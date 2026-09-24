-- S2a-1 / BUG-20260924-002: field-level record updates (Owner Decision 8d232ccb).
-- record_mutation_core used to replace mutation.type_fields and mutation.relations
-- wholesale on update, so an update naming one key silently dropped every optional
-- key it did not repeat (and was rejected when it omitted a required one).
--
-- Every operation on an existing record (update, close, restore, reclassify_scope)
-- now merges the top-level keys it sends into the stored object: keys it does not
-- name are kept, a key sent as JSON null is removed, and nested values are replaced
-- as a whole. Required keys are still enforced by m1_validate_record_shape on the
-- merged object. A caller that needs the previous behaviour sends
-- field_mode='replace', which replaces each object it sends and keeps one it omits.
-- Create stores what it is given; field_mode is validated there too.
--
-- The Decision lineage guard is tightened with it: an operation on an existing
-- Decision may no longer change or remove relations.supersedes. Before, any
-- relations edit on a superseding Decision was rejected (and, with merging, would
-- still be), while sending supersedes as null silently dropped the lineage.
--
-- The Information Flow Context Policy acceptance (IF S4) relies on replacement so
-- that the confirmed view digest covers the whole Decision body; its body now
-- declares field_mode='replace' explicitly (M0-D co-sign in the same Decision).
--
-- Both functions are patched in place from their live definitions, following the
-- anchor-count convention of 20260922143312.

create or replace function clued_private.m1_merge_record_object(p_current jsonb, p_patch jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
begin
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then
    raise exception 'invalid_record_shape' using errcode='22023';
  end if;
  return (coalesce(p_current,'{}'::jsonb)
      - coalesce((select array_agg(key) from jsonb_each(p_patch) where value='null'::jsonb),'{}'::text[]))
    || coalesce((select jsonb_object_agg(key,value) from jsonb_each(p_patch) where value<>'null'::jsonb),'{}'::jsonb);
end $$;

revoke all on function clued_private.m1_merge_record_object(jsonb,jsonb) from public,anon,authenticated,service_role;

-- The lineage guard compares supersedes as a set: absent, JSON null and [] are the
-- same empty set, and element order does not matter.
create or replace function clued_private.m1_supersedes_set(p_value jsonb)
returns text language sql immutable set search_path='' as $$
  select case when p_value is null or p_value='null'::jsonb then '[]'
    when jsonb_typeof(p_value)='array' then
      (select coalesce(jsonb_agg(distinct e order by e),'[]'::jsonb) from jsonb_array_elements(p_value) e)::text
    else p_value::text end
$$;

revoke all on function clued_private.m1_supersedes_set(jsonb) from public,anon,authenticated,service_role;

do $migration$
declare body text;
  anchor text:=$anchor$      v_type_fields:=case when v_mutation ? 'type_fields' then v_mutation->'type_fields' else v_record.type_fields end;
      v_relations:=case when v_mutation ? 'relations' then v_mutation->'relations' else v_record.relations end;
$anchor$;
  merged text:=$merged$      -- BUG-20260924-002: an update merges the top-level keys it names into the
      -- stored object (null removes a key); field_mode='replace' keeps the old
      -- wholesale replacement for callers that need it.
      if (p_input ? 'field_mode' and jsonb_typeof(p_input->'field_mode') is distinct from 'string')
         or coalesce(p_input->>'field_mode','merge') not in ('merge','replace') then
        raise exception 'invalid_field_mode' using errcode='22023';
      end if;
      v_type_fields:=case when not (v_mutation ? 'type_fields') then v_record.type_fields
        when p_input->>'field_mode'='replace' then v_mutation->'type_fields'
        else clued_private.m1_merge_record_object(v_record.type_fields,v_mutation->'type_fields') end;
      v_relations:=case when not (v_mutation ? 'relations') then v_record.relations
        when p_input->>'field_mode'='replace' then v_mutation->'relations'
        else clued_private.m1_merge_record_object(v_record.relations,v_mutation->'relations') end;
$merged$;
begin
  body:=pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    then raise exception 'record_update_field_merge_core_definition_mismatch'; end if;
  body:=replace(body,anchor,merged);
  -- Lineage: only clued_decision_supersede may set relations.supersedes.
  anchor:=$anchor$      if v_record_type='decision' and jsonb_array_length(coalesce(v_relations->'supersedes','[]'))>0 and v_relations is distinct from v_record.relations then$anchor$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    then raise exception 'record_update_field_merge_lineage_definition_mismatch'; end if;
  body:=replace(body,anchor,$lineage$      if v_record_type='decision' and clued_private.m1_supersedes_set(v_relations->'supersedes')
        is distinct from clued_private.m1_supersedes_set(v_record.relations->'supersedes') then$lineage$);
  -- field_mode is validated on create as well, where it has no effect.
  anchor:=$anchor$      v_type_fields:=coalesce(v_mutation->'type_fields','{}');$anchor$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    then raise exception 'record_update_field_merge_create_definition_mismatch'; end if;
  body:=replace(body,anchor,$create$      if (p_input ? 'field_mode' and jsonb_typeof(p_input->'field_mode') is distinct from 'string')
         or coalesce(p_input->>'field_mode','merge') not in ('merge','replace') then
        raise exception 'invalid_field_mode' using errcode='22023';
      end if;
$create$||anchor);
  execute body;
end $migration$;

do $migration$
declare body text;
  anchor text:=$anchor$'lifecycle_status','active','scope','global','authority','user_explicit','confidence',null,$anchor$;
begin
  body:=pg_get_functiondef('clued_private.context_policy_view_v1(uuid,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    then raise exception 'record_update_field_merge_policy_definition_mismatch'; end if;
  execute replace(body,anchor,$new$'field_mode','replace',$new$||anchor);
end $migration$;
