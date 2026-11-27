-- Share the registration and eligibility facts between the release door
-- and the signed node target. Liveness remains a separate readiness check.
create function clued_private.fleet_delivery_recipient_rows_v1(p_owner uuid)
returns table(node_id uuid,binding_id uuid,registration jsonb)
language sql stable set search_path='' as $$
  select n.node_id,n.binding_id,jsonb_build_object(
    'id',n.node_id,'name',n.name,
    'state',case when n.revoked_at is not null then 'revoked' else n.state end,
    'registrationVersion',n.version,'bindingGeneration',n.binding_generation,'identityFingerprint',n.identity_fingerprint,
    'bindingLive',facts.binding_live,'rebindPending',facts.rebind_pending,
    'recipientExclusion',case
      when n.revoked_at is not null or n.state not in ('pending','active','draining') then 'FLEET_RECIPIENT_INACTIVE'
      when facts.rebind_pending then 'FLEET_RECIPIENT_REBIND_PENDING'
      when not facts.binding_live then 'FLEET_RECIPIENT_BINDING_NOT_LIVE'
      when n.version not between 1 and 9007199254740991 or n.binding_generation not between 1 and 9007199254740991
        or n.identity_fingerprint !~ '^[0-9a-f]{64}$' then 'FLEET_RECIPIENT_BINDING_UNCONFIRMED'
    end)
  from clued_private.ci_nodes_v1 n
  left join public.clued_agent_bindings b on b.user_id=n.user_id and b.id=n.binding_id
  cross join lateral (select coalesce(clued_private.binding_live_v1(b),false) as binding_live,
    exists(select 1 from clued_private.native_confirmation_tokens t
      where t.user_id=n.user_id and t.action='ci_node_binding_rebind' and t.subject_key=n.node_id::text
        and t.consumed_at is null and t.revoked_at is null and t.expires_at>statement_timestamp()) as rebind_pending) facts
  where n.user_id=p_owner
$$;
revoke all on function clued_private.fleet_delivery_recipient_rows_v1(uuid)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- The snapshot binds the caller, candidate and recipients. Runtime observations
-- change independently and do not belong in the release CAS.
create or replace function clued_private.fleet_delivery_registry_v1(c jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare identity clued_private.release_identity_v1%rowtype;
  now_at timestamptz:=statement_timestamp();
  recipients jsonb;
begin
  select * into identity from clued_private.release_identity_v1;
  if not found or not exists(select 1 from public.clued_agent_bindings b
      where b.id=identity.anchor_binding_id and b.user_id=identity.user_id and b.revoked_at is not null) then
    raise exception 'release_door_identity_invalid' using errcode='55000'; end if;
  if not clued_private.ci_renew_account_available_v1(identity.user_id) then
    raise exception 'account_not_available' using errcode='42501'; end if;
  if c->>'repository' is distinct from identity.repository or c->>'scope' is distinct from 'global'
    or coalesce(clued_private.fleet_package_generation_v1(c->>'version'), 0)<25
    or coalesce(c->>'commit','') !~ '^[0-9a-f]{40}$'
    or exists(select 1 from unnest(array['archiveSha256','sourceSha256','requestSha256','kitSha256']) k
      where coalesce(c->>k,'') !~ '^[0-9a-f]{64}$') then
    raise exception 'fleet_delivery_subject_invalid' using errcode='22023'; end if;

  select coalesce(jsonb_agg(n.registration order by n.node_id),'[]'::jsonb)
    into recipients from clued_private.fleet_delivery_recipient_rows_v1(identity.user_id) n;

  return jsonb_build_object('repository',identity.repository,'scope','global','candidate',c,
    'observedAt',now_at,'complete',true,'nodes',recipients,
    'snapshotToken',encode(extensions.digest(jsonb_build_array(identity.user_id,identity.anchor_binding_id,c,recipients)::text,'sha256'),'hex'));
end $$;

do $patch$
declare
  body text:=pg_get_functiondef('clued_private.fleet_node_target_v1(uuid,uuid)'::regprocedure);
  anchor constant text:=$a$from clued_private.ci_nodes_v1 n
        left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id and l.user_id=n.user_id
        where n.user_id=p_owner and n.node_id<>p_node and n.revoked_at is null and n.state in ('pending','active','draining')$a$;
  replacement constant text:=$r$from clued_private.fleet_delivery_recipient_rows_v1(p_owner) n
        left join clued_private.ci_node_liveness_v1 l on l.node_id=n.node_id and l.user_id=p_owner
          and l.last_sender_binding_id=n.binding_id
        where n.node_id<>p_node and n.registration->'recipientExclusion'='null'::jsonb$r$;
begin
  if length(body)-length(replace(body,anchor,'')) <> length(anchor) then
    raise exception 'fleet_delivery_peer_recipients_patch_anchor_mismatch';
  end if;
  execute replace(body,anchor,replacement);
end $patch$;
