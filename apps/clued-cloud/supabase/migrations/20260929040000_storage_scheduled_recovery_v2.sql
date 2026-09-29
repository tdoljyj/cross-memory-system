-- A bounded, read-only continuation for an original create whose provider
-- attempt was durably recorded but whose verified result was not. The fixed
-- Worker issuer may list and load those exact jobs; this function cannot
-- dispatch a provider effect or settle a journal.
create function public.clued_storage_scheduled_recovery_v2(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1;
  u uuid; c clued_private.storage_connections_v1;
  policy clued_private.storage_account_policies_v2;
  p clued_private.resource_center_profiles_v1;
  j clued_private.storage_jobs_v1; m clued_private.resource_center_mutations_v1;
  root_id text; jobs jsonb; op text:=p_input->>'action';
begin
  if p_issuer_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
    or op not in ('due','load') then
    raise exception 'storage_scheduled_recovery_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1
    where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_scheduled_recovery_denied' using errcode='42501'; end if;
  if op='due' then
    if p_input is distinct from jsonb_build_object('action','due') then
      raise exception 'storage_scheduled_recovery_denied' using errcode='42501'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('connection_id',q.connection_id,'job_id',q.job_id)),'[]'::jsonb)
      into jobs from (
      select j0.connection_id,j0.job_id from clued_private.storage_jobs_v1 j0
      join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
      join clued_private.resource_center_mutations_v1 m0 on m0.id=j0.intent_id and m0.user_id=j0.owner_id
      where c0.oauth_client_id=app.oauth_client_id and c0.revoked_at is null
        and c0.auth_mode='account_policy' and c0.state in ('active','reauthorization_required')
        and j0.authority_snapshot_v2 is not null and m0.state in ('started','uncertain')
        and m0.provider_attempt is not null and m0.provider_attempt_receipt_id is not null
        and m0.created_at<=clock_timestamp()-interval '15 seconds'
        and m0.created_at>clock_timestamp()-interval '10 minutes'
      order by m0.created_at,j0.job_id limit 3
    ) q;
    return jsonb_build_object('status','ok','jobs',jobs);
  end if;
  if p_input is distinct from jsonb_build_object('action','load',
    'connection_id',p_input->>'connection_id','job_id',p_input->>'job_id') then
    raise exception 'storage_scheduled_recovery_denied' using errcode='42501'; end if;
  select * into j from clued_private.storage_jobs_v1
    where job_id=(p_input->>'job_id')::uuid and connection_id=(p_input->>'connection_id')::uuid;
  if not found or j.intent_id is null or j.authority_snapshot_v2 is null then
    raise exception 'storage_scheduled_recovery_denied' using errcode='42501'; end if;
  u:=j.owner_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||u::text||':'||j.job_id::text,0));
  select pr.root_folder_id into root_id from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
    where co.id=j.connection_id and co.owner_id=u;
  if root_id is null then raise exception 'storage_scheduled_recovery_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root_id,0));
  perform clued_private.authorization_account_v12(u);
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=u for share;
  select * into policy from clued_private.storage_account_policies_v2
    where id=c.account_policy_id and owner_id=u and connection_id=c.id for share;
  select * into p from clued_private.resource_center_profiles_v1
    where id=c.profile_id and user_id=u for share;
  perform 1 from public.clued_memories d where d.id in
    (c.source_decision_id,p.source_decision_id,policy.source_decision_id) order by d.id for share;
  select * into j from clued_private.storage_jobs_v1 where owner_id=u and job_id=j.job_id for share;
  select * into m from clued_private.resource_center_mutations_v1
    where id=j.intent_id and user_id=u and profile_id=p.id for share;
  if c.id is null or c.provider<>'google-drive' or c.auth_mode<>'account_policy'
    or c.state not in ('active','reauthorization_required')
    or c.revoked_at is not null or c.oauth_client_id is distinct from app.oauth_client_id
    or not clued_private.storage_envelope_valid_v1(c.credential_envelope)
    or policy.id is null or policy.state<>'active' or policy.revoked_at is not null
    or coalesce(policy.expires_at<=clock_timestamp(),false) or p.state<>'active'
    or p.version<>c.profile_version or p.root_folder_id<>root_id
    or c.auth_generation::text is distinct from j.authority_snapshot_v2->>'auth_generation'
    or policy.policy_generation::text is distinct from j.authority_snapshot_v2->>'policy_generation'
    or policy.scope_digest is distinct from j.authority_snapshot_v2->>'scope_digest'
    or j.authority_snapshot_v2->>'policy_id' is distinct from policy.id::text
    or j.authority_snapshot_v2->>'connection_id' is distinct from c.id::text
    or m.id is null or m.state not in ('started','uncertain') or m.version<2
    or m.profile_version<>p.version or m.verified_result_v2 is not null
    or m.provider_attempt is null or m.provider_attempt_receipt_id is null
    or m.writer_binding_id is distinct from j.cloud_writer_binding_id
    or m.exact_request->'mutation' is distinct from
      (j.mutation||jsonb_build_object('artifact_role','clued_resource'))
    or j.mutation->>'operation' is distinct from 'create'
    or m.provider_attempt->>'provider_file_id' is null
    or m.provider_attempt->>'destination_path' is distinct from j.mutation->>'destination_path'
    or m.provider_attempt->>'parent_id' is distinct from
      m.authority_request->'provider_identity'->>'destination_parent_id'
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,policy.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,p.source_decision_id)
    or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=u and provider=c.provider
      and provider_subject=c.provider_subject and root_folder_id=root_id and lineage_id is null and denied) then
    raise exception 'storage_scheduled_recovery_denied' using errcode='42501'; end if;
  return jsonb_build_object('status','recovery_only','owner_id',u,'connection_id',c.id,'job_id',j.job_id,
    'provider','google-drive','provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,
    'credential_version',c.credential_version,'credential_envelope',c.credential_envelope,
    'profile',jsonb_build_object('managed_root',p.managed_root),'root_folder_id',p.root_folder_id,
    'root_parent_id',p.root_parent_id,'mutation',m.exact_request->'mutation',
    'provider_before',m.authority_request->'provider_identity','attempt',m.provider_attempt,
    'intent_id',m.id,'version',m.version,'request_sha256',m.request_sha256);
end $$;
revoke all on function public.clued_storage_scheduled_recovery_v2(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_scheduled_recovery_v2(text,jsonb) to anon;
