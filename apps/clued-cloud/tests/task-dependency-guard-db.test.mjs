import { stopCluster } from './cluster-cleanup.mjs';
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
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

test("task depends_on accepts only readable tasks of the same user", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-task-dependency-"));
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
    // The complete migration chain must include the formal G6 closeout.
    await findGatewayCloseoutMigration(root);
    await assertGatewayCloseoutBoundary(admin);
    await allowRawTestBindings(admin);

    const userId = uuid();
    const otherUserId = uuid();
    const allToken = hash();
    const projectToken = hash();
    const otherToken = hash();
    const projectId = uuid();
    const projectScope = `project:${projectId}`;
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'dependency@example.invalid',now()),($2,'other@example.invalid',now())`, [userId, otherUserId]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      certainty_status,confirmed_at,lifecycle_status) values($1,$2,'Dependency','dependency',$3,'confirmed',now(),'active')`,
    [projectId, userId, projectScope]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','All scopes',$2,array['context:read','context:write'],array['*']),
            ($1,'synthetic','Project only',$3,array['context:read','context:write'],array[$5]),
            ($4,'synthetic','Other user',$6,array['context:read','context:write'],array['*'])`,
    [userId, allToken, projectToken, otherUserId, projectScope, otherToken]);
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const rpc = async (token, input) =>
      (await gateway.query("select public.clued_record_mutate($1,$2) value", [token, input])).rows[0].value;
    const create = (token, scope, recordType, typeFields, relations = {}) => rpc(token, {
      operation: "create", record_type: recordType, record_schema_version: 1, lifecycle_status: "active", scope,
      idempotency_key: uuid(), authority: "observed", confidence_reason: "dependency guard fixture",
      source_refs: [], source_unavailable_reason: "fixture",
      mutation: { title: `${recordType} fixture`, content: "fixture", type_fields: typeFields, relations },
    });
    const update = (token, scope, id, baseVersion, mutation, extra = {}) => rpc(token, {
      operation: "update", record_type: "task", record_schema_version: 1, lifecycle_status: "active", scope, id,
      base_version: baseVersion, idempotency_key: uuid(), authority: "observed",
      confidence_reason: "dependency guard fixture", mutation, ...extra,
    });
    const committed = (result) => {
      assert.equal(result.status, "committed", JSON.stringify(result));
      return result.target_refs[0].id;
    };
    const rejected = (result) => {
      assert.equal(result.status, "rejected", JSON.stringify(result));
      assert.equal(result.error_code, "invalid_dependency_target");
    };
    const task = { execution_bucket: "next" };

    const globalTask = committed(await create(allToken, "global", "task", task));
    const projectTask = committed(await create(allToken, projectScope, "task", task));
    const decision = committed(await create(allToken, "global", "decision", { rationale: "fixture" }));
    const otherUserTask = committed(await create(otherToken, "global", "task", task));

    // Targets the currentness vector cannot resolve to a readable task.
    for (const dependsOn of [[decision], [uuid()], [otherUserTask], ["not-a-uuid"], [42], { [globalTask]: true }]) {
      rejected(await create(allToken, "global", "task", task, { depends_on: dependsOn }));
    }
    // A binding cannot depend on a task in a scope it cannot read.
    rejected(await create(projectToken, projectScope, "task", task, { depends_on: [globalTask] }));

    // Same-scope and readable cross-scope task targets are accepted, in any case.
    const dependent = committed(await create(allToken, projectScope, "task", task,
      { depends_on: [globalTask.toUpperCase(), projectTask] }));
    committed(await create(projectToken, projectScope, "task", task, { depends_on: [projectTask] }));
    // Decisions keep their own relations and are not checked.
    committed(await create(allToken, "global", "decision", { rationale: "fixture" }, { depends_on: [decision] }));

    // Updates that change depends_on are checked, including a self-dependency.
    rejected(await update(allToken, projectScope, dependent, 1, { relations: { depends_on: [dependent] } }));
    rejected(await update(allToken, projectScope, dependent, 1, { relations: { depends_on: [decision] } }));
    committed(await update(allToken, projectScope, dependent, 1, { relations: { depends_on: [projectTask] } }));
    committed(await update(allToken, projectScope, dependent, 2, { relations: { depends_on: null } }));

    // A record that already holds a bad dependency can still be edited and
    // closed while the write leaves depends_on alone.
    const legacy = committed(await create(allToken, "global", "task", task));
    await admin.query(`update public.clued_memories set relations=jsonb_build_object('depends_on',jsonb_build_array($2::text))
      where id=$1`, [legacy, decision]);
    committed(await update(allToken, "global", legacy, 1, { content: "edited", relations: { related: [decision] } }));
    committed(await rpc(allToken, {
      operation: "close", record_type: "task", record_schema_version: 1, lifecycle_status: "completed", scope: "global",
      id: legacy, base_version: 2, idempotency_key: uuid(), authority: "observed", confidence_reason: "fixture",
      mutation: { closure_summary: "done" },
    }));
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
