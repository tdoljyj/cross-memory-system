import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

// Incident 2026-10-03: an Owner decision written as a legacy decision Event
// shadowed every Global Decision and stopped project work with no stated reason.
test("Event carrier blocks: decision-class Events rejected, blocks named with resolutions", { timeout: 240000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-carrier-block-"));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: "postgres", password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ["-c", "io_method=sync"],
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
    const projectId = uuid();
    const projectScope = `project:${projectId}`;
    const projectOnlyToken = hash();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'carrier-block@example.invalid',now())", [userId]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,
      context_key,certainty_status,confirmed_at,lifecycle_status)
      values($1,$2,'M2 pilot','m2 pilot',$3,'confirmed',now(),'active')`, [projectId, userId, projectScope]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Carrier block agent',$2,array['context:read','context:write'],array['*']),
            ($1,'synthetic','Project-only agent',$3,array['context:read','context:write'],array[$4])`,
    [userId, tokenHash, projectOnlyToken, projectScope]);
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const rpc = async (name, input, token = tokenHash) =>
      (await gateway.query(`select public.${name}($1,$2) value`, [token, input])).rows[0].value;
    // Seeds an Event as written before the guard (the incident's Event 3951).
    const legacyAppend = async (input) => (await admin.query(
      "select clued_private.clued_mcp_append_event_unguarded($1,$2) value", [tokenHash, input])).rows[0].value;
    const user = server.getPgClient();
    clients.push(user);
    await user.connect();
    await user.query("set role authenticated");
    await user.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [userId, JSON.stringify({ sub: userId, role: "authenticated" })]);
    const createDecision = (title, extra = {}) => rpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", idempotency_key: uuid(),
      authority: "user_explicit", user_confirmed: true, confidence_reason: "Carrier block fixture",
      source_refs: [], source_unavailable_reason: null,
      ...extra,
      mutation: { title, content: title, type_fields: { rationale: "fixture" }, relations: {}, ...(extra.mutation ?? {}) },
    });
    const carrierOf = async (eventId) => (await admin.query(
      "select carrier_state,transition_version from clued_private.event_truth_carriers where event_id=$1",
      [eventId])).rows[0];

    const authority = await createDecision("M2 restricted entry authorization");
    assert.equal(authority.status, "committed", JSON.stringify(authority));
    const globalSession = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    assert.equal(globalSession.blocking_event_carriers, undefined, "an unblocked resume is unchanged");
    const unblocked = await rpc("clued_record_list", { level: "global", record_type: "decision" });
    assert.equal(unblocked.records.length, 1);
    assert.equal(unblocked.withheld_by_active_events, undefined, "an unblocked list is unchanged");

    // 1. The public adapter refuses decision-class Events before any write.
    const eventsBefore = Number((await admin.query("select count(*) from public.clued_context_events")).rows[0].count);
    for (const eventType of ["decision", "correction", "retraction"]) {
      await assert.rejects(rpc("clued_mcp_append_event", {
        context_key: "global", session_token: globalSession.session_token, base_version: globalSession.version,
        event_type: eventType, payload: { title: "先对账，优先级先不用管" }, idempotency_key: uuid(),
      }), (error) => error.message === "decision_event_requires_record" && error.code === "42501", eventType);
    }
    assert.equal(Number((await admin.query("select count(*) from public.clued_context_events")).rows[0].count),
      eventsBefore, "a rejected Event writes nothing");
    await assert.rejects(rpc("clued_mcp_append_event", {
      context_key: "global", session_token: globalSession.session_token, base_version: globalSession.version,
      event_type: "decision", payload: {}, idempotency_key: uuid(),
    }, hash()), (error) => error.message !== "decision_event_requires_record",
    "an unknown token fails authentication before the rule is disclosed");
    await assert.rejects(admin.query("select public.clued_mcp_append_event_unguarded($1,$2)", [tokenHash, {}]),
      /does not exist/, "the unguarded body is not public");
    await assert.rejects(gateway.query("select clued_private.clued_mcp_append_event_unguarded($1,$2)", [tokenHash, {}]),
      /permission denied/);
    const blocker = await rpc("clued_mcp_append_event", {
      context_key: projectScope, session_token: (await rpc("clued_mcp_restore", { context_key: projectScope })).session_token,
      base_version: (await rpc("clued_mcp_restore", { context_key: projectScope })).version,
      event_type: "note", payload: { text: "notes still append" }, idempotency_key: uuid(),
    });
    assert.equal(blocker.status, "appended", "non-decision Events keep working");

    // A pre-guard decision Event (Event 3951 in the incident).
    const seedKey = uuid();
    const seeded = await legacyAppend({
      context_key: "global", session_token: globalSession.session_token, base_version: globalSession.version,
      event_type: "decision", payload: { title: "Clued 核心卖点对账先行，暂不做优先级排序" }, idempotency_key: seedKey,
    });
    assert.equal(seeded.status, "appended");
    assert.deepEqual(await carrierOf(seeded.event_id), { carrier_state: "ACTIVE_UNSTRUCTURED", transition_version: "1" });
    const replay = await rpc("clued_mcp_append_event", {
      context_key: "global", session_token: globalSession.session_token, base_version: globalSession.version,
      event_type: "decision", payload: { title: "Clued 核心卖点对账先行，暂不做优先级排序" }, idempotency_key: seedKey,
    });
    assert.equal(replay.status, "duplicate", "a retry of a pre-guard Event keeps its outcome");
    assert.equal(String(replay.event_id), String(seeded.event_id));

    // 2. record_list names the carrier behind the withheld Decisions.
    const blocked = await rpc("clued_record_list", { level: "global", record_type: "decision" });
    assert.deepEqual(blocked.records, [], "the shadow rule itself is unchanged");
    const withheld = blocked.withheld_by_active_events;
    assert.ok(withheld, JSON.stringify(blocked));
    assert.equal(withheld.schema, "clued.blocking-event-carriers.v1");
    assert.deepEqual(withheld.scopes, ["global"]);
    assert.equal(withheld.withheld_record_count, 1);
    assert.equal(withheld.carrier_count, 1);
    assert.equal(withheld.carriers_truncated, false);
    const [carrier] = withheld.carriers;
    assert.equal(String(carrier.event_id), String(seeded.event_id));
    assert.equal(carrier.event_type, "decision");
    assert.equal(carrier.scope, "global");
    assert.equal(carrier.carrier_state, "ACTIVE_UNSTRUCTURED");
    assert.deepEqual(carrier.withholds, ["decision"]);
    assert.equal(String(carrier.event_version), String(seeded.version));
    assert.equal(Number(carrier.transition_version), 1);
    assert.equal(carrier.summary, "Clued 核心卖点对账先行，暂不做优先级排序");
    assert.deepEqual(carrier.resolutions.map((item) => item.action), ["materialize", "owner_continuity_resolution"]);
    const [materialize, resolve] = carrier.resolutions;
    assert.equal(materialize.tool, "clued_record_mutate");
    assert.deepEqual(materialize.arguments, {
      operation: "create", record_type: "decision", scope: "global", lifecycle_status: "active",
      mutation: { relations: { materializes_event: { id: seeded.event_id, version: seeded.version } } },
    });
    assert.equal(resolve.tool, "clued_event_carrier_transition");
    assert.deepEqual(resolve.arguments, {
      context_key: "global", source_event_id: seeded.event_id,
      expected_transition_version: 1, transition: "resolve",
    });
    const ownerView = (await user.query("select public.clued_user_record_list($1) value",
      [{ level: "global", record_type: "decision" }])).rows[0].value;
    assert.deepEqual(ownerView.withheld_by_active_events, withheld, "the owner list explains the same block");
    const states = await rpc("clued_record_list", { level: "global", record_type: "state" });
    assert.equal(states.withheld_by_active_events, undefined, "a decision carrier does not withhold State");
    const history = await rpc("clued_record_list", { level: "global", record_type: "decision", include_history: true });
    assert.equal(history.withheld_by_active_events, undefined, "history reads already show every row");

    // 3. M2 regression: a project session names the Global carrier.
    const projectResume = await rpc("clued_mcp_restore", { context_key: projectScope });
    assert.ok(Array.isArray(projectResume.blocking_event_carriers), JSON.stringify(projectResume));
    const globalBlock = projectResume.blocking_event_carriers.find((block) => block.scopes[0] === "global");
    assert.ok(globalBlock, JSON.stringify(projectResume.blocking_event_carriers));
    assert.equal(String(globalBlock.carriers[0].event_id), String(seeded.event_id));
    const globalResume = await rpc("clued_mcp_restore", { context_key: "global" });
    assert.equal(String(globalResume.blocking_event_carriers[0].carriers[0].event_id), String(seeded.event_id));
    const projectOnly = await rpc("clued_mcp_restore", { context_key: projectScope }, projectOnlyToken);
    assert.ok(projectOnly.session_token, JSON.stringify(projectOnly));
    assert.equal(projectOnly.blocking_event_carriers, undefined, "a Binding that cannot read Global sees no Global carrier");

    // 4. Following the returned materialize resolution clears the block.
    const materialized = await createDecision("Clued 核心卖点对账先行，暂不做优先级排序", {
      ...materialize.arguments,
      mutation: { ...materialize.arguments.mutation, title: "Clued 核心卖点对账先行，暂不做优先级排序",
        content: "Owner 原话：「先对账，优先级先不用管。」", type_fields: { rationale: "Materialize Event" } },
    });
    assert.equal(materialized.status, "committed", JSON.stringify(materialized));
    assert.equal((await carrierOf(seeded.event_id)).carrier_state, "MATERIALIZED_TO_RECORD");
    const cleared = await rpc("clued_record_list", { level: "global", record_type: "decision" });
    assert.equal(cleared.records.length, 2, "the withheld Decision returns unchanged");
    assert.ok(cleared.records.some((row) => row.id === authority.supplemental.record.id));
    assert.equal(cleared.withheld_by_active_events, undefined);
    assert.equal((await rpc("clued_mcp_restore", { context_key: projectScope })).blocking_event_carriers, undefined);

    // 5. Carrier transitions still append their successor through the guard.
    const second = await legacyAppend({
      context_key: "global", session_token: globalResume.session_token,
      base_version: (await rpc("clued_mcp_restore", { context_key: "global" })).version,
      event_type: "decision", payload: { title: "Second pre-guard decision" }, idempotency_key: uuid(),
    });
    assert.equal(second.status, "appended", JSON.stringify(second));
    const transitionSession = await rpc("clued_mcp_restore", { context_key: "global" });
    const superseded = await rpc("clued_mcp_event_carrier_transition", {
      context_key: "global", source_event_id: second.event_id, expected_transition_version: 1,
      transition: "supersede", event_type: "decision", payload: { title: "Successor decision" },
      session_token: transitionSession.session_token, base_version: transitionSession.version,
      idempotency_key: uuid(),
    });
    assert.equal(superseded.status, "transitioned", JSON.stringify(superseded));
    assert.equal((await carrierOf(second.event_id)).carrier_state, "SUPERSEDED");
    const successorBlock = (await rpc("clued_record_list", { level: "global", record_type: "decision" }))
      .withheld_by_active_events;
    assert.deepEqual(successorBlock.carriers.map((row) => String(row.event_id)), [String(superseded.successor_event_id)],
      "a supersede leaves an active successor, which the list names");
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
