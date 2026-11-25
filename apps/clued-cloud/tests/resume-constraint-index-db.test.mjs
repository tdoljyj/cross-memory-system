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
import { CLOSEOUT_MIGRATION, assertGatewayCloseoutBoundary, snapshotCallerCatalog, setWorkerGatewayCaller, workerGatewayRpc, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString("hex");


test("resume returns resident constraints as an index unless asked for full text", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-constraint-index-"));
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
    await allowRawTestBindings(admin);

    const userId = uuid();
    const tokenHash = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'index@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Constraint index test',$2,array['context:read','context:write'],array['global'])`,
    [userId, tokenHash]);
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query("set role anon");
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const rpc = async (name, input) =>
      await workerGatewayRpc(workerCaller,name,tokenHash,input);
    const create = async (title, content, typeFields) => {
      const result = await rpc("clued_record_mutate", {
        operation: "create", record_type: "decision", record_schema_version: 1, lifecycle_status: "active", scope: "global",
        idempotency_key: uuid(), authority: "user_explicit", user_confirmed: true, confidence_reason: "constraint index fixture",
        source_refs: [], source_unavailable_reason: null,
        mutation: { title, content, type_fields: typeFields, relations: {} },
      });
      assert.equal(result.status, "committed", JSON.stringify(result));
      return result.target_refs[0].id;
    };

    const longContent = `${"长期规则".repeat(40)} The tail of this rule is only in the full text.`;
    const shortId = await create("Short rule", "Fits in the summary.", { rationale: "fixture", constraint: true });
    const longId = await create("Long rule", longContent, { rationale: "fixture", constraint: true });
    const multilineId = await create("Multiline rule", "First line.\nSecond line.", { rationale: "fixture", constraint: true });
    const plainDecisionId = await create("Plain decision", "Not a resident constraint.", { rationale: "fixture" });

    // The default view is the index: no content or rationale, a one-line
    // summary, and a flag for summaries that are the whole text.
    const indexed = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    assert.equal(indexed.constraint_view, "index");
    const byId = new Map(indexed.active_constraints.map((item) => [item.id, item]));
    assert.deepEqual([...byId.keys()].sort(), [shortId, longId, multilineId].sort());
    for (const item of indexed.active_constraints) {
      assert.deepEqual(Object.keys(item).sort(),
        ["id", "scope", "summary", "summary_is_full_text", "title", "updated_at", "version"]);
    }
    assert.deepEqual(byId.get(shortId), {
      ...byId.get(shortId), title: "Short rule", scope: "global", version: 1,
      summary: "Fits in the summary.", summary_is_full_text: true,
    });
    const longEntry = byId.get(longId);
    assert.equal(longEntry.summary_is_full_text, false);
    assert.equal([...longEntry.summary].length, 121);
    assert.ok(longEntry.summary.endsWith("…"));
    assert.ok(longContent.startsWith(longEntry.summary.slice(0, -1)));
    assert.doesNotMatch(longEntry.summary, /only in the full text/);
    assert.equal(byId.get(multilineId).summary, "First line. Second line.");
    assert.equal(byId.get(multilineId).summary_is_full_text, false);

    // constraint_ids returns those constraints in full inside the index, in
    // the same order; ids that are not resident constraints are ignored.
    const targeted = await rpc("clued_mcp_restore", {
      context_key: "global", response_view: "structured",
      constraint_ids: [longId.toUpperCase(), plainDecisionId, uuid()],
    });
    assert.equal(targeted.constraint_view, "index");
    assert.deepEqual(targeted.active_constraints.map((item) => item.id), indexed.active_constraints.map((item) => item.id));
    const targetedLong = targeted.active_constraints.find((item) => item.id === longId);
    assert.equal(targetedLong.content, longContent);
    assert.equal(targetedLong.rationale, "fixture");
    assert.equal(targeted.active_constraints.find((item) => item.id === shortId).content, undefined);
    assert.equal(targeted.active_constraints.some((item) => item.id === plainDecisionId), false);

    // constraint_view full keeps the previous response.
    const full = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured", constraint_view: "full" });
    assert.equal(full.constraint_view, "full");
    assert.equal(full.active_constraints.find((item) => item.id === longId).content, longContent);
    assert.equal(full.active_constraints.find((item) => item.id === multilineId).content, "First line.\nSecond line.");
    assert.ok(JSON.stringify(indexed.active_constraints).length < JSON.stringify(full.active_constraints).length);

    // The work log prints the summary as each index entry's body.
    const indexedLog = await rpc("clued_mcp_restore", { context_key: "global", response_view: "work_log" });
    assert.match(indexedLog.work_log, /Long rule/);
    assert.match(indexedLog.work_log, /Fits in the summary\./);
    assert.doesNotMatch(indexedLog.work_log, /only in the full text/);
    const fullLog = await rpc("clued_mcp_restore", { context_key: "global", response_view: "work_log", constraint_view: "full" });
    assert.match(fullLog.work_log, /only in the full text/);

    // Each session records the view it was given.
    const views = (await admin.query(`select token_hash,constraint_view from public.clued_continuity_sessions
      where token_hash=any($1)`, [[indexed.session_token, full.session_token].map((token) =>
      crypto.createHash("sha256").update(token).digest("hex"))])).rows;
    assert.deepEqual(views.map((row) => row.constraint_view).sort(), ["full", "index"]);

    // Malformed input is refused before any session is created.
    await assert.rejects(rpc("clued_mcp_restore", { context_key: "global", constraint_view: "summary" }), /invalid_constraint_view/);
    await assert.rejects(rpc("clued_mcp_restore", { context_key: "global", constraint_ids: longId }), /invalid_constraint_ids/);
    await assert.rejects(rpc("clued_mcp_restore", { context_key: "global", constraint_ids: ["not-a-uuid"] }), /invalid_constraint_ids/);
    await assert.rejects(rpc("clued_mcp_restore", { context_key: "global", constraint_ids: [42] }), /invalid_constraint_ids/);
    await assert.rejects(rpc("clued_mcp_restore", {
      context_key: "global", constraint_ids: Array.from({ length: 51 }, () => uuid()),
    }), /invalid_constraint_ids/);
    // The entire current chain was applied above; reapply the real closeout and compare catalog metadata.
    await assertGatewayCloseoutBoundary(admin);
    const closedCatalog=await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8'));
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual(await snapshotCallerCatalog(admin),closedCatalog,'actual G6 replay preserves definitions and ACL');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});

// The current account review policy is part of the same resume/renewal surface.
import './independent-review-db.test.mjs';
