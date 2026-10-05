import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  APP_ROOT, CONTRACT, DEFAULT_FILES, GATES, REPO_ROOT, SCHEMA, buildEvidence, extractIds, extractRefs, fileSeeds, main,
  parseContract, propertySamples,
} from '../evals/integration-runtime/gate-evidence.mjs';

// S2c Integration Runtime PR-6 (IntegrationRuntime v0.1.8 §14.1, §17 item 2): the gate evidence generator.
// The full run (every S2c suite, embedded PostgreSQL) is the CI step itself; this file checks the parts
// that decide the verdict — the §13 ID table read from the contract, the name → ID mapping, the verdict
// rules — and runs the generator end to end over the Worker suite, which needs no database.

const contract = await fs.readFile(path.join(REPO_ROOT, CONTRACT), 'utf8');
const criteria = parseContract(contract);
const file = path.join(APP_ROOT, 'tests/x.test.mjs');
const event = (type, name, extra = {}) => ({ type, name, nesting: 1, file, ...extra });
const pass = (name, extra) => event('test:pass', name, extra);
const byId = (evidence) => Object.fromEntries([...evidence.criteria, ...evidence.supplementary].map((c) => [c.id, c]));

test('§13: every test ID with its gate and listed parts, read from the contract', () => {
  const gated = criteria.filter((c) => c.gate);
  const count = (gate) => gated.filter((c) => c.gate === gate).length;
  assert.deepEqual(Object.fromEntries(GATES.map((g) => [g, count(g)])),
    { 'G-A3': 6, 'G-A7': 10, 'G-A8': 4, 'G-A9': 12, 'G-A10': 14, 'G-A11': 28 });
  // the ID prefix names the gate: T-A3 → G-A3 … T-A11 → G-A11
  for (const c of gated) assert.equal(c.gate, `G-${/^T-(A\d+)-/.exec(c.id)[1]}`, c.id);
  assert.deepEqual(criteria.filter((c) => !c.gate).map((c) => c.id),
    ['T-S-1', 'T-S-2', 'T-S-3', 'T-S-4', 'T-S-5', 'T-S-6', 'T-S-7', 'T-W-1', 'T-W-2', 'T-W-3', 'T-W-4', 'T-W-5', 'T-W-6']);
  // only T-A11-26 is retired: its row says PR-4 deletes the test (v0.1.8 NIT-3)
  assert.deepEqual(criteria.filter((c) => c.retired).map((c) => c.id), ['T-A11-26']);
  const parts = Object.fromEntries(criteria.filter((c) => c.parts.length).map((c) => [c.id, c.parts.join('')]));
  assert.equal(parts['T-A11-20'], 'abcd');
  assert.equal(parts['T-A11-4b'], 'abcd');
  assert.equal(Object.keys(parts).length, 13);
});

test('the contract parser fails loudly instead of dropping a row', () => {
  assert.throws(() => parseContract('### 13.1 G-A3 — x\n| T-A3-1 | a |\n| T-A3-1 | b |\n'), /T-A3-1 twice/);
  assert.throws(() => parseContract('### 13.1 G-A3 — x\n|T-A3-1| a |\n'), /unparsed row/);
  assert.throws(() => parseContract('### 13.1 G-A3 — x\n| T-A3-2  | b |\n'), /unparsed row/);
  // `## 14.` closes §13 even with its trailing dot: a later table row belongs to no section
  assert.deepEqual(parseContract('### 13.8 Worker\n| T-W-1 | a |\n## 14. next\n| T-W-9 | b |\n').map((c) => c.id), ['T-W-1']);
  // header and separator lines of a §13 table are not rows
  assert.equal(parseContract('### 13.1 G-A3 — x\n| ID | 证明 | 方法 |\n|---|---|---|\n| T-A3-1 | a | b |\n').length, 1);
});

test('every live §13.1–§13.6 ID is named by some S2c test (static guard, no database)', async () => {
  const sources = (await Promise.all(DEFAULT_FILES.map((f) => fs.readFile(path.join(APP_ROOT, f), 'utf8')))).join('\n');
  const missing = criteria.filter((c) => c.gate && !c.retired)
    .filter((c) => !new RegExp(`\\b${c.id}(?![0-9a-z])`).test(sources)).map((c) => c.id);
  assert.deepEqual(missing, []);
});

test('a test name proves the IDs it carries, with the parts it names', () => {
  assert.deepEqual(extractIds('T-A10-9 / T-A7-9 a Claim Store divergence fails closed'), ['T-A10-9', 'T-A7-9']);
  assert.deepEqual(extractRefs('T-A11-15(c)(e) superseded revocation scope'), [{ id: 'T-A11-15', parts: ['c', 'e'] }]);
  assert.deepEqual(extractRefs('T-A11-4b (a)(d): the Host disconnect'), [{ id: 'T-A11-4b', parts: ['a', 'd'] }]);
  assert.deepEqual(extractRefs('T-A11-17(a) / T-A11-15(d) reconcile'), [{ id: 'T-A11-17', parts: ['a'] }, { id: 'T-A11-15', parts: ['d'] }]);
  assert.deepEqual(extractRefs('T-A11-20 guards (a)(b)'), [{ id: 'T-A11-20', parts: [] }], 'parts not next to the ID: the whole ID');
  assert.deepEqual(extractRefs('T-A3-1 (P2 facts layer) x'), [{ id: 'T-A3-1', parts: [] }]);
  assert.deepEqual(extractIds('P1 predicate layer: exhaustive 2^22 vectors (T-A7-4, T-A7-6, T-A7-7, T-A7-8)'),
    ['T-A7-4', 'T-A7-6', 'T-A7-7', 'T-A7-8']);
  assert.deepEqual(extractIds('T-A1-10 is not T-A1-1'), ['T-A1-10', 'T-A1-1']);
  assert.deepEqual(extractIds('T-A11-4bis and T-A11-40xy'), [], 'no ID inside a longer token');
  assert.deepEqual(extractIds('registries: v1 seeds (§5.1)'), []);
});

test('the property layer reports its seeds and sample counts', async () => {
  const derivation = await fs.readFile(path.join(APP_ROOT, 'tests/integration-runtime-derivation-db.test.mjs'), 'utf8');
  assert.deepEqual(fileSeeds(derivation), { node: 'mulberry32(20260924)' });
  assert.deepEqual(fileSeeds('const x = 1;'), {});
  assert.deepEqual(propertySamples([
    'P1 {"enumerated":4194304,"consistent":21504,"states":10}',
    'P2 {"layers":{"single":120,"pairwise":15000,"random":250000},"states":{}}',
    'unrelated diagnostic',
  ]), { P1: { enumerated: 4194304, consistent: 21504 }, P2: { single: 120, pairwise: 15000, random: 250000, total: 265120 } });
});

test('verdict rules: PASS needs every owned ID PASS or RETIRED; FAIL wins; a missing ID is NOT_EVALUATED', () => {
  const mini = parseContract([
    '### 13.1 G-A3 — x', '| T-A3-1 | a |', '| T-A3-2 | b |',
    '### 13.2 G-A7 — y', '| T-A7-1 | c |',
    '### 13.5 G-A11 — z', '| T-A11-1 | d |', '| T-A11-26 | PR-2 临时拒绝（PR-4 删除本测试） | e |',
    '### 13.8 Worker', '| T-W-1 | f |',
  ].join('\n'));
  const derivation = 'tests/integration-runtime-derivation-db.test.mjs';
  const events = [
    pass('T-A3-1 (P2 facts layer) Candidate empty', { file: path.join(APP_ROOT, derivation), duration_ms: 3 }),
    pass('T-A3-2 / T-A7-1 both'),
    event('test:fail', 'T-A7-1(b) second half', { error: 'expected 1' }),
    pass('T-A11-1 revoke'),
    pass('T-W-1 tools/list'),
    pass('T-A99-1 a stale id'),
    event('test:diagnostic', null, { message: 'P2 {"layers":{"single":1,"pairwise":2,"random":3}}' }),
  ];
  const seeds = { [derivation]: { node: 'mulberry32(20260924)' }, 'tests/x.test.mjs': { node: 'mulberry32(1)' } };
  const evidence = buildEvidence({ criteria: mini, events, seedsByFile: seeds });
  const ids = byId(evidence);
  assert.equal(ids['T-A3-1'].result, 'PASS');
  assert.deepEqual(ids['T-A3-1'].seed, { node: 'mulberry32(20260924)' }, 'a property-layer test carries its seed');
  assert.deepEqual(ids['T-A3-1'].samples, { test_cases: 1, P2: { single: 1, pairwise: 2, random: 3, total: 6 } });
  assert.equal(ids['T-A3-2'].seed, 'deterministic', 'a fixture test in a seeded file is still deterministic');
  assert.equal(ids['T-A7-1'].result, 'FAIL', 'one failing part fails the ID');
  assert.equal(ids['T-A7-1'].samples.test_cases, 2);
  assert.equal(ids['T-A11-26'].result, 'RETIRED');
  assert.equal(ids['T-W-1'].result, 'PASS');
  assert.deepEqual(evidence.gates, { 'G-A3': 'PASS', 'G-A7': 'FAIL', 'G-A8': 'NOT_EVALUATED', 'G-A9': 'NOT_EVALUATED',
    'G-A10': 'NOT_EVALUATED', 'G-A11': 'PASS' });
  assert.equal(evidence.verdict, 'FAIL');
  assert.deepEqual(evidence.failed_tests, [{ file: 'tests/x.test.mjs', name: 'T-A7-1(b) second half', error: 'expected 1' }]);
  assert.deepEqual(evidence.unknown_ids, ['T-A99-1']);
  assert.equal(evidence.summary.pass, 3);
  assert.equal(evidence.summary.retired, 1);
});

test('fail closed: skipped tests, parent containers, uncovered parts, unknown IDs, retired drift, a crashed runner', () => {
  const full = parseContract(['### 13.1 G-A3 — a', '| T-A3-1 | x |', '### 13.2 G-A7 — b', '| T-A7-1 | x |',
    '### 13.3 G-A8 — c', '| T-A8-1 | x |', '### 13.4 G-A10 — d', '| T-A10-1 | x (a)(b) |', '### 13.5 G-A11 — e', '| T-A11-1 | x |',
    '### 13.6 G-A9 — f', '| T-A9-1 | x |'].join('\n'));
  const all = full.map((c) => pass(`${c.id} ok`));
  const passing = buildEvidence({ criteria: full, events: all });
  assert.deepEqual(new Set(Object.values(passing.gates)), new Set(['PASS']));
  assert.equal(passing.verdict, 'PASS');
  assert.deepEqual(byId(passing)['T-A10-1'].parts, { required: ['a', 'b'], named: 'whole' });

  const swap = (id, replacement) => [...all.filter((e) => !e.name.startsWith(`${id} `)), ...replacement];
  const verdictOf = (events, extra = {}) => buildEvidence({ criteria: full, events, ...extra });

  // a passing parent whose only child was skipped proves nothing (review M1, scenario A)
  const container = verdictOf(swap('T-A3-1', [pass('T-A3-1 (a) child', { nesting: 2, skip: 'no db' }), pass('T-A3-1 parent')]));
  assert.equal(byId(container)['T-A3-1'].result, 'NOT_EVALUATED');
  assert.equal(container.verdict, 'FAIL');
  // a passing parent with no ID-bearing child proves nothing either
  const shell = verdictOf(swap('T-A3-1', [pass('setup', { nesting: 2 }), pass('T-A3-1 parent')]));
  assert.equal(byId(shell)['T-A3-1'].result, 'NOT_EVALUATED');
  // one skipped test next to a passing one (scenario C)
  const skipped = verdictOf([...all, pass('T-A7-1 another case', { skip: true })]);
  assert.equal(byId(skipped)['T-A7-1'].result, 'NOT_EVALUATED');
  assert.equal(byId(skipped)['T-A7-1'].reason, 'a test naming it was skipped');
  assert.deepEqual(skipped.skipped_tests, [{ file: 'tests/x.test.mjs', name: 'T-A7-1 another case', result: 'skip' }]);
  // a skipped test that names no ID still fails the run
  assert.equal(verdictOf([...all, pass('helper', { todo: true })]).verdict, 'FAIL');
  // listed parts: (b) alone does not cover (a)(b); (a) + (b) does; the whole name does
  const partB = verdictOf(swap('T-A10-1', [pass('T-A10-1(b) half')]));
  assert.equal(byId(partB)['T-A10-1'].result, 'NOT_EVALUATED');
  assert.equal(byId(partB)['T-A10-1'].reason, 'parts (a) are not named by any test');
  assert.equal(byId(verdictOf(swap('T-A10-1', [pass('T-A10-1(a) one'), pass('T-A10-1 (b) two')])))['T-A10-1'].result, 'PASS');
  // a failing parent fails the ID it names even when its children pass
  const parentFail = verdictOf(swap('T-A9-1', [pass('T-A9-1 child', { nesting: 2 }), event('test:fail', 'T-A9-1 parent')]));
  assert.equal(byId(parentFail)['T-A9-1'].result, 'FAIL');
  // an ID §13 does not list fails the run (review m3)
  const typo = verdictOf([...all, pass('T-A10-41 typo')]);
  assert.deepEqual(new Set(Object.values(typo.gates)), new Set(['PASS']));
  assert.equal(typo.verdict, 'FAIL');
  // a retired ID that a test still names is drift (n9)
  const retired = parseContract('### 13.1 G-A3 — a\n| T-A3-1 | x |\n| T-A3-9 | 删除本测试 | y |\n');
  const drift = buildEvidence({ criteria: retired, events: [pass('T-A3-1 ok'), pass('T-A3-9 still here')] });
  assert.match(drift.anomalies[0], /T-A3-9 is retired by the contract but still named/);
  // a runner that exited non-zero, or reporter output that could not be read, is never PASS
  assert.equal(verdictOf(all, { exitStatus: 1 }).verdict, 'FAIL');
  const unparsed = verdictOf(all, { unparsedEvents: 1 });
  assert.equal(unparsed.verdict, 'FAIL');
  assert.match(unparsed.anomalies[0], /could not be parsed/);
});

test('end to end over the Worker suite: the evidence document and its commit checks', { timeout: 300_000 }, async () => {
  const head = spawnSync('git', ['-c', `safe.directory=${REPO_ROOT}`, 'rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .stdout.trim();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-gate-evidence-test-'));
  const run = async (prHead, name) => {
    const out = path.join(directory, name);
    const previous = process.env.CLUED_EVIDENCE_PR_HEAD_SHA;
    process.env.CLUED_EVIDENCE_PR_HEAD_SHA = prHead;
    try {
      return { status: await main(['--files', 'tests/integration-runtime-worker.test.mjs', '--out', out]),
        evidence: JSON.parse(await fs.readFile(out, 'utf8')) };
    } finally {
      if (previous === undefined) delete process.env.CLUED_EVIDENCE_PR_HEAD_SHA;
      else process.env.CLUED_EVIDENCE_PR_HEAD_SHA = previous;
    }
  };
  const { status, evidence } = await run(head, 'evidence.json');
  assert.equal(status, 1, 'the G-A gates are not evaluated by the Worker suite alone');
  assert.equal(evidence.schema, SCHEMA);
  assert.match(evidence.statement, /not READY, Qualification or GA/);
  assert.equal(evidence.contract.path, CONTRACT);
  assert.match(evidence.contract.sha256, /^[0-9a-f]{64}$/);
  assert.equal(evidence.commit.head, head);
  assert.equal(evidence.commit.pr_head, head);
  assert.equal(typeof evidence.commit.dirty, 'boolean');
  assert.equal(evidence.anomalies.some((a) => /PR_HEAD/.test(a)), false);
  assert.deepEqual(evidence.run.files.map((f) => f.path), ['tests/integration-runtime-worker.test.mjs']);
  assert.equal(evidence.summary.test_process_exit, 0);
  assert.equal(evidence.summary.failed_tests, 0);
  assert.equal(evidence.summary.skipped_tests, 0);
  assert.ok(evidence.summary.leaf_tests >= 8);
  assert.deepEqual(evidence.supplementary.filter((c) => c.id.startsWith('T-W-')).map((c) => [c.id, c.result]),
    ['T-W-1', 'T-W-2', 'T-W-3', 'T-W-4', 'T-W-5', 'T-W-6'].map((id) => [id, 'PASS']));
  assert.match(evidence.supplementary.find((c) => c.id === 'T-S-7').note, /rest of CI/);
  assert.match(evidence.decisions['G-A9'], /d11f19ea/);
  assert.deepEqual(new Set(Object.values(evidence.gates)), new Set(['NOT_EVALUATED']));
  assert.equal(evidence.verdict, 'FAIL');

  // a PR head that is not what ran is an anomaly of its own (review m4)
  const wrong = await run('b'.repeat(40), 'wrong.json');
  assert.ok(wrong.evidence.anomalies.some((a) => /CLUED_EVIDENCE_PR_HEAD_SHA is neither HEAD/.test(a)));
  await assert.rejects(main(['--out']), /--out needs a value/);
});
