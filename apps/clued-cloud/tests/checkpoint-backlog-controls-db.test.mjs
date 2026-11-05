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

test("resume pages newest first and a checkpoint can absorb all of its Binding's events", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-checkpoint-backlog-"));
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
    await allowRawTestBindings(admin);

    const userId = uuid();
    const tokenHash = hash();
    const otherTokenHash = hash();
    const projectContext = `project:${uuid()}`;
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'backlog@example.invalid',now())", [userId]);
    await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Backlog project','backlog project',$3,'confirmed',now())",
      [projectContext.slice(8), userId, projectContext]);
    for (const [token, name] of [[tokenHash, "Backlog database test"], [otherTokenHash, "Second client"]]) {
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
    const checkpoint = (session, base, eventIds, extra = {}, key = uuid(), token = tokenHash) => call(token, "clued_mcp_commit_checkpoint", {
      context_key: "global", session_token: session, base_version: base,
      snapshot: { stage: "backlog" }, summary: "Backlog fixture checkpoint.", next_action: "Continue.",
      idempotency_key: key, coverage: { mode: "explicit", contexts: ["global"], tracks: ["backlog"], event_ids: eventIds, ...extra },
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
        await admin.query(`update clued_private.projection_refresh_jobs set next_attempt_at=now()
          where user_id=$1 and status in ('queued','failed')`, [userId]);
        const claim = await call(workerToken, "clued_mcp_projection_refresh_claim", {});
        if (!claim.lease_id) return;
        const applied = await call(workerToken, "clued_mcp_projection_refresh_apply", {
          projection_key: claim.projection_key, lease_id: claim.lease_id,
          expected_invalidation_revision: claim.expected_invalidation_revision,
          expected_source_vector_digest: claim.expected_source_vector_digest,
        });
        assert.ok(["rebuilt", "reconciled"].includes(applied.status), JSON.stringify(applied));
      }
      throw new Error("projection refresh did not converge");
    };

    await drainProjections();
    const ids = (events) => events.map((event) => Number(event.id));
    const resume = (input = {}, token = tokenHash) =>
      call(token, "clued_mcp_restore", { context_key: "global", response_view: "structured", ...input });

    // Three events from this Binding and one from another Binding.
    const opened = await resume();
    const e1 = await append(opened.session_token, opened.version, "backlog-1");
    const e2 = await append(opened.session_token, e1.version, "backlog-2");
    const e3 = await append(opened.session_token, e2.version, "backlog-3");
    const other = await resume({}, otherTokenHash);
    const eb = await append(other.session_token, other.version, "other-binding", otherTokenHash);
    const all = [e1, e2, e3, eb].map((event) => Number(event.event_id));

    // Newest first by default; event_cursor pages to older events.
    const newest = await resume({ event_limit: 2 });
    assert.equal(newest.event_page.order, "newest");
    assert.deepEqual(ids(newest.events_after_checkpoint), [all[3], all[2]]);
    assert.equal(newest.event_page.next_cursor, all[2]);
    assert.equal(newest.event_page.truncated, true);
    const older = await resume({ event_limit: 2, event_cursor: newest.event_page.next_cursor });
    assert.deepEqual(ids(older.events_after_checkpoint), [all[1], all[0]]);
    assert.equal(older.event_page.truncated, false);
    assert.equal(older.event_page.next_cursor, null);
    // The previous order stays available.
    const oldest = await resume({ event_limit: 2, event_order: "oldest" });
    assert.equal(oldest.event_page.order, "oldest");
    assert.deepEqual(ids(oldest.events_after_checkpoint), [all[0], all[1]]);
    assert.equal(oldest.event_page.next_cursor, all[1]);
    const work = await resume({ response_view: "work_log", event_limit: 1 });
    assert.match(work.work_log, /other-binding|backlog/);
    await assert.rejects(resume({ event_order: "random" }), /invalid_event_order/);

    // checkpoint_recommended counts only the last 24 hours.
    let session = await resume();
    let version = session.version;
    const bulk = [];
    for (let index = 0; index < 20; index += 1) {
      const appended = await append(session.session_token, version, `bulk-${index}`);
      version = appended.version;
      bulk.push(Number(appended.event_id));
    }
    const busy = await resume();
    assert.equal(busy.pending_event_count, 24);
    assert.equal(busy.pending_event_count_recent, 24);
    assert.equal(busy.checkpoint_recommended, true);
    assert.equal(busy.checkpoint_recommendation_reason, "recent_pending_event_threshold_reached");
    await admin.query(`update public.clued_context_events set occurred_at=now()-interval '2 days' where id=any($1::bigint[])`, [bulk]);
    const aged = await resume();
    assert.equal(aged.pending_event_count, 24);
    assert.equal(aged.pending_event_count_recent, 4);
    assert.equal(aged.checkpoint_recommended, false);
    assert.equal(aged.checkpoint_recommendation_reason, null);

    // binding_events "all" absorbs every pending event this Binding wrote,
    // listed or not, and leaves the other Binding's event pending.
    session = await resume();
    await assert.rejects(checkpoint(session.session_token, session.version, [], { binding_events: "some" }),
      /invalid_checkpoint_binding_events/);
    const swept = await checkpoint(session.session_token, session.version, [all[0]], { binding_events: "all" });
    assert.equal(swept.status, "committed", JSON.stringify(swept));
    assert.equal(swept.absorbed_event_count, 23);
    assert.equal(swept.binding_event_count, 22);
    assert.deepEqual(swept.already_absorbed_event_ids, []);
    assert.equal(swept.pending_event_count_after, 1);
    const afterSweep = await resume();
    assert.deepEqual(ids(afterSweep.events_after_checkpoint), [all[3]]);

    // A sibling session of the same Binding that lists an absorbed event is
    // told so and still commits.
    const sibling = await resume();
    const late = await checkpoint(sibling.session_token, sibling.version, [all[1]]);
    assert.equal(late.status, "committed", JSON.stringify(late));
    assert.deepEqual(late.already_absorbed_event_ids, [all[1]]);
    assert.equal(late.absorbed_event_count, 0);
    assert.equal(late.pending_event_count_after, 1);

    // The other Binding sweeps its own event.
    const otherSession = await resume({}, otherTokenHash);
    const otherSweep = await checkpoint(otherSession.session_token, otherSession.version, [], { binding_events: "all" },
      uuid(), otherTokenHash);
    assert.equal(otherSweep.status, "committed", JSON.stringify(otherSweep));
    assert.equal(otherSweep.absorbed_event_count, 1);
    assert.equal(otherSweep.pending_event_count_after, 0);
    // The entire current chain was applied above; reapply the real closeout and compare catalog metadata.
    await assertGatewayCloseoutBoundary(admin);
    const closedCatalog=await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root,'supabase/migrations',CLOSEOUT_MIGRATION),'utf8'));
    await assertGatewayCloseoutBoundary(admin);
    assert.deepEqual(await snapshotCallerCatalog(admin),closedCatalog,'actual G6 replay preserves definitions and ACL');
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
  }
});
