// BUG-20261001-002: a replacement Decision written through decision_supersede
// with a missing record_schema_version became an unreachable NULL-schema row
// (readable as CURRENT, never again supersedable or updatable). The shared
// validator and the supersede core must now reject it with a receipt.
import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { newCluster } from "./pg-cluster-fixture.mjs";
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { setWorkerGatewayCaller, findGatewayCloseoutMigration, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString("hex");


test("decision supersede rejects a replacement without record_schema_version", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-supersede-schema-"));
  const server = newCluster({
    databaseDir: directory,
    user: "postgres",
    password: hash(),
    persistent: false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {},
    onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await startCluster(server);
    const admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
      await admin.query(await fs.readFile(path.join(root, "supabase/migrations", name), "utf8"));
    }
    // The complete migration chain must include the formal G6 closeout.
    await findGatewayCloseoutMigration(root);
    await assertGatewayCloseoutBoundary(admin);
    await allowRawTestBindings(admin);

    const userId = uuid();
    const token = hash();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'supersede@example.invalid',now())`, [userId]);
    const bindingId = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','All scopes',$2,array['context:read','context:write'],array['*']) returning id`, [userId, token])).rows[0].id;
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);

    const mutate = async (input) =>
      (await gateway.query("select public.clued_record_mutate($1,$2) value", [token, input])).rows[0].value;
    const supersedeRpc = async (input) =>
      (await gateway.query("select public.clued_decision_supersede($1,$2) value", [token, input])).rows[0].value;
    // The binding RPC entry raises replacement_scope_required before a receipt
    // exists; the core is called directly to prove the receipt-backed rejections.
    const supersedeCore = async (input) =>
      (await admin.query("select clued_private.decision_supersede_core($1,$2,$3,$4) value",
        [userId, bindingId, input, hash()])).rows[0].value;
    const createDecision = async () => {
      const result = await mutate({
        operation: "create", record_type: "decision", record_schema_version: 1, lifecycle_status: "active", scope: "global",
        idempotency_key: uuid(), authority: "observed", confidence_reason: "schema guard fixture",
        source_refs: [], source_unavailable_reason: "fixture",
        mutation: { title: "Decision fixture", content: "fixture", type_fields: { rationale: "fixture" }, relations: {} },
      });
      assert.equal(result.status, "committed", JSON.stringify(result));
      return result.target_refs[0].id;
    };
    const replacementFor = (sourceId, overrides = {}) => ({
      record_schema_version: 1, scope: "global", title: "Replacement", content: "current",
      type_fields: { rationale: "replaces the source" }, relations: { supersedes: [sourceId] },
      source_refs: [], source_unavailable_reason: "fixture", authority: "observed", confidence_reason: "fixture",
      ...overrides,
    });
    const supersedeInput = (sourceId, replacement) => ({
      source_decisions: [{ id: sourceId, base_version: 1 }], replacement,
      supersede_reason: "schema guard", idempotency_key: uuid(),
    });
    const sourceState = async (id) =>
      (await admin.query("select lifecycle_status,version from public.clued_memories where id=$1", [id])).rows[0];
    const nullSchemaRows = async () =>
      Number((await admin.query("select count(*) from public.clued_memories where user_id=$1 and record_schema_version is null", [userId])).rows[0].count);
    const rejected = (result, errorCode) => {
      assert.equal(result.status, "rejected", JSON.stringify(result));
      assert.equal(result.error_code, errorCode, JSON.stringify(result));
      assert.equal(typeof result.receipt_id, "string");
    };

    const source = await createDecision();

    // The exact production shape: replacement.record_schema_version omitted.
    const omitted = replacementFor(source);
    delete omitted.record_schema_version;
    rejected(await supersedeCore(supersedeInput(source, omitted)), "replacement_record_schema_version_required");
    rejected(await supersedeRpc(supersedeInput(source, omitted)), "replacement_record_schema_version_required");
    rejected(await supersedeCore(supersedeInput(source, replacementFor(source, { record_schema_version: null }))),
      "replacement_record_schema_version_required");
    rejected(await supersedeCore(supersedeInput(source, replacementFor(source, { record_schema_version: "1" }))),
      "replacement_record_schema_version_required");
    rejected(await supersedeCore(supersedeInput(source, replacementFor(source, { record_schema_version: 2 }))), "invalid_record_schema");
    rejected(await supersedeCore(supersedeInput(source, replacementFor(source, { record_schema_version: 1.5 }))), "invalid_record_schema");

    // The other replacement fields the insert needs.
    rejected(await supersedeCore({ ...supersedeInput(source, replacementFor(source)), replacement: undefined }), "replacement_required");
    rejected(await supersedeCore(supersedeInput(source, [])), "replacement_required");
    const noScope = replacementFor(source);
    delete noScope.scope;
    rejected(await supersedeCore(supersedeInput(source, noScope)), "replacement_scope_required");
    rejected(await supersedeCore(supersedeInput(source, replacementFor(source, { scope: " " }))), "replacement_scope_required");
    const noAuthority = replacementFor(source);
    delete noAuthority.authority;
    rejected(await supersedeCore(supersedeInput(source, noAuthority)), "invalid_authority");
    rejected(await supersedeCore(supersedeInput(source, replacementFor(source, { authority: "owner" }))), "invalid_authority");
    rejected(await supersedeCore(supersedeInput(source, replacementFor(source, { scope: `project:${uuid()}` }))), "decision_scope_mismatch");

    // Nothing was closed and no unreachable row was written.
    assert.deepEqual(await sourceState(source), { lifecycle_status: "active", version: "1" });
    assert.equal(await nullSchemaRows(), 0);

    // A complete replacement still commits, carries schema version 1, and can
    // itself be superseded again (the chain 326b44b9 could not continue).
    const first = await supersedeRpc(supersedeInput(source, replacementFor(source)));
    assert.equal(first.status, "committed", JSON.stringify(first));
    const replacementId = first.target_refs.find((ref) => ref.role === "target").id;
    assert.equal(first.supplemental.replacement.record_schema_version, 1);
    assert.deepEqual(await sourceState(source), { lifecycle_status: "superseded", version: "2" });
    const second = await supersedeRpc(supersedeInput(replacementId, replacementFor(replacementId)));
    assert.equal(second.status, "committed", JSON.stringify(second));
    const currentId = second.target_refs.find((ref) => ref.role === "target").id;
    assert.deepEqual(await sourceState(replacementId), { lifecycle_status: "superseded", version: "2" });
    assert.deepEqual(await sourceState(currentId), { lifecycle_status: "active", version: "1" });
    assert.equal(await nullSchemaRows(), 0);

    // The shared validator now fails closed for every caller.
    for (const input of [
      { record_schema_version: null },
      { record_schema_version: undefined },
      { record_schema_version: 0 },
    ]) {
      const result = await mutate({
        operation: "create", record_type: "note", lifecycle_status: "active", scope: "global",
        idempotency_key: uuid(), authority: "observed", confidence_reason: "schema guard fixture",
        source_refs: [], source_unavailable_reason: "fixture",
        mutation: { title: "Note", content: "fixture", type_fields: { note_kind: "log" }, relations: {} },
        ...input,
      });
      rejected(result, "invalid_record_schema");
    }
    const update = await mutate({
      operation: "update", record_type: "decision", lifecycle_status: "active", scope: "global",
      id: currentId, base_version: 1, idempotency_key: uuid(), authority: "observed",
      confidence_reason: "schema guard fixture", mutation: { content: "edited" },
    });
    rejected(update, "invalid_record_schema");
    await assert.rejects(
      admin.query("select clued_private.m1_validate_record_shape('decision',null,'{\"rationale\":\"x\"}','{}')"),
      /invalid_record_schema/);
    await assert.rejects(
      admin.query("select clued_private.m1_validate_record_shape(null,1,'{\"rationale\":\"x\"}','{}')"),
      /invalid_record_schema/);
    assert.equal(await nullSchemaRows(), 0);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
