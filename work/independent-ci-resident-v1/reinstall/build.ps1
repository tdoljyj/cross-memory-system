# Build one reinstall package for one node and commit, and generate its launcher (README.md section 3). NON-elevated, read-only on the
# repository and the host; writes only new files under the configuration's workDir. Run from PowerShell, never from Git Bash.
#   powershell -NoProfile -File build.ps1 -Config <reinstall-config.json> -Commit <40hex> [-Tag t] [-PackageOnly] [-CiPrincipalQualificationRef <uuid>] [-HostQualificationRef <uuid>]
#        [-Final -DecisionRef <uuid> -ReceiptRef <uuid> -AcceptedAt <ISO Z> -Rehearsal <rehearsal report> [-LinuxEvidence <file> -LinuxVersionFacts <file> [-LinuxAdoptedPackage <dir>]]]
# Owner acceptance: ONE decision names every acceptance reference (sourceAcceptanceRef, hostQualificationRef, ownerAuthorizationRef,
# ownerPackageAcceptanceRef, publisherQualificationRef, ownerDecisionRef) and its KooYomi receipt names installationReceiptRef and
# ownerReceiptRef; ciPrincipalQualificationRef is -CiPrincipalQualificationRef, else the base record's (the same connection only);
# hostQualificationRef is -HostQualificationRef when the Owner decided the node's Linux host qualification separately (a first install,
# README section 8c), else the decision. Without
# -Final the references are obvious PLACEHOLDERS (DRAFT); -Final refuses them, and the launcher generator refuses a final without a PASS
# rehearsal of exactly this package (rehearse.py). -PackageOnly builds the package only (another node, e.g. a first install, README
# section 8); with -Final it carries the real references.
param([Parameter(Mandatory)][string]$Config,
      [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Commit, [switch]$Final, [ValidatePattern('^[a-z0-9]{0,12}$')][string]$Tag = '',
      [ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$DecisionRef = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      [ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$ReceiptRef = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      [ValidatePattern('^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$')][string]$AcceptedAt = '2026-10-28T00:00:00Z',
      [ValidatePattern('^([0-9a-f]{64})?$')][string]$AcceptHaltSha256 = '',
      [string]$Rehearsal = '', [string]$LinuxEvidence = '', [string]$LinuxVersionFacts = '', [string]$LinuxAdoptedPackage = '',
      [ValidatePattern('^([a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12})?$')][string]$CiPrincipalQualificationRef = '',
      [ValidatePattern('^([a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12})?$')][string]$HostQualificationRef = '',
      [switch]$PackageOnly)   # a package for another node (e.g. a first install): no launcher, which reads THIS host's installed resident
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $PSCommandPath
$Placeholders = @('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
if ($Final -and ($Placeholders -contains $DecisionRef -or $Placeholders -contains $ReceiptRef -or $AcceptedAt -ceq '2026-10-28T00:00:00Z')) { throw 'FINAL_NEEDS_THE_REAL_OWNER_DECISION_AND_RECEIPT' }
$RefArgs = @()
foreach ($k in @('sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'ownerPackageAcceptanceRef', 'publisherQualificationRef')) {
  $v = $(if ($k -eq 'hostQualificationRef' -and $HostQualificationRef) { $HostQualificationRef } else { $DecisionRef })
  $RefArgs += @('--ref', ($k + '=' + $v))
}
$RefArgs += @('--ref', ('installationReceiptRef=' + $ReceiptRef), '--owner-decision-ref', $DecisionRef, '--owner-receipt-ref', $ReceiptRef, '--accepted-at', $AcceptedAt)
if ($CiPrincipalQualificationRef) { $RefArgs += @('--ref', ('ciPrincipalQualificationRef=' + $CiPrincipalQualificationRef)) }   # another node's connection
# The configuration, validated by the same loader the Python tools use (no secret-shaped key or value).
$cfgJson = & python -I -c "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('c',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); c=m.load(sys.argv[2]); print(json.dumps(c))" (Join-Path $Here 'tools\rconfig.py') $Config
if ($LASTEXITCODE) { throw 'CONFIG_REFUSED' }
$cfg = $cfgJson | ConvertFrom-Json
$R = $cfg.workDir; $Repo = $cfg.repo
if (-not (Test-Path -LiteralPath $R -PathType Container)) { throw 'WORK_DIR_MISSING' }
foreach ($d in @('record', 'build-inputs')) { if (-not (Test-Path -LiteralPath (Join-Path $R $d))) { New-Item -ItemType Directory (Join-Path $R $d) | Out-Null } }
$c8 = $Commit.Substring(0, 8); $kind = $(if ($Final) { 'final' } else { 'DRAFT' }) + $Tag   # -Tag only distinguishes repeat runs
$tree = Join-Path $R ('tree-' + $c8)
$env:GIT_NO_REPLACE_OBJECTS = '1'   # the commit's own objects, as root's src.git sees them (review 2)
if (-not (Test-Path -LiteralPath $tree)) {
  New-Item -ItemType Directory $tree | Out-Null
  $tar = Join-Path $R ('t-' + $c8 + '.tar')
  & git -C $Repo archive --format=tar -o $tar $Commit; if ($LASTEXITCODE) { throw 'GIT_ARCHIVE_FAILED' }
  & "$env:SystemRoot\System32\tar.exe" -xf $tar -C $tree; if ($LASTEXITCODE) { throw 'TAR_FAILED' }   # Windows tar: Git's tar cannot take a C:\ path
  Remove-Item -LiteralPath $tar
}
# review 1-4: root runs files from this tree; an existing tree-<c8> is reused only when it is exactly the commit (Git blob ids, no extra file)
& python -I (Join-Path $Here 'tools\tree.py') $Repo $Commit $tree; if ($LASTEXITCODE) { throw 'TREE_NOT_THE_COMMIT' }
$closure = Join-Path $tree 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\source-closure.json'
$inputs = Join-Path $R ('record\inputs.' + $cfg.node + '.' + $kind + '.' + $c8 + '.json')
& python -I (Join-Path $Here 'tools\record-inputs.py') $Config $tree $Commit $inputs @RefArgs; if ($LASTEXITCODE) { throw 'RECORD_INPUTS_FAILED' }
$record = Join-Path $R ('record\record.' + $cfg.node + '.' + $kind + '.' + $c8)
& node (Join-Path $tree 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\prepare-record.mjs') --inputs $inputs --source-root $tree --closure $closure --out $record; if ($LASTEXITCODE) { throw 'PREPARE_RECORD_FAILED' }
# the commit's own runtime validator (record.mjs validateRecordV2: signer refs, controllerRelay refs, bindings) must accept the record
& node (Join-Path $Here 'tools\check-record.mjs') $tree $record; if ($LASTEXITCODE) { throw 'RECORD_V2_REFUSED_BY_RUNTIME_VALIDATOR' }
$files = Join-Path $R ('record\source-files.' + $cfg.node + '.' + $kind + '.' + $c8 + '.txt')
& python -I -c "import json,sys; p=json.load(open(sys.argv[1],encoding='utf-8-sig'))['paths']; open(sys.argv[2],'x',newline='\n').write('\n'.join(p)+'\n')" $closure $files; if ($LASTEXITCODE) { throw 'SOURCE_FILES_FAILED' }
$pkg = Join-Path $R ('package-' + $cfg.node + '-' + $kind + '-' + $c8)
# the policy and companion inputs for the configured node (its profile, owner SID, WSL distribution), and the policy's ownerAcceptance:
# this install's Owner decision and its receipt (build-package keeps the input's)
$pol = Join-Path $R ('build-inputs\policy.' + $cfg.node + '.' + $kind + '.' + $c8 + '.input.json')
$comp = Join-Path $R ('build-inputs\companion.' + $cfg.node + '.' + $kind + '.' + $c8 + '.input.json')
& python -I (Join-Path $Here 'tools\node-inputs.py') $Config $tree $DecisionRef $ReceiptRef $pol $comp; if ($LASTEXITCODE) { throw 'NODE_INPUTS_FAILED' }
# the upgrader configuration of this fresh install, from the record, validated by the tree's own validateUpgraderConfig
$upg = Join-Path $R ('build-inputs\upgrader.' + $cfg.node + '.' + $kind + '.' + $c8 + '.input.json')
& python -I (Join-Path $Here 'tools\upgrader-config.py') $record $upg $tree; if ($LASTEXITCODE) { throw 'UPGRADER_CONFIG_INPUT_FAILED' }
# the Linux resident manifest's external pins: the installed manifest's paths and order, source-v2 entries from THIS commit
$pins = Join-Path $R ('build-inputs\linux-external-pins.' + $cfg.node + '.' + $kind + '.' + $c8 + '.json')
# another node's own toolchain node (configuration linux.host.toolchainNodeSha256), when known, replaces the copy's value
$NodePin = @(); if ($cfg.linux.host.toolchainNodeSha256) { $NodePin = @('--toolchain-node', $cfg.linux.host.toolchainNodeSha256) }
& python -I (Join-Path $Here 'tools\linux-pins.py') pins $cfg.linux.installedManifest $pins $tree @NodePin; if ($LASTEXITCODE) { throw 'LINUX_PINS_INPUT_FAILED' }
Push-Location (Join-Path $tree 'work\independent-ci-resident-v1')
try { $b = & node tools/build-package.mjs --out $pkg --policy $pol --companion $comp --node $cfg.nodeExe --record $record --source-root $tree --source-files $files --fresh-install --upgrader-config $upg --linux-external-pins $pins; if ($LASTEXITCODE) { throw 'BUILD_PACKAGE_FAILED' } } finally { Pop-Location }
$shape = & python -I (Join-Path $Here 'tools\linux-pins.py') check (Join-Path $pkg 'linux\manifest.json') $cfg.linux.installedManifest $tree @NodePin
if ($LASTEXITCODE) { throw 'LINUX_MANIFEST_NOT_THE_INSTALLED_SHAPE' }
function Write-New([string]$Path, [string]$Text) {   # create-only, like every other output of the toolchain
  $f = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text); $f.Write($bytes, 0, $bytes.Length) } finally { $f.Dispose() }
}
Write-New (Join-Path $R ('linux-shape.' + $cfg.node + '.' + $kind + '.' + $c8 + '.json')) ($shape | Out-String)
Write-New (Join-Path $R ('build-package.' + $cfg.node + '.' + $kind + '.' + $c8 + '.stdout.json')) ($b | Out-String)
$pkgSha = ($b | ConvertFrom-Json).packageManifestSha256
if ($PackageOnly) { ([ordered]@{ status = 'PACKAGE_BUILT_NO_LAUNCHER'; node = $cfg.node; final = [bool]$Final; linuxToolchainNodePin = $(if ($NodePin.Count) { 'configured' } else { 'installed-manifest-copy' }); package = $pkg; packageManifestSha256 = $pkgSha } | ConvertTo-Json); return }
# The generator rebuilds the package from these inputs into a new directory and requires the same manifest sha.
$gen = @((Join-Path $Here 'launcher\generate.py'), $Config, '--commit', $Commit, '--package', $pkg, '--package-sha', $pkgSha, '--rebuild-record', $record, '--rebuild-policy', $pol, '--rebuild-companion', $comp, '--rebuild-source-files', $files, '--rebuild-upgrader-config', $upg, '--rebuild-linux-external-pins', $pins)
if ($AcceptHaltSha256) { $gen += @('--accept-halt-sha256', $AcceptHaltSha256) }
if ($LinuxVersionFacts) { $gen += @('--linux-version-facts', $LinuxVersionFacts) }
if ($LinuxAdoptedPackage) { $gen += @('--linux-adopted-package', $LinuxAdoptedPackage) }   # record-only reinstall (README section 8b)
if ($Final) { $gen += @('--final'); if ($LinuxEvidence) { $gen += @('--linux-evidence', $LinuxEvidence) }; if ($Rehearsal) { $gen += @('--rehearsal', $Rehearsal) } }
& python -I @gen; if ($LASTEXITCODE) { exit $LASTEXITCODE }   # a refused final is a failed build
