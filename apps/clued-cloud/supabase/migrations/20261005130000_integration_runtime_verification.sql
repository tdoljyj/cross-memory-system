-- S2c Integration Runtime PR-3 (IntegrationRuntime v0.1.8 §14.1, Owner Decision 67a70fcf): A / B
-- verification write RPCs, READY profiles, integration_ready_project_v1 and its READY projection Receipt,
-- and the declare / report / fact_set / fact_clear operations.
--
-- Placement choices this migration makes inside the frozen §14.1 PR list (recorded in the PR body):
--   (a) The A-class table, integration_facts_v1 and integration_capability_declarations_v1 already exist
--       read-only (PR-2 placement choices (a) and (b)); this migration adds their write operations.
--   (b) READY evidence rules (§5.1 evidence_rules, §10.8: "规则由 profile 定义（S3 定稿）") are given a
--       minimal v1 shape so that a profile row can be checked by a CHECK: an object with exactly one rule
--       per required capability, each {"kind":"resume_after_link"} or {"kind":"committed_receipt_after_link",
--       "families":[...]}. A family may not be one of the Integration runtime's own (integration_*): those
--       Receipts are written by verify / status themselves and are not evidence of ordinary use (a FAIL
--       ready verification's committed Receipt would otherwise prove the next one). No production profile
--       is seeded (§5.1); tests bring their own.
--   (c) report (§10.6) takes action 'set' | 'clear'. An adapter may only set a narrowing value
--       (host_state DEGRADED / HARD_UNAVAILABLE, adapter_state DEGRADED / BLOCKED); returning to the healthy
--       value is a 'clear' of its own report. Every other class, and a healthy value, is
--       adapter_report_cannot_expand.
--   (d) The Operator channel public.clued_admin_integration_v1 is created with the PR-3 ops only
--       (fact_set, fact_clear, status); PR-4 adds the revocation / lifecycle ops.
--   (e) CRV-3 (§10.7) accepts a null build_sha (a Worker build without a 40-hex build SHA injects null)
--       and treats a missing or malformed transport as FAIL; SUPPORTED_MCP_VERSIONS mirrors
--       worker/continuity.ts.
--   (f) The B-class write (§10.8) neither takes L5 FOR UPDATE nor bumps integrations_v1.version: it holds
--       the Integration row FOR SHARE, checks base_version, and writes only its own table, the Receipt and
--       the operation log (T-A8-2). It therefore never materializes a connection revoke: a revoked
--       Integration is rejected before any write.
-- PR-2 objects replaced with create or replace (same signatures and privileges): the Binding status entry
-- point and the Native dispatcher, to carry the READY projection (§10.9). No object older than S2c is
-- changed (§2.3, T-S-3). OQ-15 stays: no Event is written. Nothing is granted (§5.13, OQ-21).

-- =============================================================================================
-- Part A: tables (§5.1 READY profiles, §5.8)
-- =============================================================================================

-- placement choice (b): one rule per required capability and nothing else
create function clued_private.integration_ready_rules_valid_v1(p_required text[], p_rules jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare v_key text; v_rule jsonb; v_family jsonb;
begin
  if p_required is null or not clued_private.integration_capabilities_valid_v1(p_required)
     or pg_catalog.cardinality(p_required) < 1
     or pg_catalog.cardinality(p_required) <> (select count(distinct x) from pg_catalog.unnest(p_required) x)
     or p_rules is null or pg_catalog.jsonb_typeof(p_rules) <> 'object' then
    return false;
  end if;
  if (select count(*) from pg_catalog.jsonb_object_keys(p_rules)) <> pg_catalog.cardinality(p_required) then
    return false;
  end if;
  for v_key, v_rule in select k, v from pg_catalog.jsonb_each(p_rules) e(k, v) loop
    if not (v_key = any(p_required)) or pg_catalog.jsonb_typeof(v_rule) <> 'object' then return false; end if;
    if v_rule->>'kind' = 'resume_after_link' then
      if (v_rule - 'kind') <> '{}'::jsonb then return false; end if;
    elsif v_rule->>'kind' = 'committed_receipt_after_link' then
      if (v_rule - 'kind' - 'families') <> '{}'::jsonb or pg_catalog.jsonb_typeof(v_rule->'families') is distinct from 'array'
         or pg_catalog.jsonb_array_length(v_rule->'families') not between 1 and 32 then
        return false;
      end if;
      for v_family in select f from pg_catalog.jsonb_array_elements(v_rule->'families') f loop
        if pg_catalog.jsonb_typeof(v_family) <> 'string' or pg_catalog.char_length(v_family #>> '{}') not between 1 and 80
           or (v_family #>> '{}') like 'integration\_%' then
          return false;
        end if;
      end loop;
    else
      return false;
    end if;
  end loop;
  return true;
end $$;

create table clued_private.integration_ready_profiles_v1 (
  profile_id text not null check (profile_id ~ '^[a-z][a-z0-9_.-]{2,79}$'),
  profile_version integer not null check (profile_version >= 1),
  required_capabilities text[] not null check (pg_catalog.cardinality(required_capabilities) >= 1),
  required_qualification text not null check (required_qualification in ('ANY','QUALIFIED')),
  evidence_rules jsonb not null,
  freshness_ttl interval not null check (freshness_ttl > interval '0'),
  primary key (profile_id, profile_version),
  check (clued_private.integration_ready_rules_valid_v1(required_capabilities, evidence_rules))
);

create table clued_private.integration_ready_verifications_v1 (
  verification_id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references clued_private.integrations_v1(integration_id),
  verification_class text not null default 'READY_PROFILE_VERIFICATION' check (verification_class = 'READY_PROFILE_VERIFICATION'),
  profile_id text not null,
  profile_version integer not null,
  result text not null check (result in ('PASS','FAIL')),
  checks jsonb not null,
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_id uuid not null,
  verified_at timestamptz not null default clock_timestamp(),
  valid_until timestamptz not null,
  foreign key (profile_id, profile_version) references clued_private.integration_ready_profiles_v1(profile_id, profile_version)
);
create index integration_ready_verifications_v1_latest
  on clued_private.integration_ready_verifications_v1(integration_id, profile_id, profile_version, verified_at desc);

alter table clued_private.integration_ready_profiles_v1 enable row level security;
alter table clued_private.integration_ready_verifications_v1 enable row level security;
revoke all on clued_private.integration_ready_profiles_v1, clued_private.integration_ready_verifications_v1
  from public, anon, authenticated, service_role;

-- =============================================================================================
-- Part B: READY projection (§9.5)
-- =============================================================================================

-- placement choice (e): the MCP protocol versions worker/continuity.ts SUPPORTED_MCP_VERSIONS accepts
create function clued_private.integration_supported_mcp_versions_v1()
returns text[] language sql immutable security invoker set search_path='' as $$
  select array['2026-07-28','2025-11-25','2025-06-18','2025-03-26']::text[]
$$;

-- §9.5 READY(profile) for one profile, given the Canonical evaluation e at p_as_of. Reads only e, the
-- profile, the B-class table and the Receipt table; never writes.
create function clued_private.integration_ready_assess_v1(p_integration_id uuid, p_profile_id text,
  p_profile_version integer, p_as_of timestamptz, p_evaluation jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p clued_private.integration_ready_profiles_v1; r clued_private.integration_ready_verifications_v1;
  v_found boolean; v_reasons text[] := '{}'; v_missing text[];
begin
  select * into p from clued_private.integration_ready_profiles_v1
   where profile_id = p_profile_id and profile_version = p_profile_version;
  if not found then raise exception 'ready_profile_unknown' using errcode = '42501'; end if;
  select * into r from clued_private.integration_ready_verifications_v1
   where integration_id = p_integration_id and profile_id = p_profile_id and profile_version = p_profile_version
     and verified_at <= p_as_of
   order by verified_at desc, verification_id desc limit 1;
  v_found := found;
  if not coalesce((p_evaluation->>'valid')::boolean, false) then
    v_reasons := v_reasons || 'DERIVATION_INPUT_INVALID'::text;
  end if;
  if not coalesce((p_evaluation->>'integration_operable')::boolean, false) then
    v_reasons := v_reasons || 'NOT_OPERABLE'::text;
  end if;
  v_missing := array(select c from pg_catalog.unnest(p.required_capabilities) c
                      where not coalesce(p_evaluation->'effective_capabilities', '[]'::jsonb) ? c order by c collate "C");
  if pg_catalog.cardinality(v_missing) > 0 then v_reasons := v_reasons || 'CAPABILITY_NOT_EFFECTIVE'::text; end if;
  if p.required_qualification = 'QUALIFIED'
     and p_evaluation #>> '{facts,qualification_state,value}' is distinct from 'QUALIFIED' then
    v_reasons := v_reasons || 'QUALIFICATION_REQUIRED'::text;
  end if;
  if not v_found then
    v_reasons := v_reasons || 'READY_VERIFICATION_NONE'::text;
  else
    if r.result <> 'PASS' then v_reasons := v_reasons || 'READY_VERIFICATION_FAILED'::text; end if;
    if r.subject_digest is distinct from clued_private.integration_subject_digest_v1(p_integration_id) then
      v_reasons := v_reasons || 'READY_VERIFICATION_INVALIDATED'::text;
    end if;
    if r.valid_until <= p_as_of then v_reasons := v_reasons || 'READY_VERIFICATION_EXPIRED'::text; end if;
    if r.evidence_sha256 is null
       or not exists (select 1 from public.clued_audit_receipts a where a.id = r.receipt_id) then
      v_reasons := v_reasons || 'READY_VERIFICATION_EVIDENCE_MISSING'::text;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'profile', pg_catalog.jsonb_build_object('id', p.profile_id, 'version', p.profile_version),
    'ready', pg_catalog.cardinality(v_reasons) = 0,
    'reasons', pg_catalog.to_jsonb(v_reasons),
    'missing_capabilities', pg_catalog.to_jsonb(v_missing),
    'integration_state', p_evaluation->'integration_state',
    'effective_capabilities', coalesce(p_evaluation->'effective_capabilities', '[]'::jsonb),
    'facts_sha256', p_evaluation->'facts_sha256',
    'canonical_verification_id', p_evaluation #> '{facts,canonical_runtime_verification_facts,verification_id}',
    'ready_verification_id', case when v_found then pg_catalog.to_jsonb(r.verification_id) else 'null'::jsonb end,
    'ready_verification_evidence_ref', case when v_found then pg_catalog.jsonb_build_object('verification_id', r.verification_id,
      'receipt_id', r.receipt_id, 'evidence_sha256', r.evidence_sha256) else 'null'::jsonb end,
    'last_ready_profile_verified_at', case when v_found then pg_catalog.to_jsonb(r.verified_at) else 'null'::jsonb end,
    'as_of', clued_private.integration_instant_text_v1(p_as_of));
end $$;

-- §9.5 integration_ready_project_v1 (the frozen signature): e := integration_evaluate_v1(id, as_of), then
-- the profile projection. Writes no Canonical table (evaluate may record a §7.3 diagnostic).
create function clued_private.integration_ready_project_v1(p_integration_id uuid, p_profile_id text,
  p_profile_version integer, p_as_of timestamptz)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if not exists (select 1 from clued_private.integration_ready_profiles_v1
                  where profile_id = p_profile_id and profile_version = p_profile_version) then
    raise exception 'ready_profile_unknown' using errcode = '42501';
  end if;
  return clued_private.integration_ready_assess_v1(p_integration_id, p_profile_id, p_profile_version, p_as_of,
    clued_private.integration_evaluate_v1(p_integration_id, p_as_of));
end $$;

-- =============================================================================================
-- Part C: operations (§10.6–§10.9)
-- =============================================================================================

-- The common opening of a write on an existing Integration I that takes L5 (§10.1): CAS on base_version,
-- the Binding channel's current-connection recheck under L5, connection-revoke materialization, and the
-- SUPERSEDED guard. Returns {integration, revocation_id}.
create function clued_private.integration_write_open_v1(p_actor jsonb, p_owner uuid, p_integration_id uuid,
  p_base_version bigint, p_receipt_id uuid, p_call_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t clued_private.integrations_v1; v_revocation uuid;
begin
  select * into t from clued_private.integrations_v1 where integration_id = p_integration_id and owner_id = p_owner for update;
  if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
  if t.version <> p_base_version then raise exception 'integration_version_conflict' using errcode = '40001'; end if;
  if p_actor->>'kind' = 'binding'
     and clued_private.integration_current_binding_v1(p_integration_id) is distinct from (p_actor->>'binding_id')::uuid then
    raise exception 'integration_connection_required' using errcode = '42501';
  end if;
  v_revocation := clued_private.integration_materialize_connection_revoke_v1(p_integration_id, p_receipt_id, p_call_at);
  return pg_catalog.jsonb_build_object('integration', pg_catalog.to_jsonb(t), 'revocation_id', v_revocation);
end $$;

-- §10.6 declare (Binding, current connection; family integration_declare).
create function clued_private.integration_declare_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb, p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  t clued_private.integrations_v1; s clued_private.integration_host_surfaces_v1; v_open jsonb;
  v_id uuid; v_base bigint; v_surface text; v_caps text[]; v_features jsonb; v_family text; v_adapter text;
  v_package text; v_declaration integer; e0 jsonb; e1 jsonb; v_version bigint; v_flags text[] := '{}';
  v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, (p_actor->>'binding_id')::uuid, 'integration_declare',
    p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
    exception when others then raise exception 'invalid_declaration' using errcode = '22023';
    end;
    v_surface := p_input->>'host_surface'; v_features := coalesce(p_input->'host_features', '{}'::jsonb);
    v_family := p_input->>'adapter_family'; v_adapter := p_input->>'adapter_version'; v_package := p_input->>'package_version';
    if v_id is null or v_base is null or v_surface is null
       or pg_catalog.jsonb_typeof(p_input->'declared_capabilities') is distinct from 'array'
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_input->'declared_capabilities') x where pg_catalog.jsonb_typeof(x) <> 'string')
       or pg_catalog.jsonb_typeof(v_features) <> 'object'
       or exists (select 1 from pg_catalog.jsonb_each(v_features) f where pg_catalog.jsonb_typeof(f.value) <> 'boolean')
       or coalesce(pg_catalog.char_length(v_family), 0) not between 1 and 80
       or coalesce(pg_catalog.char_length(v_adapter), 0) not between 1 and 40
       or (p_input ? 'package_version' and p_input->'package_version' <> 'null'::jsonb
           and coalesce(pg_catalog.char_length(v_package), 0) not between 1 and 40) then
      raise exception 'invalid_declaration' using errcode = '22023';
    end if;
    v_caps := array(select x from pg_catalog.jsonb_array_elements_text(p_input->'declared_capabilities') x
                    group by x order by x collate "C");
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    v_open := clued_private.integration_write_open_v1(p_actor, p_owner, v_id, v_base, v_receipt.id, v_call_at);
    t := pg_catalog.jsonb_populate_record(null::clued_private.integrations_v1, v_open->'integration');
    if v_open->>'revocation_id' is not null then
      v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
        'id', v_open->>'revocation_id');
    end if;
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    if t.historical = 'SUPERSEDED' then
      v_supp := pg_catalog.jsonb_build_object('superseded_by', t.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    if t.identity_claim_state in ('CLAIM_CONFLICT','PENDING_RECONCILE','SUPERSEDED') then
      raise exception 'integration_claim_blocked' using errcode = '42501';
    end if;
    select * into s from clued_private.integration_host_surfaces_v1 where host = t.host and surface = v_surface;
    if not found then raise exception 'host_surface_not_registered' using errcode = '42501'; end if;
    if not clued_private.integration_capabilities_valid_v1(v_caps) then
      raise exception 'capability_unknown' using errcode = '42501';
    end if;
    if not (v_caps operator(pg_catalog.<@) s.capability_ceiling) then
      raise exception 'capability_declaration_exceeds_ceiling' using errcode = '42501';
    end if;
    if exists (select 1 from pg_catalog.jsonb_each(v_features) f
                where f.value = 'true'::jsonb and coalesce(s.host_features->f.key, 'false'::jsonb) <> 'true'::jsonb) then
      raise exception 'host_feature_not_supported' using errcode = '42501';
    end if;
    select coalesce(max(declaration_version), 0) + 1 into v_declaration
      from clued_private.integration_capability_declarations_v1 where integration_id = v_id;
    insert into clued_private.integration_capability_declarations_v1(integration_id, declaration_version, host_surface,
      declared_capabilities, host_features, adapter_family, adapter_version, package_version, receipt_id)
    values (v_id, v_declaration, v_surface, v_caps, v_features, v_family, v_adapter, v_package, v_receipt.id);
    -- v0.1.2 NIT-3: the compatibility rules and the subject digest read these columns
    update clued_private.integrations_v1 set adapter_family = v_family, adapter_version = v_adapter, package_version = v_package
     where integration_id = v_id;
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, '{}'::jsonb);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, null, 'DECLARE',
      pg_catalog.jsonb_build_object('declaration_version', v_declaration, 'host_surface', v_surface,
        'adapter_family', v_family, 'adapter_version', v_adapter, 'package_version', v_package),
      null, 'DECLARED', v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'declaration_version', v_declaration,
      'declared_capabilities', pg_catalog.to_jsonb(v_caps), 'outcome_flags', pg_catalog.to_jsonb(v_flags),
      'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.6 report (Binding, current connection; family integration_report) and fact_set / fact_clear
-- (Operator; family integration_fact_set). One core, p_channel 'adapter' or 'operator'.
create function clued_private.integration_fact_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb, p_received_hash text,
  p_channel text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  t clued_private.integrations_v1; v_open jsonb; v_family text := case p_channel when 'adapter' then 'integration_report'
    else 'integration_fact_set' end;
  v_id uuid; v_base bigint; v_action text; v_class text; v_source text; v_value text; v_mask text[];
  v_reason text; v_valid_until timestamptz; v_fact uuid; v_cleared uuid; e0 jsonb; e1 jsonb; v_version bigint;
  v_flags text[] := '{}'; v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
  v_invalid text := case p_channel when 'adapter' then 'invalid_integration_report' else 'invalid_integration_fact' end;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, (p_actor->>'binding_id')::uuid, v_family, p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
      v_valid_until := (p_input->>'valid_until')::timestamptz;
    exception when others then raise exception '%', v_invalid using errcode = '22023';
    end;
    v_action := p_input->>'action'; v_class := p_input->>'truth_class'; v_value := p_input->>'value';
    v_reason := p_input->>'reason';
    v_source := case p_channel when 'adapter' then 'adapter' else coalesce(p_input->>'source', 'operator') end;
    if v_id is null or v_base is null or v_action is null or v_action not in ('set','clear') or v_class is null
       or (p_channel = 'adapter' and p_input ? 'source')
       -- §10.6: the Operator channel writes source operator or policy, never adapter
       or (p_channel <> 'adapter' and v_source not in ('operator','policy'))
       or (v_reason is not null and pg_catalog.char_length(v_reason) not between 1 and 500)
       or (v_valid_until is not null and v_valid_until <= v_call_at)
       or (v_action = 'clear' and (p_input ? 'value' or p_input ? 'mask' or p_input ? 'valid_until')) then
      raise exception '%', v_invalid using errcode = '22023';
    end if;
    if p_input ? 'mask' and p_input->'mask' <> 'null'::jsonb then
      if pg_catalog.jsonb_typeof(p_input->'mask') <> 'array'
         or exists (select 1 from pg_catalog.jsonb_array_elements(p_input->'mask') x where pg_catalog.jsonb_typeof(x) <> 'string') then
        raise exception '%', v_invalid using errcode = '22023';
      end if;
      v_mask := array(select x from pg_catalog.jsonb_array_elements_text(p_input->'mask') x group by x order by x collate "C");
    end if;
    if p_channel = 'adapter' then
      -- §10.6: an adapter reports only host_state / adapter_state and only narrows (placement choice (c))
      if v_class not in ('host_state','adapter_state')
         or (v_action = 'set' and v_value in ('AVAILABLE','OK')) then
        raise exception 'adapter_report_cannot_expand' using errcode = '42501';
      end if;
    elsif v_class not in ('environment_state','qualification_state','compatibility_state','host_state','adapter_state')
       or (v_action = 'set' and v_reason is null) then
      raise exception '%', v_invalid using errcode = '22023';
    end if;
    if v_action = 'set' and not coalesce(clued_private.integration_fact_value_valid_v1(v_class, v_value, v_mask), false) then
      raise exception '%', v_invalid using errcode = '22023';
    end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    v_open := clued_private.integration_write_open_v1(p_actor, p_owner, v_id, v_base, v_receipt.id, v_call_at);
    t := pg_catalog.jsonb_populate_record(null::clued_private.integrations_v1, v_open->'integration');
    if v_open->>'revocation_id' is not null then
      v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
        'id', v_open->>'revocation_id');
    end if;
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    if t.historical = 'SUPERSEDED' then
      v_supp := pg_catalog.jsonb_build_object('superseded_by', t.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    -- one CURRENT row per (Integration, class, source): the previous one is superseded or cleared
    update clued_private.integration_facts_v1 set fact_status = case v_action when 'set' then 'SUPERSEDED' else 'CLEARED' end
     where integration_id = v_id and truth_class = v_class and source = v_source and fact_status = 'CURRENT'
    returning fact_id into v_cleared;
    if v_action = 'clear' and v_cleared is null then
      raise exception '%', v_invalid using errcode = '22023';
    end if;
    if v_action = 'set' then
      insert into clued_private.integration_facts_v1(integration_id, truth_class, source, value, capability_mask, reason,
        valid_until, fact_status, receipt_id)
      values (v_id, v_class, v_source, v_value, v_mask, v_reason, v_valid_until, 'CURRENT', v_receipt.id)
      returning fact_id into v_fact;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'fact', 'kind', 'integration_fact', 'id', v_fact);
    end if;
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, '{}'::jsonb);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, null,
      case when p_channel = 'adapter' then 'REPORT' when v_action = 'set' then 'FACT_SET' else 'FACT_CLEAR' end,
      pg_catalog.jsonb_build_object('action', v_action, 'truth_class', v_class, 'source', v_source, 'value', v_value,
        'mask', pg_catalog.to_jsonb(v_mask), 'reason', v_reason, 'valid_until', v_valid_until,
        'fact_id', v_fact, 'previous_fact_id', v_cleared, 'operator_id', case when p_actor->>'kind' = 'operator'
          then p_actor->>'user_id' end),
      null, pg_catalog.upper(v_action), v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'action', v_action, 'truth_class', v_class,
      'source', v_source, 'fact_id', v_fact, 'previous_fact_id', v_cleared, 'outcome_flags', pg_catalog.to_jsonb(v_flags),
      'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.7 A-class verification (Binding, current connection; family integration_verify_baseline). Writes
-- the A-class table only; never reads or writes a READY table (T-A8-2 static scan).
create function clued_private.integration_verify_baseline_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  t clued_private.integrations_v1; c clued_private.integration_connections_v1; pol clued_private.integration_policy_v1;
  v_open jsonb; v_id uuid; v_base bigint; v_caller uuid := (p_actor->>'binding_id')::uuid; e0 jsonb; e1 jsonb;
  v_session uuid; v_transport jsonb; v_transport_ok boolean; v_digest text; v_checks jsonb; v_result text;
  v_verification uuid := gen_random_uuid(); v_version bigint; v_flags text[] := '{}';
  v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, v_caller, 'integration_verify_baseline', p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
    exception when others then raise exception 'invalid_verification_input' using errcode = '22023';
    end;
    -- the class is fixed by kind; a caller-supplied verification_class is never accepted (T-A8-2)
    if v_id is null or v_base is null or p_input ? 'verification_class' then
      raise exception 'invalid_verification_input' using errcode = '22023';
    end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    v_open := clued_private.integration_write_open_v1(p_actor, p_owner, v_id, v_base, v_receipt.id, v_call_at);
    t := pg_catalog.jsonb_populate_record(null::clued_private.integrations_v1, v_open->'integration');
    if v_open->>'revocation_id' is not null then
      v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
        'id', v_open->>'revocation_id');
    end if;
    if t.historical = 'SUPERSEDED' then
      v_supp := pg_catalog.jsonb_build_object('superseded_by', t.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    if clued_private.integration_revocation_status_v1(v_id) <> 'NOT_REVOKED' then
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;
    if t.identity_claim_state in ('CLAIM_CONFLICT','PENDING_RECONCILE','SUPERSEDED') then
      raise exception 'integration_claim_blocked' using errcode = '42501';
    end if;
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    -- v0.1.3 NIT-6: invalid facts carry no predicates and count as not eligible
    if not coalesce((e0->>'valid')::boolean and (e0 #>> '{predicates,verification_eligible}')::boolean, false) then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e0->'reason_codes',
        'blocking', coalesce(e0 #> '{predicates,blocking}', '[]'::jsonb), 'integration_state', e0->'integration_state');
      raise exception 'verification_not_eligible' using errcode = '42501';
    end if;
    select * into c from clued_private.integration_connections_v1
     where integration_id = v_id and link_status = 'CURRENT' order by linked_at desc, connection_id limit 1;
    -- CRV-2: a resume by this Binding after the link
    select s.id into v_session from public.clued_continuity_sessions s
     where s.binding_id = v_caller and s.started_at >= c.linked_at order by s.started_at desc, s.id limit 1;
    -- CRV-3: weak, caller-supplied transport; it can only fail the result (placement choice (e))
    v_transport := p_input->'transport';
    v_transport_ok := pg_catalog.jsonb_typeof(v_transport) = 'object'
      and coalesce(v_transport->>'protocol_version' = any(clued_private.integration_supported_mcp_versions_v1()), false)
      and (coalesce(v_transport->'build_sha', 'null'::jsonb) = 'null'::jsonb
           or coalesce(v_transport->>'build_sha' ~ '^[0-9a-f]{40}$', false));
    v_digest := clued_private.integration_subject_digest_v1(v_id);
    v_checks := pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'CRV-1', 'result', 'PASS', 'evidence_ref', v_caller),
      pg_catalog.jsonb_build_object('id', 'CRV-2', 'result', case when v_session is null then 'FAIL' else 'PASS' end,
        'evidence_ref', v_session),
      pg_catalog.jsonb_build_object('id', 'CRV-3', 'result', case when v_transport_ok then 'PASS' else 'FAIL' end,
        'evidence_strength', 'WEAK_CALLER_SUPPLIED',
        'evidence_ref', case when pg_catalog.jsonb_typeof(v_transport) = 'object' then pg_catalog.jsonb_build_object(
          'protocol_version', v_transport->'protocol_version', 'build_sha', v_transport->'build_sha') end),
      pg_catalog.jsonb_build_object('id', 'CRV-4', 'result', case when v_digest is null then 'FAIL' else 'PASS' end,
        'evidence_ref', v_digest));
    v_result := case when v_session is not null and v_transport_ok and v_digest is not null then 'PASS' else 'FAIL' end;
    select * into pol from clued_private.integration_policy_v1 where policy_version = t.policy_version;
    insert into clued_private.integration_canonical_verifications_v1(verification_id, integration_id, verification_contract,
      result, checks, subject_digest, connection_id, evidence_sha256, receipt_id, valid_until)
    values (v_verification, v_id, 'clued.crv.v1', v_result, v_checks, v_digest, c.connection_id,
      clued_private.integration_sha256_v1(v_checks::text), v_receipt.id,
      pg_catalog.clock_timestamp() + pol.canonical_verification_ttl);
    v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'verification',
      'kind', 'integration_canonical_verification', 'id', v_verification);
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, '{}'::jsonb);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, null, 'VERIFY_BASELINE',
      pg_catalog.jsonb_build_object('verification_id', v_verification, 'connection_id', c.connection_id), null, v_result,
      v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'verification_id', v_verification, 'result', v_result,
      'checks', v_checks, 'outcome_flags', pg_catalog.to_jsonb(v_flags), 'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.8 B-class verification (Binding, current connection; family integration_verify_ready). Writes only
-- integration_ready_verifications_v1, its Receipt and the operation log (placement choice (f), T-A8-2).
create function clued_private.integration_verify_ready_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  t clued_private.integrations_v1; c clued_private.integration_connections_v1; p clued_private.integration_ready_profiles_v1;
  v_id uuid; v_base bigint; v_profile text; v_profile_version integer; v_caller uuid := (p_actor->>'binding_id')::uuid;
  e jsonb; v_cap text; v_rule jsonb; v_evidence uuid; v_in_effective boolean; v_checks jsonb := '[]'; v_pass boolean := true;
  v_result text; v_digest text; v_verification uuid := gen_random_uuid();
  v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, v_caller, 'integration_verify_ready', p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
      v_profile := p_input->>'profile_id'; v_profile_version := (p_input->>'profile_version')::integer;
    exception when others then raise exception 'invalid_verification_input' using errcode = '22023';
    end;
    if v_id is null or v_base is null or v_profile is null or v_profile_version is null or p_input ? 'verification_class' then
      raise exception 'invalid_verification_input' using errcode = '22023';
    end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    select * into t from clued_private.integrations_v1 where integration_id = v_id and owner_id = p_owner for share;
    if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    if t.version <> v_base then raise exception 'integration_version_conflict' using errcode = '40001'; end if;
    if clued_private.integration_current_binding_v1(v_id) is distinct from v_caller then
      raise exception 'integration_connection_required' using errcode = '42501';
    end if;
    if t.historical = 'SUPERSEDED' then
      v_supp := pg_catalog.jsonb_build_object('superseded_by', t.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    if clued_private.integration_revocation_status_v1(v_id) <> 'NOT_REVOKED' then
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;
    select * into p from clued_private.integration_ready_profiles_v1
     where profile_id = v_profile and profile_version = v_profile_version;
    if not found then raise exception 'ready_profile_unknown' using errcode = '42501'; end if;
    e := clued_private.integration_evaluate_v1(v_id, v_call_at);
    if not coalesce((e->>'valid')::boolean and (e->>'integration_operable')::boolean, false) then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e->'reason_codes', 'integration_state', e->'integration_state');
      raise exception 'ready_verification_requires_operable' using errcode = '42501';
    end if;
    select * into c from clued_private.integration_connections_v1
     where integration_id = v_id and link_status = 'CURRENT' order by linked_at desc, connection_id limit 1;
    for v_cap in select x from pg_catalog.unnest(p.required_capabilities) x order by x collate "C" loop
      v_rule := p.evidence_rules->v_cap;
      v_in_effective := coalesce(e->'effective_capabilities', '[]'::jsonb) ? v_cap;
      v_evidence := null;
      if v_rule->>'kind' = 'resume_after_link' then
        select s.id into v_evidence from public.clued_continuity_sessions s
         where s.binding_id = v_caller and s.started_at >= c.linked_at order by s.started_at desc, s.id limit 1;
      elsif v_rule->>'kind' = 'committed_receipt_after_link' then
        select a.id into v_evidence from public.clued_audit_receipts a
         where a.binding_id = v_caller and a.status = 'committed' and a.created_at >= c.linked_at
           and a.operation_family not like 'integration\_%'
           and a.operation_family = any(array(select pg_catalog.jsonb_array_elements_text(v_rule->'families')))
         order by a.created_at desc, a.id limit 1;
      end if;
      v_checks := v_checks || pg_catalog.jsonb_build_object('id', 'READY-' || v_cap, 'capability', v_cap,
        'rule', v_rule, 'in_effective', v_in_effective,
        'result', case when v_in_effective and v_evidence is not null then 'PASS' else 'FAIL' end, 'evidence_ref', v_evidence);
      v_pass := v_pass and v_in_effective and v_evidence is not null;
    end loop;
    v_result := case when v_pass then 'PASS' else 'FAIL' end;
    v_digest := clued_private.integration_subject_digest_v1(v_id);
    insert into clued_private.integration_ready_verifications_v1(verification_id, integration_id, profile_id, profile_version,
      result, checks, subject_digest, evidence_sha256, receipt_id, valid_until)
    values (v_verification, v_id, p.profile_id, p.profile_version, v_result, v_checks, v_digest,
      clued_private.integration_sha256_v1(v_checks::text), v_receipt.id, pg_catalog.clock_timestamp() + p.freshness_ttl);
    v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'verification',
      'kind', 'integration_ready_verification', 'id', v_verification);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, null, 'VERIFY_READY',
      pg_catalog.jsonb_build_object('verification_id', v_verification, 'profile_id', p.profile_id,
        'profile_version', p.profile_version), null, v_result, v_receipt.id);
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'verification_id', v_verification,
      'profile', pg_catalog.jsonb_build_object('id', p.profile_id, 'version', p.profile_version), 'result', v_result,
      'checks', v_checks, 'integration_state', e->'integration_state');
    -- the Integration is not changed: no committed version
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs, '{}', null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.9 status with the READY projection: {integration, ready_projection_receipt?}. Profiles are
-- checked, and every 42501 / 22023 raised, before the optional Receipt (§10.1 MINOR-4). With
-- emit_ready_receipt the same request writes one integration_ready_projection Receipt bound to the
-- projections (§9.5).
create function clued_private.integration_status_ready_v1(p_owner uuid, p_binding_id uuid, p_integration_id uuid,
  p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_as_of timestamptz := pg_catalog.clock_timestamp(); v_profiles jsonb := p_input->'profiles'; v_profile jsonb;
  v_emit boolean; v_view jsonb; v_ready jsonb := '[]'; v_receipt public.clued_audit_receipts; v_refs jsonb;
  v_envelope jsonb;
begin
  if v_profiles = 'null'::jsonb then v_profiles := null; end if;
  if v_profiles is not null then
    if pg_catalog.jsonb_typeof(v_profiles) <> 'array' or pg_catalog.jsonb_array_length(v_profiles) not between 1 and 10 then
      raise exception 'invalid_ready_profiles' using errcode = '22023';
    end if;
    if (select count(distinct x) from pg_catalog.jsonb_array_elements(v_profiles) x) <> pg_catalog.jsonb_array_length(v_profiles) then
      raise exception 'invalid_ready_profiles' using errcode = '22023';
    end if;
    for v_profile in select x from pg_catalog.jsonb_array_elements(v_profiles) x loop
      if pg_catalog.jsonb_typeof(v_profile) <> 'object' or (v_profile - 'id' - 'version') <> '{}'::jsonb
         or pg_catalog.jsonb_typeof(v_profile->'id') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_profile->'version') is distinct from 'number'
         or (v_profile->>'version') !~ '^[1-9][0-9]{0,8}$' then
        raise exception 'invalid_ready_profiles' using errcode = '22023';
      end if;
      if not exists (select 1 from clued_private.integration_ready_profiles_v1
                      where profile_id = v_profile->>'id' and profile_version = (v_profile->>'version')::integer) then
        raise exception 'ready_profile_unknown' using errcode = '42501';
      end if;
    end loop;
  end if;
  if p_input ? 'emit_ready_receipt' and pg_catalog.jsonb_typeof(p_input->'emit_ready_receipt') <> 'boolean' then
    raise exception 'invalid_ready_profiles' using errcode = '22023';
  end if;
  v_emit := coalesce((p_input->>'emit_ready_receipt')::boolean, false);
  if v_emit and (v_profiles is null or coalesce(pg_catalog.char_length(p_input->>'idempotency_key'), 0) not between 8 and 160) then
    raise exception 'invalid_ready_profiles' using errcode = '22023';
  end if;
  v_view := clued_private.integration_view_v1(p_integration_id, v_as_of);
  if v_profiles is not null then
    for v_profile in select x from pg_catalog.jsonb_array_elements(v_profiles) x loop
      v_ready := v_ready || clued_private.integration_ready_assess_v1(p_integration_id, v_profile->>'id',
        (v_profile->>'version')::integer, v_as_of, v_view->'evaluation');
    end loop;
    v_view := v_view || pg_catalog.jsonb_build_object('ready', v_ready);
  end if;
  if not v_emit then return pg_catalog.jsonb_build_object('integration', v_view); end if;
  v_receipt := clued_private.m1_begin_receipt(p_owner, p_binding_id, 'integration_ready_projection', p_input,
    clued_private.integration_request_hash_v1('integration_ready_projection', p_input));
  if v_receipt.status <> 'pending' then
    -- a replay answers with the projections the original request bound into its Receipt, so the two never
    -- disagree; the Canonical view itself is read fresh
    v_envelope := clued_private.integration_replay_v1(v_receipt);
    return pg_catalog.jsonb_build_object('integration', v_view || pg_catalog.jsonb_build_object('ready',
        coalesce(v_envelope #> '{supplemental,projections}', 'null'::jsonb)),
      'ready_projection_receipt', v_envelope);
  end if;
  v_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration',
    'id', p_integration_id)) || coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', 'ready_verification',
      'kind', 'integration_ready_verification', 'id', x->'ready_verification_id') order by n)
    from pg_catalog.jsonb_array_elements(v_ready) with ordinality r(x, n)
    where x->'ready_verification_id' <> 'null'::jsonb), '[]'::jsonb);
  v_envelope := clued_private.integration_finish_v1(v_receipt.id, 'committed', v_refs, '{}', null,
    pg_catalog.jsonb_build_object('integration_id', p_integration_id, 'as_of', clued_private.integration_instant_text_v1(v_as_of),
      'projections', v_ready));
  return pg_catalog.jsonb_build_object('integration', v_view, 'ready_projection_receipt', v_envelope);
end $$;

-- ---- channel entry points ----------------------------------------------------------------------
create function public.clued_integration_declare_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  b := clued_private.integration_auth_binding_v1(p_token_hash, '{}', true);
  perform clued_private.integration_require_connection_v1(b, p_input);
  return clued_private.integration_declare_core_v1(pg_catalog.jsonb_build_object('kind', 'binding', 'binding_id', b.id,
    'user_id', b.user_id), b.user_id, p_input, clued_private.integration_request_hash_v1('integration_declare', p_input));
end $$;

create function public.clued_integration_report_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings;
begin
  b := clued_private.integration_auth_binding_v1(p_token_hash, '{}', true);
  perform clued_private.integration_require_connection_v1(b, p_input);
  return clued_private.integration_fact_core_v1(pg_catalog.jsonb_build_object('kind', 'binding', 'binding_id', b.id,
    'user_id', b.user_id), b.user_id, p_input, clued_private.integration_request_hash_v1('integration_report', p_input), 'adapter');
end $$;

-- §10.7 / §10.8: one entry point, two cores with separate families (the class is fixed by kind).
create function public.clued_integration_verify_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.clued_agent_bindings; v_kind text := p_input->>'kind'; v_actor jsonb; v_input jsonb := p_input - 'kind';
begin
  b := clued_private.integration_auth_binding_v1(p_token_hash, '{}', true);
  perform clued_private.integration_require_connection_v1(b, p_input);
  v_actor := pg_catalog.jsonb_build_object('kind', 'binding', 'binding_id', b.id, 'user_id', b.user_id);
  if v_kind = 'canonical_baseline' then
    return clued_private.integration_verify_baseline_core_v1(v_actor, b.user_id, v_input,
      clued_private.integration_request_hash_v1('integration_verify_baseline', v_input));
  elsif v_kind = 'ready_profile' then
    return clued_private.integration_verify_ready_core_v1(v_actor, b.user_id, v_input,
      clued_private.integration_request_hash_v1('integration_verify_ready', v_input));
  end if;
  raise exception 'invalid_verification_input' using errcode = '22023';
end $$;

create or replace function public.clued_integration_status_v1(p_token_hash text, p_input jsonb)
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
  return clued_private.integration_status_ready_v1(b.user_id, b.id, v_id, coalesce(p_input, '{}'::jsonb));
end $$;

-- Native account session (§10.1): the PR-2 dispatcher, with status carrying the READY projection.
create or replace function public.clued_user_integration_v1(p_input jsonb)
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
    -- views are computed in integration_id order (diagnostic lock order), then listed newest first
    return pg_catalog.jsonb_build_object('integrations', coalesce((select pg_catalog.jsonb_agg(x.view order by x.created_at desc,
        x.integration_id) from (select i.integration_id, i.created_at,
          clued_private.integration_view_v1(i.integration_id, pg_catalog.clock_timestamp()) as view
        from clued_private.integrations_v1 i where i.owner_id = u order by i.integration_id offset 0) x), '[]'::jsonb));
  elsif v_op = 'status' then
    return clued_private.integration_status_ready_v1(u, null, clued_private.integration_native_owned_v1(u, v_input), v_input);
  end if;
  raise exception 'invalid_integration_operation' using errcode = '22023';
end $$;

-- Operator (§10.1): authorization_owner_v12() and platform_admin_v13; the subject is the target
-- Integration's owner. PR-3 ops only (placement choice (d)).
create function public.clued_admin_integration_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := clued_private.authorization_owner_v12(); v_op text := p_input->>'op'; v_input jsonb := p_input - 'op';
  v_id uuid; v_owner uuid; v_actor jsonb;
begin
  -- FOR SHARE on the singleton row serializes with platform_admin_recover_v13, as the other operator paths do
  perform 1 from clued_private.platform_admin_v13 where subject_id = u for share;
  if not found then raise exception 'platform_admin_required' using errcode = '42501'; end if;
  begin
    v_id := (v_input->>'integration_id')::uuid;
  exception when others then v_id := null;
  end;
  select owner_id into v_owner from clued_private.integrations_v1 where integration_id = v_id;
  if v_owner is null then raise exception 'integration_not_owned' using errcode = '42501'; end if;
  v_actor := pg_catalog.jsonb_build_object('kind', 'operator', 'binding_id', null, 'user_id', u);
  if v_op in ('fact_set','fact_clear') then
    v_input := v_input || pg_catalog.jsonb_build_object('action', case v_op when 'fact_set' then 'set' else 'clear' end);
    return clued_private.integration_fact_core_v1(v_actor, v_owner, v_input,
      clued_private.integration_request_hash_v1('integration_fact_set', v_input), 'operator');
  elsif v_op = 'status' then
    return clued_private.integration_status_ready_v1(v_owner, null, v_id, v_input);
  end if;
  raise exception 'invalid_integration_operation' using errcode = '22023';
end $$;

-- §5.13 / OQ-21: no grant to anyone. The target grants (Binding RPCs to anon, authenticated; the Native
-- and Operator entry points to authenticated) ride the flag-enabling stage authorization's own migration.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'clued_private' and p.proname like 'integration\_%' escape '\')
               or (n.nspname = 'public' and (p.proname like 'clued\_integration\_%' escape '\'
                   or p.proname in ('clued_user_integration_v1','clued_admin_integration_v1'))) loop
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
