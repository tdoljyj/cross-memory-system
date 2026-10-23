// Resident primary/standby design v0.4 §6.1-§6.4 (C4, Task c2af8d17): GitHub is the shared record of what App 5368905
// already published on a head. Stage 1 stops a published head before Native is asked (HEAD_PUBLISHED_ON_GITHUB); a role
// this node knows nothing of but finds on GitHub ends cleanly (ROLE_ALREADY_ON_GITHUB; stage R: an ON_GITHUB row).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { batchJobsV2 } from '../src/job-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../src/batch-claim-v2.mjs';
import { CHECKS_V2 } from '../src/resident-v2/prepare-record.mjs';
import { HEAD_PUBLISHED_ON_GITHUB, PUBLISHED_ROLE_CHECK_NAMES, PUBLISHER_APP_ID, ROLE_ALREADY_ON_GITHUB, publishedNames, readPublishedChecks } from '../src/published-on-github-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { createHostedRelayStage } from '../src/hosted-relay-v1/stage.mjs';
import { entryResultOf, planRowOf, relayPlanEnding, validateRelayPlanRows } from '../src/hosted-relay-v1/relay-plan.mjs';
import { HEAD, BASE, tempDir, admittedFacts } from './resident-v2-fixtures.mjs';
import { createWorld } from './fixtures/hosted-relay/world.mjs';

const REPO = 'tdoljyj/cross-memory-system', APP = 5368905, OTHER_APP = 15368;
const iso = ms => new Date(ms).toISOString();
const jobsFor = (attempt = 1) => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt });
const claim = () => ({ claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) });
const run = (id, name, { app = APP, head = HEAD, conclusion = 'success' } = {}) => ({ id, name, head_sha: head, status: 'completed', conclusion, app: { id: app }, external_id: `independent-ci:${name}` });

// The GitHub port as the publishers see it; `seed` are check runs some other node or install published earlier.
function fakeGithub(seed = [], { narrowed = true } = {}) {
  const checks = seed.map(c => structuredClone(c)); let next = 1000;
  const calls = { readChangedPaths: 0, readChecks: 0, readAppChecks: 0, createCheck: 0 };
  const port = { fixture: true, checks, calls,
    async readChangedPaths(job) { calls.readChangedPaths++; return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readChecks(head) { calls.readChecks++; return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { calls.createCheck++; const c = { id: next++, app: { id: APP }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
  if (narrowed) port.readAppChecks = async head => { calls.readAppChecks++; return { complete: true, checks: checks.filter(c => c.head_sha === head && c.app.id === APP).map(c => structuredClone(c)) }; };
  return port;
}
// Native's merge-slot deadline does not move between the observations before and after the write.
const SLOT_UNTIL = Date.now() + 3600_000;
function fakeAdmission(c) {
  let calls = 0;
  return { fixture: true, get calls() { return calls; }, async evaluatePr(job, packet) { calls++; return admittedFacts(job, c, packet, { domain: 'fixture', slotUntil: SLOT_UNTIL }); } };
}
async function stageOne(t, github) {
  const dir = await tempDir(t);
  const batchClaims = { dir, read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } },
    record: (j, c, at) => recordBatchClaim(dir, j, c, at) };
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const c = claim(), admission = fakeAdmission(c);
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims });
  return { pub, admission, batchClaims, journal, c };
}

// ---- the read-back (published-on-github-v2.mjs) ----

test('the published names are every required check but kooyumi-work-admission, of App 5368905', () => {
  assert.equal(PUBLISHER_APP_ID, APP);
  assert.deepEqual([...PUBLISHED_ROLE_CHECK_NAMES].sort(), Object.entries(CHECKS_V2).filter(([role]) => role !== 'work-admission').map(([, d]) => d.name).sort());
  assert.ok(Object.values(CHECKS_V2).every(d => d.appId === APP));
  assert.equal(HEAD_PUBLISHED_ON_GITHUB, 'HEAD_PUBLISHED_ON_GITHUB');
  assert.equal(ROLE_ALREADY_ON_GITHUB, 'ROLE_ALREADY_ON_GITHUB');
});

test('read-back: this App only, every run of a name (filter=all), from the narrowed read or the complete inventory', async () => {
  const seed = [run(1, 'gitleaks', { conclusion: 'failure' }), run(2, 'gitleaks'), run(3, 'trivy', { app: OTHER_APP }), run(4, 'kooyumi-work-admission'), run(5, 'trivy', { head: 'c'.repeat(40) })];
  for (const narrowed of [true, false]) {
    const github = fakeGithub(seed, { narrowed });
    assert.deepEqual((await readPublishedChecks(github, HEAD)).map(c => c.id), [1, 2, 4]);
    assert.deepEqual(await publishedNames(github, HEAD, PUBLISHED_ROLE_CHECK_NAMES), ['gitleaks']);
    assert.equal(narrowed ? github.calls.readAppChecks : github.calls.readChecks, 2);
    assert.equal(narrowed ? github.calls.readChecks : github.calls.readAppChecks, 0);
  }
  assert.deepEqual(await publishedNames(fakeGithub([]), HEAD, PUBLISHED_ROLE_CHECK_NAMES), []);
});

test('read-back fails closed on anything but one complete, exact list', async () => {
  const reply = list => ({ async readAppChecks() { return list; } });
  const bad = [
    null, { complete: false, checks: [] }, { complete: true }, { complete: true, checks: [run(1, 'gitleaks'), run(1, 'trivy')] },
    { complete: true, checks: [run(1, 'gitleaks', { head: 'c'.repeat(40) })] }, { complete: true, checks: [{ ...run(1, 'gitleaks'), app: null }] },
    { complete: true, checks: [{ ...run(1, 'gitleaks'), name: 7 }] }, { complete: true, checks: [{ ...run(1, 'gitleaks'), id: 0 }] },
    // the narrowed read must hold this App's runs only
    { complete: true, checks: [run(1, 'gitleaks', { app: OTHER_APP })] },
  ];
  for (const list of bad) await assert.rejects(readPublishedChecks(reply(list), HEAD), { code: 'published_checks_unconfirmed' });
  await assert.rejects(readPublishedChecks({}, HEAD), { code: 'published_checks_unconfirmed' });
  await assert.rejects(readPublishedChecks(fakeGithub(), 'not-a-sha'), { code: 'published_checks_unconfirmed' });
  await assert.rejects(publishedNames(fakeGithub(), HEAD, []), { code: 'published_checks_unconfirmed' });
  // The port's own refusals (github.mjs#inventory: pagination, page limit, transport) keep their codes.
  for (const code of ['incomplete_checks', 'checks_page_limit', 'checks_pagination_changed', 'github_transport_unconfirmed']) {
    await assert.rejects(readPublishedChecks({ async readAppChecks() { throw Object.assign(new Error(code), { code }); } }, HEAD), { code });
  }
});

// ---- stage 1 ----

test('stage 1: a head carrying any role or control check of this App ends before Native, whatever its conclusion', async t => {
  for (const name of PUBLISHED_ROLE_CHECK_NAMES) for (const conclusion of ['success', 'failure']) {
    const github = fakeGithub([run(7, name, { conclusion })]);
    const { pub, admission, batchClaims } = await stageOne(t, github);
    const job = jobsFor()['work-admission'];
    const r = await pub.publish(job);
    assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun, r.productionAuthorized], ['BLOCKED', HEAD_PUBLISHED_ON_GITHUB, 0, false, false], name);
    assert.deepEqual(r.publishedChecks, [name]);
    // Never reached Native (so never the Task's CI meter), never read the PR files, recorded no claim, published nothing.
    assert.equal(admission.calls, 0);
    assert.equal(github.calls.readChangedPaths, 0);
    assert.equal(await batchClaims.read(job), null);
    assert.equal(github.calls.createCheck, 0);
  }
});

test('stage 1: kooyumi-work-admission of an earlier attempt and checks of other Apps do not count', async t => {
  const github = fakeGithub([run(7, 'kooyumi-work-admission'), run(8, 'gitleaks', { app: OTHER_APP }), run(9, 'kooyumi-merge-slot', { app: OTHER_APP })], { narrowed: false });
  const { pub, admission } = await stageOne(t, github);
  const r = await pub.publish(jobsFor(2)['work-admission']);
  assert.deepEqual([r.status, r.sideEffects], ['SETTLED', 1]);
  assert.equal(admission.calls, 2);
});

test('stage 1: a read-back that is not complete refuses before Native (fail closed), keeping the port code', async t => {
  for (const code of ['incomplete_checks', 'checks_page_limit', 'github_transport_unconfirmed', 'published_checks_unconfirmed']) {
    const github = fakeGithub();
    github.readAppChecks = async () => { throw Object.assign(new Error(code), { code }); };
    const { pub, admission } = await stageOne(t, github);
    const r = await pub.publish(jobsFor()['work-admission']);
    assert.deepEqual([r.status, r.reason, r.sideEffects, r.safeToRerun], ['BLOCKED', code, 0, false]);
    assert.equal(admission.calls, 0);
    assert.equal(github.calls.createCheck, 0);
  }
});

test('stage 1: a batch that already recorded its claim is this node\'s own and keeps its path', async t => {
  const github = fakeGithub();
  const { pub, batchClaims } = await stageOne(t, github);
  const job = jobsFor()['work-admission'];
  assert.equal((await pub.publish(job)).status, 'SETTLED');
  // This batch's own role checks appear on the head; stage 1 of the same batch only re-verifies its settled check.
  github.checks.push(run(50, 'gitleaks'));
  assert.ok(await batchClaims.read(job));
  const again = await pub.publish(job);
  assert.deepEqual([again.status, again.sideEffects], ['SETTLED', 0]);
  assert.equal(github.calls.readAppChecks, 1);
});

// ---- stage R rows ----

function relayStage(w, answers) {
  const calls = [];
  const publisher = { fixture: true, async publishHosted(input) { calls.push(input.envelope.role); return answers[input.envelope.role]; } };
  return { stage: createHostedRelayStage({ registry: w.registry, verifier: w.verifier(), publisher, localInputPins: { trivy: { checksDigest: w.registry.roles.trivy?.checksDigest } } }), calls };
}
const onGithubAnswer = { status: 'BLOCKED', reason: 'role_already_on_github', effectKey: 'e'.repeat(64), sideEffects: 0, productionAuthorized: false, roleMutex: { key: 'k'.repeat(64), held: false } };
const relayedAnswer = { status: 'SETTLED', mode: 'hosted-relay', effectKey: 'f'.repeat(64), checkRunId: 77, externalId: `independent-ci:relay:gitleaks:${'a'.repeat(12)}:run5:a1`,
  sideEffects: 1, productionAuthorized: false, roleMutex: { key: 'k'.repeat(64), held: true } };
const outcomes = result => Object.fromEntries(result.roles.map(row => [row.role, row.reason ? `${row.outcome}:${row.reason}` : row.outcome]));

test('stage R: a role already on GitHub is an ON_GITHUB row; later relayable roles are not processed', async () => {
  const w = createWorld(); w.allHosted();
  const { stage, calls } = relayStage(w, { gitleaks: onGithubAnswer });
  const result = await stage.run({ subject: w.subject(), attempt: 1, roles: ['gitleaks', 'contract-placement', 'trivy'] });
  assert.deepEqual([result.status, result.code, result.sideEffects], ['ON_GITHUB', ROLE_ALREADY_ON_GITHUB, 0]);
  assert.deepEqual(outcomes(result), { gitleaks: `ON_GITHUB:${ROLE_ALREADY_ON_GITHUB}`, 'contract-placement': 'LOCAL_REQUIRED:RELAY_ROLE_NOT_RELAYABLE', trivy: 'NOT_PROCESSED' });
  assert.deepEqual(calls, ['gitleaks']);
  const row = result.roles[0];
  assert.deepEqual([row.receipt, row.checkRunId, row.externalId, row.detail], [null, null, null, 'role_already_on_github']);
  // The entry result is a completed relay stage whose rows say ON_GITHUB; never LOCAL_REQUIRED for that role.
  const entry = entryResultOf(result);
  assert.deepEqual([entry.status, entry.reason, entry.sideEffects], ['RELAY_COMPLETE', ROLE_ALREADY_ON_GITHUB, 0]);
  assert.ok(validateRelayPlanRows(entry.relay));
  assert.equal(relayPlanEnding(entry.relay), 'ON_GITHUB');
  assert.deepEqual(entry.relay.map(r => r.outcome), ['ON_GITHUB', 'LOCAL_REQUIRED', 'NOT_PROCESSED']);
});

test('stage R: a role relayed before the one already on GitHub is kept in the rows and its side effect counted', async () => {
  const w = createWorld(); w.allHosted();
  const { stage } = relayStage(w, { gitleaks: relayedAnswer, trivy: onGithubAnswer });
  const result = await stage.run({ subject: w.subject(), attempt: 1, roles: ['gitleaks', 'trivy'] });
  assert.deepEqual([result.status, result.sideEffects], ['ON_GITHUB', 1]);
  const entry = entryResultOf(result);
  assert.deepEqual([entry.status, entry.reason, entry.sideEffects], ['RELAY_COMPLETE', ROLE_ALREADY_ON_GITHUB, 1]);
  assert.deepEqual(entry.relay.map(r => r.outcome), ['RELAYED', 'ON_GITHUB']);
  assert.equal(relayPlanEnding(entry.relay), 'ON_GITHUB');
});

test('stage R: only a clean refusal before K with zero side effects is ON_GITHUB; any other shape HALTs, never goes local', async () => {
  for (const answer of [{ ...onGithubAnswer, roleMutex: { key: 'k'.repeat(64), held: true } }, { ...onGithubAnswer, sideEffects: 1 }, { ...onGithubAnswer, status: 'REFUSED' }]) {
    const w = createWorld(); w.allHosted();
    const { stage } = relayStage(w, { gitleaks: answer });
    const result = await stage.run({ subject: w.subject(), attempt: 1, roles: ['gitleaks'] });
    assert.equal(result.status, 'HALT');
    assert.equal(entryResultOf(result).status, 'UNCERTAIN');
  }
});

test('relay plan rows: ON_GITHUB rows and the endings the executor acts on', () => {
  const row = (role, outcome, fields = {}) => planRowOf({ role, outcome, ...fields });
  const relayed = role => row(role, 'RELAYED', { checkRunId: 9, externalId: `independent-ci:relay:${role}:${'a'.repeat(12)}:run5:a1`, attestationSha256: 'b'.repeat(64), receipt: 'relay-attested' });
  const local = (role, reason = 'RELAY_ROLE_NOT_RELAYABLE') => row(role, 'LOCAL_REQUIRED', { reason, receipt: 'relay-local-fallback' });
  const on = role => row(role, 'ON_GITHUB', { reason: ROLE_ALREADY_ON_GITHUB });
  const skipped = role => row(role, 'NOT_PROCESSED');
  assert.deepEqual(on('gitleaks'), { role: 'gitleaks', outcome: 'ON_GITHUB', reason: ROLE_ALREADY_ON_GITHUB, receipt: null, checkRunId: null, externalId: null, attestationSha256: null, detail: null });
  // An ON_GITHUB row with another reason is not one (fail closed: HALT).
  assert.equal(row('gitleaks', 'ON_GITHUB', { reason: 'RELAY_PUBLICATION_UNCERTAIN' }).outcome, 'HALT');
  assert.equal(relayPlanEnding([relayed('gitleaks'), local('contract-placement')]), 'COMPLETE');
  assert.equal(relayPlanEnding([on('gitleaks'), skipped('trivy')]), 'ON_GITHUB');
  assert.equal(relayPlanEnding([relayed('gitleaks'), on('trivy'), local('contract-placement')]), 'ON_GITHUB');
  for (const rows of [[], [skipped('gitleaks')], [relayed('gitleaks'), skipped('trivy')], [on('gitleaks'), on('trivy')], [on('gitleaks'), relayed('trivy')],
    [on('gitleaks'), local('trivy', 'RELAY_NOT_ATTESTED_PENDING')], [skipped('gitleaks'), on('trivy')], [row('gitleaks', 'HALT', { reason: 'RELAY_PUBLICATION_UNCERTAIN' })]]) {
    assert.equal(relayPlanEnding(rows), null, JSON.stringify(rows.map(r => r.outcome)));
  }
  // A stage result that says ON_GITHUB with rows that do not end so is uncertain, never a completed relay stage.
  const bad = entryResultOf({ status: 'ON_GITHUB', code: ROLE_ALREADY_ON_GITHUB, sideEffects: 0, roles: [{ role: 'gitleaks', outcome: 'NOT_PROCESSED' }] });
  assert.deepEqual([bad.status, bad.reason], ['UNCERTAIN', 'RELAY_PUBLICATION_UNCERTAIN']);
  const coded = entryResultOf({ status: 'COMPLETE', code: ROLE_ALREADY_ON_GITHUB, sideEffects: 0, roles: [local('contract-placement')] });
  assert.equal(coded.status, 'UNCERTAIN');
});
