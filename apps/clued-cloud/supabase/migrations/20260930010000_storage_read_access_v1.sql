-- StorageFullCapability.v0.1 P1 (read level). CLOSED by default: no app has
-- read_enabled, no read access row is seeded, and the read_content class is
-- stored but cannot be enabled until P2. Read levels live outside the write
-- policy so toggling them never changes a policy row, its digest or
-- auth_generation, and never invalidates a queued/prepared create job.

alter table clued_private.storage_oauth_apps_v1 add column read_enabled boolean not null default false;

create table clued_private.storage_read_access_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  account_policy_id uuid not null references clued_private.storage_account_policies_v2(id),
  classes text[] not null check(classes in ('{read}'::text[],'{read_content}'::text[],'{read,read_content}'::text[])),
  read_generation bigint not null check(read_generation>0),
  disclosure_version text not null check(length(disclosure_version) between 1 and 160),
  consent_receipt_id uuid not null references public.clued_audit_receipts(id),
  state text not null default 'active' check(state in ('active','revoked')),
  revoked_at timestamptz,
  revocation_receipt_id uuid references public.clued_audit_receipts(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(connection_id,read_generation),
  check((state='revoked')=(revoked_at is not null)),
  check(state<>'revoked' or revocation_receipt_id is not null)
);
create unique index storage_read_access_active_v1 on clued_private.storage_read_access_v1(connection_id) where state='active';

-- Per-class restriction. storage_client_denies_v2 (whole storage) still applies
-- to reads; this table only removes one read class for one client lineage.
create table clued_private.storage_read_client_denies_v1 (
  owner_id uuid not null references auth.users(id),
  lineage_id uuid not null check(lineage_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  class text not null check(class in ('read','read_content')),
  generation bigint not null default 1 check(generation>0),
  denied boolean not null default true,
  receipt_id uuid not null references public.clued_audit_receipts(id),
  primary key(owner_id,lineage_id,class)
);

-- Dedicated read receipts: never clued_audit_receipts, so "read" is never
-- confused with "changed". No body, file name list or search term is stored;
-- condition_hmac is computed by the Worker with a domain-separated keyring key.
create table clued_private.storage_read_receipts_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  connection_id uuid not null references clued_private.storage_connections_v1(id),
  lineage_id uuid not null,
  binding_id uuid not null,
  account_policy_id uuid not null,
  read_access_id uuid not null references clued_private.storage_read_access_v1(id),
  read_generation bigint not null check(read_generation>0),
  class text not null check(class in ('read','read_content')),
  operation text not null check(operation in ('list','stat','search','resolve','read')),
  object_id text check(object_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  condition_hmac text check(condition_hmac ~ '^[0-9a-f]{64}$'),
  key_id text check(key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  state text not null default 'intent' check(state in ('intent','finalized')),
  item_count integer check(item_count between 0 and 100000),
  byte_count bigint check(byte_count>=0),
  complete boolean,
  created_at timestamptz not null default clock_timestamp(),
  finalized_at timestamptz,
  check((condition_hmac is null)=(key_id is null)),
  check((state='finalized')=(finalized_at is not null and item_count is not null and byte_count is not null and complete is not null)),
  check(state='finalized' or (item_count is null and byte_count is null and complete is null))
);
create index storage_read_receipts_owner_v1 on clued_private.storage_read_receipts_v1(owner_id,created_at);

create function clued_private.storage_read_rows_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception 'storage_read_history_immutable' using errcode='42501'; end if;
  if tg_table_name='storage_read_access_v1' then
    if (to_jsonb(new)-array['state','revoked_at','revocation_receipt_id'])
      is distinct from (to_jsonb(old)-array['state','revoked_at','revocation_receipt_id'])
      or old.state='revoked' or new.state<>'revoked' then
      raise exception 'storage_read_access_immutable' using errcode='42501'; end if;
  elsif tg_table_name='storage_read_client_denies_v1' then
    if new.owner_id<>old.owner_id or new.lineage_id<>old.lineage_id or new.class<>old.class
      or new.generation<>old.generation+1 or new.receipt_id=old.receipt_id then
      raise exception 'storage_read_deny_version_conflict' using errcode='40001'; end if;
  elsif tg_table_name='storage_read_receipts_v1' then
    if old.state<>'intent' or new.state<>'finalized'
      or (to_jsonb(new)-array['state','item_count','byte_count','complete','finalized_at'])
        is distinct from (to_jsonb(old)-array['state','item_count','byte_count','complete','finalized_at']) then
      raise exception 'storage_read_receipt_immutable' using errcode='42501'; end if;
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['storage_read_access_v1','storage_read_client_denies_v1','storage_read_receipts_v1'] loop
    execute format('alter table clued_private.%I enable row level security',t);
    execute format('revoke all on clued_private.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger %I before update or delete on clued_private.%I for each row execute function clued_private.storage_read_rows_guard_v1()',t||'_immutable',t);
  end loop;
end $$;

-- Read evaluator (§5.1). Same identity checks as storage_policy_evaluate_v2,
-- but NO job lock and a SHARED root advisory on the same key: reads do not
-- serialize with each other, while disconnect/policy revoke/read toggles (root
-- X) and client revoke/class deny (lineage X) serialize with them. v12 and
-- capability revokes conflict with the row locks held FOR SHARE here.
-- The caller's transaction commit is the linearization point.
create function clued_private.storage_read_evaluate_v1(p_hash text,p_connection uuid,p_class text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12;
  req clued_private.authorization_requests_v12; link clued_private.storage_client_request_links_v2;
  registration clued_private.storage_client_registrations_v2; cap clued_private.storage_client_capabilities_v2;
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; ra clued_private.storage_read_access_v1;
  owner_key uuid; binding_key uuid; request_key uuid; lineage_key uuid; root_key text; issuer_key text; resource_key text;
  digest text; runtime_decision uuid; runtime_version bigint;
begin
  if coalesce(p_hash,'') !~ '^[0-9a-f]{64}$' or p_connection is null
    or coalesce(p_class,'') not in ('read','read_content') then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  -- Unlocked reads select lock keys ONLY. Every identity is rechecked below.
  select b0.user_id,b0.id,a0.request_id,l.lineage_id,p0.root_folder_id,r0.issuer_hash,r0.resource
    into owner_key,binding_key,request_key,lineage_key,root_key,issuer_key,resource_key
    from public.clued_agent_bindings b0 join clued_private.authorizations_v12 a0 on a0.binding_id=b0.id and a0.owner_id=b0.user_id
    join clued_private.authorization_requests_v12 r0 on r0.id=a0.request_id
    join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id
    join clued_private.storage_connections_v1 c0 on c0.id=p_connection and c0.owner_id=b0.user_id
    join clued_private.resource_center_profiles_v1 p0 on p0.id=c0.profile_id and p0.user_id=b0.user_id
    where b0.token_hash=p_hash;
  if not found then raise exception 'storage_read_denied' using errcode='42501'; end if;
  perform 1 from clued_private.authorization_issuers_v12 where token_hash=issuer_key
    and resource=resource_key and revoked_at is null for share;
  if not found then raise exception 'storage_read_denied' using errcode='42501'; end if;
  perform clued_private.storage_client_guard_v2(owner_key,lineage_key,false);
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(owner_key::text||':'||root_key,0));
  select * into b from public.clued_agent_bindings where id=binding_key and user_id=owner_key and token_hash=p_hash for share;
  if not found or b.revoked_at is not null then raise exception 'storage_read_denied' using errcode='42501'; end if;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=owner_key for share;
  if not found or a.request_id<>request_key or a.revoked_at is not null then raise exception 'storage_read_denied' using errcode='42501'; end if;
  perform clued_private.authorization_account_v12(owner_key);
  select * into c from clued_private.storage_connections_v1 where id=p_connection and owner_id=owner_key for share;
  if not found or c.auth_mode<>'account_policy' or c.state<>'active' or c.revoked_at is not null then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  select * into policy from clued_private.storage_account_policies_v2 where id=c.account_policy_id and connection_id=c.id and owner_id=owner_key for share;
  if not found or policy.state<>'active' or policy.profile_id<>c.profile_id or policy.provider<>c.provider
    or policy.provider_subject is distinct from c.provider_subject or policy.root_folder_id<>root_key then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  select * into ra from clued_private.storage_read_access_v1 where connection_id=c.id and owner_id=owner_key and state='active' for share;
  if not found or ra.account_policy_id<>policy.id or not (p_class=any(ra.classes)) then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  select * into cap from clued_private.storage_client_capabilities_v2 where lineage_id=lineage_key and state='active' for share;
  if not found or cap.state<>'active' then raise exception 'storage_read_denied' using errcode='42501'; end if;
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
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  if exists(select 1 from clued_private.storage_client_denies_v2 where owner_id=owner_key and lineage_id=lineage_key and denied)
    or exists(select 1 from clued_private.storage_read_client_denies_v1 where owner_id=owner_key and lineage_id=lineage_key and class=p_class and denied)
    or exists(select 1 from clued_private.storage_root_denies_v2 where owner_id=owner_key and provider=c.provider
      and provider_subject=c.provider_subject and root_folder_id=root_key and (lineage_id is null or lineage_id=lineage_key) and denied) then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=owner_key for share;
  if not found or p.root_folder_id<>root_key or p.state<>'active' or p.version<>c.profile_version
    or p.cloud_runtime->>'contract' is distinct from 'clued.storage-cloud-runtime/1'
    or p.cloud_runtime->>'profile_version' is distinct from p.version::text then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  runtime_decision:=(p.cloud_runtime->>'source_decision_id')::uuid;
  runtime_version:=(p.cloud_runtime->>'decision_version')::bigint;
  if runtime_decision is null or runtime_version is null then raise exception 'storage_read_denied' using errcode='42501'; end if;
  perform 1 from public.clued_memories where id in
    (c.source_decision_id,p.source_decision_id,policy.source_decision_id,runtime_decision) order by id for share;
  if not clued_private.resource_center_decision_current_v1(owner_key,p.project_id,c.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(owner_key,p.project_id,p.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(owner_key,p.project_id,policy.source_decision_id)
    or not clued_private.resource_center_decision_current_v1(owner_key,p.project_id,runtime_decision)
    or not exists(select 1 from public.clued_memories where id=c.source_decision_id and version=c.decision_version)
    or not exists(select 1 from public.clued_memories where id=policy.source_decision_id and version=policy.decision_version)
    or not exists(select 1 from public.clued_memories where id=runtime_decision and version=runtime_version) then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  digest:=clued_private.storage_policy_scope_digest_v2(c.id);
  if digest is null or policy.scope_digest<>digest
    or not exists(select 1 from public.clued_audit_receipts where id=policy.consent_receipt_id and user_id=owner_key and status='committed')
    or not exists(select 1 from public.clued_audit_receipts where id=policy.activation_receipt_id and user_id=owner_key and status='committed')
    or not exists(select 1 from public.clued_audit_receipts where id=ra.consent_receipt_id and user_id=owner_key and status='committed')
    or exists(select 1 from unnest(array[cap.receipt_id,registration.review_receipt_id,link.review_receipt_id]) rid
      where not exists(select 1 from public.clued_audit_receipts r where r.id=rid and r.status='committed')) then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  -- A lock wait can cross expiry; check the wall clock LAST.
  if a.expires_at is null or a.expires_at<=clock_timestamp()
    or coalesce((to_jsonb(b)->>'expires_at')::timestamptz<=clock_timestamp(),false)
    or coalesce(policy.expires_at<=clock_timestamp(),false) then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  return jsonb_build_object('owner_id',owner_key,'connection_id',c.id,'binding_id',b.id,'registration_lineage',lineage_key,
    'policy_id',policy.id,'read_access_id',ra.id,'read_generation',ra.read_generation,'class',p_class,
    'profile_id',p.id,'root_folder_id',root_key,'managed_root',p.managed_root);
end $$;

-- Worker-only transport (fixed server issuer + the caller's Binding hash).
-- admit: evaluate, commit an intent receipt, and only then return the sealed
-- credential envelope; no receipt means no provider request. finalize: record
-- counts for the SAME Binding's intent, even after a later revoke, so a read is
-- never unaudited. Neither action accepts caller owner/root/profile/class maps.
create function public.clued_storage_read_v1(p_issuer_hash text,p_token_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare app clued_private.storage_oauth_apps_v1; c clued_private.storage_connections_v1;
  op text:=p_input->>'action'; evaluated jsonb; wanted text; rr clued_private.storage_read_receipts_v1;
  b public.clued_agent_bindings;
begin
  if coalesce(p_issuer_hash,'') !~ '^[0-9a-f]{64}$' or coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('admit','finalize')
    or p_input->>'connection_id' is null
    or p_input->>'connection_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'storage_read_input_invalid' using errcode='22023'; end if;
  if op='admit' then
    if (p_input-array['action','connection_id','operation','object_id','condition_hmac','key_id'])<>'{}'::jsonb
      or coalesce(p_input->>'operation','') not in ('list','stat','search','resolve','read')
      or (p_input ? 'object_id' and coalesce(p_input->>'object_id','') !~ '^[A-Za-z0-9_-]{1,160}$')
      or ((p_input ? 'condition_hmac')<>(p_input ? 'key_id'))
      or (p_input ? 'condition_hmac' and (coalesce(p_input->>'condition_hmac','') !~ '^[0-9a-f]{64}$'
        or coalesce(p_input->>'key_id','') !~ '^[A-Za-z0-9._-]{1,64}$')) then
      raise exception 'storage_read_input_invalid' using errcode='22023'; end if;
    wanted:=case when p_input->>'operation'='read' then 'read_content' else 'read' end;
    -- Fixed server issuer is the outermost lock, before identity/root locks.
    select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null and read_enabled for share;
    if not found then raise exception 'storage_read_denied' using errcode='42501'; end if;
    evaluated:=clued_private.storage_read_evaluate_v1(p_token_hash,(p_input->>'connection_id')::uuid,wanted);
    select * into c from clued_private.storage_connections_v1 where id=(evaluated->>'connection_id')::uuid;
    if c.oauth_client_id is distinct from app.oauth_client_id or c.credential_envelope is null
      or c.provider_subject is null or c.credential_version is null then
      raise exception 'storage_read_denied' using errcode='42501'; end if;
    insert into clued_private.storage_read_receipts_v1(owner_id,connection_id,lineage_id,binding_id,account_policy_id,
      read_access_id,read_generation,class,operation,object_id,condition_hmac,key_id)
    values((evaluated->>'owner_id')::uuid,c.id,(evaluated->>'registration_lineage')::uuid,(evaluated->>'binding_id')::uuid,
      (evaluated->>'policy_id')::uuid,(evaluated->>'read_access_id')::uuid,(evaluated->>'read_generation')::bigint,wanted,
      p_input->>'operation',p_input->>'object_id',p_input->>'condition_hmac',p_input->>'key_id')
    returning * into rr;
    return jsonb_build_object('contract','clued.storage-read-admission/1','receipt_id',rr.id,'class',wanted,
      'owner_id',c.owner_id,'connection_id',c.id,'binding_id',rr.binding_id,'provider','google-drive','provider_subject',c.provider_subject,
      'oauth_client_id',c.oauth_client_id,'credential_version',c.credential_version,'credential_envelope',c.credential_envelope,
      'root_folder_id',evaluated->>'root_folder_id','read_generation',rr.read_generation);
  end if;
  if (p_input-array['action','connection_id','receipt_id','item_count','byte_count','complete'])<>'{}'::jsonb
    or not(p_input ?& array['action','connection_id','receipt_id','item_count','byte_count','complete'])
    or coalesce(p_input->>'receipt_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(p_input->'item_count') is distinct from 'number' or p_input->>'item_count' !~ '^(0|[1-9][0-9]{0,4}|100000)$'
    or jsonb_typeof(p_input->'byte_count') is distinct from 'number' or p_input->>'byte_count' !~ '^(0|[1-9][0-9]{0,15})$'
    or jsonb_typeof(p_input->'complete') is distinct from 'boolean' then
    raise exception 'storage_read_input_invalid' using errcode='22023'; end if;
  select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null for share;
  if not found then raise exception 'storage_read_denied' using errcode='42501'; end if;
  select * into b from public.clued_agent_bindings where token_hash=p_token_hash;
  select * into rr from clued_private.storage_read_receipts_v1 where id=(p_input->>'receipt_id')::uuid for update;
  if b.id is null or rr.id is null or rr.binding_id<>b.id or rr.owner_id<>b.user_id
    or rr.connection_id<>(p_input->>'connection_id')::uuid then
    raise exception 'storage_read_denied' using errcode='42501'; end if;
  if rr.state='finalized' then
    if rr.item_count=(p_input->>'item_count')::integer and rr.byte_count=(p_input->>'byte_count')::bigint
      and rr.complete=(p_input->>'complete')::boolean then
      return jsonb_build_object('receipt_id',rr.id,'state',rr.state,'replayed',true); end if;
    raise exception 'storage_read_receipt_conflict' using errcode='40001';
  end if;
  update clued_private.storage_read_receipts_v1 set state='finalized',item_count=(p_input->>'item_count')::integer,
    byte_count=(p_input->>'byte_count')::bigint,complete=(p_input->>'complete')::boolean,finalized_at=clock_timestamp()
    where id=rr.id returning * into rr;
  return jsonb_build_object('receipt_id',rr.id,'state',rr.state,'replayed',false);
end $$;

-- Native Owner control of read access and per-class client deny (§3.3).
-- status: current read access + class denies. set_classes: CAS on the active
-- read_generation (0 = none); [] disables. read_content is rejected until P2.
-- deny_class: storage-only, lineage-scoped, CAS on the deny generation.
create function public.clued_storage_read_access_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; ra clued_private.storage_read_access_v1;
  fresh clued_private.storage_read_access_v1; deny clued_private.storage_read_client_denies_v1;
  b public.clued_agent_bindings; a clued_private.authorizations_v12; link clued_private.storage_client_request_links_v2;
  root text; lineage uuid; expected bigint; wanted text[]; r public.clued_audit_receipts; refs jsonb; ev text; result jsonb;
  disclosure constant text:='clued.storage-read-disclosure/1';
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('status','set_classes','deny_class') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if op='status' then
    if (p_input-array['action','connection_id'])<>'{}'::jsonb or coalesce(p_input->>'connection_id','') !~ uuid_re then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
    if not found then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    select * into ra from clued_private.storage_read_access_v1 where connection_id=c.id and owner_id=u and state='active';
    return jsonb_build_object('connection_id',c.id,'disclosure_version',disclosure,
      -- read_generation is the set_classes CAS base: the active generation, or 0.
      'read_generation',coalesce(ra.read_generation,0),
      'last_generation',coalesce((select max(read_generation) from clued_private.storage_read_access_v1 where connection_id=c.id),0),
      'active',ra.id is not null,'classes',coalesce(to_jsonb(ra.classes),'[]'::jsonb),
      'bound_to_active_policy',coalesce(ra.account_policy_id=c.account_policy_id and c.auth_mode='account_policy' and c.state='active',false),
      'class_denies',coalesce((select jsonb_agg(jsonb_build_object('binding_id',b0.id,'class',d.class,'denied',d.denied,'generation',d.generation) order by b0.id,d.class)
        from public.clued_agent_bindings b0
        join clued_private.authorizations_v12 a0 on a0.binding_id=b0.id and a0.owner_id=u
        join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id
        join clued_private.storage_read_client_denies_v1 d on d.owner_id=u and d.lineage_id=l.lineage_id
        where b0.user_id=u),'[]'::jsonb));
  end if;
  if op='set_classes' then
    if (p_input-array['action','connection_id','classes','base_generation','disclosure_version','idempotency_key'])<>'{}'::jsonb
      or not(p_input ?& array['action','connection_id','classes','base_generation','disclosure_version','idempotency_key'])
      or coalesce(p_input->>'connection_id','') !~ uuid_re
      or jsonb_typeof(p_input->'classes') is distinct from 'array'
      or jsonb_typeof(p_input->'base_generation') is distinct from 'number' or p_input->>'base_generation' !~ '^(0|[1-9][0-9]{0,17})$'
      or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
      or length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key') then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    select coalesce(array_agg(x order by x),'{}') into wanted from (select distinct jsonb_array_elements_text(p_input->'classes') x) s;
    if jsonb_array_length(p_input->'classes')<>cardinality(wanted) or not (wanted <@ array['read','read_content']) then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    if 'read_content'=any(wanted) then raise exception 'storage_read_class_unavailable' using errcode='42501'; end if;
    if cardinality(wanted)>0 and p_input->>'disclosure_version' is distinct from disclosure then
      raise exception 'storage_read_disclosure_changed' using errcode='40001'; end if;
    expected:=(p_input->>'base_generation')::bigint;
    select pr.root_folder_id into root from clued_private.storage_connections_v1 co
      join clued_private.resource_center_profiles_v1 pr on pr.id=co.profile_id and pr.user_id=u
      where co.id=(p_input->>'connection_id')::uuid and co.owner_id=u;
    if root is null then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
    perform clued_private.storage_owner_v1();
    perform clued_private.authorization_account_v12(u);
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for share;
    select * into policy from clued_private.storage_account_policies_v2
      where id=c.account_policy_id and connection_id=c.id and owner_id=u for share;
    select * into p from clued_private.resource_center_profiles_v1 where id=c.profile_id and user_id=u for share;
    select * into ra from clued_private.storage_read_access_v1 where connection_id=c.id and owner_id=u and state='active' for update;
    r:=clued_private.m1_begin_receipt(u,null,'storage_owner_read_access_v1',p_input,clued_private.m1_sha256(p_input));
    if r.status<>'pending' then
      if r.status='committed' then return r.canonical_result; end if;
      raise exception 'storage_owner_version_conflict' using errcode='40001';
    end if;
    if c.id is null or c.auth_mode<>'account_policy' or c.state<>'active' or c.revoked_at is not null
      or policy.id is null or policy.state<>'active' or p.root_folder_id is distinct from root
      or coalesce(ra.read_generation,0)<>expected
      or (ra.id is null and cardinality(wanted)=0)
      or (ra.id is not null and ra.classes=wanted and ra.account_policy_id=policy.id) then
      raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
    if ra.id is not null then
      update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=r.id where id=ra.id;
    end if;
    if cardinality(wanted)>0 then
      insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id)
      values(u,c.id,policy.id,wanted,coalesce((select max(read_generation) from clued_private.storage_read_access_v1 where connection_id=c.id),0)+1,disclosure,r.id)
      returning * into fresh;
    end if;
    refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
    ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:owner_read_access_v1',
      refs,'project:'||p.project_id::text,null,jsonb_build_object('connection_id',c.id,'classes',to_jsonb(wanted),
        'read_generation',coalesce(fresh.read_generation,ra.read_generation)),
      p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
    result:=clued_private.m1_finish_receipt(r.id,'committed',refs,jsonb_build_object(c.id::text,expected),
      jsonb_build_object(c.id::text,coalesce(fresh.read_generation,expected)),array[ev],'{}'::uuid[],null);
    perform clued_private.storage_owner_v1();
    return result;
  end if;
  -- deny_class
  if (p_input-array['action','binding_id','class','denied','base_generation','idempotency_key'])<>'{}'::jsonb
    or not(p_input ?& array['action','binding_id','class','denied','base_generation','idempotency_key'])
    or coalesce(p_input->>'binding_id','') !~ uuid_re
    or coalesce(p_input->>'class','') not in ('read','read_content')
    or jsonb_typeof(p_input->'denied') is distinct from 'boolean'
    or jsonb_typeof(p_input->'base_generation') is distinct from 'number' or p_input->>'base_generation' !~ '^(0|[1-9][0-9]{0,17})$'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  expected:=(p_input->>'base_generation')::bigint;
  select l.lineage_id into lineage from public.clued_agent_bindings b0
    join clued_private.authorizations_v12 a0 on a0.binding_id=b0.id and a0.owner_id=u
    join clued_private.storage_client_request_links_v2 l on l.request_id=a0.request_id
    where b0.id=(p_input->>'binding_id')::uuid and b0.user_id=u;
  if lineage is null then raise exception 'storage_owner_denied' using errcode='42501'; end if;
  perform clued_private.storage_client_guard_v2(u,lineage,true);
  perform clued_private.storage_owner_v1();
  select * into b from public.clued_agent_bindings where id=(p_input->>'binding_id')::uuid and user_id=u for share;
  select * into a from clued_private.authorizations_v12 where binding_id=b.id and owner_id=u for share;
  select * into link from clued_private.storage_client_request_links_v2 where request_id=a.request_id;
  if b.id is null or a.binding_id is null or link.lineage_id is distinct from lineage then
    raise exception 'storage_owner_denied' using errcode='42501'; end if;
  select * into deny from clued_private.storage_read_client_denies_v1 where owner_id=u and lineage_id=lineage and class=p_input->>'class' for update;
  r:=clued_private.m1_begin_receipt(u,null,'storage_owner_read_class_deny_v1',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    if r.status='committed' then return r.canonical_result; end if;
    raise exception 'storage_owner_version_conflict' using errcode='40001';
  end if;
  if coalesce(deny.generation,0)<>expected or coalesce(deny.denied,false)=(p_input->>'denied')::boolean then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  if deny.lineage_id is null then
    insert into clued_private.storage_read_client_denies_v1(owner_id,lineage_id,class,generation,denied,receipt_id)
      values(u,lineage,p_input->>'class',1,true,r.id);
  else
    update clued_private.storage_read_client_denies_v1 set generation=generation+1,denied=(p_input->>'denied')::boolean,receipt_id=r.id
      where owner_id=u and lineage_id=lineage and class=p_input->>'class';
  end if;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',b.id));
  ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:owner_read_class_deny_v1',
    refs,'global',null,jsonb_build_object('binding_id',b.id,'class',p_input->>'class','denied',(p_input->>'denied')::boolean),
    p_input->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  result:=clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
  perform clued_private.storage_owner_v1();
  return result;
end $$;

revoke all on function clued_private.storage_read_rows_guard_v1(),clued_private.storage_read_evaluate_v1(text,uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_read_v1(text,text,jsonb),public.clued_storage_read_access_v1(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_read_v1(text,text,jsonb) to anon;
grant execute on function public.clued_storage_read_access_v1(jsonb) to authenticated;
