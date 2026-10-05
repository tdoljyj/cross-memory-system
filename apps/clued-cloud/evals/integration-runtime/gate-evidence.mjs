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
// cannot drift from §13. A test proves an ID when its node:test name carries the ID (T-A10-9 / T-A7-9 proves
// both; T-A11-15(c)(e) proves part of T-A11-15). An ID is PASS when at least one test proves it and every
// test that names it passed; FAIL when any of them failed; NOT_EVALUATED when none ran; RETIRED when its
// contract row says the test is deleted by a later PR (T-A11-26). A gate is PASS only when every ID it
// owns is PASS or RETIRED. The process exits 1 unless every gate is PASS and every test passed.
//
// The DB suites run embedded PostgreSQL, which refuses to start as root: run this as a non-root user.
// S2c gate evidence is not READY, Qualification or GA (§17).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const ID = /\bT-(?:A\d+|S|W)-\d+[a-z]?(?:\([a-z]\))*/g;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// §13 of the contract: `### 13.N <gate> — …` headings with `| T-… |` table rows. 13.1–13.6 name a gate;
// 13.7 (structure) and 13.8 (Worker / transport) are supplementary.
export function parseContract(markdown) {
  const criteria = [];
  let section = null;
  for (const line of markdown.split('\n')) {
    const heading = /^#{2,3} (\d+(?:\.\d+)?) (.*)$/.exec(line);
    if (heading) {
      const number = heading[1];
      const gate = /^(G-A\d+)\b/.exec(heading[2])?.[1] ?? null;
      section = /^13\.[1-8]$/.test(number)
        ? { number, gate, kind: gate ? 'gate' : 'supplementary', title: heading[2].trim() } : null;
      continue;
    }
    if (!section) continue;
    const row = /^\| (T-(?:A\d+|S|W)-\d+[a-z]?) \|(.*)$/.exec(line);
    if (!row) continue;
    const text = row[2];
    criteria.push({ id: row[1], gate: section.gate, section: section.number, kind: section.kind,
      // a row that says its test is deleted by a later PR (v0.1.8 NIT-3) is not owed by the merged code
      retired: /删除本测试/.test(text.split('|')[0]) });
  }
  const ids = criteria.map((c) => c.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length) throw new Error(`contract lists ${duplicates.join(', ')} twice`);
  return criteria;
}

// The IDs a test name proves: `T-A11-15(c)(e)` → T-A11-15 (part (c)(e)).
export function extractIds(name) {
  return [...new Set([...String(name).matchAll(ID)].map((m) => m[0].replace(/(\([a-z]\))+$/, '')))];
}

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

const PROPERTY_LAYER = (name) => /^P1 /.test(name) ? 'P1' : /\(P2 facts layer\)|^P2 coverage/.test(name) ? 'P2' : null;

// events: the ndjson-reporter stream. Returns the evidence object (without run metadata).
export function buildEvidence({ criteria, events, seedsByFile = {}, exitStatus = 0 }) {
  const results = events.filter((e) => e.type === 'test:pass' || e.type === 'test:fail').map((e) => ({
    file: e.file ? path.relative(APP_ROOT, e.file) : null, name: e.name, nesting: e.nesting,
    result: e.type === 'test:fail' ? 'fail' : e.skip ? 'skip' : e.todo ? 'todo' : 'pass',
    duration_ms: e.duration_ms ?? null, ...(e.error ? { error: e.error } : {}),
    ids: extractIds(e.name),
  }));
  const samples = propertySamples(events.filter((e) => e.type === 'test:diagnostic').map((e) => e.message));
  const known = new Set(criteria.map((c) => c.id));
  const evaluate = (c) => {
    const tests = results.filter((t) => t.ids.includes(c.id));
    const failed = tests.some((t) => t.result === 'fail');
    const passed = tests.filter((t) => t.result === 'pass');
    const result = c.retired ? 'RETIRED' : failed ? 'FAIL' : passed.length ? 'PASS' : 'NOT_EVALUATED';
    const seeds = Object.assign({}, ...[...new Set(tests.map((t) => t.file))].map((f) => seedsByFile[f] ?? {}));
    const layers = [...new Set(tests.map((t) => PROPERTY_LAYER(t.name)).filter(Boolean))];
    return {
      id: c.id, gate: c.gate, section: c.section, result,
      seed: Object.keys(seeds).length ? seeds : null,
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
  const unknownIds = [...new Set(results.flatMap((t) => t.ids))].filter((id) => !known.has(id)).sort();
  const count = (list, r) => list.filter((c) => c.result === r).length;
  const required = evaluated.filter((c) => c.gate);
  const ok = exitStatus === 0 && failures.length === 0 && GATES.every((g) => gates[g] === 'PASS');
  return {
    gates,
    verdict: ok ? 'PASS' : 'FAIL',
    summary: {
      criteria: required.length, pass: count(required, 'PASS'), fail: count(required, 'FAIL'),
      not_evaluated: count(required, 'NOT_EVALUATED'), retired: count(required, 'RETIRED'),
      tests: results.length, failed_tests: failures.length, test_process_exit: exitStatus,
    },
    property_samples: samples,
    criteria: required,
    supplementary: evaluated.filter((c) => !c.gate),
    failed_tests: failures.map(({ file, name, error }) => ({ file, name, error: error ?? null })),
    // a test naming an ID that §13 does not list is a typo or a stale ID, reported rather than dropped
    unknown_ids: unknownIds,
  };
}

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
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
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--files') args.files = argv[++i].split(',').filter(Boolean);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const contractText = fs.readFileSync(path.join(REPO_ROOT, CONTRACT), 'utf8');
  const criteria = parseContract(contractText);
  const files = args.files.map((f) => path.resolve(APP_ROOT, f));
  const seedsByFile = Object.fromEntries(files.map((f) => [path.relative(APP_ROOT, f), fileSeeds(fs.readFileSync(f, 'utf8'))]));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-gate-evidence-'));
  const stream = path.join(scratch, 'events.ndjson');
  const startedAt = new Date().toISOString();
  // the same CLI the per-suite npm scripts use, one file at a time; the spec report goes to stderr
  const run = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-concurrency=1',
    '--test-reporter=spec', '--test-reporter-destination=stderr',
    `--test-reporter=${path.join(here, 'ndjson-reporter.mjs')}`, `--test-reporter-destination=${stream}`,
    ...files], { cwd: APP_ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: childEnv() });
  const events = fs.existsSync(stream)
    ? fs.readFileSync(stream, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  fs.rmSync(scratch, { recursive: true, force: true });
  const evidence = buildEvidence({ criteria, events, seedsByFile, exitStatus: run.status ?? 1 });
  const document = {
    schema: SCHEMA,
    statement: 'S2c gate evidence (IntegrationRuntime v0.1.8 §17). It is not READY, Qualification or GA.',
    contract: { path: CONTRACT, sha256: sha256(contractText) },
    commit: {
      head: git(['rev-parse', 'HEAD']),
      // on a pull_request run HEAD is GitHub's merge commit; the workflow passes the PR head here
      pr_head: process.env.CLUED_EVIDENCE_PR_HEAD_SHA || null,
      dirty: (git(['status', '--porcelain', '--', 'apps/clued-cloud', 'development/contracts/integration-runtime']) ?? '') !== '',
    },
    run: {
      started_at: startedAt, finished_at: new Date().toISOString(), node: process.version,
      property_mode: process.env.CLUED_INTEGRATION_RUNTIME_PROPERTY_FULL === '1' ? 'nightly' : 'ci',
      files: files.map((f) => ({ path: path.relative(APP_ROOT, f), sha256: sha256(fs.readFileSync(f)) })),
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
    lines.push(`  ${c.result}: ${c.id} (${c.gate})`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
  return evidence.verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
