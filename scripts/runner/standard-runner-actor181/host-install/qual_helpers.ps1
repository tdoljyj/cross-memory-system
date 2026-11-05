function ObsCheck($ok,[string]$code){if($ok -isnot [bool] -or -not $ok){throw [InvalidOperationException]::new($code)}}
function ObsString($value,[string]$expected){ObsCheck ($value -is [string] -and $value -ceq $expected) 'OBSERVER_STRING_SUBJECT'}
function ObsHash([byte[]]$raw){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function ObsKeys($value,[string[]]$keys){ObsCheck ($value -is [pscustomobject] -and (($value.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'OBSERVER_CLOSED_OBJECT'}
function ObsNoReparse([string]$path){$item=Get-Item -Force -LiteralPath $path;while($null -ne $item){ObsCheck (([long]$item.Attributes -band 1024) -eq 0) 'OBSERVER_REPARSE';if($item.PSIsContainer){$item=$item.Parent}else{$item=$item.Directory}}}
function ObsAdminDirectory([string]$path){ObsNoReparse $path;$acl=Get-Acl -LiteralPath $path;ObsCheck ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544') 'OBSERVER_DIRECTORY_OWNER';foreach($ace in $acl.Access){if($ace.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and -not ($ace.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)){$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;ObsCheck ($sid -in @('S-1-5-18','S-1-5-32-544') -or (([long]$ace.FileSystemRights -band 0x500D0156L) -eq 0)) 'OBSERVER_NONADMIN_DIRECTORY_WRITE'}}}
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
