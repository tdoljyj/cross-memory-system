// Board 271 (FABLE-backlog-batch-design-20261124 §4): a helper the broker saw started (it reached RUNNING, so its preflight
// passed) that left no receipt may have run a child. The Source fact for it, read by the resident, must HALT: no same-batch
// retry on the "nothing launched" basis, no retry-stage archive. Before the fix the Source called it STAGE_HELPER_PREFLIGHT_REFUSED
// with a confirmed zero tree and the resident ran stage 1 again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseStageFact } from '../src/engine-windows.mjs';
import { buildStageFact } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const M = 'f'.repeat(64);
const started = { contract: 'x', requestId: '0a1b2c3d-0000-4000-8000-000000000001', ok: true, code: null, started: true, startCallIssued: true, helperPid: 4242,
  stoppedInTime: true, restored: true, accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false };

async function bodies(f, type) {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
}

test('a started helper without a receipt: the resident HALTs, never runs the stage again in the batch', async t => {
  const fact = buildStageFact({ stage: 1, nonce: 'a'.repeat(32), plan: { stage: 1 }, planSha256: 'b'.repeat(64), workManifestSha256: M, broker: started });
  const result = parseStageFact(JSON.stringify(fact), M);
  const engine = fakeEngine();
  const run = engine.runStage;
  let first = true;
  engine.runStage = async (batch, stage, o) => {
    if (stage.number === 1 && first) { first = false; engine.calls.push(['stage', 1]); engine.opts.push([1, o ?? null]); return result; }
    return run(batch, stage, o);
  };
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  await f.exec.tick();
  assert.deepEqual(await bodies(f, 'execution-retry'), [], 'no same-batch retry');
  assert.equal(engine.calls.filter(c => c[0] === 'stage' && c[1] === 1).length, 1, 'stage 1 ran once');
  assert.ok(!engine.calls.some(c => c[0] === 'archive-windows' && String(c[1]).startsWith('retry-stage')), 'no retry-stage archive');
  assert.equal((await f.ledger.halted())?.value?.code ?? null, 'NATIVE_RECEIPT_UNCONFIRMED', JSON.stringify(result));
});
