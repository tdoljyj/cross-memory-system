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
