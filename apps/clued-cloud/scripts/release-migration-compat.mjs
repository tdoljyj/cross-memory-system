// Backward-compatibility check for pending migrations, run by migration-verify
// (scripts/production-schema-drift.mjs) on the production snapshot replay.
//
// A migration is applied while the previous Worker still serves, and a failed
// deploy rolls the Worker back but never the database. So a pending migration
// must only add: it may not drop, rename, retype or tighten anything that
// existed before it. This finds such statements on objects the file did not
// create itself. A migration that must break the previous Worker (a contract
// step) declares so on its own line before its first statement:
//
//   -- clued-release: breaking <reason>
//
// Dynamic SQL inside EXECUTE and function bodies is not inspected.
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

const REASONS = Object.freeze({
  drop_relation: 'the previous Worker may still read or write the dropped object',
  drop_cascade: 'CASCADE also drops dependent objects the previous Worker may use',
  drop_column: 'the previous Worker may still select or write the dropped column',
  rename: 'the previous Worker still addresses the object by its old name',
  rename_function: 'the previous Worker still calls the function by its old name',
  retype_column: 'values the previous Worker sends or reads may no longer fit the new type',
  set_not_null: 'inserts from the previous Worker that leave the column empty would fail',
  enable_rls: 'queries of the previous Worker may start returning no rows or failing',
  drop_policy: "the previous Worker's access that the policy allowed would be denied",
  drop_function: 'the previous Worker may still call the dropped function',
  function_signature_change: 'the previous Worker calls the old signature, which no longer exists',
});

// Findings for the pending migration steps ({file, text}) that can break the
// previous Worker and do not declare it. Already applied files are never
// passed in, so history cannot turn a check red.
export function pendingBreakingFindings(pending) {
  const findings = [];
  for (const step of pending) {
    const result = classifyMigration(step.text);
    if (!result.breaking || result.declared) continue;
    for (const finding of result.findings) {
      findings.push({ file: step.file, rule: finding.rule, statement: finding.statement, reason: REASONS[finding.rule] });
    }
  }
  return findings;
}
