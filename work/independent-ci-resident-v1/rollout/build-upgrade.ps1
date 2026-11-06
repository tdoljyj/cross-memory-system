# Build one IN-PLACE upgrade package for one node and commit, then precheck it against the node (DESIGN §42.3.1, Task 018da927).
# NON-elevated, read-only on the repository and the host; writes only new files under the configuration's workDir. Run from
# PowerShell, never from Git Bash.
#   powershell -NoProfile -File build-upgrade.ps1 -Config <reinstall-config.json> -Commit <40hex> -InstalledPackage <dir> [-Tag t]
#        [-Final -DecisionRef <uuid> -ReceiptRef <uuid>] [-StateCompat <stateCompat.json>] [-Root <resident root>]
# Differences from reinstall\build.ps1 (same configuration, same tools):
#   - the record's acceptance references and acceptedAt are the INSTALLED package's (record-inputs.py with no --ref; Decision b1dd8a84):
#     the node identity pins them, and the upgrader refuses a package whose identity changed. The Owner's acceptance of THIS upgrade is
#     -DecisionRef / -ReceiptRef: it goes into the policy's ownerAcceptance, the package's acceptance.decisionRef, the request and the Grant;
#   - no --fresh-install: nothing under upgrader\, secrets\ or the layout; the upgrader copy must be the installed one (precheck);
#   - --source-v2: the accepted commit's bundle (refs/heads/accepted only) and the role hashes the Linux stage will derive, computed with
#     the frozen Linux tool's own derive_role (tools\roles-derived.py);
#   - stateCompat is the installed package's unless -StateCompat gives it (DESIGN §42.4.4: expand, then contract);
#   - the same inputs are built twice (same bundle file): the package sha must be the same;
#   - the precheck (precheck.mjs) runs the installed upgrader's ACCEPT on this node, read-only.
param([Parameter(Mandatory)][string]$Config,
      [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Commit,
      [Parameter(Mandatory)][string]$InstalledPackage,
      [switch]$Final, [ValidatePattern('^[a-z0-9]{0,12}$')][string]$Tag = '',
      [ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$DecisionRef = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      [ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$ReceiptRef = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      [string]$StateCompat = '',
      [string]$Root = 'C:\ProgramData\CluedIndependentCI\resident')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $PSCommandPath
$RI = Join-Path (Split-Path -Parent $Here) 'reinstall'
$Placeholders = @('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
if ($Final -and ($Placeholders -contains $DecisionRef -or $Placeholders -contains $ReceiptRef)) { throw 'FINAL_NEEDS_THE_REAL_OWNER_DECISION_AND_RECEIPT' }
# ValidatePattern ignores case: a commit in capitals would pass it and be refused later under another name (review round 1, NIT).
if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'COMMIT_MUST_BE_40_LOWERCASE_HEX' }
function Write-New([string]$Path, [string]$Text) {   # create-only, like every other output of the toolchain
  $f = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Text); $f.Write($bytes, 0, $bytes.Length) } finally { $f.Dispose() }
}
function Sha256File([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$cfgJson = & python -I -c "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('c',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); c=m.load(sys.argv[2]); print(json.dumps(c))" (Join-Path $RI 'tools\rconfig.py') $Config
if ($LASTEXITCODE) { throw 'CONFIG_REFUSED' }
$cfg = $cfgJson | ConvertFrom-Json
if ($null -eq $cfg.linux.installedRoles) { throw 'NODE_HAS_NO_INSTALLED_LINUX_CI' }   # a first install has nothing to upgrade
$R = $cfg.workDir; $Repo = $cfg.repo
if (-not (Test-Path -LiteralPath $R -PathType Container)) { throw 'WORK_DIR_MISSING' }
foreach ($d in @('record', 'build-inputs', 'upgrade')) { if (-not (Test-Path -LiteralPath (Join-Path $R $d))) { New-Item -ItemType Directory (Join-Path $R $d) | Out-Null } }
$c8 = $Commit.Substring(0, 8); $kind = 'upgrade-' + $(if ($Final) { 'final' } else { 'DRAFT' }) + $Tag
$stem = $cfg.node + '.' + $kind + '.' + $c8

# 0. what a FAILED earlier run of this same stem left behind (its create-only outputs would stop this run at the first CreateNew) is
#    renamed into <workDir>\failed-attempts\<UTC>\ (nothing is deleted); a COMPLETED run (its precheck file exists) is never touched:
#    use another -Tag for a new attempt. The shared tree, bare repository and bundle are reused on purpose and not listed.
$pk = 'package-' + $cfg.node + '-' + $kind + '-' + $c8
$aside = & python -I (Join-Path $RI 'tools\set-aside-leftovers.py') $R --pattern ('record/*.' + $stem + '*') --pattern ('build-inputs/*.' + $stem + '.*') `
  --pattern ('upgrade/linux-shape.' + $stem + '.json') --pattern $pk --pattern ($pk + '-rebuild') --done ('upgrade/precheck.' + $stem + '.*.json')
if ($LASTEXITCODE -eq 3) { throw 'ATTEMPT_ALREADY_COMPLETE_USE_ANOTHER_TAG' }
if ($LASTEXITCODE) { $aside; throw 'SET_ASIDE_LEFTOVERS_REFUSED' }
$setAside = $aside | ConvertFrom-Json
if ($setAside.count -gt 0) { Write-Warning ('Set aside ' + $setAside.count + ' leftover path(s) of an earlier failed attempt of ' + $stem + ' into failed-attempts\') }

# 1. the node's current package, and the configuration that carries it (tools\upgrade-config.py)
$ucfg = Join-Path $R ('build-inputs\upgrade-config.' + $stem + '.json')
$u = & python -I (Join-Path $Here 'tools\upgrade-config.py') $Config $InstalledPackage $Root $ucfg; if ($LASTEXITCODE) { $u; throw 'UPGRADE_CONFIG_REFUSED' }
$installedManifest = Get-Content -LiteralPath (Join-Path $InstalledPackage 'package-manifest.json') -Raw | ConvertFrom-Json
foreach ($k in @('nodeIdentitySha256', 'nodeProfileSha256', 'residentManifestSha256', 'stateCompat', 'upgrader')) {   # a /4 package with an upgrader
  if (-not (@($installedManifest.PSObject.Properties.Name) -ccontains $k)) { throw ('INSTALLED_PACKAGE_NOT_AN_UPGRADER_PACKAGE ' + $k) } }

# 2. the commit's tree, checked blob by blob (reinstall\tools\tree.py)
$tree = Join-Path $R ('tree-' + $c8)
$env:GIT_NO_REPLACE_OBJECTS = '1'
if (-not (Test-Path -LiteralPath $tree)) {
  New-Item -ItemType Directory $tree | Out-Null
  $tar = Join-Path $R ('t-' + $c8 + '.tar')
  & git -C $Repo archive --format=tar -o $tar $Commit; if ($LASTEXITCODE) { throw 'GIT_ARCHIVE_FAILED' }
  & python -I -c "import sys,tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter='data')" $tar $tree; if ($LASTEXITCODE) { throw 'TAR_FAILED' }   # not Windows tar.exe: it cannot extract non-ASCII (Chinese) path names
  Remove-Item -LiteralPath $tar
}
& python -I (Join-Path $RI 'tools\tree.py') $Repo $Commit $tree; if ($LASTEXITCODE) { throw 'TREE_NOT_THE_COMMIT' }

# 2b. Generation 13 (DESIGN §57.6, Task 3edfc598): a FINAL package's commit must be on a branch of GitHub. Every batch builds its bundle
#     from GitHub and reads the installed Source commit's .gitleaks.toml from it; a commit only on an unpushed local branch ends every
#     batch BUNDLE_UNAVAILABLE (generation 9, 0521cb9f). Push the branch first. A DRAFT may be built from any local commit.
#     The repository is the one the commit's own build-bundle.ps1 fetches every bundle from ($Url), and it must be the companion
#     input's repo too (review round 2, NIT): the two never disagree in a package.
if ($Final) {
  $bb = [IO.File]::ReadAllText((Join-Path $tree 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\build-bundle.ps1'))
  $urls = @([regex]::Matches($bb, "(?m)^\`$Url='(https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git)'") | ForEach-Object { $_.Groups[1].Value })
  if ($urls.Count -ne 1) { throw 'BUILD_BUNDLE_URL_NOT_FOUND' }
  $bundleRepo = (Get-Content -LiteralPath $cfg.companionInput -Raw | ConvertFrom-Json).repo
  if (-not ($bundleRepo -is [string]) -or $bundleRepo -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'COMPANION_INPUT_REPO_REFUSED' }
  if ($urls[0] -cne ('https://github.com/' + $bundleRepo + '.git')) { throw 'BUILD_BUNDLE_URL_NOT_THE_COMPANION_REPO' }
  $onGithub = & python -I (Join-Path $Here 'tools\source-on-github.py') $urls[0] $Commit
  if ($LASTEXITCODE -eq 3) { throw 'SOURCE_COMMIT_NOT_ON_GITHUB_PUSH_THE_BRANCH_FIRST' }
  if ($LASTEXITCODE) { $onGithub; throw 'SOURCE_COMMIT_ON_GITHUB_UNCONFIRMED' }
}

# 3. the record: the installed references (no --ref), the commit's Source
$closure = Join-Path $tree 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\source-closure.json'
$inputs = Join-Path $R ('record\inputs.' + $stem + '.json')
& python -I (Join-Path $RI 'tools\record-inputs.py') $ucfg $tree $Commit $inputs; if ($LASTEXITCODE) { throw 'RECORD_INPUTS_FAILED' }
$record = Join-Path $R ('record\record.' + $stem)
& node (Join-Path $tree 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\prepare-record.mjs') --inputs $inputs --source-root $tree --closure $closure --out $record; if ($LASTEXITCODE) { throw 'PREPARE_RECORD_FAILED' }
& node (Join-Path $RI 'tools\check-record.mjs') $tree $record; if ($LASTEXITCODE) { throw 'RECORD_V2_REFUSED_BY_RUNTIME_VALIDATOR' }
$files = Join-Path $R ('record\source-files.' + $stem + '.txt')
& python -I -c "import json,sys; p=json.load(open(sys.argv[1],encoding='utf-8-sig'))['paths']; open(sys.argv[2],'x',newline='\n').write('\n'.join(p)+'\n')" $closure $files; if ($LASTEXITCODE) { throw 'SOURCE_FILES_FAILED' }
$ciSha = Sha256File (Join-Path $record 'source-manifest.json')

# 4. policy and companion: this upgrade's Owner acceptance goes into the policy's ownerAcceptance
$pol = Join-Path $R ('build-inputs\policy.' + $stem + '.input.json')
$comp = Join-Path $R ('build-inputs\companion.' + $stem + '.input.json')
& python -I (Join-Path $RI 'tools\node-inputs.py') $ucfg $tree $DecisionRef $ReceiptRef $pol $comp; if ($LASTEXITCODE) { throw 'NODE_INPUTS_FAILED' }

# 5. the Linux half: external pins, the accepted commit's bundle (built once, reused by the rebuild), the derived role hashes
$pins = Join-Path $R ('build-inputs\linux-external-pins.' + $stem + '.json')
$NodePin = @(); if ($cfg.linux.host.toolchainNodeSha256) { $NodePin = @('--toolchain-node', $cfg.linux.host.toolchainNodeSha256) }
& python -I (Join-Path $RI 'tools\linux-pins.py') pins $cfg.linux.installedManifest $pins $tree @NodePin; if ($LASTEXITCODE) { throw 'LINUX_PINS_INPUT_FAILED' }
$bare = Join-Path $R ('upgrade\src-' + $c8 + '.git')
$bundle = Join-Path $R ('upgrade\source-' + $c8 + '.bundle')
if (-not (Test-Path -LiteralPath $bare)) {   # holds only the accepted commit; the bundle is built once and reused by every rebuild
  & git init -q --bare --initial-branch=accepted $bare; if ($LASTEXITCODE) { throw 'BUNDLE_REPO_FAILED' }
  & git -C $bare fetch -q --no-tags $Repo ($Commit + ':refs/heads/accepted'); if ($LASTEXITCODE) { throw 'BUNDLE_FETCH_FAILED' }
}
if (-not (Test-Path -LiteralPath $bundle)) { & git -C $bare bundle create -q $bundle refs/heads/accepted; if ($LASTEXITCODE) { throw 'BUNDLE_CREATE_FAILED' } }
& git -C $bare bundle verify -q $bundle; if ($LASTEXITCODE) { throw 'BUNDLE_VERIFY_FAILED' }
$heads = @(& git bundle list-heads $bundle); if ($LASTEXITCODE -or $heads.Count -ne 1 -or $heads[0] -cne ($Commit + ' refs/heads/accepted')) { throw 'BUNDLE_NOT_ONLY_THE_ACCEPTED_COMMIT' }
$facts = Join-Path $Root 'upgrade\mailbox\responses\version-facts.json'
$rolesOut = & python -I (Join-Path $Here 'tools\roles-derived.py') $tree $Repo $Commit $cfg.linux.installedRoles (Join-Path $record 'source-manifest.json') $ciSha $facts
if ($LASTEXITCODE) { $rolesOut; throw 'ROLES_DERIVATION_REFUSED' }
$roles = ($rolesOut | ConvertFrom-Json).rolesDerivedSha256
$sv = Join-Path $R ('build-inputs\source-v2.' + $stem + '.json')
Write-New $sv (([ordered]@{ commit = $Commit; bundle = $bundle; rolesDerivedSha256 = [ordered]@{ gitleaks = $roles.gitleaks; trivy = $roles.trivy; 'contract-placement' = $roles.'contract-placement' } }) | ConvertTo-Json -Depth 4)
$sc = Join-Path $R ('build-inputs\state-compat.' + $stem + '.json')
# the installed package's stateCompat, byte-faithful (Python: PowerShell 5.1 would turn a one-element readableBySchemas into a number)
if ($StateCompat) { Copy-Item -LiteralPath $StateCompat -Destination $sc } else {
  & python -I -c "import json,sys; m=json.load(open(sys.argv[1],encoding='utf-8')); open(sys.argv[2],'x',newline='\n').write(json.dumps(m['stateCompat'],sort_keys=True)+'\n')" (Join-Path $InstalledPackage 'package-manifest.json') $sc
  if ($LASTEXITCODE) { throw 'STATE_COMPAT_INPUT_FAILED' } }

# 6. the package, twice from the same inputs
$res = Join-Path $tree 'work\independent-ci-resident-v1'
function Build-Package([string]$Out) {
  Push-Location $res
  try { $b = & node tools/build-package.mjs --out $Out --policy $pol --companion $comp --node $cfg.nodeExe --record $record --source-root $tree --source-files $files --linux-external-pins $pins --source-v2 $sv --state-compat $sc; if ($LASTEXITCODE) { throw 'BUILD_PACKAGE_FAILED' } } finally { Pop-Location }
  return ($b | ConvertFrom-Json)
}
$pkg = Join-Path $R ('package-' + $cfg.node + '-' + $kind + '-' + $c8)
$first = Build-Package $pkg
$again = Build-Package ($pkg + '-rebuild')
if ($first.packageManifestSha256 -cne $again.packageManifestSha256) { throw 'PACKAGE_NOT_REPRODUCIBLE' }
$shape = & python -I (Join-Path $RI 'tools\linux-pins.py') check (Join-Path $pkg 'linux\manifest.json') $cfg.linux.installedManifest $tree @NodePin
if ($LASTEXITCODE) { throw 'LINUX_MANIFEST_NOT_THE_INSTALLED_SHAPE' }
Write-New (Join-Path $R ('upgrade\linux-shape.' + $stem + '.json')) ($shape | Out-String)
$pkgSha = $first.packageManifestSha256
$m = Get-Content -LiteralPath (Join-Path $pkg 'package-manifest.json') -Raw | ConvertFrom-Json
if ($m.nodeIdentitySha256 -cne $installedManifest.nodeIdentitySha256) { throw 'UPGRADE_NODE_IDENTITY_WOULD_CHANGE' }   # e.g. a new App key: a full reinstall
if ($m.nodeProfileSha256 -cne $installedManifest.nodeProfileSha256) { throw 'UPGRADE_NODE_PROFILE_WOULD_CHANGE' }

# 7. the precheck: the installed upgrader's ACCEPT on this node, read-only
$pre = & node (Join-Path $Here 'precheck.mjs') --root $Root --package $pkg --package-sha $pkgSha --acceptance $DecisionRef --installed-package $InstalledPackage
$preExit = $LASTEXITCODE
Write-New (Join-Path $R ('upgrade\precheck.' + $stem + '.' + $pkgSha.Substring(0, 8) + '.json')) ($pre | Out-String)
$p = $pre | ConvertFrom-Json
$request = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Root ('resident\' + $installedManifest.residentManifestSha256 + '\windows\request-upgrade.ps1')) + '" -PackageRoot "' + $pkg + '" -ExpectedPackageManifestSha256 ' + $pkgSha + ' -AcceptanceDecisionRef ' + $DecisionRef
([ordered]@{ status = $(if ($preExit -eq 0) { 'UPGRADE_PACKAGE_BUILT' } else { 'UPGRADE_PACKAGE_BUILT_PRECHECK_REFUSED' }); node = $cfg.node; final = [bool]$Final
  package = $pkg; packageManifestSha256 = $pkgSha; ciSourceManifestSha256 = $m.ciSourceManifestSha256; residentManifestSha256 = $m.residentManifestSha256
  grantResource = ('ci-resident:' + $cfg.node + '/' + $pkgSha); precheck = $p.status; precheckCode = $(if ($p.PSObject.Properties.Name -contains 'code') { $p.code } else { $null })
  requestCommand = $(if ($Final -and $preExit -eq 0) { $request } else { $null }) } | ConvertTo-Json -Depth 4)
if ($preExit -ne 0) { exit 1 }
