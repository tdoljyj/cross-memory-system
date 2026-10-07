-- BUG-20261008-001 (Clued Task f7a4dd7d): a queued storage job is dispatched
-- once, and a dispatch whose load the database refuses leaves no trace.
--
-- On 2026-10-07 four text creates submitted while their root was fenced by an
-- unsettled binary job (BUG-20261007-005) stayed queued for more than six
-- hours: the submit queued them, the one dispatch after submit was refused at
-- load (storage_root_has_unresolved_mutation), the Worker reports a dispatch
-- outcome only after a successful load, and nothing lists a queued job again
-- (scheduled recovery wants a journal with an attempt, the unattempted release
-- wants a started journal, the staging sweep wants a binary job). Identical
-- jobs submitted after the root was settled ran within 90 seconds.
--
-- * clued_private.storage_jobs_v1 counts the scheduled redispatches of a job
--   (redispatch_attempts, redispatch_at); the Worker's first dispatch after
--   submit is not counted.
-- * public.clued_storage_queued_sweep_v1 (the fixed connector issuer, called by
--   the Worker's scheduled run every minute, {action: due, dispatch: bool}):
--   1. settles at most 3 text jobs that are still queued (no intent, no dispatch
--      outcome) 2 hours after submit as attention_required with the fixed
--      reason DISPATCH_NOT_STARTED, through the same Receipt operation and
--      idempotency key the executor's own report uses
--      (storage_dispatch_outcome, cloud-dispatch-outcome:<job>), so a late
--      report and this settlement cannot both commit; load then answers the
--      job's status and never executes it. A binary job keeps its own 12-hour
--      cancellation (20260930180000, staging_expired) and is not settled here.
--   2. with dispatch true, lists at most 3 queued jobs of active account-policy
--      connections of an execution-enabled issuer whose root has no unresolved
--      journal, 90 seconds after submit and then with backoff (2, 4, 8 ...
--      minutes, at most 60) counted on the job; a job on a fenced root is
--      counted as root_busy and not listed. The Worker dispatches each listed
--      job exactly as after submit (queue consumer or in place).
-- * clued_private.storage_root_stuck_v1: a root whose unresolved journal
--   outlived its admission by 60 seconds (the unattempted release's threshold)
--   is stuck, not busy. storage_jobs_policy_core_v2 refuses a submit on such a
--   root before any Receipt or job with the structured rejection
--   {status: rejected, error_code: storage_root_busy}; a submit while a job is
--   merely running still queues, and the sweep dispatches it once the root is
--   quiet.
-- * clued_private.storage_job_status_v1 already names the reason code of a
--   pre-reservation outcome; the inspect tool adds a fixed hint.

alter table clued_private.storage_jobs_v1
  add column redispatch_attempts integer not null default 0 check(redispatch_attempts between 0 and 1000000),
  add column redispatch_at timestamptz;

-- An unresolved journal on the root whose admission expired at least 60 s ago.
create function clued_private.storage_root_stuck_v1(p_owner uuid,p_root text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.resource_center_mutations_v1 m
    join clued_private.resource_center_profiles_v1 p on p.id=m.profile_id
    where m.user_id=p_owner and p.root_folder_id=p_root and m.state in ('prepared','started','uncertain')
      and m.expires_at<clock_timestamp()-interval '60 seconds')
$$;
revoke all on function clued_private.storage_root_stuck_v1(uuid,text) from public,anon,authenticated,service_role;

-- A text job still queued 2 hours after submit is settled as attention_required
-- (reason DISPATCH_NOT_STARTED): the same locks, Receipt, row update and Event
-- as the executor's report and the binary staging cancellation.
create function clued_private.storage_queued_timeout_v1(p_owner uuid,p_job uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare j clued_private.storage_jobs_v1; p clued_private.resource_center_profiles_v1; root text;
  r public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
begin
  select pr.root_folder_id into root from clued_private.storage_jobs_v1 j0
    join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
    join clued_private.resource_center_profiles_v1 pr on pr.id=c0.profile_id and pr.user_id=j0.owner_id
    where j0.owner_id=p_owner and j0.job_id=p_job;
  if root is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||p_owner::text||':'||p_job::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text||':'||root,0));
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job for update;
  if j.job_id is null or j.mutation ? 'content_ref' or j.intent_id is not null or j.dispatch_outcome is not null
    or j.authority_snapshot_v2 is null or j.created_at>clock_timestamp()-interval '2 hours' then return false; end if;
  select pr.* into p from clued_private.storage_connections_v1 c0
    join clued_private.resource_center_profiles_v1 pr on pr.id=c0.profile_id and pr.user_id=c0.owner_id where c0.id=j.connection_id;
  req:=jsonb_build_object('idempotency_key','cloud-dispatch-outcome:'||j.job_id::text,'job_id',j.job_id,
    'outcome',jsonb_build_object('status','attention_required','reason',jsonb_build_object('code','DISPATCH_NOT_STARTED')));
  if not clued_private.storage_dispatch_outcome_valid_v1(req->'outcome') then return false; end if;
  r:=clued_private.m1_begin_receipt(p_owner,null,'storage_dispatch_outcome',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then return false; end if;
  update clued_private.storage_jobs_v1 set dispatch_outcome=req->'outcome',dispatch_outcome_receipt_id=r.id
    where owner_id=p_owner and job_id=j.job_id;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',j.job_id));
  ev:=clued_private.m1_append_event_row(p_owner,null,r.id,r.canonical_version,'extension:storage:dispatch_outcome',
    refs,'project:'||p.project_id::text,null,req||jsonb_build_object('reason','dispatch_not_started',
      'redispatch_attempts',j.redispatch_attempts),req->>'idempotency_key',
    r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  return true;
end $$;
revoke all on function clued_private.storage_queued_timeout_v1(uuid,uuid) from public,anon,authenticated,service_role;

create function public.clued_storage_queued_sweep_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; cand record; dispatch boolean;
  settled int:=0; root_busy int:=0; listed jsonb:='[]'::jsonb; due timestamptz;
begin
  if coalesce(p_issuer_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
    or p_input->>'action' is distinct from 'due' or jsonb_typeof(p_input->'dispatch') is distinct from 'boolean'
    or (p_input-array['action','dispatch'])<>'{}'::jsonb then
    raise exception 'storage_queued_sweep_denied' using errcode='42501'; end if;
  dispatch:=(p_input->>'dispatch')::boolean;
  select * into app from clued_private.storage_oauth_apps_v1
    where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_queued_sweep_denied' using errcode='42501'; end if;
  perform pg_catalog.set_config('lock_timeout','2s',true);
  -- 1. Timeouts, each in its own subtransaction: one that fails is rolled back
  --    alone (locks included) and skipped; at most 10 are looked at per call.
  for cand in
    select j0.owner_id,j0.job_id from clued_private.storage_jobs_v1 j0
    join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
    where c0.oauth_client_id=app.oauth_client_id and c0.auth_mode='account_policy'
      and j0.authority_snapshot_v2 is not null and not (j0.mutation ? 'content_ref')
      and j0.intent_id is null and j0.dispatch_outcome is null
      and j0.created_at<=clock_timestamp()-interval '2 hours'
    order by j0.created_at,j0.job_id limit 10
  loop
    exit when settled>=3;
    begin
      if clued_private.storage_queued_timeout_v1(cand.owner_id,cand.job_id) then settled:=settled+1; end if;
    exception when others then
      null;
    end;
  end loop;
  -- 2. Redispatch candidates on quiet roots, oldest first, with backoff. The
  --    listing itself is the attempt: a dispatch the Worker loses or the
  --    database refuses at load is still counted, so the backoff advances.
  if dispatch and app.execution_enabled then
    for cand in
      select j0.owner_id,j0.job_id,j0.connection_id,j0.redispatch_attempts,j0.redispatch_at,j0.created_at,pr.root_folder_id
      from clued_private.storage_jobs_v1 j0
      join clued_private.storage_connections_v1 c0 on c0.id=j0.connection_id and c0.owner_id=j0.owner_id
      join clued_private.resource_center_profiles_v1 pr on pr.id=c0.profile_id and pr.user_id=j0.owner_id
      where c0.oauth_client_id=app.oauth_client_id and c0.auth_mode='account_policy'
        and c0.state='active' and c0.revoked_at is null
        and j0.authority_snapshot_v2 is not null and j0.intent_id is null and j0.dispatch_outcome is null
        and j0.created_at<=clock_timestamp()-interval '90 seconds'
      order by j0.created_at,j0.job_id limit 20
      for update of j0 skip locked
    loop
      exit when jsonb_array_length(listed)>=3;
      due:=case when cand.redispatch_at is null then cand.created_at+interval '90 seconds'
        else cand.redispatch_at+least(interval '60 minutes',interval '2 minutes'*power(2,least(cand.redispatch_attempts,6)-1)) end;
      if due>clock_timestamp() then continue; end if;
      if exists(select 1 from clued_private.resource_center_mutations_v1 m
          join clued_private.resource_center_profiles_v1 p on p.id=m.profile_id
          where m.user_id=cand.owner_id and p.root_folder_id=cand.root_folder_id
            and m.state in ('prepared','started','uncertain')) then
        root_busy:=root_busy+1; continue; end if;
      update clued_private.storage_jobs_v1 set redispatch_attempts=redispatch_attempts+1,redispatch_at=clock_timestamp()
        where owner_id=cand.owner_id and job_id=cand.job_id;
      listed:=listed||jsonb_build_array(jsonb_build_object('connection_id',cand.connection_id,'job_id',cand.job_id));
    end loop;
  end if;
  return jsonb_build_object('status','ok','settled',settled,'jobs',listed,'root_busy',root_busy);
end $$;
revoke all on function public.clued_storage_queued_sweep_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_queued_sweep_v1(text,jsonb) to anon;

-- Submit refuses a stuck root with a structured rejection, before the Work
-- Claim door and before any Receipt or job (anchored patch, exact hit count).
do $migration$
declare body text; hits int;
  anchor text:=$a$  gate:=clued_private.work_claim_gate_v1((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,$a$;
  replacement text:=$r$  -- BUG-20261008-001: a root whose unresolved journal outlived its admission
  -- cannot run this job; say so now instead of queueing it silently. A merely
  -- busy root (a job still inside its admission) queues as before.
  if clued_private.storage_root_stuck_v1((snapshot->>'owner_id')::uuid,
      (select root_folder_id from clued_private.resource_center_profiles_v1
        where id=(snapshot->>'profile_id')::uuid and user_id=(snapshot->>'owner_id')::uuid)) then
    return jsonb_build_object('status','rejected','error_code','storage_root_busy',
      'job_id',v_job_id,'connection_id',connection_id,'execution_permitted',false); end if;
  gate:=clued_private.work_claim_gate_v1((snapshot->>'owner_id')::uuid,(snapshot->>'binding_id')::uuid,$r$;
begin
  body:=pg_get_functiondef('clued_private.storage_jobs_policy_core_v2(text,jsonb)'::regprocedure);
  hits:=(length(body)-length(replace(body,anchor,'')))/length(anchor);
  if hits<>1 then
    raise exception 'storage_queued_dispatch_definition_mismatch: storage_jobs_policy_core_v2 (% of 1)',hits;
  end if;
  execute replace(body,anchor,replacement);
end $migration$;
