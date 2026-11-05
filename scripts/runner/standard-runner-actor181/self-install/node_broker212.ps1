# Only exact captured bytes in the actual Node-owned PS child. This broker is
# distinct from the later captured Self actor; it never registers or runs Task.
$ErrorActionPreference='Stop'
function N212Require($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function N212Hash([byte[]]$b){$s=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function N212Keys($v,[string[]]$keys){N212Require ($v -is [pscustomobject] -and (($v.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'BROKER_CLOSED'}
$reader=$script:NodeBrokerReader212;N212Require ($reader -is [IO.StreamReader]) 'CAPTURED_ORIGINAL_NODE_STDIN_READER'
$line=$reader.ReadLine();N212Require ($line -is [string] -and $line.Length -le 262144) 'BROKER_CAPTURE_BOUND';$capture=$line|ConvertFrom-Json;N212Keys $capture @('schema','identity','native','selector')
N212Require ($capture.schema -is [string] -and $capture.schema -ceq 'clued.node-ingress-broker-capture212/1') 'BROKER_CAPTURE_SCHEMA'
$pins=@{identity='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';native='abfd6fae020b3f0cb31e43cd3802ec98cb089472f70579310dc99ce42e3048cb'}
$bytes=@{};foreach($name in $pins.Keys){$text=$capture.$name;N212Require ($text -is [string] -and $text.Length -le 131072) 'BROKER_NATIVE_BOUND';$b=[Convert]::FromBase64String($text);N212Require ($b.Length -gt 0 -and $b.Length -le 65536 -and (N212Hash $b) -ceq $pins[$name]) 'BROKER_NATIVE_PIN';$bytes[$name]=$b}
foreach($a in [AppDomain]::CurrentDomain.GetAssemblies()){N212Require ($null -eq $a.GetType('CluedQualification181.HeldProcess',$false) -and $null -eq $a.GetType('CluedNodeAuthority212.IngressPipe',$false)) 'BROKER_PREEXISTING_TYPES'}
$null=[Reflection.Assembly]::Load($bytes.identity);$null=[Reflection.Assembly]::Load($bytes.native)
$s=$capture.selector;N212Keys $s @('schema','attempt_id','root_pid','root_start','root_sid','packet_sha256','owner_receipt_id','source_acceptance_ref')
foreach($n in @('schema','attempt_id','root_start','root_sid','packet_sha256','owner_receipt_id','source_acceptance_ref')){N212Require ($s.$n -is [string]) 'BROKER_SELECTOR_TYPE'}
N212Require ($s.schema -ceq 'clued.node-ingress-selector212/1' -and $s.root_pid -is [int] -and $s.root_pid -gt 0 -and $s.root_start -cmatch '^[1-9][0-9]{0,18}$' -and $s.attempt_id -cmatch '^[a-f0-9]{32}$' -and $s.packet_sha256 -cmatch '^[a-f0-9]{64}$') 'BROKER_SELECTOR_DOMAIN'
$self=[CluedQualification181.HeldProcess]::new($PID);$node=$null;$pipe=$null
try{
 $me=$self.Observe();$node=[CluedQualification181.HeldProcess]::new($me.ParentPid);$nf=$node.Observe()
 N212Require ($me.Sid -ceq $nf.Sid -and $me.Elevated -eq 0 -and $nf.Elevated -eq 0 -and [IO.Path]::GetFileName($nf.Image) -ieq 'node.exe') 'BROKER_REAL_NODE_PARENT'
 $pipe=[CluedNodeAuthority212.IngressPipe]::ConnectForAcceptedAttempt($s.attempt_id,$s.root_pid,[long]::Parse($s.root_start),$s.root_sid)
 $peer=$pipe.ObserveAuthenticatedPeer()
 [Console]::Out.WriteLine((@{schema='clued.node-ingress-broker-ready212/1';broker_pid=$me.Pid;broker_start=[string]$me.CreationFileTime;node_pid=$nf.Pid;node_start=[string]$nf.CreationFileTime;node_sid=$nf.Sid;root_pid=$peer.Pid;root_start=[string]$peer.CreationFileTime;root_sid=$peer.Sid;root_elevated=$peer.Elevated;packet_sha256=$s.packet_sha256;authority_granted=$false}|ConvertTo-Json -Compress));[Console]::Out.Flush()
 $sequence=0
 while($sequence -lt 1024){
  $line=$reader.ReadLine();if($null -eq $line){break};N212Require ($line.Length -le 16384 -and $line -notmatch '[\r\n]') 'BROKER_ONE_REQUEST'
  $q=$line|ConvertFrom-Json;N212Keys $q @('schema','seq','request_id','operation','body');$sequence++
  N212Require ($q.schema -is [string] -and $q.schema -ceq 'clued.node-ingress-request212/1' -and $q.seq -is [int] -and $q.seq -eq $sequence -and $q.request_id -is [string] -and $q.request_id -cmatch '^[a-f0-9]{32}$' -and $q.operation -is [string] -and $q.operation -cin @('Open','AcceptedSource','BindInvocation','Current','ObserverReady','BindCapturedSelf','ObserverPhase','LaunchReady','ProofStatus','ReopenProof')) 'BROKER_REQUEST_DOMAIN'
  $pipe.Send([Text.UTF8Encoding]::new($false).GetBytes($line),20000)
  [byte[]]$reply=$pipe.ReceiveIdle(90000);$out=[Text.UTF8Encoding]::new($false,$true).GetString($reply);N212Require ($out.Length -le 16384 -and $out -notmatch '[\r\n]') 'BROKER_REPLY_BOUND'
  [Console]::Out.WriteLine($out);[Console]::Out.Flush()
 }
}finally{if($pipe){$pipe.Dispose()};if($node){$node.Dispose()};$self.Dispose()}
