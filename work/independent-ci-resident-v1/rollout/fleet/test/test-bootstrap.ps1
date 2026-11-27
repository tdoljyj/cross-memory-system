<#
  Offline check of rollout/fleet/bootstrap.ps1's pure functions (the asset set and its sums files, the prerequisite manifest, the
  elevated command and the UAC refusal). Nothing on the host is read or changed; the functions are taken from the real script by AST.
    powershell -NoProfile -ExecutionPolicy Bypass -File test-bootstrap.ps1
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions   # JavaScriptSerializer (Windows PowerShell 5.1 does not load it by itself)
$here = $PSScriptRoot
$script:n = 0
# Every failed check is named (a failure does not hide the checks after it); the run fails at the end when any did.
$script:failures = New-Object Collections.Generic.List[string]
function Yes([bool]$ok, [string]$what) { if (-not $ok) { $script:failures.Add($what) } else { $script:n++ } }
function Throws([scriptblock]$b, [string]$like, [string]$what) { $m = $null; try { & $b } catch { $m = $_.Exception.Message }; Yes ($null -ne $m -and $m -like $like) ($what + ' (got: ' + $m + ')') }
# A group of checks whose code may not exist yet: an exception fails the group by name, the run goes on.
function Case([string]$what, [scriptblock]$b) { try { & $b } catch { $script:failures.Add($what + ' (threw: ' + $_.Exception.Message + ')') } }

$file = Join-Path (Split-Path -Parent $here) 'bootstrap.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
Yes ($errors.Count -eq 0) 'parse:bootstrap.ps1'
$functions = @{}
foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
Case 'first-install:one-UAC' {
  $bootstrap = $functions['Invoke-Bootstrap']
  Yes ($bootstrap -match "Invoke-Elevated 'install'" -and $bootstrap -notmatch "Invoke-Elevated 'host'") 'first-install:host-and-launcher-use-one-elevation'
  Yes ($functions['Invoke-Stage'] -match "(?s)FIRST_INSTALL_HOST_READY.*Invoke-FirstInstallLauncher") 'first-install:launcher-starts-only-after-host-ready'
}
Case 'lifecycle:OS facts instead of the prior install receipt' {
  $bootstrap = $functions['Invoke-Bootstrap']
  Yes ($bootstrap -notmatch '\$ReceiptFile' -and $bootstrap -match 'Get-FleetLifecycleMode') 'lifecycle:single-entry-without-receipt-gate'
  Yes ($bootstrap -match 'upgrade\.mjs' -and $bootstrap -match 'FLEET_NODE_UPGRADE_NEEDS_REINSTALL') 'lifecycle:upgrade-and-same-package-reinstall'
  Yes ($bootstrap -match "'Retire'" -and $bootstrap -match "'Rollback'") 'lifecycle:explicit-actions'
}
Case 'lifecycle:protected destructive stage' {
  $stage = $functions['Invoke-Stage']
  Yes ($stage -match 'Invoke-FleetLifecycle' -and $stage -match 'ExpectedOperatorSid') 'lifecycle:one-protected-operation'
  $module = Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1'
  if (-not [IO.File]::Exists($module)) { throw 'lifecycle module missing' }
  . $module
  $empty = @{ complete = $true; residue = @() }
  $dirty = @{ complete = $true; residue = @('directory:resident') }
  Yes ((Get-FleetLifecycleMode 'Install' $empty $null) -ceq 'Fresh') 'lifecycle:truly-empty'
  Yes ((Get-FleetLifecycleMode 'Install' $dirty $null) -ceq 'InspectUpgrade') 'lifecycle:residual-machine'
  Yes ((Get-FleetLifecycleMode 'Install' $empty @{ mode = 'Reinstall' }) -ceq 'Resume') 'lifecycle:resume-before-empty'
  Yes ((Get-FleetLifecycleMode 'Rollback' $dirty $null) -ceq 'Rollback') 'lifecycle:only-explicit-rollback'
  Yes ((Get-FleetLifecycleMode 'Retire' $dirty $null) -ceq 'Retire') 'lifecycle:only-explicit-retirement'
  $block = Invoke-FleetMaintenance -Phase 'preview' -Context @{}
  Yes ($block.code -ceq 'FLEET_MAINTENANCE_ACTION_REFUSED') 'lifecycle:service-unavailable-before-delete'
}
Case 'lifecycle:durable cleanup and install readback' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  $directory = Join-Path $env:TEMP ('clued-lifecycle-test-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($directory)
  $file = Join-Path $directory 'operation.json'
  $context = @{ machine = 'FIXTURE'; operatorSid = 'S-1-5-21-1-2-3-1001'; archiveSha256 = 'a' * 64; acceptanceSha256 = 'b' * 64; action = 'Install' }
  $machine = @{ cleanup = $false; install = $false; verify = $false; return = $false; revoked = $false; operations = @(); phases = @() }
  function Invoke-FleetMaintenance([string]$Phase, $Context) {
    $machine.phases += $Phase
    if ($Phase -ceq 'before-return' -and $machine.revoked) { return @{ ok = $false; code = 'FLEET_TARGET_REVOKED' } }
    if ($Phase -ceq 'before-return') { $machine['return'] = $true }
    @{ ok = $true; sealed = $true; archiveSha256 = $Context.archiveSha256; acceptanceSha256 = $Context.acceptanceSha256
      operationId = $Context.operationId; ownerUac = $true; drained = $true; hasDuty = $false }
  }
  $observe = { param($step, $context) if ($machine[$step]) { 'complete' } else { 'pending' } }
  $apply = {
    param($step, $context)
    $machine.operations += $step
    $machine[$step] = $true
    if ($step -ceq 'cleanup') { throw 'TEST_AFTER_DELETE' }
    if ($step -ceq 'install') { throw 'TEST_AFTER_WINDOWS_SWITCH' }
  }
  try {
    Throws { Invoke-FleetLifecycle $context 'Reinstall' $file $observe $apply } 'TEST_AFTER_DELETE' 'lifecycle:interruption-after-delete'
    $saved = Read-FleetProgress $file $context
    Yes ($saved.step -ceq 'cleanup') 'lifecycle:cleanup-intent-persisted'
    Throws { Invoke-FleetLifecycle $context 'Resume' $file $observe $apply } 'TEST_AFTER_WINDOWS_SWITCH' 'lifecycle:interruption-after-switch'
    $machine.revoked = $true
    Throws { Invoke-FleetLifecycle $context 'Resume' $file $observe $apply } 'FLEET_TARGET_REVOKED' 'lifecycle:revocation-before-standby'
    Yes (($machine.operations -join ',') -ceq 'cleanup,install,verify' -and -not $machine['return']) 'lifecycle:no-repeat-cleanup-or-install'
    $machine.revoked = $false
    $done = Invoke-FleetLifecycle $context 'Resume' $file $observe $apply
    $last = Read-FleetProgress $file $context
    Yes ($done.status -ceq 'FLEET_LIFECYCLE_COMPLETE' -and $last.operationId -ceq $saved.operationId -and $last.step -ceq 'complete') 'lifecycle:same-operation-finishes'
    $other = $context.Clone(); $other.archiveSha256 = 'c' * 64
    Throws { Read-FleetProgress $file $other } 'FLEET_PROGRESS_DIFFERS:archiveSha256' 'lifecycle:another-package-refused'
    foreach ($action in @('Retire','Rollback')) {
      [IO.File]::Delete($file)
      $context.action = $action
      $machine.operations = @()
      Throws { Invoke-FleetLifecycle $context $action $file $observe $apply } 'FLEET_MAINTENANCE_NOT_SAFE_TO_REMOVE' ('lifecycle:' + $action + ':authorization-required')
      Yes ($machine.operations.Count -eq 0) ('lifecycle:' + $action + ':no-cleanup-before-authorization')
    }
  } finally {
    foreach ($name in @('operation.json','operation.json.pending')) { [IO.File]::Delete((Join-Path $directory $name)) }
    [IO.Directory]::Delete($directory)
  }
}
Case 'lifecycle:paths and native credential carriers' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  $directory = Join-Path $env:TEMP ('clued-lifecycle-paths-' + [Guid]::NewGuid().ToString('N'))
  $FleetResources.ciRoot = Join-Path $directory 'product'
  $FleetResources.controlRoot = Join-Path $directory 'control'
  $FleetResources.journalRoot = $directory
  function Assert-FleetJournalRoot([string]$root) { [void][IO.Directory]::CreateDirectory($root) }
  $ctx = @{ operationId = 'a'*32; maintenance = @{ connection = @{ heartbeatToken = @{} } } }
  $carry = Get-FleetCarryDirectory $ctx
  $paths = @('resident\upgrade\current.json','resident\state\ledger\old.json','resident-uninstalled-fixture\old',
    'wsl\CluedResident-Linux\fixture','secrets\ci-admission.token','secrets\ci-admission.connection.json','another-product\fixture') + @($FleetResources.stagedTokens.Keys)
  try {
    [void][IO.Directory]::CreateDirectory($carry)
    foreach ($relative in $paths) {
      $file = Join-Path $FleetResources.ciRoot $relative
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
      [IO.File]::WriteAllText($file, 'offline-fixture')
    }
    $app = Join-Path $FleetResources.controlRoot $FleetResources.controlKey
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($app))
    [IO.File]::WriteAllText($app, 'offline-fixture')
    # The pointer and ledger are arbitrary bytes and the receipt is absent.
    # Only the exact per-resident token filenames are carried across removal.
    $null = Save-FleetConnectionCarriers $ctx
    $renewed = Join-Path $FleetResources.ciRoot 'resident\secrets\resident-upgrade.token'
    [IO.File]::WriteAllText($renewed, 'rotated-offline-fixture')
    $null = Save-FleetConnectionCarriers $ctx
    Yes ([IO.File]::ReadAllText((Join-Path $carry 'resident-upgrade.token')) -ceq 'rotated-offline-fixture') 'lifecycle:current-token-replaces-old-carry'
    Remove-FleetProductPaths
    Yes (@(Get-FleetProductPaths).Count -eq 0) 'lifecycle:malformed-old-product-paths-removed'
    foreach ($name in $FleetResources.stagedTokens.Values) {
      Yes ([IO.File]::Exists((Join-Path $carry $name))) ('lifecycle:carrier-preserved:' + $name)
    }
    foreach ($name in @($FleetResources.admissionAssets + @('another-product\fixture'))) {
      Yes ([IO.File]::Exists((Join-Path $FleetResources.ciRoot $name))) ('lifecycle:unrelated-or-connection-left-in-place:' + $name)
    }
  } finally {
    if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory, $true) }
  }
}
Case 'lifecycle:retry cannot use a previously drained result to delete' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  $ctx = @{ archiveSha256='a'*64; acceptanceSha256='b'*64; sourceSha256='c'*64; operationId='d'*32
    mode='Reinstall'; retryingInstall=$true; install={ throw 'FIXTURE_INSTALL_REACHED' }; effects=[Collections.Generic.List[string]]::new() }
  function Invoke-FleetMaintenance {
    @{ok=$true; sealed=$true; archiveSha256=$ctx.archiveSha256; acceptanceSha256=$ctx.acceptanceSha256
      operationId=$ctx.operationId; ownerUac=$true; drained=$true; hasDuty=$false}
  }
  function Get-FleetStepState { if ($ctx.effects.Count) { 'complete' } else { 'pending' } }
  function Invoke-FleetCleanup { $ctx.effects.Add('delete') }
  Throws { Invoke-FleetStep 'install' $ctx } 'FLEET_MAINTENANCE_STALE_DRAIN' 'lifecycle:old-removal-receipt-refused-at-cleanup'
  Yes ($ctx.effects.Count -eq 0) 'lifecycle:replayed-drain-cannot-delete'
}
Case 'lifecycle:another package cannot use an earlier preview' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  $file = Join-Path $env:TEMP ('fleet-other-package-' + [Guid]::NewGuid().ToString('N') + '.json')
  $a = @{machine='FIXTURE';operatorSid='S-1-5-21-1-2-3-1001';action='Install';archiveSha256='a'*64;acceptanceSha256='b'*64}
  try {
    $progress = New-FleetProgress $a 'Reinstall'; $progress.step = 'install'
    Write-FleetProgress $file $progress
    $packageB = $a.Clone(); $packageB.archiveSha256 = 'c'*64; $packageB.acceptanceSha256='d'*64; $packageB.grantId='73f65562-5419-4ca8-bff0-8783ebb1b0d2'
    Throws { Invoke-FleetLifecycle $packageB 'Resume' $file { 'pending' } { throw 'FIXTURE_EFFECT_REACHED' } } 'FLEET_REINSTALL_REQUIRES_PREVIEW' 'lifecycle:new-package-requires-preview-instead-of-digest-deadlock'
  } finally { [IO.File]::Delete($file); [IO.File]::Delete($file + '.pending') }
}
Case 'lifecycle:upgrader operation heartbeat belongs to the live service child' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  . ([scriptblock]::Create($functions['Get-Key']))
  $at = [DateTimeOffset]::UtcNow.AddMinutes(-11)
  $service = @{Name='CluedCIUpgrader';State='Running';ProcessId=42}
  $pulse = @{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();token='fixture'}
  function Get-FleetServices { $service }
  function Read-FleetConnectionJson([string]$file) {
    if ([IO.Path]::GetFileName($file) -ceq 'holder.json') { return @{pid=84;token='fixture'} }
    $pulse
  }
  $child = @{ProcessId=84;ParentProcessId=42;CreationDate=$at.UtcDateTime.AddMinutes(-1)}
  function Get-CimInstance { $child }
  $answer = @{statusAt=$at.ToString('o');upgraderPid=84;op=@{opId='93f65562-5419-4ca8-bff0-8783ebb1b0d2'}}
  Yes (Test-FleetUpgradeInProgress $answer) 'lifecycle:long-live-upgrader-is-not-abandoned'
  $pulse.at = $at.ToUnixTimeMilliseconds()
  Yes (Test-FleetUpgradeInProgress $answer) 'lifecycle:frozen-upgrader-pulse-between-ticks'
  $pulse.token = 'another-holder'
  Throws { Test-FleetUpgradeInProgress $answer } 'FLEET_UPGRADER_HEARTBEAT_UNKNOWN' 'lifecycle:heartbeat-from-another-holder'
  $pulse.token = 'fixture'
  $child.ParentProcessId = 43
  Throws { Test-FleetUpgradeInProgress $answer } 'FLEET_UPGRADER_HEARTBEAT_UNKNOWN' 'lifecycle:child-belongs-to-another-service'
  $child.ParentProcessId = 42
  $child.CreationDate = $at.UtcDateTime.AddMinutes(1)
  Throws { Test-FleetUpgradeInProgress $answer } 'FLEET_UPGRADER_HEARTBEAT_UNKNOWN' 'lifecycle:reused-pid-postdates-the-pulse'
  $service.State = 'Stopped'; $service.ProcessId = 0
  Yes (-not (Test-FleetUpgradeInProgress $answer)) 'lifecycle:stopped-upgrader-can-be-abandoned'
}
Case 'lifecycle:Windows registration identifies WSL ownership before cleanup' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  $operator = 'S-1-5-21-1-2-3-1001'
  $companion = 'S-1-5-21-1-2-3-1002'
  $opProfile = 'C:\Users\FixtureOperator'
  $coProfile = 'C:\Users\FixtureCompanion'
  $ownedBase = Join-Path $FleetResources.ciRoot $FleetResources.distributionDirectories[0]
  function Get-FleetWslRegistryRows([string]$sid) {
    if ($sid -ceq $operator) {
      @{ id = '{11111111-1111-4111-8111-111111111111}'; name = 'CluedResident-Linux'; basePath = ($opProfile + '\WSL\CluedResident-Linux') }
      @{ id = '{22222222-2222-4222-8222-222222222222}'; name = 'Ubuntu-24.04'; basePath = ($opProfile + '\AppData\Local\wsl\fixture') }
      @{ id = '{33333333-3333-4333-8333-333333333333}'; name = 'Unrelated'; basePath = 'D:\AnotherProduct' }
    } else {
      @{ id = '{44444444-4444-4444-8444-444444444444}'; name = 'CluedResident-Linux'; basePath = $ownedBase }
    }
  }
  $first = @(Get-FleetWslInventory $operator $opProfile)
  $second = @(Get-FleetWslInventory $companion $coProfile)
  Yes ($first.Count -eq 2 -and $first[0].kind -ceq 'dedicated' -and $first[0].ownerSid -ceq $operator) 'lifecycle:dedicated-operator-vhd-identified'
  Yes ($first[1].kind -ceq 'shared-candidate' -and $first[1].ownerSid -ceq $operator) 'lifecycle:shared-distro-is-only-a-candidate'
  Yes ($second.Count -eq 1 -and $second[0].kind -ceq 'dedicated' -and $second[0].ownerSid -ceq $companion -and $second[0].basePath -ceq $ownedBase) 'lifecycle:dedicated-companion-vhd-bound-to-sid'
  $ownedBase = 'D:\UnrelatedVhd'
  Throws { Get-FleetWslInventory $companion $coProfile } 'FLEET_WSL_REGISTRATION_PATH_REFUSED' 'lifecycle:dedicated-name-alone-cannot-authorize-cleanup'
}
Case 'lifecycle:cleanup readback excludes preserved connection carriers' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  $fixture = @{ complete = $true; residue = @(); wsl = @() }
  $kept = @('directory:ci-root', 'directory:app-key', 'account:clued-control', 'account:clued-companion')
  $paths = @('resident\upgrade\current.json')
  $residentAce = $true
  function Get-FleetInventory { $fixture }
  function Get-FleetProductPaths { $paths }
  function Test-FleetResidentRootAce { $residentAce }
  function Test-FleetOldConnectionSidecar { $false }
  function Invoke-FleetOwnedWsl { throw 'FIXTURE_WSL_READBACK_UNKNOWN' }
  $fixture.residue = $kept + @('service:CluedCIResident','task:CluedCIResidentCompanion','firewall:CluedCIResident-BlockOutbound',
    'wsl:S-1-5-21-1-2-3-1002:CluedResident-Linux')
  Yes ((Get-FleetStepState 'cleanup' @{}) -ceq 'pending') 'lifecycle:Windows-effects-remain'
  $fixture.residue = $kept
  Yes ((Get-FleetStepState 'cleanup' @{}) -ceq 'pending') 'lifecycle:malformed-pointer-still-counts-as-residue'
  $paths = @()
  Yes ((Get-FleetStepState 'cleanup' @{}) -ceq 'pending') 'lifecycle:resident-ACE-still-counts-as-residue'
  $residentAce = $false
  $fixture.wsl = @(@{kind = 'shared-candidate'})
  Yes ((Get-FleetStepState 'cleanup' @{}) -ceq 'unknown') 'lifecycle:shared-Linux-needs-its-own-proof'
  $fixture.wsl = @()
  Yes ((Get-FleetStepState 'cleanup' @{}) -ceq 'complete') 'lifecycle:preserved-resources-do-not-block-readback'
}
Case 'lifecycle:clean reinstall chain through native boundaries' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  . ([scriptblock]::Create($functions['Get-Key']))
  . (Join-Path $here 'test-clean-reinstall.ps1')
}
Case 'lifecycle:maintenance RPC status, consent and replay' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  . ([scriptblock]::Create($functions['Get-Key']))
  $node = @{scope='global';nodeId='03f65562-5419-4ca8-bff0-8783ebb1b0d2';bindingId='83f65562-5419-4ca8-bff0-8783ebb1b0d2';generation=3}
  $ctx = @{ repository='fixture/repo'; machine='FIXTURE'; action='Install'; archiveSha256='a'*64
    acceptanceSha256='b'*64; sourceSha256='c'*64; operationId='d'*32; zeroNodeConsent=$false; ownerUac=$true
    nodeConnection=$node; grantId='73f65562-5419-4ca8-bff0-8783ebb1b0d2'; installed=@{status='verified'} }
  $start = [DateTimeOffset]::Parse('2026-11-27T00:00:00Z')
  $wire = @{mode='missing';clock=$start;writes=0;commands=@()}
  $clock = { $wire.clock }
  $wait = { $wire.clock = $wire.clock.AddMinutes(15) }
  $send = {
    param($request)
    $wire.commands += $request.command
    if ($wire.mode -ceq 'missing') { throw 'FLEET_MAINTENANCE_REQUEST_FAILED' }
    if ($request.command -cne 'status') {
      $wire.writes++
      Yes ($request.operation_id -ceq ([Guid]$ctx.operationId).ToString('D') -and $request.grant_id -ceq $ctx.grantId) 'lifecycle:write-binds-grant-operation'
      if ($request.command -ceq 'delist') {
        Yes ($request.method -ceq 'reinstall' -and $request['sole_node_agreed'] -eq $true) 'lifecycle:sole-consent-on-reinstall-only'
      }
    }
    $r = @{status='ok'; state='delisted'; has_other_healthy=$false; install_ready=$true; node_id=$node.nodeId
      grant_id=$ctx.grantId; binding_generation=$node.generation; operation_id=([Guid]$ctx.operationId).ToString('D')
      receipt_id='63f65562-5419-4ca8-bff0-8783ebb1b0d2'; drain_confirmed_at=$wire.clock.ToString('o')}
    switch ($wire.mode) {
      'draining' { $r.install_ready = $false }
      'stale' { $r.drain_confirmed_at = $wire.clock.AddMinutes(-10).ToString('o') }
      'verify' { $r.install_ready = $false; $r.verify_started_at = $start.ToString('o') }
      'returned' { $r.install_ready = $false; $r.state = 'returned' }
      'wrong-node' { $r.node_id = $r.receipt_id }
    }
    $r
  }
  $answer = Invoke-FleetMaintenance 'preview' $ctx -Send $send -Wait $wait -Now $clock
  Yes ($answer.code -ceq 'FLEET_MAINTENANCE_REQUEST_FAILED') 'lifecycle:missing-interface-fails-closed'
  $wire.mode = 'ready'
  $answer = Invoke-FleetMaintenance 'preview' $ctx -Send $send -Wait $wait -Now $clock
  Assert-FleetPreview $answer $ctx
  Yes ($answer.healthyPeers -eq 0 -and $wire.writes -eq 0) 'lifecycle:authorized-zero-node-preview'
  $answer = Invoke-FleetMaintenance 'before-remove' $ctx -Send $send -Wait $wait -Now $clock
  Yes ($answer.code -ceq 'FLEET_MAINTENANCE_NEEDS_SOLE_NODE_CONSENT' -and $wire.writes -eq 0) 'lifecycle:zero-node-refused-without-consent'
  $ctx.zeroNodeConsent = $true
  $wire.commands = @()
  $answer = Invoke-FleetMaintenance 'before-remove' $ctx -Send $send -Wait $wait -Now $clock
  Yes ($answer.ok -and ($wire.commands -join ',') -ceq 'status,delist,status') 'lifecycle:delist-readback-after-write'
  $wire.mode = 'draining'
  $answer = Invoke-FleetMaintenance 'before-remove' $ctx -Send $send -Wait $wait -Now $clock
  Yes ($answer.code -ceq 'FLEET_MAINTENANCE_DRAIN_TIMEOUT') 'lifecycle:drain-wait-bounded'
  $wire.mode = 'stale'; $ctx.requireFreshDrain = $true
  $answer = Invoke-FleetMaintenance 'before-remove' $ctx -Send $send -Wait $wait -Now $clock
  Yes ($answer.code -ceq 'FLEET_MAINTENANCE_STALE_DRAIN') 'lifecycle:old-delisted-ready-is-refused'
  $wire.mode = 'verify'; $wire.clock = $start.AddMinutes(30)
  $answer = Invoke-FleetMaintenance 'before-return' $ctx -Send $send -Wait $wait -Now $clock
  Yes ($answer.code -ceq 'FLEET_MAINTENANCE_VERIFY_TIMEOUT' -and $wire.clock -eq $start.AddMinutes(45)) 'lifecycle:post-start-deadline-stays-anchored'
  $wire.mode = 'returned'
  $answer = Invoke-FleetMaintenance 'before-return' $ctx -Send $send -Wait $wait -Now $clock
  Yes ($answer.ok) 'lifecycle:server-returns-node-after-verification'
  $wire.mode = 'wrong-node'
  $answer = Invoke-FleetMaintenance 'before-return' $ctx -Send $send -Wait $wait -Now $clock
  Yes ($answer.code -ceq 'FLEET_MAINTENANCE_SUBJECT_REFUSED') 'lifecycle:other-node-reply-refused'
}

foreach ($name in @('Get-Key', 'Read-Sha256Sums', 'Get-ReleaseVersion', 'Get-RequiredAssets', 'Test-AssetSet', 'Test-PrereqManifest', 'Get-LastJsonLine', 'Get-ElevatedArguments', 'Test-UacDeclined',
    'Test-SafePath', 'Test-SafeArgument', 'Get-ExtractState', 'Get-StageFailure', 'Test-StageOperator',
    'Sha256File', 'Invoke-StageChild', 'Clear-CredentialDirectory', 'Test-FirstInstallCheck', 'Copy-ToWork', 'Test-UnderDirectory', 'Get-LauncherVerdict',
    'Get-NeededPrereqs', 'Expand-Cached', 'ConvertTo-PlainData', 'ConvertTo-JsonLine', 'Out-Result', 'Out-Step', 'Add-ResultLine', 'Get-StageVerdict', 'Read-StageResult',
    'Invoke-FirstInstallLauncher', 'Complete-InstallStageVerdict', 'Get-InstallStageVerdict', 'Copy-BootstrapEvidence')) {
  Yes ($functions.ContainsKey($name)) ('present:' + $name); if ($functions.ContainsKey($name)) { . ([scriptblock]::Create($functions[$name])) }
}
Case 'lifecycle:protected journal routing' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  $directory = Join-Path $env:TEMP ('clued-lifecycle-routing-' + [Guid]::NewGuid().ToString('N'))
  $FleetResources.journalRoot = Join-Path $directory 'journal'
  $root = $FleetResources.journalRoot
  $file = Join-Path $root 'operation.json'
  $context = @{ machine = 'FIXTURE'; operatorSid = 'S-1-5-21-1-2-3-1001'; archiveSha256 = 'a' * 64; acceptanceSha256 = 'b' * 64; action = 'Install' }
  $fixture = @{}
  function Get-FleetInventory { @{ complete = $true; residue = @('directory:resident') } }
  function Get-FleetNewInstall { $null }
  function Invoke-FleetLifecycle { throw 'UNEXPECTED_REINSTALL' }
  function Get-Acl([string]$LiteralPath) {
    if ($LiteralPath -cne $root) { throw 'UNEXPECTED_ACL_PATH' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $sddl = if ($fixture['aclRefused']) { 'O:BAG:BAD:P(A;OICI;FA;;;WD)' } else { 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' }
    $acl.SetSecurityDescriptorSddlForm($sddl)
    $acl
  }
  $body = $functions['Invoke-Stage']
  $start = $body.IndexOf('$facts = Get-FleetInventory')
  $end = $body.IndexOf('$clearCredentials = $true', $start)
  $route = [scriptblock]::Create($body.Substring($start, $end - $start))
  function Invoke-FixtureRouting([bool]$Reset) {
    $Action = 'Install'; $LifecycleMode = 'Probe'; $PreviewReceipt = $null; $out = $null; $verdict = $null
    $progress = $null
    try { . $route } catch { $fixture.error = $_.Exception.Message }
    finally { $fixture.verdict = $verdict; $fixture.progress = $progress }
  }
  try {
    [void][IO.Directory]::CreateDirectory($root)
    Invoke-FixtureRouting $false
    Yes ($null -eq $fixture['error'] -and (Get-Key $fixture.verdict 'status') -ceq 'FLEET_LIFECYCLE_RESELECT' -and -not [IO.Directory]::Exists($root)) ('lifecycle:empty-journal-releases-upgrade-routing (got: ' + $fixture['error'] + ')')

    [void][IO.Directory]::CreateDirectory($root)
    $fixture.Clear(); $fixture.aclRefused = $true
    Invoke-FixtureRouting $false
    Yes ($fixture['error'] -like ('FLEET_JOURNAL_ACL_REFUSED:*' + $root + '*') -and [IO.Directory]::Exists($root)) ('lifecycle:untrusted-journal-refusal-identifies-path (got: ' + $fixture['error'] + ')')

    $fixture.Clear()
    $hidden = Join-Path $root 'keep.txt'
    [IO.File]::WriteAllText($hidden, 'fixture')
    [IO.File]::SetAttributes($hidden, [IO.FileAttributes]::Hidden)
    Invoke-FixtureRouting $false
    Yes ($fixture['error'] -ceq 'FLEET_REINSTALL_REQUIRES_PREVIEW' -and [IO.File]::Exists($hidden)) ('lifecycle:nonempty-journal-is-not-removed (got: ' + $fixture['error'] + ')')
    [IO.File]::Delete($hidden)

    $fixture.Clear()
    $fresh = New-FleetProgress $context 'Fresh'; $fresh.step = 'launcher'
    Write-FleetProgress $file $fresh
    $output = Join-Path $root ('launcher-' + $fresh.operationId + '.jsonl')
    Invoke-FixtureRouting $false
    Yes ($fixture['error'] -ceq 'FLEET_REINSTALL_REQUIRES_PREVIEW' -and (Read-FleetProgress $file $context).step -ceq 'launcher') ('lifecycle:unknown-launcher-result-does-not-retry (got: ' + $fixture['error'] + ')')
    Add-ResultLine $output '{"contract":"clued.independent-ci.source-v2-windows-launch-terminal/1","status":"STOPPED","code":"FIXTURE_STOP"}'
    foreach ($resetRequested in @($false, $true)) {
      $fixture.Clear()
      Write-FleetProgress $file $fresh
      Invoke-FixtureRouting $resetRequested
      Yes ($null -eq $fixture['error'] -and $fixture.progress.step -ceq 'install' -and (Read-FleetProgress $file $context).step -ceq 'install') ('lifecycle:terminal-failure-reopens-install:reset=' + $resetRequested + ' (got: ' + $fixture['error'] + ')')
    }

    $fixture.Clear()
    $other = $context.Clone(); $other.archiveSha256 = 'c' * 64; $other.acceptanceSha256 = 'd' * 64
    $old = New-FleetProgress $other 'Fresh'; $old.step = 'install'
    Write-FleetProgress $file $old
    $oldBytes = [IO.File]::ReadAllText($file)
    Invoke-FixtureRouting $false
    $archived = @(Get-ChildItem -LiteralPath $directory -Recurse -Filter 'operation.json' -File -Force)
    Yes ($null -eq $fixture['error'] -and $null -eq $fixture.progress -and -not [IO.File]::Exists($file) -and $archived.Count -eq 1 -and
      [IO.File]::ReadAllText($archived[0].FullName) -ceq $oldBytes) ('lifecycle:new-package-archives-stale-fresh-progress (got: ' + $fixture['error'] + ')')
  } finally {
    if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory, $true) }
  }
}
Case 'lifecycle:reselect routes back through the non-elevated entry' {
  . (Join-Path (Split-Path -Parent $here) 'package-lifecycle.ps1')
  $body = $functions['Invoke-Bootstrap']
  $start = $body.IndexOf('while ($true) {')
  $route = [scriptblock]::Create($body.Substring($start, $body.LastIndexOf('}') - $start))
  function Invoke-ReselectFixture([bool]$reappears) {
    $fixture = @{ inventory = 0; elevated = 0; upgrades = 0 }
    $Action = 'Install'; $Reset = $false; $hostInputs = @('-Tar', 'fixture.tar'); $reselected = $false; $protectedPreview = $null
    $acceptLocal = $acceptance = 'fixture.json'; $archiveSha = 'a' * 64; $operator = 'fixture-operator'
    $install = Join-Path $env:TEMP 'fixture\install.mjs'
    $tar = 'fixture.tar'; $nodeExe = @('fixture-node'); $childEnv = @{}
    $HostLimitSeconds = $LauncherLimitSeconds = 1
    function Get-FleetInventory { $fixture.inventory++; @{ complete = $true; residue = @('directory:resident') } }
    function Test-FleetProgressHint { $fixture.inventory -eq 1 -or $reappears }
    function New-FleetContext { @{} }
    function Invoke-FleetMaintenance { @{ ok = $false; code = 'FIXTURE_PREVIEW_UNAVAILABLE' } }
    function Invoke-Elevated { $fixture.elevated++; @{ declined = $false; last = @{ status = 'FLEET_LIFECYCLE_RESELECT' } } }
    function Invoke-NonElevated { $fixture.upgrades++; @{ exit = 0; last = @{ status = 'FLEET_NODE_UPGRADE_REQUESTED' } } }
    function Out-Step { }
    function Out-Result([string]$status) { $fixture.result = $status }
    function Stop-Bootstrap([string]$step, [string]$code) { throw $code }
    $saved = Get-Variable -Name Work -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    try { $script:Work = $env:TEMP; & $route }
    catch { $fixture['error'] = $_.Exception.Message }
    finally { $script:Work = $saved }
    $fixture
  }
  $routed = Invoke-ReselectFixture $false
  Yes ($routed.inventory -eq 2 -and $routed.elevated -eq 1 -and $routed.upgrades -eq 1 -and
    $routed['result'] -ceq 'FLEET_NODE_UPGRADE_REQUESTED') ('lifecycle:cleared-hint-reaches-upgrade-without-a-second-elevation (got: ' + (ConvertTo-Json -InputObject $routed -Compress) + ')')
  $repeated = Invoke-ReselectFixture $true
  Yes ($repeated.inventory -eq 2 -and $repeated.elevated -eq 2 -and $repeated.upgrades -eq 0 -and
    $repeated['error'] -ceq 'FLEET_LIFECYCLE_RESELECT_REPEATED') 'lifecycle:reselect-stops-if-journal-reappears'
}
Case 'first-install:launcher failure keeps evidence after staging cleanup' {
  $fixture = Join-Path $env:TEMP ('clued-bootstrap-evidence-' + [guid]::NewGuid().ToString('N'))
  $stage = Join-Path $fixture 'staging'
  $work = Join-Path $stage 'prepare'
  $launch = Join-Path $work 'launch-fixture'
  function New-BootstrapFailureDirectory {
    $saved = Join-Path $fixture 'saved'
    [void][IO.Directory]::CreateDirectory($saved)
    $saved
  }
  try {
    [void][IO.Directory]::CreateDirectory($launch)
    foreach ($name in @('first-train-report.json', 'companion-headless-report.json')) { [IO.File]::WriteAllText((Join-Path $launch $name), '{}') }
    [IO.File]::WriteAllText((Join-Path $work 'install-plan.json'), '{}')
    $failed = Complete-InstallStageVerdict @{ status = 'STOPPED'; code = 'FIXTURE_LAUNCHER_REFUSED'; bootstrapPhase = 'launcher' } $stage
    [IO.Directory]::Delete($stage, $true)
    $v = Get-InstallStageVerdict $failed
    Yes ($v.status -ceq 'BOOTSTRAP_LAUNCHER_ENDED' -and $v.code -ceq 'FIXTURE_LAUNCHER_REFUSED') 'first-install:retains-launcher-refusal'
    foreach ($name in @('install-plan.json','launch-fixture\first-train-report.json','launch-fixture\companion-headless-report.json')) {
      Yes ([IO.File]::Exists((Join-Path $v.evidenceDirectory $name))) ('first-install:retains:' + $name)
    }
  } finally {
    [IO.Directory]::Delete($fixture, $true)
  }
}
Case 'first-install:stage failure keeps the original refusal' {
  $failed = Get-StageFailure 'install' ([InvalidOperationException]::new('PROTECTED_INSTALL_INPUTS_REFUSED'))
  $v = Get-InstallStageVerdict $failed
  Yes ($v.status -ceq 'HOST_PREPARATION_NOT_DONE' -and $v.code -ceq 'PROTECTED_INSTALL_INPUTS_REFUSED' -and $v.message -ceq $failed.message) 'first-install:stage-refusal-code'
  $hostFailure = Get-InstallStageVerdict @{ status = 'FIRST_INSTALL_HOST_REFUSED'; code = 'WSL_UNAVAILABLE'; message = 'Host refused' }
  Yes ($hostFailure.status -ceq 'HOST_PREPARATION_NOT_DONE' -and $hostFailure.code -ceq 'WSL_UNAVAILABLE' -and $hostFailure.message -ceq 'Host refused') 'first-install:host-refusal-code'
}
# the constants the functions read, from the script itself
foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] }, $false)) {
  if ($a.Left.Extent.Text -cin @('$PrereqContract', '$PrereqNames', '$PowerShellExe', '$WorkParent')) { . ([scriptblock]::Create($a.Extent.Text)) }
}
Yes ($PrereqContract -ceq 'clued.independent-ci.fleet-node-prereq-manifest/1' -and $PrereqNames.Count -eq 9 -and $PrereqNames -ccontains 'wsl' -and $PrereqNames -ccontains 'gh' -and $PrereqNames -ccontains 'git-for-windows') 'constants'
$text = [IO.File]::ReadAllText($file)
$js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue   # reads lines longer than the default 2,097,152
$h1 = 'a' * 64; $h2 = 'b' * 64; $h3 = 'c' * 64; $img = 'd' * 64
$v = '2026.11.16-1'; $t = 'fleet-node-' + $v

# ---- sums files
$s = Read-Sha256Sums ("$h1  $t.tar`r`n$h2  $t.release.json`n")
Yes ($s.Count -eq 2 -and $s["$t.tar"] -ceq $h1 -and $s["$t.release.json"] -ceq $h2) 'sums:crlf-and-lf'
Throws { Read-Sha256Sums "$h1  a`n$h2  a`n" } 'BOOTSTRAP_SUMS_DUPLICATE:*' 'sums:duplicate'
Throws { Read-Sha256Sums "$h1  sub/a`n" } 'BOOTSTRAP_SUMS_REFUSED:*' 'sums:path-refused'
Throws { Read-Sha256Sums (('A' * 64) + "  a`n") } 'BOOTSTRAP_SUMS_REFUSED:*' 'sums:upper-hex-refused'
Throws { Read-Sha256Sums "$h1 a`n" } 'BOOTSTRAP_SUMS_REFUSED:*' 'sums:one-blank-refused'

# ---- the version, the asset set
Yes ((Get-ReleaseVersion @("$t.tar", "$t.release.json", 'SHA256SUMS')) -ceq $v) 'version'
Throws { Get-ReleaseVersion @('SHA256SUMS') } 'BOOTSTRAP_NOT_ONE_ARCHIVE:0' 'version:none'
Throws { Get-ReleaseVersion @("$t.tar", 'fleet-node-2026.11.16-2.tar') } 'BOOTSTRAP_NOT_ONE_ARCHIVE:2' 'version:two'
$release = [ordered]@{ "$t.tar" = $h1; "$t.release.json" = $h2; "$t.bootstrap.ps1" = $h3; "$t.prereq-manifest.json" = $h1 }
$reinstall = @("$t.tar", "$t.release.json", 'SHA256SUMS', "$t.bootstrap.ps1", "$t.prereq-manifest.json", "$t.acceptance.json")
Yes ((Test-AssetSet $reinstall $release $null $v $false @()).Count -eq 0) 'assets:reinstall-complete'
$c = Test-AssetSet ($reinstall + 'notes.txt') $release $null $v $false @()
Yes ($c.Count -eq 1 -and $c[0] -ceq 'ASSET_NOT_LISTED:notes.txt') 'assets:unlisted-file-refused'
$c = Test-AssetSet ($reinstall | Where-Object { $_ -cne "$t.bootstrap.ps1" }) $release $null $v $false @()
Yes ($c -ccontains "ASSET_LISTED_NOT_PRESENT:$t.bootstrap.ps1" -and $c -ccontains "ASSET_REQUIRED_MISSING:$t.bootstrap.ps1") 'assets:listed-missing-refused'
$c = Test-AssetSet ($reinstall | Where-Object { $_ -cne "$t.acceptance.json" }) $release $null $v $false @()
Yes ($c.Count -eq 1 -and $c[0] -ceq "ASSET_REQUIRED_MISSING:$t.acceptance.json") 'assets:acceptance-required'
Yes ((Test-AssetSet ($reinstall + 'node-v24.21.0-win-x64.zip') $release $null $v $false @('node-v24.21.0-win-x64.zip')).Count -eq 0) 'assets:a-prerequisite-may-lie-there'
$c = Test-AssetSet $reinstall $release $null $v $true @()
Yes ($c -ccontains "ASSET_REQUIRED_MISSING:$t.first-install-kit.json" -and $c -ccontains "ASSET_REQUIRED_MISSING:$t.first-install.SHA256SUMS") 'assets:first-install-needs-the-kit'
$first = [ordered]@{ "$t.first-install-kit.json" = $h2; "role-image-$img.tar.gz" = $h3 }
$all = $reinstall + @("$t.first-install-kit.json", "role-image-$img.tar.gz", "$t.first-install.SHA256SUMS")
Yes ((Test-AssetSet $all $release $first $v $true @()).Count -eq 0) 'assets:first-install-complete'
$c = Test-AssetSet ($all | Where-Object { $_ -cne "role-image-$img.tar.gz" }) $release $first $v $true @()
Yes ($c.Count -eq 1 -and $c[0] -ceq "ASSET_LISTED_NOT_PRESENT:role-image-$img.tar.gz") 'assets:image-missing-refused'
$bad = [ordered]@{ "$t.first-install-kit.json" = $h2; "role-image-$img.tar.gz" = $h3; "$t.tar" = $h1 }
$c = Test-AssetSet $all $release $bad $v $true @()
Yes ($c -ccontains "ASSET_IN_BOTH_SUMS:$t.tar" -and $c -ccontains "FIRST_INSTALL_SUMS_NAMES_OTHER:$t.tar") 'assets:first-sums-names-only-kit-and-images'
$rel2 = [ordered]@{}; foreach ($k in @($release.Keys)) { $rel2[$k] = $release[$k] }; $rel2["role-image-$img.tar.gz"] = $h3
$c = Test-AssetSet $all $rel2 $null $v $true @()
Yes ($c -ccontains "RELEASE_SUMS_NAMES_FIRST_INSTALL_ASSET:role-image-$img.tar.gz") 'assets:release-sums-never-names-an-image'

# ---- the prerequisite manifest: the committed one pins what the drill VM proved (WSL MSI, rootfs, the 16 docker .debs and the five
#      python3.12 .debs whose /usr/bin/python3.12 is the fleet's pin) and refuses the rest until
#      the coordinator pins it (M6, M7)
$committed = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path (Split-Path -Parent $here) 'prereq-manifest.json')))
$c = Test-PrereqManifest $committed
$unpinned = @($c | Where-Object { $_ -like 'PREREQ_NOT_PINNED:*' } | ForEach-Object { $_.Substring(18) } | Sort-Object)
Yes ($c.Count -eq 0 -and @($committed['items'] | Where-Object { [string]$_['sha256'] -cnotmatch '^[0-9a-f]{64}$' -or -not ($_['bytes'] -gt 0) -or [string]::IsNullOrEmpty([string]$_['url']) }).Count -eq 0) ('prereq:committed-pins-every-item ' + ($c -join ','))
$wslItem = @($committed['items'] | Where-Object { $_['name'] -ceq 'wsl' })[0]
Yes ($wslItem['sha256'] -ceq 'a3505a50f4cc585551d11d9de824ba4375448d7a68f2e71d3fb315fa986fc754' -and $wslItem['version'] -ceq '2.7.13.0' -and $wslItem['kind'] -ceq 'msi') 'prereq:wsl-msi-pinned'
Yes (@($committed['debs']).Count -eq 21 -and @($committed['debs'] | Where-Object { [string]$_['sha256'] -cnotmatch '^[0-9a-f]{64}$' }).Count -eq 0 -and @($committed['debs'] | Where-Object { $_['package'] -ceq 'docker.io' }).Count -eq 1 -and @($committed['debs'] | Where-Object { [string]$_['package'] -cmatch '^(lib)?python3\.12' -and [string]$_['version'] -ceq '3.12.3-1ubuntu0.17' }).Count -eq 5) 'prereq:21-debs-pinned'
Yes ($null -eq (Get-Key $committed 'aptPins')) 'prereq:no-apt-resolution'
# Measured from the pinned ZIPs, including directory entries and the archive's top-level directory (DESK, 2026-11-17).
# Capture the real extraction destination before any I/O: this checks Windows' default path budget even on a long-path-enabled host.
Case 'cache:default-Windows-path-budget' {
  $measured = @{ node = 125; python = 20; git = 64; 'actions-runner' = 61 }
  function Get-ExtractState([string]$dir, [string]$sourceSha256) { 'absent' }
  function Expand-Archive([string]$LiteralPath, [string]$DestinationPath) { $script:cacheDestination = $DestinationPath; throw 'CACHE_PATH_CAPTURED' }
  foreach ($i in @($committed['items'] | Where-Object { $_['kind'] -ceq 'zip' })) {
    $name = [string]$i['name']; $max = Get-Key $i 'maxEntryPathLength'
    Yes ($measured.ContainsKey($name) -and $max -eq $measured[$name]) ('cache:measured-max-entry:' + $name)
    $script:cacheDestination = $null
    Throws { Expand-Cached 'not-read.zip' $name ([string]$i['sha256']) $measured[$name] } 'CACHE_PATH_CAPTURED' ('cache:capture:' + $name)
    $dest = [string]$script:cacheDestination
    Yes ($dest.Length -gt 0 -and $dest.Length + 1 + $measured[$name] -le 259) ('cache:default-path-at-most-259:' + $name + ':' + ($dest.Length + 1 + $measured[$name]))
    $prefix = Join-Path (Join-Path $WorkParent 'tools') ($name + '-' + ([string]$i['sha256']).Substring(0, 16))
    Yes ($dest -cmatch ('^' + [regex]::Escape($prefix) + '\.p-[0-9a-f]{8}$')) ('cache:short-destination:' + $name)
  }
}
function New-Pinned {
  $m = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path (Split-Path -Parent $here) 'prereq-manifest.json')))
  foreach ($i in @($m['items'])) { if ($null -eq $i['sha256']) { $i['sha256'] = 'e' * 64; $i['bytes'] = 12345 }; if ($null -eq $i['url']) { $i['url'] = 'https://example.invalid/' + $i['fileName'] } }
  $m
}
$m = New-Pinned
Yes ((Test-PrereqManifest $m).Count -eq 0) ('prereq:pinned-passes ' + ((Test-PrereqManifest $m) -join ','))
foreach ($bad in @($null, 0, -1, 1.5, '125', $true, 2147483648L)) {
  $m = New-Pinned; $m['items'][0]['maxEntryPathLength'] = $bad
  Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH:node') ('prereq:invalid-zip-max-entry:' + $bad)
}
$m = New-Pinned; [void]$m['items'][0].Remove('maxEntryPathLength')
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH:node') 'prereq:missing-zip-max-entry'
$m = New-Pinned; $m['items'][0]['sha256'] = $null
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:node') 'prereq:null-sha-refused'
$m = New-Pinned; $m['items'][1]['bytes'] = $null
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:python') 'prereq:null-bytes-refused'
$m = New-Pinned; $m['items'][2]['url'] = 'http://insecure.example/x.zip'
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_URL:git') 'prereq:https-only'
$m = New-Pinned; $m['items'] = @($m['items'] | Select-Object -Skip 1)
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_ITEM_NOT_ONCE:node') 'prereq:every-item'
$m = New-Pinned; $m['debs'][3]['sha256'] = $null
Yes ((Test-PrereqManifest $m) -ccontains ('PREREQ_NOT_PINNED:deb:' + $m['debs'][3]['package'])) 'prereq:a-deb-unpinned'
$m = New-Pinned; $m['debs'] = @()
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_DEBS_SHAPE') 'prereq:debs-required'
$m = New-Pinned; $m['debs'][0]['fileName'] = '../x.deb'
Yes ((Test-PrereqManifest $m) -ccontains ('PREREQ_DEB_FILE_NAME:' + $m['debs'][0]['package'])) 'prereq:deb-file-name'
$m = New-Pinned; @($m['items'] | Where-Object { $_['name'] -ceq 'wsl' })[0]['version'] = 'latest'
Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_WSL_VERSION') 'prereq:wsl-version-exact'
Yes ((Test-PrereqManifest @{ contract = 'x' }) -ccontains 'PREREQ_MANIFEST_SHAPE') 'prereq:contract'

# ---- the last JSON line, the elevated command, the declined UAC
Yes ((Get-LastJsonLine "noise`r`n{`"status`":`"A`"}`r`n`r`n")['status'] -ceq 'A') 'last-json'
Yes ($null -eq (Get-LastJsonLine "{`"status`":`"A`"}`nnot json")) 'last-json:not-json'
Yes ($null -eq (Get-LastJsonLine '')) 'last-json:empty'
# M3: an elevated run is -File with its arguments one by one, each inside the whitelist: no value ever becomes code
$self = 'C:\ProgramData\CluedBootstrap\abc\fleet-node-1.bootstrap.ps1'
$ea = Get-ElevatedArguments $self @('-Stage', 'install', '-Tar', 'C:\x\fleet-node-1.tar', '-ArchiveSha256', ('a' * 64), '-ExpectedOperatorSid', 'S-1-5-21-1-2-3-1000')
Yes ((@($ea) -join ' ') -ceq ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $self + ' -Stage install -Tar C:\x\fleet-node-1.tar -ArchiveSha256 ' + ('a' * 64) + ' -ExpectedOperatorSid S-1-5-21-1-2-3-1000')) 'elevated:file-and-arguments'
foreach ($bad in @("C:\x';calc;'", 'C:\a b\x.tar', 'C:\x\..\y', '\\server\share\x', 'C:\x\', '$(calc)', 'C:\x"y', '-Stage host')) {
  Throws { Get-ElevatedArguments $self @('-Tar', $bad) } 'BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:*' ('elevated:refused ' + $bad)
}
Throws { Get-ElevatedArguments 'C:\a b\x.ps1' @() } 'BOOTSTRAP_ELEVATED_ARGUMENT_REFUSED:*' 'elevated:script-path-refused'
Yes ((Test-SafePath 'C:\ProgramData\CluedBootstrap\x.y_z-1') -and -not (Test-SafePath 'C:\a b') -and -not (Test-SafePath 'C:\x\..\y') -and -not (Test-SafePath 'C:\x\') -and -not (Test-SafePath 'x\y')) 'safe-path'
Yes ((Test-SafeArgument ('a' * 64)) -and (Test-SafeArgument 'S-1-5-21-1-2-3-1000') -and (Test-SafeArgument 'host') -and -not (Test-SafeArgument '') -and -not (Test-SafeArgument 'a;b')) 'safe-argument'
Yes ($text -notmatch 'EncodedCommand' -and $text -notmatch '\[scriptblock\]::Create\(') 'elevated:no-code-built-from-values'
# M2: the accepted inputs are checked non-elevated (install.mjs first-install-check) before the first UAC; P1 gets their pins from it
$main = $text.Substring($text.IndexOf('function Invoke-Bootstrap'))
Yes ($main.IndexOf('first-install-check') -gt 0 -and $main.IndexOf('first-install-check') -lt $main.IndexOf("Invoke-Elevated 'install'")) 'm2:check-before-uac-1'
foreach ($p in @("'-KitSha256', [string]`$chk['kitSha256']", "'-ToolchainNodeSha256', [string]`$chk['toolchainNodeSha256']", "'-RegistrarSha256', [string]`$chk['registrarSha256']", "'-ExpectedOperatorSid', `$operator")) { Yes ($main.Contains($p)) ('m2/m4:host-argument ' + $p) }
Yes ($text -notmatch 'CompanionTaskRegistrar\.cs') 'l2:registrar-pin-not-computed-here'
# M4: the elevated stage refuses another account than the one that started the bootstrap
Yes ($null -eq (Test-StageOperator 'S-1-5-21-1-2-3-1000' 'S-1-5-21-1-2-3-1000')) 'm4:same-operator'
Yes ((Test-StageOperator 'S-1-5-21-1-2-3-1009' 'S-1-5-21-1-2-3-1000') -ceq 'ELEVATED_ACCOUNT_IS_NOT_THE_OPERATOR') 'm4:uac-switched-account'
# L1: an extraction is complete only with its marker naming the source's sha256; anything else is set aside and done again
$tmpx = Join-Path ([IO.Path]::GetTempPath()) ('bootstrap-x-' + [Guid]::NewGuid().ToString('N'))
try {
  Yes ((Get-ExtractState $tmpx ('a' * 64)) -ceq 'absent') 'l1:absent'
  [void][IO.Directory]::CreateDirectory($tmpx); [IO.File]::WriteAllText((Join-Path $tmpx 'half.txt'), 'x')
  Yes ((Get-ExtractState $tmpx ('a' * 64)) -ceq 'incomplete') 'l1:no-marker'
  [IO.File]::WriteAllText((Join-Path $tmpx '.bootstrap-complete'), ('b' * 64))
  Yes ((Get-ExtractState $tmpx ('a' * 64)) -ceq 'incomplete') 'l1:other-source'
  [IO.File]::WriteAllText((Join-Path $tmpx '.bootstrap-complete'), ('a' * 64))
  Yes ((Get-ExtractState $tmpx ('a' * 64)) -ceq 'complete') 'l1:complete'
} finally { Remove-Item -LiteralPath $tmpx -Recurse -Force -ErrorAction SilentlyContinue }
Case 'cache:expansion-budget-and-full-hash-integrity' {
  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $WorkParent = [IO.Path]::GetFullPath((Join-Path $tempParent ('cache-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))))
  $script:cacheExpansions = 0
  function Expand-Archive([string]$LiteralPath, [string]$DestinationPath) {
    $script:cacheExpansions++; $script:cacheDestination = $DestinationPath
    [void][IO.Directory]::CreateDirectory($DestinationPath)
    [IO.File]::WriteAllText((Join-Path $DestinationPath 'payload.txt'), 'extracted')
  }
  try {
    $expected = Join-Path (Join-Path $WorkParent 'tools') ('node-' + $h1.Substring(0, 16))
    $budget = 259 - ($expected.Length + '.p-12345678'.Length + 1)
    $dir = Expand-Cached 'not-read.zip' 'node' $h1 $budget
    Yes ($dir -ceq $expected -and $script:cacheDestination.Length + 1 + $budget -eq 259) 'cache:259-accepted'
    Yes (([IO.File]::ReadAllText((Join-Path $dir '.bootstrap-complete'))) -ceq $h1) 'cache:marker-is-full-sha256'
    Yes ((Expand-Cached 'not-read.zip' 'node' $h1 $budget) -ceq $dir -and $script:cacheExpansions -eq 1) 'cache:complete-reused'
    Throws { Expand-Cached 'not-read.zip' 'node' $h1 ($budget + 1) } 'TOOL_CACHE_PATH_TOO_LONG:*' 'cache:260-refused-before-reuse-or-extraction'
    Yes ($script:cacheExpansions -eq 1 -and (Get-ExtractState $dir $h1) -ceq 'complete') 'cache:overlong-has-no-side-effects'
    $collision = $h1.Substring(0, 16) + ('b' * 48)
    Yes ((Get-ExtractState $dir $collision) -ceq 'incomplete') 'cache:same-prefix-different-full-sha-incomplete'
    $again = Expand-Cached 'not-read.zip' 'node' $collision $budget
    Yes ($again -ceq $dir -and $script:cacheExpansions -eq 2 -and (Get-ExtractState $dir $collision) -ceq 'complete') 'cache:collision-reexpanded'
    $aside = @(Get-ChildItem -LiteralPath (Split-Path -Parent $dir) -Directory | Where-Object { $_.FullName -cne $dir })
    Yes ($aside.Count -eq 1 -and (Get-ExtractState $aside[0].FullName $h1) -ceq 'complete') 'cache:previous-extraction-preserved'
    Throws { Expand-Cached 'not-read.zip' 'python' $h2 } 'PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH:python' 'cache:missing-bound-refused'
  } finally {
    if (-not $WorkParent.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -or $WorkParent -ceq $tempParent) { throw 'CACHE_TEST_CLEANUP_OUTSIDE_TEMP' }
    Remove-Item -LiteralPath $WorkParent -Recurse -Force -ErrorAction SilentlyContinue
  }
}
# L4: a terminating exception of a stage keeps its message in the result
$sf = Get-StageFailure 'host' (New-Object InvalidOperationException('ARCHIVE_CHANGED_BEFORE_ELEVATION'))
Yes ($sf['status'] -ceq 'BOOTSTRAP_STAGE_FAILED' -and $sf['stage'] -ceq 'host' -and $sf['message'] -ceq 'ARCHIVE_CHANGED_BEFORE_ELEVATION' -and $sf['type'] -ceq 'System.InvalidOperationException') 'l4:message-kept'
$stageBody = $text.Substring($text.IndexOf('function Invoke-Stage '))
$stageBody = $stageBody.Substring(0, $stageBody.IndexOf("`nfunction "))
Yes ($stageBody -match 'finally' -and $stageBody -match 'Get-StageFailure' -and $stageBody -match 'Remove-Item -LiteralPath \$stageDir') 'l4:stage-cleans-its-copies'
Yes ($stageBody -match '(?s)finally.+if \(\$clearCredentials\).+Clear-CredentialDirectory' -and
  $main -notmatch "Invoke-Elevated 'cleanup'") 'l3:single-stage-clears-credential-staging'
Yes (Test-UacDeclined (New-Object InvalidOperationException('x', (New-Object ComponentModel.Win32Exception(1223))))) 'uac:declined'
Yes (-not (Test-UacDeclined (New-Object ComponentModel.Win32Exception(2)))) 'uac:other-error'

# ---- independent review of 29c53c38c (REPORT-api-review-first-install.md)
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('bootstrap-review-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($tmp)
$evidence = [ordered]@{}
try {
  # H1: the elevated stage reads its child (P1, the launcher) with stdout and stderr apart. Under $ErrorActionPreference = 'Stop' a line
  # on stderr must neither end the stage nor lose the child's verdict: the launcher prints its terminal and then throws (Stop-Launch).
  $child = Join-Path $tmp 'child.ps1'
  [IO.File]::WriteAllText($child, "param([switch]`$RunApprovedInstall, [switch]`$Grandchild)`r`n`$ErrorActionPreference = 'Stop'`r`n" +
    "[Console]::Error.WriteLine('noise on stderr')`r`n" +
    "if (`$Grandchild) { `$null = cmd.exe /c 'echo grandchild-stderr 1>&2'; '{`"status`":`"FIRST_INSTALL_HOST_READY`"}'; exit 0 }`r`n" +
    "'{`"status`":`"STOPPED`",`"code`":`"LINUX_PHASE_B_NOT_COMPLETED`"}'`r`nthrow 'Stop-Launch: LINUX_PHASE_B_NOT_COMPLETED'`r`n", (New-Object Text.UTF8Encoding($false)))
  $childArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $child)
  Case 'h1:a-launcher-that-stops-keeps-its-terminal' {
    $r = Invoke-StageChild $PowerShellExe ($childArgs + '-RunApprovedInstall') 300
    Yes ($r.exit -eq 1 -and [string](Get-Key $r.last 'status') -ceq 'STOPPED' -and [string](Get-Key $r.last 'code') -ceq 'LINUX_PHASE_B_NOT_COMPLETED') ('h1:terminal-kept exit=' + $r.exit + ' last=' + (ConvertTo-Json $r.last -Compress))
    Yes ([string]$r.stderr -match 'Stop-Launch: LINUX_PHASE_B_NOT_COMPLETED' -and [string]$r.stderr -match 'noise on stderr') ('h1:stderr-kept-apart ' + $r.stderr)
    Yes ([string]$r.stdout -notmatch 'noise on stderr') 'h1:stdout-is-only-stdout'
  }
  Case 'h1:a-grandchild-on-stderr-does-not-end-the-host-stage' {
    $r = Invoke-StageChild $PowerShellExe ($childArgs + '-Grandchild') 300
    Yes ($r.exit -eq 0 -and [string](Get-Key $r.last 'status') -ceq 'FIRST_INSTALL_HOST_READY') ('h1:grandchild exit=' + $r.exit + ' stdout=' + $r.stdout + ' stderr=' + $r.stderr)
  }
  # Defect 0e004509 (Fable ruling 11-19 renew-key, "branch two, two points" 1): a stage child's lines reach the stage's output file as it
  # prints them (appended and flushed line by line), the verdict last; a child still running at the limit, or one that printed no verdict,
  # gives the lines it printed, never nothing. Before: ReadToEndAsync held them all until the child ended, and the file was written once.
  $slow = Join-Path $tmp 'slow-child.ps1'
  [IO.File]::WriteAllText($slow, "'{`"name`":`"stage`",`"result`":`"ok`",`"rejectCode`":null,`"detail`":null}'`r`n'{`"name`":`"v1-base`",`"result`":`"ok`",`"rejectCode`":null,`"detail`":null}'`r`nStart-Sleep -Seconds 25`r`n'{`"status`":`"FIRST_INSTALL_HOST_READY`"}'`r`n", (New-Object Text.UTF8Encoding($false)))
  Case 'stage-lines:a-child-at-the-limit-gives-the-lines-it-printed' {
    $out = Join-Path $tmp 'stage-result.txt'
    $r = Invoke-StageChild $PowerShellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $slow) 6 $out
    Yes ($r.timedOut -eq $true) 'stage-lines:timed-out'
    Yes ([string]$r.stdout -match '"name":"stage"' -and [string]$r.stdout -match '"name":"v1-base"') ('stage-lines:stdout-so-far ' + $r.stdout)
    $file = if ([IO.File]::Exists($out)) { [IO.File]::ReadAllText($out) } else { '' }
    Yes ($file -match '"name":"stage"' -and $file -match '"name":"v1-base"' -and $file -notmatch 'FIRST_INSTALL_HOST_READY') ('stage-lines:on-disk-while-the-child-runs ' + $file)
    $read = Read-StageResult $out
    Yes ($read.lines.Count -eq 2 -and $null -eq $read.last) ('stage-lines:read-back-no-verdict ' + $read.lines.Count)
  }
  Case 'stage-lines:no-verdict-is-said-by-name' {
    $step = [ordered]@{ exit = 1; timedOut = $false; last = [ordered]@{ name = 'linux'; result = 'failed'; rejectCode = $null; detail = $null } }
    $v = Get-StageVerdict $step 'first-install-host.ps1'
    Yes ([string]$v.status -ceq 'STAGE_CHILD_PRINTED_NO_VERDICT' -and $v.child -ceq 'first-install-host.ps1' -and $v.exit -eq 1) ('stage-lines:a-step-line-is-no-verdict ' + (ConvertTo-Json $v -Compress))
    $ready = [ordered]@{ exit = 0; timedOut = $false; last = [ordered]@{ status = 'FIRST_INSTALL_HOST_READY' } }
    Yes ([string](Get-StageVerdict $ready 'first-install-host.ps1').status -ceq 'FIRST_INSTALL_HOST_READY') 'stage-lines:a-verdict-is-kept'
    Yes ($stageBody -notmatch 'WriteAllLines' -and $stageBody -match 'Add-ResultLine') 'stage-lines:the-stage-appends-never-writes-once'
    $elevated = $text.Substring($text.IndexOf('function Invoke-Elevated')); $elevated = $elevated.Substring(0, $elevated.IndexOf("`nfunction "))
    Yes ($elevated -match 'Stop-Bootstrap \$step ''STAGE_GAVE_NO_VERDICT''' -and $elevated -match 'Read-StageResult \$result') 'stage-lines:the-entry-names-a-stage-without-a-verdict'
  }
  Case 'h1:the-stages-never-merge-stderr-into-the-verdict' {
    Yes ($stageBody -notmatch '2>&1') 'h1:no-2>&1-in-Invoke-Stage'
    Yes ($stageBody -match 'Invoke-StageChild \$PowerShellExe' -and $functions['Invoke-FirstInstallLauncher'] -match 'Invoke-StageChild \$PowerShellExe' -and
      $functions['Invoke-FirstInstallLauncher'] -notmatch '2>&1') 'h1:host-and-launcher-through-Invoke-StageChild'
  }
  # what the pattern H1 replaced does on this host (recorded for the report, not a check): `& powershell -File <child> 2>&1` under Stop
  $old = $null
  try { $ErrorActionPreference = 'Stop'; $o = & $PowerShellExe @($childArgs + '-RunApprovedInstall') 2>&1 | ForEach-Object { [string]$_ }; $old = 'no exception; lines=' + @($o).Count }
  catch { $old = 'threw ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message }
  $evidence['oldPatternLauncherStop'] = $old

  Case 'h2:a-left-directory-is-swept' {
    $cd = Join-Path $tmp 'credentials'; [void][IO.Directory]::CreateDirectory($cd); [IO.File]::WriteAllText((Join-Path $cd 'resident-upgrade.token'), 'x')
    $c = Clear-CredentialDirectory $cd
    Yes ($c.existed -eq $true -and $c.cleared -eq $true -and -not [IO.Directory]::Exists($cd)) 'h2:swept'
    $c = Clear-CredentialDirectory $cd
    Yes ($c.existed -eq $false -and $c.cleared -eq $true) 'h2:nothing-there'
  }
  Case 'first-install:protected-inputs-verified-before-preparing-host' {
    Yes ($stageBody.IndexOf('Get-ProtectedInstallInputs') -gt 0 -and
      $stageBody.IndexOf('Get-ProtectedInstallInputs') -lt $stageBody.IndexOf('Clear-CredentialDirectory') -and
      $stageBody.IndexOf('Clear-CredentialDirectory') -lt $stageBody.IndexOf('if ($Reset) { $p1Args')) 'first-install:precheck-then-staging-cleanup-then-host'
  }
  Case 'first-install:protected-stage-runs-only-the-verified-launcher' {
    Yes ($stageBody -match 'Invoke-FirstInstallLauncher[^\r\n]+-BeforeLaunch') 'first-install:stage-checkpoints-at-launch-boundary'
    $stage = Join-Path $tmp 'first-install-stage'
    $fixtureLauncher = Join-Path (Join-Path $stage 'prepare') 'launcher.ps1'
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $fixtureLauncher))
    [IO.File]::WriteAllText($fixtureLauncher, '# fixture only')
    $ArchiveSha256 = $h1
    $inputFiles = @{ node = 'fixture-node'; acceptance = (Join-Path $stage 'acceptance.json'); assets = $stage; environment = @{} }
    $calls = New-Object Collections.Generic.List[string]
    $checkpoint = Join-Path $stage 'launcher-checkpoint.fixture'
    $mode = 'refuse'
    function Invoke-StageChild([string]$exe, [string[]]$arguments) {
      $calls.Add($exe)
      if ($exe -ceq 'fixture-node') {
        Yes ($arguments -ccontains '--from' -and $arguments -ccontains $inputFiles.acceptance) 'first-install:prepare-only-protected-inputs'
        if ($mode -ceq 'refuse') { return @{ exit = 1; last = @{ status = 'FLEET_NODE_INSTALL_REFUSED' } } }
        $digest = if ($mode -ceq 'bad-hash') { '0' * 64 } else { Sha256File $fixtureLauncher }
        return @{ exit = 0; last = @{ status = 'FLEET_NODE_FIRST_INSTALL_PREPARED'; launcher = @{ path = $fixtureLauncher; sha256 = $digest } } }
      }
      Yes ([IO.File]::Exists($checkpoint)) 'first-install:launch-checkpoint-precedes-child'
      Yes ($arguments -ccontains $fixtureLauncher -and $arguments -ccontains '-RunApprovedInstall') 'first-install:executes-verified-stage-launcher'
      return @{ exit = 0; last = @{ status = 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' } }
    }
    $run = {
      Invoke-FirstInstallLauncher $stage (Join-Path $stage 'a.tar') (Join-Path $stage 'install.mjs') $inputFiles $null -BeforeLaunch {
        [IO.File]::WriteAllText($checkpoint, 'launcher')
      }
    }
    Yes ((& $run).status -ceq 'FLEET_NODE_INSTALL_REFUSED' -and $calls.Count -eq 1) 'first-install:prepare-refused-stops-before-launcher'
    Yes (-not [IO.File]::Exists($checkpoint)) 'first-install:prepare-refused-keeps-install-checkpoint'
    $calls.Clear(); $mode = 'bad-hash'
    Throws $run 'LAUNCHER_CHANGED' 'first-install:refuses-altered-launcher'
    Yes ($calls.Count -eq 1) 'first-install:altered-launcher-never-runs'
    Yes (-not [IO.File]::Exists($checkpoint)) 'first-install:altered-launcher-keeps-install-checkpoint'
    $calls.Clear(); $mode = 'valid'
    Yes ((& $run).status -ceq 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' -and $calls.Count -eq 2) 'first-install:same-stage-prepare-and-launch'
  }

  # M2: the toolchain's node.exe is the fleet's controller runtime before the first UAC (the check P1 can no longer undo)
  $good = [ordered]@{ status = 'FIRST_INSTALL_INPUTS_ACCEPTED'; archiveSha256 = $h1; kitSha256 = $h2; controllerNodeSha256 = $h3; toolchainNodeSha256 = $img; registrarSha256 = $h1 }
  Case 'm2:the-controller-node-before-uac-1' {
    # (the function returns its codes as one array, as Test-AssetSet: used as it is, never wrapped in @() again)
    Yes ((Test-FirstInstallCheck $good $h1 $h2 $h3).Count -eq 0) 'm2:accepted'
    Yes ((Test-FirstInstallCheck $good $h1 $h2 ('9' * 64)) -ccontains 'CONTROLLER_NODE_NOT_THE_FLEETS') 'm2:node-differs'
    Yes ((Test-FirstInstallCheck $good ('9' * 64) $h2 $h3) -ccontains 'ARCHIVE_NOT_THE_CHECKED') 'm2:archive-differs'
    Yes ((Test-FirstInstallCheck $good $h1 $null $h3) -ccontains 'KIT_NOT_THE_LISTED') 'm2:no-kit'
    $bad = [ordered]@{}; foreach ($k in @($good.Keys)) { $bad[$k] = $good[$k] }; $bad['registrarSha256'] = 'x'
    Yes ((Test-FirstInstallCheck $bad $h1 $h2 $h3) -ccontains 'PIN_SHAPE:registrarSha256') 'm2:pin-shape'
    $hostAt = $main.IndexOf("Invoke-Elevated 'install'")
    Yes ($main.IndexOf('Test-FirstInstallCheck') -gt 0 -and $main.IndexOf('Test-FirstInstallCheck') -lt $hostAt -and $main.IndexOf('Sha256File $nodeExe[0]') -lt $hostAt -and $main.IndexOf('Sha256File $nodeExe[0]') -gt 0) 'm2:checked-before-uac-1'
  }

  # M3: what the elevated stage reads is a local copy in the work directory (an elevated token does not see the user's mapped drives)
  Case 'm3:local-copies-for-the-elevated-stage' {
    $src = Join-Path $tmp 'from'; $wd = Join-Path $tmp 'work'; [void][IO.Directory]::CreateDirectory($src); [void][IO.Directory]::CreateDirectory($wd)
    $a = Join-Path $src 'fleet-node-1.tar'; [IO.File]::WriteAllText($a, 'archive bytes')
    $want = Sha256File $a
    $copy = Copy-ToWork $a $wd $want
    Yes ($copy -ceq (Join-Path $wd 'fleet-node-1.tar') -and (Sha256File $copy) -ceq $want) 'm3:copied-and-held-to-its-hash'
    Throws { Copy-ToWork $a (Join-Path $tmp 'work2') ('0' * 64) } 'LOCAL_COPY_NOT_THE_PINNED:*' 'm3:another-hash-refused'
    Yes ((Test-UnderDirectory $copy $wd) -and -not (Test-UnderDirectory $a $wd) -and -not (Test-UnderDirectory ($wd + 'x\y') $wd)) 'm3:under-the-work-directory'
    $hostArgsAt = $main.IndexOf('$hostInputs = @(')
    $hostArgsText = $main.Substring($hostArgsAt, $main.IndexOf("`n", $main.IndexOf("`n", $hostArgsAt) + 1) - $hostArgsAt)
    Yes ($hostArgsText -notmatch "'-Tar', \`$tar\b" -and $hostArgsText -notmatch "'-PrereqManifest', \`$prereqFile\b") ('m3:host-arguments-are-the-copies ' + $hostArgsText)
    Yes ($main -match 'Copy-ToWork \$tar ' -and $main -match 'Copy-ToWork \$prereqFile ') 'm3:tar-and-manifest-copied'
  }

  # M4: a first install is done only when the M5-b switch moved the distribution to the companion (COMPANION_HEADLESS_QUALIFIED)
  Case 'm4:the-companion-switch-counts-for-a-first-install' {
    $term = { param($s, $c) [ordered]@{ status = $s; role = 'not-held'; companionHeadless = [ordered]@{ ran = $true; status = $c } } }   # role: a confirmed one (role-unconfirmed: first-install-switch.test.mjs)
    Yes ((Get-LauncherVerdict $true (& $term 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' 'COMPANION_HEADLESS_QUALIFIED')).status -ceq 'BOOTSTRAP_DONE') 'm4:first-install-done'
    Yes ((Get-LauncherVerdict $true (& $term 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' 'COMPANION_HEADLESS_FELL_BACK')).status -ceq 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE') 'm4:switch-fell-back'
    Yes ((Get-LauncherVerdict $true ([ordered]@{ status = 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED'; role = 'not-held' })).status -ceq 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE') 'm4:switch-not-reported'
    Yes ((Get-LauncherVerdict $false (& $term 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' 'COMPANION_HEADLESS_FELL_BACK')).status -ceq 'BOOTSTRAP_DONE') 'm4:a-reinstall-as-before'
    Yes ((Get-LauncherVerdict $true (& $term 'PAUSE_NOT_CONFIRMED' 'COMPANION_HEADLESS_QUALIFIED')).status -ceq 'BOOTSTRAP_LAUNCHER_ENDED') 'm4:not-verified'
    # the launcher prints its terminal with ConvertTo-Json: the switch's status is read from it
    $printed = "x`r`n" + ((& $term 'R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED' 'COMPANION_HEADLESS_FAILED') | ConvertTo-Json -Depth 6)
    Yes ((Get-LauncherVerdict $true (Get-LastJsonLine $printed)).status -ceq 'BOOTSTRAP_FIRST_INSTALL_COMPANION_SWITCH_NOT_DONE') 'm4:read-from-the-printed-terminal'
    Yes ($main -match 'Get-InstallStageVerdict \$h\.last' -and $functions['Get-InstallStageVerdict'] -match 'Get-LauncherVerdict') 'm4:the-bootstrap-uses-it'
  }

  # M6: a node with a resident (the reinstall) fetches and needs pinned only what its path runs: node, python, git; never the rootfs,
  # the WSL package, the runner, the Linux toolchain node or the .debs
  Case 'm6:the-reinstall-takes-only-what-it-needs' {
    Yes (((Get-NeededPrereqs $false) -join ',') -ceq 'node,python,git') 'm6:reinstall-needs'
    Yes (((Get-NeededPrereqs $true) -join ',') -ceq ($PrereqNames -join ',')) 'm6:first-install-needs-all'
    $c = Test-PrereqManifest $committed (Get-NeededPrereqs $false) $false
    $u = @($c | Where-Object { $_ -like 'PREREQ_NOT_PINNED:*' } | ForEach-Object { $_.Substring(18) } | Sort-Object)
    Yes ($c.Count -eq 0) ('m6:reinstall-committed-pins-pass ' + ($c -join ','))
    $m = New-Pinned; $m['debs'][0]['sha256'] = $null; foreach ($i in @($m['items'])) { if ($i['name'] -ceq 'wsl') { $i['sha256'] = $null } }
    Yes ((Test-PrereqManifest $m (Get-NeededPrereqs $false) $false).Count -eq 0) 'm6:reinstall-ignores-first-install-pins'
    Yes ((Test-PrereqManifest $m) -ccontains 'PREREQ_NOT_PINNED:wsl') 'm6:first-install-still-refuses'
    Yes ($main -match '(?s)Get-NeededPrereqs \$false.*FLEET_NODE_UPGRADE_REQUESTED.*return.*Get-NeededPrereqs \$true.*\$debDir') 'm6:the-bootstrap-fetches-by-need'
  }

  # The one JSON writer (Fable ruling 11-19 renew-key section 4.4a; the same defect as first-install-host.ps1, drill 3bc571a6 A1): under
  # Windows PowerShell 5.1 the Work directory (Join-Path, :459) is a string in a PSObject shell, and every Out-Result after it (each
  # refusal, the reset result, RESTART_THEN_RUN_THE_SAME_COMMAND, the final verdict) threw a PSParameterizedProperty circular reference
  # instead of printing its line. Every bootstrap output is progress-grade: never an exception, never a change of control flow (the
  # credential clean-up order stays); a value that is not plain data is printed as its type name.
  Case 'json:out-result-prints-the-work-directory' {
    $saved = Get-Variable -Name Work -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    try {
      $script:Work = Join-Path 'C:\ProgramData\CluedBootstrap' 'abc'
      $line = Out-Result 'BOOTSTRAP_DONE' 'launcher' ([ordered]@{ firstInstall = $true; codes = (@('A', 'B') | Where-Object { $_ }); dir = (Split-Path -Parent 'C:\a\b') })
      $o = $js.DeserializeObject($line)
      Yes ($o['status'] -ceq 'BOOTSTRAP_DONE' -and $o['workDir'] -ceq 'C:\ProgramData\CluedBootstrap\abc' -and (@($o['codes']) -join ',') -ceq 'A,B' -and $o['dir'] -ceq 'C:\a') ('json:done ' + $line)
      $odd = Out-Result 'BOOTSTRAP_REFUSED' 'assets' ([ordered]@{ code = 'X'; detail = (Get-Item -LiteralPath $env:SystemRoot) })
      $o = $js.DeserializeObject($odd)
      Yes ($o['code'] -ceq 'X' -and [string]$o['detail'] -clike '*DirectoryInfo*') ('json:not-plain-is-printed-by-type ' + $odd)
      # Codex review of PR-甲 (blocking 2): a verdict of plain data longer than the serializer's default 2,097,152 characters (the
      # stage child's result is read up to 16,777,216) threw instead of printing; the writer's limit is at least the reader's
      $big = 'x' * 2500000
      $long = Out-Result 'BOOTSTRAP_REFUSED' 'host' ([ordered]@{ code = 'LONG'; detail = $big })
      $o = $js.DeserializeObject($long)
      Yes ($null -ne $o -and $o['code'] -ceq 'LONG' -and ([string]$o['detail']).Length -eq 2500000) ('json:longer-than-2M ' + $(if ($long) { $long.Length } else { 'none' }))
    } finally { $script:Work = $saved }
    $inWriter = [regex]::Matches($functions['ConvertTo-JsonLine'], '\.Serialize\(').Count
    Yes ($inWriter -ge 1 -and ([regex]::Matches($text, '\.Serialize\(')).Count -eq $inWriter) 'json:every-serialize-is-in-the-writer'
    # every output of the bootstrap is the progress grade (it never throws)
    $calls = @([regex]::Matches($text, '(?m)^(?!\s*#).*?ConvertTo-JsonLine [^\r\n]*'))
    Yes (@($calls | Where-Object { $_.Value -notmatch '-Progress\b' }).Count -eq 0) ('json:every-call-is-progress ' + (@($calls | Where-Object { $_.Value -notmatch '-Progress\b' } | ForEach-Object { $_.Value }) -join ' | '))
  }
  # bootstrap.ps1 is downloaded on its own (the first hop) and cannot load a file of the package: the writer is a copy of
  # windows/first-install-host.ps1's, held to it character for character.
  Case 'json:the-same-writer-as-first-install-host' {
    $hostFile = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))) 'windows\first-install-host.ps1'
    $hostAst = [Management.Automation.Language.Parser]::ParseFile($hostFile, [ref]$tokens, [ref]$errors)
    foreach ($name in @('ConvertTo-PlainData', 'ConvertTo-JsonLine')) {
      $theirs = @($hostAst.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $name }, $true))
      Yes ($theirs.Count -eq 1 -and $functions.ContainsKey($name) -and $theirs[0].Extent.Text -ceq $functions[$name]) ('json:same-text:' + $name)
    }
  }
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }

if ($script:failures.Count) {
  (New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ status = 'BOOTSTRAP_PURE_TESTS_FAILED'; checks = $script:n; failures = @($script:failures); evidence = $evidence })
  exit 1
}
(New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ status = 'BOOTSTRAP_PURE_TESTS_PASSED'; checks = $script:n; evidence = $evidence })
