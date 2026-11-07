// Scan result cache by tested tree (M4 of the resident CI optimisation plan, DESIGN 65). trivy's verdict is a function of
// what its three scanners can read, not of which commit names that content: the same tree, scanned with the same tools,
// rules, data and Source, gives the same verdict. A GitHub recomputation of the trial merge S with an unchanged tree, a
// PR's ordinary and train-front batch on the same tree, and a force-push that only rewrites the commit message all produce
// a new commit with a tree already scanned. This module turns such a repeat into a lookup; it never decides that a scan is
// unnecessary on any other ground.
//
// Rules (DESIGN 65.2-65.6):
//   - The key lists every input that can change the verdict (cacheKey; the adapters build it). A component that is
//     missing or malformed makes the key null: no lookup and no store, the scan runs as before.
//   - contract-placement is not cached: its container runs the candidate's own code, which can read the commit history,
//     the job request and the wall clock, so no key built from trees is complete by construction (DESIGN 65.1). Its
//     switch is off in code (cacheSettings), and the signer and the Windows issuer accept cacheHit for trivy only.
//   - Only the CI writes the cache: root, inside a root-owned directory that every path component and the record pass
//     protectedPath for (no symlink, uid 0, not group/other writable, private 0600 record, one link). A record is stored
//     only after the original result was signed, and carries that signed envelope: a record is accepted only when the
//     existing qualified result key signed its observation (Linux checks with the role's public key; the Windows issuer
//     checks the envelope inside cacheHit again with its own signer table). No new secret is introduced.
//   - A record is the complete, real, successful, signed observation of an earlier run plus its key, the time it was
//     stored and a self-digest; it is good for CACHE_TTL_MS. Anything else (read wrongly, damaged, unsigned, from another
//     key, Source or contract, stored in the future or too long ago, stored by a cache hit) is a miss. Failures and
//     uncertain runs are never stored, so a new commit is still the remedy for a flaky failure.
//   - The role policy switches it (scanResultCache: { enabled, root }); absent, disabled or invalid means off.
//   - A hit is evidence too: the adapter still takes both admissions and the scan-start grant, produces a new observation
//     for this job whose own fields describe only this run, with the original observation and its signed envelope under
//     cacheHit; the signer signs it as usual and marks the hit in the signed payload.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, verify } from 'node:crypto';
import { canonical, digest } from '../../src/proof.mjs';
import { RESULT_CONTRACT_V2, ENVELOPE_CONTRACT_V2 } from '../../src/proof-v2.mjs';
import { protectedPath } from '../qualification-v2.mjs';

export const CACHE_POLICY_FIELD = 'scanResultCache';
export const CACHE_KEY_CONTRACT = 'clued.independent-ci.scan-result-cache-key/1';
export const CACHE_RECORD_CONTRACT = 'clued.independent-ci.scan-result-cache-record/2';
export const CACHE_HIT_CONTRACT = 'clued.independent-ci.scan-result-cache-hit/2';
// Roles with a cache key. Of these, only CACHE_HIT_ROLES may ever be served from the cache (cacheSettings) and only their
// cacheHit is accepted by the signer and the Windows issuer (validateCacheHitEvidence).
export const CACHE_ROLES = Object.freeze(['trivy', 'contract-placement']);
export const CACHE_HIT_ROLES = Object.freeze(['trivy']);
// How long a record serves (DESIGN 65.3): storedAt must be in [now - TTL, now].
export const CACHE_TTL_MS = Object.freeze({ trivy: 24 * 3600_000, 'contract-placement': 24 * 3600_000 });
// A temporary file older than this is an orphan of an interrupted store (DESIGN 65.2); the role serial lock means no
// store of another run can be in flight.
export const ORPHAN_TEMPORARY_AGE_MS = 10 * 60_000;
// The real observation contracts a record may hold, by role (formal-trivy-v4 TRIVY_OBSERVATION_CONTRACT and
// formal-contract-placement-v2; literals here so this module imports no adapter).
export const CACHED_OBSERVATION = Object.freeze({
  trivy: Object.freeze({ contract: 'clued.independent-ci.formal-scanner-observation/3', profile: 'required-trivy-three-scanners/1' }),
  'contract-placement': Object.freeze({ contract: 'clued.independent-ci.formal-check-observation/2', profile: 'required-contract-placement/1' }),
});
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/, IMAGE = /^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/;
const TEMPORARY = /^\.[a-f0-9]{64}\.[a-f0-9]{16}\.tmp$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => plain(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f]/.test(value);
const stripSlash = value => typeof value === 'string' && value.length > 1 ? value.replace(/\/+$/, '') || '/' : value;
const safeRoot = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && path.posix.normalize(value) === value && value !== '/';
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const reasonOf = error => /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code ?? '') ? error.code : 'SCAN_RESULT_CACHE_UNREADABLE';
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;

// The policy switch. Off unless the role may be served from the cache and its policy names exactly { enabled: true, root }
// with a root (trailing slashes removed) that overlaps nothing the job, Docker or the control plane uses (extraRoots:
// role-specific directories such as trivy's database cache).
export function cacheSettings(config, role, { extraRoots = [] } = {}) {
  if (!CACHE_ROLES.includes(role)) return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_ROLE_NOT_CACHED' });
  if (!CACHE_HIT_ROLES.includes(role)) return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_KEY_NOT_CLOSED_FOR_ROLE' });
  const value = config?.[CACHE_POLICY_FIELD];
  if (value === undefined) return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_NOT_CONFIGURED' });
  if (!exactKeys(value, ['enabled', 'root']) || typeof value.enabled !== 'boolean') return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_POLICY_INVALID' });
  if (value.enabled !== true) return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_DISABLED' });
  const root = stripSlash(value.root);
  const roots = [config.workspaceRoot, config.runsRoot, config.trustedSourceDirectory, config.dockerRootDirectory, ...extraRoots].map(stripSlash);
  const files = [config.signingKeyFile, config.qualificationFile, config.publicKeyFile, config.sourceManifestFile, config.entryFile];
  if (!safeRoot(root) || roots.some(other => !safeRoot(other) || overlaps(other, root))
    || files.some(file => typeof file === 'string' && (file === root || file.startsWith(root + '/'))))
    return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_ROOT_OVERLAP' });
  return Object.freeze({ enabled: true, root, role });
}

// Key components. Every field is required and type-checked; one that is missing or malformed makes the key null.
const COMMON = { repo: v => v === 'tdoljyj/cross-memory-system', sourceManifestSha256: v => SHA256.test(v ?? ''), sourceSha: v => SHA1.test(v ?? ''),
  workflowSha256: v => SHA256.test(v ?? ''), runtimeIdentity: text, hostAcceptanceRef: text, sourceAcceptanceRef: text,
  dockerExecutableSha256: v => SHA256.test(v ?? '') };
const FIELDS = Object.freeze({
  trivy: { ...COMMON, profile: v => v === CACHED_OBSERVATION.trivy.profile, candidateTreeSha: v => SHA1.test(v ?? ''),
    inputInventorySha256: v => SHA256.test(v ?? ''), image: v => IMAGE.test(v ?? ''), nativeImageDigest: v => IMAGE.test(v ?? ''),
    policyImage: v => IMAGE.test(v ?? ''), scannersSha256: v => SHA256.test(v ?? ''),
    database: v => exactKeys(v, ['dbSha256', 'metadataSha256', 'fallback', 'checksDigest', 'checksMajorVersion', 'checksContentSha256'])
      && SHA256.test(v.dbSha256 ?? '') && SHA256.test(v.metadataSha256 ?? '') && typeof v.fallback === 'boolean'
      && /^sha256:[a-f0-9]{64}$/.test(v.checksDigest ?? '') && Number.isSafeInteger(v.checksMajorVersion) && SHA256.test(v.checksContentSha256 ?? '') },
  'contract-placement': { ...COMMON, profile: v => v === CACHED_OBSERVATION['contract-placement'].profile, testTreeSha: v => SHA1.test(v ?? ''),
    baseTreeSha: v => SHA1.test(v ?? ''), image: v => IMAGE.test(v ?? ''), containerNodeSha256: v => SHA256.test(v ?? ''),
    nodeExecutableSha256: v => SHA256.test(v ?? ''), gitExecutableSha256: v => SHA256.test(v ?? ''), toolPinsSha256: v => SHA256.test(v ?? ''),
    esbuildVersion: text, commandTemplateSha256: v => SHA256.test(v ?? ''), limitsSha256: v => SHA256.test(v ?? '') },
});
// Pure: { components, keySha256 } or null when a component is missing or malformed.
export function cacheKey(role, values) {
  const fields = FIELDS[role];
  if (!fields || !plain(values) || !exactKeys(values, Object.keys(fields))) return null;
  for (const [name, valid] of Object.entries(fields)) if (!valid(values[name])) return null;
  const components = Object.freeze({ contract: CACHE_KEY_CONTRACT, role, ...structuredClone(values) });
  return Object.freeze({ components, keySha256: digest(components) });
}
// trivy reads only the snapshot (no .git), the database and checks bundle mounts and its fixed argv. The scanner list is
// keyed by what the container sees: host mount sources (a per-run directory, a database generation directory whose
// bytes are keyed separately) are replaced by their targets.
export function trivyScannersSha256(scanners) {
  if (!Array.isArray(scanners) || scanners.length !== 3) return null;
  return digest(scanners.map(({ mounts, actualScanObserved, ...scan }) => ({ ...scan, mounts: Array.isArray(mounts) ? mounts.map(mount => mount?.[1]) : null })));
}
// contract-placement's fixed commands with the two commit ids blanked. Kept for the key layout only: placement is not
// served from the cache (cacheSettings), because the commands run candidate code that can read more than these trees.
export function placementCommandTemplateSha256(commands, job) {
  if (!Array.isArray(commands) || !SHA1.test(job?.testSha ?? '') || !SHA1.test(job?.baseSha ?? '')) return null;
  const blank = value => typeof value === 'string' ? value.split(job.testSha).join('{testSha}').split(job.baseSha).join('{baseSha}') : value;
  return digest(commands.map(command => ({ ...command, args: Array.isArray(command.args) ? command.args.map(blank) : null })));
}

// Pure structure of a real, complete, successful observation of the role (no key components): what a record may hold and
// what cacheHit.originalObservation must be. limit: no recorded moment may be later than this (the record's storedAt).
function realSuccessfulObservation(role, o, limit = Infinity) {
  const expected = CACHED_OBSERVATION[role];
  check(expected && plain(o) && o.contract === expected.contract && o.profile === expected.profile && o.domain === 'production-observation' && o.fixture === false
    && o.formalEligible === false && o.checksWritten === false && o.qualificationIssued === false && !Object.hasOwn(o, 'cacheHit')
    && o.conclusion === 'success' && SHA256.test(o.sourceManifestSha256 ?? '') && SHA1.test(o.sourceSha ?? '') && plain(o.subject)
    && SHA256.test(o.preAdmissionSha256 ?? '') && SHA256.test(o.postAdmissionSha256 ?? '') && plain(o.cleanup) && time(o.cleanup.observedAt) <= limit,
  'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
  if (role === 'trivy') check(Array.isArray(o.scans) && o.scans.length === 3 && o.scans.every(s => plain(s) && s.complete === true && s.cleanupConfirmed === true
    && s.exitCode === 0 && SHA256.test(s.preAdmissionSha256 ?? '') && SHA256.test(s.postAdmissionSha256 ?? '') && plain(s.logs)
    && ['startedAt', 'finishedAt', 'cleanupObservedAt'].every(k => time(s[k]) <= limit)) && o.cleanup.snapshotRemoved === true, 'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
  else check(o.exitCode === 0 && /^sha256:[a-f0-9]{64}$/.test(o.imageId ?? '') && time(o.startedAt) <= limit && time(o.finishedAt) <= limit
    && plain(o.logs) && ['stdout', 'stderr'].every(k => exactKeys(o.logs[k], ['bytes', 'sha256', 'truncated']) && SHA256.test(o.logs[k].sha256 ?? '')
      && Number.isSafeInteger(o.logs[k].bytes) && o.logs[k].truncated === false), 'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
  return o;
}
function matchesKey(role, o, c) {
  check(o.sourceManifestSha256 === c.sourceManifestSha256 && o.sourceSha === c.sourceSha && o.runtimeIdentity === c.runtimeIdentity
    && o.hostAcceptanceRef === c.hostAcceptanceRef && o.sourceAcceptanceRef === c.sourceAcceptanceRef, 'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
  if (role === 'trivy') check(o.candidateTreeSha === c.candidateTreeSha && o.inputInventorySha256 === c.inputInventorySha256 && o.image === c.image
    && o.nativeImageDigest === c.nativeImageDigest && canonical(o.cache) === canonical(c.database), 'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
  else check(o.candidateTreeSha === c.testTreeSha && o.image === c.image && o.workflowSha256 === c.workflowSha256 && o.toolPinsSha256 === c.toolPinsSha256,
    'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
}
// Pure: the original result envelope really signed this observation (DESIGN 65.2). signer = { publicKeyPem, keyId,
// runtimeId }: on Linux the role policy's own key, on Windows the issuer's signer table entry for envelope.keyId.
export function verifyOriginalEnvelope(envelope, signer, observation) {
  check(exactKeys(envelope, ['contract', 'keyId', 'payload', 'signature']) && envelope.contract === ENVELOPE_CONTRACT_V2 && typeof envelope.keyId === 'string'
    && envelope.keyId === signer?.keyId && typeof envelope.signature === 'string' && /^[A-Za-z0-9_-]+$/.test(envelope.signature) && signer.publicKeyPem, 'SCAN_RESULT_CACHE_ENVELOPE_REFUSED');
  const p = envelope.payload;
  check(plain(p) && p.contract === RESULT_CONTRACT_V2 && p.domain === 'production' && p.runtimeId === signer.runtimeId && p.executionObservationSha256 === digest(observation)
    && canonical(p.subject) === canonical(observation.subject) && p.profile === observation.profile && p.conclusion === 'success' && p.exitCode === 0
    && (p.cacheHit ?? null) === null, 'SCAN_RESULT_CACHE_ENVELOPE_REFUSED');
  const signature = Buffer.from(envelope.signature, 'base64url');
  let valid = false; try { valid = signature.length === 64 && verify(null, Buffer.from(canonical(p)), signer.publicKeyPem, signature); } catch { valid = false; }
  check(valid, 'SCAN_RESULT_CACHE_SIGNATURE_INVALID');
  return envelope;
}
const RECORD_KEYS = ['contract', 'role', 'keySha256', 'key', 'observation', 'originalObservationSha256', 'envelope', 'storedAt', 'recordSha256'];
// Pure: the record, or a thrown code. Bytes are parsed only here. now and signer are required.
export function parseCacheRecord(bytes, role, key, { now, signer } = {}) {
  check(key && SHA256.test(key.keySha256 ?? '') && key.components?.role === role, 'SCAN_RESULT_CACHE_KEY_INCOMPLETE');
  check(Number.isSafeInteger(now) && CACHE_TTL_MS[role], 'SCAN_RESULT_CACHE_CLOCK_UNKNOWN');
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_RECORD_BYTES, 'SCAN_RESULT_CACHE_RECORD_BOUND');
  let record; try { record = JSON.parse(bytes.toString('utf8')); } catch { fail('SCAN_RESULT_CACHE_RECORD_UNPARSABLE'); }
  check(exactKeys(record, RECORD_KEYS) && record.contract === CACHE_RECORD_CONTRACT && record.role === role, 'SCAN_RESULT_CACHE_RECORD_CONTRACT');
  const { recordSha256, ...body } = record;
  check(SHA256.test(recordSha256 ?? '') && digest(body) === recordSha256, 'SCAN_RESULT_CACHE_RECORD_DIGEST');
  check(record.keySha256 === key.keySha256 && canonical(record.key) === canonical(key.components) && digest(record.key) === key.keySha256, 'SCAN_RESULT_CACHE_KEY_MISMATCH');
  const stored = time(record.storedAt);
  check(Number.isFinite(stored) && stored <= now, 'SCAN_RESULT_CACHE_RECORD_FROM_FUTURE');
  check(now - stored <= CACHE_TTL_MS[role], 'SCAN_RESULT_CACHE_RECORD_EXPIRED');
  check(record.originalObservationSha256 === digest(record.observation), 'SCAN_RESULT_CACHE_OBSERVATION_DIGEST');
  realSuccessfulObservation(role, record.observation, stored); matchesKey(role, record.observation, key.components);
  verifyOriginalEnvelope(record.envelope, signer, record.observation);
  return record;
}
// Pure: the record a real, complete, successful, signed observation becomes.
export function cacheRecord(role, key, observation, envelope, storedAt = new Date().toISOString()) {
  check(key && key.components?.role === role && SHA256.test(key.keySha256 ?? ''), 'SCAN_RESULT_CACHE_KEY_INCOMPLETE');
  realSuccessfulObservation(role, observation, time(storedAt)); matchesKey(role, observation, key.components);
  check(plain(envelope) && envelope.payload?.executionObservationSha256 === digest(observation), 'SCAN_RESULT_CACHE_ENVELOPE_REFUSED');
  const body = { contract: CACHE_RECORD_CONTRACT, role, keySha256: key.keySha256, key: key.components, observation,
    originalObservationSha256: digest(observation), envelope, storedAt };
  return { ...body, recordSha256: digest(body) };
}
// Pure: the cacheHit evidence a hit observation carries. The original observation and its signed envelope travel with it,
// so the signer and the Windows issuer check the original run themselves instead of trusting this run's fields.
export function cacheHitEvidence(record, servedAt) {
  return Object.freeze({ contract: CACHE_HIT_CONTRACT, keySha256: record.keySha256, recordSha256: record.recordSha256,
    originalObservationSha256: record.originalObservationSha256, originalObservation: structuredClone(record.observation),
    originalEnvelope: structuredClone(record.envelope), storedAt: record.storedAt, servedAt });
}
// Pure: the signed-payload marker of a hit (null for a real run); the signer writes it, the Windows issuer compares it.
export const cacheHitMarker = observation => observation?.cacheHit ? { keySha256: observation.cacheHit.keySha256, recordSha256: observation.cacheHit.recordSha256,
  originalObservationSha256: observation.cacheHit.originalObservationSha256 } : null;
// Pure: the signer's and the Windows issuer's structural check of a hit's evidence (signed-result observationFacts). Only
// CACHE_HIT_ROLES; the original observation must be a real successful one of the same role and Source, every moment it
// records no later than storedAt, storedAt no later than servedAt, and its envelope must name exactly that observation.
// The envelope signature is checked where a signer key is at hand (signActualBridgeResult, verifySignedBridgeResult).
export function validateCacheHitEvidence(value, role, observation) {
  check(CACHE_HIT_ROLES.includes(role), 'SCAN_RESULT_CACHE_HIT_ROLE_REFUSED');
  check(exactKeys(value, ['contract', 'keySha256', 'recordSha256', 'originalObservationSha256', 'originalObservation', 'originalEnvelope', 'storedAt', 'servedAt'])
    && value.contract === CACHE_HIT_CONTRACT && ['keySha256', 'recordSha256', 'originalObservationSha256'].every(k => SHA256.test(value[k] ?? ''))
    && Number.isFinite(time(value.storedAt)) && Number.isFinite(time(value.servedAt)) && time(value.storedAt) <= time(value.servedAt)
    && value.originalObservationSha256 === digest(value.originalObservation) && plain(value.originalEnvelope)
    && value.originalEnvelope.payload?.executionObservationSha256 === value.originalObservationSha256, 'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED');
  try { realSuccessfulObservation(role, value.originalObservation, time(value.storedAt)); } catch { fail('SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED'); }
  const original = value.originalObservation;
  check(original.sourceManifestSha256 === observation?.sourceManifestSha256 && original.sourceSha === observation.sourceSha
    && original.runtimeIdentity === observation.runtimeIdentity && original.image === observation.image, 'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED');
  return value;
}

// The cache port the adapter uses. guard is protectedPath on the installed host; the offline tests pass their own. signer
// is the role's qualified result key ({ publicKeyPem, keyId, runtimeId }). lookup never throws: every failure is
// { record: null, reason }. store never throws either; it keeps a valid record and replaces an invalid one.
export function createResultCache(settings, { guard = protectedPath, signer = null, now = () => Date.now() } = {}) {
  const enabled = settings?.enabled === true && typeof settings.root === 'string' && path.isAbsolute(settings.root) && CACHE_HIT_ROLES.includes(settings.role)
    && !!signer?.publicKeyPem;
  const role = settings?.role, directory = enabled ? path.join(settings.root, role) : null;
  const fileOf = key => path.join(directory, key.keySha256 + '.json');
  const read = async key => {
    await guard(settings.root, { directory: true }); await guard(directory, { directory: true });
    const file = fileOf(key);
    try { await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    await guard(file, { privateFile: true });
    return parseCacheRecord(await fsp.readFile(file), role, key, { now: now(), signer });
  };
  return Object.freeze({
    enabled,
    async lookup(key) {
      if (!enabled) return { record: null, reason: settings?.reason ?? (settings?.enabled ? 'SCAN_RESULT_CACHE_SIGNER_UNKNOWN' : 'SCAN_RESULT_CACHE_DISABLED') };
      if (!key || key.components?.role !== role) return { record: null, reason: 'SCAN_RESULT_CACHE_KEY_INCOMPLETE' };
      try { const record = await read(key); return record ? { record, reason: 'SCAN_RESULT_CACHE_HIT' } : { record: null, reason: 'SCAN_RESULT_CACHE_MISS' }; }
      catch (error) { return { record: null, reason: reasonOf(error) }; }
    },
    // Called only after the real result was signed: envelope is that signed envelope.
    async store(key, observation, envelope) {
      if (!enabled) return { stored: false, reason: settings?.reason ?? 'SCAN_RESULT_CACHE_DISABLED' };
      let temporary = null;
      try {
        const record = cacheRecord(role, key, observation, envelope, new Date(now()).toISOString());
        verifyOriginalEnvelope(envelope, signer, observation);
        await guard(path.dirname(settings.root), { directory: true });
        for (const dir of [settings.root, directory]) { try { await fsp.mkdir(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } await guard(dir, { directory: true }); }
        // Orphans of an interrupted store (crash between create, link and unlink): an old temporary file is removed,
        // which also brings a record left with two links back to one, so it can be read (or replaced) again.
        for (const name of await fsp.readdir(directory)) {
          if (!TEMPORARY.test(name)) continue;
          const stat = await fsp.lstat(path.join(directory, name)).catch(() => null);
          if (stat?.isFile() && now() - stat.mtimeMs > ORPHAN_TEMPORARY_AGE_MS) await fsp.unlink(path.join(directory, name)).catch(() => {});
        }
        const file = fileOf(key);
        temporary = path.join(directory, '.' + key.keySha256 + '.' + randomBytes(8).toString('hex') + '.tmp');
        const handle = await fsp.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
        let reason = 'SCAN_RESULT_CACHE_STORED';
        try { await fsp.link(temporary, file); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          // A record already there is kept when it still reads as a hit; a damaged, expired, unsigned or two-link one
          // (it reads as a miss for ever otherwise) is replaced by this newer real result.
          let existing = null; try { existing = await read(key); } catch { existing = null; }
          if (existing) return { stored: false, reason: 'SCAN_RESULT_CACHE_RECORD_EXISTS' };
          await fsp.unlink(file); await fsp.link(temporary, file); reason = 'SCAN_RESULT_CACHE_RECORD_REPLACED';
        }
        // Directory fsync (Linux, where the installed CI runs; Windows cannot open a directory for it).
        if (process.platform !== 'win32') { const parent = await fsp.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
        return { stored: true, reason, keySha256: key.keySha256, recordSha256: record.recordSha256 };
      } catch (error) { return { stored: false, reason: reasonOf(error) }; }
      finally { if (temporary) await fsp.unlink(temporary).catch(() => {}); }
    },
  });
}
