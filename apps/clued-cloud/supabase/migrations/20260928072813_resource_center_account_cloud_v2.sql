-- Closed-by-default V2 cloud assembly. No Worker flag, app, policy, grant or
-- connection is enabled here. The original journal remains the only fence.
-- IMPORTANT: durable pre-revocation verified-result settlement (plan section 6)
-- is NOT implemented here. Recovery actions fail closed; this increment is not
-- sufficient to activate production account-policy execution.

create function clued_private.storage_cloud_job_current_v2(p_owner uuid,p_job uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; b public.clued_agent_bindings;
  s jsonb; consent uuid; wanted text;
begin
  -- Lookup hints only: the evaluator acquires issuer -> lineage -> job -> root
  -- before rows. Never take a job/root lock before this first evaluation.
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
  if not found or j.authority_snapshot_v2 is null then raise exception 'storage_cloud_mode_denied' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where id=j.binding_id and user_id=p_owner;
  wanted:=case j.mutation->>'target_kind' when 'file' then 'create_file' when 'directory' then 'create_topic' end;
  s:=clued_private.storage_policy_evaluate_v2(b.token_hash,j.connection_id,wanted,p_job);
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job for share;
  select consent_receipt_id into consent from clued_private.storage_account_policies_v2 where id=(s->>'policy_id')::uuid;
  if j.authority_snapshot_v2 is distinct from (s||jsonb_build_object('consent_receipt_id',consent))
    or j.grant_receipt_id is distinct from (s->>'policy_receipt_id')::uuid
    or j.authorization_version is distinct from (s->>'authorization_version')::bigint
    or j.request_digest is distinct from clued_private.m1_sha256(jsonb_build_object('connection_id',j.connection_id,'mutation',j.mutation))
    or j.mutation->>'operation' is distinct from 'create'
    or not exists(select 1 from public.clued_audit_receipts where id=j.receipt_id and user_id=p_owner
      and binding_id=j.binding_id and operation='storage_job_submit' and status='committed') then
    raise exception 'storage_cloud_snapshot_changed' using errcode='42501'; end if;
  return s;
end $$;

create function clued_private.storage_cloud_job_mutation_v2(p_mutation jsonb,p_authority jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare field text;
begin
  if jsonb_typeof(p_authority) is distinct from 'object' then raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
  foreach field in array array['operation','destination_path','target_kind','directory_semantics'] loop
    if coalesce(p_authority->field,'null'::jsonb) is distinct from coalesce(p_mutation->field,'null'::jsonb) then
      raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
  end loop;
  if p_authority->>'artifact_role' is distinct from 'clued_resource' or p_authority->>'source_path' is not null then
    raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
end $$;

create function clued_private.storage_job_begin_v2(p_owner uuid,p_job uuid,p_writer_hash text,p_prepare jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; b public.clued_agent_bindings;
  w clued_private.resource_center_writer_bindings_v1; a clued_private.resource_center_bindings_v1;
  prepared jsonb; started jsonb; wanted text; field text; am jsonb;
begin
  perform clued_private.storage_cloud_job_current_v2(p_owner,p_job);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
  if not found then raise exception 'storage_job_unavailable' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text||':'||p.root_folder_id,0));
  select * into b from public.clued_agent_bindings where id=j.binding_id and user_id=p_owner;
  wanted:=case when j.mutation->>'target_kind'='file' then 'create_file' else 'create_topic' end;
  perform clued_private.storage_cloud_job_current_v2(p_owner,p_job);
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job for update;
  if j.intent_id is not null then return clued_private.storage_job_status_v1(j)||jsonb_build_object('replayed',true); end if;
  select * into w from clued_private.resource_center_writer_bindings_v1 where token_hash=p_writer_hash;
  select * into a from clued_private.resource_center_bindings_v1 where id=w.authority_binding_id;
  if w.id is distinct from j.cloud_writer_binding_id
    or a.profile_id is distinct from p.id or a.user_id is distinct from p_owner
    or p_prepare->>'action' is distinct from 'prepare'
    or p_prepare->>'request_key' is distinct from ('account-job:'||p_job::text)
    or p_prepare->'exact_request'->'mutation' is distinct from (j.mutation||jsonb_build_object('artifact_role','clued_resource')) then
    raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
  -- Host-derived authority/binding cannot authorize B while the stored job
  -- and provider payload still describe A. Only canonical exact paths enter
  -- this composition point; the Host must not silently retarget/normalize it.
  am:=p_prepare->'authority_request'->'mutation';
  foreach field in array array['operation','destination_path','target_kind','directory_semantics'] loop
    if coalesce(am->field,'null'::jsonb) is distinct from coalesce(j.mutation->field,'null'::jsonb) then
      raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
  end loop;
  if am->>'artifact_role' is distinct from 'clued_resource' or am->>'source_path' is not null then
    raise exception 'storage_job_attempt_mismatch' using errcode='42501'; end if;
  prepared:=public.clued_resource_center_write_v1(p_writer_hash,p_prepare);
  if prepared->>'state' is distinct from 'prepared' or prepared->>'status' is distinct from 'committed' then
    raise exception 'storage_job_prepare_denied' using errcode='42501'; end if;
  started:=public.clued_resource_center_write_v1(p_writer_hash,jsonb_build_object('action','start',
    'intent_id',prepared->'intent_id','base_version',prepared->'version','request_sha256',prepared->'request_sha256',
    'idempotency_key','account-job:'||p_job::text||':start'));
  if started->>'state' is distinct from 'started' or started->'execution_permitted' is distinct from 'true'::jsonb then
    raise exception 'storage_job_start_denied' using errcode='42501'; end if;
  update clued_private.storage_jobs_v1 set intent_id=(started->>'intent_id')::uuid where owner_id=p_owner and job_id=p_job;
  -- Expiry during profile/journal/receipt locks rolls back the whole attempt.
  perform clued_private.storage_cloud_job_current_v2(p_owner,p_job);
  return started||jsonb_build_object('job_id',p_job,'job_request_digest',j.request_digest);
end $$;

create function clued_private.storage_job_provider_attempt_v2(
  p_owner uuid,p_job uuid,p_writer_hash text,p_attempt jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; m clued_private.resource_center_mutations_v1;
  inspected jsonb; expected jsonb; r public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
begin
  perform clued_private.storage_cloud_job_current_v2(p_owner,p_job);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
  if j.intent_id is null then raise exception 'storage_attempt_unavailable' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text||':'||p.root_folder_id,0));
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner for share;
  if not found or c.auth_mode<>'account_policy' then raise exception 'storage_cloud_mode_denied' using errcode='42501'; end if;
  -- Existing writer resolution checks owner/profile/Decision and serializes
  -- revocation. No additional execution permit is acquired here.
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner and profile_id=p.id;
  if m.writer_binding_id is distinct from j.cloud_writer_binding_id
    or not exists(select 1 from clued_private.resource_center_writer_bindings_v1
      where id=j.cloud_writer_binding_id and token_hash=p_writer_hash) then
    raise exception 'storage_attempt_mismatch' using errcode='42501'; end if;
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
  perform clued_private.storage_cloud_job_current_v2(p_owner,p_job);
  return jsonb_build_object('status','committed','attempt_recorded',true,'receipt_id',r.id,'attempt',p_attempt);
end $$;

create function clued_private.storage_job_finalize_v2(p_owner uuid,p_job uuid,p_writer_hash text,p_finish jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; m clued_private.resource_center_mutations_v1; result jsonb;
begin
  -- Active-only settlement. Revocation/expiry keeps the original unresolved
  -- intent; no stored provider attempt is mistaken for a verified result.
  perform clued_private.storage_cloud_job_current_v2(p_owner,p_job);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
  if j.intent_id is null then raise exception 'storage_attempt_unavailable' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=p_owner;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text||':'||p.root_folder_id,0));
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=p_owner for share;
  if not found or c.auth_mode<>'account_policy' then raise exception 'storage_cloud_mode_denied' using errcode='42501'; end if;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner and profile_id=p.id;
  if m.writer_binding_id is distinct from j.cloud_writer_binding_id
    or not exists(select 1 from clued_private.resource_center_writer_bindings_v1
      where id=j.cloud_writer_binding_id and token_hash=p_writer_hash)
    or m.provider_attempt is null or p_finish->>'action' is distinct from 'finalize' or
    p_finish->>'intent_id' is distinct from m.id::text or p_finish->>'request_sha256' is distinct from m.request_sha256 or
    p_finish->'postcondition'->>'provider_file_id' is distinct from m.provider_attempt->>'provider_file_id' or
    p_finish->'postcondition'->>'path' is distinct from m.provider_attempt->>'destination_path' or
    p_finish->'postcondition'->>'parent_id' is distinct from m.provider_attempt->>'parent_id' then
    raise exception 'storage_attempt_postcondition_mismatch' using errcode='42501'; end if;
  result:=public.clued_resource_center_write_v1(p_writer_hash,p_finish);
  perform clued_private.storage_cloud_job_current_v2(p_owner,p_job);
  return result;
end $$;

create function clued_private.storage_cloud_worker_v2(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; c clued_private.storage_connections_v1;
  j clued_private.storage_jobs_v1; p clued_private.resource_center_profiles_v1;
  b public.clued_agent_bindings; w clued_private.resource_center_writer_bindings_v1;
  a clued_private.resource_center_bindings_v1; result jsonb; wanted text; op text:=p_input->>'action';
  issued jsonb; expiry timestamptz; nonce text; writer_hash text; reader_hash text;
  receipt public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
begin
  -- No durable verified-result settlement exists in this increment. Never
  -- issue recovery credentials, renew a writer, or release an unknown fence.
  if op in ('recovery_load','recovery_finalize') then raise exception 'storage_cloud_recovery_unavailable' using errcode='42501'; end if;
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
  select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=(p_input->>'job_id')::uuid and connection_id=c.id;
  if not found then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  select * into b from public.clued_agent_bindings where id=j.binding_id and user_id=c.owner_id;
  wanted:=case when j.mutation->>'target_kind'='file' then 'create_file' else 'create_topic' end;
  -- Evaluator owns lineage -> job -> root -> identity/policy locks. Do not
  -- acquire the job/root guard before it (global deny uses lineage X).
  perform clued_private.storage_cloud_job_current_v2(c.owner_id,j.job_id);
  select * into c from clued_private.storage_connections_v1 where id=c.id for share;
  if c.auth_mode is distinct from 'account_policy' then raise exception 'storage_cloud_mode_denied' using errcode='42501'; end if;
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
    perform clued_private.storage_cloud_job_current_v2(c.owner_id,j.job_id);
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
    perform clued_private.storage_cloud_job_current_v2(c.owner_id,j.job_id);
    return result;
  end if;
  if w.id is null then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
  if op='authority' then
    select * into a from clued_private.resource_center_bindings_v1 where id=w.authority_binding_id;
    if p_input->'request'->>'profile_id' is distinct from p.id::text then raise exception 'storage_cloud_denied' using errcode='42501'; end if;
    perform clued_private.storage_cloud_job_mutation_v2(j.mutation,p_input->'request'->'mutation');
    result:=public.clued_resource_center_authority_v1(a.token_hash,p_input->'request');
    perform clued_private.storage_cloud_job_current_v2(c.owner_id,j.job_id);
    return result||jsonb_build_object('request',p_input->'request');
  elsif op='begin' then return clued_private.storage_job_begin_v2(c.owner_id,j.job_id,w.token_hash,p_input->'prepare');
  elsif op='provider_attempt' then return clued_private.storage_job_provider_attempt_v2(c.owner_id,j.job_id,w.token_hash,p_input->'attempt');
  else return clued_private.storage_job_finalize_v2(c.owner_id,j.job_id,w.token_hash,p_input->'finish'); end if;
end $$;

-- Preserve both legacy public RPC bodies and their established validation
-- order/error contracts. Their existing root-locked legacy mode fence remains.
-- Only the new routers add snapshot checks around legacy dispatch. Account jobs
-- cannot legitimately become legacy: snapshots are immutable and a transitioned
-- connection cannot switch back to legacy through the accepted contracts.
alter function public.clued_storage_jobs_v2(text,jsonb) set schema clued_private;
alter function clued_private.clued_storage_jobs_v2(text,jsonb) rename to storage_jobs_policy_core_v2;
revoke all on function clued_private.storage_jobs_policy_core_v2(text,jsonb)
  from public,anon,authenticated,service_role;

create function clued_private.storage_jobs_mode_v2(p_hash text,p_input jsonb,p_mode text)
returns void language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; j clued_private.storage_jobs_v1; u uuid;
begin
  select user_id into u from public.clued_agent_bindings where token_hash=p_hash;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
  select * into j from clued_private.storage_jobs_v1 where owner_id=u and job_id=(p_input->>'job_id')::uuid;
  if c.id is null or (j.job_id is not null and j.connection_id<>c.id)
    or (p_mode='legacy' and (c.auth_mode<>'legacy' or j.authority_snapshot_v2 is not null))
    or (p_mode='account_policy' and
      (c.auth_mode not in ('account_policy','revoked')
       or (j.job_id is not null and j.authority_snapshot_v2 is null)
       or (c.auth_mode='revoked' and j.job_id is null)))
    or p_mode not in ('legacy','account_policy') then
    raise exception 'storage_job_mode_denied' using errcode='42501'; end if;
end $$;

create function public.clued_storage_jobs_v2(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform clued_private.storage_jobs_mode_v2(p_token_hash,p_input,'account_policy');
  result:=clued_private.storage_jobs_policy_core_v2(p_token_hash,p_input);
  perform clued_private.storage_jobs_mode_v2(p_token_hash,p_input,'account_policy');
  return result;
end $$;
create function public.clued_storage_jobs_router_v2(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare mode text; result jsonb;
begin
  -- Unlocked dispatch hint only. Neither an exception nor a timeout falls back.
  select c.auth_mode into mode from clued_private.storage_connections_v1 c
    join public.clued_agent_bindings b on b.user_id=c.owner_id
    where c.id=(p_input->>'connection_id')::uuid and b.token_hash=p_token_hash;
  if mode='legacy' then
    perform clued_private.storage_jobs_mode_v2(p_token_hash,p_input,'legacy');
    result:=public.clued_storage_jobs_v1(p_token_hash,p_input);
    -- The original RPC now holds job/root/connection locks. Recheck the
    -- dispatch hint without altering direct v1 callers' validation order.
    perform clued_private.storage_jobs_mode_v2(p_token_hash,p_input,'legacy');
    return result;
  elsif mode in ('account_policy','revoked') then return public.clued_storage_jobs_v2(p_token_hash,p_input);
  else raise exception 'storage_job_mode_denied' using errcode='42501'; end if;
end $$;

create function clued_private.storage_cloud_mode_v2(p_issuer_hash text,p_input jsonb,p_mode text)
returns void language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; j clued_private.storage_jobs_v1;
begin
  select c0.* into c from clued_private.storage_connections_v1 c0
    join clued_private.storage_oauth_apps_v1 app on app.oauth_client_id=c0.oauth_client_id
    where c0.id=(p_input->>'connection_id')::uuid and app.issuer_hash=p_issuer_hash
      and app.revoked_at is null and app.execution_enabled;
  select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=(p_input->>'job_id')::uuid;
  if c.id is null or j.job_id is null or j.connection_id<>c.id or c.auth_mode is distinct from p_mode
    or (p_mode='legacy' and j.authority_snapshot_v2 is not null)
    or (p_mode='account_policy' and j.authority_snapshot_v2 is null)
    or p_mode not in ('legacy','account_policy') then
    raise exception 'storage_cloud_mode_denied' using errcode='42501'; end if;
end $$;
create function public.clued_storage_cloud_worker_router_v2(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare mode text; result jsonb;
begin
  select c.auth_mode into mode from clued_private.storage_connections_v1 c
    join clued_private.storage_oauth_apps_v1 app on app.oauth_client_id=c.oauth_client_id
    where c.id=(p_input->>'connection_id')::uuid and app.issuer_hash=p_issuer_hash
      and app.revoked_at is null and app.execution_enabled;
  if mode='legacy' then
    perform clued_private.storage_cloud_mode_v2(p_issuer_hash,p_input,'legacy');
    result:=public.clued_storage_cloud_worker_v1(p_issuer_hash,p_input);
    perform clued_private.storage_cloud_mode_v2(p_issuer_hash,p_input,'legacy');
    return result;
  elsif mode='account_policy' then
    perform clued_private.storage_cloud_mode_v2(p_issuer_hash,p_input,'account_policy');
    result:=clued_private.storage_cloud_worker_v2(p_issuer_hash,p_input);
    perform clued_private.storage_cloud_mode_v2(p_issuer_hash,p_input,'account_policy');
    return result;
  else raise exception 'storage_cloud_mode_denied' using errcode='42501'; end if;
end $$;

revoke all on function clued_private.storage_cloud_job_current_v2(uuid,uuid),
  clued_private.storage_cloud_job_mutation_v2(jsonb,jsonb),
  clued_private.storage_job_begin_v2(uuid,uuid,text,jsonb),
  clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb),
  clued_private.storage_job_finalize_v2(uuid,uuid,text,jsonb),
  clued_private.storage_cloud_worker_v2(text,jsonb),
  clued_private.storage_jobs_mode_v2(text,jsonb,text),
  clued_private.storage_cloud_mode_v2(text,jsonb,text)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_jobs_v2(text,jsonb),
  public.clued_storage_jobs_router_v2(text,jsonb),
  public.clued_storage_cloud_worker_router_v2(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_jobs_v2(text,jsonb),
  public.clued_storage_jobs_router_v2(text,jsonb),
  public.clued_storage_cloud_worker_router_v2(text,jsonb) to anon;
