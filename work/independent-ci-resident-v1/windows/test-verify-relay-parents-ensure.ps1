# verify-resident.ps1's Invoke-CompanionRelayParentsEnsure (the M5-b relay-parent ACE in the generic install and in-place upgrade) and
# Invoke-StateParentEnsure (r13: <CiRoot>\state by the installer's rule state-parent-acl) on
# real NTFS in a new TEMP scratch, NOT elevated: the function itself (with install-resident.ps1's own rule) against temp parents, and
# the verify body's wiring by AST. No production path is read or written; nothing runs as SYSTEM.
param([Parameter(Mandatory)][string]$Scratch)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'WINDOWS_POWERSHELL_5_REQUIRED' }
if ((New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'NON_ELEVATED_TEST_REQUIRED' }
if ([IO.Directory]::Exists($Scratch)) { throw 'NEW_SCRATCH_REQUIRED' }
[void][IO.Directory]::CreateDirectory($Scratch)
$count = 0
function Yes([bool]$ok, [string]$why) { if (-not $ok) { throw ('FAILED:' + $why) }; $script:count++ }
function Refused([scriptblock]$b, [string]$code) { try { & $b | Out-Null; return $false } catch { return $_.Exception.Message.StartsWith($code) } }

$verify = Join-Path $PSScriptRoot 'verify-resident.ps1'
$installer = Join-Path $PSScriptRoot 'install-resident.ps1'
$t = $null; $e = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($verify, [ref]$t, [ref]$e)
if (@($e).Count -ne 0) { throw 'VERIFY_UNPARSEABLE' }
$fn = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-CompanionRelayParentsEnsure' }, $true))
Yes ($fn.Count -eq 1) 'one-ensure-function'
. ([scriptblock]::Create($fn[0].Extent.Text))
# the test's own readers (not the code under test): the installer's helpers
$ia = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$t, [ref]$e)
foreach ($n in @('Get-DaclPart', 'Get-AceKeys', 'Get-RelayParentAclPresence')) { . ([scriptblock]::Create(@($ia.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $n }, $true))[0].Extent.Text)) }

# The wiring: only elevated/SYSTEM ensures, before the unchanged check, and a refusal fails the check.
$body = $ast.EndBlock.Extent.Text
$call = $body.IndexOf('if ($verifyIdentity.User.Value -ceq ''S-1-5-18'') {')
$pinned = $body.IndexOf('Invoke-CompanionRelayParentsEnsure $Root ([string]$Node.ownerSid) (Join-Path $PSScriptRoot ''install-resident.ps1'') ([string]$rulePin[0].sha256)')
$pinRead = $body.IndexOf('Where-Object { [string]$_.path -ceq ''windows/install-resident.ps1'' }')
$genCheck = $body.IndexOf('$residentManifestSha -cne [string]$receipt.residentManifestSha256 -or (Split-Path -Leaf (Split-Path -Parent $PSScriptRoot)) -cne $residentManifestSha')
$check = $body.IndexOf('$parentProblem = Get-CompanionRelayParentsProblem ([string]$Node.ownerSid)')
$record = $body.IndexOf('Record ''companion-relay-parents'' ($null -eq $parentProblem -and $relayAdded -isnot [string])')
Yes ($call -gt 0 -and $check -gt $call -and $record -gt $check) 'verify-ensures-then-checks-then-records'
Yes ($call -gt 0 -and $genCheck -gt $call -and $pinRead -gt $genCheck -and $pinned -gt $pinRead -and $check -gt $pinned) 'system-only-pinned-rule-then-check'
Yes ($body.IndexOf('$verifyIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()') -lt $call -and -not $body.Contains('if ($verifyCanFix) { $relayAdded')) 'elevated-by-hand-never-writes'
Yes (@([regex]::Matches($body, 'Invoke-CompanionRelayParentsEnsure ')).Count -eq 1) 'one-call-site'

$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$companion = 'S-1-5-21-1-2-3-1008'; $operator = 'S-1-5-21-1-2-3-1001'; $other = 'S-1-5-21-1-2-3-1007'
$base = "O:${me}G:${me}D:PAI(A;OICI;FA;;;$me)(A;OICI;0x1200a9;;;$other)(A;;0x120080;;;$operator)"
$ace = "(A;;0x120080;;;$companion)"
function Set-Dacl([string]$path, [string]$sddl) { $s = New-Object Security.AccessControl.DirectorySecurity; $s.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access); [IO.Directory]::SetAccessControl($path, $s) }
function Dacl([string]$path) { Get-DaclPart (Get-Acl -LiteralPath $path).Sddl }
function New-Node([string]$name) {
  $ci = Join-Path $Scratch $name; $root = Join-Path $ci 'resident'
  [void][IO.Directory]::CreateDirectory($root); [void][IO.Directory]::CreateDirectory((Join-Path $ci 'formal-spool'))
  foreach ($p in @($ci, (Join-Path $ci 'formal-spool'))) { Set-Dacl $p $base }
  [ordered]@{ ci = $ci; spool = (Join-Path $ci 'formal-spool'); root = $root }
}
function ShaOf([string]$f) { (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant() }
$installerSha = ShaOf $installer
function Ensure($n, [string]$sid = $companion, [string]$inst = $installer, [string]$pin = $installerSha) { Invoke-CompanionRelayParentsEnsure $n.root $sid $inst $pin }

# 1. missing on both: exactly that ACE is appended to each; every other ACE and the owner are kept.
$n = New-Node 'missing'
$before = @((Get-Acl -LiteralPath $n.ci).Sddl, (Get-Acl -LiteralPath $n.spool).Sddl); $owner = (Get-Acl -LiteralPath $n.ci).Owner
Yes ((Ensure $n) -eq 2) 'missing-both-written'
foreach ($i in 0, 1) {
  $path = @($n.ci, $n.spool)[$i]; $now = (Get-Acl -LiteralPath $path).Sddl
  $old = @(Get-AceKeys $before[$i]); $new = @(Get-AceKeys $now)
  Yes ($new.Count -eq $old.Count + 1 -and @($old | Where-Object { $new -cnotcontains $_ }).Count -eq 0) ('one-ace-added-others-kept-' + $i)
  $added = @($new | Where-Object { $old -cnotcontains $_ })
  Yes ((Get-RelayParentAclPresence $now $companion) -ceq 'present' -and $added.Count -eq 1 -and $added[0] -ceq ($companion + '|1179776|0|AccessAllowed')) ('exactly-the-install-ace-added-' + $i)
}
Yes ((Get-Acl -LiteralPath $n.ci).Owner -ceq $owner) 'owner-unchanged'

# 2. present: nothing written, twice.
$after = @((Dacl $n.ci), (Dacl $n.spool))
foreach ($k in 1, 2) { Yes ((Ensure $n) -eq 0 -and (Dacl $n.ci) -ceq $after[0] -and (Dacl $n.spool) -ceq $after[1]) ('present-untouched-' + $k) }

# 3. one present, one missing with an unrelated extra ACE: only the missing one is written, the extra ACE stays.
$n = New-Node 'half'
Set-Dacl $n.ci ($base + $ace); Set-Dacl $n.spool ($base + '(A;;0x1200a9;;;S-1-5-21-1-2-3-1099)')
$ciBefore = Dacl $n.ci
Yes ((Ensure $n) -eq 1 -and (Dacl $n.ci) -ceq $ciBefore) 'only-missing-parent-written'
Yes ((Dacl $n.spool).Contains('(A;;0x1200a9;;;S-1-5-21-1-2-3-1099)') -and (Get-RelayParentAclPresence (Get-Acl -LiteralPath $n.spool).Sddl $companion) -ceq 'present') 'extra-ace-kept'

# 4. a SID of the wrong shape is refused before anything is read.
foreach ($bad in @('', 'S-1-5-18', 'S-1-5-21-1-2-1008', ($companion + ')(A;;FA;;;WD'), 'S-1-5-21-1-2-3-12345678901')) {
  $n = New-Node ('sid-' + $bad.Length); $d = @((Dacl $n.ci), (Dacl $n.spool))
  Yes ((Refused { Ensure $n $bad } 'RELAY_PARENT_SID_REFUSED') -and (Dacl $n.ci) -ceq $d[0] -and (Dacl $n.spool) -ceq $d[1]) ('bad-sid-refused-' + $bad.Length)
}

# 5. links: formal-spool is a junction; the CI root is reached through a junction. Neither target is touched.
$n = New-Node 'link-spool'
[IO.Directory]::Delete($n.spool); $target = Join-Path $Scratch 'link-target'; [void][IO.Directory]::CreateDirectory($target); Set-Dacl $target $base
New-Item -ItemType Junction -Path $n.spool -Value $target | Out-Null
Yes ((Refused { Ensure $n } 'RELAY_PARENT_LINK_OR_NOT_A_DIRECTORY') -and (Get-RelayParentAclPresence (Get-Acl -LiteralPath $target).Sddl $companion) -ceq 'missing' -and (Get-RelayParentAclPresence (Get-Acl -LiteralPath $n.ci).Sddl $companion) -ceq 'missing') 'junction-parent-refused'
$n = New-Node 'real-ci'
$alias = Join-Path $Scratch 'alias-ci'; New-Item -ItemType Junction -Path $alias -Value $n.ci | Out-Null
Yes ((Refused { Invoke-CompanionRelayParentsEnsure (Join-Path $alias 'resident') $companion $installer $installerSha } 'RELAY_PARENT_LINK_OR_NOT_A_DIRECTORY') -and (Get-RelayParentAclPresence (Get-Acl -LiteralPath $n.ci).Sddl $companion) -ceq 'missing') 'junction-ancestor-refused'

# 6. the installer's rule refuses what it refuses (and nothing is written): another entry of the account, a deny, an unprotected DACL.
foreach ($c in @(
    @{ name = 'inheritable'; sddl = ($base + "(A;OICI;0x120080;;;$companion)"); code = 'PARENT_ACL_HAS_OTHER_RESIDENT_ACES' },
    @{ name = 'wider'; sddl = ($base + "(A;;0x1200a9;;;$companion)"); code = 'PARENT_ACL_HAS_OTHER_RESIDENT_ACES' },
    @{ name = 'deny'; sddl = ("O:${me}G:${me}D:PAI(D;;0x120080;;;S-1-5-21-1-2-3-1098)(A;OICI;FA;;;$me)(A;OICI;0x1200a9;;;$other)"); code = 'COMPANION_RELAY_PARENT_ACL_REFUSED' },
    @{ name = 'unprotected'; sddl = ("O:${me}G:${me}D:AI(A;OICI;FA;;;$me)(A;OICI;0x1200a9;;;$other)"); code = 'PARENT_ACL_NOT_PROTECTED' })) {
  $n = New-Node ('rule-' + $c.name); Set-Dacl $n.ci $c.sddl
  $d = @((Dacl $n.ci), (Dacl $n.spool))
  Yes ((Refused { Ensure $n } $c.code) -and (Dacl $n.ci) -ceq $d[0] -and (Dacl $n.spool) -ceq $d[1]) ('rule-refused-' + $c.name)
}

# 7. the DACL changed after the plan: the installer's compare-before-write refuses (only the first parent is written, as planned).
$n = New-Node 'toctou'
$plans = & {
  $ast2 = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$t, [ref]$e)
  foreach ($x in @('Get-DaclPart', 'Get-DaclShape', 'Get-ParentAce', 'Get-AceKeys', 'Get-ParentAclState', 'Add-ParentAce', 'Get-RelayParentAclPresence', 'Assert-CompanionRelayParentPlan', 'Add-CompanionRelayParentAce', 'Get-CompanionRelayParentsPlan')) {
    . ([scriptblock]::Create(@($ast2.FindAll({ param($y) $y -is [Management.Automation.Language.FunctionDefinitionAst] -and $y.Name -ceq $x }, $true))[0].Extent.Text)) }
  $OwnerSid = $companion; $CiRoot = $n.ci
  $p = Get-CompanionRelayParentsPlan ([ordered]@{ present = $true })
  Set-Dacl $n.spool ($base + '(A;;0x1200a9;;;S-1-5-21-1-2-3-1097)')
  $r1 = Add-CompanionRelayParentAce $p[0]
  $r2 = try { Add-CompanionRelayParentAce $p[1]; 'WROTE' } catch { $_.Exception.Message }
  ,@($r1, $r2)
}
Yes ($plans[0] -eq $true -and $plans[1] -ceq 'COMPANION_RELAY_PARENT_CHANGED_SINCE_PLAN' -and (Get-RelayParentAclPresence (Get-Acl -LiteralPath $n.spool).Sddl $companion) -ceq 'missing') 'changed-since-plan-refused'

# 8. the rule comes only from install-resident.ps1: a copy without one of its functions is refused before anything is written.
$broken = Join-Path $Scratch 'install-resident.ps1'
[IO.File]::WriteAllText($broken, ([IO.File]::ReadAllText($installer) -replace 'function Add-CompanionRelayParentAce', 'function Renamed-Away'))
$n = New-Node 'broken-rule'; $d = Dacl $n.ci
Yes ((Refused { Ensure $n $companion $broken (ShaOf $broken) } 'RELAY_PARENT_RULE_MISSING:Add-CompanionRelayParentAce') -and (Dacl $n.ci) -ceq $d) 'installer-rule-required'

# 9. the rule's bytes must be the pinned ones: another hash, or no well-formed pin, is refused before anything is parsed or written.
$n = New-Node 'pin'; $d = @((Dacl $n.ci), (Dacl $n.spool))
Yes ((Refused { Ensure $n $companion $installer ('0' * 64) } 'RELAY_PARENT_RULE_HASH_MISMATCH') -and (Dacl $n.ci) -ceq $d[0] -and (Dacl $n.spool) -ceq $d[1]) 'other-hash-refused'
Yes ((Refused { Ensure $n $companion $broken $installerSha } 'RELAY_PARENT_RULE_HASH_MISMATCH') -and (Dacl $n.ci) -ceq $d[0]) 'changed-installer-refused'
foreach ($bad in @('', 'ABC', ('A' * 64), ($installerSha + '0'))) { Yes ((Refused { Ensure $n $companion $installer $bad } 'RELAY_PARENT_RULE_NOT_PINNED') -and (Dacl $n.ci) -ceq $d[0]) ('malformed-pin-refused-' + $bad.Length) }
Yes ((Ensure $n) -eq 2) 'pinned-installer-accepted'

# 10. r13 (Fable ruling 0e418483): <CiRoot>\state by the installer's rule state-parent-acl, through verify's Invoke-StateParentEnsure.
# The wiring: on every node (after the companion-account branch, before not-halted); SYSTEM writes, elevated by hand reads, never writes.
$stateCall = $body.IndexOf('Invoke-StateParentEnsure $Root ([string]$Node.controllerSid) (Join-Path $PSScriptRoot ''install-resident.ps1'') ([string]$statePin[0].sha256) -Write:($verifyIdentity.User.Value -ceq ''S-1-5-18'')')
$stateGen = $body.IndexOf('$stateManifestSha -cne [string]$receipt.residentManifestSha256 -or (Split-Path -Leaf (Split-Path -Parent $PSScriptRoot)) -cne $stateManifestSha')
$statePinRead = $body.IndexOf('$statePin = @(@((Get-Content -LiteralPath $stateManifest -Raw | ConvertFrom-Json).files) | Where-Object { [string]$_.path -ceq ''windows/install-resident.ps1'' })')
$stateGate = $body.IndexOf("if (`$verifyCanFix) {`n  `$stateParent = try {")
$stateRecord = $body.IndexOf('Record ''state-parent-acl'' ($stateParent.action -ceq ''none'' -or $stateParent.wrote)')
Yes ($stateGate -gt $record -and $stateGen -gt $stateGate -and $statePinRead -gt $stateGen -and $stateCall -gt $statePinRead -and $stateRecord -gt $stateCall -and $body.IndexOf("Record 'not-halted'") -gt $stateRecord) 'state-parent-every-node-pinned-rule-then-record'
Yes (@([regex]::Matches($body, 'Invoke-StateParentEnsure \$')).Count -eq 1 -and $body.Contains("} else { Record 'state-parent-acl' `$true 'NOT_ELEVATED_NOT_READ' }")) 'state-parent-one-call-site-not-elevated-not-read'
$sfn = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-StateParentEnsure' }, $true))
Yes ($sfn.Count -eq 1) 'one-state-ensure-function'
. ([scriptblock]::Create($sfn[0].Extent.Text))
foreach ($n in @('Get-DaclShape', 'Get-StateParentSddl')) { . ([scriptblock]::Create(@($ia.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -ceq $n }, $true))[0].Extent.Text)) }
$controller = 'S-1-5-21-1-2-3-1007'
$wide = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$controller)"
function New-StateNode([string]$name, [string]$dacl) {
  $ci = Join-Path $Scratch $name; [void][IO.Directory]::CreateDirectory((Join-Path $ci 'resident')); $s = Join-Path $ci 'state'; [void][IO.Directory]::CreateDirectory($s)
  Set-Dacl $s $dacl; [ordered]@{ ci = $ci; root = (Join-Path $ci 'resident'); state = $s }
}
function StateEnsure($n, [switch]$Write, [string]$inst = $installer, [string]$pin = $installerSha) { Invoke-StateParentEnsure $n.root $controller $inst $pin -Write:$Write }
$stateDirs = @()
# a. the r13 state (the controller's modify on state itself): by hand nothing is written; as SYSTEM the rule converges it, then nothing more.
$n = New-StateNode 'state-wide' $wide; $stateDirs += $n.state
$d = Dacl $n.state; $r = StateEnsure $n
Yes ($r.action -ceq 'converge' -and $r.wrote -eq $false -and (Dacl $n.state) -ceq $d) 'state-read-only-without-write'
$r = StateEnsure $n -Write
Yes ($r.action -ceq 'converge' -and $r.wrote -eq $true -and (Get-DaclShape (Dacl $n.state)) -ceq (Get-DaclShape (Get-StateParentSddl $controller))) 'state-converged-with-write'
$d = Dacl $n.state; $r = StateEnsure $n -Write
Yes ($r.action -ceq 'none' -and $r.wrote -eq $false -and (Dacl $n.state) -ceq $d) 'state-passing-not-written'
# b. another writer: refused by the installer's rule, nothing written.
$n = New-StateNode 'state-other' ($wide + '(A;;0x1301bf;;;S-1-5-21-1-2-3-1099)'); $stateDirs += $n.state; $d = Dacl $n.state
Yes ((Refused { StateEnsure $n -Write } 'STATE_PARENT_ACL_REFUSED:OTHER_WRITER:S-1-5-21-1-2-3-1099') -and (Dacl $n.state) -ceq $d) 'state-other-writer-refused'
# c. the rule's bytes: another hash, a copy without one of its functions, a malformed pin or SID: refused before anything is written.
$n = New-StateNode 'state-pin' $wide; $stateDirs += $n.state; $d = Dacl $n.state
$brokenState = Join-Path $Scratch 'install-resident-state.ps1'
[IO.File]::WriteAllText($brokenState, ([IO.File]::ReadAllText($installer) -replace 'function Invoke-StateParentAcl', 'function Renamed-Away'))
Yes ((Refused { StateEnsure $n -Write -pin ('0' * 64) } 'STATE_PARENT_RULE_HASH_MISMATCH') -and (Dacl $n.state) -ceq $d) 'state-other-hash-refused'
Yes ((Refused { StateEnsure $n -Write -inst $brokenState -pin (ShaOf $brokenState) } 'STATE_PARENT_RULE_MISSING:Invoke-StateParentAcl') -and (Dacl $n.state) -ceq $d) 'state-installer-rule-required'
Yes ((Refused { StateEnsure $n -Write -pin 'ABC' } 'STATE_PARENT_RULE_NOT_PINNED') -and (Refused { Invoke-StateParentEnsure $n.root 'S-1-5-18' $installer $installerSha -Write } 'STATE_PARENT_SID_REFUSED') -and (Dacl $n.state) -ceq $d) 'state-malformed-pin-or-sid-refused'
# d. the CI root reached through a junction: refused, the real state untouched.
$alias = Join-Path $Scratch 'alias-state-ci'; New-Item -ItemType Junction -Path $alias -Value $n.ci | Out-Null
Yes ((Refused { Invoke-StateParentEnsure (Join-Path $alias 'resident') $controller $installer $installerSha -Write } 'STATE_PARENT_LINK_OR_NOT_A_DIRECTORY') -and (Dacl $n.state) -ceq $d) 'state-junction-ancestor-refused'
[IO.Directory]::Delete($alias)
foreach ($s in $stateDirs) { Set-Dacl $s ('D:(A;OICI;FA;;;' + $me + ')') }   # owner rights: the scratch can be removed

[ordered]@{ status = 'VERIFY_RELAY_PARENTS_ENSURE_TEMP_PASS'; assertions = $count; verifySha256 = (Get-FileHash -LiteralPath $verify -Algorithm SHA256).Hash.ToLowerInvariant(); productionReadOrWrite = $false; elevated = $false } | ConvertTo-Json -Compress
