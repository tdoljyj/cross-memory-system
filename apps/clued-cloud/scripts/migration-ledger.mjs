// Production migration ledger: the committed record of every row of
// production's supabase_migrations.schema_migrations and of the repository
// file that carries its text (docs/maintenance/migration-ledger.md).
//
//   node scripts/migration-ledger.mjs verify
//     Offline: every ledger row resolves to a repository file whose text, after
//     the recorded line-ending transform, has the recorded md5; every migration
//     file up to the release baseline is carried by a row or listed under
//     repository_only; a later file no row carries is pending and must be one
//     the release workflow's migrate mode can apply.
//   node scripts/migration-ledger.mjs compare (--history rows.json | --database-url URL)
//     Online: verify, then production history against the ledger. A production
//     row the ledger lacks is a warning only when it is newer than
//     history_through and exactly what migrate mode records for a pending file;
//     any other difference is an error.
//   node scripts/migration-ledger.mjs export (--history rows.json | --database-url URL) [--out PATH]
//     Rebuilds the rows from production history, keeps known_deviations and
//     the repository_only entries no row carries now, and writes the text of a
//     row no migration file carries to supabase/ledger/history-only/.
//
// rows.json is a JSON array of {version, name, statements} as the table holds
// them (statements is a text[] with exactly one element); a row may carry
// statements_md5 instead of statements when only the hash is known.

import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_CONTRACT = 'clued.production-migration-ledger.v1';
export const TRANSFORMS = ['identical', 'append_crlf', 'strip_final_newline', 'crlf', 'cr_crlf'];
export const REPOSITORY_ONLY_STATUSES = ['never_applied', 'diverged_from_production'];
export const MIGRATION_FILENAME = /^(\d{12}|\d{14})_([a-z0-9_]+)\.sql$/;
// The file names the release workflow's migrate mode accepts.
export const MIGRATABLE_FILENAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;
export const HISTORY_ONLY_FILENAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const appDirectory = join(scriptDirectory, '..');
export const migrationsDirectory = join(appDirectory, 'supabase', 'migrations');
export const ledgerDirectory = join(appDirectory, 'supabase', 'ledger');
export const historyOnlyDirectory = join(ledgerDirectory, 'history-only');
export const ledgerPath = join(ledgerDirectory, 'production-history.json');
export const releaseBaselinePath = join(scriptDirectory, 'production-release-baseline.json');

export const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');
// Postgres length() counts characters; a JavaScript string's length counts
// UTF-16 code units.
export const characterLength = (text) => [...text].length;

// A 12-digit timestamp (YYYYMMDDHHMM) orders as its 14-digit form with 00 seconds.
export function fileVersion(filename) {
  const version = MIGRATION_FILENAME.exec(filename)?.[1];
  if (!version) return null;
  return version.length === 12 ? `${version}00` : version;
}

export function fileShortName(filename) {
  return MIGRATION_FILENAME.exec(filename)?.[2] ?? null;
}

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

// The text checks the release workflow's migrate mode applies before it runs a
// file (COPY-based transport): non-empty, ends with a newline, no carriage
// return, no \x01 or \x02, no line that is only \. — null when it passes.
export function migrateTextProblem(text) {
  if (typeof text !== 'string' || text.length === 0) return 'empty';
  if (!text.endsWith('\n')) return 'no_final_newline';
  if (/[\r\x01\x02]/.test(text)) return 'forbidden_character';
  if (text.split('\n').includes('\\.')) return 'copy_terminator_line';
  return null;
}

// md5 of a history row's single statements element. The release workflow's
// apply step checks md5(array_to_string(statements, '')) and the release gate
// compares statements[0]; for the one-element rows production holds (and the
// ledger requires) all three are the same text.
export function historyRowMd5(row) {
  if (Array.isArray(row?.statements)) {
    return row.statements.length === 1 && typeof row.statements[0] === 'string'
      ? md5(row.statements[0]) : null;
  }
  if (typeof row?.statements_md5 === 'string') return row.statements_md5;
  return null;
}

function historyRowLength(row) {
  if (Array.isArray(row.statements) && row.statements.length === 1) {
    return characterLength(row.statements[0]);
  }
  return Number.isInteger(row.statements_length) ? row.statements_length : null;
}

function sourceText(source, migrations, historyOnly) {
  if (source.startsWith('migrations/')) return migrations[source.slice('migrations/'.length)];
  if (source.startsWith('history-only/')) return historyOnly[source.slice('history-only/'.length)];
  return undefined;
}

function ledgerRows(ledger) {
  return (Array.isArray(ledger?.rows) ? ledger.rows : []).filter((row) => row && typeof row === 'object');
}

function repositoryOnlyEntries(ledger) {
  return (Array.isArray(ledger?.repository_only) ? ledger.repository_only : [])
    .filter((entry) => entry && typeof entry === 'object');
}

// The release baseline's source migration: every migration file up to it is
// history (the release gate refuses to add or change one), so the ledger must
// account for each; later files are applied through migrate mode.
export function baselineVersion(baseline) {
  return fileVersion(baseline?.source_migration ?? '');
}

// Migration files after the baseline that no row carries and repository_only
// does not list: added since the ledger was refreshed and not applied yet.
export function listPendingMigrations({ ledger, migrations, historicalThrough }) {
  const carried = new Set(ledgerRows(ledger).map((row) => row.source));
  const listed = new Set(repositoryOnlyEntries(ledger).map((entry) => entry.file));
  return Object.keys(migrations).sort().filter((filename) => {
    const version = fileVersion(filename);
    const source = `migrations/${filename}`;
    return version !== null && typeof historicalThrough === 'string' && version > historicalThrough &&
      !carried.has(source) && !listed.has(source);
  });
}

// Why migrate mode could not apply this pending file, or null.
function pendingProblem(filename, text, { recordedNames, shortNameCounts }) {
  if (!MIGRATABLE_FILENAME.test(filename)) return 'filename';
  const name = fileShortName(filename);
  if (recordedNames.has(name)) return 'name_recorded';
  if ((shortNameCounts.get(name) ?? 0) > 1) return 'name_duplicate';
  return migrateTextProblem(text);
}

export function verifyLedger({ ledger, migrations, historyOnly, historicalThrough }) {
  const errors = [];
  if (!ledger || ledger.contract !== LEDGER_CONTRACT) return ['ledger_contract_invalid'];
  if (!Array.isArray(ledger.rows)) errors.push('ledger_rows_missing');
  const rows = ledgerRows(ledger);
  const repositoryOnly = repositoryOnlyEntries(ledger);
  if (ledger.row_count !== rows.length) errors.push(`ledger_row_count_mismatch:${ledger.row_count}`);
  if (!/^\d{14}$/.test(ledger.history_through ?? '')) errors.push('history_through_invalid');
  if (!/^\d{14}$/.test(historicalThrough ?? '')) errors.push('release_baseline_invalid');

  const fileHashes = new Map();
  for (const [filename, text] of Object.entries(migrations)) {
    for (const transform of TRANSFORMS) fileHashes.set(md5(applyTransform(text, transform)), filename);
  }

  const carried = new Map();
  const versions = new Set();
  const names = new Set();
  let previousVersion = '';
  for (const row of rows) {
    const label = `${row.version}_${row.name}`;
    if (!/^\d{14}$/.test(row.version ?? '') || !/^[a-z0-9_]+$/.test(row.name ?? '') ||
        !/^[0-9a-f]{32}$/.test(row.statements_md5 ?? '') || typeof row.source !== 'string' ||
        !TRANSFORMS.includes(row.transform)) {
      errors.push(`ledger_row_invalid:${label}`);
      continue;
    }
    if (versions.has(row.version)) errors.push(`ledger_duplicate_version:${row.version}`);
    if (names.has(row.name)) errors.push(`ledger_duplicate_name:${row.name}`);
    if (row.version < previousVersion) errors.push(`ledger_rows_not_sorted:${row.version}`);
    if (/^\d{14}$/.test(ledger.history_through ?? '') && row.version > ledger.history_through) {
      errors.push(`ledger_row_after_history_through:${label}`);
    }
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
      // A text a migration file carries belongs to that file: a history-only
      // copy means the ledger was exported from a checkout that lacked it.
      if (fileHashes.has(row.statements_md5)) {
        errors.push(`history_only_duplicates_migration:${row.source}:${fileHashes.get(row.statements_md5)}`);
      }
    }
    const stored = applyTransform(text, row.transform);
    if (md5(stored) !== row.statements_md5) {
      errors.push(`ledger_source_mismatch:${label}`);
    } else if (row.statements_length !== undefined && row.statements_length !== null &&
        row.statements_length !== characterLength(stored)) {
      errors.push(`ledger_length_mismatch:${label}`);
    }
  }
  for (const [source, count] of carried) {
    if (count > 1) errors.push(`ledger_source_shared:${source}`);
  }

  const listed = new Map();
  for (const entry of repositoryOnly) {
    const file = entry.file;
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
      const name = fileShortName(file.slice('migrations/'.length));
      const row = rows.find((candidate) => candidate.name === name);
      if (!row || !String(row.source).startsWith('history-only/')) {
        errors.push(`repository_only_divergence_unrecorded:${file}`);
      }
    }
  }

  const shortNameCounts = new Map();
  for (const filename of Object.keys(migrations)) {
    const name = fileShortName(filename);
    if (name) shortNameCounts.set(name, (shortNameCounts.get(name) ?? 0) + 1);
  }
  for (const filename of Object.keys(migrations).sort()) {
    const version = fileVersion(filename);
    if (version === null) {
      errors.push(`invalid_migration_filename:${filename}`);
      continue;
    }
    const source = `migrations/${filename}`;
    if (carried.has(source) || listed.has(source)) continue;
    if (!/^\d{14}$/.test(historicalThrough ?? '') || version <= historicalThrough) {
      // At or before the release baseline: history, which the ledger must account for.
      errors.push(`historical_migration_not_in_ledger:${filename}`);
      continue;
    }
    const problem = pendingProblem(filename, migrations[filename], { recordedNames: names, shortNameCounts });
    if (problem) errors.push(`pending_migration_not_migratable:${filename}:${problem}`);
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

// The ledger holds every production row up to history_through. A row newer
// than that and missing from the ledger is the normal state right after the
// release workflow's migrate mode applied a pending file and before the
// ledger pull request lands, but only when it looks exactly like what migrate
// mode records: the row's name is the pending file's short name, its text is
// the file's exact text, no ledger row and no other production row has that
// name, and no other row claims the same file. Anything else is an error.
// A hand apply that copies all of that cannot be told apart from migrate mode
// here; the workflow's production-migrations.json evidence is what tells them apart.
export function compareLedgerWithHistory({ ledger, history, migrations = {}, historicalThrough }) {
  const errors = [];
  const warnings = [];
  const missingRows = [];
  if (!ledger || ledger.contract !== LEDGER_CONTRACT || !Array.isArray(ledger.rows)) {
    return { errors: ['ledger_contract_invalid'], warnings, missingRows };
  }
  if (!Array.isArray(history)) return { errors: ['production_history_invalid'], warnings, missingRows };
  const rows = ledgerRows(ledger);
  const byVersion = new Map(rows.map((row) => [row.version, row]));
  const recordedNames = new Set(rows.map((row) => row.name));
  const historyNameCounts = new Map();
  for (const row of history) {
    if (row && typeof row.name === 'string') {
      historyNameCounts.set(row.name, (historyNameCounts.get(row.name) ?? 0) + 1);
    }
  }
  const pending = new Set(listPendingMigrations({ ledger, migrations, historicalThrough }));
  const shortNameCounts = new Map();
  for (const filename of Object.keys(migrations)) {
    const name = fileShortName(filename);
    if (name) shortNameCounts.set(name, (shortNameCounts.get(name) ?? 0) + 1);
  }
  const textHashes = new Set();
  for (const text of Object.values(migrations)) {
    for (const transform of TRANSFORMS) textHashes.add(md5(applyTransform(text, transform)));
  }
  const historyThrough = /^\d{14}$/.test(ledger.history_through ?? '') ? ledger.history_through : null;
  const claimed = new Set();
  const seen = new Set();
  for (const row of history) {
    if (!row || typeof row !== 'object' || typeof row.version !== 'string' || typeof row.name !== 'string') {
      errors.push(`production_row_invalid:${row?.version}_${row?.name}`);
      continue;
    }
    const label = `${row.version}_${row.name}`;
    seen.add(row.version);
    if (Array.isArray(row.statements) && row.statements.length !== 1) {
      errors.push(`production_row_multi_statement:${label}`);
      continue;
    }
    const hash = historyRowMd5(row);
    if (hash === null) {
      errors.push(`production_row_without_statements:${label}`);
      continue;
    }
    const entry = byVersion.get(row.version);
    if (entry) {
      if (entry.name !== row.name) errors.push(`production_row_renamed:${label}`);
      if (entry.statements_md5 !== hash) errors.push(`production_statements_changed:${label}`);
      continue;
    }
    if (historyThrough === null || row.version <= historyThrough) {
      // The ledger claims every row up to history_through: a removed row, a
      // reverted ledger or a row inserted with an old version.
      errors.push(`production_row_missing_from_ledger:${label}`);
      continue;
    }
    const carrier = [...pending].find((filename) => fileShortName(filename) === row.name);
    const migrateShaped = carrier !== undefined && !claimed.has(carrier) &&
      md5(migrations[carrier]) === hash &&
      !recordedNames.has(row.name) && historyNameCounts.get(row.name) === 1 &&
      pendingProblem(carrier, migrations[carrier], { recordedNames, shortNameCounts }) === null;
    if (migrateShaped) {
      claimed.add(carrier);
      warnings.push(`ledger_missing_row:${label}`);
      missingRows.push({
        version: row.version, name: row.name, statements_md5: hash,
        statements_length: historyRowLength(row),
        source: `migrations/${carrier}`, transform: 'identical',
      });
    } else if (textHashes.has(hash)) {
      errors.push(`production_row_not_from_migrate:${label}`);
    } else {
      errors.push(`production_row_not_in_repository:${label}`);
    }
  }
  for (const row of rows) {
    if (!seen.has(row.version)) errors.push(`ledger_row_not_in_production:${row.version}_${row.name}`);
  }
  return { errors, warnings, missingRows };
}

// What the release gate runs: the committed ledger must be valid against the
// checkout's files, and production history must match it.
export function evaluateLedger({ ledger, history, migrations, historyOnly, historicalThrough }) {
  const verifyErrors = verifyLedger({ ledger, migrations, historyOnly, historicalThrough });
  const report = compareLedgerWithHistory({ ledger, history, migrations, historicalThrough });
  return {
    errors: [...verifyErrors, ...report.errors],
    warnings: report.warnings,
    missingRows: report.missingRows,
    pending: listPendingMigrations({ ledger, migrations, historicalThrough }),
  };
}

// Rebuild rows from production history. Rows the migration files carry are
// mapped by content, preferring the file whose short name is the row's name;
// the others need their statements and are written to history-only/ (an
// existing file must hold the same text). history_through becomes the newest
// production row's version.
export function buildLedger({ history, migrations, historyOnly = {}, previous = null, exportedAt }) {
  const fileHashes = new Map();
  for (const [filename, text] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
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
    if (Array.isArray(row.statements) && row.statements.length !== 1) {
      errors.push(`history_row_multi_statement:${label}`);
      continue;
    }
    const hash = historyRowMd5(row);
    if (hash === null) { errors.push(`history_row_without_statements:${label}`); continue; }
    const candidates = fileHashes.get(hash) ?? [];
    const carrier = candidates.find(({ filename }) => fileShortName(filename) === row.name) ??
      candidates[0];
    const statementsLength = historyRowLength(row);
    if (carrier) {
      rows.push({ version: row.version, name: row.name, statements_md5: hash,
        statements_length: statementsLength, source: `migrations/${carrier.filename}`,
        transform: carrier.transform });
      continue;
    }
    const filename = `${row.version}_${row.name}.sql`;
    const existing = historyOnly[filename];
    const text = Array.isArray(row.statements) ? row.statements[0] : null;
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
  const carried = new Set(rows.map((row) => row.source));
  const ledger = {
    contract: LEDGER_CONTRACT,
    database_project: previous?.database_project ?? 'clued-prod',
    exported_at: exportedAt,
    history_through: rows.at(-1)?.version ?? null,
    row_count: rows.length,
    rows,
    // A file a row carries now (for example a never_applied file applied
    // later through migrate mode) leaves repository_only.
    repository_only: (previous?.repository_only ?? []).filter((entry) => !carried.has(entry?.file)),
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
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('ledger_json_invalid');
  }
}

export async function readHistoricalThrough(path = releaseBaselinePath) {
  const version = baselineVersion(JSON.parse(await readFile(path, 'utf8')));
  if (!version) throw new Error('release_baseline_invalid');
  return version;
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

async function readCheckout() {
  return {
    migrations: await readSqlDirectory(migrationsDirectory),
    historyOnly: await readSqlDirectory(historyOnlyDirectory),
    historicalThrough: await readHistoricalThrough(),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === 'verify') {
    const ledger = await readLedger();
    const checkout = await readCheckout();
    const errors = verifyLedger({ ledger, ...checkout });
    for (const error of errors) process.stderr.write(`${error}\n`);
    if (errors.length) {
      process.stderr.write(`migration_ledger_invalid:${errors.length}\n`);
      return 1;
    }
    const pending = listPendingMigrations({ ledger, ...checkout });
    process.stdout.write(`migration ledger ok: ${ledger.rows.length} production rows, ` +
      `${ledger.repository_only.length} repository-only files, ${pending.length} pending\n`);
    for (const filename of pending) process.stdout.write(`pending (not applied yet): ${filename}\n`);
    return 0;
  }
  if (command === 'compare') {
    const ledger = await readLedger();
    const checkout = await readCheckout();
    const report = evaluateLedger({ ledger, history: await readHistory(args), ...checkout });
    for (const filename of report.pending) process.stderr.write(`pending (not applied yet): ${filename}\n`);
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
    // A new --out file still keeps repository_only and known_deviations from the committed ledger.
    const previous = await readLedger(existsSync(out) ? out : ledgerPath).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    const { migrations, historyOnly } = await readCheckout();
    const { ledger, newHistoryOnly, errors } = buildLedger({
      history: await readHistory(args), migrations, historyOnly, previous,
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
