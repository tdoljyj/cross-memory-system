#!/usr/bin/env node
// Recomputes every scenario's normalized digest (plan section 8) and, with
// --against, compares a fresh run with committed evidence: "reproducible"
// means equal normalized digests at the same code tree (volatile ids,
// timestamps, durations and PIDs are stripped; raw bodies differ per run).

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NORMALIZATION, normalizedDigest } from './evidence.mjs';

const { values: args } = parseArgs({ options: { dir: { type: 'string' }, against: { type: 'string' } } });
if (!args.dir) throw new Error('--dir <evidence dir> is required');

function scenarios(dir) {
  const out = {};
  for (const sub of ['e2e', 'continuity']) {
    const base = path.join(dir, sub);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).filter((n) => /^E2E-\d+\.json$/.test(n)).sort()) {
      out[name.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
    }
  }
  return out;
}

const mine = scenarios(path.resolve(args.dir));
const report = { normalization: NORMALIZATION, recomputed: {}, mismatched_self: [], compared: {}, differing: [],
  code_tree_mismatch: [] };
for (const [id, evidence] of Object.entries(mine)) {
  const digest = normalizedDigest(evidence);
  report.recomputed[id] = { stored: evidence.normalized_digest, recomputed: digest, result: evidence.result };
  if (digest !== evidence.normalized_digest) report.mismatched_self.push(id);
}
if (args.against) {
  const theirs = scenarios(path.resolve(args.against));
  for (const id of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    // Recomputed on both sides with this checkout's normalizer.
    const a = mine[id] ? normalizedDigest(mine[id]) : null;
    const b = theirs[id] ? normalizedDigest(theirs[id]) : null;
    report.compared[id] = { this_run: a, against: b, equal: a !== null && a === b,
      code_tree_equal: mine[id]?.code_binding?.code_tree === theirs[id]?.code_binding?.code_tree };
    if (a === null || a !== b) report.differing.push(id);
    if (!report.compared[id].code_tree_equal) report.code_tree_mismatch.push(id);
  }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.mismatched_self.length || report.differing.length || report.code_tree_mismatch.length ? 1 : 0;
