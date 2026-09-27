import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(readFileSync(new URL("../app/storage/google/callback/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
function fixture(query, authenticated = true, delayed = false) {
  const effects = [], messages = [], requests = [], calls = [];
  let authCallback, owner = authenticated ? "owner-a" : null, respond;
  const browser = { location: { href: "https://clued.invalid/storage/google/callback?" + query }, history: {
    replaceState(_state, _unused, value) { calls.push("clear"); browser.location.href = new URL(value, browser.location.href).href; },
  } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, Error, window: browser,
    require(name) {
      if (name === "react") return { useState: initial => [initial, message => messages.push(message)], useEffect: effect => effects.push(effect) };
      if (name === "react/jsx-runtime") return { jsx() {}, jsxs() {} };
      if (name === "next/link") return { __esModule: true, default: "a" };
      if (name.endsWith("/supabase-browser")) return { supabase: { auth: { onAuthStateChange(cb) { authCallback = cb; cb("INITIAL_SESSION", owner ? { user: { id: owner } } : null); return { data: { subscription: { unsubscribe() {} } } }; }, getSession: async () => {
        calls.push("session"); assert.equal(new URL(browser.location.href).search, "");
        return { data: { session: owner ? { access_token: "fixture-native", user: { id: owner } } : null }, error: null };
      } } } };
      throw Error("Unexpected import: " + name);
    },
    fetch: async (url, init) => { calls.push("network"); requests.push({ url, init });
      if (delayed) await new Promise(resolve => { respond = resolve; });
      return { ok: true, json: async () => ({ status: "completed", receipt_id: "fixture-receipt" }) }; },
  });
  exports.default();
  const settle = async () => { for (let i=0;i<16;i++) await Promise.resolve(); };
  return { browser, calls, messages, requests, settle, respond: () => respond(), change: id => { owner = id; authCallback("SIGNED_OUT", id ? { user: { id } } : null); },
    run: async () => { effects[0](); effects[0](); await settle(); } };
}
test("Google callback clears credentials before session/network and duplicate effects exchange once", async () => {
  const f = fixture("state=fixture-state&code=fixture-code"); await f.run();
  assert.deepEqual(f.calls.slice(0,3), ["clear", "session", "network"]); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/v1/storage/google/complete");
  assert.equal(f.requests[0].init.referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(f.requests[0].init.body), { state: "fixture-state", code: "fixture-code" });
  assert.ok(f.messages.every(message => !message.includes("fixture-code")));
});
test("Google denial, duplicate query or missing native session never submits authorization code", async () => {
  for (const [query, auth] of [["error=access_denied", true], ["state=a&state=b&code=x", true], ["state=a&code=x", false]]) {
    const f = fixture(query, auth); await f.run(); assert.equal(f.requests.length, 0);
    assert.equal(new URL(f.browser.location.href).search, "");
    assert.ok(f.messages.length > 0);
    assert.ok(f.messages.every(message => auth
      ? message === "Google 授权未完成，请返回连接页检查。"
      : message === "登录账号已变化，请返回连接页重新读取状态。"));
  }
});
test("logout or account switch before callback completion suppresses the old receipt", async () => {
  for (const owner of [null, "owner-b"]) {
    const f = fixture("state=fixture-state&code=fixture-code", true, true); await f.run();
    f.change(owner); f.respond(); await f.settle();
    assert.ok(f.messages.every(message => !message.includes("fixture-receipt")));
    assert.ok(f.messages.some(message => message.includes("账号已变化")));
  }
});
