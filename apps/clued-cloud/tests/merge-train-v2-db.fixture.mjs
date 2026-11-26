import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { digest, schedulingFixture, sha, uuid } from './ci-scheduling-stage1-fixture.mjs';
import { trainBatchKey, trainEffectKey, trainLandingSlotKey } from '../../../work/actions-hosted-migration/independent-ci-v1/src/merge-train-v2-contract.mjs';
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
    async prepareInFlightAdopt({ intent, newerHead }) {
      const [member] = intent.members;
      const ref = repository + '#' + member.pr;
      const args = [f.user, f.claim.claim_id, member.epoch, f.binding, repository, member.headSha, ref];
      await f.admin.query(`insert into clued_private.work_claim_pr_task_bindings_v1(user_id,repo_id,pr_number,task_id,status)
        values($1,$2,$3,$4,'active')`, [f.user, repository, member.pr, f.claim.task_id]);
      await authorizeHead(member.pr, member.headSha);
      await authorizeHead(member.pr, newerHead);
      await f.admin.query(`insert into clued_private.work_claim_execution_admissions_v1
        (user_id,claim_id,execution_epoch,ci_binding_id,repository,head_sha,target_branch,pr_ref,resources_digest)
        values($1,$2,$3,$4,$5,$6,'main',$7,$6)`, args);
      const { id } = await one(`select clued_private.ci_train_record_landing_v2(b,$2,$3,$4,$5) id
        from public.clued_agent_bindings b where b.id=$1`, [f.binding,scope,repository,intent,
        { state: 'landed', mainSha: intent.testSha, generationRefOid: intent.landedRefOid }]);
      // The already-dispatched adopt carries H1 after the remote PR changes to H2.
      return {
        async adopt() {
          const { result } = await one(`select clued_private.ci_train_adopt_member_v2(b,$2,$3,$4,$5,$6) result
            from public.clued_agent_bindings b where b.id=$1`, [f.binding,scope,id,intent.effectId,member,member.headSha]);
          return result;
        },
        snapshot: () => one(`select t.status binding, w.status claim, exists(
          select 1 from clued_private.work_claim_head_authorizations_v1 a where a.claim_id=w.claim_id
            and a.head_sha=$5 and a.revoked_at is null
          ) "newerAuthorized" from clued_private.work_claim_pr_task_bindings_v1 t
          join clued_private.work_claims_v1 w on w.user_id=t.user_id and w.task_id=t.task_id
          where t.user_id=$1 and t.repo_id=$2 and t.pr_number=$3 and w.claim_id=$4`,
        [f.user,repository,member.pr,member.claimId,newerHead]),
      };
    },
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

export async function verifyInFlightAdoptPreservesNewHead(t) {
  const repository = 'tdoljyj/cross-memory-system';
  const db = await mergeTrainTestDatabase(t, { repository, nodeCount: 1 });
  const member = { pr: 30, headSha: sha('old head'), claimId: db.claim.claim_id,
    fence: Number(db.claim.fence), epoch: Number(db.claim.execution_epoch) };
  const scope = { tenantId: 'fixture-tenant', projectId: db.config.scope, repositoryId: 11, targetBranch: 'main' };
  const baseSha = sha('base'), testSha = sha('tested'), generationRefOid = sha('generation');
  const batchId = trainBatchKey({ ...scope, baseSha, members: [member], sourceSha256: digest('source'), policyVersion: 'test' });
  const intent = { batchId, slotId: trainLandingSlotKey(scope), generation: 1, baseSha, testSha, generationRefOid,
    members: [member], landedRefOid: sha('landed'), expiresAt: new Date(db.startAt + 90_000).toISOString(),
    effectId: trainEffectKey({ ...scope, action: 'landing_send', subject: [batchId, 1, generationRefOid, baseSha, testSha] }) };
  const race = await db.prepareInFlightAdopt({ intent, newerHead: sha('new head') });
  const result = await race.adopt();
  assert.deepEqual(await race.snapshot(), { binding: 'active', claim: 'ACTIVE', newerAuthorized: true },
    'H1 的在途报告不能结束 H2 的 PR 绑定或释放它的认领');
  assert.equal(result.state, 'claim_changed');
  assert.deepEqual(await race.adopt(), result);
}
