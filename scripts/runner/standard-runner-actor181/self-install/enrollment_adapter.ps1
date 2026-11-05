# Captured execution bytes only. No external source path, command, account or
# process can be selected through this internal factory.
function NewCapturedSelfEnrollment211([byte[]]$capturedCode){
 $expectedCodeSha='9395b92c4724e498f02f9a138f76a1cb60cb5b6deba351725a1baee5579f7a79'
 $capturedSourcePins=@{'config/ci-resource-maintenance.json'='ff191ef4b70bedfa35183a156775c4441563de6417eb509d5065ec1979051517';'scripts/ci/self-hosted/resource-maintenance/README.md'='3bf73beae47c2d3a3a813c2da29c50a473ffece4dc023a633723924bcd36455f';'scripts/ci/self-hosted/resource-maintenance/enroll.py'='1065b8a01c52eb1249a1b282df6ceef2fb396eb4fc29fa6705c4c1263e6571b1';'scripts/ci/self-hosted/resource-maintenance/maintenance.py'='b4a4946f3e2252ec173d90fce7659d0f35c55c1dbee07949951c8a33f17fc8d8';'scripts/ci/self-hosted/resource-maintenance/probe.py'='94a2917c9f1f9a15bbe806a0bd90b2a37b7a17dff9501be2010c511cc88bd8f1';'scripts/ci/self-hosted/resource-maintenance/producer.py'='65708765edb2ca593b685ab59159894d3690bd04f45ea1518db074584ee92cfd';'scripts/ci/self-hosted/resource-maintenance/schedule.py'='d772148106aa3f132cccbc1e4b62cdb2d7068e5a16a2a54fb796b655951acdab';'scripts/ci/self-hosted/resource-maintenance/security.py'='932567b1fc5d753b7b29561991ac0ab3a8502f31edfad0fb5109b5b5d2083209';'scripts/ci/self-hosted/resource-maintenance/test_maintenance.py'='77b490df6dedd6b68d42e1d735920c3a8241c6195606c1b57f8e38a0ab07b40f';'scripts/ci/self-hosted/resource-maintenance/test_producer.py'='d3fc91eca4bdb64cf5a392c7a69fa5ddbdc64f93013cf8f84c39f382c9ddce19';'scripts/ci/self-hosted/resource-maintenance/test_schedule_probe.py'='2f5e5913f660c1c3bcc554108a28ac4b238f5fa0c21bbdc102062e9e192c3cc2'}
 InstallRequire211 ($capturedCode.Length -gt 0 -and $capturedCode.Length -le 32768 -and $expectedCodeSha -cmatch '\A[a-f0-9]{64}\z' -and (InstallSame211 (BytesHash $capturedCode) $expectedCodeSha)) 'INSTALL_ENROLLMENT_CAPTURE_PIN'
 InstallRequire211 ($capturedSourcePins -is [Collections.IDictionary] -and $capturedSourcePins.Count -eq 11) 'INSTALL_CAPTURED_SOURCE11_REQUIRED'
 $held=[byte[]]$capturedCode.Clone();$pins=@{};foreach($k in $capturedSourcePins.Keys){InstallRequire211 ($k -is [string] -and $k -cmatch '\A(?:config/ci-resource-maintenance\.json|scripts/ci/self-hosted/resource-maintenance/[a-zA-Z0-9_.-]+)\z' -and $capturedSourcePins[$k] -is [string] -and $capturedSourcePins[$k] -cmatch '\A[a-f0-9]{64}\z') 'INSTALL_SOURCE_MEMBER_PIN';$pins[$k]=$capturedSourcePins[$k]}
 $enroll={param($r)
  foreach($name in @('python','pythonw')){$path=$r.$name;NoReparse $path;MachineRuntimeAcl $path;InstallRequire211 ((InstallSame211 (Hash $path) $r.($name+'_sha256')) -and (Get-AuthenticodeSignature -LiteralPath $path).Status -eq 'Valid') 'INSTALL_MACHINE_INTERPRETER_PIN_SIGNATURE'}
  $requestRaw=[CluedQualification181.SafeEvidence]::Read($r.request_path,16384,'S-1-5-32-544');InstallRequire211 (InstallSame211 (BytesHash $requestRaw) $r.request_sha256) 'INSTALL_PROTECTED_REQUEST_PIN'
  $data=[Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes((@($r.request_path,$r.request_sha256)|ConvertTo-Json -Compress)))
  $program='import base64,json;g={"__name__":"clued_captured_install211"};exec(compile(base64.b64decode("'+[Convert]::ToBase64String($held)+'"),"<captured-self-enrollment211>","exec"),g);a=json.loads(base64.b64decode("'+$data+'"));v=g["enroll_captured211"](*a);print(json.dumps(v,separators=(",",":")))'
  $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$r.python;$info.Arguments='-B -I -S -';$info.WorkingDirectory='C:\ProgramData\CluedCacheInstallSelf211\Stage';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
  $info.EnvironmentVariables.Clear();$info.EnvironmentVariables['SystemRoot']=$env:SystemRoot;$info.EnvironmentVariables['PATH']=[Environment]::SystemDirectory
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$heldProcess=$null
  try{
   InstallRequire211 ($process.Start()) 'INSTALL_ENROLLMENT_PROCESS_NOT_STARTED'
   $heldProcess=[CluedQualification181.HeldProcess]::new($process.Id);$before=$heldProcess.Observe()
   InstallRequire211 ($before.Pid -eq $process.Id -and $before.ParentPid -eq $PID -and $before.Sid -ceq $r.expected_sid -and $before.Elevated -eq 0 -and $before.Image -ieq $r.python) 'INSTALL_ENROLLMENT_OWN_CHILD'
   $out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync();$process.StandardInput.Write($program);$process.StandardInput.Close()
   InstallRequire211 ($process.WaitForExit(240000) -and $out.Wait(1000) -and $err.Wait(1000) -and $process.ExitCode -eq 0) 'INSTALL_ENROLLMENT_UNKNOWN_PRESERVE_NO_RETRY'
   $line=$out.GetAwaiter().GetResult();$null=$err.GetAwaiter().GetResult();InstallRequire211 ($line -is [string] -and $line.Length -le 4096) 'INSTALL_ENROLLMENT_REPLY_BOUND'
   $value=SelfStrictJson $line;InstallKeys211 $value @('schema','status','node_id','nonce','pid','sid','binding_sha256','scheduler_xml_sha256','worker_qualified','automatic_retry')
   InstallRequire211 ((InstallSame211 $value.schema 'clued.self-maintenance-enrollment211/1') -and (InstallSame211 $value.status 'ENROLLED_SCHEDULER_NOT_INSTALLED') -and (InstallSame211 $value.node_id $r.node_id) -and (InstallSame211 $value.sid $r.expected_sid) -and $value.pid -is [int] -and $value.pid -eq $process.Id -and $value.worker_qualified -is [bool] -and -not $value.worker_qualified -and $value.automatic_retry -is [bool] -and -not $value.automatic_retry) 'INSTALL_ENROLLMENT_REPLY_SUBJECT'
   return $value
  }finally{if($null -ne $heldProcess){$heldProcess.Dispose()};$process.Dispose()}
 }.GetNewClosure()
 $verify={param($r,$enrollment)
  foreach($name in $pins.Keys){$raw=[CluedQualification181.SafeEvidence]::Read((Join-Path $r.source $name),1048576,$r.expected_sid);InstallRequire211 (InstallSame211 (BytesHash $raw) $pins[$name]) 'INSTALL_SOURCE11_AFTER_ENROLL'}
  $bindingPath=Join-Path $r.managed 'binding.json';$raw=[CluedQualification181.SafeEvidence]::Read($bindingPath,16384,$r.expected_sid);$bindingHash=BytesHash $raw
  InstallRequire211 (InstallSame211 $bindingHash $enrollment.binding_sha256) 'INSTALL_BINDING_PIN_AFTER_ENROLL'
  $binding=SelfStrictJson ([Text.UTF8Encoding]::new($false,$true).GetString($raw));InstallKeys211 $binding @('schema','node_id','state_root','caches')
  InstallRequire211 ((InstallSame211 $binding.schema 'clued.cache-node/1') -and (InstallSame211 $binding.node_id $r.node_id) -and (InstallSame211 $binding.state_root (Join-Path $r.managed 'state'))) 'INSTALL_BINDING_EXACT_SCOPE'
  InstallKeys211 $binding.caches @('npm','pip','job-temp','generic');foreach($cache in @('npm','pip','job-temp','generic')){InstallKeys211 $binding.caches.$cache @('profile','root');InstallRequire211 ((InstallSame211 $binding.caches.$cache.profile $cache) -and (InstallSame211 $binding.caches.$cache.root (Join-Path $r.managed $cache))) 'INSTALL_CACHE_SCOPE'}
  $xmlPath=Join-Path $r.managed ('scheduler\clued-cache-'+$r.node_id+'.xml');$xmlRaw=[CluedQualification181.SafeEvidence]::Read($xmlPath,65536,$r.expected_sid);$xmlHash=BytesHash $xmlRaw
  InstallRequire211 (InstallSame211 $xmlHash $enrollment.scheduler_xml_sha256) 'INSTALL_SCHEDULER_PIN_AFTER_ENROLL'
  $xml=[Text.UTF8Encoding]::new($false,$true).GetString($xmlRaw);CheckWorkerXml $xml $r $r.source $r.managed
  return [pscustomobject]@{xml=$xml;binding_sha256=$bindingHash;scheduler_xml_sha256=$xmlHash}
 }.GetNewClosure()
 $enroll=InstallBindPrivateCallback212 $enroll @('NoReparse','MachineRuntimeAcl','InstallRequire211','InstallSame211','Hash','BytesHash','SelfStrictJson','SelfRequire','InstallKeys211','Require')
 $verify=InstallBindPrivateCallback212 $verify @('InstallRequire211','InstallSame211','BytesHash','SelfStrictJson','SelfRequire','InstallKeys211','CheckWorkerXml','SameArgv','Require')
 return @{enroll=$enroll;verify_enrollment=$verify}
}
