// Offline tests of the Source v2 Linux side and bridge v4 (DESIGN S6, S7, S10): claim-free jobs, the shared v2
// admission check with a sticky claim generation, protocol v4 (incl. the clean 'blocked' record), the v4 signed
// result, the Windows issuer engine end to end against a simulated Linux party, role policy v3 and
// qualification v2. No network, Docker, WSL, Host path or credential; all directories are under os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, sign } from 'node:crypto';
import { canonical } from '../src/proof.mjs';
import { batchJobsV2, claimGeneration } from '../src/job-v2.mjs';
import { ENVELOPE_CONTRACT_V2 } from '../src/proof-v2.mjs';
import { validateFormalAdmissionV2 } from '../src/admission-facts-v2.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { runWorkerJob } from '../src/worker-v2.mjs';
import { REQUIRED_SOURCE_PATHS, createWindowsContext } from '../worker/protected-job-bridge-v4/boundary.mjs';
import { CALLBACK_WINDOW_MS, makeIssue, makeChallenge, makeResponse, makeBlocked, validateChallenge, validateResponse, validateBlocked, encode, decode, digest as bridgeDigest } from '../worker/protected-job-bridge-v4/protocol.mjs';
import { createFixtureMailbox } from '../worker/protected-job-bridge-v4/mailbox.mjs';
import { runIssuer as runActualIssuer, issuerEvaluate, blockedReason, refsFailureReason, ISSUER_SUCCESS } from '../worker/protected-job-bridge-v4/windows-issuer.mjs';
import { resultPayload, observationFacts, verifySignedBridgeResult, RESULT_WRAPPER_CONTRACT_V2 } from '../worker/protected-job-bridge-v4/signed-result.mjs';
import { callbackValue, cleanBlockedReason, isCleanBlocked } from '../worker/protected-job-bridge-v4/linux-worker.mjs';
import { cacheRefusal } from '../worker/formal-trivy-v4/adapter.mjs';
import { bridgeManifest, BRIDGE_MANIFEST_CONTRACT } from '../worker/protected-job-bridge-v4/bridge-manifest.mjs';
import { validatePolicyShape, validateQualificationPayload, qualificationDeadline, LINUX_NODE_V2 } from '../worker/qualification-v2.mjs';
import { validateSelectedFacts, requiredSourcePaths, FIXED_ROLE_POLICIES } from '../worker/formal-fixed-role-policy-v3/policy.mjs';
import { IMAGE as GITLEAKS_IMAGE, SCAN_ARGS, REVIEWED_HISTORY_PROOF } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import { validateEntryJob } from '../worker/formal-contract-placement-v2/container-entry.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, admittedFacts, hex } from './resident-v2-fixtures.mjs';
import { PLACEMENT as PLACEMENT_WORKFLOW, acceptedSha256s } from './fixtures/trusted-workflows.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const sha = b => createHash('sha256').update(b).digest('hex');
const claim = (o = {}) => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000), ...o });
const PACKET = { complete: true, paths: ['a.txt'] };
// Explicit offline Native boundary; no production caller flag is added.
const runIssuer = options => runActualIssuer({ scanStart: async ({ job, executionId }) => ({ status: 'committed', contract: 'clued.ci-scan-start-grant/1', launch_allowed: true, execution_id: executionId, receipt_id: randomUUID(), repository_id: 1334673495, head_sha: job.headSha, role: job.role, provider: 'independent-controller', start_requested_at: new Date().toISOString() }), nativeScanStartRequired: true, ...options });
const refsSnapshot = (now = Date.now()) => ({ contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: iso(now), refs: [{ name: 'refs/heads/main', objectSha: BASE }] });

function setup({ attempt = 1 } = {}) {
  const fx = fixtureRecord({}, { paths: REQUIRED_SOURCE_PATHS });
  const record = validateRecordV2(fx.docs, { now: Date.now() });
  const jobs = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: record.config.sourceManifestSha256, createdAt: iso(Date.now() - 60_000), attempt });
  return { ...fx, record, jobs };
}
const facts = (job, c, batch = c) => admittedFacts(job, c, PACKET, { batchClaim: batch });

function trivyObservation(job, { exitCode = 0, startedAt = Date.now() - 20_000 } = {}) {
  const log = () => ({ sha256: hex(32), bytes: 10, truncated: false });
  const scans = [0, 1, 2].map(i => ({ scanner: ['vuln', 'misconfig', 'secret'][i], complete: true, cleanupConfirmed: true, exitCode: i === 2 ? exitCode : 0, startedAt: iso(startedAt + i), logs: { stdout: log(), stderr: log() } }));
  return { contract: 'clued.independent-ci.formal-scanner-observation/2', domain: 'production-observation', fixture: false, profile: 'required-trivy-three-scanners/1',
    subject: Object.fromEntries(['id', 'repo', 'pr', 'headSha', 'baseSha', 'role', 'sourceManifestSha256', 'attempt'].map(k => [k, job[k]])),
    sourceManifestSha256: job.sourceManifestSha256, sourceSha: 'c'.repeat(40), scans, conclusion: exitCode === 0 ? 'success' : 'failure',
    cleanup: { containersRemoved: true, wholeContainerTreesStopped: true, snapshotRemoved: true, observedAt: iso(Date.now() - 2000) },
    formalEligible: false, checksWritten: false, qualificationIssued: false };
}
function signedWrapper(issue, observation, signer) {
  const payload = resultPayload(issue, observation, observationFacts(issue, observation), 'fixture-runtime');
  const envelope = { contract: ENVELOPE_CONTRACT_V2, keyId: 'fixture-key', payload, signature: sign(null, Buffer.from(canonical(payload)), signer.privateKey).toString('base64url') };
  return { contract: RESULT_WRAPPER_CONTRACT_V2, domain: 'production', issueSha256: bridgeDigest(issue), envelope, observation };
}

test('gitleaks signed result v4 binds the exact 730/102/173/130 proof and rejects legacy or altered proof', () => {
  const { jobs, signer, record } = setup(), job = jobs.gitleaks, c = claim(), now = Date.now();
  const issue = makeIssue(job, facts(job, c), refsSnapshot(), { sourceAcceptanceRef: record.accepted.sourceAcceptanceRef,
    hostQualificationRef: record.accepted.hostQualificationRef, expiresAt: iso(now + 600000) });
  const observation = { contract: 'clued.independent-ci.formal-scanner-observation/2', domain: 'production-observation', fixture: false,
    profile: 'required-gitleaks-history/1', subject: Object.fromEntries(['id', 'repo', 'pr', 'headSha', 'baseSha', 'role', 'sourceManifestSha256', 'attempt'].map(k => [k, job[k]])),
    sourceManifestSha256: job.sourceManifestSha256, sourceSha: 'c'.repeat(40), requiredHistoricalExceptions: 730,
    reviewedHistoryProof: { ...REVIEWED_HISTORY_PROOF }, startedAt: iso(now - 5000), finishedAt: iso(now - 1000), exitCode: 0, conclusion: 'success',
    logs: { stdout: { sha256: hex(32) }, stderr: { sha256: hex(32) } },
    cleanup: { complete: true, wholeContainerTreeStopped: true, containerRemoved: true, observedAt: iso(now - 500) },
    formalEligible: false, checksWritten: false, qualificationIssued: false };
  const wrapper = signedWrapper(issue, observation, signer);
  assert.equal(verifySignedBridgeResult({ issue, wrapper, signers: record.signers }).payload.conclusion, 'success');
  for (const changed of [{ ...observation, requiredHistoricalExceptions: 726 }, { ...observation, requiredHistoricalExceptions: 729 }, { ...observation, reviewedHistoryProof: undefined },
    ...Object.keys(REVIEWED_HISTORY_PROOF).map(key => ({ ...observation, reviewedHistoryProof: { ...REVIEWED_HISTORY_PROOF, [key]: null } }))]) {
    assert.throws(() => verifySignedBridgeResult({ issue, wrapper: { ...wrapper, observation: changed }, signers: record.signers }),
      { code: 'ACTUAL_HISTORY_CLEANUP_REQUIRED' });
  }
});

test('v2 admission check: the claim comes from the facts, the batch generation is required and sticky; renewal is the same generation', () => {
  const { jobs } = setup(), job = jobs.trivy, c = claim();
  assert.equal(validateFormalAdmissionV2(job, facts(job, c)).claimId, c.claimId);
  assert.throws(() => validateFormalAdmissionV2(job, admittedFacts(job, c, PACKET)), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' }); // no batch claim bound
  assert.throws(() => validateFormalAdmissionV2(job, facts(job, c, claim())), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' }); // observed != batch
  const renewed = { ...c, expiresAt: iso(Date.now() + 7200_000) };
  assert.ok(validateFormalAdmissionV2(job, facts(job, renewed, c), Date.now(), { batchClaim: claimGeneration(c) }));
  assert.throws(() => validateFormalAdmissionV2(job, facts(job, c), Date.now(), { batchClaim: { ...claimGeneration(c), fence: 4 } }), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' });
  assert.throws(() => validateFormalAdmissionV2(jobs.gitleaks, facts(job, c)), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' }); // another role's job id
  assert.throws(() => validateFormalAdmissionV2(job, { ...facts(job, c), domain: 'fixture' }), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' });
});

test('protocol v4: issue -> challenge -> response round trip; a moved claim generation and v1 jobs are refused; blocked binds the issue', () => {
  const { jobs, accepted } = { ...setup() }, job = jobs.gitleaks, c = claim();
  const ctx = { sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), expiresAt: iso(Date.now() + 600_000) };
  const issue = makeIssue(job, facts(job, c), refsSnapshot(), ctx);
  assert.deepEqual(decode(encode(issue)), JSON.parse(JSON.stringify(issue)));
  const ch = makeChallenge(issue, 'admission', 1);
  const renewed = { ...c, expiresAt: iso(Date.now() + 7200_000) };
  assert.ok(makeResponse(issue, ch, facts(job, renewed, c), null)); // renewal: same generation
  const other = claim();
  assert.throws(() => makeResponse(issue, ch, facts(job, other, other), null), { code: 'BRIDGE_FORMAL_ADMISSION_SHAPE_REQUIRED' });
  const refsCh = makeChallenge(issue, 'remote-refs', 2);
  assert.ok(validateResponse(issue, refsCh, makeResponse(issue, refsCh, null, refsSnapshot())));
  assert.throws(() => makeChallenge(makeIssue(jobs.trivy, facts(jobs.trivy, c), null, ctx), 'remote-refs', 1), { code: 'BRIDGE_CHALLENGE_ACTION_REQUIRED' });
  const v1 = { ...job, contract: 'clued.independent-ci.job/1', claimId: c.claimId, fence: 3, epoch: 1 };
  assert.throws(() => makeIssue(v1, facts(job, c), refsSnapshot(), ctx), { code: 'BRIDGE_FIXED_JOB_REQUIRED' });
  assert.throws(() => makeIssue(jobs['work-admission'], facts(jobs['work-admission'], c), null, ctx), { code: 'BRIDGE_FIXED_JOB_REQUIRED' });
  const b = makeBlocked(issue, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  assert.equal(validateBlocked(issue, decode(encode(b))).reason, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  assert.throws(() => validateBlocked(issue, { ...b, sideEffectsMayHaveStarted: true }), { code: 'BRIDGE_BLOCKED_BINDING_CHANGED' });
  assert.throws(() => validateBlocked(makeIssue(job, facts(job, c), refsSnapshot(), ctx), b), { code: 'BRIDGE_BLOCKED_BINDING_CHANGED' });
  // the issue never outlives the claim lease it was issued under
  const short = claim({ expiresAt: iso(Date.now() + 60_000) });
  assert.ok(Date.parse(makeIssue(job, facts(job, short), refsSnapshot(), ctx).expiresAt) <= Date.parse(short.expiresAt));
  void accepted;
});

// Owner Decision 6f1fb753 (Task 576231fa): PR #915 stage 4 (2026-10-23) lost a response the issuer had written 10 s
// after the challenge, because the relay call took about 30 s and the Linux side measured the admission's 30 s from
// the arrival. Like the issue's, a response's admission is now fresh at its issuance; the response only has to arrive
// inside its own window, and the claim must outlive the arrival.
test('protocol v4: a callback response is fresh at its issuance and only has to arrive inside its window', () => {
  const { jobs } = setup(), job = jobs.trivy, c = claim(), generation = { batchClaim: claimGeneration(c) };
  const ctx = () => ({ sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), expiresAt: iso(Date.now() + 600_000) });
  const issue = makeIssue(job, facts(job, c), null, ctx()), gl = jobs.gitleaks, gissue = makeIssue(gl, facts(gl, c), refsSnapshot(), ctx());
  const t = Date.now(), ch = makeChallenge(issue, 'admission', 1, { now: t });
  const answer = admittedFacts(job, c, PACKET, { batchClaim: c, observedAt: t + 10_000 });
  const response = makeResponse(issue, ch, answer, null, { now: t + 10_500 });
  const arrived = t + 10_500 + 35_000; // the relay call took 35 s
  assert.ok(validateResponse(issue, ch, decode(encode(response)), arrived));
  // The adapter re-checks the facts the worker hands it from the issuance while the response is valid ...
  const given = callbackValue('admission', decode(encode(response)));
  assert.ok(validateFormalAdmissionV2(job, given, arrived, generation));
  assert.throws(() => validateFormalAdmissionV2(job, given, Date.parse(response.expiresAt), generation), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' });
  // ... and the same facts outside a validated response keep the 30 s from now.
  assert.throws(() => validateFormalAdmissionV2(job, decode(encode(response)).admission, arrived, generation), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' });
  // Stale already at issuance: never issued, and a forged late issuedAt does not pass either.
  const stale = admittedFacts(job, c, PACKET, { batchClaim: c, observedAt: t });
  assert.throws(() => makeResponse(issue, ch, stale, null, { now: t + 31_000 }), { code: 'BRIDGE_FORMAL_ADMISSION_SHAPE_REQUIRED' });
  assert.throws(() => validateResponse(issue, ch, { ...decode(encode(makeResponse(issue, ch, stale, null, { now: t + 1_000 }))), issuedAt: iso(t + 31_000) }, t + 32_000), { code: 'BRIDGE_FORMAL_ADMISSION_SHAPE_REQUIRED' });
  // Arrival after the round's deadline is still refused.
  assert.throws(() => validateResponse(issue, ch, decode(encode(response)), Date.parse(ch.deadline)), { code: 'BRIDGE_CHALLENGE_EXPIRED' });
  // A claim that ends before the arrival: the response never outlives it.
  const short = { ...c, expiresAt: iso(t + 20_000) };
  const r2 = makeResponse(issue, ch, admittedFacts(job, short, PACKET, { batchClaim: c, observedAt: t + 10_000 }), null, { now: t + 10_500 });
  assert.ok(Date.parse(r2.expiresAt) <= t + 20_000);
  assert.ok(validateResponse(issue, ch, decode(encode(r2)), t + 19_000));
  assert.throws(() => validateResponse(issue, ch, decode(encode(r2)), t + 25_000), { code: 'BRIDGE_RESPONSE_EXPIRED' });
  // A response window past the claim is never issued, and a forged one is refused on arrival.
  const shortFacts = admittedFacts(job, short, PACKET, { batchClaim: c, observedAt: t + 10_000 });
  assert.throws(() => makeResponse(issue, ch, shortFacts, null, { now: t + 10_500, expiresAt: iso(t + 60_000) }), { code: 'BRIDGE_RESPONSE_ADMISSION_TIME_REQUIRED' });
  const stretched = { ...decode(encode(r2)), expiresAt: iso(t + 60_000) };
  assert.throws(() => validateResponse(issue, ch, stretched, t + 25_000), { code: 'BRIDGE_RESPONSE_ADMISSION_TIME_REQUIRED' });
  // Noted facts never get the issuance time past their claim, whatever the response window says.
  assert.throws(() => validateFormalAdmissionV2(job, callbackValue('admission', stretched), t + 25_000, generation), { code: 'FRESH_COMPLETE_NATIVE_ADMISSION_REQUIRED' });
  // remote-refs responses likewise (Task 576231fa): the refs snapshot is fresh at the response's issuance, not its arrival
  // (test/issuer-refs-transient.test.mjs has the details).
  const refsCh = makeChallenge(gissue, 'remote-refs', 1, { now: t }), refsResponse = makeResponse(gissue, refsCh, null, refsSnapshot(t + 10_000), { now: t + 10_500 });
  assert.ok(validateResponse(gissue, refsCh, decode(encode(refsResponse)), t + 10_500 + 15_000));
  assert.ok(validateResponse(gissue, refsCh, decode(encode(refsResponse)), arrived));
});

test('signed result v4: the wrapper binds the issue, the v2 subject and the observation; any change is refused', () => {
  const { jobs, signer, record } = setup(), job = jobs.trivy, c = claim();
  const issue = makeIssue(job, facts(job, c), null, { sourceAcceptanceRef: record.accepted.sourceAcceptanceRef, hostQualificationRef: record.accepted.hostQualificationRef, expiresAt: iso(Date.now() + 600_000) });
  const wrapper = signedWrapper(issue, trivyObservation(job), signer);
  const verified = verifySignedBridgeResult({ issue, wrapper, signers: record.signers });
  assert.equal(verified.payload.subject.attempt, 1);
  assert.equal(verified.payload.conclusion, 'success');
  const changed = { ...wrapper, observation: { ...wrapper.observation, sourceSha: 'd'.repeat(40) } };
  assert.throws(() => verifySignedBridgeResult({ issue, wrapper: changed, signers: record.signers }), { code: 'SIGNED_FORMAL_OBSERVATION_CHANGED' });
  assert.throws(() => verifySignedBridgeResult({ issue, wrapper: { ...wrapper, contract: 'clued.independent-ci.protected-job-result/1' }, signers: record.signers }), { code: 'SIGNED_BRIDGE_RESULT_BINDING_REQUIRED' });
  const v1Obs = { ...trivyObservation(job), contract: 'clued.independent-ci.formal-scanner-observation/1' };
  assert.throws(() => observationFacts(issue, v1Obs), { code: 'ACTUAL_FORMAL_PROFILE_REQUIRED' });
});

// PR-A x PR-B: the Source v2 placement path accepts exactly the two reviewed contract-placement.yml
// versions (fixture bytes, never the working tree) in role policy v3 and in the v4 signed result.
function placementObservation(job, workflowSha256) {
  const now = Date.now(), log = () => ({ sha256: hex(32), bytes: 10, truncated: false });
  return { contract: 'clued.independent-ci.formal-check-observation/2', domain: 'production-observation', fixture: false, profile: 'required-contract-placement/1',
    subject: Object.fromEntries(['id', 'repo', 'pr', 'headSha', 'baseSha', 'role', 'sourceManifestSha256', 'attempt'].map(k => [k, job[k]])),
    sourceSha: 'c'.repeat(40), sourceTreeSha: 'd'.repeat(40), candidateTreeSha: 'e'.repeat(40), sourceManifestSha256: job.sourceManifestSha256, workflowSha256,
    image: 'sha256:' + hex(32), imageId: 'sha256:' + hex(32), runtimeIdentity: 'turing-linux', hostAcceptanceRef: randomUUID(), sourceAcceptanceRef: randomUUID(),
    nonce: hex(32), requestSha256: hex(32), headBasePackSha256: hex(32), commandSequenceSha256: hex(32), toolPinsSha256: hex(32), preAdmissionSha256: hex(32), postAdmissionSha256: hex(32),
    conclusion: 'success', exitCode: 0, startedAt: iso(now - 20_000), finishedAt: iso(now - 10_000), logs: { stdout: log(), stderr: log() },
    cleanup: { complete: true, wholeContainerTreeStopped: true, containerRemoved: true, observedAt: iso(now - 5_000) },
    evidenceClass: 'unsigned-observation-requires-protected-result-issuer', formalEligible: false, checksWritten: false, qualificationIssued: false };
}
test('placement (Source v2): policy v3 and the v4 signed result accept both reviewed contract-placement.yml versions and nothing else', () => {
  const accepted = acceptedSha256s(PLACEMENT_WORKFLOW), other = hex(32);
  const { jobs, record } = setup(), job = jobs['contract-placement'], c = claim();
  const issue = makeIssue(job, facts(job, c), null, { sourceAcceptanceRef: record.accepted.sourceAcceptanceRef, hostQualificationRef: record.accepted.hostQualificationRef, expiresAt: iso(Date.now() + 600_000) });
  for (const workflowSha256 of accepted) assert.equal(observationFacts(issue, placementObservation(job, workflowSha256)).exitCode, 0);
  for (const workflowSha256 of [other, acceptedSha256s('.github/workflows/gitleaks.yml')[1]]) {
    assert.throws(() => observationFacts(issue, placementObservation(job, workflowSha256)), { code: 'ACTUAL_PLACEMENT_EVIDENCE_REQUIRED' });
  }
  const tools = { node: { path: '/usr/local/bin/node', sha256: hex(32) }, python: { path: '/usr/bin/python3', sha256: hex(32) }, git: { path: '/usr/bin/git', sha256: hex(32) },
    esbuildJs: { path: '/opt/esbuild/lib/main.js', sha256: hex(32) }, esbuildBinary: { path: '/opt/esbuild/bin/esbuild', sha256: hex(32) } };
  const refs = { runtimeIdentity: 'turing-linux', sourceAcceptanceRef: randomUUID(), hostAcceptanceRef: randomUUID() }, image = 'sha256:' + hex(32);
  const selected = workflowSha256 => {
    const manifestBytes = Buffer.from(canonical({ schema: 'independent-ci.sources.v2', repo: REPO, sourceSha: 'c'.repeat(40), roles: { 'contract-placement': {
      formalContractPlacement: { profile: 'required-contract-placement/1', workflowSha256, esbuildVersion: '0.28.1', tools },
      sourceFiles: requiredSourcePaths('contract-placement').map(p => ({ path: p, sha256: hex(32) })) } } }));
    const placement = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: sha(manifestBytes), createdAt: iso(Date.now() - 1000), attempt: 1 })['contract-placement'];
    const config = { schema: 'independent-ci.linux-policy.v3', role: 'contract-placement', formalEnabled: true, sourceManifestSha256: sha(manifestBytes), nodeExecutable: LINUX_NODE_V2,
      dockerRootDirectory: '/var/lib/docker', containerUser: '65532:65532', executionMode: 'node-entry', image, containerNodeExecutable: tools.node.path, containerNodeSha256: tools.node.sha256, ...refs };
    const qualification = { payload: { schema: 'independent-ci.runtime-qualification.v2', fixture: false, image, sourceManifestSha256: sha(manifestBytes), ...refs, qualifiedAt: iso(Date.now() - 1000), expiresAt: null } };
    return () => validateSelectedFacts(placement, { config, sourceManifestBytes: manifestBytes, qualification });
  };
  for (const workflowSha256 of accepted) assert.equal(selected(workflowSha256)().config.role, 'contract-placement');
  for (const workflowSha256 of [other, null]) assert.throws(selected(workflowSha256), { code: 'FIXED_CONTRACT_TOOLS_IMAGE_REQUIRED' });
});

// ---- the Windows issuer engine against a simulated Linux party over fixture mailboxes ----
async function spool(t) {
  const root = await tempDir(t, 'clued-v2-spool-');
  for (const d of ['incoming', 'outgoing']) await fs.mkdir(path.join(root, d));
  return root;
}
async function put(root, name, bytes) {
  await fs.writeFile(path.join(root, 'incoming', `${name}.json`), bytes, { flag: 'wx' });
  await fs.writeFile(path.join(root, 'incoming', `${name}.ready.json`), canonical({ bytes: bytes.length, contract: 'clued.independent-ci.complete-public-file/1', sha256: sha(bytes) }), { flag: 'wx' });
}
async function waitFor(file, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) { try { return await fs.readFile(file); } catch (e) { if (e.code !== 'ENOENT' || Date.now() > until) throw e; } await new Promise(r => setTimeout(r, 50)); }
}
function issuerFixture(t, { evaluate, job = 'trivy' } = {}) {
  const s = setup(), c = claim(), j = s.jobs[job];
  let live = true;
  const context = createWindowsContext({ inputs: { jobs: [j], record: s.record }, policyText: '{}', sourceRoot: 'C:\\fixture', live: () => { if (!live) throw Object.assign(new Error('HELD_RECORD_LEASE_LOST'), { code: 'HELD_RECORD_LEASE_LOST' }); } });
  return { ...s, c, job: j, context, evaluate: evaluate ?? (async () => facts(j, c)), stop: () => { live = false; } };
}

const rejectedIssuerFacts = () => ({ contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false,
  reason: 'full_admission_rejected', diagnostic: { verdict: 'REJECTED', nativeVerdict: 'REJECTED', ownerReviewKind: 'refused',
    reasonCodes: ['owner_grant_required', 'sensitive-details-must-not-survive'], nativeReasonCodes: ['path_outside_write_set'],
    phase: 'native', workflowGateFindingsPresent: true, rawBody: 'sensitive-details-must-not-survive' } });
const expectedIssuerDiagnostic = () => ({ verdict: 'REJECTED', nativeVerdict: 'REJECTED', ownerReviewKind: 'refused',
  reasonCodes: ['owner_grant_required', 'unknown_reason'], nativeReasonCodes: ['path_outside_write_set'], phase: 'native', workflowGateFindingsPresent: true });

test('issuer diagnostics: complete rejection before issue retains its sanitized Native reason', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t); let writes = 0;
  const r = await runIssuer({ context: f.context, evaluate: async () => rejectedIssuerFacts(), collect: async () => null,
    box: { async lock() {}, async write() { writes++; } }, stageDeadline: Date.now() + 60_000 });
  assert.deepEqual([r.status, r.reason, r.sideEffects, writes], ['BLOCKED', 'full_admission_rejected', 0, 0]);
  assert.deepEqual(r.admissionDiagnostic, expectedIssuerDiagnostic());
});

test('issuer diagnostics: complete callback rejection keeps UNCERTAIN and the exact sanitized rejection context', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t); let n = 0, issue; const writes = [];
  const box = { async lock() {}, async write(name, bytes) { writes.push(name); if (name === 'issue') issue = decode(bytes); },
    async read(name) { if (name === 'challenge-01') return encode(makeChallenge(issue, 'scan-start', 1));
      throw Object.assign(new Error('not present'), { code: 'ENOENT' }); } };
  const r = await runIssuer({ context: f.context, evaluate: async () => ++n === 1 ? facts(f.job, f.c) : rejectedIssuerFacts(),
    collect: async () => null, box, stageDeadline: Date.now() + 60_000 });
  assert.deepEqual([r.status, r.reason, r.sideEffects, n, writes], ['UNCERTAIN', 'full_admission_rejected', 1, 2, ['issue']]);
  assert.deepEqual(r.admissionDiagnostic, expectedIssuerDiagnostic());
});

test('issuer: one admission callback, then the signed result -> ISSUED_RESULT_RECEIVED; the protocol is driven for real', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1)));
    const response = decode(await waitFor(path.join(root, 'outgoing', 'response-01.json')));
    assert.equal(response.admission.claimId, f.c.claimId);
    await put(root, 'result', Buffer.from(canonical(signedWrapper(issue, trivyObservation(f.job), f.signer))));
  })();
  const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.equal(r.status, ISSUER_SUCCESS);
  assert.equal(r.sideEffects, 1);
  await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'response-02.json')), { code: 'ENOENT' });
});

test('issuer, local scan-start mode: an admission round, then the signed result -> ISSUED_RESULT_RECEIVED without any Native start', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'admission', 1)));
    const response = decode(await waitFor(path.join(root, 'outgoing', 'response-01.json')));
    assert.equal(response.admission.claimId, f.c.claimId); assert.equal(response.scanStart, null);
    await put(root, 'result', Buffer.from(canonical(signedWrapper(issue, trivyObservation(f.job), f.signer))));
  })();
  let nativeCalls = 0;
  const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000,
    nativeScanStartRequired: false, scanStart: async () => { nativeCalls++; throw new Error('never called in local mode'); } });
  await linux;
  assert.equal(r.status, ISSUER_SUCCESS, JSON.stringify(r)); assert.equal(r.sideEffects, 1); assert.equal(nativeCalls, 0);
});
test('issuer: a scan-start mode that is not a boolean is refused before anything is issued', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  for (const mode of ['false', 0, null]) {
    const f = issuerFixture(t), root = await spool(t), box = await createFixtureMailbox(root, 'windows');
    const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000, nativeScanStartRequired: mode });
    assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', 'SCAN_START_MODE_INVALID', 0]);
    await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'issue.json')), { code: 'ENOENT' }, 'nothing was issued');
  }
});

test('issuer: the Linux clean blocked record ends the stage BLOCKED with zero side effects (refs moved since the bundle)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => { const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json'))); await put(root, 'blocked', encode(makeBlocked(issue, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'))); })();
  const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 0]);
  // any other clean Linux refusal is final for the attempt, never a pass-through of untrusted text
  assert.equal(blockedReason('ANYTHING_ELSE'), 'LINUX_PREPARATION_REFUSED');
});

test('issuer: an answer that would be late writes no response and waits for the worker\'s clean blocked record (no UNCERTAIN)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0;
  const f = issuerFixture(t);
  // The callback admission takes longer than the round allows (PR #889 stage 2 attempt 2: about 30 s against 30 s).
  const evaluate = async () => { if (++n > 1) await new Promise(r => setTimeout(r, 2500)); return facts(f.job, f.c); };
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    const challenge = makeChallenge(issue, 'scan-start', 1, { deadline: new Date(Date.now() + 1500).toISOString() });
    await put(root, 'challenge-01', encode(challenge));
    await new Promise(r => setTimeout(r, 3500));
    await put(root, 'blocked', encode(makeBlocked(issue, 'BRIDGE_CALLBACK_DEADLINE')));
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects, n], ['BLOCKED', 'BRIDGE_CALLBACK_DEADLINE', 0, 2], 'the callback admission ran, then nothing was answered');
  await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'response-01.json')), { code: 'ENOENT' });
});

test('issuer: a stale callback admission (slow host, not a refusal) is evaluated again in full; a fresh one answers', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0;
  const f = issuerFixture(t);
  const evaluate = async () => (++n === 2 ? { status: 'BLOCKED', reason: 'full_admission_observation_expired' } : facts(f.job, f.c));
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1)));
    await waitFor(path.join(root, 'outgoing', 'response-01.json'));
    await put(root, 'result', Buffer.from(canonical(signedWrapper(issue, trivyObservation(f.job), f.signer))));
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, n], [ISSUER_SUCCESS, 4], 'issue, stale callback, fresh callback, final admission');
});

test('issuer: a callback admission still stale after three evaluations is late, never UNCERTAIN; other refusals still are', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0;
  const f = issuerFixture(t);
  const evaluate = async () => (++n === 1 ? facts(f.job, f.c) : { status: 'BLOCKED', reason: 'full_admission_observation_expired' });
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1)));
    await new Promise(r => setTimeout(r, 1500));
    await put(root, 'blocked', encode(makeBlocked(issue, 'BRIDGE_CALLBACK_DEADLINE')));
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects, n], ['BLOCKED', 'BRIDGE_CALLBACK_DEADLINE', 0, 4]);
  await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'response-01.json')), { code: 'ENOENT' });
});

// full_admission_unavailable: the admission caught an exception, here in its Native phase (PR #894 stage 6, 2026-10-21).
const UNAVAILABLE = Object.freeze({ status: 'BLOCKED', reason: 'full_admission_unavailable', diagnostic: Object.freeze({ phase: 'native' }) });
const STALE = Object.freeze({ status: 'BLOCKED', reason: 'full_admission_observation_expired' });
const gaveUp = evaluations => ({ transientAdmission: 'full_admission_unavailable', evaluations, phase: 'native' });
// Records the issuer's backoff waits (1 s and more; its polling sleeps 100 ms). Unless `real`, a wait lasts 20 ms.
const backoffSleep = (waits, { real = false, onWait = () => {} } = {}) => ms => {
  if (ms >= 1000) { waits.push(ms); onWait(ms); }
  return new Promise(r => setTimeout(r, ms >= 1000 && !real ? 20 : ms));
};
const waitUntil = async (done, ms = 8000) => { for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise(r => setTimeout(r, 20)); };
// The first admission keeps one callback window of the stage for the Linux side.
const FIRST_RESERVE_MS = CALLBACK_WINDOW_MS;

test('issuer: an unavailable admission is evaluated again after a short backoff; the fresh ADMITTED answers (callback and final admission)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), given = [], waits = [];
  const plan = ['admitted', 'unavailable', 'admitted', 'unavailable', 'admitted']; // issue, callback x2, final x2
  const evaluate = async () => { const v = plan[given.length] === 'unavailable' ? UNAVAILABLE : facts(f.job, f.c); given.push(v); return v; };
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1)));
    const response = decode(await waitFor(path.join(root, 'outgoing', 'response-01.json')));
    assert.equal(response.admission.observationSha256, given[2].observationSha256, 'the answer is the evaluation after the retry');
    assert.notEqual(response.admission.observationSha256, given[0].observationSha256);
    await put(root, 'result', Buffer.from(canonical(signedWrapper(issue, trivyObservation(f.job), f.signer))));
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, sleep: backoffSleep(waits), stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.sideEffects, given.length, waits, r.admissionDiagnostic], [ISSUER_SUCCESS, 1, 5, [1000, 1000], undefined]);
});

test('issuer: a callback admission unavailable until the round deadline answers nothing; the worker\'s clean blocked record ends the stage (no UNCERTAIN)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0;
  const f = issuerFixture(t), waits = [];
  const evaluate = async () => (++n === 1 ? facts(f.job, f.c) : UNAVAILABLE);
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    const deadline = Date.now() + 2950;
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1, { deadline: iso(deadline) })));
    await new Promise(r => setTimeout(r, deadline + 300 - Date.now()));
    await put(root, 'blocked', encode(makeBlocked(issue, 'BRIDGE_CALLBACK_DEADLINE')));
  })();
  // Real waits: the 1 s one ends inside the round (the first callback evaluation has about 1.9 s to start), the 2 s
  // one would end past its deadline and is not taken.
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, sleep: backoffSleep(waits, { real: true }), stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects, n, waits], ['BLOCKED', 'BRIDGE_CALLBACK_DEADLINE', 0, 3, [1000]]);
  assert.deepEqual(r.admissionDiagnostic, gaveUp(2), 'the outcome record keeps why the round went late');
  await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'response-01.json')), { code: 'ENOENT' });
});

test('issuer: a callback admission still unavailable after four evaluations (waits 1, 2, 4 s) is late, with time left in the round', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0;
  const f = issuerFixture(t), waits = [];
  const evaluate = async () => (++n === 1 ? facts(f.job, f.c) : UNAVAILABLE);
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1)));
    await waitUntil(() => n >= 5);
    await put(root, 'blocked', encode(makeBlocked(issue, 'BRIDGE_CALLBACK_DEADLINE')));
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, sleep: backoffSleep(waits), stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects, n, waits, r.admissionDiagnostic], ['BLOCKED', 'BRIDGE_CALLBACK_DEADLINE', 0, 5, [1000, 2000, 4000], gaveUp(4)]);
  await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'response-01.json')), { code: 'ENOENT' });
});

test('issuer: a refusal is final at once, also right after an unavailable evaluation (UNCERTAIN after the issue, as before)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  for (const refusal of [{ status: 'BLOCKED', reason: 'full_admission_rejected' }, { status: 'BLOCKED', reason: 'full_admission_claim_changed' }, { status: 'BLOCKED' }]) {
    let n = 0;
    const f = issuerFixture(t), waits = [];
    const evaluate = async () => (++n === 1 ? facts(f.job, f.c) : n === 2 ? UNAVAILABLE : refusal);
    const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
    const linux = (async () => { const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json'))); await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1))); })();
    const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, sleep: backoffSleep(waits), stageDeadline: Date.now() + 10_000 });
    await linux;
    assert.deepEqual([r.status, r.reason, r.sideEffects, n, waits, r.admissionDiagnostic], ['UNCERTAIN', refusal.reason ?? 'ACTUAL_NATIVE_ADMISSION_REQUIRED', 1, 3, [1000], undefined]);
    await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'response-01.json')), { code: 'ENOENT' });
  }
});

test('issuer: both transient reasons share one evaluation counter; the final admission gives up UNCERTAIN; a lease lost in a wait fails at once', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  // seq[i] is the i-th evaluation (0 = before the issue). The Linux party sends the result once response-01 exists,
  // else (no answer within 1.5 s) its clean blocked record.
  const run = async (seq, { onWait } = {}) => {
    let n = 0;
    const f = issuerFixture(t), waits = [];
    const evaluate = async () => { const v = seq[n++] ?? 'admitted'; return v === 'stale' ? STALE : v === 'unavailable' ? UNAVAILABLE : facts(f.job, f.c); };
    const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
    const linux = (async () => {
      const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
      await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1)));
      const answered = await waitFor(path.join(root, 'outgoing', 'response-01.json'), 1500).then(() => true, () => false);
      await put(root, answered ? 'result' : 'blocked', answered ? Buffer.from(canonical(signedWrapper(issue, trivyObservation(f.job), f.signer))) : encode(makeBlocked(issue, 'BRIDGE_CALLBACK_DEADLINE')));
    })();
    const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, sleep: backoffSleep(waits, { onWait: () => onWait?.(f) }), stageDeadline: Date.now() + 20_000 });
    await linux;
    return { r, n, waits, responded: await fs.lstat(path.join(root, 'outgoing', 'response-01.json')).then(() => true, () => false) };
  };
  // stale (no wait), then unavailable as the 2nd evaluation of the callback admission: its 2nd wait (2 s), then ADMITTED
  let x = await run(['admitted', 'stale', 'unavailable', 'admitted']);
  assert.deepEqual([x.r.status, x.n, x.waits, x.responded], [ISSUER_SUCCESS, 5, [2000], true]);
  // unavailable, unavailable, then stale as the 3rd evaluation: stale has no 3rd wait, so the round gives up (late)
  x = await run(['admitted', 'unavailable', 'unavailable', 'stale']);
  assert.deepEqual([x.r.status, x.r.reason, x.n, x.waits, x.responded, x.r.admissionDiagnostic],
    ['BLOCKED', 'BRIDGE_CALLBACK_DEADLINE', 4, [1000, 2000], false, { transientAdmission: 'full_admission_observation_expired', evaluations: 3 }]);
  // after the result: the final admission retries, then fails UNCERTAIN (the result is in hand, the admission is not)
  x = await run(['admitted', 'admitted', 'unavailable', 'unavailable', 'unavailable', 'unavailable']);
  assert.deepEqual([x.r.status, x.r.reason, x.r.sideEffects, x.n, x.waits, x.r.admissionDiagnostic], ['UNCERTAIN', 'full_admission_unavailable', 1, 6, [1000, 2000, 4000], gaveUp(4)]);
  // the held lease ends during a wait: the next evaluation never runs
  x = await run(['admitted', 'unavailable', 'admitted'], { onWait: f => f.stop() });
  assert.deepEqual([x.r.status, x.r.reason, x.n, x.waits, x.responded], ['UNCERTAIN', 'HELD_RECORD_LEASE_LOST', 2, [1000], false]);
});

test('issuer: the first admission retries an unavailable evaluation while a callback window of the stage is left; still unavailable, nothing is issued (clean BLOCKED)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0;
  const a = issuerFixture(t), waitsA = [], rootA = await spool(t);
  const linux = (async () => { const issue = decode(await waitFor(path.join(rootA, 'outgoing', 'issue.json'))); await put(rootA, 'blocked', encode(makeBlocked(issue, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'))); })();
  const rA = await runIssuer({ context: a.context, evaluate: async () => (++n === 1 ? UNAVAILABLE : facts(a.job, a.c)), collect: async () => null,
    box: await createFixtureMailbox(rootA, 'windows'), sleep: backoffSleep(waitsA), stageDeadline: Date.now() + FIRST_RESERVE_MS + 20_000 });
  await linux;
  assert.deepEqual([rA.status, rA.reason, rA.sideEffects, n, waitsA, rA.admissionDiagnostic], ['BLOCKED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 0, 2, [1000], undefined], 'issued after one retry');

  // [stage window, evaluations, waits, evaluation result, outcome diagnostic]; a phase that is not a plain string is dropped
  for (const [window, evaluations, expected, result = UNAVAILABLE, diagnostic = gaveUp(evaluations)] of [[FIRST_RESERVE_MS + 20_000, 4, [1000, 2000, 4000]],
    [FIRST_RESERVE_MS + 2000, 2, [1000]], [20_000, 1, []],
    [FIRST_RESERVE_MS + 20_000, 4, [1000, 2000, 4000], { ...UNAVAILABLE, diagnostic: { phase: ['native'] } }, { transientAdmission: 'full_admission_unavailable', evaluations: 4 }]]) {
    let m = 0;
    const b = issuerFixture(t), waits = [], root = await spool(t);
    const r = await runIssuer({ context: b.context, evaluate: async () => { m += 1; return result; }, collect: async () => null,
      box: await createFixtureMailbox(root, 'windows'), sleep: backoffSleep(waits), stageDeadline: Date.now() + window });
    assert.deepEqual([r.status, r.reason, r.sideEffects, m, waits, r.admissionDiagnostic], ['BLOCKED', 'full_admission_unavailable', 0, evaluations, expected, diagnostic], `stage window ${window} ms`);
    await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'issue.json')), { code: 'ENOENT' });
  }
  // a real refusal after an unavailable first evaluation is final as before: nothing issued
  let k = 0;
  const c = issuerFixture(t), waitsC = [], rootC = await spool(t);
  const rC = await runIssuer({ context: c.context, evaluate: async () => (++k === 1 ? UNAVAILABLE : { status: 'BLOCKED', reason: 'full_admission_claim_changed' }), collect: async () => null,
    box: await createFixtureMailbox(rootC, 'windows'), sleep: backoffSleep(waitsC), stageDeadline: Date.now() + FIRST_RESERVE_MS + 20_000 });
  assert.deepEqual([rC.status, rC.reason, rC.sideEffects, k, waitsC, rC.admissionDiagnostic], ['BLOCKED', 'full_admission_claim_changed', 0, 2, [1000], undefined]);
  await assert.rejects(fs.lstat(path.join(rootC, 'outgoing', 'issue.json')), { code: 'ENOENT' });
});

test('issuer evaluate: a failed changed-paths read is unavailable (retried), a PR that moved is the subject change, a refusal is its own reason; otherwise the complete admission runs', async () => {
  const job = { id: 'job' }, batchClaim = { claimId: 'c' }, packet = { complete: true, paths: ['a.txt'] }, calls = [];
  const admission = { evaluatePr: async (...args) => { calls.push(args); return { status: 'ADMITTED', marker: 1 }; } };
  const throwing = code => ({ readChangedPaths: async () => { throw code === undefined ? undefined : Object.assign(new Error(code), { code }); } });
  for (const code of ['github_transport_unconfirmed', 'github_http_502', 'github_http_429', undefined]) {
    assert.deepEqual(await issuerEvaluate({ github: throwing(code), admission, job, batchClaim })(),
      { status: 'BLOCKED', reason: 'full_admission_unavailable', diagnostic: { phase: 'changed_paths' } }, String(code));
  }
  // the port's own refusal and GitHub's 403 are no longer unavailable (DESIGN §7.8 review, MINOR; Task 576231fa)
  for (const [code, reason] of [['pr_files_changed', 'full_admission_paths_refused'], ['invalid_pr_files', 'full_admission_paths_refused'], ['github_http_403', 'full_admission_github_forbidden']]) {
    assert.deepEqual(await issuerEvaluate({ github: throwing(code), admission, job, batchClaim })(),
      { status: 'BLOCKED', reason, diagnostic: { phase: 'changed_paths' } }, code);
  }
  assert.deepEqual(await issuerEvaluate({ github: throwing('pr_subject_changed'), admission, job, batchClaim })(),
    { status: 'BLOCKED', reason: 'full_admission_subject_changed', diagnostic: { phase: 'changed_paths' } });
  assert.equal(calls.length, 0, 'no admission without the changed paths');
  const read = [];
  const ok = await issuerEvaluate({ github: { readChangedPaths: async j => { read.push(j); return packet; } }, admission, job, batchClaim })();
  assert.deepEqual([ok, read, calls], [{ status: 'ADMITTED', marker: 1 }, [job], [[job, packet, { batchClaim }]]]);
});

test('issuer: a changed-paths read that fails once in a callback round is retried and answered (through issuerEvaluate)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), waits = [];
  let reads = 0;
  // read 1: the issue; read 2: the callback, GitHub down after the port's own retries; read 3: the callback again; read 4: the final admission
  const github = { readChangedPaths: async () => { if (++reads === 2) throw Object.assign(new Error('github_transport_unconfirmed'), { code: 'github_transport_unconfirmed' }); return PACKET; } };
  const admission = { evaluatePr: async () => facts(f.job, f.c) };
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1)));
    await waitFor(path.join(root, 'outgoing', 'response-01.json'));
    await put(root, 'result', Buffer.from(canonical(signedWrapper(issue, trivyObservation(f.job), f.signer))));
  })();
  const r = await runIssuer({ context: f.context, evaluate: issuerEvaluate({ github, admission, job: f.job, batchClaim: null }), collect: async () => null, box,
    sleep: backoffSleep(waits), stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, reads, waits, r.admissionDiagnostic], [ISSUER_SUCCESS, 4, [1000], undefined]);
});

test('issuer: a final admission that ends past the issue window is not a success (UNCERTAIN BRIDGE_RESULT_DEADLINE)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0, skew = 0;
  const f = issuerFixture(t);
  const clock = () => Date.now() + skew;
  // evaluation 3 is the admission after the result; it returns ADMITTED but only after the issue's expiresAt
  const evaluate = async () => { if (++n === 3) skew = 60_000; return facts(f.job, f.c); };
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1)));
    await waitFor(path.join(root, 'outgoing', 'response-01.json'));
    await put(root, 'result', Buffer.from(canonical(signedWrapper(issue, trivyObservation(f.job), f.signer))));
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, clock, stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects, n], ['UNCERTAIN', 'BRIDGE_RESULT_DEADLINE', 1, 3]);
});

test('issuer: a challenge relayed only after its deadline is late (no admission, no response, no UNCERTAIN)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0;
  const f = issuerFixture(t);
  const evaluate = async () => { n += 1; return facts(f.job, f.c); };
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    const challenge = makeChallenge(issue, 'scan-start', 1, { deadline: new Date(Date.now() + 300).toISOString() });
    await new Promise(r => setTimeout(r, 700));
    await put(root, 'challenge-01', encode(challenge));
    await new Promise(r => setTimeout(r, 700));
    await put(root, 'blocked', encode(makeBlocked(issue, 'BRIDGE_CALLBACK_DEADLINE')));
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects, n], ['BLOCKED', 'BRIDGE_CALLBACK_DEADLINE', 0, 1]);
  await assert.rejects(fs.lstat(path.join(root, 'outgoing', 'response-01.json')), { code: 'ENOENT' });
});

test('issuer: an expired challenge that was never valid (created before the issue) is UNCERTAIN, never late', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0;
  const f = issuerFixture(t);
  const evaluate = async () => { n += 1; return facts(f.job, f.c); };
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    const challenge = makeChallenge(issue, 'scan-start', 1, { deadline: new Date(Date.now() + 300).toISOString() });
    await new Promise(r => setTimeout(r, 600));
    await put(root, 'challenge-01', encode({ ...challenge, createdAt: new Date(Date.parse(issue.issuedAt) - 1000).toISOString() }));
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, stageDeadline: Date.now() + 5_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects, n], ['UNCERTAIN', 'BRIDGE_CHALLENGE_EXPIRED', 1, 1]);
});

test('issuer: after a late round the wait for the blocked record is two windows; then UNCERTAIN (the worker may have run)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  let n = 0, skew = 0;
  const f = issuerFixture(t);
  const clock = () => Date.now() + skew;
  const evaluate = async () => { if (++n > 1) await new Promise(r => setTimeout(r, 600)); return facts(f.job, f.c); };
  const root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1, { deadline: new Date(Date.now() + 300).toISOString() })));
    await new Promise(r => setTimeout(r, 1500));
    skew = 2 * CALLBACK_WINDOW_MS + 5000;
  })();
  const r = await runIssuer({ context: f.context, evaluate, collect: async () => null, box, clock, stageDeadline: Date.now() + 600_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['UNCERTAIN', 'BRIDGE_LATE_BLOCKED_UNCONFIRMED', 1]);
});

test('protocol: one callback round may take up to 120 s (Owner decision dd7378d2), never longer', () => {
  assert.equal(CALLBACK_WINDOW_MS, 120000);
  const { jobs } = setup(), job = jobs.gitleaks, c = claim(), admitted = facts(job, c), now = Date.now();
  const issue = makeIssue(job, admitted, refsSnapshot(now), { sourceAcceptanceRef: randomUUID(), hostQualificationRef: randomUUID(), expiresAt: iso(now + 600_000), now });
  const ch = makeChallenge(issue, 'admission', 1, { now });
  assert.equal(Date.parse(ch.deadline) - Date.parse(ch.createdAt), CALLBACK_WINDOW_MS);
  assert.ok(validateChallenge(issue, ch, now + CALLBACK_WINDOW_MS - 1));
  assert.throws(() => validateChallenge(issue, ch, now + CALLBACK_WINDOW_MS), { code: 'BRIDGE_CHALLENGE_EXPIRED' });
  assert.throws(() => makeChallenge(issue, 'admission', 1, { now, deadline: iso(now + CALLBACK_WINDOW_MS + 1) }), { code: 'BRIDGE_CHALLENGE_EXPIRED' });
  // a response never outlives its challenge's round
  const response = makeResponse(issue, ch, admitted, null, { now });
  assert.ok(Date.parse(response.expiresAt) <= Date.parse(ch.deadline));
});

test('issuer: a refused first admission issues nothing; a claim that moves after the issue is UNCERTAIN, never clean', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const refused = issuerFixture(t, { evaluate: async () => ({ status: 'BLOCKED', reason: 'full_admission_claim_changed' }) });
  const root1 = await spool(t);
  const r1 = await runIssuer({ context: refused.context, evaluate: refused.evaluate, collect: async () => null, box: await createFixtureMailbox(root1, 'windows'), stageDeadline: Date.now() + 5_000 });
  assert.deepEqual([r1.status, r1.reason, r1.sideEffects], ['BLOCKED', 'full_admission_claim_changed', 0]);
  await assert.rejects(fs.lstat(path.join(root1, 'outgoing', 'issue.json')), { code: 'ENOENT' });

  let n = 0;
  const moved = issuerFixture(t);
  const evaluate = async () => (++n === 1 ? facts(moved.job, moved.c) : { status: 'BLOCKED', reason: 'full_admission_claim_changed' });
  const root2 = await spool(t), box2 = await createFixtureMailbox(root2, 'windows');
  const linux = (async () => { const issue = decode(await waitFor(path.join(root2, 'outgoing', 'issue.json'))); await put(root2, 'challenge-01', encode(makeChallenge(issue, 'scan-start', 1))); })();
  const r2 = await runIssuer({ context: moved.context, evaluate, collect: async () => null, box: box2, stageDeadline: Date.now() + 10_000 });
  await linux;
  assert.deepEqual([r2.status, r2.reason, r2.sideEffects, n], ['UNCERTAIN', 'full_admission_claim_changed', 1, 2], 'a refusal other than staleness is never re-evaluated');
});

test('issuer: no result before the stage window ends is UNCERTAIN (the Linux side may still run); refs failures map to stable reasons', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), root = await spool(t);
  const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: async () => null, box: await createFixtureMailbox(root, 'windows'), stageDeadline: Date.now() + 1200 });
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['UNCERTAIN', 'BRIDGE_RESULT_DEADLINE', 1]);
  assert.equal(refsFailureReason('REFS_SNAPSHOT_CHANGED'), 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  assert.equal(refsFailureReason('REFS_PR_SUBJECT_CHANGED'), 'full_admission_subject_changed');
  assert.equal(refsFailureReason('REFS_HTTP_UNCONFIRMED'), 'REMOTE_REFS_REFUSED');
  assert.equal(refsFailureReason('REFS_HTTP_503'), 'REMOTE_REFS_UNAVAILABLE');
  // gitleaks: a refs observation that saw a push fails before anything is issued
  const g = issuerFixture(t, { job: 'gitleaks' }), root2 = await spool(t);
  const r2 = await runIssuer({ context: g.context, evaluate: g.evaluate, collect: async () => { throw Object.assign(new Error('REFS_SNAPSHOT_CHANGED'), { code: 'REFS_SNAPSHOT_CHANGED' }); }, box: await createFixtureMailbox(root2, 'windows'), stageDeadline: Date.now() + 5_000 });
  assert.deepEqual([r2.status, r2.reason, r2.sideEffects], ['BLOCKED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 0]);
});

test('linux worker v4: only an adapter BLOCKED that started nothing is a clean blocked record; codes are normalised', () => {
  assert.equal(isCleanBlocked({ status: 'BLOCKED', sideEffectsMayHaveStarted: false }), true);
  assert.equal(isCleanBlocked({ status: 'BLOCKED', sideEffectsMayHaveStarted: true }), false);
  assert.equal(isCleanBlocked({ status: 'BLOCKED', sideEffectsMayHaveStarted: false, snapshotRetained: true }), false);
  assert.equal(isCleanBlocked({ status: 'UNCERTAIN', sideEffectsMayHaveStarted: false }), false);
  assert.equal(cleanBlockedReason('REMOTE_REFS_CHANGED_SINCE_BUNDLE'), 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  assert.equal(cleanBlockedReason('FORMAL_MAILBOX_WAIT_UNCONFIRMED'), 'BRIDGE_CALLBACK_DEADLINE');
  assert.equal(cleanBlockedReason('weird text'), 'LINUX_PREPARATION_REFUSED');
});

test('trivy v4: a BLOCKED cache is a clean blocked record under its own reason; any other cache outcome stays uncertain', () => {
  // 2026-10-21, batch ed9dc331: the cache root was read-only in the worker unit (EROFS on prepare.lock). The
  // refusal lacked sideEffectsMayHaveStarted, so the bridge dropped its reason as ACTUAL_SCANNER_OBSERVATION_MISSING
  // and the batch halted UNCERTAIN although no scanner had run.
  const subject = { repo: REPO, pr: 1 }, at = '2026-10-21T12:00:00.000Z';
  const blocked = cacheRefusal({ status: 'BLOCKED', reason: 'EROFS', phase: 'PREPARATION', observations: [] }, subject, at);
  assert.equal(blocked.clean, true);
  assert.equal(blocked.file, 'cache-blocked.json');
  assert.equal(isCleanBlocked(blocked.result), true);
  assert.equal(cleanBlockedReason(blocked.result.reason), 'EROFS');
  assert.deepEqual(blocked.record, { contract: 'clued.independent-ci.formal-trivy-cache-refusal/1', subject, cacheStatus: 'BLOCKED',
    reason: 'EROFS', phase: 'PREPARATION', cacheContainerRuns: 0, snapshotRemoved: true, observedAt: at });
  canonical(blocked.record); // the run-directory record is always serialisable, whatever the cache returned
  const unnamed = cacheRefusal({ status: 'BLOCKED' }, subject, at);
  assert.equal(unnamed.result.reason, 'CACHE_PREPARATION_REFUSED');
  assert.deepEqual([unnamed.record.phase, unnamed.record.cacheContainerRuns], [null, null]);
  canonical(unnamed.record);
  for (const cache of [{ status: 'UNCERTAIN', reason: 'DB_EXECUTION_OR_CLEANUP_UNKNOWN' }, { status: 'WEIRD' }, null]) {
    const refusal = cacheRefusal(cache, subject, at);
    assert.equal(refusal.clean, false);
    assert.equal(refusal.file, 'uncertain.json');
    assert.deepEqual([refusal.result.status, refusal.result.sideEffectsMayHaveStarted, refusal.result.snapshotRetained], ['UNCERTAIN', true, true]);
    assert.equal(isCleanBlocked(refusal.result), false);
    canonical(refusal.record);
  }
});

test('qualification v2 and role policy v3 (S6, S10): no claim anywhere, the pinned toolchain node, expiresAt null = until Source change', () => {
  const { jobs } = setup();
  const pins = requiredSourcePaths('gitleaks').map(p => ({ path: p, sha256: hex(32) }));
  const manifestBytes = Buffer.from(canonical({ schema: 'independent-ci.sources.v2', repo: REPO, sourceSha: 'c'.repeat(40), roles: { gitleaks: {
    containerCommand: { image: GITLEAKS_IMAGE, scanner: 'gitleaks', executable: '/usr/bin/gitleaks', args: [...SCAN_ARGS], cwd: '/input' },
    hostTools: { python: { path: '/usr/bin/python3.12', sha256: hex(32) } }, sourceFiles: pins } } }));
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: sha(manifestBytes), createdAt: iso(Date.now() - 1000), attempt: 2 }).gitleaks;
  const refs = { runtimeIdentity: 'turing-linux', sourceAcceptanceRef: randomUUID(), hostAcceptanceRef: randomUUID() };
  const config = { schema: 'independent-ci.linux-policy.v3', role: 'gitleaks', formalEnabled: true, sourceManifestSha256: sha(manifestBytes), nodeExecutable: LINUX_NODE_V2,
    dockerRootDirectory: '/var/lib/docker', containerUser: '65532:65532', memoryBytes: 2147483648, cpus: 2, pids: 128, executionMode: 'scanner', image: GITLEAKS_IMAGE, ...refs };
  const qualification = { payload: { schema: 'independent-ci.runtime-qualification.v2', fixture: false, image: GITLEAKS_IMAGE, sourceManifestSha256: sha(manifestBytes), ...refs, qualifiedAt: iso(Date.now() - 1000), expiresAt: null } };
  const loaded = { config, sourceManifestBytes: manifestBytes, qualification };
  assert.equal(validateSelectedFacts(job, loaded).config.role, 'gitleaks');
  assert.throws(() => validateSelectedFacts(job, { ...loaded, config: { ...config, currentClaim: claim() } }), { code: 'FIXED_ROLE_POLICY_V3_REQUIRED' });
  assert.throws(() => validateSelectedFacts(job, { ...loaded, config: { ...config, nodeExecutable: '/opt/actions-runner/externals/node24/bin/node' } }), { code: 'FIXED_ROLE_POLICY_V3_REQUIRED' });
  assert.throws(() => validateSelectedFacts(job, { ...loaded, config: { ...config, schema: 'independent-ci.linux-policy.v1' } }), { code: 'FIXED_ROLE_SOURCE_CONTEXT_REQUIRED' });
  assert.throws(() => validateSelectedFacts(job, { ...loaded, qualification: { payload: { ...qualification.payload, schema: 'independent-ci.runtime-qualification.v1' } } }), { code: 'ACTUAL_ROLE_QUALIFICATION_REQUIRED' });
  assert.throws(() => validateSelectedFacts(jobs.gitleaks, loaded), { code: 'FIXED_ROLE_SOURCE_CONTEXT_REQUIRED' }); // other Source manifest
  assert.match(FIXED_ROLE_POLICIES.trivy, /roles-v3\/trivy\.json$/);
  // the full policy shape: claim-bound or wrong-node policies are refused before anything else is read
  const shape = { ...config, dockerExecutable: '/usr/bin/docker', dockerEndpoint: 'unix:///run/docker.sock', keyId: 'k', gitExecutable: '/usr/bin/git', entryFile: '/opt/x/linux-worker.mjs',
    sourceManifestFile: '/etc/clued-independent-ci/formal-source-manifest-v2.json', publicKeyFile: '/etc/clued-independent-ci/result.pub', qualificationFile: '/etc/clued-independent-ci/q.json',
    signingKeyFile: '/etc/clued-independent-ci/result.key', workspaceRoot: '/var/lib/clued-independent-ci/workspaces', runsRoot: '/var/lib/clued-independent-ci/runs', trustedSourceDirectory: '/opt/clued-independent-ci/source-v2' };
  assert.doesNotThrow(() => validatePolicyShape(shape));
  assert.throws(() => validatePolicyShape({ ...shape, currentClaim: claim() }), { code: 'CLAIM_BOUND_POLICY_REFUSED' });
  assert.throws(() => validatePolicyShape({ ...shape, nodeExecutable: '/opt/actions-runner/externals/node24/bin/node' }), { code: 'PINNED_TOOLCHAIN_NODE_REQUIRED' });
  assert.equal(qualificationDeadline({ expiresAt: null }), Infinity);
  const pub = Buffer.from('fixture-public-key');
  const q = { schema: 'independent-ci.runtime-qualification.v2', fixture: false, runtimeIdentity: refs.runtimeIdentity, sourceManifestSha256: config.sourceManifestSha256, image: GITLEAKS_IMAGE,
    entrySha256: 'e', qualificationSha256: 'q', executionMode: 'scanner', workerSha256: 'w', proofSha256: 'p', jobSha256: 'j', nodeExecutable: LINUX_NODE_V2, keyId: 'k', resultPublicKeySha256: sha(pub),
    isolation: 'root-managed-single-job-container', prCannotReadSignerKey: true, noControllerMounts: true, noCredentials: true, networkDisabled: true, cleanupQualified: true,
    hostAcceptanceRef: refs.hostAcceptanceRef, sourceAcceptanceRef: refs.sourceAcceptanceRef, qualifiedAt: iso(Date.now() - 1000), expiresAt: null };
  const qc = { ...shape, entrySha256: 'e', qualificationSha256: 'q', workerSha256: 'w', proofSha256: 'p', jobSha256: 'j' };
  assert.ok(validateQualificationPayload(q, qc, pub));
  assert.throws(() => validateQualificationPayload({ ...q, currentClaim: claim() }, qc, pub), { code: 'QUALIFICATION_BINDING_REFUSED' });
  assert.throws(() => validateQualificationPayload({ ...q, expiresAt: iso(Date.now() - 1) }, qc, pub), { code: 'QUALIFICATION_EXPIRED' });
});

test('worker-v2 and the placement container entry accept only job contract v2 (attempt 1..2)', async () => {
  const { jobs } = setup({ attempt: 2 });
  assert.ok(validateEntryJob(jobs['contract-placement']));
  assert.throws(() => validateEntryJob({ ...jobs['contract-placement'], attempt: 3 }), { code: 'EXACT_PLACEMENT_JOB_REQUIRED' });
  assert.throws(() => validateEntryJob({ ...jobs['contract-placement'], id: 'f'.repeat(64) }), { code: 'EXACT_PLACEMENT_JOB_REQUIRED' });
  const v1 = { ...jobs.trivy, contract: 'clued.independent-ci.job/1', claimId: randomUUID(), fence: 1, epoch: 1 };
  assert.equal((await runWorkerJob({ job: v1 })).reason, 'INVALID_JOB');
  assert.equal((await runWorkerJob({ job: jobs.trivy })).reason, 'RUNTIME_UNQUALIFIED');
});

test('bridge v4 bundle manifest covers exactly the runtime files and changes with any byte', async t => {
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../worker/protected-job-bridge-v4');
  const m = bridgeManifest(dir), v = JSON.parse(m.text);
  assert.equal(v.contract, BRIDGE_MANIFEST_CONTRACT);
  assert.deepEqual(Object.keys(v.runtimeFiles).sort(), ['boundary.mjs', 'formal-spool-acl.ps1', 'issue-job.mjs', 'linux-worker.mjs', 'mailbox.mjs', 'protocol.mjs', 'relay-public.ps1', 'relay-record.mjs', 'signed-result.mjs', 'windows-issuer.mjs']);
  const copy = await tempDir(t);
  for (const n of Object.keys(v.runtimeFiles)) await fs.copyFile(path.join(dir, n), path.join(copy, n));
  assert.equal(bridgeManifest(copy).sha256, m.sha256);
  await fs.appendFile(path.join(copy, 'protocol.mjs'), '\n');
  assert.notEqual(bridgeManifest(copy).sha256, m.sha256);
});

// ---- refsInStore (lesson b28): a push between the bundle and the scan is a clean, retryable refusal ----
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import { refsInStore } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
const GIT = [String.raw`C:\Program Files\Git\mingw64\libexec\git-core\git.exe`, '/usr/bin/git']
  .find(file => { try { const s = fsSync.lstatSync(file); return s.isFile() && s.nlink === 1; } catch { return false; } }) ?? null;
test('refsInStore: every fresh ref tip, head and base must already be in the workspace store, else REMOTE_REFS_CHANGED_SINCE_BUNDLE', { skip: !GIT && 'no single-link git executable' }, async t => {
  const dir = await tempDir(t, 'clued-v2-refs-');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.invalid' };
  const git = (...a) => { const r = spawnSync(GIT, a, { cwd: dir, env }); if (r.status !== 0) throw new Error(String(r.stderr)); return String(r.stdout).trim(); };
  git('init', '-q', '-b', 'main', '.');
  await fs.writeFile(path.join(dir, 'a.txt'), 'a'); git('add', 'a.txt'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(dir, 'b.txt'), 'b'); git('add', 'b.txt'); git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  const gitSha = sha(await fs.readFile(GIT));
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: head, baseSha: base, testSha: head, sourceManifestSha256: 'e'.repeat(64), createdAt: iso(Date.now() - 1000), attempt: 1 }).gitleaks;
  const snapshot = extra => ({ contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: iso(Date.now()), refs: [{ name: 'refs/heads/main', objectSha: base }, { name: 'refs/heads/pr', objectSha: head }, ...extra] });
  const store = path.join(dir, '.git');
  assert.deepEqual(await refsInStore({ job, remoteSnapshot: snapshot([]), gitDirectory: store, gitExecutable: GIT, expectedGitSha256: gitSha }), { tips: 2, refs: 2 });
  await assert.rejects(refsInStore({ job, remoteSnapshot: snapshot([{ name: 'refs/heads/pushed-later', objectSha: '1'.repeat(40) }]), gitDirectory: store, gitExecutable: GIT, expectedGitSha256: gitSha }), { code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' });
  await assert.rejects(refsInStore({ job, remoteSnapshot: { ...snapshot([]), refs: [{ name: 'refs/heads/main', objectSha: head }] }, gitDirectory: store, gitExecutable: GIT, expectedGitSha256: gitSha }), { code: 'REMOTE_MAIN_BASE_CHANGED' });
});
