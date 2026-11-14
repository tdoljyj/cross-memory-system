// Pure offline HTTP/DB fixtures and real RSA signatures. No installed secrets,
// network requests, scanner, activation, migration or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { build, stop } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../worker/ci-scan-start-v1.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
stop();
const worker = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const { handleCiScanStartV1, CI_SCAN_START_PATH, CI_SCAN_START_AUDIENCE } = worker;
const NOW = Date.parse('2026-11-02T14:00:00.000Z'), REPO = 'fixture-owner/fixture-repo';
const UUID = n => String(n).repeat(8) + '-1111-4111-8111-' + String(n).repeat(12);
const SHA = c => c.repeat(64), H = 'a'.repeat(40), B = 'b'.repeat(40), T = 'c'.repeat(40), TREE = 'd'.repeat(40);
const API = 'https://api.github.com/repos/' + REPO, DB = 'https://fixture-db.invalid';
const READ = 'ghs_' + 'R'.repeat(40), GATEWAY = 'fixture-worker-gateway';
const ISSUER = 'https://token.actions.githubusercontent.com', JWKS = ISSUER + '/.well-known/jwks';
const workflowPath = '.github/workflows/gitleaks.yml', workflow = Buffer.from('name: Fixed offline workflow\n');
const hex = (b, alg = 'sha256') => createHash(alg).update(b).digest('hex');
const blob = hex(Buffer.concat([Buffer.from('blob ' + workflow.length + '\0'), workflow]), 'sha1');
const pair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const key = { kty: pub.kty, n: pub.n, e: pub.e, kid: 'fixture-key', use: 'sig', alg: 'RS256' };
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const clone = x => JSON.parse(JSON.stringify(x));
async function token(extra = {}, header = {}, signingKey = pair.privateKey) {
  const claims = { iss: ISSUER, aud: CI_SCAN_START_AUDIENCE, sub: 'repo:' + REPO + ':pull_request',
    repository: REPO, repository_id: '42', repository_owner: 'fixture-owner', repository_owner_id: '7',
    event_name: 'pull_request', ref: 'refs/pull/88/merge', base_ref: 'main', head_ref: 'fixture-branch',
    workflow_ref: REPO + '/' + workflowPath + '@refs/pull/88/merge', workflow_sha: T, sha: T,
    runner_environment: 'github-hosted', run_id: '100', run_attempt: '1', check_run_id: '200',
    iat: NOW / 1000 - 1, nbf: NOW / 1000 - 5, exp: NOW / 1000 + 300, jti: 'SECRET_JTI_NOT_FOR_DB', ...extra };
  const input = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header }) + '.' + b64(claims);
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, Buffer.from(input));
  return input + '.' + Buffer.from(signature).toString('base64url');
}
function fixture(options = {}) {
  const body = { contract: 'clued.ci-scan-start-request/1', execution_id: UUID(1), claim_id: UUID(2), fence: 9, epoch: 2,
    pr: 88, head_sha: H, base_sha: B, source_manifest_sha256: SHA('e'), registry_sha256: SHA('f') };
  const selectedRole = options.role ?? 'gitleaks', selectedWorkflow = options.workflowPath ?? workflowPath;
  const closureFiles = options.closureFiles ?? new Map([[workflowPath, workflow], ['scripts/ci/scan-helper.mjs', Buffer.from('export const fixed = true;\n')],
    ['config/scanner.json', Buffer.from('{"fixed":true}\n')]]);
  const workflowBytes = closureFiles.get(selectedWorkflow);
  const pin = { workflow_path: selectedWorkflow,
    workflow_blob: hex(Buffer.concat([Buffer.from('blob ' + workflowBytes.length + '\0'), workflowBytes]), 'sha1'),
    workflow_sha256: hex(workflowBytes), check_name: options.checkName ?? 'Hosted ' + selectedRole, hosted_allowed: true,
    closure: [...closureFiles].map(([path, bytes]) => ({ path, mode: options.closureModes?.get(path) ?? '100644',
      blob: hex(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes]), 'sha1'), sha256: hex(bytes) })),
    must_not_exist: ['absent.yaml'], forbidden_change_prefixes: ['forbidden/'] };
  const policy = { status: 'ok', policy_id: UUID(3), repository_id: 42, repository: REPO, repository_owner_id: 7,
    scope: 'project:' + UUID(4), source_manifest_sha256: SHA('e'), registry_sha256: SHA('f'), roles: { [selectedRole]: pin },
    activated_at: new Date(NOW - 1000).toISOString(), hosted_head_sha: H };
  const pr = { number: 88, state: 'open', draft: false, changed_files: 1, merge_commit_sha: T,
    head: { sha: H, ref: 'fixture-branch', repo: { id: 42, full_name: REPO } },
    base: { sha: B, ref: 'main', repo: { id: 42, full_name: REPO } } };
  const marker = Object.fromEntries(['claim_id', 'fence', 'epoch', 'source_manifest_sha256', 'registry_sha256'].map(k => [k, body[k]]));
  const admission = { total_count: 1, check_runs: [{ id: 300, head_sha: H, name: 'kooyumi-work-admission', app: { id: 5368905 },
    status: 'completed', conclusion: 'success', output: { summary: 'Protected admission\nclued-scan-start-subject/1 ' + JSON.stringify(marker) } }] };
  const responses = new Map([
    [JWKS, { keys: [clone(key)] }], [API, { id: 42, full_name: REPO, owner: { id: 7 }, fork: false }],
    [API + '/pulls/88', pr],
    [API + `/commits/${H}/check-runs?per_page=100&filter=all&app_id=5368905&page=1`, admission],
    [API + '/actions/runs/100/attempts/1', { id: 100, run_attempt: 1, event: 'pull_request', head_sha: H, path: selectedWorkflow,
      status: 'in_progress', conclusion: null, repository: { id: 42 }, head_repository: { id: 42 } }],
    [API + '/actions/runs/100/attempts/1/jobs?per_page=100', { total_count: 1, jobs: [{ id: 201, run_id: 100, head_sha: H,
      name: pin.check_name, status: 'in_progress', conclusion: null, check_run_url: API + '/check-runs/200', labels: ['ubuntu-latest'] }] }],
    [API + '/check-runs/200', { id: 200, name: pin.check_name, head_sha: H, app: { id: 15368 }, status: 'in_progress', conclusion: null,
      details_url: 'https://github.com/' + REPO + '/actions/runs/100/job/201' }],
    [API + '/git/commits/' + T, { sha: T, tree: { sha: TREE }, parents: [{ sha: B }, { sha: H }] }],
    [API + '/git/commits/' + H, { sha: H, tree: { sha: TREE }, parents: [] }],
    [API + '/git/commits/' + B, { sha: B, tree: { sha: TREE }, parents: [] }],
    [API + '/contents/' + workflowPath + '?ref=' + T, { type: 'file', path: workflowPath, sha: blob, size: workflow.length,
      encoding: 'base64', content: workflow.toString('base64') }],
    [API + '/pulls/88/files?per_page=100&page=1', [{ filename: 'src/new.mjs', status: 'renamed', previous_filename: 'src/old.mjs' }]],
  ]);
  const treePackets = new Map(), treeSha = directory => directory === '' ? TREE : hex('tree:' + directory, 'sha1');
  const treeFor = directory => {
    const sha = treeSha(directory);
    if (!treePackets.has(sha)) treePackets.set(sha, { sha, truncated: false, tree: [] });
    return treePackets.get(sha);
  };
  for (const entry of pin.closure) {
    const segments = entry.path.split('/'); let directory = '';
    for (let i = 0; i < segments.length; i++) {
      const packet = treeFor(directory), leaf = i === segments.length - 1, name = segments[i];
      const childDir = directory ? directory + '/' + name : name;
      if (!packet.tree.some(row => row.path === name)) packet.tree.push({ path: name,
        mode: leaf ? entry.mode : '040000', type: leaf ? 'blob' : 'tree', sha: leaf ? entry.blob : treeSha(childDir) });
      directory = childDir;
    }
    const bytes = closureFiles.get(entry.path);
    responses.set(API + '/git/blobs/' + entry.blob,
      { sha: entry.blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
    for (const ref of [T, H, B]) responses.set(API + '/contents/' + entry.path + '?ref=' + ref,
      { type: 'file', path: entry.path, sha: entry.blob, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
  }
  for (const [sha, packet] of treePackets) responses.set(API + '/git/trees/' + sha, packet);
  const treePacket = { sha: TREE, truncated: false, tree: clone(options.inventory ?? []) };
  const flatten = (directory, sha) => {
    for (const entry of treePackets.get(sha).tree) {
      const name = directory ? directory + '/' + entry.path : entry.path;
      const actual = { ...entry, path: name }, existing = treePacket.tree.findIndex(row => row.path === name);
      if (existing < 0) treePacket.tree.push(actual); else treePacket.tree[existing] = actual;
      if (entry.type === 'tree') flatten(name, entry.sha);
    }
  };
  flatten('', TREE); responses.set(API + '/git/trees/' + TREE + '?recursive=1', treePacket);
  const calls = [], begins = []; let consumed = false, time = NOW;
  const grant = () => ({ status: 'committed', contract: 'clued.ci-scan-start-grant/1', launch_allowed: true,
    execution_id: body.execution_id, receipt_id: UUID(5), repository_id: 42, head_sha: H, role: selectedRole,
    provider: 'github-actions', start_requested_at: new Date(time).toISOString() });
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers); calls.push({ url, method: init.method, headers, body: init.body, redirect: init.redirect, cache: init.cache });
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    if (url === JWKS) assert.equal(headers.has('authorization'), false);
    else if (url.startsWith(API)) { assert.equal(init.method, 'GET'); assert.equal(headers.get('authorization'), 'Bearer ' + READ); }
    else { assert.ok(url.startsWith(DB + '/rest/v1/rpc/')); assert.equal(headers.get('authorization'), 'Bearer ' + GATEWAY);
      assert.equal(headers.get('apikey'), 'fixture-public'); assert.ok(!String(init.body).includes(READ)); }
    const custom = await options.fetch?.(url, init, { responses, policy, body, calls, begins, setTime: value => { time = value; } });
    if (custom instanceof Response) return custom;
    if (url.endsWith('/clued_ci_scan_start_policy_v1')) {
      assert.deepEqual(JSON.parse(init.body), { p_input: { repository_id: 42, repository: REPO } }); return Response.json(policy);
    }
    if (url.endsWith('/clued_ci_scan_start_hosted_v1')) {
      const verified = JSON.parse(init.body).p_verified; begins.push(verified);
      if (options.begin) return options.begin(verified, grant());
      if (consumed) return Response.json({ status: 'consumed', launch_allowed: false, reason: 'SECRET_DB_REASON_MUST_NOT_ESCAPE' });
      consumed = true; return Response.json(grant());
    }
    if ([T, H, B].some(ref => url === API + '/contents/absent.yaml?ref=' + ref))
      return Response.json({ message: 'Not Found', status: '404' }, { status: 404 });
    assert.ok(responses.has(url), 'unexpected network target'); return Response.json(responses.get(url));
  };
  const request = (jwt, extraBody = {}, headers = {}) => new Request('https://owner-worker.invalid' + CI_SCAN_START_PATH, {
    method: 'POST', headers: { authorization: 'Bearer ' + jwt, 'x-github-read-token': READ, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ ...body, ...extraBody }),
  });
  return { body, policy, responses, admission, pr, calls, begins, request, fetchImpl, treeSha, treePacket, now: () => time,
    handle: req => handleCiScanStartV1(req, { SUPABASE_URL: DB, SUPABASE_PUBLISHABLE_KEY: 'fixture-public', CLUED_DB_GATEWAY_TOKEN: GATEWAY }, { fetchImpl, now: () => time }) };
}
const denied = async (f, req) => { const r = await f.handle(req), data = await r.json(); assert.equal(data.launch_allowed, false);
  assert.equal(f.begins.length, 0); assert.equal(JSON.stringify(data).includes('SECRET'), false); return data; };

test('real fresh RSA + fixed GitHub proofs derives server role and passes only closed verified facts to Native', async () => {
  const f = fixture(), jwt = await token(), response = await f.handle(f.request(jwt)), value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.launch_allowed, true); assert.equal(value.role, 'gitleaks');
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(f.begins.length, 1);
  const v = f.begins[0];
  assert.deepEqual(v.changed_paths, ['src/new.mjs', 'src/old.mjs']);
  assert.deepEqual(Object.keys(v).sort(), ['policy_id','execution_id','claim_id','fence','epoch','pr','head_sha','base_sha','changed_paths',
    'source_manifest_sha256','registry_sha256','workflow_path','workflow_blob','workflow_sha256','run_id','run_attempt','token_sha256','claims_sha256','verified_at','expires_at'].sort());
  assert.equal(v.token_sha256, hex(jwt)); assert.equal(v.workflow_blob, blob); assert.equal(v.workflow_sha256, hex(workflow));
  for (const secret of [jwt, READ, GATEWAY, 'SECRET_JTI_NOT_FOR_DB']) {
    assert.equal(JSON.stringify(value).includes(secret), false); assert.equal(JSON.stringify(v).includes(secret), false);
  }
});

test('every request fetches fresh JWKS; replay/consumed response never grants a second launch', async () => {
  const f = fixture(), jwt = await token();
  assert.equal((await (await f.handle(f.request(jwt))).json()).launch_allowed, true);
  const second = await (await f.handle(f.request(jwt))).json(); assert.equal(second.launch_allowed, false);
  assert.equal(JSON.stringify(second).includes('SECRET'), false);
  assert.equal(f.calls.filter(c => c.url === JWKS).length, 2); assert.equal(f.begins.length, 2);
});

test('no-exp attestation, stale/future/expired tokens and wrong issuer/audience/runner cannot call Native', async () => {
  for (const patch of [{ exp: undefined }, { nbf: undefined }, { iat: NOW / 1000 - 121 }, { iat: NOW / 1000 + 6 },
    { exp: NOW / 1000 }, { nbf: NOW / 1000 + 6 }, { exp: NOW / 1000 + 601 },
    { iss: 'https://attacker.invalid' }, { aud: 'clued-independent-ci' }, { aud: [CI_SCAN_START_AUDIENCE] }, { runner_environment: 'self-hosted' }]) {
    const f = fixture(); await denied(f, f.request(await token(patch)));
  }
});

test('bad signatures, algorithm confusion, unknown/duplicate/private/weak keys and redirects fail closed', async () => {
  const foreign = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
  const f = fixture(); await denied(f, f.request(await token({}, {}, foreign.privateKey)));
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { jku: 'https://attacker.invalid' }, { kid: 'unknown' }]) {
    const x = fixture(); await denied(x, x.request(await token({}, header)));
  }
  for (const keys of [[key, key], [{ ...key, d: 'PRIVATE_SECRET' }], [{ ...key, n: 'YQ' }], [{ ...key, e: 'Aw' }]]) {
    const x = fixture(); x.responses.set(JWKS, { keys }); await denied(x, x.request(await token()));
  }
  const redirect = fixture({ fetch: async url => url === JWKS ? new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } }) : null });
  await denied(redirect, redirect.request(await token()));
});

test('closed inputs refuse caller role/claims/paths and long-lived credentials before any network', async () => {
  for (const patch of [{ role: 'trivy' }, { verified_claims: {} }, { changed_paths: ['safe'] }, { user_id: UUID(8) }, { hosted_head_sha: H }]) {
    const f = fixture(); await denied(f, f.request(await token(), patch)); assert.equal(f.calls.length, 0);
  }
  for (const value of ['', 'ghp_' + 'P'.repeat(40), 'clued_bnd_' + 'B'.repeat(64)]) {
    const f = fixture(); await denied(f, f.request(await token(), {}, { 'x-github-read-token': value })); assert.equal(f.calls.length, 0);
  }
});

test('missing or inactive policy and wrong immutable owner/Source/registry/job pins never call Native', async () => {
  for (const change of [p => p.status = 'rejected', p => p.repository_owner_id++, p => p.source_manifest_sha256 = SHA('0'),
    p => p.registry_sha256 = SHA('0'), p => p.roles.gitleaks.hosted_allowed = false,
    p => p.roles.gitleaks.check_name = 'Other job', p => p.roles.gitleaks.workflow_sha256 = SHA('0'), p => p.roles.gitleaks.workflow_blob = '0'.repeat(40)]) {
    const f = fixture(); change(f.policy); await denied(f, f.request(await token()));
  }
});

test('job/check/run claims and live GitHub mismatches cannot impersonate a registered scanner', async () => {
  for (const claims of [{ check_run_id: undefined }, { check_run_id: '201' }, { run_id: '101' }, { run_id: '9999999999999999' }, { run_attempt: '2' },
    { workflow_ref: REPO + '/.github/workflows/other.yml@refs/pull/88/merge' }, { ref: 'refs/heads/main' }, { workflow_sha: H },
    { repository_owner_id: '8' }, { event_name: 'pull_request_target' }, { sub: 'repo:' + REPO + ':environment:prod' }]) {
    const f = fixture(); await denied(f, f.request(await token(claims)));
  }
  for (const [url, patch] of [[API + '/actions/runs/100/attempts/1', { run_attempt: 2 }],
    [API + '/check-runs/200', { app: { id: 1 } }], [API + '/check-runs/200', { head_sha: T }],
    [API + '/check-runs/200', { status: 'completed' }], [API + '/git/commits/' + T, { parents: [{ sha: H }, { sha: B }] }],
    [API + '/git/commits/' + H, { tree: { sha: '0'.repeat(40) } }]]) {
    const f = fixture(); f.responses.set(url, { ...f.responses.get(url), ...patch }); await denied(f, f.request(await token()));
  }
});

test('current protected admission marker must be unique, successful and exactly body-bound', async () => {
  for (const change of [f => f.admission.check_runs = [], f => f.admission.check_runs.push(clone(f.admission.check_runs[0])),
    f => f.admission.check_runs[0].app.id = 1, f => f.admission.check_runs[0].conclusion = 'failure',
    f => f.admission.check_runs[0].output.summary = 'missing',
    f => f.admission.check_runs[0].output.summary += '\n' + f.admission.check_runs[0].output.summary,
    f => f.body.fence++, f => f.body.epoch++, f => f.body.claim_id = UUID(8)]) {
    const f = fixture(); change(f); await denied(f, f.request(await token()));
  }
});

test('E8 needs two observed valid tree SHA values, never equal missing/null/invalid placeholders', async () => {
  for (const tree of [{}, { sha: null }, { sha: 'invalid-tree' }]) {
    const f = fixture();
    for (const sha of [T, H]) f.responses.set(API + '/git/commits/' + sha,
      { ...f.responses.get(API + '/git/commits/' + sha), tree });
    await denied(f, f.request(await token()));
  }
});

test('changed paths are complete, unique and reread under the same actual PR head/base', async () => {
  for (const files of [[], [{ filename: '../secret', status: 'modified' }], [{ filename: 'src/new.mjs', status: 'renamed' }],
    [{ filename: 'src/new.mjs', status: 'modified' }, { filename: 'src/new.mjs', status: 'modified' }]]) {
    const f = fixture(); f.pr.changed_files = files.length || 1; f.responses.set(API + '/pulls/88/files?per_page=100&page=1', files);
    await denied(f, f.request(await token()));
  }
  let reads = 0;
  const moved = fixture({ fetch: async (url, _init, context) => {
    if (url === API + '/pulls/88' && ++reads === 2) return Response.json({ ...context.responses.get(url), merge_commit_sha: H });
  } });
  await denied(moved, moved.request(await token()));
});

test('bounded responses, transport errors and lost mutation replies never retry or disclose raw errors', async () => {
  for (const fetch of [async url => { if (url === JWKS) throw { code: 'SECRET_TOKEN', message: READ }; },
    async url => url === JWKS ? new Response(' '.repeat(65537)) : null]) {
    const f = fixture({ fetch }); await denied(f, f.request(await token()));
  }
  let mutations = 0;
  const f = fixture({ begin: async () => { mutations++; throw { code: 'SECRET_DATABASE_REPLY', body: GATEWAY }; } });
  const response = await f.handle(f.request(await token())), body = await response.json();
  assert.equal(body.launch_allowed, false); assert.equal(mutations, 1); assert.equal(f.begins.length, 1);
  assert.equal(JSON.stringify(body).includes('SECRET'), false); assert.equal(JSON.stringify(body).includes(GATEWAY), false);
});

test('foreign proxy/getter/string failures are never inspected or reflected', async () => {
  let inspected = 0;
  const foreign = [new Proxy({}, { getPrototypeOf() { inspected++; throw 'SECRET_PROXY'; },
    get() { inspected++; throw 'SECRET_PROPERTY'; } }),
    Object.defineProperty({}, 'code', { get() { inspected++; throw 'SECRET_GETTER'; } }), 'SECRET_STRING'];
  for (const error of foreign) {
    const f = fixture({ fetch: async () => { throw error; } });
    const value = await denied(f, f.request(await token())); assert.equal(value.error_code, 'SCAN_START_UNCONFIRMED');
  }
  assert.equal(inspected, 0);
});

test('a malformed or mismatched committed grant cannot authorize launch', async () => {
  for (const patch of [{ role: 'trivy' }, { execution_id: UUID(8) }, { repository_id: 43 }, { head_sha: T },
    { provider: 'independent-controller' }, { launch_allowed: 'true' }, { secret: 'SECRET_DO_NOT_EMIT' }]) {
    const f = fixture({ begin: (_v, grant) => Response.json({ ...grant, ...patch }) });
    const response = await f.handle(f.request(await token())), body = await response.json();
    assert.equal(body.launch_allowed, false); assert.equal(f.begins.length, 1); assert.equal(JSON.stringify(body).includes('SECRET'), false);
  }
});

test('pre-start closure binds every actual root and verifies each immutable blob once before Native', async () => {
  const f = fixture(); assert.equal((await (await f.handle(f.request(await token()))).json()).launch_allowed, true);
  for (const entry of f.policy.roles.gitleaks.closure)
    assert.equal(f.calls.filter(c => c.url === API + '/git/blobs/' + entry.blob).length, 1);
  assert.equal(f.calls.filter(c => c.url.includes('/git/trees/')).length, 1, 'equal immutable roots share a complete tree');
  const nativeAt = f.calls.findIndex(c => c.url.endsWith('/clued_ci_scan_start_hosted_v1'));
  assert.ok(f.calls.every((c, i) => !/\/git\/(blobs|trees)\//.test(c.url) || i < nativeAt));
  for (const patch of [{ content: Buffer.from('changed helper').toString('base64'), size: 14 }, { sha: H }, { size: 0 }, { encoding: 'none' }]) {
    const g = fixture(), entry = g.policy.roles.gitleaks.closure.find(p => p.path === 'scripts/ci/scan-helper.mjs'), url = API + '/git/blobs/' + entry.blob;
    g.responses.set(url, { ...g.responses.get(url), ...patch });
    await denied(g, g.request(await token()));
  }
});

test('server closure is closed, bounded, unique, disjoint and includes the exact workflow pins', async () => {
  for (const change of [p => delete p.closure, p => p.closure = [], p => p.closure = Array(65).fill(p.closure[0]),
    p => p.closure.push(clone(p.closure[0])), p => p.closure[0].approved = true, p => p.closure[0].mode = '120000',
    p => p.closure[0].path = '../outside', p => p.closure[0].blob = 'x'.repeat(40), p => p.closure[0].sha256 = 'bad',
    p => p.closure.shift(), p => p.closure[0].blob = '0'.repeat(40), p => p.must_not_exist = [p.closure[0].path],
    p => p.must_not_exist = ['absent.yaml', 'absent.yaml'], p => p.forbidden_change_prefixes = ['no-slash'],
    p => p.forbidden_change_prefixes = ['../outside/']]) {
    const f = fixture(); change(f.policy.roles.gitleaks); await denied(f, f.request(await token()));
  }
});

test('actual tree mode/blob, symlink ancestors, truncated or duplicate trees cannot be hidden by contents', async () => {
  for (const change of [
    f => f.treePacket.tree.find(e => e.path === 'scripts/ci/scan-helper.mjs').mode = '100755',
    f => f.treePacket.tree.find(e => e.path === 'scripts/ci/scan-helper.mjs').mode = '120000',
    f => f.treePacket.tree.find(e => e.path === 'scripts/ci/scan-helper.mjs').sha = '0'.repeat(40),
    f => f.treePacket.tree.find(e => e.path === 'scripts').mode = '120000',
    f => f.treePacket.truncated = true,
    f => f.treePacket.tree.push(clone(f.treePacket.tree[0])),
    f => f.treePacket.sha = H,
    f => f.treePacket.tree = f.treePacket.tree.filter(e => e.path !== 'scripts/ci'),
    f => f.treePacket.tree.push({ path: '../outside', mode: '100644', type: 'blob', sha: blob }),
  ]) {
    const f = fixture(); change(f); await denied(f, f.request(await token()));
  }
  // A base-only drift must be checked even while T and H are the same valid tree.
  const f = fixture(), other = '1'.repeat(40), packet = clone(f.treePacket);
  packet.sha = other; packet.tree = packet.tree.filter(e => !e.path.startsWith('scripts'));
  f.responses.set(API + '/git/trees/' + other + '?recursive=1', packet);
  f.responses.set(API + '/git/commits/' + B, { sha: B, tree: { sha: other } });
  await denied(f, f.request(await token()));
});

test('forbidden changes and rename sources refuse before burn even with a matching workflow blob', async () => {
  for (const filename of ['.github/actions/new/action.yml', '.gitattributes', 'nested/.gitattributes', 'scripts/ci/new-helper.mjs', 'forbidden/new.yml']) {
    const f = fixture(); f.responses.set(API + '/pulls/88/files?per_page=100&page=1', [{ filename, status: 'modified' }]);
    await denied(f, f.request(await token()));
  }
  const f = fixture(); f.responses.set(API + '/pulls/88/files?per_page=100&page=1',
    [{ filename: 'src/new.mjs', status: 'renamed', previous_filename: 'scripts/ci/old-helper.mjs' }]);
  await denied(f, f.request(await token()));
});

test('must-not-exist requires actual tree absence and only a normal fixed-route GitHub 404', async () => {
  const existing = fixture(); existing.treePacket.tree.push(
    { path: 'absent.yaml', mode: '100644', type: 'blob', sha: blob });
  await denied(existing, existing.request(await token()));
  for (const status of [200, 302, 403, 500]) {
    const f = fixture({ fetch: async url => url.includes('/contents/absent.yaml?ref=')
      ? Response.json({ message: 'Not Found' }, { status }) : null });
    await denied(f, f.request(await token()));
  }
  for (const value of [{ message: 'Rate limited' }, { message: 'Not Found', status: '403' }]) {
    const f = fixture({ fetch: async url => url.includes('/contents/absent.yaml?ref=')
      ? Response.json(value, { status: 404 }) : null });
    await denied(f, f.request(await token()));
  }
  const lost = fixture({ fetch: async url => { if (url.includes('/contents/absent.yaml?ref=')) throw 'SECRET_NETWORK'; } });
  await denied(lost, lost.request(await token()));
});

test('one total fetch budget counts JWKS, policy, GitHub and mutation, refusing fetch 51 before burn', async () => {
  for (const [absences, allowed] of [[32, true], [33, false]]) {
    const f = fixture({ fetch: async url => /\/contents\/absent-\d+\.yaml\?ref=/.test(url)
      ? Response.json({ message: 'Not Found', status: '404' }, { status: 404 }) : null });
    f.policy.roles.gitleaks.must_not_exist = Array.from({ length: absences }, (_, i) => `absent-${i}.yaml`);
    const value = await (await f.handle(f.request(await token()))).json();
    assert.equal(value.launch_allowed, allowed); assert.equal(f.calls.length, 50);
    assert.equal(f.begins.length, allowed ? 1 : 0);
    assert.equal(f.calls.filter(c => c.url === JWKS).length, 1);
    assert.equal(f.calls.filter(c => c.url.endsWith('/clued_ci_scan_start_policy_v1')).length, 1);
    if (!allowed) assert.equal(value.error_code, 'SCAN_START_PROOF_BOUND');
  }
});

test('actual frozen registry gitleaks/trivy closures and full tracked inventory fit the shared 50-fetch budget', async t => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const registry = JSON.parse(readFileSync(path.join(repoRoot, 'work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.json'), 'utf8'));
  const raw = execFileSync('git', ['ls-tree', '-r', '-t', '-z', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const inventory = raw.split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line); assert.ok(match);
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
  });
  assert.ok(inventory.filter(entry => entry.type !== 'tree').length >= 9000, 'use the real repository scale');
  for (const role of ['gitleaks', 'trivy']) {
    const accepted = registry.roles[role]; assert.ok(accepted.closure.length >= 26 && accepted.closure.length <= 64);
    // The reviewed-set successors use live digests (Decision 98fec682).
    // The lifecycle inventory has since gained a separately reviewed workflow;
    // this frozen scan fixture still reads its exact historical Git object.
    // Neither the accepted registry nor its pins are rewritten by this test.
    const REPINNED = new Set(['.gitleaks.toml', 'scripts/ci/reviewed_gitleaks.py', 'scripts/ci/reviewed_gitleaks_historical.py']);
    const closure = clone(accepted.closure);
    const closureFiles = new Map(closure.map(entry => {
      // coverage.json and check-workflows.mjs moved on (deleted workflows); the frozen closure keeps their exact old objects.
      const HISTORICAL = { '.github/actions/ci-temporary-storage/coverage.json': ['12f0ff5aca09df465aa0461d493485c3ed2c65b1', '55a88fb58198f079d00c2467867b271d850ad198ee0eb1709db04ae2e109f9be'],
        '.github/actions/ci-temporary-storage/check-workflows.mjs': ['bd30bbb8527d86a9e3c2bd2aafe07e0eb1a342fc', '832ae3eac5a222e9630ca9ff34bb269398a2e284ca3ed9d6e61e870f192bd8fa'] };
      const historicalCoverage = Object.hasOwn(HISTORICAL, entry.path);
      if (historicalCoverage) {
        assert.equal(entry.blob, HISTORICAL[entry.path][0]);
        assert.equal(entry.sha256, HISTORICAL[entry.path][1]);
      }
      const bytes = historicalCoverage
        ? execFileSync('git', ['cat-file', 'blob', entry.blob], { cwd: repoRoot })
        : readFileSync(path.join(repoRoot, entry.path));
      const blob = hex(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes]), 'sha1');
      if (REPINNED.has(entry.path)) { entry.sha256 = hex(bytes); entry.blob = blob; }
      else {
        assert.equal(hex(bytes), entry.sha256, 'actual frozen closure bytes: ' + entry.path);
        assert.equal(blob, entry.blob);
      }
      return [entry.path, bytes];
    }));
    const f = fixture({ role, workflowPath: accepted.workflowPath, checkName: accepted.hostedCheckName, closureFiles, inventory,
      closureModes: new Map(closure.map(entry => [entry.path, entry.mode])),
      fetch: async url => url.includes('/contents/') ? Response.json({ message: 'Not Found', status: '404' }, { status: 404 }) : null });
    const pin = f.policy.roles[role]; pin.closure = clone(closure); pin.must_not_exist = clone(accepted.mustNotExist);
    pin.forbidden_change_prefixes = clone(accepted.forbiddenChangePrefixes);
    assert.equal(pin.workflow_blob, accepted.workflowBlob); assert.equal(pin.workflow_sha256, accepted.workflowSha256);
    // Different B inventory, with the same protected closure; T/H share a root.
    const baseRoot = '2'.repeat(40), basePacket = clone(f.treePacket); basePacket.sha = baseRoot;
    basePacket.tree.push({ path: 'base-only-file.mjs', mode: '100644', type: 'blob', sha: H });
    f.responses.set(API + '/git/trees/' + baseRoot + '?recursive=1', basePacket);
    f.responses.set(API + '/git/commits/' + B, { sha: B, tree: { sha: baseRoot } });
    const value = await (await f.handle(f.request(await token({ workflow_ref: REPO + '/' + accepted.workflowPath + '@refs/pull/88/merge' })))).json();
    assert.equal(value.launch_allowed, true, JSON.stringify(value)); assert.equal(value.role, role); assert.equal(f.begins.length, 1);
    assert.ok(f.calls.length <= 50); assert.equal(f.calls.filter(call => call.url.includes('/git/trees/')).length, 2);
    const uniqueBlobs = new Set(closure.map(entry => entry.blob));
    assert.equal(f.calls.filter(call => call.url.includes('/git/blobs/')).length, uniqueBlobs.size);
    assert.equal(f.calls.filter(call => call.url.includes('/contents/')).length, accepted.mustNotExist.length * 2);
    t.diagnostic(`${role}: closure=${closure.length}, uniqueBlobs=${uniqueBlobs.size}, inventoryRows=${f.treePacket.tree.length}, totalFetches=${f.calls.length}`);
  }
});

test('recursive tree bounds and an extra unpinned .gitattributes stop before Native', async () => {
  for (const change of [
    f => f.treePacket.tree.push({ path: '.gitattributes', mode: '100644', type: 'blob', sha: blob }),
    f => f.treePacket.tree = Array.from({ length: 32001 }, (_, i) => ({ path: 'file-' + i, mode: '100644', type: 'blob', sha: blob })),
  ]) {
    const f = fixture(); change(f); await denied(f, f.request(await token()));
  }
  const oversized = fixture({ fetch: async url => url.includes('/git/trees/') ? new Response(' '.repeat(8 * 1024 * 1024 + 1)) : null });
  await denied(oversized, oversized.request(await token()));
});

test('cached blob verification still compares every closure SHA256 pin', async () => {
  const f = fixture(), original = f.policy.roles.gitleaks.closure[0];
  f.policy.roles.gitleaks.closure.push({ ...original, path: 'alias.yml', sha256: '0'.repeat(64) });
  f.treePacket.tree.push({ path: 'alias.yml', mode: original.mode, type: 'blob', sha: original.blob });
  await denied(f, f.request(await token()));
  assert.equal(f.calls.filter(call => call.url === API + '/git/blobs/' + original.blob).length, 1);
});

test('server-owned exact hosted H or explicit nullable policy is checked immediately after lookup', async () => {
  for (const value of [H, null]) {
    const f = fixture(); f.policy.hosted_head_sha = value;
    const grant = await (await f.handle(f.request(await token()))).json();
    assert.equal(grant.launch_allowed, true); assert.equal(f.begins.length, 1);
  }
  const f = fixture(); f.policy.hosted_head_sha = B;
  const value = await denied(f, f.request(await token()));
  assert.equal(value.error_code, 'SCAN_START_HOSTED_HEAD_REFUSED');
  assert.deepEqual(f.calls.map(call => call.url), [JWKS, DB + '/rest/v1/rpc/clued_ci_scan_start_policy_v1']);
});

test('missing, malformed or extra policy head-pin fields refuse before GitHub proof reads and Native burn', async () => {
  for (const value of [undefined, '', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 0, false, {}, [H]]) {
    const f = fixture(); f.policy.hosted_head_sha = value;
    await denied(f, f.request(await token())); assert.equal(f.calls.length, 2);
  }
  const f = fixture(); f.policy.hosted_head_override = null;
  await denied(f, f.request(await token())); assert.equal(f.calls.length, 2);
});
