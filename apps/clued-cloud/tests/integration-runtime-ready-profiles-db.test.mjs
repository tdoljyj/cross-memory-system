import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// Plugin line S3 (Cross-Host v0.2.6 §20, §41.0; Task 9966975d): the production READY profiles that
// 20261007060000_integration_runtime_ready_profiles.sql seeds, one per registered Host surface.
// Every database runs as a non-root OS user (embedded-postgres refuses root).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261007060000_integration_runtime_ready_profiles.sql';
const PROFILES = ['anthropic.claude.chat.continuity', 'anthropic.claude.claude_code.continuity',
  'anthropic.claude.cowork.continuity', 'openai.chatgpt.codex.continuity', 'openai.chatgpt.desktop.continuity',
  'openai.chatgpt.mobile.continuity', 'openai.chatgpt.web.continuity'];
const FAMILIES = ['record_mutation', 'decision_supersede'];

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('S3 READY profiles: one continuity profile per registered surface', { timeout: 1_800_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-ready-profiles-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: sha(crypto.randomUUID()), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync', '-c', 'max_connections=20'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  const connect = async () => {
    const client = server.getPgClient();
    clients.push(client);
    await client.connect();
    return client;
  };
  try {
    await server.initialise();
    await server.start();
    const admin = await connect();
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
    const dir = path.join(root, 'supabase/migrations');
    const migrations = (await fs.readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(migrations.includes(MIGRATION));
    for (const name of migrations) {
      try { await admin.query(await fs.readFile(path.join(dir, name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }

    await t.test('the seven profiles, version 1, ask context.read and context.write with ANY qualification', async () => {
      const { rows } = await admin.query(`select profile_id, profile_version, required_capabilities, required_qualification,
          evidence_rules, extract(epoch from freshness_ttl)::bigint ttl,
          clued_private.integration_ready_rules_valid_v1(required_capabilities, evidence_rules) rules_valid
        from clued_private.integration_ready_profiles_v1
        where profile_id ~ '^(anthropic\\.claude|openai\\.chatgpt)\\.' order by profile_id`);
      assert.deepEqual(rows.map((r) => r.profile_id), PROFILES);
      for (const row of rows) {
        assert.equal(row.profile_version, 1, row.profile_id);
        assert.deepEqual(row.required_capabilities, ['context.read', 'context.write'], row.profile_id);
        assert.equal(row.required_qualification, 'ANY', row.profile_id);
        assert.equal(Number(row.ttl), 30 * 24 * 3600, row.profile_id);
        assert.equal(row.rules_valid, true, row.profile_id);
        assert.deepEqual(row.evidence_rules, {
          'context.read': { kind: 'resume_after_link' },
          'context.write': { kind: 'committed_receipt_after_link', families: FAMILIES },
        }, row.profile_id);
      }
    });

    await t.test('every profile names a registered Host surface, and every surface has one', async () => {
      const { rows } = await admin.query(`select host || '.' || surface || '.continuity' id
        from clued_private.integration_host_surfaces_v1 where host <> 'generic.mcp' order by 1`);
      assert.deepEqual(rows.map((r) => r.id), PROFILES);
    });

    await t.test('the evidence families are ones Clued writes for ordinary record and decision writes', async () => {
      const sources = await Promise.all(migrations.filter((name) => name < MIGRATION)
        .map((name) => fs.readFile(path.join(dir, name), 'utf8')));
      for (const family of FAMILIES) {
        assert.ok(sources.some((text) => text.includes(`'${family}'`)), `${family} is an operation family`);
        assert.doesNotMatch(family, /^integration_/);
      }
    });

    await t.test('the migration changes data only: no grant on the profile table', async () => {
      const { rows } = await admin.query(`select r.rolname, has_table_privilege(r.rolname,
          'clued_private.integration_ready_profiles_v1', 'select') can_select
        from (values ('anon'), ('authenticated'), ('service_role')) r(rolname)`);
      for (const row of rows) assert.equal(row.can_select, false, row.rolname);
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
