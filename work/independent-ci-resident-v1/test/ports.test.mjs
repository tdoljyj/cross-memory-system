import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ORIGINAL_BINARY, originalStopped, parseScQc, parseScQueryex, parseStageFact } from '../src/engine-windows.mjs';
import { INSTALLED_MANIFEST_CONTRACT, installedIntegrity, mailboxCompanion } from '../src/service-ports.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { Runner, FIXED_ENV, serviceEnv } from '../src/runner.mjs';
import { sha256 } from '../src/canonical.mjs';
import { tempRoot, TEST_NODE, TEST_NODE_SHA } from './helpers.mjs';

const M = 'f'.repeat(64);
const goodFact = {
  state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', complete_original_readback: true, original_binary_restored: true,
  tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true, manifest_sha256: M,
  scm_start_call_issued: true, configuration_conflict_detected: false, native_receipt_sha256: 'a'.repeat(64),
};

test('stage terminal facts map to ok, a stable code and the Windows half of the cleanup proof', () => {
  assert.deepEqual(parseStageFact(JSON.stringify(goodFact), M), { ok: true, code: null, proof: { windowsTreeZero: true, serviceOriginalStopped: true }, nativeReceiptSha256: 'a'.repeat(64), relay: null, train: null,
    outcome: null, brokerNoLaunch: false });
  assert.deepEqual(parseStageFact(JSON.stringify({ ...goodFact, relay: [{ role: 'trivy' }] }), M).relay, [{ role: 'trivy' }], 'stage R rows are passed through for the executor to validate');
  assert.deepEqual(parseStageFact(JSON.stringify({ ...goodFact, train: { wouldDo: 'NO_FRONT' } }), M).train, { wouldDo: 'NO_FRONT' }, 'stage 10 facts are passed through for train.mjs#trainSummary');
  const refused = parseStageFact(JSON.stringify({ ...goodFact, state: 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED' }), M);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED');
  assert.equal(refused.proof.windowsTreeZero, true);
  const leaked = parseStageFact(JSON.stringify({ ...goodFact, tree_active_processes: 2, failure_code: 'X_Y' }), M);
  assert.equal(leaked.ok, false);
  assert.equal(leaked.proof.windowsTreeZero, false);
  assert.equal(parseStageFact(JSON.stringify(goodFact), 'e'.repeat(64)).ok, false, 'a different manifest is never ok');
});

test('SCM readback parsing requires the original binary, Manual and STOPPED with pid 0', () => {
  const qc = parseScQc(`[SC] QueryServiceConfig SUCCESS\r\n\r\nSERVICE_NAME: x\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        START_TYPE         : 3   DEMAND_START\r\n        BINARY_PATH_NAME   : ${ORIGINAL_BINARY}\r\n        SERVICE_START_NAME : .\\clued-control\r\n`);
  const q = parseScQueryex('SERVICE_NAME: x\r\n        STATE              : 1  STOPPED\r\n        PID                : 0\r\n');
  assert.equal(qc.account, '.\\clued-control');
  assert.equal(originalStopped(qc, q, TEST_NODE), true);
  assert.equal(originalStopped({ ...qc, binary: '"C:\\ProgramData\\CluedIndependentCI\\x.exe"' }, q, TEST_NODE), false);
  assert.equal(originalStopped(qc, { state: 4, pid: 1234 }, TEST_NODE), false);
});

test('installed integrity re-hashes every listed file and fails on any drift', async t => {
  const root = await tempRoot(t);
  const src = path.join(root, 'src');
  await fs.mkdir(path.join(src, 'a'), { recursive: true });
  await fs.writeFile(path.join(src, 'a', 'x.mjs'), 'export const x = 1;\n');
  const entry = { path: 'a/x.mjs', sha256: sha256(await fs.readFile(path.join(src, 'a', 'x.mjs'))), bytes: 20 };
  const manifest = path.join(root, 'm.json');
  await fs.writeFile(manifest, JSON.stringify({ contract: INSTALLED_MANIFEST_CONTRACT, root: 'src', files: [entry] }));
  const check = installedIntegrity({ sourceRoot: src, sourceManifest: manifest, residentRoot: src, residentManifest: manifest });
  const ok = await check();
  assert.equal(ok.ok, true);
  assert.equal(ok.sourceManifestSha256, sha256(await fs.readFile(manifest)));
  await fs.writeFile(path.join(src, 'a', 'x.mjs'), 'export const x = 2;\n');
  assert.equal((await check()).ok, false);
  await fs.writeFile(manifest, JSON.stringify({ contract: INSTALLED_MANIFEST_CONTRACT, root: 'src', files: [{ ...entry, path: '../outside' }] }));
  assert.equal((await check()).ok, false);
});

test('a companion that never answers is never success', async t => {
  const root = await tempRoot(t);
  let now = 0;
  const box = await Mailbox.open(root, () => now);
  const port = mailboxCompanion(box, async ms => { now += ms; });
  assert.equal((await port.buildBundle({ batchId: '0123456789abcdef-0123456789ab' })).ok, false);
  assert.equal((await port.archiveLinux({ batchId: '0123456789abcdef-0123456789ab' }, 'x')).verified, false);
  assert.equal(await port.heartbeat(), null);
});

test('runner refuses bad argv, never kills a slow child and stays busy until it exits', async () => {
  const children = [];
  const spawnImpl = () => { const c = new EventEmitter(); c.stdout = null; c.stderr = null; c.kill = () => { throw new Error('must not kill'); }; children.push(c); return c; };
  const runner = new Runner({ spawnImpl });
  assert.equal((await runner.run([], { timeoutMs: 10 })).refused, 'RUNNER_ARGV_REFUSED');
  const slow = await runner.run(['x.exe'], { timeoutMs: 10 });
  assert.equal(slow.timedOut, true);
  assert.equal(runner.busy, true);
  assert.equal((await runner.run(['y.exe'], { timeoutMs: 10 })).refused, 'RUNNER_BUSY_WITH_UNFINISHED_CHILD');
  children[0].emit('close', 0);
  assert.equal(runner.busy, false);
});

test('instance lock refuses a second live executor and keeps a dead holder\'s lock', async t => {
  const { acquireInstanceLock } = await import('../src/instance-lock.mjs');
  const root = await tempRoot(t);
  await acquireInstanceLock(root, { pid: 111, alive: async () => true, clock: () => 0 });
  await assert.rejects(acquireInstanceLock(root, { pid: 222, alive: async () => true, clock: () => 0 }), { code: 'EXECUTOR_ALREADY_RUNNING' });
  await acquireInstanceLock(root, { pid: 333, alive: async () => false, clock: () => 0 });
  const stale = await fs.readdir(path.join(root, 'locks'));
  assert.equal(stale.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'locks', stale[0], 'holder.json'), 'utf8')).pid, 111);
});

test('service children get the service temp directory on top of the fixed environment', () => {
  const dir = String.raw`C:\ProgramData\CluedIndependentCI\resident\state\tmp`;
  const env = serviceEnv(dir, TEST_NODE, TEST_NODE_SHA);
  assert.equal(env.TEMP, dir);
  assert.equal(env.TMP, dir);
  for (const [k, v] of Object.entries(FIXED_ENV)) assert.equal(env[k], v);
  assert.deepEqual(Object.keys(env).sort(), [...Object.keys(FIXED_ENV), 'COMPUTERNAME', 'TEMP', 'TMP'].sort());
  assert.equal(FIXED_ENV.TEMP, undefined);
  for (const bad of ['', String.raw`relative\tmp`, String.raw`C:\a;b`, String.raw`C:\a"b`, null]) assert.throws(() => serviceEnv(bad), /SERVICE_TEMP_DIR_REFUSED/);
});

test('the service entry passes every port the executor needs (independent review of phase 2 step 1, B1)', async () => {
  const { EXECUTOR_PORTS } = await import('../src/executor.mjs');
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(new URL('../src/service-main.mjs', import.meta.url), 'utf8');
  const block = /new ResidentExecutor\(\{([\s\S]*?)\n\s*\}\);/.exec(text)?.[1] ?? '';
  const named = new Set([...block.matchAll(/\b([a-zA-Z]+)\b(?=\s*[,:}\n])/g)].map(m => m[1]));
  for (const port of EXECUTOR_PORTS) assert.ok(named.has(port), `service-main.mjs does not pass ${port}`);
  assert.match(text, /RunQueue\.open\(path\.join\(state, 'queue'\)/, 'the run queue lives in state\queue');
});

test('production service environment requires the full independently pinned profile and cannot use an ambient host fallback', () => {
  const dir = String.raw`C:\ProgramData\CluedIndependentCI\resident\state\tmp`;
  assert.throws(() => serviceEnv(dir), { code: 'NODE_PROFILE_PIN_CHANGED' });
  assert.throws(() => serviceEnv(dir, TEST_NODE, '0'.repeat(64)), { code: 'NODE_PROFILE_PIN_CHANGED' });
  const other = { ...TEST_NODE, hostname: 'COMPANY-01', mutationMutex: 'Global\\CluedControlControllerMutationV1-COMPANY-01-1015' };
  assert.throws(() => serviceEnv(dir, other, TEST_NODE_SHA), { code: 'NODE_PROFILE_PIN_CHANGED' });
  assert.equal(serviceEnv(dir, TEST_NODE, TEST_NODE_SHA).COMPUTERNAME, TEST_NODE.hostname);
  assert.equal(Object.hasOwn(FIXED_ENV, 'COMPUTERNAME'), false, 'generic Runner has no fixed or ambient host identity');
});
