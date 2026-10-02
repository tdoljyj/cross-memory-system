-- StorageFullCapability.v0.1 P6 (§3.1, §3.2, §6.2, T14; Owner Decisions
-- c47efe38 and 746fd078): move one registered directory, with everything
-- under it, to another registered folder under a separate modify_subtree
-- write level. Built on the same account-policy job chain as P3-B, P4 and
-- P5; every existing function is changed by an anchored patch with an exact
-- hit count, never rewritten.
--
-- * Policies gain the action "modify_subtree". A /3 policy's action set is
--   the create set plus any of modify, overwrite, destructive, modify_subtree
--   in that order (clued_private.storage_write_actions_v1). The native switch
--   toggles it like the other levels, with its own disclosure
--   (clued.storage-subtree-disclosure/1).
-- * Submit accepts {operation: move, target_kind: directory, source_path,
--   destination_path, source_file_version, source_file_id}: the directory is
--   named by its Drive ID, path and observed version, keeps its name and
--   changes folder, never into itself or below itself. A track (a direct child
--   of the root) is never moved.
-- * The Artifact authority requires, for a directory move: the registered
--   directory (by Drive ID and its sharing state, as for every registered
--   directory, since Drive advances folder versions when children change);
--   its registered folder as Drive reports it; the destination not inside the
--   directory and nothing registered at or under the destination; both folders
--   with exactly the same sharing state (sharing_differs otherwise), so the
--   inherited access of the moved subtree does not change; at most 500
--   registered items under the directory (subtree_too_large).
-- * In-flight work under the subtree (T14) is excluded by the existing single
--   writer per profile: no other intent can be prepared, started or
--   uncertain while the move is, and the move cannot start while another is.
--   A queued job that names an old path fails its own provider lookup.
-- * The provider attempt (clued.storage-subtree-move-attempt/1) names the
--   directory, both folders, both paths and up to 10 registered descendants
--   chosen by the server (shallowest first, then by path) that the verifier
--   re-reads by Drive ID after the move. The verified proof is
--   clued.storage-directory-move-verified/1 (identity, ancestors,
--   stable_state, unique_name, source_vacated, sharing_unchanged, subtree).
-- * Settlement (artifact_subtree_move) changes, in the one settlement
--   transaction, the directory's path and observed Drive version by CAS on the
--   version the authority saw, and the path of every active or trashed item
--   under it. Nothing is rewritten from a partial observation.
-- * An uncertain directory move is never settled automatically (§6.2):
--   scheduled recovery does not load it. Only the Owner's native recovery
--   re-verifies it by GET and settles through the same verified record.

-- Action sets: the create set plus an ordered subset of the write levels.
create function clued_private.storage_write_actions_v1(p_actions text[])
returns boolean language sql immutable set search_path='' as $$
  select p_actions is not null and p_actions=array['inspect','create_file','create_topic']::text[]||array(
    select x from unnest(array['modify','overwrite','destructive','modify_subtree']::text[]) with ordinality u(x,n)
    where x=any(p_actions) order by n)
$$;
alter table clued_private.storage_account_policies_v2
  drop constraint storage_account_policies_v2_actions_check,
  add constraint storage_account_policies_v2_actions_check check(
    actions=array['inspect','create_file','create_topic']::text[]
    or (scope_contract='clued.storage-account-scope/3' and clued_private.storage_write_actions_v1(actions)));

-- Exact directory move shape after path canonicalization.
create function clued_private.storage_subtree_shape_v1(m jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare sp text; dp text; bad constant text:='(\\|//|/\./|/\.\./|/\.$|/\.\.$|/$)';
begin
  if jsonb_typeof(m) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(m) k)
      is distinct from array['destination_path','operation','source_file_id','source_file_version','source_path','target_kind']
    or m->>'operation' is distinct from 'move' or m->>'target_kind' is distinct from 'directory'
    or jsonb_typeof(m->'source_path') is distinct from 'string' or jsonb_typeof(m->'destination_path') is distinct from 'string'
    or jsonb_typeof(m->'source_file_version') is distinct from 'string' or coalesce(m->>'source_file_version','') !~ '^[1-9][0-9]{0,39}$'
    or jsonb_typeof(m->'source_file_id') is distinct from 'string' or coalesce(m->>'source_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then
    return false; end if;
  sp:=m->>'source_path'; dp:=m->>'destination_path';
  if length(sp) not between 1 and 1000 or length(dp) not between 1 and 1000
    or sp ~ bad or dp ~ bad or strpos(sp,'/')=0 or strpos(dp,'/')=0 then return false; end if;
  return regexp_replace(sp,'/[^/]*$','')<>regexp_replace(dp,'/[^/]*$','')
    and substring(sp from '[^/]*$')=substring(dp from '[^/]*$')
    and dp<>sp and left(dp,char_length(sp)+1)<>sp||'/';
end $$;

-- Registry hint at submit, only after the evaluator authenticated the Binding
-- and the modify_subtree level: a track is never moved (the authority decides
-- again under its locks).
create function clued_private.storage_subtree_target_v1(p_connection uuid,m jsonb)
returns void language plpgsql stable security definer set search_path='' as $$
declare root text;
begin
  select pr.managed_root into root from clued_private.storage_connections_v1 c
    join clued_private.resource_center_profiles_v1 pr on pr.id=c.profile_id and pr.user_id=c.owner_id
    where c.id=p_connection;
  if root is not null and regexp_replace(m->>'source_path','/[^/]*$','')=root then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
end $$;

-- The registered descendants a directory move re-reads after the effect: up
-- to 10 active items under the directory, shallowest first, then by path,
-- each by Drive ID and its path relative to the directory.
create function clued_private.storage_subtree_sample_v1(p_profile uuid,p_user uuid,p_path text)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('provider_file_id',x.provider_file_id,
      'relative_path',substr(x.path,char_length(p_path)+2),'target_kind',x.target_kind)
      order by x.depth,x.path collate "C"),'[]'::jsonb)
  from (select a.provider_file_id,a.path,a.target_kind,
      char_length(a.path)-char_length(replace(a.path,'/','')) depth
    from clued_private.resource_center_artifacts_v1 a
    where a.profile_id=p_profile and a.user_id=p_user and a.state='active'
      and left(a.path,char_length(p_path)+1)=p_path||'/'
    order by depth,a.path collate "C" limit 10) x
$$;

-- Expected provider attempt of a directory move: the directory and both
-- folders are the authority's provider identity, the directory is the one the
-- job names by Drive ID, and the descendants are the server's sample.
create function clued_private.storage_subtree_attempt_v1(m clued_private.resource_center_mutations_v1,
  j clued_private.storage_jobs_v1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare pi jsonb:=m.authority_request->'provider_identity';
begin
  if j.mutation->>'source_file_version' is distinct from pi->>'source_file_version'
    or j.mutation->>'source_file_id' is distinct from pi->>'source_file_id'
    or coalesce(pi->>'source_parent_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
    or coalesce(pi->>'destination_parent_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then
    return null; end if;
  return jsonb_build_object('contract','clued.storage-subtree-move-attempt/1','intent_id',m.id,'request_sha256',m.request_sha256,
    'profile_id',m.profile_id,'operation','move','target_kind','directory',
    'provider_file_id',pi->>'source_file_id','source_path',j.mutation->>'source_path',
    'source_file_version',j.mutation->>'source_file_version','source_parent_id',pi->>'source_parent_id',
    'destination_path',j.mutation->>'destination_path','parent_id',pi->>'destination_parent_id',
    'subtree_sample',clued_private.storage_subtree_sample_v1(m.profile_id,m.user_id,j.mutation->>'source_path'),
    'binding',m.exact_request->'binding');
end $$;

-- Registry change of a verified directory move (T14): the directory's path
-- and observed Drive version by CAS on its version, and the path of every
-- active or trashed item under it, in this one transaction. Same name, a
-- registered folder under the root (never the root itself), nothing
-- registered at or under the new path, never below the old one.
create function clued_private.storage_subtree_move_v1(p clued_private.resource_center_profiles_v1,
  a clued_private.resource_center_artifacts_v1,p_input jsonb,p_decision uuid,p_receipt uuid)
returns clued_private.resource_center_artifacts_v1 language plpgsql security definer set search_path='' as $$
declare v_path text:=p_input->>'path'; old text:=a.path; root text:=p.managed_root; parent text;
  moved clued_private.resource_center_artifacts_v1;
begin
  if p_input->>'provider_file_id' is distinct from a.provider_file_id
    or coalesce(p_input->>'provider_file_version','') !~ '^[0-9]+$' or v_path is null
    or v_path=old or left(v_path,char_length(old)+1)=old||'/'
    or left(v_path,char_length(root)+1)<>root||'/' or right(v_path,1)='/'
    or position(E'\\' in v_path)>0 or position('..' in v_path)>0
    or regexp_replace(v_path,'^.*/','')<>regexp_replace(old,'^.*/','')
    or regexp_replace(old,'/[^/]*$','')=root then
    raise exception 'resource_center_artifact_invalid' using errcode='22023'; end if;
  parent:=left(v_path,char_length(v_path)-strpos(reverse(v_path),'/'));
  if parent=root or not exists(select 1 from clued_private.resource_center_artifacts_v1 x
      where x.profile_id=p.id and x.path=parent and x.state='active' and x.target_kind='directory') then
    raise exception 'resource_center_parent_unregistered' using errcode='22023'; end if;
  if exists(select 1 from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id
      and x.state in ('active','trashed') and (x.path=v_path or left(x.path,char_length(v_path)+1)=v_path||'/')) then
    raise exception 'resource_center_artifact_conflict' using errcode='40001'; end if;
  perform 1 from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id and x.user_id=p.user_id
    and x.state in ('active','trashed') and left(x.path,char_length(old)+1)=old||'/' order by x.id for update;
  update clued_private.resource_center_artifacts_v1 x
    set path=v_path||substr(x.path,char_length(old)+1),version=x.version+1,updated_at=now(),receipt_id=p_receipt
    where x.profile_id=p.id and x.user_id=p.user_id and x.state in ('active','trashed')
      and left(x.path,char_length(old)+1)=old||'/';
  update clued_private.resource_center_artifacts_v1
    set path=v_path,provider_file_version=p_input->>'provider_file_version',version=version+1,updated_at=now(),
      source_decision_id=p_decision,receipt_id=p_receipt
    where id=a.id returning * into moved;
  return moved;
end $$;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- Write level and its native switch.
    ('clued_private.storage_policy_scope_digest_v3(uuid,text,text[])',
     $a$p_actions not in (
      array['inspect','create_file','create_topic']::text[],
      array['inspect','create_file','create_topic','modify']::text[],
      array['inspect','create_file','create_topic','overwrite']::text[],
      array['inspect','create_file','create_topic','modify','overwrite']::text[],
      array['inspect','create_file','create_topic','destructive']::text[],
      array['inspect','create_file','create_topic','modify','destructive']::text[],
      array['inspect','create_file','create_topic','overwrite','destructive']::text[],
      array['inspect','create_file','create_topic','modify','overwrite','destructive']::text[]) then$a$,
     $r$not clued_private.storage_write_actions_v1(p_actions) then$r$,1),
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$    or coalesce(p_action,'') not in ('inspect','create_file','create_topic','modify','overwrite','destructive') then$a$,
     $r$    or coalesce(p_action,'') not in ('inspect','create_file','create_topic','modify','overwrite','destructive','modify_subtree') then$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$  destructive_disclosure constant text:='clued.storage-destructive-disclosure/1';$a$,
     $r$  destructive_disclosure constant text:='clued.storage-destructive-disclosure/1';
  subtree_disclosure constant text:='clued.storage-subtree-disclosure/1';$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$      'destructive_disclosure_version',destructive_disclosure,$a$,
     $r$      'destructive_disclosure_version',destructive_disclosure,
      'subtree_disclosure_version',subtree_disclosure,$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$unnest(policy.actions) x where x in ('modify','overwrite','destructive')$a$,
     $r$unnest(policy.actions) x where x in ('modify','overwrite','destructive','modify_subtree')$r$,2),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$not (wanted <@ array['modify','overwrite','destructive']) then$a$,
     $r$not (wanted <@ array['modify','overwrite','destructive','modify_subtree']) then$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$(case toggled when 'overwrite' then overwrite_disclosure when 'destructive' then destructive_disclosure else disclosure end)$a$,
     $r$(case toggled when 'overwrite' then overwrite_disclosure when 'destructive' then destructive_disclosure
      when 'modify_subtree' then subtree_disclosure else disclosure end)$r$,1),
    ('public.clued_storage_write_access_v1(jsonb)',
     $a$  actions:=base_actions||array(select x from unnest(array['modify','overwrite','destructive']) x where x=any(wanted));$a$,
     $r$  actions:=base_actions||array(select x from unnest(array['modify','overwrite','destructive','modify_subtree']) x where x=any(wanted));$r$,1),
    -- Submit: shape, level and the track hint.
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$    if m->>'operation' in ('delete','restore') then
      wanted:='destructive';$a$,
     $r$    if m->>'operation'='move' and m->>'target_kind'='directory' then
      wanted:='modify_subtree';
      if not clued_private.storage_subtree_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m->>'operation' in ('delete','restore') then
      wanted:='destructive';$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$  if m->>'operation' in ('delete','restore') then perform clued_private.storage_destructive_target_v1(connection_id,m); end if;$a$,
     $r$  if m->>'operation' in ('delete','restore') then perform clued_private.storage_destructive_target_v1(connection_id,m); end if;
  if wanted='modify_subtree' then perform clued_private.storage_subtree_target_v1(connection_id,m); end if;$r$,1),
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$  wanted:=case when j.mutation->>'operation' in ('rename','move') then 'modify'$a$,
     $r$  wanted:=case when j.mutation->>'operation'='move' and j.mutation->>'target_kind'='directory' then 'modify_subtree'
    when j.mutation->>'operation' in ('rename','move') then 'modify'$r$,1),
    -- Artifact authority for a directory move.
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$        and provider_file_id=v_provider->>'source_file_id'
        and provider_file_version=v_provider->>'source_file_version'
        and target_kind=v_mutation->>'target_kind';$a$,
     $r$        and provider_file_id=v_provider->>'source_file_id'
        and (provider_file_version=v_provider->>'source_file_version'
          or (v_operation='move' and target_kind='directory'
            and clued_private.resource_center_directory_match_v1(provider_file_version,provider_sharing_digest,
              v_provider->>'source_file_version',v_provider->>'source_sharing_digest')='match'))
        and target_kind=v_mutation->>'target_kind';$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  if v_destination_path is not null then
    if left(v_destination_path,$a$,
     $r$  -- Directory move (P6): never a track; the directory's folder is its
  -- registered, current parent as Drive reports it; never into itself;
  -- nothing registered at or under the destination; both folders with the
  -- same sharing state; at most 500 registered items under the directory.
  if v_operation='move' and v_mutation->>'target_kind'='directory' then
    v_parent_path:=left(v_source_path,char_length(v_source_path)-strpos(reverse(v_source_path),'/'));
    if v_parent_path=v_profile.managed_root then
      return jsonb_build_object('status','denied','reason','track_forbidden');
    end if;
    if v_destination_path=v_source_path or left(v_destination_path,char_length(v_source_path)+1)=v_source_path||'/' then
      return jsonb_build_object('status','denied','reason','destination_inside_source');
    end if;
    select * into v_parent from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_parent_path and target_kind='directory'
        and provider_file_id=v_provider->>'source_parent_id';
    if not found then
      return jsonb_build_object('status','denied','reason','parent_unregistered');
    end if;
    if not clued_private.resource_center_path_current_v1(
      v_profile.user_id,v_profile.project_id,v_profile.id,
      v_profile.managed_root,v_parent_path) then
      return jsonb_build_object('status','denied','reason','parent_path_not_current');
    end if;
    if coalesce(v_provider->>'source_sharing_digest','') !~ '^[0-9a-f]{64}$'
      or coalesce(v_provider->>'source_parent_sharing_digest','') !~ '^[0-9a-f]{64}$'
      or v_provider->>'source_parent_sharing_digest' is distinct from v_provider->>'destination_parent_sharing_digest' then
      return jsonb_build_object('status','denied','reason','sharing_differs');
    end if;
    if exists(select 1 from clued_private.resource_center_artifacts_v1 a
        where a.profile_id=v_profile.id and a.state in ('active','trashed')
          and (a.path=v_destination_path or left(a.path,char_length(v_destination_path)+1)=v_destination_path||'/')) then
      return jsonb_build_object('status','denied','reason','destination_exists');
    end if;
    if (select count(*) from clued_private.resource_center_artifacts_v1 a
        where a.profile_id=v_profile.id and a.state in ('active','trashed')
          and left(a.path,char_length(v_source_path)+1)=v_source_path||'/')>500 then
      return jsonb_build_object('status','denied','reason','subtree_too_large');
    end if;
  end if;
  if v_destination_path is not null then
    if left(v_destination_path,$r$,1),
    -- Provider attempt.
    ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)',
     $a$  if j.mutation->>'operation' in ('rename','move') then
    expected:=clued_private.storage_modify_attempt_v1(m,j,p_attempt->'content');$a$,
     $r$  if j.mutation->>'operation'='move' and j.mutation->>'target_kind'='directory' then
    expected:=clued_private.storage_subtree_attempt_v1(m,j);
  elsif j.mutation->>'operation' in ('rename','move') then
    expected:=clued_private.storage_modify_attempt_v1(m,j,p_attempt->'content');$r$,1),
    -- Verified record and settlement.
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    if j.mutation->>'operation' in ('rename','move') then
      attempt_expected:=clued_private.storage_modify_attempt_v1(m,j,m.provider_attempt->'content');$a$,
     $r$    if j.mutation->>'operation'='move' and j.mutation->>'target_kind'='directory' then
      attempt_expected:=clued_private.storage_subtree_attempt_v1(m,j);
    elsif j.mutation->>'operation' in ('rename','move') then
      attempt_expected:=clued_private.storage_modify_attempt_v1(m,j,m.provider_attempt->'content');$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    elsif j.mutation->>'operation' in ('rename','move') then
      expected:=post||jsonb_build_object('contract','clued.storage-'||(j.mutation->>'operation')||'-verified/1',$a$,
     $r$    elsif j.mutation->>'operation'='move' and j.mutation->>'target_kind'='directory' then
      expected:=post||jsonb_build_object('contract','clued.storage-directory-move-verified/1',
        'operation','move','target_kind','directory','source_path',j.mutation->>'source_path',
        'source_file_version',j.mutation->>'source_file_version','subtree_sample',attempt_expected->'subtree_sample',
        'provider_before',m.authority_request->'provider_identity',
        'checks',jsonb_build_object('identity',true,'ancestors',true,'stable_state',true,'unique_name',true,
          'source_vacated',true,'sharing_unchanged',true,'subtree',true));
    elsif j.mutation->>'operation' in ('rename','move') then
      expected:=post||jsonb_build_object('contract','clued.storage-'||(j.mutation->>'operation')||'-verified/1',$r$,1),
    ('clued_private.storage_settle_authority_v1(uuid,clued_private.resource_center_profiles_v1,clued_private.resource_center_mutations_v1,jsonb,clued_private.resource_center_artifacts_v1)',
     $a$        and target_kind=case when p_mutation->>'operation' in ('delete','restore') then p_mutation->>'target_kind' else 'file' end$a$,
     $r$        and target_kind=case when p_mutation->>'operation' in ('delete','restore','move') then p_mutation->>'target_kind' else 'file' end$r$,1),
    ('clued_private.storage_settle_authority_v1(uuid,clued_private.resource_center_profiles_v1,clued_private.resource_center_mutations_v1,jsonb,clued_private.resource_center_artifacts_v1)',
     $a$        and provider_file_version=case when p_mutation->>'operation'='replace'
          then m.authority_request->'provider_identity'->>'destination_file_version' else m.authority_request->'provider_identity'->>'source_file_version' end;$a$,
     $r$        and (provider_file_version=case when p_mutation->>'operation'='replace'
          then m.authority_request->'provider_identity'->>'destination_file_version' else m.authority_request->'provider_identity'->>'source_file_version' end
          or (p_mutation->>'operation'='move' and p_mutation->>'target_kind'='directory'
            and clued_private.resource_center_directory_match_v1(provider_file_version,provider_sharing_digest,
              m.authority_request->'provider_identity'->>'source_file_version',
              m.authority_request->'provider_identity'->>'source_sharing_digest')='match'));$r$,1),
    ('clued_private.storage_settle_authority_v1(uuid,clued_private.resource_center_profiles_v1,clued_private.resource_center_mutations_v1,jsonb,clued_private.resource_center_artifacts_v1)',
     $a$      or (p_mutation->>'operation'='delete' and selected.governance_class='governance' and not selected.delete_authority)$a$,
     $r$      or (p_mutation->>'operation'='delete' and selected.governance_class='governance' and not selected.delete_authority)
      or (p_mutation->>'operation'='move' and p_mutation->>'target_kind'='directory'
        and (regexp_replace(selected.path,'/[^/]*$','')=p.managed_root
          or not exists(select 1 from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id and x.state='active'
            and x.target_kind='directory' and x.path=regexp_replace(selected.path,'/[^/]*$','')
            and x.provider_file_id=m.authority_request->'provider_identity'->>'source_parent_id')
          or exists(select 1 from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id
            and x.state in ('active','trashed') and (x.path=p_mutation->>'destination_path'
              or left(x.path,char_length(p_mutation->>'destination_path')+1)=(p_mutation->>'destination_path')||'/'))))$r$,1),
    ('clued_private.storage_settle_input_v1(uuid,clued_private.resource_center_mutations_v1,jsonb)',
     $a$  select case when m.authority_request->'mutation'->>'operation' in ('delete','restore') then$a$,
     $r$  select case when m.authority_request->'mutation'->>'operation'='move' and m.authority_request->'mutation'->>'target_kind'='directory' then
    jsonb_build_object('action','artifact_subtree_move','profile_id',p_profile,'source_decision_id',m.source_decision_id,
      'idempotency_key','resource-center-finalize:'||m.id::text,
      'artifact_id',m.authority_result->'authority'->>'artifact_id',
      'base_version',split_part(m.authority_result->'authority'->>'authority_version',':',2)::bigint,
      'path',p_proof->>'path','provider_file_id',p_proof->>'provider_file_id','provider_file_version',p_proof->>'provider_file_version')
  when m.authority_request->'mutation'->>'operation' in ('delete','restore') then$r$,1),
    -- Registry: the directory and its subtree change path together.
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$    ('profile_register','artifact_register','artifact_update','artifact_revoke','artifact_trash','artifact_untrash',$a$,
     $r$    ('profile_register','artifact_register','artifact_update','artifact_revoke','artifact_trash','artifact_untrash','artifact_subtree_move',$r$,1),
    ('public.clued_resource_center_admin_v1(uuid,jsonb)',
     $a$    elsif v_action='binding_issue' then$a$,
     $r$    elsif v_action='artifact_subtree_move' then
      -- StorageFullCapability P6 (T14): a registered directory and every
      -- active or trashed item under it change path in this one transaction,
      -- by CAS on the directory's version.
      select * into v_artifact from clued_private.resource_center_artifacts_v1
        where id=(p_input->>'artifact_id')::uuid and profile_id=v_profile.id and user_id=p_user_id
          and state='active' and target_kind='directory' for update;
      if not found or v_artifact.path=v_profile.managed_root or
        v_artifact.version is distinct from (p_input->>'base_version')::bigint then
        raise exception 'resource_center_artifact_conflict' using errcode='40001';
      end if;
      v_artifact:=clued_private.storage_subtree_move_v1(v_profile,v_artifact,p_input,v_decision_id,v_receipt.id);
      v_target_id:=v_artifact.id; v_version:=v_artifact.version;
      v_base:=jsonb_build_object(v_target_id::text,v_version-1);
    elsif v_action='binding_issue' then$r$,1),
    -- The executor descriptor names a directory move's descendants to re-read.
    ('clued_private.storage_cloud_worker_v2(text,jsonb)',
     $a$      'untrash_source',clued_private.storage_untrash_source_v1(j),$a$,
     $r$      'untrash_source',clued_private.storage_untrash_source_v1(j),
      'subtree_sample',case when j.mutation->>'operation'='move' and j.mutation->>'target_kind'='directory'
        then clued_private.storage_subtree_sample_v1(p.id,c.owner_id,j.mutation->>'source_path') end,$r$,1),
    -- Scheduled recovery never settles a directory move (§6.2); the Owner's
    -- native recovery still may.
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$        and j0.authority_snapshot_v2 is not null and m0.state in ('started','uncertain')$a$,
     $r$        and j0.authority_snapshot_v2 is not null and m0.state in ('started','uncertain')
        and not (j0.mutation->>'operation'='move' and j0.mutation->>'target_kind'='directory')$r$,1),
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')
    or (j.mutation->>'operation'='move' and j.mutation->>'target_kind'='directory')$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Paired edits are applied together: every edit of one function first,
    -- then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_directory_move_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_write_actions_v1(text[]),
  clued_private.storage_subtree_shape_v1(jsonb),
  clued_private.storage_subtree_target_v1(uuid,jsonb),
  clued_private.storage_subtree_sample_v1(uuid,uuid,text),
  clued_private.storage_subtree_attempt_v1(clued_private.resource_center_mutations_v1,clued_private.storage_jobs_v1),
  clued_private.storage_subtree_move_v1(clued_private.resource_center_profiles_v1,clued_private.resource_center_artifacts_v1,jsonb,uuid,uuid)
  from public,anon,authenticated,service_role;
