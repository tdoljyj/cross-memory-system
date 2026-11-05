# Captured library. No command-line production launch and no authority from flags.
function Uac181Require([bool]$ok,[string]$code){if(-not $ok){throw [InvalidOperationException]::new($code)}}
# Raw primitives must be checked before PowerShell's coercing comparisons.
function Uac181ExactString($value,[string]$expected){return ($value -is [string] -and [StringComparer]::Ordinal.Equals($value,$expected))}
function Uac181Packet($value){return ($value -is [string] -and $value -cmatch '\A[a-f0-9]{64}\z')}
function Uac181Authorization($answer,$packetSha){
 Uac181Require (Uac181Packet $packetSha) 'EXPECTED_PACKET_PRIMITIVE'
 Uac181Keys $answer @('status','packet_sha256')
 Uac181Require ((Uac181ExactString $answer.status 'CURRENT') -and (Uac181Packet $answer.packet_sha256) -and (Uac181ExactString $answer.packet_sha256 $packetSha)) 'ROOT_AUTHORIZATION_RAW_PRIMITIVES'
}
function Uac181Hash([byte[]]$raw){$s=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($s.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function Uac181Import([byte[]]$control,[string]$controlSha,[byte[]]$identity){
 Uac181Require ((Uac181Hash $control) -ceq $controlSha -and (Uac181Hash $identity) -ceq '31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8') 'CAPTURED_DLL_SHA'
 [void][Reflection.Assembly]::Load($identity);[void][Reflection.Assembly]::Load($control)
}
function Uac181Own {
 Uac181Require ([Environment]::Is64BitProcess) 'X64_REQUIRED'
 $thread=[Security.Principal.WindowsIdentity]::GetCurrent($true);if($null -ne $thread){$thread.Dispose();throw 'THREAD_IMPERSONATION_REFUSED'}
 $held=[CluedQualification181.HeldProcess]::new($PID)
 try{$o=$held.Observe();Uac181Require ($o.Sid -cne 'S-1-5-18') 'SYSTEM_REFUSED';return $o}finally{$held.Dispose()}
}
function Uac181Peer($pipe,[int]$expectedProcessId,[long]$expectedStart,[string]$expectedSid,[string]$expectedImage,[int]$expectedElevation){
 # Kernel peer PID is authoritative; no caller-supplied PID selects the handle.
 $kernelId=$pipe.PeerPid;Uac181Require ($kernelId -eq $expectedProcessId) 'KERNEL_PEER_PID'
 $held=[CluedQualification181.HeldProcess]::new($kernelId)
 try{$o=$held.Observe();Uac181Require ($o.Pid -eq $kernelId -and $o.CreationFileTime -eq $expectedStart -and $o.Sid -ceq $expectedSid -and $o.Image -ieq $expectedImage -and $o.Elevated -eq $expectedElevation -and -not $held.HasExited) 'KERNEL_PEER_IDENTITY';return $o}finally{$held.Dispose()}
}
function Uac181Json([string]$text){
 Uac181Require ([Text.Encoding]::UTF8.GetByteCount($text) -le 32768) 'CONTROL_JSON_BOUND'
 $tokens=[regex]::Matches($text,'"(?:[^"\\]|\\.)*"|[{}\[\]:,]');$stack=[Collections.Generic.Stack[object]]::new()
 for($i=0;$i -lt $tokens.Count;$i++){$t=$tokens[$i].Value;if($t -ceq '{'){$stack.Push([Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase))}elseif($t -ceq '['){$stack.Push($null)}elseif($t -in @('}',']')){Uac181Require ($stack.Count -gt 0) 'JSON_STACK';$null=$stack.Pop()}elseif($t.StartsWith('"') -and $i+1 -lt $tokens.Count -and $tokens[$i+1].Value -ceq ':'){$k=('['+$t+']'|ConvertFrom-Json)[0];Uac181Require ($stack.Count -gt 0 -and $null -ne $stack.Peek() -and $stack.Peek().Add($k)) 'JSON_DUPLICATE_KEY'}}
 return ($text|ConvertFrom-Json)
}
function Uac181Keys($v,[string[]]$keys){Uac181Require ($v -is [pscustomobject] -and (($v.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'CLOSED_CONTROL_FIELDS'}
function NewUac181Wire($pipe,[string]$session){
 Uac181Require ($session -cmatch '^[a-f0-9]{32}$') 'CONTROL_SESSION'
 return @{pipe=$pipe;session=$session;sent=0;received=0;reader=[CluedRootUacControl181.BoundedLineReader]::new($pipe.Transport);closed=$false}
}
function NewUac181RootController {
 $own=Uac181Own;Uac181Require ($own.Elevated -eq 0) 'ORDINARY_ROOT_ONLY'
 $nonce=[Guid]::NewGuid().ToString('N');$session=[Guid]::NewGuid().ToString('N')
 return @{pipe=[CluedRootUacControl181.ControlPipe]::Create($nonce,$own.Sid);pipe_nonce=$nonce;session=$session;sent=0;received=0;reader=$null;closed=$false;root=$own}
}
function WriteUac181($wire,[string]$role,[string]$kind,$body){
 Uac181Require (-not $wire.closed -and $wire.sent -lt 1024 -and $role -cin @('PARENT','OBSERVER','RELAY') -and $kind -cin @('HELLO','START','AUTH_REQUEST','AUTH_RESPONSE','META','STDOUT','STDIN','TERMINAL','REFUSED')) 'CONTROL_WRITE_DOMAIN'
 $wire.sent++;$v=[ordered]@{schema='clued.root-uac-control181/1';session=$wire.session;seq=$wire.sent;role=$role;kind=$kind;body=$body};$text=$v|ConvertTo-Json -Depth 12 -Compress
 Uac181Require ([Text.Encoding]::UTF8.GetByteCount($text) -le 32768) 'CONTROL_WRITE_BOUND'
 $b=[Text.UTF8Encoding]::new($false).GetBytes($text+"`n");$wire.pipe.Transport.Write($b,0,$b.Length);$wire.pipe.Transport.Flush()
}
function ReadUac181($wire,[int]$timeout=5000){
 try{$text=$wire.reader.ReadAsync($timeout).GetAwaiter().GetResult();Uac181Require ($null -ne $text -and -not $wire.closed) 'CONTROL_EOF';$v=Uac181Json $text;Uac181Keys $v @('schema','session','seq','role','kind','body')
  Uac181Require ((Uac181ExactString $v.schema 'clued.root-uac-control181/1') -and (Uac181ExactString $v.session $wire.session) -and $v.seq -is [int] -and $v.seq -eq $wire.received+1 -and $v.seq -le 1024 -and $v.role -is [string] -and $v.kind -is [string] -and $v.role -cin @('PARENT','OBSERVER','RELAY') -and $v.kind -cin @('HELLO','START','AUTH_REQUEST','AUTH_RESPONSE','META','STDOUT','STDIN','TERMINAL','REFUSED')) 'CONTROL_READ_BINDING';$wire.received++;return $v
 }catch{$wire.closed=$true;throw}
}
function NewUac181EncodedParent([string]$bootstrapPath,[string]$bootstrapSha,$data){
 Uac181Require ($bootstrapPath -cmatch '^[A-Za-z]:[\\/]' -and $bootstrapPath -notmatch '[\r\n\x00]' -and $bootstrapSha -cmatch '\A[a-f0-9]{64}\z') 'BOOTSTRAP_CAPTURE_REFERENCE'
 $pathB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bootstrapPath));$dataB64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($data|ConvertTo-Json -Compress -Depth 10)))
 # Path/data are literals encoded as data; execute the exact bytes hashed here.
 $code='$ErrorActionPreference="Stop";$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("'+$pathB64+'"));$b=[IO.File]::ReadAllBytes($p);if($b.Length -gt 1048576){exit 2};$s=[Security.Cryptography.SHA256]::Create();try{$h=([BitConverter]::ToString($s.ComputeHash($b))).Replace("-","").ToLowerInvariant()}finally{$s.Dispose()};if($h -cne "'+$bootstrapSha+'"){exit 2};. ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($b)));$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("'+$dataB64+'"))|ConvertFrom-Json;InvokeCapturedUac181Parent $d'
 $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code));Uac181Require ($encoded.Length -le 30000) 'ENCODED_PARENT_BOUND';return $encoded
}
function StartUac181AcceptedParent($wire,$captured,[scriptblock]$actualRootAuthorize){
 # Internal Host seam: only independently captured Root code supplies this
 # callback. A CLI flag, child JSON, digest or arbitrary caller callback is not permission.
 Uac181Require ($null -ne $actualRootAuthorize) 'ACTUAL_ROOT_AUTHORITY_REQUIRED';$a=& $actualRootAuthorize
 Uac181Authorization $a $captured.packet_sha256
 $own=Uac181Own;Uac181Require ($own.Elevated -eq 0) 'ORDINARY_SUPERVISOR_REQUIRED'
 Uac181Require ($captured.parent_data.root_pid -is [int] -and $captured.parent_data.root_pid -eq $PID -and (Uac181ExactString $captured.parent_data.root_start ([string]$own.CreationFileTime)) -and (Uac181ExactString $captured.parent_data.root_sid $own.Sid) -and (Uac181ExactString $captured.parent_data.session $wire.session) -and (Uac181ExactString $captured.parent_data.pipe_nonce $wire.pipe_nonce)) 'ROOT_DERIVED_BOOTSTRAP_BINDING'
 $fixed=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';Uac181Require ($own.Image -ieq $fixed) 'FIXED_ROOT_POWERSHELL'
 $encoded=NewUac181EncodedParent $captured.parent_bootstrap_path $captured.parent_bootstrap_sha256 $captured.parent_data
 $owned=[CluedRootUacControl181.UacLauncher]::LaunchExact($encoded)
 try{$wire.pipe.Accept(120000);$wire.reader=[CluedRootUacControl181.BoundedLineReader]::new($wire.pipe.Transport);$peer=Uac181Peer $wire.pipe $owned.Pid $owned.CreationFileTime $own.Sid $fixed 1
  Uac181Require (-not $owned.HasExited) 'OWNED_UAC_PARENT_EXITED';$wire.pipe.VerifySecurity($own.Sid)
  return @{owned_process=$owned;wire=$wire;actual_parent=$peer;root=$own}
 }catch{$owned.Dispose();throw}
}
function InvokeUac181Controller($controller,[string]$packetSha,[scriptblock]$actualRootAuthorize,[scriptblock]$onCapturedChildFrame){
 # Ordinary Root's captured orchestration supplies both callbacks in memory.
 # The child cannot choose either callback or make an executable/path request.
 $wire=$controller.wire;$hello=ReadUac181 $wire 10000
 Uac181Require ($hello.role -ceq 'PARENT' -and $hello.kind -ceq 'HELLO') 'PARENT_HELLO'
 Uac181Keys $hello.body @('pid','start','sid','elevated','image','packet_sha256')
 $p=$controller.actual_parent;Uac181Require ($hello.body.pid -is [int] -and $hello.body.pid -eq $p.Pid -and (Uac181ExactString $hello.body.start ([string]$p.CreationFileTime)) -and (Uac181ExactString $hello.body.sid $p.Sid) -and $hello.body.elevated -is [int] -and $hello.body.elevated -eq 1 -and $hello.body.image -is [string] -and [StringComparer]::OrdinalIgnoreCase.Equals($hello.body.image,$p.Image) -and (Uac181Packet $hello.body.packet_sha256) -and (Uac181ExactString $hello.body.packet_sha256 $packetSha)) 'PARENT_HELLO_HELD_IDENTITY'
 $a=& $actualRootAuthorize 'START_PAIR' $hello.body;Uac181Authorization $a $packetSha
 WriteUac181 $wire 'PARENT' 'START' ([pscustomobject]@{packet_sha256=$packetSha});$terminal=@{};$clock=[Diagnostics.Stopwatch]::StartNew()
 while($terminal.Count -lt 2){Uac181Require ($clock.Elapsed.TotalSeconds -lt 300 -and -not $controller.owned_process.HasExited) 'OWNED_PARENT_OR_CONTROL_STOPPED';$m=ReadUac181 $wire 120000
  if($m.role -ceq 'PARENT'){
   Uac181Require ($m.kind -ceq 'AUTH_REQUEST') 'PARENT_FIXED_AUTH_ONLY';Uac181Keys $m.body @('operation','packet_sha256','plan');Uac181Require ($m.body.operation -is [string] -and $m.body.operation -cin @('NEW_CHILD_READ_ACCESS','NEW_CHILD_READ_ACCESS_WRITE') -and (Uac181ExactString $m.body.packet_sha256 $packetSha)) 'PARENT_FIXED_PLAN_SCOPE'
   $answer=& $actualRootAuthorize $m.body.operation $m.body;Uac181Authorization $answer $packetSha;WriteUac181 $wire 'PARENT' 'AUTH_RESPONSE' $answer
  }else{
   Uac181Require ($m.role -cin @('OBSERVER','RELAY') -and $m.kind -cin @('META','STDOUT','TERMINAL') -and -not $terminal.ContainsKey($m.role)) 'FIXED_ROLE_EVENT_ORDER'
   if($m.kind -ceq 'TERMINAL'){$terminal[$m.role]=$m.body}
   $responses=@(& $onCapturedChildFrame $m)
   foreach($reply in $responses){if($null -eq $reply){continue};Uac181Keys $reply @('role','kind','body');Uac181Require ($reply.role -cin @('OBSERVER','RELAY') -and $reply.kind -ceq 'STDIN') 'FIXED_CAPTURED_CHILD_REPLY';Uac181Keys $reply.body @('line');Uac181Require ($reply.body.line -is [string] -and $reply.body.line -notmatch '[\r\n]' -and [Text.Encoding]::UTF8.GetByteCount($reply.body.line) -le 16384) 'CHILD_REPLY_BOUND';WriteUac181 $wire $reply.role 'STDIN' $reply.body}
  }
 }
 $settle=[Diagnostics.Stopwatch]::StartNew();while(-not $controller.owned_process.HasExited -and $settle.Elapsed.TotalSeconds -lt 5){Start-Sleep -Milliseconds 20};$parentExit=$controller.owned_process.ExitCode
 return @{schema='clued.root-uac-controlled-pair181/1';parent_exit_code=$parentExit;children=$terminal;qualification=$false;automatic_retry=$false}
}
if($MyInvocation.InvocationName -ne '.'){@{schema='clued.root-uac-supervisor-preview181/1';status='CAPTURED_LIBRARY_NO_PRODUCTION_CLI';uac=$false;task=$false}|ConvertTo-Json -Compress}
