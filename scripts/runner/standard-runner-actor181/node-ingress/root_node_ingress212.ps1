# Captured RELAY library, not a CLI launcher or authorization API. The original
# Root UAC pipe and its three ACEs are untouched. This separate pipe has the
# original BA/Self exact ACL and belongs to the accepted owned elevated relay.
function NI212Require($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function NI212Keys($v,[string[]]$names){NI212Require ($v -is [pscustomobject] -and (($v.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($names|Sort-Object)-join '|')) 'NODE_INGRESS_FIELDS'}
function NewRootNodeIngress212([string]$acceptedAttempt,[scriptblock]$capturedStrictJson){
 NI212Require ($acceptedAttempt -cmatch '^[a-f0-9]{32}$' -and $capturedStrictJson -is [scriptblock]) 'NODE_INGRESS_CAPTURED_FACTORY'
 $own=[CluedQualification181.HeldProcess]::new($PID);try{$o=$own.Observe();NI212Require ($o.Elevated -eq 1 -and $o.Sid -cne 'S-1-5-18') 'ROOT_OWNED_ELEVATED_RELAY_ONLY'}finally{$own.Dispose()}
 $p=[CluedNodeAuthority212.IngressPipe]::ListenForAcceptedAttempt($acceptedAttempt)
 return @{pipe=$p;accept=$p.AcceptAsync(120000);read=$null;parser=$capturedStrictJson;sequence=0;closed=$false;broker=$null;node=$null;peer=$null;source_broker_is_self=$false}
}
function CompleteRootNodeIngressAccept212($state){
 NI212Require (-not $state.closed -and $null -eq $state.peer -and $state.accept.IsCompleted) 'NODE_ACCEPT_NOT_READY_OR_SPENT';$state.accept.GetAwaiter().GetResult()
 $peer=$state.pipe.ObserveAuthenticatedPeer();$state.broker=[CluedQualification181.HeldProcess]::new($peer.Pid);$state.node=[CluedQualification181.HeldProcess]::new($peer.ParentPid);$node=$state.node.Observe()
 NI212Require ($node.Pid -ne $peer.Pid -and $peer.ParentPid -eq $node.Pid -and $node.Sid -ceq $peer.Sid -and $node.Elevated -eq 0 -and [IO.Path]::GetFileName($node.Image) -ieq 'node.exe' -and $peer.CreationFileTime -ge $node.CreationFileTime) 'ACTUAL_NODE_BROKER_PARENT_CHAIN'
 $state.peer=@{broker_pid=$peer.Pid;broker_start=[string]$peer.CreationFileTime;node_pid=$node.Pid;node_start=[string]$node.CreationFileTime;node_sid=$node.Sid;node_image=$node.Image}
 $state.read=$state.pipe.ReceiveIdleAsync(180000)
 return ($state.peer|ConvertTo-Json -Compress|ConvertFrom-Json)
}
function ReadCompletedRootNodeRequest212($state){
 NI212Require (-not $state.closed -and $null -ne $state.peer -and $null -ne $state.read -and $state.read.IsCompleted) 'NODE_REQUEST_NOT_READY'
 try{
  [byte[]]$raw=$state.read.GetAwaiter().GetResult();$text=[Text.UTF8Encoding]::new($false,$true).GetString($raw);$q=& $state.parser $text
  NI212Keys $q @('schema','seq','request_id','operation','body');$state.sequence++
  NI212Require ($q.schema -is [string] -and $q.schema -ceq 'clued.node-ingress-request212/1' -and $q.seq -is [int] -and $q.seq -eq $state.sequence -and $q.seq -le 1024 -and $q.request_id -is [string] -and $q.request_id -cmatch '^[a-f0-9]{32}$' -and $q.operation -is [string] -and $q.operation -cin @('Open','AcceptedSource','BindInvocation','Current','ObserverReady','BindCapturedSelf','ObserverPhase','LaunchReady','ProofStatus','ReopenProof')) 'NODE_REQUEST_SEQUENCE_OR_OPERATION'
  $p=$state.broker.Observe();$n=$state.node.Observe();NI212Require ($state.pipe.PeerPid -eq $p.Pid -and $p.CreationFileTime.ToString() -ceq $state.peer.broker_start -and $p.ParentPid -eq $n.Pid -and $n.Pid -eq $state.peer.node_pid -and $n.CreationFileTime.ToString() -ceq $state.peer.node_start -and $p.Sid -ceq $n.Sid) 'NODE_HELD_PEER_CONTINUITY'
  # One pending Root decision, not an automatic reconnect or concurrent reader.
  $state.read=$null
  return @{schema='clued.root-node-request212/1';raw=$text;actual_node=($state.peer|ConvertTo-Json -Compress|ConvertFrom-Json)}
 }catch{$state.closed=$true;$state.pipe.Dispose();throw}
}
function WriteRootNodeReply212($state,[string]$capturedRootReply){
 NI212Require (-not $state.closed -and $null -eq $state.read -and $capturedRootReply -notmatch '[\r\n]' -and [Text.Encoding]::UTF8.GetByteCount($capturedRootReply) -le 4096) 'NODE_REPLY_STATE_OR_BOUND'
 $state.pipe.Send([Text.UTF8Encoding]::new($false).GetBytes($capturedRootReply),2000);$state.read=$state.pipe.ReceiveIdleAsync(180000)
}
function CloseRootNodeIngress212($state){$state.closed=$true;$state.pipe.Dispose();foreach($n in @('broker','node')){if($null -ne $state[$n]){$state[$n].Dispose()}}}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_RELAY_LIBRARY_ONLY_NO_NODE_INGRESS_CLI'}
