// FABLE r5 continue-install ruling (D:/w/tmp/FABLE-r5-continue-install-20261121.md sections 3 and 4.2 B): a PowerShell function that ends
// with a unary comma (", $found") outputs its whole array as ONE object. Wrapping its call in @( ) then gives a one-element array that
// holds the result (an empty result has Count 1), and making it the first stage of a pipeline hands the next command one whole array,
// not its elements. Both turned a "nothing found" into "something found" (continue-install.ps1: a resumed reinstall always
// LINUX_PHASE_STILL_RUNNING_RETRY; first-install-host.ps1: -Reset always RESET_REFUSED_RESIDENT_PRESENT). The return convention stays;
// the two wrong ways to call such a function are refused here, for every .ps1 of the resident, by Windows PowerShell 5.1's own parser.
// No list of functions is kept: which functions return with a comma is read from the scripts each run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempRoot } from './helpers.mjs';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const windows = process.platform === 'win32';

// One JSON line: the comma-returning functions found and every wrong call of one ("<kind> <path>:<line> <function>").
const SCAN = String.raw`param([string]$Root)
$ErrorActionPreference = 'Stop'
$files = @(Get-ChildItem -LiteralPath $Root -Recurse -Filter *.ps1 -File | Where-Object { $_.FullName -notlike '*\node_modules\*' } | Sort-Object FullName)
$asts = @{}; $comma = @{}
foreach ($f in $files) {
  $t = $null; $e = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)
  $asts[$f.FullName] = $ast
  foreach ($fn in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    # a statement of the function's own body (not of a script block or a nested function in it) that is ", <one thing>"
    $hits = @($fn.Body.FindAll({ param($n) $n -is [Management.Automation.Language.ArrayLiteralAst] -and $n.Elements.Count -eq 1 -and $n.Extent.Text.TrimStart().StartsWith(',') }, $true) | Where-Object {
      $p = $_.Parent
      if ($p -isnot [Management.Automation.Language.CommandExpressionAst]) { return $false }
      $pp = $p.Parent; if ($pp -isnot [Management.Automation.Language.PipelineAst] -or $pp.PipelineElements.Count -ne 1) { return $false }
      $g = $pp.Parent
      if (-not ($g -is [Management.Automation.Language.ReturnStatementAst] -or $g -is [Management.Automation.Language.NamedBlockAst] -or $g -is [Management.Automation.Language.StatementBlockAst])) { return $false }
      $q = $_.Parent; while ($q -and $q -isnot [Management.Automation.Language.ScriptBlockAst]) { $q = $q.Parent }
      $q -eq $fn.Body
    })
    if ($hits.Count) { $comma[$fn.Name] = $true }
  }
}
$wrong = @()
foreach ($f in $files) {
  $rel = $f.FullName.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
  foreach ($c in $asts[$f.FullName].FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true)) {
    $name = $c.GetCommandName(); if (-not $name -or -not $comma.ContainsKey($name)) { continue }
    $pl = $c.Parent; $kind = $null
    if ($pl -is [Management.Automation.Language.PipelineAst]) {
      if ($pl.PipelineElements.Count -gt 1 -and $pl.PipelineElements[0] -eq $c) { $kind = 'PIPED' }
      elseif ($pl.PipelineElements.Count -eq 1) {
        $up = $pl.Parent
        if ($up -is [Management.Automation.Language.StatementBlockAst] -and $up.Parent -is [Management.Automation.Language.ArrayExpressionAst] -and $up.Statements.Count -eq 1) { $kind = 'ARRAY-WRAPPED' }
      }
    }
    if ($kind) { $wrong += ('{0} {1}:{2} {3}' -f $kind, $rel, $c.Extent.StartLineNumber, $name) }
  }
}
[Console]::Out.WriteLine(([ordered]@{ functions = @($comma.Keys | Sort-Object); wrong = $wrong } | ConvertTo-Json -Compress -Depth 3))
`;

async function scan(t, root) {
  const dir = await tempRoot(t, 'clued-comma-scan-');
  const script = path.join(dir, 'scan.ps1');
  await fsp.writeFile(script, SCAN);
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

test('comma return: the scan finds both wrong calls and leaves the right ones (a fixture)', { skip: !windows }, async t => {
  const root = await tempRoot(t, 'clued-comma-fixture-');
  await fsp.mkdir(path.join(root, 'a'), { recursive: true });
  await fsp.writeFile(path.join(root, 'a', 'lib.ps1'), [
    'function Get-Whole { $found = @(); , $found }',
    'function Get-Plain { @(1, 2) }',
    'function Get-Nested { $x = { , @(1) }; @(1) }',
    '',
  ].join('\n'));
  await fsp.writeFile(path.join(root, 'use.ps1'), [
    '$a = Get-Whole',                                   // right: the array itself
    '$b = @(Get-Whole)',                                // wrong
    '$c = @((Get-Whole) | Where-Object { $_ })',        // right: the parenthesis unrolls it
    '$d = Get-Whole | Where-Object { $_ }',             // wrong
    '$e = @(Get-Plain)',                                // right: not a comma return
    '$f = @(Get-Nested)',                               // right: the comma is a script block's, not the function's
    '$g = @(Get-Whole; 1)',                             // right: a second statement, a collection on purpose
    '',
  ].join('\n'));
  const r = await scan(t, root);
  assert.deepEqual(r.functions, ['Get-Whole']);
  assert.deepEqual(r.wrong, ['ARRAY-WRAPPED use.ps1:2 Get-Whole', 'PIPED use.ps1:4 Get-Whole']);
});

test('comma return: no .ps1 of the resident wraps a comma-returning function in @( ) or pipes it', { skip: !windows }, async t => {
  const r = await scan(t, RES);
  // the scan reads the real scripts: the functions the ruling names are among those it finds
  for (const name of ['Get-FleetRunProcesses', 'Get-ResidueCodes', 'New-Slots']) assert.ok(r.functions.includes(name), name);
  assert.deepEqual(r.wrong, [], r.wrong.join('\n'));
});
