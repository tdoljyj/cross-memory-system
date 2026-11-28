<#
.SYNOPSIS
  First install, P1: the host preparation of a NEW node, ELEVATED (the first install's one UAC before the package is assembled).
  Run by rollout/fleet/bootstrap.ps1 -Stage host only, from the copy of the accepted archive that the elevated process checked
  (sha256) and extracted itself into an admin-only directory; never with a node argument. Its pins (kit, toolchain node, registrar)
  are the output of install.mjs first-install-check, run before UAC on the accepted acceptance file (M2); nothing here recomputes them.

.DESCRIPTION
  Idempotent: each step that finds its result already there only checks it; the same command is run again after a stop or a restart.
  Writes C:\ProgramData\CluedIndependentCI\first-install\facts.json (clued.independent-ci.first-install-facts/1, public) and
  companion-wsl.json, the App private key and the ci-admission token at the installer's own targets with its secret ACL (as a
  reinstall finds them in place: the launcher never touches them), and the two connection tokens the installer is given
  (resident-upgrade, heartbeat) under first-install\credentials\ (SYSTEM and Administrators only; bootstrap.ps1 clears that folder on
  every end of the run, so a later run asks for those two tokens again and holds them to the fingerprints in facts.json).
  Steps (each prints one JSON line {step, result}; the last line is the verdict):
    execution-policy  Get-ExecutionPolicy -List, every scope in the step's detail; a group policy (MachinePolicy, UserPolicy) that
                   enforces Restricted or AllSigned is refused (HOST_EXECUTION_POLICY_ENFORCED_BY_POLICY): -ExecutionPolicy Bypass cannot win;
    operator       the elevated account must be the operator the bootstrap ran as (-ExpectedOperatorSid; M4), before anything else;
    residue        a first install needs a CLEAN machine. Refused by name (FIRST_INSTALL_RESIDUE_PRESENT): the three services, the
                   firewall rule, the companion task, the resident root, the resident service's ACE on the CI root (an uninstall leaves
                   it), resident-uninstalled-* kept roots, a ci-admission token at its target with no facts.json of this first install,
                   a CluedResident-Linux registered to the companion account (its hive read elevated; not readable is refused as
                   COMPANION_WSL_REGISTRATIONS_UNREADABLE, never taken as none) (M5). A node with a resident is reinstalled
                   (prepare finds its install receipt); leftovers of an uninstalled one are removed by a person first;
    execution-policy-baseline  (not with -Reset) the first write: LocalMachine's execution policy RemoteSigned when it is Undefined,
                   Restricted or AllSigned (RemoteSigned, Unrestricted, Bypass kept), the value the frozen Source runs under on every
                   node (Get-ExecutionPolicyBaseline); every scope before and after in the detail; then a probe started as
                   held-record.mjs starts its PowerShell must run (HOST_EXECUTION_POLICY_NOT_EFFECTIVE). Never put back by an uninstall;
    stage          a new admin-only directory under C:\Windows\Temp: the prerequisite manifest held to the sha256 the bootstrap pinned,
                   every prerequisite this step uses (node, rootfs, runner, the Linux toolchain node, the WSL package, the .debs)
                   copied in and held to the manifest's sha256 and size;
    v1-base        what the installer needs from Windows itself (Get-V1BaseCodes: .NET Framework 4 csc.exe, the LocalAccounts,
                   NetSecurity and ScheduledTasks modules, secedit) and cannot be added here: refused by name when missing;
    node-key-check the node's two identity keys (registration\export-node-registration.ps1, in the archive), read with that script's own
                   Find-MachineKey: one of them, the identity key not in the TPM, either not valid or not readable, or none and no
                   usable TPM, is refused (Get-NodeKeyPlan) before anything is installed;
    wsl            WSL itself at the pinned version (the manifest's wsl item): installed from the pinned MSI when `wsl --version` is
                   not that version (msiexec /i /qn /norestart), then `wsl --version` must name it (M7); a restart: exit 3;
    features       VirtualMachinePlatform (and Microsoft-Windows-Subsystem-Linux) enabled (/norestart); a needed restart:
                   RESTART_THEN_RUN_THE_SAME_COMMAND (exit 3); standby and hibernation off;
    accounts       .\clued-control and .\clued-runner (made when absent, random password nobody knows, not administrators), the
                   companion account by the package's own windows\prepare-companion-account.ps1 (-RegistrarSha256: the archive's pin,
                   L2); clued-control's right to log on as a service, and no deny-logon-as-a-service entry for it;
    node-key       neither key there: the packaged script's init-keys -ConfirmCreateKeys -KeyProvider tpm (non-exportable; the identity
                   key in the TPM, never in software; the encryption key in software, where the TPM provider leaves it), then both
                   must be found, the identity key in the TPM; both there: kept. -Reset never removes them;
    ci-root        C:\ProgramData\CluedIndependentCI and formal-spool with the baseline DACL the installer appends to, formal-spool\outgoing
                   and \incoming (the v1 one-shot table, the operator in the Owner's place), first-install\, first-install\credentials\,
                   the secrets folder (installer's Get-SecretDirectorySddl): Get-CiRootDirectories, one table;
    runner         the carrier runner binaries (actions-runner) at C:\ProgramData\CluedControl\runner and its service (RunnerService.exe,
                   Manual, Stopped, .\clued-control): never registered with GitHub. Expanded resumably (Expand-Verified, M5): into a new
                   directory, every file held to the pinned zip, renamed into place, then marked (CluedControl\runner.first-install-complete);
                   a runner directory without the mark (a cut-off run) is set aside, kept, and expanded again; a marked one is checked;
    distribution   CluedResident-Linux from the pinned Ubuntu image (wsl --install --from-file --location --no-launch) under the
                   operator, at C:\ProgramData\CluedIndependentCI\wsl-first-install\CluedResident-Linux; the switch's target
                   facts.companionWsl.vhdxDirectory (...\wsl\CluedResident-Linux) is never made here (filled, it is residue): the M5-b
                   switch MOVES the disk there (see the note below);
    linux          as root in it (wsl --exec: no shell between): linux/first-host-prep.sh (the pinned .debs by dpkg, systemd, docker
                   with the containerd image store, the toolchain node), make-result-key.sh (create-only), first-install-facts.py;
    credentials    H2: nothing is written before everything is in hand and checked. With facts.json there and every secret in place
                   with its recorded fingerprint: no dialog, only checked. With facts.json there and some secret missing: only those
                   are asked for, and each must have the recorded fingerprint. Without facts.json: -CredentialDirectory (only a directory
                   whose DACL is SYSTEM and Administrators alone, fixed file names) or the Windows dialogs (one credential box per
                   connection token, the system's Open dialog for the App key, one input box per public value). The facts draft is then
                   checked by install.mjs first-install-facts-check (the one rule, readFirstInstallFacts; M1) and only then, in this
                   order: facts.json (Write-NewFile: whole or not at all, create-only), the App key and the ci-admission token (create-only,
                   the installer's secret ACL; found there, the fingerprint must be this one), the two connection tokens, companion-wsl.json.
                   A run cut off in between leaves facts.json without some secrets, which the next run asks for (held to the recorded
                   fingerprints) and -Reset removes; never secrets without the facts that say whose they are (review M1). A re-run asks
                   for exactly what facts.json records and requires all of it (a recorded heartbeat token too: Get-MissingCredentials, L3).
  Every tool P1 starts (wsl, msiexec, dism, powercfg, secedit, reg, the companion account's script) runs through Invoke-Native, its
  stdout and stderr read apart: a line on stderr never ends P1 under Stop (review H1).
  -Reset (no resident on the host): removes what this host preparation made and nothing else: first-install\, the App key and the
  ci-admission token only where their fingerprints are the ones facts.json records, the distribution only when companion-wsl.json says
  this operator imported it (Get-ResetPlan). Prints FIRST_INSTALL_HOST_RESET with what it removed and what it kept.
  -StepProgress <file> (the CLUED-DRILL entry only; bootstrap.ps1 does not pass it): each step's start and end also appended to that file
  (the entry's stage-progress.jsonl), so a drill cut off mid-step says which step; stdout and the step lines are unchanged.

  The installer's needs on a new machine (install-resident.ps1 and its plan; the "v1 control base"), and where each comes from:
    CI root C:\ProgramData\CluedIndependentCI, protected, no other resident ACE (PARENT_ACL_*)       P1 ci-root (baseline DACL)
    secrets\ for the ci-admission token, CluedControl\trusted\ for the App key (*_TARGET_DIRECTORY_MISSING) P1 ci-root / runner
    the App key and the ci-admission token at their targets, fingerprints = the record                   P1 credentials
    runner service: original binary, Manual, Stopped (PID 0), .\clued-control (RUNNER_SERVICE_NOT_...)   P1 runner
    clued-control: local, not admin, log on as a service, not denied (CONTROLLER_SERVICE_LOGON_RIGHT_MISSING) P1 accounts
    the companion account: local, not admin (COMPANION_ACCOUNT_*)                                       P1 accounts (prepare-companion-account.ps1)
    machine name = the profile's hostname (NODE_HOST_REQUIRED); the elevated operator (OWNER_ACCOUNT_REQUIRED) P1 profile / operator
    .NET Framework 4 csc.exe (every compile step), LocalAccounts / NetSecurity / ScheduledTasks modules, secedit
                                                                                                        Windows itself: checked, not addable (v1-base)
    the firewall rule CluedCIResident-BlockOutbound absent (FIREWALL_RULE_EXISTS), no resident root/services P1 residue (refused, not removed)
    the CI resident's own trees, services, tasks, upgrader, generation 1                                 the installer itself
    a registered GitHub runner                                                                          not needed: the broker swaps the
                                                                                                        stopped service's binary only
                                                                                                        (SwapBroker stable digest = SCM config)
  NOTE, the distribution: the registrar (CompanionTaskRegistrar.cs root-run / register-account) works only for an INSTALLED resident.
  Before the first install no reviewed tool can run anything as root in a distribution registered to the companion account, so P1
  imports CluedResident-Linux to the operator's own WSL and first-install\companion-wsl.json (P1's own record, never install\) says
  stage "owner-imported" with the import's ext4.vhdx; the first-install plan runs Linux A/B as the operator (companionAccount false)
  and the existing switch (rearm-resident.ps1 -CompanionAccount -WslVhdxDirectory <facts.companionWsl.vhdxDirectory>, the launcher's
  Step-CompanionHeadless) moves it to the companion account and writes install\companion-wsl.json itself.
#>
param([string]$Tree, [string]$PrereqDirectory, [string]$PrereqManifest, [string]$PrereqManifestSha256, [string]$KitSha256, [string]$ToolchainNodeSha256,
  [string]$RegistrarSha256, [string]$ExpectedOperatorSid, [string]$CredentialDirectory, [string]$Kit, [switch]$Reset, [string]$StepProgress,
  [string]$PreservedConnectionFile, [string]$PreservedCarrierDirectory, [string]$PreservedNodeExe, [switch]$CheckPreservedConnection,
  [string]$BootstrapNodeExe, [string]$BootstrapRunnerDirectory)
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
$VhdxDirectory = 'C:\ProgramData\CluedIndependentCI\wsl\CluedResident-Linux'   # facts.companionWsl.vhdxDirectory: where the M5-b switch moves it
# where P1 imports it (the operator's, until the switch): never the switch's target itself, which would make its plan 'forget' (no move,
# no Set-CompanionVhdxAcl) instead of the move DESK-W-591 took (companion-headless.ps1 Get-CompanionWslMovePlan)
$ImportDirectory = 'C:\ProgramData\CluedIndependentCI\wsl-first-install\CluedResident-Linux'
$CompanionAccountName = 'clued-companion'
$Wsl = 'C:\Windows\System32\wsl.exe'
$Sc = 'C:\Windows\System32\sc.exe'
$PowerShellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
# Where Windows PowerShell reads the LocalMachine execution policy (value ExecutionPolicy, REG_SZ; 64-bit view): the baseline's one place
$ExecutionPolicyKey = 'SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell'
$FactsContract = 'clued.independent-ci.first-install-facts/1'
# install-resident.ps1 $SecretTargets: placed here, never passed to the installer (a reinstall finds them in place the same way)
$SecretTargets = [ordered]@{ appKey = 'C:\ProgramData\CluedControl\trusted\controller-checks-app.pem'; ciToken = 'C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token' }
# The credentials a first install takes, and -CredentialDirectory's fixed input names, are data: windows\credential-files.json next to
# this script, in the archive under its hash ("credential list source"; contract clued.independent-ci.credential-files/1): required (a
# run without one stops in the credentials step: CREDENTIAL_MISSING) and optional (a first run without one records none). P1 reads it
# first (Read-CredentialFiles into $script:CredentialList: required, optional, files = both); every "missing: stop or not" reads that
# and nothing else, and this script names no credential file. Only upgradeToken and heartbeatToken are placed under
# first-install\credentials\; companionToken goes to the companion's own gh configuration.
$CredentialFilesContract = 'clued.independent-ci.credential-files/1'
# The secrets facts.json records (by fingerprint); whether each is required is the data's.
$FactsSecrets = @('appKey', 'ciToken', 'upgradeToken', 'heartbeatToken')
# Git for Windows where the companion expects it (the three places that name it: install-resident.ps1 and companion-headless.ps1
# Get-CompanionPathDirs, companion-gh-login.ps1 $Git; not refactored here, a defect is registered). gh's path is the kit's companion
# configuration's ghExe (the one source; Get-KitGhExe).
$GitExe = 'C:\Program Files\Git\cmd\git.exe'
$Utf8 = New-Object Text.UTF8Encoding($false)
$Strict8 = New-Object Text.UTF8Encoding($false, $true)

# ------------------------------------------------------------------ pure functions (test-first-install-host.ps1 runs them)
function Get-Key($d, [string]$k) { if ($d -is [Collections.IDictionary] -and ([Collections.IDictionary]$d).Contains($k)) { $d[$k] } else { $null } }
function Get-Rid([string]$sid) { if ($sid -cmatch '^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-(\d{1,10})$') { [long]$Matches[1] } else { $null } }
# M4: the elevated account must be the one the bootstrap ran as.
function Test-ExpectedOperator([string]$actualSid, [string]$expectedSid) {
  if ($expectedSid -cnotmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { return 'EXPECTED_OPERATOR_SID_REQUIRED' }
  if ($actualSid -cne $expectedSid) { return 'ELEVATED_ACCOUNT_IS_NOT_THE_OPERATOR' }
  $null
}
# The node profile (clued.independent-ci.node-profile/1) from this machine's name and the three accounts. Throws HOSTNAME_NOT_A_NODE_NAME
# (a machine name that cannot be one: rename the machine) or NODE_PROFILE_INVALID. install.mjs readFirstInstallFacts and prepare-record.mjs
# validateNodeProfile hold the result to the rule (first-install-facts-check).
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
# The node's signer by the convention: keyId <nodeName>-first-run-<yyyymmdd> (UTC day of the key), runtimeId
# <HOSTNAME>-cluedresident-independent-ci-v1, the Ed25519 public key PEM make-result-key.sh made.
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
# The ci-root step's directories, in the order they are made: name (the step's detail key) -> @(path, SDDL). The one table the step
# makes them from (test/first-install-r5-defects.test.mjs builds its fixture from it).
# formal-spool\outgoing and \incoming (r5, Fable 11-21 section 1.1: drill r4 stopped in the launcher's spool inventory without them): the
# v1 one-shot install's fixed table (invoke-functions.ps1 New-FixedSecurity: outgoing = Spool, incoming = Results; controller and Owner
# modify or read and execute), the operator in the Owner's place. The installer then moves the operator's write entries to the companion
# account (install-resident.ps1 Set-CompanionSpoolAcl), as on the nodes the one-shot install made: the same end state, entry for entry.
# Source v2's migrate-acl.ps1 appends the resident's entries to formal-spool and these two (acl-model.json add).
function Get-CiRootDirectories([string]$operatorSid, [string]$controllerSid) {
  [ordered]@{
    $CiRoot = @($CiRoot, (Get-CiRootSddl $operatorSid $controllerSid))
    'formal-spool' = @((Join-Path $CiRoot 'formal-spool'), (Get-CiRootSddl $operatorSid $controllerSid))
    'formal-spool\outgoing' = @((Join-Path $CiRoot 'formal-spool\outgoing'), ('O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $controllerSid + ')(A;OICI;0x1200a9;;;' + $operatorSid + ')'))
    'formal-spool\incoming' = @((Join-Path $CiRoot 'formal-spool\incoming'), ('O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $controllerSid + ')(A;OICI;0x1301bf;;;' + $operatorSid + ')'))
    'first-install' = @($FirstDir, (Get-FirstInstallSddl $operatorSid))
    'credentials' = @($CredDir, (Get-AdminOnlySddl))
    'secrets' = @((Split-Path -Parent $SecretTargets['ciToken']), (Get-SecretDirectorySddl $controllerSid))
  }
}
# r5 (Fable 11-21 section 1.2): every PowerShell this package starts carries -ExecutionPolicy Bypass, which sets the process scope; a
# group policy (MachinePolicy, UserPolicy) outranks the process scope. One that enforces Restricted or AllSigned is refused by name before
# anything is written. $list: Get-ExecutionPolicy -List (Scope, ExecutionPolicy); scopes: every scope's value as read (the step's detail).
function Get-ExecutionPolicyCheck($list) {
  $scopes = [ordered]@{}
  foreach ($e in @($list)) { $scopes[[string]$e.Scope] = [string]$e.ExecutionPolicy }
  $enforced = @(@('MachinePolicy', 'UserPolicy') | Where-Object { $scopes.Contains($_) -and @('Restricted', 'AllSigned') -ccontains $scopes[$_] })
  [ordered]@{ scopes = $scopes; code = $(if ($enforced.Count) { 'HOST_EXECUTION_POLICY_ENFORCED_BY_POLICY' } else { $null }) }
}
# r5 (Fable 11-21 "r5 preflight gaps" section 3.2): the frozen Source starts Windows PowerShell with its own environment and no
# -ExecutionPolicy (held-record.mjs on every stage entry, and eight more; their bytes are pinned by ciSourceManifestSha256), so the
# machine's policy decides for them. The nodes run LocalMachine RemoteSigned, the value the Source was accepted and runs under; the host
# preparation provides it: Undefined, Restricted and AllSigned are set to RemoteSigned; RemoteSigned, Unrestricted and Bypass are left as
# they are; a group policy that enforces Restricted or AllSigned is refused (Get-ExecutionPolicyCheck); any other value is refused by name
# (HOST_EXECUTION_POLICY_UNRECOGNIZED). An uninstall never puts the old value back. $list: Get-ExecutionPolicy -List.
function Get-ExecutionPolicyBaseline($list) {
  $c = Get-ExecutionPolicyCheck $list
  $lm = if ($c.scopes.Contains('LocalMachine')) { [string]$c.scopes['LocalMachine'] } else { $null }
  $action = $null; $code = $c.code
  if (-not $code) {
    if (@('RemoteSigned', 'Unrestricted', 'Bypass') -ccontains $lm) { $action = 'keep' }
    elseif (@('Undefined', 'Restricted', 'AllSigned') -ccontains $lm) { $action = 'set' }
    else { $code = 'HOST_EXECUTION_POLICY_UNRECOGNIZED' }
  }
  [ordered]@{ scopes = $c.scopes; localMachine = $lm; action = $action; code = $code }
}
# The probe that proves the baseline is started as held-record.mjs starts hold-record.ps1 (test/first-install-r5-host-prep.test.mjs reads
# that start from held-record.mjs itself): 64-bit Windows PowerShell 5.1 by its path, the same options before the script and no
# -ExecutionPolicy (on purpose: the frozen start has none; the structure scan, test/ps-execution-policy.test.mjs, has to list this one line
# as its exception), only its seven variables
# (its state temp directory in HOME, USERPROFILE, TEMP and TMP; here the probe's own directory). Whatever decides for the frozen Source
# decides for the probe, and nothing of this elevated process (its process scope, PSExecutionPolicyPreference) reaches it.
function Get-PolicyProbeStart([string]$powershell, [string]$probe, [string]$temp) {
  [ordered]@{ file = $powershell; arguments = @('-NoProfile', '-NonInteractive', '-File', $probe)
    environment = [ordered]@{ SystemRoot = 'C:\Windows'; WINDIR = 'C:\Windows'; PATH = 'C:\Windows\System32;C:\Windows'; HOME = $temp; USERPROFILE = $temp; TEMP = $temp; TMP = $temp } }
}
# The probe ran (exit 0, nothing on stderr: held-record.mjs takes any stderr as a failure) and printed its one line with the policy in
# effect for it; anything else is HOST_EXECUTION_POLICY_NOT_EFFECTIVE. $run: Invoke-PolicyProbe's answer.
function Get-PolicyProbeResult($run) {
  $out = ([string](Get-Key $run 'stdout')).Trim()
  if ((Get-Key $run 'timedOut') -ne $true -and (Get-Key $run 'exit') -eq 0 -and ([string](Get-Key $run 'stderr')).Trim() -ceq '' -and $out -cmatch '\ACLUED_EXECUTION_POLICY_PROBE ([A-Za-z]+)\z') {
    return [ordered]@{ code = $null; effective = $Matches[1] }
  }
  [ordered]@{ code = 'HOST_EXECUTION_POLICY_NOT_EFFECTIVE'; effective = $null }
}
# N7 (Fable 11-21 "r5 preflight gaps" section 2.2, as "r5 node key" 3.2 corrects it): what the key step does with the node's two keys as
# Get-NodeKeyObservation found them (each $null: absent, 'unreadable', or {origin, valid}; tpmUsable). Both valid, the identity key in the
# TPM: present (kept). Neither: create, only with a usable TPM (-KeyProvider tpm: the identity key never in software; M5 accepts only a
# TPM identity key), else HOST_TPM_NOT_USABLE. One of them (HOST_NODE_KEY_INCOMPLETE), the identity key not in the TPM
# (HOST_NODE_KEY_NOT_TPM), either not valid (HOST_NODE_KEY_INVALID) or not readable (HOST_NODE_KEY_UNREADABLE): refused; init-keys never
# replaces a key, and nothing here deletes one. The encryption key's provider is not judged: the TPM provider makes no key-agreement key
# (NTE_NOT_SUPPORTED), so init-keys puts it in software, as on both nodes in service.
function Get-NodeKeyPlan($observed) {
  $i = Get-Key $observed 'identity'; $e = Get-Key $observed 'encryption'
  $refuse = { param($c) [ordered]@{ action = $null; code = $c } }
  if ($i -is [string] -or $e -is [string]) { return (& $refuse 'HOST_NODE_KEY_UNREADABLE') }
  if ($null -eq $i -and $null -eq $e) { if ((Get-Key $observed 'tpmUsable') -eq $true) { return [ordered]@{ action = 'create'; code = $null } } else { return (& $refuse 'HOST_TPM_NOT_USABLE') } }
  if ($null -eq $i -or $null -eq $e) { return (& $refuse 'HOST_NODE_KEY_INCOMPLETE') }
  if ([string](Get-Key $i 'origin') -cne 'tpm') { return (& $refuse 'HOST_NODE_KEY_NOT_TPM') }
  foreach ($k in @($i, $e)) { if ((Get-Key $k 'valid') -ne $true) { return (& $refuse 'HOST_NODE_KEY_INVALID') } }
  [ordered]@{ action = 'present'; code = $null }
}
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
# A service's SID as Windows derives it (S-1-5-80- and the SHA-1 of the upper-case name in UTF-16LE as five 32-bit words; what
# `sc.exe showsid` prints): known whether or not the service exists, so an uninstall's leftover ACE on the CI root is found.
function Get-ServiceSid([string]$serviceName) {
  $s = [Security.Cryptography.SHA1]::Create()
  try { $h = $s.ComputeHash([Text.Encoding]::Unicode.GetBytes($serviceName.ToUpperInvariant())) } finally { $s.Dispose() }
  'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($h, $_ * 4) }) -join '-')
}
function Test-CiRootHasResidentAce([string]$sddl, [string]$serviceSid) {
  try { $d = New-Object Security.AccessControl.RawSecurityDescriptor($sddl) } catch { return $false }
  @($d.DiscretionaryAcl | Where-Object { $_.SecurityIdentifier.Value -ceq $serviceSid }).Count -gt 0
}
# What of a Clued resident is on this host: the codes, each naming what was found (M5). $observed: services, firewallRule,
# companionTask, residentRoot, residentAce, keptRoots, ciTokenWithoutFacts, companionDistribution ('no-account', 'absent', 'present',
# 'unknown': the companion's registrations could not be read, which is never taken as none).
function Get-ResidueCodes($observed) {
  $codes = @()
  foreach ($s in @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader')) { if (@($observed.services) -ccontains $s) { $codes += ('SERVICE:' + $s) } }
  if ($observed.firewallRule) { $codes += 'FIREWALL_RULE:CluedCIResident-BlockOutbound' }
  if ($observed.companionTask) { $codes += 'SCHEDULED_TASK:\Clued\CluedCIResidentCompanion' }
  if ($observed.residentRoot) { $codes += ('DIRECTORY:' + $ResidentRoot) }
  if ((Get-Key $observed 'residentAce') -eq $true) { $codes += 'CI_ROOT_RESIDENT_ACE:CluedCIResident' }
  foreach ($k in @(Get-Key $observed 'keptRoots' | Where-Object { $_ })) { $codes += ('KEPT_ROOT:' + $k) }
  if ((Get-Key $observed 'vhdxTargetNotEmpty') -eq $true) { $codes += ('DIRECTORY_NOT_EMPTY:' + $VhdxDirectory) }
  if ((Get-Key $observed 'ciTokenWithoutFacts') -eq $true) { $codes += ('SECRET_NOT_PLACED_BY_THIS_FIRST_INSTALL:' + $SecretTargets['ciToken']) }
  switch ([string](Get-Key $observed 'companionDistribution')) {
    'present' { $codes += ('WSL_DISTRIBUTION_OF_THE_COMPANION:' + $Distribution) }
    'unknown' { $codes += 'COMPANION_WSL_REGISTRATIONS_UNREADABLE' }
  }
  , @($codes)
}
# The version `wsl.exe --version` prints on its first line (any language; UTF-16 noise removed); $null for the inbox wsl.exe (usage).
function Get-WslVersion([string]$output) {
  if ($null -eq $output) { return $null }
  $first = @(($output -replace "`0", '') -split "`r?`n" | Where-Object { $_.Trim() })
  if ($first.Count -eq 0) { return $null }
  if ($first[0] -cmatch '^WSL[^\d]*(\d+\.\d+\.\d+\.\d+)\s*$') { $Matches[1] } else { $null }
}
# H2: what the credentials step does. $state: appKey, ciToken, upgradeToken, heartbeatToken each 'match' (in place, the fingerprint
# facts.json records), 'differs', 'missing', or 'none' (facts.json records no heartbeat token).
function Get-CredentialPlan([bool]$factsPresent, $state) {
  if (-not $factsPresent) { return [ordered]@{ mode = 'collect-all'; ask = @('appKey', 'ciToken', 'upgradeToken', 'heartbeatToken'); code = $null } }
  foreach ($k in @('appKey', 'ciToken', 'upgradeToken', 'heartbeatToken')) { if ([string]$state[$k] -ceq 'differs') { return [ordered]@{ mode = 'refused'; ask = @(); code = ('SECRET_IN_PLACE_IS_NOT_THE_FACTS:' + $k) } } }
  $missing = @(@('appKey', 'ciToken', 'upgradeToken', 'heartbeatToken') | Where-Object { [string]$state[$_] -ceq 'missing' })
  if ($missing.Count -eq 0) { [ordered]@{ mode = 'verify-only'; ask = @(); code = $null } } else { [ordered]@{ mode = 'ask-missing'; ask = $missing; code = $null } }
}
# H2: -Reset removes what this host preparation made and nothing else, and only with no resident on the host.
function Get-ResetPlan($st) {
  if (@($st.resident).Count) { return [ordered]@{ code = 'RESET_REFUSED_RESIDENT_PRESENT'; actions = @(); kept = @($st.resident) } }
  $actions = @(); $kept = @()
  if ($st.factsPresent) {
    foreach ($p in @(@('appKey', 'remove-app-key', 'app-key-not-this-first-installs'), @('ciToken', 'remove-ci-token', 'ci-token-not-this-first-installs'))) {
      switch ([string]$st[$p[0]]) { 'match' { $actions += $p[1] } 'differs' { $kept += $p[2] } }
    }
    $cw = $st.companionWsl
    if ($null -ne $cw -and [string](Get-Key $cw 'stage') -ceq 'owner-imported' -and [string](Get-Key $cw 'importedBy') -ceq $st.operator) {
      if ($st.distributionRegistered) { $actions += 'unregister-distribution' }
      $actions += 'remove-import-directory'
    } elseif ($null -ne $cw) { $kept += 'distribution-not-this-operators' }
  } else { $kept += 'secrets-without-facts-unknown-owner' }
  $actions += 'remove-first-install-directory'
  [ordered]@{ code = $null; actions = $actions; kept = $kept }
}
# A secedit USER_RIGHTS export that denies $sid the right to log on as a service (install-resident.ps1 counts the deny over the grant).
function Test-DenyServiceLogon([string]$inf, [string]$sid) {
  foreach ($line in ($inf -split "`r?`n")) { if ($line -match '^\s*SeDenyServiceLogonRight\s*=\s*(.*)$' -and @($Matches[1].Split(',') | ForEach-Object { $_.Trim() }) -ccontains ('*' + $sid)) { return $true } }
  $false
}
# What the installer needs from Windows itself and P1 cannot add: the codes.
function Get-V1BaseCodes($o) { , @(@('csc', 'localAccounts', 'netSecurity', 'scheduledTasks', 'secedit') | Where-Object { (Get-Key $o $_) -ne $true } | ForEach-Object { 'V1_BASE_MISSING:' + $_ }) }
# The .deb list linux/first-host-prep.sh checks with sha256sum -c before dpkg sees a file.
function Get-DebListText($debs) {
  $t = ''
  foreach ($d in @($debs)) {
    $n = [string](Get-Key $d 'fileName'); $h = [string](Get-Key $d 'sha256')
    if ($n -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}\.deb$' -or $h -cnotmatch '^[0-9a-f]{64}$') { throw ('DEB_LIST_REFUSED:' + $n) }
    $t += $h + '  ' + $n + "`n"
  }
  $t
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
# The facts document (the contract; install.mjs readFirstInstallFacts is its one check, run through Invoke-FactsCheck).
function New-FirstInstallFacts($nodeProfile, [string]$operatorSid, [string]$vhdxDirectory, $nodeRecord, $credentials, $signer, $linuxHost, [string]$observedAt) {
  [ordered]@{ contract = $FactsContract; observedAt = $observedAt; node = $nodeProfile; operatorSid = $operatorSid
    companionWsl = [ordered]@{ distribution = $nodeProfile.wslDistribution; vhdxDirectory = $vhdxDirectory }
    nodeRecord = $nodeRecord; credentials = $credentials; signer = $signer; linuxHost = $linuxHost }
}
# Two facts documents are the same install when everything but observedAt is equal (a re-run finds its own facts).
function Test-SameFacts($a, $b) {
  $strip = { param($d) $o = [ordered]@{}; foreach ($k in @($d.Keys | Sort-Object)) { if ($k -cne 'observedAt') { $o[$k] = $d[$k] } }; $o }
  $canon = { param($v) if ($v -is [Collections.IDictionary]) { $o = [ordered]@{}; foreach ($k in @($v.Keys | Sort-Object)) { $o[$k] = & $canon $v[$k] }; $o } else { $v } }
  (ConvertTo-JsonLine (& $canon (& $strip $a))) -ceq (ConvertTo-JsonLine (& $canon (& $strip $b)))
}
# The Linux facts first-install-facts.py printed, as P1 needs them: the codes when this is not a host the first install can use.
# $ownKeyPem: facts.json's signer key, when this first install wrote it already: its own Linux CI (a stopped launch) is not refused.
function Test-LinuxFirstInstallFacts($lf, [string]$toolchainSha, [string]$ownKeyPem = $null) {
  $c = @()
  if ((Get-Key $lf 'contract') -cne 'clued.independent-ci.linux-first-install-facts/1' -or (Get-Key $lf 'root') -ne $true) { return , @('LINUX_FACTS_SHAPE') }
  $tn = Get-Key $lf 'toolchainNode'; $pk = Get-Key $lf 'resultPublicKey'; $k = Get-Key $lf 'resultKey'
  if ((Get-Key $tn 'present') -ne $true -or (Get-Key $tn 'protected') -ne $true -or (Get-Key $tn 'sha256') -cne $toolchainSha) { $c += 'LINUX_TOOLCHAIN_NODE_NOT_THE_KITS' }
  if ((Get-Key $pk 'present') -ne $true -or (Get-Key $pk 'protected') -ne $true -or [string](Get-Key $pk 'pem') -ceq '') { $c += 'LINUX_RESULT_PUBLIC_KEY' }
  if ((Get-Key $k 'present') -ne $true -or (Get-Key $k 'protected') -ne $true) { $c += 'LINUX_RESULT_KEY' }
  foreach ($x in @('systemdPid1', 'cgroupV2', 'dockerActive', 'python312')) { if ((Get-Key $lf $x) -ne $true) { $c += ('LINUX_' + $x) } }
  $own = $ownKeyPem -and ([string](Get-Key $pk 'pem')).Replace("`r`n", "`n") -ceq $ownKeyPem
  if (@(Get-Key $lf 'linuxCiPresent').Count -ne 0 -and -not $own) { $c += 'LINUX_CI_ALREADY_PRESENT' }
  , @($c)
}

# ------------------------------------------------------------------ host steps
function New-RandomPassword { $b = New-Object byte[] 33; $r = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $r.GetBytes($b) } finally { $r.Dispose() }; [Convert]::ToBase64String($b) }
function ConvertTo-Secure([string]$t) { $s = New-Object Security.SecureString; foreach ($ch in $t.ToCharArray()) { $s.AppendChar($ch) }; $s.MakeReadOnly(); $s }
function Sha256File([string]$p) { $s = [Security.Cryptography.SHA256]::Create(); $f = [IO.File]::OpenRead($p); try { (-join ($s.ComputeHash($f) | ForEach-Object { $_.ToString('x2') })) } finally { $f.Dispose(); $s.Dispose() } }
function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { -join ($s.ComputeHash($b) | ForEach-Object { $_.ToString('x2') }) } finally { $s.Dispose() } }
# The one JSON writer of P1 (drill 3bc571a6 A1, Fable ruling 11-19 section 2.1): every line it prints and every JSON file it writes
# goes through ConvertTo-JsonLine, and nothing else here calls the serializer. Under Windows PowerShell 5.1 a cmdlet's output (Join-Path,
# Where-Object, Split-Path) is a string in a PSObject shell, which JavaScriptSerializer walks as an object (PSParameterizedProperty: a
# circular reference); `Step 'stage' $stage` ended P1 so, and the READY line (facts = Join-Path) would have ended it after a whole
# install. ConvertTo-PlainData takes the shell off and keeps only plain data: a string, a bool, a number, null, a dictionary with string
# keys (ordered, its key order kept), a list (an array). Anything else (a FileInfo, a DateTime, an enum, a PSCustomObject, a structure
# deeper than 32) is not plain data: -Progress prints its type name instead and never throws; without it ConvertTo-JsonLine throws
# OUTPUT_NOT_PLAIN_DATA:<where>:<type>. rollout/fleet/bootstrap.ps1 carries the same two functions, character for character (it is
# downloaded on its own and cannot load this file; test-bootstrap.ps1 holds the two texts equal). ConvertTo-Json is not the way out
# (5.1's depth limit, one-element arrays and escaping are another set of traps).
function ConvertTo-PlainData($value, [bool]$progress, [string]$at = '$', [int]$depth = 0) {
  if ($null -eq $value) { return $null }
  $v = $value.PSObject.BaseObject
  $t = $v.GetType()
  if ($v -is [string] -or $v -is [bool]) { return $v }
  $tc = [int][Type]::GetTypeCode($t)
  if ($t.IsPrimitive -and -not $t.IsEnum -and $tc -ge 5 -and $tc -le 14 -or $v -is [decimal]) { return $v }   # SByte..Double, Decimal
  if ($depth -lt 32) {
    if ($v -is [Collections.IDictionary]) {
      $o = [ordered]@{}
      foreach ($k in @($v.Keys)) {
        $key = if ($null -ne $k) { $k.PSObject.BaseObject } else { $null }
        if ($key -isnot [string]) { $o = $null; break }
        $r = ConvertTo-PlainData $v[$k] $progress ($at + '.' + $key) ($depth + 1)
        if ($null -ne $r) { $r = $r.PSObject.BaseObject }   # an array a function returns comes back in a shell again
        $o[$key] = $r
      }
      if ($null -ne $o) { return $o }
    } elseif ($v -is [Collections.IEnumerable]) {
      $items = @(foreach ($x in $v) { , $x })
      $a = New-Object object[] $items.Count
      for ($i = 0; $i -lt $items.Count; $i++) {
        $r = ConvertTo-PlainData $items[$i] $progress ($at + '[' + $i + ']') ($depth + 1)
        if ($null -ne $r) { $r = $r.PSObject.BaseObject }
        $a[$i] = $r
      }
      return , $a
    }
  }
  if ($progress) { return ('<not plain data: ' + $t.FullName + '>') }
  $e = New-Object InvalidOperationException ('OUTPUT_NOT_PLAIN_DATA:' + $at + ':' + $t.FullName)
  $e.Data['OutputNotPlainData'] = $true   # the mark a caller recognizes the refusal by (never its text alone)
  throw $e
}
function ConvertTo-JsonLine($value, [switch]$Progress) {
  $plain = ConvertTo-PlainData $value $Progress.IsPresent
  if ($null -ne $plain) { $plain = $plain.PSObject.BaseObject }
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer
  $js.MaxJsonLength = [int]::MaxValue   # not the default 2,097,152: at least what a reader takes (bootstrap reads a stage child up to 16,777,216)
  if (-not $Progress) { return $js.Serialize($plain) }
  try { $js.Serialize($plain) } catch {
    # progress never throws: a line that cannot be written is replaced by one that keeps its status, step and code and names why
    $kept = [ordered]@{}
    if ($plain -is [Collections.IDictionary]) { foreach ($k in @('status', 'step', 'code', 'name', 'result', 'rejectCode')) { if ($plain.Contains($k) -and $plain[$k] -is [string]) { $kept[$k] = $plain[$k] } } }
    $kept['notWritten'] = [string]$_.Exception.GetType().FullName
    $js.Serialize($kept)
  }
}
# The step lines (an aid; Fable ruling 11-19 renew-key, "evidence goes with the verdict" 2.3): one JSON line per step that ends, the same
# shape in the three stages of a first install (this host preparation, bootstrap.ps1, the launcher): {name, result: ok|failed, rejectCode,
# detail}. Enter-Step names the step that runs now: a refusal, a restart or an exception is printed as that step failed, before the
# verdict. A step line never throws and never ends P1.
# This stage's lines also carry at, the UTC time the step ended (Fable ruling 0e418483 section 4; ISO 8601, +00:00): two neighbouring lines
# give a step's duration. bootstrap.ps1's lines do not carry it; the launcher's carry it and ms, its own monotonic milliseconds (task 87d330d0).
function Get-StepLine([string]$name, [string]$result, $rejectCode, $detail) {
  $at = try { [DateTimeOffset]::UtcNow.ToString('o') } catch { $null }
  try { ConvertTo-JsonLine ([ordered]@{ name = $name; result = $result; rejectCode = $rejectCode; detail = $detail; at = $at }) -Progress }
  catch { ConvertTo-JsonLine ([ordered]@{ name = $name; result = $result; rejectCode = $(if ($rejectCode -is [string]) { $rejectCode } else { $null }); detail = '<not printable>'; at = $at }) -Progress }
}
# -StepProgress <file> (the CLUED-DRILL entry only; bootstrap.ps1 does not pass it): a step line printed only as a step ends says
# nothing while a step runs (drill 20261123T125817Z: the host stage cut off 5 minutes after node-key-check, the step it was in unknown).
# With it, each step is also one line in that file as it starts and one as it ends -- stage host, event step-start/step-end, step, startedAt,
# endedAt, result, code -- the entry's stage record (drill/first-install-entry.ps1 stage-progress.jsonl, pulled by the drill host while
# this runs). Appended with read-write sharing; an aid: a line that cannot be written is not, and stdout is unchanged.
$script:StepProgressStartedAt = $null
function Write-StepProgress([string]$event, [string]$name, [string]$result, $code) {
  try {
    $file = Get-Variable -Name StepProgress -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if (-not $file) { return }
    $now = [DateTimeOffset]::UtcNow.ToString('o')
    if ($event -ceq 'step-start') { $script:StepProgressStartedAt = $now }
    $line = [ordered]@{ stage = 'host'; event = $event; item = $null; step = $name; bytes = $null; startedAt = $script:StepProgressStartedAt
      endedAt = $(if ($event -ceq 'step-end') { $now } else { $null }); result = $result; code = $(if ($code -is [string]) { $code } else { $null }) }
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes((ConvertTo-JsonLine $line -Progress) + "`n")   # the one JSON writer
    $fs = New-Object IO.FileStream -ArgumentList $file, ([IO.FileMode]::Append), ([IO.FileAccess]::Write), ([IO.FileShare]::ReadWrite)
    try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
  } catch { }
}
function Enter-Step([string]$name) { $script:StepNow = $name; Write-StepProgress 'step-start' $name 'running' $null }
function Step([string]$name, $detail) { $script:StepNow = $null; Write-StepProgress 'step-end' $name 'ok' $null; Get-StepLine $name 'ok' $null $detail }
# A failed step's line carries its name and code only: the detail is the verdict's, once (a stage keeps only the tail of stdout).
function Get-FailedStepLine($rejectCode) { $n = if ($script:StepNow) { [string]$script:StepNow } else { 'host' }; $script:StepNow = $null; Write-StepProgress 'step-end' $n 'failed' $rejectCode; Get-StepLine $n 'failed' $rejectCode $null }
# A restart Windows asks for (exit 3): the step it ended, then the verdict; the same command is run again after the restart. The verdict
# says which install step asked and each installer's own exit code ($installers: {installer, exit}; "heartbeat token and restart code" 2).
function Exit-Restart([string]$why, $installers) {
  $step = $script:StepNow
  Get-FailedStepLine 'RESTART_THEN_RUN_THE_SAME_COMMAND'
  ConvertTo-JsonLine ([ordered]@{ status = 'RESTART_THEN_RUN_THE_SAME_COMMAND'; why = $why; step = $step; installers = @($installers) })
  exit 3
}
# The refusal verdict: one JSON line, exit 1, after the line of the step it ended. A detail that is not plain data is refused by name,
# with the code it was refusing.
function Stop-Host([string]$code, $detail) {
  Clear-Secrets
  Get-FailedStepLine $code
  $line = try { ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_REFUSED'; code = $code; detail = $detail }) } catch {
    ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_REFUSED'; code = 'HOST_OUTPUT_NOT_PLAIN_DATA'; detail = [ordered]@{ code = $code; why = [string]$_.Exception.Message } }) -Progress
  }
  $line
  exit 1
}
# The other verdicts (READY, RESET, RESTART) and the files P1 writes are contracts too: one that is not plain data ends P1 refused by
# name (HOST_OUTPUT_NOT_PLAIN_DATA), never as a bare exception and never written in a form someone has to guess at.
function Invoke-Host {
  try { Invoke-HostPreparation } catch {
    $x = $_.Exception
    if ($x.Data['OutputNotPlainData'] -eq $true -and [string]$x.Message -cmatch '^OUTPUT_NOT_PLAIN_DATA:(.*):([^:]*)$') { Stop-Host 'HOST_OUTPUT_NOT_PLAIN_DATA' ([ordered]@{ at = $Matches[1]; type = $Matches[2] }) }
    # any other exception passes through as it is (stderr, no verdict), after the line of the step it ended
    Get-FailedStepLine $null
    throw
  }
}function Clear-Secrets {
  foreach ($k in @($script:Secrets.Keys)) { [Array]::Clear($script:Secrets[$k], 0, $script:Secrets[$k].Length) }; $script:Secrets.Clear()
  if ($null -ne $script:CompanionToken) { [Array]::Clear($script:CompanionToken, 0, $script:CompanionToken.Length); $script:CompanionToken = $null }
}
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
# M1: a new file whole or not at all: written under a temporary name beside it (create-only, its security descriptor from the start,
# written through), then renamed into place; a name that exists is never replaced (File.Move refuses one).
function Write-NewFile([string]$path, [byte[]]$bytes, [string]$sddl) {
  if ([IO.File]::Exists($path)) { throw ('FILE_EXISTS_NOT_REPLACED:' + $path) }
  $partial = $path + '.partial-' + [Guid]::NewGuid().ToString('N')
  $fs = New-Object Security.AccessControl.FileSecurity; $fs.SetSecurityDescriptorSddlForm($sddl)
  try {
    $f = New-Object IO.FileStream($partial, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $fs)
    try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
    [IO.File]::Move($partial, $path)
  } finally { if ([IO.File]::Exists($partial)) { [IO.File]::Delete($partial) } }
}

function Copy-PreservedCredential([string]$source, [string]$target, [scriptblock]$Create = {
    param($path, $security)
    [IO.FileStream]::new($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write,
      [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $security)
  }) {
  $partial = $target + '.partial-' + [Guid]::NewGuid().ToString('N')
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)')
  $inputFile = [IO.File]::Open($source, 'Open', 'Read', 'Read')
  try {
    $output = & $Create $partial $acl
    try { $inputFile.CopyTo($output); $output.Flush($true) }
    finally { $output.Dispose() }
    [IO.File]::Move($partial, $target)
  } finally {
    $inputFile.Dispose()
    if ([IO.File]::Exists($partial)) { [IO.File]::Delete($partial) }
  }
}
# M5: an expansion of a pinned archive is complete only with its mark (a file beside the directory naming the archive's sha256).
function Get-ExpandState([string]$dir, [string]$marker, [string]$sha256) {
  if (-not [IO.Directory]::Exists($dir)) { return 'absent' }
  if ([IO.File]::Exists($marker) -and ([IO.File]::ReadAllText($marker)).Trim() -ceq $sha256) { 'complete' } else { 'incomplete' }
}
# M5: check every file against the ZIP's bytes. When materializing a cached tree, copy and check only entries named by the ZIP.
function Test-ZipExpanded([string]$zip, [string]$dir, [string]$copyTo) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $root = [IO.Path]::GetFullPath($dir).TrimEnd('\') + '\'
  $z = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    foreach ($e in $z.Entries) {
      $f = [IO.Path]::GetFullPath((Join-Path $root ($e.FullName.Replace('/', '\'))))
      if (-not $f.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $false }
      $target = if ($copyTo) { Join-Path $copyTo $f.Substring($root.Length) } else { $null }
      if ($e.FullName.EndsWith('/') -or $e.FullName.EndsWith('\')) {
        if ($target) { [void][IO.Directory]::CreateDirectory($target) }
        continue
      }
      if (-not [IO.File]::Exists($f) -or (New-Object IO.FileInfo($f)).Length -ne $e.Length) { return $false }
      if ($target) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        $source = [IO.File]::OpenRead($f)
        try {
          $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
          try { $source.CopyTo($output) } finally { $output.Dispose() }
        } finally { $source.Dispose() }
        $f = $target
      }
      $s = [Security.Cryptography.SHA256]::Create()
      try {
        $es = $e.Open(); try { $want = [BitConverter]::ToString($s.ComputeHash($es)) } finally { $es.Dispose() }
        $fs = [IO.File]::OpenRead($f); try { $have = [BitConverter]::ToString($s.ComputeHash($fs)) } finally { $fs.Dispose() }
      } finally { $s.Dispose() }
      if ($want -cne $have) { return $false }
    }
  } finally { $z.Dispose() }
  $true
}
# M5: the archive expanded resumably (bootstrap.ps1 Expand-Cached's way): into a new directory, checked against the zip, renamed into place,
# then marked; a directory found without its mark (a cut-off run) is set aside whole (kept, never deleted) and the expansion done again;
# a marked one is only checked, and refused when its files are not the zip's.
function Expand-Verified([string]$zip, [string]$dir, [string]$marker, [string]$sha256, [string]$cachedDirectory) {
  $state = Get-ExpandState $dir $marker $sha256
  if ($state -ceq 'complete') {
    if (-not (Test-ZipExpanded $zip $dir)) { Stop-Host 'EXPANDED_FILES_NOT_THE_PINNED' $dir }
    return 'checked'
  }
  if ($state -ceq 'incomplete') { [IO.Directory]::Move($dir, $dir + '.incomplete-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)) }
  if ([IO.File]::Exists($marker)) { [IO.File]::Delete($marker) }
  $partial = $dir + '.partial-' + [Guid]::NewGuid().ToString('N')
  if ($cachedDirectory) {
    if ([IO.File]::ReadAllText((Join-Path $cachedDirectory '.bootstrap-complete')) -cne $sha256) { Stop-Host 'EXPANDED_FILES_NOT_THE_PINNED' $cachedDirectory }
    [void][IO.Directory]::CreateDirectory($partial)
    $valid = Test-ZipExpanded $zip $cachedDirectory $partial
  } else {
    Expand-HostZip $zip $partial
    $valid = Test-ZipExpanded $zip $partial
  }
  if (-not $valid) { Stop-Host 'EXPANDED_FILES_NOT_THE_PINNED' $partial }
  [IO.Directory]::Move($partial, $dir)
  [IO.File]::WriteAllText($marker, $sha256)
  'expanded'
}

function Expand-HostZip([string]$zip, [string]$dir) {
  [void][IO.Directory]::CreateDirectory($dir)
  & 'C:\Windows\System32\tar.exe' -x -f $zip -C $dir
  if ($LASTEXITCODE -ne 0) { Stop-Host 'PREREQ_ZIP_EXTRACT_FAILED' $zip }
}
# L3: what a run must have been given before anything is written: a first run (collect-all) the App key, the ci-admission token and the
# upgrade token (the heartbeat token is optional: facts then record none); a re-run (ask-missing) everything it asked for, which
# facts.json records (a recorded heartbeat token left empty reached READY and stopped the launcher at Step-CarryTokens).
# The credential list (the data file): the two groups, each name to one file name. Refused by name before anything is done: missing
# (CREDENTIAL_FILES_MISSING), not JSON (_UNREADABLE), another contract (_CONTRACT), a top-level key other than contract, required and
# optional (_SHAPE), a name not ^[A-Za-z][A-Za-z0-9]*$ (_NAME_REFUSED), a file name Test-CredentialFileName refuses (_FILE_NAME_REFUSED),
# one file name twice (_DUPLICATE_FILE), one name twice in a group
# (_DUPLICATE_NAME) or in both groups (_NAME_IN_BOTH), case-insensitively, and an empty required group (_REQUIRED_EMPTY).
# A credential file name the list may give (the drill's kit build holds the same file to the same rule; ASCII only, so "the same name
# up to case" means the same in both readers): ^[A-Za-z0-9][A-Za-z0-9._-]*$, not ending in '.', and not a Windows device name (CON, PRN,
# AUX, NUL, COM1-9, LPT1-9) with or without an extension.
function Test-CredentialFileName($f) {
  if ($f -isnot [string] -or $f -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\z' -or $f.EndsWith('.')) { return $false }
  -not ($f.Split('.')[0] -match '^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\z')
}
function Read-CredentialFiles([string]$path) {
  if (-not $path -or -not [IO.File]::Exists($path)) { throw 'CREDENTIAL_FILES_MISSING' }
  $d = try { (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject((New-Object Text.UTF8Encoding($false, $true)).GetString([IO.File]::ReadAllBytes($path)).TrimStart([char]0xFEFF)) } catch { $null }
  if ($d -isnot [Collections.IDictionary]) { throw 'CREDENTIAL_FILES_UNREADABLE' }
  if ([string](Get-Key $d 'contract') -cne $CredentialFilesContract) { throw 'CREDENTIAL_FILES_CONTRACT' }
  $r = [ordered]@{ required = [ordered]@{}; optional = [ordered]@{}; files = [ordered]@{} }
  if (@($d.Keys | Where-Object { @('contract', 'required', 'optional') -cnotcontains $_ }).Count) { throw 'CREDENTIAL_FILES_SHAPE' }
  # the rules the drill's kit build holds the same file to: exactly these three top-level keys (nothing else is ever added to the file;
  # what it means is said here and in the drill's documentation), names and file names unique also when they differ only in case (a
  # name twice in one group: _DUPLICATE_NAME; in both groups: _NAME_IN_BOTH), plain file names, a non-empty required group.
  $seenFiles = @{}; $seenNames = @{}
  foreach ($g in @('required', 'optional')) {
    $m = Get-Key $d $g
    if ($m -isnot [Collections.IDictionary]) { throw 'CREDENTIAL_FILES_SHAPE' }
    foreach ($k in @($m.Keys)) {
      $f = $m[$k]
      if ($k -cnotmatch '^[A-Za-z][A-Za-z0-9]*\z') { throw 'CREDENTIAL_FILES_NAME_REFUSED' }
      if (-not (Test-CredentialFileName $f)) { throw 'CREDENTIAL_FILES_FILE_NAME_REFUSED' }
      $lk = $k.ToLowerInvariant()
      if ($seenNames.ContainsKey($lk)) { if ($seenNames[$lk] -ceq $g) { throw 'CREDENTIAL_FILES_DUPLICATE_NAME' } else { throw 'CREDENTIAL_FILES_NAME_IN_BOTH' } }
      if ($seenFiles.ContainsKey($f.ToLowerInvariant())) { throw 'CREDENTIAL_FILES_DUPLICATE_FILE' }
      $seenNames[$lk] = $g; $seenFiles[$f.ToLowerInvariant()] = $true; $r[$g][$k] = $f; $r.files[$k] = $f
    }
  }
  if ($r.required.Count -eq 0) { throw 'CREDENTIAL_FILES_REQUIRED_EMPTY' }
  $r
}
function Get-MissingCredentials($plan, [string[]]$given) {
  $required = if ([string]$plan.mode -ceq 'collect-all') { @($FactsSecrets | Where-Object { $script:CredentialList.required.Contains($_) }) } else { @($plan.ask) }
  , @($required | Where-Object { @($given) -cnotcontains $_ })
}
function Get-HeartbeatPrompt([bool]$recorded) { if ($recorded) { 'heartbeat (the one facts.json records; required)' } else { 'heartbeat (leave empty for none)' } }
function Copy-Verified([string]$from, [string]$to, [string]$sha, $bytes) {
  if (-not [IO.File]::Exists($from)) { Stop-Host 'INPUT_MISSING' $from }
  [IO.File]::Copy($from, $to, $false)
  if ((Sha256File $to) -cne $sha -or ($null -ne $bytes -and (Get-Item -LiteralPath $to).Length -ne [long]$bytes)) { Stop-Host 'INPUT_NOT_THE_PINNED_BYTES' ([IO.Path]::GetFileName($to)) }
  $to
}
# H1, one rule for every child a package script starts (test/native-child.test.mjs holds every copy of this function the same text and no
# package .ps1 merging a stream into its output): stdout, stderr and the exit code read apart. A line a child writes on stderr is text,
# never a PowerShell error (Windows PowerShell 5.1 turns a native stderr line under 2>&1 into one, which ends the caller under Stop). On
# timeout nothing is killed: timedOut, exit $null. $shareConsole: the child keeps this console (a tool that may show a window or read the
# clipboard). stderr is its last 1500 characters.
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
# Every tool P1 starts (review H1): Invoke-NativeChild; a child still running after $seconds ends P1 refused by name.
function Invoke-Native([string]$exe, [string[]]$arguments, [int]$seconds = 3600, [Text.Encoding]$encoding = $Utf8, [bool]$shareConsole = $false, [byte[]]$stdin = $null) {
  $r = Invoke-NativeChild $exe $arguments $seconds $encoding $shareConsole $stdin
  if ($r.timedOut) { Stop-Host 'COMMAND_TIMEOUT_NOTHING_KILLED' ([IO.Path]::GetFileName($exe) + ' ' + ($arguments -join ' ')) }
  $r
}
function Invoke-Wsl([string[]]$arguments, [int]$seconds = 3600) { Invoke-Native $Wsl $arguments $seconds }
# As root in the distribution, by --exec (the arguments reach env as they are: no shell between), with a cleared environment.
function Invoke-Root([string]$wslScript, [string[]]$scriptArgs, [string]$interpreter = '/usr/bin/bash') {
  $base = @('-d', $Distribution, '-u', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'LANG=C', 'LC_ALL=C', 'HOME=/root')
  $run = if ($interpreter -ceq '/usr/bin/bash') { @('/usr/bin/bash', '--noprofile', '--norc', $wslScript) } else { @($interpreter, '-I', $wslScript) }
  Invoke-Wsl ($base + $run + $scriptArgs)
}
function To-WslPath([string]$p) { '/mnt/' + $p.Substring(0, 1).ToLowerInvariant() + $p.Substring(2).Replace('\', '/') }
# The secret-fingerprint tool of the package, with the staged node, a cleared environment, the secret on stdin (place-app-key.ps1's way).
function Get-SecretFingerprint([byte[]]$secret, [string]$kind, [string]$carrier) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe; $psi.Arguments = '"' + $script:FingerprintTool + '" ' + $kind; $psi.WorkingDirectory = 'C:\Windows\System32'
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables.Clear(); $psi.EnvironmentVariables['SystemRoot'] = 'C:\Windows'; $psi.EnvironmentVariables['WINDIR'] = 'C:\Windows'; $psi.EnvironmentVariables['PATH'] = 'C:\Windows\System32'
  # No BOM before the secret on a UTF-8 console: the guard every start with a redirected stdin carries (see Invoke-NativeChild, test/native-child.test.mjs).
  $cie = if ($psi.RedirectStandardInput) { [Console].GetField('_inputEncoding', [Reflection.BindingFlags]'NonPublic, Static') } else { $null }
  $was = if ($null -ne $cie) { $cie.GetValue($null) } else { $null }
  if ($null -ne $cie) { $cie.SetValue($null, (New-Object Text.UTF8Encoding($false))) }
  try { $p = [Diagnostics.Process]::Start($psi) } finally { if ($null -ne $cie) { $cie.SetValue($null, $was) } }
  try {
    if ($carrier) {
      $inputFile = [IO.File]::Open($carrier, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      try { $inputFile.CopyTo($p.StandardInput.BaseStream) } finally { $inputFile.Dispose() }
    } else { $p.StandardInput.BaseStream.Write($secret, 0, $secret.Length) }
  } finally { $p.StandardInput.Close() }
  $o = $p.StandardOutput.ReadToEndAsync(); $null = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch { }; Stop-Host 'SECRET_FINGERPRINT_TIMEOUT' $kind }
  if ($p.ExitCode -ne 0) { return $null }
  $r = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($o.Result.Trim())
  if ((Get-Key $r 'kind') -cne $kind) { return $null }
  [string]$r['fingerprint']
}
# M1: the facts rule is install.mjs's readFirstInstallFacts (first-install-facts-check), run by the staged node from the archive's tree.
function Invoke-FactsCheck([string]$factsFile) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $script:NodeExe; $psi.Arguments = '"' + $script:InstallMjs + '" first-install-facts-check --facts "' + $factsFile + '"'; $psi.WorkingDirectory = 'C:\Windows\System32'
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables.Clear(); foreach ($kv in @(@('SystemRoot', 'C:\Windows'), @('WINDIR', 'C:\Windows'), @('PATH', 'C:\Windows\System32'), @('COMPUTERNAME', [Environment]::MachineName))) { $psi.EnvironmentVariables[$kv[0]] = $kv[1] }
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(120000)) { Stop-Host 'FACTS_CHECK_TIMEOUT' $null }
  $last = @(([string]$o.Result) -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -Last 1
  $r = try { (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([string]$last) } catch { $null }
  [ordered]@{ ok = ($p.ExitCode -eq 0 -and [string](Get-Key $r 'status') -ceq 'FIRST_INSTALL_FACTS_VALID'); result = $r; stderr = ([string]$e.Result) }
}
function Read-SecureBytes([Security.SecureString]$s) {
  $p = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($s)
  try { $chars = New-Object char[] $s.Length; [Runtime.InteropServices.Marshal]::Copy($p, $chars, 0, $s.Length); $b = $Utf8.GetBytes($chars); [Array]::Clear($chars, 0, $chars.Length); , $b }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($p) }
}
# The one way a token is asked for (Fable ruling 11-19 renew-key, "eight on the path" 1): the Windows credential dialog itself
# (credui.dll CredUIPromptForCredentialsW: generic credentials, always shown, never saved), never PowerShell's host prompt. P1 runs with
# -NonInteractive (an unexpected prompt never holds an unattended stage), which refuses that prompt before any window opens. The token is
# the password: read into unmanaged memory, copied out as UTF-8 bytes, the memory and the characters cleared. The dialog's answers by code:
# cancelled CREDENTIAL_DIALOG_CANCELLED; any other CREDENTIAL_DIALOG_FAILED:<Win32 code>; the dialog not loadable CREDENTIAL_DIALOG_UNAVAILABLE.
# The synthetic input of the drill (-CredentialDirectory) never comes here and is held to the same checks after it.
function Get-CredentialDialogCode([int]$rc) { if ($rc -eq 0) { $null } elseif ($rc -eq 1223) { 'CREDENTIAL_DIALOG_CANCELLED' } else { 'CREDENTIAL_DIALOG_FAILED:' + $rc } }
$CredUiSource = @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class CluedFirstInstallCredUi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Info { public int cbSize; public IntPtr hwndParent; public string pszMessageText; public string pszCaptionText; public IntPtr hbmBanner; }
  [DllImport("credui.dll", CharSet = CharSet.Unicode)]
  static extern int CredUIPromptForCredentialsW(ref Info info, string target, IntPtr reserved, int authError, StringBuilder user, int userMax, IntPtr password, int passwordMax, ref bool save, int flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  public const int PasswordChars = 257;   // CREDUI_MAX_PASSWORD_LENGTH + 1, as PowerShell's own credential prompt
  // GENERIC_CREDENTIALS 0x40000 | KEEP_USERNAME 0x100000 | ALWAYS_SHOW_UI 0x80 | EXCLUDE_CERTIFICATES 0x8 | DO_NOT_PERSIST 0x2
  public const int Flags = 0x40000 | 0x100000 | 0x80 | 0x8 | 0x2;
  public static int Prompt(string user, string caption, string message, IntPtr password) {
    Info i = new Info(); i.cbSize = Marshal.SizeOf(typeof(Info)); i.hwndParent = GetConsoleWindow(); i.pszCaptionText = caption; i.pszMessageText = message;
    StringBuilder u = new StringBuilder(user, 514); bool save = false;
    return CredUIPromptForCredentialsW(ref i, "Clued first install", IntPtr.Zero, 0, u, 514, password, PasswordChars, ref save, Flags);
  }
}
'@
function Read-TokenFromDialog([string]$what) {
  try { if (-not ('CluedFirstInstallCredUi' -as [type])) { Add-Type -TypeDefinition $CredUiSource } } catch { Stop-Host 'CREDENTIAL_DIALOG_UNAVAILABLE' $what }
  $size = [CluedFirstInstallCredUi]::PasswordChars * 2
  $zero = New-Object byte[] $size
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::Copy($zero, 0, $buf, $size)
    $rc = try { [CluedFirstInstallCredUi]::Prompt($what, 'Clued first install', ("Paste the $what token as the password (it is fingerprinted and stored for SYSTEM and Administrators only; never shown)."), $buf) } catch { -1 }
    $code = Get-CredentialDialogCode $rc
    if ($code) { Stop-Host $code $what }
    $n = 0; while ($n -lt [CluedFirstInstallCredUi]::PasswordChars -and [Runtime.InteropServices.Marshal]::ReadInt16($buf, $n * 2) -ne 0) { $n++ }
    $chars = New-Object char[] $n
    if ($n) { [Runtime.InteropServices.Marshal]::Copy($buf, $chars, 0, $n) }
    try { , $Utf8.GetBytes($chars) } finally { [Array]::Clear($chars, 0, $chars.Length) }
  } finally { [Runtime.InteropServices.Marshal]::Copy($zero, 0, $buf, $size); [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
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
# One secret's state against facts.json: 'match', 'differs', 'missing' ('none' when the facts record no such secret).
function Get-SecretState([string]$name, $facts, [string]$controllerSid) {
  $want = switch ($name) {
    'appKey' { [string](Get-Key (Get-Key $facts 'nodeRecord') 'appPublicKeySha256Base64') } 'ciToken' { [string](Get-Key (Get-Key $facts 'nodeRecord') 'ciTokenPinSha256') }
    'upgradeToken' { [string](Get-Key (Get-Key (Get-Key $facts 'credentials') 'upgradeToken') 'fingerprint') }
    'heartbeatToken' { $h = Get-Key (Get-Key $facts 'credentials') 'heartbeatToken'; if ($null -eq $h) { return 'none' }; [string](Get-Key $h 'fingerprint') } }
  $file = if ($SecretTargets.Contains($name)) { $SecretTargets[$name] } else { Join-Path $CredDir $script:CredentialList.files[$name] }
  if (-not [IO.File]::Exists($file)) { return 'missing' }
  $item = Get-Item -LiteralPath $file -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return 'differs' }
  if ($SecretTargets.Contains($name) -and -not (Test-SddlIs (Get-Acl -LiteralPath $file).Sddl (Get-SecretFileSddl $controllerSid))) { return 'differs' }
  $b = [IO.File]::ReadAllBytes($file)
  try { $fp = Get-SecretFingerprintOf $name $b } finally { [Array]::Clear($b, 0, $b.Length) }
  if ($fp -ceq $want) { 'match' } else { 'differs' }
}
function Get-SecretFingerprintOf([string]$name, [byte[]]$bytes) {
  switch ($name) { 'appKey' { Get-SecretFingerprint $bytes 'app-key' } 'ciToken' { Get-SecretFingerprint $bytes 'ci-token' } 'upgradeToken' { Get-TokenFingerprint $bytes 'ci-token' } 'heartbeatToken' { Get-TokenFingerprint $bytes 'heartbeat-token' } }
}
# H2: the secrets placed, after the facts draft passed: create-only; a file found in place must have the same fingerprint.
function Write-Secrets([string]$controllerSid) {
  foreach ($name in @($script:Secrets.Keys)) {
    $bytes = $script:Secrets[$name]
    $target = if ($SecretTargets.Contains($name)) { $SecretTargets[$name] } else { Join-Path $CredDir $script:CredentialList.files[$name] }
    $sddl = if ($SecretTargets.Contains($name)) { Get-SecretFileSddl $controllerSid } else { Get-AdminOnlySddl }
    if ([IO.File]::Exists($target)) {
      $have = [IO.File]::ReadAllBytes($target)
      try { $same = (Get-SecretFingerprintOf $name $have) -ceq (Get-SecretFingerprintOf $name $bytes) } finally { [Array]::Clear($have, 0, $have.Length) }
      if (-not $same) { Stop-Host 'SECRET_ALREADY_PLACED_IS_ANOTHER' $target }
    } else { Write-CreateOnly $target $bytes $sddl }
  }
}
# The companion account's WSL registrations, read elevated: its loaded hive, else its NTUSER.DAT loaded for this read and unloaded.
# Task 87d330d0 line C (FABLE-drill-companion-queued-20261124 2.4): a hive this read leaves loaded keeps the account's profile from loading,
# so the loaded copy is read by reg.exe (this process holds no handle in it), this process's own handles are let go first, and the unload
# is held to its exit code: three tries $Pause apart; a hive still loaded stops the host by name (FIRST_INSTALL_COMPANION_HIVE_NOT_UNLOADED).
# $ProfileRoot, $Pause: the machine's own by default; a test gives its own.
function Get-CompanionDistributionState([string]$ProfileRoot = 'C:\Users', [scriptblock]$Pause = { Start-Sleep -Seconds 1 }) {
  $u = Get-LocalUser -Name $CompanionAccountName -ErrorAction SilentlyContinue
  if ($null -eq $u) { return 'no-account' }
  $sid = $u.SID.Value
  $lxss = '\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (Test-Path -LiteralPath "Registry::HKEY_USERS\$sid") {
    try {
      $k = "Registry::HKEY_USERS\$sid$lxss"; if (-not (Test-Path -LiteralPath $k)) { return 'absent' }
      if (@(Get-ChildItem -LiteralPath $k | ForEach-Object { [string](Get-ItemProperty -LiteralPath $_.PSPath -Name DistributionName -ErrorAction SilentlyContinue).DistributionName } | Where-Object { $_ -ceq $Distribution }).Count) { return 'present' }
      return 'absent'
    } catch { return 'unknown' }
  }
  $dat = Join-Path $ProfileRoot ($CompanionAccountName + '\NTUSER.DAT')
  if (-not [IO.File]::Exists($dat)) { return 'absent' }   # never logged on and no profile: no registration can exist
  $mount = 'HKU\clued-p1-' + [Guid]::NewGuid().ToString('N')
  $reg = 'C:\Windows\System32\reg.exe'
  $l = Invoke-Native $reg @('load', $mount, $dat) 60
  if ($l.exit -ne 0) { return 'unknown' }
  $state = 'unknown'
  try {
    # exit 0 with the lines it found; 1 when the key or the value is not there
    $q = Invoke-Native $reg @('query', ($mount + $lxss), '/s', '/v', 'DistributionName') 60
    $names = @(([string]$q.stdout) -split "`r?`n" | ForEach-Object { if ($_ -match '^\s+DistributionName\s+REG_SZ\s+(.*?)\s*$') { $Matches[1] } })
    $state = if ($names -ccontains $Distribution) { 'present' } elseif ($q.exit -eq 0 -or $q.exit -eq 1) { 'absent' } else { 'unknown' }
  } catch { $state = 'unknown' }
  finally {
    [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()
    $unloaded = $false
    for ($try = 1; $try -le 3 -and -not $unloaded; $try++) {
      if ($try -gt 1) { & $Pause }
      $unloaded = ((Invoke-Native $reg @('unload', $mount) 60).exit -eq 0)
    }
    if (-not $unloaded) { Stop-Host 'FIRST_INSTALL_COMPANION_HIVE_NOT_UNLOADED' $mount }
  }
  $state
}
# The companion account script's answer (one JSON document on stdout): prepared, or P1 ends refused with the evidence inline. Its log file
# lies in P1's stage, which is removed when P1 ends: the refusal names no file there and carries the log's error and steps (the script's
# own non-secret fields, printed with its status) instead; an answer that is not that JSON is kept as it came (stdout, stderr, exit).
function Assert-CompanionPrepared($prepRun) {
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue
  $prep = [string]$prepRun.stdout
  $pr = try { $js.DeserializeObject($prep) } catch { try { $js.DeserializeObject(@($prep -split "`r?`n" | Where-Object { $_.Trim() })[-1]) } catch { $null } }
  if ($pr -isnot [Collections.IDictionary]) { Stop-Host 'COMPANION_ACCOUNT_NOT_PREPARED' ([ordered]@{ exit = $prepRun.exit; stdout = $prep; stderr = $prepRun.stderr }) }
  # -AccountOnly: the account alone; its token is the credentials step's. ..._TOKEN_PENDING (the token step ran after all) is refused.
  if ([string](Get-Key $pr 'status') -cne 'COMPANION_ACCOUNT_PREPARED') {
    Stop-Host 'COMPANION_ACCOUNT_NOT_PREPARED' ([ordered]@{ exit = $prepRun.exit; status = (Get-Key $pr 'status'); error = (Get-Key $pr 'error'); steps = (Get-Key $pr 'steps'); stderr = $prepRun.stderr })
  }
  $pr
}
# clued-control's right to log on as a service, as the companion account script granted it and read it back (its steps.serviceLogon):
# granted, or the host preparation stops with the step it stopped in (resolve, open, grant, readback) and the system's raw status.
function Assert-ServiceLogonGranted($pr) {
  $s = Get-Key (Get-Key $pr 'steps') 'serviceLogon'
  if ([string](Get-Key $s 'status') -ceq 'SERVICE_LOGON_GRANTED') { return }
  Stop-Host 'SERVICE_LOGON_RIGHT_NOT_GRANTED' ([ordered]@{ step = (Get-Key $s 'step'); ntStatus = (Get-Key $s 'ntStatus'); win32 = (Get-Key $s 'win32')
    registrarCode = (Get-Key $s 'registrarCode'); detail = (Get-Key $s 'detail'); rights = (Get-Key $s 'rights'); recorded = ($null -ne $s) })
}
# The error id a PowerShell child that threw printed on stderr ("+ FullyQualifiedErrorId : <id>"): its code when it threw one.
function Get-ChildErrorId([string]$stderr) {
  $m = [regex]::Match([string]$stderr, '(?m)^\s*\+\s*FullyQualifiedErrorId\s*:\s*([A-Za-z][A-Za-z0-9_.:,-]{0,120})\s*$')
  if ($m.Success) { $m.Groups[1].Value } else { $null }
}
# ---- the companion's GitHub token ("package branch, two points" B): taken in the credentials step with the other credentials, kept nowhere but the companion's
# own isolated gh configuration (never in facts.json: whether it is in place is read from that configuration itself). Its one writer is the
# package's login script (windows\companion-gh-login.ps1), run as a child (Invoke-Native, H1) with the kit's ghExe; a token goes to it on
# standard input only. Every check after a write is the script's offline one (shape and isolation; nothing on the network).
function Invoke-CompanionGhLogin([string]$gl, [string]$mode, [string[]]$more, [string]$profileDir, [string]$sid, [string]$ghExe, [byte[]]$stdin = $null) {
  $r = Invoke-Native $PowerShellExe (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $gl, ('-' + $mode)) + @($more) + @('-ProfileDirectory', $profileDir, '-AccountSid', $sid, '-GhExe', $ghExe)) 900 $Utf8 $false $stdin
  [ordered]@{ mode = $mode; exit = $r.exit; status = $(if ([string]$r.stdout -match '"status":\s*"([A-Za-z_:,-]+)"') { $Matches[1] } else { $null }); errorId = (Get-ChildErrorId $r.stderr) }
}
# Where the token comes from, in this order (B3): in place in the companion's profile (nothing to do); the Owner's own companion token
# (the login script copies it; no dialog: a node reinstalled from scratch, TURING's fallback, asks the Owner for nothing); else it is asked
# for with the other credentials ('ask'). An Owner token the script refuses to copy for any other reason (a link, a hard link, another
# SID, a refused profile) ends P1 by name: it never falls through to a dialog.
function Resolve-CompanionTokenSource([string]$gl, [string]$profileDir, [string]$sid, [string]$ghExe) {
  $c = Invoke-CompanionGhLogin $gl 'Check' @('-Offline') $profileDir $sid $ghExe
  if ($c.exit -eq 0 -and $c.status -ceq 'COMPANION_GH_LOGIN_READY') { return 'in-place' }
  $o = Invoke-CompanionGhLogin $gl 'CopyFromOwner' @() $profileDir $sid $ghExe
  if ($o.exit -eq 0 -and $o.status -ceq 'COMPANION_GH_LOGIN_COPIED') {
    $c = Invoke-CompanionGhLogin $gl 'Check' @('-Offline') $profileDir $sid $ghExe
    if ($c.exit -eq 0 -and $c.status -ceq 'COMPANION_GH_LOGIN_READY') { return 'owner-copied' }
    Stop-Host 'COMPANION_TOKEN_NOT_IN_PLACE' $c
  }
  if ($null -eq $o.errorId -and @('COMPANION_GH_OWNER_TOKEN_MISSING', 'COMPANION_GH_OWNER_TOKEN_NOT_CLASSIC') -ccontains [string]$o.status) { return 'ask' }
  Stop-Host 'COMPANION_TOKEN_OWNER_COPY_REFUSED' $o
}
# 'ask': the credential directory's companion-github.token (the drill's synthetic input; the directory is held to its ACL by the caller),
# else the Windows credential dialog. Nothing given: CREDENTIAL_MISSING; not a classic token: CREDENTIAL_NOT_ITS_KIND. Never written here.
function Read-CompanionTokenInput([string]$credentialDirectory) {
  $b = $null
  if ($credentialDirectory) { $f = Join-Path $credentialDirectory $script:CredentialList.files['companionToken']; if ([IO.File]::Exists($f)) { $b = [IO.File]::ReadAllBytes($f) } }
  else { $b = Read-TokenFromDialog 'companion GitHub (classic token, repo scope)' }
  if ($null -eq $b -or $b.Length -eq 0) { if ($script:CredentialList.required.Contains('companionToken')) { Stop-Host 'CREDENTIAL_MISSING' @('companionToken') }; return $null }
  $ok = try { $Strict8.GetString($b).Trim() -cmatch '^ghp_[A-Za-z0-9]{36}\z' } catch { $false }
  if (-not $ok) { [Array]::Clear($b, 0, $b.Length); Stop-Host 'CREDENTIAL_NOT_ITS_KIND' 'companionToken' }
  , ([byte[]]$Utf8.GetBytes($Strict8.GetString($b).Trim()))
}
function Write-CompanionToken([string]$gl, [string]$profileDir, [string]$sid, [string]$ghExe, [byte[]]$token) {
  $w = Invoke-CompanionGhLogin $gl 'Login' @('-TokenFromStdin') $profileDir $sid $ghExe $token
  if ($w.exit -ne 0 -or $w.status -cne 'COMPANION_GH_LOGIN_STORED') { Stop-Host 'COMPANION_TOKEN_NOT_WRITTEN' $w }
  $c = Invoke-CompanionGhLogin $gl 'Check' @('-Offline') $profileDir $sid $ghExe
  if ($c.exit -ne 0 -or $c.status -cne 'COMPANION_GH_LOGIN_READY') { Stop-Host 'COMPANION_TOKEN_NOT_IN_PLACE' $c }
}
# gh's path: the kit's companion configuration (config.companion, base64 of the companion input) ghExe, the field the companion and the
# installer read: the one source. Throws KIT_GH_EXE_REFUSED.
function Get-KitGhExe([string]$kitText) {
  $p = try {
    $k = (New-Object Web.Script.Serialization.JavaScriptSerializer -Property @{ MaxJsonLength = [int]::MaxValue }).DeserializeObject($kitText)
    $c = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject((New-Object Text.UTF8Encoding($false, $true)).GetString([Convert]::FromBase64String([string](Get-Key (Get-Key $k 'config') 'companion'))).TrimStart([char]0xFEFF))
    [string](Get-Key $c 'ghExe')
  } catch { '' }
  if ($p -cnotmatch '^[A-Z]:\\[^"''\r\n;]+\\gh\.exe\z') { throw 'KIT_GH_EXE_REFUSED' }
  $p
}
# The two Windows tools the companion runs (B5), installed from the pinned, staged installer only when absent; then the file must be at its
# path. $run: the installer's run (or $null: present already); a restart the installer asks for: RESTART (the same command after it).
function Get-ToolInstallCode([string]$tool, $run, [bool]$present, [int[]]$restartExits) {
  if ($null -ne $run -and @($restartExits) -contains [int]$run.exit) { return 'RESTART' }
  if ($null -ne $run -and $run.exit -ne 0) { return ($tool + '_INSTALL_FAILED') }
  if (-not $present) { return ($tool + '_NOT_AT_THE_EXPECTED_PATH') }
  $null
}
# ---- the execution policy baseline (section 3.2; Get-ExecutionPolicyBaseline)
# The one writer: $policy as REG_SZ ExecutionPolicy under $key in the 64-bit view of $hive, read back. The host passes LocalMachine and
# $ExecutionPolicyKey (the 64-bit Windows PowerShell held-record.mjs starts reads that view); the tests a temporary key under HKCU.
function Set-ExecutionPolicyValue([string]$hive, [string]$key, [string]$policy) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hive, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $k = $base.CreateSubKey($key)
    try { $k.SetValue('ExecutionPolicy', $policy, [Microsoft.Win32.RegistryValueKind]::String); $back = [string]$k.GetValue('ExecutionPolicy') } finally { $k.Dispose() }
  } finally { $base.Dispose() }
  if ($back -cne $policy) { throw ('EXECUTION_POLICY_READBACK:' + $back) }
  $back
}
# The probe (Get-PolicyProbeStart): its script written next to it, started with exactly that environment, stdout and stderr read apart.
# On timeout nothing is killed (timedOut; H1's rule).
function Invoke-PolicyProbe($start, [int]$seconds = 120) {
  $probe = [string]@($start.arguments)[-1]
  [IO.File]::WriteAllText($probe, "[Console]::Out.Write('CLUED_EXECUTION_POLICY_PROBE ' + [string](Get-ExecutionPolicy))`r`n", (New-Object Text.ASCIIEncoding))
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $start.file; $psi.Arguments = ((@($start.arguments) | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = 'C:\Windows\System32'
  $psi.EnvironmentVariables.Clear(); foreach ($k in @($start.environment.Keys)) { $psi.EnvironmentVariables[$k] = [string]$start.environment[$k] }
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($seconds * 1000)) { return [ordered]@{ exit = $null; stdout = ''; stderr = ''; timedOut = $true } }
  $p.WaitForExit()
  $err = [string]$e.Result; if ($err.Length -gt 1500) { $err = $err.Substring($err.Length - 1500) }
  [ordered]@{ exit = $p.ExitCode; stdout = [string]$o.Result; stderr = $err; timedOut = $false }
}
# The step: decide (Get-ExecutionPolicyBaseline), write only for 'set', list every scope again, then the probe in $probeDir (a new
# directory the caller made and removes). Its answer is the step's detail: action, before, written, after, probe, and the refusal code.
function Invoke-ExecutionPolicyBaseline($list, [string]$hive, [string]$key, [string]$probeDir, [string]$powershell) {
  $b = Get-ExecutionPolicyBaseline $list
  $r = [ordered]@{ action = $b.action; code = $b.code; before = $b.scopes; written = $null; after = $null; probe = $null }
  if ($b.code) { return $r }
  if ($b.action -ceq 'set') { $r.written = Set-ExecutionPolicyValue $hive $key 'RemoteSigned' }
  $r.after = (Get-ExecutionPolicyCheck (Get-ExecutionPolicy -List)).scopes
  $run = Invoke-PolicyProbe (Get-PolicyProbeStart $powershell (Join-Path $probeDir 'probe.ps1') $probeDir)
  $res = Get-PolicyProbeResult $run
  $r.probe = [ordered]@{ code = $res.code; effective = $res.effective; exit = $run.exit; timedOut = $run.timedOut; stderr = $run.stderr }
  if ($res.code) { $r.code = $res.code }
  $r
}
# ---- the node's identity keys (N7; Get-NodeKeyPlan)
# What is on this machine, read with the packaged registration script's own Find-MachineKey: its functions and its three names taken from
# the file by the parser (never a copy), its Fail (which exits) replaced here by one that throws; all of it local to this function. Per
# key: $null (absent), 'unreadable' (Find-MachineKey refused: KEY_ACCESS_DENIED), or {origin, valid} (valid: the public blob is the P-256
# key of its role); tpmUsable: the TPM provider answered a lookup. $names: other key names (the tests only). Nothing is created or opened
# for writing.
function Get-NodeKeyObservation([string]$registrationScript, $names = $null) {
  Add-Type -AssemblyName System.Core
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($registrationScript, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw 'NODE_KEY_SCRIPT_PARSE_ERRORS' }
  foreach ($wanted in @('ConvertTo-Base64Url', 'ConvertFrom-EccPublicBlob', 'Get-Providers', 'Find-MachineKey')) {
    $found = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $wanted }, $true))
    if ($found.Count -ne 1) { throw ('NODE_KEY_SCRIPT_FUNCTION_NOT_ONE:' + $wanted) }
    . ([scriptblock]::Create($found[0].Extent.Text))
  }
  foreach ($wanted in @('KeyNames', 'TpmProviderName', 'Magic')) {
    $found = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] -and $x.Left.Extent.Text -ceq ('$' + $wanted) }, $false))
    if ($found.Count -ne 1) { throw ('NODE_KEY_SCRIPT_ASSIGNMENT_NOT_ONE:' + $wanted) }
    . ([scriptblock]::Create($found[0].Extent.Text))
  }
  function Fail([string]$Code, [string]$Detail) { throw ($Code + ': ' + $Detail) }
  if ($null -ne $names) { $KeyNames = $names }
  $tpmUsable = $false
  foreach ($entry in Get-Providers) {
    if ($entry[1] -cne 'tpm') { continue }
    try { $null = [Security.Cryptography.CngKey]::Exists(('Clued-CI-Node-Lookup-' + [Guid]::NewGuid().ToString('N')), $entry[0], [Security.Cryptography.CngKeyOpenOptions]::MachineKey); $tpmUsable = $true } catch { }
  }
  $o = [ordered]@{ identity = $null; encryption = $null; tpmUsable = $tpmUsable }
  foreach ($role in @('identity', 'encryption')) {
    $key = try { Find-MachineKey $KeyNames[$role] } catch { 'unreadable' }
    if ($key -is [string]) { $o[$role] = 'unreadable'; continue }
    if ($null -eq $key) { continue }
    $valid = try { $null = ConvertFrom-EccPublicBlob ($key.key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) $Magic[$role]; $true } catch { $false }
    try { $key.key.Dispose() } catch { }
    $o[$role] = [ordered]@{ origin = [string]$key.origin; valid = $valid }
  }
  $o
}
# The key step: observe, decide (Get-NodeKeyPlan); only when both are absent the packaged script's init-keys, the identity key in the TPM
# only, then the same observation and rule again: both present, or HOST_NODE_KEY_NOT_CREATED. The private keys are never exported (the
# identity key's never leaves the TPM); nothing is printed but their origins. The keys are not removed by -Reset or an uninstall: a re-run
# finds them and keeps them.
function Invoke-NodeKeyStep([string]$registrationScript, [string]$powershell) {
  $before = Get-NodeKeyObservation $registrationScript
  $plan = Get-NodeKeyPlan $before
  $r = [ordered]@{ action = $plan.action; code = $plan.code; before = $before; after = $null; run = $null }
  if ($plan.action -cne 'create') { return $r }
  $run = Invoke-Native $powershell @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $registrationScript, '-Mode', 'init-keys', '-ConfirmCreateKeys', '-KeyProvider', 'tpm') 600
  $r.run = [ordered]@{ exit = $run.exit; stderr = $run.stderr }
  $r.after = Get-NodeKeyObservation $registrationScript
  if ($run.exit -ne 0 -or (Get-NodeKeyPlan $r.after).action -cne 'present') { $r.action = $null; $r.code = 'HOST_NODE_KEY_NOT_CREATED'; return $r }
  $r.action = 'created'
  $r
}
function Get-ObservedResidue([bool]$factsPresent) {
  $sddl = try { (Get-Acl -LiteralPath $CiRoot).Sddl } catch { '' }
  [ordered]@{ services = @(Get-Service -Name 'CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    firewallRule = [bool](Get-NetFirewallRule -Name 'CluedCIResident-BlockOutbound' -ErrorAction SilentlyContinue)
    companionTask = [bool](Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -ErrorAction SilentlyContinue); residentRoot = [IO.Directory]::Exists($ResidentRoot)
    residentAce = ($sddl -and (Test-CiRootHasResidentAce $sddl (Get-ServiceSid 'CluedCIResident')))
    keptRoots = @($(if ([IO.Directory]::Exists($CiRoot)) { Get-ChildItem -LiteralPath $CiRoot -Directory -Force | Where-Object { $_.Name -like 'resident-uninstalled-*' } | ForEach-Object { $_.Name } }))
    ciTokenWithoutFacts = ([IO.File]::Exists($SecretTargets['ciToken']) -and -not $factsPresent)
    vhdxTargetNotEmpty = ([IO.Directory]::Exists($VhdxDirectory) -and @(Get-ChildItem -LiteralPath $VhdxDirectory -Force).Count -gt 0)
    companionDistribution = (Get-CompanionDistributionState) }
}

function Assert-CiInstallBaseline([string]$ciRoot) {
  $file = Join-Path $ciRoot 'secrets\ci-admission.connection.json'
  try { [void][IO.File]::GetAttributes($file) }
  catch [IO.FileNotFoundException] { return }
  catch [IO.DirectoryNotFoundException] { return }
  catch { throw 'CI_CONNECTION_RECORD_REFUSED' }
  throw 'CI_CONNECTION_REINSTALL_BASELINE_REQUIRED'
}

function Get-KitControllerNodeSha256([string]$kitFile, [string]$kitSha) {
  $bytes = [IO.File]::ReadAllBytes($kitFile)
  if ((Sha256Bytes $bytes) -cne $kitSha) { throw 'FIRST_INSTALL_KIT_CHANGED' }
  $reader = New-Object Web.Script.Serialization.JavaScriptSerializer -Property @{ MaxJsonLength = [int]::MaxValue }
  $pin = Get-Key (Get-Key ($reader.DeserializeObject($Strict8.GetString($bytes))) 'record') 'controllerNodeSha256'
  if ($pin -cnotmatch '^[0-9a-f]{64}$') { throw 'FIRST_INSTALL_CONTROLLER_NODE_REFUSED' }
  $pin
}

function Read-PreservedConnection([string]$controllerSid) {
  $resident = Join-Path $Tree 'work\independent-ci-resident-v1'
  . (Join-Path $resident 'rollout\fleet\package-lifecycle.ps1')
  $root = $FleetResources.journalRoot
  if ($Reset -or $CredentialDirectory -or -not $PreservedNodeExe -or
      [IO.Path]::GetDirectoryName($PreservedCarrierDirectory) -ine $root -or
      [IO.Path]::GetFileName($PreservedCarrierDirectory) -cnotmatch '^connection-[0-9a-f]{32}$') {
    throw 'FLEET_PRESERVED_INPUT_REFUSED'
  }
  Assert-FleetLocalPath $PreservedConnectionFile
  Assert-FleetLocalPath $PreservedNodeExe
  if ((Get-Item -LiteralPath $PreservedConnectionFile -Force).Length -gt 8192 -or
      (Sha256File $PreservedNodeExe) -cne (Get-KitControllerNodeSha256 $Kit $KitSha256)) { throw 'FLEET_PRESERVED_INPUT_REFUSED' }
  $data = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText($PreservedConnectionFile))
  $record = Get-Key $data 'nodeRecord'
  $upgrade = Get-Key $data 'upgradeToken'
  $heartbeat = Get-Key $data 'heartbeatToken'
  $uuid = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  foreach ($ref in @('ciPrincipalBindingId','ciPrincipalRoleRef','ciPrincipalQualificationRef')) {
    if ((Get-Key $record $ref) -cnotmatch $uuid) { throw 'FLEET_PRESERVED_BINDING_REFUSED' }
  }
  if ($null -ne $heartbeat -and (Get-Key $heartbeat 'bindingId') -cnotmatch $uuid) { throw 'FLEET_PRESERVED_BINDING_REFUSED' }
  $oldNode = $script:NodeExe
  $oldTool = $script:FingerprintTool
  $script:NodeExe = $PreservedNodeExe
  $script:FingerprintTool = Join-Path $resident 'tools\secret-fingerprint.mjs'
  $carriers = [ordered]@{}
  try {
    $specs = @(@('appKey','app-key',$record['appPublicKeySha256Base64'],$SecretTargets['appKey']),
      @('ciToken','ci-token',$record['ciTokenPinSha256'],$SecretTargets['ciToken']),
      @('upgradeToken','ci-token',(Get-Key $upgrade 'fingerprint'),(Join-Path $PreservedCarrierDirectory $script:CredentialList.files['upgradeToken'])))
    if ($null -ne $heartbeat) {
      $specs += ,@('heartbeatToken','heartbeat-token',(Get-Key $heartbeat 'fingerprint'),(Join-Path $PreservedCarrierDirectory $script:CredentialList.files['heartbeatToken']))
    }
    foreach ($spec in $specs) {
      $file = Get-FleetConnectionCarrier $spec[3]
      if ($null -eq $file -or -not $spec[2] -or
          ($SecretTargets.Contains($spec[0]) -and -not (Test-SddlIs (Get-Acl -LiteralPath $file.FullName -ErrorAction Stop).Sddl (Get-SecretFileSddl $controllerSid))) -or
          (Get-SecretFingerprint $null $spec[1] $file.FullName) -cne $spec[2]) { throw ('FLEET_PRESERVED_CARRIER_REFUSED:' + $spec[0]) }
      if (-not $SecretTargets.Contains($spec[0])) { $carriers[$spec[0]] = $file.FullName }
    }
  } finally { $script:NodeExe = $oldNode; $script:FingerprintTool = $oldTool }
  $appKeyId = 0L
  if (-not [long]::TryParse([string](Get-Key $record 'appKeyId'), [ref]$appKeyId) -or $appKeyId -lt 1) { throw 'FLEET_PRESERVED_APP_KEY_ID_REFUSED' }
  @{
    nodeRecord = [ordered]@{ appKeyId = $appKeyId; appPublicKeySha256Base64 = $record['appPublicKeySha256Base64']
      ciPrincipalBindingId = $record['ciPrincipalBindingId']; ciPrincipalQualificationRef = $record['ciPrincipalQualificationRef']
      ciPrincipalRoleRef = $record['ciPrincipalRoleRef']; ciTokenPinSha256 = $record['ciTokenPinSha256'] }
    credentials = [ordered]@{ heartbeatToken = $heartbeat; upgradeToken = $upgrade }
    carriers = $carriers
  }
}

function Invoke-HostPreparation {
  # the credential list (data next to this script, in the archive under its hash), read before anything else is done
  Enter-Step 'credential-files'
  $script:CredentialList = try { Read-CredentialFiles (Join-Path $PSScriptRoot 'credential-files.json') } catch { Stop-Host ([string]$_.Exception.Message) $PSScriptRoot }
  Step 'credential-files' ([ordered]@{ required = @($script:CredentialList.required.Keys); optional = @($script:CredentialList.optional.Keys) })
  # the execution policy as every scope says it (read only; a group policy that enforces Restricted or AllSigned is refused here)
  Enter-Step 'execution-policy'
  $policy = Get-ExecutionPolicyCheck (Get-ExecutionPolicy -List)
  if ($policy.code) { Stop-Host $policy.code $policy.scopes }
  Step 'execution-policy' $policy.scopes
  # the operator: elevated, and the account the bootstrap ran as (M4), before anything else
  Enter-Step 'operator'
  $wi = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($wi)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Stop-Host 'RUN_ELEVATED' $null }
  if (-not $CheckPreservedConnection) { Assert-CiInstallBaseline $CiRoot }
  $operator = $wi.User.Value
  $oc = Test-ExpectedOperator $operator $ExpectedOperatorSid
  if ($oc) { Stop-Host $oc ([ordered]@{ elevatedAs = $operator; bootstrapRanAs = $ExpectedOperatorSid }) }
  foreach ($a in @($Tree, $PrereqDirectory, $PrereqManifest, $Kit)) { if (-not $a) { Stop-Host 'USAGE' $null } }
  foreach ($h in @($PrereqManifestSha256, $KitSha256, $ToolchainNodeSha256, $RegistrarSha256)) { if ($h -cnotmatch '^[0-9a-f]{64}$') { Stop-Host 'USAGE' 'pinned sha256 required (install.mjs first-install-check)' } }
  Step 'operator' $operator
  $preserved = $null
  if ($PreservedConnectionFile -or $CheckPreservedConnection) {
    $controller = Get-LocalUser -Name 'clued-control' -ErrorAction Stop
    $preserved = Read-PreservedConnection $controller.SID.Value
    if ($CheckPreservedConnection) {
      $companion = Get-LocalUser -Name $CompanionAccountName -ErrorAction Stop
      . (Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet\package-lifecycle.ps1')
      $profile = Get-FleetProfileDirectory $companion.SID.Value
      if (-not $profile -or (Sha256File $Kit) -cne $KitSha256) { throw 'FLEET_PRESERVED_COMPANION_LOGIN_REFUSED' }
      $gh = Get-KitGhExe ([IO.File]::ReadAllText($Kit))
      $script = Join-Path $Tree 'work\independent-ci-resident-v1\windows\companion-gh-login.ps1'
      $login = Invoke-CompanionGhLogin $script 'Check' @('-Offline') $profile $companion.SID.Value $gh
      if ($login.exit -ne 0 -or $login.status -cne 'COMPANION_GH_LOGIN_READY') { throw 'FLEET_PRESERVED_COMPANION_LOGIN_REFUSED' }
      ConvertTo-JsonLine ([ordered]@{ status = 'PRESERVED_CONNECTION_CARRIERS_VERIFIED' })
      return
    }
  }
  Enter-Step 'residue'
  $factsFile = Join-Path $FirstDir 'facts.json'
  $js = New-Object Web.Script.Serialization.JavaScriptSerializer
  $old = if ([IO.File]::Exists($factsFile)) { $js.DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes($factsFile))) } else { $null }
  # residue (M5); -Reset needs only that no resident is there
  $observed = Get-ObservedResidue ($null -ne $old)
  if ($preserved) {
    if ($null -ne $old) { Stop-Host 'FLEET_PRESERVED_INSTALL_RESIDUE' $null }
    $observed['ciTokenWithoutFacts'] = $false
  }
  $res = Get-ResidueCodes $observed
  if (-not $Reset -and $res.Count) { Stop-Host 'FIRST_INSTALL_RESIDUE_PRESENT' ([ordered]@{ found = $res; next = 'a first install needs a clean machine: a node with a resident is reinstalled; leftovers of an uninstalled one (named above) are removed by a person first' }) }
  Step 'residue' $(if ($res.Count) { $res } else { 'none' })
  if (-not $Reset) {
    # the execution policy baseline (section 3.2): the first thing written, once the operator is the expected one and the machine is a
    # clean one; LocalMachine RemoteSigned when it is Undefined, Restricted or AllSigned, then proved by a probe started as the frozen
    # Source starts its PowerShell (a -Reset run only removes, and changes nothing here)
    Enter-Step 'execution-policy-baseline'
    $probeDir = Join-Path 'C:\Windows\Temp' ('clued-p1-policy-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Dir $probeDir (Get-AdminOnlySddl)
    $probePowerShell = if ([Environment]::Is64BitProcess) { $PowerShellExe } else { 'C:\Windows\Sysnative\WindowsPowerShell\v1.0\powershell.exe' }
    try { $baseline = Invoke-ExecutionPolicyBaseline (Get-ExecutionPolicy -List) 'LocalMachine' $ExecutionPolicyKey $probeDir $probePowerShell }
    finally { Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($baseline.code -ceq 'HOST_EXECUTION_POLICY_NOT_EFFECTIVE') { Stop-Host 'HOST_EXECUTION_POLICY_NOT_EFFECTIVE' $baseline }
    if ($baseline.code) { Stop-Host $baseline.code $baseline }
    Step 'execution-policy-baseline' $baseline
  }
  Enter-Step 'stage'
  # stage: what this elevated run uses, copied into an admin-only directory and held to the pins
  $stage = Join-Path 'C:\Windows\Temp' ('clued-p1-' + [Guid]::NewGuid().ToString('N'))
  $null = New-Dir $stage (Get-AdminOnlySddl)
  try {
    $man = $js.DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes((Copy-Verified $PrereqManifest (Join-Path $stage 'prereq-manifest.json') $PrereqManifestSha256 $null))))
    $items = @{}; foreach ($i in @(Get-Key $man 'items')) { $items[[string](Get-Key $i 'name')] = $i }
    $staged = @{}
    foreach ($n in @('node', 'ubuntu-rootfs', 'actions-runner', 'linux-node', 'wsl', 'gh', 'git-for-windows')) {
      if ($n -ceq 'node' -and $BootstrapNodeExe) { continue }   # bootstrap supplied the verified Windows executable
      $i = $items[$n]; if ($null -eq $i -or [string](Get-Key $i 'sha256') -cnotmatch '^[0-9a-f]{64}$') { Stop-Host 'PREREQ_NOT_PINNED' $n }
      $staged[$n] = Copy-Verified (Join-Path $PrereqDirectory $i['fileName']) (Join-Path $stage $i['fileName']) $i['sha256'] $i['bytes']
    }
    $debDir = Join-Path $stage 'debs'; $null = New-Dir $debDir (Get-AdminOnlySddl)
    foreach ($d in @(Get-Key $man 'debs')) { $null = Copy-Verified (Join-Path (Join-Path $PrereqDirectory 'debs') $d['fileName']) (Join-Path $debDir $d['fileName']) $d['sha256'] $d['bytes'] }
    $debList = Join-Path $stage 'debs.sha256'
    [IO.File]::WriteAllText($debList, (Get-DebListText @(Get-Key $man 'debs')), $Utf8)
    $R = Join-Path $Tree 'work\independent-ci-resident-v1'
    $script:FingerprintTool = Join-Path $R 'tools\secret-fingerprint.mjs'
    $script:InstallMjs = Join-Path $R 'rollout\fleet\install.mjs'
    $kitCopy = Copy-Verified $Kit (Join-Path $stage 'first-install-kit.json') $KitSha256 $null
    if ($BootstrapNodeExe) {
      $controllerSha = Get-KitControllerNodeSha256 $kitCopy $KitSha256
      $script:NodeExe = Copy-Verified $BootstrapNodeExe (Join-Path $stage 'node.exe') $controllerSha $null
    } else {
      $nodeDir = Join-Path $stage 'node'
      Expand-HostZip $staged['node'] $nodeDir
      $ne = @(Get-ChildItem -LiteralPath $nodeDir -Recurse -Filter node.exe | ForEach-Object { $_.FullName })
      if ($ne.Count -ne 1) { Stop-Host 'NODE_NOT_ONE' $ne.Count }
      $script:NodeExe = $ne[0]
    }
    $GhExe = try { Get-KitGhExe ($Strict8.GetString([IO.File]::ReadAllBytes($kitCopy))) } catch { Stop-Host 'KIT_GH_EXE_REFUSED' $null }
    Step 'stage' $stage
    if ($Reset) { Enter-Step 'reset'; Invoke-Reset $old $observed $operator; return }
    Enter-Step 'v1-base'
    # v1 base: what Windows itself must have for the installer
    $base = [ordered]@{ csc = [IO.File]::Exists('C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe')
      localAccounts = [IO.Directory]::Exists('C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts')
      netSecurity = [IO.File]::Exists('C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1')
      scheduledTasks = [IO.File]::Exists('C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'); secedit = [IO.File]::Exists('C:\Windows\System32\SecEdit.exe') }
    $vb = Get-V1BaseCodes $base
    if ($vb.Count) { Stop-Host 'V1_BASE_MISSING' $vb }
    Step 'v1-base' 'present'
    Enter-Step 'node-key-check'
    # N7, read only: the node's two identity keys as the packaged registration script finds them (Get-NodeKeyObservation). One of them,
    # the identity key not in the TPM, either not valid or not readable, or none and no usable TPM, is refused here, before anything is
    # installed.
    $NodeKeyScript = Join-Path $R 'registration\export-node-registration.ps1'
    $nodeKeys = try { Get-NodeKeyObservation $NodeKeyScript } catch { Stop-Host 'HOST_NODE_KEY_SCRIPT_REFUSED' ([string]$_.Exception.Message) }
    $nodeKeyPlan = Get-NodeKeyPlan $nodeKeys
    if ($nodeKeyPlan.code) { Stop-Host $nodeKeyPlan.code $nodeKeys }
    Step 'node-key-check' ([ordered]@{ plan = $nodeKeyPlan.action; observed = $nodeKeys })
    Enter-Step 'wsl'
    # WSL at the pinned version (M7)
    $wantWsl = [string](Get-Key $items['wsl'] 'version')
    $have = Get-WslVersion ((Invoke-Native $Wsl @('--version') 120 ([Text.Encoding]::Unicode)).stdout)
    if ($have -cne $wantWsl) {
      $mi = Invoke-Native 'C:\Windows\System32\msiexec.exe' @('/i', $staged['wsl'], '/qn', '/norestart') 1800
      if ($mi.exit -eq 3010) { Exit-Restart 'WSL installed' @([ordered]@{ installer = ('msiexec /i ' + [IO.Path]::GetFileName($staged['wsl'])); exit = $mi.exit }) }
      if ($mi.exit -ne 0) { Stop-Host 'WSL_MSI_FAILED' ([ordered]@{ exit = $mi.exit; stderr = $mi.stderr }) }
      $have = Get-WslVersion ((Invoke-Native $Wsl @('--version') 120 ([Text.Encoding]::Unicode)).stdout)
      if ($have -cne $wantWsl) { Stop-Host 'WSL_VERSION_NOT_THE_PINNED' ([ordered]@{ want = $wantWsl; have = $have }) }
    }
    Step 'wsl' $have
    Enter-Step 'features'
    # features (a restart: run the same command again), power
    $needRestart = $false; $restarts = @()
    foreach ($feature in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')) {
      $info = Invoke-Native 'C:\Windows\System32\dism.exe' @('/English', '/online', '/get-featureinfo', ('/featurename:' + $feature)) 600
      if ($info.stdout -notmatch 'State : Enabled') {
        $en = Invoke-Native 'C:\Windows\System32\dism.exe' @('/English', '/online', '/enable-feature', ('/featurename:' + $feature), '/all', '/norestart') 3600
        if ($en.exit -eq 3010) { $needRestart = $true; $restarts += [ordered]@{ installer = ('dism /enable-feature /featurename:' + $feature); exit = $en.exit } } elseif ($en.exit -ne 0) { Stop-Host 'WINDOWS_FEATURE_ENABLE_FAILED' ([ordered]@{ feature = $feature; exit = $en.exit; stderr = $en.stderr }) }
      }
    }
    if ($needRestart) { Exit-Restart 'Windows features enabled' $restarts }
    $null = Invoke-Native 'C:\Windows\System32\powercfg.exe' @('/change', 'standby-timeout-ac', '0') 120; $null = Invoke-Native 'C:\Windows\System32\powercfg.exe' @('/hibernate', 'off') 120
    Step 'features' 'enabled; standby-ac 0, hibernate off'
    Enter-Step 'tools'
    # gh (at the kit's ghExe) and Git for Windows: the companion runs both; installed from the pinned installers when absent, then checked
    $tools = [ordered]@{}
    foreach ($t in @(@('GH', $GhExe, 'gh', @(3010)), @('GIT', $GitExe, 'git-for-windows', @(8)))) {
      $run = $null
      if (-not [IO.File]::Exists($t[1])) {
        $run = if ($t[2] -ceq 'gh') { Invoke-Native 'C:\Windows\System32\msiexec.exe' @('/i', $staged['gh'], '/qn', '/norestart') 1800 }
          else { Invoke-Native $staged['git-for-windows'] @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES') 1800 }
      }
      $code = Get-ToolInstallCode $t[0] $run ([IO.File]::Exists($t[1])) $t[3]
      if ($code -ceq 'RESTART') { Exit-Restart ($t[2] + ' installed') @([ordered]@{ installer = $(if ($t[2] -ceq 'gh') { 'msiexec /i ' + [IO.Path]::GetFileName($staged['gh']) } else { [IO.Path]::GetFileName($staged['git-for-windows']) + ' /VERYSILENT /NORESTART' }); exit = $run.exit }) }
      if ($code) { Stop-Host $code ([ordered]@{ path = $t[1]; exit = $(if ($run) { $run.exit } else { $null }); stderr = $(if ($run) { $run.stderr } else { $null }) }) }
      $tools[$t[2]] = [ordered]@{ path = $t[1]; action = $(if ($run) { 'installed' } else { 'present' }) }
    }
    Step 'tools' $tools
    Enter-Step 'accounts'
    # accounts
    foreach ($name in @('clued-control', 'clued-runner')) {
      $u = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
      if ($null -eq $u) { $u = New-LocalUser -Name $name -Password (ConvertTo-Secure (New-RandomPassword)) -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description 'Clued independent CI service account' }
      if (-not $u.Enabled) { Stop-Host 'SERVICE_ACCOUNT_DISABLED' $name }
      if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -ceq $u.SID.Value }).Count) { Stop-Host 'SERVICE_ACCOUNT_IS_AN_ADMINISTRATOR' $name }
    }
    $controllerSid = (Get-LocalUser -Name 'clued-control').SID.Value
    # clued-control never denied the right to log on as a service (install-resident.ps1 Test-ServiceLogonRight): read only, a USER_RIGHTS
    # export -- the policy is never written back here (Fable renew-key ruling, supplement "service logon grant")
    $rights = Join-Path $stage 'rights'; $null = New-Dir $rights (Get-AdminOnlySddl)
    $seExport = Invoke-Native 'C:\Windows\System32\secedit.exe' @('/export', '/areas', 'USER_RIGHTS', '/cfg', (Join-Path $rights 'now.inf')) 300
    if ($seExport.exit -ne 0 -or -not [IO.File]::Exists((Join-Path $rights 'now.inf'))) { Stop-Host 'USER_RIGHTS_UNREADABLE' ([ordered]@{ exit = $seExport.exit; stdout = $seExport.stdout; stderr = $seExport.stderr }) }
    $now = [IO.File]::ReadAllText((Join-Path $rights 'now.inf'))
    if (Test-DenyServiceLogon $now $controllerSid) { Stop-Host 'CONTROLLER_DENIED_LOGON_AS_A_SERVICE' 'SeDenyServiceLogonRight names clued-control: remove it (a policy decision, never made here)' }
    # the companion account by the package's own tool, its registrar held to the archive's pin (L2); the same registrar grants clued-control
    # its right to log on as a service and reads it back (-ServiceLogonSid)
    # (it keeps this console: its token step may read the clipboard; its own output in the console's code page)
    $prepRun = Invoke-Native $PowerShellExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $R 'windows\prepare-companion-account.ps1'), '-LogDirectory', (Join-Path $stage 'companion-log'), '-RegistrarSha256', $RegistrarSha256, '-AccountOnly', '-ServiceLogonSid', $controllerSid) 1800 ([Console]::OutputEncoding) $true
    $pr = Assert-CompanionPrepared $prepRun
    Assert-ServiceLogonGranted $pr
    $companionSid = [string](Get-Key (Get-Key $pr 'nodeProfile') 'ownerSid'); $companionProfile = [string](Get-Key (Get-Key $pr 'nodeProfile') 'ownerProfileDirectory')
    $nodeProfile = try { Get-NodeProfile ([Environment]::MachineName) $controllerSid $companionSid $companionProfile } catch { Stop-Host ([string]$_.Exception.Message) 'rename the machine to a name of 1-15 letters, digits and inner hyphens; no parameter changes it' }
    if ($operator -ceq $companionSid -or $operator -ceq $controllerSid) { Stop-Host 'OPERATOR_IS_A_SERVICE_ACCOUNT' $operator }
    Step 'accounts' ([ordered]@{ controllerSid = $controllerSid; companionSid = $companionSid; operatorSid = $operator })
    Enter-Step 'node-key'
    # N7: the two keys made by the packaged script (init-keys -KeyProvider tpm: identity in the TPM, encryption in software) when neither
    # is there; both there: kept
    $nodeKey = try { Invoke-NodeKeyStep $NodeKeyScript $PowerShellExe } catch { Stop-Host 'HOST_NODE_KEY_SCRIPT_REFUSED' ([string]$_.Exception.Message) }
    if ($nodeKey.code) { Stop-Host $nodeKey.code $nodeKey }
    Step 'node-key' $nodeKey
    Enter-Step 'ci-root'
    # CI root, formal-spool and its outgoing and incoming, first-install, credentials, the secrets folder (Get-CiRootDirectories)
    $ci = [ordered]@{}
    $dirs = Get-CiRootDirectories $operator $controllerSid
    foreach ($k in @($dirs.Keys)) { $ci[$k] = New-Dir $dirs[$k][0] $dirs[$k][1] }
    Step 'ci-root' $ci
    Enter-Step 'runner'
    # the carrier runner: binaries and a stopped, manual service as .\clued-control; never registered with GitHub
    $runnerDir = Join-Path $ControlRoot 'runner'
    $null = New-Dir $ControlRoot ('O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $controllerSid + ')')
    $null = New-Dir (Split-Path -Parent $SecretTargets['appKey']) (Get-SecretDirectorySddl $controllerSid)
    # M5: resumable and checked: a cut-off expansion is set aside and done again, a completed one is held to the pinned archive
    $runnerMark = Join-Path $ControlRoot 'runner.first-install-complete'
    $null = Expand-Verified $staged['actions-runner'] $runnerDir $runnerMark ([string]$items['actions-runner']['sha256']) $BootstrapRunnerDirectory
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
    Enter-Step 'distribution'
    # the distribution (the operator's WSL until the M5-b switch)
    $listed = (Invoke-Wsl @('--list', '--quiet') 120).stdout
    if (@($listed -split "`r?`n" | Where-Object { $_.Trim() -ceq $Distribution }).Count -eq 0) {
      if ([IO.Directory]::Exists($ImportDirectory) -and @(Get-ChildItem -LiteralPath $ImportDirectory -Force).Count) { Stop-Host 'IMPORT_DIRECTORY_NOT_EMPTY' $ImportDirectory }
      $null = New-Dir (Split-Path -Parent $ImportDirectory) ('O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $operator + ')')
      $null = New-Dir $ImportDirectory ('O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $operator + ')')
      $imp = Invoke-Wsl @('--install', '--from-file', $staged['ubuntu-rootfs'], '--name', $Distribution, '--location', $ImportDirectory, '--no-launch')
      if ($imp.exit -ne 0) { Stop-Host 'DISTRIBUTION_INSTALL_FAILED' ([ordered]@{ exit = $imp.exit; stderr = $imp.stderr; stdout = $imp.stdout }) }
    }
    Step 'distribution' ([ordered]@{ name = $Distribution; importDirectory = $ImportDirectory; switchTarget = $VhdxDirectory; account = 'operator' })
    Enter-Step 'linux'
    # Linux, as root (--exec)
    $hp = $null
    foreach ($attempt in 1..2) {
      $hp = Invoke-Root (To-WslPath (Join-Path $R 'linux\first-host-prep.sh')) @((To-WslPath $debDir), (To-WslPath $debList), (To-WslPath $staged['linux-node']), $ToolchainNodeSha256)
      if ($hp.exit -eq 2 -and $attempt -eq 1) { $null = Invoke-Wsl @('--terminate', $Distribution) 120; continue }   # systemd just enabled: this distribution only, never --shutdown
      break
    }
    if ($hp.exit -ne 0 -or $hp.stdout -notmatch '"status":"LINUX_HOST_READY"') { Stop-Host 'LINUX_HOST_NOT_READY' ([ordered]@{ stdout = $hp.stdout.Trim(); stderr = $hp.stderr }) }
    $mk = Invoke-Root (To-WslPath (Join-Path $R 'reinstall\linux\tools\make-result-key.sh')) @()
    if ($mk.exit -ne 0 -and $mk.stdout -notmatch 'KEY_EXISTS_PRESERVE') { Stop-Host 'RESULT_KEY_NOT_MADE' ([ordered]@{ stdout = $mk.stdout.Trim(); stderr = $mk.stderr }) }
    $ff = Invoke-Root (To-WslPath (Join-Path $R 'reinstall\linux\tools\first-install-facts.py')) @() '/usr/bin/python3.12'
    $lf = try { $js.DeserializeObject($ff.stdout) } catch { $null }
    $lc = Test-LinuxFirstInstallFacts $lf $ToolchainNodeSha256 ([string](Get-Key (Get-Key $old 'signer') 'publicKeyPem'))
    if ($ff.exit -ne 0 -or $lc.Count) { Stop-Host 'LINUX_NOT_A_FIRST_INSTALL_HOST' ([ordered]@{ codes = $lc; stderr = $ff.stderr }) }
    $pem = ([string]$lf['resultPublicKey']['pem']).Replace("`r`n", "`n")
    Step 'linux' 'ready'
    Enter-Step 'credentials'
    # the companion's token: in place, else the Owner's copied by the login script, else asked for below with the others (B3)
    $gl = Join-Path $R 'windows\companion-gh-login.ps1'
    $companionSource = if ($preserved) {
      $connection = Invoke-CompanionGhLogin $gl 'Check' @('-Offline') $nodeProfile.ownerProfileDirectory $nodeProfile.ownerSid $GhExe
      if ($connection.exit -ne 0 -or $connection.status -cne 'COMPANION_GH_LOGIN_READY') { Stop-Host 'FLEET_PRESERVED_COMPANION_LOGIN_REFUSED' $null }
      'present'
    } else { Resolve-CompanionTokenSource $gl $nodeProfile.ownerProfileDirectory $nodeProfile.ownerSid $GhExe }
    # credentials (H2): what is in place and recorded is only checked; what is asked for is checked whole before anything is written
    $state = [ordered]@{}
    foreach ($k in @('appKey', 'ciToken', 'upgradeToken', 'heartbeatToken')) { $state[$k] = if ($null -ne $old) { Get-SecretState $k $old $controllerSid } else { 'missing' } }
    $plan = Get-CredentialPlan ($null -ne $old) $state
    if ($preserved) { $plan = @{ mode = 'verify-only'; ask = @() } }
    if ($plan.mode -ceq 'refused') { Stop-Host $plan.code 'run bootstrap.ps1 -Reset first (it removes what this first install placed)' }
    $public = $null
    if ($plan.mode -cne 'verify-only') {
      if ($CredentialDirectory) {
        if (-not (Test-SddlIs (Get-Acl -LiteralPath $CredentialDirectory).Sddl (Get-AdminOnlySddl))) { Stop-Host 'CREDENTIAL_DIRECTORY_NOT_ADMIN_ONLY' $CredentialDirectory }
        foreach ($k in @($plan.ask)) { $f = Join-Path $CredentialDirectory $script:CredentialList.files[$k]; if ([IO.File]::Exists($f)) { $script:Secrets[$k] = [IO.File]::ReadAllBytes($f) } }
        if ($plan.mode -ceq 'collect-all') { $public = $js.DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes((Join-Path $CredentialDirectory $script:CredentialList.files['public'])))) }
      } else {
        foreach ($k in @($plan.ask)) {
          switch ($k) {
            'appKey' { $script:Secrets['appKey'] = Read-AppKeyFromDialog }
            'ciToken' { $script:Secrets['ciToken'] = Read-TokenFromDialog 'ci-admission' }
            'upgradeToken' { $script:Secrets['upgradeToken'] = Read-TokenFromDialog 'resident-upgrade' }
            'heartbeatToken' { $b = Read-TokenFromDialog (Get-HeartbeatPrompt ($null -ne $old -or $script:CredentialList.required.Contains('heartbeatToken'))); if ($b.Length) { $script:Secrets['heartbeatToken'] = $b } }
          }
        }
        if ($plan.mode -ceq 'collect-all') {
          $public = [ordered]@{ appKeyId = (Read-PublicFromDialog 'GitHub App key id (a number, shown next to the key on the App page)'); ciPrincipalBindingId = (Read-PublicFromDialog 'CI connection id (UUID, /oauth/connections)')
            ciPrincipalRoleRef = (Read-PublicFromDialog 'ciPrincipalRoleRef (Decision UUID)'); ciPrincipalQualificationRef = (Read-PublicFromDialog 'ciPrincipalQualificationRef (UUID)')
            heartbeatBindingId = $(if ($script:Secrets.Contains('heartbeatToken')) { Read-PublicFromDialog 'heartbeat connection id (UUID, or empty)' } else { '' }) }
        }
      }
      # L3: what facts.json records is required again (a recorded heartbeat token too); only a first run may give no heartbeat token
      $miss = Get-MissingCredentials $plan @($script:Secrets.Keys)
      if ($miss.Count) { Stop-Host 'CREDENTIAL_MISSING' $miss }
    }
    if ($companionSource -ceq 'ask') {
      if ($CredentialDirectory -and -not (Test-SddlIs (Get-Acl -LiteralPath $CredentialDirectory).Sddl (Get-AdminOnlySddl))) { Stop-Host 'CREDENTIAL_DIRECTORY_NOT_ADMIN_ONLY' $CredentialDirectory }
      $script:CompanionToken = Read-CompanionTokenInput $CredentialDirectory
    }
    $fps = [ordered]@{}
    foreach ($k in @($script:Secrets.Keys)) { $fps[$k] = Get-SecretFingerprintOf $k $script:Secrets[$k]; if (-not $fps[$k]) { Stop-Host 'CREDENTIAL_NOT_ITS_KIND' $k } }
    if ($preserved) {
      $nodeRecord = $preserved.nodeRecord; $cred = $preserved.credentials; $keyId = $null
    } elseif ($null -ne $old) {
      # every secret given now must be the one facts.json records; the rest of the draft is the facts' own
      foreach ($k in @($fps.Keys)) { if ($state[$k] -cne 'missing' -or $fps[$k] -cne (Get-SecretRecorded $k $old)) { Stop-Host 'SECRET_GIVEN_IS_NOT_THE_FACTS' $k } }
      $nodeRecord = $old['nodeRecord']; $cred = $old['credentials']; $keyId = [string]$old['signer']['keyId']
    } else {
      foreach ($k in @($FactsSecrets | Where-Object { $script:CredentialList.required.Contains($_) })) { if (-not $fps.Contains($k)) { Stop-Host 'CREDENTIAL_MISSING' $k } }
      $appKeyId = 0L; if (-not [long]::TryParse([string](Get-Key $public 'appKeyId'), [ref]$appKeyId)) { Stop-Host 'APP_KEY_ID_NOT_A_NUMBER' $null }
      $hbId = [string](Get-Key $public 'heartbeatBindingId'); if ($hbId -ceq '') { $hbId = $null }
      $nodeRecord = [ordered]@{ appKeyId = $appKeyId; appPublicKeySha256Base64 = $fps['appKey']; ciPrincipalBindingId = [string](Get-Key $public 'ciPrincipalBindingId')
        ciPrincipalQualificationRef = [string](Get-Key $public 'ciPrincipalQualificationRef'); ciPrincipalRoleRef = [string](Get-Key $public 'ciPrincipalRoleRef'); ciTokenPinSha256 = $fps['ciToken'] }
      $cred = [ordered]@{ heartbeatToken = $(if ($fps.Contains('heartbeatToken')) { [ordered]@{ bindingId = $hbId; fingerprint = $fps['heartbeatToken'] } } else { $null }); upgradeToken = [ordered]@{ fingerprint = $fps['upgradeToken'] } }
      $keyId = $null
    }
    $signer = Get-Signer $nodeProfile $pem ([DateTime]::UtcNow)
    if ($keyId) { $signer.keyId = $keyId }   # a re-run keeps the key day of the first run (the key is create-only: the same key)
    $facts = New-FirstInstallFacts $nodeProfile $operator $VhdxDirectory $nodeRecord $cred $signer ([ordered]@{ resultPublicKeySha256 = (Sha256Bytes ([Text.Encoding]::ASCII.GetBytes($pem))); toolchainNodeSha256 = $ToolchainNodeSha256 }) ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))
    if ($null -ne $old -and -not (Test-SameFacts $old $facts)) { Stop-Host 'FACTS_ALREADY_WRITTEN_DIFFER' 'this host is not the one facts.json describes: run bootstrap.ps1 -Reset first' }
    $draft = Join-Path $stage 'facts-draft.json'
    [IO.File]::WriteAllText($draft, (ConvertTo-JsonLine $facts) + "`n", $Utf8)
    $fc = Invoke-FactsCheck $draft
    if (-not $fc.ok) { Stop-Host 'FACTS_REFUSED' ([ordered]@{ result = $fc.result; stderr = $fc.stderr }) }
    # only now, in this order (M1): facts.json (whole or not at all, create-only), then the secrets, then the companion WSL record. A run
    # cut off between them leaves facts.json without (some) secrets: the next run asks for what is missing, held to the fingerprints it
    # records, and -Reset removes it; never the App key and the ci-admission token without the facts that say whose they are.
    if ($null -eq $old) { Write-NewFile $factsFile ($Utf8.GetBytes((ConvertTo-JsonLine $facts) + "`n")) (Get-FirstInstallSddl $operator) }
    if ($preserved) {
      foreach ($name in $preserved.carriers.Keys) {
        $target = Join-Path $CredDir $script:CredentialList.files[$name]
        Copy-PreservedCredential $preserved.carriers[$name] $target
      }
    }
    Write-Secrets $controllerSid
    # then the companion's token into its own isolated configuration (the login script; never in facts.json, never in credentials\)
    if ($companionSource -ceq 'ask' -and $null -ne $script:CompanionToken) { Write-CompanionToken $gl $nodeProfile.ownerProfileDirectory $nodeProfile.ownerSid $GhExe $script:CompanionToken }
    Clear-Secrets
    $cw = [ordered]@{ contract = 'clued.independent-ci.companion-wsl/1'; distro = $Distribution; target = ($ImportDirectory + '\ext4.vhdx'); companionSid = $nodeProfile.ownerSid; stage = 'owner-imported'; imported = $true; importedBy = $operator }
    $cwFile = Join-Path $FirstDir 'companion-wsl.json'
    if ([IO.File]::Exists($cwFile)) { if ($Strict8.GetString([IO.File]::ReadAllBytes($cwFile)).Trim() -cne (ConvertTo-JsonLine $cw)) { Stop-Host 'COMPANION_WSL_RECORD_ALREADY_WRITTEN_DIFFERS' $cwFile } }
    else { Write-NewFile $cwFile ($Utf8.GetBytes((ConvertTo-JsonLine $cw) + "`n")) (Get-FirstInstallSddl $operator) }
    Step 'credentials' ([ordered]@{ plan = $plan.mode; companionToken = $companionSource })
    ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_READY'; facts = $factsFile; factsSha256 = (Sha256File $factsFile); node = $nodeProfile.nodeName; credentials = $plan.mode })
  } finally {
    Clear-Secrets
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
function Get-SecretRecorded([string]$name, $facts) {
  switch ($name) {
    'appKey' { [string]$facts['nodeRecord']['appPublicKeySha256Base64'] } 'ciToken' { [string]$facts['nodeRecord']['ciTokenPinSha256'] }
    'upgradeToken' { [string]$facts['credentials']['upgradeToken']['fingerprint'] } 'heartbeatToken' { [string](Get-Key (Get-Key $facts['credentials'] 'heartbeatToken') 'fingerprint') }
  }
}
# -Reset: what this host preparation made, removed (Get-ResetPlan); nothing else.
function Invoke-Reset($old, $observed, [string]$operator) {
  $resident = Get-ResidueCodes ([ordered]@{ services = $observed.services; firewallRule = $observed.firewallRule; companionTask = $observed.companionTask; residentRoot = $observed.residentRoot })
  $controllerSid = try { (Get-LocalUser -Name 'clued-control').SID.Value } catch { $null }
  $cwFile = Join-Path $FirstDir 'companion-wsl.json'
  $cw = if ([IO.File]::Exists($cwFile)) { (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject($Strict8.GetString([IO.File]::ReadAllBytes($cwFile))) } else { $null }
  $registered = @((Invoke-Wsl @('--list', '--quiet') 120).stdout -split "`r?`n" | Where-Object { $_.Trim() -ceq $Distribution }).Count -gt 0
  $st = [ordered]@{ resident = $resident; factsPresent = ($null -ne $old)
    appKey = $(if ($null -ne $old -and $controllerSid) { Get-SecretState 'appKey' $old $controllerSid } else { 'missing' })
    ciToken = $(if ($null -ne $old -and $controllerSid) { Get-SecretState 'ciToken' $old $controllerSid } else { 'missing' })
    companionWsl = $cw; operator = $operator; distributionRegistered = $registered }
  $plan = Get-ResetPlan $st
  if ($plan.code) { Stop-Host $plan.code $plan.kept }
  $done = @()
  foreach ($a in @($plan.actions)) {
    switch ($a) {
      'remove-app-key' { [IO.File]::Delete($SecretTargets['appKey']) }
      'remove-ci-token' { [IO.File]::Delete($SecretTargets['ciToken']) }
      'unregister-distribution' { $u = Invoke-Wsl @('--unregister', $Distribution) 600; if ($u.exit -ne 0) { Stop-Host 'RESET_UNREGISTER_FAILED' ([ordered]@{ done = $done; stderr = $u.stderr }) } }
      'remove-import-directory' {
        $longPath = '\\?\' + $ImportDirectory
        if ([IO.Directory]::Exists($longPath)) { [IO.Directory]::Delete($longPath, $true) }
      }
      'remove-first-install-directory' {
        $longPath = '\\?\' + $FirstDir
        if ([IO.Directory]::Exists($longPath)) { [IO.Directory]::Delete($longPath, $true) }
      }
    }
    $done += $a
  }
  Step 'reset' ([ordered]@{ removed = $done; kept = @($plan.kept) })
  ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_RESET'; removed = $done; kept = @($plan.kept) })
}

$script:NodeExe = $null; $script:FingerprintTool = $null; $script:InstallMjs = $null; $script:Secrets = [ordered]@{}; $script:StepNow = $null; $script:CompanionToken = $null; $script:CredentialList = $null
if ($MyInvocation.InvocationName -ne '.') { Invoke-Host }
