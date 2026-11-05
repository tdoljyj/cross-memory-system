# Captured ordinary Root PS library. Direct entry cannot open UAC.
function S214Require($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function S214Emit([string]$kind,$body){$s=$script:OwnedRoot214;$s.event_seq++;S214Require ($s.event_seq -le 2048) 'ROOT_EVENT_BOUND';$v=[ordered]@{schema='clued.root-supervisor-event214/1';seq=$s.event_seq;kind=$kind;body=$body};$line=$v|ConvertTo-Json -Compress -Depth 16;S214Require ([Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'ROOT_EVENT_BYTES';[Console]::Out.WriteLine($line);[Console]::Out.Flush()}
function S214ReadHostLine([string]$line){
 $s=$script:OwnedRoot214;S214Require ($line -is [string] -and [Text.Encoding]::UTF8.GetByteCount($line) -le 16384) 'HOST_CONTROL_LINE_BOUND';$v=Uac181Json $line;Uac181Keys $v @('schema','seq','packet_sha256','kind','body');$s.host_seq++
 S214Require ((Uac181ExactString $v.schema 'clued.root-supervisor-command214/1') -and $v.seq -is [int] -and $v.seq -eq $s.host_seq -and $v.seq -le 2048 -and (Uac181ExactString $v.packet_sha256 $s.capture.packet_sha256) -and $v.kind -is [string]) 'HOST_CONTROL_BINDING';return $v
}
function S214Ask([string]$operation,$plan=$null){
 $s=$script:OwnedRoot214;$s.auth_seq++;$id=[string]$s.auth_seq
 S214Emit 'PARENT_AUTH' ([pscustomobject]@{request_id=$id;operation=$operation;packet_sha256=$s.capture.packet_sha256;plan=$plan})
 $pending=$s.reader.ReadLineAsync();S214Require ($pending.Wait(20000)) 'HOST_CURRENT_REPLY_TIMEOUT';$v=S214ReadHostLine $pending.GetAwaiter().GetResult();S214Require ($v.kind -ceq 'AUTHORIZATION') 'HOST_AUTHORIZATION_REPLY_REQUIRED';Uac181Keys $v.body @('request_id','value');S214Require (Uac181ExactString $v.body.request_id $id) 'HOST_AUTHORIZATION_CORRELATION';Uac181Authorization $v.body.value $s.capture.packet_sha256;return $v.body.value
}
function S214CompletedParent([string]$text){
 $s=$script:OwnedRoot214;$wire=$s.controller.wire;$v=Uac181Json $text;Uac181Keys $v @('schema','session','seq','role','kind','body')
 S214Require ((Uac181ExactString $v.schema 'clued.root-uac-control181/1') -and (Uac181ExactString $v.session $wire.session) -and $v.seq -is [int] -and $v.seq -eq $wire.received+1 -and $v.seq -le 1024 -and $v.role -is [string] -and $v.role -cin @('PARENT','OBSERVER','RELAY') -and $v.kind -is [string]) 'PARENT_CONTROL_BINDING';$wire.received++;return $v
}
function InvokeCapturedRootOwnedSupervisor214($capture,[IO.StreamReader]$capturedHostReader){
 $ErrorActionPreference='Stop';S214Require ($capturedHostReader -is [IO.StreamReader]) 'ACTUAL_CAPTURED_HOST_READER';S214Require ($null -eq $script:OwnedRoot214 -and $capture -is [pscustomobject]) 'CAPTURED_ROOT_SINGLE_PRIVATE_NAMESPACE'
 $names=@('schema','owner_sid','packet_sha256','target_sid','parent_bootstrap_path','parent_bootstrap_sha256','parent_package_path','parent_package_sha256','supervisor_base64','supervisor_sha256','control_base64','identity_base64')
 S214Require ((($capture.PSObject.Properties.Name|Sort-Object)-join '|') -ceq (($names|Sort-Object)-join '|')) 'ROOT_CAPTURE_CLOSED'
 foreach($n in $names){S214Require ($capture.$n -is [string] -and $capture.$n -notmatch '[\r\n\x00]') 'ROOT_CAPTURE_RAW_STRINGS'}
 S214Require ($capture.schema -ceq 'clued.root-owned-supervisor-capture214/1' -and $capture.packet_sha256 -cmatch '\A[a-f0-9]{64}\z' -and $capture.parent_package_sha256 -cmatch '\A[a-f0-9]{64}\z' -and $capture.parent_bootstrap_sha256 -cmatch '\A[a-f0-9]{64}\z' -and $capture.supervisor_sha256 -ceq 'db8ec064e2f049c8fc306333d6cddfd4bbe677222c34d349e2551e7effb68a36' -and $capture.parent_bootstrap_sha256 -ceq '29503e11d72494bb90865eece3a034541241050daba45dd50942d3a7d223215f' -and $capture.target_sid -cmatch '\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z') 'ROOT_CAPTURE_DOMAINS'
 # All component pins are captured by the exact accepted Source/actor packet.
 $supervisor=[Convert]::FromBase64String($capture.supervisor_base64);$control=[Convert]::FromBase64String($capture.control_base64);$identity=[Convert]::FromBase64String($capture.identity_base64)
 $h=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($h.ComputeHash($supervisor))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};S214Require ($actual -ceq $capture.supervisor_sha256 -and $supervisor.Length -le 65536) 'ROOT_UAC_SUPERVISOR_CAPTURE'
 . ([scriptblock]::Create([Text.UTF8Encoding]::new($false,$true).GetString($supervisor)))
 Uac181Import $control '5885416d8d76ad33dfd5978d61221402b6f7b035c4f226611d4f1b229c493ad8' $identity
 # The runtime envelope raw SHA is integrity, not an acceptance receipt.
 # Its executable components must still be the exact accepted static Source.
 foreach($path in @($capture.parent_package_path,$capture.parent_bootstrap_path)){
  S214Require ($path -cmatch '\A[A-Za-z]:[\\/]' -and $path -notmatch '[\r\n\x00]') 'ROOT_PUBLIC_CODE_ABSOLUTE_PATH'
  $walk=Get-Item -LiteralPath $path -Force;while($null -ne $walk){S214Require (([long]$walk.Attributes -band 1024) -eq 0) 'ROOT_PUBLIC_CODE_REPARSE';if($walk.PSIsContainer){$walk=$walk.Parent}else{$walk=$walk.Directory}}
 }
 $stream=[IO.FileStream]::new($capture.parent_package_path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 try{S214Require ($stream.Length -gt 0 -and $stream.Length -le 8388608) 'PARENT_PACKAGE_BYTE_BOUND';$bytes=New-Object byte[] ([int]$stream.Length);$offset=0;while($offset -lt $bytes.Length){$n=$stream.Read($bytes,$offset,$bytes.Length-$offset);S214Require ($n -gt 0) 'PARENT_PACKAGE_PARTIAL_READ';$offset+=$n}}finally{$stream.Dispose()}
 S214Require ((Uac181Hash $bytes) -ceq $capture.parent_package_sha256) 'PARENT_RUNTIME_ENVELOPE_INTEGRITY'
 $package=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)|ConvertFrom-Json
 Uac181Keys $package @('schema','packet_sha256','target_sid','members','pair');S214Require ((Uac181ExactString $package.schema 'clued.root-uac-captured-package181/1') -and (Uac181ExactString $package.packet_sha256 $capture.packet_sha256) -and (Uac181ExactString $package.target_sid $capture.target_sid)) 'PARENT_RUNTIME_CORRELATION'
 $memberPins=@{control='5885416d8d76ad33dfd5978d61221402b6f7b035c4f226611d4f1b229c493ad8';identity='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';child_factory='24076ae339aa6b90240da7abb0dee2ea4be224f781aab1a08cf8b19764944bbf';supervisor='db8ec064e2f049c8fc306333d6cddfd4bbe677222c34d349e2551e7effb68a36'}
 Uac181Keys $package.members @('control','identity','child_factory','supervisor');foreach($name in $memberPins.Keys){$member=$package.members.$name;Uac181Keys $member @('base64','sha256');S214Require ($member.base64 -is [string] -and (Uac181ExactString $member.sha256 $memberPins[$name])) 'PARENT_STATIC_COMPONENT_PIN';$raw=[Convert]::FromBase64String($member.base64);S214Require ((Uac181Hash $raw) -ceq $memberPins[$name]) 'PARENT_STATIC_COMPONENT_BYTES'}
 $own=Uac181Own;S214Require ($own.Elevated -eq 0 -and (Uac181ExactString $own.Sid $capture.owner_sid)) 'ORDINARY_CAPTURED_ROOT_OWNER_ONLY'
 $state=@{capture=$capture;reader=$capturedHostReader;event_seq=0;host_seq=0;auth_seq=0;controller=$null;ready_tick=0L;pending_auth=$null;terminal=@{}}
 $script:OwnedRoot214=$state;$wire=$null;$controller=$null
 try{
  S214Emit 'READY' ([pscustomobject]@{pid=[int]$PID;start=[string]$own.CreationFileTime;sid=$own.Sid;elevated=$own.Elevated;image=$own.Image;packet_sha256=$capture.packet_sha256})
  $wire=NewUac181RootController
  $parentData=[pscustomobject]@{package_path=$capture.parent_package_path;package_sha256=$capture.parent_package_sha256;pipe_nonce=$wire.pipe_nonce;session=$wire.session;root_pid=[int]$PID;root_start=[string]$own.CreationFileTime;root_sid=$own.Sid}
  $bound=[pscustomobject]@{packet_sha256=$capture.packet_sha256;parent_bootstrap_path=$capture.parent_bootstrap_path;parent_bootstrap_sha256=$capture.parent_bootstrap_sha256;parent_data=$parentData}
  $controller=StartUac181AcceptedParent $wire $bound {S214Ask 'START_PARENT'};$state.controller=$controller;$p=$controller.actual_parent
  S214Emit 'PARENT_HELD' ([pscustomobject]@{pid=$p.Pid;start=[string]$p.CreationFileTime;sid=$p.Sid;elevated=$p.Elevated;image=$p.Image})
  $hello=ReadUac181 $wire 10000;S214Require ($hello.role -ceq 'PARENT' -and $hello.kind -ceq 'HELLO') 'PARENT_HELLO_REQUIRED';Uac181Keys $hello.body @('pid','start','sid','elevated','image','packet_sha256')
  S214Require ($hello.body.pid -is [int] -and $hello.body.pid -eq $p.Pid -and (Uac181ExactString $hello.body.start ([string]$p.CreationFileTime)) -and (Uac181ExactString $hello.body.sid $p.Sid) -and $hello.body.elevated -is [int] -and $hello.body.elevated -eq 1 -and $hello.body.image -is [string] -and $hello.body.image -ieq $p.Image -and (Uac181ExactString $hello.body.packet_sha256 $capture.packet_sha256)) 'ACTUAL_UAC_PARENT_HELLO'
  $null=S214Ask 'START_PAIR';WriteUac181 $wire 'PARENT' 'START' ([pscustomobject]@{packet_sha256=$capture.packet_sha256})
  $parentRead=$wire.reader.ReadAsync(120000);$hostRead=$state.reader.ReadLineAsync();$deadline=[Diagnostics.Stopwatch]::StartNew()
  while($state.terminal.Count -lt 2){
   S214Require ($deadline.Elapsed.TotalSeconds -lt 300 -and -not $controller.owned_process.HasExited) 'OWNED_PARENT_OR_MUX_STOPPED'
   if($parentRead.IsCompleted){
    $raw=$parentRead.GetAwaiter().GetResult();S214Require ($null -ne $raw) 'PARENT_CONTROL_EOF';$v=S214CompletedParent $raw
    if($v.role -ceq 'PARENT'){
     S214Require ($v.kind -ceq 'AUTH_REQUEST' -and $null -eq $state.pending_auth) 'FIXED_PARENT_AUTH_ONCE_PENDING';Uac181Keys $v.body @('operation','packet_sha256','plan')
     S214Require ($v.body.operation -is [string] -and $v.body.operation -cin @('NEW_CHILD_READ_ACCESS','NEW_CHILD_READ_ACCESS_WRITE') -and (Uac181ExactString $v.body.packet_sha256 $capture.packet_sha256)) 'PARENT_FIXED_READ_PLAN'
     $state.auth_seq++;$state.pending_auth=[string]$state.auth_seq;S214Emit 'PARENT_AUTH' ([pscustomobject]@{request_id=$state.pending_auth;operation=$v.body.operation;packet_sha256=$capture.packet_sha256;plan=$v.body.plan})
    }else{
     S214Require ($v.kind -cin @('META','STDOUT','TERMINAL') -and -not $state.terminal.ContainsKey($v.role)) 'OWNED_CHILD_EVENT_ORDER'
     if($v.kind -ceq 'STDOUT' -and $v.role -ceq 'OBSERVER'){$line=Uac181Json $v.body.line;if($line.schema -is [string] -and $line.schema -ceq 'clued.windows-self-entry-ready181/1'){S214Require ($state.ready_tick -eq 0L) 'READY_MONOTONIC_ONCE';$state.ready_tick=[Diagnostics.Stopwatch]::GetTimestamp()}}
     if($v.kind -ceq 'TERMINAL'){$state.terminal[$v.role]=$v.body}
     S214Emit 'CHILD_FRAME' ([pscustomobject]@{role=$v.role;kind=$v.kind;body=$v.body})
    }
    $parentRead=$wire.reader.ReadAsync(120000)
   }
   if($hostRead.IsCompleted){
    $line=$hostRead.GetAwaiter().GetResult();S214Require ($null -ne $line) 'ACTUAL_ROOT_HOST_EOF';$q=S214ReadHostLine $line
    if($q.kind -ceq 'AUTHORIZATION'){
     Uac181Keys $q.body @('request_id','value');S214Require ($null -ne $state.pending_auth -and (Uac181ExactString $q.body.request_id $state.pending_auth)) 'ACTUAL_PENDING_AUTH_REPLY';Uac181Authorization $q.body.value $capture.packet_sha256
     WriteUac181 $wire 'PARENT' 'AUTH_RESPONSE' $q.body.value;$state.pending_auth=$null
    }elseif($q.kind -ceq 'CHILD_STDIN'){
     Uac181Keys $q.body @('role','line');S214Require ($q.body.role -is [string] -and $q.body.role -cin @('OBSERVER','RELAY') -and $q.body.line -is [string] -and $q.body.line -notmatch '[\r\n]' -and [Text.Encoding]::UTF8.GetByteCount($q.body.line) -le 16384 -and -not $state.terminal.ContainsKey($q.body.role)) 'FIXED_CHILD_STDIN'
     WriteUac181 $wire $q.body.role 'STDIN' ([pscustomobject]@{line=$q.body.line})
    }elseif($q.kind -ceq 'READ_READY_AGE'){
     Uac181Keys $q.body @('request_id');S214Require ($q.body.request_id -is [string] -and $state.ready_tick -gt 0L) 'ACTUAL_READY_MONOTONIC_REQUIRED'
     $age=[long][Math]::Floor(([Diagnostics.Stopwatch]::GetTimestamp()-$state.ready_tick)*1000.0/[Diagnostics.Stopwatch]::Frequency);S214Require ($age -ge 0 -and $age -lt 120000) 'ACTUAL_READY_AGE_BOUND';S214Emit 'READY_AGE' ([pscustomobject]@{request_id=$q.body.request_id;age_ms=$age})
    }else{throw 'ROOT_CONTROL_FIXED_KIND_ONLY'}
    $hostRead=$state.reader.ReadLineAsync()
   }
   Start-Sleep -Milliseconds 5
  }
  $settle=[Diagnostics.Stopwatch]::StartNew();while(-not $controller.owned_process.HasExited -and $settle.Elapsed.TotalSeconds -lt 5){Start-Sleep -Milliseconds 20};S214Require ($controller.owned_process.ExitCode -eq 0) 'OWNED_PARENT_EXIT'
  S214Emit 'TERMINAL' ([pscustomobject]@{parent_exit_code=$controller.owned_process.ExitCode;qualification=$false})
 }finally{if($controller){$controller.owned_process.Dispose()};if($wire){$wire.pipe.Dispose()};$script:OwnedRoot214=$null}
}
if($MyInvocation.InvocationName -ne '.'){throw 'CAPTURED_ROOT_HOST_SOURCE_OWNER_CI_REQUIRED_NO_PUBLIC_UAC_ENTRY'}
