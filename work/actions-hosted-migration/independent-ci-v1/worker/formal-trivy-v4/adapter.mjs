// Source v2 copy of formal-trivy-v3/adapter.mjs (DESIGN S6): job contract v2, roles-v3 policy (no currentClaim),
// the shared v2 admission check with one claim generation per run, qualification v2, worker-v2 preparation,
// observation/intent contracts /2. Docker, scanner argv and cleanup are the unchanged v3 modules; the v3 cache
// module is shared (its prepare.lock is removed again when the lock write fails), and a BLOCKED cache is a clean
// refusal here (cacheRefusal).
// Fixed three-scanner execution Source. No signer, credentials or Checks writer.
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

const HASH = /^[a-f0-9]{64}$/;
const JOB_TIMEOUT_MS = 25 * 60000; // Existing trusted trivy job ceiling.
const PREFIX = 'work/actions-hosted-migration/independent-ci-v1/';
const CLOSURE = ['worker/formal-trivy-v4/adapter.mjs', 'worker/formal-trivy-v3/docker.mjs', 'worker/formal-trivy-v3/cache.mjs',
  'worker/required-trivy-v3/plans.mjs', 'worker/required-trivy-v2/plans.mjs', 'worker/required-gitleaks/prepare.mjs', 'worker/verify-once/verify-worker.mjs',
  'worker/trusted-workflows.mjs', 'worker/qualification-v2.mjs', 'worker/qualification.mjs', 'src/worker-v2.mjs', 'src/worker.mjs', 'src/proof.mjs', 'src/job-v2.mjs', 'src/admission-facts-v2.mjs', 'src/scan-start-v1/grant.mjs'];
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

// The shared fixture path exercises real argv/readback algorithms with mocked
// Docker. It is deliberately not the installed qualification or signing path.
async function executeScanners({ job, preparedRequest, snapshotDirectory, inputInventory, cache, checksPin, workflowSha256, docker,
  dockerRootDirectory, deadline, signal, admissionPort, scanStartPort, scanStartRecord, fixture, context, generation = null,
  nativeScanStartRequired = NATIVE_SCAN_START_REQUIRED }) {
  const scans = [], pre = validateAdmission(job, await admissionPort(job), Date.now(), { batchClaim: generation });
  check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED');
  const plan = requiredTrivyPlans({ job, preparedRequest, snapshotDirectory, inputInventory, database: cache.database,
    dbDecision: cache.dbDecision, checksBundle: cache.checksBundle, checksPin, workflowSha256, sourceManifestSha256: job.sourceManifestSha256 });
  check(typeof scanStartPort === 'function', 'PROTECTED_SCAN_START_PORT_MISSING');
  const grantValue = await scanStartPort(job);
  const grant = fixture ? validateScanStartGrant(grantValue, { job, executionId: grantValue?.execution_id }) : scanStartPermission(job, grantValue, nativeScanStartRequired);
  if (!fixture) { check(typeof scanStartRecord === 'function', 'PROTECTED_SCAN_START_RECORD_MISSING'); await scanStartRecord(grant); scanStartPermission(job, grantValue, nativeScanStartRequired); }
  check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED_BEFORE_SCAN');
  for (const scan of plan.scanners) {
    validateAdmission(job, await admissionPort(job), Date.now(), { batchClaim: generation }); check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED_BEFORE_SCAN');
    // The last admission await can outlive the grant's transport window. Burn
    // permission is checked again only before this role unit's first scanner.
    if (!fixture && scans.length === 0) scanStartPermission(job, grantValue, nativeScanStartRequired);
    const result = await runFixedScanner({ scan, docker, dockerRootDirectory, deadline: Math.min(deadline, Date.now() + LIMITS.timeoutMs), signal }); scans.push(result);
    if (!result.complete || !result.cleanupConfirmed || Date.parse(result.cleanupObservedAt) > deadline) return { status: result.touched ? 'UNCERTAIN' : 'BLOCKED',
      reason: result.reason ?? 'SCAN_CLEANUP_UNCONFIRMED', scans, fixture, automaticRetryAllowed: false, checksWritten: false, formalEligible: false };
    validateAdmission(job, await admissionPort(job), Date.now(), { batchClaim: generation }); check(Date.now() < deadline && !signal?.aborted, 'AUTHORITY_EXPIRED_AFTER_SCAN');
  }
  const post = validateAdmission(job, await admissionPort(job), Date.now(), { batchClaim: generation });
  return { status: 'THREE_SCANNERS_OBSERVED_UNSIGNED', observation: freeze({ contract: 'clued.independent-ci.formal-scanner-observation/2',
    domain: fixture ? 'fixture' : 'production-observation', fixture, profile: 'required-trivy-three-scanners/1', subject: subjectOf(job),
    sourceManifestSha256: job.sourceManifestSha256, sourceSha: preparedRequest.sourceSha, sourceTreeSha: preparedRequest.sourceTreeSha,
    candidateTreeSha: preparedRequest.candidateTreeSha, nonce: preparedRequest.nonce, requestSha256: digest(preparedRequest), inputInventorySha256: digest(inputInventory),
    image: IMAGE, nativeImageDigest: NATIVE_IMAGE, cache: plan.cache, cacheProvenanceSha256: cache.provenanceSha256,
    scans, conclusion: scans.every(scan => scan.exitCode === 0) ? 'success' : 'failure', preAdmissionSha256: pre.observationSha256, postAdmissionSha256: post.observationSha256,
    runtimeIdentity: context.runtimeIdentity, hostAcceptanceRef: context.hostAcceptanceRef, sourceAcceptanceRef: context.sourceAcceptanceRef,
    cleanup: { containersRemoved: true, wholeContainerTreesStopped: true }, evidenceClass: 'unsigned-observation-requires-protected-result-issuer',
    formalEligible: false, checksWritten: false, qualificationIssued: false, publicationAuthorized: false }), formalEligible: false, checksWritten: false };
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
      const { config, sourceManifestBytes, qualification } = await loadQualifiedPolicy('/etc/clued-independent-ci/roles-v3/trivy.json');
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
      validateAdmission(job, await admissionPort(job), Date.now(), { batchClaim: generation }); mayHaveStarted = true;
      const cache = await actualCachePort({ storage, docker, dockerRootDirectory: config.dockerRootDirectory, checksPin: accepted.checksPin }).prepare({ deadline, signal });
      if (cache.status !== 'READY') {
        const refusal = cacheRefusal(cache, subjectOf(job), new Date().toISOString());
        if (refusal.clean) { await removeSnapshot(run, snapshot); snapshotReady = false; }
        await durableNew(path.join(run, refusal.file), refusal.record); return { ...refusal.result, cache };
      }
      const result = await executeScanners({ job, preparedRequest: prepared, snapshotDirectory: snapshot, inputInventory, cache, checksPin: accepted.checksPin, workflowSha256,
        docker, dockerRootDirectory: config.dockerRootDirectory, deadline, signal, admissionPort, scanStartPort,
        scanStartRecord: grant => durableNew(path.join(run, 'scan-start.json'), grant), fixture: false, context: config, generation, nativeScanStartRequired });
      if (result.status !== 'UNCERTAIN') { await removeSnapshot(run, snapshot); snapshotReady = false; }
      if (result.observation) {
        const observation = freeze({ ...result.observation, cleanup: { ...result.observation.cleanup, snapshotRemoved: true, observedAt: new Date().toISOString() } });
        check(Date.now() <= deadline, 'AUTHORITY_EXPIRED_AFTER_CLEANUP'); await durableNew(path.join(run, 'observation.json'), observation);
        actualObservations.add(observation); return { ...result, observation };
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
