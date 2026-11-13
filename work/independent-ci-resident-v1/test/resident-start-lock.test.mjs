// The first start of a generation, seconds after its predecessor ended (DESK, 2026-11-14 01:38:38, upgrade op 17a31df9): the new
// service-main ended with exit 4 before it took the lock, wrote nothing anywhere, and the upgrade rolled back. The executor's lock
// counted any live pid as its holder, and Windows gives a freed pid to another process within seconds. Now the holder counts only
// while its pid is still this root's service-main and that process started no later than the lock was written; a start that is
// refused all the same says why in state\start-refused.json.
//
// End to end: the service entry itself (src/service-main.mjs, as ResidentServiceHost.exe starts it) in a child process, against a
// throw-away root, with a real live process behind the holder's pid. What Windows says about a pid comes from a file the test
// writes (the entry reads it only when the test names it on the child's command line), so the same test runs on Linux.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/canonical.mjs';
import { acquireInstanceLock } from '../src/instance-lock.mjs';
import { TAKEOVER_RETRY_MS, acquireResidentLock, readWin32Process, residentProcessAlive } from '../src/resident-lock.mjs';
import { START_REFUSED_FILE } from '../src/service-main.mjs';
import { rawPolicy, tempRoot } from './helpers.mjs';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'service-start-entry.mjs');
const SERVICE_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'service-main.mjs');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const receiptTypes = async root => (await fs.readdir(path.join(root, 'state', 'receipts')).catch(() => []))
  .filter(name => /^\d+-/.test(name)).sort().map(name => name.replace(/^\d+-/, '').replace(/\.json$/, ''));
const stale = async root => (await fs.readdir(path.join(root, 'state', 'locks')).catch(() => [])).filter(name => name.startsWith('stale-'));

// Why a start ended as it did, for the assertion messages: what the entry wrote to state/start-refused.json.
const refusal = async root => fs.readFile(path.join(root, 'state', START_REFUSED_FILE), 'utf8').catch(() => 'no start-refused.json');

// The start got past the lock that `oldPid` held. On Windows it then runs to the end: exit 0, a service-start receipt, no refusal
// left. The service is Windows-only: on any other host the first step after the lock that needs Windows (runner.mjs serviceEnv:
// the children's temp directory must be a drive path) refuses the start, which is exactly what the refusal file must then say.
// (#1095: this test first expected exit 0 everywhere and failed on the Linux runner with a bare "4 !== 0".)
async function assertStarted(root, code, oldPid) {
  const why = `exit ${code}; ${await refusal(root)}`;
  assert.notEqual((await read(path.join(root, 'state', 'executor.lock', 'holder.json'))).pid, oldPid, why);
  if (process.platform === 'win32') {
    assert.equal(code, 0, why);
    assert.equal((await receiptTypes(root))[0], 'service-start', why);
    await assert.rejects(fs.access(path.join(root, 'state', START_REFUSED_FILE)));
  } else {
    const refused = await read(path.join(root, 'state', START_REFUSED_FILE)).catch(() => null);
    assert.deepEqual([code, refused?.code, refused?.message], [4, 'RESIDENT_START_EXCEPTION', 'SERVICE_TEMP_DIR_REFUSED'], why);
  }
}

// A live process that is not the service: it only waits. Ended by the test through its own handle.
function sleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { child.kill(); });
  return child;
}

// A root with the installed policy and the lock a predecessor wrote `agoMs` ago under `pid` (holder and liveness, same boot).
async function rootWithLock(t, pid, agoMs = 7000) {
  const root = await tempRoot(t, 'clued-start-lock-');
  const policy = Buffer.from(JSON.stringify(rawPolicy()));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'policy.json'), policy);
  const lock = path.join(root, 'state', 'executor.lock');
  await fs.mkdir(lock, { recursive: true });
  const at = Date.now() - agoMs, uptimeMs = Math.max(0, Math.round(os.uptime() * 1000) - agoMs);
  await fs.writeFile(path.join(lock, 'holder.json'), JSON.stringify({ at: new Date(at).toISOString(), pid, token: 'aa', uptimeMs }));
  await fs.writeFile(path.join(lock, 'alive.json'), JSON.stringify({ token: 'aa', at, uptimeMs }));
  return { root, pin: sha256(policy), lockedAt: at };
}

// Runs the service entry once; `processes` (pid -> what Win32_Process says) replaces the PowerShell query when given.
async function startOnce(root, pin, processes) {
  const args = [processes ? ENTRY : SERVICE_MAIN, '--root', root, '--policy-sha256', pin, '--once'];
  if (processes) {
    const file = path.join(root, 'processes.json');
    await fs.writeFile(file, JSON.stringify(processes));
    args.push('--processes', file);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('SERVICE_ENTRY_DID_NOT_END')); }, 120_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

test('a 7 second old lock whose pid now names a live process that is not service-main: the new generation starts', async t => {
  const other = sleeper(t);
  const { root, pin, lockedAt } = await rootWithLock(t, other.pid);
  // Windows gave the freed pid to another program after the lock was written (the upgrade's own children, that night).
  const code = await startOnce(root, pin, { [other.pid]: { name: 'sc.exe', executablePath: null, commandLine: null, creationMs: lockedAt + 5000 } });
  await assertStarted(root, code, other.pid);
  assert.equal((await stale(root)).length, 1, 'the old lock is set aside');
});

test('the same, when the reused pid is a later node of this root (even a service-main): it started after the lock was written', async t => {
  const other = sleeper(t);
  const { root, pin, lockedAt } = await rootWithLock(t, other.pid);
  const node = path.join(root, 'runtime', 'node.exe');
  const code = await startOnce(root, pin, { [other.pid]: { name: 'node.exe', executablePath: node,
    commandLine: `"${node}" "${path.join(root, 'resident', 'x', 'src', 'service-main.mjs')}" --root "${root}" --policy-sha256 ${pin}`, creationMs: lockedAt + 1 } });
  await assertStarted(root, code, other.pid);
});

test('the real holder is still alive: the start is refused, nothing is taken over, and the refusal is written down', async t => {
  const holder = sleeper(t);
  const { root, pin, lockedAt } = await rootWithLock(t, holder.pid);
  const node = path.join(root, 'runtime', 'node.exe');
  const processes = { [holder.pid]: { name: 'node.exe', executablePath: node,
    commandLine: `"${node}" "${path.join(root, 'resident', 'x', 'src', 'service-main.mjs')}" --root "${root}" --policy-sha256 ${pin}`, creationMs: lockedAt - 300 } };
  assert.equal(await startOnce(root, pin, processes), 4, await refusal(root));
  assert.deepEqual(await receiptTypes(root), []);
  assert.deepEqual(await stale(root), []);
  assert.equal((await read(path.join(root, 'state', 'executor.lock', 'holder.json'))).pid, holder.pid);
  const refused = await read(path.join(root, 'state', START_REFUSED_FILE));
  assert.deepEqual([refused.contract, refused.code, refused.detail, typeof refused.pid, Number.isFinite(Date.parse(refused.at))],
    ['clued.independent-ci.start-refused/1', 'EXECUTOR_ALREADY_RUNNING', holder.pid, 'number', true]);
  // The holder ends; the next start takes the lock over and the old refusal no longer stands.
  delete processes[holder.pid];
  holder.kill();
  await new Promise(resolve => holder.once('exit', resolve));
  await assertStarted(root, await startOnce(root, pin, processes), holder.pid);
});

test('a holder whose process cannot be read at all keeps the old rule: refused, never two executors', async t => {
  const holder = sleeper(t);
  const { root, pin } = await rootWithLock(t, holder.pid);
  assert.equal(await startOnce(root, pin, { [holder.pid]: 'unreadable' }), 4);
  assert.equal((await read(path.join(root, 'state', START_REFUSED_FILE))).code, 'EXECUTOR_ALREADY_RUNNING');
});

test('on Windows, with the real process query: a live pid that is not service-main does not refuse the start', { skip: process.platform !== 'win32' }, async t => {
  const other = sleeper(t);
  const seen = await readWin32Process(other.pid);
  assert.equal(seen?.name?.toLowerCase(), 'node.exe');
  assert.ok(Number.isFinite(seen.creationMs) && Math.abs(seen.creationMs - Date.now()) < 120_000, JSON.stringify(seen));
  const { root, pin } = await rootWithLock(t, other.pid);
  await assertStarted(root, await startOnce(root, pin, null), other.pid);
});

test('residentProcessAlive: who counts as the holder', async () => {
  const root = path.join('C:', 'resident-root');
  const node = path.join(root, 'runtime', 'node.exe');
  const ours = { name: 'node.exe', executablePath: node, commandLine: `${node} x\\src\\service-main.mjs --root ${root}`, creationMs: 900 };
  const holder = { pid: 50, at: new Date(1000).toISOString() };
  const ask = (seen, { pid = 50, live = true, self = 99 } = {}) => residentProcessAlive(pid, holder, root, { alive: async () => live, readProcess: async () => seen, self });
  assert.equal(await ask(ours), true);
  assert.equal(await ask(ours, { live: false }), false, 'the pid is gone');
  assert.equal(await ask(ours, { self: 50 }), false, 'this process itself got the old pid');
  assert.equal(await ask(null), true, 'unreadable: refuse');
  assert.equal(await ask({ name: null, executablePath: null, commandLine: null, creationMs: null }), false, 'gone by the time it was read');
  assert.equal(await ask({ ...ours, creationMs: 1001 }), false, 'started after the lock was written');
  assert.equal(await ask({ ...ours, creationMs: 1000 }), true);
  assert.equal(await ask({ name: 'powershell.exe', executablePath: null, commandLine: null, creationMs: 900 }), false, 'another program');
  assert.equal(await ask({ ...ours, executablePath: path.join('C:', 'elsewhere', 'node.exe') }), false, 'another node');
  assert.equal(await ask({ ...ours, commandLine: `${node} x\\src\\companion-main.mjs --root ${root}` }), false, 'the companion');
  assert.equal(await ask({ name: 'node.exe', executablePath: null, commandLine: null, creationMs: 900 }), true, 'a node that cannot be opened and is old enough: refuse');
  assert.equal(await ask({ ...ours, creationMs: null }), true, 'no start time: the path and the command line decide');
});

test('the service lock hands the holder record to the liveness test, and a takeover rename that fails for a moment is retried', async t => {
  const root = await tempRoot(t);
  await acquireInstanceLock(root, { pid: 111, alive: async () => false, clock: () => 1000 });
  // The reused pid: alive, another program, started after the lock was written.
  const seen = [];
  const readProcess = async pid => { seen.push(pid); return { name: 'sc.exe', executablePath: null, commandLine: null, creationMs: 1500 }; };
  let calls = 0;
  const acquire = async (dir, options) => {
    calls += 1;
    assert.equal(await options.alive(111), false);
    if (calls <= 2) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
    return acquireInstanceLock(dir, { ...options, pid: 222 });
  };
  const lock = await acquireResidentLock(root, path.join(root, 'r'), { clock: () => 2000, alive: async () => true, readProcess, self: 222, acquire, sleep: async () => {} });
  assert.deepEqual([calls, seen], [3, [111, 111, 111, 111]]);
  assert.equal((await read(path.join(lock.dir, 'holder.json'))).pid, 222);
  // Any other failure, and a rename that never succeeds, are thrown.
  await assert.rejects(acquireResidentLock(root, root, { acquire: async () => { throw Object.assign(new Error('no'), { code: 'ENOSPC' }); }, sleep: async () => {} }), { code: 'ENOSPC' });
  let always = 0;
  await assert.rejects(acquireResidentLock(root, root, { acquire: async () => { always += 1; throw Object.assign(new Error('busy'), { code: 'EACCES' }); }, sleep: async () => {} }), { code: 'EACCES' });
  assert.equal(always, TAKEOVER_RETRY_MS.length + 1);
});
