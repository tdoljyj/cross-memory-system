import { stopCluster, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
import { setWorkerGatewayCaller, findGatewayCloseoutMigration, assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

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

test("T-CUR-35/67 successor: Event fence, materialization, hidden equivalence, and atomic recovery", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-currentness-"));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: "postgres", password: hash(), port: await freePort(),
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
    await admin.query(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, "supabase/migrations", name), "utf8")); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    // The complete migration chain must include the formal G6 closeout.
    await findGatewayCloseoutMigration(root);
    await assertGatewayCloseoutBoundary(admin);
    await allowRawTestBindings(admin);

    const userId = uuid();
    const tokenHash = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'currentness@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Currentness database test',$2,array['context:read','context:write','audit:read'],array['global'])`, [userId, tokenHash]);
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const rpc = async (name, input) => (await gateway.query(`select public.${name}($1,$2) value`, [tokenHash, input])).rows[0].value;
    const list = () => rpc("clued_record_list", { level: "global", record_type: "decision" });
    const user = server.getPgClient();
    clients.push(user);
    await user.connect();
    await user.query("set role authenticated");
    await user.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [userId, JSON.stringify({ sub: userId, role: "authenticated" })]);
    const userList = async () => (await user.query("select public.clued_user_record_list($1) value", [{ level: "global", record_type: "decision" }])).rows[0].value;

    const d1 = await rpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Currentness fixture",
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: "Old decision", content: "old decision marker", type_fields: { rationale: "fixture" }, relations: {} },
    });
    assert.equal(d1.status, "committed");
    const beforeBinding = await list();
    const beforeUser = await userList();
    assert.equal(beforeBinding.records.length, 1);
    assert.deepEqual(beforeBinding.records, beforeUser.records);
    assert.equal(beforeBinding.records[0].record_currentness, "CURRENT");

    const restored = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    const checkpoint = await rpc("clued_mcp_commit_checkpoint", {
      context_key: "global", session_token: restored.session_token,
      base_version: restored.version, snapshot: { decision: "Old decision" },
      summary: "Old decision checkpoint", next_action: "Use old decision",
      idempotency_key: uuid(),
      coverage: { mode: "explicit", contexts: ["global"], tracks: ["currentness"], event_ids: [] },
    });
    assert.equal(checkpoint.status, "committed");
    const appendSession = await rpc("clued_mcp_restore", {
      context_key: "global", response_view: "structured",
    });
    // Decision-class Events are rejected by the public adapter; seed a pre-guard row.
    const event = (await admin.query("select clued_private.clued_mcp_append_event_unguarded($1,$2) value", [tokenHash, {
      context_key: "global", session_token: appendSession.session_token, base_version: appendSession.version,
      event_type: "decision", payload: { marker: "new decision carrier" }, idempotency_key: uuid(),
    }])).rows[0].value;
    assert.equal(event.status, "appended");
    const carrier = (await admin.query("select carrier_state,visibility from clued_private.event_truth_carriers where event_id=$1", [event.event_id])).rows[0];
    assert.deepEqual(carrier, { carrier_state: "ACTIVE_UNSTRUCTURED", visibility: "work_log" });
    assert.deepEqual((await list()).records, []);
    assert.deepEqual((await userList()).records, []);
    const unstructuredSearch = await rpc("clued_mcp_search_context", {
      context_key: "global", session_token: appendSession.session_token,
      query: "new decision carrier",
    });
    assert.equal(unstructuredSearch.results[0].kind, "event");
    assert.equal(unstructuredSearch.results[0].structured_action_usable, false);
    // A routine Record edit can move updated_at past the Event. It must not
    // release the fence without the Event's materialization or transition CAS.
    const ordinaryEdit = await rpc("clued_record_mutate", {
      operation: "update", id: beforeBinding.records[0].id,
      record_type: "decision", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", base_version: 1,
      idempotency_key: uuid(), authority: "user_explicit", user_confirmed: true,
      confidence_reason: "Currentness fixture",
      mutation: { title: "Old decision edited", content: "old decision marker edited" },
    });
    assert.equal(ordinaryEdit.status, "committed");
    await admin.query(`update public.clued_memories set updated_at=(
      select occurred_at+interval '1 second' from public.clued_context_events where id=$2
    ) where id=$1`, [beforeBinding.records[0].id, event.event_id]);
    assert.deepEqual((await list()).records, [], "ordinary edit cannot release an active Event fence");
    assert.deepEqual((await userList()).records, []);
    const latestCarrier = (await admin.query(`select event_id from clued_private.event_truth_carriers
      where user_id=$1 and carrier_state='ACTIVE_UNSTRUCTURED' and visibility='work_log'
      order by event_id desc limit 1`, [userId])).rows[0].event_id;
    await admin.query(`update clued_private.event_truth_carriers
      set carrier_state='ACTIVE_TYPED' where event_id=$1`, [latestCarrier]);
    assert.deepEqual((await list()).records, [], "a typed active Event fences the same old Record");
    const afterAppendResume = await rpc("clued_mcp_restore", {
      context_key: "global", response_view: "structured",
    });
    assert.equal(afterAppendResume.currentness_evaluation.authoritative, false);
    assert.deepEqual(afterAppendResume.snapshot, {});
    assert.equal(afterAppendResume.next_action, "RECONCILIATION_REQUIRED");
    assert.equal(afterAppendResume.effective_next_action, null);
    const history = await rpc("clued_record_list", { level: "global", record_type: "decision", include_history: true });
    assert.equal(history.records.length, 1);
    assert.equal(history.records[0].record_currentness, "SHADOWED_BY_ACTIVE_EVENT");
    assert.equal(history.records[0].authoritative, false);
    const search = await rpc("clued_mcp_search_context", {
      context_key: "global", session_token: afterAppendResume.session_token, query: "new decision carrier",
    });
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].kind, "event");
    assert.equal(search.results[0].source_semantics, "canonical_material_event");

    const sourceId = beforeBinding.records[0].id;
    const supersede = await rpc("clued_decision_supersede", {
      idempotency_key: uuid(), source_decisions: [{ id: sourceId, base_version: 2 }],
      supersede_reason: "New event materialized to a successor", user_confirmed: true,
      replacement: {
        scope: "global", title: "Current decision", content: "current decision marker",
        record_schema_version: 1, type_fields: { rationale: "New carrier" },
        relations: { supersedes: [sourceId], materializes_event: { id: event.event_id, version: event.version } },
        authority: "user_explicit", source_refs: [], source_unavailable_reason: null,
        confidence_reason: "Currentness fixture",
      },
    });
    assert.equal(supersede.status, "committed");
    assert.equal((await admin.query("select carrier_state from clued_private.event_truth_carriers where event_id=$1", [event.event_id])).rows[0].carrier_state,
      "MATERIALIZED_TO_RECORD");
    const current = await list();
    assert.equal(current.records.length, 1);
    assert.equal(current.records[0].title, "Current decision");
    assert.equal(current.records[0].record_currentness, "CURRENT");
    assert.deepEqual(current.records, (await userList()).records);
    const postMaterialSearch = await rpc("clued_mcp_search_context", {
      context_key: "global", session_token: afterAppendResume.session_token, query: "new decision carrier",
    });
    // The materialized Event is gone; term matching may surface the successor Record itself.
    assert.deepEqual(postMaterialSearch.results.filter((row) => row.kind !== "record"), []);
    assert.deepEqual(postMaterialSearch.results.map((row) => [row.title, row.authoritative]), [["Current decision", true]]);

    // T-CUR-67 successor: a hidden carrier has no low-permission observable effect.
    const beforeHidden = await list();
    const beforeHiddenPage = await rpc("clued_record_list", {
      level: "global", record_type: "decision", limit: 1,
    });
    const beforeHiddenSearch = await rpc("clued_mcp_search_context", {
      context_key: "global", session_token: afterAppendResume.session_token,
      query: "decision", limit: 1,
    });
    const vectorSql = `select clued_private.currentness_vector(s.user_id,s.context_key,s.binding_id) vector
      from public.clued_continuity_sessions s
      where s.token_hash=encode(extensions.digest($1,'sha256'),'hex')`;
    const beforeHiddenVector = (await admin.query(vectorSql, [afterAppendResume.session_token])).rows[0].vector;
    await admin.query(`insert into public.clued_context_events
      (user_id,context_key,session_id,binding_id,version,event_type,payload,audit_visibility)
      select $1,'global',e.session_id,e.binding_id,e.version+1,'decision',
        '{"marker":"hidden decision"}'::jsonb,'audit_only'
      from public.clued_context_events e where e.id=$2`, [userId, event.event_id]);
    const afterHidden = await list();
    assert.deepEqual(afterHidden, beforeHidden);
    assert.deepEqual(await rpc("clued_record_list", {
      level: "global", record_type: "decision", limit: 1,
    }), beforeHiddenPage);
    assert.deepEqual((await userList()).records, beforeHidden.records);
    assert.deepEqual(await rpc("clued_mcp_search_context", {
      context_key: "global", session_token: afterAppendResume.session_token,
      query: "decision", limit: 1,
    }), beforeHiddenSearch);
    assert.deepEqual((await admin.query(vectorSql, [afterAppendResume.session_token])).rows[0].vector,
      beforeHiddenVector);
    const hiddenSearch = await rpc("clued_mcp_search_context", {
      context_key: "global", session_token: afterAppendResume.session_token, query: "hidden decision",
    });
    assert.deepEqual(hiddenSearch.results, []);

    const failedMaterialization = await rpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Currentness fixture",
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: "Invalid duplicate", content: "duplicate materialization", type_fields: { rationale: "fixture" },
        relations: { materializes_event: { id: event.event_id, version: event.version } } },
    });
    assert.equal(failedMaterialization.status, "rejected");
    assert.deepEqual((await list()).records, current.records);
    assert.equal((await admin.query("select carrier_state from clued_private.event_truth_carriers where event_id=$1", [event.event_id])).rows[0].carrier_state,
      "MATERIALIZED_TO_RECORD");
    await assert.rejects(admin.query(`update public.clued_memories
      set receipt_id=null,relations=jsonb_build_object('materializes_event',jsonb_build_object('id',$1::text,'version',$2::bigint))
      where id=$3`, [String(event.event_id), event.version, sourceId]), /materialization_receipt_required/);

    // A separate reader sees the complete pre-commit view until the Event and
    // its fence become visible together at commit.
    await admin.query("begin");
    try {
      await admin.query(`insert into public.clued_context_events
        (user_id,context_key,session_id,binding_id,version,event_type,payload,audit_visibility)
        select $1,'global',e.session_id,e.binding_id,e.version+2,'decision',
          '{"marker":"atomic decision"}'::jsonb,'work_log'
        from public.clued_context_events e where e.id=$2`, [userId, event.event_id]);
      assert.deepEqual((await list()).records, current.records);
      await admin.query("commit");
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
    assert.deepEqual((await list()).records, []);
    assert.deepEqual((await userList()).records, []);

    // T-CUR-59: an extension only enters current truth after a protected
    // consumer registers its impact, authorization scope, and read surface.
    const typedUser = uuid();
    const typedToken = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'typed-currentness@example.invalid',now())", [typedUser]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Typed currentness test',$2,array['context:read','context:write'],array['global'])`, [typedUser, typedToken]);
    const typedRpc = async (name, input) => (await gateway.query(`select public.${name}($1,$2) value`, [typedToken, input])).rows[0].value;
    assert.equal((await typedRpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Typed fixture",
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: "Typed baseline", content: "typed baseline", type_fields: { rationale: "fixture" }, relations: {} },
    })).status, "committed");
    const typedList = async () => (await typedRpc("clued_record_list", {
      level: "global", record_type: "decision",
    })).records;
    const appendTyped = async (marker, version) => (await admin.query(`insert into public.clued_context_events
      (user_id,context_key,event_scope,event_schema_version,version,event_type,payload,audit_visibility)
      values ($1,'global','global',1,$3,'extension:currentness:decision',$2,'work_log') returning id`,
      [typedUser, { marker }, version])).rows[0].id;
    const unregistered = await appendTyped("unregistered extension", 1);
    assert.equal((await admin.query("select count(*)::integer count from clued_private.event_truth_carriers where event_id=$1", [unregistered])).rows[0].count, 0);
    assert.equal((await typedList()).length, 1);
    await admin.query(`insert into clued_private.typed_event_currentness_registry
      (event_type,impact_dimensions,typed_consumer,registry_version)
      values ('extension:currentness:decision',array['decision'],'currentness-test',1)`);
    const registered = await appendTyped("registered extension", 2);
    assert.equal((await admin.query("select carrier_state,source_kind from clued_private.event_truth_carriers where event_id=$1", [registered])).rows[0].carrier_state,
      "ACTIVE_TYPED");
    assert.deepEqual(await typedList(), []);
    const typedSession = await typedRpc("clued_mcp_restore", {
      context_key: "global", response_view: "structured",
    });
    const typedSearch = await typedRpc("clued_mcp_search_context", {
      context_key: "global", session_token: typedSession.session_token,
      query: "registered extension",
    });
    assert.equal(typedSearch.results.length, 1);
    assert.equal(typedSearch.results[0].kind, "event");
    assert.equal(typedSearch.results[0].structured_action_usable, true);

    // A post-cutover direct Event written through an authorized legacy
    // project alias must fence the canonical project Record and remain a
    // current Event source on the canonical search path.
    const aliasUser = uuid();
    const aliasToken = hash();
    const projectId = uuid();
    const projectScope = `project:${projectId}`;
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'alias-currentness@example.invalid',now())", [aliasUser]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      certainty_status,confirmed_at) values($1,$2,'Alpha','alpha',$3,'confirmed',now())`,
      [projectId, aliasUser, projectScope]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Alias currentness test',$2,
        array['context:read','context:write'],array['project:alpha',$3])`,
      [aliasUser, aliasToken, projectScope]);
    const aliasRpc = async (name, input) => (await gateway.query(`select public.${name}($1,$2) value`,
      [aliasToken, input])).rows[0].value;
    const aliasRecord = await aliasRpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1,
      lifecycle_status: "active", scope: projectScope, idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Alias fixture",
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: "Project D1", content: "old project decision",
        type_fields: { rationale: "Alias fixture" }, relations: {} },
    });
    assert.equal(aliasRecord.status, "committed", JSON.stringify(aliasRecord));
    const projectList = () => aliasRpc("clued_record_list", {
      level: "project", project_id: projectId, record_type: "decision",
    });
    assert.equal((await projectList()).records.length, 1);
    const aliasSession = await aliasRpc("clued_mcp_restore", {
      context_key: "project:alpha", response_view: "structured",
    });
    const aliasEvent = (await admin.query("select clued_private.clued_mcp_append_event_unguarded($1,$2) value", [aliasToken, {
      context_key: "project:alpha", session_token: aliasSession.session_token,
      base_version: aliasSession.version, event_type: "decision",
      payload: { marker: "alias E2 current" }, idempotency_key: uuid(),
    }])).rows[0].value;
    assert.equal(aliasEvent.status, "appended");
    assert.equal((await admin.query(`select canonical_scope from clued_private.event_truth_carriers
      where event_id=$1`, [aliasEvent.event_id])).rows[0].canonical_scope, projectScope);
    assert.deepEqual((await projectList()).records, []);
    const canonicalSession = await aliasRpc("clued_mcp_restore", {
      context_key: projectScope, response_view: "structured",
    });
    const aliasSearch = await aliasRpc("clued_mcp_search_context", {
      context_key: projectScope, session_token: canonicalSession.session_token,
      query: "alias E2 current",
    });
    assert.equal(aliasSearch.results.length, 1);
    assert.equal(aliasSearch.results[0].kind, "event");
    await assert.rejects(admin.query(`insert into public.clued_context_events
      (user_id,context_key,session_id,binding_id,version,event_type,payload,audit_visibility)
      select $1,'project:missing',e.session_id,e.binding_id,e.version+1,'decision',
        '{"marker":"unresolved alias"}'::jsonb,'work_log'
      from public.clued_context_events e where e.id=$2`,
    [aliasUser, aliasEvent.event_id]), /material_event_project_scope_unresolved/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
