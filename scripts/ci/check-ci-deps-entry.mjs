#!/usr/bin/env node
// CI check ci-deps-entry: every npm dependency install in the CI scripts and
// workflows goes through scripts/ci/ci-deps.mjs (prepare: the one networked
// step; install: offline from the runner's store). Any other npm ci / npm
// install fails CI.
//
// Scanned: .github/workflows, .github/actions, scripts/ci, scripts/runner
// (not tests, fixtures or JSON snapshots). Shell text (workflows, .sh, .ps1)
// may not say `npm ci|install|i|add`; program code (.mjs, .js, .py, ...) may not
// pass "ci"/"install"/"add" as npm's first argument.
//
// ci-deps-legacy.json lists the installs that predate ci-deps.mjs in the
// protected workflow files, which only a protected change can move to it. Only
// workflow lines can be listed, the list only shrinks: a listed line that is no
// longer there fails until it is removed, and an unlisted one fails at once.
//
//   node scripts/ci/check-ci-deps-entry.mjs [--root <checkout>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRY = 'scripts/ci/ci-deps.mjs';
export const LEGACY = 'scripts/ci/ci-deps-legacy.json';
const SCOPE = ['.github/workflows', '.github/actions', 'scripts/ci', 'scripts/runner'];
const SHELL_FILE = /\.(ya?ml|sh|bash|ps1|psm1)$/i;
const CODE_FILE = /\.(mjs|cjs|js|ts|py)$/i;
const NOT_SCANNED = /(^|\/)(tests?|fixtures?)\/|\.test\.[a-z]+$|(^|\/)test_[^/]*\.py$/i;
const SHELL_INSTALL = /\bnpm(?:\.cmd)?\s+(?:ci|install|i|add)(?=\s|$|[;&|)"'`])/;
const CODE_INSTALL = /\bnpm\w*\b[^\n]{0,40}?['"](?:ci|install|add)['"]/;
const COMMENT = /^\s*(#|\/\/|\*|\/\*)/;

export function offendingLines(file, text) {
  if (file === ENTRY || NOT_SCANNED.test(file)) return [];
  const pattern = SHELL_FILE.test(file) ? SHELL_INSTALL : CODE_FILE.test(file) ? CODE_INSTALL : null;
  if (!pattern) return [];
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!COMMENT.test(line) && pattern.test(line) && !line.includes('ci-deps.mjs')) found.push({ file, line: line.trim(), number: index + 1 });
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

// found: offending lines; legacy: listed ones. Returns the problems (empty: pass).
export function verdict(found, legacy) {
  const left = new Map();
  for (const { file, line } of legacy) left.set(`${file}\0${line}`, (left.get(`${file}\0${line}`) ?? 0) + 1);
  const problems = [];
  for (const hit of found) {
    const key = `${hit.file}\0${hit.line}`;
    if (left.get(key) > 0) left.set(key, left.get(key) - 1);
    else problems.push(`${hit.file}:${hit.number}: installs dependencies without ${ENTRY}: ${hit.line}\n` +
      `    use: node ${ENTRY} prepare <app-dir>  (networked, once per lockfile)  then  node ${ENTRY} install <app-dir>  (offline)`);
  }
  for (const [key, count] of left) {
    if (count > 0) problems.push(`${LEGACY} lists a line that is gone (${count}x), remove it: ${key.replace('\0', ': ')}`);
  }
  return problems;
}

export function scan(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--', ...SCOPE], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return files.flatMap((file) => {
    const full = path.join(root, file);
    return fs.existsSync(full) ? offendingLines(file, fs.readFileSync(full, 'utf8')) : [];
  });
}

export function main(argv = process.argv.slice(2)) {
  const at = argv.indexOf('--root');
  const root = path.resolve(at >= 0 ? argv[at + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const problems = verdict(scan(root), readLegacy(fs.readFileSync(path.join(root, LEGACY), 'utf8')));
  if (problems.length === 0) {
    console.log(`ci-deps-entry: every CI dependency install goes through ${ENTRY}`);
    return 0;
  }
  console.error(problems.join('\n'));
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
