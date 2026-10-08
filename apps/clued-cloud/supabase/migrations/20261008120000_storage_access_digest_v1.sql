-- StorageFineGrainedConcurrency.v0.1 §4.1, step 2 (Task e2eb07d1, Owner
-- Decision 94fc26b4): registered directories get an access digest.
--
-- The access digest (googleDriveAccessDigest) covers every permission with
-- its grantee kind, role, domain, discoverability and expiry, so unlike the
-- sharing digest it changes when only a role changes. Step 3 will match
-- ancestors by it instead of by their Drive version; this step only collects
-- it. No matching rule changes here.
--
-- * provider_access_digest: 64-hex, directories only. access_digest_missing_at
--   marks a directory whose digest could not be established; it is cleared
--   when a digest is written.
-- * Onboarding records the root's and every track's digest from the same
--   Drive read that recorded their version (effect_result access_digest).
-- * A directory create or adopt may carry the folder's observed digest in its
--   verified proof, only when the proof also carries the sharing digest the
--   existing rule already checks; the registration stores it.
-- * A directory move's settlement records, on the source and destination
--   folders still at the Drive version the provider identity saw (in the same
--   update that records their sharing digest, so each changes once), and on
--   the moved directory itself (whose access the postcondition required to be
--   unchanged), the access digest the identity recorded.
-- * The directory check may report provider_access_digest, and an Owner
--   approved artifact_update may write it.
-- * Backfill (clued_storage_access_digest_backfill_v1): a directory with
--   neither digest gets its access digest only when one Drive read returns
--   the registered version; another version, a folder Drive no longer shows
--   (404) or no usable permission list marks it missing. A transient failure
--   commits nothing; access_digest_attempted_at puts the directory behind
--   the others for 30 minutes so one failing connection cannot starve them. Equal
--   versions prove only "unchanged since the registry last recorded this
--   version", which is exactly the baseline version matching protects today.
-- * Each existing function is changed by an anchored patch with an exact hit
--   count. Every new input is optional, so the old Worker keeps working
--   between this migration and the release.

-- The verified record compares whole registry rows (to_jsonb) at settlement;
-- new columns change every row, so no verified job may be waiting to settle.
do $guard$
begin
  if exists(select 1 from clued_private.resource_center_mutations_v1
    where state in ('started','uncertain') and verified_result_v2 is not null) then
    raise exception 'storage_access_digest_verified_job_unsettled' using errcode='55000'; end if;
end $guard$;

alter table clued_private.resource_center_artifacts_v1
  add column provider_access_digest text,
  add column access_digest_missing_at timestamptz,
  add column access_digest_attempted_at timestamptz,
  add constraint resource_center_artifacts_v1_access_digest_check check (provider_access_digest is null
    or (provider_access_digest ~ '^[0-9a-f]{64}$' and target_kind='directory')),
  add constraint resource_center_artifacts_v1_access_missing_check check (access_digest_missing_at is null
    or (target_kind='directory' and provider_access_digest is null));

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- artifact_update: an Owner approved digest (directories only); writing
    -- one clears the missing mark, an explicit null clears the digest.
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$      if p_input ? 'provider_sharing_digest' and p_input->'provider_sharing_digest'<>'null'::jsonb and$a$,
     $r$      if p_input ? 'provider_access_digest' and p_input->'provider_access_digest'<>'null'::jsonb and
        (v_artifact.target_kind<>'directory' or
          coalesce(p_input->>'provider_access_digest','') !~ '^[0-9a-f]{64}$') then
        raise exception 'resource_center_artifact_invalid' using errcode='22023';
      end if;
      if p_input ? 'provider_sharing_digest' and p_input->'provider_sharing_digest'<>'null'::jsonb and$r$,1),
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$          provider_sharing_digest=case when p_input ? 'provider_sharing_digest'
            then p_input->>'provider_sharing_digest' else provider_sharing_digest end,$a$,
     $r$          provider_sharing_digest=case when p_input ? 'provider_sharing_digest'
            then p_input->>'provider_sharing_digest' else provider_sharing_digest end,
          provider_access_digest=case when p_input ? 'provider_access_digest'
            then p_input->>'provider_access_digest' else provider_access_digest end,
          access_digest_missing_at=case when jsonb_typeof(p_input->'provider_access_digest')='string'
            then null else access_digest_missing_at end,$r$,1),
    -- artifact_register stores the digest a verified create or adopt carried.
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$        governance_class,delete_authority,source_decision_id,receipt_id,provider_sharing_digest)$a$,
     $r$        governance_class,delete_authority,source_decision_id,receipt_id,provider_sharing_digest,provider_access_digest)$r$,1),
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$        case when jsonb_typeof(p_input->'provider_sharing_digest')='string' then p_input->>'provider_sharing_digest' end)$a$,
     $r$        case when jsonb_typeof(p_input->'provider_sharing_digest')='string' then p_input->>'provider_sharing_digest' end,
        case when jsonb_typeof(p_input->'provider_access_digest')='string' then p_input->>'provider_access_digest' end)$r$,1),
    -- The registration input carries it.
    ('clued_private.storage_settle_input_v1(uuid,clued_private.resource_center_mutations_v1,jsonb)',
     $a$    ||case when p_proof ? 'provider_sharing_digest'
      then jsonb_build_object('provider_sharing_digest',p_proof->'provider_sharing_digest') else '{}'::jsonb end$a$,
     $r$    ||case when p_proof ? 'provider_sharing_digest'
      then jsonb_build_object('provider_sharing_digest',p_proof->'provider_sharing_digest') else '{}'::jsonb end
    ||case when p_proof ? 'provider_access_digest'
      then jsonb_build_object('provider_access_digest',p_proof->'provider_access_digest') else '{}'::jsonb end$r$,1),
    -- The verified record: the observed access digest only for a directory
    -- create or adopt whose proof also carries the checked sharing digest.
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    if proof is distinct from expected or finish->'postcondition' is distinct from post$a$,
     $r$    if proof ? 'provider_access_digest' then
      if j.mutation->>'target_kind' is distinct from 'directory'
        or coalesce(j.mutation->>'operation','') not in ('create','adopt') or not (expected ? 'provider_sharing_digest')
        or jsonb_typeof(proof->'provider_access_digest') is distinct from 'string'
        or proof->>'provider_access_digest' !~ '^[0-9a-f]{64}$' then
        raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
      expected:=expected||jsonb_build_object('provider_access_digest',proof->'provider_access_digest');
    end if;
    if proof is distinct from expected or finish->'postcondition' is distinct from post$r$,1),
    -- The directory move's settlement. The moved directory, whose access the
    -- postcondition required to be unchanged, gets the access digest the
    -- provider identity recorded in the same update that moves it.
    ('clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)',
     $a$  moved clued_private.resource_center_artifacts_v1;$a$,
     $r$  moved clued_private.resource_center_artifacts_v1; moved_access text;$r$,1),
    ('clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)',
     $a$  update clued_private.resource_center_artifacts_v1
    set path=v_path,provider_file_version=p_input->>'provider_file_version',version=version+1,updated_at=now(),$a$,
     $r$  select m.authority_request->'provider_identity'->>'source_access_digest' into moved_access
    from clued_private.resource_center_mutations_v1 m where m.id=substr(p_input->>'idempotency_key',26)::uuid
      and m.authority_request->'provider_identity'->>'source_access_digest' ~ '^[0-9a-f]{64}$';
  update clued_private.resource_center_artifacts_v1
    set path=v_path,provider_file_version=p_input->>'provider_file_version',version=version+1,updated_at=now(),
      provider_access_digest=coalesce(provider_access_digest,moved_access),
      access_digest_missing_at=case when moved_access is null then access_digest_missing_at end,$r$,1),
    -- The source and destination folders: one update records whichever of
    -- the two digests each still lacks, at the Drive version the identity saw.
    ('clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)',
     $a$    set provider_sharing_digest=g.digest,version=x.version+1,updated_at=now(),receipt_id=p_receipt$a$,
     $r$    set provider_sharing_digest=coalesce(x.provider_sharing_digest,case when g.digest ~ '^[0-9a-f]{64}$' then g.digest end),
      provider_access_digest=coalesce(x.provider_access_digest,case when g.access ~ '^[0-9a-f]{64}$' then g.access end),
      access_digest_missing_at=case when x.provider_access_digest is null and g.access ~ '^[0-9a-f]{64}$' then null
        else x.access_digest_missing_at end,
      version=x.version+1,updated_at=now(),receipt_id=p_receipt$r$,1),
    ('clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)',
     $a$      lateral (values (s.i->>'destination_parent_id',parent,s.i->>'destination_parent_version',s.i->>'destination_parent_sharing_digest'),
        (s.i->>'source_parent_id',regexp_replace(old,'/[^/]*$',''),s.i->>'source_parent_version',s.i->>'source_parent_sharing_digest'))
        g(fid,folder,seen_version,digest)$a$,
     $r$      lateral (values (s.i->>'destination_parent_id',parent,s.i->>'destination_parent_version',s.i->>'destination_parent_sharing_digest',
          s.i->>'destination_parent_access_digest'),
        (s.i->>'source_parent_id',regexp_replace(old,'/[^/]*$',''),s.i->>'source_parent_version',s.i->>'source_parent_sharing_digest',
          s.i->>'source_parent_access_digest'))
        g(fid,folder,seen_version,digest,access)$r$,1),
    ('clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)',
     $a$      and x.provider_sharing_digest is null and x.provider_file_id=g.fid and x.path=g.folder
      and x.provider_file_version=g.seen_version and g.digest ~ '^[0-9a-f]{64}$';$a$,
     $r$      and x.provider_file_id=g.fid and x.path=g.folder and x.provider_file_version=g.seen_version
      and ((x.provider_sharing_digest is null and g.digest ~ '^[0-9a-f]{64}$')
        or (x.provider_access_digest is null and g.access ~ '^[0-9a-f]{64}$'));$r$,1),
    -- The directory check may report each directory's access digest.
    ('public.clued_storage_directory_probe_v1(text,jsonb)',
     $a$          or (item-array['path','provider_file_id','provider_file_version','parent_id','provider_sharing_digest'])<>'{}'::jsonb$a$,
     $r$          or (item-array['path','provider_file_id','provider_file_version','parent_id','provider_sharing_digest','provider_access_digest'])<>'{}'::jsonb
          or (item ? 'provider_access_digest' and item->'provider_access_digest'<>'null'::jsonb
            and coalesce(item->>'provider_access_digest','') !~ '^[0-9a-f]{64}$')$r$,1),
    -- Onboarding: effect_result may carry the folder's access digest.
    ('public.clued_storage_onboard_v1(text,jsonb)',
     $a$    if (p_input-array['action','onboard_attempt_id','run_token','role','provider_file_id','version','parents','created'])<>'{}'::jsonb$a$,
     $r$    if (p_input-array['action','onboard_attempt_id','run_token','role','provider_file_id','version','parents','created','access_digest'])<>'{}'::jsonb
      or (p_input ? 'access_digest' and p_input->'access_digest'<>'null'::jsonb
        and coalesce(p_input->>'access_digest','') !~ '^[0-9a-f]{64}$')$r$,1),
    ('public.clued_storage_onboard_v1(text,jsonb)',
     $a$        'created',(p_input->>'created')::boolean,'result_at',clock_timestamp())),$a$,
     $r$        'created',(p_input->>'created')::boolean,'result_at',clock_timestamp())
        ||case when jsonb_typeof(p_input->'access_digest')='string'
          then jsonb_build_object('access_digest',p_input->>'access_digest') else '{}'::jsonb end),$r$,1),
    -- Activation registers the root and tracks with it.
    ('clued_private.storage_onboard_activate_v1(uuid,clued_private.storage_onboard_attempts_v1,clued_private.storage_oauth_apps_v1,jsonb)',
     $a$    target_kind,governance_class,delete_authority,source_decision_id,receipt_id)
  values(u,p.id,managed,root,root_version,'directory','governance',false,decision,r.id);$a$,
     $r$    target_kind,governance_class,delete_authority,source_decision_id,receipt_id,provider_access_digest)
  values(u,p.id,managed,root,root_version,'directory','governance',false,decision,r.id,
    case when o.effects->'root'->>'access_digest' ~ '^[0-9a-f]{64}$' then o.effects->'root'->>'access_digest' end);$r$,1),
    ('clued_private.storage_onboard_activate_v1(uuid,clued_private.storage_onboard_attempts_v1,clued_private.storage_oauth_apps_v1,jsonb)',
     $a$      target_kind,governance_class,delete_authority,source_decision_id,receipt_id)
    values(u,p.id,managed||'/'||track,tid,tversion,'directory','ordinary',false,decision,r.id);$a$,
     $r$      target_kind,governance_class,delete_authority,source_decision_id,receipt_id,provider_access_digest)
    values(u,p.id,managed||'/'||track,tid,tversion,'directory','ordinary',false,decision,r.id,
      case when o.effects->('track:'||track)->>'access_digest' ~ '^[0-9a-f]{64}$'
        then o.effects->('track:'||track)->>'access_digest' end);$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Every edit of one function first, then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_access_digest_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

-- Backfill: one directory at a time, for a scheduled Worker that holds the
-- OAuth app's issuer secret. due lists candidates; load returns the
-- credential to read one directory with; commit records the outcome.
create function public.clued_storage_access_digest_backfill_v1(p_issuer_hash text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; c clued_private.storage_connections_v1;
  policy clued_private.storage_account_policies_v2;
  p clued_private.resource_center_profiles_v1; a clued_private.resource_center_artifacts_v1;
  u uuid; op text:=p_input->>'action'; listed jsonb; r public.clued_audit_receipts; req jsonb; refs jsonb; ev text;
  outcome text; uuid_re text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(p_issuer_hash,'') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
    or coalesce(op,'') not in ('due','load','commit') then
    raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
  if op='due' then
    if p_input is distinct from jsonb_build_object('action','due') then
      raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
    -- Directories with neither digest and no missing mark, under an active
    -- connection of this app whose root is quiet and not denied.
    select coalesce(jsonb_agg(jsonb_build_object('connection_id',q.connection_id,'artifact_id',q.artifact_id)),'[]'::jsonb)
      into listed from (
      select c0.id connection_id,a0.id artifact_id from clued_private.resource_center_artifacts_v1 a0
      join clued_private.resource_center_profiles_v1 p0 on p0.id=a0.profile_id and p0.user_id=a0.user_id and p0.state='active'
      join clued_private.storage_connections_v1 c0 on c0.profile_id=p0.id and c0.owner_id=a0.user_id
      where a0.state='active' and a0.target_kind='directory' and a0.provider_sharing_digest is null
        and a0.provider_access_digest is null and a0.access_digest_missing_at is null
        and coalesce(a0.access_digest_attempted_at<clock_timestamp()-interval '30 minutes',true)
        and c0.oauth_client_id=app.oauth_client_id and c0.provider='google-drive' and c0.revoked_at is null
        and c0.auth_mode='account_policy' and c0.state='active'
        and clued_private.storage_envelope_valid_v1(c0.credential_envelope)
        and not exists(select 1 from clued_private.resource_center_mutations_v1 m0
          join clued_private.resource_center_profiles_v1 p1 on p1.id=m0.profile_id
          where m0.user_id=a0.user_id and p1.root_folder_id=p0.root_folder_id and m0.state in ('prepared','started','uncertain'))
        and not exists(select 1 from clued_private.storage_root_denies_v2 d0 where d0.owner_id=a0.user_id
          and d0.provider=c0.provider and d0.provider_subject=c0.provider_subject and d0.root_folder_id=p0.root_folder_id
          and d0.lineage_id is null and d0.denied)
      order by a0.access_digest_attempted_at nulls first,a0.created_at,a0.id limit 5
    ) q;
    return jsonb_build_object('status','ok','directories',listed);
  end if;
  if coalesce(p_input->>'connection_id','') !~ uuid_re or coalesce(p_input->>'artifact_id','') !~ uuid_re then
    raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
  if op='load' then
    if p_input is distinct from jsonb_build_object('action','load','connection_id',p_input->>'connection_id',
      'artifact_id',p_input->>'artifact_id') then
      raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
  elsif (p_input-array['action','connection_id','artifact_id','row_version','registered_version','observed_version','access_digest','found'])<>'{}'::jsonb
    or jsonb_typeof(p_input->'found') is distinct from 'boolean'
    or ((p_input->>'found')::boolean and p_input->'observed_version'='null'::jsonb)
    or (not (p_input->>'found')::boolean and (p_input->'observed_version'<>'null'::jsonb or p_input->'access_digest'<>'null'::jsonb))
    or jsonb_typeof(p_input->'row_version') is distinct from 'number'
    or coalesce(p_input->>'registered_version','') !~ '^[0-9]{1,40}$'
    or not (p_input ? 'observed_version') or not (p_input ? 'access_digest')
    or (p_input->'observed_version'<>'null'::jsonb and coalesce(p_input->>'observed_version','') !~ '^[0-9]{1,40}$')
    or (p_input->'access_digest'<>'null'::jsonb and coalesce(p_input->>'access_digest','') !~ '^[0-9a-f]{64}$') then
    raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
  select co.owner_id into u from clued_private.storage_connections_v1 co where co.id=(p_input->>'connection_id')::uuid;
  if u is null then raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
  select pr.* into p from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u where co.id=(p_input->>'connection_id')::uuid;
  if p.id is null then raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||p.root_folder_id,0));
  perform clued_private.storage_root_quiet_v1(u,p.root_folder_id);
  perform clued_private.authorization_account_v12(u);
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for share;
  select * into policy from clued_private.storage_account_policies_v2
    where id=c.account_policy_id and owner_id=u and connection_id=c.id for share;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u for share;
  select * into a from clued_private.resource_center_artifacts_v1
    where id=(p_input->>'artifact_id')::uuid and user_id=u and profile_id=p.id for update;
  if c.provider<>'google-drive' or c.oauth_client_id is distinct from app.oauth_client_id or c.revoked_at is not null
    or c.auth_mode<>'account_policy' or c.state<>'active' or not clued_private.storage_envelope_valid_v1(c.credential_envelope)
    or policy.id is null or policy.state<>'active' or policy.revoked_at is not null
    or coalesce(policy.expires_at<=clock_timestamp(),false) or p.state<>'active' or p.version<>c.profile_version
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,policy.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(u,p.project_id,p.source_decision_id)
    or a.id is null or a.state<>'active' or a.target_kind<>'directory'
    or a.provider_sharing_digest is not null or a.provider_access_digest is not null or a.access_digest_missing_at is not null
    or exists(select 1 from clued_private.storage_root_denies_v2 d where d.owner_id=u and d.provider=c.provider
      and d.provider_subject=c.provider_subject and d.root_folder_id=p.root_folder_id and d.lineage_id is null and d.denied) then
    raise exception 'storage_access_digest_backfill_denied' using errcode='42501'; end if;
  if op='load' then
    -- Behind the others for 30 minutes; not a registry change (no version bump).
    update clued_private.resource_center_artifacts_v1 set access_digest_attempted_at=clock_timestamp() where id=a.id;
    return jsonb_build_object('status','read_only','owner_id',u,'connection_id',c.id,'artifact_id',a.id,
      'provider','google-drive','provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,
      'credential_version',c.credential_version,'credential_envelope',c.credential_envelope,
      'provider_file_id',a.provider_file_id,'registered_version',a.provider_file_version,'row_version',a.version,
      'execution_permitted',false);
  end if;
  -- commit: the row and its registered version are still the ones loaded.
  if a.version<>(p_input->>'row_version')::bigint or a.provider_file_version<>p_input->>'registered_version' then
    raise exception 'storage_access_digest_backfill_conflict' using errcode='40001'; end if;
  outcome:=case when p_input->>'observed_version'=a.provider_file_version and jsonb_typeof(p_input->'access_digest')='string'
    then 'recorded' else 'missing' end;
  req:=jsonb_build_object('idempotency_key','storage-access-digest-backfill:'||a.id::text||':'||a.version::text,
    'artifact_id',a.id,'path',a.path,'provider_file_id',a.provider_file_id,'registered_version',a.provider_file_version,
    'found',p_input->'found','observed_version',p_input->'observed_version','access_digest',p_input->'access_digest','outcome',outcome);
  r:=clued_private.m1_begin_receipt(u,null,'storage_access_digest_backfill',req,clued_private.m1_sha256(req));
  if r.status<>'pending' then raise exception 'storage_access_digest_backfill_conflict' using errcode='40001'; end if;
  update clued_private.resource_center_artifacts_v1 set
      provider_access_digest=case when outcome='recorded' then p_input->>'access_digest' end,
      access_digest_missing_at=case when outcome='missing' then clock_timestamp() end,
      version=version+1,updated_at=now(),receipt_id=r.id
    where id=a.id returning * into a;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:access_digest_backfilled',refs,
    'project:'||p.project_id::text,null,req-'idempotency_key',req->>'idempotency_key',r.request_sha256,
    'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  return jsonb_build_object('status','committed','outcome',outcome,'artifact_id',a.id,'receipt_id',r.id,'execution_permitted',false);
end $$;
revoke all on function public.clued_storage_access_digest_backfill_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_access_digest_backfill_v1(text,jsonb) to anon;
