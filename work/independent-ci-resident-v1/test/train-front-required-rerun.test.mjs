// Fable 11-20“补：车头缺必需检查”（Clued Task 6ed681d6，合修 9aba97c1）。#1192 的替身现场：车头 head 上常驻的六项都已绿（含合并位），
// 线上规则另要求的 Actions 四项（ci-suites、clued-cloud-tests、migration-verify、ci-suites-windows）在停机窗口里被准入门跳过：作业名是
// 未求值的条件表达式，按名字看这四项“未出现”。修复前第 10 段只看合并位，判 FRONT_GREEN_WAIT_MERGE（“已绿、等合入”），GitHub 却 BLOCKED，
// 一个永远等不来的等待。修复后：“已绿”＝线上规则要求的每一项在该 head 上都成功；缺项在跑是“等检查”，流程原因缺项是“缺检查”（陪伴补跑），
// 时限内没有任何新动静就让出车头，列车继续。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, sha, iso, H, NOW, CLAIM, REPO, APP, SOURCE } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { frontPullFacts, decideShadow } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';
import { trainPageLine } from '../src/train.mjs';

const ACTIONS_APP = 15368;
const ACTIONS = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
const NATIVE = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const MIN = 60_000;
// The four job names GitHub gave the skipped jobs of #1192 (the unevaluated `name:` expression), shortened.
const SKIPPED_NAME = c => `needs.admission-gate.outputs.admitted == 'true' && (...) && '${c}' || '${c}-skipped'`;

async function front(t, { extraRequired = [], slotAt = NOW - 4 * MIN, others = true } = {}) {
  const e = await setup(t, { strict: true, tick: 1,
    native: { nodes: [{ node: { name: 'fixture', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(NOW) } }] } });
  const read = e.gh.readPullRequest;
  e.gh.readPullRequest = async n => ({ ...(await read(n)), auto_merge: { merge_method: 'merge' } });
  const rules = e.gh.readBranchRules;
  e.gh.readBranchRules = async () => {
    const reply = await rules();
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
      started_at: iso(at), completed_at: status === 'completed' ? iso(at) : null };
    if (name === 'kooyumi-merge-slot') c.output = { title: 'Complete Native control', summary: `front PR #910, head ${H}, main@${e.gh.world.main}` };
    e.gh.world.checks.set(c.id, c);
    return c;
  };
  // the six native checks of App 5368905, the merge slot last
  for (const name of NATIVE) check(name, { app: APP, at: name === 'kooyumi-merge-slot' ? slotAt : slotAt - 10 * MIN });
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

test('a required check queued or running (the re-run picked up): wait for checks, never yield, whatever the age', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 120 * MIN });
  check('ci-suites', { status: 'in_progress', at: NOW - 90 * MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(yields(), 0);
});

test('a re-run whose gate is still waiting counts as activity: no yield while it runs', async t => {
  const { e, check, yields } = await front(t, { slotAt: NOW - 120 * MIN });
  check('admission-gate', { status: 'queued', at: NOW - 30 * MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(yields(), 0);
});

test('missing after the re-runs (or with no re-run channel): no new check for the grace time, the front yields with a clear reason', async t => {
  const { e, yields, queue } = await front(t, { slotAt: NOW - 25 * MIN });
  const r = await e.run();
  assert.equal(yields(), 1, 'the front gives the slot to the next claim');
  assert.equal(queue[0].pr, 911, 'the next head is the front');
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING_YIELDED');
  assert.equal(r.facts.actions.returned, true);
});

test('a required check that ran and failed: no re-run wait, the front yields as a failure (the existing path)', async t => {
  const { e, check, yields } = await front(t, { others: false });
  for (const c of ACTIONS) check(c, { at: NOW - 2 * MIN, conclusion: c === 'ci-suites' ? 'failure' : 'success' });
  const r = await e.run();
  assert.equal(yields(), 1);
  assert.equal(r.facts.decision, 'FRONT_RETURNED');
});

test('a check newly required by the live rules is part of green without any change to the train', async t => {
  const { e, check } = await front(t, { others: false, extraRequired: ['brand-new-check'] });
  for (const c of ACTIONS) check(c, { at: NOW - 2 * MIN });
  const r = await e.run();
  assert.equal(r.facts.decision, 'FRONT_CHECKS_MISSING');
  assert.deepEqual(r.facts.front.required.missing.map(m => m.context), ['brand-new-check']);
});

test('pure decision: rules that could not be read never make a slot-green head green', () => {
  const mainSha = sha(0x7001);
  const pull = { state: 'open', draft: false, base: { ref: 'main' }, head: { sha: H }, mergeable: true };
  const slot = { id: 7, app: { id: APP }, name: 'kooyumi-merge-slot', head_sha: H, status: 'completed', conclusion: 'success', completed_at: iso(NOW) };
  const f = frontPullFacts({ pull, mergeCommit: null, compare: null, checks: [slot], mainSha, appId: APP, rules: null });
  assert.equal(decideShadow({ onDuty: true, holders: [{ pr: 910 }], front: f, rules: { strict: true }, mainSha }), 'FRONT_CHECKS_WAIT');
});

test('PR page words: wait for checks, re-run in progress (count), and the yield', () => {
  const at = NOW;
  const summary = decision => ({ at, mode: 'on', decision, wouldDo: decision, front: { pr: 910, headSha: H } });
  assert.match(trainPageLine(summary('FRONT_CHECKS_WAIT'), 910, ['ci-suites（进行中）']), /等检查/);
  assert.match(trainPageLine(summary('FRONT_CHECKS_MISSING'), 910, ['ci-suites（未出现）'], 1), /补跑中（第 1 次）/);
  assert.match(trainPageLine(summary('FRONT_CHECKS_MISSING'), 910, ['ci-suites（未出现）'], 0), /缺检查/);
  assert.match(trainPageLine(summary('FRONT_CHECKS_MISSING_YIELDED'), 910), /必需检查缺失，重跑无效/);
  for (const d of ['FRONT_CHECKS_WAIT', 'FRONT_CHECKS_MISSING', 'FRONT_CHECKS_MISSING_YIELDED'])
    assert.doesNotMatch(trainPageLine(summary(d), 910, ['ci-suites（未出现）'], 1), /等合并|等合入/);
});
