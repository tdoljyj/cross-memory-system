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
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

test("K-CONT explicit coverage preserves unabsorbed continuity", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-k-cont-"));
  const server = new EmbeddedPostgres({
    databaseDir: directory,
    user: "postgres",
    password: hash(),
    port: await freePort(),
    persistent: false,
    postgresFlags: ["-c", "io_method=sync"],
    onLog() {},
    onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
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

    const userId = uuid();
    const tokenHash = hash();
    const projectContext = `project:${uuid()}`;
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'k-cont@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','K-CONT database test',$2,array['context:read','context:write','audit:read'],array['global',$3])`,
      [userId, tokenHash, projectContext]);
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query("set role anon");
    const rpc = async (name, input) => (await anon.query(`select public.${name}($1,$2) value`, [tokenHash, input])).rows[0].value;

    const restored = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured", event_limit: 1, event_budget_bytes: 4096 });
    const first = await rpc("clued_mcp_append_event", {
      context_key: "global", session_token: restored.session_token, base_version: restored.version,
      event_type: "note", payload: { marker: "k-cont-first" }, idempotency_key: uuid(),
    });
    const second = await rpc("clued_mcp_append_event", {
      context_key: "global", session_token: restored.session_token, base_version: first.version,
      event_type: "note", payload: { marker: "k-cont-second" }, idempotency_key: uuid(),
    });
    await assert.rejects(
      rpc("clued_mcp_commit_checkpoint", {
        context_key: "global", session_token: restored.session_token, base_version: second.version,
        snapshot: { stage: "K-CONT" }, summary: "Reject missing coverage mode.",
        next_action: "Keep both events pending.", idempotency_key: uuid(),
        coverage: { contexts: ["global"], tracks: ["k-cont"], event_ids: [first.event_id] },
      }),
      /checkpoint_coverage_required/,
    );
    const checkpoint = await rpc("clued_mcp_commit_checkpoint", {
      context_key: "global", session_token: restored.session_token, base_version: second.version,
      snapshot: { stage: "K-CONT" }, summary: "Absorb only the declared event.", next_action: "Resume the uncovered event.",
      idempotency_key: uuid(), coverage: { mode: "explicit", contexts: ["global"], tracks: ["k-cont"], event_ids: [first.event_id] },
    });
    assert.equal(checkpoint.status, "committed");
    assert.equal(checkpoint.absorbed_event_count, 1);
    assert.equal(checkpoint.pending_event_count_after, 1);

    const after = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured", event_limit: 1, event_budget_bytes: 4096 });
    assert.equal(after.pending_event_count, 1);
    assert.deepEqual(after.events_after_checkpoint.map((event) => Number(event.id)), [Number(second.event_id)]);
    assert.equal(after.event_page.truncated, false);

    const decision = await rpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1, lifecycle_status: "active", scope: "global",
      idempotency_key: uuid(), authority: "user_explicit", user_confirmed: true, confidence_reason: "K-CONT database fixture",
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: "Resident constraint", content: "Remain visible during resume.", type_fields: { rationale: "fixture", constraint: true }, relations: {} },
    });
    assert.equal(decision.status, "committed");
    const constrained = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    assert.equal(constrained.active_constraints.length, 1);
    assert.equal(constrained.active_constraints[0].title, "Resident constraint");
    assert.equal(constrained.active_constraints[0].content, "Remain visible during resume.");
    assert.ok(constrained.authority_conflicts.some((item) => item.title === "Resident constraint" && item.status === "review_required"));

    const boundedSession = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    const boundedFirst = await rpc("clued_mcp_append_event", {
      context_key: "global", session_token: boundedSession.session_token, base_version: boundedSession.version,
      event_type: "note", payload: { marker: "bounded-first" }, idempotency_key: uuid(),
    });
    await rpc("clued_mcp_append_event", {
      context_key: "global", session_token: boundedSession.session_token, base_version: boundedFirst.version,
      event_type: "note", payload: { marker: "bounded-second" }, idempotency_key: uuid(),
    });
    const workLog = await rpc("clued_mcp_restore", {
      context_key: "global", response_view: "work_log", event_cursor: Number(boundedFirst.event_id) - 1, event_limit: 1, event_budget_bytes: 4096,
    });
    assert.equal(typeof workLog.work_log, "string");
    assert.equal("events_after_checkpoint" in workLog, false);
    assert.equal(workLog.event_page.returned, 1);
    assert.equal(workLog.event_page.truncated, true);
    assert.match(workLog.work_log, /bounded-first/);
    assert.doesNotMatch(workLog.work_log, /bounded-second/);
    assert.match(workLog.work_log, /More pending events remain/);

    const projectWorkLog = await rpc("clued_mcp_restore", {
      context_key: projectContext, response_view: "work_log", event_limit: 1, event_budget_bytes: 4096,
    });
    assert.match(projectWorkLog.work_log, /Resident constraint/);
    assert.match(projectWorkLog.work_log, /scope=global/);
    assert.match(projectWorkLog.work_log, /Remain visible during resume\./);
    assert.equal(projectWorkLog.active_constraints[0].content, "Remain visible during resume.");

    const exactCoverageSession = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    await assert.rejects(
      rpc("clued_mcp_commit_checkpoint", {
        context_key: "global", session_token: exactCoverageSession.session_token, base_version: exactCoverageSession.version,
        snapshot: { stage: "K-CONT" }, summary: "Reject false cross-context coverage.",
        next_action: "Keep both contexts separate.", idempotency_key: uuid(),
        coverage: { mode: "explicit", contexts: ["global", projectContext], tracks: ["k-cont"], event_ids: [] },
      }),
      /checkpoint_context_not_covered/,
    );

    const audit = await rpc("clued_mcp_audit_receipts", { context_key: "global" });
    assert.equal(Array.isArray(audit.session_compliance), true);
    assert.equal(typeof audit.checkpoint_reminder, "boolean");
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("clued-k-cont-")) throw new Error("Unsafe test cleanup");
    await fs.rm(target, { recursive: true, force: true });
  }
});
