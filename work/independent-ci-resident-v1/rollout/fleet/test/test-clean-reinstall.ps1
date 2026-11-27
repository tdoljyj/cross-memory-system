# Simulated native ports. No service manager, scheduler, WSL or network is used.
$fixtureRoot = Join-Path $env:TEMP ('clued-clean-reinstall-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixtureRoot)
try {
  $FleetResources.ciRoot = Join-Path $fixtureRoot 'product'
  $FleetResources.controlRoot = Join-Path $fixtureRoot 'control'
  $FleetResources.journalRoot = $fixtureRoot
  function Assert-FleetJournalRoot([string]$root) { [void][IO.Directory]::CreateDirectory($root) }
  $files = @('resident\upgrade\current.json','resident\state\old.json','wsl\CluedResident-Linux\ext4.vhdx',
    'secrets\ci-admission.token','secrets\ci-admission.connection.json','another-product\keep') + @($FleetResources.stagedTokens.Keys)
  function Put-Fixture([string]$file) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
    [IO.File]::WriteAllText($file, 'offline-fixture')
  }
  foreach ($relative in $files) { Put-Fixture (Join-Path $FleetResources.ciRoot $relative) }
  Put-Fixture (Join-Path $FleetResources.controlRoot $FleetResources.controlKey)
  $operator = 'S-1-5-21-1-2-3-1001'; $companion = 'S-1-5-21-1-2-3-1002'
  $dedicated = @{ name = $FleetResources.distribution; kind = 'dedicated'; ownerSid = $companion
    id = '{11111111-1111-4111-8111-111111111111}'; basePath = (Join-Path $FleetResources.ciRoot 'wsl\CluedResident-Linux') }
  $shared = @{ name = $FleetResources.sharedDistribution; kind = 'shared-candidate'; ownerSid = $operator
    id = '{22222222-2222-4222-8222-222222222222}'; basePath = (Join-Path $fixtureRoot 'shared') }
  $fixtureMachine = @{
    services = @(foreach ($name in $FleetResources.services) {
      @{Name=$name; State='Running'; ProcessId=42; PathName=(Join-Path $FleetResources.ciRoot ('resident\bin\' + $name + '.exe')) }
    })
    tasks = @(foreach ($name in $FleetResources.tasks) { @{TaskName=$name; State='Running'; TaskPath=$FleetResources.taskPath} })
    firewall = $true; acl = $true; dedicated = $true; sharedResidue = $true; finished = $false
    installedTries = 0; refuseDrain = $true; refuseReturn = $true; afterRemovalCut = $true; order = [Collections.Generic.List[string]]::new()
  }
  $base = @{ repository = 'fixture/repo'; machine = 'FIXTURE'; operatorSid = $operator; archiveSha256 = 'a' * 64
    acceptanceSha256 = 'b' * 64; sourceSha256 = 'c' * 64; action = 'Install'; ownerUac = $true; zeroNodeConsent = $true
    grantId = '73f65562-5419-4ca8-bff0-8783ebb1b0d2'; preservedConnection = @{heartbeatToken=@{}}
    nodeConnection = @{scope='global'; nodeId='03f65562-5419-4ca8-bff0-8783ebb1b0d2';bindingId='83f65562-5419-4ca8-bff0-8783ebb1b0d2';generation=3} }
  $wire = @{clock=[DateTimeOffset]::Parse('2026-11-27T00:00:00Z'); state='available'; operation=$null; grant=$null; stale=$false; writes=@()}
  $maintenanceAdapter = ${function:Invoke-FleetMaintenance}
  function Invoke-FleetMaintenance([string]$Phase, $Context) {
    $fixtureMachine.order.Add($Phase)
    $send = {
      param($request)
      if ($request.command -cne 'status') {
        $wire.writes += $request.Clone()
        $wire.operation = $request.operation_id
        $wire.grant = $request.grant_id
      }
      if ($request.command -ceq 'delist') { $wire.state = 'delisted' }
      if ($request.command -ceq 'verify_started') {
        $wire.state = if ($fixtureMachine.refuseReturn) { 'verifying' } else { 'returned' }
      }
      $at = if ($wire.stale) { $wire.clock.AddHours(-1) } else { $wire.clock }
      @{status='ok'; node_id=$Context.nodeConnection.nodeId; binding_generation=3; grant_id=$Context.grantId
        has_other_healthy=$false; state=$wire.state; operation_id=$wire.operation; receipt_id='63f65562-5419-4ca8-bff0-8783ebb1b0d2'
        install_ready=($wire.state -ceq 'delisted' -and -not $fixtureMachine.refuseDrain); drain_confirmed_at=$at.ToString('o')}
    }
    & $maintenanceAdapter $Phase $Context -Send $send -Now { $wire.clock } -Wait { $wire.clock = $wire.clock.AddMinutes(15) }
  }
  function Get-FleetServices { $fixtureMachine.services }
  function Get-FleetTasks { $fixtureMachine.tasks }
  function Get-FleetFirewallRules { if ($fixtureMachine.firewall) { @{Name=$FleetResources.firewallRules[0]} } }
  function Set-Service { param($Name, $StartupType, $ErrorAction) $fixtureMachine.order.Add('disable-service:' + $Name) }
  function Stop-Service {
    param($Name, $ErrorAction)
    $s = $fixtureMachine.services | Where-Object Name -eq $Name
    $s.State = 'Stopped'; $s.ProcessId = 0
    $fixtureMachine.order.Add('stop-service:' + $Name)
  }
  function Disable-ScheduledTask { param($InputObject, $ErrorAction) $fixtureMachine.order.Add('disable-task:' + $InputObject.TaskName) }
  function Stop-ScheduledTask { param($InputObject, $ErrorAction) $InputObject.State = 'Disabled'; $fixtureMachine.order.Add('stop-task:' + $InputObject.TaskName) }
  function Unregister-ScheduledTask {
    param($InputObject, [switch]$Confirm, $ErrorAction)
    if ($InputObject.State -ne 'Disabled') { throw 'FIXTURE_TASK_NOT_STOPPED' }
    $fixtureMachine.tasks = @($fixtureMachine.tasks | Where-Object TaskName -ne $InputObject.TaskName)
    $fixtureMachine.order.Add('delete-task:' + $InputObject.TaskName)
  }
  function Remove-FleetServiceRegistration {
    param($Name)
    $s = $fixtureMachine.services | Where-Object Name -eq $Name
    if ($s.State -ne 'Stopped' -or $s.ProcessId -ne 0) { throw 'FIXTURE_SERVICE_NOT_STOPPED' }
    $fixtureMachine.services = @($fixtureMachine.services | Where-Object Name -ne $Name)
    $fixtureMachine.order.Add('delete-service:' + $Name)
  }
  function Get-CimInstance {
    param($ClassName, $ErrorAction)
    if ($ClassName -cne 'Win32_Process') { throw 'FIXTURE_HOST_PROBE_REFUSED' }
    $fixtureMachine.order.Add('readback-writers')
  }
  function Get-NetFirewallServiceFilter { param($ErrorAction) process { @{ Service = 'CluedCIResident' } } }
  function Disable-NetFirewallRule { param($InputObject, $ErrorAction) $fixtureMachine.order.Add('disable-firewall') }
  function Remove-NetFirewallRule { param($InputObject, $ErrorAction) $fixtureMachine.firewall = $false; $fixtureMachine.order.Add('delete-firewall') }
  function Test-FleetResidentRootAce { $fixtureMachine.acl }
  function Remove-FleetResidentRootAce { $fixtureMachine.acl = $false; $fixtureMachine.order.Add('delete-ACE') }
  function Get-FleetProfileDirectory { }
  function Get-FleetWslScratchTasks { }
  function Get-FleetWslInventory($sid, $path) {
    if ($sid -ceq $operator) { return $shared }
    if ($sid -ceq $companion -and $fixtureMachine.dedicated) { return $dedicated }
  }
  function Invoke-FleetOwnedWsl($row, $mode) {
    if ($row.name -ceq $dedicated.name -and $row.ownerSid -ceq $companion -and $mode -ceq 'remove') {
      $fixtureMachine.order.Add('unregister-companion')
      $fixtureMachine.dedicated = $false
      [IO.File]::Delete((Join-Path $row.basePath 'ext4.vhdx'))
      return 0
    }
    if ($row.name -ceq $shared.name -and $row.ownerSid -ceq $operator) {
      if ($mode -ceq 'remove') { $fixtureMachine.order.Add('clean-shared'); $fixtureMachine.sharedResidue = $false }
      if ($fixtureMachine.sharedResidue) { return 10 }
      return 0
    }
    throw 'FIXTURE_WSL_WRONG_OWNER'
  }
  function Get-FleetInventory {
    $residue = @(foreach ($s in $fixtureMachine.services) { 'service:' + $s.Name }) +
      @(foreach ($t in $fixtureMachine.tasks) { 'task:' + $t.TaskName })
    if ($fixtureMachine.firewall) { $residue += 'firewall:product' }
    if ($fixtureMachine.dedicated) { $residue += 'wsl:dedicated' }
    @{ complete = $true; residue = $residue; wsl = @(Get-FleetWslInventory $operator '') + @(Get-FleetWslInventory $companion '') }
  }
  $base.checkConnection = {
    param($ctx,$carry)
    foreach ($name in $FleetResources.stagedTokens.Values) {
      if (-not [IO.File]::Exists((Join-Path $carry $name))) { throw 'FIXTURE_CARRIER_MISSING' }
    }
    $fixtureMachine.order.Add('check-connection')
  }
  $base.observeInstall = {
    param($ctx)
    if ($fixtureMachine.finished) { @{ status = 'verified'; sourceSha256 = $ctx.sourceSha256 } }
  }
  $base.install = {
    param($ctx)
    $fixtureMachine.order.Add('install')
    if ($fixtureMachine.afterRemovalCut) { $fixtureMachine.afterRemovalCut = $false; throw 'FIXTURE_CUT_AFTER_REMOVAL' }
    $fixtureMachine.installedTries++
    if ($fixtureMachine.installedTries -eq 1) {
      $fixtureMachine.dedicated = $true
      Put-Fixture (Join-Path $dedicated.basePath 'ext4.vhdx')
      throw 'FIXTURE_CUT_AFTER_WSL'
    }
    if ($fixtureMachine.installedTries -eq 2) {
      Put-Fixture (Join-Path $FleetResources.ciRoot 'resident\upgrade\current.json')
      throw 'FIXTURE_CUT_AFTER_WINDOWS'
    }
    $fixtureMachine.finished = $true
    & $ctx.observeInstall $ctx
  }
  $file = Join-Path $fixtureRoot 'operation.json'
  $run = { Invoke-FleetLifecycle ($base.Clone()) 'Reinstall' $file ${function:Get-FleetStepState} ${function:Invoke-FleetStep} }
  $preview = Invoke-FleetMaintenance 'preview' $base
  Assert-FleetPreview $preview $base
  $base.previewReceipt = $preview.previewReceipt
  Yes ($preview.healthyPeers -eq 0 -and $wire.writes.Count -eq 0) 'clean-reinstall:zero-node-read-before-delisting'
  $fixtureMachine.order.Clear()
  Throws $run 'FLEET_MAINTENANCE_DRAIN_TIMEOUT' 'clean-reinstall:drain-before-removal'
  Yes (($fixtureMachine.order -join ',') -ceq 'before-remove') 'clean-reinstall:no-mutation-before-drain'
  $fixtureMachine.refuseDrain = $false
  $checkConnection = $base.checkConnection
  $base.checkConnection = { throw 'FIXTURE_CONNECTION_REFUSED' }
  $oldEffects = @($fixtureMachine.order | Where-Object {$_ -like 'disable-*'}).Count
  Throws $run 'FIXTURE_CONNECTION_REFUSED' 'clean-reinstall:failed-connection-preflight-refuses'
  Yes (@($fixtureMachine.order | Where-Object {$_ -like 'disable-*'}).Count -eq $oldEffects) 'clean-reinstall:connection-before-stop'
  $base.checkConnection = $checkConnection
  Throws $run 'FIXTURE_CUT_AFTER_REMOVAL' 'clean-reinstall:cut-after-removal'
  Yes ($fixtureMachine.services.Count -eq 0 -and $fixtureMachine.tasks.Count -eq 0 -and -not $fixtureMachine.firewall -and -not $fixtureMachine.acl) 'clean-reinstall:Windows-removals-read-back'
  Yes (-not $fixtureMachine.dedicated -and -not $fixtureMachine.sharedResidue -and @(Get-FleetWslInventory $operator '').Count -eq 1) 'clean-reinstall:owner-unregister-and-shared-preserved'
  Yes ([IO.File]::Exists((Join-Path $FleetResources.ciRoot 'another-product\keep'))) 'clean-reinstall:unrelated-resource-preserved'
  Yes (-not [IO.File]::Exists((Join-Path $FleetResources.ciRoot 'resident\upgrade\current.json'))) 'clean-reinstall:malformed-pointer-removed'
  $packageA = Read-FleetProgress $file $base
  $carryA = Get-FleetCarryDirectory $packageA
  $delistA = $wire.operation
  $base.archiveSha256 = 'e' * 64
  $base.acceptanceSha256 = 'f' * 64
  $base.grantId = '53f65562-5419-4ca8-bff0-8783ebb1b0d2'
  Throws $run 'FLEET_REINSTALL_REQUIRES_PREVIEW' 'clean-reinstall:new-package-needs-own-preview'
  $base.previewReceipt = (Invoke-FleetMaintenance 'preview' $base).previewReceipt
  Throws $run 'FIXTURE_CUT_AFTER_WSL' 'clean-reinstall:cut-after-WSL'
  $packageB = Read-FleetProgress $file $base
  Yes ((Get-FleetCarryDirectory $packageB) -ceq $carryA -and $wire.operation -cne $delistA -and $wire.grant -ceq $base.grantId) 'clean-reinstall:new-grant-reuses-one-carry'
  Throws $run 'FIXTURE_CUT_AFTER_WINDOWS' 'clean-reinstall:forwards-across-half-WSL'
  Throws $run 'FLEET_MAINTENANCE_VERIFY_TIMEOUT' 'clean-reinstall:forwards-across-unconfirmed-Windows'
  $fixtureMachine.finished = $false
  Put-Fixture (Join-Path $FleetResources.ciRoot 'resident\upgrade\current.json')
  $wire.stale = $true
  $effects = $fixtureMachine.order.Count
  Throws $run 'FLEET_MAINTENANCE_STALE_DRAIN' 'clean-reinstall:old-drain-after-verify-refuses'
  Yes ($fixtureMachine.order.Count -eq ($effects + 1) -and [IO.File]::Exists((Join-Path $FleetResources.ciRoot 'resident\upgrade\current.json'))) 'clean-reinstall:old-drain-means-zero-deletions'
  $wire.stale = $false
  $fixtureMachine.finished = $true
  $fixtureMachine.refuseReturn = $false
  $done = & $run
  Yes ($done.status -ceq 'FLEET_LIFECYCLE_COMPLETE' -and $fixtureMachine.installedTries -eq 3) 'clean-reinstall:verified-resume-only-returns-to-service'
  Yes (@($fixtureMachine.order | Where-Object {$_ -ceq 'unregister-companion'}).Count -eq 2) 'clean-reinstall:only-two-real-WSL-residues-unregistered'
  Yes (@($fixtureMachine.order | Where-Object {$_ -ceq 'before-return'}).Count -eq 2) 'clean-reinstall:return-readback-retried'
} finally {
  [IO.Directory]::Delete($fixtureRoot, $true)
}
