// GitHub Actions OIDC token verification (design S16). RS256 with node:crypto
// only, no dependency. The issuer and the JWKS URL are fixed; the JWKS is the
// only thing fetched, from that one origin, through its own bounded port. The
// token is used as a GitHub-signed statement about one run, not as a session
// credential, so `exp` is deliberately not required (design E7).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { relayFail } from './registry.mjs';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
export const JWKS_CACHE_CONTRACT = 'clued.independent-ci.jwks-cache/1';
export const MAX_TOKEN_LENGTH = 8192;
const MAX_SEGMENT_BYTES = 6144;
const DEFAULT_MAX_JWKS_BYTES = 64 * 1024;
const MAX_KEYS = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;
const KID = /^[A-Za-z0-9_.-]{1,128}$/;
const HEADER_KEYS = ['alg', 'kid', 'typ', 'x5t'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function segment(text, code) {
  if (!B64URL.test(text)) relayFail(code, 'base64url');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length === 0 || bytes.length > MAX_SEGMENT_BYTES || bytes.toString('base64url') !== text) relayFail(code, 'encoding');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { relayFail(code, 'json'); }
  if (!plain(value)) relayFail(code, 'object');
  return value;
}

// Pure decode, no signature check. Companion hint mode and the observer use it
// only to read the merge commit it names; nothing decoded here is trusted.
export function decodeJwtUnverified(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > MAX_TOKEN_LENGTH) relayFail('OIDC_TOKEN_MALFORMED', 'length');
  const parts = token.split('.');
  if (parts.length !== 3) relayFail('OIDC_TOKEN_MALFORMED', 'parts');
  const header = segment(parts[0], 'OIDC_TOKEN_MALFORMED');
  const claims = segment(parts[1], 'OIDC_TOKEN_MALFORMED');
  if (!B64URL.test(parts[2])) relayFail('OIDC_TOKEN_MALFORMED', 'signature');
  const signature = Buffer.from(parts[2], 'base64url');
  if (signature.toString('base64url') !== parts[2]) relayFail('OIDC_TOKEN_MALFORMED', 'signature');
  return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature };
}

// The hosted job prints the token's ASCII bytes as lowercase hex: GitHub masks JWT-shaped text in logs and
// annotations, so a raw token arrives as "***" (Task 169fd456). The observer reads every identity annotation
// through this one decoder. Anything but exact lowercase hex of printable ASCII, the masked text and a raw JWT
// included, is null and refused downstream as E6_TOKEN_MALFORMED. Hex doubles the token (about 2.5 KB), far below the
// annotation message limit; a truncated message has an odd length or a bad signature and fails closed.
export function tokenFromAnnotation(message) {
  if (typeof message !== 'string' || message.length === 0 || message.length > 2 * MAX_TOKEN_LENGTH
    || message.length % 2 !== 0 || !/^[0-9a-f]+$/.test(message)) return null;
  const bytes = Buffer.from(message, 'hex');
  if (bytes.some(byte => byte < 0x21 || byte > 0x7e)) return null;
  return bytes.toString('latin1');
}

function headerChecks(header) {
  if (Object.keys(header).some(key => !HEADER_KEYS.includes(key))) relayFail('OIDC_HEADER_REFUSED', 'parameter');
  if (header.alg !== 'RS256') relayFail('OIDC_ALG_REFUSED');
  if (header.typ !== undefined && header.typ !== 'JWT') relayFail('OIDC_HEADER_REFUSED', 'typ');
  if (typeof header.kid !== 'string' || !KID.test(header.kid)) relayFail('OIDC_HEADER_REFUSED', 'kid');
}

// Parse one JWKS document into kid -> RSA public key. Keys that are not RSA
// signing keys are ignored; a malformed RSA entry refuses the whole document.
export function parseJwks(value) {
  if (!plain(value) || !Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > MAX_KEYS) relayFail('OIDC_JWKS_INVALID', 'keys');
  const keys = new Map();
  for (const jwk of value.keys) {
    if (!plain(jwk)) relayFail('OIDC_JWKS_INVALID', 'entry');
    if (jwk.kty !== 'RSA' || (jwk.use !== undefined && jwk.use !== 'sig') || (jwk.alg !== undefined && jwk.alg !== 'RS256')) continue;
    if (typeof jwk.kid !== 'string' || !KID.test(jwk.kid) || keys.has(jwk.kid)
      || typeof jwk.n !== 'string' || !B64URL.test(jwk.n) || typeof jwk.e !== 'string' || !B64URL.test(jwk.e)) relayFail('OIDC_JWKS_INVALID', 'rsa');
    let key;
    try { key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }); } catch { relayFail('OIDC_JWKS_INVALID', 'rsa-key'); }
    const bits = key.asymmetricKeyDetails?.modulusLength;
    if (!(bits >= 2048 && bits <= 8192)) relayFail('OIDC_JWKS_INVALID', 'modulus');
    keys.set(jwk.kid, { key, bytes: bits / 8, thumbprint: sha256(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n })) });
  }
  if (keys.size === 0) relayFail('OIDC_JWKS_INVALID', 'no-rsa-key');
  return keys;
}

async function boundedBody(response, maximum) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maximum) relayFail('OIDC_JWKS_TOO_LARGE');
  let bytes;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maximum) { await reader.cancel().catch(() => {}); relayFail('OIDC_JWKS_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    bytes = Buffer.concat(chunks);
  } else if (typeof response.arrayBuffer === 'function') {
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximum) relayFail('OIDC_JWKS_TOO_LARGE');
  } else relayFail('OIDC_JWKS_UNAVAILABLE', 'body');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { relayFail('OIDC_JWKS_INVALID', 'json'); }
}

// Fixed-origin JWKS port: one GET of one URL, no redirect, bounded body.
export function createJwksPort({ fetchImpl = globalThis.fetch, timeoutMs = 10_000, maxBytes = DEFAULT_MAX_JWKS_BYTES } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024) relayFail('OIDC_CONFIGURATION_INVALID', 'jwks-port');
  const url = new URL(GITHUB_OIDC_JWKS_URL);
  if (url.origin !== GITHUB_OIDC_ISSUER) relayFail('OIDC_ORIGIN_REFUSED');
  return Object.freeze({
    async fetchJwks() {
      let response;
      try {
        response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/json', 'user-agent': 'clued-independent-ci-relay' } });
      } catch { relayFail('OIDC_JWKS_UNAVAILABLE', 'transport'); }
      if (typeof response?.url === 'string' && response.url !== '' && response.url !== url.href) relayFail('OIDC_ORIGIN_REFUSED');
      if (!response?.ok) relayFail('OIDC_JWKS_UNAVAILABLE', `http_${response?.status}`);
      return boundedBody(response, maxBytes);
    },
  });
}

// File cache under the protected relay state (state\relay\jwks\). A damaged,
// linked or oversized cache file is a miss, never an error and never trusted.
export function createJwksFileCache(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) relayFail('OIDC_CONFIGURATION_INVALID', 'cache-directory');
  const file = path.join(directory, 'jwks.json');
  return Object.freeze({
    async read() {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) return null;
        const record = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!plain(record) || record.contract !== JWKS_CACHE_CONTRACT || !Number.isFinite(Date.parse(record.fetchedAt))
          || !plain(record.jwks) || record.jwksSha256 !== sha256(JSON.stringify(record.jwks))) return null;
        return { fetchedAt: record.fetchedAt, jwks: record.jwks };
      } catch { return null; }
    },
    async write({ fetchedAt, jwks }) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) relayFail('OIDC_CACHE_UNSAFE');
      const temporary = path.join(directory, `jwks.${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ contract: JWKS_CACHE_CONTRACT, fetchedAt, jwksSha256: sha256(JSON.stringify(jwks)), jwks })); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
    },
  });
}

// verify(token) -> { verified: true, kid, claims, tokenSha256, keyThumbprintSha256 }
// Error codes: OIDC_TOKEN_MALFORMED, OIDC_HEADER_REFUSED, OIDC_ALG_REFUSED,
// OIDC_KID_UNKNOWN, OIDC_SIGNATURE_INVALID, OIDC_ISSUER_MISMATCH,
// OIDC_AUDIENCE_MISMATCH, OIDC_JWKS_UNAVAILABLE, OIDC_JWKS_TOO_LARGE, OIDC_JWKS_INVALID.
export function createGitHubOidcVerifier({ audience, jwksPort, cache = null, clock = Date.now,
  cacheMaxAgeMs = 3_600_000, refetchMinIntervalMs = 60_000, fixture = false } = {}) {
  if (typeof audience !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(audience) || typeof jwksPort?.fetchJwks !== 'function'
    || (cache !== null && (typeof cache.read !== 'function' || typeof cache.write !== 'function')) || typeof clock !== 'function'
    || !Number.isSafeInteger(cacheMaxAgeMs) || cacheMaxAgeMs < 0 || cacheMaxAgeMs > 86_400_000
    || !Number.isSafeInteger(refetchMinIntervalMs) || refetchMinIntervalMs < 0 || typeof fixture !== 'boolean') relayFail('OIDC_CONFIGURATION_INVALID', 'verifier');
  let keys = null, loadedAt = null, lastFetchAt = null;
  const current = now => keys && loadedAt !== null && loadedAt <= now && now - loadedAt <= cacheMaxAgeMs;
  async function fromCache(now) {
    if (!cache) return false;
    const record = await cache.read();
    const at = record ? Date.parse(record.fetchedAt) : NaN;
    if (!(at <= now && now - at <= cacheMaxAgeMs)) return false;
    try { keys = parseJwks(record.jwks); loadedAt = at; return true; } catch { return false; }
  }
  async function fromNetwork(now) {
    if (lastFetchAt !== null && now - lastFetchAt < refetchMinIntervalMs) return false;
    lastFetchAt = now;
    const jwks = await jwksPort.fetchJwks();
    keys = parseJwks(jwks); loadedAt = now;
    if (cache) await cache.write({ fetchedAt: new Date(now).toISOString(), jwks }).catch(() => {});
    return true;
  }
  async function keyFor(kid) {
    const now = clock();
    if (!current(now)) { keys = null; await fromCache(now); }
    if (keys?.has(kid)) return keys.get(kid);
    // Unknown kid: GitHub rotated its keys. Fetch at most once per interval.
    if (!(await fromNetwork(now)) || !keys.has(kid)) relayFail('OIDC_KID_UNKNOWN');
    return keys.get(kid);
  }
  return Object.freeze({
    fixture, issuer: GITHUB_OIDC_ISSUER, audience,
    async verify(token) {
      const decoded = decodeJwtUnverified(token);
      headerChecks(decoded.header);
      const entry = await keyFor(decoded.header.kid);
      if (decoded.signature.length !== entry.bytes
        || !verifySignature('RSA-SHA256', Buffer.from(decoded.signingInput), entry.key, decoded.signature)) relayFail('OIDC_SIGNATURE_INVALID');
      if (decoded.claims.iss !== GITHUB_OIDC_ISSUER) relayFail('OIDC_ISSUER_MISMATCH');
      // A single audience is a string; an array audience is refused.
      if (decoded.claims.aud !== audience) relayFail('OIDC_AUDIENCE_MISMATCH');
      return Object.freeze({ verified: true, kid: decoded.header.kid, claims: Object.freeze(structuredClone(decoded.claims)),
        tokenSha256: sha256(token), keyThumbprintSha256: entry.thumbprint });
    },
  });
}
