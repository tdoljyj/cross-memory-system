<#
  Offline checks of the resident's Windows privilege boundary (independent review of PR-A: MAJOR-1, MINOR-2,
  MINOR-3 via the Source v2 harness, MINOR-4, MINOR-5, MINOR-9). Nothing on the host is read or changed:
  - install-resident.ps1 and verify-resident.ps1 parse; their pure helper functions are taken from the real
    scripts by AST and exercised on recorded sc.exe output shapes;
  - the directory ACL plan is checked ACE by ACE (create-only Owner drop boxes, no DELETE for the resident on
    broker\requests, OWNER RIGHTS restriction);
  - SwapBroker.cs, ResidentServiceHost.cs and BrokerPureTests.cs are compiled with the in-box csc into the NEW
    scratch directory given by the caller and the broker's bounded read and both token checks are run.
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
foreach ($name in @('ConvertFrom-ScPrivs', 'Test-ExactPrivileges', 'Test-TokenRecord', 'Test-BrokerBinaryPath', 'Test-ScSddl')) {
  Yes ($functions.ContainsKey('verify-resident.ps1:' + $name)) ('verify-present:' + $name); . ([scriptblock]::Create($functions['verify-resident.ps1:' + $name]))
}
Yes (Test-ExactPrivileges (ConvertFrom-ScPrivs $qprivs) $BrokerPrivileges) 'verify-qprivs-broker'
Yes (-not (Test-ExactPrivileges (ConvertFrom-ScPrivs $qprivs) $ResidentPrivileges)) 'verify-qprivs-resident-refuses-extra'
Yes (Test-TokenRecord '{"contract":"clued.independent-ci.service-token-privileges/1","pid":4,"privileges":["SeChangeNotifyPrivilege"]}' $ResidentPrivileges) 'token-minimal'
Yes (-not (Test-TokenRecord '{"contract":"clued.independent-ci.service-token-privileges/1","pid":4,"privileges":["SeChangeNotifyPrivilege","SeImpersonatePrivilege"]}' $ResidentPrivileges)) 'token-impersonate-refused'
Yes (-not (Test-TokenRecord '{"contract":"x","privileges":["SeChangeNotifyPrivilege"]}' $ResidentPrivileges)) 'token-contract'
Yes (-not (Test-TokenRecord 'not json' $ResidentPrivileges)) 'token-garbage'
$root = 'C:\ProgramData\CluedIndependentCI\resident'; $sha = 'a' * 64
$qc = "SERVICE_NAME: CluedCISwapBroker`r`n        BINARY_PATH_NAME   : `"C:\ProgramData\CluedIndependentCI\resident\bin\SwapBroker.exe`" `"C:\ProgramData\CluedIndependentCI\resident`" $sha`r`n        SERVICE_START_NAME : LocalSystem`r`n"
Yes (Test-BrokerBinaryPath $qc $root $sha) 'broker-binpath'
Yes (-not (Test-BrokerBinaryPath $qc $root ('b' * 64))) 'broker-binpath-config-pin'
Yes (-not (Test-BrokerBinaryPath ($qc.Replace('SwapBroker.exe', 'Other.exe')) $root $sha)) 'broker-binpath-exe'
Yes (Test-ScSddl " D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)`r`n" 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)') 'sddl-exact'
Yes (-not (Test-ScSddl 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;RPWP;;;IU)' 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)')) 'sddl-extra-ace'
Yes (-not (Test-ScSddl 'D:x' $null)) 'sddl-no-receipt-value'

# 5. C#: the broker's bounded read and both token checks (compiled into the scratch directory).
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'; $csc = Join-Path $fw 'csc.exe'
$v2 = [IO.Path]::GetFullPath((Join-Path $here '..\..\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows'))
$refs = @("/reference:$($fw)System.dll", "/reference:$($fw)System.Core.dll", "/reference:$($fw)System.ServiceProcess.dll", "/reference:$($fw)System.Web.Extensions.dll")
& $csc /nologo /noconfig /target:exe /main:BrokerPureTests $refs ('/out:' + (Join-Path $Scratch 'broker-pure.exe')) (Join-Path $here 'SwapBroker.cs') (Join-Path $here 'ResidentServiceHost.cs') (Join-Path $here 'BrokerPureTests.cs') (Join-Path $v2 'ResidentScmV2.cs') (Join-Path $v2 'ScmPidHandshakeV2.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-broker-pure'
# exactly the install-time compile lines (install-resident.ps1 step service-hosts)
& $csc /nologo /noconfig /target:exe /optimize+ ('/out:' + (Join-Path $Scratch 'ResidentServiceHost.exe')) "/reference:$($fw)System.dll" "/reference:$($fw)System.ServiceProcess.dll" (Join-Path $here 'ResidentServiceHost.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-resident-host'
& $csc /nologo /noconfig /target:exe /optimize+ ('/out:' + (Join-Path $Scratch 'SwapBroker.exe')) $refs (Join-Path $here 'SwapBroker.cs') (Join-Path $v2 'ResidentScmV2.cs') (Join-Path $v2 'ScmPidHandshakeV2.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-broker'
$out = & (Join-Path $Scratch 'broker-pure.exe') | Out-String
Yes ($LASTEXITCODE -eq 0 -and $out -match 'BROKER_PURE_PASS') ('broker-pure:' + $out.Trim())
$csharp = [int](($out | ConvertFrom-Json).assertions)
[ordered]@{ status = 'RESIDENT_WINDOWS_OFFLINE_PASS'; assertions = $n; csharpAssertions = $csharp; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
