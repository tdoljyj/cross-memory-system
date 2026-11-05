-- Unified scheduling, step 2A: one place decides who is on duty.
--
-- Design: work/independent-ci-unified-scheduling-v1/DESIGN.md r4, section 5.1
-- (PR 969). Until now many server functions each decided on their own whether a
-- Binding is "the ci-admission holder": by reading binding_roles_v1 directly,
-- through binding_role_admits_v1(..,'ci-admission'), or through
-- merge_slot_admits_v1. Phase 4 (N publishers, train lease) would have made two
-- sources of "who is on duty" valid at once. This migration puts the decision
-- in clued_private.ci_duty_holder_v1 and clued_private.ci_duty_admits_v1 and
-- routes every such determination of the final definitions through them.
--
-- What does NOT change (the 2A guarantee): while every CI project of the
-- account is at pool policy phase 1..3, or the account has no CI project (no
-- pool_policy row; production on 2026-11-05 has none at all), each routed entry
-- point keeps its own previous criterion (modes below). The single tightening is
-- noted where it happens (the Owner Grant admission door now also matches the
-- Binding's own account, which its Binding id already implied).
-- tests/ci-duty-holder-db.test.mjs evaluates each anchor text of this migration
-- against its replacement over ten role-row states, three Bindings and every
-- phase context.
--
-- What is new and dormant: from phase 4 the on-duty Binding is the holder of an
-- active or sweep_required, unexpired ci_train_lease_v1 row, and the two
-- one-transaction moves ci_phase_3_to_4_v1 / ci_phase_4_to_3_v1 exist. Nothing
-- in the repository or in any Native/Worker wrapper calls the two moves, and
-- the forward move refuses while ci_phase_external_prerequisites_v1 reports any
-- outstanding item (eight are listed there). No pool policy is above phase 1
-- today, and nothing here raises a phase, so applying this migration to
-- production changes no behaviour.
--
-- Not done here (each is an outstanding item of the forward move or a later
-- step of DESIGN 6.1 2A): G9 (the admission records whether its issuer was on
-- duty, so that a handover keeps in-flight jobs valid), G1 (lease_next that
-- never leases kind=maintenance), the dedicated train-maintenance claim (T4),
-- admission metering de-duplication across publishers, the single sweep
-- watermark source of DESIGN 5.2, the 2B green mirror, the 4E resident phase
-- routing, the reconciliation days (Q2), G2/G4..G8/G10, the phase 1->2->3
-- moves, and any wrapper or page for the moves.
--
-- Deviation from DESIGN 5.1 class F, recorded here: the primitive
-- binding_role_admits_v1(..,'ci-admission') is called by ci_duty_admits_v1 (the
-- yes/no form of the duty decision), not by ci_duty_holder_v1; it has no other
-- caller for that role.

-- ---------------------------------------------------------------------------
-- Guard first: 20261102151506 pins the two verify functions' text by hash and
-- refuses scan starts when it changed. This migration rewrites both and re-pins
-- the guard below; that is only right when the guard holds now. A database
-- whose verify text has drifted keeps refusing and needs its own repair.
do $ci_duty_guard_before$ begin
  if to_regprocedure('clued_private.ci_scan_start_native_source_current_v1()') is null
      or clued_private.ci_scan_start_native_source_current_v1() is distinct from true then
    raise exception 'ci_duty_native_source_not_current'; end if;
end $ci_duty_guard_before$;

-- ---------------------------------------------------------------------------
-- Phase and project readers. Read only: no lock, no row created (ci_policy_v1
-- locks and inserts, which a predicate in a hot path must not do).

-- policy.phase read the way Stage 1 reads it ((policy->>'phase')::integer).
-- Absent: 1, as every Stage 1 writer sets it. Unreadable: the largest integer,
-- so that the reader takes the phase-4 branch, which admits only a lease holder
-- or an approved publisher node, never the legacy role.
create function clued_private.ci_duty_phase_value_v1(policy jsonb) returns integer
language plpgsql immutable set search_path='' as $$
begin
  return coalesce((policy->>'phase')::integer,1);
exception when others then
  return 2147483647;
end $$;

-- The account's CI project: the single project with a pool_policy row. No row:
-- null (legacy account, phase 1 semantics). More than one: null as well, and
-- ci_duty_ambiguous_v1 says so.
create function clued_private.ci_duty_project_v1(u uuid) returns uuid
language sql stable security definer set search_path='' as $$
  select case when count(*)=1 then (array_agg(x.project_id))[1] end
  from clued_private.ci_quota_counters_v1 x where x.user_id=u and x.row_kind='pool_policy'
$$;

create function clued_private.ci_duty_ambiguous_v1(u uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select count(*)>1 from clued_private.ci_quota_counters_v1 x where x.user_id=u and x.row_kind='pool_policy'
$$;

-- policy.phase of one project (1 when it has no pool_policy row).
create function clued_private.ci_duty_phase_v1(u uuid,p uuid) returns integer
language sql stable security definer set search_path='' as $$
  select coalesce((select clued_private.ci_duty_phase_value_v1(x.policy) from clued_private.ci_quota_counters_v1 x
      where x.user_id=u and x.row_kind='pool_policy' and x.project_id=p),1)
$$;

-- The highest phase of the account's CI projects (1 without any). The failover
-- watchdog and its switch are per account (DESIGN 5.1 step 5), and an account
-- with several CI projects is in phase 4 as soon as one of them is.
create function clued_private.ci_duty_account_phase_v1(u uuid) returns integer
language sql stable security definer set search_path='' as $$
  select coalesce(max(clued_private.ci_duty_phase_value_v1(x.policy)),1)
  from clued_private.ci_quota_counters_v1 x where x.user_id=u and x.row_kind='pool_policy'
$$;

-- Pool apply (Stage 1 ci_apply_v1) rewrites the whole policy with phase 1. Only
-- the phase moves may change the phase: from phase 2 on, an apply keeps the
-- stored phase, mode and signature gateway flag (used by the rewrite below).
create function clued_private.ci_duty_policy_keep_v1(policy jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select case when clued_private.ci_duty_phase_value_v1(policy)>=2
    then jsonb_build_object('phase',policy->'phase','mode',policy->'mode',
      'signature_gateway_active',coalesce(policy->'signature_gateway_active','false'::jsonb))
    else '{}'::jsonb end
$$;

-- ---------------------------------------------------------------------------
-- ci_duty_holder_v1(u,p): the Binding (and its node) on duty, zero or one row.
--
-- Context: with p, that project's phase. Without p, the account's single CI
-- project; an account without one is phase 1; an account with several is read
-- at its highest phase and, at 4 or more, nobody is on duty (fail closed).
-- phase <= 3: the one unrevoked ci-admission row whose purpose is resident-node
-- or unspecified (the failover watchdog's view, FO:1053, and merge_slot_admits_v1's
-- purpose rule), provided its row has started. Two such rows, none, or one that
-- has not started (a handover inside its five minutes): nobody is on duty.
-- phase >= 4: the holder of an active or sweep_required, unexpired train lease
-- whose Binding is live. sweep_required is on duty for the sweep, the
-- watermark, revocations and keepalive only (duty_merge_slot below needs active).
create function clued_private.ci_duty_holder_v1(u uuid,p uuid default null)
returns table(binding_id uuid,node_id uuid,project_id uuid,phase integer,source text,lease_state text,lease_expires_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare pr uuid; ph integer;
begin
  if p is null and clued_private.ci_duty_ambiguous_v1(u) then
    ph:=clued_private.ci_duty_account_phase_v1(u);
    if ph>=4 then return; end if;
  else
    pr:=coalesce(p,clued_private.ci_duty_project_v1(u));
    ph:=case when pr is null then 1 else clued_private.ci_duty_phase_v1(u,pr) end;
  end if;
  if ph>=4 then
    return query
      select l.holder_binding_id,l.holder_node_id,l.project_id,ph,'train-lease'::text,l.state,l.expires_at
      from clued_private.ci_train_lease_v1 l
      join public.clued_agent_bindings b on b.id=l.holder_binding_id and b.user_id=l.user_id
      where l.user_id=u and l.project_id=pr and l.state in ('active','sweep_required')
        and l.holder_binding_id is not null and l.holder_node_id is not null
        and l.expires_at>clock_timestamp() and clued_private.binding_live_v1(b);
    return;
  end if;
  return query
    select r.binding_id,
      (select n.node_id from clued_private.ci_nodes_v1 n where n.user_id=u and n.binding_id=r.binding_id
        and n.state not in ('retired','revoked') and (pr is null or n.project_id=pr) order by n.created_at,n.node_id limit 1),
      pr,ph,'ci-admission'::text,null::text,null::timestamptz
    from clued_private.binding_roles_v1 r
    where r.user_id=u and r.role='ci-admission' and r.revoked_at is null and r.purpose in ('resident-node','unspecified')
      and r.effective_at<=clock_timestamp()
      and (select count(*) from clued_private.binding_roles_v1 x where x.user_id=u and x.role='ci-admission'
        and x.revoked_at is null and x.purpose in ('resident-node','unspecified'))=1;
end $$;

-- ---------------------------------------------------------------------------
-- ci_duty_admits_v1(u,binding,mode,p): the yes/no every entry point asks.
--
-- For phase <= 3 (and an account without a CI project, and an account with
-- several CI projects that are all at 3 or below) each mode keeps the previous
-- criterion of its entry points, moved here verbatim:
--   duty_role, issuer_role, admission_role
--       a started, unrevoked ci-admission row of the Binding (command door,
--       independent begin/abort/drain, scan start, verify, grant door,
--       admission validity)
--   duty_admits, issuer_admits
--       binding_role_admits_v1: the same, or the account has no unrevoked
--       ci-admission row at all (verify core, merge-slot holders probe)
--   duty_merge_slot, duty_merge_slot_sweep
--       merge_slot_admits_v1: admits, and a started row of this Binding is for a
--       resident node (touch, adopt, return, queue join, lease extend; and
--       watermark and keepalive)
--   duty_publisher
--       a started row that is not parking (ci_publisher_current_v1)
-- From phase 4 (DESIGN 5.1 classes B, C and D):
--   duty_role, duty_admits, duty_merge_slot_sweep: holds the train lease
--       (active or sweep_required);
--   duty_merge_slot: holds the train lease and it is active (no merge-slot work
--       while the new holder still owes its sweep);
--   issuer_role, issuer_admits, duty_publisher: is the Binding of an active,
--       publisher-approved node whose qualification and eligibility are current;
--   admission_role: is the Binding of an active or draining publisher-approved
--       node (an admission already issued is not voided by a lapsed
--       qualification; the node is re-checked where it acts).
-- A Binding id of another account is never admitted.
create function clued_private.ci_duty_admits_v1(u uuid,p_binding uuid,p_mode text,p uuid default null) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare pr uuid; ph integer; b public.clued_agent_bindings%rowtype;
begin
  if p_mode is null or p_mode not in ('duty_role','duty_admits','duty_merge_slot','duty_merge_slot_sweep','duty_publisher',
      'issuer_role','issuer_admits','admission_role') then
    raise exception 'ci_duty_mode_invalid' using errcode='22023'; end if;
  if u is null or p_binding is null then return false; end if;
  if p is null and clued_private.ci_duty_ambiguous_v1(u) then
    ph:=clued_private.ci_duty_account_phase_v1(u);
    if ph>=4 then return false; end if;
  else
    pr:=coalesce(p,clued_private.ci_duty_project_v1(u));
    ph:=case when pr is null then 1 else clued_private.ci_duty_phase_v1(u,pr) end;
  end if;
  if ph>=4 then
    if p_mode in ('duty_role','duty_admits','duty_merge_slot_sweep') then
      return exists(select 1 from clued_private.ci_duty_holder_v1(u,pr) h where h.binding_id=p_binding);
    end if;
    if p_mode='duty_merge_slot' then
      return exists(select 1 from clued_private.ci_duty_holder_v1(u,pr) h where h.binding_id=p_binding and h.lease_state='active');
    end if;
    if p_mode='admission_role' then
      return exists(select 1 from clued_private.ci_nodes_v1 n
        join public.clued_agent_bindings x on x.id=n.binding_id and x.user_id=n.user_id
        where n.user_id=u and n.project_id=pr and n.binding_id=p_binding and n.state in ('active','draining')
          and n.publisher_approved and clued_private.binding_live_v1(x));
    end if;
    return exists(select 1 from clued_private.ci_nodes_v1 n
      join public.clued_agent_bindings x on x.id=n.binding_id and x.user_id=n.user_id
      where n.user_id=u and n.project_id=pr and n.binding_id=p_binding and n.state='active' and n.publisher_approved
        and n.qualification_status='verified' and n.qualification_expires_at>clock_timestamp()
        and n.eligible_until>clock_timestamp() and clued_private.binding_live_v1(x));
  end if;
  if p_mode in ('duty_role','issuer_role','admission_role') then
    return exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=u and r.binding_id=p_binding
      and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp());
  end if;
  if p_mode='duty_publisher' then
    return exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=u and r.binding_id=p_binding
      and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp() and r.purpose<>'parking');
  end if;
  select * into b from public.clued_agent_bindings x where x.id=p_binding and x.user_id=u;
  if not found then return false; end if;
  if not clued_private.binding_role_admits_v1(b,'ci-admission') then return false; end if;
  if p_mode in ('duty_admits','issuer_admits') then return true; end if;
  return not exists(select 1 from jsonb_array_elements(
      clued_private.binding_role_holders_v1(b.user_id,'ci-admission','{}'::uuid[])) h
    where h->>'binding_id'=b.id::text and (h->>'effective_at')::timestamptz<=pg_catalog.clock_timestamp()
      and h->>'purpose' not in ('resident-node','unspecified'));
end $$;

-- merge_slot_admits_v1 keeps its name and its callers (touch, adopt, return,
-- queue join, lease extend); the criterion now lives in ci_duty_admits_v1.
-- Watermark and keepalive call ci_duty_admits_v1 directly (below).
create or replace function clued_private.merge_slot_admits_v1(p_binding public.clued_agent_bindings) returns boolean
language sql stable security definer set search_path='' as $$
  select clued_private.ci_duty_admits_v1(p_binding.user_id,p_binding.id,'duty_merge_slot')
$$;

revoke all on function clued_private.ci_duty_phase_value_v1(jsonb),clued_private.ci_duty_project_v1(uuid),
  clued_private.ci_duty_ambiguous_v1(uuid),clued_private.ci_duty_phase_v1(uuid,uuid),
  clued_private.ci_duty_account_phase_v1(uuid),clued_private.ci_duty_policy_keep_v1(jsonb),
  clued_private.ci_duty_holder_v1(uuid,uuid),clued_private.ci_duty_admits_v1(uuid,uuid,text,uuid)
  from public,anon,authenticated,service_role,clued_worker_gateway;

-- ---------------------------------------------------------------------------
-- Anchored rewrites of the final definitions. Each target is rewritten with
-- one exact, unique piece of its current text; a missing function or an anchor
-- that is absent or repeated aborts the whole migration.

create function clued_private.ci_duty_patch_v1(p_signature text,p_anchor text,p_replacement text) returns void
language plpgsql set search_path='' as $$
declare target regprocedure:=to_regprocedure(p_signature); body text;
begin
  if target is null then raise exception 'ci_duty_patch_function_missing: %',p_signature; end if;
  body:=pg_get_functiondef(target);
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'ci_duty_patch_anchor_mismatch: %',p_signature; end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- Class B: the CI command door's role gate (every node action after it).
select clued_private.ci_duty_patch_v1('clued_private.work_claim_ci_command_v1(text,jsonb)',
$a$not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id
      and r.binding_id=b.id and r.role='ci-admission' and r.revoked_at is null
      and r.effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(b.user_id,b.id,'duty_role')$r$);

-- DESIGN N1, door path: from phase 4 every publication goes through the Stage 1
-- reservation path. The door's run-based publication_begin does not name its
-- check, so it is refused as a whole from phase 4 (abort, reconcile and finish
-- of publications already open stay available).
select clued_private.ci_duty_patch_v1('clued_private.work_claim_ci_command_v1(text,jsonb)',
$a$  if op='publication_begin' then
$a$,
$r$  if op='publication_begin' then
    if clued_private.ci_duty_account_phase_v1(b.user_id)>=4 then
      return jsonb_build_object('status','rejected','error_code','phase_requires_reservation'); end if;
$r$);

-- Class B: watermark and keepalive are allowed while the new lease holder
-- still owes its sweep (DESIGN 5.1 step 1, sweep_required).
select clued_private.ci_duty_patch_v1('clued_private.ci_sweep_watermark_v1(public.clued_agent_bindings,jsonb)',
$a$if not clued_private.merge_slot_admits_v1(b) then$a$,
$r$if not clued_private.ci_duty_admits_v1(b.user_id,b.id,'duty_merge_slot_sweep') then$r$);
select clued_private.ci_duty_patch_v1('clued_private.work_claim_merge_queue_keepalive_v1(public.clued_agent_bindings,jsonb)',
$a$if not clued_private.merge_slot_admits_v1(b) then$a$,
$r$if not clued_private.ci_duty_admits_v1(b.user_id,b.id,'duty_merge_slot_sweep') then$r$);

-- Class C: the three independent-publication commands.
select clued_private.ci_duty_patch_v1('clued_private.work_claim_independent_begin_v1(text,jsonb)',
$a$not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id and r.binding_id=b.id
    and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(b.user_id,b.id,'duty_role')$r$);
select clued_private.ci_duty_patch_v1('clued_private.work_claim_independent_abort_v1(text,jsonb)',
$a$not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id and r.binding_id=b.id
    and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(b.user_id,b.id,'duty_role')$r$);
select clued_private.ci_duty_patch_v1('clued_private.work_claim_independent_drain_command_v1(text,jsonb)',
$a$not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id and r.binding_id=b.id
    and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(b.user_id,b.id,'duty_role')$r$);

-- DESIGN N1, independent path: from phase 4 the 2a path must not publish a
-- merge-slot green, or a batch that began in phase 3 could open a green the
-- server's ledger never sees. (In phase 3 the reservation path refuses it, S1:1030.)
select clued_private.ci_duty_patch_v1('clued_private.work_claim_independent_begin_v1(text,jsonb)',
$a$  -- Consume the existing CI admission door, including its current designated$a$,
$r$  if j->>'role'='control-merge-slot' and clued_private.ci_duty_account_phase_v1(b.user_id)>=4 then
    return jsonb_build_object('status','rejected','error_code','phase_requires_reservation'); end if;
  -- Consume the existing CI admission door, including its current designated$r$);

-- Class D: who may issue an admission (verify path, two reads; the previous
-- admits-only gate; the Owner Grant admission door, whose old text matched the
-- Binding id alone and now also its own account, see the header).
select clued_private.ci_duty_patch_v1('public.clued_work_verify_v1(text,jsonb)',
$a$not exists(select 1 from clued_private.binding_roles_v1 where binding_id=b.id
        and user_id=b.user_id and role='ci-admission' and revoked_at is null
        and effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(b.user_id,b.id,'issuer_role')$r$);
select clued_private.ci_duty_patch_v1('public.clued_work_verify_v1(text,jsonb)',
$a$exists(select 1 from clued_private.binding_roles_v1 where user_id=b.user_id and binding_id=b.id
      and role='ci-admission' and revoked_at is null and effective_at<=clock_timestamp())$a$,
$r$clued_private.ci_duty_admits_v1(b.user_id,b.id,'issuer_role')$r$);
select clued_private.ci_duty_patch_v1('clued_private.work_claim_verify_before_execution_v1(text,jsonb)',
$a$not clued_private.binding_role_admits_v1(v_binding,'ci-admission')$a$,
$r$not clued_private.ci_duty_admits_v1(v_binding.user_id,v_binding.id,'issuer_admits')$r$);
select clued_private.ci_duty_patch_v1('public.clued_owner_grant_admission_door_v1(text,jsonb)',
$a$not exists(select 1 from clued_private.binding_roles_v1 r
      where r.binding_id=v_binding.id and r.role='ci-admission' and r.revoked_at is null
        and r.effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(v_binding.user_id,v_binding.id,'issuer_role')$r$);

-- Class B: the role probe that decides ACTIVE or STANDBY for a resident node.
select clued_private.ci_duty_patch_v1('public.clued_work_merge_slot_holders_v1(text,jsonb)',
$a$not clued_private.binding_role_admits_v1(v_binding,'ci-admission')$a$,
$r$not clued_private.ci_duty_admits_v1(v_binding.user_id,v_binding.id,'duty_admits')$r$);

-- Class D: validity of an issued admission (CI job lease path and the 2a
-- observation). Previous criterion kept for phase <= 3; the full "was on duty
-- when it was issued" fact is G9 and is not part of this migration.
select clued_private.ci_duty_patch_v1('clued_private.ci_claim_current_v1(uuid,clued_private.ci_jobs_v1,text,bigint,uuid)',
$a$not exists(select 1 from clued_private.binding_roles_v1 r
    where r.user_id=u and r.binding_id=ci.id and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(u,ci.id,'admission_role',j.project_id)$r$);
select clued_private.ci_duty_patch_v1('clued_private.work_claim_execution_current_v1(jsonb)',
$a$not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=c.user_id
          and r.binding_id=ci.id and r.role='ci-admission' and r.revoked_at is null
          and r.effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(c.user_id,ci.id,'admission_role')$r$);

-- Class C: the Stage 1 publisher check (only asked while phase < 4).
select clued_private.ci_duty_patch_v1('clued_private.ci_publisher_current_v1(uuid,uuid,uuid,integer,text)',
$a$not exists(select 1 from clued_private.binding_roles_v1 where user_id=u and binding_id=n.binding_id
    and role='ci-admission' and revoked_at is null and effective_at<=clock_timestamp() and purpose<>'parking')$a$,
$r$not clued_private.ci_duty_admits_v1(u,n.binding_id,'duty_publisher',p)$r$);

-- DESIGN 5.4: only the phase moves change the phase. Pool apply keeps the
-- stored phase, mode and gateway flag from phase 2 on (phase 1 unchanged).
select clued_private.ci_duty_patch_v1('clued_private.ci_apply_v1(jsonb,text)',
$a$set policy=jsonb_build_object('mode','prepared','phase',1,'signature_gateway_active',false,
          'limits',case when c ? 'limits' then c->'limits' else policy->'limits' end,
          'status',case when coalesce(case when c ? 'limits' then c->'limits' else policy->'limits' end,'null'::jsonb)='null'::jsonb then 'UNCONFIGURED' else 'CONFIGURED_PREPARED' end),$a$,
$r$set policy=jsonb_build_object('mode','prepared','phase',1,'signature_gateway_active',false,
          'limits',case when c ? 'limits' then c->'limits' else policy->'limits' end,
          'status',case when coalesce(case when c ? 'limits' then c->'limits' else policy->'limits' end,'null'::jsonb)='null'::jsonb then 'UNCONFIGURED' else 'CONFIGURED_PREPARED' end)
          ||clued_private.ci_duty_policy_keep_v1(policy),$r$);

-- DESIGN 5.1 step 5: the 2b failover watchdog is per account and the phase per
-- project; from phase 4 it is retired (the train lease replaces it) and the
-- Owner cannot switch it on.
select clued_private.ci_duty_patch_v1('clued_private.ci_admission_failover_owner_v1(uuid)',
$a$  v_now:=clock_timestamp();
  select * into s from clued_private.ci_failover_settings_v1 x where x.user_id=p_owner;$a$,
$r$  v_now:=clock_timestamp();
  if clued_private.ci_duty_account_phase_v1(p_owner)>=4 then
    return jsonb_build_object('outcome','phase4_retired'); end if;
  select * into s from clued_private.ci_failover_settings_v1 x where x.user_id=p_owner;$r$);
select clued_private.ci_duty_patch_v1('clued_private.ci_failover_change_view_v1(uuid,jsonb)',
$a$    if (p_choices->>'enabled')::boolean=(v_setting->>'enabled')::boolean then$a$,
$r$    if (p_choices->>'enabled')::boolean and clued_private.ci_duty_account_phase_v1(p_owner)>=4 then
      raise exception 'resident_failover_phase4_retired' using errcode='55000'; end if;
    if (p_choices->>'enabled')::boolean=(v_setting->>'enabled')::boolean then$r$);

-- 20261102151506 (scan start keys): the authenticated server-principal clones of
-- the two verify functions carry the same determinations; they get exactly the
-- originals' rewrites, so that each clone stays its original with only the
-- credential entry changed.
select clued_private.ci_duty_patch_v1('clued_private.ci_scan_start_verify_principal_v1(uuid,jsonb)',
$a$not exists(select 1 from clued_private.binding_roles_v1 where binding_id=b.id
        and user_id=b.user_id and role='ci-admission' and revoked_at is null
        and effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(b.user_id,b.id,'issuer_role')$r$);
select clued_private.ci_duty_patch_v1('clued_private.ci_scan_start_verify_principal_v1(uuid,jsonb)',
$a$exists(select 1 from clued_private.binding_roles_v1 where user_id=b.user_id and binding_id=b.id
      and role='ci-admission' and revoked_at is null and effective_at<=clock_timestamp())$a$,
$r$clued_private.ci_duty_admits_v1(b.user_id,b.id,'issuer_role')$r$);
select clued_private.ci_duty_patch_v1('clued_private.ci_scan_start_verify_core_principal_v1(uuid,jsonb)',
$a$not clued_private.binding_role_admits_v1(v_binding,'ci-admission')$a$,
$r$not clued_private.ci_duty_admits_v1(v_binding.user_id,v_binding.id,'issuer_admits')$r$);

-- Class C: the scan-start transaction (local command and hosted entry). The
-- caller must be on duty, as the command door already requires for the local
-- path; from phase 4 the train lease decides, like the door.
select clued_private.ci_duty_patch_v1('clued_private.ci_scan_start_begin_v1(public.clued_agent_bindings,clued_private.ci_scan_start_policies_v1,jsonb,text,text,text)',
$a$not exists(select 1 from clued_private.binding_roles_v1 where user_id=b.user_id and binding_id=b.id
      and role='ci-admission' and revoked_at is null and effective_at<=clock_timestamp())$a$,
$r$not clued_private.ci_duty_admits_v1(b.user_id,b.id,'duty_role')$r$);

-- Re-pin the Native-source guard to the rewritten verify bodies: the guard held
-- before any rewrite (checked at the top), the clones received the same
-- rewrites, and this is the same text and form as 20261102151506 with the two
-- new hashes (create or replace keeps its owner-only ACL). It must hold after.
do $ci_duty_repin$ declare verify_hash text; core_hash text; begin
  select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex') into verify_hash
    from pg_catalog.pg_proc where oid='public.clued_work_verify_v1(text,jsonb)'::regprocedure;
  select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex') into core_hash
    from pg_catalog.pg_proc where oid='clued_private.work_claim_verify_before_execution_v1(text,jsonb)'::regprocedure;
  execute format($source$create or replace function clued_private.ci_scan_start_native_source_current_v1() returns boolean
    language sql stable security definer set search_path='' as $guard$
      select (select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex')
        from pg_catalog.pg_proc where oid='public.clued_work_verify_v1(text,jsonb)'::regprocedure)=%L
      and (select encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex')
        from pg_catalog.pg_proc where oid='clued_private.work_claim_verify_before_execution_v1(text,jsonb)'::regprocedure)=%L
    $guard$ $source$,verify_hash,core_hash);
  if clued_private.ci_scan_start_native_source_current_v1() is distinct from true then
    raise exception 'ci_duty_native_source_repin_failed'; end if;
end $ci_duty_repin$;

drop function clued_private.ci_duty_patch_v1(text,text,text);

-- ---------------------------------------------------------------------------
-- The two moves (DESIGN 5.1 steps 3 and 4). Each is one function call and so
-- one transaction: every check, every write and the phase change commit together
-- or not at all. Private; no wrapper exists, no API role can run them. Neither
-- changes policy.mode (Stage 1 reads only mode='prepared'; DESIGN 5.4 keeps it
-- active from phase 2).

-- What is still outstanding outside what this migration can check. Each item is
-- removed by the migration that ships it; the forward move needs an empty list.
create function clued_private.ci_phase_external_prerequisites_v1(u uuid,p uuid) returns text[]
language sql stable security definer set search_path='' as $$
  select array['green_mirror_2b','admission_issue_fact_g9','resident_phase_routing_4e','reconciliation_days_q2',
    'maintenance_never_leased_g1','dedicated_maintenance_claim_t4','admission_meter_dedup_phase4',
    'sweep_watermark_single_source']::text[]
$$;

-- Greens the server knows to be open: any ledger row not finished.
create function clued_private.ci_phase_open_greens_v1(u uuid,p uuid) returns bigint
language sql stable security definer set search_path='' as $$
  select count(*) from clued_private.ci_green_ledger_v1 g
  where g.user_id=u and g.project_id=p and g.state not in ('abandoned','revoke_confirmed','merged')
$$;

create function clued_private.ci_phase_3_to_4_v1(u uuid,p uuid,p_expected_phase integer,p_request jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q clued_private.ci_quota_counters_v1; h record; n clued_private.ci_nodes_v1; j clued_private.ci_jobs_v1;
  l clued_private.ci_train_lease_v1; unmet text[]:='{}'::text[]; t timestamptz; r uuid; id uuid; gen bigint;
begin
  perform clued_private.work_claim_lock(u);
  perform pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||u::text||':ci-admission',0));
  select * into q from clued_private.ci_quota_counters_v1 where user_id=u and project_id=p and row_kind='pool_policy' for update;
  if not found then raise exception 'CI_PHASE_POLICY_MISSING' using errcode='42501'; end if;
  if p_expected_phase is distinct from 3 or clued_private.ci_duty_phase_value_v1(q.policy) is distinct from 3 then
    raise exception 'CI_PHASE_CAS_MISMATCH' using errcode='40001'; end if;
  t:=clock_timestamp();
  if coalesce(q.policy->>'mode','prepared')='prepared' then unmet:=array_append(unmet,'pool_not_active'); end if;
  if clued_private.ci_duty_ambiguous_v1(u) then unmet:=array_append(unmet,'ambiguous_ci_projects'); end if;
  -- A resident row that has not started yet is a handover in its five minutes;
  -- parking rows never start (effective_at is infinity) and do not count.
  if exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=u and r.role='ci-admission'
      and r.revoked_at is null and r.purpose<>'parking' and r.effective_at>t) then
    unmet:=array_append(unmet,'handover_in_progress'); end if;
  select * into h from clued_private.ci_duty_holder_v1(u,p);
  if h.binding_id is null or h.node_id is null then unmet:=array_append(unmet,'holder_not_single_started_node');
  else
    if not exists(select 1 from public.clued_agent_bindings x where x.id=h.binding_id and x.user_id=u
        and clued_private.binding_live_v1(x)) then unmet:=array_append(unmet,'holder_binding_not_live'); end if;
    select * into n from clued_private.ci_nodes_v1 where user_id=u and project_id=p and node_id=h.node_id;
    if n.state<>'active' or not n.publisher_approved or n.qualification_status<>'verified'
        or n.qualification_expires_at is null or n.qualification_expires_at<=t or n.eligible_until is null or n.eligible_until<=t then
      unmet:=array_append(unmet,'holder_node_not_eligible'); end if;
    if not exists(select 1 from clued_private.ci_node_liveness_v1 x where x.node_id=h.node_id and x.last_heartbeat_at>t-interval '20 minutes') then
      unmet:=array_append(unmet,'holder_not_alive'); end if;
  end if;
  if clued_private.ci_phase_open_greens_v1(u,p)>0 then unmet:=array_append(unmet,'open_green_in_ledger'); end if;
  select * into l from clued_private.ci_train_lease_v1 x where x.user_id=u and x.project_id=p for update;
  if found and (l.holder_node_id is not null or l.state not in ('unheld','silence')) then unmet:=array_append(unmet,'lease_not_empty'); end if;
  if found and l.state='silence' and l.silence_until>t then unmet:=array_append(unmet,'lease_silence'); end if;
  unmet:=unmet||clued_private.ci_phase_external_prerequisites_v1(u,p);
  if cardinality(unmet)>0 then
    raise exception 'CI_PHASE_PREREQUISITES_UNMET:%',array_to_string(unmet,',') using errcode='55000'; end if;
  -- The dedicated maintenance request (kind=maintenance, aimed at the holder).
  if jsonb_typeof(p_request) is distinct from 'object' or p_request->>'kind' is distinct from 'maintenance' then
    raise exception 'CI_PHASE_REQUEST_INVALID' using errcode='22023'; end if;
  id:=clued_private.ci_job_enqueue_v1(u,p,p_request);
  select * into j from clued_private.ci_jobs_v1 where user_id=u and project_id=p and job_id=id for update;
  update clued_private.ci_jobs_v1 set requested_node_id=h.node_id,version=version+1 where job_id=id;
  select * into j from clued_private.ci_jobs_v1 where job_id=id;
  perform clued_private.ci_train_request_current_v1(u,p,n,j);
  r:=clued_private.ci_receipt_v1(u,p,'ci_phase_3_to_4',p::text,jsonb_build_object('holder_binding_id',h.binding_id,
    'holder_node_id',h.node_id,'request_job_id',id));
  -- The failover switch goes off for the account; the lease replaces it.
  update clued_private.ci_failover_settings_v1 set enabled=false,enabled_at=null,version=version+1,updated_at=t,receipt_id=r
    where user_id=u and enabled;
  insert into clued_private.ci_train_lease_v1(user_id,project_id) values(u,p) on conflict do nothing;
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
  gen:=l.generation+1;
  update clued_private.ci_train_lease_v1 set generation=gen,lease_version=1,holder_node_id=h.node_id,holder_binding_id=h.binding_id,
    request_job_id=id,receipt_id=r,state='sweep_required',issued_at=t,ended_at=null,silence_until=null,
    expires_at=least(t+interval '10 minutes',n.eligible_until,n.qualification_expires_at,
      (select expires_at from clued_private.work_claims_v1 where claim_id=j.claim_id)),
    sweep_state='incomplete',sweep_generation=null,sweep_evidence_digest=null
    where user_id=u and project_id=p returning * into l;
  update clued_private.ci_quota_counters_v1 set policy=policy||jsonb_build_object('phase',4),receipt_id=r
    where user_id=u and project_id=p and row_kind='pool_policy';
  return jsonb_build_object('phase',4,'holder_binding_id',h.binding_id,'holder_node_id',h.node_id,'generation',l.generation,
    'lease_version',l.lease_version,'state',l.state,'expires_at',l.expires_at,'request_job_id',id,'receipt_id',r);
end $$;

-- 4 -> 3. The lease ends; the role is the source of duty again. Outcome:
--   kept: the single resident ci-admission holder is alive (heartbeat within
--     20 minutes) on an active, publisher-approved, qualified node;
--   holder_is_former_lease_holder: it is not, but it is the lease's last holder
--     anyway, so there is nobody better to hand to;
--   handed_over: the role goes to the lease's last holder (the holder, or after a
--     node revoke the Binding of last_holder_node_id) by the existing handover
--     core; it starts after five minutes, nobody is on duty meanwhile (fails
--     closed). A parking row of that Binding is revoked first in the same
--     transaction, because the core refuses a target that holds the role.
-- Every other case raises and the whole move rolls back (still phase 4):
-- no single resident holder, no last lease holder to hand to, or a refusal by
-- the handover core (for example a target that is not live).
create function clued_private.ci_phase_4_to_3_v1(u uuid,p uuid,p_expected_phase integer,p_green_settled_by_readback boolean default false) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q clued_private.ci_quota_counters_v1; l clued_private.ci_train_lease_v1; t timestamptz; r uuid;
  d record; keep boolean:=false; v_handover jsonb; v_holders uuid[]; v_target uuid; v_outcome text;
begin
  perform clued_private.work_claim_lock(u);
  perform pg_advisory_xact_lock(hashtextextended('clued-binding-role:'||u::text||':ci-admission',0));
  select * into q from clued_private.ci_quota_counters_v1 where user_id=u and project_id=p and row_kind='pool_policy' for update;
  if not found then raise exception 'CI_PHASE_POLICY_MISSING' using errcode='42501'; end if;
  if p_expected_phase is distinct from 4 or clued_private.ci_duty_phase_value_v1(q.policy) is distinct from 4 then
    raise exception 'CI_PHASE_CAS_MISMATCH' using errcode='40001'; end if;
  if clued_private.ci_phase_open_greens_v1(u,p)>0 and not coalesce(p_green_settled_by_readback,false) then
    raise exception 'CI_PHASE_PREREQUISITES_UNMET:open_green_in_ledger' using errcode='55000'; end if;
  t:=clock_timestamp();
  select * into l from clued_private.ci_train_lease_v1 where user_id=u and project_id=p for update;
  v_target:=coalesce(l.holder_binding_id,
    (select n.binding_id from clued_private.ci_nodes_v1 n where n.user_id=u and n.project_id=p and n.node_id=l.last_holder_node_id));
  r:=clued_private.ci_receipt_v1(u,p,'ci_phase_4_to_3',p::text,jsonb_build_object('former_holder_binding_id',l.holder_binding_id,
    'former_holder_node_id',l.holder_node_id,'last_holder_node_id',l.last_holder_node_id,'generation',l.generation));
  if l.user_id is not null then
    update clued_private.ci_train_lease_v1 set state='silence',receipt_id=r,ended_at=t,silence_until=t+interval '5 minutes',
      last_holder_node_id=coalesce(holder_node_id,last_holder_node_id),last_lost_at=case when holder_node_id is not null then t else last_lost_at end,
      holder_node_id=null,holder_binding_id=null,sweep_state='incomplete' where user_id=u and project_id=p;
  end if;
  update clued_private.ci_quota_counters_v1 set policy=policy||jsonb_build_object('phase',3),receipt_id=r
    where user_id=u and project_id=p and row_kind='pool_policy';
  select * into d from clued_private.ci_duty_holder_v1(u,p);
  if d.binding_id is not null and d.node_id is not null then
    keep:=exists(select 1 from clued_private.ci_node_liveness_v1 x where x.node_id=d.node_id and x.last_heartbeat_at>t-interval '20 minutes')
      and exists(select 1 from clued_private.ci_nodes_v1 n where n.node_id=d.node_id and n.state='active' and n.publisher_approved
        and n.qualification_status='verified' and n.qualification_expires_at>t and n.eligible_until>t);
  end if;
  if keep then v_outcome:='kept';
  else
    select array_agg(x.binding_id) into v_holders from clued_private.binding_roles_v1 x
      where x.user_id=u and x.role='ci-admission' and x.revoked_at is null and x.purpose in ('resident-node','unspecified');
    if v_holders is null or cardinality(v_holders)<>1 then
      raise exception 'CI_PHASE_ROLLBACK_NO_SINGLE_HOLDER' using errcode='55000'; end if;
    if v_target is null then
      raise exception 'CI_PHASE_ROLLBACK_NO_LEASE_HOLDER' using errcode='55000'; end if;
    if v_holders[1]=v_target then v_outcome:='holder_is_former_lease_holder';
    else
      update clued_private.binding_roles_v1 set revoked_at=t,revoked_receipt_id=r
        where user_id=u and binding_id=v_target and role='ci-admission' and purpose='parking' and revoked_at is null;
      v_handover:=clued_private.binding_role_handover_core_v1(u,v_holders[1],v_target,null,
        jsonb_build_object('receipt_kind','CI_ADMISSION_PHASE_ROLLBACK_HANDOVER','principal','ci_phase_4_to_3','phase_receipt_id',r));
      v_outcome:='handed_over';
    end if;
  end if;
  return jsonb_build_object('phase',3,'receipt_id',r,'outcome',v_outcome,'role_holder_kept',keep,'handover',v_handover);
end $$;

revoke all on function clued_private.ci_phase_external_prerequisites_v1(uuid,uuid),clued_private.ci_phase_open_greens_v1(uuid,uuid),
  clued_private.ci_phase_3_to_4_v1(uuid,uuid,integer,jsonb),clued_private.ci_phase_4_to_3_v1(uuid,uuid,integer,boolean)
  from public,anon,authenticated,service_role,clued_worker_gateway;
