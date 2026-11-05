# Captured elevated parent library. Direct CLI refuses; no UAC invocation here.
function InvokeCapturedUac181Parent($d){
 $ErrorActionPreference='Stop'
 if($d -isnot [pscustomobject]){throw 'PARENT_BOOTSTRAP_DATA_OBJECT'}
 if((($d.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'package_path|package_sha256|pipe_nonce|root_pid|root_sid|root_start|session'){throw 'PARENT_BOOTSTRAP_DATA_FIELDS'}
 foreach($name in @('package_path','package_sha256','pipe_nonce','root_sid','root_start','session')){if($d.$name -isnot [string]){throw 'PARENT_BOOTSTRAP_RAW_PRIMITIVE'}}
 if($d.root_pid -isnot [int] -or $d.root_pid -le 0 -or $d.root_start -cnotmatch '\A[1-9][0-9]{0,18}\z' -or $d.package_sha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $d.pipe_nonce -cnotmatch '\A[a-f0-9]{32}\z' -or $d.session -cnotmatch '\A[a-f0-9]{32}\z' -or $d.package_path -cnotmatch '^[A-Za-z]:[\\/]'){throw 'PARENT_BOOTSTRAP_DATA_DOMAIN'}
 # The outer small EncodedCommand hashed these script bytes before evaluation.
 # Its package hash is independently captured in the accepted Root packet.
 $raw=[IO.File]::ReadAllBytes($d.package_path);if($raw.Length -gt 8388608){throw 'PARENT_PACKAGE_BOUND'}
 $sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($hash -cne $d.package_sha256){throw 'PARENT_PACKAGE_HASH'}
 $pack=[Text.UTF8Encoding]::new($false,$true).GetString($raw)|ConvertFrom-Json
 if($pack -isnot [pscustomobject] -or $pack.schema -isnot [string] -or $pack.packet_sha256 -isnot [string] -or $pack.packet_sha256 -cnotmatch '\A[a-f0-9]{64}\z' -or $pack.target_sid -isnot [string]){throw 'PARENT_PACKAGE_RAW_PRIMITIVES'}
 if($pack.schema -cne 'clued.root-uac-captured-package181/1' -or (($pack.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'members|packet_sha256|pair|schema|target_sid' -or (($pack.members.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'child_factory|control|identity|supervisor'){throw 'PARENT_PACKAGE_SCHEMA'}
 # Capture every member and verify before the first assembly/script execution.
 $members=@{};foreach($name in @('control','identity','child_factory','supervisor')){$m=$pack.members.$name;if((($m.PSObject.Properties.Name|Sort-Object)-join '|') -cne 'base64|sha256'){throw 'PARENT_MEMBER_FIELDS'};$b=[Convert]::FromBase64String($m.base64);if($b.Length -gt 2097152){throw 'PARENT_MEMBER_BOUND'};$sha=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($sha.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($h -cne $m.sha256){throw 'PARENT_MEMBER_HASH'};$members[$name]=$b}
 if($pack.members.identity.sha256 -cne '31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8'){throw 'ORIGINAL_IDENTITY_PIN'}
 [void][Reflection.Assembly]::Load($members.identity);[void][Reflection.Assembly]::Load($members.control);[void][Reflection.Assembly]::Load($members.child_factory)
 . ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($members.supervisor)))
 $own=Uac181Own;Uac181Require ($own.Sid -ceq $d.root_sid -and $own.Elevated -eq 1) 'SAME_SID_ELEVATED_PARENT_REQUIRED'
 $fixed=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';Uac181Require ($own.Image -ieq $fixed) 'PARENT_EXACT_IMAGE'
 $pipe=[CluedRootUacControl181.ControlPipe]::Connect($d.pipe_nonce,$d.root_sid);$pair=$null
 try{
  $null=Uac181Peer $pipe ([int]$d.root_pid) ([long]$d.root_start) $d.root_sid $fixed 0;$wire=NewUac181Wire $pipe $d.session
  WriteUac181 $wire 'PARENT' 'HELLO' ([pscustomobject]@{pid=$own.Pid;start=[string]$own.CreationFileTime;sid=$own.Sid;elevated=$own.Elevated;image=$own.Image;packet_sha256=$pack.packet_sha256})
  $start=ReadUac181 $wire 120000;Uac181Require ($start.role -ceq 'PARENT' -and $start.kind -ceq 'START') 'PARENT_START_REQUIRED';Uac181Keys $start.body @('packet_sha256');Uac181Require ((Uac181ExactString $start.body.packet_sha256 $pack.packet_sha256)) 'PARENT_START_PACKET'
  # The only factory creates both exact owned children. No incoming command,
  # executable, token or provider can select another factory or process.
  $x=$pack.pair
  $pair=[CluedNewChildReadAccess181.NewChildReadAccess]::SpawnPair($x.observer_encoded,$x.observer_sha256,$x.relay_encoded,$x.relay_sha256,$own.Sid,$pack.target_sid)
  $plan=$pair.OpenVerifiedOwnedChildren()
  WriteUac181 $wire 'PARENT' 'AUTH_REQUEST' ([pscustomobject]@{operation='NEW_CHILD_READ_ACCESS';packet_sha256=$pack.packet_sha256;plan=$plan})
  $answer=ReadUac181 $wire 20000;Uac181Require ($answer.role -ceq 'PARENT' -and $answer.kind -ceq 'AUTH_RESPONSE') 'ROOT_CHILD_ACCESS_REPLY';Uac181Authorization $answer.body $pack.packet_sha256
  # Approval is from the authenticated ordinary Root pipe peer, never a child.
  # ApplyOnce callback is rechecked for each write by the factory.
  $verify={param($actualPlan)WriteUac181 $wire 'PARENT' 'AUTH_REQUEST' ([pscustomobject]@{operation='NEW_CHILD_READ_ACCESS_WRITE';packet_sha256=$pack.packet_sha256;plan=$actualPlan});$r=ReadUac181 $wire 20000;Uac181Require ($r.role -ceq 'PARENT' -and $r.kind -ceq 'AUTH_RESPONSE') 'ROOT_CHILD_ACCESS_WRITE_REFUSED';Uac181Authorization $r.body $pack.packet_sha256}.GetNewClosure()
  $helpers=@{};foreach($name in @('WriteUac181','ReadUac181','Uac181Json','Uac181Keys','Uac181Require','Uac181Authorization','Uac181ExactString','Uac181Packet')){$helpers[$name]=(Get-Item ('Function:\'+$name)).ScriptBlock}
  & $verify.Module {param($functions)foreach($name in $functions.Keys){Set-Item -Path ('Function:script:'+$name) -Value $functions[$name]};Export-ModuleMember -Function @()} $helpers
  $report=$pair.ApplyOnce([Action[CluedNewChildReadAccess181.ReadAccessPlan]]$verify)
  Uac181Require ($report.Status -ceq 'APPLIED_TO_DISTINCT_NEW_OBJECTS_ONLY' -and $report.WritesConfirmed -eq 4 -and -not $report.UnknownMutationExtent) 'CHILD_READ_ACCESS_NOT_PROVEN'
  $children=@{OBSERVER=$pair.ObserverProcess;RELAY=$pair.RelayProcess}
  foreach($role in @('OBSERVER','RELAY')){$p=$children[$role];foreach($line in $x.($role.ToLowerInvariant()+'_initial_lines')){Uac181Require ($line -is [string] -and $line -notmatch '[\r\n]' -and $line.Length -le 2097152) 'CAPTURED_CHILD_BOOTSTRAP_LINE';$p.StandardInput.WriteLine($line);$p.StandardInput.Flush()};WriteUac181 $wire $role 'META' ([pscustomobject]@{pid=$p.Id;start=[string]$p.StartTime.ToUniversalTime().ToFileTimeUtc();image=$fixed;packet_sha256=$pack.packet_sha256})}
  InvokeUac181PairMux $wire $children
 }finally{if($pair){$pair.Dispose()};$pipe.Dispose()}
}
function InvokeUac181PairMux($wire,$children){
 $reads=@{};$readers=@{};$ended=@{};$stderr=@{};$deadline=[DateTime]::UtcNow.AddMinutes(5)
 foreach($role in @('OBSERVER','RELAY')){$readers[$role]=[CluedRootUacControl181.BoundedLineReader]::new($children[$role].StandardOutput.BaseStream);$reads[$role]=$readers[$role].ReadAsync(120000);$stderr[$role]=[CluedRootUacControl181.ErrorCapture]::ReadAsync($children[$role].StandardError.BaseStream)}
 $control=$wire.reader.ReadAsync(120000)
 while($ended.Count -lt 2){
  Uac181Require ([DateTime]::UtcNow -lt $deadline) 'PAIR_MUX_TIMEOUT'
  foreach($role in @('OBSERVER','RELAY')){if($ended.ContainsKey($role)){continue};if($reads[$role].IsCompleted){$line=$reads[$role].GetAwaiter().GetResult();if($null -eq $line){$ended[$role]=$true;continue};Uac181Require ([Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'CHILD_STDOUT_BOUND';WriteUac181 $wire $role 'STDOUT' ([pscustomobject]@{line=$line});$reads[$role]=$readers[$role].ReadAsync(120000)}}
  if($control.IsCompleted){$line=$control.GetAwaiter().GetResult();Uac181Require ($null -ne $line) 'ROOT_CONTROL_EOF';$v=Uac181Json $line;Uac181Keys $v @('schema','session','seq','role','kind','body');Uac181Require ((Uac181ExactString $v.schema 'clued.root-uac-control181/1') -and (Uac181ExactString $v.session $wire.session) -and $v.seq -is [int] -and $v.seq -eq $wire.received+1 -and $v.seq -le 1024 -and $v.role -is [string] -and $v.role -cin @('OBSERVER','RELAY') -and (Uac181ExactString $v.kind 'STDIN')) 'FIXED_CHILD_STDIN_ONLY';$wire.received++;Uac181Keys $v.body @('line');Uac181Require ($v.body.line -is [string] -and $v.body.line -notmatch '[\r\n]' -and [Text.Encoding]::UTF8.GetByteCount($v.body.line) -le 16384) 'CHILD_REPLY_LINE';$p=$children[$v.role];Uac181Require (-not $p.HasExited) 'CHILD_ALREADY_EXITED';$p.StandardInput.WriteLine($v.body.line);$p.StandardInput.Flush();$control=$wire.reader.ReadAsync(120000)}
  Start-Sleep -Milliseconds 5
 }
 foreach($role in @('OBSERVER','RELAY')){$p=$children[$role];Uac181Require ($p.WaitForExit(5000) -and $stderr[$role].Wait(5000)) 'CHILD_TERMINAL_EOF';$streamError=$stderr[$role].Result;Uac181Require ($streamError.Eof -and -not $streamError.Exceeded) 'CHILD_STDERR_BOUND';WriteUac181 $wire $role 'TERMINAL' ([pscustomobject]@{exit_code=$p.ExitCode;stdout_eof=$true;stderr_eof=$true;stderr_bytes=$streamError.Bytes;stderr_sha256=$streamError.Sha256})}
}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_PARENT_BOOTSTRAP_ONLY_NO_CLI_AUTHORITY'}
