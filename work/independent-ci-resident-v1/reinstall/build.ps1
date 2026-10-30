# Build one reinstall package for one node and commit, and generate its launcher (README.md section 3). NON-elevated, read-only on the
# repository and the host; writes only new files under the configuration's workDir. Run from PowerShell, never from Git Bash.
#   powershell -NoProfile -File build.ps1 -Config <reinstall-config.json> -Commit <40hex> [-Tag t]
#        [-Final -DecisionRef <uuid> -ReceiptRef <uuid> -AcceptedAt <ISO Z> -Rehearsal <rehearsal report> [-LinuxEvidence <file> -LinuxVersionFacts <file>]]
# Owner acceptance: ONE decision names every acceptance reference (sourceAcceptanceRef, hostQualificationRef, ownerAuthorizationRef,
# ownerPackageAcceptanceRef, publisherQualificationRef, ownerDecisionRef) and its KooYomi receipt names installationReceiptRef and
# ownerReceiptRef; ciPrincipalQualificationRef stays the base record's. Without -Final the references are obvious PLACEHOLDERS (DRAFT);
# -Final refuses them, and the launcher generator refuses a final without a PASS rehearsal of exactly this package (rehearse.py).
param([Parameter(Mandatory)][string]$Config,
      [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Commit, [switch]$Final, [ValidatePattern('^[a-z0-9]{0,12}$')][string]$Tag = '',
      [ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$DecisionRef = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      [ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$ReceiptRef = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      [ValidatePattern('^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$')][string]$AcceptedAt = '2026-10-28T00:00:00Z',
      [ValidatePattern('^([0-9a-f]{64})?$')][string]$AcceptHaltSha256 = '',
      [string]$Rehearsal = '', [string]$LinuxEvidence = '', [string]$LinuxVersionFacts = '',
      [switch]$PackageOnly)   # a package for another node (e.g. a first install): no launcher, which reads THIS host's installed resident
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $PSCommandPath
$Placeholders = @('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
if ($Final -and ($Placeholders -contains $DecisionRef -or $Placeholders -contains $ReceiptRef -or $AcceptedAt -ceq '2026-10-28T00:00:00Z')) { throw 'FINAL_NEEDS_THE_REAL_OWNER_DECISION_AND_RECEIPT' }
$RefArgs = @()
foreach ($k in @('sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'ownerPackageAcceptanceRef', 'publisherQualificationRef')) { $RefArgs += @('--ref', ($k + '=' + $DecisionRef)) }
$RefArgs += @('--ref', ('installationReceiptRef=' + $ReceiptRef), '--owner-decision-ref', $DecisionRef, '--owner-receipt-ref', $ReceiptRef, '--accepted-at', $AcceptedAt)
# The configuration, validated by the same loader the Python tools use (no secret-shaped key or value).
$cfgJson = & python -I -c "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('c',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); c=m.load(sys.argv[2]); print(json.dumps(c))" (Join-Path $Here 'tools\rconfig.py') $Config
if ($LASTEXITCODE) { throw 'CONFIG_REFUSED' }
$cfg = $cfgJson | ConvertFrom-Json
$R = $cfg.workDir; $Repo = $cfg.repo
if (-not (Test-Path -LiteralPath $R -PathType Container)) { throw 'WORK_DIR_MISSING' }
foreach ($d in @('record', 'build-inputs')) { if (-not (Test-Path -LiteralPath (Join-Path $R $d))) { New-Item -ItemType Directory (Join-Path $R $d) | Out-Null } }
$c8 = $Commit.Substring(0, 8); $kind = $(if ($Final) { 'final' } else { 'DRAFT' }) + $Tag   # -Tag only distinguishes repeat runs
$tree = Join-Path $R ('tree-' + $c8)
if (-not (Test-Path -LiteralPath $tree)) {
  New-Item -ItemType Directory $tree | Out-Null
  $tar = Join-Path $R ('t-' + $c8 + '.tar')
  & git -C $Repo archive --format=tar -o $tar $Commit; if ($LASTEXITCODE) { throw 'GIT_ARCHIVE_FAILED' }
  & "$env:SystemRoot\System32\tar.exe" -xf $tar -C $tree; if ($LASTEXITCODE) { throw 'TAR_FAILED' }   # Windows tar: Git's tar cannot take a C:\ path
  Remove-Item -LiteralPath $tar
}
# review 1-4: root runs files from this tree; an existing tree-<c8> is reused only when it is exactly the commit (Git blob ids, no extra file)
& python -I (Join-Path $Here 'tools	ree.py') $Repo $Commit $tree; if ($LASTEXITCODE) { throw 'TREE_NOT_THE_COMMIT' }
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
# policy ownerAcceptance names this install's Owner decision and its receipt (build-package keeps the input's)
$pol = Join-Path $R ('build-inputs\policy.' + $cfg.node + '.' + $kind + '.' + $c8 + '.input.json')
& python -I -c "import json,sys; p=json.load(open(sys.argv[1],encoding='utf-8')); p['ownerAcceptance']={'decisionRef':sys.argv[3],'installReceiptRef':sys.argv[4]}; open(sys.argv[2],'x',encoding='utf-8',newline='\n').write(json.dumps(p,sort_keys=True,separators=(',',':')))" $cfg.policyInput $pol $DecisionRef $ReceiptRef; if ($LASTEXITCODE) { throw 'POLICY_INPUT_FAILED' }
# the upgrader configuration of this fresh install, from the record, validated by the tree's own validateUpgraderConfig
$upg = Join-Path $R ('build-inputs\upgrader.' + $cfg.node + '.' + $kind + '.' + $c8 + '.input.json')
& python -I (Join-Path $Here 'tools\upgrader-config.py') $record $upg $tree; if ($LASTEXITCODE) { throw 'UPGRADER_CONFIG_INPUT_FAILED' }
# the Linux resident manifest's external pins: the installed manifest's paths and order, source-v2 entries from THIS commit
$pins = Join-Path $R ('build-inputs\linux-external-pins.' + $cfg.node + '.' + $kind + '.' + $c8 + '.json')
& python -I (Join-Path $Here 'tools\linux-pins.py') pins $cfg.linux.installedManifest $pins $tree; if ($LASTEXITCODE) { throw 'LINUX_PINS_INPUT_FAILED' }
Push-Location (Join-Path $tree 'work\independent-ci-resident-v1')
try { $b = & node tools/build-package.mjs --out $pkg --policy $pol --companion $cfg.companionInput --node $cfg.nodeExe --record $record --source-root $tree --source-files $files --fresh-install --upgrader-config $upg --linux-external-pins $pins; if ($LASTEXITCODE) { throw 'BUILD_PACKAGE_FAILED' } } finally { Pop-Location }
$shape = & python -I (Join-Path $Here 'tools\linux-pins.py') check (Join-Path $pkg 'linux\manifest.json') $cfg.linux.installedManifest $tree
if ($LASTEXITCODE) { throw 'LINUX_MANIFEST_NOT_THE_INSTALLED_SHAPE' }
function Write-New([string]$Path, [string]$Text) {   # create-only, like every other output of the toolchain
  $f = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text); $f.Write($bytes, 0, $bytes.Length) } finally { $f.Dispose() }
}
Write-New (Join-Path $R ('linux-shape.' + $cfg.node + '.' + $kind + '.' + $c8 + '.json')) ($shape | Out-String)
Write-New (Join-Path $R ('build-package.' + $cfg.node + '.' + $kind + '.' + $c8 + '.stdout.json')) ($b | Out-String)
$pkgSha = ($b | ConvertFrom-Json).packageManifestSha256
if ($PackageOnly) { if ($Final) { throw 'PACKAGE_ONLY_IS_NEVER_A_FINAL_LAUNCH' }; ([ordered]@{ status = 'PACKAGE_BUILT_NO_LAUNCHER'; node = $cfg.node; package = $pkg; packageManifestSha256 = $pkgSha } | ConvertTo-Json); return }
# The generator rebuilds the package from these inputs into a new directory and requires the same manifest sha.
$gen = @((Join-Path $Here 'launcher\generate.py'), $Config, '--commit', $Commit, '--package', $pkg, '--package-sha', $pkgSha, '--rebuild-record', $record, '--rebuild-policy', $pol, '--rebuild-source-files', $files, '--rebuild-upgrader-config', $upg, '--rebuild-linux-external-pins', $pins)
if ($AcceptHaltSha256) { $gen += @('--accept-halt-sha256', $AcceptHaltSha256) }
if ($LinuxVersionFacts) { $gen += @('--linux-version-facts', $LinuxVersionFacts) }
if ($Final) { $gen += @('--final'); if ($LinuxEvidence) { $gen += @('--linux-evidence', $LinuxEvidence) }; if ($Rehearsal) { $gen += @('--rehearsal', $Rehearsal) } }
& python -I @gen
