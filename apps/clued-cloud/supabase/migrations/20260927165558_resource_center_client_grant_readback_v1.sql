-- Native-owner readback only. Never expose credential envelopes, bearer hashes,
-- or an admission proof. This snapshot does not attest executor qualification.
create function clued_private.storage_client_grants_read_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); c clued_private.storage_connections_v1; result jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or p_input is distinct from jsonb_build_object('action','client_grants','connection_id',p_input->'connection_id')
    or jsonb_typeof(p_input->'connection_id') is distinct from 'string' then
    raise exception 'storage_input_invalid' using errcode='22023'; end if;
  select * into c from clued_private.storage_connections_v1
    where id=(p_input->>'connection_id')::uuid and owner_id=u for share;
  if not found then raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
  -- Include stopped grants for inspection/revocation; never revive them by listing.
  select jsonb_build_object('connection_id',c.id,'connection_version',c.version,'connection_state',c.state,
    'grants',coalesce(jsonb_agg(jsonb_build_object(
      'binding_id',g.binding_id,'authorization_version',g.authorization_version,
      'actions',g.actions,'expires_at',g.expires_at,'revoked_at',g.revoked_at,'receipt_id',g.receipt_id,
      'binding_current',b.revoked_at is null and a.revoked_at is null
        and (b.expires_at is null or b.expires_at>clock_timestamp()) and a.expires_at>clock_timestamp()
        and a.version=g.authorization_version
    ) order by g.binding_id),'[]'::jsonb)) into result
    from clued_private.storage_client_grants_v1 g
    join public.clued_agent_bindings b on b.id=g.binding_id and b.user_id=u
    join clued_private.authorizations_v12 a on a.binding_id=b.id and a.owner_id=u
    where g.connection_id=c.id;
  perform clued_private.storage_owner_v1();
  return result;
end $$;
revoke all on function clued_private.storage_client_grants_read_v1(jsonb) from public,anon,authenticated,service_role;

-- Keep the existing provider-root revocation serialization and mutation receipts.
create or replace function public.clued_storage_account_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); root text;
begin
  if p_input->>'action'='client_grants' then
    return clued_private.storage_client_grants_read_v1(p_input);
  end if;
  if p_input->>'action'='revoke_connection' then
    select p.root_folder_id into root from clued_private.storage_connections_v1 c
      join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id
      where c.id=(p_input->>'connection_id')::uuid and c.owner_id=u;
    if root is null then raise exception 'storage_connection_unavailable' using errcode='42501'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
  end if;
  return clued_private.clued_storage_account_v1(p_input);
end $$;
revoke all on function public.clued_storage_account_v1(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_account_v1(jsonb) to authenticated;
