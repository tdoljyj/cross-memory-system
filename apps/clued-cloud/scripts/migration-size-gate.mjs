#!/usr/bin/env node
// Capacity gate before a production migration (FABLE-prod-db-shrink-v2-20261124 §8, B3).
//
//   node scripts/migration-size-gate.mjs --size-bytes <n> --files <a.sql,b.sql>
//
// The release workflow's migrate mode reads pg_database_size with the migration
// login and runs this before the encrypted backup, so a refused migration costs
// no full backup. This command reads no database; it only decides:
//   - below THRESHOLD_BYTES: pass;
//   - at or above it: refuse every file with a statement that adds storage
//     (create table, create table ... as, select ... into, create materialized
//     view, create [unique] index, alter table ... add column / add primary key,
//     unique or exclude), with file, line and statement;
//   - except a file that declares, on its own comment line before its first
//     statement, `-- clued-release: shrink <reason>` and adds indexes only.
// Statements are found with the migration tokenizer (scripts/ci/sql-tokens.mjs):
// top-level SQL, DO bodies and the text of a literal EXECUTE in a DO body are
// judged; function bodies are not (they run when called, not when the file is
// applied). A DO body that EXECUTEs anything but one literal is judged by every
// string literal of that body instead (§12): a literal that holds an adding
// statement at its start or after a semicolon refuses the file; a literal the
// tokenizer cannot read counts as an addition. SELECT ... INTO counts only in the
// file's top-level SQL, never in text from a literal (§13): EXECUTE refuses it
// (0A000, tests/migration-size-gate-db.test.mjs) and in a function body it assigns
// variables. A file the tokenizer cannot read is refused at or above the
// threshold and passes with a warning below it.
// There is no option to change the threshold. Exit 0 pass, 1 refused, 2 usage.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlTokens } from '../../../scripts/ci/sql-tokens.mjs';

const LIMIT_BYTES = 500 * 1024 * 1024;
export const THRESHOLD_BYTES = Math.floor(LIMIT_BYTES * 0.85);

const SHRINK_LINE = /^\s*--\s*clued-release:\s*shrink\s+(\S.*?)\s*$/;
// The declaration counts only as a full-line comment before the first
// statement (as release-migration-compat.mjs reads `breaking`).
export function shrinkReason(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const marker = SHRINK_LINE.exec(line);
    if (marker) return marker[1];
    if (line.trim() && !/^\s*--/.test(line)) return null;
  }
  return null;
}

const isCode = (token, ...values) => token?.kind === 'code' && (values.length === 0 || values.includes(token.value));
// Where a statement may start: the beginning of a text, after `;`, or inside a
// plpgsql body after the words that open a statement list.
const STATEMENT_OPENERS = [';', 'begin', 'then', 'else', 'loop'];
const atStatementStart = (tokens, index) => index === 0 || isCode(tokens[index - 1], ...STATEMENT_OPENERS);

function statementEnd(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isCode(token)) continue;
    if (token.value === '(' || token.value === '[') depth += 1;
    else if (token.value === ')' || token.value === ']') depth -= 1;
    else if (token.value === ';' && depth === 0) return index;
  }
  return tokens.length;
}

// Tokens of one statement at parenthesis depth 0, with their index.
function* topLevel(tokens) {
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (isCode(token, ')', ']')) depth -= 1;
    if (depth === 0) yield [index, token];
    if (isCode(token, '(', '[')) depth += 1;
  }
}

function render(tokens) {
  return tokens.slice(0, 10).map((token) => (token.kind === 'code' ? token.value
    : token.kind === 'identifier' ? `"${token.value}"` : "'…'")).join(' ').replace(/ \. /g, '.');
}

function createKind(statement) {
  let index = 1;
  if (isCode(statement[index], 'or') && isCode(statement[index + 1], 'replace')) index += 2;
  if (isCode(statement[index], 'global', 'local')) index += 1;
  if (isCode(statement[index], 'temp', 'temporary')) return null;
  if (isCode(statement[index], 'unlogged')) index += 1;
  if (isCode(statement[index], 'table')) return 'table';
  if (isCode(statement[index], 'materialized') && isCode(statement[index + 1], 'view')) return 'materialized view';
  if (isCode(statement[index], 'unique')) index += 1;
  if (isCode(statement[index], 'index')) return 'index';
  return null;
}

function alterTableKinds(statement) {
  const kinds = [];
  for (const [index, token] of topLevel(statement)) {
    if (!isCode(token, 'add')) continue;
    const next = statement[index + 1];
    if (isCode(next, 'constraint')) {
      if (isCode(statement[index + 3], 'primary', 'unique', 'exclude')) kinds.push('add constraint');
    } else if (isCode(next, 'primary', 'unique', 'exclude')) kinds.push('add constraint');
    else if (!isCode(next, 'check', 'foreign', 'generated', 'not')) kinds.push('add column');
  }
  return kinds;
}

// SELECT ... INTO <table> in top-level SQL creates a table (in plpgsql it assigns
// variables; through EXECUTE PostgreSQL refuses it).
function selectIntoKind(statement) {
  const words = [...topLevel(statement)];
  const verb = statement[0].value === 'with'
    ? words.find(([index, token]) => index > 0 && isCode(token, 'select', 'insert', 'update', 'delete', 'merge'))
    : words[0];
  if (!verb || !isCode(verb[1], 'select')) return null;
  const into = words.find(([index, token]) => index > verb[0] && isCode(token, 'into'));
  if (!into) return null;
  return isCode(statement[into[0] + 1], 'temp', 'temporary') ? null : 'select into';
}

function bodyOfDo(tokens, index) {
  if (isCode(tokens[index - 1], 'do')) return true;
  return isCode(tokens[index - 2], 'language') && isCode(tokens[index - 3], 'do');
}

// A string literal judged as the SQL it holds. A literal the tokenizer cannot read
// cannot be judged and counts as an addition, as an unreadable file does.
function scanLiteral(token, additions) {
  let tokens;
  try {
    tokens = sqlTokens(token.value, token.line);
  } catch (error) {
    additions.push({ kind: 'unreadable literal', line: token.line, statement: `${render([token])} (${error.message})` });
    return;
  }
  scan(tokens, false, additions, null, true);
}

// A DO body: its statements, and, when it executes anything but one literal, every
// string literal of the body (FABLE-prod-db-shrink-v2-20261124 §12): the statement
// it builds is written in one of them (a constant, a format or replace argument).
function scanDo(tokens, additions) {
  const body = { dynamic: false, judged: new Set() };
  scan(tokens, true, additions, body);
  if (!body.dynamic) return;
  for (const token of tokens) {
    if (token.kind === 'literal' && !body.judged.has(token)) scanLiteral(token, additions);
  }
}

function scan(tokens, plpgsql, additions, body = null, fromLiteral = false) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'literal' && bodyOfDo(tokens, index)) {
      scanDo(sqlTokens(token.value, token.line), additions);
      continue;
    }
    if (token.kind !== 'code' || !atStatementStart(tokens, index)) continue;
    const end = statementEnd(tokens, index);
    const statement = tokens.slice(index, end);
    const add = (kind) => additions.push({ kind, line: token.line, statement: render(statement) });
    if (token.value === 'create') {
      const kind = createKind(statement);
      if (kind) add(kind);
    } else if (token.value === 'alter' && isCode(statement[1], 'table')) {
      alterTableKinds(statement).forEach(add);
    } else if (!plpgsql && !fromLiteral && (token.value === 'select' || token.value === 'with')) {
      const kind = selectIntoKind(statement);
      if (kind) add(kind);
    } else if (plpgsql && token.value === 'execute') {
      let stop = statement.findIndex((part, at) => at > 0 && isCode(part, 'using', 'into'));
      if (stop < 0) stop = statement.length;
      const argument = statement.slice(1, stop);
      if (argument.length === 1 && argument[0].kind === 'literal') {
        body?.judged.add(argument[0]);
        scanLiteral(argument[0], additions);
      } else if (body) {
        body.dynamic = true;
      }
    }
  }
}

// One file: its shrink declaration, every statement that adds storage, and the
// tokenizer's error when it cannot read the file.
export function judgeMigration(text) {
  const shrink = shrinkReason(text);
  try {
    const additions = [];
    scan(sqlTokens(String(text)), false, additions);
    return { shrink, additions };
  } catch (error) {
    return { shrink, additions: [], error: error.message };
  }
}

const USAGE = 'usage: node scripts/migration-size-gate.mjs --size-bytes <n> --files <a.sql,b.sql>';

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!['--size-bytes', '--files'].includes(flag) || value === undefined || Object.hasOwn(values, flag)) return null;
    values[flag] = value;
  }
  const size = values['--size-bytes'];
  const files = (values['--files'] ?? '').split(',').filter(Boolean);
  if (!/^\d+$/.test(size ?? '') || !Number.isSafeInteger(Number(size)) || files.length === 0) return null;
  return { size: Number(size), files };
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  const parsed = parseArguments(argv);
  if (!parsed) {
    error(USAGE);
    return 2;
  }
  const { size, files } = parsed;
  const judged = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (cause) {
      error(`::error::容量门：读不到迁移文件 ${file}（${cause.code ?? cause.message}）`);
      return 1;
    }
    judged.push({ file, ...judgeMigration(text) });
  }
  const at = size >= THRESHOLD_BYTES;
  const where = `库 ${size} 字节，阈值 ${THRESHOLD_BYTES} 字节（500 MB 的 85%）`;
  const refused = [];
  for (const { file, shrink, additions, error: unreadable } of judged) {
    if (unreadable) {
      if (at) {
        refused.push(file);
        error(`${file}: ${unreadable}`);
      } else {
        log(`::warning::容量门：${file} 无法按语句识别（${unreadable}）；库在阈值以下，放行`);
      }
      continue;
    }
    if (!at || additions.length === 0) continue;
    if (shrink && additions.every((item) => item.kind === 'index')) {
      log(`容量门：${file} 声明 shrink（${shrink}），只新增索引，放行`);
      continue;
    }
    refused.push(file);
    if (shrink) error(`${file}: 声明了 clued-release: shrink 的迁移只能新增索引（create index）`);
    for (const item of additions) error(`${file}:${item.line}: ${item.statement}`);
  }
  if (refused.length > 0) {
    error(`::error title=容量门::${where}，拒绝新增表、索引或列的迁移：${refused.map((file) => path.basename(file)).join(', ')}。先上线清理迁移（只删改、或声明 shrink 只建索引）把库降到阈值以下。生产没有变化。`);
    return 1;
  }
  log(`容量门：${where}；${at ? '所有文件都不新增存储' : '阈值以下'}，放行`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
