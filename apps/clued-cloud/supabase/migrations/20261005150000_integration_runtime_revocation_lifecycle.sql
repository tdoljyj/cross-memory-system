-- S2c Integration Runtime PR-4 (IntegrationRuntime v0.1.8 §14.1, Owner Decision 1b607636): the
-- revocation / restore / reauth mark / capability_expansion / lifecycle write operations (§10.10–§10.13),
-- the Binding channel's revoke_self, the Operator ops for them, and §10.5 REPLACE_HOLDER rule 2 (a revoked
-- superseded holder), which replaces PR-2's temporary refusal (v0.1.7 MINOR-N25).
--
-- Placement choices this migration makes inside the frozen §14.1 PR list (recorded in the PR body):
--   (a) revoke takes no base_version (§10.1 CAS, v0.1.2 MINOR-N1); an input that carries one is
--       invalid_revoke (22023) rather than silently ignored.
--   (b) revoke_self's LINEAGE (§10.10 step 4) compares each Binding's identity on I: the latest connection
--       snapshot of that Binding on I, else (a Binding I owns without a connection row on I, i.e. one moved
--       to I by reconcile) its server-derived identity (§6.2). The caller must be live before any Integration
--       row is read. A successful revoke_self revokes the caller, so its idempotent replay is a 403 by design.
--   (c) ALREADY_REVOKED (§10.10 step 5) writes the Receipt and the operation log only: no revocation row,
--       no Binding, and no integrations_v1 version bump (T-A11-11(c), T-A11-24).
--   (d) restore checks, in order: integration_superseded, lifecycle_transition_invalid (nothing to restore),
--       binding_not_owned, restore_requires_new_authorization_decision, binding_not_adoptable (the new Binding
--       is not live or is a P5 Binding), integration_provider_mismatch, integration_claim_blocked,
--       binding_owned_by_other_integration. The new-decision check precedes liveness, so a pre-revocation
--       Binding that the revocation itself swept still reads restore_requires_new_authorization_decision.
--   (e) Operator reauth_mark takes raised_by ∈ {CLUED, POLICY, SECURITY}, as Operator revoke takes
--       revoked_by; SERVER is only reachable through integration_reauth_mark_core_v1 from the server.
--   (f) capability_expansion (§10.11, optional raw-Binding path) only widens: new_ceiling must be a valid
--       ceiling that covers the stored one, else invalid_capability_expansion (22023). On a revoked Integration
--       it is integration_revoked_requires_explicit_restore (a ceiling change is not a restore).
--   (g) lifecycle request_close / request_archive take request_id and the Request's base_version; close is
--       OPEN | BOUND → CLOSED, archive is any non-ARCHIVED status → ARCHIVED. Neither touches integrations_v1
--       (§5.3 rule 3, T-A9-5). policy_pause also covers PAUSED_BY_OWNER; policy_resume then returns to the value
--       the policy pause replaced (PAUSED_BY_OWNER or PERMITTED), so an Operator cycle never lifts an Owner pause.
--       A lifecycle action that does not change the value is lifecycle_transition_invalid.
--       lifecycle, reauth_mark and capability_expansion on a SUPERSEDED Integration are integration_superseded.
--   (h) The status view gains a revocation block: the open row (if any) and the full revoked set of the
--       current revocation episode — the row's revoked_binding_ids ∪ the affected_binding_ids of every
--       REVOKE / PARTIAL_REVOKE log row since the last restore (§10.10 "PARTIAL 之后的记录").
--   (i) A revoke whose Integration's Claim Store was tampered out of band (§7.3 C4 / C5) still commits: it
--       writes the revocation row and revokes the Bindings but leaves the integrations_v1 row (version,
--       snapshot) unchanged, flagged CLAIM_STORE_DIVERGENT, since touching it would fail the §5.4 deferred
--       consistency trigger at commit (§10.1, T-A11-9).
--   (j) Normalization's fallback host surface (no declaration yet) reads the latest Request bound to I by
--       bound_integration_id alone, no longer only while that Request is BOUND: with PR-4's request_close /
--       request_archive a status change would otherwise change I's host_state facts (§5.3 rule 3, T-A9-5).
-- S2c objects replaced with create or replace (same signatures; no grant changes): integration_view_v1,
-- integration_normalize_detail_v1, integration_reconcile_core_v1, public.clued_user_integration_v1,
-- public.clued_admin_integration_v1. No object
-- older than S2c is changed (§2.3, T-S-3). OQ-15 stays: no Event is written. Nothing is granted (§5.13, OQ-21).

-- =============================================================================================
-- Part A: revocation helpers (§5.5 O5 / O7, §10.10 step 7)
-- =============================================================================================

-- §5.5 O5 UnownedLineage(I, t): non-revoked, unowned, same owner, non-P5 Bindings with a consent-page v12
-- grant created ≤ t whose (clued.oauth.v12, sha256(client_id)) ∈ Lin*(I). Empty for a SUPERSEDED I (its
-- lineage belongs to the survivor).
create function clued_private.integration_unowned_lineage_v1(p_integration_id uuid, p_cut timestamptz)
returns uuid[] language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(b.id order by b.id), '{}')
    from clued_private.integrations_v1 i
    join public.clued_agent_bindings b on b.user_id = i.owner_id and b.revoked_at is null
    join clued_private.authorizations_v12 a on a.binding_id = b.id
   where i.integration_id = p_integration_id and i.historical = 'NONE'
     and p_cut is not null and a.issuance = 'oauth' and a.created_at <= p_cut
     and pg_catalog.to_jsonb(b)->>'organization_id' is null
     and not exists (select 1 from clued_private.integration_binding_owners_v1 o where o.binding_id = b.id)
     and exists (select 1 from clued_private.integration_lineage_v1(p_integration_id) l
                  where l.provider = 'clued.oauth.v12' and l.provider_connection_id = clued_private.integration_sha256_v1(a.client_id))
$$;

-- §10.10 Rev(I, t) := Owned(I) ∪ UnownedLineage(I, t), sorted.
create function clued_private.integration_rev_set_v1(p_integration_id uuid, p_cut timestamptz)
returns uuid[] language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(distinct x order by x), '{}')
    from pg_catalog.unnest(clued_private.integration_owned_unrevoked_v1(p_integration_id)
                           || clued_private.integration_unowned_lineage_v1(p_integration_id, p_cut)) x
$$;

-- §10.10 t_cut (v0.1.6 MINOR-N18, v0.1.7 NIT-2): rev_at(I) when I is revoked (open row, or the row a
-- materialization would write), else the call's t_rev.
create function clued_private.integration_revoke_cut_v1(p_integration_id uuid, p_t_rev timestamptz)
returns timestamptz language sql stable security definer set search_path='' as $$
  select coalesce(clued_private.integration_rev_at_v1(p_integration_id, p_t_rev), p_t_rev)
$$;

-- §5.5 O5 sibling_integration_ids (v0.1.6 MINOR-N22): the owner's other Integrations, not revoked,
-- historical = NONE, whose Lin* contains the Binding's server-derived identity.
create function clued_private.integration_sibling_integrations_v1(p_binding_id uuid, p_exclude uuid)
returns uuid[] language plpgsql volatile security definer set search_path='' as $$
declare v_ident jsonb;
begin
  v_ident := clued_private.integration_binding_identity_v1(p_binding_id);
  if v_ident is null then return '{}'; end if;
  return coalesce((select array_agg(x.integration_id order by x.integration_id)
    from clued_private.integrations_v1 x
   where x.owner_id = (v_ident->>'user_id')::uuid and x.integration_id <> p_exclude and x.historical = 'NONE'
     and clued_private.integration_revocation_status_v1(x.integration_id) = 'NOT_REVOKED'
     and exists (select 1 from clued_private.integration_lineage_v1(x.integration_id) l
                  where l.provider = v_ident->>'provider' and l.provider_connection_id = v_ident->>'provider_connection_id')), '{}');
end $$;

-- §10.10 step 7 for one Binding (the caller holds its L1 and L2): an unowned Binding first becomes I's
-- (REVOCATION_SWEEP, first ownership, v0.1.5 MAJOR-N5); then the Binding and its v12 authorization are
-- revoked with the same semantics as manage_v12 revoke, audited as 'revoke_integration'. Returns true
-- when the Binding was swept (it had no owner).
create function clued_private.integration_revoke_binding_v1(p_binding_id uuid, p_integration_id uuid, p_owner uuid,
  p_actor_kind text, p_receipt_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_swept boolean := false; a clued_private.authorizations_v12;
begin
  if not exists (select 1 from clued_private.integration_binding_owners_v1 where binding_id = p_binding_id) then
    perform clued_private.integration_take_ownership_v1(p_binding_id, p_integration_id, p_owner, 'REVOCATION_SWEEP',
      p_actor_kind, p_receipt_id);
    v_swept := true;
  end if;
  update public.clued_agent_bindings set revoked_at = pg_catalog.clock_timestamp()
   where id = p_binding_id and revoked_at is null;
  update clued_private.authorizations_v12 set revoked_at = pg_catalog.clock_timestamp(), version = version + 1
   where binding_id = p_binding_id and revoked_at is null;
  select * into a from clued_private.authorizations_v12 where binding_id = p_binding_id;
  insert into clued_private.authorization_audit_v12(owner_id, binding_id, request_id, operation, version, selected)
  values (p_owner, p_binding_id, a.request_id, 'revoke_integration', a.version,
    case when a.binding_id is not null then clued_private.authorization_selection_v12(p_binding_id) end);
  return v_swept;
end $$;

-- The operation log row with affected_binding_ids (§10.10 step 7, §10.12 RESTORE_SWEEP, §10.5 rule 2).
create function clued_private.integration_log_affected_v1(p_owner uuid, p_actor jsonb, p_request_id uuid,
  p_integration_id uuid, p_related uuid, p_operation_type text, p_source jsonb, p_result text, p_receipt_id uuid,
  p_affected uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  insert into clued_private.integration_operation_log_v1(owner_id, actor_kind, actor_binding_id, request_id, integration_id,
    related_integration_id, affected_binding_ids, operation_type, identity_snapshot_id, source_provenance, result, receipt_id)
  values (p_owner, p_actor->>'kind', (p_actor->>'binding_id')::uuid, p_request_id, p_integration_id, p_related,
    coalesce(p_affected, '{}'), p_operation_type,
    (select current_identity_snapshot_id from clued_private.integrations_v1 where integration_id = p_integration_id),
    coalesce(p_source, '{}'::jsonb), p_result, p_receipt_id)
  returning operation_id into v_id;
  return v_id;
end $$;

-- §10.10 step 5 / §10.5 rule 2 (v0.1.8 NIT-2): the ONE materialized row of a derived revoke, carrying the
-- adopted connection Binding followed by p_extra. Same adoption computation as every other
-- materialization site (§10.1, v0.1.3 MINOR-N10). Null when I is not derived-revoked.
create function clued_private.integration_insert_adopted_revocation_v1(p_integration_id uuid, p_extra uuid[],
  p_receipt_id uuid, p_call_at timestamptz)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_adopted jsonb; v_b uuid; v_id uuid;
begin
  if clued_private.integration_revocation_status_v1(p_integration_id) <> 'CONNECTION_USER_REVOKE' then
    return null;
  end if;
  v_adopted := clued_private.integration_connection_revoke_adoption_v1(p_integration_id);
  v_b := (v_adopted->>'binding_id')::uuid;
  insert into clued_private.integration_revocations_v1(integration_id, revoked_by, reason, revoked_binding_ids,
    revocation_source, adopted_from, receipt_id, revoked_at)
  values (p_integration_id, v_adopted->>'connection_revoked_by', 'connection revoke adopted (§10.1)',
    array[v_b] || array(select distinct x from pg_catalog.unnest(coalesce(p_extra, '{}'::uuid[])) x
                         where x is not null and x <> v_b order by x),
    'CONNECTION_REVOKE_ADOPTED', v_adopted, p_receipt_id,
    coalesce((v_adopted->>'connection_revoked_at')::timestamptz, p_call_at))
  returning revocation_id into v_id;
  return v_id;
end $$;

-- §5.9 trigger (b): superset extension of the open row with one Receipt. p_add must be non-empty and
-- disjoint from the row (its members were non-revoked, the row's were revoked).
create function clued_private.integration_extend_revocation_v1(p_revocation_id uuid, p_add uuid[], p_receipt_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  update clued_private.integration_revocations_v1 r
     set revoked_binding_ids = r.revoked_binding_ids
           || array(select distinct x from pg_catalog.unnest(p_add) x
                     where x is not null and not (x = any(r.revoked_binding_ids)) order by x),
         extended_receipt_ids = r.extended_receipt_ids || p_receipt_id
   where r.revocation_id = p_revocation_id;
end $$;

-- Revokes a set of Bindings for I (§10.10 step 7) and returns {revoked, swept: [{binding_id,
-- sibling_integration_ids}]}. Siblings are computed before the revoke, while the Binding is still live.
create function clued_private.integration_revoke_set_v1(p_ids uuid[], p_integration_id uuid, p_owner uuid,
  p_actor_kind text, p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_b uuid; v_siblings uuid[]; v_revoked uuid[] := '{}'; v_swept jsonb := '[]';
begin
  for v_b in select distinct x from pg_catalog.unnest(coalesce(p_ids, '{}'::uuid[])) x where x is not null order by x loop
    v_siblings := case when not exists (select 1 from clued_private.integration_binding_owners_v1 o where o.binding_id = v_b)
                       then clued_private.integration_sibling_integrations_v1(v_b, p_integration_id) end;
    if clued_private.integration_revoke_binding_v1(v_b, p_integration_id, p_owner, p_actor_kind, p_receipt_id) then
      v_swept := v_swept || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('binding_id', v_b,
        'sibling_integration_ids', pg_catalog.to_jsonb(coalesce(v_siblings, '{}'::uuid[]))));
    end if;
    v_revoked := v_revoked || v_b;
  end loop;
  return pg_catalog.jsonb_build_object('revoked', pg_catalog.to_jsonb(v_revoked), 'swept', v_swept);
end $$;

-- The §5.4 deferred consistency condition of integrations_v1 ⇔ Claim Store for I (the trigger's own test).
-- False only after out-of-band tampering (§7.3 C4 / C5); a revoke then leaves the integrations_v1 row
-- alone, because touching it would roll the whole revocation back at commit (§10.1: revoke is unconditional,
-- T-A11-9).
create function clued_private.integration_claim_store_consistent_v1(p_integration_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select case
    when i.identity_claim_state = 'CURRENT_CLAIM_HOLDER' then
      (select count(*) = 1 and count(*) filter (where c.claim_key_sha256 = i.claim_key_sha256
                                               and c.active_binding_domain = i.active_binding_domain) = 1
         from clued_private.integration_claims_v1 c where c.integration_id = i.integration_id and c.claim_status = 'CURRENT')
    else not exists (select 1 from clued_private.integration_claims_v1 c
                      where c.integration_id = i.integration_id and c.claim_status = 'CURRENT') end
    from clued_private.integrations_v1 i where i.integration_id = p_integration_id
$$;

-- §5.9 / §10.10 the revocation block of the status view (placement choice (h)).
create function clued_private.integration_revocation_view_v1(p_integration_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_status text; r clued_private.integration_revocations_v1; v_has boolean; v_since timestamptz; v_ids uuid[];
begin
  v_status := clued_private.integration_revocation_status_v1(p_integration_id);
  select * into r from clued_private.integration_revocations_v1
   where integration_id = p_integration_id and restored_by_regrant_id is null;
  v_has := found;
  select max(g.regranted_at) into v_since from clued_private.integration_regrants_v1 g where g.integration_id = p_integration_id;
  if v_status = 'NOT_REVOKED' then
    v_ids := '{}';
  else
    select coalesce(array_agg(distinct x order by x), '{}') into v_ids
      from (select pg_catalog.unnest(case when v_has then r.revoked_binding_ids else '{}'::uuid[] end) x
            union all
            select pg_catalog.unnest(o.affected_binding_ids) from clued_private.integration_operation_log_v1 o
             where o.integration_id = p_integration_id and o.operation_type in ('REVOKE','PARTIAL_REVOKE')
               and (v_since is null or o.recorded_at > v_since)) t;
  end if;
  return pg_catalog.jsonb_build_object(
    'revocation_state', case when v_status = 'NOT_REVOKED' then 'NOT_REVOKED' else 'REVOKED' end,
    'revocation_source', case v_status when 'NOT_REVOKED' then 'NONE' else v_status end,
    'revocation_id', case when v_has then r.revocation_id end,
    'revoked_by', case when v_has then r.revoked_by end,
    'revoked_at', case when v_has then r.revoked_at end,
    'row_source', case when v_has then r.revocation_source end,
    'revoked_binding_ids', pg_catalog.to_jsonb(v_ids),
    'restore_count', (select count(*) from clued_private.integration_regrants_v1 g where g.integration_id = p_integration_id));
end $$;

-- =============================================================================================
-- Part B: operations (§10.10–§10.13)
-- =============================================================================================

-- §10.10 Integration-level revoke (family integration_revoke), for all three channels. p_s0 / p_t_rev /
-- p_cut are given by the Binding channel, which discovers S0 and locks it together with the caller in one
-- pass before the Receipt (§10.1 MINOR-N13); Native and Operator pass nulls and the core does steps 0–1
-- itself. No base_version (placement choice (a)); never refused by the post-write validity gate (§10.1).
create function clued_private.integration_revoke_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text, p_revoked_by text, p_s0 uuid[], p_t_rev timestamptz, p_cut timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_t_rev timestamptz := coalesce(p_t_rev, pg_catalog.clock_timestamp());
  v_id uuid; v_reason text; i clued_private.integrations_v1; v_cut timestamptz; v_s0 uuid[]; v_s1 uuid[];
  v_caller jsonb; v_lineage uuid[]; v_targets uuid[]; v_partial boolean := false; v_foreign integer;
  r clued_private.integration_revocations_v1; v_has_row boolean; v_status text; v_revocation uuid;
  v_outcome text; v_flags text[] := '{}'; v_done jsonb := '{"revoked":[],"swept":[]}'; v_version bigint;
  e1 jsonb; v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, (p_actor->>'binding_id')::uuid, 'integration_revoke',
    p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid;
    exception when others then raise exception 'invalid_revoke' using errcode = '22023';
    end;
    v_reason := p_input->>'reason';
    if v_id is null or p_input ? 'base_version' or coalesce(pg_catalog.char_length(v_reason), 0) not between 1 and 500
       or p_revoked_by is null or p_revoked_by not in ('USER','USER_VIA_HOST','CLUED','POLICY','SECURITY') then
      raise exception 'invalid_revoke' using errcode = '22023';
    end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    -- steps 0–1: t_cut and S0 (unlocked discovery), then L1 + L2 in one id-ordered pass
    if p_s0 is null then
      v_cut := clued_private.integration_revoke_cut_v1(v_id, v_t_rev);
      v_s0 := clued_private.integration_rev_set_v1(v_id, v_cut);
      perform clued_private.integration_lock_bindings_v1(v_s0);
    else
      v_s0 := p_s0; v_cut := p_cut;
    end if;
    -- step 2: L5 (no CAS)
    select * into i from clued_private.integrations_v1 where integration_id = v_id and owner_id = p_owner for update;
    if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    if p_actor->>'kind' = 'binding'
       and clued_private.integration_current_binding_v1(v_id) is distinct from (p_actor->>'binding_id')::uuid then
      raise exception 'integration_connection_required' using errcode = '42501';
    end if;
    -- step 3: t_cut and the set re-read under L5
    if clued_private.integration_revoke_cut_v1(v_id, v_t_rev) is distinct from v_cut then
      raise exception 'integration_revoke_connection_set_changed' using errcode = '40001';
    end if;
    v_s1 := clued_private.integration_rev_set_v1(v_id, v_cut);
    if not (v_s1 <@ v_s0) then
      raise exception 'integration_revoke_connection_set_changed' using errcode = '40001';
    end if;
    select count(*) into v_foreign from clued_private.integration_binding_owners_v1 o
      join public.clued_agent_bindings b on b.id = o.binding_id
     where o.integration_id = v_id and b.user_id <> i.owner_id;
    v_status := clued_private.integration_revocation_status_v1(v_id);
    -- step 4: revoke_self is limited to the caller's provider-connection identity (placement choice (b))
    v_targets := v_s1;
    if p_actor->>'kind' = 'binding' then
      v_caller := clued_private.integration_binding_identity_v1((p_actor->>'binding_id')::uuid);
      v_lineage := array(select x from pg_catalog.unnest(v_s1) x
        where coalesce(
          (select pg_catalog.jsonb_build_object('provider', c.provider, 'pcid', c.provider_connection_id)
             from clued_private.integration_connections_v1 c where c.integration_id = v_id and c.binding_id = x
            order by c.linked_at desc, c.connection_id limit 1),
          (select pg_catalog.jsonb_build_object('provider', d->>'provider', 'pcid', d->>'provider_connection_id')
             from (select clued_private.integration_binding_identity_v1(x) d) dd))
          = pg_catalog.jsonb_build_object('provider', v_caller->>'provider', 'pcid', v_caller->>'provider_connection_id')
        order by x);
      if not (v_s1 <@ v_lineage) then
        v_partial := true; v_targets := v_lineage;
      end if;
    end if;
    -- step 5: the revocation row
    if v_partial then
      v_outcome := 'PARTIAL_CONNECTION_REVOKE';
    else
      select * into r from clued_private.integration_revocations_v1 where integration_id = v_id and restored_by_regrant_id is null;
      v_has_row := found;
      if not v_has_row and v_status = 'CONNECTION_USER_REVOKE' then
        v_revocation := clued_private.integration_insert_adopted_revocation_v1(v_id, v_s1, v_receipt.id, v_t_rev);
        v_outcome := 'REVOKED'; v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
      elsif v_has_row and pg_catalog.cardinality(v_s1) = 0 then
        v_revocation := r.revocation_id; v_outcome := 'ALREADY_REVOKED';
      elsif v_has_row then
        perform clued_private.integration_extend_revocation_v1(r.revocation_id, v_s1, v_receipt.id);
        v_revocation := r.revocation_id; v_outcome := 'REVOKED';
      else
        insert into clued_private.integration_revocations_v1(integration_id, revoked_by, reason, revoked_binding_ids,
          revocation_source, receipt_id, revoked_at)
        values (v_id, p_revoked_by, v_reason, v_s1, 'INTEGRATION_REVOKE', v_receipt.id, v_t_rev)
        returning revocation_id into v_revocation;
        v_outcome := 'REVOKED';
      end if;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
        'id', v_revocation);
    end if;
    -- step 7: revoke the Bindings (sweeping unowned ones into I)
    v_done := clued_private.integration_revoke_set_v1(v_targets, v_id, p_owner, p_actor->>'kind', v_receipt.id);
    perform clued_private.integration_log_affected_v1(p_owner, p_actor, null, v_id, null,
      case when v_partial then 'PARTIAL_REVOKE' else 'REVOKE' end,
      pg_catalog.jsonb_build_object('revoked_by', p_revoked_by, 'reason', v_reason, 't_cut', v_cut,
        'revocation_id', v_revocation),
      v_outcome, v_receipt.id, array(select pg_catalog.jsonb_array_elements_text(v_done->'revoked')::uuid));
    -- step 8
    if v_outcome = 'ALREADY_REVOKED' then
      v_version := i.version;
    elsif not clued_private.integration_claim_store_consistent_v1(v_id) then
      v_version := i.version; v_flags := v_flags || 'CLAIM_STORE_DIVERGENT'::text;
    else
      v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, '{}'::jsonb);
    end if;
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'outcome', v_outcome, 'revocation_id', v_revocation,
      'revoked_by', case when v_outcome = 'ALREADY_REVOKED' then r.revoked_by else p_revoked_by end,
      'requested_by', p_revoked_by, 't_cut', v_cut, 'revoked_binding_ids', v_done->'revoked',
      'swept_unowned_binding_ids', v_done->'swept', 'foreign_binding_count', v_foreign,
      'outcome_flags', pg_catalog.to_jsonb(v_flags), 'evaluation', e1 - 'facts' - 'sources_read');
    if v_partial then
      v_supp := v_supp || pg_catalog.jsonb_build_object('remaining_binding_count',
        pg_catalog.cardinality(array(select x from pg_catalog.unnest(v_s1) x except select y from pg_catalog.unnest(v_lineage) y)),
        'hint', 'Other connections of this Integration remain; revoke the whole Integration in Clued to revoke them.');
    end if;
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      case when v_version = i.version then '{}'::jsonb else pg_catalog.jsonb_build_object(v_id::text, v_version) end,
      null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.12 the restore basis of I at p_call_at given its evaluation e: {kind, t_loss}, or null when there is
-- nothing to restore. (i) revoked → REVOCATION, t_loss = rev_at(I) (the row a materialization writes);
-- (ii) B9 with FORBIDS_REAUTH → FORBIDS_REAUTH_RECOVERY, t_loss per v0.1.2 MINOR-N2.
create function clued_private.integration_restore_basis_v1(p_integration_id uuid, p_call_at timestamptz, p_e jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare i clued_private.integrations_v1; v_cur uuid; b public.clued_agent_bindings; a clued_private.authorizations_v12;
  v_lost timestamptz; v_marks timestamptz; v_t timestamptz;
begin
  if clued_private.integration_revocation_status_v1(p_integration_id) <> 'NOT_REVOKED' then
    return pg_catalog.jsonb_build_object('kind', 'REVOCATION',
      't_loss', clued_private.integration_rev_at_v1(p_integration_id, p_call_at));
  end if;
  select * into i from clued_private.integrations_v1 where integration_id = p_integration_id;
  if i.recovery_policy <> 'FORBIDS_REAUTH'
     or coalesce((p_e #>> '{predicates,credential_lost}')::boolean, false) is not true then
    return null;
  end if;
  select max(m.raised_at) into v_marks from clued_private.integration_reauth_marks_v1 m
   where m.integration_id = p_integration_id and m.cleared_at is null;
  v_cur := clued_private.integration_current_binding_v1(p_integration_id);
  if v_cur is not null then
    select * into b from public.clued_agent_bindings where id = v_cur;
    select * into a from clued_private.authorizations_v12 where binding_id = v_cur;
    select min(x) into v_lost from pg_catalog.unnest(array[(pg_catalog.to_jsonb(b)->>'expires_at')::timestamptz, b.revoked_at,
      a.expires_at, a.revoked_at]) x where x <= p_call_at;
  else
    select max(c.unlinked_at) into v_lost from clued_private.integration_connections_v1 c
     where c.integration_id = p_integration_id and c.link_status = 'HISTORICAL';
  end if;
  v_t := greatest(v_lost, v_marks);
  if v_t is null then return null; end if;
  return pg_catalog.jsonb_build_object('kind', 'FORBIDS_REAUTH_RECOVERY', 't_loss', v_t);
end $$;

-- §10.12 Old(I) of a restore: Owned(I) \ {new}, and for REVOCATION also UnownedLineage(I, t_loss) \ {new},
-- evaluated before the new connection is linked (v0.1.6 MINOR-N21).
create function clued_private.integration_restore_old_v1(p_integration_id uuid, p_basis jsonb, p_new uuid)
returns uuid[] language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(distinct x order by x), '{}')
    from pg_catalog.unnest(clued_private.integration_owned_unrevoked_v1(p_integration_id)
           || case when p_basis->>'kind' = 'REVOCATION'
                   then clued_private.integration_unowned_lineage_v1(p_integration_id, (p_basis->>'t_loss')::timestamptz)
                   else '{}'::uuid[] end) x
   where x <> p_new
$$;

-- §10.12 restore (family integration_restore), Native (decided_by USER) or Operator (OPERATOR).
create function clued_private.integration_restore_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text, p_decided_by text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  v_id uuid; v_base bigint; v_new uuid; i0 clued_private.integrations_v1; i clued_private.integrations_v1;
  v_conn jsonb; v_basis jsonb; v_basis1 jsonb; v_old uuid[]; v_old1 uuid[]; v_identity jsonb; v_key text;
  v_t_loss timestamptz; e0 jsonb; e1 jsonb; o clued_private.integration_binding_owners_v1; v_has_o boolean;
  v_transfer boolean := false; v_transfer_rec jsonb; v_revocation uuid; v_regrant uuid; v_link_authority text;
  v_done jsonb := '{"revoked":[],"swept":[]}'; v_state text; v_skip_claim boolean := false;
  v_ceiling_before jsonb; v_ceiling_after jsonb; v_cleared uuid[] := '{}'; v_flags text[] := '{}';
  v_version bigint; v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, null, 'integration_restore', p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
      v_new := (p_input->>'new_binding_id')::uuid;
    exception when others then raise exception 'invalid_restore' using errcode = '22023';
    end;
    if v_id is null or v_base is null or v_new is null or p_decided_by not in ('USER','OPERATOR') then
      raise exception 'invalid_restore' using errcode = '22023';
    end if;
    v_link_authority := case p_decided_by when 'USER' then 'NATIVE_RESTORE' else 'OPERATOR_RESTORE' end;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    -- pre-1: unlocked reads of I and the new Binding
    select * into i0 from clued_private.integrations_v1 where integration_id = v_id and owner_id = p_owner;
    if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    v_conn := clued_private.integration_binding_identity_v1(v_new);
    if v_conn is null or (v_conn->>'user_id')::uuid <> p_owner then
      raise exception 'binding_not_owned' using errcode = '42501';
    end if;
    -- derive without evaluate's diagnostic side effect: no advisory lock is taken before L1 (lock order)
    v_basis := clued_private.integration_restore_basis_v1(v_id, v_call_at,
      clued_private.integration_derive_v1(clued_private.integration_normalize_v1(v_id, v_call_at)));
    v_old := clued_private.integration_restore_old_v1(v_id, v_basis, v_new);
    -- pre-2: the new key K (tenant / account keep I's values; the connection is the new Binding's)
    v_identity := pg_catalog.jsonb_build_object('tenant_status', i0.tenant_status, 'tenant', i0.host_tenant_or_workspace_id,
      'account_status', i0.account_status, 'account', i0.host_account_id, 'provider', v_conn->>'provider',
      'connection_status', 'VALUE', 'connection', v_conn->>'provider_connection_id', 'domain', i0.active_binding_domain);
    v_key := clued_private.integration_claim_key_v1(clued_private.integration_claim_key_material_v1(p_owner, i0.host,
      i0.tenant_status, i0.host_tenant_or_workspace_id, i0.account_status, i0.host_account_id, v_conn->>'provider',
      'VALUE', v_conn->>'provider_connection_id', i0.active_binding_domain));
    -- L1 (new Binding and Old(I), owner rows) → L2 → L4 {K0, K} → L5 (§6.4 pre-1…pre-5, v0.1.3 MINOR-N12)
    perform clued_private.integration_lock_bindings_v1(array[v_new] || v_old);
    perform clued_private.integration_claim_lock_v1(array[i0.active_binding_domain || E'\x1f' || i0.claim_key_sha256,
      i0.active_binding_domain || E'\x1f' || v_key]);
    select * into i from clued_private.integrations_v1 where integration_id = v_id for update;
    if i.version <> v_base or i.version <> i0.version then
      raise exception 'integration_version_conflict' using errcode = '40001';
    end if;
    -- pre-5: rechecks under the locks
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    v_basis1 := clued_private.integration_restore_basis_v1(v_id, v_call_at,
      clued_private.integration_derive_v1(clued_private.integration_normalize_v1(v_id, v_call_at)));
    v_old1 := clued_private.integration_restore_old_v1(v_id, v_basis1, v_new);
    if v_basis1 is distinct from v_basis or not (v_old1 <@ v_old) then
      raise exception 'integration_version_conflict' using errcode = '40001';
    end if;
    -- guards (placement choice (d))
    if i.historical <> 'NONE' then
      v_supp := pg_catalog.jsonb_build_object('superseded_by', i.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    if v_basis1 is null then raise exception 'lifecycle_transition_invalid' using errcode = '42501'; end if;
    v_t_loss := (v_basis1->>'t_loss')::timestamptz;
    v_conn := clued_private.integration_binding_identity_v1(v_new);
    if v_conn is null or (v_conn->>'user_id')::uuid <> p_owner then
      raise exception 'binding_not_owned' using errcode = '42501';
    end if;
    if (v_conn->>'authorization_created_at')::timestamptz <= v_t_loss then
      raise exception 'restore_requires_new_authorization_decision' using errcode = '42501';
    end if;
    if not (v_conn->>'live')::boolean or (v_conn->>'p5')::boolean then
      raise exception 'binding_not_adoptable' using errcode = '42501';
    end if;
    if v_conn->>'provider' <> i.provider then
      raise exception 'integration_provider_mismatch' using errcode = '42501';
    end if;
    if i.identity_claim_state in ('CLAIM_CONFLICT','PENDING_RECONCILE') then
      if v_basis1->>'kind' <> 'REVOCATION' or v_key is distinct from i.claim_key_sha256 then
        raise exception 'integration_claim_blocked' using errcode = '42501';
      end if;
      v_skip_claim := true;   -- v0.1.8 MINOR-N27: K = K0, the conflict is left to reconcile
    end if;
    select * into o from clued_private.integration_binding_owners_v1 where binding_id = v_new;
    v_has_o := found;
    if v_has_o and o.integration_id <> v_id then
      if p_decided_by = 'OPERATOR'
         or exists (select 1 from clued_private.integration_connections_v1 x
                     where x.integration_id = o.integration_id and x.binding_id = v_new and x.link_status = 'CURRENT') then
        raise exception 'binding_owned_by_other_integration' using errcode = '42501';
      end if;
      v_transfer := true;
    end if;

    -- the revocation row (materialized here when derived), the regrant, the new connection
    if v_basis1->>'kind' = 'REVOCATION' then
      select revocation_id into v_revocation from clued_private.integration_revocations_v1
       where integration_id = v_id and restored_by_regrant_id is null;
      if v_revocation is null then
        v_revocation := clued_private.integration_materialize_connection_revoke_v1(v_id, v_receipt.id, v_call_at);
        v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
      end if;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
        'id', v_revocation);
    end if;
    insert into clued_private.integration_regrants_v1(integration_id, restore_kind, revocation_id, new_binding_id,
      new_authorization_request_id, new_authorization_created_at, decided_by, receipt_id)
    values (v_id, v_basis1->>'kind', v_revocation, v_new, (v_conn->>'authorization_request_id')::uuid,
      (v_conn->>'authorization_created_at')::timestamptz, p_decided_by, v_receipt.id)
    returning regrant_id into v_regrant;
    if v_revocation is not null then
      update clued_private.integration_revocations_v1 set restored_by_regrant_id = v_regrant where revocation_id = v_revocation;
    end if;
    update clued_private.integration_connections_v1 set link_status = 'HISTORICAL', unlinked_at = pg_catalog.clock_timestamp(),
      unlink_receipt_id = v_receipt.id where integration_id = v_id and link_status = 'CURRENT';
    insert into clued_private.integration_connections_v1(integration_id, binding_id, connection_kind, link_status,
      scopes_at_link, provider, provider_connection_id, link_authority, link_receipt_id)
    values (v_id, v_new, v_conn->>'connection_kind', 'CURRENT', array(select pg_catalog.jsonb_array_elements_text(v_conn->'scopes')),
      v_conn->>'provider', v_conn->>'provider_connection_id', v_link_authority, v_receipt.id);
    if not v_has_o or v_transfer then
      v_transfer_rec := clued_private.integration_take_ownership_v1(v_new, v_id, p_owner, v_link_authority,
        p_actor->>'kind', v_receipt.id);
      if v_transfer then
        v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'ownership_source', 'kind', 'integration',
          'id', o.integration_id);
      end if;
    end if;
    -- Old(I): the superseded credentials are revoked (Owner Decision 1b034f44 item 2, v0.1.5 MINOR-N16)
    if pg_catalog.cardinality(v_old1) > 0 then
      v_done := clued_private.integration_revoke_set_v1(v_old1, v_id, p_owner, p_actor->>'kind', v_receipt.id);
      perform clued_private.integration_log_affected_v1(p_owner, p_actor, null, v_id, null, 'RESTORE_SWEEP',
        pg_catalog.jsonb_build_object('restore_kind', v_basis1->>'kind', 't_loss', v_t_loss), 'REVOKED', v_receipt.id, v_old1);
    end if;
    -- identity and claim (L4 already held)
    if v_skip_claim then
      v_state := i.identity_claim_state;
    else
      v_state := clued_private.integration_claim_core_v1(v_id, v_identity, v_receipt.id);
      if v_state = 'CLAIM_CONFLICT' then
        v_flags := v_flags || 'CLAIM_CONFLICT_AFTER_RESTORE'::text;
        v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'conflict', 'kind', 'integration',
          'id', (select conflicting_integration_id from clued_private.integrations_v1 where integration_id = v_id));
      end if;
    end if;
    -- the new decision is the new ceiling (v0.1.4 MINOR-N14)
    v_ceiling_before := i.authorization_ceiling; v_ceiling_after := v_conn->'authority';
    update clued_private.integrations_v1 set authorization_ceiling = v_ceiling_after,
      authorization_ceiling_set_at = pg_catalog.clock_timestamp(),
      first_authorized_at = coalesce(first_authorized_at,
        case when (v_conn->>'auth_usable')::boolean then pg_catalog.clock_timestamp() end)
    where integration_id = v_id;
    if v_ceiling_before is not null and not clued_private.integration_covers_v1(v_ceiling_before, v_ceiling_after) then
      v_flags := v_flags || 'AUTHORITY_CHANGED_BY_RESTORE'::text;
    end if;
    with cleared as (
      update clued_private.integration_reauth_marks_v1 m set cleared_at = pg_catalog.clock_timestamp(),
        cleared_by = 'RESTORE', cleared_receipt_id = v_receipt.id
       where m.integration_id = v_id and m.cleared_at is null
         and m.raised_at < (v_conn->>'authorization_created_at')::timestamptz
      returning m.mark_id)
    select coalesce(array_agg(mark_id order by mark_id), '{}') into v_cleared from cleared;
    if exists (select 1 from clued_private.integration_reauth_marks_v1 m where m.integration_id = v_id and m.cleared_at is null) then
      v_flags := v_flags || 'REAUTH_MARKS_REMAIN'::text;
    end if;
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, pg_catalog.jsonb_build_object(
      'connection_evidence_kind', case when v_conn->>'provider' = 'clued.oauth.v12' then 'OAUTH_V12_CLIENT_ID' else 'BINDING_ID' end));
    perform clued_private.integration_log_affected_v1(p_owner, p_actor, null, v_id, null, 'RESTORE',
      pg_catalog.jsonb_build_object('restore_kind', v_basis1->>'kind', 'regrant_id', v_regrant, 'new_binding_id', v_new,
        'link_authority', v_link_authority, 't_loss', v_t_loss), v_state, v_receipt.id, array[v_new]);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'regrant_id', v_regrant, 'restore_kind', v_basis1->>'kind',
      'revocation_id', v_revocation, 't_loss', v_t_loss, 'new_binding_id', v_new,
      'new_authorization_created_at', v_conn->>'authorization_created_at', 'link_authority', v_link_authority,
      'identity_claim_state', v_state, 'revoked_binding_ids', v_done->'revoked',
      'swept_unowned_binding_ids', v_done->'swept', 'cleared_reauth_mark_ids', pg_catalog.to_jsonb(v_cleared),
      'ceiling_before', v_ceiling_before, 'ceiling_after', v_ceiling_after,
      'outcome_flags', pg_catalog.to_jsonb(v_flags), 'evaluation', e1 - 'facts' - 'sources_read');
    if v_transfer_rec is not null and not coalesce((v_transfer_rec->>'first_ownership')::boolean, false) then
      v_supp := v_supp || pg_catalog.jsonb_build_object('ownership_transfer', v_transfer_rec);
    end if;
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.11 reauth mark (family integration_reauth_mark). Operator with raised_by ∈ {CLUED, POLICY, SECURITY}
-- (placement choice (e)); the server may call this core with SERVER. A revoked Integration is refused
-- (v0.1.3 NIT-6: by integration_revocation_status_v1, never by integration_state).
create function clued_private.integration_reauth_mark_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text, p_raised_by text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  v_id uuid; v_base bigint; v_reason text := p_input->>'reason'; v_open jsonb; t clued_private.integrations_v1;
  v_mark uuid; e0 jsonb; e1 jsonb; v_version bigint; v_target_refs jsonb := '[]'; v_supp jsonb := '{}';
  v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, null, 'integration_reauth_mark', p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
    exception when others then raise exception 'invalid_reauth_mark' using errcode = '22023';
    end;
    if v_id is null or v_base is null or p_raised_by is null or p_raised_by not in ('CLUED','POLICY','SECURITY','SERVER')
       or v_reason is null or v_reason not in ('SCOPE_RECONSENT_REQUIRED','PROVIDER_RECONFIRMATION','CREDENTIAL_INVALIDATED',
         'HOST_SESSION_INVALIDATED','POLICY_RECONSENT') then
      raise exception 'invalid_reauth_mark' using errcode = '22023';
    end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    if clued_private.integration_revocation_status_v1(v_id) <> 'NOT_REVOKED' then
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;
    v_open := clued_private.integration_write_open_v1(p_actor, p_owner, v_id, v_base, v_receipt.id, v_call_at);
    t := pg_catalog.jsonb_populate_record(null::clued_private.integrations_v1, v_open->'integration');
    if clued_private.integration_revocation_status_v1(v_id) <> 'NOT_REVOKED' then
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;
    if t.historical = 'SUPERSEDED' then
      v_supp := pg_catalog.jsonb_build_object('superseded_by', t.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    insert into clued_private.integration_reauth_marks_v1(integration_id, reason, raised_by, raised_receipt_id)
    values (v_id, v_reason, p_raised_by, v_receipt.id) returning mark_id into v_mark;
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, '{}'::jsonb);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, null, 'REAUTH_MARK',
      pg_catalog.jsonb_build_object('mark_id', v_mark, 'reason', v_reason, 'raised_by', p_raised_by), null, 'MARKED', v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'mark_id', v_mark, 'reason', v_reason,
      'raised_by', p_raised_by, 'outcome_flags', '[]'::jsonb, 'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed',
      v_target_refs || pg_catalog.jsonb_build_object('role', 'reauth_mark', 'kind', 'integration_reauth_mark', 'id', v_mark),
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.11 Operator reauth_clear (family integration_reauth_clear): clears one open mark of I; never touches a
-- revocation (a revoked Integration stays REVOKED, T-A11-2 / T-A11-6).
create function clued_private.integration_reauth_clear_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  v_id uuid; v_base bigint; v_mark uuid; v_reason text := p_input->>'reason'; v_open jsonb; v_flags text[] := '{}';
  e0 jsonb; e1 jsonb; v_version bigint; v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, null, 'integration_reauth_clear', p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
      v_mark := (p_input->>'mark_id')::uuid;
    exception when others then raise exception 'invalid_reauth_clear' using errcode = '22023';
    end;
    if v_id is null or v_base is null or v_mark is null
       or coalesce(pg_catalog.char_length(v_reason), 0) not between 1 and 500 then
      raise exception 'invalid_reauth_clear' using errcode = '22023';
    end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    v_open := clued_private.integration_write_open_v1(p_actor, p_owner, v_id, v_base, v_receipt.id, v_call_at);
    if v_open->>'revocation_id' is not null then
      v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
      v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
        'id', v_open->>'revocation_id');
    end if;
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    perform 1 from clued_private.integration_reauth_marks_v1
     where mark_id = v_mark and integration_id = v_id and cleared_at is null for update;
    if not found then raise exception 'reauth_mark_not_open' using errcode = '42501'; end if;
    update clued_private.integration_reauth_marks_v1 set cleared_at = pg_catalog.clock_timestamp(), cleared_by = 'OPERATOR',
      cleared_receipt_id = v_receipt.id where mark_id = v_mark;
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, '{}'::jsonb);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, null, 'REAUTH_CLEAR',
      pg_catalog.jsonb_build_object('mark_id', v_mark, 'reason', v_reason), null, 'CLEARED', v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'mark_id', v_mark,
      'outcome_flags', pg_catalog.to_jsonb(v_flags), 'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed',
      v_target_refs || pg_catalog.jsonb_build_object('role', 'reauth_mark', 'kind', 'integration_reauth_mark', 'id', v_mark),
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.11 Native capability_expansion (family integration_capability_expansion; optional raw-Binding path,
-- OQ-14): the Owner widens the authorization ceiling (placement choice (f)).
create function clued_private.integration_capability_expansion_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  v_id uuid; v_base bigint; v_new jsonb := p_input->'new_ceiling'; v_open jsonb; t clued_private.integrations_v1;
  e0 jsonb; e1 jsonb; v_version bigint; v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, null, 'integration_capability_expansion', p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
    exception when others then raise exception 'invalid_capability_expansion' using errcode = '22023';
    end;
    if v_id is null or v_base is null or not coalesce(clued_private.integration_ceiling_valid_v1(v_new), false) then
      raise exception 'invalid_capability_expansion' using errcode = '22023';
    end if;
    v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'primary', 'kind', 'integration', 'id', v_id));
    if clued_private.integration_revocation_status_v1(v_id) <> 'NOT_REVOKED' then
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;
    v_open := clued_private.integration_write_open_v1(p_actor, p_owner, v_id, v_base, v_receipt.id, v_call_at);
    t := pg_catalog.jsonb_populate_record(null::clued_private.integrations_v1, v_open->'integration');
    if clued_private.integration_revocation_status_v1(v_id) <> 'NOT_REVOKED' then
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;
    if t.historical = 'SUPERSEDED' then
      v_supp := pg_catalog.jsonb_build_object('superseded_by', t.superseded_by_integration_id);
      raise exception 'integration_superseded' using errcode = '42501';
    end if;
    if t.authorization_ceiling is not null and not clued_private.integration_covers_v1(v_new, t.authorization_ceiling) then
      raise exception 'invalid_capability_expansion' using errcode = '22023';
    end if;
    e0 := clued_private.integration_evaluate_v1(v_id, v_call_at);
    update clued_private.integrations_v1 set authorization_ceiling = v_new, authorization_ceiling_set_at = pg_catalog.clock_timestamp()
     where integration_id = v_id;
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, '{}'::jsonb);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, null, 'CAPABILITY_EXPANSION',
      pg_catalog.jsonb_build_object('ceiling_before', t.authorization_ceiling, 'ceiling_after', v_new), null, 'EXPANDED',
      v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'ceiling_before', t.authorization_ceiling,
      'ceiling_after', v_new, 'outcome_flags', '[]'::jsonb, 'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- §10.13 lifecycle (family integration_lifecycle). Native: installation_completed, pause, resume,
-- request_close, request_archive; Operator: policy_pause, policy_resume, recovery_policy (placement choice
-- (g)). The Request actions never touch integrations_v1 (§5.3 rule 3).
create function clued_private.integration_lifecycle_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text, p_channel text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  v_action text := p_input->>'action'; v_id uuid; v_base bigint; v_request uuid; v_value text := p_input->>'value';
  r clued_private.integration_installation_requests_v1; v_open jsonb; t clued_private.integrations_v1;
  v_from text; v_to text; v_flags text[] := '{}'; e0 jsonb; e1 jsonb; v_version bigint;
  v_target_refs jsonb := '[]'; v_supp jsonb := '{}'; v_error text; v_sqlstate text;
begin
  v_receipt := clued_private.m1_begin_receipt(p_owner, null, 'integration_lifecycle', p_input, p_received_hash);
  if v_receipt.status <> 'pending' then return clued_private.integration_replay_v1(v_receipt); end if;
  begin
    if v_action is null
       or (p_channel = 'native' and v_action not in ('installation_completed','pause','resume','request_close','request_archive'))
       or (p_channel = 'operator' and v_action not in ('policy_pause','policy_resume','recovery_policy'))
       or (v_action = 'recovery_policy' and (v_value is null or v_value not in ('PERMITS_REAUTH','FORBIDS_REAUTH'))) then
      raise exception 'invalid_lifecycle' using errcode = '22023';
    end if;

    if v_action in ('request_close','request_archive') then
      begin
        v_request := (p_input->>'request_id')::uuid; v_base := (p_input->>'base_version')::bigint;
      exception when others then raise exception 'invalid_lifecycle' using errcode = '22023';
      end;
      if v_request is null or v_base is null then raise exception 'invalid_lifecycle' using errcode = '22023'; end if;
      v_target_refs := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('role', 'request',
        'kind', 'integration_installation_request', 'id', v_request));
      select * into r from clued_private.integration_installation_requests_v1
       where request_id = v_request and owner_id = p_owner for update;
      if not found then raise exception 'integration_not_owned' using errcode = '42501'; end if;
      if r.version <> v_base then raise exception 'installation_request_version_conflict' using errcode = '40001'; end if;
      v_from := r.request_status;
      if v_action = 'request_close' and r.request_status in ('OPEN','BOUND') then v_to := 'CLOSED';
      elsif v_action = 'request_archive' and r.request_status <> 'ARCHIVED' then v_to := 'ARCHIVED';
      else raise exception 'lifecycle_transition_invalid' using errcode = '42501';
      end if;
      update clued_private.integration_installation_requests_v1 set request_status = v_to, version = version + 1
       where request_id = v_request;
      perform clued_private.integration_log_v1(p_owner, p_actor, v_request, null, r.bound_integration_id,
        pg_catalog.upper(v_action), pg_catalog.jsonb_build_object('from', v_from, 'to', v_to), null, v_to, v_receipt.id);
      v_supp := pg_catalog.jsonb_build_object('request_id', v_request, 'action', v_action, 'from', v_from, 'to', v_to,
        'request_version', r.version + 1);
      return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs, '{}', null, v_supp);
    end if;

    begin
      v_id := (p_input->>'integration_id')::uuid; v_base := (p_input->>'base_version')::bigint;
    exception when others then raise exception 'invalid_lifecycle' using errcode = '22023';
    end;
    if v_id is null or v_base is null then raise exception 'invalid_lifecycle' using errcode = '22023'; end if;
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
    if v_action = 'installation_completed' then
      v_from := t.install_status; v_to := 'COMPLETED';
      if t.install_status <> 'PENDING' then raise exception 'lifecycle_transition_invalid' using errcode = '42501'; end if;
      update clued_private.integrations_v1 set install_status = 'COMPLETED' where integration_id = v_id;
    elsif v_action = 'recovery_policy' then
      v_from := t.recovery_policy; v_to := v_value;
      if t.recovery_policy = v_value then raise exception 'lifecycle_transition_invalid' using errcode = '42501'; end if;
      update clued_private.integrations_v1 set recovery_policy = v_value where integration_id = v_id;
    else
      v_from := t.ordinary_runtime;
      v_to := case
        when v_action = 'pause' and t.ordinary_runtime = 'PERMITTED' then 'PAUSED_BY_OWNER'
        when v_action = 'resume' and t.ordinary_runtime = 'PAUSED_BY_OWNER' then 'PERMITTED'
        when v_action = 'policy_pause' and t.ordinary_runtime <> 'PAUSED_BY_POLICY' then 'PAUSED_BY_POLICY'
        -- a policy pause laid over an Owner pause gives the Owner pause back (never fails open on it)
        when v_action = 'policy_resume' and t.ordinary_runtime = 'PAUSED_BY_POLICY' then
          case when (select o.source_provenance->>'from' from clued_private.integration_operation_log_v1 o
                      where o.integration_id = v_id and o.operation_type = 'LIFECYCLE'
                        and o.source_provenance->>'action' = 'policy_pause'
                      order by o.recorded_at desc, o.operation_id desc limit 1) = 'PAUSED_BY_OWNER'
               then 'PAUSED_BY_OWNER' else 'PERMITTED' end end;
      if v_to is null then raise exception 'lifecycle_transition_invalid' using errcode = '42501'; end if;
      update clued_private.integrations_v1 set ordinary_runtime = v_to where integration_id = v_id;
    end if;
    v_version := clued_private.integration_touch_v1(v_id, v_receipt.id, '{}'::jsonb);
    perform clued_private.integration_log_v1(p_owner, p_actor, null, v_id, null, 'LIFECYCLE',
      pg_catalog.jsonb_build_object('action', v_action, 'from', v_from, 'to', v_to), null, v_to, v_receipt.id);
    e1 := clued_private.integration_evaluate_v1(v_id, pg_catalog.clock_timestamp());
    if clued_private.integration_gate_violated_v1(e0->'reason_codes', e1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', e1->'reason_codes', 'previous_reason_codes', e0->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', v_id, 'action', v_action, 'from', v_from, 'to', v_to,
      'outcome_flags', pg_catalog.to_jsonb(v_flags), 'evaluation', e1 - 'facts' - 'sources_read');
    return clued_private.integration_finish_v1(v_receipt.id, 'committed', v_target_refs,
      pg_catalog.jsonb_build_object(v_id::text, v_version), null, v_supp);
  exception when others then
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
    return clued_private.integration_finish_v1(v_receipt.id, clued_private.integration_rejected_status_v1(v_sqlstate),
      v_target_refs, '{}', v_error, v_supp);
  end;
end $$;

-- =============================================================================================
-- Part C: PR-2 objects replaced (§10.5 rule 2, §10.9 revocation block, placement choice (j))
-- =============================================================================================

-- §10.5 Native reconcile. REBIND_TO_HOLDER moves I's live CURRENT connection to the holder H and
-- supersedes I; REPLACE_HOLDER supersedes H and makes I the holder. Every non-revoked Binding the
-- superseded party owns moves to the survivor (NATIVE_RECONCILE, v0.1.5 MINOR-N15). PR-4: REPLACE_HOLDER
-- over a revoked H follows rule 2 (v0.1.7 MINOR-N24) instead of PR-2's temporary refusal: R := Owned(H) ∪
-- UnownedLineage(H, rev_at(H)) is revoked and stays H's, the derived revoke is materialized once with
-- [b_H] ∪ R, an open row is extended only when R ≠ ∅, and nothing moves to I.
create or replace function clued_private.integration_reconcile_core_v1(p_actor jsonb, p_owner uuid, p_input jsonb,
  p_received_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt public.clued_audit_receipts; v_call_at timestamptz := pg_catalog.clock_timestamp();
  i0 clued_private.integrations_v1; h0 clued_private.integrations_v1; i clued_private.integrations_v1;
  h clued_private.integrations_v1; v_resolution text := p_input->>'resolution'; v_base bigint; v_hbase bigint;
  v_i_cur uuid; v_h_cur uuid; v_moving uuid[]; v_locked uuid[]; b uuid; v_conn jsonb; v_authority jsonb;
  ei0 jsonb; eh0 jsonb; ei1 jsonb; eh1 jsonb; v_eff jsonb; v_expanded boolean := false; v_transfers jsonb := '[]';
  v_rec jsonb; v_ceiling_before jsonb; v_ceiling_after jsonb; v_ceiling_set_at timestamptz; v_cleared uuid[] := '{}';
  v_flags text[] := '{}'; v_vi bigint; v_vh bigint; v_target_refs jsonb := '[]'; v_supp jsonb := '{}';
  v_error text; v_sqlstate text; v_winner uuid; v_loser uuid; v_h_revoked boolean := false; v_r uuid[] := '{}';
  v_r_lineage uuid[] := '{}'; v_h_rev_at timestamptz; v_revocation uuid; v_done jsonb := '{"revoked":[],"swept":[]}';
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
    -- rule 2 (v0.1.6 MINOR-N20): a revoked H's never-linked same-client grants join L1
    if v_resolution = 'REPLACE_HOLDER' and clued_private.integration_revocation_status_v1(h0.integration_id) <> 'NOT_REVOKED' then
      v_r_lineage := clued_private.integration_unowned_lineage_v1(h0.integration_id,
        clued_private.integration_rev_at_v1(h0.integration_id, v_call_at));
    end if;
    v_locked := array[v_i_cur, v_h_cur] || v_moving || v_r_lineage;
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
                 then i.integration_id else h.integration_id end) <@ v_locked)
       or (v_resolution = 'REPLACE_HOLDER'
           and clued_private.integration_revocation_status_v1(h.integration_id) <> 'NOT_REVOKED'
           and not (clued_private.integration_unowned_lineage_v1(h.integration_id,
                      clued_private.integration_rev_at_v1(h.integration_id, v_call_at)) <@ v_locked)) then
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
    -- evaluate in integration_id order, as list does, so first-occurrence diagnostic locks never cycle
    if i.integration_id < h.integration_id then
      ei0 := clued_private.integration_evaluate_v1(i.integration_id, v_call_at);
      eh0 := clued_private.integration_evaluate_v1(h.integration_id, v_call_at);
    else
      eh0 := clued_private.integration_evaluate_v1(h.integration_id, v_call_at);
      ei0 := clued_private.integration_evaluate_v1(i.integration_id, v_call_at);
    end if;
    if clued_private.integration_revocation_status_v1(i.integration_id) <> 'NOT_REVOKED' then
      raise exception 'integration_revoked_requires_explicit_restore' using errcode = '42501';
    end if;
    v_h_revoked := clued_private.integration_revocation_status_v1(h.integration_id) <> 'NOT_REVOKED';
    if v_h_revoked and v_resolution = 'REBIND_TO_HOLDER' then
      -- REBIND_TO_HOLDER precondition 2: a revoked H receives no connection (OQ-6)
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
      if v_h_revoked then
        -- rule 2, evaluated before H is superseded and its lineage joins Lin*(I)
        v_h_rev_at := clued_private.integration_rev_at_v1(h.integration_id, v_call_at);
        v_r := clued_private.integration_rev_set_v1(h.integration_id, v_h_rev_at);
        select revocation_id into v_revocation from clued_private.integration_revocations_v1
         where integration_id = h.integration_id and restored_by_regrant_id is null;
        if v_revocation is null then
          v_revocation := clued_private.integration_insert_adopted_revocation_v1(h.integration_id, v_r, v_receipt.id, v_call_at);
          v_flags := v_flags || 'REVOCATION_MATERIALIZED'::text;
        elsif pg_catalog.cardinality(v_r) > 0 then
          perform clued_private.integration_extend_revocation_v1(v_revocation, v_r, v_receipt.id);
        end if;
        if pg_catalog.cardinality(v_r) > 0 then
          v_done := clued_private.integration_revoke_set_v1(v_r, h.integration_id, p_owner, 'native_session', v_receipt.id);
        end if;
        if pg_catalog.cardinality(v_r) > 0 or 'REVOCATION_MATERIALIZED' = any(v_flags) then
          perform clued_private.integration_log_affected_v1(p_owner, p_actor, null, h.integration_id, i.integration_id,
            'RECONCILE_REVOKE', pg_catalog.jsonb_build_object('resolution', v_resolution, 'rev_at', v_h_rev_at,
              'revocation_id', v_revocation), 'REVOKED', v_receipt.id, v_r);
        end if;
        v_target_refs := v_target_refs || pg_catalog.jsonb_build_object('role', 'revocation', 'kind', 'integration_revocation',
          'id', v_revocation);
        -- every Binding H owned is now revoked and stays H's (§10.10 step 7): nothing moves to I
        v_moving := '{}';
      end if;
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
    if i.integration_id < h.integration_id then
      ei1 := clued_private.integration_evaluate_v1(i.integration_id, pg_catalog.clock_timestamp());
      eh1 := clued_private.integration_evaluate_v1(h.integration_id, pg_catalog.clock_timestamp());
    else
      eh1 := clued_private.integration_evaluate_v1(h.integration_id, pg_catalog.clock_timestamp());
      ei1 := clued_private.integration_evaluate_v1(i.integration_id, pg_catalog.clock_timestamp());
    end if;
    if clued_private.integration_gate_violated_v1(ei0->'reason_codes', ei1->'reason_codes')
       or clued_private.integration_gate_violated_v1(eh0->'reason_codes', eh1->'reason_codes') then
      v_supp := pg_catalog.jsonb_build_object('reason_codes', ei1->'reason_codes', 'holder_reason_codes', eh1->'reason_codes');
      raise exception 'derivation_input_invalid' using errcode = '22023';
    end if;
    v_supp := pg_catalog.jsonb_build_object('integration_id', i.integration_id, 'holder_integration_id', h.integration_id,
      'resolution', v_resolution, 'surviving_integration_id', v_winner, 'superseded_integration_id', v_loser,
      'ownership_transfer', v_transfers, 'outcome_flags', pg_catalog.to_jsonb(v_flags),
      'holder_revocation_id', v_revocation, 'revoked_binding_ids', v_done->'revoked',
      'swept_unowned_binding_ids', v_done->'swept',
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

-- §10.9 status view. provider_connection_id is shown as an 8-character prefix. PR-4 adds the revocation
-- block (placement choice (h)).
create or replace function clued_private.integration_view_v1(p_integration_id uuid, p_as_of timestamptz)
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
    'lifecycle', pg_catalog.jsonb_build_object('install_status', i.install_status, 'ordinary_runtime', i.ordinary_runtime,
      'recovery_policy', i.recovery_policy, 'historical', i.historical),
    'revocation', clued_private.integration_revocation_view_v1(i.integration_id),
    'open_reauth_marks', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('mark_id', m.mark_id,
        'reason', m.reason, 'raised_by', m.raised_by, 'raised_at', m.raised_at) order by m.raised_at, m.mark_id)
      from clued_private.integration_reauth_marks_v1 m where m.integration_id = i.integration_id and m.cleared_at is null), '[]'::jsonb),
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
    'canonical_verification_evidence_ref', (select pg_catalog.jsonb_build_object('verification_id', v.verification_id,
        'receipt_id', v.receipt_id, 'evidence_sha256', v.evidence_sha256)
      from clued_private.integration_canonical_verifications_v1 v
      where v.integration_id = p_integration_id and v.verified_at <= p_as_of
      order by v.verified_at desc, v.verification_id desc limit 1),
    'last_canonical_verified_at', (select v.verified_at from clued_private.integration_canonical_verifications_v1 v
      where v.integration_id = p_integration_id and v.verified_at <= p_as_of
      order by v.verified_at desc, v.verification_id desc limit 1),
    'last_successful_resume', case when v_has_cur then (select max(s.started_at) from public.clued_continuity_sessions s
      where s.binding_id = v_cur.binding_id and s.started_at >= v_cur.linked_at) end,
    'last_successful_tool_use', case when v_has_cur then (select pg_catalog.jsonb_build_object('receipt_id', r.id, 'at', r.created_at)
      from public.clued_audit_receipts r where r.binding_id = v_cur.binding_id and r.status = 'committed'
      order by r.created_at desc limit 1) end);
end $$;


-- §7.1 / §7.2 normalization with its read provenance: {facts, sources_read}. Never reads READY tables.
create or replace function clued_private.integration_normalize_detail_v1(p_integration_id uuid, p_as_of timestamptz)
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
    -- PR-4 (placement choice (j)): bound_integration_id is immutable once set (§5.3 rule 2) while the status
    -- is not, so a Request close / archive cannot change this fact (§5.3 rule 3, T-A9-5)
    select r.request_payload->>'host_surface' into v_surface from clued_private.integration_installation_requests_v1 r
     where r.bound_integration_id = i.integration_id
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
    'dropped_scopes', pg_catalog.to_jsonb(v_dropped),
    'crv_verification_id', v_facts #> '{canonical_runtime_verification_facts,verification_id}'));
end $$;

-- =============================================================================================
-- Part D: channel entry points
-- =============================================================================================

-- §10.10 Binding revoke_self (revoked_by USER_VIA_HOST): the caller must be I's CURRENT connection. S0 is
-- discovered unlocked and locked together with the caller in one id-ordered pass, and the caller is
-- authenticated under that lock (§10.1 MINOR-N13) — all before the Receipt (§10.1 MINOR-4).
create function public.clued_integration_revoke_self_v1(p_token_hash text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b0 public.clued_agent_bindings; b public.clued_agent_bindings; v_id uuid; v_t_rev timestamptz; v_cut timestamptz;
  v_s0 uuid[]; v_found boolean;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'binding_not_authorized' using errcode = '42501';
  end if;
  -- unlocked discovery: the caller must already be live (not revoked or expired, account usable, v12 grant
  -- live) before any Integration row is read; it is re-authenticated under L1 below. No lock is taken here.
  select * into b0 from public.clued_agent_bindings where token_hash = p_token_hash;
  v_found := found;
  if not v_found or b0.revoked_at is not null
     or coalesce((pg_catalog.to_jsonb(b0)->>'expires_at')::timestamptz <= pg_catalog.clock_timestamp(), false)
     or exists (select 1 from clued_private.authorizations_v12 a where a.binding_id = b0.id
                 and (a.revoked_at is not null or a.expires_at <= pg_catalog.clock_timestamp()))
     or not exists (select 1 from auth.users u where u.id = b0.user_id and (pg_catalog.to_jsonb(u)->>'deleted_at') is null
                     and not coalesce((pg_catalog.to_jsonb(u)->>'banned_until')::timestamptz > pg_catalog.clock_timestamp(), false)) then
    raise exception 'binding_not_authorized' using errcode = '42501';
  end if;
  perform clued_private.integration_require_connection_v1(b0, p_input);
  v_id := (p_input->>'integration_id')::uuid;
  v_t_rev := pg_catalog.clock_timestamp();
  v_cut := clued_private.integration_revoke_cut_v1(v_id, v_t_rev);
  v_s0 := clued_private.integration_rev_set_v1(v_id, v_cut);
  b := clued_private.integration_auth_binding_v1(p_token_hash, v_s0, true);
  perform clued_private.integration_require_connection_v1(b, p_input);
  return clued_private.integration_revoke_core_v1(pg_catalog.jsonb_build_object('kind', 'binding', 'binding_id', b.id,
    'user_id', b.user_id), b.user_id, coalesce(p_input, '{}'::jsonb),
    clued_private.integration_request_hash_v1('integration_revoke', p_input), 'USER_VIA_HOST',
    array(select distinct x from pg_catalog.unnest(v_s0 || b.id) x order by x), v_t_rev, v_cut);
end $$;

-- Native account session (§10.1): the PR-3 dispatcher plus revoke, restore, capability_expansion and
-- lifecycle (§10.15).
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
  elsif v_op = 'revoke' then
    perform clued_private.integration_native_owned_v1(u, v_input);
    return clued_private.integration_revoke_core_v1(v_actor, u, v_input,
      clued_private.integration_request_hash_v1('integration_revoke', v_input), 'USER', null, null, null);
  elsif v_op = 'restore' then
    perform clued_private.integration_native_owned_v1(u, v_input);
    begin
      v_binding := (v_input->>'new_binding_id')::uuid;
    exception when others then v_binding := null;
    end;
    if v_binding is null or not exists (select 1 from public.clued_agent_bindings where id = v_binding and user_id = u) then
      raise exception 'binding_not_owned' using errcode = '42501';
    end if;
    return clued_private.integration_restore_core_v1(v_actor, u, v_input,
      clued_private.integration_request_hash_v1('integration_restore', v_input), 'USER');
  elsif v_op = 'capability_expansion' then
    perform clued_private.integration_native_owned_v1(u, v_input);
    return clued_private.integration_capability_expansion_core_v1(v_actor, u, v_input,
      clued_private.integration_request_hash_v1('integration_capability_expansion', v_input));
  elsif v_op = 'lifecycle' then
    if v_input->>'action' in ('request_close','request_archive') then
      begin
        select owner_id into v_owner from clued_private.integration_installation_requests_v1
         where request_id = (v_input->>'request_id')::uuid;
      exception when others then v_owner := null;
      end;
      if v_owner is null or v_owner <> u then raise exception 'integration_not_owned' using errcode = '42501'; end if;
    else
      perform clued_private.integration_native_owned_v1(u, v_input);
    end if;
    return clued_private.integration_lifecycle_core_v1(v_actor, u, v_input,
      clued_private.integration_request_hash_v1('integration_lifecycle', v_input), 'native');
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
-- Integration's owner. PR-3 ops plus revoke, restore, reauth_mark, reauth_clear, policy_pause,
-- policy_resume and recovery_policy (§10.15). The Operator never transfers ownership (v0.1.5 MINOR-N17).
create or replace function public.clued_admin_integration_v1(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := clued_private.authorization_owner_v12(); v_op text := p_input->>'op'; v_input jsonb := p_input - 'op';
  v_id uuid; v_owner uuid; v_actor jsonb; v_binding uuid;
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
  elsif v_op = 'revoke' then
    -- revoked_by stays in the Receipt input, so a different revoked_by under the same key is a conflict
    return clued_private.integration_revoke_core_v1(v_actor, v_owner, v_input,
      clued_private.integration_request_hash_v1('integration_revoke', v_input),
      case when v_input->>'revoked_by' in ('CLUED','POLICY','SECURITY') then v_input->>'revoked_by' end, null, null, null);
  elsif v_op = 'restore' then
    begin
      v_binding := (v_input->>'new_binding_id')::uuid;
    exception when others then v_binding := null;
    end;
    if v_binding is null or not exists (select 1 from public.clued_agent_bindings where id = v_binding and user_id = v_owner) then
      raise exception 'binding_not_owned' using errcode = '42501';
    end if;
    return clued_private.integration_restore_core_v1(v_actor, v_owner, v_input,
      clued_private.integration_request_hash_v1('integration_restore', v_input), 'OPERATOR');
  elsif v_op = 'reauth_mark' then
    return clued_private.integration_reauth_mark_core_v1(v_actor, v_owner, v_input,
      clued_private.integration_request_hash_v1('integration_reauth_mark', v_input),
      case when v_input->>'raised_by' in ('CLUED','POLICY','SECURITY') then v_input->>'raised_by' end);
  elsif v_op = 'reauth_clear' then
    return clued_private.integration_reauth_clear_core_v1(v_actor, v_owner, v_input,
      clued_private.integration_request_hash_v1('integration_reauth_clear', v_input));
  elsif v_op in ('policy_pause','policy_resume','recovery_policy') then
    v_input := v_input || pg_catalog.jsonb_build_object('action', v_op);
    return clued_private.integration_lifecycle_core_v1(v_actor, v_owner, v_input,
      clued_private.integration_request_hash_v1('integration_lifecycle', v_input), 'operator');
  end if;
  raise exception 'invalid_integration_operation' using errcode = '22023';
end $$;

-- §5.13 / OQ-21: no grant to anyone. The target grants ride the flag-enabling stage authorization's own
-- migration.
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
