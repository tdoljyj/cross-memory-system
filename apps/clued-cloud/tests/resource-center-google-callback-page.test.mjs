import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(readFileSync(new URL("../app/storage/google/callback/page.tsx",import.meta.url),"utf8"),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText;
async function fixture(result,ok=false) {
  let message, callback; const calls=[],effects=[],history=[];
  const exports={};
  vm.runInNewContext(compiled,{exports,URL,Error,
    window:{location:{href:"https://clued.invalid/storage/google/callback?state=fixture-state&code=fixture-secret-code"},
      history:{replaceState:(_a,_b,url)=>history.push(url)}},
    fetch:async(url,init)=>{calls.push({url,init}); return {ok,json:async()=>result};},
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
  const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  exports.default(); effects.shift()(); await settle();
  return {message:()=>message,calls,history,remount:async()=>{exports.default();effects.shift()();await settle();},
    change:()=>callback("SIGNED_OUT",null)};
}
test("callback shows fixed actionable root diagnosis and strips code before exchange",async()=>{
  const f=await fixture({reason:"root_not_authorized",error:"fixture-provider-secret"});
  assert.ok(f.message().includes("尚未将已登记根目录授权"));
  assert.equal(f.message().includes("fixture-provider-secret"),false);
  assert.deepEqual(f.history,["/storage/google/callback"]);
  assert.equal(f.calls.length,1);
  await f.remount(); assert.equal(f.calls.length,1);
});
test("unknown/prototype reasons cannot render arbitrary server text",async()=>{
  for(const reason of ["fixture-private-error","toString","__proto__",{},null]){
    const f=await fixture({reason,error:"fixture-secret"});
    assert.equal(f.message(),"连接未确认，请返回连接页检查状态。此操作不会开启文件写入；不会自动重试或放宽权限。");
  }
});
test("confirmed callback displays receipt but does not claim file execution; account change wins",async()=>{
  const f=await fixture({status:"completed",receipt_id:"fixture-receipt"},true);
  assert.ok(f.message().includes("fixture-receipt"));assert.ok(f.message().includes("文件操作仍需独立授权"));
  f.change();assert.ok(f.message().includes("登录账号已变化"));
});
