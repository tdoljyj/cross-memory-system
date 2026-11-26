import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { removeTestDirectory, startCluster, stopCluster } from './cluster-cleanup.mjs';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { assertGatewayCloseoutBoundary } from './worker-gateway-caller-fixture.mjs';

const uuid = () => crypto.randomUUID();
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const user = uuid();
const other = uuid();
const session = uuid();
const binding = uuid();
const token = digest(uuid());
const heartbeatToken = digest(uuid());
const migrations = new URL('../supabase/migrations/', import.meta.url);

const view = {
  contract: 'clued.merge-queue-node-view/1',
  node: { name: 'Synthetic node', mode: 'ACTIVE', source: digest('source'), generation: 1, consistent: true },
  executor: { state: 'running', reason: null, since: '2026-11-26T01:00:00Z' },
  halt: null,
  paused: false,
  intakePause: null,
  breaker: { state: 'closed', nextTrialAt: null },
  queueHold: null,
  current: null,
  pending: [{ pr: 1, headSha: 'a'.repeat(40), state: 'QUEUED', position: 1, deferred: null,
    since: '2026-11-26T01:00:00Z', nextAt: null, holdText: '等待执行' }],
  unqueued: [{ pr: 2, headSha: 'b'.repeat(40) }],
  train: { enabled: 'on', last: null },
  alerts: [],
  stall: null,
};

let directory;
let server;
const clients = [];
let admin;
let human;
let nodeId;
let ci;
const connect = async (role) => {
  const client = server.getPgClient();
  clients.push(client);
  await client.connect();
  if (role) await client.query(`set role ${role}`);
  return client;
};
const read = async (account = user, extra = {}) => {
  await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [account, JSON.stringify({ sub: account, role: 'authenticated', session_id: session, ...extra })]);
  return (await human.query("select public.clued_merge_queue_resident_v1('{}'::jsonb) v")).rows[0].v;
};
const command = async (input, token = heartbeatToken) => (await ci.query(
  'select public.clued_work_verify_v1($1,$2) v', [token, { scope: 'global', ...input }])).rows[0].v;
const report = (data = view, token) => command({ action: 'ci_queue_report', view: data }, token);
const beat = () => command({ action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'ACTIVE', probe: 'held',
  ci_source_manifest_sha256: digest('source'), service_running: true, snapshot_age_seconds: 5 });
const ok = (result) => {
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return result;
};
const heartbeatAge = (age) => admin.query(`update clued_private.ci_node_liveness_v1
  set last_heartbeat_at=clock_timestamp()-$2::interval,heartbeat_previous_at=null,steady_since=null
  where node_id=$1 returning last_heartbeat_at`, [nodeId, age]);

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-merge-queue-resident-'));
  server = newCluster({ databaseDir: directory, user: 'postgres', password: digest(uuid()), persistent: false,
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  await startCluster(server);
  admin = await connect();
  await admin.query(`create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls; create role authenticator nologin noinherit;
    create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
      banned_until timestamptz,deleted_at timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id),not_after timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as
      $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    grant usage on schema auth,extensions to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
  for (const name of (await fs.readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) {
    try { await admin.query(await fs.readFile(new URL(name, migrations), 'utf8')); }
    catch (error) { throw new Error(`迁移 ${name}：${error.message}`, { cause: error }); }
  }
  await allowRawTestBindings(admin);
  await assertGatewayCloseoutBoundary(admin);

  await admin.query(`insert into auth.users(id,email,email_confirmed_at)
    values($1,'resident-owner@example.invalid',now()),($2,'resident-other@example.invalid',now())`, [user, other]);
  const project = uuid();
  await admin.query('begin');
  await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,project_schema_version,project_recognized_v2)
    values($1,$2,'Resident queue fixture','resident queue fixture',$3,2,true)`, [project, user, `project:${project}`]);
  await admin.query(`insert into clued_private.project_lifecycle_v2_dispositions(project_id,user_id,disposition,disposition_reason,
    recognition_confidence,recognition_source,basis,disposition_hash)
    values($1,$2,'recognized_project','Synthetic database fixture',1,'v2_explicit_create','{}',$3)`, [project, user, digest('project')]);
  await admin.query('commit');
  await admin.query(`insert into public.clued_agent_bindings(id,user_id,vendor,agent_name,token_hash,scopes,context_keys)
    values($1,$2,'synthetic','resident CI connection',$3,array['context:read'],array['*'])`, [binding, user, token]);
  const jwk = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const { rows: [node] } = await admin.query(`insert into clued_private.ci_nodes_v1
    (user_id,project_id,binding_id,name,profile,profile_sha256,identity_public_jwk,encryption_public_jwk,
      identity_fingerprint,encryption_fingerprint,registration_digest,idempotency_key)
    values($1,$2,$3,$4,'{}'::jsonb,$5,$6,$7,$8,$9,$10,$11) returning node_id`,
  [user, project, binding, view.node.name, digest('profile'), jwk(), jwk(), digest('identity'), digest('encryption'),
    digest('registration'), uuid()]);
  nodeId = node.node_id;
  const { rows: [receipt] } = await admin.query(`insert into public.clued_audit_receipts
    (user_id,context_key,operation,object_type,object_id,version,metadata)
    values($1,'global','fixture','fixture','fixture',1,'{}') returning id`, [user]);
  await admin.query(`insert into clued_private.binding_roles_v1
    (user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
    values($1,$2,'ci-admission',now(),$3,now(),'resident-node')`, [user, binding, receipt.id]);
  const { id } = (await admin.query(`insert into public.clued_agent_bindings
    (user_id,vendor,agent_name,token_hash,scopes,context_keys)
    values($1,'Headless','queue view heartbeat',clued_private.ci_heartbeat_token_hash_v1($2),
      array['ci:heartbeat'],array['global']) returning id`, [user, heartbeatToken])).rows[0];
  await admin.query(`insert into clued_private.authorizations_v12
    (binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
    values($1,null,$2,'clued-headless','queue view heartbeat','clued:ci-heartbeat',now()+interval '30 days','headless')`, [id, user]);
  await admin.query(`insert into clued_private.ci_node_heartbeat_link_v1
    (user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id) values($1,$2,$3,now(),$4)`,
  [user, id, binding, receipt.id]);
  ci = await connect('anon');
  human = await connect('authenticated');
});

after(async () => {
  for (const client of clients.reverse()) await client.end().catch(() => {});
  if (server) await stopCluster(server);
  if (directory) await removeTestDirectory(directory);
});

test('心跳连接上报队列视图后，Owner 的页面 RPC 读到同一份', async (t) => {
  const result = await report();
  if (result.status !== 'ok') {
    const { length, md5 } = (await admin.query(`select length(body),md5(body) from
      (select pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure) body) d`)).rows[0];
    t.diagnostic(`命令门定义 length=${length} md5=${md5}`);
  }
  assert.equal(ok(result).changed, true);
  const { nodes } = ok(await read());
  assert.equal(nodes[0].name, view.node.name);
  assert.equal(nodes[0].holder, true);
  assert.equal(nodes[0].last_heartbeat_at, null);
  assert.equal(nodes[0].silent, false);
  assert.ok(nodes[0].view_reported_at);
  assert.deepEqual(nodes[0].view, view);
});

test('摘要相同只推进 reported_at，非当班节点的 CI 连接也可上报', async () => {
  ok(await report());
  const { rows: [previous] } = await admin.query(`update clued_private.ci_node_queue_view_v1
    set reported_at=reported_at-interval '1 minute', changed_at=changed_at-interval '1 minute'
    where node_id=$1 returning reported_at,changed_at,view_digest`, [nodeId]);
  const { rows: [role] } = await admin.query(`select effective_at::text from clued_private.binding_roles_v1
    where binding_id=$1 and role='ci-admission'`, [binding]);
  await admin.query(`update clued_private.binding_roles_v1 set effective_at=now()+interval '1 hour'
    where binding_id=$1 and role='ci-admission'`, [binding]);
  const sameView = Object.fromEntries(Object.entries(view).reverse());
  try {
    const result = ok(await report(sameView, token));
    assert.equal(result.changed, false);
    assert.equal(new Date(result.changed_at).getTime(), previous.changed_at.getTime());
    assert.ok(new Date(result.reported_at) > previous.reported_at);
    const { rows: [stored] } = await admin.query(`select changed_at,view_digest,view
      from clued_private.ci_node_queue_view_v1 where node_id=$1`, [nodeId]);
    assert.deepEqual(stored, { changed_at: previous.changed_at, view_digest: previous.view_digest, view });
  } finally {
    await admin.query(`update clued_private.binding_roles_v1 set effective_at=$2
      where binding_id=$1 and role='ci-admission'`, [binding, role.effective_at]);
  }
  const updated = { ...view, paused: true };
  const changed = ok(await report(updated));
  assert.equal(changed.changed, true);
  assert.equal(changed.changed_at, changed.reported_at);
  assert.deepEqual((await read()).nodes[0].view, updated);
});

test('坏视图被拒，心跳仍推进且旧视图完整保留', async () => {
  ok(await report());
  ok(await beat());
  const { rows: [oldHeartbeat] } = await heartbeatAge('1 minute');
  const oldView = (await read()).nodes[0];
  const wideText = '𠮷'.repeat(200);
  for (const invalid of [
    { ...view, pending: Array(30).fill({ ...view.pending[0], holdText: wideText }), alerts: Array(10).fill(wideText) },
    { ...view, contract: 'clued.merge-queue-node-view/2' },
    { ...view, node_id: uuid() },
    { ...view, node: { ...view.node, secret: 'unexpected' } },
    { ...view, pending: Array(31).fill(view.pending[0]) },
    { ...view, unqueued: [null] },
    { ...view, alerts: ['字'.repeat(201)] },
    { ...view, alerts: { text: '非数组' } },
  ]) {
    const result = await report(invalid);
    assert.deepEqual([result.status, result.error_code], ['rejected', 'ci_queue_report_invalid']);
  }
  const forbidden = await command({ action: 'ci_nodes_status' });
  assert.equal(forbidden.error_code, 'heartbeat_connection_only');
  const extraField = await command({ action: 'ci_queue_report', view, node_id: uuid() });
  assert.equal(extraField.error_code, 'ci_queue_report_invalid');
  ok(await beat());
  const [node] = (await read()).nodes;
  assert.ok(new Date(node.last_heartbeat_at) > oldHeartbeat.last_heartbeat_at);
  assert.equal(node.view_reported_at, oldView.view_reported_at);
  assert.deepEqual(node.view, view);
});

test('节点沉默由服务端使用现行规则判定，并保留心跳读数', async () => {
  ok(await beat());
  await heartbeatAge('6 minutes');
  const stale = ok(await read());
  assert.equal(stale.rules.silence_minutes, 5);
  assert.equal(stale.nodes[0].silent, true);
  await heartbeatAge('1 minute');
  const [live] = (await read()).nodes;
  assert.equal(live.silent, false);
  assert.equal(live.reported_state, 'NORMAL');
  assert.equal(live.reported_mode, 'ACTIVE');
  assert.equal(live.reported_snapshot_age_seconds, 5);
  assert.equal(live.reported_source_sha256, digest('source'));
});

test('只有 Owner 本人会话能读本账号节点，底表保持私有', async () => {
  await assert.rejects(() => read(user, { client_id: 'oauth-client' }), /direct_human_session_required/);
  assert.deepEqual(ok(await read(other)).nodes, []);
  const { rows } = await admin.query(`select r.role,
    has_function_privilege(r.role,'public.clued_merge_queue_resident_v1(jsonb)','execute') allowed,
    has_table_privilege(r.role,'clued_private.ci_node_queue_view_v1','select,insert,update,delete') table_access
    from unnest(array['anon','authenticated','service_role','clued_worker_gateway']) r(role)`);
  assert.deepEqual(rows.map((row) => [row.role, row.allowed, row.table_access]), [
    ['anon', false, false], ['authenticated', true, false], ['service_role', false, false], ['clued_worker_gateway', false, false],
  ]);
});
