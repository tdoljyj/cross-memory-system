import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled=ts.transpileModule(readFileSync(new URL("../app/storage/connections/page.tsx",import.meta.url),"utf8"),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
function fixture(options={}){
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
   if(name==="react/jsx-runtime"){const jsx=(type,props)=>typeof type==="function"?type(props):({type,props});return{jsx,jsxs:jsx};}
   if(name==="next/link")return{__esModule:true,default:"a"};
   if(name.endsWith("/worker/storage-master-disclosure")){
    const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../worker/storage-master-disclosure.ts",import.meta.url),"utf8"),{
     compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});return exports;
   }
   if(name.endsWith("/supabase-browser"))return{supabase:{auth:{
    getSession:async()=>{if(sessionHold){const hold=sessionHold;sessionHold=null;await hold.promise}return{data:{session:owner?{user:{id:owner},access_token:"synthetic-owner-"+owner}:null},error:null}},
    onAuthStateChange(cb){callback=cb;return{data:{subscription:{unsubscribe(){}}}}}}}};
   throw Error(name)},
  fetch(url,init){return new Promise(resolve=>{requests.push({url,init,resolve});
   if(url==="/v1/storage/owner"&&JSON.parse(init.body).action==="master_status")resolve({ok:true,status:200,json:async()=>"master"in options?
    typeof options.master==="function"?options.master(JSON.parse(init.body).connection_id):options.master:{...master,connection_id:JSON.parse(init.body).connection_id}});
  })}});
 const text=n=>Array.isArray(n)?n.map(text).join(""):n==null||typeof n==="boolean"?"":typeof n==="object"?text(n.props?.children):String(n);
 const render=()=>{cursor=0;tree=exports.default();while(effects.length)effects.shift()()};
 const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();render()};
 render();
 const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==="object"?[n,...nodes(n.props?.children)]:[];
 return{requests,settle,navigation,text:()=>text(tree),nodes:()=>nodes(tree),
  holdSession(){let release;sessionHold={promise:new Promise(resolve=>{release=resolve})};return release},
  click(label){const node=nodes(tree).find(n=>n.type==="button"&&text(n.props.children)===label);assert.ok(node,`missing button ${label}`);if(!node.props.disabled)node.props.onClick();render()},
  check(index,checked){const dialog=nodes(tree).find(n=>n.props.role==="dialog");const node=nodes(dialog??tree).filter(n=>n.type==="input"&&n.props.type==="checkbox")[index];assert.ok(node);node.props.onChange({target:{checked}});render()},
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
const read={active:true,read_generation:1,disclosure_version:"clued.storage-read-disclosure/1",
 content_disclosure_version:"clued.storage-read-content-disclosure/1",classes:["read","read_content"]};
const write={active:true,policy_generation:1,disclosure_version:"clued.storage-modify-disclosure/1",
 overwrite_disclosure_version:"clued.storage-overwrite-disclosure/1",classes:[]};
const master={contract:"clued.storage-master-control/1",connection_id:connection.id,state:"partial",master_generation:1,status_digest:"a".repeat(64),
 disclosure_version:"clued.storage-master-disclosure/1",provider_scope_profile:"normal",reconsent_required:true,
 read_classes:["read","read_content"],read_content:true,normal_use:true,write_classes:[],agent_enabled:true,create_enabled:true,read_enabled:true,write_enabled:true};
const replySettings=(f,start=1,n=normal,r=read,w=write)=>{f.respond(start,n);f.respond(start+1,r);f.respond(start+2,w)};
test("initial list reads the range and read/write classes once, and waits for effective truth",async()=>{
 const f=fixture();await f.settle();f.respond(0,listing([connection]));await f.settle();
 assert.equal(f.requests.length,5);assert.deepEqual(f.requests.slice(1).filter(r=>r.url!=="/v1/storage/owner").map(r=>r.url),[
  "/v1/storage/normal-use","/v1/storage/read-access","/v1/storage/write-access"]);
 for(const request of f.requests.slice(1).filter(r=>r.url!=="/v1/storage/owner")){
  assert.deepEqual(JSON.parse(request.init.body),{action:"status",connection_id:connection.id});
  assert.equal(request.init.headers.authorization,"Bearer synthetic-owner-a");
  assert.equal(request.init.method,"POST");assert.equal(request.init.redirect,"error");
 }
 assert.match(f.text(),/正在读取实际状态/);assert.ok(!f.text().includes("已允许读取目录内全部文件"));
 f.respond(1,normal);await f.settle();assert.ok(!f.text().includes("已允许读取目录内全部文件"));
 f.respond(2,read);f.respond(3,write);await f.settle();assert.match(f.text(),/已允许读取目录内全部文件并按内容搜索/);
 assert.equal(f.requests.length,5);
});
test("a failed range read stays unknown and explicit retry rereads the range and actual read classes",async()=>{
 let masterReads=0;const f=fixture({master:()=>masterReads++===0?null:master});await f.settle();f.respond(0,listing([connection]));await f.settle();
 f.respond(1,{error:"private upstream details"},403);f.respond(2,read);f.respond(3,write);await f.settle();
 assert.match(f.text(),/读取与搜索总开关状态未确认/);assert.match(f.text(),/重新读取读取与搜索状态/);
 assert.ok(!f.text().includes("private upstream"));assert.equal(f.requests.length,5);
 f.click("重新读取读取与搜索状态");await f.settle();assert.equal(f.requests.length,8);
 assert.deepEqual(f.requests.slice(5).filter(r=>r.url!=="/v1/storage/owner").map(r=>r.url),["/v1/storage/normal-use","/v1/storage/read-access"]);
 f.respond(5,normal);f.respond(6,read);await f.settle();assert.match(f.text(),/已允许读取目录内全部文件并按内容搜索/);
});
test("same-owner token refresh preserves all pending settings reads; relogin invalidates them",async()=>{
 for(const event of ["TOKEN_REFRESHED","SIGNED_IN"]){
  const f=fixture();await f.settle();f.respond(0,listing([connection]));await f.settle();
  f.event(event);await f.settle();replySettings(f);await f.settle();
  if(event==="TOKEN_REFRESHED"){assert.equal(f.requests.length,5);assert.match(f.text(),/已允许读取目录内全部文件并按内容搜索/)}
  else{assert.equal(f.requests.length,6);assert.ok(!f.text().includes("已允许读取目录内全部文件"));f.respond(5,listing([]));await f.settle()}
 }
});
test("an account switch clears old range and class settings and discards every late read",async()=>{
 const f=fixture();await f.settle();f.respond(0,listing([connection]));await f.settle();
 f.event("SIGNED_IN","b");await f.settle();f.respond(5,listing([]));await f.settle();
 replySettings(f);await f.settle();assert.ok(!f.text().includes("Clued_資料中心"));
 assert.ok(!f.text().includes("已允许读取目录内全部文件"));assert.ok(!f.text().includes("写入权限"));assert.equal(f.requests.length,6);
});
test("revoked connections have no reads while a stopped active connection reports the closed master gate",async()=>{
 const off={...master,connection_id:"11111111-1111-4111-8111-111111111112",state:"off",agent_enabled:false,create_enabled:false,read_enabled:false,write_enabled:false,normal_use:false,read_content:false,read_classes:[],write_classes:[]};
 const f=fixture({master:off});await f.settle();f.respond(0,listing([{...connection,state:"revoked"},{...connection,id:"11111111-1111-4111-8111-111111111112",policy_active:false}]));
 await f.settle();assert.equal(f.requests.length,5);replySettings(f);await f.settle();
 assert.ok(!f.text().includes("已允许读取目录内全部文件"));assert.equal(f.nodes().find(n=>n.props["aria-label"]==="Agent 文件操作总开关").props["aria-checked"],false);
 assert.ok(f.requests.slice(1).every(r=>JSON.parse(r.init.body).connection_id==="11111111-1111-4111-8111-111111111112"));
});
test("each live connection receives only its own range and class truth",async()=>{
 const f=fixture({master:id=>({...master,connection_id:id,normal_use:id!=="11111111-1111-4111-8111-111111111112"})});await f.settle();f.respond(0,listing([connection,{...connection,id:"11111111-1111-4111-8111-111111111112",root_name:"Another root"}]));await f.settle();
 assert.equal(f.requests.length,9);replySettings(f,5,{...normal,normal_use:false});replySettings(f);await f.settle();
 assert.match(f.text(),/已允许读取目录内全部文件并按内容搜索/);assert.match(f.text(),/仅允许读取 BeamingFace 创建的文本文件/);
 assert.deepEqual(f.requests.slice(1).map(x=>JSON.parse(x.init.body).connection_id),[connection.id,connection.id,connection.id,connection.id,...Array(4).fill("11111111-1111-4111-8111-111111111112")]);
});
test("all-file range cannot advertise content search when directory or body reading is stopped",async()=>{
 for(const r of [{...read,active:false,classes:[]},{...read,classes:["read"]}]){
  const f=fixture({master:{...master,read_classes:r.classes,read_enabled:r.active,read_content:r.active&&r.classes.includes("read_content")}});await f.settle();f.respond(0,listing([connection]));await f.settle();replySettings(f,1,normal,r);await f.settle();
  assert.ok(!f.text().includes("已允许读取目录内全部文件并按内容搜索"));
  assert.ok(!f.text().includes("已允许（目录内全部文件）"));
  assert.match(f.text(),r.active?/当前仅允许查看文件名和目录结构/:/目录结构和正文读取均已停止/);
  assert.equal(f.requests.length,5);
 }
});
test("unavailable or differing-generation read truth never advertises all-file capability",async()=>{
 for(const [r,status] of [[{error:"private read reply"},403],[{...read,read_generation:2},200]]){
  const f=fixture({master:null});await f.settle();f.respond(0,listing([connection]));await f.settle();
  f.respond(1,normal);f.respond(2,r,status);f.respond(3,write);await f.settle();
  assert.match(f.text(),/实际读取权限未确认/);assert.ok(!f.text().includes("已允许读取目录内全部文件并按内容搜索"));
  assert.ok(!f.text().includes("已允许（目录内全部文件）"));assert.ok(!f.text().includes("private read reply"));
 }
});
test("a write-status failure leaves reading available but no enabled write operation",async()=>{
 const f=fixture();await f.settle();f.respond(0,listing([connection]));await f.settle();
 f.respond(1,normal);f.respond(2,read);f.respond(3,{error:"private write reply"},403);await f.settle();
 assert.match(f.text(),/已允许读取目录内全部文件并按内容搜索/);assert.match(f.text(),/已有文件修改已全部停止/);
 assert.ok(f.nodes().some(n=>n.type==="button"&&n.props.children==="重新读取写入权限"));
 assert.ok(!f.text().includes("private write reply"));assert.ok(!f.nodes().some(n=>n.type==="button"&&n.props.children==="允许全部修改操作"));
});

const revoked={...connection,state:"revoked",policy_active:false,refresh_enabled:false,root_stopped:true,normal_use_enabled:false};
const preview={trash_available:true,root_folder_id:connection.root_folder_id,root_name:"Verified exact root",
 root_version:"42",metadata_digest:"a".repeat(64),item_count:3,connection_version:1,profile_version:1};
async function ready(rows=[revoked]){const f=fixture();await f.settle();f.respond(0,listing(rows));await f.settle();
 if(rows.some(c=>c.state==="active"&&c.policy_active)){for(let i=1;i<f.requests.length;i++)if(f.requests[i].url!=="/v1/storage/owner")f.respond(i,f.requests[i].url==="/v1/storage/normal-use"?normal:f.requests[i].url==="/v1/storage/read-access"?read:write);await f.settle()}
 return f;}

test("same-name roots show physical paths and exact Drive links; internal namespaces never become paths",async()=>{
 const f=await ready([revoked,{...revoked,id:"second",root_folder_id:"other-root",physical_location:{status:"unavailable",source:"google_drive_metadata"}}]);
 assert.match(f.text(),/Drive 位置：我的云端硬盘\/Physical folder \(1\)/);
 assert.match(f.text(),/Drive 当前名称与路径暂未核实/);assert.ok(!f.text().includes("/clued-cloud/"));
 assert.deepEqual(f.nodes().filter(n=>n.type==="a"&&n.props.href?.startsWith("https://drive.google.com/")).map(n=>n.props.href),[
 "https://drive.google.com/drive/folders/synthetic-root","https://drive.google.com/drive/folders/other-root"]);
});

test("revoked-root reconnect uses exact CAS and disclosed master consent without creating a new folder",async()=>{
 const f=await ready();f.click("重新连接这个文件夹");await f.settle();assert.equal(f.requests.length,1);
 assert.match(f.text(),/不会另建同名文件夹/);assert.match(f.text(),/后台自动续签（默认选中，可随时停用）/);
 f.click("取消");await f.settle();assert.equal(f.requests.length,1);
 f.click("重新连接这个文件夹");f.click("确认并前往 Google 授权");await f.settle();
 const b=JSON.parse(f.requests[1].init.body);assert.equal(f.requests[1].url,"/v1/storage/lifecycle");
 assert.equal(b.action,"reconnect");assert.equal(b.base_version,1);assert.equal(b.profile_version,1);assert.equal(b.root_stop_generation,1);
 assert.equal(b.confirmation.root_folder_id,connection.root_folder_id);assert.equal(b.confirmation.master_enabled,true);assert.equal(b.confirmation.contract,"clued.storage-owner-confirmation/4");assert.equal(b.confirmation.disclosure_version,"clued.storage-master-disclosure/1");assert.ok(!("normal_use"in b.confirmation));
 assert.equal(b.confirmation.default_refresh,true);assert.equal(b.confirmation.refresh_disclosure_version,"clued.storage-reconnect-refresh-disclosure/1");
 assert.ok(!("owner_id"in b));assert.ok(!("root_name"in b));assert.ok(!("default_refresh"in b));
 f.respond(1,{authorization_url:"https://accounts.google.com/o/oauth2/v2/auth?synthetic=true"});await f.settle();assert.equal(f.navigation.length,1);
});

test("reconnect enables all Agent file operations by default under its displayed master disclosure",async()=>{
 const f=await ready();f.click("重新连接这个文件夹");await f.settle();
 assert.equal(f.nodes().find(n=>n.type==="input"&&n.props.type==="checkbox").props.checked,true);
 assert.match(f.text(),/重新连接后开启全部 Agent 文件操作（默认）/);
 assert.match(f.text(),/读取到的内容会发送给该 Agent 所用的模型服务/);
 assert.match(f.text(),/查看、修改、创建和删除你 Google 云端硬盘中的所有文件/);
 f.click("确认并前往 Google 授权");await f.settle();assert.equal(JSON.parse(f.requests[1].init.body).confirmation.master_enabled,true);
});
test("explicitly disabling the reconnect default sends master OFF and cancellation preserves the stopped connection",async()=>{
 const f=await ready();f.click("重新连接这个文件夹");f.check(0,false);await f.settle();
 f.click("取消");await f.settle();assert.equal(f.requests.length,1);assert.equal(f.navigation.length,0);
 f.click("重新连接这个文件夹");f.check(0,false);f.click("确认并前往 Google 授权");await f.settle();
 const body=JSON.parse(f.requests[1].init.body);assert.equal(body.confirmation.master_enabled,false);
 assert.equal(body.confirmation.contract,"clued.storage-owner-confirmation/4");assert.equal(body.confirmation.default_refresh,true);assert.ok(!("normal_use"in body.confirmation));
 assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==="master_set").length,0);assert.equal(f.navigation.length,0);
});

test("reconnect renewal defaults on each fresh dialog; explicit opt-out is independent of the Agent master switch",async()=>{
 const f=await ready();f.click("重新连接这个文件夹");await f.settle();
 const checkboxes=()=>f.nodes().filter(n=>n.type==="input"&&n.props.type==="checkbox");
 assert.deepEqual(checkboxes().map(n=>n.props.checked),[true,true]);
 assert.match(f.text(),/直到你关闭后台续签或断开连接/);
 f.check(1,false);await f.settle();assert.deepEqual(checkboxes().map(n=>n.props.checked),[true,false]);
 f.click("取消");await f.settle();assert.equal(f.requests.length,1);
 f.click("重新连接这个文件夹");await f.settle();assert.deepEqual(checkboxes().map(n=>n.props.checked),[true,true]);
 f.check(1,false);f.click("确认并前往 Google 授权");await f.settle();
 const body=JSON.parse(f.requests[1].init.body);assert.equal(body.confirmation.master_enabled,true);assert.equal(body.confirmation.default_refresh,false);
 assert.equal(body.confirmation.refresh_disclosure_version,"clued.storage-reconnect-refresh-disclosure/1");
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

test("closing consent leaves an immediate explicit retry entry with fresh exact master confirmation",async()=>{
 const f=await ready([{...revoked,pending_lifecycle:{attempt_id:connection.id,operation:"reconnect",state:"prepared",execution_permitted:false}}]);
 assert.match(f.text(),/关闭授权页后，可以重新打开/);assert.equal(f.requests.length,1);assert.equal(f.navigation.length,0);
 f.click("重新打开 Google 授权");await f.settle();assert.equal(f.requests.length,1);
 f.click("取消");await f.settle();assert.equal(f.requests.length,1);assert.equal(f.navigation.length,0);
 f.click("重新打开 Google 授权");f.click("确认并前往 Google 授权");await f.settle();
 const b=JSON.parse(f.requests[1].init.body);assert.equal(b.action,"reconnect");assert.equal(b.connection_id,revoked.id);
 assert.equal(b.base_version,revoked.version);assert.equal(b.root_stop_generation,revoked.root_stop_generation);
 assert.equal(b.confirmation.master_enabled,true);assert.equal(b.confirmation.root_folder_id,revoked.root_folder_id);
 f.respond(1,{authorization_url:"https://accounts.google.com/o/oauth2/v2/auth?synthetic=fresh"});await f.settle();
 assert.deepEqual(f.navigation,["https://accounts.google.com/o/oauth2/v2/auth?synthetic=fresh"]);
});
test("unknown reconnect or delete effects never offer an authorization retry",async()=>{
 for(const [operation,state]of[["reconnect","started"],["reconnect","uncertain"],["delete","prepared"],["delete","uncertain"]]){
  const f=await ready([{...revoked,pending_lifecycle:{attempt_id:connection.id,operation,state,execution_permitted:false}}]);
  assert.ok(!f.text().includes("重新打开 Google 授权"));assert.match(f.text(),/核对上次操作结果/);assert.equal(f.requests.length,1);
 }
});
test("waiting recovery keeps retry visible and gives no ten-minute instruction or automatic OAuth request",async()=>{
 const c={...revoked,pending_lifecycle:{attempt_id:connection.id,operation:"reconnect",state:"prepared",execution_permitted:false}};
 const f=await ready([c]);f.click("核对上次操作结果");await f.settle();f.respond(1,{status:"waiting",execution_permitted:false});
 await f.settle();f.respond(2,listing([c]));await f.settle();
 assert.match(f.text(),/重新打开 Google 授权/);assert.ok(!f.text().includes("最长 10 分钟"));assert.equal(f.requests.length,3);assert.equal(f.navigation.length,0);
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

const wholePreview={...preview,confirmation_contract:"clued.storage-owner-confirmation/2",confirmation_mode:"whole_created_root_v2"};

test("whole Root mode is advertised explicitly, unchecked by default and confirms execution-time scope with exact V2 fields",async()=>{
 const f=await ready([connection]),i=f.requests.length;f.click("删除连接");await f.settle();f.respond(i,wholePreview);await f.settle();
 assert.equal(f.nodes().find(n=>n.type==="input"&&n.props.type==="checkbox").props.checked,false);
 assert.ok(f.text().includes("执行时的全部内容，包括确认后新放进去的内容"));
 assert.ok(f.text().includes("显示的清单仅供参考；执行以这个文件夹标识为准"));
 assert.ok(f.text().includes("名称、位置或内容在确认后发生变化，也会回收这个文件夹及当时其中的全部内容"));
 assert.ok(!f.text().includes("删除连接并移入回收站"));assert.equal(f.requests.length,i+1);
 f.check(0,true);await f.settle();
 const confirm=f.nodes().find(n=>n.type==="button"&&n.props.children==="删除连接并移入回收站").props.onClick;
 confirm();confirm();await f.settle();assert.equal(f.requests.length,i+2);
 const body=JSON.parse(f.requests[i+1].init.body);
 assert.equal(body.action,"delete");assert.equal(body.base_version,connection.version);assert.equal(body.profile_version,connection.profile_version);
 assert.deepEqual(body.confirmation,{contract:"clued.storage-owner-confirmation/2",root_folder_id:connection.root_folder_id,
  confirmed:true,trash_created_root:true,confirmation_mode:"whole_created_root_v2"});
 assert.ok(!("metadata_digest"in body.confirmation));assert.ok(!("root_version"in body.confirmation));assert.ok(!("owner_id"in body));
});

test("an unchecked V2 preview still uses existing V1 connection-only delete, never silently opts into whole Root",async()=>{
 const f=await ready([connection]),i=f.requests.length;f.click("删除连接");await f.settle();f.respond(i,wholePreview);await f.settle();
 f.click("仅删除连接，保留文件夹");await f.settle();
 assert.deepEqual(JSON.parse(f.requests[i+1].init.body).confirmation,{contract:"clued.storage-owner-confirmation/1",
  root_folder_id:connection.root_folder_id,confirmed:true,trash_created_root:false});
 assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==="delete").length,1);
});

test("incomplete, unknown or mismatched whole Root capability cannot offer trash confirmation",async()=>{
 for(const response of [{...preview,confirmation_contract:"clued.storage-owner-confirmation/2"},
  {...preview,confirmation_mode:"whole_created_root_v2"},{...wholePreview,confirmation_mode:"unknown"},
  {...wholePreview,confirmation_contract:"clued.storage-owner-confirmation/1"},{...wholePreview,root_folder_id:"another-root"},
  {...wholePreview,connection_version:2}]){
  const f=await ready([connection]),i=f.requests.length;f.click("删除连接");await f.settle();f.respond(i,response);await f.settle();
  assert.ok(!f.nodes().filter(n=>n.props.role==="dialog").some(n=>{const visit=v=>Array.isArray(v)?v.some(visit):v&&typeof v==="object"?(v.type==="input"&&v.props.type==="checkbox")||visit(v.props.children):false;return visit(n)}));
  assert.ok(!f.text().includes("删除连接并移入回收站"));f.click("取消");await f.settle();assert.equal(f.requests.length,i+1);
 }
});

test("V2 cancellation, account changes and lost result never resend or revive a whole Root confirmation",async()=>{
 const cancelled=await ready([connection]),start=cancelled.requests.length;
 cancelled.click("删除连接");await cancelled.settle();cancelled.respond(start,wholePreview);await cancelled.settle();
 cancelled.check(0,true);cancelled.click("取消");await cancelled.settle();assert.equal(cancelled.requests.length,start+1);
 cancelled.click("删除连接");await cancelled.settle();cancelled.respond(start+1,wholePreview);await cancelled.settle();
 assert.equal(cancelled.nodes().find(n=>n.type==="input"&&n.props.type==="checkbox").props.checked,false);
 const switched=await ready([connection]),i=switched.requests.length;
 switched.click("删除连接");await switched.settle();switched.respond(i,wholePreview);await switched.settle();switched.check(0,true);
 const release=switched.holdSession();switched.click("删除连接并移入回收站");switched.event("SIGNED_IN","b");
 await switched.settle();release();await switched.settle();assert.equal(switched.requests.filter(r=>JSON.parse(r.init.body).action==="delete").length,0);
 const lost=await ready([connection]),j=lost.requests.length;lost.click("删除连接");await lost.settle();lost.respond(j,wholePreview);await lost.settle();
 lost.check(0,true);lost.click("删除连接并移入回收站");await lost.settle();
 lost.respond(j+1,{status:"uncertain",attempt_id:connection.id,execution_permitted:false});await lost.settle();
 lost.respond(j+2,listing([{...revoked,pending_lifecycle:{attempt_id:connection.id,operation:"delete",state:"uncertain",execution_permitted:false}}]));await lost.settle();
 assert.ok(lost.text().includes("核对上次操作结果"));assert.equal(lost.requests.filter(r=>JSON.parse(r.init.body).action==="delete").length,1);
 lost.click("核对上次操作结果");await lost.settle();assert.deepEqual(JSON.parse(lost.requests[j+3].init.body),{action:"recover",attempt_id:connection.id});
});
