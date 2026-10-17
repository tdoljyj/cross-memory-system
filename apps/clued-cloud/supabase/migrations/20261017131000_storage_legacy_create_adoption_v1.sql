-- A separately authorized current registration of an existing legacy create.
-- No provider effect, old authority snapshot, old successful result or old
-- Receipt is recreated. Every helper remains private to the issuer wrapper.
create function clued_private.storage_legacy_create_registration_authority_v1(
 p_issuer_identity text,p_connection uuid,p_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare authority jsonb;j clued_private.storage_jobs_v1;required_class text;master jsonb;
begin
 authority:=clued_private.storage_registration_program_authority_v1(p_issuer_identity,p_connection,p_job);
 select * into j from clued_private.storage_jobs_v1 where connection_id=p_connection and job_id=p_job;
 master:=clued_private.storage_master_snapshot_v1(j.owner_id,(authority->'registration_authority'->>'connection_id')::uuid);
 required_class:=case when j.mutation->>'target_kind'='directory' then 'create_topic' else 'create_file' end;
 if j.mutation->>'operation' is distinct from 'create'
 or j.mutation->>'target_kind' not in ('file','directory')
 or not coalesce((authority->'registration_authority'->'actions') ? required_class,false)
 or master->'create_enabled' is distinct from 'true'::jsonb
 or master->'allow_base_create' is distinct from 'true'::jsonb
 or master->>'status_digest' is distinct from authority->'registration_authority'->>'master_status_digest' then
  raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
 return authority;
end $$;
revoke all on function clued_private.storage_legacy_create_registration_authority_v1(text,uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_legacy_create_registration_plan_v1(
 p_issuer_identity text,p_connection uuid,p_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare reader jsonb;descriptor jsonb;j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;
 q clued_private.storage_conflict_isolations_v1;p clued_private.resource_center_profiles_v1;
 node clued_private.resource_center_artifacts_v1;attempt_receipt public.clued_audit_receipts;
 parents jsonb:='[]';parent_path text;parent_id text;last_path text;last_id text;expected jsonb;
 destination text;target_size text;target_sha text;target_mime text;
begin
 reader:=clued_private.storage_legacy_create_registration_authority_v1(p_issuer_identity,p_connection,p_job);
 select * into j from clued_private.storage_jobs_v1 where connection_id=p_connection and job_id=p_job for share;
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id for share;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for share;
 select * into p from clued_private.resource_center_profiles_v1 where id=m.profile_id and user_id=j.owner_id for share;
 select * into attempt_receipt from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=j.owner_id;
 destination:=j.mutation->>'destination_path';parent_path:=regexp_replace(destination,'/[^/]+$','');
 target_size:=case when j.mutation->>'target_kind'='file' then case when j.mutation ? 'content_ref'
  then j.mutation->'content_ref'->>'size' else octet_length(j.mutation->>'content')::text end end;
 target_sha:=case when j.mutation->>'target_kind'='file' then case when j.mutation ? 'content_ref'
  then j.mutation->'content_ref'->>'sha256' else encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end end;
 target_mime:=case when j.mutation->>'target_kind'='directory' then 'application/vnd.google-apps.folder'
  when j.mutation ? 'content_ref' then j.mutation->'content_ref'->>'mime_type'
  else clued_private.storage_semantic_text_mime_v1(regexp_replace(destination,'^.*/','')) end;
 expected:=jsonb_build_object('contract','clued.resource-center-provider-attempt/1','intent_id',m.id,
  'request_sha256',m.request_sha256,'profile_id',p.id,'provider_file_id',m.provider_attempt->>'provider_file_id',
  'destination_path',destination,'parent_id',m.authority_request->'provider_identity'->>'destination_parent_id',
  'target_kind',j.mutation->>'target_kind','binding',m.exact_request->'binding','size',target_size,'sha256',target_sha);
 if not clued_private.storage_legacy_create_absent_candidate_v1(j)
 or m.provider_attempt is distinct from expected or q.object_ids[1] is distinct from expected->>'provider_file_id'
 or p.id is null or p.state<>'active' or p.root_folder_id is distinct from q.root_folder_id
 or attempt_receipt.status is distinct from 'committed' or attempt_receipt.operation is distinct from 'storage_provider_attempt'
 or attempt_receipt.response_hash is distinct from clued_private.m1_sha256(attempt_receipt.canonical_result)
 or attempt_receipt.canonical_result is distinct from clued_private.m1_result_envelope(attempt_receipt)
 or attempt_receipt.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object(
  'operation','storage_provider_attempt','payload',jsonb_build_object('intent_id',m.id,'attempt_digest',clued_private.m1_sha256(expected))))
 or attempt_receipt.idempotency_key is distinct from 'storage-provider-attempt:'||m.id::text
 or attempt_receipt.received_payload_hash is distinct from clued_private.m1_sha256(jsonb_build_object(
  'idempotency_key','storage-provider-attempt:'||m.id::text,'intent_id',m.id,'attempt_digest',clued_private.m1_sha256(expected)))
 or not exists(select 1 from public.clued_context_events event where event.id::text=any(attempt_receipt.event_ids)
  and event.receipt_id=attempt_receipt.id and event.user_id=j.owner_id and event.result='success'
  and event.canonical_event_type='extension:storage:provider_attempt_recorded'
  and event.change_summary->>'intent_id'=m.id::text
  and event.change_summary->>'attempt_digest'=clued_private.m1_sha256(expected))
 or m.expires_at is null or greatest(m.expires_at,attempt_receipt.created_at)+interval '132 minutes'>clock_timestamp()
 or not starts_with(destination,p.managed_root||'/') or parent_path=p.managed_root
 or destination~'[[:cntrl:]\\]' or regexp_replace(destination,'^.*/','') in ('','.','..')
 or target_mime is null or length(target_mime) not between 1 and 255
 or j.mutation->>'target_kind'='file' and (coalesce(target_size,'')!~'^(0|[1-9][0-9]{0,19})$'
  or coalesce(target_sha,'')!~'^[0-9a-f]{64}$' or target_mime like 'application/vnd.google-apps.%')
 or q.paths is distinct from array[destination] or q.object_ids[1] in (p.root_folder_id,p.root_parent_id)
 or exists(select 1 from clued_private.resource_center_artifacts_v1 a where a.user_id=j.owner_id and a.profile_id=p.id
  and (a.provider_file_id=q.object_ids[1] or a.state in ('active','trashed') and
   (a.path=destination or starts_with(a.path,destination||'/')))) then
  raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
 -- Existing trusted loader checks original job/intent/request/attempt/I9
 -- Receipt and supplies the current reader; it does not restore execution.
 descriptor:=clued_private.storage_conflict_load_v1(p_issuer_identity,
  jsonb_build_object('action','load','connection_id',p_connection,'job_id',p_job));
 if descriptor->>'intent_id' is distinct from m.id::text or descriptor->>'request_sha256' is distinct from m.request_sha256
 or descriptor->>'version' is distinct from m.version::text or descriptor->'attempt' is distinct from expected then
  raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
 perform 1 from public.clued_memories decision where decision.user_id=j.owner_id and decision.id in (
  select p.source_decision_id union select (reader->'registration_authority'->>'source_decision_id')::uuid
  union select ancestor.source_decision_id from clued_private.resource_center_ancestor_rows_v1(p.id,j.owner_id,array[parent_path]) ancestor)
  order by decision.id for share nowait;
 last_path:=null;last_id:=null;
 for node in select * from clued_private.resource_center_ancestor_rows_v1(p.id,j.owner_id,array[parent_path]) a
  order by a.path collate "C" for share loop
  parent_id:=case when node.path=p.managed_root then p.root_parent_id else last_id end;
  if node.path=p.managed_root and (last_path is not null or node.provider_file_id is distinct from p.root_folder_id)
  or node.path<>p.managed_root and (last_path is null or regexp_replace(node.path,'/[^/]+$','') is distinct from last_path)
  or node.provider_file_id is null or parent_id is null
  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,node.source_decision_id)
  or not clued_private.resource_center_path_current_v1(j.owner_id,p.project_id,p.id,p.managed_root,node.path) then
   raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
  parents:=parents||jsonb_build_array(clued_private.storage_current_registration_node_v1(node,parent_id));
  last_path:=node.path;last_id:=node.provider_file_id;
 end loop;
 if jsonb_array_length(parents) not between 2 and 20 or parents->0->>'path' is distinct from p.managed_root
 or last_path is distinct from parent_path or last_id is distinct from expected->>'parent_id'
 or node.governance_class is distinct from 'ordinary' then
  raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
 return reader||jsonb_build_object('status','registration_required','connection_id',j.connection_id,'job_id',j.job_id,
  'owner_id',j.owner_id,'intent_id',m.id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'registration_plan',jsonb_build_object('contract','clued.storage-registration-plan/1','mode','adopt_create',
   'managed_root',p.managed_root,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,
   'intent_id',m.id,'request_sha256',m.request_sha256,'parents',parents,
   'target',jsonb_build_object('path',destination,'provider_file_id',q.object_ids[1],'parent_id',last_id,
    'target_kind',j.mutation->>'target_kind','mime_type',target_mime,'size',target_size,'sha256',target_sha)),
  'execution_permitted',false);
end $$;
revoke all on function clued_private.storage_legacy_create_registration_plan_v1(text,uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;



create function clued_private.storage_legacy_create_registration_observation_v1(p_plan jsonb,p_observation jsonb) returns void
language plpgsql immutable security definer set search_path='' as $$
declare node jsonb;observed jsonb;idx integer;owner_permission text;discovery text;expected_access text;expected_sharing text;
begin
 if jsonb_typeof(p_observation) is distinct from 'object'
 or p_observation-array['contract','mode','parents','target','observed_at']<>'{}'
 or p_observation->>'contract' is distinct from 'clued.storage-registration-observation/1'
 or jsonb_typeof(p_observation->'observed_at') is distinct from 'string'
 or p_observation->'mode' is distinct from p_plan->'mode'
 or jsonb_typeof(p_observation->'parents') is distinct from 'array'
 or jsonb_array_length(p_observation->'parents')<>jsonb_array_length(p_plan->'parents') then
  raise exception 'storage_current_registration_proof_invalid' using errcode='22023';end if;
 for idx in 0..jsonb_array_length(p_plan->'parents') loop
  if idx=jsonb_array_length(p_plan->'parents') then node:=p_plan->'target';observed:=p_observation->'target';
  else node:=p_plan->'parents'->idx;observed:=p_observation->'parents'->idx;end if;
  if jsonb_typeof(observed) is distinct from 'object'
  or observed-array['target_kind','artifact_id','artifact_version','path','provider_file_id','parent_id','access_digest','sharing_digest',
   'provider_file_version','owner_permission_id','owner_allow_file_discovery',
   case when idx=jsonb_array_length(p_plan->'parents') then 'mime_type' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'size' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'sha256' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'empty' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'intent_tag' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'request_tag' end]<>'{}'
  or observed-array['provider_file_version','access_digest','sharing_digest','owner_permission_id','owner_allow_file_discovery',
   'mime_type','size','sha256','empty','intent_tag','request_tag'] is distinct from node-array['access_digest','sharing_digest','mime_type','size','sha256']
  or jsonb_typeof(observed->'provider_file_version') is distinct from 'string'
  or jsonb_typeof(observed->'owner_permission_id') is distinct from 'string'
  or jsonb_typeof(observed->'access_digest') is distinct from 'string'
  or jsonb_typeof(observed->'sharing_digest') is distinct from 'string'
  or coalesce(observed->>'provider_file_version','')!~'^[1-9][0-9]{0,39}$'
  or coalesce(observed->>'owner_permission_id','')!~'^[A-Za-z0-9_.:-]{1,200}$'
  or (observed->'owner_allow_file_discovery') is null
  or observed->'owner_allow_file_discovery' not in ('null'::jsonb,'false'::jsonb) then
   raise exception 'storage_current_registration_proof_invalid' using errcode='22023';end if;
  owner_permission:=observed->>'owner_permission_id';discovery:=case when observed->'owner_allow_file_discovery'='false'::jsonb then 'false' else 'null' end;
  expected_access:=encode(sha256(convert_to('{"permissions":[['||to_json(owner_permission)::text||',"user","owner",null,'||discovery||',null,false]]}','UTF8')),'hex');
  expected_sharing:=encode(sha256(convert_to('{"shared":false,"permission_ids":['||to_json(owner_permission)::text||']}','UTF8')),'hex');
  if observed->>'access_digest' is distinct from expected_access or observed->>'sharing_digest' is distinct from expected_sharing
  or node->>'access_digest' is not null and node->>'access_digest' is distinct from expected_access
  or node->>'sharing_digest' is not null and node->>'sharing_digest' is distinct from expected_sharing then
   raise exception 'storage_current_registration_acl_changed' using errcode='40001';end if;
 end loop;
 if p_plan->>'mode' is distinct from 'adopt_create'
 or p_observation->'target'->'target_kind' is distinct from p_plan->'target'->'target_kind'
 or p_observation->'target'->'mime_type' is distinct from p_plan->'target'->'mime_type'
 or p_observation->'target'->'size' is distinct from p_plan->'target'->'size'
 or p_observation->'target'->'sha256' is distinct from p_plan->'target'->'sha256'
 or p_observation->'target'->'intent_tag' is distinct from p_plan->'intent_id'
 or p_observation->'target'->'request_tag' is distinct from p_plan->'request_sha256'
 or p_plan->'target'->>'target_kind'='directory' and (p_observation->'target'->'empty' is distinct from 'true'::jsonb
  or p_observation->'target'->'mime_type' is distinct from '"application/vnd.google-apps.folder"'::jsonb
  or p_observation->'target'->'size' is distinct from 'null'::jsonb or p_observation->'target'->'sha256' is distinct from 'null'::jsonb)
 or p_plan->'target'->>'target_kind'='file' and (p_observation->'target'->'empty' is distinct from 'null'::jsonb
  or coalesce(p_observation->'target'->>'size','')!~'^(0|[1-9][0-9]{0,19})$'
  or coalesce(p_observation->'target'->>'sha256','')!~'^[0-9a-f]{64}$'
  or p_observation->'target'->>'mime_type' like 'application/vnd.google-apps.%')
 or p_observation->'target'->'access_digest' is distinct from (p_observation->'parents'->-1)->'access_digest'
 or p_observation->'target'->'sharing_digest' is distinct from (p_observation->'parents'->-1)->'sharing_digest' then
  raise exception 'storage_current_registration_proof_invalid' using errcode='22023';end if;
end $$;
revoke all on function clued_private.storage_legacy_create_registration_observation_v1(jsonb,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_legacy_create_registration_v1(p_issuer_identity text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d jsonb;authority jsonb;plan jsonb;first jsonb:=p_input->'first_observation';second jsonb:=p_input->'second_observation';
 j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;q clued_private.storage_conflict_isolations_v1;
 p clued_private.resource_center_profiles_v1;saved clued_private.storage_current_registration_results_v1;
 a clued_private.resource_center_artifacts_v1;next_artifact clued_private.resource_center_artifacts_v1;
 node jsonb;observed jsonb;idx integer;qualified_at timestamptz;
 first_at timestamptz;second_at timestamptz;req jsonb;refs jsonb;ev text;result jsonb;r public.clued_audit_receipts;
 created_id uuid:=gen_random_uuid();created_artifact clued_private.resource_center_artifacts_v1;
 changed_ids uuid[]:='{}';before_rows jsonb:='[]';after_rows jsonb:='[]';base_versions jsonb;committed_versions jsonb;changed jsonb;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or coalesce(p_input->>'action','') not in ('registration_current_load','registration_current_commit')
 or p_input-array['action','connection_id','job_id',
  case when p_input->>'action'='registration_current_commit' then 'base_version' end,
  case when p_input->>'action'='registration_current_commit' then 'source_receipt_id' end,
  case when p_input->>'action'='registration_current_commit' then 'registration_authority' end,
  case when p_input->>'action'='registration_current_commit' then 'registration_plan' end,
  case when p_input->>'action'='registration_current_commit' then 'first_observation' end,
  case when p_input->>'action'='registration_current_commit' then 'second_observation' end]<>'{}' then
  raise exception 'storage_current_registration_invalid' using errcode='22023';end if;
 -- Even read-only replay needs a valid current program actor. The first call
 -- acquires issuer/app -> original client -> job -> root/account in order.
 authority:=clued_private.storage_legacy_create_registration_authority_v1(p_issuer_identity,
  (p_input->>'connection_id')::uuid,(p_input->>'job_id')::uuid);
 select * into j from clued_private.storage_jobs_v1 where connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid for update;
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id for update;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for update;
 select * into p from clued_private.resource_center_profiles_v1 where id=m.profile_id and user_id=j.owner_id for share;
 select * into saved from clued_private.storage_current_registration_results_v1 where intent_id=m.id and owner_id=j.owner_id;
 if saved.intent_id is not null then
  if q.state is distinct from 'resolved' or q.resolution_receipt_id is distinct from saved.receipt_id
  or m.final_result->>'automatic_resolution' is distinct from 'automatically_registered_current_state'
  or m.final_result->>'automatic_receipt_id' is distinct from saved.receipt_id::text
  or m.final_result->>'automatic_base_version' is distinct from saved.base_version::text
  or not exists(select 1 from public.clued_audit_receipts receipt where receipt.id=saved.receipt_id
   and receipt.user_id=j.owner_id and receipt.operation='storage_current_registration_reconcile' and receipt.status='committed'
   and receipt.response_hash=clued_private.m1_sha256(receipt.canonical_result)) then
   raise exception 'storage_current_registration_conflict' using errcode='40001';end if;
  if p_input->>'action'='registration_current_commit' and (p_input->>'base_version' is distinct from saved.base_version::text
   or p_input->>'source_receipt_id' is distinct from saved.source_receipt_id::text
   or p_input->'registration_authority' is distinct from saved.authority or p_input->'registration_plan' is distinct from saved.plan
   or jsonb_build_object('first_observation',first,'second_observation',second) is distinct from saved.observations) then
   raise exception 'storage_current_registration_conflict' using errcode='40001';end if;
  return saved.result;
 end if;
 d:=clued_private.storage_legacy_create_registration_plan_v1(p_issuer_identity,j.connection_id,j.job_id);
 if p_input->>'action'='registration_current_load' then return d;end if;
 plan:=d->'registration_plan';
 if p_input->>'base_version' is distinct from m.version::text or p_input->>'source_receipt_id' is distinct from q.close_receipt_id::text
 or p_input->'registration_authority' is distinct from d->'registration_authority' or p_input->'registration_plan' is distinct from plan then
  raise exception 'storage_current_registration_conflict' using errcode='40001';end if;
 perform clued_private.storage_legacy_create_registration_observation_v1(plan,first);
 perform clued_private.storage_legacy_create_registration_observation_v1(plan,second);
 first_at:=(first->>'observed_at')::timestamptz;second_at:=(second->>'observed_at')::timestamptz;
 if first_at is null or second_at is null or first_at>second_at or first_at<clock_timestamp()-interval '30 seconds'
 or second_at>clock_timestamp()+interval '5 seconds'
 or first-array['observed_at','parents'] is distinct from second-array['observed_at','parents']
 or (select jsonb_agg(x-'provider_file_version' order by n) from jsonb_array_elements(first->'parents') with ordinality v(x,n))
  is distinct from (select jsonb_agg(x-'provider_file_version' order by n) from jsonb_array_elements(second->'parents') with ordinality v(x,n)) then
  raise exception 'storage_current_registration_proof_changed' using errcode='40001';end if;
 -- Acquire Artifact rows in one stable order. A new permission mode must not
 -- invalidate a still-running operation or an already recorded verified
 -- result that depends on that exact directory. Other paths keep running.
 perform 1 from clued_private.resource_center_artifacts_v1 artifact
  where artifact.user_id=j.owner_id and artifact.profile_id=p.id
  and artifact.id in (select (x->>'artifact_id')::uuid from jsonb_array_elements(plan->'parents') x)
  order by artifact.id for update;
 for idx in 0..jsonb_array_length(plan->'parents')-1 loop
  node:=plan->'parents'->idx;observed:=second->'parents'->idx;
  select * into a from clued_private.resource_center_artifacts_v1 where id=(node->>'artifact_id')::uuid and user_id=j.owner_id and profile_id=p.id;
  if a.id is null or a.version::text is distinct from node->>'artifact_version' or a.state<>'active'
  or a.path is distinct from node->>'path' or a.provider_file_id is distinct from node->>'provider_file_id'
  or a.provider_access_digest is distinct from node->>'access_digest' or a.provider_sharing_digest is distinct from node->>'sharing_digest'
  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,a.source_decision_id) then
   raise exception 'storage_current_registration_conflict' using errcode='40001';end if;
  if a.provider_access_digest is null then
   if exists(select 1 from clued_private.resource_center_mutations_v1 other where other.user_id=j.owner_id and other.profile_id=p.id
    and other.id<>m.id and (other.state in ('prepared','started','uncertain') or other.state='conflict'
      and other.verified_result_v2 is not null and exists(select 1 from clued_private.storage_conflict_isolations_v1 other_q
       where other_q.intent_id=other.id and other_q.state='active'))
    and (other.exact_request->'binding'->>'artifact_id'=a.id::text
     or other.authority_request->'provider_identity'->>'source_file_id'=a.provider_file_id
     or other.authority_request->'provider_identity'->>'destination_file_id'=a.provider_file_id
     or exists(select 1 from jsonb_array_elements(coalesce(other.authority_request->'provider_identity'->'ancestors','[]')) link
       where link->>'id'=a.provider_file_id)
     or (other.authority_request->'provider_identity'->>'root_folder_id'=a.provider_file_id)
     or other.authority_request->'provider_identity'->>'source_parent_id'=a.provider_file_id
     or other.authority_request->'provider_identity'->>'destination_parent_id'=a.provider_file_id)) then
    raise exception 'storage_current_registration_object_busy' using errcode='40001';end if;
   changed_ids:=array_append(changed_ids,a.id);before_rows:=before_rows||jsonb_build_array(to_jsonb(a));
  end if;
 end loop;
 -- Wall-clock validity is rechecked after all potentially waiting locks. A
 -- statement-start snapshot/now() cannot authorize work across an expiry.
 authority:=clued_private.storage_legacy_create_registration_authority_v1(p_issuer_identity,j.connection_id,j.job_id);
 if authority->'registration_authority' is distinct from d->'registration_authority'
 or clock_timestamp()-first_at>interval '30 seconds' then
  raise exception 'storage_current_registration_authority_changed' using errcode='40001';end if;
 req:=jsonb_build_object('idempotency_key','storage-current-registration:'||m.id::text||':'||m.version::text,
  'intent_id',m.id,'connection_id',j.connection_id,'job_id',j.job_id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'original_attempt_receipt_id',m.provider_attempt_receipt_id,'original_attempt_digest',clued_private.m1_sha256(m.provider_attempt),
  'registration_authority',d->'registration_authority','registration_plan',plan,'created_target_id',created_id,
  'first_observation',first,'second_observation',second,'before_rows',before_rows,'reason_code','CURRENT_REGISTRATION_QUALIFIED');
 r:=clued_private.m1_begin_receipt(j.owner_id,null,'storage_current_registration_reconcile',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_current_registration_conflict' using errcode='40001';end if;
 insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
 qualified_at:=clock_timestamp();
 for idx in 0..jsonb_array_length(plan->'parents')-1 loop
  node:=plan->'parents'->idx;observed:=second->'parents'->idx;
  if (node->>'artifact_id')::uuid=any(changed_ids) then
   select * into a from clued_private.resource_center_artifacts_v1 where id=(node->>'artifact_id')::uuid;
   next_artifact:=jsonb_populate_record(a,jsonb_build_object('provider_access_digest',observed->>'access_digest',
    'provider_sharing_digest',observed->>'sharing_digest','provider_file_version',observed->>'provider_file_version',
    'access_digest_missing_at',null,'access_digest_attempted_at',qualified_at,'receipt_id',r.id,'version',a.version+1,'updated_at',qualified_at));
   insert into clued_private.storage_registration_artifact_permits_v1
    values(txid_current(),a.id,r.id,m.id,j.owner_id,p.id,clued_private.m1_sha256(to_jsonb(a)),clued_private.m1_sha256(to_jsonb(next_artifact)));
   update clued_private.resource_center_artifacts_v1 set provider_access_digest=next_artifact.provider_access_digest,
    provider_sharing_digest=next_artifact.provider_sharing_digest,provider_file_version=next_artifact.provider_file_version,
    access_digest_missing_at=null,access_digest_attempted_at=qualified_at,receipt_id=r.id,version=next_artifact.version,updated_at=qualified_at
    where id=(node->>'artifact_id')::uuid returning * into a;
   after_rows:=after_rows||jsonb_build_array(to_jsonb(a));
  end if;
 end loop;
 -- No INSERT bypass: the normal Artifact trigger checks every other I9
 -- object/slot/subtree. Only this intent has an exact pending-receipt exit.
 insert into clued_private.resource_center_artifacts_v1(id,user_id,profile_id,path,provider_file_id,provider_file_version,
  target_kind,governance_class,delete_authority,source_decision_id,receipt_id,provider_access_digest,provider_sharing_digest,
  access_digest_missing_at,access_digest_attempted_at,created_at,updated_at)
 values(created_id,j.owner_id,p.id,plan->'target'->>'path',plan->'target'->>'provider_file_id',
  second->'target'->>'provider_file_version',plan->'target'->>'target_kind','ordinary',false,
  (d->'registration_authority'->>'source_decision_id')::uuid,r.id,
  case when plan->'target'->>'target_kind'='directory' then second->'target'->>'access_digest' end,
  case when plan->'target'->>'target_kind'='directory' then second->'target'->>'sharing_digest' end,null,
  case when plan->'target'->>'target_kind'='directory' then qualified_at end,qualified_at,qualified_at)
 returning * into created_artifact;
 after_rows:=after_rows||jsonb_build_array(to_jsonb(created_artifact));
 update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 update clued_private.resource_center_mutations_v1 set version=version+1,updated_at=clock_timestamp(),
  final_result=final_result||jsonb_build_object('automatic_resolution','automatically_registered_current_state',
   'automatic_receipt_id',r.id,'automatic_base_version',m.version) where id=m.id;
 result:=jsonb_build_object('status','resolved','resolution','automatically_registered_current_state','automatic_recovery','resolved',
  'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',r.id,
  'source_receipt_id',q.close_receipt_id,'base_version',m.version,'artifact_id',created_id,'execution_permitted',false);
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 base_versions:=jsonb_build_object(m.id::text,m.version);committed_versions:=jsonb_build_object(m.id::text,m.version+1);
 refs:=refs||jsonb_build_array(jsonb_build_object('kind','system','role','target','id',created_id));
 base_versions:=base_versions||jsonb_build_object(created_id::text,0);
 committed_versions:=committed_versions||jsonb_build_object(created_id::text,1);
 for changed in select value from jsonb_array_elements(before_rows) loop
  refs:=refs||jsonb_build_array(jsonb_build_object('kind','system','role','target','id',changed->>'id'));
  base_versions:=base_versions||jsonb_build_object(changed->>'id',changed->'version');
  committed_versions:=committed_versions||jsonb_build_object(changed->>'id',(changed->>'version')::bigint+1);
 end loop;
 ev:=clued_private.m1_append_event_row(j.owner_id,null,r.id,r.canonical_version,'extension:storage:current_registration_reconciled',
  refs,'project:'||p.project_id::text,null,req||jsonb_build_object('after_rows',after_rows),req->>'idempotency_key',r.request_sha256,
  'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,base_versions,committed_versions,array[ev],'{}'::uuid[],null);
 insert into clued_private.storage_current_registration_results_v1(intent_id,owner_id,original_connection_id,job_id,base_version,
  source_receipt_id,authority,plan,observations,receipt_id,result)
 values(m.id,j.owner_id,j.connection_id,j.job_id,m.version,q.close_receipt_id,d->'registration_authority',plan,
  jsonb_build_object('first_observation',first,'second_observation',second),r.id,result);
 return result;
end $$;
revoke all on function clued_private.storage_legacy_create_registration_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Preserve the entire accepted directory branch behind a private clone.
do $clone$ declare body text;begin
 if (select md5(prosrc) from pg_proc where oid='clued_private.storage_current_registration_reconcile_v1(text,jsonb)'::regprocedure)
  is distinct from '0e7115ba1f0b0f4789782f5e84b468b0' then raise exception 'storage_create_registration_source_mismatch';end if;
 body:=pg_get_functiondef('clued_private.storage_current_registration_reconcile_v1(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_current_registration_reconcile_v1(',
  'FUNCTION clued_private.storage_registration_before_create_v1(');
end $clone$;
revoke all on function clued_private.storage_registration_before_create_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;
create or replace function clued_private.storage_current_registration_reconcile_v1(p_issuer_identity text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform clued_private.storage_recovery_client_input_guard_v1(p_input);
 if exists(select 1 from clued_private.storage_jobs_v1 j
  where j.connection_id=(p_input->>'connection_id')::uuid and j.job_id=(p_input->>'job_id')::uuid
  and j.mutation->>'operation'='create') then
  return clued_private.storage_legacy_create_registration_v1(p_issuer_identity,p_input);end if;
 return clued_private.storage_registration_before_create_v1(p_issuer_identity,p_input);
end $$;
revoke all on function clued_private.storage_current_registration_reconcile_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;
