param([Parameter(Mandatory)][string]$Scratch)
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Scratch){throw 'NEW_SCRATCH_REQUIRED'}
[void][IO.Directory]::CreateDirectory((Join-Path $Scratch 'install'))
[IO.File]::WriteAllText((Join-Path $Scratch 'install\install-receipt.json'),'{"residentManifestSha256":"'+('a'*64)+'"}')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'companion-headless.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'SOURCE_PARSE_ERROR'}
foreach($name in @('Invoke-CompanionAccountSwitch','Test-CompanionPendingMaintenance')){
 $function=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -CEQ $name)
 if($function.Count -ne 1){throw 'FUNCTION_COUNT'}
 . ([scriptblock]::Create($function[0].Extent.Text))
}
$count=0
function Yes([bool]$condition,[string]$label){if(-not $condition){throw $label};$script:count++}
$script:events=New-Object Collections.Generic.List[string]
$script:scenario='denied';$script:pending=$null;$script:recordStage='forgotten'
$CompanionPendingFile='install\pending-fixture.json'
$script:CompanionRegistrarExe=$null
function Assert-CompanionMaintenanceEntry {
 param($Root,$TargetVhdxPath,$CompanionSid,$ContextFile,$ExpectedContextSha256)
 $script:events.Add('entry')
 if($script:scenario -ceq 'denied'){throw 'FIXTURE_ENTRY_DENIED'}
 [pscustomobject]@{operationId=('b'*64)}
}
function Read-CompanionPending { $script:events.Add('read-pending');$script:pending }
function Test-CompanionPendingOwnerAlive { $false }
function Read-CompanionWslRecord { $null }
function New-CompanionBuild { $script:events.Add('build');@{generation='fixture';directory=$Scratch;registrar=@{sourceSha256=('c'*64);sha256=('d'*64);exe='FIXTURE_NOT_EXECUTED.exe'}} }
function Remove-CompanionBuild { $script:events.Add('cleanup') }
function Get-CompanionAccountFacts { @{} }
function Get-CompanionDomainCredsDisabled { 0 }
function Get-LockoutPolicy { @{} }
function Get-CompanionRelayParentsProblem { $null }
function Get-CompanionAccountPreflight { @{refusals=@()} }
function Register-CompanionFallbackTask { $script:events.Add('register-fallback') }
function Write-CompanionPending { $script:events.Add('write-pending') }
function Get-CompanionProcessTree { @{supervisors=@();children=@()} }
function Wait-CompanionTaskNotRunning { }
function Stop-CompanionTask { throw 'UNEXPECTED_STOP_TASK' }
function Invoke-CompanionStopAndFallback { throw 'UNEXPECTED_FORCED_FALLBACK' }
function Invoke-CompanionFallback { throw 'UNEXPECTED_FALLBACK' }
function Invoke-CompanionWslMove {
 $script:events.Add('move')
 if($script:scenario -ceq 'move-failed'){throw 'WSL_FIXTURE_MOVE_FAILED'}
 [ordered]@{stage=$script:recordStage;target=(Join-Path $Scratch 'data\ext4.vhdx');ownerRegistration=$null}
}
function Invoke-CompanionRegistrar {
 if($script:scenario -ceq 'registrar-failed'){'{"code":"FIXTURE_REGISTRAR_FAILED"}'}else{'{"code":"REGISTERED"}'}
}
function Invoke-CompanionWslImportTask { 3 }
function ConvertTo-CompanionOrdered($value) { $value }
function Remove-CompanionOwnerRegistration { throw 'FIXTURE_FORGET_FAILED' }
function Start-CompanionTask { $script:events.Add('start-companion') }
function Wait-CompanionQualified { if($script:scenario -cne 'qualified'){'FIXTURE_NOT_QUALIFIED'} }
function Get-CompanionTaskFacts { [pscustomobject]@{mode='password'} }
function Write-CompanionWslRecord { $script:events.Add('write-qualified') }
function Remove-CompanionFallbackTask { $script:events.Add('remove-fallback') }
function Complete-CompanionMaintenanceQualification { $script:events.Add('qualification-proof') }
$node=[pscustomobject]@{ownerSid='S-1-5-21-1-2-3-1008';wslDistribution='FixtureDistro'}
$bound=@{MaintenanceContextFile='C:\fixture\context.json';ExpectedMaintenanceContextSha256=('e'*64);AllowWslVmShutdown=$true}
$denied=$false;try{Invoke-CompanionAccountSwitch $Scratch $node (Join-Path $Scratch 'data') 'account' @bound|Out-Null}catch{$denied=$_.Exception.Message -ceq 'FIXTURE_ENTRY_DENIED'}
Yes ($denied -and ($script:events -join ',') -ceq 'entry') 'ENTRY_DENIAL_PRECEDES_ALL_READS_AND_EFFECTS'
$script:events.Clear();$script:scenario='pending';$script:pending=[pscustomobject]@{maintenanceOperationId=('b'*64)}
$result=Invoke-CompanionAccountSwitch $Scratch $node (Join-Path $Scratch 'data') 'account' @bound
Yes ($result.manualRecovery -and -not $result.fellBack -and -not $script:events.Contains('build')) 'CONTEXT_PENDING_NEVER_FORCES_FALLBACK'
$script:events.Clear()
$result=Invoke-CompanionAccountSwitch $Scratch $node (Join-Path $Scratch 'data') 'account'
Yes ($result.manualRecovery -and -not $result.fellBack -and -not $script:events.Contains('build')) 'LEGACY_CANNOT_FORCE_MAINTENANCE_PENDING'
$script:pending=$null
foreach($case in @('move-failed','registrar-failed','import-failed','forget-failed','qualification-failed')){
 $script:events.Clear();$script:scenario=$case
 $script:recordStage=if($case -ceq 'import-failed'){'moved'}elseif($case -ceq 'forget-failed'){'imported'}else{'forgotten'}
 $result=Invoke-CompanionAccountSwitch $Scratch $node (Join-Path $Scratch 'data') 'account' @bound
 Yes ($result.manualRecovery -and -not $result.fellBack -and -not $result.qualified -and $script:events.Contains('cleanup')) ('NO_FORCE_OR_FALLBACK_ON_'+$case)
}
$script:events.Clear();$script:scenario='qualified';$script:recordStage='forgotten'
$result=Invoke-CompanionAccountSwitch $Scratch $node (Join-Path $Scratch 'data') 'account' @bound
Yes ($result.qualified -and -not $result.fellBack) 'QUALIFIED_RESULT_REQUIRES_PROOF_HOOK'
Yes ($script:events.IndexOf('write-qualified') -lt $script:events.IndexOf('remove-fallback') -and $script:events.IndexOf('remove-fallback') -lt $script:events.IndexOf('qualification-proof')) 'PROOF_AFTER_QUALIFIED_RECORD_AND_PENDING_CLEANUP'
$fallbackAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'companion-headless-fallback.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'FALLBACK_PARSE_ERROR'}
$dispatch=@($fallbackAst.FindAll({param($node)$node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if ($maintenanceHold -or')},$true))
if($dispatch.Count -ne 1){throw 'FALLBACK_DISPATCH_COUNT'}
$dispatchCode=[scriptblock]::Create($dispatch[0].Extent.Text)
foreach($marker in @([pscustomobject]@{unreadable=$true},[pscustomobject]@{maintenanceOperationId=('b'*64)})){
 $maintenanceHold=($marker.PSObject.Properties.Name -contains 'unreadable');$pending=$marker;$did='nothing'
 . $dispatchCode
 Yes ($did -ceq 'maintenance-manual-recovery-held') 'SYSTEM_FALLBACK_HOLDS_DURABLE_OR_MARKED_MAINTENANCE'
}
$maintenanceHold=$false;$pending=$null;$did='nothing';$script:events.Clear()
. $dispatchCode
Yes ($did -ceq 'no-marker' -and ($script:events -join ',') -ceq 'remove-fallback') 'SYSTEM_FALLBACK_LEGACY_NO_MARKER_STILL_REMOVES_TASK'
[ordered]@{status='MAINTENANCE_SWITCH_OFFLINE_PASS';assertions=$count;scmTaskWslEffects=0;scope=$Scratch}|ConvertTo-Json -Compress
