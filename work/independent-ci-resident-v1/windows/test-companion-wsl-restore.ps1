<# Offline restore tests. Filesystem and ACL operations are in-memory fakes;
   no host path, WSL client, account, registration or task is accessed. #>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'companion-headless.ps1')
$script:count = 0
$script:sid = 'S-1-5-21-1-2-3-1008'
$script:dir = 'D:\CluedWSL\Distro'
$script:source = 'C:\Owner\ext4.vhdx'
$script:node = [pscustomobject]@{ ownerSid = $script:sid }
function Yes([bool]$value, [string]$label) { if (-not $value) { throw ('FAILED:' + $label) }; $script:count++ }
function Reset-World {
  $script:items = @{}
  foreach ($p in @('C:\', 'C:\Owner', 'D:\', 'D:\CluedWSL', $script:dir)) { $script:items[$p] = [pscustomobject]@{ PSIsContainer = $true; Attributes = [IO.FileAttributes]::Directory; Name = (Split-Path -Leaf $p) } }
  $script:items[$script:source] = [pscustomobject]@{ PSIsContainer = $false; Attributes = [IO.FileAttributes]::Normal; Name = 'ext4.vhdx' }
  $script:sddls = @{}
  foreach ($p in @('C:\', 'C:\Owner', 'D:\', 'D:\CluedWSL')) { $script:sddls[$p] = $CompanionVhdxParentSddl }
  $script:sddls[$script:dir] = Get-CompanionVhdxSddl $script:sid
  $script:children = @(); $script:setCalls = 0; $script:setMode = 'ok'; $script:readbackMode = 'ok'
  $script:record = [ordered]@{ contract = $CompanionWslContract; source = $script:source; target = ($script:dir + '\ext4.vhdx'); companionSid = $script:sid; parentsCreated = @('D:\CluedWSL', $script:dir) }
}
# The actual restore logic and ACL decision functions remain unchanged.
function Test-Path([string]$LiteralPath, [string]$PathType) {
  if (-not $script:items.ContainsKey($LiteralPath)) { return $false }
  if ($PathType -ceq 'Leaf') { return -not $script:items[$LiteralPath].PSIsContainer }
  if ($PathType -ceq 'Container') { return $script:items[$LiteralPath].PSIsContainer }
  $true
}
function Get-Item([string]$LiteralPath, [switch]$Force) {
  if (-not $script:items.ContainsKey($LiteralPath)) { throw 'FAKE_ITEM_MISSING' }
  $script:items[$LiteralPath]
}
function Get-ChildItem([string]$LiteralPath, [switch]$Force, $ErrorAction) {
  if ($LiteralPath -cne $script:dir) { throw 'UNEXPECTED_ENUMERATION' }
  $script:children
}
function Get-CompanionDirSddl([string]$path) {
  if ($path -ceq $script:dir -and $script:setCalls -gt 0 -and $script:readbackMode -ceq 'throw') { throw 'FAKE_READBACK_FAILED' }
  if ($path -ceq $script:dir -and $script:setCalls -gt 0 -and $script:readbackMode -ceq 'old') { return (Get-CompanionVhdxSddl $script:sid) }
  $script:sddls[$path]
}
function Set-CompanionRestoreTargetAcl([string]$dir) {
  if ($dir -cne $script:dir) { throw 'UNEXPECTED_ACL_TARGET' }
  $script:setCalls++
  if ($script:setMode -ceq 'throw') { throw 'FAKE_SET_FAILED' }
  $script:sddls[$dir] = $CompanionRestoredVhdxSddl
  if ($script:setMode -ceq 'wrong-owner') { $script:sddls[$dir] = $CompanionRestoredVhdxSddl.Replace('O:BA', ('O:' + $script:sid)) }
  if ($script:setMode -ceq 'link') { $script:items[$dir].Attributes = [IO.FileAttributes]::ReparsePoint }
}
function Remove-Item { throw 'RESTORE_MUST_NOT_DELETE' }
function Set-Acl { throw 'RESTORE_MUST_USE_ISOLATED_LEAF_SETTER' }
function Expect-Failure([string]$code, [int]$setCalls = 0) {
  $actual = ''
  try { $null = Restore-CompanionTargetDirectory $script:record $script:node } catch { $actual = [string]$_.Exception.Message }
  Yes ($actual -ceq $code) ('refusal:' + $code + ':actual=' + $actual)
  Yes ($script:setCalls -eq $setCalls) ('setter-count:' + $code)
}

Reset-World
$r = Restore-CompanionTargetDirectory $script:record $script:node
Yes ($r.status -ceq 'REUSABLE' -and $script:setCalls -eq 1) 'normal-leaf-restored'
Yes (Test-CompanionRestoreTargetAcl $r.afterSddl $script:sid -RestoredOnly) 'protected-exact-readback'
Yes ($null -eq (Get-CompanionDirAclProblem $r.afterSddl $false)) 'next-parent-check-accepts-restored-leaf'
$r = Restore-CompanionTargetDirectory ([pscustomobject]$script:record) $script:node
Yes ($r.status -ceq 'REUSABLE' -and $script:setCalls -eq 2) 'already-restored-retry-and-json-record'

Reset-World
foreach ($name in @('ext4.vhdx.partial', 'companion-wsl-import-result.json')) { $script:children += [pscustomobject]@{ Name = $name; PSIsContainer = $false; Attributes = [IO.FileAttributes]::Normal } }
$before = $script:children | ConvertTo-Json -Compress
$r = Restore-CompanionTargetDirectory $script:record $script:node
Yes ($r.kept.Count -eq 2 -and ($script:children | ConvertTo-Json -Compress) -ceq $before) 'partial-and-diagnostics-preserved'

foreach ($proof in @('missing', 'string', 'mixed', 'wrong-leaf')) {
  Reset-World
  switch ($proof) {
    missing { $script:record.Remove('parentsCreated') }
    string { $script:record.parentsCreated = $script:dir }
    mixed { $script:record.parentsCreated = @($script:dir, 42) }
    wrong-leaf { $script:record.parentsCreated = @('D:\CluedWSL') }
  }
  Expect-Failure 'WSL_RESTORE_TARGET_OWNERSHIP_UNCONFIRMED'
}
foreach ($kind in @('null', 'string', 'array', 'missing-field', 'wrong-type', 'wrong-contract', 'wrong-sid')) {
  Reset-World
  switch ($kind) {
    null { $script:record = $null }
    string { $script:record = 'record' }
    array { $script:record = @(@{}, @{}) }
    missing-field { $script:record.Remove('source') }
    wrong-type { $script:record.target = @($script:record.target) }
    wrong-contract { $script:record.contract = 'other' }
    wrong-sid { $script:record.companionSid = 'S-1-5-21-1-2-3-10080' }
  }
  Expect-Failure 'WSL_RESTORE_TARGET_RECORD_REFUSED'
}
foreach ($kind in @('unknown-file', 'subdirectory', 'link')) {
  Reset-World
  $script:children = @([pscustomobject]@{ Name = $(if ($kind -ceq 'unknown-file') { 'notes.txt' } else { 'ext4.vhdx.partial' }); PSIsContainer = ($kind -ceq 'subdirectory'); Attributes = $(if ($kind -ceq 'link') { [IO.FileAttributes]::ReparsePoint } else { [IO.FileAttributes]::Normal }) })
  Expect-Failure 'WSL_RESTORE_TARGET_CONTENTS_UNCONFIRMED'
  Yes ($script:children.Count -eq 1) ('unknown-content-kept:' + $kind)
}
Reset-World
$script:items[$script:record.target] = [pscustomobject]@{ PSIsContainer = $false; Attributes = [IO.FileAttributes]::Normal }
Expect-Failure 'WSL_RESTORE_TARGET_VHDX_REMAINS'
foreach ($p in @($script:dir, 'D:\CluedWSL')) {
  Reset-World; $script:items[$p].Attributes = [IO.FileAttributes]::ReparsePoint
  Expect-Failure 'WSL_RESTORE_TARGET_NOT_PLAIN'
}
foreach ($p in @($script:source, 'C:\Owner')) {
  Reset-World; $script:items[$p].Attributes = [IO.FileAttributes]::ReparsePoint
  Expect-Failure 'WSL_RESTORE_SOURCE_NOT_PLAIN'
}
Reset-World; $script:items.Remove($script:source)
Expect-Failure 'WSL_RESTORE_SOURCE_NOT_PLAIN'
Reset-World; $script:sddls['D:\CluedWSL'] = 'O:BAG:BAD:P(A;;FA;;;WD)'
Expect-Failure 'WSL_RESTORE_TARGET_PARENT_UNSAFE'
foreach ($bad in @(
    ('O:' + $script:sid + 'G:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'),
    ('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $script:sid + ')'),
    ('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $script:sid + '0)'),
    'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FW;;;WD)',
    'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;WD)',
    'O:BAG:BAD:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)',
    'not-sddl')) {
  Reset-World; $script:sddls[$script:dir] = $bad
  Expect-Failure 'WSL_RESTORE_TARGET_ACL_UNCONFIRMED'
}
Reset-World; $script:setMode = 'throw'; Expect-Failure 'WSL_RESTORE_TARGET_ACL_WRITE_FAILED' 1
foreach ($mode in @('old', 'throw')) {
  Reset-World; $script:readbackMode = $mode; Expect-Failure 'WSL_RESTORE_TARGET_ACL_READBACK_MISMATCH' 1
  $script:readbackMode = 'ok'
  $r = Restore-CompanionTargetDirectory $script:record $script:node
  Yes ($r.status -ceq 'REUSABLE') ('readback-failure-retry:' + $mode)
}
foreach ($mode in @('wrong-owner', 'link')) {
  Reset-World; $script:setMode = $mode; Expect-Failure 'WSL_RESTORE_TARGET_ACL_READBACK_MISMATCH' 1
}
Reset-World; $script:items.Remove($script:dir)
$r = Restore-CompanionTargetDirectory $script:record $script:node
Yes ($r.status -ceq 'ABSENT' -and $script:setCalls -eq 0) 'already-absent-no-change'
[ordered]@{ status = 'PASSED'; assertions = $script:count; hostChanges = $false } | ConvertTo-Json -Compress
