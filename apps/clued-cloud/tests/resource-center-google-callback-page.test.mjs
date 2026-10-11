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
    window:{location:{href:options.cancelled?"https://clued.invalid/storage/google/callback?state=fixture-state&error=access_denied":
      "https://clued.invalid/storage/google/callback?state=fixture-state&code=fixture-secret-code"},
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
test("cancelled Google consent never exchanges a code or enables Agent file operations",async()=>{
  const f=await fixture({},false,undefined,{cancelled:true});
  assert.match(f.message(),/Google 授权未完成/);assert.equal(f.calls.length,0);
  assert.deepEqual(f.history,["/storage/google/callback"]);
  await f.remount();assert.equal(f.calls.length,0);
});
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
    assert.equal(f.message(),"连接未确认，请返回连接页检查状态。请核对连接状态和原回执；不会自动重试或放宽权限。");
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
test("N0 onboard callback: connection established message, partial grant, refresh state and fixed page-only reasons",async()=>{
  const done=await fixture({status:"completed",purpose:"onboard",receipt_id:"fixture-receipt",connection_id:"c",onboard_attempt_id:"a",
    provider_scope_profile:"normal",requested_scope_profile:"normal",normal_use_enabled:true,refresh_enabled:true},true);
  assert.match(done.message(),/Google Drive 连接已建立/); assert.match(done.message(),/正常使用已开启/); assert.match(done.message(),/后台自动续期已开启/);
  assert.equal(done.calls.length,1,"no recovery settlement for onboarding");
  const partial=await fixture({status:"completed",purpose:"onboard",receipt_id:"fixture-receipt",connection_id:"c",onboard_attempt_id:"a",
    provider_scope_profile:"legacy",requested_scope_profile:"normal",normal_use_enabled:false,refresh_enabled:false},true);
  assert.match(partial.message(),/未授予“查看你 Google 云端硬盘中的所有文件”，正常使用未开启/); assert.match(partial.message(),/约 1 小时后读写都不可用/);
  for(const [reason,text] of [["root_shared_drive",/共享云端硬盘/],["root_not_owned",/不属于你的 Google 账号/],["root_overlaps_existing",/已连接的资料根/],
    ["root_name_changed",/名称已变化/],["onboard_track_name_conflict",/同名的文件夹/],["onboard_effect_ambiguous",/多个本次接入创建/],["root_multiple_parents",/多个上级目录/]]){
    const f=await fixture({reason,onboard_attempt_id:"a",error:"fixture-private"});
    assert.match(f.message(),text,reason); assert.equal(f.message().includes("fixture-private"),false);
  }
});
test("onboarding and reconnect callbacks claim all permissions only for explicit ON with actual full Google scope",async()=>{
  for(const purpose of ["onboard","reconnect"]){
    const f=await fixture({status:"completed",receipt_id:"master-receipt",purpose,requested_scope_profile:"full",provider_scope_profile:"full",
      master_state:"on",normal_use_enabled:true,refresh_enabled:true},true);
    assert.match(f.message(),/全部 Agent 文件操作已开启/);assert.equal(f.calls.length,1);await f.remount();assert.equal(f.calls.length,1);
    f.change();assert.match(f.message(),/登录账号已变化/);
  }
  for(const profile of ["normal","legacy",undefined]){
    const f=await fixture({status:"completed",receipt_id:"partial-scope-receipt",purpose:"onboard",requested_scope_profile:"full",
      provider_scope_profile:profile,master_state:"on",normal_use_enabled:true},true);
    assert.ok(!f.message().includes("全部 Agent 文件操作已开启"));assert.match(f.message(),/全部 Agent 文件操作尚未确认/);
    assert.equal(f.calls.length,1);
  }
});
test("partial, OFF and older narrower receipts never imply master ON",async()=>{
  for(const [state,expected] of [["partial",/部分开启/],["off",/全部 Agent 文件操作已停止/]]){
    const f=await fixture({status:"completed",receipt_id:"configured-receipt",requested_scope_profile:"full",provider_scope_profile:"full",master_state:state},true);
    assert.match(f.message(),expected);assert.ok(!f.message().includes("全部 Agent 文件操作已开启"));
  }
  for(const result of [{normal_use_enabled:true,provider_scope_profile:"full",requested_scope_profile:"full"},
    {normal_use_enabled:true,provider_scope_profile:"normal"},{master_state:"unknown",provider_scope_profile:"full",requested_scope_profile:"full"}]){
    const f=await fixture({status:"completed",receipt_id:"older-receipt",...result},true);
    assert.ok(!f.message().includes("全部 Agent 文件操作已开启"));assert.ok(f.message().includes("older-receipt"));
    assert.equal(f.calls.length,1);await f.remount();assert.equal(f.calls.length,1);
  }
});
test("confirmed callback displays receipt but does not claim file execution; account change wins",async()=>{
  const f=await fixture({status:"completed",receipt_id:"fixture-receipt"},true);
  assert.ok(f.message().includes("fixture-receipt"));assert.ok(f.message().includes("执行仍须通过目录和客户端检查"));
  f.change();assert.ok(f.message().includes("登录账号已变化"));
});
test("callback reports only confirmed server refresh state, never assumes the default succeeded",async()=>{
  for(const enabled of [true,false,undefined]) {
    const f=await fixture({status:'completed',receipt_id:'fixture-receipt',...(enabled===undefined?{}:{refresh_enabled:enabled})},true);
    assert.equal(f.message().includes('后台续签已开启'),enabled===true);
    assert.equal(f.message().includes('后台续签保持关闭'),enabled===false);
    assert.ok(f.message().includes('执行仍须通过目录和客户端检查'));
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
test("normal-use re-consent: the callback reports the granted profile and whether normal use is on (StorageNormalUse §2.3)",async()=>{
  const on=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"normal",normal_use_enabled:true},true);
  assert.match(on.message(),/正常使用已开启/);
  const partial=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"legacy",normal_use_enabled:false},true);
  assert.match(partial.message(),/未授予“查看你 Google 云端硬盘中的所有文件”，正常使用未开启/);
  const off=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"normal",normal_use_enabled:false},true);
  assert.match(off.message(),/正常使用未自动开启/);
  const plain=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"legacy"},true);
  assert.equal(plain.message().includes("正常使用"),false,"a plain reconnect says nothing about normal use");
  const legacyReconnect=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"legacy",requested_scope_profile:"legacy"},true);
  assert.equal(legacyReconnect.message().includes("正常使用"),false,"a legacy reconnect of a legacy connection says nothing either");
  // Reconnect of a NORMAL connection (normal requested, normal use not part of
  // the request) where the Owner unticked the scope: same §2.3 message.
  const downgraded=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"legacy",requested_scope_profile:"normal"},true);
  assert.match(downgraded.message(),/未授予“查看你 Google 云端硬盘中的所有文件”，正常使用未开启/);
  const kept=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"normal",requested_scope_profile:"normal"},true);
  assert.equal(kept.message().includes("正常使用"),false);
  const limit=await fixture({reason:"refresh_token_limit"});
  assert.match(limit.message(),/联系维护者/); assert.equal(limit.message().includes("撤回全部文件读取授权"),false,"never points to a control that does not exist");
  const busy=await fixture({reason:"storage_root_busy"});
  assert.match(busy.message(),/尚未完成的文件操作/);
});
test("full-scope re-consent (StorageFullCapability P7): the callback says whether managing existing files is allowed",async()=>{
  const full=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"full",requested_scope_profile:"full"},true);
  assert.match(full.message(),/已允许管理已有文件（完整云端硬盘权限）/);
  const normal=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"normal",requested_scope_profile:"full"},true);
  assert.match(normal.message(),/未授予“查看、修改、创建和删除你 Google 云端硬盘中的所有文件”，管理已有文件未允许/);
  assert.equal(normal.message().includes("正常使用不可用"),false);
  const legacy=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"legacy",requested_scope_profile:"full"},true);
  assert.match(legacy.message(),/管理已有文件未允许；也未授予“查看你 Google 云端硬盘中的所有文件”，正常使用不可用/);
  const other=await fixture({status:"completed",receipt_id:"fixture-receipt",provider_scope_profile:"normal",requested_scope_profile:"normal"},true);
  assert.equal(other.message().includes("管理已有文件"),false);
});
