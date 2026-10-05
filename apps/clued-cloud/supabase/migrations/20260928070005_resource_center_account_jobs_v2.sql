-- Account policy jobs retain the existing job identity, durable journal and
-- provider-root fence. This successor introduces no independent permission or
-- provider effect. The v1 RPC continues to serve only legacy connections.
alter table clued_private.storage_jobs_v1 add column authority_snapshot_v2 jsonb
  check(authority_snapshot_v2 is null or jsonb_typeof(authority_snapshot_v2)='object');

create function clued_private.storage_job_authority_immutable_v2() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.authority_snapshot_v2 is distinct from old.authority_snapshot_v2 then
    raise exception 'storage_job_authority_immutable' using errcode='42501';
  end if;
  return new;
end $$;
create trigger storage_job_authority_immutable_v2 before update on clued_private.storage_jobs_v1
  for each row execute function clued_private.storage_job_authority_immutable_v2();
revoke all on function clued_private.storage_job_authority_immutable_v2() from public,anon,authenticated,service_role;

-- Original-job metadata is not new execution authority. An Agent must still
-- hold its ORIGINAL live Binding/v12 generation and original request lineage;
-- client-specific storage denies remain effective. A root disconnect alone,
-- policy replacement or capability lifecycle change does not erase history.
-- Native Owner history already uses recovery_inspect in the existing native
-- recovery RPC, including when the Agent's delegation has itself been revoked.
create function clued_private.storage_job_history_v2(p_hash text,p_connection uuid,p_job uuid,p_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
  req clued_private.authorization_requests_v12; link clued_private.storage_client_request_links_v2;
  registration clued_private.storage_client_registrations_v2; c clued_private.storage_connections_v1;
  original_policy clued_private.storage_account_policies_v2;
  j clued_private.storage_jobs_v1; r public.clued_audit_receipts;
  owner_key uuid; binding_key uuid; request_key uuid; lineage_key uuid; issuer_key text; resource_key text; root_key text;
  s jsonb; expected_request jsonb;
begin
  if coalesce(p_hash,'') !~ '^[0-9a-f]{64}$' or p_connection is null or p_job is null then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select id,user_id into binding_key,owner_key from public.clued_agent_bindings where token_hash=p_hash;
  if not found then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  -- Lookup hints only. No existing job means the caller must use the normal
  -- current evaluator before it can create anything.
  select * into j from clued_private.storage_jobs_v1 where owner_id=owner_key and job_id=p_job;
  if not found then return null; end if;
  select a0.request_id,l.lineage_id,q.issuer_hash,q.resource,ap.root_folder_id
    into request_key,lineage_key,issuer_key,resource_key,root_key
    from clued_private.authorizations_v12 a0 join clued_private.authorization_requests_v12 q on q.id=a0.request_id
    join clued_private.storage_client_request_links_v2 l on l.request_id=q.id
    join clued_private.storage_connections_v1 sc on sc.id=j.connection_id and sc.owner_id=owner_key
    join clued_private.storage_account_policies_v2 ap on ap.id=(j.authority_snapshot_v2->>'policy_id')::uuid
      and ap.owner_id=owner_key and ap.connection_id=sc.id
    where a0.binding_id=binding_key and a0.owner_id=owner_key;
  if not found then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  perform 1 from clued_private.authorization_issuers_v12 where token_hash=issuer_key and resource=resource_key and revoked_at is null for share;
  if not found then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  perform clued_private.storage_client_guard_v2(owner_key,lineage_key,false);
  perform pg_advisory_xact_lock(hashtextextended('storage-job:'||owner_key::text||':'||p_job::text,0));
  perform pg_advisory_xact_lock(hashtextextended(owner_key::text||':'||root_key,0));
  select * into b from public.clued_agent_bindings where id=binding_key and user_id=owner_key and token_hash=p_hash for share;
  if not found or b.revoked_at is not null then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=owner_key for share;
  if not found or a.revoked_at is not null or a.request_id<>request_key then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(owner_key);
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=owner_key for share;
  if not found then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  -- The immutable ORIGINAL policy locates historical scope even if the
  -- connection has since acquired a successor policy. No active-state check.
  select * into original_policy from clued_private.storage_account_policies_v2
    where id=(j.authority_snapshot_v2->>'policy_id')::uuid and owner_id=owner_key and connection_id=c.id for share;
  if not found or original_policy.root_folder_id<>root_key then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  if exists(select 1 from clued_private.storage_client_denies_v2 where owner_id=owner_key and lineage_id=lineage_key and denied)
    or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=owner_key and provider=original_policy.provider
      and provider_subject=original_policy.provider_subject and root_folder_id=root_key and lineage_id=lineage_key and denied) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select * into j from clued_private.storage_jobs_v1 where owner_id=owner_key and job_id=p_job for share;
  s:=j.authority_snapshot_v2;
  if j.job_id is null or s is null or j.binding_id<>b.id or j.authorization_version<>a.version
    or s->>'binding_id' is distinct from b.id::text or s->>'owner_id' is distinct from owner_key::text
    or s->>'connection_id' is distinct from j.connection_id::text
    or s->>'authorization_version' is distinct from a.version::text
    or s->>'registration_lineage' is distinct from lineage_key::text
    or s->>'policy_generation' is distinct from original_policy.policy_generation::text
    or s->>'scope_digest' is distinct from original_policy.scope_digest
    or s->>'profile_id' is distinct from original_policy.profile_id::text
    or s->>'policy_receipt_id' is distinct from original_policy.activation_receipt_id::text
    or s->>'consent_receipt_id' is distinct from original_policy.consent_receipt_id::text
    or j.grant_receipt_id is distinct from original_policy.activation_receipt_id
    or (s->'actions' @> '["inspect"]'::jsonb) is not true then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select * into req from clued_private.authorization_requests_v12 where id=request_key;
  select * into link from clued_private.storage_client_request_links_v2 where request_id=request_key;
  select * into registration from clued_private.storage_client_registrations_v2
    where lineage_id=lineage_key and generation=(s->>'registration_generation')::bigint;
  if not found or req.owner_id is distinct from owner_key or req.binding_id is distinct from b.id or req.status is distinct from 'approved'
    or req.issuer_hash is distinct from issuer_key or req.resource is distinct from resource_key
    or req.client_id is distinct from a.client_id or req.resource is distinct from a.resource
    or link.lineage_id is distinct from lineage_key or link.registration_generation is distinct from registration.generation
    or registration.issuer_hash is distinct from req.issuer_hash or registration.resource is distinct from req.resource
    or registration.client_id is distinct from req.client_id or registration.metadata_digest is distinct from link.metadata_digest
    or link.metadata_digest is distinct from clued_private.storage_client_request_digest_v2(req.id) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  if j.connection_id<>p_connection or (p_digest is not null and j.request_digest<>p_digest) then
    raise exception 'storage_job_identity_conflict' using errcode='40001'; end if;
  expected_request:=jsonb_build_object('job_id',j.job_id,'request_digest',j.request_digest);
  select * into r from public.clued_audit_receipts where id=j.receipt_id and user_id=owner_key and binding_id=b.id
    and operation_family='storage_job_submit' and operation='storage_job_submit' and status='committed'
    and idempotency_key='storage-job:'||j.job_id::text and owns_idempotency_key;
  if not found or j.request_digest is distinct from clued_private.m1_sha256(jsonb_build_object('connection_id',j.connection_id,'mutation',j.mutation))
    or r.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_job_submit','payload',expected_request))
    or r.received_payload_hash is distinct from j.request_digest
    or not(r.target_refs @> jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',j.job_id)))
    or r.canonical_result->>'status' is distinct from 'committed'
    or r.response_hash is distinct from clued_private.m1_sha256(r.canonical_result) then
    raise exception 'storage_job_unavailable' using errcode='42501'; end if;
  if a.expires_at is null or a.expires_at<=clock_timestamp()
    or coalesce((to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp(),false) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  return clued_private.storage_job_status_v1(j)||jsonb_build_object('submit_receipt_id',j.receipt_id,'execution_permitted',false);
end $$;
revoke all on function clued_private.storage_job_history_v2(text,uuid,uuid,text) from public,anon,authenticated,service_role;

-- The evaluator obtains lineage -> owner/job -> root -> account locks and
-- rechecks every identity under those locks. Its result is a snapshot to pin,
-- never a bearer permission or an Agent-visible admission.
create function public.clued_storage_jobs_v2(p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op text:=p_input->>'action'; m jsonb:=p_input->'mutation';
  v_job_id uuid; connection_id uuid; wanted text:='inspect'; digest text;
  snapshot jsonb; consent_receipt uuid; existing clued_private.storage_jobs_v1; historical jsonb;
  receipt public.clued_audit_receipts; refs jsonb; ev text; profile_project uuid;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(p_input->'action') is distinct from 'string'
    or op not in ('submit','inspect')
    or p_input-array['action','connection_id','job_id','mutation']<>'{}'::jsonb
    or jsonb_typeof(p_input->'connection_id') is distinct from 'string'
    or jsonb_typeof(p_input->'job_id') is distinct from 'string'
    or (op='inspect' and (p_input ? 'mutation' or not(p_input ?& array['action','connection_id','job_id'])))
    or (op='submit' and not(p_input ?& array['action','connection_id','job_id','mutation'])) then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  connection_id:=(p_input->>'connection_id')::uuid;
  v_job_id:=(p_input->>'job_id')::uuid;
  if op='submit' then
    if jsonb_typeof(m) is distinct from 'object'
      or m-array['operation','destination_path','target_kind','directory_semantics','content']<>'{}'::jsonb
      or m->>'operation' is distinct from 'create'
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or jsonb_typeof(m->'destination_path') is distinct from 'string'
      or length(m->>'destination_path') not between 1 and 1000 then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    if m->>'target_kind'='file' then
      wanted:='create_file';
      if jsonb_typeof(m->'content') is distinct from 'string' or m ? 'directory_semantics'
        or not(m ?& array['operation','target_kind','destination_path','content'])
        or octet_length(m->>'content')>1048576 then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    else
      wanted:='create_topic';
      if m ? 'content' or coalesce(m->>'directory_semantics','') not in ('topic','asset_collection')
        or not(m ?& array['operation','target_kind','destination_path','directory_semantics']) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    end if;
  end if;
  if op='submit' then digest:=clued_private.m1_sha256(jsonb_build_object('connection_id',connection_id,'mutation',m)); end if;
  historical:=clued_private.storage_job_history_v2(p_token_hash,connection_id,v_job_id,digest);
  if historical is not null then
    return historical||case when op='submit' then jsonb_build_object('replayed',true) else '{}'::jsonb end;
  end if;
  if op='inspect' then raise exception 'storage_job_unavailable' using errcode='42501'; end if;
  snapshot:=clued_private.storage_policy_evaluate_v2(p_token_hash,connection_id,wanted,v_job_id);
  select consent_receipt_id into consent_receipt from clued_private.storage_account_policies_v2
    where id=(snapshot->>'policy_id')::uuid and owner_id=(snapshot->>'owner_id')::uuid for share;
  if consent_receipt is null then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  snapshot:=snapshot||jsonb_build_object('consent_receipt_id',consent_receipt);
  select * into existing from clued_private.storage_jobs_v1
    where owner_id=(snapshot->>'owner_id')::uuid and job_id=v_job_id for update;
  if existing.job_id is not null then
    -- Another submit may have committed while this one awaited the original
    -- job guard. It is historical identity, not a current-snapshot equality.
    historical:=clued_private.storage_job_history_v2(p_token_hash,connection_id,v_job_id,digest);
    if historical is null then raise exception 'storage_job_unavailable' using errcode='42501'; end if;
    return historical||jsonb_build_object('replayed',true);
  end if;
  receipt:=clued_private.m1_begin_receipt((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,
    'storage_job_submit',jsonb_build_object('idempotency_key','storage-job:'||v_job_id::text,
      'job_id',v_job_id,'request_digest',digest),digest);
  if receipt.status<>'pending' then raise exception 'storage_job_receipt_conflict' using errcode='40001'; end if;
  insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,
    authorization_version,request_digest,mutation,receipt_id,authority_snapshot_v2)
    values((snapshot->>'owner_id')::uuid,v_job_id,connection_id,(snapshot->>'binding_id')::uuid,
      (snapshot->>'policy_receipt_id')::uuid,(snapshot->>'authorization_version')::bigint,digest,m,receipt.id,snapshot)
    returning * into existing;
  select project_id into profile_project from clued_private.resource_center_profiles_v1
    where id=(snapshot->>'profile_id')::uuid;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',v_job_id));
  ev:=clued_private.m1_append_event_row((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,
    receipt.id,receipt.canonical_version,'extension:storage:job_submitted',refs,
    'project:'||profile_project::text,null,
    jsonb_build_object('job_id',v_job_id,'connection_id',connection_id,'request_digest',digest,
      'policy_id',snapshot->'policy_id','policy_generation',snapshot->'policy_generation',
      'capability_id',snapshot->'capability_id','scope_digest',snapshot->'scope_digest'),
    'storage-job:'||v_job_id::text,receipt.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(receipt.id,'committed',refs,'{}'::jsonb,
    jsonb_build_object(v_job_id::text,1),array[ev],'{}'::uuid[],null);
  if clued_private.storage_policy_evaluate_v2(p_token_hash,connection_id,wanted,v_job_id) is distinct from
      snapshot-'consent_receipt_id' then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  return clued_private.storage_job_status_v1(existing)||jsonb_build_object('replayed',false,'submit_receipt_id',existing.receipt_id);
end $$;
revoke all on function public.clued_storage_jobs_v2(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_jobs_v2(text,jsonb) to anon;
