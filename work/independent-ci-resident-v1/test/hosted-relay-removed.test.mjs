// The hosted relay is removed (DESIGN §76, Owner 2026-11-14): stage R, the hosted wait and its hints, and the relay qualification
// hold are gone from the executor. A batch runs exactly as the shipped relay.enabled = false did (stages 1-8, the same plan records
// and receipts), without the per-batch qualification-window read; an installed policy that still carries a `relay` block (every
// node before the upgrade) is accepted and the block is dropped unread, whatever it says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchKey } from '../src/ledger.mjs';
import { HEAVY_ROLES, LEGACY_POLICY_KEYS, batchBudgetMs, validatePolicy } from '../src/policy.mjs';
import { BASE, HEAD, RELAY_OFF, SOURCE, executorFixture, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const types = async f => (await f.receipts.entries()).map(e => e.type);
const strip = ({ at, key, ...rest }) => rest;
const LEGACY_ON = Object.freeze({ ...RELAY_OFF, enabled: true });
// The records main 6eac0f12 wrote for this batch with relay.enabled = false (the shipped default of every node).
const PLAN_INTENT = { contract: 'clued.independent-ci.resident-relay-plan-intent/1', candidates: [], local: ['gitleaks', 'trivy', 'contract-placement'],
  reasons: { gitleaks: 'RELAY_DISABLED', trivy: 'RELAY_DISABLED', 'contract-placement': 'RELAY_DISABLED' }, reason: 'RELAY_DISABLED', waitedMs: 0, hintSha256: null, hintRefused: false };
const PLAN = { contract: 'clued.independent-ci.resident-relay-plan/1', candidates: [], relayed: [],
  local: HEAVY_ROLES.map(role => ({ role, reason: 'RELAY_DISABLED', receipt: 'relay-local-fallback', source: 'resident' })) };
const RECEIPTS = ['executed-heads-backfilled', 'trigger-queued', 'batch-reserved', 'batch-derived', 'stage-terminal', 'batch-started', 'relay-plan-intent',
  'stage-terminal', 'stage-terminal', 'stage-terminal', 'stage-terminal', 'stage-terminal', 'stage-terminal', 'batch-parked', 'stage-terminal', 'batch-terminal'];

// Every removed port throws if anything still calls it: the hosted wait's hint, stage R and the qualification-window read.
function noRelayPorts(f, engine) {
  const called = [];
  for (const [o, name] of [[engine, 'relayQualificationWindow'], [engine, 'runRelayStage'], [engine, 'runRelayQualification'], [f.companion, 'hostedHint']])
    o[name] = async () => { called.push(name); throw new Error(`${name} is removed`); };
  return called;
}

for (const [name, relay] of [['no relay block (a new package)', undefined], ['a legacy relay block, off (every node today)', RELAY_OFF], ['a legacy relay block that says on', LEGACY_ON]]) {
  test(`relay removed, ${name}: one batch runs 1-8 with no wait, no stage R and no relay port, and writes the records relay off wrote`, async t => {
    const engine = fakeEngine();
    const f = await executorFixture(t, { engine, policy: rawPolicy(relay === undefined ? {} : { relay }) });
    const called = noRelayPorts(f, engine);
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.equal(r.state, 'COMPLETED');
    assert.deepEqual(stagesRun(engine), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(called, [], 'no hint, no stage R, no qualification-window read');
    const s = await f.ledger.state(r.key);
    assert.deepEqual([strip(s.planIntent), strip(s.plan)], [PLAN_INTENT, PLAN]);
    assert.deepEqual(await types(f), RECEIPTS);
    assert.deepEqual(r.relayed, []);
  });
}

test('a legacy relay block is accepted and dropped unread; the batch budget never counts a hosted wait; any other unknown key is still refused', () => {
  assert.deepEqual([...LEGACY_POLICY_KEYS], ['relay']);
  const plain = validatePolicy(rawPolicy());
  for (const relay of [RELAY_OFF, LEGACY_ON, { anything: true }]) {
    const p = validatePolicy(rawPolicy({ relay }));
    assert.equal(Object.hasOwn(p, 'relay'), false, 'nothing downstream can read it');
    assert.equal(batchBudgetMs(p), batchBudgetMs(plain));
  }
  assert.throws(() => validatePolicy(rawPolicy({ hostedRelay: RELAY_OFF })), { code: 'POLICY_KEYS_INVALID' });
});

test('a crash between 20-plan-intent and 25-plan still closes FAILED_UNKNOWN RELAY_STAGE_INTERRUPTED and HALTs (unchanged)', async t => {
  const f = await executorFixture(t);
  const s = { repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1 }, key = batchKey(s);
  const batch = { batchId: `${key.slice(0, 16)}-${'0'.repeat(12)}`, key };
  await f.ledger.reserve(key, s);
  await f.ledger.markStarted(key, { batchId: batch.batchId });
  await f.ledger.beginWait(key, { t0: f.clock(), batch });
  await f.ledger.writePlanIntent(key, { candidates: [], local: [...HEAVY_ROLES], reasons: {}, reason: 'RELAY_DISABLED' });
  const r = await f.exec.tick();
  assert.equal(r.state, 'HALTED');
  const st = await f.ledger.state(key);
  assert.deepEqual([st.outcome, st.terminal.facts.failureCode], ['FAILED_UNKNOWN', 'RELAY_STAGE_INTERRUPTED']);
  assert.deepEqual(stagesRun(f.engine), []);
});
