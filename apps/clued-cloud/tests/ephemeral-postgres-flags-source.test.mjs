import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every test file that sets postgresFlags or initdbFlags must take them from the ephemeral constants in
// cluster-cleanup.mjs, and must not append a flag that the constant already sets, so a hand-written list
// cannot quietly bring back durable settings for a throwaway cluster.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join('/');
// Frozen evidence and historical snapshots are copies of past runs; they are not edited.
const SKIP_DIRS = new Set(['node_modules', '.git', 'development', 'artifacts', 'history', 'evidence', 'readable']);
const SOURCE_FILE = /\.(mjs|js|ts)$/;
const TESTS_DIRECTORY = 'apps/clued-cloud/tests/';

// Splits a source into two views: `code` (comments blanked, string literals kept, for reading flag values)
// and `bare` (comments and string contents blanked, for counting option names that really are code).
function scan(source) {
  let code = '', bare = '';
  let i = 0;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < source.length) {
    const c = source[i], d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < source.length && source[i] !== '\n') { code += ' '; bare += ' '; i++; }
    } else if (c === '/' && d === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      for (; i < stop; i++) { code += blank(source[i]); bare += blank(source[i]); }
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, source.length);
      code += source.slice(i, stop);
      bare += c + c;
      i = stop;
    } else {
      code += c; bare += c; i++;
    }
  }
  return { code, bare };
}

const RULES = [
  { name: 'postgresFlags', constant: 'EPHEMERAL_POSTGRES_FLAGS', conflicts: new Set(['io_method', 'fsync', 'synchronous_commit', 'full_page_writes']), keyOf: (value) => value.split('=')[0] },
  { name: 'initdbFlags', constant: 'EPHEMERAL_INITDB_FLAGS', conflicts: new Set(['--no-sync']), keyOf: (value) => value },
];

// Returns the problems found in one source file; an empty list means the file complies.
function violations(source) {
  const { code, bare } = scan(source);
  const found = [];
  for (const { name, constant, conflicts, keyOf } of RULES) {
    const mentions = bare.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
    if (mentions === 0) continue;
    // Accepted forms: `name: [...CONSTANT, <string literals only>]` or `name: CONSTANT`, ending the value.
    const form = new RegExp(`\\b${name}\\s*:\\s*(?:\\[\\s*\\.\\.\\.${constant}\\b((?:\\s*,\\s*(?:'[^'\\n]*'|"[^"\\n]*"))*)\\s*,?\\s*\\]|${constant}\\b)(?=\\s*(?:[,)};\\n]|$))`, 'g');
    const matches = [...code.matchAll(form)];
    if (matches.length !== mentions) found.push(`${name} 未全部从 ${constant} 取值`);
    if (!new RegExp(`import\\s*\\{[^}]*\\b${constant}\\b[^}]*\\}\\s*from`).test(code)) found.push(`${name} 未导入 ${constant}`);
    for (const match of matches) {
      for (const literal of [...(match[1] ?? '').matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2])) {
        if (conflicts.has(keyOf(literal))) found.push(`${name} 追加了与常量冲突的 ${literal}`);
      }
    }
  }
  return found;
}

async function testFiles(directory, found = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await testFiles(full, found);
    } else if (SOURCE_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const IMPORT_LINE = "import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';\n";

test('unit: compliant options pass', () => {
  assert.deepEqual(violations(IMPORT_LINE + `new EmbeddedPostgres({ persistent: false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS, '--locale=C'],
    postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=40'] });`), []);
});

test('unit: initdbFlags not taken from EPHEMERAL_INITDB_FLAGS fails', () => {
  assert.notDeepEqual(violations(IMPORT_LINE + `new EmbeddedPostgres({ initdbFlags: ['--locale=C'], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS] });`), []);
});

test('unit: appended flags that conflict with the constant fail', () => {
  for (const extra of ["'-c', 'fsync=on'", "'-c', 'synchronous_commit=on'", "'-c', 'full_page_writes=on'",
    "'-c', 'io_method=worker'", "'-c', 'io_method=sync'"]) {
    assert.notDeepEqual(violations(IMPORT_LINE + `new EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, ${extra}] });`), [], extra);
  }
});

test('unit: appended non-literal or chained expressions fail', () => {
  assert.notDeepEqual(violations(IMPORT_LINE + `new EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, ...extra] });`), []);
  assert.notDeepEqual(violations(IMPORT_LINE + `new EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS].slice(0) });`), []);
});

test('unit: appended --no-sync to initdbFlags fails', () => {
  assert.notDeepEqual(violations(IMPORT_LINE + `new EmbeddedPostgres({ initdbFlags: [...EPHEMERAL_INITDB_FLAGS, '--no-sync'], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS] });`), []);
});

test('unit: names inside comments and strings do not count', () => {
  assert.deepEqual(violations(`// postgresFlags: ['-c', 'fsync=on'] and initdbFlags: ['--no-sync'] were removed
/* initdbFlags is EPHEMERAL_INITDB_FLAGS now */
const note = 'postgresFlags and initdbFlags moved to cluster-cleanup';
`), []);
});

test('every test file that sets postgresFlags or initdbFlags takes them from the ephemeral constants', async () => {
  const offenders = [];
  for (const file of await testFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === self || !(rel.startsWith(TESTS_DIRECTORY) || /\.test\.(mjs|js|ts)$/.test(rel))) continue;
    const found = violations(await fs.readFile(file, 'utf8'));
    if (found.length) offenders.push(`${rel}: ${found.join(',')}`);
  }
  assert.deepEqual(offenders, []);
});
