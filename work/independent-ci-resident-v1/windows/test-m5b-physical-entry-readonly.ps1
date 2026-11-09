# Read-only tests: AST-load pure validators and Native read guards only.
# Never invoke the wrapper main, an executable, an ACL setter, WSL or a task.
[CmdletBinding()]
param([switch]$ActualReceipt)
$ErrorActionPreference='Stop'
$wrapper=Join-Path $PSScriptRoot 'start-m5b-physical-import-reviewed.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($wrapper,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'WRAPPER_PARSE_FAILED'}
$text=[IO.File]::ReadAllText($wrapper)
function Load-Function($tree,[string]$name){
  $found=@($tree.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object{$_.Name -ceq $name})
  if($found.Count -ne 1){throw "FUNCTION_NOT_UNIQUE:$name"}
  . ([scriptblock]::Create($found[0].Extent.Text))
  Set-Item -LiteralPath ('Function:script:'+$name) -Value (Get-Item -LiteralPath ('Function:'+$name)).ScriptBlock
}
foreach($name in @('Hash-Bytes','Assert-ExactDirectoryDacl','Assert-SeedDirectoryDacl','Convert-EntryJson','Assert-MapFields','Assert-SeedMarker','Assert-OriginalPreflightFailure','Open-VerifiedEntry','Open-VerifiedRead','Read-VerifiedBytes','Hash-Stream','Native')){Load-Function $ast $name}
# Only constant declarations needed by the pure validators; no main statements.
foreach($name in @('owner','sourceHash','targetRoot','seedHash','registrarHash','harnessHash','seedRoot','seedFile','seedLength','rootfsInputHash','buildRoot','exe','executableHash','sddl','seedSddl','buildSddl')){
  $assignment=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq ('$'+$name)})
  if($assignment.Count -ne 1){throw "CONSTANT_NOT_UNIQUE:$name"}
  . ([scriptblock]::Create($assignment[0].Extent.Text))
}
$count=0
function Check([string]$name,[scriptblock]$body){& $body;$script:count++;Write-Output ('PASS '+$name)}
function Refuses([scriptblock]$body,[string]$code){try{& $body}catch{if($_.Exception.Message -ceq $code){return};throw};throw ('DID_NOT_REFUSE:'+ $code)}
function Json($value){Convert-EntryJson ([Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 10 -Compress)))}
Check 'exact receipt ACL accepted' {Assert-ExactDirectoryDacl $sddl $sddl @('S-1-5-32-544') 'ACL'}
Check 'owner cannot grant itself receipt trust' {Refuses {Assert-ExactDirectoryDacl ($sddl.Replace('O:BA',('O:'+$owner))) $sddl @('S-1-5-32-544') 'ACL'} 'ACL'}
Check 'unprotected receipt rejected' {Refuses {Assert-ExactDirectoryDacl ($sddl.Replace('D:P','D:')) $sddl @('S-1-5-32-544') 'ACL'} 'ACL'}
Check 'extra outsider reader rejected' {Refuses {Assert-ExactDirectoryDacl ($sddl+'(A;OICI;GR;;;BU)') $sddl @('S-1-5-32-544') 'ACL'} 'ACL'}
Check 'extra outsider writer rejected' {Refuses {Assert-ExactDirectoryDacl ($sddl+'(A;OICI;FA;;;BU)') $sddl @('S-1-5-32-544') 'ACL'} 'ACL'}
Check 'owner full access rejected on protected receipt' {Refuses {Assert-ExactDirectoryDacl ($sddl.Replace('0x1200a9','FA')) $sddl @('S-1-5-32-544') 'ACL'} 'ACL'}
Check 'missing administrator ACE rejected' {Refuses {Assert-ExactDirectoryDacl ($sddl.Replace('(A;OICI;FA;;;BA)','')) $sddl @('S-1-5-32-544') 'ACL'} 'ACL'}
Check 'noninheriting receipt ACE rejected' {Refuses {Assert-ExactDirectoryDacl ($sddl.Replace('OICI','OI')) $sddl @('S-1-5-32-544') 'ACL'} 'ACL'}
$originalSeed='O:'+$owner+'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;'+$owner+')'
Check 'original disposable seed ACL accepted' {Assert-SeedDirectoryDacl $originalSeed}
Check 'hardened disposable seed ACL accepted' {Assert-SeedDirectoryDacl $seedSddl}
Check 'outsider seed owner rejected' {Refuses {Assert-SeedDirectoryDacl ($originalSeed.Replace(('O:'+$owner),'O:BU'))} 'ENTRY_SEED_ACL_REFUSED'}
Check 'outsider seed write rejected' {Refuses {Assert-SeedDirectoryDacl ($originalSeed+'(A;OICI;FA;;;BU)')} 'ENTRY_SEED_ACL_REFUSED'}
Check 'hardened seed with user owner rejected' {Refuses {Assert-SeedDirectoryDacl ($seedSddl.Replace('O:BA',('O:'+$owner)))} 'ENTRY_SEED_ACL_REFUSED'}
$marker=@{contract='clued.m5b.physical-seed/1';distro='CluedM5bSeed1109';root=$seedRoot;inputSha256=$rootfsInputHash}
Check 'seed creation subject accepted' {Assert-SeedMarker (Json $marker)}
foreach($field in @('contract','distro','root','inputSha256')){
  Check ('seed wrong '+$field+' rejected') {$bad=$marker.Clone();$bad[$field]='other';Refuses {Assert-SeedMarker (Json $bad)} 'ENTRY_SEED_MARKER_REFUSED'}
}
Check 'seed marker array field rejected' {$bad=$marker.Clone();$bad.root=@($seedRoot);Refuses {Assert-SeedMarker (Json $bad)} 'ENTRY_SEED_MARKER_REFUSED'}
Check 'JSON singleton array rejected' {Refuses {Convert-EntryJson ([Text.Encoding]::UTF8.GetBytes('[{"status":"STARTED"}]'))} 'ENTRY_JSON_OBJECT_REQUIRED'}
Check 'bad JSON rejected' {try{Convert-EntryJson ([Text.Encoding]::UTF8.GetBytes('{'));throw 'JSON_WAS_ACCEPTED'}catch{if($_.Exception.Message -ceq 'JSON_WAS_ACCEPTED'){throw}}}
function Fixture {
  $started=Json @{status='STARTED';psSha256=$sourceHash;registrarSha256=$registrarHash;harnessSha256=$harnessHash;seedSha256=$seedHash}
  $finished=Json @{contract='clued.m5b.physical-entry/1';childExitCode=1;targetRoot=$targetRoot;formalSupervisorQualified=$false;evidenceStatus='EVIDENCE_ROOT_ABSENT'}
  $failure=Json @{status='FAILED_PRESERVED_NO_RETRY';phase='preflight';code='PARENT_OWNER_OR_DACL_REFUSED';exceptionType='Refusal';hresult='0x80131500';evidenceRoot=$targetRoot}
  $compiled=Json @{status='RUN_IMPORT_FAILED_PRESERVED';buildRoot=$buildRoot;executable=$exe;registrarSha256=$registrarHash;harnessSha256=$harnessHash;executableSha256=$executableHash;account='clued-m5b-1109';taskFolder='\CluedM5bPhysical1109';distro='CluedM5bPhysical1109';targetRoot=$targetRoot;seed=$seedFile;effectsExecuted=$true;formalSupervisorQualified=$false;rawExitCode=1;output=($buildRoot+'\run-import.log')}
  return @{started=$started;finished=$finished;lines=@($failure,$compiled)}
}
Check 'exact original failure proof accepted' {$f=Fixture;Assert-OriginalPreflightFailure $f.started $f.finished $f.lines}
Check 'extra output line refused' {$f=Fixture;Refuses {Assert-OriginalPreflightFailure $f.started $f.finished ($f.lines+@(@{}))} 'ENTRY_RETRY_STDOUT_NOT_EXACT_PREFLIGHT'}
foreach($field in @('psSha256','registrarSha256','harnessSha256','seedSha256')){
  Check ('started '+$field+' tamper refused') {$f=Fixture;$f.started[$field]='bad';Refuses {Assert-OriginalPreflightFailure $f.started $f.finished $f.lines} 'ENTRY_RETRY_STARTED_SUBJECT_REFUSED'}
}
foreach($field in @('phase','code','exceptionType','hresult','evidenceRoot')){
  Check ('failure '+$field+' tamper refused') {$f=Fixture;$f.lines[0][$field]='bad';Refuses {Assert-OriginalPreflightFailure $f.started $f.finished $f.lines} 'ENTRY_RETRY_FAILURE_NOT_EXACT_PREFLIGHT'}
}
foreach($field in @('buildRoot','executable','executableSha256','registrarSha256','harnessSha256','account','taskFolder','distro','targetRoot','seed','output')){
  Check ('compiled '+$field+' tamper refused') {$f=Fixture;$f.lines[1][$field]='bad';Refuses {Assert-OriginalPreflightFailure $f.started $f.finished $f.lines} 'ENTRY_RETRY_COMPILED_SUBJECT_REFUSED'}
}
Check 'finished success refused' {$f=Fixture;$f.finished.childExitCode=0;Refuses {Assert-OriginalPreflightFailure $f.started $f.finished $f.lines} 'ENTRY_RETRY_FINISHED_NOT_PREFLIGHT_FAILURE'}
Check 'finished unknown evidence refused' {$f=Fixture;$f.finished.evidenceStatus='EVIDENCE_ROOT_UNTRUSTED_NO_CONTENT_READ';Refuses {Assert-OriginalPreflightFailure $f.started $f.finished $f.lines} 'ENTRY_RETRY_FINISHED_NOT_PREFLIGHT_FAILURE'}
Check 'string exit code refused' {$f=Fixture;$f.lines[1].rawExitCode='1';Refuses {Assert-OriginalPreflightFailure $f.started $f.finished $f.lines} 'ENTRY_RETRY_COMPILED_SUBJECT_REFUSED'}
Check 'array exit code refused' {$f=Fixture;$f.lines[1].rawExitCode=@(1);Refuses {Assert-OriginalPreflightFailure $f.started $f.finished $f.lines} 'ENTRY_RETRY_COMPILED_SUBJECT_REFUSED'}
Check 'string false refused' {$f=Fixture;$f.finished.formalSupervisorQualified='false';Refuses {Assert-OriginalPreflightFailure $f.started $f.finished $f.lines} 'ENTRY_RETRY_FINISHED_NOT_PREFLIGHT_FAILURE'}
# Real file/anchor reads exercise final-path and native handle guards. Extract
# only the existing P/Invoke declarations, never the source/read/main sequence.
$nativeBegin=$text.IndexOf('$assemblyName = New-Object Reflection.AssemblyName')
$nativeEnd=$text.IndexOf('function Native(')
. ([scriptblock]::Create($text.Substring($nativeBegin,$nativeEnd-$nativeBegin)))
$sourceAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'test-m5b-physical-import.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'SOURCE_PARSE_FAILED'}
$trustedSids=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
foreach($name in @('Assert-Plain','Assert-TrustedAnchor','Test-Entry')){Load-Function $sourceAst $name}
Check 'real C and ProgramData anchors trusted read-only' {Assert-TrustedAnchor 'C:\';Assert-TrustedAnchor 'C:\ProgramData'}
Check 'real wrapper held read final path and SHA verified' {$actual=Read-VerifiedBytes $wrapper 1048576;if((Hash-Bytes $actual) -cne (Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'NATIVE_BYTES_MISMATCH'}}
Check 'real directory handle final path verified' {$handle=Open-VerifiedEntry $PSScriptRoot $true;try{if($handle.IsInvalid){throw 'INVALID_HANDLE'}}finally{$handle.Dispose()}}
Check 'real file mistaken as directory refused' {Refuses {Open-VerifiedEntry $wrapper $true} 'PATH_NOT_PLAIN'}
Check 'real read maximum enforced' {Refuses {Read-VerifiedBytes $wrapper 1} 'ENTRY_INPUT_SIZE_REFUSED'}
Check 'retry marker create-new and validation ordering retained' {
  $proof=$text.IndexOf('Assert-OriginalPreflightFailure (Convert-EntryJson $startedBytes)')
  $once=$text.IndexOf("Write-New (Join-Path `$root 'retry-preflight.started.json')")
  $protect=$text.IndexOf('$seedAfter=Protect-ValidatedSeedDirectory')
  if($proof -lt 0 -or $once -le $proof -or $protect -le $once -or -not $text.Contains("[IO.File]::Open(`$Path,'CreateNew'")){throw 'ONCE_ORDER_REGRESSED'}
}
if($ActualReceipt){
  Check 'actual seed directory original ACL admitted read-only' {Assert-SeedDirectoryDacl ((Get-Acl -LiteralPath $seedRoot).Sddl)}
  Check 'actual seed creation marker subject admitted read-only' {Assert-SeedMarker (Convert-EntryJson (Read-VerifiedBytes ($seedRoot+'\created.json') 16384))}
  Check 'actual seed length and content match fixed input read-only' {$held=Open-VerifiedRead $seedFile 2147483648;try{if($held.Length -ne $seedLength -or (Hash-Stream $held) -cne $seedHash){throw 'ACTUAL_SEED_CHANGED'}}finally{$held.Dispose()}}
  Check 'actual protected original receipt proof admitted read-only' {
    $receipt='C:\ProgramData\CluedM5bPhysicalReceipt1109'
    Assert-ExactDirectoryDacl ((Get-Acl -LiteralPath $receipt).Sddl) $sddl @('S-1-5-32-544') 'ACTUAL_RECEIPT_UNTRUSTED'
    $started=Convert-EntryJson (Read-VerifiedBytes ($receipt+'\started.json'))
    $finished=Convert-EntryJson (Read-VerifiedBytes ($receipt+'\finished.json'))
    $output=[Text.Encoding]::UTF8.GetString((Read-VerifiedBytes ($receipt+'\stdout.log')))
    $lines=@();foreach($line in @($output -split '\r?\n'|Where-Object{$_.Length -gt 0})){$lines+=,(Convert-EntryJson ([Text.Encoding]::UTF8.GetBytes($line)))}
    Assert-OriginalPreflightFailure $started $finished $lines
    if((Read-VerifiedBytes ($receipt+'\stderr.log')).Length -ne 0 -or (Hash-Bytes (Read-VerifiedBytes ($receipt+'\reviewed-entry.ps1'))) -cne $sourceHash){throw 'ACTUAL_RECEIPT_CONTENT_CHANGED'}
  }
}
Write-Output ('TOTAL_PASS='+$count)
Write-Output ('WRAPPER_SHA256='+(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant())
