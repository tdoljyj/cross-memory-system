// Deterministic real-component logic coverage, not a live browser qualification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(readFileSync(new URL("../app/storage/connections/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
function fixture() {
  const hooks = [], effects = [], requests = [], navigations = [];
  let owner = "a", authCallback, cursor = 0, tree;
  const equal = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const React = {
    useState(initial) { const i=cursor++; hooks[i] ??= { value: initial }; return [hooks[i].value, v => { hooks[i].value = v; }]; },
    useRef(initial) { const i=cursor++; hooks[i] ??= { current: initial }; return hooks[i]; },
    useCallback(fn,deps) { const i=cursor++; if (!hooks[i] || !equal(hooks[i].deps,deps)) hooks[i] = { fn,deps }; return hooks[i].fn; },
    useEffect(fn,deps) { const i=cursor++; if (!hooks[i] || !equal(hooks[i].deps,deps)) { hooks[i]={deps}; effects.push(fn); } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, Error, queueMicrotask, crypto: { randomUUID: () => "fixture-request" },
    window: { confirm: () => true, location: { assign: url => navigations.push(url) } },
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
  return { requests, navigations, settle, text: () => text(tree), button,
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
