import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, digest } from '../../src/proof.mjs';
import { protectedPath } from '../qualification.mjs';
import { databaseDecision, databasePreparationPlan, cachePromotionPlan, inspectDatabase, inspectChecksBundle,
  checksPreparationPlan, validateChecksBundle } from '../required-trivy-v2/plans.mjs';
import { runCacheContainer, isActualDockerClient } from './docker.mjs';

// Generation 10 (resident DESIGN 53.11): the network may drop at any time.
//   - A DB or checks container that ended badly (timed out, cut off, its exit not readable) but whose removal was CONFIRMED could
//     only have written its own fresh staging directory (the only rw mount, /cache), which is never read unless the run succeeded:
//     it is a clean failed attempt, not UNCERTAIN. The DB then goes on to its next attempt and, when all four fail, to the existing
//     fallback to a current DB at most 72 hours old. Only a container whose removal is not confirmed stays UNCERTAIN (lock retained).
//   - A DB attempt is only started while the job still has DB_ATTEMPT_MS + SCAN_RESERVE_MS left (one attempt may take 310 s, the
//     scan 300 s); the attempts there is no time for are recorded as skipped and the same fallback rule decides.
//   - A prepare.lock left behind by an UNCERTAIN ending (DESIGN R6; 2026-11-05 it stopped every trivy run) is reclaimed when it is
//     provably stale: the pid it names is gone, no cache container exists, and everything in staging/ is a real directory of the
//     kinds' own shape. A durable receipt is written under reclaimed/ first. Anything not proven: the preparation waits (polling,
//     bounded) and then refuses cleanly (CACHE_PREPARATION_LOCK_BUSY, BLOCKED), never UNCERTAIN.
export const DB_ATTEMPT_MS = 310_000;
export const SCAN_RESERVE_MS = 420_000;
export const LOCK_POLL_MS = 15_000;
export const LOCK_WAIT_MS = 300_000;
export const STAGING_NAME = /^(?:db|checks)-[a-f0-9]{64}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The real probes of a stale lock (fixtureCachePort may replace them; actualCachePort never does).
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function cacheContainersNone(docker) {
  try {
    const r = await docker(['container', 'ls', '--all', '--no-trunc', '--filter', 'label=clued.verify.nonce', '--format', '{{.ID}}']);
    return r?.code === 0 && !r.timedOut && !r.error && typeof r.stdout === 'string' && r.stdout.trim() === '';
  } catch { return false; }
}

const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const actualStores = new WeakSet();
const safe = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && path.posix.normalize(value) === value && value !== '/';
const absent = async file => { try { await fs.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
async function durable(file, value) {
  const h = await fs.open(file, 'wx', 0o600); try { await h.writeFile(canonical(value)); await h.sync(); } finally { await h.close(); }
}
async function syncDirectory(directory) { const h = await fs.open(directory, 'r'); try { await h.sync(); } finally { await h.close(); } }
// The actual store supplies only its closed-over fixed filesystem operations.
// The explicit phase survives generic filesystem errors after pointer rename.
async function activatePointer({ next, originalPointer, readPointer, rename, syncRoot }) {
  let phase = 'POINTER_CAS_READ';
  try {
    const before = await readPointer(); check(before.sha256 === originalPointer.sha256, 'CACHE_POINTER_CAS_CHANGED');
    phase = 'POINTER_RENAME'; await rename();
    phase = 'POINTER_PARENT_FSYNC'; await syncRoot();
    phase = 'POINTER_READBACK'; const after = await readPointer();
    check(after.sha256 === digest(next), 'CACHE_POINTER_ACTIVATION_UNCONFIRMED'); return after;
  } catch (error) { error.activationPhase = phase; throw error; }
}
// Pure failure injection shares the exact rename/fsync/readback sequence. It
// never constructs or brands an actual store, and performs no filesystem I/O.
export const fixtureActivatePointer = operations => activatePointer(operations);
async function seal(directory) {
  const stat = await fs.lstat(directory); check(!stat.isSymbolicLink() && stat.isDirectory(), 'CACHE_STAGE_TYPE_UNKNOWN');
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), s = await fs.lstat(file);
    check(!s.isSymbolicLink() && (s.isDirectory() || s.isFile() && s.nlink === 1), 'CACHE_STAGE_LINK_REFUSED');
    if (s.isDirectory()) await seal(file); else { const h = await fs.open(file, 'r'); try { await h.sync(); } finally { await h.close(); }
      await fs.chown(file, 0, 0); await fs.chmod(file, 0o444); }
  }
  await fs.chown(directory, 0, 0); await fs.chmod(directory, 0o555); await syncDirectory(directory);
}

// Depth first, never following a link: a link is removed as itself (unlink), a real directory is entered.
async function removeCacheTree(directory) {
  const stat = await fs.lstat(directory); check(!stat.isSymbolicLink() && stat.isDirectory(), 'CACHE_RECLAIM_TYPE_REFUSED');
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), s = await fs.lstat(file);
    if (s.isDirectory() && !s.isSymbolicLink()) await removeCacheTree(file); else await fs.unlink(file);
  }
  await fs.rmdir(directory);
}
// Generation 10: what the lock left by another preparation says (null when there is none): its digest and inode, and the pid only when
// it is the shape lock() writes ({ pid, nonce }). Never follows a link; an odd file has no pid (never reclaimed).
export async function readLockState(root) {
  const file = path.join(root, 'prepare.lock');
  let stat; try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) return { file, pid: null, sha256: null, shape: false, ino: stat.ino };
  const bytes = await fs.readFile(file, 'utf8');
  let value = null; try { value = JSON.parse(bytes); } catch { value = null; }
  const shape = !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && Number.isSafeInteger(value.pid) && value.pid > 0 && /^[a-f0-9]{64}$/.test(value.nonce ?? '');
  return { file, pid: shape ? value.pid : null, sha256: digest({ bytes }), shape, ino: stat.ino };
}
// Everything directly below staging/: verifiable only when each entry is a real directory of the kinds' own shape.
export async function stagingLeftovers(root) {
  const dir = path.join(root, 'staging'), names = [];
  for (const entry of await fs.readdir(dir)) {
    const s = await fs.lstat(path.join(dir, entry));
    if (!STAGING_NAME.test(entry) || s.isSymbolicLink() || !s.isDirectory()) return { verifiable: false, names: [] };
    names.push(entry);
  }
  return { verifiable: true, names: names.sort() };
}
// A lock proven stale. Order (review of gen10, round 4):
//   1. the lock is claimed by one atomic rename into reclaimed/claim-<random>: of two preparations judging the same lock only one
//      rename succeeds; the claimed file must still be the bytes and inode that were judged (else it is put back, refused);
//   2. the receipt (durable, create-only): stagingToRemove names what is about to be removed;
//   3. the leftovers (never following a link); 4. a completion record names what was really removed (stagingRemoved).
// The lock is gone from prepare.lock at step 1, so a failure at 3 leaves no lock behind, only the receipt without its completion.
export async function reclaimStaleLock({ root, state, leftovers, proof, protect = dir => protectedPath(dir, { directory: true }), clock = Date.now, syncDir = syncDirectory }) {
  const dir = path.join(root, 'reclaimed'); if (await absent(dir)) await fs.mkdir(dir, { mode: 0o700 }); await protect(dir);
  const at = new Date(clock()).toISOString(), id = at.replace(/[:.]/g, '-') + '-' + randomBytes(8).toString('hex');
  const claim = path.join(dir, 'claim-' + id);
  await fs.rename(state.file, claim);
  const stat = await fs.lstat(claim), bytes = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096 ? await fs.readFile(claim, 'utf8') : null;
  if (bytes === null || digest({ bytes }) !== state.sha256 || stat.ino !== state.ino) {
    await fs.rename(claim, state.file).catch(() => {});
    check(false, 'CACHE_LOCK_CHANGED_WHILE_RECLAIMED');
  }
  await syncDir(root); await syncDir(dir);
  const receipt = { contract: 'clued.independent-ci.trivy-cache-lock-reclaimed/1', at, lockSha256: state.sha256, lockPid: state.pid, claim: path.basename(claim),
    stagingToRemove: leftovers.names, proof };
  const file = path.join(dir, 'lock-' + id + '.json');
  await durable(file, receipt); await syncDir(dir);
  const removed = [];
  for (const name of leftovers.names) { check(STAGING_NAME.test(name), 'CACHE_RECLAIM_NAME_REFUSED'); await removeCacheTree(path.join(root, 'staging', name)); removed.push(name); }
  await durable(path.join(dir, 'lock-' + id + '.done.json'), { contract: 'clued.independent-ci.trivy-cache-lock-reclaimed-done/1', receipt: path.basename(file), stagingRemoved: removed, at: new Date(clock()).toISOString() });
  await syncDir(dir);
  return { ...receipt, stagingRemoved: removed, receipt: path.basename(file) };
}

// Reclaim after a confirmed promotion (resident Task 4aedda54, DESIGN §35): every promotion left its staging copy and a new
// generation behind and nothing was ever removed (about +3.3 GB per DB rotation). Now, once the pointer readback confirmed
// the activation, the kind's staging copies (this promotion's and any earlier leftover; the prepare lock is held, so no
// other preparation of this root can be using one) and every generation of the kind other than the current and the
// previous one are removed. Only names of the kind's own shape directly below staging/ and generations/ are touched; the
// other kind is never touched; a failure here never fails or undoes the promotion (it is reported; the next one retries).
export async function reclaimCache({ root, kind, currentDirectory, previousDirectory = null, removeTree = removeCacheTree }) {
  check(['db', 'checks'].includes(kind) && typeof root === 'string' && typeof currentDirectory === 'string'
    && path.dirname(currentDirectory) === path.join(root, 'generations')
    && (previousDirectory === null || path.dirname(previousDirectory) === path.join(root, 'generations')), 'CACHE_RECLAIM_SCOPE');
  const stagingName = new RegExp('^' + kind + '-[a-f0-9]{64}$'), generationName = new RegExp('^gen-' + kind + '-[a-f0-9]{64}$');
  const kept = [currentDirectory, previousDirectory].filter(Boolean).map(d => path.basename(d));
  check(kept.every(name => generationName.test(name)), 'CACHE_RECLAIM_SCOPE');
  const removed = { staging: [], generations: [] }, failed = [];
  for (const [sub, pattern, list] of [['staging', stagingName, removed.staging], ['generations', generationName, removed.generations]]) {
    for (const name of (await fs.readdir(path.join(root, sub))).sort()) {
      if (!pattern.test(name) || kept.includes(name)) continue;
      try { await removeTree(path.join(root, sub, name)); list.push(name); } catch (error) { failed.push({ name, code: error?.code ?? 'CACHE_RECLAIM_UNCONFIRMED' }); }
    }
  }
  return { ok: failed.length === 0, kept: [...new Set(kept)].sort(), removed, failed };
}

// Actual storage has no caller-supplied filesystem operations. Every new stage
// is exclusive and under the one protected Source-bound cache root.
export async function createActualStorage(root) {
  check(safe(root), 'FIXED_CACHE_ROOT_REQUIRED'); await protectedPath(root, { directory: true });
  for (const name of ['staging', 'generations']) {
    const dir = path.join(root, name); if (await absent(dir)) await fs.mkdir(dir, { mode: 0o700 }); await protectedPath(dir, { directory: true });
  }
  const empty = path.join(root, 'empty'); if (await absent(empty)) await fs.mkdir(empty, { mode: 0o555 });
  await protectedPath(empty, { directory: true }); check((await fs.readdir(empty)).length === 0, 'CHECKS_INPUT_NOT_EMPTY');
  let lock = null;
  async function readPointer(kind) {
    const file = path.join(root, kind === 'db' ? 'current.json' : 'checks-current.json');
    if (await absent(file)) return { file, value: null, sha256: null };
    await protectedPath(file, { privateFile: true }); const bytes = await fs.readFile(file, 'utf8'); check(bytes.length <= 65536, 'CACHE_POINTER_BOUND');
    const value = JSON.parse(bytes);
    check(safe(value.directory) && path.dirname(value.directory) === path.join(root, 'generations') && new RegExp('^gen-' + kind + '-[a-f0-9]{64}$').test(path.basename(value.directory)), 'CACHE_GENERATION_SCOPE_CHANGED');
    await protectedPath(value.directory, { directory: true }); return { file, value, sha256: digest(value) };
  }
  const storage = {
    fixture: false, empty,
    async lock() { check(!lock, 'CACHE_PREPARATION_ALREADY_OPEN'); const file = path.join(root, 'prepare.lock'), handle = await fs.open(file, 'wx', 0o600);
      // A lock whose bytes did not reach the disk is removed again: a failed write must not leave a stale
      // prepare.lock that refuses every later preparation (prepare() never set `acquired` for it). Should the
      // unlink fail too, the lock stays and later preparations refuse cleanly with EEXIST (fail closed).
      try { await handle.writeFile(canonical({ pid: process.pid, nonce: randomBytes(32).toString('hex') })); await handle.sync(); }
      catch (error) { await handle.close().catch(() => {}); await fs.unlink(file).catch(() => {}); throw error; }
      lock = handle; },
    async unlock(retain) { if (lock) { await lock.close(); lock = null; if (!retain) await fs.unlink(path.join(root, 'prepare.lock')); } },
    // Generation 10 (readLockState, stagingLeftovers, reclaimStaleLock below).
    lockState: () => readLockState(root),
    stagingLeftovers: () => stagingLeftovers(root),
    reclaimLock: ({ state, leftovers, proof }) => reclaimStaleLock({ root, state, leftovers, proof }),
    async current(kind) {
      const pointer = await readPointer(kind);
      if (!pointer.value) return { pointer, facts: kind === 'db' ? { exists: false, complete: false } : null };
      const facts = kind === 'db' ? await inspectDatabase(pointer.value.directory) : await inspectChecksBundle(pointer.value.directory);
      if (kind === 'db') check(facts.sha256 === pointer.value.dbSha256 && facts.metadataSha256 === pointer.value.dbMetadataSha256, 'CURRENT_DB_PIN_CHANGED');
      else check(facts.contentSha256 === pointer.value.contentSha256 && facts.metadataSha256 === pointer.value.metadataSha256, 'CURRENT_CHECKS_PIN_CHANGED');
      return { pointer, facts };
    },
    async stage(kind) {
      const directory = path.join(root, 'staging', kind + '-' + randomBytes(32).toString('hex'));
      await fs.mkdir(directory, { mode: 0o700 }); await fs.chown(directory, 65532, 65532); return directory;
    },
    inspect(kind, directory) { return kind === 'db' ? inspectDatabase(directory) : inspectChecksBundle(directory); },
    async promote(kind, stage, facts, originalPointer, decision) {
      check(path.dirname(stage) === path.join(root, 'staging') && new RegExp('^' + kind + '-[a-f0-9]{64}$').test(path.basename(stage)), 'STAGING_ACTIVATION_SCOPE');
      const directory = path.join(root, 'generations', 'gen-' + path.basename(stage)); await fs.mkdir(directory, { mode: 0o700 });
      // Copy only the data subtree; no scanner-created fanal cache or arbitrary
      // staging files can become the trusted active generation.
      const subtree = kind === 'db' ? 'db' : 'policy';
      await fs.cp(path.join(stage, subtree), path.join(directory, subtree), { recursive: true, dereference: false, errorOnExist: true, force: false });
      await seal(directory); const fresh = await (kind === 'db' ? inspectDatabase(directory) : inspectChecksBundle(directory));
      check(kind === 'db' ? fresh.sha256 === facts.sha256 && fresh.metadataSha256 === facts.metadataSha256
        : fresh.contentSha256 === facts.contentSha256 && fresh.metadataSha256 === facts.metadataSha256, 'CACHE_GENERATION_BYTES_CHANGED');
      const activation = kind === 'db' ? cachePromotionPlan({ decision, generationDirectory: directory, currentPointerFile: originalPointer.file,
        expectedCurrentPointerSha256: originalPointer.sha256, currentPointer: originalPointer.value }) : null;
      const next = activation?.nextPointer ?? { contract: 'clued.independent-ci.trivy-checks-generation/1', directory,
        contentSha256: fresh.contentSha256, metadataSha256: fresh.metadataSha256, digest: fresh.metadata.Digest, activatedAt: new Date().toISOString() };
      const nextFile = originalPointer.file + '.next-' + randomBytes(32).toString('hex'); await durable(nextFile, next); await syncDirectory(directory);
      const after = await activatePointer({ next, originalPointer, readPointer: () => readPointer(kind),
        rename: () => fs.rename(nextFile, originalPointer.file), syncRoot: () => syncDirectory(root) });
      // Only after the activation is confirmed: the current and the previous generation stay, the rest of the kind goes.
      const reclaimed = await reclaimCache({ root, kind, currentDirectory: directory, previousDirectory: originalPointer.value?.directory ?? null })
        .catch(error => ({ ok: false, code: error?.code ?? 'CACHE_RECLAIM_UNCONFIRMED' }));
      return { facts: fresh, pointerSha256: after.sha256, activationSha256: digest({ previous: originalPointer.sha256, next: after.sha256, kind }), previousGenerationRetained: true,
        reclaimed };
    },
  };
  // Frozen before it is branded (review of gen10, round 5): no caller can replace a method of the actual store (its lock handle lives in
  // the closure, so lock()/unlock() keep working).
  Object.freeze(storage); actualStores.add(storage); return storage;
}

// Generation 10: take the lock; a stale one (pid gone, no cache container, staging verifiable) is reclaimed with a receipt, anything
// else is waited for (bounded) and then refused cleanly. Returns the reclaim receipt or null.
async function acquireLock({ storage, docker, deadline, signal, hooks }) {
  const alive = hooks.pidAlive ?? pidAlive, containersNone = hooks.containersNone ?? cacheContainersNone, wait = hooks.sleep ?? sleep, now = hooks.now ?? Date.now;
  const until = Math.min(now() + LOCK_WAIT_MS, deadline - DB_ATTEMPT_MS - SCAN_RESERVE_MS);
  let reclaimed = null;
  for (;;) {
    try { await storage.lock(); return reclaimed; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const state = await storage.lockState();
    // Released between the two steps: take it now instead of waiting a poll (review of gen10, round 4).
    if (state === null) { check(!signal?.aborted && now() < until, 'CACHE_PREPARATION_LOCK_BUSY'); continue; }
    if (state && !reclaimed && state.shape && state.pid !== process.pid && !alive(state.pid) && await containersNone(docker)) {
      const leftovers = await storage.stagingLeftovers();
      if (leftovers.verifiable) {
        // Another preparation claimed it first (its rename won, ours finds no lock): not an error, just try the lock again.
        try { reclaimed = await storage.reclaimLock({ state, leftovers, proof: { pidGone: true, cacheContainers: 0, stagingVerifiable: true } }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
    }
    check(!signal?.aborted && now() + LOCK_POLL_MS < until, 'CACHE_PREPARATION_LOCK_BUSY');
    await wait(LOCK_POLL_MS);
  }
}

async function prepare({ storage, docker, dockerRootDirectory, checksPin, deadline, signal, fixture, hooks = {} }) {
  let retain = false, acquired = false, activationMayHaveStarted = false, phase = 'PREPARATION', lockReclaimed = null; const observations = [];
  const runContainer = hooks.runContainer ?? runCacheContainer, now = hooks.now ?? Date.now;
  try {
    validateChecksBundleShape(checksPin); lockReclaimed = await acquireLock({ storage, docker, deadline, signal, hooks }); acquired = true;
    const existingDb = await storage.current('db'), current = existingDb.facts;
    let decision = databaseDecision({ current }), activeDb = current, dbActivation = null;
    const attempts = [];
    while (decision.status === 'PREPARE_REQUIRED') {
      check(!signal?.aborted, 'CACHE_AUTHORITY_EXPIRED');
      // No time for another attempt and the scan after it: the rest are skipped and the fallback rule decides (generation 10).
      if (deadline - now() < DB_ATTEMPT_MS + SCAN_RESERVE_MS) {
        attempts.push({ ...decision.nextAttempt, outcome: 'failure', cleanupConfirmed: true, skipped: 'NO_TIME_LEFT' });
        decision = databaseDecision({ current, attempts });
        continue;
      }
      const stage = await storage.stage('db'), plan = databasePreparationPlan({ stagingDirectory: stage, current: { exists: false } });
      const spec = { ...plan.attempts[attempts.length], image: plan.image, executable: plan.executable };
      const run = await runContainer({ spec, docker, dockerRootDirectory, deadline, signal }); observations.push(run);
      if (!run.cleanupConfirmed) { retain = run.touched; return { status: retain ? 'UNCERTAIN' : 'BLOCKED',
        reason: run.touched ? 'DB_EXECUTION_OR_CLEANUP_UNKNOWN' : run.reason, observations, lockReclaimed, fixture, publicationAuthorized: false }; }
      // Generation 10: the container is gone; whatever made the run unknown (a timeout, a cut connection) left only its own staging copy.
      const outcome = run.outcome === 'success' ? 'success' : 'failure';
      const facts = outcome === 'success' ? await storage.inspect('db', stage) : null;
      attempts.push({ repository: spec.repository, attempt: spec.attempt, outcome, cleanupConfirmed: true, ...(run.outcome === 'unknown' ? { reason: run.reason ?? 'CACHE_EXECUTION_UNKNOWN' } : {}), ...(facts ? { db: facts } : {}) });
      decision = databaseDecision({ current, attempts });
      if (decision.status === 'READY' && decision.source === 'staging') {
        check(Date.now() < deadline && !signal?.aborted, 'CACHE_AUTHORITY_EXPIRED');
        phase = 'DB_ACTIVATION'; activationMayHaveStarted = true;
        dbActivation = await storage.promote('db', stage, facts, existingDb.pointer, decision);
        // Actual promote resolves only after pointer rename, parent fsync and
        // protected readback. Any throw before this line retains the lock.
        activationMayHaveStarted = false; phase = 'DB_ACTIVATED'; activeDb = dbActivation.facts;
      }
    }
    check(decision.status === 'READY', decision.reason ?? 'OFFLINE_DB_UNAVAILABLE');
    const existingChecks = await storage.current('checks'); let activeChecks = existingChecks.facts, checksActivation = null;
    try { validateChecksBundle(activeChecks, checksPin); }
    catch {
      check(Date.now() < deadline && !signal?.aborted, 'CACHE_AUTHORITY_EXPIRED');
      const stage = await storage.stage('checks'), spec = checksPreparationPlan({ stagingDirectory: stage, emptyDirectory: storage.empty, checksPin });
      check(!spec.status, 'REAL_CHECKS_PIN_MISSING');
      const run = await runContainer({ spec, docker, dockerRootDirectory, deadline, signal }); observations.push(run);
      if (!run.cleanupConfirmed) { retain = run.touched; return { status: retain ? 'UNCERTAIN' : 'BLOCKED',
        reason: run.touched ? 'CHECKS_EXECUTION_OR_CLEANUP_UNKNOWN' : run.reason, observations, lockReclaimed, fixture, publicationAuthorized: false }; }
      // Generation 10: removal confirmed: a clean failure (BLOCKED, lock released), whatever made the run unknown.
      check(run.outcome === 'success', 'PINNED_CHECKS_DOWNLOAD_FAILED');
      const facts = await storage.inspect('checks', stage); validateChecksBundle(facts, checksPin);
      check(Date.now() < deadline && !signal?.aborted, 'CACHE_AUTHORITY_EXPIRED');
      phase = 'CHECKS_ACTIVATION'; activationMayHaveStarted = true;
      checksActivation = await storage.promote('checks', stage, facts, existingChecks.pointer);
      activationMayHaveStarted = false; phase = 'CHECKS_ACTIVATED'; activeChecks = checksActivation.facts;
    }
    return { status: 'READY', fixture, database: activeDb, dbDecision: { ...decision, db: activeDb }, checksBundle: activeChecks,
      dbActivation, checksActivation, observations, lockReclaimed, provenanceSha256: digest({ database: activeDb, checks: activeChecks,
        dbActivation, checksActivation, observations }), publicationAuthorized: false, qualificationIssued: false };
  } catch (error) {
    // Phase determines possible activation, including generic EIO/EACCES/ENOENT
    // from rename, fsync or readback. Error names cannot establish rollback.
    retain ||= activationMayHaveStarted;
    if (activationMayHaveStarted && error.activationPhase) phase += ':' + error.activationPhase;
    return { status: retain ? 'UNCERTAIN' : 'BLOCKED', reason: error.code ?? 'CACHE_PREPARATION_UNCONFIRMED', phase,
      activationMayHaveStarted, observations, lockReclaimed, fixture, publicationAuthorized: false };
  } finally { if (acquired) await storage.unlock(retain); }
}
function validateChecksBundleShape(pin) {
  check(pin?.repository === 'ghcr.io/aquasecurity/trivy-checks:2' && /^sha256:[a-f0-9]{64}$/.test(pin.digest ?? '')
    && pin.majorVersion === 2 && /^[a-f0-9]{64}$/.test(pin.contentSha256 ?? ''), 'REAL_CHECKS_BUNDLE_PIN_REQUIRED');
}
const boundedContext = context => { check(context && Object.keys(context).every(key => ['deadline', 'signal'].includes(key)) && Number.isFinite(context.deadline), 'FIXED_CACHE_CONTEXT_REQUIRED'); return context; };
// The actual port takes its four inputs once, at construction, into a frozen copy: a later change to the caller's options object (a
// hook, another storage or docker client) never reaches prepare (review of gen10, round 4). Test hooks are refused outright.
export function actualCachePort(options) {
  check(options?.hooks === undefined, 'ACTUAL_CACHE_HOOKS_REFUSED');
  check(actualStores.has(options.storage) && isActualDockerClient(options.docker), 'ACTUAL_PROTECTED_CACHE_TRANSPORT_REQUIRED');
  const fixed = Object.freeze({ storage: options.storage, docker: options.docker, dockerRootDirectory: options.dockerRootDirectory, checksPin: structuredClone(options.checksPin) });
  return Object.freeze({ fixture: false, prepare: context => prepare({ ...fixed, ...boundedContext(context), fixture: false, hooks: {} }) });
}
export function fixtureCachePort(options) { return Object.freeze({ fixture: true, prepare: context => prepare({ ...options, ...boundedContext(context), fixture: true }) }); }
