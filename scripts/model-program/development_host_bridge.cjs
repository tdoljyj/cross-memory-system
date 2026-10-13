'use strict';
// Called only by the fixed Host that owns the local child's private stdio pipes.
// Captures the already issued Profile binding and real protected Clued reader.
// A fixed child composition is available only with separately admitted pins.
// No Profile issuance, permission or generic command is exposed.
const SCHEMA = 'clued.development-currentness-channel/1';
const MAX_FRAME_BYTES = 32768;
const PHASES = new Set(['preflight','before_observation_open','observation_opened','consume',
  'before_start','before_resume','running','before_result']);
const stable = value => {
  if(Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if(value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',') + '}';
  if(typeof value==='number' && !Number.isFinite(value)) throw new Error('NONFINITE_BINDING');
  const encoded=JSON.stringify(value);
  if(encoded===undefined) throw new Error('INVALID_BINDING');
  return encoded;
};
const need=(ok,code)=>{if(!ok)throw new Error('DEVELOPMENT_HOST_BRIDGE_'+code);};

function makeDevelopmentHostBridge({reader,bound}) {
  need(typeof reader?.read==='function' && bound && typeof bound==='object', 'CAPTURED_READER_REQUIRED');
  const captured=JSON.parse(stable(bound));
  const seal=stable(captured);
  const read=reader.read.bind(reader);
  let sequence=0, busy=false, sealed=false;
  async function handle(request) {
    need(!busy && !sealed, 'SEALED_OR_CONCURRENT');
    busy=true;
    try {
      need(request && Object.keys(request).sort().join(',')==='binding,id,phase,schema,sequence', 'FRAME_FIELDS');
      need(request.schema===SCHEMA && typeof request.id==='string' && /^[0-9a-f]{32}$/.test(request.id)
        && request.sequence===sequence+1 && request.sequence<=4096 && PHASES.has(request.phase), 'FRAME_IDENTITY_OR_REPLAY');
      need(stable(request.binding)===seal, 'CAPTURED_BINDING_DRIFT');
      sequence=request.sequence;
      const base={schema:SCHEMA,id:request.id,sequence,phase:request.phase};
      try {
        // The real reader revalidates its own exact issued pins. Child-supplied
        // content never changes the captured binding passed to that reader.
        const observation=await read(request.phase,JSON.parse(seal));
        need(stable(captured)===seal, 'CAPTURED_BINDING_MUTATED');
        return {...base,admitted:true,observation};
      } catch {
        sealed=true;
        // Do not relay raw tool errors, private records, tokens or credentials.
        return {...base,admitted:false,observation:null};
      }
    } catch(error) {
      sealed=true;
      throw error;
    } finally {busy=false;}
  }
  return Object.freeze({handle});
}

function makeCluedDevelopmentHostBridge({tools,ownerCapture,issued,sessionRef,bound}) {
  // Production composition uses the real protected-tool reader, not a child-
  // supplied callback or a serialized observation. Issuance stays external.
  const {makeDevelopmentCurrentnessReader}=require('./development_clued_currentness.cjs');
  const reader=makeDevelopmentCurrentnessReader({tools,ownerCapture,issued,sessionRef});
  return makeDevelopmentHostBridge({reader,bound});
}

async function runFixedDevelopmentChild({tools,ownerCapture,issued,sessionRef,bound,
    bootstrap,python,sourceDirectory,sourceFiles,workingDirectory}) {
  // This is a candidate fixed Host controller. Its installation/qualification
  // and fresh exact experiment admission are required separately.
  const start=performance.now();
  const bridge=makeCluedDevelopmentHostBridge({tools,ownerCapture,issued,sessionRef,bound});
  const {createHash}=require('node:crypto');
  const fs=require('node:fs/promises');
  const path=require('node:path');
  const {spawn}=require('node:child_process');
  need(bootstrap?.schema==='clued.fixed-development-child-bootstrap/1'
    && typeof bootstrap.remaining_seconds==='number' && Number.isFinite(bootstrap.remaining_seconds)
    && bootstrap.remaining_seconds>0 && bootstrap.remaining_seconds<=120, 'BOOTSTRAP');
  const frozen=JSON.parse(stable(bootstrap));
  need(Object.keys(frozen).sort().join(',')===
    'identity,live_pins,output_directory,output_name,plan,remaining_seconds,schema','BOOTSTRAP_FIELDS');
  const deadline=start+frozen.remaining_seconds*1000;
  // Reserve five seconds inside the declared total for parent close/reaping.
  const executionEnd=deadline-5000;
  const active=()=>need(performance.now()<executionEnd,'DEADLINE');
  const within=async(promise,end=executionEnd)=>{
    let timer;
    try {return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('FIXED_HOST_DEADLINE')),Math.max(1,end-performance.now()));
    })]);} finally {clearTimeout(timer);}
  };
  need(stable(frozen.identity)===stable(bound.identity), 'BOOTSTRAP_IDENTITY');
  need(createHash('sha256').update(stable(frozen.plan)).digest('hex')===bound.execution_plan_sha256,
    'BOOTSTRAP_PLAN');
  need(frozen.live_pins?.claim_id===issued.claim_id && frozen.live_pins.claim_fence===issued.claim_fence
    && frozen.live_pins.task_version===issued.task_version, 'BOOTSTRAP_LIVE_PINS');
  need(process.platform==='win32' && path.isAbsolute(sourceDirectory) && path.isAbsolute(workingDirectory)
    && typeof python?.path==='string' && path.isAbsolute(python.path)
    && /^[0-9a-f]{64}$/.test(python.sha256) && Array.isArray(sourceFiles) && sourceFiles.length>0,
    'FIXED_HOST_SOURCE_PINS');
  const names=['development_completion_entry.py','development_attempt_ledger.py',
    'development_currentness_channel.py','development_windows_namespace.py',
    'observed_completion_execution.py','local_completion_execution.py'];
  need(sourceFiles.length===names.length
    && new Set(sourceFiles.map(row=>row.path)).size===names.length
    && names.every(name=>sourceFiles.some(row=>row.path===path.join(sourceDirectory,name))),
    'COMPLETE_FIXED_SOURCE_CLOSURE');
  const environment={};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP']) {
    const key=Object.keys(process.env).find(key=>key.toLowerCase()===name.toLowerCase());
    if(key) environment[name]=process.env[key];
  }
  need(typeof environment.SystemRoot==='string' && path.isAbsolute(environment.SystemRoot),'SYSTEM_ROOT');
  environment.PATH=path.join(environment.SystemRoot,'System32');
  const startup={schema:'clued.fixed-development-startup/1',python,sourceDirectory,
    sourceFiles,workingDirectory,environment};
  need(createHash('sha256').update(stable(startup)).digest('hex')===issued.startup_sha256,
    'CAPTURED_STARTUP_PINS');
  // Verify the exact interpreter and imported local Source closure, never model
  // weights or runtime. These pins must be captured from the accepted request.
  const rows=[python,...sourceFiles];
  for(const row of rows) {
    active();
    need(typeof row.path==='string' && path.isAbsolute(row.path)
      && Number.isSafeInteger(row.bytes) && row.bytes>0 && row.bytes<=33554432
      && typeof row.sha256==='string' && /^[0-9a-f]{64}$/.test(row.sha256), 'SOURCE_ROW');
    const st=await within(fs.lstat(row.path));
    need(st.isFile() && !st.isSymbolicLink() && st.size===row.bytes, 'SOURCE_FILE_IDENTITY');
    const bytes=await within(fs.readFile(row.path));
    need(bytes.length===row.bytes && createHash('sha256').update(bytes).digest('hex')===row.sha256,
      'SOURCE_DIGEST');
  }
  // The child has no CLI switches, shell, credentials, tool names or override
  // code. Only the exact imported function owns model execution boundaries.
  const code='import sys;sys.path.insert(0,sys.argv[1]);from development_completion_entry import run_captured_stdio_bootstrap;run_captured_stdio_bootstrap(sys.stdin.buffer,sys.stdout.buffer)';
  active();
  const child=spawn(python.path,['-I','-u','-c',code,sourceDirectory],
    {cwd:workingDirectory,env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let buffer=Buffer.alloc(0), total=0, stderrBytes=0, terminal, failure, closed=false, ready=false, sequence=0;
  let chain=Promise.resolve();
  const end=new Promise(resolve=>{child.on('error',error=>{failure=error;resolve(null);});
    child.on('close',code=>{closed=true;resolve(code);});});
  const stop=()=>{if(!closed)child.kill();};
  const fail=error=>{failure ||= error;stop();};
  const timer=setTimeout(()=>fail(new Error('FIXED_HOST_DEADLINE')), Math.max(1,executionEnd-performance.now()));
  const write=async value=>{
    active();need(!failure && !closed,'CLOSED_CHANNEL');
    const raw=JSON.stringify(value)+'\n';
    need(Buffer.byteLength(raw)<=MAX_FRAME_BYTES,'WRITE_FRAME_LIMIT');
    await within(new Promise((resolve,reject)=>child.stdin.write(raw,error=>error?reject(error):resolve())));
    active();
  };
  for(const stream of [child.stdin,child.stdout,child.stderr]) stream.on('error',fail);
  child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes>65536)fail(new Error('FIXED_HOST_STDERR_LIMIT'));});
  child.stdout.on('data',bytes=>{
    if(failure)return;
    total+=bytes.length;
    if(total>2097152){fail(new Error('FIXED_HOST_CONTROL_STREAM_LIMIT'));return;}
    buffer=Buffer.concat([buffer,bytes]);
    if(buffer.length>1048576 && buffer.indexOf(10)<0){fail(new Error('FIXED_HOST_FRAME_LIMIT'));return;}
    while(buffer.indexOf(10)>=0) {
      const index=buffer.indexOf(10),line=buffer.subarray(0,index);buffer=buffer.subarray(index+1);
      chain=chain.then(async()=>{
        active();need(!failure && !terminal, 'LATE_OR_EXTRA_FRAME');
        need(line.length<=1048576,'FRAME_LIMIT');
        const text=new TextDecoder('utf-8',{fatal:true}).decode(line);
        const frame=JSON.parse(text);
        // The fixed child emits canonical JSON. Reject duplicates, whitespace
        // tricks, non-finite values and any parser-normalized different frame.
        need(stable(frame)===text,'NONCANONICAL_FRAME');
        if(frame.schema===frozen.schema && frame.kind==='host_ready') {
          need(!ready && Object.keys(frame).sort().join(',')==='job_bounded,kind,schema'
            && frame.job_bounded===true,'JOB_READINESS');
          ready=true;
          await write({...frozen,remaining_seconds:(executionEnd-performance.now())/1000});
          return;
        }
        need(ready,'BOOTSTRAP_NOT_READY');
        if(frame.schema===frozen.schema && frame.kind==='terminal_result') {
          need(line.length<=1048576 && Object.keys(frame).sort().join(',')==='kind,result,schema', 'TERMINAL_FRAME');
          need(frame.result && frame.result.owned_cleanup_verified===true
            && frame.result.authority_effect==='NONE'
            && frame.result.budget_reservation?.status==='SPENT_BEFORE_MODEL_LOAD',
            'TERMINAL_CLEANUP_OR_SPEND');
          terminal=frame;return;
        }
        need(line.length<=MAX_FRAME_BYTES, 'CURRENTNESS_FRAME_LIMIT');
        sequence++;
        need(frame.sequence===sequence, 'CURRENTNESS_SEQUENCE');
        const reply=await within(bridge.handle(frame));
        active();need(!failure && !closed, 'LATE_CURRENTNESS_REPLY');
        await write(reply);
        need(reply.admitted===true,'CURRENTNESS_REFUSED');
      }).catch(fail);
    }
  });
  try {
    need(Buffer.byteLength(JSON.stringify(frozen)+'\n')<=MAX_FRAME_BYTES,'BOOTSTRAP_FRAME_LIMIT');
    const exit=await within(end);
    await within(chain);
    if(failure)throw failure;
    need(exit===0 && terminal && buffer.length===0,'CHILD_EOF_OR_FAILURE');
    return terminal.result;
  } finally {
    clearTimeout(timer);stop();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    // On kill, OS closes the child's non-inherited kill-on-close Job handle.
    // A process that never reached readiness could not receive model bindings.
    try {await within(end,deadline);} catch {throw new Error('FIXED_HOST_PARENT_CLEANUP_UNVERIFIED');}
  }
}

module.exports=Object.freeze({runFixedDevelopmentChild,makeCluedDevelopmentHostBridge,makeDevelopmentHostBridge,SCHEMA,MAX_FRAME_BYTES});
