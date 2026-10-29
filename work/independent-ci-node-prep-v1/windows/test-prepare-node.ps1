# Offline tests for prepare-node.ps1. Touches nothing outside a temporary fixture directory under TEMP: no account, service,
# registration or real ProgramData path is used (the fixture stubs those effects). Run: powershell -File test-prepare-node.ps1
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Root = Split-Path -Parent $Here
$Repo = Split-Path -Parent (Split-Path -Parent $Root)
$Tool = Join-Path $Here 'prepare-node.ps1'
. $Tool -DefinitionsOnly

$script:Pass = 0; $script:Fail = New-Object System.Collections.ArrayList
function Ok([bool]$c, [string]$name) { if ($c) { $script:Pass++ } else { [void]$script:Fail.Add($name) } }
function Code([scriptblock]$b) { try { & $b; 'NO_ERROR' } catch { [string]$_.Exception.Message } }
function Bytes([string]$t) { (New-Object Text.UTF8Encoding($false)).GetBytes($t) }
function ProfileText([string]$name) { [IO.File]::ReadAllText((Join-Path $Root "config\node-prep.$name.json")) }
function LoadProfile([string]$name) { ConvertFrom-PrepProfile ([IO.File]::ReadAllBytes((Join-Path $Root "config\node-prep.$name.json"))) }
function LoadFacts([string]$name) { [IO.File]::ReadAllText((Join-Path $Root "test\fixtures\facts.$name.json")) | ConvertFrom-Json }
function Mutate([string]$json, [scriptblock]$edit) { $o = $json | ConvertFrom-Json; & $edit $o; $o | ConvertTo-Json -Depth 8 }
$PkgSha = '1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc'
$Meta = @{ toolSha256 = ('a' * 64); profileSha256 = ('b' * 64); package = [ordered]@{ sha256 = $PkgSha; bytes = 103528051; entries = 275 } }
function PlanOf($p, $f, $m = $Meta) { Get-NodePrepPlan $p $f $m }
$Turing = LoadProfile 'turing'; $Desk = LoadProfile 'desk-w-591'
$TuringFactsJson = [IO.File]::ReadAllText((Join-Path $Root 'test\fixtures\facts.turing.json'))
$DeskFactsJson = [IO.File]::ReadAllText((Join-Path $Root 'test\fixtures\facts.desk-w-591.json'))
$Ctrl = 'S-1-5-21-1173730660-3877291096-655431861-1015'

# ---- 1. Profiles ----
Ok ($Turing.hostname -ceq 'TURING' -and $Desk.hostname -ceq 'DESK-W-591') 'profiles parse'
Ok ((Get-RunnerName $Desk) -ceq 'clued-ci-company-win-02') 'runner name from runnerService'
# The TURING prep profile carries exactly the values of the resident's node-profile.turing.json.
$np = [IO.File]::ReadAllText((Join-Path $Repo 'work\independent-ci-resident-v1\config\node-profile.turing.json')) | ConvertFrom-Json
$derived = Get-DerivedNodeProfile $Turing $Turing.controllerSid
Ok (@($NodeProfileKeys | Where-Object { [string]$derived[$_] -cne [string]$np.$_ }).Count -eq 0) 'TURING derived node profile equals node-profile.turing.json'
Ok ((Sha256Text (ConvertTo-CanonicalJson $derived)) -ceq '4d006ddc5b8cb0a112f67ddf4c07f96ddb5c39623e3eb11617c076708acd9be6') 'derived digest equals src/node-profile.mjs nodeProfileSha256 (pinned)'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $js = "import('file:///' + process.argv[1].replace(/\\/g,'/')).then(m=>{const fs=require('fs');process.stdout.write(m.nodeProfileSha256(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))))})"
  $live = & $node.Source -e $js (Join-Path $Repo 'work\independent-ci-resident-v1\src\node-profile.mjs') (Join-Path $Repo 'work\independent-ci-resident-v1\config\node-profile.turing.json')
  Ok ($live -ceq '4d006ddc5b8cb0a112f67ddf4c07f96ddb5c39623e3eb11617c076708acd9be6') 'node digest of node-profile.turing.json unchanged'
}
Ok ($null -eq (Get-DerivedNodeProfile $Desk $null)) 'DESK derived profile waits for the controller SID'
$dd = Get-DerivedNodeProfile ($Desk | Select-Object *) 'S-1-5-21-858977881-4031698862-3006450925-1001'
Ok ($null -eq $dd) 'DESK derived profile waits for the WSL distribution'
$deskJson = ProfileText 'desk-w-591'
$rej = @(
  @{ n = 'missing key'; e = { param($o) $o.PSObject.Properties.Remove('wslDistribution') }; c = 'NODE_PREP_PROFILE_FIELDS_REQUIRED' }
  @{ n = 'extra key'; e = { param($o) $o | Add-Member -NotePropertyName mutationMutex -NotePropertyValue 'x' }; c = 'NODE_PREP_PROFILE_FIELDS_REQUIRED' }
  @{ n = 'contract'; e = { param($o) $o.contract = 'clued.independent-ci.node-profile/1' }; c = 'NODE_PREP_PROFILE_CONTRACT_REFUSED' }
  @{ n = 'hostname lower'; e = { param($o) $o.hostname = 'desk-w-591' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'nodeName upper'; e = { param($o) $o.nodeName = 'DESK' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'owner sid'; e = { param($o) $o.ownerSid = 'S-1-5-18' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'profile dir'; e = { param($o) $o.ownerProfileDirectory = 'D:\Users\Windows' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'runner service other repo'; e = { param($o) $o.runnerService = 'actions.runner.other-repo.clued-ci-x' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'runner service no clued-ci'; e = { param($o) $o.runnerService = 'actions.runner.tdoljyj-cross-memory-system.company-win-02' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'controller = owner'; e = { param($o) $o.controllerSid = $o.ownerSid }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'controller rid < 1000'; e = { param($o) $o.controllerSid = 'S-1-5-21-858977881-4031698862-3006450925-500' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'controller number'; e = { param($o) $o.controllerSid = 1015 }; c = 'NODE_PREP_PROFILE_FIELDS_REQUIRED' }
  @{ n = 'wsl bad'; e = { param($o) $o.wslDistribution = 'bad name' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'version'; e = { param($o) $o.runnerPackage.version = 'latest' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'fileName mismatch'; e = { param($o) $o.runnerPackage.fileName = 'actions-runner-win-x64-2.338.2.zip' }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'sha upper'; e = { param($o) $o.runnerPackage.sha256 = $o.runnerPackage.sha256.ToUpperInvariant() }; c = 'NODE_PREP_PROFILE_INVALID' }
  @{ n = 'package extra key'; e = { param($o) $o.runnerPackage | Add-Member -NotePropertyName url -NotePropertyValue 'x' }; c = 'NODE_PREP_PROFILE_FIELDS_REQUIRED' }
)
foreach ($r in $rej) { $j = Mutate $deskJson $r.e; Ok ((Code { ConvertFrom-PrepProfile (Bytes $j) }) -ceq $r.c) ('profile rejects ' + $r.n) }
Ok ((Code { ConvertFrom-PrepProfile ([byte[]](@(0xEF, 0xBB, 0xBF) + (Bytes $deskJson))) }) -ceq 'NODE_PREP_PROFILE_REFUSED') 'profile rejects BOM'
Ok ((Code { ConvertFrom-PrepProfile (Bytes 'not json') }) -ceq 'NODE_PREP_PROFILE_REFUSED') 'profile rejects non-JSON'
Ok ((Code { ConvertFrom-PrepProfile (Bytes '[1]') }) -ceq 'NODE_PREP_PROFILE_REFUSED') 'profile rejects array'

# ---- 2. DESK-W-591 plan (fresh node) ----
$df = LoadFacts 'desk-w-591'
$plan = PlanOf $Desk $df
$ids = @($plan.steps | ForEach-Object { $_.id })
Ok ($plan.status -ceq 'PLAN' -and @($plan.steps | Where-Object { $_.skip }).Count -eq 0) 'DESK: every step to do'
Ok ($ids[0] -ceq 'account' -and $plan.steps[0].kind -ceq 'account-create' -and @($plan.steps[0].groups).Count -eq 0 -and $plan.steps[0].description -ceq 'Dedicated trusted-main CI control') 'DESK: account first, no groups'
Ok (($ids -join ',') -ceq ('account,' + ((@(Get-DirectoryModel)[0..5] | ForEach-Object { 'dir:' + $_.path }) -join ',') + ',runner-extract,runner-package-copy,runner-register,runner-service-file,service,' + ((@(Get-DirectoryModel)[6..11] | ForEach-Object { 'dir:' + $_.path }) -join ','))) 'DESK: step order'
Ok (@($plan.steps | Where-Object { $_.kind -ceq 'directory' -and $_.sddl -cnotmatch '\{CTRL\}' }).Count -eq 0) 'DESK: every directory grants the controller (bound at apply)'
$reg = @($plan.steps | Where-Object { $_.id -ceq 'runner-register' })[0]
Ok ($reg.name -ceq 'clued-ci-company-win-02' -and ($reg.labels -join ',') -ceq 'self-hosted,Windows,X64,clued-controller-windows-v1' -and $reg.disableUpdate -and -not $reg.asService -and $reg.tokenFromOwnerPrompt -and $reg.url -ceq 'https://github.com/tdoljyj/cross-memory-system') 'DESK: registration (controller labels, no service, Owner token)'
$route = [IO.File]::ReadAllText((Join-Path $Repo 'scripts\ci\clued-control-workflow-source.mjs'))
Ok ($route.Contains("MAIN_SECRET_CONTROLLER_ROUTE=freeze(['self-hosted','Windows','X64','clued-controller-windows-v1'])")) 'controller labels equal the workflow route'
$svc = @($plan.steps | Where-Object { $_.id -ceq 'service' })[0]
Ok ($svc.kind -ceq 'service-create' -and $svc.binary -ceq '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"' -and $svc.account -ceq '.\clued-control' -and $svc.startMode -ceq 'Manual' -and -not $svc.started) 'DESK: service Stopped/Manual on original binary'
$lay = [IO.File]::ReadAllText((Join-Path $Repo 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\layout.mjs'))
Ok ($lay.Contains("ORIGINAL_BINARY = '`"C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe`"'")) 'original binary equals resident-v2 layout'
Ok (@($plan.untouchedServices).Count -eq 1 -and $plan.untouchedServices[0].name -ceq 'actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-01' -and $plan.untouchedServices[0].account -ceq '.\clued-runner') 'DESK: existing general runner listed as untouched'
Ok ($null -eq $plan.controllerSid -and $null -eq $plan.derivedNodeProfile) 'DESK: no controller SID before the account exists'
$noPkg = @{ toolSha256 = $Meta.toolSha256; profileSha256 = $Meta.profileSha256; package = $null }
Ok ((Code { PlanOf $Desk $df $noPkg }) -ceq 'RUNNER_PACKAGE_REQUIRED') 'DESK: package required for a fresh runner'
$h1 = Get-PlanSha256 (PlanOf $Desk $df); $h2 = Get-PlanSha256 (PlanOf $Desk (LoadFacts 'desk-w-591'))
Ok ($h1 -ceq $h2 -and $h1 -cmatch '^[0-9a-f]{64}$') 'plan hash deterministic'
$m2 = @{ toolSha256 = ('c' * 64); profileSha256 = $Meta.profileSha256; package = $Meta.package }
Ok ((Get-PlanSha256 (PlanOf $Desk $df $m2)) -cne $h1) 'plan hash binds the tool bytes'
$m3 = @{ toolSha256 = $Meta.toolSha256; profileSha256 = ('d' * 64); package = $Meta.package }
Ok ((Get-PlanSha256 (PlanOf $Desk $df $m3)) -cne $h1) 'plan hash binds the profile bytes'
$f2 = Mutate $DeskFactsJson { param($o) $o.services[0].binary = '"C:\clued-ci\other\bin\RunnerService.exe"' } | ConvertFrom-Json
Ok ((Get-PlanSha256 (PlanOf $Desk $f2)) -cne $h1) 'plan hash binds the untouched runners'
$f3 = Mutate $DeskFactsJson { param($o) $o.services[0].state = 'Stopped' } | ConvertFrom-Json
Ok ((Get-PlanSha256 (PlanOf $Desk $f3)) -ceq $h1) 'an untouched runner going idle does not change the plan'

# ---- 3. TURING (everything present) ----
$tf = LoadFacts 'turing'
$tp = PlanOf $Turing $tf $noPkg
Ok ($tp.status -ceq 'NOTHING_TO_DO' -and @($tp.steps | Where-Object { -not $_.skip }).Count -eq 0) 'TURING recorded tree: nothing to do, no package needed'
Ok ($tp.controllerSid -ceq $Ctrl -and $tp.derivedNodeProfileSha256 -ceq '4d006ddc5b8cb0a112f67ddf4c07f96ddb5c39623e3eb11617c076708acd9be6') 'TURING: derived node profile digest'
Ok (@($tp.untouchedServices).Count -eq 1 -and $tp.untouchedServices[0].name -cmatch 'home-win-01$') 'TURING: general runner untouched, controller recognised'
$tu = Mutate $TuringFactsJson { param($o) $o.runnerRoot = 'unexpected:changed:bin\Runner.Worker.dll' } | ConvertFrom-Json
Ok ((Code { PlanOf $Turing $tu $noPkg }) -ceq 'RUNNER_ROOT_UNEXPECTED:changed:bin\Runner.Worker.dll') 'TURING with a changed runner tree: refused, names the file'
$tp2 = Mutate $TuringFactsJson { param($o) $o.paths.'C:\ProgramData\CluedIndependentCI\state\temp' = [pscustomobject]@{ exists = $false; kind = 'absent'; sddl = $null } } | ConvertFrom-Json
$p2 = PlanOf $Turing $tp2 $noPkg
Ok ($p2.status -ceq 'PLAN' -and (@($p2.steps | Where-Object { -not $_.skip } | ForEach-Object { $_.id }) -join ',') -ceq 'dir:C:\ProgramData\CluedIndependentCI\state\temp' -and
  @($p2.steps | Where-Object { -not $_.skip })[0].sddl -ceq ('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $Ctrl + ')')) 'TURING missing one folder: only that folder, SID bound'

# ---- 4. Refusals ----
$cases = @(
  @{ n = 'other host'; j = $DeskFactsJson; e = { param($o) $o.hostname = 'DESK-W-592' }; c = 'NODE_HOST_REQUIRED' }
  @{ n = 'other user'; j = $DeskFactsJson; e = { param($o) $o.currentUserSid = 'S-1-5-21-858977881-4031698862-3006450925-1002' }; c = 'OWNER_ACCOUNT_REQUIRED' }
  @{ n = 'profile dir'; j = $DeskFactsJson; e = { param($o) $o.userProfile = 'C:\Users\Other' }; c = 'OWNER_PROFILE_DIRECTORY_MISMATCH' }
  @{ n = 'ProgramData link'; j = $DeskFactsJson; e = { param($o) $o.paths.'C:\ProgramData'.kind = 'reparse' }; c = 'PROGRAMDATA_REFUSED' }
  @{ n = 'facts incomplete'; j = $DeskFactsJson; e = { param($o) $o.paths.PSObject.Properties.Remove('C:\ProgramData\CluedIndependentCI\state') }; c = 'HOST_FACTS_INCOMPLETE' }
  @{ n = 'unreadable folder'; j = $DeskFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedControl'.kind = 'unreadable'; $o.paths.'C:\ProgramData\CluedControl'.exists = $true }; c = 'ELEVATED_DRY_RUN_REQUIRED' }
  @{ n = 'unreadable runner root'; j = $DeskFactsJson; e = { param($o) $o.runnerRoot = 'unreadable' }; c = 'ELEVATED_DRY_RUN_REQUIRED' }
  @{ n = 'folder before account'; j = $DeskFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedIndependentCI' = [pscustomobject]@{ exists = $true; kind = 'directory'; sddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' } }; c = 'DIRECTORY_EXISTS_BEFORE_ACCOUNT:C:\ProgramData\CluedIndependentCI' }
  @{ n = 'target is a file'; j = $DeskFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedControl'.kind = 'file'; $o.paths.'C:\ProgramData\CluedControl'.exists = $true }; c = 'DIRECTORY_TARGET_REFUSED:C:\ProgramData\CluedControl' }
  @{ n = 'target is a link'; j = $DeskFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedControl\runner'.kind = 'reparse'; $o.paths.'C:\ProgramData\CluedControl\runner'.exists = $true }; c = 'DIRECTORY_TARGET_REFUSED:C:\ProgramData\CluedControl\runner' }
  @{ n = 'foreign runner in control root'; j = $DeskFactsJson; e = { param($o) $o.services[0].binary = '"C:\ProgramData\CluedControl\other\bin\RunnerService.exe"' }; c = 'FOREIGN_RUNNER_SERVICE_IN_CONTROL_ROOT' }
  @{ n = 'service without account'; j = $DeskFactsJson; e = { param($o) $o.services += [pscustomobject]@{ name = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-02'; binary = '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"'; account = '.\clued-control'; startMode = 'Manual'; state = 'Stopped'; displayName = 'Clued dedicated trusted-main controller' } }; c = 'RUNNER_SERVICE_WITHOUT_ACCOUNT' }
  @{ n = 'runner root changed'; j = $DeskFactsJson; e = { param($o) $o.runnerRoot = 'unexpected:extra:bin\x.dll' }; c = 'RUNNER_ROOT_UNEXPECTED:extra:bin\x.dll' }
  @{ n = 'package copy exists'; j = $DeskFactsJson; e = { param($o) $o.packageCopyKind = 'file'; $o.packageCopySha256 = ('0' * 64) }; c = 'RUNNER_PACKAGE_COPY_EXISTS_DIFFERENT' }
  @{ n = 'package copy is a folder'; j = $DeskFactsJson; e = { param($o) $o.packageCopyKind = 'directory' }; c = 'RUNNER_PACKAGE_COPY_REFUSED' }
  @{ n = 'service file differs'; j = $DeskFactsJson; e = { param($o) $o.serviceFile = 'actions.runner.x' }; c = 'RUNNER_SERVICE_FILE_EXISTS_DIFFERENT' }
  @{ n = 'registered before account'; j = $DeskFactsJson; e = { param($o) $o.runnerRoot = 'registered' }; c = 'RUNNER_REGISTERED_BEFORE_ACCOUNT' }
  @{ n = 'TURING sid mismatch'; j = $TuringFactsJson; e = { param($o) $o.account.sid = 'S-1-5-21-1173730660-3877291096-655431861-1016' }; c = 'CONTROLLER_SID_MISMATCH'; p = 'turing' }
  @{ n = 'account in a group'; j = $TuringFactsJson; e = { param($o) $o.account.groups = @('Users') }; c = 'CONTROLLER_ACCOUNT_EXISTS_DIFFERENT'; p = 'turing' }
  @{ n = 'account description'; j = $TuringFactsJson; e = { param($o) $o.account.description = 'x' }; c = 'CONTROLLER_ACCOUNT_EXISTS_DIFFERENT'; p = 'turing' }
  @{ n = 'account disabled'; j = $TuringFactsJson; e = { param($o) $o.account.enabled = $false }; c = 'CONTROLLER_ACCOUNT_EXISTS_DIFFERENT'; p = 'turing' }
  @{ n = 'account may change password'; j = $TuringFactsJson; e = { param($o) $o.account.userMayChangePassword = $true }; c = 'CONTROLLER_ACCOUNT_EXISTS_DIFFERENT'; p = 'turing' }
  @{ n = 'account is the owner'; j = $TuringFactsJson; e = { param($o) $o.account.sid = 'S-1-5-21-1173730660-3877291096-655431861-1001' }; c = 'CONTROLLER_ACCOUNT_REFUSED'; p = 'turing' }
  @{ n = 'service swapped to helper'; j = $TuringFactsJson; e = { param($o) $o.services[1].binary = '"C:\ProgramData\CluedIndependentCI\resident\helpers\controller-formal-generic-v2.exe"' }; c = 'RUNNER_SERVICE_EXISTS_DIFFERENT'; p = 'turing' }
  @{ n = 'service running'; j = $TuringFactsJson; e = { param($o) $o.services[1].state = 'Running' }; c = 'RUNNER_SERVICE_EXISTS_DIFFERENT'; p = 'turing' }
  @{ n = 'service automatic'; j = $TuringFactsJson; e = { param($o) $o.services[1].startMode = 'Auto' }; c = 'RUNNER_SERVICE_EXISTS_DIFFERENT'; p = 'turing' }
  @{ n = 'service other account'; j = $TuringFactsJson; e = { param($o) $o.services[1].account = '.\clued-runner' }; c = 'RUNNER_SERVICE_EXISTS_DIFFERENT'; p = 'turing' }
  @{ n = 'account used, service missing'; j = $TuringFactsJson; e = { param($o) $o.services = @($o.services[0]) }; c = 'CONTROLLER_ACCOUNT_IN_USE_WITHOUT_SERVICE'; p = 'turing' }
  @{ n = 'folder grants Users'; j = $TuringFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedControl\trusted'.sddl += '(A;OICI;0x1200a9;;;BU)' }; c = 'DIRECTORY_EXISTS_DIFFERENT:C:\ProgramData\CluedControl\trusted:extra-ace'; p = 'turing' }
  @{ n = 'folder lacks controller'; j = $TuringFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedIndependentCI\state\temp'.sddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' }; c = 'DIRECTORY_EXISTS_DIFFERENT:C:\ProgramData\CluedIndependentCI\state\temp:missing-ace'; p = 'turing' }
  @{ n = 'folder owned by a user'; j = $TuringFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedControl'.sddl = 'O:S-1-5-21-1173730660-3877291096-655431861-1001D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;S-1-5-21-1173730660-3877291096-655431861-1015)' }; c = 'DIRECTORY_EXISTS_DIFFERENT:C:\ProgramData\CluedControl:owner-refused'; p = 'turing' }
  @{ n = 'controller writes CluedControl'; j = $TuringFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedControl'.sddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;S-1-5-21-1173730660-3877291096-655431861-1015)' }; c = 'DIRECTORY_EXISTS_DIFFERENT:C:\ProgramData\CluedControl:missing-ace'; p = 'turing' }
  @{ n = 'resident ACE wider than install-resident'; j = $TuringFactsJson; e = { param($o) $o.paths.'C:\ProgramData\CluedIndependentCI'.sddl += '(A;OICI;0x1301bf;;;S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629)' }; c = 'DIRECTORY_EXISTS_DIFFERENT:C:\ProgramData\CluedIndependentCI:extra-ace'; p = 'turing' }
)
foreach ($c in $cases) {
  $prof = if ($c.ContainsKey('p')) { $Turing } else { $Desk }
  $m = if ($c.ContainsKey('p')) { $noPkg } else { $Meta }
  $f = Mutate $c.j $c.e | ConvertFrom-Json
  $got = Code { PlanOf $prof $f $m }
  Ok ($got -ceq $c.c) ('refuses ' + $c.n + ' (got ' + $got + ')')
}
# The profile names a controller that is not there.
$dp = Mutate $deskJson { param($o) $o.controllerSid = 'S-1-5-21-858977881-4031698862-3006450925-1001' }
Ok ((Code { PlanOf (ConvertFrom-PrepProfile (Bytes $dp)) $df }) -ceq 'CONTROLLER_ACCOUNT_MISSING') 'refuses a profile controller that does not exist'
# An earlier apply stopped after creating the account: the account never logged on, so the plan resets its password and continues.
$partial = Mutate $DeskFactsJson { param($o)
  $o.account = [pscustomobject]@{ sid = 'S-1-5-21-858977881-4031698862-3006450925-1001'; enabled = $true; description = 'Dedicated trusted-main CI control'; fullName = ''; passwordNeverExpires = $true; userMayChangePassword = $false; groups = @(); neverLoggedOn = $true } } | ConvertFrom-Json
$pp = PlanOf $Desk $partial
Ok ($pp.steps[0].kind -ceq 'account-password-reset' -and -not $pp.steps[0].skip -and $pp.controllerSid -ceq 'S-1-5-21-858977881-4031698862-3006450925-1001' -and
  @($pp.steps | Where-Object { $_.kind -ceq 'directory' -and $_.sddl -cmatch '\{CTRL\}' }).Count -eq 0) 'partial earlier apply: password reset, SID bound everywhere'

# ---- 5. ACL comparison ----
Ok ((Compare-DirectoryAcl 'O:BAD:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;S-1-5-21-1-2-3-1015)' 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;S-1-5-21-1-2-3-1015)' @()) -ceq 'same') 'inherited equals explicit'
Ok ((Compare-DirectoryAcl 'O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x120080;;;S-1-5-21-1-2-3-1001)(A;OICI;0x1200a9;;;S-1-5-21-1-2-3-1015)(A;;0x1200a5;;;S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629)' 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x120080;;;S-1-5-21-1-2-3-1001)(A;OICI;0x1200a9;;;S-1-5-21-1-2-3-1015)' @('(A;;0x1200a5;;;{RES})' | ForEach-Object { Resolve-Sddl $_ 'x' 'y' })) -ceq 'same') 'the planned resident ACE is accepted'
Ok ((Compare-DirectoryAcl 'O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(D;;FA;;;WD)' 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' @()) -ceq 'extra-ace') 'a deny entry is not ignored'

# ---- 6. The planned trees pass the runtime's secret ACL rule (verify-resident.ps1 Test-SecretAclChain, extracted unchanged) ----
$vr = [IO.File]::ReadAllText((Join-Path $Repo 'work\independent-ci-resident-v1\windows\verify-resident.ps1'))
$tok = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseInput($vr, [ref]$tok, [ref]$er)
foreach ($fn in @('Test-SecretAclChain')) { . ([scriptblock]::Create((@($ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq $fn }, $true))[0].Extent.Text))) }
$SecretAdmins = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function AclOf([string]$sddl) { $a = New-Object Security.AccessControl.DirectorySecurity; $a.SetSecurityDescriptorSddlForm($sddl); $a }
$driveRoot = 'O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464G:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464D:PAI(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'
$pdata = $df.paths.'C:\ProgramData'.sddl
$model = @(Get-DirectoryModel)
$cc = Resolve-Sddl $model[0].sddl $Ctrl 'S-1-5-21-1-2-3-1001'; $tr = Resolve-Sddl $model[1].sddl $Ctrl 'S-1-5-21-1-2-3-1001'
$keyChain = @(@{ acl = (AclOf $driveRoot); protected = $false; secret = $false }, @{ acl = (AclOf $pdata); protected = $false; secret = $false }, @{ acl = (AclOf $cc); protected = $true; secret = $false }, @{ acl = (AclOf $tr); protected = $true; secret = $true })
Ok ((Test-SecretAclChain $keyChain $Ctrl) -ceq 'ok') 'App key chain (C:\ -> ProgramData -> CluedControl -> trusted) passes the runtime rule'
$ci = Resolve-Sddl $model[6].sddl $Ctrl 'S-1-5-21-1-2-3-1001'
$secretsDir = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $Ctrl + ')'   # install-resident.ps1 Get-SecretDirectorySddl
$tokChain = @(@{ acl = (AclOf $driveRoot); protected = $false; secret = $false }, @{ acl = (AclOf $pdata); protected = $false; secret = $false }, @{ acl = (AclOf $ci); protected = $true; secret = $false }, @{ acl = (AclOf $secretsDir); protected = $true; secret = $true })
Ok ((Test-SecretAclChain $tokChain $Ctrl) -ceq 'ok') 'ci-admission token chain (CluedIndependentCI -> secrets) passes the runtime rule'
$bad = @(@{ acl = (AclOf $driveRoot); protected = $false; secret = $false }, @{ acl = (AclOf $pdata); protected = $false; secret = $false }, @{ acl = (AclOf (Resolve-Sddl $model[2].sddl $Ctrl 'x')); protected = $true; secret = $false }, @{ acl = (AclOf $tr); protected = $true; secret = $true })
Ok ((Test-SecretAclChain $bad $Ctrl) -ceq 'writable-ancestor') 'control: a controller-writable parent is refused by the same rule'
# migrate-acl.ps1 appends to the spool and creates state\v2*: the spool folders must be protected and carry no resident ACE yet.
foreach ($i in 7, 8, 9) { $raw = New-Object Security.AccessControl.RawSecurityDescriptor((Resolve-Sddl $model[$i].sddl $Ctrl 'S-1-5-21-1-2-3-1001')); Ok ((($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) -and (Resolve-Sddl $model[$i].sddl $Ctrl 'x') -notmatch 'S-1-5-80-') ('migrate-acl target protected, no resident ACE: ' + $model[$i].path) }
$am = [IO.File]::ReadAllText((Join-Path $Repo 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\acl-model.json')) | ConvertFrom-Json
Ok (@($am.add | Where-Object { @($model.path) -cnotcontains $_.path }).Count -eq 0) 'every migrate-acl add target is prepared here'
Ok (@($am.create | Where-Object { @($model.path) -ccontains $_.path }).Count -eq 0) 'nothing migrate-acl creates is created here'

# ---- 7. Static guarantees of the tool text ----
$text = [IO.File]::ReadAllText($Tool)
foreach ($w in @('Remove-Item', 'Remove-LocalUser', 'Set-Acl', 'icacls', 'SetAccessControl', 'sc.exe delete', 'DeleteService', 'Start-Service', 'StartService', '--runasservice', ' remove ', 'Delete(', 'Move-Item', 'Rename-Item', 'net.exe', 'Add-LocalGroupMember', 'secedit')) { Ok (-not $text.Contains($w)) ('tool never uses ' + $w) }
Ok ([regex]::Matches($text, 'FileMode\]::CreateNew').Count -eq 2 -and -not $text.Contains('FileMode]::Create)') -and -not $text.Contains('WriteAllBytes') -and -not $text.Contains('WriteAllText')) 'files only CreateNew'
$wslStart = $text.IndexOf('function Get-WslObservations'); $wslEnd = $text.IndexOf('if ($DefinitionsOnly)')
Ok (@([regex]::Matches($text, '& wsl\.exe') | Where-Object { $_.Index -lt $wslStart -or $_.Index -gt $wslEnd }).Count -eq 0 -and [regex]::Matches($text, '& wsl\.exe').Count -eq 2) 'wsl.exe only inside Get-WslObservations'
Ok ($text -match "if \(Test-Elevated\) \{ return \[ordered\]@\{ probed = \`$false") 'the elevated run never enters a distribution'
Ok ($text.Contains("Read-Host -AsSecureString") -and -not ($text -match 'Write-(Host|Output)[^\r\n]*\$token\b') -and $text.Contains("Replace(`$token, '<token>')")) 'token only typed, never printed'

# ---- 8. End-to-end in a fixture (dry run, apply, refusals) ----
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('nodeprep-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $tmp | Out-Null
try {
  # A tiny stand-in package and a profile pinned to it.
  Add-Type -AssemblyName System.IO.Compression
  $zipPath = Join-Path $tmp 'actions-runner-win-x64-9.9.9.zip'
  $ms = New-Object IO.MemoryStream; $za = New-Object IO.Compression.ZipArchive($ms, [IO.Compression.ZipArchiveMode]::Create, $true)
  foreach ($e in @('bin/RunnerService.exe', 'bin/Runner.Listener.exe', 'externals/node20/bin/node.exe', 'config.cmd', 'run.cmd')) { $w = New-Object IO.StreamWriter($za.CreateEntry($e).Open()); $w.Write('fixture ' + $e); $w.Dispose() }
  $za.Dispose(); [IO.File]::WriteAllBytes($zipPath, $ms.ToArray())
  $zsha = Sha256Bytes ([IO.File]::ReadAllBytes($zipPath))
  $profPath = Join-Path $tmp 'node-prep.fixture.json'
  [IO.File]::WriteAllText($profPath, (Mutate $deskJson { param($o) $o.runnerPackage.version = '9.9.9'; $o.runnerPackage.fileName = 'actions-runner-win-x64-9.9.9.zip'; $o.runnerPackage.sha256 = $zsha }), (New-Object Text.UTF8Encoding($false)))
  $factsPath = Join-Path (Join-Path $Root 'test\fixtures') 'facts.desk-w-591.json'
  $ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  function Run([string[]]$a) { $o = & $ps -NoProfile -ExecutionPolicy Bypass -File $Tool @a 2>&1 | Out-String; $j = $o.Substring(0, $o.LastIndexOf('}') + 1) | ConvertFrom-Json; @{ code = $LASTEXITCODE; out = $j; text = $o } }
  $dry = Run @('-ProfilePath', $profPath, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath)
  Ok ($dry.code -eq 0 -and $dry.out.status -ceq 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN' -and $dry.text -match "PLAN_SHA256=$($dry.out.planSha256)") 'fixture dry run prints the plan hash'
  Ok ($dry.out.plan.package.sha256 -ceq $zsha -and $dry.out.plan.package.entries -eq 5) 'fixture plan binds the package'
  $fx1 = Join-Path $tmp 'pd1'; New-Item -ItemType Directory $fx1 | Out-Null
  $wrong = Run @('-ProfilePath', $profPath, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath, '-OfflineFixtureRoot', $fx1, '-Apply', '-ExpectedPlanSha256', ('0' * 64))
  Ok ($wrong.code -eq 2 -and $wrong.out.code -ceq 'PLAN_CHANGED_SINCE_REVIEW' -and @(Get-ChildItem $fx1 -Force).Count -eq 0) 'a different plan hash writes nothing'
  $noHash = Run @('-ProfilePath', $profPath, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath, '-OfflineFixtureRoot', $fx1, '-Apply')
  Ok ($noHash.out.code -ceq 'EXPECTED_PLAN_SHA256_REQUIRED' -and @(Get-ChildItem $fx1 -Force).Count -eq 0) 'apply without a plan hash writes nothing'
  $badZip = Join-Path $tmp 'other.zip'; [IO.File]::WriteAllBytes($badZip, [byte[]](1, 2, 3))
  $bz = Run @('-ProfilePath', $profPath, '-RunnerPackageZip', $badZip, '-OfflineHostFacts', $factsPath)
  Ok ($bz.out.code -ceq 'RUNNER_PACKAGE_SHA256_MISMATCH') 'a package with another hash is refused'
  $live = Run @('-ProfilePath', $profPath, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath, '-Apply', '-ExpectedPlanSha256', $dry.out.planSha256)
  Ok ($live.out.code -ceq 'OFFLINE_FACTS_APPLY_REFUSED') 'offline facts never apply to the real host'
  $outside = Run @('-ProfilePath', $profPath, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath, '-OfflineFixtureRoot', 'C:\ProgramData', '-Apply', '-ExpectedPlanSha256', $dry.out.planSha256)
  Ok ($outside.out.code -ceq 'OFFLINE_FIXTURE_OUTSIDE_TEMP_REFUSED') 'a fixture root outside TEMP is refused'
  $ap = Run @('-ProfilePath', $profPath, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath, '-OfflineFixtureRoot', $fx1, '-Apply', '-ExpectedPlanSha256', $dry.out.planSha256)
  Ok ($ap.code -eq 0 -and $ap.out.status -ceq 'NODE_PREPARED_FIXTURE') 'fixture apply completes'
  Ok ((@($ap.out.effects) -join '|') -ceq 'account-create|runner-register:clued-ci-company-win-02:self-hosted,Windows,X64,clued-controller-windows-v1|service-create:actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-02') 'fixture apply: account, registration, service in order'
  $fsid = 'S-1-5-21-1-2-3-1015'
  foreach ($d in $model) {
    $p = $fx1 + $d.path.Substring('C:\ProgramData'.Length)
    $ok = [IO.Directory]::Exists($p)
    if ($ok) { $s = (Get-Acl -LiteralPath $p).Sddl; $raw = New-Object Security.AccessControl.RawSecurityDescriptor($s)
      $ok = (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) -and $s.Contains($fsid) -and -not $s.Contains('{CTRL}') }
    Ok $ok ('fixture folder created, protected, controller bound: ' + $d.path)
  }
  $rr = $fx1 + '\CluedControl\runner'
  Ok ([IO.File]::ReadAllText("$rr\bin\RunnerService.exe") -ceq 'fixture bin/RunnerService.exe' -and [IO.File]::Exists("$rr\externals\node20\bin\node.exe")) 'fixture package extracted'
  $inh = (Get-Acl -LiteralPath "$rr\bin\RunnerService.exe").Sddl
  Ok ($inh.Contains($fsid) -and $inh -match '\(A;ID;0x1200a9;;;' + [regex]::Escape($fsid) + '\)') 'extracted files inherit controller read only'
  Ok ((Sha256Bytes ([IO.File]::ReadAllBytes("$fx1\CluedControl\runner-package.zip"))) -ceq $zsha) 'package copy written'
  Ok ([IO.File]::ReadAllText("$rr\.service") -ceq 'actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-02') '.service names the service'
  Ok ($ap.out.controllerSid -ceq $fsid -and $null -eq $ap.out.derivedNodeProfile) 'receipt: controller SID; node profile waits for WSL'
  # Create-only: the same plan applied again (facts still say absent) refuses at the first existing target.
  $again = Run @('-ProfilePath', $profPath, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath, '-OfflineFixtureRoot', $fx1, '-Apply', '-ExpectedPlanSha256', $dry.out.planSha256)
  Ok ($again.code -eq 2 -and $again.out.code -ceq 'DIRECTORY_APPEARED_SINCE_PLAN:C:\ProgramData\CluedControl') 'second apply refuses, nothing overwritten'
  # A profile with the WSL distribution: the receipt then carries the resident node profile.
  $prof2 = Join-Path $tmp 'node-prep.fixture2.json'
  [IO.File]::WriteAllText($prof2, (Mutate ([IO.File]::ReadAllText($profPath)) { param($o) $o.wslDistribution = 'CluedResident-Linux' }), (New-Object Text.UTF8Encoding($false)))
  $dry2 = Run @('-ProfilePath', $prof2, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath)
  $fx2 = Join-Path $tmp 'pd2'; New-Item -ItemType Directory $fx2 | Out-Null
  $ap2 = Run @('-ProfilePath', $prof2, '-RunnerPackageZip', $zipPath, '-OfflineHostFacts', $factsPath, '-OfflineFixtureRoot', $fx2, '-Apply', '-ExpectedPlanSha256', $dry2.out.planSha256)
  Ok ($ap2.out.derivedNodeProfile.mutationMutex -ceq 'Global\CluedControlControllerMutationV1-DESK-W-591-1015' -and $ap2.out.derivedNodeProfile.controllerSid -ceq $fsid -and $ap2.out.derivedNodeProfileSha256 -cmatch '^[0-9a-f]{64}$') 'receipt: derived node profile with mutex'
  if ($node) {
    $npPath = Join-Path $tmp 'np.json'; [IO.File]::WriteAllText($npPath, ($ap2.out.derivedNodeProfile | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    $d2 = & $node.Source -e $js (Join-Path $Repo 'work\independent-ci-resident-v1\src\node-profile.mjs') $npPath
    Ok ($d2 -ceq $ap2.out.derivedNodeProfileSha256) 'derived DESK node profile passes the resident validator with the same digest'
  }
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force }

# ---- 9. Real package (optional): set NODEPREP_RUNNER_ZIP to the official actions-runner-win-x64-2.337.0.zip ----
if ($env:NODEPREP_RUNNER_ZIP -and (Test-Path -LiteralPath $env:NODEPREP_RUNNER_ZIP)) {
  $zb = [IO.File]::ReadAllBytes($env:NODEPREP_RUNNER_ZIP)
  Ok ((Sha256Bytes $zb) -ceq $Desk.runnerPackage.sha256) 'real package matches the profile pin'
  $en = Get-ZipEntries $zb
  Ok ($en.Count -eq 275 -and $en.Contains('bin\RunnerService.exe') -and $en.Contains('config.cmd')) 'real package entries accepted (275 files)'
}

'{0} passed, {1} failed' -f $script:Pass, $script:Fail.Count
foreach ($f in $script:Fail) { 'FAIL: ' + $f }
if ($script:Fail.Count) { exit 1 } else { exit 0 }
