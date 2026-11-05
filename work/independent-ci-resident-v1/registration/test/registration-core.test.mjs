// Registration export core (Task c9673047): canonical JSON, the page's rules and the document it builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  CAPABILITIES, ENVIRONMENT_KINDS, PROFILE_KEYS, REGISTRATION_KEYS, buildRegistration, canonicalDigest, canonicalJson, databaseRefuses, jwkFromPublicPem,
  keyFingerprint, publicDocument, publicJwk, sourceFromManifest, validProfile, validateFacts, validateRegistration,
} from '../registration-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.resolve(here, '../../../../apps/clued-cloud/app/ci-nodes/page.tsx');
// A fresh key pair the registration RPC accepts, as init-keys makes them: about one random pair in 6,500 has a coordinate the RPC
// refuses, and a test that needs a good key must not fail on it (generation 11: the flaky random-key case).
const newKey = () => {
  for (;;) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = jwkFromPublicPem(publicKey.export({ type: 'spki', format: 'pem' }));
    if (!databaseRefuses(publicJwk)) return { publicJwk, privateJwk: privateKey.export({ format: 'jwk' }) };
  }
};
// A real P-256 public key whose x coordinate holds `text` at `at` (deterministic: no random search). y = sqrt(x^3 - 3x + b) mod p,
// p = 3 mod 4; when x^3 - 3x + b is not a square, the character after the text is changed and the next x is tried.
const P256 = { p: 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n, b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn };
const modPow = (base, exp, mod) => { let r = 1n; base %= mod; for (; exp > 0n; exp >>= 1n) { if (exp & 1n) r = r * base % mod; base = base * base % mod; } return r; };
const b64 = n => Buffer.from(n.toString(16).padStart(64, '0'), 'hex').toString('base64url');
function keyWith(text, at) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const base = 'axq7Bp2LmN0rTv5WzY8cDf3GhJ6kMs9QuXe1Ri4Ow2E'; // 43 characters, the last one encodes zero spare bits
  for (const c of ALPHABET) {
    const x64 = (base.slice(0, at) + text + c + base.slice(at + text.length + 1)).slice(0, 43);
    const x = BigInt('0x' + Buffer.from(x64, 'base64url').toString('hex'));
    if (x >= P256.p || b64(x) !== x64) continue;
    const rhs = ((x ** 3n - 3n * x + P256.b) % P256.p + P256.p) % P256.p;
    const y = modPow(rhs, (P256.p + 1n) / 4n, P256.p);
    if (y * y % P256.p !== rhs) continue;
    const jwk = { kty: 'EC', crv: 'P-256', x: x64, y: b64(y) };
    createPublicKey({ key: jwk, format: 'jwk' }); // on the curve
    return jwk;
  }
  throw new Error('no point found');
}
const facts = (over = {}) => ({
  os: 'linux', os_version: 'Linux 6.8.0', hostname: 'company-linux-01', memory_mb: 32000, docker_server_version: '27.3.1',
  hyperv_enabled: null, windows_sandbox_enabled: null, tpm_present: false, identity_public_jwk: newKey().publicJwk,
  encryption_public_jwk: newKey().publicJwk, identity_key_origin: 'software', encryption_key_origin: 'software', ...over,
});
const options = (over = {}) => ({ bindingId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', slotCount: 2,
  source: { commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) }, generatedAt: '2026-10-31T12:00:00.000Z', ...over });

test('canonical JSON is the stage-1 subset: sorted keys, integers only, no accessors', () => {
  assert.equal(canonicalJson({ b: [1, true, null], a: 'x', c: { z: 1, y: 'é' } }), '{"a":"x","b":[1,true,null],"c":{"y":"é","z":1}}');
  assert.throws(() => canonicalJson({ a: 1.5 }), /CANONICAL_INVALID/);
  assert.throws(() => canonicalJson({ a: '\ud800' }), /CANONICAL_INVALID/);
  assert.throws(() => canonicalJson(new Date()), /CANONICAL_INVALID/);
  assert.throws(() => canonicalJson(Object.defineProperty({}, 'a', { get: () => 1, enumerable: true })), /CANONICAL_INVALID/);
  let deep = 0; for (let i = 0; i < 17; i++) deep = [deep];
  assert.throws(() => canonicalJson(deep), /CANONICAL_INVALID/);
});

test('the key lists match the Native page, so a page change cannot silently diverge', () => {
  const page = fs.readFileSync(PAGE, 'utf8');
  const list = (source, anchor) => {
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, anchor);
    const open = source.indexOf('[', start);
    return [...source.slice(open, source.indexOf(']', open)).matchAll(/"([^"]+)"/g)].map(m => m[1]);
  };
  const registration = page.slice(page.indexOf('function registrationDocument'));
  assert.deepEqual(list(registration, 'const keys ='), [...REGISTRATION_KEYS]);
  const profile = page.slice(page.indexOf('function validProfile'));
  assert.deepEqual(list(profile, 'const keys ='), [...PROFILE_KEYS]);
  assert.deepEqual(list(profile, 'const capabilities ='), [...CAPABILITIES]);
  assert.deepEqual(list(profile, 'value.environment_kinds,'), [...ENVIRONMENT_KINDS]);
});

test('a built registration passes every page rule and contains no private key field', () => {
  const f = facts();
  const { registration, report } = buildRegistration(f, options({ roles: ['scan'], siteId: 'office-a', environmentKinds: ['E1-Linux'] }));
  assert.deepEqual(Object.keys(registration), [...REGISTRATION_KEYS]);
  validateRegistration(registration, ['0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0']);
  assert.ok(publicDocument(registration) && publicDocument(report));
  assert.deepEqual(registration.profile, { schema: 'clued.ci-node-profile/1', slot_count: 2, identity_key_origin: 'software',
    capabilities: ['linux', 'docker', 'scan'], exclusions: [], site_id: 'office-a', environment_kinds: ['E1-Linux'], memory_limit_mb: 32000 });
  assert.equal(registration.profile_sha256, canonicalDigest(registration.profile));
  assert.equal(registration.qualification_digest, canonicalDigest(report));
  assert.equal(registration.qualification_source, 'a'.repeat(40));
  assert.equal(report.keys.identity_fingerprint, keyFingerprint(f.identity_public_jwk));
  assert.equal(registration.publisher_requested, false);
  assert.equal(registration.scan_signing_requested, false);
  assert.doesNotMatch(JSON.stringify({ registration, report }), /"d"\s*:|PRIVATE KEY/);
});

test('roles are only what the operator declares; Windows features become capabilities when enabled', () => {
  const plain = buildRegistration(facts({ docker_server_version: null }), options()).registration.profile;
  assert.deepEqual(plain.capabilities, ['linux']);
  const windows = buildRegistration(facts({ os: 'windows', hyperv_enabled: true, windows_sandbox_enabled: false, identity_key_origin: 'tpm' }),
    options({ roles: ['publish', 'control'], exclusions: ['relay'] })).registration.profile;
  assert.deepEqual(windows.capabilities, ['windows', 'docker', 'hyper-v', 'publish', 'control']);
  assert.deepEqual(windows.exclusions, ['relay']);
  assert.equal(windows.identity_key_origin, 'tpm');
  assert.throws(() => buildRegistration(facts(), options({ roles: ['docker'] })), /OPTION_INVALID/);
  assert.throws(() => buildRegistration(facts(), options({ roles: ['scan'], exclusions: ['scan'] })), /OPTION_INVALID/);
  assert.throws(() => buildRegistration(facts(), options({ slotCount: 0 })), /OPTION_INVALID/);
  assert.throws(() => buildRegistration(facts(), options({ slotCount: 65 })), /OPTION_INVALID/);
  assert.throws(() => buildRegistration(facts(), options({ environmentKinds: ['E2-Linux'] })), /OPTION_INVALID/);
  assert.throws(() => buildRegistration(facts(), options({ siteId: '-bad' })), /OPTION_INVALID/);
  assert.equal(buildRegistration(facts({ memory_mb: 5_000_000 }), options()).registration.profile.memory_limit_mb, 1048576);
});

test('refusals: private key fields, same key twice, off-curve points, missing Source, bad binding id', () => {
  const key = newKey();
  assert.throws(() => publicJwk(key.privateJwk), /PUBLIC_KEY_INVALID/, 'a private JWK is refused, not trimmed');
  assert.throws(() => validateFacts(facts({ identity_public_jwk: key.privateJwk })), /FACTS_INVALID|PUBLIC_KEY_INVALID/);
  assert.throws(() => publicJwk({ kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) }), /PUBLIC_KEY_INVALID/);
  assert.throws(() => buildRegistration(facts({ identity_public_jwk: key.publicJwk, encryption_public_jwk: key.publicJwk }), options()), /REGISTRATION_INVALID/);
  assert.throws(() => buildRegistration(facts(), options({ source: { commit: 'abc' } })), /SOURCE_UNAVAILABLE/);
  assert.throws(() => buildRegistration(facts(), options({ bindingId: 'not-a-uuid' })), /OPTION_INVALID/);
  assert.throws(() => validateFacts({ ...facts(), extra: 1 }), /FACTS_INVALID/);
  assert.throws(() => validateFacts(facts({ os_version: '-----BEGIN PRIVATE KEY----- x' })), /FACTS_INVALID/);
  const { registration } = buildRegistration(facts(), options());
  assert.throws(() => validateRegistration({ ...registration, profile_sha256: 'c'.repeat(64) }), /does not match/);
  assert.throws(() => validateRegistration({ ...registration, secret: 'x' }), /REGISTRATION_INVALID/);
  assert.throws(() => validateRegistration(registration, ['11111111-1111-1111-1111-111111111111']), /not listed/);
  assert.ok(validProfile(registration.profile));
});

test('canonical JSON and fingerprints are byte-identical to the stage-1 Worker candidate', async t => {
  // Transpiled with the app's own TypeScript (apps/clued-cloud/node_modules); skipped where the app's dependencies are not installed.
  const app = path.resolve(here, '../../../../apps/clued-cloud');
  let ts;
  try { ts = createRequire(path.join(app, 'package.json'))('typescript'); }
  catch { t.skip('apps/clued-cloud dependencies are not installed (npm ci there to run this check)'); return; }
  const source = fs.readFileSync(path.join(app, 'worker/ci-scheduling-v1.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const worker = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const samples = [{ b: [1, true, null], a: 'x', c: { z: 1, y: 'é', '': [] } }, { slot_count: 3, capabilities: ['linux', 'scan'], schema: 'clued.ci-node-profile/1' },
    'string', -42, [[], {}], { 'Z': 1, 'a': 2, 'é': 3, '\u{1F600}': 4 }];
  for (const sample of samples) assert.equal(canonicalJson(sample), worker.ciCanonicalJson(sample));
  const jwk = newKey().publicJwk;
  assert.equal(keyFingerprint(jwk), await worker.ciIdentityFingerprint(jwk));
});

test('documents the registration RPC would refuse are caught here, including inside key coordinates', () => {
  assert.equal(databaseRefuses('xxghp_yy'), true, 'no word boundary, unlike the page');
  assert.equal(databaseRefuses('GHO_'), true, 'case-insensitive');
  assert.equal(databaseRefuses('github_pat'), false);
  // Real keys whose x coordinate holds such text (about one random pair in 6,500 does). Inside a word ("AgHo_") only the RPC refuses
  // it; at a word boundary (the start, or after "-") the page's publicDocument refuses it too. Either way the cause reported is
  // KEY_UNREGISTRABLE, never FACTS_INVALID or REGISTRATION_INVALID "not a public document" (the flaky case: a random search found
  // a boundary key about once in forty runs).
  const inner = keyWith('AgHo_', 10), boundary = keyWith('-ghp_', 10), start = keyWith('gho_', 0);
  assert.deepEqual([inner, boundary, start].map(k => databaseRefuses(k)), [true, true, true]);
  assert.deepEqual([inner, boundary, start].map(k => publicDocument(k)), [true, false, false], 'only the boundary keys are not public documents');
  for (const key of [inner, boundary, start]) {
    for (const over of [{ identity_public_jwk: key }, { encryption_public_jwk: key }]) {
      assert.throws(() => validateFacts(facts(over)), /KEY_UNREGISTRABLE/, key.x);
      assert.throws(() => buildRegistration(facts(over), options()), /KEY_UNREGISTRABLE/, key.x);
    }
  }
  // the registration document itself: the same cause first
  const good = buildRegistration(facts(), options());
  for (const key of [inner, boundary, start]) assert.throws(() => validateRegistration({ ...good, identity_public_jwk: key }), /KEY_UNREGISTRABLE/, key.x);
  // anything that is not a valid public key keeps its own refusal
  assert.throws(() => validateFacts(facts({ identity_public_jwk: { ...inner, y: inner.x } })), /PUBLIC_KEY_INVALID/);
  // the helper itself: every key it makes is accepted
  for (let i = 0; i < 50; i++) assert.equal(databaseRefuses(newKey().publicJwk), false);
});

test('the installed source manifest gives the Source commit and its own hash', () => {
  const bytes = Buffer.from(JSON.stringify({ schema: 'independent-ci.sources.v2', repo: 'tdoljyj/cross-memory-system', sourceSha: 'c'.repeat(40), roles: {} }));
  const source = sourceFromManifest(bytes);
  assert.equal(source.commit, 'c'.repeat(40));
  assert.match(source.manifestSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => sourceFromManifest(Buffer.from('{"sourceSha":"short"}')), /SOURCE_UNAVAILABLE/);
  assert.throws(() => sourceFromManifest(Buffer.from('not json')), /SOURCE_UNAVAILABLE/);
});
