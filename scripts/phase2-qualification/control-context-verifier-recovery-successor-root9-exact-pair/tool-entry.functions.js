// Root-only fixed tools program, after exact independent acceptance. No caller-selected tool/query/command.
// The same pure functions are embedded verbatim into the fixed functions entry.
function parseSqlResult(result){
 if(result?.isError===true||!Array.isArray(result?.content)||result.content.length!==1||result.content[0]?.type!=='text')throw Error('EXACT_NONERROR_SQL_BLOCK_REQUIRED');
 const envelope=JSON.parse(result.content[0].text);
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).length!==1||typeof envelope.result!=='string')throw Error('EXACT_SQL_RESULT_ENVELOPE_REQUIRED');
 const lines=envelope.result.split(/\r?\n/),starts=[],ends=[];
 for(let i=0;i<lines.length;i++){let m=lines[i].match(/^<untrusted-data-([A-Za-z0-9-]+)>$/);if(m)starts.push({i,id:m[1]});m=lines[i].match(/^<\/untrusted-data-([A-Za-z0-9-]+)>$/);if(m)ends.push({i,id:m[1]});}
 if(starts.length!==1||ends.length!==1||starts[0].id!==ends[0].id||starts[0].i>=ends[0].i)throw Error('EXACT_PAIRED_SQL_BOUNDARIES_REQUIRED');
 const rows=JSON.parse(lines.slice(starts[0].i+1,ends[0].i).join('\n'));
 if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0]!=='object'||Array.isArray(rows[0]))throw Error('EXACT_SINGLE_SQL_ROW_REQUIRED');
 return rows[0];
}
function recordQuery(intent){
 if(!intent||typeof intent.gaId!=='string'||!/^ga_[A-Za-z0-9_.-]+$/.test(intent.gaId)||!/^intent_[a-f0-9]{64}$/.test(intent.key)||!['CREATE','START'].includes(intent.body?.operation)||typeof intent.body.raw!=='string'||intent.body.raw.length>131072||!/^[a-f0-9]{64}$/.test(intent.body.sha256))throw Error('FIXED_INTENT_QUERY_INPUT');
 const quote=x=>"'"+x.replaceAll("'","''")+"'";
 return 'select clued_control.record_effect_intent('+quote(intent.gaId)+','+quote(intent.key)+','+quote(JSON.stringify(intent.body))+'::jsonb) as recorded';
}
function dispatchQuery(intent,sequence,key){
 recordQuery(intent);
 if(!Number.isSafeInteger(sequence)||sequence<1||!/^clued_[a-f0-9]{64}$/.test(key))throw Error('FIXED_DISPATCH_QUERY_INPUT');
 const quote=x=>"'"+x.replaceAll("'","''")+"'";
 return 'select clued_control.dispatch_recorded_intent('+quote(intent.gaId)+','+quote(intent.body.operation+'_SENT')+','+quote(key)+','+sequence+','+quote(intent.body.sha256)+') as dispatched';
}

function terminalMessages(raw){return raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}
const project='uscrdifznmlvczcekqpw',query='select clock_timestamp() as observed_at, clued_control.read_execution() as execution';
const query_sha256='cb5704c053850f1484f39f4396d638f2e603b7df48f6eb7045fea36b8f072654';
async function actualSql(query){
 if(typeof tools?.mcp__codex_apps__supabase_execute_sql!=='function')throw Error('NATIVE_SUPABASE_SQL_TOOL_REQUIRED');
 const result=await tools.mcp__codex_apps__supabase_execute_sql({project_id:project,query});return {project,query,row:parseSqlResult(result)};
}
let session=load('clued_verifier_source_diagnostic600_session'),output;
if(session){output=await tools.write_stdin({session_id:session,chars:'',yield_time_ms:1000,max_output_tokens:40000});}
else{
 const material=load('clued_exact_reviewed_ga_material');if(!material)throw Error('ACTUAL_REVIEWED_MATERIAL_REQUIRED');
 const observation=await actualSql(query),expected=observation.row.execution?.binding?.controller_sha256;
 if(!/^[a-f0-9]{64}$/.test(expected))throw Error('ACTUAL_SQL_CONTROLLER_SOURCE_DIGEST_REQUIRED');
 material.observation={project,query_sha256,row:observation.row};
 // Expected digest comes from this actual fixed private SQL call, not supplied material.
 // No self-digest cycle: the source manifest excludes itself and all acceptance/signing metadata.
 // Linux successor of the PowerShell entry. Checks, in order: manifest digest against the value
 // this process read from SQL, the interpreter's own bytes, manifest shape, no __pycache__ under
 // the tree, every listed file's length and sha256, the node binary's bytes, then exec with
 // NODE_OPTIONS and NODE_PATH cleared. python3.11 takes the role PowerShell had -- a system
 // interpreter validating the sources before node is started, so the runtime being checked is not
 // the runtime doing the checking.
 //
 // Two holes were found here after the port and are closed above; both were reproduced first.
 //   - sha256sum and cut were invoked bare, so $PATH chose them. A sha256sum earlier in PATH that
 //     echoes whatever digest the caller is about to compare against defeated BOTH the manifest
 //     gate and the node gate: with a deliberately wrong expected manifest digest the entry still
 //     reached cli.mjs and printed the same BOUNDED_STDIN_INPUT_REQUIRED as an honest run. PATH is
 //     now set before anything runs and both commands are absolute.
 //   - the interpreter that performs every per-file byte check was itself unchecked. Standing an
 //     interpreter that only does "exit 0" in its place skipped all declared file comparisons and the
 //     entry proceeded to node, again indistinguishably from an honest run. Its bytes are now
 //     verified before it is invoked, by the same sha256sum the manifest gate uses.
 //
 // Residual, stated rather than papered over: the shell binary itself is chosen by the harness's
 // exec_command, not by this script, so it cannot be pinned from here. /usr/bin/dash is in the
 // manifest, but nothing forces the harness to use it. That is the remaining root of trust,
 // alongside /usr/bin/sha256sum and /usr/bin/cut, which the manifest does pin.
 const cmd=`set -eu
PATH=/usr/bin:/bin
export PATH
REPO=/home/user/cross-memory-system
MAN="\$REPO/scripts/phase2-qualification/control-context-verifier-recovery-successor-root9-exact-pair/ControllerSourceManifest.candidate.json"
test "\$(/usr/bin/sha256sum "\$MAN" | /usr/bin/cut -d\" \" -f1)" = "${expected}" || { echo ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT >&2; exit 1; }
test "\$(/usr/bin/sha256sum /usr/bin/python3.11 | /usr/bin/cut -d\" \" -f1)" = "f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e" || { echo FIXED_PYTHON_BYTES_DRIFT >&2; exit 1; }
/usr/bin/python3.11 -I -S -B -c 'import json,hashlib,os,sys
man=sys.argv[1]; repo=sys.argv[2]
d=json.load(open(man))
if d.get("object_type")!="ControllerSourceManifest" or d.get("qualification_issued") is not False or len(d.get("files",[]))!=23:
    sys.exit("EXACT_SOURCE_MANIFEST_REQUIRED")
qual=os.path.dirname(os.path.dirname(man))
for root,dirs,_ in os.walk(qual):
    if "node_modules" in dirs: dirs.remove("node_modules")
    if "__pycache__" in dirs: sys.exit("CONTROLLER_BYTECODE_CACHE_PRESENT")
for e in d["files"]:
    q=e["path"] if os.path.isabs(e["path"]) else os.path.join(repo,e["path"])
    b=open(q,"rb").read()
    if len(b)!=e["bytes"] or hashlib.sha256(b).hexdigest()!=e["sha256"]:
        sys.exit("EXACT_CONTROLLER_SOURCE_BYTES_DRIFT")
' "\$MAN" "\$REPO"
test "\$(/usr/bin/sha256sum /opt/node22/bin/node | /usr/bin/cut -d\" \" -f1)" = "81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90" || { echo FIXED_NODE_BYTES_DRIFT >&2; exit 1; }
cd "\$REPO"
NODE_OPTIONS= NODE_PATH= exec /opt/node22/bin/node scripts/phase2-qualification/control-context-verifier-recovery-successor-root9-exact-pair/cli.mjs`;

 const started=await tools.exec_command({cmd,workdir:'/home/user/cross-memory-system',sandbox_permissions:'require_escalated',justification:'Execute the independently accepted fixed Clued nonproduction controller after actual SQL source-digest checks, using the existing explicitly authorized qualification scope.',tty:true,yield_time_ms:1000,max_output_tokens:500});
 if(!started.session_id)throw Error('LIVE_FIXED_VERIFIER_PROCESS_REQUIRED');session=started.session_id;store('clued_verifier_source_diagnostic600_session',session);
 output=await tools.write_stdin({session_id:session,chars:JSON.stringify(material)+'\n',yield_time_ms:1000,max_output_tokens:40000});
}
let messages=terminalMessages(output.output);
const resultReady=messages.find(x=>x.state==='NEED_FRESH_RESULT_CONTEXT'&&/^[a-f0-9]{48}$/.test(x.challenge));
if(resultReady){
 if(resultReady.project!==project)throw Error('FIXED_RESULT_NODE_PROJECT_REQUIRED');
 const fresh=await actualSql(query);
 output=await tools.write_stdin({session_id:session,chars:JSON.stringify({challenge:resultReady.challenge,observation:{project,query_sha256,row:fresh.row}})+'\n',yield_time_ms:1000,max_output_tokens:40000});
 messages=terminalMessages(output.output);
}
const ready=messages.find(x=>x.state==='NEED_COMMITTED_DISPATCH'&&/^[a-f0-9]{48}$/.test(x.challenge));
if(ready){
 if(ready.project!==project)throw Error('FIXED_NODE_PROJECT_REQUIRED');
 // Two separately committed actual tool calls. Any failure leaves the live process/slot UNKNOWN.
 const record=await actualSql(recordQuery(ready.intent));
 if(record.row.recorded?.status!=='RECORDED'||record.row.recorded.phase!=='INTENT_RECORDED')throw Error('NO_DISPATCH_ON_OLD_OR_UNKNOWN_INTENT');
 const dispatch=await actualSql(dispatchQuery(ready.intent,record.row.recorded.sequence,ready.dispatch_key));
 output=await tools.write_stdin({session_id:session,chars:JSON.stringify({challenge:ready.challenge,record,dispatch})+'\n',yield_time_ms:1000,max_output_tokens:40000});
 messages=terminalMessages(output.output);
}
const actual=messages.find(x=>x.state==='ACTUAL_HOST_EFFECT_REQUIRES_REMOTE_RESULT');
const terminal=messages.find(x=>x.state==='EXACT_RESULT_REQUIRES_TERMINAL_CAS');
if(terminal){
 store('clued_unpersisted_exact_grr',terminal);
 const request=terminal.request;
 if(typeof request?.raw!=='string'||request.raw.length>131072||!/^[a-f0-9]{64}$/.test(request.sha256)||!/^[a-f0-9]{64}$/.test(request.decision_sha256))throw Error('EXACT_SIGNED_RESULT_CAS_REQUIRED');
 const committed=await actualSql("select clued_control.commit_gate_result('"+request.raw.replaceAll("'","''")+"','"+request.sha256+"','"+request.decision_sha256+"') as committed");
 if(committed.row.committed?.status!=='COMMITTED'||committed.row.committed.receipt_sha256!==request.sha256||committed.row.committed.result!==terminal.result)throw Error('RESULT_COMMIT_UNKNOWN_NO_RETRY');
 const readback=await actualSql(query),attempts=readback.row.execution?.attempts?.filter(a=>a.ga_id===terminal.ga_id);
 if(attempts?.length!==1||attempts[0].receipt_raw!==request.raw||attempts[0].receipt_sha256!==request.sha256||attempts[0].receipt_id!==terminal.receipt_id||attempts[0].phase!==terminal.result||readback.row.execution.current.active_ga_id!==null)throw Error('EXACT_RESULT_READBACK_REQUIRED');
 store('clued_last_durable_grr',{terminal,committed,readback});store('clued_unpersisted_exact_grr',null);store('clued_verifier_source_diagnostic600_session',null);
 text({state:'EXACT_SIGNED_GRR_COMMITTED_AND_READ_BACK',result:terminal.result,receipt_id:terminal.receipt_id,qualified:false,automatic_retry:false});
}else if(actual){
 store('clued_unpersisted_host_result',actual);
 const serialized=JSON.stringify(actual.event_request);
 if(serialized.length>262144||!['CREATED','RUNNING'].includes(actual.event_request?.operation))throw Error('EXACT_FIXED_HOST_EVENT_REQUIRED');
 const recorded=await actualSql("select clued_control.execution_transition('"+serialized.replaceAll("'","''")+"'::jsonb) as recorded");
 if(recorded.row.recorded?.status!=='RECORDED'||recorded.row.recorded.phase!==actual.event_request.operation)throw Error('REMOTE_RESULT_UNKNOWN_PRESERVE_ACTUAL_OBSERVATION');
 store('clued_unpersisted_host_result',null);store('clued_verifier_source_diagnostic600_session',null);store('clued_last_durable_host_result',{actual,recorded});
 text({state:'ACTUAL_HOST_OBSERVATION_DURABLY_RECORDED',operation:actual.operation,container_id:actual.container_id,capacity_released:false,qualified:false});
}else{
 const ended=messages.find(x=>['BLOCKED','UNKNOWN'].includes(x.state));
 if(ended){store('clued_verifier_source_diagnostic600_session',null);text(ended);}
 else if(output.exit_code!==undefined){store('clued_verifier_source_diagnostic600_session',null);text({state:'UNKNOWN',reason:'NO_EXACT_TERMINAL_RESULT',capacity_released:false,automatic_retry:false});}
 else text({state:'FIXED_VERIFIER_OR_HOST_PROCESS_RUNNING'});
}

