# Closed receiver of the ORIGINAL c27-produced Self chain. No old r9 success
# relabel, registration, Run, export copy, ACL change or authority from JSON.
function QualNeed212($v,[string]$why){if($v -isnot [bool] -or -not $v){throw [InvalidOperationException]::new($why)}}
function QualKeys212($v,[string[]]$keys){QualNeed212 ($v -is [pscustomobject] -and ((@($v.PSObject.Properties.Name)|Sort-Object)-join '|') -ceq (($keys|Sort-Object)-join '|')) 'SELF_QUAL_CLOSED_OBJECT'}
function QualString212($v,[string]$expected){QualNeed212 ($v -is [string] -and [StringComparer]::Ordinal.Equals($v,$expected)) 'SELF_QUAL_EXACT_STRING'}
function QualHash212($v){QualNeed212 ($v -is [string] -and $v -cmatch '\A[a-f0-9]{64}\z') 'SELF_QUAL_HASH'}
function QualHashBytes212([byte[]]$raw){$h=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($h.ComputeHash($raw))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function QualExpect212($e){
 QualKeys212 $e @('schema','host','node_id','expected_sid','qualification_attempt_id','qualification_subject_sha256','qualification_owner_receipt_id','qualification_source_acceptance_ref','qualification_index_sha256','public_transport_result_sha256','request_sha256','predecessor_r9_sha256','producer_sha256','native_executable','python')
 QualString212 $e.schema 'clued.self-qualification-expectation212/1'
 foreach($k in @('qualification_subject_sha256','qualification_index_sha256','public_transport_result_sha256','request_sha256','predecessor_r9_sha256','producer_sha256')){QualHash212 $e.$k}
 QualString212 $e.producer_sha256 'c27f400015fcf0628ff42f46d777892437fd688158b1e6b25c616d60e8c9971a'
 foreach($k in @('qualification_owner_receipt_id','qualification_source_acceptance_ref')){QualNeed212 ($e.$k -is [string] -and $e.$k -cmatch '\A[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\z') 'SELF_QUAL_REAL_RECEIPT_REF_REQUIRED'}
 QualNeed212 ($e.qualification_attempt_id -is [string] -and $e.qualification_attempt_id -cmatch '\A[a-f0-9]{32}\z' -and $e.node_id -is [string] -and $e.node_id -cmatch '\A[a-z0-9][a-z0-9-]{0,62}\z' -and $e.host -is [string] -and $e.host -cmatch '\A[A-Za-z0-9-]{1,63}\z' -and $e.expected_sid -is [string] -and $e.expected_sid -cmatch '\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z') 'SELF_QUAL_TYPED_SUBJECT'
 foreach($k in @('native_executable','python')){QualNeed212 ($e.$k -is [string] -and $e.$k -cmatch '\A[A-Za-z]:[\\/]' -and $e.$k -notmatch '[\r\n\x00]') 'SELF_QUAL_EXECUTABLE_PATH'}
 # Original frozen Self predecessor/request mappings; a new host cannot inherit
 # another SID's proof simply by presenting a well-shaped expectation object.
 $known=@{'DESK-W-591'=@('desk-w-591-windows-runner-caches','S-1-5-21-858977881-4031698862-3006450925-1005','556c2a224252ae9b84078075049ce6c46bd4c3ccf9cab9dcabdec16c9d6b9ce0','d24a9bd1a8b0d905af0a789e0c18e6a97d6433868d124eecaa67c7784d72f297');'TURING'=@('turing-windows-runner-caches','S-1-5-21-1173730660-3877291096-655431861-1013','961a6a425a81ce2ef4e40fa42809c72210d65ded7bd30c164286e8351206e8b7','87f3aa2534d3999d9664c740f5eb5dc1d593fa1cdb075867c68000a788ab8c7c')}
 QualNeed212 ($known.ContainsKey($e.host)) 'SELF_QUAL_NEW_HOST_NOT_ENROLLED';$k=$known[$e.host];QualString212 $e.node_id $k[0];QualString212 $e.expected_sid $k[1];QualString212 $e.request_sha256 $k[2];QualString212 $e.predecessor_r9_sha256 $k[3]
}
function QualRelative212($v){QualNeed212 ($v -is [string] -and $v.Length -le 512 -and $v -cmatch '\A[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*\z' -and $v -notmatch '(?:\A|/)\.\.?(?:/|\z)') 'SELF_QUAL_RELATIVE_PATH'}
function QualRef212($v,[string]$relative){QualKeys212 $v @('relative','sha256');QualString212 $v.relative $relative;QualHash212 $v.sha256}
function QualRead212([scriptblock]$reader,[string]$relative,[string]$pin,[string]$owner,[int]$limit=1048576){
 QualRelative212 $relative;QualHash212 $pin;$raw=& $reader $relative $owner $limit
 QualNeed212 ($raw -is [byte[]] -and $raw.Length -gt 0 -and $raw.Length -le $limit) 'SELF_QUAL_READ_BOUND';QualString212 (QualHashBytes212 $raw) $pin
 return ,$raw
}
function QualJson212([byte[]]$raw){return ObsStrictEvidenceJson ([Text.UTF8Encoding]::new($false,$true).GetString($raw))}
function QualFlagsFalse212($v,[string[]]$names){foreach($n in $names){QualNeed212 ($v.$n -is [bool] -and -not $v.$n) 'SELF_QUAL_FALSE_EFFECT_FLAG'}}
function QualCurrent212($e,[scriptblock]$authority){
 QualNeed212 ($null -ne $authority) 'SELF_QUAL_ACTUAL_ROOT_AUTHORITY_REQUIRED'
 $a=& $authority $e
 QualKeys212 $a @('status','host','node_id','expected_sid','qualification_attempt_id','qualification_subject_sha256','qualification_owner_receipt_id','qualification_source_acceptance_ref','qualification_index_sha256','producer_sha256')
 QualString212 $a.status 'QUALIFICATION_INPUTS_CURRENT'
 foreach($k in @('host','node_id','expected_sid','qualification_attempt_id','qualification_subject_sha256','qualification_owner_receipt_id','qualification_source_acceptance_ref','qualification_index_sha256','producer_sha256')){QualString212 $a.$k $e.$k}
}
function ReadSelfQualificationCore212($e,[scriptblock]$reader,[scriptblock]$authority){
 QualExpect212 $e;QualCurrent212 $e $authority
 $admin='S-1-5-32-544';$control='Control/'+$e.node_id+'/';$output='Outputs/'+$e.node_id+'/'
 $indexRaw=QualRead212 $reader 'qualification-self181.result.json' $e.qualification_index_sha256 $admin
 $i=QualJson212 $indexRaw
 QualKeys212 $i @('schema','status','host','node_id','expected_sid','attempt_id','accepted_subject_sha256','predecessor_r9','history_pins','observer_proof','native','automatic_retry','installation','worker_qualification')
 QualString212 $i.schema 'clued.windows-qualification-self181-result181/1';QualString212 $i.status 'QUALIFIED_NOT_MAINTENANCE_INSTALLED'
 foreach($k in @('host','node_id','expected_sid')){QualString212 $i.$k $e.$k};QualString212 $i.attempt_id $e.qualification_attempt_id;QualString212 $i.accepted_subject_sha256 $e.qualification_subject_sha256;QualFlagsFalse212 $i @('automatic_retry','installation','worker_qualification')
 QualRef212 $i.predecessor_r9 'qualification-r9.result.json';QualString212 $i.predecessor_r9.sha256 $e.predecessor_r9_sha256
 $old=QualJson212 (QualRead212 $reader 'qualification-r9.result.json' $e.predecessor_r9_sha256 $admin)
 QualString212 $old.status 'NOT_QUALIFIED_PRESERVE_NO_RETRY'
 QualNeed212 ($i.history_pins -is [pscustomobject] -and @($i.history_pins.PSObject.Properties).Count -ge 2 -and @($i.history_pins.PSObject.Properties).Count -le 10000) 'SELF_QUAL_HISTORY_BOUND'
 $history=@{};foreach($p in $i.history_pins.PSObject.Properties){QualRelative212 $p.Name;QualHash212 $p.Value;$owner=$admin;if($p.Name.StartsWith($output,[StringComparison]::Ordinal)){$owner=$e.expected_sid};$null=QualRead212 $reader $p.Name $p.Value $owner;$history[$p.Name]=$p.Value}
 QualString212 $history['qualification-r9.result.json'] $e.predecessor_r9_sha256;QualString212 $history[($control+'request.json')] $e.request_sha256
 $request=QualJson212 (QualRead212 $reader ($control+'request.json') $e.request_sha256 $admin 16384)
 QualKeys212 $request @('schema','node_id','host','expected_sid','python','python_sha256','pythonw','pythonw_sha256','home','private_parent','stage_dir','output_dir','release_path','nonce','stage_pins')
 QualString212 $request.schema 'clued.windows-account-probe-request181/1';foreach($k in @('host','node_id','expected_sid','python')){QualString212 $request.$k $e.$k}
 QualNeed212 ($request.nonce -is [string] -and $request.nonce -cmatch '\A[a-f0-9]{32}\z') 'SELF_QUAL_ORIGINAL_REQUEST_NONCE'
 QualString212 $request.stage_dir 'C:\ProgramData\CluedCacheQualification181\Stage';QualString212 $request.output_dir ('C:\ProgramData\CluedCacheQualification181\Outputs\'+$e.node_id);QualString212 $request.release_path ('C:\ProgramData\CluedCacheQualification181\Control\'+$e.node_id+'\release.json')
 $stagePins=@{'WindowsAccountIdentity181.dll'='31a3f23a0db09cbd44fba46aaacacf72818a8e3759cd50ca716b7b0b57b157c8';'windows_native_account_probe181.ps1'='55d8dbc145b694d17e03314cec495b91353e66eee13c08ce60a8e6a06735b814';'windows_python_account_probe181.py'='34d342a2e7af8d24cf3412413ca30aebf09bf7eb18532bdcc5a323a9e6eecff8';'security.py'='932567b1fc5d753b7b29561991ac0ab3a8502f31edfad0fb5109b5b5d2083209'}
 QualKeys212 $request.stage_pins @($stagePins.Keys);foreach($k in $stagePins.Keys){QualString212 $request.stage_pins.$k $stagePins[$k];$null=QualRead212 $reader ('Stage/'+$k) $stagePins[$k] $admin}
 # Reconstruct every retained failed-r9 reference, not just a caller-selected
 # subset of history. No reading or rewriting of old bytes outside this root.
 foreach($map in @($old.original_pins,$old.intermediate_pins)){if($null -ne $map){foreach($p in $map.PSObject.Properties){QualRelative212 $p.Name;QualHash212 $p.Value;QualString212 $history[$p.Name] $p.Value}}}
 foreach($ref in @($old.batch_start,$old.batch_result)+@($old.nodes|ForEach-Object {@($_.request,$_.account_result)})){if($null -ne $ref){QualRelative212 $ref.relative;QualHash212 $ref.sha256;QualString212 $history[$ref.relative] $ref.sha256}}
 $proofRelative=$control+'self-registration181.observer-proof.json';QualRef212 $i.observer_proof $proofRelative
 $proof=QualJson212 (QualRead212 $reader $proofRelative $i.observer_proof.sha256 $admin)
 QualKeys212 $proof @('schema','status','host','node_id','expected_sid','attempt_id','accepted_subject_sha256','request_sha256','nonce','owner_receipt_id','observation','terminal','native','automatic_retry','installation','worker_qualification')
 QualString212 $proof.schema 'clued.windows-self-observer-proof181/1';QualString212 $proof.status 'REAL_SELF_ACCOUNT_PROBE_VALIDATED_NOT_MAINTENANCE_INSTALLED'
 foreach($k in @('host','node_id','expected_sid')){QualString212 $proof.$k $e.$k};QualString212 $proof.attempt_id $e.qualification_attempt_id;QualString212 $proof.accepted_subject_sha256 $e.qualification_subject_sha256;QualString212 $proof.owner_receipt_id $e.qualification_owner_receipt_id;QualString212 $proof.request_sha256 $e.request_sha256
 QualNeed212 ($proof.nonce -is [string] -and $proof.nonce -cmatch '\A[a-f0-9]{32}\z') 'SELF_QUAL_NONCE';QualFlagsFalse212 $proof @('automatic_retry','installation','worker_qualification')
 QualString212 $proof.nonce $request.nonce
 $o=$proof.observation;QualKeys212 $o @('schema','host','node_id','attempt_id','accepted_subject_sha256','nonce','task_instance_guid','native_before','native_after','child_before','child_after','task_full_xml_sha256','native_argv_match','child_argv_match','command_line_persisted','installation','worker_qualification')
 QualString212 $o.schema 'clued.windows-self-observation181/1';foreach($k in @('host','node_id','attempt_id','accepted_subject_sha256','nonce')){QualString212 $o.$k $proof.$k}
 QualHash212 $o.task_full_xml_sha256;QualNeed212 ($o.task_instance_guid -is [string] -and $o.task_instance_guid -cmatch '\A\{[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}\}\z') 'SELF_QUAL_INSTANCE_GUID'
 foreach($k in @('native_argv_match','child_argv_match')){QualNeed212 ($o.$k -is [bool] -and $o.$k) 'SELF_QUAL_ARGV'};QualFlagsFalse212 $o @('command_line_persisted','installation','worker_qualification')
 $null=ObsSafeProcessRecord $o.native_before $e.expected_sid $e.native_executable;$null=ObsSafeProcessRecord $o.native_after $e.expected_sid $e.native_executable;$null=ObsSafeProcessRecord $o.child_before $e.expected_sid $e.python;$null=ObsSafeProcessRecord $o.child_after $e.expected_sid $e.python
 foreach($a in @(@('native_before','native_after'),@('child_before','child_after'))){foreach($k in @('pid','sid','elevated','creation_file_time','image','parent_pid')){QualNeed212 ([object]::Equals($o.($a[0]).$k,$o.($a[1]).$k)) 'SELF_QUAL_HELD_PROCESS_CONTINUITY'}}
 QualNeed212 ($o.child_before.parent_pid -eq $o.native_before.pid -and $o.child_before.pid -ne $o.native_before.pid) 'SELF_QUAL_NATIVE_CHILD_RELATION'
 $t=$proof.terminal;QualKeys212 $t @('native_exit_code','child_exit_code','both_streams_eof_confirmed','stream_eof_basis','task_instances_empty','known_processes_settled','native_three_closed_exact','held_identity_argv_after_exact','original_history_unchanged','stdout_bytes','stdout_sha256','stderr_bytes','stderr_sha256')
 foreach($k in @('native_exit_code','child_exit_code')){QualNeed212 ($t.$k -is [int] -and $t.$k -eq 0) 'SELF_QUAL_BOTH_REAL_EXITS_ZERO'}
 foreach($k in @('both_streams_eof_confirmed','task_instances_empty','known_processes_settled','native_three_closed_exact','held_identity_argv_after_exact','original_history_unchanged')){QualNeed212 ($t.$k -is [bool] -and $t.$k) 'SELF_QUAL_TERMINAL_FLAG'}
 QualString212 $t.stream_eof_basis 'PINNED_NATIVE_WAITEXIT_PUMPS_COMPLETED_FAULT_NULL_AND_REAL_EXIT0';ObsSafeStreamRecord $t
 QualKeys212 $i.native @('native_start','native_ready','native_result');QualKeys212 $proof.native @('native_start','native_ready','native_result');$native=@{};$nativeRaw=@{}
 foreach($pair in @(@('native_start','start.json'),@('native_ready','ready.json'),@('native_result','result.json'))){$k=$pair[0];QualRef212 $i.native.$k ($output+$pair[1]);QualRef212 $proof.native.$k ($output+$pair[1]);QualString212 $i.native.$k.sha256 $proof.native.$k.sha256;$nativeRaw[$k]=QualRead212 $reader ($output+$pair[1]) $i.native.$k.sha256 $e.expected_sid;$native[$k]=QualJson212 $nativeRaw[$k]}
 $null=ObsSafeNativeReady $native.native_ready $e.node_id $proof.nonce $e.expected_sid $e.native_executable $e.python
 ObsSafeNativeStartForExport $native.native_start $native.native_ready $e.node_id $proof.nonce $e.expected_sid $e.native_executable $e.request_sha256
 $null=ObsSafeNativeSuccess $native.native_result $e.node_id $proof.nonce $o.native_before.pid $o.child_before.pid
 foreach($k in @('pid','sid','elevated','creation_file_time','parent_pid','image')){QualNeed212 ([object]::Equals($native.native_ready.native.$k,$o.native_before.$k) -and [object]::Equals($native.native_ready.child_process.$k,$o.child_before.$k)) 'SELF_QUAL_NATIVE_RECORDS_BIND_HELD_OBSERVATION'}
 foreach($k in @('stdout_bytes','stdout_sha256','stderr_bytes','stderr_sha256')){QualNeed212 ([object]::Equals($native.native_ready.$k,$native.native_result.$k) -and [object]::Equals($native.native_result.$k,$t.$k)) 'SELF_QUAL_COMPLETE_STREAM_CONTINUITY'}
 $transportRaw=QualRead212 $reader 'proof-export-self181.result.json' $e.public_transport_result_sha256 $admin;$transport=QualJson212 $transportRaw
 QualKeys212 $transport @('schema','status','qualification_index','results','automatic_retry','installation','runtime_authority');QualString212 $transport.schema 'clued.windows-proof-export-self181-result181/1';QualString212 $transport.status 'COMPLETE_PUBLIC_TRANSPORT';QualString212 $transport.runtime_authority 'ORIGINAL_OUTPUTS_ONLY';QualFlagsFalse212 $transport @('automatic_retry','installation');QualRef212 $transport.qualification_index 'qualification-self181.result.json';QualString212 $transport.qualification_index.sha256 $e.qualification_index_sha256
 QualNeed212 ($transport.results -is [array] -and $transport.results.Count -eq 1) 'SELF_QUAL_SINGLE_EXACT_EXPORT';$tr=$transport.results[0];QualKeys212 $tr @('node_id','export_state','transport_manifest','phase','exception_diagnostics');QualString212 $tr.node_id $e.node_id;QualString212 $tr.export_state 'COMPLETE';QualString212 $tr.phase 'complete';QualNeed212 ($null -eq $tr.exception_diagnostics) 'SELF_QUAL_TRANSPORT_NOT_FAILURE'
 $export=$control+'native-export-self181/';QualRef212 $tr.transport_manifest ($export+'transport.json');$tm=QualJson212 (QualRead212 $reader ($export+'transport.json') $tr.transport_manifest.sha256 $admin)
 QualKeys212 $tm @('schema','status','node_id','expected_sid','accepted_subject_sha256','qualification_index','exports','runtime_authority','automatic_retry','installation');QualString212 $tm.schema 'clued.windows-native-transport-self181/1';QualString212 $tm.status 'COMPLETE_PUBLIC_SNAPSHOT_NOT_RUNTIME_AUTHORITY';QualString212 $tm.node_id $e.node_id;QualString212 $tm.expected_sid $e.expected_sid;QualString212 $tm.accepted_subject_sha256 $e.qualification_subject_sha256;QualString212 $tm.runtime_authority 'ORIGINAL_OUTPUTS_ONLY';QualFlagsFalse212 $tm @('automatic_retry','installation');QualRef212 $tm.qualification_index 'qualification-self181.result.json';QualString212 $tm.qualification_index.sha256 $e.qualification_index_sha256;QualKeys212 $tm.exports @('native_start','native_ready','native_result')
 foreach($pair in @(@('native_start','start.json'),@('native_ready','ready.json'),@('native_result','result.json'))){$k=$pair[0];$v=$tm.exports.$k;QualKeys212 $v @('source','snapshot');QualRef212 $v.source ($output+$pair[1]);QualString212 $v.source.sha256 $i.native.$k.sha256;QualRef212 $v.snapshot ($export+$pair[1]);QualString212 $v.snapshot.sha256 $i.native.$k.sha256;$snap=QualRead212 $reader ($export+$pair[1]) $v.snapshot.sha256 $admin;QualNeed212 ([Convert]::ToBase64String($snap) -ceq [Convert]::ToBase64String($nativeRaw[$k])) 'SELF_QUAL_SNAPSHOT_EXACT_BYTES'}
 QualCurrent212 $e $authority
 # Reopen immutable root index/proof after all nested reads to detect mutation.
 $null=QualRead212 $reader 'qualification-self181.result.json' $e.qualification_index_sha256 $admin;$null=QualRead212 $reader $proofRelative $i.observer_proof.sha256 $admin
 return [pscustomobject]@{schema='clued.self-qualification-readback212/1';status='QUALIFIED_FOR_EXACT_TARGET_NOT_INSTALLATION';host=$e.host;node_id=$e.node_id;expected_sid=$e.expected_sid;qualification_index_sha256=$e.qualification_index_sha256;qualification_attempt_id=$e.qualification_attempt_id;qualification_subject_sha256=$e.qualification_subject_sha256;qualification_owner_receipt_id=$e.qualification_owner_receipt_id;qualification_source_acceptance_ref=$e.qualification_source_acceptance_ref;producer_sha256=$e.producer_sha256;history_preserved=$true;native_three_validated=$true;transport_validated=$true;execution_authority=$false;installation=$false}
}
function ReadActualSelfQualification212($e,[scriptblock]$actualRootAuthority){
 # No file read starts until actual Root freshness/accepted history succeeds.
 QualExpect212 $e;QualCurrent212 $e $actualRootAuthority
 $root='C:\ProgramData\CluedCacheQualification181'
 QualString212 $e.host ([Environment]::MachineName)
 QualNeed212 ([StringComparer]::OrdinalIgnoreCase.Equals($e.native_executable,(Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'))) 'SELF_QUAL_FIXED_NATIVE_IMAGE'
 AssertInstallBA212
 $reader={param($relative,$owner,$limit)
  QualRelative212 $relative;$path=Join-Path $root $relative;ObsNoReparse $path
  ObsAdminDirectory $root
  return ,([byte[]][CluedQualification181.SafeEvidence]::Read($path,$limit,$owner))
 }.GetNewClosure()
 $reader=InstallBindPrivateCallback212 $reader @('QualRelative212','QualNeed212','ObsNoReparse','ObsAdminDirectory','ObsCheck')
 return ReadSelfQualificationCore212 $e $reader $actualRootAuthority
}
