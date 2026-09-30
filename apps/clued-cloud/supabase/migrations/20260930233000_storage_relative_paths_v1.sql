-- Storage relative paths v1: a write path may be given relative to the
-- connection's registered root.
--
-- Agents browse and resolve with root-relative paths (clued_storage_browse
-- resolve takes "a/b/c"), and naturally submit writes the same way, e.g.
-- "90_待归类/x.md". Until now clued_storage_submit and
-- clued_storage_upload_begin accepted such a path, queued the job, and the
-- cloud executor then denied it (ARTIFACT_AUTHORITY_RESOLUTION_FAILED),
-- because policy and provider-identity resolution work on the full path under
-- the profile's managed_root. With the full path the same write commits.
--
-- Every destination_path and source_path is now canonicalized to the full
-- path BEFORE the request digest is computed, so the stored job, its receipt
-- and the staging row bind the full path, and a relative and a full path for
-- the same target produce the same digest (same job_id replays):
--
--   * a path equal to <managed_root>/<rest> is kept unchanged;
--   * a relative path (no leading "/" or "\", no drive prefix "X:", no
--     scheme "x://") becomes <managed_root>/<path>;
--   * anything else absolute is refused as storage_path_outside_root;
--   * an empty, "." or ".." segment, a trailing "/", a backslash, a control
--     character, the root itself, or a full path over 1000 characters is
--     refused as storage_path_invalid.
--
-- Both are fixed codes (errcode 22023) raised at submit / upload_begin, before
-- any staging row, receipt or job row exists. They carry no path.
-- A connection that this Binding's owner does not hold resolves no root; its
-- path is left as given and the unchanged policy evaluator denies it.
--
-- Replay note: a job submitted earlier with a relative path bound the
-- relative path in its digest (all such jobs were denied by the executor).
-- Re-submitting that job_id with the same relative path now canonicalizes to
-- a different digest and is refused as a job identity conflict; inspect still
-- returns the stored status. Use a new job_id for the corrected write.
-- The legacy clued_storage_jobs_v1 (legacy auth mode) is not changed.

create function clued_private.storage_path_canonical_v1(p_root text,p_path text)
returns text language plpgsql immutable set search_path='' as $$
declare rel text; full_path text;
begin
  if p_root is null or p_path is null or p_root='' or right(p_root,1)='/' then
    raise exception 'storage_path_invalid' using errcode='22023'; end if;
  if left(p_path,char_length(p_root)+1)=p_root||'/' then
    rel:=substr(p_path,char_length(p_root)+2);
  elsif p_path=p_root then
    raise exception 'storage_path_invalid' using errcode='22023';
  elsif left(p_path,1) in ('/',E'\\') or p_path ~ '^[A-Za-z]:' or p_path ~ '^[A-Za-z][A-Za-z0-9+.-]*://' then
    raise exception 'storage_path_outside_root' using errcode='22023';
  else
    rel:=p_path;
  end if;
  if rel='' or left(rel,1)='/' or rel ~ '(^|/)\.{1,2}(/|$)' or strpos(rel,'//')>0 or right(rel,1)='/'
    or strpos(rel,E'\\')>0 or rel ~ '[\x01-\x1f\x7f]' then
    raise exception 'storage_path_invalid' using errcode='22023'; end if;
  full_path:=p_root||'/'||rel;
  if length(full_path)>1000 then raise exception 'storage_path_invalid' using errcode='22023'; end if;
  return full_path;
end $$;
revoke all on function clued_private.storage_path_canonical_v1(text,text) from public,anon,authenticated,service_role;

-- Root lookup only (the connection's registered profile, for this Binding's
-- owner). Authorization stays with storage_policy_evaluate_v2. The root is
-- resolved only for a live storage client Binding (not revoked, with an
-- unrevoked, unexpired v12 authorization linked to a storage client request), so a
-- revoked or non-storage token cannot use the distinct path refusals to
-- confirm a guessed managed_root; for any other caller the path is left as
-- given and the unchanged policy evaluator denies it as before.
create function clued_private.storage_connection_path_v1(p_hash text,p_connection uuid,p_path text)
returns text language plpgsql stable security definer set search_path='' as $$
declare root text;
begin
  select p.managed_root into root from public.clued_agent_bindings b
    join clued_private.authorizations_v12 a on a.binding_id=b.id and a.owner_id=b.user_id and a.revoked_at is null
      and a.expires_at>now()
    join clued_private.storage_client_request_links_v2 l on l.request_id=a.request_id
    join clued_private.storage_connections_v1 c on c.owner_id=b.user_id and c.id=p_connection
    join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id and p.user_id=b.user_id
    where b.token_hash=p_hash and b.revoked_at is null;
  if root is null then return p_path; end if;
  return clued_private.storage_path_canonical_v1(root,p_path);
end $$;
revoke all on function clued_private.storage_connection_path_v1(text,uuid,text) from public,anon,authenticated,service_role;

create function clued_private.storage_mutation_paths_v1(p_hash text,p_connection uuid,m jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if jsonb_typeof(m->'destination_path')='string' then
    m:=m||jsonb_build_object('destination_path',clued_private.storage_connection_path_v1(p_hash,p_connection,m->>'destination_path'));
  end if;
  if jsonb_typeof(m->'source_path')='string' then
    m:=m||jsonb_build_object('source_path',clued_private.storage_connection_path_v1(p_hash,p_connection,m->>'source_path'));
  end if;
  return m;
end $$;
revoke all on function clued_private.storage_mutation_paths_v1(text,uuid,jsonb) from public,anon,authenticated,service_role;

-- Anchored patches on the latest definitions (every edit of one function
-- first, then one CREATE OR REPLACE), as in 20260930230000.
do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- Submit: canonicalize both paths before shape checks, staging match and the digest.
    ('clued_private.storage_jobs_policy_core_v2(text,jsonb)',
     $a$      or length(m->>'destination_path') not between 1 and 1000 then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    if m->>'operation' in ('rename','move') then$a$,
     $r$      or length(m->>'destination_path') not between 1 and 1000 then
      raise exception 'storage_job_input_invalid' using errcode='22023'; end if;
    m:=clued_private.storage_mutation_paths_v1(p_token_hash,connection_id,m);
    if m->>'operation' in ('rename','move') then$r$,1),
    -- upload_begin: the staging row stores (and returns) the full path, so the
    -- later submit (relative or full) matches it after its own canonicalization.
    ('public.clued_storage_staging_v1(text,text,jsonb)',
     $a$      raise exception 'storage_staging_input_invalid' using errcode='22023'; end if;
    if not clued_private.storage_binary_mime_v1(p_input->>'destination_path',p_input->>'mime_type') then$a$,
     $r$      raise exception 'storage_staging_input_invalid' using errcode='22023'; end if;
    p_input:=p_input||jsonb_build_object('destination_path',clued_private.storage_connection_path_v1(
      p_token_hash,(p_input->>'connection_id')::uuid,p_input->>'destination_path'));
    if not clued_private.storage_binary_mime_v1(p_input->>'destination_path',p_input->>'mime_type') then$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_relative_paths_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;
