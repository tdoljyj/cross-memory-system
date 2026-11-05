param([switch]$ExecuteAcceptedObserver)
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

function EntryRequire([bool]$value,[string]$code){if(-not $value){throw [InvalidOperationException]::new($code)}}
function EntryHash([byte[]]$raw){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function EntrySourcePins {return @{
 'actor'='c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616'
 'observer_core'='017d894f54a7bef4fae447b7e3b04d0c0faa29011efafb5b1e603b185d2ff95c'
 'observer_os'='c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a'
 'identity_dll'='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8'
 'definition'='0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4'
 'registration'='642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb'
}}
function EntryCaptureDigest {
 $pins=EntrySourcePins;$ordered=[ordered]@{}
 foreach($key in @('actor','observer_core','observer_os','identity_dll','definition','registration')){$ordered[$key]=$pins[$key]}
 return (EntryHash ([Text.UTF8Encoding]::new($false).GetBytes(($ordered|ConvertTo-Json -Compress))))
}
function EntrySafeError($record,[string]$phase){
 $e=$record.Exception;for($n=0;$n -lt 16 -and $e.InnerException;$n++){$e=$e.InnerException}
 $type=$e.GetType().FullName;if($type -cnotin @('System.InvalidOperationException','System.UnauthorizedAccessException','System.IO.IOException','System.ComponentModel.Win32Exception','System.IO.FileNotFoundException','System.Runtime.InteropServices.COMException')){$type='OTHER'}
 $hr=[int]$e.HResult;$win=$null
 if($e -is [ComponentModel.Win32Exception]){$win=[int]$e.NativeErrorCode}elseif(($hr -band 0xffff0000L) -eq 0x80070000L){$win=[int]($hr -band 65535)}
 return @{phase=$phase;type=$type;hresult=$hr;win32_error=$win;raw_message_persisted=$false}
}
function ImportEntryCapturedComponents($candidate){
 $pins=EntrySourcePins
 EntryRequire ($candidate -is [Collections.IDictionary] -and (($candidate.Keys|Sort-Object)-join '|') -ceq (($pins.Keys|Sort-Object)-join '|')) 'EXACT_CAPTURED_COMPONENT_SET'
 $private=@{};$functionNames=@();$capturedAsts=@()
 # Capture and validate every byte[] before the first ScriptBlock invocation.
 foreach($key in @('actor','observer_core','observer_os','identity_dll','definition','registration')){
  EntryRequire ($candidate[$key] -is [byte[]] -and $candidate[$key].Length -gt 0 -and $candidate[$key].Length -le 1048576) 'CAPTURED_COMPONENT_BOUND'
  $private[$key]=[byte[]]$candidate[$key].Clone()
  EntryRequire ((EntryHash $private[$key]) -ceq $pins[$key]) 'CAPTURED_COMPONENT_SHA_MISMATCH'
  if($key -ceq 'identity_dll'){continue}
  $text=[Text.UTF8Encoding]::new($false,$true).GetString($private[$key]);$errors=$null;$tokens=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$tokens,[ref]$errors);EntryRequire ($errors.Count -eq 0) 'CAPTURED_COMPONENT_PARSE'
  $capturedAsts+=,$ast
  $functionNames+=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)|ForEach-Object {$_.Name})
 }
 $assembly=[Reflection.Assembly]::Load($private.identity_dll)
 EntryRequire ([CluedQualification181.HeldProcess].Assembly -eq $assembly) 'CAPTURED_IDENTITY_TYPE_COLLISION'
 foreach($key in @('actor','definition','registration','observer_core','observer_os')){. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($private[$key])))}
 foreach($name in $functionNames){$item=Get-Item ('Function:\'+$name);Set-Item -Path ('Function:script:'+$name) -Value $item.ScriptBlock}
 $driverNamespace=EntryDriverNamespace
 $components=EntryOwnedNamespace $ExecutionContext.SessionState.Module (EntryNamespaceDescriptors $capturedAsts)
 $functions=@{};foreach($map in @($driverNamespace.functions,$components.functions)){foreach($name in $map.Keys){if($functions.ContainsKey($name)){throw 'ENTRY_CAPTURE_NAMESPACE_COLLISION'};$functions[$name]=$map[$name]}}
 $script:EntryCompleteNamespace=@{owner=$ExecutionContext.SessionState.Module;functions=$functions}
 return $pins
}
function EntryValidateRegistered($value,$expected){
 $keys=@('schema','host','node_id','expected_sid','attempt_id','request_sha256','nonce','task_name','intended_xml_sha256','accepted_subject_sha256')
 EntryRequire ($value -is [pscustomobject] -and (($value.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'REGISTERED_CLOSED_SCHEMA'
 foreach($name in $keys){EntryRequire ($value.$name -is [string]) 'REGISTERED_STRING_TYPE'}
 EntryRequire ($value.schema -ceq 'clued.windows-self-registered181/1' -and $value.intended_xml_sha256 -cmatch '^[0-9a-f]{64}$') 'REGISTERED_SCHEMA_OR_XML_SHA'
 foreach($name in @('host','node_id','expected_sid','attempt_id','request_sha256','nonce','task_name','accepted_subject_sha256')){EntryRequire ($value.$name -ceq $expected.$name) 'REGISTERED_SUBJECT_MISMATCH'}
 return $value
}
function EntrySafeAwaitRegistered([string]$path,[string]$owner,$expected,[scriptblock]$read,[scriptblock]$strictJson,[scriptblock]$authorize,[scriptblock]$clock,[scriptblock]$pause,[double]$limitSeconds=120){
 EntryRequire ($limitSeconds -gt 0 -and $limitSeconds -le 120) 'REGISTERED_WAIT_BOUND'
 $started=[double](& $clock)
 while($true){
  EntryRequire (([double](& $clock)-$started) -lt $limitSeconds) 'REGISTERED_WAIT_TIMEOUT_NO_RETRY'
  & $authorize
  EntryRequire (([double](& $clock)-$started) -lt $limitSeconds) 'REGISTERED_AUTHORIZATION_BUDGET_EXPIRED'
  try{
   $raw=& $read $path $owner 16384
   EntryRequire ($raw -is [byte[]] -and $raw.Length -gt 0 -and $raw.Length -le 16384) 'REGISTERED_BYTES_BOUND'
   $value=& $strictJson ([Text.UTF8Encoding]::new($false,$true).GetString($raw))
   EntryRequire (([double](& $clock)-$started) -lt $limitSeconds) 'REGISTERED_LATE_READ'
   return (EntryValidateRegistered $value $expected)
  }catch{
   $e=$_.Exception;for($depth=0;$depth -lt 16 -and $e.InnerException;$depth++){$e=$e.InnerException}
   $transient=$e -is [Management.Automation.ItemNotFoundException] -or ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -in @(2,32))
   if(-not $transient){throw}
   EntryRequire (([double](& $clock)-$started) -lt $limitSeconds) 'REGISTERED_WAIT_TIMEOUT_NO_RETRY'
   & $pause
  }
 }
}
function NewEntryBoundedStdout {
 $state=@{bytes=0;messages=0;ready=$false;final=$false}
 $output={param([string]$kind,$record)
  EntryRequire ($kind -cin @('ready','final')) 'ENTRY_EVENT_KIND'
  if($kind -ceq 'ready'){EntryRequire (-not $state.ready -and -not $state.final) 'ENTRY_READY_ONCE';$state.ready=$true}else{EntryRequire (-not $state.final) 'ENTRY_FINAL_ONCE';$state.final=$true}
  $raw=[Text.UTF8Encoding]::new($false).GetBytes((($record|ConvertTo-Json -Compress -Depth 12)+"`n"))
  EntryRequire ($raw.Length -le 4096 -and $state.bytes+$raw.Length -le 8192 -and $state.messages -lt 2) 'ENTRY_STDOUT_BOUND'
  $stream=[Console]::OpenStandardOutput();$stream.Write($raw,0,$raw.Length);$stream.Flush();$state.bytes+=$raw.Length;$state.messages++
 }.GetNewClosure()
 return (BindEntryClosures $output $script:EntryCompleteNamespace)
}
function InvokeObserverEntryCore($ops){
 $phase='authority';$prepared=$null;$coreStarted=$false;$record=$null
 try{
  & $ops.authorize
  $phase='prepare-factory';$prepared=& $ops.prepare
  $phase='emit-ready';& $ops.emit 'ready' $prepared.ready
  $phase='await-registered';$registered=& $ops.await_registered $prepared
  $phase='observer-core';$coreStarted=$true
  $outcome=& $ops.run_core $prepared $registered
  EntryRequire ($outcome.status -is [string] -and $outcome.status -cin @('INDEPENDENT_NATIVE_PROOF_VALIDATED_PENDING_FACTORY_RECONCILIATION','UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY')) 'OBSERVER_CORE_STATUS'
  $status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';$exit=2
  if($outcome.status -ceq 'INDEPENDENT_NATIVE_PROOF_VALIDATED_PENDING_FACTORY_RECONCILIATION'){$status='OBSERVER_COMPLETED_REVIEW_REQUIRED';$exit=0}
  $record=@{schema='clued.windows-self-observer-entry-result181/1';status=$status;phase='observer-core';exit_code=$exit;observer_status=$outcome.status;exception_diagnostics=$null;automatic_retry=$false;installation=$false}
 }catch{
  $record=@{schema='clued.windows-self-observer-entry-result181/1';status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';phase=$phase;exit_code=2;observer_status=$null;exception_diagnostics=(EntrySafeError $_ $phase);automatic_retry=$false;installation=$false}
  if($null -ne $prepared -and -not $coreStarted){try{& $ops.persist_early_failure $prepared $record}catch{$record=@{schema='clued.windows-self-observer-entry-result181/1';status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';phase='persist-observer-failure';exit_code=2;observer_status=$null;exception_diagnostics=(EntrySafeError $_ 'persist-observer-failure');automatic_retry=$false;installation=$false}}}
 }finally{if($null -ne $prepared -and -not $coreStarted){try{& $prepared.observer_ops.dispose}catch{$record=@{schema='clued.windows-self-observer-entry-result181/1';status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';phase='dispose-prepared-factory';exit_code=2;observer_status=$null;exception_diagnostics=(EntrySafeError $_ 'dispose-prepared-factory');automatic_retry=$false;installation=$false}}}}
 try{& $ops.persist_entry $record}catch{$record=@{schema='clued.windows-self-observer-entry-result181/1';status='ENTRY_RESULT_PERSISTENCE_UNKNOWN';phase='persist-entry-result';exit_code=2;observer_status=$null;exception_diagnostics=(EntrySafeError $_ 'persist-entry-result');automatic_retry=$false;installation=$false}}
 try{& $ops.emit 'final' $record}catch{$record=@{schema='clued.windows-self-observer-entry-result181/1';status='ENTRY_FINAL_OUTPUT_UNKNOWN';phase='emit-final';exit_code=2;observer_status=$null;exception_diagnostics=(EntrySafeError $_ 'emit-final');automatic_retry=$false;installation=$false}}
 return $record
}
function ResolveAcceptedObserverAuthorityProvider {
 # No CLI data, flag, digest, or caller callback supplies authority. A future
 # reviewed connected provider must independently verify exact Owner acceptance,
 # source capture, Binding/revocation and live target claim at the required phase.
 throw 'ACCEPTED_OBSERVER_AUTHORITY_PROVIDER_AND_CI_TRANSPORT_UNBOUND'
}
function NewRealObserverEntryOperations($provider,$binding){
 # Internal adapter only, after the production resolver returns a trusted provider.
 # The current resolver cannot return one. Fake providers belong only to tests.
 $namespace=$script:EntryCompleteNamespace
 if($null -eq $namespace){throw 'COMPLETE_CAPTURED_ENTRY_NAMESPACE_REQUIRED'}
 ObsKeys $binding @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','code_captured','channel_bound')
 $binding=ObsClone $binding
 foreach($key in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id')){ObsCheck ($binding.$key -is [string]) 'ENTRY_BINDING_STRING_REQUIRED'}
 ObsCheck ($binding.attempt_id -cmatch '^[0-9a-f]{32}$' -and $binding.accepted_subject_sha256 -cmatch '^[0-9a-f]{64}$' -and $binding.owner_receipt_id -cmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') 'ENTRY_BINDING_REFERENCE_FORMAT'
 ObsCheck ($binding.code_captured -is [bool] -and $binding.code_captured -and $binding.channel_bound -is [bool] -and $binding.channel_bound) 'ENTRY_CAPTURE_AND_CHANNEL_UNPROVEN'
 $state=@{prepared=$null;entry_started=$false;target=$null;emit=(NewEntryBoundedStdout)}
 $authorize={
  $fresh=$provider.VerifyLive()
  ObsKeys $fresh @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','code_captured','channel_bound')
  foreach($key in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id')){ObsString $fresh.$key $binding.$key}
  ObsCheck ($fresh.code_captured -is [bool] -and $fresh.code_captured -and $fresh.channel_bound -is [bool] -and $fresh.channel_bound) 'ENTRY_EXTERNAL_BINDING_STALE'
 }.GetNewClosure()
 $operations=@{
 authorize=$authorize
 prepare={
  & $authorize
  $target=SelfTarget ([Environment]::MachineName);$state.target=ObsClone $target
  ObsString $binding.host $target.host;ObsString $binding.node_id $target.node_id
  ObsCheck ([Environment]::Is64BitProcess) 'ENTRY_64BIT_PROCESS_REQUIRED'
  $thread=[Security.Principal.WindowsIdentity]::GetCurrent($true);if($null -ne $thread){$thread.Dispose();throw 'ENTRY_THREAD_IMPERSONATION'}
  $id=[Security.Principal.WindowsIdentity]::GetCurrent();try{$currentSid=$id.User.Value;ObsCheck ($currentSid -cne 'S-1-5-18' -and ([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'ENTRY_ELEVATED_NON_SYSTEM_BA_REQUIRED'}finally{$id.Dispose()}
  # All DLL/helper/script bytes were captured before the first code invocation.
  # Do not reopen Cw or load the original DLL a second time.
  $own=[CluedQualification181.HeldProcess]::new($PID);try{$facts=$own.Observe();ObsCheck ($facts.Elevated -eq 1 -and $facts.Sid -ceq $currentSid) 'ENTRY_PRIMARY_IDENTITY_ELEVATION_REQUIRED'}finally{$own.Dispose()}
  ObsAdminDirectory $target.control
  foreach($name in @('self-registration181.observer-entry.start.json','self-registration181.observer-entry.result.json')){ObsAbsent (Join-Path $target.control $name);ObsAbsent ((Join-Path $target.control $name)+'.pending181')}
  $root='C:\ProgramData\CluedCacheQualification181';[byte[]]$old=ObsRead (Join-Path $root 'qualification-r9.result.json') 'S-1-5-32-544' 1048576;ObsString (ObsHash $old) $target.predecessor_index_sha256
  ObsNewJson (Join-Path $target.control 'self-registration181.observer-entry.start.json') @{schema='clued.windows-self-observer-entry-start181/1';host=$target.host;node_id=$target.node_id;attempt_id=$binding.attempt_id;accepted_subject_sha256=$binding.accepted_subject_sha256;owner_receipt_id=$binding.owner_receipt_id;status='BEFORE_FACTORY_PREFLIGHT';automatic_retry=$false;installation=$false};$state.entry_started=$true
  # Factory is prepared before a ready event or any Self registration dispatch.
  $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\');ObsCheck (TaskMissingForEntry $folder $target.task_name) 'ENTRY_TASK_NOT_ABSENT'
  $authAuthorize=$authorize;$authProvider=$provider
  $auth=@{verify_live={param($t,$attempt,$subject) & $authAuthorize;return $authProvider.VerifyLive()}.GetNewClosure()}
  $null=BindEntryClosures $auth $namespace
  $factory=NewBoundSelfObserverFacade $target $binding.attempt_id $binding.accepted_subject_sha256 $auth
  $null=BindEntryClosures $factory $namespace
  [byte[]]$requestRaw=ObsRead (Join-Path $target.control 'request.json') 'S-1-5-32-544';ObsString (ObsHash $requestRaw) $target.request_sha256
  $request=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($requestRaw));ObsCheck ($request.nonce -is [string] -and $request.nonce -cmatch '^[0-9a-f]{32}$') 'ENTRY_ORIGINAL_NONCE'
  $expected=[pscustomobject]@{host=$target.host;node_id=$target.node_id;expected_sid=$target.sid;attempt_id=$binding.attempt_id;accepted_subject_sha256=$binding.accepted_subject_sha256;request_sha256=$target.request_sha256;nonce=$request.nonce;task_name=$target.task_name}
  $state.observer_ops=$factory;$state.expected=ObsClone $expected
  $prepared=@{target=(ObsClone $target);observer_ops=$factory.Clone();expected=(ObsClone $expected);ready=@{schema='clued.windows-self-entry-ready181/1';role='BA_OBSERVER';host=$target.host;node_id=$target.node_id;attempt_id=$binding.attempt_id;accepted_subject_sha256=$binding.accepted_subject_sha256;owner_receipt_id=$binding.owner_receipt_id;predecessor_r9_index_sha256=$target.predecessor_index_sha256;request_sha256=$target.request_sha256;source_capture_sha256=(EntryCaptureDigest);phase='FACTORY_PREFLIGHT_READY_WAITING_SELF_REGISTERED'}}
  $state.prepared=$true;return $prepared
 }.GetNewClosure()
 await_registered={param($prepared)
  $timer=[Diagnostics.Stopwatch]::StartNew();$clock={$timer.Elapsed.TotalSeconds}.GetNewClosure()
  $null=BindEntryClosures $clock $namespace
  return (EntrySafeAwaitRegistered (Join-Path $state.target.output 'self-registration181.registered.json') $state.target.sid $state.expected {param($path,$owner,$limit) return ,(ObsRead $path $owner $limit)} {param($raw) ObsStrictEvidenceJson $raw} $authorize $clock {Start-Sleep -Milliseconds 100} 120)
 }.GetNewClosure()
 run_core={param($prepared,$registered) InvokeSelfObserverCore $state.target $state.observer_ops $registered}.GetNewClosure()
 persist_early_failure={param($prepared,$failure)
  $record=@{status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';phase='read-self-registration';release_created=$false;registration_by_observer=$false;run_by_observer=$false;installation=$false;automatic_retry=$false;exception_diagnostics=@{phase='read-self-registration';root_exception_type=$failure.exception_diagnostics.type;numeric_hresult=$failure.exception_diagnostics.hresult;numeric_win32_error=$failure.exception_diagnostics.win32_error;win32_code_source=$null;raw_message_persisted=$false}}
  & $state.observer_ops.persist_result_new $state.target $record
 }.GetNewClosure()
 persist_entry={param($record) if($state.entry_started){ObsNewJson (Join-Path $state.target.control 'self-registration181.observer-entry.result.json') @{schema='clued.windows-self-observer-entry-evidence181/1';host=$state.target.host;node_id=$state.target.node_id;attempt_id=$binding.attempt_id;accepted_subject_sha256=$binding.accepted_subject_sha256;owner_receipt_id=$binding.owner_receipt_id;result=$record;automatic_retry=$false;installation=$false}}}.GetNewClosure()
 emit={param($kind,$record) & $state.emit $kind $record}.GetNewClosure()
 }
 return (BindEntryClosures $operations $namespace)
}
function TaskMissingForEntry($folder,[string]$name){try{$null=$folder.GetTask($name);return $false}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if([int]$e.HResult -eq -2147024894){return $true};throw}}
function InvokeAcceptedObserverEntry($captured){
 # Production boundary has no caller-supplied authority/provider parameter.
 $provider=ResolveAcceptedObserverAuthorityProvider
 $binding=$provider.VerifyLive()
 $null=ImportEntryCapturedComponents $captured
 $ops=NewRealObserverEntryOperations $provider $binding
 return (InvokeObserverEntryCore $ops)
}
# Captured drivers are invoked through their owning module; helper commands are
# never exported into the caller session or used as a global lookup fallback.
if($null -ne $ExecutionContext.SessionState.Module){Export-ModuleMember -Function @()}
if($MyInvocation.InvocationName -ne '.'){
 if(-not $ExecuteAcceptedObserver){@{schema='clued.windows-self-observer-entry-preview181/1';status='PREVIEW_AUTHORITY_PROVIDER_AND_CI_TRANSPORT_UNBOUND';component_pins=(EntrySourcePins);registration=$false;run=$false;uac=$false;target_writes=$false}|ConvertTo-Json -Compress;return}
 # No attempt is made to acquire UAC, source files, a token or target evidence.
 $provider=ResolveAcceptedObserverAuthorityProvider
 $binding=$provider.VerifyLive()
 $captured=$provider.CaptureApprovedComponents()
 $null=ImportEntryCapturedComponents $captured
 $ops=NewRealObserverEntryOperations $provider $binding
 $result=InvokeObserverEntryCore $ops
 exit $result.exit_code
}
