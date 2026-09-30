-- StorageFullCapability.v0.1 P4 (§6.2, T13): replace, revision protection
-- and revert, under a separate overwrite write level (Owner Decision
-- cc671d13: its own switch and disclosure; K = 10 Clued-pinned revisions).
--
-- * Policies gain the action "overwrite". A /3 policy's action set is the
--   create set plus any of modify, overwrite (canonical order).
-- * clued_storage_write_access_v1 toggles one class at a time; each class has
--   its own disclosure, and enabling a class requires that class's text.
-- * Submit accepts {replace, file, destination_path, destination_file_version,
--   content | restore_job_id}. A revert names the committed replace job whose
--   pinned previous revision it restores; it is evaluated as overwrite.
-- * The provider attempt (clued.storage-replace-attempt/1) records the
--   previous content identity and head revision (kept forever before the
--   upload), the new content's size and sha256, and the older Clued pins to
--   release. The verified proof (clued.storage-replace-verified/1) must repeat
--   them. Settlement updates the same Artifact by CAS and records the pin.
-- * storage_revision_pins_v1 lists the revisions Clued pinned. At most K of
--   one Artifact stay pinned; each replace tries to release the oldest beyond
--   K-1, and each row the proof observed released names the settlement
--   receipt. Releases never gate settlement: a pin Drive still keeps stays
--   pinned and is listed again. A head the Owner already kept forever is
--   recorded owner_kept and never released; other Owner-kept revisions are
--   never touched.
-- * Scheduled and native recovery load replace descriptors; recovery only reads.

-- Action sets: the create set plus any of modify, overwrite.
alter table clued_private.storage_account_policies_v2
  drop constraint storage_account_policies_v2_actions_check,
  add constraint storage_account_policies_v2_actions_check check(
    actions=array['inspect','create_file','create_topic']::text[]
    or (scope_contract='clued.storage-account-scope/3' and actions in (
      array['inspect','create_file','create_topic','modify']::text[],
      array['inspect','create_file','create_topic','overwrite']::text[],
      array['inspect','create_file','create_topic','modify','overwrite']::text[])));

-- Same digest as before for every existing action set; two more sets accepted.
create or replace function clued_private.storage_policy_scope_digest_v3(p_connection uuid,p_contract text,p_actions text[])
returns text language plpgsql stable security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  tracks jsonb; registered jsonb;
begin
  if p_contract='clued.storage-account-scope/2' then
    if p_actions is distinct from array['inspect','create_file','create_topic']::text[] then return null; end if;
    return clued_private.storage_policy_scope_digest_v2(p_connection);
  end if;
  if p_contract is distinct from 'clued.storage-account-scope/3' or p_actions is null or p_actions not in (
      array['inspect','create_file','create_topic']::text[],
      array['inspect','create_file','create_topic','modify']::text[],
      array['inspect','create_file','create_topic','overwrite']::text[],
      array['inspect','create_file','create_topic','modify','overwrite']::text[]) then
    return null; end if;
  select * into c from clued_private.storage_connections_v1 where id=p_connection;
  if not found or c.provider_subject is null then return null; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  if not found or p.cloud_runtime->>'contract' is distinct from 'clued.storage-cloud-runtime/1'
    or jsonb_typeof(p.cloud_runtime->'allowed_root_children') is distinct from 'array' then return null; end if;
  tracks:=p.cloud_runtime->'allowed_root_children';
  if jsonb_array_length(tracks) not between 1 and 32 or exists(
    select 1 from jsonb_array_elements(tracks) x where jsonb_typeof(x)<>'string')
    or (select count(distinct x) from jsonb_array_elements(tracks) x)<>jsonb_array_length(tracks) then return null; end if;
  select jsonb_agg(jsonb_build_object('path',a.path,'provider_file_id',a.provider_file_id) order by a.path collate "C") into registered
    from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=c.owner_id
      and a.state='active' and a.target_kind='directory'
      and a.path in (select p.managed_root||'/'||x from jsonb_array_elements_text(tracks) x);
  if coalesce(jsonb_array_length(registered),0)<>jsonb_array_length(tracks) then return null; end if;
  return clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-account-scope/3',
    'owner_id',c.owner_id,'provider',c.provider,'provider_subject',c.provider_subject,
    'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'managed_root',p.managed_root,
    'profile_id',p.id,'policy_version',p.policy_version,'tracks',registered,
    'directory_semantics',jsonb_build_array('topic','asset_collection'),
    'actions',to_jsonb(p_actions)));
end $$;

-- Revisions Clued pinned (kept forever) before overwriting a file. Only rows
-- in state pinned are ever released by Clued. A head the Owner had already
-- kept forever is recorded as owner_kept: restorable, never released, and not
-- counted toward K.
create table clued_private.storage_revision_pins_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  profile_id uuid not null references clued_private.resource_center_profiles_v1(id),
  artifact_id uuid not null references clued_private.resource_center_artifacts_v1(id),
  provider_file_id text not null check(provider_file_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  revision_id text not null check(revision_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  size text not null check(size ~ '^(0|[1-9][0-9]{0,19})$'),
  md5 text check(md5 ~ '^[0-9a-f]{32}$'),
  sha256 text check(sha256 ~ '^[0-9a-f]{64}$'),
  job_id uuid not null unique,
  intent_id uuid not null references clued_private.resource_center_mutations_v1(id),
  pin_receipt_id uuid not null references public.clued_audit_receipts(id),
  state text not null default 'pinned' check(state in ('pinned','released','owner_kept')),
  released_at timestamptz,
  released_receipt_id uuid references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  check(md5 is not null or sha256 is not null),
  check((state='released')=(released_at is not null and released_receipt_id is not null))
);
create unique index storage_revision_pin_active_v1 on clued_private.storage_revision_pins_v1(provider_file_id,revision_id) where state='pinned';
create index storage_revision_pin_artifact_v1 on clued_private.storage_revision_pins_v1(artifact_id,created_at) where state='pinned';
create function clued_private.storage_revision_pins_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'storage_revision_pin_immutable' using errcode='42501'; end if;
  if old.state<>'pinned' or new.state<>'released'
    or (to_jsonb(new)-array['state','released_at','released_receipt_id']) is distinct from (to_jsonb(old)-array['state','released_at','released_receipt_id']) then
    raise exception 'storage_revision_pin_immutable' using errcode='42501'; end if;
  return new;
end $$;
create trigger storage_revision_pins_immutable_v1 before update or delete on clued_private.storage_revision_pins_v1
  for each row execute function clued_private.storage_revision_pins_guard_v1();
alter table clued_private.storage_revision_pins_v1 enable row level security;
revoke all on clued_private.storage_revision_pins_v1 from public,anon,authenticated,service_role;

-- Exact replace shape; paths canonical as for rename/move.
create function clued_private.storage_replace_shape_v1(m jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare dp text; bad constant text:='(\\|//|/\./|/\.\./|/\.$|/\.\.$|/$)'; keys text[];
begin
  if jsonb_typeof(m) is distinct from 'object' then return false; end if;
  select array_agg(k order by k) into keys from jsonb_object_keys(m) k;
  if (keys is distinct from array['content','destination_file_version','destination_path','operation','target_kind']
      and keys is distinct from array['destination_file_version','destination_path','operation','restore_job_id','target_kind'])
    or m->>'operation' is distinct from 'replace' or m->>'target_kind' is distinct from 'file'
    or jsonb_typeof(m->'destination_path') is distinct from 'string'
    or jsonb_typeof(m->'destination_file_version') is distinct from 'string'
    or coalesce(m->>'destination_file_version','') !~ '^[1-9][0-9]{0,39}$'
    or (m ? 'content' and (jsonb_typeof(m->'content') is distinct from 'string' or octet_length(m->>'content')>1048576))
    or (m ? 'restore_job_id' and coalesce(m->>'restore_job_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    return false; end if;
  dp:=m->>'destination_path';
  return length(dp) between 1 and 1000 and dp !~ bad and strpos(dp,'/')>0;
end $$;

-- The registered target Artifact of a replace job (by its exact path).
create function clued_private.storage_replace_target_v1(j clued_private.storage_jobs_v1)
returns clued_private.resource_center_artifacts_v1 language sql stable security definer set search_path='' as $$
  select a.* from clued_private.resource_center_artifacts_v1 a
    join clued_private.storage_connections_v1 c on c.id=j.connection_id and c.owner_id=j.owner_id
    where a.profile_id=c.profile_id and a.user_id=j.owner_id and a.state='active' and a.target_kind='file'
      and a.path=j.mutation->>'destination_path'
$$;

-- Clued pins of one Artifact to release so that at most 10 stay pinned
-- after this replace pins one more: all but the newest 9, oldest first.
create function clued_private.storage_revision_releases_v1(p_artifact uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(revision_id order by created_at,id),'[]'::jsonb) from (
    select revision_id,created_at,id from clued_private.storage_revision_pins_v1
      where artifact_id=p_artifact and state='pinned'
      order by created_at desc,id desc offset 9) older
$$;
create function clued_private.storage_revision_releases_for_job_v1(j clued_private.storage_jobs_v1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare target clued_private.resource_center_artifacts_v1;
begin
  if j.mutation->>'operation' is distinct from 'replace' then return '[]'::jsonb; end if;
  target:=clued_private.storage_replace_target_v1(j);
  if target.id is null then return null; end if;
  return clued_private.storage_revision_releases_v1(target.id);
end $$;

-- The pinned revision a revert restores: the pin recorded by the named
-- committed replace job of the same owner, for the same Artifact, still kept
-- (pinned by Clued, or kept by the Owner).
create function clued_private.storage_restore_v1(j clued_private.storage_jobs_v1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare pin clued_private.storage_revision_pins_v1; target clued_private.resource_center_artifacts_v1;
begin
  if j.mutation->>'operation' is distinct from 'replace' or not (j.mutation ? 'restore_job_id') then return null; end if;
  target:=clued_private.storage_replace_target_v1(j);
  select * into pin from clued_private.storage_revision_pins_v1 where job_id=(j.mutation->>'restore_job_id')::uuid
    and owner_id=j.owner_id and state in ('pinned','owner_kept');
  if target.id is null or pin.id is null or pin.artifact_id<>target.id or pin.provider_file_id<>target.provider_file_id
    or pin.sha256 is null then
    return jsonb_build_object('unavailable',true); end if;
  return jsonb_build_object('revision_id',pin.revision_id,'provider_file_id',pin.provider_file_id,
    'size',pin.size,'md5',pin.md5,'sha256',pin.sha256);
end $$;

-- Expected provider attempt of a replace. The previous content identity and
-- head revision (and whether the Owner already kept it) are observed by the
-- executor and only shape-checked here; the
-- new content's identity, the restore and the releases are the server's.
create function clued_private.storage_replace_attempt_v1(m clued_private.resource_center_mutations_v1,
  j clued_private.storage_jobs_v1,p_attempt jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare before jsonb:=p_attempt->'content_before'; after jsonb; restore jsonb; target clued_private.resource_center_artifacts_v1;
begin
  target:=clued_private.storage_replace_target_v1(j);
  if target.id is null or target.id::text is distinct from m.authority_result->'authority'->>'artifact_id'
    or j.mutation->>'destination_file_version' is distinct from m.authority_request->'provider_identity'->>'destination_file_version'
    or jsonb_typeof(before) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(before) k) is distinct from array['head_revision_id','md5','sha256','size']
    or jsonb_typeof(before->'size') is distinct from 'string' or before->>'size' !~ '^(0|[1-9][0-9]{0,19})$'
    or jsonb_typeof(before->'head_revision_id') is distinct from 'string' or before->>'head_revision_id' !~ '^[A-Za-z0-9_-]{1,200}$'
    or jsonb_typeof(before->'sha256') not in ('string','null') or jsonb_typeof(before->'md5') not in ('string','null')
    or coalesce(before->>'sha256','0'||repeat('a',63)) !~ '^[0-9a-f]{64}$'
    or coalesce(before->>'md5',repeat('a',32)) !~ '^[0-9a-f]{32}$'
    or (before->>'sha256' is null and before->>'md5' is null)
    or p_attempt->>'pinned_revision_id' is distinct from before->>'head_revision_id'
    or jsonb_typeof(p_attempt->'previously_kept') is distinct from 'boolean' then
    return null; end if;
  if j.mutation ? 'content' then
    after:=jsonb_build_object('size',octet_length(j.mutation->>'content')::text,
      'sha256',encode(sha256(convert_to(j.mutation->>'content','UTF8')),'hex'));
  else
    restore:=clued_private.storage_restore_v1(j);
    if restore is null or restore ? 'unavailable' then return null; end if;
    after:=jsonb_build_object('size',restore->>'size','sha256',restore->>'sha256');
  end if;
  return jsonb_build_object('contract','clued.storage-replace-attempt/1','intent_id',m.id,'request_sha256',m.request_sha256,
    'profile_id',m.profile_id,'operation','replace',
    'provider_file_id',m.authority_request->'provider_identity'->>'destination_file_id',
    'destination_path',j.mutation->>'destination_path',
    'parent_id',m.authority_request->'provider_identity'->>'destination_parent_id',
    'destination_file_version',j.mutation->>'destination_file_version','content_before',before,
    'pinned_revision_id',before->>'head_revision_id','previously_kept',p_attempt->'previously_kept','content_after',after,
    'restore_job_id',j.mutation->'restore_job_id','release_revision_ids',clued_private.storage_revision_releases_v1(target.id),
    'target_kind','file','binding',m.exact_request->'binding');
end $$;

-- The settlement authority for a replace is the registered target Artifact.
create or replace function clued_private.storage_settle_authority_v1(p_owner uuid,p clued_private.resource_center_profiles_v1,
  m clued_private.resource_center_mutations_v1,p_mutation jsonb,parent clued_private.resource_center_artifacts_v1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare selected clued_private.resource_center_artifacts_v1; decision_version bigint; existing boolean;
begin
  existing:=p_mutation->>'operation' in ('rename','move','replace');
  if existing then
    select * into selected from clued_private.resource_center_artifacts_v1
      where id=(m.authority_result->'authority'->>'artifact_id')::uuid and profile_id=p.id and user_id=p_owner
        and state='active' and target_kind='file'
        and path=case when p_mutation->>'operation'='replace' then p_mutation->>'destination_path' else p_mutation->>'source_path' end
        and provider_file_id=case when p_mutation->>'operation'='replace'
          then m.authority_request->'provider_identity'->>'destination_file_id' else m.authority_request->'provider_identity'->>'source_file_id' end
        and provider_file_version=case when p_mutation->>'operation'='replace'
          then m.authority_request->'provider_identity'->>'destination_file_version' else m.authority_request->'provider_identity'->>'source_file_version' end;
    if not found or not clued_private.resource_center_path_current_v1(p_owner,p.project_id,p.id,p.managed_root,selected.path)
      or not clued_private.resource_center_decision_current_v1(p_owner,p.project_id,selected.source_decision_id) then
      return null; end if;
  else
    selected:=parent;
  end if;
  select version into decision_version from public.clued_memories where id=selected.source_decision_id and user_id=p_owner;
  return jsonb_build_object('status','resolved','authority',jsonb_build_object(
    'artifact_id',case when existing then selected.id end,
    'artifact_role','clued_resource','governance_class',selected.governance_class,'delete_authority',selected.delete_authority,
    'authority_version',selected.id::text||':'||selected.version::text||':'||decision_version::text,
    'currentness_identity','decision:'||selected.source_decision_id::text||':'||decision_version::text,
    'workspace_version',p.id::text||':'||p.version::text||':'||selected.version::text));
end $$;

-- A replace updates the same Artifact (same path) by CAS, like rename/move.
create or replace function clued_private.storage_settle_input_v1(p_profile uuid,m clued_private.resource_center_mutations_v1,p_proof jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when m.authority_request->'mutation'->>'operation' in ('rename','move','replace') then
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

-- At settlement of a replace: record the kept previous revision, and mark the
-- older pins the proof observed released with the settlement receipt. A pin
-- Drive still kept stays pinned; the next replace lists it again.
create function clued_private.storage_revision_settle_v1(m clued_private.resource_center_mutations_v1,
  j clued_private.storage_jobs_v1,p_proof jsonb,p_receipt uuid)
returns void language plpgsql security definer set search_path='' as $$
declare released int; wanted int;
begin
  if j.mutation->>'operation' is distinct from 'replace' then return; end if;
  wanted:=jsonb_array_length(p_proof->'released_revision_ids');
  update clued_private.storage_revision_pins_v1 set state='released',released_at=clock_timestamp(),released_receipt_id=p_receipt
    where artifact_id=(m.authority_result->'authority'->>'artifact_id')::uuid and state='pinned'
      and revision_id in (select jsonb_array_elements_text(p_proof->'released_revision_ids'));
  get diagnostics released=row_count;
  if released<>wanted then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  insert into clued_private.storage_revision_pins_v1(owner_id,profile_id,artifact_id,provider_file_id,revision_id,size,md5,sha256,
    job_id,intent_id,pin_receipt_id,state)
  values(j.owner_id,m.profile_id,(m.authority_result->'authority'->>'artifact_id')::uuid,p_proof->>'provider_file_id',
    p_proof->>'pinned_revision_id',p_proof->'content_before'->>'size',p_proof->'content_before'->>'md5',
    p_proof->'content_before'->>'sha256',j.job_id,m.id,p_receipt,
    case when (p_proof->>'previously_kept')::boolean then 'owner_kept' else 'pinned' end);
end $$;

-- Native Owner control of the write levels: classes [] / modify / overwrite,
-- one class toggled per call, each with its own disclosure.
create or replace function public.clued_storage_write_access_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; fresh clued_private.storage_account_policies_v2;
  ra clued_private.storage_read_access_v1; moved clued_private.storage_read_access_v1;
  queued clued_private.storage_jobs_v1; qr public.clued_audit_receipts; qreq jsonb; qrefs jsonb; qev text; cancelled jsonb:='[]'::jsonb;
  root text; expected bigint; wanted text[]; current_classes text[]; toggled text; actions text[]; digest text; stored text;
  r public.clued_audit_receipts; refs jsonb; ev text; result jsonb;
  base_actions constant text[]:=array['inspect','create_file','create_topic'];
  disclosure constant text:='clued.storage-modify-disclosure/1';
  overwrite_disclosure constant text:='clued.storage-overwrite-disclosure/1';
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('status','set_classes') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if op='status' then
    if (p_input-array['action','connection_id'])<>'{}'::jsonb or coalesce(p_input->>'connection_id','') !~ uuid_re then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
    if not found then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    select * into policy from clued_private.storage_account_policies_v2
      where id=c.account_policy_id and connection_id=c.id and owner_id=u and state='active';
    return jsonb_build_object('connection_id',c.id,'disclosure_version',disclosure,'overwrite_disclosure_version',overwrite_disclosure,
      'active',policy.id is not null and c.auth_mode='account_policy' and c.state='active',
      -- policy_generation is the set_classes CAS base (0 = no active policy).
      'policy_generation',coalesce(policy.policy_generation,0),
      'classes',coalesce((select jsonb_agg(x order by x) from unnest(policy.actions) x where x in ('modify','overwrite')),'[]'::jsonb));
  end if;
  if (p_input-array['action','connection_id','classes','base_generation','disclosure_version','idempotency_key'])<>'{}'::jsonb
    or not(p_input ?& array['action','connection_id','classes','base_generation','disclosure_version','idempotency_key'])
    or coalesce(p_input->>'connection_id','') !~ uuid_re
    or jsonb_typeof(p_input->'classes') is distinct from 'array'
    or jsonb_typeof(p_input->'base_generation') is distinct from 'number' or p_input->>'base_generation' !~ '^[1-9][0-9]{0,17}$'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  select coalesce(array_agg(x order by x),'{}') into wanted from (select distinct jsonb_array_elements_text(p_input->'classes') x) s;
  if jsonb_array_length(p_input->'classes')<>cardinality(wanted) or not (wanted <@ array['modify','overwrite']) then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  expected:=(p_input->>'base_generation')::bigint;
  -- Unlocked resolution yields only the advisory lock key. The root advisory
  -- is taken before any row lock, as by the evaluators, submit and begin, so a
  -- switch serializes with every admission on this root.
  select pr.root_folder_id into root from clued_private.storage_connections_v1 co
    join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
    where co.id=(p_input->>'connection_id')::uuid and co.owner_id=u;
  if root is null then raise exception 'storage_owner_denied' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  perform clued_private.storage_owner_v1();
  perform clued_private.authorization_account_v12(u);
  select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for update;
  select * into policy from clued_private.storage_account_policies_v2
    where id=c.account_policy_id and connection_id=c.id and owner_id=u for update;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u for share;
  select * into ra from clued_private.storage_read_access_v1 where connection_id=c.id and owner_id=u and state='active' for update;
  r:=clued_private.m1_begin_receipt(u,null,'storage_owner_write_access_v1',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    if r.status='committed' then return r.canonical_result; end if;
    raise exception 'storage_owner_version_conflict' using errcode='40001';
  end if;
  select coalesce(array_agg(x order by x),'{}') into current_classes from unnest(policy.actions) x where x in ('modify','overwrite');
  -- Exactly one class changes per call; its own disclosure must be shown.
  select x into toggled from ((select unnest(wanted) except select unnest(current_classes))
    union all (select unnest(current_classes) except select unnest(wanted))) d(x) limit 1;
  if c.id is null or c.auth_mode<>'account_policy' or c.state<>'active' or c.revoked_at is not null
    or policy.id is null or policy.state<>'active' or p.root_folder_id is distinct from root
    or p.state<>'active' or p.version<>c.profile_version
    or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=u and provider=c.provider
      and provider_subject=c.provider_subject and root_folder_id=root and lineage_id is null and denied)
    or policy.policy_generation<>expected
    or (select count(*) from ((select unnest(wanted) except select unnest(current_classes))
      union all (select unnest(current_classes) except select unnest(wanted))) d)<>1 then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  if p_input->>'disclosure_version' is distinct from (case toggled when 'overwrite' then overwrite_disclosure else disclosure end) then
    raise exception 'storage_write_disclosure_changed' using errcode='40001'; end if;
  -- The switch re-consents only the level. If the scope itself has drifted
  -- (tracks, profile), the current policy no longer evaluates and is not renewed.
  if policy.scope_digest is distinct from clued_private.storage_policy_scope_digest_v3(c.id,policy.scope_contract,policy.actions)
    or coalesce(policy.expires_at<=clock_timestamp(),false) then
    raise exception 'storage_owner_scope_changed' using errcode='42501'; end if;
  -- An unresolved intent may have a provider effect: it keeps its policy and
  -- blocks the switch. Work admitted under the old policy is never re-authorized.
  perform clued_private.storage_root_quiet_v1(u,root);
  -- Queued jobs have no intent and no effect. Cancel them as the Worker's
  -- report would (same idempotency key; a late report returns the job status
  -- unchanged). A Worker that already loaded the job waits on this root lock,
  -- then fails its snapshot check, and the cloud worker refuses any job with a
  -- dispatch outcome before begin.
  for queued in select * from clued_private.storage_jobs_v1 j where j.owner_id=u and j.connection_id=c.id
    and j.intent_id is null and j.dispatch_outcome is null order by j.job_id for update loop
    qreq:=jsonb_build_object('idempotency_key','cloud-dispatch-outcome:'||queued.job_id::text,'job_id',queued.job_id,
      'outcome',jsonb_build_object('status','denied'));
    qr:=clued_private.m1_begin_receipt(u,null,'storage_dispatch_outcome',qreq,clued_private.m1_sha256(qreq));
    if qr.status<>'pending' then raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
    update clued_private.storage_jobs_v1 set dispatch_outcome=qreq->'outcome',dispatch_outcome_receipt_id=qr.id
      where owner_id=u and job_id=queued.job_id;
    qrefs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',queued.job_id));
    qev:=clued_private.m1_append_event_row(u,null,qr.id,qr.canonical_version,'extension:storage:dispatch_outcome',
      qrefs,'project:'||p.project_id::text,null,qreq,qreq->>'idempotency_key',qr.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    perform clued_private.m1_finish_receipt(qr.id,'committed',qrefs,'{}'::jsonb,'{}'::jsonb,array[qev],'{}'::uuid[],null);
    cancelled:=cancelled||to_jsonb(queued.job_id);
  end loop;
  actions:=base_actions||array(select x from unnest(array['modify','overwrite']) x where x=any(wanted));
  digest:=clued_private.storage_policy_scope_digest_v3(c.id,'clued.storage-account-scope/3',actions);
  if digest is null then raise exception 'storage_owner_scope_changed' using errcode='42501'; end if;
  stored:=case when toggled=any(wanted) then p_input->>'disclosure_version' else 'clued.storage-'||toggled||'-disabled/1' end;
  update clued_private.storage_account_policies_v2
    set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=r.id where id=policy.id;
  insert into clued_private.storage_account_policies_v2(owner_id,connection_id,provider,provider_subject,root_folder_id,
    profile_id,actions,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,
    consent_receipt_id,activation_receipt_id,state,expires_at,scope_contract)
  values(u,c.id,policy.provider,policy.provider_subject,policy.root_folder_id,policy.profile_id,actions,digest,
    (select max(policy_generation) from clued_private.storage_account_policies_v2 where connection_id=c.id)+1,
    policy.source_decision_id,policy.decision_version,'native_level_change',stored,r.id,r.id,'active',policy.expires_at,
    'clued.storage-account-scope/3')
  returning * into fresh;
  update clued_private.storage_connections_v1 set account_policy_id=fresh.id,auth_generation=auth_generation+1
    where id=c.id returning * into c;
  -- §3.3 part 1: the read access follows the new policy with the same classes
  -- and disclosure; the Owner's original read consent receipt is kept. A row
  -- bound to any other policy was already inert and is only revoked.
  if ra.id is not null then
    update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=r.id where id=ra.id;
  end if;
  if ra.id is not null and ra.account_policy_id=policy.id then
    insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id)
    values(u,c.id,fresh.id,ra.classes,(select max(read_generation) from clued_private.storage_read_access_v1 where connection_id=c.id)+1,
      ra.disclosure_version,ra.consent_receipt_id)
    returning * into moved;
  end if;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:owner_write_access_v1',
    refs,'project:'||p.project_id::text,null,jsonb_build_object('connection_id',c.id,'classes',to_jsonb(wanted),
      'policy_id',fresh.id,'policy_generation',fresh.policy_generation,'previous_policy_id',policy.id,
      'auth_generation',c.auth_generation,'read_generation',moved.read_generation,'cancelled_jobs',cancelled),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(policy.id::text,expected),
    jsonb_build_object(fresh.id::text,fresh.policy_generation),array[ev],'{}'::uuid[],null);
  perform clued_private.storage_owner_v1();
  return result;
end $$;

do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$    or coalesce(p_action,'') not in ('inspect','create_file','create_topic','modify') then$a$,
     $r$    or coalesce(p_action,'') not in ('inspect','create_file','create_topic','modify','overwrite') then$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$      or m-array['operation','destination_path','target_kind','directory_semantics','content','source_path','source_file_version']<>'{}'::jsonb
      or coalesce(m->>'operation','') not in ('create','rename','move')$a$,
     $r$      or m-array['operation','destination_path','target_kind','directory_semantics','content','source_path','source_file_version',
        'destination_file_version','restore_job_id']<>'{}'::jsonb
      or coalesce(m->>'operation','') not in ('create','rename','move','replace')$r$,1),
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$    elsif m ?| array['source_path','source_file_version'] then$a$,
     $r$    elsif m->>'operation'='replace' then
      wanted:='overwrite';
      if not clued_private.storage_replace_shape_v1(m) then
        raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    elsif m ?| array['source_path','source_file_version','destination_file_version','restore_job_id'] then$r$,1),
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$  wanted:=case when j.mutation->>'operation' in ('rename','move') then 'modify'$a$,
     $r$  wanted:=case when j.mutation->>'operation' in ('rename','move') then 'modify' when j.mutation->>'operation'='replace' then 'overwrite'$r$,1),
    ('clued_private.storage_cloud_job_current_v2(uuid,uuid)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace')$r$,1),
    ('clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)',
     $a$  if j.mutation->>'operation' in ('rename','move') then
    expected:=clued_private.storage_modify_attempt_v1(m,j,p_attempt->'content');
  else$a$,
     $r$  if j.mutation->>'operation' in ('rename','move') then
    expected:=clued_private.storage_modify_attempt_v1(m,j,p_attempt->'content');
  elsif j.mutation->>'operation'='replace' then
    expected:=clued_private.storage_replace_attempt_v1(m,j,p_attempt);
  else$r$,1),
    ('public.clued_resource_center_mutation_journal_v1(uuid,jsonb)',
     $a$        coalesce(v_request->'mutation'->>'operation','') not in ('create','rename','move') then$a$,
     $r$        coalesce(v_request->'mutation'->>'operation','') not in ('create','rename','move','replace') then$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace')$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    if j.mutation->>'operation' in ('rename','move') then
      attempt_expected:=clued_private.storage_modify_attempt_v1(m,j,m.provider_attempt->'content');
    else$a$,
     $r$    if j.mutation->>'operation' in ('rename','move') then
      attempt_expected:=clued_private.storage_modify_attempt_v1(m,j,m.provider_attempt->'content');
    elsif j.mutation->>'operation'='replace' then
      attempt_expected:=clued_private.storage_replace_attempt_v1(m,j,m.provider_attempt);
    else$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$    if j.mutation->>'operation' in ('rename','move') then
      expected:=post||jsonb_build_object('contract','clued.storage-'||(j.mutation->>'operation')||'-verified/1',$a$,
     $r$    if j.mutation->>'operation'='replace' then
      expected:=post||jsonb_build_object('contract','clued.storage-replace-verified/1','operation','replace',
        'destination_file_version',j.mutation->>'destination_file_version','content_before',attempt_expected->'content_before',
        'content_after',attempt_expected->'content_after','pinned_revision_id',attempt_expected->'pinned_revision_id',
        'previously_kept',attempt_expected->'previously_kept',
        'release_revision_ids',attempt_expected->'release_revision_ids','restore_job_id',attempt_expected->'restore_job_id',
        -- Observed releases: distinct members of the attempted list, else null (mismatch).
        'released_revision_ids',case when jsonb_typeof(proof->'released_revision_ids')='array'
          and not exists(select 1 from jsonb_array_elements(proof->'released_revision_ids') e
            where jsonb_typeof(e)<>'string' or not (attempt_expected->'release_revision_ids') @> jsonb_build_array(e))
          and jsonb_array_length(proof->'released_revision_ids')=(select count(distinct e) from jsonb_array_elements(proof->'released_revision_ids') e)
          then proof->'released_revision_ids' end,
        'provider_before',m.authority_request->'provider_identity',
        'checks',jsonb_build_object('identity',true,'ancestors',true,'stable_state',true,'content',true,
          'revision_changed',true,'previous_revision_kept',true,'releases_observed',true));
    elsif j.mutation->>'operation' in ('rename','move') then
      expected:=post||jsonb_build_object('contract','clued.storage-'||(j.mutation->>'operation')||'-verified/1',$r$,1),
    ('clued_private.storage_verified_result_v2(text,jsonb)',
     $a$  registered:=public.clued_resource_center_admin_v1(c.owner_id,registration_input);
  if registered->>'status' is distinct from 'committed' then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;$a$,
     $r$  registered:=public.clued_resource_center_admin_v1(c.owner_id,registration_input);
  if registered->>'status' is distinct from 'committed' then raise exception 'storage_verified_registry_changed' using errcode='40001'; end if;
  perform clued_private.storage_revision_settle_v1(m,j,proof,r.id);$r$,1),
    ('clued_private.storage_cloud_worker_v2(text,jsonb)',
     $a$      'owner_id',c.owner_id,'connection_id',c.id,'job_id',j.job_id,'request_digest',j.request_digest,'mutation',j.mutation,$a$,
     $r$      'owner_id',c.owner_id,'connection_id',c.id,'job_id',j.job_id,'request_digest',j.request_digest,'mutation',j.mutation,
      'restore',clued_private.storage_restore_v1(j),'revision_releases',clued_private.storage_revision_releases_for_job_v1(j),$r$,1),
    ('public.clued_storage_scheduled_recovery_v2(text,jsonb)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace')$r$,1),
    ('public.clued_storage_native_recovery_load_v2(text,jsonb)',
     $a$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move')$a$,
     $r$    or coalesce(j.mutation->>'operation','') not in ('create','rename','move','replace')$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    -- Paired edits are applied together: every edit of one function first,
    -- then one CREATE OR REPLACE.
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_overwrite_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_revision_pins_guard_v1(),
  clued_private.storage_replace_shape_v1(jsonb),
  clued_private.storage_replace_target_v1(clued_private.storage_jobs_v1),
  clued_private.storage_revision_releases_v1(uuid),
  clued_private.storage_revision_releases_for_job_v1(clued_private.storage_jobs_v1),
  clued_private.storage_restore_v1(clued_private.storage_jobs_v1),
  clued_private.storage_replace_attempt_v1(clued_private.resource_center_mutations_v1,clued_private.storage_jobs_v1,jsonb),
  clued_private.storage_revision_settle_v1(clued_private.resource_center_mutations_v1,clued_private.storage_jobs_v1,jsonb,uuid)
  from public,anon,authenticated,service_role;
