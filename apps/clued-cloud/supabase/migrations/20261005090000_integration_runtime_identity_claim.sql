-- S2c Integration Runtime PR-2 (IntegrationRuntime v0.1.8 §14.1): Integration identity, Installation
-- Requests, the Claim Store with its deferred consistency trigger, connections, explicit Binding
-- ownership (§5.5, Owner Decision c5574918), the operation log, derivation diagnostics, the read side
-- of revocation / regrant / reauth marks (§5.9; their write operations are PR-4), connection-revoke
-- materialization (§10.1), integration_normalize_v1 / integration_evaluate_v1, and the PR-2 operations:
-- request_open, create_or_bind (with Rebind authorization and the post-write validity gate),
-- confirm_rebind, identity_update, reconcile_request / reconcile, adopt_binding, binding_inventory and
-- status / list (without READY).
--
-- Placement choices this migration makes inside the frozen §14.1 PR list (recorded in the PR body):
--   (a) integration_facts_v1 and integration_capability_declarations_v1 (§5.6, §5.10) are created here,
--       read-only: §7.2 normalization reads them, and their write operations (declare / report /
--       fact_set) stay in PR-3, exactly as the revocation tables are created here with writes in PR-4.
--   (b) the A-class verification table (§5.7) is created here read-only, like (a), with the §7.4
--       subject digest; §7.2 normalization reads it. Its write operation (verify) is PR-3, so a PR-2
--       build reaches ACTIVE / DEGRADED only through a test fixture row (§14.1 moves those cases to
--       PR-3), and PR-3 adds objects without replacing any PR-2 function.
--   (c) OQ-15: no Event is written. Every operation writes its M1 Receipt only and declares
--       event_ids = [] (§11.3 alternative), so resume / work log / checkpoint counts / capture state and
--       projections cannot be changed by Integration operations (T-S-6).
--   (d) Headless Bindings (authorizations_v12.issuance = 'headless', added after the freeze) all carry
--       client_id 'clued-headless', which is not an OAuth client identity. ERRATA-003 (Owner Decision
--       591a0fc6) derives them as clued.binding.v1 (provider_connection_id = binding_id), one provider
--       connection each, connection kind OAUTH_V12; their authority still comes from
--       authorizations_v12 / authorization_entries_v12, and fresh_consent and O7 do not apply to them.
--   (e) Binding-channel rebind under REBIND_CLASS keeps T's tenant / account values unless the Request
--       payload names them; a VALUE → UNAVAILABLE change is only accepted for REBIND / ADAPTER_MIGRATION
--       (§10.4), otherwise identity_dimension_downgrade_forbidden.
-- New objects only: no existing function, table, policy or grant is changed (§2.3, T-S-3).
-- Nothing is granted to public, anon, authenticated or service_role (§5.13, OQ-21): the public RPCs are
-- created and immediately revoked; the target grants ride the flag-enabling stage authorization.

-- =============================================================================================
-- Part A: tables (§5.2–§5.11)
-- =============================================================================================

create table clued_private.integrations_v1 (
  integration_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  host text not null references clued_private.integration_hosts_v1(host),
  provider text not null references clued_private.integration_providers_v1(provider),
  tenant_status text not null check (tenant_status in ('VALUE','NOT_APPLICABLE','UNAVAILABLE')),
  host_tenant_or_workspace_id text check (host_tenant_or_workspace_id is null or char_length(host_tenant_or_workspace_id) between 1 and 255),
  account_status text not null check (account_status in ('VALUE','NOT_APPLICABLE','UNAVAILABLE')),
  host_account_id text check (host_account_id is null or char_length(host_account_id) between 1 and 255),
  connection_status text not null check (connection_status in ('VALUE','NOT_APPLICABLE','UNAVAILABLE')),
  provider_connection_id text check (provider_connection_id is null or char_length(provider_connection_id) between 1 and 255),
  active_binding_domain text not null references clued_private.integration_binding_domains_v1(domain),
  identity_completeness text not null check (identity_completeness in ('COMPLETE','INCOMPLETE')),
  claim_key_sha256 text check (claim_key_sha256 is null or claim_key_sha256 ~ '^[0-9a-f]{64}$'),
  identity_claim_state text not null check (identity_claim_state in
    ('INCOMPLETE_UNCLAIMED','CURRENT_CLAIM_HOLDER','CLAIM_CONFLICT','PENDING_RECONCILE','SUPERSEDED')),
  conflicting_integration_id uuid references clued_private.integrations_v1(integration_id),
  current_identity_snapshot_id uuid not null,
  adapter_family text not null check (char_length(adapter_family) between 1 and 80),
  adapter_version text not null check (char_length(adapter_version) between 1 and 40),
  package_version text check (package_version is null or char_length(package_version) between 1 and 40),
  install_status text not null check (install_status in ('PENDING','COMPLETED')),
  ordinary_runtime text not null default 'PERMITTED' check (ordinary_runtime in ('PERMITTED','PAUSED_BY_OWNER','PAUSED_BY_POLICY')),
  historical text not null default 'NONE' check (historical in ('NONE','SUPERSEDED')),
  superseded_by_integration_id uuid references clued_private.integrations_v1(integration_id),
  recovery_policy text not null check (recovery_policy in ('PERMITS_REAUTH','FORBIDS_REAUTH')),
  first_authorization_required boolean not null,
  first_authorized_at timestamptz,
  authorization_ceiling jsonb,
  authorization_ceiling_set_at timestamptz,
  policy_version integer not null references clued_private.integration_policy_v1(policy_version),
  version bigint not null default 1 check (version >= 1),
  created_receipt_id uuid not null,
  last_receipt_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((tenant_status = 'VALUE') = (host_tenant_or_workspace_id is not null)),
  check ((account_status = 'VALUE') = (host_account_id is not null)),
  check ((connection_status = 'VALUE') = (provider_connection_id is not null)),
  check ((identity_completeness = 'COMPLETE') = (tenant_status <> 'UNAVAILABLE' and account_status <> 'UNAVAILABLE' and connection_status <> 'UNAVAILABLE')),
  check ((identity_completeness = 'COMPLETE') = (claim_key_sha256 is not null)),
  check ((identity_completeness = 'INCOMPLETE') = (identity_claim_state = 'INCOMPLETE_UNCLAIMED')),
  check ((identity_claim_state in ('CLAIM_CONFLICT','PENDING_RECONCILE')) = (conflicting_integration_id is not null)),
  check ((authorization_ceiling is null) = (authorization_ceiling_set_at is null)),
  check (authorization_ceiling is null or clued_private.integration_ceiling_valid_v1(authorization_ceiling)),
  check ((identity_claim_state = 'SUPERSEDED') = (historical = 'SUPERSEDED')),
  check ((historical = 'SUPERSEDED') = (superseded_by_integration_id is not null))
);
create index integrations_v1_owner on clued_private.integrations_v1(owner_id, created_at desc);
create index integrations_v1_claim_key on clued_private.integrations_v1(claim_key_sha256) where claim_key_sha256 is not null;
create index integrations_v1_by_superseded_by
  on clued_private.integrations_v1(superseded_by_integration_id) where superseded_by_integration_id is not null;

create table clued_private.integration_identity_snapshots_v1 (
  snapshot_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  owner_id uuid not null,
  tuple jsonb not null,
  tuple_sha256 text not null check (tuple_sha256 ~ '^[0-9a-f]{64}$'),
  claim_key_sha256 text check (claim_key_sha256 is null or claim_key_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_id uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create index integration_identity_snapshots_v1_by_integration
  on clued_private.integration_identity_snapshots_v1(integration_id, created_at desc);

create table clued_private.integration_installation_requests_v1 (
  request_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_key text not null check (char_length(request_key) between 16 and 160),
  intent text not null check (intent in ('create_or_bind','bind_connection','rebind','reauthorization',
    'reinstall','recovery','adapter_migration','verification_repair','restore')),
  target_integration_id uuid references clued_private.integrations_v1(integration_id),
  created_via text not null check (created_via in ('binding','native_session')),
  creator_binding_id uuid,
  request_payload jsonb not null,
  request_payload_sha256 text not null check (request_payload_sha256 ~ '^[0-9a-f]{64}$'),
  source_provenance jsonb not null,
  callback_provenance jsonb,
  request_status text not null default 'OPEN' check (request_status in ('OPEN','BOUND','CLOSED','ARCHIVED','REJECTED')),
  bound_integration_id uuid references clued_private.integrations_v1(integration_id),
  bound_intent_sha256 text check (bound_intent_sha256 is null or bound_intent_sha256 ~ '^[0-9a-f]{64}$'),
  bound_receipt_id uuid,
  version bigint not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (owner_id, request_key),
  check (request_status <> 'BOUND' or bound_integration_id is not null),
  check (request_status not in ('OPEN','REJECTED') or bound_integration_id is null),
  check (intent = 'create_or_bind' or target_integration_id is not null)
);
create index integration_installation_requests_v1_bound
  on clued_private.integration_installation_requests_v1(bound_integration_id) where bound_integration_id is not null;

create table clued_private.integration_claims_v1 (
  claim_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  active_binding_domain text not null,
  claim_key_sha256 text not null check (claim_key_sha256 ~ '^[0-9a-f]{64}$'),
  claim_key_material jsonb not null,
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  claim_status text not null check (claim_status in ('CURRENT','RELEASED','SUPERSEDED')),
  claimed_receipt_id uuid not null,
  ended_receipt_id uuid,
  claimed_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  check ((claim_status = 'CURRENT') = (ended_at is null))
);
create unique index integration_claims_v1_one_current_per_key
  on clued_private.integration_claims_v1(active_binding_domain, claim_key_sha256) where claim_status = 'CURRENT';
create unique index integration_claims_v1_one_current_per_integration
  on clued_private.integration_claims_v1(integration_id) where claim_status = 'CURRENT';

create table clued_private.integration_connections_v1 (
  connection_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  binding_id uuid not null,
  connection_kind text not null check (connection_kind in ('OAUTH_V12','RAW_BINDING')),
  link_status text not null check (link_status in ('CURRENT','HISTORICAL')),
  linked_at timestamptz not null default clock_timestamp(),
  unlinked_at timestamptz,
  scopes_at_link text[] not null,
  provider text not null,
  provider_connection_id text not null,
  link_authority text not null check (link_authority in
    ('CREATE','SELF','SAME_PROVIDER_CONNECTION','NATIVE_BIND_REQUEST','NATIVE_OWNER_CONFIRMED','NATIVE_ADOPT','NATIVE_RESTORE',
     'NATIVE_RECONCILE','OPERATOR_RESTORE')),
  link_receipt_id uuid not null,
  unlink_receipt_id uuid,
  check ((link_status = 'CURRENT') = (unlinked_at is null))
);
create unique index integration_connections_v1_one_current_per_integration
  on clued_private.integration_connections_v1(integration_id) where link_status = 'CURRENT';
create unique index integration_connections_v1_one_current_per_binding
  on clued_private.integration_connections_v1(binding_id) where link_status = 'CURRENT';
create index integration_connections_v1_by_provider_connection
  on clued_private.integration_connections_v1(provider, provider_connection_id);
create index integration_connections_v1_by_integration
  on clued_private.integration_connections_v1(integration_id);

create table clued_private.integration_binding_owners_v1 (
  binding_id uuid primary key,
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  owner_id uuid not null,
  acquired_via text not null check (acquired_via in
    ('FIRST_LINK','NATIVE_OWNER_CONFIRMED','NATIVE_ADOPT','NATIVE_RESTORE','NATIVE_RECONCILE',
     'OPERATOR_RESTORE','REVOCATION_SWEEP')),
  acquired_receipt_id uuid not null,
  acquired_at timestamptz not null default clock_timestamp(),
  version bigint not null default 1
);
create index integration_binding_owners_v1_by_integration
  on clued_private.integration_binding_owners_v1(integration_id);

create table clued_private.integration_binding_ownership_log_v1 (
  transfer_id uuid primary key default gen_random_uuid(),
  binding_id uuid not null,
  from_integration_id uuid,
  to_integration_id uuid not null,
  acquired_via text not null,
  actor_kind text not null check (actor_kind in ('binding','native_session','operator')),
  receipt_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp()
);

-- §5.6 / §5.10: read side only in PR-2 (placement choice (a) above).
create function clued_private.integration_fact_value_valid_v1(p_truth_class text, p_value text, p_mask text[])
returns boolean language sql immutable security invoker set search_path='' as $$
  select case p_truth_class
    when 'environment_state' then p_value in ('AVAILABLE','RESTRICTED','BLOCKED')
    when 'qualification_state' then p_value in ('QUALIFIED','CONDITIONAL','SUSPENDED')
    when 'compatibility_state' then p_value in ('COMPATIBLE','DEGRADED','HARD_INCOMPATIBLE')
    when 'host_state' then p_value in ('AVAILABLE','DEGRADED','HARD_UNAVAILABLE')
    when 'adapter_state' then p_value in ('OK','DEGRADED','BLOCKED')
    else false end
  and (case when p_value in ('RESTRICTED','CONDITIONAL','DEGRADED')
            then p_mask is not null and clued_private.integration_capabilities_valid_v1(p_mask)
            else p_mask is null end)
$$;

create table clued_private.integration_facts_v1 (
  fact_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  truth_class text not null check (truth_class in
    ('environment_state','qualification_state','compatibility_state','host_state','adapter_state')),
  source text not null check (source in ('adapter','operator','policy','server')),
  value text not null,
  capability_mask text[],
  reason text check (reason is null or char_length(reason) between 1 and 500),
  valid_until timestamptz,
  fact_status text not null check (fact_status in ('CURRENT','SUPERSEDED','CLEARED')),
  receipt_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  check (clued_private.integration_fact_value_valid_v1(truth_class, value, capability_mask))
);
create unique index integration_facts_v1_one_current
  on clued_private.integration_facts_v1(integration_id, truth_class, source) where fact_status = 'CURRENT';

create table clued_private.integration_capability_declarations_v1 (
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  declaration_version integer not null check (declaration_version >= 1),
  host_surface text not null,
  declared_capabilities text[] not null check (clued_private.integration_capabilities_valid_v1(declared_capabilities)),
  host_features jsonb not null,
  adapter_family text not null,
  adapter_version text not null,
  package_version text,
  receipt_id uuid not null,
  declared_at timestamptz not null default clock_timestamp(),
  primary key (integration_id, declaration_version)
);

-- §5.7 A-class verification, created read-only here like (a): §7.2 normalization reads it; the verify
-- operation that writes it is PR-3 (placement choice (b)).
create table clued_private.integration_canonical_verifications_v1 (
  verification_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  verification_contract text not null check (verification_contract = 'clued.crv.v1'),
  verification_class text not null default 'CANONICAL_RUNTIME_BASELINE' check (verification_class = 'CANONICAL_RUNTIME_BASELINE'),
  result text not null check (result in ('PASS','FAIL')),
  checks jsonb not null,
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  connection_id uuid not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_id uuid not null,
  verified_at timestamptz not null default clock_timestamp(),
  valid_until timestamptz not null
);
create index integration_canonical_verifications_v1_latest
  on clued_private.integration_canonical_verifications_v1(integration_id, verified_at desc);

-- §5.9: revocation / regrant / reauth marks. PR-2 creates the tables, their immutability triggers and
-- the read helper; the write operations (revoke, restore, reauth_mark / reauth_clear) are PR-4. The
-- only PR-2 writer is §10.1 connection-revoke materialization.
create table clued_private.integration_revocations_v1 (
  revocation_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  revoked_by text not null check (revoked_by in ('USER','USER_VIA_HOST','CLUED','POLICY','SECURITY')),
  reason text not null check (char_length(reason) between 1 and 500),
  revoked_binding_ids uuid[] not null,
  revocation_source text not null default 'INTEGRATION_REVOKE' check (revocation_source in ('INTEGRATION_REVOKE','CONNECTION_REVOKE_ADOPTED')),
  adopted_from jsonb,
  receipt_id uuid not null,
  revoked_at timestamptz not null default clock_timestamp(),
  restored_by_regrant_id uuid,
  extended_receipt_ids uuid[] not null default '{}',
  check ((revocation_source = 'CONNECTION_REVOKE_ADOPTED') = (adopted_from is not null))
);
create unique index integration_revocations_v1_one_open
  on clued_private.integration_revocations_v1(integration_id) where restored_by_regrant_id is null;

create table clued_private.integration_regrants_v1 (
  regrant_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  restore_kind text not null check (restore_kind in ('REVOCATION','FORBIDS_REAUTH_RECOVERY')),
  revocation_id uuid references clued_private.integration_revocations_v1(revocation_id),
  new_binding_id uuid not null,
  new_authorization_request_id uuid,
  new_authorization_created_at timestamptz not null,
  decided_by text not null check (decided_by in ('USER','OPERATOR')),
  receipt_id uuid not null,
  regranted_at timestamptz not null default clock_timestamp(),
  check ((restore_kind = 'REVOCATION') = (revocation_id is not null))
);

create table clued_private.integration_reauth_marks_v1 (
  mark_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  reason text not null check (reason in ('SCOPE_RECONSENT_REQUIRED','PROVIDER_RECONFIRMATION','CREDENTIAL_INVALIDATED',
    'HOST_SESSION_INVALIDATED','POLICY_RECONSENT')),
  raised_by text not null check (raised_by in ('CLUED','POLICY','SECURITY','SERVER')),
  raised_receipt_id uuid not null,
  raised_at timestamptz not null default clock_timestamp(),
  cleared_at timestamptz,
  cleared_by text check (cleared_by is null or cleared_by in ('REAUTHORIZATION_REBIND','OPERATOR','RESTORE')),
  cleared_receipt_id uuid,
  check ((cleared_at is null) = (cleared_receipt_id is null))
);
create index integration_reauth_marks_v1_open
  on clued_private.integration_reauth_marks_v1(integration_id) where cleared_at is null;

create table clued_private.integration_operation_log_v1 (
  operation_id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  actor_kind text not null check (actor_kind in ('binding','native_session','operator','server')),
  actor_binding_id uuid,
  request_id uuid,
  integration_id uuid,
  related_integration_id uuid,
  affected_binding_ids uuid[] not null default '{}',
  operation_type text not null,
  identity_snapshot_id uuid,
  source_provenance jsonb not null,
  callback_provenance jsonb,
  result text not null,
  receipt_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create index integration_operation_log_v1_by_integration
  on clued_private.integration_operation_log_v1(integration_id, recorded_at desc);

create table clued_private.integration_derivation_diagnostics_v1 (
  diagnostic_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null,
  derivation_contract text not null,
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  reason_codes text[] not null check (cardinality(reason_codes) >= 1),
  receipt_id uuid not null,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  occurrences bigint not null default 1,
  unique (integration_id, derivation_contract, facts_sha256)
);

-- ---- immutability triggers ---------------------------------------------------------------------
create function clued_private.integration_append_only_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  raise exception '%', tg_argv[0] using errcode = '55000';
end $$;

create trigger integration_identity_snapshots_v1_append_only
  before update or delete on clued_private.integration_identity_snapshots_v1
  for each row execute function clued_private.integration_append_only_v1('integration_identity_snapshot_immutable');
create trigger integration_binding_ownership_log_v1_append_only
  before update or delete on clued_private.integration_binding_ownership_log_v1
  for each row execute function clued_private.integration_append_only_v1('integration_ownership_log_immutable');
create trigger integration_operation_log_v1_append_only
  before update or delete on clued_private.integration_operation_log_v1
  for each row execute function clued_private.integration_append_only_v1('integration_operation_log_immutable');
create trigger integration_regrants_v1_append_only
  before update or delete on clued_private.integration_regrants_v1
  for each row execute function clued_private.integration_append_only_v1('integration_regrant_immutable');

-- §5.3 rule 2: bound_integration_id changes only null → value, once. request_key, owner, intent, target,
-- payload and its hash never change. DELETE is not refused: the owner_id cascade from auth.users is the
-- only deletion path (§5.2 point 3), and no function here deletes a Request.
create function clued_private.integration_request_bound_immutable_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.bound_integration_id is not null and new.bound_integration_id is distinct from old.bound_integration_id then
    raise exception 'installation_request_bound_immutable' using errcode = '55000';
  end if;
  if (new.owner_id, new.request_key, new.intent, new.target_integration_id, new.created_via, new.creator_binding_id,
      new.request_payload, new.request_payload_sha256, new.source_provenance, new.callback_provenance, new.expires_at,
      new.created_at)
     is distinct from
     (old.owner_id, old.request_key, old.intent, old.target_integration_id, old.created_via, old.creator_binding_id,
      old.request_payload, old.request_payload_sha256, old.source_provenance, old.callback_provenance, old.expires_at,
      old.created_at) then
    raise exception 'installation_request_bound_immutable' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger integration_installation_requests_v1_bound_immutable
  before update on clued_private.integration_installation_requests_v1
  for each row execute function clued_private.integration_request_bound_immutable_v1();

-- §5.9 trigger: exactly two kinds of UPDATE, never combined — (a) restore: restored_by_regrant_id
-- null → value, everything else unchanged; (b) extension: still open before and after,
-- revoked_binding_ids a strict superset, extended_receipt_ids := OLD || {one Receipt}, everything
-- else unchanged. Every other UPDATE and every DELETE is rejected.
create function clued_private.integration_revocation_immutable_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'integration_revocation_immutable' using errcode = '55000';
  end if;
  if (new.revocation_id, new.integration_id, new.revoked_by, new.reason, new.revocation_source, new.adopted_from,
      new.receipt_id, new.revoked_at)
     is distinct from
     (old.revocation_id, old.integration_id, old.revoked_by, old.reason, old.revocation_source, old.adopted_from,
      old.receipt_id, old.revoked_at) then
    raise exception 'integration_revocation_immutable' using errcode = '55000';
  end if;
  if old.restored_by_regrant_id is null and new.restored_by_regrant_id is not null then
    -- (a) restore
    if new.revoked_binding_ids is distinct from old.revoked_binding_ids
       or new.extended_receipt_ids is distinct from old.extended_receipt_ids then
      raise exception 'integration_revocation_immutable' using errcode = '55000';
    end if;
    return new;
  end if;
  if old.restored_by_regrant_id is null and new.restored_by_regrant_id is null then
    -- (b) extension
    if not (new.revoked_binding_ids @> old.revoked_binding_ids)
       or (new.revoked_binding_ids <@ old.revoked_binding_ids)
       or array_position(new.revoked_binding_ids, null) is not null
       or cardinality(new.extended_receipt_ids) <> cardinality(old.extended_receipt_ids) + 1
       or new.extended_receipt_ids[1:cardinality(old.extended_receipt_ids)] is distinct from old.extended_receipt_ids
       or new.extended_receipt_ids[cardinality(new.extended_receipt_ids)] is null then
      raise exception 'integration_revocation_immutable' using errcode = '55000';
    end if;
    return new;
  end if;
  raise exception 'integration_revocation_immutable' using errcode = '55000';
end $$;
create trigger integration_revocations_v1_immutable
  before update or delete on clued_private.integration_revocations_v1
  for each row execute function clued_private.integration_revocation_immutable_v1();

-- Reauth marks: only the clearing transition (cleared_at / cleared_by / cleared_receipt_id null → value).
create function clued_private.integration_reauth_mark_immutable_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'integration_reauth_mark_immutable' using errcode = '55000';
  end if;
  if (new.mark_id, new.integration_id, new.reason, new.raised_by, new.raised_receipt_id, new.raised_at)
     is distinct from (old.mark_id, old.integration_id, old.reason, old.raised_by, old.raised_receipt_id, old.raised_at)
     or old.cleared_at is not null or new.cleared_at is null or new.cleared_by is null then
    raise exception 'integration_reauth_mark_immutable' using errcode = '55000';
  end if;
  return new;
end $$;
create trigger integration_reauth_marks_v1_immutable
  before update or delete on clued_private.integration_reauth_marks_v1
  for each row execute function clued_private.integration_reauth_mark_immutable_v1();

-- ---- §5.4 Claim Store ⇔ identity_claim_state, validated at commit ---------------------------------
-- holder ⇒ exactly one CURRENT claim row of I, whose key and domain are I's; not holder ⇒ no CURRENT
-- claim row of I. Deferred, so a transaction may release and re-claim in any order; a violation rolls
-- the whole transaction back (no observable window, §5.4).
create function clued_private.integration_claim_consistency_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_ids uuid[];
  v_id uuid;
  i clued_private.integrations_v1;
  v_current integer;
  v_matching integer;
begin
  -- a Claim Store DELETE is checked as well (beyond the literal §5.4 "insert or update"): removing a
  -- CURRENT row must not bypass the equality either
  if tg_op = 'DELETE' then
    v_ids := array[old.integration_id];
  elsif tg_table_name = 'integrations_v1' then
    v_ids := array[new.integration_id];
  else
    v_ids := array[new.integration_id];
    if tg_op = 'UPDATE' and old.integration_id is distinct from new.integration_id then
      v_ids := v_ids || old.integration_id;
    end if;
  end if;
  foreach v_id in array v_ids loop
    select * into i from clued_private.integrations_v1 where integration_id = v_id;
    if not found then continue; end if;
    select count(*), count(*) filter (where c.claim_key_sha256 = i.claim_key_sha256
                                        and c.active_binding_domain = i.active_binding_domain)
      into v_current, v_matching
      from clued_private.integration_claims_v1 c
     where c.integration_id = v_id and c.claim_status = 'CURRENT';
    if (i.identity_claim_state = 'CURRENT_CLAIM_HOLDER' and (v_current <> 1 or v_matching <> 1))
       or (i.identity_claim_state <> 'CURRENT_CLAIM_HOLDER' and v_current <> 0) then
      raise exception 'identity_claim_store_divergence' using errcode = '23514', detail = v_id::text;
    end if;
  end loop;
  return null;
end $$;
create constraint trigger integrations_v1_claim_consistency
  after insert or update on clued_private.integrations_v1
  deferrable initially deferred
  for each row execute function clued_private.integration_claim_consistency_v1();
create constraint trigger integration_claims_v1_claim_consistency
  after insert or update or delete on clued_private.integration_claims_v1
  deferrable initially deferred
  for each row execute function clued_private.integration_claim_consistency_v1();

alter table clued_private.integrations_v1 enable row level security;
alter table clued_private.integration_identity_snapshots_v1 enable row level security;
alter table clued_private.integration_installation_requests_v1 enable row level security;
alter table clued_private.integration_claims_v1 enable row level security;
alter table clued_private.integration_connections_v1 enable row level security;
alter table clued_private.integration_binding_owners_v1 enable row level security;
alter table clued_private.integration_binding_ownership_log_v1 enable row level security;
alter table clued_private.integration_facts_v1 enable row level security;
alter table clued_private.integration_capability_declarations_v1 enable row level security;
alter table clued_private.integration_canonical_verifications_v1 enable row level security;
alter table clued_private.integration_revocations_v1 enable row level security;
alter table clued_private.integration_regrants_v1 enable row level security;
alter table clued_private.integration_reauth_marks_v1 enable row level security;
alter table clued_private.integration_operation_log_v1 enable row level security;
alter table clued_private.integration_derivation_diagnostics_v1 enable row level security;
revoke all on table clued_private.integrations_v1, clued_private.integration_identity_snapshots_v1,
  clued_private.integration_installation_requests_v1, clued_private.integration_claims_v1,
  clued_private.integration_connections_v1, clued_private.integration_binding_owners_v1,
  clued_private.integration_binding_ownership_log_v1, clued_private.integration_facts_v1,
  clued_private.integration_capability_declarations_v1, clued_private.integration_revocations_v1,
  clued_private.integration_regrants_v1, clued_private.integration_reauth_marks_v1,
  clued_private.integration_operation_log_v1, clued_private.integration_derivation_diagnostics_v1,
  clued_private.integration_canonical_verifications_v1
  from public, anon, authenticated, service_role;

-- =============================================================================================
-- Part B: identity, authority, revocation helpers; normalization; evaluation; claim core
-- =============================================================================================

create function clued_private.integration_sha256_v1(p_text text)
returns text language sql immutable security invoker set search_path='' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_text, 'UTF8')), 'hex')
$$;

create function clued_private.integration_instant_text_v1(p_at timestamptz)
returns text language sql immutable security invoker set search_path='' as $$
  select pg_catalog.to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- §6.3 claim key material; null when any nullable dimension is UNAVAILABLE (an UNAVAILABLE dimension
-- never takes part in a key through a placeholder). Inputs are the Tuple columns only: no provenance,
-- no weak identifier can reach it (T-A10-3 static part).
create function clued_private.integration_claim_key_material_v1(p_owner uuid, p_host text,
  p_tenant_status text, p_tenant text, p_account_status text, p_account text,
  p_provider text, p_connection_status text, p_connection text, p_domain text)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select case when p_tenant_status = 'UNAVAILABLE' or p_account_status = 'UNAVAILABLE'
                or p_connection_status = 'UNAVAILABLE' then null
         else pg_catalog.jsonb_build_object(
           'schema', 'clued.integration-claim-key.v1',
           'clued_principal_id', p_owner,
           'host', p_host,
           'host_tenant_or_workspace_id', case when p_tenant_status = 'VALUE' then pg_catalog.to_jsonb(p_tenant)
                                               else '{"status":"NOT_APPLICABLE"}'::jsonb end,
           'host_account_id', case when p_account_status = 'VALUE' then pg_catalog.to_jsonb(p_account)
                                   else '{"status":"NOT_APPLICABLE"}'::jsonb end,
           'provider', p_provider,
           'provider_connection_id', case when p_connection_status = 'VALUE' then pg_catalog.to_jsonb(p_connection)
                                          else '{"status":"NOT_APPLICABLE"}'::jsonb end,
           'active_binding_domain', p_domain) end
$$;

create function clued_private.integration_claim_key_v1(p_material jsonb)
returns text language sql immutable security invoker set search_path='' as $$
  select case when p_material is null then null else clued_private.integration_sha256_v1(p_material::text) end
$$;

-- L4: advisory transaction locks for claim keys, taken in (domain, key) order (§6.4).
create function clued_private.integration_claim_lock_id_v1(p_domain text, p_key text)
returns bigint language sql immutable security invoker set search_path='' as $$
  select pg_catalog.hashtextextended('clued.integration.claim:' || p_domain || ':' || p_key, 0)
$$;

create function clued_private.integration_claim_lock_v1(p_pairs text[])
returns void language plpgsql security definer set search_path='' as $$
declare v_pair text;
begin
  -- each element is domain || E'\x1f' || key; sorted and de-duplicated, nulls dropped
  for v_pair in select x from pg_catalog.unnest(p_pairs) x where x is not null group by x order by x collate "C" loop
    perform pg_catalog.pg_advisory_xact_lock(clued_private.integration_claim_lock_id_v1(
      pg_catalog.split_part(v_pair, E'\x1f', 1), pg_catalog.split_part(v_pair, E'\x1f', 2)));
  end loop;
end $$;

create function clued_private.integration_claim_lock_held_v1(p_domain text, p_key text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (select 1 from pg_catalog.pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted
      and l.database = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
      and l.objsubid = 1
      and l.classid::bigint = ((clued_private.integration_claim_lock_id_v1(p_domain, p_key) >> 32) & 4294967295)
      and l.objid::bigint = (clued_private.integration_claim_lock_id_v1(p_domain, p_key) & 4294967295))
$$;

-- Authority of a Binding (§10.3 covers / ceiling): {scopes, entries}. scopes = Binding scopes ∩ the
-- three v12 scopes, sorted; entries = the v12 entries (sorted, actions de-duplicated and sorted) or
-- "LEGACY_UNRESTRICTED" for a raw Binding. The result always satisfies integration_ceiling_valid_v1.
create function clued_private.integration_binding_authority_v1(p_binding_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_scopes text[]; v_entries jsonb;
begin
  select coalesce(array(select s from pg_catalog.unnest(b.scopes) s
                         where s in ('audit:read','context:read','context:write')
                         group by s order by s collate "C"), '{}')
    into v_scopes from public.clued_agent_bindings b where b.id = p_binding_id;
  if not found then return null; end if;
  if exists (select 1 from clued_private.authorizations_v12 a where a.binding_id = p_binding_id) then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'resource_kind', e.resource_kind, 'resource_id', e.resource_id, 'environment', e.environment,
             'actions', (select pg_catalog.to_jsonb(array(select x from pg_catalog.unnest(e.actions) x group by x order by x collate "C"))))
           order by e.resource_kind collate "C", e.resource_id collate "C", e.environment collate "C"), '[]'::jsonb)
      into v_entries from clued_private.authorization_entries_v12 e where e.binding_id = p_binding_id;
  else
    v_entries := '"LEGACY_UNRESTRICTED"'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('scopes', pg_catalog.to_jsonb(v_scopes), 'entries', v_entries);
end $$;

-- §6.2: the server-derived identity of a Binding. provider_connection_id is never taken from the
-- caller. OAuth v12 (issuance 'oauth'): clued.oauth.v12 / sha256(client_id). Raw Binding, and headless
-- issuance (placement choice (d)): clued.binding.v1 / binding_id. connection_kind follows where the
-- authorization lives: authorizations_v12 → OAUTH_V12, none → RAW_BINDING.
create function clued_private.integration_binding_identity_v1(p_binding_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare b public.clued_agent_bindings; a clued_private.authorizations_v12; v_has_a boolean;
  v_expires timestamptz; v_account_ok boolean; v_provider text; v_pcid text;
begin
  select * into b from public.clued_agent_bindings where id = p_binding_id;
  if not found then return null; end if;
  select * into a from clued_private.authorizations_v12 where binding_id = p_binding_id;
  v_has_a := found;
  v_expires := (pg_catalog.to_jsonb(b)->>'expires_at')::timestamptz;
  select exists (select 1 from auth.users u where u.id = b.user_id
                   and (pg_catalog.to_jsonb(u)->>'deleted_at') is null
                   and not coalesce((pg_catalog.to_jsonb(u)->>'banned_until')::timestamptz > pg_catalog.clock_timestamp(), false))
    into v_account_ok;
  if v_has_a and a.issuance = 'oauth' then
    v_provider := 'clued.oauth.v12';
    v_pcid := clued_private.integration_sha256_v1(a.client_id);
  else
    v_provider := 'clued.binding.v1';
    v_pcid := b.id::text;
  end if;
  return pg_catalog.jsonb_build_object(
    'binding_id', b.id, 'user_id', b.user_id, 'provider', v_provider, 'provider_connection_id', v_pcid,
    'connection_kind', case when v_has_a then 'OAUTH_V12' else 'RAW_BINDING' end,
    'issuance', case when v_has_a then a.issuance end,
    'scopes', pg_catalog.to_jsonb(b.scopes),
    'authority', clued_private.integration_binding_authority_v1(b.id),
    'authorization_created_at', case when v_has_a then a.created_at else b.created_at end,
    'authorization_request_id', case when v_has_a then a.request_id end,
    'p5', pg_catalog.to_jsonb(b)->>'organization_id' is not null,   -- column absent where P5 is not installed
    'revoked', b.revoked_at is not null or (v_has_a and a.revoked_at is not null),
    'live', b.revoked_at is null and (v_expires is null or v_expires > pg_catalog.clock_timestamp()) and v_account_ok
            and (not v_has_a or (a.revoked_at is null and a.expires_at > pg_catalog.clock_timestamp())),
    'auth_usable', b.revoked_at is null and (v_expires is null or v_expires > pg_catalog.clock_timestamp())
            and (not v_has_a or (a.revoked_at is null and a.expires_at > pg_catalog.clock_timestamp())));
end $$;

-- §10.3 covers(C, A) and C ∩ A over ceiling-shaped values.
create function clued_private.integration_covers_v1(p_ceiling jsonb, p_authority jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v_entry jsonb;
begin
  if p_ceiling is null or p_authority is null then return false; end if;
  if not ((p_authority->'scopes') <@ (p_ceiling->'scopes')) then return false; end if;
  if p_ceiling->'entries' = '"LEGACY_UNRESTRICTED"'::jsonb then return true; end if;
  if p_authority->'entries' = '"LEGACY_UNRESTRICTED"'::jsonb then return false; end if;
  for v_entry in select e from pg_catalog.jsonb_array_elements(p_authority->'entries') e loop
    if not exists (select 1 from pg_catalog.jsonb_array_elements(p_ceiling->'entries') c
                    where c->>'resource_kind' = v_entry->>'resource_kind' and c->>'resource_id' = v_entry->>'resource_id'
                      and c->>'environment' = v_entry->>'environment' and (v_entry->'actions') <@ (c->'actions')) then
      return false;
    end if;
  end loop;
  return true;
end $$;

create function clued_private.integration_ceiling_intersect_v1(p_left jsonb, p_right jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v_scopes jsonb; v_entries jsonb;
begin
  v_scopes := (select coalesce(pg_catalog.jsonb_agg(s order by s collate "C"), '[]'::jsonb)
                 from (select pg_catalog.jsonb_array_elements_text(p_left->'scopes') s
                       intersect select pg_catalog.jsonb_array_elements_text(p_right->'scopes')) t);
  if p_left->'entries' = '"LEGACY_UNRESTRICTED"'::jsonb then
    v_entries := p_right->'entries';
  elsif p_right->'entries' = '"LEGACY_UNRESTRICTED"'::jsonb then
    v_entries := p_left->'entries';
  else
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('resource_kind', k, 'resource_id', r,
             'environment', env, 'actions', acts) order by k collate "C", r collate "C", env collate "C"), '[]'::jsonb)
      into v_entries
      from (select l->>'resource_kind' k, l->>'resource_id' r, l->>'environment' env,
                   (select pg_catalog.jsonb_agg(x order by x collate "C") from
                     (select pg_catalog.jsonb_array_elements_text(l->'actions') x
                      intersect select pg_catalog.jsonb_array_elements_text(rr->'actions')) i) acts
              from pg_catalog.jsonb_array_elements(p_left->'entries') l
              join pg_catalog.jsonb_array_elements(p_right->'entries') rr
                on rr->>'resource_kind' = l->>'resource_kind' and rr->>'resource_id' = l->>'resource_id'
               and rr->>'environment' = l->>'environment') t
     where acts is not null;
  end if;
  return pg_catalog.jsonb_build_object('scopes', v_scopes, 'entries', v_entries);
end $$;

-- §10.3 C_eff(T) (v0.1.2 MINOR-N7, v0.1.3 MINOR-N11): the ceiling lowered by every v12 reduce made
-- after the ceiling was set while the reduced Binding was T's CURRENT connection.
-- Returns {ceiling, latest_reduce_at}; ceiling is null when T has none.
create function clued_private.integration_ceiling_eff_v1(p_integration_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare i clued_private.integrations_v1; v_ceiling jsonb; v_latest timestamptz; v_binding uuid;
begin
  select * into i from clued_private.integrations_v1 where integration_id = p_integration_id;
  if not found or i.authorization_ceiling is null then
    return pg_catalog.jsonb_build_object('ceiling', null, 'latest_reduce_at', null);
  end if;
  v_ceiling := i.authorization_ceiling;
  for v_binding in
    select distinct r.binding_id from clued_private.authorization_audit_v12 r
      join clued_private.integration_connections_v1 c on c.binding_id = r.binding_id and c.integration_id = i.integration_id
     where r.operation = 'reduce' and r.recorded_at > i.authorization_ceiling_set_at
       and c.linked_at <= r.recorded_at and r.recorded_at < coalesce(c.unlinked_at, 'infinity'::timestamptz)
     order by r.binding_id loop
    v_ceiling := clued_private.integration_ceiling_intersect_v1(v_ceiling,
      coalesce(clued_private.integration_binding_authority_v1(v_binding), '{"scopes":[],"entries":[]}'::jsonb));
  end loop;
  select max(r.recorded_at) into v_latest from clued_private.authorization_audit_v12 r
    join clued_private.integration_connections_v1 c on c.binding_id = r.binding_id and c.integration_id = i.integration_id
   where r.operation = 'reduce' and r.recorded_at > i.authorization_ceiling_set_at
     and c.linked_at <= r.recorded_at and r.recorded_at < coalesce(c.unlinked_at, 'infinity'::timestamptz);
  return pg_catalog.jsonb_build_object('ceiling', v_ceiling, 'latest_reduce_at', v_latest);
end $$;

-- §10.3 fresh_consent(b, T): b's v12 grant (consent page, issuance 'oauth') was created after both the
-- ceiling was set and the latest counted reduce.
create function clued_private.integration_fresh_consent_v1(p_binding_id uuid, p_integration_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare i clued_private.integrations_v1; a clued_private.authorizations_v12; v_eff jsonb;
begin
  select * into i from clued_private.integrations_v1 where integration_id = p_integration_id;
  select * into a from clued_private.authorizations_v12 where binding_id = p_binding_id;
  if not found or a.issuance <> 'oauth' or i.authorization_ceiling_set_at is null then return false; end if;
  v_eff := clued_private.integration_ceiling_eff_v1(p_integration_id);
  return a.created_at > greatest(i.authorization_ceiling_set_at,
    coalesce((v_eff->>'latest_reduce_at')::timestamptz, i.authorization_ceiling_set_at));
end $$;

-- §5.9 / §7.2 revocation status, shared by normalization and every write-path guard (v0.1.2 MINOR-N8):
-- INTEGRATION (an open revocation row), CONNECTION_USER_REVOKE (OQ-2 interim rule: a CURRENT
-- connection's Binding is revoked or its row is missing), or NOT_REVOKED.
create function clued_private.integration_revocation_status_v1(p_integration_id uuid)
returns text language sql stable security definer set search_path='' as $$
  select case
    when exists (select 1 from clued_private.integration_revocations_v1 r
                  where r.integration_id = p_integration_id and r.restored_by_regrant_id is null) then 'INTEGRATION'
    when exists (select 1 from clued_private.integration_connections_v1 c
                   left join public.clued_agent_bindings b on b.id = c.binding_id
                  where c.integration_id = p_integration_id and c.link_status = 'CURRENT'
                    and (b.id is null or b.revoked_at is not null)) then 'CONNECTION_USER_REVOKE'
    else 'NOT_REVOKED' end
$$;

-- §10.1 integration_connection_revoke_adoption_v1: provenance of the adopted connection revoke,
-- identical at every materialization site (v0.1.3 MINOR-N10). Null when there is no revoked CURRENT
-- connection.
create function clued_private.integration_connection_revoke_adoption_v1(p_integration_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c clued_private.integration_connections_v1; v_binding_revoked_at timestamptz; v_binding_found boolean;
  v_audit clued_private.authorization_audit_v12; v_audit_found boolean; v_receipt uuid; v_by text;
begin
  select cc.* into c from clued_private.integration_connections_v1 cc
    left join public.clued_agent_bindings b on b.id = cc.binding_id
   where cc.integration_id = p_integration_id and cc.link_status = 'CURRENT' and (b.id is null or b.revoked_at is not null)
   order by cc.linked_at desc, cc.connection_id limit 1;
  if not found then return null; end if;
  select b.revoked_at, true into v_binding_revoked_at, v_binding_found from public.clued_agent_bindings b where b.id = c.binding_id;
  select * into v_audit from clued_private.authorization_audit_v12 x
   where x.binding_id = c.binding_id and x.operation in ('revoke','revoke_issuer','revoke_self','revoke_integration')
   order by x.recorded_at desc, x.id desc limit 1;
  v_audit_found := found;
  if v_audit_found and v_audit.operation = 'revoke_integration' then
    select o.receipt_id into v_receipt from clued_private.integration_operation_log_v1 o
     where o.operation_type = 'PARTIAL_REVOKE' and c.binding_id = any(o.affected_binding_ids)
     order by o.recorded_at desc limit 1;
  end if;
  v_by := case when not v_audit_found then 'USER'
               when v_audit.operation = 'revoke' then 'USER'
               else 'USER_VIA_HOST' end;
  return pg_catalog.jsonb_build_object(
    'binding_id', c.binding_id,
    'audit_operation', case when v_audit_found then v_audit.operation end,
    'audit_id', case when v_audit_found then v_audit.id end,
    'revoking_receipt_id', v_receipt,
    'connection_revoked_by', v_by,
    'connection_revoked_at', coalesce(case when v_audit_found then v_audit.recorded_at end, v_binding_revoked_at));
end $$;

-- §5.5 O7 rev_at(X): the open row's revoked_at; for a derived revoke the value a materialization would
-- write (connection_revoked_at, else the caller's call timestamp — v0.1.7 NIT-2, v0.1.8 NIT-1).
create function clued_private.integration_rev_at_v1(p_integration_id uuid, p_call_at timestamptz)
returns timestamptz language plpgsql stable security definer set search_path='' as $$
declare v_at timestamptz; v_status text;
begin
  select r.revoked_at into v_at from clued_private.integration_revocations_v1 r
   where r.integration_id = p_integration_id and r.restored_by_regrant_id is null;
  if found then return v_at; end if;
  v_status := clued_private.integration_revocation_status_v1(p_integration_id);
  if v_status = 'CONNECTION_USER_REVOKE' then
    return coalesce((clued_private.integration_connection_revoke_adoption_v1(p_integration_id)->>'connection_revoked_at')::timestamptz,
                    p_call_at);
  end if;
  return null;
end $$;

-- §10.1 materialization: a successful write holding L5 on I first turns a derived connection revoke
-- into I's revocation row (one row, CONNECTION_REVOKE_ADOPTED). Returns the new row id or null.
create function clued_private.integration_materialize_connection_revoke_v1(p_integration_id uuid,
  p_receipt_id uuid, p_call_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_adopted jsonb; v_id uuid;
begin
  if clued_private.integration_revocation_status_v1(p_integration_id) <> 'CONNECTION_USER_REVOKE' then
    return null;
  end if;
  v_adopted := clued_private.integration_connection_revoke_adoption_v1(p_integration_id);
  insert into clued_private.integration_revocations_v1(integration_id, revoked_by, reason, revoked_binding_ids,
    revocation_source, adopted_from, receipt_id, revoked_at)
  values (p_integration_id, v_adopted->>'connection_revoked_by', 'connection revoke adopted (§10.1)',
    array[(v_adopted->>'binding_id')::uuid], 'CONNECTION_REVOKE_ADOPTED', v_adopted, p_receipt_id,
    coalesce((v_adopted->>'connection_revoked_at')::timestamptz, p_call_at))
  returning revocation_id into v_id;
  return v_id;
end $$;

-- §5.5 O5 Lin*(I): the (provider, provider_connection_id) snapshots of every connection row of I and of
-- every Integration superseded into I (recursively, set semantics, no depth limit — v0.1.8 MINOR-N28),
-- restricted to providers whose connection source is the OAuth v12 client id.
create function clued_private.integration_lineage_v1(p_integration_id uuid)
returns table (provider text, provider_connection_id text)
language sql stable security definer set search_path='' as $$
  with recursive tree(integration_id) as (
    select p_integration_id
    union
    select i.integration_id from clued_private.integrations_v1 i join tree t on i.superseded_by_integration_id = t.integration_id
  )
  select distinct c.provider, c.provider_connection_id
    from clued_private.integration_connections_v1 c
    join tree t on t.integration_id = c.integration_id
    join clued_private.integration_providers_v1 p on p.provider = c.provider
   where p.connection_source = 'OAUTH_V12_CLIENT_ID_SHA256'
$$;

-- §5.5 O7 / §10.3 step 6': an unowned Binding whose grant is not later than the revocation instant of
-- an Integration X (same owner, historical = NONE, revoked, derived(b) ∈ Lin*(X)) cannot link or create.
create function clued_private.integration_binding_predates_revocation_v1(p_identity jsonb, p_call_at timestamptz)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_x uuid; v_rev_at timestamptz;
begin
  if p_identity is null or not exists (select 1 from clued_private.integration_providers_v1 p
                                        where p.provider = p_identity->>'provider'
                                          and p.connection_source = 'OAUTH_V12_CLIENT_ID_SHA256') then
    return false;
  end if;
  for v_x in
    with recursive chain(integration_id) as (
      select distinct c.integration_id from clued_private.integration_connections_v1 c
        join clued_private.integrations_v1 y on y.integration_id = c.integration_id
       where c.provider = p_identity->>'provider' and c.provider_connection_id = p_identity->>'provider_connection_id'
         and y.owner_id = (p_identity->>'user_id')::uuid
      union
      select i.superseded_by_integration_id from clued_private.integrations_v1 i join chain ch on i.integration_id = ch.integration_id
       where i.superseded_by_integration_id is not null
    )
    select x.integration_id from chain ch join clued_private.integrations_v1 x on x.integration_id = ch.integration_id
     where x.historical = 'NONE' and x.owner_id = (p_identity->>'user_id')::uuid
     order by x.integration_id loop
    if clued_private.integration_revocation_status_v1(v_x) <> 'NOT_REVOKED' then
      v_rev_at := clued_private.integration_rev_at_v1(v_x, p_call_at);
      if (p_identity->>'authorization_created_at')::timestamptz <= v_rev_at then return true; end if;
    end if;
  end loop;
  return false;
end $$;

-- §5.6 lattice merge of reported facts: the most restrictive value wins; masks of the winning masked
-- value are intersected. p_rank lists the class's values from least to most restrictive.
create function clued_private.integration_lattice_merge_v1(p_rank text[], p_default text, p_facts jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v_value text := p_default; v_fact jsonb; v_mask text[]; v_first boolean := true;
begin
  for v_fact in select f from pg_catalog.jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) f loop
    if pg_catalog.array_position(p_rank, v_fact->>'value') > pg_catalog.array_position(p_rank, v_value) then
      v_value := v_fact->>'value';
    end if;
  end loop;
  if v_value in ('RESTRICTED','CONDITIONAL','DEGRADED') then
    for v_fact in select f from pg_catalog.jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) f
                   where f->>'value' = v_value loop
      if v_first then
        v_mask := array(select pg_catalog.jsonb_array_elements_text(v_fact->'mask'));
        v_first := false;
      else
        v_mask := array(select x from pg_catalog.unnest(v_mask) x
                        intersect select pg_catalog.jsonb_array_elements_text(v_fact->'mask'));
      end if;
    end loop;
    v_mask := array(select x from pg_catalog.unnest(coalesce(v_mask, '{}'::text[])) x group by x order by x collate "C");
    return pg_catalog.jsonb_build_object('value', v_value, 'mask', pg_catalog.to_jsonb(v_mask));
  end if;
  return pg_catalog.jsonb_build_object('value', v_value, 'mask', null);
end $$;

-- §7.4 subject digest: canonical_json is jsonb::text (§6.2). host_surface is the latest declaration's
-- (null before the first declaration); derivation_contract is the PR-1 contract.
create function clued_private.integration_subject_digest_v1(p_integration_id uuid)
returns text language sql stable security definer set search_path='' as $$
  select clued_private.integration_sha256_v1(pg_catalog.jsonb_build_object(
    'integration_id', i.integration_id,
    'current_connection_id', c.connection_id,
    'binding_id', c.binding_id,
    'adapter_family', i.adapter_family, 'adapter_version', i.adapter_version, 'package_version', i.package_version,
    'claim_key_sha256', i.claim_key_sha256,
    'host_surface', (select d.host_surface from clued_private.integration_capability_declarations_v1 d
                      where d.integration_id = i.integration_id order by d.declaration_version desc limit 1),
    'derivation_contract', 'clued.integration-derivation.v1')::text)
    from clued_private.integrations_v1 i
    left join clued_private.integration_connections_v1 c
      on c.integration_id = i.integration_id and c.link_status = 'CURRENT'
   where i.integration_id = p_integration_id
$$;

-- canonical_runtime_verification_facts (§7.2 table): the latest A-class row at as_of. No row → NONE;
-- FAIL → FAILED; subject digest differs → INVALIDATED; valid_until <= as_of → EXPIRED; else VALID.
create function clued_private.integration_crv_facts_v1(p_integration_id uuid, p_as_of timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v clued_private.integration_canonical_verifications_v1;
begin
  select * into v from clued_private.integration_canonical_verifications_v1
   where integration_id = p_integration_id and verified_at <= p_as_of
   order by verified_at desc, verification_id desc limit 1;
  if not found then
    return '{"status":"NONE","verification_id":null,"valid_until":null}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('status', case
      when v.result = 'FAIL' then 'FAILED'
      when v.subject_digest is distinct from clued_private.integration_subject_digest_v1(p_integration_id) then 'INVALIDATED'
      when v.valid_until <= p_as_of then 'EXPIRED'
      else 'VALID' end,
    'verification_id', v.verification_id,
    'valid_until', clued_private.integration_instant_text_v1(v.valid_until));
end $$;

-- §7.1 / §7.2 normalization with its read provenance: {facts, sources_read}. Never reads READY tables.
create function clued_private.integration_normalize_detail_v1(p_integration_id uuid, p_as_of timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  i clued_private.integrations_v1; pol clued_private.integration_policy_v1;
  c clued_private.integration_connections_v1; v_has_c boolean := false; v_current_count integer;
  b public.clued_agent_bindings; v_has_b boolean := false; v_b_expires timestamptz;
  a clued_private.authorizations_v12; v_has_a boolean := false;
  v_identity_state text := 'VALID'; v_claim_store text; v_connection_store text;
  v_authn text; v_authz text; v_marks integer; v_scopes text[] := '{}'; v_dropped text[] := '{}';
  v_resource jsonb; v_caps text[]; v_rule clued_private.integration_compatibility_rules_v1; v_rule_found boolean;
  v_compat_rule_value jsonb; v_facts_by_class jsonb := '{}'; v_class text;
  v_surface text; v_ceiling text[]; v_declared text[]; v_declaration clued_private.integration_capability_declarations_v1;
  v_has_decl boolean := false; v_host jsonb; v_universe text[]; v_facts jsonb; v_claim_ids uuid[];
  v_fact_ids uuid[]; v_mark_ids uuid[]; v_revocation text; v_open_revocation uuid; v_user jsonb; v_below boolean;
  v_count integer; v_matching integer;
begin
  select * into i from clued_private.integrations_v1 where integration_id = p_integration_id;
  if not found then raise exception 'integration_not_found' using errcode = 'P0002'; end if;
  select * into pol from clued_private.integration_policy_v1 where policy_version = i.policy_version;

  -- identity_state: the account (as authorization_account_v12) and the current connection's owner
  select pg_catalog.to_jsonb(u) into v_user from auth.users u where u.id = i.owner_id;
  if v_user is null or v_user->>'deleted_at' is not null
     or coalesce((v_user->>'banned_until')::timestamptz > p_as_of, false) then
    v_identity_state := 'INVALID';
  end if;

  select count(*) into v_current_count from clued_private.integration_connections_v1
   where integration_id = i.integration_id and link_status = 'CURRENT';
  select * into c from clued_private.integration_connections_v1
   where integration_id = i.integration_id and link_status = 'CURRENT'
   order by linked_at desc, connection_id limit 1;
  v_has_c := found;
  if v_has_c then
    select * into b from public.clued_agent_bindings where id = c.binding_id;
    v_has_b := found;
    if v_has_b then
      v_b_expires := (pg_catalog.to_jsonb(b)->>'expires_at')::timestamptz;
      if b.user_id <> i.owner_id then v_identity_state := 'INVALID'; end if;
    end if;
    select * into a from clued_private.authorizations_v12 where binding_id = c.binding_id;
    v_has_a := found;
  end if;

  -- claim_store (§7.2): holder ⇒ one CURRENT row with I's key and domain; otherwise none
  select count(*), count(*) filter (where cl.claim_key_sha256 = i.claim_key_sha256
                                      and cl.active_binding_domain = i.active_binding_domain),
         coalesce(array_agg(cl.claim_id order by cl.claim_id), '{}')
    into v_count, v_matching, v_claim_ids
    from clued_private.integration_claims_v1 cl where cl.integration_id = i.integration_id and cl.claim_status = 'CURRENT';
  if i.identity_claim_state = 'CURRENT_CLAIM_HOLDER' then
    v_claim_store := case when v_count = 0 then 'MISSING_CURRENT_ROW'
                          when v_count <> 1 or v_matching <> 1 then 'KEY_MISMATCH' else 'CONSISTENT' end;
  else
    v_claim_store := case when v_count > 0 then 'UNEXPECTED_CURRENT_ROW' else 'CONSISTENT' end;
  end if;

  -- connection_store (ERRATA-001 carrier of C7)
  if v_current_count > 1 then
    v_connection_store := 'MULTIPLE_CURRENT';
  elsif exists (select 1 from clued_private.integration_connections_v1 x join public.clued_agent_bindings xb on xb.id = x.binding_id
                 where x.integration_id = i.integration_id and xb.user_id <> i.owner_id)
     or exists (select 1 from clued_private.integration_binding_owners_v1 o join public.clued_agent_bindings ob on ob.id = o.binding_id
                 where o.integration_id = i.integration_id and (ob.user_id <> i.owner_id or o.owner_id <> i.owner_id)) then
    v_connection_store := 'FOREIGN_BINDING';
  elsif v_has_c and not exists (select 1 from clued_private.integration_binding_owners_v1 o where o.binding_id = c.binding_id) then
    v_connection_store := 'OWNER_ROW_MISSING';
  elsif v_has_c and exists (select 1 from clued_private.integration_binding_owners_v1 o
                             where o.binding_id = c.binding_id and o.integration_id <> i.integration_id) then
    v_connection_store := 'OWNER_MISMATCH';
  else
    v_connection_store := 'CONSISTENT';
  end if;

  -- authentication / authorization (§7.2, by connection_kind)
  if not v_has_c then
    v_authn := 'NONE'; v_authz := 'NOT_GRANTED';
  else
    if not v_has_b or b.revoked_at is not null then v_authn := 'INVALIDATED';
    elsif (v_b_expires is not null and v_b_expires <= p_as_of) or (v_has_a and a.expires_at <= p_as_of) then v_authn := 'EXPIRED';
    else v_authn := 'USABLE'; end if;
    if c.connection_kind = 'RAW_BINDING' then v_authz := 'GRANTED_LEGACY';
    elsif not v_has_a or a.revoked_at is not null then v_authz := 'REVOKED_CONNECTION';
    elsif a.expires_at <= p_as_of then v_authz := 'EXPIRED';
    else v_authz := 'GRANTED'; end if;
  end if;

  select count(*), coalesce(array_agg(m.mark_id order by m.mark_id), '{}') into v_marks, v_mark_ids
    from clued_private.integration_reauth_marks_v1 m where m.integration_id = i.integration_id and m.cleared_at is null;

  -- oauth_scope_facts: current Binding scopes ∩ the three v12 scopes; other names dropped (MINOR-1)
  if v_has_c and v_has_b then
    v_scopes := array(select s from pg_catalog.unnest(b.scopes) s
                       where s in ('audit:read','context:read','context:write') group by s order by s collate "C");
    v_dropped := array(select s from pg_catalog.unnest(b.scopes) s
                        where s not in ('audit:read','context:read','context:write') group by s order by s collate "C");
  end if;

  -- resource_action_scope_facts (§7.2, §9.1)
  if not v_has_c then
    v_resource := '{"mode":"NONE"}';
  elsif c.connection_kind = 'RAW_BINDING' then
    v_resource := '{"mode":"LEGACY_UNRESTRICTED"}';
  elsif not v_has_a then
    v_resource := '{"mode":"NONE"}';
  else
    v_caps := array(select cap from (values ('audit.read','audit'), ('context.read','read'), ('context.write','write'),
        ('development_history.read','read'), ('evidence.write','write'), ('project.read','read'), ('project.write','write')) m(cap, act)
      where exists (select 1 from clued_private.authorization_entries_v12 e where e.binding_id = c.binding_id and m.act = any(e.actions))
        and (cap <> 'development_history.read' or exists (select 1 from clued_private.authorization_entries_v12 e
              where e.binding_id = c.binding_id and e.resource_kind = 'context' and 'read' = any(e.actions)))
        and (cap not in ('project.read','project.write') or exists (select 1 from clued_private.authorization_entries_v12 e
              where e.binding_id = c.binding_id and e.resource_kind = 'scope' and e.resource_id like 'project:%'))
      order by cap collate "C");
    v_resource := pg_catalog.jsonb_build_object('mode', 'ENTRIES', 'capabilities', pg_catalog.to_jsonb(v_caps));
  end if;

  -- reported facts (§5.6), current and not past valid_until
  select coalesce(array_agg(f.fact_id order by f.fact_id), '{}') into v_fact_ids from clued_private.integration_facts_v1 f
   where f.integration_id = i.integration_id and f.fact_status = 'CURRENT' and (f.valid_until is null or f.valid_until > p_as_of);
  for v_class in select unnest(array['environment_state','qualification_state','compatibility_state','host_state','adapter_state']) loop
    v_facts_by_class := v_facts_by_class || pg_catalog.jsonb_build_object(v_class, coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('value', f.value, 'mask', pg_catalog.to_jsonb(f.capability_mask))
                                  order by f.fact_id)
        from clued_private.integration_facts_v1 f
       where f.integration_id = i.integration_id and f.truth_class = v_class and f.fact_status = 'CURRENT'
         and (f.valid_until is null or f.valid_until > p_as_of)), '[]'::jsonb));
  end loop;

  -- compatibility rules: latest registry_version for (host, adapter_family); below minimum fails closed
  select * into v_rule from clued_private.integration_compatibility_rules_v1 r
   where r.host = i.host and r.adapter_family = i.adapter_family order by r.registry_version desc limit 1;
  v_rule_found := found;
  if v_rule_found then
    v_below := (v_rule.min_adapter_version is not null
                and coalesce(clued_private.integration_version_cmp_v1(i.adapter_version, v_rule.min_adapter_version), -1) < 0)
            or (v_rule.min_package_version is not null
                and coalesce(clued_private.integration_version_cmp_v1(i.package_version, v_rule.min_package_version), -1) < 0);
    if v_below then
      v_facts_by_class := pg_catalog.jsonb_set(v_facts_by_class, '{compatibility_state}',
        (v_facts_by_class->'compatibility_state') || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'value', v_rule.below_minimum, 'mask', pg_catalog.to_jsonb(v_rule.degraded_mask))));
    end if;
  end if;

  -- host_state: the latest declaration's surface (else the most recent bound Request's surface);
  -- surface_ceiling from the registry, declared = latest declaration or the ceiling (Preserve, OQ-10)
  select * into v_declaration from clued_private.integration_capability_declarations_v1 d
   where d.integration_id = i.integration_id order by d.declaration_version desc limit 1;
  v_has_decl := found;
  if v_has_decl then
    v_surface := v_declaration.host_surface;
  else
    select r.request_payload->>'host_surface' into v_surface from clued_private.integration_installation_requests_v1 r
     where r.bound_integration_id = i.integration_id and r.request_status = 'BOUND'
     order by r.created_at desc, r.request_id limit 1;
  end if;
  select coalesce(array(select x from pg_catalog.unnest(s.capability_ceiling) x group by x order by x collate "C"), '{}')
    into v_ceiling from clued_private.integration_host_surfaces_v1 s where s.host = i.host and s.surface = v_surface;
  v_ceiling := coalesce(v_ceiling, '{}');
  v_declared := case when v_has_decl
    then array(select x from pg_catalog.unnest(v_declaration.declared_capabilities) x group by x order by x collate "C")
    else v_ceiling end;
  v_host := clued_private.integration_lattice_merge_v1(array['AVAILABLE','DEGRADED','HARD_UNAVAILABLE'], 'AVAILABLE',
              v_facts_by_class->'host_state')
            || pg_catalog.jsonb_build_object('surface_ceiling', pg_catalog.to_jsonb(v_ceiling),
                                             'declared', pg_catalog.to_jsonb(v_declared));

  v_revocation := clued_private.integration_revocation_status_v1(i.integration_id);
  select r.revocation_id into v_open_revocation from clued_private.integration_revocations_v1 r
   where r.integration_id = i.integration_id and r.restored_by_regrant_id is null;
  v_universe := array(select capability from clued_private.integration_capability_vocabulary_v1 order by capability collate "C");

  v_facts := pg_catalog.jsonb_build_object(
    'schema', 'clued.integration-facts.v1',
    'derivation_contract', 'clued.integration-derivation.v1',
    'as_of', clued_private.integration_instant_text_v1(p_as_of),
    'policy', pg_catalog.jsonb_build_object('policy_version', pol.policy_version,
      'incomplete_identity_ordinary_runtime', pol.incomplete_identity_ordinary_runtime,
      'qualification_not_evaluated', pol.qualification_not_evaluated, 'preclusion_rule', pol.preclusion_rule),
    'capability_universe', pg_catalog.to_jsonb(v_universe),
    'identity_state', v_identity_state,
    'identity_completeness', i.identity_completeness,
    'identity_claim_state', i.identity_claim_state,
    'claim_store', v_claim_store,
    'connection_store', v_connection_store,
    'authentication_state', v_authn,
    'authorization_state', v_authz,
    'reauth_marks_open', v_marks,
    'oauth_scope_facts', pg_catalog.to_jsonb(v_scopes),
    'resource_action_scope_facts', v_resource,
    'environment_state', clued_private.integration_lattice_merge_v1(array['AVAILABLE','RESTRICTED','BLOCKED'], 'AVAILABLE',
                           v_facts_by_class->'environment_state'),
    'qualification_state', clued_private.integration_lattice_merge_v1(array['QUALIFIED','NOT_EVALUATED','CONDITIONAL','SUSPENDED'],
                           case when pg_catalog.jsonb_array_length(v_facts_by_class->'qualification_state') = 0 then 'NOT_EVALUATED'
                                else 'QUALIFIED' end, v_facts_by_class->'qualification_state'),
    'compatibility_state', clued_private.integration_lattice_merge_v1(array['COMPATIBLE','DEGRADED','HARD_INCOMPATIBLE'], 'COMPATIBLE',
                           v_facts_by_class->'compatibility_state'),
    'revocation_state', case when v_revocation = 'NOT_REVOKED' then 'NOT_REVOKED' else 'REVOKED' end,
    'revocation_source', case v_revocation when 'NOT_REVOKED' then 'NONE' else v_revocation end,
    'host_state', v_host,
    'adapter_state', clued_private.integration_lattice_merge_v1(array['OK','DEGRADED','BLOCKED'], 'OK',
                           v_facts_by_class->'adapter_state'),
    'lifecycle_facts', pg_catalog.jsonb_build_object('ordinary_runtime', i.ordinary_runtime, 'historical', i.historical,
      'recovery_policy', i.recovery_policy, 'first_authorization_required', i.first_authorization_required),
    'installation_facts', pg_catalog.jsonb_build_object('install_status', i.install_status,
      'ever_authorized', i.first_authorized_at is not null),
    'canonical_runtime_verification_facts', clued_private.integration_crv_facts_v1(i.integration_id, p_as_of));

  return pg_catalog.jsonb_build_object('facts', v_facts, 'sources_read', pg_catalog.jsonb_build_object(
    'integration', pg_catalog.jsonb_build_object('id', i.integration_id, 'version', i.version),
    'policy_version', pol.policy_version,
    'connection', case when v_has_c then pg_catalog.jsonb_build_object('id', c.connection_id, 'binding_id', c.binding_id,
                    'connection_kind', c.connection_kind) end,
    'authorization_version', case when v_has_a then a.version end,
    'claim_ids', pg_catalog.to_jsonb(v_claim_ids),
    'fact_ids', pg_catalog.to_jsonb(v_fact_ids),
    'reauth_mark_ids', pg_catalog.to_jsonb(v_mark_ids),
    'open_revocation_id', v_open_revocation,
    'declaration_version', case when v_has_decl then v_declaration.declaration_version end,
    'host_surface', v_surface,
    'compatibility_rule', case when v_rule_found then pg_catalog.jsonb_build_object('host', v_rule.host,
                            'adapter_family', v_rule.adapter_family, 'registry_version', v_rule.registry_version) end,
    'dropped_scopes', pg_catalog.to_jsonb(v_dropped)));
end $$;

create function clued_private.integration_normalize_v1(p_integration_id uuid, p_as_of timestamptz)
returns jsonb language sql stable security definer set search_path='' as $$
  select clued_private.integration_normalize_detail_v1(p_integration_id, p_as_of)->'facts'
$$;

-- §8.2 evaluate = derive(normalize) + facts; DERIVATION_INPUT_INVALID upserts the diagnostic and, on the
-- first occurrence of (integration, contract, facts_sha256), writes one integration_derivation_invalid
-- Receipt (§7.3). Volatile because of those writes.
create function clued_private.integration_evaluate_v1(p_integration_id uuid,
  p_as_of timestamptz default pg_catalog.clock_timestamp())
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_detail jsonb; v_result jsonb; v_owner uuid; v_receipt public.clued_audit_receipts; v_input jsonb;
  v_diag uuid;
begin
  v_detail := clued_private.integration_normalize_detail_v1(p_integration_id, p_as_of);
  v_result := clued_private.integration_derive_v1(v_detail->'facts');
  if not (v_result->>'valid')::boolean then
    -- serialize first occurrence per (Integration, facts) so concurrent evaluations never race on the
    -- diagnostic Receipt's idempotency key
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'clued.integration.diagnostic:' || p_integration_id || ':' || (v_result->>'facts_sha256'), 0));
    update clued_private.integration_derivation_diagnostics_v1
       set occurrences = occurrences + 1, last_seen_at = pg_catalog.clock_timestamp()
     where integration_id = p_integration_id and derivation_contract = v_result->>'derivation_contract'
       and facts_sha256 = v_result->>'facts_sha256'
    returning diagnostic_id into v_diag;
    if v_diag is null then
      select owner_id into v_owner from clued_private.integrations_v1 where integration_id = p_integration_id;
      v_input := pg_catalog.jsonb_build_object('idempotency_key', 'diag:' || p_integration_id || ':' || (v_result->>'facts_sha256'),
        'integration_id', p_integration_id, 'derivation_contract', v_result->>'derivation_contract',
        'facts_sha256', v_result->>'facts_sha256', 'reason_codes', v_result->'reason_codes');
      v_receipt := clued_private.m1_begin_receipt(v_owner, null, 'integration_derivation_invalid', v_input,
        clued_private.integration_sha256_v1(pg_catalog.jsonb_build_object('operation', 'integration_derivation_invalid',
          'payload', v_input)::text));
      if v_receipt.status = 'pending' then
        perform clued_private.m1_finish_receipt(v_receipt.id, 'committed',
          pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', p_integration_id)),
          '{}', '{}', '{}', '{}', null);
        update public.clued_audit_receipts set metadata = pg_catalog.jsonb_build_object('supplemental',
          pg_catalog.jsonb_build_object('integration_id', p_integration_id, 'facts_sha256', v_result->>'facts_sha256',
            'reason_codes', v_result->'reason_codes')) where id = v_receipt.id;
      end if;
      insert into clued_private.integration_derivation_diagnostics_v1(integration_id, derivation_contract, facts_sha256,
        reason_codes, receipt_id)
      values (p_integration_id, v_result->>'derivation_contract', v_result->>'facts_sha256',
        array(select pg_catalog.jsonb_array_elements_text(v_result->'reason_codes')), v_receipt.id)
      on conflict (integration_id, derivation_contract, facts_sha256) do update
        set occurrences = clued_private.integration_derivation_diagnostics_v1.occurrences + 1,
            last_seen_at = pg_catalog.clock_timestamp();
    end if;
  end if;
  return v_result || pg_catalog.jsonb_build_object('facts', v_detail->'facts', 'sources_read', v_detail->'sources_read');
end $$;

-- §6.1 / §6.2 one nullable dimension (tenant or account) from a submitted {status, value?, evidence_kind?}.
-- NOT_APPLICABLE only from the registry; weak evidence kinds are refused; a kind the registry does not
-- accept leaves the dimension UNAVAILABLE (its value only reaches source_provenance). p_current is the
-- Integration's present {status, value} used when nothing is submitted (REBIND_CLASS / identity_update).
create function clued_private.integration_resolve_dimension_v1(p_registry_dimension text, p_accepted_kinds text[],
  p_submitted jsonb, p_current jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v_status text; v_kind text;
begin
  if p_registry_dimension = 'NOT_APPLICABLE' then
    if p_submitted is not null and p_submitted <> 'null'::jsonb
       and coalesce(p_submitted->>'status', 'NOT_APPLICABLE') <> 'NOT_APPLICABLE' then
      raise exception 'identity_dimension_not_applicable_mismatch' using errcode = '42501';
    end if;
    return '{"status":"NOT_APPLICABLE","value":null}'::jsonb;
  end if;
  if p_submitted is null or p_submitted = 'null'::jsonb then
    return coalesce(p_current, '{"status":"UNAVAILABLE","value":null}'::jsonb);
  end if;
  if pg_catalog.jsonb_typeof(p_submitted) <> 'object' then
    raise exception 'invalid_identity_dimension' using errcode = '22023';
  end if;
  v_status := p_submitted->>'status';
  v_kind := p_submitted->>'evidence_kind';
  if v_status = 'NOT_APPLICABLE' then
    raise exception 'identity_dimension_not_applicable_mismatch' using errcode = '42501';
  elsif v_status = 'UNAVAILABLE' then
    return '{"status":"UNAVAILABLE","value":null}'::jsonb;
  elsif v_status = 'VALUE' then
    if v_kind in ('EMAIL','DISPLAY_NAME','HOST_UI_LABEL','VENDOR_LABEL','AGENT_NAME','CLIENT_NAME','UNVERIFIED_HOST_ASSERTION') then
      raise exception 'identity_weak_identifier_forbidden' using errcode = '42501';
    end if;
    if pg_catalog.jsonb_typeof(p_submitted->'value') <> 'string'
       or pg_catalog.char_length(p_submitted->>'value') not between 1 and 255 then
      raise exception 'invalid_identity_dimension' using errcode = '22023';
    end if;
    if v_kind is not null and v_kind = any(p_accepted_kinds) then
      return pg_catalog.jsonb_build_object('status', 'VALUE', 'value', p_submitted->>'value');
    end if;
    return '{"status":"UNAVAILABLE","value":null}'::jsonb;
  end if;
  raise exception 'invalid_identity_dimension' using errcode = '22023';
end $$;

-- §6.4 claim core (integration_claim_core_v1). The caller has done pre-1…pre-5: L4 for the old and
-- new key and L5 on I are held. p_identity carries the resulting Tuple (tenant / account / connection
-- statuses and values, provider, domain); the core writes the Tuple, the key and the claim state in
-- one UPDATE (the §5.2 CHECKs hold after every statement) and the Claim Store rows; the deferred
-- trigger validates both at commit. Returns the resulting identity_claim_state.
create function clued_private.integration_claim_core_v1(p_integration_id uuid, p_identity jsonb, p_receipt_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare i clued_private.integrations_v1; v_material jsonb; v_key text; v_domain text; v_holder uuid;
  v_state text; v_conflicting uuid; v_attempt integer := 0; v_complete boolean;
begin
  select * into i from clued_private.integrations_v1 where integration_id = p_integration_id for update;
  v_domain := coalesce(p_identity->>'domain', i.active_binding_domain);
  v_material := clued_private.integration_claim_key_material_v1(i.owner_id, i.host,
    p_identity->>'tenant_status', p_identity->>'tenant', p_identity->>'account_status', p_identity->>'account',
    coalesce(p_identity->>'provider', i.provider), p_identity->>'connection_status', p_identity->>'connection', v_domain);
  v_key := clued_private.integration_claim_key_v1(v_material);
  v_complete := v_key is not null;

  if v_key is null then
    -- step 1: identity incomplete — release I's CURRENT claim, INCOMPLETE_UNCLAIMED
    update clued_private.integration_claims_v1 set claim_status = 'RELEASED', ended_at = pg_catalog.clock_timestamp(),
      ended_receipt_id = p_receipt_id where integration_id = i.integration_id and claim_status = 'CURRENT';
    v_state := 'INCOMPLETE_UNCLAIMED'; v_conflicting := null;
  else
    -- step 2: L4 for the new key (and the old one, if different) must already be held
    if not clued_private.integration_claim_lock_held_v1(v_domain, v_key)
       or (i.claim_key_sha256 is not null and not clued_private.integration_claim_lock_held_v1(i.active_binding_domain, i.claim_key_sha256)) then
      raise exception 'integration_claim_lock_not_held' using errcode = 'XX000';
    end if;
    loop
      v_attempt := v_attempt + 1;
      select c.integration_id into v_holder from clued_private.integration_claims_v1 c
       where c.active_binding_domain = v_domain and c.claim_key_sha256 = v_key and c.claim_status = 'CURRENT';
      begin
        if v_holder is null then
          update clued_private.integration_claims_v1 set claim_status = 'RELEASED', ended_at = pg_catalog.clock_timestamp(),
            ended_receipt_id = p_receipt_id where integration_id = i.integration_id and claim_status = 'CURRENT';
          insert into clued_private.integration_claims_v1(owner_id, active_binding_domain, claim_key_sha256, claim_key_material,
            integration_id, claim_status, claimed_receipt_id)
          values (i.owner_id, v_domain, v_key, v_material, i.integration_id, 'CURRENT', p_receipt_id);
          v_state := 'CURRENT_CLAIM_HOLDER'; v_conflicting := null;
        elsif v_holder = i.integration_id then
          v_state := 'CURRENT_CLAIM_HOLDER'; v_conflicting := null;   -- idempotent
        else
          update clued_private.integration_claims_v1 set claim_status = 'RELEASED', ended_at = pg_catalog.clock_timestamp(),
            ended_receipt_id = p_receipt_id where integration_id = i.integration_id and claim_status = 'CURRENT';
          v_state := 'CLAIM_CONFLICT';   -- §6.4 step 4, also when I was PENDING_RECONCILE
          v_conflicting := v_holder;
        end if;
        exit;
      exception when unique_violation then
        if v_attempt >= 2 then
          raise exception 'identity_claim_retry_exhausted' using errcode = '40001';
        end if;
      end;
    end loop;
  end if;

  update clued_private.integrations_v1 set
    tenant_status = p_identity->>'tenant_status', host_tenant_or_workspace_id = p_identity->>'tenant',
    account_status = p_identity->>'account_status', host_account_id = p_identity->>'account',
    provider = coalesce(p_identity->>'provider', provider),
    connection_status = p_identity->>'connection_status', provider_connection_id = p_identity->>'connection',
    active_binding_domain = v_domain,
    identity_completeness = case when v_complete then 'COMPLETE' else 'INCOMPLETE' end,
    claim_key_sha256 = v_key, identity_claim_state = v_state, conflicting_integration_id = v_conflicting
  where integration_id = i.integration_id;
  return v_state;
end $$;

-- The Tuple of an Integration as the claim core consumes it.
create function clued_private.integration_identity_of_v1(p_integration_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select pg_catalog.jsonb_build_object('tenant_status', tenant_status, 'tenant', host_tenant_or_workspace_id,
    'account_status', account_status, 'account', host_account_id, 'provider', provider,
    'connection_status', connection_status, 'connection', provider_connection_id, 'domain', active_binding_domain)
  from clued_private.integrations_v1 where integration_id = p_integration_id
$$;

-- Ends a write on I: new identity snapshot, version + 1, last Receipt. Returns the new version.
create function clued_private.integration_touch_v1(p_integration_id uuid, p_receipt_id uuid, p_evidence jsonb)
returns bigint language plpgsql security definer set search_path='' as $$
declare i clued_private.integrations_v1; v_tuple jsonb; v_snapshot uuid := gen_random_uuid(); v_version bigint;
begin
  select * into i from clued_private.integrations_v1 where integration_id = p_integration_id for update;
  v_tuple := pg_catalog.jsonb_build_object(
    'clued_principal_id', i.owner_id, 'host', i.host, 'provider', i.provider,
    'host_tenant_or_workspace_id', pg_catalog.jsonb_build_object('status', i.tenant_status, 'value', i.host_tenant_or_workspace_id),
    'host_account_id', pg_catalog.jsonb_build_object('status', i.account_status, 'value', i.host_account_id),
    'provider_connection_id', pg_catalog.jsonb_build_object('status', i.connection_status, 'value', i.provider_connection_id),
    'active_binding_domain', i.active_binding_domain, 'identity_completeness', i.identity_completeness,
    'identity_claim_state', i.identity_claim_state, 'claim_key_sha256', i.claim_key_sha256,
    'evidence', coalesce(p_evidence, '{}'::jsonb));
  insert into clued_private.integration_identity_snapshots_v1(snapshot_id, integration_id, owner_id, tuple, tuple_sha256,
    claim_key_sha256, receipt_id)
  values (v_snapshot, i.integration_id, i.owner_id, v_tuple, clued_private.integration_sha256_v1(v_tuple::text),
    i.claim_key_sha256, p_receipt_id);
  update clued_private.integrations_v1 set current_identity_snapshot_id = v_snapshot, version = version + 1,
    last_receipt_id = p_receipt_id, updated_at = pg_catalog.clock_timestamp()
  where integration_id = i.integration_id returning version into v_version;
  return v_version;
end $$;

-- §5.5 O1 / O4: first ownership or transfer of one Binding to I (the caller holds L1 on the Binding and
-- its owner row). Returns the ownership_transfer record for a transfer, {first_ownership} for a first
-- ownership, null when I already owns it.
create function clued_private.integration_take_ownership_v1(p_binding_id uuid, p_integration_id uuid, p_owner uuid,
  p_acquired_via text, p_actor_kind text, p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o clued_private.integration_binding_owners_v1;
begin
  select * into o from clued_private.integration_binding_owners_v1 where binding_id = p_binding_id for update;
  if not found then
    insert into clued_private.integration_binding_owners_v1(binding_id, integration_id, owner_id, acquired_via, acquired_receipt_id)
    values (p_binding_id, p_integration_id, p_owner, p_acquired_via, p_receipt_id);
    insert into clued_private.integration_binding_ownership_log_v1(binding_id, from_integration_id, to_integration_id,
      acquired_via, actor_kind, receipt_id)
    values (p_binding_id, null, p_integration_id, p_acquired_via, p_actor_kind, p_receipt_id);
    return pg_catalog.jsonb_build_object('first_ownership', true, 'binding_id', p_binding_id,
      'to_integration_id', p_integration_id, 'acquired_via', p_acquired_via);
  end if;
  if o.integration_id = p_integration_id then return null; end if;
  update clued_private.integration_binding_owners_v1 set integration_id = p_integration_id, acquired_via = p_acquired_via,
    acquired_receipt_id = p_receipt_id, acquired_at = pg_catalog.clock_timestamp(), version = version + 1
  where binding_id = p_binding_id;
  insert into clued_private.integration_binding_ownership_log_v1(binding_id, from_integration_id, to_integration_id,
    acquired_via, actor_kind, receipt_id)
  values (p_binding_id, o.integration_id, p_integration_id, p_acquired_via, p_actor_kind, p_receipt_id);
  return pg_catalog.jsonb_build_object('binding_id', p_binding_id, 'from_integration_id', o.integration_id,
    'to_integration_id', p_integration_id, 'acquired_via', p_acquired_via);
end $$;

create function clued_private.integration_log_v1(p_owner uuid, p_actor jsonb, p_request_id uuid, p_integration_id uuid,
  p_related uuid, p_operation_type text, p_source jsonb, p_callback jsonb, p_result text, p_receipt_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  insert into clued_private.integration_operation_log_v1(owner_id, actor_kind, actor_binding_id, request_id, integration_id,
    related_integration_id, operation_type, identity_snapshot_id, source_provenance, callback_provenance, result, receipt_id)
  values (p_owner, p_actor->>'kind', (p_actor->>'binding_id')::uuid, p_request_id, p_integration_id, p_related,
    p_operation_type,
    (select current_identity_snapshot_id from clued_private.integrations_v1 where integration_id = p_integration_id),
    coalesce(p_source, '{}'::jsonb), p_callback, p_result, p_receipt_id)
  returning operation_id into v_id;
  return v_id;
end $$;

-- §10.1 post-write validity gate: reject only when R1 ≠ ∅ ∧ R1 ⊄ R0.
create function clued_private.integration_gate_violated_v1(p_r0 jsonb, p_r1 jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
  select pg_catalog.jsonb_array_length(coalesce(p_r1, '[]'::jsonb)) > 0 and not (coalesce(p_r1, '[]'::jsonb) <@ coalesce(p_r0, '[]'::jsonb))
$$;

-- Ends a Receipt: finish the M1 Receipt, store supplemental in the Receipt metadata (so an idempotent
-- replay returns it), and return the envelope. event_ids are always empty (OQ-15, choice (c)).
create function clued_private.integration_finish_v1(p_receipt_id uuid, p_status text, p_target_refs jsonb,
  p_committed jsonb, p_error text, p_supplemental jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_refs jsonb := coalesce(p_target_refs, '[]'::jsonb);
begin
  if p_status <> 'committed' then
    -- a rejected write rolled its subtransaction back: never name an Integration it created
    select coalesce(pg_catalog.jsonb_agg(x order by n), '[]'::jsonb) into v_refs
      from pg_catalog.jsonb_array_elements(v_refs) with ordinality e(x, n)
     where x->>'kind' <> 'integration'
        or exists (select 1 from clued_private.integrations_v1 i where i.integration_id::text = x->>'id');
  end if;
  v_result := clued_private.m1_finish_receipt(p_receipt_id, p_status, v_refs, '{}',
    coalesce(p_committed, '{}'::jsonb), '{}', '{}', p_error);
  update public.clued_audit_receipts set metadata = pg_catalog.jsonb_build_object('supplemental', coalesce(p_supplemental, '{}'::jsonb))
   where id = p_receipt_id;
  return v_result || pg_catalog.jsonb_build_object('replayed', false, 'supplemental', coalesce(p_supplemental, '{}'::jsonb));
end $$;

create function clued_private.integration_replay_v1(p_receipt public.clued_audit_receipts)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(p_receipt.canonical_result, clued_private.m1_result_envelope(p_receipt))
         || pg_catalog.jsonb_build_object('replayed', true, 'supplemental', coalesce(p_receipt.metadata->'supplemental', '{}'::jsonb))
$$;

create function clued_private.integration_rejected_status_v1(p_sqlstate text)
returns text language sql immutable security invoker set search_path='' as $$
  select case when p_sqlstate in ('22023','23505','40001','42501','P0002','55000') then 'rejected' else 'failed' end
$$;

-- =============================================================================================
-- Part C: operations (§10)
-- =============================================================================================

-- §10.1 L1 for a set of Bindings: each Binding row FOR UPDATE immediately followed by its owner row,
-- in id order (§5.5 O6), then their authorizations_v12 rows (L2), also in id order.
create function clued_private.integration_lock_bindings_v1(p_ids uuid[])
returns void language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  for v_id in select distinct x from pg_catalog.unnest(p_ids) x where x is not null order by x loop
    perform 1 from public.clued_agent_bindings where id = v_id for update;
    perform 1 from clued_private.integration_binding_owners_v1 where binding_id = v_id for update;
  end loop;
  for v_id in select distinct x from pg_catalog.unnest(p_ids) x where x is not null order by x loop
    perform 1 from clued_private.authorizations_v12 where binding_id = v_id for update;
  end loop;
end $$;

-- §10.1 Binding-channel authentication (v0.1.4 MINOR-N13): never resolve_binding; one unlocked lookup
-- by token hash, then one FOR UPDATE pass over the caller and p_extra (L1, owner rows, L2), then the
-- caller is re-checked under the lock. Read operations take one FOR SHARE on the caller instead.
-- Every failure is binding_not_authorized (42501), before any Receipt.
create function clued_private.integration_auth_binding_v1(p_token_hash text, p_extra uuid[], p_for_update boolean)
returns public.clued_agent_bindings language plpgsql security definer set search_path='' as $$
declare v_id uuid; b public.clued_agent_bindings; a clued_private.authorizations_v12; v_expires timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'binding_not_authorized' using errcode = '42501';
  end if;
  select id into v_id from public.clued_agent_bindings where token_hash = p_token_hash;
  if not found then raise exception 'binding_not_authorized' using errcode = '42501'; end if;
  if p_for_update then
    perform clued_private.integration_lock_bindings_v1(array[v_id] || coalesce(p_extra, '{}'::uuid[]));
    select * into b from public.clued_agent_bindings where id = v_id;
  else
    select * into b from public.clued_agent_bindings where id = v_id for share;
  end if;
  v_expires := (pg_catalog.to_jsonb(b)->>'expires_at')::timestamptz;
  if b.token_hash is distinct from p_token_hash or b.revoked_at is not null
     or (v_expires is not null and v_expires <= pg_catalog.clock_timestamp()) then
    raise exception 'binding_not_authorized' using errcode = '42501';
  end if;
  begin
    perform clued_private.authorization_account_v12(b.user_id);
  exception when insufficient_privilege then
    raise exception 'binding_not_authorized' using errcode = '42501';
  end;
  select * into a from clued_private.authorizations_v12 where binding_id = b.id;
  if found and (a.revoked_at is not null or a.expires_at <= pg_catalog.clock_timestamp()) then
    raise exception 'binding_not_authorized' using errcode = '42501';
  end if;
  return b;
end $$;

-- The CURRENT connection Binding of I (or null).
create function clued_private.integration_current_binding_v1(p_integration_id uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select c.binding_id from clued_private.integration_connections_v1 c
   where c.integration_id = p_integration_id and c.link_status = 'CURRENT'
   order by c.linked_at desc, c.connection_id limit 1
$$;

-- §10.2 Installation Request open. No Receipt (the Request is transient and carries its own
-- provenance). Same request_key + same payload → the existing request_id; different payload →
-- installation_request_key_conflict.
create function clued_private.integration_request_open_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_key text := p_input->>'request_key'; v_intent text := pg_catalog.lower(p_input->>'intent');
  v_target uuid; h clued_private.integration_hosts_v1; v_payload jsonb; v_sha text; v_native boolean;
  v_provider text; r clued_private.integration_installation_requests_v1; v_ttl interval; v_phase text;
begin
  v_native := p_actor->>'kind' = 'native_session';
  if pg_catalog.jsonb_typeof(p_input) is distinct from 'object' or v_key is null
     or pg_catalog.char_length(v_key) not between 16 and 160 then
    raise exception 'invalid_request_key' using errcode = '22023';
  end if;
  if v_intent is null or v_intent not in ('create_or_bind','bind_connection','rebind','reauthorization','reinstall',
      'recovery','adapter_migration','verification_repair') then
    -- 'restore' Requests belong to PR-4's restore path
    raise exception 'invalid_request_intent' using errcode = '22023';
  end if;
  if v_intent <> 'create_or_bind' then
    begin
      v_target := (p_input->>'target_integration_id')::uuid;
    exception when others then
      raise exception 'invalid_target_integration_id' using errcode = '22023';
    end;
    if v_target is null then raise exception 'invalid_target_integration_id' using errcode = '22023'; end if;
    if not exists (select 1 from clued_private.integrations_v1 where integration_id = v_target and owner_id = p_owner) then
      raise exception 'integration_not_owned' using errcode = '42501';
    end if;
  elsif p_input ? 'target_integration_id' and p_input->'target_integration_id' <> 'null'::jsonb then
    raise exception 'invalid_target_integration_id' using errcode = '22023';
  end if;
  select * into h from clued_private.integration_hosts_v1 where host = p_input->>'host';
  if not found then raise exception 'host_not_registered' using errcode = '42501'; end if;
  if not exists (select 1 from clued_private.integration_host_surfaces_v1 s
                  where s.host = h.host and s.surface = p_input->>'host_surface') then
    raise exception 'host_surface_not_registered' using errcode = '42501';
  end if;
  -- Native create_or_bind names its provider (v0.1.1 MINOR-9); a Binding's provider is derived at bind
  -- (adopt_binding's internal Request derives it from the adopted Binding; p_actor is server-built)
  if v_native and v_intent = 'create_or_bind' and coalesce(p_actor->>'internal_adopt', 'false') <> 'true' then
    v_provider := p_input->>'provider';
    if v_provider is null or not exists (select 1 from clued_private.integration_providers_v1 where provider = v_provider) then
      raise exception 'provider_not_registered' using errcode = '42501';
    end if;
  end if;
  if pg_catalog.char_length(coalesce(p_input->>'adapter_family', '')) not between 1 and 80
     or pg_catalog.char_length(coalesce(p_input->>'adapter_version', '')) not between 1 and 40
     or (p_input ? 'package_version' and p_input->'package_version' <> 'null'::jsonb
         and pg_catalog.char_length(coalesce(p_input->>'package_version', '')) not between 1 and 40) then
    raise exception 'invalid_adapter_version' using errcode = '22023';
  end if;
  v_phase := coalesce(p_input->>'installation_phase', 'STARTED');
  if v_phase not in ('STARTED','COMPLETED') then raise exception 'invalid_installation_phase' using errcode = '22023'; end if;
  if (p_input ? 'source_provenance' and pg_catalog.jsonb_typeof(p_input->'source_provenance') <> 'object')
     or (p_input ? 'callback_provenance' and p_input->'callback_provenance' <> 'null'::jsonb
         and pg_catalog.jsonb_typeof(p_input->'callback_provenance') <> 'object') then
    raise exception 'invalid_provenance' using errcode = '22023';
  end if;
  if p_input ? 'expected_provider_connection_id' and p_input->'expected_provider_connection_id' <> 'null'::jsonb then
    if not (v_native and v_intent = 'bind_connection')
       or pg_catalog.jsonb_typeof(p_input->'expected_provider_connection_id') <> 'string' then
      raise exception 'invalid_expected_provider_connection_id' using errcode = '22023';
    end if;
  end if;
  -- weak identifiers and NOT_APPLICABLE mismatches are refused at open as well as at bind
  perform clued_private.integration_resolve_dimension_v1(h.tenant_dimension, h.tenant_evidence_kinds, p_input->'tenant', null);
  perform clued_private.integration_resolve_dimension_v1(h.account_dimension, h.account_evidence_kinds, p_input->'account', null);

  v_payload := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'intent', v_intent, 'target_integration_id', v_target, 'host', h.host, 'host_surface', p_input->>'host_surface',
    'provider', v_provider, 'tenant', p_input->'tenant', 'account', p_input->'account',
    'provider_connection_id', p_input->'provider_connection_id',
    'adapter_family', p_input->>'adapter_family', 'adapter_version', p_input->>'adapter_version',
    'package_version', p_input->'package_version', 'installation_phase', v_phase,
    'expected_provider_connection_id', p_input->'expected_provider_connection_id',
    'source_provenance', coalesce(p_input->'source_provenance', '{}'::jsonb),
    'callback_provenance', p_input->'callback_provenance'));
  v_sha := clued_private.integration_sha256_v1(v_payload::text);
  select installation_request_ttl into v_ttl from clued_private.integration_policy_v1 order by policy_version desc limit 1;

  insert into clued_private.integration_installation_requests_v1(owner_id, request_key, intent, target_integration_id,
    created_via, creator_binding_id, request_payload, request_payload_sha256, source_provenance, callback_provenance, expires_at)
  values (p_owner, v_key, v_intent, v_target, case when v_native then 'native_session' else 'binding' end,
    (p_actor->>'binding_id')::uuid, v_payload, v_sha, coalesce(p_input->'source_provenance', '{}'::jsonb),
    case when p_input->'callback_provenance' = 'null'::jsonb then null else p_input->'callback_provenance' end,
    pg_catalog.clock_timestamp() + v_ttl)
  on conflict (owner_id, request_key) do nothing
  returning * into r;
  if not found then
    select * into r from clued_private.integration_installation_requests_v1 where owner_id = p_owner and request_key = v_key;
    -- a replay is the same caller: the channel and the creating Binding are part of the Request
    if r.request_payload_sha256 <> v_sha or r.created_via <> (p_actor->>'kind')
       or r.creator_binding_id is distinct from (p_actor->>'binding_id')::uuid then
      raise exception 'installation_request_key_conflict' using errcode = '42501';
    end if;
    return pg_catalog.jsonb_build_object('request_id', r.request_id, 'replayed', true, 'intent', r.intent,
      'request_status', case when r.request_status = 'OPEN' and r.expires_at <= pg_catalog.clock_timestamp() then 'EXPIRED'
                             else r.request_status end, 'expires_at', r.expires_at);
  end if;
  return pg_catalog.jsonb_build_object('request_id', r.request_id, 'replayed', false, 'intent', r.intent,
    'request_status', r.request_status, 'expires_at', r.expires_at);
end $$;

-- §10.3 create-or-bind core, shared by the Binding channel (p_mode BINDING: the caller is the
-- connection), Native create_or_bind (NATIVE_CREATE: no connection), confirm_rebind (CONFIRM_REBIND:
-- the named Binding, NATIVE_OWNER_CONFIRMED) and adopt_binding (ADOPT: the named Binding, NATIVE_ADOPT).
-- Authentication, the Request-owner check and L1 (+ L2) on the connection Binding are done by the
-- caller before this function begins the Receipt (§10.1 MINOR-4 / MINOR-N13).
create function clued_private.integration_bind_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb, p_mode text,
  p_connection_binding uuid, p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_family text := case when p_mode = 'ADOPT' then 'integration_adopt_binding' else 'integration_create_or_bind' end;
  v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  v_rebind_class constant text[] := array['REBIND','REAUTHORIZATION','REINSTALL','RECOVERY','ADAPTER_MIGRATION',
    'VERIFICATION_REPAIR','BIND_CONNECTION'];
  r clued_private.integration_installation_requests_v1; v_request_id uuid; v_intent text; v_bound_sha text;
  v_conn jsonb; o clued_private.integration_binding_owners_v1; v_has_o boolean := false;
  h clued_private.integration_hosts_v1; p clued_private.integration_providers_v1;
  t0 clued_private.integrations_v1; t clued_private.integrations_v1; v_has_t boolean := false;
  v_provider text; v_conn_status text; v_pcid text; v_tenant jsonb; v_account jsonb; v_domain text;
  v_identity jsonb; v_key text; v_holder uuid; v_outcome text; v_downgrade boolean := false;
  e0 jsonb; e1 jsonb; v_r0 jsonb := '[]'; v_link_authority text; ref clued_private.integration_connections_v1;
  v_has_ref boolean := false; cur clued_private.integration_connections_v1; v_has_cur boolean := false;
  v_eff jsonb; v_fresh boolean := false; v_expanded boolean := false; v_authority jsonb; v_transfer boolean := false;
  v_transfer_rec jsonb; v_ceiling_before jsonb; v_ceiling_after jsonb; v_ceiling_set_at timestamptz;
  v_flags text[] := '{}'; v_cleared uuid[] := '{}'; v_state text; v_version bigint; v_target_refs jsonb := '[]';
  v_supp jsonb := '{}'; v_error text; v_sqlstate text; pol clued_private.integration_policy_v1;
  v_payload jsonb; v_open jsonb; v_new_id uuid; v_new_connection boolean := false; v_op_type text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, (p_actor->>'binding_id')::uuid, v_family, p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    if p_mode = 'ADOPT' then
      -- §10.14: an internal create_or_bind Request opened in the Native session
      v_open := clued_private.integration_request_open_core_v1(p_actor || '{"internal_adopt":true}'::jsonb, p_owner,
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'request_key', 'adopt:' || clued_private.integration_sha256_v1(p_connection_binding::text || ':' || (p_input->>'idempotency_key')),
          'intent', 'create_or_bind', 'host', p_input->>'host', 'host_surface', p_input->>'host_surface',
          'tenant', p_input->'tenant', 'account', p_input->'account',
          'adapter_family', p_input->>'adapter_family', 'adapter_version', p_input->>'adapter_version',
          'package_version', p_input->'package_version', 'installation_phase', p_input->>'installation_phase',
          'source_provenance', pg_catalog.jsonb_build_object('adopt_binding', p_connection_binding)
            || coalesce(p_input->'source_provenance', '{}'::jsonb))));
      v_request_id := (v_open->>'request_id')::uuid;
    else
      begin
        v_request_id := (p_input->>'request_id')::uuid;
      exception when others then
        raise exception 'invalid_request_id' using errcode = '22023';
      end;
    end if;

    -- step 2: L3 and the Request decisions, in the v0.1.1 NIT-1 order
    select * into r from clued_private.integration_installation_requests_v1
     where request_id = v_request_id and owner_id = p_owner for update;
    if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    v_intent := case when p_mode in ('CONFIRM_REBIND','ADOPT') then pg_catalog.upper(r.intent)
                     else pg_catalog.upper(p_input->>'binding_intent') end;
    if v_intent is null or v_intent not in ('CREATE_OR_BIND','BIND_CONNECTION','REBIND','REAUTHORIZATION','REINSTALL',
        'RECOVERY','ADAPTER_MIGRATION','VERIFICATION_REPAIR') then
      raise exception 'invalid_binding_intent' using errcode = '22023';
    end if;
    v_bound_sha := clued_private.integration_sha256_v1(pg_catalog.jsonb_build_object('binding_intent', v_intent,
      'request_id', r.request_id, 'connection_binding_id', p_connection_binding)::text);
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'request',
      'kind', 'integration_installation_request', 'id', r.request_id));
    if r.request_status = 'BOUND' then
      if r.bound_intent_sha256 = v_bound_sha then
        v_supp := pg_catalog.jsonb_build_object('integration_id', r.bound_integration_id, 'request_replayed', true,
          'outcome', (select o2.result from clued_private.integration_operation_log_v1 o2
                       where o2.receipt_id = r.bound_receipt_id and o2.request_id = r.request_id
                       order by o2.recorded_at limit 1));
        return clued_private.integration_finish_v1(v_receipt.id, 'committed',
          pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration',
            'id', r.bound_integration_id)) || v_target_refs, '{}', null, v_supp);
      end if;
      raise exception 'installation_request_bound_to_other_integration' using errcode = '42501';
    end if;
    if r.request_status in ('CLOSED','ARCHIVED','REJECTED') then
      raise exception 'installation_request_closed' using errcode = '42501';
    end if;
    if r.expires_at <= v_call_at then raise exception 'installation_request_expired' using errcode = '42501'; end if;
    if pg_catalog.lower(v_intent) <> r.intent
       or (p_mode = 'CONFIRM_REBIND' and v_intent <> all(v_rebind_class))
       or (p_mode in ('NATIVE_CREATE','ADOPT') and v_intent <> 'CREATE_OR_BIND') then
      raise exception 'installation_request_intent_mismatch' using errcode = '42501';
    end if;
    v_payload := r.request_payload;
    select * into h from clued_private.integration_hosts_v1 where host = v_payload->>'host';

    -- steps 3–4: the resulting Tuple; the connection identity is derived by the server (§6.2)
    if p_connection_binding is not null then
      v_conn := clued_private.integration_binding_identity_v1(p_connection_binding);
      if v_conn is null or not (v_conn->>'live')::boolean or (v_conn->>'p5')::boolean
         or (v_conn->>'user_id')::uuid <> p_owner then
        raise exception 'binding_not_adoptable' using errcode = '42501';
      end if;
      if v_payload ? 'provider_connection_id'
         and v_payload->>'provider_connection_id' is distinct from v_conn->>'provider_connection_id' then
        raise exception 'identity_dimension_evidence_unverified' using errcode = '42501';
      end if;
      v_provider := v_conn->>'provider'; v_conn_status := 'VALUE'; v_pcid := v_conn->>'provider_connection_id';
      v_authority := v_conn->'authority';
      select * into o from clued_private.integration_binding_owners_v1 where binding_id = p_connection_binding;
      v_has_o := found;
    else
      v_provider := v_payload->>'provider';
      select * into p from clued_private.integration_providers_v1 where provider = v_provider;
      if not found then raise exception 'provider_not_registered' using errcode = '42501'; end if;
      v_conn_status := case when p.connection_dimension = 'REQUIRED' then 'UNAVAILABLE' else 'NOT_APPLICABLE' end;
      v_pcid := null;
    end if;

    if v_intent = any(v_rebind_class) then
      select * into t0 from clued_private.integrations_v1 where integration_id = r.target_integration_id and owner_id = p_owner;
      if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
      v_tenant := clued_private.integration_resolve_dimension_v1(h.tenant_dimension, h.tenant_evidence_kinds, v_payload->'tenant',
        pg_catalog.jsonb_build_object('status', t0.tenant_status, 'value', t0.host_tenant_or_workspace_id));
      v_account := clued_private.integration_resolve_dimension_v1(h.account_dimension, h.account_evidence_kinds, v_payload->'account',
        pg_catalog.jsonb_build_object('status', t0.account_status, 'value', t0.host_account_id));
      v_downgrade := (t0.tenant_status = 'VALUE' and v_tenant->>'status' = 'UNAVAILABLE')
                  or (t0.account_status = 'VALUE' and v_account->>'status' = 'UNAVAILABLE');
      if v_downgrade and v_intent not in ('REBIND','ADAPTER_MIGRATION') then
        raise exception 'identity_dimension_downgrade_forbidden' using errcode = '42501';
      end if;
      v_domain := t0.active_binding_domain;
    else
      v_tenant := clued_private.integration_resolve_dimension_v1(h.tenant_dimension, h.tenant_evidence_kinds, v_payload->'tenant', null);
      v_account := clued_private.integration_resolve_dimension_v1(h.account_dimension, h.account_evidence_kinds, v_payload->'account', null);
      v_domain := 'clued.default.v1';
    end if;
    v_identity := pg_catalog.jsonb_build_object('tenant_status', v_tenant->>'status', 'tenant', v_tenant->>'value',
      'account_status', v_account->>'status', 'account', v_account->>'value', 'provider', v_provider,
      'connection_status', v_conn_status, 'connection', v_pcid, 'domain', v_domain);
    v_key := clued_private.integration_claim_key_v1(clued_private.integration_claim_key_material_v1(p_owner, h.host,
      v_tenant->>'status', v_tenant->>'value', v_account->>'status', v_account->>'value', v_provider, v_conn_status, v_pcid, v_domain));

    -- step 5: target; L4 strictly before L5 (§6.4 pre-1…pre-5)
    if v_intent = any(v_rebind_class) then
      perform clued_private.integration_claim_lock_v1(array[v_domain || E'\x1f' || v_key,
        t0.active_binding_domain || E'\x1f' || t0.claim_key_sha256]);
      select * into t from clued_private.integrations_v1 where integration_id = t0.integration_id for update;
      if t.version <> t0.version or t.claim_key_sha256 is distinct from t0.claim_key_sha256
         or t.active_binding_domain <> t0.active_binding_domain then
        raise exception 'integration_version_conflict' using errcode = '40001';
      end if;
      v_has_t := true; v_outcome := 'REBOUND';
    elsif v_key is not null then
      perform clued_private.integration_claim_lock_v1(array[v_domain || E'\x1f' || v_key]);
      select c.integration_id into v_holder from clued_private.integration_claims_v1 c
       where c.active_binding_domain = v_domain and c.claim_key_sha256 = v_key and c.claim_status = 'CURRENT';
      if v_holder is not null then
        select * into t from clued_private.integrations_v1 where integration_id = v_holder for update;
        v_has_t := true; v_outcome := 'BIND_EXISTING';
      else
        v_outcome := 'CREATE';
      end if;
    else
      v_outcome := 'CREATE';
    end if;
    if p_mode = 'CONFIRM_REBIND' then
      if not v_has_t or (p_input->>'base_version') is null or (p_input->>'base_version')::bigint <> t.version then
        raise exception 'integration_version_conflict' using errcode = '40001';
      end if;
    end if;

    -- step 6: guards on an existing target
    if v_has_t then
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', t.integration_id);
      e0 := clued_private.integration_evaluate_v1(t.integration_id, v_call_at);
      v_r0 := e0->'reason_codes';
      if clued_private.integration_revocation_status_v1(t.integration_id) <> 'NOT_REVOKED' then
        raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
      end if;
      if t.historical = 'SUPERSEDED' then
        v_supp := pg_catalog.jsonb_build_object('superseded_by', t.superseded_by_integration_id);
        raise exception 'integration_superseded' using errcode = '42501';
      end if;
      if t.identity_claim_state in ('CLAIM_CONFLICT','PENDING_RECONCILE')
         and (v_key is distinct from t.claim_key_sha256 or v_downgrade) then
        raise exception 'integration_claim_blocked' using errcode = '42501';
      end if;
      if v_payload->>'host' <> t.host then raise exception 'integration_host_mismatch' using errcode = '42501'; end if;
      if v_provider <> t.provider then raise exception 'integration_provider_mismatch' using errcode = '42501'; end if;
      select * into cur from clued_private.integration_connections_v1
       where integration_id = t.integration_id and link_status = 'CURRENT' order by linked_at desc limit 1;
      v_has_cur := found;
      if v_has_cur then
        ref := cur; v_has_ref := true;
      else
        select * into ref from clued_private.integration_connections_v1
         where integration_id = t.integration_id order by unlinked_at desc nulls last, linked_at desc limit 1;
        v_has_ref := found;
      end if;
      if p_mode = 'BINDING' then
        v_link_authority := case
          when v_has_ref and ref.binding_id = p_connection_binding then 'SELF'
          when v_has_ref and ref.provider = v_provider and ref.provider_connection_id = v_pcid
               and exists (select 1 from clued_private.integration_providers_v1 pp
                            where pp.provider = v_provider and pp.connection_source = 'OAUTH_V12_CLIENT_ID_SHA256')
            then 'SAME_PROVIDER_CONNECTION'
          when not v_has_ref and v_intent = 'BIND_CONNECTION' and r.created_via = 'native_session'
               and r.target_integration_id = t.integration_id
               and (v_payload->>'expected_provider_connection_id' is null
                    or v_payload->>'expected_provider_connection_id' = v_pcid)
            then 'NATIVE_BIND_REQUEST'
          when v_outcome = 'BIND_EXISTING' then 'SAME_PROVIDER_CONNECTION'   -- the full key matched (§10.1)
          else null end;
        if v_link_authority is null then
          raise exception 'integration_rebind_requires_owner_confirmation' using errcode = '42501';
        end if;
      end if;
      v_new_connection := p_connection_binding is not null and (not v_has_cur or cur.binding_id <> p_connection_binding);
      if v_new_connection and t.first_authorized_at is not null and t.recovery_policy = 'FORBIDS_REAUTH' then
        raise exception 'integration_recovery_forbidden' using errcode = '42501';
      end if;
      if p_connection_binding is not null and t.authorization_ceiling is not null then
        v_eff := clued_private.integration_ceiling_eff_v1(t.integration_id);
        if not clued_private.integration_covers_v1(v_eff->'ceiling', v_authority) then
          v_fresh := clued_private.integration_fresh_consent_v1(p_connection_binding, t.integration_id);
          if not v_fresh then
            raise exception 'reauthorization_scope_expansion_forbidden' using errcode = '42501';
          end if;
          v_expanded := true;
        end if;
      end if;
    end if;
    if p_mode = 'CONFIRM_REBIND' then v_link_authority := 'NATIVE_OWNER_CONFIRMED';
    elsif p_mode = 'ADOPT' then v_link_authority := 'NATIVE_ADOPT';
    elsif p_mode = 'BINDING' and v_outcome = 'CREATE' then v_link_authority := 'CREATE';
    end if;

    -- step 6': ownership (§5.5 O3 / O4 / O7)
    if p_connection_binding is not null then
      if p_mode = 'BINDING' then
        if v_has_o and (v_outcome = 'CREATE' or o.integration_id <> t.integration_id) then
          raise exception 'binding_owned_by_other_integration' using errcode = '42501';
        end if;
        if not v_has_o and clued_private.integration_binding_predates_revocation_v1(v_conn, v_call_at) then
          raise exception 'binding_predates_revocation' using errcode = '42501';
        end if;
      elsif v_has_o and (v_outcome = 'CREATE' or o.integration_id <> t.integration_id) then
        if exists (select 1 from clued_private.integration_connections_v1 x
                    where x.integration_id = o.integration_id and x.binding_id = p_connection_binding and x.link_status = 'CURRENT') then
          raise exception 'binding_owned_by_other_integration' using errcode = '42501';
        end if;
        v_transfer := true;
      end if;
    end if;

    -- step 7: create
    if v_outcome = 'CREATE' then
      select * into pol from clued_private.integration_policy_v1 order by policy_version desc limit 1;
      insert into clued_private.integrations_v1(owner_id, host, provider, tenant_status, host_tenant_or_workspace_id,
        account_status, host_account_id, connection_status, provider_connection_id, active_binding_domain,
        identity_completeness, claim_key_sha256, identity_claim_state, current_identity_snapshot_id, adapter_family,
        adapter_version, package_version, install_status, recovery_policy, first_authorization_required, policy_version,
        created_receipt_id, last_receipt_id)
      values (p_owner, h.host, v_provider, v_tenant->>'status', v_tenant->>'value', v_account->>'status', v_account->>'value',
        'UNAVAILABLE', null, v_domain, 'INCOMPLETE', null, 'INCOMPLETE_UNCLAIMED', gen_random_uuid(),
        v_payload->>'adapter_family', v_payload->>'adapter_version', v_payload->>'package_version', 'PENDING',
        pol.default_recovery_policy, h.first_authorization_required, pol.policy_version, v_receipt.id, v_receipt.id)
      returning * into t;
      v_has_t := true;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', t.integration_id);
    end if;

    -- step 8: link the connection, ownership, first authorization, ceiling, reauth marks
    if p_connection_binding is not null then
      select * into cur from clued_private.integration_connections_v1
       where integration_id = t.integration_id and link_status = 'CURRENT' order by linked_at desc limit 1;
      v_has_cur := found;
      if not v_has_cur or cur.binding_id <> p_connection_binding then
        update clued_private.integration_connections_v1 set link_status = 'HISTORICAL', unlinked_at = pg_catalog.clock_timestamp(),
          unlink_receipt_id = v_receipt.id where integration_id = t.integration_id and link_status = 'CURRENT';
        insert into clued_private.integration_connections_v1(integration_id, binding_id, connection_kind, link_status,
          scopes_at_link, provider, provider_connection_id, link_authority, link_receipt_id)
        values (t.integration_id, p_connection_binding, v_conn->>'connection_kind', 'CURRENT',
          array(select pg_catalog.jsonb_array_elements_text(v_conn->'scopes')), v_provider, v_pcid, v_link_authority, v_receipt.id);
      end if;
      if not v_has_o or v_transfer then
        v_transfer_rec := clued_private.integration_take_ownership_v1(p_connection_binding, t.integration_id, p_owner,
          case p_mode when 'BINDING' then 'FIRST_LINK' when 'CONFIRM_REBIND' then 'NATIVE_OWNER_CONFIRMED' else 'NATIVE_ADOPT' end,
          p_actor->>'kind', v_receipt.id);
        if v_transfer then
          v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'ownership_source', 'kind', 'integration',
            'id', o.integration_id);
        end if;
      end if;
      select * into t from clued_private.integrations_v1 where integration_id = t.integration_id;
      v_ceiling_before := t.authorization_ceiling;
      if t.authorization_ceiling is null or v_expanded then
        v_ceiling_after := v_authority; v_ceiling_set_at := pg_catalog.clock_timestamp();
        if v_expanded then v_flags := v_flags || 'AUTHORITY_EXPANDED_BY_CONSENT'::text; end if;
      else
        v_eff := coalesce(v_eff, clued_private.integration_ceiling_eff_v1(t.integration_id));
        v_ceiling_after := v_eff->'ceiling';
        v_ceiling_set_at := case when v_ceiling_after is distinct from t.authorization_ceiling
                                 then (v_eff->>'latest_reduce_at')::timestamptz else t.authorization_ceiling_set_at end;
      end if;
      update clued_private.integrations_v1 set
        first_authorized_at = coalesce(first_authorized_at,
          case when (v_conn->>'auth_usable')::boolean then pg_catalog.clock_timestamp() end),
        authorization_ceiling = v_ceiling_after, authorization_ceiling_set_at = v_ceiling_set_at
      where integration_id = t.integration_id;
      with cleared as (
        update clued_private.integration_reauth_marks_v1 m set cleared_at = pg_catalog.clock_timestamp(),
          cleared_by = 'REAUTHORIZATION_REBIND', cleared_receipt_id = v_receipt.id
         where m.integration_id = t.integration_id and m.cleared_at is null
           and m.raised_at < (v_conn->>'authorization_created_at')::timestamptz
           and clued_private.integration_covers_v1(v_ceiling_after, v_authority)
        returning m.mark_id)
      select coalesce(array_agg(mark_id order by mark_id), '{}') into v_cleared from cleared;
    end if;

    -- step 9: claim (L4 already held)
    v_state := clued_private.integration_claim_core_v1(t.integration_id, v_identity, v_receipt.id);
    -- step 10: installation phase, monotonic
    if v_payload->>'installation_phase' = 'COMPLETED' then
      update clued_private.integrations_v1 set install_status = 'COMPLETED' where integration_id = t.integration_id;
    end if;
    -- step 11: the Request is bound
    update clued_private.integration_installation_requests_v1 set request_status = 'BOUND',
      bound_integration_id = t.integration_id, bound_intent_sha256 = v_bound_sha, bound_receipt_id = v_receipt.id,
      version = version + 1
    where request_id = r.request_id;
    -- step 12: snapshot, operation log, validity gate, Receipt
    v_version := clued_private.integration_touch_v1(t.integration_id, v_receipt.id, pg_catalog.jsonb_build_object(
      'tenant_evidence_kind', v_payload #>> '{tenant,evidence_kind}', 'account_evidence_kind', v_payload #>> '{account,evidence_kind}',
      'connection_evidence_kind', case when v_provider = 'clued.oauth.v12' then 'OAUTH_V12_CLIENT_ID'
                                       when p_connection_binding is not null then 'BINDING_ID' end));
    if v_state = 'CLAIM_CONFLICT' then
      v_outcome := 'CLAIM_CONFLICT';
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'conflict', 'kind', 'integration',
        'id', (select conflicting_integration_id from clued_private.integrations_v1 where integration_id = t.integration_id));
    end if;
    v_op_type := case when v_intent = any(v_rebind_class) then 'REBIND'
                      when v_has_t and t.created_receipt_id = v_receipt.id then 'CREATE' else 'BIND_EXISTING' end;
    perform clued_private.integration_log_v1(p_owner, p_actor, r.request_id, t.integration_id,
      (select conflicting_integration_id from clued_private.integrations_v1 where integration_id = t.integration_id),
      v_op_type, coalesce(v_payload->'source_provenance', '{}'::jsonb) || pg_catalog.jsonb_build_object('mode', p_mode,
        'connection_binding_id', p_connection_binding, 'link_authority', v_link_authority),
      v_payload->'callback_provenance', v_outcome, v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(t.integration_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(v_r0, e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', v_r0);
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', t.integration_id, 'outcome', v_outcome,
      'identity_claim_state', v_state, 'link_authority', v_link_authority, 'request_id', r.request_id,
      'evaluation', e1 - 'facts' - 'sources_read', 'outcome_flags', pg_catalog.to_jsonb(v_flags),
      'cleared_reauth_mark_ids', pg_catalog.to_jsonb(v_cleared));
    if v_transfer_rec is not null and not coalesce((v_transfer_rec->>'first_ownership')::boolean, false) then
      v_supp := v_supp || pg_catalog.jsonb_build_object('ownership_transfer', v_transfer_rec);
    end if;
    if p_connection_binding is not null and v_ceiling_before is distinct from v_ceiling_after then
      v_supp := v_supp || pg_catalog.jsonb_build_object('ceiling_before', v_ceiling_before, 'ceiling_after', v_ceiling_after);
    end if;
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(t.integration_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.4 identity strengthening / re-claim. provider_connection_id is never caller input; a VALUE →
-- UNAVAILABLE change is identity_dimension_downgrade_forbidden here (only a REBIND / ADAPTER_MIGRATION
-- Request may do it, §10.3); a key change during CLAIM_CONFLICT / PENDING_RECONCILE is
-- integration_claim_blocked (v0.1.2 MINOR-N5).
create function clued_private.integration_identity_update_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  t0 clued_private.integrations_v1; t clued_private.integrations_v1; h clued_private.integration_hosts_v1;
  v_id uuid; v_base bigint; v_tenant jsonb; v_account jsonb; v_domain text; v_identity jsonb; v_key text;
  e0 jsonb; e1 jsonb; v_state text; v_version bigint; v_revocation uuid; v_flags text[] := '{}';
  v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, (p_actor->>'binding_id')::uuid, 'integration_identity_update',
    p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
    exception when others then raise exception 'invalid_identity_update' using errcode = '22023';
    end;
    if v_id is null or v_base is null or p_input ? 'provider' or p_input ? 'provider_connection_id' then
      -- provider and provider_connection_id are derived by the server, never accepted as input (§10.4)
      raise exception 'invalid_identity_update' using errcode = '22023';
    end if;
    select * into t0 from clued_private.integrations_v1 where integration_id = v_id and owner_id = p_owner;
    if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    select * into h from clued_private.integration_hosts_v1 where host = t0.host;
    v_tenant := clued_private.integration_resolve_dimension_v1(h.tenant_dimension, h.tenant_evidence_kinds, p_input->'tenant',
      pg_catalog.jsonb_build_object('status', t0.tenant_status, 'value', t0.host_tenant_or_workspace_id));
    v_account := clued_private.integration_resolve_dimension_v1(h.account_dimension, h.account_evidence_kinds, p_input->'account',
      pg_catalog.jsonb_build_object('status', t0.account_status, 'value', t0.host_account_id));
    if (t0.tenant_status = 'VALUE' and v_tenant->>'status' = 'UNAVAILABLE')
       or (t0.account_status = 'VALUE' and v_account->>'status' = 'UNAVAILABLE') then
      raise exception 'identity_dimension_downgrade_forbidden' using errcode = '42501';
    end if;
    v_domain := coalesce(p_input->>'active_binding_domain', t0.active_binding_domain);
    if not exists (select 1 from clued_private.integration_binding_domains_v1 where domain = v_domain) then
      raise exception 'invalid_binding_domain' using errcode = '22023';
    end if;
    v_identity := pg_catalog.jsonb_build_object('tenant_status', v_tenant->>'status', 'tenant', v_tenant->>'value',
      'account_status', v_account->>'status', 'account', v_account->>'value', 'provider', t0.provider,
      'connection_status', t0.connection_status, 'connection', t0.provider_connection_id, 'domain', v_domain);
    v_key := clued_private.integration_claim_key_v1(clued_private.integration_claim_key_material_v1(p_owner, t0.host,
      v_tenant->>'status', v_tenant->>'value', v_account->>'status', v_account->>'value', t0.provider,
      t0.connection_status, t0.provider_connection_id, v_domain));
    -- §6.4 pre-3…pre-5
    perform clued_private.integration_claim_lock_v1(array[v_domain || E'\x1f' || v_key,
      t0.active_binding_domain || E'\x1f' || t0.claim_key_sha256]);
    select * into t from clued_private.integrations_v1 where integration_id = v_id for update;
    if t.version <> t0.version or t.version <> v_base then
      raise exception 'integration_version_conflict' using errcode = '40001';
    end if;
    -- §10.1: the Binding channel's current-connection precondition is rechecked under L5
    if p_actor->>'kind' = 'binding'
       and clued_private.integration_current_binding_v1(v_id) is distinct from (p_actor->>'binding_id')::uuid then
      raise exception 'integration_connection_required' using errcode = '42501';
    end if;
    -- §10.1 materialization before this write's own change
    v_revocation := clued_private.integration_materialize_connection_revoke_v1(v_id, v_receipt.id, v_call_at);
    if v_revocation is not null then
      v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
        'id', v_revocation);
    end if;
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    if t.historical = 'SUPERSEDED' then
      v_supp := pg_catalog.jsonb_build_object('superseded_by', t.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    if t.identity_claim_state in ('CLAIM_CONFLICT','PENDING_RECONCILE') and v_key is distinct from t.claim_key_sha256 then
      raise exception 'integration_claim_blocked' using errcode = '42501';
    end if;
    v_state := clued_private.integration_claim_core_v1(v_id, v_identity, v_receipt.id);
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, pg_catalog.jsonb_build_object(
      'tenant_evidence_kind', p_input #>> '{tenant,evidence_kind}', 'account_evidence_kind', p_input #>> '{account,evidence_kind}'));
    if v_state = 'CLAIM_CONFLICT' then
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'conflict', 'kind', 'integration',
        'id', (select conflicting_integration_id from clued_private.integrations_v1 where integration_id = v_id));
    end if;
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id,
      (select conflicting_integration_id from clued_private.integrations_v1 where integration_id = v_id),
      'RECLAIM', coalesce(p_input->'source_provenance', '{}'::jsonb), null, v_state, v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'identity_claim_state', v_state,
      'outcome_flags', pg_catalog.to_jsonb(v_flags), 'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.5 Binding reconcile_request: CLAIM_CONFLICT → PENDING_RECONCILE (the conflicting ref is kept).
create function clued_private.integration_reconcile_request_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  t clued_private.integrations_v1; v_id uuid; v_base bigint; e0 jsonb; e1 jsonb; v_version bigint; v_revocation uuid;
  v_flags text[] := '{}'; v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, (p_actor->>'binding_id')::uuid, 'integration_reconcile',
    p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
    exception when others then raise exception 'invalid_reconcile_request' using errcode = '22023';
    end;
    if v_id is null or v_base is null then raise exception 'invalid_reconcile_request' using errcode = '22023'; end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    select * into t from clued_private.integrations_v1 where integration_id = v_id and owner_id = p_owner for update;
    if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    if t.version <> v_base then raise exception 'integration_version_conflict' using errcode = '40001'; end if;
    if p_actor->>'kind' = 'binding'
       and clued_private.integration_current_binding_v1(v_id) is distinct from (p_actor->>'binding_id')::uuid then
      raise exception 'integration_connection_required' using errcode = '42501';
    end if;
    v_revocation := clued_private.integration_materialize_connection_revoke_v1(v_id, v_receipt.id, v_call_at);
    if v_revocation is not null then
      v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
        'id', v_revocation);
    end if;
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    if t.identity_claim_state <> 'CLAIM_CONFLICT' then
      raise exception 'reconcile_not_applicable' using errcode = '42501';
    end if;
    update clued_private.integrations_v1 set identity_claim_state = 'PENDING_RECONCILE' where integration_id = v_id;
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, null);
    v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'holder', 'kind', 'integration',
      'id', t.conflicting_integration_id);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, t.conflicting_integration_id, 'RECONCILE',
      pg_catalog.jsonb_build_object('step', 'reconcile_request'), null, 'PENDING_RECONCILE', v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'identity_claim_state', 'PENDING_RECONCILE',
      'outcome_flags', pg_catalog.to_jsonb(v_flags), 'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- Non-revoked Bindings owned by I (§5.5; "non-revoked" = revoked_at is null, expiry is not a filter).
create function clued_private.integration_owned_unrevoked_v1(p_integration_id uuid)
returns uuid[] language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(o.binding_id order by o.binding_id), '{}')
    from clued_private.integration_binding_owners_v1 o
    join clued_private.integrations_v1 i on i.integration_id = o.integration_id
    join public.clued_agent_bindings b on b.id = o.binding_id and b.user_id = i.owner_id
   where o.integration_id = p_integration_id and b.revoked_at is null
$$;

-- §10.5 Native reconcile. REBIND_TO_HOLDER moves I's live CURRENT connection to the holder H and
-- supersedes I; REPLACE_HOLDER supersedes H and makes I the holder. Every non-revoked Binding the
-- superseded party owns moves to the survivor (NATIVE_RECONCILE, v0.1.5 MINOR-N15). PR-2 refuses
-- REPLACE_HOLDER over a revoked H (v0.1.7 MINOR-N25; PR-4 replaces it with rule 2).
create function clued_private.integration_reconcile_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  i0 clued_private.integrations_v1; h0 clued_private.integrations_v1; i clued_private.integrations_v1;
  h clued_private.integrations_v1; v_resolution text := p_input->>'resolution'; v_base bigint; v_hbase bigint;
  v_i_cur uuid; v_h_cur uuid; v_moving uuid[]; v_locked uuid[]; b uuid; v_conn jsonb; v_authority jsonb;
  ei0 jsonb; eh0 jsonb; ei1 jsonb; eh1 jsonb; v_eff jsonb; v_expanded boolean := false; v_transfers jsonb := '[]';
  v_rec jsonb; v_ceiling_before jsonb; v_ceiling_after jsonb; v_ceiling_set_at timestamptz; v_cleared uuid[] := '{}';
  v_flags text[] := '{}'; v_vi bigint; v_vh bigint; v_target_refs jsonb := '[]'; v_supp jsonb := '{}';
  v_error text; v_sqlstate text; v_winner uuid; v_loser uuid;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, null, 'integration_reconcile', p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_base := (p_input->>'base_version')::bigint; v_hbase := (p_input->>'holder_base_version')::bigint;
      select * into i0 from clued_private.integrations_v1
       where integration_id = (p_input->>'integration_id')::uuid and owner_id = p_owner;
    exception when others then raise exception 'invalid_reconcile' using errcode = '22023';
    end;
    if i0.integration_id is null then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    if v_base is null or v_hbase is null or v_resolution not in ('REBIND_TO_HOLDER','REPLACE_HOLDER') then
      raise exception 'invalid_reconcile' using errcode = '22023';
    end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration',
      'id', i0.integration_id));
    if i0.identity_claim_state not in ('CLAIM_CONFLICT','PENDING_RECONCILE') then
      raise exception 'reconcile_not_applicable' using errcode = '42501';
    end if;
    select * into h0 from clued_private.integrations_v1
     where integration_id = i0.conflicting_integration_id and owner_id = p_owner;
    if h0.integration_id is null then raise exception 'reconcile_not_applicable' using errcode = '42501'; end if;
    v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'holder', 'kind', 'integration', 'id', h0.integration_id);
    -- L1 (+ owner rows) and L2 over every Binding this reconcile may move, then L4, then L5
    v_i_cur := clued_private.integration_current_binding_v1(i0.integration_id);
    v_h_cur := clued_private.integration_current_binding_v1(h0.integration_id);
    v_moving := case when v_resolution = 'REBIND_TO_HOLDER' then clued_private.integration_owned_unrevoked_v1(i0.integration_id)
                     else clued_private.integration_owned_unrevoked_v1(h0.integration_id) end;
    v_locked := array[v_i_cur, v_h_cur] || v_moving;
    perform clued_private.integration_lock_bindings_v1(v_locked);
    perform clued_private.integration_claim_lock_v1(array[i0.active_binding_domain || E'\x1f' || i0.claim_key_sha256,
      h0.active_binding_domain || E'\x1f' || h0.claim_key_sha256]);
    perform 1 from clued_private.integrations_v1 where integration_id in (i0.integration_id, h0.integration_id)
      order by integration_id for update;
    select * into i from clued_private.integrations_v1 where integration_id = i0.integration_id;
    select * into h from clued_private.integrations_v1 where integration_id = h0.integration_id;
    if i.version <> v_base or h.version <> v_hbase or i.version <> i0.version or h.version <> h0.version
       or i.conflicting_integration_id is distinct from h.integration_id
       or clued_private.integration_current_binding_v1(i.integration_id) is distinct from v_i_cur
       or clued_private.integration_current_binding_v1(h.integration_id) is distinct from v_h_cur
       or not (clued_private.integration_owned_unrevoked_v1(case when v_resolution = 'REBIND_TO_HOLDER'
                 then i.integration_id else h.integration_id end) <@ v_locked) then
      raise exception 'integration_version_conflict' using errcode = '40001';
    end if;
    -- The stored conflict pointer is only a hint: under L4 and L5, H must still be the CURRENT holder of
    -- I's own (D, K). A SUPERSEDED H is terminal (§6.5) and neither receives a connection nor is superseded
    -- again; that would move a live Binding outside every survivor's revocation set, or rewrite H's
    -- superseded_by and cut its lineage out of Lin*(survivor) (§5.5 O5).
    if h.historical <> 'NONE' or h.identity_claim_state = 'SUPERSEDED' then
      v_supp := pg_catalog.jsonb_build_object('holder_superseded_by', h.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    if h.identity_claim_state <> 'CURRENT_CLAIM_HOLDER' or i.claim_key_sha256 is null
       or h.claim_key_sha256 is distinct from i.claim_key_sha256
       or h.active_binding_domain is distinct from i.active_binding_domain
       or not exists (select 1 from clued_private.integration_claims_v1 c
                       where c.active_binding_domain = i.active_binding_domain and c.claim_key_sha256 = i.claim_key_sha256
                         and c.claim_status = 'CURRENT' and c.integration_id = h.integration_id) then
      raise exception 'reconcile_not_applicable' using errcode = '42501';
    end if;
    ei0 := clued_private.integration_evaluate_v1(i.integration_id, v_call_at);
    eh0 := clued_private.integration_evaluate_v1(h.integration_id, v_call_at);
    if clued_private.integration_revocation_status_v1(i.integration_id) <> 'NOT_REVOKED' then
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;
    if clued_private.integration_revocation_status_v1(h.integration_id) <> 'NOT_REVOKED' then
      -- REBIND_TO_HOLDER rule 2; for REPLACE_HOLDER this is the PR-2 temporary refusal (T-A11-26)
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;

    if v_resolution = 'REBIND_TO_HOLDER' then
      v_winner := h.integration_id; v_loser := i.integration_id;
      v_conn := case when v_i_cur is not null then clued_private.integration_binding_identity_v1(v_i_cur) end;
      if v_conn is null or not (v_conn->>'live')::boolean then
        raise exception 'reconcile_requires_active_connection' using errcode = '42501';
      end if;
      b := v_i_cur; v_authority := v_conn->'authority';
      if h.recovery_policy = 'FORBIDS_REAUTH' and h.first_authorized_at is not null then
        raise exception 'integration_recovery_forbidden' using errcode = '42501';
      end if;
      if h.authorization_ceiling is not null then
        v_eff := clued_private.integration_ceiling_eff_v1(h.integration_id);
        if not clued_private.integration_covers_v1(v_eff->'ceiling', v_authority) then
          if not clued_private.integration_fresh_consent_v1(b, h.integration_id) then
            raise exception 'reauthorization_scope_expansion_forbidden' using errcode = '42501';
          end if;
          v_expanded := true;
        end if;
      end if;
      if i.host <> h.host then raise exception 'integration_host_mismatch' using errcode = '42501'; end if;
      if i.provider <> h.provider then raise exception 'integration_provider_mismatch' using errcode = '42501'; end if;
      update clued_private.integration_connections_v1 set link_status = 'HISTORICAL', unlinked_at = pg_catalog.clock_timestamp(),
        unlink_receipt_id = v_receipt.id
       where integration_id in (i.integration_id, h.integration_id) and link_status = 'CURRENT';
      insert into clued_private.integration_connections_v1(integration_id, binding_id, connection_kind, link_status,
        scopes_at_link, provider, provider_connection_id, link_authority, link_receipt_id)
      values (h.integration_id, b, v_conn->>'connection_kind', 'CURRENT',
        array(select pg_catalog.jsonb_array_elements_text(v_conn->'scopes')), v_conn->>'provider',
        v_conn->>'provider_connection_id', 'NATIVE_RECONCILE', v_receipt.id);
      foreach b in array v_moving loop
        v_rec := clued_private.integration_take_ownership_v1(b, h.integration_id, p_owner, 'NATIVE_RECONCILE',
          'native_session', v_receipt.id);
        if v_rec is not null then v_transfers := v_transfers || pg_catalog.jsonb_build_array(v_rec); end if;
      end loop;
      b := v_i_cur;
      v_ceiling_before := h.authorization_ceiling;
      if h.authorization_ceiling is null or v_expanded then
        v_ceiling_after := v_authority; v_ceiling_set_at := pg_catalog.clock_timestamp();
        if v_expanded then v_flags := v_flags || 'AUTHORITY_EXPANDED_BY_CONSENT'::text; end if;
      else
        v_ceiling_after := v_eff->'ceiling';
        v_ceiling_set_at := case when v_ceiling_after is distinct from h.authorization_ceiling
                                 then (v_eff->>'latest_reduce_at')::timestamptz else h.authorization_ceiling_set_at end;
      end if;
      update clued_private.integrations_v1 set
        first_authorized_at = coalesce(first_authorized_at,
          case when (v_conn->>'auth_usable')::boolean then pg_catalog.clock_timestamp() end),
        authorization_ceiling = v_ceiling_after, authorization_ceiling_set_at = v_ceiling_set_at
      where integration_id = h.integration_id;
      with cleared as (
        update clued_private.integration_reauth_marks_v1 m set cleared_at = pg_catalog.clock_timestamp(),
          cleared_by = 'REAUTHORIZATION_REBIND', cleared_receipt_id = v_receipt.id
         where m.integration_id = h.integration_id and m.cleared_at is null
           and m.raised_at < (v_conn->>'authorization_created_at')::timestamptz
           and clued_private.integration_covers_v1(v_ceiling_after, v_authority)
        returning m.mark_id)
      select coalesce(array_agg(mark_id order by mark_id), '{}') into v_cleared from cleared;
      update clued_private.integrations_v1 set identity_claim_state = 'SUPERSEDED', historical = 'SUPERSEDED',
        superseded_by_integration_id = h.integration_id, conflicting_integration_id = null
       where integration_id = i.integration_id;
    else
      if i.host <> h.host then raise exception 'integration_host_mismatch' using errcode = '42501'; end if;
      if i.provider <> h.provider then raise exception 'integration_provider_mismatch' using errcode = '42501'; end if;
      v_winner := i.integration_id; v_loser := h.integration_id;
      update clued_private.integration_claims_v1 set claim_status = 'SUPERSEDED', ended_at = pg_catalog.clock_timestamp(),
        ended_receipt_id = v_receipt.id where integration_id = h.integration_id and claim_status = 'CURRENT';
      update clued_private.integrations_v1 set identity_claim_state = 'SUPERSEDED', historical = 'SUPERSEDED',
        superseded_by_integration_id = i.integration_id, conflicting_integration_id = null
       where integration_id = h.integration_id;
      update clued_private.integration_connections_v1 set link_status = 'HISTORICAL', unlinked_at = pg_catalog.clock_timestamp(),
        unlink_receipt_id = v_receipt.id where integration_id = h.integration_id and link_status = 'CURRENT';
      foreach b in array v_moving loop
        v_rec := clued_private.integration_take_ownership_v1(b, i.integration_id, p_owner, 'NATIVE_RECONCILE',
          'native_session', v_receipt.id);
        if v_rec is not null then v_transfers := v_transfers || pg_catalog.jsonb_build_array(v_rec); end if;
      end loop;
      perform clued_private.integration_claim_core_v1(i.integration_id,
        clued_private.integration_identity_of_v1(i.integration_id), v_receipt.id);
    end if;
    v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'superseded', 'kind', 'integration', 'id', v_loser);
    if pg_catalog.jsonb_array_length(v_transfers) > 0 then
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'ownership_source', 'kind', 'integration', 'id', v_loser);
    end if;
    v_vi := clued_private.integration_touch_v1(i.integration_id, v_receipt.id, null);
    v_vh := clued_private.integration_touch_v1(h.integration_id, v_receipt.id, null);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_winner, v_loser, 'RECONCILE',
      pg_catalog.jsonb_build_object('resolution', v_resolution), null, 'CURRENT_CLAIM_HOLDER', v_receipt.id);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_loser, v_winner, 'SUPERSEDE',
      pg_catalog.jsonb_build_object('resolution', v_resolution), null, 'SUPERSEDED', v_receipt.id);
    ei1 := clued_private.integration_evaluate_v1(i.integration_id, pg_catalog.clock_timestamp());
    eh1 := clued_private.integration_evaluate_v1(h.integration_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(ei0->'reason_codes', ei1->'reason_codes')
       or clued_private.integration_gate_violated_v1(eh0->'reason_codes', eh1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', ei1->'reason_codes', 'holder_reason_codes', eh1->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', i.integration_id, 'holder_integration_id', h.integration_id,
      'resolution', v_resolution, 'surviving_integration_id', v_winner, 'superseded_integration_id', v_loser,
      'ownership_transfer', v_transfers, 'outcome_flags', pg_catalog.to_jsonb(v_flags),
      'cleared_reauth_mark_ids', pg_catalog.to_jsonb(v_cleared),
      'evaluation', ei1 - 'facts' - 'sources_read', 'holder_evaluation', eh1 - 'facts' - 'sources_read');
    if v_resolution = 'REBIND_TO_HOLDER' and v_ceiling_before is distinct from v_ceiling_after then
      v_supp := v_supp || pg_catalog.jsonb_build_object('ceiling_before', v_ceiling_before, 'ceiling_after', v_ceiling_after);
    end if;
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(i.integration_id::text, v_vi, h.integration_id::text, v_vh), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.9 status view (no READY in PR-2). provider_connection_id is shown as an 8-character prefix.
create function clued_private.integration_view_v1(p_integration_id uuid, p_as_of timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare i clued_private.integrations_v1; e jsonb; v_cur clued_private.integration_connections_v1; v_has_cur boolean;
begin
  select * into i from clued_private.integrations_v1 where integration_id = p_integration_id;
  e := clued_private.integration_evaluate_v1(p_integration_id, p_as_of);
  select * into v_cur from clued_private.integration_connections_v1
   where integration_id = p_integration_id and link_status = 'CURRENT' order by linked_at desc limit 1;
  v_has_cur := found;
  return pg_catalog.jsonb_build_object(
    'integration_id', i.integration_id, 'version', i.version, 'created_at', i.created_at,
    'identity', pg_catalog.jsonb_build_object('host', i.host, 'provider', i.provider,
      'host_tenant_or_workspace_id', pg_catalog.jsonb_build_object('status', i.tenant_status, 'value', i.host_tenant_or_workspace_id),
      'host_account_id', pg_catalog.jsonb_build_object('status', i.account_status, 'value', i.host_account_id),
      'provider_connection_id', pg_catalog.jsonb_build_object('status', i.connection_status,
        'prefix', pg_catalog.left(i.provider_connection_id, 8)),
      'active_binding_domain', i.active_binding_domain, 'identity_completeness', i.identity_completeness,
      'conflicting_integration_id', i.conflicting_integration_id, 'superseded_by_integration_id', i.superseded_by_integration_id),
    'identity_claim_state', i.identity_claim_state,
    'adapter', pg_catalog.jsonb_build_object('adapter_family', i.adapter_family, 'adapter_version', i.adapter_version,
      'package_version', i.package_version),
    'evaluation', e - 'sources_read',
    'sources_read', e->'sources_read',
    'connections', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('connection_id', c.connection_id,
        'binding_id', c.binding_id, 'connection_kind', c.connection_kind, 'link_status', c.link_status,
        'linked_at', c.linked_at, 'unlinked_at', c.unlinked_at, 'link_authority', c.link_authority, 'provider', c.provider,
        'provider_connection_prefix', pg_catalog.left(c.provider_connection_id, 8)) order by c.linked_at, c.connection_id)
      from clued_private.integration_connections_v1 c where c.integration_id = p_integration_id), '[]'::jsonb),
    'owned_bindings', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('binding_id', o.binding_id,
        'acquired_via', o.acquired_via, 'live', coalesce((clued_private.integration_binding_identity_v1(o.binding_id)->>'live')::boolean, false),
        'last_transfer_receipt_id', (select l.receipt_id from clued_private.integration_binding_ownership_log_v1 l
          where l.binding_id = o.binding_id and l.from_integration_id is not null order by l.recorded_at desc limit 1))
        order by o.binding_id)
      from clued_private.integration_binding_owners_v1 o where o.integration_id = p_integration_id), '[]'::jsonb),
    'identity_claim_evidence_ref', pg_catalog.jsonb_build_object('identity_snapshot_id', i.current_identity_snapshot_id,
      'receipt_id', (select s.receipt_id from clued_private.integration_identity_snapshots_v1 s
                      where s.snapshot_id = i.current_identity_snapshot_id)),
    'canonical_verification_evidence_ref', null, 'last_canonical_verified_at', null,
    'last_successful_resume', case when v_has_cur then (select max(s.started_at) from public.clued_continuity_sessions s
      where s.binding_id = v_cur.binding_id and s.started_at >= v_cur.linked_at) end,
    'last_successful_tool_use', case when v_has_cur then (select pg_catalog.jsonb_build_object('receipt_id', r.id, 'at', r.created_at)
      from public.clued_audit_receipts r where r.binding_id = v_cur.binding_id and r.status = 'committed'
      order by r.created_at desc limit 1) end);
end $$;

-- §5.15 / §10.14 binding_inventory: the owner's live, unowned, non-P5 Bindings. Writes nothing.
create function clued_private.integration_binding_inventory_v1(p_owner uuid)
returns jsonb language sql volatile security definer set search_path='' as $$
  select pg_catalog.jsonb_build_object('bindings', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'binding_id', b.id, 'vendor', b.vendor, 'agent_name', b.agent_name, 'created_at', b.created_at,
      'provider', x->>'provider', 'provider_connection_prefix', pg_catalog.left(x->>'provider_connection_id', 8),
      'connection_kind', x->>'connection_kind') order by b.created_at, b.id), '[]'::jsonb))
    from public.clued_agent_bindings b
    cross join lateral (select clued_private.integration_binding_identity_v1(b.id) x) ident
   where b.user_id = p_owner and not (x->>'p5')::boolean and (x->>'live')::boolean
     and not exists (select 1 from clued_private.integration_binding_owners_v1 o where o.binding_id = b.id)
$$;

-- ---- channel entry points ----------------------------------------------------------------------
create function clued_private.integration_request_hash_v1(p_family text, p_input jsonb)
returns text language sql immutable security invoker set search_path='' as $$
  select clued_private.integration_sha256_v1(pg_catalog.jsonb_build_object('operation', p_family, 'payload', p_input)::text)
$$;

create function public.clued_integration_request_open_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  b := clued_private.integration_auth_binding_v1(p_token_hash, '{}', false);
  if pg_catalog.to_jsonb(b)->>'organization_id' is not null then
    raise exception 'binding_not_adoptable' using errcode = '42501';
  end if;
  return clued_private.integration_request_open_core_v1(pg_catalog.jsonb_build_object('kind', 'binding',
    'binding_id', b.id, 'user_id', b.user_id), b.user_id, coalesce(p_input, '{}'::jsonb));
end $$;

create function public.clued_integration_create_or_bind_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; v_owner uuid;
begin
  b := clued_private.integration_auth_binding_v1(p_token_hash, '{}', true);
  if pg_catalog.to_jsonb(b)->>'organization_id' is not null then
    raise exception 'binding_not_adoptable' using errcode = '42501';
  end if;
  begin
    select owner_id into v_owner from clued_private.integration_installation_requests_v1
     where request_id = (p_input->>'request_id')::uuid;
  exception when others then v_owner := null;
  end;
  if v_owner is null or v_owner <> b.user_id then raise exception 'integration_not_owned' using errcode = '42501'; end if;
  return clued_private.integration_bind_core_v1(pg_catalog.jsonb_build_object('kind', 'binding', 'binding_id', b.id,
    'user_id', b.user_id), b.user_id, p_input, 'BINDING', b.id,
    clued_private.integration_request_hash_v1('integration_create_or_bind', p_input));
end $$;

-- Binding-channel operations on an existing Integration require the caller to be its CURRENT
-- connection; both checks are 403-class and precede the Receipt (§10.1 MINOR-4).
create function clued_private.integration_require_connection_v1(p_binding public.clued_agent_bindings, p_input jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  begin
    v_id := (p_input->>'integration_id')::uuid;
  exception when others then v_id := null;
  end;
  if v_id is null or not exists (select 1 from clued_private.integrations_v1 where integration_id = v_id
                                   and owner_id = p_binding.user_id) then
    raise exception 'integration_not_owned' using errcode = '42501';
  end if;
  if clued_private.integration_current_binding_v1(v_id) is distinct from p_binding.id then
    raise exception 'integration_connection_required' using errcode = '42501';
  end if;
end $$;

create function public.clued_integration_identity_update_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  b := clued_private.integration_auth_binding_v1(p_token_hash, '{}', true);
  perform clued_private.integration_require_connection_v1(b, p_input);
  return clued_private.integration_identity_update_core_v1(pg_catalog.jsonb_build_object('kind', 'binding', 'binding_id', b.id,
    'user_id', b.user_id), b.user_id, p_input, clued_private.integration_request_hash_v1('integration_identity_update', p_input));
end $$;

create function public.clued_integration_reconcile_request_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  b := clued_private.integration_auth_binding_v1(p_token_hash, '{}', true);
  perform clued_private.integration_require_connection_v1(b, p_input);
  return clued_private.integration_reconcile_request_core_v1(pg_catalog.jsonb_build_object('kind', 'binding', 'binding_id', b.id,
    'user_id', b.user_id), b.user_id, p_input, clued_private.integration_request_hash_v1('integration_reconcile', p_input));
end $$;

create function public.clued_integration_status_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; v_id uuid;
begin
  b := clued_private.integration_auth_binding_v1(p_token_hash, '{}', false);
  if coalesce(p_input->'integration_id', 'null'::jsonb) = 'null'::jsonb then
    select c.integration_id into v_id from clued_private.integration_connections_v1 c
     where c.binding_id = b.id and c.link_status = 'CURRENT';
    if v_id is null then
      return pg_catalog.jsonb_build_object('integration', null, 'reason', 'NOT_ADOPTED');
    end if;
  else
    perform clued_private.integration_require_connection_v1(b, p_input);
    v_id := (p_input->>'integration_id')::uuid;
  end if;
  return pg_catalog.jsonb_build_object('integration', clued_private.integration_view_v1(v_id, pg_catalog.clock_timestamp()));
end $$;

-- Native ownership pre-check (§10.1 MINOR-4): unlocked, before any lock and before the Receipt; the
-- core rechecks under its locks.
create function clued_private.integration_native_owned_v1(p_user uuid, p_input jsonb)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_id uuid; v_owner uuid;
begin
  begin
    v_id := (p_input->>'integration_id')::uuid;
  exception when others then v_id := null;
  end;
  select owner_id into v_owner from clued_private.integrations_v1 where integration_id = v_id;
  if v_owner is null or v_owner <> p_user then raise exception 'integration_not_owned' using errcode = '42501'; end if;
  return v_id;
end $$;

-- Native account session (§10.1): one entry point dispatched by op.
create function public.clued_user_integration_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := clued_private.authorization_owner_v12(); v_op text := p_input->>'op'; v_input jsonb := p_input - 'op';
  v_actor jsonb; v_binding uuid; v_owner uuid; v_family text;
begin
  v_actor := pg_catalog.jsonb_build_object('kind', 'native_session', 'binding_id', null, 'user_id', u);
  if v_op = 'request_open' then
    return clued_private.integration_request_open_core_v1(v_actor, u, v_input);
  elsif v_op in ('create_or_bind','confirm_rebind','adopt_binding') then
    if v_op in ('confirm_rebind','adopt_binding') then
      begin
        v_binding := (v_input->>'binding_id')::uuid;
      exception when others then v_binding := null;
      end;
      -- unlocked ownership check first, so no caller can take L1 / L2 on another user's credential rows
      if v_binding is null or not exists (select 1 from public.clued_agent_bindings where id = v_binding and user_id = u) then
        raise exception 'binding_not_owned' using errcode = '42501';
      end if;
      perform clued_private.integration_lock_bindings_v1(array[v_binding]);
      if not exists (select 1 from public.clued_agent_bindings where id = v_binding and user_id = u) then
        raise exception 'binding_not_owned' using errcode = '42501';
      end if;
    end if;
    if v_op in ('create_or_bind','confirm_rebind') then
      begin
        select owner_id into v_owner from clued_private.integration_installation_requests_v1
         where request_id = (v_input->>'request_id')::uuid;
      exception when others then v_owner := null;
      end;
      if v_owner is null or v_owner <> u then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    end if;
    v_family := case when v_op = 'adopt_binding' then 'integration_adopt_binding' else 'integration_create_or_bind' end;
    return clued_private.integration_bind_core_v1(v_actor, u, v_input,
      case v_op when 'create_or_bind' then 'NATIVE_CREATE' when 'confirm_rebind' then 'CONFIRM_REBIND' else 'ADOPT' end,
      v_binding, clued_private.integration_request_hash_v1(v_family, v_input));
  elsif v_op = 'identity_update' then
    perform clued_private.integration_native_owned_v1(u, v_input);
    return clued_private.integration_identity_update_core_v1(v_actor, u, v_input,
      clued_private.integration_request_hash_v1('integration_identity_update', v_input));
  elsif v_op = 'reconcile' then
    perform clued_private.integration_native_owned_v1(u, v_input);
    return clued_private.integration_reconcile_core_v1(v_actor, u, v_input,
      clued_private.integration_request_hash_v1('integration_reconcile', v_input));
  elsif v_op = 'binding_inventory' then
    return clued_private.integration_binding_inventory_v1(u);
  elsif v_op = 'list' then
    return pg_catalog.jsonb_build_object('integrations', coalesce((select pg_catalog.jsonb_agg(
        clued_private.integration_view_v1(i.integration_id, pg_catalog.clock_timestamp()) order by i.created_at desc, i.integration_id)
      from clued_private.integrations_v1 i where i.owner_id = u), '[]'::jsonb));
  elsif v_op = 'status' then
    return pg_catalog.jsonb_build_object('integration', clued_private.integration_view_v1(
      clued_private.integration_native_owned_v1(u, v_input), pg_catalog.clock_timestamp()));
  end if;
  raise exception 'invalid_integration_operation' using errcode = '22023';
end $$;

-- §5.13 / OQ-21: no grant to anyone. The target grants (Binding RPCs to anon, authenticated; the Native
-- entry point to authenticated) ride the flag-enabling stage authorization's own migration.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'clued_private' and p.proname like 'integration\_%' escape '\')
               or (n.nspname = 'public' and (p.proname like 'clued\_integration\_%' escape '\' or p.proname = 'clued_user_integration_v1')) loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
