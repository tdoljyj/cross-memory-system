-- READ ONLY expected postimage.
begin transaction isolation level repeatable read read only;
do $check$ declare h clued_control.current_head; c clued_control.execution_current; begin
 select * into h from clued_control.current_head where root_id='ctr_414bd3c724264a83894b0c55cf2ab878'; select * into c from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
 if h.sequence<>9 or h.generation_id<>'ctrgen_308a1dfc185cff633892638581e0a34c' or h.revoked or c.sequence<>101 or c.pending_budget_sequence is not null or c.active_ga_id is not null or c.charged_seconds<>10506 or c.charged_evidence_bytes<>2335812531 then raise exception 'ROOT9_POSTIMAGE_STATE_DRIFT'; end if;
 if (select count(*) from clued_control.events where root_id=h.root_id)<>9 or (select count(*) from clued_control.execution_events where root_id=h.root_id)<>101 or exists(select 1 from clued_control.execution_events where root_id=h.root_id and sequence=102) then raise exception 'ROOT9_POSTIMAGE_SEQUENCE_DRIFT'; end if;

 if (select request->>'kind' from clued_control.events where root_id=h.root_id and sequence=9) is distinct from 'GENERATION_REGISTERED'
 or (select request->>'operation' from clued_control.execution_events where root_id=h.root_id and sequence=98) is distinct from 'SUCCESSOR_BINDING_REGISTERED'
 or (select request->>'operation' from clued_control.execution_events where root_id=h.root_id and sequence=99) is distinct from 'SUCCESSOR_BINDING_PREPARED'
 or (select request->>'operation' from clued_control.execution_events where root_id=h.root_id and sequence=100) is distinct from 'SUCCESSOR_BINDING_QUALIFIED'
 or (select request->>'operation' from clued_control.execution_events where root_id=h.root_id and sequence=101) is distinct from 'EXECUTION_RUNTIME_ACCEPTANCE_REPOINTED'
 or not exists(select 1 from clued_control.control_objects where root_id=h.root_id and object_type='StatusManifest' and generation=26 and sha256='8e02293caa447a5c2fe1749d89c082fe2e1e937180c937d746512d9b7e32b6a3')
 or not exists(select 1 from clued_control.successor_binding where root_id=h.root_id and binding_id='sb_201178b7a8111000d515f7f26a75a28b' and binding_sha256='d3c597a2425343bb6fb897e4a6eaddd76cb73adf282a8cd07187e23a527cd76e')
 or (select count(*) from clued_control.execution_events where root_id=h.root_id and sequence>44 and request->>'operation'='BUDGET_RESERVED')<>9
 or (select count(*) from clued_control.execution_events where root_id=h.root_id and sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')<>17
 then raise exception 'ROOT9_POSTIMAGE_OBJECT_OR_EVENT_DRIFT'; end if;
end $check$;
select sequence,idempotency_key,request from clued_control.events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence=9;
select sequence,idempotency_key,request from clued_control.execution_events where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and sequence between 98 and 101 order by sequence;
select object_type,uri,sha256,generation from clued_control.control_objects where root_id='ctr_414bd3c724264a83894b0c55cf2ab878' and object_type='StatusManifest' and generation=26;
select 'PASS_ROOT9_EXEC101_BUDGET102_ABSENT' state; rollback;
