// E2E-11: OD-5 bypass probe. Recorded as OBSERVED behavior, never PASS:
// while OD-5 is open a bound Agent can write authority=user_explicit through
// the public clued_record_mutate. Runs only on the freshly reset local
// database with a synthetic principal. Filed under OPEN_BY_OD-5 (A03 L01).
import { noteInput, uuid } from './common.mjs';

export const id = 'E2E-11';

export async function run(ctx, r) {
  const { U, B_main: B, projects, environment } = ctx;
  const scope = projects.p12;
  r.alias('P12', scope.slice(8));
  const identity = (await r.observe('database identity', `select (select system_identifier::text from pg_control_system()) s`))[0];
  r.check('11.pre.fresh_db', 'precondition: the disposable local database recorded right after db reset',
    environment.db_system_identifier, identity.s);
  r.check('11.pre.synthetic', 'precondition: the principal is synthetic (@example.invalid)', true,
    U.email.endsWith('@example.invalid'));
  const recordId = r.alias('BYPASS', uuid());
  const written = await r.tool(B, 'clued_record_mutate', noteInput(recordId, 'E2E-11 bypass write (synthetic)', { scope }),
    { extract: (b) => ({ status: b?.status, error_code: b?.error_code ?? null }) });
  r.check('11.observed.committed', 'observed: the Binding user_explicit write commits while OD-5 is open', 'committed',
    written.structured?.status);
  const receipt = await r.observe('writer Receipt', `select m.version::int v, rc.binding_id::text binding,
    clued_private.record_human_confirmed_v1(m.user_id,m.id,m.version) human_confirmed
    from public.clued_memories m join public.clued_audit_receipts rc on rc.id=m.receipt_id where m.id=$1`, [recordId]);
  r.check('11.observed.binding', 'observed: the Receipt carries the Binding id (Agent-authored)', B.bindingId,
    receipt[0]?.binding);
  r.check('11.observed.not_confirmed', 'observed: the Record is not human_confirmed', false, receipt[0]?.human_confirmed);
  ctx.shared.e11 = { recordId, scope };
  r.extra = { limitation_id: 'OPEN_BY_OD-5', register_entry: 'L01', expectation_if_OD5_decided: 'rejected',
    observation: written.structured?.status === 'committed' ? 'bypass_write_committed' : 'bypass_write_not_committed' };
  const preconditions = r.assertions.filter((a) => a.id.startsWith('11.pre.')).every((a) => a.pass);
  return { result: preconditions ? 'OBSERVED' : 'FAIL' };
}
