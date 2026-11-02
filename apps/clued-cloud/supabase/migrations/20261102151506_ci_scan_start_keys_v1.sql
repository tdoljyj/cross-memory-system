-- Candidate only. No policy is activated or seeded by this migration.
-- This is a physical scanner-start burn, distinct from publication keys and
-- Stage-1 combination scheduling. A lost reply never grants a second launch.
create table clued_private.ci_scan_start_policies_v1 (
  policy_id uuid primary key default extensions.gen_random_uuid(),
  repository_id bigint not null unique check(repository_id>0),
  repository_owner_id bigint not null check(repository_owner_id>0),
  repository text not null unique check(repository=lower(repository) and repository ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'),
  user_id uuid not null references auth.users(id),
  project_id uuid not null references public.clued_projects(id),
  scope text not null check(scope='project:'||project_id::text),
  source_manifest_sha256 text not null check(source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  registry_sha256 text not null check(registry_sha256 ~ '^[0-9a-f]{64}$'),
  -- Owner server policy: a qualification window is exact-H. NULL is the
  -- separately accepted global mode, never an instruction to activate it.
  hosted_head_sha text constraint ci_scan_start_hosted_head_v1 check(hosted_head_sha is null or hosted_head_sha ~ '^[0-9a-f]{40}$'),
  roles jsonb not null,
  activated_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check(jsonb_typeof(roles)='object' and roles<>'{}'::jsonb)
);
alter table clued_private.ci_scan_start_policies_v1 enable row level security;
revoke all on clued_private.ci_scan_start_policies_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create table clued_private.ci_scan_start_keys_v1 (
  repository_id bigint not null,
  head_sha text not null check(head_sha ~ '^[0-9a-f]{40}$'),
  role text not null check(role in ('gitleaks','trivy','contract-placement')),
  primary key(repository_id,head_sha,role), -- deliberately global, not per tenant/provider/run/Source/claim
  execution_id uuid not null unique,
  policy_id uuid not null references clued_private.ci_scan_start_policies_v1(policy_id),
  user_id uuid not null references auth.users(id),
  scope text not null,
  provider text not null check(provider in ('independent-controller','github-actions')),
  claim_id uuid not null references clued_private.work_claims_v1(claim_id),
  fence bigint not null check(fence>0),
  execution_epoch bigint not null check(execution_epoch>0),
  base_sha text not null check(base_sha ~ '^[0-9a-f]{40}$'),
  source_manifest_sha256 text not null check(source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  registry_sha256 text not null check(registry_sha256 ~ '^[0-9a-f]{64}$'),
  run_id text,
  run_attempt integer,
  token_sha256 text,
  claims_sha256 text,
  request_sha256 text not null check(request_sha256 ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz not null default clock_timestamp(),
  state text not null default 'start_requested' check(state='start_requested'),
  receipt_id uuid not null references public.clued_audit_receipts(id),
  check((provider='independent-controller' and run_id is null and run_attempt is null and token_sha256 is null and claims_sha256 is null)
    or (provider='github-actions' and run_id ~ '^[1-9][0-9]{0,19}$' and run_attempt between 1 and 1000000
      and token_sha256 ~ '^[0-9a-f]{64}$' and claims_sha256 ~ '^[0-9a-f]{64}$'))
);
alter table clued_private.ci_scan_start_keys_v1 enable row level security;
revoke all on clued_private.ci_scan_start_keys_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.ci_scan_start_immutable_v1() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  raise exception 'CI_SCAN_START_IMMUTABLE' using errcode='42501';
end $$;
create trigger ci_scan_start_no_update_delete_v1 before update or delete on clued_private.ci_scan_start_keys_v1
  for each row execute function clued_private.ci_scan_start_immutable_v1();

create function clued_private.ci_scan_start_roles_valid_v1(value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare k text; r jsonb; item jsonb; item_path text; paths text[]:='{}';
  closure_paths text[]; absent_paths text[]; prefixes text[]; workflow_found boolean;
begin
  if jsonb_typeof(value) is distinct from 'object' or value='{}'::jsonb then return false; end if;
  for k,r in select key,val from jsonb_each(value) as e(key,val) loop
    if k not in ('gitleaks','trivy','contract-placement') or jsonb_typeof(r) is distinct from 'object'
      or not(r ?& array['workflow_path','workflow_blob','workflow_sha256','check_name','hosted_allowed','closure','must_not_exist','forbidden_change_prefixes'])
      or r-array['workflow_path','workflow_blob','workflow_sha256','check_name','hosted_allowed','closure','must_not_exist','forbidden_change_prefixes']<>'{}'::jsonb
      or jsonb_typeof(r->'workflow_path') is distinct from 'string'
      or coalesce(r->>'workflow_path','') !~ '^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$'
      or jsonb_typeof(r->'workflow_blob') is distinct from 'string' or coalesce(r->>'workflow_blob','') !~ '^[0-9a-f]{40}$'
      or jsonb_typeof(r->'workflow_sha256') is distinct from 'string' or coalesce(r->>'workflow_sha256','') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(r->'check_name') is distinct from 'string' or length(coalesce(r->>'check_name','')) not between 1 and 100
      or (r->>'check_name') ~ '[[:cntrl:]]'
      or jsonb_typeof(r->'hosted_allowed') is distinct from 'boolean'
      or (k='contract-placement' and r->'hosted_allowed' is distinct from 'false'::jsonb)
      or (r->>'workflow_path')=any(paths) then return false; end if;
    -- Frozen executable/config closure is server-owned. The gateway reads these
    -- pins before burn; neither p_verified nor a caller can supply a new closure.
    if jsonb_typeof(r->'closure') is distinct from 'array'
      or jsonb_typeof(r->'must_not_exist') is distinct from 'array'
      or jsonb_typeof(r->'forbidden_change_prefixes') is distinct from 'array' then return false; end if;
    if jsonb_array_length(r->'closure') not between 1 and 64
      or jsonb_array_length(r->'must_not_exist')>64
      or jsonb_array_length(r->'forbidden_change_prefixes')>64 then return false; end if;
    closure_paths:='{}'; absent_paths:='{}'; prefixes:='{}'; workflow_found:=false;
    for item in select v from jsonb_array_elements(r->'closure') as a(v) loop
      if jsonb_typeof(item) is distinct from 'object'
        or not(item ?& array['path','mode','blob','sha256'])
        or item-array['path','mode','blob','sha256']<>'{}'::jsonb
        or jsonb_typeof(item->'path') is distinct from 'string'
        or length(coalesce(item->>'path','')) not between 1 and 500
        or coalesce(item->>'path','') !~ '^[A-Za-z0-9_.@+-]+(/[A-Za-z0-9_.@+-]+)*$'
        or (item->>'path') ~ '(^|/)\.{1,2}(/|$)'
        or (item->>'path')=any(closure_paths)
        or jsonb_typeof(item->'mode') is distinct from 'string' or (item->>'mode') not in ('100644','100755')
        or jsonb_typeof(item->'blob') is distinct from 'string' or coalesce(item->>'blob','') !~ '^[0-9a-f]{40}$'
        or jsonb_typeof(item->'sha256') is distinct from 'string' or coalesce(item->>'sha256','') !~ '^[0-9a-f]{64}$' then return false; end if;
      closure_paths:=array_append(closure_paths,item->>'path');
      if item->>'path'=r->>'workflow_path' then
        if item->>'mode'<>'100644' or item->>'blob'<>r->>'workflow_blob' or item->>'sha256'<>r->>'workflow_sha256' then return false; end if;
        workflow_found:=true;
      end if;
    end loop;
    if not workflow_found then return false; end if;
    for item in select v from jsonb_array_elements(r->'must_not_exist') as a(v) loop
      item_path:=item #>> '{}';
      if jsonb_typeof(item) is distinct from 'string' or length(coalesce(item_path,'')) not between 1 and 500
        or coalesce(item_path,'') !~ '^[A-Za-z0-9_.@+-]+(/[A-Za-z0-9_.@+-]+)*$'
        or item_path ~ '(^|/)\.{1,2}(/|$)' or item_path=any(absent_paths) or item_path=any(closure_paths) then return false; end if;
      absent_paths:=array_append(absent_paths,item_path);
    end loop;
    for item in select v from jsonb_array_elements(r->'forbidden_change_prefixes') as a(v) loop
      item_path:=item #>> '{}';
      if jsonb_typeof(item) is distinct from 'string' or length(coalesce(item_path,'')) not between 2 and 500
        or coalesce(item_path,'') !~ '^[A-Za-z0-9_.@+-]+(/[A-Za-z0-9_.@+-]+)*/$'
        or item_path ~ '(^|/)\.{1,2}(/|$)' or item_path=any(prefixes) then return false; end if;
      prefixes:=array_append(prefixes,item_path);
    end loop;
    paths:=array_append(paths,r->>'workflow_path');
  end loop;
  return true;
end $$;
alter table clued_private.ci_scan_start_policies_v1 add constraint ci_scan_start_policy_roles_v1
  check(clued_private.ci_scan_start_roles_valid_v1(roles));

-- Policy changes are server-owned, not an Agent-facing registry/activation door.
-- The gateway can read public pins only; it cannot insert or activate policies.
create function public.clued_ci_scan_start_policy_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p clued_private.ci_scan_start_policies_v1; begin
  if jsonb_typeof(p_input) is distinct from 'object' or not(p_input ?& array['repository_id','repository'])
    or p_input-array['repository_id','repository']<>'{}'::jsonb
    or jsonb_typeof(p_input->'repository_id') is distinct from 'number'
    or coalesce(p_input->>'repository_id','') !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_input->'repository') is distinct from 'string' then
    raise exception 'CI_SCAN_START_INPUT_INVALID' using errcode='22023'; end if;
  select * into p from clued_private.ci_scan_start_policies_v1
    where repository_id=(p_input->>'repository_id')::bigint and repository=p_input->>'repository';
  if p.policy_id is null or p.activated_at is null or p.activated_at>clock_timestamp() or p.disabled_at is not null then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_policy_inactive'); end if;
  return jsonb_build_object('status','ok','policy_id',p.policy_id,'repository_id',p.repository_id,'repository',p.repository,
    'repository_owner_id',p.repository_owner_id,
    'scope',p.scope,'source_manifest_sha256',p.source_manifest_sha256,'registry_sha256',p.registry_sha256,'hosted_head_sha',p.hosted_head_sha,'roles',p.roles,
    'activated_at',p.activated_at);
end $$;

-- A serving Worker authenticates a hosted job, not a recoverable Binding secret.
-- Stored cv* credential verifiers are deliberately not usable as raw proof.
-- This private resolver is reachable only through the server-owned policy path.
create function clued_private.ci_scan_start_resolve_principal_v1(p_binding_id uuid,p_required_scope text,p_context_key text)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; begin
  if p_binding_id is null or coalesce(length(p_context_key),0) not between 1 and 160 then
    raise exception 'CI_SCAN_START_PRINCIPAL_INVALID' using errcode='22023'; end if;
  select * into b from public.clued_agent_bindings where id=p_binding_id for share;
  if b.id is null or b.revoked_at is not null or (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp()
    or not(p_required_scope=any(b.scopes)) or not('*'=any(b.context_keys) or p_context_key=any(b.context_keys)) then
    raise exception 'binding_not_authorized' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(b.user_id);
  perform clued_private.authorization_assert_entry_v12(b.id,'scope',p_context_key,'canonical',
    case p_required_scope when 'context:read' then 'read' when 'audit:read' then 'audit' else 'write' end);
  return b;
end $$;

-- Preserve the real current Native full-verification bodies, including private
-- head grants, roles, scope, paths, meters, epochs and fences. Only the credential
-- proof entry changes for the authenticated server-principal sibling; no old
-- function/catalog/ACL is changed. Exact anchors and reverse-byte tests guard it.
do $scan_principal_verify$ declare body text; item record; old_header text; new_header text; anchor text;
  verify_hash text; core_hash text; begin
  for item in select * from (values
    ('clued_private.work_claim_verify_before_execution_v1','clued_private.ci_scan_start_verify_core_principal_v1'),
    ('public.clued_work_verify_v1','clued_private.ci_scan_start_verify_principal_v1')) v(original,replacement) loop
    body:=pg_catalog.pg_get_functiondef((item.original||'(text,jsonb)')::regprocedure);
    old_header:='FUNCTION '||item.original||'(p_token_hash text, p_input jsonb)';
    new_header:='FUNCTION '||item.replacement||'(p_binding_id uuid, p_input jsonb)';
    anchor:='clued_private.resolve_binding(p_token_hash,';
    if (length(body)-length(replace(body,old_header,'')))/length(old_header)<>1
      or (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
      raise exception 'CI_SCAN_START_NATIVE_CLONE_SOURCE_UNEXPECTED'; end if;
    body:=replace(body,old_header,new_header);
    body:=replace(body,anchor,'clued_private.ci_scan_start_resolve_principal_v1(p_binding_id,');
    if item.original='public.clued_work_verify_v1' then
      anchor:='clued_private.work_claim_verify_before_execution_v1(p_token_hash,p_input)';
      if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>2 then
        raise exception 'CI_SCAN_START_NATIVE_CLONE_CORE_UNEXPECTED'; end if;
      body:=replace(body,anchor,'clued_private.ci_scan_start_verify_core_principal_v1(p_binding_id,p_input)');
    end if;
    body:=replace(body,'p_token_hash','p_binding_id');
    execute body;
  end loop;
  select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex') into verify_hash
    from pg_catalog.pg_proc where oid='public.clued_work_verify_v1(text,jsonb)'::regprocedure;
  select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex') into core_hash
    from pg_catalog.pg_proc where oid='clued_private.work_claim_verify_before_execution_v1(text,jsonb)'::regprocedure;
  execute format($source$create function clued_private.ci_scan_start_native_source_current_v1() returns boolean
    language sql stable security definer set search_path='' as $guard$
      select (select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex')
        from pg_catalog.pg_proc where oid='public.clued_work_verify_v1(text,jsonb)'::regprocedure)=%L
      and (select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex')
        from pg_catalog.pg_proc where oid='clued_private.work_claim_verify_before_execution_v1(text,jsonb)'::regprocedure)=%L
    $guard$ $source$,verify_hash,core_hash);
end $scan_principal_verify$;

-- Common transaction; provider is chosen by the authenticated entry, never by caller JSON.
create function clued_private.ci_scan_start_begin_v1(b public.clued_agent_bindings,p clued_private.ci_scan_start_policies_v1,
  data jsonb,scan_role text,provider_name text,p_proof text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.work_claims_v1; consumer clued_private.work_claim_independent_consumer_v1;
  verification jsonb; r uuid; inserted uuid; authorized_at timestamptz; old clued_private.ci_scan_start_keys_v1; pr_ref text;
begin
  if clued_private.ci_scan_start_native_source_current_v1() is distinct from true then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_native_source_changed','launch_allowed',false); end if;
  perform clued_private.work_claim_lock(b.user_id);
  if p.user_id<>b.user_id or p.activated_at is null
    or p.activated_at>clock_timestamp() or p.disabled_at is not null
    or not(p.roles ? scan_role) or p.source_manifest_sha256<>data->>'source_manifest_sha256'
    or p.registry_sha256<>data->>'registry_sha256'
    or not exists(select 1 from public.clued_projects where id=p.project_id and user_id=b.user_id)
    or not exists(select 1 from clued_private.binding_roles_v1 where user_id=b.user_id and binding_id=b.id
      and role='ci-admission' and revoked_at is null and effective_at<=clock_timestamp()) then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_policy_not_current','launch_allowed',false); end if;
  if provider_name='github-actions' and p.hosted_head_sha is not null
    and p.hosted_head_sha is distinct from data->>'head_sha' then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_hosted_head_not_qualified','launch_allowed',false); end if;
  -- The single existing qualified consumer is the execution principal truth.
  -- Pin it for this transaction; a role alone or a caller-supplied Binding
  -- never grants consumer qualification, nor does this door activate one.
  select * into consumer from clued_private.work_claim_independent_consumer_v1 where singleton for share;
  if consumer.activated_at is null or consumer.activated_at>clock_timestamp()
    or consumer.ci_principal_binding_id is distinct from b.id
    or consumer.source_manifest_sha256 is distinct from p.source_manifest_sha256 then
    return jsonb_build_object('status','rejected','error_code','work_claim_independent_consumer_not_qualified','launch_allowed',false); end if;
  pr_ref:=p.repository||'#'||(data->>'pr');
  -- Exactly the existing private-head/paths/current-designated-Binding door; no admission is inferred from OIDC.
  verification:=jsonb_build_object('scope',p.scope,'claim_id',data->>'claim_id',
    'pr_ref',pr_ref,'head_sha',data->>'head_sha','base_sha',data->>'base_sha','target_branch','main','changed_paths',data->'changed_paths');
  if provider_name='independent-controller' then
    verification:=public.clued_work_verify_v1(p_proof,verification);
  else
    verification:=clued_private.ci_scan_start_verify_principal_v1(b.id,verification);
  end if;
  if verification->>'status' is distinct from 'ok' or verification->>'verdict' is distinct from 'ADMITTED'
    or verification->'execution_authorized' is distinct from 'true'::jsonb
    or verification->>'execution_policy' is distinct from 'active' then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_native_refused','launch_allowed',false); end if;
  select * into c from clued_private.work_claims_v1 where claim_id=(data->>'claim_id')::uuid and user_id=b.user_id for update;
  if c.claim_id is null or c.context_key<>p.scope or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp()
    or c.execution_handover_pending or c.fence is distinct from (data->>'fence')::bigint
    or c.execution_epoch is distinct from (data->>'epoch')::bigint or c.bound_pr is distinct from pr_ref
    or verification->>'current_fence' is distinct from data->>'fence'
    or verification->>'execution_epoch' is distinct from data->>'epoch' then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_claim_not_current','launch_allowed',false); end if;
  select * into old from clued_private.ci_scan_start_keys_v1 where repository_id=p.repository_id
    and head_sha=data->>'head_sha' and role=scan_role;
  if old.execution_id is not null then
    return jsonb_build_object('status','consumed','launch_allowed',false,'reason','scan_start_already_consumed',
      'execution_id',old.execution_id,'receipt_id',old.receipt_id); end if;
  r:=clued_private.work_claim_ci_receipt_v1(b,p.scope,'ci_scan_start_requested',c.claim_id,c.execution_epoch,
    jsonb_build_object('repository_id',p.repository_id,'head_sha',data->>'head_sha','role',scan_role,
      'provider',provider_name,'execution_id',data->>'execution_id','request_sha256',clued_private.m1_sha256(data)));
  -- Locks, Native verification and even an audit INSERT can wait. Recheck
  -- deadlines at the final burn boundary; an attempt receipt grants nothing.
  if c.expires_at<=clock_timestamp() then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_claim_not_current','launch_allowed',false); end if;
  if provider_name='github-actions' and ((data->>'expires_at')::timestamptz<=clock_timestamp()
    or (data->>'verified_at')::timestamptz<clock_timestamp()-interval '30 seconds'
    or (data->>'verified_at')::timestamptz>clock_timestamp()+interval '5 seconds') then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_verification_expired','launch_allowed',false); end if;
  insert into clued_private.ci_scan_start_keys_v1(repository_id,head_sha,role,execution_id,policy_id,user_id,scope,provider,
    claim_id,fence,execution_epoch,base_sha,source_manifest_sha256,registry_sha256,run_id,run_attempt,token_sha256,claims_sha256,request_sha256,receipt_id)
    values(p.repository_id,data->>'head_sha',scan_role,(data->>'execution_id')::uuid,p.policy_id,b.user_id,p.scope,provider_name,
      c.claim_id,c.fence,c.execution_epoch,data->>'base_sha',p.source_manifest_sha256,p.registry_sha256,
      data->>'run_id',(data->>'run_attempt')::integer,data->>'token_sha256',data->>'claims_sha256',clued_private.m1_sha256(data),r)
    on conflict do nothing returning execution_id,requested_at into inserted,authorized_at;
  if inserted is null then
    return jsonb_build_object('status','consumed','launch_allowed',false,'reason','scan_start_identity_already_consumed',
      'execution_id',null,'receipt_id',null); end if;
  return jsonb_build_object('status','committed','contract','clued.ci-scan-start-grant/1','launch_allowed',true,
    'execution_id',inserted,'receipt_id',r,'repository_id',p.repository_id,'head_sha',data->>'head_sha','role',scan_role,
    'provider',provider_name,'start_requested_at',to_char(authorized_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end $$;

create function clued_private.ci_scan_start_data_valid_v1(data jsonb) returns boolean
language plpgsql immutable set search_path='' as $$ declare x jsonb; begin
  if jsonb_typeof(data) is distinct from 'object' then return false; end if;
  foreach x in array array[data->'execution_id',data->'claim_id'] loop
    if jsonb_typeof(x) is distinct from 'string' or coalesce(x#>>'{}','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  end loop;
  foreach x in array array[data->'fence',data->'epoch',data->'pr'] loop
    if jsonb_typeof(x) is distinct from 'number' or coalesce(x#>>'{}','') !~ '^[1-9][0-9]{0,14}$' then return false; end if;
  end loop;
  foreach x in array array[data->'head_sha',data->'base_sha'] loop
    if jsonb_typeof(x) is distinct from 'string' or coalesce(x#>>'{}','') !~ '^[0-9a-f]{40}$' then return false; end if;
  end loop;
  foreach x in array array[data->'source_manifest_sha256',data->'registry_sha256'] loop
    if jsonb_typeof(x) is distinct from 'string' or coalesce(x#>>'{}','') !~ '^[0-9a-f]{64}$' then return false; end if;
  end loop;
  if jsonb_typeof(data->'changed_paths') is distinct from 'array' or jsonb_array_length(data->'changed_paths') not between 1 and 5000 then return false; end if;
  for x in select value from jsonb_array_elements(data->'changed_paths') loop
    if jsonb_typeof(x) is distinct from 'string' or length(x#>>'{}') not between 1 and 400
      or (x#>>'{}') ~ '[[:cntrl:]]' then return false; end if;
  end loop;
  return true;
end $$;

create function clued_private.ci_scan_start_local_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; p clued_private.ci_scan_start_policies_v1; begin
  perform clued_private.intake_payload_cap_v1(p_input);
  if not clued_private.ci_scan_start_data_valid_v1(p_input)
    or not(p_input ?& array['action','scope','repository_id','repository','execution_id','claim_id','fence','epoch','pr','head_sha','base_sha','changed_paths','role','source_manifest_sha256','registry_sha256'])
    or p_input-array['action','scope','repository_id','repository','execution_id','claim_id','fence','epoch','pr','head_sha','base_sha','changed_paths','role','source_manifest_sha256','registry_sha256']<>'{}'::jsonb
    or p_input->>'action' is distinct from 'scan_start_independent'
    or jsonb_typeof(p_input->'repository_id') is distinct from 'number' or coalesce(p_input->>'repository_id','') !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_input->'repository') is distinct from 'string'
    or jsonb_typeof(p_input->'scope') is distinct from 'string' or jsonb_typeof(p_input->'role') is distinct from 'string' then
    raise exception 'CI_SCAN_START_INPUT_INVALID' using errcode='22023'; end if;
  b:=clued_private.resolve_binding(p_token_hash,'context:read',p_input->>'scope');
  select * into p from clued_private.ci_scan_start_policies_v1 where user_id=b.user_id and scope=p_input->>'scope'
    and repository_id=(p_input->>'repository_id')::bigint
    and repository=p_input->>'repository' and roles ? (p_input->>'role') for share;
  if p.policy_id is null then return jsonb_build_object('status','rejected','error_code','ci_scan_start_policy_not_current','launch_allowed',false); end if;
  return clued_private.ci_scan_start_begin_v1(b,p,p_input-array['action','scope','role','repository_id','repository'],p_input->>'role','independent-controller',p_token_hash);
end $$;

-- Closed, Worker-authenticated facts. No external user/scope/provider/role/Binding field is accepted.
create function public.clued_ci_scan_start_hosted_v1(p_verified jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare p clued_private.ci_scan_start_policies_v1; b public.clued_agent_bindings;
  consumer clued_private.work_claim_independent_consumer_v1; scan_role text; entry jsonb;
  verified timestamptz; expiry timestamptz; data jsonb; begin
  perform clued_private.intake_payload_cap_v1(p_verified);
  if not clued_private.ci_scan_start_data_valid_v1(p_verified)
    or not(p_verified ?& array['policy_id','execution_id','claim_id','fence','epoch','pr','head_sha','base_sha','changed_paths','source_manifest_sha256','registry_sha256',
      'workflow_path','workflow_blob','workflow_sha256','run_id','run_attempt','token_sha256','claims_sha256','verified_at','expires_at'])
    or p_verified-array['policy_id','execution_id','claim_id','fence','epoch','pr','head_sha','base_sha','changed_paths','source_manifest_sha256','registry_sha256',
      'workflow_path','workflow_blob','workflow_sha256','run_id','run_attempt','token_sha256','claims_sha256','verified_at','expires_at']<>'{}'::jsonb
    or jsonb_typeof(p_verified->'policy_id') is distinct from 'string' or coalesce(p_verified->>'policy_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_verified->'workflow_path') is distinct from 'string'
    or jsonb_typeof(p_verified->'workflow_blob') is distinct from 'string' or coalesce(p_verified->>'workflow_blob','') !~ '^[0-9a-f]{40}$'
    or jsonb_typeof(p_verified->'workflow_sha256') is distinct from 'string' or coalesce(p_verified->>'workflow_sha256','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_verified->'run_id') is distinct from 'string' or coalesce(p_verified->>'run_id','') !~ '^[1-9][0-9]{0,19}$'
    or jsonb_typeof(p_verified->'run_attempt') is distinct from 'number' or coalesce(p_verified->>'run_attempt','') !~ '^[1-9][0-9]{0,5}$'
    or jsonb_typeof(p_verified->'token_sha256') is distinct from 'string' or coalesce(p_verified->>'token_sha256','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_verified->'claims_sha256') is distinct from 'string' or coalesce(p_verified->>'claims_sha256','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_verified->'verified_at') is distinct from 'string' or jsonb_typeof(p_verified->'expires_at') is distinct from 'string' then
    raise exception 'CI_SCAN_START_INPUT_INVALID' using errcode='22023'; end if;
  begin verified:=(p_verified->>'verified_at')::timestamptz; expiry:=(p_verified->>'expires_at')::timestamptz;
  exception when others then raise exception 'CI_SCAN_START_INPUT_INVALID' using errcode='22023'; end;
  if not isfinite(verified) or not isfinite(expiry) or verified>clock_timestamp()+interval '5 seconds'
    or verified<clock_timestamp()-interval '30 seconds' or expiry<=clock_timestamp() or expiry>verified+interval '10 minutes' then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_verification_expired','launch_allowed',false); end if;
  select * into p from clued_private.ci_scan_start_policies_v1 where policy_id=(p_verified->>'policy_id')::uuid for share;
  if p.policy_id is null then return jsonb_build_object('status','rejected','error_code','ci_scan_start_policy_not_current','launch_allowed',false); end if;
  select key,value into scan_role,entry from jsonb_each(p.roles) where value->>'workflow_path'=p_verified->>'workflow_path';
  if scan_role is null or entry->'hosted_allowed' is distinct from 'true'::jsonb
    or entry->>'workflow_blob' is distinct from p_verified->>'workflow_blob'
    or entry->>'workflow_sha256' is distinct from p_verified->>'workflow_sha256' then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_workflow_not_registered','launch_allowed',false); end if;
  perform clued_private.work_claim_lock(p.user_id);
  select * into consumer from clued_private.work_claim_independent_consumer_v1 where singleton for share;
  if consumer.activated_at is null or consumer.activated_at>clock_timestamp()
    or consumer.ci_principal_binding_id is null
    or consumer.source_manifest_sha256 is distinct from p.source_manifest_sha256 then
    return jsonb_build_object('status','rejected','error_code','work_claim_independent_consumer_not_qualified','launch_allowed',false); end if;
  -- Only the current server-qualified consumer supplies the principal. Keep
  -- account, Binding expiry/consent/context and Native role/head verification.
  b:=clued_private.ci_scan_start_resolve_principal_v1(consumer.ci_principal_binding_id,'context:read',p.scope);
  if b.user_id is distinct from p.user_id then
    return jsonb_build_object('status','rejected','error_code','ci_scan_start_policy_not_current','launch_allowed',false); end if;
  data:=p_verified-array['policy_id','workflow_path','workflow_blob','workflow_sha256'];
  return clued_private.ci_scan_start_begin_v1(b,p,data,scan_role,'github-actions',null);
end $$;

-- Add one exact new command; preserve the old command body/ACL and all old cases.
do $scan_dispatch$ declare body text; anchor text:=$a$  if op='publication_begin_independent' then$a$; begin
  body:=pg_catalog.pg_get_functiondef('clued_private.work_claim_ci_command_v1(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'CI_SCAN_START_COMMAND_SOURCE_UNEXPECTED'; end if;
  body:=replace(body,anchor,$a$  if op='scan_start_independent' then
    return clued_private.ci_scan_start_local_v1(p_token_hash,p_input);
  end if;
  if op='publication_begin_independent' then$a$);
  execute body;
end $scan_dispatch$;

-- No new public access to private functions/tables; hosted facts enter only from the serving gateway.
revoke all on function clued_private.ci_scan_start_immutable_v1(),clued_private.ci_scan_start_roles_valid_v1(jsonb),
  clued_private.ci_scan_start_data_valid_v1(jsonb),clued_private.ci_scan_start_local_v1(text,jsonb),
  clued_private.ci_scan_start_resolve_principal_v1(uuid,text,text),
  clued_private.ci_scan_start_native_source_current_v1(),
  clued_private.ci_scan_start_verify_principal_v1(uuid,jsonb),clued_private.ci_scan_start_verify_core_principal_v1(uuid,jsonb),
  clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)
  from public,anon,authenticated,service_role,clued_worker_gateway;
revoke all on function public.clued_ci_scan_start_policy_v1(jsonb),public.clued_ci_scan_start_hosted_v1(jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_ci_scan_start_policy_v1(jsonb),public.clued_ci_scan_start_hosted_v1(jsonb) to clued_worker_gateway;
notify pgrst,'reload schema';
