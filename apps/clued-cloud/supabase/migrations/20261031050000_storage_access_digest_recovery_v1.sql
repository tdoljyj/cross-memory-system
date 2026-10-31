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
-- * missing with a reason: not_found (Drive no longer shows it), unreadable
--   (no usable permission list), version_changed (no parent baseline to
--   compare with yet), access_differs (it grants something its parent does
--   not: a real sharing difference, still blocked and shown to the Owner).
--
-- A missing directory is tried again with backoff (30 minutes doubling, at
-- most 16 hours) up to 12 attempts, in storage_access_digest_recovery_v1, a
-- side table: the registry row's shape is unchanged, so every whole-row
-- comparison (to_jsonb) in settlement and registration repair still holds.
-- Existing marks have no side row and are retried at once.
--
-- clued_storage_access_digest_attention_v1 lists, for the signed-in Owner,
-- the directories that need them (a real sharing difference, or a folder
-- still unreadable or gone after every attempt). It is a separate read so the
-- source-pinned Owner lifecycle function and its access_digest_missing
-- summary stay exactly as they are.
--
-- Each existing function is changed by an anchored patch with an exact hit
-- count. Every new commit input is optional, so the old Worker keeps working
-- between this migration and the release.

create table clued_private.storage_access_digest_recovery_v1(
  artifact_id uuid primary key references clued_private.resource_center_artifacts_v1(id) on delete cascade,
  user_id uuid not null,
  reason text not null check (reason in ('version_changed','not_found','unreadable','access_differs')),
  attempts integer not null check (attempts between 1 and 1000),
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
    and jsonb_typeof(p->'row_version')='number'
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
    -- due: a missing directory comes back with backoff until its attempts run out.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$      join clued_private.storage_connections_v1 c0 on c0.profile_id=p0.id and c0.owner_id=a0.user_id
      where a0.state='active' and a0.target_kind='directory' and a0.provider_sharing_digest is null
        and a0.provider_access_digest is null and a0.access_digest_missing_at is null
        and coalesce(a0.access_digest_attempted_at<clock_timestamp()-interval '30 minutes',true)$a$,
     $r$      join clued_private.storage_connections_v1 c0 on c0.profile_id=p0.id and c0.owner_id=a0.user_id
      left join clued_private.storage_access_digest_recovery_v1 t0 on t0.artifact_id=a0.id
      where a0.state='active' and a0.target_kind='directory' and a0.provider_sharing_digest is null
        and a0.provider_access_digest is null and (a0.access_digest_missing_at is null or coalesce(t0.attempts,0)<12)
        and coalesce(a0.access_digest_attempted_at<clock_timestamp()
          -interval '30 minutes'*power(2,least(coalesce(t0.attempts,0),5)),true)$r$,1),
    -- commit may carry the parent observation.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$  elsif (p_input-array['action','connection_id','artifact_id','row_version','registered_version','observed_version','access_digest','found'])<>'{}'::jsonb$a$,
     $r$  elsif (p_input-array['action','connection_id','artifact_id','row_version','registered_version','observed_version','access_digest','found','parent'])<>'{}'::jsonb
    or (p_input ? 'parent' and not clued_private.storage_access_digest_parent_input_v1(p_input->'parent'))$r$,1),
    -- load and commit: a missing directory stays eligible until its attempts run out.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$    or a.provider_sharing_digest is not null or a.provider_access_digest is not null or a.access_digest_missing_at is not null$a$,
     $r$    or a.provider_sharing_digest is not null or a.provider_access_digest is not null
    or (a.access_digest_missing_at is not null and coalesce((select t.attempts from clued_private.storage_access_digest_recovery_v1 t
      where t.artifact_id=a.id),0)>=12)$r$,1),
    -- load names the parent to compare with.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$      'provider_file_id',a.provider_file_id,'registered_version',a.provider_file_version,'row_version',a.version,
      'execution_permitted',false);$a$,
     $r$      'provider_file_id',a.provider_file_id,'registered_version',a.provider_file_version,'row_version',a.version,
      'parent',clued_private.storage_access_digest_parent_v1(a),'execution_permitted',false);$r$,1),
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$  outcome:=case when p_input->>'observed_version'=a.provider_file_version and jsonb_typeof(p_input->'access_digest')='string'
    then 'recorded' else 'missing' end;$a$,
     $r$  outcome:=clued_private.storage_access_digest_outcome_v1(a,p_input);$r$,1),
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$'access_digest',p_input->'access_digest','outcome',outcome);$a$,
     $r$'access_digest',p_input->'access_digest','outcome',outcome)
    ||case when p_input ? 'parent' then jsonb_build_object('parent',p_input->'parent') else '{}'::jsonb end;$r$,1),
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$      provider_access_digest=case when outcome='recorded' then p_input->>'access_digest' end,
      access_digest_missing_at=case when outcome='missing' then clock_timestamp() end,$a$,
     $r$      provider_access_digest=case when outcome in ('recorded','recorded_inherited') then p_input->>'access_digest' end,
      access_digest_missing_at=case when outcome like 'missing:%' then clock_timestamp() end,
      access_digest_attempted_at=case when outcome like 'missing:%' then clock_timestamp() else access_digest_attempted_at end,$r$,1),
    -- Count the attempt, or forget it once recorded.
    ('clued_private.ii_pub_clued_storage_access_digest_backfill_v1(text,jsonb)',
     $a$    where id=a.id returning * into a;$a$,
     $r$    where id=a.id returning * into a;
  if outcome like 'missing:%' then
    insert into clued_private.storage_access_digest_recovery_v1 as t(artifact_id,user_id,reason,attempts,last_receipt_id)
      values(a.id,u,substr(outcome,9),1,r.id)
      on conflict (artifact_id) do update set reason=excluded.reason,attempts=least(t.attempts+1,1000),
        last_receipt_id=excluded.last_receipt_id,updated_at=now();
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

-- The signed-in Owner's directories that need them, per connection, in
-- business terms. Directories still being recovered are not listed.
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
            and (t.reason='access_differs' or t.attempts>=12)) n,
        coalesce((select jsonb_agg(jsonb_build_object('path',y.path,'reason',y.reason) order by y.path collate "C")
          from (select substr(x.path,char_length(pr.managed_root)+2) path,
              case when t.reason in ('access_differs','not_found') then t.reason else 'unreadable' end reason
            from clued_private.resource_center_artifacts_v1 x
            join clued_private.storage_access_digest_recovery_v1 t on t.artifact_id=x.id
            where x.profile_id=pr.id and x.user_id=u and x.state='active' and x.access_digest_missing_at is not null
              and (t.reason='access_differs' or t.attempts>=12) order by x.path collate "C" limit 20) y),'[]'::jsonb) dirs
      from clued_private.storage_connections_v1 co
      join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
      where co.owner_id=u) q where q.n>0),'[]'::jsonb));
end $$;
revoke all on function public.clued_storage_access_digest_attention_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_access_digest_attention_v1(jsonb) to authenticated;
