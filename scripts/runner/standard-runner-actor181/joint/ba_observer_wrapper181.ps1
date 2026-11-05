# Memory-only, captured BA observer wrapper. Preview performs no target operation.
function BARequire($value,[string]$code){if($value -isnot [bool] -or -not $value){throw $code}}
function BAKeys($value,[string[]]$keys){BARequire ($value -is [pscustomobject] -and ((@($value.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'BA_CLOSED_OBJECT'}
function BAString($value,[string]$expected){BARequire ($value -is [string] -and $value -ceq $expected) 'BA_STRING_BINDING'}
function BACopy($value){return ($value|ConvertTo-Json -Compress -Depth 12|ConvertFrom-Json)}
function BAHash([byte[]]$raw){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function BAPins {return [ordered]@{observer_entry='6d2ae34fc7bc390708120e1b3f653fa49c49ac1ae9f7a61f77ddf08daa27f079';actor='c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616';observer_core='017d894f54a7bef4fae447b7e3b04d0c0faa29011efafb5b1e603b185d2ff95c';observer_os='c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a';identity_dll='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';definition='0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4';registration='642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb'}}
function BAChannelCheck($state){BARequire ($null -ne $state.root_read -and -not $state.root_read.IsCompleted -and -not $state.final) 'BA_ROOT_EOF_REVOCATION_OR_FINAL'}
function BAHeldFacts($state){
 $b=$state.binding;$t=& $state.driver {SelfTarget ([Environment]::MachineName)}
 $facts=@{};foreach($role in @('node','ps','ba','relay')){
  $s=$state.held[$role].Observe();$sid=$t.sid;$elev=0;$image=$b.node_image;if($role -cin @('ps','ba','relay')){$image=$state.ps_image};if($role -ceq 'ba'){$sid=$b.ba_sid;$elev=1};if($role -ceq 'relay'){$sid=$b.relay_sid;$elev=1}
  BARequire ($s.Pid -eq $b.($role+'_pid') -and $s.CreationFileTime.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $b.($role+'_start') -and $s.Sid -ceq $sid -and $s.Elevated -eq $elev -and $s.Image -ieq $image) 'BA_ACTUAL_HELD_ROLE'
  $facts[$role]=$s
 }
 BARequire ($facts.ps.ParentPid -eq $facts.node.Pid -and $facts.ba.Pid -ne $facts.relay.Pid -and $facts.ba.Pid -eq $PID) 'BA_ACTUAL_NODE_CHILD_AND_SEPARATE_RELAY'
 return @{ps_pid=$facts.ps.Pid;ps_start=$b.ps_start;ps_parent_pid=$facts.ps.ParentPid;node_pid=$facts.node.Pid;node_start=$b.node_start;ba_pid=$facts.ba.Pid;ba_start=$b.ba_start;relay_pid=$facts.relay.Pid;relay_start=$b.relay_start}
}
function BASetPhase($state,[string]$phase,$ready=$null){
 BARequire ($phase -cin @('WAITING_SELF_REGISTERED','AWAITING_INSTANCE','FINAL')) 'BA_PHASE_ENUM'
 if($phase -ceq 'WAITING_SELF_REGISTERED'){BARequire ($state.phase -ceq 'PREFLIGHT') 'BA_READY_ONCE';$state.ready=BACopy $ready;$state.ready_clock=[Diagnostics.Stopwatch]::GetTimestamp()}
 elseif($phase -ceq 'AWAITING_INSTANCE'){BARequire ($state.phase -ceq 'WAITING_SELF_REGISTERED') 'BA_ACK_AFTER_READY'}
 else{$state.final=$true}
 $state.phase=$phase;$state.lease=$null;$state.lease_tick=0L
 if($phase -ceq 'AWAITING_INSTANCE'){
  [Console]::Out.WriteLine((@{schema='clued.root-owned-ba-phase181/1';session_id=$state.binding.session_id;attempt_id=$state.binding.attempt_id;accepted_subject_sha256=$state.binding.accepted_subject_sha256;phase=$phase;source='ORIGINAL_ACK_CALLBACK_RETURNED'}|ConvertTo-Json -Compress));[Console]::Out.Flush()
 }
}
function BARootVerifyLive($state){
 BAChannelCheck $state;$facts=BAHeldFacts $state
 $age=([Diagnostics.Stopwatch]::GetTimestamp()-$state.lease_tick)*1000.0/[Diagnostics.Stopwatch]::Frequency
 if($null -ne $state.lease -and $age -ge 0 -and $age -lt 2000 -and $state.lease_phase -ceq $state.phase){return (BACopy $state.lease)}
 $state.sequence++;BARequire ($state.sequence -le 4096) 'BA_ROOT_REQUEST_LIMIT'
 $id=$state.sequence.ToString([Globalization.CultureInfo]::InvariantCulture)+':'+[Guid]::NewGuid().ToString('N')
 $request=[ordered]@{schema='clued.root-owned-authority-request181/1';session_id=$state.binding.session_id;request_id=$id;method='VerifyLive';argument='';binding=(BACopy $state.binding);actual_chain=$facts}
 $line=$request|ConvertTo-Json -Compress -Depth 12;$requestHash=BAHash ([Text.UTF8Encoding]::new($false).GetBytes($line));BARequire ([Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'BA_ROOT_REQUEST_BOUND';[Console]::Out.WriteLine($line);[Console]::Out.Flush()
 BARequire ($state.root_read.Wait(16000)) 'BA_ROOT_REPLY_TIMEOUT_NO_RETRY';$response=$state.root_read.Result;BARequire ($response -is [string] -and $response.Length -gt 0 -and [Text.Encoding]::UTF8.GetByteCount($response) -le 16384) 'BA_ROOT_REPLY_EOF_OR_BOUND';$state.root_read=$state.reader.ReadLineAsync()
 $reply=& $state.parser $response;BAKeys $reply @('schema','session_id','request_id','request_sha256','method','canonical_receipt_id','decision','observer_ready','observer_phase','ready_age_ms')
 BAString $reply.schema 'clued.root-owned-authority-reply181/1';BAString $reply.session_id $state.binding.session_id;BAString $reply.request_id $id;BAString $reply.request_sha256 $requestHash;BAString $reply.method 'VerifyLive';BAString $reply.decision 'CURRENT_FOR_EXACT_ROOT_OWNED_REQUEST'
 BARequire ($reply.canonical_receipt_id -is [string] -and $reply.canonical_receipt_id -cmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') 'BA_REAL_ROOT_RECEIPT_REQUIRED'
 BAString $reply.observer_phase $state.phase
 if($state.phase -ceq 'PREFLIGHT'){BARequire ($null -eq $reply.observer_ready -and $null -eq $reply.ready_age_ms) 'BA_PREFLIGHT_CANNOT_FABRICATE_READY'}
 else{
  BAKeys $reply.observer_ready @('schema','role','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256','source_capture_sha256','phase')
  foreach($n in $state.ready.PSObject.Properties.Name){BAString $reply.observer_ready.$n $state.ready.$n}
  BARequire (($reply.ready_age_ms -is [int] -or $reply.ready_age_ms -is [long]) -and $reply.ready_age_ms -ge 0 -and $reply.ready_age_ms -lt 120000) 'BA_READY_ACTUAL_AGE'
 }
 $null=BAHeldFacts $state;BAChannelCheck $state
 $result=[pscustomobject]@{host=$state.binding.host;node_id=$state.binding.node_id;attempt_id=$state.binding.attempt_id;accepted_subject_sha256=$state.binding.accepted_subject_sha256;owner_receipt_id=$state.binding.owner_receipt_id;code_captured=$true;channel_bound=$true}
 $state.lease=BACopy $result;$state.lease_tick=[Diagnostics.Stopwatch]::GetTimestamp();$state.lease_phase=$state.phase;return (BACopy $result)
}
function NewCapturedBAObserver181($candidate){
 $pins=BAPins;BARequire ($candidate -is [Collections.IDictionary] -and (($candidate.Keys|Sort-Object)-join '|') -ceq (($pins.Keys|Sort-Object)-join '|')) 'BA_EXACT_CAPTURED_MEMBERS'
 $private=@{};foreach($key in $pins.Keys){BARequire ($candidate[$key] -is [byte[]] -and $candidate[$key].Length -gt 0 -and $candidate[$key].Length -le 1048576) 'BA_CAPTURE_BOUND';$private[$key]=[byte[]]$candidate[$key].Clone();BAString (BAHash $private[$key]) $pins[$key]
  if($key -cne 'identity_dll'){$errors=$null;$tokens=$null;$null=[Management.Automation.Language.Parser]::ParseInput([Text.UTF8Encoding]::new($false,$true).GetString($private[$key]),[ref]$tokens,[ref]$errors);BARequire ($errors.Count -eq 0) 'BA_CAPTURE_PARSE'}
 }
 $driver=New-Module {param($raw). ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($raw)));Export-ModuleMember -Function @()} -ArgumentList (,$private.observer_entry)
 $six=@{};foreach($key in @('actor','observer_core','observer_os','identity_dll','definition','registration')){$six[$key]=$private[$key]}
 $null=& $driver {param($bytes)ImportEntryCapturedComponents $bytes} $six
 $root=$MyInvocation.MyCommand.ScriptBlock.Ast;while($root.Parent){$root=$root.Parent};$descriptors=@();foreach($f in $root.EndBlock.Statements){if($f -is [Management.Automation.Language.FunctionDefinitionAst]){$descriptors+=@{name=$f.Name;text=$f.Extent.Text}}}
 $namespace=& $driver {param($owner,$d)EntryOwnedNamespace $owner $d} $ExecutionContext.SessionState.Module $descriptors
 $owner=New-Module {
  param($capturedDriver,$verifiedNamespace)
  $script:driver=$capturedDriver;$script:namespace=$verifiedNamespace;$script:state=$null;$script:spent=$false
  function BindOwnedBAObserverOnce181($binding,$reader){
   if($null -ne $script:state -or $script:spent){throw 'BA_BIND_ONCE'}
   # Reuse the strict protected server22 binding validator, passed by captured
   # bootstrap as data; actual source/Owner authority still comes from Root.
   $keys=@('session_id','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','packet_sha256','request_sha256','predecessor_r9_index_sha256','node_pid','node_start','node_image','ps_pid','ps_start','ba_pid','ba_start','ba_sid','relay_pid','relay_start','relay_sid','observer_capture_sha256','runner_capture_sha256')
   BAKeys $binding $keys;foreach($n in @('node_pid','ps_pid','ba_pid','relay_pid')){BARequire ($binding.$n -is [int] -and $binding.$n -gt 0) 'BA_BIND_PID'}
   foreach($n in @('node_start','ps_start','ba_start','relay_start')){BARequire ($binding.$n -is [string] -and $binding.$n -cmatch '^[1-9][0-9]{0,18}$') 'BA_BIND_FILETIME'}
   foreach($n in @('session_id','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','packet_sha256','request_sha256','predecessor_r9_index_sha256','node_image','ba_sid','relay_sid','observer_capture_sha256','runner_capture_sha256')){BARequire ($binding.$n -is [string]) 'BA_BIND_STRING'}
   BARequire ($binding.ba_pid -eq $PID -and $binding.ba_pid -ne $binding.relay_pid -and $reader -is [IO.StreamReader]) 'BA_BIND_OWN_PROCESS_AND_DISTINCT_RELAY'
   $b=BACopy $binding;$target=& $script:driver {SelfTarget ([Environment]::MachineName)};BAString $b.host $target.host;BAString $b.node_id $target.node_id;BAString $b.request_sha256 $target.request_sha256;BAString $b.predecessor_r9_index_sha256 $target.predecessor_index_sha256;BAString $b.observer_capture_sha256 '17c85ea6052ce15f4d501316247009ff374aebc435841e016fabd609fd7d12e3'
   $state=@{driver=$script:driver;binding=$b;reader=$reader;root_read=$reader.ReadLineAsync();phase='PREFLIGHT';ready=$null;final=$false;sequence=0;lease=$null;lease_tick=0L;lease_phase=$null;held=@{};ps_image=(Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe');parser=(& $script:driver {(Get-Item Function:ObsStrictEvidenceJson).ScriptBlock})}
   try{foreach($role in @('node','ps','ba','relay')){$state.held[$role]=[CluedQualification181.HeldProcess]::new($b.($role+'_pid'))};$null=BAHeldFacts $state;$script:state=$state}catch{foreach($h in $state.held.Values){$h.Dispose()};throw}
  }
  function InvokeOwnedBAObserverOnce181 {
   if($script:spent -or $null -eq $script:state){throw 'BA_INVOKE_BOUND_ONCE'};$script:spent=$true;$state=$script:state
   $provider=[pscustomobject]@{}
   $verify={return (BARootVerifyLive $state)}.GetNewClosure();$null=& $script:driver {param($c,$n)BindEntryClosures $c $n} $verify $script:namespace
   $provider|Add-Member ScriptMethod VerifyLive $verify
   try{
    $binding=$provider.VerifyLive();$ops=& $script:driver {param($p,$b)NewRealObserverEntryOperations $p $b} $provider $binding
    $originalEmit=$ops.emit;$originalPrepare=$ops.prepare;$namespace=$script:namespace;$driver=$script:driver
    $ops.emit={param($kind,$record)if($kind -ceq 'ready'){BASetPhase $state 'WAITING_SELF_REGISTERED' $record}elseif($kind -ceq 'final'){BASetPhase $state 'FINAL'};& $originalEmit $kind $record}.GetNewClosure()
    $ops.prepare={
     $prepared=& $originalPrepare
     # Original r2 run_core uses its private canonical table. Wrap only the ACK
     # slot after original factory construction; never substitute its proof state.
     & $originalPrepare.Module {param($phaseState,$capturedNamespace,$driverOwner)
      $oldAck=$state.observer_ops.write_ack_new
      $newAck={param($t,$ack)& $oldAck $t $ack;BASetPhase $phaseState 'AWAITING_INSTANCE'}.GetNewClosure()
      $null=& $driverOwner {param($c,$n)BindEntryClosures $c $n} $newAck $capturedNamespace
      $state.observer_ops.write_ack_new=$newAck
      $oldRelease=$state.observer_ops.write_release_new
      $newRelease={param($t,$release)
       $phaseState.lease=$null;$phaseState.lease_tick=0L
       [Console]::Out.WriteLine((@{schema='clued.root-owned-ba-phase181/1';session_id=$phaseState.binding.session_id;attempt_id=$phaseState.binding.attempt_id;accepted_subject_sha256=$phaseState.binding.accepted_subject_sha256;phase='AWAITING_INSTANCE';source='BEFORE_NATIVE_RELEASE'}|ConvertTo-Json -Compress));[Console]::Out.Flush()
       $null=BARootVerifyLive $phaseState
       & $oldRelease $t $release
      }.GetNewClosure()
      $null=& $driverOwner {param($c,$n)BindEntryClosures $c $n} $newRelease $capturedNamespace
      $state.observer_ops.write_release_new=$newRelease
     } $state $namespace $driver
     return $prepared
    }.GetNewClosure()
    $null=& $script:driver {param($table,$n)foreach($k in @('emit','prepare')){$null=BindEntryClosures $table[$k] $n}} $ops $script:namespace
    return (& $script:driver {param($o)InvokeObserverEntryCore $o} $ops)
   }finally{foreach($h in $state.held.Values){$h.Dispose()};$state.final=$true}
  }
  Export-ModuleMember -Function @()
 } -ArgumentList $driver,$namespace
 # Install verified wrapper helpers privately without exporting any command.
 $anchor=& $owner {return {$script:state}}
 $null=& $driver {param($c,$n)BindEntryClosures $c $n} $anchor $namespace
 return $owner
}
function InvokeBAObserverStdio181 {
 $reader=$script:OwnedBAStdin181;$line=$reader.ReadLine();BARequire ($line -is [string] -and [Text.Encoding]::UTF8.GetByteCount($line) -le 2097152) 'BA_PAYLOAD_BOUND';$payload=$line|ConvertFrom-Json;BAKeys $payload @('schema','captures');BAString $payload.schema 'clued.root-owned-ba-capture181/1';BARequire ($payload.captures -is [pscustomobject]) 'BA_CAPTURE_OBJECT'
 $caps=@{};foreach($p in $payload.captures.PSObject.Properties){BARequire ($p.Value -is [string] -and $p.Value.Length -le 1398104) 'BA_BASE64_BOUND';$raw=[Convert]::FromBase64String($p.Value);BAString ([Convert]::ToBase64String($raw)) $p.Value;$caps[$p.Name]=$raw}
 $owner=NewCapturedBAObserver181 $caps;$held=[CluedQualification181.HeldProcess]::new($PID)
 try{$s=$held.Observe();[Console]::Out.WriteLine((@{schema='clued.root-owned-ba-capture-ready181/1';host=[Environment]::MachineName;ba_pid=$s.Pid;ba_start=$s.CreationFileTime.ToString([Globalization.CultureInfo]::InvariantCulture);ba_sid=$s.Sid;ba_elevated=$s.Elevated;parent_pid=$s.ParentPid;source_capture_sha256='17c85ea6052ce15f4d501316247009ff374aebc435841e016fabd609fd7d12e3';authority_granted=$false}|ConvertTo-Json -Compress));[Console]::Out.Flush()
  $startRead=$reader.ReadLineAsync();BARequire ($startRead.Wait(120000)) 'BA_START_TIMEOUT';$startLine=$startRead.Result;BARequire ($startLine -is [string] -and [Text.Encoding]::UTF8.GetByteCount($startLine) -le 16384) 'BA_START_BOUND';$start=$startLine|ConvertFrom-Json;BAKeys $start @('schema','binding');BAString $start.schema 'clued.root-owned-ba-observer-start181/1'
  & $owner {param($b,$r)BindOwnedBAObserverOnce181 $b $r} $start.binding $reader
  return (& $owner {InvokeOwnedBAObserverOnce181})
 }finally{$held.Dispose()}
}
if($MyInvocation.InvocationName -ne '.'){@{schema='clued.ba-observer-wrapper-preview181/1';status='PREVIEW_CAPTURED_ROOT_OWNED_BOOTSTRAP_REQUIRED';physical_owner_packet=$null;task_operations=0;uac=$false}|ConvertTo-Json -Compress}
