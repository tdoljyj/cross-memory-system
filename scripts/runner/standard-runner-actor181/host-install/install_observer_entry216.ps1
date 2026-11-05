# Fixed captured installation OBSERVER loader. Not a CLI launcher.
function IL216Need($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function InvokeCapturedInstallObserver216 {
 $reader=$script:OwnedInstallReader216;IL216Need ($reader -is [IO.StreamReader]) 'INSTALL_ACTUAL_INHERITED_READER'
 $line=$reader.ReadLine();IL216Need ($line -is [string] -and [Text.Encoding]::UTF8.GetByteCount($line) -le 2097152) 'INSTALL_FIXED_CAPTURE_BOUND'
 $payload=$line|ConvertFrom-Json;IL216Need ($payload -is [pscustomobject] -and (($payload.PSObject.Properties.Name|Sort-Object)-join '|') -ceq 'captures|initial|schema' -and $payload.schema -ceq 'clued.root-install-capture216/1') 'INSTALL_FIXED_CAPTURE_SHAPE'
 $pins=@{'namespace'='88a8388c9d3f5c0a814549de0cd4cb8ba7820860fab05f674bbc04b0f30dd4b9';'actor'='0401d559c495469f213ef4eaf00b8590c9eea91bba0dc3c58e2983b483e9c3e4';'enrollment_adapter'='69cccbbf0899c82ac09f35e163cc782cb2edab385be05e984cf9b14e00956627';'enrollment_code'='9395b92c4724e498f02f9a138f76a1cb60cb5b6deba351725a1baee5579f7a79';'xml'='aa5dfe432ce9d6c0f6a1b867c1950b5036ec431056dc30560a1d230a74e6efb5';'self_helpers'='c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616';'definition'='0f8e12a1da7db668fc64b4ab10dde042f06ec26186a93833a446d284dec890a4';'registration'='642cd65994270271ab12f88c81bfc5653852ae2fd1ad831e827ac016679e4fcb';'qual_helpers'='2eced12090f96460c5699f247d171bd3e16a69e908c9debd6986cd36af3dc509';'qual_receiver'='4ea513a4a99a5aca4dac62670e37ed4237acbabd776d891be03bb906f5c856a0';'observer'='142b564e2fd411e7f68d82b2b6ca4b16ef261c5d795324d296b8b6535a35895e';'identity'='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';'ingress'='abfd6fae020b3f0cb31e43cd3802ec98cb089472f70579310dc99ce42e3048cb';'node_ingress'='4b71c2422904315f861a41a63373b04dc9bfcc848d5b35e22ea655d39fc045c7';'observer_runtime'='e6a4cc9d6c0cf907cf1cd009bb6685b0c1bcf8d067bf28bc069d737328e80f73'};IL216Need ((($payload.captures.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($pins.Keys|Sort-Object)-join '|')) 'INSTALL_FIXED_CAPTURE_MEMBERS'
 $held=@{};foreach($k in $pins.Keys){$v=$payload.captures.$k;IL216Need ($v -is [string] -and $v.Length -le 1398104) 'INSTALL_CAPTURE_BASE64_BOUND';$raw=[Convert]::FromBase64String($v);$h=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};IL216Need ($raw.Length -gt 0 -and $raw.Length -le 1048576 -and $actual -ceq $pins[$k] -and [Convert]::ToBase64String($raw) -ceq $v) 'INSTALL_CAPTURE_EXACT_SOURCE_PIN';$held[$k]=[byte[]]$raw.Clone()}
 foreach($a in [AppDomain]::CurrentDomain.GetAssemblies()){foreach($t in @('CluedQualification181.HeldProcess','CluedNodeAuthority212.IngressPipe')){IL216Need ($null -eq $a.GetType($t,$false)) 'INSTALL_FRESH_NATIVE_NAMESPACE'}}
 $identity=[Reflection.Assembly]::Load($held.identity);$ingress=[Reflection.Assembly]::Load($held.ingress);;IL216Need ([CluedQualification181.HeldProcess].Assembly -eq $identity -and [CluedNodeAuthority212.IngressPipe].Assembly -eq $ingress) 'INSTALL_NATIVE_TYPES_FROM_CAPTURE'
 $own=[CluedQualification181.HeldProcess]::new($PID)
 try{$s=$own.Observe();IL216Need ($s.Elevated -eq 1 -and $s.Sid -cne 'S-1-5-18') 'INSTALL_ACTUAL_ELEVATED_CAPTURED_ROLE'
  $module=New-Module {
   param($held,$reader,$initial)
   foreach($k in @('namespace','self_helpers','definition','registration','xml','actor','enrollment_adapter','qual_helpers','qual_receiver','observer','node_ingress')){. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($held[$k])))}
   . ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($held.observer_runtime)))
   $script:InstallBootstrapBytes216=1274;$script:InstallBootstrapSha216='5f1053eb8f0880a5417bb204a5b70532ec90c85b4dcd018fe2a1b0010dfb9dbd'
   $script:PrivateInitial216=$initial;$script:PrivateReader216=$reader;$script:CapturedEnrollment216=[byte[]]$held.enrollment_code.Clone();Export-ModuleMember -Function @()
  } -ArgumentList $held,$reader,$payload.initial
  $value=@{schema='clued.root-owned-ba-capture-ready181/1';host=[Environment]::MachineName;ba_pid=$s.Pid;ba_start=$s.CreationFileTime.ToString();ba_sid=$s.Sid;ba_elevated=$s.Elevated;parent_pid=$s.ParentPid;authority_granted=$false}
  $value.source_capture_sha256=$payload.initial.binding.observer_capture_sha256
  [Console]::Out.WriteLine(($value|ConvertTo-Json -Compress));[Console]::Out.Flush()
  & $module {InvokeInstallObserver216 $script:PrivateInitial216 $script:CapturedEnrollment216 $script:PrivateReader216}
 }finally{$own.Dispose()}
}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_INSTALL_ROLE_ONLY_NO_CLI'}
