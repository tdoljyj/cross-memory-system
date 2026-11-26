import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ResidentExecutor, PARK_NUDGE_MS } from '../src/executor.mjs';
import { describe as prPage } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { Poller } from '../src/poller.mjs';
import { restAnswer } from './gh-rest-stub.mjs';
import { BASE, HEAD, executorFixture, rawPolicy, triggerBytes } from './helpers.mjs';
import { MIN, H, subject, KEY, stagesRun, notReady, stage8Engine, LIVE_SCAFFOLD, pinnedBack, sourceCode, stage8Tries, companionBeats, unreadable, beatsUntil } from './park-fixtures.mjs';

describe('parking: ruleset changes and companion wake-up', () => {
  test('bd07449b must-red 1-3: under the scaffold rules stage 8 parks asleep at its first try; no timed retry, no wake when the companion restarts; rules pinned back wake it', async t => {
    const code = sourceCode(LIVE_SCAFFOLD);
    assert.equal(code, 'RULESET_UNREADABLE', 'what the Source answers for the rules read on 11-25');
    assert.equal(sourceCode(pinnedBack()), null);
    const engine = stage8Engine([notReady(code), notReady(code), notReady(code)], KEY);
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    const first = await f.exec.tick();
    // must-red 1: asleep at once
    assert.deepEqual([first.state, first.reason, first.until, first.tries], ['PARKED', 'RULESET_UNREADABLE', null, 1]);
    const ended = (await f.ledger.state(KEY)).tries.at(-1).ended;
    assert.deepEqual([ended.code, ended.nextAt, ended.sleeping], ['RULESET_UNREADABLE', null, true]);
    assert.deepEqual(await stage8Tries(f), [['RULESET_UNREADABLE', null]]);
    assert.equal((await f.exec.parkedCounts()).outside, 0, 'a sleeping batch holds no parking place');
    assert.equal(f.queue.notices.filter(n => n.kind === 'stage8-rules' || n.code === 'STAGE8_TRY_LIMIT').length, 0, 'nobody is told by the executor');
    for (const minutes of [10, 20, 40]) {
      f.advance(minutes * MIN);
      assert.equal((await f.exec.tick()).state, 'IDLE', `${minutes} minutes later`);
    }
    assert.equal(stagesRun(engine).filter(stage => stage === 8).length, 1, 'no stage-8 try by the clock');
    // must-red 2: the companion restarts (a new poller: nothing observed yet) and reads the same rules
    let events = 0, checkReads = 0;
    const companion = () => new Poller({ repo: subject().repo, ghExe: 'gh', clock: f.clock,
      run: async argv => { checkReads++; return restAnswer(argv, { total_count: 1, check_runs: [{ id: 1, name: 'hosted-ci-suites', status: 'completed', conclusion: 'success' }] }); },
      writeTrigger: async trigger => { events++; await f.drop(Buffer.from(JSON.stringify(trigger))); } });
    // the rows as the companion reads them: the queue's view through the status board (state\status.json)
    const pending = () => { const b = new StatusBoard({ clock: f.clock }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
      b.setPending(f.queue.view(f.clock(), { etaBatchMs: 20 * MIN })); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))).pending; };
    assert.deepEqual(pending().filter(r => r.pr === 884).map(r => [r.state, r.deferred, r.nextAt, r.baseSha]), [['PARKED', 'RULESET_UNREADABLE', null, BASE]]);
    for (let restart = 0; restart < 3; restart++) {
      const poller = companion();
      poller.lastPass = { mainSha: BASE, pulls: [{ pr: 884, headSha: HEAD }] };
      await poller.parkedPass(pending());
      poller.noteBranchRules(LIVE_SCAFFOLD);
      await poller.parkedPass(pending());
      await poller.parkedPass(pending());
      assert.equal(events, 0, `restart ${restart}: the rules are still not this App's, nothing to wake for`);
      assert.equal((await f.exec.tick()).state, 'IDLE');
    }
    assert.equal(checkReads, 0, 'and no GitHub read is spent on it');
    assert.equal(stagesRun(engine).filter(stage => stage === 8).length, 1);
    // must-red 3: the rules change to the six pinned to this App: the next pass writes the wake, stage 8 is tried again
    const poller = companion();
    poller.lastPass = { mainSha: BASE, pulls: [{ pr: 884, headSha: HEAD }] };
    poller.noteBranchRules(LIVE_SCAFFOLD);
    await poller.parkedPass(pending());
    assert.equal(events, 0);
    poller.noteBranchRules(pinnedBack());
    await poller.parkedPass(pending());
    assert.equal(events, 1, 'one wake');
    await poller.parkedPass(pending());
    assert.equal(events, 1, 'and only one');
    const again = await f.exec.tick();
    assert.deepEqual([again.state, again.tries], ['PARKED', 2], 'stage 8 ran again (here it still answers the old code: asleep again)');
    assert.equal(stagesRun(engine).filter(stage => stage === 8).length, 2);
    assert.equal((await f.exec.tick()).state, 'IDLE');
  });

  test('bd07449b must-red 4 (resident half): RULESET_READ_FAILED parks and is read again after 1, 3, 10, 10 minutes; the try limit still tells the Owner once', async t => {
    const tries = 6;
    const engine = stage8Engine(Array.from({ length: tries }, () => notReady('RULESET_READ_FAILED')), KEY);
    const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: tries } }) });
    await f.drop(triggerBytes());
    const waits = [];
    for (let i = 0; i < tries; i++) {
      const r = await f.exec.tick();
      assert.deepEqual([r.state, r.reason, r.tries], ['PARKED', 'RULESET_READ_FAILED', i + 1]);
      if (r.until === null) { waits.push(null); break; }
      waits.push((r.until - f.clock()) / MIN);
      f.advance(r.until - f.clock() - 1);
      assert.equal((await f.exec.tick()).state, 'IDLE', 'not before its time');
      f.advance(1);
    }
    assert.deepEqual(waits, [1, 3, 10, 10, 10, null], 'short at first, then every 10 minutes; the try limit puts it to sleep');
    assert.equal(f.queue.notices.filter(n => n.code === 'STAGE8_TRY_LIMIT').length, 1);
    assert.equal(f.queue.notices.filter(n => n.kind === 'stage8-rules').length, 0);
    assert.equal(f.queue.breaker?.state ?? 'closed', 'closed', 'neutral');
  });

  test('bd07449b: the PR page says which of the two it is', () => {
    const now = Date.parse('2026-11-25T03:00:00Z');
    const board = rows => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.setPending(rows); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
    const pull = { pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 };
    const page = row => prPage({ pull, status: board([{ pr: 7, headSha: H(7), baseSha: BASE, state: 'PARKED', ...row }]), now }).description;
    assert.match(page({ deferred: 'RULESET_READ_FAILED', nextAt: now + MIN }), /^已测通：暂时读不到 main 的规则.*再查第 8 段/);
    assert.match(page({ deferred: 'RULESET_UNREADABLE', nextAt: null }), /^已测通：main 的必需检查没有全部钉在本执行器上.*规则钉回后/);
    assert.doesNotMatch(page({ deferred: 'RULESET_UNREADABLE', nextAt: null }), /读不到/);
  });

  test('bd07449b r2 must-red 3: put to sleep on RULESET_UNREADABLE again on the try it was woken for, the batch is woken again by the next beat', async t => {
    const engine = stage8Engine(Array.from({ length: 4 }, unreadable), KEY);
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    const first = await f.exec.tick();
    assert.deepEqual([first.state, first.reason, first.until, first.tries], ['PARKED', 'RULESET_UNREADABLE', null, 1]);
    const c = companionBeats(f);
    assert.deepEqual(c.readStatus().pending.filter(r => r.pr === 884).map(r => [r.state, r.deferred, r.nextAt]), [['PARKED', 'RULESET_UNREADABLE', null]]);
    await c.beat();
    assert.equal(c.events(), 1, 'the rules read pinned: a wake');
    const second = await f.exec.tick();
    assert.deepEqual([second.state, second.reason, second.until, second.tries], ['PARKED', 'RULESET_UNREADABLE', null, 2], 'stage 8 answers the same: asleep again');
    // the companion beats every minute; the world has not changed
    const runs = () => stagesRun(engine).filter(stage => stage === 8).length;
    for (let minute = 0; minute <= PARK_NUDGE_MS / MIN && runs() === 2; minute++) {
      await c.beat();
      await f.exec.tick();
      f.advance(MIN);
    }
    assert.equal(c.events(), 2, 'one more wake, for the second sleep');
    assert.equal(runs(), 3, 'the third try ran');
    const ended = (await f.ledger.state(KEY)).tries.map(x => x.ended?.code);
    assert.deepEqual(ended, ['RULESET_UNREADABLE', 'RULESET_UNREADABLE', 'RULESET_UNREADABLE']);
  });

  test('bd07449b r2 must-red 4: the companion reads the rules pinned and stage 8 answers RULESET_UNREADABLE for ever: a try at most every 5 minutes, none past the budget, the Owner told once', async t => {
    // a budget of 4 tries (policy park.stage8MaxTries, 12 by default) keeps the scene short; the companion beats every minute while tries
    // come, then every 10 minutes to the end of the 3 hours (a beat writes only a changed signal, so the coarser beat hides nothing)
    const limit = 4;
    const engine = stage8Engine(Array.from({ length: 30 }, unreadable), KEY);
    const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: limit } }) });
    await f.drop(triggerBytes());
    const start = f.clock();
    await f.exec.tick();
    const c = companionBeats(f);
    const at = [f.clock()];
    let runs = 1;
    while (f.clock() - start < 180 * MIN) {
      await c.beat();
      await f.exec.tick();
      const now = stagesRun(engine).filter(stage => stage === 8).length;
      if (now > runs) { at.push(f.clock()); runs = now; }
      f.advance(f.clock() - at.at(-1) < 15 * MIN ? MIN : 10 * MIN);
    }
    assert.ok(runs >= 3, `the third try happened (${runs} tries)`);
    assert.equal(runs, limit, 'tries up to the budget, none past it');
    // The first wake of a batch comes at once (executor.mjs#nudgeParked: no nudge before it), so the second try may follow the first in the
    // same minute; every later wake is at least PARK_NUDGE_MS after the one before it.
    const gaps = at.slice(1).map((x, i) => (x - at[i]) / MIN);
    assert.ok(gaps.slice(1).every(g => g >= PARK_NUDGE_MS / MIN), `woken tries at least 5 minutes apart: ${gaps.join(', ')}`);
    assert.ok(at.at(-1) - at[0] < 60 * MIN, 'the budget is spent within the first hour of the three');
    assert.equal(f.queue.notices.filter(n => n.code === 'STAGE8_TRY_LIMIT').length, 1, 'the Owner is told once');
    const [entry] = await f.ledger.parkedEntries();
    assert.equal(ResidentExecutor.lastTry(entry).sleeping, true);
    assert.equal(c.readStatus().pending.find(r => r.pr === 884).parkTry, limit - 1, 'the budget reached: the row keeps the parkTry that woke the last try (r3)');
  });

  test('bd07449b 重启守卫：预算休眠后检查列表暂时读不到，原列表恢复前后累计尝试均为 4 次，通知一次', async t => {
    const limit = 4;
    const engine = stage8Engine(Array.from({ length: 30 }, unreadable), KEY);
    const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: limit } }) });
    await f.drop(triggerBytes());
    await f.exec.tick();
    const at = [f.clock()];
    assert.equal(await beatsUntil(f, companionBeats(f), engine, f.clock() + 120 * MIN, at), limit, 'the budget, as must-red 4');
    const limitNotices = () => f.queue.notices.filter(n => n.code === 'STAGE8_TRY_LIMIT');
    assert.equal(limitNotices().length, 1);
    const noticeKey = limitNotices()[0].key;
    // The first new Poller starts without a confirmed check list. The original list then comes back.
    let checkId = null;
    const firstRestart = companionBeats(f, () => checkId);
    const unreadableChecks = await beatsUntil(f, firstRestart, engine, f.clock() + 15 * MIN, at);
    checkId = 1;
    const restored = await beatsUntil(f, firstRestart, engine, f.clock() + 45 * MIN, at);
    const afterSecond = await beatsUntil(f, companionBeats(f), engine, f.clock() + 60 * MIN, at);
    assert.deepEqual([unreadableChecks, restored, afterSecond], [limit, limit, limit], '读失败、原列表恢复及再次重启后的累计尝试');
    assert.deepEqual(limitNotices().map(n => n.key), [noticeKey], 'one STAGE8_TRY_LIMIT notice, the same one');
    const [entry] = await f.ledger.parkedEntries();
    assert.equal(ResidentExecutor.lastTry(entry).sleeping, true);
  });

  test('bd07449b 旧版停靠行的同一观察至多触发一次兼容续试，行和账本保留 null', async t => {
    const limit = 4;
    const engine = stage8Engine(Array.from({ length: 10 }, unreadable), KEY);
    const f = await executorFixture(t, { engine, policy: rawPolicy({ park: { ...rawPolicy().park, stage8MaxTries: limit } }) });
    await f.drop(triggerBytes());
    await f.exec.tick();
    const at = [f.clock()];
    assert.equal(await beatsUntil(f, companionBeats(f), engine, f.clock() + 60 * MIN, at), limit);
    // The r2 format had a parkEvent but no parkTry in the last 72 record, and null in the queue row.
    const ended = path.join(f.ledger.dir(KEY), '72-tried-04.json');
    const last = JSON.parse(await fs.readFile(ended, 'utf8'));
    assert.equal(typeof last.parkEvent, 'string');
    delete last.parkTry;
    await fs.writeFile(ended, JSON.stringify(last));
    assert.equal(f.queue.park(884, HEAD, { reason: 'RULESET_UNREADABLE', nextAt: null, position: null, parkTry: null }, f.clock()), true);
    const c = companionBeats(f);
    const after = await beatsUntil(f, c, engine, f.clock() + 45 * MIN, at);
    const restarted = await beatsUntil(f, companionBeats(f), engine, f.clock() + 45 * MIN, at);
    assert.deepEqual([after, restarted], [limit + 1, limit + 1], '同一观察只产生一次兼容续试');
    assert.equal(c.readStatus().pending.find(r => r.pr === 884).parkTry, null, '状态行保留显式 null');
    const saved = (await f.ledger.state(KEY)).tries.at(-1).ended;
    assert.equal(saved.parkTry, null, '账本保留显式 null');
    assert.equal(typeof saved.parkEvent, 'string', '账本记录已消费的唤醒信号');
    assert.equal(f.queue.notices.filter(n => n.code === 'STAGE8_TRY_LIMIT').length, 1);
  });

  test('bd07449b 队首设计说明区分预算休眠阈值、事件唤醒与每 PR 滚动额度', () => {
    const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
    const guard = design.split(/\r?\n/).find(line => line.includes('叫醒信号带“第几次睡”'));
    assert.match(guard, /99 次.*或停靠满 24 小时.*后进入预算休眠.*睡眠序号停止推动后续重试.*新的有效事件仍可唤醒.*每 PR 仍受滚动 24 小时 100 次重试额度约束/,
      '队首达到次数或停靠时龄阈值会休眠，新事件依然按每 PR 滚动额度准入');
  });
});
