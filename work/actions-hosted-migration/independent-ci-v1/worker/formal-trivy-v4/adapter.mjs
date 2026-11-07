// Source v2 copy of formal-trivy-v3/adapter.mjs (DESIGN S6): job contract v2, roles-v3 policy (no currentClaim),
// the shared v2 admission check with one claim generation per run, qualification v2, worker-v2 preparation,
// observation/intent contracts /2. Docker, scanner argv and cleanup are the unchanged v3 modules; the v3 cache
// module is shared (its prepare.lock is removed again when the lock write fails), and a BLOCKED cache is a clean
// refusal here (cacheRefusal).
// Fixed three-scanner execution Source. No signer, credentials or Checks writer.
// Back-to-back admissions (CI Source round-trip trim): nothing runs between one scanner's post admission and the next
// scanner's pre admission, or the final one, so that admission is carried over instead of asking the bridge again
// (carriedAdmission). Every scanner still has a fresh admission right before and right after it, and the observation
// records both per scanner (scans[i].preAdmissionSha256 / postAdmissionSha256; scans[i+1].pre is scans[i].post when carried).
// That shape is observation contract /3 (Owner decision, DESIGN 64.3; TRIVY_OBSERVATION_CONTRACT): the signer, the Windows
// issuer's verification and the role session accept only /3 for trivy. gitleaks keeps its /2.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { validateJobV2 as validateJob, subjectOfV2 as subjectOf } from '../../src/job-v2.mjs';
import { canonical, digest } from '../../src/proof.mjs';
import { validateFormalAdmissionV2 } from '../../src/admission-facts-v2.mjs';
import { validateScanStartGrant, NATIVE_SCAN_START_REQUIRED, scanStartPermission } from '../../src/scan-start-v1/grant.mjs';
import { prepareContainerWorkerJob } from '../../src/worker-v2.mjs';
import { loadQualifiedPolicyV2 as loadQualifiedPolicy, protectedPath, qualificationDeadline } from '../qualification-v2.mjs';
import { IMAGE, LIMITS, WORKFLOW_SHA256S, requiredTrivyPlans } from '../required-trivy-v3/plans.mjs';
import { actualDockerClient, NATIVE_IMAGE, runFixedScanner } from '../formal-trivy-v3/docker.mjs';
import { createActualStorage, actualCachePort } from '../formal-trivy-v3/cache.mjs';
import { cacheKey, cacheSettings, createResultCache, cacheHitEvidence, trivyScannersSha256 } from '../scan-result-cache-v1/cache.mjs';

const HASH = /^[a-f0-9]{64}$/;
export const TRIVY_OBSERVATION_CONTRACT = 'clued.independent-ci.formal-scanner-observation/3';
const JOB_TIMEOUT_MS = 25 * 60000; // Existing trusted trivy job ceiling.
const PREFIX = 'work/actions-hosted-migration/independent-ci-v1/';
const CLOSURE = ['worker/formal-trivy-v4/adapter.mjs', 'worker/formal-trivy-v3/docker.mjs', 'worker/formal-trivy-v3/cache.mjs',
  'worker/required-trivy-v3/plans.mjs', 'worker/required-trivy-v2/plans.mjs', 'worker/required-gitleaks/prepare.mjs', 'worker/verify-once/verify-worker.mjs',
  'worker/trusted-workflows.mjs', 'worker/qualification-v2.mjs', 'worker/scan-result-cache-v1/cache.mjs', 'worker/qualification.mjs', 'src/worker-v2.mjs', 'src/worker.mjs', 'src/proof.mjs', 'src/job-v2.mjs', 'src/admission-facts-v2.mjs', 'src/scan-start-v1/grant.mjs'];
const actualObservations = new WeakSet();
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const safeReason = error => /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(error.code ?? error.message ?? '') ? (error.code ?? error.message) : 'TRIVY_EXECUTION_UNCONFIRMED';
const without = (value, key) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
async function fileHash(file) { const hash = createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }
async function durableNew(file, value) { const h = await fsp.open(file, 'wx', 0o600); try { await h.writeFile(canonical(value)); await h.sync(); } finally { await h.close(); } }
export function validateRequiredJob(job) {
  validateJob(job); check(job.repo === 'tdoljyj/cross-memory-system' && job.role === 'trivy', 'FIXED_TRIVY_JOB_REQUIRED'); return job;
}
export function validateAdmission(job, value, now = Date.now(), options = {}) { validateRequiredJob(job); return validateFormalAdmissionV2(job, value, now, options); }
async function sourceBoundary(config, manifest) {
  const role = manifest.roles?.trivy, accepted = role?.formalTrivy;
  check(accepted?.profile === 'required-trivy-three-scanners/1' && role.containerCommand?.image === IMAGE
    && role.containerCommand.scanner === 'trivy' && role.containerCommand.executable === '/usr/local/bin/trivy'
    && role.timeoutMs === JOB_TIMEOUT_MS && role.maxOutputBytes === LIMITS.maxOutputBytes, 'FIXED_TRIVY_SOURCE_PROFILE_REQUIRED');
  for (const relative of CLOSURE) {
    const file = fileURLToPath(new URL('../../' + relative, import.meta.url)), pins = role.sourceFiles?.filter(pin => pin.path === PREFIX + relative);
    check(pins?.length === 1 && HASH.test(pins[0].sha256) && file === path.join(config.trustedSourceDirectory, PREFIX, relative), 'FORMAL_TRIVY_SOURCE_NOT_ACCEPTED');
    await protectedPath(file); check(await fileHash(file) === pins[0].sha256, 'FORMAL_TRIVY_SOURCE_DRIFT');
  }
  const workflowPins = role.sourceFiles.filter(pin => pin.path === '.github/workflows/trivy.yml');
  const workflow = path.join(config.trustedSourceDirectory, '.github/workflows/trivy.yml');
  check(workflowPins.length === 1 && WORKFLOW_SHA256S.includes(workflowPins[0].sha256), 'ORIGINAL_TRIVY_WORKFLOW_SOURCE_REQUIRED');
  await protectedPath(workflow); check(await fileHash(workflow) === workflowPins[0].sha256, 'ORIGINAL_TRIVY_WORKFLOW_DRIFT');
  check(typeof accepted.cacheRoot === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(accepted.cacheRoot) && path.posix.normalize(accepted.cacheRoot) === accepted.cacheRoot
    && accepted.cacheRoot !== '/' && ![config.workspaceRoot, config.runsRoot, config.trustedSourceDirectory].some(root => root === accepted.cacheRoot
      || root.startsWith(accepted.cacheRoot + '/') || accepted.cacheRoot.startsWith(root + '/'))
    && ![config.signingKeyFile, config.qualificationFile, config.publicKeyFile, config.sourceManifestFile].some(file => file.startsWith(accepted.cacheRoot + '/')),
  'CACHE_CONTROL_OR_PR_OVERLAP');
  await protectedPath(accepted.cacheRoot, { directory: true });
  return freeze({ accepted: structuredClone(accepted), workflowSha256: workflowPins[0].sha256 });
}

// No PR script executes while producing this immutable tree. The prior worker
// validates exact Git head/base and every tracked byte; this copy additionally
// requires root-owned nonwritable inputs and verifies each copied byte.
async function snapshotTree(source, destination) {
  await fsp.mkdir(destination, { mode: 0o755 }); const files = [];
  async function walk(from, to, prefix = '') {
    await protectedPath(from, { directory: true });
    for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
      if (!prefix && entry.name === '.git') continue;
      const relative = prefix + entry.name, input = path.join(from, entry.name), output = path.join(to, entry.name);
      check(relative.length < 4096 && !/[\\:\x00-\x1f]/.test(relative), 'SCANNER_INPUT_PATH_REFUSED');
      if (entry.isDirectory()) { await fsp.mkdir(output, { mode: 0o755 }); await walk(input, output, relative + '/'); await fsp.chmod(output, 0o555); }
      else { await protectedPath(input); const hash = await fileHash(input); await fsp.copyFile(input, output, fs.constants.COPYFILE_EXCL);
        check(await fileHash(output) === hash, 'SCANNER_SNAPSHOT_BYTES_CHANGED'); await fsp.chmod(output, 0o444); files.push({ path: relative, sha256: hash }); }
      check(files.length <= 100000, 'SCANNER_INPUT_BOUND');
    }
  }
  await walk(source, destination); await fsp.chmod(destination, 0o555); return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function removeSnapshot(run, snapshot) {
  check(path.dirname(snapshot) === run && path.basename(snapshot) === 'repo' && /^trivy-[a-f0-9]{64}$/.test(path.basename(run)), 'SNAPSHOT_CLEANUP_SCOPE');
  await protectedPath(run, { directory: true }); await protectedPath(snapshot, { directory: true });
  check(await fsp.realpath(snapshot) === snapshot, 'SNAPSHOT_CLEANUP_ALIAS'); await fsp.rm(snapshot, { recursive: true });
  try { await fsp.lstat(snapshot); check(false, 'SNAPSHOT_CLEANUP_UNCONFIRMED'); } catch (error) { check(error.code === 'ENOENT', 'SNAPSHOT_CLEANUP_UNCONFIRMED'); }
}

// The freshness window of a carried admission: clock-skew.mjs FRESH_MS, measured on this host's monotonic clock from the
// moment the admission was asked for (no later than its issuance), so it never outlasts what a new answer would get.
export const CARRIED_ADMISSION_MAX_AGE_MS = 30_000;
// Pure: the admission held from the step just before, when it may stand in for a new one. null means ask again: nothing
// held, older than the window (or a clock that went backwards), or facts the full v2 check no longer accepts now.
export function carriedAdmission(job, held, { now = Date.now(), nowMono, batchClaim = null } = {}) {
  if (!held || !Number.isFinite(held.sentMono) || !Number.isFinite(nowMono)) return null;
  const age = nowMono - held.sentMono;
  if (!(age >= 0 && age <= CARRIED_ADMISSION_MAX_AGE_MS)) return null;
  try { validateAdmission(job, held.facts, now, { batchClaim }); return held; } catch { return null; }
}

// M4 scan result cache (DESIGN 68): every input that can change the three scanners' verdict. The scanners read the
// snapshot only (snapshotTree skips .git, so no commit id, message or history), keyed by the candidate tree and the
// digest of every copied file's path and bytes; the offline database and checks bundle by their content digests; the
// image by tag digest, native digest and the role policy's pin; argv, mounts as the container sees them, limits and
// isolation by scannersSha256; the Docker client by its pinned hash; the trusted workflow, the whole Source manifest
// (adapter, plans, docker and cache modules) and the qualified runtime and acceptance references. null when any is
// missing: then nothing is looked up or stored.
export function trivyResultKey(input) {
  try { const { job, preparedRequest, inputInventory, plan, workflowSha256, context, keyContext } = input ?? {}; return cacheKey('trivy', { repo: job?.repo, profile: 'required-trivy-three-scanners/1', sourceManifestSha256: job?.sourceManifestSha256,
    sourceSha: preparedRequest?.sourceSha, workflowSha256, runtimeIdentity: context?.runtimeIdentity, hostAcceptanceRef: context?.hostAcceptanceRef,
    sourceAcceptanceRef: context?.sourceAcceptanceRef, candidateTreeSha: preparedRequest?.candidateTreeSha,
    inputInventorySha256: inputInventory?.complete === true && inputInventory.candidateTreeSha === preparedRequest?.candidateTreeSha ? digest(inputInventory) : null,
    image: IMAGE, nativeImageDigest: NATIVE_IMAGE, policyImage: keyContext?.policyImage, dockerExecutableSha256: keyContext?.dockerExecutableSha256,
    scannersSha256: trivyScannersSha256(plan?.scanners), database: plan?.cache }); } catch { return null; }
}

// The shared fixture path exercises real argv/readback algorithms with mocked
// Docker. It is deliberately not the installed qualification or signing path.
async function executeScanners({ job, preparedRequest, snapshotDirectory, inputInventory, cache, checksPin, workflowSha256, docker,
  dockerRootDirectory, deadline, signal, admissionPort, scanStartPort, scanStartRecord, fixture, context, generation = null,
  nativeScanStartRequired = NATIVE_SCAN_START_REQUIRED, monotonic = () => performance.now(), resultCache = null, keyContext = null }) {
  const scans = [], pre = validateAdmission(job, await admissionPort(job), Date.now(), { batchClaim: generation });
  check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED');
  const plan = requiredTrivyPlans({ job, preparedRequest, snapshotDirectory, inputInventory, database: cache.database,
    dbDecision: cache.dbDecision, checksBundle: cache.checksBundle, checksPin, workflowSha256, sourceManifestSha256: job.sourceManifestSha256 });
  check(typeof scanStartPort === 'function', 'PROTECTED_SCAN_START_PORT_MISSING');
  const grantValue = await scanStartPort(job);
  const grant = fixture ? validateScanStartGrant(grantValue, { job, executionId: grantValue?.execution_id }) : scanStartPermission(job, grantValue, nativeScanStartRequired);
  if (!fixture) { check(typeof scanStartRecord === 'function', 'PROTECTED_SCAN_START_RECORD_MISSING'); await scanStartRecord(grant); scanStartPermission(job, grantValue, nativeScanStartRequired); }
  check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED_BEFORE_SCAN');
  // A new admission, with the monotonic moment it was asked for; or the one carried from the step just before.
  const admit = async () => { const sentMono = monotonic(); return { facts: validateAdmission(job, await admissionPort(job), Date.now(), { batchClaim: generation }), sentMono }; };
  const freshAdmission = async held => carriedAdmission(job, held, { now: Date.now(), nowMono: monotonic(), batchClaim: generation }) ?? await admit();
  // A hit observation describes this run only: its own admissions, snapshot and cleanup; the original three scanner
  // records and their admissions are not repeated here as if they were this run's, they stay inside
  // cacheHit.originalObservation with the original signed envelope (DESIGN 68.5).
  const observationOf = (scans, post, cacheHit = null) => freeze({ contract: TRIVY_OBSERVATION_CONTRACT,
    domain: fixture ? 'fixture' : 'production-observation', fixture, profile: 'required-trivy-three-scanners/1', subject: subjectOf(job),
    sourceManifestSha256: job.sourceManifestSha256, sourceSha: preparedRequest.sourceSha, sourceTreeSha: preparedRequest.sourceTreeSha,
    candidateTreeSha: preparedRequest.candidateTreeSha, nonce: preparedRequest.nonce, requestSha256: digest(preparedRequest), inputInventorySha256: digest(inputInventory),
    image: IMAGE, nativeImageDigest: NATIVE_IMAGE, cache: plan.cache, cacheProvenanceSha256: cache.provenanceSha256,
    ...(cacheHit ? { conclusion: cacheHit.originalObservation.conclusion } : { scans, conclusion: scans.every(scan => scan.exitCode === 0) ? 'success' : 'failure' }),
    preAdmissionSha256: pre.observationSha256, postAdmissionSha256: post.observationSha256, runtimeIdentity: context.runtimeIdentity, hostAcceptanceRef: context.hostAcceptanceRef, sourceAcceptanceRef: context.sourceAcceptanceRef,
    cleanup: { containersRemoved: true, wholeContainerTreesStopped: true }, evidenceClass: 'unsigned-observation-requires-protected-result-issuer',
    formalEligible: false, checksWritten: false, qualificationIssued: false, publicationAuthorized: false, ...(cacheHit ? { cacheHit } : {}) });
  // M4 (DESIGN 68): after the grant is held and recorded, exactly where the first scanner would start. A hit starts no
  // scanner: it takes the burn-permission check a first scanner takes and a new post admission, and serves the original
  // signed result's verdict under this job's subject with cacheHit carrying it. Any lookup failure is a miss.
  const resultKey = resultCache?.enabled ? trivyResultKey({ job, preparedRequest, inputInventory, plan, workflowSha256, context, keyContext }) : null;
  const lookup = resultKey ? await resultCache.lookup(resultKey)
    : { record: null, reason: resultCache?.enabled ? 'SCAN_RESULT_CACHE_KEY_INCOMPLETE' : 'SCAN_RESULT_CACHE_DISABLED' };
  const resultCacheFacts = { keySha256: resultKey?.keySha256 ?? null, lookup: lookup.reason };
  if (lookup.record) {
    check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED_BEFORE_SCAN');
    if (!fixture) scanStartPermission(job, grantValue, nativeScanStartRequired);
    const servedAt = new Date().toISOString(), post = (await admit()).facts;
    check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED_AFTER_SCAN');
    return { status: 'THREE_SCANNERS_OBSERVED_UNSIGNED',
      observation: observationOf(null, post, cacheHitEvidence(lookup.record, servedAt)),
      resultCache: resultCacheFacts, formalEligible: false, checksWritten: false };
  }
  let carried = null;
  for (const scan of plan.scanners) {
    // The previous scanner's post admission, with no work since, unless it left the freshness window.
    const before = await freshAdmission(carried); carried = null; check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED_BEFORE_SCAN');
    // The last admission await can outlive the grant's transport window. Burn
    // permission is checked again only before this role unit's first scanner.
    if (!fixture && scans.length === 0) scanStartPermission(job, grantValue, nativeScanStartRequired);
    const result = await runFixedScanner({ scan, docker, dockerRootDirectory, deadline: Math.min(deadline, Date.now() + LIMITS.timeoutMs), signal });
    const entry = { ...result, preAdmissionSha256: before.facts.observationSha256 }; scans.push(entry);
    if (!result.complete || !result.cleanupConfirmed || Date.parse(result.cleanupObservedAt) > deadline) return { status: result.touched ? 'UNCERTAIN' : 'BLOCKED',
      reason: result.reason ?? 'SCAN_CLEANUP_UNCONFIRMED', scans, fixture, automaticRetryAllowed: false, checksWritten: false, formalEligible: false };
    const after = await admit(); check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED_AFTER_SCAN');
    scans[scans.length - 1] = { ...entry, postAdmissionSha256: after.facts.observationSha256 }; carried = after;
  }
  const post = (await freshAdmission(carried)).facts;
  return { status: 'THREE_SCANNERS_OBSERVED_UNSIGNED', observation: observationOf(scans, post), resultCache: resultCacheFacts, resultKey,
    formalEligible: false, checksWritten: false };
}
export function createFixtureTrivyAdapter({ docker, cache, checksPin, admissionPort, scanStartPort, preparedRequest, snapshotDirectory, inputInventory, workflowSha256 = WORKFLOW_SHA256S[0] }) {
  return Object.freeze({ fixture: true, async execute(job, { signal } = {}) {
    try { job = freeze(structuredClone(validateRequiredJob(job))); check(cache?.fixture === true, 'FIXTURE_CACHE_REQUIRED');
      return await executeScanners({ job, preparedRequest, snapshotDirectory, inputInventory, cache, checksPin, workflowSha256, docker, dockerRootDirectory: '/var/lib/docker',
        deadline: Date.now() + 60000, signal, admissionPort, scanStartPort, fixture: true, context: { runtimeIdentity: 'fixture', hostAcceptanceRef: null, sourceAcceptanceRef: null } });
    } catch (error) { return { status: 'UNCERTAIN', reason: safeReason(error), fixture: true, formalEligible: false, checksWritten: false, automaticRetryAllowed: false }; }
  } });
}
// Pure: the outcome of a cache that is not READY. A BLOCKED cache (formal-trivy-v3/cache.mjs prepare) left no
// activation in progress and released its lock (a DB generation it already promoted is an ordinary cache update);
// its containers had a cache-only mount and nothing of the checkout. Once the snapshot is removed no scanner touched
// the PR, so it is a clean refusal the bridge publishes as blocked under its reason (protected-job-bridge-v4
// isCleanBlocked); the Windows issuer ends the stage clean and final, without an automatic retry. Any other status
// keeps the snapshot and stays UNCERTAIN. The record is kept in the run directory either way, so the reason and the
// number of cache containers run survive the bridge.
export function cacheRefusal(cache, subject, observedAt) {
  const clean = cache?.status === 'BLOCKED', reason = typeof cache?.reason === 'string' && cache.reason ? cache.reason : 'CACHE_PREPARATION_REFUSED';
  return freeze({ clean, file: clean ? 'cache-blocked.json' : 'uncertain.json',
    record: { contract: 'clued.independent-ci.formal-trivy-cache-refusal/1', subject, cacheStatus: String(cache?.status), reason,
      phase: typeof cache?.phase === 'string' ? cache.phase : null,
      cacheContainerRuns: Array.isArray(cache?.observations) ? cache.observations.length : null, snapshotRemoved: clean, observedAt },
    result: { status: clean ? 'BLOCKED' : 'UNCERTAIN', reason, sideEffectsMayHaveStarted: !clean, snapshotRetained: !clean,
      automaticRetryAllowed: false, checksWritten: false, formalEligible: false } });
}
// After the final observation exists: it is made durable first, then the run's cache facts (result-cache.json, for a hit
// and a miss alike). A real complete successful run with a key gets back the one way to store it, which the bridge calls
// only after the result is signed (protected-job-bridge-v4 linux-worker): the record carries that signed envelope. A hit
// is never stored. A failed store writes its reason (result-cache-store.json) and never changes the signed result.
async function finishObservation({ run, job, observation, result, resultCache, write }) {
  await write(path.join(run, 'observation.json'), observation);
  const facts = { contract: 'clued.independent-ci.scan-result-cache-run/1', subject: subjectOf(job), enabled: resultCache.enabled,
    keySha256: result.resultCache?.keySha256 ?? null, lookup: result.resultCache?.lookup ?? 'SCAN_RESULT_CACHE_DISABLED',
    cacheHit: observation.cacheHit ? { keySha256: observation.cacheHit.keySha256, recordSha256: observation.cacheHit.recordSha256,
      originalObservationSha256: observation.cacheHit.originalObservationSha256 } : null, observationSha256: digest(observation) };
  try { await write(path.join(run, 'result-cache.json'), facts); } catch {}
  if (!result.resultKey || observation.cacheHit || observation.conclusion !== 'success') return null;
  const key = result.resultKey, observationSha256 = digest(observation);
  return async signed => {
    const stored = signed?.observation && digest(signed.observation) === observationSha256 && signed.envelope?.payload?.executionObservationSha256 === observationSha256
      ? await resultCache.store(key, observation, signed.envelope) : { stored: false, reason: 'SCAN_RESULT_CACHE_SIGNED_RESULT_MISMATCH' };
    try { await write(path.join(run, 'result-cache-store.json'), { contract: 'clued.independent-ci.scan-result-cache-store/1', subject: subjectOf(job),
      keySha256: key.keySha256, observationSha256, ...stored }); } catch {}
    return stored;
  };
}
export function takeActualObservation(observation, job) {
  validateRequiredJob(job); check(actualObservations.has(observation) && canonical(observation.subject) === canonical(subjectOf(job)), 'ACTUAL_PROTECTED_TRIVY_OBSERVATION_REQUIRED'); return observation;
}
export function createFormalTrivyAdapter({ admissionPort, scanStartPort, nativeScanStartRequired = NATIVE_SCAN_START_REQUIRED } = {}) {
  return Object.freeze({ async execute(input, { signal } = {}) {
    let run = null, snapshot = null, mayHaveStarted = false, snapshotReady = false;
    try {
      const job = freeze(structuredClone(validateRequiredJob(input)));
      check(typeof admissionPort === 'function' && typeof scanStartPort === 'function', 'PROTECTED_COMPLETE_ADMISSION_PORT_MISSING');
      check(process.platform === 'linux' && process.getuid?.() === 0, 'FIXED_PROTECTED_LINUX_ROOT_REQUIRED');
      const { config, sourceManifestBytes, qualification, publicKey } = await loadQualifiedPolicy('/etc/clued-independent-ci/roles-v3/trivy.json');
      check(config.executionMode === 'scanner' && config.image === IMAGE && config.sourceManifestSha256 === job.sourceManifestSha256
        && config.dockerRootDirectory === '/var/lib/docker'
        && config.memoryBytes === LIMITS.memoryBytes && config.cpus === LIMITS.cpus && config.pids === LIMITS.pids, 'QUALIFIED_JOB_CONTEXT_MISMATCH');
      const { accepted, workflowSha256 } = await sourceBoundary(config, JSON.parse(sourceManifestBytes));
      const before = validateAdmission(job, await admissionPort(job)), generation = before.batchClaimBound;
      const deadline = Math.min(Date.parse(before.claimExpiresAt), qualificationDeadline(qualification.payload), Date.now() + JOB_TIMEOUT_MS);
      check(deadline > Date.now() && !signal?.aborted, 'CURRENT_AUTHORITY_EXPIRED');
      const candidate = path.join(config.workspaceRoot, job.id, 'candidate'); await protectedPath(candidate, { directory: true });
      const prepared = await prepareContainerWorkerJob({ job, workspace: candidate, trustedSourceDirectory: config.trustedSourceDirectory,
        sourceManifestBytes, expectedSourceManifestSha256: config.sourceManifestSha256, gitExecutable: config.gitExecutable });
      run = path.join(config.runsRoot, 'trivy-' + randomBytes(32).toString('hex')); await fsp.mkdir(run, { mode: 0o700 });
      await durableNew(path.join(run, 'intent.json'), { contract: 'clued.independent-ci.formal-trivy-intent/2', subject: subjectOf(job),
        requestSha256: digest(prepared), preAdmissionSha256: before.observationSha256, automaticRetryAllowed: false });
      snapshot = path.join(run, 'repo'); snapshotReady = true; const files = await snapshotTree(candidate, snapshot);
      const inputInventory = { complete: true, candidateTreeSha: prepared.candidateTreeSha, paths: files.map(file => file.path), files };
      const storage = await createActualStorage(accepted.cacheRoot), docker = actualDockerClient();
      const resultCache = createResultCache(cacheSettings(config, 'trivy', { extraRoots: [accepted.cacheRoot] }),
        { signer: { publicKeyPem: publicKey, keyId: config.keyId, runtimeId: config.runtimeIdentity } });
      validateAdmission(job, await admissionPort(job), Date.now(), { batchClaim: generation }); mayHaveStarted = true;
      const cache = await actualCachePort({ storage, docker, dockerRootDirectory: config.dockerRootDirectory, checksPin: accepted.checksPin }).prepare({ deadline, signal });
      if (cache.status !== 'READY') {
        const refusal = cacheRefusal(cache, subjectOf(job), new Date().toISOString());
        if (refusal.clean) { await removeSnapshot(run, snapshot); snapshotReady = false; }
        await durableNew(path.join(run, refusal.file), refusal.record); return { ...refusal.result, cache };
      }
      const result = await executeScanners({ job, preparedRequest: prepared, snapshotDirectory: snapshot, inputInventory, cache, checksPin: accepted.checksPin, workflowSha256,
        docker, dockerRootDirectory: config.dockerRootDirectory, deadline, signal, admissionPort, scanStartPort,
        scanStartRecord: grant => durableNew(path.join(run, 'scan-start.json'), grant), fixture: false, context: config, generation, nativeScanStartRequired,
        resultCache, keyContext: { policyImage: config.image, dockerExecutableSha256: config.dockerExecutableSha256 } });
      if (result.status !== 'UNCERTAIN') { await removeSnapshot(run, snapshot); snapshotReady = false; }
      if (result.observation) {
        const observation = freeze({ ...result.observation, cleanup: { ...result.observation.cleanup, snapshotRemoved: true, observedAt: new Date().toISOString() } });
        check(Date.now() <= deadline, 'AUTHORITY_EXPIRED_AFTER_CLEANUP');
        const { resultKey: _key, ...rest } = result;
        const storeSignedResult = await finishObservation({ run, job, observation, result, resultCache, write: durableNew });
        actualObservations.add(observation); return { ...rest, observation, ...(storeSignedResult ? { storeSignedResult } : {}) };
      }
      await durableNew(path.join(run, 'uncertain.json'), result); return result;
    } catch (error) {
      const result = { status: mayHaveStarted ? 'UNCERTAIN' : 'BLOCKED', reason: safeReason(error), sideEffectsMayHaveStarted: mayHaveStarted,
        snapshotRetained: snapshotReady, automaticRetryAllowed: false, formalEligible: false, checksWritten: false, qualificationIssued: false };
      if (run) try { await durableNew(path.join(run, 'uncertain.json'), result); } catch { result.receiptPersistenceConfirmed = false; }
      return result;
    }
  } });
}
