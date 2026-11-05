# Read-only installation observer. No enrollment, RegisterTask, Run, task
# deletion, process spawn, private-directory creation or ACL modification.
function AssertInstallBA212 {
 $thread=[Security.Principal.WindowsIdentity]::GetCurrent($true);if($null -ne $thread){$thread.Dispose();throw 'INSTALL_OBSERVER_IMPERSONATION_FORBIDDEN'}
 $id=[Security.Principal.WindowsIdentity]::GetCurrent();try{QualNeed212 (([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'INSTALL_OBSERVER_ACTUAL_BA_REQUIRED'}finally{$id.Dispose()}
 $held=[CluedQualification181.HeldProcess]::new($PID);try{QualNeed212 ($held.Observe().Elevated -eq 1) 'INSTALL_OBSERVER_ELEVATED_PRIMARY_REQUIRED'}finally{$held.Dispose()}
}
function InstallReadFiles212($r){
 # Exact original Source11 pins, bound inside the captured enrollment adapter.
 $source=NewCapturedSelfEnrollment211 ([byte[]]$script:InstallEnrollmentBytes212)
 $bindingPath=Join-Path $r.managed 'binding.json';$xmlPath=Join-Path $r.managed ('scheduler\clued-cache-'+$r.node_id+'.xml')
 $binding=[CluedQualification181.SafeEvidence]::Read($bindingPath,16384,$r.expected_sid);$xml=[CluedQualification181.SafeEvidence]::Read($xmlPath,65536,$r.expected_sid)
 # Invoke only the read-only verifier; the enroll scriptblock is never called
 # or returned by this observer. The verifier reopens every Source11/binding/XML.
 return (& $source.verify_enrollment $r ([pscustomobject]@{binding_sha256=(BytesHash $binding);scheduler_xml_sha256=(BytesHash $xml)}))
}
function InstallWorkerFacts212($r,$instance,$first,$second,[string[]]$argv,[string[]]$expectedArgv){
 InstallInstance211 $instance
 foreach($s in @($first,$second)){
  QualNeed212 ($s.Pid -is [int] -and $s.Pid -eq $instance.pid -and $s.Sid -is [string] -and $s.Sid -ceq $r.expected_sid -and $s.Elevated -is [int] -and $s.Elevated -eq 0 -and $s.Image -is [string] -and [StringComparer]::OrdinalIgnoreCase.Equals($s.Image,$r.pythonw) -and ($s.CreationFileTime -is [long] -or $s.CreationFileTime -is [int]) -and $s.CreationFileTime -gt 0 -and $s.ParentPid -is [int] -and $s.ParentPid -gt 0) 'INSTALL_OBSERVER_WORKER_PRIMARY_IDENTITY'
 }
 foreach($n in @('Pid','Sid','Elevated','Image','CreationFileTime','ParentPid')){QualNeed212 ([object]::Equals($first.$n,$second.$n)) 'INSTALL_OBSERVER_WORKER_HELD_CONTINUITY'}
 SameArgv $argv $expectedArgv
}
function ObserveInstalledWorker212($r,$task,[string]$xmlHash,$claimed){
 # Bounded read-only startup observation; no second Register/Run and no adoption
 # of a new GUID while waiting for an already observed instance to start.
 $end=[DateTime]::UtcNow.AddSeconds(20);$seenGuid=$null;$actual=$null
 while($true){
  QualString212 (BytesHash ([Text.Encoding]::UTF8.GetBytes([string]$task.Xml))) $xmlHash
  $items=$task.GetInstances(0);QualNeed212 ($items.Count -le 1 -and $items.Count -ge 0) 'INSTALL_OBSERVER_MULTIPLE_WORKERS'
  if($items.Count -eq 1){$item=$items.Item(1);$guid=[string]$item.InstanceGuid
   if($null -ne $seenGuid){QualString212 $guid $seenGuid}else{$seenGuid=$guid}
   if($item.EnginePID -gt 0 -and $item.State -eq 4){$actual=[pscustomobject](TaskOne $task $xmlHash);break}
  }
  QualNeed212 ([DateTime]::UtcNow -lt $end) 'INSTALL_OBSERVER_WORKER_START_UNKNOWN';Start-Sleep -Milliseconds 100
 }
 InstallInstance211 $actual;InstallInstance211 $claimed;QualNeed212 ($actual.pid -eq $claimed.pid) 'INSTALL_OBSERVER_SELF_CLAIMED_PID';QualString212 $actual.guid $claimed.guid;QualString212 $actual.xml_hash $claimed.xml_hash
 $held=[CluedQualification181.HeldProcess]::new($actual.pid)
 try{
  $before=$held.Observe();$argv=[CluedQualification181.CommandLine]::Parse($held.ReadCommandLine())
  $expected=@($r.pythonw,(Join-Path $r.source 'scripts\ci\self-hosted\resource-maintenance\maintenance.py'),'--registry',(Join-Path $r.source 'config\ci-resource-maintenance.json'),'--registry-sha256','f8f3ee9711689993b5a9d663961c72b70b1b1dc7c13dd0252d7ec5e2fe5a2d9a','--binding',(Join-Path $r.managed 'binding.json'),'worker')
  Start-Sleep -Milliseconds 250;$after=$held.Observe();InstallWorkerFacts212 $r $actual $before $after $argv $expected
  $again=[pscustomobject](TaskOne $task $xmlHash);QualNeed212 ($again.pid -eq $actual.pid) 'INSTALL_OBSERVER_TASK_PID_CONTINUITY';QualString212 $again.guid $actual.guid
  $null=InstallReadFiles212 $r;MachineRuntimeAcl $r.pythonw;QualString212 (Hash $r.pythonw) $r.pythonw_sha256
  return $actual
 }finally{$held.Dispose()}
}
function NewReadonlyInstallObserver212($plan,$qualification,[byte[]]$capturedEnrollment,[scriptblock]$installAuthority,[scriptblock]$qualificationAuthority){
 # Caller supplies only the independently captured internal Root callbacks.
 # No caller/provider JSON can stand in for accepted Source/Role/Owner/claim.
 $r=InstallPlan211 $plan;InstallCurrent211 $plan 'before-enroll' $installAuthority
 QualExpect212 $qualification;QualString212 $qualification.host $r.host;QualString212 $qualification.node_id $r.node_id;QualString212 $qualification.expected_sid $r.expected_sid
 QualString212 $r.host ([Environment]::MachineName);AssertInstallBA212
 $qualified=ReadActualSelfQualification212 $qualification $qualificationAuthority
 $script:InstallEnrollmentBytes212=[byte[]]$capturedEnrollment.Clone()
 # Verify exact held code now, before any actual installed-path read. This
 # constructor creates callbacks only and does not invoke the enrollment one.
 $null=NewCapturedSelfEnrollment211 ([byte[]]$script:InstallEnrollmentBytes212)
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
 $observer={param($phase,$receivedPlan,$fixed)
  AssertInstallBA212
  QualString212 $receivedPlan.actor_packet_sha256 $plan.actor_packet_sha256;QualString212 $receivedPlan.attempt_id $plan.attempt_id
  # Fixed target comes from the captured plan; no received row/path is used.
  InstallCurrent211 $plan 'observe-worker' $installAuthority;QualCurrent212 $qualification $qualificationAuthority
  $raw=[CluedQualification181.SafeEvidence]::Read($r.request_path,16384,'S-1-5-32-544');QualString212 (BytesHash $raw) $r.request_sha256
  $request=SelfStrictJson ([Text.UTF8Encoding]::new($false,$true).GetString($raw));QualKeys212 $request @('schema','node_id','host','expected_sid','python','python_sha256','pythonw','pythonw_sha256','home','source_staging','output_dir','release_path','nonce')
  QualString212 $request.schema 'clued.windows-maintenance-install-request181/1';foreach($k in @('host','node_id','expected_sid','python','python_sha256','pythonw','pythonw_sha256','home')){QualString212 $request.$k $r.$k}
  QualString212 $request.source_staging 'C:\ProgramData\CluedCacheInstallSelf211\Stage\Source1.0.1';QualString212 $request.output_dir ('C:\ProgramData\CluedCacheInstallSelf211\Outputs\'+$r.node_id);QualString212 $request.release_path ('C:\ProgramData\CluedCacheInstallSelf211\Control\'+$r.node_id+'\release.json');QualNeed212 ($request.nonce -is [string] -and $request.nonce -cmatch '\A[a-f0-9]{32}\z') 'INSTALL_OBSERVER_REQUEST_NONCE'
  $files=InstallReadFiles212 $r
  if($phase -ceq 'enrolled-before-register'){
   AbsentTask $folder $r.task_name
   QualString212 $files.binding_sha256 $fixed.binding_sha256;QualString212 $files.scheduler_xml_sha256 $fixed.scheduler_xml_sha256
  }elseif($phase -cin @('registered-worker','before-initial-run-if-empty','actual-worker')){
   $task=$folder.GetTask($r.task_name);$registered=CheckRegisteredTask $task $files.xml ('\'+$r.task_name) $scheduler
   if($phase -ceq 'actual-worker'){
    QualString212 $registered $fixed.xml_hash;$actual=ObserveInstalledWorker212 $r $task $registered $fixed
    return [pscustomobject]@{status='INDEPENDENT_WORKER_OBSERVED';attempt_id=$plan.attempt_id;actor_packet_sha256=$plan.actor_packet_sha256;worker_pid=$actual.pid;worker_instance_guid=$actual.guid;registered_xml_sha256=$registered}
   }
   QualString212 $files.binding_sha256 $fixed.binding_sha256;QualString212 $registered $fixed.scheduler_xml_sha256
   $files.scheduler_xml_sha256=$registered
  }else{throw 'INSTALL_OBSERVER_UNKNOWN_PHASE'}
  return [pscustomobject]@{status='INDEPENDENT_INSTALL_PHASE_READY';phase=$phase;attempt_id=$plan.attempt_id;actor_packet_sha256=$plan.actor_packet_sha256;binding_sha256=$files.binding_sha256;scheduler_xml_sha256=$files.scheduler_xml_sha256;source_11_match=$true}
 }.GetNewClosure()
 $names=@('AssertInstallBA212','InstallPlan211','InstallCurrent211','InstallKeys211','InstallRequire211','InstallSame211','QualCurrent212','QualKeys212','QualNeed212','QualString212','QualRelative212','QualHash212','QualExpect212','InstallReadFiles212','NewCapturedSelfEnrollment211','InstallBindPrivateCallback212','InstallWorkerFacts212','InstallInstance211','ObserveInstalledWorker212','AbsentTask','CheckRegisteredTask','TaskXmlDocument','TaskXmlShape','CheckWorkerXml','SameArgv','Require','TaskOne','BytesHash','Hash','MachineRuntimeAcl','NoReparse','SelfStrictJson','SelfRequire')
 $observer=InstallBindPrivateCallback212 $observer $names
 # Bind the cloned held code only to this observer's private module, not Host
 # globals and not a caller-selected path. No currentness cache crosses phases.
 & $observer.Module {param([byte[]]$code)$script:InstallEnrollmentBytes212=$code.Clone();Export-ModuleMember -Function @()} ([byte[]]$script:InstallEnrollmentBytes212)
 return $observer
}
