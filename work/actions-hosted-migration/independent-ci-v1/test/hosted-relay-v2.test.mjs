// PR-A integration of the hosted relay with Source v2 (free-minutes design S18-S22):
//   - stage R is derived after the hosted wait for exactly the relay candidates (derive-batch --relay-roles);
//   - the relay entry's per-role rows travel outcome -> stage fact (relay-plan.mjs) with stable codes;
//   - the v2 scanner publisher carries publishHosted and K(head, role), so relay and local v2 exclude each other.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest as digestOf } from '../src/proof.mjs';
import { relayExternalId } from '../src/hosted-relay-v1/attest.mjs';
import { claimRolePublication, rolePublicationKey } from '../src/effect-journal.mjs';
import { canonical } from '../src/proof.mjs';
import { hash } from '../src/resident-v2/prepare-record.mjs';
import { deriveBatch, deriveRelayStage, residentBatchKey, writeBatch, writeRelayStage, main as deriveMain } from '../src/resident-v2/derive-batch.mjs';
import { readSealedStage } from '../src/resident-v2/stage-package.mjs';
import { invokeStage } from '../src/resident-v2/invoke-stage.mjs';
import { writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { ALL_STAGE_CODES, CLEAN_FINAL_CODES, UNKNOWN_CODES, NATIVE_RECEIPT_CONTRACT_V2, outcomeFailureCode } from '../src/resident-v2/stage-fact.mjs';
import { BROKER_RESPONSE_CONTRACT, makeBrokerRequest } from '../src/resident-v2/broker-protocol.mjs';
import { OUTCOME_CONTRACT, RELAY_STAGE_NUMBER, STAGES_V2, stageJobRolesValid } from '../src/resident-v2/layout.mjs';
import { entryResultOf, planRowOf, validateRelayPlanRows, RELAY_PLAN_ROW_FIELDS } from '../src/hosted-relay-v1/relay-plan.mjs';
import { installedInputPins, installedRegistry, relaySubject } from '../src/hosted-relay-v1/relay-entry-v2.mjs';
import { LOCAL_REASONS, createHostedRelayStage } from '../src/hosted-relay-v1/stage.mjs';
import { EffectJournal, readRolePublication } from '../src/effect-journal.mjs';
import { makeJobV2, claimGeneration } from '../src/job-v2.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { NOW, hex, tempDir, fixtureRecord, writeRecordDir, subject, admittedFacts, signerKeys } from './resident-v2-fixtures.mjs';
import { B, H, CLAIM, MANIFEST, REPO, ROLES, createWorld, published } from './fixtures/hosted-relay/world.mjs';
import { sign } from 'node:crypto';
import { RESULT_CONTRACT_V2, ENVELOPE_CONTRACT_V2 } from '../src/proof-v2.mjs';
import { subjectOfV2 } from '../src/job-v2.mjs';

const CONTROLLER = 'S-1-5-21-1-2-3-1015';

function derived(t) {
  const rec = fixtureRecord();
  const s = subject();
  const key = residentBatchKey(s);
  const id = `${key.slice(0, 16)}-${hex(6)}`;
  return { rec, s, key, id, d: deriveBatch({ recordDocs: rec.docs, subject: s, batchKey: key, batchId: id, now: NOW }) };
}

test('layout: stage R is stage 9, kind hosted-relay, entry relay-publisher, a variable subset of the relayable roles', () => {
  const r = STAGES_V2.find(s => s.number === RELAY_STAGE_NUMBER);
  assert.deepEqual([r.kind, r.entryRole, [...r.jobRoles], r.variableJobRoles, r.linuxWorker], ['hosted-relay', 'relay-publisher', ['gitleaks', 'trivy'], true, false]);
  for (const ok of [['gitleaks'], ['trivy'], ['gitleaks', 'trivy']]) assert.equal(stageJobRolesValid(r, ok), true, ok.join());
  for (const no of [[], ['trivy', 'gitleaks'], ['contract-placement'], ['gitleaks', 'gitleaks'], ['gitleaks', 'trivy', 'contract-placement']]) assert.equal(stageJobRolesValid(r, no), false, no.join());
  assert.equal(stageJobRolesValid(STAGES_V2[1], ['gitleaks']), true);
  assert.equal(stageJobRolesValid(STAGES_V2[1], ['trivy']), false);
});

test('derive-batch --relay-roles: one deterministic stage-R package for exactly the candidates, from the batch itself', async t => {
  const { rec, key, id, d } = derived(t);
  assert.equal(d.result.stages.length, 8, 'stage R is never part of the batch derivation');
  const a = deriveRelayStage({ recordDocs: rec.docs, batchJson: d.files['batch.json'], roles: ['gitleaks', 'trivy'], batchKey: key, batchId: id, now: NOW });
  const b = deriveRelayStage({ recordDocs: rec.docs, batchJson: Buffer.from(d.files['batch.json']), roles: ['gitleaks', 'trivy'], batchKey: key, batchId: id, now: NOW + 5 });
  assert.deepEqual(a.files, b.files);
  assert.equal(a.result.stage.number, 9);
  const batch = JSON.parse(d.files['batch.json']);
  assert.deepEqual(a.result.stage.jobIds, [batch.jobs.gitleaks, batch.jobs.trivy], 'the same content ids, never new local jobs');
  const one = deriveRelayStage({ recordDocs: rec.docs, batchJson: d.files['batch.json'], roles: ['trivy'], batchKey: key, batchId: id, now: NOW });
  assert.deepEqual(one.result.stage.jobIds, [batch.jobs.trivy]);
  for (const roles of [[], ['trivy', 'gitleaks'], ['contract-placement'], ['control-admission']])
    assert.throws(() => deriveRelayStage({ recordDocs: rec.docs, batchJson: d.files['batch.json'], roles, batchKey: key, batchId: id, now: NOW }), { code: 'RESIDENT_RELAY_ROLES_REFUSED' });
  assert.throws(() => deriveRelayStage({ recordDocs: rec.docs, batchJson: d.files['batch.json'], roles: ['trivy'], batchKey: 'f'.repeat(64), batchId: id, now: NOW }), { code: 'RESIDENT_BATCH_RECORD_REFUSED' });
  const tampered = canonical({ ...batch, jobs: { ...batch.jobs, trivy: 'f'.repeat(64) } });
  assert.throws(() => deriveRelayStage({ recordDocs: rec.docs, batchJson: tampered, roles: ['trivy'], batchKey: key, batchId: id, now: NOW }), { code: 'RESIDENT_BATCH_RECORD_REFUSED' });
  assert.throws(() => deriveRelayStage({ recordDocs: rec.docs, batchJson: d.files['batch.json'] + ' ', roles: ['trivy'], batchKey: key, batchId: id, now: NOW }), { code: 'RESIDENT_BATCH_RECORD_REFUSED' });
  // write next to the batch, read back against the pin, never twice
  const dir = path.join(await tempDir(t), 'batch');
  writeBatch(dir, d.files);
  writeRelayStage(dir, a.files);
  const sealed = await readSealedStage(dir, 9, a.result.stage.workManifestSha256);
  assert.deepEqual([sealed.plan.entryRole, sealed.stage.jobRoles], ['relay-publisher', ['gitleaks', 'trivy']]);
  assert.throws(() => writeRelayStage(dir, a.files), { code: 'RESIDENT_RELAY_STAGE_EXISTS_PRESERVE_NO_RETRY' });
});

test('derive-batch CLI --relay-roles writes stage-09 into the existing batch directory', async t => {
  const root = await tempDir(t);
  const { files } = fixtureRecord();
  const record = await writeRecordDir(path.join(root, 'record'), files);
  const s = subject(), key = residentBatchKey(s), id = `${key.slice(0, 16)}-${hex(6)}`;
  const out = path.join(root, 'out');
  assert.equal(deriveMain(['--subject-json', JSON.stringify(s), '--batch-key', key, '--batch-id', id, '--out', out, '--record', record], { now: NOW, output: { write() {} } }), 0);
  let text = '';
  assert.equal(deriveMain(['--relay-roles', 'gitleaks', '--batch-dir', out, '--batch-key', key, '--batch-id', id, '--record', record], { now: NOW, output: { write: x => { text += x; } } }), 0);
  const v = JSON.parse(text);
  assert.equal(v.status, 'RESIDENT_RELAY_STAGE_DERIVED');
  assert.ok(fs.existsSync(path.join(out, 'stage-09', 'jobs.json')));
  assert.throws(() => deriveMain(['--relay-roles', 'gitleaks', '--batch-dir', out, '--batch-key', key, '--batch-id', id, '--out', out], { now: NOW }), { code: 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED' });
  assert.throws(() => deriveMain(['--relay-roles', 'Gitleaks;rm', '--batch-dir', out, '--batch-key', key, '--batch-id', id], { now: NOW }), { code: 'RESIDENT_RELAY_ROLES_REFUSED' });
});

const relayed = role => ({ role, outcome: 'RELAYED', reason: null, receipt: 'relay-attested', checkRunId: 901, externalId: `independent-ci:relay:${role}:${H.slice(0, 12)}:run39000000001:a1`,
  attestationSha256: 'a'.repeat(64), detail: null });
const local = (role, reason = 'RELAY_NOT_ATTESTED_PENDING') => ({ role, outcome: 'LOCAL_REQUIRED', reason, receipt: reason === 'RELAY_NOT_ATTESTED_BILLING_REFUSED' ? 'relay-billing-refused' : 'relay-local-fallback',
  checkRunId: null, externalId: null, attestationSha256: null, detail: 'E5_HOSTED_IN_PROGRESS' });

test('relay plan rows: stage rows map to strict plan rows; anything unexpected is HALT; the entry result is RELAY_COMPLETE/UNCERTAIN/BLOCKED', () => {
  assert.deepEqual(Object.keys(relayed('gitleaks')).sort(), [...RELAY_PLAN_ROW_FIELDS].sort());
  assert.deepEqual(validateRelayPlanRows([relayed('gitleaks'), local('trivy')], ['gitleaks', 'trivy']).map(r => r.outcome), ['RELAYED', 'LOCAL_REQUIRED']);
  assert.equal(validateRelayPlanRows([relayed('gitleaks')], ['trivy']), null, 'rows must be exactly the candidates');
  assert.equal(validateRelayPlanRows([{ ...local('trivy'), reason: 'SOMETHING_ELSE' }]), null);
  assert.equal(validateRelayPlanRows([{ ...relayed('trivy'), receipt: 'relay-local-fallback' }]), null);
  assert.equal(validateRelayPlanRows([{ ...relayed('trivy'), extra: 1 }]), null);
  assert.equal(validateRelayPlanRows([]), null);
  for (const reason of LOCAL_REASONS) assert.equal(planRowOf({ role: 'trivy', outcome: 'LOCAL_REQUIRED', reason, receipt: 'relay-local-fallback' }).outcome, 'LOCAL_REQUIRED', reason);
  assert.equal(planRowOf({ role: 'trivy', outcome: 'LOCAL_REQUIRED', reason: 'MADE_UP', receipt: 'relay-local-fallback' }).outcome, 'HALT');
  assert.equal(planRowOf({ role: 'trivy', outcome: 'RELAYED', checkRunId: 1, externalId: 'x', attestationSha256: 'a'.repeat(64), receipt: 'relay-attested' }).outcome, 'HALT');
  const complete = entryResultOf({ status: 'COMPLETE', code: null, sideEffects: 1, roles: [{ ...relayed('gitleaks') }, { ...local('trivy') }] });
  assert.deepEqual([complete.status, complete.sideEffects, complete.relay.length], ['RELAY_COMPLETE', 1, 2]);
  const halt = entryResultOf({ status: 'HALT', code: 'RELAY_PUBLICATION_UNCERTAIN', sideEffects: 1, roles: [{ role: 'gitleaks', outcome: 'HALT', reason: 'RELAY_PUBLICATION_UNCERTAIN' }] });
  assert.deepEqual([halt.status, halt.reason], ['UNCERTAIN', 'RELAY_PUBLICATION_UNCERTAIN']);
  assert.deepEqual(entryResultOf({ status: 'REFUSED', code: 'RELAY_STAGE_NOT_CONFIGURED', sideEffects: 0, roles: [] }), { status: 'BLOCKED', reason: 'RELAY_STAGE_NOT_CONFIGURED', sideEffects: 0, relay: null });
  assert.equal(entryResultOf({ status: 'COMPLETE', sideEffects: 0, roles: [{ role: 'gitleaks', outcome: 'NOT_PROCESSED' }] }).status, 'UNCERTAIN', 'COMPLETE with a non-final row is not complete');
});

test('stage-fact catalogue: stage-R codes are catalogued (refusal clean, every relay uncertainty UNKNOWN)', () => {
  assert.ok(CLEAN_FINAL_CODES.includes('RELAY_STAGE_REFUSED'));
  for (const c of ['RELAY_PUBLICATION_UNCERTAIN', 'ROLE_ALREADY_PUBLISHED_ON_HEAD', 'RELAY_PLAN_UNCONFIRMED']) assert.ok(UNKNOWN_CODES.includes(c) && ALL_STAGE_CODES.includes(c), c);
  const o = (status, reason, sideEffects = 0) => ({ status, reason, sideEffects, mayHavePublished: !(status === 'BLOCKED' && sideEffects === 0) });
  assert.equal(outcomeFailureCode(o('UNCERTAIN', 'RELAY_PUBLICATION_UNCERTAIN', 1), 9), 'RELAY_PUBLICATION_UNCERTAIN');
  assert.equal(outcomeFailureCode(o('UNCERTAIN', 'ROLE_ALREADY_PUBLISHED_ON_HEAD', 1), 9), 'ROLE_ALREADY_PUBLISHED_ON_HEAD');
  assert.equal(outcomeFailureCode(o('UNCERTAIN', 'RELAY_PUBLICATION_UNCERTAIN', 1), 3), 'PUBLICATION_UNCERTAIN', 'a relay code outside stage R is the generic one');
  assert.equal(outcomeFailureCode(o('BLOCKED', 'RELAY_STAGE_NOT_CONFIGURED'), 9), 'RELAY_STAGE_REFUSED');
  assert.equal(outcomeFailureCode(o('BLOCKED', 'RELAY_STAGE_INPUT_INVALID'), 9), 'RELAY_STAGE_REFUSED');
  assert.equal(outcomeFailureCode(o('BLOCKED', 'whatever_else'), 9), 'PUBLICATION_BLOCKED');
});

// invoke-stage for stage 9 end to end, with a fake broker and helper that write the outcome as writeOutcome would.
async function stageRFixture(t, roles = ['gitleaks', 'trivy']) {
  const root = await tempDir(t);
  const { rec, key, id, d } = derived(t);
  const batchDir = path.join(root, 'work', id);
  await fsp.mkdir(path.join(root, 'work'));
  writeBatch(batchDir, d.files);
  const r = deriveRelayStage({ recordDocs: rec.docs, batchJson: d.files['batch.json'], roles, batchKey: key, batchId: id, now: NOW });
  writeRelayStage(batchDir, r.files);
  for (const p of ['stage', 'broker/requests', 'broker/responses', 'receipts']) await fsp.mkdir(path.join(root, p), { recursive: true });
  return { root, key, batchDir, row: r.result.stage, rec };
}
function relayBroker(f, result) {
  const handled = new Set();
  return async () => {
    for (const n of await fsp.readdir(path.join(f.root, 'broker', 'requests'))) {
      if (handled.has(n)) continue;
      handled.add(n);
      const req = JSON.parse(await fsp.readFile(path.join(f.root, 'broker', 'requests', n), 'utf8'));
      const plan = JSON.parse(await fsp.readFile(path.join(f.root, 'stage', req.nonce, 'formal-service-entry.json'), 'utf8'));
      const outcome = await writeOutcome({ receiptsRoot: path.join(f.root, 'receipts'), nonce: req.nonce, plan, jobIds: [], result, clock: () => NOW });
      const outcomeBytes = await fsp.readFile(path.join(f.root, 'receipts', `outcome-${req.nonce}.json`));
      const ok = outcome.status === 'RELAY_COMPLETE';
      const receipt = { contract: NATIVE_RECEIPT_CONTRACT_V2, nonce: req.nonce, state: ok ? 'FIXED_CHILD_COMPLETED' : 'FIXED_CHILD_REFUSED', failure_code: ok ? null : 'FIXED_CHILD_NONZERO_EXIT', actual_sid: CONTROLLER,
        service_pid: 4242, session_id: 0, node_pid: 77, node_exit_code: ok ? 0 : 2, timed_out: false, stop_requested: false, tree_cleanup_confirmed: true, tree_cleanup_failure_code: null,
        tree_active_processes: 0, root_exit_confirmed: true, entry_role: plan.entryRole, stage: plan.stage, entry_sha256: plan.entrySha256, config_sha256: req.configSha256,
        acceptance_sha256: plan.acceptanceSha256, source_manifest_sha256: plan.sourceManifestSha256, outcome_sha256: hash(outcomeBytes), stdout_captured: false,
        private_bytes_read_by_helper: false, host_qualification: false, ci_principal_qualification: false };
      await fsp.writeFile(path.join(f.root, 'receipts', `windows-formal-entry-${req.nonce}.json`), JSON.stringify(receipt), { flag: 'wx' });
      const id = n.replace(/\.json$/, '');
      await fsp.writeFile(path.join(f.root, 'broker', 'responses', `${id}.json`), JSON.stringify({ contract: BROKER_RESPONSE_CONTRACT, requestId: id, ok: true, code: null, started: true,
        startCallIssued: true, helperPid: 4242, stoppedInTime: true, restored: true, accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false }), { flag: 'wx' });
    }
  };
}
const invokeR = (f, broker) => {
  let time = NOW;
  return invokeStage({ batchDir: f.batchDir, stage: 9, workManifestSha256: f.row.workManifestSha256, batchKey: f.key, stageRoot: path.join(f.root, 'stage'),
    // #926: the invoker checks the sealed plan against the record's node profile and takes the controller SID from it
    brokerRoot: path.join(f.root, 'broker'), receiptsRoot: path.join(f.root, 'receipts'), spoolRoot: path.join(f.root, 'spool'), recordDocs: f.rec.docs,
    clock: () => time, sleep: async ms => { time += ms; await broker(); } });
};

test('invoke-stage stage 9: a completed relay stage is a success fact carrying the plan rows; a HALT or a bad plan never is', async t => {
  const f = await stageRFixture(t);
  assert.equal(makeBrokerRequest({ stage: 9, nonce: hex(16), configSha256: hex(32), now: NOW }).stage, 9);
  const ok = await invokeR(f, relayBroker(f, { status: 'RELAY_COMPLETE', reason: null, sideEffects: 1, relay: [relayed('gitleaks'), local('trivy')] }));
  assert.equal(ok.state, 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION');
  assert.deepEqual(ok.relay.map(r => `${r.role}:${r.outcome}`), ['gitleaks:RELAYED', 'trivy:LOCAL_REQUIRED']);
  const g = await stageRFixture(t);
  const halt = await invokeR(g, relayBroker(g, { status: 'UNCERTAIN', reason: 'RELAY_PUBLICATION_UNCERTAIN', sideEffects: 1,
    relay: [{ ...relayed('gitleaks'), outcome: 'HALT', reason: 'RELAY_PUBLICATION_UNCERTAIN', receipt: null, checkRunId: null, externalId: null, attestationSha256: null }, { ...local('trivy'), outcome: 'NOT_PROCESSED', reason: null, receipt: null, detail: null }] }));
  assert.deepEqual([halt.state, halt.failure_code], ['FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED', 'RELAY_PUBLICATION_UNCERTAIN']);
  assert.deepEqual(halt.relay.map(r => r.outcome), ['HALT', 'NOT_PROCESSED']);
  const h = await stageRFixture(t);
  // the entry's own writeOutcome turns an invalid row set into [] -> a "complete" stage without a plan is UNKNOWN
  const bad = await invokeR(h, relayBroker(h, { status: 'RELAY_COMPLETE', reason: null, sideEffects: 1, relay: [{ ...relayed('gitleaks'), receipt: 'relay-local-fallback' }] }));
  assert.equal(bad.failure_code, 'RELAY_PLAN_UNCONFIRMED');
  const k = await stageRFixture(t);
  const refused = await invokeR(k, relayBroker(k, { status: 'BLOCKED', reason: 'RELAY_STAGE_NOT_CONFIGURED', sideEffects: 0, relay: null }));
  assert.equal(refused.failure_code, 'RELAY_STAGE_REFUSED');
});

test('relay entry: the installed registry must be the held, accepted bytes; the subject carries the batch claim generation', () => {
  const bytes = fs.readFileSync(new URL('../src/hosted-relay-v1/registry.json', import.meta.url));
  const p = 'work/actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/registry.json';
  const held = { sourceHashes: new Map([[p, createHash('sha256').update(bytes).digest('hex')]]) };
  if (Object.values(JSON.parse(bytes).roles).some(r => !Object.hasOwn(r, 'forbiddenChangePrefixes'))) {
    // pre-isolation registry (PR-A review BLOCKER): refused until PR-B is re-frozen and the registry rebuilt
    assert.throws(() => installedRegistry(held), { code: 'RELAY_REGISTRY_INVALID' });
  } else {
    const registry = installedRegistry(held);
    assert.equal(registry.domain, 'production');
    assert.deepEqual(Object.keys(registry.roles).sort(), ['gitleaks', 'trivy']);
  }
  assert.throws(() => installedRegistry({ sourceHashes: new Map([[p, 'f'.repeat(64)]]) }), { code: 'RELAY_REGISTRY_NOT_ACCEPTED' });
  const job = makeJobV2({ repo: REPO, pr: 7, headSha: H, baseSha: B, testSha: H, role: 'gitleaks', sourceManifestSha256: MANIFEST, createdAt: new Date(NOW).toISOString(), attempt: 2 });
  assert.deepEqual(relaySubject([job], { claimId: CLAIM, fence: 3, epoch: 1 }), { repo: REPO, pr: 7, headSha: H, baseSha: B, claimId: CLAIM, fence: 3, epoch: 1, sourceManifestSha256: MANIFEST });
});

// ---- the v2 scanner publisher with the hosted relay (world fixture, v2 Native admission and authority) ----
async function journalFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-relay-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return EffectJournal.open(dir);
}
const REFS = { sourceAcceptanceRef: 'a1a1a1a1-0000-4000-8000-000000000001', hostQualificationRef: 'a1a1a1a1-0000-4000-8000-000000000002',
  ownerAuthorizationRef: 'a1a1a1a1-0000-4000-8000-000000000003', publisherQualificationRef: 'a1a1a1a1-0000-4000-8000-000000000004',
  ciPrincipalQualificationRef: 'a1a1a1a1-0000-4000-8000-000000000005' };
const BINDING = '11111111-2222-4333-8444-555555555555';
// wrapGithub: the GitHub port the v2 publisher sees (the world's own by default). admissionMs: how long each complete admission takes
// (the world's clock moves). w.state.windowLeft, when set, is what production's pre-write observation window has left (windowLeftMs).
function v2World({ claimFence = 3, wrapGithub = g => g, admissionMs = 0 } = {}) {
  const w = createWorld();
  const iso = ms => new Date(ms).toISOString();
  const observed = () => ({ claimId: CLAIM, fence: claimFence, epoch: 1, expiresAt: iso(w.state.now + 3_600_000) });
  const nativeAdmission = { fixture: true, async evaluatePr(job, packet, opts) {
    if (w.state.faults.native) return { contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false, reason: 'full_admission_rejected' };
    w.state.now += admissionMs;
    return admittedFacts(job, observed(), packet, { domain: 'fixture', batchClaim: opts?.batchClaim ?? null, observedAt: w.state.now, slotUntil: w.state.now + 3_600_000 });
  } };
  const authority = { fixture: true, async observe(job) {
    return { ...subjectOfV2(job), ...REFS, ciPrincipalBindingId: BINDING, sourceAccepted: true, hostQualified: true, publisherQualified: true, ciPrincipalQualified: true,
      observedAt: iso(w.state.now), claimExpiresAt: observed().expiresAt, claim: claimGeneration(observed()) };
  }, windowLeftMs: () => w.state.windowLeft ?? null };
  const signer = signerKeys();
  const signers = new Map([['fixture-key', { domain: 'fixture', publicKeyPem: signer.publicKeyPem, runtimeId: 'fixture-runtime', qualificationRef: REFS.hostQualificationRef, sourceAcceptanceRef: REFS.sourceAcceptanceRef }]]);
  const batchClaim = { claimId: CLAIM, fence: 3, epoch: 1 };
  const configuredChecks = { gitleaks: { name: 'gitleaks', appId: 5368905 }, trivy: { name: 'trivy', appId: 5368905 }, 'contract-placement': { name: 'contract-placement', appId: 5368905 } };
  const publisher = (journal, hostedVerifier) => createStagedCheckPublisherV2({ nativeAdmission, authority, github: wrapGithub(w.github), journal, signers, configuredChecks,
    readChangedPaths: job => w.github.readChangedPaths(job), clock: () => w.state.now, domain: 'fixture', hostedVerifier, batchClaim,
    protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: BINDING, ...REFS } });
  // The installed trivy role pins the same checks bundle the hosted job uses (stage R compares them).
  const localInputPins = installedInputPins({ roles: { trivy: { formalTrivy: { checksPin: { digest: w.registry.roles.trivy.checksDigest } } } } });
  const stage = journal => { const v = w.verifier(); return createHostedRelayStage({ registry: w.registry, verifier: v, publisher: publisher(journal, v), localInputPins }); };
  const localJob = (role, attempt = 1) => makeJobV2({ repo: REPO, pr: 7, headSha: H, baseSha: B, testSha: H, role, sourceManifestSha256: MANIFEST, createdAt: iso(w.state.now - 20 * 60_000), attempt });
  const signed = job => {
    const payload = { contract: RESULT_CONTRACT_V2, domain: 'fixture', runtimeId: 'fixture-runtime', subject: subjectOfV2(job), startedAt: iso(w.state.now - 300_000), finishedAt: iso(w.state.now - 60_000),
      conclusion: 'success', exitCode: 0, stdoutSha256: 'd'.repeat(64), stderrSha256: 'e'.repeat(64), artifactsSha256: 'f'.repeat(64) };
    return { contract: ENVELOPE_CONTRACT_V2, keyId: 'fixture-key', signature: sign(null, Buffer.from(canonical(payload)), signer.privateKey).toString('base64url'), payload };
  };
  const subjectOf = () => ({ repo: REPO, pr: 7, headSha: H, baseSha: B, claimId: CLAIM, fence: 3, epoch: 1, sourceManifestSha256: MANIFEST });
  return { w, publisher, stage, localJob, signed, subjectOf, localInputPins };
}
const rowsOf = r => Object.fromEntries(r.roles.map(x => [x.role, x.reason ? `${x.outcome}:${x.reason}` : x.outcome]));

test('v2 relay: attested roles are relayed once under the batch claim; a later local v2 publication of the role is refused (K)', async t => {
  const v = v2World(); v.w.allHosted();
  const journal = await journalFor(t);
  const first = await v.stage(journal).run({ subject: v.subjectOf(), attempt: 1, roles: [...ROLES] });
  assert.deepEqual(rowsOf(first), { gitleaks: 'RELAYED', trivy: 'RELAYED' });
  assert.equal(published(v.w.state).length, 2);
  const again = await v.stage(journal).run({ subject: v.subjectOf(), attempt: 1, roles: [...ROLES] });
  assert.deepEqual([again.sideEffects, published(v.w.state).length], [0, 2], 'a repeated stage only reads back');
  const job = v.localJob('gitleaks');
  const localTry = await v.publisher(journal, null).publish({ job, envelope: v.signed(job) });
  assert.deepEqual([localTry.status, localTry.reason], ['BLOCKED', 'role_already_published_on_head']);
  const holder = await readRolePublication(journal, { repo: REPO, headSha: H, role: 'gitleaks', checkName: 'gitleaks', appId: 5368905 });
  assert.equal(holder.holder.path, 'relay');
  // K has no attempt (PR-A review MAJOR 2): an attempt-2 local job of the relayed role is refused as well
  const job2 = v.localJob('gitleaks', 2);
  const attempt2 = await v.publisher(journal, null).publish({ job: job2, envelope: v.signed(job2) });
  assert.deepEqual([attempt2.status, attempt2.reason], ['BLOCKED', 'role_already_published_on_head']);
});

test('v2 relay: a local v2 publication first holds K; the relay then HALTs for that role and never publishes it', async t => {
  const v = v2World(); v.w.allHosted();
  const journal = await journalFor(t);
  const job = v.localJob('trivy');
  const pre = await v.publisher(journal, null).publish({ job, envelope: v.signed(job) });
  assert.equal(pre.status, 'SETTLED', JSON.stringify(pre));
  const r = await v.stage(journal).run({ subject: v.subjectOf(), attempt: 1, roles: ['trivy'] });
  assert.deepEqual([r.status, r.code], ['HALT', 'ROLE_ALREADY_PUBLISHED_ON_HEAD']);
  assert.equal(published(v.w.state).filter(c => c.external_id.startsWith('independent-ci:relay:')).length, 0);
});

test('v2 relay: another claim generation than the batch claim, or a Native refusal, leaves the role local with nothing written', async t => {
  const v = v2World(); v.w.allHosted();
  const journal = await journalFor(t);
  const moved = await v.stage(journal).run({ subject: { ...v.subjectOf(), fence: 4 }, attempt: 1, roles: ['gitleaks'] });
  assert.deepEqual(rowsOf(moved), { gitleaks: 'LOCAL_REQUIRED:RELAY_NOT_ATTESTED_NOT_ADMITTED' });
  assert.equal(moved.roles[0].detail, 'hosted_claim_changed');
  v.w.state.faults.native = true;
  const refused = await v.stage(journal).run({ subject: v.subjectOf(), attempt: 1, roles: ['gitleaks'] });
  assert.deepEqual(rowsOf(refused), { gitleaks: 'LOCAL_REQUIRED:RELAY_NOT_ATTESTED_NOT_ADMITTED' });
  assert.equal(published(v.w.state).length, 0);
  assert.equal((await readRolePublication(journal, { repo: REPO, headSha: H, role: 'gitleaks', checkName: 'gitleaks', appId: 5368905 })).holder, null);
  delete v.w.state.faults.native;
  const job = v.localJob('gitleaks');
  assert.equal((await v.publisher(journal, null).publish({ job, envelope: v.signed(job) })).status, 'SETTLED', 'the local path stays open');
});

test('v2 relay: an unconfirmed POST is RELAY_PUBLICATION_UNCERTAIN, and the role is locked against the local v2 path', async t => {
  const v = v2World(); v.w.allHosted(); v.w.state.faults.createCheck = 'lost-no-write';
  const journal = await journalFor(t);
  const r = await v.stage(journal).run({ subject: v.subjectOf(), attempt: 1, roles: ['gitleaks', 'trivy'] });
  assert.deepEqual([r.status, r.code], ['HALT', 'RELAY_PUBLICATION_UNCERTAIN']);
  assert.deepEqual(rowsOf(r), { gitleaks: 'HALT:RELAY_PUBLICATION_UNCERTAIN', trivy: 'NOT_PROCESSED' });
  delete v.w.state.faults.createCheck;
  const job = v.localJob('gitleaks');
  const local = await v.publisher(journal, null).publish({ job, envelope: v.signed(job) });
  assert.deepEqual([local.status, local.reason], ['BLOCKED', 'role_already_published_on_head']);
  const entry = entryResultOf(r);
  assert.deepEqual([entry.status, entry.reason, entry.relay.map(x => x.outcome)], ['UNCERTAIN', 'RELAY_PUBLICATION_UNCERTAIN', ['HALT', 'NOT_PROCESSED']]);
});

test('v2 publisher without a hosted verifier refuses publishHosted and never touches K', async t => {
  const v = v2World(); v.w.allHosted();
  const journal = await journalFor(t);
  const r = await v.publisher(journal, null).publishHosted({ subject: v.subjectOf(), attempt: 1, envelope: {} });
  assert.deepEqual([r.status, r.reason, r.roleMutex.held], ['BLOCKED', 'hosted_relay_not_configured', false]);
});

// ---- Resident primary/standby design v0.4 §6.2 (C4, Task c2af8d17): GitHub is the shared record across nodes ----
// A check of App 5368905 that another node (or an earlier install) published on the head; this node's journal knows nothing of it.
const otherNodeRun = (role, id = 990001) => ({ id, name: role, head_sha: H, status: 'completed', conclusion: 'success', app: { id: 5368905 },
  external_id: `independent-ci:staged:v2:${'c'.repeat(64)}:a1`, output: { title: `${role}: success`, summary: 'published by another node' } });
const onGithub = role => ({ role, outcome: 'ON_GITHUB', reason: 'ROLE_ALREADY_ON_GITHUB', receipt: null, checkRunId: null, externalId: null, attestationSha256: null, detail: 'role_already_on_github' });
const notProcessed = role => ({ role, outcome: 'NOT_PROCESSED', reason: null, receipt: null, checkRunId: null, externalId: null, attestationSha256: null, detail: null });
const mutexOf = role => ({ repo: REPO, headSha: H, role, checkName: role, appId: 5368905 });

test('C4 v2 relay: a role already on GitHub from another node is ON_GITHUB; nothing posted, no K, later roles not processed', async t => {
  const v = v2World(); v.w.allHosted(); v.w.state.checkRuns.push(otherNodeRun('gitleaks'));
  const journal = await journalFor(t);
  const r = await v.stage(journal).run({ subject: v.subjectOf(), attempt: 1, roles: [...ROLES] });
  assert.deepEqual([r.status, r.code, r.sideEffects], ['ON_GITHUB', 'ROLE_ALREADY_ON_GITHUB', 0]);
  assert.deepEqual(rowsOf(r), { gitleaks: 'ON_GITHUB:ROLE_ALREADY_ON_GITHUB', trivy: 'NOT_PROCESSED' });
  assert.equal(v.w.state.calls.createCheck ?? 0, 0);
  assert.deepEqual(published(v.w.state).map(c => c.id), [990001]);
  assert.equal((await readRolePublication(journal, mutexOf('gitleaks'))).holder, null);
  const entry = entryResultOf(r);
  assert.deepEqual([entry.status, entry.reason, entry.relay.map(x => x.outcome)], ['RELAY_COMPLETE', 'ROLE_ALREADY_ON_GITHUB', ['ON_GITHUB', 'NOT_PROCESSED']]);
});

test('C4 v2 local: a role already on GitHub from another node ends cleanly; what this journal knows keeps its path', async t => {
  const v = v2World(); v.w.allHosted(); v.w.state.checkRuns.push(otherNodeRun('gitleaks'));
  const journal = await journalFor(t);
  const job = v.localJob('gitleaks');
  const r = await v.publisher(journal, null).publish({ job, envelope: v.signed(job) });
  assert.deepEqual([r.status, r.reason, r.sideEffects], ['BLOCKED', 'role_already_on_github', 0]);
  assert.equal(await journal.read(r.effectKey), null, 'no effect key');
  assert.equal((await readRolePublication(journal, mutexOf('gitleaks'))).holder, null, 'no K');
  assert.equal(v.w.state.calls.createCheck ?? 0, 0);
  assert.equal(outcomeFailureCode({ status: r.status, reason: r.reason, sideEffects: 0, mayHavePublished: false }, 3), 'ROLE_ALREADY_ON_GITHUB');
  // A role this journal knows: its own settled publication is re-verified (its check on GitHub is its own), never refused.
  const trivy = v.localJob('trivy');
  assert.equal((await v.publisher(journal, null).publish({ job: trivy, envelope: v.signed(trivy) })).status, 'SETTLED');
  const again = await v.publisher(journal, null).publish({ job: trivy, envelope: v.signed(trivy) });
  assert.deepEqual([again.status, again.sideEffects], ['SETTLED', 0]);
  // K held by the other path stays role_already_published_on_head (HALT), even when GitHub also carries the check.
  const w2 = v2World(); w2.w.allHosted();
  const j2 = await journalFor(t);
  assert.deepEqual(rowsOf(await w2.stage(j2).run({ subject: w2.subjectOf(), attempt: 1, roles: ['gitleaks'] })), { gitleaks: 'RELAYED' });
  const late = w2.localJob('gitleaks');
  const refused = await w2.publisher(j2, null).publish({ job: late, envelope: w2.signed(late) });
  assert.deepEqual([refused.status, refused.reason], ['BLOCKED', 'role_already_published_on_head']);
});

test('C4 v2: a read-back that is not complete refuses before K on both paths (fail closed), and the relay leaves the role local', async t => {
  const v = v2World({ wrapGithub: g => ({ ...g, async readAppChecks() { throw Object.assign(new Error('incomplete_checks'), { code: 'incomplete_checks' }); } }) });
  v.w.allHosted();
  const journal = await journalFor(t);
  const r = await v.stage(journal).run({ subject: v.subjectOf(), attempt: 1, roles: ['gitleaks'] });
  assert.deepEqual(rowsOf(r), { gitleaks: 'LOCAL_REQUIRED:RELAY_NOT_ATTESTED_NOT_ADMITTED' });
  const job = v.localJob('gitleaks');
  const local = await v.publisher(journal, null).publish({ job, envelope: v.signed(job) });
  assert.deepEqual([local.status, local.reason, local.sideEffects], ['BLOCKED', 'incomplete_checks', 0]);
  assert.equal((await readRolePublication(journal, mutexOf('gitleaks'))).holder, null);
  assert.equal(v.w.state.calls.createCheck ?? 0, 0);
  assert.equal(outcomeFailureCode({ status: 'BLOCKED', reason: 'incomplete_checks', sideEffects: 0, mayHavePublished: false }, 3), 'PUBLICATION_BLOCKED');
});

test('C4 stage fact: an ON_GITHUB plan is a completed stage R exactly when the outcome says ROLE_ALREADY_ON_GITHUB', async t => {
  const f = await stageRFixture(t);
  const ok = await invokeR(f, relayBroker(f, { status: 'RELAY_COMPLETE', reason: 'ROLE_ALREADY_ON_GITHUB', sideEffects: 0, relay: [onGithub('gitleaks'), notProcessed('trivy')] }));
  assert.equal(ok.state, 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION');
  assert.deepEqual(ok.relay.map(r => `${r.role}:${r.outcome}`), ['gitleaks:ON_GITHUB', 'trivy:NOT_PROCESSED']);
  for (const [reason, relay] of [[null, [onGithub('gitleaks'), notProcessed('trivy')]], ['ROLE_ALREADY_ON_GITHUB', [relayed('gitleaks'), local('trivy')]],
    ['ROLE_ALREADY_ON_GITHUB', [onGithub('gitleaks'), relayed('trivy')]], ['ROLE_ALREADY_ON_GITHUB', [notProcessed('gitleaks'), onGithub('trivy')]],
    ['SOMETHING_ELSE', [relayed('gitleaks'), local('trivy')]]]) {
    const g = await stageRFixture(t);
    const bad = await invokeR(g, relayBroker(g, { status: 'RELAY_COMPLETE', reason, sideEffects: 0, relay }));
    assert.equal(bad.failure_code, 'RELAY_PLAN_UNCONFIRMED', JSON.stringify([reason, relay.map(r => r.outcome)]));
  }
});

test('C4 stage-fact catalogue: both codes are clean and final, and only on a clean BLOCKED with zero side effects', () => {
  for (const c of ['HEAD_PUBLISHED_ON_GITHUB', 'ROLE_ALREADY_ON_GITHUB']) assert.ok(CLEAN_FINAL_CODES.includes(c) && ALL_STAGE_CODES.includes(c) && !UNKNOWN_CODES.includes(c), c);
  const o = (reason, sideEffects = 0) => ({ status: 'BLOCKED', reason, sideEffects, mayHavePublished: sideEffects !== 0 });
  assert.equal(outcomeFailureCode(o('HEAD_PUBLISHED_ON_GITHUB'), 1), 'HEAD_PUBLISHED_ON_GITHUB');
  assert.equal(outcomeFailureCode(o('HEAD_PUBLISHED_ON_GITHUB'), 3), 'PUBLICATION_BLOCKED', 'only stage 1 ends a head this way');
  for (const stage of [3, 5, 7]) assert.equal(outcomeFailureCode(o('role_already_on_github'), stage), 'ROLE_ALREADY_ON_GITHUB');
  assert.equal(outcomeFailureCode(o('ROLE_ALREADY_ON_GITHUB'), 8), 'ROLE_ALREADY_ON_GITHUB');
  assert.equal(outcomeFailureCode(o('role_already_on_github', 1), 3), 'PUBLICATION_UNCERTAIN', 'a write may have happened: never clean');
  assert.equal(outcomeFailureCode({ status: 'UNCERTAIN', reason: 'ROLE_ALREADY_ON_GITHUB', sideEffects: 1, mayHavePublished: true }, 8), 'PUBLICATION_UNCERTAIN');
});

// Generation 13 (DESIGN §57.2, review round 6 MAJOR 1): a newer run attempt of a role the relay already settled on this head resolves to
// that publication by re-verifying it, a complete boundary inside the pre-write observation window. With too little of the window left
// for one, the relay stops having written nothing, says what is true (K is another holder's: REFUSED role_already_published_on_head,
// review round 7 MINOR 2) and the settled check stays; with enough, it is re-verified and stays settled.
test('v2 relay: re-verifying another run\'s settled publication needs room for a complete boundary in the pre-write window', async t => {
  for (const [left, expected] of [[15_000, 'REFUSED'], [60_000, 'SETTLED']]) {
    const v = v2World({ admissionMs: 20_000 }); v.w.allHosted();
    const journal = await journalFor(t);
    const real = v.w.verifier();
    const verifier = { fixture: true, registrySha256: real.registrySha256, publisherAppId: real.publisherAppId,
      async confirm(e) { return { confirmed: true, attestationSha256: e.attestationSha256 }; } };
    const { verdicts } = await real.attest({ subject: v.subjectOf(), roles: ['gitleaks'] });
    const first = await v.publisher(journal, verifier).publishHosted({ subject: v.subjectOf(), attempt: 1, envelope: verdicts.gitleaks.envelope });
    assert.equal(first.status, 'SETTLED', JSON.stringify(first));
    const { attestationSha256: _old, ...rest } = { ...verdicts.gitleaks.envelope, runAttempt: '2' };
    v.w.state.windowLeft = left;
    const newer = await v.publisher(journal, verifier).publishHosted({ subject: v.subjectOf(), attempt: 1, envelope: { ...rest, attestationSha256: digestOf(rest) } });
    if (expected === 'REFUSED') assert.deepEqual([newer.status, newer.reason, newer.detail, newer.sideEffects, newer.roleMutex.held],
      ['REFUSED', 'role_already_published_on_head', 'publication_window_short_before_write', 0, false], JSON.stringify(newer));
    else assert.deepEqual([newer.status, newer.checkRunId], ['SETTLED', first.checkRunId], JSON.stringify(newer));
    const checks = published(v.w.state);
    assert.deepEqual(checks.map(c => c.conclusion), ['success'], 'the settled check is never withdrawn for want of time');
  }
});

// Review rounds 7 and 8 (MINOR 2 / MINOR 1 and 2): through stage R, a newer run that cannot use the window HALTs the stage
// (ROLE_ALREADY_PUBLISHED_ON_HEAD) with the real cause as the row's detail, whether the window was too short for its re-verification
// after K was refused (15 s left) or already for the write before K (4 s left); the role is never sent to the local path (whose
// publication the same K would refuse after a wasted scan), and the settled check is not withdrawn.
for (const left of [15_000, 4_000]) test(`v2 relay stage: a newer run with ${left / 1000} s of the window left HALTs the stage with the window as its detail, never LOCAL_REQUIRED`, async t => {
  const v = v2World({ admissionMs: 20_000 }); v.w.allHosted();
  const journal = await journalFor(t);
  const first = await v.stage(journal).run({ subject: v.subjectOf(), attempt: 1, roles: ['gitleaks'] });
  assert.deepEqual(rowsOf(first), { gitleaks: 'RELAYED' });
  const real = v.w.verifier();
  const newerRun = { ...real, fixture: true, registrySha256: real.registrySha256, publisherAppId: real.publisherAppId,
    async attest(input) {
      const out = await real.attest(input);
      const { attestationSha256: _old, ...rest } = { ...out.verdicts.gitleaks.envelope, runAttempt: '2' };
      return { ...out, verdicts: { ...out.verdicts, gitleaks: { ...out.verdicts.gitleaks, envelope: { ...rest, attestationSha256: digestOf(rest) } } } };
    },
    async confirm(e) { return { confirmed: true, attestationSha256: e.attestationSha256 }; } };
  v.w.state.windowLeft = left;
  const stage = createHostedRelayStage({ registry: v.w.registry, verifier: newerRun, publisher: v.publisher(journal, newerRun), localInputPins: v.localInputPins });
  const r = await stage.run({ subject: v.subjectOf(), attempt: 1, roles: ['gitleaks'] });
  assert.deepEqual([r.status, r.code, rowsOf(r), r.roles[0].detail], ['HALT', 'ROLE_ALREADY_PUBLISHED_ON_HEAD', { gitleaks: 'HALT:ROLE_ALREADY_PUBLISHED_ON_HEAD' },
    'publication_window_short_before_write'], JSON.stringify(r));
  assert.deepEqual(published(v.w.state).map(c => c.conclusion), ['success'], 'the settled check stays');
});

// Review round 9, NIT 2: the two cases in which a refusal before K stays the plain BLOCKED (the role stays local): K cannot be read, and
// K is this relay's own effect key (claimed by an earlier try that stopped before its own record).
test('v2 relay: a refusal before K stays BLOCKED when K cannot be read or is held by this relay itself', async t => {
  const mutex = { repo: REPO, headSha: H, role: 'gitleaks', checkName: 'gitleaks', appId: 5368905 };
  const roleKey = rolePublicationKey(mutex);
  for (const kind of ['unreadable', 'own']) {
    const v = v2World(); v.w.allHosted();
    const raw = await journalFor(t);
    const journal = { read: async k => { if (kind === 'unreadable' && k === roleKey) throw Object.assign(new Error('journal_read_unconfirmed'), { code: 'journal_read_unconfirmed' }); return raw.read(k); },
      begin: (...a) => raw.begin(...a), transition: (...a) => raw.transition(...a) };
    const real = v.w.verifier();
    const verifier = { fixture: true, registrySha256: real.registrySha256, publisherAppId: real.publisherAppId,
      async confirm(e) { return { confirmed: true, attestationSha256: e.attestationSha256 }; } };
    const { verdicts } = await real.attest({ subject: v.subjectOf(), roles: ['gitleaks'] });
    const envelope = verdicts.gitleaks.envelope;
    if (kind === 'own') {
      const externalId = relayExternalId({ role: 'gitleaks', headSha: H, runId: envelope.runId, runAttempt: envelope.runAttempt });
      const key = digestOf({ action: 'hosted-relay-check/2', roleMutexKey: roleKey, externalId, definition: { name: 'gitleaks', appId: 5368905 } });
      await claimRolePublication(raw, mutex, { path: 'relay', effectKey: key, externalId });
      v.w.state.windowLeft = 4_000; // the write cannot fit: a refusal before K
    }
    const r = await v.publisher(journal, verifier).publishHosted({ subject: v.subjectOf(), attempt: 1, envelope });
    assert.deepEqual([r.status, r.reason, r.sideEffects, r.roleMutex.held],
      ['BLOCKED', kind === 'own' ? 'publication_window_short_before_write' : 'journal_read_unconfirmed', 0, false], JSON.stringify(r));
    assert.equal(published(v.w.state).length, 0);
  }
});
