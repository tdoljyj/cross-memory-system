-- Unified scheduling 2A, second part (Task c176aea6-2346-455c-b9db-15f14d9e2e8b):
-- pull scheduling (G1), the lease sweep (G2), the Owner's phase moves 1<->2<->3
-- (G4), liveness freshness (G5), preference and exclusions (G6), availability
-- windows, the sixth check's publication key (G8) and admissions that survive a
-- duty handover (G9).
-- Design: PR #969 DESIGN.md r4 3.3, 5.4, 6.3, 6.4; Task 5500739b acceptance 3
-- (outside its window a node gets no job). Builds on 2B (20261106090000).
-- Owner Decision be3aa3f9 (Q-A1..Q-A4): the page offers phase moves 1<->2<->3
-- only; 2->1 is refused while work runs or a publication key is reserved; a
-- node's preference comes from its registered profile (changing it means
-- registering again); an availability window gates new leases only.
--
-- Behaviour at phase 1 (production on 2026-11-06: no pool_policy row at all):
-- pool mode stays 'prepared', so enqueue, lease and lease-next keep refusing
-- with CI_SCHEDULING_NOT_ACTIVATED and the sweep finds no lease. The intended
-- changes, each covered by tests/ci-scheduling-t2a2-db.test.mjs:
--   * ci_node_current_v1 also requires a heartbeat within 20 minutes (G5);
--   * a lease by job id also refuses kind=maintenance, a job requested for
--     another node, and every rule of the lease-next filter (G1/G6, so the
--     filter cannot be bypassed by naming a job);
--   * an admission issued while its issuer was on duty stays valid after a
--     handover (G9); a node of the issuer's connection revoked (in the job's
--     project) after the admission was issued voids it; admissions issued
--     before this migration keep the previous rule (the issuer must hold the
--     role now). This also applies to the 2a execution observation
--     (work_claim_execution_current_v1) used by the resident executor today;
--   * the node profile accepts two more keys (availability, preference) and
--     registration copies the preference into the node row;
--   * clued_ci_nodes_v1 also returns phase_moves; ci_nodes_v1 gains revoked_at.
--
-- Phase moves (G4): one Owner two-step confirmation per step of +-1 between
-- phases 1, 2 and 3, with the expected phase. 3<->4 stays with T2A's private
-- moves, unwired (their prerequisites are T4 items).
--
-- Not here: the single sweep watermark source (DESIGN 5.2), metering
-- de-duplication across publishers, the dedicated maintenance claim (T4), 4E and
-- the reconciliation days; they stay outstanding items of the 3->4 move.

-- ---------------------------------------------------------------------------
-- Schema.

create function clued_private.ci_capabilities_valid_v1(a text[]) returns boolean
language sql immutable set search_path='' as $$
  select a is not null and cardinality(a)<=16 and a<@array['linux','windows','docker','hyper-v','windows-sandbox','scan','publish','control','relay','f-pr']::text[]
    and cardinality(a)=(select count(distinct x) from unnest(a) x)
$$;

alter table clued_private.ci_jobs_v1
  add column excluded_node_ids uuid[] not null default '{}' check(cardinality(excluded_node_ids)<=8),
  add column required_capabilities text[] not null default '{}' check(clued_private.ci_capabilities_valid_v1(required_capabilities)),
  add column queued_at timestamptz not null default clock_timestamp(),
  add column retry_of_job_id uuid;
update clued_private.ci_jobs_v1 set queued_at=created_at;

-- When a node was revoked (G9 voids only admissions issued before it). Existing
-- revoked rows: their last update was the revocation.
alter table clued_private.ci_nodes_v1 add column revoked_at timestamptz;
update clued_private.ci_nodes_v1 set revoked_at=updated_at where state='revoked';
alter table clued_private.ci_nodes_v1 add constraint ci_nodes_v1_revoked_at_check check((state='revoked')=(revoked_at is not null));
create function clued_private.ci_node_revoked_at_v1() returns trigger language plpgsql set search_path='' as $$ begin
  if new.state='revoked' and old.state is distinct from 'revoked' then new.revoked_at:=clock_timestamp();
  elsif old.state='revoked' then new.revoked_at:=old.revoked_at; end if;
  return new;
end $$;
create trigger ci_nodes_v1_revoked_at before update on clued_private.ci_nodes_v1 for each row execute function clued_private.ci_node_revoked_at_v1();

-- G2: the sweep records each run, so the 1->2 move can require that it runs.
create table clued_private.ci_lease_sweep_watchdog_v1 (
  singleton boolean primary key default true check(singleton), last_tick_at timestamptz not null, ticks bigint not null default 1);
alter table clued_private.ci_lease_sweep_watchdog_v1 enable row level security;
revoke all on clued_private.ci_lease_sweep_watchdog_v1 from public,anon,authenticated,service_role,clued_worker_gateway;

-- G9: whether the issuer was on duty when the admission was issued, recorded by
-- the insert itself (null: issued before this migration).
alter table clued_private.work_claim_execution_admissions_v1 add column issuer_on_duty boolean;

-- G8: the sixth required check.
alter table clued_private.ci_publish_keys_v1 drop constraint ci_publish_keys_v1_check_name_check;
alter table clued_private.ci_publish_keys_v1 add constraint ci_publish_keys_v1_check_name_check check(check_name in
  ('gitleaks','trivy','contract-placement','kooyumi-admission-verified','kooyumi-merge-slot','kooyumi-work-admission'));

-- G5: ci_node_liveness_v1 is the only liveness source.
comment on column clued_private.ci_nodes_v1.last_heartbeat_at is 'Deprecated (DESIGN G5): never written; liveness is clued_private.ci_node_liveness_v1.';
comment on column clued_private.ci_nodes_v1.heartbeat_sequence is 'Deprecated (DESIGN G5): never written; liveness is clued_private.ci_node_liveness_v1.';
comment on column clued_private.ci_nodes_v1.clock_skew_ms is 'Deprecated (DESIGN G5): never written; liveness is clued_private.ci_node_liveness_v1.';

-- ---------------------------------------------------------------------------
-- G9: the admission records its issue-time fact.

create function clued_private.ci_admission_issue_fact_v1() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if tg_op='INSERT' then
    new.issuer_on_duty:=clued_private.ci_duty_admits_v1(new.user_id,new.ci_binding_id,'issuer_role');
  elsif new.issuer_on_duty is distinct from old.issuer_on_duty then
    raise exception 'CI_IMMUTABLE_FACT' using errcode='55000';
  end if;
  return new;
end $$;
create trigger work_claim_execution_admissions_issue_fact_v1 before insert or update on clued_private.work_claim_execution_admissions_v1
  for each row execute function clued_private.ci_admission_issue_fact_v1();

-- Valid now: issued on duty, issuer's connection live (checked by the callers),
-- and no node of the issuer's connection revoked since it was issued (in the
-- job's project when it is known). Legacy rows: the previous rule.
create function clued_private.ci_admission_issue_valid_v1(u uuid,e clued_private.work_claim_execution_admissions_v1,p uuid default null) returns boolean
language sql stable security definer set search_path='' as $$
  select case when e.admission_id is null then false
    when e.issuer_on_duty is null then clued_private.ci_duty_admits_v1(u,e.ci_binding_id,'admission_role',p)
    else e.issuer_on_duty and not exists(select 1 from clued_private.ci_nodes_v1 n
      where n.user_id=u and n.binding_id=e.ci_binding_id and n.state='revoked' and n.revoked_at>=e.created_at
        and (p is null or n.project_id=p)) end
$$;

-- ---------------------------------------------------------------------------
-- G5, G6 and availability: what a node may lease.

create function clued_private.ci_node_live_v1(node uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.ci_node_liveness_v1 l where l.node_id=node
    and l.last_heartbeat_at>clock_timestamp()-interval '20 minutes')
$$;

-- Minutes since midnight of 'HH:MM' (24:00 allowed as an end).
create function clued_private.ci_clock_minutes_v1(t text) returns integer
language sql immutable set search_path='' as $$
  select case when t ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then split_part(t,':',1)::integer*60+split_part(t,':',2)::integer
    when t='24:00' then 1440 end
$$;

-- profile.availability: {timezone, windows:[{days:[1..7 ISO], start, end}]}.
-- No availability: always available. end<start: the window runs past midnight
-- (the part after midnight belongs to the listed day's window).
create function clued_private.ci_node_available_v1(profile jsonb,at timestamptz) returns boolean
language plpgsql stable set search_path='' as $$
declare a jsonb:=profile->'availability'; w jsonb; local timestamp; dow integer; prev integer; m integer; s integer; e integer;
begin
  if a is null then return true; end if;
  local:=at at time zone (a->>'timezone'); dow:=extract(isodow from local)::integer; prev:=case when dow=1 then 7 else dow-1 end;
  m:=extract(hour from local)::integer*60+extract(minute from local)::integer;
  for w in select x from jsonb_array_elements(a->'windows') x loop
    s:=clued_private.ci_clock_minutes_v1(w->>'start'); e:=clued_private.ci_clock_minutes_v1(w->>'end');
    if s<e then
      if w->'days' @> to_jsonb(dow) and m>=s and m<e then return true; end if;
    else
      if w->'days' @> to_jsonb(dow) and m>=s or w->'days' @> to_jsonb(prev) and m<e then return true; end if;
    end if;
  end loop;
  return false;
exception when others then return false;
end $$;

-- The node profile gains availability and preference (Stage 1 whitelist plus
-- these two keys; every other rule unchanged). Stable now: a timezone must be
-- one PostgreSQL knows.
create or replace function clued_private.ci_profile_v1(p jsonb) returns boolean language plpgsql stable set search_path='' as $$ declare k text; a jsonb; w jsonb; d jsonb; begin
  if jsonb_typeof(p) is distinct from 'object' or p-array['schema','site_id','environment_kinds','slot_count','memory_limit_mb','identity_key_origin','capabilities','exclusions','availability','preference']<>'{}'::jsonb
    or jsonb_typeof(p->'slot_count') is distinct from 'number' or coalesce(p->>'slot_count','') !~ '^[1-9][0-9]*$' or (p->>'slot_count')::numeric>64 then return false; end if;
  if p ? 'schema' and (jsonb_typeof(p->'schema') is distinct from 'string' or p->>'schema'<>'clued.ci-node-profile/1') then return false; end if;
  if p ? 'site_id' and (jsonb_typeof(p->'site_id') is distinct from 'string' or p->>'site_id' !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') then return false; end if;
  if p ? 'memory_limit_mb' and (jsonb_typeof(p->'memory_limit_mb') is distinct from 'number' or coalesce(p->>'memory_limit_mb','') !~ '^[0-9]{1,7}$' or (p->>'memory_limit_mb')::numeric>1048576) then return false; end if;
  if p ? 'identity_key_origin' and (jsonb_typeof(p->'identity_key_origin') is distinct from 'string' or p->>'identity_key_origin' not in ('tpm','software')) then return false; end if;
  foreach k in array array['environment_kinds','capabilities','exclusions'] loop
    if p ? k then
      a:=p->k; if jsonb_typeof(a) is distinct from 'array' then return false; end if;
      if jsonb_array_length(a)>(case when k='environment_kinds' then 4 else 16 end) or k='environment_kinds' and jsonb_array_length(a)=0
        or (select count(*)<>count(distinct x) from jsonb_array_elements(a)x) then return false; end if;
      if exists(select 1 from jsonb_array_elements(a)x where jsonb_typeof(x)<>'string' or
        (k='environment_kinds' and x#>>'{}' not in ('E1-Linux','E1-Windows','E4-Windows-Sandbox','hardened-Windows')) or
        (k<>'environment_kinds' and x#>>'{}' not in ('linux','windows','docker','hyper-v','windows-sandbox','scan','publish','control','relay','f-pr'))) then return false; end if;
    end if;
  end loop;
  if p ? 'preference' and (jsonb_typeof(p->'preference') is distinct from 'string' or p->>'preference' not in ('primary','relay','overflow')) then return false; end if;
  if p ? 'availability' then
    a:=p->'availability';
    if jsonb_typeof(a) is distinct from 'object' or a-array['timezone','windows']<>'{}'::jsonb or not (a ?& array['timezone','windows'])
      or jsonb_typeof(a->'timezone') is distinct from 'string' or length(a->>'timezone')>64
      or not exists(select 1 from pg_catalog.pg_timezone_names z where z.name=a->>'timezone')
      or jsonb_typeof(a->'windows') is distinct from 'array' or jsonb_array_length(a->'windows') not between 1 and 14 then return false; end if;
    for w in select x from jsonb_array_elements(a->'windows') x loop
      if jsonb_typeof(w) is distinct from 'object' or w-array['days','start','end']<>'{}'::jsonb or not (w ?& array['days','start','end'])
        or jsonb_typeof(w->'start') is distinct from 'string' or jsonb_typeof(w->'end') is distinct from 'string'
        or coalesce(clued_private.ci_clock_minutes_v1(w->>'start'),1440)>=1440 or clued_private.ci_clock_minutes_v1(w->>'end') is null
        or clued_private.ci_clock_minutes_v1(w->>'start')=clued_private.ci_clock_minutes_v1(w->>'end')
        or jsonb_typeof(w->'days') is distinct from 'array' or jsonb_array_length(w->'days') not between 1 and 7
        or (select count(*)<>count(distinct x) from jsonb_array_elements(w->'days') x) then return false; end if;
      for d in select x from jsonb_array_elements(w->'days') x loop
        if jsonb_typeof(d) is distinct from 'number' or d::text !~ '^[1-7]$' then return false; end if;
      end loop;
    end loop;
  end if;
  return true;
end $$;

-- What the job needs from a node: its kind's and environment's capability tags
-- and the job's own required capabilities. The node's exclusions (profile and
-- column) may name none of them; the job's own required capabilities must all
-- be among the node's capabilities.
create function clued_private.ci_job_needs_v1(j clued_private.ci_jobs_v1) returns text[]
language sql immutable set search_path='' as $$
  select array(select distinct x from unnest(array[case j.kind when 'delegated_scan' then 'scan' when 'github_f_pr' then 'f-pr'
      when 'control' then 'control' when 'publication' then 'publish' end,
    case when j.required_environment='E1-Linux' then 'linux' else 'windows' end]||j.required_capabilities) x where x is not null order by 1)
$$;
create function clued_private.ci_node_exclusions_v1(n clued_private.ci_nodes_v1) returns text[]
language sql immutable set search_path='' as $$
  select array(select distinct x from (
    select jsonb_array_elements_text(case when jsonb_typeof(n.profile->'exclusions')='array' then n.profile->'exclusions' else '[]'::jsonb end) x
    union all select jsonb_array_elements_text(case when jsonb_typeof(n.exclusions)='array' then n.exclusions else '[]'::jsonb end)) y order by 1)
$$;

-- DESIGN 6.3 for one job and one node; null when it fits. p_scope 'static'
-- leaves out what changes by the minute (availability, preference wait) and the
-- per-job node exclusion; it decides whether any other node could take the job.
create function clued_private.ci_job_fit_v1(j clued_private.ci_jobs_v1,n clued_private.ci_nodes_v1,at timestamptz,p_scope text default 'lease') returns text
language plpgsql stable set search_path='' as $$ begin
  if j.kind='maintenance' then return 'CI_JOB_KIND_NOT_LEASABLE'; end if;
  if j.requested_node_id is not null and j.requested_node_id<>n.node_id then return 'CI_JOB_REQUESTED_ELSEWHERE'; end if;
  if not coalesce(n.profile->'environment_kinds' ? j.required_environment,false)
    or coalesce((n.profile->>'memory_limit_mb')::integer,0)<j.required_memory_mb then return 'CI_NODE_CAPACITY_UNAVAILABLE'; end if;
  if n.qualification_source is distinct from j.source_sha then return 'CI_SOURCE_NOT_ACCEPTED'; end if;
  if j.kind='delegated_scan' and (not n.hardening_observed or not n.scan_signing_approved) then return 'CI_SCAN_NODE_NOT_APPROVED'; end if;
  if clued_private.ci_job_needs_v1(j) && clued_private.ci_node_exclusions_v1(n) then return 'CI_NODE_EXCLUDES_JOB'; end if;
  if not j.required_capabilities<@array(select jsonb_array_elements_text(case when jsonb_typeof(n.profile->'capabilities')='array'
      then n.profile->'capabilities' else '[]'::jsonb end)) then return 'CI_NODE_CAPABILITY_MISSING'; end if;
  if p_scope='static' then return null; end if;
  if n.node_id=any(j.excluded_node_ids) then return 'CI_NODE_EXCLUDED_FOR_JOB'; end if;
  if not clued_private.ci_node_available_v1(n.profile,at) then return 'CI_NODE_OUTSIDE_AVAILABILITY'; end if;
  if n.preference in ('relay','overflow') and j.queued_at>at-interval '60 seconds' then return 'CI_NODE_PREFERENCE_WAIT'; end if;
  return null;
end $$;

-- A node able to take jobs at all (state, qualification, connection, heartbeat).
create function clued_private.ci_node_ready_v1(n clued_private.ci_nodes_v1) returns boolean
language sql stable security definer set search_path='' as $$
  select n.state='active' and n.qualification_status='verified' and n.qualification_expires_at>clock_timestamp()
    and n.eligible_until>clock_timestamp() and clued_private.ci_node_live_v1(n.node_id)
    and exists(select 1 from public.clued_agent_bindings b where b.id=n.binding_id and b.user_id=n.user_id and clued_private.binding_live_v1(b))
$$;

-- DESIGN 6.4 rule 3: a job's node exclusion is waived when no other ready node
-- could take it, except for a depth-1 (head key) execution: its excluded node
-- has already burned its head key for this head.
create function clued_private.ci_job_exclusion_waived_v1(j clued_private.ci_jobs_v1) returns boolean
language sql stable security definer set search_path='' as $$
  select not (j.kind='combination_execution' and j.combination_mode not in ('depth2','depth3'))
    and not exists(select 1 from clued_private.ci_nodes_v1 m where m.user_id=j.user_id and m.project_id=j.project_id
      and not (m.node_id=any(j.excluded_node_ids)) and clued_private.ci_node_ready_v1(m)
      and clued_private.ci_job_fit_v1(j,m,clock_timestamp(),'static') is null)
$$;

create function clued_private.ci_job_lease_fit_v1(j clued_private.ci_jobs_v1,n clued_private.ci_nodes_v1,at timestamptz) returns text
language plpgsql stable security definer set search_path='' as $$ declare code text; waived clued_private.ci_jobs_v1; begin
  code:=clued_private.ci_job_fit_v1(j,n,at,'lease');
  if code='CI_NODE_EXCLUDED_FOR_JOB' and clued_private.ci_job_exclusion_waived_v1(j) then
    waived:=j; waived.excluded_node_ids:='{}';
    code:=clued_private.ci_job_fit_v1(waived,n,at,'lease'); end if;
  return code;
end $$;

-- A queued job that can never be leased again: each test mirrors a refusal of
-- ci_claim_current_v1 that no later event can undo (claim ended, draining,
-- fenced or moved to a new execution epoch (an execution handover moves it at
-- once), superseded by a newer single claim of the Task, holder connection
-- revoked; head authorization revoked; admission's issuer gone). Null while it
-- may still become leasable: an older copy of a race (copies share the Task's
-- fence sequence), claim resources that differ from the admission's (a renew can
-- restore them), a quota.
create function clued_private.ci_job_stale_v1(j clued_private.ci_jobs_v1) returns text
language sql stable security definer set search_path='' as $$
  select case
    when c.claim_id is null or c.fence is distinct from j.claim_fence or c.execution_epoch is distinct from j.execution_epoch
      or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() or c.outcome='not_adopted'
      or c.copy_index is null and exists(select 1 from clued_private.work_claims_v1 newer where newer.user_id=j.user_id and newer.task_id=c.task_id and newer.fence>c.fence)
      or not exists(select 1 from public.clued_agent_bindings b where b.id=c.holder_binding_id and clued_private.binding_live_v1(b))
      then 'CI_CLAIM_NOT_CURRENT'
    when not exists(select 1 from clued_private.work_claim_head_authorizations_v1 a where a.authorization_id=j.head_authorization_id and a.revoked_at is null)
      then 'CI_HEAD_AUTHORIZATION_NOT_CURRENT'
    when not exists(select 1 from clued_private.work_claim_execution_admissions_v1 e join public.clued_agent_bindings b on b.id=e.ci_binding_id
        where e.admission_id=j.admission_id and clued_private.binding_live_v1(b) and clued_private.ci_admission_issue_valid_v1(j.user_id,e,j.project_id))
      then 'CI_ADMISSION_BINDING_NOT_CURRENT'
  end
  from (select 1) one left join clued_private.work_claims_v1 c on c.user_id=j.user_id and c.claim_id=j.claim_id
$$;

-- The queue in DESIGN 6.3 order: priority, then the head batch of 2a's merge
-- queue (its single source: work_claim_merge_queue_current_v1), then queue time.
create function clued_private.ci_job_candidates_v1(u uuid,p uuid,at timestamptz,lim integer) returns setof clued_private.ci_jobs_v1
language sql stable security definer set search_path='' as $$
  with heads as materialized (select array(select x from (select (clued_private.work_claim_merge_queue_current_v1(u,r)->'head'->>'claim_id')::uuid x
      from unnest(clued_private.work_claim_merge_queue_refs_v1(u,null)) r) y where x is not null) ids)
  select x.* from clued_private.ci_jobs_v1 x cross join heads h
  where x.user_id=u and x.project_id=p and x.state='queued' and x.kind<>'maintenance' and x.eligible_after<=at
  order by x.priority,coalesce(x.claim_id=any(h.ids),false) desc,x.queued_at,x.created_at,x.job_id
  limit lim
$$;

-- What a node is told about the job it leased.
create function clued_private.ci_job_public_v1(j clued_private.ci_jobs_v1) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('job_id',j.job_id,'kind',j.kind,'repository_id',j.repository_id,'repository_name',j.repository_name,
    'pr_ref',j.pr_ref,'target_branch',j.target_branch,'workflow',j.workflow,'head_sha',j.head_sha,'base_sha',j.base_sha,'test_sha',j.test_sha,
    'source_sha',j.source_sha,'combination_sha256',j.combination_sha256,'combination_mode',j.combination_mode,'role',j.role,'attempt',j.attempt,
    'parent_job_id',j.parent_job_id,'parent_lease_generation',j.parent_lease_generation,'required_environment',j.required_environment,
    'required_memory_mb',j.required_memory_mb,'required_capabilities',to_jsonb(j.required_capabilities),'stage8_limit',j.stage8_limit,
    'priority',j.priority,'origin',j.origin,'version',j.version)
$$;

-- ---------------------------------------------------------------------------
-- Anchored rewrites (the T2A method).

create function clued_private.ci_t2a2_patch_v1(p_signature text,p_anchor text,p_replacement text) returns void
language plpgsql set search_path='' as $$
declare target regprocedure:=to_regprocedure(p_signature); body text;
begin
  if target is null then raise exception 'ci_t2a2_patch_function_missing: %',p_signature; end if;
  body:=pg_get_functiondef(target);
  if (length(body)-length(replace(body,p_anchor,'')))<>length(p_anchor) then
    raise exception 'ci_t2a2_patch_anchor_mismatch: %',p_signature; end if;
  execute replace(body,p_anchor,p_replacement);
end $$;

-- G5: every node operation needs a heartbeat within 20 minutes.
select clued_private.ci_t2a2_patch_v1('clued_private.ci_node_current_v1(uuid,uuid,uuid,boolean,text)',
$a$    or publisher and not n.publisher_approved then raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;$a$,
$r$    or publisher and not n.publisher_approved or not clued_private.ci_node_live_v1(n.node_id) then
    raise exception 'CI_NODE_NOT_ELIGIBLE' using errcode='42501'; end if;$r$);

-- G1/G6: a lease by job id obeys the lease-next filter (maintenance never
-- leased, requested node, exclusions, availability, preference wait).
select clued_private.ci_t2a2_patch_v1('clued_private.ci_job_lease_v1(uuid,uuid,uuid,uuid,bigint)',
$a$declare j clued_private.ci_jobs_v1; n clued_private.ci_nodes_v1; q clued_private.ci_quota_counters_v1; l clued_private.ci_job_leases_v1; t timestamptz; r uuid;$a$,
$r$declare j clued_private.ci_jobs_v1; n clued_private.ci_nodes_v1; q clued_private.ci_quota_counters_v1; l clued_private.ci_job_leases_v1; t timestamptz; r uuid; fit text;$r$);
select clued_private.ci_t2a2_patch_v1('clued_private.ci_job_lease_v1(uuid,uuid,uuid,uuid,bigint)',
$a$  if j.kind='delegated_scan' and (not n.hardening_observed or not n.scan_signing_approved) then raise exception 'CI_SCAN_NODE_NOT_APPROVED' using errcode='42501'; end if;$a$,
$r$  if j.kind='delegated_scan' and (not n.hardening_observed or not n.scan_signing_approved) then raise exception 'CI_SCAN_NODE_NOT_APPROVED' using errcode='42501'; end if;
  fit:=clued_private.ci_job_lease_fit_v1(j,n,clock_timestamp());
  if fit is not null then raise exception using message=fit,errcode='42501'; end if;$r$);
-- A requeued job starts its queue wait again.
select clued_private.ci_t2a2_patch_v1('clued_private.ci_job_enqueue_v1(uuid,uuid,jsonb)',
$a$    'combination_sha256','combination_mode','role','attempt','origin','parent_job_id','parent_lease_generation','required_environment'],$a$,
$r$    'combination_sha256','combination_mode','role','attempt','origin','parent_job_id','parent_lease_generation','required_environment','required_capabilities'],$r$);
select clued_private.ci_t2a2_patch_v1('clued_private.ci_job_enqueue_v1(uuid,uuid,jsonb)',
$a$  perform clued_private.ci_claim_current_v1(u,j);$a$,
$r$  if p_input ? 'required_capabilities' then
    if jsonb_typeof(p_input->'required_capabilities') is distinct from 'array'
      or exists(select 1 from jsonb_array_elements(p_input->'required_capabilities') x where jsonb_typeof(x)<>'string')
      or not clued_private.ci_capabilities_valid_v1(array(select jsonb_array_elements_text(p_input->'required_capabilities')))
      or array(select jsonb_array_elements_text(p_input->'required_capabilities'))
        <>array(select x from jsonb_array_elements_text(p_input->'required_capabilities') x order by 1) then
      raise exception 'CI_JOB_SCALAR_INVALID' using errcode='22023'; end if;
    update clued_private.ci_jobs_v1 set required_capabilities=array(select jsonb_array_elements_text(p_input->'required_capabilities'))
      where job_id=j.job_id returning * into j;
  end if;
  perform clued_private.ci_claim_current_v1(u,j);$r$);

-- Registration copies the profile's preference into the node row.
select clued_private.ci_t2a2_patch_v1('public.clued_ci_node_registration_v1(jsonb)',
$a$    coalesce((p_input->>'scan_signing_requested')::boolean,false),(to_jsonb(b)->>'expires_at')::timestamptz,d,p_input->>'idempotency_key') returning * into n;$a$,
$r$    coalesce((p_input->>'scan_signing_requested')::boolean,false),(to_jsonb(b)->>'expires_at')::timestamptz,d,p_input->>'idempotency_key') returning * into n;
  update clued_private.ci_nodes_v1 set preference=coalesce(n.profile->>'preference','primary') where node_id=n.node_id returning * into n;$r$);

-- G9: admission validity is the issue-time fact plus the issuer's connection.
select clued_private.ci_t2a2_patch_v1('clued_private.ci_claim_current_v1(uuid,clued_private.ci_jobs_v1,text,bigint,uuid)',
$a$not clued_private.ci_duty_admits_v1(u,ci.id,'admission_role',j.project_id)$a$,
$r$not clued_private.ci_admission_issue_valid_v1(u,e,j.project_id)$r$);
select clued_private.ci_t2a2_patch_v1('clued_private.work_claim_execution_current_v1(jsonb)',
$a$not clued_private.ci_duty_admits_v1(c.user_id,ci.id,'admission_role')$a$,
$r$not clued_private.ci_admission_issue_valid_v1(c.user_id,a)$r$);

-- G8: the sixth check reserves like the other control checks (from phase 4 it
-- needs the current train lease).
select clued_private.ci_t2a2_patch_v1('clued_private.ci_publish_prepare_v1(uuid,uuid,uuid,uuid,bigint,jsonb)',
$a$    or coalesce(data->>'check_name','') not in ('gitleaks','trivy','contract-placement','kooyumi-admission-verified','kooyumi-merge-slot')$a$,
$r$    or coalesce(data->>'check_name','') not in ('gitleaks','trivy','contract-placement','kooyumi-admission-verified','kooyumi-merge-slot','kooyumi-work-admission')$r$);
select clued_private.ci_t2a2_patch_v1('clued_private.ci_publish_prepare_v1(uuid,uuid,uuid,uuid,bigint,jsonb)',
$a$  if data->>'check_name' in ('kooyumi-admission-verified','kooyumi-merge-slot') and (q.policy->>'phase')::integer>=4 then$a$,
$r$  if data->>'check_name' in ('kooyumi-admission-verified','kooyumi-merge-slot','kooyumi-work-admission') and (q.policy->>'phase')::integer>=4 then$r$);

-- G4: the Owner page shows each phase move with what still blocks it.
select clued_private.ci_t2a2_patch_v1('public.clued_ci_nodes_v1(jsonb)',
$a$'node_list',clued_private.ci_node_list_view_v1(u,p),$a$,
$r$'node_list',clued_private.ci_node_list_view_v1(u,p),'phase_moves',clued_private.ci_phase_moves_view_v1(u,p),$r$);

-- ---------------------------------------------------------------------------
-- G1: lease the next job (DESIGN 6.3). One transaction; the lease itself is
-- Stage 1's ci_job_lease_v1 (quota, claim, Source and every recheck unchanged).
-- A candidate whose lease fails is skipped in its own subtransaction. One that
-- can never be leased again (ci_job_stale_v1) is invalidated with a receipt and
-- does not count; after 16 other failures lease-next stops.
create function clued_private.ci_job_lease_next_v1(u uuid,p uuid,node uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare q clued_private.ci_quota_counters_v1; n clued_private.ci_nodes_v1; j clued_private.ci_jobs_v1; t timestamptz;
  res jsonb; tried integer:=0; failed integer:=0; skipped jsonb:='[]'::jsonb; code text; stale text; r uuid;
begin
  perform clued_private.work_claim_lock(u);
  q:=clued_private.ci_policy_v1(u,p);
  if q.policy->>'mode'='prepared' then raise exception 'CI_SCHEDULING_NOT_ACTIVATED' using errcode='42501'; end if;
  n:=clued_private.ci_node_current_v1(u,p,node);
  if coalesce((n.profile->>'slot_count')::integer,0)<=(select count(*) from clued_private.ci_job_leases_v1
      where holder_node_id=node and state='current' and expires_at>clock_timestamp()) then
    return jsonb_build_object('state','none','reason','CI_NODE_CAPACITY_UNAVAILABLE','tried',0); end if;
  t:=clock_timestamp();
  for j in select * from clued_private.ci_job_candidates_v1(u,p,t,500) loop
    continue when clued_private.ci_job_lease_fit_v1(j,n,t) is not null;
    exit when failed>=16;
    tried:=tried+1;
    begin
      res:=clued_private.ci_job_lease_v1(u,p,node,j.job_id,j.version);
      select * into j from clued_private.ci_jobs_v1 where job_id=j.job_id;
      return res||jsonb_build_object('state','leased','tried',tried,'job',clued_private.ci_job_public_v1(j));
    exception when others then
      code:=case when sqlerrm ~ '^[A-Z][A-Z0-9_]{2,80}(:[A-Za-z0-9_]{1,80})?$' then sqlerrm else 'CI_LEASE_FAILED' end;
    end;
    stale:=clued_private.ci_job_stale_v1(j);
    if stale is not null then
      r:=clued_private.ci_receipt_v1(u,p,'ci_job_invalidated',j.job_id::text,jsonb_build_object('reason',stale,'lease_error',code));
      update clued_private.ci_jobs_v1 set state='invalidated',version=version+1,updated_at=clock_timestamp(),receipt_id=r
        where job_id=j.job_id and state='queued';
      skipped:=skipped||jsonb_build_array(jsonb_build_object('job_id',j.job_id,'error_code',stale,'invalidated',true));
    else
      failed:=failed+1;
      skipped:=skipped||jsonb_build_array(jsonb_build_object('job_id',j.job_id,'error_code',code));
      exit when code in ('CI_NODE_NOT_ELIGIBLE','CI_BINDING_UNAVAILABLE','CI_SCHEDULING_NOT_ACTIVATED');
    end if;
  end loop;
  return jsonb_build_object('state','none','tried',tried,'skipped',skipped);
end $$;

-- ---------------------------------------------------------------------------
-- G2: the lease sweep (DESIGN 6.4), every minute under pg_cron.

-- One expired current lease. Released through Stage 1's ci_job_release_v1 as
-- the server's own verified classification: environment (the node went away),
-- breaker 'lease_expired', so it never counts as a head release and refunds
-- the evaluation hold.
create function clued_private.ci_job_lease_expire_v1(u uuid,p uuid,id uuid,g bigint) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare l clued_private.ci_job_leases_v1; j clued_private.ci_jobs_v1; q clued_private.ci_quota_counters_v1; inp jsonb; nid uuid;
  r uuid; outcome text; head_key boolean; keyed boolean; produced boolean; consumed boolean;
begin
  q:=clued_private.ci_policy_v1(u,p);
  select * into l from clued_private.ci_job_leases_v1 where user_id=u and project_id=p and job_id=id and generation=g;
  if not found or l.state<>'current' or l.expires_at>clock_timestamp() then return jsonb_build_object('outcome','not_expired'); end if;
  select * into j from clued_private.ci_jobs_v1 where job_id=id;
  keyed:=exists(select 1 from clued_private.ci_publish_keys_v1 k where k.job_id=id);
  produced:=exists(select 1 from clued_private.ci_result_index_v1 x where x.job_id=id and x.execution_generation=g);
  -- Every kind it produced already reserved by the parent: nothing left to run.
  consumed:=produced and not exists(select 1 from clued_private.ci_result_index_v1 x where x.job_id=id and x.execution_generation=g
    and not exists(select 1 from clued_private.ci_publish_keys_v1 k where k.user_id=u and k.job_id=j.parent_job_id and k.check_name=x.result_kind));
  perform clued_private.ci_job_release_v1(u,p,l.holder_node_id,id,g,case when l.started_at is null then 'LEASE_EXPIRED' else 'LEASE_LOST_AFTER_START' end,
    case when j.state='observed' then 'success' else 'environment' end,'lease_expired',true);
  select * into j from clued_private.ci_jobs_v1 where job_id=id;
  if l.started_at is null then
    -- Not started: back to the queue, same job; nothing was consumed.
    r:=clued_private.ci_receipt_v1(u,p,'ci_job_restored',id::text,jsonb_build_object('generation',g,'holder_node_id',l.holder_node_id));
    update clued_private.ci_jobs_v1 set state='queued',origin='restored',queued_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp(),receipt_id=r
      where job_id=id and current_generation=g and state='canceled';
    return jsonb_build_object('outcome','restored','job_id',id,'receipt_id',r);
  end if;
  -- Started and lost (DESIGN 6.4 rule 3). Publication-bearing jobs never move.
  -- Results already produced can no longer be published (no current lease):
  -- they are invalidated, and the retry runs again from scratch, unless the
  -- parent job already reserved a publication for every kind produced.
  head_key:=j.kind='combination_execution' and j.combination_mode not in ('depth2','depth3');
  if produced then
    update clued_private.ci_result_index_v1 set state='invalidated' where job_id=id and execution_generation=g and state='available';
  end if;
  if keyed or consumed or j.state<>'failed' or j.kind not in ('delegated_scan','github_f_pr','combination_execution') then outcome:='lost_no_retry';
  elsif head_key and clued_private.ci_duty_phase_value_v1(q.policy)>=4 then outcome:='lost_head_burned';
  elsif j.attempt>=2 then outcome:='lost_final';
  else
    inp:=jsonb_strip_nulls(jsonb_build_object('repository_id',j.repository_id,'kind',j.kind,'task_id',j.task_id,'claim_id',j.claim_id,
      'claim_fence',j.claim_fence,'execution_epoch',j.execution_epoch,'copy_index',j.copy_index,'target_branch',j.target_branch,'workflow',j.workflow,
      'head_authorization_id',j.head_authorization_id,'admission_id',j.admission_id,'pr_ref',j.pr_ref,'head_sha',j.head_sha,'base_sha',j.base_sha,
      'test_sha',j.test_sha,'source_sha',j.source_sha,'combination_sha256',j.combination_sha256,'combination_mode',j.combination_mode,'role',j.role,
      'attempt',2,'origin','backoff-retry','parent_job_id',j.parent_job_id,'parent_lease_generation',j.parent_lease_generation,
      'required_environment',j.required_environment))
      ||case when cardinality(j.required_capabilities)>0 then jsonb_build_object('required_capabilities',to_jsonb(j.required_capabilities)) else '{}'::jsonb end;
    begin
      nid:=clued_private.ci_job_enqueue_v1(u,p,inp);
      update clued_private.ci_jobs_v1 set retry_of_job_id=id,excluded_node_ids=array(select distinct x from unnest(j.excluded_node_ids||l.holder_node_id) x),
        required_memory_mb=j.required_memory_mb,priority=j.priority,requested_node_id=j.requested_node_id,stage8_limit=j.stage8_limit,
        eligible_after=greatest(j.eligible_after,clock_timestamp()),version=version+1 where job_id=nid and retry_of_job_id is null;
      outcome:='retried';
    exception when others then
      outcome:='lost_retry_refused';
    end;
  end if;
  r:=clued_private.ci_receipt_v1(u,p,'ci_job_lease_lost',id::text,jsonb_build_object('generation',g,'holder_node_id',l.holder_node_id,
    'outcome',outcome,'retry_job_id',nid,'job_state',j.state,'results_invalidated',produced,'alert',outcome<>'retried'));
  return jsonb_build_object('outcome',outcome,'job_id',id,'retry_job_id',nid,'receipt_id',r);
end $$;

-- One account: its work-claim lock first (every core function's order), then
-- each expired lease in its own subtransaction; results past their time expire.
create function clued_private.ci_job_lease_sweep_account_v1(u uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare l record; out jsonb:='[]'::jsonb; res jsonb; err text; expired_results integer:=0; x record;
begin
  perform clued_private.work_claim_lock(u);
  for l in select user_id,project_id,job_id,generation from clued_private.ci_job_leases_v1
      where user_id=u and state='current' and expires_at<=clock_timestamp() order by project_id,job_id,generation limit 200 loop
    begin
      res:=clued_private.ci_job_lease_expire_v1(l.user_id,l.project_id,l.job_id,l.generation);
    exception when others then
      get stacked diagnostics err=message_text;
      res:=jsonb_build_object('outcome','error','job_id',l.job_id,'error_code',left(err,120));
    end;
    out:=out||jsonb_build_array(res);
  end loop;
  for x in select project_id,count(*) n from clued_private.ci_result_index_v1 where user_id=u and state='available' and expires_at<=clock_timestamp() group by project_id loop
    update clued_private.ci_result_index_v1 set state='expired' where user_id=u and project_id=x.project_id and state='available' and expires_at<=clock_timestamp();
    perform clued_private.ci_receipt_v1(u,x.project_id,'ci_results_expired',x.project_id::text,jsonb_build_object('count',x.n));
    expired_results:=expired_results+x.n;
  end loop;
  return jsonb_build_object('user_id',u,'leases',out,'expired_results',expired_results);
end $$;

create function clued_private.ci_job_lease_sweep_v1() returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; out jsonb:='[]'::jsonb; err text;
begin
  insert into clued_private.ci_lease_sweep_watchdog_v1(singleton,last_tick_at,ticks) values(true,clock_timestamp(),1)
  on conflict (singleton) do update set last_tick_at=excluded.last_tick_at,ticks=clued_private.ci_lease_sweep_watchdog_v1.ticks+1;
  for u in select distinct user_id from clued_private.ci_job_leases_v1 where state='current' and expires_at<=clock_timestamp()
      union select distinct user_id from clued_private.ci_result_index_v1 where state='available' and expires_at<=clock_timestamp() order by 1 loop
    begin
      out:=out||jsonb_build_array(clued_private.ci_job_lease_sweep_account_v1(u));
    exception when others then
      get stacked diagnostics err=message_text;
      out:=out||jsonb_build_array(jsonb_build_object('user_id',u,'outcome','error','error_code',left(err,120)));
    end;
  end loop;
  return jsonb_build_object('status','ok','swept_at',clock_timestamp(),'accounts',out);
end $$;

-- ---------------------------------------------------------------------------
-- G4: the Owner's phase moves 1<->2<->3 (DESIGN 5.4).

-- The Owner's ticks each move needs (items DESIGN 6.1/6.2 do not let the server
-- check), sorted.
create function clued_private.ci_phase_attestations_v1(p_from integer,p_to integer) returns text[]
language sql immutable set search_path='' as $$
  select case when p_from=1 and p_to=2 then array['two_node_assumptions_a1_a5_installed']
    when p_from=2 and p_to=3 then array['stage2_exit_acceptance_passed'] else array[]::text[] end
$$;

-- Machine conditions still unmet for one move; empty when it may run.
create function clued_private.ci_phase_move_unmet_v1(u uuid,p uuid,p_from integer,p_to integer) returns text[]
language plpgsql stable security definer set search_path='' as $$
declare q clued_private.ci_quota_counters_v1; ph integer; out text[]:='{}'; r record; since timestamptz;
begin
  if p_from is null or p_to is null or p_from not between 1 and 3 or p_to not between 1 and 3 or abs(p_to-p_from)<>1 then
    return array['move_not_offered']; end if;
  select * into q from clued_private.ci_quota_counters_v1 where user_id=u and project_id=p and row_kind='pool_policy';
  ph:=case when q.counter_id is null then 1 else clued_private.ci_duty_phase_value_v1(q.policy) end;
  if ph<>p_from then return array['phase_changed']; end if;
  if p_from=1 and p_to=2 then
    if q.counter_id is null or coalesce(q.policy->'limits','null'::jsonb)='null'::jsonb then out:=out||'limits_unconfigured'::text; end if;
    if not exists(select 1 from clued_private.ci_quota_counters_v1 x where x.user_id=u and x.project_id=p and x.row_kind='repo_registration') then
      out:=out||'no_repository'::text; end if;
    if clued_private.ci_duty_ambiguous_v1(u) then out:=out||'several_ci_projects'::text; end if;
    -- DESIGN 6.1: every publisher registered and alive. The one on duty
    -- (ci_duty_holder_v1) has a ready node here, and so does every other active
    -- publisher-approved node of the project.
    if not exists(select 1 from clued_private.ci_duty_holder_v1(u,p) h join clued_private.ci_nodes_v1 n on n.user_id=u and n.project_id=p
        and n.binding_id=h.binding_id and n.publisher_approved and clued_private.ci_node_ready_v1(n)) then
      out:=out||'duty_holder_not_ready'::text; end if;
    for r in select n.node_id from clued_private.ci_nodes_v1 n where n.user_id=u and n.project_id=p and n.state='active' and n.publisher_approved
        and not clued_private.ci_node_ready_v1(n) order by n.created_at,n.node_id loop
      out:=out||('publisher_not_ready:'||r.node_id)::text;
    end loop;
    if not exists(select 1 from clued_private.ci_lease_sweep_watchdog_v1 w where w.last_tick_at>clock_timestamp()-interval '5 minutes') then
      out:=out||'lease_sweep_not_running'::text; end if;
  elsif p_from=2 and p_to=3 then
    select max(x.created_at) into since from public.clued_audit_receipts x where x.user_id=u and x.context_key='project:'||p
      and x.operation='ci_phase_move' and x.metadata->>'to_phase'='2';
    if since is null or since>clock_timestamp()-interval '3 days' then out:=out||'phase2_under_3_days'::text; end if;
    if exists(select 1 from clued_private.ci_publish_keys_v1 k where k.user_id=u and k.project_id=p and k.reserved_at>=coalesce(since,'-infinity')
        and (k.state='unknown' or k.state='reserved' and k.landing_deadline_at<=clock_timestamp())) then
      out:=out||'unknown_publication_in_phase2'::text; end if;
  elsif p_from=2 and p_to=1 then
    -- Owner Decision be3aa3f9 (Q-A2): any job in a running state (an expired,
    -- unswept lease included: the sweep may still retry it), any current lease or
    -- any reserved publication key.
    if exists(select 1 from clued_private.ci_jobs_v1 j where j.user_id=u and j.project_id=p
        and j.state in ('leased','started','result_ready','publication_pending','observed'))
      or exists(select 1 from clued_private.ci_job_leases_v1 l where l.user_id=u and l.project_id=p and l.state='current')
      or exists(select 1 from clued_private.ci_publish_keys_v1 k where k.user_id=u and k.project_id=p and k.state='reserved') then
      out:=out||'pool_not_drained'::text; end if;
  end if;
  return out;
end $$;

create function clued_private.ci_phase_moves_view_v1(u uuid,p uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  with cur as (select coalesce((select clued_private.ci_duty_phase_value_v1(x.policy) from clued_private.ci_quota_counters_v1 x
      where x.user_id=u and x.project_id=p and x.row_kind='pool_policy'),1) ph)
  select jsonb_build_object('phase',cur.ph,'moves',coalesce((select jsonb_agg(jsonb_build_object('target_phase',t,
      'attestations',to_jsonb(clued_private.ci_phase_attestations_v1(cur.ph,t)),
      'unmet',to_jsonb(clued_private.ci_phase_move_unmet_v1(u,p,cur.ph,t))) order by t)
    from unnest(array[cur.ph-1,cur.ph+1]) t where t between 1 and 3 and cur.ph between 1 and 3),'[]'::jsonb))
  from cur
$$;

-- Validate a move request; returns the sorted attestations.
create function clued_private.ci_phase_request_v1(c jsonb) returns text[]
language plpgsql immutable set search_path='' as $$ declare a text[]; begin
  if jsonb_typeof(c->'expected_phase') is distinct from 'number' or c->>'expected_phase' !~ '^[1-5]$'
    or jsonb_typeof(c->'target_phase') is distinct from 'number' or c->>'target_phase' !~ '^[1-5]$'
    or jsonb_typeof(c->'attestations') is distinct from 'array'
    or exists(select 1 from jsonb_array_elements(c->'attestations') x where jsonb_typeof(x)<>'string')
    or jsonb_typeof(c->'accepted_ref') is distinct from 'string' or nullif(btrim(c->>'accepted_ref'),'') is null or length(c->>'accepted_ref')>200 then
    raise exception 'CI_PHASE_REQUEST_INVALID' using errcode='22023'; end if;
  a:=array(select distinct x from jsonb_array_elements_text(c->'attestations') x order by 1);
  if a<>clued_private.ci_phase_attestations_v1((c->>'expected_phase')::integer,(c->>'target_phase')::integer)
    or cardinality(a)<>jsonb_array_length(c->'attestations') then raise exception 'CI_PHASE_ATTESTATION_MISMATCH' using errcode='22023'; end if;
  return a;
end $$;

create function public.clued_ci_phase_confirmation_issue_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$ declare u uuid; p uuid; missing text[]; begin
  perform clued_private.ci_input_v1(p_input,array['project_id','base_version','expected_phase','target_phase','attestations','accepted_ref'],
    array['project_id','base_version','expected_phase','target_phase','attestations','accepted_ref']);
  perform clued_private.ci_public_metadata_v1(p_input);
  p:=(p_input->>'project_id')::uuid; u:=clued_private.ci_native_owner_v1(true,p);
  if jsonb_typeof(p_input->'base_version') is distinct from 'number' or coalesce(p_input->>'base_version','') !~ '^[1-9][0-9]*$' then
    raise exception 'CI_STALE_VERSION' using errcode='22023'; end if;
  perform clued_private.ci_phase_request_v1(p_input);
  if coalesce((clued_private.ci_pool_view_v1(u,p)->>'version')::bigint,0)<>(p_input->>'base_version')::bigint then
    raise exception 'CI_STALE_VERSION' using errcode='40001'; end if;
  missing:=clued_private.ci_phase_move_unmet_v1(u,p,(p_input->>'expected_phase')::integer,(p_input->>'target_phase')::integer);
  if cardinality(missing)>0 then raise exception using message='CI_PHASE_CONDITION_UNMET:'||split_part(missing[1],':',1),errcode='55000'; end if;
  return clued_private.ci_issue_v1(u,p,'ci_phase',p_input-'project_id');
end $$;

-- The token flow of Stage 1's ci_apply_v1, for kind 'ci_phase'.
create function public.clued_ci_phase_apply_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=auth.uid(); p uuid; tok clued_private.native_confirmation_tokens; c jsonb; q clued_private.ci_quota_counters_v1;
  r uuid; v jsonb; sid text; missing text[]; a text[]; ph integer;
begin
  select * into tok from clued_private.native_confirmation_tokens where user_id=u and action='ci_phase'
    and token_hash=encode(extensions.digest(convert_to(p_input->>'confirmation_token','UTF8'),'sha256'),'hex');
  if not found then raise exception 'confirmation_token_invalid' using errcode='42501'; end if;
  c:=tok.native_choices; p:=(c->>'project_id')::uuid;
  u:=clued_private.ci_native_owner_v1(true,p); sid:=clued_private.native_session_id_v1();
  select * into tok from clued_private.native_confirmation_tokens where id=tok.id for update;
  perform clued_private.ci_input_v1(p_input,array['confirmation_token','view_digest'],array['confirmation_token','view_digest']);
  perform clued_private.ci_native_recheck_v1(u,sid);
  if tok.session_id is distinct from sid or tok.view_digest is distinct from p_input->>'view_digest' then
    raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
  if tok.consume_outcome='committed' then
    return jsonb_build_object('status','committed','replayed',true,'receipt_id',tok.consumed_receipt_id)
      ||coalesce((select metadata->'result' from public.clued_audit_receipts where id=tok.consumed_receipt_id),'{}'::jsonb);
  end if;
  begin
    if tok.consumed_at is not null or tok.revoked_at is not null or tok.expires_at<=clock_timestamp()
      or tok.issued_xact=pg_current_xact_id() then raise exception 'confirmation_token_binding_mismatch' using errcode='42501'; end if;
    perform clued_private.work_claim_lock(u);
    q:=clued_private.ci_policy_v1(u,p);
    perform clued_private.ci_native_recheck_v1(u,sid);
    if tok.expires_at<=clock_timestamp() then raise exception 'confirmation_token_expired' using errcode='42501'; end if;
    v:=clued_private.ci_confirmation_view_v1(u,p,'ci_phase',c-'project_id');
    if clued_private.m1_sha256(v)<>tok.view_digest then raise exception 'confirmation_view_stale' using errcode='40001'; end if;
    a:=clued_private.ci_phase_request_v1(c);
    missing:=clued_private.ci_phase_move_unmet_v1(u,p,(c->>'expected_phase')::integer,(c->>'target_phase')::integer);
    if cardinality(missing)>0 then raise exception using message='CI_PHASE_CONDITION_UNMET:'||split_part(missing[1],':',1),errcode='55000'; end if;
    ph:=(c->>'target_phase')::integer;
    update clued_private.ci_quota_counters_v1 set policy=policy||jsonb_build_object('phase',ph,'mode',case when ph>=2 then 'active' else 'prepared' end,
        'status',case when ph>=2 then 'ACTIVE' when coalesce(policy->'limits','null'::jsonb)='null'::jsonb then 'UNCONFIGURED' else 'CONFIGURED_PREPARED' end),
      version=version+1,policy_version=policy_version+1 where counter_id=q.counter_id;
    v:=jsonb_build_object('project_id',p,'from_phase',(c->>'expected_phase')::integer,'to_phase',ph,'pool',clued_private.ci_pool_view_v1(u,p));
    r:=clued_private.ci_receipt_v1(u,p,'ci_phase_move',p::text,jsonb_build_object('result',v,'from_phase',(c->>'expected_phase')::integer,
      'to_phase',ph,'attestations',to_jsonb(a),'accepted_ref',c->>'accepted_ref','view_digest',tok.view_digest));
    update clued_private.ci_quota_counters_v1 set receipt_id=r where counter_id=q.counter_id;
    update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=r,consume_outcome='committed' where id=tok.id;
    return jsonb_build_object('status','committed','replayed',false,'receipt_id',r)||v;
  exception when others then
    r:=clued_private.ci_receipt_v1(u,p,'ci_phase_rejected',p::text,jsonb_build_object('error_code',sqlerrm));
    update clued_private.native_confirmation_tokens set consumed_at=clock_timestamp(),consumed_receipt_id=r,consume_outcome='rejected'
      where id=tok.id and consumed_at is null and revoked_at is null;
    return jsonb_build_object('status','rejected','error_code',sqlerrm,'receipt_id',r,'authoritative',false);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2B gateway: the jobless operation job_lease_next.
select clued_private.ci_t2a2_patch_v1('public.clued_ci_node_command_v1(text,jsonb,jsonb,jsonb)',
$a$    if op in ('qualification_report','train_sweep_confirm','green_mirror_append') then$a$,
$r$    if op in ('qualification_report','train_sweep_confirm','green_mirror_append','job_lease_next') then$r$);
select clued_private.ci_t2a2_patch_v1('public.clued_ci_node_command_v1(text,jsonb,jsonb,jsonb)',
$a$    elsif op='nonce_issue' then$a$,
$r$    elsif op='job_lease_next' then
      perform clued_private.ci_input_v1(p_payload,array[]::text[]);
      res:=clued_private.ci_job_lease_next_v1(n.user_id,n.project_id,n.node_id);
    elsif op='nonce_issue' then$r$);

drop function clued_private.ci_t2a2_patch_v1(text,text,text);

-- Two items of the 3->4 move ship here (G1 never leases maintenance; G9).
create or replace function clued_private.ci_phase_external_prerequisites_v1(u uuid,p uuid) returns text[]
language sql stable security definer set search_path='' as $$
  select array['green_mirror_writers_3d','resident_phase_routing_4e','reconciliation_days_q2',
    'dedicated_maintenance_claim_t4','admission_meter_dedup_phase4',
    'sweep_watermark_single_source','hosted_admission_publication_route']::text[]
$$;

-- ---------------------------------------------------------------------------
-- Schedule (where pg_cron is installed) and ACL.
do $schedule$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('clued-ci-lease-sweep','* * * * *','select clued_private.ci_job_lease_sweep_v1()');
  else
    raise warning 'ci_lease_sweep_scheduler_absent: pg_cron is not installed; expired CI leases are not swept';
  end if;
end $schedule$;

do $function_acl$ declare s regprocedure; begin
  for s in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='clued_private' and p.proname=any(array['ci_capabilities_valid_v1','ci_admission_issue_fact_v1','ci_admission_issue_valid_v1',
      'ci_node_live_v1','ci_clock_minutes_v1','ci_node_available_v1','ci_profile_v1','ci_job_needs_v1','ci_node_exclusions_v1','ci_job_fit_v1',
      'ci_node_ready_v1','ci_job_exclusion_waived_v1','ci_job_lease_fit_v1','ci_job_public_v1','ci_job_lease_next_v1','ci_job_lease_expire_v1',
      'ci_node_revoked_at_v1','ci_job_stale_v1','ci_job_candidates_v1',
      'ci_job_lease_sweep_account_v1','ci_job_lease_sweep_v1','ci_phase_attestations_v1','ci_phase_move_unmet_v1','ci_phase_moves_view_v1',
      'ci_phase_request_v1','ci_phase_external_prerequisites_v1']))
    or (n.nspname='public' and p.proname=any(array['clued_ci_phase_confirmation_issue_v1','clued_ci_phase_apply_v1'])) loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role,clued_worker_gateway',s);
  end loop;
end $function_acl$;
grant execute on function public.clued_ci_phase_confirmation_issue_v1(jsonb),public.clued_ci_phase_apply_v1(jsonb) to authenticated;
notify pgrst,'reload schema';
