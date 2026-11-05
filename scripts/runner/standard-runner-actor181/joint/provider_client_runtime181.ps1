# Loaded only from exact accepted captured bytes in a future trusted owner module.
# This is the entry-r2 method adapter, NOT a no-argument authority resolver.
# It cannot supply Owner approval, a live claim, Source admission or source bytes.
function NewLocalPipeRunnerProvider181($pipe,[scriptblock]$strictJson){
 if($pipe -isnot [CluedLocalTransport181.LocalPipe] -or $strictJson -isnot [scriptblock]){throw 'AUTHENTICATED_PIPE_AND_CAPTURED_STRICT_PARSER_REQUIRED'}
 # This internal factory must be called solely by the protected captured resolver.
 # Parser must be original ObsStrictEvidenceJson from the captured BA namespace.
 $state=@{pipe=$pipe;parser=$strictJson;sequence=0;closed=$false;binding=$null;atomic=$null}
 $call={param([string]$method,[string]$argument)
  if($state.closed -or $method -cnotin @('VerifyLive','VerifyCapturedSource','VerifyObserverStillWaiting','ReadVerifiedObserverReady','ExpectedObserverSourceCaptureSha256','VerifyObserverPhase')){throw 'RPC_METHOD_OR_CLOSED'}
  if($method -ceq 'VerifyCapturedSource'){if($argument -cnotmatch '^[0-9a-f]{64}$'){throw 'RPC_CAPTURE_ARGUMENT'}}elseif($method -ceq 'VerifyObserverPhase'){if($argument -cnotin @('register','run')){throw 'RPC_PHASE_ARGUMENT'}}elseif($argument -cne ''){throw 'RPC_UNEXPECTED_ARGUMENT'}
  try{
   if($state.sequence -ge 1024){throw 'RPC_REQUEST_LIMIT'};$state.sequence++
   # Correlation only, never a secret or authorization capability.
   $challenge=[Guid]::NewGuid().ToString('N')
   $head=$state.sequence.ToString([Globalization.CultureInfo]::InvariantCulture)+':'+$challenge
   $utf8=[Text.UTF8Encoding]::new($false,$true)
   $state.pipe.Send($utf8.GetBytes($head+"`n"+$method+"`n"+$argument),20000)
   [byte[]]$bytes=$state.pipe.Receive(20000);$text=$utf8.GetString($bytes);$line=$text.IndexOf("`n")
   if($line -lt 1 -or $text.Substring(0,$line) -cne $head){throw 'RPC_RESPONSE_CORRELATION'}
   $value=& $state.parser $text.Substring($line+1)
   if($method -cin @('VerifyCapturedSource','VerifyObserverStillWaiting','VerifyObserverPhase')){
    if($value -isnot [pscustomobject] -or @($value.PSObject.Properties).Count -ne 1 -or $value.PSObject.Properties.Name -cne 'status' -or $value.status -isnot [string] -or $value.status -cne 'VERIFIED_BY_TRUSTED_AUTHORITY'){throw 'RPC_VERIFICATION_RESPONSE'}
    return
   }
   if($method -ceq 'ExpectedObserverSourceCaptureSha256'){if($value -isnot [pscustomobject] -or @($value.PSObject.Properties).Count -ne 1 -or $value.PSObject.Properties.Name -cne 'sha256' -or $value.sha256 -isnot [string] -or $value.sha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'RPC_CAPTURE_RESPONSE'};return $value.sha256}
   return $value
  }catch{$state.closed=$true;$state.pipe.Dispose();throw}
 }.GetNewClosure()
 # The six methods match the existing reviewed entry-r2 consumer exactly.
 # None invokes Register/Run or accepts an arbitrary executable/argv/path.
 $p=[pscustomobject]@{}
 $p|Add-Member -MemberType ScriptMethod -Name VerifyLive -Value ({
  if($null -ne $state.atomic){
   if($state.atomic.stage -cne 'fresh-phase' -or ([Diagnostics.Stopwatch]::GetTimestamp()-$state.atomic.tick)*1000.0/[Diagnostics.Stopwatch]::Frequency -ge 2000){$state.closed=$true;$state.pipe.Dispose();throw 'ATOMIC_LIVE_STAGE_OR_EXPIRY'}
   $null=$state.pipe.PeerPid;$state.atomic.stage='live-consumed';return ($state.binding|ConvertTo-Json -Compress -Depth 12|ConvertFrom-Json)
  }
  $value=& $call 'VerifyLive' '';if($value -isnot [pscustomobject] -or ((@($value.PSObject.Properties.Name)|Sort-Object)-join '|') -cne ((@('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','code_captured','channel_bound')|Sort-Object)-join '|')){throw 'ATOMIC_STATIC_BINDING_CLOSED'}
  $state.binding=$value|ConvertTo-Json -Compress -Depth 12|ConvertFrom-Json;return ($state.binding|ConvertTo-Json -Compress -Depth 12|ConvertFrom-Json)
 }.GetNewClosure())
 $p|Add-Member -MemberType ScriptMethod -Name VerifyCapturedSource -Value ({param([string]$digest)& $call 'VerifyCapturedSource' $digest}.GetNewClosure())
 $p|Add-Member -MemberType ScriptMethod -Name VerifyObserverStillWaiting -Value ({& $call 'VerifyObserverStillWaiting' ''}.GetNewClosure())
 $p|Add-Member -MemberType ScriptMethod -Name ReadVerifiedObserverReady -Value ({& $call 'ReadVerifiedObserverReady' ''}.GetNewClosure())
 $p|Add-Member -MemberType ScriptMethod -Name ExpectedObserverSourceCaptureSha256 -Value ({& $call 'ExpectedObserverSourceCaptureSha256' ''}.GetNewClosure())
 # Begin/End are private fixed-source lastguard mechanics, never wire methods
 # or caller-supplied flags. Only a new fresh Root Phase response creates a
 # one-operation ticket; prior VerifyLive metadata cannot be upgraded.
 $p|Add-Member -MemberType ScriptMethod -Name BeginAtomicOperation -Value ({param([string]$operation)
  if($state.closed -or $null -ne $state.atomic -or $null -eq $state.binding -or $operation -cnotin @('register','run')){throw 'ATOMIC_BEGIN_STATE'}
  $null=& $call 'VerifyObserverPhase' $operation
  $state.atomic=@{operation=$operation;stage='fresh-phase';tick=[Diagnostics.Stopwatch]::GetTimestamp()}
 }.GetNewClosure())
 $p|Add-Member -MemberType ScriptMethod -Name VerifyObserverPhase -Value ({param([string]$operation)
  if($null -eq $state.atomic -or $state.atomic.operation -cne $operation -or $state.atomic.stage -cne 'live-consumed' -or ([Diagnostics.Stopwatch]::GetTimestamp()-$state.atomic.tick)*1000.0/[Diagnostics.Stopwatch]::Frequency -ge 2000){$state.closed=$true;$state.pipe.Dispose();throw 'ATOMIC_PHASE_STAGE_OPERATION_OR_EXPIRY'}
  $null=$state.pipe.PeerPid;$state.atomic.stage='phase-consumed'
 }.GetNewClosure())
 $p|Add-Member -MemberType ScriptMethod -Name EndAtomicOperation -Value ({param([string]$operation)
  if($null -eq $state.atomic -or $state.atomic.operation -cne $operation -or $state.atomic.stage -cne 'phase-consumed' -or ([Diagnostics.Stopwatch]::GetTimestamp()-$state.atomic.tick)*1000.0/[Diagnostics.Stopwatch]::Frequency -ge 2000){$state.closed=$true;$state.pipe.Dispose();throw 'ATOMIC_END_WITHOUT_EXACT_CONSUMPTION'}
  $state.atomic=$null
 }.GetNewClosure())
 return $p
}
