import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled=ts.transpileModule(readFileSync(new URL("../app/storage/connections/page.tsx",import.meta.url),"utf8"),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
function fixture(){
 const hooks=[],effects=[],requests=[],navigation=[];let owner="a",callback,cursor=0,tree,sessionHold;
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const React={
  useState(initial){const i=cursor++;hooks[i]??={value:initial};return[hooks[i].value,v=>{hooks[i].value=typeof v==="function"?v(hooks[i].value):v}]},
  useRef(initial){const i=cursor++;hooks[i]??={current:initial};return hooks[i]},
  useCallback(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps))hooks[i]={fn,deps};return hooks[i].fn},
  useEffect(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps)){hooks[i]={deps};effects.push(fn)}}};
 const exports={};vm.runInNewContext(compiled,{exports,URL,Error,queueMicrotask,crypto:{randomUUID:()=>"synthetic-operation"},
  window:{confirm:()=>true,location:{assign:url=>navigation.push(url)}},
  require(name){
   if(name==="react")return React;
   if(name==="react/jsx-runtime")return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
   if(name==="next/link")return{__esModule:true,default:"a"};
   if(name.endsWith("/supabase-browser"))return{supabase:{auth:{
    getSession:async()=>{if(sessionHold){const hold=sessionHold;sessionHold=null;await hold.promise}return{data:{session:owner?{user:{id:owner},access_token:"synthetic-owner-"+owner}:null},error:null}},
    onAuthStateChange(cb){callback=cb;return{data:{subscription:{unsubscribe(){}}}}}}}};
   throw Error(name)},
  fetch(url,init){return new Promise(resolve=>requests.push({url,init,resolve}))}});
 const text=n=>Array.isArray(n)?n.map(text).join(""):n==null||typeof n==="boolean"?"":typeof n==="object"?text(n.props?.children):String(n);
 const render=()=>{cursor=0;tree=exports.default();while(effects.length)effects.shift()()};
 const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();render()};
 render();
 const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==="object"?[n,...nodes(n.props?.children)]:[];
 return{requests,settle,navigation,text:()=>text(tree),nodes:()=>nodes(tree),
  holdSession(){let release;sessionHold={promise:new Promise(resolve=>{release=resolve})};return release},
  click(label){const node=nodes(tree).find(n=>n.type==="button"&&text(n.props.children)===label);assert.ok(node,`missing button ${label}`);if(!node.props.disabled)node.props.onClick();render()},
  check(index,checked){const node=nodes(tree).filter(n=>n.type==="input"&&n.props.type==="checkbox")[index];assert.ok(node);node.props.onChange({target:{checked}});render()},
  event(event,id=owner){owner=id;callback(event,id?{user:{id}}:null);render()},
  respond(i,data,status=200){requests[i].resolve({ok:status<400,status,json:async()=>data})}};
}
const connection={id:"11111111-1111-4111-8111-111111111111",version:1,provider:"google-drive",state:"active",
 auth_mode:"account_policy",root_name:"Clued_資料中心",policy_active:true,actions:["inspect"],
 refresh_enabled:true,database_execution_enabled:true,profile_current:true,
 profile_version:1,root_folder_id:"synthetic-root",managed_root:"/clued-cloud/google-drive/synthetic-root",
 created_by_clued:true,root_stopped:false,root_stop_generation:1,normal_use_enabled:true,
 physical_location:{status:"verified",source:"google_drive_metadata",root_name:"Physical folder (1)",path:"我的云端硬盘/Physical folder (1)"}};
const normal={read_generation:1,disclosure_version:"synthetic-normal/1",provider_scope_profile:"normal",
 normal_use:true,reconsent_required:false,refresh_token_count:1,refresh_token_warning:false,refresh_token_blocked:false};
const listing=rows=>({contract:"clued.storage-owner-lifecycle/1",complete:true,connections:rows,worker_execution_enabled:true});
test("initial list automatically reads normal-use truth and never labels an unknown value as off",async()=>{
 const f=fixture();await f.settle();f.respond(0,listing([connection]));await f.settle();
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,"/v1/storage/normal-use");
 assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:"status",connection_id:connection.id});
 assert.match(f.text(),/正在读取实际状态/);assert.ok(!f.text().includes("正常使用：未开启"));
 f.respond(1,normal);await f.settle();assert.match(f.text(),/正常使用：已开启/);
 assert.ok(!f.text().includes("读取正常使用设置"));assert.equal(f.requests.length,2);
});
test("a failed automatic read stays unknown and exposes a bounded explicit retry",async()=>{
 const f=fixture();await f.settle();f.respond(0,listing([connection]));await f.settle();
 f.respond(1,{error:"private upstream details"},403);await f.settle();
 assert.match(f.text(),/正常使用：状态未确认/);assert.match(f.text(),/重新读取正常使用状态/);
 assert.ok(!f.text().includes("正常使用：未开启"));assert.ok(!f.text().includes("private upstream"));assert.equal(f.requests.length,2);
});
test("same-owner token refresh preserves the pending truth read; relogin invalidates it",async()=>{
 for(const event of ["TOKEN_REFRESHED","SIGNED_IN"]){
  const f=fixture();await f.settle();f.respond(0,listing([connection]));await f.settle();
  f.event(event);await f.settle();f.respond(1,normal);await f.settle();
  if(event==="TOKEN_REFRESHED"){assert.equal(f.requests.length,2);assert.match(f.text(),/正常使用：已开启/)}
  else{assert.equal(f.requests.length,3);assert.ok(!f.text().includes("正常使用：已开启"));f.respond(2,listing([]));await f.settle()}
 }
});
test("an account switch clears old settings and discards late reads",async()=>{
 const f=fixture();await f.settle();f.respond(0,listing([connection]));await f.settle();
 f.event("SIGNED_IN","b");await f.settle();f.respond(2,listing([]));await f.settle();
 f.respond(1,normal);await f.settle();assert.ok(!f.text().includes("Clued_資料中心"));
 assert.ok(!f.text().includes("正常使用：已开启"));assert.equal(f.requests.length,3);
});
test("inactive and stopped policies do not dispatch normal-use reads or acquire settings",async()=>{
 const f=fixture();await f.settle();f.respond(0,listing([{...connection,state:"revoked"},{...connection,id:"second",policy_active:false}]));
 await f.settle();assert.equal(f.requests.length,1);assert.ok(!f.text().includes("正常使用：已开启"));
});
test("each live connection receives only its own normal-use truth",async()=>{
 const f=fixture();await f.settle();f.respond(0,listing([connection,{...connection,id:"second",root_name:"Another root"}]));await f.settle();
 assert.equal(f.requests.length,3);f.respond(2,{...normal,normal_use:false});f.respond(1,normal);await f.settle();
 assert.match(f.text(),/正常使用：已开启/);assert.match(f.text(),/正常使用：未开启/);
 assert.deepEqual(f.requests.slice(1).map(x=>JSON.parse(x.init.body).connection_id),[connection.id,"second"]);
});

const revoked={...connection,state:"revoked",policy_active:false,refresh_enabled:false,root_stopped:true,normal_use_enabled:false};
const preview={trash_available:true,root_folder_id:connection.root_folder_id,root_name:"Verified exact root",
 root_version:"42",metadata_digest:"a".repeat(64),item_count:3,connection_version:1,profile_version:1};
async function ready(rows=[revoked]){const f=fixture();await f.settle();f.respond(0,listing(rows));await f.settle();
 if(rows.some(c=>c.state==="active"&&c.policy_active)){for(let i=1;i<f.requests.length;i++)f.respond(i,normal);await f.settle()}
 return f;}

test("same-name roots show physical paths and exact Drive links; internal namespaces never become paths",async()=>{
 const f=await ready([revoked,{...revoked,id:"second",root_folder_id:"other-root",physical_location:{status:"unavailable",source:"google_drive_metadata"}}]);
 assert.match(f.text(),/Drive 位置：我的云端硬盘\/Physical folder \(1\)/);
 assert.match(f.text(),/Drive 当前名称与路径暂未核实/);assert.ok(!f.text().includes("/clued-cloud/"));
 assert.deepEqual(f.nodes().filter(n=>n.type==="a"&&n.props.href?.startsWith("https://drive.google.com/")).map(n=>n.props.href),[
 "https://drive.google.com/drive/folders/synthetic-root","https://drive.google.com/drive/folders/other-root"]);
});

test("revoked-root reconnect uses exact CAS, fresh confirmation and never requests a new folder or silent normal use",async()=>{
 const f=await ready();f.click("重新连接这个文件夹");await f.settle();assert.equal(f.requests.length,1);
 assert.match(f.text(),/不会另建同名文件夹/);assert.match(f.text(),/后台续签保持关闭/);
 f.click("取消");await f.settle();assert.equal(f.requests.length,1);
 f.click("重新连接这个文件夹");f.click("确认并前往 Google 授权");await f.settle();
 const b=JSON.parse(f.requests[1].init.body);assert.equal(f.requests[1].url,"/v1/storage/lifecycle");
 assert.equal(b.action,"reconnect");assert.equal(b.base_version,1);assert.equal(b.profile_version,1);assert.equal(b.root_stop_generation,1);
 assert.equal(b.confirmation.root_folder_id,connection.root_folder_id);assert.equal(b.confirmation.normal_use,false);
 assert.ok(!("owner_id"in b));assert.ok(!("root_name"in b));assert.ok(!("default_refresh"in b));
 f.respond(1,{authorization_url:"https://accounts.google.com/o/oauth2/v2/auth?synthetic=true"});await f.settle();assert.equal(f.navigation.length,1);
});

test("normal use on reconnect requires its displayed disclosure and explicit checkbox",async()=>{
 const f=await ready();f.click("重新连接这个文件夹");f.check(0,true);await f.settle();
 assert.match(f.text(),/读取到的内容会发送给该 Agent 所用的模型服务/);
 f.click("确认并前往 Google 授权");await f.settle();assert.equal(JSON.parse(f.requests[1].init.body).confirmation.normal_use,true);
});

test("created-root deletion first reads a snapshot; cancel makes no mutation; confirmation is one-shot and exact",async()=>{
 const f=await ready([connection]);const start=f.requests.length;
 f.click("删除连接");await f.settle();assert.deepEqual(JSON.parse(f.requests[start].init.body),{action:"preview_delete",connection_id:connection.id});
 f.respond(start,preview);await f.settle();assert.match(f.text(),/其中 3 个文件和子文件夹/);assert.match(f.text(),/包括你后来放进去的内容/);
 f.click("取消");await f.settle();assert.equal(f.requests.length,start+1);
 f.click("删除连接");await f.settle();f.respond(start+1,preview);await f.settle();
 const confirm=f.nodes().find(n=>n.type==="button"&&n.props.children==="删除连接并移入回收站").props.onClick;
 confirm();confirm();await f.settle();assert.equal(f.requests.length,start+3);
 const b=JSON.parse(f.requests[start+2].init.body);assert.equal(b.action,"delete");assert.equal(b.confirmation.trash_created_root,true);
 assert.equal(b.confirmation.metadata_digest,preview.metadata_digest);assert.equal(b.confirmation.root_version,"42");assert.equal(b.confirmation.root_folder_id,connection.root_folder_id);
 f.respond(start+2,{status:"completed",connection_id:connection.id,receipt_id:"synthetic-receipt",root_trashed:true});await f.settle();
 f.respond(start+3,listing([]));await f.settle();assert.match(f.text(),/连接已删除，文件夹及其中内容已移入/);
});

test("picked or unverified created roots allow connection-only deletion without an upstream trash request",async()=>{
 for(const c of [{...revoked,created_by_clued:false},revoked]){
 const f=await ready([c]);f.click("删除连接");await f.settle();assert.equal(f.requests.length,1);
 assert.ok(!f.text().includes("删除连接并移入回收站"));f.click("仅删除连接，保留文件夹");await f.settle();
 const b=JSON.parse(f.requests[1].init.body);assert.equal(b.confirmation.trash_created_root,false);assert.ok(!("metadata_digest"in b.confirmation));
 }});

test("preview mismatch cannot authorize trash and unknown delete only exposes read-only recovery",async()=>{
 const f=await ready([connection]);const i=f.requests.length;f.click("删除连接");await f.settle();
 f.respond(i,{...preview,root_folder_id:"different-root"});await f.settle();assert.ok(!f.text().includes("删除连接并移入回收站"));
 f.click("仅删除连接，保留文件夹");await f.settle();f.respond(i+1,{status:"uncertain",attempt_id:connection.id,execution_permitted:false});await f.settle();
 f.respond(i+2,listing([{...revoked,pending_lifecycle:{attempt_id:connection.id,operation:"delete",state:"uncertain",execution_permitted:false}}]));await f.settle();
 assert.match(f.text(),/核对上次操作结果/);assert.ok(!f.nodes().some(n=>n.type==="button"&&n.props.children==="删除连接"));
 f.click("核对上次操作结果");await f.settle();assert.deepEqual(JSON.parse(f.requests[i+3].init.body),{action:"recover",attempt_id:connection.id});
 assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==="delete").length,1);
});

test("account switch discards a late destructive preview and never sends its confirmation",async()=>{
 const f=await ready([connection]);const i=f.requests.length;f.click("删除连接");await f.settle();
 f.event("SIGNED_IN","b");await f.settle();f.respond(i+1,listing([]));await f.settle();f.respond(i,preview);await f.settle();
 assert.ok(!f.nodes().some(n=>n.props.role==="dialog"));assert.ok(!f.text().includes("Verified exact root"));
 assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==="delete").length,0);
});

test("cancelling while a metadata preview is pending keeps late results closed and sends no deletion",async()=>{
 const f=await ready([connection]);const i=f.requests.length;f.click("删除连接");await f.settle();
 f.click("取消");await f.settle();assert.ok(!f.nodes().some(n=>n.props.role==="dialog"));
 f.respond(i,preview);await f.settle();assert.ok(!f.nodes().some(n=>n.props.role==="dialog"));
 assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==="delete").length,0);
});

test("cancelled reconnect recovery restores the explicit reconnect entry without automatic OAuth restart",async()=>{
 const f=await ready([{...revoked,pending_lifecycle:{attempt_id:connection.id,operation:"reconnect",state:"prepared",execution_permitted:false}}]);
 f.click("核对上次操作结果");await f.settle();assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:"recover",attempt_id:connection.id});
 f.respond(1,{status:"cancelled",execution_permitted:false});await f.settle();f.respond(2,listing([revoked]));await f.settle();
 assert.match(f.text(),/可以重新确认/);assert.match(f.text(),/重新连接这个文件夹/);assert.equal(f.requests.length,3);assert.equal(f.navigation.length,0);
});

test("account switch before lifecycle dispatch prevents stale consent from using the new account token",async()=>{
 for(const event of ["SIGNED_IN","SIGNED_OUT"]){
 const f=await ready();f.click("删除连接");const release=f.holdSession();f.click("仅删除连接，保留文件夹");
 f.event(event,event==="SIGNED_IN"?"b":null);await f.settle();release();await f.settle();
 assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==="delete").length,0);assert.equal(f.navigation.length,0);
 }
});

test("unavailable delete previews explain provider conditions without suggesting an active connection needs reconnect",async()=>{
 for(const [reason,expected] of [["can_trash_unavailable","未能确认 Google 允许"],
  ["conditional_capability_unavailable","未取得删除所需的版本保护信息"]]){
  const f=await ready([connection]),i=f.requests.length;f.click("删除连接");await f.settle();
  f.respond(i,{...preview,trash_available:false,reason});await f.settle();
  assert.ok(f.text().includes(expected));assert.ok(!f.text().includes("请先恢复连接"));
  assert.ok(!f.text().includes("删除连接并移入回收站"));assert.equal(f.requests.length,i+1);
  f.click("仅删除连接，保留文件夹");await f.settle();
  const body=JSON.parse(f.requests[i+1].init.body);
  assert.equal(body.action,"delete");assert.equal(body.confirmation.trash_created_root,false);
  assert.ok(!("metadata_digest"in body.confirmation));assert.ok(!("root_version"in body.confirmation));
 }
});

test("safe read failures remain distinct, do not leak responses or retry, and cancel leaves zero mutations",async()=>{
 for(const [reason,expected] of [["fresh_authorization_required","当前 Google 授权无法"],
  ["metadata_unavailable","未能读取 Google 的文件夹信息"],
  ["inventory_unavailable","未能完整核对"],["operation_deadline","限定时间内"],
  ["root_drift","登记信息不一致"],["storage_connection_unavailable","访问资格未能确认"],
  ["storage_owner_lifecycle_conflict","核对期间发生了变化"]]){
  const f=await ready([connection]),i=f.requests.length;f.click("删除连接");await f.settle();
  f.respond(i,{reason,error:"private provider reply synthetic-secret"},409);await f.settle();
  assert.ok(f.text().includes(expected));assert.ok(!f.text().includes("synthetic-secret"));
  assert.ok(!f.text().includes("删除连接并移入回收站"));assert.equal(f.requests.length,i+1);
  f.click("取消");await f.settle();assert.equal(f.requests.length,i+1);
  assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==="delete").length,0);
 }
});

test("unknown or malformed preview reasons stay generic and never acquire destructive confirmation",async()=>{
 for(const [value,status] of [[{trash_available:false,reason:"private_provider_body"},200],
  [{reason:"synthetic-secret provider reply"},409],[{...preview,item_count:-1},200],
  [{...preview,trash_available:"true"},200]]){
  const f=await ready([connection]),i=f.requests.length;f.click("删除连接");await f.settle();
  f.respond(i,value,status);await f.settle();assert.ok(f.text().includes("当前无法确定具体原因"));
  assert.ok(!f.text().includes("private_provider_body"));assert.ok(!f.text().includes("synthetic-secret"));
  assert.ok(!f.text().includes("删除连接并移入回收站"));assert.equal(f.requests.length,i+1);
  f.click("取消");await f.settle();assert.equal(f.requests.length,i+1);
 }
});

test("connection and profile CAS drift explain refreshing the list while a foreign root stays refused",async()=>{
 for(const changed of [{connection_version:2},{profile_version:2},{root_folder_id:"foreign-root"}]){
  const f=await ready([connection]),i=f.requests.length;f.click("删除连接");await f.settle();
  f.respond(i,{...preview,...changed});await f.settle();
  assert.ok(f.text().includes(changed.root_folder_id?"登记信息不一致":"关闭窗口并刷新状态"));
  assert.ok(!f.text().includes("删除连接并移入回收站"));assert.equal(f.requests.length,i+1);
  f.click("取消");await f.settle();assert.equal(f.requests.length,i+1);
 }
});

test("known inactive state and picked provenance explain why preview is not dispatched",async()=>{
 for(const [row,expected] of [[revoked,"目前未处于已连接状态"],
  [{...connection,created_by_clued:false},"已有或自行选择的文件夹"]]){
  const f=await ready([row]),i=f.requests.length;f.click("删除连接");await f.settle();
  assert.ok(f.text().includes(expected));assert.ok(!f.text().includes("删除连接并移入回收站"));
  assert.equal(f.requests.length,i);f.click("取消");await f.settle();assert.equal(f.requests.length,i);
 }
});
