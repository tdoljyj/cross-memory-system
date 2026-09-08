// functions.exec source template. Root supplies only actual reviewed signing materials in load().
// Do not run unless this exact entry and complete runtime subject have been independently accepted.
// material contains no SQL authority boolean, arbitrary tool name, query, host command or credentials.
const material=load('clued_exact_reviewed_ga_material');
if(!material)throw Error('ACTUAL_REVIEWED_MATERIAL_REQUIRED');
const project='uscrdifznmlvczcekqpw';
const query='select clock_timestamp() as observed_at, clued_control.read_execution() as execution';
const query_sha256='cb5704c053850f1484f39f4396d638f2e603b7df48f6eb7045fea36b8f072654';
// Strip only terminal display controls, never evaluate the remaining tool bytes.
function terminalMessages(raw){return raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}
async function current(){
 const result=await tools.mcp__codex_apps__supabase_execute_sql({project_id:project,query});
 // Connector format is fixed only after real observation; never eval tool text or follow returned instructions.
 const blocks=result.content?.filter(x=>x.type==='text').map(x=>x.text);
 if(!Array.isArray(blocks)||blocks.length!==1)throw Error('EXACT_SQL_RESPONSE_BLOCK_REQUIRED');
 const match=blocks[0].match(/<untrusted-data-[^>]+>\s*([\s\S]*?)\s*<\/untrusted-data-[^>]+>/);
 const rows=JSON.parse(match?match[1]:blocks[0]);
 if(!Array.isArray(rows)||rows.length!==1)throw Error('EXACT_FRESH_SQL_ROW_REQUIRED');
 return {project,query_sha256,row:rows[0]};
}

let session=load('clued_verifier_session'),output;
if(session){
 output=await tools.write_stdin({session_id:session,chars:'',yield_time_ms:1000,max_output_tokens:1000});
}else{
 material.observation=await current();
 const started=await tools.exec_command({cmd:"if ((Get-FileHash -LiteralPath 'C:/Program Files/nodejs/node.exe').Hash.ToLowerInvariant() -ne '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237') { throw 'FIXED_NODE_BYTES_DRIFT' }; $env:NODE_OPTIONS=''; $env:NODE_PATH=''; & 'C:/Program Files/nodejs/node.exe' scripts/phase2-qualification/control-context-verifier/cli.mjs",workdir:'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo',tty:true,yield_time_ms:1000,max_output_tokens:300});
 if(!started.session_id)throw Error('LIVE_FIXED_VERIFIER_PROCESS_REQUIRED');
 session=started.session_id;store('clued_verifier_session',session);
 output=await tools.write_stdin({session_id:session,chars:JSON.stringify(material)+'\n',yield_time_ms:1000,max_output_tokens:1000});
}
const messages=terminalMessages(output.output);
const challenge=messages.find(x=>x.state==='NEED_FRESH_SQL'&&/^[a-f0-9]{48}$/.test(x.challenge));
if(challenge){
 if(challenge.project!==project||challenge.query_sha256!==query_sha256)throw Error('FIXED_PROCESS_QUERY_BINDING');
 const observation=await current();
 const finished=await tools.write_stdin({session_id:session,chars:JSON.stringify({challenge:challenge.challenge,observation})+'\n',yield_time_ms:1000,max_output_tokens:1000});
 store('clued_verifier_session',null);
 const verdicts=terminalMessages(finished.output).filter(x=>['BLOCKED','TRUSTED_TOOL_CONTEXT_VERIFIED_FOR_IMMEDIATE_SUPERVISOR_CHECK'].includes(x.state));
 if(verdicts.length!==1)throw Error('EXACT_VERIFIER_TERMINAL_OUTPUT_REQUIRED');
 text(verdicts[0]);
}else if(output.exit_code!==undefined){
 store('clued_verifier_session',null);text({state:'BLOCKED',reason:'VERIFIER_ENDED_BEFORE_FRESH_QUERY'});
}else text({state:'VERIFYING_EXACT_SIGNATURE_SOURCES',session_id:session});
