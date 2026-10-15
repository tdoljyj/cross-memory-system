// E2E-05: Binding scope reduction. The next compile omits the reduced scope
// and the existing manifest fails revalidation. The reduction goes through
// clued_authorization_manage_v12 over PostgREST with the owner's real JWT:
// no Worker route exposes reduce outside the delegated-OAuth consent API.
import { acceptPolicy, checkPack, ids, nativeNote, packExtract, packRest, policyDoc } from './common.mjs';

export const id = 'E2E-05';

export async function run(ctx, r) {
  const { U, B_reduce: B, projects } = ctx;
  const [pa, pb] = [projects.p05a, projects.p05b];
  r.alias('P05A', pa.slice(8));
  r.alias('P05B', pb.slice(8));
  const na = r.alias('NA', await nativeNote(r, U, 'Scope A note', { scope: pa }));
  const nb = r.alias('NB', await nativeNote(r, U, 'Scope B note', { scope: pb }));
  await acceptPolicy(r, U, policyDoc('e05.check', [pa, pb], { allowed_record_types: ['note'] }));
  const first = (await r.tool(B, 'clued_context_pack', { scope: pa, task_class: 'e05.check' }, { extract: packExtract }))
    .structured;
  checkPack(r, '05.before', first);
  r.check('05.effective_scopes', 'the first compile covers both granted scopes', [pa, pb].sort(),
    [...(first?.pack?.scopes ?? [])].sort());
  r.checkSet('05.before_items', 'before: notes from both scopes', [na, nb], ids(first));
  const m5 = r.alias('M5', first?.manifest?.id);

  const listed = await r.postgrest('owner_jwt', 'clued_authorization_manage_v12', { p_input: { op: 'list' } },
    { extract: (b) => ({ count: b?.bindings?.length, code: b?.code, message: b?.message }) });
  const current = listed.body?.bindings?.find((row) => row.binding_id === B.bindingId);
  r.check('05.source_protocol', 'the current Native DTO uses source-aware authorization', [200, 'sources_v1'],
    [listed.status, current?.selection_format]);
  const exactSource = (scope) => (current?.sources ?? []).filter((source) => source.kind === 'direct'
    && source.contributions?.length === 1 && source.contributions[0].resource_kind === 'scope'
    && source.contributions[0].resource_id === scope && source.contributions[0].environment === 'canonical');
  const sourcesA = exactSource(pa), sourcesB = exactSource(pb);
  r.check('05.source_targets', 'the Native DTO has one independent direct source for each granted scope', [1, 1],
    [sourcesA.length, sourcesB.length]);
  if (listed.status !== 200 || current?.selection_format !== 'sources_v1' || sourcesA.length !== 1 || sourcesB.length !== 1) {
    throw new Error(`E2E-05 cannot identify exact source consent: ${listed.status} ${listed.body?.code ?? 'source_selection_unavailable'}`);
  }
  const [sourceA] = sourcesA, [sourceB] = sourcesB;
  // Omitted sources retain consent. Revoke the exact B source, rather than
  // treating the projected A row as a complete replacement of all provenance.
  const reduced = await r.postgrest('owner_jwt', 'clued_authorization_manage_v12', { p_input: { op: 'reduce',
    binding_id: B.bindingId, base_version: current.version, selection_format: 'sources_v1',
    sources: [{ source_id: sourceB.source_id, base_version: sourceB.version, action_cap: [] }], exceptions: [] } },
  { extract: (b) => ({ version: b?.version, selected: b?.selected?.map((row) => row.resource_id),
    selection_format: b?.selection_format, code: b?.code, message: b?.message }) });
  r.check('05.reduce', 'the owner reduces the Binding to scope A', [200, [pa]],
    [reduced.status, (reduced.body?.selected ?? []).map((row) => row.resource_id)]);
  r.check('05.untargeted_source', 'the unsubmitted A source keeps its original identity, version and consent', sourceA,
    reduced.body?.sources?.find((source) => source.source_id === sourceA.source_id));
  r.check('05.revoked_source', 'the submitted B source is no longer live', false,
    reduced.body?.sources?.some((source) => source.source_id === sourceB.source_id));

  const next = (await r.tool(B, 'clued_context_pack', { scope: pa, task_class: 'e05.check' }, { extract: packExtract }))
    .structured;
  checkPack(r, '05.after', next);
  r.check('05.next_scopes', 'the next compile covers only scope A', [pa], next?.pack?.scopes);
  r.checkSet('05.next_items', 'the next compile omits scope B items', [na], ids(next));
  const revalidated = await packRest(r, U, { manifest_id: m5 });
  r.check('05.revalidate', 'the existing manifest fails revalidation (binding_scope_reduced)',
    [409, 'STALE', 'binding_scope_reduced'],
    [revalidated.status, revalidated.body?.revalidation, revalidated.body?.reason]);
  r.note('Transport: reduce is a PostgREST call with the owner JWT (plan section 14 item 25).');
  return {};
}
