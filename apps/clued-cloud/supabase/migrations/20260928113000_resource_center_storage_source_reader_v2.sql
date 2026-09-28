-- Least-privilege source capture for storage-client qualification.
-- Runtime LOGIN credentials receive membership in this NOLOGIN role. They can
-- resolve one exact approved request, but cannot read the backing tables.

do $$
begin
  if not exists(select 1 from pg_catalog.pg_roles where rolname='clued_storage_source_reader_v2') then
    create role clued_storage_source_reader_v2 nologin
      nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end $$;

create schema clued_storage_source;
revoke all on schema clued_storage_source from public,anon,authenticated,service_role;

create function clued_storage_source.authorization_request_snapshot_v2(p_request_id uuid)
returns table(
  id uuid,
  request_digest text,
  client_id text,
  client_name text,
  redirect_uri text,
  resource text,
  requested_scopes text[],
  status text
)
language sql stable security definer set search_path='' as $$
  select r.id,r.request_digest,r.client_id,r.client_name,r.redirect_uri,
    r.resource,r.requested_scopes,r.status
  from clued_private.authorization_requests_v12 r
  join clued_private.authorization_issuers_v12 i
    on i.token_hash=r.issuer_hash and i.resource=r.resource
  join clued_private.authorizations_v12 a
    on a.request_id=r.id and a.binding_id=r.binding_id and a.owner_id=r.owner_id
  join public.clued_agent_bindings b
    on b.id=a.binding_id and b.user_id=r.owner_id
  where r.id=p_request_id and r.status='approved'
    and i.revoked_at is null and a.revoked_at is null and b.revoked_at is null
    and a.client_id=r.client_id and a.resource=r.resource
$$;

revoke all on function clued_storage_source.authorization_request_snapshot_v2(uuid)
  from public,anon,authenticated,service_role;
grant usage on schema clued_storage_source to clued_storage_source_reader_v2;
grant execute on function clued_storage_source.authorization_request_snapshot_v2(uuid)
  to clued_storage_source_reader_v2;
