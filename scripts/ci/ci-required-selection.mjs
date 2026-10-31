// Which test suites a change needs, and what each suite runs (Task 2a5fdb66;
// design in work/ci-required-tests-v1/DESIGN.md).
//
// The required checks ci-suites, clued-cloud-tests and migration-verify
// always report, so they can sit in the main ruleset; this file decides what
// each one runs. The
// workflows run it from the pull request's trusted base checkout, never from
// the candidate, so a pull request cannot narrow its own selection or swap a
// suite's commands. The candidate's own changes to the selection (this file,
// the workflows) select every suite.
//
//   node scripts/ci/ci-required-selection.mjs --check <ci-suites|clued-cloud-tests|migration-verify>
//     reads GITHUB_EVENT_PATH and lists the pull request's files through the
//     API (GITHUB_TOKEN, pull-requests: read); a push, a listing it cannot
//     read or a listing at GitHub's 3000-file limit selects everything.
//     Writes suites=<json> and run_<suite>=true|false to GITHUB_OUTPUT.
//   node scripts/ci/ci-required-selection.mjs --run <suite> [--root <checkout>]
//     runs one suite's commands (SUITE_COMMANDS) in the checkout at --root.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// suite id -> path patterns ("**" any depth, "*" within a segment).
export const SUITES = {
  'ci-suites': {
    'resident-node': ['work/independent-ci-resident-v1/**'],
    'resident-python': ['work/independent-ci-resident-v1/**'],
    'offline-drill': ['work/independent-ci-resident-v1/**', 'work/actions-hosted-migration/independent-ci-v1/**'],
    'source-v2-node': ['work/actions-hosted-migration/independent-ci-v1/**'],
    'source-v2-python': ['work/actions-hosted-migration/independent-ci-v1/**'],
    'components': ['scripts/clued_components.py', 'scripts/hooks/**', 'skills/**', 'integrations/**',
      'config/clued-components.json', 'tests/test_clued_components.py', 'tests/test_clued_version_check.py',
      'VERSION', '.claude/settings.json'],
    'runner-budget-policy': ['.github/workflows/**', 'scripts/ci/validate_runner_budget_policy.py',
      'scripts/ci/test_validate_runner_budget_policy.py'],
    'admission-self-tests': ['scripts/ci/clued-work-admission*.mjs', 'scripts/ci/merge-admission-policy*.mjs',
      'scripts/ci/clued-release-grant*.mjs', 'scripts/ci/clued-merge-slot-ci*.mjs', 'scripts/runner/**',
      'config/merge-admission-policy.json'],
    'selection': ['scripts/ci/ci-required-selection.mjs', 'scripts/ci/ci-required-selection.test.mjs'],
  },
  // The application suite reads files from across the repository (workflow,
  // contract and CI-script tests), so every change runs it, like the disabled
  // clued-cloud-quality-gate.yml did.
  'clued-cloud-tests': {
    'clued-cloud': ['**'],
  },
  'migration-verify': {
    'production-schema': ['apps/clued-cloud/supabase/**', 'apps/clued-cloud/scripts/production-schema-*.mjs',
      'apps/clued-cloud/scripts/migration-ledger.mjs', 'apps/clued-cloud/scripts/production-release-baseline.json',
      'apps/clued-cloud/tests/production-schema-drift.test.mjs', 'apps/clued-cloud/package.json',
      'apps/clued-cloud/package-lock.json'],
  },
};

// Changing how selection or a required-check workflow works selects every suite
// of every check.
export const SELECT_ALL = ['scripts/ci/ci-required-selection.mjs', '.github/workflows/clued-ci-suites.yml', '.github/workflows/clued-cloud-tests.yml',
  '.github/workflows/clued-migration-verify.yml', '.github/actions/**'];

export const FILE_LIMIT = 3000;

// What each suite runs; cwd is relative to the checkout root. Source v2 tests
// resolve paths from the root, so they run there. {tests:<dir>} expands to the
// sorted *.test.mjs files directly in <dir> (relative to cwd), {base} to the
// base commit (CI_BASE_SHA), {report} to a file under RUNNER_TEMP.
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const RESIDENT = 'work/independent-ci-resident-v1';
const SOURCE_V2 = 'work/actions-hosted-migration/independent-ci-v1';
export const SUITE_COMMANDS = {
  'resident-node': [{ cwd: RESIDENT, argv: ['node', '--test', '{tests:test}'] }],
  'resident-python': [{ cwd: RESIDENT, argv: [PYTHON, '-I', '-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'] }],
  'offline-drill': [{ cwd: RESIDENT, argv: ['node', 'drill/offline-drill.mjs'] }],
  'source-v2-node': [{ cwd: '.', argv: ['node', '--test', `{tests:${SOURCE_V2}/test}`] }],
  'source-v2-python': [{ cwd: '.', argv: [PYTHON, '-I', '-B', '-m', 'unittest', 'discover', '-s', `${SOURCE_V2}/test`, '-p', 'test_*.py'] }],
  'components': [
    { cwd: '.', argv: [PYTHON, 'scripts/clued_components.py', 'check', '--base', '{base}'] },
    { cwd: '.', argv: [PYTHON, '-m', 'unittest', 'tests.test_clued_components', 'tests.test_clued_version_check'] },
  ],
  'runner-budget-policy': [
    { cwd: '.', argv: [PYTHON, 'scripts/ci/validate_runner_budget_policy.py'], quiet: true },
    { cwd: '.', argv: [PYTHON, '-m', 'unittest', 'scripts/ci/test_validate_runner_budget_policy.py'] },
  ],
  'admission-self-tests': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/clued-work-admission.test.mjs',
    'scripts/ci/merge-admission-policy.test.mjs', 'scripts/ci/merge-admission-policy-file.test.mjs',
    'scripts/ci/clued-release-grant.test.mjs', 'scripts/runner/clued-runner-job-started.test.mjs',
    'scripts/ci/clued-merge-slot-ci.test.mjs'] }],
  'selection': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/ci-required-selection.test.mjs'] }],
  'clued-cloud': [
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'lint'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'ledger:verify'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'typecheck'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'build'] },
    { cwd: 'apps/clued-cloud', argv: ['node', 'scripts/run-tests.mjs', '--test', '{unit-tests}'] },
    { cwd: 'apps/clued-cloud', argv: ['node', 'scripts/run-tests.mjs', '--test', '{unit-quarantine}'],
      quarantine: 'unit test files that already fail on main (UNIT_QUARANTINE)' },
  ],
  'production-schema': [
    { cwd: 'apps/clued-cloud', argv: ['node', '--test', 'tests/production-schema-drift.test.mjs'] },
    { cwd: 'apps/clued-cloud', argv: ['node', 'scripts/production-schema-drift.mjs', 'check', '--report', '{report}'] },
  ],
};

// Suites that already fail on main run and report, but their failure does not
// fail the required check (quarantine, Task 679a0c2b). Each entry names why;
// remove it in the change that makes the suite pass.
export const QUARANTINED = {
  'admission-self-tests': '4 tests already fail on main 67893c2e: the workflow inventories in clued-merge-slot-ci.test.mjs '
    + 'and clued-work-admission.test.mjs do not list clued-native617-admission-dispatch.yml and clued-compute-panel.yml, '
    + 'and gate guard A1 rejects the gitleaks.yml pair.',
};

// Application unit test files (as scripts/select-tests.mjs classifies them)
// that already fail on main 67893c2e, observed on TURING (Windows) on
// 2026-11-01: 86 of 2960 tests in these files. They run in their own
// quarantined command, so the rest of the suite gates. The first self-hosted
// Linux run shows which of them pass there; remove those entries.
export const UNIT_QUARANTINE = {
  'tests/ci-proof-profiles.test.mjs': 'registered workflow definitions and the request-budget fixture no longer match main',
  'tests/production-publisher-source.test.mjs': 'imports merge-admission natural-frame and source-producer tests that fail on main',
  'tests/ci-temporary-storage.test.mjs': 'clued-native617-admission-dispatch.yml and the handover qualification workflows lack reviewed temporary-data entries',
  'tests/integration-runtime-gate-evidence.test.mjs': 'verdict and fail-closed fixtures differ from the evidence document',
  'tests/resource-center-daily-install.test.mjs': 'fails on main',
  'tests/resource-center-storage-read-pdf-bounds.test.mjs': 'child process URL scheme on Windows (ERR_UNSUPPORTED_ESM_URL_SCHEME); expected to pass on Linux',
};

export function unitTestFiles(cwd, spawn = spawnSync) {
  const result = spawn('node', ['scripts/select-tests.mjs', 'unit', '--list'], { cwd, encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error('select-tests --list failed');
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (char === '*') source += '[^/]*';
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const matchesAny = (file, patterns) => patterns.some((pattern) => globToRegExp(pattern).test(file));

// files: repository paths changed, or null when they are unknown. A renamed
// file counts under both names (listPullRequestFiles returns both).
export function selectSuites(check, files) {
  const suites = SUITES[check];
  if (!suites) throw new Error(`unknown check: ${check}`);
  const ids = Object.keys(suites);
  if (files === null) return { suites: ids, reason: 'changed files unknown: every suite runs' };
  if (files.some((file) => matchesAny(file, SELECT_ALL))) {
    return { suites: ids, reason: 'the selection or a required-check workflow changed: every suite runs' };
  }
  const selected = ids.filter((id) => files.some((file) => matchesAny(file, suites[id])));
  return { suites: selected, reason: selected.length === 0 ? 'no file this check covers changed' : 'selected by changed paths' };
}

export async function listPullRequestFiles({ repository, number, token, fetchImpl = fetch }) {
  const files = [];
  for (let page = 1; page <= FILE_LIMIT / 100; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    });
    if (!response.ok) return null;
    const batch = await response.json();
    if (!Array.isArray(batch)) return null;
    for (const entry of batch) {
      if (typeof entry?.filename !== 'string') return null;
      files.push(entry.filename);
      if (typeof entry.previous_filename === 'string') files.push(entry.previous_filename);
    }
    if (batch.length < 100) return files;
  }
  return null; // at GitHub's listing limit: the list may be incomplete
}

export async function changedFiles({ event, env, fetchImpl = fetch }) {
  const number = event?.pull_request?.number;
  if (!Number.isInteger(number) || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return null;
  try {
    return await listPullRequestFiles({ repository: env.GITHUB_REPOSITORY, number, token: env.GITHUB_TOKEN, fetchImpl });
  } catch {
    return null;
  }
}

export function outputLines(check, selection) {
  return [
    `suites=${JSON.stringify(selection.suites)}`,
    ...Object.keys(SUITES[check]).map((id) => `run_${id.replace(/-/g, '_')}=${selection.suites.includes(id)}`),
  ];
}

export function expandArgv(argv, { cwd, base, report, listUnit = () => unitTestFiles(cwd) }) {
  return argv.flatMap((arg) => {
    if (arg === '{unit-tests}') return listUnit().filter((file) => !UNIT_QUARANTINE[file]);
    if (arg === '{unit-quarantine}') {
      const files = new Set(listUnit());
      return Object.keys(UNIT_QUARANTINE).filter((file) => files.has(file));
    }
    const tests = /^\{tests:(.+)\}$/.exec(arg);
    if (tests) {
      return readdirSync(path.join(cwd, tests[1])).filter((name) => name.endsWith('.test.mjs')).sort()
        .map((name) => `${tests[1]}/${name}`);
    }
    if (arg === '{base}') {
      if (!base) throw new Error('CI_BASE_SHA is required for this suite');
      return [base];
    }
    if (arg === '{report}') return [report];
    return [arg];
  });
}

export function runSuite(id, { root, env = process.env, spawn = spawnSync, log = console.log } = {}) {
  const commands = SUITE_COMMANDS[id];
  if (!commands) throw new Error(`unknown suite: ${id}`);
  const report = path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-report.json`);
  for (const command of commands) {
    const cwd = path.join(root, command.cwd);
    const argv = expandArgv(command.argv, { cwd, base: env.CI_BASE_SHA, report });
    log(`::group::${id}: (${command.cwd}) ${argv.join(' ')}`);
    const result = spawn(argv[0], argv.slice(1), { cwd, env, stdio: command.quiet ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    if (command.quiet && result.stdout) {
      // The runner budget report is long; print its head on success, all of it on failure.
      const text = result.stdout.toString();
      log(result.status === 0 ? `${text.split('\n').slice(0, 4).join('\n')}\n...` : text);
    }
    log('::endgroup::');
    const failure = result.error ? `${argv[0]} did not start: ${result.error.message}`
      : result.status !== 0 ? `${argv.join(' ')} exited ${result.status ?? result.signal}` : null;
    if (failure) {
      if (command.quarantine) {
        log(`::warning title=${id} (quarantined)::${failure}. Quarantined: ${command.quarantine}`);
        continue;
      }
      if (QUARANTINED[id]) {
        log(`::warning title=${id} (quarantined)::${failure}. Quarantined: ${QUARANTINED[id]}`);
        return 0;
      }
      log(`${id}: ${failure}`);
      return result.status || 1;
    }
  }
  return 0;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(argv, env = process.env) {
  const runIndex = argv.indexOf('--run');
  if (runIndex >= 0) {
    const rootIndex = argv.indexOf('--root');
    return runSuite(argv[runIndex + 1], { root: rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : ROOT, env });
  }
  const index = argv.indexOf('--check');
  const check = index >= 0 ? argv[index + 1] : undefined;
  if (!SUITES[check]) {
    console.error('usage: node scripts/ci/ci-required-selection.mjs --check <ci-suites|clued-cloud-tests|migration-verify> | --run <suite> [--root <checkout>]');
    return 2;
  }
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const files = env.GITHUB_EVENT_NAME === 'pull_request' ? await changedFiles({ event, env }) : null;
  const selection = selectSuites(check, files);
  console.log(`${check}: ${selection.reason}; suites: ${selection.suites.join(', ') || 'none'}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${outputLines(check, selection).join('\n')}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${check}\n\n${selection.reason}.\n\nSuites: ${selection.suites.map((id) => `\`${id}\``).join(', ') || 'none (not affected)'}\n`);
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`ci-required-selection: ${error.message}`);
    process.exitCode = 1;
  }
}
