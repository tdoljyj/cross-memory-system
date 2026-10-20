// Stage R and hosted publication (S17/S18, design §5 E9/E10, §7.3, §7.4, §11):
// fresh Native admission, K(head, role) against the local path, never a second
// publication, and RELAY_PUBLICATION_UNCERTAIN for every unsettled write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EffectJournal, readRolePublication, rolePublicationKey } from '../src/effect-journal.mjs';
import { createHostedRelayStage } from '../src/hosted-relay-v1/stage.mjs';
import { createStagedCheckPublisher } from '../src/staged-check-publisher.mjs';
import { digest } from '../src/proof.mjs';
import { validateRegistry } from '../src/hosted-relay-v1/registry.mjs';
import { H, OTHER, REPO, ROLES, createWorld, published } from './fixtures/hosted-relay/world.mjs';

async function journalFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-relay-stage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return EffectJournal.open(dir);
}
const run = (stage, w, roles = [...ROLES], attempt = 1) => stage.run({ subject: w.subject(), attempt, roles });
const outcomes = result => Object.fromEntries(result.roles.map(row => [row.role, row.reason ? `${row.outcome}:${row.reason}` : row.outcome]));
const mutexOf = (w, role, attempt = 1) => ({ repo: REPO, headSha: H, role, checkName: role, appId: 5368905, attempt });

test('three attested roles are relayed once by 5368905 under the required names', async t => {
  const w = createWorld(); const runs = w.allHosted();
  const journal = await journalFor(t);
  const { stage } = w.stage(journal);
  const result = await run(stage, w);
  assert.equal(result.status, 'COMPLETE'); assert.equal(result.code, null);
  assert.deepEqual(outcomes(result), { 'contract-placement': 'RELAYED', gitleaks: 'RELAYED', trivy: 'RELAYED' });
  assert.equal(result.sideEffects, 3);
  const checks = published(w.state);
  assert.deepEqual(checks.map(c => c.name).sort(), [...ROLES]);
  for (const row of result.roles) {
    const check = checks.find(c => c.id === row.checkRunId);
    assert.equal(check.name, row.role); // the required name, never the hosted job name
    assert.equal(check.conclusion, 'success');
    assert.equal(check.external_id, `independent-ci:relay:${row.role}:${H.slice(0, 12)}:run${runs[row.role].runId}:a1`);
    assert.equal(check.output.title, `${row.role}: success`);
    assert.ok(check.output.summary.includes(`actions/runs/${runs[row.role].runId}`) && check.output.summary.includes(row.attestationSha256));
    assert.ok(!check.output.summary.includes('eyJ'), 'no token in the published output');
    assert.equal(row.receipt, 'relay-attested');
    const mutex = await readRolePublication(journal, mutexOf(w, row.role));
    assert.deepEqual(mutex.holder, { path: 'relay', effectKey: row.effectKey, externalId: check.external_id });
    assert.equal((await journal.read(row.effectKey)).state, 'settled');
  }
  const { resultSha256, ...body } = result;
  assert.equal(resultSha256, digest(body));
});

test('a second stage run for the same head re-reads and never publishes again', async t => {
  const w = createWorld(); w.allHosted();
  const journal = await journalFor(t);
  const first = await run(w.stage(journal).stage, w);
  const second = await run(w.stage(journal).stage, w);
  assert.deepEqual(outcomes(second), outcomes(first));
  assert.equal(second.sideEffects, 0);
  assert.equal(published(w.state).length, 3);
  assert.equal(w.state.calls.createCheck, 3);
});

test('E9: a fresh Native admission refusal leaves every role local and writes nothing', async t => {
  const w = createWorld(); w.allHosted(); w.state.faults.native = true;
  const journal = await journalFor(t);
  const result = await run(w.stage(journal).stage, w);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(outcomes(result), Object.fromEntries(ROLES.map(role => [role, 'LOCAL_REQUIRED:RELAY_NOT_ATTESTED_NOT_ADMITTED'])));
  assert.equal(result.roles[0].detail, 'full_admission_not_proven');
  assert.equal(w.state.calls.createCheck, undefined);
  for (const role of ROLES) assert.equal((await readRolePublication(journal, mutexOf(w, role))).holder, null);
  // The local path is still open for the role.
  delete w.state.faults.native;
  const job = w.localJob('gitleaks');
  const local = await w.publisher(journal).publish({ job, envelope: w.signedResult(job) });
  assert.equal(local.status, 'SETTLED');
});

test('a mixed head: relayed, billing-refused and pending roles in one stage', async t => {
  const w = createWorld();
  w.addHostedRun('gitleaks');
  w.addHostedRun('trivy', { name: 'admission-gate', conclusion: 'failure', annotations: [{ annotation_level: 'failure', title: '', path: '.github',
    message: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.' }] });
  w.addHostedRun('trivy', { conclusion: 'skipped' });
  w.addHostedRun('contract-placement', { status: 'in_progress' });
  const result = await run(w.stage(await journalFor(t)).stage, w);
  assert.deepEqual(outcomes(result), { 'contract-placement': 'LOCAL_REQUIRED:RELAY_NOT_ATTESTED_PENDING', gitleaks: 'RELAYED',
    trivy: 'LOCAL_REQUIRED:RELAY_NOT_ATTESTED_BILLING_REFUSED' });
  const rows = Object.fromEntries(result.roles.map(row => [row.role, row]));
  assert.equal(rows.trivy.receipt, 'relay-billing-refused');
  assert.equal(rows['contract-placement'].receipt, 'relay-local-fallback');
  assert.equal(rows['contract-placement'].detail, 'E5_HOSTED_IN_PROGRESS');
  assert.equal(published(w.state).length, 1);
});

test('an unconfirmed POST is RELAY_PUBLICATION_UNCERTAIN: HALT, later roles untouched, the role locked against local', async t => {
  const w = createWorld(); w.allHosted(); w.state.faults.createCheck = 'lost-no-write';
  const journal = await journalFor(t);
  const result = await run(w.stage(journal).stage, w, ['gitleaks', 'trivy', 'contract-placement']);
  assert.equal(result.status, 'HALT'); assert.equal(result.code, 'RELAY_PUBLICATION_UNCERTAIN');
  assert.deepEqual(outcomes(result), { gitleaks: 'HALT:RELAY_PUBLICATION_UNCERTAIN', trivy: 'NOT_PROCESSED', 'contract-placement': 'NOT_PROCESSED' });
  assert.equal(w.state.calls.createCheck, 1);
  assert.equal((await journal.read(result.roles[0].effectKey)).state, 'uncertain');
  delete w.state.faults.createCheck;
  const job = w.localJob('gitleaks');
  const local = await w.publisher(journal).publish({ job, envelope: w.signedResult(job) });
  assert.deepEqual([local.status, local.reason], ['BLOCKED', 'role_already_published_on_head']);
  // Re-running the stage never resends the uncertain publication.
  const again = await run(w.stage(journal).stage, w, ['gitleaks']);
  assert.equal(again.code, 'RELAY_PUBLICATION_UNCERTAIN');
  assert.equal(w.state.calls.createCheck, 1);
});

test('a check found after a lost reply, or a read-back that disagrees, is revoked and still HALTs', async t => {
  for (const mode of ['lost-after-write', 'tamper']) {
    const w = createWorld(); w.allHosted(); w.state.faults.createCheck = mode;
    const result = await run(w.stage(await journalFor(t)).stage, w, ['trivy']);
    assert.equal(result.code, 'RELAY_PUBLICATION_UNCERTAIN', mode);
    assert.match(result.roles[0].detail, /^REVOKED:/, mode);
    const [check] = published(w.state);
    assert.equal(check.conclusion, 'failure', mode);
    assert.equal(w.state.calls.createCheck, 1, mode);
  }
});

test('K(head, role): whichever path begins first wins; the other is refused', async t => {
  // Local first: the relay refuses and the stage HALTs.
  let w = createWorld(); w.allHosted();
  let journal = await journalFor(t);
  const job = w.localJob('gitleaks');
  assert.equal((await w.publisher(journal).publish({ job, envelope: w.signedResult(job) })).status, 'SETTLED');
  let result = await run(w.stage(journal).stage, w, ['gitleaks', 'trivy']);
  assert.equal(result.code, 'ROLE_ALREADY_PUBLISHED_ON_HEAD');
  assert.deepEqual(outcomes(result), { gitleaks: 'HALT:ROLE_ALREADY_PUBLISHED_ON_HEAD', trivy: 'NOT_PROCESSED' });
  assert.deepEqual(published(w.state).map(c => c.external_id.split(':')[1]), ['staged']);
  // Relay first: the local publication of that role is refused before its own key.
  w = createWorld(); w.allHosted();
  journal = await journalFor(t);
  result = await run(w.stage(journal).stage, w, ['gitleaks']);
  assert.deepEqual(outcomes(result), { gitleaks: 'RELAYED' });
  const late = w.localJob('gitleaks');
  const local = await w.publisher(journal).publish({ job: late, envelope: w.signedResult(late) });
  assert.deepEqual([local.status, local.reason, local.sideEffects], ['BLOCKED', 'role_already_published_on_head', 0]);
  assert.equal(await journal.read(local.effectKey), null);
  // A hosted re-run after publication changes nothing: the newer run is refused by K.
  w.addHostedRun('gitleaks');
  result = await run(w.stage(journal).stage, w, ['gitleaks']);
  assert.equal(result.code, 'ROLE_ALREADY_PUBLISHED_ON_HEAD');
  assert.equal(published(w.state).length, 1);
  // Attempt 2 (Owner-opened) is a different K.
  assert.notEqual(rolePublicationKey(mutexOf(w, 'gitleaks', 2)), rolePublicationKey(mutexOf(w, 'gitleaks', 1)));
});

test('the publisher re-attests from fresh facts: a newer re-run or a moved main leaves the role local', async t => {
  for (const change of [w => w.addHostedRun('gitleaks', { status: 'in_progress' }), w => { w.state.mainTip = OTHER;
    w.state.compares.set(`${OTHER}...${H}`, { status: 'ahead', ahead_by: 1, behind_by: 0 }); }]) {
    const w = createWorld(); w.allHosted();
    const journal = await journalFor(t);
    const { verifier } = w.stage(journal);
    const racing = { ...verifier, async attest(input) { const first = await verifier.attest(input); change(w); return first; } };
    const stage = createHostedRelayStage({ registry: w.registry, verifier: racing, publisher: w.publisher(journal, verifier) });
    const result = await run(stage, w, ['gitleaks']);
    assert.deepEqual(outcomes(result), { gitleaks: 'LOCAL_REQUIRED:RELAY_NOT_ATTESTED_NOT_CONFIRMED' });
    assert.equal(result.roles[0].detail, 'hosted_attestation_not_confirmed');
    assert.equal(w.state.calls.createCheck, undefined);
    assert.equal((await readRolePublication(journal, mutexOf(w, 'gitleaks'))).holder, null);
  }
});

test('a resealed envelope naming another run is re-attested and refused before any write', async t => {
  const w = createWorld(); w.allHosted();
  const journal = await journalFor(t);
  const verifier = w.verifier();
  const { verdicts } = await verifier.attest({ subject: w.subject(), roles: ['gitleaks'] });
  const { attestationSha256, ...rest } = { ...verdicts.gitleaks.envelope, runAttempt: '2' };
  const forged = { ...rest, attestationSha256: digest(rest) };
  const out = await w.publisher(journal, verifier).publishHosted({ subject: w.subject(), attempt: 1, envelope: forged });
  assert.deepEqual([out.status, out.reason, out.roleMutex.held], ['BLOCKED', 'hosted_attestation_not_confirmed', false]);
  // The Ed25519 entry never accepts a hosted-attestation envelope.
  const job = w.localJob('gitleaks');
  const wrongEntry = await w.publisher(journal, verifier).publish({ job, envelope: verdicts.gitleaks.envelope });
  assert.deepEqual([wrongEntry.status, wrongEntry.reason], ['BLOCKED', 'execution_proof_refused']);
  // Subject and definition must agree with the envelope.
  const mismatch = await w.publisher(journal, verifier).publishHosted({ subject: { ...w.subject(), pr: 8 }, attempt: 1, envelope: verdicts.gitleaks.envelope });
  assert.equal(mismatch.reason, 'hosted_subject_mismatch');
  assert.equal(w.state.calls.createCheck, undefined);
  // Without an installed hosted verifier the hosted entry is closed.
  const closed = createStagedCheckPublisher({ nativeAdmission: w.nativeAdmission, authority: w.authority, github: w.github, journal, signers: w.signers,
    configuredChecks: { gitleaks: { name: 'gitleaks', appId: 5368905 } }, readChangedPaths: w.github.readChangedPaths, clock: () => w.state.now, domain: 'fixture',
    protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: '11111111-2222-4333-8444-555555555555',
      sourceAcceptanceRef: 'x', hostQualificationRef: 'x', ownerAuthorizationRef: 'x', publisherQualificationRef: 'x', ciPrincipalQualificationRef: 'x' } });
  assert.equal((await closed.publishHosted({ subject: w.subject(), attempt: 1, envelope: verdicts.gitleaks.envelope })).reason, 'hosted_relay_not_configured');
});

test('observation failure keeps every role local; invalid input and mixed domains are refused', async t => {
  const w = createWorld(); w.allHosted(); w.state.faults.readPullRequest = 'github_http_502';
  const journal = await journalFor(t);
  const { stage } = w.stage(journal);
  const result = await run(stage, w);
  assert.deepEqual(outcomes(result), Object.fromEntries(ROLES.map(role => [role, 'LOCAL_REQUIRED:RELAY_NOT_ATTESTED_OBSERVATION_UNCONFIRMED'])));
  assert.equal(result.roles[0].detail, 'RELAY_OBSERVATION_UNCONFIRMED:pull_request:github_http_502');
  assert.equal(result.sideEffects, 0);
  for (const input of [{ subject: w.subject(), attempt: 0, roles: ['gitleaks'] }, { subject: w.subject(), attempt: 1, roles: ['kooyumi-merge-slot'] },
    { subject: { ...w.subject(), repo: 'attacker/cross-memory-system' }, attempt: 1, roles: ['gitleaks'] }, { subject: w.subject(), attempt: 1, roles: [] },
    { subject: w.subject(), attempt: 1, roles: ['gitleaks', 'gitleaks'] }, { subject: w.subject(), attempt: 1, roles: ['gitleaks'], extra: true }]) {
    const refused = await stage.run(input);
    assert.deepEqual([refused.status, refused.code, refused.sideEffects], ['REFUSED', 'RELAY_STAGE_INPUT_INVALID', 0]);
  }
  const production = validateRegistry({ ...structuredClone(w.registry), domain: 'production' });
  const mixed = createHostedRelayStage({ registry: production, verifier: w.verifier(), publisher: w.publisher(journal) });
  assert.equal((await mixed.run({ subject: w.subject(), attempt: 1, roles: ['gitleaks'] })).code, 'RELAY_STAGE_NOT_CONFIGURED');
});

test('the local path keeps working with K and re-enters a settled publication without a second POST', async t => {
  const w = createWorld();
  const journal = await journalFor(t);
  const job = w.localJob('trivy');
  const envelope = w.signedResult(job);
  const first = await w.publisher(journal).publish({ job, envelope });
  assert.equal(first.status, 'SETTLED');
  const again = await w.publisher(journal).publish({ job, envelope });
  assert.deepEqual([again.status, again.sideEffects], ['SETTLED', 0]);
  assert.equal(w.state.calls.createCheck, 1);
  const mutex = await readRolePublication(journal, mutexOf(w, 'trivy'));
  assert.equal(mutex.holder.path, 'local');
  assert.equal(mutex.holder.effectKey, first.effectKey);
});
