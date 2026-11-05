# Installation-only successor of the214 Node mux. Two actual212 listeners;
# route identity is the listener held here, never a role in incoming JSON.
function IR216Need($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function IR216Emit($v){[Console]::Out.WriteLine(($v|ConvertTo-Json -Compress -Depth 12));[Console]::Out.Flush()}
function IR216PeerMatch($actual,$expected){foreach($n in @('broker_pid','broker_start','node_pid','node_start','node_sid','node_image')){IR216Need ([object]::Equals($actual.$n,$expected.$n)) 'INSTALL_HELD_NODE_PEER_DRIFT'}}
function IR216Inspect($m,$peer,$plan){
 InstallKeys211 $m @('schema','host','ps_pid','ps_start','ps_parent_pid','ps_sid','ps_elevated','node_pid','node_start','node_sid','node_elevated','node_image','source_captured','authority_granted')
 IR216Need ($m.schema -ceq 'clued.node-install-self-captured215/1' -and $m.host -ceq $plan.row.host -and $m.ps_pid -is [int] -and $m.ps_pid -gt 0 -and $m.ps_pid -ne $peer.broker_pid -and $m.node_pid -eq $peer.node_pid -and $m.ps_parent_pid -eq $peer.node_pid -and $m.node_start -ceq $peer.node_start -and $m.node_sid -ceq $peer.node_sid -and $m.ps_sid -ceq $plan.row.expected_sid -and $m.ps_elevated -is [int] -and $m.ps_elevated -eq 0 -and $m.node_elevated -is [int] -and $m.node_elevated -eq 0 -and $m.source_captured -is [bool] -and $m.source_captured -and $m.authority_granted -is [bool] -and -not $m.authority_granted) 'INSTALL_SELF_METADATA_NOT_AUTHORITY'
 $self=[CluedQualification181.HeldProcess]::new($m.ps_pid);$node=$null
 try{
  $node=[CluedQualification181.HeldProcess]::new($peer.node_pid);$s=$self.Observe();$n=$node.Observe();$ps=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
  IR216Need (-not $self.HasExited -and -not $node.HasExited -and $s.Pid -eq $m.ps_pid -and $s.ParentPid -eq $n.Pid -and $s.CreationFileTime.ToString() -ceq $m.ps_start -and $n.CreationFileTime.ToString() -ceq $peer.node_start -and $s.Sid -ceq $plan.row.expected_sid -and $n.Sid -ceq $s.Sid -and $s.Elevated -eq 0 -and $n.Elevated -eq 0 -and $s.Image -ieq $ps -and $n.Image -ieq $peer.node_image -and [IO.Path]::GetFileName($n.Image) -ieq 'node.exe') 'INSTALL_ACTUAL_HELD_SELF_CHAIN'
  $argv=[CluedQualification181.CommandLine]::Parse($self.ReadCommandLine());IR216Need ($argv.Count -eq 5 -and $argv[0] -ieq $ps -and $argv[1] -ceq '-NoProfile' -and $argv[2] -ceq '-NonInteractive' -and $argv[3] -ceq '-EncodedCommand') 'INSTALL_ACTUAL_SELF_ARGV'
  $code=[Convert]::FromBase64String($argv[4]);IR216Need ($code.Length -eq $script:InstallBootstrapBytes216 -and (BytesHash $code) -ceq $script:InstallBootstrapSha216) 'INSTALL_ACTUAL_FIXED_SOURCE_BOOTSTRAP'
  $out=@{self=$self;node=$node;metadata=$m};$self=$null;$node=$null;return $out
 }finally{if($self){$self.Dispose()};if($node){$node.Dispose()}}
}
function IR216SelfPeer($peer,$held,$nodePeer,$plan){
 $s=$held.self.Observe();$n=$held.node.Observe()
 IR216Need (-not $held.self.HasExited -and -not $held.node.HasExited -and $peer.broker_pid -eq $s.Pid -and $peer.broker_start -ceq $s.CreationFileTime.ToString() -and $peer.node_pid -eq $n.Pid -and $peer.node_start -ceq $n.CreationFileTime.ToString() -and $peer.node_pid -eq $nodePeer.node_pid -and $s.ParentPid -eq $n.Pid -and $s.Sid -ceq $plan.row.expected_sid -and $n.Sid -ceq $s.Sid -and $s.Elevated -eq 0 -and $n.Elevated -eq 0) 'INSTALL_SECOND_LISTENER_ACTUAL_SELF_NOT_BROKER'
}
function IR216Reply($state,$pending,$value,[string]$id){
 $q=$pending.q;InstallKeys211 $value @('schema','seq','request_id','operation','request_sha256','status','value')
 IR216Need ($id -ceq $q.request_id -and $value.schema -ceq 'clued.node-ingress-reply212/1' -and $value.seq -is [int] -and $value.seq -eq $q.seq -and $value.request_id -ceq $q.request_id -and $value.operation -ceq $q.operation -and $value.request_sha256 -ceq $pending.sha -and $value.status -ceq 'CURRENT_FOR_EXACT_ROOT_OWNED_REQUEST') 'INSTALL_ROOT_REPLY_EXACT_PENDING'
 WriteRootNodeReply212 $state ($value|ConvertTo-Json -Compress -Depth 12)
}
function IR216PublishSelector($p){
 # Reuse the qualification-created exact directory under the same reviewed
 # native no-share-delete held parent+directory lease. Never create/adopt a
 # weaker directory, change an existing ACL, overwrite or remove a locator.
 $dir='C:\ProgramData\CluedIndependentCI\standard-runner-actor'
 $lease=[CluedSelectorPublisher216.Publisher]::HoldExistingDirectoryForInstall($p.row.expected_sid)
 $own=[CluedQualification181.HeldProcess]::new($PID)
 try{$s=$own.Observe();IR216Need ($s.Elevated -eq 1) 'INSTALL_SELECTOR_ACTUAL_ROOT';$value=[ordered]@{schema='clued.node-ingress-selector212/1';attempt_id=$p.attempt_id;root_pid=[int]$PID;root_start=$s.CreationFileTime.ToString();root_sid=$s.Sid;packet_sha256=$p.actor_packet_sha256;owner_receipt_id=$p.owner_receipt_id;source_acceptance_ref=$p.source_acceptance_ref};$raw=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Compress))
  $security=[Security.AccessControl.FileSecurity]::new();$security.SetSecurityDescriptorBinaryForm([CluedSelectorPublisher216.Publisher]::FileSecurityBytes($p.row.expected_sid))
  $pending=Join-Path $dir 'root-node-install-selector215.json.pending216';$final=Join-Path $dir 'root-node-install-selector215.json'
  $file=[IO.FileStream]::new($pending,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,$security)
  try{$file.Write($raw,0,$raw.Length);$file.Flush($true)}finally{$file.Dispose()}
  foreach($path in @($pending,$final)){
   if($path -ceq $final){[IO.File]::Move($pending,$final)}
   $acl=[IO.File]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
   IR216Need ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544' -and $acl.AreAccessRulesProtected -and $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ceq $security.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) 'INSTALL_SELECTOR_EXACT_NEW_FILE_DACL'
   $read=[CluedQualification181.SafeEvidence]::Read($path,4096,'S-1-5-32-544');IR216Need ((BytesHash $read) -ceq (BytesHash $raw)) 'INSTALL_SELECTOR_EXACT_ATOMIC_READBACK'
  }
  return [pscustomobject]@{status='EXACT_NEW_INSTALL_SELECTOR_PUBLISHED';attempt_id=$p.attempt_id;actor_packet_sha256=$p.actor_packet_sha256;root_pid=[int]$PID;root_start=$s.CreationFileTime.ToString();root_sid=$s.Sid}
 }finally{$own.Dispose();$lease.Dispose()}
}
function InvokeInstallIngressMux216($initial,[scriptblock]$strict,[IO.StreamReader]$reader){
 $p=$initial.install_plan;$r=InstallPlan211 $p;AssertInstallBA212
 IR216Need ($reader -is [IO.StreamReader] -and $strict -is [scriptblock] -and $p.actor_packet_sha256 -ceq $initial.binding.packet_sha256 -and $p.attempt_id -ceq $initial.binding.attempt_id -and $r.expected_sid -ceq $initial.target_sid -and $r.host -ceq [Environment]::MachineName) 'INSTALL_PRIVATE_RELAY_CAPTURE'
 $node=$null;$self=$null;$held=$null;$np=$null;$sp=$null;$nodePending=$null;$selfPending=$null;$commandSeq=0;$proof=$false;$published=$false;$clock=[Diagnostics.Stopwatch]::StartNew()
 try{
  $node=NewRootNodeIngress212 $p.attempt_id $strict
  $derived=(BytesHash ([Text.Encoding]::UTF8.GetBytes('clued.install-self215/'+$p.attempt_id))).Substring(0,32);$self=NewRootNodeIngress212 $derived $strict
  IR216Emit ([ordered]@{schema='clued.root-install-relay-listening216/1';attempt_id=$p.attempt_id;actor_packet_sha256=$p.actor_packet_sha256;pid=$PID;self_pipe_attempt=$derived;authority_from_message=$false})
  $read=$reader.ReadLineAsync()
  while($clock.ElapsedMilliseconds -lt 300000 -and $commandSeq -lt 128){
   if($read.IsCompleted){
    $line=$read.GetAwaiter().GetResult();IR216Need ($line -is [string] -and [Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'INSTALL_ROOT_CONTROL_EOF_BOUND';$cmd=& $strict $line
    InstallKeys211 $cmd @('schema','kind','request_id','body');$commandSeq++;IR216Need ($cmd.schema -ceq 'clued.root-install-relay-command216/1' -and $cmd.kind -is [string] -and $cmd.kind -cin @('NODE_REPLY','SELF_REPLY','INSPECT_SELF','REOPEN_SELF','PUBLISH_SELECTOR','FINISH') -and $cmd.request_id -is [string] -and $cmd.request_id -cmatch '\A[a-f0-9]{32}\z') 'INSTALL_FIXED_ROOT_CONTROL'
    $read=$reader.ReadLineAsync()
    if($cmd.kind -ceq 'NODE_REPLY'){IR216Need ($null -ne $nodePending) 'INSTALL_NODE_REPLY_PENDING';IR216Reply $node $nodePending $cmd.body $cmd.request_id;$nodePending=$null}
    elseif($cmd.kind -ceq 'SELF_REPLY'){IR216Need ($null -ne $selfPending -and $null -ne $held) 'INSTALL_SELF_REPLY_PENDING';IR216SelfPeer $sp $held $np $p;IR216Reply $self $selfPending $cmd.body $cmd.request_id;$selfPending=$null}
    elseif($cmd.kind -ceq 'INSPECT_SELF'){
     IR216Need ($null -eq $held -and $null -ne $np) 'INSTALL_INSPECT_ONCE_AFTER_NODE';InstallKeys211 $cmd.body @('metadata','actual_node');IR216PeerMatch $cmd.body.actual_node $np;$held=IR216Inspect $cmd.body.metadata $np $p
     $s=$held.self.Observe();$value=[pscustomobject]@{status='ACTUAL_INSTALL_SELF_HELD';ps_pid=$s.Pid;ps_start=$s.CreationFileTime.ToString();node_pid=$np.node_pid;node_start=$np.node_start;target_sid=$s.Sid}
     IR216Emit ([ordered]@{schema='clued.root-install-relay-result216/1';kind=$cmd.kind;request_id=$cmd.request_id;value=$value})
    }elseif($cmd.kind -ceq 'REOPEN_SELF'){
     InstallKeys211 $cmd.body @();IR216Need ($null -ne $held -and $held.self.HasExited -and $held.self.ExitCode -eq 0) 'INSTALL_ENTRY_ACTUAL_EXIT0_REQUIRED';$proof=$true
     IR216Emit ([ordered]@{schema='clued.root-install-relay-result216/1';kind=$cmd.kind;request_id=$cmd.request_id;value=[pscustomobject]@{status='ACTUAL_INSTALL_SELF_EXIT0';ps_pid=$held.metadata.ps_pid;exit_code=[int]$held.self.ExitCode}})
    }elseif($cmd.kind -ceq 'PUBLISH_SELECTOR'){InstallKeys211 $cmd.body @();IR216Need (-not $published -and $null -eq $np) 'INSTALL_SELECTOR_PUBLISH_ONCE_BEFORE_NODE';$value=IR216PublishSelector $p;$published=$true;IR216Emit ([ordered]@{schema='clued.root-install-relay-result216/1';kind=$cmd.kind;request_id=$cmd.request_id;value=$value})}
    else{InstallKeys211 $cmd.body @();IR216Need ($proof -and $null -eq $selfPending -and $null -eq $nodePending) 'INSTALL_FINISH_AFTER_REOPEN_AND_REPLIES';return}
   }
   if($null -eq $np -and $node.accept.IsCompleted){$np=CompleteRootNodeIngressAccept212 $node;IR216Emit ([ordered]@{schema='clued.root-install-node-peer216/1';actual_node=$np;attempt_id=$p.attempt_id;actor_packet_sha256=$p.actor_packet_sha256})}
   if($null -eq $sp -and $self.accept.IsCompleted){IR216Need ($null -ne $held -and $null -ne $np) 'INSTALL_SELF_CONNECTED_BEFORE_CAPTURE';$sp=CompleteRootNodeIngressAccept212 $self;IR216SelfPeer $sp $held $np $p}
   foreach($which in @('node','self')){
    $state=$node;if($which -ceq 'self'){$state=$self};$pending=$nodePending;if($which -ceq 'self'){$pending=$selfPending}
    if($null -ne $state.peer -and $null -eq $pending -and $null -ne $state.read -and $state.read.IsCompleted){
     try{$frame=ReadCompletedRootNodeRequest212 $state}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if($e -is [IO.EndOfStreamException] -and (($which -ceq 'self' -and $held.self.HasExited) -or ($which -ceq 'node' -and $proof))){$state.read=$null;continue};throw}
     $q=& $strict $frame.raw;$v=@{q=$q;sha=(BytesHash ([Text.Encoding]::UTF8.GetBytes($frame.raw)));tick=[Diagnostics.Stopwatch]::GetTimestamp()}
     if($which -ceq 'node'){$nodePending=$v;IR216Emit $frame}else{IR216SelfPeer $sp $held $np $p;$selfPending=$v;IR216Emit ([ordered]@{schema='clued.root-install-self-request216/1';raw=$frame.raw;actual_self=$frame.actual_node})}
    }
   }
   $now=[Diagnostics.Stopwatch]::GetTimestamp();foreach($pending in @($nodePending,$selfPending)){if($null -ne $pending){ $limit=89000;if($pending -eq $selfPending -and $pending.q.operation -ceq 'Current'){$limit=19000};IR216Need (($now-$pending.tick)*1000.0/[Diagnostics.Stopwatch]::Frequency -lt $limit) 'INSTALL_ROOT_FRESH_REPLY_TIMEOUT_NO_RETRY'}}
   Start-Sleep -Milliseconds 2
  };throw 'INSTALL_RELAY_LIFETIME_BOUND_NO_RETRY'
 }finally{foreach($s in @($node,$self)){if($null -ne $s){CloseRootNodeIngress212 $s}};if($held){$held.self.Dispose();$held.node.Dispose()}}
}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_INSTALL_RELAY_ONLY_NO_CLI'}
