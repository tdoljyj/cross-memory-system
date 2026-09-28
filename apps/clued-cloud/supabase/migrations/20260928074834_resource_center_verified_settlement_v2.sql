-- Section 6: trusted complete verification is durable BEFORE final disconnect.
-- No new attempt table, admission, credential, provider operation or authority.
-- Narrow settlement: connection/policy/writer revocation is allowed, but the
-- original profile, CURRENT Decisions and ancestor registry must still match.
alter table clued_private.resource_center_mutations_v1
  add column verified_result_v2 jsonb,
  add column verified_receipt_id_v2 uuid references public.clued_audit_receipts(id),
  add column verified_digest_v2 text check(verified_digest_v2 ~ '^[0-9a-f]{64}$'),
  add constraint resource_center_verified_complete_v2 check(
    (verified_result_v2 is null and verified_receipt_id_v2 is null and verified_digest_v2 is null)
    or (verified_result_v2 is not null and jsonb_typeof(verified_result_v2)='object'
      and verified_receipt_id_v2 is not null and verified_digest_v2 is not null));

create function clued_private.storage_verified_immutable_v2()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.verified_result_v2 is not null and (new.verified_result_v2,new.verified_receipt_id_v2,new.verified_digest_v2)
    is distinct from (old.verified_result_v2,old.verified_receipt_id_v2,old.verified_digest_v2) then
    raise exception 'storage_verified_immutable' using errcode='42501'; end if;
  return new;
end $$;
create trigger resource_center_verified_immutable_v2 before update on clued_private.resource_center_mutations_v1
  for each row execute function clued_private.storage_verified_immutable_v2();

create function clued_private.storage_verified_result_v2(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op text:=p_input->>'action'; app clued_private.storage_oauth_apps_v1;
  c clued_private.storage_connections_v1; j clued_private.storage_jobs_v1;
  p clued_private.resource_center_profiles_v1; policy clued_private.storage_account_policies_v2;
  m clued_private.resource_center_mutations_v1; parent clued_private.resource_center_artifacts_v1;
  r public.clued_audit_receipts; audit public.clued_audit_receipts; start_receipt public.clued_audit_receipts;
  proof jsonb:=p_input->'proof'; finish jsonb:=p_input->'finish'; post jsonb;
  expected jsonb; attempt_expected jsonb; req jsonb; refs jsonb; ev text; registered jsonb; result jsonb;
  ancestors jsonb; saved jsonb; parent_path text; root_key text; decision_version bigint; authority jsonb;
  registration_input jsonb; start_request jsonb; input_digest text:=clued_private.m1_sha256(p_input);
begin
  if jsonb_typeof(p_input) is distinct from 'object' or jsonb_typeof(p_input->'action') is distinct from 'string'
    or op not in ('verified_record','verified_inspect','settle_verified') then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  if (op='verified_record' and p_input-array['action','connection_id','job_id','credential_version','finish','proof']<>'{}'::jsonb)
    or (op='settle_verified' and p_input-array['action','connection_id','job_id','intent_id','base_version','request_sha256','verified_receipt_id','verified_digest']<>'{}'::jsonb)
    or (op='verified_inspect' and p_input is distinct from jsonb_build_object('action','verified_inspect','connection_id',p_input->>'connection_id','job_id',p_input->>'job_id')) then
    raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
  -- Operational pause (execution_enabled=false) is not final issuer revoke.
  -- This endpoint cannot load credentials or permit a provider request.
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and oauth_client_id=app.oauth_client_id;
  if not found then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('storage-job:'||c.owner_id::text||':'||(p_input->>'job_id')::uuid::text,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=(p_input->>'job_id')::uuid and connection_id=c.id;
  if not found or j.authority_snapshot_v2 is null or (j.intent_id is null and op<>'verified_inspect') then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  select root_folder_id into root_key from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  if root_key is null then raise exception 'storage_verified_denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(c.owner_id::text||':'||root_key,0));
  perform clued_private.authorization_account_v12(c.owner_id);
  select * into c from clued_private.storage_connections_v1 where id=c.id for share;
  select * into policy from clued_private.storage_account_policies_v2 where id=(j.authority_snapshot_v2->>'policy_id')::uuid and owner_id=c.owner_id and connection_id=c.id for share;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id for update;
  if op='verified_inspect' and j.intent_id is null then
    -- This is NOT authority for fresh execution. Only the ordinary evaluator
    -- may subsequently load a queued job. Unknown/outcome paths never fall back.
    select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=j.job_id for share;
    if j.dispatch_outcome is null and c.auth_mode='account_policy' and c.state='active'
      and c.revoked_at is null and policy.state='active' then
      return jsonb_build_object('status','none','connection_id',c.id,'job_id',j.job_id,'execution_permitted',false); end if;
    return jsonb_build_object('status','inspection_required','connection_id',c.id,'job_id',j.job_id,'execution_permitted',false);
  end if;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=c.owner_id and profile_id=p.id;
  parent_path:=left(j.mutation->>'destination_path',char_length(j.mutation->>'destination_path')-strpos(reverse(j.mutation->>'destination_path'),'/'));
  -- Profile lock serializes registry changes; lock all relevant Decisions in
  -- stable order before job/journal rows, including each registered ancestor.
  perform 1 from public.clued_memories d where d.id in (
    select unnest(array[c.source_decision_id,p.source_decision_id,policy.source_decision_id,m.source_decision_id,(p.cloud_runtime->>'source_decision_id')::uuid])
    union select a.source_decision_id from clued_private.resource_center_artifacts_v1 a
      where a.profile_id=p.id and a.user_id=c.owner_id and a.state='active'
        and (a.path=parent_path or left(parent_path,char_length(a.path)+1)=a.path||'/')) order by d.id for share;
  perform 1 from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=c.owner_id
    and a.state='active' and (a.path=parent_path or left(parent_path,char_length(a.path)+1)=a.path||'/') order by a.id for share;
  select jsonb_agg(to_jsonb(a) order by a.path collate "C") into ancestors
    from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=c.owner_id
      and a.state='active' and (a.path=parent_path or left(parent_path,char_length(a.path)+1)=a.path||'/');
  select * into parent from clued_private.resource_center_artifacts_v1 where profile_id=p.id and user_id=c.owner_id and state='active' and path=parent_path;
  select * into j from clued_private.storage_jobs_v1 where owner_id=c.owner_id and job_id=j.job_id for update;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=c.owner_id and profile_id=p.id for update;
  if m.id is null or policy.id is null or c.oauth_client_id<>app.oauth_client_id
    or p.root_folder_id<>root_key or j.connection_id<>c.id or j.authority_snapshot_v2 is null
    or m.writer_binding_id is distinct from j.cloud_writer_binding_id
    or m.exact_request->'mutation' is distinct from (j.mutation||jsonb_build_object('artifact_role','clued_resource'))
    or j.mutation->>'operation' is distinct from 'create'
    or j.request_digest is distinct from clued_private.m1_sha256(jsonb_build_object('connection_id',c.id,'mutation',j.mutation))
    or j.authority_snapshot_v2->>'owner_id' is distinct from c.owner_id::text
    or j.authority_snapshot_v2->>'connection_id' is distinct from c.id::text
    or j.authority_snapshot_v2->>'profile_id' is distinct from p.id::text
    or j.authority_snapshot_v2->>'profile_version' is distinct from m.profile_version::text
    or j.authority_snapshot_v2->>'binding_id' is distinct from j.binding_id::text
    or j.authority_snapshot_v2->>'authorization_version' is distinct from j.authorization_version::text
    or j.grant_receipt_id is distinct from policy.activation_receipt_id
    or j.authority_snapshot_v2->>'policy_receipt_id' is distinct from policy.activation_receipt_id::text
    or j.authority_snapshot_v2->>'consent_receipt_id' is distinct from policy.consent_receipt_id::text
    or not exists(select 1 from public.clued_audit_receipts where id=j.receipt_id and user_id=c.owner_id and binding_id=j.binding_id
      and status='committed' and operation='storage_job_submit' and received_payload_hash=j.request_digest
      and request_sha256=clued_private.m1_sha256(jsonb_build_object('operation','storage_job_submit','payload',
        jsonb_build_object('job_id',j.job_id,'request_digest',j.request_digest)))) then
    raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
  saved:=m.verified_result_v2;
  -- The original atomic begin always prepared at version 1 and started at 2.
  -- Preserve that exact durable admission receipt independently of m.receipt_id,
  -- which uncertain/finalize subsequently replace. Hashes below are checked
  -- internally only: authority_token_hash never enters this new audit payload.
  start_request:=jsonb_build_object('action','start','intent_id',m.id,'base_version',1,
    'request_sha256',m.request_sha256,'idempotency_key','account-job:'||j.job_id::text||':start',
    'profile_id',m.profile_id,'source_decision_id',m.source_decision_id,
    'authority_token_hash',m.authority_token_hash,'writer_binding_id',m.writer_binding_id);
  select * into start_receipt from public.clued_audit_receipts where user_id=c.owner_id
    and operation_family='resource_center_journal' and operation='resource_center_journal'
    and idempotency_key=start_request->>'idempotency_key' and owns_idempotency_key;
  if not found or start_receipt.status<>'committed' or start_receipt.binding_id is not null
    or start_receipt.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object(
      'operation','resource_center_journal','payload',start_request-'idempotency_key'))
    or start_receipt.received_payload_hash is distinct from clued_private.m1_sha256(start_request)
    or start_receipt.target_refs is distinct from jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id))
    or start_receipt.committed_versions is distinct from jsonb_build_object(m.id::text,2)
    or start_receipt.canonical_result is distinct from clued_private.m1_result_envelope(start_receipt)
    or start_receipt.response_hash is distinct from clued_private.m1_sha256(start_receipt.canonical_result)
    or (saved is not null and saved->>'start_receipt_id' is distinct from start_receipt.id::text)
    or (m.state='started' and (m.version<>2 or m.receipt_id is distinct from start_receipt.id)) then
    raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
  if saved is null and op='verified_record' then
    select * into audit from public.clued_audit_receipts where id=m.receipt_id and user_id=c.owner_id
      and operation='resource_center_journal' and status='committed';
    if not found or audit.target_refs is distinct from start_receipt.target_refs
      or audit.committed_versions is distinct from jsonb_build_object(m.id::text,m.version)
      or audit.canonical_result is distinct from clued_private.m1_result_envelope(audit)
      or audit.response_hash is distinct from clued_private.m1_sha256(audit.canonical_result) then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
  end if;
  if saved is not null and m.state='committed' then
    -- A concurrent active finalize is historical success only when its exact
    -- Artifact receipt registered the SAME persisted proof, not another version.
    registration_input:=jsonb_build_object('action','artifact_register','profile_id',p.id,'source_decision_id',m.source_decision_id,
      'idempotency_key','resource-center-finalize:'||m.id::text,'path',saved->'proof'->>'path',
      'provider_file_id',saved->'proof'->>'provider_file_id','provider_file_version',saved->'proof'->>'provider_file_version',
      'target_kind',m.authority_request->'mutation'->>'target_kind','governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false);
    if not exists(select 1 from public.clued_audit_receipts where id=(m.final_result->>'receipt_id')::uuid
      and user_id=c.owner_id and status='committed' and operation='resource_center_admin'
      and request_sha256=clued_private.m1_sha256(jsonb_build_object('operation','resource_center_admin','payload',registration_input-'idempotency_key'))
      and received_payload_hash=clued_private.m1_sha256(registration_input)) then
      raise exception 'storage_verified_conflict' using errcode='40001'; end if;
  end if;
  if op='verified_inspect' then
    if saved is not null and (saved->>'issuer_hash' is distinct from p_issuer_hash
      or m.verified_digest_v2 is distinct from clued_private.m1_sha256(saved)
      or not exists(select 1 from public.clued_audit_receipts where id=m.verified_receipt_id_v2 and user_id=c.owner_id
        and status='committed' and operation='storage_verified_record')) then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    if m.state='committed' and exists(select 1 from public.clued_audit_receipts where id=m.receipt_id and user_id=c.owner_id and status='committed') then
      return jsonb_build_object('status','committed','state','committed','connection_id',c.id,'job_id',j.job_id,'intent_id',m.id,'version',m.version,
        'request_sha256',m.request_sha256,'receipt_id',m.receipt_id,'final_result',m.final_result,'execution_permitted',false);
    elsif saved is not null then
      return jsonb_build_object('status','verified','connection_id',c.id,'job_id',j.job_id,'verified_receipt_id',m.verified_receipt_id_v2,'verified_digest',m.verified_digest_v2,
        'intent_id',m.id,'version',(saved->>'intent_version')::bigint,'request_sha256',m.request_sha256,'execution_permitted',false);
    else
      return jsonb_build_object('status','inspection_required','connection_id',c.id,'job_id',j.job_id,'intent_id',m.id,'execution_permitted',false);
    end if;
  end if;
  -- Exact record response recovery is metadata only, even if connection state
  -- changed after its commit. It never records late proof after final revoke.
  if op='verified_record' and saved is not null then
    if saved->>'issuer_hash' is distinct from p_issuer_hash or saved->>'record_input_digest' is distinct from input_digest
      or m.verified_digest_v2 is distinct from clued_private.m1_sha256(saved)
      or not exists(select 1 from public.clued_audit_receipts where id=m.verified_receipt_id_v2 and user_id=c.owner_id and status='committed' and operation='storage_verified_record') then
      raise exception 'storage_verified_conflict' using errcode='40001'; end if;
    return jsonb_build_object('status','verified','verified_receipt_id',m.verified_receipt_id_v2,'verified_digest',m.verified_digest_v2,
      'intent_id',m.id,'version',(saved->>'intent_version')::bigint,'execution_permitted',false);
  end if;
  if op='settle_verified' then
    if saved is null or saved->>'issuer_hash' is distinct from p_issuer_hash
      or m.verified_digest_v2 is distinct from clued_private.m1_sha256(saved)
      or (p_input is distinct from jsonb_build_object('action','settle_verified','connection_id',c.id,'job_id',j.job_id)
        and p_input is distinct from jsonb_build_object('action','settle_verified','connection_id',c.id,'job_id',j.job_id,
        'intent_id',m.id,'base_version',(saved->>'intent_version')::bigint,'request_sha256',m.request_sha256,
        'verified_receipt_id',m.verified_receipt_id_v2,'verified_digest',m.verified_digest_v2))
      or saved->'provider_attempt' is distinct from m.provider_attempt
      or saved->>'provider_attempt_receipt_id' is distinct from m.provider_attempt_receipt_id::text
      or saved->>'writer_binding_id' is distinct from m.writer_binding_id::text
      or saved->'authority_snapshot' is distinct from j.authority_snapshot_v2
      or saved->>'job_request_digest' is distinct from j.request_digest
      or saved->>'submit_receipt_id' is distinct from j.receipt_id::text
      or saved->>'exact_request_digest' is distinct from clued_private.m1_sha256(m.exact_request)
      or saved->>'authority_request_digest' is distinct from clued_private.m1_sha256(m.authority_request)
      or saved->'authority_result' is distinct from m.authority_result then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    select * into audit from public.clued_audit_receipts where id=m.verified_receipt_id_v2 and user_id=c.owner_id and status='committed' and operation='storage_verified_record';
    req:=jsonb_build_object('idempotency_key','storage-verified:'||m.id::text,'intent_id',m.id,'verified_digest',m.verified_digest_v2);
    if not found or audit.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_verified_record','payload',req-'idempotency_key'))
      or audit.received_payload_hash is distinct from clued_private.m1_sha256(req)
      or audit.response_hash is distinct from clued_private.m1_sha256(audit.canonical_result) then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    if m.state='committed' then
      if m.version<>(saved->>'intent_version')::bigint+1 or not exists(select 1 from public.clued_audit_receipts
        where id=m.receipt_id and user_id=c.owner_id and status='committed') then raise exception 'storage_verified_conflict' using errcode='40001'; end if;
      return clued_private.storage_job_status_v1(j)||jsonb_build_object('state','committed','version',m.version,
        'request_sha256',m.request_sha256,'final_result',m.final_result);
    end if;
    if m.version<>(saved->>'intent_version')::bigint or m.state not in ('started','uncertain') then raise exception 'storage_verified_conflict' using errcode='40001'; end if;
    proof:=saved->'proof'; finish:=saved->'finish';
    if ancestors is distinct from saved->'ancestors' then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  end if;
  -- No token/Binding is renewed for these checks; they describe the original
  -- still-current registry. A changed registry preserves unknown, not overwrite.
  if p.state<>'active' or p.version<>m.profile_version or parent.id is null or parent.target_kind<>'directory'
    or parent.provider_file_id is distinct from m.provider_attempt->>'parent_id'
    or parent.provider_file_version is distinct from m.authority_request->'provider_identity'->>'destination_parent_version'
    or not clued_private.resource_center_path_current_v1(c.owner_id,p.project_id,p.id,p.managed_root,parent_path)
    or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,m.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,(p.cloud_runtime->>'source_decision_id')::uuid)
    or not exists(select 1 from public.clued_memories where id=(p.cloud_runtime->>'source_decision_id')::uuid
      and version=(p.cloud_runtime->>'decision_version')::bigint)
    or not exists(select 1 from clued_private.resource_center_artifacts_v1 where profile_id=p.id and user_id=c.owner_id
      and path=p.managed_root and state='active' and target_kind='directory' and provider_file_id=p.root_folder_id
      and provider_file_version=m.authority_request->'provider_identity'->>'root_folder_version') then
    raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  select version into decision_version from public.clued_memories where id=parent.source_decision_id and user_id=c.owner_id;
  authority:=jsonb_build_object('status','resolved','authority',jsonb_build_object('artifact_id',null,
    'artifact_role','clued_resource','governance_class',parent.governance_class,'delete_authority',parent.delete_authority,
    'authority_version',parent.id::text||':'||parent.version::text||':'||decision_version::text,
    'currentness_identity','decision:'||parent.source_decision_id::text||':'||decision_version::text,
    'workspace_version',p.id::text||':'||p.version::text||':'||parent.version::text));
  if authority is distinct from m.authority_result then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  if op='verified_record' then
    if c.auth_mode<>'account_policy' or c.state not in ('active','reauthorization_required') or c.revoked_at is not null
      or policy.state<>'active' or policy.revoked_at is not null or c.account_policy_id<>policy.id
      or c.auth_generation::text is distinct from j.authority_snapshot_v2->>'auth_generation'
      or policy.policy_generation::text is distinct from j.authority_snapshot_v2->>'policy_generation'
      or policy.scope_digest is distinct from j.authority_snapshot_v2->>'scope_digest'
      or c.credential_version is distinct from (p_input->>'credential_version')::bigint
      or coalesce(policy.expires_at<=clock_timestamp(),false)
      or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,c.source_decision_id)
      or not clued_private.resource_center_decision_current_v1(c.owner_id,p.project_id,policy.source_decision_id)
      or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=c.owner_id and provider=c.provider
        and provider_subject=c.provider_subject and root_folder_id=root_key and lineage_id is null and denied) then
      raise exception 'storage_verified_denied' using errcode='42501'; end if;
    if m.state not in ('started','uncertain') or m.provider_attempt is null or m.provider_attempt_receipt_id is null
      or jsonb_typeof(finish) is distinct from 'object' or finish-array['action','intent_id','base_version','request_sha256','idempotency_key','postcondition']<>'{}'::jsonb
      or finish->>'action' is distinct from 'finalize' or finish->>'intent_id' is distinct from m.id::text
      or finish->>'base_version' is distinct from m.version::text or finish->>'request_sha256' is distinct from m.request_sha256
      or coalesce(length(finish->>'idempotency_key'),0) not between 1 and 160 then
      raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    attempt_expected:=jsonb_build_object('contract','clued.resource-center-provider-attempt/1','intent_id',m.id,
      'request_sha256',m.request_sha256,'profile_id',p.id,'provider_file_id',m.provider_attempt->>'provider_file_id',
      'destination_path',j.mutation->>'destination_path','parent_id',m.authority_request->'provider_identity'->>'destination_parent_id',
      'target_kind',j.mutation->>'target_kind','binding',m.exact_request->'binding',
      'size',case when j.mutation->>'target_kind'='file' then octet_length(j.mutation->>'content')::text end,
      'sha256',case when j.mutation->>'target_kind'='file' then encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);
    if m.provider_attempt is distinct from attempt_expected then raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    select * into audit from public.clued_audit_receipts where id=m.provider_attempt_receipt_id and user_id=c.owner_id and status='committed' and operation='storage_provider_attempt';
    req:=jsonb_build_object('idempotency_key','storage-provider-attempt:'||m.id::text,'intent_id',m.id,'attempt_digest',clued_private.m1_sha256(attempt_expected));
    if not found or audit.request_sha256 is distinct from clued_private.m1_sha256(jsonb_build_object('operation','storage_provider_attempt','payload',req-'idempotency_key'))
      or audit.received_payload_hash is distinct from clued_private.m1_sha256(req)
      or audit.response_hash is distinct from clued_private.m1_sha256(audit.canonical_result) then raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    post:=jsonb_build_object('path',attempt_expected->>'destination_path','parent_id',attempt_expected->>'parent_id',
      'provider_file_id',attempt_expected->>'provider_file_id','provider_file_version',proof->>'provider_file_version');
    expected:=post||jsonb_build_object('contract','clued.storage-create-verified/2','target_kind',j.mutation->>'target_kind',
      'size',attempt_expected->'size','sha256',attempt_expected->'sha256','provider_before',m.authority_request->'provider_identity',
      'checks',jsonb_build_object('identity',true,'content',true,'ancestors',true,'unique_name',true,'stable_version',true));
    if proof is distinct from expected or finish->'postcondition' is distinct from post
      or coalesce(proof->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$'
      or coalesce(proof->>'provider_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
    saved:=jsonb_build_object('contract','clued.storage-persisted-verification/2','issuer_hash',p_issuer_hash,
      'record_input_digest',input_digest,'recorded_at',clock_timestamp(),'owner_id',c.owner_id,'connection_id',c.id,'job_id',j.job_id,
      'job_request_digest',j.request_digest,'submit_receipt_id',j.receipt_id,'start_receipt_id',start_receipt.id,
      'intent_id',m.id,'intent_version',m.version,
      'request_sha256',m.request_sha256,'writer_binding_id',m.writer_binding_id,'provider_attempt',m.provider_attempt,
      'provider_attempt_receipt_id',m.provider_attempt_receipt_id,'authority_snapshot',j.authority_snapshot_v2,
      'exact_request_digest',clued_private.m1_sha256(m.exact_request),'authority_request_digest',clued_private.m1_sha256(m.authority_request),
      'authority_result',m.authority_result,'ancestors',ancestors,'proof',proof,'finish',finish);
    req:=jsonb_build_object('idempotency_key','storage-verified:'||m.id::text,'intent_id',m.id,'verified_digest',clued_private.m1_sha256(saved));
    r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_verified_record',req,clued_private.m1_sha256(req));
    if r.status<>'pending' then raise exception 'storage_verified_conflict' using errcode='40001'; end if;
    update clued_private.resource_center_mutations_v1 set verified_result_v2=saved,verified_receipt_id_v2=r.id,
      verified_digest_v2=clued_private.m1_sha256(saved) where id=m.id returning * into m;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
    ev:=clued_private.m1_append_event_row(c.owner_id,null,r.id,r.canonical_version,'extension:storage:verified_recorded',refs,
      'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
    if coalesce(policy.expires_at<=clock_timestamp(),false) then raise exception 'storage_verified_denied' using errcode='42501'; end if;
    return jsonb_build_object('status','verified','verified_receipt_id',r.id,'verified_digest',m.verified_digest_v2,
      'intent_id',m.id,'version',m.version,'execution_permitted',false);
  end if;
  -- All registration data comes from the immutable DB proof, never fresh
  -- caller postconditions. The original admin supplies its independent receipt.
  req:=jsonb_build_object('idempotency_key','storage-settle-verified:'||m.id::text,'intent_id',m.id,'verified_digest',m.verified_digest_v2);
  r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_verified_settle',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_verified_conflict' using errcode='40001'; end if;
  registration_input:=jsonb_build_object('action','artifact_register','profile_id',p.id,'source_decision_id',m.source_decision_id,
    'idempotency_key','resource-center-finalize:'||m.id::text,'path',proof->>'path','provider_file_id',proof->>'provider_file_id',
    'provider_file_version',proof->>'provider_file_version','target_kind',m.authority_request->'mutation'->>'target_kind',
    'governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false);
  registered:=public.clued_resource_center_admin_v1(c.owner_id,registration_input);
  if registered->>'status' is distinct from 'committed' then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  update clued_private.resource_center_mutations_v1 set state='committed',version=version+1,updated_at=clock_timestamp(),
    receipt_id=r.id,final_result=registered where id=m.id returning * into m;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
  ev:=clued_private.m1_append_event_row(c.owner_id,null,r.id,r.canonical_version,'extension:storage:verified_settled',refs,
    'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,jsonb_build_object(m.id::text,m.version),array[ev],'{}'::uuid[],null);
  return result||jsonb_build_object('state','committed','connection_id',c.id,'job_id',j.job_id,'intent_id',m.id,'version',m.version,'request_sha256',m.request_sha256,
    'execution_permitted',false,'final_result',registered);
end $$;

-- Only the fixed server-issuer router gets these actions. Browser/MCP jobs
-- remain submit/inspect; no generic service-role helper EXECUTE is granted.
alter function public.clued_storage_cloud_worker_router_v2(text,jsonb) set schema clued_private;
alter function clued_private.clued_storage_cloud_worker_router_v2(text,jsonb) rename to storage_cloud_execution_router_v2;
revoke all on function clued_private.storage_cloud_execution_router_v2(text,jsonb) from public,anon,authenticated,service_role;
create function public.clued_storage_cloud_worker_router_v2(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_input->>'action' in ('verified_record','verified_inspect','settle_verified') then
    return clued_private.storage_verified_result_v2(p_issuer_hash,p_input);
  end if;
  return clued_private.storage_cloud_execution_router_v2(p_issuer_hash,p_input);
end $$;
revoke all on function clued_private.storage_verified_result_v2(text,jsonb),clued_private.storage_verified_immutable_v2()
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_cloud_worker_router_v2(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_cloud_worker_router_v2(text,jsonb) to anon;
