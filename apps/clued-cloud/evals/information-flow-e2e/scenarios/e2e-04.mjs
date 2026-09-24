// E2E-04: Evidence withdrawal. The dependent pending candidate moves to
// conflict, the knowledge lineage and the promoted Record are flagged, the
// manifest goes stale and a recompile excludes them; the Evidence row and
// the Record body are unchanged.
import { ALL_TIERS, acceptPolicy, checkPack, ids, item, key, nativeNote, packRest, policyDoc, promote,
  submitNative } from './common.mjs';

export const id = 'E2E-04';

export async function run(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p04;
  r.alias('P04', scope.slice(8));
  const submitted = await submitNative(r, U, scope, 'seg_s6_e04', [item('one', 'fact'), item('two', 'fact')]);
  const c4a = r.alias('C4A', submitted.ids.item_one);
  const c4b = r.alias('C4B', submitted.ids.item_two);
  const evidence = r.alias('E', submitted.evidenceId);
  const r4 = r.alias('R4', (await promote(r, U, 'information', c4a)).recordId);
  const s4 = r.alias('S4', await nativeNote(r, U, 'Independent source S', { scope }));
  const proposed = await r.tool(B, 'clued_knowledge_propose', { idempotency_key: key('kp4'), scope,
    rule_id: 'knowledge.consolidate.v1', assertion: 'R4 and S4 agree.', sources: [{ id: r4, version: 1 },
      { id: s4, version: 1 }] }, { extract: (b) => ({ status: b?.status }) });
  const k4 = r.alias('K4', (await promote(r, U, 'knowledge', proposed.structured?.supplemental?.candidate_id)).recordId);
  await acceptPolicy(r, U, policyDoc('e04.all', [scope], { allowed_tiers: ALL_TIERS, allowed_record_types: ['note'],
    allow_agent_authored: true }));
  const before = (await packRest(r, U, { scope, task_class: 'e04.all' })).body;
  checkPack(r, '04.before', before);
  r.checkSet('04.before_items', 'before: R4, S4, K4 and pending C4B are in the pack', [r4, s4, k4, c4b], ids(before));
  const m4 = r.alias('M4', before?.manifest?.id);

  const snapshot = async () => (await r.observe('Evidence row and Record bodies', `select
    (select md5(to_jsonb(e)::text) from public.clued_evidence e where e.id=$1) evidence,
    (select md5(to_jsonb(m)::text) from public.clued_memories m where m.id=$2) r4,
    (select md5(to_jsonb(m)::text) from public.clued_memories m where m.id=$3) k4`, [evidence, r4, k4]))[0];
  const bodiesBefore = await snapshot();

  const issued = await r.rest(U, 'POST', `/v1/evidence/${evidence}/withdrawal/confirmation`, { base_version: 0,
    reason: 'The capture was pasted into the wrong chat (synthetic)' }, { extract: (b) => ({ status: b?.status,
    records: b?.effects_preview?.counts?.records ?? null }) });
  r.check('04.issue', 'step 1 issues a withdrawal confirmation token', 'issued', issued.body?.status);
  const withdrawn = await r.rest(U, 'POST', `/v1/evidence/${evidence}/withdrawal`, { idempotency_key: key('wd'),
    base_version: 0, confirmation_token: issued.body?.confirmation_token, view_digest: issued.body?.view_digest },
  { extract: (b) => ({ status: b?.status, outcome: b?.supplemental?.outcome, stale_manifests: b?.supplemental?.stale_manifests }) });
  r.check('04.withdraw', 'step 2 withdraws the Evidence', ['committed', 'withdrawn'],
    [withdrawn.body?.status, withdrawn.body?.supplemental?.outcome]);

  const listed = await r.rest(U, 'GET', `/v1/intake?scope=${encodeURIComponent(scope)}`, undefined,
    { extract: (b) => ({ statuses: b?.candidates?.map((c) => c.status) }) });
  r.check('04.candidate_conflict', 'the dependent pending candidate is conflict (via transport)', 'conflict',
    listed.body?.candidates?.find((c) => c.id === c4b)?.status);
  const revalidated = await packRest(r, U, { manifest_id: m4 });
  r.check('04.revalidate', 'the manifest fails revalidation with evidence_withdrawn', [409, 'STALE', 'evidence_withdrawn'],
    [revalidated.status, revalidated.body?.revalidation, revalidated.body?.reason]);
  const after = (await packRest(r, U, { scope, task_class: 'e04.all' })).body;
  checkPack(r, '04.after', after);
  r.checkSet('04.recompile', 'the recompile excludes R4, K4 and C4B', [s4], ids(after));
  const flags = await r.observe('record_evidence_status for R4', `select record_version::int v, evidence_id::text e,
    flagged_by from clued_private.record_evidence_status where record_id=$1`, [r4]);
  r.check('04.record_flag', 'R4@1 is flagged evidence_withdrawn by the withdrawal',
    [{ v: 1, e: evidence, flagged_by: 'withdrawal' }], flags);
  const lineage = await r.observe('knowledge_lineage for K4', `select source_record_id::text id, lineage_stale, stale_reason
    from clued_private.knowledge_lineage where knowledge_record_id=$1`, [k4]);
  r.checkSet('04.lineage_flag', 'K4 lineage over R4 is flagged source_evidence_withdrawn',
    [`${r4}:true:source_evidence_withdrawn`, `${s4}:false:null`],
    lineage.map((row) => `${row.id}:${row.lineage_stale}:${row.stale_reason}`));
  r.check('04.bodies_unchanged', 'the Evidence row and the Record bodies are unchanged', bodiesBefore, await snapshot());
  return {};
}
