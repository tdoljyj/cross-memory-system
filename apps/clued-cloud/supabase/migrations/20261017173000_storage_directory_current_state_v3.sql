-- A separate, current directory-state qualification. The old operation stays
-- conflicted; no Google write, restored writer, user checkbox or success rewrite.
-- Existing typed-result settlement still runs first in the recovery program.
create table clued_private.storage_directory_state_permits_v3(
 transaction_id bigint not null,artifact_id uuid not null,receipt_id uuid not null references public.clued_audit_receipts(id),
 intent_id uuid not null,owner_id uuid not null,profile_id uuid not null,before_hash text not null,after_hash text not null,
 primary key(transaction_id,artifact_id));
alter table clued_private.storage_directory_state_permits_v3 enable row level security;
revoke all on clued_private.storage_directory_state_permits_v3 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_directory_state_permitted_v3(
 p_before clued_private.resource_center_artifacts_v1,p_after clued_private.resource_center_artifacts_v1) returns boolean
language plpgsql security definer set search_path='' as $$
declare permit clued_private.storage_directory_state_permits_v3;
 p clued_private.resource_center_profiles_v1;q clued_private.storage_conflict_isolations_v1;
 qp clued_private.resource_center_profiles_v1;relative_path text;relative_subtree text;subtree text;parent_id text;
begin
 select x.* into permit from clued_private.storage_directory_state_permits_v3 x
  join public.clued_audit_receipts r on r.id=x.receipt_id and r.user_id=x.owner_id
  where x.transaction_id=txid_current() and x.artifact_id=p_before.id and x.owner_id=p_before.user_id
   and x.profile_id=p_before.profile_id and x.receipt_id=p_after.receipt_id
   and x.before_hash=clued_private.m1_sha256(to_jsonb(p_before)) and x.after_hash=clued_private.m1_sha256(to_jsonb(p_after))
   and r.status='pending' and r.operation='storage_current_registration_reconcile';
 if permit.artifact_id is null then return false;end if;
 if (to_jsonb(p_before)-array['state','provider_access_digest','provider_sharing_digest','provider_file_version','version','receipt_id',
   'access_digest_missing_at','access_digest_attempted_at','updated_at']) is distinct from
  (to_jsonb(p_after)-array['state','provider_access_digest','provider_sharing_digest','provider_file_version','version','receipt_id',
   'access_digest_missing_at','access_digest_attempted_at','updated_at'])
 or p_before.target_kind<>'directory' or p_before.governance_class<>'ordinary'
 or p_before.state not in ('active','trashed') or p_after.state not in ('active','trashed')
 or p_after.version<>p_before.version+1 or p_after.access_digest_missing_at is not null
 or p_after.provider_access_digest is null or p_after.provider_sharing_digest is null
 or p_before.provider_access_digest is not null and p_before.provider_access_digest is distinct from p_after.provider_access_digest
 or p_before.provider_sharing_digest is not null and p_before.provider_sharing_digest is distinct from p_after.provider_sharing_digest then
  raise exception 'storage_directory_state_permit_invalid' using errcode='42501';end if;
 select * into p from clued_private.resource_center_profiles_v1 where id=p_before.profile_id and user_id=p_before.user_id;
 if p.id is null or p_before.provider_file_id in (p.root_folder_id,p.root_parent_id)
 or regexp_replace(p_before.path,'/[^/]+$','')=p.managed_root
 or exists(select 1 from clued_private.resource_center_artifacts_v1 child
  where child.user_id=p_before.user_id and child.profile_id=p_before.profile_id and child.state in ('active','trashed')
   and starts_with(child.path,p_before.path||'/'))
 or exists(select 1 from clued_private.resource_center_artifacts_v1 alias
  where alias.provider_file_id=p_before.provider_file_id and alias.id<>p_before.id and alias.state in ('active','trashed')) then
  raise exception 'storage_directory_state_permit_invalid' using errcode='42501';end if;
 relative_path:=substr(p_before.path,length(p.managed_root)+1);
 select provider_file_id into parent_id from clued_private.resource_center_artifacts_v1 parent
  where parent.user_id=p_before.user_id and parent.profile_id=p_before.profile_id and parent.state='active'
   and parent.path=regexp_replace(p_before.path,'/[^/]+$','');
 -- Unlike an ancestor metadata refresh, a state transition may affect every
 -- descendant. Unknown scope and actual ancestor dependencies remain fenced.
 for q in select * from clued_private.storage_conflict_isolations_v1 where state='active'
  and (root_folder_id=p.root_folder_id or p_before.provider_file_id=any(object_ids) or p_before.provider_file_id=any(ancestor_ids)) loop
  if q.intent_id=permit.intent_id and clued_private.storage_conflict_exit_allowed_v1(q.intent_id,permit.receipt_id) then continue;end if;
  if not q.scope_complete or p_before.provider_file_id=any(q.object_ids) or p_before.provider_file_id=any(q.ancestor_ids)
  or p_before.profile_id=q.profile_id and exists(select 1 from unnest(q.paths) path where path=p_before.path or starts_with(path,p_before.path||'/'))
  or exists(select 1 from jsonb_array_elements(q.slots) slot where slot->>'parent_id'=p_before.provider_file_id
   or slot->>'parent_id'=parent_id and slot->>'name'=regexp_replace(p_before.path,'^.*/','')) then
   raise exception 'storage_object_under_review' using errcode='42501';end if;
  select * into qp from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=q.user_id;
  foreach subtree in array q.subtree_paths loop
   relative_subtree:=substr(subtree,length(qp.managed_root)+1);
   if qp.id is null or q.root_folder_id=p.root_folder_id and
    (relative_path=relative_subtree or starts_with(relative_path,relative_subtree||'/') or starts_with(relative_subtree,relative_path||'/')) then
    raise exception 'storage_object_under_review' using errcode='42501';end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function clued_private.storage_directory_state_permitted_v3(
 clued_private.resource_center_artifacts_v1,clued_private.resource_center_artifacts_v1)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Clone pinned, already accepted implementations. Every edit has an exact
-- occurrence assertion; the old helpers and their ACLs remain intact.
do $upgrade$
declare definition text;old_text text;new_text text;item record;
begin
 for item in select * from (values
  ('clued_private.storage_current_registration_plan_v1(text,uuid,uuid)','a6cb230bb3cd538553b9d7567bc896c9'),
  ('clued_private.storage_current_registration_observation_v1(jsonb,jsonb)','482866097b27cf1cae2bba5f80bc3b5b'),
  ('clued_private.storage_registration_before_create_v1(text,jsonb)','0e7115ba1f0b0f4789782f5e84b468b0'),
  ('clued_private.storage_conflict_artifact_guard_v1()','2faf789ac6fdebad422a4b91ad2e47d9')
 ) expected(signature,source_md5) loop
  if (select md5(prosrc) from pg_proc where oid=to_regprocedure(item.signature)) is distinct from item.source_md5 then
   raise exception 'storage_directory_state_source_changed: %',item.signature;end if;
 end loop;
 definition:=pg_get_functiondef('clued_private.storage_current_registration_plan_v1(text,uuid,uuid)'::regprocedure);
 definition:=replace(definition,'FUNCTION clued_private.storage_current_registration_plan_v1(',
  'FUNCTION clued_private.storage_directory_state_plan_v3(');
 for item in select * from (values
  ('a.state<>''active''','a.state not in (''active'',''trashed'')'),
  ('p.id,p.managed_root,a.path)','p.id,p.managed_root,parent_path)'),
  ('''mode'',''refresh_directory''','''mode'',''refresh_directory_state'''),
  ('clued_private.storage_current_registration_node_v1(a,last_id)',
   '(clued_private.storage_current_registration_node_v1(a,last_id)||jsonb_build_object(''registered_state'',a.state))')
 ) patch(old_text,new_text) loop
  if (length(definition)-length(replace(definition,item.old_text,'')))/length(item.old_text)<>1 then
   raise exception 'storage_directory_state_plan_anchor_changed: %',item.old_text;end if;
  definition:=replace(definition,item.old_text,item.new_text);
 end loop;
 execute definition;

 definition:=pg_get_functiondef('clued_private.storage_current_registration_observation_v1(jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,'FUNCTION clued_private.storage_current_registration_observation_v1(',
  'FUNCTION clued_private.storage_directory_state_observation_v3(');
 old_text:='case when idx=jsonb_array_length(p_plan->''parents'') then ''mime_type'' end,';
 new_text:=old_text||E'\n   case when idx=jsonb_array_length(p_plan->''parents'') then ''registered_state'' end,'||
  E'\n   case when idx=jsonb_array_length(p_plan->''parents'') then ''current_state'' end,';
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'storage_directory_state_observation_anchor_changed';end if;
 definition:=replace(definition,old_text,new_text);
 old_text:='''mime_type'',''size'',''sha256'',''empty'',''intent_tag'',''request_tag''] is distinct';
 new_text:='''mime_type'',''size'',''sha256'',''empty'',''intent_tag'',''request_tag'',''current_state''] is distinct';
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'storage_directory_state_observation_anchor_changed';end if;
 definition:=replace(definition,old_text,new_text);
 old_text:='jsonb_typeof(p_observation->''target''->''empty'') is distinct from ''boolean''';
 new_text:=$check$(p_plan->>'mode' is distinct from 'refresh_directory_state'
 or coalesce(p_plan->'target'->>'registered_state','') not in ('active','trashed')
 or coalesce(p_observation->'target'->>'current_state','') not in ('active','trashed')
 or p_observation->'target'->>'current_state'='active' and jsonb_typeof(p_observation->'target'->'empty') is distinct from 'boolean'
 or p_observation->'target'->>'current_state'='trashed' and p_observation->'target'->'empty' is distinct from 'null'::jsonb)$check$;
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'storage_directory_state_observation_anchor_changed';end if;
 execute replace(definition,old_text,new_text);

 definition:=pg_get_functiondef('clued_private.storage_registration_before_create_v1(text,jsonb)'::regprocedure);
 definition:=replace(definition,'FUNCTION clued_private.storage_registration_before_create_v1(',
  'FUNCTION clued_private.storage_directory_state_reconcile_v3(');
 definition:=replace(definition,'clued_private.storage_current_registration_plan_v1(','clued_private.storage_directory_state_plan_v3(');
 definition:=replace(definition,'clued_private.storage_current_registration_observation_v1(','clued_private.storage_directory_state_observation_v3(');
 for item in select * from (values
  ('a.version::text is distinct from node->>''artifact_version'' or a.state<>''active''',
   'a.version::text is distinct from node->>''artifact_version'' or a.state is distinct from coalesce(node->>''registered_state'',''active'')'),
  ('next_artifact:=jsonb_populate_record(a,jsonb_build_object(''provider_access_digest'',observed->>''access_digest'',',
   'next_artifact:=jsonb_populate_record(a,jsonb_build_object(''state'',coalesce(observed->>''current_state'',a.state),''provider_access_digest'',observed->>''access_digest'','),
  ('insert into clued_private.storage_registration_artifact_permits_v1',
   'insert into clued_private.storage_directory_state_permits_v3'),
  ('set provider_access_digest=next_artifact.provider_access_digest,',
   'set state=next_artifact.state,provider_access_digest=next_artifact.provider_access_digest,'),
  ('''source_receipt_id'',q.close_receipt_id,''base_version'',m.version,''execution_permitted'',false)',
   '''source_receipt_id'',q.close_receipt_id,''base_version'',m.version,''current_artifact_state'',second->''target''->''current_state'',''execution_permitted'',false)')
 ) patch(old_text,new_text) loop
  if (length(definition)-length(replace(definition,item.old_text,'')))/length(item.old_text)<>1 then
   raise exception 'storage_directory_state_commit_anchor_changed: %',item.old_text;end if;
  definition:=replace(definition,item.old_text,item.new_text);
 end loop;
 -- Parents are metadata-only; only the observed target may use the state
 -- permit. The existing metadata permit is deliberately not widened.
 old_text:='insert into clued_private.storage_directory_state_permits_v3';
 new_text:=$insert$if idx=jsonb_array_length(plan->'parents') then
   insert into clued_private.storage_directory_state_permits_v3$insert$;
 definition:=replace(definition,old_text,new_text);
 old_text:='clued_private.m1_sha256(to_jsonb(next_artifact)));';
 new_text:=old_text||$insert$
   else
    insert into clued_private.storage_registration_artifact_permits_v1
     values(txid_current(),a.id,r.id,m.id,j.owner_id,p.id,clued_private.m1_sha256(to_jsonb(a)),clued_private.m1_sha256(to_jsonb(next_artifact)));
   end if;$insert$;
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'storage_directory_state_permit_anchor_changed';end if;
 definition:=replace(definition,old_text,new_text);
 old_text:=E' -- Acquire Artifact rows in one stable order.';
 new_text:=$locks$ -- Share the existing physical-object lock domain across Owner/profile
 -- aliases. Do not wait while retaining Decision/Artifact shared locks.
 for node in select x from jsonb_array_elements((plan->'parents')||jsonb_build_array(plan->'target')) x
  order by x->>'provider_file_id' collate "C" loop
  if not pg_try_advisory_xact_lock(hashtextextended('storage-object:'||(node->>'provider_file_id'),0)) then
   raise exception 'storage_current_registration_object_busy' using errcode='40001';end if;
 end loop;
 -- Acquire Artifact rows in one stable order.$locks$;
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'storage_directory_state_lock_anchor_changed';end if;
 definition:=replace(definition,old_text,new_text);
 old_text:='other.user_id=j.owner_id and other.profile_id=p.id';
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'storage_directory_state_inflight_anchor_changed';end if;
 definition:=replace(definition,old_text,'true');
 old_text:='or (other.authority_request->''provider_identity''->>''root_folder_id''=a.provider_file_id)';
 new_text:=old_text||$busy$
     or (other.profile_id=p.id and jsonb_typeof(other.authority_request->'provider_identity') is distinct from 'object')$busy$;
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'storage_directory_state_unknown_inflight_anchor_changed';end if;
 definition:=replace(definition,old_text,new_text);
 execute definition;
 definition:=pg_get_functiondef('clued_private.storage_conflict_artifact_guard_v1()'::regprocedure);
 old_text:=E'\nbegin\n';
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'storage_directory_state_guard_anchor_changed';end if;
 execute replace(definition,old_text,old_text||$guard$ if tg_op='UPDATE' and clued_private.storage_directory_state_permitted_v3(old,new) then return new;end if;
$guard$);
end $upgrade$;
revoke all on function clued_private.storage_directory_state_plan_v3(text,uuid,uuid),
 clued_private.storage_directory_state_observation_v3(jsonb,jsonb),clued_private.storage_directory_state_reconcile_v3(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function clued_private.storage_current_registration_reconcile_v1(p_issuer_identity text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform clued_private.storage_recovery_client_input_guard_v1(p_input);
 if exists(select 1 from clued_private.storage_jobs_v1 j where j.connection_id=(p_input->>'connection_id')::uuid
  and j.job_id=(p_input->>'job_id')::uuid and j.mutation->>'operation'='create') then
  return clued_private.storage_legacy_create_registration_v1(p_issuer_identity,p_input);end if;
 return clued_private.storage_directory_state_reconcile_v3(p_issuer_identity,p_input);
end $$;
revoke all on function clued_private.storage_current_registration_reconcile_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create or replace function clued_private.storage_job_status_v1(p_job clued_private.storage_jobs_v1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb:=clued_private.storage_job_status_before_current_registration_v1(p_job);
 current_result jsonb:=clued_private.storage_current_registration_status_v1(p_job);
begin
 if current_result is not null then result:=result||jsonb_build_object('reason_code','PROVIDER_RESULT_RECONCILED',
  'resolution','automatically_registered_current_state','resolution_receipt_id',current_result->'receipt_id',
  'source_receipt_id',current_result->'source_receipt_id','automatic_recovery','resolved')||
  case when current_result ? 'current_artifact_state' then jsonb_build_object('current_artifact_state',current_result->'current_artifact_state') else '{}'::jsonb end;end if;
 return result;
end $$;
