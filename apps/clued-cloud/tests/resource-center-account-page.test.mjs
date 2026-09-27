// Deterministic real-component logic coverage, not a live browser qualification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(readFileSync(new URL("../app/storage/connections/page.tsx", import.meta.url), "utf8"), {
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
  render();
  return { requests, navigations, confirmations, settle, text: () => text(tree), button,
    change(id) { owner=id; authCallback("SIGNED_IN", id ? { user:{id} } : null); render(); },
    respond(i,value) { requests[i].resolve({ ok:true, json:async()=>value }); },
  };
}
const connection = { id: "fixture-connection-a", provider: "google-drive", state: "awaiting_provider", version:1, profile_id:"fixture-profile" };
test("late account A list cannot appear after switching to B", async () => {
  const f=fixture(); await f.settle(); f.change("b"); await f.settle();
  f.respond(1,{connections:[]}); await f.settle(); f.respond(0,{connections:[connection]}); await f.settle();
  assert.equal(f.text().includes(connection.id),false);
});
test("account change suppresses a late Google authorization navigation", async () => {
  const f=fixture(); await f.settle(); f.respond(0,{connections:[connection]}); await f.settle();
  f.button("连接 / 重新授权 Google").props.onClick(); await f.settle();
  f.change("b"); await f.settle();
  f.respond(1,{authorization_url:"https://accounts.google.com/o/oauth2/v2/auth?state=fixture"}); await f.settle();
  assert.equal(f.navigations.length,0); assert.equal(f.text().includes(connection.id),false);
});
const status = { enabled:false,version:0,connection_version:2,failures:0,pending:false,next_refresh_at:null };
async function ready(confirm=true) {
  const f=fixture(confirm); await f.settle(); f.respond(0,{connections:[{...connection,state:"active",version:2}]}); await f.settle();
  assert.equal(f.requests.length,1); // Listing does not silently authorize refresh.
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
