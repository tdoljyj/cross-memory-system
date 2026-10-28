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
[ordered]@{ status = 'RESIDENT_WINDOWS_OFFLINE_PASS'; assertions = $n; csharpAssertions = $csharp; serviceHostCsharpAssertions = $serviceHostCsharp; uptimeClock = $uptimeClock; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
