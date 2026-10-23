// DESIGN §22 (Task 8e1f07d3): the companion's children run under the job host, so a child that outlives its limit is
// ended with exactly its own job and the mailbox lane goes on; a stage-0 failure is released without the companion.
// CLUED_JOB_HOST_EXE (set by windows/test-job-host.ps1 after it compiles the host) adds the live tests against the real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JOB_HOST_GRACE_MS, JOB_HOST_REPORT_CONTRACT, Runner, parseJobHostReport } from '../src/runner.mjs';
import { lane } from '../src/companion-main.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, jobTreeOf, validateCompanionConfig } from '../src/companion.mjs';
import { Mailbox, RESPONSE_CONTRACT } from '../src/mailbox.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { executorFixture, fakeCompanion, fakeEngine, tempRoot, triggerBytes } from './helpers.mjs';

const NONCE = '0123456789abcdef0123456789abcdef';
const HOST = 'C:\\ProgramData\\CluedIndependentCI\\resident\\bin\\CluedCompanionJobHost.exe';
const report = (o = {}) => `clued-job-host ${o.nonce ?? NONCE} ${JSON.stringify({ contract: JOB_HOST_REPORT_CONTRACT, started: true, failure: null, childPid: 4242,
  timedOut: false, exitCode: 0, leftover: 0, activeProcesses: 0, totalProcesses: 2, treeZero: true, ...o.fields })}`;

// A fake job host: what it writes and how it ends, decided by the test.
function fakeHost() {
  const spawned = [];
  const spawnImpl = (file, args, opts) => {
    const c = new EventEmitter();
    const stream = () => { const s = new EventEmitter(); s.setEncoding = () => s; return s; };
    c.stdout = stream(); c.stderr = stream(); c.killed = 0; c.kill = () => { c.killed += 1; };
    spawned.push({ file, args, opts, child: c });
    return c;
  };
  const end = (i, { out = '', err = '', code = 0 } = {}) => {
    const { child } = spawned[i];
    if (out) child.stdout.emit('data', out);
    if (err) child.stderr.emit('data', err);
    child.emit('close', code);
  };
  return { spawned, spawnImpl, end };
}
const tick = () => new Promise(r => setImmediate(r));

test('the host report is taken only as the last stderr line, for this nonce, in exactly the host shape', () => {
  assert.equal(parseJobHostReport(`child noise\n${report()}\n`, NONCE).treeZero, true);
  assert.equal(parseJobHostReport(`${report()}\r\n`, NONCE).exitCode, 0);
  assert.equal(parseJobHostReport(report(), 'f'.repeat(32)), null, 'another nonce');
  assert.equal(parseJobHostReport(`${report()}\nlater line\n`, NONCE), null, 'not the last line');
  assert.equal(parseJobHostReport(report({ fields: { extra: 1 } }), NONCE), null, 'extra key');
  assert.equal(parseJobHostReport(report({ fields: { failure: 'free text' } }), NONCE), null, 'free-form failure');
  assert.equal(parseJobHostReport(report({ fields: { contract: 'x/1' } }), NONCE), null);
  assert.equal(parseJobHostReport(report({ fields: { exitCode: -1 } }), NONCE), null);
  assert.equal(parseJobHostReport(report({ fields: { treeZero: 'yes' } }), NONCE), null);
  assert.equal(parseJobHostReport('', NONCE), null);
});

test('a hosted child that ends on its own: exact argv to the host, its exit code and output, the report taken off stderr', async () => {
  const h = fakeHost();
  const runner = new Runner({ jobHost: HOST, spawnImpl: h.spawnImpl, nonce: () => NONCE, env: { A: '1' } });
  const p = runner.run(['C:\\Windows\\System32\\wsl.exe', '--exec', '/bin/true'], { timeoutMs: 15_000 });
  assert.deepEqual([h.spawned[0].file, h.spawned[0].args], [HOST, [NONCE, '15000', 'C:\\Windows\\System32\\wsl.exe', '--exec', '/bin/true']]);
  assert.deepEqual(h.spawned[0].opts, { shell: false, windowsHide: true, env: { A: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(runner.busy, true);
  h.end(0, { out: '{"ok":true}', err: `warn\n${report({ fields: { exitCode: 3 } })}\n`, code: 3 });
  assert.deepEqual(await p, { code: 3, stdout: '{"ok":true}', stderr: 'warn' });
  assert.equal(runner.busy, false);
});

test('a hosted child past its limit: the host ended and drained its job; the runner is free at once (no busy left behind)', async () => {
  const h = fakeHost();
  const runner = new Runner({ jobHost: HOST, spawnImpl: h.spawnImpl, nonce: () => NONCE });
  const p = runner.run(['C:\\ps.exe', '-File', 'build-bundle.ps1'], { timeoutMs: 1_800_000 });
  h.end(0, { err: report({ fields: { timedOut: true, exitCode: 90, leftover: 5, totalProcesses: 5 } }), code: 121 });
  const r = await p;
  assert.deepEqual([r.code, r.timedOut, r.tree, r.refused], [null, true, 'zero', undefined]);
  assert.equal(runner.busy, false);
  const next = runner.run(['C:\\wsl.exe', 'quiescence'], { timeoutMs: 30_000 });
  assert.equal(h.spawned.length, 2, 'the next child starts right away');
  h.end(1, { out: '{}', err: report(), code: 0 });
  assert.equal((await next).code, 0);
});

test('host endings other than "ended on its own, drained": each says what is unknown; only a child that exited is ever code 0', async () => {
  const cases = [
    [{ err: report({ fields: { timedOut: true, exitCode: 90, activeProcesses: 1, treeZero: false } }), code: 121 }, { code: null, timedOut: true, tree: 'unconfirmed' }],
    [{ err: report({ fields: { activeProcesses: 1, treeZero: false } }), code: 0 }, { code: 0, tree: 'unconfirmed' }],
    [{ err: 'crashed\n', code: 255 }, { code: null, refused: 'JOB_HOST_UNCONFIRMED', tree: 'unconfirmed' }],
    [{ err: report({ fields: { started: false, failure: 'CHILD_CREATE_FAILED', childPid: null, exitCode: null } }), code: 120 }, { code: null, refused: 'JOB_HOST_UNCONFIRMED' }],
    [{ err: report({ fields: { started: false, failure: 'CHILD_RESUME_FAILED', exitCode: null, activeProcesses: 1, treeZero: false } }), code: 120 }, { code: null, refused: 'JOB_HOST_UNCONFIRMED', tree: 'unconfirmed' }],
    [{ err: report({ fields: { exitCode: 0 } }), code: 1 }, { code: null, refused: 'JOB_HOST_UNCONFIRMED', tree: 'zero' }],
    [{ err: report({ fields: { failure: 'CHILD_WAIT_UNCONFIRMED' } }), code: 122 }, { code: null, refused: 'JOB_HOST_UNCONFIRMED', tree: 'zero' }],
    [{ err: report({ nonce: 'a'.repeat(32) }), code: 0 }, { code: null, refused: 'JOB_HOST_UNCONFIRMED', tree: 'unconfirmed' }],
  ];
  for (const [ending, want] of cases) {
    const h = fakeHost();
    const runner = new Runner({ jobHost: HOST, spawnImpl: h.spawnImpl, nonce: () => NONCE });
    const p = runner.run(['C:\\x.exe'], { timeoutMs: 5_000 });
    h.end(0, ending);
    const r = await p;
    for (const [k, v] of Object.entries(want)) assert.deepEqual(r[k], v, `${JSON.stringify(ending)} -> ${k}`);
    if (!('tree' in want)) assert.equal('tree' in r, false);
    assert.equal(runner.busy, false);
  }
});

test('the report is found after more than 4 MiB of child stderr', async () => {
  const h = fakeHost();
  const runner = new Runner({ jobHost: HOST, spawnImpl: h.spawnImpl, nonce: () => NONCE });
  const p = runner.run(['C:\\x.exe'], { timeoutMs: 5_000 });
  for (let i = 0; i < 5; i++) h.spawned[0].child.stderr.emit('data', 'x'.repeat(1024 * 1024));
  h.end(0, { err: `\n${report({ fields: { timedOut: true, exitCode: 90 } })}\n`, code: 121 });
  assert.equal((await p).tree, 'zero');
});

test('a host that outstays its own limit is ended by the runner (its job closes with it); busy until it is gone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fakeHost();
  const runner = new Runner({ jobHost: HOST, spawnImpl: h.spawnImpl, nonce: () => NONCE });
  const p = runner.run(['C:\\x.exe'], { timeoutMs: 10_000 });
  t.mock.timers.tick(10_000 + JOB_HOST_GRACE_MS - 1);
  assert.equal(h.spawned[0].child.killed, 0, 'not before the limit plus the grace');
  t.mock.timers.tick(1);
  assert.deepEqual(await p, { code: null, stdout: '', stderr: '', timedOut: true, tree: 'unconfirmed' });
  assert.equal(h.spawned[0].child.killed, 1, 'only the host, its own direct child');
  assert.equal(runner.busy, true);
  assert.equal((await runner.run(['C:\\y.exe'], { timeoutMs: 5_000 })).refused, 'RUNNER_BUSY_WITH_UNFINISHED_CHILD');
  h.end(0, { code: null });
  assert.equal(runner.busy, false);
});

test('a kill the system refuses (an error event of a started host) leaves the runner busy until the host is really gone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fakeHost();
  const runner = new Runner({ jobHost: HOST, spawnImpl: (...a) => { const c = h.spawnImpl(...a); c.pid = 4321; c.kill = () => { c.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' })); }; return c; }, nonce: () => NONCE });
  const p = runner.run(['C:\\x.exe'], { timeoutMs: 5_000 });
  t.mock.timers.tick(5_000 + JOB_HOST_GRACE_MS);
  assert.deepEqual((await p).tree, 'unconfirmed');
  assert.equal(runner.busy, true, 'the host still runs: nothing new starts on top of it');
  h.end(0, { code: 1 });
  assert.equal(runner.busy, false);
});

test('a host that never started (spawn error, no pid) frees the runner at once', async () => {
  const h = fakeHost();
  const runner = new Runner({ jobHost: HOST, spawnImpl: (...a) => { const c = h.spawnImpl(...a); setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; }, nonce: () => NONCE });
  assert.equal((await runner.run(['C:\\x.exe'], { timeoutMs: 5_000 })).refused, 'RUNNER_SPAWN_FAILED');
  assert.equal(runner.busy, false);
});

test('hosted limits outside the host\'s range and a malformed host path are refused before anything starts', async () => {
  const h = fakeHost();
  const runner = new Runner({ jobHost: HOST, spawnImpl: h.spawnImpl, nonce: () => NONCE });
  assert.equal((await runner.run(['C:\\x.exe'], { timeoutMs: 999 })).refused, 'RUNNER_TIMEOUT_REFUSED');
  assert.equal((await runner.run(['C:\\x.exe'], { timeoutMs: 3_600_001 })).refused, 'RUNNER_TIMEOUT_REFUSED');
  assert.equal((await runner.run(['C:\\x.exe'], { timeoutMs: 1.5e3 + 0.5 })).refused, 'RUNNER_TIMEOUT_REFUSED');
  assert.equal(h.spawned.length, 0);
  assert.throws(() => new Runner({ jobHost: 'bin\\host.exe' }), /RUNNER_JOB_HOST_REFUSED/);
  assert.throws(() => new Runner({ jobHost: 'C:\\a"b.exe' }), /RUNNER_JOB_HOST_REFUSED/);
});

test('the service runner (no job host) keeps the old rule: it never kills and stays busy after a timeout', async () => {
  const h = fakeHost();
  const runner = new Runner({ spawnImpl: h.spawnImpl });
  const r = await runner.run(['C:\\node.exe', 'invoke-stage.mjs'], { timeoutMs: 5 });
  assert.deepEqual([r.timedOut, 'tree' in r, h.spawned[0].file], [true, false, 'C:\\node.exe']);
  assert.equal(h.spawned[0].child.killed, 0);
  assert.equal(runner.busy, true);
  h.end(0, { code: 0 });
  assert.equal(runner.busy, false);
});

test('the mailbox lane goes on after a timed-out child: the next request is answered with fresh root-tool facts', async () => {
  const h = fakeHost();
  const runner = new Runner({ jobHost: HOST, spawnImpl: h.spawnImpl, nonce: () => NONCE });
  let ticks = 0, answered = 0, stopped = false;
  const stop = () => stopped || ++ticks > 200;
  const work = async () => {
    const i = h.spawned.length;
    const p = runner.run(['C:\\x.exe'], { timeoutMs: 5_000 });
    // the first child outlives its limit (the host ends it); every later one answers at once
    if (i === 0) h.end(0, { err: report({ fields: { timedOut: true, exitCode: 90 } }), code: 121 });
    else h.end(i, { out: '{"linuxUnitsInactive":true,"containersZero":true}', err: report(), code: 0 });
    if ((await p).code === 0) answered += 1;
  };
  await lane({ runner, work, sleep: tick, stop });
  stopped = true;
  assert.ok(answered > 100, `the lane kept answering after the timeout (${answered})`);
});

const cfg = validateCompanionConfig({
  contract: COMPANION_CONFIG_CONTRACT,
  wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\build-bundle.ps1',
  windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04',
  bridgeManifestSha256: '9'.repeat(64),
  linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux',
});
const BATCH = '0123456789abcdef-0123456789ab';

test('jobTree: none, all drained, or anything else', () => {
  assert.equal(jobTreeOf([]), null);
  assert.equal(jobTreeOf(['zero', 'zero']), 'zero');
  assert.equal(jobTreeOf(['zero', 'unconfirmed']), 'unconfirmed');
});

test('the companion answers a timed-out bundle with its job tree, then answers linux-quiescence from the root tool', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-23T09:00:00Z');
  const box = await Mailbox.open(root, () => now);
  const bundle = await box.send('build-bundle', { batchId: BATCH }, 35 * 60_000);
  now += 1000;
  const quiet = await box.send('linux-quiescence', { batchId: BATCH }, 2 * 60_000);
  const runs = [];
  const run = async (a, o) => {
    runs.push([a.at(-1), o.timeoutMs]);
    if (a.includes('-BatchId')) return { code: null, stdout: '', stderr: '', timedOut: true, tree: 'zero' };
    return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }), stderr: '' };
  };
  const companion = new Companion({ cfg, mailbox: box, run, fileExists: async () => false, sleep: tick, clock: () => now });
  await companion.step();
  const b = await box.poll(bundle);
  assert.deepEqual([b.contract, b.ok, b.code, b.jobTree], [RESPONSE_CONTRACT, false, 'BUNDLE_UNAVAILABLE', 'zero']);
  const q = await box.poll(quiet);
  assert.deepEqual([q.ok, q.proof, q.jobTree], [true, { linuxUnitsInactive: true, containersZero: true }, null]);
  assert.deepEqual(runs.map(r => r[1]), [30 * 60_000, 30_000]);
});

test('a relay call past its limit: the pump refuses as before, and its blocked hand-over can now run (no busy runner)', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-23T09:00:00Z');
  const box = await Mailbox.open(root, () => now);
  const req = await box.send('relay-stage', { batchId: BATCH, stage: 4, jobId: 'e'.repeat(64) }, 10 * 60_000);
  const modes = [];
  let gaveUp = false;
  const run = async a => {
    if (a.includes('-Mode')) {
      const mode = a[a.indexOf('-Mode') + 1];
      modes.push(mode);
      if (mode === 'SendIssue') return { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
      if (mode === 'ReceiveChallenge') { gaveUp = true; return { code: null, stdout: '', stderr: '', timedOut: true, tree: 'zero' }; }
      if (mode === 'ReceiveBlocked') return { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
    }
    // the worker gives up on the round it never got an answer for: its clean 'blocked' record
    if (a.includes('/usr/bin/ls')) return { code: 0, stdout: gaveUp ? 'challenge-01.ready.json\nblocked.ready.json\n' : 'challenge-01.ready.json\n' };
    if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
    return { code: 0, stdout: '' };
  };
  const companion = new Companion({ cfg, mailbox: box, run, fileExists: async () => true, sleep: async ms => { now += ms; }, clock: () => now });
  await companion.step();
  const r = await box.poll(req);
  assert.deepEqual([r.ok, r.code, r.jobTree], [false, 'RELAY_REFUSED_NO_RETRY', 'zero']);
  assert.deepEqual(modes, ['SendIssue', 'ReceiveChallenge', 'ReceiveBlocked'], 'the blocked record is handed over once');
});

test('responses /2: jobTree is null, zero or unconfirmed, nothing else', async t => {
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => Date.parse('2026-10-23T09:00:00Z'));
  const a = await box.send('build-bundle', { batchId: BATCH }, 60_000);
  await assert.rejects(box.respond(a, { ok: false, code: 'BUNDLE_UNAVAILABLE', jobTree: 'gone' }), { code: 'MAILBOX_RESPONSE_JOB_TREE_REFUSED' });
  await box.respond(a, { ok: false, code: 'BUNDLE_UNAVAILABLE', jobTree: 'unconfirmed' });
  assert.equal((await box.poll(a)).jobTree, 'unconfirmed');
  const b = await box.send('archive-usage', { batchId: BATCH }, 60_000);
  await box.respond(b, { ok: true, usage: { bytes: 1, directories: 1 } });
  assert.equal((await box.poll(b)).jobTree, null);
  assert.ok(RESPONSE_CONTRACT.endsWith('/2'));
});

test('the service port passes the bundle answer\'s job tree on', async t => {
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => Date.parse('2026-10-23T09:00:00Z'));
  const port = mailboxCompanion(box, tick);
  const asked = port.buildBundle({ batchId: BATCH });
  let req = null;
  while (!req) { await tick(); req = (await box.pending())[0] ?? null; }
  await box.respond(req, { ok: false, code: 'BUNDLE_UNAVAILABLE', jobTree: 'zero' });
  assert.deepEqual(await asked, { ok: false, code: 'BUNDLE_UNAVAILABLE', jobTree: 'zero' });
});

test('stage 0 fails: released after a Windows-only close; the companion is asked for nothing, so it cannot HALT the release', async t => {
  // archive-linux and quiescence would fail: a companion still busy with the bundle answers nothing (the 2026-10-23 HALT).
  const companion = fakeCompanion({ bundle: { ok: false, code: 'BUNDLE_UNAVAILABLE', jobTree: 'zero' }, archiveLinux: { verified: false, directory: null },
    linux: { linuxUnitsInactive: false, containersZero: false } });
  const engine = fakeEngine();
  const f = await executorFixture(t, { companion, engine });
  await f.drop(triggerBytes());
  const out = await f.exec.tick();
  assert.equal(out.state, 'NOT_EXECUTED');
  assert.equal(out.failureCode, 'BUNDLE_UNAVAILABLE');
  assert.deepEqual(engine.calls.filter(c => c[0] === 'close'), [['close', false]], 'Windows only');
  assert.deepEqual(companion.calls.map(c => c[0]).filter(c => c !== 'pr-head'), ['bundle'], 'nothing else asked of the companion');
  const dir = path.join(f.root, 'state', 'receipts');
  const names = await fs.readdir(dir);
  const unexecuted = names.find(n => n.endsWith('-batch-unexecuted.json'));
  assert.ok(unexecuted, 'batch-unexecuted receipt');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, unexecuted), 'utf8')).body.companionJobTree, 'zero');
  assert.equal(names.some(n => /-(halt[a-z-]*|batch-terminal)\.json$/.test(n)), false, 'no HALT, no terminal');
  assert.equal(await f.ledger.halted(), null, 'no HALT');
});

test('superseded before stage 1: also a Windows-only close', async t => {
  const engine = fakeEngine();
  const companion = fakeCompanion({ archiveLinux: { verified: false, directory: null } });
  const f = await executorFixture(t, { companion, engine });
  const bundle = companion.buildBundle;
  let once = true;
  companion.buildBundle = async b => { if (once) { once = false; await f.drop(triggerBytes({ headSha: '7'.repeat(40) })); } return bundle(b); };
  await f.drop(triggerBytes());
  const out = await f.exec.tick();
  assert.equal(out.release, 'SUPERSEDED');
  assert.deepEqual(engine.calls.filter(c => c[0] === 'close'), [['close', false]]);
  assert.equal(companion.calls.some(c => c[0] === 'archive-linux'), false);
});

// ---- live, against the real job host (windows/test-job-host.ps1 compiles it and sets CLUED_JOB_HOST_EXE) ----
const LIVE = process.env.CLUED_JOB_HOST_EXE ?? null;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('live: output and exit code pass through unchanged, arguments arrive exactly', { skip: !LIVE }, async () => {
  const runner = new Runner({ jobHost: LIVE, env: { ...process.env } });
  const args = ['a b', 'q"x', 'tr\\\\', 'mid\\"q', '{number: .number, state: .state}', ''];
  const r = await runner.run([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.exit(5)', ...args], { timeoutMs: 20_000 });
  assert.equal(r.code, 5);
  assert.deepEqual(JSON.parse(r.stdout), args);
  assert.equal('tree' in r, false);
  assert.equal(runner.busy, false);
});

test('live: a child and its grandchild past the limit are both ended; the runner is free and runs the next child', { skip: !LIVE }, async () => {
  const runner = new Runner({ jobHost: LIVE, env: { ...process.env } });
  const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+' '+process.pid);setInterval(()=>{},1000)";
  const r = await runner.run([process.execPath, '-e', script], { timeoutMs: 3_000 });
  assert.deepEqual([r.timedOut, r.tree], [true, 'zero']);
  const [grandchild, child] = r.stdout.split(' ').map(Number);
  assert.equal(alive(child), false, 'the child is gone');
  assert.equal(alive(grandchild), false, 'the grandchild is gone too');
  assert.equal(runner.busy, false);
  assert.equal((await runner.run([process.execPath, '-e', 'process.exit(0)'], { timeoutMs: 10_000 })).code, 0);
});

test('live: a grandchild left behind by a child that exits is ended too; a process outside the job is never touched', { skip: !LIVE }, async () => {
  const outside = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const runner = new Runner({ jobHost: LIVE, env: { ...process.env } });
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});c.unref();process.stdout.write(String(c.pid))";
    const r = await runner.run([process.execPath, '-e', script], { timeoutMs: 20_000 });
    assert.equal(r.code, 0);
    assert.equal(alive(Number(r.stdout)), false, 'even a detached grandchild belongs to the job');
    assert.equal(alive(outside.pid), true, 'a process that is not in the job lives on');
  } finally { outside.kill(); }
});

test('live: the 2026-10-23 case: powershell running a git fetch that hangs on a silent server is ended whole at the limit', { skip: !LIVE }, async t => {
  const net = await import('node:net');
  const held = [];
  const server = net.createServer(s => { s.on('error', () => {}); held.push(s); }); // accepts, never answers (the end of git resets it)
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { held.forEach(s => s.destroy()); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/stalled.git`;
  const runner = new Runner({ jobHost: LIVE, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const script = `$p = Start-Process -FilePath 'C:\\Program Files\\Git\\cmd\\git.exe' -ArgumentList @('ls-remote','${url}') -NoNewWindow -PassThru; [Console]::Out.Write($p.Id); $p.WaitForExit()`;
  const started = Date.now();
  const r = await runner.run(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 5_000 });
  assert.deepEqual([r.timedOut, r.tree], [true, 'zero']);
  assert.ok(Date.now() - started < 5_000 + 30_000, 'ended at the limit, drained within the host\'s 30 s');
  assert.equal(alive(Number(r.stdout)), false, 'the hanging git is gone');
  assert.equal(runner.busy, false);
});

test('live: wsl, powershell and git chains end inside the job (the companion\'s real children)', { skip: !LIVE || process.env.CLUED_JOB_HOST_WSL !== '1' }, async () => {
  const runner = new Runner({ jobHost: LIVE, env: { ...process.env } });
  const w = await runner.run(['C:\\Windows\\System32\\wsl.exe', '--distribution', 'Ubuntu-24.04', '--exec', '/bin/echo', 'hi'], { timeoutMs: 60_000 });
  assert.deepEqual([w.code, w.stdout.trim()], [0, 'hi']);
  const slow = await runner.run(['C:\\Windows\\System32\\wsl.exe', '--distribution', 'Ubuntu-24.04', '--exec', '/bin/sleep', '30'], { timeoutMs: 3_000 });
  assert.deepEqual([slow.timedOut, slow.tree], [true, 'zero']);
  const g = await runner.run(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-Command', "& 'C:\\Program Files\\Git\\cmd\\git.exe' --version"], { timeoutMs: 60_000 });
  assert.deepEqual([g.code, /^git version /.test(g.stdout), 'tree' in g], [0, true, false]);
});
