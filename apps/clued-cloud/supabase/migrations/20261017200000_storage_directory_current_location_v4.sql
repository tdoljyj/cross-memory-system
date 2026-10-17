-- A GET-only current-location registration of one original ordinary directory.
-- New private actor, exact Artifact/old attempt and current parent are checked
-- independently; no old writer, provider effect or historical success is issued.

-- Alias qualification changes must participate in the same physical ID domain
-- as Artifact mutations. All lifecycle updates participate, even unchanged IDs.
create function clued_private.storage_location_profile_guard_v4() returns trigger
language plpgsql security definer set search_path='' as $guard$
declare ids text[]:='{}';identity text;
begin
 if tg_op<>'INSERT' then ids:=ids||array[old.root_folder_id,old.root_parent_id];end if;
 if tg_op<>'DELETE' then ids:=ids||array[new.root_folder_id,new.root_parent_id];end if;
 for identity in select value from (select distinct value from unnest(array_remove(ids,null)) value) keys
  order by value collate "C" loop
  if not pg_try_advisory_xact_lock(hashtextextended('storage-object:'||identity,0)) then
   raise exception 'storage_current_location_busy' using errcode='40001';end if;
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end $guard$;
revoke all on function clued_private.storage_location_profile_guard_v4()
 from public,anon,authenticated,service_role,clued_worker_gateway;
create trigger storage_location_profile_guard_v4 before insert or update or delete
 on clued_private.resource_center_profiles_v1 for each row
 execute function clued_private.storage_location_profile_guard_v4();

create table clued_private.storage_directory_location_permits_v4(
 transaction_id bigint not null,artifact_id uuid not null,
 receipt_id uuid not null references public.clued_audit_receipts(id),intent_id uuid not null,
 owner_id uuid not null,profile_id uuid not null,before_hash text not null,after_hash text not null,
 old_parent_id text not null,new_parent_id text not null,
 primary key(transaction_id,artifact_id));
alter table clued_private.storage_directory_location_permits_v4 enable row level security;
revoke all on clued_private.storage_directory_location_permits_v4
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- A target-only transition. Parent metadata continues to use the original
-- metadata permit; neither existing permit acquires path-changing authority.
create function clued_private.storage_directory_location_permitted_v4(
 p_before clued_private.resource_center_artifacts_v1,p_after clued_private.resource_center_artifacts_v1) returns boolean
language plpgsql security definer set search_path='' as $permit$
declare permit clued_private.storage_directory_location_permits_v4;p clued_private.resource_center_profiles_v1;
 q clued_private.storage_conflict_isolations_v1;qp clued_private.resource_center_profiles_v1;
 candidate text;relative_candidate text;other_path text;relative_other text;slot jsonb;protected_ids text[];
begin
 select x.* into permit from clued_private.storage_directory_location_permits_v4 x
  join public.clued_audit_receipts r on r.id=x.receipt_id and r.user_id=x.owner_id
  where x.transaction_id=txid_current() and x.artifact_id=p_before.id and x.owner_id=p_before.user_id
   and x.profile_id=p_before.profile_id and x.receipt_id=p_after.receipt_id
   and x.before_hash=clued_private.m1_sha256(to_jsonb(p_before)) and x.after_hash=clued_private.m1_sha256(to_jsonb(p_after))
   and r.status='pending' and r.operation='storage_current_registration_reconcile';
 if permit.artifact_id is null then return false;end if;
 select * into p from clued_private.resource_center_profiles_v1 where id=p_before.profile_id and user_id=p_before.user_id;
 if p.id is null or p.state<>'active'
 or (to_jsonb(p_before)-array['path','state','provider_access_digest','provider_sharing_digest','provider_file_version','version','receipt_id',
  'access_digest_missing_at','access_digest_attempted_at','updated_at']) is distinct from
 (to_jsonb(p_after)-array['path','state','provider_access_digest','provider_sharing_digest','provider_file_version','version','receipt_id',
  'access_digest_missing_at','access_digest_attempted_at','updated_at'])
 or p_before.target_kind<>'directory' or p_before.governance_class<>'ordinary'
 or p_before.state not in ('active','trashed') or p_after.state<>'active' or p_before.path=p_after.path
 or not starts_with(p_before.path,p.managed_root||'/') or not starts_with(p_after.path,p.managed_root||'/')
 or regexp_replace(p_before.path,'/[^/]+$','')=p.managed_root or regexp_replace(p_after.path,'/[^/]+$','')=p.managed_root
 or p_before.provider_file_id in (p.root_folder_id,p.root_parent_id)
 or p_after.version<>p_before.version+1 or p_after.access_digest_missing_at is not null
 or p_after.provider_access_digest is null or p_after.provider_sharing_digest is null
 or p_before.provider_access_digest is not null and p_before.provider_access_digest is distinct from p_after.provider_access_digest
 or p_before.provider_sharing_digest is not null and p_before.provider_sharing_digest is distinct from p_after.provider_sharing_digest
 or exists(select 1 from clued_private.resource_center_artifacts_v1 child where child.profile_id=p.id
  and child.state in ('active','trashed') and child.id<>p_before.id
  and (starts_with(child.path,p_before.path||'/') or child.path=p_after.path or starts_with(child.path,p_after.path||'/')))
 or exists(select 1 from clued_private.resource_center_artifacts_v1 alias where alias.provider_file_id=p_before.provider_file_id
  and alias.id<>p_before.id and alias.state in ('active','trashed'))
 or exists(select 1 from clued_private.resource_center_profiles_v1 alias where alias.state='active'
  and p_before.provider_file_id in (alias.root_folder_id,alias.root_parent_id)) then
  raise exception 'storage_current_location_permit_invalid' using errcode='42501';end if;
 protected_ids:=array[p_before.provider_file_id,permit.old_parent_id,permit.new_parent_id,p.root_folder_id,p.root_parent_id]||
  array(select ancestor.provider_file_id from clued_private.resource_center_ancestor_rows_v1(
   p.id,p.user_id,array[regexp_replace(p_after.path,'/[^/]+$','')]) ancestor);
 for q in select * from clued_private.storage_conflict_isolations_v1 where state='active'
  and (root_folder_id=p.root_folder_id or object_ids&&protected_ids
   or p_before.provider_file_id=any(ancestor_ids)
   or exists(select 1 from jsonb_array_elements(slots) s where s->>'parent_id'=any(protected_ids))) loop
  if q.intent_id=permit.intent_id and clued_private.storage_conflict_exit_allowed_v1(q.intent_id,permit.receipt_id) then continue;end if;
  if not q.scope_complete or q.object_ids&&protected_ids or p_before.provider_file_id=any(q.ancestor_ids) then
   raise exception 'storage_object_under_review' using errcode='42501';end if;
  for slot in select value from jsonb_array_elements(q.slots) loop
   if slot->>'parent_id'=p_before.provider_file_id
   or slot->>'parent_id'=permit.old_parent_id and slot->>'name'=regexp_replace(p_before.path,'^.*/','')
   or slot->>'parent_id'=permit.new_parent_id and slot->>'name'=regexp_replace(p_after.path,'^.*/','') then
    raise exception 'storage_object_under_review' using errcode='42501';end if;
  end loop;
  if q.root_folder_id=p.root_folder_id then
   select * into qp from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=q.user_id;
   if qp.id is null then raise exception 'storage_object_under_review' using errcode='42501';end if;
   foreach candidate in array array[p_before.path,p_after.path] loop
    relative_candidate:=substr(candidate,length(p.managed_root)+1);
    foreach other_path in array q.paths||q.subtree_paths loop
     if not starts_with(other_path,qp.managed_root||'/') and other_path<>qp.managed_root then
      raise exception 'storage_object_under_review' using errcode='42501';end if;
     relative_other:=substr(other_path,length(qp.managed_root)+1);
     if relative_other='' or relative_candidate=relative_other or starts_with(relative_candidate,relative_other||'/')
     or starts_with(relative_other,relative_candidate||'/') then
      raise exception 'storage_object_under_review' using errcode='42501';end if;
    end loop;
   end loop;
  end if;
 end loop;
 return true;
end $permit$;
revoke all on function clued_private.storage_directory_location_permitted_v4(
 clued_private.resource_center_artifacts_v1,clued_private.resource_center_artifacts_v1)
 from public,anon,authenticated,service_role,clued_worker_gateway;

do $guard_pin$
declare definition text;anchor text:=E'\nbegin\n';
begin
 if (select md5(prosrc) from pg_proc where oid='clued_private.storage_conflict_artifact_guard_v1()'::regprocedure)
  is distinct from '189db0e906b68fd892dc052e221be288' then
  raise exception 'storage_current_location_guard_source_changed';end if;
 definition:=pg_get_functiondef('clued_private.storage_conflict_artifact_guard_v1()'::regprocedure);
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
  raise exception 'storage_current_location_guard_anchor_changed';end if;
 execute replace(definition,anchor,anchor||$insert$ if tg_op='UPDATE' and clued_private.storage_directory_location_permitted_v4(old,new) then return new;end if;
$insert$);
end $guard_pin$;

-- Already dispatched effects cannot be stopped by acquiring today's root
-- lock. Check the complete current geometry, independently of which rows
-- need metadata updates. Unrelated siblings share ancestry but no target/slot.
create function clued_private.storage_directory_location_inflight_v4(p_intent uuid,p_profile uuid,p_plan jsonb)
returns void language plpgsql security definer set search_path='' as $inflight$
declare other clued_private.resource_center_mutations_v1;p clued_private.resource_center_profiles_v1;
 op clued_private.resource_center_profiles_v1;pi jsonb;mutation jsonb;ancestor_ids text[];
 target_id text:=p_plan->'target'->>'provider_file_id';old_parent text:=p_plan->'target'->>'registered_parent_id';
 new_parent text:=p_plan->'target'->>'parent_id';old_path text:=p_plan->'target'->>'registered_path';
 new_path text:=p_plan->'target'->>'path';candidate text;other_path text;relative_candidate text;relative_other text;
begin
 select * into p from clued_private.resource_center_profiles_v1 where id=p_profile;
 ancestor_ids:=array(select x->>'provider_file_id' from jsonb_array_elements(p_plan->'parents') x);
 for other in select m.* from clued_private.resource_center_mutations_v1 m where m.id<>p_intent
  and (m.state in ('prepared','started','uncertain') or m.state='conflict' and m.verified_result_v2 is not null
   and exists(select 1 from clued_private.storage_conflict_isolations_v1 q where q.intent_id=m.id and q.state='active')) loop
  pi:=other.authority_request->'provider_identity';mutation:=coalesce(other.exact_request->'mutation',other.authority_request->'mutation');
  select * into op from clued_private.resource_center_profiles_v1 where id=other.profile_id and user_id=other.user_id;
  if (other.profile_id=p.id or op.root_folder_id=p.root_folder_id)
   and (jsonb_typeof(pi) is distinct from 'object' or jsonb_typeof(mutation) is distinct from 'object')
  or other.exact_request->'binding'->>'artifact_id'=p_plan->'target'->>'artifact_id'
  or pi->>'source_file_id'=target_id or pi->>'destination_file_id'=target_id
  or pi->>'source_parent_id'=target_id or pi->>'destination_parent_id'=target_id or pi->>'root_folder_id'=target_id
  or exists(select 1 from jsonb_array_elements(coalesce(pi->'ancestors','[]')) link where link->>'id'=target_id)
  -- Moving/renaming/trashing an actual current ancestor invalidates the plan,
  -- even when that ancestor already has a qualified nonnull ACL baseline.
  or mutation->>'target_kind'='directory' and mutation->>'operation' in ('move','rename','delete','restore')
   and (pi->>'source_file_id'=any(ancestor_ids) or pi->>'destination_file_id'=any(ancestor_ids))
  -- Global physical name slots, including another profile's generated ID.
  or (pi->>'source_parent_id'=old_parent and regexp_replace(mutation->>'source_path','^.*/','')=regexp_replace(old_path,'^.*/',''))
  or (pi->>'source_parent_id'=new_parent and regexp_replace(mutation->>'source_path','^.*/','')=regexp_replace(new_path,'^.*/',''))
  or (coalesce(pi->>'destination_parent_id',pi->>'parent_id')=old_parent
   and regexp_replace(mutation->>'destination_path','^.*/','')=regexp_replace(old_path,'^.*/',''))
  or (coalesce(pi->>'destination_parent_id',pi->>'parent_id')=new_parent
   and regexp_replace(mutation->>'destination_path','^.*/','')=regexp_replace(new_path,'^.*/','')) then
   raise exception 'storage_current_location_busy' using errcode='40001';end if;
  if op.root_folder_id=p.root_folder_id then
   foreach candidate in array array[old_path,new_path] loop
    relative_candidate:=substr(candidate,length(p.managed_root)+1);
    foreach other_path in array array_remove(array[mutation->>'source_path',mutation->>'destination_path'],null) loop
     if not starts_with(other_path,op.managed_root||'/') and other_path<>op.managed_root then
      raise exception 'storage_current_location_busy' using errcode='40001';end if;
     relative_other:=substr(other_path,length(op.managed_root)+1);
     if relative_candidate=relative_other or mutation->>'target_kind'='directory' and
      (relative_other='' or starts_with(relative_candidate,relative_other||'/') or starts_with(relative_other,relative_candidate||'/')) then
      raise exception 'storage_current_location_busy' using errcode='40001';end if;
    end loop;
   end loop;
  end if;
 end loop;
end $inflight$;
revoke all on function clued_private.storage_directory_location_inflight_v4(uuid,uuid,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_directory_location_seed_v4(
 p_issuer_identity text,p_connection uuid,p_job uuid) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='50ms' as $seed$
declare reader jsonb;descriptor jsonb;j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;
 q clued_private.storage_conflict_isolations_v1;p clued_private.resource_center_profiles_v1;
 a clued_private.resource_center_artifacts_v1;attempt_receipt public.clued_audit_receipts;
begin
 reader:=clued_private.storage_registration_program_authority_v1(p_issuer_identity,p_connection,p_job);
 select * into j from clued_private.storage_jobs_v1 where connection_id=p_connection and job_id=p_job for share nowait;
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id for share nowait;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for share nowait;
 select * into p from clued_private.resource_center_profiles_v1 where id=m.profile_id and user_id=j.owner_id for share nowait;
 select * into attempt_receipt from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=j.owner_id;
 if q.intent_id is null or q.state is distinct from 'active' or not q.scope_complete or cardinality(q.object_ids)<>1
 or m.state is distinct from 'conflict' or m.version is distinct from q.closed_version or m.receipt_id is distinct from q.close_receipt_id
 or m.verified_result_v2 is not null or j.cloud_writer_binding_id is null or m.writer_binding_id is distinct from j.cloud_writer_binding_id
 or ((m.exact_request->'mutation')-'artifact_role') is distinct from (j.mutation-'artifact_role')
 or m.exact_request->'mutation'->>'artifact_role' is distinct from 'clued_resource'
 or j.mutation->>'target_kind' is distinct from 'directory' or coalesce(j.mutation->>'operation','') not in ('delete','restore')
 or j.mutation ? 'destination_path' or m.provider_attempt is null
 or m.provider_attempt->>'provider_file_id' is distinct from q.object_ids[1]
 or m.provider_attempt is distinct from clued_private.storage_destructive_attempt_v1(m,j,'null'::jsonb)
 or attempt_receipt.status is distinct from 'committed' or attempt_receipt.operation is distinct from 'storage_provider_attempt'
 or attempt_receipt.response_hash is distinct from clued_private.m1_sha256(attempt_receipt.canonical_result)
 or greatest(m.expires_at,attempt_receipt.created_at)+interval '130 minutes 10 seconds'>clock_timestamp() then
  raise exception 'storage_current_location_unavailable' using errcode='42501';end if;
 descriptor:=clued_private.storage_conflict_load_v1(p_issuer_identity,
  jsonb_build_object('action','load','connection_id',p_connection,'job_id',p_job));
 if descriptor->>'intent_id' is distinct from m.id::text or descriptor->>'request_sha256' is distinct from m.request_sha256
 or descriptor->>'version' is distinct from m.version::text or descriptor->'attempt' is distinct from m.provider_attempt then
  raise exception 'storage_current_location_unavailable' using errcode='42501';end if;
 -- Bind the original Artifact, not a later registration at its name or ID.
 select * into a from clued_private.resource_center_artifacts_v1
  where id=(m.exact_request->'binding'->>'artifact_id')::uuid and user_id=j.owner_id and profile_id=p.id for share nowait;
 if a.id is null or a.state not in ('active','trashed') or a.target_kind<>'directory' or a.governance_class<>'ordinary'
 or a.path is distinct from j.mutation->>'source_path' or a.path is distinct from m.provider_attempt->>'source_path'
 or a.provider_file_id is distinct from q.object_ids[1] or a.provider_file_id is distinct from j.mutation->>'source_file_id'
 or not starts_with(a.path,p.managed_root||'/') or regexp_replace(a.path,'/[^/]+$','')=p.managed_root
 or a.provider_file_id in (p.root_folder_id,p.root_parent_id)
 or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,a.source_decision_id)
 or exists(select 1 from clued_private.resource_center_artifacts_v1 child
  where child.user_id=j.owner_id and child.profile_id=p.id and child.state in ('active','trashed') and starts_with(child.path,a.path||'/'))
 then raise exception 'storage_current_location_unavailable' using errcode='42501';end if;
 perform 1 from public.clued_memories decision where decision.id=a.source_decision_id and decision.user_id=j.owner_id for share nowait;
 -- Old ancestry is immutable attempt evidence only. It need not still be
 -- active: actual current ancestry is independently discovered and qualified.
 return reader||jsonb_build_object('status','registration_location_required','connection_id',j.connection_id,'job_id',j.job_id,
  'owner_id',j.owner_id,'intent_id',m.id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'registration_seed',jsonb_build_object('contract','clued.storage-directory-location-seed/1',
   'managed_root',p.managed_root,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,
   'intent_id',m.id,'request_sha256',m.request_sha256,
   'target',clued_private.storage_current_registration_node_v1(a,m.provider_attempt->>'parent_id')||
    jsonb_build_object('registered_state',a.state)),'execution_permitted',false);
end $seed$;
revoke all on function clued_private.storage_directory_location_seed_v4(text,uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_directory_location_plan_v4(
 p_issuer_identity text,p_connection uuid,p_job uuid,p_parent_id text,p_name text) returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='50ms' as $plan$
declare d jsonb;seed jsonb;p clued_private.resource_center_profiles_v1;a clued_private.resource_center_artifacts_v1;
 parent clued_private.resource_center_artifacts_v1;node clued_private.resource_center_artifacts_v1;
 parents jsonb:='[]';last_path text;last_id text;parent_id text;new_path text;track text;
begin
 d:=clued_private.storage_directory_location_seed_v4(p_issuer_identity,p_connection,p_job);seed:=d->'registration_seed';
 if p_parent_id is null or p_parent_id!~'^[A-Za-z0-9_-]{1,160}$' or p_name is null or char_length(p_name) not between 1 and 255
 or p_name in ('.','..') or p_name ~ '[/\\[:cntrl:]]' then
  raise exception 'storage_current_location_invalid' using errcode='22023';end if;
 select * into p from clued_private.resource_center_profiles_v1 where id=(d->'registration_authority'->>'profile_id')::uuid;
 select * into a from clued_private.resource_center_artifacts_v1 where id=(seed->'target'->>'artifact_id')::uuid for share nowait;
 select * into parent from clued_private.resource_center_artifacts_v1 where user_id=a.user_id and profile_id=p.id
  and provider_file_id=p_parent_id and state='active' and target_kind='directory' for share nowait;
 new_path:=parent.path||'/'||p_name;
 track:=split_part(substr(parent.path,length(p.managed_root)+2),'/',1);
 if parent.id is null or parent.provider_file_id=a.provider_file_id or parent.path=p.managed_root
 or new_path=a.path or length(new_path)>1000 or not starts_with(parent.path,p.managed_root||'/')
 or not (p.cloud_runtime->'allowed_root_children' @> jsonb_build_array(track))
 or not clued_private.resource_center_path_current_v1(a.user_id,p.project_id,p.id,p.managed_root,parent.path)
 or exists(select 1 from clued_private.resource_center_artifacts_v1 collision
  where collision.profile_id=p.id and collision.id<>a.id and collision.path=new_path and collision.state in ('active','trashed'))
 then raise exception 'storage_current_location_unavailable' using errcode='42501';end if;
 perform 1 from public.clued_memories decision where decision.user_id=a.user_id and decision.id in (
  select a.source_decision_id union select p.source_decision_id
  union select (d->'registration_authority'->>'source_decision_id')::uuid
  union select ancestor.source_decision_id from clued_private.resource_center_ancestor_rows_v1(p.id,a.user_id,array[parent.path]) ancestor
 ) order by decision.id for share nowait;
 for node in select * from clued_private.resource_center_ancestor_rows_v1(p.id,a.user_id,array[parent.path]) r
  order by r.path collate "C" for share nowait loop
  parent_id:=case when node.path=p.managed_root then p.root_parent_id else last_id end;
  if node.path=p.managed_root and (last_path is not null or node.provider_file_id is distinct from p.root_folder_id)
  or node.path<>p.managed_root and (last_path is null or regexp_replace(node.path,'/[^/]+$','') is distinct from last_path)
  or node.provider_file_id is null or parent_id is null
  or not clued_private.resource_center_decision_current_v1(a.user_id,p.project_id,node.source_decision_id)
  or not clued_private.resource_center_path_current_v1(a.user_id,p.project_id,p.id,p.managed_root,node.path) then
   raise exception 'storage_current_location_unavailable' using errcode='42501';end if;
  parents:=parents||jsonb_build_array(clued_private.storage_current_registration_node_v1(node,parent_id));
  last_path:=node.path;last_id:=node.provider_file_id;
 end loop;
 if jsonb_array_length(parents) not between 2 and 20 or last_path is distinct from parent.path or last_id is distinct from p_parent_id
 or parents->0->>'provider_file_id' is distinct from p.root_folder_id then
  raise exception 'storage_current_location_unavailable' using errcode='42501';end if;
 return (d-'registration_seed')||jsonb_build_object('status','registration_required',
  'registration_plan',(seed-'target')||jsonb_build_object('contract','clued.storage-directory-location-plan/1',
   'mode','refresh_directory_location','parents',parents,
   'target',(seed->'target')||jsonb_build_object('registered_path',a.path,
    'registered_parent_id',seed->'target'->>'parent_id','path',new_path,'parent_id',p_parent_id)));
end $plan$;
revoke all on function clued_private.storage_directory_location_plan_v4(text,uuid,uuid,text,text)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- The private entry inherits the normal public issuer-proof resolver.
-- Its local lock budget starts here, not before the outer resolver.
create function clued_private.storage_directory_location_reconcile_v4(p_issuer_identity text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='50ms' as $entry$
declare op text:=p_input->>'action';d jsonb;hint jsonb:=p_input->'location_hint';
 authority jsonb;plan jsonb;inner_plan jsonb;first jsonb:=p_input->'first_observation';second jsonb:=p_input->'second_observation';
 j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;q clued_private.storage_conflict_isolations_v1;
 p clued_private.resource_center_profiles_v1;saved clued_private.storage_current_registration_results_v1;
 a clued_private.resource_center_artifacts_v1;next_artifact clued_private.resource_center_artifacts_v1;
 node jsonb;observed jsonb;idx integer;identity text;qualified_at timestamptz;first_at timestamptz;second_at timestamptz;
 req jsonb;refs jsonb;ev text;result jsonb;r public.clued_audit_receipts;
 changed_ids uuid[]:='{}';before_rows jsonb:='[]';after_rows jsonb:='[]';base_versions jsonb;committed_versions jsonb;changed jsonb;
begin
 if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in
  ('registration_location_load','registration_location_plan','registration_location_commit')
 or p_input-array['action','connection_id','job_id',
  case when op<>'registration_location_load' then 'base_version' end,
  case when op<>'registration_location_load' then 'source_receipt_id' end,
  case when op<>'registration_location_load' then 'registration_authority' end,
  case when op='registration_location_plan' then 'registration_seed' end,
  case when op='registration_location_plan' then 'location_hint' end,
  case when op='registration_location_commit' then 'registration_plan' end,
  case when op='registration_location_commit' then 'first_observation' end,
  case when op='registration_location_commit' then 'second_observation' end]<>'{}' then
  raise exception 'storage_current_location_invalid' using errcode='22023';end if;
 perform clued_private.storage_recovery_client_input_guard_v1(p_input);
 -- Current program authentication precedes even a successful lost-reply read.
 -- Replay is checked BEFORE the seed's active-isolation requirement.
 authority:=clued_private.storage_registration_program_authority_v1(p_issuer_identity,
  (p_input->>'connection_id')::uuid,(p_input->>'job_id')::uuid);
 select * into j from clued_private.storage_jobs_v1 where connection_id=(p_input->>'connection_id')::uuid
  and job_id=(p_input->>'job_id')::uuid for update nowait;
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id for update nowait;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for update nowait;
 select * into p from clued_private.resource_center_profiles_v1 where id=m.profile_id and user_id=j.owner_id for share nowait;
 select * into saved from clued_private.storage_current_registration_results_v1 where intent_id=m.id and owner_id=j.owner_id;
 if saved.intent_id is not null then
  if saved.plan->>'mode' is distinct from 'refresh_directory_location'
  or clued_private.storage_current_registration_status_v1(j) is distinct from saved.result
  or op='registration_location_commit' and (p_input->>'base_version' is distinct from saved.base_version::text
   or p_input->>'source_receipt_id' is distinct from saved.source_receipt_id::text
   or p_input->'registration_authority' is distinct from saved.authority or p_input->'registration_plan' is distinct from saved.plan
   or jsonb_build_object('first_observation',first,'second_observation',second) is distinct from saved.observations) then
   raise exception 'storage_current_location_conflict' using errcode='40001';end if;
  return saved.result;
 end if;
 d:=clued_private.storage_directory_location_seed_v4(p_issuer_identity,
  (p_input->>'connection_id')::uuid,(p_input->>'job_id')::uuid);
 if op='registration_location_load' then return d;end if;
 if jsonb_typeof(p_input->'base_version') is distinct from 'number'
 or p_input->>'base_version' is distinct from d->>'base_version'
 or p_input->>'source_receipt_id' is distinct from d->>'source_receipt_id'
 or p_input->'registration_authority' is distinct from d->'registration_authority' then
  raise exception 'storage_current_location_conflict' using errcode='40001';end if;
 if op='registration_location_plan' then
  if p_input->'registration_seed' is distinct from d->'registration_seed'
  or jsonb_typeof(hint) is distinct from 'object'
  or not(hint ?& array['contract','provider_file_id','provider_file_version','parent_id','name'])
  or hint-array['contract','provider_file_id','provider_file_version','parent_id','name']<>'{}'
  or hint->>'contract' is distinct from 'clued.storage-directory-location-hint/1'
  or hint->>'provider_file_id' is distinct from d->'registration_seed'->'target'->>'provider_file_id'
  or jsonb_typeof(hint->'provider_file_version') is distinct from 'string'
  or coalesce(hint->>'provider_file_version','')!~'^[1-9][0-9]{0,39}$'
  or jsonb_typeof(hint->'parent_id') is distinct from 'string' or jsonb_typeof(hint->'name') is distinct from 'string' then
   raise exception 'storage_current_location_invalid' using errcode='22023';end if;
  return clued_private.storage_directory_location_plan_v4(p_issuer_identity,
   (p_input->>'connection_id')::uuid,(p_input->>'job_id')::uuid,hint->>'parent_id',hint->>'name');
 end if;
 -- Native reconstructs the new path from a current registered parent plus a
 -- single safe name. A preliminary hint never becomes a mutation permit.
 plan:=(clued_private.storage_directory_location_plan_v4(p_issuer_identity,j.connection_id,j.job_id,
  p_input->'registration_plan'->'target'->>'parent_id',
  regexp_replace(p_input->'registration_plan'->'target'->>'path','^.*/','')))->'registration_plan';
 if p_input->'registration_plan' is distinct from plan then
  raise exception 'storage_current_location_conflict' using errcode='40001';end if;
 inner_plan:=(plan-'target')||jsonb_build_object('contract','clued.storage-registration-plan/1','mode','refresh_directory_state',
  'target',(plan->'target')-array['registered_path','registered_parent_id']);
 perform clued_private.storage_directory_state_observation_v3(inner_plan,first);
 perform clued_private.storage_directory_state_observation_v3(inner_plan,second);
 first_at:=(first->>'observed_at')::timestamptz;second_at:=(second->>'observed_at')::timestamptz;
 if first->'target'->>'current_state' is distinct from 'active' or second->'target'->>'current_state' is distinct from 'active'
 or first_at is null or second_at is null or first_at>second_at or first_at<clock_timestamp()-interval '30 seconds'
 or second_at>clock_timestamp()+interval '5 seconds'
 or first-array['observed_at','parents'] is distinct from second-array['observed_at','parents']
 or (select jsonb_agg(x-'provider_file_version' order by n) from jsonb_array_elements(first->'parents') with ordinality v(x,n))
  is distinct from (select jsonb_agg(x-'provider_file_version' order by n) from jsonb_array_elements(second->'parents') with ordinality v(x,n)) then
  raise exception 'storage_current_location_proof_changed' using errcode='40001';end if;
 -- Root/parent/target physical IDs are global across profiles and accounts.
 -- Profile creation/reactivation uses this same domain in its BEFORE guard.
 for identity in select value from (
  select distinct value from unnest(array[p.root_folder_id,p.root_parent_id,plan->'target'->>'registered_parent_id']||
   array(select x->>'provider_file_id' from jsonb_array_elements((plan->'parents')||jsonb_build_array(plan->'target')) x)) value
 ) keys order by value collate "C" loop
  if identity is null or not pg_try_advisory_xact_lock(hashtextextended('storage-object:'||identity,0)) then
   raise exception 'storage_current_location_busy' using errcode='40001';end if;
 end loop;
 perform 1 from clued_private.resource_center_artifacts_v1 artifact where artifact.user_id=j.owner_id and artifact.profile_id=p.id
  and artifact.id in (select (x->>'artifact_id')::uuid from jsonb_array_elements((plan->'parents')||jsonb_build_array(plan->'target')) x)
  order by artifact.id for update nowait;
 -- Rebuild after locks. This also repeats current Decisions, source identity,
 -- permitted track, collision/descendant checks and the actual parent chain.
 if plan is distinct from (clued_private.storage_directory_location_plan_v4(p_issuer_identity,j.connection_id,j.job_id,
  plan->'target'->>'parent_id',regexp_replace(plan->'target'->>'path','^.*/','')))->'registration_plan' then
  raise exception 'storage_current_location_conflict' using errcode='40001';end if;
 perform clued_private.storage_directory_location_inflight_v4(m.id,p.id,plan);
 for idx in 0..jsonb_array_length(plan->'parents') loop
  if idx=jsonb_array_length(plan->'parents') then node:=plan->'target';observed:=second->'target';
  else node:=plan->'parents'->idx;observed:=second->'parents'->idx;end if;
  select * into a from clued_private.resource_center_artifacts_v1 where id=(node->>'artifact_id')::uuid and user_id=j.owner_id and profile_id=p.id;
  if a.id is null or a.version::text is distinct from node->>'artifact_version'
  or a.state is distinct from coalesce(node->>'registered_state','active')
  or a.path is distinct from coalesce(node->>'registered_path',node->>'path')
  or a.provider_file_id is distinct from node->>'provider_file_id'
  or a.provider_access_digest is distinct from node->>'access_digest' or a.provider_sharing_digest is distinct from node->>'sharing_digest'
  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,a.source_decision_id) then
   raise exception 'storage_current_location_conflict' using errcode='40001';end if;
  if idx=jsonb_array_length(plan->'parents') and (
   exists(select 1 from clued_private.resource_center_profiles_v1 alias where alias.state='active'
    and a.provider_file_id in (alias.root_folder_id,alias.root_parent_id))
   or exists(select 1 from clued_private.resource_center_artifacts_v1 alias where alias.provider_file_id=a.provider_file_id
    and alias.id<>a.id and alias.state in ('active','trashed'))) then
   raise exception 'storage_current_location_alias' using errcode='42501';end if;
  if idx=jsonb_array_length(plan->'parents') or a.provider_access_digest is null then
   if exists(select 1 from clued_private.resource_center_mutations_v1 other where other.id<>m.id
    and (other.state in ('prepared','started','uncertain') or other.state='conflict' and other.verified_result_v2 is not null
     and exists(select 1 from clued_private.storage_conflict_isolations_v1 oq where oq.intent_id=other.id and oq.state='active'))
    and (other.exact_request->'binding'->>'artifact_id'=a.id::text
     or other.authority_request->'provider_identity'->>'source_file_id'=a.provider_file_id
     or other.authority_request->'provider_identity'->>'destination_file_id'=a.provider_file_id
     or exists(select 1 from jsonb_array_elements(coalesce(other.authority_request->'provider_identity'->'ancestors','[]')) link
      where link->>'id'=a.provider_file_id)
     or other.authority_request->'provider_identity'->>'root_folder_id'=a.provider_file_id
     or other.authority_request->'provider_identity'->>'source_parent_id'=a.provider_file_id
     or other.authority_request->'provider_identity'->>'destination_parent_id'=a.provider_file_id
     or other.profile_id=p.id and jsonb_typeof(other.authority_request->'provider_identity') is distinct from 'object'
     or idx=jsonb_array_length(plan->'parents') and other.profile_id=p.id and
      (other.exact_request->'mutation'->>'source_path' in (a.path,node->>'path')
       or other.exact_request->'mutation'->>'destination_path' in (a.path,node->>'path')))) then
    raise exception 'storage_current_location_busy' using errcode='40001';end if;
   changed_ids:=array_append(changed_ids,a.id);before_rows:=before_rows||jsonb_build_array(to_jsonb(a));
  end if;
 end loop;
 authority:=clued_private.storage_registration_program_authority_v1(p_issuer_identity,j.connection_id,j.job_id);
 if authority->'registration_authority' is distinct from d->'registration_authority' or clock_timestamp()-first_at>interval '30 seconds' then
  raise exception 'storage_current_location_authority_changed' using errcode='40001';end if;
 req:=jsonb_build_object('idempotency_key','storage-current-location:'||m.id::text||':'||m.version::text,
  'intent_id',m.id,'connection_id',j.connection_id,'job_id',j.job_id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'original_attempt_receipt_id',m.provider_attempt_receipt_id,'original_attempt_digest',clued_private.m1_sha256(m.provider_attempt),
  'registration_authority',d->'registration_authority','registration_plan',plan,
  'first_observation',first,'second_observation',second,'before_rows',before_rows,'reason_code','CURRENT_LOCATION_QUALIFIED');
 r:=clued_private.m1_begin_receipt(j.owner_id,null,'storage_current_registration_reconcile',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_current_location_conflict' using errcode='40001';end if;
 -- Receipt-head contention is also a possible wait. Its earlier validation
 -- cannot outlive the fresh observation or current program authorization.
 authority:=clued_private.storage_registration_program_authority_v1(p_issuer_identity,j.connection_id,j.job_id);
 if authority->'registration_authority' is distinct from d->'registration_authority' or clock_timestamp()-first_at>interval '30 seconds' then
  raise exception 'storage_current_location_authority_changed' using errcode='40001';end if;
 insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
 qualified_at:=clock_timestamp();
 for idx in 0..jsonb_array_length(plan->'parents') loop
  if idx=jsonb_array_length(plan->'parents') then node:=plan->'target';observed:=second->'target';
  else node:=plan->'parents'->idx;observed:=second->'parents'->idx;end if;
  if (node->>'artifact_id')::uuid=any(changed_ids) then
   select * into a from clued_private.resource_center_artifacts_v1 where id=(node->>'artifact_id')::uuid;
   next_artifact:=jsonb_populate_record(a,jsonb_build_object('provider_access_digest',observed->>'access_digest',
    'provider_sharing_digest',observed->>'sharing_digest','provider_file_version',observed->>'provider_file_version',
    'access_digest_missing_at',null,'access_digest_attempted_at',qualified_at,'receipt_id',r.id,'version',a.version+1,'updated_at',qualified_at)||
    case when idx=jsonb_array_length(plan->'parents') then jsonb_build_object('path',node->>'path','state','active') else '{}'::jsonb end);
   if idx=jsonb_array_length(plan->'parents') then
    insert into clued_private.storage_directory_location_permits_v4 values(txid_current(),a.id,r.id,m.id,j.owner_id,p.id,
     clued_private.m1_sha256(to_jsonb(a)),clued_private.m1_sha256(to_jsonb(next_artifact)),
     node->>'registered_parent_id',node->>'parent_id');
   else
    insert into clued_private.storage_registration_artifact_permits_v1 values(txid_current(),a.id,r.id,m.id,j.owner_id,p.id,
     clued_private.m1_sha256(to_jsonb(a)),clued_private.m1_sha256(to_jsonb(next_artifact)));
   end if;
   update clued_private.resource_center_artifacts_v1 set path=next_artifact.path,state=next_artifact.state,
    provider_access_digest=next_artifact.provider_access_digest,provider_sharing_digest=next_artifact.provider_sharing_digest,
    provider_file_version=next_artifact.provider_file_version,access_digest_missing_at=null,access_digest_attempted_at=qualified_at,
    receipt_id=r.id,version=next_artifact.version,updated_at=qualified_at
    where id=a.id and version=a.version returning * into a;
   if a.id is null then raise exception 'storage_current_location_conflict' using errcode='40001';end if;
   after_rows:=after_rows||jsonb_build_array(to_jsonb(a));
  end if;
 end loop;
 update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 update clued_private.resource_center_mutations_v1 set version=version+1,updated_at=clock_timestamp(),
  final_result=final_result||jsonb_build_object('automatic_resolution','automatically_registered_current_state',
   'automatic_receipt_id',r.id,'automatic_base_version',m.version) where id=m.id and version=m.version;
 if not found then raise exception 'storage_current_location_conflict' using errcode='40001';end if;
 result:=jsonb_build_object('status','resolved','resolution','automatically_registered_current_state','automatic_recovery','resolved',
  'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',r.id,'source_receipt_id',q.close_receipt_id,
  'base_version',m.version,'current_artifact_state','active','current_path',plan->'target'->>'path','execution_permitted',false);
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 base_versions:=jsonb_build_object(m.id::text,m.version);committed_versions:=jsonb_build_object(m.id::text,m.version+1);
 for changed in select value from jsonb_array_elements(before_rows) loop
  refs:=refs||jsonb_build_array(jsonb_build_object('kind','system','role','target','id',changed->>'id'));
  base_versions:=base_versions||jsonb_build_object(changed->>'id',changed->'version');
  committed_versions:=committed_versions||jsonb_build_object(changed->>'id',(changed->>'version')::bigint+1);
 end loop;
 ev:=clued_private.m1_append_event_row(j.owner_id,null,r.id,r.canonical_version,'extension:storage:current_location_reconciled',
  refs,'project:'||p.project_id::text,null,req||jsonb_build_object('after_rows',after_rows),req->>'idempotency_key',r.request_sha256,
  'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 perform clued_private.m1_finish_receipt(r.id,'committed',refs,base_versions,committed_versions,array[ev],'{}'::uuid[],null);
 insert into clued_private.storage_current_registration_results_v1(intent_id,owner_id,original_connection_id,job_id,base_version,
  source_receipt_id,authority,plan,observations,receipt_id,result)
 values(m.id,j.owner_id,j.connection_id,j.job_id,m.version,q.close_receipt_id,d->'registration_authority',plan,
  jsonb_build_object('first_observation',first,'second_observation',second),r.id,result);
 return result;
exception when lock_not_available or serialization_failure or deadlock_detected then
 -- This exception block rolls back the whole qualification subtransaction.
 -- Authorization errors (42501) and malformed input are deliberately not caught.
 return jsonb_build_object('contract','clued.storage-current-location-busy/1',
  'connection_id',p_input->>'connection_id','job_id',p_input->>'job_id',
  'status','pending','automatic_recovery','pending','reason_code','REGISTRATION_LOCATION_BUSY','execution_permitted',false);
end $entry$;
revoke all on function clued_private.storage_directory_location_reconcile_v4(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

do $router_pin$begin
 if (select md5(prosrc) from pg_proc
  where oid='clued_private.ii_pub_clued_storage_scheduled_recovery_v2(text,jsonb)'::regprocedure)
  is distinct from '20bc5fa844e75db3dd7f0bcf9ac998b6' then
  raise exception 'storage_current_location_router_source_changed';end if;
end $router_pin$;
create or replace function clued_private.ii_pub_clued_storage_scheduled_recovery_v2(p_issuer_identity text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $router$
begin
 if p_input->>'action' in ('registration_location_load','registration_location_plan','registration_location_commit') then
  return clued_private.storage_directory_location_reconcile_v4(p_issuer_identity,p_input);end if;
 if p_input->>'action' in ('registration_current_load','registration_current_commit') then
  return clued_private.storage_current_registration_reconcile_v1(p_issuer_identity,p_input);end if;
 return clued_private.storage_scheduled_before_current_registration_v1(p_issuer_identity,p_input);
end $router$;
