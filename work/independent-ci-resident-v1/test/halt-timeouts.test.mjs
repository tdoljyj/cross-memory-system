// DESIGN §44 (Tasks 576231fa, 4d3aaa64, 8e1f07d3, the remainder): a wsl.exe, git or systemctl call that only ran out of time is
// asked again where that is read-only or idempotent, before "no answer" becomes a failure that HALTs. Nothing here repeats an
// action with an effect: a worker start is never run twice, a workspace preparation never again, and a failed head stays burned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMPANION_CONFIG_CONTRACT, CHECK_REFS_SECOND_TRY_MAX_MS, Companion, READ_RETRIES, TERMINAL_NOANSWER_CAP_MS, WSPREP_QUIET_WAIT_MS,
  BUNDLE_BRANCH_ONLY_HINT, bundleRefusalLogEntry, retryLogEntry, timedOutGone, validateCompanionConfig } from '../src/companion.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { events, haltHint } from '../src/pr-status.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const BATCH = '0123456789abcdef-0123456789ab';
const JOB = 'e'.repeat(64);
const T0 = Date.parse('2026-11-04T10:00:00Z');
const REASON = 'formal-bridge-stage-deadline';

const TIMED_OUT = { code: null, stdout: '', stderr: '', timedOut: true, tree: 'zero' };
const TIMED_OUT_PLAIN = { code: null, stdout: '', stderr: '', timedOut: true };
const TIMED_OUT_LEFTOVER = { code: null, stdout: '', stderr: '', timedOut: true, tree: 'unconfirmed' };
const QUIET = { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
const BUSY = { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: false, containersZero: true }) };
const facts = (state, { invocation = '', mono = 0 } = {}) => ({ code: 0, stdout: `ActiveState=${state}\nInvocationID=${invocation}\nExecMainStartTimestampMonotonic=${mono}\n` });
const is = (a, ...words) => words.every(w => a.includes(w));

// A companion over a scripted host: script(argv, now) answers; every call is kept with the virtual time it began.
function rig({ script }) {
  const state = { now: T0, calls: [], logs: [] };
  const run = async a => { state.calls.push({ a, at: state.now - T0 }); return script(a, state.now - T0, state.calls.filter(c => c.a.join(' ') === a.join(' ')).length); };
  const c = new Companion({ cfg, mailbox: null, run, fileExists: async () => true, sleep: async ms => { state.now += ms; }, clock: () => state.now, log: async e => { state.logs.push(e); } });
  state.c = c;
  state.count = pred => state.calls.filter(x => pred(x.a)).length;
  return state;
}
const request = (kind, extra = {}) => ({ kind, batchId: BATCH, reason: REASON, jobId: JOB, deadline: new Date(T0 + 30 * 60_000).toISOString(), ...extra });

test('only a timeout whose child is gone counts as "no answer"; a tree the job host could not show gone, a refusal and an exit never do', () => {
  assert.equal(timedOutGone(TIMED_OUT), true);
  assert.equal(timedOutGone(TIMED_OUT_PLAIN), true);
  assert.equal(timedOutGone(TIMED_OUT_LEFTOVER), false);
  for (const r of [QUIET, { code: 1, stdout: '' }, { code: null, refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' }, { code: null, refused: 'JOB_HOST_UNCONFIRMED', tree: 'unconfirmed' }, null, undefined])
    assert.equal(timedOutGone(r), false);
  assert.equal(READ_RETRIES, 2);
});

test('quiescence is a read: two timeouts then an answer is that answer; three timeouts are "not quiet"; a leftover tree is asked once', async () => {
  const rg = rig({ script: (a, at, n) => (n <= 2 ? TIMED_OUT : QUIET) });
  assert.deepEqual(await rg.c.quiescence(BATCH), { linuxUnitsInactive: true, containersZero: true });
  assert.equal(rg.count(a => is(a, 'quiescence')), 3);
  assert.deepEqual(rg.logs.map(e => [e.kind, e.op, e.attempt]), [['retry', 'quiescence', 1], ['retry', 'quiescence', 2]]);
  const never = rig({ script: () => TIMED_OUT });
  assert.deepEqual(await never.c.quiescence(BATCH), { linuxUnitsInactive: false, containersZero: false });
  assert.equal(never.count(a => is(a, 'quiescence')), 3, 'bounded: three reads in all');
  const leftover = rig({ script: () => TIMED_OUT_LEFTOVER });
  assert.deepEqual(await leftover.c.quiescence(BATCH), { linuxUnitsInactive: false, containersZero: false });
  assert.equal(leftover.count(a => is(a, 'quiescence')), 1, 'a child that may still run is never asked on top of itself');
  const definite = rig({ script: () => BUSY });
  await definite.c.quiescence(BATCH);
  assert.equal(definite.count(a => is(a, 'quiescence')), 1, 'a definite "not quiet" is an answer, not a timeout');
});

test('archive-linux: a start --wait that only timed out is asked once more (the tool replays the earlier result); the receipt still decides', async () => {
  const status = { code: 0, stdout: JSON.stringify({ verified: true, directory: 'failed-0123456789ab-formal-bridge-stage-deadline-aaaaaaaaaaaa' }) };
  const rg = rig({ script: (a, at, n) => (is(a, 'start', '--wait') ? (n === 1 ? TIMED_OUT : { code: 0, stdout: '' }) : is(a, 'archive-status') ? status : QUIET) });
  const r = await rg.c.handle(request('archive-linux'));
  assert.equal(r.ok, true); assert.equal(r.verified, true);
  assert.equal(rg.count(a => is(a, 'start', '--wait')), 2);
  // Both timed out: not verified, and no third start.
  const both = rig({ script: (a) => (is(a, 'start', '--wait') ? TIMED_OUT : status) });
  const b = await both.c.handle(request('archive-linux'));
  assert.equal(b.ok, false); assert.equal(b.code, 'LINUX_ARCHIVE_UNCONFIRMED');
  assert.equal(both.count(a => is(a, 'start', '--wait')), 2);
  // An exit code that is not 0 is not a timeout: no second start (a refused archive stays refused).
  const refused = rig({ script: (a) => (is(a, 'start', '--wait') ? { code: 1, stdout: '' } : status) });
  assert.equal((await refused.c.handle(request('archive-linux'))).ok, false);
  assert.equal(refused.count(a => is(a, 'start', '--wait')), 1);
  // The status read is a read: two timeouts then the receipt.
  const slow = rig({ script: (a, at, n) => (is(a, 'start', '--wait') ? { code: 0, stdout: '' } : is(a, 'archive-status') ? (n <= 2 ? TIMED_OUT : status) : QUIET) });
  assert.equal((await slow.c.handle(request('archive-linux'))).verified, true);
  // A start that ended 0 with a status that never answers is still not verified.
  const mute = rig({ script: (a) => (is(a, 'start', '--wait') ? { code: 0, stdout: '' } : TIMED_OUT) });
  assert.equal((await mute.c.handle(request('archive-linux'))).ok, false);
});

test('check-refs: only a definite answer ends the gate; a read without one is asked once more, never more than twice, and never after a long first read', async () => {
  const unchanged = { code: 0, stdout: JSON.stringify({ status: 'REMOTE_REFS_UNCHANGED' }) };
  const changed = { code: 0, stdout: JSON.stringify({ status: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' }) };
  const unreachable = { code: 1, stdout: '' };
  const second = rig({ script: (a, at, n) => (n === 1 ? unreachable : unchanged) });
  assert.deepEqual(await second.c.handle(request('check-refs')), { ok: true, code: null });
  assert.equal(second.count(a => a.includes('-CheckRefs')), 2);
  const moved = rig({ script: () => changed });
  assert.deepEqual(await moved.c.handle(request('check-refs')), { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' });
  assert.equal(moved.count(a => a.includes('-CheckRefs')), 1, 'a definite "changed" is never asked again');
  const movedSecond = rig({ script: (a, at, n) => (n === 1 ? TIMED_OUT : changed) });
  assert.equal((await movedSecond.c.handle(request('check-refs'))).code, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  const none = rig({ script: () => unreachable });
  assert.deepEqual(await none.c.handle(request('check-refs')), { ok: false, code: 'REMOTE_REFS_UNAVAILABLE' });
  assert.equal(none.count(a => a.includes('-CheckRefs')), 2);
  // A first read that took longer than the bound: no second one.
  const long = rig({ script: () => unreachable });
  const slowRun = long.c.run;
  long.c.run = async (a, o) => { long.now += CHECK_REFS_SECOND_TRY_MAX_MS + 1; return slowRun(a, o); };
  assert.equal((await long.c.handle(request('check-refs'))).code, 'REMOTE_REFS_UNAVAILABLE');
  assert.equal(long.count(a => a.includes('-CheckRefs')), 1);
  const leftover = rig({ script: () => TIMED_OUT_LEFTOVER });
  await leftover.c.handle(request('check-refs'));
  assert.equal(leftover.count(a => a.includes('-CheckRefs')), 1);
});

test('prepare-workspaces: a start --wait that timed out only waits for quiet (reads); quiet is the ordinary refusal, busy stays UNCONFIRMED; no second start, ever', async () => {
  const quietAfter = ms => (a, at) => (is(a, 'start', '--wait') ? TIMED_OUT : at >= ms ? QUIET : BUSY);
  const settles = rig({ script: quietAfter(70_000) });
  const r = await settles.c.handle(request('prepare-workspaces'));
  assert.equal(r.ok, false); assert.equal(r.code, 'WORKSPACE_PREPARATION_REFUSED');
  assert.deepEqual(r.proof, { linuxUnitsInactive: true, containersZero: true });
  assert.equal(settles.count(a => is(a, 'start', '--wait')), 1, 'the preparation is never started a second time');
  const busy = rig({ script: () => (true ? TIMED_OUT : null) });
  busy.c.run = async a => { busy.calls.push({ a, at: busy.now - T0 }); return is(a, 'start', '--wait') ? TIMED_OUT : BUSY; };
  const b = await busy.c.handle(request('prepare-workspaces'));
  assert.equal(b.code, 'WORKSPACE_PREPARATION_UNCONFIRMED');
  assert.ok(busy.now - T0 >= WSPREP_QUIET_WAIT_MS - 20_000 && busy.now - T0 <= WSPREP_QUIET_WAIT_MS + 60_000, `waited about the bound, not forever (${busy.now - T0})`);
  assert.equal(busy.count(a => is(a, 'start', '--wait')), 1);
  // A preparation that failed on its own (exit 1) with the Linux side not quiet does not wait: as before.
  const failed = rig({ script: () => ({ code: 1, stdout: '' }) });
  failed.c.run = async a => { failed.calls.push({ a, at: failed.now - T0 }); return is(a, 'start', '--wait') ? { code: 1, stdout: '' } : BUSY; };
  assert.equal((await failed.c.handle(request('prepare-workspaces'))).code, 'WORKSPACE_PREPARATION_UNCONFIRMED');
  assert.equal(failed.now - T0, 0);
  // Success is success.
  const ok = rig({ script: () => QUIET });
  ok.c.run = async a => (is(a, 'start', '--wait') ? { code: 0, stdout: '' } : QUIET);
  assert.equal((await ok.c.handle(request('prepare-workspaces'))).ok, true);
  // The wait never runs past the request's own deadline.
  const tight = rig({ script: () => BUSY });
  tight.c.run = async a => { tight.calls.push({ a, at: tight.now - T0 }); return is(a, 'start', '--wait') ? TIMED_OUT : BUSY; };
  await tight.c.handle(request('prepare-workspaces', { deadline: new Date(T0 + 90_000).toISOString() }));
  assert.ok(tight.now - T0 <= 90_000, 'bounded by the deadline');
});

// ---- the pump ----

async function pump(t, { start, unitFacts, listing = () => '' }) {
  const root = await tempRoot(t);
  const state = { now: T0, calls: [] };
  const box = await Mailbox.open(root, () => state.now);
  const run = async a => {
    state.calls.push(a);
    if (a.some(x => x.includes('-Mode'))) return ['SendIssue', 'ReceiveResult'].includes(a[a.indexOf('-Mode') + 1]) ? { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) } : { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
    if (is(a, 'start', '--no-block')) return start(state.now - T0);
    if (a.some(x => x.startsWith('--property=ActiveState'))) return unitFacts(state.now - T0);
    if (a.includes('/usr/bin/ls')) return { code: 0, stdout: listing(state.now - T0) };
    return QUIET;
  };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async p => p.includes('\\outgoing\\'), sleep: async ms => { state.now += ms; }, clock: () => state.now });
  const req = await box.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 45 * 60_000);
  await c.step();
  return { res: await box.poll(req), state, starts: state.calls.filter(a => is(a, 'start', '--no-block')).length };
}

test('worker start that timed out: the unit\'s facts decide, the start is never repeated; evidence that it ran makes the pump go on', async t => {
  const ran = await pump(t, { start: () => TIMED_OUT, unitFacts: ms => (ms < 30_000 ? facts('active', { invocation: 'a'.repeat(32), mono: 5 }) : facts('inactive', { invocation: 'a'.repeat(32), mono: 5 })),
    listing: ms => (ms < 20_000 ? '' : 'result.json\nresult.ready.json\n') });
  assert.equal(ran.res.ok, true, JSON.stringify(ran.res));
  assert.equal(ran.starts, 1, 'a second start would run the worker again');
  const none = await pump(t, { start: () => TIMED_OUT, unitFacts: () => facts('inactive') });
  assert.equal(none.res.ok, false); assert.equal(none.res.code, 'LINUX_WORKER_START_UNCONFIRMED', 'no evidence: as before');
  assert.equal(none.starts, 1);
  const unreadable = await pump(t, { start: () => TIMED_OUT, unitFacts: () => TIMED_OUT });
  assert.equal(unreadable.res.code, 'LINUX_WORKER_START_UNCONFIRMED');
  assert.equal(unreadable.starts, 1);
  // A start that exited non-zero is a refusal: its facts are not even read for it.
  const refused = await pump(t, { start: () => ({ code: 1, stdout: '' }), unitFacts: () => facts('active', { invocation: 'a'.repeat(32), mono: 5 }) });
  assert.equal(refused.res.code, 'LINUX_WORKER_START_UNCONFIRMED');
});

test('the worker\'s end: reads without an answer are waited out up to the cap; a unit read as still busy keeps the 30 s', async t => {
  const resultNow = ms => (ms < 1000 ? '' : 'result.json\nresult.ready.json\n');
  // Unit facts do not answer for the first 100 s after the result arrived, then say inactive.
  const slowReads = await pump(t, { start: () => ({ code: 0, stdout: '' }), listing: resultNow,
    unitFacts: ms => (ms < 1000 ? facts('active', { invocation: 'a'.repeat(32), mono: 5 }) : ms < 100_000 ? TIMED_OUT : facts('inactive', { invocation: 'a'.repeat(32), mono: 5 })) });
  assert.equal(slowReads.res.ok, true, JSON.stringify(slowReads.res));
  assert.ok(slowReads.state.now - T0 < TERMINAL_NOANSWER_CAP_MS + 20_000);
  // Never an answer: gives up at the cap, not later.
  const mute = await pump(t, { start: () => ({ code: 0, stdout: '' }), listing: resultNow, unitFacts: ms => (ms < 1000 ? facts('active', { invocation: 'a'.repeat(32), mono: 5 }) : TIMED_OUT) });
  assert.equal(mute.res.code, 'FORMAL_WORKER_TERMINAL_UNCONFIRMED');
  assert.ok(mute.state.now - T0 >= TERMINAL_NOANSWER_CAP_MS - 20_000 && mute.state.now - T0 <= TERMINAL_NOANSWER_CAP_MS + 40_000, `${mute.state.now - T0}`);
  // A unit that is read and still active: the 30 s of before.
  const busy = await pump(t, { start: () => ({ code: 0, stdout: '' }), listing: resultNow, unitFacts: () => facts('active', { invocation: 'a'.repeat(32), mono: 5 }) });
  assert.equal(busy.res.code, 'FORMAL_WORKER_TERMINAL_UNCONFIRMED');
  assert.ok(busy.state.now - T0 <= 60_000, `${busy.state.now - T0}`);
});

// ---- evidence and the recovery hint ----

test('retry log entries have fixed keys, codes and counts only', () => {
  const e = retryLogEntry({ at: T0, op: 'quiescence', attempt: 2, ms: 30_000, runner: { ...TIMED_OUT, stdout: 'C:\\Users\\secret', stderr: 'token ghp_x' } });
  assert.deepEqual(Object.keys(e).sort(), ['at', 'attempt', 'kind', 'ms', 'op', 'runner'].sort());
  assert.deepEqual(e.runner, { code: null, timedOut: true, tree: 'zero', refused: null });
  assert.equal(JSON.stringify(e).includes('secret'), false);
  assert.equal(retryLogEntry({ at: T0, op: 'x', attempt: 1, ms: 1, runner: { refused: 'free text here' } }).runner.refused, null);
});

test('the HALT notice names what to read before the Owner re-arms, for timeout-shaped codes only', () => {
  const now = Date.parse('2026-11-04T10:00:00Z');
  const status = code => ({ writtenAt: now, current: null, halt: { code, at: '2026-11-04T09:59:00Z' }, pending: [], notices: [] });
  const body = code => events({ status: status(code), now }).find(e => e.key.startsWith('halt:')).body;
  for (const code of ['FAILURE_ARCHIVE_UNCONFIRMED', 'UNEXECUTED_CLOSE_UNCONFIRMED', 'WORKSPACE_PREPARATION_UNCONFIRMED', 'FORMAL_WORKER_TERMINAL_UNCONFIRMED', 'STAGE_INVOKER_TERMINAL_UNCONFIRMED', 'COMPANION_REQUEST_EXPIRED']) {
    assert.ok(haltHint(code).length > 20, code);
    assert.ok(body(code).startsWith(`原因：${code}。需要 Owner 复位（rearm）后才会继续。`) && body(code).endsWith(haltHint(code)), code);
    assert.match(haltHint(code), /只读|确认/);
  }
  assert.equal(haltHint('SOMETHING_ELSE'), ''); assert.equal(haltHint('constructor'), ''); assert.equal(haltHint(null), '');
  assert.equal(body('PUBLICATION_UNCERTAIN'), '原因：PUBLICATION_UNCERTAIN。需要 Owner 复位（rearm）后才会继续。', 'other codes read as before');
});

// DESIGN 52 (Decision 98fec682): the hint of build-bundle.ps1's refusal reaches the operator through the companion log, and only when it is
// exactly the fixed text; every other hint is dropped.
const HINT = BUNDLE_BRANCH_ONLY_HINT;
const refusal = (extra = {}) => ({ code: 2, stdout: JSON.stringify({ status: 'REFUSED_BEFORE_WRITE', stage: 'fetch-reviewed-commits-by-sha', reason: 'GIT_STEP_FAILED', hint: HINT,
  git: { label: 'fetch-reviewed', exitCode: 128 }, created: ['C:\\secret\\path'], ...extra }), stderr: 'token ghp_x' });

test('the fixed hint is the same text in build-bundle.ps1 and in the companion', () => {
  const ps = fs.readFileSync(new URL('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');
  const m = /\$branchOnly=@\{'d94cd486e29a7362888fc32cd807ceb38890acb6'='([^']+)'\}/.exec(ps);
  assert.ok(m, 'the script defines the fixed text for d94cd486');
  assert.equal(m[1], BUNDLE_BRANCH_ONLY_HINT);
  assert.match(ps, / return \$branchOnly\[\$hit\[0\]\]\n/, 'the script returns the table text unchanged');
});

test('a build-bundle refusal with the fixed hint is answered BUNDLE_UNAVAILABLE as before and logs only the reason and that hint', async () => {
  for (const [kind, op] of [['build-bundle', 'build-bundle'], ['rebuild-bundle', 'rebuild-bundle']]) {
    const rg = rig({ script: () => refusal() });
    assert.deepEqual(await rg.c.handle(request(kind)), { ok: false, code: 'BUNDLE_UNAVAILABLE' });
    assert.equal(rg.logs.length, 1, kind);
    assert.deepEqual(rg.logs[0], { at: new Date(T0).toISOString(), kind: 'bundle-refusal', op, reason: 'GIT_STEP_FAILED', hint: HINT });
    assert.equal(JSON.stringify(rg.logs[0]).includes('secret'), false);
    assert.equal(JSON.stringify(rg.logs[0]).includes('ghp_'), false);
  }
});

test('any hint that is not exactly the fixed text is dropped, whatever characters it has; a refusal without one logs nothing', async () => {
  for (const extra of [{ hint: undefined }, { hint: null }, { hint: '' }, { hint: HINT + ' ' }, { hint: ' ' + HINT }, { hint: HINT.toLowerCase() }, { hint: HINT.slice(0, -1) },
    { hint: HINT + HINT }, { hint: 5 }, { hint: [HINT] }, { hint: { text: HINT } },
    { hint: 'C:/Users/x/AppData/token' }, { hint: 'https://github.com/org/repo' }, { hint: 'https://example.invalid/a' },
    { hint: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD' }, { hint: 'line one\nline two' }, { hint: 'C:\\Users\\x' }, { hint: '<script>' },
    { hint: 'The reviewed set contains d94cd486 (and its parent 8ea4da40), which is reachable only from branch other-branch until PR #991 is merged' }]) {
    const rg = rig({ script: () => refusal(extra) });
    assert.deepEqual(await rg.c.handle(request('build-bundle')), { ok: false, code: 'BUNDLE_UNAVAILABLE' });
    assert.deepEqual(rg.logs, [], JSON.stringify(extra).slice(0, 60));
  }
  assert.equal(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: { code: 1, stdout: refusal().stdout } }), null, 'only the script\'s own refusal exit');
  assert.equal(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: { code: 2, stdout: 'not json' } }), null);
  assert.equal(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: null }), null);
  assert.equal(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: { code: 2, stdout: refusal({ reason: 'free text' }).stdout } }).reason, null);
  const ok = rig({ script: () => ({ code: 0, stdout: JSON.stringify({ status: 'BUNDLE_WRITTEN', generation: 2, hint: HINT }) }) });
  assert.deepEqual(await ok.c.handle(request('build-bundle')), { ok: true, code: null });
  assert.deepEqual(ok.logs, []);
});

test('a failing log never changes the answer of a refused build-bundle', async () => {
  const state = { now: T0 };
  const c = new Companion({ cfg, mailbox: null, run: async () => refusal(), fileExists: async () => true, sleep: async () => {}, clock: () => state.now, log: async () => { throw new Error('disk full'); } });
  assert.deepEqual(await c.handle(request('build-bundle')), { ok: false, code: 'BUNDLE_UNAVAILABLE' });
});
