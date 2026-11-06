// Read-only deployment-operator evidence collector, NOT client qualification.
// Never run this in a Worker, native session, MCP client, or browser.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(appDirectory, '..', '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const LIMIT = 65536;
const RESOURCE_BINDINGS = Object.freeze({
  'https://clued.pixelgrav.com/mcp': 'OAUTH_KV',
  'https://kooyumi.pixelgrav.com/mcp': 'KOOYUMI_OAUTH_KV',
});
const CLIENT_KEYS = ['clientId', 'clientName', 'redirectUris', 'grantTypes', 'responseTypes',
  'tokenEndpointAuthMethod', 'registrationDate', 'logoUri', 'clientUri', 'policyUri',
  'tosUri', 'jwksUri', 'i18n', 'contacts', 'authMethodExplicit'];
const REQUIRED_KEYS = ['clientId', 'redirectUris', 'grantTypes', 'responseTypes',
  'tokenEndpointAuthMethod', 'registrationDate'];
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = value => typeof value === 'string' && value.length >= 1 && value.length <= 4096;

export function projectClientInfo(raw) {
  if (!object(raw) || Object.keys(raw).some(key => !CLIENT_KEYS.includes(key) && key !== 'clientSecret')
      || REQUIRED_KEYS.some(key => !Object.hasOwn(raw, key))) fail('source_client_shape_invalid');
  const client = {};
  // Construct a fresh allowlisted object; never spread or serialize raw ClientInfo.
  // clientSecret contains a credential hash and is deliberately never copied.
  for (const key of CLIENT_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (['redirectUris', 'grantTypes', 'responseTypes', 'contacts'].includes(key)) {
      if (!Array.isArray(value) || value.length > 64 || (key !== 'contacts' && value.length === 0)
          || value.some(item => !string(item)) || new Set(value).size !== value.length) fail('source_client_shape_invalid');
      client[key] = [...value];
    } else if (key === 'registrationDate') {
      if (!Number.isSafeInteger(value) || value < 0) fail('source_client_shape_invalid');
      client[key] = value;
    } else if (key === 'authMethodExplicit') {
      if (typeof value !== 'boolean') fail('source_client_shape_invalid');
      client[key] = value;
    } else if (key === 'i18n') {
      if (!object(value) || Object.keys(value).length > 64 || Object.entries(value).some(([name, text]) =>
        !/^(client_name|client_uri|logo_uri|tos_uri|policy_uri)#[A-Za-z0-9-]{1,64}$/.test(name) || !string(text))) {
        fail('source_client_shape_invalid');
      }
      client[key] = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    } else {
      if (!string(value)) fail('source_client_shape_invalid');
      client[key] = value;
    }
  }
  if (!['none', 'client_secret_basic', 'client_secret_post'].includes(client.tokenEndpointAuthMethod)
      || !client.grantTypes.includes('authorization_code') || !client.responseTypes.includes('code')) {
    fail('source_client_shape_invalid');
  }
  return client;
}

function validateRequest(request, requestId, expectedRequestDigest) {
  if (!UUID.test(requestId) || !SHA256.test(expectedRequestDigest) || !object(request)
      || request.id !== requestId || request.request_digest !== expectedRequestDigest
      || typeof request.resource !== 'string' || !Object.hasOwn(RESOURCE_BINDINGS, request.resource)
      || request.status !== 'approved'
      || !string(request.client_id) || !string(request.client_name) || !string(request.redirect_uri)
      || !Array.isArray(request.requested_scopes) || !request.requested_scopes.length
      || request.requested_scopes.some(scope => !['context:read', 'context:write', 'audit:read'].includes(scope))) {
    fail('source_request_mismatch');
  }
}

export function buildSourceSnapshot({ rawClient, request, requestId, expectedRequestDigest, releaseSha, now = new Date() }) {
  validateRequest(request, requestId, expectedRequestDigest);
  if (!SHA1.test(releaseSha) || !Number.isFinite(now.getTime())) fail('source_provenance_invalid');
  const client = projectClientInfo(rawClient);
  if (client.clientId !== request.client_id || (client.clientName || client.clientId) !== request.client_name
      || !client.redirectUris.includes(request.redirect_uri)) fail('source_client_request_mismatch');
  const snapshot = {
    contract: 'clued.storage-client-source-snapshot/1', source: 'cloudflare-oauth-provider',
    request_id: requestId, request_digest: expectedRequestDigest, resource: request.resource,
    observed_at: now.toISOString(), release_sha: releaseSha, client,
  };
  const text = JSON.stringify(snapshot, null, 2) + '\n';
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  if (sizeBytes > LIMIT) fail('source_snapshot_too_large');
  return { text, sha256: digest(text), sizeBytes };
}

export function oauthNamespace(configuration, resource) {
  // The committed production configuration is currently strict JSON. If its
  // syntax changes, fail closed instead of extracting a convenient first ID.
  // Both issuers must remain isolated, even when collecting a legacy request.
  if (!object(configuration) || configuration.name !== 'clued-cloud'
      || !object(configuration.vars) || configuration.vars.KOOYUMI_OAUTH_ORIGIN !== 'https://kooyumi.pixelgrav.com'
      || !Array.isArray(configuration.kv_namespaces)
      || typeof resource !== 'string' || !Object.hasOwn(RESOURCE_BINDINGS, resource)) fail('source_namespace_invalid');
  const namespaces = {};
  for (const binding of Object.values(RESOURCE_BINDINGS)) {
    const matches = configuration.kv_namespaces.filter(item => item?.binding === binding);
    if (matches.length !== 1 || typeof matches[0].id !== 'string'
        || !/^[0-9a-f]{16,64}$/.test(matches[0].id)) fail('source_namespace_invalid');
    namespaces[binding] = matches[0].id;
  }
  if (new Set(Object.values(namespaces)).size !== Object.values(RESOURCE_BINDINGS).length) fail('source_namespace_invalid');
  return namespaces[RESOURCE_BINDINGS[resource]];
}

export async function fetchExactClient({ accountId, namespaceId, clientId, token, fetchImpl = fetch }) {
  if (!/^[0-9a-f]{32}$/.test(accountId) || !/^[0-9a-f]{16,64}$/.test(namespaceId)
      || !string(clientId) || typeof token !== 'string' || !token || /[\r\n]/.test(token)) fail('source_environment_invalid');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent('client:' + clientId)}`;
  let reader;
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (response.status !== 200 || !response.body) fail('source_provider_unconfirmed');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT)) fail('source_provider_unconfirmed');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) fail('source_provider_unconfirmed');
      chunks.push(value);
    }
    // No raw response/error body is ever printed or written, including on JSON
    // failure. The caller immediately allowlists the in-memory object.
    return projectClientInfo(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  } catch {
    fail('source_provider_unconfirmed');
  } finally {
    if (reader) await reader.cancel().catch(() => {});
  }
}

export async function readExactRequest(database, requestId) {
  if (!UUID.test(requestId)) fail('source_request_mismatch');
  // No transaction, row lock, or DB connection is held across provider HTTP.
  await database.query('begin read only');
  try {
    await database.query("set local statement_timeout = '10000ms'");
    const result = await database.query(
      'select * from clued_storage_source.authorization_request_snapshot_v2($1::uuid)', [requestId]);
    if (result.rows.length !== 1) fail('source_request_mismatch');
    await database.query('commit');
    return result.rows[0];
  } catch {
    await database.query('rollback').catch(() => {});
    fail('source_request_unconfirmed');
  }
}

export async function collectSource({ requestId, expectedRequestDigest, releaseSha, loadRequest, loadClient, now = () => new Date() }) {
  const before = await loadRequest(requestId);
  validateRequest(before, requestId, expectedRequestDigest);
  // The approved database request selects the namespace. Never probe another
  // issuer's KV when the exact client is absent or the provider rejects access.
  const rawClient = await loadClient(before.client_id, before.resource);
  const after = await loadRequest(requestId);
  validateRequest(after, requestId, expectedRequestDigest);
  // Reject a raced request; this still does not claim a distributed transaction
  // or a stable DCR incarnation. Every future request needs its own review link.
  for (const field of ['client_id', 'client_name', 'redirect_uri', 'resource', 'status', 'requested_scopes']) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) fail('source_request_changed');
  }
  return buildSourceSnapshot({ rawClient, request: after, requestId, expectedRequestDigest, releaseSha, now: now() });
}

export async function saveSource(output, evidence) {
  if (!output || typeof evidence.text !== 'string' || digest(evidence.text) !== evidence.sha256
      || Buffer.byteLength(evidence.text, 'utf8') !== evidence.sizeBytes) fail('source_output_invalid');
  // New evidence only: existing paths and symlinks are not overwritten.
  await writeFile(output, evidence.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export function readSourceGit(args, { cwd = repositoryDirectory, environment = process.env, spawn = spawnSync } = {}) {
  // Git must never receive the deployment credentials. Disable configurable
  // helpers as well: a clean tracked tree does not authenticate .git/config.
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const actual = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase());
    if (actual) env[name] = environment[actual];
  }
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_CONFIG_SYSTEM: nullFile,
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  const result = spawn('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullFile}`,
    '-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8', env, windowsHide: true });
  if (result.error || result.status !== 0) fail('source_git_unconfirmed');
  return result.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    console.log('Read-only, secret-filtered registration evidence. Does NOT grant storage access.\n'
      + 'node scripts/storage-client-registration-source.mjs --request-id UUID --expected-request-digest SHA256 --expected-release-sha COMMIT --output NEW_JSON_PATH\n'
      + 'Run only in the reviewed deployment environment with CLUED_ATTESTATION_DATABASE_URL, CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.');
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--request-id', '--expected-request-digest', '--expected-release-sha', '--output'].includes(key)
        || Object.hasOwn(options, key) || !args[index + 1]) fail('source_arguments_invalid');
    options[key] = args[index + 1];
  }
  if (Object.keys(options).length !== 4 || !UUID.test(options['--request-id'])
      || !SHA256.test(options['--expected-request-digest']) || !SHA1.test(options['--expected-release-sha'])) fail('source_arguments_invalid');
  const releaseSha = readSourceGit(['rev-parse', 'HEAD']);
  if (releaseSha !== options['--expected-release-sha'] || readSourceGit(['status', '--porcelain', '--untracked-files=normal'])) fail('source_checkout_not_reviewed_clean');
  const configuration = JSON.parse(await readFile(resolve(appDirectory, 'wrangler.production.jsonc'), 'utf8'));
  const databaseUrl = process.env.CLUED_ATTESTATION_DATABASE_URL;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!databaseUrl || !accountId || !token) fail('source_environment_invalid');
  const loadRequest = async requestId => {
    const database = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000,
      application_name: 'clued-storage-source-readonly' });
    try { await database.connect(); return await readExactRequest(database, requestId); }
    finally { await database.end().catch(() => {}); }
  };
  const evidence = await collectSource({ requestId: options['--request-id'],
    expectedRequestDigest: options['--expected-request-digest'], releaseSha, loadRequest,
    loadClient: (clientId, resource) => fetchExactClient({ accountId,
      namespaceId: oauthNamespace(configuration, resource), clientId, token }) });
  await saveSource(resolve(options['--output']), evidence);
  console.log(JSON.stringify({ status: 'source_captured_not_qualified', sha256: evidence.sha256, size_bytes: evidence.sizeBytes }));
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  main().catch(() => { console.error('storage_client_source_capture_failed; no qualification or storage authority was granted'); process.exitCode = 1; });
}
