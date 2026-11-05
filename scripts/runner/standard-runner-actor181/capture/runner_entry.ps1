param([switch]$ExecuteAcceptedRunner)
$ErrorActionPreference='Stop'
function EntryNamespaceDescriptors($asts){
 $result=@();$seen=@{}
 foreach($ast in $asts){foreach($node in $ast.EndBlock.Statements){if($node -isnot [Management.Automation.Language.FunctionDefinitionAst]){continue};if($seen.ContainsKey($node.Name)){throw 'CAPTURED_NAMESPACE_DECLARATION_COLLISION'};$seen[$node.Name]=$true;$result+=@{name=$node.Name;text=$node.Extent.Text}}}
 return ,$result
}
function EntryOwnedNamespace($owner,$descriptors){
 if($owner -isnot [Management.Automation.PSModuleInfo]){throw 'PRIVATE_CAPTURED_OWNER_MODULE_REQUIRED'}
 return (& $owner {param($declarations)
  $map=@{}
  foreach($d in $declarations){
   $item=Get-Item -LiteralPath ('Function:\'+$d.name) -ErrorAction Stop
   if($item -isnot [Management.Automation.FunctionInfo] -or -not [Object]::ReferenceEquals($item.Module,$ExecutionContext.SessionState.Module) -or -not [Object]::ReferenceEquals($item.ScriptBlock.Module,$ExecutionContext.SessionState.Module) -or $item.ScriptBlock.Ast.Extent.Text -cne $d.text){throw 'CAPTURED_NAMESPACE_FUNCTION_NOT_EXACT'}
   if($map.ContainsKey($d.name)){throw 'CAPTURED_NAMESPACE_FUNCTION_COLLISION'};$map[$d.name]=$item.ScriptBlock
  }
  return @{owner=$ExecutionContext.SessionState.Module;functions=$map}
 } $descriptors)
}
function EntryDriverNamespace {
 $root=$MyInvocation.MyCommand.ScriptBlock.Ast;while($root.Parent){$root=$root.Parent}
 return (EntryOwnedNamespace $ExecutionContext.SessionState.Module (EntryNamespaceDescriptors @($root)))
}
function BindEntryClosures($value,$namespace){
 if($namespace -isnot [Collections.IDictionary] -or $namespace.functions -isnot [Collections.IDictionary] -or $namespace.owner -isnot [Management.Automation.PSModuleInfo]){throw 'CAPTURED_NAMESPACE_REQUIRED'}
 if($value -is [scriptblock]){
  if($null -eq $value.Module){throw 'CLOSURE_WITHOUT_PRIVATE_MODULE_REFUSED'}
  # A declaration already bound to the verified owner has that namespace.
  # Only detached GetNewClosure modules need a private helper installation.
  if([Object]::ReferenceEquals($value.Module,$namespace.owner)){return $value}
  & $value.Module {param($functions,$closure,$namespaceOwner)
   $registry=Get-Variable -Name __clued181_private_namespace -Scope Script -ErrorAction SilentlyContinue
   if($null -ne $registry){
    if(-not [Object]::ReferenceEquals($registry.Value.closure,$closure) -or -not [Object]::ReferenceEquals($registry.Value.module,$ExecutionContext.SessionState.Module) -or -not [Object]::ReferenceEquals($registry.Value.namespace_owner,$namespaceOwner) -or ((($registry.Value.functions.Keys|Sort-Object)-join '|') -cne (($functions.Keys|Sort-Object)-join '|'))){throw 'CLOSURE_NAMESPACE_REBIND_REFUSED'}
    foreach($name in $functions.Keys){$old=Get-Item -LiteralPath ('Function:\'+$name) -ErrorAction Stop;$expected=$registry.Value.functions[$name];if(-not [Object]::ReferenceEquals($expected,$functions[$name]) -or -not [Object]::ReferenceEquals($old.ScriptBlock.Module,$expected.Module) -or $old.ScriptBlock.Ast.Extent.Text -cne $expected.Ast.Extent.Text){throw 'CLOSURE_HELPER_CHANGED'}}
    return
   }
   # This fresh GetNewClosure module has not escaped its verified factory.
   # Install local definitions directly; never resolve inherited/global names.
   foreach($name in $functions.Keys){
    $definition=$functions[$name]
    if($definition -isnot [scriptblock] -or -not [Object]::ReferenceEquals($definition.Module,$namespaceOwner)){throw 'UNBOUND_HELPER_REFUSED'}
    Set-Item -Path ('Function:script:'+$name) -Value $definition -ErrorAction Stop
   }
   $snapshot=@{};foreach($name in $functions.Keys){$snapshot[$name]=$functions[$name]};Set-Variable -Name __clued181_private_namespace -Scope Script -Value @{closure=$closure;module=$ExecutionContext.SessionState.Module;namespace_owner=$namespaceOwner;functions=$snapshot} -Option ReadOnly
   Export-ModuleMember -Function @()
  } $namespace.functions $value $namespace.owner
 }elseif($value -is [Collections.IDictionary]){foreach($key in @($value.Keys)){if($value[$key] -is [scriptblock] -or $value[$key] -is [Collections.IDictionary]){$null=BindEntryClosures $value[$key] $namespace}}}
 else{throw 'CLOSURE_CONTAINER_REQUIRED'}
 return $value
}

function RunnerRequire($ok,[string]$code){if($ok -isnot [bool] -or -not $ok){throw [InvalidOperationException]::new($code)}}
function RunnerHash([byte[]]$raw){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function RunnerKeys($value,[string[]]$keys){RunnerRequire ($value -is [pscustomobject] -and (($value.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'RUNNER_CLOSED_OBJECT'}
function RunnerString($value,[string]$expected){RunnerRequire ($value -is [string] -and $value -ceq $expected) 'RUNNER_STRING_BINDING'}
function RunnerClone($value){return ($value|ConvertTo-Json -Depth 12 -Compress|ConvertFrom-Json)}
function RunnerSourcePins {return [ordered]@{
 actor='c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616'
 identity='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8'
 definition='0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4'
 registration='642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb'
}}
function RunnerExpectedObserverCaptureSha256 {return '17c85ea6052ce15f4d501316247009ff374aebc435841e016fabd609fd7d12e3'}
function CopyRunnerSourceCapture($candidate){
 $pins=RunnerSourcePins;RunnerRequire ($candidate -is [Collections.IDictionary] -and (($candidate.Keys|Sort-Object)-join '|') -ceq (($pins.Keys|Sort-Object)-join '|')) 'RUNNER_EXACT_SOURCE_MEMBERS'
 $private=@{};$manifest=@()
 # Complete capture and hash/parse of every member precedes any code loading.
 foreach($key in $pins.Keys){RunnerRequire ($candidate[$key] -is [byte[]] -and $candidate[$key].Length -gt 0 -and $candidate[$key].Length -le 1048576) 'RUNNER_SOURCE_BOUND';$private[$key]=[byte[]]$candidate[$key].Clone();RunnerString (RunnerHash $private[$key]) $pins[$key]
  if($key -cne 'identity'){$errors=$null;$tokens=$null;$null=[Management.Automation.Language.Parser]::ParseInput([Text.UTF8Encoding]::new($false,$true).GetString($private[$key]),[ref]$tokens,[ref]$errors);RunnerRequire ($errors.Count -eq 0) 'RUNNER_SOURCE_PARSE'}
  $manifest+=([ordered]@{member=$key;sha256=$pins[$key]})
 }
 $digest=RunnerHash ([Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Compress)))
 return @{bytes=$private;source_capture_sha256=$digest;members=$manifest}
}
function NewBoundSelfRegistrationModule($captured){
 $capture=CopyRunnerSourceCapture $captured
 foreach($assembly in [AppDomain]::CurrentDomain.GetAssemblies()){RunnerRequire ($null -eq $assembly.GetType('CluedQualification181.HeldProcess',$false)) 'RUNNER_PREEXISTING_IDENTITY_TYPE_REFUSED'}
 $moduleBody={
  param($source,$binder)
  $script:closureBinder=$binder;$script:capturedNamespace=$null
  $ErrorActionPreference='Stop'
  $assembly=[Reflection.Assembly]::Load([byte[]]$source.identity)
  if([CluedQualification181.HeldProcess].Assembly -ne $assembly){throw 'RUNNER_IDENTITY_TYPE_COLLISION'}
  foreach($key in @('actor','definition','registration')){. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($source[$key])))}
  $script:spent=$false
  $script:api=@{registration_guard_checks=0;registration_guard_passes=0;registration_api_call_count=0;registration_api_returned=$false;run_guard_checks=0;run_guard_passes=0;run_api_call_count=0;run_api_returned=$false}
  function GetCapturedApiObservation {return ($script:api|ConvertTo-Json -Compress|ConvertFrom-Json)}
  function GetCapturedRunnerTarget {return (SelfTarget ([Environment]::MachineName)|ConvertTo-Json -Compress|ConvertFrom-Json)}
  function GetCapturedRunnerIdentity {
   $target=SelfTarget ([Environment]::MachineName)
   $thread=[Security.Principal.WindowsIdentity]::GetCurrent($true);if($null -ne $thread){$thread.Dispose();throw 'RUNNER_THREAD_IMPERSONATION_FORBIDDEN'}
   $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$held=[CluedQualification181.HeldProcess]::new($PID)
   try{
    $snapshot=$held.Observe();SelfRequire ($snapshot.Pid -eq $PID -and $snapshot.Sid -ceq $identity.User.Value) 'RUNNER_OWN_PRIMARY_HELD_SID'
    $image=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';SelfRequire ($snapshot.Image -ieq $image) 'RUNNER_FIXED_HOST_IMAGE'
    $principal=[Security.Principal.WindowsPrincipal]::new($identity)
    $facts=@{sid=$snapshot.Sid;elevated=[bool]$snapshot.Elevated;admin_enabled=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);admin_sid_present=(TestSelfTokenAdminSid $identity);process_id=[int]$PID}
    SelfValidateIdentity $target $facts
    $expectedRunner=@{'DESK-W-591'='clued-ci-company-win-01';'TURING'='clued-ci-home-win-01'}
    SelfRequire ([Environment]::GetEnvironmentVariable('RUNNER_NAME','Process') -ceq $expectedRunner[$target.host]) 'RUNNER_EXACT_ACTIONS_NAME_REQUIRED'
    return [pscustomobject]$facts
   }finally{$held.Dispose();$identity.Dispose()}
  }
  function InvokeCapturedSelfOnce($binding,$liveAdmissionGuard){
   if($script:spent){throw 'RUNNER_ALREADY_ATTEMPTED_NO_RETRY'}
   $null=GetCapturedRunnerIdentity
   $target=SelfTarget ([Environment]::MachineName)
   foreach($field in @('host','node_id')){SelfRequire ($binding.$field -is [string] -and $binding.$field -ceq $target.$field) 'RUNNER_PRIVATE_TARGET_BINDING'}
   SelfRequire ($binding.attempt_id -is [string] -and $binding.attempt_id -cmatch '^[0-9a-f]{32}$' -and $binding.accepted_subject_sha256 -is [string] -and $binding.accepted_subject_sha256 -cmatch '^[0-9a-f]{64}$') 'RUNNER_PRIVATE_ATTEMPT_BINDING'
   SelfRequire ($liveAdmissionGuard -is [scriptblock]) 'RUNNER_TRUSTED_ENTRY_RECHECK_REQUIRED'
   $script:spent=$true
   # Exact captured actor/helper declarations, no second source/DLL path open.
   $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
   $ops=NewSelfRegistrationRealFacade $folder $scheduler
   $null=& $script:closureBinder $ops $script:capturedNamespace
   $capturedRegister=$ops.register;$capturedRun=$ops.run_once;$guardState=@{register_spent=$false;run_spent=$false};$api=$script:api
   # Mechanical fresh check from the already-resolved trusted provider, directly
   # after actor admit/build/readback and before the original COM call. This is
   # not a caller-supplied authority interface on the public entry.
   $ops.register={param($name,$definition,$accountName)
    SelfRequire (-not $guardState.register_spent) 'RUNNER_REGISTER_ONCE_AFTER_LIVE_OBSERVER'
    $guardState.register_spent=$true;$api.registration_guard_checks++;$null=& $liveAdmissionGuard 'register';$api.registration_guard_passes++
    $api.registration_api_call_count++;$value=& $capturedRegister $name $definition $accountName;$api.registration_api_returned=$true;return $value
   }.GetNewClosure()
   $ops.run_once={param($actual)
    SelfRequire (-not $guardState.run_spent) 'RUNNER_RUN_ONCE_AFTER_LIVE_OBSERVER'
    $guardState.run_spent=$true;$api.run_guard_checks++;$null=& $liveAdmissionGuard 'run';$api.run_guard_passes++
    $api.run_api_call_count++;$value=& $capturedRun $actual;$api.run_api_returned=$true;return $value
   }.GetNewClosure()
   $null=& $script:closureBinder $ops $script:capturedNamespace
   return (InvokeSelfRegistrationCore $target $ops $binding.attempt_id $binding.accepted_subject_sha256)
  }
  Export-ModuleMember -Function @()
 }
 $binder=(Get-Item -LiteralPath 'Function:\BindEntryClosures').ScriptBlock
 $module=New-Module -Name CluedCapturedSelfRunner181 -ArgumentList $capture.bytes,$binder -ScriptBlock $moduleBody
 $asts=@($moduleBody.Ast)
 foreach($key in @('actor','definition','registration')){$errors=$null;$tokens=$null;$asts+=([Management.Automation.Language.Parser]::ParseInput([Text.UTF8Encoding]::new($false,$true).GetString($capture.bytes[$key]),[ref]$tokens,[ref]$errors))}
 $namespace=EntryOwnedNamespace $module (EntryNamespaceDescriptors $asts)
 & $module {param($capturedNamespace)$script:capturedNamespace=$capturedNamespace} $namespace
 return @{module=$module;source_capture_sha256=$capture.source_capture_sha256;members=(RunnerClone ([pscustomobject]@{rows=$capture.members})).rows}
}
function RunnerValidateBinding($binding,$target,$previous=$null){
 RunnerKeys $binding @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','code_captured','channel_bound')
 foreach($key in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id')){RunnerRequire ($binding.$key -is [string]) 'RUNNER_BINDING_STRING'}
 RunnerString $binding.host $target.host;RunnerString $binding.node_id $target.node_id
 RunnerRequire ($binding.attempt_id -cmatch '^[0-9a-f]{32}$' -and $binding.accepted_subject_sha256 -cmatch '^[0-9a-f]{64}$' -and $binding.owner_receipt_id -cmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') 'RUNNER_BINDING_REFERENCE'
 foreach($flag in @('code_captured','channel_bound')){RunnerRequire ($binding.$flag -is [bool] -and $binding.$flag) 'RUNNER_BINDING_UNBOUND'}
 if($null -ne $previous){foreach($key in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id')){RunnerString $binding.$key $previous.$key}}
 return RunnerClone $binding
}
function RunnerValidateObserverReady($value,$binding,$target,$observerCaptureSha256){
 RunnerKeys $value @('schema','role','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256','source_capture_sha256','phase')
 foreach($key in $value.PSObject.Properties.Name){RunnerRequire ($value.$key -is [string]) 'RUNNER_OBSERVER_READY_STRING'}
 RunnerString $value.schema 'clued.windows-self-entry-ready181/1';RunnerString $value.role 'BA_OBSERVER';RunnerString $value.phase 'FACTORY_PREFLIGHT_READY_WAITING_SELF_REGISTERED'
 foreach($key in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id')){RunnerString $value.$key $binding.$key}
 RunnerString $value.predecessor_r9_index_sha256 $target.predecessor_index_sha256;RunnerString $value.request_sha256 $target.request_sha256
 RunnerRequire ($observerCaptureSha256 -is [string] -and $observerCaptureSha256 -cmatch '^[0-9a-f]{64}$') 'RUNNER_TRUSTED_OBSERVER_CAPTURE_REQUIRED';RunnerString $value.source_capture_sha256 $observerCaptureSha256
 return RunnerClone $value
}
function RunnerSafeError($record,[string]$phase){$e=$record.Exception;for($depth=0;$depth -lt 16 -and $e.InnerException;$depth++){$e=$e.InnerException};$type=$e.GetType().FullName;if($type -cnotin @('System.InvalidOperationException','System.UnauthorizedAccessException','System.IO.IOException','System.ComponentModel.Win32Exception','System.Runtime.InteropServices.COMException')){$type='OTHER'};$hr=[int]$e.HResult;$win=$null;if($e -is [ComponentModel.Win32Exception]){$win=[int]$e.NativeErrorCode}elseif(($hr -band 0xffff0000L) -eq 0x80070000L){$win=[int]($hr -band 65535)};return @{phase=$phase;type=$type;hresult=$hr;win32_error=$win;raw_message_persisted=$false}}
function RunnerValidateApiObservation($value){
 RunnerKeys $value @('registration_guard_checks','registration_guard_passes','registration_api_call_count','registration_api_returned','run_guard_checks','run_guard_passes','run_api_call_count','run_api_returned')
 foreach($prefix in @('registration','run')){foreach($suffix in @('guard_checks','guard_passes','api_call_count')){$number=$value.($prefix+'_'+$suffix);RunnerRequire ($number -is [int] -and $number -in @(0,1)) 'RUNNER_API_COUNT_INTEGER'};RunnerRequire ($value.($prefix+'_api_returned') -is [bool]) 'RUNNER_API_RETURNED_BOOL';RunnerRequire ($value.($prefix+'_api_call_count') -le $value.($prefix+'_guard_passes') -and $value.($prefix+'_guard_passes') -le $value.($prefix+'_guard_checks') -and (-not $value.($prefix+'_api_returned') -or $value.($prefix+'_api_call_count') -eq 1)) 'RUNNER_API_COUNTER_ORDER'}
 return RunnerClone $value
}
function RunnerValidateActorResult($record){
 $value=RunnerClone $record;RunnerKeys $value @('schema','host','node_id','sid','task_name','attempt_id','accepted_subject_sha256','status','phase','registration_attempted','registered_returned','intended_xml_sha256','exception_diagnostics','run_attempted','task_instance_guid','engine_pid','task_left_for_explicit_future_decision','automatic_retry','installation','maintenance_qualification')
 foreach($key in @('schema','host','node_id','sid','task_name','attempt_id','accepted_subject_sha256','status','phase')){RunnerRequire ($record.$key -is [string]) 'RUNNER_ACTOR_STRING'}
 RunnerString $record.schema 'clued.windows-self-registration-result181/1';RunnerRequire ($record.host -cin @('DESK-W-591','TURING') -and $record.node_id -cmatch '^[a-z0-9-]{1,63}$' -and $record.sid -cmatch '^S-1-5-21-[0-9-]{1,150}$' -and $record.task_name -ceq ('CluedCacheProbe-'+$record.node_id+'-181') -and $record.attempt_id -cmatch '^[0-9a-f]{32}$' -and $record.accepted_subject_sha256 -cmatch '^[0-9a-f]{64}$') 'RUNNER_ACTOR_SUBJECT'
 RunnerRequire ($record.status -cin @('SELF_REGISTER_RUN_RECORDED_AWAITING_INDEPENDENT_NATIVE_PROOF','UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY') -and $record.phase -cin @('query-exact-task','build-self-definition','register-self-task','compare-registered-definition','await-independent-observer-ack','self-run-once','instance-published')) 'RUNNER_ACTOR_PHASE'
 foreach($key in @('registration_attempted','registered_returned','run_attempted','task_left_for_explicit_future_decision','automatic_retry','installation','maintenance_qualification')){RunnerRequire ($record.$key -is [bool]) 'RUNNER_ACTOR_FLAG'}
 RunnerRequire (-not $record.automatic_retry -and -not $record.installation -and -not $record.maintenance_qualification) 'RUNNER_ACTOR_NO_QUALIFICATION'
 RunnerRequire ($null -eq $record.intended_xml_sha256 -or ($record.intended_xml_sha256 -is [string] -and $record.intended_xml_sha256 -cmatch '^[0-9a-f]{64}$')) 'RUNNER_ACTOR_XML_SHA'
 RunnerRequire ($null -eq $record.engine_pid -or ($record.engine_pid -is [int] -and $record.engine_pid -gt 0)) 'RUNNER_ACTOR_ENGINE_PID'
 RunnerRequire ($null -eq $record.task_instance_guid -or ($record.task_instance_guid -is [string] -and $record.task_instance_guid -cmatch '^\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}$')) 'RUNNER_ACTOR_GUID'
 if($null -ne $record.exception_diagnostics){$original=$record.exception_diagnostics;$errorValue=$value.exception_diagnostics;RunnerKeys $errorValue @('phase','root_exception_type','numeric_hresult','numeric_win32_error','win32_code_source','raw_message_persisted');RunnerRequire ($original.phase -is [string] -and $original.phase -ceq $record.phase -and $original.root_exception_type -is [string] -and $original.root_exception_type -cin @('System.UnauthorizedAccessException','System.InvalidOperationException','System.IO.IOException','System.IO.FileNotFoundException','System.ComponentModel.Win32Exception','System.Runtime.InteropServices.COMException','OTHER') -and $original.numeric_hresult -is [int] -and ($null -eq $original.numeric_win32_error -or $original.numeric_win32_error -is [int]) -and ($null -eq $original.win32_code_source -or ($original.win32_code_source -is [string] -and $original.win32_code_source -cin @('Win32Exception','HRESULT_FROM_WIN32'))) -and $original.raw_message_persisted -is [bool] -and -not $original.raw_message_persisted) 'RUNNER_ACTOR_SAFE_ERROR'}
 return $value
}
function RunnerValidateOutput($kind,$record){
 RunnerRequire ($kind -is [string] -and $kind -cin @('ready','final')) 'RUNNER_OUTPUT_KIND'
 $value=RunnerClone $record
 if($kind -ceq 'ready'){
  RunnerKeys $value @('schema','role','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256','source_capture_sha256','phase')
  foreach($key in $value.PSObject.Properties.Name){RunnerRequire ($record.$key -is [string]) 'RUNNER_READY_OUTPUT_STRING'}
  RunnerString $value.schema 'clued.windows-self-entry-ready181/1';RunnerString $value.role 'SELF_RUNNER';RunnerString $value.phase 'OWN_PROCESS_IDENTITY_VERIFIED'
  RunnerRequire ($value.host -cin @('DESK-W-591','TURING') -and $value.node_id -cmatch '^[a-z0-9-]{1,63}$' -and $value.attempt_id -cmatch '^[0-9a-f]{32}$' -and $value.owner_receipt_id -cmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') 'RUNNER_READY_OUTPUT_ID'
  foreach($key in @('accepted_subject_sha256','predecessor_r9_index_sha256','request_sha256','source_capture_sha256')){RunnerRequire ($value.$key -cmatch '^[0-9a-f]{64}$') 'RUNNER_READY_OUTPUT_SHA'}
 }else{
  RunnerKeys $value @('schema','status','phase','exit_code','actor_status','actor_result','api_observation','actor_call_attempted','exception_diagnostics','qualification','installation','automatic_retry')
  if($null -ne $record.actor_result){$null=RunnerValidateActorResult $record.actor_result};if($null -ne $record.api_observation){$null=RunnerValidateApiObservation $record.api_observation}
  foreach($key in @('schema','status','phase')){RunnerRequire ($record.$key -is [string]) 'RUNNER_FINAL_OUTPUT_STRING'}
  RunnerString $value.schema 'clued.windows-self-runner-entry-result181/1'
  RunnerRequire ($value.status -cin @('SELF_ATTEMPT_RECORDED_NOT_QUALIFICATION','UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY','RUNNER_FINAL_OUTPUT_UNKNOWN')) 'RUNNER_FINAL_OUTPUT_STATUS'
  RunnerRequire ($value.phase -cin @('authority','own-process-identity','verified-observer-ready','authority-before-self','emit-self-ready','single-self-register-run','actor-returned','emit-final','source-capture-or-authority')) 'RUNNER_FINAL_OUTPUT_PHASE'
  RunnerRequire ($record.exit_code -is [int] -and $record.exit_code -in @(0,2) -and $record.actor_call_attempted -is [bool]) 'RUNNER_FINAL_OUTPUT_PRIMITIVE'
  RunnerRequire ($null -eq $record.actor_status -or ($record.actor_status -is [string] -and $record.actor_status -cin @('SELF_REGISTER_RUN_RECORDED_AWAITING_INDEPENDENT_NATIVE_PROOF','UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY'))) 'RUNNER_FINAL_ACTOR_STATUS'
  foreach($key in @('qualification','installation','automatic_retry')){RunnerRequire ($record.$key -is [bool] -and -not $record.$key) 'RUNNER_OUTPUT_NO_QUALIFICATION'}
  if($value.status -ceq 'SELF_ATTEMPT_RECORDED_NOT_QUALIFICATION'){RunnerRequire ($record.exit_code -eq 0 -and $record.actor_call_attempted -and $record.actor_status -ceq 'SELF_REGISTER_RUN_RECORDED_AWAITING_INDEPENDENT_NATIVE_PROOF' -and $null -eq $record.exception_diagnostics) 'RUNNER_SUCCESS_RECORD_ONLY'}else{RunnerRequire ($record.exit_code -eq 2) 'RUNNER_FAILURE_EXIT_REQUIRED'}
  if($null -ne $record.exception_diagnostics){$errorValue=$value.exception_diagnostics;$original=$record.exception_diagnostics;RunnerKeys $errorValue @('phase','type','hresult','win32_error','raw_message_persisted');RunnerRequire ($original.phase -is [string] -and $original.phase -ceq $value.phase -and $original.type -is [string] -and $original.type -cin @('System.InvalidOperationException','System.UnauthorizedAccessException','System.IO.IOException','System.ComponentModel.Win32Exception','System.Runtime.InteropServices.COMException','OTHER') -and $original.hresult -is [int] -and ($null -eq $original.win32_error -or $original.win32_error -is [int]) -and $original.raw_message_persisted -is [bool] -and -not $original.raw_message_persisted) 'RUNNER_SAFE_ERROR_OUTPUT'}
 }
 return $value
}
function NewRunnerStdout {
 $state=@{ready=$false;final=$false;bytes=0}
 $output={param($kind,$record)
  RunnerRequire ($kind -is [string] -and $kind -cin @('ready','final')) 'RUNNER_OUTPUT_KIND'
  $record=RunnerValidateOutput $kind $record
  if($kind -ceq 'ready'){RunnerRequire (-not $state.ready -and -not $state.final) 'RUNNER_READY_ONCE'}else{RunnerRequire (-not $state.final) 'RUNNER_FINAL_ONCE'}
  [byte[]]$raw=[Text.UTF8Encoding]::new($false).GetBytes((($record|ConvertTo-Json -Compress -Depth 12)+"`n"));RunnerRequire ($raw.Length -le 4096 -and $state.bytes+$raw.Length -le 8192) 'RUNNER_STDOUT_BOUND'
  $stream=[Console]::OpenStandardOutput();$stream.Write($raw,0,$raw.Length);$stream.Flush();$state[$kind]=$true;$state.bytes+=$raw.Length
 }.GetNewClosure()
 return (BindEntryClosures $output (EntryDriverNamespace))
}
function InvokeRunnerEntryCore($ops){
 $phase='authority';$attempted=$false;$outcome=$null;$apiObservation=$null
 try{
  $null=& $ops.authorize;$phase='own-process-identity';$null=& $ops.identity
  $phase='verified-observer-ready';$null=& $ops.await_observer
  $phase='authority-before-self';$null=& $ops.authorize
  $phase='emit-self-ready';& $ops.emit 'ready' (& $ops.ready)
  $phase='single-self-register-run';$attempted=$true
  try{$outcome=& $ops.invoke_once;$null=RunnerValidateActorResult $outcome}finally{$apiObservation=RunnerValidateApiObservation (& $ops.observe_api)}
  RunnerRequire ($outcome.status -is [string] -and $outcome.status -cin @('SELF_REGISTER_RUN_RECORDED_AWAITING_INDEPENDENT_NATIVE_PROOF','UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY')) 'RUNNER_ACTOR_RESULT_STATUS'
  $exit=2;$status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';if($outcome.status -ceq 'SELF_REGISTER_RUN_RECORDED_AWAITING_INDEPENDENT_NATIVE_PROOF'){$exit=0;$status='SELF_ATTEMPT_RECORDED_NOT_QUALIFICATION'}
  $record=@{schema='clued.windows-self-runner-entry-result181/1';status=$status;phase='actor-returned';exit_code=$exit;actor_status=$outcome.status;actor_result=$outcome;api_observation=$apiObservation;actor_call_attempted=$attempted;exception_diagnostics=$null;qualification=$false;installation=$false;automatic_retry=$false}
 }catch{$record=@{schema='clued.windows-self-runner-entry-result181/1';status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';phase=$phase;exit_code=2;actor_status=$null;actor_result=$outcome;api_observation=$apiObservation;actor_call_attempted=$attempted;exception_diagnostics=(RunnerSafeError $_ $phase);qualification=$false;installation=$false;automatic_retry=$false}}
 try{& $ops.emit 'final' $record}catch{$record=@{schema='clued.windows-self-runner-entry-result181/1';status='RUNNER_FINAL_OUTPUT_UNKNOWN';phase='emit-final';exit_code=2;actor_status=$null;actor_result=$outcome;api_observation=$apiObservation;actor_call_attempted=$attempted;exception_diagnostics=(RunnerSafeError $_ 'emit-final');qualification=$false;installation=$false;automatic_retry=$false}}
 return $record
}
function ReceiveApprovedRunnerSourceBytes181 {throw 'RUNNER_FIXED_BYTE_TRANSPORT_UNBOUND'}
function ResolveAcceptedRunnerAuthorityProvider {throw 'RUNNER_OWNER_CLAIM_CI_AUTHORITY_PROVIDER_UNBOUND'}
function NewRealRunnerEntryOperations($loaded,$provider){
 # Internal adapter: only the no-argument trusted resolver may provide this object.
 # Supplying flags, metadata, a callback or source hashes is not an authority API.
 $namespace=EntryDriverNamespace
 $module=$loaded.module;$target=& $module {GetCapturedRunnerTarget};$binding=RunnerValidateBinding ($provider.VerifyLive()) $target
 RunnerRequire ($loaded.source_capture_sha256 -is [string] -and $loaded.source_capture_sha256 -cmatch '^[0-9a-f]{64}$') 'RUNNER_CAPTURE_REFERENCE'
 $captureDigest=$loaded.source_capture_sha256;$provider.VerifyCapturedSource($captureDigest)
 $state=@{target=(RunnerClone $target);binding=(RunnerClone $binding);capture_digest=$captureDigest;phase='bound';observer=$null;attempted=$false;stdout=(NewRunnerStdout)}
 $authorize={return (RunnerValidateBinding ($provider.VerifyLive()) $state.target $state.binding)}.GetNewClosure()
 $operations=@{
  authorize=$authorize
  identity={RunnerRequire ($state.phase -ceq 'bound') 'RUNNER_ENTRY_PHASE';$state.phase='checking_identity';$facts=& $module {GetCapturedRunnerIdentity};$state.phase='identity_verified';return $facts}.GetNewClosure()
  await_observer={
   RunnerRequire ($state.phase -ceq 'identity_verified') 'RUNNER_ENTRY_PHASE';$state.phase='checking_observer'
   & $authorize|Out-Null
   # Provider must bind an actual captured BA entry/provenance, not raw stdin JSON.
   $provider.VerifyObserverStillWaiting()
   $ready=$provider.ReadVerifiedObserverReady();$expectedSha=$provider.ExpectedObserverSourceCaptureSha256();RunnerString $expectedSha (RunnerExpectedObserverCaptureSha256)
   $state.observer=RunnerValidateObserverReady $ready $state.binding $state.target $expectedSha;$state.phase='observer_verified'
  }.GetNewClosure()
  ready={RunnerRequire ($state.phase -ceq 'observer_verified') 'RUNNER_ENTRY_PHASE';$state.phase='self_ready';return @{schema='clued.windows-self-entry-ready181/1';role='SELF_RUNNER';host=$state.target.host;node_id=$state.target.node_id;attempt_id=$state.binding.attempt_id;accepted_subject_sha256=$state.binding.accepted_subject_sha256;owner_receipt_id=$state.binding.owner_receipt_id;predecessor_r9_index_sha256=$state.target.predecessor_index_sha256;request_sha256=$state.target.request_sha256;source_capture_sha256=$state.capture_digest;phase='OWN_PROCESS_IDENTITY_VERIFIED'}}.GetNewClosure()
  invoke_once={
   RunnerRequire ($state.phase -ceq 'self_ready' -and -not $state.attempted -and $null -ne $state.observer) 'RUNNER_SINGLE_ATTEMPT_AFTER_VERIFIED_OBSERVER'
   $fresh=& $authorize;$provider.VerifyObserverStillWaiting();$state.attempted=$true;$state.phase='attempted'
   # Nested GetNewClosure copies invocation locals, not the enclosing closure's
   # script variables. Capture these explicit private references at this level.
   $guardAuthorize=$authorize;$guardProvider=$provider
   $liveGuard={param($operation)
    RunnerRequire ($operation -is [string] -and $operation -cin @('register','run')) 'RUNNER_FIXED_GUARD_PHASE'
    $guardProvider.BeginAtomicOperation($operation)
    try{& $guardAuthorize|Out-Null;$guardProvider.VerifyObserverPhase($operation)}finally{$guardProvider.EndAtomicOperation($operation)}
   }.GetNewClosure()
   $null=BindEntryClosures $liveGuard $namespace
   return (& $module {param($verifiedBinding,$entryLiveGuard)InvokeCapturedSelfOnce $verifiedBinding $entryLiveGuard} (RunnerClone $fresh) $liveGuard)
  }.GetNewClosure()
  observe_api={& $module {GetCapturedApiObservation}}.GetNewClosure()
  emit={param($kind,$record)& $state.stdout $kind $record}.GetNewClosure()
 }
 return (BindEntryClosures $operations $namespace)
}
function InvokeAcceptedRunnerEntry($sourceBytes){
 # No provider/attempt/target/authority argument is accepted by this entry boundary.
 $loaded=NewBoundSelfRegistrationModule $sourceBytes
 $provider=ResolveAcceptedRunnerAuthorityProvider
 $ops=NewRealRunnerEntryOperations $loaded $provider
 return (InvokeRunnerEntryCore $ops)
}
# Captured drivers are invoked through their owning module; helper commands are
# never exported into the caller session or used as a global lookup fallback.
if($null -ne $ExecutionContext.SessionState.Module){Export-ModuleMember -Function @()}
if($MyInvocation.InvocationName -ne '.'){
 if(-not $ExecuteAcceptedRunner){@{schema='clued.windows-self-runner-entry-preview181/1';status='PREVIEW_SOURCE_TRANSPORT_AND_AUTHORITY_PROVIDER_UNBOUND';host=[Environment]::MachineName;component_pins=(RunnerSourcePins);registration=$false;run=$false;target_writes=$false;qualification=$false;installation=$false}|ConvertTo-Json -Depth 5 -Compress;return}
 try{$sourceBytes=ReceiveApprovedRunnerSourceBytes181;$record=InvokeAcceptedRunnerEntry $sourceBytes;exit $record.exit_code}catch{@{schema='clued.windows-self-runner-entry-result181/1';status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';phase='source-capture-or-authority';exit_code=2;actor_status=$null;actor_result=$null;api_observation=$null;actor_call_attempted=$false;exception_diagnostics=(RunnerSafeError $_ 'source-capture-or-authority');qualification=$false;installation=$false;automatic_retry=$false}|ConvertTo-Json -Compress;exit 2}
}
