import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source=readFileSync(new URL("../app/storage/connections/page.tsx",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020,esModuleInterop:true,
}}).outputText;
const active={id:"10000000-0000-4000-8000-000000000090",version:4,provider:"google-drive",state:"active",auth_mode:"account_policy",
  root_name:"Clued_资料中心",policy_active:true,actions:["inspect","create_file","create_topic"],
  refresh_enabled:true,database_execution_enabled:false,profile_current:true,
  profile_id:"10000000-0000-4000-8000-000000000091",project_id:"10000000-0000-4000-8000-000000000092",
  profile_version:1,root_folder_id:"fixture-root",root_parent_id:"fixture-parent",managed_root:"/registered/fixture-root",
  created_by_clued:false,root_stopped:false,root_stop_generation:0,normal_use_enabled:false,
  physical_location:{status:"verified",source:"google_drive_metadata",path:"我的云端硬盘/Clued_资料中心",root_name:"Clued_资料中心"}};
const writeStatus=classes=>({active:true,policy_generation:classes.length+1,
  disclosure_version:"clued.storage-modify-disclosure/1",overwrite_disclosure_version:"clued.storage-overwrite-disclosure/1",classes});
const readStatus=(classes,generation=classes.length+1)=>({active:classes.includes("read"),read_generation:generation,
  disclosure_version:"clued.storage-read-disclosure/1",content_disclosure_version:"clued.storage-read-content-disclosure/1",classes});
const masterStatus=(state="partial",extra={})=>({contract:"clued.storage-master-control/1",connection_id:active.id,state,master_generation:1,status_digest:"a".repeat(64),
  disclosure_version:"clued.storage-master-disclosure/1",provider_scope_profile:"full",reconsent_required:false,
  read_classes:state==="on"?["read","read_content"]:[],read_content:state==="on",normal_use:state==="on",
  write_classes:state==="on"?["modify","overwrite","destructive","modify_subtree"]:[],agent_enabled:state!=="off",create_enabled:state!=="off",read_enabled:state==="on",write_enabled:state!=="off",...extra});
function fixture(initialNormal = normalStatus("normal",false), initialRead = readStatus([],1), initialWrite = writeStatus([]),
  initialMaster, options = {}) {
  const hooks=[],effects=[],calls=[],prompts=[],assigned=[];let cursor=0,tree,authCallback,owner="owner",cancelNextConfirm=false,masterReads=0,sessionHold;
  let automaticReads = new Map(), initialList=true;
  let serverNormal=initialNormal,serverRead=initialRead,serverWrite=initialWrite;
  const pendingMasters=[];
  const deriveMaster=()=>{
    if(!serverNormal||!serverRead||!serverWrite)return null;
    const full=serverNormal.provider_scope_profile==="full",readClasses=serverRead.active?serverRead.classes:[],writeClasses=serverWrite.active?serverWrite.classes:[];
    const on=full&&serverNormal.normal_use&&readClasses.includes("read")&&readClasses.includes("read_content")&&["modify","overwrite","destructive","modify_subtree"].every(v=>writeClasses.includes(v));
    return masterStatus(on?"on":"partial",{provider_scope_profile:serverNormal.provider_scope_profile,reconsent_required:!full,
      read_classes:readClasses,read_enabled:serverRead.active,write_enabled:serverWrite.active,read_content:readClasses.includes("read_content"),normal_use:serverRead.active&&readClasses.includes("read_content")&&serverNormal.normal_use,write_classes:writeClasses});
  };
  const flushMasters=()=>{
    if(calls.some(c=>!c.answered&&["/v1/storage/normal-use","/v1/storage/read-access","/v1/storage/write-access"].includes(c.url)&&JSON.parse(c.init.body).action==="status"))return;
    while(pendingMasters.length){const c=pendingMasters.shift();c.answered=true;c.resolve({ok:true,status:200,json:async()=>initialMaster===undefined?deriveMaster():initialMaster});}
  };
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const React={
    useState(initial){const i=cursor++;hooks[i]??={value:initial};return [hooks[i].value,v=>{hooks[i].value=typeof v==="function"?v(hooks[i].value):v;}]},
    useRef(initial){const i=cursor++;hooks[i]??={current:initial};return hooks[i];},
    useCallback(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps))hooks[i]={fn,deps};return hooks[i].fn;},
    useEffect(fn,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps)){hooks[i]={deps};effects.push(fn);}},
  };
  const exports={};
  vm.runInNewContext(compiled,{exports,URL,Error,queueMicrotask,crypto:{randomUUID:()=>"fixture-id"},
    window:{confirm:message=>{prompts.push(message);const allowed=!cancelNextConfirm;cancelNextConfirm=false;return allowed;},location:{assign(url){assigned.push(url);}}},
    require(name){
      if(name==="react")return React;
      if(name==="react/jsx-runtime"){const jsx=(type,props)=>typeof type==="function"?type(props):({type,props});return {jsx,jsxs:jsx};}
      if(name==="next/link")return {__esModule:true,default:"a"};
      if(name.endsWith("/worker/storage-master-disclosure")){
        const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../worker/storage-master-disclosure.ts",import.meta.url),"utf8"),{
          compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});return exports;
      }
      if(name.endsWith("/supabase-browser"))return {supabase:{auth:{
        getSession:async()=>{if(sessionHold){const hold=sessionHold;sessionHold=null;await hold.promise;}return {data:{session:owner?{user:{id:owner},access_token:"native-"+owner}:null},error:null};},
        onAuthStateChange(cb){authCallback=cb;return {data:{subscription:{unsubscribe(){}}}};},
      }}};
      throw Error(name);
    },
    fetch(url,init){return new Promise(resolve=>{
      calls.push({url,init,resolve,answered:false});
      if(url==="/v1/storage/owner"&&JSON.parse(init.body).action==="master_status"&&(!options.manualMasterReads||masterReads++===0)){
        assert.deepEqual(JSON.parse(init.body),{action:"master_status",connection_id:active.id});
        pendingMasters.push(calls.at(-1));flushMasters();return;
      }
      if(automaticReads.has(url) && JSON.parse(init.body).action === "status") {
        // All initial background reads remain in the complete request log. Only
        // their deterministic responses are automatic; mutation/readbacks stay controlled.
        assert.deepEqual(JSON.parse(init.body),{action:"status",connection_id:active.id});
        assert.equal(init.headers.authorization,"Bearer native-"+owner);
        assert.equal(init.method,"POST");assert.equal(init.redirect,"error");
        const value=automaticReads.get(url);automaticReads.delete(url);calls.at(-1).answered=true;resolve({ok:true,status:200,json:async()=>value});
      }
    });},
  });
  const render=()=>{cursor=0;tree=exports.default();while(effects.length)effects.shift()();};
  const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();render();};
  const text=n=>Array.isArray(n)?n.map(text).join(""):n==null||typeof n==="boolean"?"":typeof n==="object"?text(n.props?.children):String(n);
  const nodes=n=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==="object"?[n,...nodes(n.props?.children)]:[];
  function button(label){let found;const walk=n=>{if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=="object")return;
    if(n.type==="button"&&text(n)===label)found=n;walk(n.props?.children);};walk(tree);assert.ok(found,label);return found;}
  render();
  function labelled(label){let found;const walk=n=>{if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=="object")return;
    if(n.props?.["aria-label"]===label)found=n;walk(n.props?.children);};walk(tree);return found;}
  return {calls,prompts,assigned,settle,button,labelled,render,text:()=>text(tree),tree:()=>tree,nodes:()=>nodes(tree),
    cancelNextConfirm(){cancelNextConfirm=true;},
    holdSession(){let release;sessionHold={promise:new Promise(resolve=>{release=resolve})};return release;},
    respond(i,value,status=200){
      if(calls[i].url === "/v1/storage/lifecycle" && Array.isArray(value.connections)) {
        value={contract:"clued.storage-owner-lifecycle/1",complete:true,...value};
        automaticReads=initialList&&value.connections.some(c=>c.state==="active" && c.auth_mode==="account_policy" && c.policy_active)
          ? new Map([["/v1/storage/normal-use",initialNormal],["/v1/storage/read-access",initialRead],["/v1/storage/write-access",initialWrite]]) : new Map();
        initialList=false;
      }
      calls[i].answered=true;
      if(JSON.parse(calls[i].init.body).action==="status"){
        const latest=status<400?value:null;
        if(calls[i].url==="/v1/storage/normal-use")serverNormal=latest;
        if(calls[i].url==="/v1/storage/read-access")serverRead=latest;
        if(calls[i].url==="/v1/storage/write-access")serverWrite=latest;
      }
      calls[i].resolve({ok:status<400,status,json:async()=>value});
      flushMasters();
    },
    pending(url,action="status"){const i=calls.findIndex(c=>!c.answered&&c.url===url&&(action===null||JSON.parse(c.init.body).action===action));assert.ok(i>=0,`pending ${url} ${action}`);return i;},
    request(url,action="status"){const call=calls.findLast(c=>c.url===url&&(action===null||JSON.parse(c.init.body).action===action));assert.ok(call,`request ${url} ${action}`);return call;},
    featureCalls(){return calls.filter(c=>c.url!=="/v1/storage/owner"||JSON.parse(c.init.body).action!=="master_status");},
    change(id){owner=id;authCallback("SIGNED_IN",id?{user:{id}}:null);render();},
  };
}
async function replyReading(f,read,normal=normalStatus("normal",false,{read_generation:read.read_generation})) {
  f.respond(f.pending("/v1/storage/read-access"),read);
  f.respond(f.pending("/v1/storage/normal-use"),normal);
  await f.settle();
}
async function replyRefresh(f,rows=[active],normal=normalStatus("normal",false),read=readStatus([],1),write=writeStatus([]),master) {
  f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:rows,worker_execution_enabled:false});await f.settle();
  if(rows.some(c=>c.state==="active"&&c.auth_mode==="account_policy"&&c.policy_active)) {
    f.respond(f.pending("/v1/storage/normal-use"),normal);
    f.respond(f.pending("/v1/storage/read-access"),read);
    f.respond(f.pending("/v1/storage/write-access"),write);
    if(master!==undefined)f.respond(f.pending("/v1/storage/owner","master_status"),master);
    await f.settle();
  }
}
async function readyMaster(master) {
  const f=fixture(fullStatus("full"),readStatus(["read","read_content"],3),allStatus(["modify","overwrite","destructive","modify_subtree"]),master,{manualMasterReads:true});
  await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();return f;
}
async function replyMasterReload(f,master,retainConfiguration=false) {
  const normal=fullStatus("full",{normal_use:retainConfiguration||master.normal_use,read_generation:3});
  const read=readStatus(retainConfiguration?["read","read_content"]:master.read_classes,3);
  const write=allStatus(retainConfiguration?["modify","overwrite","destructive","modify_subtree"]:master.write_classes);
  await replyRefresh(f,[active],normal,read,write,master);
  f.respond(f.pending("/v1/storage/owner","master_status"),master);await f.settle();
}
test("master is a true three-state checkbox; malformed or incomplete all-on truth stays unknown",async()=>{
  for(const state of ["on","off","partial"]){
    const f=await readyMaster(masterStatus(state));const input=f.labelled("Agent 文件操作总开关");
    assert.equal(input.type,"input");assert.equal(input.props.type,"checkbox");assert.equal(input.props.disabled,false);
    assert.equal(input.props["aria-checked"],state==="partial"?"mixed":state==="on");assert.equal(input.props.checked,state==="on");
    const element={indeterminate:false};input.props.ref(element);assert.equal(element.indeterminate,state==="partial");
    assert.match(f.text(),state==="on"?/全开/:state==="off"?/全关/:/部分开启/);
    const request=f.request("/v1/storage/owner","master_status");assert.deepEqual(JSON.parse(request.init.body),{action:"master_status",connection_id:active.id});
    assert.equal(request.init.headers.authorization,"Bearer native-owner");assert.equal(request.init.redirect,"error");
    assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="master_set").length,0);
  }
  for(const master of [null,masterStatus("on",{connection_id:"10000000-0000-4000-8000-000000000099"}),masterStatus("on",{create_enabled:false}),masterStatus("on",{provider_scope_profile:"normal"}),
    masterStatus("on",{read_classes:["read"]}),masterStatus("on",{write_classes:["modify"]}),masterStatus("off",{agent_enabled:true})]){
    const f=await readyMaster(master);const input=f.labelled("Agent 文件操作总开关");assert.equal(input.props.disabled,true);assert.equal(input.props.checked,false);
    assert.match(f.text(),/总开关状态未确认/);assert.ok(!f.text().includes("已允许读取目录内全部文件并按内容搜索"));
  }
});
test("master ON is one digest-and-generation CAS and confirms every capability before reporting all on",async()=>{
  const initial=masterStatus("partial"),f=await readyMaster(initial),input=f.labelled("Agent 文件操作总开关");
  input.props.onChange({target:{checked:true,indeterminate:false}});input.props.onChange({target:{checked:true,indeterminate:false}});await f.settle();
  const body=JSON.parse(f.request("/v1/storage/owner","master_set").init.body);
  assert.deepEqual(body,{action:"master_set",connection_id:active.id,enabled:true,base_generation:1,base_status_digest:initial.status_digest,
    disclosure_version:"clued.storage-master-disclosure/1",idempotency_key:"fixture-id"});
  assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="master_set").length,1);
  assert.match(f.prompts[0],/新建文件与目录/);assert.match(f.prompts[0],/移入回收站和恢复/);assert.match(f.prompts[0],/移动整个文件夹/);
  f.respond(f.pending("/v1/storage/owner","master_set"),{status:"committed",receipt_id:"master-on-receipt"});await f.settle();
  assert.notEqual(f.labelled("Agent 文件操作总开关").props.checked,true);
  const on=masterStatus("on",{master_generation:2,status_digest:"b".repeat(64)});await replyMasterReload(f,on);
  assert.equal(f.labelled("Agent 文件操作总开关").props.checked,true);assert.match(f.text(),/Agent 文件操作已全部开启。回执：master-on-receipt/);
  assert.equal(on.provider_scope_profile,"full");assert.equal(on.create_enabled,true);assert.equal(on.agent_enabled,true);
  assert.deepEqual(on.read_classes,["read","read_content"]);assert.equal(on.normal_use,true);assert.equal(on.write_classes.length,4);
  assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="set_classes").length,0,"master does not simulate a series of fine-grained writes");
});
test("master OFF stops all Agent admissions even when old fine-grained configuration is still visible",async()=>{
  const f=await readyMaster(masterStatus("on"));f.labelled("Agent 文件操作总开关").props.onChange({target:{checked:true,indeterminate:false}});await f.settle();
  assert.equal(JSON.parse(f.request("/v1/storage/owner","master_set").init.body).enabled,false);
  assert.match(f.prompts[0],/目录查看、正文读取、搜索、新建、上传、纳管、修改、移动和回收站操作都会停止/);
  f.respond(f.pending("/v1/storage/owner","master_set"),{status:"committed",receipt_id:"master-off-receipt"});await f.settle();
  await replyMasterReload(f,masterStatus("off",{master_generation:2,status_digest:"b".repeat(64)}),true);
  assert.equal(f.labelled("Agent 文件操作总开关").props["aria-checked"],false);assert.match(f.text(),/Agent 文件操作已全部停止/);
  assert.match(f.text(),/总开关已关闭；读取与搜索已停止/);assert.match(f.text(),/总开关已关闭；Agent 写入已停止/);
  assert.match(f.text(),/总开关已关闭，纳管与修改已停止；Google 授权范围保留/);
  assert.ok(!f.text().includes("已允许读取目录内全部文件并按内容搜索"));assert.match(f.text(),/Agent 改名和移动文件：已配置允许/);
  assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="set_classes").length,0);
});
test("the verified atomic full scope overrides stale or absent normal-use scope details",async()=>{
  for(const normal of [null,fullStatus("normal")]){
    const f=fixture(normal,readStatus(["read","read_content"],3),allStatus(["modify","overwrite","destructive","modify_subtree"]),masterStatus("on"));
    await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
    assert.equal(f.labelled("Agent 文件操作总开关").props.checked,true);assert.match(f.text(),/Google 已授予完整云端硬盘权限/);
    assert.throws(()=>f.button("允许纳管已有文件"));assert.ok(!f.text().includes("已有文件的纳管授权状态未确认"));
  }
});
test("partial execution gates stop actual reads and writes even while every fine-grained class remains configured",async()=>{
  const f=await readyMaster(masterStatus("partial",{read_classes:["read","read_content"],read_content:true,normal_use:true,
    write_classes:["modify","overwrite","destructive","modify_subtree"],read_enabled:false,write_enabled:false,create_enabled:false}));
  assert.equal(f.labelled("Agent 文件操作总开关").props["aria-checked"],"mixed");
  assert.ok(!f.text().includes("已允许读取目录内全部文件并按内容搜索"));assert.ok(!f.text().includes("已有文件修改：已允许 4 / 4"));
  assert.match(f.text(),/目录结构和正文读取均已停止/);assert.match(f.text(),/Agent 写入已停止/);assert.match(f.text(),/新建文件与目录：已停止/);
  assert.match(f.text(),/Agent 改名和移动文件：已配置允许/);
});
test("a fine-grained content switch derives partial from fresh master truth without making another master mutation",async()=>{
  const f=await readyMaster(masterStatus("on"));f.button("停止 Agent 读正文").props.onClick();await f.settle();
  f.respond(f.pending("/v1/storage/read-access","set_classes"),{status:"committed",receipt_id:"content-off"});await f.settle();
  f.respond(f.pending("/v1/storage/read-access"),readStatus(["read"],4));f.respond(f.pending("/v1/storage/normal-use"),fullStatus("full",{read_generation:4}));
  f.respond(f.pending("/v1/storage/owner","master_status"),masterStatus("partial",{master_generation:2,status_digest:"b".repeat(64),read_classes:["read"],read_enabled:true,read_content:false,
    normal_use:true,write_classes:["modify","overwrite","destructive","modify_subtree"]}));await f.settle();
  assert.equal(f.labelled("Agent 文件操作总开关").props["aria-checked"],"mixed");assert.match(f.text(),/当前仅允许查看文件名和目录结构/);
  assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="master_set").length,0);
});
test("master ON with insufficient Google scope starts only disclosed reconsent and does not report all on",async()=>{
  const initial=masterStatus("partial",{provider_scope_profile:"normal",reconsent_required:true}),f=await readyMaster(initial);
  f.labelled("Agent 文件操作总开关").props.onChange({target:{checked:true,indeterminate:false}});await f.settle();
  const request=f.request("/v1/storage/google/start",null);assert.deepEqual(JSON.parse(request.init.body),{connection_id:active.id,
    full_scope:{disclosure_version:"clued.storage-master-disclosure/1"}});
  assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="master_set").length,0);assert.equal(f.labelled("Agent 文件操作总开关").props.checked,false);
  f.respond(f.pending("/v1/storage/google/start",null),{authorization_url:"https://accounts.google.com/o/oauth2/v2/auth?fixture=master"});await f.settle();
  assert.equal(f.assigned.length,1);assert.equal(f.labelled("Agent 文件操作总开关").props["aria-checked"],"mixed");
});
test("cancelling master confirmation sends no mutation or OAuth request",async()=>{
  for(const state of ["on","partial"]){const f=await readyMaster(masterStatus(state)),before=f.calls.length;f.cancelNextConfirm();
    f.labelled("Agent 文件操作总开关").props.onChange({target:{checked:true,indeterminate:false}});await f.settle();assert.equal(f.calls.length,before);
    assert.equal(f.labelled("Agent 文件操作总开关").props["aria-checked"],state==="partial"?"mixed":true);}
});
test("CAS refusal and unknown master results clear current truth and never resend",async()=>{
  for(const result of [{error:"private CAS details",reason:"storage_master_conflict"},{status:"unknown"}]){
    const f=await readyMaster(masterStatus("partial"));f.labelled("Agent 文件操作总开关").props.onChange({target:{checked:true,indeterminate:false}});await f.settle();
    f.respond(f.pending("/v1/storage/owner","master_set"),result,result.error?409:200);await f.settle();
    assert.equal(f.labelled("Agent 文件操作总开关").props.disabled,true);assert.ok(!f.text().includes("Agent 文件操作已全部开启"));
    assert.ok(!f.text().includes("private CAS details"));assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="master_set").length,1);
  }
});
test("old master receipts, unchanged digests and partial or insufficient-scope readbacks cannot report success",async()=>{
  for(const next of [masterStatus("on"),masterStatus("on",{master_generation:2}),masterStatus("partial",{master_generation:2,status_digest:"b".repeat(64)}),
    masterStatus("on",{master_generation:2,status_digest:"b".repeat(64),provider_scope_profile:"normal"})]){
    const f=await readyMaster(masterStatus("partial"));f.labelled("Agent 文件操作总开关").props.onChange({target:{checked:true,indeterminate:false}});await f.settle();
    f.respond(f.pending("/v1/storage/owner","master_set"),{status:"committed",receipt_id:"old-or-unconfirmed"});await f.settle();await replyMasterReload(f,next);
    assert.ok(!f.text().includes("Agent 文件操作已全部开启"));assert.match(f.text(),/最新状态未确认/);
    assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="master_set").length,1);
  }
});
test("account switch clears the old master and discards a late master mutation result",async()=>{
  const f=await readyMaster(masterStatus("partial"));f.labelled("Agent 文件操作总开关").props.onChange({target:{checked:true,indeterminate:false}});await f.settle();
  const pending=f.pending("/v1/storage/owner","master_set");f.change("new-owner");await f.settle();
  f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[],worker_execution_enabled:false});await f.settle();
  f.respond(pending,{status:"committed",receipt_id:"old-owner-receipt"});await f.settle();
  assert.equal(f.labelled("Agent 文件操作总开关"),undefined);assert.ok(!f.text().includes("old-owner-receipt"));assert.equal(f.assigned.length,0);
  assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="master_set").length,1);
});
test("account switch before dispatch prevents stale master consent from using another account",async()=>{
  for(const reconsent of [false,true]){
    const f=await readyMaster(masterStatus("partial",{reconsent_required:reconsent,provider_scope_profile:reconsent?"normal":"full"}));
    const release=f.holdSession();f.labelled("Agent 文件操作总开关").props.onChange({target:{checked:true,indeterminate:false}});f.change("new-owner");await f.settle();
    f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[],worker_execution_enabled:false});release();await f.settle();
    assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="master_set").length,0);assert.equal(f.assigned.length,0);
    assert.equal(f.calls.filter(c=>c.url==="/v1/storage/google/start").length,0);assert.equal(f.labelled("Agent 文件操作总开关"),undefined);
  }
});
async function replyWriteReload(f,write,rows=[active],read=readStatus([],1)) {
  await replyRefresh(f,rows,normalStatus("normal",false),read,write);
  f.respond(f.pending("/v1/storage/write-access"),write);
  f.respond(f.pending("/v1/storage/read-access"),read);await f.settle();
}
test("everyday page shows exact scope and a paused execution gate without technical grant controls",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.calls[0].url,"/v1/storage/lifecycle");
  assert.deepEqual(JSON.parse(f.calls[0].init.body),{action:"list"});
  assert.equal(f.request("/v1/storage/normal-use","status").url,"/v1/storage/normal-use");
  assert.deepEqual(f.featureCalls().slice(1).map(c=>c.url),["/v1/storage/normal-use","/v1/storage/read-access","/v1/storage/write-access"]);
  assert.match(f.text(),/Clued_资料中心/);assert.match(f.text(),/连接执行条件：当前未满足/);
  assert.equal(f.text().includes(active.id),false);
  for(const phrase of ["Agent 存储权限","Decision ID","授权客户端","登记账号连接"])assert.equal(f.text().includes(phrase),false);
});
test("permission groups have one control surface each and advanced operations stay in closed details",async()=>{
  const f=fixture(fullStatus("normal"),readStatus(["read","read_content"],3),allStatus([]));await f.settle();
  f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.deepEqual(f.nodes().filter(n=>n.type==="h3").map(n=>n.props.children),["Agent 文件操作","读取与搜索","可操作的文件范围","写入权限"]);
  for(const label of ["关闭读取与搜索","允许纳管已有文件","允许全部修改操作","停止全部修改操作"])
    assert.equal(f.nodes().filter(n=>n.type==="button"&&n.props.children===label).length,1,label);
  const details=f.nodes().filter(n=>n.type==="details");
  for(const label of ["细分读取权限","按操作设置写入权限"]){
    const group=details.find(n=>n.props.children.some?.(child=>child?.type==="summary"&&child.props.children===label));
    assert.ok(group,label);assert.notEqual(group.props.open,true,"advanced controls start collapsed");
  }
  assert.equal(f.nodes().filter(n=>n.type==="button"&&n.props.children==="允许 Agent 改名和移动文件").length,1);
  assert.match(f.text(),/已有文件修改已全部停止/);assert.match(f.text(),/新建权限随总开关和全部文件读取与搜索设置生效/);
  assert.ok(!f.text().includes("正常使用："));assert.ok(!f.text().includes("管理已有文件："));
  assert.equal(f.featureCalls().length,4,"grouping the controls dispatches no mutation");
});
test("whole-drive disconnect sends one native CAS mutation and requires matching readback",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  const button=f.button("断开网盘连接");button.props.onClick();button.props.onClick();await f.settle();
  assert.equal(f.featureCalls().length,5);assert.match(f.prompts[0],/不删除 Google Drive 文件/);
  assert.match(f.prompts[0],/断开后不再允许读取提供方/);
  assert.equal(f.request("/v1/storage/owner","disconnect").url,"/v1/storage/owner");
  assert.deepEqual(JSON.parse(f.request("/v1/storage/owner","disconnect").init.body),{action:"disconnect",connection_id:active.id,base_version:4,idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/owner","disconnect"),{status:"committed",receipt_id:"fixture-receipt"});await f.settle();
  assert.equal(f.featureCalls().length,6);await replyRefresh(f,[{...active,state:"revoked",policy_active:false,refresh_enabled:false,version:5}]);
  assert.match(f.text(),/网盘连接已断开/);assert.equal(f.featureCalls().length,6);
});
test("unknown disconnect result does not resend or claim success",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("断开网盘连接").props.onClick();await f.settle();
  f.respond(f.pending("/v1/storage/owner","disconnect"),{error:"private"},403);await f.settle();
  assert.equal(f.featureCalls().length,6);await replyRefresh(f);
  assert.match(f.text(),/断开结果未确认/);assert.equal(f.featureCalls().length,9);
});
test("Agent read level is loaded with the list and toggled by one native CAS mutation with shared-generation readback",async()=>{
  const f=fixture(normalStatus("normal",false),readStatus([],0));await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.featureCalls().length,4,"the everyday page reads the lifecycle list and all effective capability settings");
  assert.match(f.text(),/Agent 查看目录结构：未配置允许/);
  assert.equal(f.request("/v1/storage/read-access","status").url,"/v1/storage/read-access");
  assert.deepEqual(JSON.parse(f.request("/v1/storage/read-access","status").init.body),{action:"status",connection_id:active.id});
  assert.equal(f.request("/v1/storage/write-access","status").url,"/v1/storage/write-access");
  assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","status").init.body),{action:"status",connection_id:active.id});
  assert.equal(f.text().includes("允许 Agent 读正文"),false,"bodies are offered only while read is on");
  const allow=f.button("允许 Agent 查看目录结构");allow.props.onClick();allow.props.onClick();await f.settle();
  assert.equal(f.featureCalls().length,5);assert.match(f.prompts.at(-1),/不读取文件内容，不修改任何文件/);
  assert.deepEqual(JSON.parse(f.request("/v1/storage/read-access","set_classes").init.body),{action:"set_classes",connection_id:active.id,classes:["read"],
    base_generation:0,disclosure_version:"clued.storage-read-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/read-access","set_classes"),{status:"committed",receipt_id:"fixture-read-receipt"});await f.settle();
  await replyReading(f,readStatus(["read"],1));
  assert.match(f.text(),/已允许 Agent 查看目录结构。回执：fixture-read-receipt/);
  assert.match(f.text(),/当前仅允许查看文件名和目录结构/);
  const stop=f.button("停止 Agent 查看目录结构");stop.props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.request("/v1/storage/read-access","set_classes").init.body).classes,[]);assert.equal(JSON.parse(f.request("/v1/storage/read-access","set_classes").init.body).base_generation,1);
  f.respond(f.pending("/v1/storage/read-access","set_classes"),{error:"private"},403);await f.settle();
  assert.match(f.text(),/Agent 查看设置结果未确认/);assert.match(f.text(),/Agent 查看目录结构：未确认/);
  assert.equal(f.featureCalls().length,8,"an unknown result is never resent");
});
test("reading bodies is a separate toggle with its own disclosure, and stopping it keeps the read level",async()=>{
  const f=fixture(normalStatus("normal",false),readStatus(["read"],2));await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  const status=classes=>({active:true,read_generation:classes.length+1,disclosure_version:"clued.storage-read-disclosure/1",
    content_disclosure_version:"clued.storage-read-content-disclosure/1",classes});
  assert.match(f.text(),/Agent 读正文：未配置允许/);
  f.button("允许 Agent 读正文").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/由 Clued 创建的文本文件正文/);assert.match(f.prompts.at(-1),/发送给该 Agent 所用的模型服务/);
  assert.deepEqual(JSON.parse(f.request("/v1/storage/read-access","set_classes").init.body),{action:"set_classes",connection_id:active.id,classes:["read","read_content"],
    base_generation:2,disclosure_version:"clued.storage-read-content-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/read-access","set_classes"),{status:"committed",receipt_id:"fixture-content-receipt"});await f.settle();
  await replyReading(f,status(["read","read_content"]));
  assert.match(f.text(),/已允许 Agent 读正文。回执：fixture-content-receipt/);assert.match(f.text(),/Agent 读正文：已配置允许/);
  f.button("停止 Agent 读正文").props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.request("/v1/storage/read-access","set_classes").init.body),{action:"set_classes",connection_id:active.id,classes:["read"],
    base_generation:3,disclosure_version:"clued.storage-read-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/read-access","set_classes"),{status:"committed",receipt_id:"fixture-stop-receipt"});await f.settle();
  await replyReading(f,status(["read"]));
  assert.match(f.text(),/已停止 Agent 读正文/);assert.match(f.text(),/当前仅允许查看文件名和目录结构/);
});
test("rename and move is its own write-level toggle; it replaces the policy and reloads everything",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/Agent 改名和移动文件：未配置允许/);
  const allow=f.button("允许 Agent 改名和移动文件");allow.props.onClick();allow.props.onClick();await f.settle();
  assert.equal(f.featureCalls().length,5);
  assert.match(f.prompts.at(-1),/由 Clued 创建的文件/);assert.match(f.prompts.at(-1),/尚未开始的排队任务会被取消/);
  assert.equal(f.request("/v1/storage/write-access","set_classes").url,"/v1/storage/write-access");
  assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","set_classes").init.body),{action:"set_classes",connection_id:active.id,classes:["modify"],
    base_generation:1,disclosure_version:"clued.storage-modify-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/write-access","set_classes"),{status:"committed",receipt_id:"fixture-modify-receipt"});await f.settle();
  assert.equal(f.request("/v1/storage/lifecycle","list").url,"/v1/storage/lifecycle","the connection list is reloaded");
  await replyWriteReload(f,writeStatus(["modify"]),[{...active,actions:[...active.actions,"modify"]}]);
  assert.equal(f.request("/v1/storage/write-access","status").url,"/v1/storage/write-access");assert.equal(f.request("/v1/storage/read-access","status").url,"/v1/storage/read-access");
  assert.match(f.text(),/已允许 Agent 改名和移动文件。回执：fixture-modify-receipt/);
  assert.match(f.text(),/改名、移动文件/);
  f.button("停止 Agent 改名和移动文件").props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","set_classes").init.body).classes,[]);assert.equal(JSON.parse(f.request("/v1/storage/write-access","set_classes").init.body).base_generation,2);
  f.respond(f.pending("/v1/storage/write-access","set_classes"),{error:"private"},403);await f.settle();
  assert.match(f.text(),/Agent 修改设置结果未确认/);assert.equal(f.featureCalls().length,12,"an unknown result is never resent");
});
test("a level switch refused because the root has an unresolved job says so (fix d9d6db4c)",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("允许 Agent 改名和移动文件").props.onClick();await f.settle();
  f.respond(f.pending("/v1/storage/write-access","set_classes"),{error:"Storage access operation unavailable.",reason:"storage_root_busy"},409);await f.settle();
  assert.match(f.text(),/未修改：此目录有一个已开始但未结束的任务/);
  assert.doesNotMatch(f.text(),/结果未确认/);assert.equal(f.featureCalls().length,5,"a refusal is never resent");
});
test("overwrite is its own toggle with its own disclosure and keeps rename/move as is",async()=>{
  const f=fixture(normalStatus("normal",false),readStatus([],1),writeStatus(["modify"]));await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/Agent 覆盖文件内容：未配置允许/);assert.match(f.text(),/Agent 改名和移动文件：已配置允许/);
  assert.match(f.text(),/修改对象：仅 BeamingFace 创建或已纳管的文件和文件夹/);
  f.button("允许 Agent 覆盖文件内容").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/保存为永久保留的 Google Drive 版本/);assert.match(f.prompts.at(-1),/最近 10 个/);
  assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","set_classes").init.body),{action:"set_classes",connection_id:active.id,classes:["modify","overwrite"],
    base_generation:2,disclosure_version:"clued.storage-overwrite-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/write-access","set_classes"),{status:"committed",receipt_id:"fixture-overwrite-receipt"});await f.settle();
  await replyWriteReload(f,writeStatus(["modify","overwrite"]),[{...active,actions:[...active.actions,"modify","overwrite"]}]);
  assert.match(f.text(),/已允许 Agent 覆盖文件内容。回执：fixture-overwrite-receipt/);assert.match(f.text(),/覆盖文件内容/);
});
// StorageFullCapability P5: the destructive level and the native trash batch confirmation.
const destructiveStatus=classes=>({...writeStatus(classes),destructive_disclosure_version:"clued.storage-destructive-disclosure/1"});
test("moving files to the trash is its own toggle with its own disclosure; a server without it shows no toggle",async()=>{
  const f=fixture(normalStatus("normal",false),readStatus([],1),destructiveStatus([]));await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/Agent 把文件移入回收站：未配置允许/);
  f.button("允许 Agent 把文件移入回收站").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/30 天后自动永久删除/);assert.match(f.prompts.at(-1),/不会永久删除/);assert.match(f.prompts.at(-1),/超过 5 项/);assert.match(f.prompts.at(-1),/空目录/);
  assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","set_classes").init.body),{action:"set_classes",connection_id:active.id,classes:["destructive"],
    base_generation:1,disclosure_version:"clued.storage-destructive-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/write-access","set_classes"),{status:"committed",receipt_id:"fixture-destructive-receipt"});await f.settle();
  await replyWriteReload(f,destructiveStatus(["destructive"]),[{...active,actions:[...active.actions,"destructive"]}]);
  assert.match(f.text(),/已允许 Agent 把文件移入回收站。回执：fixture-destructive-receipt/);
  assert.match(f.text(),/移入回收站、从回收站恢复/);
  // The Agent's pending batch is listed with each item's ID and version and confirmed once ("全部确认").
  f.button("读取回收站确认").props.onClick();await f.settle();
  assert.equal(f.request("/v1/storage/trash-confirmation","status").url,"/v1/storage/trash-confirmation");
  assert.deepEqual(JSON.parse(f.request("/v1/storage/trash-confirmation","status").init.body),{action:"status",connection_id:active.id});
  const item=(extra={})=>({operation:"delete",target_kind:"file",path:"/Clued_资料中心/20_P/a.md",provider_file_id:"drive-a",
    provider_file_version:"9",current:true,used:false,...extra});
  const batch=(status,items)=>({batch_id:"batch-1",status,created_at:"2026-10-01T00:00:00Z",expires_at:"2026-10-02T00:00:00Z",items});
  const stale={...batch("pending",[item(),item({path:"/Clued_资料中心/20_P/b.md",provider_file_id:"drive-b",current:false})]),batch_id:"batch-0"};
  const pending=batch("pending",[item(),item({operation:"restore",target_kind:"directory",path:"/Clued_资料中心/20_P/old",provider_file_id:"drive-d",provider_file_version:"2"})]);
  f.respond(f.pending("/v1/storage/trash-confirmation","status"),{destructive:true,policy_generation:2,limit:5,window_hours:24,batches_truncated:true,batches:[pending,stale]});await f.settle();
  assert.match(f.text(),/移入回收站：\/Clued_资料中心\/20_P\/a\.md（ID drive-a，版本 9）/);
  assert.match(f.text(),/从回收站恢复（空目录）：\/Clued_资料中心\/20_P\/old/);
  assert.match(f.text(),/已变化，不能确认/);assert.match(f.text(),/只显示最近 20 个批次/);
  assert.match(f.text(),/同一客户端登记/);assert.equal(f.text().includes("同一 Agent"),false);
  // A batch with a changed item cannot be confirmed; the current one can, as a whole.
  let buttons=[];const walk=n=>{if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=="object")return;
    if(n.type==="button"&&n.props?.children==="全部确认")buttons.push(n);walk(n.props?.children);};
  const confirmButtons=()=>{buttons=[];walk(f.tree());return buttons;};
  assert.equal(confirmButtons().length,2);assert.equal(confirmButtons()[1].props.disabled,true);
  confirmButtons()[0].props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/共 2 项/);assert.match(f.prompts.at(-1),/30 天后自动永久删除/);
  assert.equal(f.request("/v1/storage/trash-confirmation","confirm").url,"/v1/storage/trash-confirmation");
  assert.deepEqual(JSON.parse(f.request("/v1/storage/trash-confirmation","confirm").init.body),{action:"confirm",connection_id:active.id,batch_id:"batch-1",base_generation:2,
    idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/trash-confirmation","confirm"),{status:"committed",receipt_id:"fixture-trash-confirmation"});await f.settle();
  f.respond(f.pending("/v1/storage/trash-confirmation","status"),{destructive:true,policy_generation:2,limit:5,window_hours:24,batches_truncated:false,batches:[batch("confirmed",pending.items)]});await f.settle();
  assert.match(f.text(),/已确认这批 2 项。回执：fixture-trash-confirmation/);
  assert.match(f.text(),/已确认批次/);assert.equal(confirmButtons().length,0);
});
test("without the destructive disclosure in the status, the page offers only rename/move and overwrite",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/Agent 覆盖文件内容：未配置允许/);assert.equal(f.text().includes("回收站"),false);
});
// Decision 62e796f9: one button for every write level, one confirmation, then one
// change per level (each with its own disclosure and the generation the last one produced).
const allStatus=classes=>({...writeStatus(classes),destructive_disclosure_version:"clued.storage-destructive-disclosure/1",
  subtree_disclosure_version:"clued.storage-subtree-disclosure/1"});
const readOff={active:false,read_generation:0,disclosure_version:"clued.storage-read-disclosure/1",
  content_disclosure_version:"clued.storage-read-content-disclosure/1",classes:[]};
test("all write levels at once: one confirmation, then one change per level in order",async()=>{
  const f=fixture(normalStatus("normal",false),readOff,allStatus(["overwrite"]));await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.button("停止全部修改操作").props.disabled,false);
  const all=f.button("允许全部修改操作");all.props.onClick();all.props.onClick();await f.settle();
  assert.equal(f.prompts.length,1,"one confirmation");
  const prompt=f.prompts.at(-1);
  assert.match(prompt,/一次允许以下 3 项/);assert.match(prompt,/【改名和移动文件】/);assert.match(prompt,/【把文件移入回收站】/);
  assert.match(prompt,/30 天后自动永久删除/);assert.match(prompt,/【移动整个文件夹】/);
  assert.equal(prompt.includes("【覆盖文件内容】"),false,"a level already on is not changed");
  const steps=[["modify","clued.storage-modify-disclosure/1",["modify","overwrite"]],
    ["destructive","clued.storage-destructive-disclosure/1",["destructive","modify","overwrite"]],
    ["modify_subtree","clued.storage-subtree-disclosure/1",["destructive","modify","modify_subtree","overwrite"]]];
  let call=4,generation=2;
  for(const [level,disclosure,classes] of steps){
    assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","set_classes").init.body),{action:"set_classes",connection_id:active.id,classes,
      base_generation:generation,disclosure_version:disclosure,idempotency_key:"fixture-id"},level);
    f.respond(f.pending("/v1/storage/write-access","set_classes"),{status:"committed",receipt_id:`r-${level}`});await f.settle();call++;
    if(level==="modify_subtree")break;
    assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","status").init.body),{action:"status",connection_id:active.id});
    f.respond(f.pending("/v1/storage/write-access","status"),allStatus(classes));await f.settle();call++;generation=classes.length+1;
  }
  assert.equal(f.request("/v1/storage/lifecycle","list").url,"/v1/storage/lifecycle","then everything is reloaded once");
  await replyWriteReload(f,allStatus(["destructive","modify","modify_subtree","overwrite"]),[active],readOff);
  assert.match(f.text(),/已允许 Agent 改名和移动文件、把文件移入回收站、移动整个文件夹。回执：r-modify、r-destructive、r-modify_subtree/);
  assert.equal(f.button("允许全部修改操作").props.disabled,true,"nothing left to allow");
  // Stopping all goes the other way round, the most destructive levels first.
  f.button("停止全部修改操作").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/一次停止以下 4 项/);
  assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","set_classes").init.body).classes,["destructive","modify","overwrite"],"modify_subtree first");
  f.respond(f.pending("/v1/storage/write-access","set_classes"),{status:"committed",receipt_id:"s-1"});await f.settle();
  f.respond(f.pending("/v1/storage/write-access","status"),allStatus(["destructive","modify","overwrite"]));await f.settle();
  assert.deepEqual(JSON.parse(f.request("/v1/storage/write-access","set_classes").init.body).classes,["modify","overwrite"]);
  // A refusal part way names what already changed and stops.
  f.respond(f.pending("/v1/storage/write-access","set_classes"),{error:"Storage access operation unavailable.",reason:"storage_root_busy"},409);await f.settle();
  assert.match(f.text(),/已停止：移动整个文件夹（回执：s-1）；其余未完成。此目录有一个已开始但未结束的任务/);
  assert.equal(f.featureCalls().length,call+9,"never resent");
});
test("the bulk buttons follow the levels the server offers",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.button("停止全部修改操作").props.disabled,true,"nothing to stop");
  f.button("允许全部修改操作").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/一次允许以下 2 项/);assert.equal(f.prompts.at(-1).includes("回收站"),false);
});
// One everyday control, with range and concrete actions stated in distinct groups.
// After P7 the levels also cover adopted items; bodies of every in-root file only under normal use.
test("file scope is shown once while unknown read scope remains unconfirmed until both current reads agree",async()=>{
  const f=fixture(null,readStatus(["read","read_content"],2),{...writeStatus(["modify","modify_subtree"]),subtree_disclosure_version:"clued.storage-subtree-disclosure/1"});await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/Agent 读正文：已配置允许；文件范围未确认/);
  assert.match(f.text(),/Agent 改名和移动文件：已配置允许/);
  assert.match(f.text(),/Agent 移动整个文件夹：已配置允许/);
  assert.equal(f.text().split("修改对象：仅 BeamingFace 创建或已纳管的文件和文件夹").length-1,1);
  assert.doesNotMatch(f.text(),/已允许（仅 BeamingFace 创建的文件）/);
  f.button("重新读取读取与搜索状态").props.onClick();await f.settle();
  await replyReading(f,readStatus(["read","read_content"],3),normalStatus("normal",true));
  assert.match(f.text(),/Agent 读正文：已配置允许（目录内全部文件）/);
});
const normalStatus=(profile,on,extra={})=>({connection_id:active.id,read_generation:on?3:1,disclosure_version:"clued.storage-normal-use-disclosure/1",
  provider_scope_profile:profile,normal_use:on,reconsent_required:profile!=="normal",refresh_token_count:2,refresh_token_warning:false,
  refresh_token_blocked:false,...extra});
test("normal use with a normal credential is one native CAS mutation under the versioned disclosure",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.featureCalls().length,4,"effective settings are read automatically with the lifecycle list");assert.match(f.text(),/目录结构和正文读取均已停止/);assert.match(f.text(),/细分读取权限/);
  assert.equal(f.request("/v1/storage/normal-use","status").url,"/v1/storage/normal-use");assert.deepEqual(JSON.parse(f.request("/v1/storage/normal-use","status").init.body),{action:"status",connection_id:active.id});
  assert.match(f.text(),/目录结构和正文读取均已停止/);
  const on=f.button("开启读取与搜索");on.props.onClick();on.props.onClick();await f.settle();
  assert.equal(f.featureCalls().length,5);
  assert.match(f.prompts.at(-1),/读取「Clued_资料中心」内的全部文件，包括你手动上传的文件/);
  assert.match(f.prompts.at(-1),/查看你 Google 云端硬盘中的所有文件/);assert.match(f.prompts.at(-1),/这个限制由 Clued 保证，不由 Google 保证/);
  assert.equal(f.prompts.at(-1).includes("前往 Google 授权页面"),false);
  assert.deepEqual(JSON.parse(f.request("/v1/storage/normal-use","enable").init.body),{action:"enable",connection_id:active.id,base_generation:1,
    disclosure_version:"clued.storage-normal-use-disclosure/1",idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/normal-use","enable"),{status:"committed",receipt_id:"fixture-normal-receipt"});await f.settle();
  await replyReading(f,readStatus(["read","read_content"],3),normalStatus("normal",true));
  assert.match(f.text(),/已开启读取与搜索。回执：fixture-normal-receipt/);assert.match(f.text(),/已允许读取目录内全部文件并按内容搜索/);
  f.button("关闭读取与搜索").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/不会收回 Google 授权/);
  assert.equal(JSON.parse(f.request("/v1/storage/normal-use","disable").init.body).action,"disable");assert.equal(JSON.parse(f.request("/v1/storage/normal-use","disable").init.body).base_generation,3);
  f.respond(f.pending("/v1/storage/normal-use","disable"),{error:"private"},403);await f.settle();
  assert.match(f.text(),/正常使用设置结果未确认/);assert.match(f.text(),/状态未确认/);assert.equal(f.featureCalls().length,8,"never resent");
});
test("normal-use mutation cannot claim full reading when its actual class readback is unavailable",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("开启读取与搜索").props.onClick();await f.settle();
  f.respond(f.pending("/v1/storage/normal-use","enable"),{status:"committed",receipt_id:"fixture-normal-receipt"});await f.settle();
  assert.deepEqual(f.featureCalls().slice(5).map(c=>c.url),["/v1/storage/normal-use","/v1/storage/read-access"]);
  f.respond(f.pending("/v1/storage/normal-use","status"),normalStatus("normal",true));f.respond(f.pending("/v1/storage/read-access","status"),{error:"private readback"},403);await f.settle();
  assert.match(f.text(),/实际读取权限未确认/);assert.ok(!f.text().includes("已允许读取目录内全部文件并按内容搜索"));
  assert.ok(!f.text().includes("已允许（目录内全部文件）"));assert.ok(!f.text().includes("private readback"));
  assert.equal(f.featureCalls().length,7);assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="enable").length,1);
});
test("read-class mutation cannot revive the old file range when its normal-use readback fails",async()=>{
  const f=fixture(normalStatus("normal",true),readStatus(["read"],3));await f.settle();
  f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  f.button("允许 Agent 读正文").props.onClick();await f.settle();
  f.respond(f.pending("/v1/storage/read-access","set_classes"),{status:"committed",receipt_id:"fixture-content-receipt"});await f.settle();
  assert.deepEqual(f.featureCalls().slice(5).map(c=>c.url),["/v1/storage/read-access","/v1/storage/normal-use"]);
  f.respond(f.pending("/v1/storage/read-access","status"),readStatus(["read","read_content"],4));f.respond(f.pending("/v1/storage/normal-use","status"),{error:"private range readback"},403);await f.settle();
  assert.match(f.text(),/已配置允许；文件范围未确认/);assert.ok(!f.text().includes("已允许读取目录内全部文件并按内容搜索"));
  assert.ok(!f.text().includes("已允许（目录内全部文件）"));assert.ok(!f.text().includes("private range readback"));
  assert.equal(f.featureCalls().length,7);assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="set_classes").length,1);
});
test("normal use on a legacy connection starts Google re-consent with the normal set; busy and token limits are explained",async()=>{
  const f=fixture(normalStatus("legacy",false));await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/开启需要重新授权 Google/);
  f.button("开启读取与搜索").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/前往 Google 授权页面/);
  assert.equal(f.request("/v1/storage/google/start",null).url,"/v1/storage/google/start");
  assert.deepEqual(JSON.parse(f.request("/v1/storage/google/start",null).init.body),{connection_id:active.id,normal_use:{disclosure_version:"clued.storage-normal-use-disclosure/1"}});
  f.respond(f.pending("/v1/storage/google/start",null),{error:"Storage Google connection unavailable.",reason:"storage_root_busy"},403);await f.settle();
  assert.match(f.text(),/该目录还有尚未完成的文件操作，稍后再试/);
  f.button("重新读取读取与搜索状态").props.onClick();await f.settle();
  await replyReading(f,readStatus([],1),normalStatus("legacy",false,{refresh_token_count:90,refresh_token_warning:true,refresh_token_blocked:true}));
  assert.match(f.text(),/授权次数已达上限/);
  const before=f.featureCalls().length;f.button("开启读取与搜索").props.onClick();await f.settle();
  assert.equal(f.featureCalls().length,before,"a blocked account starts no consent");assert.match(f.text(),/暂时不能通过重新授权开启正常使用/);
  assert.equal(f.text().includes("请先撤回全部文件读取授权"),false,"never points to a control that does not exist");
});
// StorageFullCapability P7 (Decision 6dc1cf20 item 3): one button upgrades the Google grant to the full set.
const FULL_DISCLOSURE="clued.storage-full-scope-disclosure/1";
const fullStatus=(profile,extra={})=>normalStatus(profile,profile!=="legacy",{reconsent_required:profile==="legacy",
  full_scope:profile==="full",full_scope_disclosure_version:FULL_DISCLOSURE,...extra});
test("managing existing files: one button starts Google re-consent with the full set under its own disclosure, nothing else",async()=>{
  const f=fixture(fullStatus("normal"));await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/修改对象：仅 BeamingFace 创建或已纳管的文件和文件夹/);assert.match(f.text(),/只扩展可纳管范围，不开启任何写入操作/);
  f.button("允许纳管已有文件").props.onClick();await f.settle();
  const prompt=f.prompts.at(-1);
  assert.match(prompt,/“纳管”「Clued_资料中心」里你自己拥有的已有文件和文件夹：一次一个，只登记、不改动/);
  assert.match(prompt,/查看、修改、创建和删除你 Google 云端硬盘中的所有文件/);assert.match(prompt,/这个限制由 Clued 保证，不由 Google 保证/);
  assert.match(prompt,/整个云端硬盘都可能被读取或改写/);assert.match(prompt,/第三方应用和服务/);assert.match(prompt,/前往 Google 授权页面/);
  assert.equal(prompt.includes("撤回全部文件读取授权"),false,"never points to a control that does not exist");
  assert.equal(f.request("/v1/storage/google/start",null).url,"/v1/storage/google/start");
  assert.deepEqual(JSON.parse(f.request("/v1/storage/google/start",null).init.body),{connection_id:active.id,full_scope:{disclosure_version:FULL_DISCLOSURE}});
  f.respond(f.pending("/v1/storage/google/start",null),{error:"Storage Google connection unavailable.",reason:"storage_root_busy"},403);await f.settle();
  assert.match(f.text(),/该目录还有尚未完成的文件操作，稍后再试/);
  // A full credential: allowed, no button.
  f.button("重新读取读取与搜索状态").props.onClick();await f.settle();await replyReading(f,readStatus(["read","read_content"],3),fullStatus("full"));
  assert.match(f.text(),/可纳管你拥有的已有文件和文件夹/);assert.match(f.text(),/已允许读取目录内全部文件并按内容搜索/);
  assert.match(f.text(),/已有文件修改已全部停止/);assert.equal(f.calls.filter(c=>JSON.parse(c.init.body).action==="set_classes").length,0);
  assert.throws(()=>f.button("允许纳管已有文件"));
  // The refresh-token limit refuses before any request.
  const g=fixture(fullStatus("normal",{refresh_token_count:90,refresh_token_warning:true,refresh_token_blocked:true}));await g.settle();g.respond(g.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await g.settle();
  const before=g.featureCalls().length;g.button("允许纳管已有文件").props.onClick();await g.settle();
  assert.equal(g.featureCalls().length,before);assert.match(g.text(),/暂时不能通过重新授权允许管理已有文件/);
  // An older server names neither field: no button.
  const h=fixture(normalStatus("normal",true),readStatus([],1),writeStatus([]),null);await h.settle();h.respond(h.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await h.settle();
  assert.match(h.text(),/已有文件的纳管授权状态未确认/);assert.throws(()=>h.button("允许纳管已有文件"));
});
// StorageNormalUse.v0.1 §7.3 / §8.2 item 4 (N4): hourly budgets with presets and a bounded custom value.
const MiB=1048576,GiB=1024*MiB;
const budgetStatus=(connection={},account={})=>({contract:"clued.storage-budget/1",connection_id:active.id,
  connection:{budget_generation:0,configured:false,read_bytes_per_hour:256*MiB,upload_bytes_per_hour:256*MiB,...connection},
  account:{budget_generation:0,configured:false,read_bytes_per_hour:GiB,upload_bytes_per_hour:GiB,...account},
  defaults:{connection:{read_bytes_per_hour:256*MiB,upload_bytes_per_hour:256*MiB},account:{read_bytes_per_hour:GiB,upload_bytes_per_hour:GiB}},
  bounds:{step_bytes:MiB,connection:{min_bytes:32*MiB,max_bytes:2*GiB},account:{min_bytes:32*MiB,max_bytes:8*GiB}}});
test("hourly budgets: presets and custom within bounds, one native CAS mutation, readback confirms immediate effect",async()=>{
  const f=fixture();await f.settle();f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[active],worker_execution_enabled:false});await f.settle();
  assert.equal(f.featureCalls().length,4,"budgets are loaded on demand");assert.match(f.text(),/每小时额度：未读取/);
  f.button("读取额度设置").props.onClick();await f.settle();
  assert.equal(f.request("/v1/storage/budget","status").url,"/v1/storage/budget");assert.deepEqual(JSON.parse(f.request("/v1/storage/budget","status").init.body),{action:"status",connection_id:active.id});
  f.respond(f.pending("/v1/storage/budget","status"),budgetStatus());await f.settle();
  assert.match(f.text(),/每个已授权 Agent 读取 256 MiB、上传 256 MiB；账号合计读取 1 GiB、上传 1 GiB/);
  assert.match(f.text(),/可设 32 MiB–2 GiB/);assert.match(f.text(),/可设 32 MiB–8 GiB/);assert.match(f.text(),/256 MiB（默认）/);
  const read=f.labelled("每个已授权 Agent（此连接）读取额度"),upload=f.labelled("每个已授权 Agent（此连接）上传额度");
  assert.equal(read.props.value,"256");assert.deepEqual([...read.props.children[0].map(o=>o.props.value)],["64","256","1024"]);
  assert.equal(f.labelled("每个已授权 Agent（此连接）上传自定义额度（MiB）"),undefined,"custom input only when chosen");
  read.props.onChange({target:{value:"64"}});upload.props.onChange({target:{value:"custom"}});f.render();
  const custom=f.labelled("每个已授权 Agent（此连接）上传自定义额度（MiB）");
  assert.equal(custom.props.min,32);assert.equal(custom.props.max,2048);
  custom.props.onChange({target:{value:"4096"}});f.render();
  f.button("保存此连接的额度").props.onClick();await f.settle();
  assert.equal(f.featureCalls().length,5,"an out-of-bounds custom value sends nothing");assert.match(f.text(),/自定义额度须为 32 MiB 到 2 GiB 之间的整数 MiB/);
  f.labelled("每个已授权 Agent（此连接）上传自定义额度（MiB）").props.onChange({target:{value:"100"}});f.render();
  const save=f.button("保存此连接的额度");save.props.onClick();save.props.onClick();await f.settle();
  assert.equal(f.featureCalls().length,6);
  assert.match(f.prompts.at(-1),/读取 64 MiB、上传 100 MiB/);assert.match(f.prompts.at(-1),/立即生效/);
  assert.match(f.prompts.at(-1),/不改变任何授权、正常使用、写入设置或排队任务/);
  assert.deepEqual(JSON.parse(f.request("/v1/storage/budget","set").init.body),{action:"set",scope:"connection",connection_id:active.id,base_generation:0,
    read_bytes_per_hour:64*MiB,upload_bytes_per_hour:100*MiB,idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/budget","set"),{status:"committed",receipt_id:"fixture-budget-receipt"});await f.settle();
  assert.deepEqual(JSON.parse(f.request("/v1/storage/budget","status").init.body),{action:"status",connection_id:active.id});
  f.respond(f.pending("/v1/storage/budget","status"),budgetStatus({budget_generation:1,configured:true,read_bytes_per_hour:64*MiB,upload_bytes_per_hour:100*MiB}));await f.settle();
  assert.match(f.text(),/已更新每个已授权 Agent（此连接）的每小时额度，立即生效。回执：fixture-budget-receipt/);
  assert.match(f.text(),/每个已授权 Agent 读取 64 MiB、上传 100 MiB/);
  // Account totals: their own CAS generation and no connection_id; an unknown result is never resent.
  f.labelled("账号合计（全部 Agent 与连接）读取额度").props.onChange({target:{value:"custom"}});f.render();
  f.labelled("账号合计（全部 Agent 与连接）读取自定义额度（MiB）").props.onChange({target:{value:"8192"}});f.render();
  f.button("保存账号合计额度").props.onClick();await f.settle();
  assert.match(f.prompts.at(-1),/账号合计（全部 Agent 与连接）的每小时额度改为：读取 8 GiB、上传 1 GiB/);
  assert.deepEqual(JSON.parse(f.request("/v1/storage/budget","set").init.body),{action:"set",scope:"account",base_generation:0,
    read_bytes_per_hour:8*GiB,upload_bytes_per_hour:GiB,idempotency_key:"fixture-id"});
  f.respond(f.pending("/v1/storage/budget","set"),{error:"private"},403);await f.settle();
  assert.match(f.text(),/额度设置结果未确认/);assert.match(f.text(),/每小时额度：未读取/);assert.equal(f.featureCalls().length,8,"never resent");
});
// Bug 38bb5ddf (Decision 24422a98): the page never asks the Owner to run a
// directory check. Directories still being recovered are a one-line status;
// only a real sharing difference or a folder Drive no longer shows is listed,
// in business terms.
test("storage step 3: directories without an access digest are recovered in the background, never sent to a directory check",async()=>{
  const f=fixture();await f.settle();
  f.respond(f.pending("/v1/storage/lifecycle","list"),{connections:[{...active,access_digest_missing:{count:21,directories:[{path:"",since:"2026-10-08T00:00:00Z"},
    {path:"资料/旧目录",since:"2026-10-08T00:00:00Z"}]}}],worker_execution_enabled:false});await f.settle();
  assert.match(f.text(),/后台正在自动核对 21 个目录的共享设置。/);assert.equal(f.text().includes("无需操作"),false,"unknown until the separate read answers");
  f.respond(f.pending("/v1/storage/owner","digest_attention"),{contract:"clued.storage-access-digest-attention/1",connections:[]});await f.settle();
  assert.match(f.text(),/后台正在自动核对 21 个目录的共享设置，无需操作/);
  assert.equal(/运行目录检查|目录需检查|访问权限摘要/.test(f.text()),false);
  assert.equal(f.text().includes("暂不写入"),false);
  const a=fixture();await a.settle();
  a.respond(a.pending("/v1/storage/lifecycle","list"),{connections:[{...active,
    access_digest_missing:{count:23,directories:[{path:"资料/旧目录",since:"2026-10-08T00:00:00Z"}]}}],
    worker_execution_enabled:false});await a.settle();
  assert.equal(a.text().includes("暂不写入"),false,"shown only once the separate read answers");
  a.respond(a.pending("/v1/storage/owner","digest_attention"),{contract:"clued.storage-access-digest-attention/1",connections:[{connection_id:active.id,
    count:22,directories:[{artifact_id:"20000000-0000-4000-8000-000000000001",path:"资料/对外分享",reason:"access_differs",observed_access:"a".repeat(64)},
      {artifact_id:"20000000-0000-4000-8000-000000000002",path:"资料/已删除",reason:"not_found",observed_access:null}]}]});await a.settle();
  assert.match(a.text(),/有 22 个目录暂不写入/);assert.match(a.text(),/为防止资料被意外共享/);
  assert.match(a.text(),/资料\/对外分享：共享设置与上级目录不同/);assert.match(a.text(),/资料\/已删除：在 Google Drive 中找不到/);
  assert.match(a.text(),/另有 20 个未列出/);assert.match(a.text(),/后台正在自动核对 1 个目录/);
  assert.equal(/运行目录检查|访问权限摘要/.test(a.text()),false);
  // Where the program cannot decide, the Owner confirms in one step, bound to the observation shown.
  const confirm=a.button("确认当前共享设置");confirm.props.onClick();await a.settle();
  assert.deepEqual(JSON.parse(a.request("/v1/storage/owner","digest_accept").init.body),
    {action:"digest_accept",artifact_id:"20000000-0000-4000-8000-000000000001",observed_access:"a".repeat(64)});
  a.respond(a.pending("/v1/storage/owner","digest_accept"),{status:"committed"});await a.settle();
  a.respond(a.pending("/v1/storage/lifecycle","list"),{connections:[{...active}],worker_execution_enabled:false});await a.settle();
  assert.match(a.text(),/已确认“资料\/对外分享”的当前共享设置/);
  for(const missing of [{count:0,directories:[]},undefined]){
    const g=fixture();await g.settle();g.respond(g.pending("/v1/storage/lifecycle","list"),{connections:[{...active,access_digest_missing:missing}],worker_execution_enabled:false});await g.settle();
    assert.equal(/自动核对|暂不写入/.test(g.text()),false);assert.match(g.text(),/Clued_资料中心/);
  }
  // A malformed or refused attention read only leaves the notice out.
  for(const [answer,status] of [[{contract:"clued.storage-access-digest-attention/1",connections:[{connection_id:active.id,count:1,
    directories:[{artifact_id:"20000000-0000-4000-8000-000000000001",path:"x",reason:"other",observed_access:null}]}]},200],[{error:"private"},403]]){
    const bad=fixture();await bad.settle();bad.respond(bad.pending("/v1/storage/lifecycle","list"),{connections:[{...active,
      access_digest_missing:{count:1,directories:[{path:"x",since:"2026-10-08T00:00:00Z"}]}}],worker_execution_enabled:false});
    await bad.settle();bad.respond(bad.pending("/v1/storage/owner","digest_attention"),answer,status);await bad.settle();
    assert.match(bad.text(),/Clued_资料中心/);assert.equal(/暂不写入|private|无需操作/.test(bad.text()),false);
  }
  // A malformed field is not a connection.
  const h=fixture();await h.settle();h.respond(h.pending("/v1/storage/lifecycle","list"),{connections:[{...active,access_digest_missing:{count:"x",directories:[]}}],worker_execution_enabled:false});await h.settle();
  assert.equal(h.text().includes("Clued_资料中心"),false);
});
