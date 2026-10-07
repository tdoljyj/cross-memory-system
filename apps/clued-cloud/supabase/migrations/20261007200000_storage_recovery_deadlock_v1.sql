-- BUG-20261007-005 (Clued Task c9733a6e): an unsettled account-policy cloud
-- job no longer locks its storage root indefinitely.
--
-- Production incident 2026-10-07 (connection Clued_资料中心): a binary create
-- recorded its provider attempt and never settled. Scheduled recovery looked at
-- it only during the first 10 minutes after the attempt; ordinary credential
-- refresh needs a quiet root (storage_root_has_unresolved_mutation), and the
-- recovery-only refresh accepted legacy connections only. The access token
-- expired an hour later and every read of the connection failed with
-- storage_read_unavailable. The upload had never reached Drive, and recovery
-- could only prove an effect, never its absence, so nothing could settle it.
--
-- 1. Scheduled recovery keeps a job due after its first 10 minutes, with
--    backoff (clued_private.storage_recovery_backoff_v1: 2, 4, 8, ... minutes,
--    at most 60). Jobs inside their first 10 minutes come first, as before.
--    `load` no longer refuses a job older than 10 minutes.
-- 2. clued_storage_refresh_worker_v1 accepts a recovery-only refresh
--    (recovery_job_id) for an account-policy connection, bound to the exact
--    unsettled job, intent and provider attempt under the policy that admitted
--    it (clued_private.storage_account_recovery_refresh_v1). Like the legacy
--    branch it keeps the file fence, skips only the quiet-root check and issues
--    no writer, admission or Drive write.
-- 3. public.clued_storage_recovery_absent_v1 (fixed connector issuer) settles a
--    create whose provider effect is proven absent: the Worker read Drive and
--    found neither the generated file ID nor any file carrying the intent's
--    appProperties. It accepts only a create whose admission expired and whose
--    attempt was recorded at least 10 minutes earlier (every create request
--    starts before its admission expires and is bounded at 120 s, and the
--    resumable session URI is never persisted), and it reuses the scheduled
--    `load` checks. The journal becomes cancelled with
--    {outcome: released_not_effected, reason_code: PROVIDER_EFFECT_ABSENT}, with
--    its own Receipt (storage_absent_release) and Event
--    (extension:storage:absent_released).
-- 4. The refresh `due` call skips a connection whose root has an unresolved
--    journal (its claim would be refused anyway) and reports how many it
--    skipped as root_busy, so the Worker can log the blocked refresh.

create table clued_private.storage_recovery_backoff_v1 (
  owner_id uuid not null,
  job_id uuid not null,
  attempts integer not null check (attempts between 1 and 1000000),
  next_at timestamptz not null,
  primary key (owner_id, job_id),
  foreign key (owner_id, job_id) references clued_private.storage_jobs_v1(owner_id, job_id) on delete cascade
);
alter table clued_private.storage_recovery_backoff_v1 enable row level security;
revoke all on table clued_private.storage_recovery_backoff_v1 from public, anon, authenticated, service_role;

-- 2. The account-policy recovery-only refresh target. Called by
-- clued_storage_refresh_worker_v1 only; raises storage_refresh_denied unless
-- the job is an attempted, unsettled account-policy cloud job whose authority
-- snapshot still matches the connection's active policy. On claim the journal
-- must still be started or uncertain; on a later commit/fail the attempt must
-- name the same job, intent and attempt digest (another verifier may have
-- settled the file meanwhile, so committed and cancelled are accepted then).
create function clued_private.storage_account_recovery_refresh_v1(p_connection uuid, p_owner uuid, p_profile uuid,
  p_job uuid, p_claim boolean, p_attempt_job uuid, p_attempt_intent uuid, p_attempt_digest text)
returns table(intent_id uuid, attempt_digest text) language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; j clued_private.storage_jobs_v1;
  m clued_private.resource_center_mutations_v1; digest text;
begin
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=p_owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=p_profile and user_id=p_owner;
  select * into j from clued_private.storage_jobs_v1 where owner_id=p_owner and job_id=p_job and connection_id=p_connection;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=p_owner and profile_id=p.id;
  select * into policy from clued_private.storage_account_policies_v2
    where id=c.account_policy_id and owner_id=p_owner and connection_id=c.id;
  if c.id is null or c.auth_mode<>'account_policy' or c.revoked_at is not null or p.id is null or p.id<>c.profile_id
    or j.job_id is null or j.authority_snapshot_v2 is null or m.id is null or m.profile_version<>p.version
    or m.writer_binding_id is distinct from j.cloud_writer_binding_id
    or m.provider_attempt is null or m.provider_attempt_receipt_id is null
    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')
    or (j.mutation->>'operation'='move' and j.mutation->>'target_kind'='directory')
    or policy.id is null or policy.state<>'active' or policy.revoked_at is not null
    or coalesce(policy.expires_at<=clock_timestamp(),false)
    or c.auth_generation::text is distinct from j.authority_snapshot_v2->>'auth_generation'
    or policy.policy_generation::text is distinct from j.authority_snapshot_v2->>'policy_generation'
    or policy.scope_digest is distinct from j.authority_snapshot_v2->>'scope_digest'
    or j.authority_snapshot_v2->>'policy_id' is distinct from policy.id::text
    or j.authority_snapshot_v2->>'connection_id' is distinct from c.id::text
    or not exists(select 1 from public.clued_audit_receipts r where r.id=m.provider_attempt_receipt_id and r.user_id=p_owner
      and r.status='committed' and r.operation='storage_provider_attempt' and r.created_at<=clock_timestamp()-interval '15 seconds')
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,policy.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,p.source_decision_id)
    or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=p_owner and provider=c.provider
      and provider_subject=c.provider_subject and root_folder_id=p.root_folder_id and lineage_id is null and denied) then
    raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  digest:=clued_private.m1_sha256(jsonb_build_object('request_sha256',m.request_sha256,'provider_attempt',m.provider_attempt));
  if p_claim then
    if m.state not in ('started','uncertain') or m.verified_result_v2 is not null then
      raise exception 'storage_refresh_denied' using errcode='42501'; end if;
  elsif p_attempt_job is distinct from p_job or p_attempt_intent is distinct from m.id or p_attempt_digest is distinct from digest
    or m.state not in ('started','uncertain','committed','cancelled') then
    raise exception 'storage_refresh_denied' using errcode='42501';
  end if;
  return query select m.id, digest;
end $$;
revoke all on function clued_private.storage_account_recovery_refresh_v1(uuid,uuid,uuid,uuid,boolean,uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- 1, 2 and 4: anchored patches with exact hit counts; paired edits of one
-- function are applied together and then created once.
do $migration$
declare patch record; current text; body text; hits int;
begin
  for patch in select * from (values
    -- 1. due: past its first 10 minutes a job is due again once its backoff has passed.
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$        and r0.created_at<=clock_timestamp()-interval '15 seconds'
        and r0.created_at>clock_timestamp()-interval '10 minutes'
      order by r0.created_at,j0.job_id limit 3
    ) q;$a$,
     $r$        and r0.created_at<=clock_timestamp()-interval '15 seconds'
        and (r0.created_at>clock_timestamp()-interval '10 minutes'
          or not exists(select 1 from clued_private.storage_recovery_backoff_v1 b0
            where b0.owner_id=j0.owner_id and b0.job_id=j0.job_id and b0.next_at>clock_timestamp()))
      order by r0.created_at<=clock_timestamp()-interval '10 minutes',r0.created_at,j0.job_id limit 3
    ) q;
    -- BUG-20261007-005: each listing of a job past its first 10 minutes
    -- doubles its wait (2, 4, 8, ... minutes, at most 60).
    insert into clued_private.storage_recovery_backoff_v1 as b(owner_id,job_id,attempts,next_at)
      select j1.owner_id,j1.job_id,1,clock_timestamp()+interval '2 minutes'
      from jsonb_to_recordset(jobs) as listed(connection_id uuid,job_id uuid)
      join clued_private.storage_jobs_v1 j1 on j1.job_id=listed.job_id and j1.connection_id=listed.connection_id
      join clued_private.resource_center_mutations_v1 m1 on m1.id=j1.intent_id and m1.user_id=j1.owner_id
      join public.clued_audit_receipts r1 on r1.id=m1.provider_attempt_receipt_id
      where r1.created_at<=clock_timestamp()-interval '10 minutes'
    on conflict (owner_id,job_id) do update set attempts=b.attempts+1,
      next_at=clock_timestamp()+least(interval '1 minute'*power(2,least(b.attempts+1,6)),interval '60 minutes');$r$,1),
    -- 1. load: no upper age bound.
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$        and r1.created_at<=clock_timestamp()-interval '15 seconds'
        and r1.created_at>clock_timestamp()-interval '10 minutes')$a$,
     $r$        and r1.created_at<=clock_timestamp()-interval '15 seconds')$r$,1),
    -- 4. due: skip a connection whose root has an unresolved journal.
    ('public.clued_storage_refresh_worker_v1(text,jsonb)',
     $a$       and not exists(select 1 from clued_private.storage_refresh_attempts_v1 pending_attempt where pending_attempt.connection_id=candidate_connection.id and pending_attempt.state='claimed')$a$,
     $r$       and not exists(select 1 from clued_private.storage_refresh_attempts_v1 pending_attempt where pending_attempt.connection_id=candidate_connection.id and pending_attempt.state='claimed')
       and not exists(select 1 from clued_private.resource_center_profiles_v1 busy_root
         join clued_private.resource_center_profiles_v1 busy_profile on busy_profile.root_folder_id=busy_root.root_folder_id
         join clued_private.resource_center_mutations_v1 busy_m on busy_m.profile_id=busy_profile.id and busy_m.user_id=candidate_connection.owner_id
         where busy_root.id=candidate_connection.profile_id and busy_m.state in ('prepared','started','uncertain'))$r$,1),
    ('public.clued_storage_refresh_worker_v1(text,jsonb)',
     $a$    return result||jsonb_build_object('pending_expired', (select count(*) from clued_private.storage_refresh_attempts_v1
      where issuer_hash=a.issuer_hash and state='claimed' and expires_at<=clock_timestamp()));$a$,
     $r$    return result||jsonb_build_object('pending_expired', (select count(*) from clued_private.storage_refresh_attempts_v1
      where issuer_hash=a.issuer_hash and state='claimed' and expires_at<=clock_timestamp()),
      -- BUG-20261007-005: due refreshes held back by an unresolved journal on their root.
      'root_busy', (select count(*) from clued_private.storage_refresh_delegations_v1 g
        join clued_private.storage_connections_v1 candidate_connection on candidate_connection.id=g.connection_id
        where g.issuer_hash=a.issuer_hash and g.enabled and g.failures<3 and g.next_refresh_at<=clock_timestamp()
          and candidate_connection.state='active'
          and exists(select 1 from clued_private.resource_center_profiles_v1 busy_root
            join clued_private.resource_center_profiles_v1 busy_profile on busy_profile.root_folder_id=busy_root.root_folder_id
            join clued_private.resource_center_mutations_v1 busy_m on busy_m.profile_id=busy_profile.id and busy_m.user_id=candidate_connection.owner_id
            where busy_root.id=candidate_connection.profile_id and busy_m.state in ('prepared','started','uncertain'))));$r$,1),
    -- 2. recovery-only refresh for an account-policy connection.
    ('public.clued_storage_refresh_worker_v1(text,jsonb)',
     $a$    if not a.execution_enabled or c.auth_mode<>'legacy' then raise exception 'storage_refresh_denied' using errcode='42501'; end if;$a$,
     $r$    if c.auth_mode='account_policy' then
      -- BUG-20261007-005: bound to the exact unsettled job, intent and attempt.
      select t.intent_id,t.attempt_digest into recovery_intent,recovery_digest
        from clued_private.storage_account_recovery_refresh_v1(c.id,c.owner_id,p.id,recovery_job,op='claim' and x.id is null,
          x.recovery_job_id,x.recovery_intent_id,x.recovery_attempt_digest) t;
    else
    if not a.execution_enabled or c.auth_mode<>'legacy' then raise exception 'storage_refresh_denied' using errcode='42501'; end if;$r$,1),
    ('public.clued_storage_refresh_worker_v1(text,jsonb)',
     $a$    -- Never reset the mutation, replace its provider ID or issue write authority.
  end if;$a$,
     $r$    -- Never reset the mutation, replace its provider ID or issue write authority.
    end if;
  end if;$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_recovery_deadlock_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

-- 3. Settle a create whose provider effect is proven absent.
create function public.clued_storage_recovery_absent_v1(p_issuer_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; descriptor jsonb; owner uuid;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  j clued_private.storage_jobs_v1; m clued_private.resource_center_mutations_v1;
  r public.clued_audit_receipts; req jsonb; refs jsonb; ev text; proof jsonb:=p_input->'proof';
begin
  if coalesce(p_issuer_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(p_input) k)
      is distinct from array['action','base_version','connection_id','intent_id','job_id','proof','request_sha256']
    or p_input->>'action' is distinct from 'settle_absent'
    or coalesce(p_input->>'connection_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_input->>'job_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_input->>'intent_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_input->>'base_version','') !~ '^[1-9][0-9]{0,17}$'
    or coalesce(p_input->>'request_sha256','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(proof) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(proof) k)
      is distinct from array['contract','intent_id','parent_id','provider_file_id']
    or proof->>'contract' is distinct from 'clued.storage-create-absent/1'
    or proof->>'intent_id' is distinct from p_input->>'intent_id'
    or coalesce(proof->>'provider_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
    or coalesce(proof->>'parent_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then
    raise exception 'storage_absent_release_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_absent_release_denied' using errcode='42501'; end if;
  select * into j from clued_private.storage_jobs_v1
    where job_id=(p_input->>'job_id')::uuid and connection_id=(p_input->>'connection_id')::uuid;
  if not found or j.intent_id is distinct from (p_input->>'intent_id')::uuid then
    raise exception 'storage_absent_release_denied' using errcode='42501'; end if;
  owner:=j.owner_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||owner::text||':'||j.job_id::text,0));
  -- A lost reply: the same settlement is answered from the journal.
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=owner;
  if m.state='cancelled' and m.final_result->>'reason_code'='PROVIDER_EFFECT_ABSENT'
    and m.provider_attempt->>'provider_file_id' is not distinct from proof->>'provider_file_id' then
    return jsonb_build_object('status','committed','state','cancelled','replayed',true,'connection_id',j.connection_id,
      'job_id',j.job_id,'intent_id',m.id,'receipt_id',m.receipt_id,'execution_permitted',false);
  end if;
  -- Every check of the scheduled recovery load: issuer, connection, policy,
  -- authority snapshot, Decisions, root denial, journal, attempt and writer.
  descriptor:=public.clued_storage_scheduled_recovery_v2(p_issuer_hash,
    jsonb_build_object('action','load','connection_id',p_input->>'connection_id','job_id',p_input->>'job_id'));
  select * into c from clued_private.storage_connections_v1 where id=j.connection_id and owner_id=owner;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=owner;
  select * into j from clued_private.storage_jobs_v1 where owner_id=owner and job_id=j.job_id for update;
  select * into m from clued_private.resource_center_mutations_v1 where id=j.intent_id and user_id=owner and profile_id=p.id for update;
  if descriptor->>'status' is distinct from 'recovery_only' or m.id is null
    or descriptor->>'intent_id' is distinct from m.id::text
    or j.mutation->>'operation' is distinct from 'create' or m.exact_request->'mutation'->>'operation' is distinct from 'create'
    or m.state not in ('started','uncertain') or m.verified_result_v2 is not null
    or m.version::text is distinct from p_input->>'base_version'
    or m.request_sha256 is distinct from p_input->>'request_sha256'
    or m.provider_attempt->>'provider_file_id' is distinct from proof->>'provider_file_id'
    or m.provider_attempt->>'parent_id' is distinct from proof->>'parent_id'
    or m.provider_attempt->>'intent_id' is distinct from m.id::text
    -- No create request of this journal can still be running or start again.
    or m.expires_at is null or m.expires_at>clock_timestamp()-interval '10 minutes'
    or not exists(select 1 from public.clued_audit_receipts r1 where r1.id=m.provider_attempt_receipt_id and r1.user_id=owner
      and r1.status='committed' and r1.operation='storage_provider_attempt'
      and r1.created_at<=clock_timestamp()-interval '10 minutes') then
    raise exception 'storage_absent_release_denied' using errcode='42501'; end if;
  req:=jsonb_build_object('idempotency_key','storage-absent-release:'||m.id::text,'intent_id',m.id,'job_id',j.job_id,
    'base_version',m.version,'proof',proof);
  r:=clued_private.m1_begin_receipt(owner,null,'storage_absent_release',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_absent_release_denied' using errcode='42501'; end if;
  update clued_private.resource_center_mutations_v1 set state='cancelled',version=version+1,updated_at=now(),
    receipt_id=r.id,final_result=jsonb_build_object('outcome','released_not_effected','reason_code','PROVIDER_EFFECT_ABSENT')
    where id=m.id;
  delete from clued_private.storage_recovery_backoff_v1 where owner_id=owner and job_id=j.job_id;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',m.id));
  ev:=clued_private.m1_append_event_row(owner,null,r.id,r.canonical_version,'extension:storage:absent_released',
    refs,'project:'||p.project_id::text,null,req,req->>'idempotency_key',r.request_sha256,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  return jsonb_build_object('status','committed','state','cancelled','replayed',false,'connection_id',j.connection_id,
    'job_id',j.job_id,'intent_id',m.id,'receipt_id',r.id,'execution_permitted',false);
end $$;
revoke all on function public.clued_storage_recovery_absent_v1(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.clued_storage_recovery_absent_v1(text,jsonb) to anon;
