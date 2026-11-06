import assert from 'node:assert/strict';
import { webcrypto, randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build, stop } from 'esbuild';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-ci-signature-'));
await build({ entryPoints: [path.join(cloud, 'worker/ci-scheduling-v1.ts')],
  outfile: path.join(directory, 'candidate.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
stop();
const candidate = await import(pathToFileURL(path.join(directory, 'candidate.mjs')).href);
const { ciCanonicalJson, ciCommandSigningBytes, ciIdentityFingerprint, verifyCiNodeCommand } = candidate;
const now = 1800000000000;
const ids = Array.from({ length: 5 }, (_, i) => `${i + 1}`.repeat(8) + '-1111-4111-8111-' + `${i + 1}`.repeat(12));
const principal = { user_id: ids[0], project_id: ids[1], binding_id: ids[2], binding_generation: 1 };
const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const publicJwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
const fingerprint = await ciIdentityFingerprint(publicJwk);
const node = { ...principal, node_id: ids[3], version: 3, key_version: 1,
  identity_fingerprint: fingerprint, identity_public_jwk: publicJwk,
  state: 'active', qualification_verified: true, publisher_approved: true,
  binding_expires_at_ms: now + 3600000, qualification_expires_at_ms: now + 3600000 };
const payload = { job_id: ids[4], outcome: 'failed', evidence_sha256: 'a'.repeat(64) };
const sha = value => createHash('sha256').update(ciCanonicalJson(value)).digest('hex');
async function signed(changes = {}, data = payload) {
  const command = { protocol: candidate.CI_SIGNATURE_PROTOCOL, operation: 'job_release', ...principal,
    node_id: node.node_id, node_version: 3, key_version: 1, key_fingerprint: fingerprint,
    payload_sha256: sha(data), nonce: randomBytes(32).toString('base64url'),
    job_id: ids[4], execution_generation: 1, train_generation: 0,
    issued_at_ms: now - 1000, expires_at_ms: now + 30000,
    signature: Buffer.alloc(64).toString('base64url'), ...changes };
  command.signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
    ciCommandSigningBytes(command))).toString('base64url');
  return command;
}
const verify = (command, data = payload, actor = principal, read = async () => node, clock = () => now) =>
  verifyCiNodeCommand(command, data, actor, read, clock);

test('P-256 real signature binds payload, identity, operation, tenant and all generations', async () => {
  const command = await signed();
  let reads = 0;
  const result = await verify(command, payload, principal, async () => { reads++; return node; });
  assert.equal(result.ok, true); assert.equal(reads, 2);
  assert.equal(result.observation.kind, 'signature_observation_only');
  assert.equal(result.observation.payload_sha256, sha(payload));
  assert.equal(result.observation.nonce_sha256, createHash('sha256').update(command.nonce).digest('hex'));
  assert.equal(Object.hasOwn(result.observation, 'signature_verified'), false);
  for (const changed of [{ operation: 'job_started' }, { execution_generation: 2 }, { train_generation: 1 }, { nonce: randomBytes(32).toString('base64url') }])
    assert.equal((await verify({ ...command, ...changed })).code, 'SIGNATURE_INVALID');
  assert.equal((await verify(command, { ...payload, outcome: 'completed' })).code, 'SIGNATURE_INVALID');
});

test('same body order yields stable bytes; malformed canonical inputs are bounded and rejected', () => {
  assert.equal(ciCanonicalJson({ b: 1, a: ['中文', true, null] }), ciCanonicalJson({ a: ['中文', true, null], b: 1 }));
  const nested = {}; nested.self = nested;
  let getter = 0; const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { getter++; return 1; } });
  const badArray = [1]; Object.defineProperty(badArray, '0', { get() { getter++; return 1; } });
  for (const value of [undefined, NaN, Infinity, 1.5, -0, 2 ** 53, new Date(), accessor, badArray, nested,
    [Symbol('x')], Array(3), { s: '\ud800' }, { s: '\udfff' }, { s: '中'.repeat(30000) },
    Array.from({ length: 256 }, () => 'x'.repeat(1024))]) assert.throws(() => ciCanonicalJson(value));
  assert.equal(getter, 0);
});

test('public key fingerprint is canonical public-only SHA256; reject private/algorithm fields', async () => {
  assert.equal(await ciIdentityFingerprint({ y: publicJwk.y, x: publicJwk.x, crv: 'P-256', kty: 'EC' }), fingerprint);
  for (const extra of [{ d: 'secret' }, { alg: 'ES256' }, { key_ops: ['sign'] }, { crv: 'P-384' }])
    await assert.rejects(() => ciIdentityFingerprint({ ...publicJwk, ...extra }));
});

test('strict envelope rejects unknown keys, padded/noncanonical encoding and wrong algorithm', async () => {
  const command = await signed();
  for (const extra of [{ signature_verified: true }, { protocol: 'legacy' }, { nonce: command.nonce + '=' },
    { signature: command.signature + '=' }, { operation: 'arbitrary_rpc' }, { job_id: null },
    { execution_generation: 0 }, { expires_at_ms: now + 120001 }])
    assert.equal((await verify({ ...command, ...extra })).code, 'INPUT_INVALID');
});

test('principal, scope, node/key versions and Publisher capability are independently checked', async () => {
  const command = await signed();
  assert.equal((await verify(command, payload, { ...principal, binding_generation: 2 })).code, 'PRINCIPAL_INVALID');
  for (const changed of [{ state: 'revoked' }, { qualification_verified: false }, { binding_expires_at_ms: now },
    { qualification_expires_at_ms: Infinity }, { binding_id: ids[4] }])
    assert.equal((await verify(command, payload, principal, async () => ({ ...node, ...changed }))).code, 'PRINCIPAL_INVALID');
  assert.equal((await verify(command, payload, principal, async () => ({ ...node, project_id: ids[4] }))).code, 'SCOPE_DENIED');
  for (const changed of [{ version: 4 }, { key_version: 2 }, { identity_fingerprint: 'b'.repeat(64) }])
    assert.equal((await verify(command, payload, principal, async () => ({ ...node, ...changed }))).code, 'STALE_VERSION');
  assert.equal((await verify(await signed({ operation: 'publish_prepare' }), payload, principal,
    async () => ({ ...node, publisher_approved: false }))).code, 'SCOPE_DENIED');
});

test('expiry and revocation during cryptographic awaits refuse the command', async () => {
  const command = await signed(); let reads = 0;
  assert.equal((await verify(command, payload, principal, async () => ++reads === 1 ? node : { ...node, state: 'revoked' })).code, 'PRINCIPAL_INVALID');
  let ticks = 0;
  assert.equal((await verify(command, payload, principal, async () => node, () => ++ticks === 1 ? now : command.expires_at_ms)).code, 'COMMAND_EXPIRED');
  assert.equal((await verify(await signed({ issued_at_ms: now + 1 }))).code, 'COMMAND_EXPIRED');
  assert.equal((await verify(await signed({ expires_at_ms: now }))).code, 'COMMAND_EXPIRED');
});

test('draining accepts trusted existing-job settlement, never new execution/publication', async () => {
  const drain = async () => ({ ...node, state: 'draining' });
  for (const operation of ['job_release', 'result_register', 'publish_observe', 'green_transition', 'job_renew', 'nonce_issue'])
    assert.equal((await verify(await signed({ operation }), payload, principal, drain)).ok, true, operation);
  for (const operation of ['node_heartbeat', 'green_mirror_append'])
    assert.equal((await verify(await signed({ operation, job_id: null, execution_generation: 0 }), payload, principal, drain)).ok, true, operation);
  for (const operation of ['job_lease', 'job_lease_next', 'qualification_report', 'sealed_drop_take'])
    assert.equal((await verify(await signed({ operation, ...(['qualification_report', 'job_lease_next'].includes(operation) ? { job_id: null, execution_generation: 0 } : {}) }),
      payload, principal, drain)).code, 'PRINCIPAL_INVALID', operation);
  for (const operation of ['job_started', 'publish_prepare', 'stage8_try_begin', 'sealed_drop_send', 'train_front_set'])
    assert.equal((await verify(await signed({ operation }), payload, principal, drain)).code, 'PRINCIPAL_INVALID', operation);
});

test('last trust read crossing expiry checks the clock after that read completes', async () => {
  const command = await signed(); let reads = 0, time = now;
  const result = await verify(command, payload, principal, async () => {
    if (++reads === 2) time = command.expires_at_ms;
    return node;
  }, () => time);
  assert.deepEqual(result, { ok: false, code: 'COMMAND_EXPIRED' });
});

test('a lookup outage is a refusal and no request input survives as mutable authority', async () => {
  const command = await signed();
  assert.deepEqual(await verify(command, payload, principal, async () => { throw new Error('private detail'); }), { ok: false, code: 'TRUST_LOOKUP_FAILED' });
  const body = { ...payload }; const actor = { ...principal };
  const result = await verify(command, body, actor, async () => { body.outcome = 'completed'; actor.binding_id = ids[4]; return node; });
  assert.equal(result.ok, true); assert.equal(result.observation.payload_sha256, sha(payload));
});

test('2B: job-scoped operations name their job and jobless ones never do', async () => {
  // Malformed envelopes cannot be signed through ciCommandSigningBytes; the verifier
  // refuses them while parsing, before any signature check.
  const malformed = async changes => ({ ...(await signed()), ...changes });
  for (const operation of ['qualification_report', 'green_mirror_append', 'train_sweep_confirm', 'node_heartbeat', 'job_lease_next']) {
    assert.equal((await verify(await malformed({ operation }))).code, 'INPUT_INVALID', operation + ' with a job');
    assert.equal((await verify(await signed({ operation, job_id: null, execution_generation: 0 }))).ok, true, operation);
  }
  for (const operation of ['nonce_issue', 'job_lease', 'job_renew', 'job_started', 'result_register', 'publish_observe', 'sealed_drop_take'])
    assert.equal((await verify(await malformed({ operation, job_id: null, execution_generation: 0 }))).code, 'INPUT_INVALID', operation + ' without a job');
  assert.equal((await verify(await malformed({ operation: 'unknown_operation' }))).code, 'INPUT_INVALID');
});

test('2B: only a qualification report and a publisher\'s mirror record are accepted without a current qualification', async () => {
  const report = { operation: 'qualification_report', job_id: null, execution_generation: 0 };
  for (const changed of [{ qualification_verified: false }, { qualification_expires_at_ms: 0 }, { qualification_expires_at_ms: now }]) {
    assert.equal((await verify(await signed(report), payload, principal, async () => ({ ...node, ...changed }))).ok, true, JSON.stringify(changed));
    assert.equal((await verify(await signed(), payload, principal, async () => ({ ...node, ...changed }))).code, 'PRINCIPAL_INVALID');
    assert.equal((await verify(await signed({ operation: 'green_mirror_append', job_id: null, execution_generation: 0 }), payload, principal,
      async () => ({ ...node, ...changed }))).ok, true);
    assert.equal((await verify(await signed({ operation: 'green_mirror_append', job_id: null, execution_generation: 0 }), payload, principal,
      async () => ({ ...node, ...changed, state: 'draining' }))).ok, true);
  }
  for (const changed of [{ state: 'pending' }, { state: 'draining' }, { state: 'revoked' }, { binding_expires_at_ms: now }])
    assert.equal((await verify(await signed(report), payload, principal, async () => ({ ...node, qualification_verified: false, ...changed }))).code,
      'PRINCIPAL_INVALID', JSON.stringify(changed));
});

test('2B: mirror rows come only from approved publishers', async () => {
  const mirror = { operation: 'green_mirror_append', job_id: null, execution_generation: 0 };
  assert.equal((await verify(await signed(mirror), payload, principal, async () => ({ ...node, publisher_approved: false }))).code, 'SCOPE_DENIED');
  assert.equal((await verify(await signed(mirror))).ok, true);
});

test.after(async () => {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('clued-ci-signature-'));
  await fs.rm(resolved, { recursive: true, force: true });
});
