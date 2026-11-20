// Fable 11-20“补：车头缺必需检查”（Clued Task 6ed681d6，合修 9aba97c1）。#1192 的替身现场：车头 head 上常驻的六项都已绿（含合并位），
// 线上规则另要求的 Actions 四项（ci-suites、clued-cloud-tests、migration-verify、ci-suites-windows）在停机窗口里被准入门跳过：作业名是
// 未求值的条件表达式，按名字看这四项“未出现”。修复前第 10 段只看合并位，判 FRONT_GREEN_WAIT_MERGE（“已绿、等合入”），GitHub 却 BLOCKED，
// 一个永远等不来的等待。修复后：“已绿”＝线上规则要求的每一项在该 head 上都成功；缺项在跑是“等检查”，流程原因缺项是“缺检查”（陪伴补跑），
// 缺项有明确的最长等待（自合并位变绿起 60 分钟），补跑额度（每 head 每工作流共三次尝试）用完立即让出车头，列车继续（独审修复）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, sha, iso, H, NOW, CLAIM, REPO, APP, SOURCE } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { frontPullFacts, decideShadow } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';
import { trainPageLine, trainSummary, TRAIN_FRONT_RECHECK_DECISIONS } from '../src/train.mjs';

const ACTIONS_APP = 15368;
const ACTIONS = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
const NATIVE = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const MIN = 60_000;
// The four job names GitHub gave the skipped jobs of #1192 (the unevaluated `name:` expression), shortened.
const SKIPPED_NAME = c => `needs.admission-gate.outputs.admitted == 'true' && (...) && '${c}' || '${c}-skipped'`;

async function front(t, { extraRequired = [], slotAt = NOW - 4 * MIN, others = true, takenAt = undefined, rulesReply = null } = {}) {
  const e = await setup(t, { strict: true, tick: 1,
    native: { nodes: [{ node: { name: 'fixture', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(NOW) } }], ...(takenAt !== undefined ? { holder: { takenAt } } : {}) } });
  const read = e.gh.readPullRequest;
  e.gh.readPullRequest = async n => ({ ...(await read(n)), auto_merge: { merge_method: 'merge' } });
  const rules = e.gh.readBranchRules;
  e.gh.readBranchRules = async () => {
    const reply = await rules();
    if (rulesReply) return rulesReply(reply);
    for (const context of [...ACTIONS, ...extraRequired]) reply.rules[1].parameters.required_status_checks.push({ context, integration_id: ACTIONS_APP });
    return reply;
  };
  const otherHead = sha(0x9999);
  e.gh.pull(911, { head: otherHead });
  const queue = [{ pr: 910, headSha: H, claimId: CLAIM }, { pr: 911, headSha: otherHead, claimId: '99999999-8888-4777-8666-555555555555' }];
  e.native.port.yieldSlot = async input => {
    e.native.calls.push(['yield', input]);
    queue.push(queue.shift());
    e.native.holder = { ...e.native.holder, ...queue[0], boundPr: `${REPO}#${queue[0].pr}` };
    return { onDuty: true, yielded: true };
  };
  let id = 600;
  const check = (name, { app = ACTIONS_APP, status = 'completed', conclusion = 'success', at = NOW - 30 * MIN, head = H } = {}) => {
    const c = { id: ++id, app: { id: app }, name, head_sha: head, status, conclusion: status === 'completed' ? conclusion : null,
      started_at: at === null ? null : iso(at), completed_at: status === 'completed' && at !== null ? iso(at) : null };
    if (name === 'kooyumi-merge-slot') c.output = { title: 'Complete Native control', summary: `front PR #910, head ${H}, main@${e.gh.world.main}` };
    e.gh.world.checks.set(c.id, c);
    return c;
  };
  // the six native checks of App 5368905, the merge slot last
  for (const name of NATIVE) check(name, { app: APP, at: slotAt === null ? null : name === 'kooyumi-merge-slot' ? slotAt : slotAt - 10 * MIN });
  // the gate of both workflows ran and admitted nothing: its own check run succeeded, the heavy jobs are skipped under their expression names
  if (others) {
    check('admission-gate', { at: NOW - 60 * MIN });
    check('admission-gate', { at: NOW - 60 * MIN });
    for (const c of ACTIONS) check(SKIPPED_NAME(c), { conclusion: 'skipped', at: NOW - 60 * MIN });
  }
  const yields = () => e.native.calls.filter(c => c[0] === 'yield').length;
  return { e, queue, check, yields };
}

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

test('a required check queued or running: wait for checks while within the longest wait', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 30 * MIN });
  check('ci-suites', { status: 'in_progress', at: NOW - 20 * MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(yields(), 0);
});

test('a re-run whose gate is still running shows as a re-run in progress, without a yield inside the longest wait', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 30 * MIN });
  check('admission-gate', { status: 'queued', at: NOW - 2 * MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(r.facts.front.required.reruns, 1, 'one earlier attempt of each missing check, and a gate in flight: the first re-run');
  assert.equal(yields(), 0);
});

test('nothing moving 25 minutes after the merge slot went green: still missing, no yield before the longest wait', async t => {
  const { e, yields } = await front(t, { slotAt: NOW - 25 * MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING');
  assert.equal(yields(), 0);
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

test('the first gate of a head in flight with no earlier attempt is a wait for checks, not a re-run', async t => {
  const { e, check } = await front(t, { slotAt: NOW - 4 * MIN, others: false });
  check('admission-gate', { status: 'in_progress', at: NOW - MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(r.facts.front.required.reruns, 0);
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
