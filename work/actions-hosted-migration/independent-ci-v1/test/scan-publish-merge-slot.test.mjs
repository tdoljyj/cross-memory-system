// Stages 3, 5, 7 (scanner publication) do not depend on the merge slot; stage 8 still does.
//
// Before: staged-check-publisher-v2.mjs bound Native's whole merge-slot observation (state, until, ...) in the
// before/after authorization binding of one publication. A claim joining or leaving the merge queue, a renewal that
// moved the slot's until, or the slot lapsing between the two reads voided the publication
// (authorization_binding_changed -> REVOKED, the head burned) although a scan result has nothing to do with the slot.
// Now a scanner role binds only the slot's ref and tip (which slot, which main tip). These tests pin both halves: the
// three slot changes (join, leave, lapse) no longer revoke any scanner role, and every other bound field, the claim
// lease, the Native admission itself and stage 8 stay exactly as strict.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration, subjectOfV2, SCANNER_ROLES_V2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { createStagedCheckPublisherV2, slotBindingFor } from '../src/staged-check-publisher-v2.mjs';
import { createFixtureControlPublisherV2, QUEUE_POLL_MS } from '../src/independent-control-checks-v2/publisher.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const SLOT_REF = `merge:${REPO}:main`;
const iso = ms => new Date(ms).toISOString();
const SLOT_UNTIL = iso(Date.now() + 3600_000); // fixed: an unchanged slot reads alike twice
const jobsFor = (attempt = 1) => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt });
const claim = (o = {}) => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000), ...o });
const blocked = reason => ({ contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false, reason });

// A complete admitted v2 observation (shape of full-admission-v2 facts); every field a test varies is a parameter.
function admitted(job, observed, packet, { mergeQueueHead = false, slot = {}, batchClaim = null, observedAt = Date.now(), mode = {}, ownerReview = null, executionPolicy = 'staged' } = {}) {
  const facts = { contract: 'clued.independent-ci.full-admission/2', status: 'ADMITTED', admitted: true, completeAdmission: true, evaluator: 'scripts/ci/clued-work-admission.mjs#evaluate',
    domain: 'fixture', repository: REPO, scope: 'project:x', prRef: `${REPO}#${job.pr}`, headSha: job.headSha, baseSha: job.baseSha, jobId: job.id, role: job.role, attempt: job.attempt,
    claimId: observed.claimId, fence: observed.fence, epoch: observed.epoch, observedClaim: { ...observed }, batchClaimBound: batchClaim ? claimGeneration(batchClaim) : null,
    sourceManifestSha256: job.sourceManifestSha256, executionPolicy, guarded: false, executionHandoverPending: false, mergeQueueHead,
    mode: { state: 'normal', layer: 'code', policyVersion: 1, ...mode }, mergeSlot: { state: 'held', ref: SLOT_REF, tip: job.baseSha, until: SLOT_UNTIL, ...slot },
    ownerReview, workflowGateFindings: [], observedAt: iso(observedAt), claimExpiresAt: observed.expiresAt, modeProofRef: 'mode', observationRef: 'obs',
    packetSha256: digest(packet), evaluationSha256: digest('evaluation') };
  return { ...facts, observationSha256: digest(facts) };
}
// Branch rules and the test merge stage 8 reads (shape as in resident-v2-publishers.test.mjs): the six checks pinned to
// 5368905, strict on, the test merge exactly [BASE, HEAD] with HEAD's own tree.
const SIX = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const TREE = 'c'.repeat(40), TEST_MERGE = 'd'.repeat(40);
const branchRules = () => [
  { type: 'deletion', rulesetId: 24182890, parameters: null },
  { type: 'pull_request', rulesetId: 24182890, parameters: { allowed_merge_methods: ['merge', 'squash', 'rebase'], required_approving_review_count: 0 } },
  { type: 'required_status_checks', rulesetId: 24182890, parameters: { strict_required_status_checks_policy: true, required_status_checks: SIX.map(context => ({ context, integration_id: 5368905 })) } }];
function fakeGithub() {
  const checks = []; let next = 100;
  const state = { onCreate: null, pull: { state: 'open', merged: false, mergeable: true, merge_commit_sha: TEST_MERGE },
    commits: { [HEAD]: { sha: HEAD, tree: TREE, parents: [BASE] }, [TEST_MERGE]: { sha: TEST_MERGE, tree: TREE, parents: [BASE, HEAD] } } };
  return { fixture: true, checks, state,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, ...structuredClone(state.pull), head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readBranchRules(branch) { return { complete: true, branch, rules: branchRules() }; },
    async readGitCommit(sha) { if (!state.commits[sha]) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' }); return structuredClone(state.commits[sha]); },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); state.onCreate?.(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}
// admission.evaluatePr: answers from a script (job, packet, options, call number).
function fakeAdmission(answer) { let calls = 0; return { fixture: true, get calls() { return calls; }, async evaluatePr(job, packet, options) { calls++; return answer(job, packet, options ?? {}, calls); } }; }

// One scanner publication of `role`. `observe(job, c, packet, opts, n)` answers Native's n-th full evaluation of the
// publication: n = 1 is the before-write read, n = 2 the after-write read. Returns the publisher's result and its world.
async function scanPublication(t, role, observe, { authorityClaimExpiresAt = null } = {}) {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const job = jobsFor()[role], c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const refs = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, record.accepted[k]]));
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
    publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: authorityClaimExpiresAt ?? c.expiresAt, claim: claimGeneration(c) }; } };
  const admission = fakeAdmission((j, packet, opts, n) => observe(j, c, packet, opts, n));
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const publisher = createStagedCheckPublisherV2({ nativeAdmission: admission, authority, github, journal, signers, configuredChecks: record.config.checks,
    readChangedPaths: j => github.readChangedPaths(j), protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs },
    batchClaim: claimGeneration(c), domain: 'fixture' });
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  const result = await publisher.publish({ job, envelope });
  return { result, github, admission, journal, job, c };
}
const withAfter = (before, after) => (j, c, packet, opts, n) => admitted(j, c, packet, { batchClaim: opts.batchClaim, ...(n === 1 ? before : after) });

// The queue/slot changes that may happen between the two reads of one publication.
const SLOT_CHANGES = {
  'the claim joins the merge queue': [{ slot: { state: 'missing', until: null }, mergeQueueHead: false }, { slot: { state: 'held' }, mergeQueueHead: true }],
  'the claim leaves the merge queue': [{ slot: { state: 'held' }, mergeQueueHead: true }, { slot: { state: 'missing', until: null }, mergeQueueHead: false }],
  'the slot lapses (held until 45 minutes, then missing)': [{ slot: { state: 'held', until: iso(Date.now() + 1000) }, mergeQueueHead: true }, { slot: { state: 'missing', until: iso(Date.now() - 1000) }, mergeQueueHead: false }],
  'the head of the queue changes while the claim only waits': [{ slot: { state: 'missing', until: null }, mergeQueueHead: true }, { slot: { state: 'missing', until: null }, mergeQueueHead: false }],
  'a renewal or touch moves the slot clock (until only)': [{ slot: { until: iso(Date.now() + 1_000_000) } }, { slot: { until: iso(Date.now() + 3_000_000) } }],
  'the slot goes from not_needed to held (the head now contains main\'s tip)': [{ slot: { state: 'not_needed', until: null } }, { slot: { state: 'held' } }],
  'the policy advises the slot (not_required, observed state changes)': [{ slot: { state: 'not_required', observed: 'missing', until: null } }, { slot: { state: 'not_required', observed: 'held' } }],
};

for (const role of SCANNER_ROLES_V2) {
  for (const [name, [before, after]] of Object.entries(SLOT_CHANGES)) {
    test(`scanner publisher v2 (${role}): ${name} between the two reads does not revoke the scan`, async t => {
      const { result, github, admission } = await scanPublication(t, role, withAfter(before, after));
      assert.equal(result.status, 'SETTLED', JSON.stringify(result));
      assert.equal(result.sideEffects, 1, 'one create, no revocation');
      assert.equal(admission.calls, 2, 'the publication was admitted before and after the write');
      assert.deepEqual(github.checks.map(x => [x.status, x.conclusion]), [['completed', 'success']]);
    });
  }
}

test('scanner publisher v2: the control run -- a slot that never changes still settles (baseline for the cases above)', async t => {
  const same = { slot: { state: 'held' }, mergeQueueHead: true };
  const { result } = await scanPublication(t, 'gitleaks', withAfter(same, same));
  assert.equal(result.status, 'SETTLED');
});

// Every other field of the binding stays bound: a change between the two reads revokes the one check, never leaves a success.
const STILL_BOUND = {
  'the mode (state)': { mode: { state: 'frozen' } },
  'the mode (layer)': { mode: { layer: 'protected' } },
  'the mode (policyVersion)': { mode: { policyVersion: 2 } },
  'the Owner review': { ownerReview: { kind: 'owner_grant', grantId: 'g-1', carriedFrom: null } },
  'the execution policy': { executionPolicy: 'active' },
  'the slot ref (another slot)': { slot: { ref: `merge:${REPO}:other` } },
  'main\'s tip as the slot reports it (main moved)': { slot: { tip: '9'.repeat(40) } },
};
for (const [name, change] of Object.entries(STILL_BOUND)) {
  test(`scanner publisher v2: ${name} changing between the two reads still revokes (not relaxed)`, async t => {
    const { result, github } = await scanPublication(t, 'trivy', withAfter({}, change));
    assert.equal(result.status, 'REVOKED', JSON.stringify(result));
    assert.ok(['authorization_binding_changed', 'native_identity_changed'].includes(result.reason), JSON.stringify(result));
    assert.equal(result.sideEffects, 2, 'create + revoke');
    assert.deepEqual(github.checks.map(x => x.conclusion), ['failure']);
  });
}

test('scanner publisher v2: a slot change together with another bound change still revokes (the slot cannot mask a real drift)', async t => {
  const { result } = await scanPublication(t, 'gitleaks', withAfter({ slot: { state: 'held' }, mergeQueueHead: true }, { slot: { state: 'missing', until: null }, mergeQueueHead: false, mode: { state: 'frozen' } }));
  assert.deepEqual([result.status, result.reason], ['REVOKED', 'authorization_binding_changed']);
});

test('scanner publisher v2: the claim generation moving between the two reads still revokes', async t => {
  const { result, github } = await scanPublication(t, 'contract-placement', (j, c, packet, opts, n) =>
    admitted(j, n === 1 ? c : { ...c, fence: c.fence + 1 }, packet, { batchClaim: opts.batchClaim }));
  assert.equal(result.status, 'REVOKED', JSON.stringify(result));
  assert.deepEqual(github.checks.map(x => x.conclusion), ['failure']);
});

test('scanner publisher v2: Native no longer admitting after the write still revokes (full_admission_not_proven)', async t => {
  for (const after of [blocked('full_admission_rejected'), blocked('full_admission_native_changed'), blocked('full_admission_unavailable')]) {
    const { result, github } = await scanPublication(t, 'gitleaks', (j, c, packet, opts, n) => n === 1 ? admitted(j, c, packet, { batchClaim: opts.batchClaim }) : after);
    assert.deepEqual([result.status, result.reason, result.sideEffects, github.checks.map(x => x.conclusion)], ['REVOKED', 'full_admission_not_proven', 2, ['failure']], after.reason);
  }
});

test('scanner publisher v2: an expired claim lease is not a slot change and still refuses (before: nothing written; after: revoked)', async t => {
  // before the write: the lease is already over, so the publication never starts
  const early = await scanPublication(t, 'gitleaks', (j, c, packet, opts) => admitted(j, { ...c, expiresAt: iso(Date.now() - 1000) }, packet, { batchClaim: opts.batchClaim }),
    { authorityClaimExpiresAt: iso(Date.now() - 1000) });
  assert.equal(early.result.status, 'BLOCKED');
  assert.equal(early.result.sideEffects, 0);
  assert.equal(early.github.checks.length, 0, 'nothing was written');
});

test('slotBindingFor: scanner roles bind only the slot\'s ref and tip; every other role binds the whole slot', () => {
  const slot = { state: 'held', ref: SLOT_REF, tip: BASE, until: iso(Date.now() + 1000), observed: 'held' };
  for (const role of SCANNER_ROLES_V2) assert.deepEqual(slotBindingFor({ role }, slot), { ref: SLOT_REF, tip: BASE });
  for (const role of ['work-admission', 'control-admission', 'control-merge-slot', 'unknown', undefined]) assert.equal(slotBindingFor({ role }, slot), slot, String(role));
  assert.equal(slotBindingFor(null, slot), slot);
  assert.deepEqual(slotBindingFor({ role: 'gitleaks' }, {}), { ref: null, tip: null });
});

// Stage 8 (control-admission, control-merge-slot) keeps its strictness: the slot is the very thing it checks.
test('control pair v2 (stage 8) is as strict as before: the slot or the queue head changing between its two reads revokes, nothing settles', async t => {
  const changes = {
    'the slot lapses (held -> missing)': { slot: { state: 'missing', until: null }, mergeQueueHead: false },
    'the claim loses the queue head (still held in the observation)': { slot: { state: 'held' }, mergeQueueHead: false },
    'main moved (slot tip)': { slot: { state: 'held', tip: '9'.repeat(40) }, mergeQueueHead: true },
  };
  for (const [name, drift] of Object.entries(changes)) {
    const jobs = jobsFor(), c = claim(), github = fakeGithub();
    const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
    let time = Date.now(), written = false;
    github.state.onCreate = () => { written = true; };
    const admission = fakeAdmission((job, packet, opts) => admitted(job, c, packet, { batchClaim: opts.batchClaim, observedAt: time, mergeQueueHead: true, ...(written ? drift : {}) }));
    const pub = createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
    const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + 10 * QUEUE_POLL_MS });
    assert.deepEqual([r.status, r.reason, r.sideEffects], ['REVOKED', 'NATIVE_AUTHORIZATION_BINDING_CHANGED', 2], `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(github.checks.map(x => x.conclusion), ['failure']);
    assert.ok(!github.checks.some(x => x.conclusion === 'success'), `${name}: no success stands`);
  }
  // an until-only move is still tolerated at stage 8 (§41.8, unchanged)
  const jobs = jobsFor(), c = claim(), github = fakeGithub();
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  let time = Date.now(), written = false;
  github.state.onCreate = () => { written = true; };
  const admission = fakeAdmission((job, packet, opts) => admitted(job, c, packet, { batchClaim: opts.batchClaim, observedAt: time, mergeQueueHead: true, slot: { until: iso(time + (written ? 1_800_000 : 600_000)) } }));
  const pub = createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim: claimGeneration(c), clock: () => time, sleep: async ms => { time += ms; } });
  const r = await pub.publishPair([jobs['control-admission'], jobs['control-merge-slot']], { waitUntil: time + 10 * QUEUE_POLL_MS });
  assert.equal(r.status, 'SETTLED', JSON.stringify(r));
});
