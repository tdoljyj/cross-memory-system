// What the test entry needs around the real-clock guard (test-clock-guard.mjs; Clued Task 11092b8b,
// FABLE-no-real-clock-20261122 §2, FABLE-defect-remediation-plan-20261124 §3.4). This module never installs the guard:
// the entry imports it, the suite children get the guard (clockGuardEnv).
//   clockGuardEnv   the three variables that preload the guard into a suite command and every node it starts.
//   recordVerdict   what a command's record says: the lines outside the debt list fail the command, exit code 0 or not.
//   debtVerdict     the debt list (config/test-clock-debt.txt) and the static rules:
//                   - the list only shrinks: a line the base commit's list does not have, a listed file with more hits than
//                     at the base commit, a listed file that is gone or has no hit left (remove the line) are each a problem;
//                     a listed test with no hit of its own that imports a listed file with one keeps its line (it runs
//                     that file's debt: the guard lets a listed helper through only for a listed test);
//                     the caller gives the base commit: none given is a problem (the comparison may not quietly stop),
//                     base: null says in so many words not to compare, and a base without the list (the change that
//                     brings it) is the only base not compared; the environment (CI_BASE_SHA, CI) is never read;
//                   - what has no preload is read here, in every test file the list does not name: node:test's { timeout }
//                     option, a timeout given to a promisified exec or execFile, PowerShell clock reads and waits (in a
//                     test's strings or a test script), pg_sleep, and Python's clock, sleep and timeout= (FABLE §2.5, §3.4);
//                   - the allowlist (scripts/ci/test-clock-allow.json) names a file, a kind and the exact count.
// The counts are lexical (a line that starts a comment is skipped, nothing else): the same text gives the same count, so
// the base and the change are compared on one measure. node --import scripts/ci/test-clock-scan.mjs is not how it runs: run
//   node scripts/ci/test-clock-scan.mjs --check --base <commit> [--root <checkout>]   (--base is required)
//   node scripts/ci/test-clock-scan.mjs --write-debt [--root <checkout>]              (the list as the scan finds it)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JS, importsDebt } from './test-clock-imports.mjs';

export { importsDebt };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GUARD_PATH = path.join(HERE, 'test-clock-guard.mjs');
export const DEBT_FILE = 'config/test-clock-debt.txt';
export const ALLOW_FILE = 'scripts/ci/test-clock-allow.json';
export const ALLOW_KINDS = Object.freeze(['sleep', 'elapsedMs', 'child-timeout', 'ps', 'py']);
export const RECORD_SHOWN = 20;

// Test code: what the guard treats as test code (a *.test.* file or a file under a test, tests or fixtures directory), plus
// Python and PowerShell test files.
const TEST_DIR = /(^|\/)(tests?|fixtures|evals)\//;
export function testFileKind(file) {
  const name = file.replaceAll('\\', '/');
  if (/(^|\/)node_modules\//.test(name)) return null;
  const base = path.posix.basename(name);
  if (JS.test(name)) return TEST_DIR.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name) ? 'js' : null;
  if (name.endsWith('.py')) return TEST_DIR.test(name) || /^test_.*\.py$|_test\.py$|\.test\.py$/.test(base) ? 'py' : null;
  if (/\.ps1$/i.test(name)) return TEST_DIR.test(name) || /^test-.*\.ps1$|\.tests\.ps1$/i.test(base) ? 'ps' : null;
  return null;
}

// The patterns, by kind. clock, timer and child are what the guard refuses at run time; the others have no preload and are
// enforced here. sleep and elapsedMs count the guard's allowlisted helpers.
const NODE_TEST_CALL = String.raw`\b(?:test|it|describe|suite|before|after|beforeEach|afterEach)(?:\.(?:only|skip|todo))?\s*\(`;
const LEADING_NAME = String.raw`(?:(?:'[^'\n]*'|"[^"\n]*"|\x60[^\x60]*\x60)\s*,\s*)?`;
const PS = /Get-Date\b|Start-Sleep\b|\[(?:System\.)?(?:DateTime|DateTimeOffset)\]::(?:Utc)?Now\b|\bStopwatch\b/gi;
export const PATTERNS = Object.freeze({
  js: {
    clock: [/\bDate\.now\b/g, /\bnew\s+Date\s*\(\s*\)/g, /\bnew\s+Date\b(?!\s*\()/g, /(?<![\w$.]|\bnew\s{0,9})\bDate\s*\(\s*\)/g, /\bperformance\.now\b/g,
      /\bprocess\.hrtime\b/g, /\bprocess\.uptime\b/g, /\bTemporal\.Now\b/g],
    timer: [/\bset(?:Timeout|Interval)\b/g, /\bAbortSignal\.timeout\b/g, /\bscheduler\.wait\b/g],
    child: [/\btimeout\s*:/g],
    testTimeout: [new RegExp(`${NODE_TEST_CALL}\\s*${LEADING_NAME}\\{[^{}]*?\\btimeout\\b`, 'g')],
    ps: [PS],
    sql: [/\bpg_sleep\b/gi],
    sleep: [/\bsleep\s*\(/g],
    elapsedMs: [/\belapsedMs\s*\(/g],
  },
  py: {
    py: [/\btime\.(?:time|monotonic|perf_counter|sleep)(?:_ns)?\s*\(/g, /\bdatetime\.(?:now|utcnow|today)\s*\(/g,
      /\bdate\.today\s*\(/g, /\btimeout\s*=(?!=)/g],
  },
  ps: {
    ps: [PS],
  },
});
// A file that promisifies exec or execFile: its timeout options are a child's time limit the guard sees only on the paths
// the run takes (promisedChild: the child hits of such a file, read statically on top of the guard).
const PROMISED_CHILD = /\bpromisify\s*\(\s*(?:[\w$]+\.)*exec(?:File)?\s*\)/;
// The kinds a debt-list file's hits are counted over, and the ones enforced here on files the list does not name.
// promisedChild repeats child hits, so it is not counted for the list.
export const DEBT_KINDS = Object.freeze(['clock', 'timer', 'child', 'testTimeout', 'ps', 'sql', 'py']);
export const STATIC_KINDS = Object.freeze(['testTimeout', 'promisedChild', 'ps', 'sql', 'py']);
const COMMENT_LINE = { js: /^\s*(?:\/\/|\/\*|\*)/, py: /^\s*#/, ps: /^\s*#/ };

// Hits by kind: { kind: [line, ...] } (one entry per hit).
export function scanSource(text, kind) {
  const patterns = PATTERNS[kind];
  const found = {};
  if (!patterns) return found;
  const usesGuard = text.includes('test-clock-guard');
  let block = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (kind === 'js') {
      if (block) {
        if (line.includes('*/')) block = false;
        return;
      }
      if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
        block = true;
        return;
      }
    }
    if (COMMENT_LINE[kind].test(line)) return;
    for (const [what, list] of Object.entries(patterns)) {
      if ((what === 'sleep' || what === 'elapsedMs') && !usesGuard) continue;
      for (const pattern of list) {
        for (const _ of line.matchAll(pattern)) (found[what] ??= []).push(index + 1);
      }
    }
  });
  if (kind === 'js' && found.child && PROMISED_CHILD.test(text)) found.promisedChild = [...found.child];
  return found;
}
export const debtHits = (found) => DEBT_KINDS.reduce((sum, kind) => sum + (found[kind]?.length ?? 0), 0);

// The test files of a checkout: tracked, and (unless untracked is false) untracked ones git does not ignore.
export function testFiles(root, { git = spawnSync, untracked = true } = {}) {
  const listed = git('git', ['-C', root, 'ls-files', '-z', '--cached', ...(untracked ? ['--others', '--exclude-standard'] : [])],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files in ${root}: ${(listed.stderr || listed.error?.message || '').trim()}`);
  return [...new Set(listed.stdout.split('\0').filter(Boolean))].filter((file) => testFileKind(file) && existsSync(path.join(root, file))).sort();
}

// The debt list: one repository path a line, sorted, no repeats; a line starting with # is a marker, not a file.
export function parseDebt(text) {
  const files = [];
  const markers = [];
  const problems = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      markers.push(line);
      continue;
    }
    if (line.includes('\\') || path.posix.isAbsolute(line) || path.posix.normalize(line) !== line) problems.push(`${DEBT_FILE}: not a repository path: ${line}`);
    files.push(line);
  }
  const sorted = [...new Set(files)].sort();
  if (sorted.length !== files.length) problems.push(`${DEBT_FILE}: a file is listed twice`);
  else if (sorted.some((file, i) => file !== files[i])) problems.push(`${DEBT_FILE}: keep the lines sorted`);
  return { files: sorted, markers, problems };
}

// Several blobs of one commit in one git process: Map path -> text (null: not a file there; absent: not in that commit).
export function readAtCommit(root, commit, files, { git = spawnSync } = {}) {
  const result = new Map();
  if (files.length === 0) return result;
  const out = git('git', ['-C', root, 'cat-file', '--batch'], { input: files.map((file) => `${commit}:${file}\n`).join(''), maxBuffer: 512 * 1024 * 1024 });
  if (out.status !== 0) throw new Error(`git cat-file in ${root}: ${String(out.stderr || out.error?.message || '').trim()}`);
  const buffer = out.stdout;
  let at = 0;
  for (const file of files) {
    const end = buffer.indexOf(10, at);
    if (end < 0) throw new Error(`git cat-file: no answer for ${file}`);
    const header = buffer.subarray(at, end).toString('utf8');
    at = end + 1;
    const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!match) {
      if (header.endsWith(' missing')) continue; // not in that commit
      throw new Error(`git cat-file: ${header}`);
    }
    const size = Number(match[2]);
    result.set(file, match[1] === 'blob' ? buffer.subarray(at, at + size).toString('utf8') : null);
    at += size + 1;
  }
  return result;
}
function commitExists(root, commit, git) {
  const out = git('git', ['-C', root, 'cat-file', '-e', `${commit}^{commit}`], { encoding: 'utf8' });
  return out.status === 0;
}

// The allowlist: [{ file, kind, count, reason, ruling }]; each entry must match the scan's count of that kind exactly.
export function allowProblems(entries, scanOf) {
  const problems = [];
  if (!Array.isArray(entries)) return { problems: [`${ALLOW_FILE}: not a JSON array`], byFile: new Map() };
  const byFile = new Map();
  const counted = { sleep: 'sleep', elapsedMs: 'elapsedMs', 'child-timeout': 'child', ps: 'ps', py: 'py' };
  for (const entry of entries) {
    const { file, kind, count, reason, ruling } = entry ?? {};
    const label = `${ALLOW_FILE}: ${file ?? '(no file)'} ${kind ?? '(no kind)'}`;
    if (typeof file !== 'string' || !ALLOW_KINDS.includes(kind) || !Number.isInteger(count) || count < 1
      || typeof reason !== 'string' || !reason || typeof ruling !== 'string' || !ruling) {
      problems.push(`${label}: an entry is { file, kind (${ALLOW_KINDS.join(', ')}), count >= 1, reason, ruling }`);
      continue;
    }
    if (byFile.get(file)?.has(kind)) {
      problems.push(`${label}: listed twice`);
      continue;
    }
    if (!byFile.has(file)) byFile.set(file, new Set());
    byFile.get(file).add(kind);
    const found = scanOf(file);
    if (!found) {
      problems.push(`${label}: no such test file`);
      continue;
    }
    const actual = found[counted[kind]]?.length ?? 0;
    if (actual !== count) problems.push(`${label}: the entry says ${count}, the file has ${actual}; the entry is for those places only`);
  }
  return { problems, byFile };
}


// Every problem of the list, the allowlist and the static rules in the checkout at root, against the base commit's list.
// The base comes from the caller only: not given (undefined) is a problem of its own, wherever it runs; base: null is the
// caller saying the list is not compared (the static rules and the allowlist still are).
export function debtVerdict({ root, base, git = spawnSync, untracked = true } = {}) {
  const problems = [];
  const read = (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8');
    } catch {
      return null;
    }
  };
  const debtText = read(DEBT_FILE);
  const head = parseDebt(debtText ?? '');
  problems.push(...head.problems);
  const scans = new Map();
  const scanOf = (file) => {
    if (!scans.has(file)) {
      const kind = testFileKind(file);
      const text = kind ? read(file) : null;
      scans.set(file, text === null ? null : scanSource(text, kind));
    }
    return scans.get(file);
  };
  let baseList = null;
  if (base === undefined) {
    // A missing base would quietly stop the comparison: the list could grow with every check green.
    problems.push('no base commit: the debt list cannot be compared; give the check the base commit (--base)');
  } else if (base !== null) {
    if (!commitExists(root, base, git)) {
      problems.push(`the base commit ${base} cannot be read: the debt list is not compared (fetch it)`);
    } else {
      const text = readAtCommit(root, base, [DEBT_FILE], { git }).get(DEBT_FILE);
      // Only a base without the file is the change that brings the list (nothing to compare with); a base where it is
      // something git cannot give as a file is a failure, not a pass.
      if (text === null) problems.push(`the base commit's ${DEBT_FILE} is not a file: the debt list cannot be compared`);
      else if (text !== undefined) baseList = parseDebt(text).files;
    }
  }
  const listed = new Set(head.files);
  const baseTexts = baseList ? readAtCommit(root, base, head.files.filter((file) => baseList.includes(file)), { git }) : new Map();
  const baseSet = new Set(baseList ?? []);
  for (const file of head.files) {
    if (baseList && !baseSet.has(file)) {
      problems.push(`${file}: test-clock debt grew (the base commit's ${DEBT_FILE} does not list it); fix the test instead`);
      continue;
    }
    const found = scanOf(file);
    if (!found) {
      problems.push(`${file}: listed in ${DEBT_FILE} but not a test file here; remove the line`);
      continue;
    }
    const hits = debtHits(found);
    if (hits === 0) {
      // A test that runs a listed helper's use carries that debt too (the guard lets the helper through only for a listed
      // test): its line stays while it imports a listed file with a use, and goes once that file is clear.
      if (!importsDebt(file, { read, listed, hitsOf: (other) => debtHits(scanOf(other) ?? {}) })) {
        problems.push(`${file}: no real-clock use left; remove the line from ${DEBT_FILE}`);
      }
      continue;
    }
    if (typeof baseTexts.get(file) === 'string') {
      const before = debtHits(scanSource(baseTexts.get(file), testFileKind(file)));
      if (hits > before) problems.push(`${file}: real-clock uses grew from ${before} to ${hits}; a listed file only sheds them`);
    }
  }
  const allowText = read(ALLOW_FILE);
  let allow = { problems: [], byFile: new Map() };
  if (allowText !== null) {
    try {
      allow = allowProblems(JSON.parse(allowText), scanOf);
    } catch (error) {
      allow = { problems: [`${ALLOW_FILE}: ${error.message}`], byFile: new Map() };
    }
  }
  problems.push(...allow.problems);
  const allowKind = { ps: 'ps', py: 'py', promisedChild: 'child-timeout' };
  for (const file of testFiles(root, { git, untracked })) {
    if (listed.has(file)) continue;
    const found = scanOf(file);
    for (const kind of STATIC_KINDS) {
      if (!found?.[kind]?.length) continue;
      if (allowKind[kind] && allow.byFile.get(file)?.has(allowKind[kind])) continue;
      problems.push(`${file}:${found[kind].join(',')}: ${STATIC_HELP[kind]}`);
    }
  }
  return { problems, debt: head.files, markers: head.markers };
}
const STATIC_HELP = {
  testTimeout: "node:test's { timeout } puts a wall-clock limit on the test; the entry bounds the whole command",
  promisedChild: 'a promisified exec or execFile is given a timeout in a test; the entry bounds the whole command',
  ps: 'PowerShell reads the real clock or waits in a test (Get-Date, Start-Sleep, ::Now, Stopwatch); give the script a time seam (Get-DrillTime)',
  sql: 'pg_sleep waits for real time in a test; write the time into the row (now() - interval ...)',
  py: 'Python reads the real clock, sleeps or sets a timeout in a test; pass a clock, wait on the event',
};

// The scan's list, for the first list and nothing else (debtVerdict refuses any growth): every test file with a hit, and
// the lines already there for tests that run a listed helper's use (the guard's record finds those; no scan can).
export function debtListOf(root, { git = spawnSync } = {}) {
  const read = (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8');
    } catch {
      return null;
    }
  };
  const hit = new Set(testFiles(root, { git }).filter((file) => debtHits(scanSource(read(file), testFileKind(file))) > 0));
  const borrowers = parseDebt(read(DEBT_FILE) ?? '').files.filter((file) => !hit.has(file) && testFileKind(file)
    && importsDebt(file, { read, listed: hit, hitsOf: () => 1 }));
  return [...hit, ...borrowers].sort();
}

// The variables that preload the guard: into a suite command, and from there into every node it starts.
export function clockGuardEnv({ root, record, guard = GUARD_PATH }) {
  return { NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`, CLUED_CLOCK_ROOT: path.resolve(root), CLUED_CLOCK_RECORD: record };
}

// A command's record, read once the command has ended: { refused, debt, lines } where refused are the entries outside the
// debt list (each fails the command) and lines are what the entry prints for them.
export function recordVerdict(text, { suite = 'suite' } = {}) {
  const entries = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ api: 'unreadable record line', file: '?', line: 0, debt: false });
    }
  }
  const refused = entries.filter((entry) => !entry.debt);
  const debt = entries.filter((entry) => entry.debt);
  // The test the process ran, when the use is in another file (a helper): that test is what the debt list does not name.
  const via = (entry) => (entry.entry && entry.entry !== entry.file ? ` (${entry.entry})` : '');
  const lines = refused.length === 0 ? [] : [`${suite}: ${refused.length} real-clock use${refused.length === 1 ? '' : 's'} in test code`,
    ...refused.slice(0, RECORD_SHOWN).map((entry) => `  ${entry.file}:${entry.line} ${entry.api}${via(entry)}`),
    ...(refused.length > RECORD_SHOWN ? [`  ... and ${refused.length - RECORD_SHOWN} more`] : [])];
  return { refused, debt, lines };
}

function main(argv) {
  const option = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const root = path.resolve(option('--root') ?? path.join(HERE, '..', '..'));
  if (argv[0] === '--write-debt') {
    const files = debtListOf(root);
    writeFileSync(path.join(root, DEBT_FILE), `${files.join('\n')}\n`);
    console.log(`${DEBT_FILE}: ${files.length} files`);
    return 0;
  }
  if (argv[0] === '--check') {
    // The base is an argument and nothing else: the environment is not read, and no base is not a quiet skip.
    const base = option('--base');
    if (!base || base.startsWith('-')) {
      console.error('test-clock-scan: --check needs --base <commit> (the commit whose debt list this checkout is compared with)');
      return 2;
    }
    const { problems, debt } = debtVerdict({ root, base });
    for (const problem of problems) console.log(`::error title=test-clock::${problem}`);
    console.log(`test-clock: ${debt.length} files on the debt list; ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
    return problems.length === 0 ? 0 : 1;
  }
  console.error('usage: node scripts/ci/test-clock-scan.mjs --check --base <commit> [--root <checkout>] | --write-debt [--root <checkout>]');
  return 2;
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2));
