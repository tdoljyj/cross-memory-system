// What the capacity gate (scripts/migration-size-gate.mjs) relies on when it does not count SELECT ... INTO tokenized from
// a string literal (FABLE-prod-db-shrink-v2-20261124 §13): PL/pgSQL's EXECUTE refuses SELECT ... INTO with SQLSTATE 0A000
// ("EXECUTE of SELECT ... INTO is not implemented"), so a migration cannot create a table that way.
// If this test turns red, PostgreSQL has started to accept it: the gate must then count SELECT ... INTO in the literal of
// an EXECUTE again (tighten the rule in the same change).
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('EXECUTE of SELECT ... INTO fails with 0A000 and creates no table', { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-size-gate-db-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: crypto.randomUUID(),
    port: await freePort(), persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  let db;
  try {
    await server.initialise();
    await server.start();
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
