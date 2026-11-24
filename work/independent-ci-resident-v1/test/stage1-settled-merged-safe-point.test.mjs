// Field 2026-11-23 (PR #1233-#1239; FABLE-resident-halt-merge-race-followup-20261123 section 1): the resident's stage-1 success is the
// PR's last required check, so GitHub's auto-merge merges the PR seconds later. The Source's stage-1 publisher then ends SETTLED and
// says so (settledMerged: true): the green stands, nothing is withdrawn. The executor counted every settled stage 1 as the batch's
// first live read of the rule (DESIGN §72), so no read was due at the two safe points after it for SUPERSEDE_LIVE_READ_MS and the
// batch ran its remaining stages on a PR that had already merged.
// End to end on the resident's side: a stage-1 result as the publisher gives it, through the real outcome record (Source
// stage-inputs.mjs#writeOutcome), the real stage fact (stage-fact.mjs#outcomeFacts) and the engine's own parse
// (engine-windows.mjs#parseStageOutcome), into the real executor; the companion's live PR read says closed from the moment stage 1 ran.
//   - settledMerged: stage 1 was no read of an open PR, so the read at before-relay-plan is due and the batch ends there the one way
//     (supersededEnd: FAILED_CLEAN SUPERSEDED_AT_SAFE_POINT, neutral for the breaker, never an attempt 2). Nothing after stage 1 runs.
//   - whatever a later stage would have answered on the merged PR never reaches the breaker.
//   - a settled stage 1 without the flag stays the batch's first read, as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeOutcome } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-inputs.mjs';
import { outcomeFacts } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { parseStageOutcome } from '../src/engine-windows.mjs';
import { SUPERSEDED_AT_SAFE_POINT } from '../src/executor.mjs';
import { failureRow } from '../src/classify.mjs';
import { HEAD, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

const SETTLED = Object.freeze({ status: 'SETTLED', effectKey: 'k', checkRunId: 1000, sideEffects: 2, productionAuthorized: false });
const MERGED = Object.freeze({ ...SETTLED, settledMerged: true });
// What the plan feared a later stage answers on a merged PR: a refusal no row names, on a row the breaker counts.
const STAGE2_REFUSED = Object.freeze({ ok: false, code: 'STAGE_CHILD_REFUSED', proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: Object.freeze({ status: 'BLOCKED', reason: 'pr_not_open', sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false }) });

// The stage-1 outcome as the resident receives it: the publisher's result through every hop that names its fields.
async function carried(t, result) {
  const written = await writeOutcome({ receiptsRoot: await tempRoot(t, 'clued-outcome-'), nonce: randomUUID().replace(/-/g, ''), plan: { stage: 1, entryRole: 'work-admission' }, jobIds: [], result });
  return parseStageOutcome(outcomeFacts(written));
}

// A resident whose stage 1 answers `stage1(pr)`; a PR in `merges` is merged by GitHub the moment its stage 1 has run (the companion's
// live read says closed from then on). Stage 2 of a merged PR refuses on a counting row.
async function node(t, { stage1, merges = [884], policy = rawPolicy() }) {
  const engine = fakeEngine(), run = engine.runStage, closed = new Set(), heads = new Map(), prOf = new Map(), derive = engine.derive;
  engine.derive = async (subject, key, chain) => { prOf.set(key, subject.pr); heads.set(subject.pr, subject.headSha); return derive(subject, key, chain); };
  engine.runStage = async (batch, stage, o) => {
    const pr = prOf.get(batch.key);
    if (stage.number === 1) {
      engine.calls.push(['stage', 1]);
      if (merges.includes(pr)) closed.add(pr);
      return { ok: true, factsSha256: 'd'.repeat(64), outcome: await carried(t, stage1(pr)) };
    }
    if (stage.number === 2 && closed.has(pr)) { engine.calls.push(['stage', 2]); return STAGE2_REFUSED; }
    return run(batch, stage, o);
  };
  const companion = fakeCompanion({ pull: pr => ({ number: pr, state: closed.has(pr) ? 'closed' : 'open', headSha: heads.get(pr) ?? HEAD }) });
  const f = await executorFixture(t, { engine, companion, policy });
  return Object.assign(f, { stages: () => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]) });
}

test('#1233-#1239: stage 1 settled on a PR that merged (settledMerged) -> the batch ends SUPERSEDED_AT_SAFE_POINT at before-relay-plan, nothing after stage 1 runs', async t => {
  const f = await node(t, { stage1: () => MERGED });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.safePoint], ['FAILED_CLEAN', SUPERSEDED_AT_SAFE_POINT, 'before-relay-plan'], JSON.stringify(r));
  assert.deepEqual(f.stages(), [1], 'nothing after stage 1 ran for the merged PR');
  const s = await f.ledger.state(r.key);
  assert.deepEqual([s.outcome, s.terminal.facts.basis, s.terminal.facts.liveState, s.terminal.facts.breaker, s.selfAbort.basis], ['FAILED_CLEAN', 'pr-closed', 'closed', 'neutral', 'pr-closed']);
  assert.equal(await f.ledger.halted(), null, 'no HALT');
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 'never an attempt 2');
  // The next PR is taken as usual.
  await f.drop(triggerBytes({ pr: 885, headSha: '7'.repeat(40) }));
  const next = await f.exec.tick();
  assert.equal(next.state, 'COMPLETED', JSON.stringify(next));
});

test('PRs closed before stage 2 starts: every ending is neutral for the breaker, however many in a row', async t => {
  const policy = rawPolicy(), prs = Array.from({ length: policy.breaker.windowCount + 1 }, (_, i) => 884 + i);
  const f = await node(t, { stage1: () => MERGED, merges: prs, policy });
  for (const pr of prs) {
    await f.drop(triggerBytes({ pr, headSha: String(pr % 10).repeat(40) }));
    const r = await f.exec.tick();
    assert.equal(r.state, 'FAILED_CLEAN', `PR ${pr}: ${JSON.stringify(r)}`);
    // The breaker counts an ending by its row of the failure table (classify.mjs#failureRow, executor.mjs#feedBreaker).
    const row = failureRow({ code: r.failureCode, stage: 1 });
    assert.deepEqual([r.failureCode, row?.breaker, (await f.ledger.state(r.key)).terminal.facts.breaker], [SUPERSEDED_AT_SAFE_POINT, 'neutral', 'neutral'], `PR ${pr}`);
    f.advance(60_000);
  }
  assert.equal(f.stages().includes(2), false, 'stage 2 never started on a merged PR');
  assert.equal(f.queue.breaker?.state ?? 'closed', 'closed', `the breaker stays closed: ${JSON.stringify(f.queue.breaker)}`);
  assert.equal(await f.ledger.halted(), null);
});

test('a settled stage 1 without the flag is still the first live read of its batch; the flag alone costs one read and ends nothing', async t => {
  const reads = f => f.companion.calls.filter(c => c[0] === 'pr-head').length;
  const plain = await node(t, { stage1: () => SETTLED, merges: [] });
  await plain.drop(triggerBytes());
  const r = await plain.exec.tick();
  assert.equal(r.state, 'COMPLETED', JSON.stringify(r));
  const flagged = await node(t, { stage1: () => MERGED, merges: [] });
  await flagged.drop(triggerBytes());
  assert.equal((await flagged.exec.tick()).state, 'COMPLETED', 'the PR reads open at this head: the batch goes on');
  assert.equal(reads(flagged), reads(plain) + 1, 'exactly one more live read (before-relay-plan)');
});
