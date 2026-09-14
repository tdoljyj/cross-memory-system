-- Stage2C Root9 live preflight. READ ONLY; emits exactly one JSON object.
-- Run through run-stage2c.sh. This file never reserves budget or mutates state.
begin transaction read only isolation level repeatable read;

with
k as (
  select
    'ctr_414bd3c724264a83894b0c55cf2ab878'::text root_id,
    'ctrgen_b060bc520329398936e461af6a477f94'::text root8,
    'ctrgen_308a1dfc185cff633892638581e0a34c'::text root9,
    'sb_9f790cbeb45430e8cb368ab47d30afb4'::text old_binding_id,
    'sb_201178b7a8111000d515f7f26a75a28b'::text new_binding_id,
    '5a43eb7f5afe213c83a829599e2c69de4d58365a7b8124f3ccb335b7601654a0'::text old_binding_sha,
    '373dc972af34bd584dc0b45b1938261e809635e2ff904a45fe72892796891a7e'::text old_controller_sha,
    'ff449c61c38fd928c6472fbc02616fdee51485f1cca72644d697a9bacfaa9825'::text old_qualification_sha,
    '6cdae0f2865409b6d6721f607ebd35008952fcb40857207c5b1d291299aebf08'::text old_acceptance_sha,
    '2026-09-14T03:00:00Z'::timestamptz not_before,
    '2026-09-15T03:00:00Z'::timestamptz expires_at
),
head as (select h.* from clued_control.current_head h,k where h.root_id=k.root_id),
cur as (select c.* from clued_control.execution_current c,k where c.root_id=k.root_id),
effective_binding as (select to_jsonb(b) body from clued_control.effective_execution_binding() b),
effective_window as (select to_jsonb(w) body from clued_control.effective_execution_window() w),
counts as (
 select
  (select count(*) from clued_control.events e,k where e.root_id=k.root_id) root_events,
  (select count(*) from clued_control.execution_events e,k where e.root_id=k.root_id) execution_events,
  (select count(*) from clued_control.gate_attempts a,k where a.root_id=k.root_id) attempts,
  (select count(*) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence>44 and e.request->>'operation'='BUDGET_RESERVED') allocations,
  (select count(*) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence>44 and e.request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') forwards,
  (select count(*) from clued_control.successor_binding s,k where s.root_id=k.root_id) successors,
  (select count(*) from clued_control.control_objects o,k where o.root_id=k.root_id and o.object_type='StatusManifest' and o.generation=26) status26,
  (select count(*) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence>=98) exec_after97,
  (select count(*) from clued_control.events e,k where e.root_id=k.root_id and e.sequence>=9) root_after8
),
snapshot as (
 select jsonb_build_object(
  'root_events_1_8_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(e) order by e.sequence) from clued_control.events e,k where e.root_id=k.root_id and e.sequence between 1 and 8),'[]'::jsonb)::text,'UTF8')),'hex'),
  'execution_events_1_97_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(e) order by e.sequence) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence between 1 and 97),'[]'::jsonb)::text,'UTF8')),'hex'),
  'gate_attempts_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(a) order by a.ga_id) from clued_control.gate_attempts a,k where a.root_id=k.root_id),'[]'::jsonb)::text,'UTF8')),'hex'),
  'accepted_binding_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(a) order by a.root_id) from clued_control.accepted_binding a,k where a.root_id=k.root_id),'[]'::jsonb)::text,'UTF8')),'hex'),
  'old_successor_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(s) order by s.binding_id) from clued_control.successor_binding s,k where s.root_id=k.root_id and s.binding_id=k.old_binding_id),'[]'::jsonb)::text,'UTF8')),'hex'),
  'control_objects_through_25_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(o) order by o.object_type,o.generation,o.uri) from clued_control.control_objects o,k where o.root_id=k.root_id and not (o.object_type='StatusManifest' and o.generation>=26)),'[]'::jsonb)::text,'UTF8')),'hex'),
  'gate_attempt_count',c.attempts,
  'allocation_count',c.allocations,
  'forward_count',c.forwards,
  'charged_seconds',(select charged_seconds from cur),
  'charged_evidence_bytes',(select charged_evidence_bytes from cur),
  'routine_acl_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(x) order by x.specific_name,x.grantee,x.privilege_type) from (select specific_name,grantee,privilege_type,is_grantable from information_schema.routine_privileges where specific_schema='clued_control' and routine_name not in ('read_root','reserve_execution_budget','reserve_gate','install_root9_successor_v1')) x),'[]'::jsonb)::text,'UTF8')),'hex'),
  'table_acl_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(x) order by x.table_name,x.grantee,x.privilege_type) from (select table_name,grantee,privilege_type,is_grantable from information_schema.table_privileges where table_schema='clued_control') x),'[]'::jsonb)::text,'UTF8')),'hex'),
  'non_target_function_defs_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_control' and p.proname not in ('read_root','reserve_execution_budget','reserve_gate','install_root9_successor_v1')),'[]'::jsonb)::text,'UTF8')),'hex'),
  'non_target_constraints_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid,true)) order by c.conrelid::regclass::text,c.conname) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='clued_control' and c.conname<>'successor_binding_predecessor_generation_id_check'),'[]'::jsonb)::text,'UTF8')),'hex')
 ) body from counts c
),
checks as (
 select jsonb_build_object(
  'transaction_is_read_only',current_setting('transaction_read_only')='on',
  'inside_root9_window',clock_timestamp()>=k.not_before and clock_timestamp()<k.expires_at,
  'root_exact_preimage',(select count(*)=1 and min(sequence)=8 and min(generation_id)=k.root8 and not bool_or(revoked) from head),
  'execution_exact_preimage',(select count(*)=1 and min(sequence)=97 and min(charged_seconds)=10506 and min(charged_evidence_bytes)=2335812531 and bool_and(pending_budget_sequence is null) and bool_and(active_ga_id is null) from cur),
  'append_only_counts_exact',c.root_events=8 and c.execution_events=97 and c.attempts=14,
  'unique_budget_untouched',c.allocations=9 and c.forwards=17,
  'no_postimage_exists',c.root_after8=0 and c.exec_after97=0 and c.status26=0,
  'only_root8_successor_exists',c.successors=1 and exists(select 1 from clued_control.successor_binding s where s.binding_id=k.old_binding_id and s.root_id=k.root_id and s.generation_id=k.root8 and s.binding_sha256=k.old_binding_sha),
  'root9_successor_absent',not exists(select 1 from clued_control.successor_binding s where s.binding_id=k.new_binding_id or s.generation_id=k.root9),
  'status25_preserved',exists(select 1 from clued_control.control_objects o where o.root_id=k.root_id and o.object_type='StatusManifest' and o.generation=25 and o.sha256='439233de96022d9963e5266962833d88a2f2fda022fae7a9d5444c9dd7266ad6'),
  'repair_refs_8_exact',(select e.request->'body'->'evidence'->'required_repair_refs' from clued_control.execution_events e where e.root_id=k.root_id and e.sequence=96) =
    '[{"ga_id":"ga_04377008dc04437d9ee9d28a3c79ff3a","receipt_sha256":"b27286d6fcb54e34a62d8738f49c1ecafe3210c9a321a703c3828e38497e434c","budget_sequence":46},{"ga_id":"ga_4e7ce4ad385e4f5aa633bcea2ddb71ce","receipt_sha256":"2fd3b68be76b3f4efcf10050d6c908bcb79c8d5a3e22290e18f582d780b53b7e","budget_sequence":51},{"ga_id":"ga_1d52f4778d494399b12aea54fe4a189e","receipt_sha256":"3a311d678ed563d5dd1492ef53675fcba8e985dccf3880d032ca2029168fedf9","budget_sequence":59},{"ga_id":"ga_6abb193a56304029a788f7cb624a0d35","receipt_sha256":"0bd435f4fd4bb9c4174a1d96b132908f128ceadcfa51021ba1871757ed16df77","budget_sequence":68},{"ga_id":"ga_71a1d946fca34c1e9e700c80a546b3ad","receipt_sha256":"90955f5c896d8a76f65458fe36bff5d321b2d3d92d1ed10f1857f8628cb83bed","budget_sequence":73},{"ga_id":"ga_41643fece183424daf7f05b8b2868f8e","receipt_sha256":"9a75bf4694d1584a51adbeb7c2497da62f6266e2654da9e0189ff2a43a87a0be","budget_sequence":77},{"ga_id":"ga_e56ca0eb07304f2fbcf60eb8f29f3889","receipt_sha256":"74afd52096ce817ad2da9e5af8ce63e7f95705a13702ad7f12edce8fa4d4a4f5","budget_sequence":81},{"ga_id":"ga_8eb410609e294d899806a319e6615f2b","receipt_sha256":"ee250a365f879f99aa41bf45274296cadc6f11d26567dc15c6be3c8778e4b533","budget_sequence":85}]'::jsonb,
  'old_effective_binding_exact',(select body from effective_binding)=jsonb_build_object('root_id',k.root_id,'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5','controller_sha256',k.old_controller_sha,'qualification_sha256',k.old_qualification_sha,'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5','gate_id','G-PREENTRY-SKILL-QUALIFICATION','gate_version','fixed-synthetic-20260910.v10-env-order-repair','gate_sha256','3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a','runtime_acceptance_sha256',k.old_acceptance_sha,'prior_seconds',1506,'prior_evidence_bytes',322546611),
  'old_effective_window_exact',(select body from effective_window)->>'generation_id'=k.root8 and (select body from effective_window)->>'binding_digest'=k.old_binding_sha and (select body from effective_window)->>'expires_at'='2026-09-15T03:00:00+00:00',
  'installer_absent',to_regprocedure('clued_control.install_root9_successor_v1(jsonb)') is null,
  'old_constraint_exact',exists(select 1 from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='clued_control' and t.relname='successor_binding' and c.conname='successor_binding_predecessor_generation_id_check' and position(k.root8 in pg_get_constraintdef(c.oid,true))=0 and position('ctrgen_26769cc7109ced40bc4016b2af678198' in pg_get_constraintdef(c.oid,true))>0)
 ) body from k cross join counts c
),
result as (
 select jsonb_build_object(
  'object_type','Stage2CLivePreflight','state',case when not exists(select 1 from jsonb_each((select body from checks)) q where q.value<>'true'::jsonb) then 'PASS_EXACT_ROOT8_SEQ97_PREIMAGE' else 'FAIL_CLOSED' end,
  'all_pass',not exists(select 1 from jsonb_each((select body from checks)) q where q.value<>'true'::jsonb),
  'observed_at',clock_timestamp(),'m3_owner_merge_commit','9398c6cb8db84b802facebf683c134fb1ba4ad5d',
  'checks',(select body from checks),'snapshot',(select body from snapshot),
  'current_head',(select to_jsonb(h) from head h),'execution_current',(select to_jsonb(c) from cur c),
  'effective_window',(select body from effective_window),'effective_binding',(select body from effective_binding),
  'safety',jsonb_build_object('database_writes',0,'budget_reservations',0,'capacity_change',false,'refund',false,'ga_dispatch',false)
 ) body
)
select body from result;
commit;
