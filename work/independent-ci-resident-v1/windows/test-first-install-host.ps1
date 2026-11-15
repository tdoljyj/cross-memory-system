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
$script:n = 0
function Yes([bool]$ok, [string]$what) { if (-not $ok) { throw ('FAILED:' + $what) }; $script:n++ }
function Throws([scriptblock]$b, [string]$like, [string]$what) { $m = $null; try { & $b } catch { $m = $_.Exception.Message }; Yes ($null -ne $m -and $m -like $like) ($what + ' (got: ' + $m + ')') }

$file = Join-Path $here 'first-install-host.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
Yes ($errors.Count -eq 0) 'parse:first-install-host.ps1'
$functions = @{}
foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
foreach ($name in @('Get-Key', 'Get-Rid', 'Get-NodeProfile', 'Get-Signer', 'Get-CiRootSddl', 'Get-FirstInstallSddl', 'Get-AdminOnlySddl', 'Test-SddlIs', 'Get-ResidueCodes',
    'Get-TokenFingerprint', 'New-FirstInstallFacts', 'Test-FirstInstallFacts', 'Test-SameFacts', 'Test-LinuxFirstInstallFacts')) {
  Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name]))
}
foreach ($a in $ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] }, $false)) {
  if ($a.Left.Extent.Text -cin @('$Distribution', '$ResidentRoot', '$FactsContract', '$Utf8', '$Strict8')) { . ([scriptblock]::Create($a.Extent.Text)) }
}
$js = New-Object Web.Script.Serialization.JavaScriptSerializer
$res = Split-Path -Parent $here
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
Yes ((Get-ResidueCodes ([ordered]@{ services = @(); firewallRule = $false; companionTask = $false; residentRoot = $false })).Count -eq 0) 'residue:none'
$rc = Get-ResidueCodes ([ordered]@{ services = @('CluedCISwapBroker'); firewallRule = $true; companionTask = $true; residentRoot = $true })
Yes ($rc.Count -eq 4 -and $rc -ccontains 'SERVICE:CluedCISwapBroker' -and $rc -ccontains 'DIRECTORY:C:\ProgramData\CluedIndependentCI\resident') 'residue:named'

# ---- token fingerprints: the same as tools/secret-fingerprint.mjs (synthetic tokens of each shape, not credentials)
$ciTok = 'clued_bnd_' + ('Ab9_-' * 6); $hbTok = 'clued_hbt_' + ('x' * 43)
$fpMod = ([Uri](Join-Path $res 'tools\secret-fingerprint.mjs')).AbsoluteUri
$want = & $Node --input-type=module -e ("import { fingerprintCiToken, fingerprintHeartbeatToken } from '" + $fpMod + "'; console.log(fingerprintCiToken(process.argv[1]) + ' ' + fingerprintHeartbeatToken(process.argv[2]))") $ciTok $hbTok | Out-String
$w2 = $want.Trim().Split(' ')
Yes ((Get-TokenFingerprint ($Utf8.GetBytes($ciTok + "`r`n")) 'ci-token') -ceq $w2[0]) 'fingerprint:ci-token-as-the-tool'
Yes ((Get-TokenFingerprint ($Utf8.GetBytes($hbTok)) 'heartbeat-token') -ceq $w2[1]) 'fingerprint:heartbeat-as-the-tool'
Yes ($null -eq (Get-TokenFingerprint ($Utf8.GetBytes($hbTok)) 'ci-token')) 'fingerprint:kinds-do-not-mix'
Yes ($null -eq (Get-TokenFingerprint ([byte[]]@()) 'ci-token')) 'fingerprint:empty'

# ---- the facts document
function New-Good {
  $sh = [Security.Cryptography.SHA256]::Create(); $pk = -join ($sh.ComputeHash([Text.Encoding]::ASCII.GetBytes($pem)) | ForEach-Object { $_.ToString('x2') })
  # fresh objects each time: a case's change never reaches the next one
  $pp = Get-NodeProfile 'desk-w-591' $control $companion 'C:\Users\clued-companion'; $ss = Get-Signer $pp $pem ([DateTime]::new(2026, 11, 16, 0, 0, 0, [DateTimeKind]::Utc))
  New-FirstInstallFacts $pp $operator 'C:\ProgramData\CluedIndependentCI\wsl\CluedResident-Linux' ([ordered]@{ appKeyId = 5099457; appPublicKeySha256Base64 = ('A' * 43 + '=')
      ciPrincipalBindingId = '44dc0846-de45-40ca-b29b-423658e46b10'; ciPrincipalQualificationRef = '4611384b-8df1-4d3d-bdac-839787dcb5cd'; ciPrincipalRoleRef = '4611384b-8df1-4d3d-bdac-839787dcb5cd'; ciTokenPinSha256 = ('1' * 64) }) `
    ([ordered]@{ heartbeatToken = [ordered]@{ bindingId = $null; fingerprint = ('2' * 64) }; upgradeToken = [ordered]@{ fingerprint = ('3' * 64) } }) $ss `
    ([ordered]@{ resultPublicKeySha256 = $pk; toolchainNodeSha256 = ('4' * 64) }) '2026-11-16T01:02:03Z'
}
$good = New-Good
Yes ((Test-FirstInstallFacts $good).Count -eq 0) ('facts:valid ' + ((Test-FirstInstallFacts $good) -join ','))
$round = $js.DeserializeObject($js.Serialize($good))
Yes ((Test-FirstInstallFacts $round).Count -eq 0) 'facts:valid-after-a-json-round-trip'
Yes (Test-SameFacts $good $round) 'facts:same-after-round-trip'
$later = New-Good; $later.observedAt = '2026-11-17T00:00:00Z'
Yes (Test-SameFacts $round $later) 'facts:observedAt-aside'
$cases = @(
  @({ param($f) $f.contract = 'x' }, 'FACTS_CONTRACT'),
  @({ param($f) $f.observedAt = '2026-11-16 01:02' }, 'FACTS_OBSERVED_AT'),
  @({ param($f) $f.node.runnerService = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-other' }, 'FACTS_NODE_NOT_DERIVED'),
  @({ param($f) $f.node.hostname = 'BAD_NAME' }, 'FACTS_NODE'),
  @({ param($f) $f.operatorSid = $companion }, 'FACTS_OPERATOR'),
  @({ param($f) $f.companionWsl.distribution = 'Ubuntu' }, 'FACTS_COMPANION_WSL'),
  @({ param($f) $f.nodeRecord.appKeyId = 0 }, 'FACTS_NODE_RECORD'),
  @({ param($f) $f.nodeRecord.ciPrincipalRoleRef = 'not-a-uuid' }, 'FACTS_NODE_RECORD'),
  @({ param($f) $f.credentials.heartbeatToken.fingerprint = $f.credentials.upgradeToken.fingerprint }, 'FACTS_CREDENTIALS'),
  @({ param($f) $f.credentials.upgradeToken['target'] = 'C:\x' }, 'FACTS_CREDENTIALS'),
  @({ param($f) $f.signer.runtimeId = 'OTHER-cluedresident-independent-ci-v1' }, 'FACTS_SIGNER'),
  @({ param($f) $f.signer.keyId = 'other-first-run-20261116' }, 'FACTS_SIGNER'),
  @({ param($f) $f.linuxHost.resultPublicKeySha256 = ('5' * 64) }, 'FACTS_RESULT_KEY_NOT_THE_SIGNERS'),
  @({ param($f) $f.linuxHost.toolchainNodeSha256 = $null }, 'FACTS_LINUX_HOST'),
  @({ param($f) $f['extra'] = 1 }, 'FACTS_KEYS'))
foreach ($c in $cases) { $f = New-Good; & $c[0] $f; $got = Test-FirstInstallFacts $f; Yes ($got -ccontains $c[1]) ('facts:' + $c[1] + ' got ' + ($got -join ',')) }
$nohb = New-Good; $nohb.credentials.heartbeatToken = $null
Yes ((Test-FirstInstallFacts $nohb).Count -eq 0) ('facts:no-heartbeat-token ' + ((Test-FirstInstallFacts $nohb) -join ','))
$other = New-Good; $other.nodeRecord.ciTokenPinSha256 = '9' * 64
Yes (-not (Test-SameFacts $good $other)) 'facts:another-install-differs'

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

'{"status":"FIRST_INSTALL_HOST_PURE_TESTS_PASSED","checks":' + $script:n + '}'
