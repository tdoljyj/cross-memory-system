-- Bootstrap claim currentness for the fixed Task's registered Global intent.
-- Resolve actual Global read permission through the same token/Binding before
-- adding that scope. Project-only paths retain their original explicit scope.
-- Preserve all claim, Native grant, fixed targets, M1 and private ACL guards.

do $PATCH$
declare
  src text := pg_get_functiondef(
    'clued_private.model_domain_bootstrap_claim_candidate(text,public.clued_agent_bindings,uuid[])'::regprocedure);
  expected constant text := '7d3f10d850da7288ee206acbd3363507321be00ce9ccb508e0c4a0280d802603';
  declaration_marker constant text :=
    'declare c clued_private.work_claims_v1; admission jsonb; paths jsonb;';
  task_marker constant text :=
    ' if not exists(select 1 from public.clued_memories m where m.id=task and m.user_id=p_binding.user_id';
  fence_marker constant text :=
    'clued_private.record_currentness_fence(p_binding.user_id,m.id,array[s])';
  marker text;
begin
  if encode(extensions.digest(convert_to(src,'UTF8'),'sha256'),'hex')
      is distinct from expected then
    raise exception 'BOOTSTRAP_CLAIM_CONTEXT_SOURCE_CHANGED';
  end if;
  foreach marker in array array[declaration_marker,task_marker,fence_marker] loop
    if (length(src)-length(replace(src,marker,'')))/length(marker) <> 1 then
      raise exception 'BOOTSTRAP_CLAIM_CONTEXT_MARKER_CHANGED';
    end if;
  end loop;
  src := replace(src,declaration_marker,
    declaration_marker || E'\n permitted_scopes text[]; read_binding public.clued_agent_bindings;');
  src := replace(src,task_marker,$SCOPE$
 permitted_scopes:=array[s];
 if exists(select 1 from public.clued_memories m where m.id=task and m.user_id=p_binding.user_id
   and m.record_type='task' and m.lifecycle_status='active' and m.canonical_scope=s
   and m.type_fields->'execution_intent'->>'source_scope'='global') then
  read_binding:=clued_private.resolve_binding_action_v12(p_token_hash,'context:read','global','read');
  if read_binding.id is distinct from p_binding.id or read_binding.user_id is distinct from p_binding.user_id then
   raise exception 'BOOTSTRAP_GLOBAL_READ_BINDING_MISMATCH' using errcode='42501';
  end if;
  permitted_scopes:=array['global',s];
 end if;
$SCOPE$ || task_marker);
  src := replace(src,fence_marker,
    'clued_private.record_currentness_fence(p_binding.user_id,m.id,permitted_scopes)');
  execute src;
end $PATCH$;

notify pgrst,'reload schema';
