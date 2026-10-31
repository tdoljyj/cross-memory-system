// Migration chains for the production-schema drift check (Task 2a5fdb66).
//
// Two orders exist for the same files and they do not produce the same schema:
// - the repository chain: every file under supabase/migrations in file-name
//   order, which is what every database test applies;
// - the production chain: the rows production's schema_migrations actually
//   holds, in their version (apply) order, each with the text that was applied
//   (a migration file or supabase/ledger/history-only), followed by the pending
//   files migrate mode would apply next.
// The repository chain also applies the files the ledger lists as
// repository_only (never applied, or diverged). Tonight's bug lived there:
// the never-applied P5 series adds public.clued_agent_bindings.expires_at, so
// a function using that column passed every test and failed in production.
//
// Nothing here connects to a database. The production history comes from the
// committed snapshot (supabase/production-schema/catalog.json), never from a
// credential.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appDirectory, applyTransform, evaluateLedger, fileShortName, historyOnlyDirectory, md5,
  migrationsDirectory, readHistoricalThrough, readLedger, readSqlDirectory,
} from './migration-ledger.mjs';

export const SNAPSHOT_CONTRACT = 'clued.production-schema-catalog.v1';
export const snapshotDirectory = join(appDirectory, 'supabase', 'production-schema');
export const snapshotPath = join(snapshotDirectory, 'catalog.json');
export const catalogSqlPath = join(snapshotDirectory, 'catalog.sql');

export async function readRepository() {
  const [migrations, historyOnly, ledger, historicalThrough] = await Promise.all([
    readSqlDirectory(migrationsDirectory), readSqlDirectory(historyOnlyDirectory),
    readLedger(), readHistoricalThrough(),
  ]);
  return { migrations, historyOnly, ledger, historicalThrough };
}

export async function readSnapshot(path = snapshotPath) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function repositoryChain({ migrations }) {
  return Object.keys(migrations).sort().map((file) => ({ file: `migrations/${file}`, text: migrations[file] }));
}

function sourceText(source, { migrations, historyOnly }) {
  if (source.startsWith('migrations/')) return migrations[source.slice('migrations/'.length)];
  if (source.startsWith('history-only/')) return historyOnly[source.slice('history-only/'.length)];
  return undefined;
}

// Resolves the snapshot's applied rows to exact texts. Every row must be the
// ledger's (same version, name and md5) or a migrate-mode apply of a pending
// file the ledger has not recorded yet; anything else is an error, because the
// replay would otherwise not be production's schema. The result's errors are
// the ledger's own codes (scripts/migration-ledger.mjs) plus chain_* codes.
export function productionChain({ applied, migrations, historyOnly, ledger, historicalThrough }) {
  const errors = [];
  if (!Array.isArray(applied) || applied.length === 0) {
    return { errors: ['chain_snapshot_applied_missing'], applied: [], pending: [] };
  }
  const report = evaluateLedger({ ledger, history: applied, migrations, historyOnly, historicalThrough });
  // A pending file is not an error here, and neither is a ledger row production
  // does not hold yet: the snapshot can be older than the ledger.
  errors.push(...report.errors.filter((code) => !code.startsWith('ledger_row_not_in_production:')));
  const rows = new Map([...ledger.rows, ...report.missingRows].map((row) => [row.version, row]));
  const chain = [];
  for (const row of [...applied].sort((a, b) => a.version.localeCompare(b.version))) {
    const entry = rows.get(row.version);
    if (!entry) {
      errors.push(`chain_row_unresolved:${row.version}_${row.name}`);
      continue;
    }
    const text = sourceText(entry.source, { migrations, historyOnly });
    if (typeof text !== 'string') {
      errors.push(`chain_source_missing:${entry.source}`);
      continue;
    }
    if (md5(applyTransform(text, entry.transform)) !== row.statements_md5) {
      errors.push(`chain_source_md5:${row.version}_${row.name}`);
      continue;
    }
    // The replay runs the file's LF text. The transform records how
    // production stored the row, not always how it ran: production's
    // public.clued_mcp_currentness_g6_gate body has no CR although its rows
    // are stored with CRLF, and 20261010161848_worker_gateway_closeout_v1
    // pins that LF body's md5. The fingerprint ignores CR before LF.
    chain.push({ version: row.version, name: row.name, file: entry.source, text });
  }
  const claimed = new Set(report.missingRows.map((row) => row.source));
  const pending = report.pending
    .filter((file) => !claimed.has(`migrations/${file}`))
    .map((file) => ({ file: `migrations/${file}`, name: fileShortName(file), text: migrations[file] }));
  return { errors: [...new Set(errors)], applied: chain, pending };
}
