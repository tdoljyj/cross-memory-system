-- S2c Integration Runtime PR-1 (IntegrationRuntime v0.1.8 §14.1): versioned registries
-- (§5.1: hosts, surfaces, providers, binding domains, capability vocabulary, scope map v1,
-- policy v1, compatibility rules) and the pure derivation functions (§7.3, §8, §9):
--   integration_capabilities_valid_v1, integration_ceiling_valid_v1, integration_version_cmp_v1,
--   integration_facts_validate_v1, integration_candidate_v1, integration_predicates_v1,
--   integration_select_state_v1, integration_derive_v1.
-- SQL is the only authoritative implementation (§8.6); there is no TypeScript mirror.
-- New objects only: no existing function, table, policy or grant is changed (§2.3, T-S-3).
-- Nothing is granted to public, anon, authenticated or service_role (§5.13).
-- READY profiles (§5.1 integration_ready_profiles_v1) belong to PR-3 and are not created here.

-- ---------------------------------------------------------------------------------------------
-- Capability names (§5.1 vocabulary CHECK, §5.1 v0.1.2 NIT-3). Needed by the compatibility-rule
-- CHECK below, so it is created first.
create function clued_private.integration_capabilities_valid_v1(p_capabilities text[])
returns boolean language sql immutable security invoker set search_path='' as $$
  select p_capabilities is not null
     and pg_catalog.array_position(p_capabilities, null) is null
     and p_capabilities operator(pg_catalog.<@) array['context.read','context.write','audit.read','project.read',
       'project.write','evidence.write','development_history.read']::text[]
$$;

-- Authorization ceiling shape (§5.2 CHECK, §10.3 v0.1.2 NIT-2): exactly {scopes, entries};
-- scopes ⊆ v12 scopes, de-duplicated and sorted; entries = "LEGACY_UNRESTRICTED" or a list of
-- v12-shaped entries {resource_kind, resource_id, environment, actions} with non-empty actions
-- and at most one entry per (resource_kind, resource_id, environment) (the v12 primary key).
create function clued_private.integration_ceiling_valid_v1(p_ceiling jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare
  v_scopes jsonb; v_entries jsonb; v_entry jsonb; v_actions jsonb;
  v_scope_list text[]; v_keys text[] := '{}';
begin
  if p_ceiling is null or pg_catalog.jsonb_typeof(p_ceiling) <> 'object' then return false; end if;
  if (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(p_ceiling) k)
     is distinct from array['entries','scopes']::text[] then return false; end if;
  v_scopes := p_ceiling->'scopes';
  if pg_catalog.jsonb_typeof(v_scopes) <> 'array'
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_scopes) e where pg_catalog.jsonb_typeof(e) <> 'string') then
    return false;
  end if;
  v_scope_list := array(select e from pg_catalog.jsonb_array_elements_text(v_scopes) with ordinality t(e, n) order by n);
  if not (v_scope_list operator(pg_catalog.<@) array['context:read','context:write','audit:read']::text[])
     or v_scope_list is distinct from array(select e from (select distinct e from pg_catalog.unnest(v_scope_list) e) s order by e collate "C") then
    return false;
  end if;
  v_entries := p_ceiling->'entries';
  if v_entries = '"LEGACY_UNRESTRICTED"'::jsonb then return true; end if;
  if pg_catalog.jsonb_typeof(v_entries) <> 'array' then return false; end if;
  for v_entry in select e from pg_catalog.jsonb_array_elements(v_entries) e loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object'
       or (select pg_catalog.array_agg(k order by k collate "C") from pg_catalog.jsonb_object_keys(v_entry) k)
          is distinct from array['actions','environment','resource_id','resource_kind']::text[]
       or pg_catalog.jsonb_typeof(v_entry->'resource_kind') <> 'string'
       or (v_entry->>'resource_kind') not in ('scope','context')
       or pg_catalog.jsonb_typeof(v_entry->'resource_id') <> 'string'
       or pg_catalog.char_length(v_entry->>'resource_id') not between 1 and 255
       or pg_catalog.jsonb_typeof(v_entry->'environment') <> 'string'
       or (v_entry->>'environment') not in ('canonical','test','preview','production') then
      return false;
    end if;
    v_actions := v_entry->'actions';
    if pg_catalog.jsonb_typeof(v_actions) <> 'array' or pg_catalog.jsonb_array_length(v_actions) = 0
       or exists (select 1 from pg_catalog.jsonb_array_elements(v_actions) e
                   where pg_catalog.jsonb_typeof(e) <> 'string'
                      or (e #>> '{}') not in ('read','write','close','restore','audit','feedback_submit')) then
      return false;
    end if;
    v_keys := v_keys || ((v_entry->>'resource_kind') || E'\x1f' || (v_entry->>'resource_id') || E'\x1f' || (v_entry->>'environment'));
  end loop;
  return pg_catalog.cardinality(v_keys) = (select count(distinct k) from pg_catalog.unnest(v_keys) k);
end $$;

-- Dotted-numeric version comparison (§5.1 compatibility rules): -1 / 0 / 1, compared segment by
-- segment as numbers with missing trailing segments read as 0; null when either side is not a
-- dotted-numeric string (callers treat null as below_minimum, fail closed).
create function clued_private.integration_version_cmp_v1(p_left text, p_right text)
returns integer language plpgsql immutable security invoker set search_path='' as $$
declare
  v_left text[]; v_right text[]; v_n integer; v_a numeric; v_b numeric;
begin
  if p_left is null or p_right is null
     or p_left !~ '^[0-9]+(\.[0-9]+)*$' or p_right !~ '^[0-9]+(\.[0-9]+)*$' then
    return null;
  end if;
  v_left := pg_catalog.string_to_array(p_left, '.');
  v_right := pg_catalog.string_to_array(p_right, '.');
  v_n := greatest(pg_catalog.cardinality(v_left), pg_catalog.cardinality(v_right));
  for i in 1..v_n loop
    v_a := coalesce(v_left[i], '0')::numeric;
    v_b := coalesce(v_right[i], '0')::numeric;
    if v_a < v_b then return -1; elsif v_a > v_b then return 1; end if;
  end loop;
  return 0;
end $$;

-- ---------------------------------------------------------------------------------------------
-- §5.1 registries. Rows are written only by migrations (new versions are new rows); tests insert
-- their own test.* rows. There is no runtime RPC that writes them.
create table clued_private.integration_hosts_v1 (
  host text primary key check (host ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  tenant_dimension text not null check (tenant_dimension in ('REQUIRED','NOT_APPLICABLE')),
  account_dimension text not null check (account_dimension in ('REQUIRED','NOT_APPLICABLE')),
  tenant_evidence_kinds text[] not null default '{}',
  account_evidence_kinds text[] not null default '{}',
  first_authorization_required boolean not null default true,
  registry_version integer not null check (registry_version >= 1),
  capability_snapshot_ref text not null,
  created_at timestamptz not null default clock_timestamp()
);

create table clued_private.integration_host_surfaces_v1 (
  host text not null references clued_private.integration_hosts_v1(host),
  surface text not null check (surface ~ '^[a-z][a-z0-9_-]{1,39}$'),
  capability_ceiling text[] not null check (clued_private.integration_capabilities_valid_v1(capability_ceiling)),
  host_features jsonb not null,
  registry_version integer not null check (registry_version >= 1),
  primary key (host, surface)
);

create table clued_private.integration_providers_v1 (
  provider text primary key check (provider ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  connection_dimension text not null check (connection_dimension in ('REQUIRED','NOT_APPLICABLE')),
  connection_source text not null check (connection_source in
    ('OAUTH_V12_CLIENT_ID_SHA256','BINDING_ID','HOST_NATIVE_REGISTRY')),
  host_native boolean not null default false,
  registry_version integer not null check (registry_version >= 1)
);

create table clued_private.integration_binding_domains_v1 (
  domain text primary key,
  max_current_holders integer not null check (max_current_holders = 1),
  registry_version integer not null
);

create table clued_private.integration_capability_vocabulary_v1 (
  capability text primary key check (capability in
    ('context.read','context.write','audit.read','project.read','project.write','evidence.write','development_history.read')),
  vocabulary_version integer not null
);

create table clued_private.integration_scope_capability_map_v1 (
  map_version integer not null,
  oauth_scope text not null check (oauth_scope in ('context:read','context:write','audit:read')),
  resource_action text not null check (resource_action in ('read','write','close','restore','audit','feedback_submit')),
  capability text not null references clued_private.integration_capability_vocabulary_v1(capability),
  primary key (map_version, oauth_scope, capability)
);

create table clued_private.integration_policy_v1 (
  policy_version integer primary key,
  incomplete_identity_ordinary_runtime text not null check (incomplete_identity_ordinary_runtime in ('PERMIT','DENY')),
  qualification_not_evaluated text not null check (qualification_not_evaluated in ('NON_BLOCKING','BLOCKING')),
  default_recovery_policy text not null check (default_recovery_policy in ('PERMITS_REAUTH','FORBIDS_REAUTH')),
  canonical_verification_ttl interval not null,
  installation_request_ttl interval not null,
  preclusion_rule text not null check (preclusion_rule in ('ALL_BLOCKING_PREDICATES')),
  created_at timestamptz not null default clock_timestamp()
);

-- Minimum-version compatibility rules (§5.1, v0.1.1 MINOR-8 / v0.1.2 NIT-3); seeded empty.
create table clued_private.integration_compatibility_rules_v1 (
  host text not null references clued_private.integration_hosts_v1(host),
  adapter_family text not null check (char_length(adapter_family) between 1 and 80),
  min_adapter_version text check (min_adapter_version is null or min_adapter_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  min_package_version text check (min_package_version is null or min_package_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  below_minimum text not null check (below_minimum in ('HARD_INCOMPATIBLE','DEGRADED')),
  degraded_mask text[],
  registry_version integer not null check (registry_version >= 1),
  primary key (host, adapter_family, registry_version),
  check ((below_minimum = 'DEGRADED') = (degraded_mask is not null)),
  check (min_adapter_version is not null or min_package_version is not null),
  check (degraded_mask is null or clued_private.integration_capabilities_valid_v1(degraded_mask))
);

-- Seeds (§5.1 "S2c 迁移的初始种子"). Host features follow baseline §24.1 / §55.1 (2026-09-24
-- snapshot): hooks / subagents only on cowork and claude_code; the capability ceiling is the whole
-- vocabulary (narrowing is done by declarations and authorization).
insert into clued_private.integration_hosts_v1(host, tenant_dimension, account_dimension, tenant_evidence_kinds,
  account_evidence_kinds, first_authorization_required, registry_version, capability_snapshot_ref) values
  ('anthropic.claude', 'REQUIRED', 'REQUIRED', '{}', '{}', true, 1, 'v0.2.6 §55.1 2026-09-24'),
  ('openai.chatgpt',   'REQUIRED', 'REQUIRED', '{}', '{}', true, 1, 'v0.2.6 §55.1 2026-09-24'),
  ('generic.mcp',      'REQUIRED', 'REQUIRED', '{}', '{}', true, 1, 'v0.2.6 §55.1 2026-09-24');

insert into clued_private.integration_host_surfaces_v1(host, surface, capability_ceiling, host_features, registry_version)
select h, s, array['audit.read','context.read','context.write','development_history.read','evidence.write',
    'project.read','project.write']::text[],
  pg_catalog.jsonb_build_object('mcp_tools', true, 'oauth', true, 'skills', h <> 'generic.mcp',
    'hooks', s in ('cowork','claude_code'), 'subagents', s in ('cowork','claude_code')), 1
from (values ('anthropic.claude','chat'), ('anthropic.claude','cowork'), ('anthropic.claude','claude_code'),
             ('openai.chatgpt','web'), ('openai.chatgpt','desktop'), ('openai.chatgpt','mobile'),
             ('openai.chatgpt','codex'), ('generic.mcp','default')) t(h, s);

insert into clued_private.integration_providers_v1(provider, connection_dimension, connection_source, host_native, registry_version) values
  ('clued.oauth.v12',  'REQUIRED', 'OAUTH_V12_CLIENT_ID_SHA256', false, 1),
  ('clued.binding.v1', 'REQUIRED', 'BINDING_ID',                 false, 1);

insert into clued_private.integration_binding_domains_v1(domain, max_current_holders, registry_version) values
  ('clued.default.v1', 1, 1);

insert into clued_private.integration_capability_vocabulary_v1(capability, vocabulary_version) values
  ('context.read', 1), ('context.write', 1), ('audit.read', 1), ('project.read', 1), ('project.write', 1),
  ('evidence.write', 1), ('development_history.read', 1);

-- Scope → Capability map v1 (§9.1). integration_candidate_v1 carries the same map as a constant
-- (it must not read tables); the test suite asserts the two are identical.
insert into clued_private.integration_scope_capability_map_v1(map_version, oauth_scope, resource_action, capability) values
  (1, 'context:read',  'read',  'context.read'),
  (1, 'context:read',  'read',  'project.read'),
  (1, 'context:read',  'read',  'development_history.read'),
  (1, 'context:write', 'write', 'context.write'),
  (1, 'context:write', 'write', 'project.write'),
  (1, 'context:write', 'write', 'evidence.write'),
  (1, 'audit:read',    'audit', 'audit.read');

insert into clued_private.integration_policy_v1(policy_version, incomplete_identity_ordinary_runtime,
  qualification_not_evaluated, default_recovery_policy, canonical_verification_ttl, installation_request_ttl, preclusion_rule)
values (1, 'PERMIT', 'NON_BLOCKING', 'PERMITS_REAUTH', interval '30 days', interval '30 minutes', 'ALL_BLOCKING_PREDICATES');

alter table clued_private.integration_hosts_v1 enable row level security;
alter table clued_private.integration_host_surfaces_v1 enable row level security;
alter table clued_private.integration_providers_v1 enable row level security;
alter table clued_private.integration_binding_domains_v1 enable row level security;
alter table clued_private.integration_capability_vocabulary_v1 enable row level security;
alter table clued_private.integration_scope_capability_map_v1 enable row level security;
alter table clued_private.integration_policy_v1 enable row level security;
alter table clued_private.integration_compatibility_rules_v1 enable row level security;
revoke all on table clued_private.integration_hosts_v1, clued_private.integration_host_surfaces_v1,
  clued_private.integration_providers_v1, clued_private.integration_binding_domains_v1,
  clued_private.integration_capability_vocabulary_v1, clued_private.integration_scope_capability_map_v1,
  clued_private.integration_policy_v1, clued_private.integration_compatibility_rules_v1
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- §7.3 facts validation. Returns the §7.3 reason codes in code order (C1 … C10); empty = valid.
-- Schema clued.integration-facts.v1 (§7.1): exactly the top-level keys below, nested objects with
-- exactly their listed keys, upper-case enumerations, capability sets of vocabulary names only
-- (element order and duplicates are not errors; integration_derive_v1 canonicalizes sets), masks
-- present exactly for RESTRICTED / CONDITIONAL / DEGRADED. `connection_store` is the facts-level
-- carrier of C7 (§7.3), which the §7.1 example does not show.
create function clued_private.integration_facts_validate_v1(p_facts jsonb)
returns text[] language plpgsql immutable security invoker set search_path='' as $$
declare
  c1 boolean := false; c9 boolean := false;
  v jsonb; v_name text; v_keys text[]; v_path text[];
  v_codes text[] := '{}';
  v_ic text; v_cs text; v_store text; v_hist text; v_authn text; v_authz text;
  v_vocabulary constant jsonb := '["audit.read","context.read","context.write","development_history.read",
    "evidence.write","project.read","project.write"]';
  v_timestamp constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
  v_enums constant jsonb := '{
    "identity_state": ["VALID","INVALID"],
    "identity_completeness": ["COMPLETE","INCOMPLETE"],
    "identity_claim_state": ["INCOMPLETE_UNCLAIMED","CURRENT_CLAIM_HOLDER","CLAIM_CONFLICT","PENDING_RECONCILE","SUPERSEDED"],
    "claim_store": ["CONSISTENT","MISSING_CURRENT_ROW","UNEXPECTED_CURRENT_ROW","KEY_MISMATCH"],
    "connection_store": ["CONSISTENT","MULTIPLE_CURRENT","FOREIGN_BINDING","OWNER_ROW_MISSING","OWNER_MISMATCH"],
    "authentication_state": ["NONE","USABLE","EXPIRED","INVALIDATED"],
    "authorization_state": ["NOT_GRANTED","GRANTED","GRANTED_LEGACY","EXPIRED","REVOKED_CONNECTION"],
    "revocation_state": ["NOT_REVOKED","REVOKED"],
    "revocation_source": ["NONE","INTEGRATION","CONNECTION_USER_REVOKE"],
    "resource_action_scope_facts.mode": ["ENTRIES","LEGACY_UNRESTRICTED","NONE"],
    "environment_state.value": ["AVAILABLE","RESTRICTED","BLOCKED"],
    "qualification_state.value": ["NOT_EVALUATED","QUALIFIED","CONDITIONAL","SUSPENDED"],
    "compatibility_state.value": ["COMPATIBLE","DEGRADED","HARD_INCOMPATIBLE"],
    "host_state.value": ["AVAILABLE","DEGRADED","HARD_UNAVAILABLE"],
    "adapter_state.value": ["OK","DEGRADED","BLOCKED"],
    "lifecycle_facts.ordinary_runtime": ["PERMITTED","PAUSED_BY_OWNER","PAUSED_BY_POLICY"],
    "lifecycle_facts.historical": ["NONE","SUPERSEDED"],
    "lifecycle_facts.recovery_policy": ["PERMITS_REAUTH","FORBIDS_REAUTH"],
    "installation_facts.install_status": ["PENDING","COMPLETED"],
    "canonical_runtime_verification_facts.status": ["NONE","VALID","EXPIRED","FAILED","INVALIDATED"],
    "policy.incomplete_identity_ordinary_runtime": ["PERMIT","DENY"],
    "policy.qualification_not_evaluated": ["NON_BLOCKING","BLOCKING"],
    "policy.preclusion_rule": ["ALL_BLOCKING_PREDICATES"]}';
begin
  if p_facts is null or pg_catalog.jsonb_typeof(p_facts) <> 'object' then
    return array['C1_SCHEMA_INVALID'];
  end if;

  -- exact key sets of the document and of every nested object
  foreach v_name in array array['', 'policy', 'environment_state', 'qualification_state', 'compatibility_state',
      'host_state', 'adapter_state', 'lifecycle_facts', 'installation_facts', 'canonical_runtime_verification_facts'] loop
    v := case when v_name = '' then p_facts else p_facts->v_name end;
    v_keys := case v_name
      when '' then array['schema','derivation_contract','as_of','policy','capability_universe','identity_state',
        'identity_completeness','identity_claim_state','claim_store','connection_store','authentication_state',
        'authorization_state','reauth_marks_open','oauth_scope_facts','resource_action_scope_facts','environment_state',
        'qualification_state','compatibility_state','revocation_state','revocation_source','host_state','adapter_state',
        'lifecycle_facts','installation_facts','canonical_runtime_verification_facts']
      when 'policy' then array['policy_version','incomplete_identity_ordinary_runtime','qualification_not_evaluated','preclusion_rule']
      when 'host_state' then array['value','mask','surface_ceiling','declared']
      when 'lifecycle_facts' then array['ordinary_runtime','historical','recovery_policy','first_authorization_required']
      when 'installation_facts' then array['install_status','ever_authorized']
      when 'canonical_runtime_verification_facts' then array['status','verification_id','valid_until']
      else array['value','mask'] end;
    if pg_catalog.jsonb_typeof(v) is distinct from 'object' or not (v ?& v_keys) or (v - v_keys) <> '{}'::jsonb then
      c1 := true;
    end if;
  end loop;

  -- enumerations
  foreach v_name in array array['identity_state','identity_completeness','identity_claim_state','claim_store',
      'connection_store','authentication_state','authorization_state','revocation_state','revocation_source',
      'resource_action_scope_facts.mode','environment_state.value','qualification_state.value','compatibility_state.value',
      'host_state.value','adapter_state.value','lifecycle_facts.ordinary_runtime','lifecycle_facts.historical',
      'lifecycle_facts.recovery_policy','installation_facts.install_status','canonical_runtime_verification_facts.status',
      'policy.incomplete_identity_ordinary_runtime','policy.qualification_not_evaluated','policy.preclusion_rule'] loop
    v := p_facts #> pg_catalog.string_to_array(v_name, '.');
    if pg_catalog.jsonb_typeof(v) is distinct from 'string' or not (v <@ (v_enums->v_name)) then
      c1 := true;
    end if;
  end loop;

  -- booleans
  if pg_catalog.jsonb_typeof(p_facts #> '{lifecycle_facts,first_authorization_required}') is distinct from 'boolean'
     or pg_catalog.jsonb_typeof(p_facts #> '{installation_facts,ever_authorized}') is distinct from 'boolean' then
    c1 := true;
  end if;

  -- reauth_marks_open: a non-negative integer
  v := p_facts->'reauth_marks_open';
  if pg_catalog.jsonb_typeof(v) is distinct from 'number'
     or (v #>> '{}')::numeric < 0 or (v #>> '{}')::numeric <> pg_catalog.trunc((v #>> '{}')::numeric) then
    c1 := true;
  end if;

  -- as_of: an ISO-8601 timestamp with an explicit offset (audit only; excluded from facts_sha256)
  v := p_facts->'as_of';
  if pg_catalog.jsonb_typeof(v) is distinct from 'string' or (v #>> '{}') !~ v_timestamp then
    c1 := true;
  end if;

  -- canonical runtime verification reference: uuid / timestamp or JSON null
  v := p_facts #> '{canonical_runtime_verification_facts,verification_id}';
  if not (v = 'null'::jsonb or (pg_catalog.jsonb_typeof(v) = 'string'
       and (v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) or v is null then
    c1 := true;
  end if;
  v := p_facts #> '{canonical_runtime_verification_facts,valid_until}';
  if not (v = 'null'::jsonb or (pg_catalog.jsonb_typeof(v) = 'string' and (v #>> '{}') ~ v_timestamp)) or v is null then
    c1 := true;
  end if;

  -- capability sets: arrays whose elements are vocabulary names (jsonb array containment)
  foreach v_name in array array['capability_universe', 'host_state.surface_ceiling', 'host_state.declared'] loop
    v := p_facts #> pg_catalog.string_to_array(v_name, '.');
    if pg_catalog.jsonb_typeof(v) is distinct from 'array' or not (v <@ v_vocabulary) then
      c1 := true;
    end if;
  end loop;

  -- OAuth scope facts ⊆ {context:read, context:write, audit:read}
  v := p_facts->'oauth_scope_facts';
  if pg_catalog.jsonb_typeof(v) is distinct from 'array' or not (v <@ '["context:read","context:write","audit:read"]'::jsonb) then
    c1 := true;
  end if;

  -- resource/action scope facts: {mode: ENTRIES, capabilities} | {mode: LEGACY_UNRESTRICTED} | {mode: NONE}
  v := p_facts->'resource_action_scope_facts';
  if pg_catalog.jsonb_typeof(v) is distinct from 'object' then
    c1 := true;
  elsif v->>'mode' = 'ENTRIES' then
    if not (v ?& array['mode','capabilities']) or (v - array['mode','capabilities']) <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(v->'capabilities') is distinct from 'array' or not ((v->'capabilities') <@ v_vocabulary) then
      c1 := true;
    end if;
  elsif (v - 'mode') <> '{}'::jsonb then
    c1 := true;
  end if;

  -- masks: a capability array exactly for RESTRICTED / CONDITIONAL / DEGRADED, JSON null otherwise
  foreach v_name in array array['environment_state', 'qualification_state', 'compatibility_state', 'host_state',
      'adapter_state'] loop
    v := p_facts #> array[v_name, 'mask'];
    if (p_facts #>> array[v_name, 'value']) in ('RESTRICTED','CONDITIONAL','DEGRADED') then
      if pg_catalog.jsonb_typeof(v) is distinct from 'array' or not (v <@ v_vocabulary) then
        c1 := true;
      end if;
    elsif v is distinct from 'null'::jsonb then
      c1 := true;
    end if;
  end loop;

  -- revocation_state and revocation_source are one truth class (§7.2): REVOKED ⇔ source ≠ NONE
  if (p_facts->>'revocation_state' = 'REVOKED') is distinct from (p_facts->>'revocation_source' <> 'NONE') then
    c1 := true;
  end if;

  -- C9: schema / derivation contract / policy version unknown (a non-string / non-integer is C1)
  v := p_facts->'schema';
  if pg_catalog.jsonb_typeof(v) = 'string' then
    if (v #>> '{}') <> 'clued.integration-facts.v1' then c9 := true; end if;
  else c1 := true; end if;
  v := p_facts->'derivation_contract';
  if pg_catalog.jsonb_typeof(v) = 'string' then
    if (v #>> '{}') <> 'clued.integration-derivation.v1' then c9 := true; end if;
  else c1 := true; end if;
  v := p_facts #> '{policy,policy_version}';
  if pg_catalog.jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric = pg_catalog.trunc((v #>> '{}')::numeric) then
    if (v #>> '{}')::numeric <> 1 then c9 := true; end if;
  else c1 := true; end if;

  v_ic := p_facts->>'identity_completeness';
  v_cs := p_facts->>'identity_claim_state';
  v_store := p_facts->>'claim_store';
  v_hist := p_facts #>> '{lifecycle_facts,historical}';
  v_authn := p_facts->>'authentication_state';
  v_authz := p_facts->>'authorization_state';

  if c1 then v_codes := v_codes || 'C1_SCHEMA_INVALID'::text; end if;
  if v_ic = 'COMPLETE' and v_cs = 'INCOMPLETE_UNCLAIMED' then
    v_codes := v_codes || 'C2_COMPLETE_BUT_UNCLAIMED'::text;
  end if;
  if v_ic = 'INCOMPLETE' and v_cs <> 'INCOMPLETE_UNCLAIMED' then
    v_codes := v_codes || 'C3_INCOMPLETE_BUT_CLAIM_STATE'::text;
  end if;
  -- §7.2: a claim_store value other than CONSISTENT is always C4 or C5
  if v_store in ('MISSING_CURRENT_ROW','KEY_MISMATCH') then
    v_codes := v_codes || 'C4_CLAIM_STORE_MISSING'::text;
  end if;
  if v_store = 'UNEXPECTED_CURRENT_ROW' then
    v_codes := v_codes || 'C5_CLAIM_STORE_UNEXPECTED'::text;
  end if;
  if (v_cs = 'SUPERSEDED') <> (v_hist = 'SUPERSEDED') then
    v_codes := v_codes || 'C6_SUPERSEDED_LIFECYCLE_MISMATCH'::text;
  end if;
  if p_facts->>'connection_store' in ('MULTIPLE_CURRENT','FOREIGN_BINDING','OWNER_ROW_MISSING','OWNER_MISMATCH') then
    v_codes := v_codes || 'C7_CONNECTION_CARDINALITY'::text;
  end if;
  if v_authn = 'USABLE' and v_authz in ('GRANTED','GRANTED_LEGACY')
     and (p_facts #> '{installation_facts,ever_authorized}') = 'false'::jsonb then
    v_codes := v_codes || 'C8_AUTH_WITHOUT_EVER_AUTHORIZED'::text;
  end if;
  if c9 then v_codes := v_codes || 'C9_CONTRACT_UNKNOWN'::text; end if;
  if (v_authn = 'NONE') <> (v_authz = 'NOT_GRANTED') then
    v_codes := v_codes || 'C10_AUTHZ_WITHOUT_AUTHN'::text;
  end if;
  return v_codes;
end $$;

-- ---------------------------------------------------------------------------------------------
-- §9.2 Candidate Ordinary Capability Set = Candidate(f, claim_permits, authn_ok, authz_ok).
-- The three gates come from integration_predicates_v1 (§8.3), the only place they are defined.
-- Requires facts that passed integration_facts_validate_v1. The result is the intersection of all
-- thirteen factors, returned as a byte-order sorted set (each capability is tested against every
-- factor; vocabulary order is the sorted order).
create function clued_private.integration_candidate_v1(p_facts jsonb, p_claim_permits boolean,
  p_authn_ok boolean, p_authz_ok boolean)
returns text[] language plpgsql immutable security invoker set search_path='' as $$
declare
  c text;
  v_out text[] := '{}';
  v_resource text := p_facts #>> '{resource_action_scope_facts,mode}';
  v_environment text := p_facts #>> '{environment_state,value}';
  v_host text := p_facts #>> '{host_state,value}';
  v_adapter text := p_facts #>> '{adapter_state,value}';
  v_qualification text := p_facts #>> '{qualification_state,value}';
  v_compatibility text := p_facts #>> '{compatibility_state,value}';
begin
  -- Clued Identity validity, Stable Identity Claim, Authentication, Authorization, Revocation,
  -- Policy (PAUSED_BY_POLICY), Resource mode NONE and every "→ ∅" value are whole-set factors
  if p_facts->>'identity_state' <> 'VALID' or p_claim_permits is not true or p_authn_ok is not true
     or p_authz_ok is not true or p_facts->>'revocation_state' <> 'NOT_REVOKED'
     or p_facts #>> '{lifecycle_facts,ordinary_runtime}' = 'PAUSED_BY_POLICY'
     or v_resource = 'NONE' or v_environment = 'BLOCKED' or v_host = 'HARD_UNAVAILABLE' or v_adapter = 'BLOCKED'
     or v_qualification = 'SUSPENDED'
     or (v_qualification = 'NOT_EVALUATED' and p_facts #>> '{policy,qualification_not_evaluated}' = 'BLOCKING')
     or v_compatibility = 'HARD_INCOMPATIBLE' then
    return v_out;
  end if;
  foreach c in array array['audit.read','context.read','context.write','development_history.read','evidence.write',
      'project.read','project.write'] loop
    if (p_facts->'capability_universe') ? c
       -- OAuth Scope via scope map v1 (§9.1; the same rows as integration_scope_capability_map_v1)
       and (p_facts->'oauth_scope_facts') ? (case when c in ('context.read','project.read','development_history.read') then 'context:read'
                                                  when c in ('context.write','project.write','evidence.write') then 'context:write'
                                                  else 'audit:read' end)
       -- Resource / Action / Scope: LEGACY_UNRESTRICTED → U, ENTRIES → mapped capabilities
       and (v_resource = 'LEGACY_UNRESTRICTED' or (p_facts #> '{resource_action_scope_facts,capabilities}') ? c)
       -- Environment: AVAILABLE → U, RESTRICTED → mask
       and (v_environment = 'AVAILABLE' or (p_facts #> '{environment_state,mask}') ? c)
       -- Host Capability: surface ceiling ∩ latest declaration, DEGRADED → ∩ mask
       and (p_facts #> '{host_state,surface_ceiling}') ? c and (p_facts #> '{host_state,declared}') ? c
       and (v_host = 'AVAILABLE' or (p_facts #> '{host_state,mask}') ? c)
       -- Adapter Capability: OK → U, DEGRADED → mask
       and (v_adapter = 'OK' or (p_facts #> '{adapter_state,mask}') ? c)
       -- Qualification: QUALIFIED / NOT_EVALUATED (NON_BLOCKING) → U, CONDITIONAL → mask
       and (v_qualification <> 'CONDITIONAL' or (p_facts #> '{qualification_state,mask}') ? c)
       -- Compatibility: COMPATIBLE → U, DEGRADED → mask
       and (v_compatibility = 'COMPATIBLE' or (p_facts #> '{compatibility_state,mask}') ? c) then
      v_out := v_out || c;
    end if;
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------------------------
-- §8.3 predicates of clued.integration-derivation.v1 → the predicate vector consumed by
-- integration_select_state_v1. Requires facts that passed integration_facts_validate_v1.
create function clued_private.integration_predicates_v1(p_facts jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare
  v_cs text := p_facts->>'identity_claim_state';
  v_complete boolean; v_claim_block boolean; v_claim_permits boolean;
  v_authn_ok boolean; v_authz_ok boolean; v_auth_ok boolean;
  v_installed boolean; v_ever_auth boolean; v_credential_lost boolean;
  v_lifecycle_ok boolean; v_reauth_recoverable boolean; v_cand text[];
  b boolean[]; v_blocked boolean; v_precluded boolean; v_eligible boolean;
  v_crv_valid boolean; v_degradation text[] := '{}'; v_blocking text[] := '{}';
  v_names constant text[] := array['B1_identity_claim','B2_identity_invalid','B3_lifecycle','B4_qualification',
    'B5_host','B6_adapter','B7_environment','B8_candidate_empty','B9_unrecoverable_auth'];
begin
  v_complete := p_facts->>'identity_completeness' = 'COMPLETE';
  v_claim_block := v_cs in ('CLAIM_CONFLICT','PENDING_RECONCILE','SUPERSEDED')
                   or (v_complete and v_cs <> 'CURRENT_CLAIM_HOLDER');
  v_claim_permits := not v_claim_block and (case when v_complete then v_cs = 'CURRENT_CLAIM_HOLDER'
                     else p_facts #>> '{policy,incomplete_identity_ordinary_runtime}' = 'PERMIT' end);
  v_authn_ok := p_facts->>'authentication_state' = 'USABLE';
  v_authz_ok := p_facts->>'authorization_state' in ('GRANTED','GRANTED_LEGACY')
                and (p_facts->>'reauth_marks_open')::numeric = 0;
  v_auth_ok := v_authn_ok and v_authz_ok;
  v_installed := p_facts #>> '{installation_facts,install_status}' = 'COMPLETED';
  v_ever_auth := (p_facts #> '{installation_facts,ever_authorized}') = 'true'::jsonb;
  v_credential_lost := v_ever_auth and not v_auth_ok;
  v_lifecycle_ok := p_facts #>> '{lifecycle_facts,ordinary_runtime}' = 'PERMITTED'
                    and p_facts #>> '{lifecycle_facts,historical}' = 'NONE';
  -- v0.1.1 MAJOR-2: a historical (SUPERSEDED) Integration has no reauthorization path
  v_reauth_recoverable := p_facts #>> '{lifecycle_facts,recovery_policy}' = 'PERMITS_REAUTH'
                          and p_facts #>> '{lifecycle_facts,historical}' = 'NONE';
  v_cand := clued_private.integration_candidate_v1(p_facts, v_claim_permits, v_authn_ok, v_authz_ok);

  -- non-reauth blocking predicates (versioned list; order irrelevant)
  b := array[
    v_claim_block,                                                                   -- B1
    p_facts->>'identity_state' = 'INVALID',                                          -- B2
    not v_lifecycle_ok,                                                              -- B3
    p_facts #>> '{qualification_state,value}' = 'SUSPENDED'
      or (p_facts #>> '{qualification_state,value}' = 'NOT_EVALUATED'
          and p_facts #>> '{policy,qualification_not_evaluated}' = 'BLOCKING'),       -- B4
    p_facts #>> '{host_state,value}' = 'HARD_UNAVAILABLE',                           -- B5
    p_facts #>> '{adapter_state,value}' = 'BLOCKED',                                 -- B6
    p_facts #>> '{environment_state,value}' = 'BLOCKED',                             -- B7
    v_installed and v_auth_ok and pg_catalog.cardinality(v_cand) = 0,                -- B8 (phase-qualified, OQ-1)
    v_credential_lost and not v_reauth_recoverable                                   -- B9
  ];
  for i in 1..9 loop
    if b[i] then v_blocking := v_blocking || v_names[i]; end if;
  end loop;
  v_blocked := pg_catalog.cardinality(v_blocking) > 0;
  -- preclusion_rule = ALL_BLOCKING_PREDICATES (policy v1, OQ-8; the only value validation admits)
  v_precluded := v_blocked;
  v_eligible := v_installed and v_auth_ok and not v_claim_block and not v_precluded and v_lifecycle_ok
                and p_facts #>> '{host_state,value}' <> 'HARD_UNAVAILABLE'
                and p_facts #>> '{adapter_state,value}' <> 'BLOCKED';
  v_crv_valid := p_facts #>> '{canonical_runtime_verification_facts,status}' = 'VALID';
  if p_facts #>> '{adapter_state,value}' = 'DEGRADED' then v_degradation := v_degradation || 'adapter_state'::text; end if;
  if p_facts #>> '{compatibility_state,value}' = 'DEGRADED' then v_degradation := v_degradation || 'compatibility_state'::text; end if;
  if p_facts #>> '{environment_state,value}' = 'RESTRICTED' then v_degradation := v_degradation || 'environment_state'::text; end if;
  if p_facts #>> '{host_state,value}' = 'DEGRADED' then v_degradation := v_degradation || 'host_state'::text; end if;
  if p_facts #>> '{qualification_state,value}' = 'CONDITIONAL' then v_degradation := v_degradation || 'qualification_state'::text; end if;

  return pg_catalog.jsonb_build_object(
    'identity_claim_blocks_ordinary_runtime', v_claim_block,
    'verification_precluded_by_blocking_fact', v_precluded,
    'verification_eligible', v_eligible,
    'blocking', pg_catalog.to_jsonb(v_blocking),
    'degradation', pg_catalog.to_jsonb(v_degradation),
    'credential_lost', v_credential_lost,
    'reauth_recoverable', v_reauth_recoverable,
    'complete', v_complete,
    'claim_permits', v_claim_permits,
    'authn_ok', v_authn_ok,
    'authz_ok', v_authz_ok,
    'auth_ok', v_auth_ok,
    'installed', v_installed,
    'ever_authorized', v_ever_auth,
    'first_authorization_required', (p_facts #> '{lifecycle_facts,first_authorization_required}') = 'true'::jsonb,
    'lifecycle_ok', v_lifecycle_ok,
    'revoked', p_facts->>'revocation_state' = 'REVOKED',
    'hard_incompatible', p_facts #>> '{compatibility_state,value}' = 'HARD_INCOMPATIBLE',
    'blocked', v_blocked,
    'crv_valid', v_crv_valid,
    'degraded', pg_catalog.cardinality(v_degradation) > 0,
    'candidate_empty', pg_catalog.cardinality(v_cand) = 0,
    'candidate_ordinary_capabilities', pg_catalog.to_jsonb(v_cand));
end $$;

-- ---------------------------------------------------------------------------------------------
-- §8.4 precedence over the predicate vector. Total: the last branch is unconditional. Each branch
-- is one line so the T-A7-8 mutation test can swap the VERIFYING and BLOCKED branches.
create function clued_private.integration_select_state_v1(p_vector jsonb)
returns text language plpgsql immutable security invoker set search_path='' as $$
declare
  v_key text;
  revoked boolean; hard_incompatible boolean; credential_lost boolean; reauth_recoverable boolean;
  installed boolean; first_authorization_required boolean; ever_authorized boolean;
  verification_eligible boolean; crv_valid boolean; blocked boolean; candidate_empty boolean;
  lifecycle_ok boolean; degraded boolean;
begin
  foreach v_key in array array['revoked','hard_incompatible','credential_lost','reauth_recoverable','installed',
      'first_authorization_required','ever_authorized','verification_eligible','crv_valid','blocked',
      'candidate_empty','lifecycle_ok','degraded'] loop
    if pg_catalog.jsonb_typeof(p_vector->v_key) is distinct from 'boolean' then
      raise exception 'integration_predicate_vector_invalid' using errcode = '22023', detail = v_key;
    end if;
  end loop;
  revoked := (p_vector->'revoked')::boolean;
  hard_incompatible := (p_vector->'hard_incompatible')::boolean;
  credential_lost := (p_vector->'credential_lost')::boolean;
  reauth_recoverable := (p_vector->'reauth_recoverable')::boolean;
  installed := (p_vector->'installed')::boolean;
  first_authorization_required := (p_vector->'first_authorization_required')::boolean;
  ever_authorized := (p_vector->'ever_authorized')::boolean;
  verification_eligible := (p_vector->'verification_eligible')::boolean;
  crv_valid := (p_vector->'crv_valid')::boolean;
  blocked := (p_vector->'blocked')::boolean;
  candidate_empty := (p_vector->'candidate_empty')::boolean;
  lifecycle_ok := (p_vector->'lifecycle_ok')::boolean;
  degraded := (p_vector->'degraded')::boolean;

  if revoked then return 'REVOKED';                                                                   -- branch:REVOKED
  elsif hard_incompatible then return 'INCOMPATIBLE';                                                 -- branch:INCOMPATIBLE
  elsif credential_lost and reauth_recoverable then return 'REAUTH_REQUIRED';                         -- branch:REAUTH_REQUIRED
  elsif installed and first_authorization_required and not ever_authorized then return 'AUTH_PENDING'; -- branch:AUTH_PENDING
  elsif verification_eligible and not crv_valid then return 'VERIFYING';                              -- branch:VERIFYING
  elsif blocked then return 'BLOCKED';                                                                -- branch:BLOCKED
  elsif installed and not candidate_empty and lifecycle_ok and crv_valid and degraded then return 'DEGRADED'; -- branch:DEGRADED
  elsif installed and not candidate_empty and lifecycle_ok and crv_valid then return 'ACTIVE';        -- branch:ACTIVE
  elsif installed then return 'INSTALLED';                                                            -- branch:INSTALLED
  else return 'INSTALL_PENDING';                                                                      -- branch:INSTALL_PENDING
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- §8.2 derivation: validate → (fail closed) → predicates → state → Operability / Effective (§9.4).
-- facts_sha256 = sha256((facts − 'as_of')::text) over the canonical form (§7.1 rule 1): every set
-- is sorted in byte order and de-duplicated, so reordered keys or set elements hash identically.
create function clued_private.integration_derive_v1(p_facts jsonb)
returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare
  v_contract constant text := 'clued.integration-derivation.v1';
  v_vocabulary constant text[] := array['audit.read','context.read','context.write','development_history.read',
    'evidence.write','project.read','project.write'];
  v_scopes constant text[] := array['audit:read','context:read','context:write'];
  v_canon jsonb := p_facts;
  v_name text; v_path text[]; v_set jsonb; v_list text[]; v_sorted text[]; c text;
  v_codes text[]; v_sha text; v_vector jsonb; v_state text; v_operable boolean;
begin
  if pg_catalog.jsonb_typeof(p_facts) = 'object' then
    foreach v_name in array array['capability_universe', 'oauth_scope_facts', 'resource_action_scope_facts.capabilities',
        'environment_state.mask', 'qualification_state.mask', 'compatibility_state.mask', 'host_state.mask',
        'host_state.surface_ceiling', 'host_state.declared', 'adapter_state.mask'] loop
      v_path := pg_catalog.string_to_array(v_name, '.');
      v_set := v_canon #> v_path;
      if pg_catalog.jsonb_typeof(v_set) = 'array' then
        v_list := case when v_name = 'oauth_scope_facts' then v_scopes else v_vocabulary end;
        if v_set <@ pg_catalog.to_jsonb(v_list) then
          -- a set of known names: filter the sorted constant list (sorted and de-duplicated)
          v_sorted := '{}';
          foreach c in array v_list loop
            if v_set ? c then v_sorted := v_sorted || c; end if;
          end loop;
          v_set := pg_catalog.to_jsonb(v_sorted);
        else
          v_set := (select coalesce(pg_catalog.jsonb_agg(e order by pg_catalog.jsonb_typeof(e) collate "C",
                      (e #>> '{}') collate "C", e::text collate "C"), '[]'::jsonb)
                    from (select distinct e from pg_catalog.jsonb_array_elements(v_set) e) s);
        end if;
        v_canon := pg_catalog.jsonb_set(v_canon, v_path, v_set);
      end if;
    end loop;
    v_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((v_canon - 'as_of')::text, 'UTF8')), 'hex');
  else
    v_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_facts::text, 'null'), 'UTF8')), 'hex');
  end if;

  v_codes := clued_private.integration_facts_validate_v1(p_facts);
  if pg_catalog.cardinality(v_codes) > 0 then
    -- DERIVATION_INPUT_INVALID (§7.3): no state, not operable, empty candidate / effective sets
    return pg_catalog.jsonb_build_object('valid', false, 'reason_codes', pg_catalog.to_jsonb(v_codes),
      'derivation_contract', v_contract, 'facts_sha256', v_sha, 'predicates', null,
      'candidate_ordinary_capabilities', '[]'::jsonb, 'integration_state', null,
      'integration_operable', false, 'effective_capabilities', '[]'::jsonb);
  end if;

  v_vector := clued_private.integration_predicates_v1(v_canon);
  v_state := clued_private.integration_select_state_v1(v_vector);
  -- §9.4 Operable := cand ≠ ∅ ∧ lifecycle_ok ∧ crv_valid ∧ state ∈ {ACTIVE, DEGRADED}; Effective := Operable ? cand : ∅
  v_operable := not (v_vector->>'candidate_empty')::boolean and (v_vector->>'lifecycle_ok')::boolean
                and (v_vector->>'crv_valid')::boolean and v_state in ('ACTIVE','DEGRADED');
  return pg_catalog.jsonb_build_object('valid', true, 'reason_codes', '[]'::jsonb,
    'derivation_contract', v_contract, 'facts_sha256', v_sha,
    'predicates', v_vector - 'candidate_ordinary_capabilities',
    'candidate_ordinary_capabilities', v_vector->'candidate_ordinary_capabilities',
    'integration_state', v_state, 'integration_operable', v_operable,
    'effective_capabilities', (case when v_operable then v_vector->'candidate_ordinary_capabilities' else '[]'::jsonb end));
end $$;

revoke all on function clued_private.integration_capabilities_valid_v1(text[]),
  clued_private.integration_ceiling_valid_v1(jsonb),
  clued_private.integration_version_cmp_v1(text, text),
  clued_private.integration_facts_validate_v1(jsonb),
  clued_private.integration_candidate_v1(jsonb, boolean, boolean, boolean),
  clued_private.integration_predicates_v1(jsonb),
  clued_private.integration_select_state_v1(jsonb),
  clued_private.integration_derive_v1(jsonb)
  from public, anon, authenticated, service_role;
