// DESIGN §46 (review of gen7, finding a): a companion action that is asked again must fit into the deadline of its own request.
// The archive's second `start --wait` and the refs gate's second read are made only with what the request's deadline still leaves;
// the service and the engine use one pair of deadlines (mailbox.mjs) that holds every attempt the companion may make.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ARCHIVE_STATUS_RESERVE_MS, COMPANION_CONFIG_CONTRACT, CHECK_REFS_SECOND_TRY_MAX_MS, Companion, RETRY_MIN_ROOM_MS, validateCompanionConfig } from '../src/companion.mjs';
import { ARCHIVE_LINUX_REQUEST_MS, CHECK_REFS_REQUEST_MS } from '../src/mailbox.mjs';
import { TEST_NODE, TEST_NODE_SHA } from './helpers.mjs';

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const BATCH = '0123456789abcdef-0123456789ab';
const T0 = Date.parse('2026-11-04T10:00:00Z');
const TIMED_OUT = { code: null, stdout: '', stderr: '', timedOut: true, tree: 'zero' };
const is = (a, ...words) => words.every(w => a.includes(w));
const MIN = 60_000;
const STATUS = { code: 0, stdout: JSON.stringify({ verified: true, directory: 'failed-0123456789ab-formal-bridge-stage-deadline-aaaaaaaaaaaa' }) };

// A host whose children really take their time: a call answered with a timeout lasts its timeoutMs, any other answer lasts `took`.
function rig(script) {
  const s = { now: T0, calls: [], logs: [] };
  const run = async (a, o) => {
    const r = script(a, s.calls.filter(c => c.a.join(' ') === a.join(' ')).length + 1, s.now - T0);
    s.calls.push({ a, timeoutMs: o?.timeoutMs, at: s.now - T0 });
    s.now += r.timedOut ? o.timeoutMs : (r.took ?? 1000);
    return r;
  };
  s.c = new Companion({ cfg, mailbox: null, run, fileExists: async () => true, sleep: async ms => { s.now += ms; }, clock: () => s.now, log: async e => { s.logs.push(e); } });
  s.of = pred => s.calls.filter(x => pred(x.a));
  return s;
}
const req = (kind, ms) => ({ kind, batchId: BATCH, reason: 'formal-bridge-stage-deadline', deadline: new Date(T0 + ms).toISOString() });
const archiveScript = ({ starts }) => (a, n) => (is(a, 'start', '--wait') ? starts(n) : is(a, 'archive-status') ? STATUS : { code: 0, stdout: '{}' });

test('the shared request deadlines hold every attempt the companion may make; service and engine use them', () => {
  assert.ok(ARCHIVE_LINUX_REQUEST_MS >= 2 * 5 * MIN + ARCHIVE_STATUS_RESERVE_MS, 'two starts of 5 min and the status reads');
  assert.ok(CHECK_REFS_REQUEST_MS >= CHECK_REFS_SECOND_TRY_MAX_MS + 5 * MIN, 'a first read of at most 3 min and a second of 5 min');
  const ports = fs.readFileSync(new URL('../src/service-ports.mjs', import.meta.url), 'utf8');
  const engine = fs.readFileSync(new URL('../src/engine-windows.mjs', import.meta.url), 'utf8');
  assert.ok(ports.includes("'archive-linux': ARCHIVE_LINUX_REQUEST_MS") && ports.includes("'check-refs': CHECK_REFS_REQUEST_MS"));
  assert.ok(engine.includes("send('archive-linux', { batchId: batch.batchId, reason }, ARCHIVE_LINUX_REQUEST_MS)") && engine.includes("send('check-refs', { batchId: batch.batchId }, CHECK_REFS_REQUEST_MS)"));
  assert.ok(!/send\('(archive-linux|check-refs)'[^\n]*6 \* 60_000/.test(engine), 'no 6 minute deadline is left in the engine');
});

test('archive-linux with the real request deadline: both starts time out at 5 min and the answer still comes before the deadline', async () => {
  const both = rig(archiveScript({ starts: () => TIMED_OUT }));
  const r = await both.c.handle(req('archive-linux', ARCHIVE_LINUX_REQUEST_MS));
  assert.equal(r.code, 'LINUX_ARCHIVE_UNCONFIRMED');
  assert.equal(both.of(a => is(a, 'start', '--wait')).length, 2);
  assert.ok(both.now - T0 < ARCHIVE_LINUX_REQUEST_MS, 'the service is still waiting when the answer is written');
  // The second start is the one that finishes the archive: verified, and still before the deadline.
  const second = rig(archiveScript({ starts: n => (n === 1 ? TIMED_OUT : { code: 0, stdout: '' }) }));
  const ok = await second.c.handle(req('archive-linux', ARCHIVE_LINUX_REQUEST_MS));
  assert.equal(ok.verified, true);
  assert.ok(second.now - T0 < ARCHIVE_LINUX_REQUEST_MS);
});

test('archive-linux: a second start gets only what the deadline leaves after the status reads; with too little it is not made', async () => {
  // The old 6 minute request: the first start used 5 minutes, nothing is left for another one. One start, the status read.
  const old = rig(archiveScript({ starts: () => TIMED_OUT }));
  const o = await old.c.handle(req('archive-linux', 6 * MIN));
  assert.equal(old.of(a => is(a, 'start', '--wait')).length, 1);
  assert.equal(o.code, 'LINUX_ARCHIVE_UNCONFIRMED');
  assert.equal(old.logs.filter(l => l.kind === 'retry' && l.op === 'archive-start-wait').length, 0, 'no retry is logged for a start that was not made');
  // A deadline with some room: the second start is clamped to it.
  const mid = rig(archiveScript({ starts: () => TIMED_OUT }));
  await mid.c.handle(req('archive-linux', 9 * MIN));
  const starts = mid.of(a => is(a, 'start', '--wait'));
  assert.equal(starts.length, 2);
  assert.equal(starts[1].timeoutMs, 9 * MIN - 5 * MIN - ARCHIVE_STATUS_RESERVE_MS);
  assert.ok(starts[1].timeoutMs >= RETRY_MIN_ROOM_MS);
  assert.ok(mid.now - T0 <= 9 * MIN + 3 * 30_000, 'at most the status reads follow the deadline');
  // Just under the minimum room: none.
  const under = rig(archiveScript({ starts: () => TIMED_OUT }));
  await under.c.handle(req('archive-linux', 5 * MIN + ARCHIVE_STATUS_RESERVE_MS + RETRY_MIN_ROOM_MS - 1));
  assert.equal(under.of(a => is(a, 'start', '--wait')).length, 1);
  // The exact minimum: one.
  const exact = rig(archiveScript({ starts: () => TIMED_OUT }));
  await exact.c.handle(req('archive-linux', 5 * MIN + ARCHIVE_STATUS_RESERVE_MS + RETRY_MIN_ROOM_MS));
  assert.equal(exact.of(a => is(a, 'start', '--wait')).length, 2);
});

test('check-refs: the second read gets what the deadline leaves, never more than 5 min, and none when too little is left', async () => {
  const none = { code: 1, stdout: '' };
  const reads = r => r.of(a => a.includes('-CheckRefs'));
  // The real deadline: a first read that ended after exactly the longest first read allowed, a full second one, all inside the request.
  const full = rig((a, n) => (n === 1 ? { ...none, took: CHECK_REFS_SECOND_TRY_MAX_MS } : { ...TIMED_OUT }));
  const f = await full.c.handle(req('check-refs', CHECK_REFS_REQUEST_MS));
  assert.deepEqual(f, { ok: false, code: 'REMOTE_REFS_UNAVAILABLE' });
  assert.equal(reads(full).length, 2);
  assert.equal(reads(full)[1].timeoutMs, 5 * MIN);
  assert.ok(full.now - T0 < CHECK_REFS_REQUEST_MS, 'the answer comes before the service stops waiting');
  // The old 6 minute request after a 3 minute first read: clamped to the rest.
  const old = rig((a, n) => (n === 1 ? { ...none, took: 3 * MIN } : { ...TIMED_OUT }));
  await old.c.handle(req('check-refs', 6 * MIN));
  assert.equal(reads(old).length, 2);
  assert.equal(reads(old)[1].timeoutMs, 6 * MIN - 3 * MIN - 10_000);
  assert.ok(old.now - T0 <= 6 * MIN);
  // Too little left: one read, the head burns as before.
  const late = rig((a, n) => (n === 1 ? { ...none, took: 3 * MIN } : { ...TIMED_OUT }));
  const l = await late.c.handle(req('check-refs', 3 * MIN + 10_000 + RETRY_MIN_ROOM_MS - 1));
  assert.equal(reads(late).length, 1);
  assert.equal(l.code, 'REMOTE_REFS_UNAVAILABLE');
  assert.equal(late.logs.filter(x => x.op === 'check-refs').length, 0, 'no retry is logged for a read that was not made');
  // A definite answer on the second read still ends it, as before.
  const unchanged = { code: 0, stdout: JSON.stringify({ status: 'REMOTE_REFS_UNCHANGED' }) };
  const ok = rig((a, n) => (n === 1 ? none : unchanged));
  assert.deepEqual(await ok.c.handle(req('check-refs', CHECK_REFS_REQUEST_MS)), { ok: true, code: null });
});
