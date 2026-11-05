// Generation 10 (resident DESIGN 53.11): a trivy DB or checks download cut off by the network, and a prepare.lock left behind by an
// UNCERTAIN ending, no longer end a stage UNCERTAIN or refuse every later preparation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DB_ATTEMPT_MS, LOCK_POLL_MS, LOCK_WAIT_MS, SCAN_RESERVE_MS, STAGING_NAME, actualCachePort, fixtureCachePort } from '../worker/formal-trivy-v3/cache.mjs';
import { DB_REPOSITORIES } from '../worker/required-trivy-v2/plans.mjs';

const H = s => createHash('sha256').update(s).digest('hex');
const HOUR = 3_600_000;
const db = (updatedAgoMs, nextInMs) => ({ exists: true, complete: true, directory: '/cache/gen/db', bytes: 10, sha256: H('db' + updatedAgoMs), metadataSha256: H('m' + updatedAgoMs),
  metadata: { Version: 2, UpdatedAt: new Date(Date.now() - updatedAgoMs).toISOString(), NextUpdate: new Date(Date.now() + nextInMs).toISOString() } });
const CHECKS_PIN = { repository: 'ghcr.io/aquasecurity/trivy-checks:2', digest: 'sha256:' + 'c'.repeat(64), majorVersion: 2, contentSha256: 'd'.repeat(64) };
// A checks bundle the real validateChecksBundle accepts: the checks step then runs nothing.
const CHECKS_OK = () => ({ complete: true, metadata: { Digest: CHECKS_PIN.digest, MajorVersion: 2, DownloadedAt: new Date(Date.now() - HOUR).toISOString() },
  contentSha256: CHECKS_PIN.contentSha256, metadataSha256: H('cm'), files: [{ path: 'policy/a.rego' }] });

// An in-memory store with the actual store's lock behaviour (create-only; EEXIST while held), and a checks bundle that is already valid
// unless told otherwise (validateChecksBundle is the real one: the fixture returns facts it accepts by throwing nothing).
function store({ current, lockHeldBy = null, staging = [] } = {}) {
  const s = { lockFile: lockHeldBy === null ? null : { pid: lockHeldBy, sha256: H('lock' + lockHeldBy), ino: 7, shape: Number.isSafeInteger(lockHeldBy) },
    held: false, released: [], staging: [...staging], reclaims: [], promoted: [], fixture: true, empty: '/cache/empty', checksFacts: CHECKS_OK() };
  Object.assign(s, {
    async lock() { if (s.lockFile || s.held) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); s.held = true; s.lockFile = { pid: process.pid, sha256: H('mine'), ino: 9, shape: true }; },
    async unlock(retain) { s.held = false; s.released.push(retain); if (!retain) s.lockFile = null; },
    async lockState() { return s.lockFile ? { file: '/cache/prepare.lock', ...s.lockFile } : null; },
    async stagingLeftovers() { return s.staging.every(n => STAGING_NAME.test(n)) ? { verifiable: true, names: [...s.staging].sort() } : { verifiable: false, names: [] }; },
    async reclaimLock({ state, leftovers, proof }) { s.reclaims.push({ state, leftovers, proof }); s.staging = []; s.lockFile = null; return { contract: 'clued.independent-ci.trivy-cache-lock-reclaimed/1', lockPid: state.pid, stagingRemoved: leftovers.names, proof, receipt: 'lock-x.json' }; },
    async current(kind) { return kind === 'db' ? { pointer: { file: '/cache/current.json', value: null, sha256: null }, facts: current ?? { exists: false, complete: false } }
      : { pointer: { file: '/cache/checks-current.json', value: null, sha256: null }, facts: s.checksFacts ?? null }; },
    async stage(kind) { const d = `/cache/staging/${kind}-${H(String(Math.random()))}`; s.staging.push(d.split('/').pop()); return d; },
    async inspect(kind) { return kind === 'db' ? db(0, 6 * HOUR) : s.checksFacts; },
    async promote(kind, stage, facts) { s.promoted.push(kind); return { facts }; },
  });
  return s;
}
// A container runner that answers a fixed list of outcomes in order.
const runs = list => { const seen = []; const fn = async ({ spec }) => { seen.push(spec.repository ?? 'checks'); const r = list.shift(); return { touched: true, observationSha256: H(String(seen.length)), ...r }; }; fn.seen = seen; return fn; };
const cut = { outcome: 'unknown', reason: 'CACHE_TIMEOUT', cleanupConfirmed: true };        // the network dropped; the container was removed
const lost = { outcome: 'unknown', reason: 'CACHE_EXIT_UNKNOWN', cleanupConfirmed: false }; // removal not confirmed
const fail = { outcome: 'failure', reason: null, cleanupConfirmed: true };
const ok = { outcome: 'success', reason: null, cleanupConfirmed: true };
const port = (storage, hooks) => fixtureCachePort({ storage, docker: async () => ({ code: 0, stdout: '' }), dockerRootDirectory: '/var/lib/docker', checksPin: CHECKS_PIN, hooks });
const prepareWith = (s, hooks, deadline = Date.now() + 25 * 60_000) => port(s, { pidAlive: () => false, containersNone: async () => true, sleep: async () => {}, ...hooks }).prepare({ deadline });

test('constants: one DB attempt plus the scan must fit; the lock wait is bounded', () => {
  assert.deepEqual([DB_ATTEMPT_MS, SCAN_RESERVE_MS, LOCK_POLL_MS, LOCK_WAIT_MS], [310_000, 420_000, 15_000, 300_000]);
  assert.equal(STAGING_NAME.test('db-' + 'a'.repeat(64)) && STAGING_NAME.test('checks-' + 'b'.repeat(64)) && !STAGING_NAME.test('db-x') && !STAGING_NAME.test('../db-' + 'a'.repeat(64)), true);
});

test('a DB download cut off by the network (removal confirmed) is a clean failed attempt; four of them fall back to a DB at most 72 h old', async () => {
  const s = store({ current: db(30 * HOUR, -1) });
  const runContainer = runs([cut, cut, fail, cut]);
  const r = await prepareWith(s, { runContainer });
  assert.deepEqual(runContainer.seen, DB_REPOSITORIES.flatMap(x => [x, x]), 'all four attempts, in order');
  assert.deepEqual([r.status, r.dbDecision.source, r.dbDecision.fallback, r.dbDecision.warning], ['READY', 'current', true, 'ALL_FOUR_DB_DOWNLOADS_FAILED_USING_AT_MOST_72H_OLD_DB'], JSON.stringify(r));
  assert.deepEqual(s.released, [false], 'the lock is released, never retained');
});

test('the DB decision itself: cut-off attempts lead to the 72-hour fallback (READY), a too-old DB is a clean BLOCKED, never UNCERTAIN', async () => {
  for (const [current, want] of [[db(30 * HOUR, -1), 'fallback'], [db(80 * HOUR, -1), 'DB_MISSING_OR_OVER_72H_OLD'], [{ exists: false, complete: false }, 'DB_MISSING_OR_OVER_72H_OLD']]) {
    const s = store({ current });
    const r = await prepareWith(s, { runContainer: runs([cut, fail, cut, cut]) });
    if (want === 'fallback') assert.deepEqual([r.status, r.dbDecision.fallback], ['READY', true], JSON.stringify(r));
    else assert.deepEqual([r.status, r.reason], ['BLOCKED', want], JSON.stringify(r));
    assert.deepEqual(s.released, [false]);
  }
});

test('only a container whose removal is NOT confirmed keeps the old UNCERTAIN (lock retained)', async () => {
  const s = store({ current: db(30 * HOUR, -1) });
  const r = await prepareWith(s, { runContainer: runs([cut, lost]) });
  assert.deepEqual([r.status, r.reason, s.released], ['UNCERTAIN', 'DB_EXECUTION_OR_CLEANUP_UNKNOWN', [true]]);
});

test('a fresh current DB is used without any download (no container at all)', async () => {
  const s = store({ current: db(2 * HOUR, 4 * HOUR) });
  const runContainer = runs([]);
  const r = await prepareWith(s, { runContainer });
  assert.equal(runContainer.seen.length, 0, 'no download at all');
  assert.deepEqual([r.status, r.dbDecision.source, r.dbDecision.download], ['READY', 'current', false]);
});

test('no time left for another attempt and the scan: the rest are skipped and the fallback decides', async () => {
  const s = store({ current: db(30 * HOUR, -1) });
  const runContainer = runs([cut, cut, cut, cut]);
  let clock = Date.now();
  const deadline = clock + DB_ATTEMPT_MS + SCAN_RESERVE_MS - 1000;
  const r = await prepareWith(s, { runContainer: async a => { clock += 2000; return runContainer(a); }, now: () => clock }, deadline);
  assert.equal(runContainer.seen.length, 0, 'no attempt fits beside the scan reserve');
  assert.deepEqual([r.status, r.dbDecision.fallback], ['READY', true], JSON.stringify(r));
  // with room for exactly one attempt
  const s2 = store({ current: db(30 * HOUR, -1) });
  const one = runs([cut]);
  let c2 = Date.now();
  const r2 = await prepareWith(s2, { runContainer: async a => { c2 += DB_ATTEMPT_MS; return one(a); }, now: () => c2 }, c2 + DB_ATTEMPT_MS + SCAN_RESERVE_MS + 1000);
  assert.deepEqual([one.seen.length, r2.status, r2.dbDecision.fallback], [1, 'READY', true]);
});

test('a stale prepare.lock (pid gone, no cache container, staging verifiable) is reclaimed with a receipt, then the preparation runs', async () => {
  const leftover = 'db-' + 'e'.repeat(64);
  const s = store({ current: db(2 * HOUR, 4 * HOUR), lockHeldBy: 236590, staging: [leftover] });
  const r = await prepareWith(s, { runContainer: runs([]) });
  assert.equal(s.reclaims.length, 1);
  assert.deepEqual([s.reclaims[0].state.pid, s.reclaims[0].leftovers.names, s.reclaims[0].proof], [236590, [leftover], { pidGone: true, cacheContainers: 0, stagingVerifiable: true }]);
  assert.equal(r.lockReclaimed.receipt, 'lock-x.json');
  assert.equal(r.status, 'READY');
  assert.deepEqual(s.released, [false]);
});

test('a lock that is not provably stale is waited for (bounded) and then refused cleanly, never reclaimed, never UNCERTAIN', async () => {
  for (const [label, s, hooks] of [
    ['pid alive', store({ lockHeldBy: 4242 }), { pidAlive: () => true }],
    ['a cache container exists', store({ lockHeldBy: 4242 }), { containersNone: async () => false }],
    ['staging not verifiable', store({ lockHeldBy: 4242, staging: ['db-' + 'e'.repeat(64), 'evil-link'] }), {}],
    ['lock of an unknown shape', store({ lockHeldBy: 'x' }), {}]]) {
    let clock = Date.now(); const sleeps = [];
    const r = await prepareWith(s, { ...hooks, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, runContainer: runs([]) });
    assert.deepEqual([r.status, r.reason], ['BLOCKED', 'CACHE_PREPARATION_LOCK_BUSY'], label);
    assert.equal(s.reclaims.length, 0, label);
    assert.ok(sleeps.length >= 1 && sleeps.length * LOCK_POLL_MS <= LOCK_WAIT_MS, `${label}: ${sleeps.length}`);
    assert.deepEqual(s.released, [], `${label}: a lock it never took is never released`);
  }
  // the holder finishes while we wait: the lock is taken normally
  const s = store({ lockHeldBy: 4242, current: db(2 * HOUR, 4 * HOUR) });
  let polls = 0;
  const r = await prepareWith(s, { pidAlive: () => true, sleep: async () => { if (++polls === 2) s.lockFile = null; }, runContainer: runs([]) });
  assert.notEqual(r.reason, 'CACHE_PREPARATION_LOCK_BUSY');
  assert.deepEqual([s.reclaims.length, polls], [0, 2]);
});

test('the actual port refuses test hooks before anything else, and keeps a frozen copy of its inputs', async () => {
  assert.throws(() => actualCachePort({ storage: {}, docker: () => {}, hooks: {} }), { code: 'ACTUAL_CACHE_HOOKS_REFUSED' });
  assert.throws(() => actualCachePort({ storage: {}, docker: () => {} }), { code: 'ACTUAL_PROTECTED_CACHE_TRANSPORT_REQUIRED' });
  const text = await (await import('node:fs/promises')).readFile(new URL('../worker/formal-trivy-v3/cache.mjs', import.meta.url), 'utf8');
  const port = text.slice(text.indexOf('export function actualCachePort'), text.indexOf('export function fixtureCachePort'));
  assert.match(port, /const fixed = Object\.freeze\(\{ storage: options\.storage, docker: options\.docker, dockerRootDirectory: options\.dockerRootDirectory, checksPin: structuredClone\(options\.checksPin\) \}\);/);
  assert.match(port, /prepare\(\{ \.\.\.fixed, \.\.\.boundedContext\(context\), fixture: false, hooks: \{\} \}\)/);
  assert.doesNotMatch(port, /\.\.\.options/, 'options is never spread again after construction');
});

test('a lock released between EEXIST and the read is taken at once, without a poll', async () => {
  const s = store({ lockHeldBy: 4242, current: db(2 * HOUR, 4 * HOUR) });
  const lock = s.lock;
  let first = true;
  s.lock = async () => { if (first) { first = false; s.lockFile = null; throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); } return lock(); };
  const sleeps = [];
  const r = await prepareWith(s, { sleep: async ms => { sleeps.push(ms); }, runContainer: runs([]) });
  assert.deepEqual([r.status, sleeps], ['READY', []]);
});

test('on a real directory: the lock state, the staging leftovers and a reclaim with its durable receipt', async t => {
  const { mkdtemp, mkdir, writeFile, readdir, readFile, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readLockState, stagingLeftovers, reclaimStaleLock } = await import('../worker/formal-trivy-v3/cache.mjs');
  // directories cannot be fsynced on Windows; on Linux the real directory sync runs
  const { type: osType } = await import('node:os');
  const NOSYNC = osType() === 'Windows_NT' ? async () => {} : undefined; // the real OS (a Linux preload still runs on NTFS)
  const root = await mkdtemp(join(tmpdir(), 'clued-trivy-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'staging'));
  assert.equal(await readLockState(root), null);
  await writeFile(join(root, 'prepare.lock'), JSON.stringify({ pid: 236590, nonce: 'a'.repeat(64) }));
  const state = await readLockState(root);
  assert.deepEqual([state.pid, state.shape, /^[a-f0-9]{64}$/.test(state.sha256)], [236590, true, true]);
  const leftover = 'db-' + 'b'.repeat(64);
  await mkdir(join(root, 'staging', leftover, 'db'), { recursive: true });
  await writeFile(join(root, 'staging', leftover, 'db', 'trivy.db.part'), 'x');
  assert.deepEqual(await stagingLeftovers(root), { verifiable: true, names: [leftover] });
  const r = await reclaimStaleLock({ root, state, leftovers: await stagingLeftovers(root), proof: { pidGone: true, cacheContainers: 0, stagingVerifiable: true }, protect: async () => {}, syncDir: NOSYNC });
  assert.deepEqual([await readLockState(root), await readdir(join(root, 'staging'))], [null, []]);
  const files = (await readdir(join(root, 'reclaimed'))).sort();
  assert.equal(files.length, 3, files.join(','));
  const receiptName = files.find(f => /^lock-.*[^e]\.json$/.test(f) && !f.endsWith('.done.json'));
  const receipt = JSON.parse(await readFile(join(root, 'reclaimed', receiptName), 'utf8'));
  assert.deepEqual([receipt.contract, receipt.lockPid, receipt.stagingToRemove, r.receipt, r.stagingRemoved], ['clued.independent-ci.trivy-cache-lock-reclaimed/1', 236590, [leftover], receiptName, [leftover]]);
  const done = JSON.parse(await readFile(join(root, 'reclaimed', files.find(f => f.endsWith('.done.json'))), 'utf8'));
  assert.deepEqual([done.receipt, done.stagingRemoved], [receiptName, [leftover]]);
  assert.ok(files.some(f => f === receipt.claim), 'the claimed lock is kept beside its receipt');
  // a lock that changed after it was judged is not removed; an odd lock has no pid; an unknown staging entry is not verifiable
  await writeFile(join(root, 'prepare.lock'), JSON.stringify({ pid: 1, nonce: 'a'.repeat(64) }));
  const judged = await readLockState(root);
  await writeFile(join(root, 'prepare.lock'), JSON.stringify({ pid: 2, nonce: 'a'.repeat(64) }));
  await assert.rejects(reclaimStaleLock({ root, state: judged, leftovers: { verifiable: true, names: [] }, proof: {}, protect: async () => {}, syncDir: NOSYNC }), { code: 'CACHE_LOCK_CHANGED_WHILE_RECLAIMED' });
  assert.equal((await readLockState(root)).pid, 2, 'a lock that changed is put back where it was');
  // two judges of the same stale lock: only one rename wins, the other finds no lock to claim
  const stale = await readLockState(root);
  const a = reclaimStaleLock({ root, state: stale, leftovers: { verifiable: true, names: [] }, proof: {}, protect: async () => {}, syncDir: NOSYNC });
  const b = reclaimStaleLock({ root, state: stale, leftovers: { verifiable: true, names: [] }, proof: {}, protect: async () => {}, syncDir: NOSYNC });
  const outcomes = await Promise.allSettled([a, b]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1, JSON.stringify(outcomes.map(o => o.status)));
  await writeFile(join(root, 'prepare.lock'), '');
  assert.deepEqual([(await readLockState(root)).pid, (await readLockState(root)).shape], [null, false]);
  await writeFile(join(root, 'staging', 'stray.txt'), 'x');
  assert.deepEqual(await stagingLeftovers(root), { verifiable: false, names: [] });
  await rm(join(root, 'staging', 'stray.txt'));
  try { await symlink(join(root, 'reclaimed'), join(root, 'staging', 'db-' + 'c'.repeat(64)), 'junction'); assert.equal((await stagingLeftovers(root)).verifiable, false, 'a link is never verifiable'); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
});

test('the actual store is frozen before it is branded: its methods cannot be replaced', async () => {
  const text = await (await import('node:fs/promises')).readFile(new URL('../worker/formal-trivy-v3/cache.mjs', import.meta.url), 'utf8');
  const factory = text.slice(text.indexOf('export async function createActualStorage'), text.indexOf('// Generation 10: take the lock'));
  assert.match(factory, /Object\.freeze\(storage\); actualStores\.add\(storage\); return storage;/);
  assert.equal((factory.match(/actualStores\.add\(/g) ?? []).length, 1, 'branded in exactly one place, after the freeze');
  // a frozen object of the same shape refuses a replaced method (strict mode: the assignment throws)
  const frozen = Object.freeze({ reclaimLock() {} });
  assert.throws(() => { 'use strict'; frozen.reclaimLock = () => {}; }, TypeError);
});

test('losing a reclaim race (the other rename won) is no error: the lock is simply tried again', async () => {
  const s = store({ lockHeldBy: 4242, current: db(2 * HOUR, 4 * HOUR), staging: [] });
  s.reclaimLock = async () => { s.lockFile = null; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const r = await prepareWith(s, { runContainer: runs([]) });
  assert.deepEqual([r.status, r.lockReclaimed], ['READY', null]);
});
