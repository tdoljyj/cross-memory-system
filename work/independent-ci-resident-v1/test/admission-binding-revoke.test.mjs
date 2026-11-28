// Field defect 2026-11-15 (PR #1123, head 0ad88499; DESIGN §79): stage 1 admitted the head at 10:32:36 (Native's execution admission),
// wrote kooyumi-work-admission at 10:32:40 and verified it again at 10:32:46. In between, at 10:32:43, the claim's merge slot reached its
// hard cap (queued 08:32:43, 7200 s) and left the queue: the slot read "held" before the write and "missing" after it. The stage-1 binding
// bound the slot's state, so the check was withdrawn as NATIVE_AUTHORIZATION_BINDING_CHANGED, the resident ended the head as the final
// PUBLICATION_REVOKED, and only a new (empty) commit ran the PR again. End to end here: the real Source stage-1 publisher, its outcome
// through the real stage-fact mapping, into the real resident executor.
//   - The merge slot's state says nothing about the work admission (the slot is the merge slot check's and stage 8's business): it moving
//     between the two reads no longer withdraws stage 1, as for the scanner roles (scan-publish-merge-slot.test.mjs).
//   - A real change of the authorization between the two reads still withdraws the check, but the head is no longer burned: nothing of
//     it ran (stage 1 is the first stage, its check is attempt-scoped), so the one automatic attempt 2 admits it again, no new commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { batchJobsV2, scanExternalIdV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../../actions-hosted-migration/independent-ci-v1/src/batch-claim-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/formal-work-admission-check-v2/publisher.mjs';
import { createFullAdmissionPortV2 } from '../../actions-hosted-migration/independent-ci-v1/src/full-admission-v2.mjs';
import { outcomeFacts, outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { writeOutcome } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-inputs.mjs';
import { admittedFacts, tempDir } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { describe } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { HEAD, WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const REPO = 'tdoljyj/cross-memory-system', APP = 5368905, MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
const BASE_SHA = 'b'.repeat(40);

function github(headSha = HEAD, baseSha = BASE_SHA) {
  const checks = []; let next = 1000;
  return { fixture: true, checks,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, head: { sha: headSha, repo: { full_name: REPO } }, base: { sha: baseSha, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async readAppChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head && c.app.id === APP).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: APP }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}

// Native's answer to one evaluation: the admitted facts, with `change` (mode, ownerReview, mergeSlot fields) laid over them.
function answer(job, claim, packet, change = {}) {
  const f = admittedFacts(job, claim, packet, { domain: 'fixture', slotUntil: Date.now() + 3600_000 });
  const { observationSha256, ...facts } = { ...f, ...(change.mode ? { mode: { ...f.mode, ...change.mode } } : {}),
    ...(change.ownerReview !== undefined ? { ownerReview: change.ownerReview } : {}), ...(change.slot ? { mergeSlot: { ...f.mergeSlot, ...change.slot } } : {}) };
  return { ...facts, observationSha256: digest(facts) };
}
// The stage-1 publisher of one node. `observe(job, written)` is what Native's answer shows over the admitted facts, before the write of
// this attempt's check (written false) and when it is verified again after the write (written true).
async function stage1(t, gh, observe, verifyAfterWrite) {
  const dir = await tempDir(t);
  const batchClaims = { read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } },
    record: (j, c, at) => recordBatchClaim(dir, j, c, at) };
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const claim = { claimId: randomUUID(), fence: 37, epoch: 1, expiresAt: iso(Date.now() + 3600_000) };
  const admission = { fixture: true, async evaluatePr(job, packet, options) {
    const written = gh.checks.some(c => c.name === 'kooyumi-work-admission' && c.external_id.includes(`:a${job.attempt}:`));
    if (written && job.attempt === 1 && verifyAfterWrite) return verifyAfterWrite(job, packet, options);
    return answer(job, claim, packet, observe(job, written));
  } };
  return createFixtureWorkAdmissionPublisherV2({ github: gh, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims, sleep: async () => {} });
}
// A resident whose stage 1 is the real Source publisher; stage 3 publishes the batch's gitleaks (the first role check).
async function node(t, gh, observe, verifyAfterWrite) {
  const pub = await stage1(t, gh, observe, verifyAfterWrite);
  const receiptsRoot = await tempDir(t);
  const engine = fakeEngine(), subjects = new Map(), derive = engine.derive, run = engine.runStage;
  engine.derive = async (subject, key, chain) => { subjects.set(key, subject); return derive(subject, key, chain); };
  const jobsOf = key => { const s = subjects.get(key);
    return batchJobsV2({ repo: s.repo, pr: s.pr, headSha: s.headSha, baseSha: s.baseSha, testSha: s.headSha, sourceManifestSha256: s.sourceManifestSha256, createdAt: iso(Date.now() - MIN), attempt: s.attempt }); };
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) {
      engine.calls.push(['stage', 1]);
      const job = jobsOf(batch.key)['work-admission'];
      const r = await pub.publish(job);
      if (r.status === 'SETTLED') return { ok: true, factsSha256: 'd'.repeat(64), outcome: { status: 'SETTLED', reason: null, sideEffects: r.sideEffects, mayHavePublished: true } };
      const entry = await writeOutcome({ receiptsRoot, nonce: randomUUID().replaceAll('-', ''), plan: { stage: 1, entryRole: 'work-admission' }, jobIds: [job.id], result: r });
      const outcome = outcomeFacts(entry);
      return { ok: false, code: outcomeFailureCode(outcome, 1), proof: WINDOWS_CLEAN, outcome, brokerNoLaunch: false };
    }
    if (stage.number === 3) {
      const job = jobsOf(batch.key).gitleaks;
      await gh.createCheck({ name: 'gitleaks', head_sha: job.headSha, status: 'completed', conclusion: 'success', external_id: scanExternalIdV2(job) });
    }
    return run(batch, stage, o);
  };
  const f = await executorFixture(t, { engine });
  return { f, stages: () => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]) };
}
const admissions = gh => gh.checks.filter(c => c.name === 'kooyumi-work-admission').map(c => [/:a(\d):c/.exec(c.external_id)?.[1], c.conclusion]);

// Replay #1397's withdrawal using a concrete fault that produces its exact wording on the old Source:
// the Native PR binding RPC replies with a temporary HTTP error during the verification after the write.
const FIELD_PR = { pr: 1397, headSha: '90140323d6f06c2cbfe521ccb8320ec3c95145bb', baseSha: 'd95c894c395158790533d0b2de94a82ba5fb2ee9' };
function nativeBindingHttp(gh, status, seen) {
  const policyText = readFileSync(new URL('../../../config/merge-admission-policy.json', import.meta.url), 'utf8');
  const evaluatorSha256 = digest(readFileSync(new URL('../../../scripts/ci/clued-work-admission.mjs', import.meta.url), 'utf8'));
  const qualification = { ciPrincipalBindingId: randomUUID(), ciPrincipalQualificationRef: 'fixture' };
  return (job, packet, options) => createFullAdmissionPortV2({
    protectedConfig: { ...qualification, domain: 'fixture', repository: REPO, scope: 'global', workspace: process.cwd(),
      sourceManifestSha256: job.sourceManifestSha256, evaluatorSha256, policyText, policySha256: digest(policyText),
      publishableKey: 'sb_publishable_fixture', supabaseUrl: 'https://fixture.supabase.co' },
    tokenProvider: async () => ({ ...qualification, githubToken: 'fixture', ciAdmissionToken: ['clued', 'bnd', 'fixture123'].join('_') }),
    modeProvider: async () => ({ complete: true, repository: REPO, variable: 'CLUED_MERGE_ADMISSION_STATE', source: 'github-repository-variables',
      exists: false, observedAt: iso(Date.now()), proofRef: 'fixture' }),
    recorderProvider: async () => ({ kind: 'independent-controller', domain: 'fixture', observedAt: iso(Date.now()), observationRef: 'fixture',
      recorder: { newId: randomUUID, record() {} } }),
    fetchImpl: async (url, opts) => {
      const { hostname, pathname } = new URL(url);
      const prRoute = `/repos/${REPO}/pulls/${job.pr}`;
      if (hostname === 'api.github.com' && pathname === prRoute) return Response.json(await gh.readPullRequest(job.pr));
      if (hostname === 'api.github.com' && pathname === `${prRoute}/files`) return Response.json([{ filename: 'a.txt', status: 'modified' }]);
      if (hostname === 'api.github.com' && pathname.endsWith('/branches/main')) return Response.json({ commit: { sha: job.baseSha } });
      if (hostname === 'api.github.com' && pathname.endsWith(`/compare/${job.baseSha}...${job.headSha}`)) return Response.json({ status: 'ahead', files: [] });
      if (hostname === 'fixture.supabase.co' && pathname === '/rest/v1/rpc/clued_work_verify_v1' && opts.method === 'POST') {
        seen.push(JSON.parse(opts.body).p_input.action);
        return Response.json({ message: 'fixture' }, { status });
      }
      throw new Error(`unexpected fixture route: ${pathname}`);
    },
  }).evaluatePr(job, packet, options);
}

test('stage 1: #1397 withdrawal after a temporary Native HTTP failure schedules attempt 2 for the same head', async t => {
  const gh = github(FIELD_PR.headSha, FIELD_PR.baseSha), seen = [];
  const n = await node(t, gh, () => ({}), nativeBindingHttp(gh, 503, seen));
  await n.f.drop(triggerBytes(FIELD_PR));
  const first = await n.f.exec.tick();
  const { terminal } = await n.f.ledger.state(first.key);
  const check = gh.checks[0];
  assert.equal(seen[0], 'resolve_pr_claim');
  assert.deepEqual(admissions(gh), [['1', 'failure']]);
  assert.match(check.output.summary, /^Reconcile Native admission check [a-f0-9]{64}; full_admission_unavailable\./);
  assert.deepEqual([first.state, first.failureCode, terminal.facts.retry, check.output.title],
    ['FAILED_CLEAN', 'ADMISSION_VERIFICATION_UNAVAILABLE', 'attempt2', 'Work admission check withdrawn: verification unavailable'],
    check.output.summary);
  assert.match(check.output.summary, /could not be read in time.*no change of it was observed/);
  assert.deepEqual(seen, Array(4).fill('resolve_pr_claim'), 'the existing bounded verification re-reads');
  assert.equal(await n.f.executedHeads.published({ repo: REPO, headSha: FIELD_PR.headSha }), false, 'nothing of the head ran');
  const pending = await n.f.ledger.pendingAttempts2();
  assert.deepEqual(pending.map(({ subject }) => [subject.pr, subject.headSha, subject.attempt]), [[FIELD_PR.pr, FIELD_PR.headSha, 2]]);
  n.f.advance(10 * MIN + 1);
  assert.equal((await n.f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(admissions(gh), [['1', 'failure'], ['2', 'success']]);
});

test('stage 1: a Native binding HTTP 403 still withdraws the check and ends the head', async t => {
  const gh = github(FIELD_PR.headSha, FIELD_PR.baseSha), seen = [];
  const n = await node(t, gh, () => ({}), nativeBindingHttp(gh, 403, seen));
  await n.f.drop(triggerBytes(FIELD_PR));
  const first = await n.f.exec.tick();
  const { terminal } = await n.f.ledger.state(first.key);
  assert.deepEqual([first.state, first.failureCode, terminal.facts.retry], ['FAILED_CLEAN', 'PUBLICATION_REVOKED', 'new-commit']);
  assert.deepEqual(seen, ['resolve_pr_claim']);
  assert.equal(gh.checks[0].output.title, 'Work admission check withdrawn: verification failed');
  assert.deepEqual(await n.f.ledger.pendingAttempts2(), []);
});

test('stage 1: the merge slot leaving the queue between the two reads (field PR #1123) no longer withdraws the admission; the head runs', async t => {
  const gh = github();
  // Before the write the slot is held (the field: until 10:32:43, 3 s after the write); the read after the write finds it left the queue.
  const n = await node(t, gh, (job, written) => ({ slot: written ? { state: 'missing', until: iso(Date.now() - 3_000) } : { state: 'held', until: iso(Date.now() + 3_000) } }));
  await n.f.drop(triggerBytes());
  const r = await n.f.exec.tick();
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.deepEqual(admissions(gh), [['1', 'success']], 'one admission check, standing');
  assert.equal(gh.checks.filter(c => c.name === 'gitleaks').length, 1);
  assert.deepEqual(n.stages().filter(s => s === 1), [1]);
});

test('stage 1: the authorization really changing between the two reads withdraws the check, and attempt 2 admits the head again by itself', async t => {
  const gh = github();
  // The policy mode changes after attempt 1's write and stays changed (the change is real; attempt 2 sees the new state twice).
  const n = await node(t, gh, (job, written) => job.attempt === 1 && !written ? {} : { mode: { state: 'efficiency' } });
  await n.f.drop(triggerBytes());
  const first = await n.f.exec.tick();
  assert.deepEqual([first.state, first.failureCode], ['FAILED_CLEAN', 'ADMISSION_AUTHORIZATION_CHANGED'], JSON.stringify(first));
  assert.ok(first.attempt2, 'attempt 2 is scheduled at once: no new commit asked for');
  assert.equal(await n.f.executedHeads.published({ repo: REPO, headSha: HEAD }), false, 'nothing of the head ran');
  assert.deepEqual(admissions(gh), [['1', 'failure']]);
  assert.match(gh.checks[0].output.title, /authorization changed/);
  n.f.advance(10 * MIN + 1);
  const second = await n.f.exec.tick();
  assert.equal(second.state, 'COMPLETED', JSON.stringify(second));
  assert.deepEqual(admissions(gh), [['1', 'failure'], ['2', 'success']]);
  assert.equal(gh.checks.filter(c => c.name === 'gitleaks').length, 1);
});

test('stage 1: attempt 2 withdrawn for a changed authorization too is final (one automatic re-run, bounded)', async t => {
  const gh = github();
  // The policy moves on under each attempt's write.
  const n = await node(t, gh, (job, written) => ({ mode: { policyVersion: job.attempt + (written ? 1 : 0) } }));
  await n.f.drop(triggerBytes());
  assert.equal((await n.f.exec.tick()).failureCode, 'ADMISSION_AUTHORIZATION_CHANGED');
  n.f.advance(10 * MIN + 1);
  const second = await n.f.exec.tick();
  assert.deepEqual([second.state, second.failureCode, second.attempt2], ['FAILED_CLEAN', 'ADMISSION_AUTHORIZATION_CHANGED', undefined], JSON.stringify(second));
  n.f.advance(10 * MIN + 1);
  await n.f.exec.tick();
  assert.deepEqual(n.stages(), [1, 1], 'no third attempt');
  assert.deepEqual(admissions(gh), [['1', 'failure'], ['2', 'failure']]);
});

test('stage 1: every bound field other than the slot state still withdraws (the slot cannot mask a real change)', async t => {
  const STILL_BOUND = {
    'the mode (state)': { mode: { state: 'frozen' } },
    'the mode (layer)': { mode: { layer: 'protected' } },
    'the Owner review': { ownerReview: { kind: 'owner_grant', grantId: 'g-1', carriedFrom: null } },
    'main moved (the slot tip)': { slot: { tip: '9'.repeat(40) } },
    'another slot (ref)': { slot: { ref: `merge:${REPO}:other` } },
    'the slot lapses together with a mode change': { slot: { state: 'missing' }, mode: { state: 'frozen' } },
  };
  for (const [name, change] of Object.entries(STILL_BOUND)) {
    const gh = github(), pub = await stage1(t, gh, (job, written) => written ? change : {});
    const job = batchJobsV2({ repo: REPO, pr: 1123, headSha: HEAD, baseSha: BASE_SHA, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - MIN), attempt: 1 })['work-admission'];
    const r = await pub.publish(job);
    assert.deepEqual([r.status, r.reason, r.sideEffects], ['REVOKED', 'NATIVE_AUTHORIZATION_BINDING_CHANGED', 2], `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(admissions(gh), [['1', 'failure']], name);
  }
});

test('stage fact: only stage 1 maps a changed authorization to the transient code; every later stage stays PUBLICATION_REVOKED', () => {
  const revoked = { status: 'REVOKED', reason: 'NATIVE_AUTHORIZATION_BINDING_CHANGED', sideEffects: 2, mayHavePublished: true };
  assert.equal(outcomeFailureCode(revoked, 1), 'ADMISSION_AUTHORIZATION_CHANGED');
  for (const stage of [3, 5, 7, 8]) assert.equal(outcomeFailureCode(revoked, stage), 'PUBLICATION_REVOKED', String(stage));
  for (const reason of ['NATIVE_CHECK_READBACK_UNCONFIRMED', 'NEGATIVE_COMPENSATION_UNCONFIRMED', 'BATCH_CLAIM_CHANGED'])
    assert.equal(outcomeFailureCode({ ...revoked, reason }, 1), 'PUBLICATION_REVOKED', reason);
});

test('PR page: attempt 1 says it is admitted again by itself; attempt 2 asks for a new commit', () => {
  const now = Date.parse('2026-11-15T10:33:30Z');
  const board = attempt => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
    b.outcome({ pr: 1123, headSha: HEAD, attempt, outcome: 'FAILED_CLEAN', code: 'ADMISSION_AUTHORIZATION_CHANGED', klass: 'transient', retry: 'attempt2' });
    return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
  const pull = { pr: 1123, headSha: HEAD, eligible: true, hint: null, behindBy: 0 };
  const d1 = describe({ pull, status: board(1), now }), d2 = describe({ pull, status: board(2), now });
  assert.equal(d1?.state, 'pending');
  assert.match(d1.description, /不用推新提交/);
  assert.equal(d2?.state, 'failure');
  assert.match(d2.description, /请推新提交/);
});
