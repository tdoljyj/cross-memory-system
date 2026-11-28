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
  if ($target.holder_package.maintenance -cne 'available' -or $probe.onDuty -ne $pending.onDuty -or
      $target.has_other_healthy -ne $pending.hasPeer -or ($probe.onDuty -and $target.has_other_healthy)) {
    throw 'FLEET_WAITING_FOR_HANDOVER'
  }
  if ([IO.File]::Exists((Join-Path $FleetResidentRoot 'state\PAUSED.json'))) { throw 'FLEET_REINSTALL_PAUSED' }
  if ($probe.onDuty) {
    $status = Read-FleetDeliveryJson (Join-Path $FleetResidentRoot 'state\status.json') 1MB
    $statusAt = [DateTimeOffset]$status.writtenAt
    if ($status.current -or @($status.pending).Count -or $status.halt -or $status.paused -or
        $statusAt -gt $now -or $statusAt.AddMinutes(1) -lt $now -or
        $status.executor.state -cnotin @('IDLE','COMPLETED','NOT_ADMITTED','DEFERRED')) {
      throw 'FLEET_WAITING_FOR_IDLE'
    }
  }
  $upgrade = Read-FleetDeliveryJson (Join-Path $FleetResidentRoot 'upgrade\status.json')
  if ($upgrade.op -and $upgrade.op.state -cnotin @('SUCCEEDED','SUCCEEDED_STILL_PAUSED','REFUSED','GRANT_REJECTED',
      'GRANT_EXPIRED','CANCELLED','STALE','ROLLED_BACK_PAUSED')) { throw 'FLEET_REINSTALL_UPGRADE_IN_PROGRESS' }
  $pending
}

function Get-FleetReinstallAssetDirectory($delivery) {
  Join-Path $FleetDeliveryRoot ($delivery.requestSha256 + '\' + $delivery.operationId + '\assets')
}

function Write-FleetReinstallClaim([string]$operationId, [string]$phase, [string]$code, [switch]$Create) {
  $folder = Join-Path $FleetDeliveryRoot 'claims'
  $file = Join-Path $folder ($operationId + '.json')
  $value = @{ operationId = $operationId; phase = $phase; code = $code; pid = $PID; at = [DateTimeOffset]::UtcNow.ToString('o') }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress))
  $mode = if ($Create) { [IO.FileMode]::CreateNew } else { [IO.FileMode]::Truncate }
  $stream = [IO.FileStream]::new($file, $mode, [IO.FileAccess]::Write, [IO.FileShare]::Read, 4096, [IO.FileOptions]::WriteThrough)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Invoke-FleetInteractiveReinstall {
  if ($env:CLUED_UNDER_TEST -or $env:NODE_TEST_CONTEXT) { return }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return }
  if (-not [IO.File]::Exists((Join-Path $FleetDeliveryRoot 'pending.json'))) { return }
  $delivery = Get-FleetReinstallDelivery $identity.User.Value ''
  if ([IO.File]::Exists((Join-Path $FleetDeliveryRoot ('claims\' + $delivery.operationId + '.json'))) -or
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
