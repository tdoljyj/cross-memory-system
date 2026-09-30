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
const writeStatus=classes=>({active:true,policy_generation:classes.length+1,
  disclosure_version:"clued.storage-modify-disclosure/1",overwrite_disclosure_version:"clued.storage-overwrite-disclosure/1",classes});
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
test("Agent read level is loaded on demand and toggled by one native CAS mutation with readback",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.calls.length,1,"the everyday page stays one request");
  assert.match(f.text(),/Agent 查看目录结构：未读取/);
  f.button("读取 Agent 查看设置").props.onClick();await f.settle();
  assert.equal(f.calls[1].url,"/v1/storage/read-access");
  assert.deepEqual(JSON.parse(f.calls[1].init.body),{action:"status",connection_id:active.id});
  assert.equal(f.calls[2].url,"/v1/storage/write-access");
  assert.deepEqual(JSON.parse(f.calls[2].init.body),{action:"status",connection_id:active.id});
  f.respond(1,{active:false,read_generation:0,disclosure_version:"clued.storage-read-disclosure/1",
    content_disclosure_version:"clued.storage-read-content-disclosure/1",classes:[]});
  f.respond(2,writeStatus([]));await f.settle();
  assert.equal(f.text().includes("允许 Agent 读正文"),false,"bodies are offered only while read is on");
  const allow=f.button("允许 Agent 查看目录结构");allow.props.onClick();allow.props.onClick();await f.settle();
  assert.equal(f.calls.length,4);assert.match(f.prompts.at(-1),/不读取文件内容，不修改任何文件/);
  assert.deepEqual(JSON.parse(f.calls[3].init.body),{action:"set_classes",connection_id:active.id,classes:["read"],
    base_generation:0,disclosure_version:"clued.storage-read-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(3,{status:"committed",receipt_id:"fixture-read-receipt"});await f.settle();
  f.respond(4,{active:true,read_generation:1,disclosure_version:"clued.storage-read-disclosure/1",
    content_disclosure_version:"clued.storage-read-content-disclosure/1",classes:["read"]});await f.settle();
  assert.match(f.text(),/已允许 Agent 查看目录结构。回执：fixture-read-receipt/);
  assert.match(f.text(),/已允许（只看文件名和目录，不读内容）/);
  const stop=f.button("停止 Agent 查看目录结构");stop.props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.calls[5].init.body).classes,[]);assert.equal(JSON.parse(f.calls[5].init.body).base_generation,1);
  f.respond(5,{error:"private"},403);await f.settle();
  assert.match(f.text(),/Agent 查看设置结果未确认/);assert.match(f.text(),/Agent 查看目录结构：未读取/);
  assert.equal(f.calls.length,6,"an unknown result is never resent");
});
test("reading bodies is a separate toggle with its own disclosure, and stopping it keeps the read level",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("读取 Agent 查看设置").props.onClick();await f.settle();
  const status=classes=>({active:true,read_generation:classes.length+1,disclosure_version:"clued.storage-read-disclosure/1",
    content_disclosure_version:"clued.storage-read-content-disclosure/1",classes});
  f.respond(1,status(["read"]));f.respond(2,writeStatus([]));await f.settle();
  assert.match(f.text(),/Agent 读正文：未允许/);
  f.button("允许 Agent 读正文").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/由 Clued 创建的文本文件正文/);assert.match(f.prompts.at(-1),/发送给该 Agent 所用的模型服务/);
  assert.deepEqual(JSON.parse(f.calls[3].init.body),{action:"set_classes",connection_id:active.id,classes:["read","read_content"],
    base_generation:2,disclosure_version:"clued.storage-read-content-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(3,{status:"committed",receipt_id:"fixture-content-receipt"});await f.settle();
  f.respond(4,status(["read","read_content"]));await f.settle();
  assert.match(f.text(),/已允许 Agent 读正文。回执：fixture-content-receipt/);assert.match(f.text(),/Agent 读正文：已允许/);
  f.button("停止 Agent 读正文").props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.calls[5].init.body),{action:"set_classes",connection_id:active.id,classes:["read"],
    base_generation:3,disclosure_version:"clued.storage-read-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(5,{status:"committed",receipt_id:"fixture-stop-receipt"});await f.settle();
  f.respond(6,status(["read"]));await f.settle();
  assert.match(f.text(),/已停止 Agent 读正文/);assert.match(f.text(),/已允许（只看文件名和目录，不读内容）/);
});
test("rename and move is its own write-level toggle; it replaces the policy and reloads everything",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("读取 Agent 查看设置").props.onClick();await f.settle();
  f.respond(1,{active:false,read_generation:0,disclosure_version:"clued.storage-read-disclosure/1",
    content_disclosure_version:"clued.storage-read-content-disclosure/1",classes:[]});
  f.respond(2,writeStatus([]));await f.settle();
  assert.match(f.text(),/Agent 改名和移动文件：未允许/);
  const allow=f.button("允许 Agent 改名和移动文件");allow.props.onClick();allow.props.onClick();await f.settle();
  assert.equal(f.calls.length,4);
  assert.match(f.prompts.at(-1),/由 Clued 创建的文件/);assert.match(f.prompts.at(-1),/尚未开始的排队任务会被取消/);
  assert.equal(f.calls[3].url,"/v1/storage/write-access");
  assert.deepEqual(JSON.parse(f.calls[3].init.body),{action:"set_classes",connection_id:active.id,classes:["modify"],
    base_generation:1,disclosure_version:"clued.storage-modify-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(3,{status:"committed",receipt_id:"fixture-modify-receipt"});await f.settle();
  assert.equal(f.calls[4].url,"/v1/storage/owner","the connection list is reloaded");
  f.respond(4,{connections:[{...active,actions:[...active.actions,"modify"]}],worker_execution_enabled:false});await f.settle();
  assert.equal(f.calls[5].url,"/v1/storage/write-access");assert.equal(f.calls[6].url,"/v1/storage/read-access");
  f.respond(5,writeStatus(["modify"]));
  f.respond(6,{active:false,read_generation:0,disclosure_version:"clued.storage-read-disclosure/1",
    content_disclosure_version:"clued.storage-read-content-disclosure/1",classes:[]});await f.settle();
  assert.match(f.text(),/已允许 Agent 改名和移动文件。回执：fixture-modify-receipt/);
  assert.match(f.text(),/改名、移动文件/);
  f.button("停止 Agent 改名和移动文件").props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.calls[7].init.body).classes,[]);assert.equal(JSON.parse(f.calls[7].init.body).base_generation,2);
  f.respond(7,{error:"private"},403);await f.settle();
  assert.match(f.text(),/Agent 修改设置结果未确认/);assert.equal(f.calls.length,8,"an unknown result is never resent");
});
test("overwrite is its own toggle with its own disclosure and keeps rename/move as is",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("读取 Agent 查看设置").props.onClick();await f.settle();
  f.respond(1,{active:false,read_generation:0,disclosure_version:"clued.storage-read-disclosure/1",
    content_disclosure_version:"clued.storage-read-content-disclosure/1",classes:[]});
  f.respond(2,writeStatus(["modify"]));await f.settle();
  assert.match(f.text(),/Agent 覆盖文件内容：未允许/);assert.match(f.text(),/Agent 改名和移动文件：已允许/);
  f.button("允许 Agent 覆盖文件内容").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/保存为永久保留的 Google Drive 版本/);assert.match(f.prompts.at(-1),/最近 10 个/);
  assert.deepEqual(JSON.parse(f.calls[3].init.body),{action:"set_classes",connection_id:active.id,classes:["modify","overwrite"],
    base_generation:2,disclosure_version:"clued.storage-overwrite-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(3,{status:"committed",receipt_id:"fixture-overwrite-receipt"});await f.settle();
  f.respond(4,{connections:[{...active,actions:[...active.actions,"modify","overwrite"]}],worker_execution_enabled:false});await f.settle();
  f.respond(5,writeStatus(["modify","overwrite"]));
  f.respond(6,{active:false,read_generation:0,disclosure_version:"clued.storage-read-disclosure/1",
    content_disclosure_version:"clued.storage-read-content-disclosure/1",classes:[]});await f.settle();
  assert.match(f.text(),/已允许 Agent 覆盖文件内容。回执：fixture-overwrite-receipt/);assert.match(f.text(),/覆盖文件内容/);
});
// StorageNormalUse.v0.1 §8.2: one "正常使用" toggle; the four toggles stay under 高级.
const normalStatus=(profile,on,extra={})=>({connection_id:active.id,read_generation:on?3:1,disclosure_version:"clued.storage-normal-use-disclosure/1",
  provider_scope_profile:profile,normal_use:on,reconsent_required:profile!=="normal",refresh_token_count:2,refresh_token_warning:false,
  refresh_token_blocked:false,...extra});
test("normal use with a normal credential is one native CAS mutation under the versioned disclosure",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.calls.length,1,"normal use is loaded on demand");assert.match(f.text(),/正常使用：未读取/);assert.match(f.text(),/高级/);
  f.button("读取正常使用设置").props.onClick();await f.settle();
  assert.equal(f.calls[1].url,"/v1/storage/normal-use");assert.deepEqual(JSON.parse(f.calls[1].init.body),{action:"status",connection_id:active.id});
  f.respond(1,normalStatus("normal",false));await f.settle();
  assert.match(f.text(),/正常使用：未开启/);
  const on=f.button("开启正常使用");on.props.onClick();on.props.onClick();await f.settle();
  assert.equal(f.calls.length,3);
  assert.match(f.prompts.at(-1),/读取「Clued_资料中心」内的全部文件，包括你手动上传的文件/);
  assert.match(f.prompts.at(-1),/查看你 Google 云端硬盘中的所有文件/);assert.match(f.prompts.at(-1),/这个限制由 Clued 保证，不由 Google 保证/);
  assert.equal(f.prompts.at(-1).includes("前往 Google 授权页面"),false);
  assert.deepEqual(JSON.parse(f.calls[2].init.body),{action:"enable",connection_id:active.id,base_generation:1,
    disclosure_version:"clued.storage-normal-use-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(2,{status:"committed",receipt_id:"fixture-normal-receipt"});await f.settle();
  f.respond(3,normalStatus("normal",true));await f.settle();
  assert.match(f.text(),/已开启正常使用。回执：fixture-normal-receipt/);assert.match(f.text(),/正常使用：已开启/);
  f.button("关闭正常使用").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/不会收回 Google 授权/);
  assert.equal(JSON.parse(f.calls[4].init.body).action,"disable");assert.equal(JSON.parse(f.calls[4].init.body).base_generation,3);
  f.respond(4,{error:"private"},403);await f.settle();
  assert.match(f.text(),/正常使用设置结果未确认/);assert.match(f.text(),/正常使用：未读取/);assert.equal(f.calls.length,5,"never resent");
});
test("normal use on a legacy connection starts Google re-consent with the normal set; busy and token limits are explained",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("读取正常使用设置").props.onClick();await f.settle();f.respond(1,normalStatus("legacy",false));await f.settle();
  assert.match(f.text(),/开启需要重新授权 Google/);
  f.button("开启正常使用").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/前往 Google 授权页面/);
  assert.equal(f.calls[2].url,"/v1/storage/google/start");
  assert.deepEqual(JSON.parse(f.calls[2].init.body),{connection_id:active.id,normal_use:{disclosure_version:"clued.storage-normal-use-disclosure/1"}});
  f.respond(2,{error:"Storage Google connection unavailable.",reason:"storage_root_busy"},403);await f.settle();
  assert.match(f.text(),/该目录还有尚未完成的文件操作，稍后再试/);
  f.button("读取正常使用设置").props.onClick();await f.settle();
  f.respond(3,normalStatus("legacy",false,{refresh_token_count:90,refresh_token_warning:true,refresh_token_blocked:true}));await f.settle();
  assert.match(f.text(),/授权次数已达上限/);
  const before=f.calls.length;f.button("开启正常使用").props.onClick();await f.settle();
  assert.equal(f.calls.length,before,"a blocked account starts no consent");assert.match(f.text(),/暂时不能通过重新授权开启正常使用/);
  assert.equal(f.text().includes("请先撤回全部文件读取授权"),false,"never points to a control that does not exist");
});
