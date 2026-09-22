import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import EmbeddedPostgres from "embedded-postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString("hex");

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test("terminal restore binds explicit intent to the exact closeout Receipt", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-v2-restore-"));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: "postgres", password: hash(),
    port: await freePort(), persistent: false,
    postgresFlags: ["-c", "io_method=sync"],
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
    for (const name of (await fs.readdir(path.join(root, "supabase/migrations")))
      .filter((name) => name.endsWith(".sql")).sort()) {
      try {
        await admin.query(await fs.readFile(path.join(root, "supabase/migrations", name), "utf8"));
      } catch (error) {
        throw new Error(`Migration ${name}: ${error.message}`, { cause: error });
      }
    }

    const userId = uuid();
    const tokenHash = hash();
    await admin.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'restore@example.invalid',now())",
      [userId]);
    await admin.query(`insert into public.clued_agent_bindings(
      user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Terminal restore test',$2,
        array['context:read','context:write'],array['global'])`, [userId, tokenHash]);
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query("set role anon");
    const rpc = async (input) =>
      (await anon.query("select public.clued_record_mutate($1,$2) value",
        [tokenHash, input])).rows[0].value;
    const base = {
      record_type: "task", record_schema_version: 1, scope: "global",
      authority: "user_explicit", user_confirmed: true,
      confidence_reason: "Synthetic terminal guard regression",
    };
    const created = await rpc({
      ...base, operation: "create", lifecycle_status: "active",
      idempotency_key: uuid(), source_refs: [], source_unavailable_reason: null,
      mutation: {
        title: "Synthetic accepted task", content: "Versioned fixture",
        type_fields: { execution_bucket: "later" }, relations: {},
      },
    });
    assert.equal(created.status, "committed", JSON.stringify(created));
    const recordId = created.target_refs[0].id;
    const closed = await rpc({
      ...base, operation: "close", id: recordId, base_version: 1,
      lifecycle_status: "completed", idempotency_key: uuid(),
      mutation: { closed_reason: "Synthetic acceptance" },
    });
    assert.equal(closed.status, "committed", JSON.stringify(closed));
    const terminalReceipt = closed.receipt_id;
    const restore = {
      ...base, operation: "restore", id: recordId, base_version: 2,
      lifecycle_status: "active", idempotency_key: uuid(),
      mutation: {},
    };
    await assert.rejects(() => rpc(restore),
      /terminal_restore_requires_explicit_authorization/);
    await assert.rejects(() => rpc({
      ...restore, idempotency_key: uuid(), reopen_reason: "Reopen synthetic task",
      terminal_receipt_id: uuid(),
    }), /terminal_restore_requires_explicit_authorization/);
    await assert.rejects(() => rpc({
      ...restore, idempotency_key: uuid(), authority: "observed",
      reopen_reason: "Reopen synthetic task", terminal_receipt_id: terminalReceipt,
    }), /terminal_restore_requires_explicit_authorization/);
    const authorized = {
      ...restore, idempotency_key: uuid(), reopen_reason: "Owner authorized a new pass",
      terminal_receipt_id: terminalReceipt,
    };
    const stale = await rpc({ ...authorized, idempotency_key: uuid(), base_version: 1 });
    assert.equal(stale.status, "rejected");
    assert.equal(stale.error_code, "RECORD_VERSION_CONFLICT");
    const reopened = await rpc(authorized);
    assert.equal(reopened.status, "committed", JSON.stringify(reopened));
    assert.equal(reopened.replayed, false);
    const audit = (await admin.query(
      "select * from clued_private.record_reopen_audit where record_id=$1",
      [recordId])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].terminal_receipt_id, terminalReceipt);
    assert.equal(audit[0].terminal_version, "2");
    assert.equal(audit[0].reopen_reason, authorized.reopen_reason);
    const replay = await rpc(authorized);
    assert.equal(replay.status, "committed");
    assert.equal(replay.receipt_id, reopened.receipt_id);
    assert.equal(replay.replayed, true);
    const oldLateWrite = await rpc({
      ...base, operation: "close", id: recordId, base_version: 1,
      lifecycle_status: "completed", idempotency_key: uuid(),
    });
    assert.equal(oldLateWrite.status, "rejected");
    assert.equal(oldLateWrite.error_code, "RECORD_VERSION_CONFLICT");
    const newerClose = await rpc({
      ...base, operation: "close", id: recordId, base_version: 3,
      lifecycle_status: "completed", idempotency_key: uuid(),
    });
    assert.equal(newerClose.status, "committed");
    assert.equal((await rpc(authorized)).receipt_id, reopened.receipt_id);
    const current = (await admin.query(
      "select lifecycle_status,version,receipt_id from public.clued_memories where id=$1",
      [recordId])).rows[0];
    assert.equal(current.lifecycle_status, "completed");
    assert.equal(current.version, "4");
    assert.equal(current.receipt_id, newerClose.receipt_id);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
