-- Recovery may use a current read credential of the same Owner, Google
-- subject, OAuth client and immutable original root. It never revives the
-- original writer, policy generation or provider execution authorization.
create function clued_private.storage_recovery_client_guard_v1(p_connection uuid,p_job uuid) returns void
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;lineage uuid;
begin
 select * into j from clued_private.storage_jobs_v1 where connection_id=p_connection and job_id=p_job;
 lineage:=(j.authority_snapshot_v2->>'registration_lineage')::uuid;
 if j.owner_id is not null and lineage is not null then
  perform clued_private.storage_client_guard_v2(j.owner_id,lineage,false);
 end if;
end $$;
revoke all on function clued_private.storage_recovery_client_guard_v1(uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_recovery_client_input_guard_v1(p_input jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare connection_ref uuid;job_ref uuid;
begin
 -- Accept every UUID representation PostgreSQL accepts, so a casing or
 -- formatting variation cannot skip serialization. Invalid references go to
 -- the original entry's closed-code validation without exposing a cast error.
 begin
  connection_ref:=(p_input->>'connection_id')::uuid;job_ref:=(p_input->>'job_id')::uuid;
 exception when invalid_text_representation then return;
 end;
 perform clued_private.storage_recovery_client_guard_v1(connection_ref,job_ref);
end $$;
revoke all on function clued_private.storage_recovery_client_input_guard_v1(jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_recovery_reader_v1(
 p_issuer_identity text,p_original_connection uuid,p_job uuid,p_selected uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;original clued_private.storage_connections_v1;
 c clued_private.storage_connections_v1;p clued_private.resource_center_profiles_v1;
 m clued_private.resource_center_mutations_v1;q clued_private.storage_conflict_isolations_v1;
 policy clued_private.storage_account_policies_v2;root text;lineage uuid;reader jsonb;
begin
 perform clued_private.storage_recovery_client_guard_v1(p_original_connection,p_job);
 select * into j from clued_private.storage_jobs_v1 where connection_id=p_original_connection and job_id=p_job;
 if j.job_id is null then raise exception 'storage_recovery_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('storage-job:'||j.owner_id::text||':'||j.job_id::text,0));
 perform clued_private.authorization_account_v12(j.owner_id);
 select * into original from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=j.owner_id;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id;
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=m.id and user_id=j.owner_id;
 root:=coalesce(q.root_folder_id,j.authority_snapshot_v2->>'root_folder_id',m.authority_request->'provider_identity'->>'root_folder_id');
 if root is null or original.id is null or original.provider<>'google-drive' or original.provider_subject is null
 or original.oauth_client_id is null or m.profile_id is distinct from original.profile_id
 or (q.intent_id is not null and (q.provider is distinct from original.provider
  or q.provider_subject is distinct from original.provider_subject or q.oauth_client_id is distinct from original.oauth_client_id)) then
  raise exception 'storage_recovery_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||':'||root,0));
 select * into p from clued_private.resource_center_profiles_v1 where id=m.profile_id and user_id=j.owner_id for share;
 if p.id is null or p.state<>'active' or p.root_folder_id is distinct from root or p.version<>m.profile_version
 or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,p.source_decision_id)
 or not exists(select 1 from clued_private.storage_oauth_apps_v1 app where app.issuer_hash=p_issuer_identity
  and app.revoked_at is null and app.oauth_client_id=original.oauth_client_id) then
  raise exception 'storage_recovery_denied' using errcode='42501';end if;
 -- The live-profile unique index makes this choice unambiguous. Never borrow
 -- another profile, subject, client, root or Owner merely because GET succeeds.
 select * into c from clued_private.storage_connections_v1 where owner_id=j.owner_id and profile_id=p.id
  and provider=original.provider and provider_subject=original.provider_subject and oauth_client_id=original.oauth_client_id
  and state='active' and revoked_at is null and (p_selected is null or id=p_selected) for share;
 if c.id is null or c.auth_mode<>'account_policy' or c.profile_version<>p.version or c.credential_version<1
 or c.provider_scope_profile not in ('legacy','normal','full') or not clued_private.storage_envelope_valid_v1(c.credential_envelope)
 or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,c.source_decision_id) then
  raise exception 'storage_recovery_denied' using errcode='42501';end if;
 select * into policy from clued_private.storage_account_policies_v2 where id=c.account_policy_id
  and connection_id=c.id and owner_id=j.owner_id for share;
 if policy.id is null or policy.state<>'active' or policy.revoked_at is not null
 or coalesce(policy.expires_at<=clock_timestamp(),false) or policy.profile_id<>p.id or policy.root_folder_id<>root
 or policy.provider is distinct from original.provider or policy.provider_subject is distinct from original.provider_subject
 or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,policy.source_decision_id) then
  raise exception 'storage_recovery_denied' using errcode='42501';end if;
 lineage:=(j.authority_snapshot_v2->>'registration_lineage')::uuid;
 if exists(select 1 from clued_private.storage_client_denies_v2 d where d.owner_id=j.owner_id and d.lineage_id=lineage and d.denied)
 or exists(select 1 from clued_private.storage_read_client_denies_v1 d where d.owner_id=j.owner_id
  and d.lineage_id=lineage and d.class='read' and d.denied)
 or exists(select 1 from clued_private.storage_root_denies_v2 d where d.owner_id=j.owner_id and d.provider=original.provider
  and d.provider_subject=original.provider_subject and d.root_folder_id=root and (d.lineage_id is null or d.lineage_id=lineage) and d.denied) then
  raise exception 'storage_recovery_denied' using errcode='42501';end if;
 reader:=jsonb_build_object('contract','clued.storage-recovery-reader/1','connection_id',c.id,'connection_version',c.version,
  'credential_version',c.credential_version,'auth_generation',c.auth_generation,'policy_id',policy.id,
  'policy_generation',policy.policy_generation,'scope_digest',policy.scope_digest,'profile_version',p.version);
 return jsonb_build_object('recovery_reader',reader,'credential_version',c.credential_version,'credential_envelope',c.credential_envelope);
end $$;
revoke all on function clued_private.storage_recovery_reader_v1(text,uuid,uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Native listing is an MVCC eligibility projection, not an execution/settlement
-- transaction. It must never keep job A's root lock while inspecting job B.
-- Actual load and settlement still use the fully locked reader above.
do $snapshot$
declare body text;anchor text;expected integer;
begin
 body:=pg_get_functiondef('clued_private.storage_recovery_reader_v1(text,uuid,uuid,uuid)'::regprocedure);
 body:=replace(body,'FUNCTION clued_private.storage_recovery_reader_v1(',
  'FUNCTION clued_private.storage_recovery_reader_snapshot_v1(');
 foreach anchor in array array[
  ' perform clued_private.storage_recovery_client_guard_v1(p_original_connection,p_job);',
  ' perform pg_advisory_xact_lock(hashtextextended(''storage-job:''||j.owner_id::text||'':''||j.job_id::text,0));',
  ' perform pg_advisory_xact_lock(hashtextextended(j.owner_id::text||'':''||root,0));',
  ' perform clued_private.authorization_account_v12(j.owner_id);'] loop
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_snapshot_source_mismatch';end if;
  body:=replace(body,anchor,'');
 end loop;
 anchor:=' for share';expected:=(length(body)-length(replace(body,anchor,'')))/length(anchor);
 if expected<>3 then raise exception 'storage_reader_snapshot_row_locks_mismatch';end if;
 body:=replace(body,anchor,'');execute body;
end $snapshot$;
revoke all on function clued_private.storage_recovery_reader_snapshot_v1(text,uuid,uuid,uuid)
 from public,anon,authenticated,service_role,clued_worker_gateway;

create function clued_private.storage_recovery_reader_assert_v1(p_issuer_identity text,p_input jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare current_reader jsonb;
begin
 if jsonb_typeof(p_input->'recovery_reader') is distinct from 'object' then
  raise exception 'storage_recovery_denied' using errcode='42501';end if;
 current_reader:=clued_private.storage_recovery_reader_v1(p_issuer_identity,(p_input->>'connection_id')::uuid,
  (p_input->>'job_id')::uuid,(p_input->'recovery_reader'->>'connection_id')::uuid);
 if current_reader->'recovery_reader' is distinct from p_input->'recovery_reader'
 or current_reader->>'credential_version' is distinct from p_input->>'credential_version' then
  raise exception 'storage_recovery_reader_changed' using errcode='40001';end if;
end $$;
revoke all on function clued_private.storage_recovery_reader_assert_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

do $clone$ declare body text;begin
 body:=pg_get_functiondef('clued_private.storage_conflict_load_v1(text,jsonb)'::regprocedure);
 execute replace(body,'FUNCTION clued_private.storage_conflict_load_v1(',
  'FUNCTION clued_private.storage_conflict_load_before_reader_v1(');
end $clone$;
create or replace function clued_private.storage_conflict_load_v1(p_issuer_identity text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1;m clued_private.resource_center_mutations_v1;
 q clued_private.storage_conflict_isolations_v1;p clued_private.resource_center_profiles_v1;
 original clued_private.storage_connections_v1;credential jsonb;result jsonb;
begin
 begin
  return clued_private.storage_conflict_load_before_reader_v1(p_issuer_identity,p_input);
 exception when insufficient_privilege then
  -- The fallback supplies a new current read authority. Historical admission,
  -- original attempt identity, complete isolation and journal CAS stay pinned.
  credential:=clued_private.storage_recovery_reader_v1(p_issuer_identity,(p_input->>'connection_id')::uuid,(p_input->>'job_id')::uuid);
 end;
 select * into j from clued_private.storage_jobs_v1 where connection_id=(p_input->>'connection_id')::uuid and job_id=(p_input->>'job_id')::uuid;
 select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=j.owner_id for share;
 select * into q from clued_private.storage_conflict_isolations_v1 where intent_id=m.id and user_id=j.owner_id for share;
 select * into p from clued_private.resource_center_profiles_v1 where id=m.profile_id and user_id=j.owner_id for share;
 select * into original from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=j.owner_id;
 if m.state<>'conflict' or q.state<>'active' or not q.scope_complete or q.job_id is distinct from j.job_id
 or q.connection_id is distinct from j.connection_id or m.provider_attempt is null or m.provider_attempt_receipt_id is null
 or j.cloud_writer_binding_id is null or m.writer_binding_id is distinct from j.cloud_writer_binding_id then
  raise exception 'storage_recovery_denied' using errcode='42501';end if;
 result:=jsonb_build_object('status','recovery_only','owner_id',j.owner_id,'connection_id',j.connection_id,'job_id',j.job_id,
  'provider',q.provider,'provider_subject',q.provider_subject,'oauth_client_id',q.oauth_client_id,
  'profile',jsonb_build_object('managed_root',p.managed_root),'root_folder_id',q.root_folder_id,'root_parent_id',p.root_parent_id,
  'mutation',m.exact_request->'mutation','provider_before',m.authority_request->'provider_identity','attempt',m.provider_attempt,
  'intent_id',m.id,'version',m.version,'request_sha256',m.request_sha256)||credential;
 if clued_private.storage_automatic_reconcile_candidate_v1(j) then
  result:=result||jsonb_build_object('conflict_reconcile',jsonb_build_object('source_receipt_id',q.close_receipt_id,'closed_version',q.closed_version));end if;
 return result;
end $$;
revoke all on function clued_private.storage_conflict_load_before_reader_v1(text,jsonb)
 from public,anon,authenticated,service_role,clued_worker_gateway;

-- Keep every historical admission, typed postcondition, receipt, registry and
-- I11 check of the original verifiers. Only the current read-credential check
-- gets a separately authenticated replacement; its exact identity is persisted
-- inside the immutable verified proof and its digest.
do $verified$
declare sig text;body text;anchor text;replacement text;guard_start integer;guard_end integer;
begin
 foreach sig in array array['clued_private.storage_verified_before_conflict_v1(text,jsonb)',
  'clued_private.storage_conflict_verified_v1(text,jsonb)'] loop
  body:=pg_get_functiondef(sig::regprocedure);
  anchor:=$a$array['action','connection_id','job_id','credential_version','finish','proof']$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_verifier_keys_mismatch';end if;
  body:=replace(body,anchor,$r$array['action','connection_id','job_id','credential_version','finish','proof','recovery_reader']$r$);
  anchor:=$a$    if c.auth_mode<>'account_policy' or c.state not in ('active','reauthorization_required') or c.revoked_at is not null$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_verifier_guard_mismatch';end if;
  guard_start:=position(anchor in body);
  -- End at the next typed-verifier block, not at a formatting-dependent
  -- one-line RAISE: a later expiry check uses the same error code.
  guard_end:=strpos(substr(body,guard_start),'    if m.state not in (');
  if guard_end=0 then raise exception 'storage_reader_verifier_guard_end_missing';end if;
  anchor:=substr(body,guard_start,guard_end-1);
  if position('attempt_expected' in anchor)>0 or position('saved:=' in anchor)>0
   or position('storage_verified_denied' in anchor)=0 then raise exception 'storage_reader_verifier_guard_too_broad';end if;
  replacement:=$r$    if p_input ? 'recovery_reader' then
      perform clued_private.storage_recovery_reader_assert_v1(p_issuer_identity,p_input);
    else
$r$||anchor||$r$
    end if;$r$;
  body:=replace(body,anchor,replacement);
  anchor:=$a$'authority_result',m.authority_result,'ancestors',ancestors,'proof',proof,'finish',finish);$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_verifier_saved_mismatch';end if;
  body:=replace(body,anchor,anchor||$r$
    if p_input ? 'recovery_reader' then saved:=saved||jsonb_build_object('recovery_reader',p_input->'recovery_reader');end if;$r$);
  anchor:=$a$    if coalesce(policy.expires_at<=clock_timestamp(),false) then raise exception 'storage_verified_denied' using errcode='42501'; end if;$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_verifier_expiry_mismatch';end if;
  body:=replace(body,anchor,$r$    if p_input ? 'recovery_reader' then
      perform clued_private.storage_recovery_reader_assert_v1(p_issuer_identity,p_input);
    else
$r$||anchor||$r$
    end if;$r$);
  execute body;
 end loop;
end $verified$;

do $semantic$
declare body text;anchor text;
begin
 body:=pg_get_functiondef('clued_private.storage_semantic_settle_v1(text,jsonb)'::regprocedure);
 anchor:=$a$array['action','connection_id','job_id','intent_id','base_version','request_sha256','credential_version','observation','absence_proof','revision_observation']$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_semantic_keys_mismatch';end if;
 body:=replace(body,anchor,$r$array['action','connection_id','job_id','intent_id','base_version','request_sha256','credential_version','observation','absence_proof','revision_observation','recovery_reader']$r$);
 anchor:=$a$ or d->>'oauth_client_id' is distinct from s.oauth_client_id or d->>'credential_version' is distinct from i->>'credential_version'$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_semantic_context_mismatch';end if;
 body:=replace(body,anchor,anchor||$r$
 or coalesce(d->'recovery_reader','null'::jsonb) is distinct from coalesce(i->'recovery_reader','null'::jsonb)$r$);
 anchor:=$a$ r:=clued_private.m1_begin_receipt(j.owner_id,null,operation,req,clued_private.m1_sha256(req));$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_semantic_receipt_mismatch';end if;
 body:=replace(body,anchor,$r$ req:=req||jsonb_build_object('credential_version',d->'credential_version')||
  case when d ? 'recovery_reader' then jsonb_build_object('recovery_reader',d->'recovery_reader') else '{}'::jsonb end;
$r$||anchor);
 execute body;
end $semantic$;

do $automatic$
declare body text;anchor text;prefix text;finish integer;
begin
 body:=pg_get_functiondef('clued_private.storage_automatic_reconcile_v1(text,jsonb)'::regprocedure);
 anchor:=$a$array['action','connection_id','job_id','base_version','source_receipt_id','credential_version','first_observation','second_observation']$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_automatic_keys_mismatch';end if;
 body:=replace(body,anchor,$r$array['action','connection_id','job_id','base_version','source_receipt_id','credential_version','first_observation','second_observation','recovery_reader']$r$);
 anchor:=$a$ if descriptor->>'credential_version' is distinct from p_input->>'credential_version' then$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_automatic_descriptor_mismatch';end if;
 body:=replace(body,anchor,$r$ if descriptor->>'credential_version' is distinct from p_input->>'credential_version'
 or coalesce(descriptor->'recovery_reader','null'::jsonb) is distinct from coalesce(p_input->'recovery_reader','null'::jsonb) then$r$);
 anchor:=$a$ if c.state<>'active' or c.revoked_at is not null or policy.state<>'active' or policy.revoked_at is not null$a$;
 prefix:=substr(body,position(anchor in body));finish:=position($a$  or p.state<>'active'$a$ in prefix);
 if position(anchor in body)=0 or finish=0 then raise exception 'storage_reader_automatic_guard_mismatch';end if;
 anchor:=left(prefix,finish-1);
 body:=replace(body,anchor,$r$ if p_input ? 'recovery_reader' then
  perform clued_private.storage_recovery_reader_assert_v1(p_issuer_identity,p_input);end if;
 if (not(p_input ? 'recovery_reader') and ($r$||substr(anchor,5)||$r$))
$r$);
 foreach anchor in array array[
  $a$  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,c.source_decision_id)$a$,
  $a$  or not clued_private.resource_center_decision_current_v1(j.owner_id,p.project_id,policy.source_decision_id)$a$] loop
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_automatic_decision_mismatch';end if;
  body:=replace(body,anchor,$r$  or (not(p_input ? 'recovery_reader') and $r$||substr(anchor,6)||')');
 end loop;
 anchor:=$a$'observation',second-'boundary_status'));$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_automatic_observe_mismatch';end if;
 body:=replace(body,anchor,$r$'observation',second-'boundary_status')||
  case when p_input ? 'recovery_reader' then jsonb_build_object('recovery_reader',p_input->'recovery_reader') else '{}'::jsonb end);$r$);
 anchor:=$a$'observation_id',observation.id,'credential_version',c.credential_version,'reason_code','CURRENT_BASELINE_RECONCILED');$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_automatic_receipt_mismatch';end if;
 body:=replace(body,anchor,$r$'observation_id',observation.id,'credential_version',descriptor->'credential_version','reason_code','CURRENT_BASELINE_RECONCILED')||
  case when p_input ? 'recovery_reader' then jsonb_build_object('recovery_reader',p_input->'recovery_reader') else '{}'::jsonb end;$r$);
 execute body;
end $automatic$;

alter table clued_private.storage_conflict_observations_v1 add column recovery_reader jsonb;
do $review$
declare sig text;body text;anchor text;
begin
 foreach sig in array array['clued_private.storage_conflict_observe_v1(text,jsonb)',
  'clued_private.storage_conflict_revalidate_v1(text,jsonb)'] loop
  body:=pg_get_functiondef(sig::regprocedure);
  anchor:=case when sig like '%observe_v1%' then
   $a$array['action','connection_id','job_id','base_version','source_receipt_id','observation']$a$ else
   $a$array['action','connection_id','job_id','base_version','source_receipt_id','observation_id','observation']$a$ end;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_review_keys_mismatch';end if;
  body:=replace(body,anchor,left(anchor,length(anchor)-1)||$r$,'recovery_reader']$r$);
  anchor:=$a$ descriptor:=clued_private.storage_conflict_load_v1(p_issuer_identity,p_input);$a$;
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_review_descriptor_mismatch';end if;
  body:=replace(body,anchor,anchor||$r$
 if coalesce(descriptor->'recovery_reader','null'::jsonb) is distinct from coalesce(p_input->'recovery_reader','null'::jsonb) then
  raise exception 'storage_recovery_reader_changed' using errcode='40001';end if;
 if p_input ? 'recovery_reader' then
  perform clued_private.storage_recovery_reader_assert_v1(p_issuer_identity,p_input||jsonb_build_object('credential_version',descriptor->'credential_version'));end if;$r$);
  if sig like '%observe_v1%' then
   anchor:=$a$observed_at,expires_at)$a$;
   if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_review_columns_mismatch';end if;
   body:=replace(body,anchor,$r$observed_at,expires_at,recovery_reader)$r$);
   anchor:=$a$observed,observed+interval '5 minutes') returning id into observation_id;$a$;
   if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_review_insert_mismatch';end if;
   body:=replace(body,anchor,$r$observed,observed+interval '5 minutes',p_input->'recovery_reader') returning id into observation_id;$r$);
  else
   anchor:=$a$ select * into m from clued_private.resource_center_mutations_v1 where id=o.intent_id for share;$a$;
   if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_review_saved_mismatch';end if;
   body:=replace(body,anchor,$r$ if coalesce(o.recovery_reader,'null'::jsonb) is distinct from coalesce(p_input->'recovery_reader','null'::jsonb) then
  raise exception 'storage_recovery_reader_changed' using errcode='40001';end if;
$r$||anchor);
  end if;
  execute body;
 end loop;
end $review$;

-- Every externally reachable recovery/verification transaction enters the
-- original lineage shared guard before any job/root lock. Owner client/read
-- denies take the matching exclusive guard, so a committed denial cannot be
-- overtaken by a previously checked but not yet committed recovery result.
-- A sweep may have processed earlier roots/jobs in the same transaction.
-- Its candidate never waits for a new client/job/root execution lock: skip a
-- busy candidate and let the next bounded scan retry it, retaining all truth.
do $scan_locks$
declare body text;anchor text;
begin
 body:=pg_get_functiondef('clued_private.storage_conflict_close_candidate_v1(uuid)'::regprocedure);
 anchor:=$a$ if j.job_id is not null then perform pg_advisory_xact_lock(hashtextextended('storage-job:'||m.user_id::text||':'||j.job_id::text,0)); end if;$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_scan_job_lock_mismatch';end if;
 body:=replace(body,anchor,$r$ if j.job_id is not null then
  if j.authority_snapshot_v2->>'registration_lineage' is not null and not pg_try_advisory_xact_lock_shared(
   hashtextextended('storage-client:'||m.user_id::text||':'||(j.authority_snapshot_v2->>'registration_lineage'),0)) then return 'not_due';end if;
  if not pg_try_advisory_xact_lock(hashtextextended('storage-job:'||m.user_id::text||':'||j.job_id::text,0)) then return 'not_due';end if;
 end if;$r$);
 anchor:=$a$ perform pg_advisory_xact_lock(hashtextextended(m.user_id::text||':'||p.root_folder_id,0));$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_scan_root_lock_mismatch';end if;
 body:=replace(body,anchor,$r$ if not pg_try_advisory_xact_lock(hashtextextended(m.user_id::text||':'||p.root_folder_id,0)) then return 'not_due';end if;$r$);
 anchor:=$a$   perform pg_advisory_xact_lock(hashtextextended('storage-object:'||identity,0));$a$;
 if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'storage_reader_scan_object_lock_mismatch';end if;
 body:=replace(body,anchor,$r$   if not pg_try_advisory_xact_lock(hashtextextended('storage-object:'||identity,0)) then
    -- The candidate Receipt has already begun: throw so the statement/sweep
    -- subtransaction rolls it back, rather than returning a pending receipt.
    raise exception 'storage_conflict_candidate_busy' using errcode='55P03';end if;$r$);
 execute body;
end $scan_locks$;

do $guards$
declare target record;body text;at integer;statement text;
begin
 for target in select * from (values
  ('clued_private.storage_conflict_load_v1(text,jsonb)','p_input'),
  ('clued_private.storage_verified_before_conflict_v1(text,jsonb)','p_input'),
  ('clued_private.storage_conflict_verified_v1(text,jsonb)','p_input'),
  ('clued_private.storage_semantic_settle_v1(text,jsonb)','i'),
  ('clued_private.storage_automatic_reconcile_v1(text,jsonb)','p_input'),
  ('clued_private.ii_priv_storage_verified_result_v2(text,jsonb)','p_input'),
  ('clued_private.ii_pub_clued_storage_scheduled_recovery_v2(text,jsonb)','p_input'),
  ('clued_private.ii_pub_clued_storage_native_recovery_v1(text,jsonb)','p_input'),
  ('clued_private.ii_pub_clued_storage_cloud_worker_router_v2(text,jsonb)','p_input'),
  ('public.clued_storage_native_recovery_load_v2(text,jsonb)','p_input')
 ) signatures(signature,input_name) loop
  body:=pg_get_functiondef(target.signature::regprocedure);
  at:=strpos(body,E'\nbegin\n');
  if at=0 then raise exception 'storage_reader_guard_entry_mismatch: %',target.signature;end if;
  statement:=format(E' perform clued_private.storage_recovery_client_input_guard_v1(%I);\n',target.input_name);
  body:=overlay(body placing E'\nbegin\n'||statement from at for length(E'\nbegin\n'));
  execute body;
 end loop;
end $guards$;

notify pgrst,'reload schema';
