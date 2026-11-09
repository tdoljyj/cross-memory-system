import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/proof.mjs';
import { batchJobsV2, batchRefV2, claimGeneration, admissionEffectKeyV2, admissionExternalIdV2 } from '../src/job-v2.mjs';
import * as store from '../src/batch-claim-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { createFixtureWorkAdmissionPublisherV2, createProductionWorkAdmissionPublisherV2 } from '../src/formal-work-admission-check-v2/publisher.mjs';
import { createFullAdmissionPortV2 } from '../src/full-admission-v2.mjs';
import { HEAD, BASE, tempDir } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system', iso = ms => new Date(ms).toISOString();
const jobsFor = (overrides = {}) => batchJobsV2({ repo: REPO, pr: 1043, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1, ...overrides });
const claim = (overrides = {}) => ({ claimId: randomUUID(), fence: 7, epoch: 1, expiresAt: iso(Date.now() + 3600_000), ...overrides });
const keyFor = (job, c) => admissionEffectKeyV2('native-work-admission-check/2', job, c, { appId: 5368905, name: 'kooyumi-work-admission' });

test('batch claim persists the original admission Receipt, and terminal lookup never guesses a newer generation', async t => {
  const dir = await tempDir(t), job = jobsFor()['work-admission'], c = claim();
  const terminalAdmission = { receipt_id: randomUUID(), claim_id: c.claimId, fence: c.fence,
    execution_epoch: c.epoch, lease_version: 5, head_authorization_id: randomUUID() };
  const written = await store.recordBatchClaim(dir, job, c, iso(Date.now()), terminalAdmission);
  assert.deepEqual(written.record.terminalAdmission, terminalAdmission);
  const subject = { repo: job.repo, pr: job.pr, headSha: job.headSha, sourceManifestSha256: job.sourceManifestSha256 };
  assert.deepEqual(await store.readTerminalAdmission(dir, subject), terminalAdmission);
  const replay = await store.recordBatchClaim(dir, job, c, iso(Date.now()), { ...terminalAdmission, receipt_id: randomUUID(), lease_version: 6 });
  assert.deepEqual(replay.record.terminalAdmission, terminalAdmission, 'create-only evidence is never overwritten on a replay');
  const later = jobsFor({ baseSha: 'e'.repeat(40) })['work-admission'];
  await store.recordBatchClaim(dir, later, c, iso(Date.now()), { ...terminalAdmission, receipt_id: randomUUID(), lease_version: 6 });
  assert.equal(await store.readTerminalAdmission(dir, subject), null, 'two admission CAS identities are ambiguous, not latest-wins');
  assert.equal(await store.readTerminalAdmission(dir, { ...subject, headSha: 'f'.repeat(40) }), null);
});
async function fixture(t, { old = claim(), current = claim(), journalState = null, complete = true, published = false, valid = true,
  initial = true, terminalAdmission = null } = {}) {
  const dir = await tempDir(t), job = jobsFor()['work-admission'];
  const batchClaims = { dir,
    read: async j => { try { return await store.readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } },
    record: (j, c, at, terminal) => store.recordBatchClaim(dir, j, c, at, terminal),
    rewrite: (...args) => store.rewriteUnpublishedBatchClaim(dir, ...args),
    withPublication: (...args) => store.withBatchClaimPublication(dir, ...args) };
  if (initial) await batchClaims.record(job, old, iso(Date.now()));
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  if (journalState) {
    const k = keyFor(job, old); await journal.begin(k, {});
    if (journalState === 'not_sent') await journal.transition(k, 'intent', 'not_sent');
    if (['authorized', 'sent', 'uncertain', 'settled', 'revoked'].includes(journalState)) await journal.transition(k, 'intent', 'authorized');
    if (['sent', 'uncertain', 'settled', 'revoked'].includes(journalState)) await journal.transition(k, 'authorized', 'sent');
    if (['uncertain', 'settled', 'revoked'].includes(journalState)) await journal.transition(k, 'sent', journalState);
  }
  const checks = published ? [{ id: 1, app: { id: 5368905 }, head_sha: HEAD, name: 'kooyumi-work-admission', status: 'completed', conclusion: 'failure',
    external_id: admissionExternalIdV2('independent-ci:native-work-admission', job, old) }] : [];
  const state = { current, valid, complete, failProbe: false, trailerClaim: current.claimId, taskId: randomUUID() }, calls = [];
  const github = { fixture: true, checks,
    async readChangedPaths(j) { return { complete: true, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, paths: ['a.txt'] }; },
    async readChecks() { return { complete: state.complete, checks: structuredClone(checks) }; },
    async readPullRequest() { if (state.failProbe) throw Object.assign(new Error('github_transport_unconfirmed'), { code: 'github_transport_unconfirmed' }); return {}; },
    async createCheck(payload) { const c = { id: checks.length + 100, app: { id: 5368905 }, ...structuredClone(payload) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(c => c.id === id); Object.assign(c, body); return structuredClone(c); } };
  const scope = `project:${randomUUID()}`, prRef = `${REPO}#${job.pr}`, policyText = '{"policy":"fixture"}';
  const config = { domain: 'fixture', repository: REPO, scope, workspace: os.tmpdir(), sourceManifestSha256: job.sourceManifestSha256,
    evaluatorSha256: digest('EVALUATOR'), policyText, policySha256: digest(policyText), ciPrincipalBindingId: randomUUID(),
    ciPrincipalQualificationRef: 'qualification-ref', publishableKey: 'sb_publishable_fixture', supabaseUrl: 'https://fixture.supabase.co' };
  const realAdmission = createFullAdmissionPortV2({ protectedConfig: config,
    tokenProvider: async () => ({ githubToken: 'gh-fixture', ciAdmissionToken: ['clued', 'bnd', 'fixture123'].join('_'), ciPrincipalBindingId: config.ciPrincipalBindingId, ciPrincipalQualificationRef: config.ciPrincipalQualificationRef }),
    modeProvider: async () => ({ complete: true, repository: REPO, variable: 'CLUED_MERGE_ADMISSION_STATE', source: 'github-repository-variables', exists: false, observedAt: iso(Date.now()), proofRef: 'mode-proof' }),
    recorderProvider: async () => ({ kind: 'independent-controller', domain: 'fixture', observedAt: iso(Date.now()), observationRef: 'obs', recorder: { newId: randomUUID, record() {} } }),
    fetchImpl: async url => {
      if (new URL(url).pathname.endsWith(`/pulls/${job.pr}`)) return { ok: true, status: 200, json: async () => ({ number: job.pr, state: 'open',
        body: `Fix #1043\n\nClued-Work-Claim: ${state.trailerClaim}\nClued-Work-Scope: ${scope}\n`,
        head: { sha: job.headSha, repo: { full_name: REPO } }, base: { sha: job.baseSha, ref: 'main', repo: { full_name: REPO } } }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }, fixtureHooks: { evaluatorReader: () => 'EVALUATOR', evaluateImpl: async ({ observation_recorder }) => {
      const c = state.current, n = { status: 'ok', verdict: state.valid ? 'ADMITTED' : 'REJECTED', execution_authorized: state.valid, execution_policy: 'staged',
        current_fence: c.fence, execution_epoch: c.epoch, bound_pr: prRef, pr_ref: prRef, head_sha: job.headSha, base_sha: job.baseSha,
        verified_at: iso(Date.now()), paths_outside_write_set: [], claim: { claim_id: c.claimId, task_id: state.taskId, fence: c.fence, execution_epoch: c.epoch, context_key: scope,
          status: state.valid ? 'ACTIVE' : 'SUPERSEDED', bound_pr: prRef, expires_at: c.expiresAt, lease_key_required: false, execution_handover_pending: false, merge_queue: [] } };
      if (terminalAdmission) Object.assign(n, {terminal_admission:terminalAdmission,
        terminal_admission_receipt_id:terminalAdmission.receipt_id,head_authorization_id:terminalAdmission.head_authorization_id,
        claim:{...n.claim,lease_version:terminalAdmission.lease_version}});
      observation_recorder.record('claim_verification', { result: { payload: n } });
      return { admitted: state.valid, verdict: n.verdict, ...(state.valid ? {} : { reasons: ['claim_not_current'] }), head_sha: job.headSha, base_sha: job.baseSha,
        pr_ref: prRef, claim_id: c.claimId, task_id: state.taskId, scope,
        claim_binding: { status: 'ok', binding_status: 'bound', reason: null, repository: REPO, pr_number: job.pr, pr_ref: prRef,
          head_sha: job.headSha, base_sha: job.baseSha, target_branch: 'main', scope, task_id: state.taskId,
          claim: { claim_id: c.claimId, task_id: state.taskId, context_key: scope, fence: c.fence, execution_epoch: c.epoch,
            lease_version: 1, expires_at: c.expiresAt, status: 'ACTIVE', execution_handover_pending: false },
          head_authorization_id: null, auto_bound: false, receipt_id: null },
        changed_paths: ['a.txt'], admission_mode: { state: 'normal', layer: 'code', policy_version: 1 },
        merge_slot: { state: 'held', ref: `merge:${REPO}:main`, tip: job.baseSha, until: iso(Date.now() + 600_000) }, owner_review: null, workflow_gate_findings: [] };
    } } });
  const admission = { fixture: true, async evaluatePr(...args) { calls.push(args[2]?.batchClaim ?? null); return realAdmission.evaluatePr(...args); } };
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims });
  return { dir, job, old, current, state, checks, calls, journal, batchClaims, pub };
}

test('actual Source publisher persists its Native receipt on first admission and on the one authorized unpublished repair', async t => {
  for(const initial of [false,true]) await t.test(initial?'repair':'first admission',async t=>{
    const current=claim(),terminalAdmission={receipt_id:randomUUID(),claim_id:current.claimId,fence:current.fence,
      execution_epoch:current.epoch,lease_version:5,head_authorization_id:randomUUID()};
    const f=await fixture(t,{current,initial,terminalAdmission});
    const result=await f.pub.publish(f.job);
    assert.equal(result.status,'SETTLED',JSON.stringify(result));
    assert.deepEqual(await store.readTerminalAdmission(f.dir,{repo:REPO,pr:f.job.pr,headSha:HEAD,
      sourceManifestSha256:f.job.sourceManifestSha256}),terminalAdmission);
  });
});

test('unpublished batch recovery: current Native generation replaces stale stage-one record on the original head', async t => {
  const f = await fixture(t), result = await f.pub.publish(f.job);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.equal(result.sideEffects, 1);
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.current));
  assert.equal(f.checks.length, 1);
  assert.equal(f.checks[0].head_sha, f.job.headSha);
  assert.ok(f.calls.some(c => c === null), 'fresh current Native admission precedes replacement');
});

test('unpublished batch recovery: a published same-job attempt never rewrites the old generation', async t => {
  const f = await fixture(t, { published: true }), result = await f.pub.publish(f.job);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.sideEffects, 0);
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.old));
  assert.equal(f.checks.length, 1);
});

test('unpublished batch recovery: invalid current Native claim remains a refusal without replacing or publishing', async t => {
  const f = await fixture(t, { valid: false }), result = await f.pub.publish(f.job);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.sideEffects, 0);
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.old)); assert.equal(f.checks.length, 0);
});

test('unpublished batch recovery: #1043 current Native generation succeeds on the original head despite the stale trailer', async t => {
  const f = await fixture(t, { valid: false });
  f.state.trailerClaim = f.old.claimId;
  assert.equal((await f.pub.publish(f.job)).status, 'BLOCKED');
  f.state.valid = true;
  const result = await f.pub.publish(f.job);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.current));
  assert.equal(f.checks[0].head_sha, HEAD);
});

test('unpublished batch recovery: every non-not_sent journal state fences replacement', async t => {
  for (const journalState of ['intent', 'authorized', 'sent', 'uncertain', 'settled', 'revoked']) {
    const f = await fixture(t, { journalState }), result = await f.pub.publish(f.job);
    assert.notEqual(result.status, 'SETTLED', journalState);
    assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.old), journalState);
    assert.equal(f.checks.length, 0, journalState);
  }
});

test('unpublished batch recovery: known not_sent old effect can recover under the admitted new generation', async t => {
  const f = await fixture(t, { journalState: 'not_sent' }), result = await f.pub.publish(f.job);
  assert.equal(result.status, 'SETTLED', JSON.stringify(result));
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.current));
  assert.equal((await f.journal.read(keyFor(f.job, f.old))).state, 'not_sent');
});

test('unpublished batch recovery: an incomplete GitHub inventory is never evidence of no publication', async t => {
  const f = await fixture(t, { complete: false }), result = await f.pub.publish(f.job);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.sideEffects, 0);
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.old)); assert.equal(f.checks.length, 0);
});

test('unpublished batch recovery: only one replacement is allowed even when the first run stops before publication', async t => {
  const f = await fixture(t); f.state.failProbe = true;
  assert.equal((await f.pub.publish(f.job)).status, 'BLOCKED');
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.current), 'first replacement occurred before probe failure');
  f.state.failProbe = false; f.state.current = claim(); f.state.trailerClaim = f.state.current.claimId;
  const result = await f.pub.publish(f.job);
  assert.equal(result.status, 'BLOCKED'); assert.equal(result.sideEffects, 0);
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.current)); assert.equal(f.checks.length, 0);
});

test('unpublished batch recovery: actual Native fence and epoch mismatch of the same claim also repair before any publication', async t => {
  for (const changed of [{ fence: 8 }, { epoch: 2 }]) {
    const old = claim(), current = { ...old, ...changed }, f = await fixture(t, { old, current });
    assert.equal((await f.pub.publish(f.job)).status, 'SETTLED');
    assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(current));
  }
});

test('unpublished batch recovery store: one rewrite covers the head/attempt across base and Source variants', async t => {
  const f = await fixture(t);
  await f.batchClaims.rewrite(f.job, f.old, f.current, iso(Date.now()), async () => {});
  const otherJob = jobsFor({ baseSha: 'e'.repeat(40), sourceManifestSha256: 'f'.repeat(64) })['work-admission'];
  await f.batchClaims.record(otherJob, f.old, iso(Date.now()));
  await assert.rejects(f.batchClaims.rewrite(otherJob, f.old, f.current, iso(Date.now()), async () => {}), { code: 'BATCH_CLAIM_CHANGED' });
  assert.deepEqual(await f.batchClaims.read(otherJob), claimGeneration(f.old));
});

test('unpublished batch recovery store: generation CAS refuses a changed record after the no-publication read', async t => {
  const f = await fixture(t), file = path.join(f.dir, `${batchRefV2(f.job)}.json`), intruder = claim();
  await assert.rejects(f.batchClaims.rewrite(f.job, f.old, f.current, iso(Date.now()), async () => {
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    const { integrity, ...body } = record; body.claim = claimGeneration(intruder);
    await fs.writeFile(file, JSON.stringify({ ...body, integrity: digest(body) }));
  }), { code: 'BATCH_CLAIM_CHANGED' });
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(intruder));
});

test('unpublished batch recovery store: publication intent and record creation cannot race the replacement lock', async t => {
  const f = await fixture(t); let signal, proceed;
  const entered = new Promise(resolve => { signal = resolve; }), blocked = new Promise(resolve => { proceed = resolve; });
  const replacement = f.batchClaims.rewrite(f.job, f.old, f.current, iso(Date.now()), async () => { signal(); await blocked; });
  await entered;
  await assert.rejects(f.batchClaims.withPublication(f.job, f.old, () => f.journal.begin(keyFor(f.job, f.old), {})), { code: 'BATCH_CLAIM_BUSY' });
  await assert.rejects(f.batchClaims.record(f.job, f.old, iso(Date.now())), { code: 'BATCH_CLAIM_BUSY' });
  proceed(); await replacement;
  await assert.rejects(f.batchClaims.withPublication(f.job, f.old, () => f.journal.begin(keyFor(f.job, f.old), {})), { code: 'BATCH_CLAIM_CHANGED' });
  assert.equal(await f.journal.read(keyFor(f.job, f.old)), null);
});

test('unpublished batch recovery store: a crash after old-record archive never permits create-only resurrection', async t => {
  const f = await fixture(t), realRename = fs.rename;
  fs.rename = async (from, to) => { await realRename(from, to); if (to.endsWith('.superseded.json')) throw Object.assign(new Error('simulated_crash'), { code: 'simulated_crash' }); };
  try { await assert.rejects(f.batchClaims.rewrite(f.job, f.old, f.current, iso(Date.now()), async () => {}), { code: 'simulated_crash' }); }
  finally { fs.rename = realRename; }
  await assert.rejects(store.readBatchClaim(f.dir, f.job), { code: 'BATCH_CLAIM_MISSING' });
  await assert.rejects(f.batchClaims.record(f.job, f.current, iso(Date.now())), { code: 'BATCH_CLAIM_REWRITE_INCOMPLETE' });
  const names = await fs.readdir(f.dir);
  assert.ok(names.some(n => n.endsWith('.superseded.json')));
  assert.ok(names.some(n => n.endsWith('.rewrite-once')));
  assert.equal(names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).length, 0, 'the consumer canonical scan excludes archives and staged replacements');
});

test('unpublished batch recovery store: a crash before archive retains the old record and consumes the one-time reservation', async t => {
  const f = await fixture(t), realRename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('simulated_crash'), { code: 'simulated_crash' }); };
  try { await assert.rejects(f.batchClaims.rewrite(f.job, f.old, f.current, iso(Date.now()), async () => {}), { code: 'simulated_crash' }); }
  finally { fs.rename = realRename; }
  assert.deepEqual(await f.batchClaims.read(f.job), claimGeneration(f.old));
  await assert.rejects(f.batchClaims.rewrite(f.job, f.old, f.current, iso(Date.now()), async () => {}), { code: 'BATCH_CLAIM_CHANGED' });
});

test('unpublished batch recovery: production requires replacement and publication-lock ports together', () => {
  for (const batchClaims of [{}, { rewrite() {} }, { withPublication() {} }]) {
    assert.throws(() => createProductionWorkAdmissionPublisherV2({ batchClaims }), { code: 'WORK_ADMISSION_PUBLISHER_CONFIGURATION_REFUSED' });
  }
  assert.doesNotThrow(() => createProductionWorkAdmissionPublisherV2({ batchClaims: { rewrite() {}, withPublication() {} } }));
});
