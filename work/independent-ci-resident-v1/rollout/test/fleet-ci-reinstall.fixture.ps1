param([string]$SourceRoot, [string]$CiRoot, [string]$Scenario)
$ErrorActionPreference = 'Stop'

function Read-Functions([string]$file, [string[]]$names) {
  $tokens = $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw $errors[0] }
  foreach ($name in $names) {
    $defs = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
    if ($defs.Count -ne 1) { throw ('FIXTURE_FUNCTION_NOT_UNIQUE:' + $name) }
    $defs[0]
  }
}
function Expect-Refusal([string]$code, [scriptblock]$operation) {
  try { $null = & $operation }
  catch {
    if ($_.Exception.Message -cne $code) { throw }
    return
  }
  throw ('FIXTURE_EXPECTED_REFUSAL:' + $code)
}
function Write-JsonFixture([string]$file, $value) {
  [IO.File]::WriteAllText($file, ($value | ConvertTo-Json -Compress -Depth 8), $U8)
}
function Get-DrillTime { [DateTimeOffset]::Parse('2026-11-27T01:00:00Z') }
function Use-FixtureClock([string]$source) {
  $source -creplace '\[DateTimeOffset\]::UtcNow\b', '(Get-DrillTime)'
}

function Read-CiPrivateBytes([string]$file, [string]$sid) {
  if ($sid -cne $ControllerSid) { throw 'FIXTURE_CONTROLLER_SID' }
  if ($file -ceq $TokenFile) { return ,$U8.GetBytes('clued_bnd_reinstall_fixture_only') }
  if ($file -ceq $RecordFile) { return ,[IO.File]::ReadAllBytes($file) }
  throw 'FIXTURE_UNEXPECTED_PRIVATE_PATH'
}
function Invoke-RestMethod($Uri, $Method, $ContentType, $MaximumRedirection, $TimeoutSec, [switch]$UseBasicParsing, $Headers, $Body) {
  $script:ServerAttempts++
  if ($script:Offline) { throw 'FIXTURE_HTTP_FORBIDDEN' }
  $request = $Body | ConvertFrom-Json
  $expected = if ($script:AfterLinuxB) { $candidateInstallation } else { $installation }
  if ($Uri -cne ($expected.supabaseUrl + '/rest/v1/rpc/clued_ci_connection_self_v1') -or $Method -cne 'Post' -or
      $MaximumRedirection -ne 0 -or $TimeoutSec -ne 15 -or $Headers.apikey -cne $expected.publishableKey -or
      $request.p_input.scope -cne $expected.scope -or $request.p_token_hash -cne (Sha256Text 'clued_bnd_reinstall_fixture_only') -or
      @($request.PSObject.Properties.Name).Count -ne 2 -or @($request.p_input.PSObject.Properties.Name).Count -ne 1) {
    $script:BadRequests++
    throw 'FIXTURE_SERVER_REQUEST_CHANGED'
  }
  if ($script:HttpStatus) {
    $errorWithStatus = New-Object System.Exception('FIXTURE_HTTP')
    $errorWithStatus | Add-Member NoteProperty Response ([pscustomobject]@{ StatusCode = $script:HttpStatus })
    throw $errorWithStatus
  }
  if ($script:ServerUnavailable) { throw 'FIXTURE_SERVER_UNAVAILABLE' }
  $script:ServerReads++
  $script:ServerReply
}
function Invoke-FixtureSc([string]$action, [string]$name) {
  if ($name -cne 'CluedCISwapBroker') { throw 'FIXTURE_UNEXPECTED_SERVICE' }
  $global:LASTEXITCODE = 0
  $script:ScCalls.Add($action)
  switch ($action) {
    'stop' { $script:BrokerState = 1 }
    'start' { $script:BrokerState = 2 }
    'queryex' {
      'STATE : ' + $script:BrokerState
      'PID : ' + $(if ($script:BrokerState -eq 1) { 0 } else { 405 })
      if ($script:BrokerState -eq 2) { $script:BrokerState = 4 }
    }
    default { throw 'FIXTURE_UNEXPECTED_SCM_ACTION' }
  }
}

$U8 = [Text.UTF8Encoding]::new($false)
$Strict8 = [Text.UTF8Encoding]::new($false, $true)
$ControllerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Sc = 'Invoke-FixtureSc'
$script:BrokerState = 4
$script:ScCalls = [Collections.Generic.List[string]]::new()
$script:ServerUnavailable = $false
$script:ServerReads = 0
$script:ServerAttempts = 0
$script:BadRequests = 0
$script:Children = 0
$script:CompanionStarts = 0
$script:Rearms = 0
$launcher = Join-Path $SourceRoot 'reinstall\launcher\template.ps1'
$installer = Join-Path $SourceRoot 'windows\install-resident.ps1'
$verifier = Join-Path $SourceRoot 'windows\verify-resident.ps1'

# A standard Windows user can own fixture files. Use that SID in place of BA in the extracted ACL literals.
# All file security checks, file handles and the atomic replacement still use Windows itself.
$productionSddl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'
$fixtureSddl = "O:${ControllerSid}D:P(A;;FA;;;SY)(A;;FA;;;$ControllerSid)"
$names = @('Sha256Bytes','Get-FleetCiPlan','Get-FleetCiProofPath','Read-FleetCiVerifyHelpers','Assert-CiReinstallServicePins',
  'Read-FleetCiCandidate','Confirm-CiReinstallServer','Get-FleetCiProofPin','Assert-FleetCiSameProof','Write-FleetCiProof',
  'Confirm-FleetCiBeforeApply','Assert-FleetCiInstallPause','Confirm-FleetCiAfterInstall',
  'Get-FleetCiVerified','Assert-CiInstallBaseline','Assert-FleetCiConnection','Confirm-FleetCiBeforeLinuxB','Restore-FleetCiBrokerBeforeLinuxB',
  'Wait-Until','Get-ScState','Read-FleetFileChecked','Get-FileSha','Step-Install','Stop-Launch')
foreach ($fn in Read-Functions $launcher $names) {
  . ([scriptblock]::Create((Use-FixtureClock $fn.Extent.Text).Replace($productionSddl, $fixtureSddl)))
}
$verdict = Read-Functions (Join-Path $SourceRoot 'rollout\fleet\bootstrap.ps1') @('Get-LauncherVerdict')
. ([scriptblock]::Create($verdict.Extent.Text))
$names = @('Read-PackageRecordFile','Read-InstallCiVerifyHelpers','Assert-ProtectedCiReinstall','Write-NewSecret',
  'Test-BytesEqualClear','Get-DaclPart','Sha256Text')
foreach ($fn in Read-Functions $installer $names) {
  $source = $fn.Extent.Text.Replace('O:BAG:BA', "O:$ControllerSid")
  if ($fn.Name -ceq 'Write-NewSecret') {
    $source = $source.Replace('O:BA', "O:$ControllerSid").Replace('S-1-5-32-544', $ControllerSid)
  }
  . ([scriptblock]::Create($source))
}
$private = (Read-Functions $verifier @('Read-CiPrivateBytes')).Extent.Text
$privateStub = (Read-Functions $PSCommandPath @('Read-CiPrivateBytes')).Extent.Text
$proofSource = (Read-Functions $verifier @('Read-CiReinstallEvidence')).Extent.Text
$fixtureProofSource = $proofSource.Replace($productionSddl, $fixtureSddl).Replace('S-1-5-32-544', $ControllerSid)
$applyProofSource = (Read-Functions $verifier @('Read-CiReinstallApplyProof')).Extent.Text
. ([scriptblock]::Create($fixtureProofSource))
foreach ($fn in Read-Functions $verifier @('Get-EffectiveCiPrincipal','Get-CiAdmissionTokenPin','Read-CiReinstallProof')) {
  . ([scriptblock]::Create($fn.Extent.Text))
}

$CarryParent = $CiRoot
$ResidentRoot = Join-Path $CiRoot 'resident'
$PackageRoot = Join-Path $CiRoot 'package'
$RecordFile = Join-Path $CiRoot 'secrets\ci-admission.connection.json'
$TokenFile = Join-Path $CiRoot 'secrets\ci-admission.token'
foreach ($dir in @('secrets','resident\state','resident\secrets','resident\upgrade','resident\record','resident\install','package\record')) {
  $null = [IO.Directory]::CreateDirectory((Join-Path $CiRoot $dir))
}
$verifyPath = Join-Path $PackageRoot 'verify-resident.ps1'
$fixtureVerifySource = [IO.File]::ReadAllText($verifier).Replace($private, $privateStub).Replace($proofSource, $fixtureProofSource)
[IO.File]::WriteAllText($verifyPath, $fixtureVerifySource.Replace($applyProofSource, (Use-FixtureClock $applyProofSource)), $U8)
$verifySha = Get-FileSha $verifyPath
$Staged = @{ 'verify-resident.ps1' = @('verify-resident.ps1', $verifySha) }
$NodeName = 'FIXTURE-NODE'
$Identity = @{ nodeName = $NodeName }
$OldIdentitySha = 'a' * 64
$IdentitySha256 = 'b' * 64
$FleetPlanSha256 = 'c' * 64
$installation = [ordered]@{ supabaseUrl = 'https://fixture.supabase.co'; publishableKey = 'sb_publishable_fixture_only'; scope = 'global' }
$candidateInstallation = [ordered]@{ supabaseUrl = $installation.supabaseUrl; publishableKey = 'sb_publishable_fixture_candidate'; scope = $installation.scope }
$oldRecordPath = Join-Path $ResidentRoot 'record\installation.json'
Write-JsonFixture $oldRecordPath $installation
$candidateFile = Join-Path $PackageRoot 'record\installation.json'
Write-JsonFixture $candidateFile $candidateInstallation
$manifest = Join-Path $PackageRoot 'package-manifest.json'
Write-JsonFixture $manifest ([ordered]@{ nodeIdentitySha256 = $IdentitySha256; residentManifestSha256 = 'd' * 64; files = @(
  @{ target = ('resident\' + ('d' * 64) + '\windows\verify-resident.ps1'); path = 'verify-resident.ps1'; sha256 = $verifySha },
  @{ target = 'record\installation.json'; path = 'record\installation.json'; sha256 = (Get-FileSha $candidateFile) }
) })
$pkgBytes = [IO.File]::ReadAllBytes($manifest)
$PackageManifestSha256 = Sha256Bytes $pkgBytes
$ExpectedPackageManifestSha256 = $PackageManifestSha256
$receipt = Join-Path $ResidentRoot 'install\install-receipt.json'
Write-JsonFixture $receipt ([ordered]@{ packageManifestSha256 = 'e' * 64; installationSha256 = (Get-FileSha $oldRecordPath); nodeIdentitySha256 = $OldIdentitySha })
$InstalledReceiptSha256 = Get-FileSha $receipt
$residentSource = 'f' * 64
Write-JsonFixture (Join-Path $ResidentRoot 'upgrade\current.json') ([ordered]@{ installReceiptSha256 = $InstalledReceiptSha256; packageManifestSha256 = 'e' * 64; ciSourceManifestSha256 = $residentSource })
$record = [ordered]@{
  activatedAt = '2026-11-27T00:00:00.000Z'; baseNodeIdentitySha256 = $OldIdentitySha; bindingGeneration = 3
  bindingId = '11111111-1111-4111-8111-111111111111'; contract = 'clued.independent-ci.ci-connection/1'; previousSha256 = '9' * 64
  rebindReceiptId = '22222222-2222-4222-8222-222222222222'; tokenPinSha256 = (Get-CiAdmissionTokenPin (Read-CiPrivateBytes $TokenFile $ControllerSid))
}
Write-NewSecret $RecordFile ($U8.GetBytes(($record | ConvertTo-Json -Compress))) $fixtureSddl
$script:ServerReply = [pscustomobject]@{ status = 'ok'; contract = 'clued.ci.connection-self/1'; binding_id = $record.bindingId
  connection_expires_at = (Get-DrillTime).AddHours(1).ToString('o'); node = [pscustomobject]@{
    name = $NodeName; node_id = '33333333-3333-4333-8333-333333333333'; identity_fingerprint = '4' * 64; state = 'active'
    rebind_receipt_id = $record.rebindReceiptId; binding_generation = $record.bindingGeneration
  }
}
$current = [ordered]@{ state = 'current'; receiptSha256 = $InstalledReceiptSha256; recordSha256 = (Get-FileSha $RecordFile)
  bindingId = $record.bindingId; bindingGeneration = $record.bindingGeneration; rebindReceiptId = $record.rebindReceiptId }
$facts = [ordered]@{ at = 1795741200000; source = $residentSource; bindingId = $record.bindingId; expiresAt = '2026-12-01T00:00:00Z' }
$observation = Join-Path $ResidentRoot 'state\connection-renewal.json'
function Write-Observation($pending) {
  $lane = [ordered]@{ waiting = $false; code = $null }
  foreach ($key in $facts.Keys) { $lane[$key] = $facts[$key] }
  Write-JsonFixture $observation @{ pending = $pending; lanes = @{ ci = $lane } }
}
Write-Observation $null
$plan = $current
if ($Scenario -cin @('observed', 'continue')) {
  $plan = [ordered]@{ state = 'observed'; receiptSha256 = $InstalledReceiptSha256; bindingId = $record.bindingId
    observationSha256 = (Sha256Text ($facts | ConvertTo-Json -Compress)) }
}
$FleetCiConnectionB64 = [Convert]::ToBase64String($U8.GetBytes(($plan | ConvertTo-Json -Compress)))
$CarriedCiPlan = Get-FleetCiPlan
$CiReinstallProof = Get-FleetCiProofPath
$Stage = $PackageRoot
$Out = $Stage
$CiReinstallApplyStage = $Stage
$ExpectedPlanSha256 = '7' * 64
$R5c = @{ applyPlanSha256 = $ExpectedPlanSha256 }
$Done = [Collections.Generic.List[string]]::new()
$installedPause = @{ verified = $true; confirmed = $true; requestSha256 = '8' * 64 }
function Remove-FleetCarry {}
function Write-Json([string]$name, $value) { Write-JsonFixture (Join-Path $Out $name) $value }
function Invoke-Child { $script:Children++; throw 'FIXTURE_INSTALLER_CHILD_STARTED' }
function Get-InstallArgs {}
function Get-Key($value, $key) { if ($value -is [Collections.IDictionary]) { $value[$key] } else { $value.$key } }
function Parse-Json([string]$text) { ConvertFrom-Json -InputObject $text }
function Step-PauseAfterInstall { $installedPause }
function Step-StartCompanion { $script:CompanionStarts++; @{ started = $true } }
function Step-Rearm { $script:Rearms++; @{ requested = $true } }

function Assert-FixtureStopped([string]$code) {
  $terminal = [IO.File]::ReadAllText((Join-Path $Out 'terminal.json')) | ConvertFrom-Json
  $verdict = Get-LauncherVerdict $false $terminal
  if ($terminal.status -cne 'STOPPED' -or $verdict.status -cne 'BOOTSTRAP_LAUNCHER_ENDED' -or $verdict.code -cne $code) {
    throw 'FIXTURE_BOOTSTRAP_RELEASED_UNVERIFIED_INSTALL'
  }
}
function Move-FixtureOld {
  $kept = Join-Path $CiRoot 'resident-uninstalled-20261127T000000Z-012345abcdef'
  [IO.Directory]::Move($ResidentRoot, $kept)
  $script:uninstall = @{ keptAt = $kept }
  $script:AfterLinuxB = $true
}
function New-FixtureApply {
  $apply = Confirm-FleetCiBeforeApply $uninstall.keptAt
  $script:CiReinstallApplyProof = $apply.path
  $script:CiReinstallApplyProofSha256 = $apply.sha256
}
function New-FixtureInstall {
  $audit = Assert-ProtectedCiReinstall -Commit
  foreach ($subdir in @('install','record','state','secrets')) { [void][IO.Directory]::CreateDirectory((Join-Path $ResidentRoot $subdir)) }
  Write-JsonFixture $receipt ([ordered]@{ contract = 'clued.independent-ci.resident-install-receipt/6'; packageManifestSha256 = $PackageManifestSha256
    installationSha256 = (Get-FileSha $candidateFile); nodeIdentitySha256 = $IdentitySha256; ciConnectionReinstall = $audit })
  [IO.File]::Copy($candidateFile, $oldRecordPath)
  Write-JsonFixture (Join-Path $ResidentRoot 'state\PAUSED.json') @{ source = @{ requestSha256 = $installedPause.requestSha256 } }
}
function Invoke-InstalledGate {
  $install = @{ receiptSha256 = Get-FileSha $receipt }
  $verify = @{ status = 'RESIDENT_VERIFIED' }
  # Run the launcher control flow between pause and rearm with only role/task operations stubbed.
  $main = [IO.File]::ReadAllText($launcher).Split(@('#region main'), [StringSplitOptions]::None)[1]
  $start = $main.IndexOf('  $pause = Step-PauseAfterInstall')
  $end = $main.IndexOf('  if ($CompanionWslVhdxDirectory)', $start)
  . ([scriptblock]::Create($main.Substring($start, $end - $start)))
}

switch -CaseSensitive ($Scenario) {
  'observed' {
    Assert-CiInstallBaseline $CiRoot
    $facts.at += 86400000
    Write-Observation $null
    Assert-CiInstallBaseline $CiRoot
    if ($script:ServerReads -ne 2) { throw 'FIXTURE_OBSERVED_SERVER_WAS_NOT_RECHECKED' }
  }
  'continue' {
    Assert-CiInstallBaseline $CiRoot
    Confirm-FleetCiBeforeLinuxB
    $ContinueLinuxFrom = 'prior-launch'
    $ContinueCiProofSha256 = Get-FileSha $CiReinstallProof
    $facts.at += 86400000
    Write-Observation @{ kind = 'ci' }
    Remove-Variable VerifiedCiCarry -Scope Script
    Assert-CiInstallBaseline $CiRoot
    $step = Read-Functions (Join-Path $SourceRoot 'reinstall\launcher\continue-install.ps1') @('Step-ContinueBeforeUninstall')
    $gate = $step.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and
      $n.Extent.Text -match '^if \(Get-Variable ContinueCiProofSha256[^\r\n]+\{ Confirm-FleetCiBeforeLinuxB -AfterLinuxB \}' }, $true)
    if (-not $gate -or -not $ContinueCiProofSha256) { throw 'FIXTURE_CONTINUATION_GATE_MISSING' }
    . ([scriptblock]::Create($gate.Extent.Text))
    if ((Get-FileSha $CiReinstallProof) -cne $ContinueCiProofSha256 -or $script:BrokerState -ne 1 -or $script:ServerReads -ne 4) {
      throw 'FIXTURE_CONTINUATION_DID_NOT_VERIFY_THE_SAME_CONNECTION'
    }
  }
  'recover' {
    Assert-CiInstallBaseline $CiRoot
    $script:ServerUnavailable = $true
    Expect-Refusal 'CI_CONNECTION_SERVICE_UNAVAILABLE' { Confirm-FleetCiBeforeLinuxB }
    if (($script:ScCalls -join ',') -cne 'queryex,stop,queryex,start,queryex,queryex' -or $script:BrokerState -ne 4) {
      throw 'FIXTURE_BROKER_NOT_RESTORED'
    }
    if ([IO.File]::Exists($CiReinstallProof)) { throw 'FIXTURE_UNEXPECTED_PROOF' }
  }
  'commit' {
    Assert-CiInstallBaseline $CiRoot
    Confirm-FleetCiBeforeLinuxB
    $proof = Read-CiReinstallProof $CiReinstallProof $CiRoot $CarriedCiPlan $PackageManifestSha256
    Move-FixtureOld
    New-FixtureApply
    $dacl = [IO.File]::GetAccessControl($RecordFile).GetSecurityDescriptorSddlForm('Access')
    $before = $script:ServerAttempts
    $script:Offline = $true
    try {
      Assert-ProtectedCiReinstall
      $audit = Assert-ProtectedCiReinstall -Commit
    } finally {
      if ($script:ServerAttempts -ne $before) { throw 'FIXTURE_INSTALLER_NETWORK_CALL' }
    }
    $bytes = [IO.File]::ReadAllBytes($RecordFile)
    $principal = Get-EffectiveCiPrincipal $Identity $bytes $IdentitySha256
    if ($principal.bindingId -cne $record.bindingId -or $principal.generation -ne $record.bindingGeneration -or
        $principal.receiptId -cne $record.rebindReceiptId -or $principal.tokenPinSha256 -cne $record.tokenPinSha256 -or
        $audit.previousRecordSha256 -cne $current.recordSha256 -or $audit.recordSha256 -cne $proof.newRecordSha256 -or
        $script:ServerReads -ne 3 -or [IO.File]::GetAccessControl($RecordFile).GetSecurityDescriptorSddlForm('Access') -cne $dacl) {
      throw 'FIXTURE_REANCHORED_PRINCIPAL_CHANGED'
    }
    # SwapBroker parses, sorts with StringComparer.Ordinal and serializes with JavaScriptSerializer.
    Add-Type -AssemblyName System.Web.Extensions
    $serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
    $record.baseNodeIdentitySha256 = $IdentitySha256
    $sorted = [Collections.Generic.SortedDictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach ($key in $record.Keys) { $sorted.Add($key, $record[$key]) }
    if ([Convert]::ToBase64String($bytes) -cne [Convert]::ToBase64String($U8.GetBytes($serializer.Serialize($sorted)))) {
      throw 'FIXTURE_REANCHORED_BYTES_NOT_BROKER_CANONICAL'
    }
    Expect-Refusal 'CI_CONNECTION_RECORD_REFUSED' { Get-EffectiveCiPrincipal $Identity $bytes $OldIdentitySha }
  }
  'pre-apply-revoked' {
    Assert-CiInstallBaseline $CiRoot
    Confirm-FleetCiBeforeLinuxB
    Move-FixtureOld
    $pending = Join-Path $uninstall.keptAt 'secrets\resident-upgrade.token.renew-pending'
    [IO.File]::WriteAllText($pending, '{}', $U8)
    Expect-Refusal 'CI_CONNECTION_TRANSACTION_IN_FLIGHT' { Step-Install }
    [IO.File]::Delete($pending)
    $record.bindingGeneration++
    Write-JsonFixture $RecordFile $record
    Expect-Refusal 'CI_CONNECTION_GENERATION_CHANGED' { Step-Install }
    $record.bindingGeneration--
    Write-JsonFixture $RecordFile $record
    if ($script:ServerAttempts -ne 2) { throw 'FIXTURE_PROBED_CHANGED_CONNECTION' }
    $script:HttpStatus = 401
    Expect-Refusal 'CI_CONNECTION_REVOKED' { Step-Install }
    Assert-FixtureStopped 'CI_CONNECTION_REVOKED'
    if ($script:Children -ne 0 -or $script:ServerAttempts -ne 3) { throw 'FIXTURE_APPLY_DID_NOT_STOP' }
  }
  'apply-proof-refused' {
    Assert-CiInstallBaseline $CiRoot
    Confirm-FleetCiBeforeLinuxB
    Move-FixtureOld
    Expect-Refusal 'CI_CONNECTION_PROTECTED_PROOF_REQUIRED' { Assert-ProtectedCiReinstall }
    New-FixtureApply
    $applyBytes = [IO.File]::ReadAllBytes($CiReinstallApplyProof)
    $applySha = $CiReinstallApplyProofSha256
    $changed = $U8.GetString($applyBytes) | ConvertFrom-Json
    $changed.phase = 'after-windows-install'
    Write-JsonFixture $CiReinstallApplyProof $changed
    Expect-Refusal 'CI_CONNECTION_PROOF_CHANGED' { Assert-ProtectedCiReinstall }
    $CiReinstallApplyProofSha256 = Get-FileSha $CiReinstallApplyProof
    Expect-Refusal 'CI_CONNECTION_APPLY_PROOF_CHANGED' { Assert-ProtectedCiReinstall }
    $changed.phase = 'before-windows-apply'
    $changed.expiresAt = (Get-DrillTime).AddSeconds(-10).ToString('o')
    Write-JsonFixture $CiReinstallApplyProof $changed
    $CiReinstallApplyProofSha256 = Get-FileSha $CiReinstallApplyProof
    Expect-Refusal 'CI_CONNECTION_APPLY_PROOF_EXPIRED' { Assert-ProtectedCiReinstall -Commit }
    [IO.File]::WriteAllBytes($CiReinstallApplyProof, $applyBytes)
    $CiReinstallApplyProofSha256 = $applySha
    $ExpectedPackageManifestSha256 = '0' * 64
    Expect-Refusal 'REVIEWED_PACKAGE_CHANGED' { Assert-ProtectedCiReinstall }
    $ExpectedPackageManifestSha256 = $PackageManifestSha256
    $ExpectedPlanSha256 = '0' * 64
    Expect-Refusal 'CI_CONNECTION_APPLY_PROOF_CHANGED' { Assert-ProtectedCiReinstall }
    $ExpectedPlanSha256 = $R5c.applyPlanSha256
    $record.previousSha256 = '0' * 64
    Write-JsonFixture $RecordFile $record
    Expect-Refusal 'CI_CONNECTION_RECORD_CHANGED' { Assert-ProtectedCiReinstall -Commit }
    $record.previousSha256 = '9' * 64
    Write-JsonFixture $RecordFile $record
    $script:BrokerState = 4
    Expect-Refusal 'CI_CONNECTION_BROKER_NOT_STOPPED' { Assert-ProtectedCiReinstall -Commit }
    $script:BrokerState = 1
    $pending = $TokenFile + '.renew-pending'
    [IO.File]::WriteAllText($pending, '{}', $U8)
    Expect-Refusal 'CI_CONNECTION_TRANSACTION_IN_FLIGHT' { Assert-ProtectedCiReinstall -Commit }
    [IO.File]::Delete($pending)
    $acl = [IO.File]::GetAccessControl($CiReinstallApplyProof, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetSecurityDescriptorSddlForm(($fixtureSddl + '(A;;FR;;;BU)'), 'Access')
    [IO.File]::SetAccessControl($CiReinstallApplyProof, $acl)
    Expect-Refusal 'CI_CONNECTION_PROOF_BOUNDARY_REFUSED' { Assert-ProtectedCiReinstall -Commit }
    $keptProof = Join-Path $Stage 'held-apply.json'
    [IO.File]::Move($CiReinstallApplyProof, $keptProof)
    $null = New-Item -ItemType HardLink -Path $CiReinstallApplyProof -Target $keptProof
    Expect-Refusal 'CI_CONNECTION_PROOF_PATH_REFUSED' { Assert-ProtectedCiReinstall -Commit }
    if ((Get-FileSha $RecordFile) -cne $current.recordSha256) { throw 'FIXTURE_REFUSAL_ALTERED_RECORD' }
  }
  'post-install-refused' {
    Assert-CiInstallBaseline $CiRoot
    Confirm-FleetCiBeforeLinuxB
    Move-FixtureOld
    New-FixtureApply
    New-FixtureInstall
    $paused = Join-Path $ResidentRoot 'state\PAUSED.json'
    $pauseSha = Get-FileSha $paused
    $ContinueCiProofSha256 = Get-FileSha $CiReinstallProof
    foreach ($case in @('401','403','timeout','missing','expired','generation','fingerprint')) {
      $reply = $script:ServerReply
      $node = $reply.node
      $expires = $reply.connection_expires_at
      $generation = $node.binding_generation
      $fingerprint = $node.identity_fingerprint
      $code = switch ($case) {
        { $_ -in @('401','403') } { $script:HttpStatus = [int]$case; 'CI_CONNECTION_REVOKED' }
        'timeout' { $script:ServerUnavailable = $true; 'CI_CONNECTION_SERVICE_UNAVAILABLE' }
        'missing' { $reply.node = $null; 'CI_CONNECTION_SERVER_EVIDENCE_REFUSED' }
        'expired' { $reply.connection_expires_at = '2000-01-01T00:00:00Z'; 'CI_CONNECTION_SERVER_EVIDENCE_REFUSED' }
        'generation' { $node.binding_generation++; 'CI_CONNECTION_GENERATION_CHANGED' }
        'fingerprint' { $node.identity_fingerprint = '5' * 64; 'CI_CONNECTION_SERVER_NODE_CHANGED' }
      }
      Expect-Refusal $code { Invoke-InstalledGate }
      Assert-FixtureStopped $code
      if ($script:CompanionStarts -or $script:Rearms -or (Get-FileSha $paused) -cne $pauseSha) { throw 'FIXTURE_RELEASED_UNVERIFIED_INSTALL' }
      [IO.File]::Delete((Join-Path $Out 'ci-connection-after-install.json'))
      $script:HttpStatus = $null
      $script:ServerUnavailable = $false
      $reply.node = $node
      $reply.connection_expires_at = $expires
      $node.binding_generation = $generation
      $node.identity_fingerprint = $fingerprint
    }
    $ContinueAfterInstallFrom = 'rearm'
    Remove-Variable FleetCiProofSha256 -Scope Script
    $before = $script:ServerAttempts
    $script:ServerUnavailable = $true
    Expect-Refusal 'CI_CONNECTION_SERVICE_UNAVAILABLE' { Invoke-InstalledGate }
    if ($script:CompanionStarts -or $script:Rearms -or $script:ServerAttempts -ne ($before + 1)) { throw 'FIXTURE_CONTINUATION_BYPASSED_GATE' }
    [IO.File]::Delete((Join-Path $Out 'ci-connection-after-install.json'))
    $script:ServerUnavailable = $false
    Invoke-InstalledGate
    if ($script:CompanionStarts -ne 1 -or $script:Rearms -ne 1 -or $script:Children -ne 0 -or
        $script:ServerAttempts -ne ($before + 2)) { throw 'FIXTURE_CONTINUATION_DID_NOT_REUSE_INSTALL' }
    $reportFile = Join-Path $Out 'ci-connection-after-install.json'
    foreach ($file in @($CiReinstallProof, $CiReinstallApplyProof, $reportFile)) {
      $body = [IO.File]::ReadAllText($file)
      foreach ($secret in @('clued_bnd_reinstall_fixture_only', (Sha256Text 'clued_bnd_reinstall_fixture_only'), 'p_token_hash', 'identity_fingerprint')) {
        if ($body.Contains($secret)) { throw 'FIXTURE_CREDENTIAL_MATERIAL_IN_EVIDENCE' }
      }
    }
    if (([IO.File]::ReadAllText($reportFile) | ConvertFrom-Json).code -cne 'CI_CONNECTION_INSTALL_CONFIRMED') { throw 'FIXTURE_MISSING_SUCCESS_AUDIT' }
  }
  'refuse' {
    Assert-CiInstallBaseline $CiRoot
    Confirm-FleetCiBeforeLinuxB
    foreach ($fn in Read-Functions $verifier @('Read-CiReinstallSnapshot')) { . ([scriptblock]::Create($fn.Extent.Text)) }
    foreach ($change in @(
      @($script:ServerReply, 'binding_id', '44444444-4444-4444-8444-444444444444', 'CI_CONNECTION_SERVER_EVIDENCE_REFUSED'),
      @($script:ServerReply.node, 'binding_generation', 4, 'CI_CONNECTION_GENERATION_CHANGED'),
      @($script:ServerReply.node, 'rebind_receipt_id', '55555555-5555-4555-8555-555555555555', 'CI_CONNECTION_SERVER_EVIDENCE_REFUSED'),
      @($script:ServerReply.node, 'identity_fingerprint', ('5' * 64), 'CI_CONNECTION_SERVER_NODE_CHANGED')
    )) {
      $target, $field, $value, $code = $change
      $before = $target.$field
      $target.$field = $value
      Expect-Refusal $code { Assert-FleetCiConnection $CiRoot }
      $target.$field = $before
    }
    foreach ($change in @(
      @('bindingId', '44444444-4444-4444-8444-444444444444', 'CI_CONNECTION_GENERATION_CHANGED'),
      @('bindingGeneration', 4, 'CI_CONNECTION_GENERATION_CHANGED'),
      @('rebindReceiptId', '55555555-5555-4555-8555-555555555555', 'CI_CONNECTION_RECORD_CHANGED'),
      @('tokenPinSha256', ('5' * 64), 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED')
    )) {
      $field, $value, $code = $change
      $before = $record[$field]
      $record[$field] = $value
      Write-JsonFixture $RecordFile $record
      $snapshotPlan = [pscustomobject]$current
      $snapshotPlan.recordSha256 = Get-FileSha $RecordFile
      Expect-Refusal $code { Read-CiReinstallSnapshot $CiRoot $ControllerSid $OldIdentitySha $snapshotPlan }
      $record[$field] = $before
    }
    Write-JsonFixture $RecordFile $record
    $pending = Join-Path $CiRoot 'secrets\ci-admission.connection.json.pending'
    [IO.File]::WriteAllText($pending, '{}', $U8)
    Expect-Refusal 'CI_CONNECTION_TRANSACTION_IN_FLIGHT' { Get-FleetCiVerified $CiRoot }
    [IO.File]::Delete($pending)

    # Match the real DACL while retaining the production owner check to isolate a wrong owner.
    . ([scriptblock]::Create($proofSource.Replace($productionSddl, $fixtureSddl)))
    Expect-Refusal 'CI_CONNECTION_PROOF_BOUNDARY_REFUSED' { Read-CiReinstallProof $CiReinstallProof $CiRoot $CarriedCiPlan $PackageManifestSha256 }
    . ([scriptblock]::Create($fixtureProofSource))
    $acl = [IO.File]::GetAccessControl($CiReinstallProof, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetSecurityDescriptorSddlForm(($fixtureSddl + '(A;;FR;;;BU)'), 'Access')
    [IO.File]::SetAccessControl($CiReinstallProof, $acl)
    Expect-Refusal 'CI_CONNECTION_PROOF_BOUNDARY_REFUSED' { Read-CiReinstallProof $CiReinstallProof $CiRoot $CarriedCiPlan $PackageManifestSha256 }
    if ((Get-FileSha $RecordFile) -cne $current.recordSha256) { throw 'FIXTURE_REFUSAL_ALTERED_RECORD' }
  }
  default { throw 'FIXTURE_UNKNOWN_SCENARIO' }
}
if ($script:BadRequests) { throw 'FIXTURE_SERVER_REQUEST_CHANGED' }
[Console]::Write('PASS')
