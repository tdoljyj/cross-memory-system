'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {makeCapturedToolMailbox,runFixedDevelopmentChild,makeCluedDevelopmentHostBridge,makeDevelopmentHostBridge,SCHEMA}=require('../scripts/model-program/development_host_bridge.cjs');
const bound={identity:{task_id:'SOURCE ONLY TASK',profile_sha256:'1'.repeat(64),request_sha256:'2'.repeat(64),
  approval_record_id:'SOURCE ONLY APPROVAL',approval_version:1,approval_receipt_id:'SOURCE ONLY RECEIPT'},
  execution_plan_sha256:'3'.repeat(64)};
const obs={...bound.identity,kind:'CURRENT_OWNER_DECISION_AND_PROFILE_BINDING_OBSERVATION',
  approval_content_hash:'4'.repeat(64),task_version:2,claim_id:'SOURCE ONLY CLAIM',claim_fence:3,
  authority_effect:'NONE',permission_issued:false,attempt_consumed:false};
const frame=(sequence=1)=>({schema:SCHEMA,id:'1'.repeat(32),sequence,phase:'consume',binding:structuredClone(bound)});

test('Host-only mailbox preserves four protected reads, context and one-use replies',async()=>{
  const mailbox=makeCapturedToolMailbox({sessionRef:'SOURCE ONLY SESSION',wallSeconds:2});
  const scope='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  assert.equal(Object.keys(mailbox.tools).length,4);
  assert.throws(()=>mailbox.tools.mcp__codex_apps__clued_clued_work_verify({scope,pr_ref:'repo:pr:1'}),/NO_PR/);
  const pending=mailbox.tools.mcp__codex_apps__clued_clued_session_resume({context_key:scope,client_session_id:'SOURCE ONLY SESSION'});
  const [request]=mailbox.take();assert.equal(request.method,'clued_session_resume');
  assert.deepEqual(mailbox.take(),[]);
  mailbox.settle(request.id,{structuredContent:{status:'SOURCE_ONLY_NOT_PERMISSION'}});
  assert.equal((await pending).structuredContent.status,'SOURCE_ONLY_NOT_PERMISSION');
  assert.throws(()=>mailbox.settle(request.id,{}),/REPLAY/);
  mailbox.close();assert.throws(()=>mailbox.take(),/SEALED/);
});

test('Host-only mailbox deadline and cancellation never accept late tool results',async()=>{
  const scope='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  const mailbox=makeCapturedToolMailbox({sessionRef:'SOURCE ONLY',wallSeconds:0.02});
  const pending=mailbox.tools.mcp__codex_apps__clued_clued_work_verify({scope,claim_id:'SOURCE ONLY'});
  const [request]=mailbox.take();await assert.rejects(pending,/DEADLINE/);
  assert.throws(()=>mailbox.settle(request.id,{}),/LATE/);mailbox.close();
  const cancelled=makeCapturedToolMailbox({sessionRef:'SOURCE ONLY',wallSeconds:1});
  const next=cancelled.tools.mcp__codex_apps__clued_clued_work_verify({scope,claim_id:'SOURCE ONLY'});
  cancelled.close();await assert.rejects(next,/CLOSED/);
});

test('production composition rejects serialized observation before Host tool calls',()=>{
  assert.throws(()=>makeCluedDevelopmentHostBridge({tools:{},ownerCapture:{structuredContent:obs},
    issued:{status:'CANDIDATE'},sessionRef:'SOURCE ONLY SESSION',bound}),/ORIGINAL_M1_CAPTURE_REQUIRED/);
});

test('array nonce cannot be coerced into a valid Host round identity',async()=>{
  let calls=0;
  const bridge=makeDevelopmentHostBridge({bound,reader:{read:async()=>{calls++;return obs;}}});
  const request=frame();request.id=[request.id];
  await assert.rejects(bridge.handle(request),/IDENTITY_OR_REPLAY/);
  assert.equal(calls,0);
});

test('Source bridge uses captured binding and returns the reader observation',async()=>{
  const bridge=makeDevelopmentHostBridge({bound,reader:{read:async(phase,actual)=>{
    assert.equal(phase,'consume');assert.deepEqual(actual,bound);return obs;}}});
  assert.deepEqual((await bridge.handle(frame())).observation,obs);
  await assert.rejects(bridge.handle(frame()),/REPLAY/);
});

test('request drift and raw tool refusal seal channel without relaying secrets',async()=>{
  let calls=0;
  const bridge=makeDevelopmentHostBridge({bound,reader:{read:async()=>{calls++;throw Error('SECRET');}}});
  const reply=await bridge.handle(frame());
  assert.equal(reply.admitted,false);assert.equal(reply.observation,null);
  assert.ok(!JSON.stringify(reply).includes('SECRET'));
  await assert.rejects(bridge.handle(frame(2)),/SEALED/);assert.equal(calls,1);
  const wrong=frame();wrong.binding.identity.request_sha256='9'.repeat(64);
  const second=makeDevelopmentHostBridge({bound,reader:{read:async()=>{calls++;return obs;}}});
  await assert.rejects(second.handle(wrong),/DRIFT/);assert.equal(calls,1);
});

test('concurrent round cannot enter the actual reader twice',async()=>{
  let finish,calls=0;
  const bridge=makeDevelopmentHostBridge({bound,reader:{read:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}}});
  const first=bridge.handle(frame());
  await assert.rejects(bridge.handle(frame(2)),/CONCURRENT/);assert.equal(calls,1);
  finish(obs);assert.equal((await first).admitted,true);
});

test('real non-model Python child exchanges observation over parent-owned private pipes',async()=>{
  const {spawn}=require('node:child_process');
  const path=require('node:path');
  const python=process.env.CLUED_MODEL_SOURCE_TEST_PYTHON;
  assert.ok(python,'exact test Python is required; no silent skip');
  const modulePath=path.resolve(__dirname,'../scripts/model-program');
  const script='import sys,json;sys.path.insert(0,sys.argv[1]);from development_currentness_channel import PrivateCurrentnessChannel;b=json.loads(sys.argv[2]);c=PrivateCurrentnessChannel(sys.stdin.buffer,sys.stdout.buffer,live_pins={"task_version":2,"claim_id":"SOURCE ONLY CLAIM","claim_fence":3});assert c("consume",b) is None;sys.stdout.write("SOURCE_ONLY_ROUNDTRIP_PASS\\n");sys.stdout.flush()';
  const child=spawn(python,['-u','-c',script,modulePath,JSON.stringify(bound)],
    {shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const bridge=makeDevelopmentHostBridge({bound,reader:{read:async()=>obs}});
  let raw='',errors='',passed=false;
  const timer=setTimeout(()=>child.kill(),5000);
  const exit=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  child.stderr.on('data',b=>{errors+=b.toString();});
  let chain=Promise.resolve(),failure;
  child.stdout.on('data',b=>{
    raw+=b.toString();
    while(raw.includes('\n')) {
      const index=raw.indexOf('\n'),line=raw.slice(0,index).replace(/\r$/,'');raw=raw.slice(index+1);
      if(line==='SOURCE_ONLY_ROUNDTRIP_PASS') {passed=true;continue;}
      chain=chain.then(async()=>{const reply=await bridge.handle(JSON.parse(line));child.stdin.write(JSON.stringify(reply)+'\n');})
        .catch(error=>{failure=error;child.kill();});
    }
  });
  try {const code=await exit;await chain;if(failure)throw failure;assert.equal(code,0,errors);assert.equal(passed,true,errors);}
  finally {clearTimeout(timer);child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();}
});

// Entire fixed controller integration uses Source-only captures and a pinned
// non-model child fixture. Neither test data nor a fixture Profile is authority.
async function controllerFixture(action) {
  const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
  const root=await fs.mkdtemp(path.join(process.env.CLUED_MODEL_SOURCE_TEST_TEMP_ROOT,'fixed-source-'));
  const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
  const stable=value=>Array.isArray(value)?'['+value.map(stable).join(',')+']':
    value && typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}':JSON.stringify(value);
  const pin=async file=>{const data=await fs.readFile(file);return {path:file,bytes:data.length,sha256:digest(data)};};
  const names=['development_completion_entry.py','development_attempt_ledger.py',
    'development_currentness_channel.py','development_windows_namespace.py',
    'observed_completion_execution.py','local_completion_execution.py'];
  const original=path.resolve(__dirname,'../scripts/model-program');
  for(const name of names) await fs.copyFile(path.join(original,name),path.join(root,name));
  // Modify only a temporary child fixture, never the admitted Source or model.
  await fs.appendFile(path.join(root,names[0]),'\n'+action+'\n');
  const task='1502fd80-8ff8-4adc-b4f5-da6d462f4f8a',scope='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
  const record={id:'SOURCE-ONLY-APPROVAL',record_type:'decision',authority:'user_explicit',
    lifecycle_status:'active',canonical_scope:scope,receipt_id:'SOURCE-ONLY-RECEIPT',content_hash:'1'.repeat(64),
    content:'SOURCE FIXTURE NO MODEL OR PERMISSION',version:1,type_fields:{model_development_experiment_approval:{
      kind:'EXACT_BOUNDED_DEVELOPMENT_EXPERIMENT',task_id:task,purpose_id:'development',profile_id:'DEV-SOURCE-ONLY',
      request_sha256:'2'.repeat(64),max_attempts:1,training_allowed:false,production_allowed:false,qualification_allowed:false,
      window:{not_before:new Date(Date.now()-10000).toISOString(),stop_at:new Date(Date.now()+60000).toISOString()}}}};
  const plan={budget:{wall_seconds:12}},issued={status:'ISSUED',task_id:task,profile_id:'DEV-SOURCE-ONLY',
    request_sha256:'2'.repeat(64),profile_sha256:'3'.repeat(64),execution_plan_sha256:digest(stable(plan)),
    claim_id:'SOURCE-ONLY-CLAIM',claim_fence:1,task_version:2,task_query:'SOURCE ONLY TASK'};
  const identity={task_id:task,profile_id:issued.profile_id,profile_sha256:issued.profile_sha256,
    request_sha256:issued.request_sha256,approval_record_id:record.id,approval_version:1,
    approval_receipt_id:record.receipt_id,ledger_directory:root};
  const python=await pin(process.env.CLUED_MODEL_SOURCE_TEST_PYTHON);
  const sourceFiles=await Promise.all(names.map(name=>pin(path.join(root,name))));
  const environment={};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP']) {
    const key=Object.keys(process.env).find(k=>k.toLowerCase()===name.toLowerCase());
    if(key)environment[name]=process.env[key];
  }
  environment.PATH=path.join(environment.SystemRoot,'System32');
  issued.startup_sha256=digest(stable({schema:'clued.fixed-development-startup/1',python,
    sourceDirectory:root,sourceFiles,workingDirectory:root,environment}));
  return {root,fs,args:{tools:{mcp__codex_apps__clued_clued_session_resume:async()=>new Promise(()=>{}),
    mcp__codex_apps__clued_clued_search_context:async()=>{},mcp__codex_apps__clued_clued_session_reconcile:async()=>{},
    mcp__codex_apps__clued_clued_work_verify:async()=>{}},ownerCapture:{structuredContent:{status:'committed',
    receipt_id:record.receipt_id,event_ids:[999999999],supplemental:{record}}},issued,sessionRef:'SOURCE-ONLY-SESSION',
    bound:{identity,execution_plan_sha256:issued.execution_plan_sha256},python,sourceDirectory:root,sourceFiles,
    workingDirectory:root,bootstrap:{schema:'clued.fixed-development-child-bootstrap/1',identity,plan,
      live_pins:{task_version:2,claim_id:issued.claim_id,claim_fence:1},output_directory:root,
      output_name:'SOURCE_ONLY.jsonl',remaining_seconds:12}}};
}

test('fixed controller captures private bootstrap and nested bytes without a model',async()=>{
  const f=await controllerFixture('class SourceOnlyHost:\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def execute(self,identity,plan): return {"owned_cleanup_verified":True,"authority_effect":"NONE","budget_reservation":{"status":"SPENT_BEFORE_MODEL_LOAD"},"observation_capture":{"raw":b"SOURCE ONLY"}}\nFixedDevelopmentEntry.for_clued_stdio=classmethod(lambda cls,**kwargs:SourceOnlyHost())');
  try {const result=await runFixedDevelopmentChild(f.args);
    assert.equal(result.observation_capture.raw.encoding,'base64');
    assert.equal(Buffer.from(result.observation_capture.raw.data,'base64').toString(),'SOURCE ONLY');}
  finally {await f.fs.rm(f.root,{recursive:true});}
});

test('fixed controller bounds an unresolved protected reader and reaps non-model child',async()=>{
  const f=await controllerFixture('class SourceOnlyHost:\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def execute(self,identity,plan):\n  from development_currentness_channel import PrivateCurrentnessChannel\n  c=PrivateCurrentnessChannel(sys.stdin.buffer,sys.stdout.buffer,live_pins={"task_version":2,"claim_id":"SOURCE-ONLY-CLAIM","claim_fence":1});c("preflight",{"identity":identity,"execution_plan_sha256":observed.legacy.digest({"budget":{"wall_seconds":12}})})\nimport sys\nFixedDevelopmentEntry.for_clued_stdio=classmethod(lambda cls,**kwargs:SourceOnlyHost())');
  const start=performance.now();
  try {await assert.rejects(runFixedDevelopmentChild(f.args),/DEADLINE/);
    assert.ok(performance.now()-start<12500,'hung tool cannot extend total deadline');}
  finally {await f.fs.rm(f.root,{recursive:true});}
});

test('fixed controller rejects startup drift and incomplete import closure before launching',async()=>{
  const f=await controllerFixture('raise Exception("MUST NOT LAUNCH")');
  try {const wrong={...f.args,workingDirectory:__dirname};
    await assert.rejects(runFixedDevelopmentChild(wrong),/STARTUP_PINS/);
    await assert.rejects(runFixedDevelopmentChild({...f.args,sourceFiles:f.args.sourceFiles.slice(1)}),/SOURCE_CLOSURE/);}
  finally {await f.fs.rm(f.root,{recursive:true});}
});

test('fixed child ignores a valid conflicting local bytecode cache',async()=>{
  const f=await controllerFixture('class SourceOnlyHost:\n def __enter__(self): return self\n def __exit__(self,*a): pass\n def execute(self,*a): return {"owned_cleanup_verified":True,"authority_effect":"NONE","budget_reservation":{"status":"SPENT_BEFORE_MODEL_LOAD"}}\nFixedDevelopmentEntry.for_clued_stdio=classmethod(lambda cls,**kwargs:SourceOnlyHost())');
  try {
    const {spawnSync}=require('node:child_process');
    const file=f.args.sourceFiles.find(row=>row.path.endsWith('development_completion_entry.py')).path;
    // Same timestamp and size makes this malicious pyc acceptable to ordinary
    // CPython source importing. The fixed source-only loader must ignore it.
    const script='import sys,os,py_compile;p=sys.argv[1];raw=open(p,"rb").read();st=os.stat(p);bad=b"raise RuntimeError(\\"CONFLICTING_PYC_EXECUTED\\")\\n".ljust(len(raw),b" ");open(p,"wb").write(bad);os.utime(p,ns=(st.st_atime_ns,st.st_mtime_ns));py_compile.compile(p,doraise=True);open(p,"wb").write(raw);os.utime(p,ns=(st.st_atime_ns,st.st_mtime_ns))';
    const compiled=spawnSync(f.args.python.path,['-I','-c',script,file],{shell:false,windowsHide:true,timeout:5000});
    assert.equal(compiled.status,0,compiled.stderr?.toString());
    const result=await runFixedDevelopmentChild(f.args);
    assert.equal(result.owned_cleanup_verified,true);
  } finally {await f.fs.rm(f.root,{recursive:true});}
});
