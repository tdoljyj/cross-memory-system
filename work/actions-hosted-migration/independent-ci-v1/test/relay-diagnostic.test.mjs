import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const relayUrl=new URL('../worker/protected-job-bridge-v4/relay-public.ps1',import.meta.url);
const phases=['SOURCE','SPOOL','CLIENT','START','TRANSFER','RESULT'];

test('failure diagnostics mark six bounded phases without changing the refusal or terminal gates',async()=>{
  const source=(await fs.readFile(relayUrl,'utf8')).replaceAll('\r\n','\n');
  assert.deepEqual([...source.matchAll(/^  \$phase='([A-Z]+)'$/gm)].map(m=>m[1]),phases);
  const boundaries=["if($FixedSource -cnotmatch",'Hold-Parents $Spool;','$WslClient=Get-CluedMachineWslClient','$proc=New-Object Diagnostics.Process;', '$ot=[CluedFormalRelayIO]::Read', '$v=$stdout|ConvertFrom-Json'];
  for(let i=0;i<phases.length;i++){
    const at=source.indexOf(`  $phase='${phases[i]}'`),effect=source.indexOf(boundaries[i],at);
    assert.ok(effect>at&&(!phases[i+1]||effect<source.indexOf(`  $phase='${phases[i+1]}'`)),phases[i]);
  }
  assert.ok(source.includes("$result.failureCode=if($id -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$id}else{'PUBLIC_TRANSFER_UNCONFIRMED'};"));
  assert.ok(source.includes("if(-not $proc.WaitForExit(90000)){throw 'PUBLIC_TERMINAL_UNCONFIRMED_LOCKS_RETAINED'}"));
  assert.ok(source.includes("if($started -and -not $terminal){$result.status='UNCERTAIN_LOCKS_RETAINED_NO_RETRY'"));
  assert.equal((source.match(/Get-RelayFailureDiagnostic \$_ \$phase/g)??[]).length,1);
});

test('actual PowerShell 5 exceptions produce only fixed diagnostics, including wrapped IO and hostile messages', {skip:process.platform!=='win32'},()=>{
  const file=fileURLToPath(relayUrl).replaceAll("'","''");
  const script=`
    $ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
    $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'RELAY_PARSE_FAILED'}
    $functions=@($ast.FindAll({param($a)$a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq 'Get-RelayFailureDiagnostic'},$true))
    if($functions.Count -ne 1){throw 'DIAGNOSTIC_FUNCTION_REQUIRED'}
    . ([scriptblock]::Create($functions[0].Extent.Text))
    $secret='C:\\Users\\private-user\\private-value.token Bearer-private-value'
    $rows=@()
    try{[void][IO.File]::Open((Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N')+'.missing')),'Open','Read')}catch{$io=$_}
    $rows+=Get-RelayFailureDiagnostic $io 'SOURCE'
    $actions=@(
      {throw (New-Object UnauthorizedAccessException($secret))},
      {throw (New-Object Security.SecurityException($secret))},
      {[void][Array]::CreateInstance([int],-1)},
      {throw (New-Object InvalidOperationException($secret))},
      {throw (New-Object ComponentModel.Win32Exception(5,$secret))},
      {throw (New-Object Exception($secret))},
      {throw (New-Object Reflection.TargetInvocationException($secret,(New-Object IO.IOException($secret))))}
    )
    foreach($action in $actions){try{& $action;throw 'EXPECTED_LOCAL_EXCEPTION'}catch{$rows+=Get-RelayFailureDiagnostic $_ 'START'}}
    $allPhases=@();foreach($p in @('SOURCE','SPOOL','CLIENT','START','TRANSFER','RESULT')){$allPhases+=Get-RelayFailureDiagnostic $io $p}
    $unknown=Get-RelayFailureDiagnostic $io $secret;$none=Get-RelayFailureDiagnostic $null 'SOURCE'
    $initial=@($ast.FindAll({param($a)$a -is [Management.Automation.Language.AssignmentStatementAst] -and $a.Left.Extent.Text -ceq '$result'},$false))
    if($initial.Count -ne 1){throw 'INITIAL_RECEIPT_REQUIRED'}
    $Mode='SendIssue';$Sequence=0;$ExpectedBundleSha256='a'*64
    $receipt=Invoke-Expression $initial[0].Right.Extent.Text
    $successDefaults=@($receipt.failurePhase,$receipt.exceptionCategory,$receipt.exceptionHResult)
    $main=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.TryStatementAst] -and $_.Body.Extent.Text.Contains('FIXED_SOURCE_LOCATION_REQUIRED')})
    if($main.Count -ne 1 -or $main[0].CatchClauses.Count -ne 1){throw 'MAIN_CATCH_REQUIRED'}
    $wiring=@();$phase='START'
    foreach($action in @({throw (New-Object IO.IOException($secret))},{throw 'PUBLIC_READY_CHANGED'})){
      $result=Invoke-Expression $initial[0].Right.Extent.Text
      & ([scriptblock]::Create('try { & $action } catch '+$main[0].CatchClauses[0].Body.Extent.Text))
      $wiring+=[ordered]@{failureCode=$result.failureCode;failurePhase=$result.failurePhase;exceptionCategory=$result.exceptionCategory;exceptionHResult=$result.exceptionHResult}
    }
    [ordered]@{rows=$rows;phases=$allPhases;unknown=$unknown;none=$none;successDefaults=$successDefaults;wiring=$wiring}|ConvertTo-Json -Depth 6 -Compress
  `;
  const output=execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true});
  assert.equal(output.includes('private-user'),false);assert.equal(output.includes('private-value'),false);
  const actual=JSON.parse(output);
  assert.deepEqual(actual.rows.map(r=>r.exceptionCategory),['IO','ACCESS','SECURITY','ARGUMENT','INVALID_OPERATION','WIN32','OTHER','IO']);
  assert.equal(actual.rows[0].exceptionHResult,-2147024894,'actual FileNotFoundException HRESULT');
  for(const row of [...actual.rows,...actual.phases,actual.unknown]){
    assert.deepEqual(Object.keys(row),['failurePhase','exceptionCategory','exceptionHResult']);
    assert.ok(Number.isInteger(row.exceptionHResult)&&row.exceptionHResult>=-2147483648&&row.exceptionHResult<=2147483647);
  }
  assert.deepEqual(actual.phases.map(r=>r.failurePhase),phases);
  assert.equal(actual.unknown.failurePhase,null);
  assert.deepEqual(actual.none,{failurePhase:null,exceptionCategory:null,exceptionHResult:null});
  assert.deepEqual(actual.successDefaults,[null,null,null]);
  assert.deepEqual(actual.wiring.map(r=>[r.failureCode,r.failurePhase,r.exceptionCategory]),[['PUBLIC_TRANSFER_UNCONFIRMED','START','IO'],['PUBLIC_READY_CHANGED','START','OTHER']]);
});
