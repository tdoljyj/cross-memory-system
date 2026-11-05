// Offline integration only: real stage packaging/readers/outcome/fact, fixture
// broker and Native receipts. No installed broker, dispatch, network or scanner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonical, digest } from '../src/proof.mjs';
import { hash, assembleRecord, validateRecordInputs } from '../src/resident-v2/prepare-record.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { makeJobV2 } from '../src/job-v2.mjs';
import { validateQualificationProtectedEnding } from '../src/resident-v2/relay-qualification-entry.mjs';
import { invokeRelayQualification, invokeRoleProbe } from '../src/resident-v2/invoke-stage.mjs';
import { loadStageInputs, writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { NATIVE_RECEIPT_CONTRACT_V2 } from '../src/resident-v2/stage-fact.mjs';
import { BROKER_RESPONSE_CONTRACT, validateBrokerRequest } from '../src/resident-v2/broker-protocol.mjs';
import { ENTRY_V2, stageByNumber } from '../src/resident-v2/layout.mjs';
import { makeRelayQualificationRun, relayQualificationSubjectSha256, validateRelayQualificationObservation,
  RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS, RELAY_QUALIFICATION_WINDOW_CONTRACT,
  RELAY_QUALIFICATION_AUTHORITY_ID, RELAY_QUALIFICATION_OBSERVATION_CONTRACT } from '../src/resident-v2/relay-qualification-run.mjs';
import { NOW, fixtureRecord, tempDir } from './resident-v2-fixtures.mjs';

const SUCCESS = 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION';
const RUN_KEY = 'a'.repeat(64), RUN_ID = 'a'.repeat(16) + '-' + 'b'.repeat(12);
const h = c => c.repeat(64), s = c => c.repeat(40);

async function fixture(t, window = true) {
  const root = await tempDir(t, 'clued-v2-relay-stage-');
  const rec = fixtureRecord();
  const config = JSON.parse(rec.docs['installation.json']);
  const accepted = JSON.parse(rec.docs['acceptance.json']);
  const jobInput = { repo: config.repository, runId: RUN_ID, pr: 987, headSha: s('a'), baseSha: s('b'), testSha: s('a'),
    sourceManifestSha256: config.sourceManifestSha256, nodeProfileSha256: hash(accepted.node), claimId: randomUUID(),
    fence: 7, executionEpoch: 2, stage1JobId: h('c'), stage1OutcomeNonce: 'd'.repeat(32), stage1OutcomeSha256: h('e'),
    phase: 'initial', priorObservationNonce: null, priorObservationSha256: null, createdAt: new Date(NOW).toISOString() };
  const job = makeRelayQualificationRun(jobInput);
  if (window) {
    accepted.relayQualificationWindow = { contract: RELAY_QUALIFICATION_WINDOW_CONTRACT, qualificationRef: 'receipt:' + randomUUID(),
      sourceManifestSha256: job.sourceManifestSha256, ownerReceiptRef: accepted.ownerReceiptRef,
      authorityDecisionId: RELAY_QUALIFICATION_AUTHORITY_ID, authorityDecisionSha256: h('f'), authorityReadReceiptRef: randomUUID(),
      subject: Object.fromEntries(RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS.map(k => [k, job[k]])),
      validUntil: new Date(NOW + 3_600_000).toISOString(), allowedPhases: ['initial', 'after-ref-move'],
      executionPolicy: 'staged', guarded: false, changedPaths: ['src/fixture.mjs'], changedPathsSha256: digest(['src/fixture.mjs']) };
    rec.docs['acceptance.json'] = Buffer.from(canonical(accepted));
    config.acceptanceSha256 = hash(rec.docs['acceptance.json']);
    rec.docs['installation.json'] = Buffer.from(canonical(config));
  }
  const roots = { stageRoot: path.join(root, 'stage'), brokerRoot: path.join(root, 'broker'), receiptsRoot: path.join(root, 'receipts') };
  for (const p of [roots.stageRoot, roots.receiptsRoot, path.join(roots.brokerRoot, 'requests'), path.join(roots.brokerRoot, 'responses')])
    await fs.mkdir(p, { recursive: true });
  return { root, rec, accepted, jobInput, job, roots, handled: new Set(), inputs: [], outcomes: [] };
}

// A complete typed fixture envelope; shape/binding validation is real. The
// fixture itself is not authenticated production evidence or a live capability.
function observation(job) {
  const roles = ['gitleaks', 'trivy'].map((role, i) => {
    const verifiedClaims = { iss: 'https://token.actions.githubusercontent.com', aud: 'clued-independent-ci',
      repository: job.repo, run_id: String(42 + i), run_attempt: '1', sha: s('6'), workflow_sha: s('6'), iat: NOW / 1000 };
    return { role, verdict: 'ATTESTED_SUCCESS', checkRunId: 42 + i, workflowRunId: String(42 + i), runAttempt: '1',
      annotationsComplete: true, identityAnnotationCount: 1, totalAnnotationCount: 2, fullAnnotationsSha256: h('1'),
      tokenPresent: true, tokenSha256: h('2'), signatureVerified: true, verifiedClaims, claimsSha256: hash(canonical(verifiedClaims)),
      checkRunIdClaimPresent: false, registryBindsCheckRunId: false, keyThumbprintSha256: h('3'), attestationSha256: h('4') };
  });
  return validateRelayQualificationObservation({ contract: RELAY_QUALIFICATION_OBSERVATION_CONTRACT,
    jobId: job.id, phase: job.phase, subjectSha256: relayQualificationSubjectSha256(job), observedAt: new Date(NOW).toISOString(),
    liveQualified: false, roles, refObservation: { ref: `refs/pull/${job.pr}/merge`, beforeMergeSha: s('6'), afterMergeSha: s('6'), oldMergeReadable: true },
    jwksObservation: { networkFetched: true, sha256: h('5') } }, job);
}

function broker(f, { receipt = {}, result = {}, changeOutcome = null } = {}) {
  return async () => {
    for (const name of await fs.readdir(path.join(f.roots.brokerRoot, 'requests'))) {
      if (f.handled.has(name)) continue;
      f.handled.add(name);
      const req = JSON.parse(await fs.readFile(path.join(f.roots.brokerRoot, 'requests', name), 'utf8'));
      validateBrokerRequest(req, Date.parse(req.deadline) - stageByNumber(req.stage).runMilliseconds - 135_000);
      const plan = JSON.parse(await fs.readFile(path.join(f.roots.stageRoot, req.nonce, 'formal-service-entry.json'), 'utf8'));
      const inputs = await loadStageInputs({ nonce: req.nonce, configSha256: req.configSha256, entryRole: plan.entryRole,
        recordDocs: f.rec.docs, stageRoot: f.roots.stageRoot, now: NOW });
      f.inputs.push(inputs);
      const r = plan.stage === 13
        ? { status: 'RELAY_QUALIFICATION_OBSERVATION', reason: null, sideEffects: 0, observation: observation(inputs.jobs[0]), ...result }
        : { status: 'BLOCKED', reason: 'ROLE_PROBE_HELD', sideEffects: 0, observation: observation(f.job), ...result };
      await writeOutcome({ receiptsRoot: f.roots.receiptsRoot, nonce: req.nonce, plan, jobIds: inputs.jobs.map(j => j.id),
        relayQualificationJob: plan.stage === 13 ? inputs.jobs[0] : null, result: r, clock: () => NOW });
      const outcomePath = path.join(f.roots.receiptsRoot, `outcome-${req.nonce}.json`);
      if (changeOutcome) {
        const raw = JSON.parse(await fs.readFile(outcomePath, 'utf8'));
        changeOutcome(raw);
        await fs.writeFile(outcomePath, canonical(raw) + '\n'); // only this new fixture receipt
      }
      const bytes = await fs.readFile(outcomePath);
      f.outcomes.push(JSON.parse(bytes));
      const native = { contract: NATIVE_RECEIPT_CONTRACT_V2, nonce: req.nonce, state: 'FIXED_CHILD_COMPLETED', failure_code: null,
        actual_sid: f.accepted.node.controllerSid, service_pid: 4242, session_id: 0, node_pid: 77,
        node_exit_code: 0, timed_out: false, stop_requested: false, tree_cleanup_confirmed: true, tree_cleanup_failure_code: null,
        tree_active_processes: 0, root_exit_confirmed: true, entry_role: plan.entryRole, stage: plan.stage,
        entry_sha256: plan.entrySha256, config_sha256: req.configSha256, acceptance_sha256: plan.acceptanceSha256,
        source_manifest_sha256: plan.sourceManifestSha256, outcome_sha256: hash(bytes), stdout_captured: false,
        private_bytes_read_by_helper: false, host_qualification: false, ci_principal_qualification: false, ...receipt };
      await fs.writeFile(path.join(f.roots.receiptsRoot, `windows-formal-entry-${req.nonce}.json`), canonical(native), { flag: 'wx' });
      const id = name.replace(/\.json$/, '');
      await fs.writeFile(path.join(f.roots.brokerRoot, 'responses', `${id}.json`), canonical({ contract: BROKER_RESPONSE_CONTRACT,
        requestId: id, ok: true, code: null, started: true, startCallIssued: true, helperPid: 4242, stoppedInTime: true,
        restored: true, accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false }), { flag: 'wx' });
    }
  };
}

function invoke(f, { job = f.job, ...options } = {}) {
  let time = NOW;
  const respond = broker(f, options);
  return invokeRelayQualification({ runKey: RUN_KEY, job, ...f.roots, recordDocs: f.rec.docs,
    clock: () => time, sleep: async ms => { time += ms; await respond(); } });
}

test('record window can be assembled before dynamic Stage1 ending and reused unchanged by Stage13', async t => {
  const f = await fixture(t, false);
  const baselineManifest = JSON.parse(f.rec.docs['source-manifest.json']);
  const sourceFiles = baselineManifest.roles.gitleaks.sourceFiles;
  const normalJob = makeJobV2({ repo: f.jobInput.repo, pr: f.jobInput.pr, headSha: f.jobInput.headSha,
    baseSha: f.jobInput.baseSha, testSha: f.jobInput.testSha, sourceManifestSha256: f.jobInput.sourceManifestSha256,
    role: 'work-admission', attempt: 1, createdAt: f.jobInput.createdAt });
  const staticSubject = Object.fromEntries(RELAY_QUALIFICATION_WINDOW_SUBJECT_FIELDS
    .map(k => [k, k === 'stage1JobId' ? normalJob.id : f.jobInput[k]]));
  const window = { contract: RELAY_QUALIFICATION_WINDOW_CONTRACT, qualificationRef: 'receipt:' + randomUUID(),
    sourceManifestSha256: staticSubject.sourceManifestSha256, ownerReceiptRef: f.rec.inputs.owner.ownerReceiptRef,
    authorityDecisionId: RELAY_QUALIFICATION_AUTHORITY_ID, authorityDecisionSha256: h('f'), authorityReadReceiptRef: randomUUID(),
    subject: staticSubject, validUntil: new Date(NOW + 3_600_000).toISOString(), allowedPhases: ['initial', 'after-ref-move'],
    executionPolicy: 'staged', guarded: false, changedPaths: ['src/fixture.mjs'], changedPathsSha256: digest(['src/fixture.mjs']) };
  assert.equal(Object.hasOwn(window.subject, 'stage1OutcomeNonce'), false);
  assert.equal(Object.hasOwn(window.subject, 'stage1OutcomeSha256'), false);
  // Real preparation code runs before any Stage1 nonce or outcome bytes exist.
  const inputs = validateRecordInputs({ ...f.rec.inputs, relayQualificationWindow: window }, NOW);
  const prepared = assembleRecord(inputs, sourceFiles);
  f.rec.docs = Object.fromEntries(Object.entries(prepared.files).map(([n, text]) => [n, Buffer.from(text)]));
  f.accepted = JSON.parse(f.rec.docs['acceptance.json']);
  const heldRecord = validateRecordV2(f.rec.docs, { now: NOW });
  const acceptanceBeforeStage1 = Buffer.from(f.rec.docs['acceptance.json']);
  assert.equal(heldRecord.config.sourceManifestSha256, staticSubject.sourceManifestSha256);
  // The real outcome writer produces dynamic bytes after the prepared acceptance
  // is fixed. Only the helper receipt below is simulated, as in the broker tests.
  const stage1Nonce = randomBytes(16).toString('hex');
  await writeOutcome({ receiptsRoot: f.roots.receiptsRoot, nonce: stage1Nonce,
    plan: { stage: 1, entryRole: 'work-admission' }, jobIds: [normalJob.id], clock: () => NOW + 100,
    result: { status: 'SETTLED', reason: null, sideEffects: 1 } });
  const outcomeText = await fs.readFile(path.join(f.roots.receiptsRoot, `outcome-${stage1Nonce}.json`), 'utf8');
  const outcomeSha256 = hash(outcomeText);
  const native = { contract: NATIVE_RECEIPT_CONTRACT_V2, nonce: stage1Nonce, stage: 1, entry_role: 'work-admission',
    outcome_sha256: outcomeSha256, source_manifest_sha256: heldRecord.config.sourceManifestSha256,
    acceptance_sha256: heldRecord.hashes.acceptanceSha256, entry_sha256: heldRecord.pins.get(ENTRY_V2['work-admission']),
    config_sha256: h('6'), actual_sid: f.accepted.node.controllerSid, session_id: 0, service_pid: 4242, node_pid: 77,
    state: 'FIXED_CHILD_COMPLETED', failure_code: null, node_exit_code: 0, timed_out: false, stop_requested: false,
    stdout_captured: false, private_bytes_read_by_helper: false, host_qualification: false, ci_principal_qualification: false,
    tree_cleanup_confirmed: true, root_exit_confirmed: true, tree_active_processes: 0, tree_cleanup_failure_code: null };
  const proof = { outcomeText, nativeText: canonical(native), nonce: stage1Nonce, outcomeSha256,
    record: heldRecord, stage: 1, entryRole: 'work-admission', expectedJobId: normalJob.id };
  assert.equal(validateQualificationProtectedEnding(proof).status, 'SETTLED');
  f.jobInput = { ...f.jobInput, stage1JobId: normalJob.id, stage1OutcomeNonce: stage1Nonce, stage1OutcomeSha256: outcomeSha256 };
  f.job = makeRelayQualificationRun(f.jobInput);
  const fact = await invoke(f);
  assert.equal(fact.state, SUCCESS);
  assert.equal(fact.observation.jobId, f.job.id);
  assert.equal(fact.observation.liveQualified, false);
  assert.deepEqual(f.rec.docs['acceptance.json'], acceptanceBeforeStage1, 'no post-Stage1 acceptance rewrite is needed');
  const changedRecord = { ...heldRecord, hashes: { ...heldRecord.hashes, acceptanceSha256: h('9') } };
  assert.throws(() => validateQualificationProtectedEnding({ ...proof, record: changedRecord }), /RELAY_QUALIFICATION_STAGE1_REQUIRED/);
  assert.throws(() => validateQualificationProtectedEnding({ ...proof, nonce: randomBytes(16).toString('hex') }), /RELAY_QUALIFICATION_STAGE1_REQUIRED/);
  assert.throws(() => validateQualificationProtectedEnding({ ...proof, outcomeSha256: h('9') }), /RELAY_QUALIFICATION_STAGE1_REQUIRED/);
});

for (const kind of ['missing-window', 'wrong-source', 'wrong-subject']) {
  test(`stage13 refuses ${kind} before any stage package or broker request`, async t => {
    const f = await fixture(t, kind !== 'missing-window');
    const job = kind === 'wrong-source' ? makeRelayQualificationRun({ ...f.jobInput, sourceManifestSha256: h('9') })
      : kind === 'wrong-subject' ? makeRelayQualificationRun({ ...f.jobInput, fence: f.job.fence + 1 }) : f.job;
    const fact = await invoke(f, { job });
    assert.equal(fact.failure_code, 'STAGE_PACKAGE_REFUSED');
    assert.equal(fact.observation, undefined);
    assert.deepEqual(await fs.readdir(path.join(f.roots.brokerRoot, 'requests')), []);
    assert.deepEqual(await fs.readdir(f.roots.stageRoot), []);
    assert.deepEqual(await fs.readdir(f.roots.receiptsRoot), []);
  });
}

test('stage13 invoker -> real inputs -> typed outcome -> fact is observation only', async t => {
  const f = await fixture(t), fact = await invoke(f);
  assert.equal(fact.state, SUCCESS);
  assert.equal(fact.failure_code, null);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].plan.stage, 13);
  assert.equal(f.inputs[0].plan.entryRole, 'relay-qualification');
  assert.deepEqual(f.inputs[0].jobs, [f.job]);
  assert.equal(f.outcomes[0].status, 'RELAY_QUALIFICATION_OBSERVATION');
  assert.equal(f.outcomes[0].mayHavePublished, false);
  assert.equal(f.outcomes[0].sideEffects, 0);
  assert.deepEqual(fact.observation, observation(f.job));
  assert.equal(fact.observation.liveQualified, false);
  assert.deepEqual(fact.observationLocator, { nonce: fact.nonce, jobId: f.job.id,
    outcomeSha256: hash(await fs.readFile(path.join(f.roots.receiptsRoot, `outcome-${fact.nonce}.json`))),
    nativeReceiptSha256: hash(await fs.readFile(path.join(f.roots.receiptsRoot, `windows-formal-entry-${fact.nonce}.json`))) });
  assert.ok(fact.tree_cleanup_confirmed && fact.root_exit_confirmed && fact.tree_active_processes === 0);
  assert.equal(f.handled.size, 1);
});

for (const [name, options, expected] of [
  ['forged job id', { changeOutcome: o => { o.jobIds = [h('0')]; } }, 'STAGE_OUTCOME_MISSING'],
  ['wrong observation subject', { changeOutcome: o => { o.observation.subjectSha256 = h('0'); } }, 'STAGE_OUTCOME_MISSING'],
  ['wrong raw outcome hash', { receipt: { outcome_sha256: h('0') } }, 'STAGE_OUTCOME_MISSING'],
  ['unconfirmed child-tree cleanup', { receipt: { tree_cleanup_confirmed: false, tree_active_processes: 1 } }, 'STAGE_CHILD_TREE_UNCONFIRMED'],
  ['nonzero effects', { result: { sideEffects: 1 } }, 'STAGE_OUTCOME_MISSING'],
]) {
  test(`stage13 ${name} cannot carry a successful observation`, async t => {
    const f = await fixture(t), fact = await invoke(f, options);
    assert.equal(fact.failure_code, expected);
    assert.notEqual(fact.state, SUCCESS);
    assert.equal(fact.observation, undefined);
    assert.equal(fact.observationLocator, undefined);
    assert.equal(f.handled.size, 1);
  });
}

test('non13 real stage writer and fact cannot transport a relay observation', async t => {
  const f = await fixture(t); let time = NOW;
  const respond = broker(f);
  const fact = await invokeRoleProbe({ runKey: RUN_KEY, runId: RUN_ID, nodeProfileSha256: f.job.nodeProfileSha256,
    ...f.roots, recordDocs: f.rec.docs, clock: () => time, sleep: async ms => { time += ms; await respond(); } });
  assert.equal(fact.state, SUCCESS);
  assert.deepEqual(fact.roleProbe, { result: 'held', code: 'ROLE_PROBE_HELD' });
  assert.equal(f.inputs[0].plan.stage, 11);
  assert.equal(Object.hasOwn(f.outcomes[0], 'observation'), false);
  assert.equal(Object.hasOwn(fact, 'observation'), false);
});
