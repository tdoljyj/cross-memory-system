-- StorageFullCapability.v0.1 P3 part B (§6.1, §6.2): rename and file move
-- on the existing account-policy job chain. No new permission path: submit
-- evaluates the modify level (part A), and the same begin / provider attempt /
-- verified record / verified settle chain runs with operation-specific checks.
--
-- * Submit accepts {operation: rename|move, target_kind: file, source_path,
--   destination_path, source_file_version}. A rename keeps the parent and
--   changes the name; a move keeps the name and changes the parent. The
--   version is the one the Agent observed; the executor refuses a changed
--   file before any reservation, and the authority requires the registered
--   source (a Clued-created or otherwise registered file) at that version.
-- * The provider attempt (clued.storage-modify-attempt/1) names the file,
--   both paths, both parents and the file's content identity (size, head
--   revision, checksums) before the one files.update call. The proof must
--   show the same content identity afterwards: a concurrent edit is never
--   settled into the registry (§6.1, T5).
-- * The verified proof is clued.storage-rename-verified/1 or
--   clued.storage-move-verified/1. Settlement updates the source Artifact by
--   CAS on the version the authority saw (artifact_update), never registers a
--   new one. The plain journal finalize stays create-only.
-- * The Artifact authority for these operations is the source Artifact
--   (clued_resource_center_authority_v1 already selects it); settlement
--   rebuilds it from the still-registered source and its current Decision.
-- Uncertain-outcome recovery (scheduled and native) now loads rename and move
-- descriptors too; the Worker re-verifies them by GET only and settles
-- through the same verified record, never repeating the update.

-- Exact submit shape. Paths must already be canonical: no backslash, empty,
-- "." or ".." segment, or trailing slash.
create function clued_private.storage_modify_shape_v1(m jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare sp text; dp text; bad constant text:='(\\|//|/\./|/\.\./|/\.$|/\.\.$|/$)';
begin
  if jsonb_typeof(m) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(m) k)
      is distinct from array['destination_path','operation','source_file_version','source_path','target_kind']
    or coalesce(m->>'operation','') not in ('rename','move') or m->>'target_kind' is distinct from 'file'
    or jsonb_typeof(m->'source_path') is distinct from 'string' or jsonb_typeof(m->'destination_path') is distinct from 'string'
    or jsonb_typeof(m->'source_file_version') is distinct from 'string'
    or coalesce(m->>'source_file_version','') !~ '^[1-9][0-9]{0,39}$' then return false; end if;
  sp:=m->>'source_path'; dp:=m->>'destination_path';
  if length(sp) not between 1 and 1000 or length(dp) not between 1 and 1000
    or sp ~ bad or dp ~ bad or strpos(sp,'/')=0 or strpos(dp,'/')=0 then return false; end if;
  if m->>'operation'='rename' then
    return regexp_replace(sp,'/[^/]*$','')=regexp_replace(dp,'/[^/]*$','')
      and substring(sp from '[^/]*$')<>substring(dp from '[^/]*$');
  end if;
  return regexp_replace(sp,'/[^/]*$','')<>regexp_replace(dp,'/[^/]*$','')
    and substring(sp from '[^/]*$')=substring(dp from '[^/]*$');
end $$;

-- Expected provider attempt for a rename or move. The source parent is the
-- registered directory at the source path's parent; null (no match) fails the
-- caller's equality check. The content identity is observed by the executor
-- and can only be shape-checked here; the proof must repeat it exactly.
create function clued_private.storage_modify_attempt_v1(m clued_private.resource_center_mutations_v1,j clued_private.storage_jobs_v1,p_content jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare sp text:=j.mutation->>'source_path'; source_parent text;
begin
  if j.mutation->>'source_file_version' is distinct from m.authority_request->'provider_identity'->>'source_file_version'
    or jsonb_typeof(p_content) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(p_content) k) is distinct from array['head_revision_id','md5','sha256','size']
    or jsonb_typeof(p_content->'size') is distinct from 'string' or p_content->>'size' !~ '^(0|[1-9][0-9]{0,19})$'
    or jsonb_typeof(p_content->'head_revision_id') is distinct from 'string' or p_content->>'head_revision_id' !~ '^[A-Za-z0-9_-]{1,200}$'
    or jsonb_typeof(p_content->'sha256') not in ('string','null') or jsonb_typeof(p_content->'md5') not in ('string','null')
    or coalesce(p_content->>'sha256','0'||repeat('a',63)) !~ '^[0-9a-f]{64}$'
    or coalesce(p_content->>'md5',repeat('a',32)) !~ '^[0-9a-f]{32}$'
    or (p_content->>'sha256' is null and p_content->>'md5' is null) then
    return null; end if;
  select a.provider_file_id into source_parent from clued_private.resource_center_artifacts_v1 a
    where a.profile_id=m.profile_id and a.user_id=m.user_id and a.state='active' and a.target_kind='directory'
      and a.path=left(sp,char_length(sp)-strpos(reverse(sp),'/'));
  return jsonb_build_object('contract','clued.storage-modify-attempt/1','intent_id',m.id,'request_sha256',m.request_sha256,
    'profile_id',m.profile_id,'operation',j.mutation->>'operation',
    'provider_file_id',m.authority_request->'provider_identity'->>'source_file_id',
    'source_path',sp,'source_file_version',j.mutation->>'source_file_version','source_parent_id',source_parent,
    'destination_path',j.mutation->>'destination_path',
    'parent_id',m.authority_request->'provider_identity'->>'destination_parent_id',
    'target_kind','file','content',p_content,'binding',m.exact_request->'binding');
end $$;

-- The authority result settlement must still reproduce: the parent for a
-- create (unchanged), the registered source Artifact for a rename or move.
create function clued_private.storage_settle_authority_v1(p_owner uuid,p clued_private.resource_center_profiles_v1,
  m clued_private.resource_center_mutations_v1,p_mutation jsonb,parent clued_private.resource_center_artifacts_v1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare selected clued_private.resource_center_artifacts_v1; decision_version bigint;
begin
  if p_mutation->>'operation' in ('rename','move') then
    select * into selected from clued_private.resource_center_artifacts_v1
      where id=(m.authority_result->'authority'->>'artifact_id')::uuid and profile_id=p.id and user_id=p_owner
        and state='active' and target_kind='file' and path=p_mutation->>'source_path'
        and provider_file_id=m.authority_request->'provider_identity'->>'source_file_id'
        and provider_file_version=m.authority_request->'provider_identity'->>'source_file_version';
    if not found or not clued_private.resource_center_path_current_v1(p_owner,p.project_id,p.id,p.managed_root,selected.path)
      or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,selected.source_decision_id) then
      return null; end if;
  else
    selected:=parent;
  end if;
  select version into decision_version from public.clued_memories where id=selected.source_decision_id and user_id=p_owner;
  return jsonb_build_object('status','resolved','authority',jsonb_build_object(
    'artifact_id',case when p_mutation->>'operation' in ('rename','move') then selected.id end,
    'artifact_role','clued_resource','governance_class',selected.governance_class,'delete_authority',selected.delete_authority,
    'authority_version',selected.id::text||':'||selected.version::text||':'||decision_version::text,
    'currentness_identity','decision:'||selected.source_decision_id::text||':'||decision_version::text,
    'workspace_version',p.id::text||':'||p.version::text||':'||selected.version::text));
end $$;

-- Registry change of a verified settlement. A create registers the new file
-- (unchanged input); a rename or move updates the source Artifact by CAS on
-- the version the authority saw, keeping its governance fields.
create function clued_private.storage_settle_input_v1(p_profile uuid,m clued_private.resource_center_mutations_v1,p_proof jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when m.authority_request->'mutation'->>'operation' in ('rename','move') then
    jsonb_build_object('action','artifact_update','profile_id',p_profile,'source_decision_id',m.source_decision_id,
      'idempotency_key','resource-center-finalize:'||m.id::text,
      'artifact_id',m.authority_result->'authority'->>'artifact_id',
      'base_version',split_part(m.authority_result->'authority'->>'authority_version',':',2)::bigint,
      'path',p_proof->>'path','provider_file_id',p_proof->>'provider_file_id','provider_file_version',p_proof->>'provider_file_version',
      'governance_class',m.authority_result->'authority'->>'governance_class',
      'delete_authority',(m.authority_result->'authority'->>'delete_authority')::boolean)
  else
    jsonb_build_object('action','artifact_register','profile_id',p_profile,'source_decision_id',m.source_decision_id,
      'idempotency_key','resource-center-finalize:'||m.id::text,'path',p_proof->>'path',
      'provider_file_id',p_proof->>'provider_file_id','provider_file_version',p_proof->>'provider_file_version',
      'target_kind',m.authority_request->'mutation'->>'target_kind','governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false)
  end
$$;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$      or m-array['operation','destination_path','target_kind','directory_semantics','content']<>'{}'::jsonb
      or m->>'operation' is distinct from 'create'
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or jsonb_typeof(m->'destination_path') is distinct from 'string'
      or length(m->>'destination_path') not between 1 and 1000 then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    if m->>'target_kind'='file' then$a$,
     $r$      or m-array['operation','destination_path','target_kind','directory_semantics','content','source_path','source_file_version']<>'{}'::jsonb
      or coalesce(m->>'operation','') not in ('create','rename','move')
      or coalesce(m->>'target_kind','') not in ('file','directory')
      or jsonb_typeof(m->'destination_path') is distinct from 'string'
      or length(m->>'destination_path') not between 1 and 1000 then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    if m->>'operation' in ('rename','move') then
      wanted:='modify';
      if not clued_private.storage_modify_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m ?| array['source_path','source_file_version'] then
      raise exception 'storage_job_input_invalid' using errcode='22023';
    elsif m->>'target_kind'='file' then$r$,1),
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$  wanted:=case j.mutation->>'target_kind' when 'file' then 'create_file' when 'directory' then 'create_topic' end;$a$,
     $r$  wanted:=case when j.mutation->>'operation' in ('rename','move') then 'modify'
    when j.mutation->>'target_kind'='file' then 'create_file' when j.mutation->>'target_kind'='directory' then 'create_topic' end;$r$,1),
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$    or j.mutation->>'operation' is distinct from 'create'$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move')$r$,1),
    ('clued_private.storage_cloud_job_mutation_v2(jsonb,jsonb)',
     $a$  foreach field in array array['operation','destination_path','target_kind','directory_semantics'] loop$a$,
     $r$  foreach field in array array['operation','source_path','destination_path','target_kind','directory_semantics'] loop$r$,1),
    ('clued_private.storage_cloud_job_mutation_v2(jsonb,jsonb)',
     $a$  if p_authority->>'artifact_role' is distinct from 'clued_resource' or p_authority->>'source_path' is not null then$a$,
     $r$  if p_authority->>'artifact_role' is distinct from 'clued_resource' then$r$,1),
    ('clued_private.storage_job_begin_v2(uuid,uuid,text,jsonb)',
     $a$  foreach field in array array['operation','destination_path','target_kind','directory_semantics'] loop$a$,
     $r$  foreach field in array array['operation','source_path','destination_path','target_kind','directory_semantics'] loop$r$,1),
    ('clued_private.storage_job_begin_v2(uuid,uuid,text,jsonb)',
     $a$  if am->>'artifact_role' is distinct from 'clued_resource' or am->>'source_path' is not null then$a$,
     $r$  if am->>'artifact_role' is distinct from 'clued_resource' then$r$,1),
    ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)',
     $a$  expected:=jsonb_build_object('contract','clued.resource-center-provider-attempt/1',$a$,
     $r$  if j.mutation->>'operation' in ('rename','move') then
    expected:=clued_private.storage_modify_attempt_v1(m,j,p_attempt->'content');
  else
  expected:=jsonb_build_object('contract','clued.resource-center-provider-attempt/1',$r$,1),
    ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)',
     $a$      encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);$a$,
     $r$      encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);
  end if;$r$,1),
    ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)',
     $a$        v_request->'mutation'->>'operation' is distinct from 'create' then$a$,
     $r$        coalesce(v_request->'mutation'->>'operation','') not in ('create','rename','move') then$r$,1),
    ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)',
     $a$    elsif v_action='finalize' then
      if v_intent.state not in ('started','uncertain') or$a$,
     $r$    elsif v_action='finalize' then
      -- Rename and move settle only through verified settlement (artifact_update).
      if v_intent.authority_request->'mutation'->>'operation' is distinct from 'create' or
        v_intent.state not in ('started','uncertain') or$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    or j.mutation->>'operation' is distinct from 'create'$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move')$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$(a.path=parent_path or left(parent_path,char_length(a.path)+1)=a.path||'/')$a$,
     $r$(a.path=parent_path or left(parent_path,char_length(a.path)+1)=a.path||'/' or a.path=j.mutation->>'source_path')$r$,3),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    registration_input:=jsonb_build_object('action','artifact_register','profile_id',p.id,'source_decision_id',m.source_decision_id,
      'idempotency_key','resource-center-finalize:'||m.id::text,'path',saved->'proof'->>'path',
      'provider_file_id',saved->'proof'->>'provider_file_id','provider_file_version',saved->'proof'->>'provider_file_version',
      'target_kind',m.authority_request->'mutation'->>'target_kind','governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false);$a$,
     $r$    registration_input:=clued_private.storage_settle_input_v1(p.id,m,saved->'proof');$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$  registration_input:=jsonb_build_object('action','artifact_register','profile_id',p.id,'source_decision_id',m.source_decision_id,
    'idempotency_key','resource-center-finalize:'||m.id::text,'path',proof->>'path','provider_file_id',proof->>'provider_file_id',
    'provider_file_version',proof->>'provider_file_version','target_kind',m.authority_request->'mutation'->>'target_kind',
    'governance_class',m.authority_result->'authority'->>'governance_class','delete_authority',false);$a$,
     $r$  registration_input:=clued_private.storage_settle_input_v1(p.id,m,proof);$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$  select version into decision_version from public.clued_memories where id=parent.source_decision_id and user_id=c.owner_id;
  authority:=jsonb_build_object('status','resolved','authority',jsonb_build_object('artifact_id',null,
    'artifact_role','clued_resource','governance_class',parent.governance_class,'delete_authority',parent.delete_authority,
    'authority_version',parent.id::text||':'||parent.version::text||':'||decision_version::text,
    'currentness_identity','decision:'||parent.source_decision_id::text||':'||decision_version::text,
    'workspace_version',p.id::text||':'||p.version::text||':'||parent.version::text));$a$,
     $r$  authority:=clued_private.storage_settle_authority_v1(c.owner_id,p,m,j.mutation,parent);$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    attempt_expected:=jsonb_build_object('contract','clued.resource-center-provider-attempt/1','intent_id',m.id,$a$,
     $r$    if j.mutation->>'operation' in ('rename','move') then
      attempt_expected:=clued_private.storage_modify_attempt_v1(m,j,m.provider_attempt->'content');
    else
    attempt_expected:=jsonb_build_object('contract','clued.resource-center-provider-attempt/1','intent_id',m.id,$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$      'sha256',case when j.mutation->>'target_kind'='file' then encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);$a$,
     $r$      'sha256',case when j.mutation->>'target_kind'='file' then encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex') end);
    end if;$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    expected:=post||jsonb_build_object('contract','clued.storage-create-verified/2','target_kind',j.mutation->>'target_kind',$a$,
     $r$    if j.mutation->>'operation' in ('rename','move') then
      expected:=post||jsonb_build_object('contract','clued.storage-'||(j.mutation->>'operation')||'-verified/1',
        'operation',j.mutation->>'operation','source_path',j.mutation->>'source_path',
        'source_file_version',j.mutation->>'source_file_version','content',attempt_expected->'content',
        'provider_before',m.authority_request->'provider_identity',
        'checks',jsonb_build_object('identity',true,'ancestors',true,'stable_state',true,'unique_name',true,'source_vacated',true,
          'content_unchanged',true));
    else
    expected:=post||jsonb_build_object('contract','clued.storage-create-verified/2','target_kind',j.mutation->>'target_kind',$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$      'checks',jsonb_build_object('identity',true,'content',true,'ancestors',true,'unique_name',true,'stable_version',true));$a$,
     $r$      'checks',jsonb_build_object('identity',true,'content',true,'ancestors',true,'unique_name',true,'stable_version',true));
    end if;$r$,1),
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$    or j.mutation->>'operation' is distinct from 'create'$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move')$r$,1),
    ('public.clued_storage_native_recovery_load_v2(text,jsonb)',
     $a$    or j.mutation->>'operation' is distinct from 'create'$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move')$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Paired edits (an inserted "if" and its "end if") are applied together:
    -- every edit of one function first, then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_modify_execution_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_modify_shape_v1(jsonb),
  clued_private.storage_modify_attempt_v1(clued_private.resource_center_mutations_v1,clued_private.storage_jobs_v1,jsonb),
  clued_private.storage_settle_authority_v1(uuid,clued_private.resource_center_profiles_v1,clued_private.resource_center_mutations_v1,jsonb,clued_private.resource_center_artifacts_v1),
  clued_private.storage_settle_input_v1(uuid,clued_private.resource_center_mutations_v1,jsonb)
  from public,anon,authenticated,service_role;
