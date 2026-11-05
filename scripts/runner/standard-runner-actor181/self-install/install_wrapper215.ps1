# Captured Self-only installation child, no CLI execution or caller callbacks.
$env:PSModulePath=$PSHOME+'\Modules';$PSModuleAutoLoadingPreference='None'
foreach($n in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security')){Import-Module ($PSHOME+'\Modules\'+$n+'\'+$n+'.psd1') -ErrorAction Stop}
$env:SystemRoot=[IO.Directory]::GetParent([Environment]::SystemDirectory).FullName
function I215Need($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function I215Hash([byte[]]$raw){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function I215Keys($v,[string[]]$keys){I215Need ($v -is [pscustomobject] -and (($v.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'INSTALL_WRAPPER_CLOSED_OBJECT'}
function I215PipeAttempt([string]$attempt){I215Need ($attempt -cmatch '\A[a-f0-9]{32}\z') 'INSTALL_ACCEPTED_ATTEMPT';return (I215Hash ([Text.Encoding]::UTF8.GetBytes('clued.install-self215/'+$attempt))).Substring(0,32)}
function InvokeCapturedInstallStdio215 {
 $reader=$script:InstallOwnedStdin215;I215Need ($reader -is [IO.StreamReader]) 'INSTALL_OWNED_NODE_STDIN_REQUIRED'
 $line=$reader.ReadLine();I215Need ($line -is [string] -and $line.Length -le 2097152) 'INSTALL_CAPTURE_BOUND'
 $payload=$line|ConvertFrom-Json;I215Keys $payload @('schema','members');I215Need ($payload.schema -is [string] -and $payload.schema -ceq 'clued.node-install-capture215/1') 'INSTALL_CAPTURE_SCHEMA'
 $pins=@{'namespace'='88a8388c9d3f5c0a814549de0cd4cb8ba7820860fab05f674bbc04b0f30dd4b9';'core'='0401d559c495469f213ef4eaf00b8590c9eea91bba0dc3c58e2983b483e9c3e4';'enrollment_adapter'='69cccbbf0899c82ac09f35e163cc782cb2edab385be05e984cf9b14e00956627';'enrollment_code'='9395b92c4724e498f02f9a138f76a1cb60cb5b6deba351725a1baee5579f7a79';'xml_helpers'='aa5dfe432ce9d6c0f6a1b867c1950b5036ec431056dc30560a1d230a74e6efb5';'self_helpers'='c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616';'definition'='0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4';'registration'='642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb';'identity'='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';'ingress'='abfd6fae020b3f0cb31e43cd3802ec98cb089472f70579310dc99ce42e3048cb'};I215Keys $payload.members @($pins.Keys);$held=@{}
 foreach($name in $pins.Keys){$v=$payload.members.$name;I215Need ($v -is [string] -and $v.Length -le 1398104) 'INSTALL_CAPTURE_MEMBER';$b=[Convert]::FromBase64String($v);I215Need ($b.Length -gt 0 -and $b.Length -le 1048576 -and (I215Hash $b) -ceq $pins[$name]) 'INSTALL_CAPTURE_SHA';$held[$name]=[byte[]]$b.Clone()
  if($name -cnotin @('identity','ingress','enrollment_code')){$tok=$null;$err=$null;$null=[Management.Automation.Language.Parser]::ParseInput([Text.UTF8Encoding]::new($false,$true).GetString($b),[ref]$tok,[ref]$err);I215Need ($err.Count -eq 0) 'INSTALL_CAPTURE_PS_PARSE'}
 }
 foreach($a in [AppDomain]::CurrentDomain.GetAssemblies()){I215Need ($null -eq $a.GetType('CluedQualification181.HeldProcess',$false) -and $null -eq $a.GetType('CluedNodeAuthority212.IngressPipe',$false)) 'INSTALL_FRESH_NATIVE_NAMESPACE'}
 $identity=[Reflection.Assembly]::Load($held.identity);$ingress=[Reflection.Assembly]::Load($held.ingress)
 I215Need ([CluedQualification181.HeldProcess].Assembly -eq $identity -and [CluedNodeAuthority212.IngressPipe].Assembly -eq $ingress) 'INSTALL_NATIVE_TYPE_COLLISION'
 $module=New-Module {
  param($caps)
  foreach($name in @('namespace','self_helpers','definition','registration','xml_helpers','core','enrollment_adapter')){. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($caps[$name])))}
  $script:source=$caps;$script:spent=$false;$script:pipe=$null;$script:seq=0;$script:plan=$null
  function InstallDirectRoot215([string]$operation,[string]$phase,$fixed){
   if($null -eq $script:pipe -or $script:seq -ge 128 -or $operation -cnotin @('Current','ObserverPhase')){throw 'INSTALL_DIRECT_ROOT_REQUIRED'}
   if(($operation -ceq 'Current' -and $phase -cnotin @('before-enroll','before-register','after-register','before-run','observe-worker')) -or ($operation -ceq 'ObserverPhase' -and $phase -cnotin @('enrolled-before-register','registered-worker','before-initial-run-if-empty','actual-worker'))){throw 'INSTALL_FIXED_ROOT_PHASE'}
   $script:seq++;$id=[Guid]::NewGuid().ToString('N')
   $request=[ordered]@{schema='clued.node-ingress-request212/1';seq=$script:seq;request_id=$id;operation=$operation;body=[ordered]@{stage='INSTALL';purpose='standard_runner_self_s4u_maintenance_install_once';phase=$phase;attempt_id=$script:plan.attempt_id;actor_packet_sha256=$script:plan.actor_packet_sha256;fixed=$fixed}}
   $raw=$request|ConvertTo-Json -Compress -Depth 12;InstallRequire211 ([Text.Encoding]::UTF8.GetByteCount($raw) -le 4096) 'INSTALL_ROOT_REQUEST_BOUND'
   $script:pipe.Send([Text.UTF8Encoding]::new($false).GetBytes($raw),20000)
   $replyRaw=if($operation -ceq 'Current'){$script:pipe.Receive(20000)}else{$script:pipe.ReceiveIdle(90000)};$reply=SelfStrictJson ([Text.UTF8Encoding]::new($false,$true).GetString($replyRaw))
   InstallKeys211 $reply @('schema','seq','request_id','operation','request_sha256','status','value')
   InstallRequire211 ((InstallSame211 $reply.schema 'clued.node-ingress-reply212/1') -and $reply.seq -is [int] -and $reply.seq -eq $script:seq -and (InstallSame211 $reply.request_id $id) -and (InstallSame211 $reply.operation $operation) -and (InstallSame211 $reply.request_sha256 (BytesHash ([Text.Encoding]::UTF8.GetBytes($raw)))) -and (InstallSame211 $reply.status 'CURRENT_FOR_EXACT_ROOT_OWNED_REQUEST')) 'INSTALL_KERNEL_ROOT_REPLY_NOT_EXACT'
   return $reply.value
  }
  function InstallEvidenceNew215([string]$name,$value){
   InstallRequire211 ($name -cin @('self-install215.intent.json','self-install211.result.json')) 'INSTALL_FIXED_EVIDENCE_NAME'
   $p='C:\ProgramData\CluedCacheInstallSelf211\Outputs\'+$script:plan.row.node_id
   NoReparse $p;$acl=Get-Acl -LiteralPath $p;$wanted=[Security.AccessControl.DirectorySecurity]::new();$wanted.SetSecurityDescriptorSddlForm(('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;'+$script:plan.row.expected_sid+')'))
   InstallRequire211 ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544' -and $acl.AreAccessRulesProtected -and $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ceq $wanted.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)) 'INSTALL_ORIGINAL_OUTPUT_BOUNDARY'
   JsonNew (Join-Path $p $name) $value
  }
  function InvokeOwnedInstallOnce215($plan,$selector){
   if($script:spent){throw 'INSTALL_ONCE_NO_RETRY'};$script:spent=$true;$r=InstallPlan211 $plan;$script:plan=$plan
   InstallRequire211 ($selector -is [pscustomobject] -and (InstallSame211 $selector.attempt_id $plan.attempt_id) -and (InstallSame211 $selector.packet_sha256 $plan.actor_packet_sha256) -and (InstallSame211 $selector.owner_receipt_id $plan.owner_receipt_id) -and (InstallSame211 $selector.source_acceptance_ref $plan.source_acceptance_ref)) 'INSTALL_DISTINCT_OWNER_SELECTOR'
   # This is a DIRECT kernel-authenticated Root peer, not a Node-provided
   # callback/verdict. Derived name is only a locator, never another attempt.
   $attempt=(BytesHash ([Text.Encoding]::UTF8.GetBytes('clued.install-self215/'+$plan.attempt_id))).Substring(0,32)
   $script:pipe=[CluedNodeAuthority212.IngressPipe]::ConnectForAcceptedAttempt($attempt,$selector.root_pid,[long]::Parse($selector.root_start),$selector.root_sid)
   try{
    $peer=$script:pipe.ObserveAuthenticatedPeer();InstallRequire211 ($peer.Pid -eq $selector.root_pid -and $peer.CreationFileTime.ToString() -ceq $selector.root_start -and $peer.Sid -ceq $selector.root_sid -and $peer.Elevated -eq 1) 'INSTALL_REAL_ROOT_PEER'
    $authority={param($phase,$received)InstallRequire211 (InstallSame211 $received.actor_packet_sha256 $script:plan.actor_packet_sha256) 'INSTALL_CAPTURED_PLAN';return InstallDirectRoot215 'Current' $phase $null}
    $observer={param($phase,$received,$fixed)InstallRequire211 (InstallSame211 $received.actor_packet_sha256 $script:plan.actor_packet_sha256) 'INSTALL_CAPTURED_PLAN';return InstallDirectRoot215 'ObserverPhase' $phase $fixed}
    $enrollment=NewCapturedSelfEnrollment211 $script:source.enrollment_code
    $journal={param($phase,$value)InstallRequire211 ($phase -ceq 'intent') 'INSTALL_FIXED_JOURNAL';InstallEvidenceNew215 'self-install215.intent.json' $value}
    $write={param($name,$value)InstallEvidenceNew215 $name $value}
    # Actual local COM is created in this target's own primary context only.
    $ops=NewSelfMaintenanceSchedulerFacade211 $plan $enrollment.enroll $enrollment.verify_enrollment $journal $write
    return InvokeSelfMaintenanceInstallCore211 $plan $ops $authority $observer
   }finally{if($script:pipe){$script:pipe.Dispose()}}
  }
  Export-ModuleMember -Function @()
 } -ArgumentList (,$held)
 $self=[CluedQualification181.HeldProcess]::new($PID);$node=$null
 try{
  $s=$self.Observe();$node=[CluedQualification181.HeldProcess]::new($s.ParentPid);$n=$node.Observe();I215Need ($s.ParentPid -eq $n.Pid -and $s.Sid -ceq $n.Sid -and $s.Elevated -eq 0 -and $n.Elevated -eq 0 -and [IO.Path]::GetFileName($n.Image) -ieq 'node.exe') 'INSTALL_ACTUAL_NODE_SELF_CHAIN'
  [Console]::Out.WriteLine((@{schema='clued.node-install-self-captured215/1';host=[Environment]::MachineName;ps_pid=$s.Pid;ps_start=[string]$s.CreationFileTime;ps_parent_pid=$s.ParentPid;ps_sid=$s.Sid;ps_elevated=$s.Elevated;node_pid=$n.Pid;node_start=[string]$n.CreationFileTime;node_sid=$n.Sid;node_elevated=$n.Elevated;node_image=$n.Image;source_captured=$true;authority_granted=$false}|ConvertTo-Json -Compress));[Console]::Out.Flush()
  $next=$reader.ReadLineAsync();I215Need ($next.Wait(120000)) 'INSTALL_START_TIMEOUT';$text=$next.Result;I215Need ($text -is [string] -and $text.Length -le 8192) 'INSTALL_START_BOUND'
  $start=$text|ConvertFrom-Json;I215Keys $start @('schema','plan','selector');I215Need ($start.schema -is [string] -and $start.schema -ceq 'clued.node-install-start215/1') 'INSTALL_START_SCHEMA'
  $result=& $module {param($p,$s)InvokeOwnedInstallOnce215 $p $s} $start.plan $start.selector
  [Console]::Out.WriteLine((@{schema='clued.node-install-self-result215/1';result=$result}|ConvertTo-Json -Compress -Depth 10));[Console]::Out.Flush()
 }finally{if($node){$node.Dispose()};$self.Dispose()}
}
if($MyInvocation.InvocationName -ne '.') {throw 'CAPTURED_INSTALLATION_SOURCE_ONLY_NO_CLI'}
