-- StorageFineGrainedConcurrency.v0.1 §4.2, step 3a (Task 469700eb, Owner
-- Decision 3196d6f2): ancestors are matched by identity and digest, the
-- target keeps its own Drive version. This migration is the database half;
-- the Worker half (identity, executor, postconditions) follows in 3b.
--
-- A Drive folder's version moves whenever anything inside it changes, so
-- matching ancestors by version fails a job when an unrelated sibling changes.
-- A registered directory is matched by the first of: its access digest, its
-- sharing digest, its Drive version (resource_center_directory_match_v2, the
-- order of §4.1). An empty digest never matches (I10).
--
-- * load returns ancestor_match: every registered directory from the root to
--   the destination folder and to the source folder (not for a relocating
--   untrash, whose source sits in the trash), each with the way it is matched.
-- * A new-shape request carries provider_identity.ancestors, one entry per
--   such directory: {path, id, parent_id, match, value}, value being the
--   observed digest or version (null when it could not be read). The
--   authority then checks the set, each Drive ID and parent ID against the
--   registry (the root's parent is root_parent_id), and each value by its
--   mode (resource_center_ancestors_match_v1) instead of root_folder_version
--   and destination_parent_version. A version-matched directory is compared
--   by version only where it is today (the root and the destination folder);
--   elsewhere its version is not compared with the registry, as today, and
--   only the live re-resolution during the job watches it.
-- * storage_verified_result_v2 checks the same way, and compares the
--   registry ancestors saved by verified_record with the current ones by
--   identity, mode and matched value rather than as whole rows (for every
--   request; the root and destination folder of a request without ancestors
--   are still compared by version there).
-- * A request without ancestors is otherwise checked exactly as before, so
--   the old Worker keeps working between this migration and the release.
--   Adopt and directory move keep their own version and digest checks and
--   are refused with ancestors.
-- * The Owner's connection list reports the directories whose access digest
--   could not be established (access_digest_missing, up to 20 paths).
--
-- Each existing function is changed by an anchored patch with an exact hit
-- count.

-- The way a registered directory is matched, and whether a request value
-- matches it. The request states the mode it used; a different mode means the
-- registry changed after load.
create function clued_private.resource_center_directory_match_v2(p_registered_version text,p_registered_sharing text,
  p_registered_access text,p_request_mode text,p_request_value text) returns text
language sql immutable set search_path='' as $$
  select case
    when p_request_mode is distinct from case when p_registered_access is not null then 'access'
      when p_registered_sharing is not null then 'sharing' else 'version' end then 'match_changed'
    when p_request_mode='access' then case when p_request_value is null then 'access_unavailable'
      when p_request_value=p_registered_access then 'match' else 'access_changed' end
    when p_request_mode='sharing' then case when p_request_value is null then 'sharing_unavailable'
      when p_request_value=p_registered_sharing then 'match' else 'sharing_changed' end
    when p_request_value is not null and p_request_value=p_registered_version then 'match'
    else 'version_mismatch' end
$$;

-- The folders a mutation works in: the destination's folder, and the
-- source's folder unless the source is in the trash and the untrash
-- relocates it.
create function clued_private.resource_center_ancestor_parents_v1(p_mutation jsonb) returns text[]
language sql immutable set search_path='' as $$
  select coalesce(array_agg(distinct x order by x),'{}'::text[]) from unnest(array[
    case when p_mutation->>'destination_path' is not null then left(p_mutation->>'destination_path',
      char_length(p_mutation->>'destination_path')-strpos(reverse(p_mutation->>'destination_path'),'/')) end,
    case when p_mutation->>'source_path' is not null
      and not (p_mutation->>'operation'='restore' and p_mutation->>'destination_path' is not null)
      then left(p_mutation->>'source_path',char_length(p_mutation->>'source_path')-strpos(reverse(p_mutation->>'source_path'),'/')) end]) x
    where x is not null
$$;

-- The registered directories on the way from the root to those folders: every
-- path prefix of each folder, looked up by (profile_id, path).
create function clued_private.resource_center_ancestor_rows_v1(p_profile uuid,p_user uuid,p_parents text[])
returns setof clued_private.resource_center_artifacts_v1
language sql stable security definer set search_path='' as $$
  select a.* from clued_private.resource_center_artifacts_v1 a
    where a.profile_id=p_profile and a.user_id=p_user and a.state='active' and a.target_kind='directory'
      and a.path=any(array(select left(q,i) from unnest(p_parents) q, generate_series(1,char_length(q)) i
        where i=char_length(q) or substr(q,i+1,1)='/'))
$$;

-- load's descriptor: which directories the identity reads and how each is
-- matched.
create function clued_private.storage_ancestor_match_v1(p clued_private.resource_center_profiles_v1,p_owner uuid,p_mutation jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('path',a.path,'provider_file_id',a.provider_file_id,'match',
      case when a.provider_access_digest is not null then 'access'
        when a.provider_sharing_digest is not null then 'sharing' else 'version' end) order by a.path collate "C"),'[]'::jsonb)
    from clued_private.resource_center_ancestor_rows_v1(p.id,p_owner,clued_private.resource_center_ancestor_parents_v1(p_mutation)) a
$$;

-- 'match', or why the request's ancestors do not match the registry:
-- ancestors_invalid, ancestor_set_mismatch, ancestor_identity_mismatch, or a
-- directory_match_v2 reason prefixed root_ (the root), parent_ (a folder the
-- mutation works in) or ancestor_ (in between).
create function clued_private.resource_center_ancestors_match_v1(p clued_private.resource_center_profiles_v1,
  p_provider jsonb,p_mutation jsonb) returns text
language plpgsql stable security definer set search_path='' as $$
declare list jsonb:=p_provider->'ancestors'; parents text[]; destination_parent text; e jsonb;
  a clued_private.resource_center_artifacts_v1; registered_parent text; prefix text; reason text;
begin
  if jsonb_typeof(list) is distinct from 'array' or jsonb_array_length(list) not between 1 and 64 then return 'ancestors_invalid'; end if;
  for e in select x from jsonb_array_elements(list) x loop
    if jsonb_typeof(e)<>'object' then return 'ancestors_invalid'; end if;
    if (select array_agg(k order by k collate "C") from jsonb_object_keys(e) k)<>array['id','match','parent_id','path','value']
      or jsonb_typeof(e->'path')<>'string' or coalesce(e->>'id','') !~ '^[A-Za-z0-9_-]{1,160}$'
      or coalesce(e->>'parent_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
      or coalesce(e->>'match','') not in ('access','sharing','version')
      or jsonb_typeof(e->'value') not in ('string','null') or char_length(coalesce(e->>'value',''))>200 then
      return 'ancestors_invalid'; end if;
  end loop;
  if (select count(distinct x->>'path') from jsonb_array_elements(list) x)<>jsonb_array_length(list) then return 'ancestors_invalid'; end if;
  parents:=clued_private.resource_center_ancestor_parents_v1(p_mutation);
  if cardinality(parents)=0 then return 'ancestors_invalid'; end if;
  destination_parent:=case when p_mutation->>'destination_path' is not null then left(p_mutation->>'destination_path',
    char_length(p_mutation->>'destination_path')-strpos(reverse(p_mutation->>'destination_path'),'/')) end;
  -- The request names exactly the registered directories on the way, which
  -- include the root and every folder the mutation works in.
  if (select array_agg(r.path order by r.path collate "C") from clued_private.resource_center_ancestor_rows_v1(p.id,p.user_id,parents) r)
      is distinct from (select array_agg(x->>'path' order by x->>'path' collate "C") from jsonb_array_elements(list) x)
    or not (p.managed_root=any(array(select x->>'path' from jsonb_array_elements(list) x)))
    or not (parents<@array(select x->>'path' from jsonb_array_elements(list) x)) then
    return 'ancestor_set_mismatch'; end if;
  for a in select * from clued_private.resource_center_ancestor_rows_v1(p.id,p.user_id,parents) r order by r.path collate "C" loop
    select x into e from jsonb_array_elements(list) x where x->>'path'=a.path;
    registered_parent:=case when a.path=p.managed_root then p.root_parent_id else (
      select b.provider_file_id from clued_private.resource_center_artifacts_v1 b
        where b.profile_id=p.id and b.user_id=p.user_id and b.state='active' and b.target_kind='directory'
          and b.path=left(a.path,char_length(a.path)-strpos(reverse(a.path),'/'))) end;
    if e->>'id' is distinct from a.provider_file_id or e->>'parent_id' is distinct from registered_parent then
      return 'ancestor_identity_mismatch'; end if;
    prefix:=case when a.path=p.managed_root then 'root_' when a.path=any(parents) then 'parent_' else 'ancestor_' end;
    reason:=clued_private.resource_center_directory_match_v2(a.provider_file_version,a.provider_sharing_digest,
      a.provider_access_digest,e->>'match',e->>'value');
    -- A registered version drifts with every change inside the folder; it is
    -- compared only where it is compared today.
    if reason='version_mismatch' and a.path<>p.managed_root and a.path is distinct from destination_parent then reason:='match'; end if;
    if reason<>'match' then return prefix||reason; end if;
  end loop;
  return 'match';
end $$;

-- What settle_verified compares of the registry ancestors saved by
-- verified_record: identity, governance and the value each is matched by.
create function clued_private.resource_center_ancestor_rows_identity_v1(p_rows jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_rows)='array' then coalesce((select jsonb_agg(jsonb_build_object(
      'id',x->'id','path',x->'path','state',x->'state','target_kind',x->'target_kind',
      'provider_file_id',x->'provider_file_id','governance_class',x->'governance_class',
      'delete_authority',x->'delete_authority','source_decision_id',x->'source_decision_id',
      'match',case when x->>'provider_access_digest' is not null then 'access'
        when x->>'provider_sharing_digest' is not null then 'sharing' else 'version' end,
      'value',case when x->>'provider_access_digest' is not null then x->'provider_access_digest'
        when x->>'provider_sharing_digest' is not null then x->'provider_sharing_digest' else x->'provider_file_version' end)
      order by n) from jsonb_array_elements(p_rows) with ordinality r(x,n)),'[]'::jsonb) else p_rows end
$$;

revoke all on function clued_private.resource_center_directory_match_v2(text,text,text,text,text),
  clued_private.resource_center_ancestor_parents_v1(jsonb),
  clued_private.resource_center_ancestor_rows_v1(uuid,uuid,text[]),
  clued_private.storage_ancestor_match_v1(clued_private.resource_center_profiles_v1,uuid,jsonb),
  clued_private.resource_center_ancestors_match_v1(clued_private.resource_center_profiles_v1,jsonb,jsonb),
  clued_private.resource_center_ancestor_rows_identity_v1(jsonb)
  from public,anon,authenticated,service_role;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- Adopt and a directory move keep their version checks (§4.2).
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  select * into v_binding from clued_private.resource_center_bindings_v1$a$,
     $r$  if v_provider ? 'ancestors' and (v_operation='adopt'
      or (v_operation='move' and v_mutation->>'target_kind'='directory')) then
    return jsonb_build_object('status','denied','reason','request_invalid');
  end if;
  select * into v_binding from clued_private.resource_center_bindings_v1$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  v_existing boolean;$a$,
     $r$  v_existing boolean;
  v_match text;$r$,1),
    -- A new-shape request matches the root among its ancestors.
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  if clued_private.resource_center_directory_match_v1(v_root.provider_file_version,v_root.provider_sharing_digest,$a$,
     $r$  if not (v_provider ? 'ancestors') and clued_private.resource_center_directory_match_v1(v_root.provider_file_version,v_root.provider_sharing_digest,$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$    if clued_private.resource_center_directory_match_v1(v_parent.provider_file_version,v_parent.provider_sharing_digest,
        v_provider->>'destination_parent_version',v_provider->>'destination_parent_sharing_digest') is distinct from 'match' then$a$,
     $r$    if not (v_provider ? 'ancestors') and clued_private.resource_center_directory_match_v1(v_parent.provider_file_version,v_parent.provider_sharing_digest,
        v_provider->>'destination_parent_version',v_provider->>'destination_parent_sharing_digest') is distinct from 'match' then$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  if v_source.id is not null then v_selected:=v_source;$a$,
     $r$  if v_provider ? 'ancestors' then
    v_match:=clued_private.resource_center_ancestors_match_v1(v_profile,v_provider,v_mutation);
    if v_match is distinct from 'match' then
      return jsonb_build_object('status','denied','reason',coalesce(v_match,'ancestors_invalid'));
    end if;
  end if;
  if v_source.id is not null then v_selected:=v_source;$r$,1),
    -- Settlement: same rules, and registry ancestors compared by identity.
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    if ancestors is distinct from saved->'ancestors' then$a$,
     $r$    if clued_private.resource_center_ancestor_rows_identity_v1(ancestors)
      is distinct from clued_private.resource_center_ancestor_rows_identity_v1(saved->'ancestors') then$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    or (not (j.mutation->>'operation' in ('delete','restore','adopt') and not (j.mutation ? 'destination_path'))$a$,
     $r$    or (not (m.authority_request->'provider_identity' ? 'ancestors')
      and not (j.mutation->>'operation' in ('delete','restore','adopt') and not (j.mutation ? 'destination_path'))$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$      and clued_private.resource_center_directory_match_v1(provider_file_version,provider_sharing_digest,
        m.authority_request->'provider_identity'->>'root_folder_version',
        m.authority_request->'provider_identity'->>'root_sharing_digest')='match') then$a$,
     $r$      and (m.authority_request->'provider_identity' ? 'ancestors'
        or clued_private.resource_center_directory_match_v1(provider_file_version,provider_sharing_digest,
        m.authority_request->'provider_identity'->>'root_folder_version',
        m.authority_request->'provider_identity'->>'root_sharing_digest')='match'))
    or (m.authority_request->'provider_identity' ? 'ancestors'
      and clued_private.resource_center_ancestors_match_v1(p,m.authority_request->'provider_identity',
        m.authority_request->'mutation') is distinct from 'match') then$r$,1),
    -- load tells the identity which directories to read and how to match each.
    ('clued_private.storage_cloud_worker_v2(text,jsonb)',
     $a$      'untrash_source',clued_private.storage_untrash_source_v1(j),$a$,
     $r$      'untrash_source',clued_private.storage_untrash_source_v1(j),
      'ancestor_match',clued_private.storage_ancestor_match_v1(p,c.owner_id,j.mutation),$r$,1),
    -- The Owner's connection list: directories still matched by version
    -- because their access digest could not be established.
    ('public.clued_storage_owner_manage_v2(jsonb)',
     $a$      'profile_current',pr.state='active' and pr.version=co.profile_version) order by co.id)$a$,
     $r$      'profile_current',pr.state='active' and pr.version=co.profile_version,
      'access_digest_missing',jsonb_build_object(
        'count',(select count(*) from clued_private.resource_center_artifacts_v1 x
          where x.profile_id=pr.id and x.user_id=u and x.state='active' and x.access_digest_missing_at is not null),
        'directories',coalesce((select jsonb_agg(jsonb_build_object('path',y.path,'since',y.since) order by y.path collate "C")
          from (select substr(x.path,char_length(pr.managed_root)+2) path,x.access_digest_missing_at since
            from clued_private.resource_center_artifacts_v1 x
            where x.profile_id=pr.id and x.user_id=u and x.state='active' and x.access_digest_missing_at is not null
            order by x.path collate "C" limit 20) y),'[]'::jsonb))) order by co.id)$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Every edit of one function first, then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_ancestor_identity_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;
