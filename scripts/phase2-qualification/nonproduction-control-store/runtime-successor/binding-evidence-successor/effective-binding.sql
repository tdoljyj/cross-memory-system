-- A read projection in the existing private control domain, not an issuer.
-- Only the separately reviewed fixed forward-registration transaction may append
-- the one exact event. No public event/rotation API is introduced.
create function clued_control.effective_execution_binding()
returns setof clued_control.execution_binding language plpgsql stable security definer
set search_path='' set timezone='UTC' as $$
declare original clued_control.execution_binding; result clued_control.execution_binding;
 e clued_control.execution_events; value jsonb; n integer;
begin
 select * into original from clued_control.execution_binding
 where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
 if not found then return; end if;
 select count(*) into n from clued_control.execution_events where root_id=original.root_id
 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED';
 if n=0 then return next original;return; end if;
 if n<>1 then raise exception 'one_exact_binding_successor_required'; end if;
 select * into e from clued_control.execution_events where root_id=original.root_id
 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED';
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
 return next result;
end $$;
revoke all on function clued_control.effective_execution_binding() from public,anon,authenticated,service_role;
