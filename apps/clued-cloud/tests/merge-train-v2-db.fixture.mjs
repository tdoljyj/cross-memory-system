import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { digest, schedulingFixture, uuid } from './ci-scheduling-stage1-fixture.mjs';
import { workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const RPC = new Set([
  'clued_work_verify_v1', 'clued_work_merge_slot_holders_v1', 'clued_work_merge_slot_touch_v1',
  'clued_work_claim_adopt_v1', 'clued_work_merge_slot_return_v1', 'clued_work_pr_lifecycle_report_v1',
]);
const newToken = () => 'clued_bnd_' + randomBytes(32).toString('hex');

export async function mergeTrainTestDatabase(t, { repository, nodeCount = 2 }) {
  assert.ok(Number.isInteger(nodeCount) && nodeCount >= 1 && nodeCount <= 3);
  const firstToken = newToken();
  const f = await schedulingFixture({ tokenHash: digest(firstToken) });
  t.after(f.close);
  const anon = await f.connect('anon');
  const scope = 'project:' + f.project;
  const { receipt_id: receipt } = f.claimResult;
  const config = { scope, repository, supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' };
  const one = async (sql, args = []) => (await f.admin.query(sql, args)).rows[0];
  const calls = [];

  async function rpc(name, tokenHash, input) {
    assert.ok(RPC.has(name), name);
    const result = (await anon.query(`select public.${name}($1::text,$2::jsonb) as result`, [tokenHash, input])).rows[0].result;
    calls.push({ name, action: input.action, status: result.status, verdict: result.verdict, reason: result.error_code ?? result.reason ?? null,
      reasons: result.reasons });
    return result;
  }
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, config.supabaseUrl);
    assert.equal(options.method, 'POST');
    assert.ok(target.pathname.startsWith('/rest/v1/rpc/'));
    const { p_token_hash: tokenHash, p_input: input } = JSON.parse(options.body);
    return Response.json(await rpc(target.pathname.split('/').at(-1), tokenHash, input));
  };

  // raw-binding-grants: schedulingFixture 已安装授权触发器，会为每个新插入的节点 Binding 授予测试权限。
  const nodes = [];
  for (let index = 0; index < nodeCount; index++) {
    const name = `fixture-${index + 1}`;
    const token = index === 0 ? firstToken : newToken();
    const bindingId = index === 0 ? f.binding : (await one(`
      insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic',$2,$3,array['context:read'],array['*']) returning id`, [f.user, name, digest(token)])).id;
    const registered = f.committed(await f.native('clued_ci_node_registration_v1', {
      ...f.registration(), binding_id: bindingId, name,
    }));
    await f.approve(registered.node_id);
    nodes.push({ name, token, bindingId, nodeId: registered.node_id });
  }
  if (nodes.length > 1) {
    // 只提供隔离库中已有的开关与登记，接班结果由原看门狗决定。
    await f.admin.query(`insert into clued_private.ci_failover_settings_v1
      (user_id,enabled,enabled_at,version,updated_at,receipt_id) values($1,true,now(),1,now(),$2)`, [f.user, receipt]);
    for (const [index, node] of nodes.entries()) {
      await f.admin.query(`insert into clued_private.ci_failover_members_v1
        (user_id,binding_id,rank,marked_at,receipt_id) values($1,$2,$3,now(),$4)`, [f.user, node.bindingId, index + 1, receipt]);
    }
  }
  const verify = (node, input) => rpc('clued_work_verify_v1', digest(node.token), { scope, ...input });
  async function authorizeHead(pr, headSha) {
    const { claim, claimResult } = f;
    return f.committed(await workerGatewayRpc(f.gateway, 'clued_work_renew_v1', f.token, {
      scope, action: 'authorize_head', claim_id: claim.claim_id, fence: claim.fence, lease_version: claim.lease_version,
      ...(claimResult.lease_key ? { lease_key: claimResult.lease_key } : {}),
      repository, head_sha: headSha, target_branch: 'main', pr_number: pr, idempotency_key: uuid(),
    }));
  }
  return {
    config, fetchImpl, nodes, calls, verify, authorizeHead, claim: f.claim, startAt: f.sessionIssuedAt,
    async watchdog() {
      const { result } = await one('select clued_private.ci_admission_failover_tick_v1() as result');
      return result.accounts.find(account => account.user_id === f.user);
    },
    async heartbeats() {
      return (await f.admin.query(`select n.binding_id,l.heartbeat_sequence,l.reported_state,l.reported_service_running
        from clued_private.ci_nodes_v1 n join clued_private.ci_node_liveness_v1 l using(node_id)
        where n.user_id=$1 order by n.name`, [f.user])).rows;
    },
    async effects() {
      const { joins, adoptions } = await one(`select
        count(*) filter(where operation='work_claim_merge_queue_join_by_ci')::int joins,
        count(*) filter(where operation='work_claim_adopt')::int adoptions
        from public.clued_audit_receipts where user_id=$1 and object_id=$2`, [f.user, f.claim.claim_id]);
      return { queueJoins: joins, adoptions };
    },
  };
}
