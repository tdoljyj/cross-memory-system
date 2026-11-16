// Field defect 2026-11-08 (PR #1039): stage 1 refused a head CLAIM_NOT_CURRENT (Native: claim_not_current, fence_superseded), the
// row backed off 10 minutes, and a minute later the author put a new, valid claim in the PR body (an edit, so a new trigger). The poke
// was due only after the cool-down, so the head waited out the back-off anyway. These tests run the real queue, ledger and executor
// on offline ports (the companion's live PR read, the stage engine), and the real pr-head read path (gh answer -> companion ->
// mailbox answer -> service port): another claim in the PR body re-evaluates the same head at once, the same claim backs off as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { batchKey } from '../src/ledger.mjs';
import { TRIGGER_CONTRACT_V2 } from '../src/trigger.mjs';
import { REQUEST_CONTRACT, RESPONSE_CONTRACT, validateResponse } from '../src/mailbox.mjs';
import { parsePull, readPullArgv } from '../src/companion.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { events } from '../src/pr-status.mjs';
import { BASE, SAFE_REFUSAL, SOURCE, CI_SOURCE, rawPolicy, executorFixture, fakeCompanion, fakeEngine, notAdmitted } from './helpers.mjs';
import { trainFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const MIN = 60_000;
const PR = 1039;
const HEAD = '2e95bda4'.padEnd(40, '0');
const OLD_CLAIM = '11111111-1111-4111-8111-111111111111';
const NEW_CLAIM = '22222222-2222-4222-8222-222222222222';
const CLAIM_REFUSAL = { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: ['claim_not_current', 'fence_superseded'] } };
// The poller's trigger of the PR (contract /2): prUpdatedAt is the PR's update time, a newer one is the PR's edited event.
const trigger = updatedAt => Buffer.from(JSON.stringify({ contract: TRIGGER_CONTRACT_V2, repo: 'tdoljyj/cross-memory-system', pr: PR, headSha: HEAD, baseSha: BASE,
  prUpdatedAt: new Date(updatedAt).toISOString() }));
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d+-|\.json$/g, ''));

// Stage 1 refuses the claim until the PR names `good`; the claim the PR body names is `body.claim` (read live by the fake companion).
async function field(t, { good, refusal = CLAIM_REFUSAL, limits = {} }) {
  const body = { claim: OLD_CLAIM, status: 'bound', authorization: null, epoch: 1 };
  const engine = fakeEngine();
  const run = engine.runStage;
  const stage1 = [];
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) {
      stage1.push(body.claim);
      if (body.claim !== good || body.status !== 'bound') { engine.calls.push(['stage', 1]); return notAdmitted('CLAIM_NOT_CURRENT', refusal); }
    }
    return run(batch, stage, o);
  };
  let clock = () => 0;
  const companion = fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: HEAD, claims: [body.claim] }) }, () => clock());
  const policy = rawPolicy(); policy.train.maintenanceEveryMs = MIN;
  Object.assign(policy.limits, limits);
  const f = await executorFixture(t, { engine, companion, policy, now: Date.parse('2026-11-08T03:05:00Z') });
  clock = f.clock;
  engine.runTrainStage = async mode => {
    engine.calls.push(['stage', 10, mode]);
    const observation = { repository: policy.repo, scope: `project:${OLD_CLAIM}`, pr: PR, headSha: HEAD, baseSha: BASE, targetBranch: 'main',
      bindingStatus: body.status, taskId: OLD_CLAIM, claimId: body.claim, fence: 3, epoch: body.epoch, headAuthorizationId: body.authorization,
      observedAt: new Date(clock()).toISOString(), sourceManifestSha256: CI_SOURCE };
    return { ok: true, runId: `${'7'.repeat(16)}-${'0'.repeat(12)}`, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
      outcome: { status: 'TRAIN_FACTS', sideEffects: 0, mayHavePublished: false },
      train: { ...trainFacts({ mode, at: new Date(clock()).toISOString(), onDuty: false, holders: [], mainSha: null, rules: null,
        front: null, revoke: [], ledger: null }), claimBindings: body.unknown ? [] : [{ ...observation, ...body.observationPatch }] } };
  };
  return { f, body, stage1 };
}

// 03:05 the first evaluation: refused CLAIM_NOT_CURRENT, released NOT_ADMITTED, the row backs off 10 minutes.
async function refused(f) {
  await f.drop(trigger(f.clock() - MIN));
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['NOT_ADMITTED', 'CLAIM_NOT_CURRENT']);
  const row = f.queue.row(PR);
  assert.deepEqual([row.state, row.reason, row.level, row.levelKind], ['WAITING', 'CLAIM_NOT_CURRENT', 1, 'waiting']);
  await f.exec.tick(); // off-mode protected shadow collects the first baseline; it never admits the head.
  assert.equal(row.evalClaims, null, 'body claims are not retained as authority');
  assert.equal(typeof row.evalBinding, 'string');
  return row.nextAt;
}

test('Native Task current claim changes wake the original head through protected shadow with train off', async t => {
  const { f, body, stage1 } = await field(t, { good: NEW_CLAIM });
  const backoffEnd = await refused(f);
  const key = batchKey({ repo: 'tdoljyj/cross-memory-system', pr: PR, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 });
  // 03:06 the author edits the PR body to a new, valid claim: the poller's trigger is a new trigger of the waiting row.
  f.advance(MIN);
  body.claim = NEW_CLAIM;
  await f.exec.tick(); // protected Stage10 observation; no batch in this tick.
  const r = await f.exec.tick();
  assert.ok(f.clock() < backoffEnd, 'well before the back-off ends');
  assert.equal(r.state, 'COMPLETED', 'evaluated again in the same minute, and the new claim passes stage 1');
  assert.deepEqual(stage1, [OLD_CLAIM, NEW_CLAIM]);
  assert.deepEqual([f.queue.row(PR).state, f.queue.row(PR).origin], ['DONE', 'new-trigger']);
  // The same head and the same batch key (attempt 1): once-only, never a second attempt.
  assert.equal((await f.ledger.state(key)).outcome, 'COMPLETED');
  const types = await receiptTypes(f);
  assert.ok(types.includes('queue-claim-changed'));
  assert.equal(types.filter(x => x === 'batch-reserved').length, 2);
  assert.ok(f.queue.notices.some(n => n.kind === 'new-trigger' && n.code === 'CLAIM_CHANGED' && n.pr === PR));
  // The Owner's notification says the head is evaluated again now (not "after the 10-minute cool-down").
  const shown = events({ status: { pending: [], notices: f.queue.notices }, now: f.clock() }).find(e => e.key.startsWith(`notice:poke-claim:${PR}:`));
  assert.match(shown.title, /认领或授权已更新/);
  assert.match(shown.body, /立即重新评估/);
});

test('later head authorization wakes the same Task and current claim without a body edit or new trigger', async t => {
  const { f, body, stage1 } = await field(t, { good: OLD_CLAIM });
  body.status = 'head_not_authorized';
  const before = await refused(f);
  body.status = 'bound'; body.authorization = NEW_CLAIM;
  f.advance(MIN);
  await f.exec.tick();
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.ok(f.clock() < before);
  assert.deepEqual(stage1, [OLD_CLAIM, OLD_CLAIM]);
  assert.equal(f.queue.row(PR).origin, 'new-trigger');
});

test('unknown, stale, moved subject or wrong Source observations preserve the same unburned backoff', async t => {
  for (const change of ['unknown','old','future','repo','head','base','source']) await t.test(change, async t => {
    const { f, body, stage1 } = await field(t, { good: NEW_CLAIM });
    const before = await refused(f);
    body.claim = NEW_CLAIM;
    const patches = { old: { observedAt: new Date(f.clock() - 60_000).toISOString() }, future: { observedAt: new Date(f.clock() + 120_000).toISOString() },
      repo: { repository: 'foreign/repo' }, head: { headSha: 'f'.repeat(40) }, base: { baseSha: 'e'.repeat(40) }, source: { sourceManifestSha256: 'f'.repeat(64) } };
    body.unknown = change === 'unknown'; body.observationPatch = patches[change];
    f.advance(MIN); await f.exec.tick(); await f.exec.tick();
    assert.equal(f.queue.row(PR).nextAt, before);
    assert.equal(f.queue.row(PR).state, 'WAITING');
    assert.equal(stage1.length, 1);
    assert.ok(!f.engine.calls.some(c => c[0] === 'stage' && c[1] >= 2 && c[1] <= 9));
    assert.equal((await f.ledger.state(batchKey({ repo:'tdoljyj/cross-memory-system',pr:PR,headSha:HEAD,baseSha:BASE,sourceManifestSha256:SOURCE,attempt:1 }))).state, 'ABSENT');
  });
});

test('off-mode claim observation obeys the maintenance cap and preserves cleanup HALT', async t => {
  for (const change of ['cap','cleanup']) await t.test(change, async t => {
    const { f, body } = await field(t, { good: NEW_CLAIM });
    await refused(f); body.claim = NEW_CLAIM; f.advance(MIN);
    if (change === 'cap') f.exec.trainRuns = Array(200).fill(f.clock() - 1);
    else { const run = f.engine.runTrainStage; f.engine.runTrainStage = async mode => ({ ...await run(mode), proof: { windowsTreeZero: false, serviceOriginalStopped: true } }); }
    const before = f.engine.calls.filter(c => c[0] === 'stage' && c[1] === 10).length;
    const r = await f.exec.tick();
    if (change === 'cap') assert.equal(f.engine.calls.filter(c => c[0] === 'stage' && c[1] === 10).length, before);
    else { assert.equal(r.state, 'HALTED'); assert.equal(r.failureCode, 'TRAIN_STAGE_CLEANUP_UNCONFIRMED'); }
    assert.equal(f.queue.row(PR).state, 'WAITING');
  });
});

test('2026-11-08 PR #1039 control: a new trigger with the same claim keeps the back-off and the cool-down', async t => {
  const { f, stage1 } = await field(t, { good: NEW_CLAIM });
  const backoffEnd = await refused(f);
  // 03:06 an edit that leaves the claim as it was (the title, say): a new trigger, the PR read once, nothing expedited.
  f.advance(MIN);
  await f.drop(trigger(f.clock()));
  assert.notEqual((await f.exec.tick()).state, 'NOT_ADMITTED');
  const row = f.queue.row(PR);
  assert.deepEqual([row.state, row.reason, row.nextAt], ['WAITING', 'CLAIM_NOT_CURRENT', backoffEnd], 'the back-off stands');
  assert.equal(row.poke.claimCheck, undefined, 'the claim was checked once');
  assert.ok(row.poke.dueAt >= backoffEnd, 'the poke waits for the cool-down');
  for (let i = 0; i < 8; i += 1) { f.advance(MIN); await f.exec.tick(); }
  assert.deepEqual(stage1, [OLD_CLAIM], 'nothing ran before the cool-down ended');
  assert.ok(!(await receiptTypes(f)).includes('queue-claim-changed'));
  // At the end of the back-off the head is evaluated again, as before (and refused again: same claim).
  f.advance(backoffEnd - f.clock());
  assert.equal((await f.exec.tick()).failureCode, 'CLAIM_NOT_CURRENT');
  assert.deepEqual(stage1, [OLD_CLAIM, OLD_CLAIM]);
});

test('no answer from the live read, or a refusal that is not about the claim, keeps the back-off', async t => {
  // The live read answers at the evaluation but not at the poke.
  const { f, body, stage1 } = await field(t, { good: NEW_CLAIM });
  const backoffEnd = await refused(f);
  f.companion.prHead = async () => null;
  body.unknown = true;
  f.advance(MIN);
  body.claim = NEW_CLAIM;
  await f.drop(trigger(f.clock()));
  await f.exec.tick();
  assert.deepEqual([f.queue.row(PR).state, f.queue.row(PR).nextAt, stage1.length], ['WAITING', backoffEnd, 1]);
  // Another not-admitted code never asks for the claim.
  const g = await field(t, { good: NEW_CLAIM });
  await g.f.drop(trigger(g.f.clock() - MIN));
  await g.f.exec.tick();
  g.f.queue.row(PR).reason = 'PATHS_OUTSIDE_WRITE_SET';
  g.f.advance(MIN);
  g.body.claim = NEW_CLAIM;
  await g.f.drop(trigger(g.f.clock()));
  await g.f.exec.tick();
  assert.equal(g.f.queue.row(PR).poke?.claimCheck, undefined);
  assert.equal(g.f.queue.row(PR).state, 'WAITING');
  assert.equal(g.stage1.length, 1);
});

test('the companion and service PR head transport never returns authority from PR body claims', async () => {
  const argv = readPullArgv('C:\\gh.exe', 'tdoljyj/cross-memory-system', PR);
  assert.ok(!argv.at(-1).includes('body: .body'), 'the read does not ask for advisory text');
  const body = `Fixes the thing.\r\n\r\nClued-Work-Claim: ${NEW_CLAIM}\r\nClued-Work-Claim:${OLD_CLAIM}  \nnot Clued-Work-Claim: 33333333-3333-4333-8333-333333333333\n`;
  const pull = parsePull(JSON.stringify({ number: PR, state: 'open', merged: false, head: HEAD, mergeSha: null, body }), PR);
  assert.deepEqual(pull, { number: PR, state: 'open', headSha: HEAD });
  assert.equal(parsePull(JSON.stringify({ number: PR, state: 'open', merged: false, head: HEAD, body: null }), PR).claims, undefined);
  assert.equal(Object.hasOwn(parsePull(JSON.stringify({ number: PR, state: 'open', merged: false, head: HEAD }), PR), 'claims'), false, 'no body: unknown');
  const start = Date.parse('2026-11-08T03:06:00Z');
  const request = { contract: REQUEST_CONTRACT, requestId: 'abc0f111-867b-44ad-aa49-37c91a90fb03', kind: 'pr-head', batchId: '0000000000000000-000000000000', pr: PR,
    createdAt: new Date(start).toISOString(), deadline: new Date(start + 120000).toISOString() };
  const response = p => ({ contract: RESPONSE_CONTRACT, requestId: request.requestId, kind: request.kind, ok: true, code: null, proof: null, directory: null, verified: null,
    usage: null, pull: p, jobTree: null, memory: null, prune: null, observedAt: new Date(start).toISOString() });
  const observed = validateResponse(response(pull), request);
  const port = mailboxCompanion({ send: async () => request, await: async () => observed }, async () => {});
  assert.equal((await port.prHead(PR)).claims, undefined);
  const legacyPort = mailboxCompanion({ send: async () => request, await: async () => ({ ...observed, pull: { ...pull, claims: [NEW_CLAIM] } }) }, async () => {});
  assert.equal((await legacyPort.prHead(PR)).claims, undefined, 'even a legacy response cannot become claim authority');
  for (const claims of [[NEW_CLAIM, OLD_CLAIM], [OLD_CLAIM, OLD_CLAIM], ['not-a-claim'], 'x', null, Array(9).fill(0).map((_, i) => `${String(i).repeat(8)}-1111-4111-8111-111111111111`)]) {
    assert.throws(() => validateResponse(response({ ...pull, claims }), request), { code: 'MAILBOX_RESPONSE_PULL_REFUSED' }, JSON.stringify(claims));
  }
  assert.equal(validateResponse(response({ number: PR, state: 'open', headSha: HEAD }), request).pull.claims, undefined, 'a legacy answer stays valid');
});

// Task 9aafd9ec (PR #1043): a claim refusal never counts towards the release cap and never stops the head; it is looked at again by itself.
for (const [name, reasons] of [['no authorize_head yet', ['claim_not_found']], ['merge-queue place aged', ['work_claim_execution_epoch_stale']], ['renewed after the push', ['full_admission_claim_changed']]]) {
  test(`claim refusal (${name}) waits on the same head, past the release cap, and is admitted once the claim is good`, async t => {
    const refusal = { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: reasons } };
    const { f, body, stage1 } = await field(t, { good: NEW_CLAIM, refusal });
    const cap = f.policy?.limits?.releasesPerHeadPer24h ?? 3;
    await f.drop(trigger(f.clock() - MIN));
    let r = await f.exec.tick();
    assert.equal(r.failureCode, 'CLAIM_NOT_CURRENT');
    for (let i = 0; i < cap + 2; i += 1) {
      const row = f.queue.row(PR);
      assert.deepEqual([row.state, row.reason], ['WAITING', 'CLAIM_NOT_CURRENT'], `round ${i}: still waiting, not stopped`);
      if (i === 0) assert.match(row.deferred, /^CLAIM_NOT_CURRENT: /);
      f.advance(row.nextAt - f.clock() + 1);
      r = await f.exec.tick();
    }
    assert.ok(stage1.length > cap, 'evaluated more often than the release cap');
    body.claim = NEW_CLAIM; // the claim is fixed; no new commit
    const row = f.queue.row(PR);
    f.advance(Math.max(row.nextAt - f.clock(), 0) + 1);
    r = await f.exec.tick();
    assert.equal(r.state, 'COMPLETED', 'the same head is admitted again');
    assert.equal(f.queue.row(PR).current.headSha, HEAD);
  });
}

test('claim refusal: the head stops only after 24 hours of waiting for its claim', async t => {
  const { f } = await field(t, { good: NEW_CLAIM });
  await f.drop(trigger(f.clock() - MIN));
  await f.exec.tick();
  f.advance(24 * 60 * MIN);
  const row = f.queue.row(PR);
  row.nextAt = f.clock();
  await f.exec.tick();
  assert.deepEqual([f.queue.row(PR).state, f.queue.row(PR).stopKind], ['STOPPED', 'release-cap']);
});

test('G4: unchanged claim waits back off exponentially, including after unrelated PR edits', async t => {
  const { f, body, stage1 } = await field(t, { good: NEW_CLAIM });
  await f.drop(trigger(f.clock() - MIN));
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    assert.equal((await f.exec.tick()).failureCode, 'CLAIM_NOT_CURRENT');
    const due = f.queue.row(PR).nextAt;
    delays.push((due - f.clock()) / MIN);
    // Title/body edits with unchanged protected Native conditions cannot turn
    // the exponential wait back into one evaluation every ten minutes.
    if (i > 0) {
      f.advance(10 * MIN);
      await f.drop(trigger(f.clock()));
      await f.exec.tick();
      assert.equal(stage1.length, i + 1, 'an unchanged claim keeps its longer backoff');
    }
    if (i < 6) f.advance(due - f.clock());
  }
  assert.deepEqual(delays, [10, 20, 40, 80, 120, 120, 120]);
  const due = f.queue.row(PR).nextAt;
  body.claim = NEW_CLAIM;
  f.advance(MIN);
  await f.exec.tick(); // fresh protected observation, no PR edit
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.ok(f.clock() < due, 'a real claim change skips even a 120-minute wait');
  assert.deepEqual(stage1, [...Array(7).fill(OLD_CLAIM), NEW_CLAIM]);
});

test('G4: a protected claim change wakes immediately even when the waiting budget is full', async t => {
  const { f, body, stage1 } = await field(t, { good: NEW_CLAIM, limits: { waitingRetriesPer24h: 1 } });
  await f.drop(trigger(f.clock() - MIN));
  assert.equal((await f.exec.tick()).failureCode, 'CLAIM_NOT_CURRENT');
  await f.exec.tick(); // baseline protected observation
  f.advance(10 * MIN);
  await f.exec.tick(); // exhausted waiting budget; this must not reserve again
  assert.equal(f.queue.row(PR).deferred, 'WAITING_BUDGET_EXHAUSTED');
  assert.equal(stage1.length, 1);
  body.claim = NEW_CLAIM;
  f.advance(MIN);
  await f.exec.tick(); // observe new binding; no push or PR edit
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  assert.deepEqual(stage1, [OLD_CLAIM, NEW_CLAIM]);
  assert.equal(f.queue.row(PR).current.headSha, HEAD);
});
