import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// Compatibility of the complete committed migration order, separate from the
// authorization suite's deliberately small M1 fixture. Never targets a service.
test('all repository migrations apply in order to an isolated PostgreSQL database', { timeout: 180000 }, async () => {
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-migration-chain-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: crypto.randomBytes(32).toString('hex'), port, persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  let db;
  try {
    await server.initialise(); await server.start(); db = server.getPgClient(); await db.connect();
    await db.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir('supabase/migrations')).filter(n => n.endsWith('.sql')).sort();
    for (const name of names) {
      try { await db.query(await fs.readFile(path.join('supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    assert.ok(names.includes('20260907161611_clued_connection_authorization_v12.sql'));
    assert.ok((await db.query("select to_regprocedure('public.clued_authorization_status_v12(text)') is not null ready")).rows[0].ready);
  } finally {
    if (db) await db.end();
    await server.stop();
  }
});
