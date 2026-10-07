-- Binary replace (Owner Decision 06aba6c5, 2026-10-07): replace one registered
-- binary file (OOXML/ODF Office, PDF, images, zip) in place, keeping its Drive
-- file ID and revision history. It amends only the "no binary replace" line of
-- Decision 7dbb4c09 (StorageNormalUse.v0.1 §1); the rest of P4 is unchanged.
--
-- * Submit accepts {replace, file, destination_path, destination_file_version,
--   staging_id, mime_type, content_sha256}. The staged object (from
--   clued_storage_upload_begin, or inline content_base64 staged by the Worker)
--   is bound exactly as for a binary create and becomes content_ref. The
--   staged file is at most 5 MiB (one Drive media upload) and its type must
--   be an accepted binary type for the path's extension.
-- * The level is overwrite, as for a text replace. Staging itself still needs
--   create_file, which every write policy includes, and normal use (the same
--   binary gate as a binary create, re-checked at consume and at execution).
-- * The provider attempt's content_after is the staged object's size and
--   sha256. Proof, settlement, revision pins and revert are those of P4.
-- * The executor additionally requires the Drive file's own type to equal the
--   staged type: replace never changes a file's format.

create function clued_private.storage_binary_replace_mutation_v1(p_connection uuid,m jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare keys text[]; s clued_private.storage_staging_v1;
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  select array_agg(k order by k) into keys from jsonb_object_keys(m) k;
  if keys is distinct from array['content_sha256','destination_file_version','destination_path','mime_type','operation','staging_id','target_kind']
    or m->>'operation' is distinct from 'replace' or m->>'target_kind' is distinct from 'file'
    or jsonb_typeof(m->'destination_file_version') is distinct from 'string'
    or jsonb_typeof(m->'staging_id') is distinct from 'string' or m->>'staging_id' !~ uuid_re
    or jsonb_typeof(m->'content_sha256') is distinct from 'string' or m->>'content_sha256' !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(m->'mime_type') is distinct from 'string'
    or not clued_private.storage_binary_mime_v1(m->>'destination_path',m->>'mime_type') then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  select * into s from clued_private.storage_staging_v1 where id=(m->>'staging_id')::uuid and connection_id=p_connection;
  if not found or s.destination_path is distinct from m->>'destination_path' or s.mime_type is distinct from m->>'mime_type'
    or s.sha256 is distinct from m->>'content_sha256' or s.size>5242880 then
    raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
  return jsonb_build_object('operation','replace','target_kind','file','destination_path',s.destination_path,
    'destination_file_version',m->>'destination_file_version',
    'content_ref',jsonb_build_object('staging_id',s.id,'sha256',s.sha256,'size',s.size,'mime_type',s.mime_type));
end $$;

-- The replace shape: new text, a revert, or (new) a staged binary content_ref.
create or replace function clued_private.storage_replace_shape_v1(m jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare dp text; bad constant text:='(\\|//|/\./|/\.\./|/\.$|/\.\.$|/$)'; keys text[];
begin
  if jsonb_typeof(m) is distinct from 'object' then return false; end if;
  select array_agg(k order by k) into keys from jsonb_object_keys(m) k;
  if (keys is distinct from array['content','destination_file_version','destination_path','operation','target_kind']
      and keys is distinct from array['destination_file_version','destination_path','operation','restore_job_id','target_kind']
      and keys is distinct from array['content_ref','destination_file_version','destination_path','operation','target_kind'])
    or m->>'operation' is distinct from 'replace' or m->>'target_kind' is distinct from 'file'
    or jsonb_typeof(m->'destination_path') is distinct from 'string'
    or jsonb_typeof(m->'destination_file_version') is distinct from 'string'
    or coalesce(m->>'destination_file_version','') !~ '^[1-9][0-9]{0,39}$'
    or (m ? 'content' and (jsonb_typeof(m->'content') is distinct from 'string' or octet_length(m->>'content')>1048576))
    or (m ? 'restore_job_id' and coalesce(m->>'restore_job_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or (m ? 'content_ref' and (jsonb_typeof(m->'content_ref') is distinct from 'object'
      or (select array_agg(k order by k) from jsonb_object_keys(m->'content_ref') k) is distinct from array['mime_type','sha256','size','staging_id']
      or case when jsonb_typeof(m->'content_ref'->'size')='number'
        then (m->'content_ref'->>'size')::numeric not between 1 and 5242880 else true end
      or coalesce(m->'content_ref'->>'sha256','') !~ '^[0-9a-f]{64}$'
      or coalesce(m->'content_ref'->>'staging_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not clued_private.storage_binary_mime_v1(m->>'destination_path',m->'content_ref'->>'mime_type'))) then
    return false; end if;
  dp:=m->>'destination_path';
  return length(dp) between 1 and 1000 and dp !~ bad and strpos(dp,'/')>0;
end $$;

-- content_after of a binary replace is the staged object's identity.
create or replace function clued_private.storage_replace_attempt_v1(m clued_private.resource_center_mutations_v1,
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
  elsif j.mutation ? 'content_ref' then
    after:=jsonb_build_object('size',j.mutation->'content_ref'->>'size','sha256',j.mutation->'content_ref'->>'sha256');
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

-- Submit: a replace carrying staging_id becomes a content_ref replace first.
do $migration$
declare body text; hits int;
  anchor constant text:=$a$    elsif m->>'operation'='replace' then
      wanted:='overwrite';
      if not clued_private.storage_replace_shape_v1(m) then$a$;
  replacement constant text:=$r$    elsif m->>'operation'='replace' then
      wanted:='overwrite';
      if m ? 'staging_id' then m:=clued_private.storage_binary_replace_mutation_v1(connection_id,m); end if;
      if not clued_private.storage_replace_shape_v1(m) then$r$;
begin
  body:=pg_get_functiondef('clued_private.storage_jobs_policy_core_v2(text,jsonb)'::regprocedure);
  hits:=(length(body)-length(replace(body,anchor,'')))/length(anchor);
  if hits<>1 then raise exception 'storage_binary_replace_definition_mismatch: storage_jobs_policy_core_v2 (% of 1)',hits; end if;
  execute replace(body,anchor,replacement);
end $migration$;

revoke all on function clued_private.storage_binary_replace_mutation_v1(uuid,jsonb),
  clued_private.storage_replace_shape_v1(jsonb),
  clued_private.storage_replace_attempt_v1(clued_private.resource_center_mutations_v1,clued_private.storage_jobs_v1,jsonb)
  from public,anon,authenticated,service_role;
