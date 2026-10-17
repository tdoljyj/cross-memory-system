-- Program-owned recovery of a failed original operation. A stable current
-- baseline is not a declaration that the old provider effect never happened.
-- The original journal/attempt/I9 Receipt remain history; only a separate
-- automatic Receipt may end its quarantine. No Owner confirmation is forged.
create table clued_private.storage_automatic_reconcile_checks_v1 (
 intent_id uuid primary key references clued_private.storage_conflict_isolations_v1(intent_id),
 user_id uuid not null, connection_id uuid not null, job_id uuid not null,
 base_version bigint not null, source_receipt_id uuid not null references public.clued_audit_receipts(id),
 observation_id uuid references clued_private.storage_conflict_observations_v1(id),
 first_observed_at timestamptz not null, observed_at timestamptz not null,
 state text not null check(state in ('current_state_conflict','reconciled_before')),
 resolution_receipt_id uuid references public.clued_audit_receipts(id),
 boundary_status text not null check(boundary_status in ('qualified','identity_changed','namespace_conflict','ancestor_changed')),
 observation_digest text not null check(observation_digest~'^[0-9a-f]{64}$')
);
alter table clued_private.storage_automatic_reconcile_checks_v1 enable row level security;
revoke all on clued_private.storage_automatic_reconcile_checks_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_automatic_reconcile_candidate_v1(j clued_private.storage_jobs_v1) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from clued_private.storage_conflict_isolations_v1 q
  join clued_private.resource_center_mutations_v1 m on m.id=q.intent_id and m.user_id=q.user_id
  where q.intent_id=j.intent_id and q.user_id=j.owner_id and q.connection_id=j.connection_id and q.job_id=j.job_id
   and q.state='active' and q.scope_complete and cardinality(q.object_ids)=1 and m.state='conflict'
   and m.version=q.closed_version and m.receipt_id=q.close_receipt_id and m.verified_result_v2 is null
   and m.exact_request->'mutation'->>'operation'='replace' and m.exact_request->'mutation'->>'target_kind'='file'
   and j.authority_snapshot_v2 is not null and j.cloud_writer_binding_id is not null
   and j.cloud_writer_binding_id=m.writer_binding_id and m.provider_attempt is not null and m.provider_attempt_receipt_id is not null)
$$;

-- Add only a private descriptor hint. The original loader still authenticates
-- the exact account/job/issuer/client, current read credential and deny lists.
do $clone$ declare body text; begin
 body:=pg_get_functiondef('clued_private.storage_conflict_load_v1(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_conflict_load_v1(',
  'FUNCTION clued_private.storage_conflict_load_before_automatic_v1(');
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_scheduled_recovery_v2(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.ii_pub_clued_storage_scheduled_recovery_v2(',
  'FUNCTION clued_private.storage_scheduled_before_automatic_v1(');
 body:=pg_get_functiondef('clued_private.storage_job_status_v1(clued_private.storage_jobs_v1)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_job_status_v1(',
  'FUNCTION clued_private.storage_job_status_before_automatic_v1(');
 body:=pg_get_functiondef('clued_private.storage_conflict_public_status_v1(clued_private.storage_jobs_v1)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_conflict_public_status_v1(',
  'FUNCTION clued_private.storage_conflict_public_before_automatic_v1(');
end $clone$;

create or replace function clued_private.storage_conflict_load_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; j clued_private.storage_jobs_v1; q clued_private.storage_conflict_isolations_v1;
begin
 result:=clued_private.storage_conflict_load_before_automatic_v1(p_issuer_identity,p_input);
 select * into j from clued_private.storage_jobs_v1 where owner_id=(result->>'owner_id')::uuid and job_id=(result->>'job_id')::uuid;
 if clued_private.storage_automatic_reconcile_candidate_v1(j) then
  select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
  result:=result||jsonb_build_object('conflict_reconcile',jsonb_build_object('source_receipt_id',q.close_receipt_id,'closed_version',q.closed_version));
 end if;
 return result;
end $$;

create or replace function clued_private.storage_conflict_exit_allowed_v1(p_intent uuid,p_receipt uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from clued_private.storage_conflict_exit_permits_v1 x
  join clued_private.storage_conflict_isolations_v1 q on q.intent_id=x.intent_id
  join public.clued_audit_receipts r on r.id=x.receipt_id and r.user_id=q.user_id
  where x.intent_id=p_intent and x.receipt_id=p_receipt and x.transaction_id=txid_current()
   and r.status in ('pending','committed') and r.operation in
    ('storage_verified_settle','storage_conflict_abandon','storage_conflict_accept','storage_automatic_reconcile'))
$$;

create function clued_private.storage_automatic_reconcile_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; q clued_private.storage_conflict_isolations_v1;
 m clued_private.resource_center_mutations_v1; p clued_private.resource_center_profiles_v1;
 a clued_private.resource_center_artifacts_v1; parent clued_private.resource_center_artifacts_v1;
 c clued_private.storage_connections_v1; policy clued_private.storage_account_policies_v2;
 observation clued_private.storage_conflict_observations_v1;
 first jsonb:=p_input->'first_observation'; second jsonb:=p_input->'second_observation';
 descriptor jsonb; prepared jsonb; before jsonb; content_before jsonb; content_after jsonb; req jsonb; refs jsonb; ev text;
 first_at timestamptz; second_at timestamptz; attempt_at timestamptz; original_version text; same_before boolean;
 r public.clued_audit_receipts;
begin
 if p_input-array['action','connection_id','job_id','base_version','source_receipt_id','credential_version','first_observation','second_observation']<>'{}'
  or p_input->>'action'<>'reconcile_before' or jsonb_typeof(first) is distinct from 'object' or jsonb_typeof(second) is distinct from 'object' then
  raise exception 'storage_automatic_reconcile_invalid' using errcode='22023'; end if;
 select * into j from clued_private.storage_jobs_v1 where connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid;
 if j.job_id is null then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||j.owner_id::text||':'||j.job_id::text,0));
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
 if q.intent_id is null then raise exception 'storage_recovery_denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||':'||q.root_folder_id,0));
 perform clued_private.authorization_account_v12(j.owner_id);
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id for update;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for update;
 if not exists(select 1 from clued_private.storage_oauth_apps_v1 app where app.issuer_hash=p_issuer_identity
  and app.oauth_client_id=q.oauth_client_id and app.revoked_at is null) then
  raise exception 'storage_recovery_denied' using errcode='42501'; end if;
 if q.state='resolved' and m.final_result->>'automatic_resolution'='automatically_reconciled_before'
  and p_input->>'base_version'=m.final_result->>'automatic_base_version' and p_input->>'source_receipt_id'=q.close_receipt_id::text
  and exists(select 1 from public.clued_audit_receipts receipt where receipt.id=q.resolution_receipt_id and receipt.user_id=j.owner_id
   and receipt.operation='storage_automatic_reconcile' and receipt.status='committed') then
  return jsonb_build_object('status','resolved','resolution','automatically_reconciled_before','automatic_recovery','resolved',
   'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',q.resolution_receipt_id,
   'source_receipt_id',q.close_receipt_id,'base_version',m.final_result->'automatic_base_version','execution_permitted',false);
 end if;
 if not clued_private.storage_automatic_reconcile_candidate_v1(j) or m.version::text is distinct from p_input->>'base_version'
  or q.close_receipt_id::text is distinct from p_input->>'source_receipt_id' then
  raise exception 'storage_automatic_reconcile_conflict' using errcode='40001'; end if;
 descriptor:=clued_private.storage_conflict_load_v1(p_issuer_identity,p_input);
 if descriptor->>'credential_version' is distinct from p_input->>'credential_version' then
  raise exception 'storage_automatic_reconcile_conflict' using errcode='40001'; end if;
 select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=j.owner_id for share;
 select * into p from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=j.owner_id for share;
 select * into policy from clued_private.storage_account_policies_v2 where id=(j.authority_snapshot_v2->>'policy_id')::uuid and owner_id=j.owner_id for share;
 select created_at into attempt_at from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=j.owner_id
  and status='committed' and operation='storage_provider_attempt';
 if c.state<>'active' or c.revoked_at is not null or policy.state<>'active' or policy.revoked_at is not null
  or policy.id is null or coalesce(policy.expires_at<=clock_timestamp(),false)
  or c.account_policy_id is distinct from policy.id or c.auth_generation::text is distinct from j.authority_snapshot_v2->>'auth_generation'
  or policy.policy_generation::text is distinct from j.authority_snapshot_v2->>'policy_generation'
  or policy.scope_digest is distinct from j.authority_snapshot_v2->>'scope_digest'
  or p.state<>'active' or p.version<>m.profile_version or p.root_folder_id is distinct from q.root_folder_id
  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,c.source_decision_id)
  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,policy.source_decision_id)
  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,p.source_decision_id)
  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,m.source_decision_id)
  or attempt_at is null or greatest(m.expires_at,attempt_at)+interval '130 minutes'+
    (case when m.exact_request->'mutation'?'content_ref' then interval '120 seconds' else interval '10 seconds' end)>clock_timestamp() then
  raise exception 'storage_recovery_denied' using errcode='42501'; end if;
 first_at:=(first->>'observed_at')::timestamptz; second_at:=(second->>'observed_at')::timestamptz;
 if first_at is null or second_at is null or first_at>second_at or first_at<clock_timestamp()-interval '30 seconds'
  or second_at>clock_timestamp()+interval '5 seconds' or (first-'observed_at') is distinct from (second-'observed_at') then
  raise exception 'storage_automatic_reconcile_proof_changed' using errcode='40001'; end if;
 if (select array_agg(k order by k) from jsonb_object_keys(second) k) is distinct from array[
  'boundary_status','head_revision_id','mime_type','name','observed_at','observed_state','parent_id','provider_file_id','provider_file_version','sha256','size','trashed']
  or coalesce(second->>'boundary_status','') not in ('qualified','identity_changed','namespace_conflict','ancestor_changed')
  or second->>'provider_file_id' is distinct from q.object_ids[1] then
  raise exception 'storage_automatic_reconcile_invalid' using errcode='22023'; end if;
 if second->>'observed_state'='absent' then
  if second-array['boundary_status','provider_file_id','observed_at','observed_state'] is distinct from jsonb_build_object(
   'provider_file_version',null,'parent_id',null,'name',null,'trashed',null,'mime_type',null,'size',null,'sha256',null,'head_revision_id',null)
   or second->>'boundary_status'='qualified' then raise exception 'storage_automatic_reconcile_invalid' using errcode='22023'; end if;
 elsif coalesce(second->>'provider_file_version','')!~'^[1-9][0-9]{0,39}$'
  or coalesce(second->>'parent_id','')!~'^[A-Za-z0-9_-]{1,160}$'
  or coalesce(length(second->>'name'),0) not between 1 and 255 or second->>'name'~'[/\\[:cntrl:]]'
  or jsonb_typeof(second->'trashed') is distinct from 'boolean' or coalesce(length(second->>'mime_type'),0) not between 1 and 255
  or second->>'mime_type'='application/vnd.google-apps.folder'
  or (second->>'sha256' is not null and second->>'sha256'!~'^[0-9a-f]{64}$')
  or (second->>'size' is not null and second->>'size'!~'^(0|[1-9][0-9]{0,19})$') then
  raise exception 'storage_automatic_reconcile_invalid' using errcode='22023'; end if;
 -- Stable target identity can prove that the current state needs a choice
 -- without qualifying an unknown new location for adoption. Such observations
 -- retain the fence and expose withdrawal only; no registry change is made.
 if second->>'boundary_status'<>'qualified' or second->'trashed'='true'::jsonb
  or second->>'parent_id' is distinct from m.authority_request->'provider_identity'->>'destination_parent_id'
  or second->>'name' is distinct from regexp_replace(m.exact_request->'mutation'->>'destination_path','^.*/','') then
  if coalesce(second->>'observed_state','') not in ('changed','absent') then raise exception 'storage_automatic_reconcile_proof_changed' using errcode='40001'; end if;
  insert into clued_private.storage_automatic_reconcile_checks_v1 values(m.id,j.owner_id,j.connection_id,j.job_id,m.version,q.close_receipt_id,
   null,first_at,second_at,'current_state_conflict',null,
   case when second->>'boundary_status'='qualified' then 'identity_changed' else second->>'boundary_status' end,clued_private.m1_sha256(second))
   on conflict(intent_id) do update set observation_id=null,first_observed_at=excluded.first_observed_at,observed_at=excluded.observed_at,
    base_version=excluded.base_version,source_receipt_id=excluded.source_receipt_id,state=excluded.state,resolution_receipt_id=null,
    boundary_status=excluded.boundary_status,observation_digest=excluded.observation_digest;
  return jsonb_build_object('status','inspection_required','automatic_recovery','current_state_conflict','connection_id',j.connection_id,'job_id',j.job_id,
   'intent_id',m.id,'source_receipt_id',q.close_receipt_id,'base_version',m.version,'execution_permitted',false,'diagnostic',jsonb_build_object(
    'stage','verification','reason','CONTENT_MISMATCH','observed_at',second_at,'automatic_next_action','continue_object_recovery'));
 end if;
 -- Reuse only the existing strict private observation/registry validation,
 -- never its Owner accept operation. All writes below share this transaction.
 prepared:=clued_private.storage_conflict_observe_v1(p_issuer_identity,jsonb_build_object('action','review_observe',
  'connection_id',j.connection_id,'job_id',j.job_id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,'observation',second-'boundary_status'));
 select * into observation from clued_private.storage_conflict_observations_v1 where id=(prepared->>'observation_id')::uuid for update;
 select * into a from clued_private.resource_center_artifacts_v1 where id=observation.artifact_id and user_id=j.owner_id for update;
 select * into parent from clued_private.resource_center_artifacts_v1 where id=observation.parent_artifact_id and user_id=j.owner_id for share;
 before:=m.authority_request->'provider_identity'; content_before:=m.provider_attempt->'content_before'; content_after:=m.provider_attempt->'content_after';
 original_version:=before->>'destination_file_version';
 if a.id is null or a.state<>'active' or a.target_kind<>'file' or a.profile_id<>q.profile_id or a.version<>observation.artifact_version
  or a.path is distinct from m.exact_request->'mutation'->>'destination_path'
  or a.provider_file_id is distinct from before->>'destination_file_id' or a.provider_file_id is distinct from second->>'provider_file_id'
  or a.provider_file_version is distinct from original_version or coalesce(original_version,'')!~'^[1-9][0-9]{0,39}$'
  or second->'trashed' is distinct from 'false'::jsonb or second->>'mime_type'='application/vnd.google-apps.folder'
  or second->>'parent_id' is distinct from before->>'destination_parent_id'
  or second->>'name' is distinct from regexp_replace(a.path,'^.*/','')
  or parent.id is null or parent.state<>'active' or parent.version<>observation.parent_artifact_version
  or parent.provider_file_id is distinct from before->>'destination_parent_id'
  or not clued_private.resource_center_path_current_v1(j.owner_id,p.project_id,p.id,p.managed_root,parent.path) then
  raise exception 'storage_automatic_reconcile_conflict' using errcode='40001'; end if;
 -- Drive files.version is monotonically increasing for each server change.
 -- Compare all additional historical content facts that actually exist; old
 -- Native jobs need not invent hashes absent from their original attempt.
 same_before:=second->>'provider_file_version'=original_version;
 if same_before and ((content_before?'size' and content_before->'size' is distinct from second->'size')
  or (content_before?'sha256' and content_before->'sha256' is distinct from second->'sha256')
  or (content_before?'head_revision_id' and content_before->'head_revision_id' is distinct from second->'head_revision_id')) then
  raise exception 'storage_automatic_reconcile_proof_changed' using errcode='40001'; end if;
 if not same_before then
  if second->>'observed_state'='after' and jsonb_typeof(content_after)='object'
   and second->'size'=content_after->'size' and second->'sha256'=content_after->'sha256'
   and second->>'head_revision_id' is distinct from m.provider_attempt->>'pinned_revision_id' then
   return jsonb_build_object('status','after_observed','connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,
    'source_receipt_id',q.close_receipt_id,'base_version',m.version,'execution_permitted',false);
  end if;
  if second->>'observed_state'<>'changed' then raise exception 'storage_automatic_reconcile_proof_changed' using errcode='40001'; end if;
  insert into clued_private.storage_automatic_reconcile_checks_v1 values(m.id,j.owner_id,j.connection_id,j.job_id,m.version,q.close_receipt_id,
   observation.id,first_at,second_at,'current_state_conflict',null,'qualified',clued_private.m1_sha256(second)) on conflict(intent_id) do update
   set observation_id=excluded.observation_id,first_observed_at=excluded.first_observed_at,observed_at=excluded.observed_at,
    base_version=excluded.base_version,source_receipt_id=excluded.source_receipt_id,state=excluded.state,resolution_receipt_id=null,
    boundary_status=excluded.boundary_status,observation_digest=excluded.observation_digest;
  return jsonb_build_object('status','inspection_required','automatic_recovery','current_state_conflict','connection_id',j.connection_id,'job_id',j.job_id,
   'intent_id',m.id,'source_receipt_id',q.close_receipt_id,'base_version',m.version,'execution_permitted',false,'diagnostic',jsonb_build_object(
    'stage','verification','reason','CONTENT_MISMATCH','observed_at',second_at,'automatic_next_action','continue_object_recovery'));
 end if;
 if second->>'observed_state'<>'before' then raise exception 'storage_automatic_reconcile_proof_changed' using errcode='40001'; end if;
 req:=jsonb_build_object('action','reconcile_before','idempotency_key','storage-auto-before:'||m.id::text||':'||m.version::text,
  'intent_id',m.id,'connection_id',j.connection_id,'job_id',j.job_id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'observation_id',observation.id,'credential_version',c.credential_version,'reason_code','CURRENT_BASELINE_RECONCILED');
 r:=clued_private.m1_begin_receipt(j.owner_id,null,'storage_automatic_reconcile',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_automatic_reconcile_conflict' using errcode='40001'; end if;
 insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
 update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 update clued_private.storage_conflict_observations_v1 set resolution_receipt_id=r.id where id=observation.id;
 insert into clued_private.storage_automatic_reconcile_checks_v1 values(m.id,j.owner_id,j.connection_id,j.job_id,m.version,q.close_receipt_id,
  observation.id,first_at,second_at,'reconciled_before',r.id,'qualified',clued_private.m1_sha256(second)) on conflict(intent_id) do update
  set observation_id=excluded.observation_id,first_observed_at=excluded.first_observed_at,observed_at=excluded.observed_at,
   base_version=excluded.base_version,source_receipt_id=excluded.source_receipt_id,state=excluded.state,resolution_receipt_id=excluded.resolution_receipt_id,
   boundary_status=excluded.boundary_status,observation_digest=excluded.observation_digest;
 update clued_private.resource_center_mutations_v1 set version=version+1,updated_at=clock_timestamp(),
  final_result=final_result||jsonb_build_object('automatic_resolution','automatically_reconciled_before','automatic_receipt_id',r.id,
   'automatic_base_version',m.version,'automatic_observation_id',observation.id) where id=m.id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 ev:=clued_private.m1_append_event_row(j.owner_id,null,r.id,r.canonical_version,'extension:storage:automatic_baseline_reconciled',refs,
  'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(m.id::text,m.version),
  jsonb_build_object(m.id::text,m.version+1),array[ev],'{}'::uuid[],null);
 return jsonb_build_object('status','resolved','resolution','automatically_reconciled_before','automatic_recovery','resolved',
  'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',r.id,
  'source_receipt_id',q.close_receipt_id,'base_version',m.version,'execution_permitted',false);
end $$;

create or replace function clued_private.ii_pub_clued_storage_scheduled_recovery_v2(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_input->>'action'='reconcile_before' then return clued_private.storage_automatic_reconcile_v1(p_issuer_identity,p_input); end if;
 return clued_private.storage_scheduled_before_automatic_v1(p_issuer_identity,p_input);
end $$;

create or replace function clued_private.storage_job_status_v1(p_job clued_private.storage_jobs_v1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1:=p_job; result jsonb:=clued_private.storage_job_status_before_automatic_v1(p_job); q clued_private.storage_conflict_isolations_v1; m clued_private.resource_center_mutations_v1;
begin
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id;
 if q.state='resolved' and m.final_result->>'automatic_resolution'='automatically_reconciled_before'
  and exists(select 1 from public.clued_audit_receipts r where r.id=q.resolution_receipt_id and r.user_id=j.owner_id
   and r.operation='storage_automatic_reconcile' and r.status='committed') then
  result:=result||jsonb_build_object('reason_code','PROVIDER_RESULT_RECONCILED','resolution','automatically_reconciled_before',
   'resolution_receipt_id',q.resolution_receipt_id,'source_receipt_id',q.close_receipt_id,'automatic_recovery','resolved');
 end if; return result;
end $$;

create or replace function clued_private.storage_conflict_public_status_v1(j clued_private.storage_jobs_v1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb:=clued_private.storage_conflict_public_before_automatic_v1(j); q clued_private.storage_conflict_isolations_v1;
 m clued_private.resource_center_mutations_v1; automatic_state text; boundary text;
begin
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id;
 if result->>'resolution'='automatically_reconciled_before' and q.state='resolved' then
  return result||jsonb_build_object('status','resolved','receipt_id',q.resolution_receipt_id,'base_version',m.final_result->'automatic_base_version',
   'observation_id',m.final_result->'automatic_observation_id','review_available',false,'abandon_available',false,'automatic_recovery','resolved');
 end if;
 if clued_private.storage_automatic_reconcile_candidate_v1(j) then
  select 'current_state_conflict',check_row.boundary_status into automatic_state,boundary from clued_private.storage_automatic_reconcile_checks_v1 check_row
   where check_row.intent_id=m.id and check_row.user_id=j.owner_id and check_row.base_version=m.version
    and check_row.source_receipt_id=q.close_receipt_id and check_row.state='current_state_conflict';
  result:=result||jsonb_build_object('automatic_recovery',coalesce(automatic_state,'pending'));
  if automatic_state is null then result:=result||jsonb_build_object('review_available',false,'abandon_available',false); end if;
  if boundary is not null and boundary<>'qualified' then
   result:=result||jsonb_build_object('review_available',false,'review_unavailable_reason','REVIEW_UNAVAILABLE'); end if;
 end if; return result;
end $$;

do $acl$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='clued_private' and (p.proname like 'storage_automatic_reconcile_%' or p.proname in
   ('storage_automatic_reconcile_v1','storage_conflict_load_before_automatic_v1','storage_scheduled_before_automatic_v1',
    'storage_job_status_before_automatic_v1','storage_conflict_public_before_automatic_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role,clued_worker_gateway',f.sig);
 end loop;
end $acl$;
notify pgrst,'reload schema';
