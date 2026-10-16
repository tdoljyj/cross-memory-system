-- StorageRegistrationRecovery.v0.1 / Task 9a263b02. Metadata-only recovery of
-- one existing file before a new job reserves an intent. No public RPC, ACL,
-- admission, snapshot, unknown-effect fence or provider effect is changed.
do $source$
declare body text;
begin
 if md5(pg_get_functiondef('clued_private.ii_priv_storage_cloud_worker_v2(text,jsonb)'::regprocedure))
    is distinct from '2e6fca33c2489cccc4ca85cb0853b25a' then
  raise exception 'storage_registration_source_mismatch' using errcode='55000'; end if;
 body:=pg_get_functiondef('clued_private.ii_priv_storage_cloud_worker_v2(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.ii_priv_storage_cloud_worker_v2(',
  'FUNCTION clued_private.storage_cloud_before_registration_v1(');
end $source$;
revoke all on function clued_private.storage_cloud_before_registration_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Technical work only. It never becomes an admission, intent or root fence.
create table clued_private.storage_registration_checks_v1(
 owner_id uuid not null, job_id uuid primary key, artifact_id uuid not null,
 registration jsonb not null, recovery_key text not null unique,
 state text not null check(state in ('checking','retry_wait','commit_unknown','confirming','resolved','superseded','failed')),
 lease_id uuid not null, lease_until timestamptz not null,
 attempts integer not null check(attempts between 1 and 6), next_at timestamptz not null,
 expires_at timestamptz not null, reason_code text, receipt_id uuid,
 version bigint not null default 1, updated_at timestamptz not null default clock_timestamp());
create unique index storage_registration_checks_active_object_v1
 on clued_private.storage_registration_checks_v1(owner_id,artifact_id)
 where state in ('checking','retry_wait','commit_unknown');
alter table clued_private.storage_registration_checks_v1 enable row level security;
revoke all on clued_private.storage_registration_checks_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

-- The same dispatch outcome key as a normal pre-intent report. A precise
-- technical reason lives in the private sidecar/status, not a second job truth.
create function clued_private.storage_registration_finish_v1(p_job clued_private.storage_jobs_v1,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; p clued_private.resource_center_profiles_v1;
 r public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
begin
 select * into j from clued_private.storage_jobs_v1 where owner_id=p_job.owner_id and job_id=p_job.job_id for update;
 if j.intent_id is not null or j.dispatch_outcome is not null or j.authority_snapshot_v2 is null then return; end if;
 select pr.* into p from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 pr
  on pr.id=c.profile_id and pr.user_id=c.owner_id where c.id=j.connection_id and c.owner_id=j.owner_id;
 req:=jsonb_build_object('idempotency_key','cloud-dispatch-outcome:'||j.job_id,'job_id',j.job_id,
  'outcome',jsonb_build_object('status','attention_required','reason',jsonb_build_object('code','ARTIFACT_VERSION_MISMATCH')));
 r:=clued_private.m1_begin_receipt(j.owner_id,null,'storage_dispatch_outcome',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then return; end if;
 update clued_private.storage_jobs_v1 set dispatch_outcome=req->'outcome',dispatch_outcome_receipt_id=r.id
  where owner_id=j.owner_id and job_id=j.job_id;
 update clued_private.storage_registration_checks_v1 set state='failed',reason_code=p_reason,
  lease_id=gen_random_uuid(),lease_until=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
  where owner_id=j.owner_id and job_id=j.job_id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',j.job_id));
 ev:=clued_private.m1_append_event_row(j.owner_id,null,r.id,r.canonical_version,'extension:storage:dispatch_outcome',
  refs,'project:'||p.project_id,null,jsonb_build_object('job_id',j.job_id,'registration_reason',p_reason),
  req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}','{}',array[ev],'{}'::uuid[],null);
end $$;
revoke all on function clued_private.storage_registration_finish_v1(clued_private.storage_jobs_v1,text)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_registration_recovery_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op text:=p_input->>'action'; normal jsonb; authority jsonb; registration jsonb; supplied jsonb;
 j clued_private.storage_jobs_v1; c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
 a clued_private.resource_center_artifacts_v1; parent clued_private.resource_center_artifacts_v1;
 previous clued_private.resource_center_artifacts_v1; source_version bigint; ancestors jsonb;
 first jsonb; second jsonb; first_at timestamptz; second_at timestamptz;
 key text; req jsonb; r public.clued_audit_receipts; registry public.clued_audit_receipts;
 updated jsonb; refs jsonb; ev text; registry_id uuid; expected text;
 check_row clued_private.storage_registration_checks_v1; reason text; now_at timestamptz:=clock_timestamp();
begin
 if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('registration_load','registration_commit','registration_inspect','registration_defer')
  or jsonb_typeof(p_input->'request') is distinct from 'object'
  or jsonb_typeof(p_input->'credential_version') is distinct from 'number'
  or p_input-array['action','connection_id','job_id','credential_version','request',
    case when op<>'registration_load' then 'registration' end,case when op<>'registration_load' then 'lease_id' end,
    case when op='registration_commit' then 'observations' end,case when op='registration_defer' then 'reason_code' end]<>'{}'
  or (op<>'registration_load' and (jsonb_typeof(p_input->'registration') is distinct from 'object'
   or jsonb_typeof(p_input->'lease_id') is distinct from 'string')) then
  raise exception 'storage_registration_invalid' using errcode='22023'; end if;
 -- This preserved implementation owns the full issuer/app/client/Binding/
 -- Policy/credential/claim/qualification/Currentness and lock-order boundary.
 -- Calling a partial local copy of that qualification would be unsafe.
 normal:=jsonb_build_object('action','authority','connection_id',p_input->'connection_id','job_id',p_input->'job_id',
  'credential_version',p_input->'credential_version','request',p_input->'request');
 authority:=clued_private.storage_cloud_before_registration_v1(p_issuer_identity,normal);
 if authority->'request' is distinct from p_input->'request' then
  raise exception 'storage_registration_denied' using errcode='42501'; end if;
 select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid;
 select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and connection_id=c.id and job_id=(p_input->>'job_id')::uuid;
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=j.owner_id;
 expected:=j.mutation->>'destination_file_version';
 if j.job_id is null or j.intent_id is not null or j.dispatch_outcome is not null or j.authority_snapshot_v2 is null
  or j.mutation->>'operation' is distinct from 'replace' or j.mutation->>'target_kind' is distinct from 'file'
  or coalesce(expected,'')!~'^[1-9][0-9]{0,39}$'
  or expected is distinct from p_input->'request'->'provider_identity'->>'destination_file_version'
  or p_input->'request'->'provider_identity'->>'root_folder_id' is distinct from p.root_folder_id
  or p_input->'request'->'provider_identity'->>'root_parent_id' is distinct from p.root_parent_id then
  raise exception 'storage_registration_denied' using errcode='42501'; end if;
 perform clued_private.storage_root_quiet_v1(j.owner_id,p.root_folder_id);
 perform clued_private.storage_conflict_assert_v1(j.owner_id,p.id,j.mutation,p_input->'request'->'provider_identity');
 select * into a from clued_private.resource_center_artifacts_v1 where user_id=j.owner_id and profile_id=p.id
  and path=j.mutation->>'destination_path' and provider_file_id=p_input->'request'->'provider_identity'->>'destination_file_id'
  and target_kind='file' and state='active' for update;
 if a.id is null then raise exception 'storage_registration_denied' using errcode='42501'; end if;
 select * into parent from clued_private.resource_center_artifacts_v1 where user_id=j.owner_id and profile_id=p.id
  and path=regexp_replace(a.path,'/[^/]+$','') and target_kind='directory' and state='active' for share;
 if parent.id is null or parent.provider_file_id is distinct from p_input->'request'->'provider_identity'->>'destination_parent_id' then
  raise exception 'storage_registration_denied' using errcode='42501'; end if;
 perform 1 from public.clued_memories where id=a.source_decision_id and user_id=j.owner_id for share;
 select version into source_version from public.clued_memories where id=a.source_decision_id and user_id=j.owner_id;
 if not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,a.source_decision_id)
  or not clued_private.resource_center_path_current_v1(j.owner_id,p.project_id,p.id,p.managed_root,a.path)
  or (p_input->'request'->'provider_identity' ? 'ancestors' and
    clued_private.resource_center_ancestors_match_v1(p,p_input->'request'->'provider_identity',p_input->'request'->'mutation')<>'match') then
  raise exception 'storage_registration_denied' using errcode='42501'; end if;
 select clued_private.resource_center_ancestor_rows_identity_v1(coalesce(jsonb_agg(to_jsonb(x) order by x.path collate "C"),'[]'))
  into ancestors from clued_private.resource_center_ancestor_rows_v1(p.id,j.owner_id,
   clued_private.resource_center_ancestor_parents_v1(j.mutation)) x;
 select * into check_row from clued_private.storage_registration_checks_v1 where owner_id=j.owner_id and job_id=j.job_id for update;
 registration:=jsonb_build_object('artifact_id',a.id,'artifact_version',a.version,'artifact_receipt_id',a.receipt_id,
  'source_decision_id',a.source_decision_id,'source_decision_version',source_version,'profile_id',p.id,'profile_version',p.version,
  'request_digest',j.request_digest,'credential_version',c.credential_version,'expected_version',expected,'registered_version',a.provider_file_version,
  'path',a.path,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'provider_file_id',a.provider_file_id,
  'parent_provider_id',parent.provider_file_id,'parent_artifact_id',parent.id,'parent_artifact_version',parent.version,
  'registration_digest',clued_private.m1_sha256(to_jsonb(a)),'ancestors_digest',clued_private.m1_sha256(ancestors));
 if op='registration_load' then
  if check_row.job_id is not null then
   if check_row.state='failed' then
    return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','failed','reason_code',check_row.reason_code,
     'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
   if check_row.state in ('resolved','confirming') then
    if now_at>=check_row.expires_at or (check_row.attempts>=6 and check_row.lease_until<=now_at) then
     perform clued_private.storage_registration_finish_v1(j,'REGISTRATION_RETRY_EXHAUSTED');
     return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','failed','reason_code','REGISTRATION_RETRY_EXHAUSTED',
      'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
    if check_row.next_at>now_at or (check_row.state='confirming' and check_row.lease_until>now_at) then
     return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','busy',
      'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
    update clued_private.storage_registration_checks_v1 set state='confirming',lease_id=gen_random_uuid(),
     lease_until=now_at+interval '90 seconds',attempts=attempts+1,version=version+1,updated_at=now_at
     where job_id=j.job_id returning * into check_row;
    return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','inspect_required',
     'connection_id',c.id,'job_id',j.job_id,'registration',check_row.registration,'lease_id',check_row.lease_id,'execution_permitted',false); end if;
   if check_row.state<>'commit_unknown' and authority->>'status'='resolved' and a.provider_file_version=expected then
    if check_row.state<>'superseded' then
     update clued_private.storage_registration_checks_v1 set state='superseded',reason_code='REGISTRATION_REFRESHED_BY_ANOTHER_JOB',
      lease_id=gen_random_uuid(),lease_until=now_at,version=version+1,updated_at=now_at where job_id=j.job_id; end if;
    return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','already_current',
     'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
   if now_at>=check_row.expires_at or (check_row.attempts>=6 and check_row.lease_until<=now_at) then
    perform clued_private.storage_registration_finish_v1(j,'REGISTRATION_RETRY_EXHAUSTED');
    return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','failed','reason_code','REGISTRATION_RETRY_EXHAUSTED',
     'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
   if check_row.next_at>now_at or (check_row.state in ('checking','commit_unknown') and check_row.lease_until>now_at) then
    return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','busy',
     'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
   -- A crashed checking holder may have sent a metadata commit. Its successor
   -- must inspect the original key before new authority can admit any effect.
   update clued_private.storage_registration_checks_v1 set
    state=case when state in ('checking','commit_unknown') then 'commit_unknown' else 'checking' end,
    lease_id=gen_random_uuid(),lease_until=now_at+interval '90 seconds',attempts=attempts+1,
    version=version+1,updated_at=now_at where job_id=j.job_id returning * into check_row;
   return jsonb_build_object('contract','clued.storage-registration-recovery/1',
    'status',case when check_row.state='commit_unknown' then 'inspect_required' else 'refreshable' end,
    'connection_id',c.id,'job_id',j.job_id,'registration',check_row.registration,'lease_id',check_row.lease_id,'execution_permitted',false);
  end if;
  if authority->>'status'='resolved' and a.provider_file_version=expected then
   return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','already_current',
    'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
  if authority->>'status' is distinct from 'denied' or authority->>'reason' is distinct from 'destination_version_mismatch'
   or a.provider_file_version::numeric>=expected::numeric then raise exception 'storage_registration_denied' using errcode='42501'; end if;
  if exists(select 1 from clued_private.storage_registration_checks_v1 where owner_id=j.owner_id and artifact_id=a.id
    and state in ('checking','retry_wait','commit_unknown')) then
   return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','busy',
    'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
  key:='storage-registration-recovery:'||clued_private.m1_sha256(jsonb_build_object(
   'job_id',j.job_id,'request_digest',j.request_digest,'registration',registration));
  insert into clued_private.storage_registration_checks_v1(owner_id,job_id,artifact_id,registration,recovery_key,state,lease_id,
   lease_until,attempts,next_at,expires_at)
   values(j.owner_id,j.job_id,a.id,registration,key,'checking',gen_random_uuid(),now_at+interval '90 seconds',1,now_at,
    j.created_at+interval '2 hours') returning * into check_row;
  return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','refreshable',
   'connection_id',c.id,'job_id',j.job_id,'registration',registration,'lease_id',check_row.lease_id,'execution_permitted',false);
 end if;
 supplied:=p_input->'registration';
 if supplied-array['artifact_id','artifact_version','artifact_receipt_id','source_decision_id','source_decision_version','profile_id','profile_version',
   'request_digest','credential_version','expected_version','registered_version','path','root_folder_id','root_parent_id','provider_file_id',
   'parent_provider_id','parent_artifact_id','parent_artifact_version','registration_digest','ancestors_digest']<>'{}'
  or supplied->>'artifact_id' is distinct from a.id::text or supplied->>'request_digest' is distinct from j.request_digest
  or supplied->>'expected_version' is distinct from expected or supplied->>'profile_id' is distinct from p.id::text
  or supplied->>'path' is distinct from a.path or supplied->>'provider_file_id' is distinct from a.provider_file_id
  or jsonb_typeof(supplied->'artifact_version') is distinct from 'number'
  or coalesce(supplied->>'registration_digest','')!~'^[0-9a-f]{64}$' then
  raise exception 'storage_registration_invalid' using errcode='22023'; end if;
 key:='storage-registration-recovery:'||clued_private.m1_sha256(jsonb_build_object(
  'job_id',j.job_id,'request_digest',j.request_digest,'registration',supplied));
 if check_row.job_id is null or check_row.registration is distinct from supplied or check_row.recovery_key<>key then
  raise exception 'storage_registration_cas_changed' using errcode='40001'; end if;
 select * into r from public.clued_audit_receipts where user_id=j.owner_id and operation_family='storage_registration_recovery'
  and idempotency_key=key and owns_idempotency_key;
 if op='registration_defer' then
  reason:=p_input->>'reason_code';
  if reason not in ('REGISTRATION_METADATA_UNAVAILABLE','REGISTRATION_COMMIT_UNKNOWN','REGISTRATION_METADATA_CHANGED',
   'REGISTRATION_COMMIT_UNCONFIRMED','REGISTRATION_DESCRIPTOR_INVALID') or reason is null then
   raise exception 'storage_registration_invalid' using errcode='22023'; end if;
  if check_row.lease_id::text is distinct from p_input->>'lease_id' then
   raise exception 'storage_registration_lease_changed' using errcode='40001'; end if;
  if check_row.state='resolved' or r.status='committed' then
   update clued_private.storage_registration_checks_v1 set state='confirming',reason_code='REGISTRATION_COMMIT_UNKNOWN',
    lease_id=gen_random_uuid(),lease_until=now_at,next_at=now_at+interval '2 minutes',version=version+1,updated_at=now_at where job_id=j.job_id;
   return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','inspect_required',
    'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
  if check_row.state not in ('checking','commit_unknown') then raise exception 'storage_registration_lease_changed' using errcode='40001'; end if;
  if reason not in ('REGISTRATION_METADATA_UNAVAILABLE','REGISTRATION_COMMIT_UNKNOWN') then
   perform clued_private.storage_registration_finish_v1(j,reason);
   return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','failed','reason_code',reason,
    'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
  update clued_private.storage_registration_checks_v1 set
   state=case when reason='REGISTRATION_COMMIT_UNKNOWN' or state='commit_unknown' then 'commit_unknown' else 'retry_wait' end,
   reason_code=reason,lease_id=gen_random_uuid(),lease_until=now_at,
   next_at=now_at+least(interval '10 minutes',interval '2 minutes'*power(2,attempts-1)),
   version=version+1,updated_at=now_at where job_id=j.job_id returning * into check_row;
  return jsonb_build_object('contract','clued.storage-registration-recovery/1','status',check_row.state,'reason_code',reason,
   'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false);
 end if;
 if op='registration_inspect' then
  if r.id is not null and (r.status<>'committed' or r.canonical_result is null or r.response_hash is distinct from clued_private.m1_sha256(r.canonical_result)) then
   return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','invalid','reason_code','REGISTRATION_RECEIPT_INVALID',
    'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
  if r.id is null then
   if check_row.lease_id::text is distinct from p_input->>'lease_id' or check_row.state not in ('checking','commit_unknown') then
    raise exception 'storage_registration_lease_changed' using errcode='40001'; end if;
   if supplied is distinct from registration then
    -- A lock-proven absent commit cannot recover an obsolete CAS. End only
    -- this queued job; do not retarget its descriptor or waste retry budget.
    perform clued_private.storage_registration_finish_v1(j,'REGISTRATION_CAS_CHANGED');
    return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','failed','reason_code','REGISTRATION_CAS_CHANGED',
     'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
   -- Full normal locks + this sidecar FOR UPDATE serialize with commit. A
   -- timeout is an exception, never absence. Rotation fences a late request.
   update clued_private.storage_registration_checks_v1 set state='retry_wait',reason_code='REGISTRATION_COMMIT_NOT_APPLIED',
    lease_id=gen_random_uuid(),lease_until=now_at,next_at=now_at+interval '2 minutes',version=version+1,updated_at=now_at where job_id=j.job_id;
   return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','retry_wait','reason_code','REGISTRATION_COMMIT_NOT_APPLIED',
    'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
 else
  if jsonb_typeof(p_input->'observations') is distinct from 'array' or jsonb_array_length(p_input->'observations')<>2 then
   raise exception 'storage_registration_invalid' using errcode='22023'; end if;
  req:=jsonb_build_object('idempotency_key',key,'connection_id',c.id,'job_id',j.job_id,'request_digest',j.request_digest,
   'registration',supplied,'observations',p_input->'observations');
  if r.id is not null then
   if r.status<>'committed' or r.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object(
     'operation','storage_registration_recovery','payload',req-'idempotency_key')) then
    raise exception 'storage_registration_replay_conflict' using errcode='40001'; end if;
  else
   if check_row.state<>'checking' or check_row.lease_id::text is distinct from p_input->>'lease_id'
    or check_row.lease_until<=now_at or now_at>=check_row.expires_at then
    raise exception 'storage_registration_lease_changed' using errcode='40001'; end if;
   -- Another qualified job can win between our metadata reads and CAS. This
   -- is a read-only current result, never this job's recovery success/Receipt.
   if authority->>'status'='resolved' and a.provider_file_version=expected then
    update clued_private.storage_registration_checks_v1 set state='superseded',reason_code='REGISTRATION_REFRESHED_BY_ANOTHER_JOB',
     lease_id=gen_random_uuid(),lease_until=now_at,version=version+1,updated_at=now_at where job_id=j.job_id;
    return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','already_current',
     'connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
   if supplied is distinct from registration or authority->>'status' is distinct from 'denied'
    or authority->>'reason' is distinct from 'destination_version_mismatch' or a.provider_file_version::numeric>=expected::numeric then
    raise exception 'storage_registration_cas_changed' using errcode='40001'; end if;
   first:=p_input->'observations'->0;second:=p_input->'observations'->1;
   if jsonb_typeof(first) is distinct from 'object' or jsonb_typeof(second) is distinct from 'object'
    or first-array['id','parent_id','name','mime_type','version','trashed','size','sha256','observed_at']<>'{}'
    or second-array['id','parent_id','name','mime_type','version','trashed','size','sha256','observed_at']<>'{}'
    or exists(select 1 from unnest(array['id','parent_id','name','mime_type','version','size','sha256','observed_at']) field
      where jsonb_typeof(first->field) is distinct from 'string')
    or first-'observed_at' is distinct from second-'observed_at'
    or first->>'id' is distinct from a.provider_file_id or first->>'parent_id' is distinct from parent.provider_file_id
    or first->>'name' is distinct from regexp_replace(a.path,'^.*/','') or first->>'version' is distinct from expected
    or first->'trashed' is distinct from 'false'::jsonb or jsonb_typeof(first->'mime_type') is distinct from 'string'
    or coalesce(first->>'mime_type','')='' or first->>'mime_type' like 'application/vnd.google-apps.%'
    or coalesce(first->>'size','')!~'^(0|[1-9][0-9]{0,18})$' or (first->>'size')::numeric>5242880
    or coalesce(first->>'sha256','')!~'^[0-9a-f]{64}$'
    or jsonb_typeof(first->'observed_at') is distinct from 'string' or jsonb_typeof(second->'observed_at') is distinct from 'string' then
    raise exception 'storage_registration_observation_changed' using errcode='40001'; end if;
   first_at:=(first->>'observed_at')::timestamptz;second_at:=(second->>'observed_at')::timestamptz;
   if first_at<clock_timestamp()-interval '30 seconds' or second_at<first_at or second_at>clock_timestamp()+interval '5 seconds' then
    raise exception 'storage_registration_observation_expired' using errcode='40001'; end if;
   previous:=a;
   r:=clued_private.m1_begin_receipt(j.owner_id,null,'storage_registration_recovery',req,clued_private.m1_sha256(req));
   if r.status<>'pending' then raise exception 'storage_registration_replay_conflict' using errcode='40001'; end if;
   updated:=public.clued_resource_center_admin_v1(j.owner_id,jsonb_build_object('action','artifact_update','profile_id',p.id,
    'source_decision_id',a.source_decision_id,'artifact_id',a.id,'base_version',a.version,'path',a.path,
    'provider_file_id',a.provider_file_id,'provider_file_version',expected,'governance_class',a.governance_class,
    'delete_authority',a.delete_authority,'idempotency_key',key||':registry'));
   if updated->>'status' is distinct from 'committed' then
    raise exception 'storage_registration_update_rejected' using errcode='40001'; end if;
   select * into a from clued_private.resource_center_artifacts_v1 where id=previous.id and user_id=j.owner_id;
   registry_id:=a.receipt_id;
   select * into registry from public.clued_audit_receipts where id=registry_id and user_id=j.owner_id
    and operation='resource_center_admin' and status='committed';
   if registry.id is null or a.version<>previous.version+1 or a.provider_file_version<>expected
    or (to_jsonb(a)-array['provider_file_version','version','updated_at','receipt_id'])
      is distinct from (to_jsonb(previous)-array['provider_file_version','version','updated_at','receipt_id']) then
    raise exception 'storage_registration_update_mismatch' using errcode='40001'; end if;
   -- A registration refresh cannot transplant or repair an immutable snapshot.
   perform clued_private.storage_cloud_job_current_v2(j.owner_id,j.job_id);
   refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',a.id),
    jsonb_build_object('kind','system','role','source','id',j.job_id),
    jsonb_build_object('kind','system','role','source','id',registry_id),
    jsonb_build_object('kind','record','role','source','id',a.source_decision_id));
   ev:=clued_private.m1_append_event_row(j.owner_id,null,r.id,r.canonical_version,'extension:storage:registration_recovered',
    refs,'project:'||p.project_id::text,null,jsonb_build_object('job_id',j.job_id,'request_digest',j.request_digest,'artifact_id',a.id,
     'registered_version',previous.provider_file_version,'provider_file_version',expected,'registry_receipt_id',registry_id,
     'observations',p_input->'observations'),key,r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
   perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(a.id::text,previous.version),
    jsonb_build_object(a.id::text,a.version),array[ev],'{}'::uuid[],null);
   select * into r from public.clued_audit_receipts where id=r.id;
  end if;
 end if;
 update clued_private.storage_registration_checks_v1 set state='resolved',receipt_id=r.id,reason_code=null,
  lease_until=now_at,version=version+1,updated_at=now_at where job_id=j.job_id and state<>'resolved';
 select (value->>'id')::uuid into registry_id from jsonb_array_elements(r.target_refs)
  where value->>'kind'='system' and value->>'role'='source' and value->>'id'<>j.job_id::text;
 if registry_id is null or not exists(select 1 from public.clued_audit_receipts where id=registry_id and user_id=j.owner_id
   and operation='resource_center_admin' and status='committed') then
  raise exception 'storage_registration_receipt_invalid' using errcode='42501'; end if;
 return jsonb_build_object('contract','clued.storage-registration-recovery/1','status','committed','connection_id',c.id,'job_id',j.job_id,
  'artifact_id',a.id,'provider_file_version',expected,'receipt_id',r.id,'registration_receipt_id',registry_id,'execution_permitted',false);
end $$;
revoke all on function clued_private.storage_registration_recovery_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function clued_private.ii_priv_storage_cloud_worker_v2(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_input->>'action' in ('registration_load','registration_commit','registration_inspect','registration_defer') then
  return clued_private.storage_registration_recovery_v1(p_issuer_identity,p_input);
 end if;
 if p_input->>'action'='begin' then
  -- Qualification is still evaluated before refusing a pending technical check.
  perform clued_private.storage_cloud_before_registration_v1(p_issuer_identity,
   jsonb_build_object('action','load','connection_id',p_input->'connection_id','job_id',p_input->'job_id'));
  if exists(select 1 from clued_private.storage_registration_checks_v1
   where job_id=(p_input->>'job_id')::uuid and state not in ('resolved','superseded')) then
   raise exception 'storage_registration_pending' using errcode='42501'; end if;
 end if;
 result:=clued_private.storage_cloud_before_registration_v1(p_issuer_identity,p_input);
 if p_input->>'action'='load' and result->>'status'='queued' and exists(select 1 from clued_private.storage_registration_checks_v1
  where owner_id=(result->>'owner_id')::uuid and job_id=(result->>'job_id')::uuid) then
  result:=result||jsonb_build_object('registration_recovery',true); end if;
 return result;
end $$;
revoke all on function clued_private.ii_priv_storage_cloud_worker_v2(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- The issuer-identity writer already emits /3. Recognize its historical,
-- receipt-bound identity in delivery reads without rewriting a saved proof.
-- This helper neither authenticates a caller nor grants an execution permit.
create function clued_private.storage_delivery_issuer_compatible_v1(c clued_private.storage_connections_v1,saved jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare v_generation bigint; at_time timestamptz; matched boolean;
begin
 if jsonb_typeof(saved) is distinct from 'object' then return false; end if;
 if saved->>'contract'='clued.storage-persisted-verification/2' then return true; end if;
 if saved->>'contract' is distinct from 'clued.storage-persisted-verification/3'
  or saved->>'issuer_kind' is distinct from 'storage'
  or jsonb_typeof(saved->'issuer_id') is distinct from 'string'
  or coalesce(saved->>'issuer_id','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  or jsonb_typeof(saved->'credential_generation') is distinct from 'number'
  or coalesce(saved->>'credential_generation','')!~'^[1-9][0-9]{0,18}$'
  or (saved->>'credential_generation')::numeric>9223372036854775807
  or jsonb_typeof(saved->'recorded_at') is distinct from 'string'
  or coalesce(saved->>'recorded_at','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
  or saved ?| array['issuer_hash','issuer_proof','issuer_verifier','credential_proof','verifier','issuer_secret','access_token','refresh_token'] then
  return false; end if;
 v_generation:=(saved->>'credential_generation')::bigint;at_time:=(saved->>'recorded_at')::timestamptz;
 if not isfinite(at_time) then return false; end if;
 select exists(select 1 from clued_private.storage_oauth_apps_v1 app
  join clued_private.issuer_identities_v1 identity on identity.kind='storage' and identity.legacy_key=app.issuer_hash
  join clued_private.issuer_credentials_v1 credential on credential.issuer_id=identity.id and credential.generation=v_generation
  where app.oauth_client_id=c.oauth_client_id and identity.id::text=saved->>'issuer_id'
   and identity.created_at<=at_time and credential.state in ('active','retired')
   and credential.created_at<=at_time and credential.activated_at is not null and credential.activated_at<=at_time
   and (credential.valid_until is null or at_time<credential.valid_until)
   and (credential.retired_at is null or at_time<credential.retired_at)) into matched;
 return coalesce(matched,false);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
 return false;
end $$;
revoke all on function clued_private.storage_delivery_issuer_compatible_v1(clued_private.storage_connections_v1,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

do $delivery$
declare body text; anchor text:=$a$saved is null or saved->>'contract' is distinct from 'clued.storage-persisted-verification/2'$a$;
begin
 body:=pg_get_functiondef('clued_private.task_goal_delivery_file_v1(uuid,text,uuid,jsonb,jsonb,text,boolean)'::regprocedure);
 if md5(body) is distinct from 'dc53be9be32ec60981df092ebd4ca93f'
  or (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
  raise exception 'storage_registration_delivery_source_mismatch' using errcode='55000'; end if;
 execute replace(body,anchor,'saved is null or not clued_private.storage_delivery_issuer_compatible_v1(c,saved)');
end $delivery$;

-- All technical transitions retain immutable, audit-only history.
create function clued_private.storage_registration_check_audit_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare r public.clued_audit_receipts; req jsonb; refs jsonb; ev text; project uuid;
begin
 select p.project_id into project from clued_private.storage_jobs_v1 j join clued_private.storage_connections_v1 c
  on c.id=j.connection_id join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
  where j.owner_id=new.owner_id and j.job_id=new.job_id;
 req:=jsonb_build_object('idempotency_key','storage-registration-check:'||new.job_id||':'||new.version,
  'job_id',new.job_id,'state',new.state,'version',new.version,'attempts',new.attempts,'reason_code',new.reason_code,
  'recovery_key',new.recovery_key,'next_at',new.next_at,'expires_at',new.expires_at);
 r:=clued_private.m1_begin_receipt(new.owner_id,null,'storage_registration_check',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_registration_check_replay_conflict' using errcode='40001'; end if;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',new.job_id));
 ev:=clued_private.m1_append_event_row(new.owner_id,null,r.id,r.canonical_version,'extension:storage:registration_check',
  refs,'project:'||project,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]',null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}','{}',array[ev],'{}'::uuid[],null);
 return new;
end $$;
create trigger storage_registration_check_audit_v1 after insert or update on clued_private.storage_registration_checks_v1
 for each row execute function clued_private.storage_registration_check_audit_v1();
revoke all on function clued_private.storage_registration_check_audit_v1() from public,anon,authenticated,service_role,clued_worker_gateway;

-- All existing legal pre-intent terminal paths (including native level changes
-- that do not use Worker report) release the same technical object check. This
-- derives only from an already-terminal original job; it grants no new rights.
create function clued_private.storage_registration_job_closed_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update clued_private.storage_registration_checks_v1 set state='failed',reason_code=coalesce(reason_code,'REGISTRATION_JOB_CLOSED'),
  lease_id=gen_random_uuid(),lease_until=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
  where owner_id=new.owner_id and job_id=new.job_id and state in ('checking','retry_wait','commit_unknown','confirming');
 return null;
end $$;
create trigger storage_registration_job_closed_v1 after update of dispatch_outcome on clued_private.storage_jobs_v1
 for each row when(new.dispatch_outcome is not null and new.intent_id is null)
 execute function clued_private.storage_registration_job_closed_v1();
revoke all on function clued_private.storage_registration_job_closed_v1() from public,anon,authenticated,service_role,clued_worker_gateway;

do $status$
declare body text;
begin
 body:=pg_get_functiondef('clued_private.storage_job_status_v1(clued_private.storage_jobs_v1)'::regprocedure);
 if md5(body) is distinct from '9421e4bce636df78de040e190c31822d'
  or position('storage_job_status_before_automatic_v1' in body)=0 then raise exception 'storage_registration_status_source_mismatch'; end if;
 execute replace(body,'FUNCTION clued_private.storage_job_status_v1(','FUNCTION clued_private.storage_job_status_before_registration_v1(');
end $status$;
revoke all on function clued_private.storage_job_status_before_registration_v1(clued_private.storage_jobs_v1)
 from public,anon,authenticated,service_role,clued_worker_gateway;
create or replace function clued_private.storage_job_status_v1(p_job clued_private.storage_jobs_v1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb:=clued_private.storage_job_status_before_registration_v1(p_job); q clued_private.storage_registration_checks_v1;
begin
 select * into q from clued_private.storage_registration_checks_v1 where owner_id=p_job.owner_id and job_id=p_job.job_id;
 if q.job_id is not null then result:=result||jsonb_build_object('registration_recovery',jsonb_build_object('state',q.state,
  'reason_code',q.reason_code,'attempts',q.attempts,'next_at',q.next_at,'expires_at',q.expires_at,'receipt_id',q.receipt_id));
  if q.reason_code is not null and (result->>'status'='queued' or
   (result->>'status'='attention_required' and q.state='failed' and q.reason_code<>'REGISTRATION_JOB_CLOSED')) then
   result:=result||jsonb_build_object('reason_code',q.reason_code); end if;
 end if; return result;
end $$;

-- Reuse the existing scheduled queue and its backoff/limit. A metadata check
-- never occupies the root; only this job waits. The normal queue still owns
-- dispatch counting, and the original terminal/no-intent rules are unchanged.
do $queue$
declare body text; anchor text:=$a$        and j0.created_at<=clock_timestamp()-interval '90 seconds'$a$;
 replacement text:=$a$        and j0.created_at<=clock_timestamp()-interval '90 seconds'
        and not exists(select 1 from clued_private.storage_registration_checks_v1 rc where rc.job_id=j0.job_id
          and (rc.state='failed' or (rc.state in ('checking','retry_wait','commit_unknown','confirming') and
            (rc.next_at>clock_timestamp() or rc.lease_until>clock_timestamp()))))$a$;
begin
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_queued_sweep_v1(text,jsonb)'::regprocedure);
 if md5(body) is distinct from 'a45781ec3f5575e9043a3fe7120a3047'
  or (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_registration_queue_source_mismatch'; end if;
 body:=replace(body,anchor,replacement);
 anchor:=$a$      and j0.created_at<=clock_timestamp()-interval '2 hours'$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_registration_queue_timeout_source_mismatch'; end if;
 body:=replace(body,anchor,anchor||$a$
      and not exists(select 1 from clued_private.storage_registration_checks_v1 rc where rc.job_id=j0.job_id
        and rc.state in ('checking','retry_wait','commit_unknown','confirming'))$a$);
 execute replace(body,'FUNCTION clued_private.ii_pub_clued_storage_queued_sweep_v1(',
  'FUNCTION clued_private.storage_queue_before_registration_v1(');
end $queue$;
revoke all on function clued_private.storage_queue_before_registration_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;
create or replace function clued_private.ii_pub_clued_storage_queued_sweep_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; candidate record; j clued_private.storage_jobs_v1; app clued_private.storage_oauth_apps_v1;
 current_check clued_private.storage_registration_checks_v1; count_settled int:=0;
begin
 -- Same exact input/issuer guards as the MD5-bound original sweep; the outer
 -- issuer-proof router still owns authentication. Do not call a mutating sweep
 -- as a validator (that would run its bounded maintenance twice).
 if coalesce(p_issuer_identity,'')!~'^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object' or p_input->>'action' is distinct from 'due'
  or jsonb_typeof(p_input->'dispatch') is distinct from 'boolean' or p_input-array['action','dispatch']<>'{}' then
  raise exception 'storage_queued_sweep_denied' using errcode='42501'; end if;
 select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_identity and revoked_at is null for share;
 if not found then raise exception 'storage_queued_sweep_denied' using errcode='42501'; end if;
 perform pg_catalog.set_config('lock_timeout','2s',true);
 for candidate in select q.owner_id,q.job_id,p.root_folder_id from clued_private.storage_registration_checks_v1 q
  join clued_private.storage_jobs_v1 j0 on j0.owner_id=q.owner_id and j0.job_id=q.job_id
  join clued_private.storage_connections_v1 c on c.id=j0.connection_id and c.owner_id=j0.owner_id
  join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id and p.user_id=c.owner_id
  where c.oauth_client_id=app.oauth_client_id and j0.intent_id is null and j0.dispatch_outcome is null
   and q.state in ('checking','retry_wait','commit_unknown','confirming')
   and (q.expires_at<=clock_timestamp() or (q.attempts>=6 and q.lease_until<=clock_timestamp()))
  order by q.expires_at,q.job_id limit 3
 loop
  begin
   perform pg_advisory_xact_lock(hashtextextended('storage-job:'||candidate.owner_id||':'||candidate.job_id,0));
   perform pg_advisory_xact_lock(hashtextextended(candidate.owner_id||':'||candidate.root_folder_id,0));
   select * into j from clued_private.storage_jobs_v1 where owner_id=candidate.owner_id and job_id=candidate.job_id for update;
   select * into current_check from clued_private.storage_registration_checks_v1 where job_id=j.job_id and owner_id=j.owner_id for update;
   -- The candidate was selected before acquiring locks. A winner may have
   -- committed while this sweep waited; never settle its now-resolved check.
   if j.intent_id is null and j.dispatch_outcome is null and current_check.state in ('checking','retry_wait','commit_unknown','confirming')
    and (current_check.expires_at<=clock_timestamp() or (current_check.attempts>=6 and current_check.lease_until<=clock_timestamp())) then
    perform clued_private.storage_registration_finish_v1(j,'REGISTRATION_RETRY_EXHAUSTED');count_settled:=count_settled+1;
   end if;
  exception when lock_not_available or serialization_failure or deadlock_detected then null;
  end;
 end loop;
 result:=clued_private.storage_queue_before_registration_v1(p_issuer_identity,p_input);
 return result||jsonb_build_object('registration_settled',count_settled);
end $$;
revoke all on function clued_private.storage_job_status_v1(clued_private.storage_jobs_v1),
 clued_private.ii_pub_clued_storage_queued_sweep_v1(text,jsonb) from public,anon,authenticated,service_role,clued_worker_gateway;
