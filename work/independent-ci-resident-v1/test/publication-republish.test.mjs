// Generation 28 (docs/adr/0015, defect 664cc8eb). Field #1037 head 26ac75e4: stage 7 wrote contract-placement, then the complete admission
// after the write timed out (GitHub/Native not read in time). The publisher withdrew the check as "verification unavailable ... no change of
// it was observed" (REVOKED, full_admission_not_proven) and the batch ended FAILED_CLEAN PUBLICATION_REVOKED: the head was burned.
// End to end over the real resident executor and the real Source v2 scanner publisher (staged-check-publisher-v2.mjs), the entry's outcome
// record (stage-inputs.mjs#writeOutcome), the stage fact (stage-fact.mjs#outcomeFacts) and the Windows engine's outcome parser, with offline
// GitHub and Native ports: the withdrawn stage runs again after the bounded back-off, the republication settles, the newest check of the role
// is green, the batch completes and the head is not burned. A real change of the authorization still ends the batch as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PUBLICATION_RETRY_MS } from '../src/executor.mjs';
import { parseStageOutcome } from '../src/engine-windows.mjs';
import { batchKey } from '../src/ledger.mjs';
import { BASE as R_BASE, HEAD as R_HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';
import { createStagedCheckPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/staged-check-publisher-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { batchJobsV2, claimGeneration, subjectOfV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { digest } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { validateRecordV2 } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/record.mjs';
import { writeOutcome } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-inputs.mjs';
import { outcomeFacts, outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { HEAD, BASE, tempDir, fixtureRecord, signResult } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const iso = ms => new Date(ms).toISOString();
const KEY = batchKey({ repo: REPO, pr: 884, headSha: R_HEAD, baseSha: R_BASE, sourceManifestSha256: SOURCE, attempt: 1 });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);

// Native's complete admission as full-admission-v2.mjs reports it (staged policy, as in production), and unreachable (a timeout inside it).
function admitted(job, observed, packet, mode = {}) {
  const facts = { contract: 'clued.independent-ci.full-admission/2', status: 'ADMITTED', admitted: true, completeAdmission: true, evaluator: 'scripts/ci/clued-work-admission.mjs#evaluate',
    domain: 'fixture', repository: REPO, scope: 'project:x', prRef: `${REPO}#${job.pr}`, headSha: job.headSha, baseSha: job.baseSha, jobId: job.id, role: job.role, attempt: job.attempt,
    claimId: observed.claimId, fence: observed.fence, epoch: observed.epoch, observedClaim: { ...observed }, batchClaimBound: claimGeneration(observed),
    sourceManifestSha256: job.sourceManifestSha256, executionPolicy: 'staged', guarded: false, executionHandoverPending: false, mergeQueueHead: false,
    mode: { state: 'normal', layer: 'code', policyVersion: 1, ...mode }, mergeSlot: { state: 'held', ref: `merge:${REPO}:main`, tip: job.baseSha, until: iso(Date.now() + 3600_000) },
    ownerReview: null, workflowGateFindings: [], observedAt: iso(Date.now()), claimExpiresAt: observed.expiresAt, modeProofRef: 'mode', observationRef: 'obs',
    packetSha256: digest(packet), evaluationSha256: digest('evaluation') };
  return { ...facts, observationSha256: digest(facts) };
}
const unreachable = () => ({ contract: 'clued.independent-ci.full-admission/2', status: 'BLOCKED', admitted: false, reason: 'full_admission_unavailable',
  diagnostic: { phase: 'native', transport: true } });
function fakeGithub() {
  const checks = []; let next = 100;
  return { fixture: true, checks,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}

// The world of stage 7: one signed contract-placement result, one journal (state\v2\effects-scan), one GitHub. Every run of the stage is a new
// entry process: a new publisher over the same journal. answer(n) is Native's n-th complete admission of the whole world.
async function stage7World(t, answer) {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: Date.now() });
  const job = batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(Date.now() - 60_000), attempt: 1 })['contract-placement'];
  const c = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) };
  const refs = Object.fromEntries(['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef'].map(k => [k, record.accepted[k]]));
  const authority = { fixture: true, async observe(j) { return { ...subjectOfV2(j), ...refs, ciPrincipalBindingId: record.config.ciPrincipalBindingId, sourceAccepted: true, hostQualified: true,
    publisherQualified: true, ciPrincipalQualified: true, observedAt: iso(Date.now()), claimExpiresAt: c.expiresAt, claim: claimGeneration(c) }; } };
  const signers = new Map([...record.signers].map(([k, s]) => [k, { ...s, domain: 'fixture' }]));
  const envelope = signResult(job, signer, { finishedAt: Date.now() - 1000, startedAt: Date.now() - 5000, domain: 'fixture' });
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const receiptsRoot = await tempDir(t, 'clued-no-role-');
  const github = fakeGithub();
  let n = 0;
  const run = async () => {
    const publisher = createStagedCheckPublisherV2({ nativeAdmission: { fixture: true, async evaluatePr(j, packet, opts) { n++; return answer(n, j, c, packet, opts); } }, authority, github, journal, signers,
      configuredChecks: record.config.checks, readChangedPaths: j => github.readChangedPaths(j),
      protectedDeployment: { enabled: true, domain: 'fixture', repository: REPO, ciPrincipalBindingId: record.config.ciPrincipalBindingId, ...refs }, batchClaim: claimGeneration(c), domain: 'fixture' });
    const result = await publisher.publish({ job, envelope });
    // The entry's outcome record, the stage fact the invoker prints, and the engine's own parse of it, as in production.
    const written = await writeOutcome({ receiptsRoot, nonce: randomUUID().replace(/-/g, ''), plan: { stage: 7, entryRole: 'check-publisher' }, jobIds: [job.id], result });
    const outcome = parseStageOutcome(outcomeFacts(written));
    return result.status === 'SETTLED' ? { ok: true, factsSha256: 'd'.repeat(64), proof: WINDOWS_CLEAN, outcome }
      : { ok: false, code: outcomeFailureCode(written, 7), proof: WINDOWS_CLEAN, outcome, brokerNoLaunch: false };
  };
  return { github, run, job };
}

async function residentWith(t, world) {
  const engine = fakeEngine();
  const base = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 7 ? (engine.calls.push(['stage', 7]), world.run()) : base(batch, stage, o));
  const waits = [];
  const f = await executorFixture(t, { engine, sleep: async ms => { if (ms >= PUBLICATION_RETRY_MS[0]) waits.push(ms); } });
  await f.drop(triggerBytes());
  return { f, engine, waits, r: await f.exec.tick() };
}

test('664cc8eb end to end: the verification after the write times out once -> withdrawn, stage 7 runs again, the republication settles, the batch completes, the head is not burned', async t => {
  // The second admission of the world is the first one after the write: Native does not answer in time.
  const world = await stage7World(t, (n, j, c, packet) => (n === 2 ? unreachable() : admitted(j, c, packet)));
  const { f, engine, waits, r } = await residentWith(t, world);
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 7, 8], 'stage 7 twice, nothing re-scanned');
  assert.deepEqual(waits, [PUBLICATION_RETRY_MS[0]]);
  assert.deepEqual(world.github.checks.map(c => [c.name, c.conclusion]), [['contract-placement', 'failure'], ['contract-placement', 'success']]);
  assert.match(world.github.checks[0].output.title, /withdrawn: verification unavailable/);
  assert.equal(world.github.checks[1].external_id, world.github.checks[0].external_id, 'the role own external_id: readers count the newest check');
  const newest = world.github.checks.reduce((a, c) => (c.id > a.id ? c : a));
  assert.equal(newest.conclusion, 'success', 'the newest contract-placement check is green');
  const terminals = (await f.receipts.latest(['stage-terminal'], 50)).map(e => e.value.body).filter(b => b.stage === 7);
  assert.deepEqual(terminals.map(b => [b.ok, b.failureCode, b.outcome?.status, b.outcome?.republishSafe ?? false]), [[false, 'PUBLICATION_REVOKED', 'REVOKED', true], [true, null, 'SETTLED', false]]);
  const retries = (await f.receipts.latest(['publication-retry'], 10)).map(e => e.value.body);
  assert.deepEqual(retries.map(b => [b.stage, b.try, b.failureCode, b.reason]), [[7, 1, 'PUBLICATION_REVOKED', 'full_admission_not_proven']]);
  assert.notEqual((await f.ledger.state(KEY))?.state, 'FAILED_CLEAN', 'the head is not burned');
});

test('664cc8eb end to end: an authorization that really changed after the write still ends the batch (PUBLICATION_REVOKED, burned, no second run)', async t => {
  const world = await stage7World(t, (n, j, c, packet) => admitted(j, c, packet, n >= 2 ? { state: 'frozen' } : {}));
  const { engine, waits, r } = await residentWith(t, world);
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PUBLICATION_REVOKED'], JSON.stringify(r));
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(waits, []);
  assert.deepEqual(world.github.checks.map(c => c.conclusion), ['failure']);
  assert.equal(world.github.checks[0].output.title, 'Independent CI authorization changed');
});

test('664cc8eb end to end: the retry cap holds: withdrawn for unavailability on every try, the batch ends after the three repeats', async t => {
  const world = await stage7World(t, (n, j, c, packet) => (n % 2 === 0 ? unreachable() : admitted(j, c, packet)));
  const { engine, waits, r } = await residentWith(t, world);
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PUBLICATION_REVOKED'], JSON.stringify(r));
  assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 7, 7, 7]);
  assert.deepEqual(waits, [...PUBLICATION_RETRY_MS]);
  assert.deepEqual(world.github.checks.map(c => c.conclusion), ['failure', 'failure', 'failure', 'failure']);
});
