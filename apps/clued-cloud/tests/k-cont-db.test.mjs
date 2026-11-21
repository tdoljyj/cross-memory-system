import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
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

// The sealed G6 closeout qualifies its original sources, before these two
// authorized successors. Keep its real replay and separately prove the current
// catalog rather than asking the historical seal to accept a changed body.
async function applyQualifiedMigrations(admin, names) {
  const targets = ['public.clued_project_mutate(text,jsonb)',
    'public.clued_development_owner_v14(jsonb)', 'public.clued_authorization_manage_v12(jsonb)'];
  const catalog = async () => (await admin.query(`select p.oid, p.oid::regprocedure::text signature,
    pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl::text acl
    from pg_proc p where p.oid=any($1::regprocedure[]) order by p.oid`, [targets])).rows;
  let originalTargets;
  const successors = new Map([
    ['20261014044323_all_contexts_authorization_v2.sql', 'b78cb49134f2788c3f1fbc7438c4647a8e89cdcedf3519d540305d1105b845b8'],
    ['20261014045157_all_contexts_serialization_v2.sql', 'ce8ee42d89240a338cbd229846c397f9626f1445e2dfa832b60c19fecb994e58'],
  ]);
  for (const name of names) {
    if (name === '20261014044323_all_contexts_authorization_v2.sql') {
      await assertGatewayCloseoutBoundary(admin);
      const closedCatalog = await snapshotCallerCatalog(admin);
      await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', CLOSEOUT_MIGRATION), 'utf8'));
      await assertGatewayCloseoutBoundary(admin);
      assert.deepEqual(await snapshotCallerCatalog(admin), closedCatalog,
        'actual sealed G6 replay preserves original definitions and ACL at its bounded stage');
      originalTargets = await catalog();
      assert.equal(originalTargets.length, targets.length);
    }
    const sql = await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
    if (successors.has(name)) assert.equal(crypto.createHash('sha256').update(sql).digest('hex'), successors.get(name));
    try { await admin.query(sql); }
    catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    if (name === '20261014044323_all_contexts_authorization_v2.sql') {
      assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, false);
    }
  }
  assert.ok(originalTargets, 'both successors run only after the bounded closeout proof');
  assert.deepEqual(await catalog(), originalTargets, 'successors preserve existing OIDs, owners, security metadata and ACL');
  await assertGatewayCloseoutBoundary(admin);
  assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  assert.equal((await admin.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') source_hash from pg_proc where oid='public.clued_project_mutate(text,jsonb)'::regprocedure")).rows[0].source_hash,
    '64503257b828c3dcf1405fc378a9d297faf559cec29a373e77e5013e2eb76262', 'retired alias keeps its sealed business body');
  for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
    assert.equal((await admin.query("select has_function_privilege($1,'public.clued_project_mutate(text,jsonb)','EXECUTE') allowed", [role])).rows[0].allowed,
      false, role + ' cannot execute the retired alias');
  }
  for (const signature of ['clued_private.authorization_writer_guard_v2(uuid)',
    'clued_private.authorization_writer_require_v2(uuid)', 'clued_private.authorization_sources_view_v2(uuid)']) {
    for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
      assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed,
        false, `${role} cannot directly call private successor helper ${signature}`);
    }
  }
}

const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString("hex");


async function guardedProjectInsert(admin, owner, sql, values) {
  await admin.query('begin');
  try {
    await admin.query('select clued_private.authorization_writer_guard_v2($1)', [owner]);
    assert.equal((await admin.query('select clued_private.authorization_writer_guard_held_v2($1) held', [owner])).rows[0].held,
      true, 'raw fixture setup holds the real granted Owner advisory transaction lock before INSERT');
    const result = await admin.query(sql, values);
    await admin.query('commit');
    return result;
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
}

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
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
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
    await applyQualifiedMigrations(admin, (await fs.readdir(path.join(root, "supabase/migrations")))
      .filter((name) => name.endsWith(".sql")).sort());
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);

    const userId = uuid();
    const tokenHash = hash();
    const projectContext = `project:${uuid()}`;
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'k-cont@example.invalid',now())", [userId]);
    await guardedProjectInsert(admin, userId, "insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'K-CONT project','k-cont project',$3,'confirmed',now())",
      [projectContext.slice(8), userId, projectContext]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','K-CONT database test',$2,array['context:read','context:write','audit:read'],array['global',$3])`,
      [userId, tokenHash, projectContext]);
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query("set role anon");
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const rpc = async (name, input) => await workerGatewayRpc(workerCaller,name,tokenHash,input);

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
    const constrained = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured", constraint_view: "full" });
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
      context_key: "global", response_view: "work_log", event_order: "oldest", event_cursor: Number(boundedFirst.event_id) - 1, event_limit: 1, event_budget_bytes: 4096,
    });
    assert.equal(typeof workLog.work_log, "string");
    assert.equal("events_after_checkpoint" in workLog, false);
    assert.equal(workLog.event_page.returned, 1);
    assert.equal(workLog.event_page.truncated, true);
    assert.match(workLog.work_log, /bounded-first/);
    assert.doesNotMatch(workLog.work_log, /bounded-second/);
    assert.match(workLog.work_log, /More pending events remain/);

    const projectWorkLog = await rpc("clued_mcp_restore", {
      context_key: projectContext, response_view: "work_log", event_limit: 1, event_budget_bytes: 4096, constraint_view: "full",
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
    // BUG-20260924-001 L1: zero writes proves only that nothing reached Clued.
    const states = audit.session_compliance.map((session) => session.state);
    assert.equal(states.includes("no_material_changes"), false);
    assert.equal(states.includes("capture_unknown"), true);
    assert.equal(states.includes("checkpointed"), true);
    for (const session of audit.session_compliance) {
      assert.equal(session.authority_capture,
        session.append_count > 0 && session.checkpoint_count === 0 ? "incomplete" : "unknown");
    }
    assert.equal(audit.session_compliance.some((session) =>
      session.state === "checkpoint_required_before_handoff" && session.authority_capture === "incomplete"), true);
    assert.deepEqual(audit.authority_capture_completeness, {
      state: "incomplete",
      basis: "server_observes_only_writes_that_reached_clued",
      independent_of: "currentness",
    });

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
    await guardedProjectInsert(admin, userId, "insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Other project','other project',$3,'confirmed',now())",
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
    const reducedRpc = async (name, input) => await workerGatewayRpc(workerCaller,name,reducedTokenHash,input);
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
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:global_target", include_history: true,
    });
    assert.deepEqual(hiddenSearch.results[0].target_refs, []);
    const historicalSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:historical_unknown_kind", include_history: true,
    });
    assert.deepEqual(historicalSearch.results[0].target_refs, []);
    const visibleSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:project_target", include_history: true,
    });
    assert.deepEqual(visibleSearch.results[0].target_refs.map((item) => item.id), [projectRecordId]);
    const hiddenEvidenceSearch = await reducedRpc("clued_mcp_search_context", {
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:false_linked_evidence", include_history: true,
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
      context_key: projectContext, session_token: reduced.session_token, query: "extension:kcont:linked_evidence", include_history: true,
    });
    assert.deepEqual(mergedEvidenceSearch.results[0].target_refs.map((item) => item.id), [projectRecordId]);
    const auditOnlyEventId = (await admin.query(
      "select id from public.clued_context_events where user_id=$1 and canonical_event_type='extension:kcont:audit_secret'",
      [userId],
    )).rows[0].id;
    const projectWorkEventId = (await admin.query(
      "select id from public.clued_context_events where user_id=$1 and canonical_event_type='extension:kcont:project_target'",
      [userId],
    )).rows[0].id;
    const noAuditTokenHash = hash();
    const noAuditBindingId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','K-CONT no-audit checkpoint reader',$2,array['context:read','context:write'],array[$3]) returning id`,
      [userId, noAuditTokenHash, projectContext])).rows[0].id;
    const noAuditRpc = async (name, input) => await workerGatewayRpc(workerCaller,name,noAuditTokenHash,input);
    const noAuditRestore = await noAuditRpc("clued_mcp_restore", { context_key: projectContext, response_view: "structured" });
    assert.equal(noAuditRestore.events_after_checkpoint.some((event) => Number(event.id) === Number(auditOnlyEventId)), false);
    const checkpointInput = (eventId, key) => ({
      context_key: projectContext, session_token: noAuditRestore.session_token,
      base_version: noAuditRestore.version, snapshot: { stage: "K-CONT" },
      summary: "Cover a readable work event.", next_action: "Continue from the checkpoint.",
      idempotency_key: key,
      coverage: { mode: "explicit", contexts: [projectContext], tracks: ["k-cont"], event_ids: [Number(eventId)] },
    });
    await assert.rejects(noAuditRpc("clued_mcp_commit_checkpoint", checkpointInput(auditOnlyEventId, uuid())),
      /checkpoint_event_not_authorized/);
    await assert.rejects(noAuditRpc("clued_mcp_commit_checkpoint", checkpointInput(Number.MAX_SAFE_INTEGER, uuid())),
      /checkpoint_event_not_authorized/);
    assert.equal((await admin.query("select count(*)::int as count from public.clued_checkpoint_event_absorptions where event_id=$1",
      [auditOnlyEventId])).rows[0].count, 0);
    assert.equal((await admin.query("select count(*)::int as count from public.clued_context_checkpoints where binding_id=$1",
      [noAuditBindingId])).rows[0].count, 0);
    const readableCheckpoint = await noAuditRpc("clued_mcp_commit_checkpoint", checkpointInput(projectWorkEventId, uuid()));
    assert.equal(readableCheckpoint.status, "committed");
    assert.equal((await admin.query("select count(*)::int as count from public.clued_checkpoint_event_absorptions where event_id=$1",
      [projectWorkEventId])).rows[0].count, 1);
    const visiblePendingCount = (await admin.query(`select count(*)::int as count from public.clued_context_events e
      where e.user_id=$1 and e.context_key=$2
        and (e.audit_visibility='work_log' or (e.event_schema_version is null and e.audit_visibility is null))
        and not exists(select 1 from public.clued_checkpoint_event_absorptions a
          where a.user_id=e.user_id and a.context_key=e.context_key and a.event_id=e.id)`,
      [userId, projectContext])).rows[0].count;
    assert.equal(Number(readableCheckpoint.pending_event_count_after), visiblePendingCount);

    // A full 100-event page resolves record_targets (including an upper-case
    // stored id) within the production anon statement_timeout. The primary-key
    // lookup itself is pinned by k-cont-contract; this fixture checks results.
    for (let index = 0; index < 300; index++) {
      const pageNote = await rpc("clued_record_mutate", {
        operation: "create", record_type: "note", record_schema_version: 1, lifecycle_status: "active", scope: "global",
        idempotency_key: uuid(), authority: "user_explicit", user_confirmed: true, confidence_reason: "K-CONT page cost fixture",
        source_refs: [], source_unavailable_reason: null,
        mutation: { title: `Page cost note ${index}`, content: "fixture", type_fields: { note_kind: "log" }, relations: {} },
      });
      assert.equal(pageNote.status, "committed", JSON.stringify(pageNote));
    }
    for (let index = 0; index < 100; index++) {
      assert.equal((await rpc("clued_event_append", {
        event_schema_version: 1, event_type: "extension:kcont:page_cost", event_scope: projectContext,
        target_refs: [{ kind: "record", id: projectRecordId }], audit_visibility: "work_log", idempotency_key: uuid(),
      })).status, "committed");
    }
    await admin.query(`update public.clued_context_events set target_refs=jsonb_build_array(jsonb_build_object('kind','record','id',upper($2::text)))
      where id=(select max(id) from public.clued_context_events where user_id=$1 and canonical_event_type='extension:kcont:page_cost')`,
      [userId, projectRecordId]);
    await workerCaller.query("set statement_timeout='3s'");
    const pageCursor = (await admin.query(`select min(id)-1 as id from public.clued_context_events
      where user_id=$1 and canonical_event_type='extension:kcont:page_cost'`, [userId])).rows[0].id;
    const fullPage = await reducedRpc("clued_mcp_restore", {
      context_key: projectContext, response_view: "structured", event_order: "oldest", event_cursor: Number(pageCursor), event_limit: 100,
      event_budget_bytes: 262144,
    });
    await workerCaller.query("reset statement_timeout");
    const pageCostEvents = fullPage.events_after_checkpoint.filter((item) => item.canonical_event_type === "extension:kcont:page_cost");
    assert.equal(pageCostEvents.length, 100);
    assert.ok(pageCostEvents.every((item) =>
      item.record_targets.length === 1 && item.record_targets[0].title === "Project constraint"));
    // Current-chain behavior above is qualified independently of the bounded
    // historical closeout replay performed before applying the successors.
    await assertGatewayCloseoutBoundary(admin);
    assert.equal((await admin.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready, true);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("clued-k-cont-")) throw new Error("Unsafe test cleanup");
    await removeTestDirectory(target);
  }
});
