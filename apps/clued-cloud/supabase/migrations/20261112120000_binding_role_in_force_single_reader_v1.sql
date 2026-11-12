-- One reader decides whether a Binding's role is in force (defect 2026-11-12).
--
-- A role row carries effective_at: a hand change (20261023010000) starts the
-- new holder's row only after a delay, so two nodes are never on duty at once.
-- work_claim_resolve_pr_v1 (20261108161615) and
-- work_claim_mechanical_proof_error_v1 (20261108144312) read
-- clued_private.binding_roles_v1 themselves and skipped that check: a
-- ci-admission row that had not started yet could bind a PR to a Task and
-- publish the mechanical-files policy.
--
-- 1. binding_role_in_force_v1(account, binding, role) is the only place that
--    reads whether a row has started. A parking row never starts
--    (binding_roles_v1_parking_check: parking <=> effective_at = infinity), so
--    "in force" already excludes parking.
-- 2. Every judge goes through it: binding_role_admits_v1, ci_duty_admits_v1
--    (its role and publisher branches), ci_duty_holder_v1, the
--    resident-upgrade door and the Owner's role list.
-- 3. The two PR doors ask ci_duty_admits_v1(...,'issuer_role'), the same
--    question the verify path asks before it issues an admission (and, from
--    phase 4, the node-based answer instead of the role row).
--
-- tests/ci-admission-handover-db.test.mjs fails on any later function that
-- reads binding_roles_v1 outside its list of role-row owners, or that compares
-- effective_at with the clock anywhere but here; the block at the end of this
-- file refuses the latter already at migration time.
-- tests/binding-role-single-reader-db.test.mjs holds both PR doors to it.

create function clued_private.binding_role_in_force_v1(p_user uuid,p_binding uuid,p_role text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.binding_roles_v1 r
    where r.user_id=p_user and r.binding_id=p_binding and r.role=p_role
      and r.revoked_at is null and r.effective_at<=clock_timestamp())
$$;
revoke all on function clued_private.binding_role_in_force_v1(uuid,uuid,text) from public,anon,authenticated,service_role;

create or replace function clued_private.binding_role_admits_v1(p_binding public.clued_agent_bindings,p_role text)
returns boolean language sql stable security definer set search_path='' as $$
  select clued_private.binding_role_in_force_v1(p_binding.user_id,p_binding.id,p_role)
    or not exists(select 1 from clued_private.binding_roles_v1 r
      where r.user_id=p_binding.user_id and r.role=p_role and r.revoked_at is null)
$$;

-- Rewrites one exact, unique piece of a function's current text; a missing
-- function or an anchor that is absent or repeated stops the migration.
create function clued_private.binding_role_reader_patch_v1(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare target regprocedure:=to_regprocedure(p_signature); body text;
begin
  if target is null then raise exception 'binding_role_reader_patch_missing: %',p_signature; end if;
  body:=pg_get_functiondef(target);
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'binding_role_reader_patch_anchor_mismatch: %',p_signature;
  end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

select clued_private.binding_role_reader_patch_v1('clued_private.work_claim_resolve_pr_v1(text,jsonb)',
$a$  ci:=exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id and r.binding_id=b.id
    and r.role='ci-admission' and r.revoked_at is null);$a$,
$r$  ci:=clued_private.ci_duty_admits_v1(b.user_id,b.id,'issuer_role');$r$);

select clued_private.binding_role_reader_patch_v1('clued_private.work_claim_mechanical_proof_error_v1(public.clued_agent_bindings,jsonb)',
$a$  if not exists(select 1 from clued_private.binding_roles_v1 r
      where r.user_id=p_binding.user_id and r.binding_id=p_binding.id
        and r.role='ci-admission' and r.revoked_at is null) then$a$,
$r$  if not clued_private.ci_duty_admits_v1(p_binding.user_id,p_binding.id,'issuer_role') then$r$);

select clued_private.binding_role_reader_patch_v1('clued_private.ci_duty_admits_v1(uuid,uuid,text,uuid)',
$a$  if p_mode in ('duty_role','issuer_role','admission_role') then
    return exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=u and r.binding_id=p_binding
      and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp());
  end if;
  if p_mode='duty_publisher' then
    return exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=u and r.binding_id=p_binding
      and r.role='ci-admission' and r.revoked_at is null and r.effective_at<=clock_timestamp() and r.purpose<>'parking');
  end if;$a$,
$r$  if p_mode in ('duty_role','issuer_role','admission_role','duty_publisher') then
    return clued_private.binding_role_in_force_v1(u,p_binding,'ci-admission');
  end if;$r$);

select clued_private.binding_role_reader_patch_v1('clued_private.ci_duty_holder_v1(uuid,uuid)',
$a$      and r.effective_at<=clock_timestamp()
$a$,
$r$      and clued_private.binding_role_in_force_v1(u,r.binding_id,'ci-admission')
$r$);

select clued_private.binding_role_reader_patch_v1('clued_private.owner_grant_resident_upgrade_door_v1(text,jsonb)',
$a$  if not exists(select 1 from clued_private.binding_roles_v1 r
      where r.user_id=v_binding.user_id and r.binding_id=v_binding.id and r.role='resident-upgrade'
        and r.revoked_at is null and r.effective_at<=clock_timestamp())
      or not$a$,
$r$  if not clued_private.binding_role_in_force_v1(v_binding.user_id,v_binding.id,'resident-upgrade')
      or not$r$);

-- The Owner's role list shows whether each row is in force by the same reader.
select clued_private.binding_role_reader_patch_v1('public.clued_binding_roles_list_v1(jsonb)',
$a$'in_force',r.effective_at<=clock_timestamp())$a$,
$r$'in_force',clued_private.binding_role_in_force_v1(r.user_id,r.binding_id,r.role))$r$);

drop function clued_private.binding_role_reader_patch_v1(text,text,text);

-- Fail closed on drift: after the rewrites only the reader compares a role
-- row's start with the clock.
do $single_reader$
declare s text;
begin
  select string_agg(p.oid::regprocedure::text,', ') into s from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','clued_private') and p.prosrc ~ 'binding_roles_v1'
      and p.prosrc ~ 'effective_at\s*<=\s*clock_timestamp\(\)'
      and p.oid<>'clued_private.binding_role_in_force_v1(uuid,uuid,text)'::regprocedure;
  if s is not null then raise exception 'binding_role_in_force_bypassed: %',s; end if;
end $single_reader$;
