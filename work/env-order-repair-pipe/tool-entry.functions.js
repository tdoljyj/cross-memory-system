// Transport byte identity only; no signing or authority decisions.
function utf8(raw){
 if(typeof raw!=='string')throw Error('STRING_REQUIRED');
 const b=[];for(const c of raw){const n=c.codePointAt(0);if(n>=0xd800&&n<=0xdfff)throw Error('INVALID_UNICODE');if(n<128)b.push(n);else if(n<2048)b.push(192|n>>6,128|n&63);else if(n<65536)b.push(224|n>>12,128|n>>6&63,128|n&63);else b.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|n&63);}return new Uint8Array(b);
}
function sha256(raw){
 const input=utf8(raw),size=Math.ceil((input.length+9)/64)*64,b=new Uint8Array(size);b.set(input);b[input.length]=128;
 const bits=input.length*8;for(let i=0;i<8;i++)b[size-1-i]=Math.floor(bits/2**(i*8))&255;
 const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
 const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],r=(x,n)=>(x>>>n)|(x<<(32-n)),w=new Uint32Array(64);
 for(let p=0;p<size;p+=64){for(let i=0;i<16;i++){const j=p+i*4;w[i]=(b[j]<<24)|(b[j+1]<<16)|(b[j+2]<<8)|b[j+3];}for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(r(x,7)^r(x,18)^(x>>>3))+w[i-7]+(r(y,17)^r(y,19)^(y>>>10)))>>>0;}
 let [a,c,d,e,f,g,j,l]=h;for(let i=0;i<64;i++){const t=(l+(r(f,6)^r(f,11)^r(f,25))+((f&g)^(~f&j))+k[i]+w[i])>>>0,u=((r(a,2)^r(a,13)^r(a,22))+((a&c)^(a&d)^(c&d)))>>>0;l=j;j=g;g=f;f=(e+t)>>>0;e=d;d=c;c=a;a=(t+u)>>>0;}const v=[a,c,d,e,f,g,j,l];for(let i=0;i<8;i++)h[i]=(h[i]+v[i])>>>0;
 }return h.map(x=>x.toString(16).padStart(8,'0')).join('');
}

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
// External byte transport only. Explicit successor entry pin; e34 scheduling logic preserved; old 201 remains historical.
const loadedEntry=load('clued_reviewed_entry600_source');if(loadedEntry?.sha256!=='f2a79d015764685b724727e3aa2a7ba17e8e604535386ed3fc43a9b5b3187667'||typeof loadedEntry.raw!=='string'||sha256(loadedEntry.raw)!=='f2a79d015764685b724727e3aa2a7ba17e8e604535386ed3fc43a9b5b3187667')throw Error('EXACT_SUCCESSOR_ENTRY_RAW_REQUIRED');
const material=load('clued_exact_reviewed_ga_material');if(!material)throw Error('EXACT_ORIGINAL_MATERIAL_REQUIRED');
const ga=JSON.parse(material.ga_raw).gate_authorization_id,op=material.operation;
if(!/^ga_[a-f0-9]{32}$/.test(ga)||!['CREATE','START','GRR'].includes(op))throw Error('FIXED_GA_OPERATION');
const key='clued_normal600_env_repair_pipe_transport_'+ga+'_'+op;let attempt=load(key);
if(attempt?.state==='UNKNOWN')throw Error('NO_UNKNOWN_TRANSPORT_RETRY');
if(!attempt){attempt={state:'PREPARING',ga,op,offset:0,source_refs:[{"name":"ready-loader.mjs","sha256":"87fae23369b28e2258c3fb99a15a775b635a8e0e7a2848997ea0ca88b7e34220"},{"name":"launcher.mjs","sha256":"8594a1832c7ff847d581c706e6b595a4f2e6b9fcf26c9d923fe1a3e7aa106bd9"},{"name":"read-output.mjs","sha256":"a826d721e2947de4b88dcad286a749705b776a840f3eaff6d7cff7579562eaeb"},{"name":"message.mjs","sha256":"178bd429a4b4a5bf2c9eba33b0773123437cd0a4b268324920c93072ca5b07cb"},{"name":"deliver.mjs","sha256":"f04351149f3f5cd43ad4b6a89620c1af045c1f46ef32f0586f132f6bd85f8a27"},{"name":"sha256.mjs","sha256":"14fd1d0b3378d57bf75688a3e9a558e5c5e52e8514d345440437d5768631fdf9"},{"name":"stderr-archive.mjs","sha256":"4742ba5580bc01726556401739c97f75a2c56847bd9e6bc2f55e9459833c8b36"}],records:[]};store(key,attempt);}
const checks="if((Get-FileHash 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/stderr-archive.mjs').Hash.ToLowerInvariant() -ne '4742ba5580bc01726556401739c97f75a2c56847bd9e6bc2f55e9459833c8b36'){throw 'TRANSPORT_SOURCE_DRIFT'}; if((Get-FileHash 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/ready-loader.mjs').Hash.ToLowerInvariant() -ne '87fae23369b28e2258c3fb99a15a775b635a8e0e7a2848997ea0ca88b7e34220'){throw 'TRANSPORT_SOURCE_DRIFT'}; if((Get-FileHash 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/launcher.mjs').Hash.ToLowerInvariant() -ne '8594a1832c7ff847d581c706e6b595a4f2e6b9fcf26c9d923fe1a3e7aa106bd9'){throw 'TRANSPORT_SOURCE_DRIFT'}; if((Get-FileHash 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/read-output.mjs').Hash.ToLowerInvariant() -ne 'a826d721e2947de4b88dcad286a749705b776a840f3eaff6d7cff7579562eaeb'){throw 'TRANSPORT_SOURCE_DRIFT'}; if((Get-FileHash 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/message.mjs').Hash.ToLowerInvariant() -ne '178bd429a4b4a5bf2c9eba33b0773123437cd0a4b268324920c93072ca5b07cb'){throw 'TRANSPORT_SOURCE_DRIFT'}; if((Get-FileHash 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/deliver.mjs').Hash.ToLowerInvariant() -ne 'f04351149f3f5cd43ad4b6a89620c1af045c1f46ef32f0586f132f6bd85f8a27'){throw 'TRANSPORT_SOURCE_DRIFT'}; if((Get-FileHash 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/sha256.mjs').Hash.ToLowerInvariant() -ne '14fd1d0b3378d57bf75688a3e9a558e5c5e52e8514d345440437d5768631fdf9'){throw 'TRANSPORT_SOURCE_DRIFT'}; ",cwd='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo';
async function capture(result){
 attempt.records.push({kind:'ACTUAL_PTY_TOOL_RESULT',result});store(key,attempt);
 const read=await tools.exec_command({cmd:checks+"& 'C:/Program Files/nodejs/node.exe' 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/read-output.mjs' '"+ga+"' '"+op+"' '"+attempt.offset+"'",workdir:cwd,sandbox_permissions:'require_escalated',justification:'Read exact fixed original verifier stdout bytes without terminal rendering; no SQL or effect dispatch.',max_output_tokens:200000});
 if(read.exit_code!==0)throw Error('EXACT_ORIGINAL_STDOUT_READ');
 const observed=JSON.parse(read.output);if(!Number.isSafeInteger(observed.next_offset)||observed.next_offset<attempt.offset||typeof observed.output!=='string')throw Error('EXACT_MONOTONIC_STDOUT_READ');
 if(!attempt.context_ready){attempt.records.push({kind:'ACTUAL_PRE_READY_STDERR_ARCHIVE',stderr_archive:observed.stderr_archive});store(key,attempt);return result;}
 attempt.records.push({kind:'ACTUAL_STDOUT_BYTES',...observed});attempt.offset=observed.next_offset;store(key,attempt);
 return {...result,output:observed.output};
}
const ports={
 mcp__codex_apps__supabase_execute_sql:async args=>{
  if(args.project_id!=='uscrdifznmlvczcekqpw')throw Error('FIXED_ORIGINAL_PROJECT');
  if(args.query.startsWith('select clued_control.commit_gate_result(')){
   const read=attempt.last_actual_current_row,now=Date.now(),age=now-Date.parse(read?.observed_at);
   if(op!=='GRR'||!Number.isFinite(age)||age< -1000||age>15000)throw Error('ORIGINAL_GRR_CAS_FRESHNESS_EXPIRED_NO_COMMIT');
   attempt.records.push({kind:'ACTUAL_CAS_PREFLIGHT_CLOCK',observed_at:read.observed_at,checked_at:new Date(now).toISOString(),age_ms:age});store(key,attempt);
  }
  const result=await tools.mcp__codex_apps__supabase_execute_sql(args);
  if(args.query==='select clock_timestamp() as observed_at, clued_control.read_execution() as execution'){attempt.last_actual_current_row=parseSqlResult(result);store(key,attempt);}
  return result;
 },
 exec_command:async args=>{
  const tail="& 'C:/Program Files/nodejs/node.exe' scripts/phase2-qualification/control-context-verifier-actual-env-order-repair-successor/cli.mjs";
  if(attempt.session||!args.cmd.endsWith(tail)||args.workdir!==cwd)throw Error('FIXED_ORIGINAL_NODE_LAUNCH_ONLY');
  const rt=material.runtime_acceptance;if(!rt||typeof rt.raw!=='string'||!rt.publication)throw Error('RUNTIME_PREWARM_REQUIRED');
  const prewarm=JSON.stringify({runtime_acceptance:{raw:rt.raw,publication:rt.publication}})+'\n',prewarmBytes=utf8(prewarm).length,prewarmSHA=sha256(prewarm);if(prewarmBytes>4194304)throw Error('PREWARM_LIMIT');
  const staging='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/qualification-live/'+ga+'.'+op+'.env-order-repair-pipe600.prewarm.staging.json';
  const saved=await tools.apply_patch('*** Begin Patch\n*** Add File: '+staging+'\n+'+prewarm.slice(0,-1)+'\n*** End Patch');if(saved?.isError)throw Error('PREWARM_STAGING_FAILED');attempt.prewarm={path:staging,sha256:prewarmSHA,bytes:prewarmBytes};store(key,attempt);
  const replacement=checks+"& 'C:/Program Files/nodejs/node.exe' 'C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/env-order-repair-pipe/launcher.mjs' '"+ga+"' '"+op+"' '"+prewarmSHA+"' '"+prewarmBytes+"'";
  const start=Date.now();let result=await tools.exec_command({...args,cmd:args.cmd.slice(0,-tail.length)+replacement,max_output_tokens:2000});
  attempt.records.push({kind:'ACTUAL_LAUNCH_TOOL_RESULT',result});if(!result.session_id){await capture(result);throw Error('LIVE_TRANSPORT_PROCESS_REQUIRED');}attempt.session=result.session_id;store(key,attempt);
  while(!result.output.includes('NORMAL600_CONTEXT_READY')){if(result.exit_code!==undefined||Date.now()-start>60000){await capture(result);throw Error('CONTEXT_NOT_READY_NO_FRESH_INPUT');}result=await tools.write_stdin({session_id:attempt.session,chars:'',yield_time_ms:1000,max_output_tokens:2000});attempt.records.push({kind:'ACTUAL_READINESS_TOOL_RESULT',result});store(key,attempt);}
  attempt.context_ready=true;attempt.ready_at=new Date().toISOString();store(key,attempt);return {...result,session_id:attempt.session,output:''};
 },
 write_stdin:async args=>{
  if(args.session_id!==attempt.session||!attempt.context_ready)throw Error('EXACT_READY_PROCESS_REQUIRED');
  const start=Date.now(),input=args.chars??'';let result;
  if(input.length===0){result=await tools.write_stdin(args);}else{
   const sequence=(attempt.input_sequence||0)+1,bytes=utf8(input).length,digest=sha256(input);
   if(![1,2].includes(sequence)||bytes>4*1024*1024+1||!input.endsWith('\n')||input.slice(0,-1).includes('\n')||input.includes('\r'))throw Error('ONE_BOUNDED_ORIGINAL_MESSAGE');
   const parsed=JSON.parse(input);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('ORIGINAL_MESSAGE_OBJECT');
   const path='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/qualification-live/'+ga+'.'+op+'.env-order-repair-pipe600/message-'+sequence+'.staging.json';
   attempt.input_sequence=sequence;attempt.records.push({kind:'ORIGINAL_ACTUAL_MESSAGE',sequence,bytes,sha256:digest,raw:input,started_at:new Date(start).toISOString()});store(key,attempt);
   // The launcher has exclusively created this fixed attempt directory. The
   // notice is issued once; a wx/fsync archival write must precede pipe delivery.
   const patch='*** Begin Patch\n*** Add File: '+path+'\n+'+input.slice(0,-1)+'\n*** End Patch';
   const saved=await tools.apply_patch(patch);if(saved?.isError)throw Error('ACTUAL_MESSAGE_FILE_WRITE_FAILED');
   attempt.records.push({kind:'ACTUAL_FILE_TOOL_RESULT',sequence,result:saved});store(key,attempt);
   const notice=JSON.stringify({sequence,bytes,sha256:digest})+'\n';
   result=await tools.write_stdin({...args,chars:notice});
   attempt.records.push({kind:'ACTUAL_SHORT_PIPE_NOTICE',sequence,notice,ended_at:new Date().toISOString(),tool_wall_seconds:result.wall_time_seconds});store(key,attempt);
  }
  return capture(result);
 }
};
try{const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;await new AsyncFunction('tools','load','store','text',"// External root input scheduling; explicit successor entry; original scheduling and SQL ports remain.\nconst entry=load('clued_reviewed_entry600_source');\nif(entry?.sha256!=='f2a79d015764685b724727e3aa2a7ba17e8e604535386ed3fc43a9b5b3187667')throw Error('EXACT_SUCCESSOR_ENTRY');\nconst project='uscrdifznmlvczcekqpw',query='select clock_timestamp() as observed_at, clued_control.read_execution() as execution',queryHash='cb5704c053850f1484f39f4396d638f2e603b7df48f6eb7045fea36b8f072654';\nfunction row(result){if(result.isError||result.content?.length!==1)throw Error('ACTUAL_SQL_ERROR');const e=JSON.parse(result.content[0].text),m=e.result.match(/<untrusted-data-([A-Za-z0-9-]+)>\\r?\\n([\\s\\S]*?)\\r?\\n<\\/untrusted-data-\\1>/);if(!m)throw Error('EXACT_SQL_BOUNDARIES');const rows=JSON.parse(m[2]);if(rows.length!==1)throw Error('ONE_ACTUAL_ROW');return rows[0];}\nlet first=null,startedSession=null;\nconst port={\n mcp__codex_apps__supabase_execute_sql:async args=>{const result=await tools.mcp__codex_apps__supabase_execute_sql(args);if(args.project_id===project&&args.query===query&&first===null)first=row(result);return result;},\n exec_command:async args=>{const result=await tools.exec_command(args);if(result.session_id)startedSession=result.session_id;return result;},\n write_stdin:async args=>{\n  if(first&&startedSession===args.session_id&&typeof args.chars==='string'&&args.chars.length>0){\n   const input=JSON.parse(args.chars);\n   if(input.ga_raw&&['CREATE','START','GRR'].includes(input.operation)&&input.observation){\n    const freshResult=await tools.mcp__codex_apps__supabase_execute_sql({project_id:project,query}),fresh=row(freshResult);\n    const record={before:first,after:fresh,tool_result:freshResult,operation:input.operation,ga_id:JSON.parse(input.ga_raw).gate_authorization_id};\n    const history=load('runtime600_fresh_input_observations')||[];history.push(record);store('runtime600_fresh_input_observations',history);\n    if(JSON.stringify(Object.fromEntries(Object.entries(first.execution).filter(([k])=>k!=='observed_at')))!==JSON.stringify(Object.fromEntries(Object.entries(fresh.execution).filter(([k])=>k!=='observed_at'))))throw Error('ACTUAL_CONTEXT_CHANGED_BEFORE_INPUT');\n    const age=Date.now()-Date.parse(fresh.observed_at);if(!Number.isFinite(age)||age< -1000||age>15000)throw Error('FRESH_REAL_INPUT_REQUIRED');\n    input.observation={project,query_sha256:queryHash,row:fresh};args={...args,chars:JSON.stringify(input)+'\\n'};startedSession=null;\n   }\n  }\n  return await tools.write_stdin(args);\n }\n};\nconst AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;\nawait new AsyncFunction('tools','load','store','text',entry.raw)(port,load,store,text);\n")(ports,load,store,text);attempt.state='ORIGINAL_ENTRY_RETURNED';store(key,attempt);}catch(e){attempt.state='UNKNOWN';attempt.reason=String(e.message);store(key,attempt);throw e;}
