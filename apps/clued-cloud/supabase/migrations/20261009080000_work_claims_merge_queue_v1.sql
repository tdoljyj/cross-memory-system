-- Work Claims: the merge slot becomes a FIFO merge queue (Merge Admission
-- v0.1 §7.2, step 4 of §13; Task 38e0c90d; Owner Decision 661f8c36).
--
-- Until now the slot merge:<owner>/<name>:<branch> was a mutually exclusive
-- trigger ref: a session that wanted it while another held it got
-- work_claim_conflict and had to try again later. Now taking the slot is
-- joining a queue:
-- - A claim joins when it is issued with a merge ref or a merge ref is added
--   to it (merge_queued_at). Merge refs no longer conflict: the claim or
--   renewal succeeds, and the claim's view carries merge_queue (its state and
--   position, the head, who is ahead).
-- - The head of the queue holds the slot. Its slot starts when it became head
--   (when it joined, or when the entry ahead of it left) and lapses on the
--   clocks of 20261009010000, counted from that start: renewal 45 minutes, CI
--   running 90, green 30, the hard cap; never after the claim's lease.
-- - An entry leaves when its merge ref is dropped (merge, close, CI failure,
--   a renewal without it), its claim stops being live (release, expiry), or
--   its slot lapses. The next entry becomes head at that moment.
-- - A lapsed entry is out of the queue for good; a renewal that keeps its
--   merge ref joins again at the back. A renewal of a waiting entry keeps its
--   place.
-- The queue is computed from the claims on each read
-- (work_claim_merge_queue_v1); nothing runs in the background. When an entry
-- that was head or had lapsed leaves, work_claim_merge_queue_v1 (the table)
-- records when it left and its place, so the computation stays the same
-- after it is gone. Everything that read the slot through
-- work_claim_merge_slot_until_v1 / _live_v1 (the claim view, the holders and
-- touch RPCs, the clued-merge-slot check) now sees only the head.

alter table clued_private.work_claims_v1 add column merge_queued_at timestamptz;

-- Per account and merge ref: the last entry that left after holding the slot
-- or after its slot lapsed. Entries at or before its place are out; the next
-- one's slot starts no earlier than head_left_at.
create table clued_private.work_claim_merge_queue_v1 (
  user_id uuid not null references auth.users(id) on delete cascade,
  merge_ref text not null,
  head_left_at timestamptz not null,
  left_queued_at timestamptz not null,
  left_claim_id uuid not null,
  primary key (user_id, merge_ref)
);
alter table clued_private.work_claim_merge_queue_v1 enable row level security;
revoke all on table clued_private.work_claim_merge_queue_v1 from public,anon,authenticated,service_role;

-- Live claims with a merge ref join in the order they took the slot.
update clued_private.work_claims_v1
  set merge_queued_at=coalesce(merge_slot_taken_at,merge_slot_at,updated_at)
  where status in ('ACTIVE','DRAINING') and cardinality(clued_private.work_claim_merge_refs_v1(trigger_refs))>0;

-- Live entries only: a released or expired claim keeps its join time (review MINOR-5).
create index work_claims_v1_merge_queue_idx on clued_private.work_claims_v1(user_id,merge_queued_at)
  where merge_queued_at is not null and status in ('ACTIVE','DRAINING');

-- When a claim's slot lapses if it became head at p_start: the later of the
-- renewal clock and the CI clock, never after the hard cap counted from
-- p_start or the lease. A renewal before p_start counts as made at p_start,
-- so a new head has at least merge_slot_seconds. CI reports from before
-- p_start do not count. greatest and least skip nulls.
create function clued_private.work_claim_merge_slot_until_from_v1(c clued_private.work_claims_v1,p_start timestamptz)
returns timestamptz language sql stable set search_path='' as $$
  select least(
    greatest(greatest(c.merge_slot_at,p_start)+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'merge_slot_seconds')::integer),
      case when c.merge_slot_ci_at>=p_start then case c.merge_slot_ci_state
        when 'running' then c.merge_slot_ci_at+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'merge_slot_running_seconds')::integer)
        when 'green' then c.merge_slot_ci_at+make_interval(secs=>(clued_private.work_claim_profile_v1()->>'merge_slot_green_seconds')::integer)
      end end),
    p_start+make_interval(secs=>c.merge_slot_hard_cap_seconds),
    c.expires_at)
$$;

-- The queue of one merge ref of one account, in join order: each entry's
-- state (head, waiting, lapsed, out) and, for head and lapsed, when its slot
-- started and lapses. Claims that are ACTIVE or DRAINING count even past
-- their expires_at: the lease bounds the slot, and work_claim_expire_due
-- marks them later.
create function clued_private.work_claim_merge_queue_v1(p_user_id uuid,p_ref text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c clued_private.work_claims_v1%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp();
  q clued_private.work_claim_merge_queue_v1%rowtype;
  v_cursor timestamptz; v_start timestamptz; v_until timestamptz; v_head jsonb; v_position integer:=0;
  v_entries jsonb:='[]'::jsonb;
begin
  select * into q from clued_private.work_claim_merge_queue_v1 x
    where x.user_id=p_user_id and x.merge_ref=lower(p_ref);
  v_cursor:=q.head_left_at;
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING') and w.merge_queued_at is not null
      and exists(select 1 from unnest(w.trigger_refs) t where lower(t)=lower(p_ref))
    order by w.merge_queued_at,w.claim_id loop
    if q.left_claim_id is not null and (c.merge_queued_at,c.claim_id)<=(q.left_queued_at,q.left_claim_id) then
      -- Ahead of an entry that has already left: its slot lapsed before.
      v_entries:=v_entries||jsonb_build_array(jsonb_build_object('claim_id',c.claim_id,'state','out',
        'queued_at',c.merge_queued_at,'bound_pr',c.bound_pr));
    elsif v_head is null then
      v_start:=greatest(c.merge_queued_at,v_cursor);
      v_until:=clued_private.work_claim_merge_slot_until_from_v1(c,v_start);
      if v_until>v_now then
        v_position:=1;
        v_head:=jsonb_build_object('claim_id',c.claim_id,'since',v_start,'until',v_until,
          'bound_pr',c.bound_pr,'holder_label',c.holder_label);
        v_entries:=v_entries||jsonb_build_array(v_head||jsonb_build_object('state','head','position',1,
          'queued_at',c.merge_queued_at));
      else
        v_cursor:=greatest(v_cursor,v_until,v_start);
        v_entries:=v_entries||jsonb_build_array(jsonb_build_object('claim_id',c.claim_id,'state','lapsed',
          'queued_at',c.merge_queued_at,'since',v_start,'until',v_until,'bound_pr',c.bound_pr));
      end if;
    else
      v_position:=v_position+1;
      v_entries:=v_entries||jsonb_build_array(jsonb_build_object('claim_id',c.claim_id,'state','waiting',
        'position',v_position,'queued_at',c.merge_queued_at,'bound_pr',c.bound_pr,'holder_label',c.holder_label));
    end if;
  end loop;
  return jsonb_build_object('ref',lower(p_ref),'head',v_head,'length',v_position,'entries',v_entries);
end $$;

-- A claim's entry in each queue it is in, or null without a merge ref:
-- state, position, the head, and the live entries ahead of it.
create function clued_private.work_claim_merge_queue_view_v1(c clued_private.work_claims_v1) returns jsonb
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
      from (select clued_private.work_claim_merge_queue_v1(c.user_id,r.ref) v
              from unnest(clued_private.work_claim_merge_refs_v1(c.trigger_refs)) r(ref)) x)
  end
$$;

-- When the claim's slot lapses, or null when it is not the head of any of
-- its queues. Replaces 20261009010000: the slot is the head's.
create or replace function clued_private.work_claim_merge_slot_until_v1(c clued_private.work_claims_v1) returns timestamptz
language sql stable security definer set search_path='' as $$
  select case when c.merge_queued_at is not null and c.status in ('ACTIVE','DRAINING')
      and cardinality(clued_private.work_claim_merge_refs_v1(c.trigger_refs))>0
    then (select min((x.v->'head'->>'until')::timestamptz)
      from (select clued_private.work_claim_merge_queue_v1(c.user_id,r.ref) v
              from unnest(clued_private.work_claim_merge_refs_v1(c.trigger_refs)) r(ref)) x
      where x.v->'head'->>'claim_id'=c.claim_id::text) end
$$;

-- Stamps the queue. A claim joins (back of its queues, no CI state) when it
-- is issued with merge refs, when its set of merge refs changes in any way
-- other than dropping all of them (one join time per claim, so a changed set
-- joins every queue again; independent review MAJOR-2), or when it is
-- renewed while lapsed or out in one of them. A renewal while head or waiting
-- refreshes the renewal clock. Before the change, each queue in which the
-- claim was head or had lapsed and that it now leaves (ref dropped, claim no
-- longer live, or joining again) records the leaving: for a head, now or its
-- lapse if earlier; for a lapsed entry, the cursor after it, its lapse or
-- its start whichever is later (independent review BLOCKER-1). Merge refs
-- are compared without case, as the queue matches them (review MINOR-3).
-- Without merge refs there is no slot.
create or replace function clued_private.work_claim_merge_slot_stamp_v1() returns trigger
language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=pg_catalog.clock_timestamp(); v_ref text; e jsonb;
  v_old text[]; v_new text[]; v_rejoin boolean:=false; v_states jsonb:='{}'::jsonb;
begin
  v_new:=array(select distinct lower(t) from unnest(clued_private.work_claim_merge_refs_v1(new.trigger_refs)) t order by 1);
  if tg_op='UPDATE' then
    v_old:=array(select distinct lower(t) from unnest(clued_private.work_claim_merge_refs_v1(old.trigger_refs)) t order by 1);
  end if;
  if tg_op='UPDATE' and old.merge_queued_at is not null and old.status in ('ACTIVE','DRAINING') then
    foreach v_ref in array v_old loop
      e:=null;
      select x into e from jsonb_array_elements(clued_private.work_claim_merge_queue_v1(old.user_id,v_ref)->'entries') x
        where x->>'claim_id'=old.claim_id::text;
      if e is not null then v_states:=v_states||jsonb_build_object(v_ref,e); end if;
    end loop;
    v_rejoin:=cardinality(v_new)>0 and (v_new is distinct from v_old
      or (new.renewals is distinct from old.renewals
        and exists(select 1 from jsonb_each(v_states) j where j.value->>'state' in ('lapsed','out'))));
    for v_ref,e in select j.key,j.value from jsonb_each(v_states) j loop
      continue when e->>'state' not in ('head','lapsed');
      continue when new.status in ('ACTIVE','DRAINING') and v_ref=any(v_new) and not v_rejoin;
      insert into clued_private.work_claim_merge_queue_v1 as q(user_id,merge_ref,head_left_at,left_queued_at,left_claim_id)
        values(old.user_id,v_ref,
          case e->>'state' when 'head' then least(v_now,(e->>'until')::timestamptz)
            else greatest((e->>'until')::timestamptz,(e->>'since')::timestamptz) end,
          old.merge_queued_at,old.claim_id)
        on conflict (user_id,merge_ref) do update set
          head_left_at=greatest(q.head_left_at,excluded.head_left_at),
          left_queued_at=excluded.left_queued_at,left_claim_id=excluded.left_claim_id
          where (excluded.left_queued_at,excluded.left_claim_id)>(q.left_queued_at,q.left_claim_id);
    end loop;
  end if;
  if cardinality(v_new)=0 then
    new.merge_slot_at:=null;
    new.merge_queued_at:=null;
    new.merge_slot_taken_at:=null;
    new.merge_slot_ci_state:=null;
    new.merge_slot_ci_head:=null;
    new.merge_slot_ci_at:=null;
    new.merge_slot_hard_cap_seconds:=null;
  elsif tg_op='INSERT' or old.merge_queued_at is null or v_rejoin then
    new.merge_slot_at:=v_now;
    new.merge_queued_at:=v_now;
    new.merge_slot_taken_at:=v_now;
    new.merge_slot_ci_state:=null;
    new.merge_slot_ci_head:=null;
    new.merge_slot_ci_at:=null;
    new.merge_slot_hard_cap_seconds:=null;
  elsif new.renewals is distinct from old.renewals then
    new.merge_slot_at:=v_now;
  end if;
  return new;
end $$;

drop trigger work_claims_v1_merge_slot_stamp on clued_private.work_claims_v1;
create trigger work_claims_v1_merge_slot_stamp
  before insert or update of trigger_refs,renewals,merge_slot_at,status on clued_private.work_claims_v1
  for each row execute function clued_private.work_claim_merge_slot_stamp_v1();

-- What the head's CI reports say, or null: as 20261009010000, with taken_at
-- and the hard cap counted from when the claim became head.
create or replace function clued_private.work_claim_merge_slot_ci_view_v1(c clued_private.work_claims_v1) returns jsonb
language sql stable security definer set search_path='' as $$
  select (select jsonb_build_object('taken_at',(x.v->'head'->>'since')::timestamptz,
      'hard_cap_until',(x.v->'head'->>'since')::timestamptz+make_interval(secs=>c.merge_slot_hard_cap_seconds),
      'ci_state',c.merge_slot_ci_state,'ci_head_sha',c.merge_slot_ci_head,'ci_at',c.merge_slot_ci_at)
    from (select clued_private.work_claim_merge_queue_v1(c.user_id,r.ref) v
            from unnest(clued_private.work_claim_merge_refs_v1(c.trigger_refs)) r(ref)) x
    where x.v->'head'->>'claim_id'=c.claim_id::text
      and (x.v->'head'->>'until')::timestamptz>pg_catalog.clock_timestamp()
    limit 1)
  where c.merge_queued_at is not null and c.status in ('ACTIVE','DRAINING')
$$;

-- work_claim_conflicts: 20261006120000, except that merge refs never
-- conflict: a second claim with the same merge ref joins the queue.
create or replace function clued_private.work_claim_conflicts(
  p_user_id uuid,p_task_id uuid,p_write_set text[],p_triggers text[],p_exclude uuid
) returns jsonb language plpgsql stable set search_path='' as $$
declare v_out jsonb:='[]'::jsonb; c clued_private.work_claims_v1%rowtype;
  v_paths text[]; v_trig text[]; v_sibling boolean; v_same boolean;
  -- Copies of a Task in an open race never conflict with each other.
  v_open boolean:=p_task_id is not null
    and (clued_private.work_claim_open_race_v1(p_user_id,p_task_id)).task_id is not null;
begin
  for c in select * from clued_private.work_claims_v1 w
    where w.user_id=p_user_id and w.status in ('ACTIVE','DRAINING')
      and w.expires_at>pg_catalog.clock_timestamp()
      and (p_exclude is null or w.claim_id<>p_exclude)
    order by w.issued_at loop
    v_sibling:=v_open and c.task_id=p_task_id and c.copy_index is not null;
    v_same:=coalesce(c.task_id=p_task_id,false) and not v_sibling;
    v_paths:=case when v_sibling then '{}'::text[]
      else clued_private.work_claim_paths_overlap(c.write_set,p_write_set) end;
    select coalesce(array_agg(t order by t),'{}'::text[]) into v_trig
      from unnest(c.trigger_refs) t
      where t not like 'merge:%' and not v_sibling
        and exists(select 1 from unnest(p_triggers) n where clued_private.work_claim_triggers_match(t,n));
    if v_same or cardinality(v_paths)>0 or cardinality(v_trig)>0 then
      v_out:=v_out||jsonb_build_array(jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,
        'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
        'status',c.status,'fence',c.fence,'expires_at',c.expires_at,
        'overlap',jsonb_build_object('same_task',v_same,
          'paths',to_jsonb(v_paths),'trigger_refs',to_jsonb(v_trig))));
    end if;
  end loop;
  return v_out;
end $$;

-- work_claim_view: 20261009010000 plus merge_queue.
create or replace function clued_private.work_claim_view(c clued_private.work_claims_v1) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('claim_id',c.claim_id,'task_id',c.task_id,'context_key',c.context_key,
    'holder_binding_id',c.holder_binding_id,'holder_session_ref',c.holder_session_ref,
    'holder_label',c.holder_label,'holder_client',c.holder_client,'holder_session_title',c.holder_session_title,
    'base_commit',c.base_commit,'write_set',to_jsonb(c.write_set),'trigger_refs',to_jsonb(c.trigger_refs),
    'fence',c.fence,'lease_version',c.lease_version,'issued_at',c.issued_at,
    'expires_at',c.expires_at,'hard_deadline_at',c.hard_deadline_at,'renewals',c.renewals,
    'progress_ref',c.progress_ref,'budget',c.budget,'status',c.status,
    'released_outcome',c.released_outcome,'superseded_by',c.superseded_by,'receipt_id',c.receipt_id,
    'bound_pr',c.bound_pr,'copy_index',c.copy_index,'outcome',c.outcome,
    'lease_key_required',c.lease_key_required,
    'merge_slot_until',case when clued_private.work_claim_merge_slot_live_v1(c)
      then clued_private.work_claim_merge_slot_until_v1(c) end,
    'merge_slot_ci',clued_private.work_claim_merge_slot_ci_view_v1(c),
    'merge_queue',clued_private.work_claim_merge_queue_view_v1(c),
    'continued_from',c.continued_from)
$$;

-- The replaced functions keep their grants; the new helpers get none.
revoke all on function
  clued_private.work_claim_merge_slot_until_from_v1(clued_private.work_claims_v1,timestamptz),
  clued_private.work_claim_merge_queue_v1(uuid,text),
  clued_private.work_claim_merge_queue_view_v1(clued_private.work_claims_v1)
  from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
