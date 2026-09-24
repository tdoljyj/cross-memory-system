// E2E-13: human_confirmed negative cases. (a) a maintenance write with a
// null binding_id (DB fixture: no product transport writes as maintenance);
// (b) an Agent-authored Record whose Binding row is later deleted (fixture
// delete; binding_id is on delete set null). Both read human_confirmed=false
// and are excluded from the default pack.
import { acceptPolicy, checkPack, ids, nativeNote, noteInput, packExtract, policyDoc, uuid } from './common.mjs';
import { sha256 } from '../evidence.mjs';

export const id = 'E2E-13';

export async function run(ctx, r) {
  const { U, B_main: B, B_del: D, projects } = ctx;
  const scope = projects.p13;
  r.alias('P13', scope.slice(8));
  const native = r.alias('N13', await nativeNote(r, U, 'Native note in E2E-13', { scope }));
  const maintenance = r.alias('MAINT', uuid());
  const maint = await r.fixture('maintenance write via record_mutation_with_terminal_guard (null binding)',
    (f) => f.maintenanceWrite(U.userId, noteInput(maintenance, 'Maintenance write (synthetic)', { scope }),
      sha256(`maintenance:${maintenance}`)));
  r.check('13.a.written', '(a) the maintenance write committed', 'committed', maint?.status);
  const doomed = r.alias('DOOMED', uuid());
  const agentWrite = await r.tool(D, 'clued_record_mutate', noteInput(doomed, 'Agent write, Binding later deleted', { scope }),
    { extract: (b) => ({ status: b?.status }) });
  r.check('13.b.written', '(b) the B_del Binding write committed', 'committed', agentWrite.structured?.status);
  const deleted = await r.fixture('delete the B_del Binding row', (f) => f.deleteBinding(D.bindingId));
  r.check('13.b.deleted', '(b) the Binding row was deleted', 1, deleted);
  // Internal-state observation (read-only observer): human_confirmed has no
  // transport read route for Records that are excluded from every pack.
  const confirmed = await r.observe('internal-state observation: human_confirmed and writer binding', `select m.id::text id,
    clued_private.record_human_confirmed_v1(m.user_id,m.id,m.version) human_confirmed, rc.binding_id::text binding
    from public.clued_memories m left join public.clued_audit_receipts rc on rc.id=m.receipt_id where m.id=any($1::uuid[])`,
  [[maintenance, doomed]]);
  const byId = Object.fromEntries(confirmed.map((row) => [row.id, row]));
  r.check('13.a.not_confirmed', '(a) internal-state observation: the null-binding maintenance Record is human_confirmed=false', [false, null],
    [byId[maintenance]?.human_confirmed, byId[maintenance]?.binding]);
  r.check('13.b.not_confirmed', '(b) internal-state observation: after the Binding delete the Record has a null binding and is still not confirmed',
    [false, null], [byId[doomed]?.human_confirmed, byId[doomed]?.binding]);
  await acceptPolicy(r, U, policyDoc('e13.default', [scope]));
  await acceptPolicy(r, U, policyDoc('e13.optin', [scope], { allow_agent_authored: true }));
  const def = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e13.default' }, { extract: packExtract })).structured;
  checkPack(r, '13.default', def);
  r.checkSet('13.default_items', 'both are excluded from the default pack', [native], ids(def));
  const opt = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e13.optin' }, { extract: packExtract })).structured;
  checkPack(r, '13.optin', opt);
  // Opt-in admits Agent-authored Records, but neither case has a known writer
  // principal (null binding), so both stay excluded (same behaviour as S4).
  r.checkSet('13.optin_items', 'the opt-in pack is exactly the Native note (both cases excluded)', [native], ids(opt));
  return {};
}
