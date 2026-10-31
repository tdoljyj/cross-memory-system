-- Bug 38bb5ddf (BUG-20261028-STORAGE-ACCESS-DIGEST-MANUAL-FALLBACK), Task
-- 68ed5cab, Owner Decision 24422a98: a directory whose access digest could
-- not be established is recovered by the program, never by asking the Owner
-- to run a directory check.
--
-- Until now the backfill (20261008120000) marked a directory "missing" once
-- and never looked at it again: due and load both skipped
-- access_digest_missing_at. Most marks are ordinary version drift (anything
-- added to a folder moves its Drive version), so the directory stayed matched
-- by a stale version and writes into it kept failing.
--
-- As in Drive, a folder's permissions are inherited from its parent and its
-- version is not a sharing signal. The backfill now settles a directory by,
-- in order:
-- * recorded: the read returned the registered version (unchanged rule);
-- * recorded_inherited: the folder's access digest equals its registered
--   parent's current access digest, and that parent is still unchanged by the
--   way it is matched today (its access digest, else its sharing digest, read
--   in the same run, equal to the registry, row version unchanged since load).
--   The folder then grants nothing beyond a parent the registry already
--   protects, so this records no wider baseline than the parent's;
-- * recorded_private: the only permission is the owner's own (the Worker
--   reports owner_only). Nothing can be narrower, so this needs no parent and
--   also covers the root, which has no registered parent;
-- * missing with a reason: not_found (Drive no longer shows it), unreadable
--   (no usable permission list), version_changed (no parent baseline to
--   compare with yet), access_differs (it grants something its parent does
--   not: a real sharing difference, still blocked and shown to the Owner).
--
-- A missing directory is never given up: it is tried again with backoff (30
-- minutes doubling, at most 16 hours), so a folder whose sharing is restored
-- or which reappears recovers by itself. Attempts are counted in
-- storage_access_digest_recovery_v1, a side table: the registry row's shape
-- is unchanged, so every whole-row comparison (to_jsonb) in settlement and
-- registration repair still holds. Existing marks have no side row and are
-- retried at once; a new streak starts from one.
--
-- clued_storage_access_digest_attention_v1 lists, for the signed-in Owner,
-- the directories that need them: a real sharing difference at once; a
-- folder Drive no longer shows, whose permissions cannot be read, or that has
-- no baseline the program can compare with (a shared root registered before
-- digests, and its subtree) after 3 attempts in a row for the same reason.
-- It is a separate read so the source-pinned Owner lifecycle function and its
-- access_digest_missing summary stay exactly as they are.
--
-- Where the program cannot decide, the Owner decides in business terms, as in
-- Drive: clued_storage_access_digest_accept_v1 records the sharing the last
-- attempt observed (within 24 hours) as the directory's baseline, CAS-bound
-- to that exact observation, with its own Receipt. It never runs a check or
-- asks the Owner to.
--
-- Each existing function is changed by an anchored patch with an exact hit
-- count. Every new commit input is optional, so the old Worker keeps working
-- between this migration and the release.

create table clued_private.storage_access_digest_recovery_v1(
  artifact_id uuid primary key references clued_private.resource_center_artifacts_v1(id) on delete cascade,
  user_id uuid not null,
  reason text not null check (reason in ('version_changed','not_found','unreadable','access_differs')),
  attempts integer not null check (attempts between 1 and 1000),
  observed_access text check (observed_access is null or observed_access ~ '^[0-9a-f]{64}$'),
  last_receipt_id uuid not null,
  updated_at timestamptz not null default now());
alter table clued_private.storage_access_digest_recovery_v1 enable row level security;
revoke all on table clued_private.storage_access_digest_recovery_v1 from public,anon,authenticated,service_role;

-- A commit's optional parent observation: exactly these keys.
create function clued_private.storage_access_digest_parent_input_v1(p jsonb) returns boolean
language sql immutable set search_path='' as $$
  select jsonb_typeof(p)='object'
    and (p-array['artifact_id','row_version','observed_digest','observed_access'])='{}'::jsonb
    and p ?& array['artifact_id','row_version','observed_digest','observed_access']
    and coalesce(p->>'artifact_id','') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(p->'row_version')='number' and coalesce(p->>'row_version','') ~ '^[0-9]{1,18}$'
    and (p->'observed_digest'='null'::jsonb or coalesce(p->>'observed_digest','') ~ '^[0-9a-f]{64}$')
    and (p->'observed_access'='null'::jsonb or coalesce(p->>'observed_access','') ~ '^[0-9a-f]{64}$')
$$;

-- The registered parent a directory is compared with: same profile, the path
-- one level up, active, with a digest to be matched by.
create function clued_private.storage_access_digest_parent_v1(a clued_private.resource_center_artifacts_v1) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('artifact_id',x.id,'provider_file_id',x.provider_file_id,'row_version',x.version,
      'mode',case when x.provider_access_digest is not null then 'access' else 'sharing' end)
    from clued_private.resource_center_artifacts_v1 x
    where x.user_id=a.user_id and x.profile_id=a.profile_id and x.state='active' and x.target_kind='directory'
      and x.path=regexp_replace(a.path,'/[^/]*$','') and x.id<>a.id
      and coalesce(x.provider_access_digest,x.provider_sharing_digest) is not null
    order by x.id limit 1
$$;

create function clued_private.storage_access_digest_outcome_v1(a clued_private.resource_center_artifacts_v1,p_input jsonb) returns text
language plpgsql set search_path='' as $$
declare par clued_private.resource_center_artifacts_v1; pin jsonb:=p_input->'parent';
begin
  if not (p_input->>'found')::boolean then return 'missing:not_found'; end if;
  if jsonb_typeof(p_input->'access_digest') is distinct from 'string' then return 'missing:unreadable'; end if;
  if p_input->>'observed_version'=a.provider_file_version then return 'recorded'; end if;
  if p_input->'owner_only'='true'::jsonb then return 'recorded_private'; end if;
  if jsonb_typeof(pin) is distinct from 'object' then return 'missing:version_changed'; end if;
  select * into par from clued_private.resource_center_artifacts_v1 x
    where x.id=(pin->>'artifact_id')::uuid and x.user_id=a.user_id and x.profile_id=a.profile_id
      and x.state='active' and x.target_kind='directory' and x.path=regexp_replace(a.path,'/[^/]*$','')
    for share;
  -- The parent is unchanged by the way it is matched today; an empty digest never matches (I10).
  if par.id is null or par.version<>(pin->>'row_version')::bigint
    or coalesce(par.provider_access_digest,par.provider_sharing_digest) is null
    or pin->>'observed_digest' is distinct from coalesce(par.provider_access_digest,par.provider_sharing_digest)
    or (par.provider_access_digest is not null and pin->>'observed_access' is distinct from par.provider_access_digest)
    or jsonb_typeof(pin->'observed_access') is distinct from 'string' then
    return 'missing:version_changed'; end if;
  if pin->>'observed_access'<>p_input->>'access_digest' then return 'missing:access_differs'; end if;
  return 'recorded_inherited';
end $$;
revoke all on function clued_private.storage_access_digest_parent_input_v1(jsonb),
  clued_private.storage_access_digest_parent_v1(clued_private.resource_center_artifacts_v1),
  clued_private.storage_access_digest_outcome_v1(clued_private.resource_center_artifacts_v1,jsonb)
  from public,anon,authenticated,service_role;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- due: a missing directory comes back with backoff, never given up.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$      join clued_private.storage_connections_v1 c0 on c0.profile_id=p0.id and c0.owner_id=a0.user_id
      where a0.state='active' and a0.target_kind='directory' and a0.provider_sharing_digest is null
        and a0.provider_access_digest is null and a0.access_digest_missing_at is null
        and coalesce(a0.access_digest_attempted_at<clock_timestamp()-interval '30 minutes',true)$a$,
     $r$      join clued_private.storage_connections_v1 c0 on c0.profile_id=p0.id and c0.owner_id=a0.user_id
      left join clued_private.storage_access_digest_recovery_v1 t0 on t0.artifact_id=a0.id
      where a0.state='active' and a0.target_kind='directory' and a0.provider_sharing_digest is null
        and a0.provider_access_digest is null
        and coalesce(a0.access_digest_attempted_at<clock_timestamp()
          -interval '30 minutes'*power(2,least(case when a0.access_digest_missing_at is null then 0
            else coalesce(t0.attempts,0) end,5)),true)$r$,1),
    -- commit may carry the parent observation.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$  elsif (p_input-array['action','connection_id','artifact_id','row_version','registered_version','observed_version','access_digest','found'])<>'{}'::jsonb$a$,
     $r$  elsif (p_input-array['action','connection_id','artifact_id','row_version','registered_version','observed_version','access_digest','found','parent','owner_only'])<>'{}'::jsonb
    or (p_input ? 'parent' and not clued_private.storage_access_digest_parent_input_v1(p_input->'parent'))
    or (p_input ? 'owner_only' and (p_input->'owner_only'<>'true'::jsonb or jsonb_typeof(p_input->'access_digest') is distinct from 'string'))$r$,1),
    -- load and commit: a missing directory stays eligible.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$    or a.provider_sharing_digest is not null or a.provider_access_digest is not null or a.access_digest_missing_at is not null$a$,
     $r$    or a.provider_sharing_digest is not null or a.provider_access_digest is not null$r$,1),
    -- load names the parent to compare with.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$      'provider_file_id',a.provider_file_id,'registered_version',a.provider_file_version,'row_version',a.version,
      'execution_permitted',false);$a$,
     $r$      'provider_file_id',a.provider_file_id,'registered_version',a.provider_file_version,'row_version',a.version,
      'parent',clued_private.storage_access_digest_parent_v1(a),'execution_permitted',false);$r$,1),
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$  outcome:=case when p_input->>'observed_version'=a.provider_file_version and jsonb_typeof(p_input->'access_digest')='string'
    then 'recorded' else 'missing' end;$a$,
     $r$  outcome:=clued_private.storage_access_digest_outcome_v1(a,p_input);
  -- Not missing before this commit: a stale count (its digest was written
  -- another way and cleared since) starts no streak.
  if a.access_digest_missing_at is null then
    delete from clued_private.storage_access_digest_recovery_v1 where artifact_id=a.id; end if;$r$,1),
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$'access_digest',p_input->'access_digest','outcome',outcome);$a$,
     $r$'access_digest',p_input->'access_digest','outcome',outcome)
    ||case when p_input ? 'parent' then jsonb_build_object('parent',p_input->'parent') else '{}'::jsonb end;$r$,1),
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$      provider_access_digest=case when outcome='recorded' then p_input->>'access_digest' end,
      access_digest_missing_at=case when outcome='missing' then clock_timestamp() end,$a$,
     $r$      provider_access_digest=case when outcome like 'recorded%' then p_input->>'access_digest' end,
      access_digest_missing_at=case when outcome like 'missing:%' then clock_timestamp() end,
      access_digest_attempted_at=case when outcome like 'missing:%' then clock_timestamp() else access_digest_attempted_at end,$r$,1),
    -- Count the attempt, or forget it once recorded.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$    where id=a.id returning * into a;$a$,
     $r$    where id=a.id returning * into a;
  if outcome like 'missing:%' then
    insert into clued_private.storage_access_digest_recovery_v1 as t(artifact_id,user_id,reason,attempts,last_receipt_id,observed_access)
      values(a.id,u,substr(outcome,9),1,r.id,
        case when jsonb_typeof(p_input->'access_digest')='string' then p_input->>'access_digest' end)
      on conflict (artifact_id) do update set reason=excluded.reason,
        attempts=case when t.reason=excluded.reason then least(t.attempts+1,1000) else 1 end,
        observed_access=excluded.observed_access,last_receipt_id=excluded.last_receipt_id,updated_at=now();
  else delete from clued_private.storage_access_digest_recovery_v1 where artifact_id=a.id; end if;$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Every edit of one function first, then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_access_digest_recovery_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

-- Directories that need the Owner: a real sharing difference at once; gone,
-- unreadable or without a baseline after 3 attempts for the same reason.
create function clued_private.storage_access_digest_needs_owner_v1(t clued_private.storage_access_digest_recovery_v1) returns boolean
language sql immutable set search_path='' as $$
  select t.reason='access_differs' or t.attempts>=3
$$;
revoke all on function clued_private.storage_access_digest_needs_owner_v1(clued_private.storage_access_digest_recovery_v1)
  from public,anon,authenticated,service_role;

-- The signed-in Owner's directories that need them, per connection, in
-- business terms. can_accept: the last attempt observed a sharing state the
-- Owner may confirm (a real difference, or no baseline to compare with).
create function public.clued_storage_access_digest_attention_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1();
begin
  if p_input is distinct from jsonb_build_object('action','list') then
    raise exception 'storage_access_digest_attention_denied' using errcode='42501'; end if;
  return jsonb_build_object('contract','clued.storage-access-digest-attention/1','connections',coalesce((
    select jsonb_agg(jsonb_build_object('connection_id',q.connection_id,'count',q.n,'directories',q.dirs) order by q.connection_id)
    from (select co.id connection_id,
        (select count(*) from clued_private.resource_center_artifacts_v1 x
          join clued_private.storage_access_digest_recovery_v1 t on t.artifact_id=x.id
          where x.profile_id=pr.id and x.user_id=u and x.state='active' and x.access_digest_missing_at is not null
            and clued_private.storage_access_digest_needs_owner_v1(t)) n,
        coalesce((select jsonb_agg(jsonb_build_object('artifact_id',y.id,'path',y.path,'reason',y.reason,
            'observed_access',y.observed_access) order by y.path collate "C")
          from (select x.id,substr(x.path,char_length(pr.managed_root)+2) path,
              case when t.reason='version_changed' then 'no_baseline' else t.reason end reason,
              case when t.reason in ('access_differs','version_changed') and t.updated_at>clock_timestamp()-interval '24 hours'
                then t.observed_access end observed_access
            from clued_private.resource_center_artifacts_v1 x
            join clued_private.storage_access_digest_recovery_v1 t on t.artifact_id=x.id
            where x.profile_id=pr.id and x.user_id=u and x.state='active' and x.access_digest_missing_at is not null
              and clued_private.storage_access_digest_needs_owner_v1(t) order by x.path collate "C" limit 20) y),'[]'::jsonb) dirs
      from clued_private.storage_connections_v1 co
      join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
      where co.owner_id=u and co.revoked_at is null) q where q.n>0),'[]'::jsonb));
end $$;
revoke all on function public.clued_storage_access_digest_attention_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_access_digest_attention_v1(jsonb) to authenticated;

-- The Owner confirms the sharing the last attempt observed as the
-- directory's baseline: exactly that observation (CAS), at most 24 hours old,
-- under the root's lock and quiet rule, with its own Receipt.
create function public.clued_storage_access_digest_accept_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); a clued_private.resource_center_artifacts_v1;
  p clued_private.resource_center_profiles_v1; t clued_private.storage_access_digest_recovery_v1;
  cid uuid; r public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or (p_input-array['action','artifact_id','observed_access'])<>'{}'::jsonb or p_input->>'action' is distinct from 'accept'
    or coalesce(p_input->>'artifact_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_input->>'observed_access','') !~ '^[0-9a-f]{64}$' then
    raise exception 'storage_access_digest_accept_denied' using errcode='42501'; end if;
  select pr.* into p from clued_private.resource_center_artifacts_v1 x
    join clued_private.resource_center_profiles_v1 pr on pr.id=x.profile_id and pr.user_id=u
    where x.id=(p_input->>'artifact_id')::uuid and x.user_id=u;
  if p.id is null then raise exception 'storage_access_digest_accept_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||p.root_folder_id,0));
  perform clued_private.storage_root_quiet_v1(u,p.root_folder_id);
  perform clued_private.authorization_account_v12(u);
  select * into a from clued_private.resource_center_artifacts_v1
    where id=(p_input->>'artifact_id')::uuid and user_id=u and profile_id=p.id for update;
  select * into t from clued_private.storage_access_digest_recovery_v1 where artifact_id=a.id for update;
  select co.id into cid from clued_private.storage_connections_v1 co
    where co.profile_id=p.id and co.owner_id=u and co.revoked_at is null and co.state='active'
      and co.profile_version=p.version
      and not exists(select 1 from clued_private.storage_root_denies_v2 d where d.owner_id=u and d.provider=co.provider
        and d.provider_subject=co.provider_subject and d.root_folder_id=p.root_folder_id and d.lineage_id is null and d.denied)
    order by co.id limit 1;
  if a.id is null or a.state<>'active' or a.target_kind<>'directory' or a.access_digest_missing_at is null
    or a.provider_access_digest is not null or a.provider_sharing_digest is not null or p.state<>'active' or cid is null
    or t.artifact_id is null or t.reason not in ('access_differs','version_changed')
    or not clued_private.storage_access_digest_needs_owner_v1(t)
    or t.updated_at<=clock_timestamp()-interval '24 hours'
    or t.observed_access is distinct from p_input->>'observed_access'
    -- The row is still the one that observation settled (no other path changed it since).
    or a.receipt_id is distinct from t.last_receipt_id then
    raise exception 'storage_access_digest_accept_denied' using errcode='42501'; end if;
  req:=jsonb_build_object('idempotency_key','storage-access-digest-accept:'||a.id::text||':'||a.version::text,
    'artifact_id',a.id,'path',a.path,'provider_file_id',a.provider_file_id,'reason',t.reason,
    'observed_access',t.observed_access,'observation_receipt_id',t.last_receipt_id);
  r:=clued_private.m1_begin_receipt(u,null,'storage_access_digest_owner_accept',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_access_digest_accept_conflict' using errcode='40001'; end if;
  update clued_private.resource_center_artifacts_v1 set provider_access_digest=t.observed_access,access_digest_missing_at=null,
      version=version+1,updated_at=now(),receipt_id=r.id
    where id=a.id returning * into a;
  delete from clued_private.storage_access_digest_recovery_v1 where artifact_id=a.id;
  -- Directories below that had no baseline are checked again at once, now
  -- that this one has (not a registry change: no version bump).
  update clued_private.resource_center_artifacts_v1 x set access_digest_attempted_at=null
    from clued_private.storage_access_digest_recovery_v1 t2
    where t2.artifact_id=x.id and t2.reason='version_changed' and x.user_id=u and x.profile_id=p.id
      and x.state='active' and x.access_digest_missing_at is not null and starts_with(x.path,a.path||'/');
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',cid));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:access_digest_owner_accepted',refs,
    'project:'||p.project_id::text,null,req-'idempotency_key',req->>'idempotency_key',r.request_sha256,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  return jsonb_build_object('status','committed','artifact_id',a.id,'receipt_id',r.id);
end $$;
revoke all on function public.clued_storage_access_digest_accept_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_access_digest_accept_v1(jsonb) to authenticated;
