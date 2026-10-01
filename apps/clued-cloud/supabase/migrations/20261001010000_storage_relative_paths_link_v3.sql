-- Storage relative paths: resolve the root through the same storage client
-- link lookup as the policy evaluator.
--
-- 20260930233000 resolved the managed root only when the Binding's v12
-- request had a reviewed row in storage_client_request_links_v2. Production
-- storage clients are linked through the redirect-identity anchor instead
-- (storage_client_request_link_v3, used by storage_policy_evaluate_v2), so a
-- live production client resolved no root, its relative path was left as
-- given, and the executor denied the job (ARTIFACT_AUTHORITY_RESOLUTION_FAILED)
-- exactly as before the fix. The root lookup now uses
-- storage_client_request_link_v3, which returns the reviewed link when one
-- exists and otherwise the single active redirect-identity anchor. The other
-- conditions (unrevoked Binding, unrevoked and unexpired v12 authorization,
-- the owner's connection and profile) are unchanged.
create or replace function clued_private.storage_connection_path_v1(p_hash text,p_connection uuid,p_path text)
returns text language plpgsql stable security definer set search_path='' as $$
declare root text;
begin
  select p.managed_root into root from public.clued_agent_bindings b
    join clued_private.authorizations_v12 a on a.binding_id=b.id and a.owner_id=b.user_id and a.revoked_at is null
      and a.expires_at>now()
    join lateral clued_private.storage_client_request_link_v3(a.request_id) l on true
    join clued_private.storage_connections_v1 c on c.owner_id=b.user_id and c.id=p_connection
    join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id and p.user_id=b.user_id
    where b.token_hash=p_hash and b.revoked_at is null;
  if root is null then return p_path; end if;
  return clued_private.storage_path_canonical_v1(root,p_path);
end $$;
revoke all on function clued_private.storage_connection_path_v1(text,uuid,text) from public,anon,authenticated,service_role;
