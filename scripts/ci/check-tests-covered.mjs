#!/usr/bin/env node
// Every test file in the repository runs in a required suite or is listed in ci-uncovered-tests.json, with why
// (FABLE-tests-outside-required-suites-20261121 §2; Clued Task 700f2b68). A test no required check runs goes red
// unnoticed: the Connect release tests, the fleet publishing tools and the database tests each did.
//
//   node scripts/ci/check-tests-covered.mjs [--root <checkout>] [--base <main commit>]
//
// A test file is a tracked *.test.{mjs,js,cjs,ts}, test_*.py, *_test.py, test-*.ps1 or *.Tests.ps1, wherever it is
// (FABLE-defect-remediation-plan-20261124 §3.6: the whole checkout by file name). It runs when a suite command takes it:
// each command of SUITE_COMMANDS expanded by the selection's own expandArgv and read by its filterCommand (the
// files --run-files would run), or when a file that runs imports it with a top-level static import. Fails on:
//   - a test file that does not run and is not listed;
//   - a listed file that runs, no longer exists, or is no test file and no runner file (below); a listed pattern
//     that matches none of them, or matches a file that runs: remove or narrow the entry;
//   - an entry without a known kind, a reason of 20 characters or a Clued Task id; a pattern of any kind but
//     archive; an other-workflow entry whose workflow file is missing, has no pull_request trigger or does not
//     name the test;
//   - a file that imports a test runner (node:test, or a Python unittest TestCase) under a name that is no test
//     file name, when no test file imports it and no suite runs it: rename it, or list it;
//   - growth against the base (--base, else CI_BASE_SHA, else the newest origin/main commit HEAD contains), read from
//     git: an entry of ci-uncovered-tests.json the base does not list, once the base's table has SHRINKING_SCHEMA; an
//     entry of ci-known-failures.json (suite, file, test path and fingerprint) the base does not list; a file an archive
//     pattern matches that the base does not have (an archive is sealed: no new test hides under it, whatever the
//     base's schema); a base it cannot read. Both lists only shrink: a file leaves the table when a suite runs it, a
//     failure leaves when it is fixed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_SCRIPT_TEST_DIRS, SUITE_COMMANDS, expandArgv, filterCommand, globToRegExp, knownKey } from './ci-required-selection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '../..');
export const TABLE_PATH = 'scripts/ci/ci-uncovered-tests.json';
export const KNOWN_PATH = 'scripts/ci/ci-known-failures.json';
// A table of this schema only shrinks against the base: the change that brought the rule listed the gaps of its day.
export const SHRINKING_SCHEMA = 'clued.ci-uncovered-tests/2';
export const KINDS = ['environment', 'stale-or-suspect', 'other-workflow', 'unsorted', 'archive'];
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE_SOURCE = /\.(?:mjs|js|cjs|ts)$/;

export const isTestFile = (file) => /\.test\.(?:mjs|js|cjs|ts)$/.test(file) || /(?:^|\/)test_[^/]*\.py$/.test(file) || /_test\.py$/.test(file) ||
  /(?:^|\/)test-[^/]*\.ps1$/.test(file) || /\.Tests\.ps1$/.test(file);

export function trackedFiles(root) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
}

const readOr = (root, file) => {
  try {
    return readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
};
const resolve = (from, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));

// Coverage by import counts a top-level static import declaration only: a line that starts with `import` outside
// block comments and template strings. An import in a comment, a string or a function body is no coverage, nor a
// TypeScript `import type`, which is erased before the module runs.
export const topLevelImports = (source) => [...source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
  .matchAll(/^import\s+(?!type\s+(?:[{*]|[\w$]+\s+from\b))(?:[^'";]*?\bfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/gm)].map((match) => match[1]);
// Any relative module a file reaches: static, dynamic, export-from, side-effect and require.
const relativeSpecifiers = (source) => [...source.matchAll(
  /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
  .map((match) => match[1] ?? match[2] ?? match[3]).filter((spec) => spec.startsWith('./') || spec.startsWith('../'));
const RUNNER = 'node:' + 'test';
const importsRunner = (file, source) => (NODE_SOURCE.test(file)
  ? [...source.matchAll(/\b(?:from\s*|import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/g)].some((match) => match[1] === RUNNER)
  : file.endsWith('.py') && /^\s*class \w+\((?:unittest\.)?(?:Isolated)?(?:Async)?TestCase\)/m.test(source));

// file -> the suites whose commands take it (filterCommand's matched files, as --run-files would run them).
export function suiteFiles(root, { commands = SUITE_COMMANDS, tracked, listUnit } = {}) {
  const named = new Set(tracked);
  const runs = new Map();
  const collects = [];
  for (const [id, list] of Object.entries(commands)) {
    for (const command of list) {
      const cwd = path.join(root, command.cwd);
      const argv = expandArgv(command.argv, { cwd, root, base: 'base', report: 'report', ...(listUnit ? { listUnit: () => listUnit(cwd) } : {}) });
      for (const file of filterCommand(command, argv, named).matched) runs.set(file, [...(runs.get(file) ?? []), id]);
      // Where a new file is taken without editing the command: {tests:<dir>}, {ci-script-tests} and unittest discover.
      for (const arg of command.argv) {
        const dir = /^\{tests:(.+)\}$/.exec(arg)?.[1];
        if (dir) collects.push(`${path.posix.join(command.cwd, dir)}/*.test.mjs -> ${id}`);
        if (arg === '{ci-script-tests}') collects.push(...CI_SCRIPT_TEST_DIRS.map((ci) => `${ci}/*.test.mjs -> ${id}`));
      }
      const discover = command.argv.indexOf('discover');
      if (discover > 0 && command.argv[discover - 1] === 'unittest') {
        const at = (flag) => command.argv[command.argv.indexOf(flag) + 1];
        collects.push(`${path.posix.join(command.cwd, at('-s'))}/${at('-p') ?? 'test*.py'} -> ${id}`);
      }
    }
  }
  return { runs, collects };
}

// Test files that run: those a command takes, and the test files they import at top level, transitively. Each maps to
// the file a command takes that brings it in: itself, or the running test that imports it.
function runningTests(bySuite, trackedSet, source) {
  const direct = [...bySuite.keys()].filter(isTestFile);
  const runs = new Map(direct.map((file) => [file, file]));
  const pending = [...direct];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!NODE_SOURCE.test(file)) continue;
    for (const target of topLevelImports(source(file)).map((spec) => resolve(file, spec))) {
      if (!isTestFile(target) || !trackedSet.has(target) || runs.has(target)) continue;
      runs.set(target, runs.get(file));
      pending.push(target);
    }
  }
  return runs;
}

// Where each of files runs, read as the check reads it, for files --run-files refused (ci-required-selection.mjs): the
// suites and the file a suite command takes (the file itself, or the running test that imports it); null for none.
export function whereTestsRun(root, files, { tracked = trackedFiles(root), read = (file) => readOr(root, file) } = {}) {
  const { runs: bySuite } = suiteFiles(root, { tracked });
  const runs = runningTests(bySuite, new Set(tracked), read);
  return new Map(files.map((file) => {
    const through = runs.get(file) ?? (bySuite.has(file) ? file : null);
    return [file, through ? { suites: [...new Set(bySuite.get(through))], through } : null];
  }));
}

export function readTable(root) {
  const text = readOr(root, TABLE_PATH);
  if (text === null) return { tests: [] };
  return JSON.parse(text);
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });

// The main commit the lists are measured against: --base, CI_BASE_SHA (the required checks' base), else the newest
// origin/main commit HEAD contains (a pull request's merge commit contains its base; the required checks fetch all).
export function resolveBase(root, explicit, env = process.env) {
  for (const value of [explicit, env.CI_BASE_SHA]) if (value && !/^0+$/.test(value)) return value;
  try {
    return git(root, ['merge-base', 'HEAD', 'refs/remotes/origin/main']).trim();
  } catch {
    return null;
  }
}

// Both lists as the base holds them, parsed (a list the base does not have is null), and the files it tracks. Throws
// when the base cannot be read.
export function readBaseline(root, base) {
  if (!base) throw new Error('no base: pass --base <main commit>, set CI_BASE_SHA or fetch origin/main');
  try {
    git(root, ['cat-file', '-e', `${base}^{commit}`]);
  } catch {
    throw new Error('no such commit in this checkout; fetch main first');
  }
  const at = (file) => {
    try {
      return JSON.parse(git(root, ['show', `${base}:${file}`]));
    } catch (error) {
      if (/does not exist|exists on disk, but not in/.test(String(error.stderr))) return null;
      throw error;
    }
  };
  const files = git(root, ['ls-tree', '-r', '--name-only', '-z', base]).split(' ').filter(Boolean);
  return { base, table: at(TABLE_PATH), known: at(KNOWN_PATH), files };
}

function readKnown(read) {
  const text = read(KNOWN_PATH);
  return text === null ? {} : JSON.parse(text);
}

// Entries the base does not have: the uncovered table once its base has the rule, and the known failures always.
function growth(table, known, baseline) {
  const problems = [];
  const at = `the base (${baseline.base})`;
  if (baseline.table?.schema === SHRINKING_SCHEMA) {
    if (table?.schema !== SHRINKING_SCHEMA) problems.push(`${TABLE_PATH}: schema must stay ${SHRINKING_SCHEMA}, as at ${at}: the list only shrinks`);
    const listed = new Set((Array.isArray(baseline.table.tests) ? baseline.table.tests : []).map((entry) => entry?.path));
    for (const entry of Array.isArray(table?.tests) ? table.tests : []) {
      if (typeof entry?.path === 'string' && !listed.has(entry.path)) {
        problems.push(`${entry.path}: ${at} does not list it; ${TABLE_PATH} only shrinks: make a required suite run it`);
      }
    }
  }
  const keyOf = (entry) => (typeof entry?.file === 'string' && Array.isArray(entry.path) ? knownKey(entry)
    : JSON.stringify([entry?.file, entry?.path, entry?.fingerprint]));
  for (const [suite, entries] of Object.entries(known ?? {})) {
    const listed = new Set((Array.isArray(baseline.known?.[suite]) ? baseline.known[suite] : []).map(keyOf));
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!listed.has(keyOf(entry))) problems.push(`${KNOWN_PATH}: ${suite}: ${keyOf(entry)}: ${at} does not list it; the list only shrinks: fix the test`);
    }
  }
  return problems;
}

const entryProblems = (entry) => {
  const name = typeof entry?.path === 'string' ? entry.path : JSON.stringify(entry);
  const problems = [];
  if (typeof entry?.path !== 'string' || entry.path === '') problems.push(`${name}: path must be a repository path`);
  if (!KINDS.includes(entry?.kind)) problems.push(`${name}: kind must be one of ${KINDS.join(', ')}`);
  if (!(typeof entry?.reason === 'string' && [...entry.reason.trim()].length >= 20)) problems.push(`${name}: reason of at least 20 characters`);
  if (!(typeof entry?.task === 'string' && TASK_ID.test(entry.task))) problems.push(`${name}: task must be a Clued Task id`);
  if (typeof entry?.path === 'string' && entry.path.includes('*') && entry.kind !== 'archive') {
    problems.push(`${name}: only an archive entry may be a pattern; list ${entry.kind} files one by one`);
  }
  if (entry?.kind === 'other-workflow' && !(typeof entry.workflow === 'string' && /^[\w.-]+\.ya?ml$/.test(entry.workflow))) {
    problems.push(`${name}: an other-workflow entry names its workflow file (.github/workflows/<name>.yml)`);
  }
  return problems;
};

const PULL_REQUEST_TRIGGER = /^\s*(?:-\s*)?pull_request\s*:?\s*$|^on:.*\bpull_request\b(?!_)/m;

// The whole verdict; inputs are injectable so the test can add files that do not exist.
// baseline ({ base, table, known, files }: the lists at the base and the files it tracks) defaults to readBaseline at
// resolveBase(root, base); a baseline without files has none, so every file an archive pattern matches is new.
export function coverage({ root = DEFAULT_ROOT, tracked = trackedFiles(root), read = (file) => readOr(root, file),
  table = readTable(root), known = readKnown(read), base, baseline, commands = SUITE_COMMANDS, listUnit } = {}) {
  const trackedSet = new Set(tracked);
  const tests = tracked.filter(isTestFile);
  const { runs: bySuite, collects } = suiteFiles(root, { commands, tracked, listUnit });
  const sources = new Map();
  const source = (file) => {
    if (!sources.has(file)) sources.set(file, read(file) ?? '');
    return sources.get(file);
  };
  const runs = runningTests(bySuite, trackedSet, source);
  // Runner files under another name are helpers when a test file or a suite-run file reaches them.
  const reached = new Set();
  const walk = [...tests, ...bySuite.keys()].filter((file) => NODE_SOURCE.test(file));
  while (walk.length > 0) {
    const file = walk.pop();
    for (const target of relativeSpecifiers(source(file)).map((spec) => resolve(file, spec))) {
      if (!trackedSet.has(target) || reached.has(target)) continue;
      reached.add(target);
      if (NODE_SOURCE.test(target)) walk.push(target);
    }
  }
  const misnamed = tracked.filter((file) => !isTestFile(file) && (NODE_SOURCE.test(file) || file.endsWith('.py')) &&
    !bySuite.has(file) && !reached.has(file) && importsRunner(file, source(file)));

  const problems = [];
  if (baseline === undefined) {
    const at = resolveBase(root, base);
    try {
      baseline = readBaseline(root, at);
    } catch (error) {
      problems.push(`${TABLE_PATH}, ${KNOWN_PATH}: cannot read the base${at ? ` ${at}` : ''}: ${error.message}`);
    }
  }
  if (baseline) problems.push(...growth(table, known, baseline));
  const baseFiles = baseline ? new Set(Array.isArray(baseline.files) ? baseline.files : []) : null;
  const entries = Array.isArray(table?.tests) ? table.tests : [];
  if (!Array.isArray(table?.tests)) problems.push(`${TABLE_PATH}: "tests" must be a list of entries`);
  const seen = new Set();
  const exempt = new Map();
  const subjects = new Set([...tests, ...misnamed]);
  const kinds = {};
  for (const entry of entries) {
    const own = entryProblems(entry);
    problems.push(...own);
    if (typeof entry?.path !== 'string') continue;
    if (seen.has(entry.path)) problems.push(`${entry.path}: listed twice`);
    seen.add(entry.path);
    const pattern = entry.path.includes('*') ? globToRegExp(entry.path) : null;
    const matches = pattern ? [...new Set([...subjects, ...runs.keys()])].filter((file) => pattern.test(file)) : [entry.path];
    const running = matches.filter((file) => runs.has(file) || bySuite.has(file));
    if (running.length > 0) {
      problems.push(`${entry.path}: ${pattern ? `matches ${running.join(', ')}, which runs` : 'runs'} in a required suite (${[...new Set(running.flatMap((file) => bySuite.get(file) ?? ['imported by a test that runs']))].join(', ')}); ${pattern ? 'narrow' : 'remove'} the entry`);
      continue;
    }
    if (pattern && matches.length === 0) problems.push(`${entry.path}: matches no test file; remove the entry`);
    if (!pattern && !trackedSet.has(entry.path)) problems.push(`${entry.path}: no such tracked file; remove the entry`);
    else if (!pattern && !subjects.has(entry.path)) problems.push(`${entry.path}: neither a test file nor a file that imports a test runner; remove the entry`);
    if (entry.kind === 'other-workflow' && typeof entry.workflow === 'string' && own.length === 0) {
      const text = read(`.github/workflows/${entry.workflow}`);
      if (text === null) problems.push(`${entry.path}: workflow .github/workflows/${entry.workflow} does not exist`);
      else {
        if (!PULL_REQUEST_TRIGGER.test(text)) problems.push(`${entry.path}: workflow ${entry.workflow} has no pull_request trigger`);
        const names = [path.posix.basename(entry.path), entry.path.replace(/\.py$/, '').replaceAll('/', '.')];
        if (!names.some((name) => text.includes(name))) problems.push(`${entry.path}: workflow ${entry.workflow} does not name this test`);
      }
    }
    if (pattern && baseFiles) {
      for (const file of matches.filter((match) => !baseFiles.has(match))) {
        problems.push(`${file}: the base (${baseline.base}) does not have it; the archive ${entry.path} is sealed and takes no new test: make a required suite run it`);
      }
    }
    for (const file of matches) exempt.set(file, entry);
    kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  }
  const uncovered = tests.filter((file) => !runs.has(file) && !exempt.has(file));
  for (const file of uncovered) {
    const dir = path.posix.dirname(file);
    const siblings = [...new Set(tests.filter((other) => path.posix.dirname(other) === dir && bySuite.has(other)).flatMap((other) => bySuite.get(other)))];
    const hint = file.endsWith('.ps1') ? ' (no suite command takes a PowerShell file yet: ci-required-selection.mjs must learn one first)'
      : siblings.length ? ` (other tests of ${dir} run in ${siblings.join(', ')}: add it to that command)` : '';
    problems.push(`${file}: no required suite runs it and ${TABLE_PATH} does not list it${hint}`);
  }
  for (const file of misnamed.filter((candidate) => !exempt.has(candidate))) {
    problems.push(`${file}: imports a test runner but is not named as a test file and no test imports it: rename it (*.test.mjs, test_*.py) or list it`);
  }
  return {
    problems, collects, kinds,
    counts: { tests: tests.length, runs: tests.filter((file) => runs.has(file)).length, exempt: tests.filter((file) => exempt.has(file)).length, misnamed: misnamed.length },
  };
}

if (import.meta.main) {
  const option = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
  const root = option('--root') ? path.resolve(option('--root')) : DEFAULT_ROOT;
  const result = coverage({ root, base: option('--base') });
  if (result.problems.length > 0) {
    console.error(`TESTS_NOT_COVERED: ${result.problems.length} problem(s)\n${result.problems.join('\n')}`);
    console.error(`\nA file in one of these is taken without editing the command:\n${result.collects.join('\n')}`);
    console.error(`Otherwise list it in a suite command (scripts/ci/ci-required-selection.mjs). ${TABLE_PATH} and ${KNOWN_PATH} only shrink.`);
    process.exitCode = 1;
  } else {
    const { tests, runs, exempt, misnamed } = result.counts;
    console.log(`tests covered: ${tests} test files, ${runs} run in a required suite, ${exempt} listed in ${TABLE_PATH}` +
      ` (${Object.entries(result.kinds).map(([kind, n]) => `${kind} ${n}`).join(', ')}); ${misnamed} runner files under another name, all listed`);
  }
}
