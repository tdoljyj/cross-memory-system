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

# The only service integration point. Context binds repository, archive and
# acceptance digests, Source, version, machine, operator SID and action. The
# elevated context adds operationId from the protected journal. A gate's
# ownerUac is derived only from the current native consent, never a CLI flag.
# preview is read-only and returns exact package eligibility, healthy peer
# count and a bounded downtime estimate. before-remove acquires or replays a
# maintenance lease for operationId, rereads package eligibility and confirms
# no new work, drained (including existing job-timeout closure), no active
# duty, and revocation for Retire. before-return rereads the seal and publishes
# standby under that lease, returning service-side identity/eligibility. A
# retry must reconcile the same operationId, never start another lease.
function Invoke-FleetMaintenance([ValidateSet('preview','before-remove','before-return')][string]$Phase, $Context) {
  @{ ok = $false; code = 'FLEET_MAINTENANCE_INTERFACE_UNAVAILABLE' }
}

function New-FleetContext([string]$acceptanceFile, [string]$archiveSha256, [string]$operatorSid, [string]$action) {
  $acceptance = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText($acceptanceFile))
  if ($acceptance['archive_sha256'] -cne $archiveSha256 -or $acceptance['ciSourceManifestSha256'] -cnotmatch '^[0-9a-f]{64}$' -or
      $acceptance['repository'] -cnotmatch '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$') { throw 'FLEET_TARGET_REFUSED' }
  @{
    repository = $acceptance['repository']; version = $acceptance['version']; archiveSha256 = $archiveSha256
    acceptanceSha256 = Sha256File $acceptanceFile; sourceSha256 = $acceptance['ciSourceManifestSha256']
    machine = [Environment]::MachineName.ToUpperInvariant(); operatorSid = $operatorSid; action = $action
  }
}

function Assert-FleetPreview($preview, $context) {
  if ($preview.archiveSha256 -cne $context.archiveSha256 -or $preview.acceptanceSha256 -cne $context.acceptanceSha256 -or
      $preview.sealed -ne $true -or ($context.action -ceq 'Rollback' -and $preview['previous'] -ne $true) -or
      $preview.healthyPeers -isnot [int] -or $preview.healthyPeers -lt 0 -or
      $preview.estimatedMinutes -isnot [int] -or $preview.estimatedMinutes -lt 1) { throw 'FLEET_MAINTENANCE_PREVIEW_REFUSED' }
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

# A denied or unreadable observation may never classify a host as clean.
function Get-FleetInventory {
  $residue = [Collections.Generic.List[string]]::new()
  $unknown = [Collections.Generic.List[string]]::new()
  try {
    $runner = $FleetResources.runnerPrefix + [Environment]::MachineName.ToLowerInvariant()
    foreach ($service in @(Get-Service -ErrorAction Stop | Where-Object { $_.Name -iin $FleetResources.services -or $_.Name -ieq $runner })) {
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
    $operatorLxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (Test-Path -LiteralPath $operatorLxss -ErrorAction Stop) {
      foreach ($key in @(Get-ChildItem -LiteralPath $operatorLxss -ErrorAction Stop)) {
        if ($key.GetValue('DistributionName') -ieq $FleetResources.distribution) { $residue.Add('operator-wsl:' + $FleetResources.distribution) }
      }
    }
  } catch { $unknown.Add('operator-wsl') }
  try {
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -ieq $FleetResources.taskPath -and $_.TaskName -iin $FleetResources.tasks })
    foreach ($task in $tasks) { $residue.Add('task:' + $task.TaskName) }
  } catch { $unknown.Add('tasks') }
  try {
    $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object { $_.Name -iin $FleetResources.firewallRules })
    foreach ($rule in $rules) { $residue.Add('firewall:' + $rule.Name) }
  } catch { $unknown.Add('firewall') }
  try {
    foreach ($account in @(Get-LocalUser -ErrorAction Stop | Where-Object { $_.Name -iin @($FleetResources.account,$FleetResources.controller) })) {
      $residue.Add('account:' + $account.Name)
    }
  } catch { $unknown.Add('accounts') }
  @{ complete = $unknown.Count -eq 0; residue = $residue.ToArray(); unknown = $unknown.ToArray() }
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

# Called by the native cleanup lane after it has proved ownership and stopped
# all writers. The only moved credentials are named in the inventory. No
# credential bytes cross the Windows process boundary. Both source and
# destination are rechecked so a cut between the two moves is replayable.
function Move-FleetConnectionCarriers([string]$directory) {
  Assert-FleetLocalPath $directory
  if ([IO.Path]::GetDirectoryName($directory) -ine $FleetResources.journalRoot) { throw 'FLEET_CREDENTIAL_CARRY_DIRECTORY_REFUSED' }
  if ([IO.Path]::GetPathRoot($directory) -ine [IO.Path]::GetPathRoot($FleetResources.ciRoot)) { throw 'FLEET_CREDENTIAL_CARRY_VOLUME_REFUSED' }
  $moves = @()
  foreach ($name in $FleetResources.stagedTokens.Keys) {
    $from = Join-Path $FleetResources.ciRoot $name
    $to = Join-Path $directory $FleetResources.stagedTokens[$name]
    Assert-FleetLocalPath $from
    Assert-FleetLocalPath $to
    $source = Get-FleetPathItem $from
    $target = Get-FleetPathItem $to
    if (($null -ne $source -and $source.PSIsContainer) -or ($null -ne $target -and $target.PSIsContainer) -or ($source -and $target)) {
      throw 'FLEET_CREDENTIAL_CARRY_CONFLICT'
    }
    if ($null -ne $source) { $moves += [ordered]@{ from = $from; to = $to } }
  }
  foreach ($move in $moves) {
    [IO.File]::Move($move.from, $move.to)
    if ($null -ne (Get-FleetPathItem $move.from) -or $null -eq (Get-FleetPathItem $move.to)) { throw 'FLEET_CREDENTIAL_CARRY_READBACK_REFUSED' }
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

function Get-FleetStepState([string]$step, $context) {
  if ($step -ceq 'cleanup') {
    $facts = Get-FleetInventory
    if (-not $facts.complete) { return 'unknown' }
    if ($facts.residue.Count -eq 0) { return 'complete' }
    return 'pending'
  }
  if ($step -ceq 'return' -and $context.maintenance['restored'] -eq $true) { return 'complete' }
  'unknown'
}

function Invoke-FleetStep([string]$step, $context) {
  if ($step -cne 'cleanup') { throw 'FLEET_INSTALL_POSTCONDITION_UNAVAILABLE' }
  # Keep the filesystem preflight in the same user session that will remove
  # it. Unsupported identities or WSL ownership stop before any removal.
  $null = @(Get-FleetProductPaths)
  throw 'FLEET_WINDOWS_CLEANUP_UNAVAILABLE'
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
  $steps = @(if ($mode -ceq 'Retire') { 'cleanup' } elseif ($mode -ceq 'Fresh') { 'install'; 'verify' } else { 'cleanup'; 'install'; 'verify'; 'return' })
  if ($progress.step -ceq 'complete') { return @{ status = 'FLEET_LIFECYCLE_COMPLETE'; mode = $mode } }
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
      if ($step -ceq 'cleanup' -and ($gate.ownerUac -ne $true -or $gate.drained -ne $true -or $gate.hasDuty -ne $false -or
          ($mode -ceq 'Retire' -and $gate['retired'] -ne $true) -or ($mode -ceq 'Rollback' -and $gate['previous'] -ne $true))) {
        throw 'FLEET_MAINTENANCE_NOT_SAFE_TO_REMOVE'
      }
      $context.maintenance = $gate
    }
    $retry = $progress.step -ceq $step
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
  @{ status = 'FLEET_LIFECYCLE_COMPLETE'; mode = $mode }
}
