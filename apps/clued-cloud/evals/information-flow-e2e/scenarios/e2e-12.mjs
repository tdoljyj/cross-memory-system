// E2E-12: the default policy excludes Agent-authored Records (the E2E-11
// bypass write and an observed note written directly by the Binding); an
// explicit opt-in policy admits them labelled AGENT_AUTHORED, not
// human-confirmed, and the pack is not authoritative.
import { acceptPolicy, checkPack, ids, key, nativeNote, noteInput, packExtract, policyDoc, uuid } from './common.mjs';
import { sha256 } from '../evidence.mjs';

export const id = 'E2E-12';

export async function run(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p12;
  r.alias('P12', scope.slice(8));
  const bypass = r.alias('BYPASS', ctx.shared.e11?.recordId);
  const native = r.alias('N12', await nativeNote(r, U, 'Native note in E2E-12', { scope }));
  const ingested = await r.tool(B, 'clued_evidence_ingest', { idempotency_key: key('e12ev'), evidence_schema_version: 1,
    evidence_type: 'file', storage_ref: 'binding:s6-e12', content_hash: sha256('s6-e12'), mime_type: 'text/plain',
    size_bytes: 6 }, { extract: (b) => ({ status: b?.status }) });
  const observedId = r.alias('OBS', uuid());
  const observed = await r.tool(B, 'clued_record_mutate', noteInput(observedId, 'Agent observed note (synthetic)', { scope,
    authority: 'observed', sources: ingested.structured?.evidence_ids ?? [] }),
  { extract: (b) => ({ status: b?.status, error_code: b?.error_code ?? null }) });
  r.check('12.observed_write', 'the Binding writes an observed note directly', 'committed', observed.structured?.status);
  await acceptPolicy(r, U, policyDoc('e12.default', [scope]));
  await acceptPolicy(r, U, policyDoc('e12.optin', [scope], { allow_agent_authored: true }));
  const def = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e12.default' }, { extract: packExtract })).structured;
  checkPack(r, '12.default', def);
  r.checkSet('12.default_items', 'the default pack contains neither Agent-authored Record', [native], ids(def));
  r.check('12.default_authoritative', 'the default pack is authoritative', true, def?.pack?.authoritative);
  const opt = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e12.optin' }, { extract: packExtract })).structured;
  checkPack(r, '12.optin', opt);
  r.checkSet('12.optin_items', 'the opt-in pack contains both Agent-authored Records', [native, bypass, observedId], ids(opt));
  const byId = Object.fromEntries((opt?.pack?.items ?? []).map((row) => [row.canonical_id, row]));
  for (const [name, rid] of [['bypass', bypass], ['observed', observedId]]) {
    r.check(`12.optin_${name}_label`, `opt-in: the ${name} Record is labelled AGENT_AUTHORED and not human-confirmed`,
      [['AGENT_AUTHORED'], 'agent_binding', false],
      [byId[rid]?.labels, byId[rid]?.writer_principal, byId[rid]?.human_confirmed]);
  }
  r.check('12.optin_not_authoritative', 'the opt-in pack is authoritative=false', false, opt?.pack?.authoritative);
  return {};
}
