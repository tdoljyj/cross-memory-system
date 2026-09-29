// E2E-07: submit, the Worker host process group is SIGKILLed after
// PostgREST committed and before the Worker answers, a new host is started,
// the same key and body replay the committed result, and a different digest
// under the same key is rejected with a Receipt. Repeated for the Native
// route and for the MCP intake and knowledge-proposal tools. "One row per
// key" is observed through the transport list routes (GET /v1/intake with
// submission_id, MCP clued_intake_list); the read-only observer counts by
// idempotency key as corroboration. The rejected Receipt's stored status has
// no transport read route (the audit route needs audit:read and returns no
// status), so it stays an observer read beside the transport response.
import { documentOf, item, key, nativeNote, segment } from './common.mjs';

export const id = 'E2E-07';

async function killDuring(ctx, r, pathClass, send) {
  const host = ctx.h.worker;
  const killedPid = host.child.pid;
  await host.arm({ path_class: pathClass, step: r.steps.length + 1 });
  const hit = new Promise((resolve) => { host.onHook = resolve; });
  const pending = send();
  const hook = await hit;
  host.onHook = null;
  await host.killGroup('SIGKILL');
  const lost = await pending;
  r.processControl('SIGKILL worker host process group after committed upstream response', {
    signal: 'SIGKILL', killed_pid: killedPid, killed_pgid: killedPid, upstream_status: hook.status,
    path_class: hook.path_class });
  const committed = JSON.parse(hook.body);
  await ctx.restartWorker();
  r.processControl('start a new worker host', { new_pid: ctx.h.worker.child.pid });
  r.check(`07.${pathClass}.new_process`, 'the retry runs in a new Worker host process', true,
    ctx.h.worker.child.pid !== killedPid);
  return { lost, committed };
}

const count = (r, sql, params) => r.observe('row count', sql, params).then((rows) => rows[0].n);

export async function run(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p07;
  r.alias('P07', scope.slice(8));

  // Native /v1/intake.
  const nativeKey = key('e07n');
  const nativeBody = { idempotency_key: nativeKey, scope, segment: segment('seg_s6_e07n'),
    candidates: documentOf('seg_s6_e07n', [item('e07n', 'fact')]) };
  const session = await U.current();
  const n1 = await killDuring(ctx, r, 'rpc:clued_user_intake_submit',
    () => r.rest(U, 'POST', '/v1/intake', nativeBody, { session, extract: (b) => ({ status: b?.status }) }));
  r.check('07.native.lost', 'the client saw no response (connection reset)', true, n1.lost.networkError !== null);
  r.check('07.native.committed_upstream', 'PostgREST had committed the submit', 'committed', n1.committed.status);
  r.alias('C7N', n1.committed.supplemental?.candidates?.[0]?.id);
  const retry = await r.rest(U, 'POST', '/v1/intake', nativeBody, { session,
    extract: (b) => ({ status: b?.status, replayed: b?.replayed }) });
  r.check('07.native.replayed', 'the same key and body replay the committed Receipt', [200, true, n1.committed.receipt_id],
    [retry.status, retry.body?.replayed, retry.body?.receipt_id]);
  const submissionId = n1.committed.supplemental?.submission_id ?? null;
  const bySubmission = await r.rest(U, 'GET', `/v1/intake?scope=${encodeURIComponent(scope)}`
    + `&submission_id=${encodeURIComponent(submissionId ?? '')}&limit=200`, undefined, { session,
    extract: (b) => ({ status: b?.status, count: b?.candidates?.length ?? null }) });
  const listed = await r.rest(U, 'GET', `/v1/intake?scope=${encodeURIComponent(scope)}&limit=200`, undefined, { session,
    extract: (b) => ({ status: b?.status, local: b?.candidates?.filter((c) => c.candidate_local_id === 'item_e07n').length }) });
  r.check('07.native.one_candidate_transport', 'transport: the submission lists one candidate and the scope holds one '
    + 'candidate for the item', [200, [n1.committed.supplemental?.candidates?.[0]?.id ?? null], 1],
  [bySubmission.status, (bySubmission.body?.candidates ?? []).map((c) => c.id),
    (listed.body?.candidates ?? []).filter((c) => c.candidate_local_id === 'item_e07n').length]);
  r.check('07.native.one_submission', 'one submission row for the key', 1, await count(r,
    'select count(*)::int n from clued_private.information_intake_submissions where user_id=$1 and idempotency_key=$2',
    [U.userId, nativeKey]));
  r.check('07.native.one_candidate', 'one candidate set for the key', 1, await count(r, `select count(*)::int n
    from clued_private.information_candidates c join clued_private.information_intake_submissions s on s.id=c.submission_id
    where s.user_id=$1 and s.idempotency_key=$2`, [U.userId, nativeKey]));
  const conflict = await r.rest(U, 'POST', '/v1/intake', { ...nativeBody, client_label: 'different digest' }, { session,
    extract: (b) => ({ status: b?.status, error_code: b?.error_code }) });
  r.check('07.native.digest_conflict', 'a different digest under the same key is rejected',
    [409, 'rejected', 'IDEMPOTENCY_KEY_CONFLICT'], [conflict.status, conflict.body?.status, conflict.body?.error_code]);
  const rejectedReceipt = await r.observe('rejected Receipt', 'select status from public.clued_audit_receipts where id=$1',
    [conflict.body?.receipt_id ?? '00000000-0000-0000-0000-000000000000']);
  r.check('07.native.rejected_receipt', 'the conflict is recorded as a rejected Receipt', ['rejected'],
    rejectedReceipt.map((row) => row.status));

  // MCP clued_intake_submit.
  const agentKey = key('e07a');
  const agentBody = { idempotency_key: agentKey, scope, segment: segment('seg_s6_e07a'),
    candidates: documentOf('seg_s6_e07a', [item('e07a', 'fact')]) };
  const a1 = await killDuring(ctx, r, 'rpc:clued_intake_submit',
    () => r.tool(B, 'clued_intake_submit', agentBody, { extract: (b) => ({ status: b?.status }) }));
  r.check('07.agent.lost', 'the MCP client saw no response', true, a1.lost.networkError !== null);
  const agentRetry = await r.tool(B, 'clued_intake_submit', agentBody, { extract: (b) => ({ status: b?.status,
    replayed: b?.replayed }) });
  r.check('07.agent.replayed', 'the MCP retry replays the committed Receipt', [true, a1.committed.receipt_id],
    [agentRetry.structured?.replayed, agentRetry.structured?.receipt_id]);
  const agentListed = await r.tool(B, 'clued_intake_list', { scope, limit: 200 }, {
    extract: (b) => ({ status: b?.status, local: b?.candidates?.filter((c) => c.candidate_local_id === 'item_e07a').length }) });
  r.check('07.agent.one_candidate_transport', 'transport: the MCP list holds one candidate for the item',
    [1, a1.committed.supplemental?.submission_id ?? null],
    [(agentListed.structured?.candidates ?? []).filter((c) => c.candidate_local_id === 'item_e07a').length,
      (agentListed.structured?.candidates ?? []).find((c) => c.candidate_local_id === 'item_e07a')?.submission_id ?? null]);
  r.check('07.agent.one_submission', 'one submission row for the MCP key', 1, await count(r,
    'select count(*)::int n from clued_private.information_intake_submissions where user_id=$1 and idempotency_key=$2',
    [U.userId, agentKey]));
  const agentConflict = await r.tool(B, 'clued_intake_submit', { ...agentBody, client_label: 'different digest' },
    { extract: (b) => ({ status: b?.status, error_code: b?.error_code }) });
  r.check('07.agent.digest_conflict', 'the MCP digest conflict is rejected with a Receipt',
    ['rejected', 'IDEMPOTENCY_KEY_CONFLICT', true], [agentConflict.structured?.status, agentConflict.structured?.error_code,
      typeof agentConflict.structured?.receipt_id === 'string']);

  // MCP clued_knowledge_propose.
  const source = await nativeNote(r, U, 'E2E-07 knowledge source', { scope });
  r.alias('SRC7', source);
  const kpKey = key('e07k');
  const kpBody = { idempotency_key: kpKey, scope, rule_id: 'knowledge.dedup.v1', assertion: 'Retry after a lost response.',
    sources: [{ id: source, version: 1 }] };
  const k1 = await killDuring(ctx, r, 'rpc:clued_knowledge_propose',
    () => r.tool(B, 'clued_knowledge_propose', kpBody, { extract: (b) => ({ status: b?.status }) }));
  r.check('07.kp.lost', 'the MCP client saw no response', true, k1.lost.networkError !== null);
  const kpRetry = await r.tool(B, 'clued_knowledge_propose', kpBody, { extract: (b) => ({ status: b?.status,
    replayed: b?.replayed }) });
  r.check('07.kp.replayed', 'the proposal retry replays the committed Receipt', [true, k1.committed.receipt_id],
    [kpRetry.structured?.replayed, kpRetry.structured?.receipt_id]);
  const kpListed = await r.tool(B, 'clued_intake_list', { scope, tier: 'knowledge', limit: 200 }, {
    extract: (b) => ({ status: b?.status, count: b?.candidates?.length ?? null }) });
  r.check('07.kp.one_candidate_transport', 'transport: the MCP knowledge list holds one candidate for the assertion',
    [k1.committed.supplemental?.candidate_id ?? null],
    (kpListed.structured?.candidates ?? []).filter((c) => c.assertion === kpBody.assertion).map((c) => c.id));
  r.check('07.kp.one_candidate', 'one knowledge candidate for the key', 1, await count(r,
    'select count(*)::int n from clued_private.knowledge_candidates where user_id=$1 and idempotency_key=$2',
    [U.userId, kpKey]));
  const kpConflict = await r.tool(B, 'clued_knowledge_propose', { ...kpBody, assertion: 'changed' },
    { extract: (b) => ({ status: b?.status, error_code: b?.error_code }) });
  r.check('07.kp.digest_conflict', 'the proposal digest conflict is rejected with a Receipt',
    ['rejected', 'IDEMPOTENCY_KEY_CONFLICT', true], [kpConflict.structured?.status, kpConflict.structured?.error_code,
      typeof kpConflict.structured?.receipt_id === 'string']);
  return {};
}
