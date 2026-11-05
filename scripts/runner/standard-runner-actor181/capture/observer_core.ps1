# Typed orchestration only. Real observer facade deliberately unbound.
# No RegisterTaskDefinition/RegisterTask/Run/RunEx/DeleteTask APIs in this file.
function InvokeSelfObserverCore($target,$ops,$registered){
 $released=$false;$phase='read-self-registration'
 try{
  # Trusted implementation reads exact target-owned receipt same-held and closed.
  & $ops.validate_registered $target $registered
  $phase='independent-task-definition'
  $proof=& $ops.read_actual_task $target
  SelfRequire ($proof.xml_sha256 -ceq $registered.intended_xml_sha256 -and $proof.sid -ceq $target.sid -and $proof.task_instances_empty -is [bool] -and $proof.task_instances_empty -and $proof.definition_exact -is [bool] -and $proof.definition_exact) 'INDEPENDENT_REGISTERED_TASK_NOT_EXACT'
  # BA-owned fixed ack must be CreateNew after exact XML/empty-instance checks.
  $ack=[pscustomobject]@{schema='clued.windows-self-observer-ready181/1';host=$target.host;node_id=$target.node_id;expected_sid=$target.sid;attempt_id=$registered.attempt_id;request_sha256=$registered.request_sha256;nonce=$registered.nonce;intended_xml_sha256=$registered.intended_xml_sha256;accepted_subject_sha256=$registered.accepted_subject_sha256;task_instances_empty=$true}
  $phase='write-once-observer-ack';& $ops.write_ack_new $target $ack
  $phase='correlate-actual-task-and-held-processes'
  # This operation must bind actual GUID/EnginePID to task and independently-held
  # native/Python SID,elevation,image,start,parent and private argv before/after.
  $correlation=& $ops.observe_instance_and_hold $target $registered
  foreach($flag in @('actual_task_instance_exact','native_token_exact','child_token_exact','native_argv_exact','child_argv_exact','process_start_before_after_exact','registered_xml_before_after_exact','native_ready_closed_exact')){SelfRequire ($correlation.$flag -is [bool] -and $correlation.$flag) 'HELD_PROCESS_CORRELATION_UNPROVEN'}
  SelfRequire ($correlation.task_instance_guid -cmatch '^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$' -and $correlation.native_pid -is [int] -and $correlation.native_pid -gt 0 -and $correlation.child_pid -is [int] -and $correlation.child_pid -gt 0 -and $correlation.child_pid -ne $correlation.native_pid) 'HELD_PROCESS_IDENTIFIERS_REQUIRED'
  $release=@{schema='clued.windows-probe-release181/1';nonce=$registered.nonce;node_id=$target.node_id;task_instance_guid=$correlation.task_instance_guid;native_pid=$correlation.native_pid;child_pid=$correlation.child_pid}
  $phase='write-once-fixed-native-release';& $ops.write_release_new $target $release;$released=$true
  $phase='independent-held-exits-and-proof'
  $terminal=& $ops.settle_and_validate_native_proof $target $correlation
  SelfRequire ($terminal.native_exit_code -is [int] -and $terminal.native_exit_code -ceq 0 -and $terminal.child_exit_code -is [int] -and $terminal.child_exit_code -ceq 0) 'BOTH_HELD_EXITS_ZERO_REQUIRED'
  foreach($flag in @('both_streams_eof_confirmed','task_instances_empty','known_processes_settled','native_three_closed_exact','held_identity_argv_after_exact','original_history_unchanged')){SelfRequire ($terminal.$flag -is [bool] -and $terminal.$flag) 'TERMINAL_NATIVE_PROOF_UNPROVEN'}
  $phase='new-qualified-proof-and-safe-export'
  # Independent producer must write a NEW qualified index/history chain and export
  # exact bytes only after all checks. Never overwrite a failed r9 index.
  & $ops.write_new_proof_and_export $target $registered $correlation $terminal
  $record=@{status='INDEPENDENT_NATIVE_PROOF_VALIDATED_PENDING_FACTORY_RECONCILIATION';phase='complete';release_created=$released;registration_by_observer=$false;run_by_observer=$false;installation=$false;automatic_retry=$false;exception_diagnostics=$null}
 }catch{
  $record=@{status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';phase=$phase;release_created=$released;registration_by_observer=$false;run_by_observer=$false;installation=$false;automatic_retry=$false;exception_diagnostics=(SelfSafeException $_ $phase)}
 }finally{
  if($null -ne $ops.dispose){& $ops.dispose}
 }
 if($null -ne $ops.persist_result_new){& $ops.persist_result_new $target $record}
 return $record
}
function NewSelfObserverRealFacade {throw 'ACTUAL_OBSERVER_AND_NEW_PROOF_RECEIVER_ADAPTER_NOT_BOUND'}
