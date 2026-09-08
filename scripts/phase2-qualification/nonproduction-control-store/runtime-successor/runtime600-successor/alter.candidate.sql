-- Same approved control domain, no installation or data migration. Root runs this in one transaction.
do $$ declare r jsonb; begin
 if current_setting('clued_control.target_project',true) is distinct from 'uscrdifznmlvczcekqpw' then raise exception 'wrong_control_project'; end if;
 perform 1 from clued_control.current_head where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' for share;
 r:=clued_control.read_root('ctr_414bd3c724264a83894b0c55cf2ab878');
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or r->>'generation_id' is distinct from 'ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12' or r->>'sequence' is distinct from '2' or clock_timestamp()>='2026-09-09T09:28:59Z'::timestamptz then raise exception 'existing_root_window_or_generation_changed'; end if;
 lock table clued_control.execution_binding,clued_control.execution_current,clued_control.execution_events,clued_control.gate_attempts,clued_control.control_objects in share row exclusive mode;
 if exists(select 1 from clued_control.execution_binding) or exists(select 1 from clued_control.execution_current) or exists(select 1 from clued_control.execution_events) or exists(select 1 from clued_control.gate_attempts) or exists(select 1 from clued_control.control_objects) then raise exception 'runtime_not_empty_successor_requires_review'; end if;
 if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='clued_control.reserve_execution_budget(text,text)'::regprocedure) is distinct from 'ae2070dcb25ca4875ee001244525d1ba06a818d09b0a4dbd807b40b4fdf06c20' then raise exception 'prior_function_drift_reserve_execution_budget'; end if;
 if (select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='clued_control.reserve_gate(text,text)'::regprocedure) is distinct from 'f6859a6b4dcef1f13c3965aa66010d763b7da614cedbc3cb8594528b09b1c284' then raise exception 'prior_function_drift_reserve_gate'; end if;
end $$;

create or replace function clued_control.reserve_execution_budget(p_raw text,p_sha text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding;
 c clued_control.execution_current; previous clued_control.execution_events; r jsonb; v jsonb; next_sequence bigint; ref jsonb;
begin
 if p_raw is null or octet_length(p_raw)>16384 or not(p_raw is json object with unique keys)
 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'exact_budget_bytes_required'; end if;
 v:=p_raw::jsonb;
 if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from
 array['controller_digest','credential_generation','environment','evidence_bytes','expires_at','idempotency_key','not_before','profile_digest','purpose','root_generation','runner_generation','scope_digest','seconds','session_generation']::text[]
 or jsonb_typeof(v->'idempotency_key') is distinct from 'string'
 or coalesce(v->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$'
 or v->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION' or v->>'environment' is distinct from 'ISOLATED_TEST'
 or v->'seconds' is distinct from '600'::jsonb or v->'evidence_bytes' is distinct from '134217728'::jsonb
 then raise exception 'fixed_budget_scope_required'; end if;
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into b from clued_control.execution_binding where root_id=root;
 select * into c from clued_control.execution_current where root_id=root for update;
 if b.root_id is null or c.root_id is null then raise exception 'accepted_execution_binding_missing'; end if;
 select * into previous from clued_control.execution_events where root_id=root and idempotency_key=v->>'idempotency_key';
 if found then
  if previous.request->>'operation' is distinct from 'BUDGET_RESERVED' or previous.request->'body'->>'raw' is distinct from p_raw
  or previous.request->'body'->>'sha256' is distinct from p_sha then raise exception 'budget_idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','event',to_jsonb(previous),'authority_effect','NONE');
 end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or v->>'root_generation' is distinct from r->>'generation_id'
 or v->>'profile_digest' is distinct from b.profile_sha256 or v->>'controller_digest' is distinct from b.controller_sha256
 or v->>'scope_digest' is distinct from b.scope_sha256 or v->>'runner_generation' is distinct from c.runner_generation
 or v->>'credential_generation' is distinct from c.credential_generation or v->>'session_generation' is distinct from c.session_generation
 then raise exception 'budget_current_binding_mismatch'; end if;
 if (v->>'not_before') is null or (v->>'expires_at') is null or (v->>'not_before')::timestamptz>clock_timestamp()
 or (v->>'not_before')::timestamptz<(select not_before from clued_control.accepted_binding where root_id=root)
 or (v->>'expires_at')::timestamptz<=clock_timestamp()
 or (v->>'expires_at')::timestamptz>(select expires_at from clued_control.accepted_binding where root_id=root)
 then raise exception 'budget_window_invalid'; end if;
 if c.active_ga_id is not null or c.pending_budget_sequence is not null or c.charged_seconds<b.prior_seconds
 or c.charged_evidence_bytes<b.prior_evidence_bytes or c.charged_seconds+600>7200
 or c.charged_evidence_bytes+134217728>1073741824 then raise exception 'budget_or_pending_capacity_unavailable'; end if;
 next_sequence:=c.sequence+1;
 insert into clued_control.execution_events(root_id,sequence,idempotency_key,request)
 values(root,next_sequence,v->>'idempotency_key',jsonb_build_object('operation','BUDGET_RESERVED','body',jsonb_build_object('raw',p_raw,'sha256',p_sha)));
 update clued_control.execution_current set sequence=next_sequence,pending_budget_sequence=next_sequence,
 charged_seconds=charged_seconds+600,charged_evidence_bytes=charged_evidence_bytes+134217728 where root_id=root;
 ref:=jsonb_build_object('uri','urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||next_sequence,'sha256',p_sha);
 return jsonb_build_object('status','BUDGET_RESERVED','budget_reservation_ref',ref,'sequence',next_sequence,
 'authority_effect','NONE','automatic_refund',false);
end $$;

create or replace function clued_control.reserve_gate(p_raw text,p_sha text) returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare root constant text:='ctr_414bd3c724264a83894b0c55cf2ab878'; b clued_control.execution_binding;
 c clued_control.execution_current; old clued_control.gate_attempts; r jsonb; g jsonb; start_time timestamptz; end_time timestamptz; seconds integer; budget clued_control.execution_events; allocation jsonb;
begin
 if p_raw is null or octet_length(p_raw)>65536 or p_sha is distinct from encode(sha256(convert_to(p_raw,'UTF8')),'hex') then raise exception 'invalid_exact_ga_bytes'; end if;
 if not (p_raw is json object with unique keys) then raise exception 'invalid_unique_ga_object'; end if;
 g:=p_raw::jsonb;
 if jsonb_typeof(g)<>'object' or coalesce(g->>'gate_authorization_id','') !~ '^ga_[A-Za-z0-9_.-]{1,128}$'
 or coalesce(g->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,128}$' then raise exception 'invalid_ga_identity'; end if;
 -- Serialize root revocation/generation and runtime capacity in consistent order.
 perform 1 from clued_control.current_head where root_id=root for share;
 select * into b from clued_control.execution_binding where root_id=root;
 select * into c from clued_control.execution_current where root_id=root for update;
 if b.root_id is null or c.root_id is null then raise exception 'accepted_execution_binding_missing'; end if;
 select * into old from clued_control.gate_attempts where root_id=root and idempotency_key=g->>'idempotency_key';
 if found then
  if old.ga_raw is distinct from p_raw or old.ga_sha256 is distinct from p_sha then raise exception 'idempotency_conflict'; end if;
  return jsonb_build_object('status','DUPLICATE','attempt',to_jsonb(old),'authority_effect','NONE');
 end if;
 r:=clued_control.read_root(root);
 if r->>'state' is distinct from 'STORED_NO_GATE_AUTHORITY' or g->>'control_trust_root_generation' is distinct from r->>'generation_id'
 or g->>'runner_generation' is distinct from c.runner_generation or g->>'credential_generation' is distinct from c.credential_generation
 or g->>'session_generation' is distinct from c.session_generation then raise exception 'current_authority_or_generation_changed'; end if;
 if g->>'purpose' is distinct from 'SKILL_COEXISTENCE_QUALIFICATION' or g->>'environment' is distinct from 'ISOLATED_TEST'
 or g->>'authorization_status' is distinct from 'AUTHORIZED' or g->>'profile_digest' is distinct from b.profile_sha256
 or g->>'controller_digest' is distinct from b.controller_sha256 or g->>'scope_digest' is distinct from b.scope_sha256
 or g->>'gate_id' is distinct from b.gate_id
 or g->'controller_qualification_ref'->>'sha256' is distinct from b.qualification_sha256 then raise exception 'exact_accepted_scope_mismatch'; end if;
 if not exists(select 1 from clued_control.control_objects co where co.root_id=root
 and co.uri=g->'status_manifest_ref'->>'uri' and co.sha256=g->'status_manifest_ref'->>'sha256')
 then raise exception 'exact_stored_status_required'; end if;
 -- Full original Schema, exact static Gate version/digest, signature/issuer,
 -- Profile/NA evidence and target bindings are checked by the trusted host verifier.
 start_time:=(g->>'issued_at')::timestamptz;end_time:=(g->>'deadline')::timestamptz;
 if start_time is null or end_time is null or (g->>'expires_at') is null or start_time>clock_timestamp()
 or start_time<(select not_before from clued_control.accepted_binding where root_id=root)
 or end_time<=clock_timestamp() or end_time>(g->>'expires_at')::timestamptz
 or (g->>'expires_at')::timestamptz-start_time>interval '600 seconds'
 or (g->>'expires_at')::timestamptz>(select expires_at from clued_control.accepted_binding where root_id=root)
 then raise exception 'ga_window_invalid'; end if;
 seconds:=ceil(extract(epoch from ((g->>'expires_at')::timestamptz-start_time)))::integer;
 if c.charged_seconds<b.prior_seconds or c.charged_evidence_bytes<b.prior_evidence_bytes then raise exception 'prior_budget_binding_mismatch'; end if;
 if seconds<1 or c.active_ga_id is not null or c.pending_budget_sequence is null
 then raise exception 'actual_pending_budget_required'; end if;
 select * into budget from clued_control.execution_events where root_id=root and sequence=c.pending_budget_sequence;
 if not found or budget.recording_transaction_id=pg_current_xact_id() or budget.request->>'operation' is distinct from 'BUDGET_RESERVED'
 or g->'budget_reservation_ref'->>'uri' is distinct from 'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'||budget.sequence
 or g->'budget_reservation_ref'->>'sha256' is distinct from budget.request->'body'->>'sha256'
 then raise exception 'exact_prior_committed_budget_required'; end if;
 allocation:=(budget.request->'body'->>'raw')::jsonb;
 if allocation->>'root_generation' is distinct from g->>'control_trust_root_generation'
 or allocation->>'profile_digest' is distinct from g->>'profile_digest' or allocation->>'controller_digest' is distinct from g->>'controller_digest'
 or allocation->>'scope_digest' is distinct from g->>'scope_digest' or allocation->>'runner_generation' is distinct from g->>'runner_generation'
 or allocation->>'credential_generation' is distinct from g->>'credential_generation' or allocation->>'session_generation' is distinct from g->>'session_generation'
 or seconds>(allocation->>'seconds')::integer or start_time<(allocation->>'not_before')::timestamptz
 or (g->>'expires_at')::timestamptz>(allocation->>'expires_at')::timestamptz
 then raise exception 'budget_consumption_binding_or_window_mismatch'; end if;
 insert into clued_control.gate_attempts(root_id,ga_id,idempotency_key,ga_raw,ga_sha256,ga,phase,expires_at,budget_sequence)
 values(root,g->>'gate_authorization_id',g->>'idempotency_key',p_raw,p_sha,g,'PENDING',end_time,budget.sequence);
 update clued_control.execution_current set active_ga_id=g->>'gate_authorization_id',pending_budget_sequence=null where root_id=root;
 return jsonb_build_object('status','RESERVED','ga_id',g->>'gate_authorization_id','authority_effect','NONE');
end $$;
