// Source v2 copy of required-trivy-v2/plans.mjs (DESIGN S6): job contract v2 and the v2 prepared identity
// (worker-v2.mjs: no claim, attempt). Images, argv, cache and limits are unchanged.
// Fixed three-scanner Source candidate. No downloader, Docker execution,
// credentials, qualification issuer, signing or publication is invoked here.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateJobV2 as validateJob, subjectOfV2 as subjectOf } from '../../src/job-v2.mjs';
import { canonical, digest } from '../../src/proof.mjs';
import { noLinks } from '../required-gitleaks/prepare.mjs';
import { activeTrivyWorkflowSha256s } from '../trusted-workflows.mjs';
import { createArguments, inspectContainer } from '../verify-once/verify-worker.mjs';

export const IMAGE = 'ghcr.io/aquasecurity/trivy:0.74.0@sha256:ee940acbf1f58ebadb42d01434ce4609530bf1b52536afbd1eee66cd7123c5c9';
// .github/workflows/trivy.yml is pinned as an exact accepted set, never a pattern, taken from the one table
// (worker/trusted-workflows.mjs). The adapter passes the one the installed Source manifest declares and its
// trusted checkout holds.
export const WORKFLOW_SHA256S = activeTrivyWorkflowSha256s();
export const CHECKS_REPOSITORY = 'ghcr.io/aquasecurity/trivy-checks:2';
export const DB_REPOSITORIES = Object.freeze(['ghcr.io/aquasecurity/trivy-db:2', 'mirror.gcr.io/aquasec/trivy-db:2']);
const HASH = /^[a-f0-9]{64}$/;
const OCI = /^sha256:[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
const safe = filename => typeof filename === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(filename) && path.posix.normalize(filename) === filename && filename !== '/';
export const LIMITS = Object.freeze({ timeoutMs: 300000, maxOutputBytes: 16 * 1024 * 1024, memoryBytes: 2147483648, cpus: 2, pids: 128 });
export const SCANNERS = Object.freeze({
  vuln: Object.freeze(['fs', '--skip-db-update', '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--ignore-unfixed', '--exit-code', '1']),
  secret: Object.freeze(['fs', '--scanners', 'secret', '--exit-code', '1']),
  misconfig: Object.freeze(['fs', '--checks-bundle-repository', CHECKS_REPOSITORY, '--scanners', 'misconfig', '--severity', 'HIGH,CRITICAL', '--exit-code', '1']),
});

function usableDb(value, now) {
  return plain(value) && value.exists === true && value.complete === true && value.metadata?.Version === 2
    && Number.isSafeInteger(value.bytes) && value.bytes > 0 && HASH.test(value.sha256 ?? '') && HASH.test(value.metadataSha256 ?? '')
    && Number.isFinite(time(value.metadata.UpdatedAt)) && time(value.metadata.UpdatedAt) <= now;
}
export function databaseDecision({ current, attempts = [], now = Date.now() }) {
  check(Number.isSafeInteger(now), 'CLOCK_UNKNOWN');
  if (!Array.isArray(attempts) || attempts.length > 4) return { status: 'BLOCKED', reason: 'DB_ATTEMPTS_UNKNOWN' };
  if (attempts.length === 0 && usableDb(current, now) && time(current.metadata.NextUpdate) > now) return { status: 'READY', source: 'current', download: false, fallback: false, db: current };
  const expected = DB_REPOSITORIES.flatMap(repository => [1, 2].map(attempt => ({ repository, attempt })));
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    if (attempt?.repository !== expected[index].repository || attempt.attempt !== expected[index].attempt
      || !['failure', 'success'].includes(attempt.outcome) || attempt.cleanupConfirmed !== true) return { status: 'BLOCKED', reason: 'DB_ATTEMPT_TIMEOUT_OR_UNKNOWN' };
    if (attempt.outcome === 'success') {
      if (index !== attempts.length - 1 || !usableDb(attempt.db, now) || !(time(attempt.db.metadata.NextUpdate) > now)) return { status: 'BLOCKED', reason: 'STAGING_DB_UNCONFIRMED' };
      return { status: 'READY', source: 'staging', download: true, fallback: false, promote: true, db: attempt.db, attemptIndex: index };
    }
  }
  if (attempts.length < 4) return { status: 'PREPARE_REQUIRED', nextAttempt: expected[attempts.length], currentUntouched: true };
  if (usableDb(current, now) && now - time(current.metadata.UpdatedAt) <= 72 * 3600000) return { status: 'READY', source: 'current',
    download: false, fallback: true, warning: 'ALL_FOUR_DB_DOWNLOADS_FAILED_USING_AT_MOST_72H_OLD_DB', db: current };
  return { status: 'BLOCKED', reason: 'DB_MISSING_OR_OVER_72H_OLD' };
}

async function hashFile(file) {
  await noLinks(file); const stat = await fsp.lstat(file); check(stat.isFile() && stat.nlink === 1, 'CACHE_FILE_INVALID');
  const hash = createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  const after = await fsp.lstat(file); check(after.ino === stat.ino && after.dev === stat.dev && after.size === stat.size && after.mtimeMs === stat.mtimeMs, 'CACHE_FILE_CHANGED');
  return { bytes: stat.size, sha256: hash.digest('hex') };
}
export async function inspectDatabase(cacheDirectory) {
  await noLinks(cacheDirectory); const directory = path.join(cacheDirectory, 'db');
  try {
    const file = await hashFile(path.join(directory, 'trivy.db')), meta = path.join(directory, 'metadata.json');
    const metadataHash = await hashFile(meta); const metadata = JSON.parse(await fsp.readFile(meta, 'utf8'));
    check(await hashFile(meta).then(value => value.sha256) === metadataHash.sha256, 'CACHE_METADATA_CHANGED');
    return { exists: true, complete: true, directory, ...file, metadata, metadataSha256: metadataHash.sha256 };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false, complete: false }; throw error; }
}
export async function inspectChecksBundle(cacheDirectory) {
  const directory = path.join(cacheDirectory, 'policy'); await noLinks(directory, true);
  const metadataFile = path.join(directory, 'metadata.json'), metadata = JSON.parse(await fsp.readFile(metadataFile, 'utf8'));
  const metadataHash = await hashFile(metadataFile), content = path.join(directory, 'content'), files = [];
  async function walk(root, prefix = '') {
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(file, relative + '/'); else files.push({ path: relative, ...await hashFile(file) });
      check(files.length <= 20000, 'CHECKS_BUNDLE_SIZE_BOUND');
    }
  }
  await walk(content); files.sort((a, b) => a.path.localeCompare(b.path));
  check(files.length > 0 && files.some(file => file.path.endsWith('.rego')), 'CHECKS_BUNDLE_CONTENT_MISSING');
  return { complete: true, directory, metadata, metadataSha256: metadataHash.sha256, contentSha256: digest(files),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}
export function validateChecksBundle(actual, pin, now = Date.now()) {
  check(pin?.repository === CHECKS_REPOSITORY && OCI.test(pin.digest ?? '') && pin.majorVersion === 2
    && HASH.test(pin.contentSha256 ?? ''), 'PINNED_REAL_CHECKS_BUNDLE_REQUIRED');
  check(actual?.complete === true && actual.metadata?.Digest === pin.digest && actual.metadata.MajorVersion === pin.majorVersion
    && actual.metadata.CustomBuild !== true && time(actual.metadata.DownloadedAt) <= now
    && now - time(actual.metadata.DownloadedAt) < 24 * 3600000
    && actual.contentSha256 === pin.contentSha256 && HASH.test(actual.metadataSha256 ?? '') && actual.files?.some(file => file.path.endsWith('.rego')), 'CHECKS_BUNDLE_VERSION_OR_BYTES_CHANGED');
  return actual;
}

// Network use is confined to a new cache-only staging mount. No /repo,
// credential, Docker socket, PR-selected environment or old cache is mounted.
export function databasePreparationPlan({ stagingDirectory, current, now = Date.now() }) {
  check(safe(stagingDirectory), 'FIXED_STAGING_PATH_REQUIRED');
  const decision = databaseDecision({ current, now });
  if (decision.status === 'READY') return { contract: 'clued.independent-ci.trivy-db-preparation/1', decision, attempts: [], currentUntouched: true, sourceCandidateOnly: true };
  return { contract: 'clued.independent-ci.trivy-db-preparation/1', decision, image: IMAGE, executable: '/usr/local/bin/trivy',
    attempts: DB_REPOSITORIES.flatMap(repository => [1, 2].map(attempt => ({ repository, attempt,
      argv: ['fs', '--download-db-only', '--timeout', '5m', '--cache-dir', '/cache', '--db-repository', repository],
      network: 'host', mounts: [{ source: stagingDirectory, target: '/cache', readOnly: false }],
      user: '65532:65532', rootfsReadOnly: true, capDrop: ['ALL'], noNewPrivileges: true, limits: LIMITS,
      environment: { HOME: '/scratch', TMPDIR: '/scratch', DOCKER_CONFIG: '/nonexistent' }, inheritEnvironment: false }))),
    activation: { method: 'immutable-generation-and-current-pointer-cas', before: 'validate real download exit, complete DB bytes/metadata and cleanup',
      onFailure: 'retain previous cache and pointer; unknown/timeout is BLOCKED', expectedCurrentPointerSha256Required: true },
    sourceCandidateOnly: true, actualDownloadObserved: false, formalEligible: false };
}
export function cachePromotionPlan({ decision, generationDirectory, currentPointerFile, expectedCurrentPointerSha256, currentPointer, now = Date.now() }) {
  check(decision?.status === 'READY' && decision.source === 'staging' && decision.promote === true && usableDb(decision.db, now), 'REAL_COMPLETE_STAGING_SUCCESS_REQUIRED');
  check(safe(generationDirectory) && safe(currentPointerFile) && (expectedCurrentPointerSha256 === null || HASH.test(expectedCurrentPointerSha256 ?? ''))
    && (currentPointer === null ? null : digest(currentPointer)) === expectedCurrentPointerSha256, 'CACHE_POINTER_CAS_CHANGED');
  return { contract: 'clued.independent-ci.trivy-cache-promotion-plan/1', generationDirectory, currentPointerFile, expectedCurrentPointerSha256,
    nextPointer: { contract: 'clued.independent-ci.trivy-cache-generation/1', directory: generationDirectory, dbSha256: decision.db.sha256,
      dbMetadataSha256: decision.db.metadataSha256, activatedAt: new Date(now).toISOString() },
    operations: ['seal-and-fsync-new-generation', 'create-exclusive-next-pointer', 'recheck-current-pointer-cas', 'atomic-rename-next-pointer', 'fsync-parent-directory'],
    preserveOldGeneration: true, actualPromotionPerformed: false, formalEligible: false };
}

export function checksPreparationPlan({ stagingDirectory, emptyDirectory, checksPin }) {
  check(safe(stagingDirectory) && safe(emptyDirectory) && stagingDirectory !== emptyDirectory
    && !emptyDirectory.startsWith(stagingDirectory + '/') && !stagingDirectory.startsWith(emptyDirectory + '/'), 'FIXED_CACHE_ONLY_CHECKS_STAGING_REQUIRED');
  if (checksPin?.repository !== CHECKS_REPOSITORY || !OCI.test(checksPin.digest ?? '') || checksPin.majorVersion !== 2 || !HASH.test(checksPin.contentSha256 ?? '')) {
    return { status: 'BLOCKED', missing: ['actual_checks_bundle_oci_digest_major_version_and_content_hash'], formalEligible: false };
  }
  return { contract: 'clued.independent-ci.trivy-checks-preparation/1', image: IMAGE, executable: '/usr/local/bin/trivy',
    args: ['fs', '--cache-dir', '/cache', '--checks-bundle-repository', CHECKS_REPOSITORY.replace(/:2$/, '') + '@' + checksPin.digest,
      '--scanners', 'misconfig', '--severity', 'HIGH,CRITICAL', '--exit-code', '1', '/empty'],
    network: 'host', user: '65532:65532', rootfsReadOnly: true, capDrop: ['ALL'], noNewPrivileges: true,
    mounts: [{ source: stagingDirectory, target: '/cache', readOnly: false }, { source: emptyDirectory, target: '/empty', readOnly: true }],
    inheritEnvironment: false, environment: { HOME: '/scratch', TMPDIR: '/scratch', DOCKER_CONFIG: '/nonexistent' }, limits: LIMITS, checksPin,
    requireBeforeActivation: ['real-exit-and-cleanup', 'empty-directory-really-empty', 'exact-policy-digest-version-and-content-hash'],
    currentCacheUntouched: true, actualDownloadObserved: false, formalEligible: false };
}

export function requiredTrivyPlans({ job, preparedRequest, snapshotDirectory, database, dbDecision, checksBundle, checksPin,
  workflowSha256, sourceManifestSha256, inputInventory, now = Date.now() }) {
  validateJob(job); check(job.repo === 'tdoljyj/cross-memory-system' && job.role === 'trivy'
    && WORKFLOW_SHA256S.includes(workflowSha256) && sourceManifestSha256 === job.sourceManifestSha256, 'FIXED_TRIVY_SOURCE_REQUIRED');
  check(safe(snapshotDirectory) && safe(database?.directory) && safe(checksBundle?.directory)
    && ![database.directory, checksBundle.directory].some(root => root === snapshotDirectory || root.startsWith(snapshotDirectory + '/') || snapshotDirectory.startsWith(root + '/')), 'PR_CACHE_MOUNT_OVERLAP');
  const identity = preparedRequest?.identity;
  check(preparedRequest?.schema === 'independent-ci.container-execution-request.v1' && preparedRequest.containerCommand?.image === IMAGE
    && /^[a-f0-9]{40}$/.test(preparedRequest.candidateTreeSha ?? '')
    && ['repo', 'pr', 'headSha', 'baseSha', 'role', 'sourceManifestSha256', 'attempt'].every(key => identity?.[key] === job[key])
    && identity.jobId === job.id, 'EXACT_PREPARED_SOURCE_JOB_REQUIRED');
  check(inputInventory?.complete === true && inputInventory.candidateTreeSha === preparedRequest.candidateTreeSha
    && Array.isArray(inputInventory.paths) && inputInventory.paths.length <= 100000
    && new Set(inputInventory.paths).size === inputInventory.paths.length
    && inputInventory.paths.every(filename => typeof filename === 'string' && filename && !/[\\:\x00-\x1f]/.test(filename)
      && !filename.startsWith('/') && filename.split('/').every(part => part && part !== '.' && part !== '..')), 'COMPLETE_PREPARED_FILE_INVENTORY_REQUIRED');
  // Do not silently use --offline-scan or disable Java analysis. An input the
  // Java analyzer would open needs the separately prepared Java DB, not a silent
  // network failure or reduced analysis. This candidate refuses that gap. The
  // list is exactly trivy v0.74.0 jar analyzer requiredExtensions (case-insensitive,
  // pkg/fanal/analyzer/language/java/jar/jar.go), the only javadb.NewClient caller;
  // a plain .zip is not opened by it and needs no Java DB.
  check(!inputInventory.paths.some(filename => /\.(jar|war|ear|par)$/i.test(filename)), 'JAVA_ARCHIVE_OFFLINE_DB_ROUTE_NOT_PREPARED');
  check(dbDecision?.status === 'READY' && usableDb(database, now) && dbDecision.db.sha256 === database.sha256, 'REAL_USABLE_OFFLINE_DB_REQUIRED');
  check(dbDecision.fallback === true ? now - time(database.metadata.UpdatedAt) <= 72 * 3600000 : time(database.metadata.NextUpdate) > now, 'OFFLINE_DB_FRESHNESS_CHANGED');
  validateChecksBundle(checksBundle, checksPin, now);
  const mounts = [[snapshotDirectory, '/repo'], [database.directory, '/scratch/db'], [checksBundle.directory, '/scratch/policy']];
  return Object.freeze({ contract: 'clued.independent-ci.required-trivy-plans/2', subject: subjectOf(job), image: IMAGE,
    sourceManifestSha256, workflowSha256, candidateTreeSha: preparedRequest.candidateTreeSha,
    cache: { dbSha256: database.sha256, metadataSha256: database.metadataSha256, fallback: dbDecision.fallback === true,
      checksDigest: checksPin.digest, checksMajorVersion: checksPin.majorVersion, checksContentSha256: checksPin.contentSha256 },
    scanners: Object.entries(SCANNERS).map(([scanner, argv]) => ({ scanner, image: IMAGE, executable: '/usr/local/bin/trivy', cwd: '/scratch',
      args: [...argv, '--cache-dir', '/scratch', '--skip-check-update', '--skip-version-check', '--disable-telemetry', '/repo'], mounts,
      network: 'none', rootfsReadOnly: true, user: '65532:65532', capDrop: ['ALL'], noNewPrivileges: true, limits: LIMITS,
      scratch: { target: '/scratch', bytes: 536870912, uid: 65532, noexec: true },
      mustObserve: ['real-exit-code', 'all-mounts-readonly', 'no-network', 'whole-container-cleanup'], actualScanObserved: false })),
    completion: 'all three exact scanners must be observed; any finding fails, unknown/timeout/cleanup unknown stays uncertain',
    sourceCandidateOnly: true, actualScansObserved: false, formalEligible: false });
}

// Reuse the frozen unsigned helper's concrete isolation argv and readback;
// no observation from this adapter is enrolled for signing or qualification.
export function scannerCreateArguments(plan, index, request, name) {
  const scan = plan.scanners[index]; check(scan && plan.image === IMAGE, 'FIXED_SCANNER_REQUIRED');
  return createArguments({ imageDigest: IMAGE, limits: scan.limits, env: ['TMPDIR=/scratch'] }, request, scan, name);
}
export function inspectScannerContainer(container, plan, index, request, name, imageId) {
  return inspectContainer(container, { imageDigest: IMAGE, limits: plan.scanners[index].limits, env: ['TMPDIR=/scratch'] }, request, plan.scanners[index], name, imageId);
}
