// DESIGN §44 (Tasks 576231fa, 4d3aaa64, 8e1f07d3, the remainder): a wsl.exe, git or systemctl call that only ran out of time is
// asked again where that is read-only or idempotent, before "no answer" becomes a failure that HALTs. Nothing here repeats an
// action with an effect: a worker start is never run twice, a workspace preparation never again, and a failed head stays burned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMPANION_CONFIG_CONTRACT, CHECK_REFS_SECOND_TRY_MAX_MS, Companion, READ_RETRIES, TERMINAL_NOANSWER_CAP_MS, WSPREP_QUIET_WAIT_MS,
  BUNDLE_BRANCH_ONLY_HINTS, BUNDLE_MEMBER_MOVED_REASONS, BUNDLE_NETWORK_STEPS, BUNDLE_NETWORK_UNAVAILABLE, TRAIN_BATCH_MEMBER_MOVED, bundleNetworkRefusal, bundleRefusalLogEntry, retryLogEntry, timedOutGone, validateCompanionConfig } from '../src/companion.mjs';
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
const QUIET = { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) };
const BUSY = { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: false, containersZero: true, pendingJobsQuiet: true }) };
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

// DESIGN 52 (Decision 98fec682): the hint of build-bundle.ps1's refusal reaches the operator through the companion log, and only when it is one
// of the fixed texts (none listed since PR #991 merged); every other hint is dropped.
// The former fixed text for d94cd486 (DESIGN 52), dropped since PR #991 merged it into main.
const HINT = 'The reviewed set contains d94cd486 (and its parent 8ea4da40), which is reachable only from branch claude/gitleaks-midgen-reviewed-hold until PR #991 is merged: if that branch was deleted or rewritten, restore it.';
const refusal = (extra = {}) => ({ code: 2, stdout: JSON.stringify({ status: 'REFUSED_BEFORE_WRITE', stage: 'fetch-reviewed-commits-by-sha', reason: 'GIT_STEP_FAILED', hint: HINT,
  git: { label: 'fetch-reviewed', exitCode: 128 }, created: ['C:\\secret\\path'], ...extra }), stderr: 'token ghp_x' });

test('no reviewed commit is kept alive by a branch only any more: the script table and the companion list are both empty', () => {
  const ps = fs.readFileSync(new URL('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');
  assert.match(ps, /\n \$branchOnly=@\{\}\r?\n/, 'the script lists no commit');
  assert.deepEqual(BUNDLE_BRANCH_ONLY_HINTS, []);
  assert.match(ps, / return \$branchOnly\[\$hit\[0\]\]\r?\n/, 'the lookup still goes through the (empty) table');
});

// What a refused build looks like in the companion log (generation 10, DESIGN 53.1): the codes and counts of the refusal, nothing else.
const entryOf = (op, extra = {}) => ({ at: new Date(T0).toISOString(), kind: 'bundle-refusal', op, runner: { code: 2, timedOut: false, tree: null, refused: null },
  status: 'REFUSED_BEFORE_WRITE', reason: 'GIT_STEP_FAILED', stage: 'fetch-reviewed-commits-by-sha', git: { label: 'fetch-reviewed', exitCode: 128, stderrChars: null },
  storeAttempts: null, failedAttempts: null, seed: null, hint: null, ...extra });
const leaks = e => ['secret', 'ghp_', 'C:\\', 'https:', 'token', 'refs/heads', 'unable'].filter(x => JSON.stringify(e).includes(x));

test('a build-bundle refusal (here with the former d94cd486 hint) is answered BUNDLE_UNAVAILABLE as before and logs its codes, the hint dropped', async () => {
  // (generation 10: the fixture's failing step is fetch-reviewed, after the whole fetch and the ls-remote succeeded: not the line)
  for (const [kind, op, code] of [['build-bundle', 'build-bundle', 'BUNDLE_UNAVAILABLE'], ['rebuild-bundle', 'rebuild-bundle', 'BUNDLE_UNAVAILABLE']]) {
    const rg = rig({ script: () => refusal() });
    assert.deepEqual(await rg.c.handle(request(kind)), { ok: false, code });
    assert.equal(rg.logs.length, 1, kind);
    assert.deepEqual(rg.logs[0], entryOf(op));
    assert.deepEqual(leaks(rg.logs[0]), []);
  }
});

test('generation 10: a network refusal logs reason, stage, the git step and every given-up attempt as codes and counts, never output text', async () => {
  // The shape of build-bundle.ps1's refusal (test-build-bundle.ps1 network-down-*: GitHub unreachable, the retry seeded).
  const down = { status: 'PARTIAL_STATE_PRESERVED_NO_RETRY', stage: 'fetch-all-heads-and-tags', reason: 'GIT_STEP_FAILED', hint: null,
    git: { label: 'fetch', exitCode: 128, stderrChars: 97 }, created: ['C:\\ProgramData\\CluedIndependentCI\\resident\\bundles\\b\\fetch.git'], storeAttempts: 2,
    firstAttempt: { stage: 'fetch-all-heads-and-tags', git: { label: 'fetch', exitCode: 128, stderrChars: 97 }, failedAfterSeconds: 3 },
    failedAttempts: [{ attempt: 1, reason: 'GIT_STEP_FAILED', stage: 'fetch-all-heads-and-tags', git: { label: 'fetch', exitCode: 128, stderrChars: 97 }, failedAfterSeconds: 3 }],
    seed: { enabled: true, used: true, reason: 'SEEDED_AFTER_NETWORK_FAILURE', discarded: false, primeSeconds: 21, updated: false, updateSkipped: null, seedBytes: null,
      error: 'fatal: unable to access https://github.com/x | fetch 128', networkFailureNoted: true },
    credentialsPrinted: false, existingCheckoutTouched: false, automaticRetryAllowed: false };
  const rg = rig({ script: () => ({ code: 2, stdout: JSON.stringify(down), stderr: 'fatal: unable to access https://github.com/x token ghp_x' }) });
  assert.deepEqual(await rg.c.handle(request('build-bundle')), { ok: false, code: 'BUNDLE_NETWORK_UNAVAILABLE' });
  assert.deepEqual(rg.logs, [{ at: new Date(T0).toISOString(), kind: 'bundle-refusal', op: 'build-bundle', runner: { code: 2, timedOut: false, tree: null, refused: null },
    status: 'PARTIAL_STATE_PRESERVED_NO_RETRY', reason: 'GIT_STEP_FAILED', stage: 'fetch-all-heads-and-tags', git: { label: 'fetch', exitCode: 128, stderrChars: 97 }, storeAttempts: 2,
    failedAttempts: [{ attempt: 1, reason: 'GIT_STEP_FAILED', stage: 'fetch-all-heads-and-tags', git: { label: 'fetch', exitCode: 128, stderrChars: 97 }, failedAfterSeconds: 3, refsDiffer: null }],
    seed: { used: true, reason: 'SEEDED_AFTER_NETWORK_FAILURE', discarded: false, networkFailureNoted: true }, hint: null }]);
  assert.deepEqual(leaks(rg.logs[0]), []);
  // A refs race keeps only its count; at most three attempts; a value off its pattern is null.
  const odd = bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: { code: 2, stdout: JSON.stringify({ ...down, stage: 'Fetch All', reason: 'free text', git: { label: '../x', exitCode: 'x', stderrChars: -1 },
    storeAttempts: 2.5, failedAttempts: [{ attempt: 1, reason: 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE', stage: 'fetched-store-readback', git: null, failedAfterSeconds: 4, refsDiffer: { count: 2, refs: ['refs/heads/secret-name'] } },
      'junk', {}, { attempt: 4 }], seed: { used: 'yes', reason: 'not a code' } }) } });
  assert.deepEqual([odd.stage, odd.reason, odd.git, odd.storeAttempts, odd.failedAttempts.length], [null, null, { label: null, exitCode: null, stderrChars: null }, null, 3]);
  assert.deepEqual(odd.failedAttempts[0], { attempt: 1, reason: 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE', stage: 'fetched-store-readback', git: null, failedAfterSeconds: 4, refsDiffer: 2 });
  assert.deepEqual(odd.failedAttempts.slice(1), [null, { attempt: null, reason: null, stage: null, git: null, failedAfterSeconds: null, refsDiffer: null }]);
  assert.deepEqual(odd.seed, { used: false, reason: null, discarded: false, networkFailureNoted: false });
  assert.deepEqual(leaks(odd), []);
});

test('any hint is dropped, whatever characters it has (no fixed text is listed); the refusal is still logged with hint null', async () => {
  for (const extra of [{ hint: undefined }, { hint: null }, { hint: '' }, { hint: HINT + ' ' }, { hint: ' ' + HINT }, { hint: HINT.toLowerCase() }, { hint: HINT.slice(0, -1) },
    { hint: HINT + HINT }, { hint: 5 }, { hint: [HINT] }, { hint: { text: HINT } },
    { hint: 'C:/Users/x/AppData/token' }, { hint: 'https://github.com/org/repo' }, { hint: 'https://example.invalid/a' },
    { hint: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD' }, { hint: 'line one\nline two' }, { hint: 'C:\\Users\\x' }, { hint: '<script>' },
    { hint: 'The reviewed set contains d94cd486 (and its parent 8ea4da40), which is reachable only from branch other-branch until PR #991 is merged' }]) {
    const rg = rig({ script: () => refusal(extra) });
    assert.deepEqual(await rg.c.handle(request('build-bundle')), { ok: false, code: 'BUNDLE_UNAVAILABLE' });
    assert.deepEqual(rg.logs, [entryOf('build-bundle', { hint: null })], JSON.stringify(extra).slice(0, 60));
    assert.deepEqual(leaks(rg.logs[0]), []);
  }
  // An answer that is no refusal JSON, or no answer at all, is still one entry: the runner's own facts, every script field null.
  const bare = { status: null, reason: null, stage: null, git: null, storeAttempts: null, failedAttempts: null, seed: null, hint: null };
  assert.deepEqual(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: { code: 2, stdout: 'not json' } }), { at: new Date(T0).toISOString(), kind: 'bundle-refusal', op: 'build-bundle',
    runner: { code: 2, timedOut: false, tree: null, refused: null }, ...bare });
  assert.deepEqual(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: { code: null, timedOut: true, tree: 'unconfirmed', stdout: '' } }).runner, { code: null, timedOut: true, tree: 'unconfirmed', refused: null });
  assert.deepEqual(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: null }), { at: new Date(T0).toISOString(), kind: 'bundle-refusal', op: 'build-bundle',
    runner: { code: null, timedOut: false, tree: null, refused: null }, ...bare });
  assert.equal(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: { code: 2, stdout: 'x'.repeat(65_537) } }).status, null, 'an oversized answer is not parsed');
  assert.equal(bundleRefusalLogEntry({ at: T0, op: 'build-bundle', runner: { code: 2, stdout: refusal({ reason: 'free text' }).stdout } }).reason, null);
  const ok = rig({ script: () => ({ code: 0, stdout: JSON.stringify({ status: 'BUNDLE_WRITTEN', generation: 2, hint: HINT }) }) });
  assert.deepEqual(await ok.c.handle(request('build-bundle')), { ok: true, code: null });
  assert.deepEqual(ok.logs, []);
});

test('generation 10: every failedAttempts/seed key the companion logs is one build-bundle.ps1 writes', () => {
  const ps = fs.readFileSync(new URL('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');
  assert.match(ps, /\$given=\[ordered\]@\{attempt=\(\$n\+1\);reason=\$reason;stage=\$script:stage;git=\$script:lastGit;failedAfterSeconds=\[int\]\$elapsed\}/);
  assert.match(ps, /\$script:lastGit=\[ordered\]@\{label=\$Label;exitCode=\$p\.ExitCode;stderrChars=\$err\.Length\}/);
  assert.match(ps, /\$seedReport=\[ordered\]@\{enabled=\$true;used=\$false;reason=\$null;discarded=\$false;[^}]*networkFailureNoted=\$false\}/);
  // generation 13 (DESIGN 57.3): setAside sits between created and the counts
  assert.match(ps, /stage=\$stage;reason=\$code;hint=[^\n]+;git=\$lastGit;created=\$created;setAside=\$setAside\n  storeAttempts=\$attempts;firstAttempt=\$firstAttempt;failedAttempts=@\(\$failedAttempts\);seed=\$seedReport;/);
});

test('a failing log never changes the answer of a refused build-bundle', async () => {
  const state = { now: T0 };
  const c = new Companion({ cfg, mailbox: null, run: async () => refusal(), fileExists: async () => true, sleep: async () => {}, clock: () => state.now, log: async () => { throw new Error('disk full'); } });
  assert.deepEqual(await c.handle(request('build-bundle')), { ok: false, code: 'BUNDLE_UNAVAILABLE' });
});

test('generation 10: only a GitHub step that failed in git is BUNDLE_NETWORK_UNAVAILABLE; every other refusal or no answer stays BUNDLE_UNAVAILABLE', async () => {
  const ps = fs.readFileSync(new URL('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');
  const m = /\$NetworkSteps=@\(([^)]*)\)/.exec(ps);
  const steps = m[1].split(',').map(x => x.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(steps, ['fetch', 'ls-remote', 'fetch-reviewed', 'fetch-test', 'ls-remote-members']);
  assert.deepEqual([...BUNDLE_NETWORK_STEPS], ['fetch', 'ls-remote'], 'the steps before any by-SHA fetch; all of them are steps the script retries');
  assert.ok(BUNDLE_NETWORK_STEPS.every(s => steps.includes(s)));
  // Build-Store runs the whole fetch and the ls-remote before the by-SHA fetches of the same attempt
  const store = ps.slice(ps.indexOf('function Build-Store'), ps.indexOf('function Retry-Allowed'));
  assert.ok(store.indexOf("Invoke-Git 'fetch'") < store.indexOf("Invoke-Git 'ls-remote'") && store.indexOf("Invoke-Git 'ls-remote'") < store.indexOf("Invoke-Git 'fetch-reviewed'")
    && store.indexOf("Invoke-Git 'fetch-reviewed'") < store.indexOf("Invoke-Git 'fetch-test'"));
  for (const label of BUNDLE_NETWORK_STEPS) assert.equal(bundleNetworkRefusal(refusal({ git: { label, exitCode: 128 } })), true, label);
  for (const r of [refusal(), refusal({ git: { label: 'fetch-test', exitCode: 128 } }), refusal({ git: { label: 'cat-file', exitCode: 128 } }), refusal({ git: { label: 'fetch', exitCode: 0 } }), refusal({ reason: 'REMOTE_MAIN_BASE_CHANGED' }),
    refusal({ reason: 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' }), refusal({ reason: 'REMOTE_REF_NAME_FAILS_FORMAL_VALIDATION', git: { label: 'fetch', exitCode: 0 } }), refusal({ git: null }),
    { code: 1, stdout: refusal().stdout }, { code: null, timedOut: true, stdout: '' }, { code: 2, stdout: 'x' }, null])
    assert.equal(bundleNetworkRefusal(r), false, JSON.stringify(r)?.slice(0, 120));
  for (const [script, code] of [[() => refusal({ reason: 'HEAD_BASE_SOURCE_COMMIT_MISSING', git: { label: 'cat-file', exitCode: 128 } }), 'BUNDLE_UNAVAILABLE'],
    [() => ({ code: null, timedOut: true, stdout: '' }), 'BUNDLE_UNAVAILABLE'], [() => refusal({ git: { label: 'ls-remote', exitCode: 128 } }), BUNDLE_NETWORK_UNAVAILABLE]]) {
    const rg = rig({ script });
    assert.deepEqual(await rg.c.handle(request('build-bundle')), { ok: false, code });
    assert.equal(rg.logs.length, 1, 'logged either way');
  }
});

test('ADR 0019 review 2: a batch member that moved on (its branch or its PR head) is TRAIN_BATCH_MEMBER_MOVED; every other chain refusal stays BUNDLE_UNAVAILABLE', async () => {
  const ps = fs.readFileSync(new URL('../../actions-hosted-migration/independent-ci-v1/src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');
  for (const reason of BUNDLE_MEMBER_MOVED_REASONS) assert.ok(ps.includes(`throw '${reason}'`), reason);
  for (const [script, code] of [[() => refusal({ reason: 'BATCH_MEMBER_NOT_BRANCH_TIP', git: null }), TRAIN_BATCH_MEMBER_MOVED],
    [() => refusal({ reason: 'BATCH_MEMBER_NOT_PR_HEAD', git: { label: 'ls-remote-members', exitCode: 0 } }), TRAIN_BATCH_MEMBER_MOVED],
    [() => refusal({ reason: 'BATCH_CHAIN_REQUIRED', git: null }), 'BUNDLE_UNAVAILABLE'], [() => refusal({ reason: 'BATCH_TEST_TREE_CHANGED', git: null }), 'BUNDLE_UNAVAILABLE'],
    [() => refusal({ reason: 'BATCH_MEMBER_COMMIT_MISSING', git: null }), 'BUNDLE_UNAVAILABLE'], [() => refusal({ reason: 'GIT_STEP_FAILED', git: { label: 'ls-remote-members', exitCode: 128 } }), 'BUNDLE_UNAVAILABLE'],
    [() => ({ code: 1, stdout: refusal({ reason: 'BATCH_MEMBER_NOT_PR_HEAD' }).stdout }), 'BUNDLE_UNAVAILABLE'],
    [() => ({ code: 0, stdout: JSON.stringify({ status: 'REFUSED_BEFORE_WRITE', reason: 'BATCH_MEMBER_NOT_PR_HEAD' }) }), 'BUNDLE_UNAVAILABLE'],
    [() => ({ code: 2, stdout: JSON.stringify({ status: 'BUNDLE_WRITTEN' }) }), 'BUNDLE_UNAVAILABLE']]) {
    const rg = rig({ script });
    assert.deepEqual(await rg.c.handle(request('build-bundle')), { ok: false, code }, String(script));
  }
});

test('generation 13: the second bundle answers BUNDLE_NETWORK_UNAVAILABLE for a failed GitHub step too; refs that moved stay REMOTE_REFS_CHANGED_SINCE_BUNDLE', async () => {
  for (const [script, code] of [[() => refusal({ git: { label: 'fetch', exitCode: 128 } }), BUNDLE_NETWORK_UNAVAILABLE],
    [() => refusal({ git: { label: 'ls-remote', exitCode: 128 } }), BUNDLE_NETWORK_UNAVAILABLE],
    [() => refusal({ reason: 'REMOTE_HEAD_MOVED', git: null }), 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'],
    [() => refusal({ git: { label: 'cat-file', exitCode: 128 } }), 'BUNDLE_UNAVAILABLE'], [() => ({ code: null, timedOut: true, stdout: '' }), 'BUNDLE_UNAVAILABLE']]) {
    const rg = rig({ script });
    assert.deepEqual(await rg.c.handle(request('rebuild-bundle')), { ok: false, code });
  }
});
