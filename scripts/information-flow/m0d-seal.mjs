#!/usr/bin/env node
// M0-D closeout evidence tooling (S6 plan sections 9 and 11):
//   closure       write part-a/a03-closure.json (dependency locks, digests,
//                 known-limitations register digest)            [M0D-A03]
//   review-input  write review-input.json: the B09 input package (input
//                 commit, code tree, file digests of the review scope)
//   seal          write manifest.json + SHA256SUMS over the evidence
//                 directory (after b09-review.json exists)       [M0D-A04]
//   verify        recompute SHA256SUMS and, with --input-commit, assert
//                 that HEAD differs from the reviewed commit only inside
//                 the evidence directory
// The manifest is a closeout manifest, not an MVP-0 closure (A02 stays
// UNMET under OD-1b); it proposes separate Part A and Part B labels and never
// records a verdict.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cloudRoot = path.join(repoRoot, 'apps/clued-cloud');
const CONTRACT = 'development/contracts/information-flow/M0DCloseout.v0.1.md';
const REGISTER = 'development/contracts/information-flow/known-limitations.m0d.v0.1.json';
const [command] = process.argv.slice(2);
const { values: args } = parseArgs({ args: process.argv.slice(3), options: { dir: { type: 'string' },
  'input-commit': { type: 'string' }, 'images': { type: 'string' } } });
if (!args.dir) throw new Error('--dir <evidence dir> is required');
const dir = path.resolve(args.dir);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim();
const fileSha = (rel) => sha(fs.readFileSync(path.join(repoRoot, rel)));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };

function listFiles(base, exclude = new Set()) {
  return fs.readdirSync(base, { recursive: true })
    .filter((name) => fs.statSync(path.join(base, name)).isFile())
    .map((name) => name.split(path.sep).join('/'))
    .filter((name) => !exclude.has(name)).sort();
}

function migrationsChain() {
  const mdir = path.join(cloudRoot, 'supabase/migrations');
  const names = fs.readdirSync(mdir).filter((n) => n.endsWith('.sql')).sort();
  return { count: names.length, latest: names.at(-1),
    sha256: sha(names.map((n) => `${n}  ${sha(fs.readFileSync(path.join(mdir, n)))}\n`).join('')) };
}

function verifySums(file) {
  const base = path.dirname(file);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const bad = lines.filter((line) => {
    const [digest, name] = line.split('  ');
    return sha(fs.readFileSync(path.join(base, name))) !== digest;
  });
  return { lines: lines.length, mismatched: bad.length };
}

if (command === 'closure') {
  const register = readJson(path.join(repoRoot, REGISTER));
  const run = fs.existsSync(path.join(dir, 'run.json')) ? readJson(path.join(dir, 'run.json')) : null;
  const vendoredA = verifySums(path.join(repoRoot, 'development/contracts/information-flow/vendored/m0a/SHA256SUMS.m0a-subset'));
  const vendoredC = verifySums(path.join(repoRoot, 'development/contracts/information-flow/vendored/m0c/SHA256SUMS.m0c-subset'));
  const a01 = fs.existsSync(path.join(dir, 'part-a/a01-parents.json')) ? readJson(path.join(dir, 'part-a/a01-parents.json')) : null;
  const tokenizerBinding = 'scripts/phase2-qualification/minimum-context-compiler/TokenizerBinding.json';
  const required = ['L01', 'L02', 'L03', 'L04', 'L05', 'L06'];
  const ids = register.entries.map((entry) => entry.id);
  const closure = {
    schema: 'clued.information-flow.m0d.a03-closure/1',
    gate: 'M0D-A03',
    dependency_locks: {
      'apps/clued-cloud/package-lock.json': fileSha('apps/clued-cloud/package-lock.json'),
      'package-lock.json (root)': fs.existsSync(path.join(repoRoot, 'package-lock.json')) ? fileSha('package-lock.json') : null,
      supabase_cli: '2.115.0',
      images: run?.environment?.images ?? null,
      js_tiktoken: JSON.parse(fs.readFileSync(path.join(cloudRoot, 'node_modules/js-tiktoken/package.json'), 'utf8')).version,
      o200k_ranks_sha256: /O200K_RANKS_SHA256 = "([0-9a-f]{64})"/.exec(fs.readFileSync(path.join(cloudRoot, 'worker/context-pack.ts'), 'utf8'))?.[1] ?? null,
      // scripts/phase2-qualification/minimum-context-compiler/TokenizerBinding.json
      compiler_ranks_binding_file_sha256: fs.existsSync(path.join(repoRoot, tokenizerBinding)) ? fileSha(tokenizerBinding) : null,
      migrations_chain: migrationsChain(),
    },
    vendored_subsets: { m0a: vendoredA, m0c: vendoredC },
    contract: { path: CONTRACT, sha256: fileSha(CONTRACT) },
    parents: { original_bytes_modified: a01 ? a01.adapter?.original_bytes_modified : null,
      a01_result: a01?.result ?? 'NOT_EXECUTED',
      a01_m0c_test_attempts: a01?.parent_entries?.m0c?.tests?.attempts?.map((a) => ({ attempt: a.attempt,
        exit_code: a.exit_code, failing_tests: a.failing_tests })) ?? null },
    register: { path: REGISTER, sha256: fileSha(REGISTER), entries: ids.length,
      contract_mandated_present: required.every((id) => ids.includes(id)), all_open: register.entries.every((e) => e.status === 'OPEN') },
  };
  closure.result = vendoredA.mismatched === 0 && vendoredC.mismatched === 0 && closure.register.contract_mandated_present
    && closure.parents.original_bytes_modified === false ? 'PASS' : 'FAIL';
  write(path.join(dir, 'part-a/a03-closure.json'), closure);
  process.stdout.write(`${closure.result}\n`);
} else if (command === 'review-input') {
  const commit = git('rev-parse', 'HEAD');
  const scope = [
    'apps/clued-cloud/supabase/migrations/20260924160000_information_flow_candidate_store.sql',
    'apps/clued-cloud/supabase/migrations/20260924180000_information_flow_intake_transport.sql',
    'apps/clued-cloud/supabase/migrations/20260924190000_information_flow_promotion.sql',
    'apps/clued-cloud/supabase/migrations/20260924200000_information_flow_context_policy.sql',
    'apps/clued-cloud/supabase/migrations/20260924220000_information_flow_invalidation.sql',
    'apps/clued-cloud/worker/information-flow.ts', 'apps/clued-cloud/worker/context-pack.ts',
    'apps/clued-cloud/worker/continuity.ts', CONTRACT, REGISTER, 'AGENTS.md',
    ...listFiles(path.join(cloudRoot, 'evals/information-flow-e2e')).map((f) => `apps/clued-cloud/evals/information-flow-e2e/${f}`),
    ...listFiles(path.join(repoRoot, 'scripts/information-flow')).map((f) => `scripts/information-flow/${f}`),
    '.github/workflows/information-flow-e2e.yml',
  ];
  const evidence = listFiles(dir, new Set(['review-input.json', 'b09-review.json', 'manifest.json', 'SHA256SUMS',
    'b09-review-brief.md']));
  const rel = path.relative(repoRoot, dir).split(path.sep).join('/');
  write(path.join(dir, 'review-input.json'), {
    schema: 'clued.information-flow.m0d.review-input/1', gate: 'M0D-B09',
    status: 'PREPARED_NOT_REVIEWED',
    note: 'Input package for the Fresh-Context read-only review. The reviewer runs in a session distinct from the implementer, sees no earlier review rounds, re-runs npm run information-flow:e2e:verify and m0d-seal.mjs verify, and returns clued.information-flow.m0d.review/1 JSON (plan section 11).',
    code_parent_commit: commit,
    code_tree: git('rev-parse', `${commit}:apps/clued-cloud`),
    scope_file_digests: Object.fromEntries(scope.filter((f) => fs.existsSync(path.join(repoRoot, f))).map((f) => [f, fileSha(f)])),
    evidence_file_digests: Object.fromEntries(evidence.map((f) => [`${rel}/${f}`, sha(fs.readFileSync(path.join(dir, f)))])),
    severity_rubric: ['BLOCKER', 'MAJOR', 'MINOR'],
    pass_rule: '0 BLOCKER and 0 MAJOR (M0D-B09)',
  });
  process.stdout.write('review-input.json written\n');
} else if (command === 'seal') {
  const need = (name) => { const file = path.join(dir, name); return fs.existsSync(file) ? readJson(file) : null; };
  const review = need('b09-review.json');
  const results = need('run.json')?.results ?? {};
  const isolation = need('isolation.json');
  const regression = need('regression.json');
  const a01 = need('part-a/a01-parents.json');
  const a03 = need('part-a/a03-closure.json');
  const rows = (ids) => ids.map((id) => [id, results[id]?.result ?? 'MISSING']);
  const e2ePass = (ids) => ids.every((id) => results[id]?.result === 'PASS');
  const digests = (names) => Object.fromEntries(names.filter((n) => fs.existsSync(path.join(dir, n)))
    .map((n) => [n, sha(fs.readFileSync(path.join(dir, n)))]));
  const partB = {
    'M0D-B01': { status: 'SEE_REGRESSION', evidence: digests(['regression.json']) },
    'M0D-B02': { status: e2ePass(['E2E-06', 'E2E-07']) ? 'PASS' : 'FAIL', e2e: rows(['E2E-06', 'E2E-07']) },
    'M0D-B03': { status: e2ePass(['E2E-01', 'E2E-02', 'E2E-03', 'E2E-15']) && results['E2E-11']?.result === 'OBSERVED'
      ? 'PASS' : 'FAIL', e2e: rows(['E2E-01', 'E2E-02', 'E2E-03', 'E2E-15', 'E2E-11']) },
    'M0D-B04': { status: e2ePass(['E2E-01', 'E2E-05', 'E2E-12', 'E2E-13', 'E2E-14']) ? 'PASS' : 'FAIL',
      e2e: rows(['E2E-01', 'E2E-05', 'E2E-12', 'E2E-13', 'E2E-14']) },
    'M0D-B05': { status: e2ePass(['E2E-03', 'E2E-04', 'E2E-05']) ? 'PASS' : 'FAIL', e2e: rows(['E2E-03', 'E2E-04', 'E2E-05']) },
    'M0D-B06': { status: e2ePass(['E2E-08']) ? 'PASS' : 'FAIL', e2e: rows(['E2E-08']) },
    'M0D-B07': { status: regression && regression.summary.unexplained_failures.length === 0 ? 'PASS_WITH_DISCLOSED_BASELINE'
      : 'FAIL', evidence: digests(['regression.json']) },
    'M0D-B08': { status: isolation?.result ?? 'MISSING', e2e: rows(['E2E-09']), evidence: digests(['isolation.json', 'egress-summary.json']) },
    'M0D-B09': { status: review ? (review.counts?.blocker === 0 && review.counts?.major === 0 ? 'PASS' : 'FAIL') : 'PENDING',
      evidence: digests(['b09-review.json']) },
  };
  partB['M0D-B01'].status = regression && ['db:lint', 'test:authorization:migrations', 'test:production:release-gate']
    .every((name) => regression.suites.find((s) => s.suite === name)?.result === 'PASS') ? 'PASS' : 'FAIL';
  const partA = {
    'M0D-A01': a01?.result ?? 'NOT_EXECUTED', 'M0D-A02': 'UNMET_OD-1b', 'M0D-A03': a03?.result ?? 'MISSING',
    'M0D-A04': 'THIS_MANIFEST',
  };
  const allB = Object.values(partB).every((gate) => /^PASS/.test(gate.status));
  const commit = args['input-commit'] ?? review?.input_commit ?? null;
  const manifest = {
    schema: 'clued.information-flow.m0d.closeout-manifest/1',
    not_mvp0_closure: true,
    input_commit: commit,
    code_tree: commit ? git('rev-parse', `${commit}:apps/clued-cloud`) : null,
    contract: { path: CONTRACT, sha256: fileSha(CONTRACT), freeze_decision: '825aa822', od_decision: 'ef229e68-bff5-4dca-9b7f-159a08096748' },
    parents: a01 ? { transport_zip_sha256: a01.source.transport_zip_sha256, result: a01.result } : null,
    part_a: partA,
    part_b: partB,
    supporting_db_evidence: {
      'E2E-02 issue+consume in one transaction': (() => {
        const suite = regression?.suites?.find((s) => s.suite === 'test:information-flow:promotion');
        return { suite: 'test:information-flow:promotion', file: 'apps/clued-cloud/tests/information-flow-promotion-db.test.mjs',
          assertion: 'confirmation_token_same_request', result: suite?.result ?? 'MISSING',
          output_sha256: suite?.output_sha256 ?? null, role: 'supporting evidence only' };
      })(),
    },
    review_rounds: fs.existsSync(path.join(dir, 'b09-review.rounds'))
      ? fs.readdirSync(path.join(dir, 'b09-review.rounds')).sort().map((name) => {
        const round = readJson(path.join(dir, 'b09-review.rounds', name));
        return { file: `b09-review.rounds/${name}`, input_commit: round.input_commit, verdict: round.verdict,
          counts: round.counts, sha256: sha(fs.readFileSync(path.join(dir, 'b09-review.rounds', name))) };
      }) : [],
    observations: { 'E2E-11': { result: results['E2E-11']?.result ?? 'MISSING', register_entry: 'L01', limitation_id: 'OPEN_BY_OD-5' } },
    proposed_verdict_labels: {
      part_a: `A01 ${partA['M0D-A01']}, A02 UNMET (OD-1b), A03 ${partA['M0D-A03']}, A04 PASS; MVP-0 stays open`,
      part_b: allB && /^PASS/.test(partA['M0D-A01']) && partA['M0D-A03'] === 'PASS'
        ? `PASS / CLUED_INFORMATION_FLOW_M0D_PART_B_RUNTIME_ACCEPTED_MODEL_FREE_LOCAL_QUALIFIED (Agent authority confined only on the Information Flow path)${partA['M0D-A01'] === 'PASS' ? '' : '; conditional on Owner acceptance of the disclosed A01 nondeterminism'}`
        : 'BLOCKED / CLUED_INFORMATION_FLOW_M0D_GAPS_FOUND',
      never_combined: true,
      recorded_by: 'proposal only; a Canonical verdict Decision needs the Owner (contract header rule); Task 45fb2ae7 stays open',
    },
    does_not_authorize: ['production migration, deployment or release', 'Provider/model calls, or any budget', 'purchase',
      'changes to M0-A/B/C bytes', 'promotion of real user data during qualification',
      'changes to the general M1 user_confirmed semantics (OD-5)', 'MTPE/Frontier rule or code changes',
      'entry to Phase 2 Slice A, or claims that P-007/P-008/P-009/P-011 are complete'],
  };
  write(path.join(dir, 'manifest.json'), manifest);
  const files = listFiles(dir, new Set(['SHA256SUMS']));
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), files.map((f) => `${sha(fs.readFileSync(path.join(dir, f)))}  ${f}\n`).join(''));
  process.stdout.write(`${JSON.stringify(manifest.proposed_verdict_labels)}\n`);
} else if (command === 'verify') {
  const sums = verifySums(path.join(dir, 'SHA256SUMS'));
  const listed = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('  ')[1]);
  const unlisted = listFiles(dir, new Set(['SHA256SUMS'])).filter((f) => !listed.includes(f));
  let outside = [];
  if (args['input-commit']) {
    const rel = path.relative(repoRoot, dir).split(path.sep).join('/');
    outside = git('diff', '--name-only', `${args['input-commit']}..HEAD`).split('\n').filter(Boolean)
      .filter((f) => !f.startsWith(`${rel}/`));
  }
  const ok = sums.mismatched === 0 && unlisted.length === 0 && outside.length === 0;
  process.stdout.write(`${JSON.stringify({ ...sums, unlisted, changed_outside_evidence: outside, result: ok ? 'PASS' : 'FAIL' })}\n`);
  process.exitCode = ok ? 0 : 1;
} else {
  throw new Error('usage: m0d-seal.mjs closure|review-input|seal|verify --dir <evidence dir> [--input-commit <sha>]');
}
