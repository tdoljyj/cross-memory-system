// Scan result cache by tested tree (M4 of the resident CI optimisation plan, DESIGN 65). trivy and contract-placement
// verdicts are a function of what the scanner or check can read, not of which commit names that content: the same tree,
// scanned with the same tools, rules, data and Source, gives the same verdict. A GitHub recomputation of the trial merge
// S with an unchanged tree, a PR's ordinary and train-front batch on the same tree, and a force-push that only rewrites
// the commit message all produce a new commit with a tree already scanned. This module turns such a repeat into a
// lookup; it never decides that a scan is unnecessary on any other ground.
//
// Rules (DESIGN 65.2-65.5):
//   - The key lists every input that can change the verdict (trivyCacheKey / placementCacheKey). A component that is
//     missing or malformed makes the key null: no lookup and no store, the scan runs as before.
//   - Only the CI writes the cache: root, inside a root-owned directory that every path component and the record pass
//     protectedPath for (no symlink, uid 0, not group/other writable, private 0600 record). PR code never sees it: the
//     root never overlaps a directory that is mounted into a container or holds control or signing material.
//   - A record is the complete, real, successful observation of an earlier run plus its key and a self-digest. Anything
//     else, read wrongly, damaged, from another key, another Source or contract, or stored by a cache hit, is a miss.
//     Failures and uncertain runs are never stored, so a new commit is still the remedy for a flaky failure.
//   - The role policy switches it (scanResultCache: { enabled, root }); absent, disabled or invalid means off: no
//     lookup and no store.
//   - A hit is evidence too: the adapter still takes both admissions and the scan-start grant, produces a new
//     observation for this job that carries cacheHit (key, record and original observation digests, original subject),
//     and the signer signs it as usual. The executed-heads ledger and "one real run per commit and check" are untouched.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, digest } from '../../src/proof.mjs';
import { protectedPath } from '../qualification-v2.mjs';

export const CACHE_POLICY_FIELD = 'scanResultCache';
export const CACHE_KEY_CONTRACT = 'clued.independent-ci.scan-result-cache-key/1';
export const CACHE_RECORD_CONTRACT = 'clued.independent-ci.scan-result-cache-record/1';
export const CACHE_HIT_CONTRACT = 'clued.independent-ci.scan-result-cache-hit/1';
export const CACHE_ROLES = Object.freeze(['trivy', 'contract-placement']);
// The real observation contracts a record may hold, by role (formal-trivy-v4 TRIVY_OBSERVATION_CONTRACT and
// formal-contract-placement-v2; literals here so this module imports no adapter).
export const CACHED_OBSERVATION = Object.freeze({
  trivy: Object.freeze({ contract: 'clued.independent-ci.formal-scanner-observation/3', profile: 'required-trivy-three-scanners/1' }),
  'contract-placement': Object.freeze({ contract: 'clued.independent-ci.formal-check-observation/2', profile: 'required-contract-placement/1' }),
});
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const SHA1 = /^[a-f0-9]{40}$/, SHA256 = /^[a-f0-9]{64}$/, IMAGE = /^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys) => plain(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f]/.test(value);
const safeRoot = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && path.posix.normalize(value) === value && value !== '/';
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const reasonOf = error => /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code ?? '') ? error.code : 'SCAN_RESULT_CACHE_UNREADABLE';

// The policy switch. Off unless the role policy names exactly { enabled: true, root } with a root that overlaps nothing
// the job or the control plane uses (extraRoots: role-specific directories such as trivy's database cache).
export function cacheSettings(config, role, { extraRoots = [] } = {}) {
  if (!CACHE_ROLES.includes(role)) return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_ROLE_NOT_CACHED' });
  const value = config?.[CACHE_POLICY_FIELD];
  if (value === undefined) return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_NOT_CONFIGURED' });
  if (!exactKeys(value, ['enabled', 'root']) || typeof value.enabled !== 'boolean') return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_POLICY_INVALID' });
  if (value.enabled !== true) return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_DISABLED' });
  const roots = [config.workspaceRoot, config.runsRoot, config.trustedSourceDirectory, ...extraRoots];
  const files = [config.signingKeyFile, config.qualificationFile, config.publicKeyFile, config.sourceManifestFile, config.entryFile];
  if (!safeRoot(value.root) || roots.some(root => !safeRoot(root) || overlaps(root, value.root))
    || files.some(file => typeof file === 'string' && (file === value.root || file.startsWith(value.root + '/'))))
    return Object.freeze({ enabled: false, reason: 'SCAN_RESULT_CACHE_ROOT_OVERLAP' });
  return Object.freeze({ enabled: true, root: value.root, role });
}

// Key components. Every field is required and type-checked; one that is missing or malformed makes the key null.
const COMMON = { repo: v => v === 'tdoljyj/cross-memory-system', sourceManifestSha256: v => SHA256.test(v ?? ''), sourceSha: v => SHA1.test(v ?? ''),
  workflowSha256: v => SHA256.test(v ?? ''), runtimeIdentity: text, hostAcceptanceRef: text, sourceAcceptanceRef: text };
const FIELDS = Object.freeze({
  trivy: { ...COMMON, profile: v => v === CACHED_OBSERVATION.trivy.profile, candidateTreeSha: v => SHA1.test(v ?? ''),
    inputInventorySha256: v => SHA256.test(v ?? ''), image: v => IMAGE.test(v ?? ''), nativeImageDigest: v => IMAGE.test(v ?? ''),
    policyImage: v => IMAGE.test(v ?? ''), dockerExecutableSha256: v => SHA256.test(v ?? ''), scannersSha256: v => SHA256.test(v ?? ''),
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
// contract-placement's fixed commands name the tested and base commits only as the two trees the check reads
// (check_contract_placement.py git_tree: rev-parse to a commit, then ls-tree; the trees are keyed) and as the build
// define, a fixed-width 40-hex string whose only effect on the verdict is the rendered response size. The template keys
// every other byte of every command.
export function placementCommandTemplateSha256(commands, job) {
  if (!Array.isArray(commands) || !SHA1.test(job?.testSha ?? '') || !SHA1.test(job?.baseSha ?? '')) return null;
  const blank = value => typeof value === 'string' ? value.split(job.testSha).join('{testSha}').split(job.baseSha).join('{baseSha}') : value;
  return digest(commands.map(command => ({ ...command, args: Array.isArray(command.args) ? command.args.map(blank) : null })));
}

function validCachedObservation(role, observation, components) {
  const expected = CACHED_OBSERVATION[role], o = observation;
  check(plain(o) && o.contract === expected.contract && o.profile === expected.profile && o.domain === 'production-observation' && o.fixture === false
    && o.formalEligible === false && o.checksWritten === false && o.qualificationIssued === false && !Object.hasOwn(o, 'cacheHit')
    && o.conclusion === 'success' && o.sourceManifestSha256 === components.sourceManifestSha256 && o.sourceSha === components.sourceSha
    && o.runtimeIdentity === components.runtimeIdentity && o.hostAcceptanceRef === components.hostAcceptanceRef && o.sourceAcceptanceRef === components.sourceAcceptanceRef
    && SHA256.test(o.preAdmissionSha256 ?? '') && SHA256.test(o.postAdmissionSha256 ?? '') && plain(o.subject), 'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
  if (role === 'trivy') check(o.candidateTreeSha === components.candidateTreeSha && o.inputInventorySha256 === components.inputInventorySha256
    && o.image === components.image && o.nativeImageDigest === components.nativeImageDigest && canonical(o.cache) === canonical(components.database)
    && Array.isArray(o.scans) && o.scans.length === 3 && o.scans.every(s => plain(s) && s.complete === true && s.cleanupConfirmed === true && s.exitCode === 0
      && SHA256.test(s.preAdmissionSha256 ?? '') && SHA256.test(s.postAdmissionSha256 ?? '') && plain(s.logs)), 'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
  else check(o.candidateTreeSha === components.testTreeSha && o.image === components.image && o.workflowSha256 === components.workflowSha256
    && o.toolPinsSha256 === components.toolPinsSha256 && o.exitCode === 0 && /^sha256:[a-f0-9]{64}$/.test(o.imageId ?? '')
    && plain(o.logs) && ['stdout', 'stderr'].every(k => exactKeys(o.logs[k], ['bytes', 'sha256', 'truncated']) && SHA256.test(o.logs[k].sha256 ?? '')
      && Number.isSafeInteger(o.logs[k].bytes) && o.logs[k].truncated === false), 'SCAN_RESULT_CACHE_OBSERVATION_REFUSED');
  return o;
}
const RECORD_KEYS = ['contract', 'role', 'keySha256', 'key', 'observation', 'originalObservationSha256', 'storedAt', 'recordSha256'];
// Pure: the record, or a thrown code. Bytes are parsed only here.
export function parseCacheRecord(bytes, role, key) {
  check(key && SHA256.test(key.keySha256 ?? '') && key.components?.role === role, 'SCAN_RESULT_CACHE_KEY_INCOMPLETE');
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_RECORD_BYTES, 'SCAN_RESULT_CACHE_RECORD_BOUND');
  let record; try { record = JSON.parse(bytes.toString('utf8')); } catch { fail('SCAN_RESULT_CACHE_RECORD_UNPARSABLE'); }
  check(exactKeys(record, RECORD_KEYS) && record.contract === CACHE_RECORD_CONTRACT && record.role === role, 'SCAN_RESULT_CACHE_RECORD_CONTRACT');
  const { recordSha256, ...body } = record;
  check(SHA256.test(recordSha256 ?? '') && digest(body) === recordSha256, 'SCAN_RESULT_CACHE_RECORD_DIGEST');
  check(record.keySha256 === key.keySha256 && canonical(record.key) === canonical(key.components) && digest(record.key) === key.keySha256, 'SCAN_RESULT_CACHE_KEY_MISMATCH');
  check(record.originalObservationSha256 === digest(record.observation) && Number.isFinite(Date.parse(record.storedAt)), 'SCAN_RESULT_CACHE_OBSERVATION_DIGEST');
  validCachedObservation(role, record.observation, key.components);
  return record;
}
// Pure: the record a real, complete, successful observation becomes.
export function cacheRecord(role, key, observation, storedAt = new Date().toISOString()) {
  check(key && key.components?.role === role && SHA256.test(key.keySha256 ?? ''), 'SCAN_RESULT_CACHE_KEY_INCOMPLETE');
  validCachedObservation(role, observation, key.components);
  const body = { contract: CACHE_RECORD_CONTRACT, role, keySha256: key.keySha256, key: key.components, observation,
    originalObservationSha256: digest(observation), storedAt };
  return { ...body, recordSha256: digest(body) };
}
// Pure: the cacheHit evidence a hit observation carries.
export function cacheHitEvidence(record, servedAt) {
  return Object.freeze({ contract: CACHE_HIT_CONTRACT, keySha256: record.keySha256, recordSha256: record.recordSha256,
    originalObservationSha256: record.originalObservationSha256, originalSubject: structuredClone(record.observation.subject),
    storedAt: record.storedAt, servedAt });
}
// Pure: the signer's and the Windows issuer's check of a hit observation's evidence (signed-result observationFacts).
export function validateCacheHitEvidence(value) {
  check(exactKeys(value, ['contract', 'keySha256', 'recordSha256', 'originalObservationSha256', 'originalSubject', 'storedAt', 'servedAt'])
    && value.contract === CACHE_HIT_CONTRACT && ['keySha256', 'recordSha256', 'originalObservationSha256'].every(k => SHA256.test(value[k] ?? ''))
    && plain(value.originalSubject) && Number.isFinite(Date.parse(value.storedAt)) && Number.isFinite(Date.parse(value.servedAt))
    && Date.parse(value.storedAt) <= Date.parse(value.servedAt), 'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED');
  return value;
}

// The cache port the adapters use. guard is protectedPath on the installed host; the offline tests pass their own.
// lookup never throws: every failure is { record: null, reason }. store never throws either and never replaces a record.
export function createResultCache(settings, { guard = protectedPath, now = () => new Date().toISOString() } = {}) {
  const enabled = settings?.enabled === true && typeof settings.root === 'string' && path.isAbsolute(settings.root) && CACHE_ROLES.includes(settings.role);
  const role = settings?.role, directory = enabled ? path.join(settings.root, role) : null;
  const fileOf = key => path.join(directory, key.keySha256 + '.json');
  return Object.freeze({
    enabled,
    async lookup(key) {
      if (!enabled) return { record: null, reason: settings?.reason ?? 'SCAN_RESULT_CACHE_DISABLED' };
      if (!key || key.components?.role !== role) return { record: null, reason: 'SCAN_RESULT_CACHE_KEY_INCOMPLETE' };
      try {
        await guard(settings.root, { directory: true }); await guard(directory, { directory: true });
        const file = fileOf(key);
        try { await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return { record: null, reason: 'SCAN_RESULT_CACHE_MISS' }; throw error; }
        await guard(file, { privateFile: true });
        const record = parseCacheRecord(await fsp.readFile(file), role, key);
        return { record, reason: 'SCAN_RESULT_CACHE_HIT' };
      } catch (error) { return { record: null, reason: reasonOf(error) }; }
    },
    async store(key, observation) {
      if (!enabled) return { stored: false, reason: settings?.reason ?? 'SCAN_RESULT_CACHE_DISABLED' };
      let temporary = null;
      try {
        const record = cacheRecord(role, key, observation, now());
        await guard(path.dirname(settings.root), { directory: true });
        for (const dir of [settings.root, directory]) { try { await fsp.mkdir(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } await guard(dir, { directory: true }); }
        const file = fileOf(key);
        temporary = path.join(directory, '.' + key.keySha256 + '.' + randomBytes(8).toString('hex') + '.tmp');
        const handle = await fsp.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
        try { await fsp.link(temporary, file); }
        catch (error) { if (error.code === 'EEXIST') return { stored: false, reason: 'SCAN_RESULT_CACHE_RECORD_EXISTS' }; throw error; }
        // Directory fsync (Linux, where the installed CI runs; Windows cannot open a directory for it).
        if (process.platform !== 'win32') { const parent = await fsp.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
        return { stored: true, reason: 'SCAN_RESULT_CACHE_STORED', keySha256: key.keySha256, recordSha256: record.recordSha256 };
      } catch (error) { return { stored: false, reason: reasonOf(error) }; }
      finally { if (temporary) await fsp.unlink(temporary).catch(() => {}); }
    },
  });
}
