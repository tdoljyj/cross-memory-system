import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EPHEMERAL_INITDB_FLAGS, EPHEMERAL_POSTGRES_FLAGS } from './cluster-cleanup.mjs';

// Every test file that sets postgresFlags or initdbFlags must take them from the ephemeral constants in
// cluster-cleanup.mjs, and must not append an option that changes what the constant sets, so a hand-written list
// cannot quietly bring back durable settings for a throwaway cluster.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join('/');
const TARGET = path.join(root, 'apps/clued-cloud/tests/cluster-cleanup.mjs');
// Frozen evidence and historical snapshots are copies of past runs; they are not edited.
const SKIP_DIRS = new Set(['node_modules', '.git', 'development', 'artifacts', 'history', 'evidence', 'readable']);
const SOURCE_FILE = /\.(mjs|js|ts)$/;
const TESTS_DIRECTORY = 'apps/clued-cloud/tests/';

// Settings that decide durability. An appended value must equal the constant's value, or the check fails.
const DURABILITY = new Set(['io_method', 'fsync', 'synchronous_commit', 'full_page_writes', 'wal_sync_method']);
const pgValues = new Map();
for (let i = 0; i < EPHEMERAL_POSTGRES_FLAGS.length; i += 2) {
  const [key, value] = EPHEMERAL_POSTGRES_FLAGS[i + 1].split('=');
  pgValues.set(key, value);
}

const RULES = [
  { name: 'postgresFlags', constant: 'EPHEMERAL_POSTGRES_FLAGS' },
  { name: 'initdbFlags', constant: 'EPHEMERAL_INITDB_FLAGS' },
];
const REGEX_BEFORE = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const KEYWORD_BEFORE = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// Lexes a source into two views: `code` (comments and regex bodies blanked, string literals kept, for reading
// option values) and `bare` (strings and regex bodies blanked too, for counting names that are really code).
// Anything it cannot close (unterminated string, comment or template) is reported in `problems`, never skipped.
function scan(source) {
  const n = source.length;
  const problems = [];
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  const lineOf = (k) => source.slice(0, k).split('\n').length;
  const quotedEnd = (j, q) => {
    let k = j + 1;
    while (k < n && source[k] !== q) {
      if (source[k] === '\n') return -1;
      k += source[k] === '\\' ? 2 : 1;
    }
    return k < n ? k + 1 : -1;
  };
  const templateEnd = (j) => {
    let k = j;
    while (k < n) {
      const ch = source[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '`') return k + 1;
      if (ch === '$' && source[k + 1] === '{') {
        k = exprEnd(k + 2);
        if (k < 0) return -1;
        continue;
      }
      k++;
    }
    return -1;
  };
  const exprEnd = (j) => {
    let depth = 1, k = j, prevE = '';
    while (k < n) {
      const ch = source[k];
      if (ch === "'" || ch === '"') { k = quotedEnd(k, ch); if (k < 0) return -1; prevE = '0'; continue; }
      if (ch === '`') { k = templateEnd(k + 1); if (k < 0) return -1; prevE = '0'; continue; }
      if (ch === '/' && source[k + 1] !== '/' && source[k + 1] !== '*' && (prevE === '' || REGEX_BEFORE.has(prevE))) {
        const e = regexEnd(k);
        if (e > 0) { k = e; prevE = '0'; continue; }
      }
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return k + 1;
      if (!/\s/.test(ch)) prevE = ch;
      k++;
    }
    return -1;
  };
  const regexEnd = (j) => {
    let k = j + 1, inClass = false;
    while (k < n && source[k] !== '\n') {
      const ch = source[k];
      if (ch === '\\') { k += 2; continue; }
      if (inClass) { if (ch === ']') inClass = false; }
      else if (ch === '[') inClass = true;
      else if (ch === '/') {
        k++;
        while (k < n && /[a-z]/i.test(source[k])) k++;
        return k;
      }
      k++;
    }
    return -1;
  };

  let code = '', bare = '', prev = '', i = 0;
  while (i < n) {
    const c = source[i], d = source[i + 1];
    if (c === '/' && d === '/') {
      const e = source.indexOf('\n', i);
      const stop = e < 0 ? n : e;
      code += blank(source.slice(i, stop)); bare += blank(source.slice(i, stop));
      i = stop;
    } else if (c === '/' && d === '*') {
      const e = source.indexOf('*/', i + 2);
      if (e < 0) { problems.push(`第 ${lineOf(i)} 行起的块注释未闭合`); break; }
      code += blank(source.slice(i, e + 2)); bare += blank(source.slice(i, e + 2));
      i = e + 2;
    } else if (c === '/' && (prev === '' || REGEX_BEFORE.has(prev) || KEYWORD_BEFORE.has(prev)) && regexEnd(i) > 0) {
      const e = regexEnd(i);
      code += blank(source.slice(i, e)); bare += blank(source.slice(i, e));
      prev = '0';
      i = e;
    } else if (c === "'" || c === '"') {
      const e = quotedEnd(i, c);
      if (e < 0) { problems.push(`第 ${lineOf(i)} 行的字符串未闭合`); break; }
      code += source.slice(i, e); bare += c + c;
      prev = '0';
      i = e;
    } else if (c === '`') {
      const e = templateEnd(i + 1);
      if (e < 0) { problems.push(`第 ${lineOf(i)} 行起的模板字符串未闭合`); break; }
      code += source.slice(i, e); bare += '``';
      prev = '0';
      i = e;
    } else if (/[A-Za-z_$0-9]/.test(c)) {
      let e = i;
      while (e < n && /[A-Za-z_$0-9]/.test(source[e])) e++;
      const word = source.slice(i, e);
      code += word; bare += word;
      prev = KEYWORD_BEFORE.has(word) ? word : '0';
      i = e;
    } else {
      code += c; bare += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return { code, bare, problems };
}

// Problems in the appended items of postgresFlags: strictly `'-c', 'key=value'` pairs, durability keys must match the constant.
function postgresProblems(items, name) {
  if (items.length % 2) return [`${name} 追加的选项不成对`];
  const found = [];
  for (let i = 0; i < items.length; i += 2) {
    if (items[i] !== '-c') { found.push(`${name} 追加了非 -c 写法 ${items[i]}`); continue; }
    const match = /^([a-z_]+)=(.*)$/.exec(items[i + 1]);
    if (!match) { found.push(`${name} 追加的选项写法不认 ${items[i + 1]}`); continue; }
    const [, key, value] = match;
    if (DURABILITY.has(key) && pgValues.get(key) !== value) found.push(`${name} 追加了与常量冲突的 ${key}=${value}`);
  }
  return found;
}

// Problems in the appended items of initdbFlags: only `--name` or `--name=value` spellings.
function initdbProblems(items, name) {
  return items.filter((item) => !/^--[a-z][a-z-]*(=.*)?$/.test(item)).map((item) => `${name} 追加的选项写法不认 ${item}`);
}

// Returns the problems found in one source file; an empty list means the file complies.
function violations(source, file) {
  const { code, bare, problems } = scan(source);
  if (problems.length) return problems.map((p) => `无法解析（扫描失步，请改写）：${p}`);
  const found = [];
  for (const { name, constant } of RULES) {
    // A name counts when it is code (bare identifier) or a quoted key such as 'postgresFlags' or ['postgresFlags'].
    const mentions = (bare.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
      + (code.match(new RegExp(`(['"])${name}\\1`, 'g')) ?? []).length;
    if (mentions === 0) continue;
    const key = `(?:\\b${name}\\b|'${name}'|"${name}"|\\[\\s*'${name}'\\s*\\]|\\[\\s*"${name}"\\s*\\])`;
    // Accepted values: `[...CONSTANT, <string literals only>]` or `CONSTANT`, and the value must end there.
    const form = new RegExp(`${key}\\s*:\\s*(?:\\[\\s*\\.\\.\\.${constant}\\b((?:\\s*,\\s*(?:'[^'\\n]*'|"[^"\\n]*"))*)\\s*,?\\s*\\]|${constant}\\b)(?=\\s*(?:[,)};\\n]|$))`, 'g');
    const matches = [...code.matchAll(form)];
    if (matches.length !== mentions) found.push(`${name} 未全部从 ${constant} 取值`);
    const imported = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/g)].some((m) =>
      m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).includes(constant)
      && file !== undefined && path.resolve(path.dirname(file), m[3]) === TARGET);
    if (!imported) found.push(`${name} 未从 cluster-cleanup.mjs 导入 ${constant}`);
    if (new RegExp(`(?:const|let|var|function|class)\\s+${constant}\\b`).test(code)) found.push(`${constant} 被本地声明遮住`);
    for (const match of matches) {
      const items = [...(match[1] ?? '').matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2]);
      found.push(...(name === 'postgresFlags' ? postgresProblems(items, name) : initdbProblems(items, name)));
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

const UNIT_FILE = path.join(root, 'apps/clued-cloud/tests/unit-fixture.test.mjs');
const IMPORT_LINE = "import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';\n";
const check = (body) => violations(IMPORT_LINE + body, UNIT_FILE);

test('unit: compliant options pass', () => {
  assert.deepEqual(check(`new EmbeddedPostgres({ persistent: false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS, '--locale=C'],
    postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=40'] });`), []);
});

test('unit: initdbFlags not taken from EPHEMERAL_INITDB_FLAGS fails', () => {
  assert.notDeepEqual(check(`new EmbeddedPostgres({ initdbFlags: ['--locale=C'], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS] });`), []);
});

test('unit: appended flags that change a durability setting fail', () => {
  for (const extra of ["'-c', 'fsync=on'", "'-c', 'synchronous_commit=on'", "'-c', 'full_page_writes=on'",
    "'-c', 'io_method=worker'", "'-c', 'wal_sync_method=fsync'"]) {
    assert.notDeepEqual(check(`new EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, ${extra}] });`), [], extra);
  }
});

test('unit: same-value repeats of the constant are redundant, not conflicts', () => {
  assert.deepEqual(check(`new EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'io_method=sync'] });`), []);
  assert.deepEqual(check(`new EmbeddedPostgres({ initdbFlags: [...EPHEMERAL_INITDB_FLAGS, '--no-sync'], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS] });`), []);
});

test('unit: appended non-literal or chained expressions fail', () => {
  assert.notDeepEqual(check(`new EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, ...extra] });`), []);
  assert.notDeepEqual(check(`new EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS].slice(0) });`), []);
});

test('unit: malformed option spellings that the server would still read fail', () => {
  for (const extra of ["'-c', ' fsync=on'", "'-cfsync=on'", "'--fsync=on'", "'-c', 'fsync = on'", "'fsync=on'"]) {
    assert.notDeepEqual(check(`new EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, ${extra}] });`), [], extra);
  }
});

test('unit: quoted and computed keys are checked like bare keys', () => {
  assert.deepEqual(check(`new EmbeddedPostgres({ 'postgresFlags': [...EPHEMERAL_POSTGRES_FLAGS] });`), []);
  assert.notDeepEqual(check(`new EmbeddedPostgres({ 'postgresFlags': [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'fsync=on'] });`), []);
  assert.notDeepEqual(check(`new EmbeddedPostgres({ ['postgresFlags']: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'fsync=on'] });`), []);
});

test('unit: a regex literal containing comment or quote markers does not hide later code', () => {
  assert.notDeepEqual(check(`const r = /a\\/*b/g;\nnew EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'fsync=on'] });`), []);
  assert.notDeepEqual(check(`const r = /'/;\nnew EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'fsync=on'] });`), []);
});

test('unit: a multi-line template literal does not hide later code', () => {
  assert.notDeepEqual(check("const s = `line one\nline two`;\nnew EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'fsync=on'] });"), []);
});

test('unit: a regex inside a template expression does not hide later code', () => {
  assert.deepEqual(check("const q = `'${String(v).replace(/'/g, \"''\")}'`;\nnew EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS] });"), []);
  assert.notDeepEqual(check("const q = `'${String(v).replace(/'/g, \"''\")}'`;\nnew EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'fsync=on'] });"), []);
});

test('unit: an unterminated string is reported, not skipped', () => {
  assert.notDeepEqual(check("const s = 'abc\nnew EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS] });"), []);
});

test('unit: the constant must come from cluster-cleanup.mjs and must not be shadowed', () => {
  assert.notDeepEqual(violations(`import { EPHEMERAL_POSTGRES_FLAGS } from './other.mjs';\nnew EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS] });`, UNIT_FILE), []);
  assert.notDeepEqual(check(`const EPHEMERAL_POSTGRES_FLAGS = [];\nnew EmbeddedPostgres({ postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS] });`), []);
});

test('unit: names inside comments and strings do not count', () => {
  assert.deepEqual(violations(`// postgresFlags: ['-c', 'fsync=on'] and initdbFlags: ['--no-sync'] were removed
/* initdbFlags is EPHEMERAL_INITDB_FLAGS now */
const note = 'postgresFlags and initdbFlags moved to cluster-cleanup';
`, UNIT_FILE), []);
});

test('every test file that sets postgresFlags or initdbFlags takes them from the ephemeral constants', async () => {
  const offenders = [];
  for (const file of await testFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (rel === self || !(rel.startsWith(TESTS_DIRECTORY) || /\.test\.(mjs|js|ts)$/.test(rel))) continue;
    const found = violations(await fs.readFile(file, 'utf8'), file);
    if (found.length) offenders.push(`${rel}: ${found.join(',')}`);
  }
  assert.deepEqual(offenders, []);
});
