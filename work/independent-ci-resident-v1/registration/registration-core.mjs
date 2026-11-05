// Public registration material for a unified-scheduling stage-1 node (KooYomi Task c9673047; Decision b4cd00c5, stage 1 Task
// 98dbf336). The output is exactly the document the Native page apps/clued-cloud/app/ci-nodes/page.tsx#registrationDocument accepts:
// { binding_id, name, profile, profile_sha256, identity_public_jwk, encryption_public_jwk, qualification_digest,
// qualification_source, publisher_requested, scan_signing_requested }, plus a public qualification report whose canonical digest is
// qualification_digest. Nothing here reads, holds or writes a private key: the callers hand over public JWKs only (Windows: the
// EccPublicBlob of a non-exportable CNG key; Linux: the public PEM file written next to the key at init-keys time).
//
// profile_sha256, qualification_digest and the key fingerprints use the stage-1 canonical JSON subset (work/ci-scheduling-stage1-
// 20261023/README.md "Canonical JSON", apps/clued-cloud/worker/ci-scheduling-v1.ts#ciCanonicalJson): Unicode scalar strings, safe
// integers, sorted UTF-16 keys, plain objects and dense arrays, depth at most 16, 4096 values, 64 KiB. Capabilities and the profile
// are declarations: registration never turns them into attestation or permission (stage-1 README), so a role (scan, publish,
// control, relay, f-pr) is written only when the operator passes it.
import { createHash, createPublicKey } from 'node:crypto';

export const TOOL = Object.freeze({ name: 'clued-ci-node-registration-export', version: '1.0.0' });
export const PROFILE_SCHEMA = 'clued.ci-node-profile/1';
export const REPORT_SCHEMA = 'clued.ci-node-qualification-report/1';
// The page's lists (page.tsx#registrationDocument and #validProfile); test/registration-core.test.mjs reads the page and fails
// when they drift.
export const REGISTRATION_KEYS = Object.freeze(['binding_id', 'name', 'profile', 'profile_sha256', 'identity_public_jwk',
  'encryption_public_jwk', 'qualification_digest', 'qualification_source', 'publisher_requested', 'scan_signing_requested']);
export const PROFILE_KEYS = Object.freeze(['schema', 'site_id', 'environment_kinds', 'slot_count', 'memory_limit_mb',
  'identity_key_origin', 'capabilities', 'exclusions']);
export const CAPABILITIES = Object.freeze(['linux', 'windows', 'docker', 'hyper-v', 'windows-sandbox', 'scan', 'publish', 'control',
  'relay', 'f-pr']);
export const ENVIRONMENT_KINDS = Object.freeze(['E1-Linux', 'E1-Windows', 'E4-Windows-Sandbox', 'hardened-Windows']);
// Declared by the operator only; never detected.
export const ROLES = Object.freeze(['scan', 'publish', 'control', 'relay', 'f-pr']);
export const KEY_ORIGINS = Object.freeze(['tpm', 'software']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64URL32 = /^[A-Za-z0-9_-]{43}$/;
const SITE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const MAX_BYTES = 65536;

export class RegistrationError extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}
export function check(condition, code, detail) { if (!condition) throw new RegistrationError(code, detail); }

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const safeInteger = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && !Object.is(value, -0)
  && value >= min && value <= max;

function scalarText(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      check(next >= 0xdc00 && next <= 0xdfff, 'CANONICAL_INVALID', 'unpaired surrogate');
    } else check(!(code >= 0xdc00 && code <= 0xdfff), 'CANONICAL_INVALID', 'unpaired surrogate');
  }
}

// The stage-1 subset, byte for byte the same output as ciCanonicalJson for every value both accept.
export function canonicalJson(value) {
  let count = 0;
  const visit = (entry, depth) => {
    check(++count <= 4096 && depth <= 16, 'CANONICAL_INVALID', 'too large or too deep');
    if (entry === null) return 'null';
    if (typeof entry === 'boolean') return entry ? 'true' : 'false';
    if (typeof entry === 'number') { check(safeInteger(entry, -Number.MAX_SAFE_INTEGER), 'CANONICAL_INVALID', 'not a safe integer'); return String(entry); }
    if (typeof entry === 'string') { check(entry.length <= MAX_BYTES, 'CANONICAL_INVALID', 'string too long'); scalarText(entry); return JSON.stringify(entry); }
    if (Array.isArray(entry)) {
      check(entry.length <= 256 && Object.getPrototypeOf(entry) === Array.prototype && Reflect.ownKeys(entry).length === entry.length + 1,
        'CANONICAL_INVALID', 'array');
      return '[' + entry.map(item => visit(item, depth + 1)).join(',') + ']';
    }
    check(plain(entry), 'CANONICAL_INVALID', 'not a plain object');
    const keys = Reflect.ownKeys(entry);
    check(keys.length <= 256 && keys.every(key => typeof key === 'string'), 'CANONICAL_INVALID', 'keys');
    return '{' + keys.sort().map(key => {
      scalarText(key);
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'CANONICAL_INVALID', 'accessor');
      return JSON.stringify(key) + ':' + visit(descriptor.value, depth + 1);
    }).join(',') + '}';
  };
  const text = visit(value, 0);
  check(Buffer.byteLength(text, 'utf8') <= MAX_BYTES, 'CANONICAL_INVALID', 'larger than 64 KiB');
  return text;
}
export const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const canonicalDigest = value => sha256Hex(canonicalJson(value));

// page.tsx#sensitiveText.
export function sensitiveText(value) {
  return /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i.test(value) || /\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(value)
    || /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]+/i.test(value) || /\bpostgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(value);
}
// The registration RPC's own filter (migration 20261023092957, clued_ci_node_registration_v1: p_input::text ~* ...). It has no word
// boundary and is case-insensitive, so it also matches inside base64url key coordinates (about one key pair in 6,500 contains, say,
// "gHo_"). Such a document would be refused as CI_REGISTRATION_INVALID: init-keys regenerates those keys, export refuses them.
const DATABASE_REFUSED = /(-----BEGIN[^-]*PRIVATE KEY-----|Bearer\s|ghp_|gho_|github_pat_|postgres(ql)?:\/\/[^/@:]+:[^/@]+@)/i;
export const databaseRefuses = value => DATABASE_REFUSED.test(typeof value === 'string' ? value : JSON.stringify(value));
const PRIVATE_FIELD = /^(d|p|q|dp|dq|qi|oth|k|private_key|password|secret|access_token|refresh_token|lease_key|confirmation_token)$/i;
// page.tsx#publicDocument.
export function publicDocument(value, depth = 0) {
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => publicDocument(item, depth + 1));
  if (typeof value === 'string') return !sensitiveText(value);
  if (value === null || typeof value !== 'object') return value === null || ['string', 'boolean', 'number'].includes(typeof value);
  return Object.entries(value).every(([key, item]) => !PRIVATE_FIELD.test(key) && publicDocument(item, depth + 1));
}

// A public P-256 JWK with exactly kty, crv, x, y (anything else, a private 'd' included, is refused rather than dropped).
export function publicJwk(value) {
  check(plain(value), 'PUBLIC_KEY_INVALID', 'not an object');
  const keys = Object.keys(value).sort().join(',');
  check(keys === 'crv,kty,x,y', 'PUBLIC_KEY_INVALID', `fields ${keys}`);
  check(value.kty === 'EC' && value.crv === 'P-256' && B64URL32.test(value.x) && B64URL32.test(value.y), 'PUBLIC_KEY_INVALID', 'not P-256');
  // The point must be on the curve: Node refuses an off-curve point here.
  try { createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: value.x, y: value.y }, format: 'jwk' }); }
  catch { throw new RegistrationError('PUBLIC_KEY_INVALID', 'not a point on P-256'); }
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
}
export function jwkFromPublicPem(pem) {
  check(typeof pem === 'string' && /-----BEGIN PUBLIC KEY-----/.test(pem) && !sensitiveText(pem), 'PUBLIC_KEY_INVALID', 'not a public PEM');
  const jwk = createPublicKey({ key: pem, format: 'pem' }).export({ format: 'jwk' });
  return publicJwk({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}
export const keyFingerprint = jwk => canonicalDigest(publicJwk(jwk));
// KEY_UNREGISTRABLE for any valid public key whose coordinates the registration RPC refuses (databaseRefuses has no word boundary;
// sensitiveText has one, so only some of those keys are also "not a public document"). A value that is not a valid public key is
// left to the caller's own checks (PUBLIC_KEY_INVALID, FACTS_INVALID), as before.
const unregistrable = jwk => { let key; try { key = publicJwk(jwk); } catch { return false; } return databaseRefuses(key); };
function refuseUnregistrableKeys(...jwks) {
  check(!jwks.some(unregistrable), 'KEY_UNREGISTRABLE',
    'a public key coordinate contains text the registration RPC refuses; these keys cannot be registered, create new ones in an approved install wave');
}

const uniqueOf = (value, allowed, min, max) => Array.isArray(value) && value.length >= min && value.length <= max
  && value.every(item => typeof item === 'string' && allowed.includes(item)) && new Set(value).size === value.length;

// page.tsx#validProfile.
export function validProfile(value) {
  return plain(value) && Object.keys(value).every(key => PROFILE_KEYS.includes(key))
    && safeInteger(value.slot_count, 1, 64)
    && (!('schema' in value) || value.schema === PROFILE_SCHEMA)
    && (!('site_id' in value) || typeof value.site_id === 'string' && SITE.test(value.site_id))
    && (!('environment_kinds' in value) || uniqueOf(value.environment_kinds, ENVIRONMENT_KINDS, 1, 4))
    && (!('memory_limit_mb' in value) || safeInteger(value.memory_limit_mb, 0, 1048576))
    && (!('identity_key_origin' in value) || KEY_ORIGINS.includes(value.identity_key_origin))
    && (!('capabilities' in value) || uniqueOf(value.capabilities, CAPABILITIES, 0, 16))
    && (!('exclusions' in value) || uniqueOf(value.exclusions, CAPABILITIES, 0, 16));
}

// page.tsx#registrationDocument, plus the database's "the two keys differ" rule; bindingIds, when given, is the page's binding list.
export function validateRegistration(value, bindingIds) {
  // A key coordinate that holds refused text at a word boundary also makes the document "not public" (publicDocument); it is the
  // same unregistrable key, so its actionable cause is reported first (generation 11: the random-key case got FACTS_INVALID).
  if (plain(value)) refuseUnregistrableKeys(value.identity_public_jwk, value.encryption_public_jwk);
  check(plain(value) && publicDocument(value), 'REGISTRATION_INVALID', 'not a public document');
  check(Object.keys(value).every(key => REGISTRATION_KEYS.includes(key)), 'REGISTRATION_INVALID', 'unknown field');
  check(typeof value.binding_id === 'string' && UUID.test(value.binding_id), 'REGISTRATION_INVALID', 'binding_id');
  check(!bindingIds || bindingIds.includes(value.binding_id), 'REGISTRATION_INVALID', 'binding_id not listed');
  check(typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 100, 'REGISTRATION_INVALID', 'name');
  check(validProfile(value.profile), 'PROFILE_INVALID');
  check(typeof value.profile_sha256 === 'string' && HEX64.test(value.profile_sha256), 'REGISTRATION_INVALID', 'profile_sha256');
  check(value.profile_sha256 === canonicalDigest(value.profile), 'REGISTRATION_INVALID', 'profile_sha256 does not match profile');
  check(typeof value.qualification_digest === 'string' && HEX64.test(value.qualification_digest), 'REGISTRATION_INVALID', 'qualification_digest');
  check(typeof value.qualification_source === 'string' && HEX40.test(value.qualification_source), 'REGISTRATION_INVALID', 'qualification_source');
  check(typeof value.publisher_requested === 'boolean' && typeof value.scan_signing_requested === 'boolean', 'REGISTRATION_INVALID', 'requests');
  const identity = publicJwk(value.identity_public_jwk);
  const encryption = publicJwk(value.encryption_public_jwk);
  check(identity.x !== encryption.x || identity.y !== encryption.y, 'REGISTRATION_INVALID', 'identity and encryption keys are the same key');
  refuseUnregistrableKeys(identity, encryption);
  check(!databaseRefuses(value), 'REGISTRATION_INVALID', 'the document contains text the registration RPC refuses');
  check(Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_BYTES, 'REGISTRATION_INVALID', 'larger than 64 KiB');
  return value;
}

// facts: what the platform side observed, all public:
//   { os: 'windows'|'linux', os_version, hostname, memory_mb, docker_server_version|null, hyperv_enabled|null,
//     windows_sandbox_enabled|null, tpm_present: true|false|null, identity_public_jwk, encryption_public_jwk,
//     identity_key_origin, encryption_key_origin }
// options: { bindingId, name, slotCount, siteId, environmentKinds, roles, exclusions, memoryLimitMb, publisherRequested,
//   scanSigningRequested, source: { commit, manifestSha256|null }, generatedAt }
export const FACT_KEYS = Object.freeze(['os', 'os_version', 'hostname', 'memory_mb', 'docker_server_version', 'hyperv_enabled',
  'windows_sandbox_enabled', 'tpm_present', 'identity_public_jwk', 'encryption_public_jwk', 'identity_key_origin', 'encryption_key_origin']);
const nullableBoolean = value => value === null || typeof value === 'boolean';
export function validateFacts(facts) {
  if (plain(facts)) refuseUnregistrableKeys(facts.identity_public_jwk, facts.encryption_public_jwk);
  check(plain(facts) && publicDocument(facts), 'FACTS_INVALID', 'not a public document');
  const keys = Object.keys(facts).sort();
  check(keys.join(',') === [...FACT_KEYS].sort().join(','), 'FACTS_INVALID', `fields ${keys.join(',')}`);
  check(facts.os === 'windows' || facts.os === 'linux', 'FACTS_INVALID', 'os');
  check(typeof facts.os_version === 'string' && facts.os_version.length <= 200, 'FACTS_INVALID', 'os_version');
  check(typeof facts.hostname === 'string' && facts.hostname.length >= 1 && facts.hostname.length <= 100, 'FACTS_INVALID', 'hostname');
  check(safeInteger(facts.memory_mb, 0, 1048576 * 64), 'FACTS_INVALID', 'memory_mb');
  check(facts.docker_server_version === null || typeof facts.docker_server_version === 'string' && facts.docker_server_version.length <= 64,
    'FACTS_INVALID', 'docker_server_version');
  check(nullableBoolean(facts.hyperv_enabled) && nullableBoolean(facts.windows_sandbox_enabled) && nullableBoolean(facts.tpm_present),
    'FACTS_INVALID', 'feature flags');
  check(KEY_ORIGINS.includes(facts.identity_key_origin) && KEY_ORIGINS.includes(facts.encryption_key_origin), 'FACTS_INVALID', 'key origin');
  publicJwk(facts.identity_public_jwk); publicJwk(facts.encryption_public_jwk);
  return facts;
}

export function buildProfile(facts, options) {
  const capabilities = [facts.os];
  if (facts.docker_server_version) capabilities.push('docker');
  if (facts.hyperv_enabled === true) capabilities.push('hyper-v');
  if (facts.windows_sandbox_enabled === true) capabilities.push('windows-sandbox');
  for (const role of options.roles ?? []) { check(ROLES.includes(role), 'OPTION_INVALID', `role ${role}`); capabilities.push(role); }
  const exclusions = [...(options.exclusions ?? [])];
  check(exclusions.every(item => CAPABILITIES.includes(item)), 'OPTION_INVALID', 'exclusion');
  check(!exclusions.some(item => capabilities.includes(item)), 'OPTION_INVALID', 'a capability cannot also be an exclusion');
  check(safeInteger(options.slotCount, 1, 64), 'OPTION_INVALID', 'slot count must be 1..64');
  const profile = { schema: PROFILE_SCHEMA, slot_count: options.slotCount, identity_key_origin: facts.identity_key_origin,
    capabilities: [...new Set(capabilities)], exclusions };
  if (options.siteId !== undefined) { check(SITE.test(options.siteId), 'OPTION_INVALID', 'site id'); profile.site_id = options.siteId; }
  if (options.environmentKinds?.length) {
    check(uniqueOf(options.environmentKinds, ENVIRONMENT_KINDS, 1, 4), 'OPTION_INVALID', 'environment kind');
    profile.environment_kinds = [...options.environmentKinds];
  }
  const memory = options.memoryLimitMb ?? Math.min(facts.memory_mb, 1048576);
  check(safeInteger(memory, 0, 1048576), 'OPTION_INVALID', 'memory limit must be 0..1048576 MiB');
  profile.memory_limit_mb = memory;
  check(validProfile(profile), 'PROFILE_INVALID');
  return profile;
}

export function buildRegistration(facts, options) {
  validateFacts(facts);
  check(typeof options.bindingId === 'string' && UUID.test(options.bindingId), 'OPTION_INVALID', 'binding id must be the connection UUID shown on /ci-nodes');
  const name = options.name ?? facts.hostname;
  check(typeof name === 'string' && name.trim().length > 0 && name.length <= 100, 'OPTION_INVALID', 'name');
  check(plain(options.source) && HEX40.test(options.source.commit ?? ''), 'SOURCE_UNAVAILABLE', 'no 40-hex CI Source commit');
  const profile = buildProfile(facts, options);
  const profileSha256 = canonicalDigest(profile);
  const identity = publicJwk(facts.identity_public_jwk);
  const encryption = publicJwk(facts.encryption_public_jwk);
  const report = {
    schema: REPORT_SCHEMA, tool: { ...TOOL }, generated_at: options.generatedAt ?? new Date().toISOString(),
    host: { os: facts.os, os_version: facts.os_version, hostname: facts.hostname, memory_mb: facts.memory_mb,
      docker_server_version: facts.docker_server_version, hyperv_enabled: facts.hyperv_enabled,
      windows_sandbox_enabled: facts.windows_sandbox_enabled, tpm_present: facts.tpm_present },
    keys: { identity_fingerprint: keyFingerprint(identity), encryption_fingerprint: keyFingerprint(encryption),
      identity_key_origin: facts.identity_key_origin, encryption_key_origin: facts.encryption_key_origin },
    source: { commit: options.source.commit, manifest_sha256: options.source.manifestSha256 ?? null },
    profile_sha256: profileSha256,
  };
  check(publicDocument(report), 'REPORT_INVALID');
  const registration = {
    binding_id: options.bindingId.toLowerCase(), name: name.trim(), profile, profile_sha256: profileSha256,
    identity_public_jwk: identity, encryption_public_jwk: encryption,
    qualification_digest: canonicalDigest(report), qualification_source: options.source.commit,
    publisher_requested: options.publisherRequested === true, scan_signing_requested: options.scanSigningRequested === true,
  };
  validateRegistration(registration);
  return { registration, report };
}

// record/source-manifest.json of a resident install (schema independent-ci.sources.v2): its sourceSha is the CI Source commit the
// node runs; manifest_sha256 is the hash of the file's bytes (the name of the installed Source directory, DESIGN §33).
export function sourceFromManifest(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, 'SOURCE_UNAVAILABLE', 'manifest unreadable');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new RegistrationError('SOURCE_UNAVAILABLE', 'manifest is not JSON'); }
  check(plain(manifest) && typeof manifest.sourceSha === 'string' && HEX40.test(manifest.sourceSha), 'SOURCE_UNAVAILABLE', 'manifest has no 40-hex sourceSha');
  return { commit: manifest.sourceSha, manifestSha256: createHash('sha256').update(bytes).digest('hex') };
}
