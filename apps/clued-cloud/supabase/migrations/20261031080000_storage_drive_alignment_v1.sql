-- Storage alignment with Google Drive, batch 1 (Task 2e8ed1da item 3, Owner
-- Decisions 24422a98 and f382c494): the Resource Center's layout rules stay,
-- but a file written where the rules do not allow is placed by the program
-- instead of refused.
--
-- A new file (create or write) whose destination is directly in the managed
-- root, or under a top-level folder that is not one of the profile's allowed
-- tracks, is written to <managed_root>/90_待归类/<its name> when that track
-- is allowed. The job, its receipt and any staging row bind the placed path
-- (it is computed before the request digest), so inspect reports where the
-- file went. The navigation folder, sources, directories, replacements,
-- paths outside the root and profiles without 90_待归类 are unchanged.

create function clued_private.storage_route_destination_v1(p_hash text,p_connection uuid,p_path text)
returns text language plpgsql stable security definer set search_path='' as $$
declare full_path text:=clued_private.storage_connection_path_v1(p_hash,p_connection,p_path);
  root text; tracks jsonb; rel text; first text;
begin
  select p.managed_root,p.cloud_runtime->'allowed_root_children' into root,tracks
    from clued_private.storage_connections_v1 c
    join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id and p.user_id=c.owner_id
    where c.id=p_connection;
  -- Only a path the connection path resolution placed under this root.
  if root is null or jsonb_typeof(tracks) is distinct from 'array' or not (tracks ? '90_待归类')
    or left(full_path,char_length(root)+1) is distinct from root||'/' then return full_path; end if;
  rel:=substr(full_path,char_length(root)+2);
  first:=split_part(rel,'/',1);
  if strpos(rel,'/')>0 and (tracks ? first or first='00_从这里开始') then return full_path; end if;
  return root||'/90_待归类/'||regexp_replace(rel,'^.*/','');
end $$;
revoke all on function clued_private.storage_route_destination_v1(text,uuid,text) from public,anon,authenticated,service_role;

create or replace function clued_private.storage_mutation_paths_v1(p_hash text, p_connection uuid, m jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if jsonb_typeof(m->'destination_path')='string' then
    m:=m||jsonb_build_object('destination_path',
      case when m->>'operation' in ('create','write') and coalesce(m->>'target_kind','file')='file'
        then clued_private.storage_route_destination_v1(p_hash,p_connection,m->>'destination_path')
        else clued_private.storage_connection_path_v1(p_hash,p_connection,m->>'destination_path') end);
  end if;
  if jsonb_typeof(m->'source_path')='string' then
    m:=m||jsonb_build_object('source_path',clued_private.storage_connection_path_v1(p_hash,p_connection,m->>'source_path'));
  end if;
  return m;
end $$;

-- Binary staging takes a new file or a replacement and cannot tell them
-- apart; a replacement names a registered file, which is already in an
-- allowed place, so placing it changes nothing (and a mismatch with the later
-- replace job fails closed).
do $migration$
declare body text; anchor text:=$a$    p_input:=p_input||jsonb_build_object('destination_path',clued_private.storage_connection_path_v1(
      p_token_hash,(p_input->>'connection_id')::uuid,p_input->>'destination_path'));$a$; hits int;
begin
  body:=pg_get_functiondef('clued_private.ii_pub_clued_storage_staging_v1(text,text,jsonb)'::regprocedure);
  hits:=(length(body)-length(replace(body,anchor,'')))/length(anchor);
  if hits<>1 then raise exception 'storage_drive_alignment_definition_mismatch: staging (% of 1)',hits; end if;
  execute replace(body,anchor,$r$    p_input:=p_input||jsonb_build_object('destination_path',clued_private.storage_route_destination_v1(
      p_token_hash,(p_input->>'connection_id')::uuid,p_input->>'destination_path'));$r$);
end $migration$;
