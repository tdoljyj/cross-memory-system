<#
.SYNOPSIS
  First install, P1: the host preparation of a NEW node, ELEVATED (the first install's one UAC before the package is assembled).
  Run by rollout/fleet/bootstrap.ps1 only, from the copy of the accepted archive that the elevated process checked (sha256) and
  extracted itself into an admin-only directory; never with a node argument.

.DESCRIPTION
  Idempotent: each step that finds its result already there only checks it; the same command is run again after a stop or a restart.
  Writes C:\ProgramData\CluedIndependentCI\first-install\facts.json (clued.independent-ci.first-install-facts/1, public) and
  companion-wsl.json, the App private key and the ci-admission token at the installer's own targets with its secret ACL (as a
  reinstall finds them in place: the launcher never touches them), and the two connection tokens the installer is given
  (resident-upgrade, heartbeat) under first-install\credentials\ (SYSTEM and Administrators only): exactly what
  rollout/fleet/install.mjs prepare's first-install branch reads (the contract: D:\w\tmp\first-install-entry-contracts.md, to move
  into rollout/fleet/BATCH1-INTERFACES.md with PR1).
  Steps (each prints one JSON line {step, result}; the last line is the verdict):
    residue        refuses a node with anything of a Clued resident (the three services, the firewall rule, the companion task, the
                   resident root): FIRST_INSTALL_RESIDUE_PRESENT names it; uninstall it first (uninstall-resident.ps1 /
                   remove-companion-account.ps1), never overwritten here;
    stage          a new admin-only directory under C:\Windows\Temp: the prerequisite manifest and the kit copied in and held to the
                   sha256 the bootstrap pinned on this command line; every prerequisite this step uses copied in and held to the
                   manifest's sha256 and size (the bootstrap's work directory is the Owner's, writable by any of the Owner's processes);
    features       Microsoft-Windows-Subsystem-Linux and VirtualMachinePlatform enabled (/norestart); when Windows says a restart is
                   needed: RESTART_THEN_RUN_THE_SAME_COMMAND (exit 3); standby and hibernation off;
    profile        the node profile from this machine (Get-NodeProfile: no parameter, a machine name that is not a node name refuses);
    accounts       .\clued-control and .\clued-runner (made when absent, random password nobody knows, not administrators), the
                   companion account by the package's own windows\prepare-companion-account.ps1 (its registrar, its gh step);
                   clued-control's right to log on as a service;
    ci-root        C:\ProgramData\CluedIndependentCI and formal-spool with the baseline DACL the installer appends to (Get-CiRootSddl),
                   first-install\ and first-install\credentials\;
    runner         the carrier runner binaries (prerequisite actions-runner) at C:\ProgramData\CluedControl\runner and its service
                   (RunnerService.exe, Manual, Stopped, .\clued-control): never registered with GitHub;
    distribution   CluedResident-Linux imported from the pinned Ubuntu rootfs (see the note below);
    linux          as root in it: linux/first-host-prep.sh, reinstall/linux/tools/make-result-key.sh (create-only),
                   reinstall/linux/tools/first-install-facts.py (read-only): systemd, cgroup v2, docker with the classic image store,
                   python3.12, git, the toolchain node with the kit's sha256, this node's result key;
    credentials    -CredentialDirectory (only a directory whose DACL is SYSTEM and Administrators alone, fixed file names) or the
                   Windows dialogs: one credential box per connection token (ci-admission, resident-upgrade, heartbeat), the system's
                   Open dialog for the App private key (.pem), one input box per public value (App key id, CI connection id, the two
                   formal refs, the heartbeat connection id). The plain values live only in this process's memory and in their
                   targets; each is fingerprinted at once with the package's tools\secret-fingerprint.mjs. The App key goes to
                   C:\ProgramData\CluedControl\trusted\controller-checks-app.pem and the ci-admission token to
                   C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token (install-resident.ps1 $SecretTargets), create-only with
                   Get-SecretFileSddl (SYSTEM and Administrators full, .\clued-control read); found there already, the file's fingerprint
                   must be the one given now. The two connection tokens go to first-install\credentials\;
    facts          facts.json and companion-wsl.json, create-only; found already, they must be the same (observedAt aside).
  NOTE, the distribution: the registrar (CompanionTaskRegistrar.cs root-run / register-account) works only for an INSTALLED resident
  (it reads <root>\record\acceptance.json and the companion's switch-qualified password task). Before the first install no reviewed
  tool can run anything as root in a distribution registered to the companion account, so P1 imports CluedResident-Linux to the
  operator's own WSL (the elevated Owner, like DESK-W-591's before its M5-b move) and companion-wsl.json says stage
  "owner-imported". Moving it to the companion account is the existing M5-b switch after the install; the first-install plan must
  then run Linux A/B as the operator (companionAccount false). This is a contract point for PR1, not settled here.
#>
param([string]$Tree, [string]$PrereqDirectory, [string]$PrereqManifest, [string]$PrereqManifestSha256, [string]$Kit, [string]$KitSha256,
  [string]$CredentialDirectory)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions   # JavaScriptSerializer (Windows PowerShell 5.1 does not load it by itself)
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$CiRoot = 'C:\ProgramData\CluedIndependentCI'
$ResidentRoot = 'C:\ProgramData\CluedIndependentCI\resident'
$FirstDir = 'C:\ProgramData\CluedIndependentCI\first-install'
$CredDir = 'C:\ProgramData\CluedIndependentCI\first-install\credentials'
$ControlRoot = 'C:\ProgramData\CluedControl'
$OriginalBinary = '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"'   # install-resident.ps1 $OriginalBinary
$Distribution = 'CluedResident-Linux'
$VhdxDirectory = 'C:\ProgramData\CluedIndependentCI\wsl\CluedResident-Linux'
$Wsl = 'C:\Windows\System32\wsl.exe'
$Sc = 'C:\Windows\System32\sc.exe'
$FactsContract = 'clued.independent-ci.first-install-facts/1'
# install-resident.ps1 $SecretTargets: placed here, never passed to the installer (a reinstall finds them in place the same way)
$SecretTargets = [ordered]@{ appKey = 'C:\ProgramData\CluedControl\trusted\controller-checks-app.pem'; ciToken = 'C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token' }
# -CredentialDirectory's fixed input names; only upgradeToken and heartbeatToken are placed under first-install\credentials\
$CredentialFiles = [ordered]@{ appPrivateKey = 'app-private-key.pem'; ciAdmissionToken = 'ci-admission.token'; upgradeToken = 'resident-upgrade.token'; heartbeatToken = 'ci-node-heartbeat.token'; public = 'public.json' }
$Utf8 = New-Object Text.UTF8Encoding($false)
$Strict8 = New-Object Text.UTF8Encoding($false, $true)

# ------------------------------------------------------------------ pure functions (test-first-install-host.ps1 runs them)
function Get-Key($d, [string]$k) { if ($d -is [Collections.IDictionary] -and ([Collections.IDictionary]$d).Contains($k)) { $d[$k] } else { $null } }
function Get-Rid([string]$sid) { if ($sid -cmatch '^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-(\d{1,10})$') { [long]$Matches[1] } else { $null } }
# The node profile (clued.independent-ci.node-profile/1; prepare-record.mjs#validateNodeProfile is the rule, held here too) from this
# machine's name and the three accounts. Throws HOSTNAME_NOT_A_NODE_NAME (a machine name that cannot be one: rename the machine) or
# NODE_PROFILE_INVALID.
function Get-NodeProfile([string]$machineName, [string]$controllerSid, [string]$companionSid, [string]$companionProfileDirectory) {
  $hostname = $machineName.ToUpperInvariant()
  if ($hostname -cnotmatch '^[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?$') { throw ('HOSTNAME_NOT_A_NODE_NAME:' + $machineName) }
  $nodeName = $hostname.ToLowerInvariant()
  $rid = Get-Rid $controllerSid
  $p = [ordered]@{ contract = 'clued.independent-ci.node-profile/1'; controllerSid = $controllerSid; hostname = $hostname
    mutationMutex = ('Global\CluedControlControllerMutationV1-' + $hostname + '-' + $rid); nodeName = $nodeName; ownerProfileDirectory = $companionProfileDirectory
    ownerSid = $companionSid; runnerService = ('actions.runner.tdoljyj-cross-memory-system.clued-ci-' + $nodeName); wslDistribution = $Distribution }
  $ok = $null -ne $rid -and $rid -ge 1000 -and $null -ne (Get-Rid $companionSid) -and $companionSid -cne $controllerSid -and
    $nodeName -cmatch '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$' -and $companionProfileDirectory -cmatch '^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$'
  if (-not $ok) { throw 'NODE_PROFILE_INVALID' }
  $p
}
# The node's signer by the convention (reinstall/README.md section 8c, now code): keyId <nodeName>-first-run-<yyyymmdd> (UTC day of
# the key), runtimeId <HOSTNAME>-cluedresident-independent-ci-v1, the Ed25519 public key PEM make-result-key.sh made.
function Get-Signer($nodeProfile, [string]$publicKeyPem, [DateTime]$keyDayUtc) {
  if ($publicKeyPem -cnotmatch '\A-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=\n-----END PUBLIC KEY-----\n\z') { throw 'RESULT_PUBLIC_KEY_NOT_ED25519_PEM' }
  [ordered]@{ keyId = ($nodeProfile.nodeName + '-first-run-' + $keyDayUtc.ToString('yyyyMMdd')); runtimeId = ($nodeProfile.hostname + '-cluedresident-independent-ci-v1'); publicKeyPem = $publicKeyPem }
}
# CI root and formal-spool before any install (the v1 one-shot baseline as on DESK-W-591, 2026-11-16, read-only): protected,
# SYSTEM and Administrators full, the operator READ_CONTROL|SYNCHRONIZE|read-attributes on this folder, clued-control read and
# execute inherited. The installer appends its own ACEs (companion relay parent, the resident service) to exactly this.
function Get-CiRootSddl([string]$operatorSid, [string]$controllerSid) { 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x120080;;;' + $operatorSid + ')(A;OICI;0x1200a9;;;' + $controllerSid + ')' }
# first-install\: the operator reads (prepare runs non-elevated); credentials\: SYSTEM and Administrators only.
function Get-FirstInstallSddl([string]$operatorSid) { 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $operatorSid + ')' }
function Get-AdminOnlySddl { 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' }
# install-resident.ps1's own two (test-first-install-host.ps1 holds them to its text): a secret file, and its folder.
function Get-SecretFileSddl([string]$controllerSid) { 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $controllerSid + ')' }
function Get-SecretDirectorySddl([string]$controllerSid) { 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $controllerSid + ')' }
# An existing directory's descriptor against the wanted one: owner and DACL equal ACE for ACE (order-insensitive), protected.
function Test-SddlIs([string]$actual, [string]$want) {
  try { $a = New-Object Security.AccessControl.RawSecurityDescriptor($actual); $w = New-Object Security.AccessControl.RawSecurityDescriptor($want) } catch { return $false }
  if ($a.Owner.Value -cne $w.Owner.Value) { return $false }
  if ((($a.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0)) { return $false }
  $key = { param($ace) ([string]$ace.AceQualifier) + '|' + $ace.SecurityIdentifier.Value + '|' + $ace.AccessMask + '|' + ([int]$ace.AceFlags -band 0x0F) }
  $ak = @(foreach ($x in $a.DiscretionaryAcl) { & $key $x }) | Sort-Object
  $wk = @(foreach ($x in $w.DiscretionaryAcl) { & $key $x }) | Sort-Object
  (@($ak) -join ';') -ceq (@($wk) -join ';')
}
# What of a Clued resident is on this host ($observed: services, firewallRule, companionTask, residentRoot booleans): the codes.
function Get-ResidueCodes($observed) {
  $codes = @()
  foreach ($s in @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader')) { if (@($observed.services) -ccontains $s) { $codes += ('SERVICE:' + $s) } }
  if ($observed.firewallRule) { $codes += 'FIREWALL_RULE:CluedCIResident-BlockOutbound' }
  if ($observed.companionTask) { $codes += 'SCHEDULED_TASK:\Clued\CluedCIResidentCompanion' }
  if ($observed.residentRoot) { $codes += ('DIRECTORY:' + $ResidentRoot) }
  , @($codes)
}
# A connection token's fingerprint (template.ps1 Get-FleetTokenFingerprint = tools/secret-fingerprint.mjs): the trimmed token under
# its kind's domain; $null when the bytes are not that kind's token.
function Get-TokenFingerprint([byte[]]$bytes, [string]$kind) {
  $spec = switch ($kind) { 'ci-token' { , @("clued.independent-ci.ci-binding-pin/1`0", '^clued_bnd_[A-Za-z0-9_-]{8,480}\z') } 'heartbeat-token' { , @("clued.independent-ci.heartbeat-token-pin/1`0", '^clued_hbt_[A-Za-z0-9_-]{43}\z') } default { $null } }
  if ($null -eq $spec -or $null -eq $bytes -or $bytes.Length -lt 1 -or $bytes.Length -gt 4096) { return $null }
  $token = try { $Strict8.GetString($bytes).Trim() } catch { return $null }
  if ($token -cnotmatch $spec[1]) { return $null }
  $s = [Security.Cryptography.SHA256]::Create()
  try { -join ($s.ComputeHash($Utf8.GetBytes($spec[0] + $token)) | ForEach-Object { $_.ToString('x2') }) } finally { $s.Dispose() }
}
# The facts document (the contract) and its check. Returns the codes (empty: valid).
function New-FirstInstallFacts($nodeProfile, [string]$operatorSid, [string]$vhdxDirectory, $nodeRecord, $credentials, $signer, $linuxHost, [string]$observedAt) {
  [ordered]@{ contract = $FactsContract; observedAt = $observedAt; node = $nodeProfile; operatorSid = $operatorSid
    companionWsl = [ordered]@{ distribution = $nodeProfile.wslDistribution; vhdxDirectory = $vhdxDirectory }
    nodeRecord = $nodeRecord; credentials = $credentials; signer = $signer; linuxHost = $linuxHost }
}
function Test-FirstInstallFacts($f) {
  $c = @()
  $U = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'; $H = '^[0-9a-f]{64}$'
  $keys = @('contract', 'observedAt', 'node', 'operatorSid', 'companionWsl', 'nodeRecord', 'credentials', 'signer', 'linuxHost')
  if ($f -isnot [Collections.IDictionary] -or (@($f.Keys | Sort-Object) -join ',') -cne (@($keys | Sort-Object) -join ',')) { return , @('FACTS_KEYS') }
  if ($f.contract -cne $FactsContract) { $c += 'FACTS_CONTRACT' }
  if ([string]$f.observedAt -cnotmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$') { $c += 'FACTS_OBSERVED_AT' }
  $n = $f.node
  try { $null = Get-NodeProfile ([string](Get-Key $n 'hostname')) ([string](Get-Key $n 'controllerSid')) ([string](Get-Key $n 'ownerSid')) ([string](Get-Key $n 'ownerProfileDirectory')) } catch { $c += 'FACTS_NODE' }
  if ($c -notcontains 'FACTS_NODE') {
    $again = Get-NodeProfile $n.hostname $n.controllerSid $n.ownerSid $n.ownerProfileDirectory
    if ((@($n.Keys | Sort-Object) -join ',') -cne (@($again.Keys | Sort-Object) -join ',') -or @($again.Keys | Where-Object { [string]$n[$_] -cne [string]$again[$_] }).Count) { $c += 'FACTS_NODE_NOT_DERIVED' }
  }
  if ($null -eq (Get-Rid ([string]$f.operatorSid)) -or $f.operatorSid -ceq (Get-Key $n 'ownerSid') -or $f.operatorSid -ceq (Get-Key $n 'controllerSid')) { $c += 'FACTS_OPERATOR' }
  $w = $f.companionWsl
  if ((Get-Key $w 'distribution') -cne $Distribution -or [string](Get-Key $w 'vhdxDirectory') -cnotmatch '^[A-Z]:\\(?:[A-Za-z0-9._-]{1,64}\\){0,6}[A-Za-z0-9._-]{1,64}$') { $c += 'FACTS_COMPANION_WSL' }
  $r = $f.nodeRecord
  $rk = @('appKeyId', 'appPublicKeySha256Base64', 'ciPrincipalBindingId', 'ciPrincipalQualificationRef', 'ciPrincipalRoleRef', 'ciTokenPinSha256')
  if ($r -isnot [Collections.IDictionary] -or (@($r.Keys | Sort-Object) -join ',') -cne ($rk -join ',') -or -not (($r.appKeyId -is [int] -or $r.appKeyId -is [long]) -and $r.appKeyId -gt 0) -or
    [string]$r.appPublicKeySha256Base64 -cnotmatch '^[A-Za-z0-9+/]{43}=$' -or [string]$r.ciTokenPinSha256 -cnotmatch $H -or
    @(@('ciPrincipalBindingId', 'ciPrincipalQualificationRef', 'ciPrincipalRoleRef') | Where-Object { [string]$r[$_] -cnotmatch $U }).Count) { $c += 'FACTS_NODE_RECORD' }
  $cr = $f.credentials
  $up = Get-Key $cr 'upgradeToken'; $hb = Get-Key $cr 'heartbeatToken'
  if ($cr -isnot [Collections.IDictionary] -or (@($cr.Keys | Sort-Object) -join ',') -cne 'heartbeatToken,upgradeToken' -or
    $up -isnot [Collections.IDictionary] -or @($up.Keys).Count -ne 1 -or [string]$up.fingerprint -cnotmatch $H -or
    -not ($null -eq $hb -or ($hb -is [Collections.IDictionary] -and (@($hb.Keys | Sort-Object) -join ',') -ceq 'bindingId,fingerprint' -and [string]$hb.fingerprint -cmatch $H -and
      ($null -eq $hb.bindingId -or [string]$hb.bindingId -cmatch $U) -and $hb.fingerprint -cne $up.fingerprint))) { $c += 'FACTS_CREDENTIALS' }
  $s = $f.signer; $lh = $f.linuxHost
  if ($s -isnot [Collections.IDictionary] -or (@($s.Keys | Sort-Object) -join ',') -cne 'keyId,publicKeyPem,runtimeId' -or
    [string]$s.keyId -cnotmatch ('^' + [regex]::Escape([string](Get-Key $n 'nodeName')) + '-first-run-\d{8}$') -or $s.runtimeId -cne ([string](Get-Key $n 'hostname') + '-cluedresident-independent-ci-v1') -or
    [string]$s.publicKeyPem -cnotmatch '\A-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=\n-----END PUBLIC KEY-----\n\z') { $c += 'FACTS_SIGNER' }
  if ($lh -isnot [Collections.IDictionary] -or (@($lh.Keys | Sort-Object) -join ',') -cne 'resultPublicKeySha256,toolchainNodeSha256' -or [string]$lh.toolchainNodeSha256 -cnotmatch $H -or [string]$lh.resultPublicKeySha256 -cnotmatch $H) { $c += 'FACTS_LINUX_HOST' }
  elseif ($null -ne (Get-Key $s 'publicKeyPem')) {
    $sh = [Security.Cryptography.SHA256]::Create(); try { $pk = -join ($sh.ComputeHash([Text.Encoding]::ASCII.GetBytes([string]$s.publicKeyPem)) | ForEach-Object { $_.ToString('x2') }) } finally { $sh.Dispose() }
    if ($pk -cne $lh.resultPublicKeySha256) { $c += 'FACTS_RESULT_KEY_NOT_THE_SIGNERS' }
  }
  , @($c)
}
# Two facts documents are the same install when everything but observedAt is equal (a re-run finds its own facts).
function Test-SameFacts($a, $b) {
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer
  $strip = { param($d) $o = [ordered]@{}; foreach ($k in @($d.Keys | Sort-Object)) { if ($k -cne 'observedAt') { $o[$k] = $d[$k] } }; $o }
  $canon = { param($v) if ($v -is [Collections.IDictionary]) { $o = [ordered]@{}; foreach ($k in @($v.Keys | Sort-Object)) { $o[$k] = & $canon $v[$k] }; $o } else { $v } }
  $js.Serialize((& $canon (& $strip $a))) -ceq $js.Serialize((& $canon (& $strip $b)))
}
# The Linux facts first-install-facts.py printed, as P1 needs them: the codes when this is not a host the first install can use.
function Test-LinuxFirstInstallFacts($lf, [string]$toolchainSha) {
  $c = @()
  if ((Get-Key $lf 'contract') -cne 'clued.independent-ci.linux-first-install-facts/1' -or (Get-Key $lf 'root') -ne $true) { return , @('LINUX_FACTS_SHAPE') }
  $tn = Get-Key $lf 'toolchainNode'; $pk = Get-Key $lf 'resultPublicKey'; $k = Get-Key $lf 'resultKey'
  if ((Get-Key $tn 'present') -ne $true -or (Get-Key $tn 'protected') -ne $true -or (Get-Key $tn 'sha256') -cne $toolchainSha) { $c += 'LINUX_TOOLCHAIN_NODE_NOT_THE_KITS' }
  if ((Get-Key $pk 'present') -ne $true -or (Get-Key $pk 'protected') -ne $true -or [string](Get-Key $pk 'pem') -ceq '') { $c += 'LINUX_RESULT_PUBLIC_KEY' }
  if ((Get-Key $k 'present') -ne $true -or (Get-Key $k 'protected') -ne $true) { $c += 'LINUX_RESULT_KEY' }
  foreach ($x in @('systemdPid1', 'cgroupV2', 'dockerActive', 'python312')) { if ((Get-Key $lf $x) -ne $true) { $c += ('LINUX_' + $x) } }
  if (@(Get-Key $lf 'linuxCiPresent').Count -ne 0) { $c += 'LINUX_CI_ALREADY_PRESENT' }
  , @($c)
}

# ------------------------------------------------------------------ host steps
function New-RandomPassword { $b = New-Object byte[] 33; $r = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $r.GetBytes($b) } finally { $r.Dispose() }; [Convert]::ToBase64String($b) }
function ConvertTo-Secure([string]$t) { $s = New-Object Security.SecureString; foreach ($ch in $t.ToCharArray()) { $s.AppendChar($ch) }; $s.MakeReadOnly(); $s }
function Sha256File([string]$p) { $s = [Security.Cryptography.SHA256]::Create(); $f = [IO.File]::OpenRead($p); try { (-join ($s.ComputeHash($f) | ForEach-Object { $_.ToString('x2') })) } finally { $f.Dispose(); $s.Dispose() } }
function Step([string]$name, $result) { ((New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ step = $name; result = $result })) }
function Stop-Host([string]$code, $detail) { ((New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ status = 'FIRST_INSTALL_HOST_REFUSED'; code = $code; detail = $detail })); exit 1 }
function New-Dir([string]$path, [string]$sddl) {
  if ([IO.Directory]::Exists($path)) {
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Host 'DIRECTORY_IS_A_LINK' $path }
    if (-not (Test-SddlIs (Get-Acl -LiteralPath $path).Sddl $sddl)) { Stop-Host 'DIRECTORY_ACL_NOT_THE_WANTED' ([ordered]@{ path = $path; actual = (Get-Acl -LiteralPath $path).Sddl; want = $sddl }) }
    return 'checked'
  }
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($sddl)
  [void][IO.Directory]::CreateDirectory($path, $ds)
  if (-not (Test-SddlIs (Get-Acl -LiteralPath $path).Sddl $sddl)) { Stop-Host 'DIRECTORY_ACL_READBACK' $path }
  'made'
}
function Write-CreateOnly([string]$path, [byte[]]$bytes, [string]$sddl) {
  $fs = New-Object Security.AccessControl.FileSecurity; $fs.SetSecurityDescriptorSddlForm($sddl)
  $f = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $fs)
  try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
}
function Copy-Verified([string]$from, [string]$to, [string]$sha, $bytes) {
  if (-not [IO.File]::Exists($from)) { Stop-Host 'INPUT_MISSING' $from }
  [IO.File]::Copy($from, $to, $false)
  if ((Sha256File $to) -cne $sha -or ($null -ne $bytes -and (Get-Item -LiteralPath $to).Length -ne [long]$bytes)) { Stop-Host 'INPUT_NOT_THE_PINNED_BYTES' ([IO.Path]::GetFileName($to)) }
  $to
}
function Invoke-Wsl([string[]]$arguments, [int]$seconds = 3600) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Wsl; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = $Utf8
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($seconds * 1000)) { Stop-Host 'WSL_COMMAND_TIMEOUT_NOTHING_KILLED' ($arguments -join ' ') }
  [ordered]@{ exit = $p.ExitCode; stdout = $o.Result; stderr = $e.Result }
}
function Invoke-Root([string]$wslScript, [string[]]$scriptArgs, [string]$interpreter = '/usr/bin/bash') {
  $base = @('-d', $Distribution, '-u', 'root', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'LANG=C', 'LC_ALL=C', 'HOME=/root')
  $run = if ($interpreter -ceq '/usr/bin/bash') { @('/usr/bin/bash', '--noprofile', '--norc', $wslScript) } else { @($interpreter, '-I', $wslScript) }
  Invoke-Wsl ($base + $run + $scriptArgs)
}
function To-WslPath([string]$p) { '/mnt/' + $p.Substring(0, 1).ToLowerInvariant() + $p.Substring(2).Replace('\', '/') }
# The secret-fingerprint tool of the package, with the staged node, a cleared environment, the secret on stdin (place-app-key.ps1's way).
function Get-SecretFingerprint([byte[]]$secret, [string]$kind) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe; $psi.Arguments = '"' + $script:FingerprintTool + '" ' + $kind; $psi.WorkingDirectory = 'C:\Windows\System32'
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables.Clear(); $psi.EnvironmentVariables['SystemRoot'] = 'C:\Windows'; $psi.EnvironmentVariables['WINDIR'] = 'C:\Windows'; $psi.EnvironmentVariables['PATH'] = 'C:\Windows\System32'
  $p = [Diagnostics.Process]::Start($psi)
  try { $p.StandardInput.BaseStream.Write($secret, 0, $secret.Length) } finally { $p.StandardInput.Close() }
  $o = $p.StandardOutput.ReadToEndAsync(); $null = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch { }; Stop-Host 'SECRET_FINGERPRINT_TIMEOUT' $kind }
  if ($p.ExitCode -ne 0) { return $null }
  $r = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($o.Result.Trim())
  if ((Get-Key $r 'kind') -cne $kind) { return $null }
  [string]$r['fingerprint']
}
function Read-SecureBytes([Security.SecureString]$s) {
  $p = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($s)
  try { $chars = New-Object char[] $s.Length; [Runtime.InteropServices.Marshal]::Copy($p, $chars, 0, $s.Length); $b = $Utf8.GetBytes($chars); [Array]::Clear($chars, 0, $chars.Length); , $b }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($p) }
}
function Read-TokenFromDialog([string]$what) {
  $c = Get-Credential -UserName $what -Message ("Clued first install: paste the $what connection token as the password (it is fingerprinted and stored for SYSTEM and Administrators only; never shown).")
  if ($null -eq $c) { Stop-Host 'CREDENTIAL_DIALOG_CANCELLED' $what }
  Read-SecureBytes $c.Password
}
function Read-PublicFromDialog([string]$prompt) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $v = [Microsoft.VisualBasic.Interaction]::InputBox($prompt, 'Clued first install', '')
  if ($null -eq $v) { '' } else { $v.Trim() }
}
function Read-AppKeyFromDialog {
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object Windows.Forms.OpenFileDialog; $d.Title = 'Clued first install: the GitHub App private key (.pem) you downloaded'; $d.Filter = 'PEM (*.pem)|*.pem'
  if ($d.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { Stop-Host 'APP_KEY_DIALOG_CANCELLED' $null }
  $item = Get-Item -LiteralPath $d.FileName -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -lt 1 -or $item.Length -gt 16384) { Stop-Host 'APP_KEY_FILE_REFUSED' $null }
  , [IO.File]::ReadAllBytes($item.FullName)
}

function Invoke-HostPreparation {
  # elevation, the operator
  $wi = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($wi)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Stop-Host 'RUN_ELEVATED' $null }
  $operator = $wi.User.Value
  foreach ($a in @($Tree, $PrereqDirectory, $PrereqManifest, $Kit)) { if (-not $a) { Stop-Host 'USAGE' $null } }
  if ($PrereqManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or $KitSha256 -cnotmatch '^[0-9a-f]{64}$') { Stop-Host 'USAGE' 'pinned sha256 required' }
  # residue
  $observed = [ordered]@{ services = @(Get-Service -Name 'CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    firewallRule = [bool](Get-NetFirewallRule -Name 'CluedCIResident-BlockOutbound' -ErrorAction SilentlyContinue)
    companionTask = [bool](Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -ErrorAction SilentlyContinue); residentRoot = [IO.Directory]::Exists($ResidentRoot) }
  $res = Get-ResidueCodes $observed
  if ($res.Count) { Stop-Host 'FIRST_INSTALL_RESIDUE_PRESENT' ([ordered]@{ found = $res; remove = 'uninstall-resident.ps1 (installed copy) / remove-companion-account.ps1; then run the same command' }) }
  Step 'residue' 'none'
  # stage: what this elevated run uses, copied into an admin-only directory and held to the pins
  $stage = Join-Path 'C:\Windows\Temp' ('clued-p1-' + [Guid]::NewGuid().ToString('N'))
  $null = New-Dir $stage (Get-AdminOnlySddl)
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer
  $man = $js.DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes((Copy-Verified $PrereqManifest (Join-Path $stage 'prereq-manifest.json') $PrereqManifestSha256 $null))))
  $kitObj = $js.DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes((Copy-Verified $Kit (Join-Path $stage 'kit.json') $KitSha256 $null))))
  $toolchainSha = [string](Get-Key (Get-Key $kitObj 'template') 'toolchainNodeSha256')
  if ($toolchainSha -cnotmatch '^[0-9a-f]{64}$') { Stop-Host 'KIT_HAS_NO_TOOLCHAIN_NODE_SHA256' 'kit.template.toolchainNodeSha256' }
  $items = @{}; foreach ($i in @(Get-Key $man 'items')) { $items[[string](Get-Key $i 'name')] = $i }
  $staged = @{}
  foreach ($n in @('node', 'ubuntu-rootfs', 'actions-runner', 'linux-node')) {
    $i = $items[$n]; if ($null -eq $i -or [string](Get-Key $i 'sha256') -cnotmatch '^[0-9a-f]{64}$') { Stop-Host 'PREREQ_NOT_PINNED' $n }
    $staged[$n] = Copy-Verified (Join-Path $PrereqDirectory $i['fileName']) (Join-Path $stage $i['fileName']) $i['sha256'] $i['bytes']
  }
  Expand-Archive -LiteralPath $staged['node'] -DestinationPath (Join-Path $stage 'node')
  $ne = @(Get-ChildItem -LiteralPath (Join-Path $stage 'node') -Recurse -Filter node.exe | ForEach-Object { $_.FullName })
  if ($ne.Count -ne 1) { Stop-Host 'NODE_NOT_ONE' $ne.Count }
  $script:NodeExe = $ne[0]
  $R = Join-Path $Tree 'work\independent-ci-resident-v1'
  $script:FingerprintTool = Join-Path $R 'tools\secret-fingerprint.mjs'
  $apt = Get-Key $man 'aptPins'
  $pinsText = (@('containerd', 'docker.io', 'git', 'python3.12') | ForEach-Object { if ([string](Get-Key $apt $_) -cnotmatch '^[A-Za-z0-9.+:~-]{1,100}$') { Stop-Host 'PREREQ_NOT_PINNED' ('apt:' + $_) }; $_ + '=' + $apt[$_] }) -join "`n"
  [IO.File]::WriteAllText((Join-Path $stage 'apt-pins.txt'), $pinsText + "`n", $Utf8)
  Step 'stage' $stage
  # features (a restart: run the same command again), power
  $needRestart = $false
  foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
    $info = & dism.exe /English /online /get-featureinfo "/featurename:$feature" | Out-String
    if ($info -notmatch 'State : Enabled') {
      $null = & dism.exe /English /online /enable-feature "/featurename:$feature" /all /norestart | Out-String
      if ($LASTEXITCODE -eq 3010) { $needRestart = $true } elseif ($LASTEXITCODE -ne 0) { Stop-Host 'WINDOWS_FEATURE_ENABLE_FAILED' $feature }
    }
  }
  if ($needRestart) { ((New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ status = 'RESTART_THEN_RUN_THE_SAME_COMMAND'; why = 'Windows features enabled' })); exit 3 }
  $null = & powercfg.exe /change standby-timeout-ac 0; $null = & powercfg.exe /hibernate off
  Step 'features' 'enabled; standby-ac 0, hibernate off'
  # accounts
  foreach ($name in @('clued-control', 'clued-runner')) {
    $u = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
    if ($null -eq $u) {
      $u = New-LocalUser -Name $name -Password (ConvertTo-Secure (New-RandomPassword)) -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description 'Clued independent CI service account'
    }
    if (-not $u.Enabled) { Stop-Host 'SERVICE_ACCOUNT_DISABLED' $name }
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -ceq $u.SID.Value }).Count) { Stop-Host 'SERVICE_ACCOUNT_IS_AN_ADMINISTRATOR' $name }
  }
  $controllerSid = (Get-LocalUser -Name 'clued-control').SID.Value
  $prep = & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -ExecutionPolicy Bypass -File (Join-Path $R 'windows\prepare-companion-account.ps1') -LogDirectory (Join-Path $stage 'companion-log') -RegistrarSha256 (Sha256File (Join-Path $R 'windows\CompanionTaskRegistrar.cs')) | Out-String
  $pr = try { $js.DeserializeObject($prep) } catch { $null }
  if ([string](Get-Key $pr 'status') -notlike 'COMPANION_ACCOUNT_PREPARED*') { Stop-Host 'COMPANION_ACCOUNT_NOT_PREPARED' $prep }
  $companionSid = [string](Get-Key (Get-Key $pr 'nodeProfile') 'ownerSid'); $companionProfile = [string](Get-Key (Get-Key $pr 'nodeProfile') 'ownerProfileDirectory')
  $nodeProfile = try { Get-NodeProfile ([Environment]::MachineName) $controllerSid $companionSid $companionProfile } catch { Stop-Host ([string]$_.Exception.Message) 'rename the machine to a name of 1-15 letters, digits and inner hyphens; no parameter changes it' }
  if ($operator -ceq $companionSid -or $operator -ceq $controllerSid) { Stop-Host 'OPERATOR_IS_A_SERVICE_ACCOUNT' $operator }
  # clued-control's right to log on as a service (install-resident.ps1 Test-ServiceLogonRight requires it)
  $rights = Join-Path $stage 'rights'; $null = New-Dir $rights (Get-AdminOnlySddl)
  $null = & secedit.exe /export /areas USER_RIGHTS /cfg (Join-Path $rights 'now.inf')
  $now = [IO.File]::ReadAllText((Join-Path $rights 'now.inf'))
  if ($now -notmatch ('(?m)^SeServiceLogonRight\s*=.*\*' + [regex]::Escape($controllerSid) + '\b') -and $now -notmatch '(?m)^SeServiceLogonRight\s*=.*\bclued-control\b') {
    $line = if ($now -match '(?m)^SeServiceLogonRight\s*=\s*(.*)$') { 'SeServiceLogonRight = ' + $Matches[1].Trim() + ',*' + $controllerSid } else { 'SeServiceLogonRight = *' + $controllerSid }
    [IO.File]::WriteAllText((Join-Path $rights 'add.inf'), "[Unicode]`r`nUnicode=yes`r`n[Version]`r`nsignature=`"`$CHICAGO`$`"`r`nRevision=1`r`n[Privilege Rights]`r`n$line`r`n", [Text.Encoding]::Unicode)
    $null = & secedit.exe /configure /db (Join-Path $rights 'add.sdb') /cfg (Join-Path $rights 'add.inf') /areas USER_RIGHTS
    if ($LASTEXITCODE -ne 0) { Stop-Host 'SERVICE_LOGON_RIGHT_NOT_GRANTED' $LASTEXITCODE }
  }
  Step 'accounts' ([ordered]@{ controllerSid = $controllerSid; companionSid = $companionSid; operatorSid = $operator })
  # CI root, formal-spool, first-install, credentials
  $ci = [ordered]@{}
  $ci[$CiRoot] = New-Dir $CiRoot (Get-CiRootSddl $operator $controllerSid)
  $ci['formal-spool'] = New-Dir (Join-Path $CiRoot 'formal-spool') (Get-CiRootSddl $operator $controllerSid)
  $ci['first-install'] = New-Dir $FirstDir (Get-FirstInstallSddl $operator)
  $ci['credentials'] = New-Dir $CredDir (Get-AdminOnlySddl)
  $ci['secrets'] = New-Dir (Split-Path -Parent $SecretTargets['ciToken']) (Get-SecretDirectorySddl $controllerSid)
  Step 'ci-root' $ci
  # the carrier runner: binaries and a stopped, manual service as .\clued-control; never registered with GitHub
  $runnerDir = Join-Path $ControlRoot 'runner'
  $controlSddl = 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $controllerSid + ')'
  $null = New-Dir $ControlRoot $controlSddl
  $null = New-Dir (Split-Path -Parent $SecretTargets['appKey']) (Get-SecretDirectorySddl $controllerSid)
  if (-not [IO.File]::Exists((Join-Path $runnerDir 'bin\RunnerService.exe'))) { Expand-Archive -LiteralPath $staged['actions-runner'] -DestinationPath $runnerDir }
  $svc = Get-Service -Name $nodeProfile.runnerService -ErrorAction SilentlyContinue
  if ($null -eq $svc) {
    # one new random password for the account and the service at once (CreateService keeps the binary path verbatim, quotes included)
    $sec = ConvertTo-Secure (New-RandomPassword)
    Set-LocalUser -Name 'clued-control' -Password $sec
    $null = New-Service -Name $nodeProfile.runnerService -BinaryPathName $OriginalBinary -StartupType Manual -Credential (New-Object Management.Automation.PSCredential('.\clued-control', $sec))
  }
  $qc = & $Sc qc $nodeProfile.runnerService | Out-String; $q = & $Sc queryex $nodeProfile.runnerService | Out-String
  $bin = if ($qc -match 'BINARY_PATH_NAME\s*:\s*(.+)') { $Matches[1].Trim() } else { $null }
  if ($bin -cne $OriginalBinary -or $qc -notmatch 'START_TYPE\s*:\s*3\s' -or $qc -notmatch 'SERVICE_START_NAME\s*:\s*\.\\clued-control' -or $q -notmatch 'STATE\s*:\s*1\s') { Stop-Host 'RUNNER_SERVICE_NOT_AS_THE_INSTALLER_EXPECTS' $qc }
  Step 'runner' $nodeProfile.runnerService
  # the distribution (see the NOTE above: the operator's WSL until the M5-b switch)
  $listed = (Invoke-Wsl @('--list', '--quiet')).stdout -replace "`0", ''
  if (@($listed -split "`r?`n" | Where-Object { $_.Trim() -ceq $Distribution }).Count -eq 0) {
    if ([IO.Directory]::Exists($VhdxDirectory) -and @(Get-ChildItem -LiteralPath $VhdxDirectory -Force).Count) { Stop-Host 'VHDX_DIRECTORY_NOT_EMPTY' $VhdxDirectory }
    $null = New-Dir (Split-Path -Parent $VhdxDirectory) ('O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $operator + ')')
    $null = New-Dir $VhdxDirectory ('O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $operator + ')')
    $imp = Invoke-Wsl @('--import', $Distribution, $VhdxDirectory, $staged['ubuntu-rootfs'], '--version', '2')
    if ($imp.exit -ne 0) { Stop-Host 'DISTRIBUTION_IMPORT_FAILED' ($imp.stderr -replace "`0", '') }
  }
  Step 'distribution' ([ordered]@{ name = $Distribution; vhdxDirectory = $VhdxDirectory; account = 'operator' })
  # Linux, as root
  $hp = $null
  foreach ($attempt in 1..2) {
    $hp = Invoke-Root (To-WslPath (Join-Path $R 'linux\first-host-prep.sh')) @((To-WslPath (Join-Path $stage 'apt-pins.txt')), (To-WslPath $staged['linux-node']), $toolchainSha)
    if ($hp.exit -eq 2 -and $attempt -eq 1) { $null = Invoke-Wsl @('--terminate', $Distribution); continue }   # systemd just enabled: this distribution only, never --shutdown
    break
  }
  if ($hp.exit -ne 0 -or $hp.stdout -notmatch '"status":"LINUX_HOST_READY"') { Stop-Host 'LINUX_HOST_NOT_READY' ($hp.stdout.Trim()) }
  $mk = Invoke-Root (To-WslPath (Join-Path $R 'reinstall\linux\tools\make-result-key.sh')) @()
  if ($mk.exit -ne 0 -and $mk.stdout -notmatch 'KEY_EXISTS_PRESERVE') { Stop-Host 'RESULT_KEY_NOT_MADE' ($mk.stdout.Trim()) }
  $ff = Invoke-Root (To-WslPath (Join-Path $R 'reinstall\linux\tools\first-install-facts.py')) @() '/usr/bin/python3.12'
  $lf = try { $js.DeserializeObject($ff.stdout) } catch { $null }
  $lc = Test-LinuxFirstInstallFacts $lf $toolchainSha
  if ($ff.exit -ne 0 -or $lc.Count) { Stop-Host 'LINUX_NOT_A_FIRST_INSTALL_HOST' $lc }
  $pem = ([string]$lf['resultPublicKey']['pem']).Replace("`r`n", "`n")
  $keyDay = [DateTime]::UtcNow
  Step 'linux' 'ready'
  # credentials: the directory given (admin-only, fixed names) or the Windows dialogs; each fingerprinted at once
  $secrets = [ordered]@{}; $public = $null
  if ($CredentialDirectory) {
    if (-not (Test-SddlIs (Get-Acl -LiteralPath $CredentialDirectory).Sddl (Get-AdminOnlySddl))) { Stop-Host 'CREDENTIAL_DIRECTORY_NOT_ADMIN_ONLY' $CredentialDirectory }
    foreach ($k in @('appPrivateKey', 'ciAdmissionToken', 'upgradeToken', 'heartbeatToken')) { $f = Join-Path $CredentialDirectory $CredentialFiles[$k]; if ([IO.File]::Exists($f)) { $secrets[$k] = [IO.File]::ReadAllBytes($f) } }
    $public = $js.DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes((Join-Path $CredentialDirectory $CredentialFiles['public']))))
  } else {
    $secrets['ciAdmissionToken'] = Read-TokenFromDialog 'ci-admission'
    $secrets['upgradeToken'] = Read-TokenFromDialog 'resident-upgrade'
    $hbBytes = Read-TokenFromDialog 'heartbeat (leave empty for none)'; if ($hbBytes.Length) { $secrets['heartbeatToken'] = $hbBytes }
    $secrets['appPrivateKey'] = Read-AppKeyFromDialog
    $public = [ordered]@{ appKeyId = (Read-PublicFromDialog 'GitHub App key id (a number, shown next to the key on the App page)'); ciPrincipalBindingId = (Read-PublicFromDialog 'CI connection id (UUID, /oauth/connections)')
      ciPrincipalRoleRef = (Read-PublicFromDialog 'ciPrincipalRoleRef (Decision UUID)'); ciPrincipalQualificationRef = (Read-PublicFromDialog 'ciPrincipalQualificationRef (UUID)')
      heartbeatBindingId = $(if ($secrets.Contains('heartbeatToken')) { Read-PublicFromDialog 'heartbeat connection id (UUID, or empty)' } else { '' }) }
  }
  foreach ($k in @('appPrivateKey', 'ciAdmissionToken', 'upgradeToken')) { if (-not $secrets.Contains($k)) { Stop-Host 'CREDENTIAL_MISSING' $k } }
  $appFp = Get-SecretFingerprint $secrets['appPrivateKey'] 'app-key'; $ciFp = Get-SecretFingerprint $secrets['ciAdmissionToken'] 'ci-token'
  $upFp = Get-TokenFingerprint $secrets['upgradeToken'] 'ci-token'; $hbFp = if ($secrets.Contains('heartbeatToken')) { Get-TokenFingerprint $secrets['heartbeatToken'] 'heartbeat-token' } else { $null }
  if (-not $appFp -or -not $ciFp -or -not $upFp -or ($secrets.Contains('heartbeatToken') -and -not $hbFp)) { Stop-Host 'CREDENTIAL_NOT_ITS_KIND' ([ordered]@{ app = [bool]$appFp; ci = [bool]$ciFp; upgrade = [bool]$upFp; heartbeat = $(if ($secrets.Contains('heartbeatToken')) { [bool]$hbFp } else { $null }) }) }
  # the App key and the ci-admission token at the installer's targets: create-only with its secret ACL; found there, the same fingerprint
  foreach ($spec in @(@('appPrivateKey', 'appKey', 'app-key', $appFp), @('ciAdmissionToken', 'ciToken', 'ci-token', $ciFp))) {
    $target = $SecretTargets[$spec[1]]
    if ([IO.File]::Exists($target)) {
      $item = Get-Item -LiteralPath $target -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Stop-Host 'SECRET_TARGET_IS_A_LINK' $target }
      if (-not (Test-SddlIs (Get-Acl -LiteralPath $target).Sddl (Get-SecretFileSddl $controllerSid))) { Stop-Host 'SECRET_TARGET_ACL_NOT_THE_INSTALLERS' $target }
      $have = [IO.File]::ReadAllBytes($target)
      try { $haveFp = Get-SecretFingerprint $have $spec[2] } finally { [Array]::Clear($have, 0, $have.Length) }
      if ($haveFp -cne $spec[3]) { Stop-Host 'SECRET_ALREADY_PLACED_IS_ANOTHER' $target }
    } else { Write-CreateOnly $target $secrets[$spec[0]] (Get-SecretFileSddl $controllerSid) }
    [Array]::Clear($secrets[$spec[0]], 0, $secrets[$spec[0]].Length); $secrets.Remove($spec[0])
  }
  # the two connection tokens the launcher gives the installer
  foreach ($k in @($secrets.Keys)) {
    $target = Join-Path $CredDir $CredentialFiles[$k]
    if ([IO.File]::Exists($target)) { if ((Sha256File $target) -cne (& { $s = [Security.Cryptography.SHA256]::Create(); try { -join ($s.ComputeHash($secrets[$k]) | ForEach-Object { $_.ToString('x2') }) } finally { $s.Dispose() } })) { Stop-Host 'CREDENTIAL_ALREADY_PLACED_DIFFERS' $k } }
    else { Write-CreateOnly $target $secrets[$k] (Get-AdminOnlySddl) }
    [Array]::Clear($secrets[$k], 0, $secrets[$k].Length)
  }
  $appKeyId = 0L; if (-not [long]::TryParse([string](Get-Key $public 'appKeyId'), [ref]$appKeyId)) { Stop-Host 'APP_KEY_ID_NOT_A_NUMBER' $null }
  $hbId = [string](Get-Key $public 'heartbeatBindingId'); if ($hbId -ceq '') { $hbId = $null }
  Step 'credentials' 'placed and fingerprinted'
  # facts and the companion WSL record, create-only
  $nodeRecord = [ordered]@{ appKeyId = $appKeyId; appPublicKeySha256Base64 = $appFp; ciPrincipalBindingId = [string](Get-Key $public 'ciPrincipalBindingId')
    ciPrincipalQualificationRef = [string](Get-Key $public 'ciPrincipalQualificationRef'); ciPrincipalRoleRef = [string](Get-Key $public 'ciPrincipalRoleRef'); ciTokenPinSha256 = $ciFp }
  $cred = [ordered]@{ heartbeatToken = $(if ($hbFp) { [ordered]@{ bindingId = $hbId; fingerprint = $hbFp } } else { $null }); upgradeToken = [ordered]@{ fingerprint = $upFp } }
  $sh = [Security.Cryptography.SHA256]::Create(); try { $pubSha = -join ($sh.ComputeHash([Text.Encoding]::ASCII.GetBytes($pem)) | ForEach-Object { $_.ToString('x2') }) } finally { $sh.Dispose() }
  $facts = New-FirstInstallFacts $nodeProfile $operator $VhdxDirectory $nodeRecord $cred (Get-Signer $nodeProfile $pem $keyDay) ([ordered]@{ resultPublicKeySha256 = $pubSha; toolchainNodeSha256 = $toolchainSha }) ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
  $fc = Test-FirstInstallFacts $facts
  if ($fc.Count) { Stop-Host 'FACTS_REFUSED' $fc }
  $factsFile = Join-Path $FirstDir 'facts.json'
  if ([IO.File]::Exists($factsFile)) {
    $old = $js.DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes($factsFile)))
    # a re-run keeps the signer's key day of the first run (the key is create-only: the same key)
    if ((Get-Key (Get-Key $old 'signer') 'publicKeyPem') -ceq $pem) { $facts.signer.keyId = [string]$old['signer']['keyId'] }
    if (-not (Test-SameFacts $old $facts)) { Stop-Host 'FACTS_ALREADY_WRITTEN_DIFFER' $factsFile }
  } else { Write-CreateOnly $factsFile ($Utf8.GetBytes($js.Serialize($facts) + "`n")) (Get-FirstInstallSddl $operator) }
  $cw = [ordered]@{ contract = 'clued.independent-ci.companion-wsl/1'; distro = $Distribution; target = ($VhdxDirectory + '\ext4.vhdx'); companionSid = $nodeProfile.ownerSid; stage = 'owner-imported'; imported = $true; importedBy = $operator }
  $cwFile = Join-Path $FirstDir 'companion-wsl.json'
  if ([IO.File]::Exists($cwFile)) { if ($Strict8.GetString([IO.File]::ReadAllBytes($cwFile)).Trim() -cne $js.Serialize($cw)) { Stop-Host 'COMPANION_WSL_RECORD_ALREADY_WRITTEN_DIFFERS' $cwFile } }
  else { Write-CreateOnly $cwFile ($Utf8.GetBytes($js.Serialize($cw) + "`n")) (Get-FirstInstallSddl $operator) }
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  ((New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize([ordered]@{ status = 'FIRST_INSTALL_HOST_READY'; facts = $factsFile; factsSha256 = (Sha256File $factsFile); node = $nodeProfile.nodeName }))
}

$script:NodeExe = $null; $script:FingerprintTool = $null
if ($MyInvocation.InvocationName -ne '.') { Invoke-HostPreparation }
