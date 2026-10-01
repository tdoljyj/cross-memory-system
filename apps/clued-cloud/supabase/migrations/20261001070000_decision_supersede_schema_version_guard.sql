-- BUG-20261001-002 (Task 9a86c2a0, fix authorized by Decision 1968807c, F1).
--
-- On 2026-09-30 clued_decision_supersede committed a replacement Decision
-- (326b44b9, receipt 4731e5f5) whose record_schema_version is NULL because the
-- caller omitted replacement.record_schema_version:
--
-- * clued_private.m1_validate_record_shape tested `p_schema_version<>1`. With a
--   NULL argument that predicate is NULL, not true, so no exception was raised
--   (SQL three-valued logic).
-- * clued_private.decision_supersede_core inserted the cast of the missing
--   value, NULL, into record_schema_version.
-- * Every write path (decision_supersede_core, record_mutation_core) selects
--   sources with `record_schema_version is not null`, so the row can never be
--   superseded or updated again (active_decision_required / record_not_found),
--   while the read paths still return it as active and CURRENT.
--
-- This migration changes code only:
-- 1. m1_validate_record_shape rejects a NULL schema version and a NULL record
--    type (`is distinct from`). Every caller shares it: record_mutation_core
--    create and update, decision_supersede_core and the legacy mapping.
-- 2. decision_supersede_core rejects, with a named 22023 rejection receipt and
--    before any source Decision is closed, a replacement that is not an object
--    or lacks scope, a numeric record_schema_version or a valid authority.
--    The RPC entry public.clued_decision_supersede already raises
--    replacement_scope_required before a receipt exists; the core now records
--    the same rejection for the direct-human entry too.
-- The affected production row is not touched here: its repair (F2) needs its
-- own Owner authorization.

create or replace function clued_private.m1_validate_record_shape(
  p_record_type text,p_schema_version integer,p_type_fields jsonb,p_relations jsonb
) returns void language plpgsql immutable set search_path='' as $$
begin
  if p_schema_version is distinct from 1 or p_record_type is null
    or p_record_type not in ('state','task','decision','profile_fact','note') then
    raise exception 'invalid_record_schema' using errcode='22023';
  end if;
  if jsonb_typeof(coalesce(p_type_fields,'{}'))<>'object' or jsonb_typeof(coalesce(p_relations,'{}'))<>'object' then
    raise exception 'invalid_record_shape' using errcode='22023';
  end if;
  if p_record_type='task' and coalesce(p_type_fields->>'execution_bucket','') not in ('now','next','blocked','later') then
    raise exception 'invalid_task_execution_bucket' using errcode='22023';
  elsif p_record_type='decision' and not (p_type_fields ? 'rationale') then
    raise exception 'decision_rationale_required' using errcode='22023';
  elsif p_record_type='state' and not (p_type_fields ? 'state_kind') then
    raise exception 'state_kind_required' using errcode='22023';
  elsif p_record_type='profile_fact' and not (p_type_fields ? 'fact_kind') then
    raise exception 'fact_kind_required' using errcode='22023';
  elsif p_record_type='note' and not (p_type_fields ? 'note_kind') then
    raise exception 'note_kind_required' using errcode='22023';
  end if;
end $$;

-- Patch decision_supersede_core in place (the same anchor technique as
-- 20261001030000_task_dependency_target_guard) so later migrations that
-- redefine other parts of the body are not silently reverted.
do $migration$
declare
  body text;
  anchor text:=$anchor$    if v_repl->>'scope'<>v_scope then raise exception 'decision_scope_mismatch' using errcode='22023'; end if;$anchor$;
  guard text:=$guard$    if jsonb_typeof(v_repl) is distinct from 'object' then raise exception 'replacement_required' using errcode='22023'; end if;
    if nullif(btrim(v_repl->>'scope'),'') is null then raise exception 'replacement_scope_required' using errcode='22023'; end if;
    if jsonb_typeof(v_repl->'record_schema_version') is distinct from 'number' then
      raise exception 'replacement_record_schema_version_required' using errcode='22023';
    end if;
    if (v_repl->>'record_schema_version') !~ '^[0-9]+$' then raise exception 'invalid_record_schema' using errcode='22023'; end if;
    if coalesce(v_repl->>'authority','') not in ('user_explicit','observed','inferred','imported') then
      raise exception 'invalid_authority' using errcode='22023';
    end if;
    if v_repl->>'scope' is distinct from v_scope then raise exception 'decision_scope_mismatch' using errcode='22023'; end if;$guard$;
begin
  body:=pg_get_functiondef('clued_private.decision_supersede_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    or strpos(body,'replacement_record_schema_version_required')>0
    then raise exception 'decision_supersede_core_definition_mismatch'; end if;
  execute replace(body,anchor,guard);
end $migration$;
