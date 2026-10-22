import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { build } from "esbuild";

// StorageNormalUse.v0.1 N0 page (§8.1 steps 1 and 3): pre-ticked options, the
// disclosure shown is exactly the one the Worker renders, the Picker token is
// drive.file-only (a superset is dropped and never revoked) and never sent to
// Clued, a missing Picker configuration fails closed, orphans and retry.
const source = readFileSync(new URL("../app/storage/onboard/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const outfile = path.join(await mkdtemp(path.join(os.tmpdir(), "clued-onboard-page-")), "disclosure.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-onboard-disclosure.ts", import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
const disclosure = await import(pathToFileURL(outfile));
const DRIVE_FILE = disclosure.DRIVE_FILE_SCOPE;

function fixture(google = {}) {
  const hooks = [], effects = [], calls = [], assigned = [], scripts = [];
  let cursor = 0, tree;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: initial }; return [hooks[i].value, v => { hooks[i].value = typeof v === "function" ? v(hooks[i].value) : v; }]; },
    useRef(initial) { const i = cursor++; hooks[i] ??= { current: initial }; return hooks[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) hooks[i] = { fn, deps }; return hooks[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { hooks[i] = { deps }; effects.push(fn); } },
  };
  const document = {
    querySelector: () => null, head: { appendChild(script) { scripts.push(script.src); queueMicrotask(() => script.onload()); } },
    createElement: () => ({}),
  };
  const window = { location: { assign(url) { assigned.push(url); } }, google: google.google, gapi: { load(_name, done) { done(); } } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, Error, Set, Promise, queueMicrotask, document, window,
    require(name) {
      if (name === "react") return React;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === "next/link") return { __esModule: true, default: "a" };
      if (name.endsWith("/supabase-browser")) return { supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: "owner" }, access_token: "native-owner" } }, error: null }) } } };
      if (name.endsWith("/worker/storage-onboard-disclosure")) return disclosure;
      throw Error(name);
    },
    fetch(url, init) { return new Promise(resolve => calls.push({ url, init, resolve })); },
  });
  const render = () => { cursor = 0; tree = exports.default(); while (effects.length) effects.shift()(); };
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); render(); };
  const text = n => Array.isArray(n) ? n.map(text).join("") : n == null || typeof n === "boolean" ? "" : typeof n === "object" ? text(n.props?.children) : String(n);
  const find = predicate => { let found; const walk = n => { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== "object") return;
    if (predicate(n)) found ??= n; walk(n.props?.children); }; walk(tree); return found; };
  const button = label => { const found = find(n => n.type === "button" && text(n).startsWith(label)); assert.ok(found, label); return found; };
  render();
  return { calls, assigned, scripts, settle, button, find, text: () => text(tree), render,
    respond(i, value, status = 200) { calls[i].resolve({ ok: status < 400, status, json: async () => value }); } };
}
const config = (extra = {}) => ({ enabled: true, allowed: true, picker: null, picker_reason: "picker_unconfigured", refresh_available: true,
  refresh_token_count: 0, attempts: [], disclosure_version: "clued.storage-onboard-disclosure/2", ...extra });
const picker = { api_key: "fixture-picker-api-key", app_id: "123456789012", client_id: "fixture.apps.googleusercontent.com" };

test("onboarding closed or outside the allowlist shows a fixed message and no confirmation button", async () => {
  const off = fixture(); await off.settle(); off.respond(0, { enabled: false, reason: "onboard_disabled" }); await off.settle();
  assert.match(off.text(), /自助接入尚未开放/); assert.equal(off.find(n => n.type === "button" && /确认并连接/.test(String(n.props.children))), undefined);
  const gated = fixture(); await gated.settle(); gated.respond(0, config({ allowed: false })); await gated.settle();
  assert.equal(gated.calls[0].url, "/v1/storage/onboard/config");
  assert.match(gated.text(), /Google 应用验证通过前，自助接入只对名单内的测试用户开放/);
  assert.equal(gated.find(n => n.type === "button" && /确认并连接/.test(String(n.props.children))), undefined);
});

test("default new root: pre-ticked options, the exact Worker disclosure, one begin and a Google redirect", async () => {
  const f = fixture(); await f.settle(); f.respond(0, config()); await f.settle();
  const choice = { root: { mode: "new", name: "Clued_资料中心" }, tracks: ["资料", "项目", "归档"], normal_use: true, default_refresh: true };
  assert.ok(f.text().includes(disclosure.renderOnboardDisclosure(choice)), "the page shows the text the Worker binds");
  assert.match(f.text(),/连接后开启全部 Agent 文件操作（默认）/);assert.match(f.text(),/完整授权后，总开关默认全开/);
  assert.match(f.text(),/查看、修改、创建和删除你 Google 云端硬盘中的所有文件/);
  assert.equal(f.find(n=>n.type==="input"&&n.props.type==="checkbox").props.checked,true);
  // Missing Picker configuration: "choose an existing folder" is disabled with the fixed reason.
  const pickedRadio = f.find(n => n.type === "input" && n.props.type === "radio" && n.props.checked === false);
  assert.equal(pickedRadio.props.disabled, true); assert.match(f.text(), /需要维护者先配置 Google Picker/);
  const confirm=f.button("确认并连接 Google Drive");confirm.props.onClick();confirm.props.onClick();await f.settle();
  assert.equal(f.calls.length,2,"duplicate confirmation dispatches only one begin");
  assert.equal(f.calls[1].url, "/v1/storage/onboard/begin");
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { ...choice, disclosure_version: "clued.storage-onboard-disclosure/2" });
  f.respond(1, { authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x", onboard_attempt_id: "a" }); await f.settle();
  assert.deepEqual(f.assigned, ["https://accounts.google.com/o/oauth2/v2/auth?client_id=x"]);
  // A refusal shows only the fixed text for its reason.
  const g = fixture(); await g.settle(); g.respond(0, config()); await g.settle();
  g.button("确认并连接 Google Drive").props.onClick(); await g.settle();
  g.respond(1, { error: "x", reason: "refresh_token_limit" }, 403); await g.settle();
  assert.match(g.text(), /授权次数已达上限/); assert.deepEqual(g.assigned, []);
});
test("leaving the onboarding choice unconfirmed sends no permission change, and explicit OFF is not silently enabled",async()=>{
  const f=fixture();await f.settle();f.respond(0,config());await f.settle();
  assert.equal(f.calls.length,1);assert.equal(f.assigned.length,0,"loading the default is not consent");
  f.find(n=>n.type==="input"&&n.props.type==="checkbox").props.onChange({target:{checked:false}});f.render();
  assert.match(f.text(),/连接完成后，总开关关闭，全部 Agent 文件操作停止/);
  assert.equal(f.calls.length,1,"changing the draft does not grant permissions");
  f.button("确认并连接 Google Drive").props.onClick();await f.settle();
  const body=JSON.parse(f.calls[1].init.body);assert.equal(body.normal_use,false);assert.equal(body.disclosure_version,"clued.storage-onboard-disclosure/2");
  f.respond(1,{status:"completed",receipt_id:"wrong-stage-receipt",master_state:"on",provider_scope_profile:"full"});await f.settle();
  assert.equal(f.assigned.length,0);assert.ok(!f.text().includes("全部 Agent 文件操作已开启"));
});

test("Picker token: a scope superset is discarded with no revoke and no Picker; exact drive.file opens the Picker and stays in the page", async () => {
  const google = (scope, picked) => {
    const state = { revokes: 0, builds: [], tokenConfig: null };
    const builder = { calls: {}, addView() { return this; }, setAppId(v) { this.calls.app = v; return this; }, setOAuthToken(v) { this.calls.token = v; return this; },
      setDeveloperKey(v) { this.calls.key = v; return this; }, setCallback(cb) { this.cb = cb; return this; },
      build() { state.builds.push(this.calls); const cb = this.cb; return { setVisible() { queueMicrotask(() => cb(picked)); } }; } };
    const view = { setSelectFolderEnabled() { return this; }, setIncludeFolders() { return this; }, setMimeTypes(v) { state.mime = v; return this; } };
    state.google = { accounts: { oauth2: { revoke() { state.revokes++; }, initTokenClient(config) { state.tokenConfig = config;
      return { requestAccessToken() { queueMicrotask(() => config.callback({ access_token: "page-only-token", scope })); } }; } } },
      picker: { DocsView: function () { return view; }, ViewId: { FOLDERS: "folders" }, PickerBuilder: function () { return builder; }, Action: { PICKED: "picked", CANCEL: "cancel" } } };
    return state;
  };
  // Superset: dropped, never revoked, no Picker.
  const wide = google(DRIVE_FILE + " https://www.googleapis.com/auth/drive.readonly");
  const f = fixture({ google: wide.google }); await f.settle(); f.respond(0, config({ picker })); await f.settle();
  f.find(n => n.type === "input" && n.props.type === "radio" && n.props.checked === false).props.onChange(); f.render();
  f.button("从 Google Drive 选择目录").props.onClick(); await f.settle(); await f.settle();
  assert.deepEqual(wide.tokenConfig.scope, DRIVE_FILE); assert.equal(wide.tokenConfig.include_granted_scopes, false);
  assert.equal(wide.revokes, 0, "no revoke request"); assert.equal(wide.builds.length, 0);
  assert.match(f.text(), /已丢弃（未撤销任何授权）/);
  assert.equal(f.calls.length, 1, "nothing reached Clued");
  // Exact: Picker with App ID, token and developer key; the folder is chosen.
  const exact = google(DRIVE_FILE, { action: "picked", docs: [{ id: "folder-1", name: "我的资料", mimeType: "application/vnd.google-apps.folder" }] });
  const g = fixture({ google: exact.google }); await g.settle(); g.respond(0, config({ picker })); await g.settle();
  g.find(n => n.type === "input" && n.props.type === "radio" && n.props.checked === false).props.onChange(); g.render();
  g.button("从 Google Drive 选择目录").props.onClick(); for (let i = 0; i < 4; i++) await g.settle();
  assert.deepEqual(exact.builds, [{ app: picker.app_id, token: "page-only-token", key: picker.api_key }]);
  assert.equal(exact.mime, "application/vnd.google-apps.folder");
  assert.match(g.text(), /已选择：我的资料/);
  g.button("确认并连接 Google Drive").props.onClick(); await g.settle();
  const body = JSON.parse(g.calls[1].init.body);
  assert.deepEqual(body.root, { mode: "picked", name: "我的资料", folder_id: "folder-1" });
  assert.equal(g.calls.some(c => String(c.init?.body).includes("page-only-token")), false, "the Picker token never leaves the page");
  assert.deepEqual(g.scripts.sort(), ["https://accounts.google.com/gsi/client", "https://apis.google.com/js/api.js"]);
  // The accept rule itself.
  assert.equal(disclosure.acceptPickerToken({ access_token: "t", scope: DRIVE_FILE }), "t");
  assert.equal(disclosure.acceptPickerToken({ access_token: "t", scope: ` ${DRIVE_FILE}  ${DRIVE_FILE} ` }), "t");
  for (const scope of [DRIVE_FILE + " openid", "openid", ""]) assert.equal(disclosure.acceptPickerToken({ access_token: "t", scope }), null);
});

test("failed attempts list their orphans; retry resumes without a new consent", async () => {
  const attempt = { onboard_attempt_id: "11111111-1111-4111-8111-111111111111", state: "failed", root: { name: "Clued_资料中心" },
    failure_code: "activation_unconfirmed", orphans: [{ role: "root", provider_file_id: "r" }, { role: "track:资料", provider_file_id: "t" }],
    expires_at: "2099-01-01T00:00:00Z", retryable: true };
  // No retry when the server says resume cannot succeed (credential dropped, or another run holds the attempt).
  const closed = fixture(); await closed.settle(); closed.respond(0, config({ attempts: [{ ...attempt, failure_code: "root_not_owned", retryable: false }] }));
  await closed.settle();
  assert.match(closed.text(), /已在 Drive 中创建但未启用/);
  assert.equal(closed.find(n => n.type === "button" && /^重试/.test(String(n.props.children))), undefined);
  const f = fixture(); await f.settle(); f.respond(0, config({ attempts: [attempt] })); await f.settle();
  assert.match(f.text(), /已在 Drive 中创建但未启用：根目录、子目录 资料/); assert.match(f.text(), /BeamingFace 不会删除它们/);
  f.button("重试").props.onClick(); await f.settle();
  assert.equal(f.calls[1].url, "/v1/storage/onboard/resume");
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { onboard_attempt_id: attempt.onboard_attempt_id });
  f.respond(1, { status: "completed", receipt_id: "r-1" }); await f.settle();
  assert.match(f.text(), /已连接「Clued_资料中心」/);
  // Unticking refresh says what happens.
  const g = fixture(); await g.settle(); g.respond(0, config({ refresh_available: false })); await g.settle();
  assert.match(g.text(), /连接约 1 小时后读写都不可用/);
});
