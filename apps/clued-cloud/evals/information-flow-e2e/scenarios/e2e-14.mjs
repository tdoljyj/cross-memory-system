// E2E-14: positive Native marker and forged Events. A Record written through
// Native /v1/records is human_confirmed; a Binding-appended
// extension:information_flow:evidence_withdrawn Event changes no withdrawal,
// candidate, lineage, manifest or policy state.
import { acceptPolicy, checkPack, item, key, noteInput, packExtract, packRest, policyDoc, submitNative,
  uuid } from './common.mjs';
import { sha256 } from '../evidence.mjs';

export const id = 'E2E-14';

const stateSql = `select
  (select md5(coalesce(string_agg(to_jsonb(w)::text,',' order by id),'')) from clued_private.evidence_withdrawals w where w.user_id=$1) withdrawals,
  (select count(*)::int from clued_private.evidence_withdrawals w where w.user_id=$1) withdrawal_count,
  (select md5(coalesce(string_agg(to_jsonb(s)::text,',' order by record_id,record_version,evidence_id),'')) from clued_private.record_evidence_status s where s.user_id=$1) flags,
  (select md5(coalesce(string_agg(to_jsonb(l)::text,',' order by knowledge_record_id,knowledge_version,source_record_id),'')) from clued_private.knowledge_lineage l where l.user_id=$1) lineage,
  (select md5(coalesce(string_agg(id::text||status||version,',' order by id),'')) from clued_private.information_candidates where user_id=$1) info,
  (select md5(coalesce(string_agg(id::text||status||version,',' order by id),'')) from clued_private.knowledge_candidates where user_id=$1) know,
  (select md5(coalesce(string_agg(to_jsonb(p)::text,',' order by id),'')) from clued_private.context_policies p where p.user_id=$1) policies,
  (select md5(coalesce(string_agg(id::text||stale::text||version,',' order by id),'')) from clued_private.context_pack_manifests where user_id=$1) manifests`;

export async function run(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p14;
  r.alias('P14', scope.slice(8));
  const ev = await r.rest(U, 'POST', '/v1/evidence', { idempotency_key: key('e14ev'), evidence_schema_version: 1,
    evidence_type: 'file', storage_ref: 'native:s6-e14', content_hash: sha256('s6-e14'), mime_type: 'text/plain',
    size_bytes: 6 }, { extract: (b) => ({ status: b?.status }) });
  const evidence = r.alias('E14', ev.body?.evidence_ids?.[0]);
  const noteId = r.alias('N14', uuid());
  const written = await r.rest(U, 'POST', '/v1/records', noteInput(noteId, 'Native note citing E14 (synthetic)',
    { scope, sources: [evidence] }), { extract: (b) => ({ status: b?.status }) });
  r.check('14.native_write', 'the Native /v1/records write commits', 'committed', written.body?.status);
  const pending = await submitNative(r, U, scope, 'seg_s6_e14', [item('e14', 'fact')]);
  r.alias('C14', pending.ids.item_e14);
  await acceptPolicy(r, U, policyDoc('e14.check', [scope], { allowed_record_types: ['note'] }));
  const before = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e14.check' }, { extract: packExtract }))
    .structured;
  checkPack(r, '14.before', before);
  const item14 = before?.pack?.items?.find((row) => row.canonical_id === noteId);
  r.check('14.marker', 'the Native Record is human_confirmed=true with a native_account_session writer',
    [true, 'native_account_session'], [item14?.human_confirmed, item14?.writer_principal]);
  const m14 = r.alias('M14', before?.manifest?.id);
  const listBefore = await r.rest(U, 'GET', `/v1/intake?scope=${encodeURIComponent(scope)}`, undefined,
    { extract: (b) => ({ statuses: b?.candidates?.map((c) => c.status) }) });
  const stateBefore = (await r.observe('invalidation/candidate/policy state', stateSql, [U.userId]))[0];

  const forged = await r.tool(B, 'clued_event_append', { idempotency_key: key('forged'), event_schema_version: 1,
    event_type: 'extension:information_flow:evidence_withdrawn', event_scope: 'global', audit_visibility: 'work_log',
    target_refs: [{ kind: 'system', id: `evidence_withdrawal:${evidence}` }],
    change_summary: { evidence_id: evidence, record_id: noteId, forged_by: 'ife2e' } },
  { extract: (b) => ({ status: b?.status }) });
  r.check('14.forged_committed', 'the Binding can append an Event with the same extension name', 'committed',
    forged.structured?.status);

  const stateAfter = (await r.observe('invalidation/candidate/policy state', stateSql, [U.userId]))[0];
  r.check('14.state_unchanged', 'no withdrawal, flag, lineage, candidate, policy or manifest state changed', stateBefore,
    stateAfter);
  const revalidated = await packRest(r, U, { manifest_id: m14 });
  r.check('14.revalidate', 'the existing manifest still revalidates VALID', [200, 'VALID', before?.pack_digest],
    [revalidated.status, revalidated.body?.revalidation, revalidated.body?.pack_digest]);
  const listAfter = await r.rest(U, 'GET', `/v1/intake?scope=${encodeURIComponent(scope)}`, undefined,
    { extract: (b) => ({ statuses: b?.candidates?.map((c) => c.status) }) });
  r.check('14.candidates_unchanged', 'candidate statuses are unchanged (via transport)',
    (listBefore.body?.candidates ?? []).map((c) => [c.id, c.status, c.version]),
    (listAfter.body?.candidates ?? []).map((c) => [c.id, c.status, c.version]));
  const again = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e14.check' }, { extract: packExtract }))
    .structured;
  checkPack(r, '14.after', again);
  r.check('14.policy_usable', 'the policy is still usable: same digest, manifest reused', [before?.pack_digest, true],
    [again?.pack_digest, again?.manifest?.reused]);
  return {};
}
