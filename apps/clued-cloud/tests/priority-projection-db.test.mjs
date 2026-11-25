import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { newCluster } from "./pg-cluster-fixture.mjs";

// raw-binding-grants: applies only migrations before 20261009050000, where raw Bindings still pass.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationName = "20260922030001_sync_m1_record_priority_projection.sql";
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString("hex");


test("M1 priority updates and legacy list ordering stay aligned after repairing existing drift", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-priority-projection-"));
  const server = newCluster({
    databaseDir: directory, user: "postgres", password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  let admin;
  let anon;
  try {
    await startCluster(server);
    admin = server.getPgClient();
    await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrations = path.join(root, "supabase/migrations");
    // This regression deliberately constructs the state immediately before
    // its target migration, even when later migrations have been added.
    const names = (await fs.readdir(migrations)).filter((name) => name.endsWith(".sql") && name <= migrationName).sort();
    assert.equal(names.at(-1), migrationName);
    for (const name of names.filter((name) => name !== migrationName)) {
      try { await admin.query(await fs.readFile(path.join(migrations, name), "utf8")); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }

    const userId = uuid();
    const tokenHash = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'priority@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Priority projection database test',$2,array['context:read','context:write'],array['global'])`, [userId, tokenHash]);
    anon = server.getPgClient();
    await anon.connect();
    await anon.query("set role anon");
    const mutate = async (input) => (await anon.query("select public.clued_record_mutate($1,$2) value", [tokenHash, input])).rows[0].value;
    const list = async () => (await anon.query("select public.clued_record_list($1,$2) value", [tokenHash, { level: "global", record_type: "task" }])).rows[0].value.records;
    const create = async (id, title, priority) => mutate({
      operation: "create", id, record_type: "task", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Synthetic priority test",
      source_refs: [], source_unavailable_reason: null,
      mutation: { title, content: "Priority projection test", type_fields: { execution_bucket: "next", priority }, relations: {} },
    });
    const firstId = uuid();
    const secondId = uuid();
    const importedId = uuid();
    assert.equal((await create(firstId, "First task", 80)).status, "committed");
    assert.equal((await create(secondId, "Second task", 50)).status, "committed");
    assert.equal((await create(importedId, "Imported priority task", undefined)).status, "committed");
    // Existing imported M1 rows can have a meaningful compatibility priority
    // without type_fields.priority. The migration must not erase that value.
    await admin.query("update public.clued_memories set priority=40 where id=$1", [importedId]);
    assert.equal((await mutate({
      operation: "update", id: firstId, record_type: "task", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", base_version: 1, idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Synthetic priority test",
      mutation: { type_fields: { execution_bucket: "next", priority: 20 } },
    })).status, "committed");
    const before = (await admin.query("select priority, type_fields->>'priority' as canonical_priority, version from public.clued_memories where id=$1", [firstId])).rows[0];
    assert.deepEqual([before.priority, before.canonical_priority, Number(before.version)], [80, "20", 2]);
    assert.equal((await list())[0].id, firstId, "the old list incorrectly sorts by stale priority");

    await admin.query(await fs.readFile(path.join(migrations, migrationName), "utf8"));
    const repaired = (await admin.query("select priority, type_fields->>'priority' as canonical_priority, version from public.clued_memories where id=$1", [firstId])).rows[0];
    assert.deepEqual([repaired.priority, repaired.canonical_priority, Number(repaired.version)], [20, "20", 2]);
    assert.equal((await list())[0].id, secondId, "the repaired list follows the canonical priority");
    assert.equal((await admin.query("select priority from public.clued_memories where id=$1", [importedId])).rows[0].priority, 40);

    await assert.rejects(() => anon.query("select public.clued_record_write($1,$2)", [tokenHash, {
      action: "update", scope: "global", record_type: "task", record_id: firstId,
      expected_version: 2, idempotency_key: uuid(), priority: 75,
    }]), /permission denied for function clued_record_write/);
    await assert.rejects(() => admin.query("update public.clued_memories set priority=75 where id=$1", [firstId]),
      /m1_priority_write_requires_record_mutate/);
    const afterLegacyRejection = (await admin.query("select priority, version from public.clued_memories where id=$1", [firstId])).rows[0];
    assert.deepEqual([afterLegacyRejection.priority, Number(afterLegacyRejection.version)], [20, 2]);

    assert.equal((await mutate({
      operation: "update", id: importedId, record_type: "task", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", base_version: 1, idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Synthetic priority test",
      mutation: { type_fields: { execution_bucket: "later" } },
    })).status, "committed");
    assert.equal((await admin.query("select priority from public.clued_memories where id=$1", [importedId])).rows[0].priority, 40);

    assert.equal((await mutate({
      operation: "update", id: firstId, record_type: "task", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", base_version: 2, idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Synthetic priority test",
      mutation: { type_fields: { execution_bucket: "next", priority: 95 } },
    })).status, "committed");
    assert.equal((await list())[0].id, firstId);
    const updated = (await admin.query("select priority, version from public.clued_memories where id=$1", [firstId])).rows[0];
    assert.deepEqual([updated.priority, Number(updated.version)], [95, 3]);
    assert.equal((await mutate({
      operation: "update", id: firstId, record_type: "task", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", base_version: 3, idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Synthetic priority test",
      mutation: { type_fields: { execution_bucket: "later" } },
    })).status, "committed");
    assert.equal((await admin.query("select priority from public.clued_memories where id=$1", [firstId])).rows[0].priority, 0);
  } finally {
    await anon?.end();
    await admin?.end();
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
