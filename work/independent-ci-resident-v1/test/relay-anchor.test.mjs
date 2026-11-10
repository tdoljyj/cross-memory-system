// DESIGN §31.5 (review of §31, MAJOR-1 and MAJOR-2): the ReceiveChallenge retry budget (DESIGN §25.4: a retry only while
// now <= anchor + 120 s - 60 s) counts from an anchor that is NEVER LATER than the challenge's creation, and no earlier than the
// last moment the pump knows the challenge did not exist yet. Too late and the issuer's 60 s reserve shrinks; too early and the
// retry window closes before the challenge exists, so one transient first failure ends the stage as RELAY_REFUSED_NO_RETRY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox } from '../src/mailbox.mjs';
import { CALLBACK_WINDOW_MS, CHALLENGE_RESERVE_MS, COMPANION_CONFIG_CONTRACT, Companion, LINUX_OUTGOING, validateCompanionConfig } from '../src/companion.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot } from './helpers.mjs';

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const T0 = Date.parse('2026-10-29T10:00:00Z');
const TRANSFERRED = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
const NOT_THERE = { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
// A wsl.exe or VM hiccup that ends the call fast and leaves nothing behind: CHILD_FAILED, settled by the arrival check (DESIGN §25.2).
const TRANSIENT = { code: 2, stdout: JSON.stringify({ contract: 'clued.independent-ci.formal-public-relay-receipt/2', status: 'FAILED', failureCode: 'PUBLIC_CHILD_REFUSED_NO_RETRY',
  terminalConfirmed: true, processId: 4242, exitCode: 1, childError: { reason: 'EBUSY', stage: 'TRANSPORT' } }) };
const mode = a => (a.includes('-Mode') ? a[a.indexOf('-Mode') + 1] : null);

// A stage over a scripted worker. relayMs(mode, seq, attempt) -> how long the relay call takes; challengeAt(seq, world) -> the
// moment challenge seq appears in Linux outgoing (null: not yet decided); transient(seq, attempt) -> that ReceiveChallenge attempt
// fails fast and transiently; failListing(n, msSinceStart) -> { ms } to make that listing fail after ms. The result appears
// 10 s after the last response.
async function world(t, { relayMs = () => 5000, challengeAt, transient = () => false, failListing = () => null, rounds = 2, pace }) {
  let now = T0, startAt = null, listings = 0, finished = false;
  const box = await Mailbox.open(await tempRoot(t), () => now);
  const w = { responded: new Map(), sending: new Map(), attempts: new Map(), budgets: [], created: new Map(), listingStarts: [] };
  const exists = seq => { const at = challengeAt(seq, w, startAt); return at !== null && now >= at; };
  const run = async a => {
    const m = mode(a);
    if (m) {
      const seq = Number(a[a.indexOf('-Sequence') + 1] ?? 0);
      const attempt = (w.attempts.get(`${m}${seq}`) ?? 0) + 1;
      w.attempts.set(`${m}${seq}`, attempt);
      if (m === 'SendResponse' && !w.sending.has(seq)) w.sending.set(seq, now);
      now += relayMs(m, seq, attempt);
      if (m === 'SendResponse') { w.responded.set(seq, now); return TRANSFERRED; }
      if (m === 'SendIssue') return TRANSFERRED;
      if (m === 'ReceiveChallenge') return !exists(seq) ? NOT_THERE : transient(seq, attempt) ? TRANSIENT : TRANSFERRED;
      if (m === 'ReceiveResult') { if (w.responded.has(rounds) && now - w.responded.get(rounds) >= 10_000) { finished = true; return TRANSFERRED; } return NOT_THERE; }
      return NOT_THERE;
    }
    if (a.includes('--no-block')) { now += 250; startAt = now; return { code: 0, stdout: '' }; }
    if (a.some(x => x.startsWith('--property=ActiveState'))) { now += 250; return { code: 0, stdout: `ActiveState=${finished ? 'inactive' : 'active'}\nInvocationID=${'a'.repeat(32)}\nExecMainStartTimestampMonotonic=7\n` }; }
    if (a.includes('/usr/bin/ls') && a.includes(LINUX_OUTGOING)) {
      listings += 1;
      const failed = failListing(listings, now - startAt);
      if (failed) { now += failed.ms; return { code: 1, stdout: '' }; }
      w.listingStarts.push(now);
      now += 250;
      const names = [];
      for (let s = 1; s <= rounds; s += 1) if (exists(s)) { names.push(`challenge-0${s}.ready.json`); if (!w.created.has(s)) w.created.set(s, challengeAt(s, w, startAt)); }
      if (w.responded.has(rounds) && now - w.responded.get(rounds) >= 10_000) names.push('result.ready.json');
      return { code: 0, stdout: `${names.join('\n')}\n` };
    }
    if (a.includes('/usr/bin/ls') || a.includes('/usr/bin/pgrep')) return { code: a.includes('/usr/bin/pgrep') ? 1 : 0, stdout: '' };
    return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) };
  };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async p => p.includes('\\outgoing\\'), clock: () => now, sleep: async ms => { now += ms; }, ...(pace ? { listingDelay: pace } : {}) });
  const relay = c.relay.bind(c);
  c.relay = (m, seq, budget) => { if (m === 'ReceiveChallenge') w.budgets.push({ seq, firstSeen: budget.firstSeen, at: now }); return relay(m, seq, budget); };
  const req = await box.send('relay-stage', { batchId: '0123456789abcdef-0123456789ab', stage: 2, jobId: 'e'.repeat(64) }, 60 * 60_000);
  await c.step();
  return { ...w, answer: await box.poll(req), startAt, reserve: CALLBACK_WINDOW_MS - CHALLENGE_RESERVE_MS };
}

// Two callbacks back to back, as the gitleaks adapter makes them (admission, then remote-refs): challenge 2 is made the moment the
// worker has response 1. Relay calls are slow (the 25-45 s seen under load) except the ReceiveChallenge that fails.
const BACK_TO_BACK = (seq, w, startAt) => (seq === 1 ? (startAt === null ? null : startAt + 30_000) : (w.responded.get(1) ?? null));
const SLOW = (m, seq, attempt) => (m === 'SendResponse' || (m === 'ReceiveChallenge' && attempt === 1 && seq === 1) ? 40_000 : 5000);

for (const [name, pace] of [['the new pace', undefined], ['the old one-second pace', () => 1000]]) {
  test(`MAJOR-1 back-to-back challenges with slow relay calls (${name}): the anchor of challenge 2 is no later than its creation and its retry window is still open`, async t => {
    const r = await world(t, { relayMs: SLOW, challengeAt: BACK_TO_BACK, transient: (seq, attempt) => seq === 2 && attempt === 1, pace });
    const b = r.budgets.find(x => x.seq === 2);
    const created = r.created.get(2);
    assert.ok(b.firstSeen <= created, `the anchor ${(b.firstSeen - created) / 1000} s from the creation`);
    // challenge 2 cannot exist before response 1 began to be sent: that moment is the anchor (the listing before round 1 is not)
    assert.equal(b.firstSeen, r.sending.get(1));
    assert.ok(b.firstSeen + r.reserve > created, `the retry window ended ${(created - b.firstSeen - r.reserve) / 1000} s after the creation`);
    // and the retry is made: the first attempt failed fast and transiently, the second one moves the record
    assert.equal(r.attempts.get('ReceiveChallenge2'), 2);
    assert.deepEqual([r.answer.ok, r.answer.code], [true, null]);
  });
}

test('MAJOR-1 the anchor never goes backwards past what is known: first challenge from the start, later ones after the last response or listing', async t => {
  const r = await world(t, { challengeAt: BACK_TO_BACK });
  assert.ok(r.budgets.length >= 2);
  const b1 = r.budgets.find(x => x.seq === 1), b2 = r.budgets.find(x => x.seq === 2);
  assert.ok(b1.firstSeen <= r.created.get(1) && b1.firstSeen >= r.startAt - 1000, 'the first challenge: from the worker start');
  assert.ok(b2.firstSeen <= r.created.get(2) && b2.firstSeen >= r.sending.get(1));
});

test('MAJOR-2 a listing that fails does not move the anchor to now: the last good listing before the challenge stands, and it is not remembered as the sighting', async t => {
  // challenge 1 is made right after a good (empty) listing at 120 s; the next listing fails after its 15 s timeout; the relay call
  // is the probe, fails fast once, and is retried inside the window
  const made = { at: null };
  const r = await world(t, {
    rounds: 1,
    challengeAt: (seq, w, startAt) => { if (startAt === null) return null; if (made.at === null && w.listingStarts.length > 0 && w.listingStarts.at(-1) - startAt >= 120_000) made.at = w.listingStarts.at(-1) + 300; return made.at; },
    failListing: (n, rel) => (made.at !== null && rel >= 120_000 && !made.failed && (made.failed = true) ? { ms: 15_000 } : null),
    transient: (seq, attempt) => attempt === 1,
  });
  const b = r.budgets[0];
  const created = r.created.get(1) ?? made.at;
  assert.ok(made.failed, 'a listing failed');
  assert.ok(b.firstSeen <= created, `the anchor ${(b.firstSeen - created) / 1000} s from the creation (it was the clock of the failed listing)`);
  assert.ok(created - b.firstSeen <= 1500, `the anchor is the good listing before it (${(created - b.firstSeen) / 1000} s early)`);
  assert.equal(r.attempts.get('ReceiveChallenge1'), 2, 'the transient first failure is retried');
  assert.deepEqual([r.answer.ok, r.answer.code], [true, null]);
});

test('MAJOR-2 without any listing at all the anchor is the moment the worker was asked to start', async t => {
  const r = await world(t, { rounds: 1, challengeAt: (seq, w, startAt) => (startAt === null ? null : startAt + 20_000), failListing: () => ({ ms: 1000 }) });
  const b = r.budgets[0];
  assert.ok(b.firstSeen <= r.startAt && b.firstSeen >= r.startAt - 1000, `${b.firstSeen - r.startAt} ms from the start`);
});
