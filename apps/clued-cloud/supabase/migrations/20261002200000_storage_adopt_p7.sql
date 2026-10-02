-- StorageFullCapability.v0.1 P7 (§6.3; Owner Decisions c47efe38, 746fd078
-- and 6dc1cf20): the full Google Drive scope and the adopt job. Built on the
-- same account-policy job chain as P3-P6; every existing function is changed
-- by an anchored patch with an exact hit count, never rewritten.
--
-- Part 1, the full scope profile (Decision 746fd078 item 1):
-- * storage_connections_v1.provider_scope_profile and the OAuth attempt's
--   requested profile also allow 'full' = drive.file + drive.metadata.readonly
--   + drive.readonly + drive. Full includes normal: every check that required
--   a normal credential (normal use, full-text search, binary upload) accepts
--   full too (clued_private.storage_scope_covers_v1).
-- * Re-consent to full (Decision 6dc1cf20 item 3) is a connection-consent
--   attempt with requested_scope_profile 'full' and the full-scope disclosure
--   the Owner confirmed on the native page (clued.storage-full-scope-
--   disclosure/1), recorded on the attempt. It upgrades the grant only: no
--   write level and no read access changes. Like a normal-use upgrade it is
--   refused at 90 counted refresh tokens. A plain reconnect of a connection
--   that is already full requests the full set without a new disclosure.
--   Complete accepts the requested profile or any lower one (the Owner may
--   untick a scope) and records what Google granted, as before.
-- * Credential recovery and refresh never change the profile (unchanged).
--
-- Part 2, adopt (§6.3; Decision 6dc1cf20 items 1 and 2): see below.

-- Profiles in order; each includes every lower one.
create function clued_private.storage_scope_covers_v1(p_profile text,p_wanted text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(array_position(array['legacy','normal','full'],p_profile)>=array_position(array['legacy','normal','full'],p_wanted),false)
$$;
revoke all on function clued_private.storage_scope_covers_v1(text,text) from public,anon,authenticated,service_role;

alter table clued_private.storage_connections_v1
  drop constraint storage_connections_scope_profile_v1,
  add constraint storage_connections_scope_profile_v1 check (provider_scope_profile in ('legacy','normal','full'));
alter table clued_private.storage_oauth_attempts_v1
  drop constraint storage_oauth_requested_profile_v1,
  add constraint storage_oauth_requested_profile_v1 check (requested_scope_profile in ('legacy','normal','full')),
  add constraint storage_oauth_full_scope_v1 check (requested_scope_profile is distinct from 'full'
    or (purpose='connection' and not normal_use_requested
      and (disclosure_version is null or disclosure_version='clued.storage-full-scope-disclosure/1')));

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- The 075249 connection-consent complete records a full grant.
    ('clued_private.clued_storage_oauth_v1(text,jsonb)',
     $a$            or p_input->>'provider_scope_profile' not in ('legacy','normal')))$a$,
     $r$            or p_input->>'provider_scope_profile' not in ('legacy','normal','full')))$r$,1),
    -- The outermost OAuth wrapper: prepare binds a full request and its disclosure.
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$  normal_disclosure constant text:='clued.storage-normal-use-disclosure/1';$a$,
     $r$  normal_disclosure constant text:='clued.storage-normal-use-disclosure/1';
  full_disclosure constant text:='clued.storage-full-scope-disclosure/1';$r$,1),
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$          or p_input->>'requested_scope_profile' not in ('legacy','normal')))
      or (p_input ? 'normal_use' and (jsonb_typeof(p_input->'normal_use') is distinct from 'object'
          or ((p_input->'normal_use')-'disclosure_version')<>'{}'::jsonb
          or p_input->>'requested_scope_profile' is distinct from 'normal'))$a$,
     $r$          or p_input->>'requested_scope_profile' not in ('legacy','normal','full')))
      or (p_input ? 'normal_use' and (jsonb_typeof(p_input->'normal_use') is distinct from 'object'
          or ((p_input->'normal_use')-'disclosure_version')<>'{}'::jsonb
          or p_input->>'requested_scope_profile' is distinct from 'normal'))
      -- P7: the full-scope disclosure goes only with a full request.
      or (p_input ? 'full_scope' and (jsonb_typeof(p_input->'full_scope') is distinct from 'object'
          or ((p_input->'full_scope')-'disclosure_version')<>'{}'::jsonb
          or p_input->>'requested_scope_profile' is distinct from 'full'))$r$,1),
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$    if p_input ? 'normal_use' and p_input->'normal_use'->>'disclosure_version' is distinct from normal_disclosure then
      raise exception 'storage_normal_use_disclosure_changed' using errcode='40001'; end if;$a$,
     $r$    if p_input ? 'normal_use' and p_input->'normal_use'->>'disclosure_version' is distinct from normal_disclosure then
      raise exception 'storage_normal_use_disclosure_changed' using errcode='40001'; end if;
    if p_input ? 'full_scope' and p_input->'full_scope'->>'disclosure_version' is distinct from full_disclosure then
      raise exception 'storage_full_scope_disclosure_changed' using errcode='40001'; end if;$r$,1),
    -- Upgrading to full needs the confirmed disclosure; a plain reconnect of a
    -- full connection keeps it without one. Both count like a normal-use upgrade
    -- only when they upgrade.
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$    if normal and app.issuer_hash is not null and clued_private.storage_refresh_token_count_v1(u,c.provider_subject,app.oauth_client_id)>=90 then$a$,
     $r$    if requested='full' and not (p_input ? 'full_scope') and c.provider_scope_profile is distinct from 'full' then
      raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    if (normal or p_input ? 'full_scope') and app.issuer_hash is not null
      and clued_private.storage_refresh_token_count_v1(u,c.provider_subject,app.oauth_client_id)>=90 then$r$,1),
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$    result:=clued_private.storage_oauth_dispatch_v1(p_issuer_hash,p_input-'requested_scope_profile'-'normal_use');$a$,
     $r$    result:=clued_private.storage_oauth_dispatch_v1(p_issuer_hash,p_input-'requested_scope_profile'-'normal_use'-'full_scope');$r$,1),
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$        disclosure_version=case when normal then normal_disclosure end,$a$,
     $r$        disclosure_version=case when normal then normal_disclosure when p_input ? 'full_scope' then full_disclosure end,$r$,1),
    -- Complete: the requested profile or any lower one.
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$    -- §2.3: the granted profile is the requested one or legacy.
    requested:=coalesce(x.requested_scope_profile,'legacy');
    granted:=coalesce(p_input->>'provider_scope_profile','legacy');
    if granted not in (requested,'legacy') then raise exception 'storage_oauth_denied' using errcode='42501'; end if;$a$,
     $r$    -- §2.3: the granted profile is the requested one or a lower one.
    requested:=coalesce(x.requested_scope_profile,'legacy');
    granted:=coalesce(p_input->>'provider_scope_profile','legacy');
    if granted not in ('legacy','normal','full') or not clued_private.storage_scope_covers_v1(requested,granted) then
      raise exception 'storage_oauth_denied' using errcode='42501'; end if;$r$,1),
    ('public.clued_storage_oauth_v1(text,jsonb)',
     $a$          and ra0.account_policy_id=after.account_policy_id and after.provider_scope_profile='normal'));$a$,
     $r$          and ra0.account_policy_id=after.account_policy_id
          and clued_private.storage_scope_covers_v1(after.provider_scope_profile,'normal')));$r$,1),
    -- Normal use: a full credential includes normal.
    ('public.clued_storage_normal_use_v1(jsonb)',
     $a$      'normal_use',coalesce(ra.content_profile='normal/1' and ra.account_policy_id=c.account_policy_id and c.provider_scope_profile='normal',false),
      'reconsent_required',c.provider_scope_profile<>'normal',$a$,
     $r$      'normal_use',coalesce(ra.content_profile='normal/1' and ra.account_policy_id=c.account_policy_id
        and clued_private.storage_scope_covers_v1(c.provider_scope_profile,'normal'),false),
      'reconsent_required',not clued_private.storage_scope_covers_v1(c.provider_scope_profile,'normal'),
      'full_scope',c.provider_scope_profile='full','full_scope_disclosure_version','clued.storage-full-scope-disclosure/1',$r$,1),
    ('public.clued_storage_normal_use_v1(jsonb)',
     $a$  if op='enable' and c.provider_scope_profile is distinct from 'normal' then$a$,
     $r$  if op='enable' and not clued_private.storage_scope_covers_v1(c.provider_scope_profile,'normal') then$r$,1),
    -- Full-text search and binary upload.
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$      if evaluated->>'content_profile' is distinct from 'normal/1' or (select c0.provider_scope_profile
          from clued_private.storage_connections_v1 c0 where c0.id=(evaluated->>'connection_id')::uuid) is distinct from 'normal' then$a$,
     $r$      if evaluated->>'content_profile' is distinct from 'normal/1' or not clued_private.storage_scope_covers_v1((select c0.provider_scope_profile
          from clued_private.storage_connections_v1 c0 where c0.id=(evaluated->>'connection_id')::uuid),'normal') then$r$,1),
    ('clued_private.storage_binary_gate_v1(uuid)',
     $a$and c.provider_scope_profile='normal' and$a$,
     $r$and clued_private.storage_scope_covers_v1(c.provider_scope_profile,'normal') and$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Every edit of one function first, then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_adopt_p7_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

-- Part 2, adopt (§6.3; Decision 6dc1cf20 items 1 and 2):
-- * Submit accepts {operation: adopt, target_kind: file|directory,
--   source_path, source_file_id} under the modify level, only on a connection
--   whose credential is full (adopt_scope_upgrade_required otherwise, before
--   any job exists). One existing Drive item per job, named by its path and
--   Drive ID; never the root or a track (a direct child of the root); nothing
--   registered (active or trashed) at that path, and no registration of that
--   Drive ID in any state, revoked included: an item the Owner removed from
--   Clued comes back only through the administrative path
--   (adopt_already_registered).
-- * The Artifact authority requires the item's folder to be registered, current
--   and matched like any destination folder (by Drive version or sharing
--   state), and an ordinary one: an item under a governance folder needs the
--   Owner's administrative registration (governance_forbidden). A directory is
--   adopted only when its sharing state equals its folder's (sharing_differs),
--   so later writes into it inherit nothing the folder does not grant. The
--   executor also requires Drive to report the item as owned by this account
--   (PROVIDER_OWNER_REQUIRED) and never a shortcut, and the verifier checks
--   both again.
-- * Adopt changes nothing in Drive. Its provider attempt
--   (clued.storage-adopt-attempt/1) names the item, its folder and the Drive
--   version the authority saw; the verified proof (clued.storage-adopt-
--   verified/1) shows the same item at the same path and the same version, the
--   only one of its name, owned by this account, not a shortcut and, for a
--   directory, with its folder's sharing state. Settlement registers it as an
--   ordinary Artifact (delete_authority false; a directory with its sharing
--   digest) through the same artifact_register, and the settle Receipt names
--   the observation it came from. The plain journal finalize stays create-only.
-- * An adopt that has not committed 60 seconds after its admission expired is
--   released by the scheduled unattempted release (outcome released_no_effect,
--   reason ADOPT_NOT_SETTLED), with or without a recorded attempt or verified
--   proof: nothing in Drive ever changed. Scheduled recovery never loads it.
-- * Executing an adopt job again requires the full credential.

create function clued_private.storage_adopt_shape_v1(m jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare sp text; bad constant text:='(\\|//|/\./|/\.\./|/\.$|/\.\.$|/$)';
begin
  if jsonb_typeof(m) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(m) k)
      is distinct from array['operation','source_file_id','source_path','target_kind']
    or m->>'operation' is distinct from 'adopt' or coalesce(m->>'target_kind','') not in ('file','directory')
    or jsonb_typeof(m->'source_path') is distinct from 'string'
    or jsonb_typeof(m->'source_file_id') is distinct from 'string' or coalesce(m->>'source_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then
    return false; end if;
  sp:=m->>'source_path';
  return length(sp) between 1 and 1000 and sp !~ bad and strpos(sp,'/')>0;
end $$;

-- Registry hints at submit, only after the evaluator authenticated the Binding
-- and the modify level (the authority decides again under its locks).
create function clued_private.storage_adopt_target_v1(p_connection uuid,m jsonb)
returns void language plpgsql stable security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
begin
  select * into c from clued_private.storage_connections_v1 where id=p_connection;
  select pr.* into p from clued_private.resource_center_profiles_v1 pr where pr.id=c.profile_id and pr.user_id=c.owner_id;
  if c.id is null or p.id is null then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  if c.provider_scope_profile is distinct from 'full' then
    raise exception 'adopt_scope_upgrade_required' using errcode='42501'; end if;
  if regexp_replace(m->>'source_path','/[^/]*$','')=p.managed_root then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  if exists(select 1 from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id
      and ((a.state in ('active','trashed') and a.path=m->>'source_path') or a.provider_file_id=m->>'source_file_id')) then
    raise exception 'adopt_already_registered' using errcode='22023'; end if;
end $$;

-- Expected provider attempt of an adopt: the item, its folder and its Drive
-- version, all from the authority's provider identity.
create function clued_private.storage_adopt_attempt_v1(m clued_private.resource_center_mutations_v1,j clued_private.storage_jobs_v1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare pi jsonb:=m.authority_request->'provider_identity';
begin
  if j.mutation->>'source_file_id' is distinct from pi->>'source_file_id'
    or coalesce(pi->>'source_file_version','') !~ '^[1-9][0-9]{0,39}$'
    or coalesce(pi->>'source_parent_id','') !~ '^[A-Za-z0-9_-]{1,160}$' then
    return null; end if;
  return jsonb_build_object('contract','clued.storage-adopt-attempt/1','intent_id',m.id,'request_sha256',m.request_sha256,
    'profile_id',m.profile_id,'operation','adopt','target_kind',j.mutation->>'target_kind',
    'provider_file_id',pi->>'source_file_id','source_path',j.mutation->>'source_path',
    'provider_file_version',pi->>'source_file_version','parent_id',pi->>'source_parent_id',
    'binding',m.exact_request->'binding');
end $$;

revoke all on function clued_private.storage_adopt_shape_v1(jsonb),
  clued_private.storage_adopt_target_v1(uuid,jsonb),
  clued_private.storage_adopt_attempt_v1(clued_private.resource_center_mutations_v1,clued_private.storage_jobs_v1)
  from public,anon,authenticated,service_role;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- Submit: shape, level and the registry hints.
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$      or coalesce(m->>'operation','') not in ('create','rename','move','replace','delete','restore')
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or ((m->>'operation' not in ('delete','restore') or m ? 'destination_path')$a$,
     $r$      or coalesce(m->>'operation','') not in ('create','rename','move','replace','delete','restore','adopt')
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or ((m->>'operation' not in ('delete','restore','adopt') or m ? 'destination_path')$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$    elsif m ?| array['source_file_id','restore_mode'] then$a$,
     $r$    elsif m->>'operation'='adopt' then
      wanted:='modify';
      if not clued_private.storage_adopt_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m ?| array['source_file_id','restore_mode'] then$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$  if wanted='modify_subtree' then perform clued_private.storage_subtree_target_v1(connection_id,m); end if;$a$,
     $r$  if wanted='modify_subtree' then perform clued_private.storage_subtree_target_v1(connection_id,m); end if;
  if m->>'operation'='adopt' then perform clued_private.storage_adopt_target_v1(connection_id,m); end if;$r$,1),
    -- Execution: the same level, and still a full credential.
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$    when j.mutation->>'operation' in ('rename','move') then 'modify'$a$,
     $r$    when j.mutation->>'operation' in ('rename','move','adopt') then 'modify'$r$,1),
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore','adopt')
    or (j.mutation->>'operation'='adopt' and not exists(select 1 from clued_private.storage_connections_v1 c0
      where c0.id=j.connection_id and c0.owner_id=p_owner and c0.provider_scope_profile='full'))$r$,1),
    -- Journal prepare (finalize stays create-only).
    ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)',
     $a$        coalesce(v_request->'mutation'->>'operation','') not in ('create','rename','move','replace','delete','restore') then$a$,
     $r$        coalesce(v_request->'mutation'->>'operation','') not in ('create','rename','move','replace','delete','restore','adopt') then$r$,1),
    -- Artifact authority for an adopt.
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$    v_operation not in ('create','write','replace','move','rename','delete','restore') or$a$,
     $r$    v_operation not in ('create','write','replace','move','rename','delete','restore','adopt') or$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  elsif v_destination_path is null or v_source_path is not null then$a$,
     $r$  elsif v_operation='adopt' then
    if v_source_path is null or v_destination_path is not null then
      return jsonb_build_object('status','denied','reason','operation_shape_invalid');
    end if;
  elsif v_destination_path is null or v_source_path is not null then$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  if v_source_path is not null then
    select * into v_source from clued_private.resource_center_artifacts_v1$a$,
     $r$  if v_source_path is not null and v_operation<>'adopt' then
    select * into v_source from clued_private.resource_center_artifacts_v1$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  elsif v_provider->>'source_file_id' is not null or v_provider->>'source_file_version' is not null then$a$,
     $r$  elsif v_operation<>'adopt' and (v_provider->>'source_file_id' is not null or v_provider->>'source_file_version' is not null) then$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$  if v_destination_path is not null then
    if left(v_destination_path,$a$,
     $r$  -- Adopt (P7): one existing, unregistered item in a registered, current,
  -- ordinary folder (matched like any destination folder), never the root or
  -- a track; nothing registered at its path, and its Drive ID never registered
  -- in any state (a revoked item returns only by the administrative path); a directory
  -- only with exactly its folder's sharing state.
  if v_operation='adopt' then
    if left(v_source_path,char_length(v_profile.managed_root)+1)<>v_profile.managed_root||'/' then
      return jsonb_build_object('status','denied','reason','source_mismatch');
    end if;
    v_parent_path:=left(v_source_path,char_length(v_source_path)-strpos(reverse(v_source_path),'/'));
    if v_parent_path=v_profile.managed_root then
      return jsonb_build_object('status','denied','reason','track_forbidden');
    end if;
    if coalesce(v_provider->>'source_file_id','') !~ '^[A-Za-z0-9_-]{1,160}$'
      or coalesce(v_provider->>'source_file_version','') !~ '^[1-9][0-9]{0,39}$' then
      return jsonb_build_object('status','denied','reason','operation_shape_invalid');
    end if;
    select * into v_parent from clued_private.resource_center_artifacts_v1
      where profile_id=v_profile.id and user_id=v_profile.user_id and state='active'
        and path=v_parent_path and target_kind='directory'
        and provider_file_id=v_provider->>'source_parent_id';
    if not found then
      return jsonb_build_object('status','denied','reason','parent_unregistered');
    end if;
    if clued_private.resource_center_directory_match_v1(v_parent.provider_file_version,v_parent.provider_sharing_digest,
        v_provider->>'source_parent_version',v_provider->>'source_parent_sharing_digest') is distinct from 'match' then
      return jsonb_build_object('status','denied','reason','parent_'||clued_private.resource_center_directory_match_v1(
        v_parent.provider_file_version,v_parent.provider_sharing_digest,
        v_provider->>'source_parent_version',v_provider->>'source_parent_sharing_digest'));
    end if;
    if not clued_private.resource_center_path_current_v1(
      v_profile.user_id,v_profile.project_id,v_profile.id,
      v_profile.managed_root,v_parent_path) then
      return jsonb_build_object('status','denied','reason','parent_path_not_current');
    end if;
    if v_parent.governance_class<>'ordinary' then
      return jsonb_build_object('status','denied','reason','governance_forbidden');
    end if;
    if exists(select 1 from clued_private.resource_center_artifacts_v1 a
        where a.profile_id=v_profile.id
          and ((a.state in ('active','trashed') and a.path=v_source_path) or a.provider_file_id=v_provider->>'source_file_id')) then
      return jsonb_build_object('status','denied','reason','already_registered');
    end if;
    if v_mutation->>'target_kind'='directory' and (coalesce(v_provider->>'source_sharing_digest','') !~ '^[0-9a-f]{64}$'
      or v_provider->>'source_sharing_digest' is distinct from v_provider->>'source_parent_sharing_digest') then
      return jsonb_build_object('status','denied','reason','sharing_differs');
    end if;
  end if;
  if v_destination_path is not null then
    if left(v_destination_path,$r$,1),
    ('public.clued_resource_center_authority_v1(text,jsonb)',
     $a$    'artifact_id',case when v_operation='create' then null else v_selected.id end,$a$,
     $r$    'artifact_id',case when v_operation in ('create','adopt') then null else v_selected.id end,$r$,1),
    -- Provider attempt.
    ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)',
     $a$  elsif j.mutation->>'operation'='replace' then
    expected:=clued_private.storage_replace_attempt_v1(m,j,p_attempt);$a$,
     $r$  elsif j.mutation->>'operation'='adopt' then
    expected:=clued_private.storage_adopt_attempt_v1(m,j);
  elsif j.mutation->>'operation'='replace' then
    expected:=clued_private.storage_replace_attempt_v1(m,j,p_attempt);$r$,1),
    -- Verified record and settlement. The adopted item's folder is its
    -- registered folder, checked like an in-place trash's.
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace','delete','restore','adopt')$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$j.mutation->>'operation' in ('delete','restore') and not (j.mutation ? 'destination_path')$a$,
     $r$j.mutation->>'operation' in ('delete','restore','adopt') and not (j.mutation ? 'destination_path')$r$,2),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    elsif j.mutation->>'operation'='replace' then
      attempt_expected:=$a$,
     $r$    elsif j.mutation->>'operation'='adopt' then
      attempt_expected:=clued_private.storage_adopt_attempt_v1(m,j);
    elsif j.mutation->>'operation'='replace' then
      attempt_expected:=$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    elsif j.mutation->>'operation'='replace' then
      expected:=post||$a$,
     $r$    elsif j.mutation->>'operation'='adopt' then
      -- The same item at the same version the authority saw: nothing changed.
      if proof->>'provider_file_version' is distinct from m.authority_request->'provider_identity'->>'source_file_version' then
        raise exception 'storage_verified_mismatch' using errcode='42501'; end if;
      expected:=post||jsonb_build_object('contract','clued.storage-adopt-verified/1','operation','adopt',
        'target_kind',j.mutation->>'target_kind','provider_before',m.authority_request->'provider_identity',
        'checks',jsonb_build_object('identity',true,'ancestors',true,'stable_state',true,'unique_name',true,
          'owned_by_me',true,'not_shortcut',true)
          ||case when j.mutation->>'target_kind'='directory' then jsonb_build_object('sharing_matches_parent',true) else '{}'::jsonb end)
        ||case when j.mutation->>'target_kind'='directory' then jsonb_build_object('provider_sharing_digest',
          m.authority_request->'provider_identity'->'source_sharing_digest') else '{}'::jsonb end;
    elsif j.mutation->>'operation'='replace' then
      expected:=post||$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$      else '{}'::jsonb end;
  r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_verified_settle',req,clued_private.m1_sha256(req));$a$,
     $r$      else '{}'::jsonb end
    -- §6.3: an adopt's Receipt names the observation the registration came from.
    ||case when j.mutation->>'operation'='adopt' then jsonb_build_object('adopted',jsonb_build_object(
      'observed_by','clued.storage-adopt-verified/1','provider_file_id',proof->>'provider_file_id',
      'provider_file_version',proof->>'provider_file_version','path',proof->>'path','provider_change',false)) else '{}'::jsonb end;
  r:=clued_private.m1_begin_receipt(c.owner_id,null,'storage_verified_settle',req,clued_private.m1_sha256(req));$r$,1),
    ('clued_private.storage_settle_authority_v1(uuid,clued_private.resource_center_profiles_v1,clued_private.resource_center_mutations_v1,jsonb,clued_private.resource_center_artifacts_v1)',
     $a$  else
    selected:=parent;
  end if;$a$,
     $r$  else
    -- Adopt (P7): still an ordinary, non-root folder that is the item's
    -- folder as Drive reported it, and still nothing registered there.
    if p_mutation->>'operation'='adopt' and (parent.governance_class<>'ordinary'
        or regexp_replace(p_mutation->>'source_path','/[^/]*$','')=p.managed_root
        or parent.provider_file_id is distinct from m.authority_request->'provider_identity'->>'source_parent_id'
        or exists(select 1 from clued_private.resource_center_artifacts_v1 x where x.profile_id=p.id
          and ((x.state in ('active','trashed') and x.path=p_mutation->>'source_path')
            or x.provider_file_id=m.authority_request->'provider_identity'->>'source_file_id'))) then
      return null; end if;
    selected:=parent;
  end if;$r$,1),
    -- Scheduled recovery never loads an adopt (it is released instead).
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$        and not (j0.mutation->>'operation'='move' and j0.mutation->>'target_kind'='directory')$a$,
     $r$        and not (j0.mutation->>'operation'='move' and j0.mutation->>'target_kind'='directory')
        and j0.mutation->>'operation' is distinct from 'adopt'$r$,1),
    -- The unattempted release also releases an unsettled adopt.
    ('public.clued_storage_release_unattempted_v1(text,jsonb)',
     $a$      and m0.provider_attempt is null and m0.provider_attempt_receipt_id is null and m0.verified_result_v2 is null$a$,
     $r$      and ((m0.provider_attempt is null and m0.provider_attempt_receipt_id is null and m0.verified_result_v2 is null)
        or j0.mutation->>'operation'='adopt')$r$,1),
    ('public.clued_storage_release_unattempted_v1(text,jsonb)',
     $a$    if m.id is null or m.profile_id is distinct from p.id or m.state not in ('started','uncertain') or m.provider_attempt is not null
      or m.provider_attempt_receipt_id is not null or m.verified_result_v2 is not null$a$,
     $r$    if m.id is null or m.profile_id is distinct from p.id or m.state not in ('started','uncertain')
      or (j.mutation->>'operation' is distinct from 'adopt' and (m.provider_attempt is not null
        or m.provider_attempt_receipt_id is not null or m.verified_result_v2 is not null))$r$,1),
    ('public.clued_storage_release_unattempted_v1(text,jsonb)',
     $a$      receipt_id=r.id,final_result=jsonb_build_object('outcome','released_unattempted','reason_code','NO_PROVIDER_ATTEMPT')$a$,
     $r$      receipt_id=r.id,final_result=case when j.mutation->>'operation'='adopt'
        then jsonb_build_object('outcome','released_no_effect','reason_code','ADOPT_NOT_SETTLED')
        else jsonb_build_object('outcome','released_unattempted','reason_code','NO_PROVIDER_ATTEMPT') end$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Paired edits are applied together: every edit of one function first,
    -- then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_adopt_p7_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;
