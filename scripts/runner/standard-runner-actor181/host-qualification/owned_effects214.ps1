# Private captured RELAY helpers. These read only owned process/evidence facts.
# Original SelfTarget/ObsRead/ObsStrictEvidenceJson/native validators are loaded
# from exact original captured actor/observer_os bytes in this same private module.
function E214Require($v,[string]$c){if($v -isnot [bool] -or -not $v){throw $c}}
function E214Keys($v,[string[]]$keys){E214Require ($v -is [pscustomobject] -and ((@($v.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'EFFECT_CLOSED_FIELDS'}
function E214Same($v,[string]$want){return ($v -is [string] -and [StringComparer]::Ordinal.Equals($v,$want))}
function InitializeOwnedEffects214($capturedInitial){
 E214Require ($null -eq $script:OwnedEffects214) 'EFFECT_NAMESPACE_ONCE'
 E214Require ($null -ne $capturedInitial.owner_packet -and $null -ne $capturedInitial.binding) 'EFFECT_REAL_CAPTURE_REQUIRED'
 $own=[CluedQualification181.HeldProcess]::new($PID)
 try{$o=$own.Observe();E214Require ($o.Elevated -eq 1 -and $o.Sid -cne 'S-1-5-18') 'EFFECT_ELEVATED_OWNED_RELAY_ONLY'}finally{$own.Dispose()}
 $t=SelfTarget ([Environment]::MachineName)
 foreach($n in @('host','node_id','request_sha256')){E214Require (E214Same $capturedInitial.binding.$n $t.$n) 'EFFECT_CAPTURED_TARGET'}
 E214Require ((E214Same $capturedInitial.target_sid $t.sid) -and (E214Same $capturedInitial.binding.predecessor_r9_index_sha256 $t.predecessor_index_sha256)) 'EFFECT_CAPTURED_TARGET_HISTORY'
 $script:OwnedEffects214=@{captured=$capturedInitial;target=$t;self=$null;node=$null;metadata=$null;final_binding=$null}
}
function InvokeInspectSelf214($body,$capturedInitial){
 E214Require ($null -ne $script:OwnedEffects214 -and [object]::ReferenceEquals($script:OwnedEffects214.captured,$capturedInitial) -and $null -eq $script:OwnedEffects214.self) 'EFFECT_PRIVATE_CAPTURE_OR_ONCE'
 E214Keys $body @('metadata','actual_node');$m=$body.metadata;$peer=$body.actual_node
 E214Keys $m @('schema','host','ps_pid','ps_start','ps_parent_pid','ps_sid','ps_elevated','node_pid','node_start','node_sid','node_elevated','node_image','source_captured','authority_granted','runner_name')
 E214Keys $peer @('broker_pid','broker_start','node_pid','node_start','node_sid','node_image')
 $t=$script:OwnedEffects214.target;$fixed=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
 foreach($n in @('ps_pid','ps_parent_pid','node_pid')){E214Require ($m.$n -is [int] -and $m.$n -gt 0) 'EFFECT_METADATA_PID'}
 foreach($n in @('ps_start','node_start')){E214Require ($m.$n -is [string] -and $m.$n -cmatch '\A[1-9][0-9]{0,18}\z') 'EFFECT_METADATA_START'}
 E214Require ($peer.node_pid -is [int] -and $peer.broker_pid -is [int] -and $peer.node_pid -eq $m.node_pid -and $peer.broker_pid -ne $m.ps_pid -and $m.ps_pid -ne $m.node_pid -and $m.ps_pid -ne $PID -and $m.ps_parent_pid -eq $m.node_pid -and (E214Same $peer.node_start $m.node_start) -and (E214Same $m.node_sid $t.sid) -and (E214Same $m.ps_sid $t.sid) -and (E214Same $peer.node_sid $t.sid) -and (E214Same $m.host $t.host) -and (E214Same $peer.node_image $m.node_image)) 'EFFECT_METADATA_DISTINCT_KERNEL_NODE'
 E214Require ($m.node_elevated -is [int] -and $m.node_elevated -eq 0 -and $m.ps_elevated -is [int] -and $m.ps_elevated -eq 0 -and $m.source_captured -is [bool] -and $m.source_captured -and $m.authority_granted -is [bool] -and -not $m.authority_granted) 'EFFECT_METADATA_NOT_AUTHORITY'
 $node=[CluedQualification181.HeldProcess]::new($m.node_pid);$self=$null
 try{
  $self=[CluedQualification181.HeldProcess]::new($m.ps_pid);$n=$node.Observe();$s=$self.Observe()
  E214Require ($n.Pid -eq $m.node_pid -and $n.CreationFileTime.ToString() -ceq $m.node_start -and $n.Sid -ceq $t.sid -and $n.Elevated -eq 0 -and $n.Image -ieq $m.node_image -and [IO.Path]::GetFileName($n.Image) -ieq 'node.exe' -and -not $node.HasExited) 'EFFECT_ACTUAL_NODE_HELD'
  E214Require ($s.Pid -eq $m.ps_pid -and $s.CreationFileTime.ToString() -ceq $m.ps_start -and $s.Sid -ceq $t.sid -and $s.Elevated -eq 0 -and $s.Image -ieq $fixed -and $s.ParentPid -eq $n.Pid -and -not $self.HasExited) 'EFFECT_ACTUAL_SELF_HELD'
  # Metadata.source_captured is only a hint. Reopen the actual held Self PS
  # command line and bind its real fixed bootstrap, which enforces wrapper/source
  # hashes before consuming stdin. This is not a Node-provided command-line hash.
  $argv=[CluedQualification181.CommandLine]::Parse($self.ReadCommandLine())
  E214Require ($argv.Count -eq 5 -and $argv[0] -ieq $fixed -and $argv[1] -ceq '-NoProfile' -and $argv[2] -ceq '-NonInteractive' -and $argv[3] -ceq '-EncodedCommand') 'EFFECT_ACTUAL_SELF_BOOTSTRAP_ARGV'
  $bootstrap=[Convert]::FromBase64String($argv[4]);E214Require ($bootstrap.Length -eq 1860 -and (ObsHash $bootstrap) -ceq '8e556d3c3080fc5f3225569f47452ae68c063e0634db611d38af2265fda85cc6') 'EFFECT_ACTUAL_SELF_SOURCE_BOOTSTRAP'
  $script:OwnedEffects214.self=$self;$script:OwnedEffects214.node=$node;$script:OwnedEffects214.metadata=$m;$self=$null;$node=$null
  return [pscustomobject]@{schema='clued.root-owned-self-held214/1';node_pid=$n.Pid;node_start=$n.CreationFileTime.ToString();node_sid=$n.Sid;node_image=$n.Image;ps_pid=$s.Pid;ps_start=$s.CreationFileTime.ToString();ps_sid=$s.Sid;ps_parent_pid=$s.ParentPid}
 }finally{if($null -ne $self){$self.Dispose()};if($null -ne $node){$node.Dispose()}}
}
function BindOwnedEffects214($binding){
 E214Require ($null -ne $script:OwnedEffects214.self -and $null -eq $script:OwnedEffects214.final_binding) 'EFFECT_INSPECT_BEFORE_BIND_ONCE'
 $null=RelayBoundTarget $binding;$c=$script:OwnedEffects214.captured;$m=$script:OwnedEffects214.metadata
 foreach($n in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','packet_sha256','request_sha256','predecessor_r9_index_sha256','observer_capture_sha256','runner_capture_sha256')){E214Require (E214Same $binding.$n $c.binding.$n) 'EFFECT_FINAL_CAPTURE_BINDING'}
 E214Require ($binding.ps_pid -eq $m.ps_pid -and (E214Same $binding.ps_start $m.ps_start) -and $binding.node_pid -eq $m.node_pid -and (E214Same $binding.node_start $m.node_start) -and $binding.relay_pid -eq $PID -and $binding.ba_pid -ne $PID) 'EFFECT_FINAL_ACTUAL_ROLE_BINDING'
 $script:OwnedEffects214.final_binding=$binding
}
function E214ReadRef($ref,[string]$relative,[byte[]]$raw){E214Keys $ref @('relative','sha256');E214Require ((E214Same $ref.relative $relative) -and (E214Same $ref.sha256 (ObsHash $raw))) 'EFFECT_FIXED_EVIDENCE_REFERENCE'}
function E214Read([string]$relative,[string]$owner){
 E214Require ($relative -notmatch '[\\:\r\n\x00]' -and $relative -notmatch '(?:\A|/)\.\.?(?:/|\z)') 'EFFECT_CLOSED_RELATIVE_PATH'
 return ,([byte[]](ObsRead (Join-Path 'C:\ProgramData\CluedCacheQualification181' $relative) $owner 1048576))
}
function InvokeReopenProof214($body,$capturedInitial){
 E214Keys $body @('binding','mode');E214Require ($body.mode -is [string] -and $body.mode -cin @('STATUS','REOPEN')) 'EFFECT_PROOF_MODE'
 E214Require ($null -ne $script:OwnedEffects214 -and [object]::ReferenceEquals($script:OwnedEffects214.captured,$capturedInitial) -and $null -ne $script:OwnedEffects214.final_binding) 'EFFECT_PRIVATE_FINAL_BINDING'
 $state=$script:OwnedEffects214;$b=$state.final_binding;$candidate=$body.binding
 E214Require (($candidate|ConvertTo-Json -Compress -Depth 12) -ceq ($b|ConvertTo-Json -Compress -Depth 12)) 'EFFECT_PROOF_BINDING_DRIFT'
 if(-not $state.self.HasExited){E214Require ($body.mode -ceq 'STATUS') 'EFFECT_ENTRY_NOT_TERMINAL';return [pscustomobject]@{status='PENDING_NATIVE_PROOF'}}
 E214Require ($state.self.ExitCode -eq 0) 'EFFECT_ACTUAL_SELF_ENTRY_FAILED'
 $t=$state.target;$control='Control/'+$t.node_id+'/';$output='Outputs/'+$t.node_id+'/';$transportRelative=$control+'native-export-self181/transport.json'
 [byte[]]$proofRaw=E214Read ($control+'self-registration181.observer-proof.json') 'S-1-5-32-544';[byte[]]$indexRaw=E214Read 'qualification-self181.result.json' 'S-1-5-32-544';[byte[]]$transportRaw=E214Read $transportRelative 'S-1-5-32-544'
 $proof=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($proofRaw));$index=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($indexRaw));$transport=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($transportRaw))
 E214Keys $proof @('schema','status','host','node_id','expected_sid','attempt_id','accepted_subject_sha256','request_sha256','nonce','owner_receipt_id','observation','terminal','native','automatic_retry','installation','worker_qualification')
 E214Require ((E214Same $proof.schema 'clued.windows-self-observer-proof181/1') -and (E214Same $proof.status 'REAL_SELF_ACCOUNT_PROBE_VALIDATED_NOT_MAINTENANCE_INSTALLED')) 'EFFECT_ORIGINAL_PROOF_SCHEMA'
 foreach($n in @('host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','request_sha256')){E214Require (E214Same $proof.$n $b.$n) 'EFFECT_ORIGINAL_PROOF_SUBJECT'}
 E214Require ((E214Same $proof.expected_sid $t.sid) -and $proof.nonce -is [string] -and $proof.nonce -cmatch '\A[a-f0-9]{32}\z') 'EFFECT_ORIGINAL_PROOF_IDENTITY'
 foreach($n in @('automatic_retry','installation','worker_qualification')){E214Require ($proof.$n -is [bool] -and -not $proof.$n) 'EFFECT_ORIGINAL_PROOF_FLAGS'}
 $terminal=$proof.terminal;E214Keys $terminal @('native_exit_code','child_exit_code','both_streams_eof_confirmed','stream_eof_basis','task_instances_empty','known_processes_settled','native_three_closed_exact','held_identity_argv_after_exact','original_history_unchanged','stdout_bytes','stdout_sha256','stderr_bytes','stderr_sha256')
 foreach($n in @('native_exit_code','child_exit_code')){E214Require (($terminal.$n -is [int] -or $terminal.$n -is [long]) -and $terminal.$n -eq 0) 'EFFECT_ORIGINAL_NATIVE_TERMINAL'}
 foreach($n in @('both_streams_eof_confirmed','task_instances_empty','known_processes_settled','native_three_closed_exact','held_identity_argv_after_exact','original_history_unchanged')){E214Require ($terminal.$n -is [bool] -and $terminal.$n) 'EFFECT_ORIGINAL_TERMINAL_BOOLEANS'}
 E214Require (E214Same $terminal.stream_eof_basis 'PINNED_NATIVE_WAITEXIT_PUMPS_COMPLETED_FAULT_NULL_AND_REAL_EXIT0') 'EFFECT_ORIGINAL_EOF_BASIS';ObsSafeStreamRecord $terminal
 E214Keys $index @('schema','status','host','node_id','expected_sid','attempt_id','accepted_subject_sha256','predecessor_r9','history_pins','observer_proof','native','automatic_retry','installation','worker_qualification')
 E214Require ((E214Same $index.schema 'clued.windows-qualification-self181-result181/1') -and (E214Same $index.status 'QUALIFIED_NOT_MAINTENANCE_INSTALLED')) 'EFFECT_ORIGINAL_INDEX_SCHEMA'
 foreach($n in @('host','node_id','expected_sid','attempt_id','accepted_subject_sha256')){E214Require (E214Same $index.$n $proof.$n) 'EFFECT_ORIGINAL_INDEX_SUBJECT'}
 foreach($n in @('automatic_retry','installation','worker_qualification')){E214Require ($index.$n -is [bool] -and -not $index.$n) 'EFFECT_ORIGINAL_INDEX_FLAGS'}
 E214ReadRef $index.observer_proof ($control+'self-registration181.observer-proof.json') $proofRaw
 E214Keys $index.predecessor_r9 @('relative','sha256');E214Require ((E214Same $index.predecessor_r9.relative 'qualification-r9.result.json') -and (E214Same $index.predecessor_r9.sha256 $b.predecessor_r9_index_sha256)) 'EFFECT_ORIGINAL_HISTORY_REFERENCE'
 E214Keys $transport @('schema','status','node_id','expected_sid','accepted_subject_sha256','qualification_index','exports','runtime_authority','automatic_retry','installation')
 E214Require ((E214Same $transport.schema 'clued.windows-native-transport-self181/1') -and (E214Same $transport.status 'COMPLETE_PUBLIC_SNAPSHOT_NOT_RUNTIME_AUTHORITY') -and (E214Same $transport.runtime_authority 'ORIGINAL_OUTPUTS_ONLY')) 'EFFECT_ORIGINAL_TRANSPORT_SCHEMA'
 foreach($n in @('node_id','expected_sid','accepted_subject_sha256')){E214Require (E214Same $transport.$n $proof.$n) 'EFFECT_ORIGINAL_TRANSPORT_SUBJECT'}
 foreach($n in @('automatic_retry','installation')){E214Require ($transport.$n -is [bool] -and -not $transport.$n) 'EFFECT_ORIGINAL_TRANSPORT_FLAGS'}
 E214ReadRef $transport.qualification_index 'qualification-self181.result.json' $indexRaw
 $names=@('native_start','native_ready','native_result');E214Keys $proof.native $names;E214Keys $index.native $names;E214Keys $transport.exports $names
 $raws=@{};foreach($pair in @(@('native_start','start.json'),@('native_ready','ready.json'),@('native_result','result.json'))){$key=$pair[0];$leaf=$pair[1];[byte[]]$source=E214Read ($output+$leaf) $t.sid;[byte[]]$snapshot=E214Read ($control+'native-export-self181/'+$leaf) 'S-1-5-32-544';E214ReadRef $proof.native.$key ($output+$leaf) $source;E214ReadRef $index.native.$key ($output+$leaf) $source;E214Keys $transport.exports.$key @('source','snapshot');E214ReadRef $transport.exports.$key.source ($output+$leaf) $source;E214ReadRef $transport.exports.$key.snapshot ($control+'native-export-self181/'+$leaf) $snapshot;E214Require (E214Same (ObsHash $source) (ObsHash $snapshot)) 'EFFECT_ORIGINAL_NATIVE_EXPORT_DRIFT';$raws[$key]=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($source))}
 [byte[]]$requestRaw=E214Read ($control+'request.json') 'S-1-5-32-544';E214Require (E214Same (ObsHash $requestRaw) $t.request_sha256) 'EFFECT_ORIGINAL_REQUEST_PIN';$request=ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($requestRaw));E214Require (E214Same $request.nonce $proof.nonce) 'EFFECT_ORIGINAL_NONCE'
 $nativeExe=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe';$ready=ObsSafeNativeReady $raws.native_ready $t.node_id $proof.nonce $t.sid $nativeExe $request.python
 $null=ObsSafeNativeSuccess $raws.native_result $t.node_id $proof.nonce $ready.native.pid $ready.child.pid;ObsSafeNativeStartForExport $raws.native_start $ready $t.node_id $proof.nonce $t.sid $nativeExe $t.request_sha256
 $observation=$proof.observation;E214Keys $observation @('schema','host','node_id','attempt_id','accepted_subject_sha256','nonce','task_instance_guid','native_before','native_after','child_before','child_after','task_full_xml_sha256','native_argv_match','child_argv_match','command_line_persisted','installation','worker_qualification')
 E214Require (E214Same $observation.schema 'clued.windows-self-observation181/1') 'EFFECT_ORIGINAL_OBSERVATION_SCHEMA';foreach($n in @('host','node_id','attempt_id','accepted_subject_sha256','nonce')){E214Require (E214Same $observation.$n $proof.$n) 'EFFECT_ORIGINAL_OBSERVATION_SUBJECT'}
 E214Require ($observation.task_instance_guid -is [string] -and $observation.task_instance_guid -cmatch '\A\{[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}\}\z' -and $observation.task_full_xml_sha256 -is [string] -and $observation.task_full_xml_sha256 -cmatch '\A[a-f0-9]{64}\z') 'EFFECT_ORIGINAL_INSTANCE_XML'
 foreach($n in @('native_argv_match','child_argv_match')){E214Require ($observation.$n -is [bool] -and $observation.$n) 'EFFECT_ORIGINAL_ARGV_MATCH'}
 foreach($n in @('command_line_persisted','installation','worker_qualification')){E214Require ($observation.$n -is [bool] -and -not $observation.$n) 'EFFECT_ORIGINAL_OBSERVATION_FLAGS'}
 foreach($pair in @(@('native_before','native'),@('native_after','native'),@('child_before','child_process'),@('child_after','child_process'))){$record=$observation.($pair[0]);$reference=$ready.($pair[1]);$image=$nativeExe;if($pair[1] -ceq 'child_process'){$image=$request.python};$null=ObsSafeProcessRecord $record $t.sid $image;foreach($n in @('pid','sid','elevated','creation_file_time','parent_pid')){E214Require ([object]::Equals($record.$n,$reference.$n)) 'EFFECT_ORIGINAL_PROCESS_CONTINUITY'};E214Require ($record.image -is [string] -and $record.image -ieq $reference.image) 'EFFECT_ORIGINAL_PROCESS_IMAGE'}
 return [pscustomobject]@{schema='clued.standard-runner-actor-native-proof/1';status='INDEPENDENT_NATIVE_PROOF_VALIDATED';entry_exit_code=[int]$state.self.ExitCode;native_exit_code=[int]$terminal.native_exit_code;child_exit_code=[int]$terminal.child_exit_code;proof_sha256=(ObsHash $proofRaw);export_sha256=(ObsHash $transportRaw)}
}
function CloseOwnedEffects214{if($null -ne $script:OwnedEffects214){foreach($n in @('self','node')){if($null -ne $script:OwnedEffects214[$n]){$script:OwnedEffects214[$n].Dispose()}};$script:OwnedEffects214=$null}}
