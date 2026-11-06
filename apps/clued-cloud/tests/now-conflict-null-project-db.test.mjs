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

// BUG-20261002-001: the NOW_CONFLICT check of a project task must not resolve
// the effective project of Global tasks, whose project_id is null.

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

test("project now-task writes ignore Global now tasks and still detect real conflicts", { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-now-conflict-"));
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
    const token = hash();
    const projectId = uuid();
    const otherProjectId = uuid();
    const projectScope = `project:${projectId}`;
    const otherScope = `project:${otherProjectId}`;
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'now@example.invalid',now())`, [userId]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      certainty_status,confirmed_at,lifecycle_status)
      values($1,$3,'Now A','now a',$2,'confirmed',now(),'active'),($4,$3,'Now B','now b',$5,'confirmed',now(),'active')`,
    [projectId, projectScope, userId, otherProjectId, otherScope]);
    await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','All scopes',$2,array['context:read','context:write'],array['*'])`, [userId, token]);
    const gateway = server.getPgClient();
    clients.push(gateway);
    await gateway.connect();
    await setWorkerGatewayCaller(gateway);
    const rpc = async (input) =>
      (await gateway.query("select public.clued_record_mutate($1,$2) value", [token, input])).rows[0].value;
    const create = (scope, bucket) => rpc({
      operation: "create", record_type: "task", record_schema_version: 1, lifecycle_status: "active", scope,
      idempotency_key: uuid(), authority: "observed", confidence_reason: "now conflict fixture",
      source_refs: [], source_unavailable_reason: "fixture",
      mutation: { title: `${bucket} task`, content: "fixture", type_fields: { execution_bucket: bucket }, relations: {} },
    });
    const update = (scope, id, baseVersion, bucket) => rpc({
      operation: "update", record_type: "task", record_schema_version: 1, lifecycle_status: "active", scope, id,
      base_version: baseVersion, idempotency_key: uuid(), authority: "observed", confidence_reason: "now conflict fixture",
      mutation: { type_fields: { execution_bucket: bucket } },
    });
    const close = (scope, id, baseVersion) => rpc({
      operation: "close", record_type: "task", record_schema_version: 1, lifecycle_status: "completed", scope, id,
      base_version: baseVersion, idempotency_key: uuid(), authority: "observed", confidence_reason: "now conflict fixture",
      mutation: { closure_summary: "done" },
    });
    const committed = (result) => {
      assert.equal(result.status, "committed", JSON.stringify(result));
      return result.target_refs[0].id;
    };
    const nowConflict = (result) => {
      assert.equal(result.status, "rejected", JSON.stringify(result));
      assert.equal(result.error_code, "NOW_CONFLICT");
    };

    // An active Global now task used to make every project now-task write
    // fail with project_redirect_cycle.
    committed(await create("global", "now"));
    const projectNow = committed(await create(projectScope, "now"));
    committed(await create(otherScope, "now"));

    // Real conflicts are still detected, in a project and in Global.
    nowConflict(await create(projectScope, "now"));
    nowConflict(await create("global", "now"));
    const projectNext = committed(await create(projectScope, "next"));
    nowConflict(await update(projectScope, projectNext, 1, "now"));

    // The update branch skips the Global now task too.
    committed(await close(projectScope, projectNow, 1));
    committed(await update(projectScope, projectNext, 1, "now"));
    committed(await update(projectScope, projectNext, 2, "next"));
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
