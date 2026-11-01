// OIDC verification (S16): RS256 with node:crypto, fixed issuer and JWKS
// origin, bounded JWKS, kid rotation, the protected file cache. Keys are
// generated per run; no token or key is stored in the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { GITHUB_OIDC_ISSUER, GITHUB_OIDC_JWKS_URL, createGitHubOidcVerifier, createJwksFileCache, createJwksPort,
  MAX_TOKEN_LENGTH, decodeJwtUnverified, parseJwks, tokenFromAnnotation } from '../src/hosted-relay-v1/oidc.mjs';

const AUD = 'clued-hosted-relay-v1';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (pair, kid) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' });
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(claims, { key = rsa.privateKey, header = { alg: 'RS256', kid: 'k1', typ: 'JWT', x5t: 'fixture' } } = {}) {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}
const claims = (extra = {}) => ({ iss: GITHUB_OIDC_ISSUER, aud: AUD, sub: 'repo:tdoljyj/cross-memory-system:pull_request', iat: 1_790_000_000, ...extra });
const refusal = code => error => error.code === code;
function port(documents) {
  const queue = [...documents], calls = { count: 0 };
  return { calls, fetchJwks: async () => { calls.count++; const next = queue.length > 1 ? queue.shift() : queue[0]; return structuredClone(next); } };
}

test('a GitHub-signed token verifies once its kid is known and the JWKS is reused', async () => {
  const jwks = port([{ keys: [jwkOf(rsa, 'k1')] }]);
  const verifier = createGitHubOidcVerifier({ audience: AUD, jwksPort: jwks, clock: () => 1_000_000 });
  const token = sign(claims({ run_id: '42' }));
  const result = await verifier.verify(token);
  assert.equal(result.verified, true);
  assert.equal(result.claims.run_id, '42');
  assert.match(result.tokenSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(result.claims));
  await verifier.verify(sign(claims({ run_id: '43' })));
  assert.equal(jwks.calls.count, 1);
});

test('signature, algorithm, header, issuer and audience are enforced', async () => {
  const verifier = createGitHubOidcVerifier({ audience: AUD, jwksPort: port([{ keys: [jwkOf(rsa, 'k1')] }]) });
  const good = sign(claims());
  const [h, p, s] = good.split('.');
  await assert.rejects(verifier.verify(`${h}.${b64(claims({ aud: 'x' }))}.${s}`), refusal('OIDC_SIGNATURE_INVALID'));
  await assert.rejects(verifier.verify(sign(claims(), { key: rotated.privateKey })), refusal('OIDC_SIGNATURE_INVALID'));
  await assert.rejects(verifier.verify(`${h}.${p}.${s.slice(0, -4)}AAAA`), error => ['OIDC_SIGNATURE_INVALID', 'OIDC_TOKEN_MALFORMED'].includes(error.code));
  const none = `${b64({ alg: 'none', kid: 'k1' })}.${p}.AA`;
  await assert.rejects(verifier.verify(none), refusal('OIDC_ALG_REFUSED'));
  const hsInput = `${b64({ alg: 'HS256', kid: 'k1', typ: 'JWT' })}.${p}`;
  await assert.rejects(verifier.verify(`${hsInput}.${createHmac('sha256', 'k').update(hsInput).digest('base64url')}`), refusal('OIDC_ALG_REFUSED'));
  await assert.rejects(verifier.verify(sign(claims(), { header: { alg: 'RS256', kid: 'k1', jku: 'https://attacker.invalid/jwks' } })), refusal('OIDC_HEADER_REFUSED'));
  await assert.rejects(verifier.verify(sign(claims(), { header: { alg: 'RS256', kid: 'k1', typ: 'JOSE+JSON' } })), refusal('OIDC_HEADER_REFUSED'));
  await assert.rejects(verifier.verify(sign(claims(), { header: { alg: 'RS256', kid: '../k1' } })), refusal('OIDC_HEADER_REFUSED'));
  await assert.rejects(verifier.verify(sign(claims({ iss: 'https://token.actions.githubusercontent.com.attacker.invalid' }))), refusal('OIDC_ISSUER_MISMATCH'));
  await assert.rejects(verifier.verify(sign(claims({ aud: 'sts.amazonaws.com' }))), refusal('OIDC_AUDIENCE_MISMATCH'));
  await assert.rejects(verifier.verify(sign(claims({ aud: [AUD] }))), refusal('OIDC_AUDIENCE_MISMATCH'));
  assert.equal((await verifier.verify(good)).verified, true);
});

test('an unknown kid refetches the JWKS once per interval (key rotation)', async () => {
  let now = 10_000_000;
  const jwks = port([{ keys: [jwkOf(rsa, 'k1')] }, { keys: [jwkOf(rsa, 'k1'), jwkOf(rotated, 'k2')] }]);
  const verifier = createGitHubOidcVerifier({ audience: AUD, jwksPort: jwks, clock: () => now, refetchMinIntervalMs: 60_000 });
  await verifier.verify(sign(claims()));
  now += 61_000;
  assert.equal((await verifier.verify(sign(claims(), { key: rotated.privateKey, header: { alg: 'RS256', kid: 'k2' } }))).kid, 'k2');
  assert.equal(jwks.calls.count, 2);
  await assert.rejects(verifier.verify(sign(claims(), { header: { alg: 'RS256', kid: 'k3' } })), refusal('OIDC_KID_UNKNOWN'));
  assert.equal(jwks.calls.count, 2); // within the interval: no third fetch
  now += 61_000;
  await assert.rejects(verifier.verify(sign(claims(), { header: { alg: 'RS256', kid: 'k3' } })), refusal('OIDC_KID_UNKNOWN'));
  assert.equal(jwks.calls.count, 3);
});

test('the JWKS port fetches only the fixed issuer URL, without redirects and with a bounded body', async () => {
  const seen = [];
  const body = JSON.stringify({ keys: [jwkOf(rsa, 'k1')] });
  const ok = (text = body, headers = {}) => new Response(text, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const jwksPort = createJwksPort({ fetchImpl: async (url, options) => { seen.push({ url, method: options.method, redirect: options.redirect }); return ok(); } });
  assert.equal((await jwksPort.fetchJwks()).keys[0].kid, 'k1');
  assert.deepEqual(seen, [{ url: GITHUB_OIDC_JWKS_URL, method: 'GET', redirect: 'error' }]);
  assert.equal(new URL(GITHUB_OIDC_JWKS_URL).origin, GITHUB_OIDC_ISSUER);
  const big = 'x'.repeat(70 * 1024);
  await assert.rejects(createJwksPort({ fetchImpl: async () => ok(big, { 'content-length': String(big.length) }) }).fetchJwks(), refusal('OIDC_JWKS_TOO_LARGE'));
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 80; i++) controller.enqueue(new Uint8Array(1024)); controller.close(); } });
  await assert.rejects(createJwksPort({ fetchImpl: async () => new Response(stream, { status: 200 }) }).fetchJwks(), refusal('OIDC_JWKS_TOO_LARGE'));
  await assert.rejects(createJwksPort({ fetchImpl: async () => new Response('{}', { status: 503 }) }).fetchJwks(), refusal('OIDC_JWKS_UNAVAILABLE'));
  await assert.rejects(createJwksPort({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }).fetchJwks(), refusal('OIDC_JWKS_UNAVAILABLE'));
  await assert.rejects(createJwksPort({ fetchImpl: async () => ok('{not json') }).fetchJwks(), refusal('OIDC_JWKS_INVALID'));
  const moved = { ok: true, status: 200, url: 'https://attacker.invalid/jwks', headers: new Headers(), arrayBuffer: async () => Buffer.from(body) };
  await assert.rejects(createJwksPort({ fetchImpl: async () => moved }).fetchJwks(), refusal('OIDC_ORIGIN_REFUSED'));
  assert.throws(() => createJwksPort({ maxBytes: 10 }), refusal('OIDC_CONFIGURATION_INVALID'));
});

test('JWKS parsing keeps RSA signing keys only and refuses weak or duplicate keys', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  assert.deepEqual([...parseJwks({ keys: [{ ...ec, kid: 'e1' }, jwkOf(rsa, 'k1'), { ...jwkOf(rsa, 'enc'), use: 'enc' }] }).keys()], ['k1']);
  assert.throws(() => parseJwks({ keys: [{ ...ec, kid: 'e1' }] }), refusal('OIDC_JWKS_INVALID'));
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => parseJwks({ keys: [jwkOf(weak, 'w')] }), refusal('OIDC_JWKS_INVALID'));
  assert.throws(() => parseJwks({ keys: [jwkOf(rsa, 'k1'), jwkOf(rotated, 'k1')] }), refusal('OIDC_JWKS_INVALID'));
  assert.throws(() => parseJwks({ keys: [] }), refusal('OIDC_JWKS_INVALID'));
  assert.throws(() => parseJwks({ keys: Array.from({ length: 33 }, (_, i) => jwkOf(rsa, `k${i}`)) }), refusal('OIDC_JWKS_INVALID'));
});

test('the JWKS file cache serves a fresh copy, and a damaged or stale copy is only a miss', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-relay-jwks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheDir = path.join(dir, 'relay', 'jwks');
  let now = Date.parse('2026-10-21T06:00:00Z');
  const first = port([{ keys: [jwkOf(rsa, 'k1')] }]);
  await createGitHubOidcVerifier({ audience: AUD, jwksPort: first, cache: createJwksFileCache(cacheDir), clock: () => now }).verify(sign(claims()));
  assert.equal(first.calls.count, 1);
  const second = port([{ keys: [jwkOf(rsa, 'k1')] }]);
  await createGitHubOidcVerifier({ audience: AUD, jwksPort: second, cache: createJwksFileCache(cacheDir), clock: () => now }).verify(sign(claims()));
  assert.equal(second.calls.count, 0); // served from the protected cache
  const file = path.join(cacheDir, 'jwks.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.jwks.keys.push(jwkOf(rotated, 'k9')); // injected key, integrity no longer matches
  fs.writeFileSync(file, JSON.stringify(record));
  const third = port([{ keys: [jwkOf(rsa, 'k1')] }]);
  const verifier = createGitHubOidcVerifier({ audience: AUD, jwksPort: third, cache: createJwksFileCache(cacheDir), clock: () => now });
  await assert.rejects(verifier.verify(sign(claims(), { key: rotated.privateKey, header: { alg: 'RS256', kid: 'k9' } })), refusal('OIDC_KID_UNKNOWN'));
  assert.equal(third.calls.count, 1);
  now += 3_600_001;
  const fourth = port([{ keys: [jwkOf(rsa, 'k1')] }]);
  await createGitHubOidcVerifier({ audience: AUD, jwksPort: fourth, cache: createJwksFileCache(cacheDir), clock: () => now }).verify(sign(claims()));
  assert.equal(fourth.calls.count, 1); // stale cache refetched
  assert.throws(() => createJwksFileCache('relative/dir'), refusal('OIDC_CONFIGURATION_INVALID'));
});

test('unverified decoding refuses malformed tokens', () => {
  const token = sign(claims());
  assert.equal(decodeJwtUnverified(token).claims.aud, AUD);
  for (const bad of [token.split('.').slice(0, 2).join('.'), `${token}.x`, `${token.split('.')[0]}=.${token.split('.').slice(1).join('.')}`,
    `${b64(['array'])}.${b64(claims())}.AA`, 'a'.repeat(9000), 42]) assert.throws(() => decodeJwtUnverified(bad), refusal('OIDC_TOKEN_MALFORMED'));
});

test('the identity annotation carries the token as lowercase hex; anything else is no token', () => {
  const token = sign(claims()), hex = Buffer.from(token, 'latin1').toString('hex');
  assert.equal(tokenFromAnnotation(hex), token);
  assert.equal(decodeJwtUnverified(tokenFromAnnotation(hex)).claims.aud, AUD);
  // GitHub's masking of a raw JWT, the raw JWT itself, and every near miss of the encoding.
  for (const bad of ['***', token, hex.toUpperCase(), hex.slice(1), `${hex}0`, `${hex} `, '', '00',
    Buffer.from(`${token}\n`).toString('hex'), Buffer.from(`${token} x`).toString('hex'), 'ab'.repeat(MAX_TOKEN_LENGTH + 1), null, 42]) assert.equal(tokenFromAnnotation(bad), null, String(bad).slice(0, 20));
  assert.equal(tokenFromAnnotation('41'.repeat(MAX_TOKEN_LENGTH)), 'A'.repeat(MAX_TOKEN_LENGTH));
});
