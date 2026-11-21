import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import EmbeddedPostgres from "embedded-postgres";
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

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
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
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
    await allowRawTestBindings(admin);

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
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const rpc = input => workerGatewayRpc(workerCaller,'clued_record_mutate',tokenHash,input);
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
    for (const invalid of [restore, {
      ...restore, idempotency_key: uuid(), reopen_reason: "Reopen synthetic task",
      terminal_receipt_id: uuid(),
    }, {
      ...restore, idempotency_key: uuid(), authority: "observed",
      reopen_reason: "Reopen synthetic task", terminal_receipt_id: terminalReceipt,
    }]) {
      const rejected = await rpc(invalid);
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.error_code, "terminal_restore_requires_explicit_authorization");
      assert.ok(rejected.receipt_id);
      const replay = await rpc(invalid);
      assert.equal(replay.receipt_id, rejected.receipt_id);
      assert.equal(replay.replayed, true);
    }
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

    // Three public RPC transactions: close queues before a restore retry.
    const connections = [];
    for (let i = 0; i < 3; i++) {
      const client = server.getPgClient(); clients.push(client);
      await client.connect(); await setWorkerGatewayCaller(client);
      await client.query('begin'); connections.push(client);
    }
    const [a, c, b] = connections;
    const invoke = async (client, input) => (await client.query(
      'select public.clued_record_mutate($1,$2) value', [tokenHash, input])).rows[0].value;
    const waitLocked = async (client) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const result = await admin.query(
          "select wait_event_type from pg_stat_activity where pid=$1", [client.processID]);
        if (result.rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Expected competing transaction to wait on a database lock');
    };
    const concurrentRestore = { ...authorized, base_version: 4, idempotency_key: uuid(),
      terminal_receipt_id: newerClose.receipt_id };
    const firstRestore = await invoke(a, concurrentRestore);
    assert.equal(firstRestore.status, 'committed');
    const closePromise = invoke(c, { ...base, operation: 'close', id: recordId,
      base_version: 5, lifecycle_status: 'completed', idempotency_key: uuid(), mutation: {} });
    await waitLocked(c);
    const retryPromise = invoke(b, concurrentRestore);
    await waitLocked(b);
    await a.query('commit');
    const concurrentClose = await closePromise;
    assert.equal(concurrentClose.status, 'committed');
    await c.query('commit');
    const concurrentReplay = await retryPromise;
    assert.equal(concurrentReplay.receipt_id, firstRestore.receipt_id);
    assert.equal(concurrentReplay.replayed, true);
    await b.query('commit');
    const finalRow = (await admin.query(
      'select version,lifecycle_status,receipt_id from public.clued_memories where id=$1', [recordId])).rows[0];
    assert.equal(finalRow.version, '6');
    assert.equal(finalRow.lifecycle_status, 'completed');
    assert.equal(finalRow.receipt_id, concurrentClose.receipt_id);
    assert.equal((await admin.query('select count(*) from clued_private.record_reopen_audit where record_id=$1',
      [recordId])).rows[0].count, '2');
    const changedRetry = await rpc({ ...concurrentRestore, reopen_reason: 'Changed payload' });
    assert.equal(changedRetry.error_code, 'IDEMPOTENCY_KEY_CONFLICT');

    const human = server.getPgClient(); clients.push(human); await human.connect();
    await human.query('set role authenticated');
    await human.query("select set_config('request.jwt.claim.sub',$1,false)", [userId]);
    const ownerWrite = async () => (await human.query(
      'select public.clued_user_record_mutate($1,$2) value', [{ ...base, operation: 'create',
        idempotency_key: uuid(), source_refs: [], source_unavailable_reason: null,
        mutation: { title: 'Human fixture', content: 'Human fixture',
          type_fields: { execution_bucket: 'later' }, relations: {} } }, hash()])).rows[0].value;
    assert.equal((await ownerWrite()).status, 'committed');
    const countReceipts = async () => (await admin.query(
      'select count(*) from public.clued_audit_receipts where user_id=$1', [userId])).rows[0].count;
    const receiptCount = await countReceipts();
    await human.query(`select set_config('request.jwt.claims','{"client_id":"legacy-oauth"}',false)`);
    await assert.rejects(ownerWrite, /direct_human_session_required/);
    await human.query("select set_config('request.jwt.claims','{}',false)");
    await admin.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [userId]);
    await assert.rejects(ownerWrite, /account/);
    await admin.query('update auth.users set banned_until=null,deleted_at=now() where id=$1', [userId]);
    await assert.rejects(ownerWrite, /account/);
    assert.equal(await countReceipts(), receiptCount);
    // The entire current chain was applied above; reapply the real closeout and compare catalog metadata.
    await assertGatewayCloseoutBoundary(admin);
    const closedCatalog=await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8'));
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual(await snapshotCallerCatalog(admin),closedCatalog,'actual G6 replay preserves definitions and ACL');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
