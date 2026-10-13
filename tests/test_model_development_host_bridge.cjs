'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {makeCluedDevelopmentHostBridge,makeDevelopmentHostBridge,SCHEMA}=require('../scripts/model-program/development_host_bridge.cjs');
const bound={identity:{task_id:'SOURCE ONLY TASK',profile_sha256:'1'.repeat(64),request_sha256:'2'.repeat(64),
  approval_record_id:'SOURCE ONLY APPROVAL',approval_version:1,approval_receipt_id:'SOURCE ONLY RECEIPT'},
  execution_plan_sha256:'3'.repeat(64)};
const obs={...bound.identity,kind:'CURRENT_OWNER_DECISION_AND_PROFILE_BINDING_OBSERVATION',
  approval_content_hash:'4'.repeat(64),task_version:2,claim_id:'SOURCE ONLY CLAIM',claim_fence:3,
  authority_effect:'NONE',permission_issued:false,attempt_consumed:false};
const frame=(sequence=1)=>({schema:SCHEMA,id:'1'.repeat(32),sequence,phase:'consume',binding:structuredClone(bound)});

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
