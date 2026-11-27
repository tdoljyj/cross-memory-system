// What the capacity gate (scripts/migration-size-gate.mjs) relies on when it does not count SELECT ... INTO tokenized from
// a string literal (FABLE-prod-db-shrink-v2-20261124 §13): PL/pgSQL's EXECUTE refuses SELECT ... INTO with SQLSTATE 0A000
// ("EXECUTE of SELECT ... INTO is not implemented"), so a migration cannot create a table that way.
// If this test turns red, PostgreSQL has started to accept it: the gate must then count SELECT ... INTO in the literal of
// an EXECUTE again (tighten the rule in the same change).
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { missingMigrations, readbackSql, releaseRequirements } from '../../../work/independent-ci-resident-v1/rollout/fleet/release-migrations.mjs';


test('EXECUTE of SELECT ... INTO fails with 0A000 and creates no table', { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-size-gate-db-'));
  const server = newCluster({ databaseDir: directory, user: 'postgres', password: crypto.randomUUID(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  let db;
  try {
    await startCluster(server);
    db = server.getPgClient();
    await db.connect();
    for (const sql of [
      "do $$ begin execute 'select 1 as a into public.size_gate_probe'; end $$",
      "do $$ declare q text := 'select 1 as a into public.size_gate_probe'; begin execute q; end $$",
    ]) {
      await assert.rejects(db.query(sql), (error) => {
        assert.equal(error.code, '0A000', `${sql}: ${error.message}`);
        return true;
      });
      const { rows } = await db.query("select to_regclass('public.size_gate_probe') as probe");
      assert.equal(rows[0].probe, null, sql);
    }
    // The same text at top level does create the table: that is the only SELECT ... INTO the gate counts.
    await db.query('select 1 as a into public.size_gate_probe');
    const { rows } = await db.query("select to_regclass('public.size_gate_probe')::text as probe");
    assert.equal(rows[0].probe, 'size_gate_probe');
  } finally {
    await db?.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});

test('舰队回读在隔离 PostgreSQL 中仅用只读身份核验账本摘要和接口', async () => {
  const databaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-migration-readback-'));
  const server = newCluster({ databaseDir, user: 'postgres', password: 'fixture-local', persistent: false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {} });
  const root = new URL('../../../', import.meta.url);
  const plan = releaseRequirements('a'.repeat(40), file => readFileSync(new URL(file, root)));
  let client;
  try {
    await startCluster(server);
    client = server.getPgClient();
    await client.connect();
    await client.query(`
      create schema clued_private;
      create schema supabase_migrations;
      create role fleet_test_reader;
      grant usage on schema clued_private, supabase_migrations to fleet_test_reader;
      create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[]);
      grant select on supabase_migrations.schema_migrations to fleet_test_reader;
      create type clued_private.ci_nodes_v1 as (id integer);
      create type public.clued_agent_bindings as (id integer);
      create function clued_private.release_door_v1(jsonb) returns jsonb language sql as $$select null::jsonb$$;
      create function clued_private.fleet_accept_door_v1(jsonb) returns jsonb language sql as $$select null::jsonb$$;
    `);
    const snapshot = async () => {
      await client.query('set role fleet_test_reader');
      try { return (await client.query(readbackSql(plan)))[1].rows[0].jsonb_build_object; }
      finally { await client.query('reset role'); }
    };
    assert.deepEqual(missingMigrations(plan, await snapshot()), plan.map(row => row.file));
    const first = plan[0];
    const bytes = await fs.readFile(new URL(`../supabase/migrations/${first.file}`, import.meta.url), 'utf8');
    await client.query(`
      create table clued_private.ci_train_batches_v2 (id integer);
      create function clued_private.ci_train_command_v2(clued_private.ci_nodes_v1,text,jsonb)
        returns jsonb language sql as $$select null::jsonb$$;
    `);
    await client.query('insert into supabase_migrations.schema_migrations values ($1, $2, array[$3])', [first.version, first.name, bytes]);
    const partial = await snapshot();
    assert.deepEqual(partial.applied, [{ version: first.version, name: first.name, digest: first.digest }]);
    assert.deepEqual(missingMigrations(plan, partial), plan.slice(1).map(row => row.file));
    await client.query('update supabase_migrations.schema_migrations set statements = array[$1]', ['select 1;']);
    const changed = await snapshot();
    assert.throws(() => missingMigrations(plan, changed), { code: 'FLEET_MIGRATION_LEDGER_CONFLICT' });
  } finally {
    try { await client?.end(); } finally { await stopCluster(server); }
  }
});
