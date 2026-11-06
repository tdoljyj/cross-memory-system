import { stopCluster } from './cluster-cleanup.mjs';
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
for (const profile of ['complete-repository', 'production-installed-shape']) test(profile + ': retired baseline upgrades to successor without reviving old surfaces', { timeout: 180000 }, async () => {
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-migration-chain-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: crypto.randomBytes(32).toString('hex'), port, persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(message) { process.stderr.write(message + '\n'); } });
  let db;
  try {
    await server.initialise(); await server.start(); db = server.getPgClient(); await db.connect();
    await db.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir('supabase/migrations')).filter(n => n.endsWith('.sql') && (profile === 'complete-repository' || !n.includes('p5_'))).sort();
    for (const name of names) {
      try { await db.query(await fs.readFile(path.join('supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    assert.ok(names.includes('20260907173031_clued_connection_authorization_v12.sql'));
    assert.ok(names.indexOf('20260907172309_retire_context_ownership_publication_v11.sql') < names.indexOf('20260907173030_clued_development_context_runtime_v14.sql'));
    const shape = (await db.query(`select
      to_regclass('clued_private.context_spaces_v11') is null old_absent,
      to_regclass('clued_private.context_publications_v11') is null publication_absent,
      to_regclass('clued_private.development_spaces_v14') is not null successor_present,
      to_regprocedure('public.clued_context_owner(jsonb)') is null old_owner_absent,
      to_regprocedure('public.clued_development_owner_v14(jsonb)') is not null successor_owner_present`)).rows[0];
    for (const [name, valid] of Object.entries(shape)) assert.equal(valid, true, name);
    assert.ok((await db.query("select to_regprocedure('public.clued_authorization_status_v12(text)') is not null ready")).rows[0].ready);
  } finally {
    if (db) await db.end();
    await stopCluster(server);
  }
});
