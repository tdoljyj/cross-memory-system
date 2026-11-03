param([switch]$ExecuteAcceptedSelfRegistration)
$ErrorActionPreference='Stop'
function SelfRequire([bool]$condition,[string]$code){if(-not $condition){throw [InvalidOperationException]::new($code)}}
function TestSelfTokenAdminSid([Security.Principal.WindowsIdentity]$identity){
 # UserClaims is the native-token-derived read-only collection, unlike base Claims.
 # .NET Groups drops SE_GROUP_USE_FOR_DENY_ONLY. This covers enabled/deny-only
 # group and primary-group SID claims; it does not claim arbitrary disabled groups.
 SelfRequire ($null -ne $identity -and $identity.GetType() -eq [Security.Principal.WindowsIdentity]) 'EXACT_NATIVE_WINDOWS_IDENTITY_REQUIRED'
 $sid=$identity.User.Value;SelfRequire ($sid -is [string] -and $sid -match '^S-\d-') 'ACTUAL_IDENTITY_SID_REQUIRED'
 $groupTypes=@([Security.Claims.ClaimTypes]::GroupSid,[Security.Claims.ClaimTypes]::PrimaryGroupSid,[Security.Claims.ClaimTypes]::DenyOnlySid,[Security.Claims.ClaimTypes]::DenyOnlyPrimaryGroupSid)
 $primarySeen=0;$admin=$false;$count=0
 foreach($claim in $identity.UserClaims){
  $count++;SelfRequire ($count -le 4096) 'TOKEN_CLAIM_BOUND'
  if($claim.Type -ceq [Security.Claims.ClaimTypes]::PrimarySid -or $claim.Type -cin $groupTypes){
   SelfRequire ([object]::ReferenceEquals($claim.Subject,$identity) -and $claim.Issuer -ceq [Security.Principal.WindowsIdentity]::DefaultIssuer -and $claim.ValueType -ceq [Security.Claims.ClaimValueTypes]::String) 'NATIVE_TOKEN_CLAIM_ORIGIN_REQUIRED'
   if($claim.Type -ceq [Security.Claims.ClaimTypes]::PrimarySid){SelfRequire ($claim.Value -ceq $sid) 'NATIVE_PRIMARY_SID_CLAIM_MISMATCH';$primarySeen++}
   elseif($claim.Value -ceq 'S-1-5-32-544'){$admin=$true}
  }
 }
 SelfRequire ($primarySeen -eq 1) 'NATIVE_PRIMARY_SID_CLAIM_REQUIRED'
 return $admin
}
function SelfTarget([string]$machine){
 $targets=@{
 'DESK-W-591'=@{host='DESK-W-591';node_id='desk-w-591-windows-runner-caches';sid='S-1-5-21-858977881-4031698862-3006450925-1005';predecessor_index_sha256='d24a9bd1a8b0d905af0a789e0c18e6a97d6433868d124eecaa67c7784d72f297';request_sha256='556c2a224252ae9b84078075049ce6c46bd4c3ccf9cab9dcabdec16c9d6b9ce0'}
 'TURING'=@{host='TURING';node_id='turing-windows-runner-caches';sid='S-1-5-21-1173730660-3877291096-655431861-1013';predecessor_index_sha256='87f3aa2534d3999d9664c740f5eb5dc1d593fa1cdb075867c68000a788ab8c7c';request_sha256='961a6a425a81ce2ef4e40fa42809c72210d65ded7bd30c164286e8351206e8b7'}
 }
 SelfRequire ($targets.ContainsKey($machine)) 'EXACT_HOST_REQUIRED'
 $target=$targets[$machine]
 $target.task_name='CluedCacheProbe-'+$target.node_id+'-181'
 $target.output='C:\ProgramData\CluedCacheQualification181\Outputs\'+$target.node_id
 $target.control='C:\ProgramData\CluedCacheQualification181\Control\'+$target.node_id
 $target.stage='C:\ProgramData\CluedCacheQualification181\Stage'
 return $target
}
function SelfValidateIdentity($target,$facts){
 $names=@();if($facts -is [Collections.IDictionary]){$names=@($facts.Keys)}elseif($facts -is [pscustomobject]){$names=@($facts.PSObject.Properties.Name)}else{throw 'CLOSED_OWN_IDENTITY_REQUIRED'}
 SelfRequire ((($names|Sort-Object)-join '|') -ceq ((@('sid','elevated','admin_enabled','admin_sid_present','process_id')|Sort-Object)-join '|')) 'CLOSED_OWN_IDENTITY_REQUIRED'
 SelfRequire ($facts.sid -is [string] -and $facts.sid -ceq $target.sid) 'EXACT_RUNNER_SELF_SID_REQUIRED'
 SelfRequire ($facts.elevated -is [bool] -and -not $facts.elevated) 'NON_ELEVATED_RUNNER_REQUIRED'
 SelfRequire ($facts.admin_enabled -is [bool] -and -not $facts.admin_enabled) 'NON_ADMIN_RUNNER_REQUIRED'
 SelfRequire ($facts.admin_sid_present -is [bool] -and -not $facts.admin_sid_present) 'ADMIN_GROUP_MEMBERSHIP_INCLUDING_DENY_ONLY_FORBIDDEN'
 SelfRequire ($facts.process_id -is [int] -and $facts.process_id -gt 0) 'OWN_PROCESS_FACTS_REQUIRED'
}
function GetSelfNonAdminAccountEvidence([string]$sid){
 $user=@(Get-CimInstance Win32_UserAccount -Filter ("SID='"+$sid+"' AND LocalAccount=True") -OperationTimeoutSec 10 | Select-Object -First 2)
 SelfRequire ($user.Count -eq 1 -and $user[0].SID -ceq $sid -and $user[0].Name -ceq 'clued-runner' -and $user[0].Disabled -is [bool] -and -not $user[0].Disabled) 'EXACT_ENABLED_LOCAL_RUNNER_ACCOUNT_REQUIRED'
 $queue=[Collections.Generic.Queue[object]]::new();$queue.Enqueue($user[0]);$seen=@{};$count=0
 while($queue.Count -gt 0){
  $current=$queue.Dequeue()
  $class=[string]$current.CimSystemProperties.ClassName
  SelfRequire ($class -cin @('Win32_UserAccount','Win32_Group')) 'LOCAL_ACCOUNT_GRAPH_CLASS'
  $domain=([string]$current.Domain).Replace('\','\\').Replace('"','\"');$name=([string]$current.Name).Replace('\','\\').Replace('"','\"')
  $query='ASSOCIATORS OF {'+$class+'.Domain="'+$domain+'",Name="'+$name+'"} WHERE AssocClass=Win32_GroupUser Role=PartComponent ResultRole=GroupComponent ResultClass=Win32_Group'
  $parents=@(Get-CimInstance -Query $query -OperationTimeoutSec 10 -ErrorAction Stop | Select-Object -First 33)
  SelfRequire ($parents.Count -le 32) 'ACCOUNT_GROUP_QUERY_BOUND'
  foreach($group in $parents){
   SelfRequire ($group.SID -is [string] -and $group.SID -match '^S-\d-') 'ACCOUNT_GROUP_QUERY_UNKNOWN'
   SelfRequire ($group.SID -cne 'S-1-5-32-544') 'ADMIN_ACCOUNT_MEMBERSHIP_FORBIDDEN'
   if(-not $seen.ContainsKey($group.SID)){$seen[$group.SID]=$true;$count++;SelfRequire ($count -le 32) 'ACCOUNT_GROUP_GRAPH_BOUND';$queue.Enqueue($group)}
  }
 }
 return $true
}
function ReadSelfObserverAck($target,$registeredReceipt){
 $path=Join-Path $target.control 'self-registration181.observer-ready.json';$timer=[Diagnostics.Stopwatch]::StartNew()
 while($timer.Elapsed.TotalSeconds -lt 30){
  $present=$false
  try{$null=Get-Item -Force -LiteralPath $path;$present=$true}catch{if($_.Exception -isnot [Management.Automation.ItemNotFoundException]){throw}}
  if($present){
   $bytes=[CluedQualification181.SafeEvidence]::Read($path,16384,'S-1-5-32-544')
   $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
   return (SelfStrictJson $text)
  }
  Start-Sleep -Milliseconds 100
 }
 throw 'INDEPENDENT_OBSERVER_ACK_TIMEOUT_NO_RUN'
}
function SelfSafeException($record,[string]$phase){
 $e=$record.Exception;while($e.InnerException){$e=$e.InnerException}
 $hr=[int]$e.HResult;$win=$null;$source=$null
 if($e -is [ComponentModel.Win32Exception]){$win=[int]$e.NativeErrorCode;$source='Win32Exception'}
 elseif(($hr -band 0xffff0000) -eq -2147024896){$win=$hr -band 65535;$source='HRESULT_FROM_WIN32'}
 $type=$e.GetType().FullName
 if($type -notin @('System.UnauthorizedAccessException','System.InvalidOperationException','System.IO.IOException','System.IO.FileNotFoundException','System.ComponentModel.Win32Exception','System.Runtime.InteropServices.COMException')){$type='OTHER'}
 return @{phase=$phase;root_exception_type=$type;numeric_hresult=$hr;numeric_win32_error=$win;win32_code_source=$source;raw_message_persisted=$false}
}
function SelfBytesHash([byte[]]$bytes){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function SelfStrictJson([string]$raw){
 SelfRequire ($raw.Trim().StartsWith('{') -and $raw.Trim().EndsWith('}')) 'SELF_JSON_OBJECT_REQUIRED'
 $pattern='"(?:[^"\\]|\\.)*"|[{}\[\]:,]|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null'
 $tokens=[regex]::Matches($raw,$pattern);$frames=[Collections.Generic.List[object]]::new();$end=0
 for($i=0;$i -lt $tokens.Count;$i++){
  $token=$tokens[$i];SelfRequire ($raw.Substring($end,$token.Index-$end) -cmatch '^[\x20\t\r\n]*$') 'SELF_JSON_TOKEN';$end=$token.Index+$token.Length;$text=$token.Value
  if($text -ceq '{'){$frames.Add(@{kind='object';keys=@{}});SelfRequire ($frames.Count -le 8) 'SELF_JSON_DEPTH'}
  elseif($text -ceq '['){$frames.Add(@{kind='array';keys=@{}});SelfRequire ($frames.Count -le 8) 'SELF_JSON_DEPTH'}
  elseif($text -ceq '}' -or $text -ceq ']'){
   SelfRequire ($frames.Count -gt 0 -and (($text -ceq '}' -and $frames[$frames.Count-1].kind -ceq 'object') -or ($text -ceq ']' -and $frames[$frames.Count-1].kind -ceq 'array'))) 'SELF_JSON_STRUCTURE'
   $frames.RemoveAt($frames.Count-1);if($frames.Count -eq 0){SelfRequire ($i -eq $tokens.Count-1) 'SELF_JSON_EXTRA_ROOT'}
  }elseif($text.StartsWith('"') -and $i+1 -lt $tokens.Count -and $tokens[$i+1].Value -ceq ':'){
   SelfRequire ($frames.Count -gt 0 -and $frames[$frames.Count-1].kind -ceq 'object') 'SELF_JSON_KEY_CONTEXT'
   $key=$text.Substring(1,$text.Length-2);$seen=$frames[$frames.Count-1].keys
   SelfRequire ($key -notmatch '\\' -and -not $seen.ContainsKey($key)) 'SELF_JSON_DUPLICATE_OR_ESCAPED_KEY';$seen[$key]=$true
  }
 }
 SelfRequire ($frames.Count -eq 0 -and $raw.Substring($end) -cmatch '^[\x20\t\r\n]*$') 'SELF_JSON_INCOMPLETE'
 $value=$raw|ConvertFrom-Json;SelfRequire ($value -is [pscustomobject]) 'SELF_JSON_OBJECT_REQUIRED';return $value
}
function SelfXmlCanonical([string]$xml){$d=[xml]$xml;$d.PreserveWhitespace=$false;return $d.OuterXml}
function SelfAdmitOutput($target){
 $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
 $path=$target.output
 while($path){
  $item=Get-Item -Force -LiteralPath $path
  SelfRequire ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'NO_OUTPUT_ANCESTRY_REPARSE'
  $acl=Get-Acl -LiteralPath $path;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  SelfRequire ($owner -in $trusted) 'TRUSTED_OUTPUT_ANCESTRY_OWNER'
  if($path -ceq $target.output){
   SelfRequire ($owner -ceq 'S-1-5-32-544' -and $acl.AreAccessRulesProtected) 'EXACT_EXISTING_OUTPUT_OWNER_ACL'
   $expected=[Security.AccessControl.DirectorySecurity]::new();$expected.SetSecurityDescriptorSddlForm(('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;'+$target.sid+')'))
   SelfRequire ($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ceq $expected.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) 'EXACT_EXISTING_OUTPUT_DACL'
  }
  $parent=[IO.Directory]::GetParent($path);if($null -eq $parent){break};$path=$parent.FullName
 }
 foreach($name in @('self-registration181.start.json','self-registration181.registered.json','self-registration181.instance.json','self-registration181.result.json')){
  # GetItem errors other than exact missing are not converted into absence.
  try{$null=Get-Item -Force -LiteralPath (Join-Path $target.output $name);throw 'SELF_RECEIPT_COLLISION'}catch{if($_.Exception -isnot [Management.Automation.ItemNotFoundException]){throw}}
 }
 $raw=[CluedQualification181.SafeEvidence]::Read('C:\ProgramData\CluedCacheQualification181\qualification-r9.result.json',1048576,'S-1-5-32-544')
 SelfRequire ((SelfBytesHash $raw) -ceq $target.predecessor_index_sha256) 'EXACT_IMMUTABLE_R9_PREDECESSOR_REQUIRED'
 foreach($path in @((Join-Path $target.control 'release.json'),(Join-Path $target.control 'registered-task.xml'),(Join-Path $target.control 'self-registration181.observer-ready.json'),(Join-Path $target.output 'start.json'),(Join-Path $target.output 'ready.json'),(Join-Path $target.output 'result.json'))){
  try{$null=Get-Item -Force -LiteralPath $path;throw 'NATIVE_OR_ACK_COLLISION'}catch{if($_.Exception -isnot [Management.Automation.ItemNotFoundException]){throw}}
 }
 $requestBytes=[CluedQualification181.SafeEvidence]::Read((Join-Path $target.control 'request.json'),16384,'S-1-5-32-544')
 SelfRequire ((SelfBytesHash $requestBytes) -ceq $target.request_sha256) 'EXACT_ORIGINAL_REQUEST_REQUIRED'
 $request=SelfStrictJson ([Text.UTF8Encoding]::new($false,$true).GetString($requestBytes))
 SelfRequire ($request.nonce -is [string] -and $request.nonce -cmatch '^[0-9a-f]{32}$' -and $request.expected_sid -ceq $target.sid -and $request.node_id -ceq $target.node_id -and $request.host -ceq $target.host) 'ORIGINAL_REQUEST_IDENTITY_REQUIRED'
 $pins=@{'WindowsAccountIdentity181.dll'='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';'windows_native_account_probe181.ps1'='55d8dbc145b694d17e03314cec495b91353e66eee13c08ce60a8e6a06735b814';'windows_python_account_probe181.py'='34d342a2e7af8d24cf3412413ca30aebf09bf7eb18532bdcc5a323a9e6eecff8';'security.py'='932567b1fc5d753b7b29561991ac0ab3a8502f31edfad0fb5109b5b5d2083209'}
 foreach($name in $pins.Keys){$stageBytes=[CluedQualification181.SafeEvidence]::Read((Join-Path $target.stage $name),1048576,'S-1-5-32-544');SelfRequire ((SelfBytesHash $stageBytes) -ceq $pins[$name] -and $request.stage_pins.$name -ceq $pins[$name]) 'ORIGINAL_STAGE_PINS_REQUIRED'}
 return @{request_sha256=$target.request_sha256;nonce=$request.nonce}
}
function WriteSelfReceiptNew($target,[string]$name,$record){
 SelfRequire ($name -cin @('self-registration181.start.json','self-registration181.registered.json','self-registration181.instance.json','self-registration181.result.json')) 'EXACT_SELF_RECEIPT_NAME'
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Depth 12 -Compress))
 SelfRequire ($bytes.Length -le 16384) 'BOUNDED_SELF_RECEIPT'
 $security=[Security.AccessControl.FileSecurity]::new()
 $security.SetSecurityDescriptorSddlForm(('O:'+ $target.sid +'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1301bf;;;'+$target.sid+')'))
 $path=Join-Path $target.output $name
 $stream=[IO.FileStream]::new($path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::None,$security)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 $actual=[CluedQualification181.SafeEvidence]::Read($path,16384,$target.sid)
 SelfRequire ((SelfBytesHash $actual) -ceq (SelfBytesHash $bytes)) 'DURABLE_SELF_RECEIPT_NOT_EXACT'
 $acl=Get-Acl -LiteralPath $path
 SelfRequire ($acl.AreAccessRulesProtected -and $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ceq $security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) 'DURABLE_SELF_RECEIPT_DACL_NOT_EXACT'
}
# Pure orchestration seam. Future bound channel supplies a reviewed real facade.
# No current entry calls this function or treats an input flag/hash as authority.
function InvokeSelfRegistrationCore($target,$ops,[string]$attemptId,[string]$acceptedSubjectSha256){
 SelfRequire ($attemptId -cmatch '^[0-9a-f]{32}$') 'FIXED_ATTEMPT_ID_REQUIRED'
 SelfRequire ($acceptedSubjectSha256 -cmatch '^[0-9a-f]{64}$') 'ACCEPTED_SUBJECT_REFERENCE_REQUIRED'
 $facts=& $ops.identity;SelfValidateIdentity $target $facts
 # Facade admission checks existing protected source pins and original history,
 # exact account-owned output, no reparse/link escape, and both receipt absences.
 $request=& $ops.admit $target
 SelfRequire ($request.request_sha256 -ceq $target.request_sha256 -and $request.nonce -cmatch '^[0-9a-f]{32}$') 'EXACT_ADMITTED_REQUEST_REQUIRED'
 $start=@{schema='clued.windows-self-registration-start181/1';host=$target.host;node_id=$target.node_id;sid=$target.sid;task_name=$target.task_name;attempt_id=$attemptId;accepted_subject_sha256=$acceptedSubjectSha256;request_sha256=$request.request_sha256;nonce=$request.nonce;caller=$facts;registration_calls_allowed=1;run_calls_allowed=1;automatic_retry=$false;installation=$false;maintenance_qualification=$false}
 & $ops.write_new 'self-registration181.start.json' $start
 $phase='query-exact-task';$attempted=$false;$registered=$false;$xmlHash=$null;$runAttempted=$false;$instanceGuid=$null;$engineId=$null
 try{
  SelfRequire (& $ops.task_missing $target.task_name) 'EXACT_NEW_TASK_REQUIRED_NO_ADOPTION'
  $phase='build-self-definition';$definition=& $ops.build $target
  & $ops.validate $definition $target
  $canonical=SelfXmlCanonical ([string]$definition.XmlText)
  $xmlHash=SelfBytesHash ([Text.Encoding]::UTF8.GetBytes($canonical))
  $accountName=& $ops.account_name $target.sid
  SelfRequire ((& $ops.resolve_sid $accountName) -ceq $facts.sid) 'SELF_ACCOUNT_ROUNDTRIP_REQUIRED'
  # Refuse collisions immediately before TASK_CREATE. A later race is never adopted.
  SelfRequire (& $ops.task_missing $target.task_name) 'TASK_COLLISION_NO_RETRY'
  $phase='register-self-task';$attempted=$true
  $actual=& $ops.register $target.task_name $definition $accountName
  $registered=$true;$phase='compare-registered-definition'
  SelfRequire ((SelfXmlCanonical ([string]$actual.Xml)) -ceq $canonical) 'REGISTERED_XML_NOT_EXACT'
  & $ops.validate $actual.Definition $target
  $registeredReceipt=@{schema='clued.windows-self-registered181/1';host=$target.host;node_id=$target.node_id;expected_sid=$target.sid;attempt_id=$attemptId;request_sha256=$request.request_sha256;nonce=$request.nonce;task_name=$target.task_name;intended_xml_sha256=$xmlHash;accepted_subject_sha256=$acceptedSubjectSha256}
  & $ops.write_new 'self-registration181.registered.json' $registeredReceipt
  $phase='await-independent-observer-ack'
  $ack=& $ops.observer_ack $target $registeredReceipt
  SelfRequire ($ack -is [pscustomobject]) 'OBSERVER_ACK_CLOSED_OBJECT_REQUIRED'
  foreach($field in @('schema','host','node_id','expected_sid','attempt_id','request_sha256','nonce','intended_xml_sha256','accepted_subject_sha256')){SelfRequire ($ack.$field -is [string]) 'OBSERVER_ACK_SCALAR_STRING_REQUIRED'}
  SelfRequire ($ack.schema -ceq 'clued.windows-self-observer-ready181/1' -and $ack.host -ceq $target.host -and $ack.node_id -ceq $target.node_id -and $ack.expected_sid -ceq $target.sid -and $ack.attempt_id -ceq $attemptId -and $ack.request_sha256 -ceq $request.request_sha256 -and $ack.nonce -ceq $request.nonce -and $ack.intended_xml_sha256 -ceq $xmlHash -and $ack.accepted_subject_sha256 -ceq $acceptedSubjectSha256 -and $ack.task_instances_empty -is [bool] -and $ack.task_instances_empty) 'INDEPENDENT_OBSERVER_ACK_NOT_EXACT'
  SelfRequire (@($ack.PSObject.Properties.Name|Where-Object {$_ -notin @('schema','host','node_id','expected_sid','attempt_id','request_sha256','nonce','intended_xml_sha256','accepted_subject_sha256','task_instances_empty')}).Count -eq 0) 'OBSERVER_ACK_EXTRA_FIELDS'
  $phase='self-run-once';$runAttempted=$true;$instance=& $ops.run_once $actual
  SelfRequire ($instance.guid -is [string] -and $instance.guid -cmatch '^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$' -and $instance.engine_pid -is [int] -and $instance.engine_pid -gt 0) 'ACTUAL_RUNNING_INSTANCE_REQUIRED'
  $instanceGuid=$instance.guid;$engineId=$instance.engine_pid
  & $ops.write_new 'self-registration181.instance.json' @{schema='clued.windows-self-instance181/1';host=$target.host;node_id=$target.node_id;expected_sid=$target.sid;attempt_id=$attemptId;request_sha256=$request.request_sha256;nonce=$request.nonce;task_instance_guid=$instanceGuid;engine_pid=$engineId;accepted_subject_sha256=$acceptedSubjectSha256}
  $record=@{schema='clued.windows-self-registration-result181/1';host=$target.host;node_id=$target.node_id;sid=$target.sid;task_name=$target.task_name;attempt_id=$attemptId;accepted_subject_sha256=$acceptedSubjectSha256;status='SELF_REGISTER_RUN_RECORDED_AWAITING_INDEPENDENT_NATIVE_PROOF';phase='instance-published';registration_attempted=$attempted;registered_returned=$registered;intended_xml_sha256=$xmlHash;exception_diagnostics=$null;run_attempted=$runAttempted;task_instance_guid=$instanceGuid;engine_pid=$engineId;task_left_for_explicit_future_decision=$true;automatic_retry=$false;installation=$false;maintenance_qualification=$false}
 }catch{
  $record=@{schema='clued.windows-self-registration-result181/1';host=$target.host;node_id=$target.node_id;sid=$target.sid;task_name=$target.task_name;attempt_id=$attemptId;accepted_subject_sha256=$acceptedSubjectSha256;status='UNKNOWN_OR_REFUSED_PRESERVE_NO_RETRY';phase=$phase;registration_attempted=$attempted;registered_returned=$registered;intended_xml_sha256=$xmlHash;exception_diagnostics=(SelfSafeException $_ $phase);run_attempted=$runAttempted;task_instance_guid=$instanceGuid;engine_pid=$engineId;task_left_for_explicit_future_decision=$registered;automatic_retry=$false;installation=$false;maintenance_qualification=$false}
 }
 # Any persistence failure propagates. No collision overwrite, cleanup or retry.
 & $ops.write_new 'self-registration181.result.json' $record
 return $record
}
function NewSelfRegistrationRealFacade($folder,$scheduler){
 # This factory is declarations only. It cannot be reached by this candidate entry.
 # Libraries/type must already be verified and memory-loaded by the future bound channel.
 return @{
 identity={
  $thread=[Security.Principal.WindowsIdentity]::GetCurrent($true)
  if($null -ne $thread){$thread.Dispose();throw 'THREAD_IMPERSONATION_FORBIDDEN'}
  $id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]::new($id)
  $held=[CluedQualification181.HeldProcess]::new($PID)
  try{$s=$held.Observe();SelfRequire ($s.Sid -ceq $id.User.Value -and $s.Pid -eq $PID) 'OWN_HELD_TOKEN_REQUIRED';$adminSid=TestSelfTokenAdminSid $id;SelfRequire (-not $adminSid) 'ADMIN_TOKEN_ENABLED_OR_DENY_ONLY_GROUP_FORBIDDEN';return @{sid=$s.Sid;elevated=[bool]$s.Elevated;admin_enabled=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);admin_sid_present=$adminSid;process_id=[int]$PID}}finally{$held.Dispose()}
 }
 admit={param($target) SelfAdmitOutput $target}
 # Target is bound by future admission, never supplied as a receipt path.
 write_new={param($name,$record) $bound=SelfTarget ([Environment]::MachineName);WriteSelfReceiptNew $bound $name $record}
 task_missing={param($name) try{$null=$folder.GetTask($name);return $false}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if([int]$e.HResult -eq -2147024894){return $true};throw}}.GetNewClosure()
 build={param($target) $exe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';$argsList=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',($target.stage+'\windows_native_account_probe181.ps1'),'-ExecuteAcceptedProbe','-RequestPath',($target.control+'\request.json'),'-RequestSha256',$target.request_sha256);NewExactProbeTaskDefinition $scheduler $target.task_name $target.sid $exe $argsList $target.stage}.GetNewClosure()
 validate={param($definition,$target) $exe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';$argsList=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',($target.stage+'\windows_native_account_probe181.ps1'),'-ExecuteAcceptedProbe','-RequestPath',($target.control+'\request.json'),'-RequestSha256',$target.request_sha256);AssertExactProbeTaskDefinition $definition $target.sid $exe $argsList $target.stage}
 account_name={param($sid) ResolveRegistrationAccountName $sid}
 resolve_sid={param($name) ResolveTaskPrincipalSid $name}
 register={param($name,$definition,$accountName) $folder.RegisterTaskDefinition($name,$definition,2,$accountName,$null,2,$null)}.GetNewClosure()
 observer_ack={param($target,$registeredReceipt) ReadSelfObserverAck $target $registeredReceipt}
 run_once={param($actual)
  $running=$actual.Run($null)
  $guid=[string]$running.InstanceGuid;$engine=[int]$running.EnginePID;$timer=[Diagnostics.Stopwatch]::StartNew()
  # Only refresh this returned instance. Never issue another Run if startup is slow.
  while($engine -le 0 -and $timer.Elapsed.TotalSeconds -lt 15){Start-Sleep -Milliseconds 100;$running.Refresh();SelfRequire ([string]$running.InstanceGuid -ceq $guid) 'RETURNED_TASK_INSTANCE_CHANGED';$engine=[int]$running.EnginePID}
  return @{guid=$guid;engine_pid=$engine}
 }
 }
}
function ImportSelfFixedDependencies {
 $root='C:\ProgramData\CluedCacheProbeBootstrap181R9'
 $dllPath=Join-Path $root 'WindowsAccountIdentity181.dll'
 $walk=Get-Item -Force -LiteralPath $dllPath
 while($null -ne $walk){
  SelfRequire (-not ($walk.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'DEPENDENCY_ANCESTRY_REPARSE'
  if($walk.FullName -ieq $dllPath -or $walk.FullName -ieq $root){
   $acl=Get-Acl -LiteralPath $walk.FullName
   SelfRequire ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544' -and $acl.AreAccessRulesProtected) 'PROTECTED_BA_DEPENDENCY_REQUIRED'
   foreach($ace in $acl.Access){if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow){$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;SelfRequire ($sid -in @('S-1-5-18','S-1-5-32-544') -or (([long]$ace.FileSystemRights -band 0x500D0156L) -eq 0)) 'NONADMIN_DEPENDENCY_WRITE'}}
  }
  if($walk.PSIsContainer){$walk=$walk.Parent}else{$walk=$walk.Directory}
 }
 $stream=[IO.FileStream]::new($dllPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $memory=[IO.MemoryStream]::new();try{$buffer=[byte[]]::new(4096);while(($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0){SelfRequire ($memory.Length+$read -le 1048576) 'DEPENDENCY_BOUND';$memory.Write($buffer,0,$read)};$dllBytes=$memory.ToArray()}finally{$memory.Dispose();$stream.Dispose()}
 SelfRequire ((SelfBytesHash $dllBytes) -ceq '31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8') 'EXACT_ORIGINAL_IDENTITY_DLL_REQUIRED'
 $assembly=[Reflection.Assembly]::Load($dllBytes)
 SelfRequire ([CluedQualification181.HeldProcess].Assembly -eq $assembly) 'IDENTITY_TYPE_COLLISION_REFUSED'
 $reread=[CluedQualification181.SafeEvidence]::Read($dllPath,1048576,'S-1-5-32-544')
 SelfRequire ((SelfBytesHash $reread) -ceq (SelfBytesHash $dllBytes)) 'DEPENDENCY_CHANGED'
 $pins=@{'windows_task_definition181.ps1'='0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4';'windows_task_registration_account181.ps1'='642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb'}
 foreach($name in @('windows_task_definition181.ps1','windows_task_registration_account181.ps1')){
  $raw=[CluedQualification181.SafeEvidence]::Read((Join-Path $root $name),1048576,'S-1-5-32-544')
  SelfRequire ((SelfBytesHash $raw) -ceq $pins[$name]) 'EXACT_ORIGINAL_COM_HELPER_REQUIRED'
  # Function declarations only, exact previously both-host real-COM-tested bytes.
  . ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($raw)))
 }
 # Dot-sourced function declarations must remain in the module/script scope.
 foreach($name in @('TaskDefinitionRequire','TaskDefinitionArgs','ResolveTaskPrincipalSid','NewExactProbeTaskDefinition','GetExactProbeTaskChecks','AssertExactProbeTaskDefinition','ResolveRegistrationAccountName')){
  $function=Get-Item ('Function:\'+$name);Set-Item -Path ('Function:script:'+$name) -Value $function.ScriptBlock
 }
}
function InvokeBoundSelfRegistrationModule([string]$attemptId,[string]$acceptedSubjectSha256,$authorization){
 # Only a separately reviewed runner channel may supply this trusted verifier.
 # Its return is mechanical binding evidence, never an independent grant.
 SelfRequire ($null -ne $authorization -and $authorization.verify_live -is [scriptblock]) 'EXTERNAL_OWNER_CLAIM_CHANNEL_VERIFIER_REQUIRED'
 SelfRequire ($attemptId -cmatch '^[0-9a-f]{32}$' -and $acceptedSubjectSha256 -cmatch '^[0-9a-f]{64}$') 'EXTERNAL_ATTEMPT_SUBJECT_FORMAT'
 $target=SelfTarget ([Environment]::MachineName)
 $binding=& $authorization.verify_live $target $attemptId $acceptedSubjectSha256
 SelfRequire ($binding -is [pscustomobject] -and (($binding.PSObject.Properties.Name|Sort-Object)-join '|') -ceq ((@('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','code_captured','channel_bound')|Sort-Object)-join '|')) 'CLOSED_EXTERNAL_BINDING_REQUIRED'
 foreach($field in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id')){SelfRequire ($binding.$field -is [string]) 'EXTERNAL_BINDING_STRING_REQUIRED'}
 SelfRequire ($binding.owner_receipt_id -cmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') 'EXTERNAL_OWNER_RECEIPT_REFERENCE_REQUIRED'
 SelfRequire ($binding.host -ceq $target.host -and $binding.node_id -ceq $target.node_id -and $binding.attempt_id -ceq $attemptId -and $binding.accepted_subject_sha256 -ceq $acceptedSubjectSha256 -and $binding.code_captured -is [bool] -and $binding.code_captured -and $binding.channel_bound -is [bool] -and $binding.channel_bound -and $binding.owner_receipt_id -is [string] -and $binding.owner_receipt_id.Length -gt 0) 'EXTERNAL_BINDING_NOT_EXACT'
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity)
 SelfRequire (-not (TestSelfTokenAdminSid $identity)) 'ADMIN_TOKEN_ENABLED_OR_DENY_ONLY_GROUP_FORBIDDEN'
 SelfRequire ($identity.User.Value -ceq $target.sid -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'EXACT_NONADMIN_RUNNER_CONTEXT_REQUIRED'
 ImportSelfFixedDependencies
 $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
 $ops=NewSelfRegistrationRealFacade $folder $scheduler
 return (InvokeSelfRegistrationCore $target $ops $attemptId $acceptedSubjectSha256)
}
if($MyInvocation.InvocationName -ne '.'){
 $target=SelfTarget ([Environment]::MachineName)
 if(-not $ExecuteAcceptedSelfRegistration){@{schema='clued.windows-self-registration-preview181/1';status='PREVIEW_CHANNEL_UNBOUND';host=$target.host;node_id=$target.node_id;expected_sid=$target.sid;task_name=$target.task_name;registration=$false;run=$false;file_writes=$false}|ConvertTo-Json -Compress;return}
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=[Security.Principal.WindowsPrincipal]::new($identity)
 SelfRequire (-not (TestSelfTokenAdminSid $identity)) 'ADMIN_TOKEN_ENABLED_OR_DENY_ONLY_GROUP_FORBIDDEN'
 SelfRequire ($identity.User.Value -ceq $target.sid -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'EXACT_NON_ADMIN_RUNNER_REQUIRED'
 throw 'EXECUTION_DISABLED_PENDING_EXACT_CHANNEL_OWNER_ACCEPTANCE_AND_LIVE_CLAIM_ADAPTER'
}
