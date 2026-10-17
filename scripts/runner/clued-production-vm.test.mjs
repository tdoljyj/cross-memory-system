import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const hostPath = fileURLToPath(new URL('./clued-production-vm.ps1', import.meta.url));
const profilePath = fileURLToPath(new URL('../ci/self-hosted/production-publisher-profile.json', import.meta.url));
const guestPath = fileURLToPath(new URL('./clued-production-vm-guest-init.sh', import.meta.url));
const hostSource = fs.readFileSync(hostPath, 'utf8');
const sourceSha256 = createHash('sha256').update(hostSource).digest('hex');
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const windows = process.platform === 'win32';
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
// A Node child of PowerShell 7 inherits its PSModulePath. Supply only the
// operating system's Windows PowerShell modules to the explicit 5.1 process.
const windowsPowerShellEnv = () => ({ ...process.env,
  PSModulePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules'),
});

// Windows cases execute only AST-extracted functions/branches. The real script's
// top-level host/module/lifecycle code is never loaded by this harness.
function runWindowsCase(body) {
  const fixtureParent = path.resolve(path.dirname(hostPath), '../../../cause/trace-20261018/vm-tests');
  fs.mkdirSync(fixtureParent, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(fixtureParent, 'host-'));
  const harness = path.join(fixture, 'harness.ps1');
  const managedRoot = path.join(fixture, 'managed');
  fs.mkdirSync(managedRoot);
  const script = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sourcePath = ${psQuote(hostPath)}
$expectedSha = ${psQuote(sourceSha256)}
if ((Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedSha) { throw 'Host source changed during this test.' }
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Host source did not parse in Windows PowerShell.' }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    Invoke-Expression $definition.Extent.Text
}
$identityDefinitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Add-Type' }, $true))
if ($identityDefinitions.Count -ne 1) { throw 'Cannot uniquely load the actual file identity verifier.' }
Invoke-Expression $identityDefinitions[0].Extent.Text
$profile = Get-Content -LiteralPath ${psQuote(profilePath)} -Raw | ConvertFrom-Json
$rootPath = ${psQuote(managedRoot)}
$actorSid = 'S-1-5-21-1000'
$checks = New-Object 'Collections.Generic.List[string]'
function Check([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw ('Assertion failed: ' + $Name) }
    $checks.Add($Name)
}
function Reject([scriptblock]$Code, [string]$Pattern, [string]$Name) {
    $caught = $null
    try { & $Code | Out-Null } catch { $caught = $_ }
    if ($null -eq $caught -or $caught.Exception.Message -notmatch $Pattern) { throw ('Expected rejection: ' + $Name + '; actual=' + $caught) }
    $checks.Add($Name)
}
function Load-Action([string]$Name) {
    $prefix = 'if (' + [char]36 + 'Action -eq ' + [char]39 + $Name + [char]39 + ')'
    $matches = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith($prefix) }, $true))
    if ($matches.Count -ne 1) { throw ('Cannot uniquely extract action ' + $Name) }
    return $matches[0].Extent.Text
}
${body}
@{ schema = 'clued.production-vm.boundary-test/1'; source_sha256 = $expectedSha; powershell = $PSVersionTable.PSVersion.ToString(); checks = @($checks.ToArray()) } | ConvertTo-Json -Depth 6 -Compress
`;
  fs.writeFileSync(harness, script, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
    env: windowsPowerShellEnv(), encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nFixture: ${fixture}`);
  const resultLine = result.stdout.trim().split(/\r?\n/u).findLast(line => line.startsWith('{'));
  assert.ok(resultLine, result.stdout);
  const report = JSON.parse(resultLine);
  assert.equal(report.source_sha256, sourceSha256);
  assert.match(report.powershell, /^5\.1\./u);
  assert.ok(report.checks.length > 0);
  return report;
}

test('publisher profile keeps production and implicit host access closed on every platform', () => {
  assert.equal(profile.schema, 'clued.production-publisher.host-profile/1');
  assert.equal(profile.version, '1.0.0');
  assert.equal(profile.root, 'D:\\CluedProductionPublisher');
  assert.equal(profile.host_name, 'DESK-W-591');
  assert.equal(profile.generation, 2);
  assert.equal(profile.memory_bytes, 8 * 1024 ** 3);
  assert.equal(profile.disk_bytes, 64 * 1024 ** 3);
  assert.equal(profile.production_qualified, false);
  assert.equal(profile.qualification, null);
  assert.equal(profile.network_status, 'UNVERIFIED');
  assert.deepEqual(profile.isolation, {
    new_vm_per_job: true,
    new_differencing_disk_per_job: true,
    host_directory_mounts: false,
    host_container_socket: false,
    persistent_runner_registration: false,
    automatic_runner_registration: false,
    automatic_production_credentials: false,
  });
});

test('Windows PowerShell Plan is read-only and never grants production qualification', { skip: !windows }, () => {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hostPath, '-Action', 'Plan'], {
    env: windowsPowerShellEnv(), encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout.trim());
  assert.equal(plan.action, 'Plan');
  assert.equal(plan.side_effects, false);
  assert.equal(plan.production_authorized, false);
  assert.deepEqual(plan.profile, profile);
});

test('Windows managed paths reject traversal, sibling prefixes, ADS, reparse points, and hard links', { skip: !windows }, () => {
  const report = runWindowsCase(String.raw`
$inside = Join-Path $rootPath 'owned.txt'
[IO.File]::WriteAllText($inside, 'owned')
Check ((Assert-SafePath $inside -MustExist) -ceq $inside) 'owned regular file accepted'
Check ((Assert-SafePath $rootPath -AllowRoot -MustExist) -ceq $rootPath) 'explicit root read accepted'
Reject { Assert-SafePath $rootPath } 'root is forbidden' 'implicit root rejected'
Reject { Assert-SafePath 'relative.txt' } 'absolute managed path' 'relative path rejected'
Reject { Assert-SafePath ($rootPath + '-sibling\owned.txt') } 'leaves the dedicated' 'sibling prefix rejected'
Reject { Assert-SafePath (Join-Path $rootPath '..\outside.txt') } 'leaves the dedicated' 'normalized traversal rejected'
Reject { Assert-SafePath ($inside + ':payload') } '.' 'ADS rejected before filesystem use'
Reject { Assert-SafePath (Join-Path $rootPath 'missing.txt') -MustExist } 'does not exist' 'missing managed file rejected'
$hardLink = Join-Path $rootPath 'hard-link.txt'
New-Item -ItemType HardLink -Path $hardLink -Target $inside | Out-Null
Reject { Assert-SafePath $hardLink -MustExist } 'Hard-linked' 'hard-linked alias rejected'
Reject { Assert-SafePath $inside -MustExist } 'Hard-linked' 'original of a hard link also rejected'
$target = Join-Path $rootPath 'target'
New-Item -ItemType Directory -Path $target | Out-Null
$junction = Join-Path $rootPath 'junction'
New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
Reject { Assert-SafePath (Join-Path $junction 'not-created.txt') } 'Reparse points' 'reparse ancestor rejected'
`);
  assert.equal(report.checks.length, 11);
});

test('Windows file identity remains inspectable under an exclusive writer without relaxing hard-link rejection', { skip: !windows }, () => {
  const report = runWindowsCase(String.raw`
$file = Join-Path $rootPath 'writer-held.vhdx'
[IO.File]::WriteAllText($file, 'fixture-content-must-survive')
$before = [IO.File]::ReadAllBytes($file)
$writer = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    Check ((Assert-SafePath $file -MustExist) -ceq $file) 'file identity can be inspected while an exclusive writer owns the data handle'
} finally { $writer.Dispose() }
Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -ceq [Convert]::ToBase64String($before)) 'identity inspection preserves file bytes'
$linked = Join-Path $rootPath 'writer-held-linked.vhdx'
$alias = Join-Path $rootPath 'writer-held-alias.vhdx'
[IO.File]::WriteAllText($linked, 'linked-fixture')
New-Item -ItemType HardLink -Path $alias -Target $linked | Out-Null
$writer = [IO.File]::Open($linked, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    Reject { Assert-SafePath $linked -MustExist } 'Hard-linked' 'writer-held original with a hard link remains rejected'
    Reject { Assert-SafePath $alias -MustExist } 'Hard-linked' 'alias of a writer-held hard link remains rejected'
} finally { $writer.Dispose() }
`);
  assert.equal(report.checks.length, 4);
});

test('Windows manifest replacement is repeatable, atomic on failure, and preserves the original error', { skip: !windows }, () => {
  const report = runWindowsCase(String.raw`
$folder = Join-Path $rootPath 'manifest-case'
New-Item -ItemType Directory -Path $folder | Out-Null
$manifest = [pscustomobject]@{ schema = 'test'; generation = 0; updated_utc = $null }
Save-Manifest $manifest $folder
$manifestPath = Join-Path $folder 'manifest.json'
foreach ($generation in 1..5) {
    $manifest.generation = $generation
    Save-Manifest $manifest $folder
    $readback = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    Check ($readback.generation -eq $generation -and -not [string]::IsNullOrWhiteSpace($readback.updated_utc)) ('real File.Replace readback ' + $generation)
}
Check (@(Get-ChildItem -LiteralPath $folder -Filter '*.tmp').Count -eq 0) 'successful replacement leaves no temp file'
$original = [IO.File]::ReadAllBytes($manifestPath)
$lock = [IO.File]::Open($manifestPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $manifest.generation = 99
    Reject { Save-Manifest $manifest $folder } '.' 'locked original rejects replacement'
} finally { $lock.Dispose() }
Check (@(Get-ChildItem -LiteralPath $folder -Filter '*.tmp').Count -eq 1) 'replacement failure occurs after the complete new temp manifest was staged'
Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($manifestPath)) -ceq [Convert]::ToBase64String($original)) 'failed replacement preserves original bytes'
Check ((Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).generation -eq 5) 'failed replacement preserves parseable original generation'
function Save-Manifest { throw 'persistence_failure_sentinel' }
$quarantine = [pscustomobject]@{ status = 'prepared'; quarantine_reason = $null; folder = $folder }
$originalError = $null
try { try { throw 'operation_failure_sentinel' } catch { Mark-Quarantined $quarantine 'operation_failed' -BestEffort; throw } } catch { $originalError = $_ }
Check ($originalError.Exception.Message -ceq 'operation_failure_sentinel') 'best-effort quarantine preserves original operation error'
Check ($quarantine.status -ceq 'quarantined') 'in-memory quarantine remains explicit after persistence failure'
`);
  assert.equal(report.checks.length, 12);
});

test('Windows instance identity, owned VM, devices, and pinned artifacts fail closed', { skip: !windows }, () => {
  const report = runWindowsCase(String.raw`
function Assert-Root { }
$id = [guid]::NewGuid()
$folder = Get-InstanceFolder $id
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$manifest = [pscustomobject]@{
    schema = 'clued.production-vm.instance/1'; instance_id = $id.ToString('D'); owner = $profile.owner
    host_name = $profile.host_name; host_sid = $actorSid; vm_name = $profile.vm_name_prefix + $id.ToString('N')
    folder = $folder; vm_id = [guid]::NewGuid().ToString('D'); owner_note = 'owned-note'; updated_utc = $null
    disk_path = Join-Path $folder 'job.vhdx'; install_iso_path = $null; seed_iso_path = $null
}
Save-Manifest $manifest $folder
Check ((Read-ManagedInstance $id).instance_id -ceq $id.ToString('D')) 'matching instance identity accepted'
Reject { Get-InstanceFolder ([guid]::Empty) } 'InstanceId is required' 'empty instance ID rejected'
foreach ($field in @('schema', 'instance_id', 'owner', 'host_name', 'host_sid', 'vm_name', 'folder')) {
    $before = $manifest.$field
    $manifest.$field = 'wrong-identity'
    Save-Manifest $manifest $folder
    Reject { Read-ManagedInstance $id } 'identity mismatch' ('instance mismatch rejected: ' + $field)
    $manifest.$field = $before
}
$script:vmName = $manifest.vm_name; $script:vmNote = $manifest.owner_note
function Get-VM { param($Id, $ErrorAction) [pscustomobject]@{ Name = $script:vmName; Notes = $script:vmNote } }
Check ((Get-ManagedVm $manifest).Name -ceq $manifest.vm_name) 'exact VM name and owner note accepted'
$script:vmNote = 'foreign-note'
Reject { Get-ManagedVm $manifest } 'identity or owner note' 'foreign VM note rejected'
$script:vmNote = $manifest.owner_note
$script:vmName = 'foreign-vm'
Reject { Get-ManagedVm $manifest } 'identity or owner note' 'foreign VM name rejected'
$script:vmName = $manifest.vm_name
[IO.File]::WriteAllText($manifest.disk_path, 'disk-fixture')
$script:diskPath = $manifest.disk_path; $script:switchName = $profile.switch_name
function Get-VMHardDiskDrive { param($VM) [pscustomobject]@{ Path = $script:diskPath } }
function Get-VMDvdDrive { param($VM) }
function Get-VMNetworkAdapter { param($VM) [pscustomobject]@{ SwitchName = $script:switchName } }
function Get-VMFibreChannelHba { param($VM) }
function Get-VMAssignableDevice { param($VM) }
Check (Assert-NoUnexpectedDevices $manifest ([pscustomobject]@{})) 'owned disk and reviewed network accepted'
$script:switchName = 'unreviewed-switch'
Reject { Assert-NoUnexpectedDevices $manifest ([pscustomobject]@{}) } 'network device differs' 'unreviewed network rejected'
$script:switchName = $profile.switch_name
$script:diskPath = Join-Path $folder 'foreign.vhdx'
[IO.File]::WriteAllText($script:diskPath, 'foreign')
Reject { Assert-NoUnexpectedDevices $manifest ([pscustomobject]@{}) } 'unowned disk' 'unowned attached disk rejected'
function Get-VMAssignableDevice { param($VM) [pscustomobject]@{ InstanceID = 'fixture-passthrough' } }
$script:diskPath = $manifest.disk_path
Reject { Assert-NoUnexpectedDevices $manifest ([pscustomobject]@{}) } 'Passthrough devices' 'passthrough device rejected'
$artifactFolder = Join-Path $rootPath 'artifacts'
New-Item -ItemType Directory -Path $artifactFolder | Out-Null
$artifact = Join-Path $artifactFolder 'base.iso'
[IO.File]::WriteAllText($artifact, 'pinned-artifact')
$digest = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
Check ((Get-Artifact $artifact $digest '.iso') -ceq $artifact) 'matching pinned artifact accepted'
Reject { Get-Artifact $artifact ('a' * 64) '.iso' } 'SHA-256 mismatch' 'changed artifact hash rejected'
Reject { Get-Artifact $artifact $digest '.vhdx' } 'Only a pinned artifact' 'wrong artifact extension rejected'
Reject { Get-Artifact $manifest.disk_path (Get-FileHash -LiteralPath $manifest.disk_path -Algorithm SHA256).Hash '.vhdx' } 'Only a pinned artifact' 'artifact outside artifact directory rejected'
`);
  assert.equal(report.checks.length, 20);
});

test('Windows production and retirement guards reject before any Hyper-V or delete effects', { skip: !windows }, () => {
  const report = runWindowsCase(String.raw`
$script:effects = New-Object 'Collections.Generic.List[string]'
function Assert-PrivateAcl { param($Path) throw 'acl_guard_failure_sentinel' }
function Get-VMSwitch { $script:effects.Add('get-switch'); throw 'unexpected_hyperv_effect' }
Reject { New-ManagedVm 'build' 'qualification' } 'acl_guard_failure_sentinel' 'private root ACL guard failure refused'
Check ($script:effects.Count -eq 0) 'root guard failure makes zero Hyper-V calls'
function Assert-Root { $script:effects.Add('assert-root') }
function New-ManagedVm { $script:effects.Add('new-vm'); throw 'unexpected_vm_effect' }
function Remove-ManagedVmProvider { $script:effects.Add('destroy-provider'); throw 'unexpected_provider_effect' }
function Remove-Item { $script:effects.Add('remove-item'); throw 'unexpected_delete_effect' }
$Action = 'NewJob'; $Purpose = 'production'; $BaseId = [guid]::NewGuid()
$productionAction = Load-Action 'NewJob'
Reject { Invoke-Expression $productionAction } 'qualification is not implemented' 'production job refused'
Check ($script:effects.Count -eq 0) 'production refusal has zero root, Hyper-V, or deletion effects'
$folder = Join-Path $rootPath 'retire-guard'
New-Item -ItemType Directory -Path $folder | Out-Null
$disk = Join-Path $folder 'wrong.vhdx'
[IO.File]::WriteAllText($disk, 'keep')
$m = [pscustomobject]@{ kind = 'job'; disk_path = $disk; folder = $folder }
$Action = 'RetireJob'
$retireAction = Load-Action 'RetireJob'
Reject { Invoke-Expression $retireAction } 'Unexpected disposable disk path' 'unexpected disk basename refused'
Check ($script:effects.Count -eq 0 -and (Test-Path -LiteralPath $disk)) 'retirement path refusal has zero provider or deletion effects'
$m.kind = 'build'
Reject { Invoke-Expression $retireAction } 'restricted to disposable job' 'build instance retirement refused'
Check ($script:effects.Count -eq 0 -and (Test-Path -LiteralPath $disk)) 'build retirement refusal has zero destructive effects'
`);
  assert.equal(report.checks.length, 8);
});

test('Windows VM absence suppresses only the exact Hyper-V not-found result', { skip: !windows }, () => {
  const report = runWindowsCase(String.raw`
$script:lookupId = [guid]::NewGuid()
$script:lookupErrorId = 'ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM'
$script:lookupCategory = [Management.Automation.ErrorCategory]::ObjectNotFound
function Get-VM {
    param($Id, $ErrorAction)
    $record = New-Object Management.Automation.ErrorRecord(
        (New-Object InvalidOperationException('lookup_failure_sentinel')), $script:lookupErrorId, $script:lookupCategory, $Id)
    throw $record
}
Check (Test-ExactVmAbsent $script:lookupId) 'exact Hyper-V not-found category accepted as absence'
$script:lookupErrorId = 'AccessDenied'
$script:lookupCategory = [Management.Automation.ErrorCategory]::PermissionDenied
Reject { Test-ExactVmAbsent $script:lookupId } 'lookup_failure_sentinel' 'permission failure is not reported as absence'
$script:lookupErrorId = 'ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM'
$script:lookupCategory = [Management.Automation.ErrorCategory]::InvalidOperation
Reject { Test-ExactVmAbsent $script:lookupId } 'lookup_failure_sentinel' 'matching error ID with wrong category is not absence'
function Get-VM { param($Id, $ErrorAction) return }
Check (Test-ExactVmAbsent $script:lookupId) 'successful empty exact-ID query accepted as absence'
function Get-VM { param($Id, $ErrorAction) [pscustomobject]@{ Id = $Id } }
Check (-not (Test-ExactVmAbsent $script:lookupId)) 'remaining exact-ID VM is not absence'
`);
  assert.equal(report.checks.length, 5);
});

const providerFixture = String.raw`
$id = [guid]::NewGuid(); $vmId = [guid]::NewGuid()
$folder = Get-InstanceFolder $id
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$vmName = $profile.vm_name_prefix + $id.ToString('N')
$config = Join-Path $folder $vmName
New-Item -ItemType Directory -Path $config | Out-Null
$manifest = [pscustomobject]@{ instance_id = $id.ToString('D'); vm_id = $vmId.ToString('D'); vm_name = $vmName; folder = $folder; owner_note = 'owned-note' }
$script:destroyCalls = 0; $script:jobReads = 0; $script:vmAbsent = $true; $script:cimAbsent = $true
$script:returnCode = 0; $script:includeJob = $true; $script:jobState = 7; $script:jobError = 0
$script:identityMatches = $true; $script:vmState = 'Off'; $script:providerCalls = 0
$script:destroyHook = $null
$script:jobRef = New-Object Microsoft.Management.Infrastructure.CimInstance('Msvm_ConcreteJob', 'root/virtualization/v2')
function Get-VM {
    param($Id, $ErrorAction)
    if ($script:destroyCalls -gt 0 -and $script:vmAbsent) { return }
    [pscustomobject]@{ Name = $manifest.vm_name; Notes = $manifest.owner_note; State = $script:vmState; ConfigurationLocation = $config }
}
function Assert-NoUnexpectedDevices { param($Manifest, $Vm) return $true }
function Get-CimInstance {
    param($Namespace, $ClassName, $Filter, $InputObject, $OperationTimeoutSec, $ErrorAction)
    $script:providerCalls += 1
    if ($null -ne $InputObject) {
        $script:jobReads += 1
        return [pscustomobject]@{ InstanceID = 'fixture-job'; JobState = $script:jobState; PercentComplete = 100; ErrorCode = $script:jobError }
    }
    if ($ClassName -ceq 'Msvm_VirtualSystemManagementService') {
        return [pscustomobject]@{ Name = 'vmms'; SystemName = $profile.host_name; Started = $true; EnabledState = 2 }
    }
    if ($script:destroyCalls -gt 0 -and $script:cimAbsent) { return }
    $name = $manifest.vm_name
    if (-not $script:identityMatches) { $name = 'foreign-vm' }
    return [pscustomobject]@{ Name = $manifest.vm_id; ElementName = $name; EnabledState = 3 }
}
function Invoke-CimMethod {
    param($InputObject, $MethodName, $Arguments, $ErrorAction)
    if ($MethodName -cne 'DestroySystem' -or $Arguments.AffectedSystem.Name -cne $manifest.vm_id) { throw 'Wrong destruction target.' }
    if ($null -ne $script:destroyHook) { & $script:destroyHook }
    $script:destroyCalls += 1
    if ($script:includeJob) { return [pscustomobject]@{ ReturnValue = $script:returnCode; Job = $script:jobRef } }
    return [pscustomobject]@{ ReturnValue = $script:returnCode }
}
`;

test('Windows CIM retirement accepts synchronous zero and typed async completion only after both absence checks', { skip: !windows }, () => {
  const report = runWindowsCase(providerFixture + String.raw`
$result = Remove-ManagedVmProvider $manifest
Check ($result.result -ceq 'VERIFIED_REMOVED' -and $result.return_value -eq 0) 'synchronous provider success accepted'
Check ($result.cim_absent -and $result.vm_absent -and $script:destroyCalls -eq 1) 'synchronous success independently checks CIM and VM absence'
Check (Test-Path -LiteralPath $result.evidence_path) 'synchronous success persists bounded evidence'
$script:destroyCalls = 0; $script:returnCode = 4096; $script:jobReads = 0
$result = Remove-ManagedVmProvider $manifest
Check ($result.result -ceq 'VERIFIED_REMOVED' -and $result.return_value -eq 4096) 'typed async completed job accepted'
Check ($script:jobReads -eq 1 -and $result.job_observations.Count -eq 1 -and $result.job_instance_id -ceq 'fixture-job') 'async evidence binds the observed job identity'
Check ($result.cim_absent -and $result.vm_absent) 'async success independently checks both absence boundaries'
Check (Test-Path -LiteralPath $result.evidence_path) 'async success persists evidence'
`);
  assert.equal(report.checks.length, 7);
});

test('Windows CIM retirement refuses missing jobs, provider failures, incomplete completion, timeout, and residual VM identity', { skip: !windows }, () => {
  const report = runWindowsCase(providerFixture + String.raw`
$script:identityMatches = $false
Reject { Remove-ManagedVmProvider $manifest } 'CIM target or local management service' 'foreign CIM identity refused'
Check ($script:destroyCalls -eq 0) 'identity mismatch makes zero destroy calls'
$script:identityMatches = $true; $script:vmState = 'Running'
$providerBefore = $script:providerCalls
Reject { Remove-ManagedVmProvider $manifest } 'must be fully Off' 'running VM refused'
Check ($script:destroyCalls -eq 0 -and $script:providerCalls -eq $providerBefore) 'running VM refusal makes zero provider calls'
$script:vmState = 'Off'; $script:returnCode = 4096; $script:includeJob = $false
Reject { Remove-ManagedVmProvider $manifest } 'no typed Job reference' 'async result without typed job refused'
$script:destroyCalls = 0; $script:includeJob = $true; $script:returnCode = 5
Reject { Remove-ManagedVmProvider $manifest } 'refused or failed' 'provider failure code refused'
$script:destroyCalls = 0; $script:returnCode = 4096; $script:jobState = 8
Reject { Remove-ManagedVmProvider $manifest } 'failed or entered an unknown' 'failed async job refused'
$script:destroyCalls = 0; $script:jobState = 7; $script:jobError = 4
Reject { Remove-ManagedVmProvider $manifest } 'has an error or missing error' 'completed job with error refused'
$script:destroyCalls = 0; $script:jobError = $null
Reject { Remove-ManagedVmProvider $manifest } 'has an error or missing error' 'completed job without explicit zero error refused'
$script:destroyCalls = 0; $script:jobState = 4; $script:jobError = 0; $script:jobReads = 0
Reject { Remove-ManagedVmProvider $manifest -ObservationTimeoutSeconds 2 } 'timed out' 'incomplete async job times out within a bounded observation'
Check ($script:jobReads -gt 0) 'timeout follows actual running-job observations'
$script:destroyCalls = 0; $script:returnCode = 0; $script:vmAbsent = $false
Reject { Remove-ManagedVmProvider $manifest } 'not independently verified' 'residual Get-VM identity refused'
$script:destroyCalls = 0; $script:vmAbsent = $true; $script:cimAbsent = $false
Reject { Remove-ManagedVmProvider $manifest } 'not independently verified' 'residual CIM identity refused'
$evidence = @(Get-ChildItem -LiteralPath $folder -Filter 'provider-retirement-*.json')
Check ($evidence.Count -eq 10) 'all rejected provider operations retain separate failure evidence'
foreach ($file in $evidence) {
    $failure = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    Check ($failure.result -ceq 'FAILED_OR_UNKNOWN' -and -not [string]::IsNullOrWhiteSpace($failure.failure_stage)) ('failure evidence remains non-success: ' + $file.Name)
}
`);
  assert.equal(report.checks.length, 24);
});

const buildRetirementFixture = providerFixture + String.raw`
$Action = 'RetireBuild'
$retireBuild = Load-Action 'RetireBuild'
$diskPath = Join-Path $folder 'build.vhdx'
[IO.File]::WriteAllText($diskPath, 'retained-build-content')
$artifactFolder = Join-Path $rootPath 'artifacts'
New-Item -ItemType Directory -Path $artifactFolder | Out-Null
$installIso = Join-Path $artifactFolder 'install.iso'; $seedIso = Join-Path $artifactFolder 'seed.iso'
[IO.File]::WriteAllText($installIso, 'shared-install'); [IO.File]::WriteAllText($seedIso, 'shared-seed')
(Get-Item -LiteralPath $seedIso).IsReadOnly = $true
$manifest | Add-Member -NotePropertyName kind -NotePropertyValue 'build'
$manifest | Add-Member -NotePropertyName disk_path -NotePropertyValue $diskPath
$manifest | Add-Member -NotePropertyName install_iso_path -NotePropertyValue $installIso
$manifest | Add-Member -NotePropertyName seed_iso_path -NotePropertyValue $seedIso
$manifest | Add-Member -NotePropertyName status -NotePropertyValue 'quarantined'
$manifest | Add-Member -NotePropertyName quarantine_reason -NotePropertyValue 'prior-build-failure'
$manifest | Add-Member -NotePropertyName updated_utc -NotePropertyValue $null
$m = $manifest
$vm = Get-ManagedVm $manifest
function Get-VMHardDiskDrive { param($VM) if ($manifest.disk_path) { [pscustomobject]@{ Path = $manifest.disk_path } } }
$script:deleteCalls = 0
function Remove-Item { $script:deleteCalls += 1; throw 'unexpected_delete_effect' }
`;

test('Windows build retirement preserves and verifies disk, shared ISO files, and pre-destruction evidence', { skip: !windows }, () => {
  const report = runWindowsCase(buildRetirementFixture + String.raw`
$before = @{}
foreach ($artifact in @($diskPath, $installIso, $seedIso)) { $before[$artifact] = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash }
$script:preDestroyEvidence = $false
$script:destroyHook = {
    $saved = Get-Content -LiteralPath (Join-Path $folder 'manifest.json') -Raw | ConvertFrom-Json
    $script:preDestroyEvidence = ($saved.status -cne 'retired' -and $saved.retained_build_artifacts.Count -eq 3 -and (Get-Item -LiteralPath $diskPath).IsReadOnly)
}
Invoke-Expression $retireBuild | Out-Null
Check $script:preDestroyEvidence 'retained artifact evidence and read-only build disk are persisted before destruction'
Check ($m.status -ceq 'retired' -and $m.provider_retirement.result -ceq 'VERIFIED_REMOVED') 'build is retired only after verified provider removal'
Check ($m.provider_retirement.cim_absent -and $m.provider_retirement.vm_absent) 'build retirement binds both independent absence observations'
foreach ($artifact in @($diskPath, $installIso, $seedIso)) {
    Check ((Test-Path -LiteralPath $artifact) -and (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash -ceq $before[$artifact]) ('retained bytes verified: ' + [IO.Path]::GetFileName($artifact))
}
Check ((Get-Item -LiteralPath $diskPath).IsReadOnly) 'retained build disk remains read-only'
Check (-not (Get-Item -LiteralPath $installIso).IsReadOnly -and (Get-Item -LiteralPath $seedIso).IsReadOnly) 'shared ISO read-only attributes remain unchanged'
$saved = Get-Content -LiteralPath (Join-Path $folder 'manifest.json') -Raw | ConvertFrom-Json
Check ($saved.status -ceq 'retired' -and $saved.retained_build_artifacts.Count -eq 3) 'final retained manifest is durable'
Check ($script:deleteCalls -eq 0 -and (Test-Path -LiteralPath $folder)) 'build retirement makes zero file or directory deletion calls'
`);
  assert.equal(report.checks.length, 10);
});

test('Windows build retirement refuses wrong kinds, provider failures, residual VM, and altered retained files', { skip: !windows }, () => {
  const report = runWindowsCase(buildRetirementFixture + String.raw`
$m.kind = 'job'
Reject { Invoke-Expression $retireBuild } 'restricted to owned build' 'job kind cannot enter build retirement'
Check ($script:destroyCalls -eq 0 -and $script:deleteCalls -eq 0) 'wrong-kind retirement has zero destructive calls'
$m.kind = 'build'
foreach ($mode in @('provider-error', 'residual-vm', 'changed-artifact')) {
    $script:destroyCalls = 0; $script:vmAbsent = $true; $script:returnCode = 0; $script:destroyHook = $null
    $m.status = 'quarantined'; $m.quarantine_reason = 'prior-build-failure'
    (Get-Item -LiteralPath $diskPath).IsReadOnly = $false
    [IO.File]::WriteAllText($diskPath, 'retained-build-content')
    $expected = 'refused or failed'
    if ($mode -ceq 'provider-error') { $script:returnCode = 5 }
    if ($mode -ceq 'residual-vm') { $script:vmAbsent = $false; $expected = 'not independently verified' }
    if ($mode -ceq 'changed-artifact') {
        $expected = 'did not verify preservation'
        $script:destroyHook = { (Get-Item -LiteralPath $diskPath).IsReadOnly = $false; [IO.File]::WriteAllText($diskPath, 'unexpected-disk-change') }
    }
    Reject { Invoke-Expression $retireBuild } $expected ('build retirement refuses ' + $mode)
    Check ($m.status -ceq 'quarantined' -and $m.quarantine_reason -ceq 'build_retirement_not_verified') ('failure stays quarantined: ' + $mode)
    $saved = Get-Content -LiteralPath (Join-Path $folder 'manifest.json') -Raw | ConvertFrom-Json
    Check ($saved.status -ceq 'quarantined' -and $saved.status -cne 'retired') ('failure never persists a retired result: ' + $mode)
    Check ((Test-Path -LiteralPath $diskPath) -and (Test-Path -LiteralPath $seedIso) -and $script:deleteCalls -eq 0) ('failure keeps all local artifacts: ' + $mode)
}
`);
  assert.equal(report.checks.length, 14);
});

test('guest sudo predicate accepts only a complete target-user denial, including the observed exit-zero form', () => {
  const python = process.platform === 'win32' ? 'python.exe' : 'python3';
  const code = String.raw`
import ast, hashlib, json, pathlib, re, sys
source = pathlib.Path(sys.argv[1]).read_bytes()
blocks = re.findall(r"<<'PY'\r?\n(.*?)\r?\nPY", source.decode('utf-8'), re.S)
assert len(blocks) == 2, 'Unexpected embedded Python layout'
for index, block in enumerate(blocks):
    compile(block, '<guest-embedded-' + str(index) + '>', 'exec')
nodes = [node for node in ast.parse(blocks[1]).body if isinstance(node, ast.FunctionDef) and node.name == 'check_sudo_denial']
assert len(nodes) == 1, 'Expected exactly one actual pure denial predicate'
namespace = {'re': re}
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<actual-sudo-predicate>', 'exec'), namespace)
predicate = namespace['check_sudo_denial']
user = 'clued-release-runner'
denial = 'User clued-release-runner is not allowed to run sudo on clued-base-qualification.\n'
cases = [
    ('observed-exit-zero-denial', 0, denial, '', True),
    ('exit-one-exact-denial', 1, denial, '', True),
    ('denial-without-final-newline', 0, denial.rstrip('\n'), '', True),
    ('exit-zero-alone', 0, '', '', False),
    ('exit-one-alone', 1, '', '', False),
    ('allowed-commands', 0, 'User clued-release-runner may run the following commands on clued-base-qualification:\n    (ALL : ALL) ALL\n', '', False),
    ('denial-plus-allowed-command', 0, denial + '    (ALL : ALL) ALL\n', '', False),
    ('denial-plus-warning', 0, denial, 'sudo: unexpected policy error\n', False),
    ('whitespace-stderr', 0, denial, '\n', False),
    ('other-user-denial', 0, denial.replace(user, 'somebody-else'), '', False),
    ('missing-final-period', 0, denial.replace('.\n', '\n'), '', False),
    ('extra-stdout-line', 0, denial + '\n', '', False),
    ('invalid-exit-code', 2, denial, '', False),
    ('signal-return', -15, denial, '', False),
    ('missing-return-code', None, denial, '', False),
    ('boolean-is-not-return-code', False, denial, '', False),
    ('non-text-stdout', 0, None, '', False),
    ('unexpected-crlf', 0, denial.replace('\n', '\r\n'), '', False),
    ('leading-whitespace', 0, ' ' + denial, '', False),
]
for name, status, stdout, stderr, expected in cases:
    assert predicate(status, stdout, stderr, user) is expected, name
print(json.dumps({'cases': len(cases), 'passed': len(cases), 'guest_source_sha256': hashlib.sha256(source).hexdigest()}))
`;
  const result = spawnSync(python, ['-I', '-c', code, guestPath], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.cases, 19);
  assert.equal(report.passed, 19);
  assert.equal(report.guest_source_sha256, createHash('sha256').update(fs.readFileSync(guestPath)).digest('hex'));
});
