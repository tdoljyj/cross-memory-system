-- Attach the one provider dispatch identity to the ORIGINAL mutation journal.
-- No second attempt ledger, new retry permit, timeout reset or root fence.
alter table clued_private.resource_center_mutations_v1
  add column provider_attempt jsonb,
  add column provider_attempt_receipt_id uuid references public.clued_audit_receipts(id),
  add constraint resource_center_provider_attempt_pair_v1 check
    ((provider_attempt is null)=(provider_attempt_receipt_id is null));

-- Internal composition only. A qualified fixed issuer must derive owner/job
-- and writer credentials server-side; no public/service-role execute grant.
create function clued_private.storage_job_provider_attempt_v1(
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
revoke all on function clued_private.storage_job_provider_attempt_v1(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;

create function clued_private.storage_job_finalize_v1(p_owner uuid,p_job uuid,p_writer_hash text,p_finish jsonb)
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
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner and profile_id=p.id;
  if m.provider_attempt is null or p_finish->>'action' is distinct from 'finalize' or
    p_finish->>'intent_id' is distinct from m.id::text or p_finish->>'request_sha256' is distinct from m.request_sha256 or
    p_finish->'postcondition'->>'provider_file_id' is distinct from m.provider_attempt->>'provider_file_id' or
    p_finish->'postcondition'->>'path' is distinct from m.provider_attempt->>'destination_path' or
    p_finish->'postcondition'->>'parent_id' is distinct from m.provider_attempt->>'parent_id' then
    raise exception 'storage_attempt_postcondition_mismatch' using errcode='42501'; end if;
  return public.clued_resource_center_write_v1(p_writer_hash,p_finish);
end $$;
revoke all on function clued_private.storage_job_finalize_v1(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
