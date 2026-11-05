# Candidate actual BA-only observer operations. Loading defines functions only.
# No registration, task launch, account change, ACL repair or UAC operation.
# Call only from an independently authorized entry after immutable code capture.
function ObsCheck($ok,[string]$code){if($ok -isnot [bool] -or -not $ok){throw [InvalidOperationException]::new($code)}}
function ObsString($value,[string]$expected){ObsCheck ($value -is [string] -and $value -ceq $expected) 'OBSERVER_STRING_SUBJECT'}
function ObsHash([byte[]]$raw){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function ObsKeys($value,[string[]]$keys){ObsCheck ($value -is [pscustomobject] -and (($value.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'OBSERVER_CLOSED_OBJECT'}
function ObsNoReparse([string]$path){$item=Get-Item -Force -LiteralPath $path;while($null -ne $item){ObsCheck (([long]$item.Attributes -band 1024) -eq 0) 'OBSERVER_REPARSE';if($item.PSIsContainer){$item=$item.Parent}else{$item=$item.Directory}}}
function ObsAdminDirectory([string]$path){ObsNoReparse $path;$acl=Get-Acl -LiteralPath $path;ObsCheck ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544') 'OBSERVER_DIRECTORY_OWNER';foreach($ace in $acl.Access){if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and -not ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;ObsCheck ($sid -in @('S-1-5-18','S-1-5-32-544') -or (([long]$ace.FileSystemRights -band 0x500D0156L) -eq 0)) 'OBSERVER_NONADMIN_DIRECTORY_WRITE'}}}
function ObsAbsent([string]$path){try{$null=Get-Item -Force -LiteralPath $path}catch [Management.Automation.ItemNotFoundException]{return};throw 'OBSERVER_ARTIFACT_COLLISION_NO_RETRY'}
function ObsRead([string]$path,[string]$owner,[int]$limit=16384){
 ObsNoReparse $path
 return ,([byte[]][CluedQualification181.SafeEvidence]::Read($path,$limit,$owner))
}
function ObsReadJson([string]$path,[string]$owner){[byte[]]$raw=ObsRead $path $owner;return ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($raw))}
function ObsNewBytes([string]$path,[byte[]]$raw){
 ObsCheck ($raw.Length -le 1048576) 'OBSERVER_WRITE_BOUND';ObsAdminDirectory ([IO.Path]::GetDirectoryName($path))
 # Fixed sibling, never a retry/suffix fallback. Consumers only see the final
 # name after its immutable bytes have been closed and checked.
 $pending=$path+'.pending181';ObsAbsent $path;ObsAbsent $pending
 $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetSecurityDescriptorSddlForm('O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GR;;;BU)')
 $stream=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::None,$acl)
 try{$stream.Write($raw,0,$raw.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 [byte[]]$staged=ObsRead $pending 'S-1-5-32-544' 1048576;ObsCheck ((ObsHash $staged) -ceq (ObsHash $raw)) 'OBSERVER_PENDING_WRITE_MISMATCH'
 # Both paths are in the same protected directory. File.Move has no overwrite
 # or cross-volume-copy fallback; a collision preserves the pending evidence.
 [IO.File]::Move($pending,$path)
 [byte[]]$back=ObsRead $path 'S-1-5-32-544' 1048576;ObsCheck ((ObsHash $back) -ceq (ObsHash $raw)) 'OBSERVER_DURABLE_WRITE_MISMATCH'
}
function ObsNewJson([string]$path,$value){ObsNewBytes $path ([Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Compress -Depth 18)))}
function ObsNewExportDirectory([string]$path){[CluedQualification181.SecureDirectory]::Create($path,'O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)')}
function ObsRef([string]$relative,[byte[]]$raw){return @{relative=$relative;sha256=(ObsHash $raw)}}
function ObsExactRelative($relative){ObsCheck ($relative -is [string] -and $relative -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$' -and $relative -notmatch '(^|/)\.\.?(/|$)') 'OBSERVER_EXACT_HISTORY_RELATIVE'}
function ObsClone($value){return ObsStrictEvidenceJson ($value|ConvertTo-Json -Depth 16 -Compress)}
function ObsTargetCopy($value,$expected){
 $keys=@('host','node_id','sid','task_name','output','control','stage','request_sha256','predecessor_index_sha256')
 if($value -is [Collections.IDictionary]){$actualKeys=@($value.Keys)}elseif($value -is [pscustomobject]){$actualKeys=@($value.PSObject.Properties.Name)}else{throw 'OBSERVER_CLOSED_TARGET'}
 ObsCheck ((($actualKeys|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'OBSERVER_CLOSED_TARGET'
 $copy=[ordered]@{};foreach($key in $keys){ObsString $value.$key $expected.$key;$copy[$key]=$expected.$key};return [pscustomobject]$copy
}
function ObsBindTarget($state,$candidate,[string[]]$phases){
 $null=ObsTargetCopy $candidate $state.target
 ObsCheck ($state.phase -is [string] -and $state.phase -cin $phases) 'OBSERVER_PHASE_ORDER'
 return $state.target
}
function ObsSameRecord($candidate,$expected){
 ObsCheck ($null -ne $expected) 'OBSERVER_PRIVATE_PROOF_REQUIRED'
 $copy=ObsClone $expected
 if($candidate -is [Collections.IDictionary]){$keys=@($candidate.Keys)}elseif($candidate -is [pscustomobject]){$keys=@($candidate.PSObject.Properties.Name)}else{throw 'OBSERVER_PRIVATE_PROOF_TYPE'}
 ObsCheck ((($keys|Sort-Object)-join '|') -ceq (($copy.PSObject.Properties.Name|Sort-Object)-join '|')) 'OBSERVER_PRIVATE_PROOF_KEYS'
 foreach($property in $copy.PSObject.Properties){$value=$candidate.($property.Name);$wanted=$property.Value
  if($wanted -is [string]){ObsString $value $wanted}
  elseif($wanted -is [bool]){ObsCheck ($value -is [bool] -and $value -ceq $wanted) 'OBSERVER_PRIVATE_PROOF_BOOL'}
  elseif($wanted -is [int] -or $wanted -is [long]){ObsCheck (($value -is [int] -or $value -is [long]) -and $value -ceq $wanted) 'OBSERVER_PRIVATE_PROOF_INTEGER'}
  elseif($null -eq $wanted){ObsCheck ($null -eq $value) 'OBSERVER_PRIVATE_PROOF_NULL'}
  else{throw 'OBSERVER_PRIVATE_PROOF_NON_PRIMITIVE'}
 }
 return $copy
}
function ObsBindRegistered($state,$candidate){ObsValidateBoundReceipt (ObsClone $candidate) $state.target $state.registered 'registered';return $state.registered}
function ObsRefreshAuthorization($state){
 $fresh=& $state.authorize (ObsTargetCopy $state.target $state.target) $state.attempt $state.subject
 ObsKeys $fresh @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','code_captured','channel_bound')
 foreach($key in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id')){ObsString $fresh.$key $state.admission.$key}
 ObsCheck ($fresh.code_captured -is [bool] -and $fresh.code_captured -and $fresh.channel_bound -is [bool] -and $fresh.channel_bound) 'OBSERVER_AUTHORITY_REVOKED_OR_UNKNOWN'
}
function ObsValidateBoundReceipt($value,$target,$registered,[string]$kind){
 $keys=@('schema','host','node_id','expected_sid','attempt_id','request_sha256','nonce','accepted_subject_sha256')
 if($kind -ceq 'registered'){$keys+=@('task_name','intended_xml_sha256');$schema='clued.windows-self-registered181/1'}
 elseif($kind -ceq 'instance'){$keys+=@('task_instance_guid','engine_pid');$schema='clued.windows-self-instance181/1'}else{throw 'OBSERVER_RECEIPT_KIND'}
 ObsKeys $value $keys;ObsString $value.schema $schema
 foreach($key in @('host','node_id')){ObsString $value.$key $target.$key};ObsString $value.expected_sid $target.sid
 foreach($key in @('attempt_id','request_sha256','nonce','accepted_subject_sha256')){ObsString $value.$key $registered.$key}
 if($kind -ceq 'registered'){ObsString $value.task_name $target.task_name;ObsString $value.intended_xml_sha256 $registered.intended_xml_sha256}
 else{ObsCheck ($value.task_instance_guid -is [string] -and $value.task_instance_guid -cmatch '^\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}$') 'OBSERVER_INSTANCE_GUID';ObsEvidenceInteger $value.engine_pid 1 2147483647 'OBSERVER_ENGINE_PID'}
}
function ObsInstance($state,[string]$guid,[int]$processId){$task=$state.folder.GetTask($state.target.task_name);$items=@($task.GetInstances(0));ObsCheck ($items.Count -eq 1 -and [string]$items[0].InstanceGuid -ieq $guid -and [int]$items[0].EnginePID -eq $processId) 'OBSERVER_INSTANCE_CONTINUITY';ObsString (ObsCanonicalXml $task.Xml) $state.xml;return $task}
function ObsHistory($state){
 foreach($relative in $state.history.Keys){[byte[]]$raw=ObsRead (Join-Path $state.root $relative) 'S-1-5-32-544' 1048576;ObsCheck ((ObsHash $raw) -ceq $state.history[$relative]) 'OBSERVER_HISTORY_CHANGED'}
 foreach($name in $state.request.stage_pins.PSObject.Properties.Name){[byte[]]$raw=ObsRead (Join-Path $state.target.stage $name) 'S-1-5-32-544' 1048576;ObsCheck ((ObsHash $raw) -ceq $state.request.stage_pins.$name) 'OBSERVER_STAGE_CHANGED'}
}
function ObsAwaitJson([string]$path,[string]$owner,[int]$seconds,[datetime]$absoluteDeadline=[datetime]::MinValue){
 $end=$absoluteDeadline;if($end -eq [datetime]::MinValue){$end=[DateTime]::UtcNow.AddSeconds($seconds)}
 while($true){ObsCheck ([DateTime]::UtcNow -lt $end) 'OBSERVER_RECEIPT_ABSOLUTE_DEADLINE';try{return ObsReadJson $path $owner}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$missing=$e -is [Management.Automation.ItemNotFoundException] -or ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -in @(2,32));if(-not $missing -or [DateTime]::UtcNow -ge $end){throw};Start-Sleep -Milliseconds 100}}
}
function NewBoundSelfObserverFacade($target,$attemptId,$acceptedSubjectSha256,$authorization){
 # External authorizer is a captured trusted entry callback, not a receipt/flag supplied by Self.
 ObsCheck ($attemptId -is [string] -and $attemptId -cmatch '^[0-9a-f]{32}$' -and $acceptedSubjectSha256 -is [string] -and $acceptedSubjectSha256 -cmatch '^[0-9a-f]{64}$') 'OBSERVER_ATTEMPT_SUBJECT_FORMAT'
 ObsCheck ($null -ne $authorization -and $authorization.verify_live -is [scriptblock]) 'OBSERVER_EXTERNAL_AUTHORIZER_REQUIRED'
 $target=ObsTargetCopy $target (SelfTarget ([Environment]::MachineName))
 $admission=& $authorization.verify_live (ObsTargetCopy $target $target) $attemptId $acceptedSubjectSha256
 ObsKeys $admission @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','code_captured','channel_bound')
 foreach($k in @('host','node_id')){ObsString $admission.$k $target.$k};ObsString $admission.attempt_id $attemptId;ObsString $admission.accepted_subject_sha256 $acceptedSubjectSha256
 ObsCheck ($admission.owner_receipt_id -is [string] -and $admission.owner_receipt_id -cmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -and $admission.code_captured -is [bool] -and $admission.code_captured -and $admission.channel_bound -is [bool] -and $admission.channel_bound) 'OBSERVER_LIVE_AUTHORIZATION_UNPROVEN'
 ObsCheck ($attemptId -cmatch '^[0-9a-f]{32}$' -and $acceptedSubjectSha256 -cmatch '^[0-9a-f]{64}$') 'OBSERVER_ATTEMPT_SUBJECT_FORMAT'
 $admission=ObsClone $admission
 $id=[Security.Principal.WindowsIdentity]::GetCurrent();try{ObsCheck ($id.ImpersonationLevel -eq [Security.Principal.TokenImpersonationLevel]::None -and ([Security.Principal.WindowsPrincipal]::new($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'OBSERVER_REAL_BA_NO_IMPERSONATION'}finally{$id.Dispose()}
 $self=[CluedQualification181.HeldProcess]::new($PID);try{$selfFacts=$self.Observe();ObsCheck ($selfFacts.Elevated -eq 1) 'OBSERVER_ELEVATED_BA_REQUIRED'}finally{$self.Dispose()}
 $root='C:\ProgramData\CluedCacheQualification181';ObsAdminDirectory $root;ObsAdminDirectory $target.control;ObsAdminDirectory $target.stage;ObsNoReparse $target.output
 foreach($name in @('self-registration181.observer-ready.json','self-registration181.observer-proof.json','self-registration181.observer-result.json','native-export-self181','release.json','registered-task.xml')){ObsAbsent (Join-Path $target.control $name)}
 foreach($name in @('self-registration181.observer-ready.json','self-registration181.observer-proof.json','self-registration181.observer-result.json','release.json')){ObsAbsent (Join-Path $target.control ($name+'.pending181'))}
 foreach($name in @('qualification-self181.result.json','proof-export-self181.result.json')){ObsAbsent (Join-Path $root $name)}
 foreach($name in @('qualification-self181.result.json','proof-export-self181.result.json')){ObsAbsent (Join-Path $root ($name+'.pending181'))}
 foreach($name in @('start.json','ready.json','result.json')){ObsAbsent (Join-Path $target.output $name)}
 $outputAcl=Get-Acl -LiteralPath $target.output;$expectedAcl=[Security.AccessControl.DirectorySecurity]::new();$expectedAcl.SetSecurityDescriptorSddlForm(('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;'+$target.sid+')'))
 ObsCheck ($outputAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544' -and $outputAcl.AreAccessRulesProtected -and $outputAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ceq $expectedAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) 'OBSERVER_ORIGINAL_OUTPUT_ACL'
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
 [byte[]]$requestRaw=ObsRead (Join-Path $target.control 'request.json') 'S-1-5-32-544';ObsCheck ((ObsHash $requestRaw) -ceq $target.request_sha256) 'OBSERVER_ORIGINAL_REQUEST_HASH'
 $request=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($requestRaw));ObsKeys $request @('schema','node_id','host','expected_sid','python','python_sha256','pythonw','pythonw_sha256','home','private_parent','stage_dir','output_dir','release_path','nonce','stage_pins')
 foreach($k in @('schema','node_id','host','expected_sid','python','python_sha256','pythonw','pythonw_sha256','home','private_parent','stage_dir','output_dir','release_path','nonce')){ObsCheck ($request.$k -is [string]) 'OBSERVER_REQUEST_STRING'}
 ObsString $request.schema 'clued.windows-account-probe-request181/1';ObsString $request.host $target.host;ObsString $request.node_id $target.node_id;ObsString $request.expected_sid $target.sid;ObsString $request.stage_dir $target.stage;ObsString $request.output_dir $target.output;ObsString $request.release_path (Join-Path $target.control 'release.json');ObsCheck ($request.nonce -cmatch '^[0-9a-f]{32}$') 'OBSERVER_NONCE'
 $stagePins=@{'WindowsAccountIdentity181.dll'='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';'windows_native_account_probe181.ps1'='55d8dbc145b694d17e03314cec495b91353e66eee13c08ce60a8e6a06735b814';'windows_python_account_probe181.py'='34d342a2e7af8d24cf3412413ca30aebf09bf7eb18532bdcc5a323a9e6eecff8';'security.py'='932567b1fc5d753b7b29561991ac0ab3a8502f31edfad0fb5109b5b5d2083209'}
 ObsKeys $request.stage_pins @($stagePins.Keys);foreach($name in $stagePins.Keys){ObsString $request.stage_pins.$name $stagePins[$name]}
 $history=@{'qualification-r9.result.json'=$target.predecessor_index_sha256;('Control/'+$target.node_id+'/request.json')=$target.request_sha256}
 [byte[]]$predecessor=ObsRead (Join-Path $root 'qualification-r9.result.json') 'S-1-5-32-544' 1048576;ObsCheck ((ObsHash $predecessor) -ceq $target.predecessor_index_sha256) 'OBSERVER_FAILED_R9_PREDECESSOR'
 $old=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($predecessor));ObsString $old.status 'NOT_QUALIFIED_PRESERVE_NO_RETRY'
 foreach($map in @($old.original_pins,$old.intermediate_pins)){if($null -ne $map){foreach($property in $map.PSObject.Properties){ObsExactRelative $property.Name;ObsCheck ($property.Value -is [string] -and $property.Value -cmatch '^[0-9a-f]{64}$') 'OBSERVER_ORIGINAL_HISTORY_PIN';$history[$property.Name]=$property.Value}}}
 foreach($ref in @($old.batch_start,$old.batch_result)+@($old.nodes|ForEach-Object {@($_.request,$_.account_result)})){if($null -ne $ref){ObsKeys $ref @('relative','sha256');ObsExactRelative $ref.relative;ObsCheck ($ref.sha256 -is [string] -and $ref.sha256 -cmatch '^[0-9a-f]{64}$') 'OBSERVER_HISTORY_SHA';$history[$ref.relative]=$ref.sha256}}
 $nativeExe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';ObsMachineRuntimeAcl $nativeExe;ObsMachineRuntimeAcl $request.python;ObsMachineRuntimeAcl $request.pythonw
 $runtimePins=@{};foreach($exe in @($nativeExe,$request.python,$request.pythonw)){$runtimePins[$exe]=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()};ObsString $runtimePins[$request.python] $request.python_sha256;ObsString $runtimePins[$request.pythonw] $request.pythonw_sha256
 $state=@{root=$root;target=(ObsTargetCopy $target $target);phase='bound';request=$request;history=$history;native=$null;child=$null;scheduler=$scheduler;folder=$folder;xml=$null;nativeExe=$nativeExe;runtimePins=$runtimePins;attempt=$attemptId;subject=$acceptedSubjectSha256;admission=$admission;authorize=$authorization.verify_live;buffers=@{};verifiedCorrelation=$null;verifiedTerminal=$null}
 ObsHistory $state
 $nativeArgs=@($nativeExe,'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $target.stage 'windows_native_account_probe181.ps1'),'-ExecuteAcceptedProbe','-RequestPath',(Join-Path $target.control 'request.json'),'-RequestSha256',$target.request_sha256)
 $childArgs=@($request.python,'-I','-B','-u',(Join-Path $target.stage 'windows_python_account_probe181.py'),'--sid',$target.sid,'--python-sha256',$request.python_sha256,'--pythonw',$request.pythonw,'--pythonw-sha256',$request.pythonw_sha256,'--home',$request.home,'--private-parent',$request.private_parent)
 return @{
 validate_registered={param($t,$registered)
  $t=ObsBindTarget $state $t @('bound');$state.phase='validatingRegistered'
  $actual=ObsReadJson (Join-Path $t.output 'self-registration181.registered.json') $t.sid;ObsValidateBoundReceipt $actual $t $registered 'registered';ObsString $actual.attempt_id $state.attempt;ObsString $actual.accepted_subject_sha256 $state.subject;ObsString $actual.request_sha256 $t.request_sha256;ObsString $actual.nonce $state.request.nonce
  ObsCheck ($actual.intended_xml_sha256 -is [string] -and $actual.intended_xml_sha256 -cmatch '^[0-9a-f]{64}$') 'OBSERVER_INTENDED_XML_SHA';$state.registered=ObsClone $actual;ObsHistory $state;$state.phase='registeredValidated'
 }.GetNewClosure()
 read_actual_task={param($t)
  $t=ObsBindTarget $state $t @('registeredValidated');$state.phase='validatingTask'
  $task=$state.folder.GetTask($t.task_name);$args=$nativeArgs[1..($nativeArgs.Count-1)];AssertExactProbeTaskDefinition $task.Definition $t.sid $state.nativeExe $args $t.stage
  $xml=ObsCanonicalXml $task.Xml;ObsString (ObsHash ([Text.Encoding]::UTF8.GetBytes($xml))) $state.registered.intended_xml_sha256;ObsCheck (@($task.GetInstances(0)).Count -eq 0) 'OBSERVER_PRE_RUN_INSTANCES';$state.xml=$xml;$state.phase='taskValidated'
  return @{xml_sha256=$state.registered.intended_xml_sha256;sid=$t.sid;task_instances_empty=$true;definition_exact=$true}
 }.GetNewClosure()
 write_ack_new={param($t,$ack)
  $t=ObsBindTarget $state $t @('taskValidated');$state.phase='acking'
  ObsRefreshAuthorization $state;ObsHistory $state
  $actual=ObsStrictEvidenceJson ($ack|ConvertTo-Json -Compress);ObsKeys $actual @('schema','host','node_id','expected_sid','attempt_id','request_sha256','nonce','intended_xml_sha256','accepted_subject_sha256','task_instances_empty');ObsString $actual.schema 'clued.windows-self-observer-ready181/1'
  foreach($key in @('host','node_id','expected_sid','attempt_id','request_sha256','nonce','intended_xml_sha256','accepted_subject_sha256')){ObsString $actual.$key $state.registered.$key};ObsCheck ($actual.task_instances_empty -is [bool] -and $actual.task_instances_empty) 'OBSERVER_ACK_INSTANCES'
  $task=$state.folder.GetTask($t.task_name);ObsString (ObsCanonicalXml $task.Xml) $state.xml;ObsCheck (@($task.GetInstances(0)).Count -eq 0) 'OBSERVER_ACK_RACE'
  ObsNewJson (Join-Path $t.control 'self-registration181.observer-ready.json') $actual
  $state.instanceDeadline=[DateTime]::UtcNow.AddSeconds(30);$state.phase='acked'
 }.GetNewClosure()
 observe_instance_and_hold={param($t,$registered)
  $t=ObsBindTarget $state $t @('acked');$registered=ObsBindRegistered $state $registered;$state.phase='observing'
  $instance=ObsAwaitJson (Join-Path $t.output 'self-registration181.instance.json') $t.sid 30 $state.instanceDeadline;ObsValidateBoundReceipt $instance $t $registered 'instance'
  $state.readyDeadline=[DateTime]::UtcNow.AddSeconds(35)
  $null=ObsAwaitJson (Join-Path $t.output 'ready.json') $t.sid 35 $state.readyDeadline
  [byte[]]$readyRaw=ObsRead (Join-Path $t.output 'ready.json') $t.sid
  $ready=ObsSafeNativeReady (ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($readyRaw))) $t.node_id $registered.nonce $t.sid $state.nativeExe $state.request.python
  $state.releaseDeadline=[DateTime]::UtcNow.AddSeconds(30)
  ObsCheck ($instance.engine_pid -ceq $ready.native.pid) 'OBSERVER_NATIVE_ENGINE_MISMATCH';$null=ObsInstance $state $instance.task_instance_guid $instance.engine_pid
  $state.native=[CluedQualification181.HeldProcess]::new($ready.native.pid);$state.child=[CluedQualification181.HeldProcess]::new($ready.child.pid)
  $nb=$state.native.Observe();$cb=$state.child.Observe();ObsMatchReadyProcess $ready.native $nb;ObsMatchReadyProcess $ready.child_process $cb
  ObsCheck ($nb.Sid -ceq $t.sid -and $nb.Elevated -eq 0 -and $nb.Image -ieq $state.nativeExe -and $cb.Sid -ceq $t.sid -and $cb.Elevated -eq 0 -and $cb.Image -ieq $state.request.python -and $cb.ParentPid -eq $nb.Pid) 'OBSERVER_REAL_TOKEN_IMAGE_PARENT'
  ObsSameArgs ([CluedQualification181.CommandLine]::Parse($state.native.ReadCommandLine())) $nativeArgs;ObsSameArgs ([CluedQualification181.CommandLine]::Parse($state.child.ReadCommandLine())) $childArgs
  $na=$state.native.Observe();$ca=$state.child.Observe();ObsSameProcess $nb $na;ObsSameProcess $cb $ca;$null=ObsInstance $state $instance.task_instance_guid $instance.engine_pid;ObsHistory $state
  $state.ready=ObsClone $ready;$state.readyRawSha256=ObsHash $readyRaw;$state.instance=ObsClone $instance;$state.beforeNative=$nb;$state.beforeChild=$cb
  $state.observation=@{schema='clued.windows-self-observation181/1';host=$t.host;node_id=$t.node_id;attempt_id=$state.attempt;accepted_subject_sha256=$state.subject;nonce=$registered.nonce;task_instance_guid=$instance.task_instance_guid;native_before=(ObsPublicSnapshot $nb);native_after=(ObsPublicSnapshot $na);child_before=(ObsPublicSnapshot $cb);child_after=(ObsPublicSnapshot $ca);task_full_xml_sha256=$registered.intended_xml_sha256;native_argv_match=$true;child_argv_match=$true;command_line_persisted=$false;installation=$false;worker_qualification=$false}
  $state.verifiedCorrelation=ObsClone @{task_instance_guid=$instance.task_instance_guid;native_pid=[int]$nb.Pid;child_pid=[int]$cb.Pid;actual_task_instance_exact=$true;native_token_exact=$true;child_token_exact=$true;native_argv_exact=$true;child_argv_exact=$true;process_start_before_after_exact=$true;registered_xml_before_after_exact=$true;native_ready_closed_exact=$true};$state.phase='held'
  return ObsClone $state.verifiedCorrelation
 }.GetNewClosure()
 write_release_new={param($t,$release)
  $t=ObsBindTarget $state $t @('held');$state.phase='releasing'
  ObsRefreshAuthorization $state
  $closed=ObsStrictEvidenceJson ($release|ConvertTo-Json -Compress);ObsKeys $closed @('schema','nonce','node_id','task_instance_guid','native_pid','child_pid');ObsString $closed.schema 'clued.windows-probe-release181/1';ObsString $closed.nonce $state.request.nonce;ObsString $closed.node_id $t.node_id;ObsString $closed.task_instance_guid $state.instance.task_instance_guid;ObsEvidenceInteger $closed.native_pid $state.beforeNative.Pid $state.beforeNative.Pid 'OBSERVER_RELEASE_NATIVE_PID';ObsEvidenceInteger $closed.child_pid $state.beforeChild.Pid $state.beforeChild.Pid 'OBSERVER_RELEASE_CHILD_PID'
  ObsSameProcess $state.beforeNative ($state.native.Observe());ObsSameProcess $state.beforeChild ($state.child.Observe());ObsSameArgs ([CluedQualification181.CommandLine]::Parse($state.native.ReadCommandLine())) $nativeArgs;ObsSameArgs ([CluedQualification181.CommandLine]::Parse($state.child.ReadCommandLine())) $childArgs;$null=ObsInstance $state $release.task_instance_guid $release.native_pid;ObsHistory $state
  foreach($exe in $state.runtimePins.Keys){ObsMachineRuntimeAcl $exe;ObsString ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()) $state.runtimePins[$exe]}
  ObsCheck ([DateTime]::UtcNow -lt $state.releaseDeadline) 'OBSERVER_FIXED_READY_RELEASE_DEADLINE'
  ObsNewJson (Join-Path $t.control 'release.json') $release
  $state.phase='released'
 }.GetNewClosure()
 settle_and_validate_native_proof={param($t,$correlation)
  $t=ObsBindTarget $state $t @('released');$correlation=ObsSameRecord $correlation $state.verifiedCorrelation;$state.phase='settling'
  $null=ObsAwaitJson (Join-Path $t.output 'result.json') $t.sid 45
  [byte[]]$firstResultRaw=ObsRead (Join-Path $t.output 'result.json') $t.sid;$firstResult=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($firstResultRaw));$null=ObsSafeNativeSuccess $firstResult $t.node_id $state.request.nonce $correlation.native_pid $correlation.child_pid
  $end=[DateTime]::UtcNow.AddSeconds(190);do{$task=$state.folder.GetTask($t.task_name);ObsString (ObsCanonicalXml $task.Xml) $state.xml;$empty=@($task.GetInstances(0)).Count -eq 0;$exited=$state.native.HasExited -and $state.child.HasExited;if($empty -and $exited){break};ObsCheck ([DateTime]::UtcNow -lt $end) 'OBSERVER_TERMINAL_TIMEOUT';Start-Sleep -Milliseconds 100}while($true)
  $nativeExit=$state.native.ExitCode;$childExit=$state.child.ExitCode;ObsEvidenceInteger $nativeExit 0 0 'OBSERVER_NATIVE_EXIT';ObsEvidenceInteger $childExit 0 0 'OBSERVER_CHILD_EXIT'
  $buffers=@{};foreach($pair in @(@('native_start','start.json'),@('native_ready','ready.json'),@('native_result','result.json'))){$buffers[$pair[0]]=ObsRead (Join-Path $t.output $pair[1]) $t.sid}
  ObsString (ObsHash $buffers.native_ready) $state.readyRawSha256;ObsString (ObsHash $buffers.native_result) (ObsHash $firstResultRaw)
  $start=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($buffers.native_start));$ready=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($buffers.native_ready));$final=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($buffers.native_result))
  $null=ObsSafeNativeReady $ready $t.node_id $state.request.nonce $t.sid $state.nativeExe $state.request.python
  ObsMatchReadyProcess $ready.native $state.beforeNative;ObsMatchReadyProcess $ready.child_process $state.beforeChild;ObsMatchReadyProcess $state.ready.native $state.beforeNative;ObsMatchReadyProcess $state.ready.child_process $state.beforeChild
  ObsSafeNativeStartForExport $start $ready $t.node_id $state.request.nonce $t.sid $state.nativeExe $t.request_sha256;ObsMatchReadyProcess $start.native $state.beforeNative
  ObsCheck ($ready.native.pid -ceq $correlation.native_pid -and $ready.child.pid -ceq $correlation.child_pid) 'OBSERVER_READY_CORRELATION_PID'
  $null=ObsSafeNativeSuccess $final $t.node_id $state.request.nonce $ready.native.pid $ready.child.pid
  foreach($key in @('stdout_bytes','stdout_sha256','stderr_bytes','stderr_sha256')){ObsCheck ([Object]::Equals($final.$key,$ready.$key) -and [Object]::Equals($ready.$key,$state.ready.$key)) 'OBSERVER_COMPLETE_STREAM_CONTINUITY'};ObsHistory $state
  foreach($exe in $state.runtimePins.Keys){ObsMachineRuntimeAcl $exe;ObsString ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()) $state.runtimePins[$exe]}
  $state.buffers=$buffers;$state.verifiedTerminal=ObsClone @{native_exit_code=$nativeExit;child_exit_code=$childExit;both_streams_eof_confirmed=$true;stream_eof_basis='PINNED_NATIVE_WAITEXIT_PUMPS_COMPLETED_FAULT_NULL_AND_REAL_EXIT0';task_instances_empty=$true;known_processes_settled=$true;native_three_closed_exact=$true;held_identity_argv_after_exact=$true;original_history_unchanged=$true;stdout_bytes=$final.stdout_bytes;stdout_sha256=$final.stdout_sha256;stderr_bytes=$final.stderr_bytes;stderr_sha256=$final.stderr_sha256};$state.phase='terminalValidated'
  return ObsClone $state.verifiedTerminal
 }.GetNewClosure()
 write_new_proof_and_export={param($t,$registered,$correlation,$terminal)
  $t=ObsBindTarget $state $t @('terminalValidated');$registered=ObsBindRegistered $state $registered;$correlation=ObsSameRecord $correlation $state.verifiedCorrelation;$terminal=ObsSameRecord $terminal $state.verifiedTerminal;$state.phase='exporting'
  ObsRefreshAuthorization $state
  ObsHistory $state;$control='Control/'+$t.node_id+'/';$outputs='Outputs/'+$t.node_id+'/';$exports=@{};$refs=@{}
  foreach($pair in @(@('native_start','start.json'),@('native_ready','ready.json'),@('native_result','result.json'))){$refs[$pair[0]]=ObsRef ($outputs+$pair[1]) $state.buffers[$pair[0]]}
  ObsNewJson (Join-Path $t.control 'self-registration181.observer-proof.json') @{schema='clued.windows-self-observer-proof181/1';status='REAL_SELF_ACCOUNT_PROBE_VALIDATED_NOT_MAINTENANCE_INSTALLED';host=$t.host;node_id=$t.node_id;expected_sid=$t.sid;attempt_id=$state.attempt;accepted_subject_sha256=$state.subject;request_sha256=$t.request_sha256;nonce=$state.request.nonce;owner_receipt_id=$state.admission.owner_receipt_id;observation=$state.observation;terminal=$terminal;native=$refs;automatic_retry=$false;installation=$false;worker_qualification=$false}
  [byte[]]$proofRaw=ObsRead (Join-Path $t.control 'self-registration181.observer-proof.json') 'S-1-5-32-544' 1048576
  $index=@{schema='clued.windows-qualification-self181-result181/1';status='QUALIFIED_NOT_MAINTENANCE_INSTALLED';host=$t.host;node_id=$t.node_id;expected_sid=$t.sid;attempt_id=$state.attempt;accepted_subject_sha256=$state.subject;predecessor_r9=@{relative='qualification-r9.result.json';sha256=$t.predecessor_index_sha256};history_pins=$state.history;observer_proof=(ObsRef ($control+'self-registration181.observer-proof.json') $proofRaw);native=$refs;automatic_retry=$false;installation=$false;worker_qualification=$false}
  $indexPath=Join-Path $state.root 'qualification-self181.result.json';ObsNewJson $indexPath $index;[byte[]]$indexRaw=ObsRead $indexPath 'S-1-5-32-544' 1048576;$indexRef=ObsRef 'qualification-self181.result.json' $indexRaw
  $exportRelative=$control+'native-export-self181';$exportDir=Join-Path $state.root $exportRelative;ObsNewExportDirectory $exportDir
  foreach($pair in @(@('native_start','start.json'),@('native_ready','ready.json'),@('native_result','result.json'))){$key=$pair[0];$relative=$exportRelative+'/'+$pair[1];ObsNewBytes (Join-Path $state.root $relative) $state.buffers[$key];$exports[$key]=@{source=$refs[$key];snapshot=@{relative=$relative;sha256=$refs[$key].sha256}}}
  $manifestRelative=$exportRelative+'/transport.json';ObsNewJson (Join-Path $state.root $manifestRelative) @{schema='clued.windows-native-transport-self181/1';status='COMPLETE_PUBLIC_SNAPSHOT_NOT_RUNTIME_AUTHORITY';node_id=$t.node_id;expected_sid=$t.sid;accepted_subject_sha256=$state.subject;qualification_index=$indexRef;exports=$exports;runtime_authority='ORIGINAL_OUTPUTS_ONLY';automatic_retry=$false;installation=$false}
  [byte[]]$manifestRaw=ObsRead (Join-Path $state.root $manifestRelative) 'S-1-5-32-544' 1048576
  ObsNewJson (Join-Path $state.root 'proof-export-self181.result.json') @{schema='clued.windows-proof-export-self181-result181/1';status='COMPLETE_PUBLIC_TRANSPORT';qualification_index=$indexRef;results=@(@{node_id=$t.node_id;export_state='COMPLETE';transport_manifest=(ObsRef $manifestRelative $manifestRaw);phase='complete';exception_diagnostics=$null});automatic_retry=$false;installation=$false;runtime_authority='ORIGINAL_OUTPUTS_ONLY'}
  $state.phase='exported'
 }.GetNewClosure()
 dispose={if($state.native){$state.native.Dispose()};if($state.child){$state.child.Dispose()}}.GetNewClosure()
 persist_result_new={param($t,$record)
  $t=ObsBindTarget $state $t @('bound','validatingRegistered','registeredValidated','validatingTask','taskValidated','acking','acked','observing','held','releasing','released','settling','terminalValidated','exporting','exported')
  $closed=ObsStrictEvidenceJson ($record|ConvertTo-Json -Depth 10 -Compress)
  ObsKeys $closed @('status','phase','release_created','registration_by_observer','run_by_observer','installation','automatic_retry','exception_diagnostics')
  ObsCheck ($closed.status -is [string] -and $closed.status -cin @('INDEPENDENT_NATIVE_PROOF_VALIDATED_PENDING_FACTORY_RECONCILIATION','UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY')) 'OBSERVER_FINAL_STATUS'
  if($closed.status -ceq 'INDEPENDENT_NATIVE_PROOF_VALIDATED_PENDING_FACTORY_RECONCILIATION'){ObsCheck ($state.phase -ceq 'exported' -and $null -ne $state.verifiedTerminal -and $closed.phase -is [string] -and $closed.phase -ceq 'complete' -and $closed.release_created -is [bool] -and $closed.release_created -and $null -eq $closed.exception_diagnostics) 'OBSERVER_SUCCESS_REQUIRES_PRIVATE_EXPORTED_PROOF'}
  ObsCheck ($closed.phase -is [string] -and $closed.phase -cin @('read-self-registration','independent-task-definition','write-once-observer-ack','correlate-actual-task-and-held-processes','write-once-fixed-native-release','independent-held-exits-and-proof','new-qualified-proof-and-safe-export','complete')) 'OBSERVER_FINAL_PHASE'
  ObsCheck ($closed.release_created -is [bool]) 'OBSERVER_RELEASE_FLAG_TYPE'
  foreach($key in @('registration_by_observer','run_by_observer','installation','automatic_retry')){ObsCheck ($closed.$key -is [bool] -and -not $closed.$key) 'OBSERVER_FINAL_EFFECT_FLAG'}
  if($null -ne $closed.exception_diagnostics){$diagnostics=$closed.exception_diagnostics;ObsKeys $diagnostics @('phase','root_exception_type','numeric_hresult','numeric_win32_error','win32_code_source','raw_message_persisted');ObsString $diagnostics.phase $closed.phase;ObsCheck ($diagnostics.root_exception_type -is [string] -and $diagnostics.root_exception_type -cin @('System.UnauthorizedAccessException','System.InvalidOperationException','System.IO.IOException','System.IO.FileNotFoundException','System.ComponentModel.Win32Exception','System.Runtime.InteropServices.COMException','OTHER')) 'OBSERVER_FINAL_EXCEPTION_TYPE';foreach($key in @('numeric_hresult','numeric_win32_error')){ObsCheck ($null -eq $diagnostics.$key -or $diagnostics.$key -is [int]) 'OBSERVER_FINAL_NUMERIC_TYPE'};ObsCheck ($null -eq $diagnostics.win32_code_source -or ($diagnostics.win32_code_source -is [string] -and $diagnostics.win32_code_source -cin @('Win32Exception','HRESULT_FROM_WIN32'))) 'OBSERVER_FINAL_WIN32_SOURCE';ObsCheck ($diagnostics.raw_message_persisted -is [bool] -and -not $diagnostics.raw_message_persisted) 'OBSERVER_NO_RAW_EXCEPTION'}
  ObsNewJson (Join-Path $t.control 'self-registration181.observer-result.json') @{schema='clued.windows-self-observer-result181/1';host=$t.host;node_id=$t.node_id;attempt_id=$state.attempt;accepted_subject_sha256=$state.subject;owner_receipt_id=$state.admission.owner_receipt_id;result=$closed;unknown_mutation_extent=($closed.status -ceq 'UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY');installation=$false;automatic_retry=$false;worker_qualification=$false}
  $state.phase='resultPersisted'
 }.GetNewClosure()
 }
}

# Namespaced pure/read-only validators copied from frozen r9 broker; no entry execution.
function ObsRequire([bool]$ok,[string]$code){if(-not $ok){throw $code}}
function ObsExactKeys($obj,[string[]]$names){ObsRequire (($obj.PSObject.Properties.Name | Sort-Object) -join '|' -ceq (($names | Sort-Object) -join '|')) 'CLOSED_SCHEMA'}
function ObsStrictEvidenceJson([string]$raw){
  ObsRequire ($raw.Trim().StartsWith('{') -and $raw.Trim().EndsWith('}')) 'EVIDENCE_ROOT_OBJECT'
  $pattern='"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null'
  $tokens=[regex]::Matches($raw,$pattern);$frames=[Collections.Generic.List[object]]::new();$end=0
  for($i=0;$i -lt $tokens.Count;$i++){
    $token=$tokens[$i];ObsRequire ($raw.Substring($end,$token.Index-$end) -cmatch '^[\x20\t\r\n]*$') 'EVIDENCE_JSON_TOKEN';$end=$token.Index+$token.Length;$text=$token.Value
    if($text -ceq '{'){$frames.Add(@{kind='object';keys=@{}});ObsRequire ($frames.Count -le 8) 'EVIDENCE_JSON_DEPTH'}
    elseif($text -ceq '['){$frames.Add(@{kind='array';keys=@{}});ObsRequire ($frames.Count -le 8) 'EVIDENCE_JSON_DEPTH'}
    elseif($text -ceq '}' -or $text -ceq ']'){
      ObsRequire ($frames.Count -gt 0 -and (($text -ceq '}' -and $frames[$frames.Count-1].kind -ceq 'object') -or ($text -ceq ']' -and $frames[$frames.Count-1].kind -ceq 'array'))) 'EVIDENCE_JSON_STRUCTURE'
      $frames.RemoveAt($frames.Count-1);if($frames.Count -eq 0){ObsRequire ($i -eq $tokens.Count-1) 'EVIDENCE_EXTRA_ROOT'}
    }elseif($text.StartsWith('"') -and $i+1 -lt $tokens.Count -and $tokens[$i+1].Value -ceq ':'){
      ObsRequire ($frames.Count -gt 0 -and $frames[$frames.Count-1].kind -ceq 'object') 'EVIDENCE_JSON_KEY_CONTEXT'
      $key=$text.Substring(1,$text.Length-2);$seen=$frames[$frames.Count-1].keys
      ObsRequire ($key -notmatch '\\' -and -not $seen.ContainsKey($key)) 'EVIDENCE_DUPLICATE_OR_ESCAPED_KEY';$seen[$key]=$true
    }
  }
  ObsRequire ($frames.Count -eq 0 -and $raw.Substring($end) -cmatch '^[\x20\t\r\n]*$') 'EVIDENCE_JSON_INCOMPLETE'
  $value=$raw|ConvertFrom-Json;ObsRequire ($value -is [pscustomobject]) 'EVIDENCE_OBJECT_REQUIRED';return $value
}
function ObsEvidenceInteger($value,[long]$minimum,[long]$maximum,[string]$code){ObsRequire (($value -is [int] -or $value -is [long]) -and $value -ge $minimum -and $value -le $maximum) $code}
function ObsSafeNativeReady($value,[string]$node,[string]$nonce,[string]$sid,[string]$nativeExe,[string]$pythonExe){
  ObsExactKeys $value @('schema','node_id','nonce','native','child','child_process','stdout_bytes','stdout_sha256','stderr_bytes','stderr_sha256','writes_outside_evidence')
  ObsRequire ($value.schema -is [string] -and $value.schema -ceq 'clued.windows-native-account-ready181/1' -and $value.node_id -is [string] -and $value.node_id -ceq $node -and $value.nonce -is [string] -and $value.nonce -ceq $nonce) 'READY_SUBJECT'
  ObsRequire ($value.writes_outside_evidence -is [bool] -and -not $value.writes_outside_evidence) 'READY_WRITES_FLAG'
  $native=ObsSafeProcessRecord $value.native $sid $nativeExe;$childProcess=ObsSafeProcessRecord $value.child_process $sid $pythonExe
  ObsExactKeys $value.child @('schema','pid','parent_pid','sid','elevated','python_version','home_ancestry_safe','maintenance_parent_absent','python_read_hash','pythonw_read_hash','writes')
  $child=$value.child;ObsRequire ($child.schema -is [string] -and $child.schema -ceq 'clued.windows-python-account-ready181/1' -and $child.sid -is [string] -and $child.sid -ceq $sid) 'READY_CHILD_SUBJECT'
  ObsEvidenceInteger $child.pid 1 2147483647 'READY_CHILD_PID';ObsEvidenceInteger $child.parent_pid 1 2147483647 'READY_CHILD_PARENT';ObsEvidenceInteger $child.elevated 0 0 'READY_CHILD_ELEVATION'
  ObsRequire ($child.pid -eq $childProcess.pid -and $child.parent_pid -eq $native.pid -and $childProcess.parent_pid -eq $native.pid) 'READY_CHILD_CORRELATION'
  ObsRequire ($child.python_version -is [array] -and $child.python_version.Count -eq 3) 'READY_CHILD_VERSION_TYPE'
  ObsEvidenceInteger $child.python_version[0] 3 3 'READY_CHILD_PYTHON_MAJOR';ObsEvidenceInteger $child.python_version[1] 12 1000 'READY_CHILD_PYTHON_MINOR';ObsEvidenceInteger $child.python_version[2] 0 100000 'READY_CHILD_PYTHON_PATCH'
  foreach($key in @('home_ancestry_safe','maintenance_parent_absent','python_read_hash','pythonw_read_hash')){ObsRequire ($child.$key -is [bool] -and $child.$key) 'READY_CHILD_FLAGS'}
  ObsRequire ($child.writes -is [bool] -and -not $child.writes) 'READY_CHILD_WRITES'
  ObsSafeStreamRecord $value;return $value
}
function ObsSafeNativeSuccess($value,[string]$node,[string]$nonce,[int]$nativePid,[int]$childPid){
  ObsExactKeys $value @('schema','status','node_id','nonce','native_pid','child_pid','child_exit_code','stdout_bytes','stdout_sha256','stderr_bytes','stderr_sha256','writes_outside_evidence','installation','worker_qualification','automatic_retry')
  ObsRequire ($value.schema -is [string] -and $value.schema -ceq 'clued.windows-native-account-result181/1' -and $value.node_id -is [string] -and $value.node_id -ceq $node -and $value.nonce -is [string] -and $value.nonce -ceq $nonce -and $value.status -is [string] -and $value.status -ceq 'PROBE_EXECUTED_AWAITING_BROKER_RECONCILIATION') 'NATIVE_RESULT_SUBJECT'
  ObsEvidenceInteger $value.native_pid $nativePid $nativePid 'NATIVE_RESULT_PID';ObsEvidenceInteger $value.child_pid $childPid $childPid 'NATIVE_RESULT_CHILD_PID';ObsEvidenceInteger $value.child_exit_code 0 0 'NATIVE_RESULT_CHILD_EXIT'
  foreach($key in @('writes_outside_evidence','installation','worker_qualification','automatic_retry')){ObsRequire ($value.$key -is [bool] -and -not $value.$key) 'NATIVE_RESULT_FLAGS'}
  ObsSafeStreamRecord $value;return $value
}
function ObsSafeProcessRecord($value,[string]$sid,[string]$image){
  ObsExactKeys $value @('pid','sid','elevated','creation_file_time','image','parent_pid')
  ObsEvidenceInteger $value.pid 1 2147483647 'PROCESS_RECORD_PID';ObsEvidenceInteger $value.parent_pid 1 2147483647 'PROCESS_RECORD_PARENT'
  ObsEvidenceInteger $value.creation_file_time 1 ([long]::MaxValue) 'PROCESS_RECORD_START';ObsEvidenceInteger $value.elevated 0 0 'PROCESS_RECORD_ELEVATION'
  ObsRequire ($value.sid -is [string] -and $value.sid -ceq $sid -and $value.image -is [string] -and $value.image -ieq $image) 'PROCESS_RECORD_SUBJECT'
  return $value
}
function ObsSafeStreamRecord($value){
  foreach($key in @('stdout_bytes','stderr_bytes')){ObsEvidenceInteger $value.$key 0 8388608 'STREAM_RECORD_BYTES'}
  foreach($key in @('stdout_sha256','stderr_sha256')){ObsRequire ($value.$key -is [string] -and $value.$key -cmatch '^[0-9a-f]{64}$') 'STREAM_RECORD_HASH'}
}
function ObsSafeNativeStartForExport($value,$ready,[string]$node,[string]$nonce,[string]$sid,[string]$nativeExe,[string]$requestSha){
  ObsExactKeys $value @('schema','node_id','nonce','native','phase','request_sha256','writes_outside_evidence')
  foreach($key in @('schema','node_id','nonce','phase','request_sha256')){ObsRequire ($value.$key -is [string]) 'EXPORT_NATIVE_START_SCALAR_TYPE'}
  ObsRequire ($value.schema -ceq 'clued.windows-native-account-start181/1' -and $value.node_id -ceq $node -and $value.nonce -ceq $nonce -and $value.phase -ceq 'identity' -and $value.request_sha256 -ceq $requestSha -and $value.writes_outside_evidence -is [bool] -and -not $value.writes_outside_evidence) 'EXPORT_NATIVE_START_SUBJECT'
  $native=ObsSafeProcessRecord $value.native $sid $nativeExe
  foreach($key in @('pid','sid','elevated','creation_file_time','parent_pid')){ObsRequire ($native.$key -ceq $ready.native.$key) 'EXPORT_NATIVE_START_CONTINUITY'}
  ObsRequire ($native.image -ieq $ready.native.image) 'EXPORT_NATIVE_START_IMAGE'
}
function ObsMatchReadyProcess($record,$observed){
  $actual=ObsPublicSnapshot $observed
  foreach($key in @('pid','sid','elevated','creation_file_time','parent_pid')){ObsRequire ($record.$key -ceq $actual[$key]) 'READY_HELD_PROCESS_MISMATCH'}
  ObsRequire ($record.image -ieq $actual.image) 'READY_HELD_IMAGE_MISMATCH'
}
function ObsPublicSnapshot($s){return @{pid=[int]$s.Pid;sid=[string]$s.Sid;elevated=[int]$s.Elevated;creation_file_time=[long]$s.CreationFileTime;image=[string]$s.Image;parent_pid=[int]$s.ParentPid}}
function ObsSameProcess($a,$b){
  ObsRequire ($a.Pid -eq $b.Pid -and $a.Sid -ceq $b.Sid -and $a.Elevated -eq $b.Elevated -and $a.CreationFileTime -eq $b.CreationFileTime -and $a.Image -ieq $b.Image -and $a.ParentPid -eq $b.ParentPid) 'PROCESS_CONTINUITY'
}
function ObsCanonicalXml([string]$text){$x=[xml]$text;$x.PreserveWhitespace=$false;return $x.OuterXml}
function ObsWinPath([string]$path){ObsRequire ($path -match '^[A-Za-z]:[\\/]' -and $path -notmatch '[\x00-\x1f]') 'ABSOLUTE_WINDOWS_PATH';return [IO.Path]::GetFullPath($path.Replace('/','\'))}
function ObsSameArgs([string[]]$actual,[string[]]$expected){
  ObsRequire ($actual.Count -eq $expected.Count) 'PROCESS_ARGV_LENGTH'
  ObsRequire ((ObsWinPath $actual[0]) -ieq (ObsWinPath $expected[0])) 'PROCESS_ARGV_EXE'
  for($i=1;$i -lt $expected.Count;$i++){ObsRequire ($actual[$i] -ceq $expected[$i]) 'PROCESS_ARGV_VALUE'}
}
function ObsMachineRuntimeAcl([string]$path,[switch]$AncestorOnly){
  $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $walk=Get-Item -LiteralPath $path -Force
  while($null -ne $walk){
    ObsRequire (($walk.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'INTERPRETER_REPARSE'
    $acl=Get-Acl -LiteralPath $walk.FullName;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    ObsRequire ($trusted -ccontains $owner) 'MACHINE_RUNTIME_OWNER'
    $mask=0x500D0156L;if($AncestorOnly -or $walk.FullName -ieq [IO.Path]::GetPathRoot($walk.FullName)){$mask=0x500D0040L}
    foreach($ace in $acl.Access){
      if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){continue}
      $sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      ObsRequire ($trusted -ccontains $sid -or $sid -ceq 'S-1-3-4' -or (([long]$ace.FileSystemRights -band $mask) -eq 0)) 'MACHINE_RUNTIME_NONADMIN_WRITE'
    }
    if($walk.PSIsContainer){$walk=$walk.Parent}else{$walk=$walk.Directory}
  }
}
