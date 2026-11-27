// Deterministic real-component logic coverage, not a live browser qualification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(readFileSync(new URL("../app/storage/admin/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
function fixture(confirm = true, automaticJobs = [], options = {}) {
  const hooks = [], effects = [], requests = [], navigations = [], confirmations = [], recoveryLists = [];
  const timers = new Map(); let timerId=0;
  let owner = "a", authCallback, cursor = 0, tree;
  const equal = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const React = {
    useState(initial) { const i=cursor++; hooks[i] ??= { value: initial }; return [hooks[i].value, v => { hooks[i].value = typeof v === "function" ? v(hooks[i].value) : v; }]; },
    useRef(initial) { const i=cursor++; hooks[i] ??= { current: initial }; return hooks[i]; },
    useCallback(fn,deps) { const i=cursor++; if (!hooks[i] || !equal(hooks[i].deps,deps)) hooks[i] = { fn,deps }; return hooks[i].fn; },
    useEffect(fn,deps) { const i=cursor++; if (!hooks[i] || !equal(hooks[i].deps,deps)) { hooks[i]={deps}; effects.push(fn); } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, Error, queueMicrotask, AbortSignal, crypto: { randomUUID: () => "fixture-request" },
    setTimeout(fn) { const id=++timerId;timers.set(id,fn);return id; },clearTimeout(id) { timers.delete(id); },
    window: { confirm: message => { confirmations.push(message); return confirm; }, location: { assign: url => navigations.push(url) } },
    require(name) {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return { jsx: (type,props) => ({type,props}), jsxs: (type,props) => ({type,props}) };
      if (name === "next/link") return { __esModule: true, default: "a" };
      if (name.endsWith("/supabase-browser")) return { supabase: { auth: {
        getSession: async () => ({ data: { session: owner ? { user: { id: owner }, access_token: "fixture-"+owner } : null }, error: null }),
        onAuthStateChange(cb) { authCallback=cb; return { data: { subscription: { unsubscribe() {} } } }; },
      } } };
      throw Error(name);
    },
    fetch(url,init) {
      const body = init.body && JSON.parse(init.body);
      if (url === '/v1/storage/recovery' && body?.action === 'list') {
        if(options.deferRecoveryLists) return new Promise(resolve=>recoveryLists.push({url,init,resolve}));
        recoveryLists.push({url,init});
        return Promise.resolve({ok:true,status:200,json:async()=>({status:'ok',connection_id:body.connection_id,
          jobs:automaticJobs,execution_permitted:false})});
      }
      return new Promise(resolve => { requests.push({ url,init,resolve }); });
    },
  });
  const render = () => { cursor=0; tree=exports.default(); while(effects.length) effects.shift()(); };
  const settle = async () => { for(let i=0;i<100;i++) await Promise.resolve(); render(); };
  const text = n => Array.isArray(n) ? n.map(text).join("") : n == null || typeof n === "boolean" ? "" : typeof n === "object" ? text(n.props?.children) : String(n);
  function button(label) { let found; const visit = n => { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== "object") return; if(n.type === "button" && text(n) === label) found=n; visit(n.props?.children); }; visit(tree); assert.ok(found,label); return found; }
  function input(label) { let found; const visit = n => { if(Array.isArray(n)) return n.forEach(visit); if(!n || typeof n !== "object") return;
    if(n.type === "label" && text(n).startsWith(label)) { const children = Array.isArray(n.props.children) ? n.props.children : [n.props.children]; found=children.find(c=>c?.type === "input" || c?.type === "select"); }
    visit(n.props?.children); }; visit(tree); assert.ok(found,label); return found; }
  render();
  return { requests, recoveryLists, navigations, confirmations, settle, text: () => text(tree), button, input,
    statusBlocks() { const result=[];const visit=n=>{if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=="object")return;
      if(n.props.role==="status")result.push({text:text(n),className:n.props.className});visit(n.props.children);};visit(tree);return result;},
    poll() { const pending=[...timers.values()];timers.clear();for(const fn of pending)fn(); },
    change(id) { owner=id; authCallback("SIGNED_IN", id ? { user:{id} } : null); render(); },
    respond(i,value,status=200) { requests[i].resolve({ ok:status<400, status, json:async()=>value }); },
    respondList(i,jobs,status=200) { recoveryLists[i].resolve({ok:status<400,status,json:async()=>({status:"ok",connection_id:JSON.parse(recoveryLists[i].init.body).connection_id,jobs,execution_permitted:false})}); },
    probeFeedback() { let found=""; const visit=n=>{if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=="object")return;
      if(n.type==="div" && Array.isArray(n.props.children) && n.props.children.some(c=>c?.type==="button" && text(c)==="检查全部登记目录的信息和新建能力"))
        found=n.props.children.filter(c=>c?.props?.role==="status").map(text).join("");visit(n.props.children);};visit(tree);return found;},
  };
}
const connection = { id: "10000000-0000-4000-8000-000000000001", provider: "google-drive", state: "awaiting_provider", version:1, profile_id:"fixture-profile", root_name:"Clued_资料中心" };
const fixtureReceipt = "10000000-0000-4000-8000-000000000083", lateReceipt = "10000000-0000-4000-8000-000000000084";

test("directory probe shows progress and safe failure beside its button without a second dispatch",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
  const b=f.button("检查全部登记目录的信息和新建能力");b.props.onClick();b.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.match(f.probeFeedback(),/正在只读检查/);
  f.respond(1,{execution_permitted:false,diagnostic:{stage:"directories",reason:"DIRECTORY_NOT_APP_AUTHORIZED"}},403);await f.settle();
  assert.match(f.probeFeedback(),/尚未通过当前应用的目录管理检查/);assert.match(f.probeFeedback(),/不会自动重试或更改授权/);
  assert.equal(f.requests.length,2);assert.equal(f.button("检查全部登记目录的信息和新建能力").props.disabled,false);
});
test("provider diagnostic categories render beside the button without raw errors or retries",async()=>{
  for(const [reason,label] of [["PROVIDER_AUTHENTICATION_REJECTED","未接受当前访问凭据"],
    ["PROVIDER_ACCESS_REJECTED","拒绝了这次元数据访问"],["PROVIDER_OBJECT_UNAVAILABLE","未返回所查询的登记对象"],
    ["PROVIDER_RATE_LIMITED","限制了请求频率"],["PROVIDER_SERVER_UNAVAILABLE","服务暂时不可用"],
    ["PROVIDER_RESPONSE_REJECTED","未接受这次请求"],["PROVIDER_TIMEOUT","单次元数据请求超时"],
    ["RUNTIME_SUBREQUEST_LIMIT","单次外部请求上限"],["PROVIDER_REDIRECT_REJECTED","不允许的跳转"],
    ["PROVIDER_RESPONSE_INVALID","响应格式无效"],["METADATA_ID_MISMATCH","对象 ID 与查询不一致"],
    ["PAGINATION_INVALID","分页标记无效"],["PAGINATION_LIMIT","分页超过"],
    ["NAMESPACE_VISIBILITY_UNPROVEN","只读元数据权限未确认"],
    ["UNAUTHORIZED_WORKSPACE_MUTATION","UNAUTHORIZED_WORKSPACE_MUTATION"],
    ["BOUNDARY_CHANGED","扫描期间边界发生变化"]]) {
    const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
    f.button("检查全部登记目录的信息和新建能力").props.onClick();await f.settle();
    f.respond(1,{execution_permitted:false,diagnostic:{stage:"directories",reason},error:"private-provider-text"},403);await f.settle();
    assert.ok(f.probeFeedback().includes(label));assert.equal(f.text().includes("private-provider-text"),false);
    assert.equal(f.probeFeedback().includes("其他已获授权的目录仍可正常使用"),false);
    assert.match(f.probeFeedback(),/不会自动重试或更改授权/);assert.equal(f.requests.length,2);
  }
});

test("directory issues name each affected object, distinguish unknown fields and leave ordinary operations available",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
  f.button("检查全部登记目录的信息和新建能力").props.onClick();await f.settle();
  f.respond(1,{execution_permitted:false,diagnostic:{stage:"directories",reason:"DIRECTORY_NOT_APP_AUTHORIZED",directories:{
    contract:"clued.storage-directory-diagnostic/1",total_directories:66,checked_directories:66,failed_directories:2,truncated:false,
    failures:[{path:"/root/track/topic-a",provider_file_id:"private-drive-id-a",reasons:["DIRECTORY_NOT_APP_AUTHORIZED"]},
      {path:"/root/track/topic-b",provider_file_id:"private-drive-id-b",reasons:["DIRECTORY_APP_AUTHORIZATION_UNCONFIRMED","DIRECTORY_NOT_WRITABLE"]}]
  }}},403);await f.settle();
  const text=f.probeFeedback();assert.match(text,/已核对 66 个登记目录，2 个目录/);
  assert.match(text,/topic-a/);assert.match(text,/topic-b/);assert.match(text,/Google 未返回完整的目录资格信息/);
  assert.match(text,/当前不允许新建内容/);assert.match(text,/其他已获授权的目录仍可正常使用/);
  assert.equal(f.text().includes("private-drive-id"),false);assert.equal(f.text().includes("根目录锁"),false);
  assert.equal(f.text().includes("撤回已有普通操作"),false);assert.equal(text.includes("拒绝读取"),false);
  assert.match(text,/\n\/root\/track\/topic-a/);assert.match(text,/\n\/root\/track\/topic-b/);
  const top=f.statusBlocks().find(x=>x.className==="my-4");
  assert.equal(top.text,"检查已完成，有待确认目录，请查看下方结果。");
  assert.equal(f.text().split("/root/track/topic-a").length-1,1);
  assert.match(f.statusBlocks().find(x=>x.text===text).className,/whitespace-pre-line/);
  assert.equal(f.button("检查全部登记目录的信息和新建能力").props.disabled,false);
  assert.equal(f.requests.length,2);assert.equal(f.confirmations.length,0);
});

test("truncated directory details stay multiline and the top message does not duplicate them",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
  f.button("检查全部登记目录的信息和新建能力").props.onClick();await f.settle();
  f.respond(1,{execution_permitted:false,diagnostic:{stage:"directories",reason:"DIRECTORY_NOT_WRITABLE",directories:{
    contract:"clued.storage-directory-diagnostic/1",total_directories:66,checked_directories:66,failed_directories:20,truncated:true,
    failures:Array.from({length:16},(_,i)=>({path:"/root/folder-"+i,provider_file_id:"private-drive-id-"+i,reasons:["DIRECTORY_NOT_WRITABLE"]}))
  }}},403);await f.settle();
  assert.match(f.probeFeedback(),/仅显示前 16 个，另有 4 个目录未列出/);
  assert.equal(f.probeFeedback().split("\n").filter(line=>line.startsWith("/root/folder-")).length,16);
  assert.equal(f.text().includes("private-drive-id"),false);
  assert.equal(f.statusBlocks().find(x=>x.className==="my-4").text,"检查已完成，有待确认目录，请查看下方结果。");
  assert.equal(f.requests.length,2);assert.equal(f.confirmations.length,0);
});

test("directory summary rejects malformed counters, unknown reasons and unbounded detail",async()=>{
  for(const changes of [{failed_directories:1025},{truncated:true},{failures:Array(17).fill({})},
    {failures:[{path:"/private-provider-text",provider_file_id:"bad/id",reasons:["PRIVATE_REASON"]}]}]){
    const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
    f.button("检查全部登记目录的信息和新建能力").props.onClick();await f.settle();
    f.respond(1,{execution_permitted:false,diagnostic:{stage:"directories",reason:"DIRECTORY_NOT_APP_AUTHORIZED",directories:{
      contract:"clued.storage-directory-diagnostic/1",total_directories:1,checked_directories:1,failed_directories:1,truncated:false,
      failures:[{path:"/root/topic",provider_file_id:"topic",reasons:["DIRECTORY_NOT_APP_AUTHORIZED"]}],...changes
    }}},403);await f.settle();
    assert.equal(f.probeFeedback().includes("private-provider-text"),false);assert.equal(f.probeFeedback().includes("PRIVATE_REASON"),false);
    assert.equal(f.probeFeedback().includes("已核对"),false);assert.equal(f.requests.length,2);
  }
});

test("directory probe error text cannot inject upstream content or cross an account switch",async()=>{
  for(const changed of [false,true]) {
    const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
    f.button("检查全部登记目录的信息和新建能力").props.onClick();await f.settle();
    if(changed){f.change("b");await f.settle();f.respond(2,{connections:[]});await f.settle();}
    f.respond(1,{execution_permitted:false,diagnostic:{stage:"credential",reason:"private-token"},error:"private-token"},403);await f.settle();
    assert.equal(f.text().includes("private-token"),false);
    if(changed)assert.equal(f.probeFeedback(),"");else assert.match(f.probeFeedback(),/目录检查暂未完成/);
  }
});


const recoveryJob='10000000-0000-4000-8000-000000000081',recoveryReceipt='10000000-0000-4000-8000-000000000082';
const inspection=(status='started')=>({connection_id:connection.id,job_id:recoveryJob,status,receipt_id:recoveryReceipt,execution_permitted:false});
async function recoveryReady(state='reauthorization_required') {
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state}]});await f.settle();
  f.input('原存储任务 ID').props.onChange({target:{value:recoveryJob}});await f.settle();
  f.button('查询原任务回执').props.onClick();await f.settle();f.respond(1,inspection());await f.settle();
  return f;
}
test('technical diagnostics inspect one exact original job without exposing manual settlement',async()=>{
  const f=await recoveryReady();assert.equal(f.requests.length,2);assert.equal(f.confirmations.length,0);
  assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:'inspect',connection_id:connection.id,job_id:recoveryJob});
  assert.match(f.text(),/后台程序自动核验与恢复/);
  assert.equal(f.text().includes('核验并登记原结果（不重写）'),false);assert.equal(f.text().includes('确认核验原作业'),false);
  assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action==='settle'),false);
});
test('changed job, page refresh and account switch clear original diagnostic observations',async()=>{
  for(const change of ['job','refresh','account']) {
    const f=await recoveryReady();
    if(change==='job')f.input('原存储任务 ID').props.onChange({target:{value:recoveryReceipt}});
    if(change==='refresh')f.button('刷新状态').props.onClick();
    if(change==='account')f.change('b');await f.settle();
    assert.equal(f.text().includes('；回执：'+recoveryReceipt),false,change);
    assert.equal(f.text().includes('确认核验原作业'),false);
    assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action==='settle'),false,change);
  }
});
test('a lost diagnostic reply reads no provider effects and never dispatches settlement',async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.input('原存储任务 ID').props.onChange({target:{value:recoveryJob}});await f.settle();f.button('查询原任务回执').props.onClick();await f.settle();
  f.respond(1,{status:'unknown'},503);await f.settle();assert.equal(f.requests.length,2);
  assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action==='settle'),false);assert.equal(f.text().includes('已完成并登记'),false);
});
test('revoked and active healthy connections expose inspection without unnecessary Google reauthorization',async()=>{
  for(const state of ['revoked','active']) {
    const f=await recoveryReady(state);assert.ok(f.text().includes(recoveryReceipt));
    assert.equal(f.text().includes('核验并登记原结果（不重写）'),false);
    assert.equal(f.text().includes('重新授权并自动核对原任务（凭据失效时）'),false);
  }
});
test('reauthorization uses an exact-job page confirmation and never adds renewal authority',async()=>{
  const f=await recoveryReady();f.button('重新授权并自动核对原任务（凭据失效时）').props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.match(f.text(),/Google 最终同意由你确认/);assert.equal(f.confirmations.length,0);
  const button=f.button('继续前往 Google 授权');button.props.onClick();button.props.onClick();await f.settle();
  assert.equal(f.requests.length,3);
  assert.deepEqual(JSON.parse(f.requests[2].init.body),{connection_id:connection.id,job_id:recoveryJob});
  f.respond(2,{authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'});await f.settle();
  assert.equal(f.navigations.length,1);
});
test('account change rejects stale confirmation and suppresses a late authorization redirect',async()=>{
  for(const when of ['before','after']) {
    const f=await recoveryReady();f.button('重新授权并自动核对原任务（凭据失效时）').props.onClick();await f.settle();
    const stale=f.button('继续前往 Google 授权');
    if(when==='before')f.change('b');stale.props.onClick();await f.settle();
    if(when==='after'){f.change('b');await f.settle();f.respond(2,{authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'});await f.settle();}
    else assert.equal(f.requests.some(r=>r.url==='/v1/storage/google/recovery/auto-start'),false);
    assert.equal(f.navigations.length,0);
  }
});
test('a late diagnostic result cannot display another accounts original job',async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.input('原存储任务 ID').props.onChange({target:{value:recoveryJob}});await f.settle();f.button('查询原任务回执').props.onClick();await f.settle();
  f.change('b');await f.settle();f.respond(2,{connections:[]});await f.settle();f.respond(1,inspection('committed'));await f.settle();
  assert.equal(f.text().includes(recoveryReceipt),false);assert.equal(f.text().includes('已完成并登记'),false);
});
test('opening storage reads progress only while the server completes the original job independently',async()=>{
  const jobs=[inspection()],f=fixture(true,jobs);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  assert.equal(f.recoveryLists.length,1);assert.equal(f.requests.length,1);assert.equal(f.confirmations.length,0);
  assert.deepEqual(JSON.parse(f.recoveryLists[0].init.body),{action:'list',connection_id:connection.id});
  jobs[0]=inspection('committed');f.poll();await f.settle();assert.match(f.text(),/已完成并登记/);
  assert.equal(f.requests.length,1);
});
const autoPending=()=>({...inspection('attention_required'),automatic_recovery:'pending',review_available:true,
  abandon_available:true,base_version:3,source_receipt_id:recoveryReceipt,diagnostic:{stage:'verification',reason:'REVISION_UNCHANGED',
    observed_at:'2026-10-16T03:27:00Z',automatic_next_action:'continue_object_recovery',secret:'not-for-display'}});
const autoResolved=()=>({...inspection('resolved'),automatic_recovery:'resolved',resolution:'automatically_reconciled_before',
  receipt_id:lateReceipt,base_version:3,source_receipt_id:recoveryReceipt});
test('unchanged original files progress to automatic recovery without a manual confirmation or page mutation',async()=>{
  const jobs=[autoPending()],f=fixture(true,jobs);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  assert.match(f.text(),/系统正在自动恢复/);assert.match(f.text(),/关闭页面后仍会继续/);
  assert.equal(f.text().includes('查看当前文件并处理冲突'),false);assert.equal(f.text().includes('停止管理旧登记并解除保护'),false);
  assert.equal(f.text().includes('保留当前文件并恢复使用'),false);assert.equal(f.text().includes('not-for-display'),false);
  assert.equal(f.requests.length,1);assert.equal(f.confirmations.length,0);
  jobs[0]=autoResolved();f.poll();await f.settle();
  assert.match(f.text(),/已自动恢复使用/);assert.match(f.text(),/原操作结果未确认的历史保留/);
  assert.equal(f.text().includes('已完成并登记'),false);assert.equal(f.text().includes('原任务结果已核验并登记'),false);
  assert.equal(f.requests.length,1);assert.equal(f.confirmations.length,0);
  const reads=f.recoveryLists.length;f.poll();await f.settle();assert.equal(f.recoveryLists.length,reads);
});
test('automatic resolution requires an independent receipt and exact validated server references',async()=>{
  for(const fields of [{receipt_id:recoveryReceipt},{source_receipt_id:undefined},{source_receipt_id:'bad'},
    {base_version:0},{automatic_recovery:'pending'},{automatic_recovery:'unknown'},{resolution:'pretend_success'}]) {
    const f=fixture(true,[{...autoResolved(),...fields}]);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    assert.equal(f.text().includes('已自动恢复使用'),false);assert.equal(f.text().includes('已完成并登记'),false);
    assert.equal(f.text().includes('保留当前文件并恢复使用'),false);assert.equal(f.requests.length,1);
  }
});
test('unknown status and lost progress reads only retry the scoped original list and never post settlement',async()=>{
  const f=fixture(true,[],{deferRecoveryLists:true});await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.respondList(0,[],503);await f.settle();assert.match(f.text(),/暂时未能读取恢复进度/);
  assert.equal(f.text().includes('已自动恢复使用'),false);f.poll();await f.settle();
  assert.equal(f.recoveryLists.length,2);assert.equal(f.requests.length,1);
  f.respondList(1,[{...inspection(),status:'unknown'}]);await f.settle();
  assert.equal(f.text().includes('已完成并登记'),false);assert.equal(f.text().includes('已自动恢复使用'),false);
  f.poll();await f.settle();f.respondList(2,[autoResolved()]);await f.settle();
  assert.match(f.text(),/已自动恢复使用/);assert.equal(f.requests.length,1);
  assert.ok(f.recoveryLists.every(r=>JSON.parse(r.init.body).action==='list'));
});
test('automatic list rejects cross-connection or malformed jobs without starting any recovery action',async()=>{
  for(const job of [{...inspection(),connection_id:'other'}, {...inspection(),job_id:'not-a-job'}, {...inspection(),execution_permitted:true}]) {
    const f=fixture(true,[job]);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    assert.equal(f.requests.length,1);assert.match(f.text(),/暂时未能读取恢复进度/);
  }
});

test('a current connection displays predecessor recovery with its original identities and only polls status',async()=>{
  const prior='20000000-0000-4000-8000-000000000001';
  const jobs=[{...autoPending(),connection_id:prior,read_connection_id:connection.id}],f=fixture(true,jobs);
  await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  assert.match(f.text(),/系统正在自动恢复/);assert.equal(f.requests.length,1);assert.equal(f.confirmations.length,0);
  jobs[0]={...autoResolved(),connection_id:prior,read_connection_id:connection.id};f.poll();await f.settle();
  assert.match(f.text(),/已自动恢复使用/);assert.equal(f.requests.length,1);assert.equal(f.confirmations.length,0);
  assert.ok(f.recoveryLists.every(r=>JSON.parse(r.init.body).connection_id===connection.id));
});

test('an optional predecessor conflict review uses original CAS identities and is invalidated by a changed current context',async()=>{
  const prior='20000000-0000-4000-8000-000000000002';
  const jobs=[{...reviewJob,connection_id:prior,read_connection_id:connection.id}],f=fixture(true,jobs);
  await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.button('查看当前文件并处理冲突').props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:'review_prepare',connection_id:prior,job_id:recoveryJob});
  f.respond(1,{...observation,connection_id:prior});await f.settle();
  const old=f.button('保留当前文件并恢复使用');
  jobs[0]={...jobs[0],read_connection_id:'20000000-0000-4000-8000-000000000003'};
  f.poll();await f.settle();old.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.equal(f.text().includes('保留当前文件并恢复使用'),false);
});

test('a predecessor optional withdrawal preserves the original connection and exact receipt',async()=>{
  const prior='20000000-0000-4000-8000-000000000004';
  const f=fixture(true,[{...withdrawalJob,connection_id:prior,read_connection_id:connection.id}]);
  await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.button('停止管理旧登记并解除保护').props.onClick();await f.settle();
  f.button('确认停止管理（不删除文件）').props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:'review_abandon',connection_id:prior,job_id:recoveryJob,
    base_version:3,source_receipt_id:recoveryReceipt,confirmed:true});
  assert.equal(f.confirmations.length,0);
});
test('a delayed automatic result cannot cross an account change or restart old polling',async()=>{
  const f=fixture(true,[],{deferRecoveryLists:true});await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.change('b');await f.settle();f.respond(1,{connections:[]});await f.settle();f.respondList(0,[autoResolved()]);await f.settle();
  assert.equal(f.text().includes(recoveryReceipt),false);assert.equal(f.text().includes(lateReceipt),false);
  assert.equal(f.text().includes('已自动恢复使用'),false);f.poll();await f.settle();assert.equal(f.recoveryLists.length,1);
});
test('recovery status polling stops after the server clears jobs or the account changes',async()=>{
  const jobs=[inspection()],f=fixture(true,jobs);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.poll();await f.settle();assert.equal(f.recoveryLists.length,2);assert.equal(f.requests.length,1);
  jobs.length=0;f.poll();await f.settle();assert.match(f.text(),/没有需要恢复的文件操作/);
  const reads=f.recoveryLists.length;f.change('b');f.poll();await f.settle();assert.equal(f.recoveryLists.length,reads);
});
test('a list of several recovering files never turns status polling into provider recovery or file mutations',async()=>{
  const jobs=Array.from({length:4},(_,i)=>({...autoPending(),job_id:'10000000-0000-4000-8000-00000000008'+i}));
  const f=fixture(true,jobs);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  assert.equal(f.requests.length,1);f.poll();await f.settle();assert.equal(f.requests.length,1);
  assert.ok(f.recoveryLists.every(r=>JSON.parse(r.init.body).action==='list'));
});
const reviewJob={...inspection('attention_required'),automatic_recovery:'current_state_conflict',review_available:true,base_version:3,source_receipt_id:recoveryReceipt};
const observation={status:'review_prepared',connection_id:connection.id,job_id:recoveryJob,
  observation_id:'10000000-0000-4000-8000-000000000091',base_version:3,source_receipt_id:recoveryReceipt,
  observed_at:'2026-10-16T03:27:00Z',observed_state:'changed',file_name:'原文件.zip',provider_file_id:'fixture-file-a',
  provider_file_version:'2',mime_type:'application/zip',size:'1046345',sha256:'a'.repeat(64),execution_permitted:false};
const withdrawalJob={...reviewJob,review_available:false,abandon_available:true,file_name:'原文件.zip'};
async function withdrawalReady() {
  const jobs=[{...withdrawalJob}],f=fixture(true,jobs);await f.settle();
  f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  assert.equal(f.requests.length,1,'a content conflict does not dispatch a page recovery');
  f.button('停止管理旧登记并解除保护').props.onClick();await f.settle();return {f,jobs};
}
test('a real content conflict permits an optional confirmed withdrawal without changing the Google file',async()=>{
  const {f,jobs}=await withdrawalReady();assert.match(f.text(),/原文件.zip/);assert.equal(f.text().includes('已直接读取 Google 当前文件'),false);
  const accept=f.button('确认停止管理（不删除文件）');accept.props.onClick();accept.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.deepEqual(JSON.parse(f.requests[1].init.body),{
    action:'review_abandon',connection_id:connection.id,job_id:recoveryJob,base_version:3,source_receipt_id:recoveryReceipt,confirmed:true});
  assert.equal(f.confirmations.length,0);jobs.length=0;
  f.respond(1,{status:'resolved',resolution:'abandoned_registration',connection_id:connection.id,job_id:recoveryJob,
    receipt_id:lateReceipt,execution_permitted:false});await f.settle();assert.match(f.text(),/已停止管理相关旧登记/);
  assert.equal(f.text().includes('原任务结果已核验并登记'),false);
});
test('withdrawal cancellation, refresh, account switch and a changed server version invalidate old confirmation',async()=>{
  for(const change of ['cancel','refresh','account','version']) {
    const {f,jobs}=await withdrawalReady(),old=f.button('确认停止管理（不删除文件）');
    if(change==='cancel')f.button('保留旧登记').props.onClick();
    if(change==='refresh')f.button('刷新状态').props.onClick();
    if(change==='account')f.change('b');
    if(change==='version'){jobs[0]={...withdrawalJob,base_version:4};f.poll();await f.settle();}
    old.props.onClick();await f.settle();
    assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action==='review_abandon'),false,change);
  }
});
test('unknown withdrawal is inspected through the original list and never submitted again',async()=>{
  const {f}=await withdrawalReady();f.button('确认停止管理（不删除文件）').props.onClick();await f.settle();
  f.respond(1,{status:'unknown'},503);await f.settle();
  assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==='review_abandon').length,1);
  assert.match(f.text(),/本次处理结果尚未确认/);assert.equal(f.text().includes('已停止管理相关旧登记'),false);
});
test('an optional conflict withdrawal requires valid exact receipt and version references',async()=>{
  for(const fields of [{base_version:0},{source_receipt_id:'invalid'},{source_receipt_id:undefined}]) {
    const f=fixture(true,[{...withdrawalJob,...fields}]);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    assert.equal(f.text().includes('停止管理旧登记并解除保护'),false);
  }
});
test('explicit pending recovery never shifts routine processing into manual adoption or withdrawal',async()=>{
  const f=fixture(true,[{...withdrawalJob,automatic_recovery:'pending',review_available:true}]);await f.settle();
  f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  assert.equal(f.text().includes('查看当前文件并处理冲突'),false);
  assert.equal(f.text().includes('停止管理旧登记并解除保护'),false);
  assert.equal(f.text().includes('保留当前文件并恢复使用'),false);assert.equal(f.requests.length,1);
});
// The server owns operation/scope eligibility. The published UI payload contains
// exact availability flags, version and receipt, not an operation override.
test('legacy non-replace and incomplete-scope exits survive without an automatic marker when the server grants them',async()=>{
  for(const [scenario,review,abandon] of [['create file',true,true],['move file',true,true],['trash file',true,true],
    ['directory operation',false,true],['incomplete scope',false,true]]) {
    const job={...withdrawalJob,automatic_recovery:undefined,review_available:review,abandon_available:abandon};
    const f=fixture(true,[job]);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    assert.equal(f.text().includes('查看当前文件并处理冲突'),review,scenario);
    assert.equal(f.text().includes('停止管理旧登记并解除保护'),abandon,scenario);
    assert.equal(f.text().includes('保留当前文件并恢复使用'),false,scenario);
    assert.equal(f.requests.length,1,scenario);assert.equal(f.confirmations.length,0,scenario);
  }
});
test('a server-granted incomplete-scope legacy withdrawal uses only its original version and receipt',async()=>{
  const f=fixture(true,[{...withdrawalJob,automatic_recovery:undefined}]);await f.settle();
  f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.button('停止管理旧登记并解除保护').props.onClick();await f.settle();
  const confirm=f.button('确认停止管理（不删除文件）');confirm.props.onClick();confirm.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.deepEqual(JSON.parse(f.requests[1].init.body),{
    action:'review_abandon',connection_id:connection.id,job_id:recoveryJob,base_version:3,source_receipt_id:recoveryReceipt,confirmed:true});
  assert.equal(f.requests.some(r=>r.url.includes('google')),false);assert.equal(f.text().includes('已自动恢复使用'),false);
});
test('legacy optional review retains its existing fresh observation choices without enabling routine pending actions',async()=>{
  for(const observed_state of ['before','after','changed']) {
    const f=fixture(true,[{...reviewJob,automatic_recovery:undefined}]);await f.settle();
    f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    f.button('查看当前文件并处理冲突').props.onClick();await f.settle();f.respond(1,{...observation,observed_state});await f.settle();
    assert.equal(f.requests.length,2);f.button('保留当前文件并恢复使用').props.onClick();await f.settle();
    assert.equal(f.requests.length,3);assert.deepEqual(JSON.parse(f.requests[2].init.body),{
      action:'review_accept',connection_id:connection.id,job_id:recoveryJob,base_version:3,source_receipt_id:recoveryReceipt,
      confirmed:true,observation_id:observation.observation_id});
    assert.equal(f.text().includes('已自动恢复使用'),false);
  }
});
test('legacy availability cannot be fabricated by malformed flags, terminal status or invalid version/receipt references',async()=>{
  for(const fields of [{review_available:'true',abandon_available:'true'},{base_version:0},{base_version:3.5},
    {source_receipt_id:undefined},{source_receipt_id:'invalid'},{status:'unknown'},{status:'committed'},
    {status:'resolved',resolution:'accepted_current_state'},{automatic_recovery:'unknown'},{automatic_recovery:null}]) {
    const f=fixture(true,[{...withdrawalJob,automatic_recovery:undefined,review_available:true,...fields}]);await f.settle();
    f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    assert.equal(f.text().includes('查看当前文件并处理冲突'),false,JSON.stringify(fields));
    assert.equal(f.text().includes('停止管理旧登记并解除保护'),false,JSON.stringify(fields));
    assert.equal(f.requests.length,1);
  }
});
test('removing legacy availability invalidates an old confirmation and an old preparation button',async()=>{
  const jobs=[{...reviewJob,automatic_recovery:undefined}],f=fixture(true,jobs);await f.settle();
  f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  const prepare=f.button('查看当前文件并处理冲突');prepare.props.onClick();await f.settle();f.respond(1,observation);await f.settle();
  const accept=f.button('保留当前文件并恢复使用');jobs[0]={...jobs[0],review_available:false,abandon_available:false};
  f.poll();await f.settle();accept.props.onClick();prepare.props.onClick();await f.settle();
  assert.equal(f.text().includes('保留当前文件并恢复使用'),false);assert.equal(f.requests.length,2);
});
test('a disconnected complete identity can stop old registration without preview, credentials or reauthorization',async()=>{
  const f=fixture(true,[{...withdrawalJob,review_available:true}]);await f.settle();
  f.respond(0,{connections:[{...connection,state:'revoked'}]});await f.settle();
  f.button('停止管理旧登记并解除保护').props.onClick();await f.settle();f.button('确认停止管理（不删除文件）').props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.equal(JSON.parse(f.requests[1].init.body).action,'review_abandon');
  assert.equal(f.requests.some(r=>r.url.includes('google')),false);
});
test('every directory can load status beyond the initial five without spending provider recovery budget',async()=>{
  const f=fixture(true,[]),roots=Array.from({length:6},(_,i)=>({...connection,id:'fixture-connection-'+i,state:'active'}));await f.settle();
  f.respond(0,{connections:roots});await f.settle();assert.equal(f.recoveryLists.length,5);
  const last=f.button('读取本目录文件操作状态');last.props.onClick();await f.settle();
  assert.equal(f.recoveryLists.length,6);assert.equal(JSON.parse(f.recoveryLists[5].init.body).connection_id,roots[5].id);
  assert.equal(f.requests.length,1);f.change('b');await f.settle();const reads=f.recoveryLists.length;
  last.props.onClick();await f.settle();assert.equal(f.recoveryLists.length,reads);
});
async function reviewReady() {
  const jobs=[reviewJob],f=fixture(true,jobs);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.button('查看当前文件并处理冲突').props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:'review_prepare',connection_id:connection.id,job_id:recoveryJob});
  f.respond(1,observation);await f.settle();return {f,jobs};
}
test('only a real current-content conflict offers an optional informed choice with exact server references',async()=>{
  const {f,jobs}=await reviewReady();assert.match(f.text(),/原文件.zip/);assert.match(f.text(),/文件已变成与原操作预期不同的状态/);
  assert.equal(f.requests.length,2);assert.equal(f.confirmations.length,0);
  const accept=f.button('保留当前文件并恢复使用');accept.props.onClick();accept.props.onClick();await f.settle();
  assert.equal(f.requests.length,3);assert.deepEqual(JSON.parse(f.requests[2].init.body),{
    action:'review_accept',connection_id:connection.id,job_id:recoveryJob,base_version:3,source_receipt_id:recoveryReceipt,
    confirmed:true,observation_id:observation.observation_id});
  jobs.length=0;f.respond(2,{status:'resolved',resolution:'accepted_current_state',connection_id:connection.id,job_id:recoveryJob,
    receipt_id:lateReceipt,execution_permitted:false});await f.settle();assert.match(f.text(),/已按 Google 当前文件状态恢复登记和使用/);
  assert.equal(f.text().includes('原任务结果已核验并登记'),false);
});
test('a current-state preview that becomes before or after returns to program recovery without manual adoption',async()=>{
  for(const observed_state of ['before','after']) {
    const f=fixture(true,[reviewJob]);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    f.button('查看当前文件并处理冲突').props.onClick();await f.settle();f.respond(1,{...observation,observed_state});await f.settle();
    assert.match(f.text(),/当前文件状态无需人工取舍/);assert.equal(f.text().includes('保留当前文件并恢复使用'),false);
    assert.equal(f.requests.length,2);assert.equal(f.confirmations.length,0);assert.equal(f.text().includes('已自动恢复使用'),false);
    assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action==='review_accept'),false);
  }
});
test('cancel, refresh and account change invalidate an old current-state acceptance',async()=>{
  for(const kind of ['cancel','refresh','account']) {
    const {f}=await reviewReady(),old=f.button('保留当前文件并恢复使用');
    if(kind==='cancel')f.button('暂不采用').props.onClick();
    if(kind==='refresh')f.button('刷新状态').props.onClick();
    if(kind==='account')f.change('b');
    old.props.onClick();await f.settle();assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action==='review_accept'),false,kind);
  }
});
test('server recovery progress invalidates an old conflict choice and a stale preparation button',async()=>{
  const {f,jobs}=await reviewReady(),old=f.button('保留当前文件并恢复使用'),prepare=f.button('查看当前文件并处理冲突');
  jobs[0]=autoPending();f.poll();await f.settle();
  assert.equal(f.text().includes('保留当前文件并恢复使用'),false);
  old.props.onClick();prepare.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action==='review_accept'),false);
});
test('a conflict preview arriving after server progress is discarded instead of reopening manual recovery',async()=>{
  const jobs=[reviewJob],f=fixture(true,jobs);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  f.button('查看当前文件并处理冲突').props.onClick();await f.settle();jobs[0]=autoPending();f.poll();await f.settle();
  f.respond(1,observation);await f.settle();assert.equal(f.text().includes('保留当前文件并恢复使用'),false);
  assert.equal(f.requests.length,2);
});
test('unknown review result never becomes success and is not resubmitted',async()=>{
  const {f}=await reviewReady();f.button('保留当前文件并恢复使用').props.onClick();await f.settle();
  f.respond(2,{status:'attention_required',review_error:'REVIEW_NOT_COMMITTED',execution_permitted:false});await f.settle();
  assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==='review_accept').length,1);
  assert.equal(f.text().includes('已按 Google 当前文件状态恢复登记'),false);assert.match(f.text(),/登记结果尚未确认/);
});
test('expired review gives a useful reread action without repeating acceptance',async()=>{
  const {f}=await reviewReady();f.button('保留当前文件并恢复使用').props.onClick();await f.settle();
  f.respond(2,{status:'attention_required',review_error:'REVIEW_REFRESH_REQUIRED',execution_permitted:false});await f.settle();
  assert.match(f.text(),/读取记录已过期，或文件与登记状态已变化/);
  assert.match(f.text(),/请重新查看当前文件/);
  assert.equal(f.requests.filter(r=>JSON.parse(r.init.body).action==='review_accept').length,1);
  assert.equal(f.text().includes('已按 Google 当前文件状态恢复登记'),false);
});
test('resolved history is displayed without rerunning settlement or keeping status polling alive',async()=>{
  const f=fixture(true,[{...inspection('resolved'),resolution:'accepted_current_state'}]);await f.settle();
  f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
  assert.match(f.text(),/已按 Google 当前文件状态恢复登记和使用/);
  const reads=f.recoveryLists.length;f.poll();await f.settle();
  assert.equal(f.requests.length,1);assert.equal(f.recoveryLists.length,reads);
});
test('a late current-state acceptance cannot display success after an account switch',async()=>{
  const {f}=await reviewReady();f.button('保留当前文件并恢复使用').props.onClick();await f.settle();f.change('b');await f.settle();
  f.respond(3,{connections:[]});await f.settle();f.respond(2,{status:'resolved',resolution:'accepted_current_state',connection_id:connection.id,
    job_id:recoveryJob,receipt_id:lateReceipt,execution_permitted:false});await f.settle();
  assert.equal(f.text().includes('已按 Google 当前文件状态恢复登记'),false);
});
test('review observation identity, version and source receipt must match the displayed original job',async()=>{
  for(const changed of [{job_id:lateReceipt},{base_version:4},{source_receipt_id:lateReceipt},{provider_file_id:'https://evil.invalid'}]) {
    const f=fixture(true,[reviewJob]);await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    f.button('查看当前文件并处理冲突').props.onClick();await f.settle();
    f.respond(1,{...observation,...changed});await f.settle();
    assert.equal(f.text().includes('保留当前文件并恢复使用'),false);assert.equal(f.requests.length,2);
  }
});

test("directory observation submits only one exact connection and never claims writing is enabled",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
  const check=f.button("检查全部登记目录的信息和新建能力");check.props.onClick();check.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,"/v1/storage/google/probe");
  assert.deepEqual(JSON.parse(f.requests[1].init.body),{connection_id:connection.id});
  f.respond(1,{status:"metadata_observed",attempt_id:"10000000-0000-4000-8000-000000000001",receipt_id:"10000000-0000-4000-8000-000000000002",execution_permitted:false});await f.settle();
  assert.ok(f.text().includes("这不是完整存储资格验收"));assert.ok(f.text().includes("不会开启文件写入"));
  assert.equal(f.requests.length,2);
});
test("directory observation late reply is discarded after account switch",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
  f.button("检查全部登记目录的信息和新建能力").props.onClick();await f.settle();f.change("b");await f.settle();
  f.respond(2,{connections:[]});await f.settle();
  f.respond(1,{status:"metadata_observed",attempt_id:"10000000-0000-4000-8000-000000000001",receipt_id:"10000000-0000-4000-8000-000000000002",execution_permitted:false});await f.settle();
  assert.equal(f.text().includes("检查已记录"),false);assert.equal(f.text().includes("10000000-0000-4000-8000-000000000002"),false);
});

test('boundary clean report is distinct from a durable receipt and malformed reports cannot claim clean',async()=>{
  for(const valid of [true,false]) {
    const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    f.button('检查全部登记目录的信息和新建能力').props.onClick();await f.settle();
    f.respond(1,{status:'metadata_observed',attempt_id:'10000000-0000-4000-8000-000000000001',receipt_id:'10000000-0000-4000-8000-000000000002',execution_permitted:false,
      boundary_observation:{contract:'clued.storage-boundary-observation/1',status:'clean',observed_at_ms:100,digest_format:'sorted-json/1',
        policy_version:'clued.resource-center-mutation-policy/1',scanner_contract:'clued.google-drive-boundary/1',secret:'must-not-display',
        descriptor_sha256:'a'.repeat(64),scan_config_sha256:valid?'b'.repeat(64):'private-invalid'}});await f.settle();
    assert.equal(f.text().includes('本次父级与同级边界只读扫描未发现违规'),valid);
    if(valid){assert.match(f.text(),/不包含在旧目录回执合同中/);assert.ok(f.text().includes('"descriptor_sha256":"'+'a'.repeat(64)+'"'));assert.ok(f.text().includes('"observed_at_ms":100'));}
    assert.equal(f.text().includes('must-not-display'),false);
    assert.match(f.text(),/不会开启文件写入/);assert.equal(f.text().includes('private-invalid'),false);
  }
});
test("late account A list cannot appear after switching to B", async () => {
  const f=fixture(); await f.settle(); f.change("b"); await f.settle();
  f.respond(1,{connections:[]}); await f.settle(); f.respond(0,{connections:[connection]}); await f.settle();
  assert.equal(f.text().includes(connection.id),false);
});
const status = { enabled:false,version:0,connection_version:2,failures:0,pending:false,next_refresh_at:null };
async function ready(confirm=true) {
  const f=fixture(confirm); await f.settle(); f.respond(0,{connections:[{...connection,state:"active",version:2}]}); await f.settle();
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,"/v1/storage/owner"); assert.deepEqual(JSON.parse(f.requests[0].init.body),{action:"connections"});
  f.button("查询续签状态").props.onClick(); await f.settle();
  assert.equal(f.requests[1].url,"/v1/storage/refresh"); assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:"status",connection_id:connection.id});
  f.respond(1,status); await f.settle(); return f;
}
test("standing refresh requires explicit confirmation and exact CAS, then reads fresh status",async()=>{
  const f=await ready(); f.button("授权开启后台续签").props.onClick(); await f.settle();
  assert.ok(f.text().includes("退出登录不影响续签"));
  assert.equal(f.confirmations.length,0); assert.equal(f.requests.length,2);
  f.button("确认开启后台续签").props.onClick(); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[2].init.body),{action:"enable",connection_id:connection.id,base_version:2,delegation_version:0,idempotency_key:"fixture-request",until_revoked:true});
  f.respond(2,{status:"committed",receipt_id:fixtureReceipt}); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[3].init.body),{action:"status",connection_id:connection.id});
  f.respond(3,{...status,enabled:true,version:1}); await f.settle(); assert.ok(f.text().includes("后台续签已开启"));
  f.button("停用后台续签").props.onClick(); await f.settle();
  assert.equal(f.requests.length,4);
  f.button("确认停用后台续签").props.onClick(); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[4].init.body),{action:"disable",connection_id:connection.id,base_version:2,delegation_version:1,idempotency_key:"fixture-request"});
});
test("cancelled confirmation never submits; uncertain pending cannot be re-enabled",async()=>{
  const f=await ready(false); f.button("授权开启后台续签").props.onClick(); await f.settle(); assert.equal(f.requests.length,2);
  const stale=f.button("确认开启后台续签"); f.button("取消续签设置").props.onClick(); await f.settle();
  stale.props.onClick(); await f.settle(); assert.equal(f.requests.length,2);
  f.button("查询续签状态").props.onClick(); await f.settle(); f.respond(2,{...status,pending:true}); await f.settle();
  assert.equal(f.button("授权开启后台续签").props.disabled,true); assert.ok(f.text().includes("尚未确认"));
});
test("account switch during refresh setting does not query or display the old connection",async()=>{
  const f=await ready(); f.button("授权开启后台续签").props.onClick(); await f.settle();
  f.button("确认开启后台续签").props.onClick(); await f.settle();
  f.change("b"); await f.settle(); f.respond(3,{connections:[]}); await f.settle();
  f.respond(2,{status:"committed",receipt_id:lateReceipt}); await f.settle();
  assert.equal(f.requests.length,4); assert.equal(f.text().includes(connection.id),false); assert.equal(f.text().includes("设置已确认"),false);
});
test("double click cannot dispatch two refresh changes",async()=>{
  const f=await ready(); const enable=f.button("授权开启后台续签");
  enable.props.onClick(); enable.props.onClick(); await f.settle();
  assert.equal(f.requests.length,2); assert.equal(f.confirmations.length,0);
  const confirm=f.button("确认开启后台续签"); confirm.props.onClick(); confirm.props.onClick(); await f.settle();
  assert.equal(f.requests.length,3);
  assert.equal(JSON.parse(f.requests[2].init.body).action,"enable");
});
test("account switch before refresh dispatch blocks stale consent",async()=>{
  const f=await ready(); f.button("授权开启后台续签").props.onClick(); await f.settle();
  const stale=f.button("确认开启后台续签"); f.change("b"); await f.settle();
  stale.props.onClick(); await f.settle();
  assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action === "enable"),false);
  assert.equal(f.text().includes(connection.id),false);
});

const registrationProfile="00000000-0000-4000-8000-000000000011", registrationDecision="00000000-0000-4000-8000-000000000012";
async function registrationReady(confirm=true) {
  const f=fixture(confirm); await f.settle(); f.respond(0,{connections:[]}); await f.settle();
  f.input("已登记目录 ID").props.onChange({target:{value:registrationProfile}});
  f.input("当前授权 Decision ID").props.onChange({target:{value:registrationDecision}}); await f.settle(); return f;
}
test("native registration sends only exact existing IDs and a stable receipt key, not write grants",async()=>{
  const f=await registrationReady(); const button=f.button("登记账号连接"); button.props.onClick(); button.props.onClick(); await f.settle();
  assert.equal(f.requests.length,2); assert.ok(f.confirmations[0].includes("不授予 Google 访问"));
  const body=JSON.parse(f.requests[1].init.body);
  assert.deepEqual(body,{action:"register",profile_id:registrationProfile,source_decision_id:registrationDecision,
    idempotency_key:`storage-register-ui-v1:${registrationProfile}:${registrationDecision}`});
  f.respond(1,{status:"committed",receipt_id:fixtureReceipt}); await f.settle();
  assert.equal(f.requests[2].url,"/v1/storage/owner"); assert.deepEqual(JSON.parse(f.requests[2].init.body),{action:"connections"});
  f.respond(2,{connections:[connection]}); await f.settle(); assert.ok(f.text().includes(connection.id));
  assert.equal(f.navigations.length,0);
});
test("registration cancellation or invalid identifiers causes no mutation",async()=>{
  const f=await registrationReady(false); f.button("登记账号连接").props.onClick(); await f.settle(); assert.equal(f.requests.length,1);
  const invalid=await registrationReady(); invalid.input("已登记目录 ID").props.onChange({target:{value:"G:/caller-selected-root"}}); await invalid.settle();
  invalid.button("登记账号连接").props.onClick(); await invalid.settle(); assert.equal(invalid.requests.length,1); assert.equal(invalid.confirmations.length,0);
});
test("uncertain registration response and reload keep the same account-scoped operation identity",async()=>{
  const f=await registrationReady(); f.button("登记账号连接").props.onClick(); await f.settle();
  f.respond(1,{status:"unknown"}); await f.settle(); assert.ok(f.text().includes("登记回执未确认"));
  f.button("登记账号连接").props.onClick(); await f.settle(); assert.equal(f.requests[1].init.body,f.requests[2].init.body);
  const reloaded=await registrationReady(); reloaded.button("登记账号连接").props.onClick(); await reloaded.settle();
  assert.equal(f.requests[1].init.body,reloaded.requests[1].init.body);
});
test("account switch before registration dispatch blocks the stale request and clears draft",async()=>{
  const f=await registrationReady(); f.button("登记账号连接").props.onClick(); f.change("b"); await f.settle();
  assert.equal(f.requests.some(r=>JSON.parse(r.init.body).action === "register"),false);
  assert.equal(f.input("已登记目录 ID").props.value,""); assert.equal(f.input("当前授权 Decision ID").props.value,"");
});
test("late registration receipt after account switch cannot refresh old connection state",async()=>{
  const f=await registrationReady(); f.button("登记账号连接").props.onClick(); await f.settle(); f.change("b"); await f.settle();
  f.respond(2,{connections:[]}); await f.settle(); f.respond(1,{status:"committed",receipt_id:lateReceipt}); await f.settle();
  assert.equal(f.requests.length,3); assert.equal(f.text().includes(connection.id),false);
});

const client = { binding_id:"fixture-client",client_id:"vendor",client_name:"Example Agent",version:3,active:true,expires_at:new Date(Date.now()+7200000).toISOString() };
const grantView = {connection_id:connection.id,connection_version:4,connection_state:"active",grants:[]};
async function clientsReady(confirm=true, bindings=[client], grants=[]) {
  const f=fixture(confirm); await f.settle(); f.respond(0,{connections:[{...connection,state:"active"}]}); await f.settle();
  f.button("查询客户端存储授权").props.onClick();await f.settle();
  assert.equal(f.requests[1].url,"/oauth/connections/api");assert.equal(f.requests[1].init.method,"GET");assert.equal(f.requests[1].init.body,undefined);
  f.respond(1,{bindings});await f.settle();
  f.respond(2,{...grantView,grants});await f.settle();return f;
}
async function chooseClient(f) {
  f.input("授权客户端").props.onChange({target:{value:client.binding_id}});await f.settle();
  assert.equal(f.input("新建文件").props.checked,false);
  f.input("新建文件").props.onChange({target:{checked:true}});await f.settle();
}
