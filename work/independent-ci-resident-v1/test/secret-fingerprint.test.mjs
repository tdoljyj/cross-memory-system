// Primary/standby C7 (DESIGN.md section 30): tools/secret-fingerprint.mjs, the fingerprints the install checks before it
// places the App key and the ci-admission token. Offline. The key is a throw-away RSA key generated in memory for this test
// (never written to the repository, never a real App key); the token is a made-up string.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_TOKEN_DOMAIN, fingerprintAppKey, fingerprintCiToken } from '../tools/secret-fingerprint.mjs';
// The runtime's own digest (Source proof.mjs): the formula the controller entries apply on every start.
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';

const TOOL = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'tools', 'secret-fingerprint.mjs');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' });
const token = 'clued_bnd_' + randomBytes(24).toString('base64url');

// entry-runtime.mjs#controllerPrincipal, verbatim: the value the record's appPublicKeySha256Base64 is compared with.
const runtimeKeyFingerprint = appKey => createHash('sha256').update(createPublicKey(appKey).export({ type: 'spki', format: 'der' })).digest('base64');

function run(kind, input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [TOOL, ...(kind === null ? [] : [kind])], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', () => {});
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('the app-key fingerprint is the runtime formula over the public half, for PKCS#8 and PKCS#1 private keys', () => {
  assert.equal(fingerprintAppKey(pem), runtimeKeyFingerprint(pem));
  assert.equal(fingerprintAppKey(pkcs1), runtimeKeyFingerprint(pem));
  assert.match(fingerprintAppKey(pem), /^[A-Za-z0-9+/]{43}=$/);
  // whatever the runtime's parser takes (it skips text before the BEGIN line), the tool takes, and to the same value
  assert.equal(fingerprintAppKey('﻿' + pem), runtimeKeyFingerprint('﻿' + pem));
});

test('the token fingerprint is the runtime pin formula, over the trimmed token', () => {
  const pin = digest('clued.independent-ci.ci-binding-pin/1\0' + token);
  assert.equal(CI_TOKEN_DOMAIN, 'clued.independent-ci.ci-binding-pin/1\0');
  assert.equal(fingerprintCiToken(token), pin);
  for (const wrapped of [token + '\n', token + '\r\n', '﻿' + token, '  ' + token + ' \t\n']) assert.equal(fingerprintCiToken(wrapped), pin);
});

test('anything that is not a private RSA key or a ci-admission token is refused with one code', () => {
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  for (const bad of [publicPem, ec, 'not a key', '', pem.slice(0, 120)]) assert.throws(() => fingerprintAppKey(bad), { code: 'SECRET_FINGERPRINT_REFUSED' });
  for (const bad of ['', 'clued_bnd_short', 'bnd_' + token, token + 'x y', token.replace('clued_bnd_', 'clued_xyz_')]) assert.throws(() => fingerprintCiToken(bad), { code: 'SECRET_FINGERPRINT_REFUSED' });
});

test('as a process: the secret comes on stdin, only the fingerprint comes out, nothing of the secret is printed', async () => {
  const key = await run('app-key', pem);
  assert.equal(key.code, 0); assert.equal(key.stderr, '');
  assert.deepEqual(JSON.parse(key.stdout), { kind: 'app-key', fingerprint: runtimeKeyFingerprint(pem) });
  const tok = await run('ci-token', token + '\r\n');
  assert.equal(tok.code, 0); assert.equal(tok.stderr, '');
  assert.deepEqual(JSON.parse(tok.stdout), { kind: 'ci-token', fingerprint: digest(CI_TOKEN_DOMAIN + token) });
  for (const out of [key.stdout, tok.stdout]) assert.doesNotMatch(out, /PRIVATE KEY|clued_bnd_/);
  const body = pem.split('\n').find(l => l.length > 40);
  for (const bad of [await run('app-key', pem.slice(0, 200)), await run('ci-token', 'clued_bnd_x'), await run('app-key', ''), await run('app-key', 'x'.repeat(70000)),
    await run('other', pem), await run(null, pem), await run('ci-token', Buffer.from([0xff, 0xfe, 0x00]))]) {
    assert.equal(bad.code, 2);
    assert.equal(bad.stdout, '');
    assert.equal(bad.stderr, 'SECRET_FINGERPRINT_REFUSED\n');
  }
  assert.ok(body && !(await run('app-key', pem.slice(0, 200))).stderr.includes(body.slice(0, 30)));
});

// Task 293a092a: the heartbeat connection's token (clued_hbt_) has its own kind; neither kind accepts the other's prefix.
test('heartbeat-token: only clued_hbt_ tokens, under their own domain; a CI token is never one', async () => {
  const { HEARTBEAT_TOKEN_DOMAIN, fingerprintHeartbeatToken } = await import('../tools/secret-fingerprint.mjs');
  const hbt = 'clued_hbt_' + 'HeartbeatFixtureValue0123456789abcdefghijkl';
  assert.equal(fingerprintHeartbeatToken(hbt + '\r\n'), createHash('sha256').update(HEARTBEAT_TOKEN_DOMAIN + hbt).digest('hex'));
  assert.notEqual(HEARTBEAT_TOKEN_DOMAIN, CI_TOKEN_DOMAIN);
  assert.throws(() => fingerprintHeartbeatToken(token), { code: 'SECRET_FINGERPRINT_REFUSED' });
  assert.throws(() => fingerprintCiToken(hbt), { code: 'SECRET_FINGERPRINT_REFUSED' });
  const out = await run('heartbeat-token', hbt + '\n');
  assert.equal(out.code, 0); assert.equal(out.stderr, '');
  assert.deepEqual(JSON.parse(out.stdout), { kind: 'heartbeat-token', fingerprint: fingerprintHeartbeatToken(hbt) });
  assert.doesNotMatch(out.stdout, /clued_hbt_/);
  const refused = await run('heartbeat-token', token);
  assert.deepEqual([refused.code, refused.stdout, refused.stderr], [2, '', 'SECRET_FINGERPRINT_REFUSED\n']);
});

test('the private RPC pipe returns the authentication digest of the trimmed installed carrier', async () => {
  const out = await run('ci-rpc', '  ' + token + '\r\n');
  assert.deepEqual([out.code, out.stderr], [0, '']);
  assert.deepEqual(JSON.parse(out.stdout), { kind: 'ci-rpc', fingerprint: digest(token) });
  assert.ok(!out.stdout.includes(token));
  const refused = await run('ci-rpc', 'not-a-ci-carrier');
  assert.deepEqual([refused.code, refused.stdout, refused.stderr], [2, '', 'SECRET_FINGERPRINT_REFUSED\n']);
});
