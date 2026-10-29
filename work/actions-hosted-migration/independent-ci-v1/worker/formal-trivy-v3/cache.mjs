import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, digest } from '../../src/proof.mjs';
import { protectedPath } from '../qualification.mjs';
import { databaseDecision, databasePreparationPlan, cachePromotionPlan, inspectDatabase, inspectChecksBundle,
  checksPreparationPlan, validateChecksBundle } from '../required-trivy-v2/plans.mjs';
import { runCacheContainer, isActualDockerClient } from './docker.mjs';

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
// Reclaim after a confirmed promotion (resident Task 4aedda54, DESIGN §34): every promotion left its staging copy and a new
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
  actualStores.add(storage); return storage;
}

async function prepare({ storage, docker, dockerRootDirectory, checksPin, deadline, signal, fixture }) {
  let retain = false, acquired = false, activationMayHaveStarted = false, phase = 'PREPARATION'; const observations = [];
  try {
    validateChecksBundleShape(checksPin); await storage.lock(); acquired = true;
    const existingDb = await storage.current('db'), current = existingDb.facts;
    let decision = databaseDecision({ current }), activeDb = current, dbActivation = null;
    const attempts = [];
    while (decision.status === 'PREPARE_REQUIRED') {
      check(Date.now() < deadline && !signal?.aborted, 'CACHE_AUTHORITY_EXPIRED');
      const stage = await storage.stage('db'), plan = databasePreparationPlan({ stagingDirectory: stage, current: { exists: false } });
      const spec = { ...plan.attempts[attempts.length], image: plan.image, executable: plan.executable };
      const run = await runCacheContainer({ spec, docker, dockerRootDirectory, deadline, signal }); observations.push(run);
      if (run.outcome === 'unknown' || !run.cleanupConfirmed) { retain = run.touched; return { status: retain ? 'UNCERTAIN' : 'BLOCKED',
        reason: run.touched ? 'DB_EXECUTION_OR_CLEANUP_UNKNOWN' : run.reason, observations, fixture, publicationAuthorized: false }; }
      const facts = run.outcome === 'success' ? await storage.inspect('db', stage) : null;
      attempts.push({ repository: spec.repository, attempt: spec.attempt, outcome: run.outcome, cleanupConfirmed: run.cleanupConfirmed, ...(facts ? { db: facts } : {}) });
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
      const run = await runCacheContainer({ spec, docker, dockerRootDirectory, deadline, signal }); observations.push(run);
      if (run.outcome === 'unknown' || !run.cleanupConfirmed) { retain = run.touched; return { status: retain ? 'UNCERTAIN' : 'BLOCKED',
        reason: run.touched ? 'CHECKS_EXECUTION_OR_CLEANUP_UNKNOWN' : run.reason, observations, fixture, publicationAuthorized: false }; }
      check(run.outcome === 'success', 'PINNED_CHECKS_DOWNLOAD_FAILED');
      const facts = await storage.inspect('checks', stage); validateChecksBundle(facts, checksPin);
      check(Date.now() < deadline && !signal?.aborted, 'CACHE_AUTHORITY_EXPIRED');
      phase = 'CHECKS_ACTIVATION'; activationMayHaveStarted = true;
      checksActivation = await storage.promote('checks', stage, facts, existingChecks.pointer);
      activationMayHaveStarted = false; phase = 'CHECKS_ACTIVATED'; activeChecks = checksActivation.facts;
    }
    return { status: 'READY', fixture, database: activeDb, dbDecision: { ...decision, db: activeDb }, checksBundle: activeChecks,
      dbActivation, checksActivation, observations, provenanceSha256: digest({ database: activeDb, checks: activeChecks,
        dbActivation, checksActivation, observations }), publicationAuthorized: false, qualificationIssued: false };
  } catch (error) {
    // Phase determines possible activation, including generic EIO/EACCES/ENOENT
    // from rename, fsync or readback. Error names cannot establish rollback.
    retain ||= activationMayHaveStarted;
    if (activationMayHaveStarted && error.activationPhase) phase += ':' + error.activationPhase;
    return { status: retain ? 'UNCERTAIN' : 'BLOCKED', reason: error.code ?? 'CACHE_PREPARATION_UNCONFIRMED', phase,
      activationMayHaveStarted, observations, fixture, publicationAuthorized: false };
  } finally { if (acquired) await storage.unlock(retain); }
}
function validateChecksBundleShape(pin) {
  check(pin?.repository === 'ghcr.io/aquasecurity/trivy-checks:2' && /^sha256:[a-f0-9]{64}$/.test(pin.digest ?? '')
    && pin.majorVersion === 2 && /^[a-f0-9]{64}$/.test(pin.contentSha256 ?? ''), 'REAL_CHECKS_BUNDLE_PIN_REQUIRED');
}
const boundedContext = context => { check(context && Object.keys(context).every(key => ['deadline', 'signal'].includes(key)) && Number.isFinite(context.deadline), 'FIXED_CACHE_CONTEXT_REQUIRED'); return context; };
export function actualCachePort(options) {
  check(actualStores.has(options.storage) && isActualDockerClient(options.docker), 'ACTUAL_PROTECTED_CACHE_TRANSPORT_REQUIRED');
  return Object.freeze({ fixture: false, prepare: context => prepare({ ...options, ...boundedContext(context), fixture: false }) });
}
export function fixtureCachePort(options) { return Object.freeze({ fixture: true, prepare: context => prepare({ ...options, ...boundedContext(context), fixture: true }) }); }
