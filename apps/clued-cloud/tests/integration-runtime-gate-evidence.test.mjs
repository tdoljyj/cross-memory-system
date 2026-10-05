import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  APP_ROOT, CONTRACT, DEFAULT_FILES, GATES, REPO_ROOT, SCHEMA, buildEvidence, extractIds, fileSeeds, main, parseContract,
  propertySamples,
} from '../evals/integration-runtime/gate-evidence.mjs';

// S2c Integration Runtime PR-6 (IntegrationRuntime v0.1.8 §14.1, §17 item 2): the gate evidence generator.
// The full run (every S2c suite, embedded PostgreSQL) is the CI step itself; this file checks the parts
// that decide the verdict — the §13 ID table read from the contract, the name → ID mapping, the verdict
// rules — and runs the generator end to end over the Worker suite, which needs no database.

const contract = await fs.readFile(path.join(REPO_ROOT, CONTRACT), 'utf8');
const criteria = parseContract(contract);
const event = (type, name, extra = {}) => ({ type, name, nesting: 1, file: path.join(APP_ROOT, 'tests/x.test.mjs'), ...extra });

test('§13: every test ID with its gate, read from the contract', () => {
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
  assert.throws(() => parseContract('### 13.1 G-A3 — x\n| T-A3-1 | a |\n| T-A3-1 | b |\n'), /T-A3-1 twice/);
});

test('every live §13.1–§13.6 ID is named by some S2c test (static guard, no database)', async () => {
  const sources = (await Promise.all(DEFAULT_FILES.map((f) => fs.readFile(path.join(APP_ROOT, f), 'utf8')))).join('\n');
  const missing = criteria.filter((c) => c.gate && !c.retired)
    .filter((c) => !new RegExp(`\\b${c.id}(?![0-9a-z])`).test(sources)).map((c) => c.id);
  assert.deepEqual(missing, []);
});

test('a test name proves the IDs it carries; parts and lists map to the base ID', () => {
  assert.deepEqual(extractIds('T-A10-9 / T-A7-9 a Claim Store divergence fails closed'), ['T-A10-9', 'T-A7-9']);
  assert.deepEqual(extractIds('T-A11-15(c)(e) superseded revocation scope'), ['T-A11-15']);
  assert.deepEqual(extractIds('T-A11-4b (a)(d): the Host disconnect'), ['T-A11-4b']);
  assert.deepEqual(extractIds('P1 predicate layer: exhaustive 2^22 vectors (T-A7-4, T-A7-6, T-A7-7, T-A7-8)'),
    ['T-A7-4', 'T-A7-6', 'T-A7-7', 'T-A7-8']);
  assert.deepEqual(extractIds('T-A1-10 is not T-A1-1'), ['T-A1-10', 'T-A1-1']);
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
    event('test:pass', 'T-A3-1 (P2 facts layer) Candidate empty', { file: path.join(APP_ROOT, derivation), duration_ms: 3 }),
    event('test:pass', 'T-A3-2 / T-A7-1 both'),
    event('test:fail', 'T-A7-1(b) second half', { error: 'expected 1' }),
    event('test:pass', 'T-A11-1 revoke'),
    event('test:pass', 'T-W-1 tools/list'),
    event('test:pass', 'T-A99-1 a stale id'),
    event('test:diagnostic', null, { message: 'P2 {"layers":{"single":1,"pairwise":2,"random":3}}' }),
  ];
  const evidence = buildEvidence({ criteria: mini, events, seedsByFile: { [derivation]: { node: 'mulberry32(20260924)' } } });
  const byId = Object.fromEntries([...evidence.criteria, ...evidence.supplementary].map((c) => [c.id, c]));
  assert.equal(byId['T-A3-1'].result, 'PASS');
  assert.deepEqual(byId['T-A3-1'].seed, { node: 'mulberry32(20260924)' });
  assert.deepEqual(byId['T-A3-1'].samples, { test_cases: 1, P2: { single: 1, pairwise: 2, random: 3, total: 6 } });
  assert.equal(byId['T-A3-2'].seed, null);
  assert.equal(byId['T-A7-1'].result, 'FAIL', 'one failing part fails the ID');
  assert.equal(byId['T-A7-1'].samples.test_cases, 2);
  assert.equal(byId['T-A11-26'].result, 'RETIRED');
  assert.equal(byId['T-W-1'].result, 'PASS');
  assert.deepEqual(evidence.gates, { 'G-A3': 'PASS', 'G-A7': 'FAIL', 'G-A8': 'NOT_EVALUATED', 'G-A9': 'NOT_EVALUATED',
    'G-A10': 'NOT_EVALUATED', 'G-A11': 'PASS' });
  assert.equal(evidence.verdict, 'FAIL');
  assert.deepEqual(evidence.failed_tests, [{ file: 'tests/x.test.mjs', name: 'T-A7-1(b) second half', error: 'expected 1' }]);
  assert.deepEqual(evidence.unknown_ids, ['T-A99-1']);
  assert.deepEqual(evidence.summary, { criteria: 5, pass: 3, fail: 1, not_evaluated: 0, retired: 1, tests: 6, failed_tests: 1,
    test_process_exit: 0 });

  // a skipped test proves nothing; a non-zero runner exit fails the verdict even when every gate passes
  const skipped = buildEvidence({ criteria: mini.slice(0, 1), events: [event('test:pass', 'T-A3-1 x', { skip: true })] });
  assert.equal(skipped.criteria[0].result, 'NOT_EVALUATED');
  const full = parseContract(['### 13.1 G-A3 — a', '| T-A3-1 | x |', '### 13.2 G-A7 — b', '| T-A7-1 | x |',
    '### 13.3 G-A8 — c', '| T-A8-1 | x |', '### 13.4 G-A10 — d', '| T-A10-1 | x |', '### 13.5 G-A11 — e', '| T-A11-1 | x |',
    '### 13.6 G-A9 — f', '| T-A9-1 | x |'].join('\n'));
  const all = full.map((c) => event('test:pass', `${c.id} ok`));
  const passing = buildEvidence({ criteria: full, events: all });
  assert.deepEqual(new Set(Object.values(passing.gates)), new Set(['PASS']));
  assert.equal(passing.verdict, 'PASS');
  const crashed = buildEvidence({ criteria: full, events: all, exitStatus: 1 });
  assert.deepEqual(crashed.gates, passing.gates);
  assert.equal(crashed.verdict, 'FAIL', 'a runner that exited non-zero (a file that crashed) is never PASS');
});

test('end to end over the Worker suite: the evidence document, and FAIL while gates are unevaluated', { timeout: 300_000 }, async () => {
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'clued-gate-evidence-test-')), 'evidence.json');
  const previous = process.env.CLUED_EVIDENCE_PR_HEAD_SHA;
  process.env.CLUED_EVIDENCE_PR_HEAD_SHA = 'a'.repeat(40);
  let status;
  try {
    status = await main(['--files', 'tests/integration-runtime-worker.test.mjs', '--out', out]);
  } finally {
    if (previous === undefined) delete process.env.CLUED_EVIDENCE_PR_HEAD_SHA;
    else process.env.CLUED_EVIDENCE_PR_HEAD_SHA = previous;
  }
  const evidence = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(status, 1, 'the G-A gates are not evaluated by the Worker suite alone');
  assert.equal(evidence.schema, SCHEMA);
  assert.match(evidence.statement, /not READY, Qualification or GA/);
  assert.equal(evidence.contract.path, CONTRACT);
  assert.match(evidence.contract.sha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.commit.head, /^[0-9a-f]{40}$/);
  assert.equal(evidence.commit.pr_head, 'a'.repeat(40));
  assert.deepEqual(evidence.run.files.map((f) => f.path), ['tests/integration-runtime-worker.test.mjs']);
  assert.equal(evidence.summary.test_process_exit, 0);
  assert.equal(evidence.summary.failed_tests, 0);
  assert.ok(evidence.summary.tests >= 8);
  assert.deepEqual(evidence.supplementary.filter((c) => c.id.startsWith('T-W-')).map((c) => [c.id, c.result]),
    ['T-W-1', 'T-W-2', 'T-W-3', 'T-W-4', 'T-W-5', 'T-W-6'].map((id) => [id, 'PASS']));
  assert.deepEqual(new Set(Object.values(evidence.gates)), new Set(['NOT_EVALUATED']));
  assert.equal(evidence.verdict, 'FAIL');
});
