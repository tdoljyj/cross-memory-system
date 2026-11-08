-- Task 342c: mechanical output paths do not serialize source editing.
-- Policy below is generated from config/clued-mechanical-files.json. Change
-- that source and regenerate/check the marked block; do not maintain two lists.
-- Exemptions are restricted to the policy's qualified project and repository.
-- Generic resource/glob helpers retain their existing storage/race semantics.

create function clued_private.work_claim_mechanical_policy_v1() returns jsonb
language sql immutable set search_path='' as $policy_function$
-- BEGIN GENERATED MECHANICAL POLICY
  select $mechanical_policy${
  "schema": 1,
  "repository": "tdoljyj/cross-memory-system",
  "context_keys": [
    "project:0597aa60-9b98-4da6-a4ab-63d7705b632f"
  ],
  "mechanical_paths": [
    "config/clued-components.json",
    "apps/clued-cloud/worker/generated/**",
    "scripts/ci/clued-merge-reconcile.mjs",
    "scripts/ci/clued-merge-reconcile-source.json",
    "scripts/ci/clued-independent-publication-port.mjs"
  ]
}$mechanical_policy$::jsonb
-- END GENERATED MECHANICAL POLICY
$policy_function$;

create function clued_private.work_claim_mechanical_path_v1(p_path text,p_context text)
returns boolean language plpgsql immutable set search_path='' as $$
declare policy jsonb:=clued_private.work_claim_mechanical_policy_v1();
  resource text[]; value text; pattern text; prefix text; repo text;
begin
  if p_context is null or not exists(select 1 from jsonb_array_elements_text(policy->'context_keys') x
      where x=p_context) then return false; end if;
  resource:=clued_private.work_claim_resource_split(p_path);
  value:=resource[2];
  if resource[1]='repo' then
    repo:=lower(split_part(value,'/',1)||'/'||split_part(value,'/',2));
    if repo is distinct from policy->>'repository' then return false; end if;
    value:=substr(value,length(split_part(value,'/',1))+length(split_part(value,'/',2))+3);
  elsif resource[1] is not null then return false;
  end if;
  if value is null or value ~ '(^|/)\.\.?(/|$)' then return false; end if;
  for pattern in select jsonb_array_elements_text(policy->'mechanical_paths') loop
    if right(pattern,3)='/**' then
      prefix:=left(pattern,length(pattern)-3);
      -- Only a literal subtree or a glob wholly below that subtree is exempt.
      -- A broader source glob is not silently narrowed to its generated part.
      if value=prefix or left(value,length(prefix)+1)=prefix||'/' then return true; end if;
    elsif value=pattern then return true;
    end if;
  end loop;
  return false;
end $$;

create function clued_private.work_claim_without_mechanical_v1(p_paths text[],p_context text)
returns text[] language sql immutable set search_path='' as $$
  select coalesce(array_agg(p order by p),'{}'::text[]) from unnest(p_paths) p
    where not clued_private.work_claim_mechanical_path_v1(p,p_context)
$$;

-- A path name alone cannot prove that a runtime/configuration file changed
-- mechanically. Only the existing CI-admission principal may supply paths
-- whose exact base/head bytes it has independently checked. The proof is
-- bounded to this qualified repository and to actual changed literal paths.
create function clued_private.work_claim_mechanical_proof_error_v1(
  p_binding public.clued_agent_bindings,p_input jsonb
) returns text language plpgsql stable set search_path='' as $$
declare policy jsonb:=clued_private.work_claim_mechanical_policy_v1();
  scope text:=coalesce(p_input->>'scope','global'); item jsonb; literal text;
begin
  if not (p_input ? 'mechanical_paths_proven') then return null; end if;
  if not exists(select 1 from clued_private.binding_roles_v1 r
      where r.user_id=p_binding.user_id and r.binding_id=p_binding.id
        and r.role='ci-admission' and r.revoked_at is null) then
    return 'ci_binding_required';
  end if;
  if jsonb_typeof(p_input->'mechanical_paths_proven') is distinct from 'array'
      or jsonb_typeof(p_input->'changed_paths') is distinct from 'array' then
    return 'mechanical_paths_proof_invalid';
  end if;
  if jsonb_array_length(p_input->'mechanical_paths_proven')>2000
      or jsonb_typeof(p_input->'pr_ref') is distinct from 'string'
      or coalesce(p_input->>'pr_ref','') !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$'
      or lower(split_part(p_input->>'pr_ref','#',1)) is distinct from policy->>'repository'
      or jsonb_typeof(p_input->'head_sha') is distinct from 'string'
      or coalesce(p_input->>'head_sha','') !~ '^[0-9a-f]{40}$'
      or jsonb_typeof(p_input->'base_sha') is distinct from 'string'
      or coalesce(p_input->>'base_sha','') !~ '^[0-9a-f]{40}$'
      or not exists(select 1 from jsonb_array_elements_text(policy->'context_keys') x where x=scope) then
    return 'mechanical_paths_proof_invalid';
  end if;
  for item in select value from jsonb_array_elements(p_input->'mechanical_paths_proven') loop
    if jsonb_typeof(item) is distinct from 'string' then return 'mechanical_paths_proof_invalid'; end if;
    literal:=item#>>'{}';
    if literal ~ '[*:]' or not clued_private.work_claim_mechanical_path_v1(literal,scope)
        or not (p_input->'changed_paths' @> jsonb_build_array(literal)) then
      return 'mechanical_paths_proof_invalid';
    end if;
  end loop;
  return null;
end $$;

-- Keep same-Task, trigger, race and lease/fence behavior unchanged. Both the
-- existing and proposed write sets are filtered, only when both Tasks are in
-- the same qualified context. Cross-context resources still serialize.
do $mechanical_conflicts$
declare body text; anchor text; replacement text;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_conflicts(uuid,uuid,text[],text[],uuid)'::regprocedure);
  anchor:='v_paths text[]; v_trig text[]; v_sibling boolean; v_same boolean;';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_mechanical_conflicts_declaration_unexpected'; end if;
  body:=replace(body,anchor,anchor||' v_context text;');
  anchor:='for c in select * from clued_private.work_claims_v1 w';
  replacement:=$insert$
  select case when m.project_id is null then 'global' else 'project:'||m.project_id::text end
    into v_context from public.clued_memories m where m.id=p_task_id and m.user_id=p_user_id;
  for c in select * from clued_private.work_claims_v1 w$insert$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_mechanical_conflicts_context_unexpected'; end if;
  body:=replace(body,anchor,replacement);
  anchor:='else clued_private.work_claim_paths_overlap(c.write_set,p_write_set) end;';
  replacement:=$overlap$else case when c.context_key=v_context then
      clued_private.work_claim_paths_overlap(
        clued_private.work_claim_without_mechanical_v1(c.write_set,v_context),
        clued_private.work_claim_without_mechanical_v1(p_write_set,v_context))
      else clued_private.work_claim_paths_overlap(c.write_set,p_write_set) end end;$overlap$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_mechanical_conflicts_overlap_unexpected'; end if;
  execute replace(body,anchor,replacement);
end $mechanical_conflicts$;

-- The complete execution wrapper still performs identity, authorization,
-- currentness and publication checks. Change just its underlying source-path
-- coverage check; all invalid/released claims continue to be refused. Without
-- a validated proof the original full write-set coverage requirement applies.
do $mechanical_coverage$
declare body text; anchor text; replacement text;
begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_verify_before_execution_v1(text,jsonb)'::regprocedure);
  anchor:='if not clued_private.work_claim_path_covered(v_p,c.write_set) then';
  replacement:=$coverage$if not (clued_private.work_claim_mechanical_path_v1(v_p,c.context_key)
      and coalesce(p_input->'mechanical_paths_proven','[]'::jsonb) @> jsonb_build_array(v_p))
      and not clued_private.work_claim_path_covered(v_p,c.write_set) then$coverage$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_mechanical_coverage_source_unexpected'; end if;
  execute replace(body,anchor,replacement);
end $mechanical_coverage$;

-- Validate the optional CI proof before first PR binding, CI metering or
-- execution admission. All pre-existing role/key/head/epoch checks remain in
-- their original order after this additional restrictive gate.
do $mechanical_proof_gate$
declare body text; anchor text; replacement text;
begin
  body:=pg_catalog.pg_get_functiondef('public.clued_work_verify_v1(text,jsonb)'::regprocedure);
  anchor:='result jsonb; executing boolean;';
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_mechanical_proof_declaration_unexpected'; end if;
  body:=replace(body,anchor,anchor||' mechanical_proof_error text;');
  anchor:=$anchor$b:=clued_private.resolve_binding(p_token_hash,'context:read',coalesce(p_input->>'scope','global'));$anchor$;
  replacement:=anchor||$gate$
  mechanical_proof_error:=clued_private.work_claim_mechanical_proof_error_v1(b,p_input);
  if mechanical_proof_error is not null then
    return jsonb_build_object('status','ok','verdict','REJECTED','execution_authorized',false,
      'reasons',jsonb_build_array(mechanical_proof_error));
  end if;$gate$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'work_claim_mechanical_proof_gate_source_unexpected'; end if;
  execute replace(body,anchor,replacement);
end $mechanical_proof_gate$;

revoke all on function clued_private.work_claim_mechanical_policy_v1(),
  clued_private.work_claim_mechanical_path_v1(text,text),
  clued_private.work_claim_without_mechanical_v1(text[],text),
  clued_private.work_claim_mechanical_proof_error_v1(public.clued_agent_bindings,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
