# Captured by the protected CI Source, invoked only inside its owned PS child.
# Original entry-r2 bytes remain unchanged. Public execution defaults to preview.
function WrapperRequire($ok,[string]$code){if($ok -isnot [bool] -or -not $ok){throw $code}}
function WrapperHash([byte[]]$raw){$s=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($s.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function WrapperPins181 {return [ordered]@{
 runner_entry='aae77e546853bbb3c87b9d21a4b96537779d4860f48ef09d256fc9982ab56bd8'
 actor='c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616'
 identity='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8'
 definition='0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4'
 registration='642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb'
 observer_os='c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a'
 local_pipe='0fc2bc75b9ff8696e60d8999dc5867ec1dffbacd66479c60f781e0629cef6932'
 provider_client='5b53a5861e7708594c5c37343ea001c0d838cfdb8b0a15ff9008e35e2f236f3a'
}}
function NewCapturedPipeRunner181($candidate,$binding){
 $pins=WrapperPins181;WrapperRequire ($candidate -is [Collections.IDictionary] -and (($candidate.Keys|Sort-Object)-join '|') -ceq (($pins.Keys|Sort-Object)-join '|')) 'WRAPPER_EXACT_MEMBERS'
 $private=@{};$asts=@{}
 # Every byte is cloned, hashed and script-parsed before first loading/evaluation.
 foreach($key in $pins.Keys){WrapperRequire ($candidate[$key] -is [byte[]] -and $candidate[$key].Length -gt 0 -and $candidate[$key].Length -le 1048576) 'WRAPPER_SOURCE_BOUND';$private[$key]=[byte[]]$candidate[$key].Clone();WrapperRequire ((WrapperHash $private[$key]) -ceq $pins[$key]) 'WRAPPER_CAPTURE_SHA'
  if($key -cnotin @('identity','local_pipe')){$errors=$null;$tokens=$null;$asts[$key]=[Management.Automation.Language.Parser]::ParseInput([Text.UTF8Encoding]::new($false,$true).GetString($private[$key]),[ref]$tokens,[ref]$errors);WrapperRequire ($errors.Count -eq 0) 'WRAPPER_CAPTURE_PARSE'}
 }
 $driver=New-Module {param($source) . ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($source)));Export-ModuleMember -Function @()} -ArgumentList (,$private.runner_entry)
 $four=@{};foreach($k in @('actor','identity','definition','registration')){$four[$k]=$private[$k]}
 $loaded=& $driver {param($s)NewBoundSelfRegistrationModule $s} $four
 foreach($assembly in [AppDomain]::CurrentDomain.GetAssemblies()){WrapperRequire ($null -eq $assembly.GetType('CluedLocalTransport181.LocalPipe',$false)) 'WRAPPER_PREEXISTING_PIPE_TYPE_REFUSED'}
 $pipeAssembly=[Reflection.Assembly]::Load($private.local_pipe);WrapperRequire ([CluedLocalTransport181.LocalPipe].Assembly -eq $pipeAssembly) 'WRAPPER_PIPE_TYPE_COLLISION'
 $parserDecls=@($asts.observer_os.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -cin @('ObsRequire','ObsStrictEvidenceJson')})
 WrapperRequire ($parserDecls.Count -eq 2) 'WRAPPER_ORIGINAL_STRICT_PARSER_MEMBERS'
 $parserSource=($parserDecls|ForEach-Object {$_.Extent.Text}) -join "`n"
 $parserModule=New-Module {param($s). ([scriptblock]::Create($s));Export-ModuleMember -Function @();return $ExecutionContext.SessionState.Module} -ArgumentList $parserSource
 $parser=& $parserModule {(Get-Item Function:ObsStrictEvidenceJson).ScriptBlock}
 $clientModule=New-Module {param($s). ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($s)));Export-ModuleMember -Function @()} -ArgumentList (,$private.provider_client)
 $copy=$null;if($null -ne $binding){$copy=$binding|ConvertTo-Json -Compress -Depth 8|ConvertFrom-Json}
 # This owner module never exports its state or a parameterized authority resolver.
 $owner=New-Module {
  param($ownedDriver,$ownedLoaded,$ownedParser,$ownedClient,$bound)
  $script:driver=$ownedDriver;$script:loaded=$ownedLoaded;$script:parser=$ownedParser;$script:client=$ownedClient;$script:binding=$bound;$script:spent=$false
  function BindOwnedRunnerBootstrapOnce181($value){
   if($null -ne $script:binding -or $script:spent -or $value -isnot [pscustomobject]){throw 'WRAPPER_BOOTSTRAP_BIND_ONCE'}
   $script:binding=$value|ConvertTo-Json -Compress -Depth 8|ConvertFrom-Json
  }
  function ResolveOwnedPipeProvider181 {
   $b=$script:binding
   if($b -isnot [pscustomobject] -or ((@($b.PSObject.Properties.Name)|Sort-Object)-join '|') -cne ((@('attempt_id','node_pid','node_start','node_image','relay_pid','relay_start','relay_sid')|Sort-Object)-join '|')){throw 'WRAPPER_CLOSED_NODE_OWNED_BOOTSTRAP'}
   foreach($name in @('attempt_id','node_start','node_image','relay_start','relay_sid')){if($b.$name -isnot [string]){throw 'WRAPPER_BOOTSTRAP_STRING'}}
   if($b.attempt_id -cnotmatch '^[0-9a-f]{32}$' -or $b.node_start -cnotmatch '^[1-9][0-9]{0,18}$' -or $b.relay_start -cnotmatch '^[1-9][0-9]{0,18}$' -or $b.relay_sid -cnotmatch '^S-1-5-21-[0-9-]{1,150}$' -or [IO.Path]::GetFileName($b.node_image) -ine 'node.exe' -or $b.node_pid -isnot [int] -or $b.node_pid -le 0 -or $b.relay_pid -isnot [int] -or $b.relay_pid -le 0){throw 'WRAPPER_BOOTSTRAP_REFERENCE'}
   $self=[CluedQualification181.HeldProcess]::new($PID);$node=[CluedQualification181.HeldProcess]::new($b.node_pid)
   try{$s=$self.Observe();$n=$node.Observe();if($s.ParentPid -ne $n.Pid -or $n.CreationFileTime.ToString([Globalization.CultureInfo]::InvariantCulture) -cne $b.node_start -or $s.Sid -cne $n.Sid -or $n.Elevated -ne 0 -or $n.Image -ine $b.node_image){throw 'WRAPPER_ACTUAL_NODE_PARENT_CHAIN'}}finally{$self.Dispose();$node.Dispose()}
   $pipe=[CluedLocalTransport181.LocalPipe]::ConnectForAcceptedAttempt($b.attempt_id,$b.relay_pid,[long]::Parse($b.relay_start,[Globalization.CultureInfo]::InvariantCulture),$b.relay_sid)
   try{return @{provider=(& $script:client {param($p,$strict)NewLocalPipeRunnerProvider181 $p $strict} $pipe $script:parser);pipe=$pipe}}catch{$pipe.Dispose();throw}
  }
  function InvokeOwnedPipeRunnerOnce181 {
   if($script:spent){throw 'WRAPPER_SINGLE_INVOCATION'};$script:spent=$true
   $resolved=ResolveOwnedPipeProvider181
   try{
    # Exact r2 driver factories/core/wrappers, all in the captured owning module.
    return (& $script:driver {param($l,$p)$ops=NewRealRunnerEntryOperations $l $p;InvokeRunnerEntryCore $ops} $script:loaded $resolved.provider)
   }finally{$resolved.pipe.Dispose()}
  }
  Export-ModuleMember -Function @()
 } -ArgumentList $driver,$loaded,$parser,$clientModule,$copy
 return $owner
}
function InvokeRunnerPipeStdio181 {
 # Called by the exact protected Node spawn adapter, not by the preview entry.
 $line=$script:OwnedRunnerStdin181.ReadLine();WrapperRequire ($line -is [string] -and [Text.Encoding]::UTF8.GetByteCount($line) -le 2097152) 'WRAPPER_CAPTURE_PAYLOAD_BOUND'
 $payload=$line|ConvertFrom-Json
 WrapperRequire ($payload -is [pscustomobject] -and ((@($payload.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq 'captures|schema' -and $payload.schema -is [string] -and $payload.schema -ceq 'clued.node-owned-runner-capture181/1' -and $payload.captures -is [pscustomobject]) 'WRAPPER_CAPTURE_PAYLOAD'
 $caps=@{};foreach($property in $payload.captures.PSObject.Properties){WrapperRequire ($property.Value -is [string] -and $property.Value.Length -le 1398104) 'WRAPPER_BASE64_TYPE_OR_BOUND';$bytes=[Convert]::FromBase64String($property.Value);WrapperRequire ([Convert]::ToBase64String($bytes) -ceq $property.Value) 'WRAPPER_CANONICAL_BASE64';$caps[$property.Name]=$bytes}
 $owner=NewCapturedPipeRunner181 $caps $null
 $own=[CluedQualification181.HeldProcess]::new($PID);$node=$null
 try{
  $s=$own.Observe();$node=[CluedQualification181.HeldProcess]::new($s.ParentPid);$n=$node.Observe()
  $metadata=@{schema='clued.node-owned-ps-capture-ready181/1';host=[Environment]::MachineName;ps_pid=$s.Pid;ps_start=$s.CreationFileTime.ToString([Globalization.CultureInfo]::InvariantCulture);ps_parent_pid=$s.ParentPid;ps_sid=$s.Sid;ps_elevated=$s.Elevated;node_pid=$n.Pid;node_start=$n.CreationFileTime.ToString([Globalization.CultureInfo]::InvariantCulture);node_sid=$n.Sid;node_elevated=$n.Elevated;node_image=$n.Image;source_captured=$true;authority_granted=$false;runner_name=[Environment]::GetEnvironmentVariable('RUNNER_NAME','Process')}
  [Console]::Out.WriteLine(($metadata|ConvertTo-Json -Compress));[Console]::Out.Flush()
  # Scheduling only; the authenticated pipe's real authority service remains
  # mandatory before the original actor reaches either Register or Run.
  $startRead=$script:OwnedRunnerStdin181.ReadLineAsync();WrapperRequire ($startRead.Wait(120000)) 'WRAPPER_START_TIMEOUT';$startLine=$startRead.Result;WrapperRequire ($startLine -is [string] -and [Text.Encoding]::UTF8.GetByteCount($startLine) -le 8192) 'WRAPPER_START_BOUND'
  $start=$startLine|ConvertFrom-Json;WrapperRequire ($start -is [pscustomobject] -and ((@($start.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq 'binding|schema' -and $start.schema -is [string] -and $start.schema -ceq 'clued.node-owned-runner-start181/1') 'WRAPPER_START_SCHEMA'
  & $owner {param($b)BindOwnedRunnerBootstrapOnce181 $b} $start.binding
  return (& $owner {InvokeOwnedPipeRunnerOnce181})
 }finally{if($node){$node.Dispose()};$own.Dispose()}
}
if($MyInvocation.InvocationName -ne '.'){@{schema='clued.runner-pipe-wrapper-preview181/1';status='PREVIEW_PROTECTED_CI_CAPTURE_AND_OWNED_NODE_SPAWN_REQUIRED';physical_owner_packet=$null;task_operations=0;uac=$false}|ConvertTo-Json -Compress}
