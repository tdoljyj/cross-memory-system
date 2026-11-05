# Actual independently held elevated OBSERVER role. All helpers are captured in
# the same private module. No enrollment, Register/Run, ACL or CLI execution.
function IO216Need($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function IO216Emit($v){[Console]::Out.WriteLine(($v|ConvertTo-Json -Compress -Depth 12));[Console]::Out.Flush()}
function IO216Read($reader,[int]$timeout=90000){$q=$reader.ReadLineAsync();IO216Need ($q.Wait($timeout)) 'INSTALL_OBSERVER_ROOT_TIMEOUT';$line=$q.Result;IO216Need ($line -is [string] -and [Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'INSTALL_OBSERVER_ROOT_EOF_BOUND';return (SelfStrictJson $line)}
function IO216Root([string]$operation,[string]$phase){
 $s=$script:InstallObserver216;IO216Need ($null -ne $s -and $operation -cin @('INSTALL_CURRENT','QUALIFICATION_CURRENT')) 'INSTALL_OBSERVER_ROOT_PRIVATE'
 $s.auth_seq++;$id=[Guid]::NewGuid().ToString('N')
 IO216Emit ([ordered]@{schema='clued.root-install-authority-request216/1';request_id=$id;seq=$s.auth_seq;operation=$operation;phase=$phase;attempt_id=$s.plan.attempt_id;actor_packet_sha256=$s.plan.actor_packet_sha256})
 $q=IO216Read $s.reader;InstallKeys211 $q @('schema','request_id','seq','operation','value')
 IO216Need ((InstallSame211 $q.schema 'clued.root-install-authority-reply216/1') -and (InstallSame211 $q.request_id $id) -and $q.seq -is [int] -and $q.seq -eq $s.auth_seq -and (InstallSame211 $q.operation $operation)) 'INSTALL_OBSERVER_ROOT_CORRELATION'
 return $q.value
}
function IO216ReopenResult($plan,$outcome,[scriptblock]$observer){
 $r=InstallPlan211 $plan;$p=Join-Path ('C:\ProgramData\CluedCacheInstallSelf211\Outputs\'+$r.node_id) 'self-install211.result.json'
 $raw=[CluedQualification181.SafeEvidence]::Read($p,16384,$r.expected_sid);$actual=SelfStrictJson ([Text.UTF8Encoding]::new($false,$true).GetString($raw))
 InstallKeys211 $actual @('schema','status','purpose','node_id','attempt_id','phase','registration_attempted','registration_returned','run_request_attempted','start_observation','worker_pid','worker_instance_guid','registered_xml_sha256','windows_lifecycle_qualified','natural_retirement_qualified','production_producer_qualified','panel_qualified','automatic_retry')
 IO216Need ((InstallSame211 $actual.schema 'clued.self-maintenance-install-result211/1') -and (InstallSame211 $actual.status 'SELF_INSTALLED_WORKER_OBSERVED_AWAITING_LIFECYCLE') -and (InstallSame211 $actual.purpose $plan.purpose) -and (InstallSame211 $actual.node_id $r.node_id) -and (InstallSame211 $actual.attempt_id $plan.attempt_id) -and (InstallSame211 $actual.phase 'worker-observed') -and $actual.registration_attempted -is [bool] -and $actual.registration_attempted -and $actual.registration_returned -is [bool] -and $actual.registration_returned -and $actual.run_request_attempted -is [bool] -and $actual.start_observation -cin @('EXPLICIT_INITIAL_RUN_REQUEST','NATURAL_TRIGGER_BEFORE_RUN','NATURAL_TRIGGER_AFTER_REGISTER')) 'INSTALL_OBSERVER_PERSISTED_SUCCESS_REQUIRED'
 foreach($n in @('windows_lifecycle_qualified','natural_retirement_qualified','production_producer_qualified','panel_qualified','automatic_retry')){IO216Need ($actual.$n -is [bool] -and -not $actual.$n) 'INSTALL_OBSERVER_NO_EXTRA_QUALIFICATION'}
 IO216Need (($actual|ConvertTo-Json -Depth 10 -Compress) -ceq ($outcome|ConvertTo-Json -Depth 10 -Compress)) 'INSTALL_OBSERVER_NODE_OUTCOME_NOT_ORIGINAL_BYTES'
 $fixed=[pscustomobject]@{pid=$actual.worker_pid;guid=$actual.worker_instance_guid;xml_hash=$actual.registered_xml_sha256};InstallInstance211 $fixed
 $proof=& $observer 'actual-worker' $plan $fixed
 return [pscustomobject]@{status='INSTALLED_WORKER_INDEPENDENTLY_REOPENED';attempt_id=$plan.attempt_id;actor_packet_sha256=$plan.actor_packet_sha256;worker_pid=$proof.worker_pid;worker_instance_guid=$proof.worker_instance_guid;registered_xml_sha256=$proof.registered_xml_sha256}
}
function InvokeInstallObserver216($initial,[byte[]]$enrollment,[IO.StreamReader]$rootReader){
 IO216Need ($null -eq $script:InstallObserver216 -and $rootReader -is [IO.StreamReader]) 'INSTALL_OBSERVER_PRIVATE_ONCE'
 $plan=$initial.install_plan;$r=InstallPlan211 $plan;AssertInstallBA212;QualExpect212 $initial.qualification_expectation
 IO216Need ($r.host -ceq [Environment]::MachineName -and $r.expected_sid -ceq $initial.target_sid -and $plan.actor_packet_sha256 -ceq $initial.binding.packet_sha256 -and $plan.attempt_id -ceq $initial.binding.attempt_id) 'INSTALL_OBSERVER_CAPTURE_BINDING'
 $script:InstallObserver216=@{reader=$rootReader;plan=$plan;auth_seq=0;command_seq=0};$observer=$null;$reopened=$false
 try{
  $a={param($phase,$p)IO216Need ($p.actor_packet_sha256 -ceq $script:InstallObserver216.plan.actor_packet_sha256) 'INSTALL_OBSERVER_FIXED_PLAN';return IO216Root 'INSTALL_CURRENT' $phase}
  $q={param($e)return IO216Root 'QUALIFICATION_CURRENT' ''}
  while($true){
   $cmd=IO216Read $rootReader 180000;InstallKeys211 $cmd @('schema','seq','request_id','operation','body');$script:InstallObserver216.command_seq++
   IO216Need ((InstallSame211 $cmd.schema 'clued.root-install-observer-command216/1') -and $cmd.seq -is [int] -and $cmd.seq -eq $script:InstallObserver216.command_seq -and $cmd.seq -le 32 -and $cmd.request_id -is [string] -and $cmd.request_id -cmatch '\A[a-f0-9]{32}\z' -and $cmd.operation -cin @('INIT','PHASE','REOPEN','FINISH')) 'INSTALL_OBSERVER_FIXED_COMMAND'
   if($cmd.operation -ceq 'INIT'){
    IO216Need ($null -eq $observer) 'INSTALL_OBSERVER_INIT_ONCE';InstallKeys211 $cmd.body @()
    $observer=NewReadonlyInstallObserver212 $plan $initial.qualification_expectation $enrollment $a $q
    $value=[pscustomobject]@{status='INSTALL_BA_READY_QUALIFICATION_REOPENED';attempt_id=$plan.attempt_id;actor_packet_sha256=$plan.actor_packet_sha256;qualification_index_sha256=$initial.qualification_expectation.qualification_index_sha256}
   }elseif($cmd.operation -ceq 'PHASE'){
    IO216Need ($null -ne $observer -and -not $reopened) 'INSTALL_OBSERVER_PHASE_AFTER_INIT';InstallKeys211 $cmd.body @('phase','fixed')
    IO216Need ($cmd.body.phase -cin @('enrolled-before-register','registered-worker','before-initial-run-if-empty','actual-worker')) 'INSTALL_OBSERVER_CLOSED_PHASE';$value=& $observer $cmd.body.phase $plan $cmd.body.fixed
   }elseif($cmd.operation -ceq 'REOPEN'){
    IO216Need ($null -ne $observer -and -not $reopened) 'INSTALL_OBSERVER_REOPEN_ONCE';InstallKeys211 $cmd.body @('outcome');$value=IO216ReopenResult $plan $cmd.body.outcome $observer;$reopened=$true
   }else{IO216Need ($reopened) 'INSTALL_OBSERVER_FINISH_ONLY_AFTER_PROOF';InstallKeys211 $cmd.body @();return}
   IO216Emit ([ordered]@{schema='clued.root-install-observer-result216/1';request_id=$cmd.request_id;operation=$cmd.operation;value=$value})
  }
 }finally{$script:InstallObserver216=$null}
}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_INSTALL_OBSERVER_ONLY_NO_CLI'}
