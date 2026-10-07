-- Storage connection names (Owner Decision 8d05e50a, Task 7f209eed).
-- A root onboarded on the storage page is registered as
-- /clued-cloud/google-drive/<Drive folder ID>, so clued_storage_connections
-- named it by that ID and returned the ID in managed_root. Now:
-- * name is the profile's display_name (the folder name the Owner chose on
--   the storage page) when it has one, else the last segment of managed_root;
-- * managed_root is null for such an ID path. Agents address paths relative
--   to the registered root, which every storage tool accepts.
-- The Worker accepts a null managed_root from this release on; deploy it
-- before this migration. Changed by an anchored patch with an exact hit count.

do $migration$
declare body text; hits integer; patch record;
begin
  body:=pg_get_functiondef('public.clued_storage_connections_v1(text)'::regprocedure);
  for patch in select * from (values
    ($a$      'name',coalesce(substring(rtrim(p.managed_root,'/') from '[^/]+$'),p.managed_root),
      'managed_root',p.managed_root,'project_id',p.project_id,$a$,
     $r$      'name',coalesce(p.display_name,substring(rtrim(p.managed_root,'/') from '[^/]+$'),p.managed_root),
      'managed_root',case when p.managed_root ~ '^/clued-cloud/google-drive/[A-Za-z0-9_-]+/?$' then null
        else p.managed_root end,'project_id',p.project_id,$r$,1)
  ) v(anchor,replacement,expected) loop
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_connections_display_name_definition_mismatch (% of %)',hits,patch.expected;
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function public.clued_storage_connections_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_connections_v1(text) to anon;
