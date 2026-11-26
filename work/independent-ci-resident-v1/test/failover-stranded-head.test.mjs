// Field defect 2026-11-15 (PR #1110, head 9ffc459c; DESIGN §78): the node on duty (A) ran stage 1 of a head, published that attempt's
// own kooyumi-work-admission and lost its line before any role check; the failover gave the duty to B. B's stage 1 found A's admission
// check (same job id and attempt: the identity is content + attempt, never the node) and ended HEAD_PUBLISHED_ON_GITHUB: burned,
// recorded as executed, "push a new commit". End to end here: the real Source stage-1 publisher on one shared GitHub, its outcome
// through the real stage-fact mapping, into two resident executors. The interrupted run is not "run": B runs the head (attempt 2, new
// job ids) and gives the verdict; a head A finished (a role check on GitHub) is never run again by B.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { batchJobsV2, scanExternalIdV2 } from '../../actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { EffectJournal } from '../../actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { recordBatchClaim, readBatchClaim } from '../../actions-hosted-migration/independent-ci-v1/src/batch-claim-v2.mjs';
import { createFixtureWorkAdmissionPublisherV2 } from '../../actions-hosted-migration/independent-ci-v1/src/formal-work-admission-check-v2/publisher.mjs';
import { outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { admittedFacts, tempDir } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { ResidentError } from '../src/canonical.mjs';
import { ResidentExecutor } from '../src/executor.mjs';
import { batchKey } from '../src/ledger.mjs';
import { describe } from '../src/pr-status.mjs';
import { RunQueue } from '../src/queue.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, triggerBytes } from './helpers.mjs';

const REPO = 'tdoljyj/cross-memory-system', APP = 5368905, MIN = 60_000;
const iso = ms => new Date(ms).toISOString();

// One GitHub both nodes read and write (check runs of App 5368905 only).
function sharedGithub() {
  const checks = []; let next = 1000;
  return { fixture: true, checks,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async readPullRequest(n) { return { number: n, state: 'open', merged: false, mergeable: true, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, ref: 'main', repo: { full_name: REPO } } }; },
    async readChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async readAppChecks(head) { return { complete: true, checks: checks.filter(c => c.head_sha === head && c.app.id === APP).map(c => structuredClone(c)) }; },
    async createCheck(body) { const c = { id: next++, app: { id: APP }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
    async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
}

// A node: its own resident (executor fixture), its own Source journal and batch claims; stage 1 is the real Source work-admission
// publisher, stage 3 publishes gitleaks of the batch's job (the first role check); `script` overrides other stages.
async function node(t, github, script = {}, companion) {
  const dir = await tempDir(t);
  const batchClaims = { read: async j => { try { return await readBatchClaim(dir, j); } catch (e) { if (e.code === 'BATCH_CLAIM_MISSING') return null; throw e; } },
    record: (j, c, at) => recordBatchClaim(dir, j, c, at) };
  const journal = await EffectJournal.open(path.join(await tempDir(t), 'effects'));
  const claim = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(Date.now() + 3600_000) };
  const admission = { fixture: true, async evaluatePr(job, packet) { return admittedFacts(job, claim, packet, { domain: 'fixture', slotUntil: Date.now() + 3600_000 }); } };
  const pub = createFixtureWorkAdmissionPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaims });
  const engine = fakeEngine();
  const subjects = new Map();
  const derive = engine.derive, run = engine.runStage;
  engine.derive = async (subject, key, chain) => { subjects.set(key, subject); return derive(subject, key, chain); };
  const jobsOf = key => { const s = subjects.get(key);
    return batchJobsV2({ repo: s.repo, pr: s.pr, headSha: s.headSha, baseSha: s.baseSha, testSha: s.headSha, sourceManifestSha256: s.sourceManifestSha256, createdAt: iso(Date.now() - MIN), attempt: s.attempt }); };
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) {
      engine.calls.push(['stage', 1]);
      const r = await pub.publish(jobsOf(batch.key)['work-admission']);
      if (r.status === 'SETTLED') return { ok: true, factsSha256: 'd'.repeat(64), outcome: { status: 'SETTLED', reason: null, sideEffects: r.sideEffects, mayHavePublished: true } };
      const outcome = { status: r.status, reason: r.reason ?? null, sideEffects: r.sideEffects, mayHavePublished: false, safeToRerun: r.safeToRerun === true, diagnostic: null, scheduling: null };
      return { ok: false, code: outcomeFailureCode(outcome, 1), proof: WINDOWS_CLEAN, outcome, brokerNoLaunch: false };
    }
    if (script[stage.number]) { engine.calls.push(['stage', stage.number]); return script[stage.number]; }
    if (stage.number === 3) {
      const job = jobsOf(batch.key).gitleaks;
      await github.createCheck({ name: 'gitleaks', head_sha: job.headSha, status: 'completed', conclusion: 'success', external_id: scanExternalIdV2(job) });
    }
    return run(batch, stage, o);
  };
  const f = await executorFixture(t, { engine, companion });
  return { f, engine, stages: () => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]) };
}
const named = (github, name) => github.checks.filter(c => c.name === name);

const incident = { repo: REPO, pr: 1151, headSha: 'ba1d6dfab293bb8c660d87b69d22f30b22176223',
  baseSha: '6a2b050feeaea167c12a17ce2726d5a948e89db3', sourceManifestSha256: SOURCE, attempt: 1 };
const incidentTrigger = () => triggerBytes({ pr: incident.pr, headSha: incident.headSha, baseSha: incident.baseSha });

async function queuedIncident(t, state) {
  const github = sharedGithub();
  const job = batchJobsV2({ ...incident, testSha: incident.headSha, createdAt: '2026-11-26T13:24:30.000Z' })['work-admission'];
  await github.createCheck({ name: 'kooyumi-work-admission', head_sha: incident.headSha, status: 'completed', conclusion: 'success',
    external_id: `independent-ci:native-work-admission:v2:${job.id}:a1:cfixture` });
  const companion = fakeCompanion({ pull(pr) {
    if (pr !== incident.pr) return { number: pr, state: 'open', headSha: HEAD };
    if (state.expired) throw new ResidentError('COMPANION_REQUEST_EXPIRED');
    return { number: pr, state: state.merged ? 'merged' : 'open', headSha: incident.headSha };
  }, linux: { linuxUnitsInactive: false, containersZero: false } }, () => f.clock());
  const { f } = await node(t, github, {}, companion);
  await f.drop(incidentTrigger());
  return f;
}

test('#1151 首次精确查询过期时不预留，有效合入回执到达后收终，下一行可运行', async t => {
  const state = { merged: true, expired: true };
  const f = await queuedIncident(t, state);
  await f.drop(triggerBytes());
  const key = batchKey(incident);
  const bodies = async type => (await f.receipts.latest([type], 20)).map(r => r.value.body);

  const first = await f.exec.tick();
  const reserved = await bodies('batch-reserved');
  const stages = await bodies('stage-terminal');
  assert.deepEqual(reserved.map(r => r.subject.pr), [884], JSON.stringify({ first, reservations: reserved.map(r => r.subject.pr),
    incidentStages: stages.filter(r => r.key === key), halt: await f.ledger.halted() }));
  assert.equal(first.state, 'COMPLETED');
  assert.equal(stages.some(r => r.key === key), false);
  assert.equal((await f.ledger.state(key)).state, 'ABSENT');
  assert.equal(await f.ledger.halted(), null);
  assert.deepEqual(await bodies('queue-pr-closed'), []);

  const incidentReads = () => f.companion.calls.filter(([kind, pr]) => kind === 'pr-head' && pr === incident.pr).length;
  assert.equal(incidentReads(), 1);
  f.advance(1);
  const queue = await RunQueue.open(f.queue.dir, f.clock);
  const restarted = new ResidentExecutor({ ...f.ports, queue });
  await restarted.tick();
  assert.equal(incidentReads(), 1, '重启后退避期间也不重复查询');
  state.expired = false;
  f.advance(10 * MIN);
  await restarted.tick();
  assert.equal(incidentReads(), 2);
  assert.deepEqual((await bodies('queue-pr-closed')).map(r => [r.pr, r.state, r.before]), [[incident.pr, 'merged', 'reserve']]);
  assert.deepEqual([queue.row(incident.pr).state, queue.row(incident.pr).reason], ['DONE', 'PR_CLOSED']);
  assert.deepEqual((await bodies('batch-reserved')).map(r => r.subject.pr), [884]);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  assert.equal(await f.ledger.halted(), null);
});

test('已获可信打开状态并预留的批次缺少 Linux 静止证明时仍 HALT', async t => {
  const f = await queuedIncident(t, { merged: false, expired: false });
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'HEAD_INTERRUPTED_ON_GITHUB']);
  const s = await f.ledger.state(batchKey(incident));
  assert.equal(s.reserved.subject.pr, incident.pr);
  assert.equal(s.started == null, true);
  assert.equal(s.outcome, 'FAILED_UNKNOWN');
  assert.equal(s.terminal.facts.basis, 'cleanup-proof-incomplete');
  assert.ok(await f.ledger.halted());
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
});

test('failover: A ran stage 1 of H and lost its line before any role check; B, on duty now, runs H by itself and gives the verdict', async t => {
  const github = sharedGithub();
  // A: stage 1 publishes this attempt's admission; the line goes at stage 2 (the field ending, REMOTE_REFS_CHANGED_SINCE_BUNDLE).
  const a = await node(t, github, { 2: { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE', proof: WINDOWS_CLEAN, outcome: null, brokerNoLaunch: false } });
  await a.f.drop(triggerBytes());
  const ra = await a.f.exec.tick();
  assert.deepEqual([ra.state, ra.failureCode], ['FAILED_CLEAN', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE']);
  assert.deepEqual([named(github, 'kooyumi-work-admission').length, named(github, 'gitleaks').length], [1, 0], 'A left only its admission check');
  // A is cut off from here on (never ticked again). B, which took the duty, gets the same head.
  const b = await node(t, github);
  await b.f.drop(triggerBytes());
  const first = await b.f.exec.tick();
  assert.deepEqual([first.state, first.failureCode], ['FAILED_CLEAN', 'HEAD_INTERRUPTED_ON_GITHUB'], JSON.stringify(first));
  assert.ok(first.attempt2, 'B schedules its attempt 2 at once: no new commit asked for');
  assert.equal(await b.f.executedHeads.published({ repo: REPO, headSha: HEAD }), false, 'the interrupted run is not recorded as executed');
  b.f.advance(10 * MIN + 1);
  const second = await b.f.exec.tick();
  assert.equal(second.state, 'COMPLETED', JSON.stringify(second));
  // B gave the verdict: its own admission (attempt 2) and the role check, each once; A's attempt-1 admission stays as it was.
  assert.deepEqual(named(github, 'kooyumi-work-admission').map(c => /:a(\d):c/.exec(c.external_id)?.[1]), ['1', '2']);
  assert.equal(named(github, 'gitleaks').length, 1);
  assert.equal(b.stages().filter(n => n === 1).length, 2);
});

test('failover: A had finished H (a role check on GitHub); B never runs it again and asks for a new commit, as before', async t => {
  const github = sharedGithub();
  const a = await node(t, github);
  await a.f.drop(triggerBytes());
  assert.equal((await a.f.exec.tick()).state, 'COMPLETED');
  assert.equal(named(github, 'gitleaks').length, 1);
  const b = await node(t, github);
  await b.f.drop(triggerBytes());
  const r = await b.f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.attempt2], ['FAILED_CLEAN', 'HEAD_PUBLISHED_ON_GITHUB', undefined]);
  assert.equal(await b.f.executedHeads.published({ repo: REPO, headSha: HEAD }), true);
  b.f.advance(10 * MIN + 1);
  await b.f.exec.tick();
  assert.deepEqual(b.stages(), [1], 'nothing of H ran again on B');
  assert.deepEqual([named(github, 'kooyumi-work-admission').length, named(github, 'gitleaks').length], [1, 1]);
});

test('PR page: an interrupted head says it runs again by itself; its attempt 2 interrupted again asks for a new commit', () => {
  const now = Date.parse('2026-11-15T04:01:30Z');
  const board = attempt => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
    b.outcome({ pr: 884, headSha: HEAD, attempt, outcome: 'FAILED_CLEAN', code: 'HEAD_INTERRUPTED_ON_GITHUB', klass: 'transient', retry: 'attempt2' });
    return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
  const pull = { pr: 884, headSha: HEAD, eligible: true, hint: null, behindBy: 0 };
  const d1 = describe({ pull, status: board(1), now }), d2 = describe({ pull, status: board(2), now });
  assert.equal(d1?.state, 'pending');
  assert.match(d1.description, /不用推新提交/);
  assert.equal(d2?.state, 'failure');
  assert.match(d2.description, /请推新提交/);
});
