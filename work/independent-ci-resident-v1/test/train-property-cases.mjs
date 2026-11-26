// The train's property (FABLE-defect-remediation-plan-20261124 §3.8 steps 1-3, cluster H): after one failed read of state the train does
// not own, at any read point of stage 1, 8 or 10, every PR lands within N rounds or the node stands in an explicit final state (HALT with a
// code the failure table halts on, PAUSE with a reason). train-property-driver.mjs is the scene, the injection and the verdict (landed,
// terminal, burned, stall: FABLE-train-property-decisions-20261124 §2); this module is the one table of read points, cases and known reds.
// The cases run in four files by read point, so the suite's shards spread them (decisions §4); each file runs its own part
// (suite(group)) and its own sentinel:
//   train-property-github.test.mjs   GitHub's reads (and the guard of 搁162/#1291)
//   train-property-native.test.mjs   Native, the green ledger, the poller and the stage's batch-route file
//   train-property-store.test.mjs    the sweep store's reads
//   train-property-same-ms.test.mjs  two records of one millisecond (twin), and the census
//   - POINTS is the table: each read point and the stages that call it in the scene. The census case keeps it true: a read point the
//     scene calls that is not in the table (or one of the table nobody calls any more) is red, so a new read cannot stay untested.
//   - one case per (read point, stage, error | empty), and scope 'tick' (every stage of one round) for a point two stages read; the
//     record kinds the sweep store reads "one meaning per millisecond" get a twin case each.
//   - KNOWN_RED are the reds known today, each with its verdict (burned or stall) and its board row: registered todo (they run, they are
//     red, the suite stays green), to be fixed one by one; they run KNOWN_RED_ROUNDS rounds. A file's sentinel is red when one of its
//     known reds holds again, or ends in another class: the entry then changes with the fix (decisions §6: the stage-8 cases went from
//     stall to burned with the fix of maint:622, #1321).
// Every case writes its verdict as a diagnostic line (TRAIN_PROPERTY {...}): the red table is made from the run's log.
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALREADY_EMPTY, KNOWN_RED_ROUNDS, NO_EMPTY, ROUNDS, census, holds, inject } from './train-property-driver.mjs';

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
  'companion.readBranchRules': ['poller'],
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

const ADMISSION = { verdict: 'burned', why: "board (DESK to add, decisions §派活 看板): one failed read burns the PR. Stage 1 here: STOPPED NATIVE_NOT_ADMITTED, the node idle; the code is the fixture's (stage 1 answers NATIVE_NOT_ADMITTED with no reason code for every answer but ADMITTED, e2e:1957), re-judged after decisions §5 (the fixture as a module, stage 1 through outcomeFailureCode)" };
const STAGE8 = { verdict: 'burned', why: "board (DESK to add, decisions §派活 看板): one failed read burns the PR. A stage 8 that cannot read its batch file stops the PR before it joins the merge queue (PR_NOT_OPEN_OR_CHANGED), the row STOPPED. It was a stall until the fix of maint:622 (decisions §6, #1321): stage 10 picked the PR as a rider and every front batch of the PR behind ended TRAIN_BATCH_CHANGED until DAILY_BATCH_LIMIT; now that batch is bisected, the PR behind lands and only this PR is burned" };
// The three twin cases (store:proof, store:strict-front-proof, store:full-on, every stage of one round) were known reds of 搁163 (stall,
// TRAIN_SWEEP_INCOMPLETE for ever) until d05108d15 (#1314): TrainSweepStore.write() now writes max(writtenAt, newest stamp + 1)
// (train-sweep-store.mjs:177-187), so the twin the driver writes through write() with the same writtenAt lands one millisecond later
// and the train lands (decisions §7 item 2). They run as plain cases now, the guard of that fix.
const KNOWN_RED = Object.freeze({
  "github.readChangedPaths | stage 1 | empty | after the first landing": ADMISSION,
  "github.readChangedPaths | every stage of one round | empty | after the first landing": ADMISSION,
  "github.readCompare | stage 1 | error | after the first landing": ADMISSION,
  "github.readCompare | every stage of one round | error | after the first landing": ADMISSION,
  "github.readPullRequest | stage 1 | error | after the first landing": ADMISSION,
  "github.readPullRequest | every stage of one round | error | after the first landing": ADMISSION,
  "stage-file.batch-route | stage 1 | error | after the first landing": ADMISSION,
  "stage-file.batch-route | every stage of one round | error | after the first landing": ADMISSION,
  "stage-file.batch-route | stage 1 | empty | after the first landing": ADMISSION,
  "stage-file.batch-route | every stage of one round | empty | after the first landing": ADMISSION,
  "stage-file.batch-route | stage 8 | error | after the first landing": STAGE8,
  "stage-file.batch-route | stage 8 | empty | after the first landing": STAGE8,
});

// The injection is armed after the first front batch landed: one PR is in main, the two behind it are on their way. The points the scene
// reads only before that are armed from the start.
const ARMS = ['mid'];
const FROM_START = new Set(['github.readForcePushes', 'github.readPullCommitsBounded']);
const armOf = (point, arm) => (FROM_START.has(point) ? 'start' : arm);
const nameOf = c => `${c.point} | ${c.scope === 'tick' ? 'every stage of one round' : c.scope === 'poller' ? 'the poller' : `stage ${c.scope}`} | ${c.mode}${c.times === 2 ? ' twice' : ''} | ${c.arm === 'mid' ? 'after the first landing' : 'from the start'}${c.stage8Code ? ` | stage 8 answers ${c.stage8Code}` : ''}`;
// The companion's read of main's rules (its ruleset backstop, every 5 minutes) only wakes a batch asleep on them: it is no read of the
// stages and is injected nowhere (task bd07449b r2: "one failed read" stays a read of stage 1, 8 or 10); it is in POINTS so that the
// census still names every read of the scene.
const NOT_INJECTED = new Set(['companion.readBranchRules']);
const cases = [];
for (const arm of ARMS) {
  for (const [point, stages] of Object.entries(POINTS)) for (const mode of ['error', 'empty']) {
    if (NOT_INJECTED.has(point)) continue;
    if (mode === 'empty' && (ALREADY_EMPTY.has(point) || NO_EMPTY.has(point))) continue;
    for (const scope of stages) cases.push({ point, scope, mode, arm: armOf(point, arm) });
    if (stages.length > 1) cases.push({ point, scope: 'tick', mode, arm: armOf(point, arm) });
  }
  for (const kind of TWINS) cases.push({ point: `store:${kind}`, scope: 'tick', mode: 'twin', arm: armOf(`store:${kind}`, arm) });
}
// 搁162 as the board recorded it on 11-22: the fixture's stage 8 then answered every unsettled publication with
// TRAIN_SINGLE_GREEN_NOT_PROVEN (a parking code). Since 80b938207 the fixture's stage 8 answers with the publisher's own reason and
// the same injection lands (the case of the table above, without the code). With the code of 11-22 this case stalled on main
// 43e2c3baa (1 of 3 landed, the two behind PARKED for ever) and lands on main 12e8a3dea (parked front v2, #1291): it stays here as
// the guard of that fix (decisions §1).
cases.push({ point: 'github.readBranchRules', scope: 'tick', mode: 'error', arm: 'mid', stage8Code: 'TRAIN_SINGLE_GREEN_NOT_PROVEN' });
// Task bd07449b (PLAN-ruleset-unreadable-park-r2 §3): main's rules read whole but empty put a batch to sleep at once (RULESET_UNREADABLE);
// the companion, reading the rules pinned, wakes it. The same batch answered empty again on the try it was woken for sleeps again, with
// the world unchanged: it must be woken again, or the train behind it stands for ever.
cases.push({ point: 'github.readBranchRules', scope: '8', mode: 'empty', arm: 'mid', times: 2 });

// The four files' parts. Every case is in exactly one (the census case of the same-ms file checks it).
const GROUPS = Object.freeze({
  github: c => c.mode !== 'twin' && c.point.startsWith('github.'),
  native: c => c.mode !== 'twin' && /^(native|ledger|poller|stage-file)\./.test(c.point),
  store: c => c.mode !== 'twin' && c.point.startsWith('store.'),
  'same-ms': c => c.mode === 'twin',
});

export function suite(group) {
  const mine = cases.filter(GROUPS[group]), names = new Set(mine.map(nameOf)), verdicts = new Map();
  if (group === 'same-ms') {
    test('train property, the table: the read points of stages 1, 8 and 10 in the scene are exactly POINTS, the scene lands without an injection, and every case is in one file', async t => {
      assert.deepEqual(cases.map(c => Object.keys(GROUPS).filter(g => GROUPS[g](c)).length).filter(n => n !== 1), [], 'a case in no file, or in two');
      assert.deepEqual(Object.keys(KNOWN_RED).filter(name => !cases.some(c => nameOf(c) === name)), [], 'a known red that names no case');
      const c = await census(t);
      assert.ok(c.landed, `the scene lands by itself (${c.rounds} rounds)`);
      const called = Object.fromEntries(c.points.map(p => [p.point, Object.keys(p.stages).filter(s => ['1', '8', '10', 'poller'].includes(s)).sort((a, b) => a - b)]).filter(([, stages]) => stages.length));
      assert.deepEqual(called, Object.fromEntries(Object.entries(POINTS).sort(([a], [b]) => a.localeCompare(b))), 'a read point without a case, or a case without its read point');
      assert.deepEqual(c.twinKinds, [...TWINS]);
      const outside = c.points.filter(p => Object.keys(p.stages).some(s => !['1', '8', '10', 'poller'].includes(s)));
      assert.deepEqual(outside, [], 'a read of the scene outside stage 1, 8, 10 and the poller');
    });
  }
  describe(`train property (${group}): one failed read, then within ${ROUNDS} rounds landed or an explicit final state`, { concurrency: 10 }, () => {
    for (const c of mine) {
      const name = nameOf(c), known = KNOWN_RED[name];
      it(name, known ? { todo: `${known.verdict}: ${known.why}` } : {}, async t => {
        const v = await inject(t, c, { rounds: known ? KNOWN_RED_ROUNDS : ROUNDS });
        verdicts.set(name, v);
        t.diagnostic(`TRAIN_PROPERTY ${JSON.stringify({ name, ...c, ...v, known: known?.verdict ?? null })}`);
        assert.notEqual(v.verdict, 'not-reached', `the case is void: ${v.detail}`);
        assert.ok(holds(v), `${v.verdict === 'burned' ? 'a burned PR' : 'a stall'}: ${v.detail}`);
      });
    }
  });
  test(`train property (${group}): every known red of this file still ends in its registered class (one that holds again, or ends otherwise, changes KNOWN_RED with its fix)`, () => {
    const changed = Object.entries(KNOWN_RED).filter(([name]) => names.has(name))
      .filter(([name, k]) => !verdicts.has(name) || verdicts.get(name).verdict !== k.verdict)
      .map(([name, k]) => `${name}: registered ${k.verdict}, now ${verdicts.get(name)?.verdict ?? 'not run'}`);
    assert.deepEqual(changed, []);
  });
}
