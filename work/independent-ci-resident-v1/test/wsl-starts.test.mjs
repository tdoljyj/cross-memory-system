// Task 463e8148 (DESIGN §31.5): the pump starts far fewer wsl.exe. Every listing of Linux outgoing and every unit-facts read is a
// wsl.exe, and each opens six hv_sock channels; at one listing a second that was thousands of starts in a 45-minute stage (the
// 2026-10-28 incident). Here a fake host counts the starts of a whole stage before (listingDelay () => 1000, the old pace) and
// after, and the tests pin what must not get worse: how late a challenge is found, the relay reserves of DESIGN §25.4, and the
// timing of signals B and C.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../src/mailbox.mjs';
import {
  CALLBACK_WINDOW_MS, CHALLENGE_RESERVE_MS, COMPANION_CONFIG_CONTRACT, Companion, HANDOVER_LISTING_CAP_MS, LINUX_INCOMING, LINUX_OUTGOING, LISTING_CAP_MS, LISTING_MIN_MS,
  WORKER_FACTS_EVERY_MS, WORKER_START_WAIT_MS, listingDelayMs, validateCompanionConfig,
} from '../src/companion.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const BATCH = '0123456789abcdef-0123456789ab';
const JOB = 'e'.repeat(64);
const T0 = Date.parse('2026-10-29T10:00:00Z');
const TRANSFERRED = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
const NOT_THERE = { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
const mode = a => (a.includes('-Mode') ? a[a.indexOf('-Mode') + 1] : null);
const WSL_CALL_MS = 250, RELAY_CALL_MS = 5000; // a wsl.exe call takes about 0.15-0.3 s; a relay call about 4-6 s (DESIGN §25.4)

// One stage of a worker whose timeline is given in ms after `systemctl start`: the times each challenge is made, the result, and
// the unit's end. challengesAt[k] is when challenge k+1 appears in Linux outgoing; the records stay listed (nothing archives them
// during a stage). Returns what the host saw, in virtual time.
async function stage(t, { challengesAt, resultAt, endsAt }, ports = {}, { cancelAfterMs = null, unitNeverRuns = false } = {}) {
  let now = T0, startAt = null;
  const box = await Mailbox.open(await tempRoot(t), () => now);
  const starts = { listing: 0, facts: 0, start: 0, other: 0 }, relays = [], factsAt = [], listingAt = [], seen = new Map(), budgets = [];
  let req;
  const rel = () => now - startAt;
  const listing = () => [...challengesAt.map((at, k) => (rel() >= at ? `challenge-${String(k + 1).padStart(2, '0')}.ready.json` : null)), rel() >= resultAt ? 'result.ready.json' : null].filter(Boolean);
  const run = async a => {
    const m = mode(a);
    if (m) {
      now += RELAY_CALL_MS;
      relays.push({ m, at: now - RELAY_CALL_MS });
      if (m === 'SendIssue' || m === 'SendResponse') return TRANSFERRED;
      if (m === 'ReceiveChallenge') {
        const seq = Number(a[a.indexOf('-Sequence') + 1]);
        if (startAt !== null && challengesAt[seq - 1] !== undefined && rel() - RELAY_CALL_MS >= challengesAt[seq - 1]) { seen.set(seq, now - RELAY_CALL_MS); return TRANSFERRED; }
        return NOT_THERE;
      }
      if (m === 'ReceiveResult') return startAt !== null && rel() - RELAY_CALL_MS >= resultAt ? TRANSFERRED : NOT_THERE;
      return NOT_THERE;
    }
    if (a[0] !== cfg.wslExe) return { code: 0, stdout: '' };
    now += WSL_CALL_MS;
    if (a.includes('--no-block')) { starts.start += 1; startAt = now; return { code: 0, stdout: '' }; }
    if (a.some(x => x.startsWith('--property=ActiveState'))) {
      starts.facts += 1; factsAt.push(now);
      if (unitNeverRuns || startAt === null) return { code: 0, stdout: 'ActiveState=inactive\nInvocationID=\nExecMainStartTimestampMonotonic=0\n' };
      const state = rel() < 1000 ? 'activating' : rel() < endsAt ? 'active' : 'inactive';
      return { code: 0, stdout: `ActiveState=${state}\nInvocationID=${'a'.repeat(32)}\nExecMainStartTimestampMonotonic=7\n` };
    }
    if (a.includes('/usr/bin/ls') && a.includes(LINUX_OUTGOING)) { starts.listing += 1; listingAt.push(now); return { code: 0, stdout: `${listing().join('\n')}\n` }; }
    if (a.includes('/usr/bin/ls') && a.includes(LINUX_INCOMING)) { starts.other += 1; return { code: 0, stdout: '' }; }
    starts.other += 1; // quiescence, pgrep
    return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
  };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async () => true, clock: () => now, ...ports,
    sleep: async ms => { now += ms; if (cancelAfterMs !== null && startAt !== null && rel() >= cancelAfterMs) await box.cancel(req, 'stage-ended'); } });
  const relay = c.relay.bind(c);
  c.relay = (m, seq, budget) => { if (m === 'ReceiveChallenge') budgets.push({ seq, firstSeen: budget.firstSeen }); return relay(m, seq, budget); };
  req = await box.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 60 * 60_000);
  await c.step();
  const answer = await box.poll(req);
  const total = starts.listing + starts.facts + starts.start + starts.other;
  return { answer, starts, total, relays, factsAt, listingAt, seen, budgets, startAt, endedAt: now, elapsed: now - T0,
    lateness: [...seen].map(([seq, at]) => at - startAt - challengesAt[seq - 1]) };
}

// A typical stage: three callback rounds (the first almost at once, the second after a minute of preparation, the last after the
// scan), the result seconds later, the unit gone three seconds after that.
const TYPICAL = { challengesAt: [4_000, 70_000, 225_000], resultAt: 228_000, endsAt: 231_000 };
const LONG = { challengesAt: [4_000, 40_000, 20 * 60_000], resultAt: 20 * 60_000 + 3_000, endsAt: 20 * 60_000 + 6_000 };
const OLD_PACE = { listingDelay: () => 1000 };

test('the pace: a second right after anything happened, half the quiet time after that, never more than the cap', () => {
  assert.deepEqual([0, 1000, 1999, 3999, 8000, 20_000, 40_000, 600_000].map(q => listingDelayMs(q)), [1000, 1000, 1000, 1999, 4000, 10_000, 15_000, 15_000]);
  assert.equal(LISTING_CAP_MS, WORKER_FACTS_EVERY_MS, 'quiet, one pass does the listing and the facts read together');
  assert.equal(LISTING_MIN_MS, 1000);
  assert.equal(listingDelayMs(1e9, HANDOVER_LISTING_CAP_MS), 5000);
  // the cap is a small part of the callback window it must not eat: it leaves the whole of DESIGN §25.4's 60 s reserve for the
  // issuer's evaluation and the response, because the reserve is counted from before the challenge existed (the budget test below)
  assert.ok(LISTING_CAP_MS <= CALLBACK_WINDOW_MS / 8, `${LISTING_CAP_MS} ms of ${CALLBACK_WINDOW_MS} ms`);
});

test('wsl.exe starts of a typical stage, before and after: the listings drop to a quarter or less, every read is still done', async t => {
  const before = await stage(t, TYPICAL, OLD_PACE);
  const after = await stage(t, TYPICAL);
  for (const r of [before, after]) assert.deepEqual([r.answer.ok, r.answer.code], [true, null]);
  // eslint-disable-next-line no-console
  t.diagnostic(`typical stage (${Math.round(before.elapsed / 1000)} s): wsl.exe starts before ${JSON.stringify(before.starts)} = ${before.total}, after ${JSON.stringify(after.starts)} = ${after.total}; relay calls ${before.relays.length} / ${after.relays.length}`);
  assert.ok(before.starts.listing >= 150, `before: about one listing a second (${before.starts.listing})`);
  assert.ok(after.starts.listing * 4 <= before.starts.listing, `listings ${before.starts.listing} -> ${after.starts.listing}`);
  assert.ok(after.total * 3 <= before.total, `all starts ${before.total} -> ${after.total}`);
  // the same transfers, the same relay calls: only the polling got rarer
  assert.deepEqual(after.relays.map(r => r.m).filter(m => m !== 'ReceiveChallenge' && m !== 'ReceiveResult'), before.relays.map(r => r.m).filter(m => m !== 'ReceiveChallenge' && m !== 'ReceiveResult'));
});

test('wsl.exe starts of a 20-minute stage, before and after', async t => {
  const before = await stage(t, LONG, OLD_PACE);
  const after = await stage(t, LONG);
  t.diagnostic(`20-minute stage: before ${JSON.stringify(before.starts)} = ${before.total}, after ${JSON.stringify(after.starts)} = ${after.total}`);
  assert.deepEqual([after.answer.ok, after.answer.code], [true, null]);
  assert.ok(after.starts.listing * 8 <= before.starts.listing, `listings ${before.starts.listing} -> ${after.starts.listing}`);
  assert.ok(after.total * 5 <= before.total, `all starts ${before.total} -> ${after.total}`);
  // what is left is the facts read every WORKER_FACTS_EVERY_MS (signals B and C keep their timing) and the listing beside it
  assert.ok(after.starts.facts >= Math.floor(LONG.endsAt / WORKER_FACTS_EVERY_MS) - 1 && after.starts.facts <= Math.ceil(LONG.endsAt / WORKER_FACTS_EVERY_MS) + 6, `facts ${after.starts.facts}`);
});

test('worst-case added latency: a challenge is found within the cap (plus one listing call) of its creation, whenever in the quiet phase it appears', async t => {
  const lateness = [];
  for (let offset = 0; offset <= 20; offset += 1) {
    const r = await stage(t, { challengesAt: [4_000, 90_000 + offset * 1000, 200_000 + offset * 700], resultAt: 230_000, endsAt: 232_000 });
    assert.deepEqual([r.answer.ok, r.answer.code], [true, null], `offset ${offset}`);
    assert.equal(r.seen.size, 3);
    lateness.push(...r.lateness.slice(1));
  }
  const worst = Math.max(...lateness);
  // a relay call starts right after the listing that showed the challenge, so lateness = the wait for that listing + one listing call
  assert.ok(worst <= LISTING_CAP_MS + 2 * WSL_CALL_MS, `worst ${worst} ms`);
  assert.ok(Math.max(...(await stage(t, TYPICAL, OLD_PACE)).lateness) <= 1000 + 2 * WSL_CALL_MS + 100, 'the old pace found them within about a second');
  t.diagnostic(`challenge found ${Math.min(...lateness)}-${worst} ms after its creation (old pace: about one second); window ${CALLBACK_WINDOW_MS} ms`);
});

test('relay budgets (DESIGN §25.4): the ReceiveChallenge budget is counted from before the challenge existed, so "creation + 60 s" holds at any pace', async t => {
  for (const challenge3 of [225_000, 231_300, 236_900, 241_000]) {
    const r = await stage(t, { challengesAt: [4_000, 70_000, challenge3], resultAt: challenge3 + 3000, endsAt: challenge3 + 6000 });
    assert.deepEqual([r.answer.ok, r.answer.code], [true, null]);
    for (const { seq, firstSeen } of r.budgets) {
      const created = r.startAt + [4_000, 70_000, challenge3][seq - 1];
      assert.ok(firstSeen <= created, `challenge ${seq}: the anchor ${firstSeen - r.startAt} is not after its creation ${created - r.startAt}`);
      assert.ok(created - firstSeen <= LISTING_CAP_MS + RELAY_CALL_MS + 2 * WSL_CALL_MS, `challenge ${seq}: anchored ${created - firstSeen} ms early`);
      // the last moment a retry may start is firstSeen + 120 s - 60 s: never later than creation + 60 s
      assert.ok(firstSeen + CALLBACK_WINDOW_MS - CHALLENGE_RESERVE_MS <= created + CALLBACK_WINDOW_MS - CHALLENGE_RESERVE_MS);
    }
  }
});

test('signal B keeps its timing: the facts are read at the start and then no further apart than WORKER_FACTS_EVERY_MS (+ one pass), however quiet the stage', async t => {
  const r = await stage(t, LONG);
  assert.equal(r.factsAt[0] - r.startAt, WSL_CALL_MS, 'read right after the start');
  const gaps = r.factsAt.slice(1).map((at, i) => at - r.factsAt[i]);
  assert.ok(Math.max(...gaps.slice(0, -4)) <= WORKER_FACTS_EVERY_MS + 3 * WSL_CALL_MS + RELAY_CALL_MS * 2, `gaps ${gaps.slice(0, 12)}`);
  assert.ok(gaps.filter(g => g < WORKER_FACTS_EVERY_MS - 1).length <= 4, 'and not more often than that (the terminal check at the end reads sooner)');
  // an ended worker with nothing left is found at the first read after it ended
  const ended = await stage(t, { challengesAt: [4_000], resultAt: 10 * 60_000, endsAt: 100_000 }, {}, { cancelAfterMs: 15 * 60_000 });
  assert.equal(ended.answer.code, 'LINUX_WORKER_ENDED_WITHOUT_RECORD');
  assert.ok(ended.elapsed - 100_000 <= WORKER_FACTS_EVERY_MS + 2 * WSL_CALL_MS + 2 * RELAY_CALL_MS + 1000, `ended at ${ended.elapsed} ms`);
});

test('signal C keeps its timing: five minutes without any sign, found within one facts interval', async t => {
  const r = await stage(t, { challengesAt: [], resultAt: Infinity, endsAt: 0 }, {}, { unitNeverRuns: true });
  assert.equal(r.answer.code, 'LINUX_WORKER_NOT_STARTED');
  assert.ok(r.endedAt - r.startAt >= WORKER_START_WAIT_MS && r.endedAt - r.startAt < WORKER_START_WAIT_MS + WORKER_FACTS_EVERY_MS + 2000, `${r.endedAt - r.startAt} ms`);
  const old = await stage(t, { challengesAt: [], resultAt: Infinity, endsAt: 0 }, OLD_PACE, { unitNeverRuns: true });
  assert.equal(old.answer.code, 'LINUX_WORKER_NOT_STARTED');
  t.diagnostic(`signal C: after ${Math.round((r.endedAt - r.startAt) / 1000)} s (old pace ${Math.round((old.endedAt - old.startAt) / 1000)} s); wsl.exe starts ${r.total} (old ${old.total})`);
  assert.ok(r.total * 3 <= old.total);
});

test('the wait for the worker unit to be gone after the result backs off (0.5, 1, 2 s ...), still inside its 30 s', async t => {
  let now = T0;
  const box = await Mailbox.open(await tempRoot(t), () => now);
  const reads = [];
  const run = async a => {
    if (mode(a)) return mode(a) === 'SendIssue' || mode(a) === 'ReceiveResult' ? TRANSFERRED : NOT_THERE;
    if (a.some(x => x.startsWith('--property=ActiveState'))) { reads.push(now - T0); return { code: 0, stdout: `ActiveState=${now - T0 > 40_000 ? 'inactive' : 'deactivating'}\nInvocationID=${'a'.repeat(32)}\nExecMainStartTimestampMonotonic=7\n` }; }
    if (a.includes('/usr/bin/ls')) return { code: 0, stdout: 'result.ready.json\n' };
    return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
  };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async () => true, sleep: async ms => { now += ms; }, clock: () => now });
  const req = await box.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 60 * 60_000);
  await c.step();
  assert.equal((await box.poll(req)).code, 'FORMAL_WORKER_TERMINAL_UNCONFIRMED', 'a worker that does not end in 30 s is still reported');
  const terminal = reads.slice(reads.findIndex((at, i) => i > 0 && at - reads[i - 1] < 5000));
  assert.ok(terminal.length <= 20 && terminal.length >= 10, `${terminal.length} reads in the terminal wait (the old 0.5 s step: about 60)`);
  assert.deepEqual(terminal.slice(1, 4).map((at, i) => at - terminal[i]), [500, 1000, 2000]);
});

test('the hand-over of the worker\'s blocked record is looked for at the hand-over pace; a record that shows up late is found within that pace', async t => {
  let now = T0, listings = 0;
  const blockedAt = T0 + 100_000;
  const box = await Mailbox.open(await tempRoot(t), () => now);
  const run = async a => {
    const m = mode(a);
    if (m) { now += RELAY_CALL_MS; return m === 'ReceiveBlocked' && now - RELAY_CALL_MS >= blockedAt ? TRANSFERRED : NOT_THERE; }
    now += WSL_CALL_MS;
    if (a.includes('/usr/bin/ls') && a.includes(LINUX_OUTGOING)) { listings += 1; return { code: 0, stdout: now >= blockedAt ? 'blocked.ready.json\n' : '' }; }
    return { code: 0, stdout: '' };
  };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async () => true, sleep: async ms => { now += ms; }, clock: () => now });
  assert.equal(await c.handOverBlocked(T0 + 45 * 60_000), true);
  assert.ok(now - blockedAt <= HANDOVER_LISTING_CAP_MS + 2 * WSL_CALL_MS + RELAY_CALL_MS + 100, `found ${now - blockedAt} ms after it was made`);
  assert.ok(listings <= 30, `${listings} listings in 100 s (the old pace: 100)`);
  t.diagnostic(`hand-over: ${listings} listings before a record made 100 s in (the old pace: about 100)`);
  // a worker that never publishes one: the window (CALLBACK_WINDOW_MS + 30 s) ends, with far fewer listings than a second apart
  listings = 0; now = T0;
  const none = new Companion({ cfg, mailbox: box, run: async a => (mode(a) ? { ...NOT_THERE } : { code: 0, stdout: a.includes('/usr/bin/ls') ? '' : '' }), fileExists: async () => true,
    sleep: async ms => { now += ms; }, clock: () => now });
  assert.equal(await none.handOverBlocked(T0 + 45 * 60_000), false);
  assert.ok(now - T0 >= CALLBACK_WINDOW_MS + 30_000 && now - T0 < CALLBACK_WINDOW_MS + 30_000 + HANDOVER_LISTING_CAP_MS + 1000, `${now - T0} ms`);
});
