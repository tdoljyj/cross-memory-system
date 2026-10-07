// Production migration ledger: the committed record of every row of
// production's supabase_migrations.schema_migrations and of the repository
// file that carries its text (docs/maintenance/migration-ledger.md).
//
//   node scripts/migration-ledger.mjs verify
//     Offline: every ledger row resolves to a repository file whose text, after
//     the recorded line-ending transform, has the recorded md5; every migration
//     file is either carried by a row or listed under repository_only.
//   node scripts/migration-ledger.mjs compare (--history rows.json | --database-url URL)
//     Online: production history ⊆ ledger (same version, name and md5) and
//     ledger ⊆ production history. A production row the ledger lacks is an
//     error unless a migration file carries its exact text; then it is a
//     warning with the row to add.
//   node scripts/migration-ledger.mjs export (--history rows.json | --database-url URL) [--out PATH]
//     Rebuilds the rows from production history, keeping repository_only and
//     known_deviations, and writes the text of a row no migration file carries
//     to supabase/ledger/history-only/.
//
// rows.json is a JSON array of {version, name, statements} as the table holds
// them (statements is text[]); a row may carry statements_md5 instead of
// statements when only the hash is known.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_CONTRACT = 'clued.production-migration-ledger.v1';
export const TRANSFORMS = ['identical', 'append_crlf', 'strip_final_newline', 'crlf', 'cr_crlf'];
export const REPOSITORY_ONLY_STATUSES = ['never_applied', 'diverged_from_production'];
export const MIGRATION_FILENAME = /^\d{12,14}_[a-z0-9_]+\.sql$/;
export const HISTORY_ONLY_FILENAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const appDirectory = join(scriptDirectory, '..');
export const migrationsDirectory = join(appDirectory, 'supabase', 'migrations');
export const ledgerDirectory = join(appDirectory, 'supabase', 'ledger');
export const historyOnlyDirectory = join(ledgerDirectory, 'history-only');
export const ledgerPath = join(ledgerDirectory, 'production-history.json');

export const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

// The text production holds for a migration applied from this file. The
// release workflow records the file's exact text (identical); earlier applies
// through other tools recorded a CRLF copy, an appended CRLF, a stripped final
// newline, or a doubled carriage return before each newline.
export function applyTransform(text, transform) {
  switch (transform) {
    case 'identical': return text;
    case 'append_crlf': return `${text}\r\n`;
    case 'strip_final_newline': return text.endsWith('\n') ? text.slice(0, -1) : text;
    case 'crlf': return text.replace(/\r?\n/g, '\r\n');
    case 'cr_crlf': return text.replace(/\r?\n/g, '\r\r\n');
    default: throw new Error(`unknown_transform:${transform}`);
  }
}

export function matchTransform(text, expectedMd5) {
  for (const transform of TRANSFORMS) {
    if (md5(applyTransform(text, transform)) === expectedMd5) return transform;
  }
  return null;
}

// md5 of a history row's text as the release gate and the apply step compute
// it: array_to_string(statements, E'\n').
export function historyRowMd5(row) {
  if (Array.isArray(row.statements)) return md5(row.statements.join('\n'));
  if (typeof row.statements_md5 === 'string') return row.statements_md5;
  return null;
}

function sourceText(source, migrations, historyOnly) {
  if (source.startsWith('migrations/')) return migrations[source.slice('migrations/'.length)];
  if (source.startsWith('history-only/')) return historyOnly[source.slice('history-only/'.length)];
  return undefined;
}

export function verifyLedger({ ledger, migrations, historyOnly }) {
  const errors = [];
  if (!ledger || ledger.contract !== LEDGER_CONTRACT) return ['ledger_contract_invalid'];
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const repositoryOnly = Array.isArray(ledger.repository_only) ? ledger.repository_only : [];
  if (!Array.isArray(ledger.rows)) errors.push('ledger_rows_missing');

  const carried = new Map();
  const versions = new Set();
  const names = new Set();
  let previousVersion = '';
  for (const row of rows) {
    const label = `${row?.version}_${row?.name}`;
    if (!/^\d{14}$/.test(row?.version ?? '') || !/^[a-z0-9_]+$/.test(row?.name ?? '') ||
        !/^[0-9a-f]{32}$/.test(row?.statements_md5 ?? '') || typeof row?.source !== 'string' ||
        !TRANSFORMS.includes(row?.transform)) {
      errors.push(`ledger_row_invalid:${label}`);
      continue;
    }
    if (versions.has(row.version)) errors.push(`ledger_duplicate_version:${row.version}`);
    if (names.has(row.name)) errors.push(`ledger_duplicate_name:${row.name}`);
    if (row.version < previousVersion) errors.push(`ledger_rows_not_sorted:${row.version}`);
    versions.add(row.version);
    names.add(row.name);
    previousVersion = row.version;
    const text = sourceText(row.source, migrations, historyOnly);
    if (typeof text !== 'string') {
      errors.push(`ledger_source_missing:${row.source}`);
      continue;
    }
    carried.set(row.source, (carried.get(row.source) ?? 0) + 1);
    if (row.source.startsWith('history-only/')) {
      if (row.source !== `history-only/${row.version}_${row.name}.sql`) {
        errors.push(`history_only_name_mismatch:${row.source}`);
      }
      if (row.transform !== 'identical') errors.push(`history_only_transform_not_identical:${row.source}`);
    }
    if (md5(applyTransform(text, row.transform)) !== row.statements_md5) {
      errors.push(`ledger_source_mismatch:${label}`);
    }
  }
  for (const [source, count] of carried) {
    if (count > 1) errors.push(`ledger_source_shared:${source}`);
  }

  const listed = new Map();
  for (const entry of repositoryOnly) {
    const file = entry?.file;
    if (typeof file !== 'string' || !file.startsWith('migrations/')) {
      errors.push(`repository_only_entry_invalid:${file}`);
      continue;
    }
    if (listed.has(file)) errors.push(`repository_only_duplicate:${file}`);
    listed.set(file, entry);
    if (typeof migrations[file.slice('migrations/'.length)] !== 'string') {
      errors.push(`repository_only_file_missing:${file}`);
    }
    if (!REPOSITORY_ONLY_STATUSES.includes(entry.status) ||
        typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      errors.push(`repository_only_reason_missing:${file}`);
    }
    if (carried.has(file)) errors.push(`migration_double_listed:${file}`);
    if (entry.status === 'diverged_from_production') {
      const name = /^migrations\/\d{12,14}_(.+)\.sql$/.exec(file)?.[1];
      const row = rows.find((candidate) => candidate?.name === name);
      if (!row || !String(row.source).startsWith('history-only/')) {
        errors.push(`repository_only_divergence_unrecorded:${file}`);
      }
    }
  }

  for (const filename of Object.keys(migrations).sort()) {
    if (!MIGRATION_FILENAME.test(filename)) errors.push(`invalid_migration_filename:${filename}`);
    const source = `migrations/${filename}`;
    if (!carried.has(source) && !listed.has(source)) errors.push(`migration_not_in_ledger:${filename}`);
  }
  for (const filename of Object.keys(historyOnly).sort()) {
    if (!HISTORY_ONLY_FILENAME.test(filename)) errors.push(`invalid_history_only_filename:${filename}`);
    if (!carried.has(`history-only/${filename}`)) errors.push(`history_only_unreferenced:${filename}`);
    if (historyOnly[filename].includes('\r')) errors.push(`history_only_contains_cr:${filename}`);
  }
  for (const deviation of Array.isArray(ledger.known_deviations) ? ledger.known_deviations : []) {
    if (typeof deviation?.kind !== 'string' || typeof deviation?.name !== 'string' ||
        typeof deviation?.note !== 'string' || deviation.note.trim() === '') {
      errors.push(`known_deviation_invalid:${deviation?.name}`);
    }
  }
  return errors;
}

// migrations: {filename: text}; used to recognize a production row the ledger
// lacks but a migration file carries (applied after the ledger was refreshed).
export function compareLedgerWithHistory({ ledger, history, migrations = {} }) {
  const errors = [];
  const warnings = [];
  const missingRows = [];
  if (!ledger || ledger.contract !== LEDGER_CONTRACT) {
    return { errors: ['ledger_contract_invalid'], warnings, missingRows };
  }
  const byVersion = new Map((ledger.rows ?? []).map((row) => [row.version, row]));
  const seen = new Set();
  const fileHashes = new Map();
  for (const [filename, text] of Object.entries(migrations)) {
    for (const transform of TRANSFORMS) {
      const hash = md5(applyTransform(text, transform));
      if (!fileHashes.has(hash)) fileHashes.set(hash, { filename, transform });
    }
  }
  for (const row of history) {
    const label = `${row.version}_${row.name}`;
    seen.add(row.version);
    if (Array.isArray(row.statements) && row.statements.length !== 1) {
      errors.push(`production_row_multi_statement:${label}`);
    }
    const hash = historyRowMd5(row);
    if (hash === null) {
      errors.push(`production_row_without_statements:${label}`);
      continue;
    }
    const entry = byVersion.get(row.version);
    if (!entry) {
      const carrier = fileHashes.get(hash);
      if (carrier) {
        warnings.push(`ledger_missing_row:${label}`);
        missingRows.push({
          version: row.version, name: row.name, statements_md5: hash,
          statements_length: Array.isArray(row.statements) ? row.statements.join('\n').length
            : row.statements_length ?? null,
          source: `migrations/${carrier.filename}`, transform: carrier.transform,
        });
      } else {
        errors.push(`production_row_not_in_repository:${label}`);
      }
      continue;
    }
    if (entry.name !== row.name) errors.push(`production_row_renamed:${label}`);
    if (entry.statements_md5 !== hash) errors.push(`production_statements_changed:${label}`);
  }
  for (const row of ledger.rows ?? []) {
    if (!seen.has(row.version)) errors.push(`ledger_row_not_in_production:${row.version}_${row.name}`);
  }
  return { errors, warnings, missingRows };
}

// Rebuild rows from production history. Rows the migration files carry are
// mapped by content; the others need their statements and are written to
// history-only/ (an existing file must hold the same text).
export function buildLedger({ history, migrations, historyOnly = {}, previous = null, exportedAt }) {
  const fileHashes = new Map();
  for (const [filename, text] of Object.entries(migrations)) {
    for (const transform of TRANSFORMS) {
      const hash = md5(applyTransform(text, transform));
      const list = fileHashes.get(hash) ?? [];
      list.push({ filename, transform });
      fileHashes.set(hash, list);
    }
  }
  const rows = [];
  const newHistoryOnly = {};
  const errors = [];
  for (const row of [...history].sort((a, b) => a.version.localeCompare(b.version))) {
    const label = `${row.version}_${row.name}`;
    const hash = historyRowMd5(row);
    if (hash === null) { errors.push(`history_row_without_statements:${label}`); continue; }
    const candidates = fileHashes.get(hash) ?? [];
    const carrier = candidates.find(({ filename }) => filename.slice(15, -4) === row.name ||
      /^\d{12,14}_(.+)\.sql$/.exec(filename)?.[1] === row.name) ?? candidates[0];
    const statementsLength = Array.isArray(row.statements)
      ? row.statements.join('\n').length : row.statements_length ?? null;
    if (carrier) {
      rows.push({ version: row.version, name: row.name, statements_md5: hash,
        statements_length: statementsLength, source: `migrations/${carrier.filename}`,
        transform: carrier.transform });
      continue;
    }
    const filename = `${row.version}_${row.name}.sql`;
    const existing = historyOnly[filename];
    const text = Array.isArray(row.statements) ? row.statements.join('\n') : null;
    if (typeof existing === 'string') {
      if (md5(existing) !== hash) { errors.push(`history_only_text_differs:${filename}`); continue; }
    } else if (text === null) {
      errors.push(`history_row_needs_statements:${label}`);
      continue;
    } else if (text.includes('\r')) {
      errors.push(`history_row_contains_cr:${label}`);
      continue;
    } else {
      newHistoryOnly[filename] = text;
    }
    rows.push({ version: row.version, name: row.name, statements_md5: hash,
      statements_length: statementsLength, source: `history-only/${filename}`,
      transform: 'identical' });
  }
  const ledger = {
    contract: LEDGER_CONTRACT,
    database_project: previous?.database_project ?? 'clued-prod',
    exported_at: exportedAt,
    row_count: rows.length,
    rows,
    repository_only: previous?.repository_only ?? [],
    known_deviations: previous?.known_deviations ?? [],
  };
  return { ledger, newHistoryOnly, errors };
}

export async function readSqlDirectory(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const files = {};
  for (const name of names.filter((candidate) => candidate.endsWith('.sql')).sort()) {
    files[name] = await readFile(join(directory, name), 'utf8');
  }
  return files;
}

export async function readLedger(path = ledgerPath) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readHistory(args) {
  const historyIndex = args.indexOf('--history');
  const urlIndex = args.indexOf('--database-url');
  if (historyIndex >= 0) {
    const rows = JSON.parse(await readFile(args[historyIndex + 1], 'utf8'));
    if (!Array.isArray(rows)) throw new Error('history_file_not_an_array');
    return rows;
  }
  if (urlIndex >= 0) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: args[urlIndex + 1] });
    await client.connect();
    try {
      await client.query('begin read only');
      const result = await client.query(
        'select version, name, statements from supabase_migrations.schema_migrations order by version');
      await client.query('commit');
      return result.rows;
    } finally {
      await client.end();
    }
  }
  throw new Error('history_source_required');
}

function formatLedger(ledger) {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'verify') {
    const errors = verifyLedger({
      ledger: await readLedger(),
      migrations: await readSqlDirectory(migrationsDirectory),
      historyOnly: await readSqlDirectory(historyOnlyDirectory),
    });
    for (const error of errors) process.stderr.write(`${error}\n`);
    if (errors.length) {
      process.stderr.write(`migration_ledger_invalid:${errors.length}\n`);
      return 1;
    }
    const ledger = await readLedger();
    process.stdout.write(`migration ledger ok: ${ledger.rows.length} production rows, ` +
      `${ledger.repository_only.length} repository-only files\n`);
    return 0;
  }
  if (command === 'compare') {
    const report = compareLedgerWithHistory({
      ledger: await readLedger(),
      history: await readHistory(args),
      migrations: await readSqlDirectory(migrationsDirectory),
    });
    for (const warning of report.warnings) process.stderr.write(`warning: ${warning}\n`);
    if (report.missingRows.length) {
      process.stderr.write(`rows to add to the ledger:\n${JSON.stringify(report.missingRows, null, 2)}\n`);
    }
    for (const error of report.errors) process.stderr.write(`${error}\n`);
    if (report.errors.length) {
      process.stderr.write(`migration_ledger_drift:${report.errors.length}\n`);
      return 1;
    }
    process.stdout.write(`migration ledger matches production history` +
      `${report.warnings.length ? ` (${report.warnings.length} row(s) to add)` : ''}\n`);
    return 0;
  }
  if (command === 'export') {
    const outIndex = args.indexOf('--out');
    const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : ledgerPath;
    let previous = null;
    try { previous = await readLedger(out); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const { ledger, newHistoryOnly, errors } = buildLedger({
      history: await readHistory(args),
      migrations: await readSqlDirectory(migrationsDirectory),
      historyOnly: await readSqlDirectory(historyOnlyDirectory),
      previous,
      exportedAt: new Date().toISOString(),
    });
    for (const error of errors) process.stderr.write(`${error}\n`);
    if (errors.length) {
      process.stderr.write(`migration_ledger_export_failed:${errors.length}\n`);
      return 1;
    }
    await mkdir(historyOnlyDirectory, { recursive: true });
    for (const [filename, text] of Object.entries(newHistoryOnly)) {
      await writeFile(join(historyOnlyDirectory, filename), text, { encoding: 'utf8', flag: 'wx' });
    }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, formatLedger(ledger), 'utf8');
    process.stdout.write(`migration ledger written: ${ledger.rows.length} rows, ` +
      `${Object.keys(newHistoryOnly).length} new history-only file(s)\n`);
    return 0;
  }
  process.stderr.write('usage: node scripts/migration-ledger.mjs <verify|compare|export> [--history rows.json | --database-url URL] [--out PATH]\n');
  return 2;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntryPoint()) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
