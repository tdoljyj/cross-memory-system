// The train's property (FABLE-defect-remediation-plan-20261124 §3.8 steps 1-3, cluster H): after one failed read of state the train does
// not own, at any read point of stage 1, 8 or 10, every PR lands within N rounds or the node stands in an explicit final state (HALT with a
// code of the failure table, PAUSE with a reason). A path that does neither is a silent stall: red. train-property-driver.mjs is the
// scene, the injection and the verdict; this file is the table of read points and the cases.
//   - POINTS is the table: each read point and the stages that call it in the scene. The census case keeps it true: a read point the
//     scene calls that is not in the table (or one of the table nobody calls any more) is red, so a new read cannot stay untested.
//   - one case per (read point, stage, error | empty), and scope 'tick' (every stage of one round) for a point two stages read; the
//     record kinds the sweep store reads "one meaning per millisecond" get a twin case each.
//   - KNOWN_RED are the stalls known today, each with its board row: registered todo (they run, they are red, the suite stays green),
//     to be fixed one by one. The last case is red when one of them holds again: the entry is then removed with the fix.
// Every case writes its verdict as a diagnostic line (TRAIN_PROPERTY {...}): the red table is made from the run's log.
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALREADY_EMPTY, ROUNDS, census, inject } from './train-property-driver.mjs';

const POINTS = Object.freeze({
  'github.readBranchHead': ['8', '10'],
  'github.readBranchRules': ['8', '10'],
  'github.readChangedPaths': ['1', '8', '10'],
  'github.readChecks': ['8', '10'],
  'github.readCompare': ['1', '8', '10'],
  'github.readForcePushes': ['10'],
  'github.readGitCommit': ['8', '10'],
  'github.readOwnChecksByName': ['10'],
  'github.readPullCommitsBounded': ['10'],
  'github.readPullRequest': ['1', '8', '10'],
  'github.readPullsPage': ['10'],
  'github.readPullsUpdatedSince': ['10'],
  'github.readRuleset': ['8', '10'],
  'ledger.list': ['8', '10'],
  'native.holders': ['8', '10'],
  'native.nodesStatus': ['8', '10'],
  'poller.gh': ['poller'],
  'poller.status': ['poller'],
  'stage-file.batch-route': ['1', '8'],
  'store.landingBatchByTest': ['8'],
  'store.landingBatches': ['10'],
  'store.latestProof': ['8'],
  'store.latestProofStrict': ['8', '10'],
  'store.latestStrictFrontProof': ['8', '10'],
  'store.latestStrictProof': ['8', '10'],
  'store.readFrontSeen': ['10'],
  'store.readFullSweep': ['10'],
  'store.readFullSweepStrict': ['8', '10'],
  'store.readLandingState': ['10'],
  'store.readPendingRevocations': ['8', '10'],
  'store.readScanProgress': ['10'],
  'store.readSlotGreen': ['10'],
  'store.readStrictRound': ['8', '10'],
});
// The record kinds of the sweep store that have a record in the scene (the census case keeps it true).
const TWINS = Object.freeze(['proof', 'full-on', 'strict-front-proof']);

const ADMISSION = "unregistered: one failed read of the admission (stage 1) burns the PR (STOPPED NATIVE_NOT_ADMITTED, no HALT, no PAUSE); the code is the fixture's, the verdict stands at the fixture boundary";
const B163 = "board 搁163: two sweep proofs of one millisecond, the train stays TRAIN_SWEEP_INCOMPLETE for ever";
const B162 = "board 搁162: stage 8 and 10 cannot read the rules, the PRs behind the landed front stay parked (with the stage 8 code of the fixture of 11-22)";
const TWIN_FULL = "unregistered: the class of 搁163 on another record kind: two full-sweep records of one millisecond, the train stays TRAIN_SWEEP_INCOMPLETE and the takeover waits for the sweep for ever";
const KNOWN_RED = Object.freeze({
  "github.readChangedPaths | stage 1 | empty | after the first landing": ADMISSION,
  "github.readChangedPaths | every stage of one round | empty | after the first landing": ADMISSION,
  "github.readCompare | stage 1 | error | after the first landing": ADMISSION,
  "github.readCompare | every stage of one round | error | after the first landing": ADMISSION,
  "github.readCompare | stage 1 | empty | after the first landing": ADMISSION,
  "github.readCompare | every stage of one round | empty | after the first landing": ADMISSION,
  "github.readPullRequest | stage 1 | error | after the first landing": ADMISSION,
  "github.readPullRequest | every stage of one round | error | after the first landing": ADMISSION,
  "github.readPullRequest | stage 1 | empty | after the first landing": ADMISSION,
  "github.readPullRequest | every stage of one round | empty | after the first landing": ADMISSION,
  "stage-file.batch-route | stage 1 | error | after the first landing": ADMISSION,
  "stage-file.batch-route | every stage of one round | error | after the first landing": ADMISSION,
  "stage-file.batch-route | stage 1 | empty | after the first landing": ADMISSION,
  "stage-file.batch-route | every stage of one round | empty | after the first landing": ADMISSION,
  "store:proof | every stage of one round | twin | after the first landing": B163,
  "store:strict-front-proof | every stage of one round | twin | after the first landing": B163,
  "store:full-on | every stage of one round | twin | after the first landing": TWIN_FULL,
  "github.readBranchRules | every stage of one round | error | after the first landing | stage 8 answers TRAIN_SINGLE_GREEN_NOT_PROVEN": B162,
});

// The injection is armed after the first front batch landed: one PR is in main, the two behind it are on their way. The points the scene
// reads only before that are armed from the start.
const ARMS = ['mid'];
const FROM_START = new Set(['github.readForcePushes', 'github.readPullCommitsBounded']);
const armOf = (point, arm) => (FROM_START.has(point) ? 'start' : arm);
const nameOf = c => `${c.point} | ${c.scope === 'tick' ? 'every stage of one round' : c.scope === 'poller' ? 'the poller' : `stage ${c.scope}`} | ${c.mode} | ${c.arm === 'mid' ? 'after the first landing' : 'from the start'}${c.stage8Code ? ` | stage 8 answers ${c.stage8Code}` : ''}`;
const cases = [];
for (const arm of ARMS) {
  for (const [point, stages] of Object.entries(POINTS)) for (const mode of ['error', 'empty']) {
    if (mode === 'empty' && ALREADY_EMPTY.has(point)) continue;
    for (const scope of stages) cases.push({ point, scope, mode, arm: armOf(point, arm) });
    if (stages.length > 1) cases.push({ point, scope: 'tick', mode, arm: armOf(point, arm) });
  }
  for (const kind of TWINS) cases.push({ point: `store:${kind}`, scope: 'tick', mode: 'twin', arm: armOf(`store:${kind}`, arm) });
}
// 搁162 as the board recorded it on 11-22: the fixture's stage 8 then answered every unsettled publication with
// TRAIN_SINGLE_GREEN_NOT_PROVEN (a parking code). Since 80b938207 the fixture's stage 8 answers with the publisher's own reason and
// the same injection lands (the case of the table above, without the code). Which of the two the product's stage 8 does is open.
cases.push({ point: 'github.readBranchRules', scope: 'tick', mode: 'error', arm: 'mid', stage8Code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN' });
const verdicts = new Map();
const holds = v => v.verdict === 'landed' || v.verdict === 'terminal';
const record = (t, name, c, v) => {
  verdicts.set(name, v);
  t.diagnostic(`TRAIN_PROPERTY ${JSON.stringify({ name, ...c, ...v, known: KNOWN_RED[name] ?? null })}`);
};

test('train property, the table: the read points of stages 1, 8 and 10 in the scene are exactly POINTS, and the scene lands without an injection', async t => {
  const c = await census(t);
  assert.ok(c.landed, `the scene lands by itself (${c.rounds} rounds)`);
  const called = Object.fromEntries(c.points.map(p => [p.point, Object.keys(p.stages).filter(s => ['1', '8', '10', 'poller'].includes(s)).sort((a, b) => a - b)]).filter(([, stages]) => stages.length));
  assert.deepEqual(called, Object.fromEntries(Object.entries(POINTS).sort(([a], [b]) => a.localeCompare(b))), 'a read point without a case, or a case without its read point');
  assert.deepEqual(c.twinKinds, [...TWINS]);
  const outside = c.points.filter(p => Object.keys(p.stages).some(s => !['1', '8', '10', 'poller'].includes(s)));
  assert.deepEqual(outside, [], 'a read of the scene outside stage 1, 8, 10 and the poller');
});

describe(`train property: one failed read, then within ${ROUNDS} rounds landed or an explicit final state`, { concurrency: 10 }, () => {
  for (const c of cases) {
    const name = nameOf(c), known = KNOWN_RED[name];
    it(name, known ? { todo: known } : {}, async t => {
      const v = await inject(t, c);
      record(t, name, c, v);
      assert.notEqual(v.verdict, 'not-reached', `the case is void: ${v.detail}`);
      assert.ok(holds(v), `silent stall: ${v.detail}`);
    });
  }
});

test('train property: every known red is still red (one that holds again leaves KNOWN_RED with its fix)', () => {
  const healed = Object.keys(KNOWN_RED).filter(name => verdicts.has(name) && holds(verdicts.get(name)));
  assert.deepEqual(healed, []);
  assert.deepEqual(Object.keys(KNOWN_RED).filter(name => !cases.some(c => nameOf(c) === name) && !verdicts.has(name)), [], 'a known red that names no case');
});
