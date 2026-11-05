# Private, captured server library. No CLI execute switch or token/credential input.
# A protected Root-owned bootstrap supplies accepted binding to this internal API.
# Root owns the actual child Process/stdio; JSON detached from that channel is data.
function RelayRequire($value,[string]$code){if($value -isnot [bool] -or -not $value){throw $code}}
function RelayKeys($value,[string[]]$keys){RelayRequire ($value -is [pscustomobject] -and ((@($value.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'RELAY_CLOSED_OBJECT'}
function RelayString($value,[string]$expected){RelayRequire ($value -is [string] -and $value -ceq $expected) 'RELAY_STRING_BINDING'}
function RelayHash([byte[]]$raw){$s=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($s.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function RelayClone($value){return ($value|ConvertTo-Json -Compress -Depth 12|ConvertFrom-Json)}
function RelaySnapshot($held,[int]$expectedPid,[long]$expectedStart,[string]$sid,[int]$elevation,[string]$image){
 $s=$held.Observe();RelayRequire ($s.Pid -eq $expectedPid -and $s.CreationFileTime -eq $expectedStart -and $s.Sid -ceq $sid -and $s.Elevated -eq $elevation -and $s.Image -ieq $image) 'RELAY_HELD_IDENTITY';return $s
}
function RelayBoundTarget($binding){
 RelayKeys $binding @('session_id','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','packet_sha256','request_sha256','predecessor_r9_index_sha256','node_pid','node_start','node_image','ps_pid','ps_start','ba_pid','ba_start','ba_sid','relay_pid','relay_start','relay_sid','observer_capture_sha256','runner_capture_sha256')
 foreach($name in @('session_id','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','packet_sha256','request_sha256','predecessor_r9_index_sha256','node_image','ba_sid','relay_sid','observer_capture_sha256','runner_capture_sha256')){RelayRequire ($binding.$name -is [string]) 'RELAY_BINDING_STRING'}
 foreach($name in @('session_id','attempt_id')){RelayRequire ($binding.$name -cmatch '^[0-9a-f]{32}$') 'RELAY_CORRELATION_FORMAT'}
 foreach($name in @('accepted_subject_sha256','packet_sha256','request_sha256','predecessor_r9_index_sha256','observer_capture_sha256','runner_capture_sha256')){RelayRequire ($binding.$name -cmatch '^[0-9a-f]{64}$') 'RELAY_HASH_FORMAT'}
 RelayRequire ($binding.ba_sid -cmatch '^S-1-5-21-[0-9-]{1,150}$' -and $binding.relay_sid -cmatch '^S-1-5-21-[0-9-]{1,150}$' -and [IO.Path]::GetFileName($binding.node_image) -ieq 'node.exe') 'RELAY_BA_PRINCIPAL_AND_NODE_IMAGE'
 RelayRequire ($binding.owner_receipt_id -cmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') 'RELAY_OWNER_RECEIPT_FORMAT'
 foreach($name in @('node_pid','ps_pid','ba_pid','relay_pid')){RelayRequire ($binding.$name -is [int] -and $binding.$name -gt 0) 'RELAY_PID_TYPE'}
 foreach($name in @('node_start','ps_start','ba_start','relay_start')){RelayRequire ($binding.$name -is [string] -and $binding.$name -cmatch '^[1-9][0-9]{0,18}$' -and [long]::Parse($binding.$name,[Globalization.CultureInfo]::InvariantCulture) -gt 0) 'RELAY_START_TYPE'}
 RelayRequire ($binding.ba_pid -ne $binding.relay_pid) 'BA_OBSERVER_RELAY_PROCESS_ALIAS_REFUSED'
 $t=SelfTarget ([Environment]::MachineName);RelayString $binding.host $t.host;RelayString $binding.node_id $t.node_id;RelayString $binding.request_sha256 $t.request_sha256;RelayString $binding.predecessor_r9_index_sha256 $t.predecessor_index_sha256
 RelayString $binding.observer_capture_sha256 '17c85ea6052ce15f4d501316247009ff374aebc435841e016fabd609fd7d12e3'
 RelayString $binding.runner_capture_sha256 '258f5437df03824066a1cf2bd8ef2f1a4cfb4c4b921d7aba904100e60cc1f1fd'
 return (RelayClone $t)
}
function RelayWriteRoot($value){$line=$value|ConvertTo-Json -Compress -Depth 12;RelayRequire ([Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'ROOT_REQUEST_BOUND';[Console]::Out.WriteLine($line);[Console]::Out.Flush()}
function RelayReadRoot([scriptblock]$strictJson,[int]$milliseconds){
 RelayRequire ($milliseconds -gt 0 -and $milliseconds -le 5000) 'ROOT_REPLY_WAIT_BOUND'
 $pending=[Console]::In.ReadLineAsync();RelayRequire ($pending.Wait($milliseconds)) 'ROOT_AUTHORITY_TIMEOUT_NO_RETRY'
 $line=$pending.Result;RelayRequire ($line -is [string] -and $line.Length -gt 0 -and $line.Length -le 16384 -and [Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'ROOT_AUTHORITY_EOF_OR_BOUND'
 return (& $strictJson $line)
}
function RelayPeerChain($state){
 $b=$state.binding;$t=$state.target
 RelayRequire ($state.pipe.PeerPid -eq $b.ps_pid -and $state.pipe.PeerCreationFileTime -eq $b.ps_start) 'KERNEL_PIPE_NOT_BOUND_PS_CHILD'
 $ps=RelaySnapshot $state.ps $b.ps_pid $b.ps_start $t.sid 0 $state.ps_image
 $node=RelaySnapshot $state.node $b.node_pid $b.node_start $t.sid 0 $b.node_image
 RelayRequire ($ps.ParentPid -eq $node.Pid -and $ps.CreationFileTime -ge $node.CreationFileTime) 'NODE_OWNED_PS_CHILD_RELATION'
 $null=RelaySnapshot $state.relay $b.relay_pid $b.relay_start $b.relay_sid 1 $state.ps_image
 $null=RelaySnapshot $state.ba $b.ba_pid $b.ba_start $b.ba_sid 1 $state.ps_image
 return @{ps_pid=$ps.Pid;ps_start=$ps.CreationFileTime.ToString([Globalization.CultureInfo]::InvariantCulture);ps_parent_pid=$ps.ParentPid;node_pid=$node.Pid;node_start=$node.CreationFileTime.ToString([Globalization.CultureInfo]::InvariantCulture);ba_pid=$b.ba_pid;ba_start=$b.ba_start;relay_pid=$b.relay_pid;relay_start=$b.relay_start}
}
function RelayCurrentReply($state,[string]$head,[string]$method,[string]$argument,$facts){
 $request=[ordered]@{schema='clued.root-owned-authority-request181/1';session_id=$state.binding.session_id;request_id=$head;method=$method;argument=$argument;binding=(RelayClone $state.binding);actual_chain=$facts}
 $raw=[Text.UTF8Encoding]::new($false).GetBytes(($request|ConvertTo-Json -Compress -Depth 12));$requestHash=RelayHash $raw
 RelayWriteRoot $request
 $pending=$state.root_read;RelayRequire ($null -ne $pending -and $pending.Wait(4000)) 'ROOT_AUTHORITY_TIMEOUT_NO_RETRY';$line=$pending.Result;RelayRequire ($line -is [string] -and $line.Length -gt 0 -and [Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'ROOT_AUTHORITY_EOF_OR_BOUND';$state.root_read=$state.root_reader.ReadLineAsync();$reply=& $state.parser $line
 RelayKeys $reply @('schema','session_id','request_id','request_sha256','method','canonical_receipt_id','decision','observer_ready','observer_phase','ready_age_ms')
 RelayString $reply.schema 'clued.root-owned-authority-reply181/1';RelayString $reply.session_id $state.binding.session_id;RelayString $reply.request_id $head;RelayString $reply.request_sha256 $requestHash;RelayString $reply.method $method
 RelayRequire ($reply.canonical_receipt_id -is [string] -and $reply.canonical_receipt_id -cmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') 'ROOT_CANON_RECEIPT_REQUIRED'
 RelayString $reply.decision 'CURRENT_FOR_EXACT_ROOT_OWNED_REQUEST'
 RelayRequire ($reply.observer_phase -is [string] -and $reply.observer_phase -cin @('WAITING_SELF_REGISTERED','AWAITING_INSTANCE') -and ($reply.ready_age_ms -is [int] -or $reply.ready_age_ms -is [long]) -and $reply.ready_age_ms -ge 0 -and $reply.ready_age_ms -lt 120000) 'ROOT_OWNED_PRODUCER_PHASE_OR_AGE'
 # The ready was read by Root from its actual owned BA stdout, not from Self.
 $r=$reply.observer_ready;RelayKeys $r @('schema','role','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256','source_capture_sha256','phase')
 foreach($n in $r.PSObject.Properties.Name){RelayRequire ($r.$n -is [string]) 'ROOT_READY_STRING'}
 RelayString $r.schema 'clued.windows-self-entry-ready181/1';RelayString $r.role 'BA_OBSERVER';RelayString $r.phase 'FACTORY_PREFLIGHT_READY_WAITING_SELF_REGISTERED'
 foreach($n in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256')){RelayString $r.$n $state.binding.$n};RelayString $r.source_capture_sha256 $state.binding.observer_capture_sha256
 $null=RelayPeerChain $state
 return (RelayClone $reply)
}
function RelayLocalPhase($state,[string]$operation,$reply){
 $ackPath=Join-Path $state.target.control 'self-registration181.observer-ready.json'
 if($operation -ceq 'register'){
  RelayString $reply.observer_phase 'WAITING_SELF_REGISTERED'
  # Unknown existence is refusal. No adoption of an old ACK.
  try{$null=Get-Item -Force -LiteralPath $ackPath -ErrorAction Stop;throw 'ACK_ALREADY_PRESENT_BEFORE_REGISTER'}catch{if($_.Exception -isnot [Management.Automation.ItemNotFoundException]){throw}}
 }else{
  RelayString $reply.observer_phase 'AWAITING_INSTANCE'
  [byte[]]$raw=[CluedQualification181.SafeEvidence]::Read($ackPath,16384,'S-1-5-32-544')
  $ack=& $state.parser ([Text.UTF8Encoding]::new($false,$true).GetString($raw));RelayKeys $ack @('schema','host','node_id','expected_sid','attempt_id','request_sha256','nonce','intended_xml_sha256','accepted_subject_sha256','task_instances_empty')
  RelayString $ack.schema 'clued.windows-self-observer-ready181/1';foreach($n in @('host','node_id','attempt_id','request_sha256','accepted_subject_sha256')){RelayString $ack.$n $state.binding.$n};RelayString $ack.expected_sid $state.target.sid
  RelayRequire ($ack.nonce -is [string] -and $ack.nonce -cmatch '^[0-9a-f]{32}$' -and $ack.intended_xml_sha256 -is [string] -and $ack.intended_xml_sha256 -cmatch '^[0-9a-f]{64}$' -and $ack.task_instances_empty -is [bool] -and $ack.task_instances_empty) 'ACK_PRIMITIVES'
  [byte[]]$registeredRaw=[CluedQualification181.SafeEvidence]::Read((Join-Path $state.target.output 'self-registration181.registered.json'),16384,$state.target.sid)
  $registered=& $state.parser ([Text.UTF8Encoding]::new($false,$true).GetString($registeredRaw));RelayKeys $registered @('schema','host','node_id','expected_sid','attempt_id','request_sha256','nonce','task_name','intended_xml_sha256','accepted_subject_sha256')
  foreach($n in @('host','node_id','expected_sid','attempt_id','request_sha256','nonce','intended_xml_sha256','accepted_subject_sha256')){RelayString $registered.$n $ack.$n};RelayString $registered.schema 'clued.windows-self-registered181/1';RelayString $registered.task_name $state.target.task_name
 }
}
function InvokeRootBoundAuthorityServer181($capturedBinding,[scriptblock]$capturedStrictJson){
 # Internal factory after the protected no-argument Root bootstrap, not a CLI API.
 # Root verifies exact packet/Source/current Owner/claim in its own MCP Binding.
 # A detached caller-supplied binding/response cannot establish that bootstrap.
 $binding=RelayClone $capturedBinding;$target=RelayBoundTarget $binding
 $state=@{binding=$binding;target=$target;parser=$capturedStrictJson;pipe=$null;ps=$null;node=$null;ba=$null;relay=$null;sequence=0;root_read=$null;root_reader=([IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false,$true),$false,4096,$true));lease_reply=$null;lease_time=0L;lease_phase=$null;register_guard_spent=$false;run_guard_spent=$false;ps_image=(Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe')}
 try{
  RelayRequire ($binding.relay_pid -eq $PID) 'ROOT_OWNED_RELAY_PID_MISMATCH'
  $state.pipe=[CluedLocalTransport181.LocalPipe]::ListenForAcceptedAttempt($binding.attempt_id)
  RelayWriteRoot @{schema='clued.root-owned-relay-listening181/1';session_id=$binding.session_id;host=$binding.host;attempt_id=$binding.attempt_id;packet_sha256=$binding.packet_sha256;pid=$PID;authority_from_message=$false}
  # Scheduling signal only. Root obtains an exec session before releasing children.
  $startRead=$state.root_reader.ReadLineAsync();RelayRequire ($startRead.Wait(120000)) 'ROOT_START_SIGNAL_TIMEOUT';$startLine=$startRead.Result;RelayRequire ($startLine -is [string] -and $startLine.Length -le 1024) 'ROOT_START_SIGNAL_BOUND';$start=& $capturedStrictJson $startLine
  RelayKeys $start @('schema','session_id','packet_sha256','signal');RelayString $start.schema 'clued.root-owned-relay-start181/1';RelayString $start.session_id $binding.session_id;RelayString $start.packet_sha256 $binding.packet_sha256;RelayString $start.signal 'START_AFTER_OWNED_STDIO_SESSION_ESTABLISHED'
  $state.root_read=$state.root_reader.ReadLineAsync()
  $state.pipe.Accept(120000)
  $state.ps=[CluedQualification181.HeldProcess]::new($binding.ps_pid);$state.node=[CluedQualification181.HeldProcess]::new($binding.node_pid);$state.ba=[CluedQualification181.HeldProcess]::new($binding.ba_pid);$state.relay=[CluedQualification181.HeldProcess]::new($binding.relay_pid)
  while($state.sequence -lt 1024){
   [byte[]]$raw=$state.pipe.Receive(5000);$parts=([Text.UTF8Encoding]::new($false,$true).GetString($raw)).Split("`n");RelayRequire ($parts.Length -eq 3) 'RELAY_REQUEST_LINES'
   $head=$parts[0];$method=$parts[1];$argument=$parts[2];$state.sequence++
   RelayRequire ($head -cmatch ('^'+$state.sequence.ToString([Globalization.CultureInfo]::InvariantCulture)+':[0-9a-f]{32}$') -and $method -cin @('VerifyLive','VerifyCapturedSource','VerifyObserverStillWaiting','ReadVerifiedObserverReady','ExpectedObserverSourceCaptureSha256','VerifyObserverPhase')) 'RELAY_SEQUENCE_OR_METHOD'
   if($method -ceq 'VerifyCapturedSource'){RelayString $argument $binding.runner_capture_sha256}elseif($method -ceq 'VerifyObserverPhase'){RelayRequire ($argument -cin @('register','run')) 'RELAY_OPERATION'}else{RelayString $argument ''}
     # Check pending Root EOF/revocation before using any short private lease.
   RelayRequire (-not $state.root_read.IsCompleted) 'ROOT_CHANNEL_CLOSED_OR_UNSOLICITED_REVOCATION'
   $facts=RelayPeerChain $state
   $now=[Diagnostics.Stopwatch]::GetTimestamp();$leaseAge=($now-$state.lease_time)*1000.0/[Diagnostics.Stopwatch]::Frequency
   # Fixed2000ms policy, no caller TTL. Only repetitive VerifyLive is cached.
   # Source/ready/phase and both actual operation guards always ask Root afresh.
   if($method -ceq 'VerifyLive' -and $null -ne $state.lease_reply -and $leaseAge -ge 0 -and $leaseAge -lt 2000){$reply=RelayClone $state.lease_reply}
   else{$reply=RelayCurrentReply $state $head $method $argument $facts;$state.lease_reply=RelayClone $reply;$state.lease_time=[Diagnostics.Stopwatch]::GetTimestamp();$state.lease_phase=$reply.observer_phase}
   $response=@{status='VERIFIED_BY_TRUSTED_AUTHORITY'}
   if($method -ceq 'VerifyLive'){$response=@{host=$binding.host;node_id=$binding.node_id;attempt_id=$binding.attempt_id;accepted_subject_sha256=$binding.accepted_subject_sha256;owner_receipt_id=$binding.owner_receipt_id;code_captured=$true;channel_bound=$true}}
   elseif($method -ceq 'ReadVerifiedObserverReady'){$response=RelayClone $reply.observer_ready}
   elseif($method -ceq 'ExpectedObserverSourceCaptureSha256'){$response=@{sha256=$binding.observer_capture_sha256}}
   elseif($method -ceq 'VerifyObserverStillWaiting'){RelayString $reply.observer_phase 'WAITING_SELF_REGISTERED'}
   elseif($method -ceq 'VerifyObserverPhase'){
    if($argument -ceq 'register'){RelayRequire (-not $state.register_guard_spent -and -not $state.run_guard_spent) 'REGISTER_GUARD_ONCE';RelayLocalPhase $state 'register' $reply;$state.register_guard_spent=$true}
    else{RelayRequire ($state.register_guard_spent -and -not $state.run_guard_spent) 'RUN_AFTER_REGISTER_GUARD_ONCE';RelayLocalPhase $state 'run' $reply;$state.run_guard_spent=$true}
   }
   $null=RelayPeerChain $state;$json=$response|ConvertTo-Json -Compress -Depth 12;$state.pipe.Send([Text.UTF8Encoding]::new($false).GetBytes($head+"`n"+$json),2000)
  }
  throw 'RELAY_REQUEST_LIMIT'
 }finally{foreach($name in @('pipe','ps','node','ba','relay')){if($null -ne $state[$name]){$state[$name].Dispose()}}}
}
if($MyInvocation.InvocationName -ne '.'){@{schema='clued.root-authority-relay-preview181/1';status='PREVIEW_PROTECTED_ROOT_BOOTSTRAP_REQUIRED';physical_owner_packet=$null;task_operations=0;uac=$false}|ConvertTo-Json -Compress}
