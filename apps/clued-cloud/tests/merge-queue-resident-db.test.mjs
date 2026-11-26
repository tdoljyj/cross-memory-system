import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { digest, schedulingFixture, uuid } from './ci-scheduling-stage1-fixture.mjs';

const view = {
  schema: 'clued.merge-queue-node-view/1',
  node: { name: 'Synthetic node', mode: 'ACTIVE', source: digest('source'), generation: 1, consistent: true },
  executor: { state: 'running', reason: null, since: '2026-11-26T01:00:00Z' },
  halt: null,
  paused: false,
  intakePause: null,
  breaker: { state: 'closed', nextTrialAt: null },
  queueHold: false,
  current: null,
  pending: [{ pr: 1, headSha: 'a'.repeat(40), state: 'QUEUED', position: 1, deferred: false,
    since: '2026-11-26T01:00:00Z', nextAt: null, holdText: '等待执行' }],
  unqueued: [{ pr: 2, headSha: 'b'.repeat(40) }],
  train: { enabled: 'on', last: null },
  alerts: [],
  stall: null,
};

let fixture;
let nodeId;
let ci;
let heartbeatToken;
const read = (claims) => fixture.native('clued_merge_queue_resident_v1', {}, claims);
const command = async (input, token = heartbeatToken) => (await ci.query(
  'select public.clued_work_verify_v1($1,$2) v', [token, { scope: 'global', ...input }])).rows[0].v;
const report = (data = view, token) => command({ action: 'ci_queue_report', view: data }, token);
const beat = () => command({ action: 'ci_node_heartbeat', state: 'NORMAL', mode: 'ACTIVE', probe: 'held',
  ci_source_manifest_sha256: digest('source'), service_running: true, snapshot_age_seconds: 5 });
const ok = (result) => {
  assert.equal(result.status, 'ok', JSON.stringify(result));
  return result;
};
const heartbeatAge = (age) => fixture.admin.query(`update clued_private.ci_node_liveness_v1
  set last_heartbeat_at=clock_timestamp()-$2::interval where node_id=$1 returning last_heartbeat_at`, [nodeId, age]);

before(async () => {
  fixture = await schedulingFixture();
  const { admin, user, binding } = fixture;
  nodeId = (await fixture.register()).node_id;
  ci = await fixture.connect('anon');
  heartbeatToken = digest(uuid());
  const { id } = (await admin.query(`insert into public.clued_agent_bindings
    (user_id,vendor,agent_name,token_hash,scopes,context_keys)
    values($1,'Headless','queue view heartbeat',clued_private.ci_heartbeat_token_hash_v1($2),
      array['ci:heartbeat'],array['global']) returning id`, [user, heartbeatToken])).rows[0];
  await admin.query(`insert into clued_private.authorizations_v12
    (binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
    values($1,null,$2,'clued-headless','queue view heartbeat','clued:ci-heartbeat',now()+interval '30 days','headless')`, [id, user]);
  await admin.query(`insert into clued_private.ci_node_heartbeat_link_v1
    (user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id) values($1,$2,$3,now(),$4)`,
  [user, id, binding, uuid()]);
});

after(async () => { await fixture?.close(); });

test('心跳连接上报队列视图后，Owner 的页面 RPC 读到同一份', async (t) => {
  const result = await report();
  if (result.status !== 'ok') {
    const { length, md5 } = (await fixture.admin.query(`select length(body),md5(body) from
      (select pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure) body) d`)).rows[0];
    t.diagnostic(`命令门定义 length=${length} md5=${md5}`);
  }
  assert.equal(ok(result).changed, true);
  const { nodes } = ok(await read());
  assert.equal(nodes[0].name, view.node.name);
  assert.equal(nodes[0].holder, true);
  assert.ok(nodes[0].view_reported_at);
  assert.deepEqual(nodes[0].view, view);
});

test('摘要相同只推进 reported_at，非当班节点的 CI 连接也可上报', async () => {
  ok(await report());
  const { rows: [previous] } = await fixture.admin.query(`update clued_private.ci_node_queue_view_v1
    set reported_at=reported_at-interval '1 minute', changed_at=changed_at-interval '1 minute'
    where node_id=$1 returning reported_at,changed_at,view_digest`, [nodeId]);
  const { rows: [role] } = await fixture.admin.query(`update clued_private.binding_roles_v1
    set effective_at=now()+interval '1 hour' where binding_id=$1 and role='ci-admission'
    returning effective_at-interval '1 hour' as restore_at`, [fixture.binding]);
  const sameView = Object.fromEntries(Object.entries(view).reverse());
  try {
    const result = ok(await report(sameView, fixture.token));
    assert.equal(result.changed, false);
    assert.equal(new Date(result.changed_at).getTime(), previous.changed_at.getTime());
    assert.ok(new Date(result.reported_at) > previous.reported_at);
    const { rows: [stored] } = await fixture.admin.query(`select changed_at,view_digest,view
      from clued_private.ci_node_queue_view_v1 where node_id=$1`, [nodeId]);
    assert.deepEqual(stored, { changed_at: previous.changed_at, view_digest: previous.view_digest, view });
  } finally {
    await fixture.admin.query(`update clued_private.binding_roles_v1 set effective_at=$2
      where binding_id=$1 and role='ci-admission'`, [fixture.binding, role.restore_at]);
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
  for (const invalid of [
    { ...view, alerts: ['字'.repeat(11000)] },
    { ...view, schema: 'clued.merge-queue-node-view/2' },
    { ...view, node_id: uuid() },
    { ...view, node: { ...view.node, secret: 'unexpected' } },
    { ...view, pending: Array(31).fill(view.pending[0]) },
    { ...view, alerts: ['字'.repeat(201)] },
    { ...view, alerts: { text: '非数组' } },
  ]) {
    const result = await report(invalid);
    assert.deepEqual([result.status, result.error_code], ['rejected', 'ci_queue_report_invalid']);
  }
  const forbidden = await command({ action: 'ci_nodes_status' });
  assert.equal(forbidden.error_code, 'heartbeat_connection_only');
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
  const { admin, user, other, claims } = fixture;
  await assert.rejects(() => read(claims(user, fixture.session, { client_id: 'oauth-client' })), /direct_human_session_required/);
  assert.deepEqual(ok(await read(claims(other))).nodes, []);
  const { rows } = await admin.query(`select r.role,
    has_function_privilege(r.role,'public.clued_merge_queue_resident_v1(jsonb)','execute') execute,
    has_table_privilege(r.role,'clued_private.ci_node_queue_view_v1','select,insert,update,delete') table_access
    from unnest(array['anon','authenticated','service_role','clued_worker_gateway']) r(role)`);
  assert.deepEqual(rows.map((row) => [row.role, row.execute, row.table_access]), [
    ['anon', false, false], ['authenticated', true, false], ['service_role', false, false], ['clued_worker_gateway', false, false],
  ]);
});
