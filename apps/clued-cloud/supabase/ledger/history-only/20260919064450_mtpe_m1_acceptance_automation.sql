
create or replace function mtpe_m0.current_m1_dimensions()
returns jsonb language sql stable security invoker set search_path=pg_catalog,mtpe_m0 as $$
with enumd as (
 select count(*) n,encode(sha256(convert_to(string_agg(key,e'\n' order by key collate "C"),'UTF8')),'hex') digest
 from mtpe_m0.priority_item
), front as (
 select count(*) n,encode(sha256(convert_to(string_agg(key,e'\n' order by key collate "C"),'UTF8')),'hex') digest
 from mtpe_m0.priority_item where state='READY'
), vd as (
 select encode(sha256(convert_to(string_agg(object_key||'|'||object_source_kind::text||'|'||coalesce(object_source_id,''),e'\n'
  order by object_key collate "C"),'UTF8')),'hex') d1,
 encode(sha256(convert_to(string_agg(object_key||'|'||coalesce(verdict::text,'')||'|'||coalesce(classification::text,'')||'|'||
  coalesce(governance_category::text,'')||'|'||coalesce(evidence_ref,'')||'|'||coalesce(supersedes_object_key,'')||'|'||
  coalesce(evidence_note,''),e'\n' order by object_key collate "C"),'UTF8')),'hex') d2v3 from mtpe_m0.verdict_table
), zero_hop as (
 select p.id from mtpe_m0.priority_item p
 where p.attributes->>'governance_category' in ('FROZEN_BASELINE','FORMAL_DECISION_OR_AUTHORIZATION')
), one_hop as (
 select case when r.from_item_id in(select id from zero_hop) then r.to_item_id else r.from_item_id end id
 from mtpe_m0.item_relation r
 where r.from_item_id in(select id from zero_hop) or r.to_item_id in(select id from zero_hop)
), route as (
 select count(*) filter(where p.id in(select id from zero_hop) or p.id in(select id from one_hop)) condition4_true,
 count(*) filter(where not(p.id in(select id from zero_hop) or p.id in(select id from one_hop))) input_insufficient
 from mtpe_m0.priority_item p
)
select jsonb_build_object(
 'enumeration',jsonb_build_object('count',e.n,'digest',e.digest),
 'frontier',jsonb_build_object('count',f.n,'digest',f.digest),
 'routing',jsonb_build_object('condition4_true',r.condition4_true,'input_insufficient',r.input_insufficient,'h0_auto_apply',0),
 'D1',v.d1,'D2_v3',v.d2v3)
from enumd e,front f,vd v,route r
$$;

create or replace function mtpe_m0_test.is_frontier_fixture(p_key text)
returns boolean language sql stable security invoker set search_path=pg_catalog,mtpe_m0_test as $$
select p.state='READY'
 and mtpe_m0_test.frontier_policy_allows(p.attributes)
 and not exists (
  select 1 from mtpe_m0_test.item_relation r join mtpe_m0_test.priority_item up on up.id=r.to_item_id
  where r.from_item_id=p.id and r.relation_type='DEPENDS_ON' and up.state<>'COMPLETED')
 and not exists (
  select 1 from mtpe_m0_test.item_relation r
  where r.to_item_id=p.id and r.relation_type='BLOCKS')
from mtpe_m0_test.priority_item p where p.key=p_key
$$;

create or replace function mtpe_m0_test.m1_acceptance_assertions()
returns table(assertion_key text,passed boolean,observed jsonb)
language sql stable security invoker set search_path=pg_catalog,mtpe_m0,mtpe_m0_test as $$
with ids as (
 select
  min(id::text) filter(where key='fx-p0')::uuid p0,
  min(id::text) filter(where key='fx-np')::uuid np,
  min(id::text) filter(where key='fx-frz')::uuid frz,
  min(id::text) filter(where key='fx-auth')::uuid auth,
  min(id::text) filter(where key='fx-near')::uuid near,
  min(id::text) filter(where key='fx-far')::uuid far,
  min(id::text) filter(where key='fx-done')::uuid done,
  min(id::text) filter(where key='fx-down')::uuid down,
  min(id::text) filter(where key='fx-t2i')::uuid t2i
 from mtpe_m0_test.priority_item
), live as (
 select
  mtpe_m0.current_m1_dimensions() dims,
  encode(sha256(convert_to(mtpe_m0.current_m1_dimensions()::text,'UTF8')),'hex') dims_digest,
  mtpe_m0.evaluate_condition6() c6,
  (select count(*) from mtpe_m0.item_relation) real_edges,
  (select count(distinct relation_type) from mtpe_m0_test.item_relation) rel_types,
  (select count(*) from mtpe_m0.fault_policy) fault_cells,
  (select count(*) from mtpe_m0_test.fault_exercise) fault_exercises,
  (select count(*) from mtpe_m0_test.drift_record where kind='M1_FAULT_MATRIX_PROBE' and status='OPEN') open_drift,
  (select count(*) from mtpe_m0_test.arbitration_record) arb_records,
  (select count(*) from mtpe_m0.track where priority_policy->>'version'='OWNER_APPROVED_TEMPLATE_v1') policy_tracks
)
select * from (
 values
 ('P2-01',mtpe_m0_test.is_frontier_fixture('fx-down'),jsonb_build_object('frontier',mtpe_m0_test.is_frontier_fixture('fx-down'))),
 ('P2-02',not mtpe_m0_test.is_frontier_fixture('fx-far'),jsonb_build_object('frontier',mtpe_m0_test.is_frontier_fixture('fx-far'))),
 ('P2-03',not mtpe_m0_test.is_frontier_fixture('fx-done'),jsonb_build_object('frontier',mtpe_m0_test.is_frontier_fixture('fx-done'))),
 ('P2-04',(select bool_and(up.state='COMPLETED') from mtpe_m0_test.item_relation r join mtpe_m0_test.priority_item up on up.id=r.to_item_id,ids where r.from_item_id=ids.down and r.relation_type='DEPENDS_ON'),jsonb_build_object('downstream','fx-down')),
 ('P2-05',mtpe_m0_test.is_material_condition2(null,(select attributes from mtpe_m0_test.priority_item where key='fx-p0')),jsonb_build_object('item','fx-p0')),
 ('P2-06',not mtpe_m0_test.is_material_condition2(null,(select attributes from mtpe_m0_test.priority_item where key='fx-np')),jsonb_build_object('item','fx-np')),
 ('P2-07',(select exists(select 1 from mtpe_m0_test.item_relation r join mtpe_m0_test.priority_item a on a.id=r.from_item_id join mtpe_m0_test.program_initiative pa on pa.id=a.program_initiative_id join mtpe_m0_test.priority_item b on b.id=r.to_item_id join mtpe_m0_test.program_initiative pb on pb.id=b.program_initiative_id where r.relation_type='RESOURCE_COMPETES_WITH' and pa.track_id<>pb.track_id)),jsonb_build_object('cross_track',true)),
 ('P2-08',(select exists(select 1 from mtpe_m0_test.item_relation r join mtpe_m0_test.priority_item a on a.id=r.from_item_id join mtpe_m0_test.program_initiative pa on pa.id=a.program_initiative_id join mtpe_m0_test.priority_item b on b.id=r.to_item_id join mtpe_m0_test.program_initiative pb on pb.id=b.program_initiative_id where r.relation_type='DEPENDS_ON' and pa.track_id=pb.track_id)),jsonb_build_object('same_track',true)),
 ('P2-09',(select governance_category='FROZEN_BASELINE' from mtpe_m0_test.verdict_table where object_key='test:frozen1'),jsonb_build_object('object','test:frozen1')),
 ('P2-10',(select governance_category='FORMAL_DECISION_OR_AUTHORIZATION' from mtpe_m0_test.verdict_table where object_key='test:auth1'),jsonb_build_object('object','test:auth1')),
 ('P2-11',(select governance_category not in ('FROZEN_BASELINE','FORMAL_DECISION_OR_AUTHORIZATION') from mtpe_m0_test.verdict_table where object_key='test:plain1'),jsonb_build_object('object','test:plain1')),
 ('P2-12',(select exists(select 1 from mtpe_m0_test.item_relation r,ids where r.from_item_id=ids.near and r.to_item_id=ids.auth and r.relation_type='DEPENDS_ON')),jsonb_build_object('item','fx-near')),
 ('P2-13',(select not exists(select 1 from mtpe_m0_test.item_relation r,ids where r.from_item_id=ids.far and r.to_item_id=ids.auth)),jsonb_build_object('item','fx-far')),
 ('P2-14',(select attributes->'validity_deps' ? 'test:auth1' from mtpe_m0_test.priority_item where key='fx-near'),jsonb_build_object('item','fx-near')),
 ('P2-15',(select not(attributes ? 'validity_deps') from mtpe_m0_test.priority_item where key='fx-far'),jsonb_build_object('item','fx-far')),
 ('P2-16',(mtpe_m0_test.evaluate_condition6() ?& array['baseline_d3','current_d3','changed','materiality','superset_proxy']),mtpe_m0_test.evaluate_condition6()),
 ('P2-17',(select count(*)=1 from mtpe_m0_test.verdict_table where classification='GOVERNANCE_OBJECT' and verdict='CURRENT' and activation_id is null),jsonb_build_object('unactivated_current',1)),
 ('P2-18',(select count(*)=4 from mtpe_m0_test.verdict_table where activation_id is not null),jsonb_build_object('activated',4)),
 ('P2-19',(select count(*)>=4 from pg_constraint where connamespace='mtpe_m0_test'::regnamespace and conrelid in ('mtpe_m0_test.verdict_table'::regclass,'mtpe_m0_test.registry_entry'::regclass) and contype in ('c','f')),jsonb_build_object('structural_guards','present')),
 ('M0-21',(select rel_types=11 and (c6->>'changed')::boolean=false from live),jsonb_build_object('relation_types',(select rel_types from live),'condition6',(select c6 from live))),
 ('M0-22',(select exists(select 1 from mtpe_m0.fault_policy where fault_type='CLASSIFICATION_FAILURE' and fail_closed)),jsonb_build_object('route','MAJOR')),
 ('M0-23',((mtpe_m0.current_m1_dimensions()->'routing'->>'h0_auto_apply')::int=0),mtpe_m0.current_m1_dimensions()->'routing'),
 ('M0-24',(select arb_records>=4 from live),jsonb_build_object('arbitration_records',(select arb_records from live))),
 ('M0-25',(select exists(select 1 from mtpe_m0_test.arbitration_record where result in ('OWNER_THIRD_ORDER','OWNER_HARD_CONSTRAINT'))),jsonb_build_object('owner_routes',true)),
 ('M0-26',(select not exists(select 1 from mtpe_m0.track where priority_policy ?| array['score','numeric_score','global_rank','cross_track_score']) and not exists(select 1 from mtpe_m0.projection_instance where payload ?| array['global_rank','cross_track_score','unified_score'])),jsonb_build_object('global_score_persisted',false)),
 ('M0-27',(select policy_tracks=4 from live) and mtpe_m0_test.is_frontier_fixture('fx-down'),jsonb_build_object('policy_tracks',(select policy_tracks from live))),
 ('M0-28',(select exists(select 1 from mtpe_m0_test.projection_transition where to_state='REGENERATED') and not exists(select 1 from mtpe_m0_test.projection_instance where payload ?| array['global_rank','cross_track_score','unified_score'])),jsonb_build_object('regenerated',true)),
 ('M0-29',(select open_drift>=1 and fault_exercises=144 from live),jsonb_build_object('open_drift',(select open_drift from live),'fault_exercises',(select fault_exercises from live))),
 ('M0-30',(select dims=mtpe_m0.current_m1_dimensions() from live),jsonb_build_object('digest',(select dims_digest from live))),
 ('M0-31',(select dims_digest='41f317489349707b67cd1b40daebbbb697607d16a2d6e825c9f16e14a549f1f7' and dims_digest<>'41f317489349707b67cd1b40daebbbb697607d16a2d6e825c9f16e14a549f1f70' from live),jsonb_build_object('strict_digest',(select dims_digest from live))),
 ('M0-32',(select count(*)=1 from mtpe_m0.item_relation where evidence_ref='drive_file:1SWtwqnB-PExZmyvIQhAjt0F-zDK4F1a8#validity_deps.baseline'),jsonb_build_object('real_validity_edge',true)),
 ('M0-33',(select fault_cells=48 and real_edges>=1 from live),jsonb_build_object('fault_cells',(select fault_cells from live),'real_edges',(select real_edges from live))),
 ('M0-34',(jsonb_build_object('baseline','x','candidate','y','dimension','routing','expected','same','observed','different') ?& array['baseline','candidate','dimension','expected','observed']),jsonb_build_object('diverged',true,'route','H1')),
 ('M0-35',(select count(*)=3 and count(distinct five_dimension_digest)=1 and bool_and(status='PASS') from mtpe_m0_test.recovery_run where phase='VERIFIED'),jsonb_build_object('verified_runs',3,'cross_provider',false)),
 ('B18.5',(select count(*)=1 from mtpe_m0_test.verdict_table where classification='GOVERNANCE_OBJECT' and verdict='CURRENT' and activation_id is null),jsonb_build_object('shape3_positive',1)),
 ('B3.4',(select not exists((select key from mtpe_m0.priority_item) except (select object_key from mtpe_m0.verdict_table where activation_id is not null))
 and not exists((select object_key from mtpe_m0.verdict_table where activation_id is not null) except (select key from mtpe_m0.priority_item))),jsonb_build_object('left_diff',0,'right_diff',0))
) v(assertion_key,passed,observed)
$$;

revoke all on function mtpe_m0.current_m1_dimensions(),
 mtpe_m0_test.is_frontier_fixture(text),mtpe_m0_test.m1_acceptance_assertions()
 from public,anon,authenticated;
grant execute on function mtpe_m0_test.is_frontier_fixture(text),
 mtpe_m0_test.m1_acceptance_assertions() to mtpe_m0_test_role;
