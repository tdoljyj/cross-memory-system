import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { ResidentExecutor, PARK_NUDGE_MS } from '../src/executor.mjs';
import { executorFixture, rawPolicy, triggerBytes } from './helpers.mjs';
import { MIN, KEY, stagesRun, notReady, stage8Engine, companionBeats, unreadable, beatsUntil, seedStage8History } from './park-fixtures.mjs';

describe('parking: the ruleset wake-up and rolling retry budget', () => {
  test('bd07449b 队首停靠满 24 小时后可由新事件唤醒，续试受每 PR 滚动额度约束', async t => {
    const head = () => notReady('RULESET_UNREADABLE', { entered: true, state: 'waiting', position: 1 });
    const engine = stage8Engine([head(), head(), head()], KEY);
    const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8RetriesPer24h: 1 } }) });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).tries, 1);
    f.advance(25 * 60 * MIN);
    assert.equal((await f.exec.tick()).state, 'IDLE', '到龄未收到新事件时保持休眠');
    let checkId = 1;
    const c = companionBeats(f, () => checkId);
    await c.beat();
    assert.equal((await f.exec.tick()).tries, 2, '规则钉回是有效事件，额度内可续试');
    assert.equal(c.readStatus().pending.find(r => r.pr === 884).parkTry, 1, '到龄后的续试保持睡眠序号');
    checkId = 2;
    f.advance(PARK_NUDGE_MS);
    await c.beat();
    assert.equal(c.events(), 2, '检查变化产生新的唤醒事件');
    assert.equal((await f.exec.tick()).state, 'IDLE', '滚动重试额度用完后保持休眠');
    assert.deepEqual((await f.ledger.state(KEY)).tries.map(x => x.n), [1, 2]);
    assert.deepEqual(f.queue.notices.map(n => n.code), ['STAGE8_RETRY_BUDGET_EXHAUSTED']);
  });

  test('bd07449b 队首守卫：99 次或停靠满 24 小时后进入预算休眠，有效事件仍可唤醒，每 PR 仍受滚动 24 小时 100 次重试额度约束', async t => {
    const head = () => notReady('RULESET_UNREADABLE', { entered: true, state: 'waiting', position: 1 });
    const engine = stage8Engine(Array.from({ length: 60 }, head), KEY);
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    const start = f.clock();
    const first = await f.exec.tick();
    assert.deepEqual([first.state, first.reason, first.until, first.position], ['PARKED', 'RULESET_UNREADABLE', null, 1]);
    let checkId = 1;
    const c = companionBeats(f, () => checkId);
    const at = [f.clock()];
    // 14 tries live, more than park.stage8MaxTries (12): none of them counted, each one woken again
    const live = 14;
    assert.ok(live > rawPolicy().park.stage8MaxTries);
    assert.equal(await beatsUntil(f, c, engine, start + 6 * 60 * MIN, at, live), live);
    // the tries after them up to the 94th, the records as ledger.mjs#beginTry and #endTry write them (through the ledger every write
    // reads all the tries before it: minutes). Then every beat reads a ledger of over 90 tries: the walk to budget sleep and after it beats
    // every 5 minutes (the wake spacing was seen beat by beat above).
    await seedStage8History(f, KEY, live + 1, 94, 'x',
      n => ({ code: 'RULESET_UNREADABLE', nextAt: null, position: 1, entered: true, parkTry: n, sleeping: true }));
    assert.equal((await f.ledger.state(KEY)).tries.length, 94);
    const runs = await beatsUntil(f, c, engine, f.clock() + 60 * MIN, at, live + 99 - 94, 5 * MIN);
    const settled = await beatsUntil(f, c, engine, f.clock() + 15 * MIN, at, Infinity, 5 * MIN);
    // and past park.maxMs (24 hours from parking): two beats
    f.advance(Math.max(0, start + 25 * 60 * MIN - f.clock()));
    for (let i = 0; i < 2; i++) { await c.beat(); await f.exec.tick(); f.advance(10 * MIN); }
    const after = stagesRun(engine).filter(stage => stage === 8).length;
    const gaps = at.slice(1, live + 5).map((x, i) => (x - at[i]) / MIN);
    const codes = [...new Set(f.queue.notices.map(n => n.code))];
    t.diagnostic(`live tries ${runs} (ledger ${(await f.ledger.state(KEY)).tries.length}); gaps ${[...new Set(gaps)].join(',')}; notice codes ${JSON.stringify(codes)}`);
    assert.equal(runs, live + 99 - 94, '队首达到第 99 次后进入预算休眠');
    assert.deepEqual([settled, after], [runs, runs], '睡眠序号停止推动后续重试，停靠满 24 小时后同一观察也不再唤醒');
    assert.ok(gaps.slice(1).every(g => g >= PARK_NUDGE_MS / MIN), 'after the first wake, at least PARK_NUDGE_MS between wakes');
    const [entry] = await f.ledger.parkedEntries();
    assert.deepEqual([entry.tries.length, ResidentExecutor.lastTry(entry).sleeping, ResidentExecutor.lastTry(entry).position], [99, true, 1]);
    assert.equal(c.readStatus().pending.find(r => r.pr === 884).parkTry, 98, '预算休眠时保留前序停靠行的睡眠序号');
    assert.deepEqual(codes, [], '队首尝试不计入 stage8MaxTries，预算休眠时无次数通知');
    checkId = 2;
    await c.beat();
    assert.equal((await f.exec.tick()).tries, 100, '新的有效检查事件在每 PR 滚动 24 小时 100 次重试额度内唤醒第 100 次尝试');
  });

  // Task bd07449b r3, independent review r2 (must-red): the poller forgets a row it does not see asleep (poller.mjs#parkedPass drops the
  // observation of every head not in the sleeping list), so "the last parkTry seen" cannot carry the budget. One Poller beats every minute
  // and also once while each stage-8 try runs (the row RUNNING then); the budget reached, the batch must not be woken again.
  test('bd07449b r3 must-red: a beat that sees the row RUNNING during the last try does not wake the batch past its budget', async t => {
    const limit = 4;
    let during = async () => {};
    const engine = stage8Engine(Array.from({ length: 40 }, unreadable), KEY);
    const base = engine.runStage;
    engine.runStage = async (batch, stage, o) => { if (stage.number === 8) await during(); return base(batch, stage, o); };
    const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: limit } }) });
    await f.drop(triggerBytes());
    await f.exec.tick();
    const c = companionBeats(f);
    during = () => c.runningBeat();
    const at = [f.clock()];
    const runs = await beatsUntil(f, c, engine, f.clock() + 120 * MIN, at);
    const eventsAtBudget = c.events();
    const more = await beatsUntil(f, c, engine, f.clock() + 60 * MIN, at);
    assert.equal(runs, limit, `tries up to the budget, none past it (${runs}; tries at minutes ${at.map(x => (x - at[0]) / MIN).join(', ')})`);
    assert.equal(more, limit, 'an hour later still none');
    assert.ok(c.events() - eventsAtBudget <= 1, `no wake that runs a try (${c.events() - eventsAtBudget} trigger(s) written past the budget)`);
    assert.equal(f.queue.notices.filter(n => n.code === 'STAGE8_TRY_LIMIT').length, 1);
    assert.equal(c.readStatus().pending.find(r => r.pr === 884).parkTry, limit - 1, 'the budget reached: the row keeps the parkTry that woke the last try');
  });
});
