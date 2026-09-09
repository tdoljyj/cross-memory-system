-- A read projection in the existing private control domain, not an issuer.
-- Only the separately reviewed fixed forward-registration transaction may append
-- two exact ordered events. No public event/rotation API is introduced.
-- The original event is preserved by its complete PostgreSQL JSONB SHA256.
-- A separately reviewed one-shot transaction fixes all actual second-event bytes.
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
 if n not in (1,2) then raise exception 'at_most_two_exact_binding_successors_required'; end if;
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
 return next result;
end $$;
-- Existing owner, ACL, SECURITY DEFINER and fixed search_path/UTC are preserved.
