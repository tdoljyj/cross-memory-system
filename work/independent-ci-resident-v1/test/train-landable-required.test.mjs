// 两个排队 PR 的第 10 段回归：非必需检查失败不能使车头互相让位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, jobOf, sha, iso, H, SOURCE, NOW, CLAIM, REPO } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { runTrain } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-maintenance.mjs';

async function queued(t, { required = 'ci-suites', unreadable = null } = {}) {
  const e = await setup(t, { strict: true, tick: 1,
    // A3 window floor (review 2 high 1): the claim has been the front for 20 minutes, so a failure 11 minutes old is past its window.
    native: { nodes: [{ node: { name: 'fixture', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(NOW) } }], holder: { takenAt: iso(NOW - 20 * 60_000) } } });
  const read = e.gh.readPullRequest;
  e.gh.readPullRequest = async n => ({ ...(await read(n)), auto_merge: { merge_method: 'merge' } });
  const rules = e.gh.readBranchRules;
  e.gh.readBranchRules = async () => {
    if (unreadable === 'throw') throw new Error('offline');
    const reply = await rules();
    if (unreadable === 'incomplete') return { ...reply, complete: false };
    if (unreadable === 'missing') return { ...reply, rules: [] };
    reply.rules[1].parameters.required_status_checks.push({ context: required, integration_id: 15368 });
    if (unreadable === 'unsupported') reply.rules[1].parameters.required_status_checks.push({ context: 'legacy', integration_id: null });
    if (unreadable === 'malformed') reply.rules[1].parameters.required_status_checks.push({ context: 'invalid', integration_id: '15368' });
    return reply;
  };
  const otherHead = sha(0x9999);
  e.gh.pull(911, { head: otherHead });
  // Native 的离线队列确有另一个认领在等待；若调用 yieldSlot，就交换车头。
  const queue = [{ pr: 910, headSha: H, claimId: CLAIM }, { pr: 911, headSha: otherHead, claimId: '99999999-8888-4777-8666-555555555555' }];
  e.native.port.yieldSlot = async input => {
    e.native.calls.push(['yield', input]);
    assert.deepEqual(input, { pr: queue[0].pr, headSha: queue[0].headSha });
    queue.push(queue.shift());
    e.native.holder = { ...e.native.holder, ...queue[0], boundPr: `${REPO}#${queue[0].pr}` };
    return { onDuty: true, yielded: true };
  };
  const check = (id, head, name, conclusion, app = 15368, status = 'completed') =>
    // A3 (Fable 11-20): a failed Actions check is a real failure once the observation window has passed with no new attempt.
    e.gh.world.checks.set(id, { id, app: { id: app }, name, head_sha: head, status, conclusion, completed_at: status === 'completed' ? iso(NOW - 11 * 60_000) : null });
  check(501, H, 'ci-suites-windows', 'failure');
  check(502, otherHead, 'ci-suites-windows', 'failure');
  return { e, queue, check };
}

test('two queued PRs with only optional failures keep the front and open its batch', async t => {
  const { e, queue } = await queued(t);
  const r = await e.run();
  assert.deepEqual(e.native.calls.filter(c => c[0] === 'yield'), [], 'optional failure must not rotate the queue');
  assert.equal(queue[0].pr, 910);
  assert.equal(r.facts.actions.returned, false);
  assert.equal(r.facts.decision, 'OPEN_FRONT_BATCH');
  assert.equal(r.facts.openFrontBatch?.pr, 910);
  assert.equal(e.gh.world.calls.filter(c => c === 'rules').length, 1, 'reuse this run\'s main rules');
});

for (const mode of ['required-failed', 'optional-now-required', 'rerun-success', 'rerun-pending', 'wrong-app', 'native-required-failed'])
  test(`queue landability follows required checks: ${mode}`, async t => {
    const { e, queue, check } = await queued(t, { required: mode === 'optional-now-required' ? 'ci-suites-windows' : 'ci-suites' });
    if (mode !== 'optional-now-required') check(503, H, mode === 'native-required-failed' ? 'gitleaks' : 'ci-suites', 'failure',
      mode === 'wrong-app' ? 999 : mode === 'native-required-failed' ? 5368905 : 15368);
    if (mode.startsWith('rerun-')) check(504, H, 'ci-suites', mode === 'rerun-success' ? 'success' : null,
      15368, mode === 'rerun-success' ? 'completed' : 'in_progress');
    const r = await e.run();
    const failed = ['required-failed', 'optional-now-required', 'native-required-failed'].includes(mode);
    assert.equal(e.native.calls.filter(c => c[0] === 'yield').length, failed ? 1 : 0);
    assert.equal(queue[0].pr, failed ? 911 : 910);
    assert.equal(r.facts.decision, failed ? 'FRONT_RETURNED' : 'OPEN_FRONT_BATCH');
    assert.equal(r.facts.openFrontBatch?.pr ?? null, failed ? null : 910);
  });

for (const unreadable of ['throw', 'incomplete', 'missing', 'unsupported', 'malformed'])
  test(`unreadable required list retains the old conservative failure check and records why: ${unreadable}`, async t => {
    const { e } = await queued(t, { unreadable });
    const r = await e.run();
    assert.equal(e.native.calls.filter(c => c[0] === 'yield').length, 1);
    assert.equal(r.facts.actions.returned, true);
    assert.equal(r.facts.openFrontBatch, null);
    assert.equal(r.facts.rulesReason, unreadable === 'unsupported' ? 'REQUIRED_CHECKS_UNREADABLE' : 'RULESET_UNREADABLE');
  });

for (const failed of [false, true]) test(`multi-PR holder selection uses the same required list: required failed=${failed}`, async t => {
  const { e, check } = await queued(t);
  const scope = 'project:00000000-0000-4000-8000-000000000000';
  e.native.holder = { ...e.native.holder, pr: null, boundPr: null, prs: [910, 911],
    boundPrs: [`${REPO}#910`, `${REPO}#911`], ciState: 'green', ciHeadSha: H };
  e.native.bindings = new Map([910, 911].map(n => [n, { claimId: CLAIM, taskId: CLAIM, scope }]));
  const read = e.gh.readPullRequest;
  e.gh.readPullRequest = async n => { const p = await read(n); return { ...p, head: { ...p.head, repo: { full_name: REPO } } }; };
  if (failed) check(503, H, 'ci-suites', 'failure');
  const r = await runTrain({ job: jobOf(), github: e.gh, native: e.native.port, ledger: e.ledger, sweepStore: e.store,
    publications: e.publications, clock: e.clock, sleep: e.sleep, claimScope: scope });
  assert.equal(r.facts.front.pr, failed ? 911 : 910);
  assert.equal(e.gh.world.calls.filter(c => c === 'rules').length, 1);
});
