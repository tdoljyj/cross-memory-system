-- Recovery-only successor. No table grants, credential changes, execution flags
-- or new writer/admission. The existing automatic cloud bridge stays active-only.
-- Native sessions and the fixed private issuer must BOTH authorize every call.
create function clued_private.storage_connection_recovery_v1(p_connection uuid,p_owner uuid)
returns clued_private.storage_connections_v1 language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
begin
  perform clued_private.authorization_account_v12(p_owner);
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=p_owner for share;
  if not found or c.state not in ('active','reauthorization_required') or c.revoked_at is not null then
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
revoke all on function clued_private.storage_connection_recovery_v1(uuid,uuid) from public,anon,authenticated,service_role;


-- Internal shared settlement transaction; not callable by any API role.
create function clued_private.storage_cloud_settle_core_v1(p_owner uuid,p_job uuid,p_action text,p_finish jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; m clued_private.resource_center_mutations_v1;
  r public.clued_audit_receipts; refs jsonb; ev text; issued jsonb; registered jsonb;
  reader_hash text; req jsonb; result jsonb;
begin
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job for update;
  c:=clued_private.storage_connection_recovery_v1(j.connection_id,p_owner);
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and profile_id=p.id and user_id=p_owner for update;
  if m.id is null or m.provider_attempt is null or m.state not in ('started','uncertain') or
    m.profile_version<>p.version or m.writer_binding_id is distinct from j.cloud_writer_binding_id then
    raise exception 'storage_recovery_unavailable' using errcode='42501'; end if;
  if p_action='recovery_load' then
    return jsonb_build_object('status','recovery_only','owner_id',p_owner,'connection_id',c.id,'job_id',j.job_id,
      'provider','google-drive','provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,
      'credential_version',c.credential_version,'credential_envelope',c.credential_envelope,
      'profile',jsonb_build_object('managed_root',p.managed_root),'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,
      'mutation',m.exact_request->'mutation','provider_before',m.authority_request->'provider_identity',
      'attempt',m.provider_attempt,'intent_id',m.id,'version',m.version,'request_sha256',m.request_sha256);
  end if;
  if p_action<>'recovery_finalize' or (p_finish-array['intent_id','base_version','request_sha256','postcondition'])<>'{}'::jsonb or
    p_finish->>'intent_id' is distinct from m.id::text or p_finish->>'base_version' is distinct from m.version::text or
    p_finish->>'request_sha256' is distinct from m.request_sha256 or
    p_finish->'postcondition'->>'path' is distinct from m.provider_attempt->>'destination_path' or
    p_finish->'postcondition'->>'parent_id' is distinct from m.provider_attempt->>'parent_id' or
    p_finish->'postcondition'->>'provider_file_id' is distinct from m.provider_attempt->>'provider_file_id' or
    coalesce(p_finish->'postcondition'->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$' then
    raise exception 'storage_recovery_mismatch' using errcode='42501'; end if;
  reader_hash:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
  issued:=public.clued_resource_center_admin_v1(p_owner,jsonb_build_object('action','binding_issue','profile_id',p.id,
    'source_decision_id',m.source_decision_id,'idempotency_key','cloud-recovery-read:'||gen_random_uuid()::text,
    'token_hash',reader_hash,'expires_at',clock_timestamp()+interval '2 minutes'));
  if issued->>'status' is distinct from 'committed' or
    public.clued_resource_center_authority_v1(reader_hash,m.authority_request) is distinct from m.authority_result then
    raise exception 'storage_recovery_authority_changed' using errcode='42501'; end if;
  req:=jsonb_build_object('idempotency_key','cloud-recovery-finalize:'||m.id::text,'intent_id',m.id,'finish',p_finish);
  r:=clued_private.m1_begin_receipt(p_owner,null,'storage_recovery_finalize',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_recovery_conflict' using errcode='40001'; end if;
  registered:=public.clued_resource_center_admin_v1(p_owner,jsonb_build_object('action','artifact_register','profile_id',p.id,
    'source_decision_id',m.source_decision_id,'idempotency_key','resource-center-finalize:'||m.id::text,
    'path',p_finish->'postcondition'->>'path','provider_file_id',p_finish->'postcondition'->>'provider_file_id',
    'provider_file_version',p_finish->'postcondition'->>'provider_file_version','target_kind',m.authority_request->'mutation'->>'target_kind',
    'governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false));
  if registered->>'status' is distinct from 'committed' then raise exception 'storage_recovery_registration_failed' using errcode='40001'; end if;
  update clued_private.resource_center_mutations_v1 set state='committed',version=version+1,updated_at=clock_timestamp(),
    receipt_id=r.id,final_result=registered where id=m.id returning * into m;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
  ev:=clued_private.m1_append_event_row(p_owner,null,r.id,r.canonical_version,'extension:storage:recovery_finalized',refs,
    'project:'||p.project_id::text,null,jsonb_build_object('intent_id',m.id,'state',m.state),req->>'idempotency_key',r.request_sha256,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,jsonb_build_object(m.id::text,m.version),array[ev],'{}'::uuid[],null);
  return result||jsonb_build_object('state','committed','intent_id',m.id,'execution_permitted',false);
end $$;
revoke all on function clued_private.storage_cloud_settle_core_v1(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;


-- Preserve the existing active-only contract for every existing caller.
create or replace function clued_private.storage_cloud_recover_v1(p_owner uuid,p_job uuid,p_action text,p_finish jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;
begin
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job;
  perform clued_private.storage_connection_current_v1(j.connection_id,p_owner);
  return clued_private.storage_cloud_settle_core_v1(p_owner,p_job,p_action,p_finish);
end $$;
revoke all on function clued_private.storage_cloud_recover_v1(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;

-- Server-only RPC: native Owner session + fixed issuer. Never expose its loaded
-- credential envelope to the browser/Agent. Lock order follows the cloud bridge:
-- issuer -> owner/job -> provider root -> account/connection/profile/Decision ->
-- job/journal. A client grant may have expired; this path grants no new execution.
create function public.clued_storage_native_recovery_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  app clued_private.storage_oauth_apps_v1; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; j clued_private.storage_jobs_v1;
  d jsonb; result jsonb; bound text; root_id text;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or
    coalesce(op,'') not in ('recovery_load','recovery_finalize','recovery_inspect') or
    (op in ('recovery_load','recovery_inspect') and p_input is distinct from jsonb_build_object(
      'action',op,'connection_id',p_input->>'connection_id','job_id',p_input->>'job_id')) or
    (op='recovery_finalize' and (p_input-array['action','connection_id','job_id','credential_version','recovery_binding','finish'])<>'{}'::jsonb) then
    raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1
    where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'storage-job:'||u::text||':'||(p_input->>'job_id')::uuid::text,0));
  select * into j from clued_private.storage_jobs_v1
    where owner_id=u and job_id=(p_input->>'job_id')::uuid and connection_id=(p_input->>'connection_id')::uuid;
  if not found then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  if op='recovery_inspect' then
    -- Lost settlement replies are resolved by reading the ORIGINAL durable job,
    -- including after connection revocation. No credential or execute authority.
    select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=u for share;
    if c.id is null or c.oauth_client_id is distinct from app.oauth_client_id then
      raise exception 'storage_recovery_denied' using errcode='42501'; end if;
    result:=clued_private.storage_job_status_v1(j);
    perform clued_private.storage_owner_v1();
    return result;
  end if;
  select pr.root_folder_id into root_id from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
    where co.id=j.connection_id and co.owner_id=u;
  if root_id is null then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root_id,0));
  -- Do NOT call root_quiet: this can only settle this exact existing fence.
  c:=clued_private.storage_connection_recovery_v1(j.connection_id,u);
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id;
  if c.oauth_client_id is distinct from app.oauth_client_id or c.provider_subject is null or
    c.credential_version<1 or not clued_private.storage_envelope_valid_v1(c.credential_envelope) then
    raise exception 'storage_recovery_denied' using errcode='42501'; end if;
  d:=clued_private.storage_cloud_settle_core_v1(u,j.job_id,'recovery_load');
  -- This is a CAS fingerprint, NOT a bearer capability. Both calls independently
  -- authenticate Owner/issuer and lock/recheck current authority. Include the
  -- entire original attempt and encrypted credential, not just its file ID.
  bound:=clued_private.m1_sha256(jsonb_build_object('descriptor',d,'connection_version',c.version,
    'connection_state',c.state,'job_digest',j.request_digest,'profile_version',p.version,
    'native_session',auth.jwt()->>'session_id','issuer',app.issuer_hash));
  if op='recovery_load' then result:=d||jsonb_build_object('recovery_binding',bound);
  else
    if p_input->>'recovery_binding' is distinct from bound or
      p_input->>'credential_version' is distinct from c.credential_version::text then
      raise exception 'storage_recovery_stale' using errcode='40001'; end if;
    result:=clued_private.storage_cloud_settle_core_v1(u,j.job_id,'recovery_finalize',p_input->'finish');
  end if;
  -- Recheck expiry after any lock wait; rollback all settlement writes if stale.
  perform clued_private.storage_owner_v1();
  return result;
end $$;
revoke all on function public.clued_storage_native_recovery_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_native_recovery_v1(text,jsonb) to authenticated;
