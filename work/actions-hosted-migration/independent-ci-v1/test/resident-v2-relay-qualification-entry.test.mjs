import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical, digest } from '../src/proof.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';
import { ENTRY_V2, OUTCOME_CONTRACT } from '../src/resident-v2/layout.mjs';
import { makeRelayQualificationRun, RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS,
  RELAY_QUALIFICATION_WINDOW_CONTRACT, RELAY_QUALIFICATION_AUTHORITY_ID } from '../src/resident-v2/relay-qualification-run.mjs';
import { validateQualificationProtectedEnding, collectRelayQualificationObservation,
  createQualificationCurrentGate, qualificationReadOnlyGithub, qualificationNetworkFetch } from '../src/resident-v2/relay-qualification-entry.mjs';
import { GITHUB_OIDC_JWKS_URL, tokenFromAnnotation } from '../src/hosted-relay-v1/oidc.mjs';
import { createWorld, H, B, M0, OTHER, PR, REPO, CLAIM, MANIFEST } from './fixtures/hosted-relay/world.mjs';

const HX = c => c.repeat(64), NN = c => c.repeat(32);
const OWNER = '11111111-2222-3333-4444-555555555555';
const sha = text => createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function setup() {
  const world = createWorld(); world.state.pr.merge_commit_sha = M0; world.allHosted();
  const base = { repo: REPO, pr: PR, headSha: H, baseSha: B, testSha: H,
    sourceManifestSha256: MANIFEST, createdAt: new Date(world.state.now).toISOString() };
  const normalJob = makeJobV2({ ...base, role: 'work-admission', attempt: 1 });
  const record = { config: { repository: REPO, sourceManifestSha256: MANIFEST, scope: 'project:' + OWNER },
    accepted: { ownerReceiptRef: OWNER, node: { controllerSid: 'S-1-5-21-1-2-3-1001' } },
    hashes: { acceptanceSha256: HX('d') }, pins: new Map([[ENTRY_V2['work-admission'], HX('a')], [ENTRY_V2['relay-qualification'], HX('b')]]) };
  const ending = (outcome, role) => {
    const outcomeText = canonical(outcome) + '\n';
    const nativeText = canonical({ contract: 'clued.independent-ci.windows-formal-entry-receipt/2', nonce: outcome.nonce,
      stage: outcome.stage, entry_role: role, outcome_sha256: sha(outcomeText), source_manifest_sha256: MANIFEST,
      acceptance_sha256: record.hashes.acceptanceSha256, entry_sha256: record.pins.get(ENTRY_V2[role]), config_sha256: HX('e'),
      actual_sid: record.accepted.node.controllerSid, session_id: 0, service_pid: 30, node_pid: 31,
      state: 'FIXED_CHILD_COMPLETED', failure_code: null, node_exit_code: 0, timed_out: false, stop_requested: false,
      stdout_captured: false, private_bytes_read_by_helper: false, host_qualification: false, ci_principal_qualification: false,
      tree_cleanup_confirmed: true, root_exit_confirmed: true, tree_active_processes: 0, tree_cleanup_failure_code: null }) + '\n';
    return { outcomeText, nativeText };
  };
  const stage1Nonce = NN('1'), stage1 = ending({ contract: OUTCOME_CONTRACT, nonce: stage1Nonce, stage: 1,
    entryRole: 'work-admission', jobIds: [normalJob.id], status: 'SETTLED', reason: null, sideEffects: 1, mayHavePublished: true }, 'work-admission');
  const job = makeRelayQualificationRun({ ...base, runId: 'aaaaaaaaaaaaaaaa-bbbbbbbbbbbb', nodeProfileSha256: HX('f'),
    claimId: CLAIM, fence: 7, executionEpoch: 2, stage1JobId: normalJob.id, stage1OutcomeNonce: stage1Nonce,
    stage1OutcomeSha256: sha(stage1.outcomeText), phase: 'initial', priorObservationNonce: null, priorObservationSha256: null });
  record.accepted.relayQualificationWindow = { contract: RELAY_QUALIFICATION_WINDOW_CONTRACT, qualificationRef: 'receipt:' + OWNER,
    sourceManifestSha256: MANIFEST, ownerReceiptRef: OWNER, authorityDecisionId: RELAY_QUALIFICATION_AUTHORITY_ID,
    authorityDecisionSha256: HX('8'), authorityReadReceiptRef: OWNER,
    subject: Object.fromEntries(RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS.map(k => [k, job[k]])),
    validUntil: new Date(world.state.now + 3600000).toISOString(), allowedPhases: ['initial', 'after-ref-move'],
    executionPolicy: 'active', guarded: true, changedPaths: [...world.state.changedPaths], changedPathsSha256: digest(world.state.changedPaths) };
  const packets = new Map([[stage1Nonce, stage1]]), calls = { current: [], network: [], claim: [] };
  const native = { async current(identity, mode) { calls.current.push({ identity, mode }); return true; } };
  const fetchImpl = async (url, init) => { calls.network.push({ url, init }); return new Response(JSON.stringify(world.state.jwks), { status: 200 }); };
  const readClaim = async j => { calls.claim.push(j.id); return { claimId: CLAIM, fence: 7, epoch: 2 }; };
  const args = { job, record, github: world.github, native, live() {}, fetchImpl, registry: world.registry,
    readReceipt: async nonce => { assert.ok(packets.has(nonce), 'only known fixed receipt nonce is requested'); return packets.get(nonce); },
    readClaim, clock: () => world.state.now };
  return { args, job, record, world, packets, calls, ending, stage1, normalJob };
}

test('real fixture cryptography yields a bound short observation with no publish/K or secret output', async () => {
  const x = setup(), result = await collectRelayQualificationObservation(x.args);
  assert.equal(result.liveQualified, false); assert.equal(result.phase, 'initial'); assert.equal(result.jobId, x.job.id);
  assert.equal(result.roles.length, 2); assert.equal(result.refObservation.beforeMergeSha, M0);
  assert.ok(result.roles.every(r => r.verdict === 'ATTESTED_SUCCESS' && r.signatureVerified));
  assert.deepEqual(x.calls.claim, [x.normalJob.id]); assert.equal(x.calls.network.length, 1);
  assert.equal(x.calls.network[0].url, GITHUB_OIDC_JWKS_URL);
  assert.ok(x.calls.current.length > 10);
  for (const { identity, mode } of x.calls.current) {
    assert.equal(identity.job.id, x.normalJob.id); assert.deepEqual(identity.claim, { claim_id: CLAIM, fence: 7, execution_epoch: 2 });
    assert.deepEqual(mode.paths, x.record.accepted.relayQualificationWindow.changedPaths);
    assert.equal(mode.executionPolicy, 'active'); assert.equal(mode.guarded, true);
  }
  assert.equal(x.world.state.calls.createCheck, undefined); assert.equal(x.world.state.calls.revokeCheck, undefined);
  for (const annotations of x.world.state.annotations.values()) {
    assert.ok(!JSON.stringify(result).includes(tokenFromAnnotation(annotations[0].message)));
    assert.ok(!JSON.stringify(result).includes(annotations[0].message));
  }
});
test('helper stage1 proof requires exact hash/Source/SID/session0/terminal/tree and fixed once-only job', () => {
  const x = setup();
  const verify = packet => validateQualificationProtectedEnding({ ...packet, nonce: x.job.stage1OutcomeNonce,
    outcomeSha256: x.job.stage1OutcomeSha256, record: x.record, stage: 1, entryRole: 'work-admission', expectedJobId: x.job.stage1JobId });
  assert.equal(verify(x.stage1).status, 'SETTLED');
  const native = JSON.parse(x.stage1.nativeText);
  for (const change of [{ actual_sid: 'other' }, { source_manifest_sha256: HX('9') }, { session_id: 1 },
    { tree_active_processes: 1 }, { root_exit_confirmed: false }, { node_exit_code: 2 }, { state: 'FIXED_CHILD_REFUSED' },
    { stdout_captured: true }, { timed_out: true }, { entry_role: 'relay-publisher' }, { outcome_sha256: HX('9') }]) {
    assert.throws(() => verify({ ...x.stage1, nativeText: canonical({ ...native, ...change }) }), /RELAY_QUALIFICATION_STAGE1_REQUIRED/);
  }
  assert.throws(() => verify({ ...x.stage1, outcomeText: x.stage1.outcomeText + ' ' }), /RELAY_QUALIFICATION_STAGE1_REQUIRED/);
  assert.throws(() => validateQualificationProtectedEnding({ ...x.stage1, nonce: x.job.stage1OutcomeNonce,
    outcomeSha256: x.job.stage1OutcomeSha256, record: x.record, stage: 1, entryRole: 'work-admission', expectedJobId: HX('9') }), /RELAY_QUALIFICATION_STAGE1_REQUIRED/);
});
test('post-Stage1 locators remain protected-proof requirements even though the installed window omits them', async () => {
  for (const patch of [{ stage1OutcomeNonce: NN('9') }, { stage1OutcomeSha256: HX('9') }]) {
    const x = setup();
    const input = Object.fromEntries(Object.entries(x.job).filter(([k]) => !['contract', 'id'].includes(k)));
    const job = makeRelayQualificationRun({ ...input, ...patch });
    await assert.rejects(collectRelayQualificationObservation({ ...x.args, job,
      readReceipt: async () => x.stage1 }), /RELAY_QUALIFICATION_STAGE1_REQUIRED/);
    assert.equal(x.calls.network.length, 0);
  }
});
test('missing capability, original claim generation or actual changed paths stops before observation', async () => {
  const noWindow = setup(); delete noWindow.record.accepted.relayQualificationWindow;
  await assert.rejects(collectRelayQualificationObservation(noWindow.args), /RELAY_QUALIFICATION_WINDOW_REQUIRED/);
  assert.deepEqual(noWindow.world.state.calls, {}); assert.equal(noWindow.calls.network.length, 0);
  const claim = setup(); claim.args.readClaim = async () => ({ claimId: CLAIM, fence: 8, epoch: 2 });
  await assert.rejects(collectRelayQualificationObservation(claim.args), /RELAY_QUALIFICATION_STAGE1_REQUIRED/);
  assert.deepEqual(claim.world.state.calls, {});
  const paths = setup(); paths.world.state.changedPaths = ['src/other.js'];
  await assert.rejects(collectRelayQualificationObservation(paths.args), /RELAY_QUALIFICATION_PATHS_CHANGED/);
  assert.equal(paths.world.state.calls.readChangedPaths, 1); assert.equal(paths.calls.network.length, 0);
});
test('Native revocation latches and prevents all later GETs, retries and scans', async () => {
  const x = setup(); let calls = 0;
  x.args.native = { async current() { calls++; return calls < 5; } };
  await assert.rejects(collectRelayQualificationObservation(x.args), /RELAY_QUALIFICATION_CURRENT_REQUIRED/);
  assert.equal(calls, 5, 'a denied currentness check never calls Native or transport again');
  assert.equal(x.calls.network.length, 0); assert.equal(x.world.state.calls.createCheck, undefined);
  assert.equal(x.world.state.calls.readChangedPaths, 1);
});
test('readonly wrapper exposes no publisher/dispatch and raw pagination transport is independently gated', async () => {
  const x = setup(); let current = 0, sent = 0;
  const read = qualificationReadOnlyGithub({ ...x.world.github, createCheck() { throw Error('must not call'); } }, async () => { current++; });
  assert.equal(read.createCheck, undefined); assert.equal(read.revokeCheck, undefined); assert.equal(read.getInstallationToken, undefined);
  await read.readPullRequest(PR); assert.equal(current, 1);
  const fetch = qualificationNetworkFetch(async () => { sent++; return new Response('{}'); }, async () => { current++; });
  await fetch('https://api.github.com/repos/tdoljyj/cross-memory-system/pulls/7/files?page=1');
  await fetch('https://api.github.com/repos/tdoljyj/cross-memory-system/pulls/7/files?page=2');
  assert.equal(sent, 2); assert.equal(current, 3);
  await assert.rejects(fetch('https://api.github.com/repos/tdoljyj/cross-memory-system/check-runs', { method: 'POST' }), /RELAY_QUALIFICATION_NETWORK_REFUSED/);
  await assert.rejects(fetch('https://attacker.invalid/jwks'), /RELAY_QUALIFICATION_NETWORK_REFUSED/); assert.equal(sent, 2);
});
test('after-ref-move reads accepted prior outcome and old object despite a new current PR HEAD', async () => {
  const x = setup(), prior = await collectRelayQualificationObservation(x.args);
  const priorNonce = NN('2'), packet = x.ending({ contract: OUTCOME_CONTRACT, nonce: priorNonce, stage: 13,
    entryRole: 'relay-qualification', jobIds: [x.job.id], status: 'RELAY_QUALIFICATION_OBSERVATION', reason: null,
    sideEffects: 0, mayHavePublished: false, observation: prior }, 'relay-qualification');
  x.packets.set(priorNonce, packet);
  const { contract, id, ...input } = x.job;
  const afterJob = makeRelayQualificationRun({ ...input, phase: 'after-ref-move', priorObservationNonce: priorNonce,
    priorObservationSha256: sha(packet.outcomeText) });
  x.world.state.pr.merge_commit_sha = OTHER; x.world.state.pr.head.sha = OTHER;
  const changesBefore = x.world.state.calls.readChangedPaths;
  const result = await collectRelayQualificationObservation({ ...x.args, job: afterJob });
  assert.equal(result.liveQualified, false); assert.equal(result.phase, 'after-ref-move');
  assert.equal(result.refObservation.beforeMergeSha, M0); assert.equal(result.refObservation.afterMergeSha, OTHER);
  assert.deepEqual(result.roles, prior.roles); assert.equal(x.calls.network.length, 2, 'fresh fixed JWKS GET on each phase');
  assert.equal(x.world.state.calls.readChangedPaths, changesBefore, 'old Subject paths come from accepted window, never new HEAD files');
});
test('changed prior native terminal, unchanged ref and unreadable old object never produce success', async () => {
  for (const kind of ['native', 'same-ref', 'old-object']) {
    const x = setup(), prior = await collectRelayQualificationObservation(x.args), nonce = NN('2');
    const packet = x.ending({ contract: OUTCOME_CONTRACT, nonce, stage: 13, entryRole: 'relay-qualification',
      jobIds: [x.job.id], status: 'RELAY_QUALIFICATION_OBSERVATION', reason: null,
      sideEffects: 0, mayHavePublished: false, observation: prior }, 'relay-qualification');
    x.packets.set(nonce, packet);
    const { contract, id, ...input } = x.job;
    const afterJob = makeRelayQualificationRun({ ...input, phase: 'after-ref-move', priorObservationNonce: nonce,
      priorObservationSha256: sha(packet.outcomeText) });
    x.world.state.pr.merge_commit_sha = OTHER;
    if (kind === 'native') packet.nativeText = canonical({ ...JSON.parse(packet.nativeText), tree_active_processes: 1 });
    if (kind === 'same-ref') x.world.state.pr.merge_commit_sha = M0;
    if (kind === 'old-object') x.world.state.commits.delete(M0);
    await assert.rejects(collectRelayQualificationObservation({ ...x.args, job: afterJob }));
    assert.equal(x.calls.network.length, 1, kind + ': no new JWKS fetch after bad provenance/ref/object');
  }
});
test('mode currentness check cannot silently turn accepted active/guarded into staged/unguarded', async () => {
  const x = setup(); let seen;
  const gate = createQualificationCurrentGate({ record: x.record, job: x.job, live() {}, clock: x.args.clock,
    native: { async current(identity, mode) { seen = mode; return false; } } });
  await assert.rejects(gate(), /RELAY_QUALIFICATION_CURRENT_REQUIRED/);
  assert.equal(seen.executionPolicy, 'active'); assert.equal(seen.guarded, true);
  assert.deepEqual(seen.paths, ['src/app.js']);
});
