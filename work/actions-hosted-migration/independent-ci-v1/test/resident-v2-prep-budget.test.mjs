// Windows-only behaviour is exercised through the production PowerShell AST,
// without its main block, network access or installed/production directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../src/resident-v2/build-bundle.ps1', import.meta.url));
const text = fs.readFileSync(tool, 'utf8');
function runFunctions(names, body) {
  const code = `$ErrorActionPreference='Stop';Set-StrictMode -Version 2
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:BUNDLE_TEST_TOOL,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PARSE_FAILED'}
foreach($name in @(${names.map(name => `'${name}'`).join(',')})){
 $f=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name})
 if($f.Count -ne 1){throw ('FUNCTION_MISSING:'+$name)}
 . ([scriptblock]::Create($f[0].Extent.Text))
}
${body}`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(code, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, BUNDLE_TEST_TOOL: tool },
  }));
}

test('prep process budget: 500 valid refs use one batch query on LF and CRLF output', { skip: process.platform !== 'win32' }, () => {
  const rows = runFunctions(['New-RefMap', 'Ref-Target-Types'], `
$Common=@();$refs=New-RefMap
foreach($n in 1..500){$refs[('refs/heads/test-'+$n)]=$n.ToString('x40')}
$refs['refs/heads/duplicate']=$refs['refs/heads/test-1']
$results=@()
foreach($ending in @("\u0060n","\u0060r\u0060n")){
 $script:calls=0
 function Invoke-Git($label,$argv,$inputText){
  $script:calls++
  return (($inputText.TrimEnd("\u0060n").Split([char]10)|ForEach-Object{$_+' commit 123'}) -join $ending)+$ending
 }
 $types=Ref-Target-Types '--git-dir=unused' $refs
 $results+=@{calls=$script:calls;types=$(if($null -eq $types){0}else{$types.Count})}
}
ConvertTo-Json -InputObject $results -Compress`);
  assert.deepEqual(rows, [{ calls: 1, types: 500 }, { calls: 1, types: 500 }]);
});

test('prep timing: full-fetch measurement ends before seed cleanup, remote reads and reviewed fetch', () => {
  const store = text.slice(text.indexOf('function Build-Store'), text.indexOf('function Retry-Allowed'));
  assert.match(store, /Invoke-Git 'fetch'[^\r\n]*\r?\n\s*\$fetchWatch\.Stop\(\);\$fetchCompletedAt=Utc/);
});

test('prep telemetry: real git success and failure are timed without retaining their output', { skip: process.platform !== 'win32' }, () => {
  const result = runFunctions(['Quote-Arg', 'Invoke-Git', 'Build-Timing'], `
$Git=(Get-Command git.exe).Source;$Root=Split-Path -Parent $env:BUNDLE_TEST_TOOL
$GitTimings=New-Object 'Collections.Generic.List[object]'
$version=Invoke-Git 'version' @('--version')
$reason=$null;try{$null=Invoke-Git 'invalid-option' @('--invalid-clued-timing-test')}catch{$reason=$_.Exception.Message}
@{version=$version.Trim();reason=$reason;timing=(Build-Timing 100)}|ConvertTo-Json -Depth 6 -Compress`);
  assert.match(result.version, /^git version /);
  assert.equal(result.reason, 'GIT_STEP_FAILED');
  assert.deepEqual(result.timing.steps.map(({ label, calls, failures }) => ({ label, calls, failures })), [
    { label: 'version', calls: 1, failures: 0 },
    { label: 'invalid-option', calls: 1, failures: 1 },
  ]);
  for (const step of result.timing.steps) {
    assert.ok(Number.isSafeInteger(step.ms) && step.ms >= 0);
    assert.deepEqual(Object.keys(step).sort(), ['calls', 'failures', 'label', 'ms']);
  }
});

test('prep time budget: exact boundary, retries aggregated, no command arguments or stderr in telemetry', { skip: process.platform !== 'win32' }, () => {
  const result = runFunctions(['Build-Timing'], `
$GitTimings=New-Object 'Collections.Generic.List[object]'
$GitTimings.Add([pscustomobject]@{label='fetch';ms=40000;exitCode=1})
$GitTimings.Add([pscustomobject]@{label='fetch';ms=20000;exitCode=0})
$GitTimings.Add([pscustomobject]@{label='bundle-create';ms=30000;exitCode=0})
@{at=(Build-Timing 90000);above=(Build-Timing 90001)}|ConvertTo-Json -Depth 6 -Compress`);
  assert.equal(result.at.budgetMs, 90_000);
  assert.equal(result.at.overBudget, false);
  assert.equal(result.above.overBudget, true);
  assert.equal(result.above.elapsedMs, 90_001);
  assert.deepEqual(result.above.steps, [
    { label: 'fetch', calls: 2, ms: 60_000, failures: 1 },
    { label: 'bundle-create', calls: 1, ms: 30_000, failures: 0 },
  ]);
  assert.match(text, /\$script:GitTimings\.Add\(/);
  assert.match(text, /timing=\(Build-Timing \$Clock\.Elapsed\.TotalMilliseconds\)/);
});

test('prep batch types: malformed, missing, reordered and failed answers retain the fallback', { skip: process.platform !== 'win32' }, () => {
  const refused = runFunctions(['New-RefMap', 'Ref-Target-Types'], `
$Common=@();$a='a'*40;$b='b'*40;$refs=New-RefMap;$refs['refs/heads/a']=$a;$refs['refs/heads/b']=$b
$results=@()
foreach($kind in @('missing','reordered','malformed','failed')){
 function Invoke-Git($label,$argv,$inputText){
  $shas=$inputText.TrimEnd("\u0060n").Split([char]10)
  switch($kind){
   'missing'{return ($shas[0]+' commit 1')}
   'reordered'{return ($shas[1]+" commit 1\u0060n"+$shas[0]+" commit 1\u0060n")}
   'malformed'{return ($shas[0]+" commit NaN\u0060n"+$shas[1]+" commit 1\u0060n")}
   'failed'{throw 'GIT_STEP_FAILED'}
  }
 }
 $results+=($null -eq (Ref-Target-Types '--git-dir=unused' $refs))
}
ConvertTo-Json -InputObject $results -Compress`);
  assert.deepEqual(refused, [true, true, true, true]);
});
