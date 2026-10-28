// Relay robustness (DESIGN §25; design r3 part one, Task 241de382): the attempt classification, the arrival and leftover
// checks, the bounded retries and their budgets, and the local relay log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Mailbox } from '../src/mailbox.mjs';
import { CALLBACK_WINDOW_MS, COMPANION_CONFIG_CONTRACT, Companion, LINUX_INCOMING, RELAY_ATTEMPTS, RELAY_RECORD_PROCESS, RELAY_TIMEOUT_MS,
  argv, classifyRelayAttempt, relayLogEntry, relayRecordName, stderrTail, validateCompanionConfig } from '../src/companion.mjs';
import { RELAY_LOG_MAX_BYTES, createRelayLog } from '../src/companion-main.mjs';
import { PUMP_CODES } from '../src/engine-windows.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\protected-job-bridge-v4\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const T0 = Date.parse('2026-10-28T12:00:00Z');
const out = v => JSON.stringify(v);
const receipt = fields => out({ contract: 'clued.independent-ci.formal-public-relay-receipt/2', status: 'BLOCKED', processId: 4242, exitCode: 1, terminalConfirmed: true,
  failureCode: null, childError: null, ...fields });
const OK = { code: 0, stdout: receipt({ status: 'PUBLIC_RECORD_TRANSFERRED', exitCode: 0 }) };
const NOT_YET = { code: 2, stdout: receipt({ failureCode: 'PUBLIC_CHILD_REFUSED_NO_RETRY', childError: { reason: 'ENOENT', stage: 'RECORD' } }) };
const VM_FLAP = { code: 2, stdout: receipt({ failureCode: 'PUBLIC_CHILD_EXIT_REFUSED_NO_RETRY' }), stderr: 'The Windows Subsystem for Linux instance has terminated.' };
const NO_WSL = { code: 2, stdout: receipt({ failureCode: 'PUBLIC_TRANSFER_UNCONFIRMED', processId: null, exitCode: null }) };
const CUT = { code: null, stdout: '', stderr: '', timedOut: true, tree: 'zero' };
const childError = (reason, stage) => ({ code: 2, stdout: receipt({ failureCode: 'PUBLIC_CHILD_REFUSED_NO_RETRY', childError: { reason, stage } }) });
const failure = code => ({ code: 2, stdout: receipt({ failureCode: code }) });

test('the classification table, row by row; anything it does not name is PERMANENT', () => {
  const c = (r, label) => classifyRelayAttempt(r, (() => { try { return JSON.parse(r.stdout); } catch { return null; } })(), label);
  const rows = [
    [OK, 'OK'], [NOT_YET, 'NOT_YET'],
    // NO_CHILD: the job host never started; it reported started:false with its job drained (no tree key); wsl.exe did not start
    [{ code: null, stdout: '', stderr: '', refused: 'RUNNER_SPAWN_FAILED' }, 'NO_CHILD'],
    [{ code: null, stdout: '', stderr: '', refused: 'JOB_HOST_UNCONFIRMED' }, 'NO_CHILD'],
    [NO_WSL, 'NO_CHILD'],
    // CHILD_FAILED: the child ran and failed at the wsl/VM layer, or with a transient errno in an early stage
    [VM_FLAP, 'CHILD_FAILED'],
    ...['EBUSY', 'EMFILE', 'ENFILE', 'EINTR', 'FORMAL_RELAY_STDIN_TIMEOUT'].flatMap(reason => ['OPERATION', 'CONTEXT', 'STDIN', 'TRANSPORT', 'PACKET']
      .map(stage => [childError(reason, stage), 'CHILD_FAILED'])),
    // AMBIGUOUS: may have written
    [CUT, 'AMBIGUOUS'],
    ...['PUBLIC_TERMINAL_UNCONFIRMED_LOCKS_RETAINED', 'PUBLIC_OUTPUT_UNCONFIRMED_NO_RETRY', 'PUBLIC_STDIN_UNCERTAIN_NO_RETRY'].map(f => [failure(f), 'AMBIGUOUS']),
    [childError('EEXIST', 'RECORD'), 'AMBIGUOUS'],
    [failure('EXISTING_RECORD_PRESERVED_NO_RETRY'), 'EXISTING'],
    // PERMANENT: a transient errno in a later stage, any other reason, identity and record failures, runner refusals
    ...['BINDING', 'RECORD', 'COMPLETE'].map(stage => [childError('EBUSY', stage), 'PERMANENT']),
    [childError('FIXED_FORMAL_RELAY_SEQUENCE_REQUIRED', 'OPERATION'), 'PERMANENT'],
    [childError('EACCES', 'TRANSPORT'), 'PERMANENT'],
    ...['FORMAL_SPOOL_ACL_REFUSED', 'PUBLIC_IMPORT_UNCONFIRMED_NO_RETRY', 'PUBLIC_READY_CHANGED', 'PUBLIC_RECORD_BYTES_CHANGED', 'EXACT_BRIDGE_SOURCE_REQUIRED', 'PUBLIC_CHILD_REFUSED_NO_RETRY']
      .map(f => [failure(f), 'PERMANENT']),
    // a child exit with stderr that relay-public could not read as a bridge refusal: childError is null but failureCode differs
    [{ code: 2, stdout: receipt({ failureCode: 'PUBLIC_CHILD_EXIT_REFUSED_NO_RETRY', childError: { reason: 'EBUSY', stage: 'RECORD' } }) }, 'PERMANENT'],
    [{ code: 2, stdout: receipt({ failureCode: 'PUBLIC_CHILD_EXIT_REFUSED_NO_RETRY', terminalConfirmed: false }) }, 'PERMANENT'],
    [{ code: 2, stdout: receipt({ failureCode: 'PUBLIC_TRANSFER_UNCONFIRMED', processId: 77, exitCode: null }) }, 'PERMANENT'],
    // a JOB_HOST_UNCONFIRMED that looks alike but carries a tree key; an unconfirmed tree; any other runner refusal
    [{ code: null, stdout: '', stderr: '', refused: 'JOB_HOST_UNCONFIRMED', tree: 'unconfirmed' }, 'PERMANENT'],
    [{ code: null, stdout: '', stderr: '', refused: 'JOB_HOST_UNCONFIRMED', tree: 'zero' }, 'PERMANENT'],
    [{ code: null, stdout: '', stderr: '', timedOut: true, tree: 'unconfirmed' }, 'PERMANENT'],
    [{ code: 0, stdout: receipt({ status: 'PUBLIC_RECORD_TRANSFERRED' }), tree: 'unconfirmed' }, 'PERMANENT'],
    ...['RUNNER_BUSY_WITH_UNFINISHED_CHILD', 'RUNNER_TIMEOUT_REFUSED', 'RUNNER_ARGV_REFUSED'].map(refused => [{ code: null, stdout: '', stderr: '', refused }, 'PERMANENT']),
    [{ code: 0, stdout: 'not json' }, 'PERMANENT'], [{ code: 0, stdout: '[]' }, 'PERMANENT'],
  ];
  for (const [r, want] of rows) assert.equal(c(r), want, `${want}: ${r.refused ?? ''} ${r.stdout}`);
});

// A companion with a scripted host. script(argv, attemptOfMode) -> runner answer; a mode's attempts are counted.
async function companion(t, script, { fileExists = async () => false, readText } = {}) {
  const root = await tempRoot(t);
  let now = T0;
  const calls = [], sleeps = [], logs = [];
  const count = new Map();
  const run = async (a, o) => {
    const mode = a.includes('-Mode') ? a[a.indexOf('-Mode') + 1] : a.includes('/usr/bin/pgrep') ? 'pgrep' : a.includes(LINUX_INCOMING) ? 'incoming' : a.at(-1);
    count.set(mode, (count.get(mode) ?? 0) + 1);
    calls.push({ mode, timeoutMs: o?.timeoutMs });
    const r = await script(mode, count.get(mode), { advance: ms => { now += ms; } });
    return r ?? { code: 0, stdout: '' };
  };
  const mailbox = await Mailbox.open(root, () => now);
  const c = new Companion({ cfg, mailbox, run, fileExists, sleep: async ms => { sleeps.push(ms); now += ms; }, clock: () => now, readText, log: async e => { logs.push(e); } });
  return { c, calls, sleeps, logs, now: () => now, set: v => { now = v; } };
}
const stage = { deadline: T0 + 30 * 60_000 }; // ample stage budget
const attempts = (calls, mode) => calls.filter(x => x.mode === mode).length;

test('a fast Receive* failure at the wsl/VM layer is retried within its budget, every attempt with the full 120 s', async t => {
  const f = await companion(t, (mode, n) => (mode === 'ReceiveResult' ? (n === 1 ? VM_FLAP : OK) : null));
  assert.equal(await f.c.relay('ReceiveResult', 0, stage), true);
  assert.equal(attempts(f.calls, 'ReceiveResult'), 2);
  assert.deepEqual(f.sleeps, [3000]);
  assert.ok(f.calls.filter(x => x.mode === 'ReceiveResult').every(x => x.timeoutMs === RELAY_TIMEOUT_MS));
  assert.deepEqual(f.logs.map(e => [e.mode, e.attempt, e.class]), [['ReceiveResult', 1, 'CHILD_FAILED'], ['ReceiveResult', 2, 'OK']]);
});

test('attempts and gaps per call: 3 for SendIssue, ReceiveResult, ReceiveBlocked (3 s, 8 s); 2 for ReceiveChallenge (3 s) and SendResponse (2 s)', async t => {
  assert.deepEqual({ ...RELAY_ATTEMPTS }, { SendIssue: [3000, 8000], ReceiveResult: [3000, 8000], ReceiveBlocked: [3000, 8000], ReceiveChallenge: [3000], SendResponse: [2000] });
  const f = await companion(t, mode => (mode === 'ReceiveBlocked' ? VM_FLAP : null));
  await assert.rejects(f.c.relay('ReceiveBlocked', 0, stage), e => e.code === 'RELAY_REFUSED_NO_RETRY' && e.permanent === false);
  assert.equal(attempts(f.calls, 'ReceiveBlocked'), 3);
  assert.deepEqual(f.sleeps, [3000, 8000]);
});

test('the stage budget: another SendIssue, ReceiveResult or ReceiveBlocked only while the stage deadline is at least 150 s away', async t => {
  for (const [left, want] of [[150_000 + 3000, 2], [150_000 + 2999, 1]]) {
    const f = await companion(t, mode => (mode === 'ReceiveResult' ? VM_FLAP : null));
    await assert.rejects(f.c.relay('ReceiveResult', 0, { deadline: T0 + left }), e => e.code === 'RELAY_REFUSED_NO_RETRY');
    assert.equal(attempts(f.calls, 'ReceiveResult'), want, `left ${left}`);
  }
  // no budget at all: never a second attempt
  const f = await companion(t, mode => (mode === 'ReceiveResult' ? VM_FLAP : null));
  await assert.rejects(f.c.relay('ReceiveResult', 0), e => e.code === 'RELAY_REFUSED_NO_RETRY');
  assert.equal(attempts(f.calls, 'ReceiveResult'), 1);
});

test('the challenge budget: another ReceiveChallenge only until first sighting + one callback round - 60 s', async t => {
  for (const [seenBefore, want] of [[CALLBACK_WINDOW_MS - 60_000 - 3000, 2], [CALLBACK_WINDOW_MS - 60_000 - 2999, 1]]) {
    const f = await companion(t, mode => (mode === 'ReceiveChallenge' ? VM_FLAP : null));
    await assert.rejects(f.c.relay('ReceiveChallenge', 3, { firstSeen: T0 - seenBefore }), e => e.code === 'RELAY_REFUSED_NO_RETRY');
    assert.equal(attempts(f.calls, 'ReceiveChallenge'), want === 2 ? 2 : 1, `seen ${seenBefore} ms before`);
  }
});

test('the response budget: another SendResponse only until the challenge record\'s own deadline - 15 s; unreadable means no retry', async t => {
  const read = deadline => async p => { assert.equal(p, `${cfg.windowsSpool}\\incoming\\challenge-02.json`); return out({ deadline: new Date(deadline).toISOString() }); };
  const flapThenOk = (mode, n) => {
    if (mode === 'SendResponse') return n === 1 ? VM_FLAP : OK;
    if (mode === 'pgrep') return { code: 1, stdout: '' };
    if (mode === 'incoming') return { code: 0, stdout: 'issue.json\nissue.ready.json\n' };
    return null;
  };
  let f = await companion(t, flapThenOk, { readText: read(T0 + 2000 + 15_000) });
  assert.equal(await f.c.relay('SendResponse', 2, { challengeDeadline: () => f.c.challengeDeadline(2) }), true);
  assert.equal(attempts(f.calls, 'SendResponse'), 2);
  f = await companion(t, flapThenOk, { readText: read(T0 + 2000 + 14_999) });
  await assert.rejects(f.c.relay('SendResponse', 2, { challengeDeadline: () => f.c.challengeDeadline(2) }), e => e.code === 'RELAY_REFUSED_NO_RETRY' && !e.permanent);
  f = await companion(t, flapThenOk, { readText: async () => 'not json' });
  await assert.rejects(f.c.relay('SendResponse', 2, { challengeDeadline: () => f.c.challengeDeadline(2) }), e => e.code === 'RELAY_REFUSED_NO_RETRY');
  f = await companion(t, flapThenOk); // no readText port
  await assert.rejects(f.c.relay('SendResponse', 2, { challengeDeadline: () => f.c.challengeDeadline(2) }), e => e.code === 'RELAY_REFUSED_NO_RETRY');
  assert.equal(attempts(f.calls, 'SendResponse'), 1);
});

test('a Send* CHILD_FAILED retries only after pgrep shows no Linux relay-record and the record is not in Linux incoming', async t => {
  // pgrep finds nothing, nothing arrived: one more attempt
  let f = await companion(t, (mode, n) => ({ SendIssue: n === 1 ? VM_FLAP : OK, pgrep: { code: 1, stdout: '' }, incoming: { code: 0, stdout: '' } })[mode]);
  assert.equal(await f.c.relay('SendIssue', 0, stage), true);
  assert.deepEqual(f.calls.map(x => x.mode), ['SendIssue', 'pgrep', 'incoming', 'SendIssue']);
  // the record is already there (data and ready): transferred, no second import
  f = await companion(t, mode => ({ SendIssue: VM_FLAP, pgrep: { code: 1, stdout: '' }, incoming: { code: 0, stdout: 'issue.json\nissue.ready.json\n' } })[mode]);
  assert.equal(await f.c.relay('SendIssue', 0, stage), true);
  assert.equal(attempts(f.calls, 'SendIssue'), 1);
  // a relay-record still running after one more look 2 s later: refused for good, nothing looked at
  f = await companion(t, mode => ({ SendIssue: VM_FLAP, pgrep: { code: 0, stdout: `123 /usr/bin/node /x/${RELAY_RECORD_PROCESS} --import-issue\n` } })[mode]);
  await assert.rejects(f.c.relay('SendIssue', 0, stage), e => e.code === 'RELAY_REFUSED_NO_RETRY' && e.permanent === true);
  assert.deepEqual(f.calls.map(x => x.mode), ['SendIssue', 'pgrep', 'pgrep']);
  assert.ok(f.sleeps.includes(2000));
  // one that was gone at the second look: goes on
  f = await companion(t, (mode, n) => ({ SendIssue: n === 1 ? VM_FLAP : OK, pgrep: n === 1 ? { code: 0, stdout: 'x' } : { code: 1, stdout: '' }, incoming: { code: 0, stdout: '' } })[mode]);
  assert.equal(await f.c.relay('SendIssue', 0, stage), true);
  // pgrep or ls themselves failing: no retry
  for (const broken of [{ pgrep: { code: 2, stdout: '' } }, { pgrep: { code: 1, stdout: '' }, incoming: { code: 2, stdout: '' } },
    { pgrep: { code: 1, stdout: '' }, incoming: { code: null, stdout: '', timedOut: true, tree: 'zero' } }]) {
    f = await companion(t, mode => ({ SendIssue: VM_FLAP, ...broken })[mode]);
    await assert.rejects(f.c.relay('SendIssue', 0, stage), e => e.code === 'RELAY_REFUSED_NO_RETRY' && e.permanent === true);
    assert.equal(attempts(f.calls, 'SendIssue'), 1);
  }
  // only the data, no ready marker: kept, refused for good
  f = await companion(t, mode => ({ SendIssue: VM_FLAP, pgrep: { code: 1, stdout: '' }, incoming: { code: 0, stdout: 'issue.json\n' } })[mode]);
  await assert.rejects(f.c.relay('SendIssue', 0, stage), e => e.code === 'RELAY_PARTIAL_RECORD_PRESERVED' && e.permanent === true);
});

test('an AMBIGUOUS call is settled by the target: arrived = true, nothing = retry (a Send* also needs no leftover), half = kept', async t => {
  const incoming = name => `${cfg.windowsSpool}\\incoming\\${name}`;
  const files = set => async p => set.has(p);
  // Receive*: complete in Windows incoming -> true; nothing -> one more; data only -> RELAY_PARTIAL_RECORD_PRESERVED
  let f = await companion(t, mode => (mode === 'ReceiveResult' ? CUT : null), { fileExists: files(new Set([incoming('result.json'), incoming('result.ready.json')])) });
  assert.equal(await f.c.relay('ReceiveResult', 0, stage), true);
  f = await companion(t, (mode, n) => (mode === 'ReceiveResult' ? (n === 1 ? CUT : OK) : null));
  assert.equal(await f.c.relay('ReceiveResult', 0, stage), true);
  assert.equal(attempts(f.calls, 'ReceiveResult'), 2);
  f = await companion(t, mode => (mode === 'ReceiveResult' ? failure('PUBLIC_OUTPUT_UNCONFIRMED_NO_RETRY') : null), { fileExists: files(new Set([incoming('result.json')])) });
  await assert.rejects(f.c.relay('ReceiveResult', 0, stage), e => e.code === 'RELAY_PARTIAL_RECORD_PRESERVED');
  // Send*: arrived first; nothing there and a leftover relay-record -> refused for good
  f = await companion(t, mode => ({ SendResponse: CUT, incoming: { code: 0, stdout: 'response-04.json\nresponse-04.ready.json\n' } })[mode]);
  assert.equal(await f.c.relay('SendResponse', 4, {}), true);
  assert.equal(attempts(f.calls, 'pgrep'), 0);
  f = await companion(t, mode => ({ SendResponse: CUT, incoming: { code: 0, stdout: '' }, pgrep: { code: 0, stdout: 'x' } })[mode]);
  await assert.rejects(f.c.relay('SendResponse', 4, { challengeDeadline: async () => T0 + 10 * 60_000 }), e => e.permanent === true);
  assert.equal(attempts(f.calls, 'SendResponse'), 1);
});

test('EXISTING_RECORD_PRESERVED: only a complete record of that name counts as transferred; a half one is kept', async t => {
  const name = `${cfg.windowsSpool}\\incoming\\challenge-01`;
  let f = await companion(t, mode => (mode === 'ReceiveChallenge' ? failure('EXISTING_RECORD_PRESERVED_NO_RETRY') : null), { fileExists: async p => p === `${name}.json` || p === `${name}.ready.json` });
  assert.equal(await f.c.relay('ReceiveChallenge', 1, { firstSeen: T0 }), true);
  f = await companion(t, mode => (mode === 'ReceiveChallenge' ? failure('EXISTING_RECORD_PRESERVED_NO_RETRY') : null), { fileExists: async p => p === `${name}.ready.json` });
  await assert.rejects(f.c.relay('ReceiveChallenge', 1, { firstSeen: T0 }), e => e.code === 'RELAY_PARTIAL_RECORD_PRESERVED');
  f = await companion(t, mode => (mode === 'ReceiveChallenge' ? failure('EXISTING_RECORD_PRESERVED_NO_RETRY') : null));
  await assert.rejects(f.c.relay('ReceiveChallenge', 1, { firstSeen: T0 }), e => e.code === 'RELAY_REFUSED_NO_RETRY' && e.permanent === true);
});

test('NO_CHILD is retried once at most; PERMANENT never; a cancel stops before the next attempt', async t => {
  let f = await companion(t, mode => (mode === 'SendIssue' ? NO_WSL : null));
  await assert.rejects(f.c.relay('SendIssue', 0, stage), e => e.code === 'RELAY_REFUSED_NO_RETRY' && e.permanent === false);
  assert.equal(attempts(f.calls, 'SendIssue'), 2);
  assert.equal(attempts(f.calls, 'pgrep') + attempts(f.calls, 'incoming'), 0, 'no child ran: nothing to look at');
  f = await companion(t, mode => (mode === 'SendIssue' ? childError('EBUSY', 'BINDING') : null));
  await assert.rejects(f.c.relay('SendIssue', 0, stage), e => e.code === 'RELAY_REFUSED_NO_RETRY' && e.permanent === true);
  assert.equal(attempts(f.calls, 'SendIssue'), 1);
  let cancelled = false;
  f = await companion(t, mode => { if (mode === 'ReceiveResult') { cancelled = true; return VM_FLAP; } return null; });
  const live = async () => { if (cancelled) throw Object.assign(new Error('COMPANION_PUMP_CANCELLED'), { code: 'COMPANION_PUMP_CANCELLED' }); };
  await assert.rejects(f.c.relay('ReceiveResult', 0, { ...stage, live }), e => e.code === 'COMPANION_PUMP_CANCELLED');
  assert.equal(attempts(f.calls, 'ReceiveResult'), 1);
});

test('fixed argv for the two new checks: ls of Linux incoming and pgrep of the relay-record entry, both through wsl as root', () => {
  const a = argv(cfg);
  assert.deepEqual(a.linuxIncoming().slice(-5), ['/usr/bin/ls', '-1', '-A', '--', '/var/lib/clued-independent-ci/formal-spool/incoming']);
  assert.deepEqual(a.linuxRelayProcs().slice(-4), ['/usr/bin/pgrep', '-f', '-a', 'protected-job-bridge-v4/relay-record.mjs']);
  assert.deepEqual(a.linuxRelayProcs().slice(0, 6), [cfg.wslExe, '--distribution', 'Ubuntu-24.04', '--user', 'root', '--exec']);
  assert.deepEqual(['SendIssue', 'SendResponse', 'ReceiveChallenge', 'ReceiveResult', 'ReceiveBlocked'].map(m => relayRecordName(m, 7)), ['issue', 'response-07', 'challenge-07', 'result', 'blocked']);
  assert.ok(PUMP_CODES.includes('RELAY_PARTIAL_RECORD_PRESERVED'));
});

test('log entries: fixed keys, codes only, a scrubbed stderr tail of at most 512 printable characters', () => {
  const tail = stderrTail(`err\u0000 at C:\\Users\\Chase\\AppData\\x ${'ab'.repeat(20)} ${'Q'.repeat(50)}\n\n  token\u00e9 ${'z'.repeat(900)}`);
  assert.ok(tail.length <= 512 && /^[\x20-\x7e]*$/.test(tail));
  assert.ok(!stderrTail('C:\\Users\\Chase\\x').includes('Chase'));
  assert.equal(stderrTail(`id ${'a1'.repeat(16)} end`), 'id <hex> end');
  assert.equal(stderrTail(`k ${'Ab9+'.repeat(10)} end`), 'k <b64> end');
  const e = relayLogEntry({ at: T0, mode: 'SendIssue', seq: 0, attempt: 1, ms: 1500, runner: { code: 2, stderr: 'boom' }, receipt: JSON.parse(VM_FLAP.stdout), klass: 'CHILD_FAILED' });
  assert.deepEqual(Object.keys(e), ['at', 'mode', 'seq', 'attempt', 'ms', 'runner', 'receipt', 'class', 'stderrTail']);
  assert.deepEqual(e.receipt, { status: 'BLOCKED', failureCode: 'PUBLIC_CHILD_EXIT_REFUSED_NO_RETRY', exitCode: 1, processIdPresent: true, terminalConfirmed: true, childError: null });
  const odd = relayLogEntry({ at: T0, mode: 'SendIssue', seq: 0, attempt: 1, ms: 1, runner: {}, receipt: { status: 'free text here', childError: { reason: 'x y', stage: 'RECORD' } }, klass: 'PERMANENT' });
  assert.deepEqual([odd.receipt.status, odd.receipt.childError], [null, { reason: null, stage: 'RECORD' }]);
});

test('a failing log never decides anything', async t => {
  const root = await tempRoot(t);
  const mailbox = await Mailbox.open(root, () => T0);
  const c = new Companion({ cfg, mailbox, run: async () => OK, fileExists: async () => false, sleep: async () => {}, clock: () => T0, log: async () => { throw new Error('disk full'); } });
  assert.equal(await c.relay('ReceiveResult', 0, stage), true);
});

test('the relay log file: one JSON line per entry, a 2 MB cap with one LOG_TRUNCATED line, files older than 14 days removed', async t => {
  const dir = path.join(await tempRoot(t), 'companion-log');
  await fs.mkdir(dir, { recursive: true });
  for (const day of ['20261013', '20261014', '20261015']) await fs.writeFile(path.join(dir, `relay-${day}.jsonl`), '{}\n');
  await fs.writeFile(path.join(dir, 'other.txt'), 'kept');
  let now = Date.parse('2026-10-28T12:00:00Z');
  const log = createRelayLog({ dir, clock: () => now });
  await log({ a: 1 });
  await log({ a: 2 });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['other.txt', 'relay-20261014.jsonl', 'relay-20261015.jsonl', 'relay-20261028.jsonl']);
  assert.deepEqual((await fs.readFile(path.join(dir, 'relay-20261028.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)), [{ a: 1 }, { a: 2 }]);
  // at the cap: one LOG_TRUNCATED line, then nothing more that day; the next day starts a new file
  await fs.writeFile(path.join(dir, 'relay-20261028.jsonl'), 'x'.repeat(RELAY_LOG_MAX_BYTES - 5));
  await log({ a: 3 });
  await log({ a: 4 });
  const text = await fs.readFile(path.join(dir, 'relay-20261028.jsonl'), 'utf8');
  assert.equal(text.split('\n').filter(l => l.includes('LOG_TRUNCATED')).length, 1);
  assert.ok(!text.includes('"a":3') && !text.includes('"a":4'));
  now += 86_400_000;
  await log({ a: 5 });
  assert.equal((await fs.readFile(path.join(dir, 'relay-20261029.jsonl'), 'utf8')).trim(), '{"a":5}');
});

test('the pump: a ReceiveBlocked that ran out of retries does not stop the later blocked hand-over; a refused one does', async t => {
  const root = await tempRoot(t);
  let now = T0;
  const box = await Mailbox.open(root, () => now);
  const req = await box.send('relay-stage', { batchId: '0123456789abcdef-0123456789ab', stage: 2, jobId: 'e'.repeat(64) }, 10 * 60_000);
  let blocked = 0;
  const run = async a => {
    if (a.includes('-Mode')) {
      const mode = a[a.indexOf('-Mode') + 1];
      if (mode === 'SendIssue') return OK;
      if (mode === 'ReceiveBlocked') { blocked += 1; return blocked <= 3 ? VM_FLAP : OK; }
    }
    if (a.includes(LINUX_INCOMING)) return { code: 0, stdout: '' };
    if (a.includes('/usr/bin/ls')) return { code: 0, stdout: 'blocked.ready.json\n' };
    if (a.includes('quiescence')) return { code: 0, stdout: out({ linuxUnitsInactive: true, containersZero: true }) };
    if (a.includes('ActiveState')) return { code: 0, stdout: 'inactive\n' };
    return { code: 0, stdout: '' };
  };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async p => !p.includes('\\incoming\\'), sleep: async ms => { now += ms; }, clock: () => now });
  await c.step();
  const r = await box.poll(req);
  // three fast failures use up the first ReceiveBlocked; the hand-over's own try gets the record over
  assert.equal(blocked, 4);
  assert.deepEqual([r.ok, r.code], [false, 'RELAY_REFUSED_NO_RETRY']);
});
