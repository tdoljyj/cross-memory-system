import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const compiled = ts.transpileModule(readFileSync(new URL("../app/storage/transition/page.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const manifest = "10000000-0000-4000-8000-000000000091";
const connection = "10000000-0000-4000-8000-000000000092";
const policy = "10000000-0000-4000-8000-000000000093";
const transitionReceipt = "10000000-0000-4000-8000-000000000094";
const policyReceipt = "10000000-0000-4000-8000-000000000095";
const digest = "a".repeat(64), inventory = "b".repeat(64);

function fixture({ search = `?manifest=${manifest}`, confirm = true } = {}) {
  const hooks = [], effects = [], requests = [], confirmations = [];
  let owner = "owner-a", authCallback, cursor = 0, tree;
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const React = {
    useState(initial) { const index = cursor++; hooks[index] ??= { value: initial }; return [hooks[index].value, value => { hooks[index].value = typeof value === "function" ? value(hooks[index].value) : value; }]; },
    useRef(initial) { const index = cursor++; hooks[index] ??= { current: initial }; return hooks[index]; },
    useCallback(fn, deps) { const index = cursor++; if (!hooks[index] || !equal(hooks[index].deps, deps)) hooks[index] = { fn, deps }; return hooks[index].fn; },
    useEffect(fn, deps) { const index = cursor++; if (!hooks[index] || !equal(hooks[index].deps, deps)) { hooks[index] = { deps }; effects.push(fn); } },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URLSearchParams, Error, Date, queueMicrotask,
    window: { confirm: message => { confirmations.push(message); return confirm; }, location: { search } },
    require(name) {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "next/link") return { __esModule: true, default: "a" };
      if (name.endsWith("/supabase-browser")) return { supabase: { auth: {
        getSession: async () => ({ data: { session: owner ? { user: { id: owner }, access_token: `fixture-${owner}` } : null }, error: null }),
        onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      } } };
      throw Error(name);
    },
    fetch(url, init) { return new Promise(resolve => requests.push({ url, init, resolve })); },
  });
  const render = () => { cursor = 0; tree = exports.default(); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); render(); };
  const text = node => Array.isArray(node) ? node.map(text).join("") : node == null || typeof node === "boolean" ? "" : typeof node === "object" ? text(node.props?.children) : String(node);
  const button = label => { let found; const visit = node => { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== "object") return; if (node.type === "button" && text(node) === label) found = node; visit(node.props?.children); }; visit(tree); assert.ok(found, label); return found; };
  render();
  return { requests, confirmations, settle, button, text: () => text(tree),
    respond(index, value, status = 200) { requests[index].resolve({ ok: status < 400, status, json: async () => value }); },
    change(next) { owner = next; authCallback("SIGNED_IN", next ? { user: { id: next } } : null); render(); },
  };
}

const reviewed = { contract: "clued.storage-policy-transition-status/2", manifest_id: manifest, connection_id: connection,
  manifest_sha256: digest, expected_inventory_digest: inventory, expires_at: new Date(Date.now() + 3600000).toISOString(),
  status: "reviewed", policy_id: null, transition_receipt_id: null, policy_receipt_id: null, execution_permitted: false };

test("invalid links fail closed without a request", async () => {
  const page = fixture({ search: "?manifest=caller-path" }); await page.settle();
  assert.equal(page.requests.length, 0); assert.match(page.text(), /链接无效/);
});

test("one explicit confirmation performs one exact account cutover and reads both receipts back", async () => {
  const page = fixture(); await page.settle();
  assert.deepEqual(JSON.parse(page.requests[0].init.body), { action: "describe", manifest_id: manifest });
  page.respond(0, reviewed); await page.settle();
  const button = page.button("确认启用账号统一存储"); button.props.onClick(); button.props.onClick(); await page.settle();
  assert.equal(page.confirmations.length, 1); assert.match(page.confirmations[0], /不会修改或删除云盘文件/);
  assert.equal(page.requests.length, 2);
  assert.deepEqual(JSON.parse(page.requests[1].init.body), { action: "transition", manifest_id: manifest,
    manifest_sha256: digest, expected_inventory_digest: inventory,
    idempotency_key: `storage-policy-transition-ui-v2:${manifest}:${digest}` });
  page.respond(1, { status: "committed", receipt_id: transitionReceipt }); await page.settle();
  assert.deepEqual(JSON.parse(page.requests[2].init.body), { action: "inspect", manifest_id: manifest });
  page.respond(2, { ...reviewed, status: "committed", policy_id: policy, transition_receipt_id: transitionReceipt, policy_receipt_id: policyReceipt }); await page.settle();
  assert.match(page.text(), /两份独立回执/); assert.ok(page.text().includes(transitionReceipt)); assert.ok(page.text().includes(policyReceipt));
});

test("cancel and account change never submit a stale transition", async () => {
  const cancelled = fixture({ confirm: false }); await cancelled.settle(); cancelled.respond(0, reviewed); await cancelled.settle();
  cancelled.button("确认启用账号统一存储").props.onClick(); await cancelled.settle(); assert.equal(cancelled.requests.length, 1);
  const changed = fixture(); await changed.settle(); changed.respond(0, reviewed); await changed.settle();
  changed.button("确认启用账号统一存储").props.onClick(); changed.change("owner-b"); await changed.settle();
  assert.equal(changed.requests.some(request => JSON.parse(request.init.body).action === "transition"), false);
});
