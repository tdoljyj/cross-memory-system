// E2E-03: Agent-proposed Candidate Knowledge over two human-confirmed
// Authority Records -> Native promotion -> one source updated -> lineage
// stale, manifest stale, recompile excludes the knowledge; the knowledge
// Record itself is unchanged.
import { acceptPolicy, checkPack, ids, key, nativeNote, packExtract, packRest, policyDoc, promote,
  updateInput } from './common.mjs';

export const id = 'E2E-03';

export async function run(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p03;
  r.alias('P03', scope.slice(8));
  const r1 = r.alias('R1', await nativeNote(r, U, 'Lineage source one', { scope }));
  const r2 = r.alias('R2', await nativeNote(r, U, 'Lineage source two', { scope }));
  const proposed = await r.tool(B, 'clued_knowledge_propose', { idempotency_key: key('kp'), scope,
    rule_id: 'knowledge.consolidate.v1', assertion: 'Sources one and two describe the same confirmed risk list.',
    sources: [{ id: r1, version: 1 }, { id: r2, version: 1 }] },
  { extract: (b) => ({ status: b?.status, tier: b?.supplemental?.tier, authority: b?.supplemental?.authority }) });
  r.check('03.propose', 'the Binding proposes Candidate Knowledge', ['committed', 'knowledge', 'none'],
    [proposed.structured?.status, proposed.structured?.supplemental?.tier, proposed.structured?.supplemental?.authority]);
  const kc = r.alias('KC', proposed.structured?.supplemental?.candidate_id);
  const promoted = await promote(r, U, 'knowledge', kc);
  const k = r.alias('K', promoted.recordId);

  await acceptPolicy(r, U, policyDoc('e03.know', [scope], { allowed_tiers: ['authority_knowledge'],
    allowed_record_types: ['note'] }));
  await acceptPolicy(r, U, policyDoc('e03.mixed', [scope], { allowed_record_types: ['note'] }));
  const m3 = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e03.mixed' }, { extract: packExtract })).structured;
  checkPack(r, '03.before', m3);
  r.checkSet('03.before_items', 'the compile contains R1, R2 and K', [r1, r2, k], ids(m3));
  const m3Id = r.alias('M3', m3?.manifest?.id);
  const mk = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e03.know' }, { extract: packExtract })).structured;
  r.checkSet('03.know_items', 'the knowledge-only compile contains K with lineage OK', [k], ids(mk));
  const mkId = r.alias('MK', mk?.manifest?.id);

  const listBefore = await r.rest(U, 'GET', `/v1/records?level=project&project_id=${scope.slice(8)}&record_type=note`,
    undefined, { extract: (b) => ({ count: b?.records?.length }) });
  const kBefore = listBefore.body?.records?.find((row) => row.id === k);
  const kBodyBefore = (await r.observe('knowledge record body digest',
    'select md5(to_jsonb(m)::text) d, version::int v from public.clued_memories m where id=$1', [k]))[0];

  const updated = await r.rest(U, 'POST', '/v1/records', updateInput(r1, scope, 1, { title: 'Lineage source one v2' }),
    { extract: (b) => ({ status: b?.status }) });
  r.check('03.update', 'the Native owner updates source one', 'committed', updated.body?.status);

  const lineage = await r.observe('knowledge_lineage for K', `select source_record_id::text id, lineage_stale,
    stale_reason from clued_private.knowledge_lineage where knowledge_record_id=$1 order by 1`, [k]);
  r.checkSet('03.lineage_flag', 'the lineage edge to source one is lineage_stale (source_updated)',
    [`${r1}:true:source_updated`, `${r2}:false:null`],
    lineage.map((row) => `${row.id}:${row.lineage_stale}:${row.stale_reason}`));
  const kBodyAfter = (await r.observe('knowledge record body digest',
    'select md5(to_jsonb(m)::text) d, version::int v from public.clued_memories m where id=$1', [k]))[0];
  r.check('03.k_unchanged_db', 'the knowledge Record row is byte-identical', kBodyBefore, kBodyAfter);
  const listAfter = await r.rest(U, 'GET', `/v1/records?level=project&project_id=${scope.slice(8)}&record_type=note`,
    undefined, { extract: (b) => ({ count: b?.records?.length }) });
  const kAfter = listAfter.body?.records?.find((row) => row.id === k);
  r.check('03.k_unchanged_transport', 'the knowledge Record reads identically through /v1/records',
    JSON.stringify(kBefore ?? null), JSON.stringify(kAfter ?? null));

  const revalidated = await packRest(r, U, { manifest_id: m3Id });
  r.check('03.revalidate_stale', 'the existing manifest fails revalidation (STALE)', [409, 'STALE'],
    [revalidated.status, revalidated.body?.revalidation]);
  r.check('03.revalidate_reason', 'the stale reason names the source update or lineage', true,
    ['source_updated', 'lineage_stale'].includes(revalidated.body?.reason));
  r.check('03.no_fallback', 'a stale manifest returns no pack body', false, 'pack_text' in (revalidated.body ?? {}));
  const mkRevalidated = await packRest(r, U, { manifest_id: mkId });
  r.check('03.know_revalidate', 'the knowledge-only manifest is STALE with lineage_stale', [409, 'STALE', 'lineage_stale'],
    [mkRevalidated.status, mkRevalidated.body?.revalidation, mkRevalidated.body?.reason]);
  const recompiled = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e03.mixed' }, { extract: packExtract }))
    .structured;
  checkPack(r, '03.after', recompiled);
  r.checkSet('03.recompile_excludes_k', 'the recompile excludes K', [r1, r2], ids(recompiled));
  r.check('03.digest_differs', 'the recompiled pack digest differs from M3', true,
    Boolean(recompiled?.pack_digest) && recompiled?.pack_digest !== m3?.pack_digest);
  return {};
}
