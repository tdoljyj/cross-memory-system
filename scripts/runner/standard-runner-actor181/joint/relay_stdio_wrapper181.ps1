function RSRequire($value,[string]$code){if($value -isnot [bool] -or -not $value){throw $code}}
function RSHash([byte[]]$raw){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function RSPins {return [ordered]@{server='a605e93536b31d5018f17e991e38c11f9dccd95f982eb61ade15ae5394f35aa3';actor='c82a699dbbf5bfd44939fcdc1c5a211ed66d3571a8baa522fb955ab1d3859616';identity='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';local_pipe='579063ff78159c37f36cd2af12b4802e6c5da38b7138f24ef7c97d66377b7d8f';observer_os='c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a'}}
function InvokeCapturedRelayStdio181 {
 $reader=$script:OwnedRelayStdin181;$line=$reader.ReadLine();RSRequire ($line -is [string] -and [Text.Encoding]::UTF8.GetByteCount($line) -le 2097152) 'RELAY_CAPTURE_PAYLOAD_BOUND';$value=$line|ConvertFrom-Json
 RSRequire ($value -is [pscustomobject] -and ((@($value.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq 'captures|schema' -and $value.schema -is [string] -and $value.schema -ceq 'clued.root-owned-relay-capture181/1' -and $value.captures -is [pscustomobject]) 'RELAY_CAPTURE_CLOSED'
 $pins=RSPins;RSRequire (((@($value.captures.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq (($pins.Keys|Sort-Object)-join '|')) 'RELAY_CAPTURE_MEMBERS'
 $bytes=@{};$asts=@{};foreach($name in $pins.Keys){$text=$value.captures.$name;RSRequire ($text -is [string] -and $text.Length -le 1398104) 'RELAY_SOURCE_BOUND';$raw=[Convert]::FromBase64String($text);RSRequire ([Convert]::ToBase64String($raw) -ceq $text -and $raw.Length -gt 0 -and $raw.Length -le 1048576 -and (RSHash $raw) -ceq $pins[$name]) 'RELAY_RAW_PIN';$bytes[$name]=[byte[]]$raw.Clone()
  if($name -cnotin @('identity','local_pipe')){$errors=$null;$tokens=$null;$asts[$name]=[Management.Automation.Language.Parser]::ParseInput([Text.UTF8Encoding]::new($false,$true).GetString($bytes[$name]),[ref]$tokens,[ref]$errors);RSRequire ($errors.Count -eq 0) 'RELAY_SOURCE_PARSE'}
 }
 foreach($assembly in [AppDomain]::CurrentDomain.GetAssemblies()){RSRequire ($null -eq $assembly.GetType('CluedQualification181.HeldProcess',$false) -and $null -eq $assembly.GetType('CluedLocalTransport181.LocalPipe',$false)) 'RELAY_PREEXISTING_TYPES_REFUSED'}
 $identityAssembly=[Reflection.Assembly]::Load($bytes.identity);$pipeAssembly=[Reflection.Assembly]::Load($bytes.local_pipe);RSRequire ([CluedQualification181.HeldProcess].Assembly -eq $identityAssembly -and [CluedLocalTransport181.LocalPipe].Assembly -eq $pipeAssembly) 'RELAY_ASSEMBLY_COLLISION'
 $declarations=@();foreach($f in $asts.observer_os.EndBlock.Statements){if($f -is [Management.Automation.Language.FunctionDefinitionAst] -and $f.Name -cin @('ObsRequire','ObsStrictEvidenceJson')){$declarations+=@($f.Extent.Text)}};RSRequire ($declarations.Count -eq 2) 'RELAY_STRICT_PARSER'
 $owner=New-Module {param($actor,$server,$strict)
  . ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($actor)))
  . ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($server)))
  . ([scriptblock]::Create($strict));Export-ModuleMember -Function @()
 } -ArgumentList $bytes.actor,$bytes.server,($declarations -join "`n")
 $held=[CluedQualification181.HeldProcess]::new($PID)
 try{
  $s=$held.Observe();[Console]::Out.WriteLine((@{schema='clued.root-owned-relay-capture-ready181/1';host=[Environment]::MachineName;relay_pid=$s.Pid;relay_start=$s.CreationFileTime.ToString([Globalization.CultureInfo]::InvariantCulture);relay_sid=$s.Sid;relay_elevated=$s.Elevated;parent_pid=$s.ParentPid;authority_granted=$false}|ConvertTo-Json -Compress));[Console]::Out.Flush()
  $startRead=$reader.ReadLineAsync();RSRequire ($startRead.Wait(120000)) 'RELAY_BIND_TIMEOUT';$startLine=$startRead.Result;RSRequire ($startLine -is [string] -and [Text.Encoding]::UTF8.GetByteCount($startLine) -le 16384) 'RELAY_BIND_BOUND'
  $start=& $owner {param($raw)ObsStrictEvidenceJson $raw} $startLine
  & $owner {param($v)RelayKeys $v @('schema','binding');RelayString $v.schema 'clued.root-owned-relay-bind181/1'} $start
  # Pass the original shared reader. Reopening Console.In would lose buffered
  # START/authority lines and Console.SyncTextReader does not give async waits.
  & $owner {param($binding,$rootReader)
   InvokeRootBoundAuthorityServer181 $binding (Get-Item Function:ObsStrictEvidenceJson).ScriptBlock $rootReader
  } $start.binding $reader
 }finally{$held.Dispose()}
}
if($MyInvocation.InvocationName -ne '.'){@{schema='clued.relay-stdio-wrapper-preview181/1';status='PREVIEW_CAPTURED_PARENT_AND_ROOT_CHANNEL_REQUIRED';physical_owner_packet=$null;task_operations=0;uac=$false}|ConvertTo-Json -Compress}
