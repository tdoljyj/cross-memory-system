import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source=readFileSync(new URL("../app/storage/connections/page.tsx",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020,esModuleInterop:true,
}}).outputText;
const active={id:"fixture-connection",version:4,provider:"google-drive",state:"active",auth_mode:"account_policy",
  root_name:"Clued_资料中心",policy_active:true,actions:["inspect","create_file","create_topic"],
  refresh_enabled:true,database_execution_enabled:false,profile_current:true};
function fixture() {
  const hooks=[],effects=[],calls=[],prompts=[];let cursor=0,tree,authCallback,owner="owner";
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const React={
    useState(initial){const i=cursor++;hooks[i]??={value:initial};return [hooks[i].value,v=>{hooks[i].value=typeof v==="function"?v(hooks[i].value):v;}]},
    useRef(initial){const i=cursor++;hooks[i]??={current:initial};return hooks[i];},
    useCallback(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps))hooks[i]={fn,deps};return hooks[i].fn;},
    useEffect(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps)){hooks[i]={deps};effects.push(fn);}},
  };
  const exports={};
  vm.runInNewContext(compiled,{exports,URL,Error,queueMicrotask,crypto:{randomUUID:()=>"fixture-id"},
    window:{confirm:message=>{prompts.push(message);return true;},location:{assign(){}}},
    require(name){
      if(name==="react")return React;
      if(name==="react/jsx-runtime")return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
      if(name==="next/link")return {__esModule:true,default:"a"};
      if(name.endsWith("/supabase-browser"))return {supabase:{auth:{
        getSession:async()=>({data:{session:owner?{user:{id:owner},access_token:"native-"+owner}:null},error:null}),
        onAuthStateChange(cb){authCallback=cb;return {data:{subscription:{unsubscribe(){}}}};},
      }}};
      throw Error(name);
    },
    fetch(url,init){return new Promise(resolve=>calls.push({url,init,resolve}));},
  });
  const render=()=>{cursor=0;tree=exports.default();while(effects.length)effects.shift()();};
  const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();render();};
  const text=n=>Array.isArray(n)?n.map(text).join(""):n==null||typeof n==="boolean"?"":typeof n==="object"?text(n.props?.children):String(n);
  function button(label){let found;const walk=n=>{if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=="object")return;
    if(n.type==="button"&&text(n)===label)found=n;walk(n.props?.children);};walk(tree);assert.ok(found,label);return found;}
  render();
  return {calls,prompts,settle,button,text:()=>text(tree),
    respond(i,value,status=200){calls[i].resolve({ok:status<400,status,json:async()=>value});},
    change(id){owner=id;authCallback("SIGNED_IN",id?{user:{id}}:null);render();},
  };
}
test("everyday page shows exact scope and a paused execution gate without technical grant controls",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.calls[0].url,"/v1/storage/owner");
  assert.deepEqual(JSON.parse(f.calls[0].init.body),{action:"connections"});
  assert.match(f.text(),/Clued_资料中心/);assert.match(f.text(),/当前文件操作不可用或暂停/);
  assert.equal(f.text().includes(active.id),false);
  for(const phrase of ["Agent 存储权限","Decision ID","授权客户端","登记账号连接"])assert.equal(f.text().includes(phrase),false);
});
test("whole-drive disconnect sends one native CAS mutation and requires matching readback",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  const button=f.button("断开网盘连接");button.props.onClick();button.props.onClick();await f.settle();
  assert.equal(f.calls.length,2);assert.match(f.prompts[0],/不删除 Google Drive 文件/);
  assert.match(f.prompts[0],/断开后不再允许读取提供方/);
  assert.equal(f.calls[1].url,"/v1/storage/owner");
  assert.deepEqual(JSON.parse(f.calls[1].init.body),{action:"disconnect",connection_id:active.id,base_version:4,idempotency_key:"fixture-id"});
  f.respond(1,{status:"committed",receipt_id:"fixture-receipt"});await f.settle();
  assert.equal(f.calls.length,3);f.respond(2,{connections:[{...active,state:"revoked",policy_active:false,refresh_enabled:false,version:5}],worker_execution_enabled:false});
  await f.settle();assert.match(f.text(),/网盘连接已断开/);assert.equal(f.calls.length,3);
});
test("unknown disconnect result does not resend or claim success",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("断开网盘连接").props.onClick();await f.settle();
  f.respond(1,{error:"private"},403);await f.settle();
  assert.equal(f.calls.length,3);f.respond(2,{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/断开结果未确认/);assert.equal(f.calls.length,3);
});
