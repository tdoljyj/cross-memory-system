-- READ ONLY; run immediately before separately authorized Stage2C apply.
begin transaction isolation level repeatable read read only;
do $check$ declare h clued_control.current_head; c clued_control.execution_current; d text; begin
 select * into h from clued_control.current_head where root_id='ctr_414bd3c724264a83894b0c55cf2ab878'; select * into c from clued_control.execution_current where root_id='ctr_414bd3c724264a83894b0c55cf2ab878';
 if h.sequence<>8 or h.generation_id<>'ctrgen_b060bc520329398936e461af6a477f94' or h.revoked or c.sequence<>97 or c.pending_budget_sequence is not null or c.active_ga_id is not null or c.charged_seconds<>10506 or c.charged_evidence_bytes<>2335812531 then raise exception 'NOT_EXACT_8_97_QUIESCENT_PREIMAGE'; end if;
 if (select count(*) from clued_control.events where root_id=h.root_id)<>8 or (select count(*) from clued_control.execution_events where root_id=h.root_id)<>97 or (select count(*) from clued_control.gate_attempts where root_id=h.root_id)<>14 then raise exception 'PREIMAGE_COUNT_DRIFT'; end if;
 if (select count(*) from clued_control.execution_events where root_id=h.root_id and sequence>44 and request->>'operation'='BUDGET_RESERVED')<>9 or (select count(*) from clued_control.execution_events where root_id=h.root_id and sequence>44 and request->>'operation'='EXECUTION_BINDING_FORWARD_ACCEPTED')<>17 then raise exception 'SERIES_COUNT_DRIFT'; end if;
 if exists(select 1 from clued_control.execution_events where root_id=h.root_id and sequence in (98,99,100,101,102)) or exists(select 1 from clued_control.control_objects where root_id=h.root_id and object_type='StatusManifest' and generation=26) then raise exception 'TARGET_ALREADY_OR_PARTIALLY_PRESENT'; end if;

 select pg_get_functiondef('clued_control.read_root(text)'::regprocedure) into d; if encode(sha256(convert_to(d,'UTF8')),'hex')<>'e1f496ad7e43ba08eca97c4e2cfa13a162660ae90d6628aac16af9c2c26cc47c' then raise exception 'READ_ROOT_SOURCE_DRIFT'; end if;
 select pg_get_functiondef('clued_control.reserve_execution_budget(text,text)'::regprocedure) into d; if encode(sha256(convert_to(d,'UTF8')),'hex')<>'7af51ecc2b98a41c72542a75ef2f87d00753cabfc98afa2bc33b58c7fd0dd8c7' then raise exception 'BUDGET_FUNCTION_SOURCE_DRIFT'; end if;
 select pg_get_functiondef('clued_control.reserve_gate(text,text)'::regprocedure) into d; if encode(sha256(convert_to(d,'UTF8')),'hex')<>'61e700ffd16dc754061676b5cca3ff76aa1ca2ba4eabf3573caac41b00d23db5' then raise exception 'GATE_FUNCTION_SOURCE_DRIFT'; end if;
 select pg_get_constraintdef(x.oid,true) into d from pg_constraint x where x.conrelid='clued_control.successor_binding'::regclass and x.conname='successor_binding_predecessor_generation_id_check';
 if d is distinct from 'CHECK (predecessor_generation_id = ''ctrgen_26769cc7109ced40bc4016b2af678198''::text)' then raise exception 'SUCCESSOR_PREDECESSOR_CONSTRAINT_DRIFT'; end if;
end $check$;
select 'PASS_EXACT_ROOT8_EXEC97_QUIESCENT_NO_BUDGET_ACTION' state,clock_timestamp() observed_at;
rollback;
