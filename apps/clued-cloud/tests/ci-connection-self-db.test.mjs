import assert from 'node:assert/strict';
import test from 'node:test';
import sample from './fixtures/ci-connection-self-v1.json' with { type: 'json' };
import { digest, schedulingFixture, uuid } from './ci-scheduling-stage1-fixture.mjs';

const responseKeys = ['binding_id', 'connection_expires_at', 'contract', 'node', 'status'];
const nodeKeys = ['binding_generation', 'identity_fingerprint', 'name', 'node_id', 'rebind_receipt_id', 'state'];

test('CI 连接自查使用完整迁移链和匿名 RPC', { timeout: 900000 }, async t => {
  const f = await schedulingFixture();
  t.after(() => f.close());
  const caller = await f.connect('anon');
  const scope = 'project:' + f.project;
  const ask = async (hash, input = { scope }) => (await caller.query(
    'select public.clued_ci_connection_self_v1($1,$2) v', [hash, JSON.stringify(input)])).rows[0].v;
  const issue = async label => {
    const preview = await f.native('clued_headless_binding_confirmation_issue_v1', { label, days: 30,
      selected: [{ resource_kind: 'scope', resource_id: scope, environment: 'canonical', actions: ['read'] }] });
    assert.equal(preview.status, 'issued');
    return f.committed(await f.native('clued_headless_binding_issue_v1', {
      confirmation_token: preview.confirmation_token, view_digest: preview.view_digest }));
  };
  const register = async binding => f.committed(await f.native('clued_ci_node_registration_v1', {
    ...f.registration(), name: sample.node.name, binding_id: binding.binding_id }));

  const old = await issue('旧连接');
  const next = await issue('新连接');
  const unbound = await issue('独立只读连接');
  const first = await issue('首装连接');
  const installed = await register(first);
  const node = await register(old);
  await f.approve(node.node_id);
  const before = (await f.admin.query('select * from clued_private.ci_nodes_v1 where node_id=$1', [node.node_id])).rows[0];
  await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [old.binding_id]);
  await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
  const preview = await f.native('clued_ci_node_binding_rebind_confirmation_issue_v1', {
    project_id: f.project, node_id: node.node_id, old_binding_id: old.binding_id, new_binding_id: next.binding_id,
    base_version: Number(before.version), binding_generation: Number(before.binding_generation),
    accepted_ref: 'connection-self-fixture', idempotency_key: uuid() });
  assert.equal(preview.status, 'issued');
  const rebound = f.committed(await f.native('clued_ci_node_binding_rebind_apply_v1', {
    confirmation_token: preview.confirmation_token, view_digest: preview.view_digest }));

  await t.test('1 到期清扫及换绑后，新令牌返回原身份、新代次和换绑回执', async () => {
    const result = await ask(digest(next.token));
    assert.deepEqual(Object.keys(result).sort(), responseKeys);
    assert.deepEqual(Object.keys(result.node).sort(), nodeKeys);
    assert.deepEqual(Object.keys(sample).sort(), responseKeys);
    assert.deepEqual(Object.keys(sample.node).sort(), nodeKeys);
    assert.equal(sample.contract, 'clued.ci.connection-self/1');
    assert.equal(sample.status, 'ok');
    assert.equal(sample.node.binding_generation, Number(before.binding_generation) + 1);
    assert.equal(sample.node.state, before.state);
    // 样例与节点解析器共用。把样例中的实例值换成本轮真实签发、登记、换绑得到的值，再逐字段比较数据库应答。
    assert.deepEqual(result, { ...sample, binding_id: next.binding_id, connection_expires_at: rebound.connection_expires_at,
      node: { ...sample.node, node_id: node.node_id, identity_fingerprint: before.identity_fingerprint, rebind_receipt_id: rebound.receipt_id } });
  });

  await t.test('2 已清扫的旧令牌返回 42501', async () => {
    await assert.rejects(() => ask(digest(old.token)), { code: '42501', message: /binding_not_authorized|authorization_revoked_or_expired/ });
  });

  await t.test('3 只有 context:read 的普通连接可查自身，未挂节点时 node 为 null', async () => {
    const result = await ask(digest(unbound.token));
    const expiry = (await f.admin.query('select to_jsonb(expires_at) v from clued_private.authorizations_v12 where binding_id=$1',
      [unbound.binding_id])).rows[0].v;
    assert.deepEqual(result, { status: 'ok', contract: sample.contract, binding_id: unbound.binding_id, connection_expires_at: expiry, node: null });
    const acl = await f.admin.query(`select rolname,
      has_function_privilege(rolname,'public.clued_ci_connection_self_v1(text,jsonb)','EXECUTE') actual,
      has_function_privilege(rolname,'public.clued_work_merge_slot_holders_v1(text,jsonb)','EXECUTE') expected
      from pg_roles`);
    for (const role of acl.rows) assert.equal(role.actual, role.expected, role.rolname);
  });

  await t.test('4 首装节点没有换绑回执', async () => {
    const result = await ask(digest(first.token));
    assert.equal(result.node.node_id, installed.node_id);
    assert.equal(result.node.state, 'pending');
    assert.equal(result.node.binding_generation, 1);
    assert.equal(result.node.rebind_receipt_id, null);
  });

  await t.test('5 退役和撤销的节点均不可见', async () => {
    for (const state of ['retired', 'revoked']) {
      await f.admin.query('update clued_private.ci_nodes_v1 set state=$2 where node_id=$1', [installed.node_id, state]);
      assert.equal((await ask(digest(first.token))).node, null);
    }
  });

  await t.test('6 同一连接的节点按用户和项目隔离，拒绝额外、缺失或无效的输入', async () => {
    // 在两个项目登记同一个有权限的连接。唯一索引是 (user_id,project_id,binding_id)。
    const own = await f.register();
    assert.equal((await ask(f.token, { scope: 'global' })).node.node_id, own.node_id);
    const sibling = await f.register(f.project2);
    assert.equal((await ask(f.token)).node.node_id, own.node_id);
    assert.equal((await ask(f.token, { scope: 'project:' + f.project2 })).node.node_id, sibling.node_id);
    // 全局查询遇到两个本人的候选节点时，标量子查询拒绝任挑一行。
    await assert.rejects(() => ask(f.token, { scope: 'global' }), { code: '21000' });
    // 构造 binding_id 碰巧相同的外部账号行，确保 SECURITY DEFINER 查询仍检查 user_id。
    await f.admin.query('update clued_private.ci_nodes_v1 set user_id=$2, project_id=$3 where node_id=$1',
      [sibling.node_id, f.other, f.otherProject]);
    assert.equal((await ask(f.token, { scope: 'project:' + f.otherProject })).node, null);
    await assert.rejects(() => ask(digest(next.token), { scope: 'project:' + f.project2 }), { code: '42501' });
    for (const input of [{ scope, binding_id: old.binding_id }, {}, { scope: null }, { scope: 1 }, { scope: '' }, null, []]) {
      await assert.rejects(() => ask(digest(next.token), input), { code: '22023' });
    }
  });

  await t.test('7 有节点和无节点的调用前后，授权、节点、活性和回执逐行相同', async () => {
    // 用固定合成行重放 N1 样例。历史样例过期后，仅将测试连接的到期日平移到将来。
    // raw-binding-grants: schedulingFixture 已通过 allowRawTestBindings 配置了隔离库。
    const exampleHash = digest(uuid());
    const example = sample.node;
    await f.admin.query("set time zone 'UTC'");
    await caller.query("set time zone 'UTC'");
    const expiry = (await f.admin.query(`insert into public.clued_agent_bindings
      (id,user_id,vendor,agent_name,token_hash,scopes,context_keys,expires_at)
      values ($1,$2,'synthetic','N1 sample',$3,array['context:read'],array[$4],
        $5::timestamptz + greatest(0, current_date + 1 - $5::timestamptz::date) * interval '1 day')
      returning to_jsonb(expires_at) v, expires_at = $5::timestamptz as original`,
    [sample.binding_id, f.user, exampleHash, scope, sample.connection_expires_at])).rows[0];
    f.committed(await f.native('clued_ci_node_registration_v1', { ...f.registration(), node_id: example.node_id,
      binding_id: sample.binding_id, name: example.name }));
    await f.admin.query('update clued_private.ci_nodes_v1 set identity_fingerprint=$2,state=$3,binding_generation=$4 where node_id=$1',
      [example.node_id, example.identity_fingerprint, example.state, example.binding_generation]);
    await f.admin.query(`insert into public.clued_audit_receipts(id,user_id,context_key,operation,object_type,object_id,version,metadata)
      values ($1,$2,$3,'ci_node_binding_rebind','ci_scheduling',$4,1,'{}')`, [example.rebind_receipt_id, f.user, scope, example.node_id]);
    // 两个同连接回执取最新，另一连接的更晚回执也不能遮住它。
    await f.admin.query(`insert into clued_private.ci_node_binding_rebinds_v1
      (user_id, project_id, node_id, idempotency_key, request_digest, receipt_id, result, created_at)
      select $1,$2,$3,x.key,$4,x.receipt,jsonb_build_object('binding_id',x.binding),now()+x.age from (values
        ('older',$5::uuid,$6::uuid,interval '-1 day'), ('sample',$7::uuid,$6::uuid,interval '0 days'),
        ('other',$5::uuid,$8::uuid,interval '1 day')) x(key,receipt,binding,age)`,
    [f.user, f.project, example.node_id, digest('sample'), rebound.receipt_id, sample.binding_id, example.rebind_receipt_id, old.binding_id]);
    await f.live(node.node_id);
    const tables = ['auth.users', 'public.clued_agent_bindings', 'public.clued_projects', 'public.clued_audit_receipts',
      ...['authorizations_v12', 'authorization_entries_v12', 'authorization_audit_v12', 'binding_retirements_v1',
        'binding_roles_v1', 'ci_nodes_v1', 'ci_node_liveness_v1', 'ci_node_heartbeat_link_v1', 'ci_node_binding_rebinds_v1',
        'ci_connection_expiry_reminders_v1'].map(name => 'clued_private.' + name)];
    const snapshot = async () => {
      const rows = {};
      for (const table of tables) rows[table] = (await f.admin.query(`select to_jsonb(r) v from ${table} r order by v`)).rows;
      return rows;
    };
    const original = await snapshot();
    await ask(digest(next.token));
    await ask(digest(unbound.token));
    const exported = await ask(exampleHash);
    assert.deepEqual(exported, expiry.original ? sample : { ...sample, connection_expires_at: expiry.v });
    if (expiry.original) t.diagnostic('数据库返回的完整 JSON 与 N1 共用样例相等');
    assert.deepEqual(await snapshot(), original);
  });
});
