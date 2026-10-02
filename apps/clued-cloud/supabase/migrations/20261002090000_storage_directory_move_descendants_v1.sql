-- StorageFullCapability.v0.1 P6.1 (Owner Decision e5e99da8): a directory move
-- refreshes the registered Drive versions of the items under it.
--
-- The P6 production acceptance (Note 23d63403) showed that Google Drive
-- advances the version of every item under a folder each time the folder
-- moves, while their content stays the same. The P6 settlement rewrote their
-- paths only, so a later rename, file move, replace or trash of any of them was
-- refused for a registered version older than Drive's.
--
-- * The durable start also returns every active or trashed registered
--   descendant (Drive ID, relative path, kind, state, registered version; at
--   most 500, the authority's own cap): subtree_registry. Drive advances
--   trashed items under the folder too.
-- * Before the attempt, the executor reads them by Drive ID and records in the
--   attempt (descendants) those whose live state is exactly the registry's
--   (same version, name, kind and folder), with each file's size and sha256.
--   The attempt must name registered rows at exactly those versions.
-- * After the move, the verifier reads them again; the proof names
--   (descendant_versions) the new Drive version of each one that still sits
--   at the same place with the same name, kind and content and whose version
--   did not go backwards. The verified record accepts only items of the
--   attempt, each at most once, at a version not below the recorded one.
-- * The settlement (artifact_subtree_move) sets each of those versions by CAS
--   on the recorded version, in the same transaction as the path rewrite. An
--   item left out, or changed since, keeps its registered version: it stays
--   refused as before (fail closed), never refreshed from a guess.
-- * Each existing function is changed by an anchored patch with an exact hit
--   count. Migration first, then the release: until the release the old
--   executor's attempt has no descendants and is refused before any update.

-- Every active or trashed registered descendant of a directory, shallowest first.
create function clued_private.storage_subtree_registry_v1(p_profile uuid,p_user uuid,p_path text)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('provider_file_id',x.provider_file_id,
      'relative_path',substr(x.path,char_length(p_path)+2),'target_kind',x.target_kind,'state',x.state,
      'provider_file_version',x.provider_file_version)
      order by char_length(x.path)-char_length(replace(x.path,'/','')),x.path collate "C"),'[]'::jsonb)
  from clued_private.resource_center_artifacts_v1 x
  where x.profile_id=p_profile and x.user_id=p_user and x.state in ('active','trashed')
    and left(x.path,char_length(p_path)+1)=p_path||'/'
$$;

-- The attempt's descendants: exact shape; with p_strict, each must be an
-- active or trashed registered row (as named) under the directory at exactly the recorded version
-- (when the attempt is recorded). The verified record checks the stored
-- attempt's shape only. Null when anything is off.
create function clued_private.storage_subtree_descendants_v1(m clued_private.resource_center_mutations_v1,
  j clued_private.storage_jobs_v1,p_list jsonb,p_strict boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e jsonb;
begin
  if jsonb_typeof(p_list) is distinct from 'array' or jsonb_array_length(p_list)>500
    or (select count(distinct x->>'provider_file_id') from jsonb_array_elements(p_list) x)<>jsonb_array_length(p_list) then
    return null; end if;
  for e in select x from jsonb_array_elements(p_list) x loop
    if jsonb_typeof(e) is distinct from 'object'
      or (select array_agg(k order by k) from jsonb_object_keys(e) k)
        is distinct from array['provider_file_id','provider_file_version','relative_path','sha256','size','state','target_kind']
      or coalesce(e->>'state','') not in ('active','trashed')
      or coalesce(e->>'provider_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
      or coalesce(e->>'provider_file_version','') !~ '^[0-9]{1,40}$'
      or jsonb_typeof(e->'relative_path') is distinct from 'string' or length(e->>'relative_path') not between 1 and 1000
      or e->>'relative_path' ~ '(\\|//|^/|/$|^\.\.?/|/\.\.?/|/\.\.?$|^\.\.?$)'
      or coalesce(e->>'target_kind','') not in ('file','directory')
      or (e->>'target_kind'='directory' and (e->'size' is distinct from 'null'::jsonb or e->'sha256' is distinct from 'null'::jsonb))
      or (e->>'target_kind'='file' and (jsonb_typeof(e->'size') is distinct from 'string' or e->>'size' !~ '^(0|[1-9][0-9]{0,19})$'
        or jsonb_typeof(e->'sha256') is distinct from 'string' or e->>'sha256' !~ '^[0-9a-f]{64}$')) then
      return null; end if;
    if p_strict and not exists(select 1 from clued_private.resource_center_artifacts_v1 x
        where x.profile_id=m.profile_id and x.user_id=m.user_id and x.state=e->>'state'
          and x.path=(j.mutation->>'source_path')||'/'||(e->>'relative_path')
          and x.provider_file_id=e->>'provider_file_id' and x.target_kind=e->>'target_kind'
          and x.provider_file_version=e->>'provider_file_version') then
      return null; end if;
  end loop;
  return p_list;
end $$;

-- The proof's refreshed versions: each an item of the attempt, at most once,
-- at a Drive version not below the recorded one. Null when anything is off.
create function clued_private.storage_subtree_refresh_v1(p_descendants jsonb,p_versions jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare e jsonb; recorded text;
begin
  if jsonb_typeof(p_descendants) is distinct from 'array' or jsonb_typeof(p_versions) is distinct from 'array'
    or jsonb_array_length(p_versions)>jsonb_array_length(p_descendants)
    or (select count(distinct x->>'provider_file_id') from jsonb_array_elements(p_versions) x)<>jsonb_array_length(p_versions) then
    return null; end if;
  for e in select x from jsonb_array_elements(p_versions) x loop
    if jsonb_typeof(e) is distinct from 'object'
      or (select array_agg(k order by k) from jsonb_object_keys(e) k) is distinct from array['provider_file_id','provider_file_version']
      or coalesce(e->>'provider_file_version','') !~ '^[1-9][0-9]{0,39}$' then return null; end if;
    select d->>'provider_file_version' into recorded from jsonb_array_elements(p_descendants) d
      where d->>'provider_file_id'=e->>'provider_file_id';
    if recorded is null or (e->>'provider_file_version')::numeric<recorded::numeric then return null; end if;
  end loop;
  return p_versions;
end $$;

-- The settlement's refresh list: each refreshed item with the version the
-- attempt recorded (the CAS base). Empty when nothing is refreshed.
create function clued_private.storage_subtree_refresh_input_v1(p_descendants jsonb,p_versions jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select coalesce((select jsonb_agg(jsonb_build_object('provider_file_id',v->>'provider_file_id',
      'base_version',d->>'provider_file_version','state',d->>'state','provider_file_version',v->>'provider_file_version')
      order by v->>'provider_file_id' collate "C")
    from jsonb_array_elements(case when jsonb_typeof(p_versions)='array' then p_versions else '[]'::jsonb end) v
    join jsonb_array_elements(case when jsonb_typeof(p_descendants)='array' then p_descendants else '[]'::jsonb end) d
      on d->>'provider_file_id'=v->>'provider_file_id'),'[]'::jsonb)
$$;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- The durable start returns every registered descendant too.
    ('clued_private.storage_job_begin_v2(uuid,uuid,text,jsonb)',
     $a$jsonb_build_object('subtree_sample',
      clued_private.storage_subtree_sample_v1(p.id,p_owner,j.mutation->>'source_path'))$a$,
     $r$jsonb_build_object('subtree_sample',
      clued_private.storage_subtree_sample_v1(p.id,p_owner,j.mutation->>'source_path'),
      'subtree_registry',clued_private.storage_subtree_registry_v1(p.id,p_owner,j.mutation->>'source_path'))$r$,1),
    -- The attempt names the matching descendants at their registered versions.
    ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)',
     $a$    expected:=clued_private.storage_subtree_attempt_v1(m,j,null);$a$,
     $r$    expected:=clued_private.storage_subtree_attempt_v1(m,j,null)||jsonb_build_object('descendants',
      clued_private.storage_subtree_descendants_v1(m,j,p_attempt->'descendants',true));$r$,1),
    -- The verified record repeats the stored attempt and checks the refresh.
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$      attempt_expected:=clued_private.storage_subtree_attempt_v1(m,j,m.provider_attempt->'subtree_sample');$a$,
     $r$      attempt_expected:=clued_private.storage_subtree_attempt_v1(m,j,m.provider_attempt->'subtree_sample')
        ||jsonb_build_object('descendants',clued_private.storage_subtree_descendants_v1(m,j,m.provider_attempt->'descendants',false));$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$        'source_file_version',j.mutation->>'source_file_version','subtree_sample',attempt_expected->'subtree_sample',$a$,
     $r$        'source_file_version',j.mutation->>'source_file_version','subtree_sample',attempt_expected->'subtree_sample',
        'descendant_versions',clued_private.storage_subtree_refresh_v1(attempt_expected->'descendants',proof->'descendant_versions'),$r$,1),
    -- The settlement carries the refresh list with its CAS bases.
    ('clued_private.storage_settle_input_v1(uuid,clued_private.resource_center_mutations_v1,jsonb)',
     $a$      'path',p_proof->>'path','provider_file_id',p_proof->>'provider_file_id','provider_file_version',p_proof->>'provider_file_version')
  when m.authority_request->'mutation'->>'operation' in ('delete','restore') then$a$,
     $r$      'path',p_proof->>'path','provider_file_id',p_proof->>'provider_file_id','provider_file_version',p_proof->>'provider_file_version',
      'descendant_versions',clued_private.storage_subtree_refresh_input_v1(m.provider_attempt->'descendants',p_proof->'descendant_versions'))
  when m.authority_request->'mutation'->>'operation' in ('delete','restore') then$r$,1),
    -- The registry change: only the verified intent's own refresh list, each
    -- item by CAS on its recorded version, under the new path.
    ('clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)',
     $a$        and m.verified_result_v2->'proof'->>'provider_file_version' is not distinct from p_input->>'provider_file_version') then$a$,
     $r$        and m.verified_result_v2->'proof'->>'provider_file_version' is not distinct from p_input->>'provider_file_version'
        and p_input->'descendant_versions' is not distinct from clued_private.storage_subtree_refresh_input_v1(
          m.provider_attempt->'descendants',m.verified_result_v2->'proof'->'descendant_versions')) then$r$,1),
    ('clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)',
     $a$  update clued_private.resource_center_artifacts_v1
    set path=v_path,provider_file_version=p_input->>'provider_file_version',$a$,
     $r$  -- P6.1: each refreshed descendant's new Drive version, by CAS on the
  -- version the attempt recorded; one that changed since keeps its own.
  update clued_private.resource_center_artifacts_v1 x set provider_file_version=d->>'provider_file_version'
    from jsonb_array_elements(p_input->'descendant_versions') d
    where x.profile_id=p.id and x.user_id=p.user_id and x.state=d->>'state'
      and x.provider_file_id=d->>'provider_file_id' and x.provider_file_version=d->>'base_version'
      and left(x.path,char_length(v_path)+1)=v_path||'/';
  update clued_private.resource_center_artifacts_v1
    set path=v_path,provider_file_version=p_input->>'provider_file_version',$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Paired edits are applied together: every edit of one function first,
    -- then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_directory_move_descendants_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_subtree_registry_v1(uuid,uuid,text),
  clued_private.storage_subtree_descendants_v1(clued_private.resource_center_mutations_v1,clued_private.storage_jobs_v1,jsonb,boolean),
  clued_private.storage_subtree_refresh_v1(jsonb,jsonb),
  clued_private.storage_subtree_refresh_input_v1(jsonb,jsonb)
  from public,anon,authenticated,service_role;
