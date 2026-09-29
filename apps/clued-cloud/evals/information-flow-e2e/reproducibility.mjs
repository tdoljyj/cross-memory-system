#!/usr/bin/env node
// Writes reproducibility.json for a committed evidence directory from a second
// run at the same code tree: both runs' per-row normalized digests (recomputed
// with this checkout's normalizer), both code trees, and the verdict.
// Usage: node reproducibility.mjs --committed <dir> --cross-check <dir>

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NORMALIZATION, normalizedDigest, writeJson } from './evidence.mjs';

const { values: args } = parseArgs({ options: { committed: { type: 'string' }, 'cross-check': { type: 'string' } } });
if (!args.committed || !args['cross-check']) throw new Error('--committed <dir> --cross-check <dir> are required');

function load(dir) {
  const rows = {};
  for (const sub of ['e2e', 'continuity']) {
    const base = path.join(dir, sub);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).filter((n) => /^E2E-\d+\.json$/.test(n))) {
      const evidence = JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
      rows[evidence.scenario_id] = { digest: normalizedDigest(evidence), result: evidence.result,
        code_tree: evidence.code_binding?.code_tree ?? null };
    }
  }
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  return { rows, code_tree: run.code_binding?.code_tree ?? null, input_commit: run.code_binding?.input_commit ?? null,
    db_system_identifier: run.environment?.db_system_identifier ?? null, run_flags: run.run_flags ?? null };
}

const a = load(path.resolve(args.committed));
const b = load(path.resolve(args['cross-check']));
const ids = [...new Set([...Object.keys(a.rows), ...Object.keys(b.rows)])].sort();
const scenarios = Object.fromEntries(ids.map((id) => [id, {
  committed_run: a.rows[id] ?? null, cross_check_run: b.rows[id] ?? null,
  equal: Boolean(a.rows[id] && b.rows[id] && a.rows[id].digest === b.rows[id].digest),
}]));
const differing = ids.filter((id) => !scenarios[id].equal);
const report = {
  schema: 'clued.information-flow.m0d.reproducibility/2',
  generated_by: 'apps/clued-cloud/evals/information-flow-e2e/reproducibility.mjs',
  rule: 'equal normalized digests for every row at the same code tree (raw bodies differ per run)',
  normalization: NORMALIZATION,
  committed_run: { code_tree: a.code_tree, input_commit: a.input_commit, db_system_identifier: a.db_system_identifier,
    run_flags: a.run_flags },
  cross_check_run: { code_tree: b.code_tree, input_commit: b.input_commit, db_system_identifier: b.db_system_identifier,
    run_flags: b.run_flags, committed: 'per-row digests only (this file); the raw second run is not committed' },
  code_tree_equal: a.code_tree !== null && a.code_tree === b.code_tree,
  distinct_databases: a.db_system_identifier !== b.db_system_identifier,
  scenarios,
  differing,
};
report.result = report.code_tree_equal && differing.length === 0 ? 'REPRODUCED' : 'DIFFERENT';
writeJson(path.join(path.resolve(args.committed), 'reproducibility.json'), report);
process.stdout.write(`${report.result}\n`);
process.exitCode = report.result === 'REPRODUCED' ? 0 : 1;
