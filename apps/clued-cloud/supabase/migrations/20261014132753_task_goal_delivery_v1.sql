-- D01/D02. Opt-in metadata on the existing Canonical Task; no second body/store.
-- Native UI uses the existing M1 core, Storage journal and persisted verification.
create table clued_private.task_goal_delivery_acceptances_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  task_id uuid not null references public.clued_memories(id),
  goal_version text not null check(goal_version ~ '^[0-9a-f]{64}$'),
  completion_digest text not null check(completion_digest ~ '^[0-9a-f]{64}$'),
  accepted_record_version bigint not null check(accepted_record_version>0),
  receipt_id uuid not null unique references public.clued_audit_receipts(id),
  accepted_at timestamptz not null default clock_timestamp()
);
create index task_goal_delivery_acceptance_lookup_v1
  on clued_private.task_goal_delivery_acceptances_v1(owner_id,task_id,goal_version,completion_digest);
create table clued_private.task_goal_delivery_completion_admissions_v1 (
  receipt_id uuid primary key references public.clued_audit_receipts(id),
  transaction_id bigint not null,
  owner_id uuid not null references auth.users(id),
  task_id uuid not null references public.clued_memories(id),
  base_record_version bigint not null check(base_record_version>0),
  scope text not null,
  operation text not null check(operation='close'),
  target_lifecycle text not null check(target_lifecycle='completed'),
  request_sha256 text not null check(request_sha256 ~ '^[0-9a-f]{64}$')
);
alter table clued_private.task_goal_delivery_acceptances_v1 enable row level security;
alter table clued_private.task_goal_delivery_completion_admissions_v1 enable row level security;
revoke all on clued_private.task_goal_delivery_acceptances_v1,
  clued_private.task_goal_delivery_completion_admissions_v1
  from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.task_goal_delivery_audit_immutable_v1()
returns trigger language plpgsql set search_path='' as $$
begin raise exception 'task_goal_delivery_audit_immutable' using errcode='42501'; end $$;
create trigger task_goal_delivery_acceptance_immutable_v1 before update or delete
  on clued_private.task_goal_delivery_acceptances_v1 for each row
  execute function clued_private.task_goal_delivery_audit_immutable_v1();
create trigger task_goal_delivery_admission_immutable_v1 before update or delete
  on clued_private.task_goal_delivery_completion_admissions_v1 for each row
  execute function clued_private.task_goal_delivery_audit_immutable_v1();

create function clued_private.task_goal_delivery_validate_v1(w jsonb)
returns void language plpgsql immutable set search_path='' as $$
declare e jsonb; ids text[]:='{}'; refs text[]:='{}'; conditions text[]:='{}'; n int:=0;
begin
  if jsonb_typeof(w) is distinct from 'object'
    or w-array['contract','goal','scope','completion_level','input_versions','acceptance_mode','conditions','deliverables','delivery_refs']<>'{}'
    or w->>'contract' is distinct from 'clued.task-goal-delivery/1'
    or jsonb_typeof(w->'goal') is distinct from 'string' or length(btrim(w->>'goal')) not between 1 and 4000
    or jsonb_typeof(w->'scope') is distinct from 'string' or length(btrim(w->>'scope')) not between 1 and 4000
    or coalesce(w->>'completion_level','') not in ('artifact','business_effect','physical_effect')
    or coalesce(w->>'acceptance_mode','') not in ('machine','owner')
    or jsonb_typeof(w->'input_versions') is distinct from 'array'
    or jsonb_typeof(w->'conditions') is distinct from 'array'
    or jsonb_typeof(w->'deliverables') is distinct from 'array'
    or jsonb_typeof(w->'delivery_refs') is distinct from 'array' then
    raise exception 'task_workflow_invalid' using errcode='22023';
  end if;
  if jsonb_array_length(w->'input_versions')>16 or jsonb_array_length(w->'delivery_refs')>16
    or jsonb_array_length(w->'conditions') not between 1 and 16
    or jsonb_array_length(w->'deliverables') not between 1 and 16 then
    raise exception 'task_workflow_invalid' using errcode='22023';
  end if;
  for e in select value from jsonb_array_elements(w->'deliverables') loop
    if jsonb_typeof(e) is distinct from 'object'
      or e-array['id','label','required','path','mime_type','sha256']<>'{}'
      or jsonb_typeof(e->'id') is distinct from 'string'
      or coalesce(e->>'id','') !~ '^[A-Za-z0-9_.-]{1,80}$' or e->>'id'=any(ids)
      or jsonb_typeof(e->'label') is distinct from 'string' or length(btrim(e->>'label')) not between 1 and 200
      or jsonb_typeof(e->'required') is distinct from 'boolean'
      or (e ? 'path' and (jsonb_typeof(e->'path') is distinct from 'string' or length(e->>'path') not between 1 and 1000))
      or (e ? 'mime_type' and (jsonb_typeof(e->'mime_type') is distinct from 'string' or length(e->>'mime_type') not between 3 and 255))
      or (e ? 'sha256' and (jsonb_typeof(e->'sha256') is distinct from 'string' or e->>'sha256' !~ '^[0-9a-f]{64}$')) then
      raise exception 'task_workflow_invalid' using errcode='22023';
    end if;
    ids:=array_append(ids,e->>'id'); if (e->>'required')::boolean then n:=n+1; end if;
  end loop;
  if n=0 then raise exception 'task_workflow_required_delivery_missing' using errcode='22023'; end if;
  for e in select value from jsonb_array_elements(w->'conditions') loop
    if jsonb_typeof(e) is distinct from 'object' or e-array['id','kind','text','deliverable_id']<>'{}'
      or jsonb_typeof(e->'id') is distinct from 'string'
      or coalesce(e->>'id','') !~ '^[A-Za-z0-9_.-]{1,80}$' or e->>'id'=any(conditions)
      or jsonb_typeof(e->'text') is distinct from 'string' or length(btrim(e->>'text')) not between 1 and 1000
      or coalesce(e->>'kind','') not in ('file_integrity','owner_review')
      or (e->>'kind'='file_integrity' and (jsonb_typeof(e->'deliverable_id') is distinct from 'string' or not coalesce(e->>'deliverable_id'=any(ids),false)))
      or (e->>'kind'='owner_review' and (w->>'acceptance_mode'<>'owner' or e ? 'deliverable_id')) then
      raise exception 'task_workflow_invalid' using errcode='22023';
    end if;
    conditions:=array_append(conditions,e->>'id');
  end loop;
  for e in select value from jsonb_array_elements(w->'input_versions') loop
    if jsonb_typeof(e) is distinct from 'object' or e-array['label','kind','version','id','scope']<>'{}'
      or jsonb_typeof(e->'label') is distinct from 'string' or length(btrim(e->>'label')) not between 1 and 200
      or coalesce(e->>'kind','') not in ('record','artifact','declared') then
      raise exception 'task_workflow_invalid' using errcode='22023'; end if;
    if e->>'kind'='declared' then
      if w->>'acceptance_mode'<>'owner' or e ?| array['id','scope']
        or jsonb_typeof(e->'version') is distinct from 'string' or length(btrim(e->>'version')) not between 1 and 200 then
        raise exception 'task_workflow_declared_input_requires_owner' using errcode='22023'; end if;
    elsif jsonb_typeof(e->'version') is distinct from 'number'
      or coalesce(e->>'version','') !~ '^[1-9][0-9]{0,15}$'
      or coalesce(e->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (e->>'kind'='record' and (jsonb_typeof(e->'scope') is distinct from 'string'
        or (e->>'scope' not in ('global','profile') and e->>'scope' !~ '^project:[0-9a-f-]{36}$')))
      or (e->>'kind'='artifact' and e ? 'scope') then
      raise exception 'task_workflow_invalid' using errcode='22023';
    end if;
  end loop;
  for e in select value from jsonb_array_elements(w->'delivery_refs') loop
    if jsonb_typeof(e) is distinct from 'object' or e-array['deliverable_id','job_id','goal_version']<>'{}'
      or jsonb_typeof(e->'deliverable_id') is distinct from 'string'
      or coalesce(e->>'deliverable_id','') !~ '^[A-Za-z0-9_.-]{1,80}$' or e->>'deliverable_id'=any(refs)
      or coalesce(e->>'job_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(e->'goal_version') is distinct from 'string'
      or coalesce(e->>'goal_version','') !~ '^[0-9a-f]{64}$' then
      raise exception 'task_workflow_invalid' using errcode='22023'; end if;
    refs:=array_append(refs,e->>'deliverable_id');
  end loop;
end $$;

create function clued_private.task_goal_delivery_goal_v1(t public.clued_memories)
returns text language sql immutable set search_path='' as $$
  select clued_private.m1_sha256(jsonb_build_object('task_id',t.id,'canonical_scope',t.canonical_scope,
    'title',t.title,'content',t.content,'definition',(t.type_fields->'task_workflow')-'delivery_refs'))
$$;
create function clued_private.task_goal_delivery_metadata_v1(t public.clued_memories)
returns jsonb language sql immutable set search_path='' as $$
  select case when t.record_type='task' and t.record_schema_version=1 and t.type_fields ? 'task_workflow'
    then jsonb_build_object('goal_version',clued_private.task_goal_delivery_goal_v1(t),
      'definition',(t.type_fields->'task_workflow')-'delivery_refs','delivery_refs',t.type_fields->'task_workflow'->'delivery_refs') end
$$;

create function clued_private.task_goal_delivery_scope_read_v1(p_owner uuid,p_binding uuid,p_scope text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  if p_scope like 'project:%' and not exists(select 1 from public.clued_projects
    where id=substring(p_scope from 9)::uuid and user_id=p_owner
      and coalesce(lifecycle_status,'active')='active' and dismissed_at is null and merged_into_project_id is null) then return false; end if;
  if p_binding is null then return p_scope in ('global','profile') or p_scope like 'project:%'; end if;
  select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_owner
    and revoked_at is null and (expires_at is null or expires_at>clock_timestamp());
  if not found then return false; end if;
  if exists(select 1 from clued_private.authorizations_v12 where binding_id=b.id) then
    return coalesce('read'=any(clued_private.authorization_effective_actions_v13(b.id,'scope',p_scope,'canonical')),false);
  end if;
  return 'context:read'=any(b.scopes) and ('*'=any(b.context_keys) or p_scope=any(b.context_keys));
exception when others then return false;
end $$;

-- Task read access never implies Storage metadata/read or job-inspect access.
-- Use the existing grant evaluators, including all Owner denies and active
-- policy/read generations. A short lock timeout avoids M1/root-order inversion.
create function clued_private.task_goal_delivery_storage_read_v1(
  p_owner uuid,p_binding uuid,p_connection uuid,p_job uuid
) returns boolean language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; proof text; inspected jsonb; read_grant jsonb;
  previous_timeout text:=current_setting('lock_timeout');
begin
  if p_binding is null then return false; end if;
  select * into b from public.clued_agent_bindings where id=p_binding and user_id=p_owner and revoked_at is null;
  if not found then return false; end if;
  perform set_config('lock_timeout','100ms',true);
  begin
    proof:=clued_private.credential_internal_proof_v1(b.token_hash);
    read_grant:=clued_private.storage_read_evaluate_v1(proof,p_connection,'read');
    inspected:=clued_private.storage_policy_evaluate_v2(proof,p_connection,'inspect',p_job);
    if read_grant->>'owner_id' is distinct from p_owner::text
      or read_grant->>'binding_id' is distinct from p_binding::text
      or read_grant->>'connection_id' is distinct from p_connection::text
      or read_grant->>'class' is distinct from 'read'
      or inspected->>'owner_id' is distinct from p_owner::text
      or inspected->>'binding_id' is distinct from p_binding::text
      or inspected->>'connection_id' is distinct from p_connection::text
      or not coalesce(inspected->'actions' @> '["inspect"]'::jsonb,false) then
      raise exception 'task_storage_read_unavailable' using errcode='42501'; end if;
  exception when others then
    perform set_config('lock_timeout',previous_timeout,true); return false;
  end;
  perform set_config('lock_timeout',previous_timeout,true); return true;
end $$;

create function clued_private.task_goal_delivery_file_v1(
  p_owner uuid,p_scope text,p_binding uuid,p_ref jsonb,p_expected jsonb,p_goal text,p_lock boolean default false
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; m clued_private.resource_center_mutations_v1;
  p clued_private.resource_center_profiles_v1; c clued_private.storage_connections_v1;
  a clued_private.resource_center_artifacts_v1; saved jsonb; proof jsonb; after_content jsonb;
  out jsonb:=jsonb_build_object('deliverable_id',p_expected->>'id','job_id',p_ref->>'job_id');
  v_scope text; v_hash text; v_size text; v_mime text; v_req jsonb; r public.clued_audit_receipts;
begin
  if p_ref is null then return out||jsonb_build_object('status','pending','reason','delivery_missing'); end if;
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=(p_ref->>'job_id')::uuid;
  if not found then return out||jsonb_build_object('status','unknown','reason','delivery_unavailable'); end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=(select profile_id
    from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner) and user_id=p_owner;
  v_scope:='project:'||p.project_id::text;
  if p.id is null or (p_scope<>'global' and p_scope<>v_scope)
    or not clued_private.task_goal_delivery_scope_read_v1(p_owner,p_binding,v_scope)
    or (p_binding is not null and not clued_private.task_goal_delivery_storage_read_v1(p_owner,p_binding,j.connection_id,j.job_id)) then
    return jsonb_build_object('deliverable_id',p_expected->>'id','status','unknown','reason','delivery_unavailable'); end if;
  if p_ref->>'goal_version' is distinct from p_goal then return out||jsonb_build_object('status','stale','reason','delivery_goal_changed'); end if;
  out:=out||jsonb_build_object('connection_id',j.connection_id);
  -- Same provider-root fence as Storage, then source rows; never network I/O.
  if p_lock then
    if not pg_try_advisory_xact_lock(hashtextextended(p_owner::text||':'||p.root_folder_id,0)) then
      return out||jsonb_build_object('status','unknown','reason','delivery_source_busy'); end if;
    perform 1 from clued_private.resource_center_profiles_v1 where id=p.id for share nowait;
    perform 1 from clued_private.storage_connections_v1 where id=j.connection_id for share nowait;
    perform 1 from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=j.job_id for share nowait;
  end if;
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=p.id and user_id=p_owner;
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=j.job_id;
  if p.state<>'active' or c.state<>'active' or c.revoked_at is not null or c.profile_version<>p.version
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,c.source_decision_id) then
    return out||jsonb_build_object('status','stale','reason','delivery_authority_changed'); end if;
  if j.intent_id is null then return out||jsonb_build_object('status','pending','reason','delivery_not_settled'); end if;
  if p_lock then perform 1 from clued_private.resource_center_mutations_v1 where id=j.intent_id for share nowait; end if;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner and profile_id=p.id;
  if m.id is null then return out||jsonb_build_object('status','unknown','reason','delivery_proof_missing'); end if;
  if m.state in ('prepared','started','uncertain') then return out||jsonb_build_object('status','pending','reason','delivery_not_settled'); end if;
  if m.state<>'committed' then return out||jsonb_build_object('status','rejected','reason','delivery_not_committed'); end if;
  saved:=m.verified_result_v2; proof:=saved->'proof';
  if saved is null or saved->>'contract' is distinct from 'clued.storage-persisted-verification/2'
    or m.verified_digest_v2 is distinct from clued_private.m1_sha256(saved)
    or saved->>'owner_id' is distinct from p_owner::text or saved->>'connection_id' is distinct from c.id::text
    or saved->>'job_id' is distinct from j.job_id::text or saved->>'intent_id' is distinct from m.id::text
    or saved->>'job_request_digest' is distinct from j.request_digest
    or saved->>'submit_receipt_id' is distinct from j.receipt_id::text
    or saved->>'request_sha256' is distinct from m.request_sha256
    or jsonb_typeof(saved->'recorded_at') is distinct from 'string'
    or saved->>'exact_request_digest' is distinct from clued_private.m1_sha256(m.exact_request)
    or saved->>'authority_request_digest' is distinct from clued_private.m1_sha256(m.authority_request)
    or saved->'authority_snapshot' is distinct from j.authority_snapshot_v2
    or saved->'authority_result' is distinct from m.authority_result
    or saved->'provider_attempt' is distinct from m.provider_attempt
    or saved->>'provider_attempt_receipt_id' is distinct from m.provider_attempt_receipt_id::text
    or saved->>'writer_binding_id' is distinct from m.writer_binding_id::text
    or coalesce(saved->>'intent_version','') !~ '^[1-9][0-9]*$'
    or m.version<>(saved->>'intent_version')::bigint+1
    or coalesce(j.mutation->>'target_kind','')<>'file'
    or coalesce(proof->>'contract','') not in ('clued.storage-create-verified/2','clued.storage-create-verified/3','clued.storage-replace-verified/1')
    or proof->'checks'->'identity' is distinct from 'true'::jsonb
    or proof->'checks'->'content' is distinct from 'true'::jsonb
    or proof->'checks'->'ancestors' is distinct from 'true'::jsonb then
    return out||jsonb_build_object('status','unknown','reason','delivery_proof_invalid'); end if;
  if proof->>'contract'='clued.storage-replace-verified/1' then
    after_content:=proof->'content_after';
    if j.mutation->>'operation'<>'replace' or proof->'checks'->'stable_state' is distinct from 'true'::jsonb then
      return out||jsonb_build_object('status','unknown','reason','delivery_proof_invalid'); end if;
  else
    after_content:=proof;
    if j.mutation->>'operation'<>'create' or proof->'checks'->'stable_version' is distinct from 'true'::jsonb then
      return out||jsonb_build_object('status','unknown','reason','delivery_proof_invalid'); end if;
  end if;
  v_hash:=after_content->>'sha256'; v_size:=after_content->>'size';
  v_mime:=case when proof->'checks'->'mime_type'='true'::jsonb then proof->>'mime_type' end;
  if coalesce(v_hash,'') !~ '^[0-9a-f]{64}$' or coalesce(v_size,'') !~ '^(0|[1-9][0-9]{0,18})$'
    or coalesce(proof->>'provider_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
    or coalesce(proof->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$'
    or jsonb_typeof(proof->'path') is distinct from 'string'
    or proof->>'path' is distinct from j.mutation->>'destination_path' then
    return out||jsonb_build_object('status','unknown','reason','delivery_proof_invalid'); end if;
  if (j.mutation ? 'content' and (v_hash is distinct from encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex')
      or v_size is distinct from octet_length(j.mutation->>'content')::text))
    or (j.mutation ? 'content_ref' and (v_hash is distinct from j.mutation->'content_ref'->>'sha256'
      or v_size is distinct from j.mutation->'content_ref'->>'size')) then
    return out||jsonb_build_object('status','unknown','reason','delivery_proof_invalid'); end if;
  v_req:=jsonb_build_object('idempotency_key','storage-verified:'||m.id::text,'intent_id',m.id,'verified_digest',m.verified_digest_v2);
  select * into r from public.clued_audit_receipts where id=m.verified_receipt_id_v2 and user_id=p_owner
    and status='committed' and operation='storage_verified_record';
  if not found or r.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_verified_record','payload',v_req-'idempotency_key'))
    or r.received_payload_hash is distinct from clued_private.m1_sha256(v_req)
    or r.canonical_result is null or r.response_hash is distinct from clued_private.m1_sha256(r.canonical_result) then
    return out||jsonb_build_object('status','unknown','reason','delivery_receipt_invalid'); end if;
  v_req:=jsonb_build_object('idempotency_key','storage-settle-verified:'||m.id::text,'intent_id',m.id,'verified_digest',m.verified_digest_v2);
  select * into r from public.clued_audit_receipts where id=m.receipt_id and user_id=p_owner and status='committed'
    and operation='storage_verified_settle';
  if not found or r.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_verified_settle','payload',v_req-'idempotency_key'))
    or r.received_payload_hash is distinct from clued_private.m1_sha256(v_req)
    or r.canonical_result is null or r.response_hash is distinct from clued_private.m1_sha256(r.canonical_result)
    or m.final_result->>'status' is distinct from 'committed' then
    return out||jsonb_build_object('status','unknown','reason','delivery_receipt_invalid'); end if;
  if p_lock then perform 1 from clued_private.resource_center_artifacts_v1 where profile_id=p.id and path=proof->>'path' for share nowait; end if;
  select * into a from clued_private.resource_center_artifacts_v1 where user_id=p_owner and profile_id=p.id
    and path=proof->>'path' and provider_file_id=proof->>'provider_file_id' and state='active' and target_kind='file';
  if not found or a.provider_file_version is distinct from proof->>'provider_file_version'
    or a.receipt_id::text is distinct from m.final_result->>'receipt_id'
    or not coalesce(m.final_result->'target_refs' @> jsonb_build_array(jsonb_build_object('id',a.id,'role','primary')),false)
    or not clued_private.resource_center_path_current_v1(p_owner,p.project_id,p.id,p.managed_root,a.path)
    or not exists(select 1 from public.clued_audit_receipts where id=a.receipt_id and user_id=p_owner
      and status='committed' and operation='resource_center_admin' and response_hash=clued_private.m1_sha256(canonical_result)) then
    return out||jsonb_build_object('status','stale','reason','delivery_registry_changed'); end if;
  out:=out||jsonb_build_object('artifact_id',a.id,'artifact_version',a.version,'path',a.path,
    'provider_file_id',a.provider_file_id,'provider_file_version',a.provider_file_version,
    'sha256',v_hash,'size',v_size::bigint,'mime_type',v_mime,'receipt_id',m.receipt_id,'registration_receipt_id',a.receipt_id,
    'verified_receipt_id',m.verified_receipt_id_v2,'verified_digest',m.verified_digest_v2,
    'link','https://drive.google.com/file/d/'||a.provider_file_id||'/view','verified_at',(saved->>'recorded_at')::timestamptz,
    'verification_scope','persisted_storage_and_current_registry');
  if (p_expected ? 'path' and p_expected->>'path'<>a.path)
    or (p_expected ? 'sha256' and p_expected->>'sha256'<>v_hash) then
    return out||jsonb_build_object('status','rejected','reason','delivery_expectation_mismatch'); end if;
  if p_expected ? 'mime_type' and p_expected->>'mime_type' is distinct from v_mime then
    return out||jsonb_build_object('status','rejected','reason',case when v_mime is null then 'delivery_mime_unknown' else 'delivery_mime_mismatch' end); end if;
  return out||jsonb_build_object('status','verified');
exception when lock_not_available then return out||jsonb_build_object('status','unknown','reason','delivery_source_busy');
  when others then return out||jsonb_build_object('status','unknown','reason','delivery_verification_unavailable');
end $$;

create function clued_private.task_goal_delivery_projection_v1(
  p_owner uuid,t public.clued_memories,p_binding uuid default null,p_lock boolean default false
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare w jsonb:=t.type_fields->'task_workflow'; goal text; e jsonb; ref jsonb; d jsonb;
  deliveries jsonb:='[]'; inputs jsonb:='[]'; reasons jsonb:='[]'; limitations jsonb:='[]';
  input_state text; r public.clued_memories; a clued_private.resource_center_artifacts_v1;
  p clued_private.resource_center_profiles_v1; acceptance uuid; digest text; ready boolean; needed boolean; target_scope text;
begin
  if w is null then return null; end if;
  perform clued_private.task_goal_delivery_validate_v1(w); goal:=clued_private.task_goal_delivery_goal_v1(t);
  if t.lifecycle_status is distinct from 'active' or clued_private.record_currentness_fence(p_owner,t.id,array[t.canonical_scope]) is distinct from 'CURRENT' then
    reasons:=reasons||jsonb_build_array('task_not_current'); end if;
  if w->>'completion_level'<>'artifact' then reasons:=reasons||jsonb_build_array('completion_level_unsupported'); end if;
  for e in select value from jsonb_array_elements(w->'input_versions') loop
    input_state:='unknown';
    if e->>'kind'='declared' then
      limitations:=limitations||jsonb_build_array('input_declared_unverified:'||(e->>'label')); input_state:='declared_unverified';
    elsif e->>'kind'='record' then
      select * into r from public.clued_memories where id=(e->>'id')::uuid and user_id=p_owner and record_schema_version=1;
      if r.id is not null and r.id<>t.id and r.canonical_scope=e->>'scope'
        and clued_private.task_goal_delivery_scope_read_v1(p_owner,p_binding,r.canonical_scope)
        and r.version::text=e->>'version'
        and clued_private.record_currentness_fence(p_owner,r.id,array[r.canonical_scope])='CURRENT' then input_state:='verified'; end if;
    else
      if p_lock then
        begin perform 1 from clued_private.resource_center_artifacts_v1 where id=(e->>'id')::uuid and user_id=p_owner for share nowait;
        exception when lock_not_available then reasons:=reasons||jsonb_build_array('input_source_busy:'||(e->>'label')); end;
      end if;
      select * into a from clued_private.resource_center_artifacts_v1 where id=(e->>'id')::uuid and user_id=p_owner and state='active';
      select * into p from clued_private.resource_center_profiles_v1 where id=a.profile_id and user_id=p_owner and state='active';
      target_scope:='project:'||p.project_id::text;
      if a.id is not null and p.id is not null and (t.canonical_scope='global' or t.canonical_scope=target_scope)
        and clued_private.task_goal_delivery_scope_read_v1(p_owner,p_binding,target_scope)
        and a.version::text=e->>'version'
        and clued_private.resource_center_path_current_v1(p_owner,p.project_id,p.id,p.managed_root,a.path) then input_state:='verified'; end if;
    end if;
    inputs:=inputs||jsonb_build_array(e||jsonb_build_object('qualification',input_state));
    if input_state='unknown' then reasons:=reasons||jsonb_build_array('input_version_unverified:'||(e->>'label')); end if;
  end loop;
  for e in select value from jsonb_array_elements(w->'deliverables') order by value->>'id' loop
    select value into ref from jsonb_array_elements(w->'delivery_refs') where value->>'deliverable_id'=e->>'id';
    d:=clued_private.task_goal_delivery_file_v1(p_owner,t.canonical_scope,p_binding,ref,e,goal,p_lock);
    deliveries:=deliveries||jsonb_build_array(d);
    needed:=(e->>'required')::boolean or exists(select 1 from jsonb_array_elements(w->'conditions') x
      where x->>'kind'='file_integrity' and x->>'deliverable_id'=e->>'id');
    if needed and d->>'status'<>'verified' then reasons:=reasons||jsonb_build_array(coalesce(d->>'reason','delivery_unverified')||':'||(e->>'id')); end if;
  end loop;
  digest:=clued_private.m1_sha256(jsonb_build_object('goal_version',goal,'inputs',inputs,'deliveries',deliveries));
  ready:=jsonb_array_length(reasons)=0;
  select x.receipt_id into acceptance from clued_private.task_goal_delivery_acceptances_v1 x
    join public.clued_audit_receipts ar on ar.id=x.receipt_id and ar.user_id=p_owner and ar.status='committed'
      and ar.operation_family='task_goal_delivery_owner' and ar.response_hash=clued_private.m1_sha256(ar.canonical_result)
    where x.owner_id=p_owner and x.task_id=t.id and x.goal_version=goal and x.completion_digest=digest
    order by x.accepted_at desc,x.id desc limit 1;
  if ready and w->>'acceptance_mode'='owner' and acceptance is null then reasons:=reasons||jsonb_build_array('owner_acceptance_required'); end if;
  return jsonb_build_object('contract',w->'contract','goal_version',goal,'definition',w-'delivery_refs',
    'delivery_refs',w->'delivery_refs','deliveries',deliveries,'inputs',inputs,
    'completion',jsonb_build_object('ready_for_acceptance',ready,'eligible',ready and (w->>'acceptance_mode'='machine' or acceptance is not null),
      'reasons',reasons,'limitations',limitations,'completion_digest',digest,'owner_accepted',acceptance is not null,'acceptance_receipt_id',acceptance));
end $$;

-- Locator metadata only for an actual admitted Agent Binding. Every linked
-- source is rechecked with that Binding; null never becomes an Owner bypass.
create function clued_private.task_goal_delivery_agent_metadata_v1(
  p_owner uuid,p_binding uuid,t public.clued_memories
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare metadata jsonb:=clued_private.task_goal_delivery_metadata_v1(t); files jsonb:='[]'; e jsonb; ref jsonb; d jsonb;
begin
  if metadata is null or p_binding is null then return metadata; end if;
  if not clued_private.task_goal_delivery_scope_read_v1(p_owner,p_binding,t.canonical_scope) then return null; end if;
  for e in select value from jsonb_array_elements(t.type_fields->'task_workflow'->'deliverables') order by value->>'id' loop
    select value into ref from jsonb_array_elements(t.type_fields->'task_workflow'->'delivery_refs')
      where value->>'deliverable_id'=e->>'id';
    d:=clued_private.task_goal_delivery_file_v1(p_owner,t.canonical_scope,p_binding,ref,e,metadata->>'goal_version');
    if d->>'reason'='delivery_unavailable' then
      d:=jsonb_build_object('deliverable_id',e->>'id','status','unknown','reason','delivery_unavailable');
    end if;
    files:=files||jsonb_build_array(d);
  end loop;
  return metadata||jsonb_build_object('deliveries',files);
end $$;

create function clued_private.task_goal_delivery_admit_v1(
  p_owner uuid,p_binding uuid,p_receipt uuid,p_task uuid,p_base bigint,p_scope text,p_input jsonb
) returns void language plpgsql volatile security definer set search_path='' as $$
declare r public.clued_audit_receipts; h text;
begin
  h:=clued_private.m1_sha256(jsonb_build_object('operation','record_mutation','payload',p_input-'idempotency_key'-'request_hash'));
  select * into r from public.clued_audit_receipts where id=p_receipt and user_id=p_owner and status='pending'
    and operation_family='record_mutation' and binding_id is not distinct from p_binding and request_sha256=h;
  if not found or p_input->>'operation' is distinct from 'close'
    or p_input->>'lifecycle_status' is distinct from 'completed'
    or p_input->>'id' is distinct from p_task::text or p_input->>'base_version' is distinct from p_base::text
    or p_input->>'scope' is distinct from p_scope then
    raise exception 'task_completion_admission_invalid' using errcode='42501'; end if;
  insert into clued_private.task_goal_delivery_completion_admissions_v1
    values(p_receipt,txid_current(),p_owner,p_task,p_base,p_scope,'close','completed',h);
end $$;
do $migration$
declare body text; anchor text:=$a$      update public.clued_memories set
        title=case when v_mutation ? 'title'$a$;
begin
  body:=pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 or strpos(body,'task_goal_delivery_admit_v1')>0 then
    raise exception 'task_goal_delivery_completion_core_definition_mismatch'; end if;
  execute replace(body,anchor,$g$      if v_record_type='task' and v_operation='close' and v_lifecycle='completed'
        and (v_record.type_fields ? 'task_workflow' or v_type_fields ? 'task_workflow') then
        perform clued_private.task_goal_delivery_admit_v1(p_user_id,p_binding_id,v_receipt.id,v_id,v_base,v_scope,p_input);
      end if;
$g$||anchor);
end $migration$;

create function clued_private.task_goal_delivery_guard_v1()
returns trigger language plpgsql volatile security definer set search_path='' as $$
declare w jsonb:=new.type_fields->'task_workflow'; e jsonb; previous_ref jsonb; j clued_private.storage_jobs_v1;
  p clued_private.resource_center_profiles_v1; r public.clued_audit_receipts; t public.clued_memories;
  projection jsonb; linked_scope text; critical boolean;
begin
  if TG_OP='UPDATE' and old.type_fields ? 'task_workflow' then
    if not new.type_fields ? 'task_workflow' or w='null'::jsonb or new.record_type<>'task'
      or new.record_schema_version is distinct from 1 or new.user_id<>old.user_id or new.id<>old.id then
      raise exception 'task_workflow_marker_immutable' using errcode='22023'; end if;
  end if;
  if w is null then return new; end if;
  if new.record_type<>'task' or new.record_schema_version is distinct from 1 then raise exception 'task_workflow_invalid' using errcode='22023'; end if;
  perform clued_private.task_goal_delivery_validate_v1(w);
  select * into r from public.clued_audit_receipts where id=new.receipt_id and user_id=new.user_id;
  for e in select value from jsonb_array_elements(w->'delivery_refs') loop
    -- Existing refs may be retained as history even when their source is no
    -- longer readable. Cancellation/archive/goal edits must remain possible.
    previous_ref:=null;
    if TG_OP='UPDATE' then select value into previous_ref from jsonb_array_elements(
      coalesce(old.type_fields->'task_workflow'->'delivery_refs','[]'::jsonb))
      where value->>'deliverable_id'=e->>'deliverable_id'; end if;
    if previous_ref=e and not (new.lifecycle_status='completed' and old.lifecycle_status is distinct from 'completed') then continue; end if;
    select * into j from clued_private.storage_jobs_v1 where owner_id=new.user_id and job_id=(e->>'job_id')::uuid;
    select * into p from clued_private.resource_center_profiles_v1 where id=(select profile_id
      from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=new.user_id) and user_id=new.user_id;
    linked_scope:='project:'||p.project_id::text;
    if j.job_id is null or p.id is null or not clued_private.task_goal_delivery_scope_read_v1(new.user_id,r.binding_id,linked_scope) then
      raise exception 'task_delivery_reference_unavailable' using errcode='42501'; end if;
    if r.binding_id is not null and not clued_private.task_goal_delivery_storage_read_v1(new.user_id,r.binding_id,j.connection_id,j.job_id) then
      raise exception 'task_delivery_reference_unavailable' using errcode='42501'; end if;
    if e->>'goal_version'=clued_private.task_goal_delivery_goal_v1(new)
      and (new.canonical_scope<>'global' and new.canonical_scope<>linked_scope
        or not exists(select 1 from jsonb_array_elements(w->'deliverables') x where x->>'id'=e->>'deliverable_id')) then
      raise exception 'task_delivery_reference_unavailable' using errcode='42501'; end if;
  end loop;
  if TG_OP='UPDATE' and new.lifecycle_status='completed' and old.lifecycle_status is distinct from 'completed' then
    if old.lifecycle_status<>'active' or r.id is null or new.receipt_id is not distinct from old.receipt_id
      or r.status<>'pending' or r.operation_family<>'record_mutation'
      or not exists(select 1 from clued_private.task_goal_delivery_completion_admissions_v1 x
        where x.receipt_id=r.id and x.transaction_id=txid_current() and x.owner_id=new.user_id
          and x.task_id=old.id and x.base_record_version=old.version and x.scope=old.canonical_scope
          and x.operation='close' and x.target_lifecycle='completed' and x.request_sha256=r.request_sha256)
      or new.version<>old.version+1 or new.canonical_scope<>old.canonical_scope then
      raise exception 'task_completion_requires_m1_receipt' using errcode='42501'; end if;
    perform clued_private.currentness_user_lock(new.user_id);
    if clued_private.record_currentness_fence(new.user_id,old.id,array[old.canonical_scope]) is distinct from 'CURRENT' then
      raise exception 'task_not_current' using errcode='42501'; end if;
    t:=new; t.lifecycle_status:='active';
    projection:=clued_private.task_goal_delivery_projection_v1(new.user_id,t,r.binding_id,true);
    if projection->'completion'->'eligible' is distinct from 'true'::jsonb then
      raise exception 'task_completion_checks_failed' using errcode='22023'; end if;
  elsif TG_OP='INSERT' and new.lifecycle_status is distinct from 'active' then
    raise exception 'task_workflow_create_must_be_active' using errcode='22023';
  elsif TG_OP='UPDATE' and old.lifecycle_status='active' then
    critical:=clued_private.task_goal_delivery_goal_v1(new) is distinct from clued_private.task_goal_delivery_goal_v1(old)
      or new.type_fields->'task_workflow'->'delivery_refs' is distinct from old.type_fields->'task_workflow'->'delivery_refs';
    if critical and clued_private.record_currentness_fence(new.user_id,old.id,array[old.canonical_scope]) is distinct from 'CURRENT' then
      raise exception 'task_not_current' using errcode='42501'; end if;
  end if;
  return new;
end $$;
create trigger task_goal_delivery_guard_v1 before insert or update on public.clued_memories
  for each row execute function clued_private.task_goal_delivery_guard_v1();

-- Safe metadata only, after the existing authorized list returned the row.
create function clued_private.task_goal_delivery_enrich_list_v1(p_owner uuid,p_result jsonb,p_scopes text[])
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare rows jsonb:='[]'; e jsonb; t public.clued_memories; metadata jsonb;
begin
  for e in select value from jsonb_array_elements(coalesce(p_result->'records','[]')) loop
    metadata:=null;
    if e->>'record_type'='task' and coalesce(e->>'id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into t from public.clued_memories where id=(e->>'id')::uuid and user_id=p_owner
        and record_type='task' and record_schema_version=1 and version::text=e->>'version'
        and (p_scopes is null or canonical_scope=any(p_scopes));
      if found then metadata:=clued_private.task_goal_delivery_metadata_v1(t); end if;
    end if;
    rows:=rows||jsonb_build_array(e||case when metadata is null then '{}'::jsonb else jsonb_build_object('task_workflow',metadata) end);
  end loop;
  return jsonb_set(p_result,'{records}',rows,false);
end $$;
do $migration$
declare body text; anchor text:=$a$  v_result:=clued_private.record_list_core_before_carrier_reasons(
    p_user_id,p_input,p_authorized_scopes);$a$;
begin
  body:=pg_get_functiondef('clued_private.record_list_core(uuid,jsonb,text[])'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'task_goal_delivery_list_definition_mismatch'; end if;
  execute replace(body,anchor,anchor||E'\n  v_result:=clued_private.task_goal_delivery_enrich_list_v1(p_user_id,v_result,p_authorized_scopes);');
  body:=pg_get_functiondef('clued_private.record_mutation_core(uuid,uuid,jsonb,text)'::regprocedure);
  anchor:=$a$'record',to_jsonb(v_record)-'user_id'$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'task_goal_delivery_supplemental_definition_mismatch'; end if;
  execute replace(body,anchor,$a$'record',(to_jsonb(v_record)-'user_id')||case when v_record.type_fields ? 'task_workflow'
    then jsonb_build_object('task_workflow',clued_private.task_goal_delivery_agent_metadata_v1(p_user_id,p_binding_id,v_record)) else '{}'::jsonb end$a$);
end $migration$;

create function clued_private.task_goal_delivery_enrich_agent_list_v1(p_owner uuid,p_binding uuid,p_result jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare rows jsonb:='[]'; e jsonb; t public.clued_memories; metadata jsonb;
begin
  for e in select value from jsonb_array_elements(coalesce(p_result->'records','[]')) loop
    metadata:=null;
    if e->>'record_type'='task' and coalesce(e->>'id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into t from public.clued_memories where id=(e->>'id')::uuid and user_id=p_owner and version::text=e->>'version'
        and record_type='task' and record_schema_version=1;
      if found then metadata:=clued_private.task_goal_delivery_agent_metadata_v1(p_owner,p_binding,t); end if;
    end if;
    rows:=rows||jsonb_build_array(e||case when metadata is null then '{}'::jsonb else jsonb_build_object('task_workflow',metadata) end);
  end loop;
  return jsonb_set(p_result,'{records}',rows,false);
end $$;
do $migration$
declare body text; anchor text:=$a$return clued_private.record_list_core(b.user_id,p_input,authorized_scopes);$a$;
begin
  body:=pg_get_functiondef('public.clued_record_list(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'task_goal_delivery_agent_list_definition_mismatch'; end if;
  execute replace(body,anchor,$r$return clued_private.task_goal_delivery_enrich_agent_list_v1(b.user_id,b.id,
    clued_private.record_list_core(b.user_id,p_input,authorized_scopes));$r$);
end $migration$;

-- Canonical Task match already passed search authorization and currentness.
-- Enrich before its byte-budget sizing, at the exact returned row version/scope.
do $migration$
declare body text; anchor text:=$a$'match_score',m.score) row_data,0 source_order,m.score,$a$;
begin
  body:=pg_get_functiondef('public.clued_mcp_search_context(text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
    raise exception 'task_goal_delivery_search_definition_mismatch'; end if;
  execute replace(body,anchor,$r$'match_score',m.score)||case when m.record_type='task' and m.record_schema_version=1
        and m.type_fields ? 'task_workflow' then jsonb_build_object('task_workflow',
          (select clued_private.task_goal_delivery_agent_metadata_v1(v_binding.user_id,v_binding.id,exact_task) from public.clued_memories exact_task
            where exact_task.id=m.id and exact_task.user_id=v_binding.user_id
              and exact_task.version=m.version and exact_task.canonical_scope=m.record_scope
              and exact_task.record_type='task' and exact_task.record_schema_version=1))
        else '{}'::jsonb end row_data,0 source_order,m.score,$r$);
end $migration$;

create function public.clued_task_goal_delivery_owner_v1(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare owner uuid:=clued_private.authorization_owner_v12(); action text:=p_input->>'action';
  t public.clued_memories; r public.clued_audit_receipts; result jsonb; inner_result jsonb;
  workflow jsonb; projection jsonb; refs jsonb; candidates jsonb; e jsonb; req jsonb; ev text;
  base bigint; goal text; acceptance uuid; error text; v_sqlstate text; allowed text[];
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or coalesce(p_input->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_input->>'expected_owner_id' is distinct from owner::text
    or coalesce(action,'') not in ('read','set_goal','bind_delivery','unbind_delivery','accept','complete') then
    return jsonb_build_object('status','rejected','error_code',case when p_input->>'expected_owner_id' is distinct from owner::text
      then 'task_owner_changed' else 'task_goal_delivery_input_invalid' end); end if;
  allowed:=array['action','id','expected_owner_id'];
  if action<>'read' then allowed:=allowed||array['base_record_version','idempotency_key']; end if;
  allowed:=allowed||case action when 'set_goal' then array['workflow']
    when 'bind_delivery' then array['goal_version','deliverable_id','job_id']
    when 'unbind_delivery' then array['goal_version','deliverable_id']
    when 'accept' then array['goal_version','completion_digest']
    when 'complete' then array['goal_version','completion_digest','closure_summary'] else '{}'::text[] end;
  if p_input-allowed<>'{}' then return jsonb_build_object('status','rejected','error_code','task_goal_delivery_input_invalid'); end if;
  if action='read' then
    select * into t from public.clued_memories where id=(p_input->>'id')::uuid and user_id=owner and record_type='task'
      and record_schema_version=1 and clued_private.task_goal_delivery_scope_read_v1(owner,null,canonical_scope);
    if not found then return jsonb_build_object('status','rejected','error_code','task_unavailable'); end if;
  else
    perform clued_private.currentness_user_lock(owner);
    r:=clued_private.m1_begin_receipt(owner,null,'task_goal_delivery_owner',p_input,clued_private.m1_sha256(p_input));
    if r.status<>'pending' then
      result:=coalesce(r.canonical_result,clued_private.m1_result_envelope(r))||jsonb_build_object('replayed',true);
      select * into t from public.clued_memories where id=(p_input->>'id')::uuid and user_id=owner and record_type='task' and record_schema_version=1;
      if not found or not clued_private.task_goal_delivery_scope_read_v1(owner,null,t.canonical_scope) then return result; end if;
    else
      begin
        if jsonb_typeof(p_input->'base_record_version') is distinct from 'number' or coalesce(p_input->>'base_record_version','') !~ '^[1-9][0-9]{0,15}$' then
          raise exception 'task_goal_delivery_input_invalid' using errcode='22023'; end if;
        select * into t from public.clued_memories where id=(p_input->>'id')::uuid and user_id=owner and record_type='task'
          and record_schema_version=1 for update;
        if not found or not clued_private.task_goal_delivery_scope_read_v1(owner,null,t.canonical_scope) then
          raise exception 'task_unavailable' using errcode='42501'; end if;
        base:=t.version;
        if t.version::text<>p_input->>'base_record_version' then raise exception 'task_record_version_conflict' using errcode='40001'; end if;
        if t.lifecycle_status is distinct from 'active' or clued_private.record_currentness_fence(owner,t.id,array[t.canonical_scope]) is distinct from 'CURRENT' then
          raise exception 'task_not_current' using errcode='42501'; end if;
        workflow:=t.type_fields->'task_workflow'; goal:=clued_private.task_goal_delivery_goal_v1(t);
        if action<>'set_goal' and (workflow is null or p_input->>'goal_version' is distinct from goal) then
          raise exception 'task_goal_version_conflict' using errcode='40001'; end if;
        if action='set_goal' then
          if jsonb_typeof(p_input->'workflow') is distinct from 'object' or p_input->'workflow' ? 'delivery_refs' then
            raise exception 'task_goal_delivery_input_invalid' using errcode='22023'; end if;
          workflow:=(p_input->'workflow')||jsonb_build_object('delivery_refs',coalesce(workflow->'delivery_refs','[]'::jsonb));
          perform clued_private.task_goal_delivery_validate_v1(workflow);
        elsif action in ('bind_delivery','unbind_delivery') then
          if not exists(select 1 from jsonb_array_elements(workflow->'deliverables') x where x->>'id'=p_input->>'deliverable_id')
            or (action='bind_delivery' and coalesce(p_input->>'job_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
            raise exception 'task_goal_delivery_input_invalid' using errcode='22023'; end if;
          select coalesce(jsonb_agg(x order by x->>'deliverable_id'),'[]'::jsonb) into refs
            from jsonb_array_elements(workflow->'delivery_refs') x where x->>'deliverable_id'<>p_input->>'deliverable_id';
          if action='bind_delivery' then refs:=refs||jsonb_build_array(jsonb_build_object(
            'deliverable_id',p_input->>'deliverable_id','job_id',p_input->>'job_id','goal_version',goal)); end if;
          -- A changed definition can retire all sixteen historical IDs. When
          -- binding would overflow, reclaim only retired, older-goal refs;
          -- current deliverables/goal refs remain intact and M1 keeps history.
          if action='bind_delivery' and jsonb_array_length(refs)>16 then
            select coalesce(jsonb_agg(x order by x->>'deliverable_id'),'[]'::jsonb) into refs
              from jsonb_array_elements(refs) x
              where x->>'goal_version'=goal or exists(select 1
                from jsonb_array_elements(workflow->'deliverables') d where d->>'id'=x->>'deliverable_id');
          end if;
          workflow:=jsonb_set(workflow,'{delivery_refs}',refs);
        else
          projection:=clued_private.task_goal_delivery_projection_v1(owner,t,null,true);
          if p_input->>'completion_digest' is distinct from projection->'completion'->>'completion_digest' then
            raise exception 'task_completion_digest_conflict' using errcode='40001'; end if;
          if projection->'completion'->'ready_for_acceptance' is distinct from 'true'::jsonb then
            raise exception 'task_completion_checks_failed' using errcode='22023'; end if;
          if action='accept' then
            if workflow->>'acceptance_mode'<>'owner' then raise exception 'task_owner_acceptance_not_required' using errcode='22023'; end if;
            acceptance:=gen_random_uuid();
            insert into clued_private.task_goal_delivery_acceptances_v1(id,owner_id,task_id,goal_version,completion_digest,accepted_record_version,receipt_id)
              values(acceptance,owner,t.id,goal,projection->'completion'->>'completion_digest',t.version,r.id);
          elsif projection->'completion'->'eligible' is distinct from 'true'::jsonb then
            raise exception 'task_owner_acceptance_required' using errcode='42501';
          end if;
        end if;
        if action<>'accept' then
          req:=jsonb_build_object('operation',case when action='complete' then 'close' else 'update' end,
            'id',t.id,'record_type','task','record_schema_version',1,'scope',t.canonical_scope,'base_version',t.version,
            'lifecycle_status',case when action='complete' then 'completed' else 'active' end,
            'authority',case when action='set_goal' then 'user_explicit' else 'observed' end,'user_confirmed',action='set_goal',
            'confidence_reason','Direct Native Owner task goal/delivery action',
            'mutation',case when action='complete' then jsonb_build_object('closure_summary',p_input->>'closure_summary')
              else jsonb_build_object('type_fields',jsonb_build_object('task_workflow',workflow)) end,
            'idempotency_key','task-goal-delivery:'||r.id::text);
          if action='complete' and (jsonb_typeof(p_input->'closure_summary') is distinct from 'string'
            or length(btrim(p_input->>'closure_summary')) not between 1 and 4000) then
            raise exception 'task_goal_delivery_input_invalid' using errcode='22023'; end if;
          inner_result:=public.clued_user_record_mutate(req,clued_private.m1_sha256(req));
          if inner_result->>'status' is distinct from 'committed' then
            result:=clued_private.m1_finish_receipt(r.id,case when inner_result->>'status'='rejected' then 'rejected' else 'failed' end,
              jsonb_build_array(jsonb_build_object('kind','record','role','source','id',t.id),
                jsonb_build_object('kind','system','role','source','id',inner_result->>'receipt_id')),jsonb_build_object(t.id::text,base),
              '{}','{}','{}',coalesce(inner_result->>'error_code','task_record_mutation_failed'));
          end if;
        end if;
        if result is null then
          if action<>'accept' then
            select * into t from public.clued_memories where id=t.id and user_id=owner;
            goal:=clued_private.task_goal_delivery_goal_v1(t);
          end if;
          refs:=case when action='accept' then jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',acceptance),
            jsonb_build_object('kind','record','role','source','id',t.id))
            else jsonb_build_array(jsonb_build_object('kind','record','role','primary','id',t.id),
              jsonb_build_object('kind','system','role','source','id',inner_result->>'receipt_id')) end;
          ev:=clued_private.m1_append_event_row(owner,null,r.id,r.canonical_version,'extension:task_goal_delivery:'||action,refs,
            t.canonical_scope,null,jsonb_build_object('action',action,'task_id',t.id,'goal_version',goal,
              'record_mutation_receipt_id',inner_result->>'receipt_id'),p_input->>'idempotency_key',r.request_sha256,
            'success','work_log','{}','[]',null);
          result:=clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(t.id::text,base),
            case when action='accept' then jsonb_build_object(acceptance::text,1) else inner_result->'committed_versions' end,array[ev],'{}',null);
        end if;
      exception when others then
        get stacked diagnostics error=message_text,v_sqlstate=returned_sqlstate;
        result:=clued_private.m1_finish_receipt(r.id,case when v_sqlstate in ('22023','40001','42501','P0002','55000') then 'rejected' else 'failed' end,
          case when t.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('kind','record','role','source','id',t.id)) end,
          '{}','{}','{}','{}',error);
      end;
      result:=result||jsonb_build_object('replayed',false);
      select * into t from public.clued_memories where id=(p_input->>'id')::uuid and user_id=owner and record_type='task' and record_schema_version=1;
      if not found or not clued_private.task_goal_delivery_scope_read_v1(owner,null,t.canonical_scope) then return result; end if;
    end if;
  end if;
  projection:=clued_private.task_goal_delivery_projection_v1(owner,t);
  select coalesce(jsonb_agg(row_data order by created_at desc,job_id),'[]') into candidates from (
    select j.created_at,j.job_id,jsonb_build_object('job_id',j.job_id,
      'label',regexp_replace(j.mutation->>'destination_path','^.*/',''),'path',j.mutation->>'destination_path',
      'state',clued_private.storage_job_status_v1(j)->>'status') row_data
      from clued_private.storage_jobs_v1 j join clued_private.storage_connections_v1 c on c.id=j.connection_id and c.owner_id=owner
      join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id and p.user_id=owner and p.state='active'
      where j.owner_id=owner and j.mutation->>'target_kind'='file'
        and j.mutation->>'operation' in ('create','replace')
        and jsonb_typeof(j.mutation->'destination_path')='string' and length(j.mutation->>'destination_path')>0
        and (t.canonical_scope='global' or t.canonical_scope='project:'||p.project_id::text)
        and clued_private.task_goal_delivery_scope_read_v1(owner,null,'project:'||p.project_id::text)
      order by j.created_at desc,j.job_id limit 30
  ) q;
  return coalesce(result,jsonb_build_object('status','ok'))||jsonb_build_object('task_id',t.id,'record_version',t.version,
    'task_workflow',projection,'delivery_candidates',candidates);
end $$;

revoke all on function public.clued_task_goal_delivery_owner_v1(jsonb) from public,anon,authenticated,service_role,clued_worker_gateway;
grant execute on function public.clued_task_goal_delivery_owner_v1(jsonb) to authenticated;
revoke all on function
  clued_private.task_goal_delivery_audit_immutable_v1(),
  clued_private.task_goal_delivery_validate_v1(jsonb),
  clued_private.task_goal_delivery_goal_v1(public.clued_memories),
  clued_private.task_goal_delivery_metadata_v1(public.clued_memories),
  clued_private.task_goal_delivery_scope_read_v1(uuid,uuid,text),
  clued_private.task_goal_delivery_storage_read_v1(uuid,uuid,uuid,uuid),
  clued_private.task_goal_delivery_file_v1(uuid,text,uuid,jsonb,jsonb,text,boolean),
  clued_private.task_goal_delivery_projection_v1(uuid,public.clued_memories,uuid,boolean),
  clued_private.task_goal_delivery_agent_metadata_v1(uuid,uuid,public.clued_memories),
  clued_private.task_goal_delivery_admit_v1(uuid,uuid,uuid,uuid,bigint,text,jsonb),
  clued_private.task_goal_delivery_guard_v1(),
  clued_private.task_goal_delivery_enrich_list_v1(uuid,jsonb,text[]),
  clued_private.task_goal_delivery_enrich_agent_list_v1(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role,clued_worker_gateway;
