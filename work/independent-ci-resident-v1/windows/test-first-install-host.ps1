<#
  Offline check of windows/first-install-host.ps1's pure functions (P1 of the first install): the node profile from the machine name,
  the signer convention, the CI root baseline DACL, the residue codes, the token fingerprints, the facts document and its check, the
  Linux facts it accepts. Nothing on the host is read or changed (no elevation, no WSL); the functions are taken from the real script
  by AST. Node is used only to hold two rules to the code they mirror: prepare-record.mjs#validateNodeProfile and
  tools/secret-fingerprint.mjs.
    powershell -NoProfile -ExecutionPolicy Bypass -File test-first-install-host.ps1 [-Node <node.exe>]
#>
param([string]$Node = 'node')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
$here = $PSScriptRoot
$script:n = 0; $script:skipped = $null
function Yes([bool]$ok, [string]$what) { if (-not $ok) { throw ('FAILED:' + $what) }; $script:n++ }
function Throws([scriptblock]$b, [string]$like, [string]$what) { $m = $null; try { & $b } catch { $m = $_.Exception.Message }; Yes ($null -ne $m -and $m -like $like) ($what + ' (got: ' + $m + ')') }

$file = Join-Path $here 'first-install-host.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
Yes ($errors.Count -eq 0) 'parse:first-install-host.ps1'
$functions = @{}
foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
foreach ($name in @('Get-Key', 'Get-Rid', 'Get-NodeProfile', 'Get-Signer', 'Get-CiRootSddl', 'Get-FirstInstallSddl', 'Get-AdminOnlySddl', 'Test-SddlIs', 'Get-ResidueCodes',
    'Get-TokenFingerprint', 'New-FirstInstallFacts', 'Test-SameFacts', 'Test-LinuxFirstInstallFacts', 'Test-ExpectedOperator', 'Get-ServiceSid', 'Test-CiRootHasResidentAce',
    'Get-WslVersion', 'Get-CredentialPlan', 'Get-ResetPlan', 'Test-DenyServiceLogon', 'Get-V1BaseCodes', 'Get-DebListText')) {
  Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name]))
}
foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] }, $false)) {
  if ($a.Left.Extent.Text -cin @('$Distribution', '$ResidentRoot', '$FactsContract', '$Utf8', '$Strict8', '$SecretTargets', '$CiRoot', '$VhdxDirectory')) { . ([scriptblock]::Create($a.Extent.Text)) }
}
$js = New-Object Web.Script.Serialization.JavaScriptSerializer
$res = Split-Path -Parent $here
$text = [IO.File]::ReadAllText($file)
$main = $text.Substring($text.IndexOf('function Invoke-HostPreparation'))
$sidBase = 'S-1-5-21-111111111-2222222222-3333333333-'
$control = $sidBase + '1007'; $companion = $sidBase + '1008'; $operator = $sidBase + '1000'

# ---- the node profile from the machine name: the same rule as prepare-record.mjs#validateNodeProfile
$p = Get-NodeProfile 'desk-w-591' $control $companion 'C:\Users\clued-companion'
Yes ($p.hostname -ceq 'DESK-W-591' -and $p.nodeName -ceq 'desk-w-591' -and $p.mutationMutex -ceq 'Global\CluedControlControllerMutationV1-DESK-W-591-1007' -and
  $p.runnerService -ceq 'actions.runner.tdoljyj-cross-memory-system.clued-ci-desk-w-591' -and $p.wslDistribution -ceq 'CluedResident-Linux' -and $p.ownerSid -ceq $companion) 'profile:derived'
$mod = ([Uri](Join-Path (Split-Path -Parent $res) 'actions-hosted-migration\independent-ci-v1\src\resident-v2\prepare-record.mjs')).AbsoluteUri
$env:CLUED_TEST_PROFILE = $js.Serialize($p)   # by the environment: Windows PowerShell 5.1 drops the quotes of a JSON argument
$check = & $Node --input-type=module -e ("import { validateNodeProfile } from '" + $mod + "'; try { validateNodeProfile(JSON.parse(process.env.CLUED_TEST_PROFILE)); console.log('VALID') } catch (e) { console.log(e.code ?? e.message) }") | Out-String
Remove-Item Env:CLUED_TEST_PROFILE
Yes ($check.Trim() -ceq 'VALID') ('profile:validateNodeProfile accepts it (' + $check.Trim() + ')')
Throws { Get-NodeProfile 'DESK_W_591' $control $companion 'C:\Users\c' } 'HOSTNAME_NOT_A_NODE_NAME:*' 'profile:underscore-refused'
Throws { Get-NodeProfile 'ABCDEFGHIJKLMNOP' $control $companion 'C:\Users\c' } 'HOSTNAME_NOT_A_NODE_NAME:*' 'profile:16-characters-refused'
Throws { Get-NodeProfile 'NODE1' ($sidBase + '500') $companion 'C:\Users\c' } 'NODE_PROFILE_INVALID' 'profile:controller-rid-below-1000'
Throws { Get-NodeProfile 'NODE1' $control $control 'C:\Users\c' } 'NODE_PROFILE_INVALID' 'profile:companion-is-not-the-controller'
Throws { Get-NodeProfile 'NODE1' $control $companion 'D:\Users\c' } 'NODE_PROFILE_INVALID' 'profile:profile-directory-shape'

# ---- the signer convention
$pem = "-----BEGIN PUBLIC KEY-----`nMCowBQYDK2VwAyEA" + ('Q' * 43) + "=`n-----END PUBLIC KEY-----`n"
$sg = Get-Signer $p $pem ([DateTime]::new(2026, 11, 16, 0, 0, 0, [DateTimeKind]::Utc))
Yes ($sg.keyId -ceq 'desk-w-591-first-run-20261116' -and $sg.runtimeId -ceq 'DESK-W-591-cluedresident-independent-ci-v1' -and $sg.publicKeyPem -ceq $pem) 'signer:convention'
Throws { Get-Signer $p ($pem.Replace("`n", "`r`n")) ([DateTime]::UtcNow) } 'RESULT_PUBLIC_KEY_NOT_ED25519_PEM' 'signer:crlf-pem-refused'

# ---- DACLs: the CI root baseline is DESK-W-591's CI root without the two ACEs the installer appends (same shape, synthetic SIDs)
$service = 'S-1-5-80-1-2-3-4-5'
$installed = 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x120080;;;' + $operator + ')(A;OICI;0x1200a9;;;' + $control + ')(A;;0x120080;;;' + $companion + ')(A;;0x120080;;;' + $service + ')'
$baseline = $installed.Replace('(A;;0x120080;;;' + $companion + ')', '').Replace('(A;;0x120080;;;' + $service + ')', '')
Yes (Test-SddlIs $baseline (Get-CiRootSddl $operator $control)) 'acl:ci-root-baseline'
Yes (-not (Test-SddlIs $installed (Get-CiRootSddl $operator $control))) 'acl:an-installed-root-is-not-the-baseline'
Yes (Test-SddlIs 'O:BAG:BAD:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)' (Get-AdminOnlySddl)) 'acl:order-free'
Yes (-not (Test-SddlIs 'O:BAG:BAD:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' (Get-AdminOnlySddl))) 'acl:not-protected-refused'
Yes (-not (Test-SddlIs ('O:' + $operator + 'G:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)') (Get-AdminOnlySddl))) 'acl:owner-must-be-administrators'
Yes (-not (Test-SddlIs ((Get-AdminOnlySddl) + '(A;OICI;0x1200a9;;;AU)') (Get-AdminOnlySddl))) 'acl:extra-ace-refused'
Yes (-not (Test-SddlIs 'not an sddl' (Get-AdminOnlySddl))) 'acl:unparsable'
Yes (Test-SddlIs (Get-FirstInstallSddl $operator) ('O:BAG:BAD:PAI(A;OICI;0x1200a9;;;' + $operator + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')) 'acl:first-install-operator-reads'

# the secret file and folder descriptors are install-resident.ps1's, character for character
$inst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $here 'install-resident.ps1'), [ref]$tokens, [ref]$errors)
foreach ($name in @('Get-SecretFileSddl', 'Get-SecretDirectorySddl')) {
  $theirs = @($inst.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $name }, $true))
  Yes ($theirs.Count -eq 1 -and $functions.ContainsKey($name) -and $theirs[0].Extent.Text -ceq $functions[$name]) ('acl:' + $name + '-is-the-installers')
}
. ([scriptblock]::Create($functions['Get-SecretFileSddl']))
Yes ((Get-SecretFileSddl $control) -ceq ('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $control + ')')) 'acl:secret-file'
$targets = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -ceq '$SecretTargets' }, $true))
$theirTargets = @($inst.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -ceq '$SecretTargets' }, $true))
Yes ($targets.Count -eq 1 -and $theirTargets.Count -eq 1 -and $targets[0].Right.Extent.Text -ceq $theirTargets[0].Right.Extent.Text) 'secrets:the-installers-targets'

# ---- residue
function New-Clean { [ordered]@{ services = @(); firewallRule = $false; companionTask = $false; residentRoot = $false; residentAce = $false; keptRoots = @(); ciTokenWithoutFacts = $false; companionDistribution = 'no-account' } }
Yes ((Get-ResidueCodes (New-Clean)).Count -eq 0) 'residue:none'
$o = New-Clean; $o.services = @('CluedCISwapBroker'); $o.firewallRule = $true; $o.companionTask = $true; $o.residentRoot = $true
$rc = Get-ResidueCodes $o
Yes ($rc.Count -eq 4 -and $rc -ccontains 'SERVICE:CluedCISwapBroker' -and $rc -ccontains 'DIRECTORY:C:\ProgramData\CluedIndependentCI\resident') 'residue:named'
# M5: what an uninstall leaves behind is residue too, each named
$o = New-Clean; $o.residentAce = $true; $o.keptRoots = @('resident-uninstalled-20261101T000000Z-abc'); $o.ciTokenWithoutFacts = $true; $o.companionDistribution = 'present'
$rc = Get-ResidueCodes $o
foreach ($want in @('CI_ROOT_RESIDENT_ACE:CluedCIResident', 'KEPT_ROOT:resident-uninstalled-20261101T000000Z-abc', 'SECRET_NOT_PLACED_BY_THIS_FIRST_INSTALL:C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token', 'WSL_DISTRIBUTION_OF_THE_COMPANION:CluedResident-Linux')) { Yes ($rc -ccontains $want) ('residue:' + $want) }
$o = New-Clean; $o.companionDistribution = 'unknown'
Yes ((Get-ResidueCodes $o) -ccontains 'COMPANION_WSL_REGISTRATIONS_UNREADABLE') 'residue:unreadable-is-not-none'
$o = New-Clean; $o.companionDistribution = 'absent'
Yes ((Get-ResidueCodes $o).Count -eq 0) 'residue:companion-without-distribution'
Yes ($text -notmatch 'then run the same command') 'residue:no-run-again-after-uninstall-advice'
# the resident service's SID, as Windows derives it (differential with sc.exe showsid; read-only, any account)
$scOut = (& 'C:\Windows\System32\sc.exe' showsid CluedCIResident | Out-String)
$scSid = if ($scOut -match 'S-1-5-80(?:-\d+){5}') { $Matches[0] } else { $null }
Yes ($null -ne $scSid -and (Get-ServiceSid 'CluedCIResident') -ceq $scSid) ('service-sid:as-sc-showsid ' + $scSid)
$ace = '(A;;0x120080;;;' + $scSid + ')'
Yes (Test-CiRootHasResidentAce ((Get-CiRootSddl $operator $control) + $ace) $scSid) 'residue:resident-ace-found'
Yes (-not (Test-CiRootHasResidentAce (Get-CiRootSddl $operator $control) $scSid)) 'residue:baseline-has-none'
# M4: the elevated account must be the operator the bootstrap ran as
Yes ($null -eq (Test-ExpectedOperator $operator $operator)) 'm4:same'
Yes ((Test-ExpectedOperator $control $operator) -ceq 'ELEVATED_ACCOUNT_IS_NOT_THE_OPERATOR') 'm4:other'
Yes ((Test-ExpectedOperator $operator '') -ceq 'EXPECTED_OPERATOR_SID_REQUIRED') 'm4:required'
Yes ($main.IndexOf('Test-ExpectedOperator') -gt 0 -and $main.IndexOf('Test-ExpectedOperator') -lt $main.IndexOf('Get-ResidueCodes')) 'm4:first-step'
# M7: wsl --version, English or localized, UTF-16 noise included
Yes ((Get-WslVersion ("W`0S`0L`0 version: 2.7.13.0`r`nKernel version: 6.6.87.2-1")) -ceq '2.7.13.0') 'm7:wsl-version-english'
Yes ((Get-WslVersion ("WSL " + [char]0x7248 + [char]0x672C + ": 2.7.11.0`r`n")) -ceq '2.7.11.0') 'm7:wsl-version-localized'
Yes ($null -eq (Get-WslVersion 'Usage: wsl.exe [Argument]')) 'm7:wsl-version-old-inbox'
Yes ($main -match 'msiexec\.exe' -and $main -match 'Get-WslVersion') 'm7:msi-installed-and-checked'
# H2: the credentials are collected and the facts draft checked (install.mjs first-install-facts-check) before any file is written
Yes (-not $functions.ContainsKey('Test-FirstInstallFacts')) 'm1:no-second-copy-of-the-facts-rule'
Yes ($functions.ContainsKey('Invoke-FactsCheck') -and $functions['Invoke-FactsCheck'] -match 'first-install-facts-check') 'm1:the-rule-is-install-mjs'
$firstWrite = [Math]::Min($main.IndexOf('Write-CreateOnly'), $main.IndexOf('Write-Secrets'))
Yes ($main.IndexOf('Invoke-FactsCheck') -gt 0 -and $main.IndexOf('Invoke-FactsCheck') -lt $firstWrite) 'h2:checked-before-written'
Yes ($main.IndexOf('Get-CredentialPlan') -gt 0 -and $main.IndexOf('Get-CredentialPlan') -lt $main.IndexOf('Read-TokenFromDialog')) 'h2:plan-before-dialogs'
$cp = Get-CredentialPlan $false ([ordered]@{ appKey = 'missing'; ciToken = 'missing'; upgradeToken = 'missing'; heartbeatToken = 'missing' })
Yes ($cp.mode -ceq 'collect-all') 'h2:no-facts-collect-all'
$cp = Get-CredentialPlan $true ([ordered]@{ appKey = 'match'; ciToken = 'match'; upgradeToken = 'match'; heartbeatToken = 'none' })
Yes ($cp.mode -ceq 'verify-only' -and @($cp.ask).Count -eq 0) 'h2:facts-and-everything-there-no-dialog'
$cp = Get-CredentialPlan $true ([ordered]@{ appKey = 'match'; ciToken = 'match'; upgradeToken = 'missing'; heartbeatToken = 'missing' })
Yes ($cp.mode -ceq 'ask-missing' -and (@($cp.ask) -join ',') -ceq 'upgradeToken,heartbeatToken') 'h2:only-the-missing-ones'
$cp = Get-CredentialPlan $true ([ordered]@{ appKey = 'differs'; ciToken = 'match'; upgradeToken = 'match'; heartbeatToken = 'none' })
Yes ($cp.mode -ceq 'refused' -and $cp.code -ceq 'SECRET_IN_PLACE_IS_NOT_THE_FACTS:appKey') 'h2:another-secret-in-place'
# H2: the reset removes only what this P1 made, and only with no resident on the host
function New-ResetState { [ordered]@{ resident = @(); factsPresent = $true; appKey = 'match'; ciToken = 'match'; companionWsl = [ordered]@{ stage = 'owner-imported'; importedBy = $operator }; operator = $operator; distributionRegistered = $true } }
$rp = Get-ResetPlan (New-ResetState)
Yes ($null -eq $rp.code -and (@($rp.actions) -join ',') -ceq 'remove-app-key,remove-ci-token,unregister-distribution,remove-import-directory,remove-first-install-directory') ('reset:all-ours ' + (@($rp.actions) -join ','))
$st = New-ResetState; $st.resident = @('SERVICE:CluedCIResident')
Yes ((Get-ResetPlan $st).code -ceq 'RESET_REFUSED_RESIDENT_PRESENT') 'reset:never-with-a-resident'
$st = New-ResetState; $st.appKey = 'differs'; $st.companionWsl.importedBy = $control
$rp = Get-ResetPlan $st
Yes ((@($rp.actions) -join ',') -ceq 'remove-ci-token,remove-first-install-directory' -and (@($rp.kept) -join ',') -ceq 'app-key-not-this-first-installs,distribution-not-this-operators') ('reset:keeps-what-is-not-ours ' + (@($rp.kept) -join ','))
$st = New-ResetState; $st.factsPresent = $false
$rp = Get-ResetPlan $st
Yes ((@($rp.actions) -join ',') -ceq 'remove-first-install-directory' -and @($rp.kept) -ccontains 'secrets-without-facts-unknown-owner') 'reset:without-facts-only-the-directory'
# v1 base: what the installer needs that Windows itself must have
Yes ((Get-V1BaseCodes ([ordered]@{ csc = $true; localAccounts = $true; netSecurity = $true; scheduledTasks = $true; secedit = $true })).Count -eq 0) 'v1:base-present'
$vb = Get-V1BaseCodes ([ordered]@{ csc = $false; localAccounts = $true; netSecurity = $false; scheduledTasks = $true; secedit = $true })
Yes (($vb -join ',') -ceq 'V1_BASE_MISSING:csc,V1_BASE_MISSING:netSecurity') 'v1:named'
$inf = "[Privilege Rights]`r`nSeServiceLogonRight = *$control`r`nSeDenyServiceLogonRight = *$control,*S-1-5-32-546`r`n"
Yes ((Test-DenyServiceLogon $inf $control) -and -not (Test-DenyServiceLogon "SeDenyServiceLogonRight = *S-1-5-32-546" $control)) 'v1:deny-service-logon'
# M6: the docker closure is the pinned .debs, installed by dpkg from files, never resolved by apt
$deb = [ordered]@{ package = 'docker.io'; version = '29.1.3-0ubuntu3~24.04.2'; fileName = 'docker.io_29.1.3-0ubuntu3~24.04.2_amd64.deb'; url = 'http://archive.ubuntu.com/x.deb'; sha256 = ('f' * 64); bytes = 1 }
Yes ((Get-DebListText @($deb)) -ceq (('f' * 64) + '  docker.io_29.1.3-0ubuntu3~24.04.2_amd64.deb' + "`n")) 'm6:deb-list'
Throws { Get-DebListText @([ordered]@{ fileName = '../x.deb'; sha256 = ('f' * 64) }) } 'DEB_LIST_REFUSED:*' 'm6:deb-name-refused'
$prep = [IO.File]::ReadAllText((Join-Path $res 'linux\first-host-prep.sh'))
Yes ($prep -notmatch 'apt-get install' -and $prep -notmatch 'apt-get update' -and $prep -match 'dpkg -i' -and $prep -match 'sha256sum --quiet --strict -c') 'm6:dpkg-of-pinned-files'
Yes ($prep -notmatch '(?m)^\s*apt' -or $prep -match 'DPkg::Lock::Timeout') 'm6:lock-timeout-wherever-apt-remains'
Yes ($prep -match 'refuse_tail') 'm6:refusals-carry-the-stderr-tail'
Yes ($main -match "'--exec'" -or $text -match "'--exec'") 'wsl:exec-not-the-shell'
Yes ($main -match '\$RegistrarSha256' -and $text -notmatch "Sha256File \(Join-Path \`$R 'windows\\CompanionTaskRegistrar\.cs'\)") 'l2:registrar-pin-from-the-archive'

# ---- token fingerprints: the same as tools/secret-fingerprint.mjs (synthetic tokens of each shape, not credentials)
$ciTok = 'clued_bnd_' + ('Ab9_-' * 6); $hbTok = 'clued_hbt_' + ('x' * 43)
$fpMod = ([Uri](Join-Path $res 'tools\secret-fingerprint.mjs')).AbsoluteUri
$want = & $Node --input-type=module -e ("import { fingerprintCiToken, fingerprintHeartbeatToken } from '" + $fpMod + "'; console.log(fingerprintCiToken(process.argv[1]) + ' ' + fingerprintHeartbeatToken(process.argv[2]))") $ciTok $hbTok | Out-String
$w2 = $want.Trim().Split(' ')
Yes ((Get-TokenFingerprint ($Utf8.GetBytes($ciTok + "`r`n")) 'ci-token') -ceq $w2[0]) 'fingerprint:ci-token-as-the-tool'
Yes ((Get-TokenFingerprint ($Utf8.GetBytes($hbTok)) 'heartbeat-token') -ceq $w2[1]) 'fingerprint:heartbeat-as-the-tool'
Yes ($null -eq (Get-TokenFingerprint ($Utf8.GetBytes($hbTok)) 'ci-token')) 'fingerprint:kinds-do-not-mix'
Yes ($null -eq (Get-TokenFingerprint ([byte[]]@()) 'ci-token')) 'fingerprint:empty'

# ---- the facts document: built here, checked by install.mjs (readFirstInstallFacts, the one rule; M1)
function New-Good {
  $sh = [Security.Cryptography.SHA256]::Create(); $pk = -join ($sh.ComputeHash([Text.Encoding]::ASCII.GetBytes($pem)) | ForEach-Object { $_.ToString('x2') })
  $pp = Get-NodeProfile 'desk-w-591' $control $companion 'C:\Users\clued-companion'; $ss = Get-Signer $pp $pem ([DateTime]::new(2026, 11, 16, 0, 0, 0, [DateTimeKind]::Utc))
  New-FirstInstallFacts $pp $operator 'C:\ProgramData\CluedIndependentCI\wsl\CluedResident-Linux' ([ordered]@{ appKeyId = 5099457; appPublicKeySha256Base64 = ('A' * 43 + '=')
      ciPrincipalBindingId = '44dc0846-de45-40ca-b29b-423658e46b10'; ciPrincipalQualificationRef = '4611384b-8df1-4d3d-bdac-839787dcb5cd'; ciPrincipalRoleRef = '4611384b-8df1-4d3d-bdac-839787dcb5cd'; ciTokenPinSha256 = ('1' * 64) }) `
    ([ordered]@{ heartbeatToken = [ordered]@{ bindingId = $null; fingerprint = ('2' * 64) }; upgradeToken = [ordered]@{ fingerprint = ('3' * 64) } }) $ss `
    ([ordered]@{ resultPublicKeySha256 = $pk; toolchainNodeSha256 = ('4' * 64) }) '2026-11-16T01:02:03Z'
}
$good = New-Good
$round = $js.DeserializeObject($js.Serialize($good))
Yes (Test-SameFacts $good $round) 'facts:same-after-round-trip'
$later = New-Good; $later.observedAt = '2026-11-17T00:00:00Z'
Yes (Test-SameFacts $round $later) 'facts:observedAt-aside'
$other = New-Good; $other.nodeRecord.ciTokenPinSha256 = '9' * 64
Yes (-not (Test-SameFacts $good $other)) 'facts:another-install-differs'
# the draft P1 builds passes install.mjs's own check (run when that command is in the tree)
$installMjs = Join-Path $res 'rollout\fleet\install.mjs'
if ([IO.File]::ReadAllText($installMjs).Contains('first-install-facts-check')) {
  $draft = Join-Path ([IO.Path]::GetTempPath()) ('facts-draft-' + [Guid]::NewGuid().ToString('N') + '.json')
  try {
    [IO.File]::WriteAllText($draft, $js.Serialize($good), (New-Object Text.UTF8Encoding($false)))
    $saved = $env:COMPUTERNAME; $env:COMPUTERNAME = 'DESK-W-591'
    try { $out = & $Node $installMjs first-install-facts-check --facts $draft | Out-String } finally { $env:COMPUTERNAME = $saved }
    Yes ((Get-Key ($js.DeserializeObject(@($out.Trim() -split "`r?`n")[-1])) 'status') -ceq 'FIRST_INSTALL_FACTS_VALID') ('m1:the-draft-passes-install-mjs ' + $out.Trim())
  } finally { Remove-Item -LiteralPath $draft -Force -ErrorAction SilentlyContinue }
} else { $script:skipped = 'm1:install.mjs-has-no-first-install-facts-check-yet' }

# ---- the Linux facts first-install-facts.py prints
$lf = $js.DeserializeObject('{"contract":"clued.independent-ci.linux-first-install-facts/1","root":true,"toolchainNode":{"path":"/x","present":true,"protected":true,"sha256":"' + ('4' * 64) + '"},' +
  '"resultPublicKey":{"present":true,"protected":true,"sha256":"x","pem":"P"},"resultKey":{"present":true,"protected":true},"executables":{},"linuxCiPresent":[],' +
  '"systemdPid1":true,"cgroupV2":true,"dockerActive":true,"python312":true}')
Yes ((Test-LinuxFirstInstallFacts $lf ('4' * 64)).Count -eq 0) 'linux:ready'
Yes ((Test-LinuxFirstInstallFacts $lf ('6' * 64)) -ccontains 'LINUX_TOOLCHAIN_NODE_NOT_THE_KITS') 'linux:toolchain-not-the-kits'
$lf['linuxCiPresent'] = @('/opt/clued-independent-ci/source-v2'); $lf['dockerActive'] = $false
$lc = Test-LinuxFirstInstallFacts $lf ('4' * 64)
Yes ($lc -ccontains 'LINUX_CI_ALREADY_PRESENT' -and $lc -ccontains 'LINUX_dockerActive') 'linux:not-a-first-install-host'
Yes ((Test-LinuxFirstInstallFacts $null ('4' * 64)) -ccontains 'LINUX_FACTS_SHAPE') 'linux:unreadable'

# ---- the hand-over to the companion (補缺 1): P1 imports the distribution where the existing switch MOVES it from. The switch
#      (rearm-resident.ps1 -CompanionAccount -WslVhdxDirectory <facts.companionWsl.vhdxDirectory>, companion-headless.ps1
#      Invoke-CompanionWslMove) plans with Get-CompanionWslMovePlan; an import into the target directory itself would be 'forget'
#      (no Set-CompanionVhdxAcl), not the move DESK-W-591 took on 2026-11-09/10.
$headless = [Management.Automation.Language.Parser]::ParseFile((Join-Path $here 'companion-headless.ps1'), [ref]$tokens, [ref]$errors)
foreach ($name in @('Get-CompanionWslMovePlan', 'Test-CompanionSameVolume')) {
  $hf = @($headless.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $name }, $true))
  Yes ($hf.Count -eq 1) ('switch:' + $name); . ([scriptblock]::Create($hf[0].Extent.Text))
}
foreach ($a in $headless.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -ceq '$CompanionVhdxDirPattern' }, $true)) { . ([scriptblock]::Create($a.Extent.Text)) }
# the import location: the variable P1 hands to `wsl --install ... --location`, and the switch's target: facts.companionWsl.vhdxDirectory
$loc = [regex]::Match($text, "'--location', \`$(\w+)")
Yes ($loc.Success) 'switch:p1-import-location-found'
$varOf = { param([string]$n) $as = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] -and $x.Left.Extent.Text -ceq ('$' + $n) }, $false)); if ($as.Count -ne 1) { return $null }; & ([scriptblock]::Create($as[0].Right.Extent.Text)) }
$importAt = & $varOf $loc.Groups[1].Value
$target = & $varOf 'VhdxDirectory'
Yes ($target -ceq 'C:\ProgramData\CluedIndependentCI\wsl\CluedResident-Linux') 'switch:target-is-the-facts-vhdx-directory'
$plan = Get-CompanionWslMovePlan ([pscustomobject]@{ basePath = $importAt }) $true $target $false
Yes ($plan.action -ceq 'move' -and $plan.sameVolume -eq $true) ('switch:the-import-is-moved-into-the-companions-directory (' + $importAt + ' -> ' + $plan.action + ')')
Yes ($main -notmatch 'New-Dir \$VhdxDirectory\b' -and $main -notmatch 'New-Dir \(Split-Path -Parent \$VhdxDirectory\)') 'switch:p1-never-makes-the-target'
Yes ($text -match "target = \(\`$ImportDirectory \+ '\\ext4\.vhdx'\)") 'switch:p1-record-names-the-import'
$o = New-Clean; $o['vhdxTargetNotEmpty'] = $true
Yes ((Get-ResidueCodes $o) -ccontains 'DIRECTORY_NOT_EMPTY:C:\ProgramData\CluedIndependentCI\wsl\CluedResident-Linux') 'switch:a-filled-target-is-residue'
Yes ($text -match "'remove-import-directory'" -and $text -notmatch "'remove-vhdx-directory'") 'switch:reset-removes-the-import-only'

'{"status":"FIRST_INSTALL_HOST_PURE_TESTS_PASSED","checks":' + $script:n + ',"skipped":' + $(if ($script:skipped) { '"' + $script:skipped + '"' } else { 'null' }) + '}'
