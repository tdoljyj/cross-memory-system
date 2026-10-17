-- Current registration repair is a separately authorized program operation.
-- It never recreates the original Agent/writer or asserts the old effect was
-- authorized/successful. All callers remain behind the existing issuer-proof
-- wrappers; these private helpers are not an API or a credential issuer.
create function clued_private.storage_registration_program_authority_v1(
 p_issuer_identity text,p_original_connection uuid,p_job uuid,p_selected uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare identity clued_private.issuer_identities_v1;credential clued_private.issuer_credentials_v1;
 app clued_private.storage_oauth_apps_v1;j clued_private.storage_jobs_v1;
 c clued_private.storage_connections_v1;p clued_private.resource_center_profiles_v1;
 policy clued_private.storage_account_policies_v2;gate clued_private.storage_master_controls_v1;
 reader jsonb;master jsonb;runtime jsonb;resolved_generation bigint;authority jsonb;
begin
 -- The outer proof resolver already holds this actual credential/app before
 -- any client/job/root lock. A generation supplied by the browser is never read.
 resolved_generation:=clued_private.issuer_credential_generation_v1(p_issuer_identity,'storage');
 select * into identity from clued_private.issuer_identities_v1
  where kind='storage' and legacy_key=p_issuer_identity;
 select * into credential from clued_private.issuer_credentials_v1
  where issuer_id=identity.id and generation=resolved_generation for share;
 select * into app from clued_private.storage_oauth_apps_v1
  where issuer_hash=p_issuer_identity and revoked_at is null for share;
 if identity.id is null or credential.issuer_id is null or credential.state<>'active'
 or coalesce(credential.valid_until<=clock_timestamp(),false) or app.issuer_hash is null
 or not app.execution_enabled then
  raise exception 'storage_registration_program_denied' using errcode='42501';end if;
 -- This locks the original lineage before job/root and checks the original
 -- subject/client/root plus a currently active, separately authorized reader.
 reader:=clued_private.storage_recovery_reader_v1(p_issuer_identity,p_original_connection,p_job,p_selected);
 select * into j from clued_private.storage_jobs_v1 where connection_id=p_original_connection and job_id=p_job;
 select * into c from clued_private.storage_connections_v1
  where id=(reader->'recovery_reader'->>'connection_id')::uuid and owner_id=j.owner_id for share;
 select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=j.owner_id for share;
 select * into policy from clued_private.storage_account_policies_v2
  where id=c.account_policy_id and connection_id=c.id and owner_id=j.owner_id for share;
 select * into gate from clued_private.storage_master_controls_v1
  where connection_id=c.id and owner_id=j.owner_id for share;
 if c.id is null or c.oauth_client_id is distinct from app.oauth_client_id
 or c.provider_scope_profile is distinct from 'full' or c.auth_mode is distinct from 'account_policy'
 or policy.id is null or policy.revoked_at is not null or not('modify'=any(policy.actions))
 or policy.scope_contract is distinct from 'clued.storage-account-scope/3' or policy.policy_generation<1
 or policy.scope_digest is distinct from clued_private.storage_policy_scope_digest_v3(c.id,policy.scope_contract,policy.actions)
 or (select count(*) from clued_private.storage_oauth_apps_v1 other
   where other.oauth_client_id=c.oauth_client_id and other.revoked_at is null)<>1 then
  raise exception 'storage_registration_program_denied' using errcode='42501';end if;
 -- This is the existing account/runtime/master/lifecycle/Decision/consent
 -- gate, without borrowing the identity of an expired Agent Binding.
 master:=clued_private.storage_master_snapshot_v1(j.owner_id,c.id);
 if master->'policy_current' is distinct from 'true'::jsonb
 or master->'agent_enabled' is distinct from 'true'::jsonb
 or master->'write_enabled' is distinct from 'true'::jsonb
 or master->'root_stopped' is distinct from 'false'::jsonb then
  raise exception 'storage_registration_program_denied' using errcode='42501';end if;
 runtime:=p.cloud_runtime;
 if jsonb_typeof(runtime) is distinct from 'object'
 or runtime->>'contract' is distinct from 'clued.storage-cloud-runtime/1'
 or runtime->>'profile_version' is distinct from p.version::text
 or jsonb_typeof(runtime->'allowed_root_children') is distinct from 'array'
 or jsonb_array_length(runtime->'allowed_root_children') not between 1 and 32
 or not exists(select 1 from public.clued_audit_receipts r
  join public.clued_context_events e on e.receipt_id=r.id and e.user_id=r.user_id
  where r.id=(runtime->>'receipt_id')::uuid and r.user_id=j.owner_id
  and r.status='committed' and r.operation='storage_cloud_qualify'
  and r.response_hash=clued_private.m1_sha256(r.canonical_result)
  and e.canonical_event_type='extension:storage:cloud_qualified' and e.result='success'
  and e.change_summary->>'profile_id'=p.id::text
  and e.change_summary->>'runtime_digest'=clued_private.m1_sha256(runtime-'receipt_id')) then
  raise exception 'storage_registration_program_denied' using errcode='42501';end if;
 -- Recheck the real wall clock after every potentially waiting row lock.
 if credential.valid_until is not null and credential.valid_until<=clock_timestamp()
 or coalesce(policy.expires_at<=clock_timestamp(),false) then
  raise exception 'storage_registration_program_denied' using errcode='42501';end if;
 authority:=jsonb_build_object('contract','clued.storage-registration-program-authority/1',
  'actor_kind','storage_program','issuer_id',identity.id,'issuer_credential_generation',resolved_generation,
  'issuer_valid_until',credential.valid_until,'oauth_client_id',app.oauth_client_id,
  'owner_id',j.owner_id,'original_connection_id',j.connection_id,'job_id',j.job_id,'intent_id',j.intent_id,
  'connection_id',c.id,'connection_version',c.version,'credential_version',c.credential_version,
  'auth_generation',c.auth_generation,'provider',c.provider,'provider_subject',c.provider_subject,
  'profile_id',p.id,'profile_version',p.version,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,
  'managed_root',p.managed_root,'provider_scope_profile',c.provider_scope_profile,
  'policy_id',policy.id,'policy_generation',policy.policy_generation,'actions',to_jsonb(policy.actions),
  'scope_contract',policy.scope_contract,'scope_digest',policy.scope_digest,'source_decision_id',policy.source_decision_id,
  'decision_version',policy.decision_version,'connection_receipt_id',c.receipt_id,
  'consent_receipt_id',policy.consent_receipt_id,'activation_receipt_id',policy.activation_receipt_id,
  'runtime',runtime,'master_generation',coalesce(gate.generation,0),'master_receipt_id',gate.receipt_id,
  'master_status_digest',master->>'status_digest','registration_action','modify');
 return reader||jsonb_build_object('registration_authority',authority);
end $$;
revoke all on function clued_private.storage_registration_program_authority_v1(text,uuid,uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- A current qualification is new truth with its own Receipt. It never edits
-- the old authorization snapshot, failed attempt or success classification.
create table clued_private.storage_current_registration_results_v1(
 intent_id uuid primary key references clued_private.resource_center_mutations_v1(id),
 owner_id uuid not null references auth.users(id),
 original_connection_id uuid not null,job_id uuid not null,
 base_version bigint not null,source_receipt_id uuid not null references public.clued_audit_receipts(id),
 authority jsonb not null,plan jsonb not null,observations jsonb not null,
 receipt_id uuid not null unique references public.clued_audit_receipts(id),
 result jsonb not null,created_at timestamptz not null default clock_timestamp());
alter table clued_private.storage_current_registration_results_v1 enable row level security;
revoke all on clued_private.storage_current_registration_results_v1
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- An exact metadata transition permit, not a general conflict exemption.
-- It cannot admit provider work or clear any other object's quarantine.
create table clued_private.storage_registration_artifact_permits_v1(
 transaction_id bigint not null,artifact_id uuid not null,receipt_id uuid not null references public.clued_audit_receipts(id),
 intent_id uuid not null,owner_id uuid not null,profile_id uuid not null,before_hash text not null,after_hash text not null,
 primary key(transaction_id,artifact_id));
alter table clued_private.storage_registration_artifact_permits_v1 enable row level security;
revoke all on clued_private.storage_registration_artifact_permits_v1
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_registration_artifact_permitted_v1(
 p_before clued_private.resource_center_artifacts_v1,p_after clued_private.resource_center_artifacts_v1) returns boolean
language plpgsql security definer set search_path='' as $$
declare permit clued_private.storage_registration_artifact_permits_v1;q clued_private.storage_conflict_isolations_v1;
 p clued_private.resource_center_profiles_v1;qp clued_private.resource_center_profiles_v1;
 relative_path text;subtree text;relative_subtree text;parent_id text;
begin
 select x.* into permit from clued_private.storage_registration_artifact_permits_v1 x
  join public.clued_audit_receipts receipt on receipt.id=x.receipt_id and receipt.user_id=x.owner_id
  where x.transaction_id=txid_current() and x.artifact_id=p_before.id and x.owner_id=p_before.user_id and x.profile_id=p_before.profile_id
   and x.receipt_id=p_after.receipt_id and x.before_hash=clued_private.m1_sha256(to_jsonb(p_before))
   and x.after_hash=clued_private.m1_sha256(to_jsonb(p_after))
   and receipt.status='pending' and receipt.operation='storage_current_registration_reconcile';
 if permit.artifact_id is null then return false;end if;
 if (to_jsonb(p_before)-array['provider_access_digest','provider_sharing_digest','provider_file_version','version','receipt_id',
   'access_digest_missing_at','access_digest_attempted_at','updated_at']) is distinct from
  (to_jsonb(p_after)-array['provider_access_digest','provider_sharing_digest','provider_file_version','version','receipt_id',
   'access_digest_missing_at','access_digest_attempted_at','updated_at'])
 or p_before.target_kind<>'directory' or p_before.state<>'active' or p_after.version<>p_before.version+1
 or p_after.access_digest_missing_at is not null or p_after.provider_access_digest is null or p_after.provider_sharing_digest is null
 or p_before.provider_access_digest is not null and p_before.provider_access_digest is distinct from p_after.provider_access_digest
 or p_before.provider_sharing_digest is not null and p_before.provider_sharing_digest is distinct from p_after.provider_sharing_digest then
  raise exception 'storage_current_registration_permit_invalid' using errcode='42501';end if;
 select * into p from clued_private.resource_center_profiles_v1 where id=p_before.profile_id and user_id=p_before.user_id;
 relative_path:=substr(p_before.path,length(p.managed_root)+1);
 parent_id:=case when p_before.path=p.managed_root then p.root_parent_id else (
  select provider_file_id from clued_private.resource_center_artifacts_v1 parent
   where parent.user_id=p_before.user_id and parent.profile_id=p_before.profile_id and parent.state='active'
   and parent.path=regexp_replace(p_before.path,'/[^/]+$','')) end;
 for q in select * from clued_private.storage_conflict_isolations_v1
  where state='active' and (root_folder_id=p.root_folder_id or p_before.provider_file_id=any(object_ids) or p_before.provider_file_id=any(ancestor_ids)) loop
  if q.intent_id=permit.intent_id and clued_private.storage_conflict_exit_allowed_v1(q.intent_id,permit.receipt_id) then continue;end if;
  -- Ancestor-only metadata qualification does not alter the isolated object.
  -- Unknown scope, the same object, exact path/slot or a containing subtree
  -- still use the original fail-closed protection, including other profiles.
  if not q.scope_complete or p_before.provider_file_id=any(q.object_ids)
  or p_before.profile_id=q.profile_id and p_before.path=any(q.paths)
  or exists(select 1 from jsonb_array_elements(q.slots) slot where slot->>'parent_id'=parent_id
   and slot->>'name'=regexp_replace(p_before.path,'^.*/',''))
  or cardinality(q.subtree_paths)>0 and exists(select 1 from clued_private.resource_center_ancestor_rows_v1(
   p.id,p.user_id,array[regexp_replace(p_before.path,'/[^/]+$','')]) ancestor where ancestor.provider_file_id=any(q.object_ids)) then
   raise exception 'storage_object_under_review' using errcode='42501';end if;
  select * into qp from clued_private.resource_center_profiles_v1 where id=q.profile_id and user_id=q.user_id;
  foreach subtree in array q.subtree_paths loop
   relative_subtree:=substr(subtree,length(qp.managed_root)+1);
   if qp.id is null or q.root_folder_id=p.root_folder_id and
    (relative_path=relative_subtree or starts_with(relative_path,relative_subtree||'/')) then
    raise exception 'storage_object_under_review' using errcode='42501';end if;
  end loop;
 end loop;
 return true;
end $$;
revoke all on function clued_private.storage_registration_artifact_permitted_v1(
 clued_private.resource_center_artifacts_v1,clued_private.resource_center_artifacts_v1)
 from public,anon,authenticated,service_role,clued_worker_gateway;

do $permit$ declare body text;anchor text;begin
 body:=pg_get_functiondef('clued_private.storage_conflict_exit_allowed_v1(uuid,uuid)'::regprocedure);
 anchor:='''storage_automatic_reconcile''';
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_registration_exit_source_mismatch';end if;
 execute replace(body,anchor,anchor||',''storage_current_registration_reconcile''');
 body:=pg_get_functiondef('clued_private.storage_conflict_artifact_guard_v1()'::regprocedure);
 anchor:=E'\nbegin\n';
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_registration_guard_source_mismatch';end if;
 execute replace(body,anchor,anchor||$patch$ if tg_op='UPDATE' and clued_private.storage_registration_artifact_permitted_v1(old,new) then return new;end if;
$patch$);
end $permit$;

create function clued_private.storage_current_registration_node_v1(a clued_private.resource_center_artifacts_v1,p_parent text)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('artifact_id',a.id,'artifact_version',a.version,'path',a.path,
  'provider_file_id',a.provider_file_id,'parent_id',p_parent,
  'access_digest',a.provider_access_digest,'sharing_digest',a.provider_sharing_digest)
$$;
revoke all on function clued_private.storage_current_registration_node_v1(clued_private.resource_center_artifacts_v1,text)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Finite first registration branch: an existing, active, ordinary empty
-- directory at the same ID/path. The original P5 job is already I9-closed.
-- Parent/root/track qualification changes metadata only, never path, identity,
-- governance, delete authority, policy scope, consent or Drive contents.
create function clued_private.storage_current_registration_plan_v1(
 p_issuer_identity text,p_connection uuid,p_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare reader jsonb;descriptor jsonb;j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;
 q clued_private.storage_conflict_isolations_v1;p clued_private.resource_center_profiles_v1;
 a clued_private.resource_center_artifacts_v1;node clued_private.resource_center_artifacts_v1;
 attempt_receipt public.clued_audit_receipts;parents jsonb:='[]';parent_path text;parent_id text;last_path text;last_id text;
begin
 -- Resolve the actual issuer generation/app first, then original client/job/
 -- root/account. The public entry independently resolves the proof per RPC.
 reader:=clued_private.storage_registration_program_authority_v1(p_issuer_identity,p_connection,p_job);
 select * into j from clued_private.storage_jobs_v1 where connection_id=p_connection and job_id=p_job for share;
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=j.intent_id and user_id=j.owner_id for share;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for share;
 select * into p from clued_private.resource_center_profiles_v1 where id=m.profile_id and user_id=j.owner_id for share;
 select * into attempt_receipt from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=j.owner_id;
 if q.intent_id is null or q.state<>'active' or not q.scope_complete or cardinality(q.object_ids)<>1
 or m.state<>'conflict' or m.version<>q.closed_version or m.receipt_id is distinct from q.close_receipt_id
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
  raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
 -- Reuse the exact original attempted-request and immutable Receipt checks;
 -- this load is settlement-only and never restores the old writer.
 descriptor:=clued_private.storage_conflict_load_v1(p_issuer_identity,
  jsonb_build_object('action','load','connection_id',p_connection,'job_id',p_job));
 if descriptor->>'intent_id' is distinct from m.id::text or descriptor->>'request_sha256' is distinct from m.request_sha256
 or descriptor->>'version' is distinct from m.version::text or descriptor->'attempt' is distinct from m.provider_attempt then
  raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
 -- Artifact Decisions can differ from the current connection/profile
 -- Decision. Serialize their archival/replacement, not only the account
 -- policy's authorization, before validating the registry qualification.
 -- The master snapshot already holds a subset of these Decision locks.
 -- A replacement transaction can hold a lower Artifact Decision while it
 -- waits for that subset. Never wait here while retaining the subset: abort
 -- this entire qualification transaction and let scheduled recovery back off.
 perform 1 from public.clued_memories decision where decision.user_id=j.owner_id and decision.id in (
  select p.source_decision_id union select (reader->'registration_authority'->>'source_decision_id')::uuid
  union select artifact.source_decision_id from clued_private.resource_center_artifacts_v1 artifact
   where artifact.user_id=j.owner_id and artifact.profile_id=p.id and artifact.path=j.mutation->>'source_path'
  union select ancestor.source_decision_id from clued_private.resource_center_ancestor_rows_v1(p.id,j.owner_id,
   array[regexp_replace(j.mutation->>'source_path','/[^/]+$','')]) ancestor)
  order by decision.id for share nowait;
 select * into a from clued_private.resource_center_artifacts_v1 where user_id=j.owner_id and profile_id=p.id
  and provider_file_id=q.object_ids[1] and path=j.mutation->>'source_path' for share;
 parent_path:=regexp_replace(a.path,'/[^/]+$','');
 if a.id is null or a.state<>'active' or a.target_kind<>'directory' or a.governance_class<>'ordinary'
 or a.path is distinct from m.provider_attempt->>'source_path' or a.provider_file_id is distinct from j.mutation->>'source_file_id'
 or not starts_with(a.path,p.managed_root||'/') or parent_path=p.managed_root
 or a.provider_file_id in (p.root_folder_id,p.root_parent_id)
 or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,a.source_decision_id)
 or not clued_private.resource_center_path_current_v1(j.owner_id,p.project_id,p.id,p.managed_root,a.path)
 or exists(select 1 from clued_private.resource_center_artifacts_v1 child where child.user_id=j.owner_id and child.profile_id=p.id
  and child.state in ('active','trashed') and starts_with(child.path,a.path||'/')) then
  raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
 last_path:=null;last_id:=null;
 for node in select * from clued_private.resource_center_ancestor_rows_v1(p.id,j.owner_id,array[parent_path]) r
  order by r.path collate "C" for share loop
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
 or last_path is distinct from parent_path or last_id is distinct from m.provider_attempt->>'parent_id' then
  raise exception 'storage_current_registration_unavailable' using errcode='42501';end if;
 return reader||jsonb_build_object('status','registration_required','connection_id',j.connection_id,'job_id',j.job_id,
  'owner_id',j.owner_id,'intent_id',m.id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'registration_plan',jsonb_build_object('contract','clued.storage-registration-plan/1','mode','refresh_directory',
   'managed_root',p.managed_root,'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,
   'intent_id',m.id,'request_sha256',m.request_sha256,'parents',parents,
   'target',clued_private.storage_current_registration_node_v1(a,last_id)),'execution_permitted',false);
end $$;
revoke all on function clued_private.storage_current_registration_plan_v1(text,uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Validate the full selected observation schema and rederive both digests
-- from the supported owner-private ACL. The Worker is the trusted observer;
-- a digest-shaped string or omitted permission is never sufficient evidence.
create function clued_private.storage_current_registration_observation_v1(p_plan jsonb,p_observation jsonb) returns void
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
  or observed-array['artifact_id','artifact_version','path','provider_file_id','parent_id','access_digest','sharing_digest',
   'provider_file_version','owner_permission_id','owner_allow_file_discovery',
   case when idx=jsonb_array_length(p_plan->'parents') then 'mime_type' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'size' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'sha256' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'empty' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'intent_tag' end,
   case when idx=jsonb_array_length(p_plan->'parents') then 'request_tag' end]<>'{}'
  or observed-array['provider_file_version','access_digest','sharing_digest','owner_permission_id','owner_allow_file_discovery',
   'mime_type','size','sha256','empty','intent_tag','request_tag'] is distinct from node-array['access_digest','sharing_digest']
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
 if p_observation->'target'->>'mime_type' is distinct from 'application/vnd.google-apps.folder'
 or p_observation->'target'->'empty' is distinct from 'true'::jsonb
 or p_observation->'target'->'size' is distinct from 'null'::jsonb
 or p_observation->'target'->'sha256' is distinct from 'null'::jsonb
 or p_observation->'target'->'intent_tag' is distinct from 'null'::jsonb
 or p_observation->'target'->'request_tag' is distinct from 'null'::jsonb
 or p_observation->'target'->'access_digest' is distinct from (p_observation->'parents'->-1)->'access_digest'
 or p_observation->'target'->'sharing_digest' is distinct from (p_observation->'parents'->-1)->'sharing_digest' then
  raise exception 'storage_current_registration_proof_invalid' using errcode='22023';end if;
end $$;
revoke all on function clued_private.storage_current_registration_observation_v1(jsonb,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_current_registration_reconcile_v1(p_issuer_identity text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d jsonb;authority jsonb;plan jsonb;first jsonb:=p_input->'first_observation';second jsonb:=p_input->'second_observation';
 j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;q clued_private.storage_conflict_isolations_v1;
 p clued_private.resource_center_profiles_v1;saved clued_private.storage_current_registration_results_v1;
 a clued_private.resource_center_artifacts_v1;next_artifact clued_private.resource_center_artifacts_v1;
 node jsonb;observed jsonb;idx integer;qualified_at timestamptz;
 first_at timestamptz;second_at timestamptz;req jsonb;refs jsonb;ev text;result jsonb;r public.clued_audit_receipts;
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
 authority:=clued_private.storage_registration_program_authority_v1(p_issuer_identity,
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
 d:=clued_private.storage_current_registration_plan_v1(p_issuer_identity,j.connection_id,j.job_id);
 if p_input->>'action'='registration_current_load' then return d;end if;
 plan:=d->'registration_plan';
 if p_input->>'base_version' is distinct from m.version::text or p_input->>'source_receipt_id' is distinct from q.close_receipt_id::text
 or p_input->'registration_authority' is distinct from d->'registration_authority' or p_input->'registration_plan' is distinct from plan then
  raise exception 'storage_current_registration_conflict' using errcode='40001';end if;
 perform clued_private.storage_current_registration_observation_v1(plan,first);
 perform clued_private.storage_current_registration_observation_v1(plan,second);
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
  and artifact.id in (select (x->>'artifact_id')::uuid from jsonb_array_elements((plan->'parents')||jsonb_build_array(plan->'target')) x)
  order by artifact.id for update;
 for idx in 0..jsonb_array_length(plan->'parents') loop
  if idx=jsonb_array_length(plan->'parents') then node:=plan->'target';observed:=second->'target';
  else node:=plan->'parents'->idx;observed:=second->'parents'->idx;end if;
  select * into a from clued_private.resource_center_artifacts_v1 where id=(node->>'artifact_id')::uuid and user_id=j.owner_id and profile_id=p.id;
  if a.id is null or a.version::text is distinct from node->>'artifact_version' or a.state<>'active'
  or a.path is distinct from node->>'path' or a.provider_file_id is distinct from node->>'provider_file_id'
  or a.provider_access_digest is distinct from node->>'access_digest' or a.provider_sharing_digest is distinct from node->>'sharing_digest'
  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,a.source_decision_id) then
   raise exception 'storage_current_registration_conflict' using errcode='40001';end if;
  if idx=jsonb_array_length(plan->'parents') or a.provider_access_digest is null then
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
 authority:=clued_private.storage_registration_program_authority_v1(p_issuer_identity,j.connection_id,j.job_id);
 if authority->'registration_authority' is distinct from d->'registration_authority'
 or clock_timestamp()-first_at>interval '30 seconds' then
  raise exception 'storage_current_registration_authority_changed' using errcode='40001';end if;
 req:=jsonb_build_object('idempotency_key','storage-current-registration:'||m.id::text||':'||m.version::text,
  'intent_id',m.id,'connection_id',j.connection_id,'job_id',j.job_id,'base_version',m.version,'source_receipt_id',q.close_receipt_id,
  'original_attempt_receipt_id',m.provider_attempt_receipt_id,'original_attempt_digest',clued_private.m1_sha256(m.provider_attempt),
  'registration_authority',d->'registration_authority','registration_plan',plan,
  'first_observation',first,'second_observation',second,'before_rows',before_rows,'reason_code','CURRENT_REGISTRATION_QUALIFIED');
 r:=clued_private.m1_begin_receipt(j.owner_id,null,'storage_current_registration_reconcile',req,clued_private.m1_sha256(req));
 if r.status<>'pending' then raise exception 'storage_current_registration_conflict' using errcode='40001';end if;
 insert into clued_private.storage_conflict_exit_permits_v1 values(m.id,r.id,txid_current());
 qualified_at:=clock_timestamp();
 for idx in 0..jsonb_array_length(plan->'parents') loop
  if idx=jsonb_array_length(plan->'parents') then node:=plan->'target';observed:=second->'target';
  else node:=plan->'parents'->idx;observed:=second->'parents'->idx;end if;
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
 update clued_private.storage_conflict_isolations_v1 set state='resolved',resolution_receipt_id=r.id where intent_id=m.id;
 update clued_private.resource_center_mutations_v1 set version=version+1,updated_at=clock_timestamp(),
  final_result=final_result||jsonb_build_object('automatic_resolution','automatically_registered_current_state',
   'automatic_receipt_id',r.id,'automatic_base_version',m.version) where id=m.id;
 result:=jsonb_build_object('status','resolved','resolution','automatically_registered_current_state','automatic_recovery','resolved',
  'connection_id',j.connection_id,'job_id',j.job_id,'intent_id',m.id,'receipt_id',r.id,
  'source_receipt_id',q.close_receipt_id,'base_version',m.version,'execution_permitted',false);
 refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
 base_versions:=jsonb_build_object(m.id::text,m.version);committed_versions:=jsonb_build_object(m.id::text,m.version+1);
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
revoke all on function clued_private.storage_current_registration_reconcile_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Keep the existing public issuer-proof wrapper and every public ACL intact.
do $clone$ declare body text;begin
 body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_scheduled_recovery_v2(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.ii_pub_clued_storage_scheduled_recovery_v2(',
  'FUNCTION clued_private.storage_scheduled_before_current_registration_v1(');
end $clone$;
revoke all on function clued_private.storage_scheduled_before_current_registration_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;
create or replace function clued_private.ii_pub_clued_storage_scheduled_recovery_v2(p_issuer_identity text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_input->>'action' in ('registration_current_load','registration_current_commit') then
  return clued_private.storage_current_registration_reconcile_v1(p_issuer_identity,p_input);end if;
 return clued_private.storage_scheduled_before_current_registration_v1(p_issuer_identity,p_input);
end $$;

create function clued_private.storage_current_registration_status_v1(j clued_private.storage_jobs_v1) returns jsonb
language sql stable security definer set search_path='' as $$
 select saved.result from clued_private.storage_current_registration_results_v1 saved
  join clued_private.storage_conflict_isolations_v1 q on q.intent_id=saved.intent_id and q.user_id=saved.owner_id
  join clued_private.resource_center_mutations_v1 m on m.id=saved.intent_id and m.user_id=saved.owner_id
  join public.clued_audit_receipts receipt on receipt.id=saved.receipt_id and receipt.user_id=saved.owner_id
 where saved.intent_id=j.intent_id and saved.owner_id=j.owner_id and saved.job_id=j.job_id and saved.original_connection_id=j.connection_id
  and q.state='resolved' and q.resolution_receipt_id=saved.receipt_id and q.close_receipt_id=saved.source_receipt_id
  and m.state='conflict' and m.receipt_id=saved.source_receipt_id and m.version=saved.base_version+1
  and m.final_result->>'automatic_resolution'='automatically_registered_current_state'
  and m.final_result->>'automatic_receipt_id'=saved.receipt_id::text
  and receipt.operation='storage_current_registration_reconcile' and receipt.status='committed'
  and receipt.response_hash=clued_private.m1_sha256(receipt.canonical_result)
$$;
revoke all on function clued_private.storage_current_registration_status_v1(clued_private.storage_jobs_v1)
 from public,anon,authenticated,service_role,clued_worker_gateway;
do $status$ declare body text;begin
 body:=pg_get_functiondef('clued_private.storage_job_status_v1(clued_private.storage_jobs_v1)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_job_status_v1(',
  'FUNCTION clued_private.storage_job_status_before_current_registration_v1(');
 body:=pg_get_functiondef('clued_private.storage_conflict_public_status_v1(clued_private.storage_jobs_v1)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_conflict_public_status_v1(',
  'FUNCTION clued_private.storage_conflict_public_before_current_registration_v1(');
end $status$;
create or replace function clued_private.storage_job_status_v1(p_job clued_private.storage_jobs_v1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb:=clued_private.storage_job_status_before_current_registration_v1(p_job);
 current_result jsonb:=clued_private.storage_current_registration_status_v1(p_job);
begin
 if current_result is not null then result:=result||jsonb_build_object('reason_code','PROVIDER_RESULT_RECONCILED',
  'resolution','automatically_registered_current_state','resolution_receipt_id',current_result->'receipt_id',
  'source_receipt_id',current_result->'source_receipt_id','automatic_recovery','resolved');end if;
 return result;
end $$;
create or replace function clued_private.storage_conflict_public_status_v1(j clued_private.storage_jobs_v1) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb:=clued_private.storage_conflict_public_before_current_registration_v1(j);
 current_result jsonb:=clued_private.storage_current_registration_status_v1(j);
begin
 if current_result is not null then return result||current_result||jsonb_build_object('review_available',false,'abandon_available',false);end if;
 return result;
end $$;
revoke all on function clued_private.storage_job_status_before_current_registration_v1(clued_private.storage_jobs_v1),
 clued_private.storage_conflict_public_before_current_registration_v1(clued_private.storage_jobs_v1)
 from public,anon,authenticated,service_role,clued_worker_gateway;
