-- Storage fix (Owner Decision d9d6db4c, Task 0ea9a51c): a started journal that
-- never recorded its provider attempt is released instead of fencing the root.
--
-- The P6.2 production acceptance (Note 77019762) found a directory move whose
-- pre-effect provider identity read failed in transit: the journal stayed
-- 'started' with no provider attempt, Drive was never changed, and the single
-- writer then refused every later write on that root (and the Owner's level
-- switch) until an administrative no-effect settlement.
--
-- Every account-policy cloud effect (create, binary create, rename and move,
-- replace, trash and untrash, directory move) records its exact provider
-- attempt (storage_job_provider_attempt_v2) before its first Drive write, and
-- that call requires the journal, locked for update, to be 'started'. A journal
-- with no attempt has therefore never reached Drive, and once it is cancelled no
-- attempt can be recorded for it, so no Drive write can follow.
--
-- * public.clued_storage_release_unattempted_v1 (the fixed connector issuer,
--   called by the Worker's scheduled run): cancels at most 3 such journals of
--   account-policy cloud jobs whose admission expired at least 60 seconds ago,
--   each under the job and root locks with its own Receipt and Event, with
--   final_result {outcome: released_unattempted, reason_code:
--   NO_PROVIDER_ATTEMPT}. A journal with an attempt, a verified record or a
--   live admission is never touched. Each candidate runs in its own
--   subtransaction with a short lock timeout: one that fails is skipped and
--   rolled back alone, and at most 10 candidates are looked at per call.
-- * clued_private.storage_job_status_v1: a cancelled job names that reason code.

create function public.clued_storage_release_unattempted_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; cand record;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  j clued_private.storage_jobs_v1; m clued_private.resource_center_mutations_v1;
  r public.clued_audit_receipts; req jsonb; refs jsonb; ev text; released int:=0;
begin
  if coalesce(p_issuer_hash,'') !~ '^[0-9a-f]{64}$' or p_input is distinct from jsonb_build_object('action','release') then
    raise exception 'storage_release_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1
    where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_release_denied' using errcode='42501'; end if;
  perform pg_catalog.set_config('lock_timeout','2s',true);
  for cand in
    select j0.owner_id,j0.job_id,j0.connection_id from clued_private.storage_jobs_v1 j0
    join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
    join clued_private.resource_center_mutations_v1 m0 on m0.id=j0.intent_id and m0.user_id=j0.owner_id
    where c0.oauth_client_id=app.oauth_client_id and c0.auth_mode='account_policy'
      and j0.authority_snapshot_v2 is not null and m0.state in ('started','uncertain')
      and m0.provider_attempt is null and m0.provider_attempt_receipt_id is null and m0.verified_result_v2 is null
      and m0.writer_binding_id is not distinct from j0.cloud_writer_binding_id
      and m0.expires_at<clock_timestamp()-interval '60 seconds'
    order by m0.expires_at,j0.job_id limit 10
  loop
    exit when released>=3;
    begin
    -- The same lock order as the attempt record: job, root, then the rows.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||cand.owner_id::text||':'||cand.job_id::text,0));
    select * into c from clued_private.storage_connections_v1 where id=cand.connection_id and owner_id=cand.owner_id;
    select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=cand.owner_id;
    if p.id is null then continue; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(cand.owner_id::text||':'||p.root_folder_id,0));
    select * into c from clued_private.storage_connections_v1 where id=cand.connection_id and owner_id=cand.owner_id for share;
    select * into j from clued_private.storage_jobs_v1 where owner_id=cand.owner_id and job_id=cand.job_id for update;
    select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=cand.owner_id for update;
    if m.id is null or m.profile_id is distinct from p.id or m.state not in ('started','uncertain') or m.provider_attempt is not null
      or m.provider_attempt_receipt_id is not null or m.verified_result_v2 is not null
      or m.writer_binding_id is distinct from j.cloud_writer_binding_id
      or m.expires_at>=clock_timestamp()-interval '60 seconds' then continue; end if;
    req:=jsonb_build_object('idempotency_key','storage-unattempted-release:'||m.id::text,
      'intent_id',m.id,'job_id',j.job_id,'base_version',m.version);
    r:=clued_private.m1_begin_receipt(cand.owner_id,null,'storage_unattempted_release',req,clued_private.m1_sha256(req));
    if r.status<>'pending' then raise exception 'storage_release_receipt_conflict' using errcode='40001'; end if;
    update clued_private.resource_center_mutations_v1 set state='cancelled',version=version+1,updated_at=now(),
      receipt_id=r.id,final_result=jsonb_build_object('outcome','released_unattempted','reason_code','NO_PROVIDER_ATTEMPT')
      where id=m.id;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
    ev:=clued_private.m1_append_event_row(cand.owner_id,null,r.id,r.canonical_version,'extension:storage:unattempted_released',
      refs,'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,
      'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
    released:=released+1;
    exception when others then
      -- This candidate is rolled back alone (locks included) and left as it was.
      null;
    end;
  end loop;
  return jsonb_build_object('status','ok','released',released);
end $$;
revoke all on function public.clued_storage_release_unattempted_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_release_unattempted_v1(text,jsonb) to anon;

-- A cancelled job names its fixed reason code (anchored patch, exact hit count).
do $migration$
declare body text; hits int;
  anchor text:=$a$      then jsonb_build_object('reason_code',p_job.dispatch_outcome->'reason'->>'code') else '{}'::jsonb end$a$;
  replacement text:=$r$      then jsonb_build_object('reason_code',p_job.dispatch_outcome->'reason'->>'code') else '{}'::jsonb end
    ||case when m.state='cancelled' and coalesce(m.final_result->>'reason_code','') ~ '^[A-Z][A-Z0-9_]{2,63}$'
      then jsonb_build_object('reason_code',m.final_result->>'reason_code') else '{}'::jsonb end$r$;
begin
  body:=pg_get_functiondef('clued_private.storage_job_status_v1(clued_private.storage_jobs_v1)'::regprocedure);
  hits:=(length(body)-length(replace(body,anchor,'')))/length(anchor);
  if hits<>1 then
    raise exception 'storage_release_unattempted_definition_mismatch: storage_job_status_v1 (% of 1)',hits;
  end if;
  execute replace(body,anchor,replacement);
end $migration$;
