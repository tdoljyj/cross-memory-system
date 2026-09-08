// Execute only through the trusted root tools after exact independent source acceptance.
// This shell has no effect dispatch, retry, budget, or admission mutation.
function parseSqlResult(result){
 if(result?.isError===true||!Array.isArray(result?.content)||result.content.length!==1||result.content[0]?.type!=='text')throw Error('EXACT_NONERROR_SQL_BLOCK_REQUIRED');
 const envelope=JSON.parse(result.content[0].text);if(!envelope||Object.keys(envelope).length!==1||typeof envelope.result!=='string')throw Error('EXACT_SQL_ENVELOPE');
 const lines=envelope.result.split(/\r?\n/),starts=[],ends=[];
 for(let i=0;i<lines.length;i++){let m=lines[i].match(/^<untrusted-data-([A-Za-z0-9-]+)>$/);if(m)starts.push({i,id:m[1]});m=lines[i].match(/^<\/untrusted-data-([A-Za-z0-9-]+)>$/);if(m)ends.push({i,id:m[1]});}
 if(starts.length!==1||ends.length!==1||starts[0].id!==ends[0].id||starts[0].i>=ends[0].i)throw Error('EXACT_SQL_BOUNDARIES');
 const rows=JSON.parse(lines.slice(starts[0].i+1,ends[0].i).join('\n'));if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0]!=='object')throw Error('ONE_ACTUAL_SQL_ROW');return rows[0];
}
function terminalMessages(raw){return raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}
const project='uscrdifznmlvczcekqpw',query='select clock_timestamp() as observed_at, clued_control.read_execution() as execution',query_sha256='cb5704c053850f1484f39f4396d638f2e603b7df48f6eb7045fea36b8f072654';
async function actualSql(query){const result=await tools.mcp__codex_apps__supabase_execute_sql({project_id:project,query});return {project,query,row:parseSqlResult(result)};}
const material=load('clued_exact_recovery_material');if(!material||material.operation!=='GRR')throw Error('ACTUAL_REVIEWED_RECOVERY_MATERIAL_REQUIRED');
const requested=JSON.parse(material.grr_raw);if(!['FAIL','BLOCKED','STALE'].includes(requested.result))throw Error('NONPASS_ONLY');
const review=JSON.parse(material.recovery_source_acceptance.raw),expected=review.recovery_source_manifest_sha256;
if(review.state!=='ACCEPTED_EXACT_RECORDED_INTENT_NONPASS_RECOVERY_SOURCES'||!/^grr_[A-Za-z0-9_-]{1,128}$/.test(requested.gate_result_receipt_id)||!/^[a-f0-9]{64}$/.test(expected))throw Error('EXACT_RECOVERY_ACCEPTANCE_INPUT');
const attemptKey='clued_recovery_once_'+requested.gate_result_receipt_id;let attempt=load(attemptKey),output;
try{
 if(!attempt){
  attempt={state:'PROCESS_LAUNCH_RESERVED',ga_id:requested.gate_authorization_id,receipt_id:requested.gate_result_receipt_id,manifest:expected,input_sent:false,commit_sent:false};store(attemptKey,attempt);
  const cmd=`$ErrorActionPreference='Stop'; $taskRepo='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo'; $taskDir=Join-Path $taskRepo 'scripts/phase2-qualification/recorded-intent-nonpass-successor'; $taskManifest=Join-Path $taskDir 'RecoverySourceManifest.json'; if((Get-FileHash -LiteralPath $taskManifest).Hash.ToLowerInvariant() -ne '${expected}'){throw 'EXACT_RECOVERY_MANIFEST_DRIFT'}; $taskSource=Get-Content -Raw -LiteralPath $taskManifest|ConvertFrom-Json; foreach($taskEntry in $taskSource.files){if($taskEntry.path -notmatch '^[A-Za-z0-9_.-]+$'){throw 'FIXED_RECOVERY_PATH'}; $taskPath=Join-Path $taskDir $taskEntry.path; if((Get-Item -LiteralPath $taskPath).Length -ne $taskEntry.bytes -or (Get-FileHash -LiteralPath $taskPath).Hash.ToLowerInvariant() -ne $taskEntry.sha256){throw 'RECOVERY_SOURCE_BYTES_DRIFT'}}; $taskOriginal=Join-Path $taskRepo 'scripts/phase2-qualification/control-context-verifier-runtime600/ControllerSourceManifest.candidate.json'; if((Get-FileHash -LiteralPath $taskOriginal).Hash.ToLowerInvariant() -ne 'edf31377656e1a9a473d0095df72231c058266007e4fd4046e0a9b8c2d6a60d9'){throw 'ORIGINAL_MANIFEST_DRIFT'}; $taskOld=Get-Content -Raw -LiteralPath $taskOriginal|ConvertFrom-Json; if($taskOld.files.Count -ne 201){throw 'ORIGINAL_201_REQUIRED'}; foreach($taskEntry in $taskOld.files){$taskPath=if([System.IO.Path]::IsPathRooted($taskEntry.path)){$taskEntry.path}else{Join-Path $taskRepo $taskEntry.path}; if((Get-Item -LiteralPath $taskPath).Length -ne $taskEntry.bytes -or (Get-FileHash -LiteralPath $taskPath).Hash.ToLowerInvariant() -ne $taskEntry.sha256){throw 'ORIGINAL_SOURCE_DRIFT'}}; if((Get-FileHash -LiteralPath 'C:/Program Files/nodejs/node.exe').Hash.ToLowerInvariant() -ne '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'){throw 'FIXED_NODE_BYTES'}; $env:NODE_OPTIONS=''; $env:NODE_PATH=''; & 'C:/Program Files/nodejs/node.exe' scripts/phase2-qualification/recorded-intent-nonpass-successor/recovery-cli.mjs`;
  output=await tools.exec_command({cmd,workdir:'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo',sandbox_permissions:'require_escalated',justification:'Run the independently accepted fixed nonproduction no-effect recovery verifier; only the original non-PASS result CAS is permitted after complete signatures and fresh context.',tty:true,yield_time_ms:1000,max_output_tokens:2000});
  if(!output.session_id)throw Error('LIVE_RECOVERY_VERIFIER_REQUIRED');attempt.session=output.session_id;store(attemptKey,attempt);
 }else{
  if(!attempt.session||['UNKNOWN','COMMITTED_READ_BACK'].includes(attempt.state)||attempt.receipt_id!==requested.gate_result_receipt_id||attempt.ga_id!==requested.gate_authorization_id||attempt.manifest!==expected)throw Error('NO_AUTOMATIC_RECOVERY_RETRY');
  output=await tools.write_stdin({session_id:attempt.session,chars:'',yield_time_ms:1000,max_output_tokens:40000});
 }
 let messages=terminalMessages(output.output);
 if(messages.some(x=>x.state==='READY_FOR_RECOVERY_INPUT'&&x.project===project)){
  if(attempt.input_sent)throw Error('ONE_MATERIAL_SEND_ONLY');attempt.input_sent=true;store(attemptKey,attempt);
  // All process/source startup finishes BEFORE the first actual SQL freshness clock.
  const initial=await actualSql(query);material.observation={project,query_sha256,row:initial.row};attempt.initial=initial;store(attemptKey,attempt);
  output=await tools.write_stdin({session_id:attempt.session,chars:JSON.stringify(material)+'\n',yield_time_ms:1000,max_output_tokens:40000});messages=terminalMessages(output.output);
 }
 const freshNeeded=messages.find(x=>x.state==='NEED_FRESH_RESULT_CONTEXT'&&x.project===project&&/^[a-f0-9]{48}$/.test(x.challenge));
 if(freshNeeded){
  if(attempt.challenge_sent)throw Error('ONE_FRESH_FINISH_ONLY');attempt.challenge_sent=true;store(attemptKey,attempt);
  const fresh=await actualSql(query);attempt.fresh=fresh;store(attemptKey,attempt);
  output=await tools.write_stdin({session_id:attempt.session,chars:JSON.stringify({challenge:freshNeeded.challenge,observation:{project,query_sha256,row:fresh.row}})+'\n',yield_time_ms:1000,max_output_tokens:40000});messages=terminalMessages(output.output);
 }
 const terminal=messages.find(x=>x.state==='EXACT_RESULT_REQUIRES_TERMINAL_CAS');
 if(terminal){
  if(attempt.commit_sent||!attempt.challenge_sent||terminal.ga_id!==attempt.ga_id||terminal.receipt_id!==attempt.receipt_id||!['FAIL','BLOCKED','STALE'].includes(terminal.result)||terminal.result!==requested.result)throw Error('ONE_EXACT_NONPASS_TERMINAL_ONLY');
  const r=terminal.request;if(r?.raw!==material.grr_raw||typeof r.raw!=='string'||r.raw.length>131072||!/^[a-f0-9]{64}$/.test(r.sha256)||!/^[a-f0-9]{64}$/.test(r.decision_sha256))throw Error('EXACT_SIGNED_RECEIPT_CAS_REQUIRED');
  attempt.commit_sent=true;attempt.terminal=terminal;store(attemptKey,attempt);
  const q=x=>"'"+x.replaceAll("'","''")+"'";
  const committed=await actualSql('select clued_control.commit_gate_result('+q(r.raw)+','+q(r.sha256)+','+q(r.decision_sha256)+') as committed');attempt.committed=committed;store(attemptKey,attempt);
  if(committed.row.committed?.status!=='COMMITTED'||committed.row.committed.receipt_sha256!==r.sha256||committed.row.committed.result!==terminal.result)throw Error('COMMIT_UNKNOWN_PRESERVE_NO_RETRY');
  const readback=await actualSql(query),s=readback.row.execution,rows=s?.attempts?.filter(a=>a.ga_id===terminal.ga_id),prior=attempt.fresh.row.execution;
  if(rows?.length!==1||rows[0].receipt_raw!==r.raw||rows[0].receipt_sha256!==r.sha256||rows[0].receipt_id!==terminal.receipt_id||rows[0].phase!==terminal.result||rows[0].container_id!==null||rows[0].revoked!==true||s.current.active_ga_id!==null||s.current.pending_budget_sequence!==null||s.current.charged_seconds!==prior.current.charged_seconds||s.current.charged_evidence_bytes!==prior.current.charged_evidence_bytes)throw Error('EXACT_NONPASS_READBACK_NO_REFUND_REQUIRED');
  attempt.state='COMMITTED_READ_BACK';attempt.readback=readback;store(attemptKey,attempt);text({state:'EXACT_NOT_STARTED_NONPASS_GRR_COMMITTED_READ_BACK',result:terminal.result,receipt_id:terminal.receipt_id,qualified:false,budget_refunded:false,automatic_retry:false});
 }else{
  const ended=messages.find(x=>['BLOCKED','UNKNOWN'].includes(x.state));if(ended||output.exit_code!==undefined)throw Error(ended?.reason??'NO_EXACT_RECOVERY_RESULT');text({state:'RECOVERY_VERIFIER_IN_PROGRESS_NO_SIDE_EFFECT_DISPATCH'});
 }
}catch(error){attempt.state='UNKNOWN';attempt.reason=error.message;attempt.last_output=output;store(attemptKey,attempt);text({state:'UNKNOWN',reason:error.message,capacity_released:false,budget_refunded:false,automatic_retry:false});}
