# Captured elevated RELAY loader. Private function only, no production CLI.
function R214Require($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function InvokeCapturedRelay214 {
 $reader=$script:OwnedRelayReader214;R214Require ($reader -is [IO.StreamReader]) 'ACTUAL_INHERITED_ROOT_READER'
 $line=$reader.ReadLine();R214Require ($line -is [string] -and [Text.Encoding]::UTF8.GetByteCount($line) -le 2097152) 'RELAY_PAYLOAD_BOUND';$payload=$line|ConvertFrom-Json
 R214Require ($payload -is [pscustomobject] -and (($payload.PSObject.Properties.Name|Sort-Object)-join '|') -ceq 'captures|initial|schema' -and $payload.schema -is [string] -and $payload.schema -ceq 'clued.root-owned-relay-capture214/1' -and $payload.captures -is [pscustomobject] -and $payload.initial.owner_packet -is [pscustomobject]) 'CAPTURED_RELAY_PAYLOAD_REQUIRED'
 $pins=@{'actor'='c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616';'server'='a605e93536b31d5018f17e991e38c11f9dccd95f982eb61ade15ae5394f35aa3';'observer_os'='c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a';'identity'='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';'local_pipe'='579063ff78159c37f36cd2af12b4802e6c5da38b7138f24ef7c97d66377b7d8f';'node_native'='abfd6fae020b3f0cb31e43cd3802ec98cb089472f70579310dc99ce42e3048cb';'node_ingress'='4b71c2422904315f861a41a63373b04dc9bfcc848d5b35e22ea655d39fc045c7';'async_shim'='deec8b4985ba67084bb0d11b56b1cfe1059340bf77775d042a86126c9721dab0';'effects'='5f14a330ff00e1701db0d0f37507d08370cd9a28f2e40cadba4319011334a81c';'mux'='454c10a1caf4ca133084f7c8a86e742da62437df97f0cce26507f66a62a9b9a2';'publisher'='6dfe7e7d05e8a2d9a26bafb0237b14c55535bbc58882b0a4176ea6af2a4c59c2';'publisher_native'='3eb5a5e9daeba5b9351da5b1922240ef695a694772342625d125a73d2ef40a01'}
 R214Require ((($payload.captures.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($pins.Keys|Sort-Object)-join '|')) 'EXACT_CAPTURED_RELAY_MEMBERS'
 $held=@{};foreach($k in $pins.Keys){$s=$payload.captures.$k;R214Require ($s -is [string] -and $s.Length -le 1398104) 'RELAY_CAPTURE_BASE64_BOUND';$b=[Convert]::FromBase64String($s);$h=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($h.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};R214Require ($b.Length -gt 0 -and $b.Length -le 1048576 -and $actual -ceq $pins[$k] -and [Convert]::ToBase64String($b) -ceq $s) 'RELAY_CAPTURE_RAW_PIN';$held[$k]=[byte[]]$b.Clone()}
 foreach($asm in [AppDomain]::CurrentDomain.GetAssemblies()){foreach($type in @('CluedQualification181.HeldProcess','CluedLocalTransport181.LocalPipe','CluedNodeAuthority212.IngressPipe','CluedOriginalPipeTask214.Shim','CluedSelectorPublisher216.Publisher')){R214Require ($null -eq $asm.GetType($type,$false)) 'RELAY_ASSEMBLY_COLLISION'}}
 $identity=[Reflection.Assembly]::Load($held.identity);$local=[Reflection.Assembly]::Load($held.local_pipe);$node=[Reflection.Assembly]::Load($held.node_native);$shim=[Reflection.Assembly]::Load($held.async_shim);$publisher=[Reflection.Assembly]::Load($held.publisher_native)
 R214Require ([CluedQualification181.HeldProcess].Assembly -eq $identity -and [CluedLocalTransport181.LocalPipe].Assembly -eq $local -and [CluedNodeAuthority212.IngressPipe].Assembly -eq $node -and [CluedOriginalPipeTask214.Shim].Assembly -eq $shim -and [CluedSelectorPublisher216.Publisher].Assembly -eq $publisher -and [CluedOriginalPipeTask214.Shim].GetMethod('Accept').GetParameters()[0].ParameterType.Assembly -eq $local) 'RELAY_ASSEMBLY_IDENTITY'
 $owner=New-Module {
  param($bytes,$originalReader,$initial)
  $script:PrivateRelayInitial214=$initial;$script:PrivateRootReader214=$originalReader
  foreach($name in @('actor','server','observer_os','node_ingress','effects','publisher','mux')){$null=. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($bytes[$name])))}
  Export-ModuleMember -Function @()
 } -ArgumentList $held,$reader,$payload.initial
 $own=[CluedQualification181.HeldProcess]::new($PID)
 try{$s=$own.Observe();R214Require ($s.Elevated -eq 1 -and $s.Sid -cne 'S-1-5-18') 'ACTUAL_ELEVATED_OWNED_RELAY';[Console]::Out.WriteLine((@{schema='clued.root-owned-relay-capture-ready181/1';host=[Environment]::MachineName;relay_pid=$s.Pid;relay_start=$s.CreationFileTime.ToString();relay_sid=$s.Sid;relay_elevated=$s.Elevated;parent_pid=$s.ParentPid;authority_granted=$false}|ConvertTo-Json -Compress));[Console]::Out.Flush()
  & $owner {InvokeRelayIngressMux214 $script:PrivateRelayInitial214 (Get-Item Function:ObsStrictEvidenceJson).ScriptBlock $script:PrivateRootReader214}
 }finally{$own.Dispose()}
}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_ROOT_RELAY_ONLY_NO_CLI'}
