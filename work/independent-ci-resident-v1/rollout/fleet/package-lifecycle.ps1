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
  if (-not [guid]::TryParse([string]$answer.op.opId, [ref]$id)) { throw 'FLEET_UPGRADER_OPERATION_REFUSED' }
  $active = @(Get-FleetServices | Where-Object { $_.Name -ieq 'CluedCIUpgrader' -and ($_.State -ine 'Stopped' -or $_.ProcessId -ne 0) })
  if ($active.Count -eq 0) { return $false }
  $lock = Join-Path $FleetResources.ciRoot 'resident\upgrade\lock\executor.lock'
  $holder = Read-FleetConnectionJson (Join-Path $lock 'holder.json')
  $heartbeat = Read-FleetConnectionJson (Join-Path $lock 'alive.json')
  $pidNumber = Get-Key $holder 'pid'
  $beatAt = Get-Key $heartbeat 'at'
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  # The frozen upgrader touches the lock between ticks. The pulse ties the
  # holder to a point in the lifetime of the current service child.
  if ($active.Count -eq 1 -and $active[0].ProcessId -gt 0 -and $pidNumber -gt 0 -and
      (Get-Key $holder 'token') -and $holder['token'] -ceq (Get-Key $heartbeat 'token') -and
      $beatAt -is [long] -and $beatAt -le $now) {
    $child = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$pidNumber) -ErrorAction Stop
    if ($child -and $child.ProcessId -eq $pidNumber -and $child.ParentProcessId -eq $active[0].ProcessId -and $child.CreationDate -is [DateTime] -and
        ([DateTimeOffset]$child.CreationDate).ToUnixTimeMilliseconds() -le $beatAt) { return $true }
  }
  # An active SCM service without this proof can still hold a writer.
  throw 'FLEET_UPGRADER_HEARTBEAT_UNKNOWN'
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

function Invoke-NativeChild([string]$exe, [string[]]$arguments, [int]$seconds = 3600, [Text.Encoding]$encoding = (New-Object Text.UTF8Encoding($false)), [bool]$shareConsole = $false, [byte[]]$stdin = $null) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = ($null -ne $stdin); $psi.CreateNoWindow = (-not $shareConsole)
  $psi.StandardOutputEncoding = $encoding; $psi.StandardErrorEncoding = $encoding
  # Windows PowerShell 5.1 (.NET Framework) opens a redirected stdin as a StreamWriter in Console.InputEncoding and writes that
  # encoding's preamble at once: on a UTF-8 console (code page 65001) the child reads a BOM before $stdin (run 44705707829). While the
  # child starts, Console's cached input encoding (what its getter returns) is a UTF-8 without one; .NET Core has no such field and
  # writes no preamble. Our bytes go to the base stream, so the writer's encoding is otherwise unused.
  $cie = if ($psi.RedirectStandardInput) { [Console].GetField('_inputEncoding', [Reflection.BindingFlags]'NonPublic, Static') } else { $null }
  $was = if ($null -ne $cie) { $cie.GetValue($null) } else { $null }
  if ($null -ne $cie) { $cie.SetValue($null, (New-Object Text.UTF8Encoding($false))) }
  try { $p = [Diagnostics.Process]::Start($psi) } finally { if ($null -ne $cie) { $cie.SetValue($null, $was) } }
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if ($null -ne $stdin) { try { $p.StandardInput.BaseStream.Write($stdin, 0, $stdin.Length); $p.StandardInput.BaseStream.Flush() } finally { $p.StandardInput.Close() } }   # a secret: never a command line
  if (-not $p.WaitForExit($seconds * 1000)) { return [ordered]@{ exit = $null; stdout = ''; stderr = ''; timedOut = $true } }
  $p.WaitForExit()   # the asynchronous reads end with the child
  $tail = { param($t) $t = ([string]$t) -replace "`0", ''; if ($t.Length -gt 1500) { $t.Substring($t.Length - 1500) } else { $t } }
  [ordered]@{ exit = $p.ExitCode; stdout = ([string]$o.Result -replace "`0", ''); stderr = (& $tail $e.Result); timedOut = $false }
}

function Remove-FleetServiceRegistration([string]$name) {
  $child = Invoke-NativeChild 'C:\Windows\System32\sc.exe' @('delete', $name) 120
  if ($child.exit -notin @(0,1060,1072)) { throw 'FLEET_SERVICE_DELETE_FAILED' }
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

# The low-privilege preview reads the Broker's signed-probe projection. The
# node credential remains protected; elevated status rechecks the observation.
function Get-FleetMaintenancePreview($Context, [scriptblock]$Now) {
  try { $probe = Read-FleetConnectionJson (Join-Path $FleetResources.ciRoot 'resident\broker\renew-ci.json') }
  catch { throw 'FLEET_MAINTENANCE_PREVIEW_UNKNOWN' }
  $target = Get-Key $probe 'fleetTarget'
  $at = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string](Get-Key $probe 'at'), [ref]$at) -or $at -gt (& $Now) -or
      $at.AddMinutes(10) -lt (& $Now) -or (Get-Key $probe 'code') -or
      (Get-Key $target 'archive_sha256') -cne $Context.archiveSha256 -or (Get-Key $target 'grant_id') -cne $Context.grantId -or
      (Get-Key $target 'has_other_healthy') -isnot [bool]) { throw 'FLEET_MAINTENANCE_PREVIEW_UNKNOWN' }
  New-FleetMaintenancePreview $Context $target['has_other_healthy']
}

function New-FleetMaintenancePreview($Context, [bool]$hasPeer) {
  @{
    ok = $true; sealed = $true; archiveSha256 = $Context.archiveSha256; acceptanceSha256 = $Context.acceptanceSha256
    healthyPeers = [int]$hasPeer; previewReceipt = ($Context.grantId + '.' + $Context.acceptanceSha256)
  }
}

function Read-FleetConnectionJson([string]$file) {
  $item = Get-FleetConnectionCarrier $file
  if ($null -ne $item) {
    (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText($item.FullName))
  }
}

function Get-FleetCarrierFingerprint([string]$node, [string]$tool, [string]$kind, [string]$file) {
  if ($null -eq (Get-FleetConnectionCarrier $file)) { throw 'FLEET_REQUIRED_CONNECTION_CARRIER_MISSING' }
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $node
  $psi.Arguments = '"' + $tool + '" ' + $kind
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables.Clear()
  $psi.EnvironmentVariables['SystemRoot'] = 'C:\Windows'
  $cie = if ($psi.RedirectStandardInput) { [Console].GetField('_inputEncoding', [Reflection.BindingFlags]'NonPublic, Static') } else { $null }
  $was = if ($null -ne $cie) { $cie.GetValue($null) } else { $null }
  if ($null -ne $cie) { $cie.SetValue($null, (New-Object Text.UTF8Encoding($false))) }
  try { $process = [Diagnostics.Process]::Start($psi) } finally { if ($null -ne $cie) { $cie.SetValue($null, $was) } }
  try {
    $output = $process.StandardOutput.ReadToEndAsync()
    $null = $process.StandardError.ReadToEndAsync()
    $carrier = [IO.File]::Open($file, 'Open', 'Read', 'Read')
    try { $carrier.CopyTo($process.StandardInput.BaseStream) }
    finally { $carrier.Dispose(); $process.StandardInput.Close() }
    if (-not $process.WaitForExit(20000)) { $process.Kill(); throw 'FLEET_CONNECTION_FINGERPRINT_TIMEOUT' }
    if ($process.ExitCode -ne 0) { throw 'FLEET_CONNECTION_FINGERPRINT_REFUSED' }
    $answer = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($output.Result.Trim())
    if ($answer['kind'] -cne $kind -or $answer['fingerprint'] -cnotmatch '^[0-9a-f]{64}$') { throw 'FLEET_CONNECTION_FINGERPRINT_REFUSED' }
    [string]$answer['fingerprint']
  } finally { $process.Dispose() }
}

function Connect-FleetMaintenance($kitRecord, $carriedSite, [string]$nodeExe, [string]$tool) {
  $installed = Read-FleetConnectionJson (Join-Path $FleetResources.ciRoot 'resident\record\installation.json')
  $site = if ($installed) { $installed } else { $carriedSite }
  foreach ($key in @('scope','supabaseUrl','publishableKey')) {
    if (-not (Get-Key $site $key) -or (Get-Key $site $key) -cne (Get-Key $kitRecord $key)) { throw 'FLEET_MAINTENANCE_ENDPOINT_REFUSED' }
  }
  $file = Join-Path $FleetResources.ciRoot $FleetResources.admissionAssets[0]
  if ($null -eq (Get-FleetConnectionCarrier $file)) { throw 'FLEET_REQUIRED_CONNECTION_CARRIER_MISSING' }
  $acl = Get-Acl -LiteralPath $file -ErrorAction Stop
  $controller = (Get-LocalUser -Name $FleetResources.controller -ErrorAction Stop).SID.Value
  $administrators = @('S-1-5-18','S-1-5-32-544')
  $rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin $administrators -or
      @($rules | Where-Object {
        $_.AccessControlType -ne 'Allow' -or ($_.IdentityReference.Value -cnotin $administrators -and
          ($_.IdentityReference.Value -cne $controller -or ($_.FileSystemRights -band ([Security.AccessControl.FileSystemRights]'Write,ChangePermissions,TakeOwnership'))))
      }).Count) { throw 'FLEET_MAINTENANCE_CARRIER_ACL_REFUSED' }
  $connection = @{
    scope = $site['scope']; supabaseUrl = $site['supabaseUrl']; publishableKey = $site['publishableKey']
    authHash = Get-FleetCarrierFingerprint $nodeExe $tool 'ci-rpc' $file
  }
  $self = Invoke-FleetNodeRpc $connection 'clued_ci_connection_self_v1' @{scope=$connection.scope}
  $registered = Get-Key $self 'node'
  if ((Get-Key $self 'status') -cne 'ok' -or (Get-Key $self 'contract') -cne 'clued.ci.connection-self/1' -or
      $null -eq $registered) { throw 'FLEET_MAINTENANCE_CONNECTION_REFUSED' }
  $connection.nodeId = Get-Key $registered 'node_id'
  $connection.generation = Get-Key $registered 'binding_generation'
  $connection.bindingId = Get-Key $self 'binding_id'
  $connection
}

function Get-FleetPreservedConnection($Context, [string]$carry, [string]$nodeExe, [string]$tool) {
  $root = $FleetResources.ciRoot
  $saved = Read-FleetConnectionJson (Join-Path $carry 'metadata.json')
  $install = Read-FleetConnectionJson (Join-Path $root 'resident\record\installation.json')
  $facts = Read-FleetConnectionJson (Join-Path $root 'first-install\facts.json')
  $record = if ($install) { $install } elseif ($facts) { Get-Key $facts 'nodeRecord' } else { Get-Key $saved 'nodeRecord' }
  if ($null -eq $record) { throw 'FLEET_PRESERVED_CONNECTION_SHAPE_REFUSED' }
  $ciPin = Get-FleetCarrierFingerprint $nodeExe $tool 'ci-token' (Join-Path $root $FleetResources.admissionAssets[0])
  $sidecar = Read-FleetConnectionJson (Join-Path $root $FleetResources.admissionAssets[1])
  if ($sidecar) {
    if ($sidecar['contract'] -cne 'clued.independent-ci.ci-connection/1' -or
        $sidecar['bindingId'] -cne $Context.bindingId -or $sidecar['bindingGeneration'] -ne $Context.bindingGeneration -or
        $sidecar['tokenPinSha256'] -cne $ciPin) { throw 'FLEET_PRESERVED_BINDING_REFUSED' }
  } elseif ((Get-Key $record 'ciPrincipalBindingId') -cne $Context.bindingId -or (Get-Key $record 'ciTokenPinSha256') -cne $ciPin) {
    throw 'FLEET_PRESERVED_BINDING_REFUSED'
  }
  $next = [ordered]@{}
  foreach ($key in @('appKeyId','appPublicKeySha256Base64','ciPrincipalQualificationRef','ciPrincipalRoleRef')) {
    $next[$key] = Get-Key $record $key
  }
  $next.ciPrincipalBindingId = $Context.bindingId
  $next.ciTokenPinSha256 = $ciPin
  $upgrade = Get-FleetCarrierFingerprint $nodeExe $tool 'ci-token' (Join-Path $carry 'resident-upgrade.token')
  $hbFile = Join-Path $carry 'ci-node-heartbeat.token'
  $receipt = Read-FleetConnectionJson (Join-Path $root 'resident\install\install-receipt.json')
  $heartbeat = Get-Key $receipt 'heartbeatToken'
  if (-not $heartbeat) { $heartbeat = Get-Key (Get-Key $facts 'credentials') 'heartbeatToken' }
  if (-not $heartbeat) { $heartbeat = Get-Key $saved 'heartbeatToken' }
  if (Get-FleetConnectionCarrier $hbFile) {
    $heartbeat = @{bindingId=(Get-Key $heartbeat 'bindingId'); fingerprint=(Get-FleetCarrierFingerprint $nodeExe $tool 'heartbeat-token' $hbFile)}
  } elseif ($heartbeat -and ((Get-Key $heartbeat 'placed') -eq $true -or (Get-Key $heartbeat 'fingerprint'))) {
    throw 'FLEET_REQUIRED_CONNECTION_CARRIER_MISSING'
  } else { $heartbeat = $null }
  @{nodeRecord=$next; upgradeToken=@{fingerprint=$upgrade}; heartbeatToken=$heartbeat}
}

function Invoke-FleetNodeRpc($Connection, [ValidateSet('clued_ci_connection_self_v1','clued_work_verify_v1')][string]$Rpc, $InputData) {
  if ($Connection['supabaseUrl'] -cnotmatch '^https://[a-z0-9]+\.supabase\.co$' -or
      $Connection['publishableKey'] -cnotmatch '^sb_publishable_[A-Za-z0-9_-]+$' -or
      $Connection['authHash'] -cnotmatch '^[0-9a-f]{64}$') { throw 'FLEET_MAINTENANCE_CONNECTION_REFUSED' }
  try {
    $public = $Connection['publishableKey']
    $body = @{ p_token_hash = $Connection['authHash']; p_input = $InputData } | ConvertTo-Json -Depth 4 -Compress
    $reply = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($Connection['supabaseUrl'] + '/rest/v1/rpc/' + $Rpc) -ContentType 'application/json' -Body $body -TimeoutSec 20 -MaximumRedirection 0 -ErrorAction Stop -Headers @{apikey=$public; Authorization=('Bearer ' + $public)}
    if ($reply.Content.Length -gt 32768) { throw 'FLEET_MAINTENANCE_REPLY_REFUSED' }
    (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($reply.Content)
  } catch { throw 'FLEET_MAINTENANCE_REQUEST_FAILED' }
}

function Invoke-FleetMaintenance([ValidateSet('preview','before-remove','before-return')][string]$Phase, $Context,
    [scriptblock]$Send, [scriptblock]$Wait = { Start-Sleep -Seconds 5 }, [scriptblock]$Now = { [DateTimeOffset]::UtcNow }) {
  try {
    if ($Context['action'] -cne 'Install') { throw 'FLEET_MAINTENANCE_ACTION_REFUSED' }
    if ($null -eq $Send -and $Phase -ceq 'preview' -and -not $Context['nodeConnection']) {
      return Get-FleetMaintenancePreview $Context $Now
    }
    $uuid = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    $node = $Context['nodeConnection']
    if ($null -eq $node -or $node['nodeId'] -cnotmatch $uuid -or $node['bindingId'] -cnotmatch $uuid -or
        ($node['generation'] -isnot [int] -and $node['generation'] -isnot [long]) -or
        $node['generation'] -lt 1 -or $Context['grantId'] -cnotmatch $uuid) { throw 'FLEET_MAINTENANCE_CONNECTION_REFUSED' }
    if (($Context['bindingId'] -and $Context['bindingId'] -cne $node['bindingId']) -or
        ($Context['bindingGeneration'] -and $Context['bindingGeneration'] -ne $node['generation'])) { throw 'FLEET_MAINTENANCE_BINDING_REFUSED' }
    if ($null -eq $Send) { $Send = { param($inputData) Invoke-FleetNodeRpc $node 'clued_work_verify_v1' $inputData } }
    $read = @{ action='fleet_maintenance'; command='status'; scope=$node['scope']; node_id=$node['nodeId']; binding_generation=$node['generation'] }
    $status = & $Send $read
    Assert-FleetMaintenanceStatus $status $read $Context.grantId
    if ($Phase -ceq 'preview') { return New-FleetMaintenancePreview $Context $status['has_other_healthy'] }
    if ($Context['ownerUac'] -ne $true) { throw 'FLEET_MAINTENANCE_UAC_REQUIRED' }
    $operation = ([Guid]$(if ($Context['maintenanceOperationId']) { $Context['maintenanceOperationId'] } else { $Context.operationId })).ToString('D')
    $write = $read.Clone()
    $write.grant_id = $Context.grantId
    $write.operation_id = $operation
    if ($Phase -ceq 'before-remove') {
      if (-not $status['has_other_healthy'] -and -not $Context['zeroNodeConsent']) { throw 'FLEET_MAINTENANCE_NEEDS_SOLE_NODE_CONSENT' }
      $write.command = 'delist'
      $write.method = 'reinstall'
      if (-not $status['has_other_healthy'] -and $Context['zeroNodeConsent'] -eq $true) { $write.sole_node_agreed = $true }
    } else {
      if (-not $Context['installed']) { throw 'FLEET_INSTALL_POSTCONDITION_UNAVAILABLE' }
      $write.command = 'verify_started'
    }
    $requested = & $Now
    $deadline = $requested.AddMinutes(45)
    $response = & $Send $write
    Assert-FleetMaintenanceStatus $response $read $Context.grantId
    if ($response['operation_id'] -cne $operation -or $response['receipt_id'] -cnotmatch $uuid) { throw 'FLEET_MAINTENANCE_SUBJECT_REFUSED' }
    do {
      # The write receipt alone can be an idempotent replay. Only the current
      # status for this very operation can authorize cleanup or return.
      $status = & $Send $read
      Assert-FleetMaintenanceStatus $status $read $Context.grantId
      if ($status['operation_id'] -cne $operation -or $status['receipt_id'] -cnotmatch $uuid) { throw 'FLEET_MAINTENANCE_SUBJECT_REFUSED' }
      if ($Phase -ceq 'before-remove') {
        if ($status['state'] -cnotin @('delisted','draining')) { throw 'FLEET_MAINTENANCE_NOT_SAFE_TO_REMOVE' }
        if ($status['state'] -ceq 'delisted' -and $status['install_ready']) {
          if ($Context['requireFreshDrain']) {
            $confirmed = [DateTimeOffset]::MinValue
            if (-not [DateTimeOffset]::TryParse([string](Get-Key $status 'drain_confirmed_at'), [ref]$confirmed) -or
                $confirmed -lt $requested -or $confirmed -gt (& $Now)) {
              throw 'FLEET_MAINTENANCE_STALE_DRAIN'
            }
          }
      return @{
            ok=$true; sealed=$true; archiveSha256=$Context.archiveSha256; acceptanceSha256=$Context.acceptanceSha256
            operationId=$Context.operationId; bindingId=$node['bindingId']; bindingGeneration=$node['generation']
            ownerUac=$true; drained=$true; hasDuty=$false; freshDrain=($Context['requireFreshDrain'] -eq $true)
            connection=$Context['preservedConnection']
          }
        }
      } else {
        if ($status['state'] -ceq 'returned' -and -not $status['install_ready']) {
          return @{ok=$true; sealed=$true; restored=$true; archiveSha256=$Context.archiveSha256; acceptanceSha256=$Context.acceptanceSha256; operationId=$Context.operationId}
        }
        if ($status['state'] -cnotin @('delisted','verifying')) { throw 'FLEET_MAINTENANCE_NOT_RESTORED' }
        $started = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse([string](Get-Key $status 'verify_started_at'), [ref]$started)) {
          $serverDeadline = $started.AddMinutes(45)
          if ($serverDeadline -lt $deadline) { $deadline = $serverDeadline }
        }
      }
      if ((& $Now) -ge $deadline) { break }
      & $Wait
    } while ($true)
    if ($Phase -ceq 'before-remove') { throw 'FLEET_MAINTENANCE_DRAIN_TIMEOUT' }
    throw 'FLEET_MAINTENANCE_VERIFY_TIMEOUT'
  } catch {
    $code = [string]$_.Exception.Message
    if ($code -cnotmatch '^FLEET_[A-Z0-9_]{1,90}$') { $code = 'FLEET_MAINTENANCE_REPLY_REFUSED' }
    @{ ok = $false; code = $code }
  }
}

function Assert-FleetMaintenanceStatus($Reply, $Read, [string]$Grant) {
  if ($Reply -isnot [Collections.IDictionary] -or $Reply['status'] -cne 'ok' -or $Reply['node_id'] -cne $Read.node_id -or
      $Reply['binding_generation'] -ne $Read.binding_generation -or $Reply['grant_id'] -cne $Grant -or
      $Reply['has_other_healthy'] -isnot [bool] -or $Reply['install_ready'] -isnot [bool]) {
    throw 'FLEET_MAINTENANCE_SUBJECT_REFUSED'
  }
}


function New-FleetContext([string]$acceptanceFile, [string]$archiveSha256, [string]$operatorSid, [string]$action) {
  $acceptance = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText($acceptanceFile))
  if ($acceptance['archive_sha256'] -cne $archiveSha256 -or $acceptance['ciSourceManifestSha256'] -cnotmatch '^[0-9a-f]{64}$' -or
      $acceptance['repository'] -cnotmatch '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$') { throw 'FLEET_TARGET_REFUSED' }
  @{
    repository = $acceptance['repository']; version = $acceptance['version']; commit = $acceptance['commit']; archiveSha256 = $archiveSha256
    grantId = $acceptance['cluedDecision']
    acceptanceSha256 = Sha256File $acceptanceFile; sourceSha256 = $acceptance['ciSourceManifestSha256']
    machine = [Environment]::MachineName.ToUpperInvariant(); operatorSid = $operatorSid; action = $action
  }
}

function Assert-FleetPreview($preview, $context) {
  if ($preview['archiveSha256'] -cne $context.archiveSha256 -or $preview['acceptanceSha256'] -cne $context.acceptanceSha256 -or
      $preview['sealed'] -ne $true -or ($context.action -ceq 'Rollback' -and $preview['previous'] -ne $true) -or
      $preview['healthyPeers'] -isnot [int] -or $preview['healthyPeers'] -lt 0 -or
      $preview['previewReceipt'] -cne ($context.grantId + '.' + $context.acceptanceSha256)) { throw 'FLEET_MAINTENANCE_PREVIEW_REFUSED' }
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
    throw ('FLEET_JOURNAL_ACL_REFUSED: remove the refused journal directory ' + $root)
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
    $child = Invoke-NativeChild $reg @('load', ('HKU\' + $mount), $hive) 120
    if ($child.exit -ne 0) { throw 'FLEET_WSL_OWNER_HIVE_UNAVAILABLE' }
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
      $child = Invoke-NativeChild $reg @('unload', ('HKU\' + $mount)) 120
      if ($child.exit -ne 0) { throw 'FLEET_WSL_OWNER_HIVE_NOT_UNLOADED' }
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
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
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
        $task.Actions[0].Arguments -cnotmatch '^-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/]+=*$' -or
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
    $carried = Get-FleetConnectionCarrier $target
    $source = Get-FleetConnectionCarrier (Join-Path $FleetResources.ciRoot $relative)
    if ($null -eq $source -and $null -eq $carried) { $source = Get-FleetConnectionCarrier (Join-Path $FleetResources.ciRoot ('first-install\credentials\' + $name)) }
    if ($null -eq $source) {
      if ($null -ne $carried) { continue }
      if ($name -ceq 'resident-upgrade.token' -or $null -ne $context.maintenance.connection['heartbeatToken']) { throw 'FLEET_REQUIRED_CONNECTION_CARRIER_MISSING' }
      continue
    }
    # Move through a private pending name so a terminated Copy cannot become
    # the next attempt's accepted carrier.
    $pending = $target + '.pending'
    Assert-FleetLocalPath $pending
    [IO.File]::Delete($pending)
    [IO.File]::Copy($source.FullName, $pending, $false)
    if ($null -eq $carried) { [IO.File]::Move($pending, $target) }
    else { [IO.File]::Replace($pending, $target, [NullString]::Value) }
    if ($null -eq (Get-FleetConnectionCarrier $target)) { throw 'FLEET_CREDENTIAL_CARRY_READBACK_REFUSED' }
  }
  $carry
}

function Invoke-FleetCleanup($context) {
  $facts = Get-FleetInventory
  if (-not $facts.complete) { throw 'FLEET_LOCAL_INVENTORY_INCOMPLETE' }
  $null = @(Get-FleetProductPaths)
  if ($context['preflightCleanup']) { & $context.preflightCleanup $context }
  $carry = Save-FleetConnectionCarriers $context
  if ($context['checkConnection']) { & $context.checkConnection $context $carry }
  Stop-FleetWindowsWriters
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
    $cleanup = Get-FleetStepState 'cleanup' $context
    if ($cleanup -ceq 'pending') { $context.requireFreshDrain = $true }
    $gate = Invoke-FleetMaintenance -Phase 'before-remove' -Context $context
    Assert-FleetRemovalGate $gate $context
    $context.maintenance = $gate
    $cleanup = Get-FleetStepState 'cleanup' $context
    if ($cleanup -ceq 'pending' -and -not $context['requireFreshDrain']) { throw 'FLEET_MAINTENANCE_STALE_DRAIN' }
    if ($cleanup -ceq 'pending') { Invoke-FleetCleanup $context }
    if ((Get-FleetStepState 'cleanup' $context) -cne 'complete') { throw 'FLEET_STEP_NOT_CONFIRMED:cleanup' }
  }
  $result = & $context.install $context
  if ($null -eq $result -or $result.sourceSha256 -cne $context.sourceSha256) { throw 'FLEET_INSTALL_POSTCONDITION_UNAVAILABLE' }
  $context.installed = $result
}

function Read-FleetProgress([string]$file, $context, [switch]$ArchiveStaleFresh, [switch]$RetargetReinstall) {
  Assert-FleetLocalPath $file
  if ($null -eq (Get-FleetPathItem $file)) { return $null }
  if ((Get-Item -LiteralPath $file -Force).Length -gt 4096) { throw 'FLEET_PROGRESS_REFUSED' }
  $value = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText($file))
  if ($value.contract -cne 'clued.fleet.lifecycle-progress/1' -or $value.operationId -cnotmatch '^[0-9a-f]{32}$' -or
      $value.mode -cnotin @('Fresh','Reinstall','Rollback','Retire') -or
      $value.step -cnotin @('intent','cleanup','install','launcher','verify','return','complete')) { throw 'FLEET_PROGRESS_REFUSED' }
  foreach ($key in @('machine','operatorSid','action')) {
    if ($value[$key] -cne $context[$key]) { throw ('FLEET_PROGRESS_DIFFERS:' + $key) }
  }
  foreach ($key in @('archiveSha256','acceptanceSha256')) {
    if ($value[$key] -ceq $context[$key]) { continue }
    # Only the locked elevated bootstrap opts in after verifying the journal ACL.
    if ($ArchiveStaleFresh -and $value.mode -ceq 'Fresh' -and
        $value.archiveSha256 -cmatch '^[0-9a-f]{64}$' -and $value.acceptanceSha256 -cmatch '^[0-9a-f]{64}$') {
      $root = Split-Path -Parent $file
      $archive = $root + '.archived-' + $value.operationId
      Assert-FleetLocalPath $archive
      [IO.Directory]::Move($root, $archive)
      return $null
    }
    if ($RetargetReinstall -and $context.action -ceq 'Install' -and $value.mode -ceq 'Reinstall' -and
        $value.archiveSha256 -cmatch '^[0-9a-f]{64}$' -and $value.acceptanceSha256 -cmatch '^[0-9a-f]{64}$') {
      # Keep the carry and the local journal directory. The server operation
      # belongs to the previous Grant, so the new package has its own UUID.
      $next = New-FleetProgress $context 'Reinstall'
      $next.maintenanceOperationId = ([Guid]$next.operationId).ToString('D')
      $next.operationId = $value.operationId
      return $next
    }
    throw ('FLEET_PROGRESS_DIFFERS:' + $key)
  }
  $value
}

function Write-FleetJournalJson([string]$file, $value) {
  $tmp = $file + '.pending'
  Assert-FleetLocalPath $tmp
  if ($null -ne (Get-FleetPathItem $tmp)) { [IO.File]::Delete($tmp) }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 4 -Compress))
  $stream = [IO.FileStream]::new($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  if ([IO.File]::Exists($file)) { [IO.File]::Replace($tmp, $file, [NullString]::Value) } else { [IO.File]::Move($tmp, $file) }
}

function Write-FleetProgress([string]$file, $value) {
  Write-FleetJournalJson $file $value
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
  if ($context['requireFreshDrain'] -and $gate['freshDrain'] -ne $true) { throw 'FLEET_MAINTENANCE_STALE_DRAIN' }
}

# Observe callbacks return complete only from durable postconditions. In
# particular, an unknown side effect is not a reason to run cleanup again.
# The caller executes this function only while holding the machine mutex.
function Invoke-FleetLifecycle($context, [string]$mode, [string]$file, [scriptblock]$Observe, [scriptblock]$Apply) {
  $progress = Read-FleetProgress $file $context -RetargetReinstall
  if ($null -eq $progress) {
    $progress = New-FleetProgress $context $mode
  } elseif ($progress.Keys -ccontains 'maintenanceOperationId' -and $progress.step -ceq 'intent' -and
      $context['previewReceipt'] -cne ($context['grantId'] + '.' + $context.acceptanceSha256)) {
    throw 'FLEET_REINSTALL_REQUIRES_PREVIEW'
  }
  $mode = $progress.mode
  $context.mode = $mode
  $context.operationId = $progress.operationId
  foreach ($key in @('bindingId','bindingGeneration','previewReceipt','maintenanceOperationId','requireFreshDrain')) {
    if ($progress.step -ceq 'intent' -and $context['previewReceipt'] -and $key -ceq 'previewReceipt') {
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
    $context.requireFreshDrain = $progress['requireFreshDrain'] = $true
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
