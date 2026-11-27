# This file is loaded from the package tree. The destructive phases run under
# the bootstrap's machine mutex and same-operator administrator token.
$FleetResources = [ordered]@{
  ciRoot = 'C:\ProgramData\CluedIndependentCI'
  controlRoot = 'C:\ProgramData\CluedControl'
  journalRoot = 'C:\ProgramData\CluedFleetLifecycle'
  services = @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader')
  runnerPrefix = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-'
  taskPath = '\Clued\'
  tasks = @('CluedCIResidentCompanion', 'CluedCIResidentCompanionStart', 'CluedCIResidentCompanionFallback', 'CluedCIResidentCompanionWslImport', 'CluedCIResidentNotifier')
  firewallRules = @('CluedCIResident-BlockOutbound')
  account = 'clued-companion'
  controller = 'clued-control'
  machineKeys = @('Clued-CI-Node-Identity-v1', 'Clued-CI-Node-Encryption-v1')
  distribution = 'CluedResident-Linux'
  distributionDirectories = @('wsl\CluedResident-Linux', 'wsl-first-install\CluedResident-Linux')
  sharedDistribution = 'Ubuntu-24.04'
  ciDirectories = @('resident', 'first-install', 'state', 'formal-spool')
  controlEntries = @('runner', 'runner.first-install-complete')
  keptRootPattern = '^(?:resident-uninstalled-[A-Za-z0-9_-]+|reinstall-(?:carry|linux-out|progress)-[0-9a-f]{32})$'
  admissionAssets = @('secrets\ci-admission.token', 'secrets\ci-admission.connection.json')
  controlKey = 'trusted\controller-checks-app.pem'
  companionLogin = 'AppData\Local\CluedIndependentCI\companion-gh\gh\hosts.yml'
  stagedTokens = [ordered]@{
    'resident\secrets\resident-upgrade.token' = 'resident-upgrade.token'
    'resident\secrets\heartbeat\ci-node-heartbeat.token' = 'ci-node-heartbeat.token'
  }
  sharedLinuxUnits = @('clued-ci-worker@.service', 'clued-ci-archive@.service', 'clued-ci-wsprep@.service')
  sharedLinuxDirectories = @('/opt/clued-independent-ci', '/etc/clued-independent-ci', '/var/lib/clued-independent-ci')
}

function Get-FleetServices {
  $runner = $FleetResources.runnerPrefix + [Environment]::MachineName.ToLowerInvariant()
  @(Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object { $_.Name -iin $FleetResources.services -or $_.Name -ieq $runner })
}

function Get-FleetTasks {
  @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -ieq $FleetResources.taskPath -and $_.TaskName -iin $FleetResources.tasks })
}

function Test-FleetUpgradeInProgress($answer) {
  $id = [guid]::Empty
  $at = [DateTimeOffset]::MinValue
  if (-not [guid]::TryParse([string]$answer.op.opId, [ref]$id) -or
      -not [DateTimeOffset]::TryParse([string]$answer['statusAt'], [ref]$at) -or
      [Math]::Abs(([DateTimeOffset]::UtcNow - $at).TotalMinutes) -gt 5) { return $false }
  @(Get-FleetServices | Where-Object { $_.Name -ieq 'CluedCIUpgrader' -and $_.State -ieq 'Running' -and $_.ProcessId -gt 0 }).Count -eq 1
}

function Get-FleetFirewallRules {
  @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Name -iin $FleetResources.firewallRules })
}

function Assert-FleetServiceOwnership($service) {
  $root = Join-Path $FleetResources.ciRoot 'resident'
  $image = if ($service.PathName -match '^\s*"([^"]+\.exe)"(?:\s|$)|^\s*([^\s"]+\.exe)(?:\s|$)') {
    if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
  }
  if (-not $image) { throw 'FLEET_SERVICE_IMAGE_REFUSED' }
  Assert-FleetLocalPath $image
  $allowed = $image.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
  if ($service.Name -ilike ($FleetResources.runnerPrefix + '*')) {
    $allowed = $allowed -or $image -ieq (Join-Path $FleetResources.controlRoot 'runner\bin\RunnerService.exe')
  }
  if (-not $allowed -or [IO.Path]::GetFullPath($image) -ine $image) { throw 'FLEET_SERVICE_IMAGE_REFUSED' }
}

function Assert-FleetWindowsWritersStopped {
  if (@(Get-FleetServices | Where-Object { $_.State -ine 'Stopped' -or $_.ProcessId -ne 0 }).Count -or
      @(Get-FleetTasks | Where-Object { $_.State -ine 'Disabled' }).Count) { throw 'FLEET_WINDOWS_WRITERS_NOT_STOPPED' }
  $prefix = Join-Path $FleetResources.ciRoot 'resident\'
  $runner = Join-Path $FleetResources.controlRoot 'runner\'
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    $image = [string]$process.ExecutablePath
    $command = [string]$process.CommandLine
    if ($image.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $image.StartsWith($runner, [StringComparison]::OrdinalIgnoreCase) -or
        $command.IndexOf($prefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $command.IndexOf($runner, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      throw 'FLEET_WINDOWS_PRODUCT_PROCESS_STILL_PRESENT'
    }
  }
}

function Stop-FleetWindowsWriters {
  $services = @(Get-FleetServices)
  foreach ($service in $services) { Assert-FleetServiceOwnership $service }
  foreach ($task in @(Get-FleetTasks)) {
    # The exact task names live in the product's reserved Scheduler folder.
    $wasRunning = $task.State -iin @('Running','Queued')
    Disable-ScheduledTask -InputObject $task -ErrorAction Stop | Out-Null
    if ($wasRunning) { Stop-ScheduledTask -InputObject $task -ErrorAction Stop }
  }
  foreach ($service in $services) {
    Set-Service -Name $service.Name -StartupType Disabled -ErrorAction Stop
    if ($service.State -ine 'Stopped') {
      Stop-Service -Name $service.Name -ErrorAction Stop
    }
  }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  do {
    try { Assert-FleetWindowsWritersStopped; return }
    catch {
      if ($clock.Elapsed.TotalSeconds -ge 120) { throw }
      Start-Sleep -Seconds 1
    }
  } while ($true)
}

function Remove-FleetWindowsRegistrations {
  Assert-FleetWindowsWritersStopped
  foreach ($task in @(Get-FleetTasks)) { Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop }
  foreach ($service in @(Get-FleetServices)) {
    Assert-FleetServiceOwnership $service
    Remove-FleetServiceRegistration $service.Name
  }
  foreach ($rule in @(Get-FleetFirewallRules)) {
    $filter = @($rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
    if ($filter.Count -ne 1 -or $filter[0].Service -ine $FleetResources.services[0]) { throw 'FLEET_FIREWALL_OWNERSHIP_REFUSED' }
    Disable-NetFirewallRule -InputObject $rule -ErrorAction Stop | Out-Null
    Remove-NetFirewallRule -InputObject $rule -ErrorAction Stop
  }
  if (@(Get-FleetTasks).Count -or @(Get-FleetServices).Count -or @(Get-FleetFirewallRules).Count) { throw 'FLEET_WINDOWS_REGISTRATION_STILL_PRESENT' }
}

function Remove-FleetServiceRegistration([string]$name) {
  $null = & 'C:\Windows\System32\sc.exe' delete $name 2>&1
  if ($LASTEXITCODE -notin @(0,1060,1072)) { throw 'FLEET_SERVICE_DELETE_FAILED' }
}

function Get-FleetLifecycleMode([string]$action, $facts, $progress) {
  if ($null -ne $progress) { return 'Resume' }
  if ($action -ceq 'Rollback' -or $action -ceq 'Retire') { return $action }
  if (@($facts.residue).Count) { return 'InspectUpgrade' }
  if ($facts.complete -eq $true) { return 'Fresh' }
  'Probe'
}

function New-FleetProgress($context, [string]$mode) {
  $value = [ordered]@{ contract = 'clued.fleet.lifecycle-progress/1'; operationId = [guid]::NewGuid().ToString('N'); mode = $mode; step = 'intent' }
  foreach ($key in @('machine','operatorSid','archiveSha256','acceptanceSha256','action')) { $value[$key] = $context[$key] }
  $value
}

# Directory visibility is a routing hint. Only the elevated, locked reader
# can decide whether there is a valid operation for this exact package.
function Test-FleetProgressHint {
  $root = $FleetResources.journalRoot
  @(Get-ChildItem -LiteralPath (Split-Path -Parent $root) -Directory -Force -Filter (Split-Path -Leaf $root) -ErrorAction Stop).Count -eq 1
}

# All wire details are provisional and live here. The transport and clock
# parameters are used only by the offline fixture; the bootstrap passes neither.
function Invoke-FleetMaintenance([ValidateSet('preview','before-remove','before-return')][string]$Phase, $Context,
    [scriptblock]$Send, [scriptblock]$Wait = { Start-Sleep -Seconds 5 }, [scriptblock]$Now = { [DateTimeOffset]::UtcNow }) {
  $unavailable = @{ ok = $false; code = 'FLEET_MAINTENANCE_INTERFACE_UNAVAILABLE' }
  if (-not $Context['repository']) { return $unavailable }
  if ($null -eq $Send) {
    if ($Context.action -cne 'Install') { return $unavailable }
    $Send = {
      param($request)
      $key = $null; $signer = $null
      try {
        foreach ($provider in @([Security.Cryptography.CngProvider]::new('Microsoft Platform Crypto Provider'), [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider)) {
          $name = $FleetResources.machineKeys[0]
          if ([Security.Cryptography.CngKey]::Exists($name, $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey)) {
            if ($null -ne $key) { throw 'FLEET_MAINTENANCE_IDENTITY_AMBIGUOUS' }
            $key = [Security.Cryptography.CngKey]::Open($name, $provider, [Security.Cryptography.CngKeyOpenOptions]::MachineKey)
          }
        }
        if ($null -eq $key) { return @{ ok = $false; code = 'FLEET_MAINTENANCE_IDENTITY_UNAVAILABLE' } }
        $signer = [Security.Cryptography.ECDsaCng]::new($key)
        $signer.HashAlgorithm = [Security.Cryptography.CngAlgorithm]::Sha256
        $request['identityPublicKey'] = [Convert]::ToBase64String($key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob))
        $payload = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 8 -Compress))
        $body = @{ payload = [Convert]::ToBase64String($payload); signature = [Convert]::ToBase64String($signer.SignData($payload)) } | ConvertTo-Json -Compress
        try {
          $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'https://kooyomi.pixelgrav.com/v1/ci/node/fleet-maintenance' -ContentType 'application/json' -Body $body -TimeoutSec 20 -MaximumRedirection 0 -ErrorAction Stop
        } catch {
          $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
          if ($status -in @(404,405,501)) { return $unavailable }
          return @{ ok = $false; code = 'FLEET_MAINTENANCE_REQUEST_FAILED' }
        }
        if ($response.Content.Length -gt 32768) { return @{ ok = $false; code = 'FLEET_MAINTENANCE_REPLY_REFUSED' } }
        (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($response.Content)
      } catch { @{ ok = $false; code = 'FLEET_MAINTENANCE_IDENTITY_OR_REPLY_REFUSED' } }
      finally { if ($signer) { $signer.Dispose() }; if ($key) { $key.Dispose() } }
    }
  }
  $deadline = (& $Now).AddMinutes(45)
  $pendingState = if ($Phase -ceq 'before-return') { 'verifying' } else { 'draining' }
  do {
    $request = [ordered]@{
      contract = 'clued.fleet.maintenance/1'; phase = $Phase; nonce = [Guid]::NewGuid().ToString('N')
      at = (& $Now).ToUniversalTime().ToString('o')
    }
    foreach ($key in @('repository','version','archiveSha256','acceptanceSha256','sourceSha256','machine','operatorSid','action','operationId',
        'previewReceipt','ownerUac','zeroNodeConsent','bindingId','bindingGeneration','installed')) {
      if ($Context.Contains($key)) { $request[$key] = $Context[$key] }
    }
    $reply = & $Send $request
    if ($reply -isnot [Collections.IDictionary] -or $reply['ok'] -isnot [bool] -or -not $reply['ok']) {
      $code = if ($reply -is [Collections.IDictionary]) { [string]$reply['code'] } else { '' }
      if ($code -cnotmatch '^FLEET_[A-Z0-9_]{1,90}$') { $code = 'FLEET_MAINTENANCE_REPLY_REFUSED' }
      return @{ ok = $false; code = $code }
    }
    if ($reply['nonce'] -cne $request.nonce -or $reply['archiveSha256'] -cne $Context.archiveSha256 -or
        $reply['acceptanceSha256'] -cne $Context.acceptanceSha256 -or $reply['sourceSha256'] -cne $Context.sourceSha256 -or
        $reply['sealed'] -isnot [bool] -or -not $reply['sealed'] -or ($Phase -cne 'preview' -and $reply['operationId'] -cne $Context.operationId)) {
      return @{ ok = $false; code = 'FLEET_MAINTENANCE_SUBJECT_REFUSED' }
    }
    if ($Phase -ceq 'preview') { return $reply }
    if ($reply['bindingId'] -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
        ($reply['bindingGeneration'] -isnot [int] -and $reply['bindingGeneration'] -isnot [long]) -or $reply['bindingGeneration'] -lt 1 -or
        ($Context['bindingId'] -and ($reply['bindingId'] -cne $Context.bindingId -or $reply['bindingGeneration'] -ne $Context.bindingGeneration))) {
      return @{ ok = $false; code = 'FLEET_MAINTENANCE_BINDING_REFUSED' }
    }
    if ($reply['state'] -cne $pendingState) {
      if ($Phase -ceq 'before-remove' -and ($reply['state'] -cne 'removed' -or $reply['noNewWork'] -isnot [bool] -or -not $reply['noNewWork'] -or
          $reply['zeroNodes'] -isnot [bool] -or ($reply['zeroNodes'] -and (
            $reply['zeroNodeConsentAccepted'] -isnot [bool] -or -not $reply['zeroNodeConsentAccepted'] -or -not $Context['zeroNodeConsent'])))) {
        return @{ ok = $false; code = 'FLEET_MAINTENANCE_NOT_SAFE_TO_REMOVE' }
      }
      if ($Phase -ceq 'before-return') {
        foreach ($flag in @('restored','connectionUsable','freshHeartbeat','healthy')) {
          if ($reply[$flag] -isnot [bool] -or -not $reply[$flag]) { return @{ ok = $false; code = 'FLEET_MAINTENANCE_NOT_RESTORED' } }
        }
        if ($reply['state'] -cne 'restored' -or $reply['role'] -cne 'STANDBY') { return @{ ok = $false; code = 'FLEET_MAINTENANCE_NOT_RESTORED' } }
      }
      return $reply
    }
    if ($Phase -ceq 'before-return') {
      $started = [DateTimeOffset]::MinValue
      if (-not [DateTimeOffset]::TryParse($reply['verificationStartedAt'], [ref]$started) -or $started -gt (& $Now)) {
        return @{ ok = $false; code = 'FLEET_MAINTENANCE_VERIFY_CLOCK_REFUSED' }
      }
      $serverDeadline = $started.AddMinutes(45)
      if ($serverDeadline -lt $deadline) { $deadline = $serverDeadline }
    }
    if ((& $Now) -ge $deadline) { break }
    & $Wait
  } while ($true)
  @{ ok = $false; code = $(if ($Phase -ceq 'before-return') { 'FLEET_MAINTENANCE_VERIFY_TIMEOUT' } else { 'FLEET_MAINTENANCE_DRAIN_TIMEOUT' }) }
}

function New-FleetContext([string]$acceptanceFile, [string]$archiveSha256, [string]$operatorSid, [string]$action) {
  $acceptance = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText($acceptanceFile))
  if ($acceptance['archive_sha256'] -cne $archiveSha256 -or $acceptance['ciSourceManifestSha256'] -cnotmatch '^[0-9a-f]{64}$' -or
      $acceptance['repository'] -cnotmatch '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$') { throw 'FLEET_TARGET_REFUSED' }
  @{
    repository = $acceptance['repository']; version = $acceptance['version']; commit = $acceptance['commit']; archiveSha256 = $archiveSha256
    acceptanceSha256 = Sha256File $acceptanceFile; sourceSha256 = $acceptance['ciSourceManifestSha256']
    machine = [Environment]::MachineName.ToUpperInvariant(); operatorSid = $operatorSid; action = $action
  }
}

function Assert-FleetPreview($preview, $context) {
  if ($preview['archiveSha256'] -cne $context.archiveSha256 -or $preview['acceptanceSha256'] -cne $context.acceptanceSha256 -or
      $preview['sealed'] -ne $true -or ($context.action -ceq 'Rollback' -and $preview['previous'] -ne $true) -or
      $preview['healthyPeers'] -isnot [int] -or $preview['healthyPeers'] -lt 0 -or
      $preview['estimatedMinutes'] -isnot [int] -or $preview['estimatedMinutes'] -lt 1 -or $preview['estimatedMinutes'] -gt 1440 -or
      $preview['previewReceipt'] -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$') { throw 'FLEET_MAINTENANCE_PREVIEW_REFUSED' }
}

function Get-FleetPathItem([string]$path) {
  try { Get-Item -LiteralPath $path -Force -ErrorAction Stop }
  catch [Management.Automation.ItemNotFoundException] { $null }
}

function Assert-FleetLocalPath([string]$path) {
  $original = $path
  for (; $path; $path = [IO.Path]::GetDirectoryName($path)) {
    $item = Get-FleetPathItem $path
    if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw ('FLEET_RESOURCE_REPARSE_POINT:' + $original)
    }
    if ($path -eq [IO.Path]::GetPathRoot($path)) { break }
  }
}

function Assert-FleetJournalRoot([string]$root) {
  Assert-FleetLocalPath $root
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  [void][IO.Directory]::CreateDirectory($root, $security)
  $actual = Get-Acl -LiteralPath $root
  $writers = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin @('S-1-5-18','S-1-5-32-544') -or
      $writers.Count -ne 2 -or @($writers | Where-Object { $_.IdentityReference.Value -cnotin @('S-1-5-18','S-1-5-32-544') -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' }).Count) {
    throw 'FLEET_JOURNAL_ACL_REFUSED'
  }
}

function Get-FleetProfileDirectory([string]$sid) {
  $profile = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(
    ('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid))
  if ($null -eq $profile) { return }
  try {
    $path = $profile.GetValue('ProfileImagePath')
    if ($path -isnot [string] -or $path -notmatch '^[A-Z]:\\') { throw 'FLEET_WSL_OWNER_PROFILE_REFUSED' }
    $path
  } finally { $profile.Dispose() }
}

function Get-FleetWslRegistryRows([string]$sid) {
  $owner = [Microsoft.Win32.Registry]::Users.OpenSubKey($sid)
  $mount = $null
  if ($null -eq $owner) {
    $profile = Get-FleetProfileDirectory $sid
    if (-not $profile) { return }
    $hive = Join-Path $profile 'NTUSER.DAT'
    Assert-FleetLocalPath $hive
    if ($null -eq (Get-FleetPathItem $hive)) { throw 'FLEET_WSL_OWNER_HIVE_UNAVAILABLE' }
    $mount = 'CluedFleet-' + [Guid]::NewGuid().ToString('N')
    $reg = 'C:\Windows\System32\reg.exe'
    $null = & $reg load ('HKU\' + $mount) $hive 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'FLEET_WSL_OWNER_HIVE_UNAVAILABLE' }
    $owner = [Microsoft.Win32.Registry]::Users.OpenSubKey($mount)
  }
  try {
    if ($null -eq $owner) { throw 'FLEET_WSL_OWNER_HIVE_UNAVAILABLE' }
    $lxss = $owner.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Lxss')
    if ($null -eq $lxss) { return }
    try {
      foreach ($id in $lxss.GetSubKeyNames()) {
        $key = $lxss.OpenSubKey($id)
        if ($null -eq $key) { throw 'FLEET_WSL_REGISTRATION_CHANGED' }
        try { @{ id = $id; name = $key.GetValue('DistributionName'); basePath = $key.GetValue('BasePath') } }
        finally { $key.Dispose() }
      }
    } finally { $lxss.Dispose() }
  } finally {
    if ($null -ne $owner) { $owner.Dispose() }
    if ($mount) {
      $null = & $reg unload ('HKU\' + $mount) 2>&1
      if ($LASTEXITCODE -ne 0) { throw 'FLEET_WSL_OWNER_HIVE_NOT_UNLOADED' }
    }
  }
}

function Get-FleetWslInventory([string]$sid, [string]$profileDirectory) {
  if ($sid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw 'FLEET_WSL_OWNER_SID_REFUSED' }
  $dedicated = @($FleetResources.distributionDirectories | ForEach-Object { Join-Path $FleetResources.ciRoot $_ })
  if ($profileDirectory) { $dedicated += Join-Path $profileDirectory ('WSL\' + $FleetResources.distribution) }
  $seen = @{}
  foreach ($row in @(Get-FleetWslRegistryRows $sid)) {
    if ($row.name -ine $FleetResources.distribution -and $row.name -ine $FleetResources.sharedDistribution) { continue }
    $id = [guid]::Empty
    if (-not [guid]::TryParseExact($row.id, 'B', [ref]$id) -or $seen.ContainsKey($row.name)) { throw 'FLEET_WSL_REGISTRATION_REFUSED' }
    $seen[$row.name] = $true
    $path = [string]$row.basePath
    if ($path.StartsWith('\\?\', [StringComparison]::Ordinal)) { $path = $path.Substring(4) }
    if ($path -notmatch '^[A-Z]:\\[^:*?"<>|]+$' -or $path.Split('\') -contains '..' -or $path.Split('\') -contains '.') {
      throw 'FLEET_WSL_REGISTRATION_PATH_REFUSED'
    }
    $path = [IO.Path]::GetFullPath($path).TrimEnd('\')
    $kind = if ($row.name -ieq $FleetResources.distribution) {
      if ($dedicated -inotcontains $path) { throw 'FLEET_WSL_REGISTRATION_PATH_REFUSED' }
      'dedicated'
    } else { 'shared-candidate' }
    @{ id = $id.ToString('B'); ownerSid = $sid; name = $row.name; basePath = $path; kind = $kind }
  }
}

function New-FleetSharedLinuxCommand([bool]$remove) {
  $units = $FleetResources.sharedLinuxUnits -join ' '
  $paths = $FleetResources.sharedLinuxDirectories -join ' '
  $script = @'
set -euo pipefail
units=(__UNITS__)
paths=(__PATHS__)
patterns=()
for unit in "${units[@]}"; do patterns+=("$unit" "${unit/@./@*.}"); done
loaded=$(systemctl list-units --all --no-legend --plain --no-pager "${patterns[@]}")
mapfile -t instances < <(printf '%s\n' "$loaded" | awk 'NF {print $1}')
for unit in "${instances[@]}"; do
  case "$unit" in clued-ci-worker@*.service|clued-ci-archive@*.service|clued-ci-wsprep@*.service) ;; *) exit 12 ;; esac
done
if (( __REMOVE__ )); then
  for unit in "${instances[@]}"; do systemctl stop "$unit"; done
  for unit in "${instances[@]}"; do
    state=$(systemctl show -p ActiveState --value "$unit")
    pid=$(systemctl show -p MainPID --value "$unit")
    [[ "$state" == inactive || "$state" == failed ]] && [[ "$pid" == 0 ]] || exit 13
    systemctl disable "$unit"
  done
  for unit in "${units[@]}"; do
    file="/etc/systemd/system/$unit"
    if [[ -e "$file" || -L "$file" ]]; then systemctl disable "$unit"; rm -f -- "$file"; fi
  done
  systemctl daemon-reload
  mounts=$(findmnt -ln -o TARGET)
  for path in "${paths[@]}"; do
    for mount in $mounts; do
      [[ "$mount" != "$path" && "$mount" != "$path/"* ]] || exit 14
    done
    rm -rf --one-file-system -- "$path"
  done
else
  for unit in "${instances[@]}"; do
    state=$(systemctl show -p ActiveState --value "$unit")
    pid=$(systemctl show -p MainPID --value "$unit")
    [[ "$state" == inactive || "$state" == failed ]] && [[ "$pid" == 0 ]] || exit 10
  done
fi
files=$(systemctl list-unit-files --no-legend --no-pager "${patterns[@]}")
[[ -z "$files" ]] || exit 10
for unit in "${units[@]}"; do paths+=("/etc/systemd/system/$unit"); done
for path in "${paths[@]}"; do [[ ! -e "$path" && ! -L "$path" ]] || exit 10; done
exit 0
'@
  $mode = if ($remove) { '1' } else { '0' }
  $script = $script.Replace('__UNITS__', $units).Replace('__PATHS__', $paths).Replace('__REMOVE__', $mode).Replace([string][char]13, '')
  'echo ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script)) + ' | base64 -d | /bin/bash'
}

# Bind the current Windows SID and the exact Lxss registration in the child.
function Invoke-FleetOwnedWsl($row, [ValidateSet('probe','remove')][string]$mode, [string]$operationId) {
  $base = "'" + $row.basePath.Replace("'", "''") + "'"
  $native = if ($row.kind -ceq 'shared-candidate') {
    $linux = New-FleetSharedLinuxCommand ($mode -ceq 'remove')
    '& $wsl --distribution $name --user root --exec /bin/sh -c ''' + $linux + ''' *> $null; exit $LASTEXITCODE'
  } else {
    @'
$list = & $wsl --list --running --quiet 2>$null
if ($LASTEXITCODE -ne 0) { exit 11 }
$running = @($list | ForEach-Object { ([string]$_).Replace([string][char]0, '').Trim() })
if ($running -icontains $name) {
  & $wsl --terminate $name *> $null
  if ($LASTEXITCODE -ne 0) { exit 11 }
  $list = & $wsl --list --running --quiet 2>$null
  if ($LASTEXITCODE -ne 0 -or @($list | ForEach-Object { ([string]$_).Replace([string][char]0, '').Trim() }) -icontains $name) { exit 11 }
}
& $wsl --unregister $name *> $null
exit $LASTEXITCODE
'@
  }
  $command = @'
$ErrorActionPreference = 'Stop'
try {
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne '__SID__') { exit 11 }
  $name = '__NAME__'
  $key = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss\__ID__'
  $registered = ([string]$key.BasePath) -replace '^\\\\\?\\',''
  if ($key.DistributionName -ine $name -or [IO.Path]::GetFullPath($registered).TrimEnd('\') -ine __BASE__) { exit 11 }
  $wsl = 'C:\Windows\System32\wsl.exe'
  __NATIVE__
} catch { exit 11 }
'@
  $command = $command.Replace('__SID__', $row.ownerSid).Replace('__NAME__', $row.name).Replace('__ID__', $row.id).Replace('__BASE__', $base).Replace('__NATIVE__', $native)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = '-NoProfile -NonInteractive -EncodedCommand ' + $encoded
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($current -ceq $row.ownerSid) {
    $p = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    try {
      if (-not $p.WaitForExit(300000)) { $p.Kill(); throw 'FLEET_WSL_CLEANUP_TIMEOUT' }
      return $p.ExitCode
    } finally { $p.Dispose() }
  }
  $companion = Get-LocalUser -Name $FleetResources.account -ErrorAction Stop
  if ($companion.SID.Value -cne $row.ownerSid) { throw 'FLEET_WSL_OWNER_SID_REFUSED' }
  if ($operationId -cnotmatch '^[0-9a-f]{32}$') { throw 'FLEET_OPERATION_ID_REFUSED' }
  $taskName = 'CluedFleetWsl-' + $operationId + '-' + ([Guid]$row.id).ToString('N') + '-' + $mode
  $principal = New-ScheduledTaskPrincipal -UserId $row.ownerSid -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([timespan]::FromMinutes(5)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
  $existing = @(Get-FleetWslScratchTasks $operationId | Where-Object { $_.TaskName -ceq $taskName })
  if ($existing.Count) {
    if ($existing.Count -ne 1 -or @($existing[0].Actions).Count -ne 1 -or $existing[0].Actions[0].Execute -ine $powershell -or
        $existing[0].Actions[0].Arguments -cne $arguments -or $existing[0].Principal.LogonType -ne 'S4U') { throw 'FLEET_WSL_TASK_REFUSED' }
    Wait-FleetWslScratchTask $existing[0]
    Unregister-ScheduledTask -InputObject $existing[0] -Confirm:$false -ErrorAction Stop
  }
  $null = Register-ScheduledTask -TaskPath '\' -TaskName $taskName -Action $action -Principal $principal -Settings $settings -ErrorAction Stop
  try {
    $before = (Get-ScheduledTaskInfo -TaskPath '\' -TaskName $taskName -ErrorAction Stop).LastRunTime
    Start-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
      Start-Sleep -Milliseconds 500
      $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
      $info = Get-ScheduledTaskInfo -TaskPath '\' -TaskName $taskName -ErrorAction Stop
      if ($task.State -eq 'Ready' -and $info.LastRunTime -ne $before) { return $info.LastTaskResult }
    } while ($clock.Elapsed.TotalSeconds -lt 300)
    throw 'FLEET_WSL_CLEANUP_TIMEOUT'
  } finally {
    $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction Stop
    if ($task.State -in @('Running','Queued')) { Stop-ScheduledTask -InputObject $task -ErrorAction Stop }
    Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop
  }
}

function Get-FleetWslScratchTasks([string]$operationId) {
  if ($operationId -cnotmatch '^[0-9a-f]{32}$') { return }
  Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -ceq '\' -and $_.TaskName -cmatch ('^CluedFleetWsl-' + $operationId + '-[0-9a-f]{32}-(?:probe|remove)$') }
}

function Wait-FleetWslScratchTask($task) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($task.State -in @('Running','Queued')) {
    if ($clock.Elapsed.TotalSeconds -ge 300) { throw 'FLEET_WSL_SCRATCH_TASK_STILL_RUNNING' }
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $task.TaskName -TaskPath '\' -ErrorAction Stop
  }
}

function Clear-FleetWslScratchTasks([string]$operationId) {
  foreach ($task in @(Get-FleetWslScratchTasks $operationId)) {
    if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -or
        $task.Actions[0].Arguments -cnotmatch '^-NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+=*$' -or
        $task.Principal.LogonType -ne 'S4U') { throw 'FLEET_WSL_TASK_REFUSED' }
    Wait-FleetWslScratchTask $task
    Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction Stop
  }
  if (@(Get-FleetWslScratchTasks $operationId).Count) { throw 'FLEET_WSL_SCRATCH_TASK_STILL_PRESENT' }
}

function Get-FleetSharedWslState($rows, [string]$operationId) {
  foreach ($row in @($rows | Where-Object { $_.kind -ceq 'shared-candidate' })) {
    $code = Invoke-FleetOwnedWsl $row 'probe' $operationId
    if ($code -eq 10) { return 'pending' }
    if ($code -ne 0) { throw 'FLEET_SHARED_WSL_READBACK_REFUSED' }
  }
  'complete'
}

function Remove-FleetWslProducts($rows, [string]$operationId) {
  foreach ($row in $rows) {
    Assert-FleetLocalPath $row.basePath
    $code = Invoke-FleetOwnedWsl $row 'remove' $operationId
    if ($code -ne 0) { throw 'FLEET_WSL_CLEANUP_REFUSED' }
    $after = @(Get-FleetWslInventory $row.ownerSid (Get-FleetProfileDirectory $row.ownerSid) | Where-Object { $_.name -ieq $row.name })
    if ($row.kind -ceq 'dedicated') {
      if ($after.Count -or (Get-FleetPathItem (Join-Path $row.basePath 'ext4.vhdx'))) { throw 'FLEET_DEDICATED_WSL_STILL_PRESENT' }
    } elseif ($after.Count -ne 1 -or $after[0].id -cne $row.id -or $after[0].basePath -ine $row.basePath) {
      throw 'FLEET_SHARED_WSL_REGISTRATION_CHANGED'
    }
  }
}

# A denied or unreadable observation may never classify a host as clean.
function Get-FleetInventory {
  $residue = [Collections.Generic.List[string]]::new()
  $unknown = [Collections.Generic.List[string]]::new()
  $wsl = @()
  try {
    foreach ($service in @(Get-FleetServices)) {
      $residue.Add('service:' + $service.Name)
    }
  } catch { $unknown.Add('services') }
  $paths = @($FleetResources.ciRoot) + @($FleetResources.controlEntries + @($FleetResources.controlKey) | ForEach-Object { Join-Path $FleetResources.controlRoot $_ })
  foreach ($root in $paths) {
    try {
      Assert-FleetLocalPath $root
      if ($null -ne (Get-FleetPathItem $root)) { $residue.Add('directory:' + $root) }
    } catch { $unknown.Add('directory:' + $root) }
  }
  try {
    $operator = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $wsl += @(Get-FleetWslInventory $operator (Get-FleetProfileDirectory $operator))
  } catch { $unknown.Add('operator-wsl') }
  try {
    $tasks = @(Get-FleetTasks)
    foreach ($task in $tasks) { $residue.Add('task:' + $task.TaskName) }
  } catch { $unknown.Add('tasks') }
  try {
    $rules = @(Get-FleetFirewallRules)
    foreach ($rule in $rules) { $residue.Add('firewall:' + $rule.Name) }
  } catch { $unknown.Add('firewall') }
  try {
    foreach ($account in @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -iin @($FleetResources.account,$FleetResources.controller) })) {
      $residue.Add('account:' + $account.Name)
      if ($account.Name -ieq $FleetResources.account) {
        try { $wsl += @(Get-FleetWslInventory $account.SID.Value (Get-FleetProfileDirectory $account.SID.Value)) }
        catch { $unknown.Add('companion-wsl') }
      }
    }
  } catch { $unknown.Add('accounts') }
  foreach ($registration in $wsl) {
    if ($registration.kind -ceq 'dedicated') { $residue.Add('wsl:' + $registration.ownerSid + ':' + $registration.name) }
  }
  @{ complete = $unknown.Count -eq 0; residue = $residue.ToArray(); unknown = $unknown.ToArray(); wsl = $wsl }
}

function Test-FleetOldConnectionSidecar {
  $null -ne (Get-FleetPathItem (Join-Path $FleetResources.ciRoot $FleetResources.admissionAssets[1]))
}

# Collect only paths with reserved product names. Refuse nested links before
# deleting anything, including a link in a historical kept root.
function Get-FleetProductPaths {
  $root = $FleetResources.ciRoot
  Assert-FleetLocalPath $root
  $kept = if ($null -ne (Get-FleetPathItem $root)) {
    @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop | Where-Object { $_.Name -cmatch $FleetResources.keptRootPattern } | ForEach-Object FullName)
  } else { @() }
  $paths = @($FleetResources.ciDirectories + $FleetResources.distributionDirectories | ForEach-Object { Join-Path $root $_ }) +
    @($FleetResources.controlEntries | ForEach-Object { Join-Path $FleetResources.controlRoot $_ }) + @($kept)
  foreach ($path in $paths) {
    Assert-FleetLocalPath $path
    $item = Get-FleetPathItem $path
    if ($null -eq $item) { continue }
    if ($item.PSIsContainer) {
      $stack = [Collections.Generic.Stack[string]]::new()
      $stack.Push($path)
      while ($stack.Count) {
        foreach ($child in @(Get-ChildItem -LiteralPath $stack.Pop() -Force -ErrorAction Stop)) {
          if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('FLEET_RESOURCE_REPARSE_POINT:' + $child.FullName) }
          if ($child.PSIsContainer) { $stack.Push($child.FullName) }
        }
      }
    }
    $path
  }
}

function Remove-FleetProductPaths {
  $paths = @(Get-FleetProductPaths)
  foreach ($path in $paths) {
    Assert-FleetLocalPath $path
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
    if ($null -ne (Get-FleetPathItem $path)) { throw ('FLEET_PRODUCT_PATH_STILL_PRESENT:' + $path) }
  }
}

function Get-FleetResidentSid {
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try { $bytes = $sha1.ComputeHash([Text.Encoding]::Unicode.GetBytes($FleetResources.services[0].ToUpperInvariant())) }
  finally { $sha1.Dispose() }
  'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($bytes, $_ * 4) }) -join '-')
}

function Test-FleetResidentRootAce {
  $root = $FleetResources.ciRoot
  Assert-FleetLocalPath $root
  if ($null -eq (Get-FleetPathItem $root)) { return $false }
  $sid = Get-FleetResidentSid
  $acl = Get-Acl -LiteralPath $root -ErrorAction Stop
  @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -ceq $sid }).Count -gt 0
}

function Remove-FleetResidentRootAce {
  if (-not (Test-FleetResidentRootAce)) { return }
  $root = $FleetResources.ciRoot
  $sid = Get-FleetResidentSid
  $acl = Get-Acl -LiteralPath $root -ErrorAction Stop
  foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -ceq $sid })) {
    if ($rule.IsInherited) { throw 'FLEET_RESIDENT_ACE_INHERITED' }
    $acl.RemoveAccessRuleSpecific($rule)
  }
  Set-Acl -LiteralPath $root -AclObject $acl -ErrorAction Stop
  if (Test-FleetResidentRootAce) { throw 'FLEET_RESIDENT_ACE_STILL_PRESENT' }
}

function Get-FleetCarryDirectory($context) {
  if ($context.operationId -cnotmatch '^[0-9a-f]{32}$') { throw 'FLEET_OPERATION_ID_REFUSED' }
  Join-Path $FleetResources.journalRoot ('connection-' + $context.operationId)
}

function Get-FleetConnectionCarrier([string]$path) {
  Assert-FleetLocalPath $path
  $item = Get-FleetPathItem $path
  if ($null -ne $item -and ($item.PSIsContainer -or $item.LinkType -or $item.Length -lt 1 -or $item.Length -gt 65536)) {
    throw 'FLEET_CONNECTION_CARRIER_REFUSED'
  }
  $item
}

function Save-FleetConnectionCarriers($context) {
  $carry = Get-FleetCarryDirectory $context
  Assert-FleetJournalRoot $carry
  # The two native secrets outside the resident stay in place. Only the
  # per-resident carriers need opaque copies before the directory is removed.
  foreach ($path in @((Join-Path $FleetResources.ciRoot $FleetResources.admissionAssets[0]), (Join-Path $FleetResources.controlRoot $FleetResources.controlKey))) {
    if ($null -eq (Get-FleetConnectionCarrier $path)) { throw 'FLEET_REQUIRED_CONNECTION_CARRIER_MISSING' }
  }
  foreach ($relative in $FleetResources.stagedTokens.Keys) {
    $name = $FleetResources.stagedTokens[$relative]
    $target = Join-Path $carry $name
    if (Get-FleetConnectionCarrier $target) { continue }
    $source = Get-FleetConnectionCarrier (Join-Path $FleetResources.ciRoot $relative)
    if ($null -eq $source) { $source = Get-FleetConnectionCarrier (Join-Path $FleetResources.ciRoot ('first-install\credentials\' + $name)) }
    if ($null -eq $source) {
      if ($name -ceq 'resident-upgrade.token' -or $null -ne $context.maintenance.connection['heartbeatToken']) { throw 'FLEET_REQUIRED_CONNECTION_CARRIER_MISSING' }
      continue
    }
    # Move through a private pending name so a terminated Copy cannot become
    # the next attempt's accepted carrier.
    $pending = $target + '.pending'
    Assert-FleetLocalPath $pending
    [IO.File]::Delete($pending)
    [IO.File]::Copy($source.FullName, $pending, $false)
    [IO.File]::Move($pending, $target)
    if ($null -eq (Get-FleetConnectionCarrier $target)) { throw 'FLEET_CREDENTIAL_CARRY_READBACK_REFUSED' }
  }
  $carry
}

function Invoke-FleetCleanup($context) {
  $facts = Get-FleetInventory
  if (-not $facts.complete) { throw 'FLEET_LOCAL_INVENTORY_INCOMPLETE' }
  $null = @(Get-FleetProductPaths)
  if ($context['preflightCleanup']) { & $context.preflightCleanup $context }
  Stop-FleetWindowsWriters
  $carry = Save-FleetConnectionCarriers $context
  if ($context['checkConnection']) { & $context.checkConnection $context $carry }
  Clear-FleetWslScratchTasks $context.operationId
  Remove-FleetWslProducts $facts.wsl $context.operationId
  Remove-FleetWindowsRegistrations
  Remove-FleetResidentRootAce
  # The server-confirmed active Binding is folded into the new immutable
  # baseline. The old mutable sidecar was anchored to the deleted identity.
  $sidecar = Join-Path $FleetResources.ciRoot $FleetResources.admissionAssets[1]
  Assert-FleetLocalPath $sidecar
  [IO.File]::Delete($sidecar)
  Remove-FleetProductPaths
}

function Get-FleetStepState([string]$step, $context) {
  if ($step -ceq 'cleanup') {
    try {
      $facts = Get-FleetInventory
      if (-not $facts.complete) { return 'unknown' }
      # The CI root, controller and companion accounts and the App key are
      # routing signals, but can legitimately remain during a clean reinstall.
      if (@($facts.residue -match '^(service|task|firewall|wsl):').Count -or @(Get-FleetProductPaths).Count -or (Test-FleetResidentRootAce)) {
        return 'pending'
      }
      if ((Test-FleetOldConnectionSidecar) -or @((Get-FleetWslScratchTasks $context['operationId'])).Count) { return 'pending' }
      return Get-FleetSharedWslState $facts.wsl $context['operationId']
    } catch { return 'unknown' }
  }
  if ($step -cin @('install','verify')) {
    if ($context['observeInstall']) { $context.installed = & $context.observeInstall $context }
    if ($context['installed']) { return 'complete' }
    if ($step -ceq 'install') { return 'pending' }
  }
  if ($step -ceq 'return' -and $context.maintenance['restored'] -eq $true) { return 'complete' }
  'unknown'
}

function Invoke-FleetStep([string]$step, $context) {
  if ($step -ceq 'cleanup') { Invoke-FleetCleanup $context; return }
  if ($step -cne 'install' -or -not $context['install']) { throw 'FLEET_INSTALL_POSTCONDITION_UNAVAILABLE' }
  if ($context.retryingInstall) {
    $gate = Invoke-FleetMaintenance -Phase 'before-remove' -Context $context
    Assert-FleetRemovalGate $gate $context
    $context.maintenance = $gate
    $cleanup = Get-FleetStepState 'cleanup' $context
    if ($cleanup -ceq 'pending') { Invoke-FleetCleanup $context }
    if ((Get-FleetStepState 'cleanup' $context) -cne 'complete') { throw 'FLEET_STEP_NOT_CONFIRMED:cleanup' }
  }
  $result = & $context.install $context
  if ($null -eq $result -or $result.sourceSha256 -cne $context.sourceSha256) { throw 'FLEET_INSTALL_POSTCONDITION_UNAVAILABLE' }
  $context.installed = $result
}

function Read-FleetProgress([string]$file, $context) {
  Assert-FleetLocalPath $file
  if ($null -eq (Get-FleetPathItem $file)) { return $null }
  if ((Get-Item -LiteralPath $file -Force).Length -gt 4096) { throw 'FLEET_PROGRESS_REFUSED' }
  $value = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText($file))
  if ($value.contract -cne 'clued.fleet.lifecycle-progress/1' -or $value.operationId -cnotmatch '^[0-9a-f]{32}$' -or
      $value.mode -cnotin @('Fresh','Reinstall','Rollback','Retire') -or
      $value.step -cnotin @('intent','cleanup','install','launcher','verify','return','complete')) { throw 'FLEET_PROGRESS_REFUSED' }
  foreach ($key in @('machine','operatorSid','archiveSha256','acceptanceSha256','action')) {
    if ($value[$key] -cne $context[$key]) { throw ('FLEET_PROGRESS_DIFFERS:' + $key) }
  }
  $value
}

function Write-FleetProgress([string]$file, $value) {
  $tmp = $file + '.pending'
  Assert-FleetLocalPath $tmp
  if ($null -ne (Get-FleetPathItem $tmp)) { [IO.File]::Delete($tmp) }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 4 -Compress))
  $stream = [IO.FileStream]::new($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  if ([IO.File]::Exists($file)) { [IO.File]::Replace($tmp, $file, [NullString]::Value) } else { [IO.File]::Move($tmp, $file) }
  $back = Read-FleetProgress $file $value
  if ($back.step -cne $value.step -or $back.operationId -cne $value.operationId) { throw 'FLEET_PROGRESS_READBACK_FAILED' }
}

function Assert-FleetRemovalGate($gate, $context) {
  if ($gate.ok -ne $true) { throw $gate.code }
  if ($gate.archiveSha256 -cne $context.archiveSha256 -or $gate.acceptanceSha256 -cne $context.acceptanceSha256 -or
      $gate.operationId -cne $context.operationId -or $gate.sealed -ne $true) { throw 'FLEET_MAINTENANCE_SUBJECT_REFUSED' }
  if ($gate.ownerUac -isnot [bool] -or -not $gate.ownerUac -or $gate.drained -isnot [bool] -or -not $gate.drained -or
      $gate.hasDuty -isnot [bool] -or $gate.hasDuty -or
      ($context.mode -ceq 'Retire' -and $gate['retired'] -ne $true) -or ($context.mode -ceq 'Rollback' -and $gate['previous'] -ne $true)) {
    throw 'FLEET_MAINTENANCE_NOT_SAFE_TO_REMOVE'
  }
}

# Observe callbacks return complete only from durable postconditions. In
# particular, an unknown side effect is not a reason to run cleanup again.
# The caller executes this function only while holding the machine mutex.
function Invoke-FleetLifecycle($context, [string]$mode, [string]$file, [scriptblock]$Observe, [scriptblock]$Apply) {
  $progress = Read-FleetProgress $file $context
  if ($null -eq $progress) {
    $progress = New-FleetProgress $context $mode
    Write-FleetProgress $file $progress
  }
  $mode = $progress.mode
  $context.mode = $mode
  $context.operationId = $progress.operationId
  foreach ($key in @('bindingId','bindingGeneration','previewReceipt','zeroNodeConsent')) {
    if ($progress.step -ceq 'intent' -and $context['previewReceipt'] -and $key -cin @('previewReceipt','zeroNodeConsent')) {
      $progress[$key] = $context[$key]
    } elseif ($progress.Keys -ccontains $key) { $context[$key] = $progress[$key] }
    elseif ($context.Keys -ccontains $key) { $progress[$key] = $context[$key] }
  }
  Write-FleetProgress $file $progress
  $steps = @(if ($mode -ceq 'Retire') { 'cleanup' } elseif ($mode -ceq 'Fresh') { 'install'; 'verify' } else { 'cleanup'; 'install'; 'verify'; 'return' })
  if ($progress.step -ceq 'complete') { return @{ status = 'FLEET_LIFECYCLE_COMPLETE'; mode = $mode; operationId = $progress.operationId } }
  if ($mode -ceq 'Reinstall' -and $progress.step -cin @('verify','return') -and (& $Observe 'verify' $context) -cne 'complete') {
    # The protected journal is a cursor. A missing terminal still requires
    # fresh maintenance authorization before the retry may clean anything.
    $progress.step = 'install'
    Write-FleetProgress $file $progress
  }
  $start = if ($progress.step -ceq 'intent') { 0 } else { [Array]::IndexOf($steps, $progress.step) }
  if ($start -lt 0) { throw 'FLEET_PROGRESS_REFUSED' }
  for ($i = $start; $i -lt $steps.Count; $i++) {
    $step = $steps[$i]
    if ($step -ceq 'return' -and (& $Observe 'verify' $context) -cne 'complete') { throw 'FLEET_INSTALL_POSTCONDITION_UNAVAILABLE' }
    if ($step -ceq 'cleanup' -or $step -ceq 'return') {
      $phase = if ($step -ceq 'cleanup') { 'before-remove' } else { 'before-return' }
      $gate = Invoke-FleetMaintenance -Phase $phase -Context $context
      if ($gate.ok -ne $true) { throw $gate.code }
      if ($gate.archiveSha256 -cne $context.archiveSha256 -or $gate.acceptanceSha256 -cne $context.acceptanceSha256 -or
          $gate.operationId -cne $progress.operationId -or $gate.sealed -ne $true) { throw 'FLEET_MAINTENANCE_SUBJECT_REFUSED' }
      if ($step -ceq 'cleanup') {
        Assert-FleetRemovalGate $gate $context
        foreach ($key in @('bindingId','bindingGeneration')) {
          if ($gate.Keys -ccontains $key) { $context[$key] = $progress[$key] = $gate[$key] }
        }
      }
      $context.maintenance = $gate
    }
    $retry = $progress.step -ceq $step
    $context.retryingInstall = $retry
    $progress.step = $step
    Write-FleetProgress $file $progress
    $state = & $Observe $step $context
    if ($state -ceq 'pending' -or (-not $retry -and $state -ceq 'new')) {
      & $Apply $step $context | Out-Null
      $state = & $Observe $step $context
    }
    if ($state -cne 'complete') { throw ('FLEET_STEP_NOT_CONFIRMED:' + $step) }
  }
  $progress.step = 'complete'
  Write-FleetProgress $file $progress
  @{ status = 'FLEET_LIFECYCLE_COMPLETE'; mode = $mode; operationId = $progress.operationId }
}
