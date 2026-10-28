<#
  Offline checks of the resident's Windows privilege boundary (independent review of PR-A: MAJOR-1, MINOR-2,
  MINOR-3 via the Source v2 harness, MINOR-4, MINOR-5, MINOR-9). Nothing on the host is read or changed:
  - install-resident.ps1 and verify-resident.ps1 parse; their pure helper functions are taken from the real
    scripts by AST and exercised on recorded sc.exe output shapes;
  - the directory ACL plan is checked ACE by ACE (create-only Owner drop boxes, no DELETE for the resident on
    broker\requests, OWNER RIGHTS restriction);
  - SwapBroker.cs, ResidentServiceHost.cs and BrokerPureTests.cs are compiled with the in-box csc into the NEW
    scratch directory given by the caller and the broker's bounded read and both token checks are run;
  - ResidentServiceHost.cs and HostPureTests.cs are compiled the same way and the host's stop handling is run
    against a temporary state directory with a fake executor (one stop per process, no stop file on the
    executor's own exit; Task fe6cd7bc);
  - node's uptimeMs() reads the same clock as the host's GetTickCount64 (Task d80fd886).
  - node identity and the two secret files (primary/standby C7, DESIGN.md section 30): the identity derivations of install and verify
    against the shared cases (test/fixtures/node-identity-cases.json), the package side, the receipt checks, the secret files'
    security descriptors, and the fingerprint check and create-only placement against a scratch package and scratch targets with a
    throw-away key and a made-up token (needs a node on this machine; the result says whether it ran).
  powershell -NoProfile -File test-resident-windows.ps1 -Scratch <new empty directory>
#>
param([Parameter(Mandatory)][string]$Scratch)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Scratch) { if (@(Get-ChildItem -LiteralPath $Scratch -Force).Count) { throw 'EMPTY_SCRATCH_REQUIRED' } } else { [void][IO.Directory]::CreateDirectory($Scratch) }
$here = $PSScriptRoot
$n = 0
function Yes([bool]$ok, [string]$what) { if (-not $ok) { throw ('FAILED:' + $what) }; $script:n++ }

# 1. Parse, and take the helpers from the real scripts.
$functions = @{}
foreach ($file in @('install-resident.ps1', 'verify-resident.ps1', 'rearm-resident.ps1', 'uninstall-resident.ps1')) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $here $file), [ref]$tokens, [ref]$errors)
  Yes ($errors.Count -eq 0) ('parse:' + $file)
  foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$file + ':' + $f.Name] = $f.Extent.Text }
}
$OwnerSid = 'S-1-5-21-1173730660-3877291096-655431861-1001'; $ControllerSid = 'S-1-5-21-1173730660-3877291096-655431861-1015'
$ServiceName = 'CluedCIResident'; $ResidentPrivileges = @('SeChangeNotifyPrivilege'); $BrokerPrivileges = @('SeChangeNotifyPrivilege', 'SeCreateGlobalPrivilege')
$FirewallRuleName = 'CluedCIResident-BlockOutbound'
foreach ($name in @('install-resident.ps1:ConvertFrom-ScPrivs', 'install-resident.ps1:Get-AclPlan', 'install-resident.ps1:Get-PrivilegePlan', 'install-resident.ps1:Invoke-Sc')) {
  Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name]))
}

# 2. sc qprivs parsing (both copies), exit-code checked sc calls.
$qprivs = "[SC] QueryServiceConfig2 SUCCESS`r`n`r`nSERVICE_NAME: CluedCISwapBroker`r`n        PRIVILEGES       : SeCreateGlobalPrivilege`r`n                         : SeChangeNotifyPrivilege`r`n"
Yes ((ConvertFrom-ScPrivs $qprivs) -join '/' -ceq 'SeChangeNotifyPrivilege/SeCreateGlobalPrivilege') 'qprivs-install'
Yes (@(ConvertFrom-ScPrivs "[SC] QueryServiceConfig2 SUCCESS`r`n`r`nSERVICE_NAME: x`r`n        PRIVILEGES       :`r`n").Count -eq 0) 'qprivs-none'
$Sc = 'C:\Windows\System32\cmd.exe'
$threw = $null; try { $null = Invoke-Sc 'SC_STEP_FAILED' @('/c', 'exit 5') } catch { $threw = $_.Exception.Message }
Yes ($threw -ceq 'SC_STEP_FAILED:5') 'invoke-sc-checks-exit-code'
Yes ((Invoke-Sc 'SC_STEP_FAILED' @('/c', 'echo ok')).Trim() -ceq 'ok') 'invoke-sc-ok'
$installText = Get-Content -LiteralPath (Join-Path $here 'install-resident.ps1') -Raw
$raw = @([regex]::Matches($installText, '& \$Sc (?!@scArgs)([a-z]+)') | ForEach-Object { $_.Groups[1].Value })
Yes ((@($raw | Where-Object { @('qc', 'queryex', 'sdshow') -cnotcontains $_ }).Count) -eq 0) 'every-mutating-sc-call-is-exit-checked'
foreach ($call in @("'privs', `$ServiceName", "'privs', `$BrokerName", "'failure', `$BrokerName", "'failureflag', `$BrokerName", "'qprivs'", 'New-NetFirewallRule')) { Yes ($installText.Contains($call)) ('install-has:' + $call) }
$plan = Get-PrivilegePlan
Yes ((@($plan.residentPrivileges) -join '/') -ceq 'SeChangeNotifyPrivilege' -and $plan.firewall.direction -ceq 'Outbound' -and $plan.firewall.action -ceq 'Block' -and $plan.firewall.service -ceq 'CluedCIResident') 'privilege-plan'

# 3. Directory ACL plan, ACE by ACE.
$res = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'
$acl = Get-AclPlan $res
$fileWrite = 0x2 -bor 0x4 -bor 0x10 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000
function Aces([string]$sddl) { @((New-Object Security.AccessControl.RawSecurityDescriptor($sddl)).DiscretionaryAcl) }
# The generic helper (clued-control) must be able to open the resident root for READ_CONTROL, and nothing more.
$rootCtrl = @(Aces $acl[''] | Where-Object { $_.SecurityIdentifier.Value -ceq $ControllerSid })
Yes ($rootCtrl.Count -eq 1 -and $rootCtrl[0].AccessMask -eq 0x120080 -and [int]$rootCtrl[0].AceFlags -eq 0) 'root:controller-read-control-only'
foreach ($box in @('inbox', 'requests')) {
  $aces = Aces $acl[$box]
  $owner = @($aces | Where-Object { $_.SecurityIdentifier.Value -ceq $OwnerSid })
  Yes ($owner.Count -eq 2) ($box + ':owner-two-aces')
  foreach ($a in $owner) {
    if (([int]$a.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { Yes (($a.AccessMask -band $fileWrite) -eq 0) ($box + ':owner-files-read-only') }
    else { Yes ($a.AccessMask -eq 0x1000a2 -and ([int]$a.AceFlags -band [int][Security.AccessControl.AceFlags]::ObjectInherit) -eq 0) ($box + ':owner-folder-add-file-only') }
  }
  Yes (@($aces | Where-Object { $_.SecurityIdentifier.Value -ceq 'S-1-3-4' -and ($_.AccessMask -band $fileWrite) -eq 0 }).Count -eq 1) ($box + ':owner-rights-restricted')
}
$broker = Aces $acl['broker\requests']
foreach ($a in @($broker | Where-Object { $_.SecurityIdentifier.Value -ceq $res })) {
  Yes (($a.AccessMask -band (0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000)) -eq 0) 'broker-requests:no-delete-for-resident'
  if (([int]$a.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { Yes (($a.AccessMask -band $fileWrite) -eq 0) 'broker-requests:resident-files-read-only' }
}
Yes (@($broker | Where-Object { $_.SecurityIdentifier.Value -ceq 'S-1-3-4' }).Count -eq 1) 'broker-requests:owner-rights'

# 4. verify-resident.ps1 checks.
foreach ($name in @('Get-DaclPart', 'ConvertFrom-ScPrivs', 'Test-ExactPrivileges', 'Test-TokenRecord', 'Test-BrokerBinaryPath', 'Test-ScSddl', 'Read-ReviewedPublicJson')) {
  Yes ($functions.ContainsKey('verify-resident.ps1:' + $name)) ('verify-present:' + $name); . ([scriptblock]::Create($functions['verify-resident.ps1:' + $name]))
}
Yes (Test-ExactPrivileges (ConvertFrom-ScPrivs $qprivs) $BrokerPrivileges) 'verify-qprivs-broker'
Yes (-not (Test-ExactPrivileges (ConvertFrom-ScPrivs $qprivs) $ResidentPrivileges)) 'verify-qprivs-resident-refuses-extra'
Yes (Test-TokenRecord '{"contract":"clued.independent-ci.service-token-privileges/1","pid":4,"privileges":["SeChangeNotifyPrivilege"]}' $ResidentPrivileges) 'token-minimal'
Yes (-not (Test-TokenRecord '{"contract":"clued.independent-ci.service-token-privileges/1","pid":4,"privileges":["SeChangeNotifyPrivilege","SeImpersonatePrivilege"]}' $ResidentPrivileges)) 'token-impersonate-refused'
Yes (-not (Test-TokenRecord '{"contract":"x","privileges":["SeChangeNotifyPrivilege"]}' $ResidentPrivileges)) 'token-contract'
Yes (-not (Test-TokenRecord 'not json' $ResidentPrivileges)) 'token-garbage'
$root = 'C:\ProgramData\CluedIndependentCI\resident'; $sha = 'a' * 64; $profileSha = 'c' * 64
$qc = "SERVICE_NAME: CluedCISwapBroker`r`n        BINARY_PATH_NAME   : `"C:\ProgramData\CluedIndependentCI\resident\bin\SwapBroker.exe`" `"C:\ProgramData\CluedIndependentCI\resident`" $sha $profileSha`r`n        SERVICE_START_NAME : LocalSystem`r`n"
Yes (Test-BrokerBinaryPath $qc $root $sha $profileSha) 'broker-binpath'
Yes (-not (Test-BrokerBinaryPath $qc $root ('b' * 64) $profileSha)) 'broker-binpath-config-pin'
Yes (-not (Test-BrokerBinaryPath ($qc.Replace('SwapBroker.exe', 'Other.exe')) $root $sha $profileSha)) 'broker-binpath-exe'
Yes (-not (Test-BrokerBinaryPath $qc $root $sha ('d' * 64))) 'broker-binpath-profile-pin'
Yes (-not (Test-BrokerBinaryPath $qc $root $sha)) 'broker-binpath-profile-required'
Yes (Test-ScSddl " D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)`r`n" 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)') 'sddl-exact'
Yes (-not (Test-ScSddl 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;RPWP;;;IU)' 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)')) 'sddl-extra-ace'
Yes (-not (Test-ScSddl 'D:x' $null)) 'sddl-no-receipt-value'
# The elevated sdshow also prints the SACL; only the DACL section is compared, in every script.
$dacl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)'
Yes (Test-ScSddl ($dacl + 'S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)' + "`r`n") $dacl) 'sddl-elevated-sacl-ignored'
Yes ((Get-DaclPart ('O:SYG:SY' + $dacl + 'S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)')) -ceq $dacl) 'sddl-owner-group-sacl-stripped'
Yes ((Get-DaclPart 'O:DAG:DAD:(A;;FA;;;SY)S:(AU;FA;FA;;;WD)') -ceq 'D:(A;;FA;;;SY)') 'sddl-alias-before-dacl'
Yes (-not (Test-ScSddl ($dacl.Replace(';;;SU)', ';;;WD)') + 'S:(AU;FA;FA;;;WD)') $dacl)) 'sddl-dacl-change-still-refused'
foreach ($s in @('install-resident.ps1', 'uninstall-resident.ps1')) { Yes ($functions.ContainsKey($s + ':Get-DaclPart') -and $functions[$s + ':Get-DaclPart'] -ceq $functions['verify-resident.ps1:Get-DaclPart']) ('dacl-part-identical:' + $s) }

# 4b. Companion task action: windowless (conhost --headless) with one shape in install and verify; the uninstall
#     stops the node child before the rename; the real in-box conhost hands node exactly these arguments.
foreach ($name in @('install-resident.ps1:Get-CompanionAction', 'verify-resident.ps1:Test-CompanionAction')) { Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name])) }
$croot = 'C:\ProgramData\CluedIndependentCI\resident'; $rsha = 'a' * 64; $csha = 'b' * 64
$ca = Get-CompanionAction $croot $rsha $csha
Yes ($ca.path -ceq 'C:\Windows\System32\conhost.exe' -and $ca.arguments -ceq ('--headless "' + $croot + '\runtime\node.exe" "' + $croot + '\resident\' + $rsha + '\src\companion-main.mjs" --root "' + $croot + '" --config-sha256 ' + $csha)) 'companion-action-shape'
Yes (Test-CompanionAction $ca.path $ca.arguments $croot $rsha) 'companion-action-verified'
Yes (-not (Test-CompanionAction ($croot + '\runtime\node.exe') ('"' + $croot + '\resident\' + $rsha + '\src\companion-main.mjs" --root "' + $croot + '" --config-sha256 ' + $csha) $croot $rsha)) 'companion-action-console-node-refused'
Yes (-not (Test-CompanionAction $ca.path $ca.arguments $croot ('c' * 64))) 'companion-action-other-resident-refused'
Yes (-not (Test-CompanionAction $ca.path ($ca.arguments + ' --extra') $croot $rsha)) 'companion-action-extra-argument-refused'
Yes ($installText.Contains('$a.Path = $ca.path; $a.Arguments = $ca.arguments') -and $installText.Contains('$act.Arguments -cne $ca.arguments')) 'install-registers-and-reads-back-companion-action'
$uninstallText = Get-Content -LiteralPath (Join-Path $here 'uninstall-resident.ps1') -Raw
$killAt = $uninstallText.IndexOf("'COMPANION_STILL_RUNNING_RESIDENT_NOT_RENAMED'")
Yes ($killAt -gt $uninstallText.IndexOf('Unregister-ScheduledTask') -and $killAt -lt $uninstallText.IndexOf('[IO.Directory]::Move($Root')) 'uninstall-stops-companion-before-rename'
$probeNode = 'C:\Program Files\nodejs\node.exe'
if ((Test-Path -LiteralPath $probeNode) -and (Test-Path -LiteralPath $ca.path)) {
  $probeDir = Join-Path $Scratch 'conhost probe'; [void][IO.Directory]::CreateDirectory($probeDir)   # a space, quoted like the real paths
  $probeJs = Join-Path $probeDir 'companion-main.mjs'
  [IO.File]::WriteAllText($probeJs, "import fs from 'node:fs'; fs.writeFileSync(process.argv[1] + '.argv.json', JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) })); setTimeout(() => {}, 60000);")
  $probeArgs = '--headless "' + $probeNode + '" "' + $probeJs + '" --root "' + $probeDir + '" --config-sha256 ' + $csha
  $host1 = Start-Process -FilePath $ca.path -ArgumentList $probeArgs -WindowStyle Hidden -PassThru
  $until = (Get-Date).AddSeconds(20); while (-not (Test-Path -LiteralPath ($probeJs + '.argv.json')) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 200 }
  $host1.Refresh(); $seen = Get-Content -LiteralPath ($probeJs + '.argv.json') -Raw | ConvertFrom-Json
  Yes (((@($seen.argv) -join '|') -ceq ('--root|' + $probeDir + '|--config-sha256|' + $csha)) -and $host1.MainWindowHandle -eq [IntPtr]::Zero) 'conhost-headless-argv-and-no-window'
  Stop-Process -Id $seen.pid -Force -ErrorAction SilentlyContinue; Stop-Process -Id $host1.Id -Force -ErrorAction SilentlyContinue
}

# 4c. Node profile (resident active/standby design v0.4, section 9 C1): install-resident.ps1 takes the host identity
#     from the package's install record (record\acceptance.json `node`) and holds it to the shape rules of
#     resident-v2/prepare-record.mjs; TURING's profile (config\node-profile.turing.json) is the values this harness has
#     always used. verify and uninstall read the installed record's profile (no host constant left in the three).
foreach ($name in @('install-resident.ps1:Assert-NodeProfile', 'install-resident.ps1:Get-PackageNodeProfile', 'install-resident.ps1:Sha256Bytes', 'install-resident.ps1:ConvertTo-NodeProfileCanonical')) { Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name])) }
Yes ($installText -match '(?m)^\$NodeProfileKeys = @\([^\r\n]+\)') 'present:NodeProfileKeys'; . ([scriptblock]::Create($Matches[0]))
$turingText = [IO.File]::ReadAllText((Join-Path $here '..\config\node-profile.turing.json'))
$turing = $turingText | ConvertFrom-Json
Assert-NodeProfile $turing; $n++
Yes ((ConvertTo-NodeProfileCanonical $turing) -ceq $turingText) 'profile-canonical-original-bytes'
Yes ((Sha256Bytes ([Text.Encoding]::UTF8.GetBytes((ConvertTo-NodeProfileCanonical $turing)))) -ceq '4d006ddc5b8cb0a112f67ddf4c07f96ddb5c39623e3eb11617c076708acd9be6') 'profile-canonical-original-hash'
Yes ($turing.hostname -ceq 'TURING' -and $turing.ownerSid -ceq $OwnerSid -and $turing.controllerSid -ceq $ControllerSid -and $turing.runnerService -ceq 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02' -and $turing.wslDistribution -ceq 'Ubuntu-24.04') 'turing-profile-is-todays-values'
function Test-Refused([scriptblock]$body, [string]$code) { try { & $body; return $false } catch { return $_.Exception.Message -ceq $code } }
# The shared cases (independent-ci-v1/test/fixtures/node-profile-cases.json): the JS validator is held to the same answers
# and refusal codes (test/resident-v2-node-profile.test.mjs), so the two cannot drift apart.
$casesText = [IO.File]::ReadAllText((Join-Path $here '..\..\actions-hosted-migration\independent-ci-v1\test\fixtures\node-profile-cases.json'), (New-Object Text.UTF8Encoding($false, $true)))
$cases = $casesText | ConvertFrom-Json
Yes ($cases.contract -ceq 'clued.independent-ci.node-profile-cases/1' -and @($cases.accepted).Count -ge 5 -and @($cases.refused).Count -ge 40) 'node-profile-cases'
function New-CaseProfile($case) {
  $p = ($casesText | ConvertFrom-Json).base
  if ($case.PSObject.Properties.Name -ccontains 'set') { foreach ($f in $case.set.PSObject.Properties) { $p.($f.Name) = $f.Value } }
  if ($case.PSObject.Properties.Name -ccontains 'add') { foreach ($f in $case.add.PSObject.Properties) { $p | Add-Member -NotePropertyName $f.Name -NotePropertyValue $f.Value } }
  if ($case.PSObject.Properties.Name -ccontains 'remove') { $p.PSObject.Properties.Remove($case.remove) }
  $p
}
$i = 0; foreach ($case in @($cases.accepted)) { $i++; $p = New-CaseProfile $case; Assert-NodeProfile $p; $n++ }
$i = 0; foreach ($case in @($cases.refused)) { $i++; $p = New-CaseProfile $case; Yes (Test-Refused { Assert-NodeProfile $p } $case.code) ('node-profile-refused:' + $i + ':' + $case.code) }
Yes (Test-Refused { Assert-NodeProfile $null } 'NODE_PROFILE_FIELDS_REQUIRED') 'node-profile-refused:null'
# The profile is read from the package bytes the reviewed manifest pins, never from anything else.
$PackageRoot = Join-Path $Scratch 'node-package'; [void][IO.Directory]::CreateDirectory((Join-Path $PackageRoot 'record'))
function Write-NodePackage([string]$acceptance) {
  $ab = (New-Object Text.UTF8Encoding($false)).GetBytes($acceptance); [IO.File]::WriteAllBytes((Join-Path $PackageRoot 'record\acceptance.json'), $ab)
  $script:pkgBytes = (New-Object Text.UTF8Encoding($false)).GetBytes('{"contract":"clued.independent-ci.resident-package/3","files":[{"path":"record/acceptance.json","target":"record\\acceptance.json","sha256":"' + (Sha256Bytes $ab) + '"}]}')
  $script:ExpectedPackageManifestSha256 = Sha256Bytes $script:pkgBytes
}
Write-NodePackage ('{"accepted":true,"hostname":"TURING","node":' + $turingText + '}')
Yes ((Get-PackageNodeProfile).nodeName -ceq 'turing') 'package-node-profile-read'
$ExpectedPackageManifestSha256 = 'f' * 64; Yes (Test-Refused { Get-PackageNodeProfile } 'REVIEWED_PACKAGE_CHANGED') 'package-node-profile-manifest-pin'
Write-NodePackage ('{"accepted":true,"hostname":"TURING","node":' + $turingText + '}'); [IO.File]::WriteAllText((Join-Path $PackageRoot 'record\acceptance.json'), '{"hostname":"TURING","node":' + $turingText + '}')
Yes (Test-Refused { Get-PackageNodeProfile } 'PACKAGE_FILE_CHANGED:record\acceptance.json') 'package-node-profile-bytes-pin'
Write-NodePackage '{"accepted":true,"hostname":"TURING"}'; Yes (Test-Refused { Get-PackageNodeProfile } 'PACKAGE_NODE_PROFILE_REQUIRED') 'package-node-profile-missing'
Write-NodePackage ('{"accepted":true,"hostname":"OTHER","node":' + $turingText + '}'); Yes (Test-Refused { Get-PackageNodeProfile } 'NODE_PROFILE_INVALID') 'package-node-profile-hostname'
Yes ($functions['install-resident.ps1:Assert-Owner'].Contains("throw 'NODE_HOST_REQUIRED'") -and $functions['install-resident.ps1:Assert-Owner'].Contains("throw 'NODE_PROFILE_ACCOUNTS_MISMATCH'")) 'install-host-and-accounts-from-profile'
foreach ($s in @('install-resident.ps1', 'verify-resident.ps1', 'uninstall-resident.ps1')) {
  $code = @((Get-Content -LiteralPath (Join-Path $here $s)) | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
  Yes (-not ($code -match 'clued-ci-home-win-02|S-1-5-21-\d+-\d+-\d+-\d+|''TURING''|\(\\\.\|TURING\)')) ('no-host-constant:' + $s)
}

# The same-buffer review pin must be checked before consuming any node-bearing public JSON.
$reviewFile=Join-Path $Scratch 'reviewed-public.json';$reviewText='{"fixture":"public-only"}'
[IO.File]::WriteAllText($reviewFile,$reviewText,(New-Object Text.UTF8Encoding($false)))
$reviewSha=Sha256Bytes ([Text.Encoding]::UTF8.GetBytes($reviewText))
Yes ((Read-ReviewedPublicJson $reviewFile $reviewSha).fixture -ceq 'public-only') 'reviewed-public-same-buffer-positive'
Yes (Test-Refused { Read-ReviewedPublicJson $reviewFile ('0'*64) } 'INSTALL_RECEIPT_CHANGED') 'reviewed-public-wrong-pin-before-profile'
[IO.File]::WriteAllBytes($reviewFile,(New-Object byte[] 0))
Yes (Test-Refused { Read-ReviewedPublicJson $reviewFile $reviewSha } 'INSTALL_RECEIPT_BOUNDARY_REFUSED') 'reviewed-public-empty-refused'
$largeText='{"padding":"'+('a'*(3MB))+'"}';[IO.File]::WriteAllText($reviewFile,$largeText,(New-Object Text.UTF8Encoding($false)))
$largeSha=Sha256Bytes ([Text.Encoding]::UTF8.GetBytes($largeText))
Yes ((Read-ReviewedPublicJson $reviewFile $largeSha 4MB).padding.Length -eq 3MB) 'acceptance-standard-four-mib-domain-kept'
Yes (Test-Refused { Read-ReviewedPublicJson $reviewFile $largeSha } 'INSTALL_RECEIPT_BOUNDARY_REFUSED') 'receipt-config-small-bound-kept'

$verifyText = Get-Content -LiteralPath (Join-Path $here 'verify-resident.ps1') -Raw

# 4d. Node identity and the two secret files (primary/standby C7, Task 088ab175, DESIGN.md section 30). Nothing on the host is read or
#     changed: every path below is in the scratch directory (the install's production targets are only compared as text), the
#     only key is a throw-away RSA key node generates into the scratch directory, the only token a made-up string.
foreach ($name in @('install-resident.ps1:Get-NodeIdentity', 'install-resident.ps1:ConvertTo-NodeIdentityCanonical', 'install-resident.ps1:Sha256Text', 'install-resident.ps1:Sha256File', 'install-resident.ps1:Read-PackageRecordFile', 'install-resident.ps1:Get-PackageNodeIdentity',
  'install-resident.ps1:Get-SecretFileSddl', 'install-resident.ps1:Get-SecretDirectorySddl', 'install-resident.ps1:Open-PackageFileHeld', 'install-resident.ps1:Get-SecretFingerprint', 'install-resident.ps1:Read-SecretSource',
  'install-resident.ps1:Get-SecretsPlan', 'install-resident.ps1:Clear-SecretBytes', 'install-resident.ps1:Write-NewSecret', 'install-resident.ps1:Get-DaclPart')) { Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name])) }
foreach ($var in @('NodeIdentityRefs', 'NodeIdentityKeys')) {
  Yes ($installText -match ('(?m)^\$' + $var + ' = @\([^\r\n]+\)')) ('present:' + $var); $line = $Matches[0]; . ([scriptblock]::Create($line))
  Yes ($verifyText.Contains($line)) ('verify-has-the-same:' + $var)
}
foreach ($name in @('Get-NodeIdentity', 'ConvertTo-NodeIdentityCanonical')) { Yes ($functions['install-resident.ps1:' + $name] -ceq $functions['verify-resident.ps1:' + $name]) ('identity-function-identical:' + $name) }
Yes ($installText -match '(?m)^\$SecretTargets = \[ordered\]@\{[^\r\n]+\}') 'present:SecretTargets'; $targetsLine = $Matches[0]
Yes ($verifyText.Contains($targetsLine)) 'verify-has-the-same-secret-targets'
Yes ($targetsLine.Contains("'C:\ProgramData\CluedControl\trusted\controller-checks-app.pem'") -and $targetsLine.Contains("'C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token'")) 'secret-targets-are-the-runtime-paths'
Yes ($NodeIdentityKeys.Count -eq 16 -and $NodeIdentityRefs.Count -eq 7) 'identity-keys'

# The shared cases: this PowerShell derivation is held to the JavaScript one (test/node-identity.test.mjs reads the same file).
$idCasesText = [IO.File]::ReadAllText((Join-Path $here '..\test\fixtures\node-identity-cases.json'), (New-Object Text.UTF8Encoding($false, $true)))
$idCases = $idCasesText | ConvertFrom-Json
Yes ($idCases.contract -ceq 'clued.independent-ci.node-identity-cases/1' -and @($idCases.refused).Count -ge 30) 'node-identity-cases'
function Set-CasePath($object, [string]$dotted, $value) {
  $parts = $dotted.Split('.'); $at = $object
  for ($i = 0; $i -lt $parts.Count - 1; $i++) { $at = $at.($parts[$i]) }
  $leaf = $parts[$parts.Count - 1]
  if (@($at.PSObject.Properties.Name) -ccontains $leaf) { $at.$leaf = $value } else { $at | Add-Member -NotePropertyName $leaf -NotePropertyValue $value }
}
function New-IdentityCase($case) {
  $n = ($idCasesText | ConvertFrom-Json).nodes.($case.node)
  $docs = @{ installation = $n.installation; accepted = $n.accepted }; $pin = $n.acceptancePin
  foreach ($doc in @('installation', 'accepted')) {
    if (@($case.PSObject.Properties.Name) -ccontains $doc) {
      $edit = $case.$doc
      if (@($edit.PSObject.Properties.Name) -ccontains 'set') { foreach ($f in $edit.set.PSObject.Properties) { Set-CasePath $docs[$doc] $f.Name $f.Value } }
      if (@($edit.PSObject.Properties.Name) -ccontains 'remove') { foreach ($k in @($edit.remove)) { [void]$docs[$doc].PSObject.Properties.Remove($k) } }
    }
  }
  if (@($case.PSObject.Properties.Name) -ccontains 'pin') { $pin = $case.pin }
  [pscustomobject]@{ installation = $docs.installation; accepted = $docs.accepted; pin = $pin }
}
foreach ($nodeName in @('turing', 'company')) {
  $nd = ($idCasesText | ConvertFrom-Json).nodes.$nodeName
  $id = Get-NodeIdentity $nd.installation $nd.accepted $nd.acceptancePin
  Yes ((ConvertTo-NodeIdentityCanonical $id) -ceq (ConvertTo-NodeIdentityCanonical $nd.identity)) ('identity-derived:' + $nodeName)
  Yes ((Sha256Text (ConvertTo-NodeIdentityCanonical $id)) -ceq $nd.identitySha256) ('identity-sha-equals-the-javascript-one:' + $nodeName)
}
Yes ((($idCases.nodes.turing.identity.nodeName) -ceq 'turing') -and (($idCases.nodes.company.identity.nodeName) -ceq 'company') -and $idCases.nodes.turing.identitySha256 -cne $idCases.nodes.company.identitySha256) 'two-different-node-identities'
$i = 0; foreach ($case in @($idCases.refused)) { $i++; $c = New-IdentityCase $case; Yes (Test-Refused { Get-NodeIdentity $c.installation $c.accepted $c.pin } $case.code) ('node-identity-refused:' + $i + ':' + $case.node + ':' + $case.name) }
Yes (Test-Refused { Get-NodeIdentity $null $null ('a' * 64) } 'NODE_IDENTITY_FIELDS_REQUIRED') 'node-identity-refused:null'

# The package side: both record files are read once from the bytes the reviewed manifest pins, and the identity must be the one the build pinned.
function Write-IdentityPackage([string]$dir, $nd, [string]$identitySha, [switch]$Disagree) {
  [void][IO.Directory]::CreateDirectory((Join-Path $dir 'record'))
  $enc = New-Object Text.UTF8Encoding($false)
  $accBytes = $enc.GetBytes(($nd.accepted | ConvertTo-Json -Depth 8 -Compress))
  $inst = $nd.installation | ConvertTo-Json -Depth 8 | ConvertFrom-Json; $inst.acceptanceSha256 = Sha256Bytes $accBytes
  if ($Disagree) { $inst.ciTokenPinSha256 = 'f' * 64 }
  $instBytes = $enc.GetBytes(($inst | ConvertTo-Json -Depth 8 -Compress))
  [IO.File]::WriteAllBytes((Join-Path $dir 'record\acceptance.json'), $accBytes); [IO.File]::WriteAllBytes((Join-Path $dir 'record\installation.json'), $instBytes)
  $manifest = [ordered]@{ contract = 'clued.independent-ci.resident-package/3'; files = @(
    [ordered]@{ path = 'record/installation.json'; target = 'record\installation.json'; sha256 = (Sha256Bytes $instBytes) },
    [ordered]@{ path = 'record/acceptance.json'; target = 'record\acceptance.json'; sha256 = (Sha256Bytes $accBytes) }) }
  if ($identitySha) { $manifest.nodeIdentitySha256 = $identitySha }
  $script:pkgBytes = $enc.GetBytes(($manifest | ConvertTo-Json -Depth 6)); $script:PackageRoot = $dir; $script:ExpectedPackageManifestSha256 = Sha256Bytes $script:pkgBytes
}
foreach ($nodeName in @('turing', 'company')) {
  $nd = ($idCasesText | ConvertFrom-Json).nodes.$nodeName
  Write-IdentityPackage (Join-Path $Scratch ('identity-package-' + $nodeName)) $nd $nd.identitySha256
  $fromPackage = Get-PackageNodeIdentity
  Yes ((ConvertTo-NodeIdentityCanonical $fromPackage) -ceq (ConvertTo-NodeIdentityCanonical $nd.identity) -and $fromPackage.nodeName -ceq $nodeName) ('package-identity:' + $nodeName)
}
$nd = ($idCasesText | ConvertFrom-Json).nodes.company
Write-IdentityPackage (Join-Path $Scratch 'identity-package-no-pin') $nd ''; Yes (Test-Refused { Get-PackageNodeIdentity } 'PACKAGE_NODE_IDENTITY_REQUIRED') 'package-identity-pin-required'
Write-IdentityPackage (Join-Path $Scratch 'identity-package-wrong-pin') $nd ('0' * 64); Yes (Test-Refused { Get-PackageNodeIdentity } 'PACKAGE_NODE_IDENTITY_CHANGED') 'package-identity-pin-mismatch'
Write-IdentityPackage (Join-Path $Scratch 'identity-package-turing-pin') $nd $idCases.nodes.turing.identitySha256; Yes (Test-Refused { Get-PackageNodeIdentity } 'PACKAGE_NODE_IDENTITY_CHANGED') 'package-identity-other-nodes-pin'
Write-IdentityPackage (Join-Path $Scratch 'identity-package-disagree') $nd $nd.identitySha256 -Disagree; Yes (Test-Refused { Get-PackageNodeIdentity } 'NODE_IDENTITY_RECORDS_DISAGREE') 'package-identity-record-files-disagree'
Write-IdentityPackage (Join-Path $Scratch 'identity-package-edited') $nd $nd.identitySha256
[IO.File]::WriteAllText((Join-Path $PackageRoot 'record\installation.json'), '{"appKeyId":1}'); Yes (Test-Refused { Get-PackageNodeIdentity } 'PACKAGE_FILE_CHANGED:record\installation.json') 'package-identity-bytes-pin'

# The verify side: the receipt's identity against the installed record, and the receipt's word about the two files.
foreach ($name in @('Get-Field', 'Sha256Text', 'Test-SecretFileSecurity', 'Test-NodeIdentityReceipt', 'Test-SecretsReceipt', 'Get-SecretFileState')) { Yes ($functions.ContainsKey('verify-resident.ps1:' + $name)) ('verify-present:' + $name); . ([scriptblock]::Create($functions['verify-resident.ps1:' + $name])) }
Yes ($verifyText -match '(?m)^\$SecretAdmins = @\([^\r\n]+\)') 'verify-present:SecretAdmins'; . ([scriptblock]::Create($Matches[0]))
. ([scriptblock]::Create($targetsLine))
function New-IdentityReceipt($id, [string]$role = 'NONE', [bool]$keyPlaced = $true, [bool]$tokenPlaced = $false) {
  $r = [ordered]@{ nodeIdentity = $id; nodeIdentitySha256 = (Sha256Text (ConvertTo-NodeIdentityCanonical $id)); roleAssumption = $role
    secrets = [ordered]@{ appKey = [ordered]@{ target = $SecretTargets.appKey; placed = $keyPlaced; fingerprint = $(if ($keyPlaced) { $id.appPublicKeySha256Base64 } else { $null }) }
      ciToken = [ordered]@{ target = $SecretTargets.ciToken; placed = $tokenPlaced; fingerprint = $(if ($tokenPlaced) { $id.ciTokenPinSha256 } else { $null }) } } }
  if ($role -eq '') { $r.Remove('roleAssumption') }
  ($r | ConvertTo-Json -Depth 6) | ConvertFrom-Json   # as verify reads the receipt: parsed from the file
}
foreach ($nodeName in @('turing', 'company')) {
  $nd = ($idCasesText | ConvertFrom-Json).nodes.$nodeName
  $receipt = New-IdentityReceipt $nd.identity
  $res = Test-NodeIdentityReceipt $receipt $nd.installation $nd.accepted $nd.acceptancePin
  Yes ($res.ok -eq $true -and $res.detail -ceq $nodeName -and $res.identity.nodeName -ceq $nodeName) ('verify-node-identity:' + $nodeName)
  Yes ((Test-SecretsReceipt $receipt $res.identity) -and (Test-SecretsReceipt (New-IdentityReceipt $nd.identity 'NONE' $true $true) $res.identity) -and (Test-SecretsReceipt (New-IdentityReceipt $nd.identity 'NONE' $false $false) $res.identity)) ('verify-secrets-receipt:' + $nodeName)
}
$company = ($idCasesText | ConvertFrom-Json).nodes.company; $turing = ($idCasesText | ConvertFrom-Json).nodes.turing
$res = Test-NodeIdentityReceipt (New-IdentityReceipt $turing.identity) $company.installation $company.accepted $company.acceptancePin
Yes ($res.ok -eq $false -and $res.detail -ceq 'NODE_IDENTITY_CHANGED') 'verify-node-identity:another-nodes-receipt'
foreach ($role in @('ACTIVE', 'STANDBY', '')) {
  $res = Test-NodeIdentityReceipt (New-IdentityReceipt $company.identity $role) $company.installation $company.accepted $company.acceptancePin
  Yes ($res.ok -eq $false -and $res.detail -ceq 'ROLE_ASSUMED_AT_INSTALL') ('verify-node-identity:role-assumed:' + $role)
}
$changed = $company.identity | ConvertTo-Json | ConvertFrom-Json; $changed.ciTokenPinSha256 = 'e' * 64
$res = Test-NodeIdentityReceipt (New-IdentityReceipt $changed) $company.installation $company.accepted $company.acceptancePin
Yes ($res.ok -eq $false -and $res.detail -ceq 'NODE_IDENTITY_CHANGED') 'verify-node-identity:receipt-token-pin-edited'
$bad = New-IdentityReceipt $company.identity; $bad.nodeIdentitySha256 = '9' * 64
Yes ((Test-NodeIdentityReceipt $bad $company.installation $company.accepted $company.acceptancePin).detail -ceq 'NODE_IDENTITY_CHANGED') 'verify-node-identity:receipt-sha-edited'
$bad = New-IdentityReceipt $company.identity; $bad.nodeIdentity.PSObject.Properties.Remove('appKeyId')
Yes ((Test-NodeIdentityReceipt $bad $company.installation $company.accepted $company.acceptancePin).detail -ceq 'NODE_IDENTITY_CHANGED') 'verify-node-identity:receipt-field-missing'
$installedEdited = $company.installation | ConvertTo-Json -Depth 8 | ConvertFrom-Json; $installedEdited.ciTokenPinSha256 = 'd' * 64
Yes ((Test-NodeIdentityReceipt (New-IdentityReceipt $company.identity) $installedEdited $company.accepted $company.acceptancePin).detail -ceq 'NODE_IDENTITY_RECORDS_DISAGREE') 'verify-node-identity:the-two-record-files-disagree'
$bothEdited = $company.accepted | ConvertTo-Json -Depth 8 | ConvertFrom-Json; $bothEdited.ciTokenPinSha256 = 'd' * 64
Yes ((Test-NodeIdentityReceipt (New-IdentityReceipt $company.identity) $installedEdited $bothEdited $company.acceptancePin).detail -ceq 'NODE_IDENTITY_CHANGED') 'verify-node-identity:both-files-edited-the-receipt-still-holds-the-old-identity'
Yes ((Test-NodeIdentityReceipt (New-IdentityReceipt $company.identity) $company.installation $company.accepted ('c' * 64)).detail -ceq 'NODE_IDENTITY_ACCEPTANCE_PIN_MISMATCH') 'verify-node-identity:acceptance-bytes-changed'
$ok = Test-NodeIdentityReceipt (New-IdentityReceipt $company.identity) $company.installation $company.accepted $company.acceptancePin
$other = New-IdentityReceipt $company.identity; $other.secrets.appKey.fingerprint = 'A' * 43 + '='
Yes (-not (Test-SecretsReceipt $other $ok.identity)) 'verify-secrets-receipt:placed-with-another-fingerprint'
$other = New-IdentityReceipt $company.identity 'NONE' $false $false; $other.secrets.ciToken.fingerprint = $company.identity.ciTokenPinSha256
Yes (-not (Test-SecretsReceipt $other $ok.identity)) 'verify-secrets-receipt:not-placed-but-a-fingerprint'
$other = New-IdentityReceipt $company.identity; $other.secrets.appKey.target = 'C:\elsewhere\app.pem'
Yes (-not (Test-SecretsReceipt $other $ok.identity)) 'verify-secrets-receipt:another-target'
$other = New-IdentityReceipt $company.identity; $other.PSObject.Properties.Remove('secrets')
Yes (-not (Test-SecretsReceipt $other $ok.identity) -and -not (Test-SecretsReceipt (New-IdentityReceipt $company.identity) $null)) 'verify-secrets-receipt:missing'

# The secret files' security descriptors: what the install creates is what verify accepts, and what the runtime would refuse is refused.
$ctrl = $ControllerSid; $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function New-Acl([string]$sddl) { $a = New-Object Security.AccessControl.FileSecurity; $a.SetSecurityDescriptorSddlForm($sddl); $a }
$goodSddl = Get-SecretFileSddl $ctrl
Yes ($goodSddl -ceq ('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $ctrl + ')')) 'secret-file-sddl'
Yes (Test-SecretFileSecurity (New-Acl $goodSddl) $ctrl) 'secret-file-acl:what-install-creates-verify-accepts'
$aces = @((New-Object Security.AccessControl.RawSecurityDescriptor($goodSddl)).DiscretionaryAcl)
Yes ($aces.Count -eq 3 -and @($aces | Where-Object { $_.SecurityIdentifier.Value -ceq $ctrl -and $_.AccessMask -eq 0x120089 -and [int]$_.AceFlags -eq 0 }).Count -eq 1) 'secret-file-acl:controller-read-only-no-inheritance'
Yes ((New-Object Security.AccessControl.RawSecurityDescriptor($goodSddl)).Owner.Value -ceq 'S-1-5-32-544' -and ((New-Object Security.AccessControl.RawSecurityDescriptor($goodSddl)).ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) 'secret-file-acl:owner-administrators-protected'
$dirAces = @((New-Object Security.AccessControl.RawSecurityDescriptor((Get-SecretDirectorySddl $ctrl))).DiscretionaryAcl)
Yes ($dirAces.Count -eq 3 -and @($dirAces | Where-Object { $_.SecurityIdentifier.Value -ceq $ctrl -and $_.AccessMask -eq 0x1200a9 }).Count -eq 1) 'secret-directory-acl:controller-read-execute-only'
foreach ($pair in @(
  @('owner-is-not-an-administrator', ('O:' + $me + 'G:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $ctrl + ')')),
  @('a-user-can-read', ($goodSddl + '(A;;FR;;;BU)')), @('everyone-can-read', ($goodSddl + '(A;;FR;;;WD)')),
  @('a-user-can-write-attributes', ($goodSddl + '(A;;0x100;;;BU)')), @('a-user-can-delete', ($goodSddl + '(A;;0x10000;;;BU)')),
  @('the-controller-can-write', ('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;' + $ctrl + ')')),
  @('the-controller-cannot-read', 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'),
  @('another-account-instead-of-the-controller', ('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $me + ')')))) {
  Yes (-not (Test-SecretFileSecurity (New-Acl $pair[1]) $ctrl)) ('secret-file-acl:refused:' + $pair[0])
}

# 4e. The fingerprint check and the placement, against a scratch package and scratch targets (the real node and the real tool of this
#     checkout run on a throw-away key and a made-up token). Skipped, and said so in the result, when this machine has no node.
$secretCheck = 'skipped-no-node'
$secretState = Get-SecretFileState (Join-Path $Scratch 'secrets-fs\no-such-file') $ctrl
Yes ($secretState -ceq 'absent') 'secret-file-state:absent'
[void][IO.Directory]::CreateDirectory((Join-Path $Scratch 'secrets-fs')); $plainFile = Join-Path $Scratch 'secrets-fs\plain.bin'; [IO.File]::WriteAllText($plainFile, 'x')
Yes ((Get-SecretFileState $plainFile $ctrl) -ceq 'acl-refused') 'secret-file-state:an-ordinary-file-is-refused'
if (Test-Path -LiteralPath $probeNode) {
  $secretCheck = 'checked'
  $enc = New-Object Text.UTF8Encoding($false)
  # A package with a space in its path (like a real Downloads folder), holding the pinned node and the reviewed tool.
  $sp = Join-Path $Scratch 'secret package'; $residentSha = 'a' * 64
  [void][IO.Directory]::CreateDirectory((Join-Path $sp 'runtime')); [void][IO.Directory]::CreateDirectory((Join-Path $sp 'resident\tools'))
  Copy-Item -LiteralPath $probeNode -Destination (Join-Path $sp 'runtime\node.exe')
  Copy-Item -LiteralPath (Join-Path $here '..\tools\secret-fingerprint.mjs') -Destination (Join-Path $sp 'resident\tools\secret-fingerprint.mjs')
  function Write-SecretPackage {
    $m = [ordered]@{ contract = 'clued.independent-ci.resident-package/3'; files = @(
      [ordered]@{ path = 'runtime/node.exe'; target = 'runtime\node.exe'; sha256 = (Sha256File (Join-Path $sp 'runtime\node.exe')) },
      [ordered]@{ path = 'resident/tools/secret-fingerprint.mjs'; target = ('resident\' + $residentSha + '\tools\secret-fingerprint.mjs'); sha256 = (Sha256File (Join-Path $sp 'resident\tools\secret-fingerprint.mjs')) }) }
    $script:pkgBytes = $enc.GetBytes(($m | ConvertTo-Json -Depth 6)); $script:PackageRoot = $sp; $script:ExpectedPackageManifestSha256 = Sha256Bytes $script:pkgBytes
  }
  Write-SecretPackage
  # A throw-away RSA key, made by node in the scratch directory, with the runtime's own formula for its fingerprint.
  $gen = Join-Path $Scratch 'make-throwaway-key.mjs'
  [IO.File]::WriteAllText($gen, "import { generateKeyPairSync, createHash, createPublicKey } from 'node:crypto'; import fs from 'node:fs';`nconst { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });`nconst pem = privateKey.export({ type: 'pkcs8', format: 'pem' }); fs.writeFileSync(process.argv[2], pem);`nconsole.log(createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('base64'));")
  $keyA = Join-Path $Scratch 'secrets-fs\key-a.pem'; $keyB = Join-Path $Scratch 'secrets-fs\key-b.pem'
  $fpA = (& $probeNode $gen $keyA | Out-String).Trim(); $fpB = (& $probeNode $gen $keyB | Out-String).Trim()
  Yes ($LASTEXITCODE -eq 0 -and $fpA -cmatch '^[A-Za-z0-9+/]{43}=$' -and $fpB -cmatch '^[A-Za-z0-9+/]{43}=$' -and $fpA -cne $fpB) 'throwaway-keys'
  $tokenText = 'clued_bnd_' + 'FixtureTokenValue0123456789'; $tokenFile = Join-Path $Scratch 'secrets-fs\token-a.txt'; [IO.File]::WriteAllText($tokenFile, $tokenText + "`r`n")
  $tokenPin = Sha256Text ("clued.independent-ci.ci-binding-pin/1`0" + $tokenText)
  $keyBytes = [IO.File]::ReadAllBytes($keyA); $tokenBytes = [IO.File]::ReadAllBytes($tokenFile)

  Yes ((Get-SecretFingerprint 'app-key' $keyBytes) -ceq $fpA) 'fingerprint:app-key-equals-the-runtime-formula'
  Yes ((Get-SecretFingerprint 'ci-token' $tokenBytes) -ceq $tokenPin) 'fingerprint:ci-token-equals-the-runtime-pin'
  Yes ((Get-SecretFingerprint 'ci-token' $enc.GetBytes($tokenText)) -ceq $tokenPin) 'fingerprint:ci-token-without-newline'
  Yes ($null -eq (Get-SecretFingerprint 'app-key' $enc.GetBytes('not a key')) -and $null -eq (Get-SecretFingerprint 'ci-token' $enc.GetBytes('clued_bnd_x')) -and $null -eq (Get-SecretFingerprint 'app-key' $tokenBytes)) 'fingerprint:not-a-key-not-a-token-refused'
  # held open: no writer, no deleter while the install runs the tool; free again afterwards
  $held = Open-PackageFileHeld ('resident\' + $residentSha + '\tools\secret-fingerprint.mjs')
  $blocked = $false; try { $w = [IO.File]::Open($held.path, 'Open', 'Write', 'ReadWrite'); $w.Dispose() } catch [IO.IOException] { $blocked = $true }
  $held.stream.Dispose()
  $w = [IO.File]::Open((Join-Path $sp 'resident\tools\secret-fingerprint.mjs'), 'Open', 'Write', 'ReadWrite'); $w.Dispose()
  Yes $blocked 'package-file-held-open-against-writers'
  [IO.File]::AppendAllText((Join-Path $sp 'resident\tools\secret-fingerprint.mjs'), ' ')   # the tool changes after the manifest was reviewed
  Yes (Test-Refused { Get-SecretFingerprint 'ci-token' $tokenBytes } ('PACKAGE_FILE_CHANGED:resident\' + $residentSha + '\tools\secret-fingerprint.mjs')) 'fingerprint:changed-tool-refused'
  Copy-Item -LiteralPath (Join-Path $here '..\tools\secret-fingerprint.mjs') -Destination (Join-Path $sp 'resident\tools\secret-fingerprint.mjs') -Force
  [IO.File]::AppendAllText((Join-Path $sp 'runtime\node.exe'), ' ')   # same for the node copy
  Yes (Test-Refused { Get-SecretFingerprint 'ci-token' $tokenBytes } 'PACKAGE_FILE_CHANGED:runtime\node.exe') 'fingerprint:changed-node-refused'
  Remove-Item -LiteralPath (Join-Path $sp 'runtime\node.exe') -Force; Copy-Item -LiteralPath $probeNode -Destination (Join-Path $sp 'runtime\node.exe')

  # The plan's secrets part, against scratch targets: nothing supplied, everything right, and every way to fail closed.
  $fakeProgramData = Join-Path $Scratch 'ProgramData'
  $script:SecretTargets = [ordered]@{ appKey = (Join-Path $fakeProgramData 'CluedControl\trusted\controller-checks-app.pem'); ciToken = (Join-Path $fakeProgramData 'CluedIndependentCI\secrets\ci-admission.token') }
  $script:Identity = [pscustomobject]@{ appPublicKeySha256Base64 = $fpA; ciTokenPinSha256 = $tokenPin }
  $script:ControllerSid = $ctrl; $script:SecretBytes = @{}
  $script:AppPrivateKeyFile = ''; $script:CiAdmissionTokenFile = ''
  [void][IO.Directory]::CreateDirectory((Join-Path $fakeProgramData 'CluedControl\trusted')); [void][IO.Directory]::CreateDirectory((Join-Path $fakeProgramData 'CluedIndependentCI'))
  $none = Get-SecretsPlan
  Yes ($none.appKey.supplied -eq $false -and $none.ciToken.supplied -eq $false -and $none.appKey.verified -eq $false -and $script:SecretBytes.Count -eq 0 -and -not $none.appKey.createsDirectory) 'secrets-plan:nothing-supplied-nothing-read'
  $script:AppPrivateKeyFile = $keyA; $script:CiAdmissionTokenFile = $tokenFile
  $both = Get-SecretsPlan
  Yes ($both.appKey.supplied -and $both.appKey.verified -and $both.ciToken.supplied -and $both.ciToken.verified -and $both.ciToken.createsDirectory -and -not $both.appKey.createsDirectory -and $both.ciToken.directorySddl -ceq (Get-SecretDirectorySddl $ctrl) -and $both.appKey.sddl -ceq $goodSddl) 'secrets-plan:supplied-and-verified'
  Yes ((Sha256Bytes $script:SecretBytes.appKey) -ceq (Sha256Bytes $keyBytes) -and (Sha256Bytes $script:SecretBytes.ciToken) -ceq (Sha256Bytes $tokenBytes)) 'secrets-plan:exactly-the-fingerprinted-bytes-are-kept'
  $planJson = $both | ConvertTo-Json -Depth 6
  Yes (-not $planJson.Contains('PRIVATE KEY') -and -not $planJson.Contains($tokenText) -and $planJson.Contains($fpA) -and $planJson.Contains($tokenPin)) 'secrets-plan:fingerprints-only'
  Clear-SecretBytes; Yes ($script:SecretBytes.Count -eq 0 -and (@($keyBytes).Count -gt 0)) 'secrets-plan:bytes-cleared'
  $script:SecretBytes = @{}
  # fail closed: a key or token with another fingerprint, files that are not what they should be, targets that exist
  $script:AppPrivateKeyFile = $keyB; $script:CiAdmissionTokenFile = ''
  Yes (Test-Refused { Get-SecretsPlan } 'APP_KEY_FINGERPRINT_MISMATCH') 'secrets-plan:another-app-key-refused'
  $script:AppPrivateKeyFile = ''; $script:CiAdmissionTokenFile = $tokenFile
  $script:Identity = [pscustomobject]@{ appPublicKeySha256Base64 = $fpA; ciTokenPinSha256 = ('0' * 64) }
  Yes (Test-Refused { Get-SecretsPlan } 'CI_TOKEN_FINGERPRINT_MISMATCH') 'secrets-plan:another-token-refused'
  $script:Identity = [pscustomobject]@{ appPublicKeySha256Base64 = $fpA; ciTokenPinSha256 = $tokenPin }
  $notKey = Join-Path $Scratch 'secrets-fs\not-a-key.pem'; [IO.File]::WriteAllText($notKey, 'hello'); $script:AppPrivateKeyFile = $notKey; $script:CiAdmissionTokenFile = ''
  Yes (Test-Refused { Get-SecretsPlan } 'APP_KEY_UNREADABLE') 'secrets-plan:not-a-private-key-refused'
  $script:AppPrivateKeyFile = (Join-Path $Scratch 'secrets-fs\missing.pem'); Yes (Test-Refused { Get-SecretsPlan } 'APP_KEY_SOURCE_REFUSED') 'secrets-plan:missing-source-refused'
  $script:AppPrivateKeyFile = (Join-Path $Scratch 'secrets-fs'); Yes (Test-Refused { Get-SecretsPlan } 'APP_KEY_SOURCE_REFUSED') 'secrets-plan:directory-source-refused'
  $empty = Join-Path $Scratch 'secrets-fs\empty.pem'; [IO.File]::WriteAllBytes($empty, (New-Object byte[] 0)); $script:AppPrivateKeyFile = $empty; Yes (Test-Refused { Get-SecretsPlan } 'APP_KEY_SOURCE_REFUSED') 'secrets-plan:empty-source-refused'
  $big = Join-Path $Scratch 'secrets-fs\big.txt'; [IO.File]::WriteAllBytes($big, (New-Object byte[] 5000)); $script:AppPrivateKeyFile = ''; $script:CiAdmissionTokenFile = $big
  Yes (Test-Refused { Get-SecretsPlan } 'CI_TOKEN_SOURCE_REFUSED') 'secrets-plan:oversized-source-refused'
  $script:AppPrivateKeyFile = $keyA; $script:CiAdmissionTokenFile = ''
  [IO.File]::WriteAllText($script:SecretTargets.appKey, 'already here')
  Yes (Test-Refused { Get-SecretsPlan } 'APP_KEY_TARGET_EXISTS_NOT_OVERWRITTEN') 'secrets-plan:existing-key-never-overwritten'
  Remove-Item -LiteralPath $script:SecretTargets.appKey -Force
  $script:SecretTargets = [ordered]@{ appKey = (Join-Path $fakeProgramData 'CluedControl\no-trusted-here\controller-checks-app.pem'); ciToken = $script:SecretTargets.ciToken }
  Yes (Test-Refused { Get-SecretsPlan } 'APP_KEY_TARGET_DIRECTORY_MISSING') 'secrets-plan:controller-tree-is-not-created-by-this-install'
  $linkTarget = Join-Path $Scratch 'elsewhere'; [void][IO.Directory]::CreateDirectory($linkTarget); $link = Join-Path $fakeProgramData 'CluedControl\linked'
  $null = New-Item -ItemType Junction -Path $link -Target $linkTarget
  $script:SecretTargets = [ordered]@{ appKey = (Join-Path $link 'controller-checks-app.pem'); ciToken = $script:SecretTargets.ciToken }
  Yes (Test-Refused { Get-SecretsPlan } 'APP_KEY_TARGET_DIRECTORY_REFUSED') 'secrets-plan:linked-target-directory-refused'
  Yes ($script:SecretBytes.Count -eq 0) 'secrets-plan:a-refusal-keeps-no-bytes'
  $script:AppPrivateKeyFile = ''; $script:CiAdmissionTokenFile = $tokenFile
  [void][IO.Directory]::CreateDirectory((Join-Path $fakeProgramData 'CluedIndependentCI\secrets')); [IO.File]::WriteAllText($script:SecretTargets.ciToken, 'already here')
  Yes (Test-Refused { Get-SecretsPlan } 'CI_TOKEN_TARGET_EXISTS_NOT_OVERWRITTEN') 'secrets-plan:existing-token-never-overwritten'
  Remove-Item -LiteralPath (Join-Path $fakeProgramData 'CluedIndependentCI\secrets') -Recurse -Force
  [void][IO.Directory]::Delete($link)

  # Placement: create-only, the exact bytes, the final security descriptor (here: this account stands in for .\clued-control).
  $placeSddl = 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $me + ')'
  $placed = Join-Path $Scratch 'secrets-fs\placed.bin'
  Write-NewSecret $placed $keyBytes $placeSddl
  Yes ((Sha256File $placed) -ceq (Sha256Bytes $keyBytes)) 'place:exact-bytes'
  $placedAces = @((New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $placed).Sddl)).DiscretionaryAcl)
  Yes ($placedAces.Count -eq 3 -and @($placedAces | Where-Object { $_.SecurityIdentifier.Value -ceq $me -and $_.AccessMask -eq 0x120089 }).Count -eq 1) 'place:final-descriptor-from-the-first-moment'
  $second = $false; try { Write-NewSecret $placed $tokenBytes $placeSddl } catch { $second = $true }
  Yes ($second -and (Sha256File $placed) -ceq (Sha256Bytes $keyBytes)) 'place:create-only-never-overwrites'
  # the file is read-only for this account by design (the stand-in controller): the owner takes delete back before the cleanup
  $fi = New-Object IO.FileInfo($placed); $acl = $fi.GetAccessControl([Security.AccessControl.AccessControlSections]::Access); $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($me)), 'FullControl', 'Allow'))); $fi.SetAccessControl($acl)
  Remove-Item -LiteralPath $placed -Force
  Remove-Item -LiteralPath (Join-Path $sp 'runtime\node.exe') -Force   # the scratch copy of node (about 90 MB)
}

# 5. C#: the broker's bounded read and both token checks (compiled into the scratch directory).
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'; $csc = Join-Path $fw 'csc.exe'
$v2 = [IO.Path]::GetFullPath((Join-Path $here '..\..\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows'))
$refs = @("/reference:$($fw)System.dll", "/reference:$($fw)System.Core.dll", "/reference:$($fw)System.ServiceProcess.dll", "/reference:$($fw)System.Web.Extensions.dll")
& $csc /nologo /noconfig /target:exe /main:BrokerPureTests $refs ('/out:' + (Join-Path $Scratch 'broker-pure.exe')) (Join-Path $here 'SwapBroker.cs') (Join-Path $here 'ResidentServiceHost.cs') (Join-Path $here 'BrokerPureTests.cs') (Join-Path $v2 'ResidentScmV2.cs') (Join-Path $v2 'ScmPidHandshakeV2.cs') (Join-Path $v2 'NodeProfileV2.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-broker-pure'
# exactly the install-time compile lines (install-resident.ps1 step service-hosts)
& $csc /nologo /noconfig /target:exe /optimize+ ('/out:' + (Join-Path $Scratch 'ResidentServiceHost.exe')) "/reference:$($fw)System.dll" "/reference:$($fw)System.ServiceProcess.dll" (Join-Path $here 'ResidentServiceHost.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-resident-host'
& $csc /nologo /noconfig /target:exe /optimize+ ('/out:' + (Join-Path $Scratch 'SwapBroker.exe')) $refs (Join-Path $here 'SwapBroker.cs') (Join-Path $v2 'ResidentScmV2.cs') (Join-Path $v2 'ScmPidHandshakeV2.cs') (Join-Path $v2 'NodeProfileV2.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-broker'
$out = & (Join-Path $Scratch 'broker-pure.exe') | Out-String
Yes ($LASTEXITCODE -eq 0 -and $out -match 'BROKER_PURE_PASS') ('broker-pure:' + $out.Trim())
$csharp = [int](($out | ConvertFrom-Json).assertions)

# 6. C#: the resident host's stop handling (stop re-entry, Task fe6cd7bc), with the install-time references only.
& $csc /nologo /noconfig /target:exe /main:HostPureTests ('/out:' + (Join-Path $Scratch 'host-pure.exe')) "/reference:$($fw)System.dll" "/reference:$($fw)System.ServiceProcess.dll" (Join-Path $here 'ResidentServiceHost.cs') (Join-Path $here 'HostPureTests.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-host-pure'
$out = & (Join-Path $Scratch 'host-pure.exe') | Out-String
Yes ($LASTEXITCODE -eq 0 -and $out -match 'HOST_PURE_PASS') ('host-pure:' + $out.Trim())
$serviceHostCsharp = [int](($out | ConvertFrom-Json).assertions)

# 7. One clock for the host and the executor (Task d80fd886): the stop request carries the host's GetTickCount64,
#    and the executor compares it with node's uptimeMs(). Read between two GetTickCount64 calls, node's value must
#    lie between them. A runtime whose uptime leaves out sleep would fall outside on any machine that has slept.
#    This checks the node on this machine, not the packaged runtime; the result says whether it ran.
$uptimeClock = 'skipped-no-node'
if (Test-Path -LiteralPath $probeNode) {
  Add-Type -Namespace CluedResidentTest -Name Tick -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern ulong GetTickCount64();'
  $lockUrl = ([Uri][IO.Path]::GetFullPath((Join-Path $here '..\src\instance-lock.mjs'))).AbsoluteUri
  $before = [CluedResidentTest.Tick]::GetTickCount64()
  $nodeMs = [uint64](& $probeNode --input-type=module -e 'const m = await import(process.argv[1]); process.stdout.write(String(m.uptimeMs()));' $lockUrl)
  $after = [CluedResidentTest.Tick]::GetTickCount64()
  Yes ($LASTEXITCODE -eq 0 -and $nodeMs -ge $before -and $nodeMs -le $after) ('node-uptime-is-gettickcount64:' + $before + '/' + $nodeMs + '/' + $after)
  $uptimeClock = 'checked'
}
[ordered]@{ status = 'RESIDENT_WINDOWS_OFFLINE_PASS'; assertions = $n; csharpAssertions = $csharp; serviceHostCsharpAssertions = $serviceHostCsharp; uptimeClock = $uptimeClock; secretFingerprint = $secretCheck; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
