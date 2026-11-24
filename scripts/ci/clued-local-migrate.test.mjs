// The local executor of migration files (FABLE-g4-retention-lock-20261124; Clued Task 4432ee9b).
// A real PostgreSQL: the two migrations whose top-level LOCK TABLE the Supabase CLI could not run are applied with
// the whole chain, and fixture files show the shape is the release workflow's migrate mode (one EXECUTE in one
// explicit transaction with the history row). The Supabase image itself is only seen by the G4 workflow.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withCluster } from '../../apps/clued-cloud/scripts/production-schema-drift.mjs';
import { md5, migrationsDirectory, readHistoricalThrough, readSqlDirectory } from '../../apps/clued-cloud/scripts/migration-ledger.mjs';
import { migrationSources, verifyHistory } from './clued-g4-fresh-start.mjs';

// Loaded by each test that uses it, so that the first test below (what PostgreSQL does with the CLI's shape)
// reports on a tree that has no local executor yet.
const executor = () => import('./clued-local-migrate.mjs');

// Top-level LOCK TABLE: file, 1-based line. Both are applied in production, so their text can never change.
const TOP_LEVEL_LOCKS = [
  ['20261124120000_retention_sweep_v1.sql', 105],
  ['20261124130000_imprint_history_keep_v1.sql', 39],
];
const BASELINE = '20260105000000';
const history = async (client) => (await client.query(
  'select version, name, statements from supabase_migrations.schema_migrations order by version')).rows;

test('PostgreSQL refuses a top-level LOCK TABLE sent the way the Supabase CLI sent it (25P01)', { timeout: 300000 }, async (t) => {
  await withCluster('local-migrate-cli-shape', async (client) => {
    for (const [file, line] of TOP_LEVEL_LOCKS) {
      const statement = readFileSync(path.join(migrationsDirectory, file), 'utf8').split('\n')[line - 1];
      assert.match(statement, /^lock table [a-z_.0-9]+ in access exclusive mode;$/, `${file}:${line}`);
      // One statement of the extended protocol with no BEGIN before it: no transaction block.
      await assert.rejects(client.query({ text: statement.slice(0, -1), values: [] }), (error) => {
        t.diagnostic(`${file}:${line} -> SQLSTATE ${error.code}: ${error.message}`);
        return error.code === '25P01';
      });
    }
  });
});

test('the whole migration chain, both top-level LOCK TABLE files included, applies through the local executor',
  { timeout: 900000 }, async () => {
    const { applyChain } = await executor();
    const migrations = await readSqlDirectory(migrationsDirectory);
    const historicalThrough = await readHistoricalThrough();
    await withCluster('local-migrate-chain', async (client) => {
      const lines = [];
      const first = await applyChain(client, { migrations, historicalThrough, log: (line) => lines.push(line) });
      assert.deepEqual(first.applied, Object.keys(migrations).sort());
      assert.deepEqual(first.skipped, []);
      const rows = await history(client);
      // What clued-g4-fresh-start.mjs --verify asks of the history the CLI used to write.
      assert.deepEqual(verifyHistory(migrationSources(migrationsDirectory), rows),
        { migrations: rows.length, history_matches: true });
      for (const [file] of TOP_LEVEL_LOCKS) {
        const row = rows.find((candidate) => candidate.version === file.slice(0, 14));
        assert.equal(row.name, file.slice(15, -4));
        assert.equal(row.statements.length, 1);
        assert.equal(md5(row.statements[0]), md5(migrations[file]), 'the history row holds the file text, as in production');
        assert.ok(lines.includes(`Applying migration ${file} (migrate)...`));
      }
      assert.ok(lines.includes('Applying migration 202608230001_clued_continuity.sql (plain)...'));
      const second = await applyChain(client, { migrations, historicalThrough });
      assert.deepEqual(second, { applied: [], skipped: first.applied });
      assert.equal((await history(client)).length, rows.length);
    });
  });

test('a file after the baseline runs as one EXECUTE in one transaction with its history row', { timeout: 300000 }, async () => {
  const { applyChain, migrationSteps } = await executor();
  const migrations = {
    '202601010000_first.sql': 'create table public.local_migrate_probe(source text, value text);\n' +
      "set lock_timeout = '9s';\n",
    '20260201000000_locks.sql': "set local lock_timeout = '5s';\n" +
      'lock table public.local_migrate_probe in access exclusive mode;\n' +
      'create temp table local_migrate_keep on commit drop as select 1 as n;\n' +
      "insert into public.local_migrate_probe select 'locks', current_setting('lock_timeout') from local_migrate_keep;\n",
    '20260202000000_commits.sql': "insert into public.local_migrate_probe values ('commits', 'before');\ncommit;\n" +
      "insert into public.local_migrate_probe values ('commits', 'after');\n",
  };
  assert.deepEqual(migrationSteps(migrations, BASELINE).map((step) => [step.version, step.name, step.mode]), [
    ['202601010000', 'first', 'plain'], ['20260201000000', 'locks', 'migrate'], ['20260202000000', 'commits', 'migrate']]);
  await withCluster('local-migrate-fixture', async (client) => {
    // Production refuses transaction control in a file; so does the local executor, and nothing of the file stays.
    await assert.rejects(applyChain(client, { migrations, historicalThrough: BASELINE }),
      /^Error: Migration 20260202000000_commits\.sql: .*\(SQLSTATE 0A000\)/);
    assert.deepEqual((await history(client)).map((row) => [row.version, row.name, row.statements]), [
      ['202601010000', 'first', [migrations['202601010000_first.sql']]],
      ['20260201000000', 'locks', [migrations['20260201000000_locks.sql']]]]);
    // SET LOCAL took effect inside the file; the temporary table went with the commit.
    assert.deepEqual((await client.query('select source, value from public.local_migrate_probe')).rows,
      [{ source: 'locks', value: '5s' }]);
    assert.equal((await client.query("select to_regclass('local_migrate_keep') as t")).rows[0].t, null);
    // The files recorded are skipped. The session setting the first file left (9s) does not reach a later file.
    delete migrations['20260202000000_commits.sql'];
    migrations['20260203000000_later.sql'] = "insert into public.local_migrate_probe select 'later', current_setting('lock_timeout');\n";
    assert.deepEqual(await applyChain(client, { migrations, historicalThrough: BASELINE }), {
      applied: ['20260203000000_later.sql'], skipped: ['202601010000_first.sql', '20260201000000_locks.sql'] });
    assert.deepEqual((await client.query("select value from public.local_migrate_probe where source = 'later'")).rows, [{ value: '0' }]);
  });
});

test('file names and the local port are read strictly', async () => {
  const { localDatabasePort, migrationSteps, CONFIG_PATH } = await executor();
  assert.equal(localDatabasePort(readFileSync(CONFIG_PATH, 'utf8')), 54322);
  assert.equal(localDatabasePort('[api]\nport = 54321\n\n[db]\n# Port\nport = 61002\nshadow_port = 61000\n\n[db.pooler]\nport = 61009\n'), 61002);
  assert.throws(() => localDatabasePort('[api]\nport = 54321\n[db.pooler]\nport = 61009\n'), /local_database_port_missing/);
  assert.throws(() => migrationSteps({ 'notes.sql': 'select 1;\n' }, BASELINE), /migration_filename_invalid:notes\.sql/);
  assert.throws(() => migrationSteps({ '20260101000000_a.sql': 'select 1;\n' }, ''), /release_baseline_invalid/);
});
