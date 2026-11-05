# Private captured elevated RELAY adapter. Reuses original Relay*/NodeIngress*
# and owned_effects214 functions in this exact owning module. No CLI entry.
# One reader owns Root stdin; Node and Self pipe waits are asynchronous. Neither
# pipe gets a second reader or a detached callback/provider from incoming JSON.
function MuxRequire214($value,[string]$code){if($value -isnot [bool] -or -not $value){throw $code}}
function MuxWrite214($value){RelayWriteRoot $value}
function MuxResult214([string]$kind,[string]$request,$value){MuxWrite214 ([ordered]@{schema='clued.root-owned-relay-result214/1';kind=$kind;request_id=$request;value=$value})}
function MuxValidateCommand214($cmd){
 RelayKeys $cmd @('schema','kind','request_id','body');RelayString $cmd.schema 'clued.root-owned-relay-command214/1'
 MuxRequire214 ($cmd.kind -is [string] -and $cmd.kind -cin @('NODE_REPLY','SELF_REPLY','BIND_SELF','INSPECT_SELF','REOPEN_PROOF','PUBLISH_SELECTOR') -and $cmd.request_id -is [string] -and $cmd.request_id -cmatch '\A(?:[1-9][0-9]{0,3}:)?[a-f0-9]{32}\z') 'ROOT_FIXED_COMMAND_DOMAIN'
}
function MuxMayReuseMetadata214($state,[string]$method,[long]$now){
 # The original single-service pending-root IsCompleted test cannot be reused
 # as an EOF test: this shared reader can contain a valid Node control reply.
 # The mux consumes and validates all completed Root commands first. Only
 # metadata may use the same fixed private2s observation, never effect guards.
 MuxRequire214 (-not $state.closed) 'ROOT_CHANNEL_CLOSED'
 if($method -ceq 'VerifyObserverPhase' -or $null -eq $state.lease_reply){return $false}
 $age=($now-$state.lease_time)*1000.0/[Diagnostics.Stopwatch]::Frequency
 if($age -lt 0 -or $age -ge 2000){return $false}
 if(([double]$state.lease_reply.ready_age_ms+$age) -ge 120000){return $false}
 return ($method -cin @('VerifyLive','VerifyCapturedSource','VerifyObserverStillWaiting','ReadVerifiedObserverReady','ExpectedObserverSourceCaptureSha256'))
}
function MuxValidateSelfReply214($state,$pending,$reply){
 # Same closed primitive/subject/phase checks as original RelayCurrentReply;
 # only transport wait/correlation lives in the single multiplexed loop now.
 RelayKeys $reply @('schema','session_id','request_id','request_sha256','method','canonical_receipt_id','decision','observer_ready','observer_phase','ready_age_ms')
 RelayString $reply.schema 'clued.root-owned-authority-reply181/1';RelayString $reply.session_id $state.binding.session_id;RelayString $reply.request_id $pending.head;RelayString $reply.request_sha256 $pending.sha;RelayString $reply.method $pending.method
 RelayRequire ($reply.canonical_receipt_id -is [string] -and $reply.canonical_receipt_id -cmatch '\A[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\z') 'ROOT_CANON_RECEIPT_REQUIRED'
 RelayString $reply.canonical_receipt_id $state.binding.owner_receipt_id;RelayString $reply.decision 'CURRENT_FOR_EXACT_ROOT_OWNED_REQUEST'
 RelayRequire ($reply.observer_phase -is [string] -and $reply.observer_phase -cin @('WAITING_SELF_REGISTERED','AWAITING_INSTANCE') -and ($reply.ready_age_ms -is [int] -or $reply.ready_age_ms -is [long]) -and $reply.ready_age_ms -ge 0 -and $reply.ready_age_ms -lt 120000) 'ROOT_OWNED_PRODUCER_PHASE_OR_AGE'
 $r=$reply.observer_ready;RelayKeys $r @('schema','role','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256','source_capture_sha256','phase')
 foreach($n in $r.PSObject.Properties.Name){RelayRequire ($r.$n -is [string]) 'ROOT_READY_STRING'}
 RelayString $r.schema 'clued.windows-self-entry-ready181/1';RelayString $r.role 'BA_OBSERVER';RelayString $r.phase 'FACTORY_PREFLIGHT_READY_WAITING_SELF_REGISTERED'
 foreach($n in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256')){RelayString $r.$n $state.binding.$n};RelayString $r.source_capture_sha256 $state.binding.observer_capture_sha256
 $null=RelayPeerChain $state;return (RelayClone $reply)
}
function MuxFinishSelf214($state,$pending,$reply){
 $method=$pending.method;$argument=$pending.argument;$binding=$state.binding
 $response=@{status='VERIFIED_BY_TRUSTED_AUTHORITY'}
 if($method -ceq 'VerifyLive'){$response=@{host=$binding.host;node_id=$binding.node_id;attempt_id=$binding.attempt_id;accepted_subject_sha256=$binding.accepted_subject_sha256;owner_receipt_id=$binding.owner_receipt_id;code_captured=$true;channel_bound=$true}}
 elseif($method -ceq 'ReadVerifiedObserverReady'){$response=RelayClone $reply.observer_ready}
 elseif($method -ceq 'ExpectedObserverSourceCaptureSha256'){$response=@{sha256=$binding.observer_capture_sha256}}
 elseif($method -ceq 'VerifyObserverStillWaiting'){RelayString $reply.observer_phase 'WAITING_SELF_REGISTERED'}
 elseif($method -ceq 'VerifyObserverPhase'){
  if($argument -ceq 'register'){RelayRequire (-not $state.register_guard_spent -and -not $state.run_guard_spent) 'REGISTER_GUARD_ONCE';RelayLocalPhase $state 'register' $reply;$state.register_guard_spent=$true}
  else{RelayRequire ($state.register_guard_spent -and -not $state.run_guard_spent) 'RUN_AFTER_REGISTER_GUARD_ONCE';RelayLocalPhase $state 'run' $reply;$state.run_guard_spent=$true}
 }
 $null=RelayPeerChain $state;$json=$response|ConvertTo-Json -Compress -Depth 12
 $state.pipe.Send([Text.UTF8Encoding]::new($false).GetBytes($pending.head+"`n"+$json),2000)
}
function NewMuxSelfState214($binding,$strictJson){
 $target=RelayBoundTarget $binding;MuxRequire214 ($binding.relay_pid -eq $PID) 'ACTUAL_OWNED_RELAY_PID'
 $s=@{binding=$binding;target=$target;parser=$strictJson;pipe=$null;ps=$null;node=$null;ba=$null;relay=$null;sequence=0;lease_reply=$null;lease_time=0L;lease_phase=$null;register_guard_spent=$false;run_guard_spent=$false;closed=$false;ps_image=(Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe')}
 try{
  foreach($role in @('ps','node','ba','relay')){$s[$role]=[CluedQualification181.HeldProcess]::new($binding.($role+'_pid'))}
  $s.pipe=[CluedLocalTransport181.LocalPipe]::ListenForAcceptedAttempt($binding.attempt_id)
  return $s
 }catch{foreach($n in @('pipe','ps','node','ba','relay')){if($null -ne $s[$n]){$s[$n].Dispose()}};throw}
}
function InvokeRelayIngressMux214($capturedInitial,[scriptblock]$capturedStrictJson,[IO.StreamReader]$capturedRootReader){
 MuxRequire214 ($null -ne $capturedInitial.owner_packet -and $null -ne $capturedInitial.binding -and $capturedStrictJson -is [scriptblock] -and $capturedRootReader -is [IO.StreamReader]) 'CAPTURED_OWNER_AND_ROOT_READER_REQUIRED'
 $c=$capturedInitial;$b=$c.binding
 foreach($n in @('attempt_id','packet_sha256','host','node_id','session_id')){MuxRequire214 ($b.$n -is [string]) 'MUX_INITIAL_RAW_CAPTURE'}
 MuxRequire214 ($b.attempt_id -cmatch '\A[a-f0-9]{32}\z' -and $b.session_id -cmatch '\A[a-f0-9]{32}\z' -and $b.packet_sha256 -cmatch '\A[a-f0-9]{64}\z') 'MUX_INITIAL_DOMAIN'
 $nodeIngress=$null;$self=$null;$selfAccept=$null;$selfRead=$null;$pendingSelf=$null;$pendingNode=$null;$nodeBound=$false;$selfEnded=$false;$selfEofTick=0L;$proofReopened=$false;$selectorPublished=$false;$clock=[Diagnostics.Stopwatch]::StartNew();$rootRead=$null;$commandCount=0
 try{
  InitializeOwnedEffects214 $c
  $nodeIngress=NewRootNodeIngress212 $b.attempt_id $capturedStrictJson
  MuxWrite214 ([ordered]@{schema='clued.root-owned-relay-ingress-listening214/1';session_id=$b.session_id;host=$b.host;attempt_id=$b.attempt_id;packet_sha256=$b.packet_sha256;pid=$PID;authority_from_message=$false})
  $rootRead=$capturedRootReader.ReadLineAsync()
  while($clock.ElapsedMilliseconds -lt 300000 -and $commandCount -lt 1024){
   # Root control first: no completed command is mistaken for private revocation.
   if($rootRead.IsCompleted){
    $line=$rootRead.GetAwaiter().GetResult();MuxRequire214 ($line -is [string] -and $line.Length -gt 0 -and [Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'ROOT_COMMAND_EOF_OR_BOUND'
    $cmd=& $capturedStrictJson $line;MuxValidateCommand214 $cmd
    $commandCount++;$rootRead=$capturedRootReader.ReadLineAsync()
    if($cmd.kind -ceq 'PUBLISH_SELECTOR'){
     MuxRequire214 (-not $selectorPublished -and -not $nodeBound -and $null -eq $self) 'SELECTOR_CREATE_ONLY_BEFORE_NODE_AND_SELF'
     $value=InvokePublishSelector216 $cmd.body $c;$selectorPublished=$true;MuxResult214 'PUBLISH_SELECTOR' $cmd.request_id $value
    }elseif($cmd.kind -ceq 'NODE_REPLY'){
     MuxRequire214 ($null -ne $pendingNode) 'NODE_REPLY_WITHOUT_PENDING';$q=$pendingNode.q;$v=$cmd.body
     RelayKeys $v @('schema','seq','request_id','operation','request_sha256','status','value');RelayString $v.schema 'clued.node-ingress-reply212/1';RelayString $v.request_id $q.request_id;RelayString $cmd.request_id $q.request_id;RelayString $v.operation $q.operation;RelayString $v.request_sha256 $pendingNode.sha;RelayString $v.status 'CURRENT_FOR_EXACT_ROOT_OWNED_REQUEST'
     MuxRequire214 ($v.seq -is [int] -and $v.seq -eq $q.seq) 'NODE_REPLY_SEQUENCE';WriteRootNodeReply212 $nodeIngress ($v|ConvertTo-Json -Depth 12 -Compress);$pendingNode=$null
    }elseif($cmd.kind -ceq 'SELF_REPLY'){
     MuxRequire214 ($null -ne $pendingSelf -and $null -ne $self) 'SELF_REPLY_WITHOUT_PENDING';RelayString $cmd.request_id $pendingSelf.head
     $reply=MuxValidateSelfReply214 $self $pendingSelf $cmd.body;$self.lease_reply=RelayClone $reply;$self.lease_time=[Diagnostics.Stopwatch]::GetTimestamp();$self.lease_phase=$reply.observer_phase
     MuxFinishSelf214 $self $pendingSelf $reply;$pendingSelf=$null;$selfRead=[CluedOriginalPipeTask214.Shim]::ReceiveIdle($self.pipe,180000)
    }elseif($cmd.kind -ceq 'INSPECT_SELF'){
     MuxRequire214 ($nodeBound -and $null -eq $self) 'INSPECT_ACTUAL_NODE_BEFORE_BIND';RelayKeys $cmd.body @('metadata','actual_node')
     foreach($n in @('broker_pid','broker_start','node_pid','node_start','node_sid','node_image')){MuxRequire214 ([object]::Equals($cmd.body.actual_node.$n,$nodeIngress.peer.$n)) 'ROOT_INSPECT_ACTUAL_KERNEL_NODE'}
     $value=InvokeInspectSelf214 $cmd.body $c;MuxResult214 'INSPECT_SELF' $cmd.request_id $value
    }elseif($cmd.kind -ceq 'BIND_SELF'){
     MuxRequire214 ($nodeBound -and $null -eq $self) 'SELF_BIND_ONCE_AFTER_NODE'
     $binding=$cmd.body;$null=RelayBoundTarget $binding;BindOwnedEffects214 $binding
     $self=NewMuxSelfState214 $binding $capturedStrictJson;$selfAccept=[CluedOriginalPipeTask214.Shim]::Accept($self.pipe,120000)
     $start=[pscustomobject]@{attempt_id=$binding.attempt_id;node_pid=$binding.node_pid;node_start=$binding.node_start;node_image=$binding.node_image;relay_pid=$binding.relay_pid;relay_start=$binding.relay_start;relay_sid=$binding.relay_sid}
     MuxResult214 'BOUND_SELF' $cmd.request_id $start
    }elseif($cmd.kind -ceq 'REOPEN_PROOF'){
     MuxRequire214 ($null -ne $self) 'PROOF_BEFORE_SELF_BIND';$value=InvokeReopenProof214 $cmd.body $c;if($cmd.body.mode -ceq 'REOPEN' -and $value.status -ceq 'INDEPENDENT_NATIVE_PROOF_VALIDATED'){$proofReopened=$true};MuxResult214 'REOPEN_PROOF' $cmd.request_id $value
    }
   }
   if(-not $nodeBound -and $nodeIngress.accept.IsCompleted){$peer=CompleteRootNodeIngressAccept212 $nodeIngress;$nodeBound=$true;MuxWrite214 ([ordered]@{schema='clued.root-owned-node-peer214/1';session_id=$b.session_id;actual_node=$peer;authority_from_message=$false})}
   # Self is accepted/read without blocking Node launch-ready or proof traffic.
   if($null -ne $selfAccept -and $selfAccept.IsCompleted){$selfAccept.GetAwaiter().GetResult();$selfAccept=$null;$null=RelayPeerChain $self;$selfRead=[CluedOriginalPipeTask214.Shim]::ReceiveIdle($self.pipe,180000)}
   if($null -ne $selfRead -and $selfRead.IsCompleted -and $null -eq $pendingSelf){
    try{[byte[]]$raw=$selfRead.GetAwaiter().GetResult()}catch{
     # A clean Self EOF after its actual process exit is terminal metadata, not
     # failure of the independent Node proof-read path. Never retry Self.
     $e=$_.Exception;while($null -ne $e.InnerException){$e=$e.InnerException}
     if($e -is [IO.EndOfStreamException] -or $self.ps.HasExited){$selfEofTick=[Diagnostics.Stopwatch]::GetTimestamp();$selfRead=$null;continue};throw
    }
    $selfRead=$null;$parts=([Text.UTF8Encoding]::new($false,$true).GetString($raw)).Split("`n");RelayRequire ($parts.Length -eq 3) 'RELAY_REQUEST_LINES';$head=$parts[0];$method=$parts[1];$argument=$parts[2];$self.sequence++
    RelayRequire ($head -cmatch ('\A'+$self.sequence.ToString([Globalization.CultureInfo]::InvariantCulture)+':[0-9a-f]{32}\z') -and $self.sequence -le 1024 -and $method -cin @('VerifyLive','VerifyCapturedSource','VerifyObserverStillWaiting','ReadVerifiedObserverReady','ExpectedObserverSourceCaptureSha256','VerifyObserverPhase')) 'RELAY_SEQUENCE_OR_METHOD'
    if($method -ceq 'VerifyCapturedSource'){RelayString $argument $self.binding.runner_capture_sha256}elseif($method -ceq 'VerifyObserverPhase'){RelayRequire ($argument -cin @('register','run')) 'RELAY_OPERATION'}else{RelayString $argument ''}
    $facts=RelayPeerChain $self;$now=[Diagnostics.Stopwatch]::GetTimestamp();$pending=@{head=$head;method=$method;argument=$argument;tick=$now}
    if(MuxMayReuseMetadata214 $self $method $now){MuxFinishSelf214 $self $pending (RelayClone $self.lease_reply);$selfRead=[CluedOriginalPipeTask214.Shim]::ReceiveIdle($self.pipe,180000)}
    else{
     $request=[ordered]@{schema='clued.root-owned-authority-request181/1';session_id=$self.binding.session_id;request_id=$head;method=$method;argument=$argument;binding=(RelayClone $self.binding);actual_chain=$facts}
     $text=$request|ConvertTo-Json -Depth 12 -Compress;$pending.sha=RelayHash ([Text.UTF8Encoding]::new($false).GetBytes($text));$pendingSelf=$pending
     # Emit the exact bytes hashed above; this remains original181 shape.
     [Console]::Out.WriteLine($text);[Console]::Out.Flush()
    }
   }
   if($nodeBound -and $null -eq $pendingNode -and $null -ne $nodeIngress.read -and $nodeIngress.read.IsCompleted){
    try{$frame=ReadCompletedRootNodeRequest212 $nodeIngress}catch{$e=$_.Exception;while($null -ne $e.InnerException){$e=$e.InnerException};if(($e -is [IO.EndOfStreamException] -or $nodeIngress.broker.HasExited) -and $proofReopened -and ($selfEnded -or ($selfEofTick -gt 0 -and $self.ps.HasExited))){if(-not $selfEnded){$selfEnded=$true;MuxWrite214 ([ordered]@{schema='clued.root-owned-self-eof214/1';session_id=$b.session_id;exit_code=$self.ps.ExitCode;automatic_retry=$false})};MuxWrite214 ([ordered]@{schema='clued.root-owned-relay-mux-complete214/1';session_id=$b.session_id;proof_reopened=$true;self_exit_code=$self.ps.ExitCode;automatic_retry=$false});return};throw}
    $q=& $capturedStrictJson $frame.raw;$pendingNode=@{q=$q;sha=(RelayHash ([Text.UTF8Encoding]::new($false).GetBytes($frame.raw)));tick=[Diagnostics.Stopwatch]::GetTimestamp()};MuxWrite214 $frame
   }
   if($selfEofTick -gt 0 -and -not $selfEnded){if($self.ps.HasExited){$selfEnded=$true;MuxWrite214 ([ordered]@{schema='clued.root-owned-self-eof214/1';session_id=$b.session_id;exit_code=$self.ps.ExitCode;automatic_retry=$false})}else{MuxRequire214 (([Diagnostics.Stopwatch]::GetTimestamp()-$selfEofTick)*1000.0/[Diagnostics.Stopwatch]::Frequency -lt 5000) 'SELF_EOF_WITHOUT_ACTUAL_PROCESS_EXIT'}}
   $now=[Diagnostics.Stopwatch]::GetTimestamp();if($null -ne $pendingSelf){MuxRequire214 (($now-$pendingSelf.tick)*1000.0/[Diagnostics.Stopwatch]::Frequency -lt 16000) 'SELF_ROOT_REPLY_TIMEOUT_NO_RETRY'}
   if($null -ne $pendingNode){MuxRequire214 (($now-$pendingNode.tick)*1000.0/[Diagnostics.Stopwatch]::Frequency -lt 18000) 'NODE_ROOT_REPLY_TIMEOUT_NO_RETRY'}
   Start-Sleep -Milliseconds 2
  }
  throw 'MUX_LIFETIME_OR_COMMAND_LIMIT_NO_RETRY'
 }finally{
  if($null -ne $nodeIngress){CloseRootNodeIngress212 $nodeIngress}
  if($null -ne $self){$self.closed=$true;foreach($n in @('pipe','ps','node','ba','relay')){if($null -ne $self[$n]){$self[$n].Dispose()}}}
  CloseOwnedEffects214
 }
}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_ROOT_OWNED_RELAY_MUX_ONLY_NO_CLI'}
