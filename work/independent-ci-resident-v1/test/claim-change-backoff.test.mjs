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
import { claimTrailers, parsePull, readPullArgv } from '../src/companion.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { events } from '../src/pr-status.mjs';
import { BASE, SAFE_REFUSAL, SOURCE, executorFixture, fakeCompanion, fakeEngine, notAdmitted } from './helpers.mjs';

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
async function field(t, { good }) {
  const body = { claim: OLD_CLAIM };
  const engine = fakeEngine();
  const run = engine.runStage;
  const stage1 = [];
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1) {
      stage1.push(body.claim);
      if (body.claim !== good) { engine.calls.push(['stage', 1]); return notAdmitted('CLAIM_NOT_CURRENT', CLAIM_REFUSAL); }
    }
    return run(batch, stage, o);
  };
  let clock = () => 0;
  const companion = fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: HEAD, claims: [body.claim] }) }, () => clock());
  const f = await executorFixture(t, { engine, companion, now: Date.parse('2026-11-08T03:05:00Z') });
  clock = f.clock;
  return { f, body, stage1 };
}

// 03:05 the first evaluation: refused CLAIM_NOT_CURRENT, released NOT_ADMITTED, the row backs off 10 minutes.
async function refused(f) {
  await f.drop(trigger(f.clock() - MIN));
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['NOT_ADMITTED', 'CLAIM_NOT_CURRENT']);
  const row = f.queue.row(PR);
  assert.deepEqual([row.state, row.reason, row.level, row.levelKind], ['BACKOFF', 'CLAIM_NOT_CURRENT', 1, 'release']);
  assert.deepEqual(row.evalClaims, [OLD_CLAIM], 'the refused evaluation saw the old claim');
  return row.nextAt;
}

test('2026-11-08 PR #1039: another claim in the PR body after a claim refusal re-evaluates the same head at once, and it passes', async t => {
  const { f, body, stage1 } = await field(t, { good: NEW_CLAIM });
  const backoffEnd = await refused(f);
  const key = batchKey({ repo: 'tdoljyj/cross-memory-system', pr: PR, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 });
  // 03:06 the author edits the PR body to a new, valid claim: the poller's trigger is a new trigger of the waiting row.
  f.advance(MIN);
  body.claim = NEW_CLAIM;
  await f.drop(trigger(f.clock()));
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
  assert.match(shown.title, /已换认领/);
  assert.match(shown.body, /立即重新评估/);
});

test('2026-11-08 PR #1039 control: a new trigger with the same claim keeps the back-off and the cool-down', async t => {
  const { f, stage1 } = await field(t, { good: NEW_CLAIM });
  const backoffEnd = await refused(f);
  // 03:06 an edit that leaves the claim as it was (the title, say): a new trigger, the PR read once, nothing expedited.
  f.advance(MIN);
  await f.drop(trigger(f.clock()));
  assert.notEqual((await f.exec.tick()).state, 'NOT_ADMITTED');
  const row = f.queue.row(PR);
  assert.deepEqual([row.state, row.reason, row.nextAt], ['BACKOFF', 'CLAIM_NOT_CURRENT', backoffEnd], 'the back-off stands');
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
  f.advance(MIN);
  body.claim = NEW_CLAIM;
  await f.drop(trigger(f.clock()));
  await f.exec.tick();
  assert.deepEqual([f.queue.row(PR).state, f.queue.row(PR).nextAt, stage1.length], ['BACKOFF', backoffEnd, 1]);
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
  assert.equal(g.f.queue.row(PR).state, 'BACKOFF');
  assert.equal(g.stage1.length, 1);
});

test('the pr-head read carries the PR body claims from gh through the companion and the mailbox to the service port', async () => {
  const argv = readPullArgv('C:\\gh.exe', 'tdoljyj/cross-memory-system', PR);
  assert.ok(argv.at(-1).includes('body: .body'), 'the read asks for the body');
  const body = `Fixes the thing.\r\n\r\nClued-Work-Claim: ${NEW_CLAIM}\r\nClued-Work-Claim:${OLD_CLAIM}  \nnot Clued-Work-Claim: 33333333-3333-4333-8333-333333333333\n`;
  const pull = parsePull(JSON.stringify({ number: PR, state: 'open', merged: false, head: HEAD, mergeSha: null, body }), PR);
  assert.deepEqual(pull, { number: PR, state: 'open', headSha: HEAD, claims: [OLD_CLAIM, NEW_CLAIM] });
  assert.deepEqual(parsePull(JSON.stringify({ number: PR, state: 'open', merged: false, head: HEAD, body: null }), PR).claims, [], 'an empty body names no claim');
  assert.equal(Object.hasOwn(parsePull(JSON.stringify({ number: PR, state: 'open', merged: false, head: HEAD }), PR), 'claims'), false, 'no body: unknown');
  assert.deepEqual(claimTrailers('Clued-Work-Claim: ABCDEF12-1111-4111-8111-111111111111'), [], 'the trailer is lower-case hex, as the poller reads it');
  const start = Date.parse('2026-11-08T03:06:00Z');
  const request = { contract: REQUEST_CONTRACT, requestId: 'abc0f111-867b-44ad-aa49-37c91a90fb03', kind: 'pr-head', batchId: '0000000000000000-000000000000', pr: PR,
    createdAt: new Date(start).toISOString(), deadline: new Date(start + 120000).toISOString() };
  const response = p => ({ contract: RESPONSE_CONTRACT, requestId: request.requestId, kind: request.kind, ok: true, code: null, proof: null, directory: null, verified: null,
    usage: null, pull: p, jobTree: null, memory: null, prune: null, observedAt: new Date(start).toISOString() });
  const observed = validateResponse(response(pull), request);
  const port = mailboxCompanion({ send: async () => request, await: async () => observed }, async () => {});
  assert.deepEqual((await port.prHead(PR)).claims, [OLD_CLAIM, NEW_CLAIM]);
  for (const claims of [[NEW_CLAIM, OLD_CLAIM], [OLD_CLAIM, OLD_CLAIM], ['not-a-claim'], 'x', null, Array(9).fill(0).map((_, i) => `${String(i).repeat(8)}-1111-4111-8111-111111111111`)]) {
    assert.throws(() => validateResponse(response({ ...pull, claims }), request), { code: 'MAILBOX_RESPONSE_PULL_REFUSED' }, JSON.stringify(claims));
  }
  assert.equal(validateResponse(response({ number: PR, state: 'open', headSha: HEAD }), request).pull.claims, undefined, 'a legacy answer stays valid');
});
