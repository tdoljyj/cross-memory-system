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
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

test("a committed checkpoint renews the session without a second resume", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-session-renewal-"));
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
    for (const name of (await fs.readdir(path.join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
      await admin.query(await fs.readFile(path.join(root, "supabase/migrations", name), "utf8"));
    }
    await allowRawTestBindings(admin);

    const userId = uuid();
    const tokenHash = hash();
    const otherTokenHash = hash();
    const projectContext = `project:${uuid()}`;
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'renewal@example.invalid',now())", [userId]);
    await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Renewal project','renewal project',$3,'confirmed',now())",
      [projectContext.slice(8), userId, projectContext]);
    for (const [token, name] of [[tokenHash, "Renewal database test"], [otherTokenHash, "Second client"]]) {
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,array['context:read','context:write','audit:read'],array['global',$4])`,
        [userId, name, token, projectContext]);
    }
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query("set role anon");
    // Worker transport is distinct from anonymous CI doors and permission-denial probes.
    const workerCaller=server.getPgClient();clients.push(workerCaller);await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const call = async (token, name, input) =>
      await workerGatewayRpc(workerCaller,name,token,input);
    const rpc = (name, input) => call(tokenHash, name, input);
    const checkpoint = (session, base, eventIds, key = uuid()) => rpc("clued_mcp_commit_checkpoint", {
      context_key: "global", session_token: session, base_version: base,
      snapshot: { stage: "renewal" }, summary: "Renewal fixture checkpoint.", next_action: "Continue.",
      idempotency_key: key, coverage: { mode: "explicit", contexts: ["global"], tracks: ["renewal"], event_ids: eventIds },
    });
    const append = (session, base, marker, token = tokenHash) => call(token, "clued_mcp_append_event", {
      context_key: "global", session_token: session, base_version: base,
      event_type: "note", payload: { marker }, idempotency_key: uuid(),
    });

    // Global writes invalidate the Global projections; admission waits for the
    // refresh Worker, drained here the way currentness-admission-db does.
    const workerToken = hash();
    const workerId = (await admin.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'system','Projection refresh Worker',$2,array['context:read'],array['*']) returning id`,
    [userId, workerToken])).rows[0].id;
    await admin.query(`insert into clued_private.projection_builder_grants
      (binding_id,user_id,target_scope,projection_key,granted_by)
      values($1,$2,'global','global.priority_frontier','test-worker'),
            ($1,$2,'global','global.__aggregate__','test-worker')`, [workerId, userId]);
    const drainProjections = async () => {
      for (let round = 0; round < 6; round += 1) {
        // Only fixture scheduling is accelerated; real refresh/lease/CAS gates remain.
        await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at='-infinity'::timestamptz
          where user_id=$1 and status in ('queued','retry_wait')`, [userId]);
        const claim = await call(workerToken, "clued_mcp_projection_refresh_claim", {});
        if (claim.status === "superseded") continue;
        if (!claim.lease_id) {
          assert.equal(claim.status, "idle", JSON.stringify(claim));
          const pending = await admin.query(`
            select 'visible' as source,projection_key,invalidation_revision::text,resolved_through_revision::text
            from clued_private.visible_projection_invalidation_heads
            where user_id=$1 and target_scope='global' and invalidation_revision>resolved_through_revision
            union all
            select 'physical' as source,projection_key,invalidation_revision::text,resolved_through_revision::text
            from clued_private.projection_invalidation_heads
            where user_id=$1 and target_scope='global' and invalidation_revision>resolved_through_revision
            order by source,projection_key`, [userId]);
          assert.deepEqual(pending.rows, [], JSON.stringify({ claim, pending: pending.rows }));
          return;
        }
        const applied = await call(workerToken, "clued_mcp_projection_refresh_apply", {
          projection_key: claim.projection_key, lease_id: claim.lease_id,
          expected_invalidation_revision: claim.expected_invalidation_revision,
          expected_source_vector_digest: claim.expected_source_vector_digest,
        });
        assert.ok(["rebuilt", "reconciled"].includes(applied.status), JSON.stringify(applied));
      }
      throw new Error("projection refresh did not converge");
    };

    const constraint = await rpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1, lifecycle_status: "active", scope: "global",
      idempotency_key: uuid(), authority: "user_explicit", user_confirmed: true, confidence_reason: "renewal fixture",
      source_refs: [], source_unavailable_reason: null,
      mutation: { title: "Existing constraint", content: "Known at resume.", type_fields: { rationale: "fixture", constraint: true }, relations: {} },
    });
    assert.equal(constraint.status, "committed");
    const constraintId = constraint.target_refs[0].id;

    // While the vector is not admission-eligible, the renewal says so, as a
    // fresh resume would.
    const staleSession = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    assert.equal(staleSession.currentness_evaluation.reconciliation_required, true);
    const staleCheckpoint = await checkpoint(staleSession.session_token, staleSession.version, []);
    assert.equal(staleCheckpoint.currentness_admission_status, "CONTINUITY_COMMITTED_NOT_CURRENT");
    assert.equal(staleCheckpoint.session_renewal.reconciliation_required, true);
    await drainProjections();

    // First checkpoint of a resumed session renews it; the old token ends.
    const restored = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    assert.equal(restored.active_constraints.length, 1);
    const first = await append(restored.session_token, restored.version, "renewal-first");
    const committed = await checkpoint(restored.session_token, first.version, [Number(first.event_id)]);
    assert.equal(committed.status, "committed");
    const renewal = committed.session_renewal;
    assert.match(renewal.session_token, /^clued_ses_[0-9a-f]{64}$/);
    assert.notEqual(renewal.session_token, restored.session_token);
    assert.equal(renewal.version, committed.version);
    assert.equal(renewal.session_expires_in, 3600);
    assert.equal(renewal.reconciliation_required, false);
    assert.deepEqual(renewal.active_constraint_refs, [{ id: constraintId, version: 1 }]);
    assert.deepEqual(renewal.active_constraints_delivered, []);
    assert.deepEqual(renewal.new_unabsorbed_events, []);
    assert.equal(renewal.new_unabsorbed_event_count, 0);
    assert.equal(renewal.new_unabsorbed_events_truncated, false);
    await assert.rejects(append(restored.session_token, committed.version, "ended-token"), /resume_required/);

    // The renewed token writes and checkpoints again without a resume. An
    // uncovered event and another client's event are both reported.
    const second = await append(renewal.session_token, renewal.version, "renewal-second");
    const uncovered = await append(renewal.session_token, second.version, "renewal-uncovered");
    const otherSession = await call(otherTokenHash, "clued_mcp_restore", { context_key: "global", response_view: "structured" });
    const foreign = await append(otherSession.session_token, otherSession.version, "other-client", otherTokenHash);
    const again = await checkpoint(renewal.session_token, foreign.version, [Number(second.event_id)]);
    assert.equal(again.status, "committed");
    // Other clients' events come first.
    assert.deepEqual(again.session_renewal.new_unabsorbed_events.map((event) =>
      [Number(event.id), event.from_this_binding]),
    [[Number(foreign.event_id), false], [Number(uncovered.event_id), true]]);
    assert.equal(again.session_renewal.new_unabsorbed_event_count, 2);
    assert.equal(again.session_renewal.foreign_event_count, 1);
    assert.deepEqual(again.session_renewal.active_constraints_delivered, []);

    // A constraint changed after the session started arrives in full.
    const renewed = again.session_renewal;
    const updated = await rpc("clued_record_mutate", {
      operation: "update", id: constraintId, base_version: 1, record_type: "decision", record_schema_version: 1,
      lifecycle_status: "active", scope: "global", idempotency_key: uuid(), authority: "user_explicit",
      user_confirmed: true, confidence_reason: "renewal fixture", mutation: { content: "Changed during the session." },
    });
    assert.equal(updated.status, "committed");
    const blocked = await checkpoint(renewed.session_token, renewed.version, []);
    assert.equal(blocked.status, "conflict");
    assert.equal(blocked.error, "current_truth_changed_since_resume");
    assert.equal("session_renewal" in blocked, false);
    await drainProjections();
    const reconciled = await rpc("clued_mcp_session_reconcile", { context_key: "global", session_token: renewed.session_token });
    assert.equal(reconciled.admission_eligible, true, JSON.stringify(reconciled));
    const afterChange = await checkpoint(renewed.session_token, renewed.version, [], "renewal-replay-key");
    assert.equal(afterChange.status, "committed");
    assert.deepEqual(afterChange.session_renewal.active_constraint_refs, [{ id: constraintId, version: 2 }]);
    assert.equal(afterChange.session_renewal.active_constraints_delivered.length, 1);
    assert.equal(afterChange.session_renewal.constraint_view, "index");
    assert.equal(afterChange.session_renewal.active_constraints_delivered[0].summary, "Changed during the session.");
    assert.equal(afterChange.session_renewal.active_constraints_delivered[0].summary_is_full_text, true);
    assert.equal("content" in afterChange.session_renewal.active_constraints_delivered[0], false);
    // Events reported by the previous renewal are not reported again; only the
    // constraint update's own record Event is new.
    assert.equal(afterChange.session_renewal.foreign_event_count, 0);
    assert.ok(afterChange.session_renewal.new_unabsorbed_events.every((event) => event.from_this_binding));
    assert.ok(afterChange.session_renewal.new_unabsorbed_events.every((event) =>
      ![Number(uncovered.event_id), Number(foreign.event_id)].includes(Number(event.id))));

    // The committed checkpoint ended its token, so a replay is refused before
    // it can issue a second session; a replay under a live token of the same
    // Binding returns the original checkpoint and no renewal.
    await assert.rejects(checkpoint(renewed.session_token, renewed.version, [], "renewal-replay-key"),
      /resume_required/);
    const live = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    const duplicate = await checkpoint(live.session_token, renewed.version, [], "renewal-replay-key");
    assert.equal(duplicate.status, "duplicate");
    assert.equal("session_renewal" in duplicate, false);

    // A renewed token stays bound to its Binding and context.
    const latest = afterChange.session_renewal.session_token;
    await assert.rejects(call(otherTokenHash, "clued_mcp_append_event", {
      context_key: "global", session_token: latest, base_version: afterChange.version,
      event_type: "note", payload: { marker: "wrong-binding" }, idempotency_key: uuid(),
    }), /resume_required/);
    await assert.rejects(rpc("clued_mcp_append_event", {
      context_key: projectContext, session_token: latest, base_version: 0,
      event_type: "note", payload: { marker: "wrong-context" }, idempotency_key: uuid(),
    }), /resume_required/);

    const receipts = (await admin.query(`select metadata from public.clued_audit_receipts
      where user_id=$1 and operation='session_renew' order by created_at`, [userId])).rows;
    assert.equal(receipts.length, 4);
    assert.equal(receipts[3].metadata.constraints_delivered_count, 1);
    assert.ok(receipts.every((row) => row.metadata.predecessor_session_id && row.metadata.checkpoint_id));

    // A Binding without Global read renews a project session with only the
    // project's constraints, as its resume would return.
    const projectConstraint = await rpc("clued_record_mutate", {
      operation: "create", record_type: "decision", record_schema_version: 1, lifecycle_status: "active",
      scope: projectContext, idempotency_key: uuid(), authority: "user_explicit", user_confirmed: true,
      confidence_reason: "renewal fixture", source_refs: [], source_unavailable_reason: null,
      mutation: { title: "Project constraint", content: "Project only.", type_fields: { rationale: "fixture", constraint: true }, relations: {} },
    });
    assert.equal(projectConstraint.status, "committed");
    const projectToken = hash();
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Project-only client',$2,array['context:read','context:write'],array[$3])`,
    [userId, projectToken, projectContext]);
    const projectSession = await call(projectToken, "clued_mcp_restore", { context_key: projectContext, response_view: "structured" });
    assert.deepEqual(projectSession.active_constraints.map((item) => item.title), ["Project constraint"]);
    const projectCheckpoint = await call(projectToken, "clued_mcp_commit_checkpoint", {
      context_key: projectContext, session_token: projectSession.session_token, base_version: projectSession.version,
      snapshot: { stage: "renewal" }, summary: "Project renewal.", next_action: "Continue.", idempotency_key: uuid(),
      coverage: { mode: "explicit", contexts: [projectContext], tracks: ["renewal"], event_ids: [] },
    });
    assert.equal(projectCheckpoint.status, "committed");
    assert.deepEqual(projectCheckpoint.session_renewal.active_constraint_refs,
      [{ id: projectConstraint.target_refs[0].id, version: 1 }]);
    assert.deepEqual(projectCheckpoint.session_renewal.active_constraints_delivered, []);

    // More than 100 new events: counts and the truncation flag stay exact, and
    // another client's event is listed ahead of this Binding's own.
    const busy = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    let busyVersion = busy.version;
    for (let index = 0; index < 101; index += 1) {
      busyVersion = (await append(busy.session_token, busyVersion, `busy-${index}`)).version;
    }
    const busyOther = await call(otherTokenHash, "clued_mcp_restore", { context_key: "global", response_view: "structured" });
    const busyForeign = await append(busyOther.session_token, busyVersion, "busy-foreign", otherTokenHash);
    const busyCheckpoint = await checkpoint(busy.session_token, busyForeign.version, []);
    assert.equal(busyCheckpoint.status, "committed");
    assert.equal(busyCheckpoint.session_renewal.new_unabsorbed_events.length, 100);
    assert.equal(busyCheckpoint.session_renewal.new_unabsorbed_event_count, 102);
    assert.equal(busyCheckpoint.session_renewal.foreign_event_count, 1);
    assert.equal(busyCheckpoint.session_renewal.new_unabsorbed_events_truncated, true);
    assert.equal(Number(busyCheckpoint.session_renewal.new_unabsorbed_events[0].id), Number(busyForeign.event_id));

    // A constraint that becomes visible without changing (here: the Binding
    // gains Global read after its resume) arrives in full.
    const widened = await call(projectToken, "clued_mcp_restore", { context_key: projectContext, response_view: "structured" });
    await admin.query("update public.clued_agent_bindings set context_keys=array['global',$2] where token_hash=clued_private.credential_verifier_v1($1)",
      [projectToken, projectContext]);
    let widenedCheckpoint = await call(projectToken, "clued_mcp_commit_checkpoint", {
      context_key: projectContext, session_token: widened.session_token, base_version: widened.version,
      snapshot: { stage: "renewal" }, summary: "Widened renewal.", next_action: "Continue.", idempotency_key: uuid(),
      coverage: { mode: "explicit", contexts: [projectContext], tracks: ["renewal"], event_ids: [] },
    });
    if (widenedCheckpoint.status === "conflict") {
      await call(projectToken, "clued_mcp_session_reconcile", { context_key: projectContext, session_token: widened.session_token });
      widenedCheckpoint = await call(projectToken, "clued_mcp_commit_checkpoint", {
        context_key: projectContext, session_token: widened.session_token, base_version: widened.version,
        snapshot: { stage: "renewal" }, summary: "Widened renewal.", next_action: "Continue.", idempotency_key: uuid(),
        coverage: { mode: "explicit", contexts: [projectContext], tracks: ["renewal"], event_ids: [] },
      });
    }
    assert.equal(widenedCheckpoint.status, "committed", JSON.stringify(widenedCheckpoint));
    assert.deepEqual(widenedCheckpoint.session_renewal.active_constraints_delivered.map((item) => item.id), [constraintId]);
    assert.equal(widenedCheckpoint.session_renewal.active_constraint_refs.length, 2);

    // A session without a delivered set or constraint view (created before
    // those migrations) gets every constraint in full, and so does its chain.
    const legacy = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    await admin.query(`update public.clued_continuity_sessions set delivered_constraint_refs=null,constraint_view=null
      where token_hash=encode(extensions.digest($1,'sha256'),'hex')`, [legacy.session_token]);
    const legacyCheckpoint = await checkpoint(legacy.session_token, legacy.version, []);
    assert.equal(legacyCheckpoint.status, "committed");
    assert.deepEqual(legacyCheckpoint.session_renewal.active_constraints_delivered.map((item) => item.id),
      legacyCheckpoint.session_renewal.active_constraint_refs.map((item) => item.id));
    assert.ok(legacyCheckpoint.session_renewal.active_constraints_delivered.length >= 1);
    assert.equal(legacyCheckpoint.session_renewal.constraint_view, "full");
    assert.ok(legacyCheckpoint.session_renewal.active_constraints_delivered.every((item) => typeof item.content === "string"));

    // A chain resumed with constraint_view full keeps that view.
    const fullChain = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured", constraint_view: "full" });
    assert.equal(fullChain.constraint_view, "full");
    const fullCheckpoint = await checkpoint(fullChain.session_token, fullChain.version, []);
    assert.equal(fullCheckpoint.status, "committed");
    assert.equal(fullCheckpoint.session_renewal.constraint_view, "full");

    // A Binding that lost read admission still checkpoints but gets no renewal.
    const readable = await rpc("clued_mcp_restore", { context_key: "global", response_view: "structured" });
    await admin.query("update public.clued_agent_bindings set scopes=array['context:write','audit:read'] where token_hash=clued_private.credential_verifier_v1($1)", [tokenHash]);
    const writeOnly = await checkpoint(readable.session_token, readable.version, []);
    assert.equal(writeOnly.status, "committed");
    assert.equal(writeOnly.session_renewal, null);
    assert.equal(writeOnly.session_renewal_unavailable, "context_read_not_authorized");
    // The entire current chain was applied above; reapply the real closeout and compare catalog metadata.
    await assertGatewayCloseoutBoundary(admin);
    const closedCatalog=await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8'));
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual(await snapshotCallerCatalog(admin),closedCatalog,'actual G6 replay preserves definitions and ACL');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory).catch(() => {});
  }
});
