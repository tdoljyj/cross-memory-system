-- Storage client qualification by redirect identity (AccountStorageInheritance.v0.1 §4.2, rev. 2026-09-30).
--
-- A reviewed and qualified client lineage was bound to one exact DCR client ID
-- and every new authorization request needed its own reviewed link. Hosted
-- connectors (claude.ai, chatgpt.com) register a fresh DCR client on every
-- reconnect, so each reconnect silently lost storage access and needed the
-- manual source-capture / register / qualify / link sequence again.
--
-- An approved request without a reviewed link now inherits the ONE active
-- qualified lineage whose anchor registration has the same redirect identity:
-- exact issuer, resource, sorted requested scopes and exact redirect URI, where
-- the redirect URI is https on a public DNS host. The authorization code is only
-- ever delivered to that URI, so a party that registers a look-alike client
-- cannot obtain the resulting token. Loopback, IP-literal, .local and
-- localhost redirects never inherit: any local program can register those.
--
-- Nothing is written: the inherited link is derived on every evaluation, so
-- capability revocation, lineage denies, read-class denies, account policy and
-- Binding/authorization lifecycle keep applying unchanged. A reviewed link, when
-- present, always wins and keeps its exact client-ID contract. Two or more
-- matching active lineages are ambiguous and inherit nothing.

create function clued_private.storage_client_redirect_eligible_v3(p_uri text)
returns boolean language sql immutable security definer set search_path='' as $$
  select coalesce(length(p_uri)<=2048
    -- Lowercase DNS labels; the last label starts with a letter, so no IPv4 or
    -- numeric/hex host form (e.g. 0x7f.1) that URL parsers map to an address.
    and p_uri ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?(:443)?/[^[:space:]#?]*$'
    and p_uri !~ '^https://[0-9.]+(:443)?/'
    and p_uri !~ '^https://([^/:]+\.)?(localhost|local)(:443)?/', false)
$$;

create function clued_private.storage_client_redirect_identity_v3(p_request uuid)
returns text language sql stable security definer set search_path='' as $$
  select clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-client-redirect-identity/1',
    'issuer',r.issuer_hash,'resource',r.resource,'redirect_uri',r.redirect_uri,
    'requested_scopes',(select coalesce(jsonb_agg(s order by s),'[]'::jsonb) from unnest(r.requested_scopes) s)))
  from clued_private.authorization_requests_v12 r
  where r.id=p_request and clued_private.storage_client_redirect_eligible_v3(r.redirect_uri)
$$;

-- The effective request link: the reviewed row if one exists, otherwise the
-- derived inheritance row, otherwise nothing.
create function clued_private.storage_client_request_link_v3(p_request uuid)
returns setof clued_private.storage_client_request_links_v2
language plpgsql stable security definer set search_path='' as $$
declare reviewed clued_private.storage_client_request_links_v2; req clued_private.authorization_requests_v12; identity text;
begin
  select * into reviewed from clued_private.storage_client_request_links_v2 where request_id=p_request;
  if found then return next reviewed; return; end if;
  select * into req from clued_private.authorization_requests_v12 where id=p_request;
  if not found or req.status is distinct from 'approved' then return; end if;
  identity:=clued_private.storage_client_redirect_identity_v3(p_request);
  if identity is null then return; end if;
  return query
    with anchor as (
      select g.* from clued_private.storage_client_capabilities_v2 cap
        join clued_private.storage_client_registrations_v2 g on g.lineage_id=cap.lineage_id and g.generation=cap.registration_generation
        where cap.state='active' and g.issuer_hash=req.issuer_hash and g.resource=req.resource and g.source_request_id is not null
          and clued_private.storage_client_redirect_identity_v3(g.source_request_id)=identity)
    select p_request,anchor.lineage_id,anchor.generation,clued_private.storage_client_request_digest_v2(p_request),
      anchor.review_receipt_id,anchor.source_metadata_digest,anchor.source_snapshot_sha256,anchor.source_evidence_id,anchor.source_snapshot
    from anchor where (select count(distinct lineage_id) from anchor)=1;
end $$;

-- Replaces the exact client-ID/digest comparison in every storage evaluator.
-- Reviewed link: the original contract, unchanged. Inherited link: only the
-- derived row itself, re-derived here, is accepted.
create function clued_private.storage_client_request_matches_v3(p_request uuid,p_lineage uuid,p_generation bigint,p_link_digest text)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(case
    when exists(select 1 from clued_private.storage_client_request_links_v2 l where l.request_id=p_request) then
      (select g.client_id=r.client_id and g.metadata_digest=p_link_digest
          and g.metadata_digest=clued_private.storage_client_request_digest_v2(r.id)
        from clued_private.authorization_requests_v12 r
        join clued_private.storage_client_registrations_v2 g on g.lineage_id=p_lineage and g.generation=p_generation
        where r.id=p_request)
    else exists(select 1 from clued_private.storage_client_request_link_v3(p_request) d
      where d.lineage_id=p_lineage and d.registration_generation=p_generation and d.metadata_digest=p_link_digest)
  end,false)
$$;

do $migration$
declare fn regprocedure;
begin
  foreach fn in array array[
    'clued_private.storage_client_redirect_eligible_v3(text)'::regprocedure,
    'clued_private.storage_client_redirect_identity_v3(uuid)'::regprocedure,
    'clued_private.storage_client_request_link_v3(uuid)'::regprocedure,
    'clued_private.storage_client_request_matches_v3(uuid,uuid,bigint,text)'::regprocedure] loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn);
  end loop;
end $migration$;

-- Every reader of request links goes through the effective link. Each anchor
-- must occur exactly the expected number of times in the deployed definition.
do $migration$
declare patch record; body text; hits int;
begin
  for patch in select * from (values
    -- Read evaluator (20260930010000).
    ('clued_private.storage_read_evaluate_v1(text,uuid,text)',
     $a$join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id$a$,
     $r$join lateral clued_private.storage_client_request_link_v3(a0.request_id) l on true$r$,1),
    ('clued_private.storage_read_evaluate_v1(text,uuid,text)',
     $a$select * into link from clued_private.storage_client_request_links_v2 where request_id=request_key;$a$,
     $r$select * into link from clued_private.storage_client_request_link_v3(request_key);$r$,1),
    ('clued_private.storage_read_evaluate_v1(text,uuid,text)',
     $a$    or registration.client_id is distinct from req.client_id or registration.metadata_digest is distinct from link.metadata_digest
    or registration.metadata_digest is distinct from clued_private.storage_client_request_digest_v2(req.id) then$a$,
     $r$    or not clued_private.storage_client_request_matches_v3(req.id,registration.lineage_id,registration.generation,link.metadata_digest) then$r$,1),
    -- Write evaluator.
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id$a$,
     $r$join lateral clued_private.storage_client_request_link_v3(a0.request_id) l on true$r$,1),
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$select * into link from clued_private.storage_client_request_links_v2 where request_id=request_key;$a$,
     $r$select * into link from clued_private.storage_client_request_link_v3(request_key);$r$,1),
    ('clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)',
     $a$    or registration.client_id is distinct from req.client_id or registration.metadata_digest is distinct from link.metadata_digest
    or registration.metadata_digest is distinct from clued_private.storage_client_request_digest_v2(req.id) then$a$,
     $r$    or not clued_private.storage_client_request_matches_v3(req.id,registration.lineage_id,registration.generation,link.metadata_digest) then$r$,1),
    -- Job history.
    ('clued_private.storage_job_history_v2(text,uuid,uuid,text)',
     $a$join clued_private.storage_client_request_links_v2 l on l.request_id=q.id$a$,
     $r$join lateral clued_private.storage_client_request_link_v3(q.id) l on true$r$,1),
    ('clued_private.storage_job_history_v2(text,uuid,uuid,text)',
     $a$select * into link from clued_private.storage_client_request_links_v2 where request_id=request_key;$a$,
     $r$select * into link from clued_private.storage_client_request_link_v3(request_key);$r$,1),
    ('clued_private.storage_job_history_v2(text,uuid,uuid,text)',
     $a$    or registration.client_id is distinct from req.client_id or registration.metadata_digest is distinct from link.metadata_digest
    or link.metadata_digest is distinct from clued_private.storage_client_request_digest_v2(req.id) then$a$,
     $r$    or not clued_private.storage_client_request_matches_v3(req.id,registration.lineage_id,registration.generation,link.metadata_digest) then$r$,1),
    -- Policy transition inventory.
    ('clued_private.storage_policy_transition_inventory_v2(uuid,uuid,jsonb)',
     $a$join clued_private.storage_client_request_links_v2 l on l.request_id=req.id$a$,
     $r$join lateral clued_private.storage_client_request_link_v3(req.id) l on true$r$,1),
    ('clued_private.storage_policy_transition_inventory_v2(uuid,uuid,jsonb)',
     $a$        and reg.resource=req.resource and reg.client_id=req.client_id and a.client_id=req.client_id and a.resource=req.resource
        and reg.metadata_digest=l.metadata_digest and reg.metadata_digest=clued_private.storage_client_request_digest_v2(req.id)$a$,
     $r$        and reg.resource=req.resource and a.client_id=req.client_id and a.resource=req.resource
        and clued_private.storage_client_request_matches_v3(req.id,reg.lineage_id,reg.generation,l.metadata_digest)$r$,1),
    ('clued_private.storage_policy_transition_inventory_v2(uuid,uuid,jsonb)',
     $a$join clued_private.storage_client_request_links_v2 l on l.request_id=a.request_id$a$,
     $r$join lateral clued_private.storage_client_request_link_v3(a.request_id) l on true$r$,1),
    -- Owner client list and client deny.
    ('public.clued_storage_owner_manage_v2(jsonb)',
     $a$join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id$a$,
     $r$join lateral clued_private.storage_client_request_link_v3(a0.request_id) l on true$r$,2),
    ('public.clued_storage_owner_manage_v2(jsonb)',
     $a$select * into link from clued_private.storage_client_request_links_v2 where request_id=a.request_id;$a$,
     $r$select * into link from clued_private.storage_client_request_link_v3(a.request_id);$r$,1),
    -- Owner read-class list and read-class deny.
    ('public.clued_storage_read_access_v1(jsonb)',
     $a$join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id$a$,
     $r$join lateral clued_private.storage_client_request_link_v3(a0.request_id) l on true$r$,2),
    ('public.clued_storage_read_access_v1(jsonb)',
     $a$select * into link from clued_private.storage_client_request_links_v2 where request_id=a.request_id;$a$,
     $r$select * into link from clued_private.storage_client_request_link_v3(a.request_id);$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    body:=pg_get_functiondef(patch.sig::regprocedure);
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_client_redirect_identity_definition_mismatch: % (% of %)',patch.sig,hits,patch.expected;
    end if;
    execute replace(body,patch.anchor,patch.replacement);
  end loop;
end $migration$;

-- No reader may keep a direct table read that bypasses the effective link.
do $migration$
declare leftover text;
begin
  select string_agg(p.oid::regprocedure::text,', ') into leftover
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','clued_private')
      and (n.nspname,p.proname) in (('clued_private','storage_read_evaluate_v1'),('clued_private','storage_policy_evaluate_v2'),
        ('clued_private','storage_job_history_v2'),('clued_private','storage_policy_transition_inventory_v2'),
        ('public','clued_storage_owner_manage_v2'),('public','clued_storage_read_access_v1'))
      and (p.prosrc ~ 'from clued_private\.storage_client_request_links_v2' or p.prosrc ~ 'join clued_private\.storage_client_request_links_v2'
        or p.prosrc ~ 'registration\.client_id is distinct from req\.client_id');
  if leftover is not null then raise exception 'storage_client_redirect_identity_direct_link_read: %',leftover; end if;
end $migration$;
