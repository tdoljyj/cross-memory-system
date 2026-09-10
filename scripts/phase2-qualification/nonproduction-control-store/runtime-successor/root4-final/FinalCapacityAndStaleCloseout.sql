-- One-time nonproduction continuation authorized after an expired, never-dispatched GA.
-- Reuses existing transition, budget, and gate functions. No refund or reuse of budget 59.
begin;

do $migration$
declare
  root constant text := 'ctr_414bd3c724264a83894b0c55cf2ab878';
  expired_ga constant text := 'ga_1d52f4778d494399b12aea54fe4a189e';
  before_current jsonb;
  after_current jsonb;
  d text;
  transformed text;
  before_meta jsonb;
  after_meta jsonb;
  observed_sha text;
begin
  perform 1 from clued_control.current_head where root_id=root for share;
  select to_jsonb(ec) into before_current
  from clued_control.execution_current ec where ec.root_id=root for update;

  if before_current->>'sequence' is distinct from '59'
     or before_current->>'active_ga_id' is distinct from expired_ga
     or before_current->>'pending_budget_sequence' is not null
     or before_current->>'charged_seconds' is distinct from '6906'
     or before_current->>'charged_evidence_bytes' is distinct from '1530506163'
  then raise exception 'FINAL_CONTINUATION_EXECUTION_STATE_MISMATCH'; end if;

  if not exists(
       select 1 from clued_control.gate_attempts a
       where a.root_id=root and a.ga_id=expired_ga and a.phase='PENDING'
         and a.container_id is null and a.receipt_raw is null and a.decision is null
         and clock_timestamp()>=a.expires_at
     )
     or exists(
       select 1 from clued_control.execution_events e
       where e.root_id=root and e.request->>'ga_id'=expired_ga
     )
  then raise exception 'FINAL_CONTINUATION_NO_DISPATCH_PROOF_MISMATCH'; end if;

  -- execution_transition: permit only an expired PENDING attempt with no
  -- container and no event of any kind to enter the existing STALE decision path.
  select pg_get_functiondef(p.oid),
         encode(digest(p.prosrc,'sha256'),'hex'),
         jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
                            'volatility',p.provolatile,'parallel',p.proparallel,
                            'config',p.proconfig,'acl',p.proacl)
  into d, observed_sha, before_meta
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_control' and p.proname='execution_transition';

  if observed_sha is distinct from '3df5c3213dc97d0e5be5f5e748f36e0e1a50ab55a96e4603f53c828f7056078d'
     or strpos(d,$transition_old$ elsif op='DECISION_RESERVED' then
  if a.phase<>'STOPPED' or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;$transition_old$)=0
  then raise exception 'FINAL_CONTINUATION_OLD_TRANSITION_MISMATCH'; end if;
  transformed:=replace(d,$transition_old2$ elsif op='DECISION_RESERVED' then
  if a.phase<>'STOPPED' or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;$transition_old2$,$transition_new$ elsif op='DECISION_RESERVED' then
  if not (
    a.phase='STOPPED'
    or (
      a.phase='PENDING'
      and clock_timestamp()>=a.expires_at
      and a.container_id is null
      and p->'body'->>'result'='STALE'
      and not exists(
        select 1 from clued_control.execution_events e
        where e.root_id=root and e.request->>'ga_id'=a.ga_id
      )
    )
  ) or a.decision is not null or coalesce(p->'body'->>'decision_sha256','') !~ '^[0-9a-f]{64}$'
  or coalesce(p->'body'->>'evidence_index_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'decision_reservation_conflict'; end if;$transition_new$);
  execute transformed;
  select encode(digest(p.prosrc,'sha256'),'hex'),
         jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
                            'volatility',p.provolatile,'parallel',p.proparallel,
                            'config',p.proconfig,'acl',p.proacl)
  into observed_sha, after_meta
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_control' and p.proname='execution_transition';
  if observed_sha is distinct from '9ebd313cd6eb9a6040fcc06ef631b96fb7b658a98399a81344b4f1d44be4d7b8'
     or after_meta is distinct from before_meta
  then raise exception 'FINAL_CONTINUATION_NEW_TRANSITION_MISMATCH'; end if;

  -- reserve_execution_budget: one additional fixed 600-second/128-MiB
  -- accounting allocation, with Root3 budgets before 59 and Root4 budgets from 59.
  select pg_get_functiondef(p.oid),
         encode(digest(p.prosrc,'sha256'),'hex'),
         jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
                            'volatility',p.provolatile,'parallel',p.proparallel,
                            'config',p.proconfig,'acl',p.proacl)
  into d, observed_sha, before_meta
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_control' and p.proname='reserve_execution_budget';

  if observed_sha is distinct from 'fd99995cf7b44d93f1fbea189f3de9da02ecb20f3fddfcbaf33205e9be882327'
     or strpos(d,$budget_common_old$ if series_n>3 or series_f>3 or c.charged_seconds is distinct from 5106+600*series_n
 or c.charged_evidence_bytes is distinct from 1127852979::bigint+134217728::bigint*series_n
 or c.charged_seconds>6906 or c.charged_evidence_bytes>1530506163
 then raise exception 'series_exact_charges_or_count_mismatch'; end if;$budget_common_old$)=0
     or strpos(d,$budget_loop_old$  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
  or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  then raise exception 'series_original_budget_scope_required'; end if;$budget_loop_old$)=0
     or strpos(d,'if series_n>=3 or series_count<>series_n')=0
     or strpos(d,'c.charged_seconds+600>7200')=0
     or strpos(d,'c.charged_evidence_bytes+134217728>1530506163')=0
  then raise exception 'FINAL_CONTINUATION_OLD_BUDGET_FUNCTION_MISMATCH'; end if;

  transformed:=replace(d,$budget_common_old2$ if series_n>3 or series_f>3 or c.charged_seconds is distinct from 5106+600*series_n
 or c.charged_evidence_bytes is distinct from 1127852979::bigint+134217728::bigint*series_n
 or c.charged_seconds>6906 or c.charged_evidence_bytes>1530506163
 then raise exception 'series_exact_charges_or_count_mismatch'; end if;$budget_common_old2$,$budget_common_new$ if series_n>4 or series_f>3 or c.charged_seconds is distinct from 5106+600*series_n
 or c.charged_evidence_bytes is distinct from 1127852979::bigint+134217728::bigint*series_n
 or c.charged_seconds>7506 or c.charged_evidence_bytes>1664723891
 then raise exception 'series_exact_charges_or_count_mismatch'; end if;$budget_common_new$);
  transformed:=replace(transformed,$budget_loop_old2$  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
  or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  then raise exception 'series_original_budget_scope_required'; end if;$budget_loop_old2$,$budget_loop_new$  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  or ((series_e->>'sequence')::bigint >= 59 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint < 59 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'))
  then raise exception 'series_original_budget_scope_required'; end if;$budget_loop_new$);
  transformed:=replace(transformed,'if series_n>=3 or series_count<>series_n','if series_n>=4 or series_count<>series_n');
  transformed:=replace(transformed,'c.charged_seconds+600>7200','c.charged_seconds+600>7506');
  transformed:=replace(transformed,'c.charged_evidence_bytes+134217728>1530506163','c.charged_evidence_bytes+134217728>1664723891');
  execute transformed;
  select encode(digest(p.prosrc,'sha256'),'hex'),
         jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
                            'volatility',p.provolatile,'parallel',p.proparallel,
                            'config',p.proconfig,'acl',p.proacl)
  into observed_sha, after_meta
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_control' and p.proname='reserve_execution_budget';
  if observed_sha is distinct from 'e2e8b4de5f6faa5ee7528e98292333d15076dda3006bb1ce61177abe96955fc7'
     or after_meta is distinct from before_meta
  then raise exception 'FINAL_CONTINUATION_NEW_BUDGET_FUNCTION_MISMATCH'; end if;

  -- reserve_gate: same fixed accounting ceiling and generation split.
  select pg_get_functiondef(p.oid),
         encode(digest(p.prosrc,'sha256'),'hex'),
         jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
                            'volatility',p.provolatile,'parallel',p.proparallel,
                            'config',p.proconfig,'acl',p.proacl)
  into d, observed_sha, before_meta
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_control' and p.proname='reserve_gate';

  if observed_sha is distinct from '766a041033ab6650d03045f47f88b5b14cb379c6a400372f12ce696624a37d1b'
     or strpos(d,$gate_common_old$ if series_n>3 or series_f>3 or c.charged_seconds is distinct from 5106+600*series_n
 or c.charged_evidence_bytes is distinct from 1127852979::bigint+134217728::bigint*series_n
 or c.charged_seconds>6906 or c.charged_evidence_bytes>1530506163
 then raise exception 'series_exact_charges_or_count_mismatch'; end if;$gate_common_old$)=0
     or strpos(d,$gate_loop_old$  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  or ((series_e->>'sequence')::bigint = series_latest and (
       series_budget->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint <> series_latest and (
       series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'))
  then raise exception 'series_original_budget_scope_required'; end if;$gate_loop_old$)=0
  then raise exception 'FINAL_CONTINUATION_OLD_GATE_FUNCTION_MISMATCH'; end if;

  transformed:=replace(d,$gate_common_old2$ if series_n>3 or series_f>3 or c.charged_seconds is distinct from 5106+600*series_n
 or c.charged_evidence_bytes is distinct from 1127852979::bigint+134217728::bigint*series_n
 or c.charged_seconds>6906 or c.charged_evidence_bytes>1530506163
 then raise exception 'series_exact_charges_or_count_mismatch'; end if;$gate_common_old2$,$gate_common_new$ if series_n>4 or series_f>3 or c.charged_seconds is distinct from 5106+600*series_n
 or c.charged_evidence_bytes is distinct from 1127852979::bigint+134217728::bigint*series_n
 or c.charged_seconds>7506 or c.charged_evidence_bytes>1664723891
 then raise exception 'series_exact_charges_or_count_mismatch'; end if;$gate_common_new$);
  transformed:=replace(transformed,$gate_loop_old2$  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  or ((series_e->>'sequence')::bigint = series_latest and (
       series_budget->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint <> series_latest and (
       series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'))
  then raise exception 'series_original_budget_scope_required'; end if;$gate_loop_old2$,$gate_loop_new$  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  or ((series_e->>'sequence')::bigint >= 59 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint < 59 and (
       series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'))
  then raise exception 'series_original_budget_scope_required'; end if;$gate_loop_new$);
  execute transformed;
  select encode(digest(p.prosrc,'sha256'),'hex'),
         jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
                            'volatility',p.provolatile,'parallel',p.proparallel,
                            'config',p.proconfig,'acl',p.proacl)
  into observed_sha, after_meta
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_control' and p.proname='reserve_gate';
  if observed_sha is distinct from 'b64c47fda68d4cd64239ab6a3d4f7014cd9445ac6975248e855a2102c09e081b'
     or after_meta is distinct from before_meta
  then raise exception 'FINAL_CONTINUATION_NEW_GATE_FUNCTION_MISMATCH'; end if;

  select to_jsonb(ec) into after_current
  from clued_control.execution_current ec where ec.root_id=root;
  if after_current is distinct from before_current
  then raise exception 'FINAL_CONTINUATION_CONTROL_STATE_CHANGED'; end if;
end
$migration$;

commit;

