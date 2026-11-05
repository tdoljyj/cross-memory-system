# Function library only. A separately accepted captured install-purpose resolver
# must supply the actual Root authority/observer and fixed real facade. No CLI
# switch or JSON can mint that resolver or add physical attempt permission.
function InstallRequire211($value,[string]$code){if($value -isnot [bool] -or -not $value){throw [InvalidOperationException]::new($code)}}
function InstallKeys211($v,[string[]]$keys){InstallRequire211 ($v -is [pscustomobject] -and ((@($v.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'INSTALL_CLOSED_OBJECT'}
function InstallSame211($v,[string]$expected){return ($v -is [string] -and [StringComparer]::Ordinal.Equals($v,$expected))}
function InstallPlan211($plan){
 InstallKeys211 $plan @('schema','purpose','role','attempt_id','actor_packet_sha256','owner_receipt_id','source_acceptance_ref','component_version','component_sha256','row')
 InstallRequire211 ((InstallSame211 $plan.schema 'clued.self-maintenance-install-plan211/1') -and (InstallSame211 $plan.purpose 'standard_runner_self_s4u_maintenance_install_once') -and (InstallSame211 $plan.role 'standard-runner-maintenance-install') -and (InstallSame211 $plan.component_version '1.0.1') -and (InstallSame211 $plan.component_sha256 'cee184416d253fbdd42b47b6d21b1629c3703beacd4d918f75ae531926ae8a8a')) 'INSTALL_EXACT_PURPOSE_ROLE_COMPONENT'
 foreach($k in @('owner_receipt_id','source_acceptance_ref')){InstallRequire211 ($plan.$k -is [string] -and $plan.$k -cmatch '\A[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\z') 'INSTALL_REAL_REFERENCE_SHAPE'}
 InstallRequire211 ($plan.attempt_id -is [string] -and $plan.attempt_id -cmatch '\A[a-f0-9]{32}\z' -and $plan.actor_packet_sha256 -is [string] -and $plan.actor_packet_sha256 -cmatch '\A[a-f0-9]{64}\z') 'INSTALL_ATTEMPT_PACKET'
 $r=$plan.row;InstallKeys211 $r @('host','node_id','expected_sid','home','python','python_sha256','pythonw','pythonw_sha256','request_path','request_sha256','source','managed','task_name')
 foreach($n in $r.PSObject.Properties.Name){InstallRequire211 ($r.$n -is [string] -and $r.$n -notmatch '[\r\n\x00]') 'INSTALL_ROW_PRIMITIVE'}
 InstallRequire211 ($r.host -cmatch '\A[A-Za-z0-9-]{1,63}\z' -and $r.node_id -cmatch '\A[a-z0-9][a-z0-9-]{0,62}\z' -and $r.expected_sid -cmatch '\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z') 'INSTALL_ROW_IDENTITY'
 foreach($n in @('python_sha256','pythonw_sha256','request_sha256')){InstallRequire211 ($r.$n -cmatch '\A[a-f0-9]{64}\z') 'INSTALL_RAW_PIN'}
 InstallRequire211 ($r.home -cmatch '\A[A-Za-z]:[\\/]' -and $r.home -notmatch '(?:\A|[\\/])\.\.?(?:[\\/]|\z)' -and (InstallSame211 $r.source (Join-Path $r.home '.clued-cache-maintenance\source-1.0.1')) -and (InstallSame211 $r.managed (Join-Path $r.home '.clued-cache-maintenance\managed-runner-builds')) -and (InstallSame211 $r.request_path ('C:\ProgramData\CluedCacheInstallSelf211\Control\'+$r.node_id+'\request.json')) -and (InstallSame211 $r.task_name ('CluedCache-'+$r.node_id))) 'INSTALL_FIXED_LAYOUT'
 return $r
}
function InstallCurrent211($plan,[string]$phase,[scriptblock]$authority){
 InstallRequire211 ($null -ne $authority -and $phase -cin @('before-enroll','before-register','after-register','before-run','observe-worker')) 'INSTALL_LIVE_PRIVATE_AUTHORITY_REQUIRED'
 $v=& $authority $phase $plan
 InstallKeys211 $v @('status','purpose','role','attempt_id','actor_packet_sha256','owner_receipt_id','source_acceptance_ref')
 InstallRequire211 (InstallSame211 $v.status 'CURRENT') 'INSTALL_AUTHORITY_NOT_CURRENT'
 foreach($n in @('purpose','role','attempt_id','actor_packet_sha256','owner_receipt_id','source_acceptance_ref')){InstallRequire211 (InstallSame211 $v.$n $plan.$n) 'INSTALL_AUTHORITY_NOT_EXACT'}
}
function InstallIdentity211($r,$v){
 InstallKeys211 $v @('host','sid','elevated','admin_enabled','admin_sid_present','thread_impersonation','process_id')
 InstallRequire211 ((InstallSame211 $v.host $r.host) -and (InstallSame211 $v.sid $r.expected_sid) -and $v.process_id -is [int] -and $v.process_id -gt 0) 'INSTALL_ACTUAL_SELF_IDENTITY'
 foreach($n in @('elevated','admin_enabled','admin_sid_present','thread_impersonation')){InstallRequire211 ($v.$n -is [bool] -and -not $v.$n) 'INSTALL_NONADMIN_PRIMARY_NO_IMPERSONATION'}
}
function InstallInstance211($v){
 InstallKeys211 $v @('pid','guid','xml_hash')
 InstallRequire211 ($v.pid -is [int] -and $v.pid -gt 0 -and $v.guid -is [string] -and $v.guid -cmatch '\A\{[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}\}\z' -and $v.xml_hash -is [string] -and $v.xml_hash -cmatch '\A[a-f0-9]{64}\z') 'INSTALL_ACTUAL_SINGLE_INSTANCE'
}
function InstallObserverPhase211($plan,[string]$phase,$fixed,[scriptblock]$observer){
 $v=& $observer $phase $plan $fixed
 InstallKeys211 $v @('status','phase','attempt_id','actor_packet_sha256','binding_sha256','scheduler_xml_sha256','source_11_match')
 InstallRequire211 ((InstallSame211 $v.status 'INDEPENDENT_INSTALL_PHASE_READY') -and (InstallSame211 $v.phase $phase) -and (InstallSame211 $v.attempt_id $plan.attempt_id) -and (InstallSame211 $v.actor_packet_sha256 $plan.actor_packet_sha256) -and (InstallSame211 $v.binding_sha256 $fixed.binding_sha256) -and (InstallSame211 $v.scheduler_xml_sha256 $fixed.scheduler_xml_sha256) -and $v.source_11_match -is [bool] -and $v.source_11_match) 'INSTALL_INDEPENDENT_PHASE_NOT_EXACT'
}
function InvokeSelfMaintenanceInstallCore211($plan,$ops,[scriptblock]$authority,[scriptblock]$observer){
 $r=InstallPlan211 $plan
 InstallRequire211 ($ops -is [Collections.IDictionary] -and $null -ne $observer) 'INSTALL_CAPTURED_FACADE_AND_OBSERVER_REQUIRED'
 foreach($name in @('identity','journal','enroll','verify_enrollment','task_missing','account_name','resolve_sid','register','verify_registered','instance','run','write_new')){InstallRequire211 ($ops[$name] -is [scriptblock]) 'INSTALL_CLOSED_REQUIRED_OPERATION'}
 $phase='authority';$registrationAttempted=$false;$registrationReturned=$false;$runAttempted=$false;$instance=$null;$origin=$null
 try{
  InstallCurrent211 $plan 'before-enroll' $authority
  InstallIdentity211 $r (& $ops.identity)
  InstallRequire211 (& $ops.task_missing $r.task_name) 'INSTALL_TASK_COLLISION_NO_ADOPTION'
  & $ops.journal 'intent' @{purpose=$plan.purpose;attempt_id=$plan.attempt_id;automatic_retry=$false}
  $phase='enroll';$enrollment=& $ops.enroll $r
  $fixed=& $ops.verify_enrollment $r $enrollment
  InstallKeys211 $fixed @('xml','binding_sha256','scheduler_xml_sha256')
  foreach($k in @('binding_sha256','scheduler_xml_sha256')){InstallRequire211 ($fixed.$k -is [string] -and $fixed.$k -cmatch '\A[a-f0-9]{64}\z') 'INSTALL_ENROLLMENT_HASH'}
  InstallRequire211 ($fixed.xml -is [string] -and $fixed.xml.Length -le 65536) 'INSTALL_ENROLLED_XML_BOUND'
  $account=& $ops.account_name $r.expected_sid
  InstallRequire211 ($account -is [string] -and (InstallSame211 (& $ops.resolve_sid $account) $r.expected_sid)) 'INSTALL_SELF_ACCOUNT_SID_ROUNDTRIP'
  # Observer approval is independent and phase-bound; it cannot be supplied by
  # enrollment output or by the Self process's successful exit.
  InstallObserverPhase211 $plan 'enrolled-before-register' $fixed $observer
  InstallCurrent211 $plan 'before-register' $authority
  InstallIdentity211 $r (& $ops.identity)
  InstallRequire211 (& $ops.task_missing $r.task_name) 'INSTALL_TASK_COLLISION_BEFORE_REGISTER'
  $phase='self-register-worker';$registrationAttempted=$true
  $task=& $ops.register $r $fixed.xml $account
  $registrationReturned=$true
  $xmlHash=& $ops.verify_registered $task $r $fixed.xml
  InstallRequire211 ($xmlHash -is [string] -and $xmlHash -cmatch '\A[a-f0-9]{64}\z') 'INSTALL_REGISTERED_FULL_XML_HASH'
  InstallCurrent211 $plan 'after-register' $authority
  $registeredFixed=[pscustomobject]@{binding_sha256=$fixed.binding_sha256;scheduler_xml_sha256=$xmlHash}
  InstallObserverPhase211 $plan 'registered-worker' $registeredFixed $observer
  # Original schedule has an enabled current TimeTrigger/StartWhenAvailable.
  # Registration can naturally start it. Observe first; never issue Run merely
  # because the caller expected triggerless qualification-task behavior.
  $phase='observe-triggered-worker';$instance=& $ops.instance $task $xmlHash
  if($null -eq $instance){
   InstallCurrent211 $plan 'before-run' $authority
   InstallIdentity211 $r (& $ops.identity)
   InstallObserverPhase211 $plan 'before-initial-run-if-empty' $registeredFixed $observer
   # Recheck immediately after live authority/BA. If a trigger won the race,
   # observe it. The original IgnoreNew policy is retained for the final race.
   $instance=& $ops.instance $task $xmlHash
   if($null -eq $instance){$phase='self-run-worker-once';$runAttempted=$true;$null=& $ops.run $task;$origin='EXPLICIT_INITIAL_RUN_REQUEST'}else{$origin='NATURAL_TRIGGER_BEFORE_RUN'}
  }else{$origin='NATURAL_TRIGGER_AFTER_REGISTER'}
  if($null -eq $instance){$instance=& $ops.instance $task $xmlHash}
  InstallInstance211 $instance
  InstallCurrent211 $plan 'observe-worker' $authority
  $proof=& $observer 'actual-worker' $plan $instance
  InstallKeys211 $proof @('status','attempt_id','actor_packet_sha256','worker_pid','worker_instance_guid','registered_xml_sha256')
  InstallRequire211 ((InstallSame211 $proof.status 'INDEPENDENT_WORKER_OBSERVED') -and (InstallSame211 $proof.attempt_id $plan.attempt_id) -and (InstallSame211 $proof.actor_packet_sha256 $plan.actor_packet_sha256) -and $proof.worker_pid -is [int] -and $proof.worker_pid -eq $instance.pid -and (InstallSame211 $proof.worker_instance_guid $instance.guid) -and (InstallSame211 $proof.registered_xml_sha256 $xmlHash)) 'INSTALL_INDEPENDENT_WORKER_PROOF'
  $record=[ordered]@{schema='clued.self-maintenance-install-result211/1';status='SELF_INSTALLED_WORKER_OBSERVED_AWAITING_LIFECYCLE';purpose=$plan.purpose;node_id=$r.node_id;attempt_id=$plan.attempt_id;phase='worker-observed';registration_attempted=$registrationAttempted;registration_returned=$registrationReturned;run_request_attempted=$runAttempted;start_observation=$origin;worker_pid=$instance.pid;worker_instance_guid=$instance.guid;registered_xml_sha256=$xmlHash;windows_lifecycle_qualified=$false;natural_retirement_qualified=$false;production_producer_qualified=$false;panel_qualified=$false;automatic_retry=$false}
 }catch{
  $record=[ordered]@{schema='clued.self-maintenance-install-result211/1';status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';purpose=$plan.purpose;node_id=$r.node_id;attempt_id=$plan.attempt_id;phase=$phase;registration_attempted=$registrationAttempted;registration_returned=$registrationReturned;run_request_attempted=$runAttempted;unknown_effect_extent=($registrationAttempted -or $phase -ceq 'enroll');automatic_retry=$false}
 }
 & $ops.write_new 'self-install211.result.json' $record
 return $record
}
function InstallObserveInstance217($task,[string]$xmlHash,[int]$timeoutMs=20000,[bool]$waitForFirst=$false){
 InstallRequire211 ($timeoutMs -gt 0 -and $timeoutMs -le 20000) 'INSTALL_INSTANCE_WAIT_BOUND'
 $end=[Diagnostics.Stopwatch]::StartNew();$seen=$null
 while($true){
  $hash=BytesHash ([Text.Encoding]::UTF8.GetBytes([string]$task.Xml));InstallRequire211 (InstallSame211 $hash $xmlHash) 'INSTALL_REGISTERED_XML_CHANGED'
  $items=$task.GetInstances(0);InstallRequire211 ($items.Count -ge 0 -and $items.Count -le 1) 'INSTALL_MULTIPLE_OR_UNKNOWN_INSTANCES'
  if($items.Count -eq 0){InstallRequire211 ($null -eq $seen) 'INSTALL_OBSERVED_INSTANCE_DISAPPEARED';if(-not $waitForFirst){return $null};InstallRequire211 ($end.ElapsedMilliseconds -lt $timeoutMs) 'INSTALL_INSTANCE_START_TIMEOUT_PRESERVE_NO_RETRY';Start-Sleep -Milliseconds ([Math]::Min(100,$timeoutMs));continue}
  $item=$items.Item(1);$guid=[string]$item.InstanceGuid
  InstallRequire211 ($guid -cmatch '\A\{[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}\}\z') 'INSTALL_INSTANCE_GUID'
  if($null -eq $seen){$seen=$guid}else{InstallRequire211 (InstallSame211 $guid $seen) 'INSTALL_INSTANCE_GUID_CHANGED_NO_ADOPTION'}
  if($item.EnginePID -gt 0 -and $item.State -eq 4){$actual=[pscustomobject](TaskOne $task $xmlHash);InstallRequire211 (InstallSame211 $actual.guid $seen) 'INSTALL_INSTANCE_GUID_CHANGED_NO_ADOPTION';return $actual}
  InstallRequire211 ($end.ElapsedMilliseconds -lt $timeoutMs) 'INSTALL_INSTANCE_START_TIMEOUT_PRESERVE_NO_RETRY'
  Start-Sleep -Milliseconds ([Math]::Min(100,$timeoutMs))
 }
}
function NewSelfMaintenanceSchedulerFacade211($plan,[scriptblock]$enroll,[scriptblock]$verifyEnrollment,[scriptblock]$journal,[scriptblock]$writeNew){
 # Must remain private in the accepted captured target-SID stage. This factory
 # never starts another account or registers a temporary installation Task.
 # Reused Self token/XML/identity dependencies must already be hash-loaded.
 $r=InstallPlan211 $plan
 # Never accept a pre-connected COM service from another identity or host.
 # This no-argument Connect binds the local service in this actual Self thread.
 $thread=[Security.Principal.WindowsIdentity]::GetCurrent($true);if($null -ne $thread){$thread.Dispose();throw 'INSTALL_THREAD_IMPERSONATION_FORBIDDEN'}
 $id=[Security.Principal.WindowsIdentity]::GetCurrent();try{InstallRequire211 ((InstallSame211 $id.User.Value $r.expected_sid) -and -not (TestSelfTokenAdminSid $id)) 'INSTALL_SELF_COM_CONNECTION_ONLY'}finally{$id.Dispose()}
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
 $instanceState=@{run_requested=$false}
 $ops=@{
  identity={
   $thread=[Security.Principal.WindowsIdentity]::GetCurrent($true);if($null -ne $thread){$thread.Dispose();throw 'INSTALL_THREAD_IMPERSONATION_FORBIDDEN'}
   $id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]::new($id);$held=[CluedQualification181.HeldProcess]::new($PID)
   try{$s=$held.Observe();InstallRequire211 ($s.Pid -eq $PID -and $s.Sid -ceq $id.User.Value) 'INSTALL_OWN_HELD_TOKEN';$admin=TestSelfTokenAdminSid $id;return [pscustomobject]@{host=[Environment]::MachineName;sid=$s.Sid;elevated=[bool]$s.Elevated;admin_enabled=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);admin_sid_present=$admin;thread_impersonation=$false;process_id=[int]$PID}}finally{$held.Dispose();$id.Dispose()}
  }
  journal=$journal;enroll=$enroll;verify_enrollment=$verifyEnrollment;write_new=$writeNew
  task_missing={param($name)AbsentTask $folder $name;return $true}.GetNewClosure()
  account_name={param($sid)ResolveRegistrationAccountName $sid}
  resolve_sid={param($name)ResolveTaskPrincipalSid $name}
  register={param($row,$xml,$account)
   # Existing full template checker retains S4U/LeastPrivilege/IgnoreNew,
   # exact pythonw argv and working directory, no extra actions/triggers.
   CheckWorkerXml $xml $row $row.source $row.managed
   $folder.RegisterTask($row.task_name,$xml,2,$account,$null,2,$null)
  }.GetNewClosure()
  verify_registered={param($task,$row,$xml)CheckRegisteredTask $task $xml ('\'+$row.task_name) $scheduler}.GetNewClosure()
  instance={param($task,$xmlHash)
   return InstallObserveInstance217 $task $xmlHash 20000 $instanceState.run_requested
  }
  run={param($task)InstallRequire211 (-not $instanceState.run_requested) 'INSTALL_INITIAL_RUN_ALREADY_REQUESTED';$instanceState.run_requested=$true;$null=$task.Run($null)}
 }
 $deps=@('InstallObserveInstance217','InstallRequire211','InstallSame211','InstallKeys211','TestSelfTokenAdminSid','SelfRequire','AbsentTask','Require','ResolveRegistrationAccountName','ResolveTaskPrincipalSid','TaskDefinitionRequire','CheckWorkerXml','SameArgv','CheckRegisteredTask','TaskXmlDocument','TaskXmlShape','BytesHash','TaskOne')
 foreach($name in @('identity','task_missing','account_name','resolve_sid','register','verify_registered','instance','run')){
  $callback=$ops[$name].GetNewClosure()
  $ops[$name]=InstallBindPrivateCallback212 $callback $deps
 }
 return $ops
}
function InvokeBoundSelfMaintenanceInstall211 {
 # No production root resolver currently mints the installation-purpose
 # capability. Keep this actual public entry closed until its exact Source,
 # independent Role and physical Owner acceptance are present and integrated.
 throw 'INSTALL_PURPOSE_SOURCE_ROLE_OWNER_PRIVATE_INGRESS_NOT_ATTACHED'
}
if($MyInvocation.InvocationName -ne '.'){@{schema='clued.self-maintenance-install-preview211/1';status='CAPTURED_INSTALL_PURPOSE_REQUIRED';enrollment=$false;registration=$false;run=$false;execution_authority=$false}|ConvertTo-Json -Compress}
