#!/usr/bin/env node
// Applies the migration chain to the local Supabase database the way production runs it
// (FABLE-g4-retention-lock-20261124; Clued Task 4432ee9b).
//
//   node scripts/ci/clued-local-migrate.mjs
//
// One migration file has one executor. The release workflow's migrate mode runs a whole file as one plpgsql
// EXECUTE inside one explicit transaction, together with its history row. The Supabase CLI split a file into
// statements and sent them down an extended-protocol pipeline with no transaction block, so a file production
// accepts could fail locally (a top-level LOCK TABLE: SQLSTATE 25P01) and a file production refuses could pass
// locally (transaction control). `supabase start` therefore applies no migration ([db.migrations] enabled = false
// in apps/clued-cloud/supabase/config.toml); this script applies every file `supabase start` left out:
//   - files after the release baseline: migrate mode (MIGRATE_MODE_SQL, the text the drift check and the database
//     tests replay with);
//   - files up to the baseline (history, applied before migrate mode existed): the file's text in one simple
//     query, as those same replays send it.
// Each file runs in its own transaction with its supabase_migrations.schema_migrations row (version and name as
// the CLI wrote them, statements = the file's exact text as production records it). A failing file rolls back and
// leaves no row. Files already recorded are skipped, so a second run applies nothing.
//
// The database is always the local one: 127.0.0.1 and the [db] port of config.toml (which the workflows' isolation
// steps rewrite for their run), the CLI's local role and password. There is no option that names another database.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIGRATE_MODE_SQL } from '../../apps/clued-cloud/scripts/production-schema-drift.mjs';
import { MIGRATION_FILENAME, appDirectory, fileVersion, migrationsDirectory, readHistoricalThrough, readSqlDirectory,
} from '../../apps/clued-cloud/scripts/migration-ledger.mjs';

export const CONFIG_PATH = path.join(appDirectory, 'supabase', 'config.toml');

// The history table as the CLI creates it (pkg/migration/history.go): `supabase test db`, `db lint` and the
// fresh-start verification read it under this shape.
const HISTORY_TABLE_SQL = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;
`;
const INSERT_HISTORY_SQL = 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3)';

// The [db] port of a Supabase config.toml.
export function localDatabasePort(config) {
  const section = /^\[db\][ \t]*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(config)?.[1] ?? '';
  const port = Number(/^[ \t]*port[ \t]*=[ \t]*(\d+)[ \t]*(?:#.*)?$/m.exec(section)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('local_database_port_missing');
  return port;
}

// The files in the order the database tests and the drift check replay them (file name), each with the history
// row the CLI would have written for it and the shape it runs in.
export function migrationSteps(migrations, historicalThrough) {
  if (typeof historicalThrough !== 'string' || !/^\d{14}$/.test(historicalThrough)) throw new Error('release_baseline_invalid');
  const steps = Object.keys(migrations).sort().map((file) => {
    const match = MIGRATION_FILENAME.exec(file);
    if (!match) throw new Error(`migration_filename_invalid:${file}`);
    return { file, version: match[1], name: match[2], text: migrations[file],
      mode: fileVersion(file) > historicalThrough ? 'migrate' : 'plain' };
  });
  const versions = new Set(steps.map((step) => step.version));
  if (versions.size !== steps.length) throw new Error('migration_version_duplicate');
  return steps;
}

const failure = (file, error) => new Error(
  `Migration ${file}: ${error.message}${error.code ? ` (SQLSTATE ${error.code})` : ''}${error.where ? `\n${error.where}` : ''}`,
  { cause: error });

// client: a connected node-postgres client. Returns the files applied and the files skipped as already recorded.
export async function applyChain(client, { migrations, historicalThrough, log = () => {} }) {
  const steps = migrationSteps(migrations, historicalThrough);
  await client.query(HISTORY_TABLE_SQL);
  const recorded = new Set((await client.query('select version from supabase_migrations.schema_migrations')).rows
    .map((row) => row.version));
  const applied = [];
  const skipped = [];
  for (const step of steps) {
    if (recorded.has(step.version)) {
      skipped.push(step.file);
      continue;
    }
    log(`Applying migration ${step.file} (${step.mode})...`);
    // Session state a file left behind (a plain SET) never reaches the next one, as with the CLI's per-file reset.
    await client.query('reset all');
    await client.query('begin');
    try {
      if (step.mode === 'migrate') {
        await client.query("select set_config('clued.migration_text', $1, true)", [step.text]);
        await client.query(MIGRATE_MODE_SQL);
      } else {
        await client.query(step.text);
      }
      await client.query(INSERT_HISTORY_SQL, [step.version, step.name, [step.text]]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw failure(step.file, error);
    }
    applied.push(step.file);
  }
  // PostgREST started before the schema existed.
  if (applied.length > 0) await client.query("notify pgrst, 'reload schema'");
  return { applied, skipped };
}

export async function main({ configPath = CONFIG_PATH, directory = migrationsDirectory, log = (line) => console.error(line) } = {}) {
  const port = localDatabasePort(await readFile(configPath, 'utf8'));
  const migrations = await readSqlDirectory(directory);
  const historicalThrough = await readHistoricalThrough();
  const { Client } = createRequire(path.join(appDirectory, 'package.json'))('pg');
  const client = new Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' });
  await client.connect();
  try {
    const { applied, skipped } = await applyChain(client, { migrations, historicalThrough, log });
    log(`Applied ${applied.length} migration(s) to the local database on port ${port}; ${skipped.length} already recorded. ` +
      `Files after ${historicalThrough} ran in migrate mode.`);
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length > 2) {
    console.error(`usage: node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`);
    process.exit(2);
  }
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`clued-local-migrate: ${error.message}`);
    process.exitCode = 1;
  }
}
