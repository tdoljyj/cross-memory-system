// Generation 12 (DESIGN §56.3): the claim's lease end, as stage 1 and each stage-8 try read it from Native, reaches the status
// page and the PR page; when it ends before the batch can finish, the holder is told to renew (and the Owner once). A reminder
// only: nothing the executor decides reads it, and without a fact nothing is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEASE_BATCH_ESTIMATE_MS, LEASE_MARGIN_MS, StatusBoard, leaseShort, parseStatus } from '../src/status.mjs';
import { describe, events, leaseText } from '../src/pr-status.mjs';
import { parseStageOutcome } from '../src/engine-windows.mjs';
import { ResidentExecutor } from '../src/executor.mjs';
import { HEAD as FIXTURE_HEAD, RELAY_ON, SAFE_REFUSAL, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, hintFor, notAdmitted, rawPolicy, relayedRow, triggerBytes } from './helpers.mjs';
import { PARK_RETRY_MS } from '../src/executor.mjs';
import { STAGE8_LEASE_MINUTES } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/claim-assist-native.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-05T08:00:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const MAIN = 'f'.repeat(40);

test('leaseShort: running needs the batch estimate left plus the margin; parked needs the margin; expired is expired', () => {
  const since = T0;
  assert.equal(leaseShort({ expiresAt: T0 + LEASE_BATCH_ESTIMATE_MS + LEASE_MARGIN_MS, now: T0, running: true, since }), null);
  assert.equal(leaseShort({ expiresAt: T0 + LEASE_BATCH_ESTIMATE_MS + LEASE_MARGIN_MS - 1, now: T0, running: true, since }), 'short');
  // later in the batch less is left to cover
  assert.equal(leaseShort({ expiresAt: T0 + 52 * MIN, now: T0 + 15 * MIN, running: true, since }), null);
  assert.equal(leaseShort({ expiresAt: T0 + 51 * MIN, now: T0 + 15 * MIN, running: true, since }), "short");
  assert.equal(leaseShort({ expiresAt: T0 + LEASE_MARGIN_MS, now: T0, running: false }), null);
  assert.equal(leaseShort({ expiresAt: T0 + LEASE_MARGIN_MS - 1, now: T0, running: false }), 'short');
  assert.equal(leaseShort({ expiresAt: T0, now: T0, running: false }), 'expired');
  for (const bad of [null, undefined, 'x', 1.5]) assert.equal(leaseShort({ expiresAt: bad, now: T0 }), null, String(bad));
});

test('the engine keeps claimExpiresAt from the stage outcome only when it is a time', () => {
  const o = s => parseStageOutcome({ status: 'BLOCKED', reason: 'x', sideEffects: 0, mayHavePublished: false, scheduling: s });
  assert.equal(o({ claimExpiresAt: '2026-11-05T09:00:00.000Z' }).scheduling.claimExpiresAt, '2026-11-05T09:00:00.000Z');
  assert.equal(o({ claimExpiresAt: 'later' }).scheduling.claimExpiresAt, null);
  assert.equal(o({}).scheduling.claimExpiresAt, null);
});

const boardStatus = (fn, now) => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
const pull = { pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 };

test('the PR page: a running batch whose lease is short says renew now; a parked one too; a long or unknown lease adds nothing', () => {
  const now = T0 + 5 * MIN;
  const running = exp => describe({ pull, now, status: boardStatus(b => b.setCurrent({ key: 'a'.repeat(64), pr: 7, headSha: H(7), baseSha: MAIN, attempt: 1, stage: 4,
    since: new Date(T0).toISOString(), claimExpiresAt: exp }), now) }).description;
  assert.match(running(new Date(T0 + 40 * MIN).toISOString()), /^运行中：第 4 段（trivy 扫描）；认领约 08:40Z 到期，请现在续租（已续租可忽略）$/);
  assert.equal(running(new Date(T0 + 3 * 60 * MIN).toISOString()), '运行中：第 4 段（trivy 扫描）');
  assert.equal(running(null), '运行中：第 4 段（trivy 扫描）', 'no fact, no guess');
  assert.match(running(new Date(T0).toISOString()), /按上次读到的租约，认领已于 08:00Z 到期（已续租可忽略）/);
  const parked = (exp, watched = true, deferred = 'RESIDENT_MERGE_QUEUE_NOT_JOINED') => describe({ pull, now, status: boardStatus(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN,
    state: 'PARKED', deferred, nextAt: new Date(T0 + 15 * MIN).toISOString(), claimExpiresAt: exp, watched }]), now) }).description;
  assert.equal(parked(new Date(T0 + 20 * MIN).toISOString()), '已测通：现在加入合并队列，排到队首后几分钟内查第 8 段（最晚约 08:15Z）；认领约 08:20Z 到期，请现在续租（已续租可忽略）');
  assert.equal(parked(null), '已测通：现在加入合并队列，排到队首后几分钟内查第 8 段（最晚约 08:15Z）');
  // not watched (an older Source, STANDBY, a budget used up): the generation-11 text, with the reminder
  assert.equal(parked(null, false), '已测通：现在加入合并队列，约 08:15Z 再查第 8 段');
  assert.equal(parked(new Date(T0 + 20 * MIN).toISOString(), false), '已测通：现在加入合并队列，约 08:15Z 再查第 8 段；认领约 08:20Z 到期，请现在续租（已续租可忽略）');
  assert.ok(parked(new Date(T0 + 20 * MIN).toISOString()).length <= 140);
  assert.equal(leaseText({ claimExpiresAt: null }, now, { running: false }), '');
});

test('the Owner hears once per lease end: the lease-short notice becomes one notification', () => {
  const now = T0;
  const status = boardStatus(b => b.update({ notices: [{ key: `lease-short:7:${H(7).slice(0, 12)}:${T0 + 20 * MIN}:short`, kind: 'lease-short', pr: 7, headSha: H(7), code: 'CLAIM_LEASE_SHORT', at: new Date(T0).toISOString(), until: new Date(T0 + 20 * MIN).toISOString() }] }), now);
  const out = events({ status, now }).filter(e => e.key.startsWith('notice:lease-short'));
  assert.equal(out.length, 1);
  assert.match(out[0].title, /PR #7 的认领快到期/);
  assert.match(out[0].body, /约 08:20Z 到期.*clued_work_renew/);
});

// The executor: stage 1 and the stage-8 try carry the lease end; the status shows it; a short one gives one notice.
const withLease = (r, exp) => ({ ...r, outcome: { status: r.ok ? 'SETTLED' : 'BLOCKED', reason: r.code ?? null, sideEffects: 0, mayHavePublished: !r.ok ? false : true, diagnostic: null,
  scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null }, claimExpiresAt: exp }, safeToRerun: false } });
async function leaseFx(t, { stage1Exp, stage8Exp, stage8Ok = false }) {
  const engine = fakeEngine();
  const run = engine.runStage;
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) { engine.calls.push(['stage', 1]); return withLease({ ok: true, factsSha256: 'd'.repeat(64) }, stage1Exp); }
    if (stage.number === 8) {
      engine.calls.push(['stage', 8]);
      return stage8Ok ? withLease({ ok: true, factsSha256: 'd'.repeat(64) }, stage8Exp) : withLease({ ok: false, code: 'RESIDENT_MERGE_QUEUE_NOT_JOINED', proof: WINDOWS_CLEAN, brokerNoLaunch: false }, stage8Exp);
    }
    return run(batch, stage, o);
  };
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine, status: board, now: T0 });
  f.board = board;
  return f;
}

test('executor: the lease end of the last admission reaches the status; a short one at B is one lease-short notice; network cut = no fact, no notice', async t => {
  const f = await leaseFx(t, { stage1Exp: new Date(T0 + 3 * 60 * MIN).toISOString(), stage8Exp: new Date(T0 + 20 * MIN).toISOString() });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const s = parseStatus(Buffer.from(JSON.stringify(f.board.snapshot())));
  const row = s.pending.find(p => p.state === 'PARKED');
  assert.equal(row.claimExpiresAt, T0 + 20 * MIN, 'the stage-8 try read is the newest');
  f.exec.reportQueue();
  f.exec.reportQueue();
  const notices = f.exec.queue.notices.filter(n => n.kind === 'lease-short');
  assert.equal(notices.length, 1, 'once per lease end');
  assert.equal(notices[0].code, 'CLAIM_LEASE_SHORT');
  // the holder renews: the next try reads the new end; no new notice for a lease that is long enough
  const entries = await f.ledger.parkedEntries();
  assert.equal(ResidentExecutor.lastTry(entries[0]).claimExpiresAt, new Date(T0 + 20 * MIN).toISOString(), 'kept in the try record');
  // a restarted executor gets it back from that record
  const restarted = new ResidentExecutor(f.ports);
  await restarted.resumeParked();
  assert.equal(restarted.leaseOf({ pr: 884, headSha: entries[0].reserved.subject.headSha }), new Date(T0 + 20 * MIN).toISOString());

  const cut = await leaseFx(t, { stage1Exp: null, stage8Exp: null });
  await cut.drop(triggerBytes());
  assert.equal((await cut.exec.tick()).state, 'PARKED');
  cut.exec.reportQueue();
  assert.equal(cut.exec.queue.notices.filter(n => n.kind === 'lease-short').length, 0);
  assert.equal(parseStatus(Buffer.from(JSON.stringify(cut.board.snapshot()))).pending.find(p => p.state === 'PARKED').claimExpiresAt, null);
});

test('executor: a running batch carries stage 1\'s lease end on the status; the lease is forgotten once the batch ended', async t => {
  const f = await leaseFx(t, { stage1Exp: new Date(T0 + 3 * 60 * MIN).toISOString(), stage8Exp: new Date(T0 + 3 * 60 * MIN).toISOString(), stage8Ok: true });
  const seen = [];
  const set = f.board.setCurrent.bind(f.board);
  f.board.setCurrent = c => { if (c) seen.push([c.stage, c.claimExpiresAt ?? null]); return set(c); };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(seen.find(([stage]) => stage === 2), [2, new Date(T0 + 3 * 60 * MIN).toISOString()]);
  assert.equal(seen.find(([stage]) => stage === 1)[1], null, 'before stage 1 answered nothing is known');
  f.exec.reportQueue();
  assert.equal(f.exec.claimLeases.size, 0);
});

test('the lease end is kept in the parking record and in a transient try record; a restart restores it from the newest record', async t => {
  const exp1 = new Date(T0 + 3 * 60 * MIN).toISOString(), exp8 = new Date(T0 + 20 * MIN).toISOString();
  const f = await leaseFx(t, { stage1Exp: exp1, stage8Exp: exp8 });
  // the stage-8 try ends on a transient Native failure (DESIGN §28): parked again, the try record still carries the lease end
  const run = f.engine.runStage;
  let first = true;
  f.engine.runStage = async (batch, stage, o) => {
    if (stage.number === 8 && first) {
      first = false; f.engine.calls.push(['stage', 8]);
      return withLease({ ok: false, code: 'NATIVE_ADMISSION_UNAVAILABLE', proof: WINDOWS_CLEAN, brokerNoLaunch: false }, exp8);
    }
    return run(batch, stage, o);
  };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const [entry] = await f.ledger.parkedEntries();
  assert.equal(entry.parked.claimExpiresAt, exp1, 'the parking record keeps stage 1\'s lease end');
  const last = ResidentExecutor.lastTry(entry);
  assert.equal(last.transient, true);
  assert.equal(last.claimExpiresAt, exp8);
  const restarted = new ResidentExecutor(f.ports);
  await restarted.resumeParked({ hold: true });
  assert.equal(restarted.leaseOf(entry.reserved.subject), exp8, 'the newest record wins, and a held resume still restores');
  // without a try record the parking record is used
  const bare = new ResidentExecutor(f.ports);
  bare.ledger = { ...f.ledger, parkedEntries: async () => [{ ...entry, tries: [] }] };
  Object.setPrototypeOf(bare.ledger, Object.getPrototypeOf(f.ledger));
  await bare.resumeParked({ hold: true });
  assert.equal(bare.leaseOf(entry.reserved.subject), exp1);
});

test('review round 2: a batch at parking point A that is not the current one shows the reminder (its whole run is ahead)', () => {
  const now = T0;
  const rowAt = exp => describe({ pull, now, status: boardStatus(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, state: 'RUNNING', reason: 'PARKED_A', claimExpiresAt: exp }]), now) });
  assert.deepEqual(rowAt(new Date(T0 + 40 * MIN).toISOString()), { state: 'pending', description: '运行中：等待托管信号；认领约 08:40Z 到期，请现在续租（已续租可忽略）' });
  assert.deepEqual(rowAt(new Date(T0 + 3 * 60 * MIN).toISOString()), { state: 'pending', description: '运行中：等待托管信号' });
});

test('review round 4: Native reached but naming no lease end forgets the stored one; a restart takes the newest record that has the field', async t => {
  const exp1 = new Date(T0 + 3 * 60 * MIN).toISOString();
  const f = await leaseFx(t, { stage1Exp: exp1, stage8Exp: null });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const [entry] = await f.ledger.parkedEntries();
  assert.equal(entry.parked.claimExpiresAt, exp1, 'stage 1 named one');
  assert.equal(ResidentExecutor.lastTry(entry).claimExpiresAt, null, 'stage 8 reached Native and it named none');
  assert.equal(f.exec.leaseOf(entry.reserved.subject), null, 'forgotten, not the stale stage-1 end');
  const restarted = new ResidentExecutor(f.ports);
  await restarted.resumeParked({ hold: true });
  assert.equal(restarted.leaseOf(entry.reserved.subject), null, 'the newest record says none');
  // an outcome without scheduling facts (Native not reached) changes nothing
  f.exec.noteLease(entry.reserved.subject, { outcome: { scheduling: { claimExpiresAt: exp1 } } });
  f.exec.noteLease(entry.reserved.subject, { outcome: { scheduling: null } });
  assert.equal(f.exec.leaseOf(entry.reserved.subject), exp1);
});

test('review round 5: a batch at A says HALT or PAUSE like any queue row, not "运行中"', () => {
  const now = T0;
  const at = extra => describe({ pull, now, status: boardStatus(b => { b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, state: 'RUNNING', reason: 'PARKED_A' }]); b.update(extra); }, now) });
  assert.deepEqual(at({ halt: { code: 'ROLE_PROBE_INTERRUPTED', at: new Date(T0).toISOString() } }), { state: 'error', description: '执行器已停机（ROLE_PROBE_INTERRUPTED），等 Owner 复位' });
  assert.deepEqual(at({ paused: true }), { state: 'pending', description: '执行器已暂停，等 Owner 恢复' });
});

test('review round 6: the lease end may be old; the expired notice never advises a new commit', () => {
  const now = T0;
  const status = boardStatus(b => b.update({ notices: [{ key: `lease-short:7:${H(7).slice(0, 12)}:${T0}:expired`, kind: 'lease-short', pr: 7, headSha: H(7), code: 'CLAIM_LEASE_EXPIRED', at: new Date(T0).toISOString(), until: new Date(T0 - MIN).toISOString() }] }), now);
  const [e] = events({ status, now }).filter(x => x.key.startsWith('notice:lease-short'));
  assert.equal(e.title, 'PR #7 的认领可能已到期');
  assert.doesNotMatch(e.body, /推新提交|重新认领/);
  assert.match(e.body, /已续租可忽略/);
});

test('review round 13: the running batch is reminded during the run, not only when it parks or ends', async t => {
  const f = await leaseFx(t, { stage1Exp: new Date(T0 + 30 * MIN).toISOString(), stage8Exp: new Date(T0 + 30 * MIN).toISOString(), stage8Ok: true });
  let during = null;
  const run = f.engine.runStage;
  f.engine.runStage = async (batch, stage, o) => { if (stage.number === 3) during = f.exec.queue.notices.filter(n => n.kind === 'lease-short').length; return run(batch, stage, o); };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(during, 1, 'the lease-short notice exists at stage 3');
});

test('review round 13: a watched parked row without a known queue place gets the watched text too', () => {
  const now = T0;
  const d = watched => describe({ pull, now, status: boardStatus(b => b.setPending([{ pr: 7, headSha: H(7), baseSha: MAIN, state: 'PARKED', deferred: 'RESIDENT_QUEUE_HEAD_NOT_REACHED',
    nextAt: new Date(T0 + 15 * MIN).toISOString(), watched }]), now) }).description;
  assert.equal(d(true), '已测通：等合并队列，排到队首后几分钟内查第 8 段（最晚约 08:15Z）');
  assert.equal(d(false), '已测通：等合并队列，约 08:15Z 再查第 8 段');
});

test('review round 16: the current batch resting at A, reserved long ago, is counted as just started on the PR page (like the Owner notice)', () => {
  const now = T0 + 40 * MIN;
  const current = exp => describe({ pull, now, status: boardStatus(b => b.setCurrent({ key: 'a'.repeat(64), pr: 7, headSha: H(7), baseSha: MAIN, attempt: 1, stage: null,
    since: new Date(T0).toISOString(), claimExpiresAt: exp }), now) }).description;
  // 45 minutes left: short for a batch with its whole run ahead (22 + 30 minutes)
  assert.equal(current(new Date(T0 + 85 * MIN).toISOString()), '运行中：等待托管信号；认领约 09:25Z 到期，请现在续租（已续租可忽略）');
  assert.equal(current(new Date(T0 + 40 * MIN + 53 * MIN).toISOString()), '运行中：等待托管信号');
});

test('review round 17: a lease the CI extends at each try never triggers the reminder before the next try', () => {
  const ext = T0, tryEnd = T0 + 2 * MIN;
  const expiresAt = ext + STAGE8_LEASE_MINUTES * 60_000, nextAt = tryEnd + PARK_RETRY_MS.at(-1);
  assert.equal(leaseShort({ expiresAt, now: nextAt, running: false }), null, 'parked at the next try');
  assert.equal(leaseShort({ expiresAt, now: nextAt + MIN, running: true, since: T0 - 3 * 60 * MIN }), null, 'during the next stage-8 try');
  assert.ok(STAGE8_LEASE_MINUTES * 60_000 >= PARK_RETRY_MS.at(-1) + LEASE_MARGIN_MS + 10 * MIN, 'room above back-off plus margin');
});

test('review round 17: a stage-1 refusal that released the batch gives no "running" lease reminder', async t => {
  const exp = new Date(T0 + 10 * MIN).toISOString();
  const out = { ...SAFE_REFUSAL, scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null }, claimExpiresAt: exp } };
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine: fakeEngine({ stages: { 1: notAdmitted('NATIVE_NOT_ADMITTED', out) } }), status: board, now: T0 });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.ok(['BACKOFF', 'WAITING'].includes(f.queue.row(884)?.state), f.queue.row(884)?.state);
  f.exec.reportQueue();
  assert.deepEqual(f.exec.queue.notices.filter(n => n.kind === 'lease-short'), []);
});

test('review round 17: a batch going on from A after a long wait is no longer shown at A, and its page and notice agree (counted from then)', async t => {
  const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role)) }) });
  const run = engine.runStage;
  let f;
  const seen = [];
  const exp = new Date(T0 + 90 * MIN).toISOString();
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) { engine.calls.push(['stage', 1]); return withLease({ ok: true, factsSha256: 'd'.repeat(64) }, exp); }
    const st = parseStatus(Buffer.from(JSON.stringify(f.exec.status.snapshot())));
    seen.push({ stage: stage.number, row: st.pending.find(p => p.pr === 884)?.deferred ?? null,
      page: describe({ pull: { pr: 884, headSha: FIXTURE_HEAD, eligible: true }, status: st, now: f.clock() }).description,
      notice: f.exec.queue.notices.some(n => n.kind === 'lease-short') });
    return run(batch, stage, o);
  };
  let ready = false;
  const companion = fakeCompanion({ hint: (s, now) => ready ? hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } }, { pr: s.pr, head: s.headSha, at: now }) : null });
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine, companion, status: board, now: T0, policy: rawPolicy({ relay: RELAY_ON }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  for (let i = 0; i < 9; i++) { f.advance(5 * MIN); await f.exec.tick(); }
  ready = true;
  f.advance(MIN);
  await f.exec.tick();
  assert.ok(seen.length > 0);
  for (const x of seen) {
    assert.notEqual(x.row, 'PARKED_A', `stage ${x.stage}: not shown at A any more`);
    // 44 minutes left, counted from now (22 + 30 needed): both the page and the notice say renew
    assert.match(x.page, /请现在续租/, `stage ${x.stage}`);
    assert.equal(x.notice, true, `stage ${x.stage}`);
  }
});

test('review round 19: a lease kept from a refused earlier attempt of the head is forgotten when the next attempt starts (no false "expired")', async t => {
  const exp = new Date(T0 + 10 * MIN).toISOString();
  const out = { ...SAFE_REFUSAL, scheduling: { ciRetryAfter: null, mergeQueue: { entered: false, state: null, position: null }, claimExpiresAt: exp } };
  let f, calls = 0, seenAtSecond = null;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  const engine = fakeEngine();
  const run = engine.runStage;
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) {
      calls += 1;
      if (calls === 1) return notAdmitted('NATIVE_NOT_ADMITTED', out);
      seenAtSecond = { notices: f.exec.queue.notices.filter(n => n.kind === 'lease-short').map(n => n.code), lease: f.exec.leaseOf({ pr: 884, headSha: FIXTURE_HEAD }) };
      return notAdmitted('NATIVE_NOT_ADMITTED', { ...out, scheduling: { ...out.scheduling, claimExpiresAt: new Date(f.clock() + 5 * 60 * MIN).toISOString() } });
    }
    return run(batch, stage, o);
  };
  f = await executorFixture(t, { engine, status: board, now: T0 });
  await f.drop(triggerBytes());
  await f.exec.tick();
  f.advance(3 * 60 * MIN);
  for (let i = 0; i < 5 && calls < 2; i++) { await f.exec.tick(); f.advance(MIN); }
  assert.equal(calls, 2, 'a second attempt ran');
  assert.deepEqual(seenAtSecond, { notices: [], lease: null }, 'the stale end is gone before the new batch shows as running');
});

test('review round 18: the batch in flight resting at A, whose PR row shows a newer commit, is counted from now (one CLAIM_LEASE_SHORT)', async t => {
  const engine = fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role)) }) });
  const run = engine.runStage;
  // 70 minutes at stage 1; after 30 minutes at A, 40 are left: short for a batch with its whole run ahead (22 + 30), not for one
  // counted from its reservation 30 minutes ago (30 only)
  const exp = new Date(T0 + 70 * MIN).toISOString();
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) { engine.calls.push(['stage', 1]); return withLease({ ok: true, factsSha256: 'd'.repeat(64) }, exp); }
    return run(batch, stage, o);
  };
  const companion = fakeCompanion({ hint: () => null });
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine, companion, status: board, now: T0, policy: rawPolicy({ relay: RELAY_ON }) });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  assert.deepEqual(f.exec.queue.notices.filter(n => n.kind === 'lease-short'), []);
  await f.drop(triggerBytes({ headSha: 'd'.repeat(40) }));
  f.advance(30 * MIN);
  assert.equal((await f.exec.tick()).state, 'WAITING');
  assert.equal(f.queue.row(884)?.current?.headSha, 'd'.repeat(40), 'the PR row shows the newer commit');
  const notices = f.exec.queue.notices.filter(n => n.kind === 'lease-short');
  assert.deepEqual(notices.map(n => [n.code, n.headSha]), [['CLAIM_LEASE_SHORT', FIXTURE_HEAD]]);
});

test('review round 20: a ready try that hit a transient failure after the CI extended the lease parks with the extended end (no false reminder)', async t => {
  // 60 minutes from stage 1: enough while running (22 + 30); the try takes 35 minutes, after which the old end would be short at B (< 30)
  const short = new Date(T0 + 60 * MIN).toISOString(), extended = new Date(T0 + 180 * MIN).toISOString();
  const f = await leaseFx(t, { stage1Exp: short, stage8Exp: short });
  const run = f.engine.runStage;
  f.engine.runStage = async (batch, stage, o) => {
    if (stage.number === 8) {
      f.engine.calls.push(['stage', 8]);
      f.advance(35 * MIN);
      // the publisher's not-ready answer after a ready head: the lease end only, no queue place (publisher.mjs#publishPair)
      const r = withLease({ ok: false, code: 'NATIVE_ADMISSION_UNAVAILABLE', proof: WINDOWS_CLEAN, brokerNoLaunch: false }, extended);
      return { ...r, outcome: { ...r.outcome, scheduling: parseStageOutcome({ ...r.outcome, scheduling: { ciRetryAfter: null, mergeQueue: null, claimExpiresAt: extended } }).scheduling } };
    }
    return run(batch, stage, o);
  };
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'PARKED');
  const [entry] = await f.ledger.parkedEntries();
  const last = ResidentExecutor.lastTry(entry);
  assert.deepEqual([last.transient, last.position ?? null, last.claimExpiresAt], [true, null, extended], 'a transient try as before, with the extended end');
  assert.equal(f.exec.leaseOf(entry.reserved.subject), extended);
  f.exec.reportQueue();
  assert.deepEqual(f.exec.queue.notices.filter(n => n.kind === 'lease-short'), []);
});
