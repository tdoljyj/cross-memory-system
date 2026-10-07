
alter table mtpe_m0.priority_item
 add constraint priority_item_criticality_values
 check (criticality is null or criticality in ('CRITICAL','HIGH','NORMAL','LOW'));
alter table mtpe_m0_test.priority_item
 add constraint priority_item_criticality_values
 check (criticality is null or criticality in ('CRITICAL','HIGH','NORMAL','LOW'));

create or replace function mtpe_m0.frontier_policy_allows(p_attributes jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog
as $$ select coalesce((p_attributes->>'policy_excluded')::boolean,false)=false
       and coalesce(p_attributes->>'required_gate_status','') <> 'FAILED' $$;
create or replace function mtpe_m0_test.frontier_policy_allows(p_attributes jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog
as $$ select coalesce((p_attributes->>'policy_excluded')::boolean,false)=false
       and coalesce(p_attributes->>'required_gate_status','') <> 'FAILED' $$;

create or replace function mtpe_m0.is_material_condition2(p_criticality text,p_attributes jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog
as $$ select p_criticality='CRITICAL'
       or (p_criticality is null and coalesce(p_attributes->>'priority','')='P0') $$;
create or replace function mtpe_m0_test.is_material_condition2(p_criticality text,p_attributes jsonb)
returns boolean language sql immutable security invoker set search_path=pg_catalog
as $$ select p_criticality='CRITICAL'
       or (p_criticality is null and coalesce(p_attributes->>'priority','')='P0') $$;

create or replace function mtpe_m0.compute_d3()
returns text language sql stable security invoker set search_path=pg_catalog,mtpe_m0
as $$ select encode(sha256(convert_to(string_agg(object_key||'|'||authority::text||'|'||currentness::text,e'\n'
 order by object_key collate "C"),'UTF8')),'hex') from mtpe_m0.registry_entry $$;
create or replace function mtpe_m0_test.compute_d3()
returns text language sql stable security invoker set search_path=pg_catalog,mtpe_m0_test
as $$ select encode(sha256(convert_to(string_agg(object_key||'|'||authority::text||'|'||currentness::text,e'\n'
 order by object_key collate "C"),'UTF8')),'hex') from mtpe_m0_test.registry_entry $$;

create table mtpe_m0.condition6_guard (
 id boolean primary key default true check(id),
 baseline_d3 text not null check(length(baseline_d3)=64),
 definition text not null,
 approved_event bigint not null,
 superset_proxy boolean not null default true check(superset_proxy),
 created_at timestamptz not null default now()
);
insert into mtpe_m0.condition6_guard(id,baseline_d3,definition,approved_event)
values(true,mtpe_m0.compute_d3(),
 'sha256(newline-joined object_key|authority|currentness ORDER BY object_key COLLATE C); any change is MAJOR; object_key/currentness changes are deliberate fail-closed superset',
 779);

create table mtpe_m0_test.condition6_guard (
 id boolean primary key default true check(id),
 baseline_d3 text not null check(length(baseline_d3)=64),
 definition text not null,
 approved_event bigint not null,
 superset_proxy boolean not null default true check(superset_proxy),
 created_at timestamptz not null default now()
);
insert into mtpe_m0_test.condition6_guard(id,baseline_d3,definition,approved_event)
values(true,mtpe_m0_test.compute_d3(),
 'test mirror of owner-approved D3 superset proxy',779);

create or replace function mtpe_m0.evaluate_condition6()
returns jsonb language sql stable security invoker set search_path=pg_catalog,mtpe_m0
as $$ select jsonb_build_object('baseline_d3',g.baseline_d3,'current_d3',mtpe_m0.compute_d3(),
 'changed',g.baseline_d3<>mtpe_m0.compute_d3(),'materiality',
 case when g.baseline_d3<>mtpe_m0.compute_d3() then 'MAJOR' else 'UNCHANGED' end,
 'superset_proxy',g.superset_proxy) from mtpe_m0.condition6_guard g where id $$;
create or replace function mtpe_m0_test.evaluate_condition6()
returns jsonb language sql stable security invoker set search_path=pg_catalog,mtpe_m0_test
as $$ select jsonb_build_object('baseline_d3',g.baseline_d3,'current_d3',mtpe_m0_test.compute_d3(),
 'changed',g.baseline_d3<>mtpe_m0_test.compute_d3(),'materiality',
 case when g.baseline_d3<>mtpe_m0_test.compute_d3() then 'MAJOR' else 'UNCHANGED' end,
 'superset_proxy',g.superset_proxy) from mtpe_m0_test.condition6_guard g where id $$;

create or replace function mtpe_m0.guard_condition6_d3_change()
returns trigger language plpgsql security invoker set search_path=pg_catalog,mtpe_m0 as $$
declare b text; c text;
begin
 select baseline_d3 into b from mtpe_m0.condition6_guard where id;
 c:=mtpe_m0.compute_d3();
 if b is distinct from c and not exists(
  select 1 from mtpe_m0.drift_record where status='OPEN'
   and kind='CONDITION6_D3_CHANGE' and detail->>'current_d3'=c)
 then
  insert into mtpe_m0.drift_record(kind,status,detail,back_reference)
  values('CONDITION6_D3_CHANGE','OPEN',
    jsonb_build_object('baseline_d3',b,'current_d3',c,'materiality','MAJOR',
      'superset_proxy',true,'automatic_application',false),
    'canonical_event:779#W8-D3');
 end if;
 return null;
end $$;
create trigger registry_entry_condition6_d3_guard
after insert or update or delete on mtpe_m0.registry_entry
for each statement execute function mtpe_m0.guard_condition6_d3_change();

create table mtpe_m0.standing_authority_carrier (
 authority_key text primary key,
 registry_object_key text not null references mtpe_m0.registry_entry(object_key) on update restrict on delete restrict,
 rule_text text not null,
 prohibited_inference text not null,
 approved_event bigint not null,
 evidence_ref text not null check(length(btrim(evidence_ref))>0),
 created_at timestamptz not null default now()
);

create table mtpe_m0.legacy_reconciliation (
 legacy_key text primary key,
 display_name text not null,
 currentness_check text not null,
 absorption_check text not null,
 independent_value_check text not null,
 upstream_change_check text not null,
 recovery_point text not null,
 disposition text not null check(disposition in ('RESUME','REBASE','MERGE','SUPERSEDE','KEEP_DEFERRED')),
 authority_effect text not null default 'GOVERNANCE_RECONCILIATION_RULE_ONLY'
  check(authority_effect='GOVERNANCE_RECONCILIATION_RULE_ONLY'),
 auto_start boolean not null default false check(not auto_start),
 inherits_priority boolean not null default false check(not inherits_priority),
 grants_execution_authority boolean not null default false check(not grants_execution_authority),
 approved_event bigint not null,
 evidence_ref text not null check(length(btrim(evidence_ref))>0),
 created_at timestamptz not null default now()
);

revoke all on mtpe_m0.condition6_guard,mtpe_m0.standing_authority_carrier,
 mtpe_m0.legacy_reconciliation from public,anon,authenticated;
revoke all on function mtpe_m0.frontier_policy_allows(jsonb),
 mtpe_m0.is_material_condition2(text,jsonb),mtpe_m0.compute_d3(),
 mtpe_m0.evaluate_condition6() from public,anon,authenticated;
grant select on mtpe_m0.condition6_guard,mtpe_m0.standing_authority_carrier,
 mtpe_m0.legacy_reconciliation to mtpe_m0_test_role;
grant execute on function mtpe_m0_test.frontier_policy_allows(jsonb),
 mtpe_m0_test.is_material_condition2(text,jsonb),mtpe_m0_test.compute_d3(),
 mtpe_m0_test.evaluate_condition6() to mtpe_m0_test_role;
