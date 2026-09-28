// Deterministic real-component logic coverage, not a live browser qualification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(readFileSync(new URL("../app/storage/admin/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
function fixture(confirm = true) {
  const hooks = [], effects = [], requests = [], navigations = [], confirmations = [];
  let owner = "a", authCallback, cursor = 0, tree;
  const equal = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const React = {
    useState(initial) { const i=cursor++; hooks[i] ??= { value: initial }; return [hooks[i].value, v => { hooks[i].value = typeof v === "function" ? v(hooks[i].value) : v; }]; },
    useRef(initial) { const i=cursor++; hooks[i] ??= { current: initial }; return hooks[i]; },
    useCallback(fn,deps) { const i=cursor++; if (!hooks[i] || !equal(hooks[i].deps,deps)) hooks[i] = { fn,deps }; return hooks[i].fn; },
    useEffect(fn,deps) { const i=cursor++; if (!hooks[i] || !equal(hooks[i].deps,deps)) { hooks[i]={deps}; effects.push(fn); } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, Error, queueMicrotask, crypto: { randomUUID: () => "fixture-request" },
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
    fetch(url,init) { return new Promise(resolve => { requests.push({ url,init,resolve }); }); },
  });
  const render = () => { cursor=0; tree=exports.default(); while(effects.length) effects.shift()(); };
  const settle = async () => { for(let i=0;i<20;i++) await Promise.resolve(); render(); };
  const text = n => Array.isArray(n) ? n.map(text).join("") : n == null || typeof n === "boolean" ? "" : typeof n === "object" ? text(n.props?.children) : String(n);
  function button(label) { let found; const visit = n => { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== "object") return; if(n.type === "button" && text(n) === label) found=n; visit(n.props?.children); }; visit(tree); assert.ok(found,label); return found; }
  function input(label) { let found; const visit = n => { if(Array.isArray(n)) return n.forEach(visit); if(!n || typeof n !== "object") return;
    if(n.type === "label" && text(n).startsWith(label)) { const children = Array.isArray(n.props.children) ? n.props.children : [n.props.children]; found=children.find(c=>c?.type === "input" || c?.type === "select"); }
    visit(n.props?.children); }; visit(tree); assert.ok(found,label); return found; }
  render();
  return { requests, navigations, confirmations, settle, text: () => text(tree), button, input,
    change(id) { owner=id; authCallback("SIGNED_IN", id ? { user:{id} } : null); render(); },
    respond(i,value,status=200) { requests[i].resolve({ ok:status<400, status, json:async()=>value }); },
    probeFeedback() { let found=""; const visit=n=>{if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=="object")return;
      if(n.type==="div" && Array.isArray(n.props.children) && n.props.children.some(c=>c?.type==="button" && text(c)==="检查已登记目录（只读）"))
        found=n.props.children.filter(c=>c?.props?.role==="status").map(text).join("");visit(n.props.children);};visit(tree);return found;},
  };
}
const connection = { id: "fixture-connection-a", provider: "google-drive", state: "awaiting_provider", version:1, profile_id:"fixture-profile" };

test("directory probe shows progress and safe failure beside its button without a second dispatch",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
  const b=f.button("检查已登记目录（只读）");b.props.onClick();b.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.match(f.probeFeedback(),/正在只读检查/);
  f.respond(1,{execution_permitted:false,diagnostic:{stage:"directories",reason:"DIRECTORY_NOT_APP_AUTHORIZED"}},403);await f.settle();
  assert.match(f.probeFeedback(),/尚未向当前 Google 应用授权/);assert.match(f.probeFeedback(),/不会自动重试或开启文件写入/);
  assert.equal(f.requests.length,2);assert.equal(f.button("检查已登记目录（只读）").props.disabled,false);
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
    f.button("检查已登记目录（只读）").props.onClick();await f.settle();
    f.respond(1,{execution_permitted:false,diagnostic:{stage:"directories",reason},error:"private-provider-text"},403);await f.settle();
    assert.ok(f.probeFeedback().includes(label));assert.equal(f.text().includes("private-provider-text"),false);
    assert.match(f.probeFeedback(),/不会自动重试或开启文件写入/);assert.equal(f.requests.length,2);
  }
});

test("directory probe error text cannot inject upstream content or cross an account switch",async()=>{
  for(const changed of [false,true]) {
    const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
    f.button("检查已登记目录（只读）").props.onClick();await f.settle();
    if(changed){f.change("b");await f.settle();f.respond(2,{connections:[]});await f.settle();}
    f.respond(1,{execution_permitted:false,diagnostic:{stage:"credential",reason:"private-token"},error:"private-token"},403);await f.settle();
    assert.equal(f.text().includes("private-token"),false);
    if(changed)assert.equal(f.probeFeedback(),"");else assert.match(f.probeFeedback(),/目录检查未确认/);
  }
});

const recoveryJob='10000000-0000-4000-8000-000000000081',recoveryReceipt='10000000-0000-4000-8000-000000000082';
async function recoveryReady(confirm=true,state='reauthorization_required') {
  const f=fixture(confirm);await f.settle();f.respond(0,{connections:[{...connection,state}]});await f.settle();
  f.input('原存储任务 ID').props.onChange({target:{value:recoveryJob}});await f.settle();
  return f;
}
test('native recovery reads original receipt first, explicitly confirms settlement and prevents duplicate clicks',async()=>{
  const f=await recoveryReady();const inspect=f.button('查询原任务回执');inspect.props.onClick();inspect.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,'/v1/storage/recovery');
  assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:'inspect',connection_id:connection.id,job_id:recoveryJob});
  f.respond(1,{connection_id:connection.id,job_id:recoveryJob,status:'started',receipt_id:recoveryReceipt,execution_permitted:false});await f.settle();
  const settle=f.button('核验并登记原结果（不重写）');settle.props.onClick();settle.props.onClick();await f.settle();
  assert.equal(f.requests.length,3);assert.equal(f.confirmations.length,1);assert.match(f.confirmations[0],/不会重新创建文件/);
  assert.deepEqual(JSON.parse(f.requests[2].init.body),{action:'settle',connection_id:connection.id,job_id:recoveryJob});
  f.respond(2,{job_id:recoveryJob,status:'committed',receipt_id:recoveryReceipt,execution_permitted:false});await f.settle();
  assert.match(f.text(),/没有重新写入文件或恢复权限/);assert.equal(f.requests.length,3);assert.equal(f.navigations.length,0);
});
test('cancelled or unknown recovery never resends; editing job clears old settlement controls',async()=>{
  for(const consent of [false,true]) {
    const f=await recoveryReady(consent);f.button('查询原任务回执').props.onClick();await f.settle();
    f.respond(1,{connection_id:connection.id,job_id:recoveryJob,status:'uncertain',receipt_id:recoveryReceipt,execution_permitted:false});await f.settle();
    f.button('核验并登记原结果（不重写）').props.onClick();await f.settle();
    if(!consent)assert.equal(f.requests.length,2);
    else {f.respond(2,{status:'inspection_required',execution_permitted:false});await f.settle();assert.match(f.text(),/不会自动重试/);assert.equal(f.requests.length,3);}
    f.input('原存储任务 ID').props.onChange({target:{value:recoveryReceipt}});await f.settle();
    assert.equal(f.text().includes('核验并登记原结果（不重写）'),false);
  }
});
test('revoked connection permits historical inspection only, never a settlement button',async()=>{
  const f=await recoveryReady(true,'revoked');f.button('查询原任务回执').props.onClick();await f.settle();
  f.respond(1,{connection_id:connection.id,job_id:recoveryJob,status:'started',receipt_id:recoveryReceipt,execution_permitted:false});await f.settle();
  assert.ok(f.text().includes(recoveryReceipt));assert.equal(f.text().includes('核验并登记原结果（不重写）'),false);
});

test('fresh recovery consent is exact-job, explicit, one-click and never sends default renewal authority',async()=>{
  const f=await recoveryReady();f.button('查询原任务回执').props.onClick();await f.settle();
  f.respond(1,{connection_id:connection.id,job_id:recoveryJob,status:'started',receipt_id:recoveryReceipt,execution_permitted:false});await f.settle();
  const button=f.button('凭据过期：重新授权以核对原任务');button.props.onClick();button.props.onClick();await f.settle();
  assert.equal(f.requests.length,3);assert.equal(f.requests[2].url,'/v1/storage/google/recovery/start');
  assert.deepEqual(JSON.parse(f.requests[2].init.body),{connection_id:connection.id,job_id:recoveryJob});
  assert.match(f.confirmations[0],/不恢复已停用连接/);assert.match(f.confirmations[0],/Google 最终同意由你确认/);
  f.respond(2,{authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'});await f.settle();
  assert.equal(f.navigations.length,1);
});

test('cancel or account change prevents stale recovery consent and late redirects',async()=>{
  for(const kind of ['cancel','before','after']){
    const f=await recoveryReady(kind!=='cancel');f.button('查询原任务回执').props.onClick();await f.settle();
    f.respond(1,{connection_id:connection.id,job_id:recoveryJob,status:'started',receipt_id:recoveryReceipt,execution_permitted:false});await f.settle();
    f.button('凭据过期：重新授权以核对原任务').props.onClick();if(kind==='before')f.change('b');await f.settle();
    if(kind==='after'){f.change('b');await f.settle();f.respond(2,{authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'});await f.settle();}
    else assert.equal(f.requests.some(r=>r.url==='/v1/storage/google/recovery/start'),false);
    assert.equal(f.navigations.length,0);
  }
});
test('account switch before recovery dispatch blocks it and suppresses a late settlement receipt',async()=>{
  const blocked=await recoveryReady();blocked.button('查询原任务回执').props.onClick();blocked.change('b');await blocked.settle();
  assert.equal(blocked.requests.some(r=>r.url==='/v1/storage/recovery'),false);
  const f=await recoveryReady();f.button('查询原任务回执').props.onClick();await f.settle();
  f.respond(1,{connection_id:connection.id,job_id:recoveryJob,status:'started',receipt_id:recoveryReceipt,execution_permitted:false});await f.settle();
  f.button('核验并登记原结果（不重写）').props.onClick();await f.settle();f.change('b');await f.settle();
  f.respond(3,{connections:[]});await f.settle();f.respond(2,{job_id:recoveryJob,status:'committed',receipt_id:recoveryReceipt,execution_permitted:false});await f.settle();
  assert.equal(f.text().includes(recoveryReceipt),false);assert.equal(f.text().includes('原任务结果已核验'),false);assert.equal(f.requests.length,4);
});

test("directory observation submits only one exact connection and never claims writing is enabled",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
  const check=f.button("检查已登记目录（只读）");check.props.onClick();check.props.onClick();await f.settle();
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].url,"/v1/storage/google/probe");
  assert.deepEqual(JSON.parse(f.requests[1].init.body),{connection_id:connection.id});
  f.respond(1,{status:"metadata_observed",attempt_id:"10000000-0000-4000-8000-000000000001",receipt_id:"10000000-0000-4000-8000-000000000002",execution_permitted:false});await f.settle();
  assert.ok(f.text().includes("这不是完整存储资格验收"));assert.ok(f.text().includes("不会开启文件写入"));
  assert.equal(f.requests.length,2);
});
test("directory observation late reply is discarded after account switch",async()=>{
  const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:"active"}]});await f.settle();
  f.button("检查已登记目录（只读）").props.onClick();await f.settle();f.change("b");await f.settle();
  f.respond(2,{connections:[]});await f.settle();
  f.respond(1,{status:"metadata_observed",attempt_id:"10000000-0000-4000-8000-000000000001",receipt_id:"10000000-0000-4000-8000-000000000002",execution_permitted:false});await f.settle();
  assert.equal(f.text().includes("检查已记录"),false);assert.equal(f.text().includes("10000000-0000-4000-8000-000000000002"),false);
});

test('boundary clean report is distinct from a durable receipt and malformed reports cannot claim clean',async()=>{
  for(const valid of [true,false]) {
    const f=fixture();await f.settle();f.respond(0,{connections:[{...connection,state:'active'}]});await f.settle();
    f.button('检查已登记目录（只读）').props.onClick();await f.settle();
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
  f.button("查询续签状态").props.onClick(); await f.settle();
  assert.equal(f.requests[1].url,"/v1/storage/refresh"); assert.deepEqual(JSON.parse(f.requests[1].init.body),{action:"status",connection_id:connection.id});
  f.respond(1,status); await f.settle(); return f;
}
test("standing refresh requires explicit confirmation and exact CAS, then reads fresh status",async()=>{
  const f=await ready(); f.button("授权开启后台续签").props.onClick(); await f.settle();
  assert.ok(f.confirmations[0].includes("退出登录不影响续签"));
  assert.deepEqual(JSON.parse(f.requests[2].init.body),{action:"enable",connection_id:connection.id,base_version:2,delegation_version:0,idempotency_key:"fixture-request",until_revoked:true});
  f.respond(2,{receipt_id:"fixture-receipt"}); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[3].init.body),{action:"status",connection_id:connection.id});
  f.respond(3,{...status,enabled:true,version:1}); await f.settle(); assert.ok(f.text().includes("后台续签已开启"));
  f.button("停用后台续签").props.onClick(); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[4].init.body),{action:"disable",connection_id:connection.id,base_version:2,delegation_version:1,idempotency_key:"fixture-request"});
});
test("cancelled confirmation never submits; uncertain pending cannot be re-enabled",async()=>{
  const f=await ready(false); f.button("授权开启后台续签").props.onClick(); await f.settle(); assert.equal(f.requests.length,2);
  f.button("查询续签状态").props.onClick(); await f.settle(); f.respond(2,{...status,pending:true}); await f.settle();
  assert.equal(f.button("授权开启后台续签").props.disabled,true); assert.ok(f.text().includes("尚未确认"));
});
test("account switch during refresh setting does not query or display the old connection",async()=>{
  const f=await ready(); f.button("授权开启后台续签").props.onClick(); await f.settle();
  f.change("b"); await f.settle(); f.respond(3,{connections:[]}); await f.settle();
  f.respond(2,{receipt_id:"old-receipt"}); await f.settle();
  assert.equal(f.requests.length,4); assert.equal(f.text().includes(connection.id),false); assert.equal(f.text().includes("设置已确认"),false);
});
test("double click cannot dispatch two refresh changes",async()=>{
  const f=await ready(); const enable=f.button("授权开启后台续签");
  enable.props.onClick(); enable.props.onClick(); await f.settle();
  assert.equal(f.requests.length,3); assert.equal(f.confirmations.length,1);
  assert.equal(JSON.parse(f.requests[2].init.body).action,"enable");
});
test("account switch before refresh dispatch blocks stale consent",async()=>{
  const f=await ready(); f.button("授权开启后台续签").props.onClick(); f.change("b"); await f.settle();
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
  f.respond(1,{status:"committed",receipt_id:"fixture-receipt"}); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[2].init.body),{action:"list"});
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
  f.respond(2,{connections:[]}); await f.settle(); f.respond(1,{status:"committed",receipt_id:"old-receipt"}); await f.settle();
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