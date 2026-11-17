-- Reviewed deployment repair only. This does not follow supersession during
-- authorization, revive a Decision, change a grant, or alter the frozen layout.
-- The temporary operation is removed in this same migration.
create function clued_private.storage_runtime_authority_repair_v1(
 p_owner uuid,p_profile uuid,p_expected_runtime_sha256 text,
 p_successor uuid,p_successor_version bigint,p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p clued_private.resource_center_profiles_v1;old_decision public.clued_memories;
 successor public.clued_memories;previous jsonb;runtime jsonb;request jsonb;
 receipt public.clued_audit_receipts;refs jsonb;ev text;
begin
 if p_owner is null or p_profile is null or p_successor is null
 or coalesce(p_expected_runtime_sha256,'') !~ '^[0-9a-f]{64}$'
 or p_successor_version is null or p_successor_version<1
 or coalesce(length(p_idempotency_key),0) not between 1 and 160 then
  raise exception 'storage_runtime_authority_invalid' using errcode='22023';end if;
 select * into p from clued_private.resource_center_profiles_v1 where id=p_profile and user_id=p_owner;
 if not found then raise exception 'storage_runtime_authority_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text||':'||p.root_folder_id,0));
 perform clued_private.storage_root_quiet_v1(p_owner,p.root_folder_id);
 select * into p from clued_private.resource_center_profiles_v1 where id=p_profile and user_id=p_owner for update;
 previous:=p.cloud_runtime;
 if clued_private.m1_sha256(previous) is distinct from p_expected_runtime_sha256 then
  raise exception 'storage_runtime_authority_conflict' using errcode='40001';end if;
 if p.state<>'active' or jsonb_typeof(previous) is distinct from 'object'
 or previous->>'contract' is distinct from 'clued.storage-cloud-runtime/1'
 or previous->>'profile_version' is distinct from p.version::text
 or (previous-array['contract','profile_version','allowed_root_children','source_decision_id','decision_version','receipt_id'])<>'{}'::jsonb
 or jsonb_typeof(previous->'allowed_root_children') is distinct from 'array'
 or jsonb_array_length(previous->'allowed_root_children') not between 1 and 32 then
  raise exception 'storage_runtime_authority_denied' using errcode='42501';end if;
 perform 1 from public.clued_memories where id in
  (p.source_decision_id,(previous->>'source_decision_id')::uuid,p_successor) order by id for share;
 select * into old_decision from public.clued_memories where id=(previous->>'source_decision_id')::uuid and user_id=p_owner;
 select * into successor from public.clued_memories where id=p_successor and user_id=p_owner;
 if old_decision.id is null or old_decision.record_type is distinct from 'decision'
 or old_decision.authority is distinct from 'user_explicit' or old_decision.lifecycle_status is distinct from 'superseded'
 or old_decision.canonical_scope is distinct from 'project:'||p.project_id::text
 or successor.version is distinct from p_successor_version
 or successor.relations->'supersedes' @> to_jsonb(array[old_decision.id::text]) is not true
 or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,p_successor)
 or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,p.source_decision_id) then
  raise exception 'storage_runtime_authority_denied' using errcode='42501';end if;
 if exists(select 1 from jsonb_array_elements(previous->'allowed_root_children') x
  where jsonb_typeof(x) is distinct from 'string' or not exists(
   select 1 from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=p_owner
    and a.path=p.managed_root||'/'||(x#>>'{}') and a.state='active' and a.target_kind='directory'))
 or not exists(select 1 from public.clued_audit_receipts r
  join public.clued_context_events e on e.receipt_id=r.id and e.user_id=r.user_id
  where r.id=(previous->>'receipt_id')::uuid and r.user_id=p_owner
   and r.status='committed' and r.operation='storage_cloud_qualify'
   and r.response_hash=clued_private.m1_sha256(r.canonical_result)
   and e.canonical_event_type='extension:storage:cloud_qualified' and e.result='success'
   and e.change_summary->>'profile_id'=p.id::text
   and e.change_summary->>'runtime_digest'=clued_private.m1_sha256(previous-'receipt_id')) then
  raise exception 'storage_runtime_authority_denied' using errcode='42501';end if;
 runtime:=(previous-'receipt_id')||jsonb_build_object('source_decision_id',p_successor,'decision_version',p_successor_version);
 request:=jsonb_build_object('action','repair_runtime_authority','profile_id',p.id,'base_version',p.version,
  'previous_runtime_sha256',p_expected_runtime_sha256,'previous_receipt_id',previous->>'receipt_id',
  'source_decision_id',p_successor,'decision_version',p_successor_version,'idempotency_key',p_idempotency_key);
 receipt:=clued_private.m1_begin_receipt(p_owner,null,'storage_cloud_qualify',request,clued_private.m1_sha256(request));
 if receipt.status<>'pending' then return receipt.canonical_result;end if;
 update clued_private.resource_center_profiles_v1 set cloud_runtime=runtime||jsonb_build_object('receipt_id',receipt.id) where id=p.id;
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',p.id));
 ev:=clued_private.m1_append_event_row(p_owner,null,receipt.id,receipt.canonical_version,'extension:storage:cloud_qualified',refs,
  'project:'||p.project_id::text,null,jsonb_build_object('profile_id',p.id,'runtime_digest',clued_private.m1_sha256(runtime),
   'previous_runtime_sha256',p_expected_runtime_sha256,'previous_receipt_id',previous->>'receipt_id',
   'previous_source_decision_id',old_decision.id,'source_decision_id',p_successor),
  p_idempotency_key,receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
 if (select cloud_runtime-array['source_decision_id','decision_version','receipt_id'] from clued_private.resource_center_profiles_v1 where id=p.id)
  is distinct from previous-array['source_decision_id','decision_version','receipt_id'] then
  raise exception 'storage_runtime_authority_layout_changed' using errcode='40001';end if;
 return clued_private.m1_finish_receipt(receipt.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
end $$;
revoke all on function clued_private.storage_runtime_authority_repair_v1(uuid,uuid,text,uuid,bigint,text)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Apply the exact registered profile; absent in clean/test/other deployments.
-- A present profile with any changed preimage fails rather than being skipped.
do $$
declare result jsonb;
begin
 if exists(select 1 from clued_private.resource_center_profiles_v1 where id='b5267eb8-7dda-408b-81ce-06112a18221a') then
  if not exists(select 1 from public.clued_memories where id='40eaae1b-8fd5-41e6-9806-c88ce6e9d7f2'
   and version=1 and content_hash='1aa9d1f493c46192b128d001aa562a6b58783b27e4a8819f68cb28c550871ad3') then
   raise exception 'storage_runtime_authority_successor_changed' using errcode='40001';end if;
  result:=clued_private.storage_runtime_authority_repair_v1(
   '2ddd1804-b1e5-4916-89fb-3b87fae11ee6','b5267eb8-7dda-408b-81ce-06112a18221a',
   '53f48ae5b99cf04ec6133d7c09406463d584eed57f23670987d61ba1a264073a',
   '40eaae1b-8fd5-41e6-9806-c88ce6e9d7f2',1,'storage-runtime-authority:20261117:559106ca-to-40eaae1b');
  if result->>'status' is distinct from 'committed' then
   raise exception 'storage_runtime_authority_not_committed' using errcode='40001';end if;
 end if;
end $$;
drop function clued_private.storage_runtime_authority_repair_v1(uuid,uuid,text,uuid,bigint,text);
