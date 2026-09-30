-- StorageNormalUse.v0.1 N1a: normal use on an EXISTING connection.
--
-- * Re-consent (§2.3, §2.4): connection-consent attempts record the requested
--   scope profile, whether normal use was requested, the disclosure version the
--   Owner confirmed, the read generation seen at prepare, and the refresh
--   delegation carry snapshot. `complete` accepts only a granted profile equal
--   to the requested one or `legacy` (the Owner may untick a scope). The old
--   credential envelope is overwritten by the 075249 UPDATE (no Google revoke,
--   Decision 7dbb4c09 Q11); any failure rolls the whole transaction back.
-- * A NEW outermost OAuth wrapper public.clued_storage_oauth_v1 (§2.4 item 3):
--   the 211632 dispatcher becomes clued_private.storage_oauth_dispatch_v1. The
--   wrapper checks the root is quiet at prepare (early storage_root_busy), the
--   refresh-token count (§2.4 item 8), binds the requested profile, carries an
--   enabled refresh delegation across a connection re-consent under four
--   conditions with its own receipt, and, when normal use was requested and
--   Google granted `normal`, writes normal/1 read access in the same transaction.
--   Lock order: owner||root advisory -> connection FOR UPDATE -> delegation row
--   (§8.1.9 item 3), the same as clued_storage_refresh_manage_v1.
-- * Refresh-token issuance ledger: one row per OAuth `claim` (before any token
--   exchange), counted per owner x provider subject x OAuth client.
-- * Native RPC public.clued_storage_normal_use_v1 (§8.2): status / enable /
--   disable. enable writes {read, read_content} + normal/1 under
--   clued.storage-normal-use-disclosure/1 and needs provider_scope_profile
--   normal (otherwise it answers reconsent_required and writes nothing);
--   disable keeps {read} (text/1).
-- * clued_storage_read_access_v1: status reports both profiles; set_classes no
--   longer silently rewrites normal/1 read access as text/1.
-- * clued_storage_read_v1 admit: `content_search` (full-text search, §5.2) is
--   evaluated for read_content and requires normal/1 and a normal credential.

alter table clued_private.storage_oauth_attempts_v1
  add column requested_scope_profile text
    constraint storage_oauth_requested_profile_v1 check (requested_scope_profile in ('legacy','normal')),
  add column normal_use_requested boolean not null default false,
  add column disclosure_version text
    constraint storage_oauth_disclosure_version_v1 check (length(disclosure_version) between 1 and 160),
  add column normal_use_read_generation bigint
    constraint storage_oauth_normal_use_generation_v1 check (normal_use_read_generation>=0),
  add column carry_snapshot jsonb
    constraint storage_oauth_carry_snapshot_v1 check (carry_snapshot is null or jsonb_typeof(carry_snapshot)='object'),
  add constraint storage_oauth_normal_use_v1 check (not normal_use_requested or (purpose='connection'
    and requested_scope_profile='normal' and disclosure_version is not null and normal_use_read_generation is not null)),
  add constraint storage_oauth_connection_fields_v1 check (purpose='connection'
    or (requested_scope_profile is null and carry_snapshot is null and not normal_use_requested and disclosure_version is null));

-- §2.4 item 8 (m-k): Google keeps a limited number of refresh tokens per
-- account x client and silently drops the oldest. Every claim may lead to a
-- token (orphans included), so it is counted before the exchange. cleared_at is
-- reserved for "withdraw all file read access" (revoke), a later slice; until
-- then it is set only by the operator runbook step (resource-center-account-
-- connection.md) after the Owner revoked Clued's access at Google. Until that
-- slice lands, the 90 limit refuses only normal-use re-consent (an upgrade that
-- adds a token by choice); plain reconnect and recovery are counted, not refused.
create table clued_private.storage_refresh_token_issuance_v1 (
  oauth_attempt_id uuid primary key references clued_private.storage_oauth_attempts_v1(id),
  owner_id uuid not null references auth.users(id),
  oauth_client_id text not null,
  provider_subject text,
  connection_id uuid references clued_private.storage_connections_v1(id),
  purpose text not null,
  claimed_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  cleared_at timestamptz
);
create index storage_refresh_token_issuance_owner_v1 on clued_private.storage_refresh_token_issuance_v1(owner_id,oauth_client_id)
  where cleared_at is null;
alter table clued_private.storage_refresh_token_issuance_v1 enable row level security;
revoke all on clued_private.storage_refresh_token_issuance_v1 from public,anon,authenticated,service_role;

create function clued_private.storage_refresh_token_issuance_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if old.status='prepared' and new.status='claimed' then
    insert into clued_private.storage_refresh_token_issuance_v1(oauth_attempt_id,owner_id,oauth_client_id,provider_subject,connection_id,purpose)
      select new.id,new.owner_id,a.oauth_client_id,c.provider_subject,new.connection_id,new.purpose
      from clued_private.storage_oauth_apps_v1 a left join clued_private.storage_connections_v1 c on c.id=new.connection_id
      where a.issuer_hash=new.issuer_hash
    on conflict (oauth_attempt_id) do nothing;
  elsif old.status is distinct from 'completed' and new.status='completed' then
    update clued_private.storage_refresh_token_issuance_v1 t set completed_at=clock_timestamp(),
      provider_subject=coalesce(t.provider_subject,(select c.provider_subject from clued_private.storage_connections_v1 c where c.id=new.connection_id))
      where t.oauth_attempt_id=new.id;
  end if;
  return null;
end $$;
create trigger storage_refresh_token_issuance_v1 after update of status on clued_private.storage_oauth_attempts_v1
  for each row execute function clued_private.storage_refresh_token_issuance_v1();

-- Conservative: a claim whose subject is still unknown may belong to any
-- Google account of this owner, and an unknown subject counts every claim.
create function clued_private.storage_refresh_token_count_v1(p_owner uuid,p_subject text,p_client text) returns integer
language sql stable security definer set search_path='' as $$
  select count(*)::integer from clued_private.storage_refresh_token_issuance_v1 t
  where t.owner_id=p_owner and t.oauth_client_id=p_client and t.cleared_at is null
    and (p_subject is null or t.provider_subject is null or t.provider_subject=p_subject)
$$;

-- One writer of normal-use read access, for the native RPC and the re-consent
-- completion. The caller holds the owner||root advisory lock, has checked the
-- connection/policy/CAS and owns the pending receipt p_r.
create function clued_private.storage_normal_use_write_v1(p_owner uuid,p_connection uuid,p_policy uuid,p_project uuid,
  p_enable boolean,p_disclosure text,p_r public.clued_audit_receipts,p_idempotency text,p_source text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ra clued_private.storage_read_access_v1; fresh clued_private.storage_read_access_v1; refs jsonb; ev text; base bigint;
begin
  if p_r.status is distinct from 'pending' or p_source not in ('owner','oauth_reconsent')
    or (p_enable and p_disclosure is distinct from 'clued.storage-normal-use-disclosure/1') then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  select * into ra from clued_private.storage_read_access_v1 where connection_id=p_connection and owner_id=p_owner and state='active' for update;
  base:=coalesce(ra.read_generation,0);
  if ra.id is not null then
    update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=p_r.id where id=ra.id;
  end if;
  -- Disabling keeps browsing ({read}, Q8) under the read-level disclosure.
  insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id,content_profile)
  values(p_owner,p_connection,p_policy,case when p_enable then '{read,read_content}'::text[] else '{read}'::text[] end,
    coalesce((select max(read_generation) from clued_private.storage_read_access_v1 where connection_id=p_connection),0)+1,
    case when p_enable then p_disclosure else 'clued.storage-read-disclosure/1' end,p_r.id,
    case when p_enable then 'normal/1' else 'text/1' end)
  returning * into fresh;
  refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',p_connection));
  ev:=clued_private.m1_append_event_row(p_owner,null,p_r.id,p_r.canonical_version,'extension:storage:normal_use_v1',
    refs,'project:'||p_project::text,null,jsonb_build_object('connection_id',p_connection,'normal_use',p_enable,
      'read_generation',fresh.read_generation,'content_profile',fresh.content_profile,'source',p_source),
    p_idempotency,p_r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
  return clued_private.m1_finish_receipt(p_r.id,'committed',refs,jsonb_build_object(p_connection::text,base),
    jsonb_build_object(p_connection::text,fresh.read_generation),array[ev],'{}'::uuid[],null);
end $$;

-- §8.2 native Owner control. status: profiles, CAS base and token count.
-- enable/disable: CAS on the active read_generation (0 = none), disclosure
-- clued.storage-normal-use-disclosure/1. Same lock order as set_classes.
create function public.clued_storage_normal_use_v1(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  c clued_private.storage_connections_v1; p clued_private.resource_center_profiles_v1;
  policy clued_private.storage_account_policies_v2; ra clued_private.storage_read_access_v1;
  root text; expected bigint; r public.clued_audit_receipts; tokens integer; result jsonb;
  disclosure constant text:='clued.storage-normal-use-disclosure/1';
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_input) is distinct from 'object' or coalesce(op,'') not in ('status','enable','disable') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if op='status' then
    if (p_input-array['action','connection_id'])<>'{}'::jsonb or coalesce(p_input->>'connection_id','') !~ uuid_re then
      raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u;
    if not found then raise exception 'storage_owner_denied' using errcode='42501'; end if;
    select * into ra from clued_private.storage_read_access_v1 where connection_id=c.id and owner_id=u and state='active';
    tokens:=case when c.oauth_client_id is null then 0 else clued_private.storage_refresh_token_count_v1(u,c.provider_subject,c.oauth_client_id) end;
    return jsonb_build_object('connection_id',c.id,'disclosure_version',disclosure,'provider_scope_profile',c.provider_scope_profile,
      'read_generation',coalesce(ra.read_generation,0),'active',ra.id is not null,'classes',coalesce(to_jsonb(ra.classes),'[]'::jsonb),
      'content_profile',ra.content_profile,
      'normal_use',coalesce(ra.content_profile='normal/1' and ra.account_policy_id=c.account_policy_id and c.provider_scope_profile='normal',false),
      'reconsent_required',c.provider_scope_profile<>'normal',
      'refresh_token_count',tokens,'refresh_token_warning',tokens>=50,'refresh_token_blocked',tokens>=90);
  end if;
  if (p_input-array['action','connection_id','base_generation','disclosure_version','idempotency_key'])<>'{}'::jsonb
    or not(p_input ?& array['action','connection_id','base_generation','disclosure_version','idempotency_key'])
    or coalesce(p_input->>'connection_id','') !~ uuid_re
    or jsonb_typeof(p_input->'base_generation') is distinct from 'number' or p_input->>'base_generation' !~ '^(0|[1-9][0-9]{0,17})$'
    or jsonb_typeof(p_input->'disclosure_version') is distinct from 'string'
    or jsonb_typeof(p_input->'idempotency_key') is distinct from 'string'
    or length(p_input->>'idempotency_key') not between 8 and 160 or p_input->>'idempotency_key'<>btrim(p_input->>'idempotency_key') then
    raise exception 'storage_owner_input_invalid' using errcode='22023'; end if;
  if p_input->>'disclosure_version' is distinct from disclosure then
    raise exception 'storage_normal_use_disclosure_changed' using errcode='40001'; end if;
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
  -- A legacy credential cannot read other files: the page starts re-consent.
  if op='enable' and c.provider_scope_profile is distinct from 'normal' then
    return jsonb_build_object('status','reconsent_required','connection_id',c.id,'provider_scope_profile',c.provider_scope_profile,
      'execution_permitted',false);
  end if;
  r:=clued_private.m1_begin_receipt(u,null,'storage_normal_use_v1',p_input,clued_private.m1_sha256(p_input));
  if r.status<>'pending' then
    if r.status='committed' then return r.canonical_result; end if;
    raise exception 'storage_owner_version_conflict' using errcode='40001';
  end if;
  if c.id is null or c.auth_mode<>'account_policy' or c.state<>'active' or c.revoked_at is not null
    or policy.id is null or policy.state<>'active' or p.root_folder_id is distinct from root
    or coalesce(ra.read_generation,0)<>expected
    or (op='enable' and ra.id is not null and ra.content_profile='normal/1' and ra.account_policy_id=policy.id)
    or (op='disable' and (ra.id is null or ra.content_profile<>'normal/1')) then
    raise exception 'storage_owner_version_conflict' using errcode='40001'; end if;
  result:=clued_private.storage_normal_use_write_v1(u,c.id,policy.id,p.project_id,op='enable',disclosure,r,p_input->>'idempotency_key','owner');
  perform clued_private.storage_owner_v1();
  return result;
end $$;

-- The 211632 dispatcher keeps routing inspect/claim/complete by purpose.
alter function public.clued_storage_oauth_v1(text,jsonb) rename to storage_oauth_dispatch_v1;
alter function public.storage_oauth_dispatch_v1(text,jsonb) set schema clued_private;
revoke all on function clued_private.storage_oauth_dispatch_v1(text,jsonb) from public,anon,authenticated,service_role;

create function public.clued_storage_oauth_v1(p_issuer_hash text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=clued_private.storage_owner_v1(); op text:=p_input->>'action';
  x clued_private.storage_oauth_attempts_v1; c clued_private.storage_connections_v1; after clued_private.storage_connections_v1;
  d clued_private.storage_refresh_delegations_v1; policy clued_private.storage_account_policies_v2;
  ra clued_private.storage_read_access_v1; app clued_private.storage_oauth_apps_v1;
  root text; after_root text; project uuid; requested text; granted text; normal boolean:=false; generation bigint;
  result jsonb; r public.clued_audit_receipts; req jsonb; refs jsonb; ev text; normal_enabled boolean:=false;
  normal_disclosure constant text:='clued.storage-normal-use-disclosure/1';
  uuid_re constant text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  if op='prepare' then
    -- Only the server Worker composes these keys; the Owner's page chose normal use.
    if (p_input ? 'requested_scope_profile' and (jsonb_typeof(p_input->'requested_scope_profile') is distinct from 'string'
          or p_input->>'requested_scope_profile' not in ('legacy','normal')))
      or (p_input ? 'normal_use' and (jsonb_typeof(p_input->'normal_use') is distinct from 'object'
          or ((p_input->'normal_use')-'disclosure_version')<>'{}'::jsonb
          or p_input->>'requested_scope_profile' is distinct from 'normal'))
      or coalesce(p_input->>'connection_id','') !~ uuid_re then
      raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    if p_input ? 'normal_use' and p_input->'normal_use'->>'disclosure_version' is distinct from normal_disclosure then
      raise exception 'storage_normal_use_disclosure_changed' using errcode='40001'; end if;
    requested:=coalesce(p_input->>'requested_scope_profile','legacy');
    normal:=p_input ? 'normal_use';
    select p0.root_folder_id into root from clued_private.storage_connections_v1 c0
      join clued_private.resource_center_profiles_v1 p0 on p0.id=c0.profile_id
      where c0.id=(p_input->>'connection_id')::uuid and c0.owner_id=u;
    if root is null then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
    -- Early busy hint (§2.4 item 3); complete checks the same function again.
    perform clued_private.storage_root_quiet_v1(u,root);
    select * into c from clued_private.storage_connections_v1 where id=(p_input->>'connection_id')::uuid and owner_id=u for update;
    select * into app from clued_private.storage_oauth_apps_v1 where issuer_hash=p_issuer_hash and revoked_at is null;
    -- §2.4 item 8 (b), scoped: only a normal-use upgrade is refused at 90
    -- (see the ledger comment); a plain reconnect is never locked out.
    if normal and app.issuer_hash is not null and clued_private.storage_refresh_token_count_v1(u,c.provider_subject,app.oauth_client_id)>=90 then
      raise exception 'storage_refresh_token_limit' using errcode='42501'; end if;
    result:=clued_private.storage_oauth_dispatch_v1(p_issuer_hash,p_input-'requested_scope_profile'-'normal_use');
    if result->>'status'='prepared' then
      select read_generation into generation from clued_private.storage_read_access_v1 where connection_id=c.id and state='active';
      update clued_private.storage_oauth_attempts_v1 set requested_scope_profile=requested,normal_use_requested=normal,
        disclosure_version=case when normal then normal_disclosure end,
        normal_use_read_generation=case when normal then coalesce(generation,0) end,
        carry_snapshot=jsonb_build_object('provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,'root_folder_id',root)
        where id=(p_input->>'attempt_id')::uuid and owner_id=u and connection_id=c.id and purpose='connection' and status='prepared';
      if not found then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    end if;
    perform clued_private.storage_owner_v1();
    return result;
  end if;
  if op in ('claim','complete') then
    select * into x from clued_private.storage_oauth_attempts_v1 where state_hash=p_input->>'state_hash' and owner_id=u
      and session_id=(auth.jwt()->>'session_id')::uuid and issuer_hash=p_issuer_hash;
  end if;
  if op='complete' and x.purpose='connection' then
    select p0.root_folder_id,p0.project_id into root,project from clued_private.storage_connections_v1 c0
      join clued_private.resource_center_profiles_v1 p0 on p0.id=c0.profile_id where c0.id=x.connection_id and c0.owner_id=u;
    if root is null then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
    -- §8.1.9 item 3: advisory -> connection -> delegation.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(u::text||':'||root,0));
    select * into c from clued_private.storage_connections_v1 where id=x.connection_id and owner_id=u for update;
    select * into d from clued_private.storage_refresh_delegations_v1 where connection_id=c.id for update;
    select * into x from clued_private.storage_oauth_attempts_v1 where id=x.id;
    -- §2.3: the granted profile is the requested one or legacy.
    requested:=coalesce(x.requested_scope_profile,'legacy');
    granted:=coalesce(p_input->>'provider_scope_profile','legacy');
    if granted not in (requested,'legacy') then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  end if;
  result:=clued_private.storage_oauth_dispatch_v1(p_issuer_hash,p_input);
  if op='claim' and x.purpose='connection' and result->>'status'='claimed' then
    result:=result||jsonb_build_object('requested_scope_profile',coalesce(x.requested_scope_profile,'legacy'));
  elsif op='claim' and x.purpose='connection' and result->>'status'='completed' then
    -- Replay after a lost reply: the page shows the CURRENT profile and normal
    -- use state (read-only; the committed completion receipt is unchanged).
    select * into after from clued_private.storage_connections_v1 where id=x.connection_id and owner_id=u;
    result:=result||jsonb_build_object('requested_scope_profile',coalesce(x.requested_scope_profile,'legacy'),
      'provider_scope_profile',after.provider_scope_profile);
    if x.normal_use_requested then
      result:=result||jsonb_build_object('normal_use_enabled',exists(select 1 from clued_private.storage_read_access_v1 ra0
        where ra0.connection_id=after.id and ra0.owner_id=u and ra0.state='active' and ra0.content_profile='normal/1'
          and ra0.account_policy_id=after.account_policy_id and after.provider_scope_profile='normal'));
    end if;
  end if;
  if op='complete' and x.purpose='connection' and result->>'status'='completed' then
    select * into after from clued_private.storage_connections_v1 where id=c.id;
    select p0.root_folder_id into after_root from clued_private.resource_center_profiles_v1 p0 where p0.id=after.profile_id;
    -- Refresh delegation carry (§2.4 item 3). The inner 083521 wrapper just
    -- disabled every delegation of this root; re-enable only this connection's,
    -- and only if it was enabled before and subject, OAuth client and root are
    -- the same at prepare, before and after this completion.
    if coalesce(d.enabled,false) and d.issuer_hash=p_issuer_hash and c.provider_subject is not null
      and x.carry_snapshot=jsonb_build_object('provider_subject',c.provider_subject,'oauth_client_id',c.oauth_client_id,'root_folder_id',root)
      and after.provider_subject=c.provider_subject and after.oauth_client_id=c.oauth_client_id and after_root=root
      and after.state='active' and after.revoked_at is null then
      req:=jsonb_build_object('idempotency_key','oauth-refresh-carry:'||x.id::text,'connection_id',c.id,'oauth_attempt_id',x.id,
        'oauth_receipt_id',result->>'receipt_id','delegation_version',d.version);
      r:=clued_private.m1_begin_receipt(u,null,'storage_refresh_delegation_carry',req,clued_private.m1_sha256(req));
      if r.status<>'pending' then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
      -- Same reset as clued_storage_refresh_manage_v1 enable: the new credential
      -- starts with no failure history and is due for refresh now.
      update clued_private.storage_refresh_delegations_v1 set enabled=true,version=version+1,failures=0,
        next_refresh_at=clock_timestamp(),receipt_id=r.id
        where connection_id=c.id and issuer_hash=p_issuer_hash and not enabled;
      if not found then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
      refs:=jsonb_build_array(jsonb_build_object('kind','system','role','primary','id',c.id));
      ev:=clued_private.m1_append_event_row(u,null,r.id,r.canonical_version,'extension:storage:refresh_delegation_carry',
        refs,'project:'||project::text,null,jsonb_build_object('connection_id',c.id,'oauth_attempt_id',x.id,
          'oauth_receipt_id',result->>'receipt_id'),
        req->>'idempotency_key',r.request_sha256,'success','audit_only','{}'::uuid[],'[]'::jsonb,null);
      perform clued_private.m1_finish_receipt(r.id,'committed',refs,'{}'::jsonb,'{}'::jsonb,array[ev],'{}'::uuid[],null);
      result:=result||jsonb_build_object('refresh_carry_receipt_id',r.id);
    end if;
    -- §8.2 item 2: Google granted normal -> normal/1 read access in this
    -- transaction, unless read access changed since prepare or the connection
    -- has no active account policy (then the page shows the toggle off).
    if x.normal_use_requested then
      if granted='normal' and after.provider_scope_profile='normal' and after.auth_mode='account_policy' and after.state='active' then
        select * into policy from clued_private.storage_account_policies_v2
          where id=after.account_policy_id and connection_id=after.id and owner_id=u and state='active' for share;
        select * into ra from clued_private.storage_read_access_v1 where connection_id=after.id and owner_id=u and state='active' for update;
        if policy.id is not null and coalesce(ra.read_generation,0)=x.normal_use_read_generation
          and not (ra.id is not null and ra.content_profile='normal/1' and ra.account_policy_id=policy.id) then
          req:=jsonb_build_object('idempotency_key','oauth-normal-use:'||x.id::text,'action','enable','connection_id',after.id,
            'oauth_attempt_id',x.id,'oauth_receipt_id',result->>'receipt_id','disclosure_version',x.disclosure_version,
            'base_generation',x.normal_use_read_generation);
          r:=clued_private.m1_begin_receipt(u,null,'storage_normal_use_v1',req,clued_private.m1_sha256(req));
          if r.status<>'pending' then raise exception 'storage_oauth_denied' using errcode='42501'; end if;
          perform clued_private.storage_normal_use_write_v1(u,after.id,policy.id,project,true,x.disclosure_version,r,
            req->>'idempotency_key','oauth_reconsent');
          normal_enabled:=true;
          result:=result||jsonb_build_object('normal_use_receipt_id',r.id);
        elsif ra.id is not null and ra.content_profile='normal/1' and ra.account_policy_id=policy.id then
          normal_enabled:=true;
        end if;
      end if;
      result:=result||jsonb_build_object('normal_use_enabled',normal_enabled);
    end if;
    result:=result||jsonb_build_object('provider_scope_profile',after.provider_scope_profile,'requested_scope_profile',requested,
      'refresh_enabled',exists(select 1 from clued_private.storage_refresh_delegations_v1 where connection_id=after.id and enabled));
  end if;
  -- Lock waits above can cross session or attempt expiry: check them LAST.
  perform clued_private.storage_owner_v1();
  if op in ('claim','complete') and not exists(select 1 from clued_private.storage_oauth_attempts_v1
    where state_hash=p_input->>'state_hash' and owner_id=u and session_id=(auth.jwt()->>'session_id')::uuid
      and issuer_hash=p_issuer_hash and expires_at>clock_timestamp()) then
    raise exception 'storage_oauth_denied' using errcode='42501'; end if;
  return result;
end $$;

-- Anchored patches on the latest definitions (every edit of one function
-- first, then one CREATE OR REPLACE), as in 20260930140000.
do $migration$
declare patch record; body text; hits int; current text;
begin
  for patch in select * from (values
    -- Read access status reports both profiles.
    ('public.clued_storage_read_access_v1(jsonb)',
     $a$      'active',ra.id is not null,'classes',coalesce(to_jsonb(ra.classes),'[]'::jsonb),$a$,
     $r$      'active',ra.id is not null,'classes',coalesce(to_jsonb(ra.classes),'[]'::jsonb),
      'content_profile',ra.content_profile,'provider_scope_profile',c.provider_scope_profile,$r$,1),
    -- set_classes never rewrites normal/1 read access as text/1 (N0a review):
    -- normal use is changed through clued_storage_normal_use_v1; removing
    -- read_content (or everything) stays possible and is an explicit downgrade.
    ('public.clued_storage_read_access_v1(jsonb)',
     $a$    r:=clued_private.m1_begin_receipt(u,null,'storage_owner_read_access_v1',p_input,clued_private.m1_sha256(p_input));$a$,
     $r$    if ra.content_profile='normal/1' and 'read_content'=any(wanted) then
      raise exception 'storage_normal_use_managed' using errcode='42501'; end if;
    r:=clued_private.m1_begin_receipt(u,null,'storage_owner_read_access_v1',p_input,clued_private.m1_sha256(p_input));$r$,1),
    -- Full-text search admission (§5.2).
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$    if (p_input-array['action','connection_id','operation','object_id','condition_hmac','key_id'])<>'{}'::jsonb$a$,
     $r$    if (p_input-array['action','connection_id','operation','object_id','condition_hmac','key_id','content_search'])<>'{}'::jsonb
      or (p_input ? 'content_search' and (p_input->'content_search' is distinct from 'true'::jsonb
        or p_input->>'operation' is distinct from 'search' or not (p_input ? 'condition_hmac')))$r$,1),
    ('public.clued_storage_read_v1(text,text,jsonb)',
     $a$    evaluated:=clued_private.storage_read_evaluate_v1(p_token_hash,(p_input->>'connection_id')::uuid,wanted);$a$,
     $r$    evaluated:=clued_private.storage_read_evaluate_v1(p_token_hash,(p_input->>'connection_id')::uuid,wanted);
    if p_input ? 'content_search' then
      if evaluated->>'content_profile' is distinct from 'normal/1' or (select c0.provider_scope_profile
          from clued_private.storage_connections_v1 c0 where c0.id=(evaluated->>'connection_id')::uuid) is distinct from 'normal' then
        raise exception 'storage_read_scope_upgrade_required' using errcode='42501'; end if;
      perform clued_private.storage_read_evaluate_v1(p_token_hash,(p_input->>'connection_id')::uuid,'read_content');
    end if;$r$,1)
  ) v(sig,anchor,replacement,expected) loop
    if current is distinct from patch.sig then
      if current is not null then execute body; end if;
      current:=patch.sig; body:=pg_get_functiondef(patch.sig::regprocedure);
    end if;
    hits:=(length(body)-length(replace(body,patch.anchor,'')))/length(patch.anchor);
    if hits<>patch.expected then
      raise exception 'storage_normal_use_definition_mismatch: % (% of %) %',patch.sig,hits,patch.expected,left(patch.anchor,60);
    end if;
    body:=replace(body,patch.anchor,patch.replacement);
  end loop;
  execute body;
end $migration$;

revoke all on function clued_private.storage_refresh_token_issuance_v1(),
  clued_private.storage_refresh_token_count_v1(uuid,text,text),
  clued_private.storage_normal_use_write_v1(uuid,uuid,uuid,uuid,boolean,text,public.clued_audit_receipts,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_storage_normal_use_v1(jsonb),public.clued_storage_oauth_v1(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_storage_normal_use_v1(jsonb) to authenticated;
grant execute on function public.clued_storage_oauth_v1(text,jsonb) to authenticated;
