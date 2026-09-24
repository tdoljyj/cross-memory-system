#!/usr/bin/env node
// M0D-B07 regression runner (contract M0DCloseout.v0.1 section 8; S6 plan
// section 5). Runs the gate suites on Node 24.19.0 against the local stack
// and records, per suite: command, exit code, duration, TAP/pgTAP totals, the
// sha256 of the combined output and the first failing test with its
// normalized error line. A failing suite is compared with the same suite at
// the baseline commits (git archive; no worktree, no ref or HEAD change):
// only an identical normalized failure signature counts as pre-existing.
//
// Excluded by design: mcp:eval:* (promptfoo can call model providers) and
// test:p6. Embedded-PostgreSQL suites run as the unprivileged user given by
// --pg-user (embedded-postgres refuses root).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cloudRoot = path.join(repoRoot, 'apps/clued-cloud');
const { values: args } = parseArgs({ options: {
  out: { type: 'string' }, 'pg-user': { type: 'string' }, 'supabase-bin': { type: 'string' },
  'mcp-url': { type: 'string' }, 'e2e-evidence': { type: 'string' }, only: { type: 'string' },
  'baseline-refs': { type: 'string', default: 'dea0a61b,2aa51246' } } });
if (!args.out) throw new Error('--out <regression.json> is required');
if (process.version !== 'v24.19.0') throw new Error(`Node 24.19.0 required, got ${process.version}`);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const nodeBin = path.dirname(process.execPath);
const supabaseBin = args['supabase-bin'] ?? null;
const cli = supabaseBin ? [supabaseBin] : ['npx', '--yes', 'supabase@2.115.0'];

// Suites in plan order. `as` = 'pg' runs as the embedded-PostgreSQL user.
const SUITES = [
  { name: 'test:context:v2', as: 'pg' },
  { name: 'test:projection:refresh', as: 'pg' },
  { name: 'test:mtpe:intake', as: 'pg' },
  { name: 'db:test:m1', cli: ['test', 'db', 'supabase/tests/m1_runtime_contracts.test.sql',
    'supabase/tests/m1_legacy_mapping.test.sql', '--local'] },
  { name: 'db:test:v2', cli: ['test', 'db', 'supabase/tests/unified_record_v2.test.sql', '--local'], baseline: true },
  { name: 'test:p5:postgres', as: 'pg' },
  { name: 'test:project:lifecycle:v2', as: 'pg', needsBuild: true },
  { name: 'test:authorization:transport', as: 'pg' },
  { name: 'test:authorization:database', as: 'pg' },
  { name: 'test:authorization:migrations', as: 'pg' },
  { name: 'test:authorization:integration', as: 'pg' },
  { name: 'test:authorization:pages', as: 'pg' },
  { name: 'test:authorization:invitations', as: 'pg' },
  { name: 'mcp:tools:verify', env: { MCP_ISOLATED_URL: args['mcp-url'] ?? 'http://127.0.0.1:8787/mcp' } },
  { name: 'mcp:flags:verify' },
  { name: 'test:information-flow:candidates', as: 'pg' },
  { name: 'test:information-flow:intake', as: 'pg' },
  { name: 'test:information-flow:promotion', as: 'pg' },
  { name: 'test:information-flow:context', as: 'pg' },
  { name: 'test:information-flow:invalidation', as: 'pg' },
  { name: 'db:lint', cli: ['db', 'lint', '--local', '--schema', 'public,clued_private', '--level', 'error',
    '--fail-on', 'error'] },
  { name: 'test:production:release-gate', as: 'pg' },
  { name: 'typecheck' },
  { name: 'lint' },
  { name: 'parent-adapter (root)', root: ['node', '--test', '--test-reporter=tap',
    'tests/information-flow-parent-adapter.test.mjs'] },
];
const EXCLUDED = [
  { name: 'mcp:eval:*', reason: 'promptfoo evaluations can call model providers (B08: zero model/provider calls)' },
  { name: 'test:p6', reason: 'P6 shadow canary is outside the M0D-B07 list and exercises production release control' },
];

function tapTotals(text) {
  const pick = (key) => {
    const hits = [...text.matchAll(new RegExp(`^(?:# |ℹ )${key} (\\d+)`, 'gm'))].map((m) => Number(m[1]));
    return hits.length ? hits.reduce((a, b) => a + b, 0) : null;
  };
  const ok = (text.match(/^\s*ok \d+/gm) ?? []).length;
  const notOk = (text.match(/^\s*not ok \d+/gm) ?? []).length;
  const prove = /Files=(\d+), Tests=(\d+)/.exec(text);
  const planned = [...text.matchAll(/^1\.\.(\d+)$/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail'), cancelled: pick('cancelled'),
    skipped: pick('skipped'), tap_ok_lines: ok, tap_not_ok_lines: notOk,
    pgtap: prove ? { files: Number(prove[1]), tests: Number(prove[2]) } : planned ? { planned } : null };
}

function normalizeLine(line) {
  return String(line ?? '').trim()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{40,64}\b/g, '<hex>')
    .replace(/\/tmp\/[^\s'"]+/g, '<tmp>')
    .replace(/\d+(\.\d+)?ms/g, '<ms>');
}

function failureSignature(text) {
  const failing = [...text.matchAll(/^\s*not ok \d+ - (.+)$/gm), ...text.matchAll(/^# Failed test \d+: "(.+)"$/gm)]
    .map((m) => normalizeLine(m[1]));
  // pgTAP: "#     died: 42501: permission denied ..." / "caught: ..."
  const pgError = /^#\s+(?:died|caught):\s+([0-9A-Z]{5}):\s+(.+)$/m.exec(text);
  const errorLine = pgError ? `${pgError[1]}: ${pgError[2]}` : text.split('\n').find((line) =>
    /ERROR:|error:|Error:|permission denied|AssertionError|failed/i.test(line) && !/^\s*#\s*(fail|pass)/.test(line));
  const sqlstate = pgError?.[1] ?? /SQLSTATE[: ]+([0-9A-Z]{5})/.exec(text)?.[1] ?? null;
  return { failing_tests: [...new Set(failing)].slice(0, 40), failing_test_count: new Set(failing).size,
    first_error_line: normalizeLine(errorLine), sqlstate };
}

function run(suite, cwd = cloudRoot) {
  let command;
  let argv;
  const env = { ...process.env, ...(suite.env ?? {}), PATH: `${nodeBin}:${process.env.PATH}` };
  if (suite.cli) { [command, ...argv] = [...cli, ...suite.cli]; }
  else if (suite.root) { [command, ...argv] = suite.root; cwd = repoRoot; }
  else if (suite.as === 'pg' && args['pg-user']) {
    command = 'su';
    const inner = `cd ${cwd} && export PATH=${nodeBin}:$PATH HOME=/tmp/${args['pg-user']}-home TMPDIR=/tmp `
      + `npm_config_cache=/tmp/${args['pg-user']}-home/.npm npm_config_prefer_offline=true npm_config_update_notifier=false `
      // The root-only proxy CA bundle is unreadable for the unprivileged user.
      + '&& unset NODE_EXTRA_CA_CERTS && mkdir -p $HOME && '
      + `npm run -s ${suite.name}`;
    argv = [args['pg-user'], '-s', '/bin/bash', '-c', inner];
  } else {
    command = 'npm';
    argv = ['run', '-s', suite.name];
  }
  const started = Date.now();
  const result = spawnSync(command, argv, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 3600000 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { exit_code: result.status, signal: result.signal ?? null, duration_ms: Date.now() - started, output };
}

function record(suite, outcome) {
  return {
    suite: suite.name,
    command: suite.cli ? `supabase ${suite.cli.join(' ')}` : suite.root ? suite.root.join(' ')
      : `npm run ${suite.name}${suite.as === 'pg' ? ` (as ${args['pg-user'] ?? 'current user'})` : ''}`,
    exit_code: outcome.exit_code, signal: outcome.signal, duration_ms: outcome.duration_ms,
    totals: tapTotals(outcome.output), output_sha256: sha(outcome.output),
    result: outcome.exit_code === 0 ? 'PASS' : 'FAIL',
    ...(outcome.exit_code === 0 ? {} : { failure: failureSignature(outcome.output) }),
  };
}

// Baseline proof: the same suite at a baseline commit, from `git archive`.
function baselineProof(suite, ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `m0d-baseline-${ref}-`));
  try {
    const commit = execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: repoRoot, encoding: 'utf8' }).trim();
    execFileSync('bash', ['-c', `git -C ${repoRoot} archive ${commit} apps/clued-cloud/supabase | tar -x -C ${dir}`]);
    const workdir = path.join(dir, 'apps/clued-cloud');
    // The shared local stack is reset to the baseline migration chain, the
    // suite runs, and the caller resets back to HEAD afterwards.
    const reset = spawnSync(cli[0], [...cli.slice(1), 'db', 'reset', '--local', '--no-seed', '--workdir', workdir],
      { encoding: 'utf8', env: process.env, timeout: 1800000 });
    if (reset.status !== 0) return { ref, commit, error: `db reset failed: ${normalizeLine(reset.stderr.split('\n').at(-2))}` };
    const outcome = run(suite, workdir);
    return { ref, commit, ...record(suite, outcome) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// mcp:tools:verify needs a live /mcp: the harness Worker host (workerd) serves
// tools/list without any storage call.
async function withHarnessWorker(fn) {
  const { pathToFileURL } = await import('node:url');
  const { WorkerHost } = await import(pathToFileURL(path.join(cloudRoot, 'evals/information-flow-e2e/harness.mjs')).href);
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm0d-reg-bundle-'));
  const dry = spawnSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', bundleDir, '--config',
    'evals/information-flow-e2e/wrangler.jsonc'], { cwd: cloudRoot, encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', PATH: `${nodeBin}:${process.env.PATH}` } });
  if (dry.status !== 0) throw new Error(`wrangler dry-run failed: ${dry.stderr}`);
  const host = new WorkerHost({ bundleDir, persistDir: fs.mkdtempSync(path.join(os.tmpdir(), 'm0d-reg-persist-')),
    gatewayOrigin: 'http://127.0.0.1:9', publishableKey: 'local-tools-list-only',
    guardLedger: path.join(bundleDir, 'guard.json'), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  await host.start();
  try { return await fn(`${host.url}/mcp`); } finally {
    await host.stop();
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

// The Owner acceptance comes from the A03 register (owner_decisions), not
// from this script.
function ownerAcceptance() {
  const register = JSON.parse(fs.readFileSync(path.join(repoRoot,
    'development/contracts/information-flow/known-limitations.m0d.v0.1.json'), 'utf8'));
  const decision = (register.owner_decisions ?? []).find((d) => d.items?.['7']);
  return decision ? { source: 'known-limitations.m0d.v0.1.json owner_decisions', decision_id: decision.decision_id,
    receipt_id: decision.receipt_id, item: 7, text: decision.items['7'] } : null;
}

// Each baseline ref must be an ancestor of origin/main (the proof is on main).
function baselineAncestry() {
  const main = spawnSync('git', ['rev-parse', 'origin/main'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim() || null;
  return { origin_main: main, refs: args['baseline-refs'].split(',').map((ref) => {
    const commit = spawnSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
    const check = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { cwd: repoRoot });
    return { ref, commit, is_ancestor_of_origin_main: check.status === 0 };
  }) };
}

const only = args.only ? new Set(args.only.split(',')) : null;
const results = [];
for (const suite of SUITES) {
  if (only && !only.has(suite.name)) continue;
  if (suite.needsBuild && !fs.existsSync(path.join(cloudRoot, 'dist'))) {
    results.push({ suite: suite.name, result: 'FAIL', note: 'npm run build output (dist/) is missing' });
    continue;
  }
  process.stderr.write(`[m0d-regression] ${suite.name}\n`);
  const entry = suite.name === 'mcp:tools:verify' && !args['mcp-url']
    ? await withHarnessWorker((url) => record(suite, run({ ...suite, env: { MCP_ISOLATED_URL: url } })))
    : record(suite, run(suite));
  if (suite.name === 'mcp:tools:verify') entry.note = 'served by the S6 harness Worker host (workerd); tools/list is static';
  if (entry.result === 'FAIL' && suite.baseline) {
    entry.baseline_proof = args['baseline-refs'].split(',').map((ref) => baselineProof(suite, ref));
    entry.identical_failure_on_baselines = entry.baseline_proof.every((proof) => proof.failure
      && JSON.stringify(proof.failure) === JSON.stringify(entry.failure));
  }
  results.push(entry);
}
if (results.some((entry) => entry.baseline_proof)) {
  // Restore the HEAD migration chain on the shared stack.
  spawnSync(cli[0], [...cli.slice(1), 'db', 'reset', '--local', '--no-seed'], { cwd: cloudRoot, env: process.env,
    encoding: 'utf8', timeout: 1800000 });
}
let e2e = null;
if (args['e2e-evidence']) {
  const runFile = path.join(args['e2e-evidence'], 'run.json');
  if (fs.existsSync(runFile)) {
    const summary = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    e2e = { suite: 'test:information-flow:e2e', pointer: 'run.json and e2e/*.json in this evidence directory',
      results: summary.results };
  }
}
const report = {
  schema: 'clued.information-flow.m0d.regression/1',
  gate: 'M0D-B07',
  runtime: { node: process.version, pg_user: args['pg-user'] ?? null },
  input_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  suites: results,
  e2e,
  excluded: EXCLUDED,
  baseline_classification: {
    'db:test:v2': {
      classification: 'pre-existing stale-test baseline failure (not an environmental failure); not modified in S6',
      owner_acceptance: ownerAcceptance(),
      baseline_refs_on_main: baselineAncestry(),
      root_cause: 'apps/clued-cloud/supabase/migrations/20260825171129_clued_m1_runtime_contracts.sql:763 revokes '
        + 'clued_user_record_write from authenticated; apps/clued-cloud/supabase/tests/unified_record_v2.test.sql:36 '
        + 'still calls it. No CI workflow runs db:test:v2.',
    },
  },
  summary: {
    pass: results.filter((entry) => entry.result === 'PASS').map((entry) => entry.suite),
    fail: results.filter((entry) => entry.result === 'FAIL').map((entry) => entry.suite),
    unexplained_failures: results.filter((entry) => entry.result === 'FAIL' && !entry.identical_failure_on_baselines)
      .map((entry) => entry.suite),
  },
};
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report.summary)}\n`);
process.exitCode = report.summary.unexplained_failures.length ? 1 : 0;
