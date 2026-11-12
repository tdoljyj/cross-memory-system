#!/usr/bin/env node
// CI check ci-deps-entry: every npm dependency install in the CI scripts and
// workflows goes through scripts/ci/ci-deps.mjs (offline from the runner's
// store; preparing the store is its one networked step). Any other npm ci /
// npm install fails CI.
//
// Scanned: .github/workflows, .github/actions, scripts/ci, scripts/runner
// (not test files, fixtures or JSON snapshots). Shell text may not run npm
// with an install command (ci, install, add, update and their aliases, after
// any options), in a shell file or in a line of program code that starts a
// command (execSync("npm ci")); program code may also not hand npm an install
// command as an argument list ([npm, "ci"], npm(['ci']), spawn('npm', ['install'])).
//
// ci-deps-legacy.json lists the installs that predate ci-deps.mjs in the
// protected workflow files, which only a protected change can move to it. Only
// workflow lines can be listed, and against the base commit the list only
// shrinks: a line it does not list, a listed line that is gone, or a listed
// line the base did not list fails the check.
//
//   node scripts/ci/check-ci-deps-entry.mjs [--root <checkout>] [--base <commit>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRY = 'scripts/ci/ci-deps.mjs';
export const LEGACY = 'scripts/ci/ci-deps-legacy.json';
const SCOPE = ['.github/workflows', '.github/actions', 'scripts/ci', 'scripts/runner'];
const SHELL_FILE = /\.(ya?ml|sh|bash|ps1|psm1|cmd|bat)$/i;
const CODE_FILE = /\.(mjs|cjs|js|ts|py)$/i;
// Test files and fixtures hold these words as data; JSON files here are snapshots, not commands.
const NOT_SCANNED = /(^|\/)fixtures?\/|\.test\.[a-z]+$|(^|\/)test_[^/]*\.py$/i;
// npm's commands that install packages, with their aliases (npm 11).
const INSTALLS = ['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean', 'install', 'add', 'i', 'in', 'ins', 'inst', 'insta',
  'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'install-test', 'it', 'install-ci-test', 'cit', 'clean-install-test', 'sit',
  'update', 'up', 'upgrade', 'udpate'].join('|');
const SUB = String.raw`(?:${INSTALLS})(?=$|[\s;&|)"'` + '`' + String.raw`,\]])`;
// npm, any options before the command (an option's value is never the command itself), then an install command.
const SHELL_INSTALL = new RegExp(String.raw`\bnpm(?:\.cmd)?(?:\s+--?[\w-]+(?:=\S*|\s+(?!-|${SUB})[^\s;&|]+)?)*\s+${SUB}`);
// npm handed an install command in an argument list.
const CODE_INSTALL = new RegExp(String.raw`\bnpm\w*\b[^\n]{0,80}?['"](?:${INSTALLS})['"]`);
// A line of program code that starts a command (shell text in a message is not one).
const EXEC_CALL = /\b(?:exec\w*|spawn\w*|run|system|Popen|call|check_call|check_output|execa\w*)\s*\(/;
const COMMENT = /^\s*(#|\/\/|\*|\/\*|rem\s|::)/i;
const YAML_NAME = /^\s*-?\s*name:/;
// Pinned copies of historical workflow definitions: data, never run.
const SNAPSHOT_LINES = [['scripts/ci/clued-workflow-profile.mjs', 'const SOURCE3_WORKFLOW_DEFINITIONS = ']];

export function offendingLines(file, text) {
  if (file === ENTRY || NOT_SCANNED.test(file)) return [];
  const shell = SHELL_FILE.test(file);
  if (!shell && !CODE_FILE.test(file)) return [];
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (COMMENT.test(line) || (shell && YAML_NAME.test(line))) return;
    if (SNAPSHOT_LINES.some(([name, start]) => name === file && line.startsWith(start))) return;
    // program code that starts a command is checked for shell text too: execSync("npm ci"), subprocess.run("npm install", shell=True)
    const shellText = SHELL_INSTALL.test(line) && (shell || EXEC_CALL.test(line));
    if (shellText || (!shell && CODE_INSTALL.test(line))) found.push({ file, line: line.trim(), number: index + 1 });
  });
  return found;
}

export function readLegacy(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.entries)) throw new Error(`${LEGACY}: entries must be a list`);
  for (const entry of data.entries) {
    if (typeof entry?.file !== 'string' || typeof entry.line !== 'string' || !entry.file.startsWith('.github/workflows/')) {
      throw new Error(`${LEGACY}: only a line of a protected workflow file may be listed: ${JSON.stringify(entry)}`);
    }
  }
  return data.entries;
}

const counts = (entries) => {
  const map = new Map();
  for (const { file, line } of entries) map.set(`${file}\0${line}`, (map.get(`${file}\0${line}`) ?? 0) + 1);
  return map;
};
const shown = (key) => key.replace('\0', ': ');

// found: offending lines; legacy: the list; base: the base commit's list (null: the base has none yet).
// Returns the problems (empty: pass).
export function verdict(found, legacy, base = null) {
  const left = counts(legacy);
  const problems = [];
  for (const hit of found) {
    const key = `${hit.file}\0${hit.line}`;
    if (left.get(key) > 0) left.set(key, left.get(key) - 1);
    else problems.push(`${hit.file}:${hit.number}: installs dependencies without ${ENTRY}: ${hit.line}\n` +
      `    use: node ${ENTRY} install <app-dir>  (offline; it prepares the store, the only networked step, when a package is missing)`);
  }
  for (const [key, count] of left) if (count > 0) problems.push(`${LEGACY} lists a line that is gone (${count}x), remove it: ${shown(key)}`);
  if (base) {
    const allowed = counts(base);
    for (const [key, count] of counts(legacy)) {
      if (count > (allowed.get(key) ?? 0)) problems.push(`${LEGACY} may only shrink; the base does not list: ${shown(key)}`);
    }
  }
  return problems;
}

export function baseLegacy(root, base) {
  try {
    return readLegacy(execFileSync('git', ['show', `${base}:${LEGACY}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null; // the base predates the list (the change that adds it)
  }
}

export function scan(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--', ...SCOPE], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return files.flatMap((file) => {
    const full = path.join(root, file);
    return fs.existsSync(full) ? offendingLines(file, fs.readFileSync(full, 'utf8')) : [];
  });
}

export function main(argv = process.argv.slice(2)) {
  const option = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);
  const root = path.resolve(option('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const base = option('--base');
  const problems = verdict(scan(root), readLegacy(fs.readFileSync(path.join(root, LEGACY), 'utf8')), base ? baseLegacy(root, base) : null);
  if (problems.length === 0) {
    console.log(`ci-deps-entry: every CI dependency install goes through ${ENTRY}`);
    return 0;
  }
  console.error(problems.join('\n'));
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
