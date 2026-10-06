-- Storage connection discovery (Owner Decision 1721045d, Task 1ce7cfa1).
-- Every storage tool takes a connection_id, but no tool told an Agent which
-- connections its own Binding may use, so Agents asked the Owner for an
-- internal ID. public.clued_storage_connections_v1 lists them.
--
-- * Read-only: no receipt, no row is written, no grant changes. The Worker
--   calls it with the caller's Binding hash only, like the jobs RPC.
-- * A connection is listed only when this Binding passes the same evaluators
--   the storage tools use: storage_policy_evaluate_v2 (action inspect, a fresh
--   job key that never names a job) for the write levels, and
--   storage_read_evaluate_v1 for each read class. Each evaluation runs in its
--   own subtransaction; a denial lists nothing for that class and says
--   nothing about why. A connection with no class at all is not listed, so an
--   Agent never learns of a root its Binding cannot use.
-- * The answer names the root (its last path segment and the registered
--   managed_root), the profile's project, its tracks, the write levels in the
--   active policy, the read classes and whether normal use is on. Never the
--   provider subject, credentials, Drive IDs, receipts or the Owner's other
--   Bindings.
-- * The list is a hint, not an admission: every storage call still evaluates
--   its own grant when it runs.

create function public.clued_storage_connections_v1(p_token_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; c clued_private.storage_connections_v1;
  p clued_private.resource_center_profiles_v1; written jsonb; read_ok boolean; content jsonb;
  levels jsonb; reads jsonb; listed jsonb:='[]'::jsonb; total integer:=0;
  max_listed constant integer:=50;
begin
  if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'storage_connections_input_invalid' using errcode='22023'; end if;
  select * into b from public.clued_agent_bindings where token_hash=p_token_hash;
  if not found or b.revoked_at is not null then
    raise exception 'storage_connections_denied' using errcode='42501'; end if;
  for c in select c0.* from clued_private.storage_connections_v1 c0
    join clued_private.resource_center_profiles_v1 p0 on p0.id=c0.profile_id and p0.user_id=c0.owner_id
    where c0.owner_id=b.user_id and c0.auth_mode='account_policy' and c0.state='active' and c0.revoked_at is null
    order by p0.managed_root collate "C",c0.id loop
    written:=null; read_ok:=false; content:=null;
    begin
      written:=clued_private.storage_policy_evaluate_v2(p_token_hash,c.id,'inspect',gen_random_uuid());
    exception when others then written:=null; end;
    begin
      perform clued_private.storage_read_evaluate_v1(p_token_hash,c.id,'read'); read_ok:=true;
    exception when others then read_ok:=false; end;
    begin
      content:=clued_private.storage_read_evaluate_v1(p_token_hash,c.id,'read_content');
    exception when others then content:=null; end;
    if written is null and not read_ok and content is null then continue; end if;
    total:=total+1;
    -- One usable connection past the cap is enough to answer complete:false.
    if total>max_listed then exit; end if;
    select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
    select coalesce(jsonb_agg(x order by array_position(array['create_file','create_topic','modify','overwrite',
        'modify_subtree','destructive'],x)),'[]'::jsonb) into levels
      from jsonb_array_elements_text(coalesce(written->'actions','[]'::jsonb)) x where x<>'inspect';
    reads:=case when read_ok and content is not null then '["read","read_content"]'::jsonb
      when read_ok then '["read"]'::jsonb when content is not null then '["read_content"]'::jsonb else '[]'::jsonb end;
    listed:=listed||jsonb_build_array(jsonb_build_object('connection_id',c.id,
      'name',coalesce(substring(rtrim(p.managed_root,'/') from '[^/]+$'),p.managed_root),
      'managed_root',p.managed_root,'project_id',p.project_id,
      'tracks',coalesce(p.cloud_runtime->'allowed_root_children','[]'::jsonb),
      'inspect',written is not null,'write_levels',levels,'read',reads,
      'normal_use',coalesce(content->>'content_profile'='normal/1'
        and clued_private.storage_scope_covers_v1(c.provider_scope_profile,'normal'),false)));
  end loop;
  return jsonb_build_object('contract','clued.storage-connections/1','connections',listed,
    'complete',total<=max_listed);
end $$;

revoke all on function public.clued_storage_connections_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_connections_v1(text) to anon;
