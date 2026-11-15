import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSourceSnapshot, collectSource, fetchExactClient, oauthNamespace, projectClientInfo,
  readExactRequest, readSourceGit, saveSource } from '../scripts/storage-client-registration-source.mjs';

const requestId = '12345678-1234-4000-8000-123456789abc';
const expectedRequestDigest = 'a'.repeat(64);
const releaseSha = 'b'.repeat(40);
const legacyResource = 'https://clued.pixelgrav.com/mcp';
const kooyumiResource = 'https://kooyumi.pixelgrav.com/mcp';
const legacyNamespace = 'd'.repeat(32);
const kooyumiNamespace = 'e'.repeat(32);
const oauthConfiguration = () => ({ name: 'clued-cloud', vars: { KOOYUMI_OAUTH_ORIGIN: 'https://kooyumi.pixelgrav.com' },
  kv_namespaces: [{ binding: 'OAUTH_KV', id: legacyNamespace }, { binding: 'KOOYUMI_OAUTH_KV', id: kooyumiNamespace }] });
const request = { id: requestId, request_digest: expectedRequestDigest, client_id: 'reviewed-client',
  client_name: '受审客户端', redirect_uri: 'http://127.0.0.1:3210/callback',
  resource: legacyResource, status: 'approved', requested_scopes: ['context:read', 'context:write'] };
const rawClient = { clientId: request.client_id, clientName: request.client_name,
  redirectUris: [request.redirect_uri], grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'],
  tokenEndpointAuthMethod: 'none', registrationDate: 1790550000, authMethodExplicit: true,
  logoUri: 'https://example.com/logo.svg', clientUri: 'https://example.com', policyUri: 'https://example.com/privacy',
  tosUri: 'https://example.com/terms', jwksUri: 'https://example.com/keys', contacts: ['support@example.com'],
  i18n: { 'client_name#zh': '受审客户端', 'client_name#en': 'Reviewed Client' }, clientSecret: 'NEVER-PUBLISH-HASH' };
const now = new Date('2026-09-28T06:10:00.000Z');
const input = () => ({ rawClient: structuredClone(rawClient), request: structuredClone(request),
  requestId, expectedRequestDigest, releaseSha, now });
const providerInput = () => ({ accountId: 'c'.repeat(32), namespaceId: 'd'.repeat(32), clientId: request.client_id,
  token: 'SECRET-CLOUDFLARE-TOKEN', fetchImpl: async () => new Response(JSON.stringify(rawClient)) });

test('registration source is exact UTF-8/LF evidence and preserves all nonsecret SDK metadata', () => {
  const result = buildSourceSnapshot(input());
  assert.equal(result.sizeBytes, Buffer.byteLength(result.text, 'utf8'));
  assert.equal(result.sha256, createHash('sha256').update(result.text, 'utf8').digest('hex'));
  assert.ok(result.text.endsWith('\n'));
  assert.notEqual(result.sha256, createHash('sha256').update(result.text.trimEnd()).digest('hex'));
  const snapshot = JSON.parse(result.text);
  assert.equal(snapshot.request_digest, expectedRequestDigest);
  assert.equal(snapshot.observed_at, now.toISOString());
  assert.equal(snapshot.client.authMethodExplicit, true);
  assert.equal(snapshot.client.registrationDate, rawClient.registrationDate);
  assert.equal(snapshot.client.i18n['client_name#zh'], '受审客户端');
  assert.deepEqual(Object.keys(snapshot.client).sort(), Object.keys(rawClient).filter(key => key !== 'clientSecret').sort());
  assert.doesNotMatch(result.text, /clientSecret|NEVER-PUBLISH-HASH|issuer_hash|owner_id/);
  assert.equal(rawClient.clientSecret, 'NEVER-PUBLISH-HASH');
});

test('source schema rejects unknown metadata, wrong types, missing values and oversized UTF-8', () => {
  for (const bad of [null, [], { ...rawClient, unknownFutureProtocol: true }, { ...rawClient, tokenEndpointAuthMethod: 'private_key_jwt' },
    { ...rawClient, authMethodExplicit: 'true' }, { ...rawClient, registrationDate: 1.5 }, { ...rawClient, registrationDate: -1 },
    { ...rawClient, grantTypes: [] }, { ...rawClient, responseTypes: ['token'] }, { ...rawClient, redirectUris: [request.redirect_uri, request.redirect_uri] },
    { ...rawClient, contacts: [5] }, { ...rawClient, i18n: { secret: 'hidden' } }, { ...rawClient, clientName: '' }]) {
    assert.throws(() => projectClientInfo(bad), /source_client_shape_invalid/);
  }
  for (const key of ['clientId', 'redirectUris', 'grantTypes', 'responseTypes', 'registrationDate', 'tokenEndpointAuthMethod']) {
    const bad = { ...rawClient }; delete bad[key];
    assert.throws(() => projectClientInfo(bad), /source_client_shape_invalid/);
  }
  const oversized = input();
  oversized.rawClient.contacts = Array.from({ length: 64 }, (_, index) => String(index) + '中'.repeat(4000));
  assert.throws(() => buildSourceSnapshot(oversized), /source_snapshot_too_large/);
});

test('source binds exact request, client, resource, redirect and name without issuer or caller authority', () => {
  for (const [key, value] of [['id', '00000000-0000-4000-8000-000000000000'], ['request_digest', 'c'.repeat(64)],
    ['client_id', 'lookalike-client'], ['client_name', 'Lookalike'], ['redirect_uri', 'https://evil.example/callback'],
    ['resource', 'https://other.example/mcp'], ['status', 'pending'], ['requested_scopes', ['storage:write']]]) {
    const changed = input(); changed.request[key] = value;
    assert.throws(() => buildSourceSnapshot(changed), /source_(client_request|request)_mismatch/);
  }
  assert.throws(() => buildSourceSnapshot({ ...input(), releaseSha: 'caller-picked-label' }), /source_provenance_invalid/);
  const nameless = input(); delete nameless.rawClient.clientName; nameless.request.client_name = nameless.request.client_id;
  assert.equal(JSON.parse(buildSourceSnapshot(nameless).text).client.clientName, undefined);
});

test('namespace is derived from the exact resource and distinct committed issuer bindings', () => {
  const config = oauthConfiguration();
  assert.equal(oauthNamespace(config, legacyResource), legacyNamespace);
  assert.equal(oauthNamespace(config, kooyumiResource), kooyumiNamespace);
  for (const resource of [undefined, null, '__proto__', 'https://other.example/mcp',
    'http://kooyumi.pixelgrav.com/mcp', kooyumiResource + '/', kooyumiResource + '?issuer=legacy',
    'https://user@kooyumi.pixelgrav.com/mcp']) {
    assert.throws(() => oauthNamespace(config, resource), /source_namespace_invalid/);
  }
});

test('either issuer mapping missing, duplicated, malformed or shared rejects both resources', () => {
  const invalid = [{}, { ...oauthConfiguration(), name: 'attacker' }, { ...oauthConfiguration(), kv_namespaces: [] }];
  for (const origin of [undefined, 'https://clued.pixelgrav.com', 'http://kooyumi.pixelgrav.com',
    'https://kooyumi.pixelgrav.com/', 'https://kooyumi.pixelgrav.com?issuer=legacy']) {
    invalid.push({ ...oauthConfiguration(), vars: { KOOYUMI_OAUTH_ORIGIN: origin } });
  }
  for (const binding of ['OAUTH_KV', 'KOOYUMI_OAUTH_KV']) {
    const missing = oauthConfiguration();
    missing.kv_namespaces = missing.kv_namespaces.filter(item => item.binding !== binding);
    invalid.push(missing);
    const duplicate = oauthConfiguration();
    duplicate.kv_namespaces.push({ ...duplicate.kv_namespaces.find(item => item.binding === binding) });
    invalid.push(duplicate);
    for (const id of ['../other', '', undefined, 1111111111111111]) {
      const malformed = oauthConfiguration();
      malformed.kv_namespaces.find(item => item.binding === binding).id = id;
      invalid.push(malformed);
    }
  }
  const shared = oauthConfiguration(); shared.kv_namespaces[1].id = legacyNamespace; invalid.push(shared);
  for (const config of invalid) {
    for (const resource of [legacyResource, kooyumiResource]) {
      assert.throws(() => oauthNamespace(config, resource), /source_namespace_invalid/);
    }
  }
});

test('provider collector performs one exact GET without redirects and removes secret before return', async () => {
  let count = 0;
  const clientId = 'id/with?query#fragment';
  const result = await fetchExactClient({ ...providerInput(), clientId, fetchImpl: async (url, options) => {
    count += 1;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${'c'.repeat(32)}/storage/kv/namespaces/${'d'.repeat(32)}/values/${encodeURIComponent('client:' + clientId)}`);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer SECRET-CLOUDFLARE-TOKEN');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    return new Response(JSON.stringify(rawClient));
  } });
  assert.equal(count, 1); assert.equal(result.clientSecret, undefined);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|NEVER-PUBLISH/);
});

test('provider failures are sanitized, body bounded and never retried', async () => {
  for (const response of [() => new Response('SECRET-provider-error', { status: 403 }),
    () => new Response('SECRET-bad-json'), () => new Response('{}', { headers: { 'Content-Length': '65537' } }),
    () => new Response('x'.repeat(65537)), () => new Response(new Uint8Array([255])),
    () => { throw new Error('SECRET-network-error'); }]) {
    let count = 0;
    await assert.rejects(fetchExactClient({ ...providerInput(), fetchImpl: async () => { count += 1; return response(); } }),
      error => error.message === 'source_provider_unconfirmed');
    assert.equal(count, 1);
  }
  await assert.rejects(fetchExactClient({ ...providerInput(), accountId: '../other' }), /source_environment_invalid/);
});

test('exact DB read uses read-only transaction and parameters, never emits private identity', async () => {
  const calls = [];
  const database = { query: async (sql, args) => {
    calls.push({ sql, args }); return { rows: sql.startsWith('select * from clued_storage_source.') ? [request] : [] };
  } };
  assert.deepEqual(await readExactRequest(database, requestId), request);
  assert.equal(calls[0].sql, 'begin read only'); assert.equal(calls.at(-1).sql, 'commit');
  assert.deepEqual(calls[2].args, [requestId]);
  assert.equal(calls[2].sql, 'select * from clued_storage_source.authorization_request_snapshot_v2($1::uuid)');
  assert.doesNotMatch(calls[2].sql, /clued_private|clued_agent_bindings|issuer_hash|owner_id/);
  assert.doesNotMatch(calls.map(call => call.sql).join('\n'), /for share|for update|insert |update |delete /i);
});

test('DB read failure rolls back and removes raw exception details', async () => {
  const calls = [];
  await assert.rejects(readExactRequest({ query: async sql => {
    calls.push(sql); if (sql.startsWith('select ')) throw new Error('SECRET-database-password');
    return { rows: [] };
  } }, requestId), error => error.message === 'source_request_unconfirmed');
  assert.equal(calls.at(-1), 'rollback');
});

test('source collection verifies DB both before and after HTTP with no grant or fallback', async () => {
  const calls = [];
  const result = await collectSource({ requestId, expectedRequestDigest, releaseSha, now: () => now,
    loadRequest: async id => { calls.push('db'); assert.equal(id, requestId); return { ...request }; },
    loadClient: async id => { calls.push('provider'); assert.equal(id, request.client_id); return rawClient; } });
  assert.deepEqual(calls, ['db', 'provider', 'db']); assert.ok(result.sha256);
  let reads = 0;
  await assert.rejects(collectSource({ requestId, expectedRequestDigest, releaseSha,
    loadRequest: async () => ++reads === 1 ? request : { ...request, requested_scopes: ['context:read'] },
    loadClient: async () => rawClient }), /source_request_changed/);
});

test('approved resource selects only its exact KV for the same client ID and filters provider secrets', async () => {
  const clients = {
    [legacyNamespace]: { ...rawClient, logoUri: 'https://example.com/legacy.svg' },
    [kooyumiNamespace]: { ...rawClient, logoUri: 'https://example.com/kooyumi.svg' },
  };
  for (const [resource, namespaceId] of [[legacyResource, legacyNamespace], [kooyumiResource, kooyumiNamespace]]) {
    const calls = [];
    const approved = { ...request, resource };
    const evidence = await collectSource({ requestId, expectedRequestDigest, releaseSha, now: () => now,
      loadRequest: async () => { calls.push('db'); return { ...approved }; },
      loadClient: async (clientId, approvedResource) => {
        assert.equal(approvedResource, resource);
        return fetchExactClient({ ...providerInput(), clientId, namespaceId: oauthNamespace(oauthConfiguration(), approvedResource),
          fetchImpl: async (url, options) => {
            calls.push(url);
            assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${'c'.repeat(32)}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent('client:' + request.client_id)}`);
            assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
            return new Response(JSON.stringify(clients[new URL(url).pathname.split('/')[8]]));
          } });
      } });
    assert.equal(calls.length, 3); assert.equal(calls[0], 'db'); assert.equal(calls[2], 'db');
    const snapshot = JSON.parse(evidence.text);
    assert.equal(snapshot.resource, resource);
    assert.equal(snapshot.client.logoUri, clients[namespaceId].logoUri);
    assert.doesNotMatch(evidence.text, /clientSecret|SECRET|NEVER-PUBLISH/);
  }
});

test('unknown or missing request resource fails before provider lookup', async () => {
  for (const resource of [undefined, null, 'https://other.example/mcp', kooyumiResource + '/', kooyumiResource + '?issuer=legacy']) {
    let providerCalls = 0;
    await assert.rejects(collectSource({ requestId, expectedRequestDigest, releaseSha,
      loadRequest: async () => ({ ...request, resource }),
      loadClient: async () => { providerCalls += 1; return rawClient; } }), /source_request_mismatch/);
    assert.equal(providerCalls, 0);
  }
});

test('a request changing between the two accepted resources cannot publish source evidence', async () => {
  for (const [before, after] of [[legacyResource, kooyumiResource], [kooyumiResource, legacyResource]]) {
    let reads = 0; let providerCalls = 0;
    await assert.rejects(collectSource({ requestId, expectedRequestDigest, releaseSha,
      loadRequest: async () => ({ ...request, resource: ++reads === 1 ? before : after }),
      loadClient: async (clientId, resource) => {
        providerCalls += 1; assert.equal(clientId, request.client_id); assert.equal(resource, before); return rawClient;
      } }), /source_request_changed/);
    assert.equal(reads, 2); assert.equal(providerCalls, 1);
  }
});

test('provider failure or mismatched client never falls back to the other issuer KV', async () => {
  for (const [resource, namespaceId] of [[legacyResource, legacyNamespace], [kooyumiResource, kooyumiNamespace]]) {
    for (const mismatch of [false, true]) {
      const urls = [];
      await assert.rejects(collectSource({ requestId, expectedRequestDigest, releaseSha,
        loadRequest: async () => ({ ...request, resource }),
        loadClient: (clientId, approvedResource) => fetchExactClient({ ...providerInput(), clientId,
          namespaceId: oauthNamespace(oauthConfiguration(), approvedResource), fetchImpl: async url => {
            urls.push(url);
            return mismatch ? new Response(JSON.stringify({ ...rawClient, clientId: 'other-client' }))
              : new Response('SECRET-provider-error', { status: 404 });
          } }) }), mismatch ? /source_client_request_mismatch/ : /source_provider_unconfirmed/);
      assert.equal(urls.length, 1);
      assert.ok(urls[0].includes(`/namespaces/${namespaceId}/values/`));
    }
  }
});

test('source output is new-file-only and never overwrites a prior evidence file or symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clued-source-collector-test-'));
  try {
    const output = join(directory, 'evidence.json'); const result = buildSourceSnapshot(input());
    await saveSource(output, result); assert.equal(await readFile(output, 'utf8'), result.text);
    await assert.rejects(saveSource(output, result), { code: 'EEXIST' });
    await assert.rejects(saveSource(join(directory, 'changed.json'), { ...result, text: result.text + ' ' }), /source_output_invalid/);
    // Windows symlink privileges vary; the existing-path non-overwrite assertion
    // above is mandatory on every host. Exercise the symlink path on POSIX.
    if (process.platform !== 'win32') {
      const target = join(directory, 'target'); const link = join(directory, 'link');
      await writeFile(target, 'original'); await symlink(target, link);
      await assert.rejects(saveSource(link, result), { code: 'EEXIST' });
      assert.equal(await readFile(target, 'utf8'), 'original');
    }
  } finally { await rm(directory, { recursive: true }); }
});

test('source Git subprocess receives no credentials or inherited Git helper configuration', () => {
  let calls = 0;
  assert.equal(readSourceGit(['rev-parse', 'HEAD'], { environment: { PATH: process.env.PATH,
    CLUED_ATTESTATION_DATABASE_URL: 'SECRET-DB', CLOUDFLARE_API_TOKEN: 'SECRET-CF',
    GIT_CONFIG_PARAMETERS: 'evil', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'evil', HOME: '/unsafe/global/config' }, spawn: (binary, args, options) => {
    calls += 1; assert.equal(binary, 'git');
    assert.ok(args.includes('core.fsmonitor=false')); assert.ok(args.some(arg => arg.startsWith('core.hooksPath=')));
    assert.ok(args.includes('credential.helper='));
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    for (const key of ['CLUED_ATTESTATION_DATABASE_URL', 'CLOUDFLARE_API_TOKEN', 'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'HOME']) assert.equal(options.env[key], undefined);
    assert.doesNotMatch(JSON.stringify(options), /SECRET|evil/);
    return { status: 0, stdout: releaseSha + '\n' };
  } }), releaseSha);
  assert.equal(calls, 1);
});

test('a repository fsmonitor helper cannot run during the actual collector Git status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clued-source-git-test-'));
  try {
    const init = spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, 'isolated test repository initialized');
    const marker = join(directory, 'helper-ran');
    const helper = join(directory, 'helper.cjs');
    await writeFile(helper, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const config = spawnSync('git', ['config', '--local', 'core.fsmonitor', `node "${helper.replaceAll('\\', '/')}"`],
      { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(config.status, 0);
    readSourceGit(['status', '--porcelain'], { cwd: directory, environment: { ...process.env,
      CLUED_ATTESTATION_DATABASE_URL: 'SECRET-DB-TEST', CLOUDFLARE_API_TOKEN: 'SECRET-CF-TEST' } });
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true }); }
});

test('production capture workflow is owner-only on main and cannot qualify or mutate storage', async () => {
  await assert.rejects(readFile(join(process.cwd(), '..', '..', '.github', 'workflows',
    'clued-storage-client-source.yml'), 'utf8'), { code: 'ENOENT' });
  const workflow = await readFile(join(process.cwd(), '..', '..', '.github', 'workflows',
    'clued-cloud-production-release.yml'), 'utf8');
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.actor == github\.repository_owner/);
  assert.match(workflow, /github\.triggering_actor == github\.repository_owner/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /--request-id "\$REQUEST_ID"/);
  assert.match(workflow, /--expected-request-digest "\$REQUEST_DIGEST"/);
  assert.match(workflow, /--expected-release-sha "\$GITHUB_SHA"/);
  assert.match(workflow, /CLUED_STORAGE_SOURCE_DATABASE_URL/);
  assert.match(workflow, /CLUED_STORAGE_SOURCE_CLOUDFLARE_TOKEN/);
  assert.match(workflow, /retention-days: \$\{\{ inputs\.mode == 'source-capture' && 1 \|\| 30 \}\}/);
  const capture = workflow.slice(workflow.indexOf('- name: Capture exact nonsecret registration source'),
    workflow.indexOf('- name: Install embedded PostgreSQL ICU compatibility runtime'));
  assert.doesNotMatch(capture, /secrets\.CLUED_ATTESTATION_DATABASE_URL|secrets\.CLUED_CLOUDFLARE_DEPLOY_TOKEN|wrangler deploy/);
  assert.doesNotMatch(capture, /storage_client_capability_admin_v2|register_snapshot|qualify|supabase_apply/);
  for (const name of ['Install embedded PostgreSQL ICU compatibility runtime',
    'Verify projection and MTPE behavior', 'Build exact Worker source',
    'Block release unless database and Worker heartbeat are ready',
    'Check Cloudflare deployment credential', 'Deploy Clued production Worker',
    'Record deployment completion time', 'Verify exact live commit and currentness transport',
    'Verify projection currentness after deployment']) {
    const step = workflow.slice(workflow.indexOf(`- name: ${name}`),
      workflow.indexOf('- name:', workflow.indexOf(`- name: ${name}`) + 1));
    // Each of these runs only in preflight, deploy or release, never in source-capture.
    assert.match(step, /if: \$\{\{ inputs\.mode == '(?:preflight' \|\| inputs\.mode == ')?deploy' \|\| inputs\.mode == 'release' \}\}/);
  }
});
