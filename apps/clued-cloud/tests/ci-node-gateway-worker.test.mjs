import assert from 'node:assert/strict';
import crypto, { webcrypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build, stop } from 'esbuild';

// The CI node gateway's HTTP envelope (unified scheduling 2B): route, method,
// token and body bounds, the order of database calls, and that nothing reaches
// the mutation RPC unless the signature verified. Database behaviour is in
// ci-node-gateway-db.test.mjs.
const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ stdin: { contents: "export * from './worker/ci-node-gateway-v1.ts'; export * from './worker/ci-scheduling-v1.ts';",
  resolveDir: cloud, loader: 'ts' }, bundle: true, platform: 'neutral', format: 'esm', write: false, logLevel: 'silent' });
stop();
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const hex = text => crypto.createHash('sha256').update(text).digest('hex');
const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'pk', CLUED_DB_GATEWAY_TOKEN: 'gw' };
const ids = Array.from({ length: 4 }, (_, i) => `${i + 1}`.repeat(8) + '-1111-4111-8111-' + `${i + 1}`.repeat(12));
const token = 'clued_node_fixture_' + 'a'.repeat(32);
const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const e = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const jwk = { kty: e.kty, crv: e.crv, x: e.x, y: e.y };
const fingerprint = await m.ciIdentityFingerprint(jwk);
const principal = { user_id: ids[0], project_id: ids[1], binding_id: ids[2], binding_generation: 1 };
const node = { node_id: ids[3], ...principal, version: 2, key_version: 1, identity_fingerprint: fingerprint, identity_public_jwk: jwk,
  state: 'active', qualification_verified: false, publisher_approved: true, binding_expires_at_ms: Date.now() + 3600000, qualification_expires_at_ms: 0 };
const trustDoc = (changes = {}) => ({ status: 'ok', principal, node: { ...node, ...changes }, qualification: { status: 'unverified' },
  node_list: { version: 1, sha256: 'b'.repeat(64) }, gateway_open: true });
const payload = { schema: 'clued.ci-node-qualification/1', note: 'fixture' };
async function signed(changes = {}) {
  const c = { protocol: 'clued.ci-node-command/1', operation: 'qualification_report', ...principal, node_id: ids[3], node_version: 2, key_version: 1,
    key_fingerprint: fingerprint, payload_sha256: hex(m.ciCanonicalJson(payload)), nonce: crypto.randomBytes(32).toString('base64url'),
    job_id: null, execution_generation: 0, train_generation: 0, issued_at_ms: Date.now() - 1000, expires_at_ms: Date.now() + 60000,
    signature: Buffer.alloc(64).toString('base64url'), ...changes };
  c.signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, m.ciCommandSigningBytes(c))).toString('base64url');
  return c;
}
function db(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const name = new URL(url).pathname.replace('/rest/v1/rpc/', ''); const body = JSON.parse(init.body);
    calls.push({ url, name, body, headers: init.headers, redirect: init.redirect });
    const reply = replies[name]?.(body, calls.length);
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { calls, fetchImpl };
}
const ok = { clued_ci_node_trust_v1: () => trustDoc(), clued_ci_node_command_v1: () => ({ status: 'committed', operation: 'qualification_report', result: { status: 'qualified' }, replayed: false }) };
async function call(body, { route = '/v1/ci/node', method = 'POST', auth = 'Bearer ' + token, type = 'application/json', replies = ok, environment = env, raw } = {}) {
  const d = db(replies);
  const response = await m.handleCiNodeGatewayV1(new Request('https://clued.example.test' + route, { method,
    headers: { ...(type ? { 'content-type': type } : {}), ...(auth ? { authorization: auth } : {}) },
    ...(method === 'POST' ? { body: raw ?? JSON.stringify(body) } : {}) }), environment, { fetchImpl: d.fetchImpl });
  return { status: response.status, body: await response.json(), headers: response.headers, calls: d.calls };
}

test('a verified command makes two trust reads and exactly one mutation, with the hashed token and the verification facts', async () => {
  const command = await signed();
  const r = await call({ command, payload });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'committed');
  assert.deepEqual(r.calls.map(c => c.name), ['clued_ci_node_trust_v1', 'clued_ci_node_trust_v1', 'clued_ci_node_command_v1']);
  for (const c of r.calls) {
    assert.equal(c.url, 'https://db.example.test/rest/v1/rpc/' + c.name); assert.equal(c.headers.authorization, 'Bearer gw');
    assert.equal(c.headers.apikey, 'pk'); assert.equal(c.redirect, 'error'); assert.equal(c.body.p_token_hash, hex(token));
    assert.ok(!JSON.stringify(c.body).includes(token), 'the raw token never leaves the Worker');
  }
  const mutation = r.calls[2].body;
  assert.deepEqual(mutation.p_command, command); assert.deepEqual(mutation.p_payload, payload);
  assert.deepEqual(Object.keys(mutation.p_verified).sort(), ['node_id', 'nonce_sha256', 'operation', 'payload_sha256', 'verified_at_ms']);
  assert.equal(mutation.p_verified.nonce_sha256, hex(command.nonce)); assert.equal(mutation.p_verified.payload_sha256, command.payload_sha256);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('route, method, content type, token and body bounds are refused before any database call', async () => {
  const command = await signed();
  for (const [options, code, status] of [
    [{ route: '/v1/ci/node?x=1' }, 'CI_NODE_ROUTE_REFUSED', 404], [{ route: '/v1/ci/nodes' }, 'CI_NODE_ROUTE_REFUSED', 404],
    [{ method: 'GET' }, 'CI_NODE_METHOD_REFUSED', 405], [{ type: 'text/plain' }, 'CI_NODE_INPUT_REFUSED', 400],
    [{ auth: null }, 'CI_NODE_TOKEN_REFUSED', 401], [{ auth: 'Bearer short' }, 'CI_NODE_TOKEN_REFUSED', 401], [{ auth: 'Basic ' + token }, 'CI_NODE_TOKEN_REFUSED', 401],
    [{ raw: '{' }, 'CI_NODE_INPUT_REFUSED', 400], [{ raw: JSON.stringify({ command, payload, extra: 1 }) }, 'CI_NODE_INPUT_REFUSED', 400],
    [{ raw: JSON.stringify({ command: { ...command, node_id: 'x' }, payload }) }, 'CI_NODE_INPUT_REFUSED', 400],
    [{ raw: JSON.stringify({ command, payload: 'x'.repeat(200000) }) }, 'CI_NODE_INPUT_REFUSED', 400],
    [{ environment: { ...env, CLUED_DB_GATEWAY_TOKEN: '' } }, 'CI_NODE_GATEWAY_UNAVAILABLE', 503],
    [{ environment: { ...env, SUPABASE_URL: 'http://db.example.test' } }, 'CI_NODE_GATEWAY_UNAVAILABLE', 503],
  ]) {
    const r = await call({ command, payload }, options);
    assert.equal(r.body.error_code, code, JSON.stringify(options)); assert.equal(r.status, status); assert.equal(r.calls.length, 0, JSON.stringify(options));
  }
});

test('trust refusal, a bad signature or a stale identity never reaches the mutation RPC', async () => {
  const command = await signed();
  let r = await call({ command, payload }, { replies: { ...ok, clued_ci_node_trust_v1: () => ({ status: 'rejected', error_code: 'CI_NODE_TRUST_UNAVAILABLE' }) } });
  assert.equal(r.body.error_code, 'CI_NODE_TRUST_REFUSED'); assert.equal(r.status, 403); assert.ok(!r.calls.some(c => c.name === 'clued_ci_node_command_v1'));
  r = await call({ command: { ...command, signature: (await signed()).signature }, payload });
  assert.equal(r.body.error_code, 'CI_NODE_SIGNATURE_INVALID'); assert.ok(!r.calls.some(c => c.name === 'clued_ci_node_command_v1'));
  r = await call({ command, payload: { ...payload, note: 'changed' } });
  assert.equal(r.body.error_code, 'CI_NODE_SIGNATURE_INVALID'); assert.ok(!r.calls.some(c => c.name === 'clued_ci_node_command_v1'));
  r = await call({ command, payload }, { replies: { ...ok, clued_ci_node_trust_v1: () => trustDoc({ version: 3 }) } });
  assert.equal(r.body.error_code, 'CI_NODE_STALE_VERSION'); assert.ok(!r.calls.some(c => c.name === 'clued_ci_node_command_v1'));
  // Revoked between the two trust reads.
  r = await call({ command, payload }, { replies: { ...ok, clued_ci_node_trust_v1: (_b, n) => n === 1 ? trustDoc() : trustDoc({ state: 'revoked' }) } });
  assert.equal(r.body.error_code, 'CI_NODE_PRINCIPAL_INVALID'); assert.ok(!r.calls.some(c => c.name === 'clued_ci_node_command_v1'));
  // The Binding is revoked between the two trust reads: no trusted node (403), not an outage.
  r = await call({ command, payload }, { replies: { ...ok, clued_ci_node_trust_v1: (_b, n) => n === 1 ? trustDoc() : { status: 'rejected', error_code: 'CI_NODE_TRUST_UNAVAILABLE' } } });
  assert.equal(r.status, 403); assert.equal(r.body.error_code, 'CI_NODE_PRINCIPAL_INVALID'); assert.ok(!r.calls.some(c => c.name === 'clued_ci_node_command_v1'));
  // A malformed trust document is a gateway failure, not a verdict.
  r = await call({ command, payload }, { replies: { ...ok, clued_ci_node_trust_v1: () => ({ ...trustDoc(), node: { ...node, extra: 1 } }) } });
  assert.equal(r.status, 503); assert.equal(r.body.error_code, 'CI_NODE_GATEWAY_UNCONFIRMED');
});

test('database refusals pass their code through; anything else is unconfirmed', async () => {
  const command = await signed();
  let r = await call({ command, payload }, { replies: { ...ok, clued_ci_node_command_v1: () => ({ status: 'rejected', authoritative: false, error_code: 'SIGNATURE_GATEWAY_NOT_ACTIVATED' }) } });
  assert.equal(r.status, 409); assert.deepEqual(r.body, { status: 'refused', error_code: 'SIGNATURE_GATEWAY_NOT_ACTIVATED' });
  for (const reply of [() => ({ status: 'rejected', error_code: 'lower case detail' }), () => ({ status: 'committed', operation: 'job_lease' }),
    () => new Response('{}', { status: 500 }), () => new Response('not json', { status: 200 }), () => { throw new Error('private detail'); }]) {
    r = await call({ command, payload }, { replies: { ...ok, clued_ci_node_command_v1: reply } });
    assert.equal(r.status, 503); assert.equal(r.body.error_code, 'CI_NODE_GATEWAY_UNCONFIRMED');
    assert.ok(!JSON.stringify(r.body).includes('private detail'));
  }
});

test('status returns only the caller\'s own public node facts after one trust read', async () => {
  const r = await call({ node_id: ids[3] }, { route: '/v1/ci/node/status' });
  assert.equal(r.status, 200); assert.deepEqual(r.calls.map(c => c.name), ['clued_ci_node_trust_v1']);
  assert.deepEqual(Object.keys(r.body).sort(), ['gateway_open', 'node', 'node_list', 'qualification', 'status']);
  assert.equal(r.body.node.version, 2); assert.equal(r.body.node_list.version, 1);
  const refused = await call({ node_id: ids[3] }, { route: '/v1/ci/node/status', replies: { clued_ci_node_trust_v1: () => ({ status: 'rejected' }) } });
  assert.equal(refused.status, 403); assert.equal(refused.body.error_code, 'CI_NODE_TRUST_REFUSED');
  const extra = await call({ node_id: ids[3], command: {} }, { route: '/v1/ci/node/status' });
  assert.equal(extra.status, 400); assert.equal(extra.calls.length, 0);
});

test('the router sends both node gateway paths to the gateway and nothing else', () => {
  assert.equal(m.isCiNodeGatewayPath('/v1/ci/node'), true); assert.equal(m.isCiNodeGatewayPath('/v1/ci/node/status'), true);
  for (const other of ['/v1/ci/node/', '/v1/ci/nodes', '/v1/ci/scan-start', '/v1/ci/node/status/x']) assert.equal(m.isCiNodeGatewayPath(other), false, other);
});

test('a payload may carry a full 64 KiB sealed-drop ciphertext as base64; the command itself stays bounded', async () => {
  const big = { ciphertext_base64: Buffer.alloc(65536, 7).toString('base64') };
  const c = await (async () => {
    const x = { protocol: 'clued.ci-node-command/1', operation: 'sealed_drop_send', ...principal, node_id: ids[3], node_version: 2, key_version: 1,
      key_fingerprint: fingerprint, payload_sha256: hex(m.ciCanonicalJson(big, m.CI_MAX_PAYLOAD_BYTES)), nonce: crypto.randomBytes(32).toString('base64url'),
      job_id: ids[0], execution_generation: 1, train_generation: 0, issued_at_ms: Date.now() - 1000, expires_at_ms: Date.now() + 60000,
      signature: Buffer.alloc(64).toString('base64url') };
    x.signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, m.ciCommandSigningBytes(x))).toString('base64url');
    return x;
  })();
  const r = await call({ command: c, payload: big }, { replies: { clued_ci_node_trust_v1: () => trustDoc({ qualification_verified: true, qualification_expires_at_ms: Date.now() + 3600000 }),
    clued_ci_node_command_v1: () => ({ status: 'committed', operation: 'sealed_drop_send', result: {}, replayed: false }) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.calls[2].body.p_payload.ciphertext_base64.length, big.ciphertext_base64.length);
});
