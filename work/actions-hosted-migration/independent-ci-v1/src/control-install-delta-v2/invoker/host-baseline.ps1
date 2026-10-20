# Definitions only; predecessors' main blocks are never executed.
$InstallRoot='C:\ProgramData\CluedControl';$AccountName='clued-control';$RunnerName='clued-ci-home-win-02'
$ServiceName='actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02';$Repository='tdoljyj/cross-memory-system'
$OwnerSid='S-1-5-21-1173730660-3877291096-655431861-1001';$ExpectedControllerSid='S-1-5-21-1173730660-3877291096-655431861-1015'
$ExpectedManifest='566cbde78dc482690f15bddfcc6b5440ab340d460d0816e644b668e2f2b71a02';$ExpectedInstaller='f20e4153001dce200dee8ab9761e1a0cca88722a240a739c8f4f047bf6ca8cd2'
$ZipSha256='1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc';$ListenerSha256='72c36cc15e21605dc4adc7c280e7ad9ea524fc8f1fb7b6905d3e0ae7df7a5de3';$ServiceExeSha256='9cdb1f126072ad53d877165a2c62d966374d3577a135d295cca4cc97b5417a9f'
$OriginalBinary='"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"'
$ExpectedStable='1f3595231dad355084f441e8b84b978e2204346f6b294009ff004aa5f07f59e0'
$ExpectedNode='ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'
$NodePath='C:\Program Files\nodejs\node.exe';$GitDirectory='C:\Program Files\Git\cmd';$BashDirectory='C:\Program Files\Git\bin'
$KeyTarget='C:\ProgramData\CluedControl\trusted\controller-checks-app.pem';$ReadOnlyKeyTarget='C:\ProgramData\CluedControl\trusted\controller-readonly-app.pem'
$ControllerWorkDirectory=Join-Path $MigrationRoot 'stagec\first-free-install\controller';$BundleDirectory=Join-Path $ControllerWorkDirectory 'bundle-v1'
$RuntimeFiles=@('trusted/controller-job-started.ps1','trusted/controller-job-started.mjs','trusted/controller-policy.json','trusted/upstream/clued-runner-job-started.mjs');$RequiredFiles=@('install-controller.ps1')+$RuntimeFiles
$HelperNames=@('Assert-NoReparse','Get-Sha256','Read-LockedBytes','Get-BytesSha256','Convert-ReviewedJson','Assert-ParentAcl','Assert-TrustedParentChain')
function Pinned-Functions([string]$Relative,[string]$Hash,[string[]]$Names){
 $bytes=Read-PublicWork (Join-Path $ControllerWorkDirectory $Relative) 1MB
 if((Public-Hash $bytes) -cne $Hash){throw 'FROZEN_BASELINE_HELPER_PIN_REFUSED'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput((New-Object Text.UTF8Encoding($false,$true)).GetString($bytes),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'FROZEN_BASELINE_PARSE_REFUSED'}
 foreach($name in $Names){$functions=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name});if($functions.Count -ne 1){throw 'EXACT_BASELINE_DEFINITION_REQUIRED'};$functions[0].Extent.Text}
}
function Get-BaselineDefinitions {
 Pinned-Functions 'provision-key-v3\provision-readonly-key.ps1' '6996fc6a42912169d735ab86cb6b86a9c7558b3ea5cdcd275fc40d3ce7706fdf' @('Read-WorkBytes','Get-WorkHash','Assert-WorkNoReparse','Get-ReviewedHelpers','Assert-ReviewedBundle','Assert-OwnerEnvironment','Get-CanonicalLocalServiceAccountSid','Assert-BoundLocalServiceLogon','Assert-AccountAndStoppedService','Assert-PublicRunnerIdentity','Assert-NodeTrust','Assert-KeyTargetSecurity')
 $tree=Pinned-Functions 'tree-verifier-recovery-v1\tree-verifier.ps1' 'c7dc91114b062517530f08b215f39c1d2be1a632b7282d47c0953a7fd913a1a6' @('Assert-InstalledTreeWithReadOnlyKey')
 $needle='if($full -ceq $KeyTarget){Assert-KeyTargetSecurity $acl $ExpectedControllerSid}'
 if(-not $tree.Contains($needle)){throw 'EXACT_TWO_EXISTING_KEY_TREE_ADAPTATION_REQUIRED'}
 $tree.Replace($needle,'if($full -cin @($KeyTarget,$ReadOnlyKeyTarget)){Assert-KeyTargetSecurity $acl $ExpectedControllerSid}')
}
function Assert-CurrentOriginalHost($Manifest){
 Assert-OwnerEnvironment;$receipt.actual_host_read=$true;Assert-TrustedParentChain 'C:\ProgramData';Assert-AccountAndStoppedService
 Assert-InstalledTreeWithReadOnlyKey
 $stage5=Read-PublicWork (Join-Path $ControllerWorkDirectory 'guard-stage-v5\receipts\Stage-20261018T111218688Z-be054c6b39a24fcbaaa1a884bace7116.json') 1MB
 if((Public-Hash $stage5) -cne '2bcebeb616e8b366d87fdcd60a0433209342e34c056f963a7c83c8d44d992d29'){throw 'REAL_ACCEPTED_STAGE5_RECEIPT_REQUIRED'}
 $oldKey=$ReadOnlyKeyTarget
 foreach($relative in $RuntimeFiles){$expected=$Manifest.files.$relative;if($relative -ceq 'trusted/controller-job-started.mjs'){$expected='2b7b6deb4db376aae43674f055f063ec792dd20a3e4e15dbe1f676089e762d61'}
  $bytes=Read-LockedBytes (Join-Path $InstallRoot ($relative.Replace('/','\'))) 8MB
  if((Get-BytesSha256 $bytes) -cne $expected){throw 'EXACT_ACCEPTED_INSTALLED_RUNTIME_REQUIRED'}
  if($relative -ceq 'trusted/controller-policy.json'){$policy=Convert-ReviewedJson $bytes;if($policy.qualification -cne 'UNQUALIFIED' -or $policy.repository -cne $Repository -or $null -ne $policy.principal_sid -or $null -ne $policy.runner.id -or $null -ne $policy.readonly_app.id -or $policy.readonly_app.key_file -cne $oldKey){throw 'UNCHANGED_UNQUALIFIED_POLICY_REQUIRED'}}
 }
 if((Get-Sha256 (Join-Path $InstallRoot 'runner-package.zip')) -cne $ZipSha256 -or (Get-Sha256 (Join-Path $InstallRoot 'runner\bin\Runner.Listener.exe')) -cne $ListenerSha256 -or (Get-Sha256 (Join-Path $InstallRoot 'runner\bin\RunnerService.exe')) -cne $ServiceExeSha256){throw 'ORIGINAL_RUNNER_PUBLIC_HASHES_REQUIRED'}
 Assert-PublicRunnerIdentity;Assert-NodeTrust
 if((Get-Sha256 $NodePath) -cne $ExpectedNode){throw 'EXACT_OWNER_OBSERVED_NODE_HASH_REQUIRED'}
 foreach($key in @($KeyTarget,$ReadOnlyKeyTarget)){$h=[VerifyInstallFiles]::HoldMetadata($key,$false);$held.Add($h);$m=[VerifyInstallFiles]::Metadata($h);if($m.SizeHigh -ne 0 -or $m.SizeLow -lt 1000 -or $m.SizeLow -gt 16384){throw 'EXISTING_KEY_METADATA_SIZE_REFUSED'};$a=New-Object Security.AccessControl.FileSecurity;$a.SetSecurityDescriptorBinaryForm([VerifyInstallFiles]::Security($h));Assert-KeyTargetSecurity $a $ExpectedControllerSid}
 $snapshot=[CluedSession0ScmV2]::ReadSnapshot();[CluedSession0ScmV2]::AssertExpected($snapshot,$OriginalBinary,$ExpectedStable,$true)
 return $snapshot
}
