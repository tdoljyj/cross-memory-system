-- Stage2C Root9 post-apply readback. READ ONLY; emits exactly one JSON object.
-- It proves the narrow postimage; run-stage2c.sh additionally compares every
-- immutable-prefix/counter/ACL snapshot against the immediately preceding preflight.
begin transaction read only isolation level repeatable read;

with
k as (
 select
  'ctr_414bd3c724264a83894b0c55cf2ab878'::text root_id,
  'ctrgen_b060bc520329398936e461af6a477f94'::text root8,
  'ctrgen_308a1dfc185cff633892638581e0a34c'::text root9,
  'sb_9f790cbeb45430e8cb368ab47d30afb4'::text old_binding_id,
  'sb_201178b7a8111000d515f7f26a75a28b'::text new_binding_id,
  'd3c597a2425343bb6fb897e4a6eaddd76cb73adf282a8cd07187e23a527cd76e'::text new_binding_sha,
  'c76438600d93d708ffe312c5980d8574f649836b65ae523daab0271e7fc9ff1b'::text new_controller_sha,
  '171828b556756186ed30b88928855fb8e6607f799911bf63214e9505fa984c71'::text new_qualification_sha,
  '107fe912496392a0a677f103feb395321292231db4459d1a9a0f170573125cb9'::text new_acceptance_sha,
  '8e02293caa447a5c2fe1749d89c082fe2e1e937180c937d746512d9b7e32b6a3'::text status26_full_sha,
  'd0c0126ae12d710e531e6ceea07c9ff4636d1f69ca85b6a91a49cd75021bccd8'::text status26_signed_sha
),
head as (select h.* from clued_control.current_head h,k where h.root_id=k.root_id),
cur as (select c.* from clued_control.execution_current c,k where c.root_id=k.root_id),
effective_binding as (select to_jsonb(b) body from clued_control.effective_execution_binding() b),
effective_window as (select to_jsonb(w) body from clued_control.effective_execution_window() w),
e9 as (select e.request from clued_control.events e,k where e.root_id=k.root_id and e.sequence=9),
x98 as (select e.request from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence=98),
x99 as (select e.request from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence=99),
x100 as (select e.request from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence=100),
x101 as (select e.request from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence=101),
counts as (
 select
  (select count(*) from clued_control.events e,k where e.root_id=k.root_id) root_events,
  (select count(*) from clued_control.execution_events e,k where e.root_id=k.root_id) execution_events,
  (select count(*) from clued_control.gate_attempts a,k where a.root_id=k.root_id) attempts,
  (select count(*) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence>44 and e.request->>'operation'='BUDGET_RESERVED') allocations,
  (select count(*) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence>44 and e.request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED') forwards,
  (select count(*) from clued_control.successor_binding s,k where s.root_id=k.root_id) successors,
  (select count(*) from clued_control.control_objects o,k where o.root_id=k.root_id and o.object_type='StatusManifest' and o.generation=26) status26,
  (select count(*) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence=102) seq102
),
snapshot as (
 select jsonb_build_object(
  'root_events_1_8_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(e) order by e.sequence) from clued_control.events e,k where e.root_id=k.root_id and e.sequence between 1 and 8),'[]'::jsonb)::text,'UTF8')),'hex'),
  'execution_events_1_97_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(e) order by e.sequence) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence between 1 and 97),'[]'::jsonb)::text,'UTF8')),'hex'),
  'gate_attempts_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(a) order by a.ga_id) from clued_control.gate_attempts a,k where a.root_id=k.root_id),'[]'::jsonb)::text,'UTF8')),'hex'),
  'accepted_binding_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(a) order by a.root_id) from clued_control.accepted_binding a,k where a.root_id=k.root_id),'[]'::jsonb)::text,'UTF8')),'hex'),
  'old_successor_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(s) order by s.binding_id) from clued_control.successor_binding s,k where s.root_id=k.root_id and s.binding_id=k.old_binding_id),'[]'::jsonb)::text,'UTF8')),'hex'),
  'control_objects_through_25_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(o) order by o.object_type,o.generation,o.uri) from clued_control.control_objects o,k where o.root_id=k.root_id and not (o.object_type='StatusManifest' and o.generation>=26)),'[]'::jsonb)::text,'UTF8')),'hex'),
  'gate_attempt_count',c.attempts,'allocation_count',c.allocations,'forward_count',c.forwards,
  'charged_seconds',(select charged_seconds from cur),'charged_evidence_bytes',(select charged_evidence_bytes from cur),
  'routine_acl_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(x) order by x.specific_name,x.grantee,x.privilege_type) from (select specific_name,grantee,privilege_type,is_grantable from information_schema.routine_privileges where specific_schema='clued_control' and routine_name not in ('read_root','reserve_execution_budget','reserve_gate','install_root9_successor_v1')) x),'[]'::jsonb)::text,'UTF8')),'hex'),
  'table_acl_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(to_jsonb(x) order by x.table_name,x.grantee,x.privilege_type) from (select table_name,grantee,privilege_type,is_grantable from information_schema.table_privileges where table_schema='clued_control') x),'[]'::jsonb)::text,'UTF8')),'hex'),
  'non_target_function_defs_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_control' and p.proname not in ('read_root','reserve_execution_budget','reserve_gate','install_root9_successor_v1')),'[]'::jsonb)::text,'UTF8')),'hex'),
  'non_target_constraints_sha256',encode(sha256(convert_to(coalesce((select jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid,true)) order by c.conrelid::regclass::text,c.conname) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='clued_control' and c.conname<>'successor_binding_predecessor_generation_id_check'),'[]'::jsonb)::text,'UTF8')),'hex')
 ) body from counts c
),
checks as (
 select jsonb_build_object(
  'transaction_is_read_only',current_setting('transaction_read_only')='on',
  'root_exact_postimage',(select count(*)=1 and min(sequence)=9 and min(generation_id)=k.root9 and not bool_or(revoked) from head),
  'execution_exact_postimage',(select count(*)=1 and min(sequence)=101 and min(charged_seconds)=10506 and min(charged_evidence_bytes)=2335812531 and bool_and(pending_budget_sequence is null) and bool_and(active_ga_id is null) from cur),
  'append_only_counts_exact',c.root_events=9 and c.execution_events=101 and c.attempts=14,
  'unique_budget_untouched',c.allocations=9 and c.forwards=17,
  'no_seq102',c.seq102=0 and (select max(sequence)=101 from clued_control.execution_events e where e.root_id=k.root_id),
  'two_successors_exact',c.successors=2 and exists(select 1 from clued_control.successor_binding s where s.root_id=k.root_id and s.binding_id=k.new_binding_id and s.predecessor_generation_id=k.root8 and s.generation_id=k.root9 and s.binding_sha256=k.new_binding_sha and s.controller_sha256=k.new_controller_sha and s.qualification_sha256=k.new_qualification_sha and s.status_schema_sha256='6f9a6799109cbad00b4e615b58f535f91fe0ec4a53790fa744000caa2bf3282e' and s.budget_sequence_floor=98 and s.not_before='2026-09-14T03:00:00Z'::timestamptz and s.expires_at='2026-09-15T03:00:00Z'::timestamptz),
  'status26_exact',c.status26=1 and exists(select 1 from clued_control.control_objects o where o.root_id=k.root_id and o.object_type='StatusManifest' and o.generation=26 and o.sha256=k.status26_full_sha and o.raw::jsonb->>'status_manifest_id'='sm_root9_status26_repair_v1' and o.raw::jsonb->'signature_binding'->>'signed_object_sha256'=k.status26_signed_sha and o.raw::jsonb->'signature_binding'->>'owner_merge_commit'='9398c6cb8db84b802facebf683c134fb1ba4ad5d'),
  'root_event9_exact',(select request->>'kind'='GENERATION_REGISTERED' and request->>'generation_id'=k.root9 and request->>'predecessor_generation_id'=k.root8 and request->'expected_sequence'='8'::jsonb and request->'body'->'history'->'prefix_sequence'='8'::jsonb and request->'body'->'history'->>'prefix_digest'='bf0660f3afe7de7e9506e642fdf7ecd15b61de97775b62c3a7d6e5c98f0b1a75' and request->'body'->'predecessor'->>'sha256'='cafe4ed82c21cc3fc4a9e009afe6a29017be6834f60150d81f3c77d6897dd0ce' from e9),
  'exec98_registered',(select request->>'operation'='SUCCESSOR_BINDING_REGISTERED' and request->'body'->>'binding_id'=k.new_binding_id from x98),
  'exec99_prepared',(select request->>'operation'='SUCCESSOR_BINDING_PREPARED' and request->'body'->>'binding_id'=k.new_binding_id and request->'body'->'evidence'->'controller_file_count'='22'::jsonb from x99),
  'exec100_qualified',(select request->>'operation'='SUCCESSOR_BINDING_QUALIFIED' and request->'body'->>'binding_id'=k.new_binding_id and jsonb_array_length(request->'body'->'evidence'->'required_repair_refs')=8 from x100),
  'exec101_repointed',(select request->>'operation'='EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED' and request->'body'->>'binding_id'=k.new_binding_id and request->'body'->>'old_runtime_acceptance_sha256'='6cdae0f2865409b6d6721f607ebd35008952fcb40857207c5b1d291299aebf08' and request->'body'->>'new_runtime_acceptance_sha256'=k.new_acceptance_sha and request->'body'->'new_binding'=(request->'body'->'previous_binding'||jsonb_build_object('controller_sha256',k.new_controller_sha,'qualification_sha256',k.new_qualification_sha,'runtime_acceptance_sha256',k.new_acceptance_sha)) from x101),
  'effective_binding_three_changes_exact',(select body from effective_binding)=jsonb_build_object('root_id',k.root_id,'profile_sha256','d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5','controller_sha256',k.new_controller_sha,'qualification_sha256',k.new_qualification_sha,'scope_sha256','115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5','gate_id','G-PREENTRY-SKILL-QUALIFICATION','gate_version','fixed-synthetic-20260910.v10-env-order-repair','gate_sha256','3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a','runtime_acceptance_sha256',k.new_acceptance_sha,'prior_seconds',1506,'prior_evidence_bytes',322546611),
  'effective_window_root9_exact',(select body from effective_window)->>'generation_id'=k.root9 and (select body from effective_window)->>'binding_digest'=k.new_binding_sha and (select body from effective_window)->>'controller_sha256'=k.new_controller_sha and (select body from effective_window)->>'qualification_sha256'=k.new_qualification_sha and (select body from effective_window)->>'status_schema_sha256'='6f9a6799109cbad00b4e615b58f535f91fe0ec4a53790fa744000caa2bf3282e' and (select body from effective_window)->>'expires_at'='2026-09-15T03:00:00+00:00',
  'read_root_projects_root9',(select r->>'generation_id'=k.root9 and r->'sequence'='9'::jsonb and r->>'state'='STORED_NO_GATE_AUTHORITY' and r->>'metadata_binding_sha256'=k.new_binding_sha and r->>'authority_effect'='NONE' from (select clued_control.read_root(k.root_id) r from k) z),
  'installer_absent_after_once',to_regprocedure('clued_control.install_root9_successor_v1(jsonb)') is null,
  'read_root_acl_not_public',not has_function_privilege('public','clued_control.read_root(text)','EXECUTE') and not has_function_privilege('anon','clued_control.read_root(text)','EXECUTE') and not has_function_privilege('authenticated','clued_control.read_root(text)','EXECUTE') and has_function_privilege('service_role','clued_control.read_root(text)','EXECUTE'),
  'reserve_execution_budget_acl_not_public',not has_function_privilege('public','clued_control.reserve_execution_budget(text,text)','EXECUTE') and not has_function_privilege('anon','clued_control.reserve_execution_budget(text,text)','EXECUTE') and not has_function_privilege('authenticated','clued_control.reserve_execution_budget(text,text)','EXECUTE') and has_function_privilege('service_role','clued_control.reserve_execution_budget(text,text)','EXECUTE'),
  'reserve_gate_acl_not_public',not has_function_privilege('public','clued_control.reserve_gate(text,text)','EXECUTE') and not has_function_privilege('anon','clued_control.reserve_gate(text,text)','EXECUTE') and not has_function_privilege('authenticated','clued_control.reserve_gate(text,text)','EXECUTE') and has_function_privilege('service_role','clued_control.reserve_gate(text,text)','EXECUTE')
 ) body from k cross join counts c
),
result as (
 select jsonb_build_object(
  'object_type','Stage2CLivePostReadback','state',case when not exists(select 1 from jsonb_each((select body from checks)) q where q.value<>'true'::jsonb) then 'PASS_EXACT_ROOT9_SEQ101_POSTIMAGE' else 'FAIL_CLOSED' end,
  'all_pass',not exists(select 1 from jsonb_each((select body from checks)) q where q.value<>'true'::jsonb),
  'observed_at',clock_timestamp(),'checks',(select body from checks),'snapshot',(select body from snapshot),
  'current_head',(select to_jsonb(h) from head h),'execution_current',(select to_jsonb(c) from cur c),
  'effective_window',(select body from effective_window),'effective_binding',(select body from effective_binding),
  'root_event9',(select request from e9),'execution_events_98_101',(select jsonb_agg(to_jsonb(e) order by e.sequence) from clued_control.execution_events e,k where e.root_id=k.root_id and e.sequence between 98 and 101),
  'status26',(select to_jsonb(o) from clued_control.control_objects o,k where o.root_id=k.root_id and o.object_type='StatusManifest' and o.generation=26),
  'safety',jsonb_build_object('new_budget_events',0,'new_attempts',0,'capacity_change',false,'refund',false,'seq102_created',false,'ga_dispatch',false)
 ) body
)
select body from result;
commit;
