<#
  Offline check of windows/first-install-host.ps1's pure functions (P1 of the first install): the node profile from the machine name,
  the signer convention, the CI root baseline DACL, the residue codes, the token fingerprints, the facts document and its check, the
  Linux facts it accepts. No installed host configuration is read or changed (no elevation, no WSL, no sc.exe or Get-Acl);
  only repository inputs and temporary file fixtures are used. The functions are taken from the real script by AST.
  Node is used only to hold two rules to the code they mirror: prepare-record.mjs#validateNodeProfile and
  tools/secret-fingerprint.mjs.
    powershell -NoProfile -ExecutionPolicy Bypass -File test-first-install-host.ps1 [-Node <node.exe>]
#>
param([string]$Node = 'node')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
$here = $PSScriptRoot
$script:n = 0; $script:skipped = $null
# Every failed check is named (a failure does not hide the checks after it); the run fails at the end when any did.
$script:failures = New-Object Collections.Generic.List[string]
function Yes([bool]$ok, [string]$what) { if (-not $ok) { $script:failures.Add($what) } else { $script:n++ } }
function Throws([scriptblock]$b, [string]$like, [string]$what) { $m = $null; try { & $b } catch { $m = $_.Exception.Message }; Yes ($null -ne $m -and $m -like $like) ($what + ' (got: ' + $m + ')') }
function Case([string]$what, [scriptblock]$b) { try { & $b } catch { $script:failures.Add($what + ' (threw: ' + $_.Exception.Message + ')') } }

$file = Join-Path $here 'first-install-host.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
Yes ($errors.Count -eq 0) 'parse:first-install-host.ps1'
$functions = @{}
foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
foreach ($name in @('Get-Key', 'Get-Rid', 'Get-NodeProfile', 'Get-Signer', 'Get-CiRootSddl', 'Get-FirstInstallSddl', 'Get-AdminOnlySddl', 'Test-SddlIs', 'Get-ResidueCodes',
    'Get-TokenFingerprint', 'New-FirstInstallFacts', 'Test-SameFacts', 'Test-LinuxFirstInstallFacts', 'Test-ExpectedOperator', 'Get-ServiceSid', 'Test-CiRootHasResidentAce',
    'Get-WslVersion', 'Get-CredentialPlan', 'Get-ResetPlan', 'Test-DenyServiceLogon', 'Get-V1BaseCodes', 'Get-DebListText',
    'Sha256File', 'Write-NewFile', 'Get-ExpandState', 'Test-ZipExpanded', 'Expand-Verified', 'Get-MissingCredentials', 'Get-HeartbeatPrompt', 'Test-CredentialFileName', 'Read-CredentialFiles',
    'ConvertTo-PlainData', 'ConvertTo-JsonLine', 'Get-StepLine', 'Step', 'Get-CredentialDialogCode')) {
  Yes ($functions.ContainsKey($name)) ('present:' + $name); if ($functions.ContainsKey($name)) { . ([scriptblock]::Create($functions[$name])) }
}
foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] }, $false)) {
  if ($a.Left.Extent.Text -cin @('$Distribution', '$ResidentRoot', '$FactsContract', '$Utf8', '$Strict8', '$SecretTargets', '$CiRoot', '$VhdxDirectory', '$FactsSecrets', '$CredentialFilesContract')) { . ([scriptblock]::Create($a.Extent.Text)) }
}
$js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue   # reads lines longer than the default 2,097,152
$script:CredentialList = if ($functions.ContainsKey('Read-CredentialFiles')) { try { Read-CredentialFiles (Join-Path $here 'credential-files.json') } catch { $script:failures.Add('credential-files.json: ' + $_.Exception.Message); $null } } else { $null }
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
# Fixed Windows service-SID vectors (the resident vector is also pinned in rollout/fleet/test/first-install.test.mjs).
# Never ask the executing host's service manager: these values do not depend on whether either service is installed.
$residentSid = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'
Yes ((Get-ServiceSid 'CluedCIResident') -ceq $residentSid) 'service-sid:fixed-resident-vector'
Yes ((Get-ServiceSid 'cluedciresident') -ceq $residentSid) 'service-sid:case-insensitive'
Yes ((Get-ServiceSid 'TrustedInstaller') -ceq 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') 'service-sid:fixed-trusted-installer-vector'
$ace = '(A;;0x120080;;;' + $residentSid + ')'
Yes (Test-CiRootHasResidentAce ((Get-CiRootSddl $operator $control) + $ace) $residentSid) 'residue:resident-ace-found'
Yes (-not (Test-CiRootHasResidentAce (Get-CiRootSddl $operator $control) $residentSid)) 'residue:baseline-has-none'
Yes (-not (Test-CiRootHasResidentAce $installed $residentSid)) 'residue:another-service-ace-is-not-the-resident'
Yes (-not (Test-CiRootHasResidentAce 'not an sddl' $residentSid)) 'residue:malformed-sddl'
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
$firstWrite = @(@('Write-CreateOnly', 'Write-NewFile', 'Write-Secrets') | ForEach-Object { $main.IndexOf($_) } | Where-Object { $_ -ge 0 } | Sort-Object)[0]
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

# ---- the hand-over to the companion (gap fill 1): P1 imports the distribution where the existing switch MOVES it from. The switch
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

# ---- independent review of 29c53c38c (REPORT-api-review-first-install.md)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('first-install-host-review-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($tmp)
function Stop-Host([string]$code, $detail) { throw ('STOP:' + $code) }   # the real one prints the refusal and exits
try {
  # H1: P1 runs under Stop with its stdout and stderr read apart by the stage; no tool it starts may turn a line on stderr into the end
  # of P1 (dism, powercfg, secedit, the companion account's own script): each runs through Invoke-Native (ProcessStartInfo).
  Case 'h1:p1-starts-its-tools-through-invoke-native' {
    Yes ($main -notmatch '&\s*(?:dism|powercfg|secedit)\.exe') 'h1:no-call-operator-on-dism-powercfg-secedit'
    Yes ($main -notmatch "&\s*'C:\\Windows\\System32\\WindowsPowerShell") 'h1:no-call-operator-on-powershell'
    Yes ($main -match "Invoke-Native \`$PowerShellExe @\('-NoProfile'" -and $main -match 'prepare-companion-account\.ps1') 'h1:companion-account-through-invoke-native'
    foreach ($t in @('dism.exe', 'powercfg.exe', 'secedit.exe')) { Yes ($main -match ('Invoke-Native ''C:\\Windows\\System32\\' + [regex]::Escape($t) + '''')) ('h1:' + $t + '-through-invoke-native') }
  }

  # M1: facts.json is written (create-only, whole or not at all) BEFORE the App key and the ci-admission token are placed: a run cut off
  # between the two leaves facts without secrets, which the next run asks for again (ask-missing) and -Reset removes; never secrets
  # without facts, which nothing can attribute.
  Case 'm1:facts-before-the-secrets' {
    $fw = $main.IndexOf('Write-NewFile $factsFile'); $sw = $main.IndexOf('Write-Secrets $controllerSid')
    Yes ($fw -gt 0 -and $sw -gt 0 -and $fw -lt $sw) ('m1:order facts=' + $fw + ' secrets=' + $sw)
    Yes ($main.IndexOf('Invoke-FactsCheck') -lt $fw) 'm1:checked-before-written'
    $cp = Get-CredentialPlan $true ([ordered]@{ appKey = 'missing'; ciToken = 'missing'; upgradeToken = 'missing'; heartbeatToken = 'missing' })
    Yes ($cp.mode -ceq 'ask-missing' -and (@($cp.ask) -join ',') -ceq 'appKey,ciToken,upgradeToken,heartbeatToken') 'm1:cut-off-run-asks-again'
    $rp = Get-ResetPlan ([ordered]@{ resident = @(); factsPresent = $true; appKey = 'missing'; ciToken = 'missing'; companionWsl = $null; operator = $operator; distributionRegistered = $false })
    Yes ((@($rp.actions) -join ',') -ceq 'remove-first-install-directory' -and @($rp.kept).Count -eq 0) 'm1:reset-takes-the-cut-off-state'
  }
  Case 'm1:write-new-file-is-whole-or-nothing-and-create-only' {
    $f = Join-Path $tmp 'facts.json'
    Write-NewFile $f ($Utf8.GetBytes('{"a":1}' + "`n")) 'D:P(A;;FA;;;WD)'
    Yes ([IO.File]::ReadAllText($f) -ceq ('{"a":1}' + "`n")) 'm1:written'
    Throws { Write-NewFile $f ($Utf8.GetBytes('{}')) 'D:P(A;;FA;;;WD)' } '*' 'm1:create-only'
    Yes ([IO.File]::ReadAllText($f) -ceq ('{"a":1}' + "`n")) 'm1:not-overwritten'
    Yes (@(Get-ChildItem -LiteralPath $tmp -Force | Where-Object { $_.Name -like 'facts.json?*' }).Count -eq 0) 'm1:no-partial-left'
  }

  # M5: the runner's archive is expanded resumably: into a new directory, checked against the zip, renamed into place, marked complete;
  # a directory found without its mark (a cut-off run) is set aside, kept, and the expansion done again; a marked one is checked.
  $src = Join-Path $tmp 'runner-src'; [void][IO.Directory]::CreateDirectory((Join-Path $src 'bin'))
  [IO.File]::WriteAllText((Join-Path $src 'bin\RunnerService.exe'), 'not really a service'); [IO.File]::WriteAllText((Join-Path $src 'run.cmd'), 'echo run')
  $zip = Join-Path $tmp 'actions-runner.zip'; [IO.Compression.ZipFile]::CreateFromDirectory($src, $zip)
  $zipSha = Sha256File $zip
  $dir = Join-Path $tmp 'runner'; $mark = Join-Path $tmp 'runner.first-install-complete'
  Case 'm5:expand-into-place' {
    Yes ((Get-ExpandState $dir $mark $zipSha) -ceq 'absent') 'm5:absent'
    $null = Expand-Verified $zip $dir $mark $zipSha
    Yes ([IO.File]::Exists((Join-Path $dir 'bin\RunnerService.exe')) -and (Test-ZipExpanded $zip $dir) -and (Get-ExpandState $dir $mark $zipSha) -ceq 'complete') 'm5:complete'
    Yes (@(Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { $_.Name -like 'runner.partial-*' }).Count -eq 0) 'm5:no-partial-left'
    $null = Expand-Verified $zip $dir $mark $zipSha
    Yes ((Get-ExpandState $dir $mark $zipSha) -ceq 'complete') 'm5:a-rerun-only-checks'
  }
  Case 'm5:a-cut-off-expansion-is-set-aside-and-done-again' {
    Remove-Item -LiteralPath $mark -Force; Remove-Item -LiteralPath (Join-Path $dir 'run.cmd') -Force
    Yes ((Get-ExpandState $dir $mark $zipSha) -ceq 'incomplete' -and -not (Test-ZipExpanded $zip $dir)) 'm5:incomplete'
    $null = Expand-Verified $zip $dir $mark $zipSha
    Yes ((Get-ExpandState $dir $mark $zipSha) -ceq 'complete' -and (Test-ZipExpanded $zip $dir)) 'm5:done-again'
    Yes (@(Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { $_.Name -like 'runner.incomplete-*' }).Count -eq 1) 'm5:cut-off-kept-aside'
  }
  Case 'm5:a-marked-expansion-that-changed-is-refused' {
    [IO.File]::WriteAllText((Join-Path $dir 'bin\RunnerService.exe'), 'changed')
    Throws { Expand-Verified $zip $dir $mark $zipSha } 'STOP:EXPANDED_FILES_NOT_THE_PINNED' 'm5:changed-refused'
    Yes ((Get-ExpandState $dir $mark ('0' * 64)) -ceq 'incomplete') 'm5:another-archive-is-not-complete'
  }
  Case 'm5:the-runner-step-uses-it' {
    Yes ($main -match "Expand-Verified \`$staged\['actions-runner'\] \`$runnerDir" -and $main -notmatch "Expand-Archive -LiteralPath \`$staged\['actions-runner'\]") 'm5:runner-step'
  }

  # L3: a re-run asks for exactly what facts.json records: a recorded heartbeat token is required, never "leave empty for none"
  Case 'l3:a-recorded-token-is-required' {
    $ask = [ordered]@{ mode = 'ask-missing'; ask = @('upgradeToken', 'heartbeatToken'); code = $null }
    Yes (((Get-MissingCredentials $ask @('upgradeToken')) -join ',') -ceq 'heartbeatToken') 'l3:recorded-heartbeat-missing'
    # (the function returns one array, as Get-V1BaseCodes: used as it is, never wrapped in @() again)
    Yes ((Get-MissingCredentials $ask @('upgradeToken', 'heartbeatToken')).Count -eq 0) 'l3:all-given'
    $all = [ordered]@{ mode = 'collect-all'; ask = @('appKey', 'ciToken', 'upgradeToken', 'heartbeatToken'); code = $null }
    Yes ((Get-MissingCredentials $all @('appKey', 'ciToken', 'upgradeToken')).Count -eq 0) 'l3:first-run-heartbeat-optional'
    Yes (((Get-MissingCredentials $all @('appKey', 'upgradeToken')) -join ',') -ceq 'ciToken') 'l3:first-run-ci-token-required'
    Yes ((Get-HeartbeatPrompt $true) -notmatch 'empty' -and (Get-HeartbeatPrompt $false) -match 'leave empty for none') 'l3:prompt'
    Yes ($main -match 'Get-HeartbeatPrompt \(\$null -ne \$old -or \$script:CredentialList\.required\.Contains\(''heartbeatToken''\)\)' -and $main -match 'Get-MissingCredentials \$plan') 'l3:used'
  }
  # "credential list source": the two groups are data shipped with the package (windows\credential-files.json, next to the script, in
  # the archive under its hash), read when P1 starts; the script names no credential file. Moving a name between the groups in the data
  # changes what the package does; a list that is missing, unreadable, of another contract, with a file name twice or a name in both
  # groups is refused by name before anything is done.
  Case 'k1:the-credential-list-is-data' {
    Yes ($script:CredentialList.optional.Contains('heartbeatToken') -and -not $script:CredentialList.required.Contains('heartbeatToken')) 'k1:heartbeat-optional'
    $both = (@(@($script:CredentialList.required.Keys) + @($script:CredentialList.optional.Keys)) | Sort-Object) -join ','; $files = (@($script:CredentialList.files.Keys) | Sort-Object) -join ','
    Yes ($both -ceq $files -and $files -ne '') ('k1:the-file-names-are-the-two ' + $files)
    foreach ($n in @($script:CredentialList.files.Values)) { Yes ($text -notmatch ("'" + [regex]::Escape($n) + "'")) ('k1:no-literal-in-the-script:' + $n) }
    Yes ($text -notmatch 'RequiredCredentialFiles|OptionalCredentialFiles' -and $text -notmatch "@\('appKey', 'ciToken', 'upgradeToken'\)") 'k1:no-list-in-the-script'
    Yes ($main -match "Enter-Step 'credential-files'[\s\S]*Read-CredentialFiles \(Join-Path \`$PSScriptRoot 'credential-files\.json'\)[\s\S]*Enter-Step 'operator'") 'k1:read-first-next-to-the-script'
    $all = [ordered]@{ mode = 'collect-all'; ask = @('appKey', 'ciToken', 'upgradeToken', 'heartbeatToken'); code = $null }
    $keep = $script:CredentialList
    $write = { param([string]$name, [string]$body) $f = Join-Path $tmp $name; [IO.File]::WriteAllText($f, $body, (New-Object Text.UTF8Encoding($false))); $f }
    try {
      $script:CredentialList = Read-CredentialFiles (& $write 'hb-required.json' '{"contract":"clued.independent-ci.credential-files/1","required":{"appKey":"a.pem","ciToken":"c.token","upgradeToken":"u.token","public":"p.json","companionToken":"g.token","heartbeatToken":"h.token"},"optional":{}}')
      Yes (((Get-MissingCredentials $all @('appKey', 'ciToken', 'upgradeToken')) -join ',') -ceq 'heartbeatToken') 'k1:heartbeat-made-required-is-missing'
      $script:CredentialList = Read-CredentialFiles (& $write 'up-optional.json' '{"contract":"clued.independent-ci.credential-files/1","required":{"appKey":"a.pem","ciToken":"c.token","public":"p.json","companionToken":"g.token"},"optional":{"heartbeatToken":"h.token","upgradeToken":"u.token"}}')
      Yes ((Get-MissingCredentials $all @('appKey', 'ciToken')).Count -eq 0) 'k1:upgrade-made-optional-is-not-missing'
    } finally { $script:CredentialList = $keep }
    foreach ($c in @(@('missing', $null, 'CREDENTIAL_FILES_MISSING'), @('unreadable', '{not json', 'CREDENTIAL_FILES_UNREADABLE'),
        @('contract', '{"contract":"x/1","required":{"a":"a.pem"},"optional":{}}', 'CREDENTIAL_FILES_CONTRACT'),
        @('duplicate', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"x.token","b":"x.token"},"optional":{}}', 'CREDENTIAL_FILES_DUPLICATE_FILE'),
        @('both', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"a.token"},"optional":{"a":"b.token"}}', 'CREDENTIAL_FILES_NAME_IN_BOTH'),
        @('shape', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"..\\x"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        # the rules the drill's kit build holds the same file to (DESK, 11-20): exactly the three top-level keys, names and file names unique
        # also when they differ only in case, plain file names, a non-empty required group
        @('extra-key', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"a.token"},"optional":{},"note":"x"}', 'CREDENTIAL_FILES_SHAPE'),
        @('no-optional', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"a.token"}}', 'CREDENTIAL_FILES_SHAPE'),
        @('required-empty', '{"contract":"clued.independent-ci.credential-files/1","required":{},"optional":{"a":"a.token"}}', 'CREDENTIAL_FILES_REQUIRED_EMPTY'),
        @('file-case', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"X.token"},"optional":{"b":"x.TOKEN"}}', 'CREDENTIAL_FILES_DUPLICATE_FILE'),
        @('name-case-both', '{"contract":"clued.independent-ci.credential-files/1","required":{"appKey":"a.token"},"optional":{"AppKey":"b.token"}}', 'CREDENTIAL_FILES_NAME_IN_BOTH'),
        @('name-case-one', '{"contract":"clued.independent-ci.credential-files/1","required":{"appKey":"a.token","APPKEY":"b.token"},"optional":{}}', 'CREDENTIAL_FILES_DUPLICATE_NAME'),
        # the names allowed (DESK, 11-20; the drill's kit build holds the file to the same): a name ^[A-Za-z][A-Za-z0-9]*$, a file name
        # ^[A-Za-z0-9][A-Za-z0-9._-]*$ not ending in '.' and not a Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without
        # an extension); ASCII only, so case is the same thing in both readers
        @('sub-path', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"x/a.token"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        @('key-non-ascii', '{"contract":"clued.independent-ci.credential-files/1","required":{"\u00e4ppKey":"a.token"},"optional":{}}', 'CREDENTIAL_FILES_NAME_REFUSED'),
        @('key-digit-first', '{"contract":"clued.independent-ci.credential-files/1","required":{"1a":"a.token"},"optional":{}}', 'CREDENTIAL_FILES_NAME_REFUSED'),
        @('key-dash', '{"contract":"clued.independent-ci.credential-files/1","required":{"app-key":"a.token"},"optional":{}}', 'CREDENTIAL_FILES_NAME_REFUSED'),
        @('file-trailing-dot', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"a.token."},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        @('file-non-ascii', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"\u00e4.token"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        @('file-con', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"CON"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        @('file-nul-ext', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"nul.txt"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        @('file-com1', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"com1.log"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        @('file-lpt9', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"LPT9"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        @('file-aux-ext', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"Aux.token"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'),
        @('file-prn', '{"contract":"clued.independent-ci.credential-files/1","required":{"a":"prn"},"optional":{}}', 'CREDENTIAL_FILES_FILE_NAME_REFUSED'))) {
      $f = if ($null -eq $c[1]) { Join-Path $tmp 'no-such-credential-files.json' } else { & $write ('cf-' + $c[0] + '.json') $c[1] }
      Throws { Read-CredentialFiles $f } $c[2] ('k1:refused:' + $c[0])
    }
    # allowed: long names (no length cap in either reader), COM10 (not a device), dots inside a file name
    $ok = try { Read-CredentialFiles (& $write 'cf-allowed.json' '{"contract":"clued.independent-ci.credential-files/1","required":{"appKeyWithAVeryLongNameIndeedThatGoesOnAndOnForMoreThanFortyChars":"COM10.token"},"optional":{"b":"x.y.z"}}') } catch { $_.Exception.Message }
    Yes ($ok -is [Collections.IDictionary] -and $ok.files.Count -eq 2) ('k1:allowed ' + $ok)
    Yes ($text -match "required\.Contains\('companionToken'\)") 'k1:the-companion-token-reads-it-too'
  }

  # ---- the one JSON writer (drill 3bc571a6 A1; Fable ruling 11-19 section 2.1). Under Windows PowerShell 5.1 a cmdlet's output (Join-Path,
  # Where-Object, Split-Path) is a string in a PSObject shell, which JavaScriptSerializer walks as an object and refuses with a
  # PSParameterizedProperty circular reference: Step 'stage' (Join-Path) ended P1 in the guest, and the READY line (facts = Join-Path)
  # would have ended it after a whole install. Every line and file P1 writes goes through ConvertTo-JsonLine, which takes the shell off.
  $jp = Join-Path 'C:\Windows\Temp' 'clued-p1-0123'
  Case 't1:cmdlet-output-round-trips' {
    $dir = (Get-Item -LiteralPath $tmp).FullName
    $two = @('SERVICE:A', 'SERVICE:B') | Where-Object { $_ }
    $one = @(Split-Path -Parent 'C:\a\b')
    $str = { param($s) $js.Serialize([string]$s) }   # a plain .NET string, as the serializer writes it
    Yes ((ConvertTo-JsonLine $jp) -ceq (& $str 'C:\Windows\Temp\clued-p1-0123')) 't1:join-path'
    Yes ($js.DeserializeObject((ConvertTo-JsonLine ([ordered]@{ v = $jp })))['v'] -ceq 'C:\Windows\Temp\clued-p1-0123') 't1:join-path-parsed-back'
    Yes ((ConvertTo-JsonLine $two) -ceq '["SERVICE:A","SERVICE:B"]') 't1:where-object-array'
    Yes ((ConvertTo-JsonLine ([ordered]@{ one = $one })) -ceq ('{"one":[' + (& $str 'C:\a') + ']}')) 't1:one-element-array-stays-an-array'
    $ready = [ordered]@{ status = 'FIRST_INSTALL_HOST_READY'; facts = $jp; node = 'desk-w-591'; list = $two
      inner = [ordered]@{ dir = $dir; n = 3; big = 5099457L; ok = $true; none = $null; empty = @() } }
    $line = ConvertTo-JsonLine $ready
    $back = $js.DeserializeObject($line)
    Yes ($back['facts'] -ceq [string]$jp -and $back['inner']['dir'] -ceq [string]$dir -and (@($back['list']) -join ',') -ceq 'SERVICE:A,SERVICE:B' -and
      $back['inner']['n'] -eq 3 -and $back['inner']['big'] -eq 5099457 -and $back['inner']['ok'] -eq $true -and $null -eq $back['inner']['none'] -and
      @($back['inner']['empty']).Count -eq 0) ('t1:the-ready-shape-parsed-back ' + $line)
    Yes ($line.StartsWith('{"status":"FIRST_INSTALL_HOST_READY","facts":' + (& $str $jp) + ',"node":"desk-w-591"')) ('t1:key-order-kept ' + $line)
    # a deserialized document (facts.json read back: Dictionary and object[]) is plain data already and comes out the same
    Yes ((ConvertTo-JsonLine $back) -ceq $line) 't1:deserialized-is-unchanged'
    Yes ((Step 'stage' $jp) -ceq ('{"name":"stage","result":"ok","rejectCode":null,"detail":' + (& $str $jp) + '}')) 't1:step-stage'
    Yes ((Step 'residue' $two) -ceq '{"name":"residue","result":"ok","rejectCode":null,"detail":["SERVICE:A","SERVICE:B"]}') 't1:step-residue-codes'
    # longer than the serializer's default 2,097,152 characters (Codex review of PR-A, blocking 2): plain data is written whole
    $big = 'y' * 2500000
    $bl = try { ConvertTo-JsonLine ([ordered]@{ facts = $big }) } catch { $null }
    Yes ($null -ne $bl -and ([string]$js.DeserializeObject($bl)['facts']).Length -eq 2500000) 't1:longer-than-2M'
  }
  # Step is progress: whatever it is given, one line of JSON and no exception. A verdict line or facts.json is the contract: a value that is
  # not plain data is refused by name (HOST_OUTPUT_NOT_PLAIN_DATA), never written in a form someone has to guess at.
  Case 't3:step-never-throws-a-verdict-refuses-by-name' {
    $fi = Get-Item -LiteralPath $tmp
    $cycle = @{}; $cycle['self'] = $cycle
    foreach ($odd in @($fi, [DateTime]::UtcNow, [IO.FileAttributes]::Directory, [pscustomobject]@{ a = 1 }, $cycle, ([ordered]@{ ok = $jp; bad = $fi }))) {
      $l = Step 'odd' $odd
      $b = $js.DeserializeObject($l)
      Yes ($l -is [string] -and $b['name'] -ceq 'odd' -and $b['result'] -ceq 'ok') ('t3:step-one-line ' + $odd.GetType().Name + ' ' + $l)
    }
    Yes ([string]$js.DeserializeObject((Step 'odd' $fi))['detail'] -clike '*DirectoryInfo*') 't3:step-names-the-type'
    Yes ($js.DeserializeObject((Step 'odd' ([ordered]@{ ok = $jp; bad = $fi })))['detail']['ok'] -ceq [string]$jp) 't3:step-keeps-the-plain-part'
    foreach ($odd in @($fi, [DateTime]::UtcNow, [IO.FileAttributes]::Directory, [pscustomobject]@{ a = 1 }, $cycle)) {
      Throws { ConvertTo-JsonLine ([ordered]@{ status = 'FIRST_INSTALL_HOST_READY'; facts = $odd }) } 'OUTPUT_NOT_PLAIN_DATA:$.facts*' ('t3:verdict-refused ' + $odd.GetType().Name)
    }
  }
  # Every step the main flow prints is entered first (Enter-Step), so that a refusal inside it is printed as that step failed.
  Case 't4:every-step-is-entered-before-it-ends' {
    $ended = @([regex]::Matches($main, "(?m)^\s*Step '([a-z0-9-]+)'") | ForEach-Object { $_.Groups[1].Value })
    Yes ($ended.Count -ge 12) ('t4:steps-found ' + ($ended -join ','))
    foreach ($s in $ended) {
      $at = [regex]::Match($main, "(?m)^\s*Step '" + [regex]::Escape($s) + "'").Index
      $entered = $main.LastIndexOf("Enter-Step '" + $s + "'", $at)
      Yes ($entered -ge 0) ('t4:entered:' + $s)
    }
    Yes (-not ($main -match 'exit 3')) 't4:restarts-only-through-Exit-Restart'
  }
  # Eight on the path, 1: P1 runs -NonInteractive, which refuses PowerShell's host prompt before any window opens. Every
  # token is asked for by Read-TokenFromDialog, the Windows credential dialog itself (credui.dll), with a stable code for each of its answers.
  Case 'c1:tokens-through-the-windows-credential-dialog' {
    Yes ($text -notmatch '(?<![\w-])Get-Credential(?![\w-])' -and $text -notmatch '(?<![\w-])Read-Host(?![\w-])' -and $text -notmatch 'UI\.PromptForCredential') 'c1:no-powershell-host-prompt'
    Yes ($text -match 'CredUIPromptForCredentialsW' -and $text -match 'DllImport\("credui\.dll"') 'c1:credui'
    $reads = @([regex]::Matches($main, "Read-TokenFromDialog ") | ForEach-Object { $_.Index })
    Yes ($reads.Count -eq 3) ('c1:the-three-tokens-through-one-function ' + $reads.Count)
    Yes ($null -eq (Get-CredentialDialogCode 0) -and (Get-CredentialDialogCode 1223) -ceq 'CREDENTIAL_DIALOG_CANCELLED' -and (Get-CredentialDialogCode 87) -ceq 'CREDENTIAL_DIALOG_FAILED:87' -and
      (Get-CredentialDialogCode -1) -ceq 'CREDENTIAL_DIALOG_FAILED:-1') 'c1:codes'
    Yes ($text -match "catch \{ Stop-Host 'CREDENTIAL_DIALOG_UNAVAILABLE'") 'c1:unavailable-by-name'
    # the type compiles under Windows PowerShell 5.1 (no window is opened here)
    $src = [regex]::Match($text, "(?s)\`$CredUiSource = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
    $compiled = try { if (-not ('CluedFirstInstallCredUi' -as [type])) { Add-Type -TypeDefinition $src }; [CluedFirstInstallCredUi]::PasswordChars -eq 257 } catch { $false }
    Yes $compiled 'c1:the-dialog-type-compiles'
  }
  Case 't2:one-serializer-in-the-script' {
    $calls = [regex]::Matches($text, '\.Serialize\(').Count
    $inWriter = if ($functions.ContainsKey('ConvertTo-JsonLine')) { [regex]::Matches($functions['ConvertTo-JsonLine'], '\.Serialize\(').Count } else { 0 }
    Yes ($inWriter -ge 1 -and $calls -eq $inWriter) ('t2:every-Serialize-call-is-in-ConvertTo-JsonLine (file ' + $calls + ', writer ' + $inWriter + ')')
    Yes ($functions.ContainsKey('Get-StepLine') -and $functions['Get-StepLine'] -match 'ConvertTo-JsonLine' -and $functions['Step'] -match 'Get-StepLine' -and $functions.ContainsKey('Stop-Host') -and $functions['Stop-Host'] -match 'ConvertTo-JsonLine') 't2:step-and-stop-host-use-it'
    Yes ($main -match "ConvertTo-JsonLine \(\[ordered\]@\{ status = 'FIRST_INSTALL_HOST_READY'") 't2:ready-uses-it'
  }
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }

if ($script:failures.Count) {
  $js.Serialize([ordered]@{ status = 'FIRST_INSTALL_HOST_PURE_TESTS_FAILED'; checks = $script:n; failures = @($script:failures); skipped = $script:skipped })
  exit 1
}
$js.Serialize([ordered]@{ status = 'FIRST_INSTALL_HOST_PURE_TESTS_PASSED'; checks = $script:n; skipped = $script:skipped })
