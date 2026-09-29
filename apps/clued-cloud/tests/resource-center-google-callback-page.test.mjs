import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(readFileSync(new URL("../app/storage/google/callback/page.tsx",import.meta.url),"utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText;
async function fixture(result,ok=false,inspection,options={}) {
  let message, callback; const calls=[],effects=[],history=[];
  const exports={};
  vm.runInNewContext(compiled,{exports,URL,Error,AbortSignal:{timeout(ms){assert.ok(ms>0&&ms<=15000);return AbortSignal.timeout(options.fastTimeout?1:ms);}},
    window:{location:{href:"https://clued.invalid/storage/google/callback?state=fixture-state&code=fixture-secret-code"},
      history:{replaceState:(_a,_b,url)=>history.push(url)}},
    fetch:async(url,init)=>{calls.push({url,init});assert.ok(init.signal);
      if(url.endsWith('/inspect')&&options.hangInspect)return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
      if(url.endsWith('/auto-target'))return {ok:true,json:async()=>options.target??{status:'manual'}};
      if(url==='/v1/storage/recovery')return {ok:true,json:async()=>options.settlement??{status:'inspection_required',execution_permitted:false}};
      return {ok:url.endsWith('/inspect')?!!inspection:ok,json:async()=>{if(!url.endsWith('/inspect')&&options.brokenBody)throw Error('truncated body');return url.endsWith('/inspect')?inspection:result;}};},
    require(name){
      if(name==="react")return {useState:initial=>[initial,v=>{message=v;}],useEffect:fn=>effects.push(fn)};
      if(name==="react/jsx-runtime")return {jsx:()=>null,jsxs:()=>null};
      if(name==="next/link")return {__esModule:true,default:"a"};
      if(name.endsWith("/supabase-browser"))return {supabase:{auth:{
        getSession:async()=>({data:{session:{user:{id:"owner"},access_token:"fixture-native"}},error:null}),
        onAuthStateChange:cb=>{callback=cb;return {data:{subscription:{unsubscribe(){}}}};},
      }}};
      throw Error(name);
    },
  });
  const settle=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
  exports.default(); effects.shift()(); await settle();
  return {message:()=>message,calls,history,remount:async()=>{exports.default();effects.shift()();await settle();},
    change:()=>callback("SIGNED_OUT",null)};
}
test("callback shows fixed actionable root diagnosis and strips code before exchange",async()=>{
  const f=await fixture({reason:"root_not_authorized",error:"fixture-provider-secret"});
  assert.ok(f.message().includes("尚未将已登记根目录授权"));
  assert.equal(f.message().includes("fixture-provider-secret"),false);
  assert.deepEqual(f.history,["/storage/google/callback"]);
  assert.equal(f.calls.length,2);
  await f.remount(); assert.equal(f.calls.length,2);
});
test("unknown/prototype reasons cannot render arbitrary server text",async()=>{
  for(const reason of ["fixture-private-error","toString","__proto__",{},null]){
    const f=await fixture({reason,error:"fixture-secret"});
    assert.equal(f.message(),"连接未确认，请返回连接页检查状态。此操作不会开启文件写入；不会自动重试或放宽权限。");
  }
});

test("token failure classes show fixed guidance, never upstream error descriptions",async()=>{
  for(const reason of ["token_invalid_client","token_invalid_grant","token_unauthorized_client","token_invalid_request",
    "token_unsupported_grant_type","token_http_rejected","token_response_unreadable","token_transport_unconfirmed"]){
    const f=await fixture({reason,error:"fixture-private-upstream-body"});
    assert.ok(f.message().includes("不会自动重试或放宽权限"));
    assert.equal(f.message().includes("fixture-private-upstream-body"),false);
    await f.remount();assert.equal(f.calls.length,2);
  }
});
test("confirmed callback displays receipt but does not claim file execution; account change wins",async()=>{
  const f=await fixture({status:"completed",receipt_id:"fixture-receipt"},true);
  assert.ok(f.message().includes("fixture-receipt"));assert.ok(f.message().includes("文件操作仍需独立授权"));
  f.change();assert.ok(f.message().includes("登录账号已变化"));
});
test("callback reports only confirmed server refresh state, never assumes the default succeeded",async()=>{
  for(const enabled of [true,false,undefined]) {
    const f=await fixture({status:'completed',receipt_id:'fixture-receipt',...(enabled===undefined?{}:{refresh_enabled:enabled})},true);
    assert.equal(f.message().includes('后台续签已开启'),enabled===true);
    assert.equal(f.message().includes('后台续签保持关闭'),enabled===false);
    assert.ok(f.message().includes('文件操作仍需独立授权'));
    await f.remount(); assert.equal(f.calls.length,1);
  }
});

test('recovery callback never claims activation or renewal; a lost commit reads the original attempt without resending code',async()=>{
  for(const lost of [false,true]){
    const f=lost?await fixture({reason:'credential_commit_unconfirmed'},false,{status:'completed',receipt_id:'original-receipt',execution_permitted:false}):
      await fixture({status:'completed',receipt_id:'original-receipt',purpose:'credential_recovery',refresh_enabled:true},true);
    assert.match(f.message(),/连接停用状态、Agent 权限和后台续签设置未改变/);assert.equal(f.message().includes('后台续签已开启'),false);
    assert.equal(f.calls.length,lost?3:2);
    if(lost)assert.deepEqual(JSON.parse(f.calls[1].init.body),{state:'fixture-state'});
    await f.remount();assert.equal(f.calls.length,lost?3:2);
  }
});

test('200 truncated body, gateway failure and malformed success each inspect at most once, including timeout',async()=>{
  for(const options of [{brokenBody:true},{gateway:true},{malformed:true},{hangInspect:true,fastTimeout:true}]){
    const confirmed={status:'completed',receipt_id:'original-receipt',execution_permitted:false};
    const f=await fixture(options.malformed?{status:'unknown'}:{},!options.gateway,confirmed,options);
    if(options.hangInspect)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(f.calls.length,options.hangInspect?2:3);assert.equal(f.calls[0].url,'/v1/storage/google/complete');
    assert.equal(f.calls[1].url,'/v1/storage/google/recovery/inspect');assert.deepEqual(JSON.parse(f.calls[1].init.body),{state:'fixture-state'});
    assert.equal(f.message().includes('original-receipt'),!options.hangInspect);
    await f.remount();assert.equal(f.calls.length,options.hangInspect?2:3);
  }
});
test('new recovery consent automatically settles the exact original job and shows its separate receipt',async()=>{
  const connection='10000000-0000-4000-8000-000000000081',job='10000000-0000-4000-8000-000000000082';
  const receipt='10000000-0000-4000-8000-000000000083';
  const f=await fixture({status:'completed',receipt_id:'credential-receipt',purpose:'credential_recovery'},true,undefined,{
    target:{status:'ready',connection_id:connection,job_id:job,execution_permitted:false},
    settlement:{status:'committed',job_id:job,receipt_id:receipt,execution_permitted:false},
  });
  assert.deepEqual(f.calls.map(x=>x.url),['/v1/storage/google/complete','/v1/storage/google/recovery/auto-target','/v1/storage/recovery']);
  assert.deepEqual(JSON.parse(f.calls[2].init.body),{action:'settle',connection_id:connection,job_id:job});
  assert.match(f.message(),/原任务结果已自动核验并登记/);assert.match(f.message(),new RegExp(receipt));
  await f.remount();assert.equal(f.calls.length,3);
});
test('unconfirmed original result stops after one comparison and one original-job read',async()=>{
  const connection='10000000-0000-4000-8000-000000000081',job='10000000-0000-4000-8000-000000000082';
  const f=await fixture({status:'completed',receipt_id:'credential-receipt',purpose:'credential_recovery'},true,undefined,{
    target:{status:'ready',connection_id:connection,job_id:job,execution_permitted:false},
  });
  assert.deepEqual(f.calls.map(x=>x.url),['/v1/storage/google/complete','/v1/storage/google/recovery/auto-target',
    '/v1/storage/recovery','/v1/storage/recovery']);
  assert.deepEqual(JSON.parse(f.calls[3].init.body),{action:'inspect',connection_id:connection,job_id:job});
  assert.match(f.message(),/原任务结果尚未确认/);await f.remount();assert.equal(f.calls.length,4);
});
