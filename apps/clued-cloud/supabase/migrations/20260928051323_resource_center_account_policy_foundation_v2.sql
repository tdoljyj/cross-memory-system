-- AccountStorageInheritance.v0.1: CLOSED foundation only. No policy, client
-- registration, capability, request link or deny is seeded. No API role may
-- call these helpers or activate a policy. Existing execution remains legacy;
-- the companion compatibility migration closes legacy paths after a cutover.
-- Platform qualification / native consent / transition mutation contracts and
-- their Event+Receipt transactions are deliberately not introduced here.

alter table clued_private.storage_connections_v1
  add column auth_mode text not null default 'legacy'
    check(auth_mode in ('legacy','account_policy','revoked')),
  add column auth_generation bigint not null default 0 check(auth_generation>=0),
  add column account_policy_id uuid;

-- Registration sources currently lack a DB-owned, non-reusable DCR identity.
-- Therefore ONLY an explicitly reviewed server-side snapshot may be linked to
-- an exact v12 request. Neither client_id nor client_name is a lookup fallback.
-- This is not a new identity system: v12 remains the live identity/lifecycle.
create table clued_private.storage_client_registrations_v2 (
  lineage_id uuid not null check(lineage_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  generation bigint not null check(generation>0),
  issuer_hash text not null references clued_private.authorization_issuers_v12(token_hash),
  resource text not null check(resource ~ '^https://'),
  client_id text not null check(length(client_id) between 1 and 4096),
  metadata_digest text not null check(metadata_digest ~ '^[0-9a-f]{64}$'),
  source_kind text not null default 'reviewed_snapshot' check(source_kind='reviewed_snapshot'),
  review_receipt_id uuid not null references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key(lineage_id,generation)
);
create table clued_private.storage_client_request_links_v2 (
  request_id uuid primary key references clued_private.authorization_requests_v12(id),
  lineage_id uuid not null,
  registration_generation bigint not null,
  metadata_digest text not null check(metadata_digest ~ '^[0-9a-f]{64}$'),
  review_receipt_id uuid not null references public.clued_audit_receipts(id),
  foreign key(lineage_id,registration_generation)
    references clued_private.storage_client_registrations_v2(lineage_id,generation)
);
create index storage_client_request_lineage_v2 on clued_private.storage_client_request_links_v2(lineage_id);
create table clued_private.storage_client_capabilities_v2 (
  id uuid primary key default gen_random_uuid(),
  lineage_id uuid not null,
  registration_generation bigint not null,
  version bigint not null default 1 check(version>0),
  protocol text not null default 'clued.storage-agent/1' check(protocol='clued.storage-agent/1'),
  state text not null default 'active' check(state in ('active','revoked')),
  revoked_at timestamptz,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  foreign key(lineage_id,registration_generation)
    references clued_private.storage_client_registrations_v2(lineage_id,generation),
  check((state='revoked')=(revoked_at is not null)),
  unique(lineage_id,version)
);
create unique index storage_client_capability_active_v2 on clued_private.storage_client_capabilities_v2(lineage_id) where state='active';
create table clued_private.storage_account_policies_v2 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  provider text not null check(provider='google-drive'),
  provider_subject text not null check(length(provider_subject) between 1 and 4096),
  root_folder_id text not null check(root_folder_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  profile_id uuid not null references clued_private.resource_center_profiles_v1(id),
  actions text[] not null default array['inspect','create_file','create_topic']::text[]
    check(actions=array['inspect','create_file','create_topic']::text[]),
  scope_digest text not null check(scope_digest ~ '^[0-9a-f]{64}$'),
  policy_generation bigint not null check(policy_generation>0),
  source_decision_id uuid not null references public.clued_memories(id),
  decision_version bigint not null check(decision_version>0),
  consent_source text not null check(consent_source in ('native_connection','reviewed_transition','explicit_restore')),
  disclosure_version text not null check(length(disclosure_version) between 1 and 160),
  consent_receipt_id uuid not null references public.clued_audit_receipts(id),
  activation_receipt_id uuid references public.clued_audit_receipts(id),
  state text not null default 'pending' check(state in ('pending','active','revoked')),
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_receipt_id uuid references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(connection_id,policy_generation),
  check((state='revoked')=(revoked_at is not null)),
  check(state<>'active' or activation_receipt_id is not null),
  check(state<>'revoked' or revocation_receipt_id is not null)
);
create unique index storage_account_policy_active_v2 on clued_private.storage_account_policies_v2(connection_id) where state='active';
create index storage_account_policy_root_v2 on clued_private.storage_account_policies_v2(owner_id,provider,provider_subject,root_folder_id);
alter table clued_private.storage_connections_v1 add constraint storage_connection_policy_fk_v2
  foreign key(account_policy_id) references clued_private.storage_account_policies_v2(id) deferrable initially deferred;

-- Global storage-only deny survives new Bindings and new connections. A root
-- deny with NULL lineage is the connection/root stop tombstone; non-NULL is an
-- exact client restriction retained by a future reviewed legacy transition.
create table clued_private.storage_client_denies_v2 (
  owner_id uuid not null references auth.users(id),
  lineage_id uuid not null check(lineage_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  generation bigint not null default 1 check(generation>0),
  denied boolean not null default true,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  primary key(owner_id,lineage_id)
);
create table clued_private.storage_root_denies_v2 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  provider text not null check(provider='google-drive'),
  provider_subject text not null check(length(provider_subject) between 1 and 4096),
  root_folder_id text not null check(root_folder_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  lineage_id uuid check(lineage_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  generation bigint not null default 1 check(generation>0),
  denied boolean not null default true,
  receipt_id uuid not null references public.clued_audit_receipts(id)
);
create unique index storage_root_deny_identity_v2 on clued_private.storage_root_denies_v2
  (owner_id,provider,provider_subject,root_folder_id,coalesce(lineage_id,'00000000-0000-0000-0000-000000000000'::uuid));

create function clued_private.storage_client_request_digest_v2(p_request uuid)
returns text language sql stable security definer set search_path='' as $$
  select clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-client-registration/2',
    'issuer',r.issuer_hash,'resource',r.resource,'client_id',r.client_id,
    'redirect_uri',r.redirect_uri,'client_name',r.client_name,'requested_scopes',to_jsonb(r.requested_scopes)))
  from clued_private.authorization_requests_v12 r where r.id=p_request
$$;

-- No credential generation, directory metadata version or topic inventory is
-- included: same-scope refresh/topic creation must not change account consent.
-- Exact track provider identities ARE included, not only their names.
create function clued_private.storage_policy_scope_digest_v2(p_connection uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  tracks jsonb; registered jsonb;
begin
  select * into c from clued_private.storage_connections_v1 where id=p_connection;
  if not found or c.provider_subject is null then return null; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=c.owner_id;
  if not found or p.cloud_runtime->>'contract' is distinct from 'clued.storage-cloud-runtime/1'
    or jsonb_typeof(p.cloud_runtime->'allowed_root_children') is distinct from 'array' then return null; end if;
  tracks:=p.cloud_runtime->'allowed_root_children';
  if jsonb_array_length(tracks) not between 1 and 32 or exists(
    select 1 from jsonb_array_elements(tracks) x where jsonb_typeof(x)<>'string')
    or (select count(distinct x) from jsonb_array_elements(tracks) x)<>jsonb_array_length(tracks) then return null; end if;
  select jsonb_agg(jsonb_build_object('path',a.path,'provider_file_id',a.provider_file_id) order by a.path collate "C") into registered
    from clued_private.resource_center_artifacts_v1 a where a.profile_id=p.id and a.user_id=c.owner_id
      and a.state='active' and a.target_kind='directory'
      and a.path in (select p.managed_root||'/'||x from jsonb_array_elements_text(tracks) x);
  if coalesce(jsonb_array_length(registered),0)<>jsonb_array_length(tracks) then return null; end if;
  return clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-account-scope/2',
    'owner_id',c.owner_id,'provider',c.provider,'provider_subject',c.provider_subject,
    'root_folder_id',p.root_folder_id,'root_parent_id',p.root_parent_id,'managed_root',p.managed_root,
    'profile_id',p.id,'policy_version',p.policy_version,'tracks',registered,
    'directory_semantics',jsonb_build_array('topic','asset_collection'),
    'actions',jsonb_build_array('inspect','create_file','create_topic')));
end $$;

create function clued_private.storage_client_guard_v2(p_owner uuid,p_lineage uuid,p_exclusive boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_owner is null or p_lineage is null or p_exclusive is null then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  if p_exclusive then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-client:'||p_owner::text||':'||p_lineage::text,0));
  else
    perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('storage-client:'||p_owner::text||':'||p_lineage::text,0));
  end if;
end $$;

-- Lifecycle shape only. Trusted mutation contracts must produce the referenced
-- Receipts in their transaction; this foundation exposes no such mutation API.
create function clued_private.storage_policy_rows_guard_v2()
returns trigger language plpgsql security definer set search_path='' as $$
declare previous_version bigint; previous_registration bigint;
begin
  if tg_op='DELETE' then raise exception 'storage_policy_history_immutable' using errcode='42501'; end if;
  if tg_op='INSERT' then
    -- A revoked qualification remains immutable. A later reviewed qualification
    -- uses a new ID and a new lineage-wide version, never resets old history.
    select coalesce(max(version),0),coalesce(max(registration_generation),0)
      into previous_version,previous_registration from clued_private.storage_client_capabilities_v2 where lineage_id=new.lineage_id;
    if new.version<>previous_version+1 or new.registration_generation<previous_registration then
      raise exception 'storage_capability_version_conflict' using errcode='40001'; end if;
    return new;
  end if;
  if tg_table_name in ('storage_client_registrations_v2','storage_client_request_links_v2') then
    if new is distinct from old then raise exception 'storage_registration_immutable' using errcode='42501'; end if;
  elsif tg_table_name='storage_account_policies_v2' then
    if (to_jsonb(new)-array['state','activation_receipt_id','revoked_at','revocation_receipt_id'])
      is distinct from (to_jsonb(old)-array['state','activation_receipt_id','revoked_at','revocation_receipt_id'])
      or (old.activation_receipt_id is not null and new.activation_receipt_id is distinct from old.activation_receipt_id)
      or (old.state='revoked' and new is distinct from old)
      or (old.state='active' and new.state not in ('active','revoked')) then
      raise exception 'storage_policy_immutable' using errcode='42501'; end if;
  elsif tg_table_name='storage_client_capabilities_v2' then
    if old.state='revoked' then
      if new is distinct from old then raise exception 'storage_capability_revoked_immutable' using errcode='42501'; end if;
      return new;
    end if;
    if new.id<>old.id or new.lineage_id<>old.lineage_id or new.version<>old.version+1
      or new.registration_generation<old.registration_generation or new.receipt_id=old.receipt_id then
      raise exception 'storage_capability_version_conflict' using errcode='40001'; end if;
  elsif tg_table_name='storage_client_denies_v2' then
    if new.owner_id<>old.owner_id or new.lineage_id<>old.lineage_id or new.generation<>old.generation+1 or new.receipt_id=old.receipt_id then
      raise exception 'storage_deny_version_conflict' using errcode='40001'; end if;
  elsif tg_table_name='storage_root_denies_v2' then
    if (to_jsonb(new)-array['generation','denied','receipt_id']) is distinct from (to_jsonb(old)-array['generation','denied','receipt_id'])
      or new.generation<>old.generation+1 or new.receipt_id=old.receipt_id then
      raise exception 'storage_deny_version_conflict' using errcode='40001'; end if;
  end if;
  return new;
end $$;

create function clued_private.storage_connection_mode_guard_v2()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.auth_mode='revoked' and new.auth_mode<>'revoked'
    or old.auth_mode='account_policy' and new.auth_mode='legacy'
    or new.auth_generation<old.auth_generation
    or ((new.auth_mode,new.account_policy_id) is distinct from (old.auth_mode,old.account_policy_id)
        and new.auth_generation<>old.auth_generation+1)
    or ((new.auth_mode,new.account_policy_id) is not distinct from (old.auth_mode,old.account_policy_id)
        and new.auth_generation<>old.auth_generation) then
    raise exception 'storage_auth_mode_conflict' using errcode='40001'; end if;
  return new;
end $$;
create trigger storage_connection_mode_guard_v2 before update on clued_private.storage_connections_v1
  for each row execute function clued_private.storage_connection_mode_guard_v2();

-- Deferred so an atomic revoke/cutover can change connection and policy in any
-- SQL statement order. Validate FINAL rows, never a stale trigger NEW image.
create function clued_private.storage_policy_consistency_v2()
returns trigger language plpgsql security definer set search_path='' as $$
declare c clued_private.storage_connections_v1; a clued_private.storage_account_policies_v2; target uuid;
begin
  if tg_table_name='storage_connections_v1' then target:=new.id; else target:=new.connection_id; end if;
  select * into c from clued_private.storage_connections_v1 where id=target;
  if not found then return null; end if;
  select * into a from clued_private.storage_account_policies_v2 where connection_id=c.id and state='active';
  if c.auth_mode='account_policy' then
    if not found or c.account_policy_id is distinct from a.id or c.state='revoked'
      or a.owner_id<>c.owner_id or a.profile_id<>c.profile_id or a.provider<>c.provider
      or a.provider_subject is distinct from c.provider_subject then
      raise exception 'storage_auth_mode_inconsistent' using errcode='23514'; end if;
  elsif found or (c.auth_mode='legacy' and c.account_policy_id is not null)
    or (c.auth_mode='revoked' and c.state<>'revoked') then
    raise exception 'storage_auth_mode_inconsistent' using errcode='23514';
  end if;
  -- Existing revoked legacy rows remain legacy, but cannot authorize anything.
  -- No data backfill or policy activation occurs during installation.
  return null;
end $$;
create constraint trigger storage_connection_policy_consistency_v2 after insert or update on clued_private.storage_connections_v1
  deferrable initially deferred for each row execute function clued_private.storage_policy_consistency_v2();
create constraint trigger storage_policy_connection_consistency_v2 after insert or update on clued_private.storage_account_policies_v2
  deferrable initially deferred for each row execute function clued_private.storage_policy_consistency_v2();

-- Internal authorization snapshot, NOT an admission / HTTP capability. Future
-- submit/prepare/begin callers must invoke it BEFORE downstream locks and pin
-- this exact snapshot in the original job; a fresh result never revives a job.
-- No existing public route consumes this helper in this closed foundation.
create function clued_private.storage_policy_evaluate_v2(p_hash text,p_connection uuid,p_action text,p_job uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
  req clued_private.authorization_requests_v12; link clued_private.storage_client_request_links_v2;
  registration clued_private.storage_client_registrations_v2; cap clued_private.storage_client_capabilities_v2;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2;
  owner_key uuid; binding_key uuid; request_key uuid; lineage_key uuid; root_key text; issuer_key text; resource_key text;
  digest text; runtime_decision uuid; runtime_version bigint;
begin
  if coalesce(p_hash,'') !~ '^[0-9a-f]{64}$' or p_connection is null or p_job is null
    or coalesce(p_action,'') not in ('inspect','create_file','create_topic') then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  -- Unlocked reads select lock keys ONLY. Every identity is rechecked below.
  select b0.user_id,b0.id,a0.request_id,l.lineage_id,p0.root_folder_id,r0.issuer_hash,r0.resource
    into owner_key,binding_key,request_key,lineage_key,root_key,issuer_key,resource_key
    from public.clued_agent_bindings b0 join clued_private.authorizations_v12 a0 on a0.binding_id=b0.id and a0.owner_id=b0.user_id
    join clued_private.authorization_requests_v12 r0 on r0.id=a0.request_id
    join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id
    join clued_private.storage_connections_v1 c0 on c0.id=p_connection and c0.owner_id=b0.user_id
    join clued_private.resource_center_profiles_v1 p0 on p0.id=c0.profile_id and p0.user_id=b0.user_id
    where b0.token_hash=p_hash;
  if not found then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  -- Fixed identity issuer is an outer lock, never acquired after a root/row
  -- lock. Revocation of that issuer invalidates its reviewed registrations.
  perform 1 from clued_private.authorization_issuers_v12 where token_hash=issuer_key
    and resource=resource_key and revoked_at is null for share;
  if not found then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  perform clued_private.storage_client_guard_v2(owner_key,lineage_key,false);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('storage-job:'||owner_key::text||':'||p_job::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_key::text||':'||root_key,0));
  select * into b from public.clued_agent_bindings where id=binding_key and user_id=owner_key and token_hash=p_hash for share;
  if not found or b.revoked_at is not null then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=owner_key for share;
  if not found or a.request_id<>request_key or a.revoked_at is not null then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(owner_key);
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=owner_key for share;
  if not found or c.auth_mode<>'account_policy' or c.state<>'active' or c.revoked_at is not null then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select * into policy from clued_private.storage_account_policies_v2 where id=c.account_policy_id and connection_id=c.id and owner_id=owner_key for share;
  if not found or policy.state<>'active' or policy.profile_id<>c.profile_id or policy.provider<>c.provider
    or policy.provider_subject is distinct from c.provider_subject or policy.root_folder_id<>root_key then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select * into cap from clued_private.storage_client_capabilities_v2 where lineage_id=lineage_key and state='active' for share;
  if not found or cap.state<>'active' then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  -- These registration/request links are immutable. Their source identity must
  -- match the current v12 request, not a caller-provided client description.
  select * into req from clued_private.authorization_requests_v12 where id=request_key;
  select * into link from clued_private.storage_client_request_links_v2 where request_id=request_key;
  select * into registration from clued_private.storage_client_registrations_v2
    where lineage_id=lineage_key and generation=cap.registration_generation;
  if not found or link.lineage_id is distinct from lineage_key or link.registration_generation is distinct from cap.registration_generation
    or req.owner_id is distinct from owner_key or req.status is distinct from 'approved' or req.binding_id is distinct from b.id
    or a.client_id is distinct from req.client_id or a.resource is distinct from req.resource
    or req.issuer_hash is distinct from issuer_key or req.resource is distinct from resource_key
    or registration.issuer_hash is distinct from req.issuer_hash or registration.resource is distinct from req.resource
    or registration.client_id is distinct from req.client_id or registration.metadata_digest is distinct from link.metadata_digest
    or registration.metadata_digest is distinct from clued_private.storage_client_request_digest_v2(req.id) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  if exists(select 1 from clued_private.storage_client_denies_v2 where owner_id=owner_key and lineage_id=lineage_key and denied)
    or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=owner_key and provider=c.provider
      and provider_subject=c.provider_subject and root_folder_id=root_key and (lineage_id is null or lineage_id=lineage_key) and denied) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=owner_key for share;
  if not found or p.root_folder_id<>root_key or p.state<>'active' or p.version<>c.profile_version
    or p.cloud_runtime->>'contract' is distinct from 'clued.storage-cloud-runtime/1'
    or p.cloud_runtime->>'profile_version' is distinct from p.version::text then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  runtime_decision:=(p.cloud_runtime->>'source_decision_id')::uuid;
  runtime_version:=(p.cloud_runtime->>'decision_version')::bigint;
  if runtime_decision is null or runtime_version is null then raise exception 'storage_policy_denied' using errcode='42501'; end if;
  perform 1 from public.clued_memories where id in
    (c.source_decision_id,p.source_decision_id,policy.source_decision_id,runtime_decision) order by id for share;
  if not clued_private.resource_center_decision_current_v1(owner_key,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(owner_key,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(owner_key,p.project_id,policy.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(owner_key,p.project_id,runtime_decision)
    or not exists(select 1 from public.clued_memories where id=c.source_decision_id and version=c.decision_version)
    or not exists(select 1 from public.clued_memories where id=policy.source_decision_id and version=policy.decision_version)
    or not exists(select 1 from public.clued_memories where id=runtime_decision and version=runtime_version) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  perform 1 from clued_private.resource_center_artifacts_v1 ar where ar.profile_id=p.id and ar.user_id=owner_key
    and ar.path in (select p.managed_root||'/'||x from jsonb_array_elements_text(p.cloud_runtime->'allowed_root_children') x)
    order by ar.id for share;
  digest:=clued_private.storage_policy_scope_digest_v2(c.id);
  if digest is null or policy.scope_digest<>digest
    or not exists(select 1 from public.clued_audit_receipts where id=policy.consent_receipt_id and user_id=owner_key and status='committed')
    or not exists(select 1 from public.clued_audit_receipts where id=policy.activation_receipt_id and user_id=owner_key and status='committed')
    or exists(select 1 from unnest(array[cap.receipt_id,registration.review_receipt_id,link.review_receipt_id]) rid
      where not exists(select 1 from public.clued_audit_receipts r where r.id=rid and r.status='committed')) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  -- A lock wait can cross expiry; check the wall clock LAST. All relevant rows
  -- and both deny insertion guards remain locked through the caller's start.
  if a.expires_at is null or a.expires_at<=clock_timestamp()
    or coalesce((to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp(),false)
    or coalesce(policy.expires_at<=clock_timestamp(),false) then
    raise exception 'storage_policy_denied' using errcode='42501'; end if;
  return jsonb_build_object('policy_id',policy.id,'policy_generation',policy.policy_generation,
    'policy_receipt_id',policy.activation_receipt_id,'scope_digest',digest,
    'capability_id',cap.id,'capability_version',cap.version,'registration_lineage',lineage_key,
    'registration_generation',cap.registration_generation,'binding_id',b.id,'authorization_version',a.version,
    'owner_id',owner_key,'connection_id',c.id,'profile_id',p.id,'profile_version',p.version,
    'auth_generation',c.auth_generation,'actions',to_jsonb(policy.actions));
end $$;

do $$ declare t text; begin
  foreach t in array array['storage_client_registrations_v2','storage_client_request_links_v2',
    'storage_client_capabilities_v2','storage_account_policies_v2','storage_client_denies_v2','storage_root_denies_v2'] loop
    execute format('alter table clued_private.%I enable row level security',t);
    execute format('revoke all on clued_private.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger %I before update or delete on clued_private.%I for each row execute function clued_private.storage_policy_rows_guard_v2()',t||'_immutable',t);
  end loop;
end $$;
create trigger storage_client_capability_insert_v2 before insert on clued_private.storage_client_capabilities_v2
  for each row execute function clued_private.storage_policy_rows_guard_v2();
revoke all on function clued_private.storage_client_request_digest_v2(uuid),
  clued_private.storage_policy_scope_digest_v2(uuid),clued_private.storage_client_guard_v2(uuid,uuid,boolean),
  clued_private.storage_policy_rows_guard_v2(),clued_private.storage_connection_mode_guard_v2(),
  clued_private.storage_policy_consistency_v2(),clued_private.storage_policy_evaluate_v2(text,uuid,text,uuid)
  from public,anon,authenticated,service_role;
