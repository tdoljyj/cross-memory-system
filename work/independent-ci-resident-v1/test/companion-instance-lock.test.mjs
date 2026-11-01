// One companion per node (Task 42fe5ae4, op 8e3b3e1b: a rollback that could not see its companion started one more every
// minute, and every one served the same mailboxes). companion-main.mjs takes the executor's lock (instance-lock.mjs) in the
// Owner's profile before it sets anything up, with its own liveness test: a holder pid counts only while it is still this
// root's companion node, so a pid Windows gave to another process never shuts the companion out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANION_LOCK_TOUCH_MS, COMPANION_STALE_LOCKS_KEPT, acquireCompanionLock, companionProcessAlive } from '../src/companion-main.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'companion-main.mjs');
const ROOT = 'C:\\ProgramData\\CluedIndependentCI\\resident';
const COMPANION = { executablePath: `${ROOT}\\runtime\\node.exe`,
  commandLine: `${ROOT}\\runtime\\node.exe ${ROOT}\\resident\\${'7'.repeat(64)}\\src\\companion-main.mjs --root ${ROOT} --config-sha256 ${'d'.repeat(64)}` };
const tempDir = async t => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-companion-lock-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
// processes: pid -> what Win32_Process says (absent: the pid is gone); 'unreadable' -> null.
const world = processes => ({
  alive: async pid => Object.hasOwn(processes, pid),
  readProcess: async pid => (processes[pid] === 'unreadable' ? null : processes[pid] ?? { executablePath: null, commandLine: null }),
});
const lockWith = (dir, processes, pid) => acquireCompanionLock(dir, ROOT, { alive: p => companionProcessAlive(p, ROOT, world(processes)),
  acquire: (d, o) => import('../src/instance-lock.mjs').then(m => m.acquireInstanceLock(d, { ...o, pid })) });

test('a live companion holder refuses a second companion, and the refusal is written for the Owner', async t => {
  const dir = await tempDir(t);
  await lockWith(dir, { 101: COMPANION }, 101);
  await assert.rejects(lockWith(dir, { 101: COMPANION, 102: COMPANION }, 102), { code: 'COMPANION_ALREADY_RUNNING' });
  const refused = JSON.parse(await fs.readFile(path.join(dir, 'refused.json'), 'utf8'));
  assert.deepEqual([refused.code, refused.holderPid], ['COMPANION_ALREADY_RUNNING', 101]);
  // Once the holder is gone, the next start succeeds and the stale refusal is removed.
  await lockWith(dir, { 103: COMPANION }, 103);
  await assert.rejects(fs.access(path.join(dir, 'refused.json')));
});

test('the holder pid reused by another process (or gone) is set aside: the new companion starts', async t => {
  for (const reused of [{ executablePath: 'C:\\Program Files\\Browser\\browser.exe', commandLine: 'browser.exe' },
    { executablePath: `${ROOT}\\runtime\\node.exe`, commandLine: `${ROOT}\\runtime\\node.exe ${ROOT}\\resident\\x\\src\\service-main.mjs` },
    { executablePath: null, commandLine: null }, undefined]) {
    const dir = await tempDir(t);
    await lockWith(dir, { 201: COMPANION }, 201);
    // The old companion ended without cleanup; Windows gave its pid to something else (or nobody).
    const processes = { 202: COMPANION, ...(reused ? { 201: reused } : {}) };
    await lockWith(dir, processes, 202);
    assert.equal((await fs.readdir(path.join(dir, 'locks'))).filter(n => n.startsWith('stale-')).length, 1);
  }
});

test('a holder whose process cannot be read keeps the executor rule: refused, never two companions', async t => {
  const dir = await tempDir(t);
  await lockWith(dir, { 301: COMPANION }, 301);
  await assert.rejects(lockWith(dir, { 301: 'unreadable', 302: COMPANION }, 302), { code: 'COMPANION_ALREADY_RUNNING' });
});

test('set-aside locks are pruned to the newest few', async t => {
  const dir = await tempDir(t);
  for (let pid = 400; pid < 400 + COMPANION_STALE_LOCKS_KEPT + 4; pid++) await lockWith(dir, { [pid]: COMPANION }, pid);
  assert.equal((await fs.readdir(path.join(dir, 'locks'))).filter(n => n.startsWith('stale-')).length, COMPANION_STALE_LOCKS_KEPT);
});

test('companion-main takes the lock in the Owner profile before any lane, and refreshes it well inside ten minutes', async () => {
  const text = await fs.readFile(SRC, 'utf8');
  const lockAt = text.indexOf('await acquireCompanionLock(path.join(cfg.node.ownerProfileDirectory'), probeAt = text.indexOf('await probeJobHost(runner)');
  assert.ok(lockAt > 0 && lockAt < probeAt, 'the lock comes before the job host probe and every lane');
  assert.ok(text.includes('instanceLock.touch()') && COMPANION_LOCK_TOUCH_MS <= 60_000);
});
