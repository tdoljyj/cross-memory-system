// Headless Binding section of /oauth/connections (Task 364212a1, Owner
// Decision 6e0371e3) under controlled hooks/auth/RPC; no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
const AUTH_SOURCE = ts.transpileModule(readFileSync(new URL('../lib/context-authorization.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const CONTROLS_SOURCE = ts.transpileModule(readFileSync(new URL('../lib/context-authorization-controls.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const authExports = {}; vm.runInNewContext(AUTH_SOURCE, { exports: authExports });
function authorizationImport(name) {
  if (name.endsWith('/context-authorization')) return authExports;
  if (name.endsWith('/context-authorization-controls')) { const exports = {};
    vm.runInNewContext(CONTROLS_SOURCE, { exports, require(id) { if (id === './context-authorization') return authExports;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }; throw Error(id); } }); return exports;
  }
  return null;
}


const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const COMPONENT = compile('../app/oauth/connections/headless.tsx');

function fixture({ confirmAnswer = true } = {}) {
  const hooks = [], effects = [], calls = [], fetches = [], copied = [], dialogs = [];
  let cursor = 0, authCallback, root;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useEffect(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i];
      hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); } },
  };
  const auth = { onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() { authCallback = null; } } } }; } };
  const supabase = { auth, rpc(name, args) { let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); calls.push({ name, args, resolve, reject }); return promise; } };
  const exports = {};
  vm.runInNewContext(COMPONENT, { exports, require(name) { const shared = authorizationImport(name); if (shared) return shared;
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => typeof type === 'function' ? type(props) : ({ type, props }), jsxs: (type, props) => typeof type === 'function' ? type(props) : ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    throw Error(name);
  }, Error, Date, Number, String, Math, Array, JSON, Object,
  window: { location: { origin: 'https://clued.test' }, confirm: message => { dialogs.push(message); return confirmAnswer; } },
  navigator: { clipboard: { writeText: async value => { copied.push(value); } } },
  fetch(url) { fetches.push(url); return new Promise(() => {}); } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(from); return out; }
  function text(n) { if (arguments.length === 0) n = root; if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); }
  function emit(e, s) { authCallback(e, s); render(); }
  function button(t, from) { const n = nodes('button', from).find(n => text(n) === t); assert.ok(n, t); return n; }
  render();
  return { calls, fetches, copied, dialogs, render, nodes, text, settle, emit, button, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const plain = value => JSON.parse(JSON.stringify(value));
const ELIGIBLE = [
  { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', name: 'Personal memory', actions: ['read', 'write', 'close', 'restore', 'audit'] },
  { resource_kind: 'scope', resource_id: 'project:p1', environment: 'canonical', name: 'Alpha', actions: ['read', 'write', 'close', 'restore', 'audit'] },
];
const ROWS = [
  { binding_id: 'b-head', agent_name: 'CI reader', vendor: 'Headless', kind: 'headless', expires_at: '2099-01-01T00:00:00Z',
    version: 2, roles: [], grants: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }] },
  { binding_id: 'b-legacy', agent_name: 'clued-work-admission', vendor: 'GitHub Actions', kind: 'legacy', expires_at: null,
    version: null, roles: ['ci-admission'], grants: null },
];
const listed = (rows = ROWS) => ({ data: { status: 'ok', eligible: ELIGIBLE, bindings: rows }, error: null });

async function open(f, rows) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_headless_binding_list_v1', { p_input: {} }]);
  f.calls[0].resolve(listed(rows)); await f.settle();
}
const checkbox = (f, resource, action) => {
  const field = f.nodes('fieldset').find(n => n.props.children && f.text(n.props.children[0]) === resource);
  assert.ok(field, resource);
  const label = f.nodes('label', field).find(n => f.text(n) === action);
  assert.ok(label, action);
  return f.nodes('input', label)[0];
};

test('signed out: renders nothing and makes no call', async t => {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.render(), null);
});

test('issuing is two steps and the token is shown once', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await open(f);
  assert.ok(f.text().includes('CI reader'));
  assert.ok(f.text().includes('旧方式创建'));
  assert.ok(!f.text().includes('全部权限、无有效期'));
  assert.ok(f.text().includes('CI 准入'));
  assert.ok(f.button('预览').props.disabled, 'nothing chosen yet');
  f.nodes('input').find(n => n.props.maxLength === 80).props.onChange({ target: { value: '  Nightly script ' } });
  f.nodes('select')[0].props.onChange({ target: { value: '90' } });
  f.render();
  checkbox(f, '个人记录', '读取').props.onChange({ target: { checked: true } });
  f.render();
  checkbox(f, 'Alpha', '新增和修改').props.onChange({ target: { checked: true } });
  f.render();
  f.button('预览').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_headless_binding_confirmation_issue_v1', { p_input: {
    label: 'Nightly script', days: 90, selected: [
      { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] },
      { resource_kind: 'scope', resource_id: 'project:p1', environment: 'canonical', actions: ['write'] }] } }]);
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_hbc_a', view_digest: 'd'.repeat(64),
    confirmation_view: { kind: 'headless_binding_issue', label: 'Nightly script', days: 90, replaces: null,
      scopes: ['context:read', 'context:write'], selected: [
        { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', name: 'Personal memory', actions: ['read'] },
        { resource_kind: 'scope', resource_id: 'project:p1', environment: 'canonical', name: 'Alpha', actions: ['write'] }] } }, error: null });
  await f.settle();
  const panel = f.nodes('section').find(n => n.props['aria-label'] === '确认签发');
  assert.ok(f.text(panel).includes('签发后 90 天'));
  assert.ok(f.text(panel).includes('个人记录：读取；Alpha：新增和修改'));
  assert.ok(f.nodes('button').filter(n => ['轮换为新令牌', '撤销'].includes(f.text(n))).every(n => n.props.disabled),
    'nothing else starts while a confirmation waits');
  f.button('确认签发', panel).props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]), ['clued_headless_binding_issue_v1',
    { p_input: { confirmation_token: 'clued_hbc_a', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', binding_id: 'b-new', token: 'clued_bnd_' + 'x'.repeat(43),
    expires_at: '2099-04-01T00:00:00Z', replaced: null }, error: null });
  await f.settle();
  assert.equal(f.calls[3].name, 'clued_headless_binding_list_v1', 'the list is read again');
  f.calls[3].resolve(listed()); await f.settle();
  const shown = f.nodes('div').find(n => n.props['aria-label'] === '新令牌');
  assert.ok(f.text(shown).includes('只显示这一次'));
  assert.ok(f.text(shown).includes('clued_bnd_' + 'x'.repeat(43)));
  f.button('复制令牌', shown).props.onClick(); await f.settle();
  assert.deepEqual(f.copied, ['clued_bnd_' + 'x'.repeat(43)]);
  f.button('我已保存，关闭', shown).props.onClick(); f.render();
  assert.ok(!f.text().includes('clued_bnd_'), 'the token is gone once closed');
  assert.equal(f.fetches.length, 0, 'the section never goes through a Worker route');
});

test('rotating the legacy CI Binding names it and shows the moving role', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await open(f);
  const legacy = f.nodes('article').find(n => f.text(n).includes('clued-work-admission'));
  assert.deepEqual(f.nodes('button', legacy).map(n => f.text(n)), ['轮换为新令牌', '撤销']);
  // Before rotating, the issue form sits above the list, not after it.
  const inOrder = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return;
    if (n.type === 'div' || n.type === 'article') inOrder.push(n); visit(n.props?.children); })(f.nodes('section')[0]);
  const formAt = inOrder.findIndex(n => n.props['aria-label'] === '签发表单');
  assert.ok(formAt >= 0 && formAt < inOrder.findIndex(n => n.type === 'article'), 'issue form before the first card');
  f.button('轮换为新令牌', legacy).props.onClick(); f.render();
  assert.ok(f.text().includes('轮换「clued-work-admission」'));
  // The rotation form opens inside the card that was clicked, which no longer offers the button.
  const rotating = f.nodes('article').find(n => f.text(n).includes('clued-work-admission'));
  assert.ok(f.nodes('div', rotating).some(n => n.props['aria-label'] === '轮换表单'), 'form inside the clicked card');
  assert.ok(!f.nodes('button', rotating).some(n => f.text(n) === '轮换为新令牌'));
  assert.equal(f.nodes('div').filter(n => n.props['aria-label'] === '签发表单').length, 0, 'no second form at the top');
  checkbox(f, '个人记录', '读取').props.onChange({ target: { checked: true } }); f.render();
  f.button('预览').props.onClick();
  assert.deepEqual(plain(f.calls[1].args.p_input), { label: 'clued-work-admission', days: 30, replaces_binding_id: 'b-legacy',
    selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }] });
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_hbc_b', view_digest: 'e'.repeat(64),
    confirmation_view: { label: 'clued-work-admission', days: 30, selected: [], replaces: { binding_id: 'b-legacy',
      agent_name: 'clued-work-admission', roles: ['ci-admission'], grace_minutes: 60 } } }, error: null });
  await f.settle();
  const panel = f.nodes('section').find(n => n.props['aria-label'] === '确认签发');
  assert.ok(f.text(panel).includes('签发后 60 分钟失效'));
  assert.ok(f.text(panel).includes('角色 CI 准入 移到新令牌'));
  f.button('取消', panel).props.onClick(); f.render();
  assert.equal(f.nodes('section').find(n => n.props['aria-label'] === '确认签发'), undefined);
  assert.equal(f.calls.length, 2, 'backing out makes no call');
});

test('rotating a headless Binding starts from its current grants; revoking uses the connection management RPC', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await open(f);
  const head = f.nodes('article').find(n => f.text(n).includes('CI reader'));
  f.button('轮换为新令牌', head).props.onClick(); f.render();
  assert.equal(checkbox(f, '个人记录', '读取').props.checked, true);
  assert.equal(checkbox(f, '个人记录', '新增和修改').props.checked, false);
  f.button('改为签发新令牌').props.onClick(); f.render();
  assert.equal(checkbox(f, '个人记录', '读取').props.checked, false);
  f.button('撤销', head).props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_authorization_manage_v12',
    { p_input: { op: 'revoke', binding_id: 'b-head', base_version: 2 } }]);
  f.calls[1].resolve({ data: { binding_id: 'b-head', version: 3, revoked_at: '2026-10-04T00:00:00Z' }, error: null });
  await f.settle();
  assert.equal(f.calls[2].name, 'clued_headless_binding_list_v1');
  f.calls[2].resolve(listed([ROWS[1]])); await f.settle();
  assert.ok(f.text().includes('已撤销「CI reader」'));
});

test('a replaced Binding shows when it retires, cannot be rotated again, and can be revoked early', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await open(f, [{ ...ROWS[1], expires_at: '2099-01-01T01:00:00Z', replaced_by: 'b-new', roles: [] }]);
  const legacy = f.nodes('article')[0];
  assert.ok(f.text(legacy).includes('已被替换'));
  assert.deepEqual(f.nodes('button', legacy).map(n => f.text(n)), ['撤销']);
});

test('revoking a legacy Binding uses its own RPC and warns about its roles', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await open(f);
  const legacy = f.nodes('article').find(n => f.text(n).includes('clued-work-admission'));
  f.button('撤销', legacy).props.onClick();
  assert.equal(f.dialogs.length, 1);
  assert.ok(f.dialogs[0].includes('撤销「clued-work-admission」'));
  assert.ok(f.dialogs[0].includes('专用角色 CI 准入'), f.dialogs[0]);
  // Re-review 4, M1: the role stays locked after the revoke.
  assert.ok(f.dialogs[0].includes('仍然锁定'), f.dialogs[0]);
  assert.ok(!f.dialogs[0].includes('一起结束'), f.dialogs[0]);
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_headless_binding_revoke_v1',
    { p_input: { binding_id: 'b-legacy' } }]);
  f.calls[1].resolve({ data: { status: 'committed', binding_id: 'b-legacy', roles_kept: ['ci-admission'] }, error: null });
  await f.settle();
  assert.equal(f.calls[2].name, 'clued_headless_binding_list_v1');
  f.calls[2].resolve(listed([ROWS[0]])); await f.settle();
  assert.ok(f.text().includes('已撤销「clued-work-admission」'));
  assert.equal(f.nodes('article').length, 1);
  assert.equal(f.fetches.length, 0, 'no Worker route');
});

test('a legacy revoke that Clued refuses is shown in plain words', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await open(f);
  const legacy = f.nodes('article').find(n => f.text(n).includes('clued-work-admission'));
  f.button('撤销', legacy).props.onClick();
  f.calls[1].resolve({ data: null, error: { message: 'headless_binding_revoke_target_invalid', code: '22023' } }); await f.settle();
  assert.ok(f.text().includes('这个令牌已撤销或不能在这里撤销'));
});

test('declining the revoke dialog makes no call', async t => {
  const f = fixture({ confirmAnswer: false }); t.after(() => f.unmount());
  await open(f);
  f.button('撤销').props.onClick();
  assert.equal(f.calls.length, 1);
});

test('a refusal is shown in plain words', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await open(f);
  f.nodes('input').find(n => n.props.maxLength === 80).props.onChange({ target: { value: 'x' } });
  checkbox(f, '个人记录', '查看审计回执').props.onChange({ target: { checked: true } }); f.render();
  f.button('预览').props.onClick();
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'headless_binding_role_scope_missing' }, error: null }); await f.settle();
  assert.ok(f.text().includes('新令牌需要保留对应权限'));
  f.button('预览').props.onClick();
  f.calls[2].resolve({ data: null, error: { message: 'direct_human_session_required', code: '42501' } }); await f.settle();
  assert.ok(f.text().includes('需要你本人直接登录 BeamingFace'));
});

test('a role Binding names its GitHub secret, and a rotation says which secret to update', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await open(f);
  const legacy = f.nodes('article').find(n => f.text(n).includes('clued-work-admission'));
  assert.ok(f.text(legacy).includes('GitHub 环境 clued-admission 的 secret CLUED_ADMISSION_CLUED_TOKEN'));
  const plainCard = f.nodes('article').find(n => f.text(n).includes('CI reader'));
  assert.ok(!f.text(plainCard).includes('令牌存放在'), 'a Binding without a role names no secret');
  f.button('轮换为新令牌', legacy).props.onClick(); f.render();
  checkbox(f, '个人记录', '读取').props.onChange({ target: { checked: true } }); f.render();
  f.button('预览').props.onClick();
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_hbc_r', view_digest: 'r'.repeat(64),
    confirmation_view: { label: 'clued-work-admission', days: 30, selected: [], replaces: { binding_id: 'b-legacy',
      agent_name: 'clued-work-admission', roles: ['ci-admission'], grace_minutes: 60 } } }, error: null });
  await f.settle();
  f.button('确认签发', f.nodes('section').find(n => n.props['aria-label'] === '确认签发')).props.onClick();
  f.calls[2].resolve({ data: { status: 'committed', binding_id: 'b-new', token: 'clued_bnd_' + 'y'.repeat(43),
    expires_at: '2099-04-01T00:00:00Z', replaced: { binding_id: 'b-legacy', expires_at: '2099-01-01T01:00:00Z',
      roles_moved: ['ci-admission'] } }, error: null });
  await f.settle();
  f.calls[3].resolve(listed()); await f.settle();
  const shown = f.nodes('div').find(n => n.props['aria-label'] === '新令牌');
  const alert = f.nodes('p', shown).find(n => n.props.role === 'alert');
  assert.ok(alert, 'the update reminder stands out');
  assert.ok(f.text(alert).includes('CLUED_ADMISSION_CLUED_TOKEN'));
  assert.ok(f.text(alert).includes('旧令牌'));
});


test('new issuance with all-context capability preselects only the macro and a range change clears exact choices',async t=>{
 const f=fixture();t.after(()=>f.unmount());f.emit('INITIAL_SESSION',session('owner'));
 const macro={resource_kind:'scope',resource_id:'contexts:*',environment:'canonical',actions:['read','write','close','restore','audit','feedback_submit']};
 f.calls[0].resolve({data:{status:'ok',eligible:[macro,...ELIGIBLE],bindings:[]},error:null});await f.settle();
 assert.equal(f.calls.length,1,'no consent at load');
 f.nodes('input').find(n=>n.props.maxLength===80).props.onChange({target:{value:'Own context client'}});f.render();
 f.button('预览').props.onClick();await f.settle();
 assert.deepEqual(plain(f.calls[1].args.p_input.selected),[macro]);
 f.calls[1].resolve({data:{status:'rejected',error_code:'confirmation_view_stale'},error:null});await f.settle();
 const specified=f.nodes('input').find(n=>n.props.type==='radio'&&!n.props.checked);specified.props.onChange();f.render();
 assert.equal(f.button('预览').props.disabled,true);
});


test('source-aware rotation binds real source/override versions, sends no derived direct selections and rejects a missing snapshot',async t=>{
 const f=fixture();t.after(()=>f.unmount());
 const source={source_id:'source-actual',version:7,kind:'contexts_policy',actions:['read'],contributions:[]};
 const override={override_id:'override-actual',version:4,denied_actions:['write'],allowed_ceiling:['read']};
 await open(f,[{...ROWS[0],selection_format:'sources_v1',sources:[source],overrides:[override]}]);
 f.button('轮换为新令牌').props.onClick();f.render();
 const before=f.calls.length;f.button('预览').props.onClick();await f.settle();
 assert.deepEqual(plain(f.calls[before].args.p_input),{label:'CI reader',days:30,selected:[],replaces_binding_id:'b-head',selection_format:'sources_v1',
  sources:[{source_id:'source-actual',base_version:7,action_cap:['read']}],exceptions:[{override_id:'override-actual',base_version:4}]});
 f.calls[before].resolve({data:{status:'issued',confirmation_token:'once',view_digest:'d'.repeat(64),confirmation_view:{label:'CI reader',days:30,selected:[]}},error:null});await f.settle();
 assert.ok(f.text().includes('预览不完整'));assert.ok(!f.nodes('button').some(n=>f.text(n)==='确认签发'));
 f.button('预览').props.onClick();await f.settle();
 f.calls[before+1].resolve({data:{status:'issued',confirmation_token:'once-valid',view_digest:'e'.repeat(64),confirmation_view:{label:'CI reader',days:30,selected:ROWS[0].grants,
  source_snapshot:{binding_version:2,sources:[{source_id:'source-actual',version:7,kind:'contexts_policy',actions:['read'],expires_at:null,revoked_at:null}],exceptions:[{override_id:'override-actual',version:4}],grant_limits:[]}}},error:null});await f.settle();
 assert.ok(f.text().includes('保留的来源与限制版本'));f.button('确认签发').props.onClick();assert.equal(f.calls.at(-1).name,'clued_headless_binding_issue_v1');
});


test('raw legacy read scope is displayed without inferring full permission or all-context resource coverage',async t=>{
 const f=fixture();t.after(()=>f.unmount());await open(f,[{...ROWS[1],scopes:['context:read'],active:true}]);
 const card=f.nodes('article')[0];const text=f.text(card);
 assert.ok(text.includes('客户端操作范围读取内容'));assert.ok(!text.includes('新增和修改内容'));assert.ok(!text.includes('全部权限'));
 assert.ok(text.includes('授权明细未提供，不能推断为全部上下文'));assert.ok(text.includes('有效期至未提供，尚未确认'));
 f.button('轮换为新令牌',card).props.onClick();f.render();assert.equal(f.button('预览').props.disabled,true);
 assert.equal(f.calls.length,1,'opening rotation does not issue or implicitly select broader resources');
});

test('retired legacy Binding displays the actual retirement time and cannot be rotated again',async t=>{
 const f=fixture();t.after(()=>f.unmount());const expires='2020-01-01T00:00:00Z';
 await open(f,[{...ROWS[1],scopes:['context:read'],expires_at:expires,replaced_by:'replacement-binding',active:false}]);
 const card=f.nodes('article')[0];assert.ok(f.text(card).includes(new Date(expires).toLocaleString('zh-CN')));assert.ok(f.text(card).includes('已被替换'));
 assert.ok(!f.text(card).includes('无有效期'));assert.ok(!f.nodes('button',card).some(button=>f.text(button)==='轮换为新令牌'));
});

test('missing or malformed raw scopes stay unknown; expired legacy Binding has no actionable rotation',async t=>{
 for(const fields of [{},{scopes:'context:read'},{scopes:[null]},{scopes:['context:read'],expires_at:'2020-01-01T00:00:00Z'}]){
  const f=fixture();t.after(()=>f.unmount());await open(f,[{...ROWS[1],...fields}]);const card=f.nodes('article')[0];
  assert.ok(!f.text(card).includes('全部权限'));assert.ok(!f.text(card).includes('无有效期'));
  if(fields.expires_at){assert.ok(f.text(card).includes('已过期'));assert.equal(f.button('轮换为新令牌',card).props.disabled,true);}
  else assert.ok(f.text(card).includes('客户端操作范围未提供，尚未确认'));
 }
});
