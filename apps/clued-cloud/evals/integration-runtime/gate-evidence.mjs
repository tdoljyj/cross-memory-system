#!/usr/bin/env node
// S2c Integration Runtime PR-6 (IntegrationRuntime v0.1.8 §14.1, §17 item 2): run every S2c test file and
// write the machine gate evidence — each §13.1–§13.6 test ID mapped to its gate (G-A3 / G-A7 / G-A8 / G-A10 /
// G-A11, and the G-A9 criteria of §13.6 adopted by Owner Decision d11f19ea, OQ-20) with its result, the
// commit, the random seed and the sample counts. The §13.7 structure and §13.8 Worker IDs are reported
// alongside as supplementary evidence; they do not decide a gate.
//
//   node evals/integration-runtime/gate-evidence.mjs [--out FILE] [--files a.test.mjs,b.test.mjs]
//
// The test IDs and their gates are read from the contract itself, never restated here, so the evidence
// cannot drift from §13. A leaf test proves the IDs its node:test name carries (T-A10-9 / T-A7-9 proves both;
// T-A11-15(c)(e) proves parts (c)(e) of T-A11-15); a parent test only contains other tests. An ID is
//   PASS          when a test names it, every test that names it passed, and — if its row lists parts
//                 (a), (b), … — a test names the whole ID or the named parts cover the list;
//   FAIL          when a test that names it failed;
//   NOT_EVALUATED when no test names it, one was skipped, or a listed part is named by no test;
//   RETIRED       when its row says the test is deleted by a later PR (T-A11-26).
// A gate is PASS only when every ID it owns is PASS or RETIRED. The process exits 1 unless every gate is
// PASS, every test ran and passed, no test names an ID §13 lacks, and the commit is known and clean.
//
// The DB suites run embedded PostgreSQL, which refuses to start as root: run this as a non-root user.
// S2c gate evidence is not READY, Qualification or GA (§17).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '../..');
export const REPO_ROOT = path.resolve(APP_ROOT, '../..');
export const CONTRACT = 'development/contracts/integration-runtime/IntegrationRuntime.v0.1.8.md';
export const SCHEMA = 'clued.integration-runtime.gate-evidence.v1';
export const DEFAULT_FILES = [
  'tests/integration-runtime-derivation-db.test.mjs',
  'tests/integration-runtime-identity-db.test.mjs',
  'tests/integration-runtime-verification-db.test.mjs',
  'tests/integration-runtime-lifecycle-db.test.mjs',
  'tests/integration-runtime-worker.test.mjs',
  'tests/integration-runtime-transport.test.mjs',
];
export const GATES = ['G-A3', 'G-A7', 'G-A8', 'G-A9', 'G-A10', 'G-A11'];
// An ID in a test name, with the parts it names attached or after one space: `T-A11-15(c)(e)`,
// `T-A11-4b (a)(d)`. The lookahead keeps `T-A1-1` from matching inside `T-A1-10` or `T-A11-4bis`.
const ID = /\bT-(?:A\d+|S|W)-\d+[a-z]?(?![0-9a-z])(?: ?((?:\([a-h]\))+))?/g;
const ROW = /^\| (T-(?:A\d+|S|W)-\d+[a-z]?) \|(.*)$/;
const PART = /\(([a-h])\)/g;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Evidence this run does not produce, said so instead of left unexplained.
export const NOTES = {
  'T-S-7': 'proven by the rest of CI (migration-contract.test.mjs and every existing suite), not by this run',
};
export const DECISIONS = {
  'G-A9': 'the §13.6 criteria were adopted by Owner Decision d11f19ea-c32f-48bd-a570-460347fef110 (OQ-20)',
};

// §13 of the contract: `### 13.N <gate> — …` headings with `| T-… |` table rows. 13.1–13.6 name a gate;
// 13.7 (structure) and 13.8 (Worker / transport) are supplementary. A row that names the parts of its
// method — (a), (b), … — owes each of them. A table line in §13 that names a test ID but does not parse
// is an error, never a silently missing criterion.
export function parseContract(markdown) {
  const criteria = [];
  let section = null;
  for (const line of markdown.split('\n')) {
    const heading = /^#{2,3} (\d+(?:\.\d+)?)\.? (.*)$/.exec(line);
    if (heading) {
      const number = heading[1];
      const gate = /^(G-A\d+)\b/.exec(heading[2])?.[1] ?? null;
      section = /^13\.[1-8]$/.test(number)
        ? { number, gate, kind: gate ? 'gate' : 'supplementary', title: heading[2].trim() } : null;
      continue;
    }
    if (!section || !line.startsWith('|')) continue;
    const row = ROW.exec(line);
    if (!row) {
      if (/T-(?:A\d+|S|W)-/.test(line.split('|')[1] ?? '')) throw new Error(`§${section.number}: unparsed row ${line.slice(0, 80)}`);
      continue;
    }
    const text = row[2];
    criteria.push({ id: row[1], gate: section.gate, section: section.number, kind: section.kind,
      parts: [...new Set([...text.matchAll(PART)].map((m) => m[1]))].sort(),
      // a row that says its test is deleted by a later PR (v0.1.8 NIT-3) is not owed by the merged code
      retired: /删除本测试/.test(text.split('|')[0]) });
  }
  const ids = criteria.map((c) => c.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length) throw new Error(`contract lists ${duplicates.join(', ')} twice`);
  return criteria;
}

// The IDs a test name proves, each with the parts it names ([] = the whole ID).
export function extractRefs(name) {
  const refs = new Map();
  for (const m of String(name).matchAll(ID)) {
    const id = m[0].replace(/ ?(\([a-h]\))+$/, '');
    const parts = m[1] ? [...m[1].matchAll(PART)].map((x) => x[1]) : [];
    const known = refs.get(id);
    // naming the whole ID anywhere in the name wins over a part
    refs.set(id, known && (!known.length || !parts.length) ? [] : [...new Set([...(known ?? []), ...parts])].sort());
  }
  return [...refs].map(([id, parts]) => ({ id, parts }));
}
export const extractIds = (name) => extractRefs(name).map((r) => r.id);

// Sample counts the property layer reports as diagnostics (integration-runtime-derivation-db.test.mjs).
export function propertySamples(diagnostics) {
  const out = {};
  for (const message of diagnostics) {
    const p = /^(P1|P2) (\{.*\})$/.exec(message);
    if (!p) continue;
    const value = JSON.parse(p[2]);
    out[p[1]] = p[1] === 'P1'
      ? { enumerated: value.enumerated, consistent: value.consistent }
      : { ...value.layers, total: Object.values(value.layers ?? {}).reduce((a, b) => a + b, 0) };
  }
  return out;
}

// The seeds a test file declares: mulberry32(SEED) in Node, setseed(x) in SQL (§13.0).
export function fileSeeds(source) {
  const seeds = {};
  const node = /const SEED = (\d+);/.exec(source);
  if (node && /mulberry32\(/.test(source)) seeds.node = `mulberry32(${node[1]})`;
  const sql = /setseed\(([0-9.]+)\)/.exec(source);
  if (sql) seeds.sql = `setseed(${sql[1]})`;
  return seeds;
}

// The property-layer tests (P1, P2) are the only ones that draw random samples; every other test is a
// deterministic fixture.
const PROPERTY_LAYER = (name) => /^P1 /.test(name) ? 'P1' : /\(P2 facts layer\)|^P2 coverage/.test(name) ? 'P2' : null;

// Evidence paths are repository paths on every host, including Windows.
const relativeFile = (file) => path.relative(APP_ROOT, file).split(path.sep).join('/');

// events: the ndjson-reporter stream. Returns the evidence object (without run metadata).
export function buildEvidence({ criteria, events, seedsByFile = {}, exitStatus = 0, unparsedEvents = 0 }) {
  // A test that completes right after a test one level deeper in the same file is that test's parent: a
  // container, not evidence of its own. Only leaves prove an ID; a failing parent still fails it.
  const last = new Map();
  const results = events.filter((e) => e.type === 'test:pass' || e.type === 'test:fail').map((e) => {
    const file = e.file ? relativeFile(e.file) : null;
    const previous = last.get(file);
    last.set(file, e);
    return {
      file, name: e.name, nesting: e.nesting, parent: previous?.nesting === e.nesting + 1,
      result: e.type === 'test:fail' ? 'fail' : e.skip ? 'skip' : e.todo ? 'todo' : 'pass',
      duration_ms: e.duration_ms ?? null, ...(e.error ? { error: e.error } : {}),
      refs: extractRefs(e.name),
    };
  });
  const samples = propertySamples(events.filter((e) => e.type === 'test:diagnostic').map((e) => e.message));
  const known = new Set(criteria.map((c) => c.id));
  const anomalies = [];
  const evaluate = (c) => {
    const tests = results.filter((t) => (!t.parent || t.result === 'fail') && t.refs.some((r) => r.id === c.id));
    const passed = tests.filter((t) => t.result === 'pass');
    const whole = passed.some((t) => t.refs.find((r) => r.id === c.id).parts.length === 0);
    const named = [...new Set(passed.flatMap((t) => t.refs.find((r) => r.id === c.id).parts))].sort();
    const missing = whole ? [] : c.parts.filter((x) => !named.includes(x));
    let result;
    let reason = null;
    if (c.retired) {
      result = 'RETIRED';
      if (tests.length) anomalies.push(`${c.id} is retired by the contract but still named by ${tests.length} test(s)`);
    } else if (tests.some((t) => t.result === 'fail')) result = 'FAIL';
    else if (tests.some((t) => t.result === 'skip' || t.result === 'todo')) [result, reason] = ['NOT_EVALUATED', 'a test naming it was skipped'];
    else if (!passed.length) [result, reason] = ['NOT_EVALUATED', 'no test names it'];
    else if (passed.length && missing.length && named.length) {
      [result, reason] = ['NOT_EVALUATED', `parts ${missing.map((x) => `(${x})`).join('')} are not named by any test`];
    } else result = 'PASS';
    const seeds = Object.assign({}, ...tests.filter((t) => PROPERTY_LAYER(t.name)).map((t) => seedsByFile[t.file] ?? {}));
    const layers = [...new Set(tests.map((t) => PROPERTY_LAYER(t.name)).filter(Boolean))];
    return {
      id: c.id, gate: c.gate, section: c.section, result,
      ...(reason ? { reason } : {}), ...(NOTES[c.id] ? { note: NOTES[c.id] } : {}),
      ...(c.parts.length ? { parts: { required: c.parts, named: whole ? 'whole' : named } } : {}),
      seed: Object.keys(seeds).length ? seeds : 'deterministic',
      samples: { test_cases: tests.length, ...Object.fromEntries(layers.map((l) => [l, samples[l] ?? null])) },
      tests: tests.map(({ file, name, result: r, duration_ms }) => ({ file, name, result: r, duration_ms })),
    };
  };
  const evaluated = criteria.map(evaluate);
  const gates = Object.fromEntries(GATES.map((gate) => {
    const own = evaluated.filter((c) => c.gate === gate);
    const verdict = !own.length ? 'NOT_EVALUATED' : own.some((c) => c.result === 'FAIL') ? 'FAIL'
      : own.every((c) => c.result === 'PASS' || c.result === 'RETIRED') ? 'PASS' : 'NOT_EVALUATED';
    return [gate, verdict];
  }));
  const failures = results.filter((t) => t.result === 'fail');
  const skipped = results.filter((t) => t.result === 'skip' || t.result === 'todo');
  // a test naming an ID that §13 does not list is a typo or a stale ID: it proves nothing, so it fails
  const unknownIds = [...new Set(results.flatMap((t) => t.refs.map((r) => r.id)))].filter((id) => !known.has(id)).sort();
  if (unparsedEvents) anomalies.push(`${unparsedEvents} reporter event line(s) could not be parsed`);
  const count = (list, r) => list.filter((c) => c.result === r).length;
  const required = evaluated.filter((c) => c.gate);
  const ok = exitStatus === 0 && failures.length === 0 && skipped.length === 0 && unknownIds.length === 0
    && anomalies.length === 0 && GATES.every((g) => gates[g] === 'PASS');
  return {
    gates,
    verdict: ok ? 'PASS' : 'FAIL',
    summary: {
      criteria: required.length, pass: count(required, 'PASS'), fail: count(required, 'FAIL'),
      not_evaluated: count(required, 'NOT_EVALUATED'), retired: count(required, 'RETIRED'),
      tests: results.length, leaf_tests: results.filter((t) => !t.parent).length, failed_tests: failures.length,
      skipped_tests: skipped.length, test_process_exit: exitStatus,
    },
    decisions: DECISIONS,
    property_samples: samples,
    criteria: required,
    supplementary: evaluated.filter((c) => !c.gate),
    failed_tests: failures.map(({ file, name, error }) => ({ file, name, error: error ?? null })),
    skipped_tests: skipped.map(({ file, name, result }) => ({ file, name, result })),
    unknown_ids: unknownIds,
    anomalies,
  };
}

// Read-only git calls. safe.directory names only this checkout, so a run as another user (the DB suites
// refuse root) can still read the commit instead of silently recording none.
function git(args) {
  const r = spawnSync('git', ['-c', `safe.directory=${REPO_ROOT}`, '--no-optional-locks', ...args],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The parent SHAs a commit object names. They are read from the object itself, not resolved as `HEAD^2`:
// CI checks out the pull_request merge commit at depth 1, where the parents are named but not fetched.
export function commitParents(catFile) {
  return String(catFile ?? '').split('\n').map((line) => /^parent ([0-9a-f]{40})$/.exec(line)?.[1]).filter(Boolean);
}

// Run as a top-level test runner even when this script is itself started under node:test, which marks
// its children with NODE_TEST_CONTEXT and would make them stream to the parent instead of the reporters.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function parseArgs(argv) {
  const args = { out: null, files: DEFAULT_FILES };
  for (let i = 0; i < argv.length; i += 1) {
    const value = () => {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`);
      return argv[++i];
    };
    if (argv[i] === '--out') args.out = value();
    else if (argv[i] === '--files') args.files = value().split(',').filter(Boolean);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const contractText = fs.readFileSync(path.join(REPO_ROOT, CONTRACT), 'utf8');
  const criteria = parseContract(contractText);
  const files = args.files.map((f) => path.resolve(APP_ROOT, f));
  const seedsByFile = Object.fromEntries(files.map((f) => [relativeFile(f), fileSeeds(fs.readFileSync(f, 'utf8'))]));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-gate-evidence-'));
  const stream = path.join(scratch, 'events.ndjson');
  const startedAt = new Date().toISOString();
  // the same CLI the per-suite npm scripts use, one file at a time; the spec report goes to stderr
  const run = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-concurrency=1',
    '--test-reporter=spec', '--test-reporter-destination=stderr',
    `--test-reporter=${pathToFileURL(path.join(here, 'ndjson-reporter.mjs')).href}`, `--test-reporter-destination=${stream}`,
    ...files], { cwd: APP_ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: childEnv() });
  // a truncated line (a killed runner) is counted, and fails the verdict, rather than losing the document
  const events = [];
  let unparsedEvents = 0;
  for (const line of fs.existsSync(stream) ? fs.readFileSync(stream, 'utf8').split('\n').filter(Boolean) : []) {
    try { events.push(JSON.parse(line)); } catch { unparsedEvents += 1; }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  const evidence = buildEvidence({ criteria, events, seedsByFile, exitStatus: run.status ?? 1, unparsedEvents });
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain', '--', 'apps/clued-cloud', 'development/contracts/integration-runtime']);
  // On a pull_request run HEAD is GitHub's merge commit, whose second parent is the PR head.
  const prHead = process.env.CLUED_EVIDENCE_PR_HEAD_SHA || null;
  const prHeadMatches = !prHead || prHead === head || commitParents(git(['cat-file', '-p', 'HEAD']))[1] === prHead;
  // The commit is the evidence's subject: unknown, a dirty tree, or a PR head that is not what ran makes
  // the whole document FAIL, whatever the tests said (§17 item 2).
  const commitProblems = [!head && 'HEAD unknown', status === null && 'tree state unknown',
    status && 'the tree has uncommitted changes', !prHeadMatches && 'CLUED_EVIDENCE_PR_HEAD_SHA is neither HEAD nor its second parent']
    .filter(Boolean);
  if (commitProblems.length) {
    evidence.verdict = 'FAIL';
    evidence.anomalies.push(...commitProblems);
  }
  const document = {
    schema: SCHEMA,
    statement: 'S2c gate evidence (IntegrationRuntime v0.1.8 §17). One run at one commit: commit applies to every'
      + ' criterion. It is not READY, Qualification or GA.',
    contract: { path: CONTRACT, sha256: sha256(contractText) },
    commit: {
      head,
      // on a pull_request run HEAD is GitHub's merge commit; the workflow passes the PR head here
      pr_head: prHead,
      dirty: status === null ? null : status !== '',
    },
    run: {
      started_at: startedAt, finished_at: new Date().toISOString(), node: process.version,
      property_mode: process.env.CLUED_INTEGRATION_RUNTIME_PROPERTY_FULL === '1' ? 'nightly' : 'ci',
      files: files.map((f) => ({ path: relativeFile(f), sha256: sha256(fs.readFileSync(f)) })),
    },
    ...evidence,
  };
  const json = `${JSON.stringify(document, null, 2)}\n`;
  if (args.out) fs.writeFileSync(args.out, json);
  else process.stdout.write(json);
  const lines = [`gate evidence: ${evidence.verdict}`, ...GATES.map((g) => `  ${g}: ${evidence.gates[g]}`),
    `  criteria ${evidence.summary.pass} PASS / ${evidence.summary.fail} FAIL / ${evidence.summary.not_evaluated} NOT_EVALUATED`
      + ` / ${evidence.summary.retired} RETIRED; ${evidence.summary.failed_tests} failed tests`];
  for (const c of evidence.criteria.filter((x) => x.result === 'FAIL' || x.result === 'NOT_EVALUATED')) {
    lines.push(`  ${c.result}: ${c.id} (${c.gate})${c.reason ? ` — ${c.reason}` : ''}`);
  }
  for (const a of evidence.anomalies) lines.push(`  anomaly: ${a}`);
  if (evidence.unknown_ids.length) lines.push(`  unknown IDs: ${evidence.unknown_ids.join(', ')}`);
  process.stderr.write(`${lines.join('\n')}\n`);
  return evidence.verdict === 'PASS' ? 0 : 1;
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  process.exitCode = await main();
}
