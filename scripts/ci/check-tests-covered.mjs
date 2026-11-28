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
// files --run-files would run), or when a running test imports it at the top level or invokes it through a registered
// PowerShell call. Fails on:
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
// 子进程助手用 --runtime-reader 上报调用者。实际测试操作数由选择器在派发时核对。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_SCRIPT_TEST_DIRS, SUITE_COMMANDS, SUITES, commandArgv, expandArgv, filterCommand, globToRegExp, hostPlatform,
  knownKey, requiredCommands, selectSuites, selectWithCandidate, suitePlatforms, unitTestFiles } from './ci-required-selection.mjs';

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
const relativeReferences = (source, accept = () => true) => [...source.matchAll(
  /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
  .filter(accept).map((match) => ({ spec: match[1] ?? match[2] ?? match[3], style: match[3] ? 'require' : 'import' }))
  .filter(({ spec }) => spec.startsWith('./') || spec.startsWith('../'));
const relativeSpecifiers = (source) => relativeReferences(source).map(({ spec }) => spec);
const RUNNER = 'node:' + 'test';
const importsRunner = (file, source) => (NODE_SOURCE.test(file)
  ? [...source.matchAll(/\b(?:from\s*|import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/g)].some((match) => match[1] === RUNNER)
  : file.endsWith('.py') && /^\s*class \w+\((?:unittest\.)?(?:Isolated)?(?:Async)?TestCase\)/m.test(source));

// file -> the suites whose commands take it (filterCommand's matched files, as --run-files would run them).
export function suiteFiles(root, { commands = SUITE_COMMANDS, tracked, listUnit, argvFor, onCommand } = {}) {
  const named = new Set(tracked);
  const runs = new Map();
  const collects = [];
  for (const [id, list] of Object.entries(commands)) {
    for (const command of list) {
      const cwd = path.join(root, command.cwd);
      const argv = argvFor ? argvFor(command, cwd, id)
        : expandArgv(command.argv, { cwd, root, base: 'base', report: 'report', ...(listUnit ? { listUnit: () => listUnit(cwd) } : {}) });
      const { matched } = filterCommand(command, argv, named);
      for (const file of matched) runs.set(file, [...(runs.get(file) ?? []), id]);
      onCommand?.({ id, command, argv, matched });
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

// Map each running test, including transitive imports and invocations, to the test file the suite command takes.
function runningTests(bySuite, trackedSet, source) {
  const direct = [...bySuite.keys()].filter(isTestFile);
  const runs = new Map(direct.map((file) => [file, file]));
  const pending = [...direct];
  while (pending.length > 0) {
    const file = pending.pop();
    const imports = NODE_SOURCE.test(file) ? topLevelImports(source(file) ?? '').map((spec) => resolve(file, spec)) : [];
    const invoked = FLEET_POWERSHELL_CALLS.filter(({ caller, call }) => caller === file && call.test(source(file)))
      .map(({ script }) => script);
    for (const target of [...imports, ...invoked]) {
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

const splitPaths = (value) => value.split('\0').filter(Boolean);
const targetGit = (root, args, options) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26, timeout: 30_000, windowsHide: true,
  env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }, ...options,
});

function targetInputs(root) {
  const head = targetGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const main = targetGit(root, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']).trim();
  const bases = targetGit(root, ['merge-base', '--all', head, main]).trim().split(/\s+/);
  if (bases.length !== 1 || !bases[0]) throw new Error('HEAD 和 origin/main 没有唯一共同祖先');
  if (targetGit(root, ['ls-files', '--unmerged', '-z'])) throw new Error('Git 索引有未合并条目');
  const base = bases[0];
  const untracked = splitPaths(targetGit(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const changed = splitPaths(targetGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--']));
  const seeds = [...new Set([...changed, ...untracked])].sort();
  const tracked = splitPaths(targetGit(root, ['ls-files', '--cached', '-z']));
  return { head, main, base, seeds, files: new Set([...tracked, ...untracked]) };
}

const inside = (file) => file !== '' && file !== '..' && !file.startsWith('../') &&
  !path.posix.isAbsolute(file) && !/^[a-z]:/i.test(file);
const slash = (file) => file.split(path.sep).join('/');
const GRAPH_SOURCE = /\.(?:mjs|js|cjs|mts|cts|jsx|ts|tsx)$/;
const SCRIPT_SOURCE = /\.(?:py|ps1|sh)$/i;

function worktreeReader(root) {
  const cache = new Map();
  const read = (file) => {
    if (cache.has(file)) return cache.get(file);
    if (!inside(file)) throw new Error('路径在工作树之外：' + file);
    const absolute = path.resolve(root, file);
    let real;
    try {
      real = realpathSync.native(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      cache.set(file, null);
      return null;
    }
    const identity = slash(path.relative(root, real));
    if (!inside(identity) || !statSync(real).isFile()) throw new Error('依赖不是工作树内的文件：' + file);
    const bytes = readFileSync(real);
    const value = { identity, digest: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') };
    cache.set(file, value);
    return value;
  };
  return { cache, read };
}

// Unchanged readers use their worktree text with both path inventories. Read old blobs only
// for changed readers and package entry metadata, including readers deleted from the worktree.
function oldGraphInputs(root, { base, seeds }) {
  const ids = new Map();
  for (const entry of splitPaths(targetGit(root, ['ls-tree', '-r', '-z', base]))) {
    const tab = entry.indexOf('\t');
    const [, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob') ids.set(entry.slice(tab + 1), id);
  }
  const requested = [...new Set(seeds.filter((file) => ids.has(file) &&
    (GRAPH_SOURCE.test(file) || /(?:^|\/)package\.json$/.test(file) || file === R9_REGISTRY))
    .map((file) => ids.get(file)))];
  const texts = new Map();
  if (requested.length) {
    const bytes = targetGit(root, ['cat-file', '--batch'], { encoding: 'buffer', input: Buffer.from(requested.join('\n') + '\n') });
    let offset = 0;
    for (const id of requested) {
      const end = bytes.indexOf(10, offset);
      const header = bytes.subarray(offset, end).toString('ascii').split(' ');
      const size = Number(header[2]);
      if (end < 0 || header[0] !== id || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || bytes[end + 1 + size] !== 10) {
        throw new Error('无法读取基准 Git blob：' + id);
      }
      texts.set(id, bytes.toString('utf8', end + 1, end + 1 + size));
      offset = end + 2 + size;
    }
  }
  return { ids, text: (file, current) => texts.get(ids.get(file)) ?? current };
}

// List the language's candidates in resolution order. A disappeared explicit path is
// still an edge, so a surviving importer can report the missing file when it runs.
function fileLookup(paths) {
  if (process.platform !== 'win32') {
    const names = new Set(paths);
    return (name) => names.has(name) ? name : null;
  }
  const names = new Map();
  for (const name of paths) {
    const key = name.toLowerCase();
    if (names.has(key) && names.get(key) !== name) throw new Error('工作树文件名只在大小写上有差异：' + name);
    names.set(key, name);
  }
  return (name) => names.get(name.toLowerCase()) ?? null;
}

function moduleTargets(from, spec, style, lookup, source) {
  const fromUrl = style === 'import' || style === 'url-resource';
  const raw = fromUrl ? spec.split(/[?#]/, 1)[0] : spec;
  if (!raw || raw.includes('\\') || /^[a-z]:/i.test(raw) || path.posix.isAbsolute(raw) || fromUrl && /%(?:2f|5c)/i.test(raw)) return [];
  let relative = raw;
  if (fromUrl) {
    try { relative = decodeURIComponent(raw); } catch { return []; }
  }
  const target = resolve(from, relative);
  if (!inside(target)) return [];
  const exact = lookup(target);
  if (style.endsWith('resource') || exact) return [exact ?? target];
  const typed = /\.[cm]?tsx?$/.test(from);
  const extensions = style === 'require' ? ['.js', '.json', '.node'] : [];
  if (typed) extensions.unshift('.ts', '.tsx', '.mts', '.cts', '.js', '.jsx');
  const replacement = typed && /\.(?:js|jsx|mjs|cjs)$/.test(target) ? {
    '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
  }[path.posix.extname(target)].map((extension) => target.slice(0, target.lastIndexOf('.')) + extension) : [];
  const file = [...replacement, ...extensions.map((extension) => target + extension)].map(lookup).find(Boolean);
  if (file) return [file];
  if (extensions.length) {
    const manifest = lookup(path.posix.join(target, 'package.json'));
    const index = (directory) => extensions.map((extension) => path.posix.join(directory, 'index' + extension));
    let candidates = index(target);
    if (manifest) {
      const text = source(manifest);
      const main = text === null ? null : JSON.parse(text).main;
      if (typeof main === 'string') {
        const entry = path.posix.join(target, main);
        candidates = [entry, ...extensions.map((extension) => entry + extension), ...index(entry), ...candidates];
      }
      return [manifest, candidates.filter(inside).map(lookup).find(Boolean) ?? target];
    }
    const entry = candidates.map(lookup).find(Boolean);
    if (entry) return [entry];
  }
  return [target];
}

// Scan code, skipping comments and tokens inside strings/templates. This shares the
// specifier extractor with coverage, while keeping coverage's own rules untouched.
function dependencySyntax(file, source) {
  const excluded = new Uint8Array(source.length);
  const text = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60/g,
    (token, offset) => {
      excluded.fill(1, offset, offset + token.length);
      return token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token;
    });
  const code = (match) => !excluded[match.index];
  const references = relativeReferences(text, (match) => code(match) &&
    (!/^(?:import|require)\s*\(/.test(match[0]) || /^(?:\s*[,)]|\s*$)/.test(text.slice(match.index + match[0].length)) || match[3]));
  const resources = /\bnew\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;
  for (const match of text.matchAll(resources)) {
    if (code(match) && !/^(?:[a-z][\w+.-]*:|[/\\#?])/i.test(match[2])) references.push({ spec: match[2], style: 'url-resource' });
  }
  const resourceScopes = [...text.matchAll(/\bnew\s+URL\s*\(\s*\x60([^$\x60]+)\$\{[^}]+\}[^,\x60]*\x60\s*,\s*import\.meta\.url\s*\)/g)]
    .filter(code)
    .map((match) => match[1].endsWith('/') ? match[1] : path.posix.dirname(match[1]) + '/')
    .filter((prefix) => !/^(?:[a-z][\w+.-]*:|[/\\])|^(?:\.{1,2}\/)+$/i.test(prefix));
  const reads = /\b(?:readFile(?:Sync)?|createReadStream)\s*\(\s*(?:(?:path\.)?(?:join|resolve)\s*\(\s*(import\.meta\.dirname|__dirname|(?:path\.)?dirname\s*\(\s*fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\))\s*,\s*)?(['"])([^'"]+)\2/g;
  for (const match of text.matchAll(reads)) {
    if (!code(match) || /^(?:[a-z]:|[/\\])/i.test(match[3])) continue;
    if (match[1]) {
      const pieces = [...text.slice(match.index + match[0].length).matchAll(/^\s*((?:,\s*['"][^'"]+['"]\s*)*)\)/g)];
      if (pieces.length) {
        const rest = [...pieces[0][1].matchAll(/['"]([^'"]+)['"]/g)].map((part) => part[1]);
        references.push({ spec: path.posix.join(match[3], ...rest), style: 'resource' });
      }
    } else if (/^\s*[,)]/.test(text.slice(match.index + match[0].length))) {
      references.push({ spec: match[3], style: 'cwd-resource' });
    }
  }
  const opaque = [...text.matchAll(/\b(?:import|require)\s*\(\s*/g)].filter(code).flatMap((call) => {
    const argument = text.slice(call.index + call[0].length, call.index + call[0].length + 256);
    if (/^(['"])(?:\\.|(?!\1)[^\\])*\1\s*[,)]/.test(argument) || /^(?:['"]|\x60)(?:node:|https?:)/.test(argument)) return [];
    const template = /^\x60(\.{1,2}\/[^\x60$]+)\x60\s*[,)]/.exec(argument);
    if (template) {
      references.push({ spec: template[1], style: call[0].startsWith('require') ? 'require' : 'import' });
      return [];
    }
    const fixedRoot = /^pathToFileURL\s*\(\s*path\.(?:join|resolve)\s*\(\s*(root|tree|ROOT)\s*,\s*(['"])([^'"]+)\2\s*\)\s*\)(?:\.href)?\s*\)/.exec(argument);
    // In the governance test ROOT is resolved from the checkout, so its capacity import is exact.
    if (fixedRoot && (fixedRoot[1] !== 'ROOT' || file === GOVERNANCE_TEST)) {
      references.push({ spec: fixedRoot[3], style: 'root-resource' });
      return [];
    }
    const concatenated = /^(\w+)\s*\+\s*(['"])([^'"]+)\2\s*\)/.exec(argument);
    if (concatenated) {
      const declaration = [...text.matchAll(/\bconst\s+(\w+)\s*=\s*(['"])(\.{1,2}\/[^'"]*)\2\s*;/g)]
        .filter((match) => code(match) && match[1] === concatenated[1]);
      if (declaration.length === 1) {
        references.push({ spec: declaration[0][3] + concatenated[3], style: 'import' });
        return [];
      }
    }
    // These loaders receive the selector's URL from the suite guard and from
    // local-verify's trusted Git export. RUNTIME_READERS holds their exact edge.
    if ((file === 'scripts/ci/local-suite-slot-guard.mjs' && /^work\.selectorUrl\s*\)/.test(argument)) ||
        (file === 'scripts/ci/local-verify.mjs' && /^selectorUrl\s*\)/.test(argument))) return [];
    // A relative prefix can bound the affected source directory. An opaque
    // argument could resolve to a module anywhere in the checkout.
    const prefix = /^(?:['"]|\x60)(\.{1,2}\/[^'"$\x60]*)/.exec(argument)?.[1];
    return [prefix === undefined ? null : prefix.endsWith('/') ? prefix : path.posix.dirname(prefix) + '/'];
  });
  return { references, opaque: [...new Set(opaque)], resourceScopes: [...new Set(resourceScopes)] };
}

const RESIDENT = 'work/independent-ci-resident-v1';
const GOVERNANCE_TEST = 'scripts/ci/self-hosted/node-governance/governance.test.mjs';
const FLEET = RESIDENT + '/rollout/fleet';
const APP_TESTS = 'apps/clued-cloud/tests/';
const SOURCE_V2 = 'work/actions-hosted-migration/independent-ci-v1';
const QUALIFICATION = 'scripts/phase2-qualification';
const MODEL_TEST = 'tests/test_model_';
const FLEET_REPLAY = APP_TESTS + 'production-schema/fleet-previous-interfaces-db.test.mjs';
const FLEET_DELIVERY = APP_TESTS + 'fleet-delivery-release-db.test.mjs';
const FLEET_CHILDREN = new RegExp('^' + FLEET + '/test/[^/]+\\.test\\.mjs$');
const FLEET_WRAPPERS = [1, 2, 3].map((part) => RESIDENT + '/test/fleet-node-children-' + part + '.test.mjs');
const FLEET_POWERSHELL_CALLS = [
  { caller: RESIDENT + '/test/fleet-node-powershell.test.mjs', script: FLEET + '/test/test-bootstrap.ps1',
    call: /^\s*const r = powershellFile\(path\.join\(FLEET_TESTS, 'test-bootstrap\.ps1'\)(?:, \[[^\]]*\])?\);\s*$/m },
  { caller: FLEET + '/test/test-bootstrap.ps1', script: FLEET + '/test/test-clean-reinstall.ps1',
    call: /^\s*\. \(Join-Path \$here 'test-clean-reinstall\.ps1'\)\s*$/m },
];
const R9_REGISTRY = 'scripts/ci/merge-admission-r9-source.json';
const R9_READER = 'scripts/ci/merge-admission-r9-reregister.mjs';
// Runtime paths produced by path composition, directory enumeration or
// a subprocess call. Each edge points from an input to its actual reader.
const RUNTIME_READERS = new Map([
  ['config/node-governance-standard.json', [GOVERNANCE_TEST, RESIDENT + '/test/test_linux_tool.py']],
  [FLEET + '/test/fixtures/clued-decision-mutate-3bc571a6.json', [FLEET + '/test/publish-fixtures.mjs']],
  [R9_REGISTRY, [R9_READER]],
  ['scripts/ci/clued-gated-proof-profiles.json', [R9_READER]],
  ['scripts/ci/clued-gated-proof-role-specs.json', [R9_READER]],
  ['scripts/ci/ci-shard-seconds.json', ['scripts/ci/ci-required-selection.mjs', 'scripts/ci/local-verify.mjs']],
  ['scripts/ci/ci-required-selection.mjs', ['scripts/ci/local-suite-slot-guard.mjs', 'scripts/ci/local-verify.mjs']],
  [FLEET + '/bootstrap.ps1', [FLEET + '/test/test-bootstrap.ps1']],
  ...FLEET_POWERSHELL_CALLS.map(({ caller, script }) => [script, [caller]]),
]);

// Runtime test references include replay, direct subprocesses, dynamic fixture
// imports and tests that read another test's source. Group inputs by their reader.
for (const [reader, inputs] of [
  [FLEET_REPLAY, [FLEET_DELIVERY, APP_TESTS + 'owner-grants-fleet-accept-door-db.test.mjs']],
  [APP_TESTS + 'production-release-gate.test.mjs', [FLEET_DELIVERY]],
  [APP_TESTS + 'integration-runtime-gate-evidence.test.mjs', ['derivation-db', 'worker'].map((name) => APP_TESTS + 'integration-runtime-' + name + '.test.mjs')],
  [APP_TESTS + 'independent-review-ui.test.mjs', [APP_TESTS + 'resume-constraint-index-db.test.mjs']],
  [APP_TESTS + 'resource-center-binding-expiry-coverage.test.mjs', [APP_TESTS + 'resource-center-authority-db.test.mjs']],
  [APP_TESTS + 'worker-source-pins-current.test.mjs', [APP_TESTS + 'merge-admission-clock-audit-transport-db.test.mjs']],
  [APP_TESTS + 'storage-zip-packaging.test.mjs', ['tests/test_storage_zip.py']],
  ['scripts/ci/ci-required-selection.test.mjs', ['scripts/ci/main-entry-realpath.test.mjs',
    ...['local-dev-tools', 'storage-semantic-recovery-db', 'integration-runtime-derivation-db'].map((name) => APP_TESTS + name + '.test.mjs')]],
  ['scripts/ci/merge-admission-r9-checkout-tree.test.mjs', ['scripts/ci/merge-admission-r9-collector.test.mjs']],
  ['scripts/ci/clued-control-workflow-reconcile-source.test.mjs', ['clued-pr-task-binding', 'clued-pr-write-set', 'merge-admission-r9-collector']
    .map((name) => 'scripts/ci/' + name + '.test.mjs')],
  [QUALIFICATION + '/docker-engineering-observation/test_observation.py', [QUALIFICATION + '/linux-docker-driver/test_candidate.py']],
  ...['test_attempt_scope_fix.py', 'test_commit_identity_fix.py'].map((file) =>
    [QUALIFICATION + '/qualification-runtime/' + file, [QUALIFICATION + '/qualification-runtime/test_branch_successor.py']]),
  [QUALIFICATION + '/qualification-runtime/history/branch-target-d8f125cc/test_attempt_scope_fix.py',
    [QUALIFICATION + '/qualification-runtime/history/branch-target-d8f125cc/test_branch_successor.py']],
  [MODEL_TEST + 'completion_v2_records.py', ['program_invocation_saved_projection', 'observed_completion_response'].map((name) => MODEL_TEST + name + '.py')],
  [MODEL_TEST + 'decision_candidate_projection.py', [MODEL_TEST + 'workflow_saved_scorers.py']],
  [MODEL_TEST + 'program_m2_saved_harness.py', [MODEL_TEST + 'program_m2_saved_report_runner.py']],
  [MODEL_TEST + 'program_m2_scoped_consumer.py', [
    'program_m2_saved_output_metrics', 'program_m2_saved_report_runner', 'program_m2_saved_harness', 'program_m2_core_saved_adapter',
    'program_m2_input_generator', 'program_development_invocation_projection', 'program_invocation_saved_projection',
    'local_completion_execution', 'completion_saved_response', 'workflow_saved_scorers', 'completion_v2_records',
    'observed_completion_execution', 'runtime_observation_records', 'observed_completion_response', 'decision_candidate_projection',
    'workflow_domain_contract', 'provider_timing_saved_projection', 'reference_4b_preparation',
  ].map((name) => MODEL_TEST + name + '.py')],
  [MODEL_TEST + 'workflow_domain_contract.py', [MODEL_TEST + 'decision_candidate_projection.py']],
  ['tests/test_naming_governance_trusted_launcher.py', ['tests/test_naming_governance_post_migration.py']],
  ['tests/test_p6_release.py', [APP_TESTS + 'p6-shadow-canary.test.mjs']],
  [SOURCE_V2 + '/src/control-install-delta-v2/test-offline.ps1', [SOURCE_V2 + '/src/control-install-delta-v2/batch/test-pure.ps1']],
  ...['pure-v2-csharp', 'train-run'].map((name) =>
    [SOURCE_V2 + '/test/' + name + '.test.mjs', [SOURCE_V2 + '/src/resident-v2/windows/test-pure-v2.ps1']]),
  [RESIDENT + '/reinstall/test/test_docker_activating_wait.py', [RESIDENT + '/reinstall/test/test_reinstall_kit.py']],
  [RESIDENT + '/rollout/test/test_upgrade_tools.py', [RESIDENT + '/test/test_upgrade_linux.py']],
  [RESIDENT + '/test/companion-run-ignores-constraints.test.mjs', ['test-companion-headless', 'test-upgrade-system', 'test-upgrade-windows']
    .map((name) => RESIDENT + '/windows/' + name + '.ps1')],
  [RESIDENT + '/test/drill-vm-part4.test.mjs', [1, 2, 3].map((part) => RESIDENT + '/test/drill-vm-part' + part + '.test.mjs')],
  [RESIDENT + '/test/fleet-node-powershell.test.mjs', [RESIDENT + '/windows/test-first-install-host.ps1']],
  [RESIDENT + '/test/m5b-reinstall-regressions.test.mjs', [RESIDENT + '/windows/test-m5b-wsl-release.ps1']],
  [RESIDENT + '/test/ps-execution-policy.test.mjs', [RESIDENT + '/windows/test-first-install-host.ps1']],
  [RESIDENT + '/test/relay-parent-acl.test.mjs', ['test-companion-relay-parent-acl', 'test-verify-relay-parents-ensure']
    .map((name) => RESIDENT + '/windows/' + name + '.ps1')],
  [RESIDENT + '/test/test_upgrade_system_script.py', [RESIDENT + '/windows/test-upgrade-system.ps1']],
  [RESIDENT + '/test/verify-verdict.test.mjs', [RESIDENT + '/windows/test-resident-windows.ps1']],
  [RESIDENT + '/windows/test-companion-headless.ps1', ['test-companion-maintenance-switch', 'test-vhdx-file-acl']
    .map((name) => RESIDENT + '/windows/' + name + '.ps1')],
  [RESIDENT + '/windows/test-job-host.ps1', [RESIDENT + '/test/job-host.test.mjs']],
]) {
  for (const input of inputs) RUNTIME_READERS.set(input, [...(RUNTIME_READERS.get(input) ?? []), reader]);
}

const registeredRuntimeReaders = (file) => [
  ...(RUNTIME_READERS.get(file) ?? []), ...(FLEET_CHILDREN.test(file) ? FLEET_WRAPPERS : []),
];

// 核对选择器已解析的执行路径。回放在历史检出中执行，读取者仍来自选择器所在的检出。
export function assertRuntimeTestEdges({ root, reader, files }) {
  const relativeTest = (directory, absolute) => {
    const file = slash(path.relative(directory, absolute));
    return inside(file) && isTestFile(file) ? file : null;
  };
  if (!path.isAbsolute(reader)) throw new Error('--runtime-reader 须为读取者测试的绝对路径');
  const readerPath = realpathSync.native(reader);
  const tracked = fileLookup(trackedFiles(root));
  const rootPath = realpathSync.native(root);
  let from = tracked(relativeTest(rootPath, readerPath) ?? '');
  if (!from) {
    const sourcePath = realpathSync.native(DEFAULT_ROOT);
    const candidate = relativeTest(sourcePath, readerPath);
    if (candidate && sourcePath !== rootPath) from = fileLookup(trackedFiles(DEFAULT_ROOT))(candidate);
  }
  if (!from || !statSync(readerPath).isFile()) throw new Error('--runtime-reader 须指向源检出或执行检出中已跟踪的测试文件');

  const missing = new Set();
  for (const file of files) {
    const absolute = realpathSync.native(path.join(root, file));
    const target = tracked(relativeTest(rootPath, absolute) ?? '');
    if (target && target !== from && statSync(absolute).isFile() && !registeredRuntimeReaders(target).includes(from)) {
      missing.add(`RUNTIME_READERS 缺边：${target} -> ${from}`);
    }
  }
  if (missing.size > 0) throw new Error([...missing].sort().join('\n'));
}

// The reregistration command reads these fields when it hashes source blobs.
// Paths in prose, prior generations or other registry fields do not add edges.
function r9PinnedInputs(text) {
  if (text === null) return [];
  const config = JSON.parse(text);
  return [
    config.publisher_role?.workflow_path,
    ...['script', 'workflow', 'reverify_workflow', 'policy'].map((kind) => config.admission_source?.[kind + '_path']),
    ...(config.natural_producers ?? []).flatMap((producer) => Object.keys(producer.source_blobs ?? {})),
  ].filter((file) => typeof file === 'string' && inside(path.posix.normalize(file)) && !file.includes('\\'));
}

const pureDocs = (file) => /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|LICENSE)(?:\.[a-z]+)?$/i.test(file) ||
  /^(?:docs\/|[^/]+\.md$)/.test(file) && /\.(?:md|rst|txt)$/i.test(file);
const MAX_GRAPH_FILES = 12_000;
const MAX_PLAN_ENTRIES = 3_000;

function reverseClosure(seeds, readers) {
  const parent = new Map(seeds.map((seed) => [seed, null]));
  const pending = [...seeds];
  for (let index = 0; index < pending.length; index += 1) {
    const file = pending[index];
    for (const reader of readers.get(file) ?? []) {
      if (parent.has(reader)) continue;
      parent.set(reader, file);
      pending.push(reader);
    }
  }
  return {
    parent,
    chain(file) {
      const chain = [];
      for (let at = file; at !== null; at = parent.get(at)) chain.push(at);
      return chain.reverse();
    },
  };
}


function targetedEntries(root, state, env, work) {
  const platforms = new Map(Object.keys(SUITE_COMMANDS).map((suite) => [suite, suitePlatforms(suite)]));
  const addedSuites = new Set();
  for (const check of Object.keys(SUITES)) {
    const { selection, error } = selectWithCandidate(check, state.seeds, null, root, { env, withPlatforms: true });
    if (error) throw error;
    for (const { id, platforms: on } of selection.added ?? []) {
      platforms.set(id, on);
      addedSuites.add(id);
    }
  }
  const commands = Object.fromEntries([...platforms.keys()].map((suite) =>
    [suite, [...requiredCommands(suite, root, { env, base: state.base })]]));
  const entries = new Map();
  const unitLists = new Map();
  const directoryOf = (command) => path.posix.normalize(command.cwd.replaceAll('\\', '/'));
  const addEntry = (file, suite, command, whole) => {
    if (!state.files.has(file) || !work.read(file)) return;
    const conditions = /^.*\/test\/fleet-node-(?:children(?:-[123])?|powershell)\.test\.mjs$/.test(file) &&
      file.startsWith(RESIDENT + '/') ? platforms.get(suite).filter((platform) => platform === 'win32') : platforms.get(suite);
    const list = entries.get(file) ?? [];
    list.push({ suite, cwd: directoryOf(command), whole: whole || !Object.hasOwn(SUITE_COMMANDS, suite), platforms: conditions });
    entries.set(file, list);
  };
  suiteFiles(root, {
    commands, tracked: state.files,
    argvFor(command, cwd, id) {
      return commandArgv(command, {
        cwd, root, base: state.base, report: path.join(env.RUNNER_TEMP || os.tmpdir(), id + '-report.json'), hosted: false,
        listUnit() {
          if (!unitLists.has(cwd)) unitLists.set(cwd, unitTestFiles(cwd));
          return unitLists.get(cwd);
        },
      });
    },
    onCommand({ id, command, argv, matched }) {
      for (const file of matched) addEntry(file, id, command, false);
      // An unfilterable command can still name its script and test files. Its
      // suite must run as registered for those entries, with all original flags.
      const whole = new Set();
      if (['node', 'python', 'python3'].includes(argv[0])) {
        const first = argv.slice(1).find((arg) => !arg.startsWith('-'));
        if (first && /\.[cm]?[jt]s$|\.py$/.test(first)) whole.add(first);
        if (argv.includes('--test')) argv.filter(isTestFile).forEach((file) => whole.add(file));
      }
      for (const operand of whole) {
        const file = path.posix.join(directoryOf(command), operand.replaceAll('\\', '/'));
        if (!matched.includes(file) && inside(file)) addEntry(file, id, command, true);
      }
    },
  });
  return { entries, platforms, addedSuites };
}

function dependencyGraph(state, old, work, entries) {
  const readers = new Map();
  const opaque = new Map();
  const fleetChildren = [...new Set([...state.files, ...old.ids.keys()])].filter((file) => FLEET_CHILDREN.test(file));
  const fixedInputs = new Map();
  const lookupCurrent = fileLookup(state.files);
  const lookupOld = fileLookup(old.ids.keys());
  const addInputs = (reader, files) => fixedInputs.set(reader, [...(fixedInputs.get(reader) ?? []), ...files]);
  for (const [file, consumers] of RUNTIME_READERS) consumers.forEach((reader) => addInputs(reader, [file]));
  for (const wrapper of FLEET_WRAPPERS) addInputs(wrapper, fleetChildren);

  const parsed = new Map();
  const scan = (file, text) => {
    const previous = parsed.get(file);
    if (previous?.has(text)) return previous.get(text);
    const syntax = dependencySyntax(file, text);
    const texts = previous ?? new Map();
    texts.set(text, syntax);
    parsed.set(file, texts);
    return syntax;
  };
  const pending = [...entries].flatMap(([file, commands]) => [...new Set(commands.map(({ cwd }) => cwd))].map((cwd) => [file, cwd]));
  const visited = new Set();
  const add = (target, reader, cwd) => {
    if (target === reader) return;
    if (!readers.has(target)) readers.set(target, new Set());
    readers.get(target).add(reader);
    if (GRAPH_SOURCE.test(target) || fixedInputs.has(target)) pending.push([target, cwd]);
    else if (state.files.has(target)) work.read(target);
  };

  for (let index = 0; index < pending.length; index++) {
    const [file, cwd] = pending[index];
    const key = JSON.stringify([file, cwd]);
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > MAX_GRAPH_FILES) throw new Error('反向依赖图超过安全上限 (' + MAX_GRAPH_FILES + ')');
    const current = state.files.has(file) ? work.read(file) : null;
    if (current && current.identity !== file) add(current.identity, file, cwd);
    const atBase = old.ids.has(file) ? old.text(file, current?.text ?? null) : null;
    if (!current && atBase === null) continue;
    for (const input of fixedInputs.get(file) ?? []) add(input, file, cwd);
    if (file === R9_READER) {
      const registry = state.files.has(R9_REGISTRY) ? work.read(R9_REGISTRY)?.text ?? null : null;
      const oldRegistry = old.ids.has(R9_REGISTRY) ? old.text(R9_REGISTRY, registry) : null;
      for (const input of new Set([...r9PinnedInputs(registry), ...r9PinnedInputs(oldRegistry)])) {
        add(path.posix.normalize(input), file, cwd);
      }
    }
    if (!GRAPH_SOURCE.test(file)) continue;
    const trees = [
      [current?.text ?? null, lookupCurrent, (file) => work.read(file)?.text ?? null],
      [atBase, lookupOld, (file) => old.text(file, work.read(file)?.text ?? null)],
    ];
    for (const [text, lookup, source] of trees) {
      if (text === null) continue;
      const syntax = scan(file, text);
      for (const { spec, style } of syntax.references) {
        const from = style === 'cwd-resource' ? path.posix.join(cwd, '<command>') : style === 'root-resource' ? '<root>' : file;
        for (const target of moduleTargets(from, spec, style, lookup, source)) add(target, file, cwd);
      }
      if (syntax.opaque.length > 0 || syntax.resourceScopes.length > 0) {
        const scopes = opaque.get(file) ?? new Map();
        for (const [spec, resource] of [...syntax.opaque.map((spec) => [spec, false]), ...syntax.resourceScopes.map((spec) => [spec, true])]) {
          const scope = spec === null ? '.' : resolve(file, spec);
          if (scope === '..' || scope.startsWith('../')) continue;
          const prefix = scope === '.' ? '' : scope.replace(/\/$/, '') + '/';
          scopes.set(prefix, resource || scopes.get(prefix) === true);
        }
        opaque.set(file, scopes);
      }
    }
  }
  return { readers, opaque };
}

const sameInputs = (a, b) => a.head === b.head && a.main === b.main && a.base === b.base &&
  JSON.stringify(a.seeds) === JSON.stringify(b.seeds) && a.files.size === b.files.size && [...a.files].every((file) => b.files.has(file));

function checkInputs(root, initial, cache) {
  if (!sameInputs(initial, targetInputs(root))) throw new Error('Git 基准或改动清单发生变化');
  const { read } = worktreeReader(root);
  for (const [file, before] of cache) {
    const now = read(file);
    if (before?.identity !== now?.identity || before?.digest !== now?.digest) throw new Error(file + ' 发生变化');
  }
}

// One local plan. The worker receives the individual file list and still uses
// planFiles for each original command, including separate known-failure policies.
export function planTargetedFiles(root, suite, named, { env = process.env, platform = hostPlatform() } = {}) {
  root = realpathSync.native(root);
  if (realpathSync.native(targetGit(root, ['rev-parse', '--show-toplevel']).trim()) !== root) {
    throw new Error('--root 必须指向 Git 工作树根目录');
  }
  const state = targetInputs(root);
  const work = worktreeReader(root);
  const currentFiles = new Set(state.files);
  const seeds = [...new Set([...state.seeds, ...named])];
  for (const file of seeds) if (!work.read(file)) currentFiles.delete(file);
  const graphState = { ...state, files: currentFiles };
  const groups = new Map([[suite, { suite, names: new Set(named), reasons: new Set() }]]);
  const deferred = new Map();
  const groupFor = (map, suite) => {
    if (!map.has(suite)) map.set(suite, { suite, names: new Set(), reasons: new Set() });
    return map.get(suite);
  };
  const matches = [];
  const matchKeys = new Set();
  const graphStart = performance.now();
  if (seeds.length) {
    const old = oldGraphInputs(root, state);
    const { entries, platforms, addedSuites } = targetedEntries(root, graphState, env, work);
    const { readers, opaque } = dependencyGraph(graphState, old, work, entries);
    const affected = reverseClosure(seeds, readers);
    const changed = reverseClosure(state.seeds, readers);
    for (const file of affected.parent.keys()) {
      for (const reader of registeredRuntimeReaders(file)) {
        if (!currentFiles.has(reader) || !work.read(reader)) throw new Error(file + ' 的登记读取者缺失：' + reader);
        if (reader === FLEET_REPLAY && !entries.get(reader)?.some(({ suite, whole }) => suite === 'production-schema' && !whole)) {
          throw new Error(file + ' 的回放入口未编入 production-schema：' + reader);
        }
      }
    }
    const fallback = (id, reason, on = platforms.get(id)) => {
      groupFor(on.includes(platform) ? groups : deferred, id).reasons.add(reason);
    };
    for (const [file, commands] of entries) {
      if (!affected.parent.has(file)) continue;
      for (const command of commands) {
        const explicit = command.suite === suite && named.has(file);
        // A named file by itself belongs to the requested suite. Actual changes
        // retain their existing cross-suite expansion even when also named.
        if (!explicit && named.has(file) && !changed.parent.has(file)) continue;
        const local = explicit || command.platforms.includes(platform);
        const group = groupFor(local ? groups : deferred, command.suite);
        group.names.add(file);
        if (command.whole && (!explicit || changed.parent.has(file))) group.reasons.add(file + ' 的命令只能整条执行');
        const key = JSON.stringify([command.suite, file, local]);
        if (!explicit && !matchKeys.has(key)) {
          matchKeys.add(key);
          const chain = named.has(file) ? changed.chain(file) : affected.chain(file);
          matches.push({ suite: command.suite, file, local, platforms: command.platforms, chain });
        }
      }
    }
    // An opaque load may also matter when a different reader has a static
    // edge for the same input. Widen the suites that reach the opaque reader.
    for (const [reader, scopes] of opaque) {
      const overlap = state.seeds.filter((file) => [...scopes].some(([scope, resource]) =>
        (resource || GRAPH_SOURCE.test(file)) && file.startsWith(scope)));
      if (!overlap.length) continue;
      const owners = reverseClosure([reader], readers).parent;
      const owningSuites = new Map();
      for (const file of owners.keys()) {
        for (const command of entries.get(file) ?? []) {
          const on = owningSuites.get(command.suite) ?? new Set();
          command.platforms.forEach((host) => on.add(host));
          owningSuites.set(command.suite, on);
        }
      }
      for (const [id, on] of owningSuites) fallback(id, overlap.join(', ') + ' 可能由 ' + reader + ' 动态加载', [...on]);
    }
    for (const file of state.seeds) {
      if (/\.ps1$/i.test(file)) fallback('powershell-count', file + ' 命中 PowerShell 全仓扫描');
      if (pureDocs(file)) continue;
      const known = readers.has(file) || entries.has(file);
      const resource = !GRAPH_SOURCE.test(file) && !SCRIPT_SOURCE.test(file);
      const ids = new Set(addedSuites);
      // A resource edge covers the suites reachable through that edge. Other
      // suites selected for this resource can still read it through composed paths.
      if (!known || resource) {
        for (const check of Object.keys(SUITES)) {
          for (const id of selectSuites(check, [file]).suites) ids.add(id);
        }
      }
      if (!known && !ids.size) throw new Error('覆盖未确定：' + file + ' 找不到引用边或适用套件');
      if (!ids.size) continue;
      for (const reader of reverseClosure([file], readers).parent.keys()) {
        for (const command of entries.get(reader) ?? []) ids.delete(command.suite);
      }
      for (const id of ids) {
        if (addedSuites.has(id)) {
          fallback(id, file + ' 缺少可静态定位的引用边，候选独有套件按 CI 选择整套执行');
          continue;
        }
        const onlyGlobal = Object.values(SUITES).some((check) => check[id]?.includes('**'));
        fallback(id, file + ' 缺少可静态定位的引用边，按 ' + (onlyGlobal ? '全仓 **' : 'SUITES / SELECT_ALL') + ' 规则兜底');
      }
    }
  }
  if (matches.length > MAX_PLAN_ENTRIES) throw new Error('定向计划超过安全上限 (' + MAX_PLAN_ENTRIES + ')');
  const graphMs = seeds.length ? Math.round(performance.now() - graphStart) : 0;
  // A path may change during planning itself. Check the same byte evidence
  // before acquiring a slot and after all groups complete.
  const verify = () => checkInputs(root, state, work.cache);
  verify();
  const ordered = (map) => [...map.values()].sort((a, b) => a.suite.localeCompare(b.suite)).map((group) => ({
    suite: group.suite, files: [...group.names].sort(), reasons: [...group.reasons].sort(),
  }));
  matches.sort((a, b) => a.suite.localeCompare(b.suite) || a.file.localeCompare(b.file));
  return { head: state.head, main: state.main, base: state.base, graphMs, matches, groups: ordered(groups), deferred: ordered(deferred), verify };
}

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
