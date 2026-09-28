-- Closed-by-default compatibility layer. This migration neither activates an
-- account policy nor changes existing grants, connections or revoke receipts.
-- A later reviewed transition must use the same provider-root advisory lock.
-- Old clients cannot restore legacy authority after the mode has changed.
alter function clued_private.clued_storage_account_v1(jsonb)
  rename to storage_account_legacy_core_v1;
revoke all on function clued_private.storage_account_legacy_core_v1(jsonb)
  from public,anon,authenticated,service_role;

create function clued_private.clued_storage_account_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  root text; mode text; result jsonb;
begin
  if op in ('grant_client','revoke_client','revoke_connection') then
    -- These are unlocked lookup hints, not authorization. Serialize before the
    -- core takes Binding/authorization/connection rows, then re-read the mode.
    select p.root_folder_id into root from clued_private.storage_connections_v1 c
      join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
      where c.id=(p_input->>'connection_id')::uuid and c.owner_id=u;
    if root is null then raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
    perform clued_private.storage_owner_v1();
    select c.auth_mode into mode from clued_private.storage_connections_v1 c
      join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
      where c.id=(p_input->>'connection_id')::uuid and c.owner_id=u and p.root_folder_id=root;
    if mode is distinct from 'legacy' then
      raise exception 'storage_legacy_mode_denied' using errcode='42501'; end if;
  end if;
  result:=clued_private.storage_account_legacy_core_v1(p_input);
  -- Recheck after every core lock wait. The row mutation and its audit receipt
  -- roll back together if the execution authority is no longer legacy.
  if op in ('grant_client','revoke_client','revoke_connection') then
    select auth_mode into mode from clued_private.storage_connections_v1
      where id=(p_input->>'connection_id')::uuid and owner_id=u;
    if mode is distinct from 'legacy' then
      raise exception 'storage_legacy_mode_denied' using errcode='42501'; end if;
  end if;
  perform clued_private.storage_owner_v1();
  return result;
end $$;
revoke all on function clued_private.clued_storage_account_v1(jsonb)
  from public,anon,authenticated,service_role;

-- Keep legacy identity/lifecycle/expiry checks byte-for-byte in meaning. There
-- is deliberately no "legacy grant OR account policy" fallback: the new
-- evaluator is private and is not wired into any execution route in this stage.
create or replace function clued_private.storage_binding_v1(p_hash text,p_connection uuid,p_action text)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
  c clued_private.storage_connections_v1; g clued_private.storage_client_grants_v1;
begin
  if coalesce(p_hash,'') !~ '^[0-9a-f]{64}$' or coalesce(p_action,'') not in ('inspect','create_file','create_topic') then
    raise exception 'storage_binding_denied' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where token_hash=p_hash for share;
  if not found or b.revoked_at is not null or ((to_jsonb(b)->>'expires_at')::timestamptz is not null and (to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp()) then
    raise exception 'storage_binding_denied' using errcode='42501'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=b.user_id for share;
  if not found or a.revoked_at is not null or a.expires_at<=clock_timestamp() then
    raise exception 'storage_binding_denied' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(b.user_id);
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=b.user_id for share;
  if not found or c.auth_mode<>'legacy' then raise exception 'storage_binding_denied' using errcode='42501'; end if;
  select * into g from clued_private.storage_client_grants_v1 where connection_id=c.id and binding_id=b.id for share;
  if not found or g.revoked_at is not null or g.expires_at<=clock_timestamp() or g.authorization_version<>a.version
    or not(p_action=any(g.actions)) then raise exception 'storage_binding_denied' using errcode='42501'; end if;
  perform clued_private.storage_connection_current_v1(c.id,b.user_id);
  if least((to_jsonb(b)->>'expires_at')::timestamptz,a.expires_at,g.expires_at)<=clock_timestamp() then
    raise exception 'storage_binding_denied' using errcode='42501'; end if;
  return b;
end $$;
revoke all on function clued_private.storage_binding_v1(text,uuid,text)
  from public,anon,authenticated,service_role;

-- Close all legacy execution and provider-recovery paths. Ordinary OAuth and
-- same-scope refresh remain credential-only; recovery_inspect stays read-only.
create or replace function public.clued_storage_cloud_worker_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; c clued_private.storage_connections_v1;
  j clued_private.storage_jobs_v1; p clued_private.resource_center_profiles_v1;
  b public.clued_agent_bindings; w clued_private.resource_center_writer_bindings_v1;
  a clued_private.resource_center_bindings_v1; result jsonb; wanted text; op text:=p_input->>'action';
  issued jsonb; expiry timestamptz; nonce text; writer_hash text; reader_hash text;
  receipt public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('load','authority','begin','provider_attempt','finalize','report','recovery_load','recovery_finalize') or
    (p_input-array['action','connection_id','job_id','credential_version','request','prepare','attempt','finish','outcome'])<>'{}'::jsonb then
    raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  if (op in ('load','recovery_load') and (p_input-array['action','connection_id','job_id'])<>'{}'::jsonb) or
    (op not in ('load','recovery_load') and (p_input-array['action','connection_id','job_id','credential_version',
       case op when 'authority' then 'request' when 'begin' then 'prepare' when 'provider_attempt' then 'attempt' when 'report' then 'outcome' else 'finish' end])<>'{}'::jsonb) then
    raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null and execution_enabled for share;
  if not found then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and oauth_client_id=app.oauth_client_id;
  if not found then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||c.owner_id::text||':'||(p_input->>'job_id')::uuid::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=(p_input->>'job_id')::uuid and connection_id=c.id;
  if not found then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.owner_id::text||':'||p.root_folder_id,0));
  select * into b from public.clued_agent_bindings where id=j.binding_id and user_id=c.owner_id;
  wanted:=case when j.mutation->>'target_kind'='file' then 'create_file' else 'create_topic' end;
  -- Settlement of an already started attempt may outlive the client grant.
  -- New reads/authority/begins always recheck that exact original grant.
  if op in ('load','authority','begin') then
    perform clued_private.storage_binding_v1(b.token_hash,c.id,wanted);
    if not exists(select 1 from clued_private.storage_client_grants_v1 g where g.connection_id=c.id and g.binding_id=b.id
      and g.receipt_id=j.grant_receipt_id and g.authorization_version=j.authorization_version) then
      raise exception 'storage_job_grant_changed' using errcode='42501'; end if;
  end if;
  if op in ('recovery_load','recovery_finalize') then perform clued_private.authorization_account_v12(c.owner_id); end if;
  select * into c from clued_private.storage_connections_v1 where id=c.id for share;
  if c.auth_mode is distinct from 'legacy' then raise exception 'storage_legacy_mode_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=p.id for update;
  if p.state<>'active' or p.version<>c.profile_version or p.cloud_runtime->>'contract' is distinct from 'clued.storage-cloud-runtime/1' or
    p.cloud_runtime->>'profile_version' is distinct from p.version::text or app.oauth_client_id is distinct from c.oauth_client_id then
    raise exception 'storage_cloud_unqualified' using errcode='42501'; end if;
  perform 1 from public.clued_memories where id=(p.cloud_runtime->>'source_decision_id')::uuid for share;
  if not exists(select 1 from public.clued_memories where id=(p.cloud_runtime->>'source_decision_id')::uuid
      and version=(p.cloud_runtime->>'decision_version')::bigint) or
    not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,(p.cloud_runtime->>'source_decision_id')::uuid) then
    raise exception 'storage_cloud_unqualified' using errcode='42501'; end if;
  select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=j.job_id for update;
  if op in ('recovery_load','recovery_finalize') then
    if op='recovery_finalize' and c.credential_version is distinct from (p_input->>'credential_version')::bigint then
      raise exception 'storage_cloud_credential_changed' using errcode='42501'; end if;
    return clued_private.storage_cloud_recover_v1(c.owner_id,j.job_id,op,p_input->'finish');
  end if;
  if op='report' then
    -- Failed preflight must not remain an apparently queued/retryable job.
    -- Any existing journal always wins, especially a lost begin response.
    if j.intent_id is not null or j.dispatch_outcome is not null then return clued_private.storage_job_status_v1(j); end if;
    if p_input->'outcome' not in ('{"status":"denied"}'::jsonb,'{"status":"attention_required"}'::jsonb)
      or p_input->'outcome' is null then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
    req:=jsonb_build_object('idempotency_key','cloud-dispatch-outcome:'||j.job_id::text,'job_id',j.job_id,'outcome',p_input->'outcome');
    receipt:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_dispatch_outcome',req,clued_private.m1_sha256(req));
    if receipt.status<>'pending' then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
    update clued_private.storage_jobs_v1 set dispatch_outcome=p_input->'outcome',dispatch_outcome_receipt_id=receipt.id
      where owner_id=c.owner_id and job_id=j.job_id returning * into j;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',j.job_id));
    ev:=clued_private.m1_append_event_row(c.owner_id,null,receipt.id,receipt.canonical_version,'extension:storage:dispatch_outcome',
      refs,'project:'||p.project_id::text,null,req,req->>'idempotency_key',receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    perform clued_private.m1_finish_receipt(receipt.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
    return clued_private.storage_job_status_v1(j);
  end if;
  if op='load' and (j.intent_id is not null or j.dispatch_outcome is not null) then
    return jsonb_build_object('contract','clued.storage-job-execution/1','owner_id',c.owner_id)||clued_private.storage_job_status_v1(j);
  end if;
  if j.dispatch_outcome is not null then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  if op<>'load' and c.credential_version is distinct from (p_input->>'credential_version')::bigint then
    raise exception 'storage_cloud_credential_changed' using errcode='42501'; end if;
  select * into w from clued_private.resource_center_writer_bindings_v1 where id=j.cloud_writer_binding_id;
  if w.revoked_at is not null then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  if op='load' then
    perform clued_private.storage_root_quiet_v1(c.owner_id,p.root_folder_id);
    if w.id is null or w.expires_at<=clock_timestamp() then
      -- A fresh short-lived internal writer is allowed only before any intent.
      -- Plaintext secrets/hashes are never returned or stored on devices.
      nonce:=gen_random_uuid()::text; expiry:=clock_timestamp()+interval '2 minutes';
      reader_hash:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
      writer_hash:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
      issued:=public.clued_resource_center_admin_v1(c.owner_id,jsonb_build_object('action','binding_issue','profile_id',p.id,
        'source_decision_id',p.source_decision_id,'idempotency_key','cloud-reader:'||nonce,'token_hash',reader_hash,'expires_at',expiry));
      if issued->>'status' is distinct from 'committed' then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
      select * into a from clued_private.resource_center_bindings_v1 where token_hash=reader_hash;
      issued:=public.clued_resource_center_writer_admin_v1(c.owner_id,jsonb_build_object('action','issue','authority_binding_id',a.id,
        'source_decision_id',p.source_decision_id,'idempotency_key','cloud-writer:'||nonce,'token_hash',writer_hash,'expires_at',expiry));
      if issued->>'status' is distinct from 'committed' then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
      select * into w from clued_private.resource_center_writer_bindings_v1 where token_hash=writer_hash;
      update clued_private.storage_jobs_v1 set cloud_writer_binding_id=w.id where owner_id=c.owner_id and job_id=j.job_id;
    end if;
    if w.revoked_at is not null then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
    result:=jsonb_build_object('contract','clued.storage-job-execution/1','status','queued',
      'owner_id',c.owner_id,'connection_id',c.id,'job_id',j.job_id,'request_digest',j.request_digest,'mutation',j.mutation,
      'provider',c.provider,'provider_subject',c.provider_subject,'credential_version',c.credential_version,
      'oauth_client_id',c.oauth_client_id,'credential_envelope',c.credential_envelope,
      'profile',jsonb_build_object('registration_status','registered','profile_id',p.id,'profile_version',p.profile_version,
        'policy_version',p.policy_version,'managed_root',p.managed_root,'allowed_root_children',p.cloud_runtime->'allowed_root_children'),
      'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,
      'scan_roots',jsonb_build_array(jsonb_build_object('folder_id',p.root_parent_id,'path',regexp_replace(p.managed_root,'/[^/]+$',''))));
    perform clued_private.storage_binding_v1(b.token_hash,c.id,wanted);
    return result;
  end if;
  if w.id is null then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  if op='authority' then
    select * into a from clued_private.resource_center_bindings_v1 where id=w.authority_binding_id;
    if p_input->'request'->>'profile_id' is distinct from p.id::text then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
    result:=public.clued_resource_center_authority_v1(a.token_hash,p_input->'request');
    perform clued_private.storage_binding_v1(b.token_hash,c.id,wanted);
    return result||jsonb_build_object('request',p_input->'request');
  elsif op='begin' then return clued_private.storage_job_begin_v1(c.owner_id,j.job_id,w.token_hash,p_input->'prepare');
  elsif op='provider_attempt' then return clued_private.storage_job_provider_attempt_v1(c.owner_id,j.job_id,w.token_hash,p_input->'attempt');
  else return clued_private.storage_job_finalize_v1(c.owner_id,j.job_id,w.token_hash,p_input->'finish'); end if;
end $$;

create or replace function clued_private.storage_job_provider_attempt_v1(
  p_owner uuid,p_job uuid,p_writer_hash text,p_attempt jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; m clued_private.resource_center_mutations_v1;
  inspected jsonb; expected jsonb; r public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
  if j.intent_id is null then raise exception 'storage_attempt_unavailable' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text||':'||p.root_folder_id,0));
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner for share;
  if not found or c.auth_mode<>'legacy' then raise exception 'storage_legacy_mode_denied' using errcode='42501'; end if;
  -- Existing writer resolution checks owner/profile/Decision and serializes
  -- revocation. No additional execution permit is acquired here.
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner and profile_id=p.id;
  inspected:=public.clued_resource_center_write_v1(p_writer_hash,jsonb_build_object(
    'action','inspect','intent_id',m.id,'request_sha256',m.request_sha256));
  if inspected->>'status' is distinct from 'started' or inspected->>'intent_id' is distinct from m.id::text then
    raise exception 'storage_attempt_unavailable' using errcode='42501'; end if;
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job for update;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner and profile_id=p.id for update;
  if m.state<>'started' or m.exact_request->'mutation' is distinct from
      (j.mutation||jsonb_build_object('artifact_role','clued_resource')) or
      jsonb_typeof(p_attempt) is distinct from 'object' or
      coalesce(p_attempt->>'provider_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then
    raise exception 'storage_attempt_mismatch' using errcode='42501'; end if;
  expected:=jsonb_build_object('contract','clued.resource-center-provider-attempt/1',
    'intent_id',m.id,'request_sha256',m.request_sha256,'profile_id',p.id,
    'provider_file_id',p_attempt->>'provider_file_id','destination_path',j.mutation->>'destination_path',
    'parent_id',m.authority_request->'provider_identity'->>'destination_parent_id',
    'target_kind',j.mutation->>'target_kind','binding',m.exact_request->'binding',
    'size',case when j.mutation->>'target_kind'='file' then octet_length(j.mutation->>'content')::text end,
    'sha256',case when j.mutation->>'target_kind'='file' then
      encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);
  if p_attempt is distinct from expected then raise exception 'storage_attempt_mismatch' using errcode='42501'; end if;
  if m.provider_attempt is not null then
    if m.provider_attempt is distinct from p_attempt then raise exception 'storage_attempt_conflict' using errcode='40001'; end if;
    return jsonb_build_object('status','replayed','attempt_recorded',false,'execution_permitted',false,
      'receipt_id',m.provider_attempt_receipt_id);
  end if;
  req:=jsonb_build_object('idempotency_key','storage-provider-attempt:'||m.id::text,
    'intent_id',m.id,'attempt_digest',clued_private.m1_sha256(p_attempt));
  r:=clued_private.m1_begin_receipt(p_owner,null,'storage_provider_attempt',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_attempt_receipt_conflict' using errcode='40001'; end if;
  update clued_private.resource_center_mutations_v1 set provider_attempt=p_attempt,provider_attempt_receipt_id=r.id where id=m.id;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
  ev:=clued_private.m1_append_event_row(p_owner,null,r.id,r.canonical_version,'extension:storage:provider_attempt_recorded',
    refs,'project:'||p.project_id::text,null,req,'storage-provider-attempt:'||m.id::text,r.request_sha256,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  -- Recording is not a journal transition; preserve the original version for
  -- finalization. The caller must still consume its original one-shot admission.
  return jsonb_build_object('status','committed','attempt_recorded',true,'receipt_id',r.id,'attempt',p_attempt);
end $$;

create or replace function clued_private.storage_job_finalize_v1(p_owner uuid,p_job uuid,p_writer_hash text,p_finish jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; m clued_private.resource_center_mutations_v1;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
  if j.intent_id is null then raise exception 'storage_attempt_unavailable' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text||':'||p.root_folder_id,0));
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner for share;
  if not found or c.auth_mode<>'legacy' then raise exception 'storage_legacy_mode_denied' using errcode='42501'; end if;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner and profile_id=p.id;
  if m.provider_attempt is null or p_finish->>'action' is distinct from 'finalize' or
    p_finish->>'intent_id' is distinct from m.id::text or p_finish->>'request_sha256' is distinct from m.request_sha256 or
    p_finish->'postcondition'->>'provider_file_id' is distinct from m.provider_attempt->>'provider_file_id' or
    p_finish->'postcondition'->>'path' is distinct from m.provider_attempt->>'destination_path' or
    p_finish->'postcondition'->>'parent_id' is distinct from m.provider_attempt->>'parent_id' then
    raise exception 'storage_attempt_postcondition_mismatch' using errcode='42501'; end if;
  return public.clued_resource_center_write_v1(p_writer_hash,p_finish);
end $$;

create or replace function clued_private.storage_connection_recovery_v1(p_connection uuid,p_owner uuid)
returns clued_private.storage_connections_v1 language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
begin
  perform clued_private.authorization_account_v12(p_owner);
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=p_owner for share;
  if not found or c.auth_mode<>'legacy' or c.state not in ('active','reauthorization_required') or c.revoked_at is not null then
    raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner for share;
  if not found or p.state<>'active' or p.version<>c.profile_version then
    raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
  perform 1 from public.clued_memories where id in (c.source_decision_id,p.source_decision_id) order by id for share;
  if not exists(select 1 from public.clued_memories where id=c.source_decision_id and version=c.decision_version)
    or not clued_private.resource_center_decision_current_v1(p.user_id,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(p.user_id,p.project_id,p.source_decision_id) then
    raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
  return c;
end $$;

create or replace function public.clued_storage_refresh_worker_v1(p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a clued_private.storage_oauth_apps_v1; c clued_private.storage_connections_v1;
  d clued_private.storage_refresh_delegations_v1; x clued_private.storage_refresh_attempts_v1;
  p clued_private.resource_center_profiles_v1; op text:=p_input->>'action';
  r public.clued_audit_receipts; refs jsonb; ev text; req jsonb; expiry timestamptz; result jsonb; recovery_job uuid; recovery_intent uuid; recovery_digest text;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('due','claim','commit','fail') then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  select * into a from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if op='due' then
    if p_input<>jsonb_build_object('action','due') then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    with candidates as (select g.connection_id from clued_private.storage_refresh_delegations_v1 g join clued_private.storage_connections_v1 candidate_connection on candidate_connection.id=g.connection_id
       where g.issuer_hash=a.issuer_hash and g.enabled and g.failures<3 and g.next_refresh_at<=clock_timestamp() and candidate_connection.state='active'
       and not exists(select 1 from clued_private.storage_refresh_attempts_v1 pending_attempt where pending_attempt.connection_id=candidate_connection.id and pending_attempt.state='claimed')
       order by g.last_polled_at nulls first,g.next_refresh_at,g.connection_id limit 10 for update of g skip locked),
      selected as (update clued_private.storage_refresh_delegations_v1 g set last_polled_at=clock_timestamp()
        from candidates q where g.connection_id=q.connection_id returning g.connection_id)
      select jsonb_build_object('connections',coalesce(jsonb_agg(connection_id),'[]'::jsonb)) into result from selected;
    return result||jsonb_build_object('pending_expired', (select count(*) from clued_private.storage_refresh_attempts_v1
      where issuer_hash=a.issuer_hash and state='claimed' and expires_at<=clock_timestamp()));
  end if;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid;
  if not found then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.owner_id::text||':'||p.root_folder_id,0));
  perform clued_private.authorization_account_v12(c.owner_id);
  select * into c from clued_private.storage_connections_v1 where id=c.id for update;
  select * into d from clued_private.storage_refresh_delegations_v1 where connection_id=c.id for update;
  select * into x from clued_private.storage_refresh_attempts_v1 where id=(p_input->>'attempt_id')::uuid for update;
  if x.id is not null and (x.connection_id<>c.id or x.issuer_hash<>a.issuer_hash) then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  -- Exact terminal recovery is metadata-only even after stop/reauthorization.
  -- It cannot disclose ciphertext, issue a new grant or contact the provider.
  if x.state in ('committed','failed') and x.request_digest=clued_private.m1_sha256(p_input) then
    return jsonb_build_object('status',x.state,'receipt_id',x.receipt_id); end if;
  if d.connection_id is null or not d.enabled or d.issuer_hash<>a.issuer_hash or c.oauth_client_id<>a.oauth_client_id then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  perform clued_private.storage_connection_current_v1(c.id,c.owner_id);
  recovery_job:=(p_input->>'recovery_job_id')::uuid;
  if recovery_job is null then
    if x.recovery_job_id is not null then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    perform clued_private.storage_root_quiet_v1(c.owner_id,p.root_folder_id);
  else
    if not a.execution_enabled or c.auth_mode<>'legacy' then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    select * into p from clued_private.resource_center_profiles_v1 where id=p.id for share;
    perform 1 from public.clued_memories where id=(p.cloud_runtime->>'source_decision_id')::uuid for share;
    if p.cloud_runtime->>'contract' is distinct from 'clued.storage-cloud-runtime/1' or
      p.cloud_runtime->>'profile_version' is distinct from p.version::text or
      not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,(p.cloud_runtime->>'source_decision_id')::uuid) or
      not exists(select 1 from public.clued_memories where id=(p.cloud_runtime->>'source_decision_id')::uuid
        and version=(p.cloud_runtime->>'decision_version')::bigint) then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    if op='claim' and x.id is null then
      select m.id,clued_private.m1_sha256(jsonb_build_object('request_sha256',m.request_sha256,'provider_attempt',m.provider_attempt))
        into recovery_intent,recovery_digest
        from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id
        where j.owner_id=c.owner_id and j.job_id=recovery_job and j.connection_id=c.id
          and m.profile_id=p.id and m.user_id=c.owner_id and m.profile_version=p.version
          and m.writer_binding_id=j.cloud_writer_binding_id and m.state in ('started','uncertain') and m.provider_attempt is not null
          and p.cloud_runtime->>'contract'='clued.storage-cloud-runtime/1'
          and p.cloud_runtime->>'profile_version'=p.version::text
          and clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,(p.cloud_runtime->>'source_decision_id')::uuid)
          and exists(select 1 from public.clued_memories where id=(p.cloud_runtime->>'source_decision_id')::uuid
            and version=(p.cloud_runtime->>'decision_version')::bigint);
      if recovery_intent is null then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    elsif x.recovery_job_id is distinct from recovery_job then
      raise exception 'storage_refresh_denied' using errcode='42501';
    elsif not exists(select 1 from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id
      where j.owner_id=c.owner_id and j.connection_id=c.id and j.job_id=x.recovery_job_id and m.id=x.recovery_intent_id
        and m.profile_id=p.id and m.profile_version=p.version and m.state in ('started','uncertain','committed')
        and clued_private.m1_sha256(jsonb_build_object('request_sha256',m.request_sha256,'provider_attempt',m.provider_attempt))=x.recovery_attempt_digest) then
      raise exception 'storage_refresh_denied' using errcode='42501';
    end if;
    -- The immutable anchor survives another verifier settling the file first.
    -- Never reset the mutation, replace its provider ID or issue write authority.
  end if;
  if op='claim' then
    if p_input<>(jsonb_build_object('action','claim','connection_id',c.id,'attempt_id',(p_input->>'attempt_id')::uuid)||case when recovery_job is null then '{}'::jsonb else jsonb_build_object('recovery_job_id',recovery_job) end) then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    if x.id is not null then return jsonb_build_object('status',x.state,'receipt_id',x.receipt_id); end if;
    if d.failures>=3 or d.next_refresh_at>clock_timestamp() or exists(select 1 from clued_private.storage_refresh_attempts_v1 where connection_id=c.id and state='claimed') then
      raise exception 'storage_refresh_not_due' using errcode='42501'; end if;
    insert into clued_private.storage_refresh_attempts_v1(id,connection_id,issuer_hash,delegation_version,credential_version,state,expires_at,recovery_job_id,recovery_intent_id,recovery_attempt_digest)
      values((p_input->>'attempt_id')::uuid,c.id,a.issuer_hash,d.version,c.credential_version,'claimed',clock_timestamp()+interval '2 minutes',recovery_job,recovery_intent,recovery_digest) returning * into x;
    -- Only the first successful claim discloses ciphertext to the trusted Worker.
    return jsonb_build_object('status','acquired','attempt_id',x.id,'connection_id',c.id,'owner_id',c.owner_id,
      'provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,'credential_version',c.credential_version,
      'credential_envelope',c.credential_envelope,'expires_at',x.expires_at,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id);
  end if;
  if x.id is null then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if x.state<>'claimed' or x.expires_at<=clock_timestamp() or x.delegation_version<>d.version or x.credential_version<>c.credential_version then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if op='commit' then
    if (p_input-array['action','connection_id','attempt_id','credential_envelope','expires_at','recovery_job_id'])<>'{}'::jsonb
      or not clued_private.storage_envelope_valid_v1(p_input->'credential_envelope') then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
    expiry:=(p_input->>'expires_at')::timestamptz;
    if expiry is null or expiry<=clock_timestamp()+interval '60 seconds' or expiry>clock_timestamp()+interval '24 hours' then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  elsif p_input<>(jsonb_build_object('action','fail','connection_id',c.id,'attempt_id',x.id,'reason',p_input->>'reason')||case when recovery_job is null then '{}'::jsonb else jsonb_build_object('recovery_job_id',recovery_job) end)
    or coalesce(p_input->>'reason','') not in ('provider_rejected','provider_unavailable','credential_invalid') then
    raise exception 'storage_refresh_denied' using errcode='42501';
  end if;
  req:=jsonb_build_object('idempotency_key',x.id::text||':'||op,'request_digest',clued_private.m1_sha256(p_input));
  r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_refresh_result',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  if op='commit' then
    update clued_private.storage_connections_v1 set version=version+1,credential_version=credential_version+1,credential_envelope=p_input->'credential_envelope',receipt_id=r.id where id=c.id;
    update clued_private.storage_refresh_delegations_v1 set failures=0,next_refresh_at=greatest(clock_timestamp()+interval '60 seconds',expiry-interval '5 minutes') where connection_id=c.id;
  else
    update clued_private.storage_refresh_delegations_v1 set failures=least(3,failures+1),
      enabled=enabled and p_input->>'reason'='provider_unavailable' and failures<2,
      next_refresh_at=clock_timestamp()+((failures+1)*5)*interval '1 minute' where connection_id=c.id;
    if p_input->>'reason'<>'provider_unavailable' then
      update clued_private.storage_connections_v1 set state='reauthorization_required',version=version+1,receipt_id=r.id where id=c.id; end if;
  end if;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
  ev:=clued_private.m1_append_event_row(c.owner_id,null,r.id,r.canonical_version,'extension:storage:credential_'||op,
    refs,'project:'||p.project_id::text,null,jsonb_build_object('connection_id',c.id,'attempt_id',x.id),
    req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  update clued_private.storage_refresh_attempts_v1 set state=case when op='commit' then 'committed' else 'failed' end,
    request_digest=clued_private.m1_sha256(p_input),receipt_id=r.id where id=x.id returning * into x;
  if x.expires_at<=clock_timestamp() then raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  return jsonb_build_object('status',x.state,'receipt_id',r.id);
end $$;
