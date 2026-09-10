-- Minimal corrective migration for the final Root4 gate reservation.
--
-- The original guard correctly validates the two closed historical budgets,
-- but also applies their Root3/old-window fields to the latest pending Root4
-- budget. This migration makes that already-required historical/current split
-- explicit. It does not allocate budget, reserve a gate, run a container, or
-- change any control-plane row.

begin;

do $migration$
declare
  root constant text := 'ctr_414bd3c724264a83894b0c55cf2ab878';
  expected_old_sha constant text := 'b605cd323302739fef4b6bc59c5adb55ad6a0017bf635ee3be6c06ee08db0ac7';
  expected_new_sha constant text := '766a041033ab6650d03045f47f88b5b14cb379c6a400372f12ce696624a37d1b';
  expected_budget_sha constant text := '1deeb3fddfb3619ef17120639bb9f88f99dfa84ada50e5e4f0441e0858ef9e7e';
  before_current jsonb;
  after_current jsonb;
  before_definition text;
  after_definition text;
  before_metadata jsonb;
  after_metadata jsonb;
  before_sha text;
  after_sha text;
  replacement_count integer;
  budget_event clued_control.execution_events;
  budget jsonb;
  old_fragment constant text := $old$  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
  or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  then raise exception 'series_original_budget_scope_required'; end if;$old$;
  new_fragment constant text := $new$  if series_budget->'seconds' is distinct from '600'::jsonb or series_budget->'evidence_bytes' is distinct from '134217728'::jsonb
  or series_budget->>'environment' is distinct from 'ISOLATED_TEST' or series_budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  or ((series_e->>'sequence')::bigint = series_latest and (
       series_budget->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
       or series_budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'))
  or ((series_e->>'sequence')::bigint <> series_latest and (
       series_budget->>'root_generation' is distinct from 'ctrgen_2e778ca66244459f974b081edca8c04e'
       or series_budget->>'expires_at' is distinct from '2026-09-10T10:13:16Z'))
  then raise exception 'series_original_budget_scope_required'; end if;$new$;
begin
  -- Same lock order as the installed budget/gate functions.
  perform 1
  from clued_control.current_head
  where root_id = root
  for share;

  select to_jsonb(ec)
  into before_current
  from clued_control.execution_current ec
  where ec.root_id = root
  for update;

  if before_current->>'sequence' is distinct from '59'
     or before_current->>'pending_budget_sequence' is distinct from '59'
     or before_current->>'active_ga_id' is not null
     or before_current->>'charged_seconds' is distinct from '6906'
     or before_current->>'charged_evidence_bytes' is distinct from '1530506163'
  then
    raise exception 'ROOT4_GATE_FIX_EXECUTION_STATE_MISMATCH';
  end if;

  if (select generation_id from clued_control.current_head where root_id = root)
       is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
     or (select expires_at from clued_control.accepted_binding where root_id = root)
       is distinct from '2026-09-11T10:21:05Z'::timestamptz
  then
    raise exception 'ROOT4_GATE_FIX_ROOT_OR_WINDOW_MISMATCH';
  end if;

  select *
  into budget_event
  from clued_control.execution_events
  where root_id = root and sequence = 59;

  if not found
     or budget_event.request->>'operation' is distinct from 'BUDGET_RESERVED'
     or budget_event.request->'body'->>'sha256' is distinct from expected_budget_sha
     or encode(sha256(convert_to(budget_event.request->'body'->>'raw', 'UTF8')), 'hex')
       is distinct from expected_budget_sha
  then
    raise exception 'ROOT4_GATE_FIX_EXACT_PENDING_BUDGET_MISMATCH';
  end if;

  budget := (budget_event.request->'body'->>'raw')::jsonb;
  if budget->>'root_generation' is distinct from 'ctrgen_9cf53fa5cd0a4a38bd68613493f95b06'
     or budget->>'expires_at' is distinct from '2026-09-11T10:21:05Z'
     or budget->'seconds' is distinct from '600'::jsonb
     or budget->'evidence_bytes' is distinct from '134217728'::jsonb
     or budget->>'environment' is distinct from 'ISOLATED_TEST'
     or budget->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION'
  then
    raise exception 'ROOT4_GATE_FIX_PENDING_BUDGET_SCOPE_MISMATCH';
  end if;

  select
    pg_get_functiondef(p.oid),
    encode(digest(p.prosrc, 'sha256'), 'hex'),
    jsonb_build_object(
      'owner', pg_get_userbyid(p.proowner),
      'security_definer', p.prosecdef,
      'volatility', p.provolatile,
      'parallel', p.proparallel,
      'config', p.proconfig,
      'acl', p.proacl
    )
  into before_definition, before_sha, before_metadata
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'clued_control'
    and p.proname = 'reserve_gate'
    and pg_get_function_identity_arguments(p.oid) = 'p_raw text, p_sha text';

  if before_sha is distinct from expected_old_sha
     or before_metadata->>'owner' is distinct from 'postgres'
     or before_metadata->>'security_definer' is distinct from 'true'
     or before_metadata->>'volatility' is distinct from 'v'
     or before_metadata->>'parallel' is distinct from 'u'
  then
    raise exception 'ROOT4_GATE_FIX_OLD_FUNCTION_MISMATCH';
  end if;

  replacement_count :=
    (length(before_definition) - length(replace(before_definition, old_fragment, '')))
    / length(old_fragment);
  if replacement_count is distinct from 1 then
    raise exception 'ROOT4_GATE_FIX_EXPECTED_ONE_REPLACEMENT';
  end if;

  execute replace(before_definition, old_fragment, new_fragment);

  select
    pg_get_functiondef(p.oid),
    encode(digest(p.prosrc, 'sha256'), 'hex'),
    jsonb_build_object(
      'owner', pg_get_userbyid(p.proowner),
      'security_definer', p.prosecdef,
      'volatility', p.provolatile,
      'parallel', p.proparallel,
      'config', p.proconfig,
      'acl', p.proacl
    )
  into after_definition, after_sha, after_metadata
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'clued_control'
    and p.proname = 'reserve_gate'
    and pg_get_function_identity_arguments(p.oid) = 'p_raw text, p_sha text';

  select to_jsonb(ec)
  into after_current
  from clued_control.execution_current ec
  where ec.root_id = root;

  if after_sha is distinct from expected_new_sha
     or after_definition is distinct from replace(before_definition, old_fragment, new_fragment)
     or after_metadata is distinct from before_metadata
     or after_current is distinct from before_current
  then
    raise exception 'ROOT4_GATE_FIX_POSTCONDITION_MISMATCH';
  end if;
end
$migration$;

commit;
