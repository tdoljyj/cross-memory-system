-- Legacy P5 before-state reconciliation is program-owned. It never records
-- the old trash/untrash as successful or retries a Drive effect. A separate
-- Receipt releases only the exact completed I9 isolation; the old journal,
-- attempted request, attempt Receipt and Artifact baseline remain intact.
create function clued_private.storage_legacy_directory_candidate_v1(j clued_private.storage_jobs_v1) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from clued_private.resource_center_mutations_v1 m
  join clued_private.storage_conflict_isolations_v1 q on q.intent_id=m.id and q.user_id=m.user_id
  where m.id=j.intent_id and m.user_id=j.owner_id and q.job_id=j.job_id and q.connection_id=j.connection_id
  and q.state='active' and q.scope_complete and cardinality(q.object_ids)=1
  and m.state='conflict' and m.version=q.closed_version and m.receipt_id=q.close_receipt_id
  and m.verified_result_v2 is null and j.cloud_writer_binding_id is not null and m.writer_binding_id=j.cloud_writer_binding_id
  and ((m.exact_request->'mutation')-'artifact_role')=(j.mutation-'artifact_role')
  and m.exact_request->'mutation'->>'artifact_role'='clued_resource'
  and coalesce(j.mutation->>'artifact_role','clued_resource')='clued_resource'
  and j.mutation->>'operation' in ('delete','restore')
  and j.mutation->>'target_kind'='directory' and not(j.mutation ? 'destination_path')
  and m.provider_attempt is not null and m.provider_attempt_receipt_id is not null
  and m.provider_attempt=clued_private.storage_destructive_attempt_v1(m,j,'null'::jsonb)
  and not exists(select 1 from clued_private.storage_semantic_attempts_v1 s where s.intent_id=m.id))
$$;
revoke all on function clued_private.storage_legacy_directory_candidate_v1(clued_private.storage_jobs_v1)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- A legacy attempted create has no Artifact baseline to preserve. Its missing
-- generated ID is reconciled separately, never passed to the P5 observer.
create function clued_private.storage_legacy_create_absent_candidate_v1(j clued_private.storage_jobs_v1) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from clued_private.resource_center_mutations_v1 m
  join clued_private.storage_conflict_isolations_v1 q on q.intent_id=m.id and q.user_id=m.user_id
  where m.id=j.intent_id and m.user_id=j.owner_id and q.connection_id=j.connection_id and q.job_id=j.job_id
  and q.state='active' and q.scope_complete and cardinality(q.object_ids)=1
  and m.state='conflict' and m.version=q.closed_version and m.receipt_id=q.close_receipt_id
  and m.verified_result_v2 is null and j.cloud_writer_binding_id is not null and m.writer_binding_id=j.cloud_writer_binding_id
  and ((m.exact_request->'mutation')-'artifact_role')=(j.mutation-'artifact_role')
  and m.exact_request->'mutation'->>'artifact_role'='clued_resource'
  and coalesce(j.mutation->>'artifact_role','clued_resource')='clued_resource'
  and j.mutation->>'operation'='create' and j.mutation->>'target_kind' in ('file','directory')
  and m.provider_attempt->>'provider_file_id'=q.object_ids[1]
  and m.provider_attempt->>'intent_id'=m.id::text and m.provider_attempt_receipt_id is not null
  and m.provider_attempt->>'parent_id'=m.authority_request->'provider_identity'->>'destination_parent_id'
  and m.provider_attempt->>'destination_path'=j.mutation->>'destination_path'
  and not exists(select 1 from clued_private.storage_semantic_attempts_v1 s where s.intent_id=m.id))
$$;
revoke all on function clued_private.storage_legacy_create_absent_candidate_v1(clued_private.storage_jobs_v1)
 from public,anon,authenticated,service_role,clued_worker_gateway;

do $clone$ declare body text;begin
 body:=pg_get_functiondef('clued_private.storage_automatic_reconcile_candidate_v1(clued_private.storage_jobs_v1)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_automatic_reconcile_candidate_v1(',
  'FUNCTION clued_private.storage_automatic_candidate_before_directory_v1(');
 body:=pg_get_functiondef('clued_private.storage_conflict_load_v1(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_conflict_load_v1(',
  'FUNCTION clued_private.storage_conflict_load_before_directory_v1(');
 body:=pg_get_functiondef('clued_private.storage_automatic_reconcile_v1(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_automatic_reconcile_v1(',
  'FUNCTION clued_private.storage_automatic_before_directory_v1(');
end $clone$;

create or replace function clued_private.storage_automatic_reconcile_candidate_v1(j clued_private.storage_jobs_v1) returns boolean
language sql stable security definer set search_path='' as $$
 select clued_private.storage_automatic_candidate_before_directory_v1(j)
  or clued_private.storage_legacy_directory_candidate_v1(j)
$$;

-- A legacy/null snapshot is not fabricated into a current authorization. This
-- new branch always obtains a separately current read connection and carries
-- its complete reader identity, even if the original connection still works.
create or replace function clued_private.storage_conflict_load_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;j clued_private.storage_jobs_v1;reader jsonb;q clued_private.storage_conflict_isolations_v1;
begin
 perform clued_private.storage_recovery_client_input_guard_v1(p_input);
 result:=clued_private.storage_conflict_load_before_directory_v1(p_issuer_identity,p_input);
 select * into j from clued_private.storage_jobs_v1 where owner_id=(result->>'owner_id')::uuid and job_id=(result->>'job_id')::uuid;
 if clued_private.storage_legacy_directory_candidate_v1(j) or clued_private.storage_legacy_create_absent_candidate_v1(j) then
  reader:=clued_private.storage_recovery_reader_v1(p_issuer_identity,j.connection_id,j.job_id);
  result:=result||reader;
 end if;
 if clued_private.storage_legacy_create_absent_candidate_v1(j) then
  select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
  result:=result||jsonb_build_object('conflict_absence',jsonb_build_object('closed_version',q.closed_version,'source_receipt_id',q.close_receipt_id));
 end if;
 return result;
end $$;

create function clued_private.storage_legacy_directory_reconcile_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;q clued_private.storage_conflict_isolations_v1;
 m clued_private.resource_center_mutations_v1;p clued_private.resource_center_profiles_v1;
 a clued_private.resource_center_artifacts_v1;parent clued_private.resource_center_artifacts_v1;
 first jsonb:=p_input->'first_observation';second jsonb:=p_input->'second_observation';
 descriptor jsonb;before jsonb;req jsonb;refs jsonb;ev text;first_at timestamptz;second_at timestamptz;
 attempt_at timestamptz;expected_trashed boolean;source_path text;parent_path text;baseline boolean;r public.clued_audit_receipts;
begin
 perform clued_private.storage_recovery_client_input_guard_v1(p_input);
 if p_input-array['action','connection_id','job_id','base_version','source_receipt_id','credential_version','first_observation','second_observation','recovery_reader']<>'{}'
 or p_input->>'action' is distinct from 'reconcile_before' or jsonb_typeof(first) is distinct from 'object'
 or jsonb_typeof(second) is distinct from 'object' then raise exception 'storage_automatic_reconcile_invalid' using errcode='22023';end if;
 select * into j from clued_private.storage_jobs_v1 where connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid;
 if j.job_id is null then raise exception 'storage_recovery_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||j.owner_id::text||':'||j.job_id::text,0));
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
 if q.intent_id is null then raise exception 'storage_recovery_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||':'||q.root_folder_id,0));
 perform clued_private.authorization_account_v12(j.owner_id);
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id for update;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for update;
 if not exists(select 1 from clued_private.storage_oauth_apps_v1 app where app.issuer_hash=p_issuer_identity
 and app.oauth_client_id=q.oauth_client_id and app.revoked_at is null) then raise exception 'storage_recovery_denied' using errcode='42501';end if;
 if q.state='resolved' and m.final_result->>'automatic_resolution'='automatically_reconciled_before'
 and m.final_result->>'automatic_directory_baseline'='true' and p_input->>'base_version'=m.final_result->>'automatic_base_version'
 and p_input->>'source_receipt_id'=q.close_receipt_id::text and exists(select 1 from public.clued_audit_receipts saved
  where saved.id=q.resolution_receipt_id and saved.user_id=j.owner_id and saved.status='committed' and saved.operation='storage_automatic_reconcile') then
  return jsonb_build_object('status','resolved','resolution','automatically_reconciled_before','automatic_recovery','resolved',
   'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',q.resolution_receipt_id,
   'source_receipt_id',q.close_receipt_id,'base_version',m.final_result->'automatic_base_version','execution_permitted',false);
 end if;
 if not clued_private.storage_legacy_directory_candidate_v1(j) or m.version::text is distinct from p_input->>'base_version'
 or q.close_receipt_id::text is distinct from p_input->>'source_receipt_id' then raise exception 'storage_automatic_reconcile_conflict' using errcode='40001';end if;
 descriptor:=clued_private.storage_conflict_load_v1(p_issuer_identity,p_input);
 if descriptor->'recovery_reader' is distinct from p_input->'recovery_reader'
 or descriptor->>'credential_version' is distinct from p_input->>'credential_version' then
  raise exception 'storage_recovery_reader_changed' using errcode='40001';end if;
 perform clued_private.storage_recovery_reader_assert_v1(p_issuer_identity,p_input);
 select * into p from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=j.owner_id for share;
 select created_at into attempt_at from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=j.owner_id
  and status='committed' and operation='storage_provider_attempt';
 if p.state<>'active' or p.version<>m.profile_version or p.root_folder_id is distinct from q.root_folder_id
 or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,m.source_decision_id)
 or attempt_at is null or greatest(m.expires_at,attempt_at)+interval '130 minutes 10 seconds'>clock_timestamp() then
  raise exception 'storage_recovery_denied' using errcode='42501';end if;
 first_at:=(first->>'observed_at')::timestamptz;second_at:=(second->>'observed_at')::timestamptz;
 if first_at is null or second_at is null or first_at>second_at or first_at<clock_timestamp()-interval '30 seconds'
 or second_at>clock_timestamp()+interval '5 seconds' or (first-'observed_at') is distinct from (second-'observed_at') then
  raise exception 'storage_automatic_reconcile_proof_changed' using errcode='40001';end if;
 if (select array_agg(k order by k) from jsonb_object_keys(second) k) is distinct from array[
  'access_digest','boundary_status','empty','explicitly_trashed','head_revision_id','mime_type','name','observed_at','observed_state',
  'parent_access_digest','parent_id','parent_sharing_digest','provider_file_id','provider_file_version','sha256','sharing_digest','size','trashed']
 or coalesce(second->>'observed_state','') not in ('before','after','changed')
 or coalesce(second->>'boundary_status','') not in ('qualified','identity_changed','namespace_conflict','ancestor_changed')
 or second->>'provider_file_id' is distinct from q.object_ids[1]
 or second->>'mime_type' is distinct from 'application/vnd.google-apps.folder'
 or coalesce(second->>'provider_file_version','')!~'^[1-9][0-9]{0,39}$'
 or coalesce(second->>'parent_id','')!~'^[A-Za-z0-9_-]{1,160}$'
 or coalesce(length(second->>'name'),0) not between 1 and 255 or second->>'name'~'[/\\[:cntrl:]]'
 or jsonb_typeof(second->'trashed') is distinct from 'boolean'
 or second->'explicitly_trashed' is distinct from second->'trashed'
 or jsonb_typeof(second->'empty') is distinct from 'boolean'
 or second->'head_revision_id' is distinct from 'null'::jsonb or second->'size' is distinct from 'null'::jsonb
 or second->'sha256' is distinct from 'null'::jsonb or coalesce(second->>'access_digest','')!~'^[0-9a-f]{64}$' then
  raise exception 'storage_automatic_reconcile_invalid' using errcode='22023';end if;
 before:=m.authority_request->'provider_identity';source_path:=j.mutation->>'source_path';parent_path:=regexp_replace(source_path,'/[^/]+$','');
 expected_trashed:=j.mutation->>'operation'='restore';
 select * into a from clued_private.resource_center_artifacts_v1 where user_id=j.owner_id and profile_id=p.id
  and provider_file_id=q.object_ids[1] and state=case when expected_trashed then 'trashed' else 'active' end for update;
 select * into parent from clued_private.resource_center_artifacts_v1 where user_id=j.owner_id and profile_id=p.id
  and state='active' and target_kind='directory' and provider_file_id=before->>'source_parent_id' and path=parent_path for share;
 if a.id is null or a.target_kind<>'directory' or a.path is distinct from source_path
 or m.exact_request->'binding'->>'artifact_id' is distinct from a.id::text
 or split_part(m.exact_request->'binding'->>'artifact_authority_version',':',1) is distinct from a.id::text
 or split_part(m.exact_request->'binding'->>'artifact_authority_version',':',2) is distinct from a.version::text
 or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,a.source_decision_id)
 or not exists(select 1 from public.clued_memories decision where decision.id=a.source_decision_id and decision.user_id=j.owner_id
  and m.exact_request->'binding'->>'currentness_identity'='decision:'||decision.id::text||':'||decision.version::text)
 or a.provider_file_id is distinct from before->>'source_file_id' or a.provider_file_id is distinct from j.mutation->>'source_file_id'
 or a.provider_file_version is distinct from before->>'source_file_version'
 or a.provider_file_version is distinct from j.mutation->>'source_file_version'
 or source_path is null or not starts_with(source_path,p.managed_root||'/') or parent_path=p.managed_root
 or a.provider_file_id in (p.root_folder_id,p.root_parent_id) or parent.id is null or parent.provider_file_id is distinct from m.provider_attempt->>'parent_id'
 or exists(select 1 from clued_private.resource_center_artifacts_v1 track where track.user_id=j.owner_id and track.profile_id=p.id
  and track.target_kind='directory' and regexp_replace(track.path,'/[^/]+$','')=p.managed_root and track.provider_file_id=a.provider_file_id)
 or not clued_private.resource_center_path_current_v1(j.owner_id,p.project_id,p.id,p.managed_root,parent.path)
 or exists(select 1 from clued_private.resource_center_artifacts_v1 child where child.user_id=j.owner_id and child.profile_id=p.id
  and child.state in ('active','trashed') and starts_with(child.path,source_path||'/')) then
  raise exception 'storage_automatic_reconcile_conflict' using errcode='40001';end if;
 baseline:=second->>'boundary_status'='qualified' and second->'empty'='true'::jsonb
  and second->'trashed'=to_jsonb(expected_trashed) and second->>'provider_file_version'=a.provider_file_version
  and second->>'parent_id'=parent.provider_file_id and second->>'name'=regexp_replace(source_path,'^.*/','')
  and coalesce(before->>'source_access_digest',second->>'access_digest')=second->>'access_digest'
  and (before->>'source_sharing_digest' is null or before->>'source_sharing_digest'=second->>'sharing_digest')
  and (before->>'source_parent_access_digest' is null or before->>'source_parent_access_digest'=second->>'parent_access_digest')
  and (before->>'source_parent_sharing_digest' is null or before->>'source_parent_sharing_digest'=second->>'parent_sharing_digest');
 if not coalesce(baseline,false) then
  if second->>'observed_state'='before' then raise exception 'storage_automatic_reconcile_proof_changed' using errcode='40001';end if;
  if second->>'observed_state'='after' and second->>'boundary_status'='qualified' and second->'empty'='true'::jsonb
   and second->'trashed'=to_jsonb(not expected_trashed) then
   return jsonb_build_object('status','after_observed','connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,
    'source_receipt_id',q.close_receipt_id,'base_version',m.version,'execution_permitted',false);
  end if;
  insert into clued_private.storage_automatic_reconcile_checks_v1 values(m.id,j.owner_id,j.connection_id,j.job_id,m.version,q.close_receipt_id,
   null,first_at,second_at,'current_state_conflict',null,second->>'boundary_status',clued_private.m1_sha256(second)) on conflict(intent_id)
   do update set observation_id=null,first_observed_at=excluded.first_observed_at,observed_at=excluded.observed_at,
    base_version=excluded.base_version,source_receipt_id=excluded.source_receipt_id,state=excluded.state,resolution_receipt_id=null,
    boundary_status=excluded.boundary_status,observation_digest=excluded.observation_digest;
  return jsonb_build_object('status','inspection_required','automatic_recovery','current_state_conflict','connection_id',j.connection_id,'job_id',j.job_id,
   'intent_id',m.id,'source_receipt_id',q.close_receipt_id,'base_version',m.version,'execution_permitted',false,'diagnostic',jsonb_build_object(
    'stage','verification','reason','CONTENT_MISMATCH','observed_at',second_at,'automatic_next_action','continue_object_recovery'));
 end if;
 if second->>'observed_state'<>'before' then raise exception 'storage_automatic_reconcile_proof_changed' using errcode='40001';end if;
 req:=jsonb_build_object('action','reconcile_before','idempotency_key','storage-auto-directory-before:'||m.id::text||':'||m.version::text,
  'intent_id',m.id,'connection_id',j.connection_id,'job_id',j.job_id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'provider_attempt_receipt_id',m.provider_attempt_receipt_id,'request_sha256',m.request_sha256,'recovery_reader',p_input->'recovery_reader',
  'credential_version',p_input->'credential_version','artifact_id',a.id,'artifact_version',a.version,
  'parent_artifact_id',parent.id,'parent_artifact_version',parent.version,'profile_version',p.version,
  'first_observation',first,'second_observation',second,'reason_code','CURRENT_BASELINE_RECONCILED');
 r:=clued_private.m1_begin_receipt(j.owner_id,null,'storage_automatic_reconcile',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_automatic_reconcile_conflict' using errcode='40001';end if;
 insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
 update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 insert into clued_private.storage_automatic_reconcile_checks_v1 values(m.id,j.owner_id,j.connection_id,j.job_id,m.version,q.close_receipt_id,
  null,first_at,second_at,'reconciled_before',r.id,'qualified',clued_private.m1_sha256(second)) on conflict(intent_id) do update
  set observation_id=null,first_observed_at=excluded.first_observed_at,observed_at=excluded.observed_at,
   base_version=excluded.base_version,source_receipt_id=excluded.source_receipt_id,state=excluded.state,resolution_receipt_id=excluded.resolution_receipt_id,
   boundary_status=excluded.boundary_status,observation_digest=excluded.observation_digest;
 update clued_private.resource_center_mutations_v1 set version=version+1,updated_at=clock_timestamp(),final_result=final_result||jsonb_build_object(
  'automatic_resolution','automatically_reconciled_before','automatic_receipt_id',r.id,'automatic_base_version',m.version,
  'automatic_directory_baseline',true) where id=m.id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 ev:=clued_private.m1_append_event_row(j.owner_id,null,r.id,r.canonical_version,'extension:storage:automatic_baseline_reconciled',refs,
  'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(m.id::text,m.version),
  jsonb_build_object(m.id::text,m.version+1),array[ev],'{}'::uuid[],null);
 return jsonb_build_object('status','resolved','resolution','automatically_reconciled_before','automatic_recovery','resolved',
  'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',r.id,'source_receipt_id',q.close_receipt_id,
  'base_version',m.version,'execution_permitted',false);
end $$;

create or replace function clued_private.storage_automatic_reconcile_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare connection_ref uuid;job_ref uuid;
begin
 perform clued_private.storage_recovery_client_input_guard_v1(p_input);
 begin
  connection_ref:=(p_input->>'connection_id')::uuid;job_ref:=(p_input->>'job_id')::uuid;
 exception when invalid_text_representation then
  return clued_private.storage_automatic_before_directory_v1(p_issuer_identity,p_input);
 end;
 if exists(select 1 from clued_private.storage_jobs_v1 j where j.connection_id=connection_ref
  and j.job_id=job_ref and j.mutation->>'target_kind'='directory') then
  return clued_private.storage_legacy_directory_reconcile_v1(p_issuer_identity,p_input);
 end if;
 return clued_private.storage_automatic_before_directory_v1(p_issuer_identity,p_input);
end $$;
revoke all on function clued_private.storage_automatic_candidate_before_directory_v1(clued_private.storage_jobs_v1),
 clued_private.storage_conflict_load_before_directory_v1(text,jsonb),clued_private.storage_automatic_before_directory_v1(text,jsonb),
 clued_private.storage_legacy_directory_reconcile_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Preserve the old started/uncertain absence path byte-for-byte behind a
-- private clone. Only I9 creates use the independent reconciliation Receipt.
do $clone_absent$ declare body text;begin
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_recovery_absent_v1(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.ii_pub_clued_storage_recovery_absent_v1(',
  'FUNCTION clued_private.storage_absent_before_legacy_create_v1(');
end $clone_absent$;

create function clued_private.storage_legacy_create_absent_v1(p_issuer_identity text,i jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;
 q clued_private.storage_conflict_isolations_v1;p clued_private.resource_center_profiles_v1;
 d jsonb;req jsonb;refs jsonb;ev text;attempt_at timestamptz;r public.clued_audit_receipts;
begin
 perform clued_private.storage_recovery_client_input_guard_v1(i);
 if i-array['action','connection_id','job_id','intent_id','base_version','request_sha256','proof','credential_version','recovery_reader']<>'{}'
 or i->>'action' is distinct from 'settle_absent' then raise exception 'storage_absent_release_denied' using errcode='42501';end if;
 select * into j from clued_private.storage_jobs_v1 where connection_id=(i->>'connection_id')::uuid and job_id=(i->>'job_id')::uuid;
 if j.job_id is null then raise exception 'storage_absent_release_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||j.owner_id::text||':'||j.job_id::text,0));
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
 if q.intent_id is null then raise exception 'storage_absent_release_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||':'||q.root_folder_id,0));
 perform clued_private.authorization_account_v12(j.owner_id);
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id for update;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for update;
 if not exists(select 1 from clued_private.storage_oauth_apps_v1 app where app.issuer_hash=p_issuer_identity
 and app.oauth_client_id=q.oauth_client_id and app.revoked_at is null)
 or i->>'intent_id' is distinct from m.id::text or i->>'request_sha256' is distinct from m.request_sha256
 or i->'proof' is distinct from jsonb_build_object('contract','clued.storage-create-absent/1','intent_id',m.id,
  'provider_file_id',m.provider_attempt->>'provider_file_id','parent_id',m.provider_attempt->>'parent_id') then
  raise exception 'storage_absent_release_denied' using errcode='42501';end if;
 if q.state='resolved' and m.final_result->>'automatic_create_absent'='true'
 and m.final_result->>'automatic_base_version'=i->>'base_version' and exists(select 1 from public.clued_audit_receipts a
  where a.id=q.resolution_receipt_id and a.user_id=j.owner_id and a.status='committed' and a.operation='storage_automatic_reconcile') then
  return jsonb_build_object('status','resolved','state','conflict','resolution','automatically_reconciled_before','automatic_recovery','resolved',
   'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',q.resolution_receipt_id,
   'source_receipt_id',q.close_receipt_id,'base_version',m.final_result->'automatic_base_version','execution_permitted',false);
 end if;
 if not clued_private.storage_legacy_create_absent_candidate_v1(j) or m.version::text is distinct from i->>'base_version'
 then raise exception 'storage_automatic_reconcile_conflict' using errcode='40001';end if;
 d:=clued_private.storage_conflict_load_v1(p_issuer_identity,i);
 if d->'recovery_reader' is distinct from i->'recovery_reader' or d->>'credential_version' is distinct from i->>'credential_version'
 then raise exception 'storage_recovery_reader_changed' using errcode='40001';end if;
 perform clued_private.storage_recovery_reader_assert_v1(p_issuer_identity,i);
 select * into p from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=j.owner_id for share;
 select created_at into attempt_at from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=j.owner_id
  and status='committed' and operation='storage_provider_attempt';
 if p.id is null or p.state<>'active' or p.version<>m.profile_version or p.root_folder_id is distinct from q.root_folder_id
 or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,m.source_decision_id)
 or m.expires_at is null or attempt_at is null or greatest(m.expires_at,attempt_at)+interval '132 minutes'>clock_timestamp()
 or exists(select 1 from clued_private.resource_center_artifacts_v1 a where a.user_id=j.owner_id and a.profile_id=p.id
  and a.state in ('active','trashed') and (a.provider_file_id=q.object_ids[1] or a.path=any(q.paths)
   or exists(select 1 from unnest(q.subtree_paths) sub where starts_with(a.path,sub||'/')))) then
  raise exception 'storage_absent_release_denied' using errcode='42501';end if;
 req:=jsonb_build_object('idempotency_key','storage-auto-create-absent:'||m.id::text||':'||m.version::text,
  'intent_id',m.id,'job_id',j.job_id,'connection_id',j.connection_id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'provider_attempt_receipt_id',m.provider_attempt_receipt_id,'request_sha256',m.request_sha256,'proof',i->'proof',
  'recovery_reader',i->'recovery_reader','credential_version',i->'credential_version','reason_code','CURRENT_EFFECT_ABSENT');
 r:=clued_private.m1_begin_receipt(j.owner_id,null,'storage_automatic_reconcile',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_automatic_reconcile_conflict' using errcode='40001';end if;
 insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
 update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 insert into clued_private.storage_automatic_reconcile_checks_v1 values(m.id,j.owner_id,j.connection_id,j.job_id,m.version,q.close_receipt_id,
  null,clock_timestamp(),clock_timestamp(),'reconciled_before',r.id,'qualified',clued_private.m1_sha256(req)) on conflict(intent_id) do update
  set observation_id=null,first_observed_at=excluded.first_observed_at,observed_at=excluded.observed_at,base_version=excluded.base_version,
   source_receipt_id=excluded.source_receipt_id,state=excluded.state,resolution_receipt_id=excluded.resolution_receipt_id,
   boundary_status=excluded.boundary_status,observation_digest=excluded.observation_digest;
 update clued_private.resource_center_mutations_v1 set version=version+1,updated_at=clock_timestamp(),final_result=final_result||jsonb_build_object(
  'automatic_resolution','automatically_reconciled_before','automatic_receipt_id',r.id,'automatic_base_version',m.version,
  'automatic_create_absent',true) where id=m.id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 ev:=clued_private.m1_append_event_row(j.owner_id,null,r.id,r.canonical_version,'extension:storage:automatic_create_absent_reconciled',
  refs,'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(m.id::text,m.version),
  jsonb_build_object(m.id::text,m.version+1),array[ev],'{}'::uuid[],null);
 return jsonb_build_object('status','resolved','state','conflict','resolution','automatically_reconciled_before','automatic_recovery','resolved',
  'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',r.id,'source_receipt_id',q.close_receipt_id,
  'base_version',m.version,'execution_permitted',false);
end $$;

create or replace function clued_private.ii_pub_clued_storage_recovery_absent_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare connection_ref uuid;job_ref uuid;
begin
 perform clued_private.storage_recovery_client_input_guard_v1(p_input);
 begin
  connection_ref:=(p_input->>'connection_id')::uuid;job_ref:=(p_input->>'job_id')::uuid;
 exception when invalid_text_representation then
  return clued_private.storage_absent_before_legacy_create_v1(p_issuer_identity,p_input);
 end;
 if exists(select 1 from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m
  on m.id=j.intent_id and m.user_id=j.owner_id where j.connection_id=connection_ref and j.job_id=job_ref
  and m.state='conflict' and j.mutation->>'operation'='create') then
  return clued_private.storage_legacy_create_absent_v1(p_issuer_identity,p_input);
 end if;
 return clued_private.storage_absent_before_legacy_create_v1(p_issuer_identity,p_input);
end $$;
revoke all on function clued_private.storage_absent_before_legacy_create_v1(text,jsonb),
 clued_private.storage_legacy_create_absent_v1(text,jsonb) from public,anon,authenticated,service_role,clued_worker_gateway;
