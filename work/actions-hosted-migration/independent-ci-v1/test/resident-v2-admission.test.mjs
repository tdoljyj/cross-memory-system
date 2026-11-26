import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';
import { createFullAdmissionPortV2, admittedFactsMatchJobV2, fullAdmissionFailureV2, FULL_ADMISSION_CONTRACT_V2 } from '../src/full-admission-v2.mjs';
import { isCurrentMergeQueueHeadV2 } from '../src/independent-control-checks-v2/queue-facts.mjs';
import { HEAD, BASE } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const SCOPE = `project:${randomUUID()}`;
const iso = ms => new Date(ms).toISOString();

test('terminal admission removed: a Native reply naming one yields facts without it, and facts carrying one are refused', async () => {
  const receipt = randomUUID(), authorization = randomUUID();
  const reference = { receipt_id: receipt, claim_id: null, fence: 3, execution_epoch: 1, lease_version: 5, head_authorization_id: authorization };
  const p = world({ claimOverrides: { lease_version: 5 }, nativeOverrides: {
    terminal_admission_receipt_id: receipt, terminal_admission: reference, head_authorization_id: authorization } });
  const facts = await p.port.evaluatePr(p.job, p.packet);
  assert.equal(Object.hasOwn(facts, 'terminalAdmission'), false);
  assert.equal(admittedFactsMatchJobV2(facts, p.job, Date.now()), true);
  const { observationSha256, ...body } = facts, carried = { ...body, terminalAdmission: { ...reference, claim_id: facts.claimId } };
  assert.equal(admittedFactsMatchJobV2({ ...carried, observationSha256: digest(carried) }, p.job, Date.now()), false);
});

// testSha: the tested commit S (a train front batch when S != H); prBase: the base.sha GitHub and Native report.
function world({ trailer, claimId = randomUUID(), fence = 3, epoch = 1, nativeOverrides = {}, claimOverrides = {}, bindingOverrides = {}, commitTrailer = null, outcomeOverrides = {}, testSha = HEAD, prBase = BASE, prBaseAfter = prBase, monotonic } = {}) {
  const job = makeJobV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1, role: 'control-merge-slot' });
  const prRef = `${REPO}#888`;
  const body = trailer === undefined ? `Fix\n\nClued-Work-Claim: ${claimId}\nClued-Work-Scope: ${SCOPE}\n` : trailer;
  const pr = { number: 888, state: 'open', body, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: prBase, ref: 'main', repo: { full_name: REPO } } };
  let prReads = 0;
  const state = { claimId, taskId: randomUUID(), fence, epoch, expiresAt: iso(Date.now() + 3600_000) };
  const binding = () => ({ status: 'ok', binding_status: 'bound', reason: null, repository: REPO, pr_number: 888,
    pr_ref: prRef, head_sha: HEAD, base_sha: prBase, target_branch: 'main', scope: SCOPE, task_id: state.taskId,
    claim: { claim_id: state.claimId, task_id: state.taskId, context_key: SCOPE, fence: state.fence, execution_epoch: state.epoch,
      lease_version: 1, expires_at: state.expiresAt, status: 'ACTIVE', execution_handover_pending: false },
    head_authorization_id: null, auto_bound: false, receipt_id: null, ...bindingOverrides });
  const native = () => ({ status: 'ok', verdict: 'ADMITTED', execution_authorized: true, execution_policy: 'staged', current_fence: state.fence, execution_epoch: state.epoch,
    bound_pr: prRef, pr_ref: prRef, head_sha: HEAD, base_sha: prBase, verified_at: iso(Date.now()), paths_outside_write_set: [],
    claim: { claim_id: state.claimId, task_id: state.taskId, fence: state.fence, execution_epoch: state.epoch, context_key: SCOPE, status: 'ACTIVE', bound_pr: prRef, expires_at: state.expiresAt,
      lease_key_required: false, execution_handover_pending: false, merge_slot_until: iso(Date.now() + 600_000),
      merge_queue: [{ ref: `merge:${REPO}:main`, state: 'head', position: 1, ahead: [], head: { claim_id: state.claimId, bound_pr: prRef, since: iso(Date.now() - 1000), until: iso(Date.now() + 600_000) } }],
      ...claimOverrides }, ...nativeOverrides });
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/pulls/888')) { const p = structuredClone(pr); if (++prReads > 1) p.base.sha = prBaseAfter; return { ok: true, status: 200, json: async () => p }; }
    if (u.pathname.endsWith(`/commits/${HEAD}`)) return { ok: true, status: 200, json: async () => ({ commit: { message: commitTrailer ?? 'no trailer' } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const policyText = '{"policy":"fixture"}';
  const config = { domain: 'fixture', repository: REPO, scope: SCOPE, workspace: os.tmpdir(), sourceManifestSha256: 'd'.repeat(64), evaluatorSha256: digest('EVALUATOR'),
    policyText, policySha256: digest(policyText), ciPrincipalBindingId: randomUUID(), ciPrincipalQualificationRef: 'qualification-ref', publishableKey: 'sb_publishable_fixture',
    supabaseUrl: 'https://fixture.supabase.co' };
  const hooks = { evaluatorReader: () => 'EVALUATOR',
    evaluateImpl: async ({ observation_recorder }) => {
      const n = native();
      observation_recorder.record('claim_verification', { result: { payload: n } });
      return { admitted: true, verdict: 'ADMITTED', head_sha: HEAD, base_sha: prBase, pr_ref: prRef, claim_id: n.claim.claim_id,
        task_id: state.taskId, claim_binding: binding(), scope: SCOPE, changed_paths: ['a.txt'],
        admission_mode: { state: 'normal', layer: 'code', policy_version: 1 }, merge_slot: { state: 'held', ref: `merge:${REPO}:main`, tip: BASE, until: iso(Date.now() + 600_000) },
        owner_review: null, workflow_gate_findings: [], ...outcomeOverrides };
    } };
  const port = createFullAdmissionPortV2({ protectedConfig: config,
    tokenProvider: async () => ({ githubToken: 'gh-fixture', ciAdmissionToken: ['clued', 'bnd', 'fixture123'].join('_'), ciPrincipalBindingId: config.ciPrincipalBindingId, ciPrincipalQualificationRef: config.ciPrincipalQualificationRef }),
    modeProvider: async () => ({ complete: true, repository: REPO, variable: 'CLUED_MERGE_ADMISSION_STATE', source: 'github-repository-variables', exists: false, observedAt: iso(Date.now()), proofRef: 'mode-proof' }),
    recorderProvider: async () => ({ kind: 'independent-controller', domain: 'fixture', observedAt: iso(Date.now()), observationRef: 'obs', recorder: { newId: randomUUID, record() {} } }),
    fetchImpl, fixtureHooks: hooks, ...(monotonic ? { monotonic } : {}) });
  const packet = { complete: true, pr: 888, headSha: HEAD, baseSha: BASE, paths: ['a.txt'] };
  return { job, port, packet, state, claimId };
}

test('full admission v2: the claim comes live from the Native PR Task binding, not from the job', async () => {
  const w = world();
  const facts = await w.port.evaluatePr(w.job, w.packet);
  assert.equal(facts.contract, FULL_ADMISSION_CONTRACT_V2);
  assert.equal(facts.status, 'ADMITTED');
  assert.deepEqual(facts.observedClaim, { claimId: w.claimId, fence: 3, epoch: 1, expiresAt: w.state.expiresAt });
  assert.equal(facts.mergeQueueHead, true);
  assert.equal(facts.jobId, w.job.id);
  assert.ok(admittedFactsMatchJobV2(facts, w.job, Date.now()));
  assert.ok(admittedFactsMatchJobV2(facts, w.job, Date.now(), { batchClaim: { claimId: w.claimId, fence: 3, epoch: 1 } }));
  assert.equal(admittedFactsMatchJobV2(facts, w.job, Date.now(), { batchClaim: { claimId: w.claimId, fence: 4, epoch: 1 } }), false);
  assert.equal(admittedFactsMatchJobV2({ ...facts, fence: 9 }, w.job, Date.now()), false);
});

test('full admission v2: real issuer facts retain the server answer for subsequent local consumers without crossing clocks', async () => {
  for (const offset of [-3600_000, -180, 180, 3600_000]) {
    let mono = 0;
    const serverAt = Date.now() + offset, expiresAt = iso(serverAt + 60_000);
    const w = world({ monotonic: () => mono, nativeOverrides: { verified_at: iso(serverAt) }, claimOverrides: { expires_at: expiresAt } });
    const facts = await w.port.evaluatePr(w.job, w.packet);
    assert.equal(facts.status, 'ADMITTED', JSON.stringify({ offset, facts }));
    assert.equal(facts.claimExpiresAt, expiresAt, 'original server stamps remain unchanged for audit');
    assert.equal(admittedFactsMatchJobV2(facts, w.job, Date.now()), true, `issuer facts at offset ${offset}`);
    if (offset < -60_000) assert.equal(admittedFactsMatchJobV2(structuredClone(facts), w.job, Date.now()), false,
      'serialized fields do not recreate the issuer-held proof');
    mono = 30_000; assert.equal(admittedFactsMatchJobV2(facts, w.job, Date.now()), true);
    mono++; assert.equal(admittedFactsMatchJobV2(facts, w.job, Date.now()), false, 'later validation cannot refresh the deadline');
  }
});

test('full admission v2: batch stickiness allows a renewal, refuses another generation or claim', async () => {
  const w = world();
  const batchClaim = { claimId: w.claimId, fence: 3, epoch: 1 };
  w.state.expiresAt = iso(Date.now() + 7200_000); // renewed lease
  assert.equal((await w.port.evaluatePr(w.job, w.packet, { batchClaim })).status, 'ADMITTED');
  w.state.fence = 4; // takeover / re-claim of the same id bumps fence
  assert.equal((await w.port.evaluatePr(w.job, w.packet, { batchClaim })).reason, 'full_admission_claim_changed');
  const other = world();
  assert.equal((await other.port.evaluatePr(other.job, other.packet, { batchClaim })).reason, 'full_admission_claim_changed');
  assert.equal((await w.port.evaluatePr(w.job, w.packet, { batchClaim: { claimId: 'not-a-uuid', fence: 1, epoch: 1 } })).reason, 'full_admission_subject_invalid');
});

test('full admission v2: missing and contradictory trailers are advisory, a handed-over claim runs while staged, an unauthorized guarded one and inconsistent Native refuse', async () => {
  assert.equal((await (w => w.port.evaluatePr(w.job, w.packet))(world({ trailer: 'no trailer here' }))).status, 'ADMITTED');
  const id = randomUUID();
  const viaCommit = world({ trailer: `Clued-Work-Claim: ${randomUUID()}\nClued-Work-Scope: global`, claimId: id,
    commitTrailer: `x\n\nClued-Work-Claim: ${randomUUID()}\nClued-Work-Scope: global` });
  assert.equal((await viaCommit.port.evaluatePr(viaCommit.job, viaCommit.packet)).status, 'ADMITTED');
  // Field 2026-11-13 (PR #1086): a claim handed over on the BeamingFace page keeps lease_key_required, and Native's execution policy is
  // still 'staged' (not activated): Native admits it without any key or head authorization, so the resident runs it like any staged
  // claim (guarded false: no execution guard is in force). It refused it as NATIVE_POLICY_UNSUPPORTED and burned the head.
  const guarded = world({ claimOverrides: { lease_key_required: true } });
  const staged = await guarded.port.evaluatePr(guarded.job, guarded.packet);
  assert.equal(staged.status, 'ADMITTED', JSON.stringify(staged));
  assert.equal(staged.guarded, false);
  assert.equal(admittedFactsMatchJobV2(staged, guarded.job, Date.now()), true);
  // Once activated, the guard is in force: without the holder's head authorization Native's answer is not one the resident runs on.
  const unauthorized = world({ claimOverrides: { lease_key_required: true }, nativeOverrides: { execution_policy: 'active', head_authorization_id: null } });
  assert.equal((await unauthorized.port.evaluatePr(unauthorized.job, unauthorized.packet)).reason, 'full_admission_native_unsupported');
  const torn = world({ nativeOverrides: { current_fence: 99 } });
  assert.equal((await torn.port.evaluatePr(torn.job, torn.packet)).reason, 'full_admission_native_changed');
  const blocked = await torn.port.evaluatePr(torn.job, torn.packet);
  assert.equal(fullAdmissionFailureV2(blocked).reason, 'full_admission_native_changed');
  // a v1 job is refused outright
  assert.equal((await torn.port.evaluatePr({ ...torn.job, contract: 'clued.independent-ci.job/1' }, torn.packet)).reason, 'full_admission_unavailable');
});

test('full admission v2: Native projection never falls back to advisory trailers', async () => {
  for (const binding_status of ['unbound', 'no_live_claim', 'handover_pending', 'head_not_authorized']) {
    const w = world({ outcomeOverrides: { admitted: false, verdict: 'REJECTED', reasons: [`pr_task_binding_${binding_status}`],
      claim_binding: { status: 'ok', binding_status } } });
    const answer = await w.port.evaluatePr(w.job, w.packet);
    assert.equal(answer.reason, 'full_admission_rejected', binding_status);
    assert.equal(answer.admitted, false);
    assert.deepEqual(answer.diagnostic.reasonCodes, [`pr_task_binding_${binding_status}`]);
  }
  const w = world({ bindingOverrides: { pr_number: 889 } });
  assert.equal((await w.port.evaluatePr(w.job, w.packet)).admitted, false);
});

test('full admission v2: Native ci_binding_required is reported as an admission role refusal', async () => {
  const reasons = ['ci_binding_required'];
  const w = world({ nativeOverrides: { verdict: 'REJECTED', execution_authorized: false, reasons },
    outcomeOverrides: { admitted: false, verdict: 'REJECTED', reasons } });
  const blocked = await w.port.evaluatePr(w.job, w.packet);
  const failure = fullAdmissionFailureV2(blocked);
  assert.equal(failure.reason, 'full_admission_rejected');
  const { reasonCodes, nativeReasonCodes } = failure.admissionDiagnostic;
  assert.deepEqual({ reasonCodes, nativeReasonCodes }, {
    reasonCodes: ['admission_binding_required'], nativeReasonCodes: ['admission_binding_required'],
  });
});

test('full admission v2: an old single bound_pr field cannot override the exact Native PR Task projection', async () => {
  const w = world({ nativeOverrides: { bound_pr: `${REPO}#777` }, claimOverrides: { bound_pr: `${REPO}#777` } });
  assert.equal((await w.port.evaluatePr(w.job, w.packet)).status, 'ADMITTED');
  const wrongTask = world({ claimOverrides: { task_id: randomUUID() } });
  assert.equal((await wrongTask.port.evaluatePr(wrongTask.job, wrongTask.packet)).reason, 'full_admission_native_changed');
});

test('queue facts v2: head only for the observed claim generation', () => {
  const job = makeJobV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now()), attempt: 1, role: 'control-merge-slot' });
  const now = Date.now(), id = randomUUID();
  const claim = { claim_id: id, fence: 2, execution_epoch: 1, execution_handover_pending: false, lease_key_required: false, merge_slot_until: iso(now + 1000),
    merge_queue: [{ ref: `merge:${REPO}:main`, state: 'head', position: 1, ahead: [], head: { claim_id: id, bound_pr: `${REPO}#888`, since: iso(now - 1), until: iso(now + 1000) } }] };
  assert.equal(isCurrentMergeQueueHeadV2(claim, { claimId: id, fence: 2, epoch: 1 }, job, now), true);
  assert.equal(isCurrentMergeQueueHeadV2(claim, { claimId: id, fence: 3, epoch: 1 }, job, now), false);
  assert.equal(isCurrentMergeQueueHeadV2({ ...claim, merge_queue: [{ ...claim.merge_queue[0], position: 2 }] }, { claimId: id, fence: 2, epoch: 1 }, job, now), false);
});

test('queue facts v2: complete canonical PR membership coexists with legacy single-PR heads', () => {
  const job = makeJobV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now()), attempt: 1, role: 'control-merge-slot' });
  const now = Date.now(), id = randomUUID(), observed = { claimId: id, fence: 2, epoch: 1 }, target = `${REPO}#888`;
  const head = { claim_id: id, since: iso(now - 1), until: iso(now + 1000), bound_pr: null, bound_prs: [`${REPO}#887`, target] };
  const claim = { claim_id: id, fence: 2, execution_epoch: 1, execution_handover_pending: false, lease_key_required: false, merge_slot_until: iso(now + 1000),
    merge_queue: [{ ref: `merge:${REPO}:main`, state: 'head', position: 1, ahead: [], head }] };
  const run = patch => isCurrentMergeQueueHeadV2({ ...claim, merge_queue: [{ ...claim.merge_queue[0], head: { ...head, ...patch } }] }, observed, job, now);
  assert.equal(run({}), true, 'the higher-numbered member is a real head of the same Task slot');
  assert.equal(run({ bound_prs: [target], bound_pr: target }), true);
  assert.equal(run({ bound_prs: ['other/repository#1', target] }), true, 'a Task can have canonical targets in another repository too');
  const legacy = { ...head, bound_pr: target }; delete legacy.bound_prs;
  assert.equal(isCurrentMergeQueueHeadV2({ ...claim, merge_queue: [{ ...claim.merge_queue[0], head: legacy }] }, observed, job, now), true);
  for (const patch of [
    { bound_prs: undefined }, { bound_prs: null }, { bound_prs: {} }, { bound_prs: [] },
    { bound_prs: [target, target] }, { bound_prs: Array.from({ length: 51 }, (_, i) => `${REPO}#${i + 1}`) },
    ...[null, 888, `${REPO}#0`, `${REPO}#0888`, `${REPO}#888 `, `${REPO}#888\n`, `${REPO}#10000000000`, 'not-a-pr']
      .map(ref => ({ bound_prs: [target, ref] })),
    { bound_prs: ['other/repository#888', `${REPO}#887`] },
    { bound_pr: target }, { bound_pr: `${REPO}#887` }, { bound_pr: undefined },
    { bound_prs: [target], bound_pr: null }, { bound_prs: [target], bound_pr: `${REPO}#887` },
  ]) assert.equal(run(patch), false, JSON.stringify(patch));
  for (const patch of [
    { fence: 3 }, { execution_epoch: 2 }, { execution_handover_pending: true }, { lease_key_required: null },
    { merge_slot_until: iso(now) },
    ...[{ position: 2 }, { state: 'waiting' }, { ahead: [randomUUID()] }, { head: { ...head, claim_id: randomUUID() } },
      { head: { ...head, until: iso(now) } }, { head: { ...head, since: iso(now + 60_000) } }]
      .map(q => ({ merge_queue: [{ ...claim.merge_queue[0], ...q }] })),
  ]) assert.equal(isCurrentMergeQueueHeadV2({ ...claim, ...patch }, observed, job, now), false);
});

test('full admission v2: Native multi-PR queue projection selects exact membership without trusting the scalar', async () => {
  for (const valid of [true, false]) {
    const id = randomUUID(), now = Date.now();
    const w = world({ claimId: id, claimOverrides: { merge_queue: [{ ref: `merge:${REPO}:main`, state: 'head', position: 1, ahead: [],
      head: { claim_id: id, bound_pr: null, bound_prs: [`${REPO}#887`, `${REPO}#${valid ? 888 : 889}`], since: iso(now - 1), until: iso(now + 600_000) } }] } });
    const facts = await w.port.evaluatePr(w.job, w.packet);
    assert.equal(facts.status, 'ADMITTED');
    assert.equal(facts.mergeQueueHead, valid);
    assert.equal(admittedFactsMatchJobV2(facts, w.job, Date.now()), true);
  }
});

// Resident quota redesign v0.6 §9 phase 1, item 4: the scheduling facts (ci_retry_after, merge-queue entry) reach the
// caller of every evaluation that reached Native, and a rejection's diagnostic carries them, sanitized.
test('full admission v2: scheduling facts are told on admission and carried in a rejection diagnostic', async () => {
  const w = world();
  const told = [];
  const facts = await w.port.evaluatePr(w.job, w.packet, { scheduling: s => told.push(s) });
  assert.equal(facts.status, 'ADMITTED');
  // generation 12 (resident DESIGN 56.3): the claim's lease end as Native reported it, normalized
  assert.deepEqual(told.map(({ claimExpiresAt, ...rest }) => rest), [{ ciRetryAfter: null, mergeQueue: { entered: true, state: 'head', position: 1 } }]);
  assert.ok(Number.isFinite(Date.parse(told[0].claimExpiresAt)) && told[0].claimExpiresAt === new Date(Date.parse(told[0].claimExpiresAt)).toISOString());
  assert.ok(!('scheduling' in facts) && !('mergeQueue' in facts), 'the admitted facts contract (ADMISSION_FIELDS_V2) is unchanged');
  // a throwing listener changes nothing
  assert.equal((await w.port.evaluatePr(w.job, w.packet, { scheduling: () => { throw new Error('boom'); } })).status, 'ADMITTED');
  assert.equal((await w.port.evaluatePr(w.job, w.packet, { scheduling: 'not a function' })).reason, 'full_admission_subject_invalid');
  assert.equal((await w.port.evaluatePr(w.job, w.packet, { other: 1 })).reason, 'full_admission_subject_invalid');

  const capped = world({ claimOverrides: { merge_queue: [] },
    outcomeOverrides: { admitted: false, verdict: 'REJECTED', reasons: ['task_ci_head_cap_reached'], ci_retry_after: '2026-10-22T12:00:00+00:00' } });
  const seen = [];
  const blocked = await capped.port.evaluatePr(capped.job, capped.packet, { scheduling: s => seen.push(s) });
  assert.equal(blocked.reason, 'full_admission_rejected');
  assert.deepEqual(seen.map(({ claimExpiresAt, ...rest }) => rest), [{ ciRetryAfter: '2026-10-22T12:00:00.000Z', mergeQueue: { entered: false, state: null, position: null } }]);
  assert.equal(typeof seen[0].claimExpiresAt, 'string');
  assert.ok(!('claimExpiresAt' in fullAdmissionFailureV2(blocked).admissionDiagnostic), 'the diagnostic keeps its shape');
  const failure = fullAdmissionFailureV2(blocked);
  assert.deepEqual(failure.admissionDiagnostic.reasonCodes, ['task_ci_head_cap_reached']);
  assert.equal(failure.admissionDiagnostic.ciRetryAfter, '2026-10-22T12:00:00.000Z');
  assert.deepEqual(failure.admissionDiagnostic.mergeQueue, { entered: false, state: null, position: null });
  // remote text never passes: a free-form ci_retry_after is null, a malformed queue entry is unknown (null)
  const odd = world({ claimOverrides: { merge_queue: [{ ref: `merge:${REPO}:main`, state: 'somewhere' }] },
    outcomeOverrides: { admitted: false, verdict: 'REJECTED', reasons: ['merge_slot_required'], ci_retry_after: 'tomorrow, maybe' } });
  const d = fullAdmissionFailureV2(await odd.port.evaluatePr(odd.job, odd.packet)).admissionDiagnostic;
  assert.deepEqual([d.ciRetryAfter, d.mergeQueue, d.reasonCodes], [null, null, ['merge_slot_required']]);
  assert.deepEqual(fullAdmissionFailureV2({ ...blocked, diagnostic: { ...blocked.diagnostic, mergeQueue: { entered: true, state: 'lapsed', position: 9 } } }).admissionDiagnostic.mergeQueue,
    { entered: false, state: 'lapsed', position: 9 }, 'a lapsed entry is not in the queue whatever it says');
});

// Step 3c-2a (design v0.5 §5.7, DESIGN §21.3): for a train front batch (S != H) the PR's base.sha is only a fact, which
// every read of one admission (GitHub twice, the evaluator, Native) must report alike; T stays the job's own base.
test('full admission v2 (step 3c-2a): a train front batch is admitted on whatever base.sha GitHub reports, read alike throughout', async () => {
  const S = '4'.repeat(40), moved = '9'.repeat(40);
  const front = world({ testSha: S, prBase: moved });
  const facts = await front.port.evaluatePr(front.job, front.packet);
  assert.equal(facts.status, 'ADMITTED', JSON.stringify(facts));
  assert.deepEqual([facts.headSha, facts.baseSha, facts.jobId], [HEAD, BASE, front.job.id]);
  // base.sha moving between the two GitHub reads, or Native reading another one: the subject changed
  const between = world({ testSha: S, prBase: moved, prBaseAfter: '8'.repeat(40) });
  assert.equal((await between.port.evaluatePr(between.job, between.packet)).reason, 'full_admission_subject_changed');
  const native = world({ testSha: S, prBase: moved, nativeOverrides: { base_sha: '8'.repeat(40) } });
  assert.equal((await native.port.evaluatePr(native.job, native.packet)).reason, 'full_admission_native_changed');
  // a batch that tests the head still needs base.sha = T
  const head = world({ prBase: moved });
  assert.equal((await head.port.evaluatePr(head.job, head.packet)).reason, 'full_admission_subject_changed');
});

// Decision 1100a0ed: Native's verified_at is never compared with this host's clock; its age is the monotonic time since
// the evaluation began (no verify send is seen in the fixture), and its lease is expires_at against verified_at.
test('full admission v2: KooYomi 10 s ahead or behind is admitted; an answer older than 30 s or a short lease is refused', async () => {
  for (const shift of [-10_000, -2000, 2000, 10_000]) {
    const w = world({ nativeOverrides: { verified_at: iso(Date.now() + shift) } });
    w.state.expiresAt = iso(Date.now() + shift + 3600_000);
    assert.equal((await w.port.evaluatePr(w.job, w.packet)).status, 'ADMITTED', `shift ${shift}`);
  }
  let mono = 0;
  const slow = world({ monotonic: () => (mono += 31_000) });
  assert.equal((await slow.port.evaluatePr(slow.job, slow.packet)).reason, 'full_admission_native_changed', 'over 30 s on the monotonic clock');
  const short = world({ nativeOverrides: { verified_at: iso(Date.now()) } });
  short.state.expiresAt = iso(Date.now() + 4000);
  assert.equal((await short.port.evaluatePr(short.job, short.packet)).reason, 'full_admission_native_changed', 'lease shorter than age + 5 s');
});
