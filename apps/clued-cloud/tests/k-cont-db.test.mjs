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
    await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'K-CONT project','k-cont project',$3,'confirmed',now())",
      [projectContext.slice(8), userId, projectContext]);
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
    await assert.rejects(
      rpc("clued_mcp_commit_checkpoint", {
        context_key: "global", session_token: restored.session_token, base_version: second.version,
        snapshot: { stage: "K-CONT" }, summary: "Reject an empty track.",
        next_action: "Keep both events pending.", idempotency_key: uuid(),
        coverage: { mode: "explicit", contexts: ["global"], tracks: [null], event_ids: [first.event_id] },
      }),
      /invalid_checkpoint_track/,
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

    const projectDecision = await rpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1, lifecycle_status: "active", scope: projectContext,
      idempotency_key: uuid(), authority: "user_explicit", user_confirmed: true, confidence_reason: "K-CONT project fixture",
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: "Project constraint", content: "Keep project scope visible.",
        type_fields: { rationale: "fixture", constraint: true }, relations: {} },
    });
    assert.equal(projectDecision.status, "committed");
    const globalRecordId = (await admin.query("select id from public.clued_memories where user_id=$1 and title='Resident constraint'", [userId])).rows[0].id;
    const projectRecordId = (await admin.query("select id from public.clued_memories where user_id=$1 and title='Project constraint'", [userId])).rows[0].id;
    const appendTarget = (targetId, name) => rpc("clued_event_append", {
      event_schema_version: 1, event_type: `extension:kcont:${name}`, event_scope: projectContext,
      target_refs: [{ kind: "record", id: targetId }], audit_visibility: "work_log", idempotency_key: uuid(),
    });
    assert.equal((await appendTarget(globalRecordId, "global_target")).status, "committed");
    assert.equal((await appendTarget(projectRecordId, "project_target")).status, "committed");
    const evidenceId = uuid();
    const standaloneEvidenceId = uuid();
    await admin.query(`insert into public.clued_evidence
      (id,user_id,evidence_schema_version,evidence_type,storage_ref,content_hash,receipt_id)
      values($1,$2,1,'test_output','k-cont-fixture',$3,$4)`, [evidenceId, userId, hash(), uuid()]);
    await admin.query(`insert into public.clued_evidence
      (id,user_id,evidence_schema_version,evidence_type,storage_ref,content_hash,receipt_id)
      values($1,$2,1,'test_output','k-cont-standalone-fixture',$3,$4)`, [standaloneEvidenceId, userId, hash(), uuid()]);
    const projectRecordVersion = (await admin.query("select version from public.clued_memories where id=$1", [projectRecordId])).rows[0].version;
    const linkedRecord = await rpc("clued_record_mutate", {
      operation: "update", id: projectRecordId, record_type: "decision", record_schema_version: 1,
      lifecycle_status: "active", scope: projectContext, base_version: projectRecordVersion,
      idempotency_key: uuid(), authority: "user_explicit", user_confirmed: true,
      confidence_reason: "K-CONT evidence link fixture", source_refs: [evidenceId], source_unavailable_reason: null,
      mutation: {},
    });
    assert.equal(linkedRecord.status, "committed");
    assert.equal((await rpc("clued_event_append", {
      event_schema_version: 1, event_type: "extension:kcont:linked_evidence", event_scope: projectContext,
      target_refs: [{ kind: "record", id: projectRecordId }, { kind: "evidence", id: evidenceId }],
      audit_visibility: "work_log", idempotency_key: uuid(),
    })).status, "committed");
    assert.equal((await rpc("clued_event_append", {
      event_schema_version: 1, event_type: "extension:kcont:false_linked_evidence", event_scope: projectContext,
      target_refs: [{ kind: "record", id: projectRecordId }, { kind: "evidence", id: standaloneEvidenceId }],
      audit_visibility: "work_log", idempotency_key: uuid(),
    })).status, "committed");
    assert.equal((await rpc("clued_event_append", {
      event_schema_version: 1, event_type: "extension:kcont:unscoped_evidence", event_scope: projectContext,
      target_refs: [{ kind: "evidence", id: evidenceId }], audit_visibility: "work_log", idempotency_key: uuid(),
    })).status, "committed");
    const unknownKind = await rpc("clued_event_append", {
      event_schema_version: 1, event_type: "extension:kcont:rejected_unknown_kind", event_scope: projectContext,
      target_refs: [{ kind: "unknown", id: globalRecordId }], audit_visibility: "work_log", idempotency_key: uuid(),
    });
    assert.equal(unknownKind.status, "rejected");
    assert.equal((await admin.query("select count(*)::int as count from public.clued_context_events where user_id=$1 and canonical_event_type='extension:kcont:rejected_unknown_kind'", [userId])).rows[0].count, 0);
    assert.equal((await appendTarget(globalRecordId, "historical_unknown_kind")).status, "committed");
    await admin.query(`update public.clued_context_events set target_refs=jsonb_build_array(jsonb_build_object('kind','unknown','id',$2::text))
      where user_id=$1 and canonical_event_type='extension:kcont:historical_unknown_kind'`, [userId, globalRecordId]);
    const otherProjectId = uuid();
    await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Other project','other project',$3,'confirmed',now())",
      [otherProjectId, userId, `project:${otherProjectId}`]);
    assert.equal((await rpc("clued_event_append", {
      event_schema_version: 1, event_type: "extension:kcont:other_project_target", event_scope: projectContext,
      target_refs: [{ kind: "project", id: otherProjectId }], audit_visibility: "work_log", idempotency_key: uuid(),
    })).status, "committed");
    const malformed = await rpc("clued_event_append", {
      event_schema_version: 1, event_type: "extension:kcont:invalid_target", event_scope: projectContext,
      target_refs: { kind: "record", id: globalRecordId }, audit_visibility: "work_log", idempotency_key: uuid(),
    });
    assert.equal(malformed.status, "rejected");
    assert.equal((await admin.query("select count(*)::int as count from public.clued_context_events where user_id=$1 and canonical_event_type='extension:kcont:invalid_target'", [userId])).rows[0].count, 0);
    assert.equal((await appendTarget("------------------------------------", "invalid_id")).status, "committed");
    // Simulate a malformed row written before the new append guard existed.
    await admin.query("update public.clued_context_events set target_refs='{}'::jsonb where user_id=$1 and canonical_event_type='extension:kcont:invalid_id'", [userId]);

    const auditOnly = await rpc("clued_event_append", {
      event_schema_version: 1, event_type: "extension:kcont:audit_secret", event_scope: projectContext,
      target_refs: [{ kind: "record", id: projectRecordId }], audit_visibility: "audit_only", idempotency_key: uuid(),
    });
    assert.equal(auditOnly.status, "committed");
    const reducedTokenHash = hash();
    const reducedBinding = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'OAuth','reduced project reader',$2,array['context:read'],array['global',$3]) returning id`,
      [userId, reducedTokenHash, projectContext])).rows[0].id;
    const issuerHash = hash();
    await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,'https://mcp.example.invalid/mcp','K-CONT issuer')", [issuerHash]);
    const requestId = (await admin.query(`insert into clued_private.authorization_requests_v12
      (owner_id,issuer_hash,request_digest,client_id,client_name,redirect_uri,resource,requested_scopes,eligible,status)
      values($1,$2,$3,'k-cont-client','K-CONT client','https://client.example.invalid/callback',
      'https://mcp.example.invalid/mcp',array['context:read'],'[]'::jsonb,'approved') returning id`,
      [userId, issuerHash, hash()])).rows[0].id;
    await admin.query(`insert into clued_private.authorizations_v12
      (binding_id,request_id,owner_id,client_id,client_name,resource,expires_at)
      values($1,$2,$3,'k-cont-client','K-CONT client','https://mcp.example.invalid/mcp',now()+interval '1 hour')`,
      [reducedBinding, requestId, userId]);
    await admin.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
      values($1,'scope',$2,'canonical',array['read'])`, [reducedBinding, projectContext]);
    const reducedRpc = async (name, input) => (await anon.query(`select public.${name}($1,$2) value`, [reducedTokenHash, input])).rows[0].value;
    const reduced = await reducedRpc("clued_mcp_restore", { context_key: projectContext, response_view: "structured" });
    const auditSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:audit_secret",
    });
    const auditWorkLog = await reducedRpc("clued_mcp_restore", { context_key: projectContext, response_view: "work_log" });
    const auditReadLog = await reducedRpc("clued_mcp_read_log", { context_key: projectContext, session_token: reduced.session_token });
    assert.deepEqual({
      search: auditSearch.results.some((item) => item.payload?.canonical_event_type === "extension:kcont:audit_secret"),
      structured: reduced.events_after_checkpoint.some((item) => item.canonical_event_type === "extension:kcont:audit_secret"),
      workLog: auditWorkLog.work_log.includes("extension:kcont:audit_secret"),
      readLog: auditReadLog.markdown.includes("extension:kcont:audit_secret"),
    }, { search: false, structured: false, workLog: false, readLog: false });
    assert.deepEqual(reduced.active_constraints.map((item) => item.title), ["Project constraint"]);
    assert.equal(reduced.authority_conflicts.some((item) => item.title === "Resident constraint"), false);
    const globalEvent = reduced.events_after_checkpoint.find((item) => item.canonical_event_type === "extension:kcont:global_target");
    const projectEvent = reduced.events_after_checkpoint.find((item) => item.canonical_event_type === "extension:kcont:project_target");
    const linkedEvidenceEvent = reduced.events_after_checkpoint.find((item) => item.canonical_event_type === "extension:kcont:linked_evidence");
    const falseLinkedEvidenceEvent = reduced.events_after_checkpoint.find((item) => item.canonical_event_type === "extension:kcont:false_linked_evidence");
    const unscopedEvidenceEvent = reduced.events_after_checkpoint.find((item) => item.canonical_event_type === "extension:kcont:unscoped_evidence");
    const historicalUnknownEvent = reduced.events_after_checkpoint.find((item) => item.canonical_event_type === "extension:kcont:historical_unknown_kind");
    const otherProjectEvent = reduced.events_after_checkpoint.find((item) => item.canonical_event_type === "extension:kcont:other_project_target");
    const historicalMalformedEvent = reduced.events_after_checkpoint.find((item) => item.canonical_event_type === "extension:kcont:invalid_id");
    assert.deepEqual(globalEvent.target_refs, []);
    assert.deepEqual(globalEvent.record_targets, []);
    assert.deepEqual(projectEvent.target_refs.map((item) => item.id), [projectRecordId]);
    assert.deepEqual(projectEvent.record_targets.map((item) => item.title), ["Project constraint"]);
    assert.deepEqual(linkedEvidenceEvent.target_refs.map((item) => item.id), [projectRecordId, evidenceId]);
    assert.deepEqual(falseLinkedEvidenceEvent.target_refs.map((item) => item.id), [projectRecordId]);
    assert.deepEqual(unscopedEvidenceEvent.target_refs, []);
    assert.deepEqual(historicalUnknownEvent.target_refs, []);
    assert.deepEqual(otherProjectEvent.target_refs, []);
    assert.deepEqual(historicalMalformedEvent.record_targets, []);
    const hiddenSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:global_target",
    });
    assert.deepEqual(hiddenSearch.results[0].target_refs, []);
    const historicalSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:historical_unknown_kind",
    });
    assert.deepEqual(historicalSearch.results[0].target_refs, []);
    const visibleSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:project_target",
    });
    assert.deepEqual(visibleSearch.results[0].target_refs.map((item) => item.id), [projectRecordId]);
    const hiddenEvidenceSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:false_linked_evidence",
    });
    assert.deepEqual(hiddenEvidenceSearch.results[0].target_refs.map((item) => item.id), [projectRecordId]);
    const reducedLog = await reducedRpc("clued_mcp_restore", { context_key: projectContext, response_view: "work_log" });
    assert.doesNotMatch(reducedLog.work_log, /Remain visible during resume\./);
    assert.doesNotMatch(reducedLog.work_log, new RegExp(globalRecordId));
    assert.doesNotMatch(reducedLog.work_log, new RegExp(otherProjectId));
    assert.doesNotMatch(reducedLog.work_log, new RegExp(standaloneEvidenceId));
    assert.match(reducedLog.work_log, /Keep project scope visible\./);
    const readLog = await reducedRpc("clued_mcp_read_log", { context_key: projectContext, session_token: reduced.session_token });
    assert.doesNotMatch(readLog.markdown, new RegExp(globalRecordId));
    assert.doesNotMatch(readLog.markdown, new RegExp(otherProjectId));
    assert.doesNotMatch(readLog.markdown, new RegExp(standaloneEvidenceId));
    assert.match(readLog.markdown, new RegExp(projectRecordId));
    // A merged redirect stops granting Evidence visibility even if its old
    // source_refs remain for audit history.
    await admin.query("update public.clued_memories set lifecycle_status='merged' where id=$1", [projectRecordId]);
    const mergedEvidenceSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:linked_evidence",
    });
    assert.deepEqual(mergedEvidenceSearch.results[0].target_refs.map((item) => item.id), [projectRecordId]);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("clued-k-cont-")) throw new Error("Unsafe test cleanup");
    await fs.rm(target, { recursive: true, force: true });
  }
});
