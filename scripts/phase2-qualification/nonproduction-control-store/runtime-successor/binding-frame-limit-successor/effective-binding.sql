-- CANDIDATE: exact third event sequence26/key ordinary-frame-limit-binding-20260909 only.
-- Existing first hash and complete second event remain immutable; no generic rotation.
-- A read projection in the existing private control domain, not an issuer.
-- Only the separately reviewed fixed forward-registration transaction may append
-- three exact ordered events. No public event/rotation API is introduced.
-- The original event is preserved by its complete PostgreSQL JSONB SHA256.
-- A separately reviewed one-shot transaction must fix all actual third-event bytes.
create or replace function clued_control.effective_execution_binding()
returns setof clued_control.execution_binding language plpgsql stable security definer
set search_path='' set timezone='UTC' as $$
declare original clued_control.execution_binding; result clued_control.execution_binding;
 e clued_control.execution_events; value jsonb; n integer;
 predecessor clued_control.execution_binding; source_name text; source_value jsonb;
begin
 select * into original from clued_control.execution_binding
 where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
 if not found then return; end if;
 select count(*) into n from clued_control.execution_events where root_id=original.root_id
 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED';
 if n=0 then return next original;return; end if;
 if n not in (1,2,3) then raise exception 'at_most_three_exact_binding_successors_required'; end if;
 select * into e from clued_control.execution_events where root_id=original.root_id
 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED' order by sequence limit 1;
 if e.sequence<>10 or encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex') is distinct from '23f1ed9bc4447d6981dfadb2fdcba11d0a5458a85929166f1f09eeef7dac80d4' then raise exception 'original_full_binding_event_drift'; end if;
 value:=e.request->'body';
 if e.idempotency_key is distinct from 'ordinary-evidence-blob-binding-20260909'
 or value->'previous_binding' is distinct from to_jsonb(original)
 or value->>'previous_binding_sha256' is distinct from encode(sha256(convert_to(to_jsonb(original)::text,'UTF8')),'hex')
 or value->>'new_binding_sha256' is distinct from encode(sha256(convert_to((value->'new_binding')::text,'UTF8')),'hex')
 or jsonb_typeof(value->'source_acceptance_refs') is distinct from 'object'
 or (select array_agg(k order by k) from jsonb_object_keys(value->'new_binding') k) is distinct from
 (select array_agg(k order by k) from jsonb_object_keys(to_jsonb(original)) k)
 then raise exception 'exact_fixed_binding_event_required'; end if;
 select * into result from jsonb_populate_record(null::clued_control.execution_binding,value->'new_binding');
 if result.root_id is distinct from original.root_id or result.profile_sha256 is distinct from original.profile_sha256
 or result.gate_id is distinct from original.gate_id or result.prior_seconds is distinct from original.prior_seconds
 or result.prior_evidence_bytes is distinct from original.prior_evidence_bytes
 or coalesce(result.controller_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.qualification_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.scope_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.gate_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.runtime_acceptance_sha256,'') !~ '^[a-f0-9]{64}$'
 or result.gate_version is distinct from 'fixed-synthetic-20260909.v4-evidence-blob'
 then raise exception 'same_scope_binding_successor_required'; end if;
 if n=1 then return next result;return; end if;
 predecessor:=result;
 select * into e from clued_control.execution_events where root_id=original.root_id
 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED' order by sequence offset 1 limit 1;
 if to_jsonb(e) is distinct from $original_second${"request":{"body":{"new_binding":{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"f1c53254ac5365ff653bee9e2bcd1c3b95e7d1ac209c9f31c1b1dcfac011bbf1","gate_version":"fixed-synthetic-20260909.v5-parallel-source","scope_sha256":"04d381ff6919ec35ee3cb0e17a23c8579ed7a2f5a87835a1560db6c18f23f536","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"aa6514441aaaa1cc768c67bd9a5bca7b5a3118f8a58b499da81901d6eab99199","prior_evidence_bytes":322546611,"qualification_sha256":"7b3a438ae13a2d2967d3c424346ba94abd1203ef19690ed82dbac3f378edcf0b","runtime_acceptance_sha256":"8d1ffbb2acc6593d9f3618fb21fdcedee51ec24f8e7d2411b1203aa0281805ed"},"previous_binding":{"gate_id":"G-PREENTRY-SKILL-QUALIFICATION","root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","gate_sha256":"71130c92be95a3b16d44d3ebe7fb439dfe8fc8b44354b5adfd79652425346958","gate_version":"fixed-synthetic-20260909.v4-evidence-blob","scope_sha256":"95da22160234d3e5b2b65451d97803efd6b8f3b67d8182ff7b2fee4dc5f20ebb","prior_seconds":1506,"profile_sha256":"d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5","controller_sha256":"0ff3e4bed5587805b69e5c9e1787d60b789d46c32a9c02ae20c8dfb899af98b2","prior_evidence_bytes":322546611,"qualification_sha256":"b0e09a94a19ac53807d1024d2a1bf9c5e0b9c9ea8c16f5d0d2c00fd43f8060d4","runtime_acceptance_sha256":"14b17464205a8ed2fbd9de7b8380f26beecf3d7b3bc6395d34b678dc685637d9"},"new_binding_sha256":"fe94f758fba0a56c902fa4a1a389f77486129797200c8ff2091c62a4fa447445","source_acceptance_refs":{"scope":{"ref":{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/8921cd188b8824912a8e6a075d6ebb65261c7bc3","sha256":"04d381ff6919ec35ee3cb0e17a23c8579ed7a2f5a87835a1560db6c18f23f536"},"publication":{"commitSha":"f8952d8658f404ffa64129ac75a8a1935efd8541","artifactPath":"scripts/phase2-qualification/RuntimeMaterialPreparation/parallel-source-limit-successor/ExecutionScopeDefinition.json"}},"gate_suite":{"ref":{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/392a1b5ae28f875e584b8a180bf76426169d7c04","sha256":"2e0a962c4eaf94ed70b8b3452daf52faf8919035497c0e67e90d7c9d5d60a87a"},"publication":{"commitSha":"f8952d8658f404ffa64129ac75a8a1935efd8541","artifactPath":"scripts/phase2-qualification/RuntimeMaterialPreparation/parallel-source-limit-successor/preentry-skill-qualification.json"}},"qualification":{"ref":{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/28347b5bf7640338e6c4b080329436a7a1b03e07","sha256":"7b3a438ae13a2d2967d3c424346ba94abd1203ef19690ed82dbac3f378edcf0b"},"publication":{"commitSha":"f8952d8658f404ffa64129ac75a8a1935efd8541","artifactPath":"artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/ScopedControllerParallelEvidenceLimitQualification.json"}},"runtime_acceptance":{"ref":{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/726a7bdc6e0700044ed0401334bb70cf78f22802","sha256":"8d1ffbb2acc6593d9f3618fb21fdcedee51ec24f8e7d2411b1203aa0281805ed"},"publication":{"commitSha":"f8952d8658f404ffa64129ac75a8a1935efd8541","artifactPath":"artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/ExactPreentryParallelEvidenceLimitControllerRuntimeAcceptance.json"}},"controller_manifest":{"ref":{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/38ae55a515dd1cb58e1f02b9b56d8e004a456341","sha256":"aa6514441aaaa1cc768c67bd9a5bca7b5a3118f8a58b499da81901d6eab99199"},"publication":{"commitSha":"f8952d8658f404ffa64129ac75a8a1935efd8541","artifactPath":"scripts/phase2-qualification/control-context-verifier-parallel-evidence-limit-successor/ControllerSourceManifest.candidate.json"}},"independent_acceptance":{"ref":{"uri":"https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/d80d367d472086166b382c1fc954b9b3b4c69a52","sha256":"167fe305ea1bf0f653d5afa0aebda9fec8b3648ec3f17f8478388a29b09c7487"},"publication":{"commitSha":"f8952d8658f404ffa64129ac75a8a1935efd8541","artifactPath":"artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/ParallelEvidenceLimitControllerSourceIndependentAcceptance.json"}}},"previous_binding_sha256":"9eb896add96019e50bcbfc98e5c3c398e0498c43f4b3f0c25b989ead5dfedf9a"},"operation":"EXECUTION_BINDING_FORWARD_ACCEPTED"},"root_id":"ctr_414bd3c724264a83894b0c55cf2ab878","sequence":25,"recorded_at":"2026-09-09T05:01:40.127178+00:00","idempotency_key":"ordinary-parallel-source-binding-20260909","recording_transaction_id":"1878"}$original_second$::jsonb then raise exception 'original_full_second_binding_event_drift'; end if;
 value:=e.request->'body';
 if e.sequence<>25 or e.idempotency_key is distinct from 'ordinary-parallel-source-binding-20260909'
 or (select array_agg(k order by k) from jsonb_object_keys(e.request) k) is distinct from array['body','operation']::text[]
 or (select array_agg(k order by k) from jsonb_object_keys(value) k) is distinct from array['new_binding','new_binding_sha256','previous_binding','previous_binding_sha256','source_acceptance_refs']::text[]
 or value->'previous_binding' is distinct from to_jsonb(predecessor)
 or value->>'previous_binding_sha256' is distinct from encode(sha256(convert_to(to_jsonb(predecessor)::text,'UTF8')),'hex')
 or value->>'new_binding_sha256' is distinct from encode(sha256(convert_to((value->'new_binding')::text,'UTF8')),'hex')
 or jsonb_typeof(value->'new_binding') is distinct from 'object'
 or (select array_agg(k order by k) from jsonb_object_keys(value->'new_binding') k) is distinct from
 (select array_agg(k order by k) from jsonb_object_keys(to_jsonb(predecessor)) k)
 or jsonb_typeof(value->'source_acceptance_refs') is distinct from 'object'
 or (select array_agg(k order by k) from jsonb_object_keys(value->'source_acceptance_refs') k) is distinct from array['controller_manifest','gate_suite','independent_acceptance','qualification','runtime_acceptance','scope']::text[]
 then raise exception 'exact_second_fixed_binding_event_required'; end if;
 select * into result from jsonb_populate_record(null::clued_control.execution_binding,value->'new_binding');
 if result.root_id is distinct from predecessor.root_id or result.profile_sha256 is distinct from predecessor.profile_sha256
 or result.gate_id is distinct from predecessor.gate_id or result.prior_seconds is distinct from predecessor.prior_seconds
 or result.prior_evidence_bytes is distinct from predecessor.prior_evidence_bytes
 or coalesce(result.controller_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.qualification_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.scope_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.gate_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.runtime_acceptance_sha256,'') !~ '^[a-f0-9]{64}$'
 or result.gate_version is distinct from 'fixed-synthetic-20260909.v5-parallel-source'
 then raise exception 'same_scope_second_binding_successor_required'; end if;
 for source_name,source_value in select j.key,j.value from jsonb_each(value->'source_acceptance_refs') as j loop
  if (select array_agg(k order by k) from jsonb_object_keys(source_value) k) is distinct from array['publication','ref']::text[]
  or (select array_agg(k order by k) from jsonb_object_keys(source_value->'ref') k) is distinct from array['sha256','uri']::text[]
  or (select array_agg(k order by k) from jsonb_object_keys(source_value->'publication') k) is distinct from array['artifactPath','commitSha']::text[]
  or coalesce(source_value->'ref'->>'sha256','') !~ '^[a-f0-9]{64}$'
  or coalesce(source_value->'ref'->>'uri','') !~ '^https://api[.]github[.]com/repos/tdoljyj/cross-memory-system/git/blobs/[a-f0-9]{40}$'
  or coalesce(source_value->'publication'->>'commitSha','') !~ '^[a-f0-9]{40}$'
  or coalesce(source_value->'publication'->>'artifactPath','') !~ '^(scripts/phase2-qualification/|artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/)[A-Za-z0-9_./-]+$'
  or source_value->'publication'->>'artifactPath' like '%..%'
  then raise exception 'exact_second_binding_source_ref_required'; end if;
 end loop;
 if value->'source_acceptance_refs'->'controller_manifest'->'ref'->>'sha256' is distinct from result.controller_sha256
 or value->'source_acceptance_refs'->'scope'->'ref'->>'sha256' is distinct from result.scope_sha256
 or value->'source_acceptance_refs'->'qualification'->'ref'->>'sha256' is distinct from result.qualification_sha256
 or value->'source_acceptance_refs'->'runtime_acceptance'->'ref'->>'sha256' is distinct from result.runtime_acceptance_sha256
 then raise exception 'second_binding_source_digest_mismatch'; end if;
 if n=2 then return next result;return; end if;
 predecessor:=result;
 select * into e from clued_control.execution_events where root_id=original.root_id
 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED' order by sequence offset 2 limit 1;
 value:=e.request->'body';
 if e.sequence<>26 or e.idempotency_key is distinct from 'ordinary-frame-limit-binding-20260909'
 or (select array_agg(k order by k) from jsonb_object_keys(e.request) k) is distinct from array['body','operation']::text[]
 or (select array_agg(k order by k) from jsonb_object_keys(value) k) is distinct from array['new_binding','new_binding_sha256','previous_binding','previous_binding_sha256','source_acceptance_refs']::text[]
 or value->'previous_binding' is distinct from to_jsonb(predecessor)
 or value->>'previous_binding_sha256' is distinct from encode(sha256(convert_to(to_jsonb(predecessor)::text,'UTF8')),'hex')
 or value->>'new_binding_sha256' is distinct from encode(sha256(convert_to((value->'new_binding')::text,'UTF8')),'hex')
 or jsonb_typeof(value->'new_binding') is distinct from 'object'
 or (select array_agg(k order by k) from jsonb_object_keys(value->'new_binding') k) is distinct from
 (select array_agg(k order by k) from jsonb_object_keys(to_jsonb(predecessor)) k)
 or jsonb_typeof(value->'source_acceptance_refs') is distinct from 'object'
 or (select array_agg(k order by k) from jsonb_object_keys(value->'source_acceptance_refs') k) is distinct from array['controller_manifest','gate_suite','independent_acceptance','qualification','runtime_acceptance','scope']::text[]
 then raise exception 'exact_third_fixed_binding_event_required'; end if;
 select * into result from jsonb_populate_record(null::clued_control.execution_binding,value->'new_binding');
 if result.root_id is distinct from predecessor.root_id or result.profile_sha256 is distinct from predecessor.profile_sha256
 or result.gate_id is distinct from predecessor.gate_id or result.prior_seconds is distinct from predecessor.prior_seconds
 or result.prior_evidence_bytes is distinct from predecessor.prior_evidence_bytes
 or coalesce(result.controller_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.qualification_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.scope_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.gate_sha256,'') !~ '^[a-f0-9]{64}$'
 or coalesce(result.runtime_acceptance_sha256,'') !~ '^[a-f0-9]{64}$'
 or result.gate_version is distinct from 'fixed-synthetic-20260909.v6-frame-limit'
 then raise exception 'same_scope_third_binding_successor_required'; end if;
 for source_name,source_value in select j.key,j.value from jsonb_each(value->'source_acceptance_refs') as j loop
  if (select array_agg(k order by k) from jsonb_object_keys(source_value) k) is distinct from array['publication','ref']::text[]
  or (select array_agg(k order by k) from jsonb_object_keys(source_value->'ref') k) is distinct from array['sha256','uri']::text[]
  or (select array_agg(k order by k) from jsonb_object_keys(source_value->'publication') k) is distinct from array['artifactPath','commitSha']::text[]
  or coalesce(source_value->'ref'->>'sha256','') !~ '^[a-f0-9]{64}$'
  or coalesce(source_value->'ref'->>'uri','') !~ '^https://api[.]github[.]com/repos/tdoljyj/cross-memory-system/git/blobs/[a-f0-9]{40}$'
  or coalesce(source_value->'publication'->>'commitSha','') !~ '^[a-f0-9]{40}$'
  or coalesce(source_value->'publication'->>'artifactPath','') !~ '^(scripts/phase2-qualification/|artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/)[A-Za-z0-9_./-]+$'
  or source_value->'publication'->>'artifactPath' like '%..%'
  then raise exception 'exact_third_binding_source_ref_required'; end if;
 end loop;
 if value->'source_acceptance_refs'->'controller_manifest'->'ref'->>'sha256' is distinct from result.controller_sha256
 or value->'source_acceptance_refs'->'scope'->'ref'->>'sha256' is distinct from result.scope_sha256
 or value->'source_acceptance_refs'->'qualification'->'ref'->>'sha256' is distinct from result.qualification_sha256
 or value->'source_acceptance_refs'->'runtime_acceptance'->'ref'->>'sha256' is distinct from result.runtime_acceptance_sha256
 then raise exception 'third_binding_source_digest_mismatch'; end if;
 return next result;
end $$;
-- Existing owner, ACL, SECURITY DEFINER and fixed search_path/UTC are preserved.
