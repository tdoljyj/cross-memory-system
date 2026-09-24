#!/usr/bin/env node
// M0D-A01 runner (contract M0DCloseout.v0.1 section 8, Part A): re-verifies
// the three frozen parents on Node 24.19.0. Inputs are the release transport
// ZIPs plus the release SHA256SUMS (from the Owner's Drive copies of release
// information-flow-m0-frozen-archive-20260908). Parents are extracted outside
// the repository, bound with the read-only adapter, and each parent entry runs
// in a copy with dependencies installed in the copy's parent directory, never
// inside a parent root. The extracted roots are re-verified afterwards.
// Local only: CI cannot fetch the private release assets.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bindFrozenParents } from './frozen-parent-adapter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELEASE_SUMS_SHA256 = '24ea8ca343cd8f6526f9e8ae56e84d136b065e976c73f2fef24c86f6feef959e';
const ZIPS = {
  m0a: ['Clued_Information_Flow_M0A_Frozen_recovered.zip', 'Clued_Information_Flow_MVP0'],
  m0b: ['Clued_Information_Flow_M0B_Frozen_recovered.zip', 'Clued_Information_Flow_M0B_Prompt_Pack'],
  m0c: ['Clued_Information_Flow_M0C_Frozen_0.3.2-m0c_r3.zip', 'Clued_Information_Flow_M0C_Frozen_0.3.2-m0c_r3'],
};
const EXPECTED = {
  m0a_normalized_result_digest: '9aa2664d309915ada57f88c406a68b62417dfed1c62314f1185183352816fdee',
  m0b_normalized_prompt_contract_digest: '346158d70d075730d5ae8868d8c7015727a345dc5f8d8f4234c720adbbdf4b81',
};

const { values: args } = parseArgs({ options: { zips: { type: 'string' }, work: { type: 'string' },
  out: { type: 'string' }, attempts: { type: 'string', default: '3' } } });
if (!args.zips || !args.work || !args.out) throw new Error('usage: --zips <dir> --work <dir outside repo> --out <json>');
if (process.version !== 'v24.19.0') throw new Error(`Node 24.19.0 required, got ${process.version}`);
const work = path.resolve(args.work);
if (work.startsWith(repoRoot + path.sep)) throw new Error('the work directory must be outside the repository');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 1. Release SHA256SUMS and transport ZIP digests.
const sums = fs.readFileSync(path.join(args.zips, 'SHA256SUMS'));
if (sha(sums) !== RELEASE_SUMS_SHA256) throw new Error('release SHA256SUMS digest mismatch');
const listed = new Map(sums.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => {
  const [digest, name] = line.split(/\s+/);
  return [name, digest];
}));
const zipDigests = {};
for (const [key, [zip]] of Object.entries(ZIPS)) {
  zipDigests[key] = sha(fs.readFileSync(path.join(args.zips, zip)));
  if (listed.get(zip) !== zipDigests[key]) throw new Error(`${zip} does not match the release SHA256SUMS`);
}

// 2. Extract outside the repository.
fs.rmSync(work, { recursive: true, force: true });
const extract = path.join(work, 'extract');
fs.mkdirSync(extract, { recursive: true });
for (const [zip] of Object.values(ZIPS)) execFileSync('unzip', ['-q', path.join(args.zips, zip), '-d', extract]);
const roots = Object.fromEntries(Object.entries(ZIPS).map(([key, [, dir]]) => [key, path.join(extract, dir)]));
const adapterRoots = { 'IF-MVP0-A': roots.m0a, 'IF-MVP0-B': roots.m0b, 'IF-MVP0-C': roots.m0c };

// 3. Adapter binding and the repository adapter test with all three roots.
const adapterBefore = bindFrozenParents(adapterRoots);
const env = { ...process.env, M0A_ROOT: roots.m0a, M0B_ROOT: roots.m0b, M0C_ROOT: roots.m0c };
const run = (command, argv, cwd, extraEnv = {}) => {
  const result = spawnSync(command, argv, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024 });
  return { exit_code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
const adapterTest = run(process.execPath, ['--test', '--test-reporter=tap', 'tests/information-flow-parent-adapter.test.mjs'], repoRoot);
const tap = (text) => Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled']
  .map((key) => [key, Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(text)?.[1] ?? NaN)]));

// 4. Parent entries, each in a copy; dependencies in the copy's parent directory.
const copies = {};
for (const [key, root] of Object.entries(roots)) {
  const holder = path.join(work, 'run', key);
  fs.mkdirSync(holder, { recursive: true });
  copies[key] = path.join(holder, path.basename(root));
  fs.cpSync(root, copies[key], { recursive: true });
  if (fs.existsSync(path.join(root, 'package-lock.json'))) {
    fs.copyFileSync(path.join(root, 'package.json'), path.join(holder, 'package.json'));
    fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(holder, 'package-lock.json'));
    const installed = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], holder);
    if (installed.exit_code !== 0) throw new Error(`npm ci for ${key} failed: ${installed.stderr.slice(0, 400)}`);
  }
}
const m0a = run(process.execPath, ['tests/validate-contract.mjs'], copies.m0a);
const m0aReport = JSON.parse(m0a.stdout);
const m0b = run(process.execPath, ['tests/validate-prompts.mjs', '--m0a-root', roots.m0a], copies.m0b);
const m0bReport = JSON.parse(m0b.stdout);
const m0cVerify = run(process.execPath, ['scripts/verify-package.mjs'], copies.m0c);
const m0cValidate = run(process.execPath, ['scripts/validate-fixtures.mjs'], copies.m0c);
// The M0-C test entry is run --attempts times on the same copy and every
// attempt is recorded (the entry is known to be nondeterministic).
const m0cTestFiles = fs.readdirSync(path.join(copies.m0c, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort()
  .map((name) => `tests/${name}`);
const m0cAttempts = [];
for (let i = 0; i < Number(args.attempts); i += 1) {
  const attempt = run(process.execPath, ['--test', '--test-reporter=tap', ...m0cTestFiles], copies.m0c);
  m0cAttempts.push({ ...attempt, failing: [...attempt.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).sort() });
}
const m0cTests = m0cAttempts.find((attempt) => attempt.exit_code === 0) ?? m0cAttempts[0];
const parseStatus = (text) => { try { return JSON.parse(text).status ?? null; } catch {
  return /PASS_STATIC_ACCEPTANCE|PASS|FAIL/.exec(text)?.[0] ?? null; } };

// 5. The extracted roots are still byte-identical (inner SHA256SUMS re-checked).
const adapterAfter = bindFrozenParents(adapterRoots);
const m0cTap = tap(m0cTests.stdout);
const adapterTap = tap(adapterTest.stdout);
const result = {
  contract: 'clued.information-flow.m0d.parent-reverification/1',
  gate: 'M0D-A01',
  evidence_class: 'observed_local_agent_run',
  source: {
    release: 'information-flow-m0-frozen-archive-20260908',
    transport: 'Owner-uploaded Google Drive copies, folder Information_Flow (downloaded through the Google Drive connector)',
    transport_zip_sha256: zipDigests,
    transport_zip_matches_release_sha256sums: true,
    release_sha256sums: { sha256: RELEASE_SUMS_SHA256, bytes: sums.length },
  },
  runtime: { node: process.version, pinned_node: '24.19.0', installed_with: 'nvm (/opt/nvm)' },
  adapter: { ...adapterBefore, original_bytes_modified: JSON.stringify(adapterBefore) !== JSON.stringify(adapterAfter),
    re_verified_after_entries: adapterAfter.status },
  adapter_test: { command: 'node --test tests/information-flow-parent-adapter.test.mjs (M0A_ROOT/M0B_ROOT/M0C_ROOT set)',
    exit_code: adapterTest.exit_code, ...adapterTap },
  parent_entries: {
    m0a: { command: 'node tests/validate-contract.mjs (npm test)', exit_code: m0a.exit_code, passed: m0aReport.passed,
      failed: m0aReport.failed, normalized_result_digest: m0aReport.normalized_result_digest,
      equals_frozen_report_digest: m0aReport.normalized_result_digest === EXPECTED.m0a_normalized_result_digest },
    m0b: { command: 'node tests/validate-prompts.mjs --m0a-root <accepted-m0a-root>', exit_code: m0b.exit_code,
      status: m0bReport.status, gates: m0bReport.gates,
      normalized_prompt_contract_digest: m0bReport.normalized_prompt_contract_digest,
      equals_frozen_report_digest: m0bReport.normalized_prompt_contract_digest === EXPECTED.m0b_normalized_prompt_contract_digest },
    m0c: {
      verify: { command: 'node scripts/verify-package.mjs', exit_code: m0cVerify.exit_code, status: parseStatus(m0cVerify.stdout) },
      validate: { command: 'node scripts/validate-fixtures.mjs', exit_code: m0cValidate.exit_code,
        status: parseStatus(m0cValidate.stdout) },
      tests: { command: 'node --test tests/*.test.mjs', recorded_attempt: m0cAttempts.indexOf(m0cTests) + 1,
        exit_code: m0cTests.exit_code, ...m0cTap,
        attempts: m0cAttempts.map((attempt, i) => ({ attempt: i + 1, exit_code: attempt.exit_code, ...tap(attempt.stdout),
          failing_tests: attempt.failing, output_sha256: sha(attempt.stdout) })) },
    },
  },
  raw_output_sha256: {
    note: 'Hashes of the local raw outputs (not committed; they may contain host paths or wall-clock fields).',
    m0a_report: sha(m0a.stdout), m0b_report: sha(m0b.stdout), m0c_verify: sha(m0cVerify.stdout),
    m0c_validate: sha(m0cValidate.stdout), m0c_test_log: sha(m0cTests.stdout), adapter_test_log: sha(adapterTest.stdout),
  },
  method_notes: [
    'Entries ran in a copy of each extracted parent; dependencies were installed with npm ci --ignore-scripts in the copy\'s parent directory, never inside a parent root.',
    'The extracted parent roots were re-bound with the adapter after every entry ran (inner SHA256SUMS re-checked).',
    'The M0-C test entry is run as-is several times on one copy; every attempt is listed. Its test runner-records.test.mjs spawns scripts/run-evaluation.mjs with the package\'s locked mock-provider arguments (no network provider; the harness isolation guard is not loaded into this runner).',
    'Known nondeterminism: that test parses the child\'s large JSON stdout, which can arrive truncated ("stdout is not JSON"); it is a frozen-parent test defect and the parent bytes are never changed to fix it.',
  ],
  does_not_establish: ['Primary Model PASS (A02 stays UNMET under OD-1b)', 'MVP-0 closure', 'Phase 2 Slice A acceptance',
    'any Canonical or production effect'],
};
const KNOWN_FLAKE = 'normal mock run binds all preflight digests and records every attempt';
const others = adapterBefore.status === 'PASS_SOURCE_BINDING_ONLY' && !result.adapter.original_bytes_modified
  && adapterTest.exit_code === 0 && adapterTap.skipped === 0 && m0a.exit_code === 0
  && result.parent_entries.m0a.equals_frozen_report_digest && m0b.exit_code === 0
  && result.parent_entries.m0b.equals_frozen_report_digest && m0cVerify.exit_code === 0 && m0cValidate.exit_code === 0;
const allAttempts = m0cAttempts.every((attempt) => attempt.exit_code === 0);
const someAttempt = m0cAttempts.some((attempt) => attempt.exit_code === 0);
const onlyKnownFlake = m0cAttempts.every((attempt) => attempt.exit_code === 0
  || (attempt.failing.length === 1 && attempt.failing[0] === KNOWN_FLAKE));
result.result = others && allAttempts ? 'PASS'
  : others && someAttempt && onlyKnownFlake ? 'PASS_WITH_DISCLOSED_NONDETERMINISM' : 'FAIL';
const pass = result.result !== 'FAIL';
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${result.result}\n`);
process.exitCode = pass ? 0 : 1;
