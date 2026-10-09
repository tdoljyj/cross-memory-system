-- P0-4 step 2b. Owner Decision 818a9b05: stable issuer identity is separate from credentials;
-- new storage registrations use a new digest contract; rotate each issuer separately and retire its old key
-- immediately after verification. Historical issuer keys, registrations, request links, receipts and verified
-- JSON are not rewritten. A historical 64-hex issuer key is an identity, NOT an authentication fallback.

create table if not exists clued_private.issuer_identities_v1 (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('authorization','storage')),
  legacy_key text not null check (legacy_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(kind,legacy_key)
);
create table if not exists clued_private.issuer_credentials_v1 (
  issuer_id uuid not null references clued_private.issuer_identities_v1(id),
  generation bigint not null check (generation > 0),
  verifier text not null unique check (verifier ~ '^cv1:[0-9a-f]{64}$'),
  state text not null check (state in ('staged','active','retired')),
  created_at timestamptz not null default clock_timestamp(),
  activated_at timestamptz,
  valid_until timestamptz,
  retired_at timestamptz,
  primary key(issuer_id,generation),
  check ((state='staged' and activated_at is null and retired_at is null)
    or (state='active' and activated_at is not null and retired_at is null)
    or (state='retired' and retired_at is not null)),
  check (valid_until is null or valid_until > created_at)
);
-- Requests created before this boundary retain exactly the original /2 input, including the historical key.
-- Requests created after it use /3 with the stable UUID. This sidecar does not modify any historical payload.
create table if not exists clued_private.storage_client_digest_contracts_v1 (
  request_id uuid primary key references clued_private.authorization_requests_v12(id) on delete cascade,
  contract_version integer not null check (contract_version in (2,3))
);
-- This is a private versioned implementation source, required for deterministic reapplication of this
-- migration. It contains function definitions, not credential proofs or a seven-day rollback backup.
create table if not exists clued_private.issuer_function_sources_v1 (
  signature text primary key, schema_name text not null, function_name text not null,
  definition text not null, argument_names text[] not null, arguments text not null,
  result_type text not null, credential_argument integer,
  kind text not null check(kind in ('authorization','storage')),
  identity_name text
);
alter table clued_private.issuer_identities_v1 enable row level security;
alter table clued_private.issuer_credentials_v1 enable row level security;
alter table clued_private.storage_client_digest_contracts_v1 enable row level security;
alter table clued_private.issuer_function_sources_v1 enable row level security;
revoke all on clued_private.issuer_identities_v1,clued_private.issuer_credentials_v1,
  clued_private.storage_client_digest_contracts_v1,clued_private.issuer_function_sources_v1
  from public,anon,authenticated,service_role;

insert into clued_private.issuer_identities_v1(kind,legacy_key)
  select 'authorization',token_hash from clued_private.authorization_issuers_v12
  union all select 'storage',issuer_hash from clued_private.storage_oauth_apps_v1
  on conflict(kind,legacy_key) do nothing;
-- Only issuers present at the first application receive a bounded legacy cutover credential. New identities
-- never imply credentials. Reapplication does not extend, revive or create credentials for later identities.
insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at,valid_until)
  select id,1,'cv1:'||encode(extensions.digest('clued.credential-verifier.v1:'||legacy_key,'sha256'),'hex'),
    'active',clock_timestamp(),clock_timestamp()+interval '24 hours' from clued_private.issuer_identities_v1
    where not exists(select 1 from clued_private.issuer_function_sources_v1)
  on conflict(issuer_id,generation) do nothing;
insert into clued_private.storage_client_digest_contracts_v1(request_id,contract_version)
  select id,2 from clued_private.authorization_requests_v12 on conflict(request_id) do nothing;

create or replace function clued_private.issuer_identity_provision_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare k text;
begin
  k:=to_jsonb(new)->>case when tg_table_name='authorization_issuers_v12' then 'token_hash' else 'issuer_hash' end;
  insert into clued_private.issuer_identities_v1(kind,legacy_key) values(tg_argv[0],k)
    on conflict(kind,legacy_key) do nothing;
  return null;
end $$;
drop trigger if exists issuer_identity_provision_v1 on clued_private.authorization_issuers_v12;
create trigger issuer_identity_provision_v1 after insert on clued_private.authorization_issuers_v12
  for each row execute function clued_private.issuer_identity_provision_v1('authorization');
drop trigger if exists issuer_identity_provision_v1 on clued_private.storage_oauth_apps_v1;
create trigger issuer_identity_provision_v1 after insert on clued_private.storage_oauth_apps_v1
  for each row execute function clued_private.issuer_identity_provision_v1('storage');

create or replace function clued_private.issuer_identity_guard_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or (new.id,new.kind,new.legacy_key,new.created_at) is distinct from
    (old.id,old.kind,old.legacy_key,old.created_at) then
    raise exception 'issuer_identity_immutable' using errcode='42501'; end if;
  return new;
end $$;
drop trigger if exists issuer_identity_immutable_v1 on clued_private.issuer_identities_v1;
create trigger issuer_identity_immutable_v1 before update or delete on clued_private.issuer_identities_v1
  for each row execute function clued_private.issuer_identity_guard_v1();

create or replace function clued_private.issuer_credential_guard_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or (new.issuer_id,new.generation,new.verifier,new.created_at,new.valid_until) is distinct from
    (old.issuer_id,old.generation,old.verifier,old.created_at,old.valid_until)
    or (old.state='retired' and new is distinct from old)
    or (old.state='active' and new.state not in ('active','retired'))
    or (old.activated_at is not null and new.activated_at is distinct from old.activated_at) then
    raise exception 'issuer_credential_history_immutable' using errcode='42501'; end if;
  return new;
end $$;
drop trigger if exists issuer_credential_history_immutable_v1 on clued_private.issuer_credentials_v1;
create trigger issuer_credential_history_immutable_v1 before update or delete on clued_private.issuer_credentials_v1
  for each row execute function clued_private.issuer_credential_guard_v1();
create or replace function clued_private.storage_client_digest_contract_guard_v1() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and new is distinct from old then
    raise exception 'storage_digest_contract_immutable' using errcode='42501'; end if;
  return new;
end $$;
drop trigger if exists storage_client_digest_contract_immutable_v1 on clued_private.storage_client_digest_contracts_v1;
create trigger storage_client_digest_contract_immutable_v1 before update on clued_private.storage_client_digest_contracts_v1
  for each row execute function clued_private.storage_client_digest_contract_guard_v1();

create or replace function clued_private.storage_client_digest_contract_insert_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into clued_private.storage_client_digest_contracts_v1 values(new.id,3);
  return null;
end $$;
drop trigger if exists storage_client_digest_contract_insert_v1 on clued_private.authorization_requests_v12;
create trigger storage_client_digest_contract_insert_v1 after insert on clued_private.authorization_requests_v12
  for each row execute function clued_private.storage_client_digest_contract_insert_v1();

-- A dedicated deterministic verifier deliberately ignores credential_internal_v1. A stored identity, verifier
-- or transaction-local Binding internal proof can never be turned into an issuer credential by this resolver.
create or replace function clued_private.issuer_resolve_identity_v1(p_proof text,p_kind text) returns text
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.issuer_credentials_v1; i clued_private.issuer_identities_v1;
begin
  if coalesce(p_proof,'') !~ '^[0-9a-f]{64}$' or coalesce(p_kind,'') not in ('authorization','storage') then
    raise exception 'issuer_credential_required' using errcode='42501'; end if;
  select c0.* into c from clued_private.issuer_credentials_v1 c0
    join clued_private.issuer_identities_v1 i0 on i0.id=c0.issuer_id and i0.kind=p_kind
    where c0.verifier='cv1:'||encode(extensions.digest('clued.credential-verifier.v1:'||p_proof,'sha256'),'hex')
      and c0.state='active' and (c0.valid_until is null or c0.valid_until>clock_timestamp()) for share of c0;
  if not found then raise exception 'issuer_credential_required' using errcode='42501'; end if;
  select * into i from clued_private.issuer_identities_v1 where id=c.issuer_id;
  if p_kind='authorization' then
    perform 1 from clued_private.authorization_issuers_v12 where token_hash=i.legacy_key and revoked_at is null for share;
  else
    perform 1 from clued_private.storage_oauth_apps_v1 where issuer_hash=i.legacy_key and revoked_at is null for share;
  end if;
  -- The preceding issuer-row lock can wait. Check the actual wall clock after both locks.
  if not found or (c.valid_until is not null and c.valid_until<=clock_timestamp()) then
    raise exception 'issuer_credential_required' using errcode='42501'; end if;
  perform set_config('clued.issuer_credential_context_v1',
    (coalesce(nullif(current_setting('clued.issuer_credential_context_v1',true),''),'{}')::jsonb
      ||jsonb_build_object(i.id::text,c.generation))::text,true);
  return i.legacy_key;
end $$;

-- Preserve the published per-entry error vocabulary while using the same closed resolver. The error text is
-- embedded by this migration from each original guarded implementation, not provided through a public RPC.
create or replace function clued_private.issuer_resolve_identity_compatible_v1(p_proof text,p_kind text,p_error text) returns text
language plpgsql volatile security definer set search_path='' as $$
begin
  return clued_private.issuer_resolve_identity_v1(p_proof,p_kind);
exception when sqlstate '42501' then
  raise exception '%',p_error using errcode='42501';
end $$;

-- Only the Native policy-transition wrapper uses this resolver. Its original
-- business body may return an exact committed historical Receipt after whole-
-- issuer revocation; every fresh operation still checks the live issuer there.
-- A live credential remains mandatory even for history. No public bypass flag.
create or replace function clued_private.issuer_resolve_identity_policy_transition_v1(p_proof text,p_input jsonb) returns text
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.issuer_credentials_v1; i clued_private.issuer_identities_v1;
begin
  perform clued_private.storage_owner_v1();
  if coalesce(p_proof,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'storage_transition_denied' using errcode='42501'; end if;
  select c0.* into c from clued_private.issuer_credentials_v1 c0
    join clued_private.issuer_identities_v1 i0 on i0.id=c0.issuer_id and i0.kind='storage'
    where c0.verifier='cv1:'||encode(extensions.digest('clued.credential-verifier.v1:'||p_proof,'sha256'),'hex')
      and c0.state='active' and (c0.valid_until is null or c0.valid_until>clock_timestamp()) for share of c0;
  if not found then raise exception 'storage_transition_denied' using errcode='42501'; end if;
  select * into i from clued_private.issuer_identities_v1 where id=c.issuer_id;
  -- Preserve the original transition table-before-app-row lock order. Taking
  -- the app-row SHARE first could deadlock an operator updating that same app.
  if p_input->>'action'='transition' then lock table clued_private.storage_oauth_apps_v1 in share mode; end if;
  perform 1 from clued_private.storage_oauth_apps_v1 where issuer_hash=i.legacy_key for share;
  if not found or (c.valid_until is not null and c.valid_until<=clock_timestamp()) then
    raise exception 'storage_transition_denied' using errcode='42501'; end if;
  perform set_config('clued.issuer_credential_context_v1',
    (coalesce(nullif(current_setting('clued.issuer_credential_context_v1',true),''),'{}')::jsonb
      ||jsonb_build_object(i.id::text,c.generation))::text,true);
  return i.legacy_key;
end $$;
revoke all on function clued_private.issuer_resolve_identity_policy_transition_v1(text,jsonb)
  from public,anon,authenticated,service_role;

-- Only the existing onboard expiry sweep uses this background resolver. Its
-- original body can remove credentials from this issuer's expired attempts
-- after issuer revocation; it cannot onboard, issue, activate or call a provider.
create or replace function clued_private.issuer_resolve_identity_onboard_sweep_v1(p_proof text) returns text
language plpgsql volatile security definer set search_path='' as $$
declare c clued_private.issuer_credentials_v1; i clued_private.issuer_identities_v1;
begin
  if coalesce(p_proof,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  select c0.* into c from clued_private.issuer_credentials_v1 c0
    join clued_private.issuer_identities_v1 i0 on i0.id=c0.issuer_id and i0.kind='storage'
    where c0.verifier='cv1:'||encode(extensions.digest('clued.credential-verifier.v1:'||p_proof,'sha256'),'hex')
      and c0.state='active' and (c0.valid_until is null or c0.valid_until>clock_timestamp()) for share of c0;
  if not found then raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  select * into i from clued_private.issuer_identities_v1 where id=c.issuer_id;
  perform 1 from clued_private.storage_oauth_apps_v1 where issuer_hash=i.legacy_key for share;
  if not found or (c.valid_until is not null and c.valid_until<=clock_timestamp()) then
    raise exception 'storage_onboard_denied' using errcode='42501'; end if;
  perform set_config('clued.issuer_credential_context_v1',
    (coalesce(nullif(current_setting('clued.issuer_credential_context_v1',true),''),'{}')::jsonb
      ||jsonb_build_object(i.id::text,c.generation))::text,true);
  return i.legacy_key;
end $$;
revoke all on function clued_private.issuer_resolve_identity_onboard_sweep_v1(text)
  from public,anon,authenticated,service_role;

-- Audit provenance only. This context does not authenticate an identity or grant a business operation.
create or replace function clued_private.issuer_credential_generation_v1(p_identity text,p_kind text) returns bigint
language plpgsql stable set search_path='' as $$
declare identity_id uuid; generation text;
begin
  select id into identity_id from clued_private.issuer_identities_v1 where kind=p_kind and legacy_key=p_identity;
  generation:=coalesce(nullif(current_setting('clued.issuer_credential_context_v1',true),''),'{}')::jsonb->>identity_id::text;
  if coalesce(generation,'') !~ '^[1-9][0-9]*$' then
    raise exception 'issuer_authenticated_context_required' using errcode='42501'; end if;
  return generation::bigint;
end $$;

-- Admin-only rotation primitives; no RPC grant. They accept an already computed verifier, never a secret.
-- Staging and activation do not restore a retired generation; issuer-wide revocation is separate.
create or replace function clued_private.issuer_credential_stage_v1(p_issuer uuid,p_verifier text) returns bigint
language plpgsql set search_path='' as $$
declare generation bigint;
begin
  if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
    where oid='clued_private.issuer_credential_stage_v1(uuid,text)'::regprocedure)
    or current_user in ('anon','authenticated','service_role','authenticator') then
    raise exception 'offline_database_operator_required' using errcode='42501'; end if;
  if coalesce(p_verifier,'') !~ '^cv1:[0-9a-f]{64}$' then
    raise exception 'issuer_verifier_required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('issuer-credential:'||p_issuer::text,0));
  if not exists(select 1 from clued_private.issuer_identities_v1 where id=p_issuer) then
    raise exception 'issuer_identity_required' using errcode='42501'; end if;
  select coalesce(max(c.generation),0)+1 into generation from clued_private.issuer_credentials_v1 c where c.issuer_id=p_issuer;
  insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state) values(p_issuer,generation,p_verifier,'staged');
  return generation;
end $$;
create or replace function clued_private.issuer_credential_activate_v1(p_issuer uuid,p_generation bigint) returns void
language plpgsql set search_path='' as $$
begin
  if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
    where oid='clued_private.issuer_credential_activate_v1(uuid,bigint)'::regprocedure)
    or current_user in ('anon','authenticated','service_role','authenticator') then
    raise exception 'offline_database_operator_required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('issuer-credential:'||p_issuer::text,0));
  update clued_private.issuer_credentials_v1 set state='active',activated_at=clock_timestamp()
    where issuer_id=p_issuer and generation=p_generation and state='staged';
  if not found then raise exception 'issuer_credential_stage_required' using errcode='40001'; end if;
end $$;
create or replace function clued_private.issuer_credential_retire_v1(p_issuer uuid,p_generation bigint) returns void
language plpgsql set search_path='' as $$
begin
  if current_user is distinct from (select pg_get_userbyid(proowner) from pg_proc
    where oid='clued_private.issuer_credential_retire_v1(uuid,bigint)'::regprocedure)
    or current_user in ('anon','authenticated','service_role','authenticator') then
    raise exception 'offline_database_operator_required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('issuer-credential:'||p_issuer::text,0));
  update clued_private.issuer_credentials_v1 set state='retired',retired_at=clock_timestamp()
    where issuer_id=p_issuer and generation=p_generation and state in ('active','staged');
  if not found then raise exception 'issuer_credential_generation_conflict' using errcode='40001'; end if;
end $$;

create or replace function clued_private.issuer_verified_identity_matches_v1(p_saved jsonb,p_identity text) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(case p_saved->>'contract'
    when 'clued.storage-persisted-verification/2' then p_saved->>'issuer_hash'=p_identity
    when 'clued.storage-persisted-verification/3' then p_saved->>'issuer_kind'='storage'
      and p_saved->>'issuer_id'=(select id::text from clued_private.issuer_identities_v1 where kind='storage' and legacy_key=p_identity)
      and coalesce(p_saved->>'credential_generation','') ~ '^[1-9][0-9]*$'
      and not (p_saved ?| array['issuer_hash','issuer_proof','issuer_verifier'])
    else false end,false)
$$;

-- Version selection belongs to the request's immutable boundary, NOT to the currently installed key.
create or replace function clued_private.storage_client_request_digest_v2(p_request uuid)
returns text language sql stable security definer set search_path='' as $$
  select case d.contract_version when 2 then
    clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-client-registration/2',
      'issuer',r.issuer_hash,'resource',r.resource,'client_id',r.client_id,
      'redirect_uri',r.redirect_uri,'client_name',r.client_name,'requested_scopes',to_jsonb(r.requested_scopes)))
    when 3 then clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-client-registration/3',
      'issuer_id',i.id,'resource',r.resource,'client_id',r.client_id,
      'redirect_uri',r.redirect_uri,'client_name',r.client_name,'requested_scopes',to_jsonb(r.requested_scopes))) end
  from clued_private.authorization_requests_v12 r
  join clued_private.storage_client_digest_contracts_v1 d on d.request_id=r.id
  join clued_private.issuer_identities_v1 i on i.kind='authorization' and i.legacy_key=r.issuer_hash where r.id=p_request
$$;
-- Redirect identity has no persisted digest: both sides are computed on every evaluation. Old and new requests
-- compare through the same stable UUID, preserving exact issuer/resource/scopes/URI and ambiguity checks.
create or replace function clued_private.storage_client_redirect_identity_v3(p_request uuid)
returns text language sql stable security definer set search_path='' as $$
  select clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-client-redirect-identity/2',
    'issuer_id',i.id,'resource',r.resource,'redirect_uri',r.redirect_uri,
    'requested_scopes',(select coalesce(jsonb_agg(s order by s),'[]'::jsonb) from unnest(r.requested_scopes) s)))
  from clued_private.authorization_requests_v12 r
  join clued_private.issuer_identities_v1 i on i.kind='authorization' and i.legacy_key=r.issuer_hash
  where r.id=p_request and clued_private.storage_client_redirect_eligible_v3(r.redirect_uri)
$$;

-- Keep the exact source definitions once. Clone the existing guarded business bodies to private identity-only
-- entries, then install proof-authenticating wrappers in their old signatures. All nested issuer-hash calls
-- inside business bodies are routed to identity entries, never back into the public proof wrappers.
insert into clued_private.issuer_function_sources_v1(signature,schema_name,function_name,definition,
  argument_names,arguments,result_type,credential_argument,kind,identity_name)
select p.oid::regprocedure::text,n.nspname,p.proname,pg_get_functiondef(p.oid),p.proargnames,
  pg_get_function_arguments(p.oid),pg_get_function_result(p.oid),
  case when p.proname='authorization_issuer_v12' then 1 else array_position(p.proargnames,'p_issuer_hash') end,
  case when p.proname like '%authorization%' then 'authorization' else 'storage' end,
  case when p.proargnames @> array['p_issuer_hash'] or p.proname='authorization_issuer_v12'
    then 'ii_'||case n.nspname when 'public' then 'pub_' else 'priv_' end||p.proname end
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','clued_private') and p.prokind='f'
  and (p.proargnames && array['p_issuer_hash','p_issuer_secret']
    or p.proname in ('authorization_issuer_v12','storage_onboard_activate_v1'))
on conflict(signature) do nothing;

do $migration$
declare f record; callee record; body text; args text; arg text; index integer; hits integer; denied_error text;
  secret_anchor text:=$a$encode(sha256(convert_to(p_issuer_secret,'UTF8')),'hex')$a$;
begin
  if (select count(*) from clued_private.issuer_function_sources_v1 where schema_name='public')<>25
    or (select count(*) from clued_private.issuer_function_sources_v1 where schema_name='clued_private')<>15 then
    raise exception 'issuer_function_inventory_changed' using errcode='55000'; end if;
  for f in select * from clued_private.issuer_function_sources_v1 order by signature loop
    body:=f.definition;
    denied_error:=case when f.kind='authorization' then 'authorization_issuer_required'
      when f.function_name='clued_storage_read_v1' then 'storage_read_denied'
      when f.function_name='clued_storage_staging_v1' then 'storage_staging_denied'
      else coalesce((regexp_match(body,$p$if not found then raise exception '([a-z0-9_]+)'$p$))[1],
        (regexp_match(body,$p$raise exception '([a-z0-9_]+)'$p$))[1]) end;
    if denied_error is null then denied_error:='storage_oauth_denied'; end if;
    if f.identity_name is not null then
      body:=replace(body,'FUNCTION '||f.schema_name||'.'||f.function_name||'(',
        'FUNCTION clued_private.'||f.identity_name||'(');
      arg:=case when f.function_name='authorization_issuer_v12' then 'p_hash' else 'p_issuer_hash' end;
      body:=regexp_replace(body,'\m'||arg||'\M','p_issuer_identity','g');
    elsif f.function_name<>'storage_onboard_activate_v1' then
      -- Six raw-secret entries (five public, one private) derive the proof once; now resolve it instead.
      hits:=(length(body)-length(replace(body,secret_anchor,'')))/length(secret_anchor);
      if hits<>1 then raise exception 'issuer_secret_anchor_changed: % (%)',f.signature,hits; end if;
      body:=replace(body,secret_anchor,format('clued_private.issuer_resolve_identity_compatible_v1(%s,''storage'',%L)',secret_anchor,denied_error));
    end if;
    for callee in select * from clued_private.issuer_function_sources_v1 where identity_name is not null loop
      body:=replace(body,callee.schema_name||'.'||callee.function_name||'(',
        'clued_private.'||callee.identity_name||'(');
    end loop;
    if f.function_name in ('storage_oauth_connection_consent_v1','storage_onboard_activate_v1') then
      arg:=case when f.function_name='storage_oauth_connection_consent_v1' then 'p_issuer_identity' else 'a.issuer_hash' end;
      hits:=(length(body)-length(replace(body,'''issuer_hash'','||arg,'')))/length('''issuer_hash'','||arg);
      if hits<>1 then raise exception 'issuer_consent_anchor_changed: % (%)',f.signature,hits; end if;
      body:=replace(body,'''issuer_hash'','||arg,
        format('''issuer_id'',(select id from clued_private.issuer_identities_v1 where kind=''storage'' and legacy_key=%s),
          ''issuer_kind'',''storage'',''credential_generation'',clued_private.issuer_credential_generation_v1(%s,''storage'')',arg,arg));
    end if;
    if f.function_name='storage_verified_result_v2' then
      hits:=(length(body)-length(replace(body,$a$saved->>'issuer_hash' is distinct from p_issuer_identity$a$,'')))/
        length($a$saved->>'issuer_hash' is distinct from p_issuer_identity$a$);
      if hits<>3 then raise exception 'issuer_verified_comparison_changed: %',hits; end if;
      body:=replace(body,$a$saved->>'issuer_hash' is distinct from p_issuer_identity$a$,
        'not clued_private.issuer_verified_identity_matches_v1(saved,p_issuer_identity)');
      if strpos(body,$a$'contract','clued.storage-persisted-verification/2','issuer_hash',p_issuer_identity$a$)=0 then
        raise exception 'issuer_verified_record_changed'; end if;
      body:=replace(body,$a$'contract','clued.storage-persisted-verification/2','issuer_hash',p_issuer_identity$a$,
        $r$'contract','clued.storage-persisted-verification/3','issuer_kind','storage','issuer_id',
          (select id from clued_private.issuer_identities_v1 where kind='storage' and legacy_key=p_issuer_identity),
          'credential_generation',clued_private.issuer_credential_generation_v1(p_issuer_identity,'storage')$r$);
    end if;
    execute body;
    if f.identity_name is not null then
      -- Arguments may include defaults. The wrapper preserves their exact declarations and original ACL.
      args:='';
      for index in 1..array_length(f.argument_names,1) loop
        arg:=quote_ident(f.argument_names[index]);
        if index=f.credential_argument then
          if f.schema_name='public' and f.function_name='clued_storage_policy_transition_v2' then
            arg:=format('clued_private.issuer_resolve_identity_policy_transition_v1(%s,p_input)',arg);
          elsif f.schema_name='public' and f.function_name='clued_storage_onboard_sweep_v1' then
            arg:=format('clued_private.issuer_resolve_identity_onboard_sweep_v1(%s)',arg);
          else
            arg:=format('clued_private.issuer_resolve_identity_compatible_v1(%s,%L,%L)',arg,f.kind,denied_error);
          end if;
        end if;
        args:=args||case when index>1 then ',' else '' end||arg;
      end loop;
      execute format('create or replace function %I.%I(%s) returns %s language sql volatile security definer set search_path='''' as %L',
        f.schema_name,f.function_name,f.arguments,f.result_type,'select clued_private.'||f.identity_name||'('||args||')');
      execute format('revoke all on function clued_private.%I(%s) from public,anon,authenticated,service_role',
        f.identity_name,pg_get_function_identity_arguments(to_regprocedure(f.signature)));
    end if;
  end loop;
end $migration$;

notify pgrst,'reload schema';

-- The wrappers above preserve existing entry ACLs; all new helpers and identities remain non-RPC internals.
do $migration$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p where p.pronamespace='clued_private'::regnamespace
    and p.prokind='f' and (p.proname like 'issuer_%' or p.proname in
      ('storage_client_digest_contract_insert_v1','storage_client_digest_contract_guard_v1')) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
  end loop;
end $migration$;
