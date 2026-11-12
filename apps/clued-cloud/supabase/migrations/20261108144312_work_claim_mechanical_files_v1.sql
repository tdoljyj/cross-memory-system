-- Task 342c: mechanical output paths do not serialize source editing.
-- Native reads the single generated-file list, config/clued-mechanical-files.json,
-- exactly as CI admission publishes it from trusted main. No list literal lives
-- in a migration: changing the list needs no migration and no manual step.
-- Exemptions are restricted to the list's qualified project and repository.
-- Generic resource/glob helpers retain their existing storage/race semantics.
--
--   mechanical_paths: wholly generated; claim conflicts ignore them and a CI
--                     byte proof waives write-set coverage.
--   marker_paths:     hand-written files whose generated lines only may change;
--                     they still conflict, a CI byte proof (generated lines
--                     only) waives coverage.
-- No published row, a digest mismatch or a malformed list: no exemption at all
-- (claims conflict and need full coverage, as without the mechanism).

create table clued_private.work_claim_mechanical_policy_published_v1 (
  singleton boolean primary key default true check (singleton),
  policy_text text not null check (octet_length(policy_text) <= 65536),
  policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  base_committed_at timestamptz not null,
  published_by_binding uuid not null,
  published_at timestamptz not null default clock_timestamp()
);
alter table clued_private.work_claim_mechanical_policy_published_v1 enable row level security;
revoke all on table clued_private.work_claim_mechanical_policy_published_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.work_claim_mechanical_policy_valid_v1(p jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='object'
    and not exists(select 1 from jsonb_object_keys(p) k
      where k not in ('schema','repository','context_keys','mechanical_paths','marker_paths'))
    and p ?& array['schema','repository','context_keys','mechanical_paths']
    and p->'schema'='1'::jsonb
    and jsonb_typeof(p->'repository')='string'
    and (p->>'repository') ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
    and jsonb_typeof(p->'context_keys')='array' and jsonb_array_length(p->'context_keys') between 1 and 64
    and not exists(select 1 from jsonb_array_elements(p->'context_keys') x where jsonb_typeof(x)<>'string'
      or (x#>>'{}') !~ '^project:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
    and jsonb_typeof(p->'mechanical_paths')='array' and jsonb_array_length(p->'mechanical_paths') between 1 and 64
    and not exists(select 1 from jsonb_array_elements(p->'mechanical_paths') x where jsonb_typeof(x)<>'string'
      or (x#>>'{}') !~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*(/\*\*)?$'
      or (x#>>'{}') ~ '(^|/)(\.|\.\.|\.git)(/|$)')
    and (not p ? 'marker_paths' or (jsonb_typeof(p->'marker_paths')='array'
      and jsonb_array_length(p->'marker_paths')<=128
      and not exists(select 1 from jsonb_array_elements(p->'marker_paths') x where jsonb_typeof(x)<>'string'
        or (x#>>'{}') !~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'
        or (x#>>'{}') ~ '(^|/)(\.|\.\.|\.git)(/|$)'))),false)
$$;

-- The published list, or null (conservative) when absent, altered or malformed.
create function clued_private.work_claim_mechanical_policy_v1() returns jsonb
language plpgsql stable set search_path='' as $$
declare r clued_private.work_claim_mechanical_policy_published_v1; p jsonb;
begin
  select * into r from clued_private.work_claim_mechanical_policy_published_v1 where singleton;
  if not found or encode(pg_catalog.sha256(convert_to(r.policy_text,'UTF8')),'hex') is distinct from r.policy_sha256 then
    return null;
  end if;
  begin p:=r.policy_text::jsonb; exception when others then return null; end;
  if not clued_private.work_claim_mechanical_policy_valid_v1(p) then return null; end if;
  return p;
end $$;

-- Whether a qualified path is named by the given sections of the published list.
create function clued_private.work_claim_policy_path_v1(p_path text,p_context text,p_sections text[])
returns boolean language plpgsql stable set search_path='' as $$
declare policy jsonb:=clued_private.work_claim_mechanical_policy_v1();
  resource text[]; value text; pattern text; prefix text; repo text; section text;
begin
  if policy is null or p_context is null or not exists(select 1 from jsonb_array_elements_text(policy->'context_keys') x
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
  foreach section in array p_sections loop
    for pattern in select jsonb_array_elements_text(coalesce(policy->section,'[]'::jsonb)) loop
      if section='mechanical_paths' and right(pattern,3)='/**' then
        prefix:=left(pattern,length(pattern)-3);
        -- Only a literal subtree or a glob wholly below that subtree is exempt.
        if value=prefix or left(value,length(prefix)+1)=prefix||'/' then return true; end if;
      elsif value=pattern then return true;
      end if;
    end loop;
  end loop;
  return false;
end $$;

-- Proof/coverage: either section (CI checked the bytes). Conflicts: wholly generated only.
create function clued_private.work_claim_mechanical_path_v1(p_path text,p_context text)
returns boolean language sql stable set search_path='' as $$
  select clued_private.work_claim_policy_path_v1(p_path,p_context,array['mechanical_paths','marker_paths'])
$$;

create function clued_private.work_claim_without_mechanical_v1(p_paths text[],p_context text)
returns text[] language sql stable set search_path='' as $$
  select coalesce(array_agg(p order by p),'{}'::text[]) from unnest(p_paths) p
    where not clued_private.work_claim_policy_path_v1(p,p_context,array['mechanical_paths'])
$$;

-- CI admission publishes the list of the trusted main commit it runs from.
-- An older commit never replaces a newer one.
create function clued_private.work_claim_mechanical_policy_publish_v1(
  p_binding public.clued_agent_bindings,p_input jsonb
) returns text language plpgsql volatile set search_path='' as $$
declare m jsonb:=p_input->'mechanical_policy'; t text; p jsonb; at timestamptz;
begin
  if jsonb_typeof(m) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(m) k where k not in ('text','sha256','base_sha','base_committed_at'))
      or jsonb_typeof(m->'text') is distinct from 'string' or octet_length(m->>'text')>65536
      or coalesce(m->>'sha256','') !~ '^[0-9a-f]{64}$' or coalesce(m->>'base_sha','') !~ '^[0-9a-f]{40}$'
      or jsonb_typeof(m->'base_committed_at') is distinct from 'string'
      or coalesce(p_input->>'target_branch','') <> 'main' then
    return 'mechanical_policy_invalid';
  end if;
  t:=m->>'text';
  if encode(pg_catalog.sha256(convert_to(t,'UTF8')),'hex')<>m->>'sha256' then return 'mechanical_policy_invalid'; end if;
  begin p:=t::jsonb; at:=(m->>'base_committed_at')::timestamptz; exception when others then return 'mechanical_policy_invalid'; end;
  if not clued_private.work_claim_mechanical_policy_valid_v1(p)
      or lower(split_part(coalesce(p_input->>'pr_ref',''),'#',1)) is distinct from p->>'repository' then
    return 'mechanical_policy_invalid';
  end if;
  insert into clued_private.work_claim_mechanical_policy_published_v1 as w
      (singleton,policy_text,policy_sha256,base_sha,base_committed_at,published_by_binding)
    values(true,t,m->>'sha256',m->>'base_sha',at,p_binding.id)
  on conflict (singleton) do update set policy_text=excluded.policy_text,policy_sha256=excluded.policy_sha256,
      base_sha=excluded.base_sha,base_committed_at=excluded.base_committed_at,
      published_by_binding=excluded.published_by_binding,published_at=clock_timestamp()
    where w.base_committed_at<=excluded.base_committed_at and w.policy_sha256 is distinct from excluded.policy_sha256;
  return null;
end $$;

-- The CI proof gate (already restricted to the CI-admission principal) first
-- publishes, then validates proven literals against the published list.
create function clued_private.work_claim_mechanical_proof_error_v1(
  p_binding public.clued_agent_bindings,p_input jsonb
) returns text language plpgsql volatile set search_path='' as $$
declare policy jsonb; published text;
  scope text:=coalesce(p_input->>'scope','global'); item jsonb; literal text;
begin
  if not (p_input ? 'mechanical_paths_proven') and not (p_input ? 'mechanical_policy') then return null; end if;
  if not exists(select 1 from clued_private.binding_roles_v1 r
      where r.user_id=p_binding.user_id and r.binding_id=p_binding.id
        and r.role='ci-admission' and r.revoked_at is null) then
    return 'ci_binding_required';
  end if;
  if p_input ? 'mechanical_policy' then
    published:=clued_private.work_claim_mechanical_policy_publish_v1(p_binding,p_input);
    if published is not null then return published; end if;
  end if;
  if not (p_input ? 'mechanical_paths_proven') then return null; end if;
  policy:=clued_private.work_claim_mechanical_policy_v1();
  -- Nothing published yet: the proof waives nothing, full coverage applies.
  if policy is null then return null; end if;
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
  clued_private.work_claim_mechanical_policy_valid_v1(jsonb),
  clued_private.work_claim_policy_path_v1(text,text,text[]),
  clued_private.work_claim_mechanical_path_v1(text,text),
  clued_private.work_claim_without_mechanical_v1(text[],text),
  clued_private.work_claim_mechanical_policy_publish_v1(public.clued_agent_bindings,jsonb),
  clued_private.work_claim_mechanical_proof_error_v1(public.clued_agent_bindings,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
