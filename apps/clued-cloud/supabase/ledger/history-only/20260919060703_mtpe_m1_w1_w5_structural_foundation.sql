
-- MTPE M1 W1-W5 structural foundation. Approved by canonical Event 776 and
-- explicitly started by the Owner on 2026-09-19.
alter table mtpe_m0.item_relation
  drop constraint if exists item_relation_m0_implemented_only;
alter table mtpe_m0_test.item_relation
  drop constraint if exists item_relation_m0_implemented_only;

alter table mtpe_m0.item_relation add column if not exists evidence_ref text;
alter table mtpe_m0_test.item_relation add column if not exists evidence_ref text;
update mtpe_m0_test.item_relation
   set evidence_ref = 'fixture:m0-preexisting/' || id::text
 where evidence_ref is null;
alter table mtpe_m0.item_relation alter column evidence_ref set not null;
alter table mtpe_m0_test.item_relation alter column evidence_ref set not null;
alter table mtpe_m0.item_relation
  add constraint item_relation_evidence_ref_nonempty check (length(btrim(evidence_ref)) > 0);
alter table mtpe_m0_test.item_relation
  add constraint item_relation_evidence_ref_nonempty check (length(btrim(evidence_ref)) > 0);

create table mtpe_m0.arbitration_record (
  id uuid primary key default gen_random_uuid(),
  candidate_a_id uuid not null references mtpe_m0.priority_item(id) on delete restrict,
  candidate_b_id uuid not null references mtpe_m0.priority_item(id) on delete restrict,
  sequence text not null check (sequence in ('SECOND_ORDER','THIRD_ORDER_OWNER','HARD_CONSTRAINT_OWNER')),
  comparison_basis jsonb not null,
  result text not null check (result in ('A_DOMINATES','B_DOMINATES','OWNER_THIRD_ORDER','OWNER_HARD_CONSTRAINT')),
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  created_at timestamptz not null default now(),
  check (candidate_a_id <> candidate_b_id),
  check (not (comparison_basis ?| array['score','numeric_score','global_rank','cross_track_score']))
);
create index arbitration_record_candidates_idx on mtpe_m0.arbitration_record(candidate_a_id,candidate_b_id);

create table mtpe_m0_test.arbitration_record (
  id uuid primary key default gen_random_uuid(),
  candidate_a_id uuid not null references mtpe_m0_test.priority_item(id) on delete cascade,
  candidate_b_id uuid not null references mtpe_m0_test.priority_item(id) on delete cascade,
  sequence text not null check (sequence in ('SECOND_ORDER','THIRD_ORDER_OWNER','HARD_CONSTRAINT_OWNER')),
  comparison_basis jsonb not null,
  result text not null check (result in ('A_DOMINATES','B_DOMINATES','OWNER_THIRD_ORDER','OWNER_HARD_CONSTRAINT')),
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  created_at timestamptz not null default now(),
  check (candidate_a_id <> candidate_b_id),
  check (not (comparison_basis ?| array['score','numeric_score','global_rank','cross_track_score']))
);
create index arbitration_record_candidates_idx on mtpe_m0_test.arbitration_record(candidate_a_id,candidate_b_id);

create or replace function mtpe_m0.evaluate_second_order_unlock(
  p_candidate_a uuid, p_candidate_b uuid, p_evidence_ref text, p_hard_constraint boolean default false
) returns text language plpgsql security invoker set search_path = pg_catalog, mtpe_m0 as $$
declare
  a_set uuid[];
  b_set uuid[];
  v_result text;
  v_sequence text;
begin
  if p_candidate_a = p_candidate_b or length(btrim(coalesce(p_evidence_ref,''))) = 0 then
    raise exception 'invalid arbitration input';
  end if;
  with recursive reach(root,node,path) as (
    select r.from_item_id, r.to_item_id, array[r.from_item_id,r.to_item_id]
      from mtpe_m0.item_relation r
     where r.relation_type::text in ('BLOCKS','UNLOCKS','DEPENDS_ON')
       and r.from_item_id in (p_candidate_a,p_candidate_b)
    union all
    select x.root,r.to_item_id,x.path||r.to_item_id
      from reach x join mtpe_m0.item_relation r on r.from_item_id=x.node
     where r.relation_type::text in ('BLOCKS','UNLOCKS','DEPENDS_ON')
       and not r.to_item_id=any(x.path)
  )
  select coalesce(array_agg(distinct node order by node) filter(where root=p_candidate_a),'{}'::uuid[]),
         coalesce(array_agg(distinct node order by node) filter(where root=p_candidate_b),'{}'::uuid[])
    into a_set,b_set from reach;
  if p_hard_constraint then v_result:='OWNER_HARD_CONSTRAINT'; v_sequence:='HARD_CONSTRAINT_OWNER';
  elsif b_set <@ a_set and a_set <> b_set then v_result:='A_DOMINATES'; v_sequence:='SECOND_ORDER';
  elsif a_set <@ b_set and a_set <> b_set then v_result:='B_DOMINATES'; v_sequence:='SECOND_ORDER';
  else v_result:='OWNER_THIRD_ORDER'; v_sequence:='THIRD_ORDER_OWNER';
  end if;
  insert into mtpe_m0.arbitration_record(candidate_a_id,candidate_b_id,sequence,comparison_basis,result,evidence_ref)
  values(p_candidate_a,p_candidate_b,v_sequence,
    jsonb_build_object('relation_types',jsonb_build_array('BLOCKS','UNLOCKS','DEPENDS_ON'),
                       'candidate_a_unlocked',to_jsonb(a_set),
                       'candidate_b_unlocked',to_jsonb(b_set),
                       'strict_set_dominance',true),
    v_result,p_evidence_ref);
  return v_result;
end $$;

create or replace function mtpe_m0_test.evaluate_second_order_unlock(
  p_candidate_a uuid, p_candidate_b uuid, p_evidence_ref text, p_hard_constraint boolean default false
) returns text language plpgsql security invoker set search_path = pg_catalog, mtpe_m0_test as $$
declare
  a_set uuid[];
  b_set uuid[];
  v_result text;
  v_sequence text;
begin
  if p_candidate_a = p_candidate_b or length(btrim(coalesce(p_evidence_ref,''))) = 0 then
    raise exception 'invalid arbitration input';
  end if;
  with recursive reach(root,node,path) as (
    select r.from_item_id, r.to_item_id, array[r.from_item_id,r.to_item_id]
      from mtpe_m0_test.item_relation r
     where r.relation_type::text in ('BLOCKS','UNLOCKS','DEPENDS_ON')
       and r.from_item_id in (p_candidate_a,p_candidate_b)
    union all
    select x.root,r.to_item_id,x.path||r.to_item_id
      from reach x join mtpe_m0_test.item_relation r on r.from_item_id=x.node
     where r.relation_type::text in ('BLOCKS','UNLOCKS','DEPENDS_ON')
       and not r.to_item_id=any(x.path)
  )
  select coalesce(array_agg(distinct node order by node) filter(where root=p_candidate_a),'{}'::uuid[]),
         coalesce(array_agg(distinct node order by node) filter(where root=p_candidate_b),'{}'::uuid[])
    into a_set,b_set from reach;
  if p_hard_constraint then v_result:='OWNER_HARD_CONSTRAINT'; v_sequence:='HARD_CONSTRAINT_OWNER';
  elsif b_set <@ a_set and a_set <> b_set then v_result:='A_DOMINATES'; v_sequence:='SECOND_ORDER';
  elsif a_set <@ b_set and a_set <> b_set then v_result:='B_DOMINATES'; v_sequence:='SECOND_ORDER';
  else v_result:='OWNER_THIRD_ORDER'; v_sequence:='THIRD_ORDER_OWNER';
  end if;
  insert into mtpe_m0_test.arbitration_record(candidate_a_id,candidate_b_id,sequence,comparison_basis,result,evidence_ref)
  values(p_candidate_a,p_candidate_b,v_sequence,
    jsonb_build_object('relation_types',jsonb_build_array('BLOCKS','UNLOCKS','DEPENDS_ON'),
                       'candidate_a_unlocked',to_jsonb(a_set),
                       'candidate_b_unlocked',to_jsonb(b_set),
                       'strict_set_dominance',true),
    v_result,p_evidence_ref);
  return v_result;
end $$;

create table mtpe_m0.fault_policy (
  fault_type text not null,
  action_surface text not null check (action_surface in ('DETECT','DECIDE','APPLY','RECOVER')),
  fail_closed boolean not null default true check (fail_closed),
  expected_action text not null check (length(btrim(expected_action)) > 0),
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  primary key(fault_type,action_surface)
);
create table mtpe_m0_test.fault_exercise (
  id uuid primary key default gen_random_uuid(),
  fault_type text not null,
  action_surface text not null check (action_surface in ('DETECT','DECIDE','APPLY','RECOVER')),
  observed_action text not null,
  fail_closed boolean not null check (fail_closed),
  lkg_preserved boolean not null,
  drift_opened boolean not null,
  run_no smallint not null check (run_no between 1 and 3),
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  created_at timestamptz not null default now()
);

create table mtpe_m0.projection_instance (
  id uuid primary key default gen_random_uuid(),
  projection_key text not null unique,
  state text not null check (state in ('INVALIDATED','GENERATED','REGENERATED','REVOKED')),
  source_digest text not null check (length(btrim(source_digest)) > 0),
  projection_digest text,
  payload jsonb not null default '{}'::jsonb,
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  updated_at timestamptz not null default now(),
  check (not (payload ?| array['global_rank','cross_track_score','unified_score']))
);
create table mtpe_m0.projection_transition (
  id uuid primary key default gen_random_uuid(),
  projection_id uuid not null references mtpe_m0.projection_instance(id) on delete restrict,
  from_state text,
  to_state text not null,
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  created_at timestamptz not null default now()
);
create index projection_transition_projection_idx on mtpe_m0.projection_transition(projection_id);

create table mtpe_m0.thin_skill_lifecycle (
  id uuid primary key default gen_random_uuid(),
  skill_key text not null unique,
  state text not null check (state in ('DRAFT','INSTALLED','UPDATED','REPAIRED','REAUTHORIZED','VERIFIED','REVOKED')),
  lifecycle_digest text not null check (length(btrim(lifecycle_digest)) > 0),
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  updated_at timestamptz not null default now()
);
create table mtpe_m0.thin_skill_transition (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references mtpe_m0.thin_skill_lifecycle(id) on delete restrict,
  operation text not null check (operation in ('INSTALL','UPDATE','REPAIR','REAUTHORIZE','VERIFY','REVOKE','STATUS')),
  from_state text,
  to_state text not null,
  success boolean not null,
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  created_at timestamptz not null default now()
);
create index thin_skill_transition_skill_idx on mtpe_m0.thin_skill_transition(skill_id);

create table mtpe_m0_test.recovery_run (
  id uuid primary key default gen_random_uuid(),
  run_no smallint not null check (run_no between 1 and 3),
  phase text not null check (phase in ('STARTED','INTERRUPTED','RESUMED','REPLAYED','VERIFIED')),
  five_dimension_digest text not null check (length(five_dimension_digest)=64),
  assertion_digest text not null check (length(assertion_digest)=64),
  status text not null check (status in ('OPEN','PASS','FAIL')),
  evidence_ref text not null check (length(btrim(evidence_ref)) > 0),
  created_at timestamptz not null default now(),
  unique(run_no,phase)
);

revoke all on mtpe_m0.arbitration_record, mtpe_m0.fault_policy,
  mtpe_m0.projection_instance, mtpe_m0.projection_transition,
  mtpe_m0.thin_skill_lifecycle, mtpe_m0.thin_skill_transition from public, anon, authenticated;
revoke all on mtpe_m0_test.arbitration_record, mtpe_m0_test.fault_exercise,
  mtpe_m0_test.recovery_run from public, anon, authenticated;
revoke all on function mtpe_m0.evaluate_second_order_unlock(uuid,uuid,text,boolean) from public, anon, authenticated;
revoke all on function mtpe_m0_test.evaluate_second_order_unlock(uuid,uuid,text,boolean) from public, anon, authenticated;
grant select on mtpe_m0.arbitration_record, mtpe_m0.fault_policy,
  mtpe_m0.projection_instance, mtpe_m0.projection_transition,
  mtpe_m0.thin_skill_lifecycle, mtpe_m0.thin_skill_transition to mtpe_m0_test_role;
grant select,insert,update,delete on mtpe_m0_test.arbitration_record,
  mtpe_m0_test.fault_exercise, mtpe_m0_test.recovery_run to mtpe_m0_test_role;
grant execute on function mtpe_m0_test.evaluate_second_order_unlock(uuid,uuid,text,boolean) to mtpe_m0_test_role;
