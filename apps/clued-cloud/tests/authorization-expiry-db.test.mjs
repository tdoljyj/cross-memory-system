import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// OAuth consent lifetimes (migration 20261004140000, Owner Decision a28a9868):
// the Owner may choose up to 365 days; the database still refuses anything
// longer, and the rest of the approval kernel is unchanged.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = () => crypto.randomBytes(32).toString('hex');
const DAY = 86400000;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('OAuth approval accepts lifetimes up to 365 days and refuses longer ones', { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-consent-expiry-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hex(), port: await freePort(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }

    await allowTestIssuerCredentials(admin);

    const definition = (await admin.query(`select pg_get_functiondef(
      'clued_private.ii_pub_clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz)'::regprocedure) body`)).rows[0].body;
    assert.match(definition, /p_expires_at>clock_timestamp\(\)\+interval '365 days'/);
    assert.doesNotMatch(definition, /interval '30 days'/);
    assert.match(definition, /authorization_context_grant_v13/, 'the v13 context-grant adapter is kept');

    const userId = crypto.randomUUID();
    const issuer = hex();
    const resource = 'https://mcp.example.invalid/mcp';
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'consent@example.invalid',now())`, [userId]);
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Test gateway')`, [issuer, resource]);

    const owner = server.getPgClient();
    clients.push(owner);
    await owner.connect();
    await owner.query('set role authenticated');
    await owner.query(`select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)`,
      [userId, JSON.stringify({ sub: userId })]);
    const rpc = async (name, args) => (await owner.query(
      `select public.${name}(${args.map((_, n) => `$${n + 1}`).join(',')}) value`,
      args.map((arg) => (typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : arg)))).rows[0].value;
    const approveFor = async (lifetimeMs) => {
      const request = await rpc('clued_authorization_prepare_v12', [issuer, {
        request_digest: hex(), client_id: 'consent-client', client_name: 'Consent test',
        redirect_uri: 'https://client.example.invalid/callback', resource, requested_scopes: ['context:read'] }]);
      const selected = [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }];
      const expires = new Date(Date.now() + lifetimeMs).toISOString();
      return { expires, result: rpc('clued_authorization_approve_v12', [issuer, request.request_id, request.version, selected, hex(), expires]) };
    };

    for (const days of [90, 365]) {
      const { expires, result } = await approveFor(days * DAY - 60000);
      const approved = await result;
      assert.equal(typeof approved.binding_id, 'string', `${days} days approves`);
      assert.equal(Date.parse(approved.expires_at), Date.parse(expires));
    }
    const { result: tooLong } = await approveFor(366 * DAY);
    await assert.rejects(tooLong, (error) => error.code === '22023' && /invalid_authorization_expiry/.test(error.message));
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
