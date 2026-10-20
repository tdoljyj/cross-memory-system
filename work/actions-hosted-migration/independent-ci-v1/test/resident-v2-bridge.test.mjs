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
import { makeIssue, makeChallenge, makeResponse, makeBlocked, validateResponse, validateBlocked, encode, decode, digest as bridgeDigest } from '../worker/protected-job-bridge-v4/protocol.mjs';
import { createFixtureMailbox } from '../worker/protected-job-bridge-v4/mailbox.mjs';
import { runIssuer, blockedReason, refsFailureReason, ISSUER_SUCCESS } from '../worker/protected-job-bridge-v4/windows-issuer.mjs';
import { resultPayload, observationFacts, verifySignedBridgeResult, RESULT_WRAPPER_CONTRACT_V2 } from '../worker/protected-job-bridge-v4/signed-result.mjs';
import { cleanBlockedReason, isCleanBlocked } from '../worker/protected-job-bridge-v4/linux-worker.mjs';
import { bridgeManifest, BRIDGE_MANIFEST_CONTRACT } from '../worker/protected-job-bridge-v4/bridge-manifest.mjs';
import { validatePolicyShape, validateQualificationPayload, qualificationDeadline, LINUX_NODE_V2 } from '../worker/qualification-v2.mjs';
import { validateSelectedFacts, requiredSourcePaths, FIXED_ROLE_POLICIES } from '../worker/formal-fixed-role-policy-v3/policy.mjs';
import { IMAGE as GITLEAKS_IMAGE, SCAN_ARGS } from '../worker/formal-gitleaks-v4/required-history/prepare.mjs';
import { validateEntryJob } from '../worker/formal-contract-placement-v2/container-entry.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, admittedFacts, hex } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const sha = b => createHash('sha256').update(b).digest('hex');
const claim = (o = {}) => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000), ...o });
const PACKET = { complete: true, paths: ['a.txt'] };
const refsSnapshot = (now = Date.now()) => ({ contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: iso(now), refs: [{ name: 'refs/heads/main', objectSha: BASE }] });

function setup({ attempt = 1 } = {}) {
  const fx = fixtureRecord({}, { paths: REQUIRED_SOURCE_PATHS });
  const record = validateRecordV2(fx.docs, { now: Date.now() });
  const jobs = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, sourceManifestSha256: record.config.sourceManifestSha256, createdAt: iso(Date.now() - 60_000), attempt });
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

test('issuer: one admission callback, then the signed result -> ISSUED_RESULT_RECEIVED; the protocol is driven for real', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => {
    const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json')));
    await put(root, 'challenge-01', encode(makeChallenge(issue, 'admission', 1)));
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

test('issuer: the Linux clean blocked record ends the stage BLOCKED with zero side effects (refs moved since the bundle)', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), root = await spool(t), box = await createFixtureMailbox(root, 'windows');
  const linux = (async () => { const issue = decode(await waitFor(path.join(root, 'outgoing', 'issue.json'))); await put(root, 'blocked', encode(makeBlocked(issue, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'))); })();
  const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: async () => null, box, stageDeadline: Date.now() + 20_000 });
  await linux;
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', 0]);
  // any other clean Linux refusal is final for the attempt, never a pass-through of untrusted text
  assert.equal(blockedReason('ANYTHING_ELSE'), 'LINUX_PREPARATION_REFUSED');
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
  const linux = (async () => { const issue = decode(await waitFor(path.join(root2, 'outgoing', 'issue.json'))); await put(root2, 'challenge-01', encode(makeChallenge(issue, 'admission', 1))); })();
  const r2 = await runIssuer({ context: moved.context, evaluate, collect: async () => null, box: box2, stageDeadline: Date.now() + 10_000 });
  await linux;
  assert.deepEqual([r2.status, r2.reason, r2.sideEffects], ['UNCERTAIN', 'full_admission_claim_changed', 1]);
});

test('issuer: no result before the stage window ends is UNCERTAIN (the Linux side may still run); refs failures map to stable reasons', { skip: process.platform !== 'win32' && 'Windows issuer context' }, async t => {
  const f = issuerFixture(t), root = await spool(t);
  const r = await runIssuer({ context: f.context, evaluate: f.evaluate, collect: async () => null, box: await createFixtureMailbox(root, 'windows'), stageDeadline: Date.now() + 1200 });
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['UNCERTAIN', 'BRIDGE_RESULT_DEADLINE', 1]);
  assert.equal(refsFailureReason('REFS_SNAPSHOT_CHANGED'), 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  assert.equal(refsFailureReason('REFS_PR_SUBJECT_CHANGED'), 'full_admission_subject_changed');
  assert.equal(refsFailureReason('REFS_HTTP_UNCONFIRMED'), 'REMOTE_REFS_UNAVAILABLE');
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

test('qualification v2 and role policy v3 (S6, S10): no claim anywhere, the pinned toolchain node, expiresAt null = until Source change', () => {
  const { jobs } = setup();
  const pins = requiredSourcePaths('gitleaks').map(p => ({ path: p, sha256: hex(32) }));
  const manifestBytes = Buffer.from(canonical({ schema: 'independent-ci.sources.v2', repo: REPO, sourceSha: 'c'.repeat(40), roles: { gitleaks: {
    containerCommand: { image: GITLEAKS_IMAGE, scanner: 'gitleaks', executable: '/usr/bin/gitleaks', args: [...SCAN_ARGS], cwd: '/input' },
    hostTools: { python: { path: '/usr/bin/python3.12', sha256: hex(32) } }, sourceFiles: pins } } }));
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, sourceManifestSha256: sha(manifestBytes), createdAt: iso(Date.now() - 1000), attempt: 2 }).gitleaks;
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
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: head, baseSha: base, sourceManifestSha256: 'e'.repeat(64), createdAt: iso(Date.now() - 1000), attempt: 1 }).gitleaks;
  const snapshot = extra => ({ contract: 'clued.independent-ci.remote-heads-tags/1', repository: REPO, complete: true, observedAt: iso(Date.now()), refs: [{ name: 'refs/heads/main', objectSha: base }, { name: 'refs/heads/pr', objectSha: head }, ...extra] });
  const store = path.join(dir, '.git');
  assert.deepEqual(await refsInStore({ job, remoteSnapshot: snapshot([]), gitDirectory: store, gitExecutable: GIT, expectedGitSha256: gitSha }), { tips: 2, refs: 2 });
  await assert.rejects(refsInStore({ job, remoteSnapshot: snapshot([{ name: 'refs/heads/pushed-later', objectSha: '1'.repeat(40) }]), gitDirectory: store, gitExecutable: GIT, expectedGitSha256: gitSha }), { code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' });
  await assert.rejects(refsInStore({ job, remoteSnapshot: { ...snapshot([]), refs: [{ name: 'refs/heads/main', objectSha: head }] }, gitDirectory: store, gitExecutable: GIT, expectedGitSha256: gitSha }), { code: 'REMOTE_MAIN_BASE_CHANGED' });
});
