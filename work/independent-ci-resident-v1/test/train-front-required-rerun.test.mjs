// Fable 11-20“补：车头缺必需检查”（Clued Task 6ed681d6，合修 9aba97c1）。#1192 的替身现场：车头 head 上常驻的六项都已绿（含合并位），
// 线上规则另要求的 Actions 四项（ci-suites、clued-cloud-tests、migration-verify、ci-suites-windows）在停机窗口里被准入门跳过：作业名是
// 未求值的条件表达式，按名字看这四项“未出现”。修复前第 10 段只看合并位，判 FRONT_GREEN_WAIT_MERGE（“已绿、等合入”），GitHub 却 BLOCKED，
// 一个永远等不来的等待。修复后：“已绿”＝线上规则要求的每一项在该 head 上都成功；缺项在跑是“等检查”，流程原因缺项是“缺检查”（陪伴补跑），
// 缺项有明确的最长等待（自合并位变绿起 60 分钟），补跑额度（每 head 每工作流共三次尝试）用完立即让出车头，列车继续（独审修复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { frontPullFacts, decideShadow } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';
import { trainPageLine, trainSummary, TRAIN_FRONT_RECHECK_DECISIONS } from '../src/train.mjs';

import { sha, iso, H, NOW, APP } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { ACTIONS_APP, ACTIONS, MIN, SKIPPED_NAME, LINUX_RUN, WINDOWS_RUN, front } from './train-front-fixture.mjs';

test('#1192: the merge slot is green but four required Actions checks never appeared: not "green, wait for merge"', async t => {
  const { e, yields, queue } = await front(t);
  const r = await e.run();
  assert.notEqual(r.facts.decision, 'FRONT_GREEN_WAIT_MERGE', 'a wait GitHub can never end is not green');
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING');
  assert.equal(r.facts.wouldDo, 'FRONT_CHECKS_MISSING');
  assert.deepEqual(r.facts.front.required.missing.map(m => [m.context, m.state]), ACTIONS.map(c => [c, 'absent']));
  assert.equal(yields(), 0, 'the merge slot went green 4 minutes ago: the companion still has time to re-run');
  assert.equal(queue[0].pr, 910);
  assert.equal(r.facts.openFrontBatch, null, 'never a second front batch for a head whose slot is green');
});

test('every required check green on the head: green, wait for merge', async t => {
  const { e, check, yields } = await front(t, { others: false });
  for (const c of ACTIONS) check(c, { at: NOW - 2 * MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_GREEN_WAIT_MERGE');
  assert.deepEqual(r.facts.front.required.missing, []);
  assert.equal(yields(), 0);
});

test('required checks queued or running: wait for checks while within the longest wait', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 30 * MIN });
  for (const c of ACTIONS) check(c, { status: 'in_progress', at: NOW - 20 * MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(yields(), 0);
});

test('a re-run whose gate is still running shows as a re-run in progress, without a yield inside the longest wait', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 30 * MIN });
  for (const run of [LINUX_RUN, WINDOWS_RUN]) check('admission-gate', { status: 'in_progress', at: NOW - 2 * MIN, run });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(r.facts.front.required.reruns, 1, 'one earlier attempt of each missing check, and its own run\'s gate in flight: the first re-run');
  assert.equal(yields(), 0);
});

// Fable 11-20 (A3): the train does not judge a failure. After a required check fails or stays missing it waits the observation window
// (10 minutes, over two polls of the companion's lane); a new attempt of the workflow inside it is a re-run in progress, none is a real
// failure and the front yields.
test('A3: no new attempt within the observation window after the admission: the front yields, the check was not re-run', async t => {
  const { e, yields, queue } = await front(t, { slotAt: NOW - 25 * MIN });
  const r = await e.run();
  assert.equal(yields(), 1);
  assert.equal(queue[0].pr, 911);
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING_YIELDED');
  assert.equal(r.facts.front.required.yieldReason, 'REQUIRED_CHECK_NOT_RERUN');
});

test('A3: a failed required Actions check is not judged by the train: no yield inside the window, a real failure after it', async t => {
  const inside = await front(t, { others: false });
  for (const c of ACTIONS) inside.check(c, { at: NOW - 2 * MIN, conclusion: c === 'ci-suites' ? 'failure' : 'success' });
  const r1 = await inside.e.run();
  assert.equal(inside.yields(), 0, 'the companion or the gate may still call it a process cause and re-run it');
  assert.equal(r1.facts.decision, 'FRONT_CHECKS_MISSING');
  const after = await front(t, { others: false, slotAt: NOW - 30 * MIN });
  for (const c of ACTIONS) after.check(c, { at: NOW - 11 * MIN, conclusion: c === 'ci-suites' ? 'failure' : 'success' });
  const r2 = await after.e.run();
  assert.equal(after.yields(), 1);
  assert.equal(r2.facts.decision, 'FRONT_RETURNED', 'no new attempt in 10 minutes: a real failure, the existing path');
});

test('A3: a new attempt inside the window is a re-run in progress, whatever time has passed since the failure', async t => {
  const { e, check, yields } = await front(t, { others: false, slotAt: NOW - 30 * MIN });
  for (const c of ACTIONS) check(c, { at: NOW - 25 * MIN, conclusion: c === 'ci-suites' ? 'failure' : 'success' });
  check('ci-suites', { status: 'in_progress', at: NOW - 20 * MIN });
  const r = await e.run();
  assert.equal(yields(), 0);
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(r.facts.front.required.reruns, 1);
});

// Independent review (Codex, 051b7d585) high 1: a provable exit. The longest wait is 60 minutes from the merge slot's green, whatever runs.
for (const [label, extra] of [
  ['a required check still running', c => c('ci-suites', { status: 'in_progress', at: NOW - MIN })],
  ['an unrelated or stale queued check', c => c('lint', { status: 'queued', at: NOW - 200 * MIN })],
  ['new activity of another job', c => c('other-job', { at: NOW - MIN })],
  ['a re-run gate in flight', c => c('admission-gate', { status: 'in_progress', at: NOW - MIN })],
]) test(`the longest wait holds against ${label}: the front yields 60 minutes after its merge slot went green`, async t => {
  const { e, check, yields, queue } = await front(t, { slotAt: NOW - 61 * MIN });
  extra(check);
  const r = await e.run();
  assert.equal(yields(), 1);
  assert.equal(queue[0].pr, 911);
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING_YIELDED');
  assert.equal(r.facts.front.required.yieldReason, 'REQUIRED_CHECKS_DEADLINE');
});

test('rules that cannot be read: never green, and the front still yields at the longest wait', async t => {
  const within = await front(t, { slotAt: NOW - 30 * MIN, rulesReply: reply => ({ ...reply, complete: false }) });
  assert.equal((await within.e.run()).facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(within.yields(), 0);
  const past = await front(t, { slotAt: NOW - 61 * MIN, rulesReply: reply => ({ ...reply, complete: false }) });
  const r = await past.e.run();
  assert.equal(past.yields(), 1);
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING_YIELDED');
});

test('no check timestamps at all: the wait counts from the front time of the holder', async t => {
  const fresh = await front(t, { slotAt: null, others: false, takenAt: iso(NOW - 5 * MIN) });
  assert.equal((await fresh.e.run()).facts.decision, 'FRONT_CHECKS_MISSING');
  assert.equal(fresh.yields(), 0);
  const old = await front(t, { slotAt: null, others: false, takenAt: iso(NOW - 61 * MIN) });
  const r = await old.e.run();
  assert.equal(old.yields(), 1);
  assert.equal(r.facts.front.required.yieldReason, 'REQUIRED_CHECKS_DEADLINE');
});

// High 2: the re-run budget is the head and the workflow's (three attempts: the first run and two re-runs, every run of it, a person's re-runs
// included), as GitHub shows it; used up, the front yields at once.
test('the re-run budget used up (three attempts of each missing check on GitHub): the front yields at once, with the reason', async t => {
  const { e, check, yields, queue } = await front(t, { slotAt: NOW - 4 * MIN });
  for (const c of ACTIONS) {
    check(`${c}-skipped`, { conclusion: 'skipped', at: NOW - 30 * MIN });
    check(SKIPPED_NAME(c), { conclusion: 'skipped', at: NOW - 5 * MIN });
  }
  const r = await e.run();
  assert.equal(yields(), 1);
  assert.equal(queue[0].pr, 911);
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING_YIELDED');
  assert.equal(r.facts.front.required.yieldReason, 'REQUIRED_RERUNS_EXHAUSTED');
  assert.deepEqual(r.facts.front.required.missing.map(m => m.attempts), [3, 3, 3, 3]);
});

test('one re-run made (two attempts on GitHub): still missing, the count reaches the summary and the PR page', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 4 * MIN });
  for (const c of ACTIONS) check(`${c}-skipped`, { conclusion: 'skipped', at: NOW - 5 * MIN });
  const r = await e.run();
  assert.equal(yields(), 0);
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING');
  assert.equal(r.facts.front.required.reruns, 1);
  const s = trainSummary(r.facts);
  assert.equal(s.front.reruns, 1);
  assert.match(trainPageLine(s, 910, ['ci-suites（已跳过）']), /第 1 次补跑后仍缺/);
});

test('a gate no missing check can be tied to (no earlier attempt names its run) is not counted as a re-run', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 4 * MIN, others: false });
  check('admission-gate', { status: 'in_progress', at: NOW - MIN, run: LINUX_RUN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING');
  assert.equal(r.facts.front.required.reruns, 0);
  assert.equal(yields(), 0, 'inside the window that began when the merge slot went green');
});

test('pure decision: rules that could not be read never make a slot-green head green', () => {
  const mainSha = sha(0x7001);
  const pull = { state: 'open', draft: false, base: { ref: 'main' }, head: { sha: H }, mergeable: true };
  const slot = { id: 7, app: { id: APP }, name: 'kooyumi-merge-slot', head_sha: H, status: 'completed', conclusion: 'success', completed_at: iso(NOW) };
  const f = frontPullFacts({ pull, mergeCommit: null, compare: null, checks: [slot], mainSha, appId: APP, rules: null });
  assert.equal(decideShadow({ onDuty: true, holders: [{ pr: 910 }], front: f, rules: { strict: true }, mainSha }), 'FRONT_CHECKS_WAIT');
});

// Review medium: green is success on every required check (the ruling); a rule this train cannot verify from check runs is never green.
test('pure decision: neutral is not success; an unpinned or malformed rule and the train-landed check in GitHub-merge mode are never green', () => {
  const mainSha = sha(0x7001);
  const pull = { state: 'open', draft: false, base: { ref: 'main' }, head: { sha: H }, mergeable: true };
  const run = (id, name, conclusion = 'success', app = APP) => ({ id, app: { id: app }, name, head_sha: H, status: 'completed', conclusion, completed_at: iso(NOW) });
  const rulesOf = extra => [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
    required_status_checks: [{ context: 'kooyumi-merge-slot', integration_id: APP }, ...extra] } }];
  const decide = (extra, checks) => decideShadow({ onDuty: true, holders: [{ pr: 910 }], rules: { strict: true }, mainSha,
    front: frontPullFacts({ pull, mergeCommit: null, compare: null, checks: [run(7, 'kooyumi-merge-slot'), ...checks], mainSha, appId: APP, rules: rulesOf(extra) }) });
  assert.equal(decide([{ context: 'ci-suites', integration_id: ACTIONS_APP }], [run(8, 'ci-suites', 'success', ACTIONS_APP)]), 'FRONT_GREEN_WAIT_MERGE');
  assert.equal(decide([{ context: 'ci-suites', integration_id: ACTIONS_APP }], [run(8, 'ci-suites', 'neutral', ACTIONS_APP)]), 'FRONT_CHECKS_MISSING');
  assert.equal(decide([{ context: 'legacy' }], [run(8, 'legacy', 'success', ACTIONS_APP)]), 'FRONT_CHECKS_MISSING', 'a commit status may stand behind an unpinned rule: unverifiable here');
  assert.equal(decide([{ context: 'odd', integration_id: '15368' }], [run(8, 'odd', 'success', ACTIONS_APP)]), 'FRONT_CHECKS_WAIT', 'a malformed rule is unreadable rules');
  assert.equal(decide([{ context: 'kooyumi-train-landed', integration_id: APP }], []), 'FRONT_CHECKS_MISSING', 'GitHub-merge mode needs it like any other');
});

test('PR page words: wait for checks, re-run in progress (count), and the yield with its reason', () => {
  const summary = (decision, front = {}) => ({ at: NOW, mode: 'on', decision, wouldDo: decision, front: { pr: 910, headSha: H, ...front } });
  assert.match(trainPageLine(summary('FRONT_CHECKS_WAIT'), 910, ['ci-suites（进行中）']), /等检查/);
  assert.match(trainPageLine(summary('FRONT_CHECKS_WAIT', { reruns: 2 }), 910, ['ci-suites（进行中）']), /^合并列车：你是车头。合并位已绿，补跑中（第 2 次）/);
  assert.match(trainPageLine(summary('FRONT_CHECKS_MISSING'), 910, ['ci-suites（未出现）']), /缺检查.*等自动补跑/);
  assert.match(trainPageLine(summary('FRONT_CHECKS_MISSING_YIELDED', { yieldReason: 'REQUIRED_RERUNS_EXHAUSTED' }), 910), /补跑两次仍缺/);
  assert.match(trainPageLine(summary('FRONT_CHECKS_MISSING_YIELDED', { yieldReason: 'REQUIRED_CHECKS_DEADLINE' }), 910), /到时限仍无结果/);
  for (const d of ['FRONT_CHECKS_WAIT', 'FRONT_CHECKS_MISSING', 'FRONT_CHECKS_MISSING_YIELDED'])
    assert.doesNotMatch(trainPageLine(summary(d, { reruns: 1 }), 910, ['ci-suites（未出现）']), /等合并|等合入/);
});

test('a yield for missing checks gets the quick front re-check, like any returned slot', () => {
  assert.ok(TRAIN_FRONT_RECHECK_DECISIONS.includes('FRONT_CHECKS_MISSING_YIELDED'));
});

// Second independent review (Codex, 58b9825fe), high 1: the observation window starts no earlier than the later of the claim becoming the
// front and its merge slot going green, so the companion has at least one full discovery round once the head is the front. #1192's own
// times (Beijing time): the first attempt's jobs ended 07:09:10, the newest admission 09:45:46, the merge slot 09:56:00.
const AT_1192 = { skippedAt: NOW - (2 * 60 + 46) * MIN - 50_000, admittedAt: NOW - 10 * MIN - 14_000, slotAt: NOW };
test('review 2 high 1 (#1192 times): the first round right after the merge slot went green leaves the companion its whole window', async t => {
  const first = await front(t, AT_1192);
  const r = await first.e.run();
  assert.equal(first.yields(), 0, 'the window from 09:45:46 would have ended at 09:55:46, before the merge slot went green');
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING');
  // still no re-run 10 minutes after the merge slot: the front yields
  const later = await front(t, { ...AT_1192, skippedAt: AT_1192.skippedAt - 10 * MIN - 1000, admittedAt: AT_1192.admittedAt - 10 * MIN - 1000, slotAt: NOW - 10 * MIN - 1000 });
  const r2 = await later.e.run();
  assert.equal(later.yields(), 1);
  assert.equal(r2.facts.front.required.yieldReason, 'REQUIRED_CHECK_NOT_RERUN');
});

// High 2: a new attempt counts only in the workflow run of the missing check (GitHub's details_url names it).
test('review 2 high 2: a gate of another workflow does not excuse the Linux failure', async t => {
  const { e, check, yields } = await front(t, { others: false, slotAt: NOW - 30 * MIN });
  for (const c of ACTIONS) check(c, { at: NOW - 20 * MIN, conclusion: c === 'ci-suites' ? 'failure' : 'success' });
  check('admission-gate', { status: 'in_progress', at: NOW - MIN, run: WINDOWS_RUN });
  const r = await e.run();
  assert.equal(yields(), 1);
  assert.equal(r.facts.decision, 'FRONT_RETURNED');
});

test('review 2 high 2: a gate that is queued and has not started is not a re-run', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 30 * MIN });
  for (const run of [LINUX_RUN, WINDOWS_RUN]) check('admission-gate', { status: 'queued', at: NOW - MIN, run });
  const r = await e.run();
  assert.equal(yields(), 1);
  assert.equal(r.facts.front.required.yieldReason, 'REQUIRED_CHECK_NOT_RERUN');
});

test('review 2 high 2: the same workflow\'s new gate succeeded and its jobs are not listed yet: still a re-run in progress', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 30 * MIN });
  for (const run of [LINUX_RUN, WINDOWS_RUN]) check('admission-gate', { at: NOW - 2 * MIN, run });
  const r = await e.run();
  assert.equal(yields(), 0);
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(r.facts.front.required.reruns, 1);
});

// Medium 1: a check inventory that cannot be read no longer ends the round before the yield; the front time bounds the wait.
for (const how of ['throws', 'incomplete']) test(`review 2 medium 1: the front's checks cannot be read (${how}): no batch, and the front yields at the longest wait`, async t => {
  const failing = async () => { if (how === 'throws') throw new Error('offline'); return { complete: false, checks: [] }; };
  const within = await front(t, { slotAt: NOW - 30 * MIN });
  const read = within.e.gh.readChecks;
  within.e.gh.readChecks = async head => (head === H ? failing() : read(head));
  const r1 = await within.e.run();
  assert.equal(r1.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(r1.facts.front.checksUnreadable, true);
  assert.equal(r1.facts.openFrontBatch, null);
  assert.equal(within.yields(), 0);
  const past = await front(t, { slotAt: NOW - 30 * MIN, takenAt: iso(NOW - 61 * MIN) });
  const read2 = past.e.gh.readChecks;
  past.e.gh.readChecks = async head => (head === H ? failing() : read2(head));
  const r2 = await past.e.run();
  assert.equal(past.yields(), 1);
  assert.equal(r2.facts.front.required.yieldReason, 'REQUIRED_CHECKS_DEADLINE');
});

// Medium 3: the yield for missing checks is made only while the PR's head is still the one whose checks were read.
test('review 2 medium 3: the head moved after the checks were read: the front is not yielded on the old evidence', async t => {
  const { e, yields } = await front(t, { slotAt: NOW - 25 * MIN });
  const read = e.gh.readPullRequest;
  let reads = 0;
  e.gh.readPullRequest = async n => { const p = await read(n); return n === 910 && ++reads > 1 ? { ...p, head: { ...p.head, sha: sha(0x7777) } } : p; };
  const r = await e.run();
  assert.equal(yields(), 0);
  assert.equal(r.facts.front.requiredYieldHeld, 'FRONT_HEAD_MOVED');
});
