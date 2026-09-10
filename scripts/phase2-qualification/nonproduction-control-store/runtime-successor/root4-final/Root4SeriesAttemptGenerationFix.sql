-- Root4 continuation: validate each prior attempt against the root generation
-- attached to its own budget sequence. Historical attempts remain Root3-bound.
begin;

do $migration$
declare
  fn text;
  d text;
  transformed text;
  observed_sha text;
  expected_old_sha text;
  expected_new_sha text;
  before_meta jsonb;
  after_meta jsonb;
  before_current jsonb;
  after_current jsonb;
  root constant text := 'ctr_414bd3c724264a83894b0c55cf2ab878';
begin
  perform 1 from clued_control.current_head where root_id=root for share;
  select to_jsonb(ec) into before_current
  from clued_control.execution_current ec where ec.root_id=root for update;

  foreach fn in array array['reserve_execution_budget','reserve_gate'] loop
    expected_old_sha:=case fn
      when 'reserve_execution_budget' then 'e2e8b4de5f6faa5ee7528e98292333d15076dda3006bb1ce61177abe96955fc7'
      when 'reserve_gate' then 'b64c47fda68d4cd64239ab6a3d4f7014cd9445ac6975248e855a2102c09e081b'
    end;
    expected_new_sha:=case fn
      when 'reserve_execution_budget' then '960e5a64c05174a8fe0f6d90e3aeaa995680d262e94aa3941e6240359cad2bb0'
      when 'reserve_gate' then '8e1a5457a4b37ab3cb54e01d460bfa4dc2edcb0139f64a9d9b19a7124dda2cf5'
    end;

    select pg_get_functiondef(p.oid),
           encode(digest(p.prosrc,'sha256'),'hex'),
           jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
                              'volatility',p.provolatile,'parallel',p.proparallel,
                              'config',p.proconfig,'acl',p.proacl)
    into d, observed_sha, before_meta
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='clued_control' and p.proname=fn;

    if observed_sha is distinct from expected_old_sha then
      raise exception 'ROOT4_SERIES_OLD_FUNCTION_MISMATCH:%',fn;
    end if;

    transformed:=replace(d,$old_ga$if series_ga->>'gate_authorization_id' is distinct from series_a->>'ga_id'
  or series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
  or (series_ga->>'issued_at') is null or (series_ga->>'deadline') is null
  or (series_ga->>'deadline')::timestamptz>'2026-09-10T10:13:16Z'::timestamptz
  or (series_ga->>'deadline')::timestamptz-(series_ga->>'issued_at')::timestamptz>interval '600 seconds'
  then raise exception 'series_original_ga_window_required'; end if;$old_ga$,$new_ga$if series_ga->>'gate_authorization_id' is distinct from series_a->>'ga_id'
  or (series_ga->>'issued_at') is null or (series_ga->>'deadline') is null
  or ((series_a->>'budget_sequence')::bigint >= 59 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or (series_ga->>'deadline')::timestamptz>'2026-09-11T10:21:05Z'::timestamptz))
  or ((series_a->>'budget_sequence')::bigint < 59 and (
       series_ga->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or (series_ga->>'deadline')::timestamptz>'2026-09-10T10:13:16Z'::timestamptz))
  or (series_ga->>'deadline')::timestamptz-(series_ga->>'issued_at')::timestamptz>interval '600 seconds'
  then raise exception 'series_original_ga_window_required'; end if;$new_ga$);

    transformed:=replace(transformed,$old_receipt$if series_receipt->>'result' is distinct from series_a->>'phase'
  or series_receipt->>'gate_authorization_id' is distinct from series_a->>'ga_id'
  or series_receipt->>'gate_authorization_sha256' is distinct from series_a->>'ga_sha256'
  or series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
  then raise exception 'series_terminal_receipt_binding_mismatch'; end if;$old_receipt$,$new_receipt$if series_receipt->>'result' is distinct from series_a->>'phase'
  or series_receipt->>'gate_authorization_id' is distinct from series_a->>'ga_id'
  or series_receipt->>'gate_authorization_sha256' is distinct from series_a->>'ga_sha256'
  or ((series_a->>'budget_sequence')::bigint >= 59 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06')
  or ((series_a->>'budget_sequence')::bigint < 59 and
      series_receipt->>'control_trust_root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e')
  then raise exception 'series_terminal_receipt_binding_mismatch'; end if;$new_receipt$);

    if transformed=d then raise exception 'ROOT4_SERIES_NO_TRANSFORMATION:%',fn; end if;
    execute transformed;

    select encode(digest(p.prosrc,'sha256'),'hex'),
           jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,
                              'volatility',p.provolatile,'parallel',p.proparallel,
                              'config',p.proconfig,'acl',p.proacl)
    into observed_sha, after_meta
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='clued_control' and p.proname=fn;

    if observed_sha is distinct from expected_new_sha or after_meta is distinct from before_meta then
      raise exception 'ROOT4_SERIES_NEW_FUNCTION_MISMATCH:%',fn;
    end if;
  end loop;

  select to_jsonb(ec) into after_current
  from clued_control.execution_current ec where ec.root_id=root;
  if after_current is distinct from before_current then
    raise exception 'ROOT4_SERIES_CONTROL_STATE_CHANGED';
  end if;
end
$migration$;

commit;
