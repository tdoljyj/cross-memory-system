<#
  Offline check of install-resident.ps1's carry-forward of the executed heads (resident quota redesign v0.6 + section 9,
  phase 1, item 7). Nothing on the host is read or changed: the functions are taken from the real install script by
  AST and run against fake earlier states in the NEW scratch directory given by the caller.
  - only resident-uninstalled-* states, only the fixed record shapes, each file read once and listed with its SHA-256;
  - a link anywhere refuses before anything is written;
  - the manifest it writes is exactly what the resident's backfill (src/executed-heads.mjs) reads: node runs the real
    backfill over it and finds the published head.
  powershell -NoProfile -ExecutionPolicy Bypass -File test-install-carry.ps1 -Scratch <new empty directory> [-Node <node.exe>]
#>
param([Parameter(Mandatory)][string]$Scratch, [string]$Node = 'node')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Scratch) { if (@(Get-ChildItem -LiteralPath $Scratch -Force).Count) { throw 'EMPTY_SCRATCH_REQUIRED' } } else { [void][IO.Directory]::CreateDirectory($Scratch) }
$here = $PSScriptRoot
$n = 0
function Yes([bool]$ok, [string]$what) { if (-not $ok) { throw ('FAILED:' + $what) }; $script:n++ }

$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $here 'install-resident.ps1'), [ref]$tokens, [ref]$errors)
Yes ($errors.Count -eq 0) 'parse:install-resident.ps1'
$functions = @{}
foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
foreach ($name in @('Sha256Bytes', 'Test-NoLink', 'Get-CarryForwardPlan', 'Copy-CarryForward')) { Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name])) }
$CarryLedgerRecords = @('00-reserved.json', '10-started.json', '25-plan.json', '80-owner-abort.json', '90-terminal.json')
$installText = Get-Content -LiteralPath (Join-Path $here 'install-resident.ps1') -Raw
Yes ($installText.Contains("`$CarryLedgerRecords = @('00-reserved.json', '10-started.json', '25-plan.json', '80-owner-abort.json', '90-terminal.json')")) 'install-uses-the-same-ledger-records'
Yes ($installText.IndexOf('$carry = Get-CarryForwardPlan $CarryParent') -lt $installText.IndexOf("Step 'directories'")) 'carry-planned-before-anything-is-written'
Yes ($installText.IndexOf("Step 'carry-forward'") -gt $installText.IndexOf("Step 'directories'")) 'carry-after-the-state-directory-exists'

function Put([string]$path, [string]$text) { [void][IO.Directory]::CreateDirectory((Split-Path -Parent $path)); [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
$repo = 'tdoljyj/cross-memory-system'
$head = 'a' * 40; $other = 'b' * 40
$key = '1' * 64; $hk = '2' * 64; $key2 = '3' * 64; $hk2 = '4' * 64
$third = 'e' * 40; $dirOnly = '6' * 32
# The real executed-head keys (src/executed-heads.mjs#executedHeadKey) of the two heads with executed-heads records.
$module = ([Uri](Join-Path (Split-Path -Parent $here) 'src\executed-heads.mjs')).AbsoluteUri
$keyOf = { param([string]$sha) (& $Node --input-type=module -e ("import { executedHeadKey } from '" + $module + "'; console.log(executedHeadKey({ repo: 'tdoljyj/cross-memory-system', headSha: '" + $sha + "' }))") | Out-String).Trim() }
$ek = & $keyOf $head; $ek3 = & $keyOf $third
Yes ($ek -cmatch '^[0-9a-f]{32}$' -and $ek3 -cmatch '^[0-9a-f]{32}$' -and $ek -cne $ek3) 'real-executed-head-keys'
$subject = '"subject":{"attempt":1,"baseSha":"' + ('c' * 40) + '","headSha":"' + $head + '","pr":884,"repo":"' + $repo + '","sourceManifestSha256":"' + ('d' * 64) + '"}'
$subject2 = $subject.Replace($head, $other).Replace('"pr":884', '"pr":885')

# Two earlier states and some things that are not one.
$parent = Join-Path $Scratch 'CluedIndependentCI'
$old1 = Join-Path $parent 'resident-uninstalled-20261021T120000Z-aaaaaa\state'
Put (Join-Path $old1 ('ledger-heads\' + $hk + '.json')) ('{"headKey":"' + $hk + '","key":"' + $key + '",' + $subject + ',"startedAt":"2026-10-21T12:00:00.000Z"}')
Put (Join-Path $old1 ('ledger\' + $key + '\00-reserved.json')) ('{"headKey":"' + $hk + '","key":"' + $key + '",' + $subject + '}')
Put (Join-Path $old1 ('ledger\' + $key + '\10-started.json')) ('{"key":"' + $key + '"}')
Put (Join-Path $old1 ('ledger\' + $key + '\15-relay-wait.json')) '{"not":"carried"}'
Put (Join-Path $old1 ('ledger\' + $key + '\25-plan.json')) ''   # an interrupted write: empty, carried, counted unreadable
Put (Join-Path $old1 ('ledger\' + $key + '\90-terminal.json')) ('{"key":"' + $key + '","outcome":"COMPLETED","facts":{}}')
# a head burned at stage 1 only (published nothing): carried, but not executed after the backfill
Put (Join-Path $old1 ('ledger-heads\' + $hk2 + '.json')) ('{"headKey":"' + $hk2 + '","key":"' + $key2 + '",' + $subject2 + ',"startedAt":"2026-10-21T12:00:00.000Z","burnedBy":{"failureCode":"STAGE_CHILD_REFUSED"}}')
Put (Join-Path $old1 ('ledger\' + $key2 + '\00-reserved.json')) ('{"headKey":"' + $hk2 + '","key":"' + $key2 + '",' + $subject2 + '}')
Put (Join-Path $old1 ('ledger\' + $key2 + '\90-terminal.json')) ('{"key":"' + $key2 + '","outcome":"FAILED_CLEAN","facts":{"stage":1,"failureCode":"STAGE_CHILD_REFUSED"}}')
Put (Join-Path $old1 'ledger-heads\notes.txt') 'ignored'
# a head whose executed-heads record was left empty by an interrupted write: its directory still names it
Put (Join-Path $old1 ('executed-heads\' + $ek3 + '\backfill-' + $key2.Substring(0, 16) + '.json')) ''
$old2 = Join-Path $parent 'resident-uninstalled-20261022T060000Z-bbbbbb\state'
Put (Join-Path $old2 ('executed-heads\' + $ek + '\publication-' + $key.Substring(0, 16) + '.json')) ('{"contract":"x","repo":"' + $repo + '","headSha":"' + $head + '","key":"' + $key + '","origin":"publication"}')
Put (Join-Path $old2 'executed-heads\BACKFILL-COMPLETE.json') '{"not":"carried"}'
[void][IO.Directory]::CreateDirectory((Join-Path $old2 ('executed-heads\' + $dirOnly)))   # a key with no record at all
[void][IO.Directory]::CreateDirectory((Join-Path $parent 'resident-uninstalled-20261020T000000Z-cccccc'))   # no state at all
Put (Join-Path $parent 'resident\state\ledger-heads\x.json') '{}'                                         # not an earlier state
Put (Join-Path $parent 'resident-partial-1\state\ledger-heads\y.json') '{}'                              # not an uninstalled one

$plan = Get-CarryForwardPlan $parent
Yes (@($plan).Count -eq 3) 'three-earlier-states'
Yes ((@($plan | ForEach-Object { $_.name }) -join '|') -ceq 'resident-uninstalled-20261020T000000Z-cccccc|resident-uninstalled-20261021T120000Z-aaaaaa|resident-uninstalled-20261022T060000Z-bbbbbb') 'sorted-by-name'
Yes (@($plan[1].files).Count -eq 9) 'fixed-record-shapes-only'
Yes (-not (@($plan[1].files | ForEach-Object { $_.rel }) -match 'relay-wait|notes')) 'nothing-else'

# The dry run's preview (the install's own line): one entry per earlier state, not one entry holding them all.
$CarryParent = $parent
$previewLine = @($installText -split "`r?`n" | Where-Object { $_ -match '^\s*\$preview = try \{' })
Yes ($previewLine.Count -eq 1) 'preview-line-present'
. ([scriptblock]::Create($previewLine[0]))
$previewJson = ConvertTo-Json -InputObject $preview -Depth 4 -Compress
$previewBack = $previewJson | ConvertFrom-Json   # PS 5.1 hands a JSON array back as one object: assigned, not wrapped
Yes ($previewBack.Count -eq 3 -and $previewBack[1].name -ceq 'resident-uninstalled-20261021T120000Z-aaaaaa' -and $previewBack[1].files -eq 9 -and $previewBack[0].files -eq 0) ('preview-one-entry-per-state:' + $previewJson)

$newState = Join-Path $Scratch 'new\state'
[void][IO.Directory]::CreateDirectory($newState)
$manifest = Copy-CarryForward $plan $newState
$json = ConvertTo-Json -InputObject $manifest -Depth 6 -Compress
$manifestFile = Join-Path $Scratch 'new\install\backfill-manifest.json'
Put $manifestFile $json
$back = $json | ConvertFrom-Json
Yes ($back.contract -ceq 'clued.independent-ci.resident-backfill-manifest/1') 'manifest-contract'
Yes ((@($back.sources)[0].files -is [array]) -and @(@($back.sources)[0].files).Count -eq 0) 'an-empty-state-keeps-an-array'
Yes ((@($back.sources)[2].files -is [array]) -and @(@($back.sources)[2].files).Count -eq 1) 'a-single-file-stays-an-array'
Yes ((@($back.sources)[1].heads -is [array]) -and (@(@($back.sources)[1].heads) -join ',') -ceq $ek3) ('one-key-stays-an-array:' + $json)
Yes ((@(@($back.sources)[2].heads) -join ',') -ceq ((@($ek, $dirOnly) | Sort-Object) -join ',')) 'every-key-listed-also-without-a-record'
Yes ((@($back.sources)[0].heads -is [array]) -and @(@($back.sources)[0].heads).Count -eq 0) 'no-keys-keeps-an-array'
foreach ($s in @($back.sources)) {
  foreach ($f in @($s.files)) {
    $copy = Join-Path (Join-Path (Join-Path $newState 'backfill') $s.dir) ($f.path.Replace('/', '\'))
    $bytes = [IO.File]::ReadAllBytes($copy)
    Yes ((Sha256Bytes $bytes) -ceq $f.sha256 -and $bytes.Length -eq $f.bytes -and $f.path -notmatch '\\') ('copied:' + $f.path)
  }
}
$threw = $null; try { $null = Copy-CarryForward $plan $newState } catch { $threw = $_.Exception.Message }
Yes ($null -ne $threw) 'create-only-never-overwrites'

# The resident's real backfill over exactly this manifest.
$script = Join-Path $Scratch 'backfill.mjs'
Put $script ("import path from 'node:path';`nimport { ExecutedHeads } from '" + $module + "';`n" +
  "const [state, manifestFile] = process.argv.slice(2);`n" +
  "const e = await ExecutedHeads.open(state, Date.now, { manifestFile, carriedRoot: path.join(state, 'backfill') });`n" +
  "const m = await e.backfill();`n" +
  "console.log(JSON.stringify({ published: m.published, unreadable: m.unreadable, head: await e.published({ repo: '" + $repo + "', headSha: '" + $head + "' }), third: await e.published({ repo: '" + $repo + "', headSha: '" + $third + "' }), other: await e.published({ repo: '" + $repo + "', headSha: '" + $other + "' }) }));")
$out = & $Node $script $newState $manifestFile | Out-String
Yes ($LASTEXITCODE -eq 0) ('node-backfill:' + $out)
$r = $out | ConvertFrom-Json
# published: head (ledger and record), third (its empty record's key), the key without a record; unreadable: the two empty files
Yes ($r.published -eq 3 -and $r.unreadable -eq 2 -and $r.head -eq $true -and $r.third -eq $true -and $r.other -eq $false) ('backfill-reads-the-manifest:' + $out.Trim())

# A link anywhere in an earlier state refuses before anything is written.
$linked = Join-Path $Scratch 'linked'
$target = Join-Path $Scratch 'elsewhere'
[void][IO.Directory]::CreateDirectory($target)
Put (Join-Path $linked ('resident-uninstalled-20261022T070000Z-dddddd\state\ledger-heads\' + $hk + '.json')) '{}'
$null = New-Item -ItemType Junction -Path (Join-Path $linked ('resident-uninstalled-20261022T070000Z-dddddd\state\ledger\' + $key)) -Target $target
$threw = $null; try { $null = Get-CarryForwardPlan $linked } catch { $threw = $_.Exception.Message }
Yes ($threw -like 'CARRY_FORWARD_LINK_REFUSED:*') ('junction-refused:' + $threw)

# More earlier states than the backfill reads (256): refused before anything is written.
$many = Join-Path $Scratch 'many'
for ($i = 0; $i -lt 257; $i++) { [void][IO.Directory]::CreateDirectory((Join-Path $many ('resident-uninstalled-20261022T000000Z-' + $i.ToString('000')))) }
$threw = $null; try { $null = Get-CarryForwardPlan $many } catch { $threw = $_.Exception.Message }
Yes ($threw -ceq 'CARRY_FORWARD_TOO_MANY_STATES:257') ('too-many-states:' + $threw)

[ordered]@{ status = 'RESIDENT_INSTALL_CARRY_OFFLINE_PASS'; assertions = $n; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
