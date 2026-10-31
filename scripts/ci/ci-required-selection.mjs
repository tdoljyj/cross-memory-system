// Which test suites a change needs, and what each suite runs (Task 2a5fdb66;
// design in work/ci-required-tests-v1/DESIGN.md).
//
// The required checks ci-suites, clued-cloud-tests and migration-verify
// (.github/workflows/clued-required-tests.yml) always report, so they can sit
// in the main ruleset; this file decides what each one runs. The workflow
// runs it from the pull request's trusted base checkout, so a pull request
// cannot narrow its own selection, swap a suite's command line or extend the
// known-failure list (ci-known-failures.json, read next to this file). The
// commands themselves run the candidate's code and tests: that code is
// reviewed through the protected-path rules, not through this file. The
// candidate's own changes to the selection (this file, the workflow) select
// every suite.
//
//   node scripts/ci/ci-required-selection.mjs --check <ci-suites|clued-cloud-tests|migration-verify>
//     reads GITHUB_EVENT_PATH and lists the pull request's files through the
//     API (GITHUB_TOKEN, pull-requests: read); a push, a listing it cannot
//     read or a listing at GitHub's 3000-file limit selects everything.
//     Writes suites=<json> and run_<suite>=true|false to GITHUB_OUTPUT.
//   node scripts/ci/ci-required-selection.mjs --run <suite> [--root <checkout>]
//     runs one suite's commands (SUITE_COMMANDS) in the checkout at --root.
//   node scripts/ci/ci-required-selection.mjs --write-known <suite> [--keep] [--root <checkout>]
//     regenerates that suite's ci-known-failures.json entries from a real run
//     (--keep also keeps the entries already listed).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The resident layer imports Source v2, Source v2 imports scripts/ci (and
// through it scripts/runner) and the resident's node profile, the admission
// self-tests reach Source v2 through scripts/ci, and both read the gitleaks
// configuration; a change to any of them runs all of these suites
// (ci-required-selection.test.mjs checks the transitive imports of each).
const RESIDENT_AND_SOURCE = ['work/independent-ci-resident-v1/**', 'work/actions-hosted-migration/independent-ci-v1/**',
  'scripts/ci/**', 'scripts/runner/**', 'config/merge-admission-policy.json', '.gitleaks.toml'];

// suite id -> path patterns ("**" any depth, "*" within a segment).
export const SUITES = {
  'ci-suites': {
    'resident-node': RESIDENT_AND_SOURCE,
    'resident-python': RESIDENT_AND_SOURCE,
    'offline-drill': RESIDENT_AND_SOURCE,
    'source-v2-node': RESIDENT_AND_SOURCE,
    'source-v2-python': RESIDENT_AND_SOURCE,
    'components': ['scripts/clued_components.py', 'scripts/hooks/**', 'skills/**', 'integrations/**',
      'config/clued-components.json', 'tests/test_clued_components.py', 'tests/test_clued_version_check.py',
      'VERSION', '.claude/settings.json'],
    'runner-budget-policy': ['.github/workflows/**', 'scripts/ci/validate_runner_budget_policy.py',
      'scripts/ci/test_validate_runner_budget_policy.py'],
    'admission-self-tests': [...RESIDENT_AND_SOURCE, '.github/workflows/**'],
    'selection': ['scripts/ci/ci-required-selection.mjs', 'scripts/ci/ci-required-selection.test.mjs', 'scripts/ci/ci-test-failures-reporter.mjs',
      'scripts/ci/ci-known-failures.json'],
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

// Changing how selection or the required-check workflow works selects every
// suite of every check.
export const SELECT_ALL = ['scripts/ci/ci-required-selection.mjs', 'scripts/ci/ci-known-failures.json', 'scripts/ci/ci-test-failures-reporter.mjs',
  '.github/workflows/clued-required-tests.yml', '.github/actions/**'];

export const FILE_LIMIT = 3000;

// What each suite runs; cwd is relative to the checkout root. Source v2 tests
// resolve paths from the root, so they run there. {tests:<dir>} expands to the
// sorted *.test.mjs files directly in <dir> (relative to cwd), {unit-tests}
// to the application's unit test files (scripts/select-tests.mjs), {base} to
// the base commit (CI_BASE_SHA), {report} to a file under RUNNER_TEMP. A
// command with `known` runs Node's test runner with ci-test-failures-reporter.mjs
// and passes only when every failure is an entry of ci-known-failures.json
// under that key (knownFailureVerdict).
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
  'admission-self-tests': [{ cwd: '.', known: 'admission-self-tests', argv: ['node', '--test',
    'scripts/ci/clued-work-admission.test.mjs', 'scripts/ci/merge-admission-policy.test.mjs',
    'scripts/ci/merge-admission-policy-file.test.mjs', 'scripts/ci/clued-release-grant.test.mjs',
    'scripts/runner/clued-runner-job-started.test.mjs', 'scripts/ci/clued-merge-slot-ci.test.mjs'] }],
  'selection': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/ci-required-selection.test.mjs'] }],
  'clued-cloud': [
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'lint'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'ledger:verify'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'typecheck'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'build'] },
    { cwd: 'apps/clued-cloud', known: 'clued-cloud', argv: ['node', 'scripts/run-tests.mjs', '--test', '{unit-tests}'] },
  ],
  'production-schema': [
    { cwd: 'apps/clued-cloud', argv: ['node', '--test', 'tests/production-schema-drift.test.mjs'] },
    { cwd: 'apps/clued-cloud', argv: ['node', 'scripts/production-schema-drift.mjs', 'check', '--report', '{report}'] },
  ],
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KNOWN_FAILURES_PATH = path.join(HERE, 'ci-known-failures.json');
export const REPORTER_PATH = path.join(HERE, 'ci-test-failures-reporter.mjs');

// Tests that already fail on main (quarantine, Task 679a0c2b), by suite: each
// entry names the test file (relative to the checkout), the test's full path
// of names (describe and parent tests first) and the fingerprint of why it
// fails (ci-test-failures-reporter.mjs), with a reason. They still run. A
// failure that matches no entry exactly fails the suite, so the same test
// failing for a new reason is a new failure; a listed test that passes, or
// no longer exists, is reported so its entry can be removed.
export const knownKey = ({ file, path: names, fingerprint }) => `${file} :: ${names.join(' > ')} :: ${fingerprint}`;

export function readKnownFailures(file = KNOWN_FAILURES_PATH) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const [suite, entries] of Object.entries(data)) {
    if (!Array.isArray(entries)) throw new Error(`known failures of ${suite} must be a list`);
    for (const entry of entries) {
      if (typeof entry?.file !== 'string' || !Array.isArray(entry.path) || entry.path.length === 0 ||
          !/^[0-9a-f]{16}$/.test(entry.fingerprint ?? '') || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
        throw new Error(`known failure entry invalid or without a reason: ${suite}: ${JSON.stringify(entry)}`);
      }
    }
  }
  return data;
}

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
    return { suites: ids, reason: 'the selection or the required-check workflow changed: every suite runs' };
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
    if (arg === '{unit-tests}') {
      const files = listUnit();
      // An empty list would make `node --test` run every file it finds.
      if (files.length === 0) throw new Error('no unit test files');
      return files;
    }
    const tests = /^\{tests:(.+)\}$/.exec(arg);
    if (tests) {
      const files = readdirSync(path.join(cwd, tests[1])).filter((name) => name.endsWith('.test.mjs')).sort()
        .map((name) => `${tests[1]}/${name}`);
      if (files.length === 0) throw new Error(`no test files in ${tests[1]}`);
      return files;
    }
    if (arg === '{base}') {
      if (!base || /^0+$/.test(base)) throw new Error('CI_BASE_SHA is required for this suite');
      return [base];
    }
    if (arg === '{report}') return [report];
    return [arg];
  });
}

const real = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

// Reads the reporter's JSON lines (ci-test-failures-reporter.mjs). Files are
// made relative to the checkout root with forward slashes, both sides resolved
// to real paths (Node reports a test file's real path; a runner directory may
// sit behind a link), so entries match on any runner.
export function readReport(text, root) {
  const events = [];
  const base = root ? real(root) : null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { events, summary: null, corrupt: true };
    }
    if (typeof event.file === 'string' && base) {
      event.file = path.relative(base, real(event.file)).split(path.sep).join('/');
    }
    events.push(event);
  }
  return { events, summary: events.find((event) => event.type === 'summary') ?? null, corrupt: false };
}

// The verdict of a run with known failures. It fails on: any failure that is
// not exactly a known entry; an exit other than 0 or 1 (a signal, a timeout,
// a crash of the runner); a report without the run's summary (the runner did
// not finish); or a nonzero exit with no failure in the report.
export function knownFailureVerdict({ status, report, known }) {
  const keys = new Map(known.map((entry) => [knownKey(entry), entry]));
  const failures = report.events.filter((event) => event.type === 'fail');
  const unexpected = failures.filter((event) => !keys.has(knownKey(event)));
  const expected = failures.filter((event) => keys.has(knownKey(event)));
  const where = (entry) => `${entry.file} :: ${entry.path.join(' > ')}`;
  const failedAt = new Set(failures.map(where));
  const passedAt = new Set(report.events.filter((event) => event.type === 'pass').map(where));
  const fixed = known.filter((entry) => passedAt.has(where(entry)) && !failedAt.has(where(entry)));
  const missing = known.filter((entry) => !passedAt.has(where(entry)) && !failedAt.has(where(entry)));
  const problems = [];
  if (report.corrupt) problems.push('the test report is not readable');
  if (!report.summary) problems.push('the test run did not finish (no summary in the report)');
  if (status !== 0 && status !== 1) problems.push(`the test runner exited ${status}`);
  if (status === 1 && failures.length === 0) problems.push('the test runner failed without a failing test in the report');
  if (status === 0 && failures.length > 0) problems.push('the report has failures but the runner exited 0');
  return { ok: problems.length === 0 && unexpected.length === 0, problems, unexpected, expected, fixed, missing };
}

export function runSuite(id, { root, env = process.env, spawn = spawnSync, log = console.log,
  known = null, readReportFile = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '') } = {}) {
  const commands = SUITE_COMMANDS[id];
  if (!commands) throw new Error(`unknown suite: ${id}`);
  const report = path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-report.json`);
  for (const command of commands) {
    const cwd = path.join(root, command.cwd);
    let argv = expandArgv(command.argv, { cwd, base: env.CI_BASE_SHA, report });
    let reportDir = null;
    if (command.known) {
      reportDir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-tests-`));
      const index = argv.indexOf('--test');
      // The reporter comes from this file's (trusted base) checkout.
      argv = [...argv.slice(0, index + 1), '--test-reporter=spec', '--test-reporter-destination=stdout',
        `--test-reporter=${pathToFileURL(REPORTER_PATH).href}`, `--test-reporter-destination=${path.join(reportDir, 'failures.jsonl')}`,
        ...argv.slice(index + 1)];
    }
    log(`::group::${id}: (${command.cwd}) ${argv.join(' ')}`);
    const result = spawn(argv[0], argv.slice(1), { cwd, env, stdio: command.quiet ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    if (command.quiet && result.stdout) {
      // The runner budget report is long; print its head on success, all of it on failure.
      const text = result.stdout.toString();
      log(result.status === 0 ? `${text.split('\n').slice(0, 4).join('\n')}\n...` : text);
    }
    log('::endgroup::');
    if (result.error) {
      log(`${id}: ${argv[0]} did not start: ${result.error.message}`);
      return 1;
    }
    if (command.known) {
      const list = (known ?? readKnownFailures())[command.known] ?? [];
      const text = readReportFile(path.join(reportDir, 'failures.jsonl'));
      rmSync(reportDir, { recursive: true, force: true });
      const status = result.signal ? 128 : result.status;
      const verdict = knownFailureVerdict({ status, report: readReport(text, root), known: list });
      const label = (entry) => `${entry.file} :: ${entry.path.join(' > ')}`;
      for (const entry of verdict.expected) log(`::warning title=${id} known failure::${label(entry)}`);
      for (const entry of verdict.fixed) log(`::warning title=${id} known failure now passes::${label(entry)}; remove it from ci-known-failures.json`);
      for (const entry of verdict.missing) log(`::warning title=${id} known failure no longer runs::${label(entry)}; remove it from ci-known-failures.json`);
      for (const entry of verdict.unexpected) {
        log(`::error title=${id} new failure::${label(entry)} (${entry.failure_type ?? 'failure'}, fingerprint ${entry.fingerprint})`);
      }
      for (const problem of verdict.problems) log(`::error title=${id}::${problem}`);
      if (!verdict.ok) {
        log(`${id}: ${verdict.unexpected.length} failure(s) not on the known-failure list${verdict.problems.length ? `; ${verdict.problems.join('; ')}` : ''}`);
        return status || 1;
      }
      continue;
    }
    if (result.status !== 0) {
      log(`${id}: ${argv.join(' ')} exited ${result.status ?? result.signal}`);
      return result.status || 1;
    }
  }
  return 0;
}

const ROOT = path.resolve(HERE, '..', '..');

// The known-failure entries of one run: every failure in the report, keeping
// the reason of an entry already listed for the same file and path. A new
// entry gets no reason, so readKnownFailures refuses the list until a person
// writes one.
// A reason carries over only to the same failure (same fingerprint): a known
// test now failing for another reason needs its reason written again. With
// keep, the previous entries stay as well, so a pull request can list the
// failure a coming change will produce (a count or list a test pins) before
// that change lands; the known-failure list is read from the trusted base.
export function knownEntriesFromReport(report, previous = [], { keep = false } = {}) {
  const reasons = new Map(previous.map((entry) => [knownKey(entry), entry.reason]));
  const entries = new Map(keep ? previous.map((entry) => [knownKey(entry), entry]) : []);
  for (const event of report.events.filter((candidate) => candidate.type === 'fail')) {
    const entry = { file: event.file, path: event.path, fingerprint: event.fingerprint, reason: reasons.get(knownKey(event)) ?? '' };
    entries.set(knownKey(entry), entry);
  }
  return [...entries.values()].sort((a, b) => knownKey(a).localeCompare(knownKey(b)));
}

// --write-known <suite>: run that suite's known-failure command in the checkout
// and rewrite its entries in ci-known-failures.json from the run.
function writeKnown(id, root, env, keep = false) {
  const command = SUITE_COMMANDS[id]?.find((candidate) => candidate.known);
  if (!command) throw new Error(`suite ${id} has no known-failure command`);
  const cwd = path.join(root, command.cwd);
  const argv = expandArgv(command.argv, { cwd, base: env.CI_BASE_SHA, report: '' });
  const dir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-known-`));
  const out = path.join(dir, 'failures.jsonl');
  const index = argv.indexOf('--test');
  spawnSync(argv[0], [...argv.slice(1, index + 1), `--test-reporter=${pathToFileURL(REPORTER_PATH).href}`,
    `--test-reporter-destination=${out}`, ...argv.slice(index + 1)], { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const report = readReport(existsSync(out) ? readFileSync(out, 'utf8') : '', root);
  rmSync(dir, { recursive: true, force: true });
  if (!report.summary) throw new Error('the run did not finish; nothing written');
  const data = JSON.parse(readFileSync(KNOWN_FAILURES_PATH, 'utf8'));
  data[command.known] = knownEntriesFromReport(report, data[command.known] ?? [], { keep });
  writeFileSync(KNOWN_FAILURES_PATH, `${JSON.stringify(data, null, 2)}\n`);
  const unexplained = data[command.known].filter((entry) => !entry.reason).length;
  console.log(`${command.known}: ${data[command.known].length} entries written${unexplained ? `, ${unexplained} need a reason` : ''}`);
  return unexplained ? 1 : 0;
}

async function main(argv, env = process.env) {
  const writeIndex = argv.indexOf('--write-known');
  if (writeIndex >= 0) {
    const rootIndex = argv.indexOf('--root');
    return writeKnown(argv[writeIndex + 1], rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : ROOT, env, argv.includes('--keep'));
  }
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
