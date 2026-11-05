import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
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

// 2026-10-01: a project session checkpointed five times without context_key.
// The server looked the token up as a Global session and answered
// resume_required_or_session_expired, which no resume could cure.
test("checkpoint and reconcile take the context from the session token", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-session-context-"));
  const server = new EmbeddedPostgres({
    databaseDir: directory,
    user: "postgres",
    password: hash(),
    port: await freePort(),
    persistent: false,
    // track_functions lets the test count binding_read_scopes_v2 calls.
    postgresFlags: ["-c", "io_method=sync", "-c", "track_functions=all"],
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
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'context@example.invalid',now())", [userId]);
    await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Context project','context project',$3,'confirmed',now())",
      [projectContext.slice(8), userId, projectContext]);
    for (const [token, name] of [[tokenHash, "Session context test"], [otherTokenHash, "Second client"]]) {
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
    const restore = (contextKey, token = tokenHash) =>
      call(token, "clued_mcp_restore", { context_key: contextKey, response_view: "structured" });
    // contextKey undefined leaves context_key out of the request.
    const checkpoint = (session, base, contextKey, coverageContext, token = tokenHash) =>
      call(token, "clued_mcp_commit_checkpoint", {
        ...(contextKey === undefined ? {} : { context_key: contextKey }),
        session_token: session, base_version: base, snapshot: { stage: "context" },
        summary: "Session context fixture checkpoint.", next_action: "Continue.", idempotency_key: uuid(),
        coverage: { mode: "explicit", contexts: [coverageContext], tracks: ["context"], event_ids: [] },
      });
    const contextOf = async (receiptId) => (await admin.query(
      "select context_key from public.clued_audit_receipts where id=$1", [receiptId])).rows[0].context_key;

    // A project session reconciles and checkpoints without context_key.
    const project = await restore(projectContext);
    const reconciled = await rpc("clued_mcp_session_reconcile", { session_token: project.session_token });
    assert.equal(reconciled.admission_eligible, true, JSON.stringify(reconciled));
    assert.equal(await contextOf(reconciled.currentness_receipt_id), projectContext);
    const projectCommitted = await checkpoint(project.session_token, project.version, undefined, projectContext);
    assert.equal(projectCommitted.status, "committed", JSON.stringify(projectCommitted));
    assert.equal(projectCommitted.context_key, projectContext);
    assert.equal(projectCommitted.session_renewal.version, projectCommitted.version);

    // The renewed token keeps the project context too; an empty context_key
    // counts as omitted.
    const renewal = projectCommitted.session_renewal;
    const again = await checkpoint(renewal.session_token, renewal.version, "  ", projectContext);
    assert.equal(again.status, "committed", JSON.stringify(again));
    assert.equal(again.context_key, projectContext);

    // A context_key that is not the session's own is named as such, for both
    // entry points, instead of being reported as an expired session.
    const live = again.session_renewal;
    await assert.rejects(checkpoint(live.session_token, live.version, "global", "global"),
      /session_context_mismatch/);
    await assert.rejects(rpc("clued_mcp_session_reconcile", { context_key: "global", session_token: live.session_token }),
      /session_context_mismatch/);
    // The rejection consumed nothing: the session still checkpoints.
    const afterMismatch = await checkpoint(live.session_token, live.version, projectContext, projectContext);
    assert.equal(afterMismatch.status, "committed", JSON.stringify(afterMismatch));

    // Global sessions behave as before, with or without context_key.
    const global = await restore("global");
    const globalCommitted = await checkpoint(global.session_token, global.version, undefined, "global");
    assert.equal(globalCommitted.status, "committed", JSON.stringify(globalCommitted));
    assert.equal(globalCommitted.context_key, "global");
    await assert.rejects(checkpoint(globalCommitted.session_renewal.session_token, globalCommitted.session_renewal.version,
      projectContext, projectContext), /session_context_mismatch/);

    // An ended token keeps its own error whatever context_key says.
    await assert.rejects(checkpoint(project.session_token, project.version, undefined, projectContext),
      /resume_required_or_session_expired/);
    await assert.rejects(checkpoint(project.session_token, project.version, "global", "global"),
      /resume_required_or_session_expired/);

    // Keep the near-past boundary: exactly one second before the actual
    // Worker's fixed transaction clock, not an arbitrarily old expiry.
    const expiring = await restore(projectContext);
    let expiredRow;
    await workerCaller.query("begin isolation level read committed");
    try {
      const reference = (await workerCaller.query("select now()::text as reference_time")).rows[0].reference_time;
      const expired = await admin.query(`with target as materialized (
        select id,expires_at::text as previous_expires_at from public.clued_continuity_sessions
        where user_id=$3 and ended_at is null
          and token_hash=encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex') for update
      ) update public.clued_continuity_sessions s set expires_at=$2::timestamptz-interval '1 second'
        from target t where s.id=t.id
        returning s.id,t.previous_expires_at,s.expires_at<$2::timestamptz as expired,
          extract(epoch from ($2::timestamptz-s.expires_at))::text as past_seconds`,
      [expiring.session_token, reference, userId]);
      assert.equal(expired.rowCount, 1, "exactly the intended live synthetic session was expired");
      expiredRow = expired.rows[0];
      assert.equal(expiredRow.expired, true);
      assert.equal(Number(expiredRow.past_seconds), 1);
      // Preserve omitted-context coverage and independently test the real expiry
      // guard with the correct explicit context, so context mismatch cannot mask grace.
      for (const contextKey of [undefined, projectContext]) {
        await workerCaller.query("savepoint expired_session_probe");
        await assert.rejects(checkpoint(expiring.session_token, expiring.version, contextKey, projectContext),
          /resume_required_or_session_expired/);
        await workerCaller.query("rollback to savepoint expired_session_probe");
        await workerCaller.query("release savepoint expired_session_probe");
      }
    } finally {
      await workerCaller.query("rollback");
      if (expiredRow) {
        const restoredExpiry = await admin.query(`update public.clued_continuity_sessions set expires_at=$2::timestamptz
          where id=$1 returning id`, [expiredRow.id, expiredRow.previous_expires_at]);
        assert.equal(restoredExpiry.rowCount, 1, "restore the original synthetic expiry after the negative probes");
      }
    }

    // Another Binding's session token reveals nothing about its context.
    const foreign = await restore(projectContext, otherTokenHash);
    await assert.rejects(checkpoint(foreign.session_token, foreign.version, undefined, projectContext),
      /resume_required_or_session_expired/);
    await assert.rejects(checkpoint(foreign.session_token, foreign.version, "global", "global"),
      /resume_required_or_session_expired/);

    // A Binding no longer admitted to its session's context gets the
    // authorization error, not the mismatch.
    const narrowed = await restore(projectContext, otherTokenHash);
    await admin.query("update public.clued_agent_bindings set context_keys=array['global'] where token_hash=clued_private.credential_verifier_v1($1)", [otherTokenHash]);
    await assert.rejects(checkpoint(narrowed.session_token, narrowed.version, "global", "global", otherTokenHash),
      /binding_not_authorized/);
    await admin.query("update public.clued_agent_bindings set revoked_at=now() where token_hash=clued_private.credential_verifier_v1($1)", [otherTokenHash]);
    await assert.rejects(checkpoint(narrowed.session_token, narrowed.version, "global", "global", otherTokenHash),
      /binding_not_authorized/);

    // 2026-10-06: the current-view queries recomputed the Binding's read
    // scopes for every record, so a project of 632 records passed the anon
    // role's 3 s statement_timeout and its reconcile and checkpoint failed.
    // The scopes are now evaluated once per statement, whatever the count.
    const recordCount = 40;
    // Resume reads only Decisions, reconcile State/Task/Decision: half of each.
    for (let index = 0; index < recordCount; index += 1) {
      const [recordType, typeFields] = index % 2
        ? ["decision", { rationale: "Fixture" }]
        : ["task", { execution_bucket: "later" }];
      await admin.query(`insert into public.clued_memories(user_id,title,content,scope,project_id,record_type,status,
          record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
        values($1,$2,'Synthetic','project',$3,$4,'active',1,'active',$5,$6,'{}','{}','observed','Fixture')`,
        [userId, `Scope fixture ${index}`, projectContext.slice(8), recordType, projectContext, typeFields]);
    }
    const scopeCalls = async (work) => {
      await workerCaller.query("begin");
      try {
        const value = await work();
        const { rows } = await workerCaller.query(`select coalesce(sum(calls),0)::int calls from pg_stat_xact_user_functions
          where schemaname='clued_private' and funcname='binding_read_scopes_v2'`);
        return { value, calls: rows[0].calls };
      } finally {
        await workerCaller.query("rollback");
      }
    };
    const busy = await restore(projectContext);
    const measured = {
      resume: await scopeCalls(() => restore(projectContext)),
      reconcile: await scopeCalls(() => rpc("clued_mcp_session_reconcile", { session_token: busy.session_token })),
      checkpoint: await scopeCalls(() => checkpoint(busy.session_token, busy.version, undefined, projectContext)),
      log: await scopeCalls(() => rpc("clued_mcp_read_log", { context_key: projectContext, session_token: busy.session_token })),
    };
    assert.equal(measured.reconcile.value.admission_eligible, true, JSON.stringify(measured.reconcile.value));
    assert.equal(measured.checkpoint.value.status, "committed", JSON.stringify(measured.checkpoint.value));
    assert.equal(typeof measured.log.value.markdown, "string");
    const calls = Object.fromEntries(Object.entries(measured).map(([name, entry]) => [name, entry.calls]));
    for (const [name, count] of Object.entries(calls)) {
      assert.ok(count > 0 && count < 10, `${name} evaluated binding_read_scopes_v2 ${count} times for ${recordCount} records`);
    }

    // The predecessors are no longer callable directly.
    for (const name of ["clued_mcp_commit_checkpoint_explicit_context", "clued_mcp_session_reconcile_explicit_context"]) {
      await assert.rejects(anon.query(`select clued_private.${name}($1,$2)`, [tokenHash, {}]), /permission denied/);
    }
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
