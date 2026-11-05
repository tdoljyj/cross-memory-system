# Function library only. COM definitions remain in memory; no file writes,
# registration, Run, UAC, token/credential access or environment enumeration.
function TaskDefinitionRequire([bool]$value,[string]$code){if(-not $value){throw $code}}
function TaskDefinitionArgs([string[]]$items){return ($items|ForEach-Object {if($_.Length -gt 0 -and $_ -notmatch '[\s"]'){$_}else{'"'+([regex]::Replace([regex]::Replace($_,'(\\*)"','$1$1\"'),'(\\+)$','$1$1'))+'"'}}) -join ' '}
function ResolveTaskPrincipalSid([string]$wire){
  try{if($wire -match '^S-\d-'){return [Security.Principal.SecurityIdentifier]::new($wire).Value};return [Security.Principal.NTAccount]::new($wire).Translate([Security.Principal.SecurityIdentifier]).Value}
  catch{throw [InvalidOperationException]::new('TASK_PRINCIPAL_SID_UNRESOLVED',$_.Exception)}
}
function NewExactProbeTaskDefinition($scheduler,[string]$taskName,[string]$expectedSid,[string]$executable,[string[]]$argumentList,[string]$workingDirectory){
  $d=$scheduler.NewTask(0)
  $d.RegistrationInfo.Description='Clued181 exact one-shot account qualification; no maintenance installation';$d.RegistrationInfo.Author='CluedOwnerAcceptedQualification181';$d.RegistrationInfo.URI='\'+$taskName
  $d.Principal.UserId=$expectedSid;$d.Principal.LogonType=2;$d.Principal.RunLevel=0
  $d.Settings.Enabled=$true;$d.Settings.AllowDemandStart=$true;$d.Settings.MultipleInstances=2;$d.Settings.ExecutionTimeLimit='PT3M';$d.Settings.DisallowStartIfOnBatteries=$false;$d.Settings.StopIfGoingOnBatteries=$false
  $action=$d.Actions.Create(0);$action.Path=$executable;$action.Arguments=TaskDefinitionArgs $argumentList;$action.WorkingDirectory=$workingDirectory;$d.Settings.RestartCount=0
  return $d
}
function GetExactProbeTaskChecks($definition,[string]$expectedSid,[string]$executable,[string[]]$argumentList,[string]$workingDirectory){
  $resolved=ResolveTaskPrincipalSid ([string]$definition.Principal.UserId)
  $xml=[xml]$definition.XmlText;$manager=[Xml.XmlNamespaceManager]::new($xml.NameTable);$manager.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
  $xmlId=$xml.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:UserId',$manager).InnerText
  $action=$null;if($definition.Actions.Count -eq 1){$action=$definition.Actions.Item(1)}
  return @{principal_sid_exact=($resolved -ceq $expectedSid);xml_principal_sid_literal_exact=($xmlId -ceq $expectedSid);triggers_zero=($definition.Triggers.Count -eq 0);actions_one=($definition.Actions.Count -eq 1);logon_s4u=([int]$definition.Principal.LogonType -eq 2);runlevel_least=([int]$definition.Principal.RunLevel -eq 0);restart_zero=($definition.Settings.RestartCount -eq 0);action_exec=($null -ne $action -and [int]$action.Type -eq 0);action_executable_exact=($null -ne $action -and $action.Path -ieq $executable);action_arguments_exact=($null -ne $action -and $action.Arguments -ceq (TaskDefinitionArgs $argumentList));working_directory_exact=($null -ne $action -and $action.WorkingDirectory -ceq $workingDirectory)}
}
function AssertExactProbeTaskDefinition($definition,[string]$expectedSid,[string]$executable,[string[]]$argumentList,[string]$workingDirectory){
  $checks=GetExactProbeTaskChecks $definition $expectedSid $executable $argumentList $workingDirectory
  foreach($key in $checks.Keys){TaskDefinitionRequire ($checks[$key] -is [bool] -and $checks[$key]) 'INTENDED_TASK_DEFINITION_NOT_EXACT'}
}
function InvokeExactTaskDefinitionPreflight {
  $machine=[Environment]::MachineName
  $targets=@{'DESK-W-591'=@{node='desk-w-591-windows-runner-caches';sid='S-1-5-21-858977881-4031698862-3006450925-1005'};'TURING'=@{node='turing-windows-runner-caches';sid='S-1-5-21-1173730660-3877291096-655431861-1013'}}
  TaskDefinitionRequire ($targets.ContainsKey($machine) -and [Environment]::Is64BitProcess) 'EXACT_HOST_AND_64BIT_REQUIRED'
  $target=$targets[$machine];$root='C:\ProgramData\CluedCacheQualification181';$stage=$root+'\Stage';$exe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';$request=$root+'\Control\'+$target.node+'\request.json'
  $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',($stage+'\windows_native_account_probe181.ps1'),'-ExecuteAcceptedProbe','-RequestPath',$request,'-RequestSha256',('0'*64))
  $scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$name='CluedCacheProbe-'+$target.node+'-181'
  $normal=NewExactProbeTaskDefinition $scheduler $name $target.sid $exe $arguments $stage
  AssertExactProbeTaskDefinition $normal $target.sid $exe $arguments $stage
  $checks=GetExactProbeTaskChecks $normal $target.sid $exe $arguments $stage
  $wire=[string]$normal.Principal.UserId;$resolved=ResolveTaskPrincipalSid $wire
  $negative=@()
  foreach($kind in @('wrong_sid','wrong_runlevel','wrong_logon','extra_trigger','missing_action','restart_nonzero')){
    $inputSid=$target.sid;if($kind -ceq 'wrong_sid'){$inputSid='S-1-5-18'}
    $d=NewExactProbeTaskDefinition $scheduler $name $inputSid $exe $arguments $stage
    switch($kind){wrong_runlevel{$d.Principal.RunLevel=1};wrong_logon{$d.Principal.LogonType=3};extra_trigger{$null=$d.Triggers.Create(1)};missing_action{$d.Actions.Clear()};restart_nonzero{$d.Settings.RestartInterval='PT1M';$d.Settings.RestartCount=1}}
    $refused=$false;try{AssertExactProbeTaskDefinition $d $target.sid $exe $arguments $stage}catch{$refused=$true}
    TaskDefinitionRequire $refused 'NEGATIVE_REAL_COM_UNEXPECTED_PASS';$negative+=@{case=$kind;refused=$refused}
  }
  $unmappedRefused=$false;try{$null=ResolveTaskPrincipalSid ($machine+'\__clued_probe_no_such_account_181__')}catch{$unmappedRefused=$true};TaskDefinitionRequire $unmappedRefused 'UNMAPPED_PRINCIPAL_NOT_REFUSED'
  $hash=[Security.Cryptography.SHA256]::Create();try{$argvHash=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes((TaskDefinitionArgs $arguments))))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
  return @{schema='clued.windows-real-com-preflight-r9/1';status='PASS_READONLY_DEFINITION_ONLY';host=$machine;powershell=$PSVersionTable.PSVersion.ToString();node_id=$target.node;expected_sid=$target.sid;wire_principal_name=$wire;resolved_sid=$resolved;guard_checks=$checks;negative_cases=$negative;unmapped_principal_refused=$unmappedRefused;request_sha_source='FIXED_ZERO_PLACEHOLDER_FOR_MEMORY_TEST_ONLY';argument_sha256=$argvHash;actual_account_execution_proven=$false;registration_called=$false;run_called=$false;uac=$false;file_writes=$false;raw_command_or_environment_persisted=$false}
}
