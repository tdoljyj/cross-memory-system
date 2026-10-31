-- Merge train, step 2a, server side (work/independent-ci-resident-v1/DESIGN.md
-- §41.4, §41.5; Task a3701d3d; Decisions 263f9701, 3dcb583b and the Owner's
-- 2026-10-31 rulings on ordering, the train front, keepalive and
-- resident-node purpose).
--
-- 1. Ordering switch. One per account, fifo (default, no row) or priority.
--    Only the Owner, signed in to Clued directly with a session, reads or
--    changes it (authorization_owner_v12, base_version, one receipt per real
--    change), as the Agent messages switch of 20261008190000.
-- 2. Rank, priority mode only: mtpe_intake_projection.algorithm_priority of
--    the claim's Task, as stored. It is stored with each join (when the claim
--    joins, or for entries already queued when the switch is first turned)
--    and refreshed for every waiting entry by each write to the queue, after
--    the head is recorded; readers order by the stored values, so the order
--    moves only on writes and the front never moves. A Task without
--    a projection row has no rank and waits behind ranked ones in join order;
--    ties go by join time, then claim id. Nothing here writes MTPE or record
--    priority.
-- 3. The train front. An account that never turned the switch keeps exactly
--    today's queue (work_claim_merge_queue_v1, untouched, with its marker).
--    The first change of the switch records, under work_claim_lock, the head
--    that today's rules show at that moment and every entry already out or
--    lapsed; from then on the account's queue is work_claim_merge_queue_v2:
--    the recorded front stays head until it leaves (release, return, adopt,
--    expiry, slot lapse), whatever joins or changes priority; the next head
--    is chosen by the ordering in force when the front leaves and is recorded
--    in the same write. Changing the switch or a priority never changes the
--    current front. Every writer of a queue (claim, renew, release, expiry,
--    touch, adopt, return, keepalive, the switch) records first; readers
--    (holders, claim views) only compute, from stored state, so they cannot
--    disagree with the next write.
--    Merge measurement (20261011033947): today's queue and the stamp trigger
--    are untouched, so the measured source digest is unchanged. When an
--    account changes its ordering, a policy event (object_key merge-train-v1,
--    with the profile and the ordering) is appended to its journal; from its
--    first change on, the FIFO marker rows of today's queue are no longer
--    written for it (a guard trigger on work_claim_merge_queue_v1), so its
--    journal no longer describes a FIFO queue. Creating the new triggers on
--    work_claims_v1 and work_claim_merge_queue_v1 fires the R9 clock-source
--    DDL observer (clock_source_ddl_candidate_v1, 20261011113259): every open
--    clock-source epoch is marked ddl_tainted, and its seals are no longer
--    candidate_ready.
-- 4. Queued-claim keepalive: a new action merge_queue_keepalive on the
--    existing CI command door (clued_work_verify_v1 -> work_claim_ci_command_v1).
--    No new anon or Worker RPC: the CI8 surface is unchanged.
-- 5. Merge-slot calls (touch, adopt, return, keepalive) admit a ci-admission
--    Binding only when its started row's purpose is resident-node (or
--    unspecified, rows from before purposes, which the role pages already
--    treat as a resident node). An account without any ci-admission row keeps
--    the earlier open behaviour, as binding_role_admits_v1 does. (The check
--    reads the rows through binding_role_holders_v1: a new direct reader of
--    binding_roles_v1 would need its own review, ci-admission-handover-db.)
-- 6. Every function redefined whole here is first checked against the md5
--    of its expected predecessor body, so a hotfix in between is not reverted.

do $predecessors$
declare expected record;
begin
  for expected in select * from (values
    ('clued_private.work_claim_merge_queue_view_v1(clued_private.work_claims_v1)', '6ca5c37873fae0ea8b3ddec54b457b0f'),
    ('clued_private.work_claim_merge_slot_until_v1(clued_private.work_claims_v1)', '20c429a83ee955c8a13cd2e256f633c4'),
    ('clued_private.work_claim_merge_slot_ci_view_v1(clued_private.work_claims_v1)', '672283881665aecbef5256196c6208f1'),
    ('public.clued_work_merge_slot_touch_v1(text,jsonb)', '38765d2103c465d21fec7a4c2ab4441a'),
    ('public.clued_work_claim_adopt_v1(text,jsonb)', '0071604b35ea563e910555fb27ca122a'),
    ('public.clued_work_merge_slot_return_v1(text,jsonb)', '0e143b5e16f58d792c1a39d66c95d22d'),
    ('clued_private.work_claim_ci_command_v1(text,jsonb)', '881989aa489ca5c0f63207327862283d')
  ) inputs(signature, body_md5)
  loop
    if not exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(expected.signature)
        and pg_catalog.md5(p.prosrc)=expected.body_md5) then
      raise exception 'merge_train_queue_predecessor_mismatch: %', expected.signature;
    end if;
  end loop;
end $predecessors$;

-- ---------------------------------------------------------------------------
-- Tables.

create table clued_private.merge_queue_settings_v1 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ordering text not null check (ordering in ('fifo','priority')),
  version bigint not null check (version>=1),
  updated_at timestamptz not null,
  receipt_id uuid not null
);

-- The recorded front of one queue, and the latest time an entry left it
-- (the next head's slot starts no earlier).
create table clued_private.work_claim_merge_front_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  merge_ref text not null,
  claim_id uuid,
  queued_at timestamptz,
  since timestamptz,
  left_at timestamptz,
  recorded_at timestamptz not null,
  primary key (user_id,merge_ref),
  check ((claim_id is null)=(queued_at is null) and (claim_id is null)=(since is null))
);

-- Entries that have left a queue (as head, lapsed, or out when the front was
-- first recorded), per join: a claim that joins again has a new queued_at.
create table clued_private.work_claim_merge_departed_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  merge_ref text not null,
  claim_id uuid not null,
  queued_at timestamptz not null,
  left_at timestamptz not null,
  primary key (user_id,merge_ref,claim_id,queued_at)
);

-- The rank of one join, read when the claim joined (or when the switch was
-- first turned), so the order does not move between writes.
create table clued_private.work_claim_merge_rank_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  claim_id uuid not null,
  queued_at timestamptz not null,
  rank integer,
  primary key (claim_id,queued_at)
);

alter table clued_private.merge_queue_settings_v1 enable row level security;
alter table clued_private.work_claim_merge_rank_v1 enable row level security;
alter table clued_private.work_claim_merge_front_v1 enable row level security;
alter table clued_private.work_claim_merge_departed_v1 enable row level security;
revoke all on table clued_private.merge_queue_settings_v1,
  clued_private.work_claim_merge_front_v1,clued_private.work_claim_merge_departed_v1,
  clued_private.work_claim_merge_rank_v1
  from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- Ordering and rank.

-- No row means fifo, with today's queue.
create function clued_private.merge_queue_ordering_v1(p_user_id uuid) returns text
language sql stable security definer set search_path='' as $$
  select coalesce((select s.ordering from clued_private.merge_queue_settings_v1 s where s.user_id=p_user_id),'fifo')
$$;

-- True once the account has turned the switch: its queues use the recorded front.
create function clued_private.merge_queue_recorded_v1(p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from clued_private.merge_queue_settings_v1 s where s.user_id=p_user_id)
$$;

-- A Task's automatic priority as stored, or null without a projection row.
create function clued_private.merge_queue_rank_v1(p_user_id uuid,p_task_id uuid) returns integer
language sql stable security definer set search_path='' as $$
  select p.algorithm_priority from clued_private.mtpe_intake_projection p
    where p.user_id=p_user_id and p.record_id=p_task_id
$$;

-- ---------------------------------------------------------------------------
-- The queue with a recorded front. Same answer shape as
-- work_claim_merge_queue_v1: {ref, head, length, entries}. Entries that left
-- are out; the recorded front, while it is still in the queue, is tried
-- first with the start it was recorded with; otherwise entries are tried in
-- the account's order, each starting no earlier than the latest leaving. An
-- entry whose slot has already lapsed is lapsed and moves that time on.
create function clued_private.work_claim_merge_queue_v2(p_user_id uuid,p_ref text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_ref text:=lower(p_ref); v_now timestamptz:=pg_catalog.clock_timestamp();
  f clued_private.work_claim_merge_front_v1%rowtype; c clued_private.work_claims_v1%rowtype;
  v_priority boolean:=clued_private.merge_queue_ordering_v1(p_user_id)='priority';
  v_order uuid[]; v_pick uuid; v_front boolean; v_from_front boolean;
  v_cursor timestamptz; v_start timestamptz; v_until timestamptz; v_head jsonb; v_position integer:=0;
  v_entries jsonb; v_tail jsonb:='[]'::jsonb;
begin
  select * into f from clued_private.work_claim_merge_front_v1 x where x.user_id=p_user_id and x.merge_ref=v_ref;
  v_cursor:=f.left_at;
  select coalesce(jsonb_agg(jsonb_build_object('claim_id',w.claim_id,'state','out',
      'queued_at',w.merge_queued_at,'bound_pr',w.bound_pr) order by w.merge_queued_at,w.claim_id),'[]'::jsonb)
    into v_entries
    from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING') and w.merge_queued_at is not null
      and exists(select 1 from unnest(w.trigger_refs) t where lower(t)=v_ref)
      and exists(select 1 from clued_private.work_claim_merge_departed_v1 d where d.user_id=p_user_id
        and d.merge_ref=v_ref and d.claim_id=w.claim_id and d.queued_at=w.merge_queued_at);
  select coalesce(array_agg(w.claim_id order by
      case when v_priority then (select r.rank from clued_private.work_claim_merge_rank_v1 r
        where r.claim_id=w.claim_id and r.queued_at=w.merge_queued_at) end desc nulls last,
      w.merge_queued_at,w.claim_id),'{}'::uuid[]) into v_order
    from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING') and w.merge_queued_at is not null
      and exists(select 1 from unnest(w.trigger_refs) t where lower(t)=v_ref)
      and not exists(select 1 from clued_private.work_claim_merge_departed_v1 d where d.user_id=p_user_id
        and d.merge_ref=v_ref and d.claim_id=w.claim_id and d.queued_at=w.merge_queued_at);
  v_front:=f.claim_id is not null and f.claim_id=any(v_order)
    and exists(select 1 from clued_private.work_claims_v1 w where w.claim_id=f.claim_id and w.merge_queued_at=f.queued_at);
  while v_head is null and cardinality(v_order)>0 loop
    v_from_front:=v_front;
    v_pick:=case when v_front then f.claim_id else v_order[1] end;
    v_front:=false;
    v_order:=array_remove(v_order,v_pick);
    select * into c from clued_private.work_claims_v1 w where w.claim_id=v_pick;
    v_start:=case when v_from_front then f.since else greatest(c.merge_queued_at,v_cursor) end;
    v_until:=clued_private.work_claim_merge_slot_until_from_v1(c,v_start);
    if v_until>v_now then
      v_position:=1;
      v_head:=jsonb_build_object('claim_id',c.claim_id,'since',v_start,'until',v_until,
        'bound_pr',c.bound_pr,'holder_label',c.holder_label);
      v_tail:=v_tail||jsonb_build_array(v_head||jsonb_build_object('state','head','position',1,
        'queued_at',c.merge_queued_at));
    else
      v_cursor:=greatest(v_cursor,v_until,v_start);
      v_tail:=v_tail||jsonb_build_array(jsonb_build_object('claim_id',c.claim_id,'state','lapsed',
        'queued_at',c.merge_queued_at,'since',v_start,'until',v_until,'bound_pr',c.bound_pr));
    end if;
  end loop;
  foreach v_pick in array v_order loop
    select * into c from clued_private.work_claims_v1 w where w.claim_id=v_pick;
    v_position:=v_position+1;
    v_tail:=v_tail||jsonb_build_array(jsonb_build_object('claim_id',c.claim_id,'state','waiting',
      'position',v_position,'queued_at',c.merge_queued_at,'bound_pr',c.bound_pr,'holder_label',c.holder_label));
  end loop;
  return jsonb_build_object('ref',v_ref,'head',v_head,'length',v_position,'entries',v_entries||v_tail);
end $$;

-- The queue in force for the account.
create function clued_private.work_claim_merge_queue_current_v1(p_user_id uuid,p_ref text) returns jsonb
language sql stable security definer set search_path='' as $$
  select case when clued_private.merge_queue_recorded_v1(p_user_id)
    then clued_private.work_claim_merge_queue_v2(p_user_id,p_ref)
    else clued_private.work_claim_merge_queue_v1(p_user_id,p_ref) end
$$;

-- The account's merge refs that have live entries (optionally one repository's).
create function clued_private.work_claim_merge_queue_refs_v1(p_user_id uuid,p_prefix text) returns text[]
language sql stable security definer set search_path='' as $$
  select coalesce(array_agg(distinct lower(t) order by lower(t)),'{}'::text[])
  from clued_private.work_claims_v1 w cross join lateral unnest(clued_private.work_claim_merge_refs_v1(w.trigger_refs)) t
  where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING') and w.merge_queued_at is not null
    and (p_prefix is null or left(lower(t),length(p_prefix))=p_prefix)
$$;

-- ---------------------------------------------------------------------------
-- Recording. The caller holds work_claim_lock. Nothing for an account that
-- has never turned the switch.

-- Records what the queue shows now: lapsed entries leave (and move the
-- leaving time on), and the head becomes the recorded front.
create function clued_private.work_claim_merge_front_sync_v1(p_user_id uuid,p_ref text) returns void
language plpgsql volatile security definer set search_path='' as $$
declare v_ref text:=lower(p_ref); v_queue jsonb; e jsonb; v_left timestamptz; v_head jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if not clued_private.merge_queue_recorded_v1(p_user_id) then return; end if;
  v_queue:=clued_private.work_claim_merge_queue_v2(p_user_id,v_ref);
  insert into clued_private.work_claim_merge_front_v1(user_id,merge_ref,recorded_at)
    values(p_user_id,v_ref,v_now) on conflict (user_id,merge_ref) do nothing;
  for e in select x from jsonb_array_elements(v_queue->'entries') x loop
    if e->>'state'='lapsed' then
      insert into clued_private.work_claim_merge_departed_v1(user_id,merge_ref,claim_id,queued_at,left_at)
        values(p_user_id,v_ref,(e->>'claim_id')::uuid,(e->>'queued_at')::timestamptz,
          greatest((e->>'until')::timestamptz,(e->>'since')::timestamptz))
        on conflict do nothing;
      v_left:=greatest(v_left,(e->>'until')::timestamptz,(e->>'since')::timestamptz);
    elsif e->>'state'='head' then
      v_head:=e;
    end if;
  end loop;
  update clued_private.work_claim_merge_front_v1 f set
      claim_id=(v_head->>'claim_id')::uuid,queued_at=(v_head->>'queued_at')::timestamptz,
      since=(v_head->>'since')::timestamptz,left_at=greatest(f.left_at,v_left),
      recorded_at=case when f.claim_id is not distinct from (v_head->>'claim_id')::uuid
        and f.queued_at is not distinct from (v_head->>'queued_at')::timestamptz then f.recorded_at else v_now end
    where f.user_id=p_user_id and f.merge_ref=v_ref;
  -- With the head recorded, every waiting entry takes the priority its Task
  -- has now (a Task that rose, or one that only now has a projection row).
  -- Readers order by these stored values, so the order moves only on writes;
  -- the front never moves.
  insert into clued_private.work_claim_merge_rank_v1(user_id,claim_id,queued_at,rank)
    select p_user_id,w.claim_id,w.merge_queued_at,clued_private.merge_queue_rank_v1(p_user_id,w.task_id)
    from jsonb_array_elements(v_queue->'entries') x
    join clued_private.work_claims_v1 w on w.claim_id=(x->>'claim_id')::uuid
    where x->>'state'='waiting'
    on conflict (claim_id,queued_at) do update set rank=excluded.rank
      where clued_private.work_claim_merge_rank_v1.rank is distinct from excluded.rank;
  -- Departures of joins that no longer exist are not needed any more.
  delete from clued_private.work_claim_merge_departed_v1 d
    where d.user_id=p_user_id and d.merge_ref=v_ref and not exists(select 1 from clued_private.work_claims_v1 w
      where w.claim_id=d.claim_id and w.merge_queued_at=d.queued_at and w.status in ('ACTIVE','DRAINING'));
  delete from clued_private.work_claim_merge_rank_v1 r
    where r.user_id=p_user_id and not exists(select 1 from clued_private.work_claims_v1 w
      where w.claim_id=r.claim_id and w.merge_queued_at=r.queued_at and w.status in ('ACTIVE','DRAINING'));
end $$;

-- Every queue of the account, or of one repository (p_prefix 'merge:<owner>/<name>:').
create function clued_private.work_claim_merge_front_sync_all_v1(p_user_id uuid,p_prefix text) returns void
language plpgsql volatile security definer set search_path='' as $$
declare v_ref text;
begin
  if not clued_private.merge_queue_recorded_v1(p_user_id) then return; end if;
  foreach v_ref in array clued_private.work_claim_merge_queue_refs_v1(p_user_id,p_prefix) loop
    perform clued_private.work_claim_merge_front_sync_v1(p_user_id,v_ref);
  end loop;
end $$;

-- The first change of the switch: record today's queues as they are. The
-- head keeps its start; entries that are out or lapsed have left; the next
-- head starts no earlier than today's queue would start it.
create function clued_private.work_claim_merge_front_start_v1(p_user_id uuid) returns void
language plpgsql volatile security definer set search_path='' as $$
declare v_ref text; v_queue jsonb; e jsonb; v_head jsonb; v_left timestamptz;
  q clued_private.work_claim_merge_queue_v1%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  -- Every entry already queued keeps the rank its Task has now.
  insert into clued_private.work_claim_merge_rank_v1(user_id,claim_id,queued_at,rank)
    select w.user_id,w.claim_id,w.merge_queued_at,clued_private.merge_queue_rank_v1(w.user_id,w.task_id)
    from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING') and w.merge_queued_at is not null
    on conflict do nothing;
  foreach v_ref in array clued_private.work_claim_merge_queue_refs_v1(p_user_id,null) loop
    v_queue:=clued_private.work_claim_merge_queue_v1(p_user_id,v_ref);
    select * into q from clued_private.work_claim_merge_queue_v1 x where x.user_id=p_user_id and x.merge_ref=v_ref;
    v_left:=q.head_left_at; v_head:=null;
    for e in select x from jsonb_array_elements(v_queue->'entries') x loop
      if e->>'state' in ('out','lapsed') then
        insert into clued_private.work_claim_merge_departed_v1(user_id,merge_ref,claim_id,queued_at,left_at)
          values(p_user_id,v_ref,(e->>'claim_id')::uuid,(e->>'queued_at')::timestamptz,
            case when e->>'state'='lapsed' then greatest((e->>'until')::timestamptz,(e->>'since')::timestamptz)
              else coalesce(q.head_left_at,v_now) end)
          on conflict do nothing;
        if e->>'state'='lapsed' then
          v_left:=greatest(v_left,(e->>'until')::timestamptz,(e->>'since')::timestamptz); end if;
      elsif e->>'state'='head' then
        v_head:=e;
      end if;
    end loop;
    insert into clued_private.work_claim_merge_front_v1(user_id,merge_ref,claim_id,queued_at,since,left_at,recorded_at)
      values(p_user_id,v_ref,(v_head->>'claim_id')::uuid,(v_head->>'queued_at')::timestamptz,
        (v_head->>'since')::timestamptz,v_left,v_now)
      on conflict (user_id,merge_ref) do update set claim_id=excluded.claim_id,queued_at=excluded.queued_at,
        since=excluded.since,left_at=greatest(clued_private.work_claim_merge_front_v1.left_at,excluded.left_at),
        recorded_at=excluded.recorded_at;
  end loop;
end $$;

-- Before a claim's queue entries change (after work_claims_v1_merge_slot_stamp,
-- which sets merge_queued_at by today's queue): the queues it is in or joins
-- are recorded first, so a join or a priority never displaces the front.
-- Whether a renewal keeps its place or joins again at the back follows this
-- queue, as the stamp does for today's: a renewal of the front or of a
-- waiting entry keeps its place, a renewal of an entry that has left (lapsed
-- or out) joins again, and any change of merge refs joins again. A front
-- that leaves (claim no longer live, ref dropped, joining again) is recorded
-- as gone with the time it left.
create function clued_private.work_claim_merge_front_before_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_ref text; e jsonb; v_old text[]:='{}'::text[]; v_new text[]:='{}'::text[]; v_left timestamptz;
  v_states jsonb:='{}'::jsonb; v_rejoin boolean; v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if not clued_private.merge_queue_recorded_v1(new.user_id) then return new; end if;
  if new.status in ('ACTIVE','DRAINING') then
    v_new:=array(select distinct lower(t) from unnest(clued_private.work_claim_merge_refs_v1(new.trigger_refs)) t order by 1);
  end if;
  if tg_op='UPDATE' and old.status in ('ACTIVE','DRAINING') and old.merge_queued_at is not null then
    v_old:=array(select distinct lower(t) from unnest(clued_private.work_claim_merge_refs_v1(old.trigger_refs)) t order by 1);
  end if;
  foreach v_ref in array v_old||v_new loop
    perform clued_private.work_claim_merge_front_sync_v1(new.user_id,v_ref);
  end loop;
  foreach v_ref in array v_old loop
    e:=null;
    select x into e from jsonb_array_elements(clued_private.work_claim_merge_queue_v2(old.user_id,v_ref)->'entries') x
      where x->>'claim_id'=old.claim_id::text;
    if e is not null then v_states:=v_states||jsonb_build_object(v_ref,e); end if;
  end loop;
  if cardinality(v_old)>0 and cardinality(v_new)>0 then
    v_rejoin:=v_new is distinct from v_old or (new.renewals is distinct from old.renewals
      and exists(select 1 from jsonb_each(v_states) j where j.value->>'state' in ('lapsed','out')));
    if v_rejoin and new.merge_queued_at is not distinct from old.merge_queued_at then
      new.merge_slot_at:=v_now; new.merge_queued_at:=v_now; new.merge_slot_taken_at:=v_now;
      new.merge_slot_ci_state:=null; new.merge_slot_ci_head:=null; new.merge_slot_ci_at:=null;
      new.merge_slot_hard_cap_seconds:=null;
    elsif not v_rejoin and new.merge_queued_at is distinct from old.merge_queued_at then
      new.merge_queued_at:=old.merge_queued_at; new.merge_slot_taken_at:=old.merge_slot_taken_at;
      new.merge_slot_ci_state:=old.merge_slot_ci_state; new.merge_slot_ci_head:=old.merge_slot_ci_head;
      new.merge_slot_ci_at:=old.merge_slot_ci_at; new.merge_slot_hard_cap_seconds:=old.merge_slot_hard_cap_seconds;
    end if;
  end if;
  -- A join (new or again) keeps the rank its Task has now.
  if cardinality(v_new)>0 and new.merge_queued_at is not null
      and (tg_op='INSERT' or new.merge_queued_at is distinct from old.merge_queued_at) then
    insert into clued_private.work_claim_merge_rank_v1(user_id,claim_id,queued_at,rank)
      values(new.user_id,new.claim_id,new.merge_queued_at,clued_private.merge_queue_rank_v1(new.user_id,new.task_id))
      on conflict (claim_id,queued_at) do update set rank=excluded.rank;
  end if;
  for v_ref,e in select j.key,j.value from jsonb_each(v_states) j loop
    continue when e->>'state'<>'head';
    continue when v_ref=any(v_new) and new.merge_queued_at is not distinct from old.merge_queued_at;
    v_left:=least(v_now,(e->>'until')::timestamptz);
    insert into clued_private.work_claim_merge_departed_v1(user_id,merge_ref,claim_id,queued_at,left_at)
      values(old.user_id,v_ref,old.claim_id,old.merge_queued_at,v_left) on conflict do nothing;
    update clued_private.work_claim_merge_front_v1 set claim_id=null,queued_at=null,since=null,
        left_at=greatest(left_at,v_left),recorded_at=v_now
      where user_id=old.user_id and merge_ref=v_ref and claim_id=old.claim_id;
  end loop;
  return new;
end $$;

-- After the change: the next head, if any, is chosen and recorded in the same write.
create function clued_private.work_claim_merge_front_after_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_ref text;
begin
  if not clued_private.merge_queue_recorded_v1(new.user_id) then return null; end if;
  foreach v_ref in array array(select distinct lower(t) from unnest(
      clued_private.work_claim_merge_refs_v1(new.trigger_refs)||case when tg_op='UPDATE'
        then clued_private.work_claim_merge_refs_v1(old.trigger_refs) else '{}'::text[] end) t) loop
    perform clued_private.work_claim_merge_front_sync_v1(new.user_id,v_ref);
  end loop;
  return null;
end $$;

-- Named to run after work_claims_v1_merge_slot_stamp, which sets merge_queued_at.
create trigger work_claims_v1_merge_train_front_before
  before insert or update of trigger_refs,renewals,merge_slot_at,status on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_merge_front_before_v1();
create trigger work_claims_v1_merge_train_front_after
  after insert or update of trigger_refs,renewals,merge_slot_at,status on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_merge_front_after_v1();

-- Once an account records its front, today's FIFO marker rows are no longer
-- written for it: they describe a queue the account no longer has.
create function clued_private.work_claim_merge_marker_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if clued_private.merge_queue_recorded_v1(new.user_id) then return null; end if;
  return new;
end $$;
create trigger work_claim_merge_queue_v1_recorded_guard
  before insert or update on clued_private.work_claim_merge_queue_v1
  for each row execute function clued_private.work_claim_merge_marker_guard_v1();

-- ---------------------------------------------------------------------------
-- Readers of the queue: 20261009080000, reading the queue in force.

create or replace function clued_private.work_claim_merge_queue_view_v1(c clued_private.work_claims_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select case when c.merge_queued_at is null or c.status not in ('ACTIVE','DRAINING')
      or cardinality(clued_private.work_claim_merge_refs_v1(c.trigger_refs))=0 then null
    else (select jsonb_agg(jsonb_build_object('ref',x.v->>'ref','length',(x.v->>'length')::integer,'head',x.v->'head')
        ||coalesce((select jsonb_build_object('state',e->>'state','position',(e->>'position')::integer,
              'ahead',(select coalesce(jsonb_agg(jsonb_build_object('claim_id',a->>'claim_id','bound_pr',a->'bound_pr',
                  'holder_label',a->'holder_label','state',a->>'state') order by (a->>'position')::integer),'[]'::jsonb)
                from jsonb_array_elements(x.v->'entries') a
                where a->>'state' in ('head','waiting') and (a->>'position')::integer<(e->>'position')::integer))
            from jsonb_array_elements(x.v->'entries') e where e->>'claim_id'=c.claim_id::text),
          jsonb_build_object('state','none')) order by x.v->>'ref')
      from (select clued_private.work_claim_merge_queue_current_v1(c.user_id,r.ref) v
              from (select distinct lower(t) from unnest(clued_private.work_claim_merge_refs_v1(c.trigger_refs)) t) r(ref)) x)
  end
$$;

create or replace function clued_private.work_claim_merge_slot_until_v1(c clued_private.work_claims_v1) returns timestamptz
language sql stable security definer set search_path='' as $$
  select case when c.merge_queued_at is not null and c.status in ('ACTIVE','DRAINING')
      and cardinality(clued_private.work_claim_merge_refs_v1(c.trigger_refs))>0
    then (select min((x.v->'head'->>'until')::timestamptz)
      from (select clued_private.work_claim_merge_queue_current_v1(c.user_id,r.ref) v
              from (select distinct lower(t) from unnest(clued_private.work_claim_merge_refs_v1(c.trigger_refs)) t) r(ref)) x
      where x.v->'head'->>'claim_id'=c.claim_id::text) end
$$;

create or replace function clued_private.work_claim_merge_slot_ci_view_v1(c clued_private.work_claims_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select (select jsonb_build_object('taken_at',(x.v->'head'->>'since')::timestamptz,
      'hard_cap_until',(x.v->'head'->>'since')::timestamptz+make_interval(secs=>c.merge_slot_hard_cap_seconds),
      'ci_state',c.merge_slot_ci_state,'ci_head_sha',c.merge_slot_ci_head,'ci_at',c.merge_slot_ci_at)
    from (select clued_private.work_claim_merge_queue_current_v1(c.user_id,r.ref) v
            from (select distinct lower(t) from unnest(clued_private.work_claim_merge_refs_v1(c.trigger_refs)) t) r(ref)) x
    where x.v->'head'->>'claim_id'=c.claim_id::text
      and (x.v->'head'->>'until')::timestamptz>pg_catalog.clock_timestamp()
    limit 1)
  where c.merge_queued_at is not null and c.status in ('ACTIVE','DRAINING')
$$;

-- ---------------------------------------------------------------------------
-- Merge-slot calls: resident-node Bindings only.

-- binding_role_admits_v1 (the Binding's ci-admission row has started, or the
-- account has no such row), and a started row of this Binding is for a
-- resident node: not "other" (for example the GitHub environment connection).
create function clued_private.merge_slot_admits_v1(p_binding public.clued_agent_bindings) returns boolean
language sql stable security definer set search_path='' as $$
  select clued_private.binding_role_admits_v1(p_binding,'ci-admission')
    and not exists(select 1 from jsonb_array_elements(
        clued_private.binding_role_holders_v1(p_binding.user_id,'ci-admission','{}'::uuid[])) h
      where h->>'binding_id'=p_binding.id::text
        and (h->>'effective_at')::timestamptz<=pg_catalog.clock_timestamp()
        and h->>'purpose' not in ('resident-node','unspecified'))
$$;

-- clued_work_merge_slot_touch_v1: 20261010112852, resident-node only, and the
-- queues of the repository are recorded before the report.
create or replace function public.clued_work_merge_slot_touch_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_head text:=lower(nullif(btrim(coalesce(p_input->>'head_sha','')),'')); v_state text:=p_input->>'ci_state';
  v_cap integer; v_now timestamptz:=pg_catalog.clock_timestamp(); v_touched uuid[]:='{}'::uuid[];
  v_returned uuid[]; v_notified uuid[]:='{}'::uuid[]; v_reason text; v_until timestamptz; v_prefix text;
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k
        where k not in ('scope','pr_ref','head_sha','ci_state','hard_cap_minutes','reason')) then
    raise exception 'work_claim_merge_slot_touch_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if not clued_private.merge_slot_admits_v1(v_binding) then
    return jsonb_build_object('status','ok','touched',false,'reason','admission_binding_required');
  end if;
  if v_pr is null or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if v_head is null or v_head !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  if v_state is null or v_state not in ('running','green','failed') then
    raise exception 'work_claim_merge_slot_ci_state_invalid' using errcode='22023'; end if;
  if v_state<>'failed' or p_input ? 'hard_cap_minutes' then
    if jsonb_typeof(p_input->'hard_cap_minutes') is distinct from 'number'
        or (p_input->>'hard_cap_minutes') !~ '^[0-9]{2,3}$'
        or (p_input->>'hard_cap_minutes')::integer not between 60 and 180 then
      raise exception 'work_claim_merge_slot_hard_cap_invalid' using errcode='22023'; end if;
    v_cap:=(p_input->>'hard_cap_minutes')::integer*60;
  end if;
  if p_input ? 'reason' then
    if jsonb_typeof(p_input->'reason') is distinct from 'string'
        or char_length(p_input->>'reason') not between 1 and 300
        or (p_input->>'reason') ~ '[[:cntrl:]]' then
      raise exception 'work_claim_merge_slot_reason_invalid' using errcode='22023'; end if;
    v_reason:=p_input->>'reason';
  end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  -- Only the slots of the pull request's own repository: merge:<owner>/<name>:<branch>.
  v_prefix:='merge:'||lower(split_part(v_pr,'#',1))||':';
  perform clued_private.work_claim_merge_front_sync_all_v1(v_binding.user_id,v_prefix);
  if v_state='failed' then
    v_returned:=clued_private.work_claim_merge_slot_return_core_v1(v_binding.user_id,v_binding.id,v_scope,v_pr,
      'ci_failed',jsonb_build_object('head_sha',v_head));
    for c in select * from clued_private.work_claims_v1 w where w.claim_id=any(v_returned) loop
      if clued_private.work_claim_ci_notice_v1(v_binding,c,v_pr,v_head,v_reason) then
        v_notified:=v_notified||c.claim_id;
      end if;
    end loop;
    return jsonb_build_object('status','ok','ci_state',v_state,'pr_ref',v_pr,'head_sha',v_head,
      'notified',to_jsonb(v_notified),'returned',cardinality(v_returned)>0,'merge_slot_returned',to_jsonb(v_returned));
  end if;
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.context_key=v_scope and w.bound_pr=v_pr
      and w.status in ('ACTIVE','DRAINING')
      and exists(select 1 from unnest(w.trigger_refs) t where left(lower(t),length(v_prefix))=v_prefix)
    order by w.issued_at for update loop
    continue when not clued_private.work_claim_merge_slot_live_v1(c);
    if c.merge_slot_ci_state is distinct from v_state or c.merge_slot_ci_head is distinct from v_head
        or c.merge_slot_hard_cap_seconds is distinct from v_cap then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,
        object_type,object_id,version,metadata)
      values(c.user_id,v_binding.id,c.context_key,'work_claim_merge_slot_touch','work_claim',
        c.claim_id::text,c.fence,jsonb_build_object('receipt_kind','WORK_CLAIM_MERGE_SLOT_TOUCHED',
          'claim_id',c.claim_id,'task_id',c.task_id,'fence',c.fence,'bound_pr',v_pr,
          'ci_state',v_state,'head_sha',v_head,'hard_cap_seconds',v_cap,
          'previous_ci_state',c.merge_slot_ci_state));
    end if;
    -- A green head's 30 minutes count from its first green report.
    update clued_private.work_claims_v1
      set merge_slot_ci_state=v_state,merge_slot_ci_head=v_head,
        merge_slot_ci_at=case when c.merge_slot_ci_state='green' and v_state='green' and c.merge_slot_ci_head=v_head
          then c.merge_slot_ci_at else v_now end,
        merge_slot_hard_cap_seconds=v_cap,updated_at=v_now
      where claim_id=c.claim_id returning * into c;
    v_touched:=v_touched||c.claim_id;
    v_until:=greatest(v_until,clued_private.work_claim_merge_slot_until_v1(c));
  end loop;
  return jsonb_build_object('status','ok','ci_state',v_state,'pr_ref',v_pr,'head_sha',v_head,
    'touched',cardinality(v_touched)>0,'claims',to_jsonb(v_touched),'merge_slot_until',v_until)
    ||case when cardinality(v_touched)=0 then jsonb_build_object('reason','no_live_slot_for_pr') else '{}'::jsonb end;
end $$;

-- clued_work_claim_adopt_v1: 20261006120000, resident-node only; the queues
-- are recorded before the slot is returned.
create or replace function public.clued_work_claim_adopt_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype; c clued_private.work_claims_v1%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_merge text:=lower(nullif(btrim(coalesce(p_input->>'merge_sha','')),'')); v_returned uuid[];
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','pr_ref','merge_sha')) then
    raise exception 'work_claim_adopt_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  -- Decision 38ddb8cf: only the CI admission Binding reports a merge.
  if not clued_private.merge_slot_admits_v1(v_binding) then
    return jsonb_build_object('status','ok','adopted',false,'reason','admission_binding_required');
  end if;
  if v_pr is null or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  if v_merge is null or v_merge !~ '^[0-9a-f]{7,64}$' then
    raise exception 'work_claim_head_sha_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  perform clued_private.work_claim_merge_front_sync_all_v1(v_binding.user_id,'merge:'||lower(split_part(v_pr,'#',1))||':');
  v_returned:=clued_private.work_claim_merge_slot_return_core_v1(v_binding.user_id,v_binding.id,v_scope,v_pr,
    'merged',jsonb_build_object('merge_sha',v_merge));
  select * into c from clued_private.work_claims_v1 w
    where w.user_id=v_binding.user_id and w.context_key=v_scope and w.bound_pr=v_pr and w.copy_index is not null
    order by w.issued_at desc limit 1;
  -- The answer is as before, with merge_slot_returned only when a slot was returned.
  if not found then return jsonb_build_object('status','ok','adopted',false,'reason','no_copy_for_pr','pr_ref',v_pr)
    ||case when cardinality(v_returned)>0 then jsonb_build_object('merge_slot_returned',to_jsonb(v_returned)) else '{}'::jsonb end; end if;
  return clued_private.work_claim_adopt_core_v1(c,v_binding.id,'github',
    jsonb_build_object('pr_ref',v_pr,'merge_sha',v_merge))||jsonb_build_object('pr_ref',v_pr)
    ||case when cardinality(v_returned)>0 then jsonb_build_object('merge_slot_returned',to_jsonb(v_returned)) else '{}'::jsonb end;
end $$;

-- clued_work_merge_slot_return_v1: 20261006120000, resident-node only; the
-- queues are recorded before the slot is returned.
create or replace function public.clued_work_merge_slot_return_v1(p_token_hash text,p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_binding public.clued_agent_bindings%rowtype;
  v_scope text:=coalesce(p_input->>'scope','global'); v_pr text:=nullif(btrim(coalesce(p_input->>'pr_ref','')),'');
  v_returned uuid[];
begin
  if jsonb_typeof(p_input) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('scope','pr_ref')) then
    raise exception 'work_claim_merge_slot_return_input_invalid' using errcode='22023'; end if;
  v_binding:=clued_private.resolve_binding(p_token_hash,'context:read',v_scope);
  if not clued_private.merge_slot_admits_v1(v_binding) then
    return jsonb_build_object('status','ok','returned',false,'reason','admission_binding_required');
  end if;
  if v_pr is null or v_pr !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$' then
    raise exception 'work_claim_pr_ref_invalid' using errcode='22023'; end if;
  perform clued_private.work_claim_lock(v_binding.user_id);
  perform clued_private.work_claim_merge_front_sync_all_v1(v_binding.user_id,'merge:'||lower(split_part(v_pr,'#',1))||':');
  v_returned:=clued_private.work_claim_merge_slot_return_core_v1(v_binding.user_id,v_binding.id,v_scope,v_pr,
    'closed',null);
  return jsonb_build_object('status','ok','returned',cardinality(v_returned)>0,'pr_ref',v_pr,
    'merge_slot_returned',to_jsonb(v_returned));
end $$;

-- ---------------------------------------------------------------------------
-- Queued-claim keepalive (§41.4), an action of the CI command door.
-- Input {action: merge_queue_keepalive, scope, repository, pr_refs}: pr_refs
-- are the repository's pull requests the caller has just seen open (at most
-- 50). Under the claim lock, due claims expire first (the queue counts an
-- ACTIVE claim past its lease, so a lease must not be revived); then every
-- claim of this scope that is the head or waiting in one of the repository's
-- queues, still within its lease and bound to a listed pull request, gets
-- expires_at := greatest(expires_at, least(now + lease, hard_deadline_at)).
-- Nothing else of the claim changes. At most one receipt per claim per hour.
create function clued_private.work_claim_merge_queue_keepalive_v1(b public.clued_agent_bindings,p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_scope text:=coalesce(p_input->>'scope','global'); v_repo text:=p_input->>'repository';
  v_prs text[]; v_prefix text; v_ref text; v_ids uuid[]:='{}'::uuid[]; c clued_private.work_claims_v1%rowtype;
  v_now timestamptz:=pg_catalog.clock_timestamp(); v_expires timestamptz; v_kept jsonb:='[]'::jsonb;
  v_lease integer:=(clued_private.work_claim_profile_v1()->>'lease_seconds')::integer; v_receipt uuid;
begin
  if p_input-array['action','scope','repository','pr_refs']<>'{}'::jsonb
      or jsonb_typeof(p_input->'repository') is distinct from 'string'
      or v_repo !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'
      or jsonb_typeof(p_input->'pr_refs') is distinct from 'array'
      or jsonb_array_length(p_input->'pr_refs')>50
      or exists(select 1 from jsonb_array_elements(p_input->'pr_refs') x
        where jsonb_typeof(x) is distinct from 'string'
          or x#>>'{}' !~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$'
          or lower(split_part(x#>>'{}','#',1))<>lower(v_repo)) then
    raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
  if not clued_private.merge_slot_admits_v1(b) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  v_prs:=array(select x#>>'{}' from jsonb_array_elements(p_input->'pr_refs') x);
  v_prefix:='merge:'||lower(v_repo)||':';
  perform clued_private.work_claim_expire_due(b.user_id);
  foreach v_ref in array clued_private.work_claim_merge_queue_refs_v1(b.user_id,v_prefix) loop
    perform clued_private.work_claim_merge_front_sync_v1(b.user_id,v_ref);
    v_ids:=v_ids||array(select (e->>'claim_id')::uuid from jsonb_array_elements(
      clued_private.work_claim_merge_queue_current_v1(b.user_id,v_ref)->'entries') e
      where e->>'state' in ('head','waiting'));
  end loop;
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=b.user_id and w.claim_id=any(v_ids) and w.context_key=v_scope
      and w.status in ('ACTIVE','DRAINING') and w.expires_at>v_now and w.bound_pr=any(v_prs)
    order by w.issued_at for update loop
    v_expires:=greatest(c.expires_at,least(v_now+make_interval(secs=>v_lease),c.hard_deadline_at));
    continue when v_expires<=c.expires_at;
    update clued_private.work_claims_v1 set expires_at=v_expires where claim_id=c.claim_id;
    v_receipt:=null;
    if not exists(select 1 from public.clued_audit_receipts r where r.user_id=b.user_id
        and r.operation='work_claim_queue_keepalive' and r.object_id=c.claim_id::text
        and r.created_at>v_now-interval '1 hour') then
      insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
      values(b.user_id,b.id,c.context_key,'work_claim_queue_keepalive','work_claim',c.claim_id::text,c.fence,
        jsonb_build_object('receipt_kind','WORK_CLAIM_QUEUE_KEPT_ALIVE','claim_id',c.claim_id,'task_id',c.task_id,
          'fence',c.fence,'bound_pr',c.bound_pr,'previous_expires_at',c.expires_at,'expires_at',v_expires))
      returning id into v_receipt;
    end if;
    v_kept:=v_kept||jsonb_build_array(jsonb_build_object('claim_id',c.claim_id,'bound_pr',c.bound_pr,
      'expires_at',v_expires,'previous_expires_at',c.expires_at,'receipt_id',v_receipt));
  end loop;
  return jsonb_build_object('status','ok','repository',v_repo,'kept_alive',v_kept);
end $$;

-- work_claim_ci_command_v1: the current definition (20261011131755 with the
-- patches of 20261023010000 and 20261029050000), plus the keepalive action.
CREATE OR REPLACE FUNCTION clued_private.work_claim_ci_command_v1(p_token_hash text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare b public.clued_agent_bindings; c clued_private.work_claims_v1;
  o clued_private.work_claim_revocation_outbox_v1; p clued_private.work_claim_publications_v1;
  op text:=p_input->>'action'; scope text:=coalesce(p_input->>'scope','global');
  epoch bigint; result jsonb; id uuid; verification_input jsonb; receipt uuid;
  contexts text[]:='{}'::text[]; context_row text; context_page text[]; outboxes uuid[]; publications uuid[];
begin
  perform clued_private.intake_payload_cap_v1(p_input);
  b:=clued_private.resolve_binding(p_token_hash,'context:read',scope);
  -- A role label supplied in a payload or a read-only Agent connection is
  -- never a CI principal. This is the existing Owner-designated CI Binding.
  if not exists(select 1 from clued_private.binding_roles_v1 r where r.user_id=b.user_id
      and r.binding_id=b.id and r.role='ci-admission' and r.revoked_at is null
      and r.effective_at<=clock_timestamp()) then
    return jsonb_build_object('status','rejected','error_code','admission_binding_required'); end if;
  perform clued_private.work_claim_lock(b.user_id);
  if op='merge_queue_keepalive' then
    return clued_private.work_claim_merge_queue_keepalive_v1(b,p_input);
  end if;
  if op='publication_begin_independent' then
    return clued_private.work_claim_independent_begin_v1(p_token_hash,p_input);
  end if;
  if op='publication_abort_independent' then
    return clued_private.work_claim_independent_abort_v1(p_token_hash,p_input);
  end if;
  if op in ('independent_revocation_heads','independent_legacy_drain_finish') then
    return clued_private.work_claim_independent_drain_command_v1(p_token_hash,p_input);
  end if;
  if op='revocations_contexts' then
    if p_input-array['action','scope','cursor']<>'{}'::jsonb or scope<>'global'
      or (p_input ? 'cursor' and (jsonb_typeof(p_input->'cursor') is distinct from 'string'
        or p_input->>'cursor' !~ '^(global|project:[0-9a-f-]{36})$')) then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select array_agg(x.context_key order by x.context_key) into context_page from (
      select context_key from (
        select context_key from clued_private.work_claim_revocation_outbox_v1 where user_id=b.user_id and state='pending'
        union
        select claim_row.context_key from clued_private.work_claim_publications_v1 pubs
          join clued_private.work_claims_v1 claim_row on claim_row.claim_id=pubs.claim_id
          where pubs.user_id=b.user_id and pubs.state='open' and (pubs.execution_epoch<claim_row.execution_epoch
            or claim_row.status<>'ACTIVE' or claim_row.expires_at<=clock_timestamp() or claim_row.execution_handover_pending)
      ) known where context_key>coalesce(p_input->>'cursor','') order by context_key limit 101
    ) x;
    foreach context_row in array coalesce(context_page[1:100],'{}'::text[]) loop
      begin
        perform clued_private.resolve_binding(p_token_hash,'context:read',context_row);
        contexts:=array_append(contexts,context_row);
      exception when insufficient_privilege then null;
      end;
    end loop;
    return jsonb_build_object('status','ok','context_keys',to_jsonb(contexts),
      'next_cursor',case when cardinality(context_page)>100 then context_page[100] else null end);
  end if;
  if op='revocations_list' then
    if p_input-array['action','scope','outbox_cursor','publication_cursor']<>'{}'::jsonb
      or (p_input ? 'outbox_cursor' and coalesce(p_input->>'outbox_cursor','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
      or (p_input ? 'publication_cursor' and coalesce(p_input->>'publication_cursor','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select array_agg(x.outbox_id order by x.outbox_id) into outboxes from (
      select outbox_id from clued_private.work_claim_revocation_outbox_v1 where user_id=b.user_id
        and context_key=scope and state='pending'
        and (not(p_input ? 'outbox_cursor') or outbox_id>(p_input->>'outbox_cursor')::uuid)
      order by outbox_id limit 101) x;
    select array_agg(x.publication_id order by x.publication_id) into publications from (
      select pubs.publication_id from clued_private.work_claim_publications_v1 pubs
        join clued_private.work_claims_v1 claim_row on claim_row.claim_id=pubs.claim_id
      where pubs.user_id=b.user_id and claim_row.context_key=scope and pubs.state='open'
        and (pubs.execution_epoch<claim_row.execution_epoch or claim_row.status<>'ACTIVE'
          or claim_row.expires_at<=clock_timestamp() or claim_row.execution_handover_pending)
        and (not(p_input ? 'publication_cursor') or pubs.publication_id>(p_input->>'publication_cursor')::uuid)
      order by pubs.publication_id limit 101) x;
    return jsonb_build_object('status','ok','revocations',coalesce((select jsonb_agg(to_jsonb(x))
      from (select outbox_id,claim_id,execution_epoch,repository,head_sha,pr_ref,workflow
        from clued_private.work_claim_revocation_outbox_v1 where user_id=b.user_id
          and outbox_id=any(coalesce(outboxes[1:100],'{}'::uuid[])) order by outbox_id) x),'[]'::jsonb),
      'publications',coalesce((select jsonb_agg(to_jsonb(x)) from (
        select pubs.publication_id,pubs.claim_id,pubs.execution_epoch,pubs.repository,pubs.head_sha,pubs.pr_ref,pubs.run_id,pubs.check_run_id,pubs.independent_identity,pubs.started_receipt_id
        from clued_private.work_claim_publications_v1 pubs
          join clued_private.work_claims_v1 claim_row on claim_row.claim_id=pubs.claim_id
        where pubs.user_id=b.user_id and claim_row.context_key=scope and pubs.state='open'
          and pubs.publication_id=any(coalesce(publications[1:100],'{}'::uuid[]))
        order by pubs.publication_id) x),'[]'::jsonb),
      'next_outbox_cursor',case when cardinality(outboxes)>100 then outboxes[100] else null end,
      'next_publication_cursor',case when cardinality(publications)>100 then publications[100] else null end);
  end if;
  if op='revocation_ack' then
    if p_input-array['action','scope','outbox_id','execution_epoch','evidence']<>'{}'::jsonb
      or jsonb_typeof(p_input->'evidence') is distinct from 'object' then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into o from clued_private.work_claim_revocation_outbox_v1
      where user_id=b.user_id and context_key=scope and outbox_id=(p_input->>'outbox_id')::uuid for update;
    if o.outbox_id is null or o.execution_epoch is distinct from (p_input->>'execution_epoch')::bigint then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_stale'); end if;
    select * into c from clued_private.work_claims_v1 where claim_id=o.claim_id and user_id=b.user_id;
    if c.execution_epoch<>o.execution_epoch then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_stale'); end if;
    if o.state='acknowledged' then
      return jsonb_build_object('status','committed','replayed',true,'receipt_id',o.acknowledged_receipt_id,
        'outbox_id',o.outbox_id,'execution_epoch',o.execution_epoch); end if;
    if exists(select 1 from clued_private.work_claim_publications_v1 where claim_id=c.claim_id
        and execution_epoch<c.execution_epoch and state='open') then
      return jsonb_build_object('status','rejected','error_code','work_claim_publications_unresolved'); end if;
    if o.repository='tdoljyj/cross-memory-system' and exists(
      select 1 from clued_private.work_claim_independent_consumer_v1 policy where policy.singleton
        and policy.source_manifest_sha256 is not null and not exists(
          select 1 from clued_private.work_claim_independent_drains_v1 d where d.outbox_id=o.outbox_id
            and d.user_id=b.user_id and d.execution_epoch=o.execution_epoch
            and d.source_manifest_sha256=policy.source_manifest_sha256
            and jsonb_array_length(d.evidence->'stop_proof_refs')>0
            and not exists(select 1 from unnest(coalesce(c.admitted_heads,'{}'::text[])||array[o.head_sha]) h
              where h ~ '^[0-9a-f]{40}$' and not exists(
                select 1 from jsonb_array_elements_text(d.evidence->'heads') covered(head) where covered.head=h)))) then
      return jsonb_build_object('status','rejected','error_code','work_claim_independent_drain_required'); end if;
    if p_input->'evidence'->'checks_revoked' is distinct from 'true'::jsonb
      or p_input->'evidence'->'auto_merge_disabled' is distinct from 'true'::jsonb
      or p_input->'evidence'->'dispatch_revoked' is distinct from 'true'::jsonb then
      return jsonb_build_object('status','rejected','error_code','work_claim_revocation_incomplete'); end if;
    receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_revocation_ack',c.claim_id,c.execution_epoch,
      jsonb_build_object('outbox_id',o.outbox_id,'repository',o.repository,'head_sha',o.head_sha,
        'pr_ref',o.pr_ref,'workflow',o.workflow,'evidence',p_input->'evidence'));
    update clued_private.work_claim_revocation_outbox_v1 set state='acknowledged',
      acknowledged_at=clock_timestamp(),evidence=p_input->'evidence',acknowledged_receipt_id=receipt where outbox_id=o.outbox_id;
    return jsonb_build_object('status','committed','receipt_id',receipt,'outbox_id',o.outbox_id,'execution_epoch',o.execution_epoch);
  end if;
  if op='publication_reconcile' or op='publication_finish' then
    if p_input-array['action','scope','publication_id','check_run_id','checks_revoked','publisher_stopped']<>'{}'::jsonb then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into p from clued_private.work_claim_publications_v1 where user_id=b.user_id
      and publication_id=(p_input->>'publication_id')::uuid for update;
    if p.publication_id is null then return jsonb_build_object('status','rejected','error_code','work_claim_publication_not_found'); end if;
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id and claim_id=p.claim_id and context_key=scope;
    if c.claim_id is null then return jsonb_build_object('status','rejected','error_code','work_claim_publication_not_found'); end if;
    if p.check_run_id is not null and p.check_run_id is distinct from p_input->>'check_run_id' then
      return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
    if op='publication_reconcile' then
      if p_input->'checks_revoked' is distinct from 'true'::jsonb
        or p_input->'publisher_stopped' is distinct from 'true'::jsonb
        or coalesce(p_input->>'check_run_id','') !~ '^[0-9]{1,20}$'
        or (p.check_run_id is not null and p.check_run_id<>p_input->>'check_run_id') then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
      if p.state='reconciled' then
        return jsonb_build_object('status','committed','replayed',true,'receipt_id',p.finished_receipt_id,
          'execution_epoch',p.execution_epoch,'must_revoke',true); end if;
      update clued_private.work_claim_publications_v1 set state='reconciled',check_run_id=p_input->>'check_run_id',finished_at=clock_timestamp()
        where publication_id=p.publication_id;
    else
      if p.state='reconciled' then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_reconciled'); end if;
      if coalesce(p_input->>'check_run_id','') !~ '^[0-9]{1,20}$' then
        raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
      if p.finished_receipt_id is not null and p.check_run_id=p_input->>'check_run_id'
        and ((p.state='published' and p.execution_epoch=c.execution_epoch and not c.execution_handover_pending
          and c.status='ACTIVE' and c.expires_at>clock_timestamp()) or p.state='open') then
        return jsonb_build_object('status','committed','replayed',true,'receipt_id',p.finished_receipt_id,
          'execution_epoch',p.execution_epoch,'must_revoke',p.state='open'); end if;
      update clued_private.work_claim_publications_v1 set state=case
        when p.execution_epoch<>c.execution_epoch or c.execution_handover_pending
          or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp() then 'open' else 'published' end,
        check_run_id=p_input->>'check_run_id',finished_at=clock_timestamp() where publication_id=p.publication_id;
    end if;
    receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_'||op,c.claim_id,p.execution_epoch,
      jsonb_build_object('publication_id',p.publication_id,'repository',p.repository,'head_sha',p.head_sha,
        'pr_ref',p.pr_ref,'run_id',p.run_id,'check_run_id',p_input->>'check_run_id',
        'checks_revoked',p_input->'checks_revoked','publisher_stopped',p_input->'publisher_stopped'));
    update clued_private.work_claim_publications_v1 set finished_receipt_id=receipt where publication_id=p.publication_id;
    return jsonb_build_object('status','committed','receipt_id',receipt,'execution_epoch',p.execution_epoch,
      'must_revoke',p.execution_epoch<>c.execution_epoch or c.execution_handover_pending
        or c.status<>'ACTIVE' or c.expires_at<=clock_timestamp());
  end if;
  if op='publication_abort' then
    if p_input-array['action','scope','publication_id','not_sent']<>'{}'::jsonb
      or p_input->'not_sent' is distinct from 'true'::jsonb then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    select * into p from clued_private.work_claim_publications_v1 where user_id=b.user_id
      and publication_id=(p_input->>'publication_id')::uuid for update;
    if p.publication_id is null or p.state<>'open' or p.check_run_id is not null
      or not exists(select 1 from clued_private.work_claims_v1 claim_row
        where claim_row.claim_id=p.claim_id and claim_row.context_key=scope) then
      return jsonb_build_object('status','rejected','error_code','work_claim_publication_unresolved'); end if;
    update clued_private.work_claim_publications_v1 set state='reconciled',finished_at=clock_timestamp()
      where publication_id=p.publication_id;
    receipt:=clued_private.work_claim_ci_receipt_v1(b,scope,'work_claim_publication_abort',p.claim_id,p.execution_epoch,
      jsonb_build_object('publication_id',p.publication_id,'repository',p.repository,'head_sha',p.head_sha,
        'pr_ref',p.pr_ref,'run_id',p.run_id,'not_sent',true));
    update clued_private.work_claim_publications_v1 set finished_receipt_id=receipt where publication_id=p.publication_id;
    return jsonb_build_object('status','committed','receipt_id',receipt,'publication_id',p.publication_id);
  end if;
  if op='publication_begin' then
    if coalesce(p_input->>'run_id','') !~ '^[0-9]{1,20}$'
      or coalesce(p_input->>'publication_key','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
      raise exception 'work_claim_ci_command_invalid' using errcode='22023'; end if;
    verification_input:=p_input-array['action','run_id','publication_key'];
    if not(verification_input ? 'claim_id') then
      select * into c from clued_private.work_claims_v1 where user_id=b.user_id
        and bound_pr=p_input->>'pr_ref' and lease_key_required and status in ('ACTIVE','DRAINING')
        order by updated_at desc limit 1;
      if c.claim_id is null then
        return jsonb_build_object('status','ok','publication_required',false); end if;
      verification_input:=verification_input||jsonb_build_object('claim_id',c.claim_id,'scope',c.context_key);
    end if;
    result:=public.clued_work_verify_v1(p_token_hash,verification_input);
    if result->>'verdict'<>'ADMITTED' then return result; end if;
    select * into c from clued_private.work_claims_v1 where user_id=b.user_id and context_key=verification_input->>'scope'
      and claim_id=(verification_input->>'claim_id')::uuid;
    if not clued_private.work_claim_execution_enabled_v1() or not c.lease_key_required then
      return result||jsonb_build_object('publication_required',false); end if;
    if c.execution_handover_pending or coalesce(p_input->>'pr_ref','')='' then
      return jsonb_build_object('status','rejected','error_code','work_claim_handover_pending'); end if;
    insert into clued_private.work_claim_publications_v1(user_id,claim_id,execution_epoch,repository,
      head_sha,pr_ref,run_id,publication_key) values(b.user_id,c.claim_id,c.execution_epoch,
      lower(split_part(p_input->>'pr_ref','#',1)),p_input->>'head_sha',p_input->>'pr_ref',p_input->>'run_id',
      (p_input->>'publication_key')::uuid)
      on conflict(claim_id,execution_epoch,publication_key) do nothing
      returning publication_id into id;
    if id is null then
      select * into p from clued_private.work_claim_publications_v1 where claim_id=c.claim_id
        and execution_epoch=c.execution_epoch and publication_key=(p_input->>'publication_key')::uuid;
      if p.head_sha is distinct from p_input->>'head_sha' or p.pr_ref is distinct from p_input->>'pr_ref'
        or p.run_id is distinct from p_input->>'run_id' or p.state<>'open' then
        return jsonb_build_object('status','rejected','error_code','work_claim_publication_idempotency_conflict'); end if;
      id:=p.publication_id;
      receipt:=p.started_receipt_id;
    else
      receipt:=clued_private.work_claim_ci_receipt_v1(b,c.context_key,'work_claim_publication_begin',c.claim_id,c.execution_epoch,
        jsonb_build_object('publication_id',id,'repository',lower(split_part(p_input->>'pr_ref','#',1)),
          'head_sha',p_input->>'head_sha','pr_ref',p_input->>'pr_ref','run_id',p_input->>'run_id'));
      update clued_private.work_claim_publications_v1 set started_receipt_id=receipt where publication_id=id;
    end if;
    return result||jsonb_build_object('publication_required',true,'publication_id',id,'scope',c.context_key,'receipt_id',receipt);
  end if;
  raise exception 'work_claim_ci_command_invalid' using errcode='22023';
end $function$;

-- ---------------------------------------------------------------------------
-- The Owner's switch and page.

create function clued_private.merge_queue_setting_view_v1(p_user_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(
    (select jsonb_build_object('ordering',s.ordering,'version',s.version,'default',false,
        'updated_at',s.updated_at,'receipt_id',s.receipt_id)
      from clued_private.merge_queue_settings_v1 s where s.user_id=p_user_id),
    jsonb_build_object('ordering','fifo','version',0,'default',true,'updated_at',null,'receipt_id',null))
$$;

-- clued_merge_queue_v1: {} -> {status: ok, setting, queues}: each queue's
-- head and waiting entries with their Task and automatic priority.
-- The Owner's page. VOLATILE although it only reads (the owner check's row lock).
create function public.clued_merge_queue_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_ref text; v_queue jsonb;
  v_queues jsonb:='[]'::jsonb;
begin
  if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input)) then
    raise exception 'merge_queue_input_invalid' using errcode='22023'; end if;
  foreach v_ref in array clued_private.work_claim_merge_queue_refs_v1(v_owner,null) loop
    v_queue:=clued_private.work_claim_merge_queue_current_v1(v_owner,v_ref);
    v_queues:=v_queues||jsonb_build_array(jsonb_build_object('ref',v_ref,'entries',coalesce((
      select jsonb_agg(jsonb_build_object('claim_id',w.claim_id,'task_id',w.task_id,'task_title',m.title,
          'state',e->>'state','position',(e->>'position')::integer,'queued_at',w.merge_queued_at,
          'since',e->'since','bound_pr',w.bound_pr,'holder_label',w.holder_label,
          'front_recorded',f.claim_id is not distinct from w.claim_id and f.queued_at is not distinct from w.merge_queued_at)
          ||jsonb_build_object('auto_priority',coalesce((select r.rank from clued_private.work_claim_merge_rank_v1 r
              where r.claim_id=w.claim_id and r.queued_at=w.merge_queued_at),
            clued_private.merge_queue_rank_v1(v_owner,w.task_id)))
        order by (e->>'position')::integer)
      from jsonb_array_elements(v_queue->'entries') e
      join clued_private.work_claims_v1 w on w.claim_id=(e->>'claim_id')::uuid
      left join public.clued_memories m on m.id=w.task_id
      left join clued_private.work_claim_merge_front_v1 f on f.user_id=v_owner and f.merge_ref=v_ref
      where e->>'state' in ('head','waiting')),'[]'::jsonb)));
  end loop;
  return jsonb_build_object('status','ok','setting',clued_private.merge_queue_setting_view_v1(v_owner),
    'queues',v_queues);
end $$;

-- clued_merge_queue_ordering_set_v1: {ordering: fifo|priority, base_version}
-- -> {status: committed, changed, ordering, version, ...}. The first change
-- records today's queues as they stand; no change ever moves a front.
create function public.clued_merge_queue_ordering_set_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare v_owner uuid:=clued_private.authorization_owner_v12(); v_session text:=clued_private.native_session_id_v1();
  v_current jsonb; v_ordering text; v_base bigint; v_version bigint; v_receipt uuid;
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if jsonb_typeof(p_input) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_input) k where k not in ('ordering','base_version'))
    or jsonb_typeof(p_input->'ordering') is distinct from 'string'
    or p_input->>'ordering' not in ('fifo','priority')
    or jsonb_typeof(p_input->'base_version') is distinct from 'number'
    or (p_input->>'base_version') !~ '^[0-9]{1,18}$' then
    raise exception 'merge_queue_setting_input_invalid' using errcode='22023'; end if;
  if v_session is null then
    raise exception 'merge_queue_setting_session_required' using errcode='42501'; end if;
  v_ordering:=p_input->>'ordering';
  v_base:=(p_input->>'base_version')::bigint;
  perform clued_private.work_claim_lock(v_owner);
  v_current:=clued_private.merge_queue_setting_view_v1(v_owner);
  v_version:=(v_current->>'version')::bigint;
  if v_version<>v_base then
    return jsonb_build_object('status','rejected','error_code','merge_queue_setting_version_conflict',
      'authoritative',false,'current',v_current);
  end if;
  if v_current->>'ordering'=v_ordering then
    return jsonb_build_object('status','committed','changed',false)||v_current;
  end if;
  if v_version=0 then
    perform clued_private.work_claim_merge_front_start_v1(v_owner);
  else
    perform clued_private.work_claim_merge_front_sync_all_v1(v_owner,null);
  end if;
  -- The merge measurement journal learns that this account's queue is no
  -- longer today's FIFO (same event shape as the policy rows of 20261011033947).
  perform clued_private.merge_measurement_append_v1(v_owner,'global','policy','merge-train-v1',
    jsonb_build_object('profile',clued_private.work_claim_profile_v1(),'ordering',v_ordering,
      'front_recorded',true,'fifo_markers',false));
  v_version:=v_version+1;
  insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
  values(v_owner,null,'global','merge_queue_ordering_set','merge_queue_setting',v_owner::text,v_version,
    jsonb_build_object('receipt_kind',case when v_ordering='priority' then 'MERGE_QUEUE_ORDERING_PRIORITY'
        else 'MERGE_QUEUE_ORDERING_FIFO' end,
      'ordering',v_ordering,'base_version',v_base,'session_id',v_session,'principal','native_account_session'))
  returning id into v_receipt;
  insert into clued_private.merge_queue_settings_v1(user_id,ordering,version,updated_at,receipt_id)
  values(v_owner,v_ordering,v_version,v_now,v_receipt)
  on conflict (user_id) do update set ordering=excluded.ordering,version=excluded.version,
    updated_at=excluded.updated_at,receipt_id=excluded.receipt_id;
  return jsonb_build_object('status','committed','changed',true)||clued_private.merge_queue_setting_view_v1(v_owner);
end $$;

-- ---------------------------------------------------------------------------
-- Grants: the two Owner RPCs to authenticated; everything else to nobody.

revoke all on function
  clued_private.merge_queue_ordering_v1(uuid),
  clued_private.merge_queue_recorded_v1(uuid),
  clued_private.merge_queue_rank_v1(uuid,uuid),
  clued_private.work_claim_merge_queue_v2(uuid,text),
  clued_private.work_claim_merge_queue_current_v1(uuid,text),
  clued_private.work_claim_merge_queue_refs_v1(uuid,text),
  clued_private.work_claim_merge_front_sync_v1(uuid,text),
  clued_private.work_claim_merge_front_sync_all_v1(uuid,text),
  clued_private.work_claim_merge_front_start_v1(uuid),
  clued_private.work_claim_merge_front_before_v1(),
  clued_private.work_claim_merge_front_after_v1(),
  clued_private.work_claim_merge_marker_guard_v1(),
  clued_private.merge_slot_admits_v1(public.clued_agent_bindings),
  clued_private.work_claim_merge_queue_keepalive_v1(public.clued_agent_bindings,jsonb),
  clued_private.merge_queue_setting_view_v1(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.clued_merge_queue_v1(jsonb),
  public.clued_merge_queue_ordering_set_v1(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.clued_merge_queue_v1(jsonb),
  public.clued_merge_queue_ordering_set_v1(jsonb) to authenticated;

notify pgrst,'reload schema';
