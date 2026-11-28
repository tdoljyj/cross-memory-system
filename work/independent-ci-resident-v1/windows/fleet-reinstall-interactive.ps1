# The low-privilege task has a fixed action, delivery root and bootstrap arguments.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$FleetDeliveryRoot = 'C:\ProgramData\CluedFleetDelivery'
$FleetResidentRoot = 'C:\ProgramData\CluedIndependentCI\resident'
$FleetReinstallTask = 'CluedCIFleetReinstall'
$FleetDeliveryPowerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$FleetReinstallExecutable = 'C:\Windows\System32\conhost.exe'
$FleetReinstallArguments = '--headless ' + $FleetDeliveryPowerShell + ' -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\CluedFleetDelivery\interactive.ps1'
$FleetDeliveryResidentSid = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'

function Get-FleetDeliveryAcl([string]$operator, [bool]$claims) {
  $opMask = if ($claims) { '0x1301bf' } else { '0x1200a9' }
  'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' +
    "(A;OICI;0x1200a9;;;$FleetDeliveryResidentSid)(A;OICI;$opMask;;;$operator)"
}

function Assert-FleetDeliveryAcl([string]$dir, [string]$operator, [bool]$claims) {
  $entry = Get-Item -LiteralPath $dir -Force
  $actual = Get-Acl -LiteralPath $dir
  $expected = [Security.AccessControl.DirectorySecurity]::new()
  $expected.SetSecurityDescriptorSddlForm((Get-FleetDeliveryAcl $operator $claims))
  $sid = [Security.Principal.SecurityIdentifier]
  $access = { param($acl) @($acl.GetAccessRules($true, $true, $sid)) | ForEach-Object {
    "$($_.IdentityReference)|$($_.FileSystemRights)|$($_.AccessControlType)|$($_.InheritanceFlags)|$($_.PropagationFlags)|$($_.IsInherited)"
  } | Sort-Object }
  if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      -not $actual.AreAccessRulesProtected -or $actual.GetOwner($sid).Value -cnotin @('S-1-5-18','S-1-5-32-544') -or
      ((& $access $actual) -join ',') -cne ((& $access $expected) -join ',')) {
    throw 'FLEET_REINSTALL_ROOT_REFUSED'
  }
}

function Get-FleetReinstallTaskSddl([string]$operator) {
  "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;$operator)"
}

function Test-FleetReinstallTaskDefinition($task, [string]$operator) {
  if (-not $task -or -not $task.Enabled) { return $false }
  $def = $task.Definition
  if ($def.Principal.RunLevel -ne 0 -or $def.Principal.LogonType -ne 3 -or $def.Settings.MultipleInstances -ne 2 -or
      $def.Actions.Count -ne 1 -or $def.Triggers.Count -ne 3) { return $false }
  $id = [string]$def.Principal.UserId
  if ($id -notlike 'S-1-*') { $id = ([Security.Principal.NTAccount]::new($id)).Translate([Security.Principal.SecurityIdentifier]).Value }
  $action = $def.Actions.Item(1)
  if ($id -cne $operator -or $action.Path -cne $FleetReinstallExecutable -or $action.Arguments -cne $FleetReinstallArguments) { return $false }
  $logon = $def.Triggers.Item(1); $unlock = $def.Triggers.Item(2); $periodic = $def.Triggers.Item(3)
  if ($logon.Type -ne 9 -or $unlock.Type -ne 11 -or $unlock.StateChange -ne 8 -or $periodic.Type -ne 1 -or
      $periodic.Repetition.Interval -cne 'PT1M' -or -not ($logon.Enabled -and $unlock.Enabled -and $periodic.Enabled)) { return $false }
  $sddl = [Security.AccessControl.RawSecurityDescriptor]::new((Get-FleetReinstallTaskSddl $operator))
  $actual = [Security.AccessControl.RawSecurityDescriptor]::new($task.GetSecurityDescriptor(4))
  # Task Scheduler adds the auto-inherited control flag when storing a protected DACL.
  if (-not ($actual.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -or
      -not $actual.DiscretionaryAcl) { return $false }
  $expected = [byte[]]::new($sddl.DiscretionaryAcl.BinaryLength)
  $stored = [byte[]]::new($actual.DiscretionaryAcl.BinaryLength)
  $sddl.DiscretionaryAcl.GetBinaryForm($expected, 0)
  $actual.DiscretionaryAcl.GetBinaryForm($stored, 0)
  [Convert]::ToBase64String($expected) -ceq [Convert]::ToBase64String($stored)
}

function Install-FleetReinstallEntry([string]$operator, [string]$scriptPath) {
  if ($env:CLUED_UNDER_TEST -or $env:NODE_TEST_CONTEXT -or $operator -cnotmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') {
    throw 'FLEET_REINSTALL_INSTALL_REFUSED'
  }
  $claims = Join-Path $FleetDeliveryRoot 'claims'
  foreach ($dir in @($FleetDeliveryRoot, $claims)) {
    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm((Get-FleetDeliveryAcl $operator ($dir -ceq $claims)))
    [void][IO.Directory]::CreateDirectory($dir, $security)
    Assert-FleetDeliveryAcl $dir $operator ($dir -ceq $claims)
  }
  $entry = Join-Path $FleetDeliveryRoot 'interactive.ps1'
  $temp = $entry + '.' + [Guid]::NewGuid().ToString('N')
  [IO.File]::Copy($scriptPath, $temp, $false)
  if ([IO.File]::Exists($entry)) {
    if ((Get-Item -LiteralPath $entry -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'FLEET_REINSTALL_ENTRY_CHANGED' }
    [IO.File]::Replace($temp, $entry, [NullString]::Value)
  } else { [IO.File]::Move($temp, $entry) }
  $service = New-Object -ComObject 'Schedule.Service'; $service.Connect()
  $folder = $service.GetFolder('\Clued')
  $def = $service.NewTask(0)
  $def.Principal.UserId = $operator; $def.Principal.LogonType = 3; $def.Principal.RunLevel = 0
  $def.Settings.MultipleInstances = 2; $def.Settings.ExecutionTimeLimit = 'PT0S'
  $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
  $logon = $def.Triggers.Create(9); $logon.UserId = $operator
  $unlock = $def.Triggers.Create(11); $unlock.UserId = $operator; $unlock.StateChange = 8
  $periodic = $def.Triggers.Create(1); $periodic.StartBoundary = [DateTime]::Now.ToString('s'); $periodic.Repetition.Interval = 'PT1M'
  $action = $def.Actions.Create(0); $action.Path = $FleetReinstallExecutable; $action.Arguments = $FleetReinstallArguments
  # TASK_CREATE_OR_UPDATE | TASK_DONT_ADD_PRINCIPAL_ACE
  $task = $folder.RegisterTaskDefinition($FleetReinstallTask, $def, 22, $null, $null, 3, (Get-FleetReinstallTaskSddl $operator))
  if (-not (Test-FleetReinstallTaskDefinition $task $operator)) { throw 'FLEET_REINSTALL_TASK_READBACK_MISMATCH' }
  $hash = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -cne (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'FLEET_REINSTALL_ENTRY_CHANGED' }
  $hash
}

function Read-FleetDeliveryJson([string]$file, [long]$limit = 262144) {
  $entry = Get-Item -LiteralPath $file -Force
  if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Length -lt 1 -or $entry.Length -gt $limit) {
    throw 'FLEET_REINSTALL_RECORD_REFUSED'
  }
  [IO.File]::ReadAllText($file) | ConvertFrom-Json
}

function Test-FleetInteractiveDesktop {
  if (-not ('CluedFleetInteractiveDesktop' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CluedFleetInteractiveDesktop {
    [DllImport("wtsapi32.dll", SetLastError=true)]
    static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int type, out IntPtr data, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(int flags, bool inherit, int access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr desktop, int type, StringBuilder name, int bytes, out int needed);
    public static bool Active(int session) {
        IntPtr data; int bytes;
        if (session <= 0 || !WTSQuerySessionInformationW(IntPtr.Zero,session,8,out data,out bytes)) return false;
        try { if (bytes < 4 || Marshal.ReadInt32(data) != 0) return false; }
        finally { WTSFreeMemory(data); }
        IntPtr desktop=OpenInputDesktop(0,false,1);
        if (desktop==IntPtr.Zero) return false;
        try {
            var name=new StringBuilder(256);
            return GetUserObjectInformation(desktop,2,name,512,out bytes) && name.ToString()=="Default";
        } finally { CloseDesktop(desktop); }
    }
}
'@
  }
  [CluedFleetInteractiveDesktop]::Active([Diagnostics.Process]::GetCurrentProcess().SessionId)
}

function Get-FleetReinstallDelivery([string]$operatorSid, [string]$operationId) {
  $pending = Read-FleetDeliveryJson (Join-Path $FleetDeliveryRoot 'pending.json') 16384
  $probe = Read-FleetDeliveryJson (Join-Path $FleetDeliveryRoot 'probe.json')
  $current = Read-FleetDeliveryJson (Join-Path $FleetResidentRoot 'upgrade\current.json')
  $now = [DateTimeOffset]::UtcNow
  if ($pending.contract -cne 'clued.independent-ci.fleet-reinstall/1' -or $pending.operatorSid -cne $operatorSid -or
      $pending.operationId -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
      ($operationId -and $pending.operationId -cne $operationId) -or $pending.requestSha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $pending.targetFingerprint.version -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+-]{0,88}$' -or
      ([DateTimeOffset]$pending.expiresAt) -le $now -or $probe.code -or ([DateTimeOffset]$probe.at) -gt $now -or
      ([DateTimeOffset]$probe.at).AddMinutes(10) -le $now -or
      $probe.nodeId -cne $pending.nodeId -or $probe.bindingId -cne $pending.bindingId -or $probe.bindingGeneration -ne $pending.bindingGeneration -or
      $current.generation -ne $pending.installGeneration -or $current.installReceiptSha256 -cne $pending.installReceiptSha256) {
    throw 'FLEET_REINSTALL_SUBJECT_CHANGED'
  }
  foreach ($key in @('repository','version','grant_id','receipt_id','accepted_at','request_sha256','archive_sha256','acceptance_sha256')) {
    if ($probe.fleetTarget.$key -cne $pending.targetFingerprint.$key) { throw 'FLEET_TARGET_CHANGED' }
  }
  $target = $probe.fleetTarget
  if (-not $target.PSObject.Properties['reinstall_eligible'] -or $target.reinstall_eligible -isnot [bool] -or -not $target.reinstall_eligible -or
      $probe.onDuty -ne $pending.onDuty -or
      $target.has_other_healthy -ne $pending.hasPeer -or ($probe.onDuty -and $target.has_other_healthy)) {
    throw 'FLEET_WAITING_FOR_HANDOVER'
  }
  if ([IO.File]::Exists((Join-Path $FleetResidentRoot 'state\PAUSED.json'))) { throw 'FLEET_REINSTALL_PAUSED' }
  $upgrade = Read-FleetDeliveryJson (Join-Path $FleetResidentRoot 'upgrade\status.json')
  if ($upgrade.op -and $upgrade.op.state -cnotin @('SUCCEEDED','SUCCEEDED_STILL_PAUSED','REFUSED','GRANT_REJECTED',
      'GRANT_EXPIRED','CANCELLED','STALE','ROLLED_BACK_PAUSED')) { throw 'FLEET_REINSTALL_UPGRADE_IN_PROGRESS' }
  $pending
}

function Get-FleetReinstallAssetDirectory($delivery) {
  Join-Path $FleetDeliveryRoot ($delivery.requestSha256 + '\' + $delivery.operationId + '\assets')
}

function Write-FleetOperatorRecord([string]$file, $value, [switch]$Create) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress))
  $temp = $file + '.' + [Guid]::NewGuid().ToString('N')
  try {
    $stream = [IO.FileStream]::new($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (-not $Create -and [IO.File]::Exists($file)) { [IO.File]::Replace($temp, $file, [NullString]::Value) }
    else { [IO.File]::Move($temp, $file) }
  } finally { [IO.File]::Delete($temp) }
}

function Get-FleetPreflightState([string]$operationId, [string]$code, [DateTimeOffset]$now) {
  $retry = $code -cin @('PREREQ_DOWNLOAD_RETRY_EXHAUSTED','FLEET_WAITING_FOR_IDLE','FLEET_WAITING_FOR_OWNER_SESSION','RENEW_BUSY',
    'FLEET_REINSTALL_PERMIT_TIMEOUT','FLEET_REINSTALL_PERMIT_EXPIRED','FLEET_REINSTALL_DELIVERY_EXPIRED',
    'FLEET_REINSTALL_DISK_FULL','FLEET_REINSTALL_BROKER_UNAVAILABLE')
  @{
    operationId = $operationId; phase = $(if ($retry) { 'RETRY_PREFLIGHT' } elseif ($code) { 'FAILED' } else { 'PREFLIGHT' })
    code = $code; pid = $PID; at = $now.ToString('o'); retryAt = $(if ($retry) { $now.AddMinutes(1).ToString('o') } else { $null })
  }
}

function Get-FleetPreflightDirectory([string]$parent, [string]$operationId) {
  if ($operationId -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'FLEET_REINSTALL_SUBJECT_CHANGED' }
  Join-Path $parent ('reinstall-' + $operationId)
}

function Test-FleetPreflightDue([string]$operationId) {
  $claim = Join-Path $FleetDeliveryRoot ('claims\' + $operationId)
  if ([IO.File]::Exists($claim + '.spent.json') -or [IO.File]::Exists($claim + '.launched.json')) { return $false }
  $file = $claim + '.json'
  if (-not [IO.File]::Exists($file)) { return $true }
  $state = Read-FleetDeliveryJson $file 4096
  $state.operationId -ceq $operationId -and ($state.phase -ceq 'PREFLIGHT' -or
    ($state.phase -ceq 'RETRY_PREFLIGHT' -and [DateTimeOffset]$state.retryAt -le [DateTimeOffset]::UtcNow))
}

function Remove-FleetPreflightWork([string]$parent, [string]$keepOperation, [string]$finishedOperation) {
  $longParent = '\\?\' + $parent
  if (-not [IO.Directory]::Exists($longParent) -or
      (([IO.File]::GetAttributes($longParent) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return }
  foreach ($work in [IO.Directory]::EnumerateDirectories($longParent, 'reinstall-*')) {
    if ([IO.Path]::GetFileName($work) -cnotmatch '^reinstall-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$') { continue }
    $id = $Matches[1]
    $lock = $null
    try {
      if ($id -cne $finishedOperation -and [IO.File]::Exists((Join-Path $FleetDeliveryRoot ('claims\' + $id + '.spent.json')))) { continue }
      if ($id -ceq $keepOperation -and $id -cne $finishedOperation) {
        $stateFile = Join-Path $FleetDeliveryRoot ('claims\' + $id + '.json')
        if (-not [IO.File]::Exists($stateFile) -or (Read-FleetDeliveryJson $stateFile 4096).phase -cne 'FAILED') { continue }
      }
      $file = Join-Path $FleetDeliveryRoot ('claims\' + $id + '.preflight.lock')
      $lock = [IO.File]::Open($file, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $dirs = [Collections.Generic.Queue[string]]::new()
      $dirs.Enqueue($work)
      $safe = $true
      while ($dirs.Count -and $safe) {
        $dir = $dirs.Dequeue()
        if ([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) { $safe = $false; break }
        foreach ($child in [IO.Directory]::EnumerateDirectories($dir)) { $dirs.Enqueue($child) }
      }
      if ($safe) { [IO.Directory]::Delete($work, $true) }
    } catch { } finally { if ($lock) { $lock.Dispose() } }
  }
}

function Write-FleetReinstallClaim([string]$operationId, [string]$phase, [string]$code, [switch]$Create) {
  $file = Join-Path $FleetDeliveryRoot ('claims\' + $operationId + '.json')
  $value = Get-FleetPreflightState $operationId $code ([DateTimeOffset]::UtcNow)
  if ($phase -cne 'PREFLIGHT') { $value.phase = $phase }
  Write-FleetOperatorRecord $file $value -Create:$Create
}

function Request-FleetReinstallLaunchPermit($delivery) {
  $id = $delivery.operationId
  $nonce = [Guid]::NewGuid().ToString('D')
  $assets = Split-Path -Parent (Get-FleetReinstallAssetDirectory $delivery)
  $response = Join-Path $assets 'launch-response.json'
  $permit = Join-Path $assets 'launch-permit.json'
  $claim = Join-Path $FleetDeliveryRoot ('claims\' + $id)
  if ([IO.File]::Exists($claim + '.spent.json') -or [IO.File]::Exists($claim + '.launched.json')) { throw 'FLEET_REINSTALL_ALREADY_CLAIMED' }
  Write-FleetOperatorRecord ($claim + '.launch.json') @{
    operationId = $id; nonce = $nonce; at = [DateTimeOffset]::UtcNow.ToString('o')
  }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalMinutes -lt 2) {
    if ([IO.File]::Exists($permit)) {
      $candidate = Read-FleetDeliveryJson $permit 4096
      if ($candidate.operationId -ceq $id -and $candidate.nonce -ceq $nonce) { return @{ path = $permit; nonce = $nonce } }
    }
    if ([IO.File]::Exists($response)) {
      $answer = Read-FleetDeliveryJson $response 4096
      if ($answer.operationId -ceq $id -and $answer.nonce -ceq $nonce) { throw $answer.code }
    }
    Start-Sleep -Milliseconds 200
  }
  throw 'FLEET_REINSTALL_PERMIT_TIMEOUT'
}

function Assert-FleetReinstallLaunchPermit($delivery, $request, [DateTimeOffset]$now = [DateTimeOffset]::UtcNow) {
  $permit = Read-FleetDeliveryJson $request.path 4096
  if ($permit.contract -cne 'clued.independent-ci.fleet-reinstall-launch/1' -or $permit.nonce -cne $request.nonce -or
      $permit.operationId -cne $delivery.operationId -or $permit.requestSha256 -cne $delivery.requestSha256 -or
      $permit.bindingId -cne $delivery.bindingId -or $permit.bindingGeneration -ne $delivery.bindingGeneration -or
      $permit.installReceiptSha256 -cne $delivery.installReceiptSha256 -or $permit.hasPeer -ne $delivery.hasPeer) {
    throw 'FLEET_REINSTALL_PERMIT_REFUSED'
  }
  if ([DateTimeOffset]$permit.expiresAt -le $now) { throw 'FLEET_REINSTALL_PERMIT_EXPIRED' }
}

function Invoke-FleetInteractiveReinstall {
  if ($env:CLUED_UNDER_TEST -or $env:NODE_TEST_CONTEXT) { return }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return }
  if (-not [IO.File]::Exists((Join-Path $FleetDeliveryRoot 'pending.json'))) { return }
  $pending = Read-FleetDeliveryJson (Join-Path $FleetDeliveryRoot 'pending.json') 16384
  if ($pending.operatorSid -cne $identity.User.Value) { return }
  Remove-FleetPreflightWork 'C:\ProgramData\CluedBootstrap' $pending.operationId
  $delivery = Get-FleetReinstallDelivery $identity.User.Value ''
  if (-not (Test-FleetPreflightDue $delivery.operationId) -or
      -not (Test-FleetInteractiveDesktop)) { return }
  $assets = Get-FleetReinstallAssetDirectory $delivery
  $bootstrap = Join-Path $assets ('fleet-node-' + $delivery.targetFingerprint.version + '.bootstrap.ps1')
  if ((Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash.ToLowerInvariant() -cne $delivery.bootstrapSha256) { throw 'FLEET_REINSTALL_ENTRY_CHANGED' }
  # Preflight stays unprivileged. Bootstrap claims the operation before requesting UAC.
  $child = Start-Process -FilePath $FleetDeliveryPowerShell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',
    $bootstrap,'-From',$assets,'-ReinstallOperation',$delivery.operationId) -PassThru -WindowStyle Normal
  $child.WaitForExit()
}

if ($MyInvocation.InvocationName -ne '.') {
  try { Invoke-FleetInteractiveReinstall } catch { Write-Verbose ([string]$_.Exception.Message) }
}
