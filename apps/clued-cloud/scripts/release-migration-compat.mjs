// Backward-compatibility check for the migrations of one promotion
// (development/contracts/release/ReleasePipeline.v0.1.md §6).
//
// The pipeline rolls a failed Worker back to the previous version but never
// rolls the database back automatically, and it applies expand migrations
// while the previous Worker still serves. Both are only safe when every
// expand migration still works with the previous Worker: it adds, but does
// not drop, rename, retype or tighten anything that existed before it. This
// check finds statements that can break the previous Worker on objects the
// file did not create itself. A migration that must break it declares so on
// its own line before its first statement:
//
//   -- clued-release: breaking <reason>
//
// Such a contract migration runs only after the new Worker is live and its
// smoke test passed, and the promotion then has no automatic Worker rollback.
// Dynamic SQL inside EXECUTE and function bodies is not inspected.
//
//   node scripts/release-migration-compat.mjs <file.sql>...   (exit 1 on an
//     undeclared breaking statement; JSON report on stdout)
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER_LINE = /^\s*--\s*clued-release:\s*breaking\s+(\S.*?)\s*$/;
const IDENT = '(?:"[^"]+"|[a-z_][a-z0-9_$]*)';
const QNAME = `(${IDENT}(?:\\s*\\.\\s*${IDENT})?)`;
const norm = (name) => name.replaceAll('"', '').replace(/\s+/g, '');

// Lower-case SQL with comments removed and string literals, E'' strings and
// dollar-quoted bodies replaced by placeholders, so a function body, a
// comment or a literal cannot trip a rule. Quoted identifiers keep their
// text, with any ';' inside them neutralised so statements split correctly.
export function stripSql(text) {
  const source = String(text);
  const parts = [];
  let index = 0;
  let plain = 0;
  const flush = (end, replacement) => {
    parts.push(source.slice(plain, end), replacement);
  };
  while (index < source.length) {
    const char = source[index];
    if (char === '-' && source[index + 1] === '-') {
      const end = source.indexOf('\n', index);
      flush(index, ' ');
      index = end < 0 ? source.length : end;
      plain = index;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      flush(index, ' ');
      index = end < 0 ? source.length : end + 2;
      plain = index;
    } else if (char === '$' && /[A-Za-z0-9_$]/.test(source[index - 1] ?? ' ') === false) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(index, index + 64));
      if (!tag) { index += 1; continue; }
      const end = source.indexOf(tag[0], index + tag[0].length);
      flush(index, ' $body$ ');
      index = end < 0 ? source.length : end + tag[0].length;
      plain = index;
    } else if (char === "'") {
      const escaped = /[eE]/.test(source[index - 1] ?? '') && !/[A-Za-z0-9_]/.test(source[index - 2] ?? ' ');
      let end = index + 1;
      while (end < source.length) {
        if (escaped && source[end] === '\\') end += 2;
        else if (source[end] === "'" && source[end + 1] === "'") end += 2;
        else if (source[end] === "'") break;
        else end += 1;
      }
      flush(escaped ? index - 1 : index, " '' ");
      index = end + 1;
      plain = index;
    } else if (char === '"') {
      const end = source.indexOf('"', index + 1);
      const stop = end < 0 ? source.length : end + 1;
      flush(index, source.slice(index, stop).replaceAll(';', '_'));
      index = stop;
      plain = index;
    } else {
      index += 1;
    }
  }
  parts.push(source.slice(plain));
  return parts.join('').toLowerCase().replace(/\s+/g, ' ');
}

// Argument types of a function signature, without names, modes or defaults.
function argumentTypes(args) {
  const list = [];
  let depth = 0;
  let current = '';
  for (const char of args) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { list.push(current); current = ''; } else current += char;
  }
  if (current.trim()) list.push(current);
  return list.map((arg) => {
    const words = arg.replace(/\s+default\s.*$|\s*=.*$/, '').trim()
      .replace(/^(?:in|out|inout|variadic)\s+/, '').split(' ');
    const type = words.length > 1 && !/^(?:double|character|timestamp|time|bit)$/.test(words[0])
      ? words.slice(1).join(' ') : words.join(' ');
    return type.replace(/\s+/g, '');
  }).join(',');
}

function functionSignatures(sql, verb) {
  const pattern = verb === 'drop'
    ? new RegExp(`\\bdrop\\s+function\\s+(?:if\\s+exists\\s+)?${QNAME}\\s*(?:\\(([^)]*)\\))?`, 'g')
    : new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+${QNAME}\\s*\\(([^)]*)\\)`, 'g');
  return [...sql.matchAll(pattern)].map((match) => ({
    at: match.index, name: norm(match[1]),
    types: match[2] === undefined ? null : argumentTypes(match[2]),
  }));
}

function createdRelations(sql) {
  const created = new Set();
  const pattern = new RegExp(
    `\\bcreate\\s+(?:unlogged\\s+|temporary\\s+|temp\\s+)?(?:table|view|materialized\\s+view|sequence|type|schema)\\s+(?:if\\s+not\\s+exists\\s+)?${QNAME}`, 'g');
  for (const match of sql.matchAll(pattern)) created.add(norm(match[1]));
  // A rename target is a name the previous Worker never used.
  const renamed = new RegExp(
    `\\balter\\s+(?:function|table|view)\\s+(?:(${IDENT})\\s*\\.\\s*)?${IDENT}\\s*(?:\\([^)]*\\))?\\s+rename\\s+to\\s+(${IDENT})`, 'g');
  for (const match of sql.matchAll(renamed)) created.add(norm(match[1] ? `${match[1]}.${match[2]}` : match[2]));
  return created;
}

// [rule, pattern, index of the capture naming the object, or null]
const RULES = Object.freeze([
  ['drop_relation', new RegExp(`^\\s*drop\\s+(?:table|view|materialized\\s+view|schema|type|sequence|index)\\s+(?:if\\s+exists\\s+)?${QNAME}`), 1],
  ['drop_cascade', /^\s*drop\s+.*\bcascade\s*$/, null],
  ['drop_column', new RegExp(`^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QNAME}.*\\bdrop\\s+(?:column\\b|(?!constraint\\b|default\\b|not\\b|policy\\b|trigger\\b|index\\b|identity\\b|expression\\b)[a-z_"])`), 1],
  ['rename', new RegExp(`^\\s*alter\\s+(?:table|view|materialized\\s+view|sequence|index|type|schema)\\s+(?:if\\s+exists\\s+)?${QNAME}.*\\b(?:rename|set\\s+schema)\\b`), 1],
  ['retype_column', new RegExp(`^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QNAME}.*\\balter\\s+(?:column\\s+)?${IDENT}\\s+(?:set\\s+data\\s+)?type\\b`), 1],
  ['set_not_null', new RegExp(`^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QNAME}.*\\bset\\s+not\\s+null\\b`), 1],
  ['enable_rls', new RegExp(`^\\s*alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${QNAME}.*\\b(?:enable|force)\\s+row\\s+level\\s+security\\b`), 1],
]);

export function classifyMigration(text) {
  const raw = String(text);
  const sql = stripSql(raw);
  const createdHere = createdRelations(sql);
  const creates = functionSignatures(sql, 'create');
  for (const created of creates) createdHere.add(created.name);
  const findings = [];
  let offset = 0;
  for (const statement of sql.split(';')) {
    const start = offset;
    offset += statement.length + 1;
    for (const [rule, pattern, group] of RULES) {
      const match = pattern.exec(statement);
      if (!match) continue;
      const object = group === null ? null : norm(match[group]);
      // An object this file created is new to the previous Worker as well.
      if (object && createdHere.has(object)) {
        const createdBefore = creates.some((create) => create.name === object && create.at < start)
          || new RegExp(`\\bcreate\\b[^;]*\\b${object.replace(/[.$]/g, '\\$&')}\\b`).test(sql.slice(0, start));
        if (createdBefore) continue;
      }
      // Renaming a function and creating a wrapper under its old name keeps
      // the name the previous Worker calls; a policy dropped and created again
      // under the same name in this file is a replacement.
      findings.push({ rule, statement: statement.trim().slice(0, 160) });
    }
    const renamed = new RegExp(`^\\s*alter\\s+function\\s+${QNAME}\\s*\\(([^)]*)\\)\\s+(?:rename\\b|set\\s+schema\\b)`).exec(statement);
    if (renamed) {
      const name = norm(renamed[1]);
      const types = argumentTypes(renamed[2]);
      const wrapped = creates.some((create) => create.at > start && create.name === name && create.types === types);
      if (!wrapped && !createdHere.has(name)) findings.push({ rule: 'rename_function', statement: statement.trim().slice(0, 160) });
    }
    const policy = new RegExp(`^\\s*drop\\s+policy\\s+(?:if\\s+exists\\s+)?(${IDENT})\\s+on\\s+${QNAME}`).exec(statement);
    if (policy) {
      const recreated = new RegExp(`\\bcreate\\s+policy\\s+${policy[1].replace(/[$]/g, '\\$&')}\\s+on\\s+${policy[2].replace(/[.$]/g, '\\$&')}\\b`)
        .test(sql.slice(start));
      if (!recreated && !createdHere.has(norm(policy[2]))) {
        findings.push({ rule: 'drop_policy', statement: statement.trim().slice(0, 160) });
      }
    }
  }
  // A drop of a function signature this file created earlier is a temporary
  // helper. A drop of one that existed before the file is gone for the
  // previous Worker, or, when the name is created again, a signature change.
  for (const drop of functionSignatures(sql, 'drop')) {
    const helper = creates.some((create) => create.at < drop.at && create.name === drop.name
      && (drop.types === null || create.types === drop.types));
    if (helper) continue;
    const recreated = creates.some((create) => create.name === drop.name);
    findings.push({ rule: recreated ? 'function_signature_change' : 'drop_function',
      statement: `${drop.name}(${drop.types ?? ''})` });
  }
  return { breaking: findings.length > 0, declared: declaredReason(raw), findings };
}

// The declaration counts only as a full-line comment before the first
// statement, so a literal or a later comment cannot declare a file breaking.
export function declaredReason(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const marker = MARKER_LINE.exec(line);
    if (marker) return marker[1];
    if (line.trim() && !/^\s*--/.test(line)) return null;
  }
  return null;
}

// The promotion's plan: expand files run before the deploy; declared contract
// files run after the new Worker passed its smoke test and leave the promotion
// without automatic Worker rollback; an undeclared breaking file blocks.
export function evaluatePromotionMigrations(files) {
  const results = files.map(({ name, text }) => ({ name, ...classifyMigration(text) }));
  const undeclared = results.filter((result) => result.breaking && !result.declared);
  const contract = results.filter((result) => result.declared);
  return {
    contract: 'clued.release-migration-compat.v1',
    status: undeclared.length ? 'blocked' : 'ok',
    expand: results.filter((result) => !result.declared).map((result) => result.name),
    contract_after_deploy: contract.map((result) => result.name),
    worker_rollback: contract.length || undeclared.length ? 'until_contract_migrations' : 'automatic',
    files: results,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) throw new Error('usage: release-migration-compat.mjs <file.sql>...');
  const files = [];
  for (const path of argv) files.push({ name: basename(path), text: await readFile(path, 'utf8') });
  const report = evaluatePromotionMigrations(files);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'release_migration_compat_error'}\n`);
    process.exitCode = 2;
  });
}
