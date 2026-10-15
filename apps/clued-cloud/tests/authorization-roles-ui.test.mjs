// Connection management page (/oauth/connections) for preset roles and
// "我的全部项目（含以后新建的）" (PermissionSimplification.v0.1 §3.1, Task 0756c748).
// Runs the real component under a small hook harness with controlled auth and fetch.
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


const PAGE = ts.transpileModule(readFileSync(new URL('../app/oauth/connections/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function fixture(respond) {
  const hooks = [], effects = [], timers = new Map(), requests = [];
  let cursor = 0, authCallback, root, seq = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useCallback(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) hooks[i] = { callback, deps }; return hooks[i].callback; },
    useEffect(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i];
      hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); } },
  };
  const session = { user: { id: 'owner', email: 'owner@example.test' }, access_token: 'fixture-owner' };
  const auth = { onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session }, error: null }), signOut: async () => ({ error: null }) };
  const exports = {};
  vm.runInNewContext(PAGE, { exports, require(name) { const shared = authorizationImport(name); if (shared) return shared;
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => typeof type === 'function' ? type(props) : ({ type, props }), jsxs: (type, props) => typeof type === 'function' ? type(props) : ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase: { auth } };
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    if (name === './headless') return { __esModule: true, default: () => null };
    throw Error(name);
  }, AbortController, Error, TypeError, JSON, Date, Number, String, Math, Array, Object,
  window: { setTimeout(cb) { const id = ++seq; timers.set(id, cb); return id; }, clearTimeout(id) { timers.delete(id); }, confirm: () => true },
  fetch: async (url, options = {}) => { requests.push({ url, options }); const body = respond(url, options);
    if (body instanceof Response) return body;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }; } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(from); return out; }
  function text(...args) { const n = args.length ? args[0] : root; if (Array.isArray(n)) return n.map(m => text(m)).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); }
  async function open() { render(); authCallback('INITIAL_SESSION', session); render();
    const pending = [...timers.values()]; timers.clear(); pending.forEach(f => f()); await settle(); }
  return { requests, nodes, text, settle, open, render, emit(event, who) { authCallback(event, who); render(); } };
}

const A = 'project:11111111-1111-4111-8111-111111111111';
const B = 'project:22222222-2222-4222-8222-222222222222';
const DEV = ['read', 'write', 'close', 'restore'];
const scope = (resource_id, actions) => ({ resource_kind: 'scope', resource_id, environment: 'canonical', actions, effective_actions: actions });
const connection = (grants, version = 3) => ({ binding_id: 'b-1', client_id: 'chatgpt', client_name: 'ChatGPT', version,
  expires_at: '2099-01-01T00:00:00Z', active: true, grants });

test('legacy project grants retain their operations while range no longer claims all contexts', async () => {
  let listed = [connection([scope('global', ['read']), scope('project:*', DEV), scope(A, DEV), scope(B, DEV)])];
  const f = fixture((url, options) => {
    if (url === '/v1/storage/owner') return { clients: [] };
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      listed = [connection([scope('global', ['read']), scope('project:*', ['read']), scope(A, ['read']), scope(B, ['read'])], 4)];
      return { binding_id: body.binding_id, version: 4 };
    }
    return { bindings: listed };
  });
  await f.open();
  const card = f.nodes('article')[0];
  assert.ok(card, 'the connection is listed');
  const shown = f.text(card);
  assert.ok(shown.includes('自定义／受限'));
  assert.ok(shown.includes('尚不包含项目用途上下文'));
  assert.ok(shown.includes('自有项目正式记录（含未来项目）'));
  const legends = f.nodes('legend', card).map(n => f.text(n));
  assert.deepEqual(legends, ['个人记录', '自有项目正式记录（含未来项目）'], 'covered projects are not listed');
  // Untick write on project:*: the reduction sends project:* narrowed and no covered project row.
  const all = f.nodes('fieldset', card)[1];
  const write = f.nodes('input', all).find((n, i) => i === 1);
  write.props.onChange({ target: { checked: false } }); f.render();
  const save = f.nodes('button').find(n => f.text(n) === '保存减少后的权限');
  save.props.onClick(); await f.settle();
  const post = f.requests.find(r => r.options.method === 'POST' && r.url === '/oauth/connections/api');
  const sent = JSON.parse(post.options.body);
  assert.equal(sent.op, 'reduce');
  assert.deepEqual(sent.selected.map(g => [g.resource_id, g.actions]),
    [['global', ['read']], ['project:*', ['read', 'close', 'restore']]]);
  // Clued rebuilt the projects from project:*: the page accepts that as confirmed.
  assert.ok(f.text().includes('权限已减少'), f.text());
});

test('role names follow the entries; unticking 我的全部项目 shows the projects again', async () => {
  const f = fixture((url) => url === '/v1/storage/owner' ? { clients: [] } : { bindings: [
    { ...connection([scope('global', ['read']), scope('profile', ['read']), scope(A, ['read'])]), binding_id: 'r' },
    { ...connection([scope('global', ['read', 'write', 'close', 'restore', 'audit']), scope('profile', ['read', 'write', 'close', 'restore']),
      scope(A, ['read', 'write', 'close', 'restore'])]), binding_id: 'f' },
    { ...connection([scope('global', ['read', 'write']), scope('project:*', DEV), scope(A, DEV)]), binding_id: 'c' },
  ] });
  await f.open();
  const cards = f.nodes('article');
  const role = card => { const dd = f.nodes('div', card).find(n => f.text(n).startsWith('操作权限')); return f.text(dd).replace('操作权限', ''); };
  assert.deepEqual(cards.map(role), ['只读', '自定义／受限', '自定义／受限']);
  const custom = cards[2];
  assert.equal(f.nodes('legend', custom).length, 2);
  for (const box of f.nodes('input', f.nodes('fieldset', custom)[1])) box.props.onChange({ target: { checked: false } });
  f.render();
  assert.equal(f.nodes('legend', f.nodes('article')[2]).length, 3, 'with project:* unticked each project can be kept or removed');
});


test('sources_v1 reduction sends actual source identities and preserves legacy read when a new policy is removed', async()=>{
 const baseline={source_id:'source-old',version:2,kind:'legacy_effective_baseline',actions:['read'],contributions:[scope('global',['read'])]};
 const policy={source_id:'source-new',version:4,kind:'contexts_policy',actions:['read','write'],contributions:[scope('global',['read','write'])]};
 const all=scope('contexts:*',['read','write']);
 let listed=[{...connection([all,scope('global',['read','write'])]),selection_format:'sources_v1',sources:[baseline,policy],overrides:[],coverage:{status:'complete',differences:[]}}];
 const f=fixture((url,options)=>{
  if(url==='/v1/storage/owner')return {clients:[]};
  if(options.method==='POST'){listed=[{...listed[0],version:4,grants:[scope('global',['read'])],sources:[baseline],coverage:{status:'legacy',differences:[]}}];return {version:4};}
  return {bindings:listed};
 });
 await f.open();
 const source=f.nodes('fieldset').find(n=>f.text(f.nodes('legend',n)[0])==='全部上下文策略（已有和未来）');
 assert.ok(source);for(const box of f.nodes('input',source))box.props.onChange({target:{checked:false}});f.render();
 f.nodes('button').find(n=>f.text(n)==='保存减少后的权限').props.onClick();await f.settle();
 const sent=JSON.parse(f.requests.find(r=>r.url==='/oauth/connections/api'&&r.options.method==='POST').options.body);
 assert.equal(sent.selection_format,'sources_v1');assert.equal(sent.selected,undefined);
 assert.deepEqual(sent.sources,[{source_id:'source-old',base_version:2,action_cap:['read']},{source_id:'source-new',base_version:4,action_cap:[]}]);
 assert.deepEqual(sent.exceptions,[]);assert.ok(f.text().includes('权限已减少'));assert.ok(f.text().includes('只读'));
});

test('empty-source refusal explains that nothing was saved and requires rereading before explicit revoke', async () => {
  const source = { source_id: '30000000-0000-4000-8000-000000000001', version: 2, kind: 'direct', actions: ['read'], contributions: [scope('global', ['read'])] };
  let binding = { ...connection([scope('global', ['read'])]), selection_format: 'sources_v1', sources: [source], overrides: [], coverage: { status: 'complete', differences: [] } };
  const f = fixture((url, options) => {
    if (url === '/v1/storage/owner') return { clients: [] };
    if (options.method === 'POST') {
      if (JSON.parse(options.body).op === 'reduce') return Response.json({ error: 'authorization_empty_projection_requires_binding_revoke', message: 'private diagnostics must not be displayed' }, { status: 400 });
      binding = { ...binding, version: 4, active: false }; return { version: 4 };
    }
    return { bindings: [binding] };
  });
  await f.open();
  const field = f.nodes('fieldset').find(n => f.text(f.nodes('legend', n)[0]) === '独立明确授权');
  assert.ok(field);
  for (const box of f.nodes('input', field)) box.props.onChange({ target: { checked: false } });
  f.render(); f.nodes('button').find(n => f.text(n) === '保存减少后的权限').props.onClick(); await f.settle();
  assert.ok(f.text().includes('本次修改未保存'));
  assert.ok(f.text().includes('重新读取后使用“撤销此连接”'));
  assert.ok(!f.text().includes('private diagnostics'));
  assert.ok(!f.text().includes('权限已减少'));
  assert.equal(binding.version, 3); assert.equal(binding.active, true);
  assert.equal(f.nodes('button').find(n => f.text(n) === '撤销此连接').props.disabled, true);
  f.nodes('button').find(n => f.text(n) === '重新读取连接').props.onClick(); await f.settle();
  f.nodes('button').find(n => f.text(n) === '撤销此连接').props.onClick(); await f.settle();
  assert.ok(f.text().includes('连接已撤销'));
  assert.deepEqual(f.requests.filter(r => r.url === '/oauth/connections/api' && r.options.method === 'POST').map(r => JSON.parse(r.options.body).op), ['reduce', 'revoke']);
});

test('connection display puts profile before personal records while precise source payload stays unchanged', async () => {
  const rows = [scope(A, ['read']), scope('global', ['read']), scope('profile', ['read'])];
  const f = fixture(url => url === '/v1/storage/owner' ? { clients: [] } : { bindings: [connection(rows)] });
  await f.open();
  const card = f.nodes('article')[0];
  assert.deepEqual(f.nodes('legend', card).map(n => f.text(n)), ['个人资料', '个人记录', '项目正式记录']);
  assert.ok(f.text(card).includes('个人资料、个人记录、项目正式记录'));
  assert.deepEqual(rows.map(row => row.resource_id), [A, 'global', 'profile']);
});

test('stored macro with restricted coverage never displays complete authorization and exact reduction uses real override CAS',async()=>{
 const target={resource_kind:'context',resource_id:'c-test',environment:'test',name:'验收',actions:['read','write'],effective_actions:['read','write']};
 const override={override_id:'override-1',version:5,...target,denied_actions:['close'],allowed_ceiling:['read','write'],limits:{allowed_fields:['content']}};
 let binding={...connection([scope('contexts:*',['read','write']),target]),selection_format:'sources_v1',sources:[{source_id:'source-1',version:3,kind:'contexts_policy',actions:['read','write'],contributions:[target]}],overrides:[override],coverage:{status:'restricted',differences:[{resource_id:'c-test',reason:'fixed_fields'}]}};
 const f=fixture((url,options)=>{if(url==='/v1/storage/owner')return {clients:[]};if(options.method==='POST'){binding={...binding,version:4,grants:[scope('contexts:*',['read','write']),{...target,effective_actions:['read']}],overrides:[{...override,version:6,denied_actions:['close','write']}]};return {version:4};}return {bindings:[binding]};});
 await f.open();assert.ok(f.text().includes('全部上下文策略 · 自定义／受限'));
 const field=f.nodes('fieldset').find(n=>f.text(f.nodes('legend',n)[0])==='验收 · 测试环境');
 f.nodes('input',field)[1].props.onChange({target:{checked:false}});f.render();f.nodes('button').find(n=>f.text(n)==='保存减少后的权限').props.onClick();await f.settle();
 const sent=JSON.parse(f.requests.find(r=>r.url==='/oauth/connections/api'&&r.options.method==='POST').options.body);
 assert.deepEqual(sent.exceptions,[{override_id:'override-1',base_version:5,resource_kind:'context',resource_id:'c-test',environment:'test',denied_actions:['close','write'],allowed_ceiling:['read','write']}]);
 assert.ok(f.text().includes('权限已减少'));
});


test('malformed source identity/version or contribution cannot produce an actionable management card',async()=>{
 for(const source of [{source_id:'actual',version:'3',kind:'contexts_policy',actions:['read'],contributions:[]},
   {source_id:'actual',version:3,kind:'contexts_policy',actions:['read'],contributions:[{resource_kind:'context',resource_id:'context-test'}]}]){
  const f=fixture(url=>url==='/v1/storage/owner'?{clients:[]}:{bindings:[{...connection([scope('contexts:*',['read'])]),selection_format:'sources_v1',sources:[source],overrides:[],coverage:{status:'complete',differences:[]}}]});
  await f.open();assert.equal(f.nodes('article').length,0);assert.ok(!f.nodes('button').some(n=>f.text(n)==='保存减少后的权限'));
 }
});


const preciseFixture = () => {
 const grant={resource_kind:'context',resource_id:'owned-context',environment:'test',context_name:'Owner test',actions:['read'],effective_actions:['read'],
  limits:{actions:['read','write'],history_policy:'EXISTING_ONLY',version_policy:'FIXED_AT_GRANT',freeze_cursor:10,since_cursor:null,explicit_record_ids:[],allowed_fields:['title'],expires_at:'2098-01-01T00:00:00Z'},
  precise_limit_confirmation:{supported:true,authorization_version:3,grant_id:'actual-grant',grant_version:7,override_id:'actual-override',override_version:5,available_actions:['read','write','close','feedback_submit']}};
 const override={override_id:'actual-override',version:5,resource_kind:'context',resource_id:'owned-context',environment:'test',denied_actions:['write'],allowed_ceiling:['read'],limits:{}};
 const binding={...connection([grant]),selection_format:'sources_v1',sources:[{source_id:'actual-source',version:4,kind:'contexts_policy',actions:['read','write'],contributions:[grant]}],overrides:[override],coverage:{status:'restricted',differences:[]}};
 return {grant,override,binding};
};
function editPreciseFields(f){
 const field=f.nodes('section').find(n=>n.props['aria-label']==='精确上下文限制调整');
 const label=text=>f.nodes('label',field).find(n=>f.text(n).startsWith(text));
 f.nodes('input',label('允许字段'))[0].props.onChange({target:{value:'*'}});f.render();
 f.nodes('input',label('精确拒绝动作'))[0].props.onChange({target:{value:''}});f.render();
 f.nodes('input',label('动作允许上限'))[0].props.onChange({target:{value:''}});f.render();
 f.nodes('select',label('历史范围'))[0].props.onChange({target:{value:'EXISTING_AND_FUTURE'}});f.render();
 f.nodes('select',label('版本范围'))[0].props.onChange({target:{value:'LATEST'}});f.render();
}
const click=f=>text=>{const button=f.nodes('button').find(n=>f.text(n)===text);assert.ok(button,text);button.props.onClick();f.render();};

test('precise restriction widening previews real old/new identities first and only independent confirmation consumes its exact token',async()=>{
 const {binding,grant,override}=preciseFixture();let listed=[binding];let issued;
 const f=fixture((url,options)=>{
  if(url==='/v1/storage/owner')return {clients:[]};
  if(options.method==='POST'){
   const input=JSON.parse(options.body);
   if(input.op==='limit_confirmation_issue'){
    issued=input;
    return {status:'issued',token_id:'actual-token-id',confirmation_token:'actual-nonce',view_digest:'d'.repeat(64),expires_at:'2099-01-01T00:00:00Z',
      confirmation_view:{kind:'authorization_precise_limits',binding_id:'b-1',client_name:'ChatGPT',authorization_version:3,resource_kind:'context',resource_id:'owned-context',environment:'test',
       grant_id:'actual-grant',grant_version:7,override_id:'actual-override',override_version:5,old:{grant:grant.limits,override,binding_scopes:['context:read','context:write']},new:input.new,source_snapshot:{sources:[{source_id:'actual-source',version:4}]}}};
   }
   assert.equal(input.op,'limit_confirm');assert.deepEqual(input,{op:'limit_confirm',confirmation_token:'actual-nonce',view_digest:'d'.repeat(64)});
   listed=[{...binding,version:4,grants:[{...grant,limits:issued.new,effective_actions:['read','write']}],overrides:[{...override,version:6,denied_actions:[],allowed_ceiling:null}]}];
   return {status:'committed',receipt_id:'actual-receipt',binding_id:'b-1',version:4};
  }
  return {bindings:listed};
 });
 await f.open();click(f)('单独调整此上下文的精确限制');assert.equal(f.requests.filter(r=>r.options.method==='POST'&&r.url==='/oauth/connections/api').length,0);
 editPreciseFields(f);click(f)('预览精确限制变更');await f.settle();
 assert.equal(issued.binding_id,'b-1');assert.equal(issued.base_version,3);assert.equal(issued.grant_id,'actual-grant');assert.equal(issued.grant_base_version,7);
 assert.equal(issued.override_id,'actual-override');assert.equal(issued.override_base_version,5);assert.equal(issued.resource_id,'owned-context');assert.equal(issued.environment,'test');
 assert.deepEqual(issued.new.denied_actions,[]);assert.equal(issued.new.allowed_ceiling,null);assert.deepEqual(issued.new.allowed_fields,['*']);
 const preview=f.nodes('section').find(n=>n.props['aria-label']==='独立确认精确限制');assert.ok(preview);assert.ok(f.text(preview).includes('原限制'));assert.ok(f.text(preview).includes('拟调整为'));
 assert.equal(f.requests.filter(r=>r.options.method==='POST'&&r.url==='/oauth/connections/api').length,1,'preview does not commit');
 click(f)('确认此上下文的精确限制变更');await f.settle();assert.ok(f.text().includes('精确限制已确认'));assert.ok(f.text().includes('actual-receipt'));
});

test('stale grant/override snapshot or another resource in precise preview cannot produce a confirmation button',async()=>{
 for(const bad of [{grant_version:8},{override_version:6},{resource_id:'other-context'},{binding_id:'another-binding'}]){
  const {binding,grant,override}=preciseFixture();
  const f=fixture((url,options)=>url==='/v1/storage/owner'?{clients:[]}:options.method==='POST'?{
   status:'issued',token_id:'token',confirmation_token:'nonce',view_digest:'d'.repeat(64),expires_at:'2099-01-01T00:00:00Z',confirmation_view:{kind:'authorization_precise_limits',binding_id:'b-1',authorization_version:3,resource_kind:'context',resource_id:'owned-context',environment:'test',grant_id:'actual-grant',grant_version:7,override_id:'actual-override',override_version:5,old:{grant:grant.limits,override,binding_scopes:['context:read']},new:JSON.parse(options.body).new,source_snapshot:{sources:[]},...bad}}:{bindings:[binding]});
  await f.open();click(f)('单独调整此上下文的精确限制');click(f)('预览精确限制变更');await f.settle();assert.ok(f.text().includes('预览不完整'));
  assert.ok(!f.nodes('button').some(n=>f.text(n)==='确认此上下文的精确限制变更'));
 }
});

test('unsupported or incomplete precise metadata cannot clear a denial through the macro or manufacture grant identity',async()=>{
 for(const metadata of [{supported:false,reason:'scope precise grants unavailable'},{supported:true,authorization_version:3}]){
  const {binding,grant}=preciseFixture();const f=fixture(url=>url==='/v1/storage/owner'?{clients:[]}:{bindings:[{...binding,grants:[{...grant,precise_limit_confirmation:metadata}]}]});
  await f.open();const button=f.nodes('button').find(n=>f.text(n)==='单独调整此上下文的精确限制');if(button){button.props.onClick();f.render();}
  assert.ok(!f.nodes('button').some(n=>f.text(n)==='预览精确限制变更'));assert.equal(f.requests.filter(r=>r.options.method==='POST'&&r.url==='/oauth/connections/api').length,0);
 }
});


test('canonical scope denial uses its actual override CAS and four-field proposal, without a fabricated context grant',async()=>{
 const expires='2098-01-01T00:00:00Z';
 const grant={...scope('profile',[]),limits:{expires_at:expires},precise_limit_confirmation:{supported:true,authorization_version:3,grant_id:null,grant_version:null,override_id:'profile-denial',override_version:6,available_actions:['read','write'],current_expires_at:expires}};
 const override={override_id:'profile-denial',version:6,resource_kind:'scope',resource_id:'profile',environment:'canonical',denied_actions:['read','write'],allowed_ceiling:null,limits:{expires_at:expires}};
 const binding={...connection([grant]),selection_format:'sources_v1',sources:[{source_id:'actual-profile-source',version:2,kind:'contexts_policy',actions:['read','write'],contributions:[scope('profile',['read','write'])]}],overrides:[override],coverage:{status:'restricted',differences:[]}};
 let listed=[binding];let proposal;
 const f=fixture((url,options)=>{
  if(url==='/v1/storage/owner')return {clients:[]};if(options.method!=='POST')return {bindings:listed};
  const input=JSON.parse(options.body);
  if(input.op==='limit_confirmation_issue'){
   proposal=input;return {status:'issued',token_id:'scope-token',confirmation_token:'scope-nonce',view_digest:'a'.repeat(64),expires_at:'2099-01-01T00:00:00Z',confirmation_view:{kind:'authorization_precise_limits',binding_id:'b-1',authorization_version:3,resource_kind:'scope',resource_id:'profile',environment:'canonical',grant_id:null,grant_version:null,override_id:'profile-denial',override_version:6,old:{grant:null,override,binding_scopes:['context:read','context:write']},new:input.new,source_snapshot:{sources:[{source_id:'actual-profile-source',version:2}]}}};
  }
  assert.deepEqual(input,{op:'limit_confirm',confirmation_token:'scope-nonce',view_digest:'a'.repeat(64)});
  listed=[{...binding,version:4,grants:[{...grant,actions:['read'],effective_actions:['read']}],overrides:[{...override,version:7,denied_actions:[],allowed_ceiling:null}]}];return {status:'committed',receipt_id:'scope-receipt',binding_id:'b-1',version:4};
 });
 await f.open();click(f)('单独调整此范围的精确限制');
 const form=f.nodes('section').find(n=>n.props['aria-label']==='精确上下文限制调整');
 assert.ok(!f.text(form).includes('历史范围'));assert.ok(!f.text(form).includes('允许字段'));assert.ok(!f.text(form).includes('固定位置'));
 const read=f.nodes('label',form).find(n=>f.text(n)==='读取');f.nodes('input',read)[0].props.onChange({target:{checked:true}});f.render();
 const denied=f.nodes('label',form).find(n=>f.text(n).startsWith('精确拒绝动作'));f.nodes('input',denied)[0].props.onChange({target:{value:''}});f.render();
 click(f)('预览精确限制变更');await f.settle();
 assert.equal(proposal.resource_kind,'scope');assert.equal(proposal.resource_id,'profile');assert.equal(proposal.grant_id,null);assert.equal(proposal.grant_base_version,null);
 assert.equal(proposal.override_id,'profile-denial');assert.equal(proposal.override_base_version,6);
 assert.deepEqual(Object.keys(proposal.new).sort(),['actions','allowed_ceiling','denied_actions','expires_at']);
 click(f)('确认此上下文的精确限制变更');await f.settle();assert.ok(f.text().includes('scope-receipt'));
});

test('uncertain precise commit recovers with the same nonce/digest and never opens a replacement preview',async()=>{
 const {binding,grant,override}=preciseFixture();let listed=[binding],attempts=0;let issued;
 const f=fixture((url,options)=>{
  if(url==='/v1/storage/owner')return {clients:[]};if(options.method!=='POST')return {bindings:listed};const input=JSON.parse(options.body);
  if(input.op==='limit_confirmation_issue'){issued=input;return {status:'issued',token_id:'token',confirmation_token:'original-nonce',view_digest:'e'.repeat(64),expires_at:'2099-01-01T00:00:00Z',confirmation_view:{kind:'authorization_precise_limits',binding_id:'b-1',authorization_version:3,resource_kind:'context',resource_id:'owned-context',environment:'test',grant_id:'actual-grant',grant_version:7,override_id:'actual-override',override_version:5,old:{grant:grant.limits,override,binding_scopes:['context:read']},new:input.new,source_snapshot:{sources:[]}}};}
  assert.deepEqual(input,{op:'limit_confirm',confirmation_token:'original-nonce',view_digest:'e'.repeat(64)});++attempts;
  if(attempts===1)throw new TypeError('lost response');listed=[{...binding,version:4,grants:[{...grant,limits:issued.new}]}];return {status:'committed',replayed:true,receipt_id:'original-receipt',binding_id:'b-1',version:4};
 });
 await f.open();click(f)('单独调整此上下文的精确限制');click(f)('预览精确限制变更');await f.settle();click(f)('确认此上下文的精确限制变更');await f.settle();
 assert.ok(f.text().includes('确认结果尚未核实'));click(f)('核对原精确限制确认');await f.settle();assert.ok(f.text().includes('original-receipt'));
 const posts=f.requests.filter(r=>r.url==='/oauth/connections/api'&&r.options.method==='POST').map(r=>JSON.parse(r.options.body));
 assert.deepEqual(posts.map(p=>p.op),['limit_confirmation_issue','limit_confirm','limit_confirm']);assert.deepEqual(posts[1],posts[2]);
});

test('account change discards a late precise preview and no old-account grant confirmation becomes actionable',async()=>{
 const {binding,grant,override}=preciseFixture();let resolvePreview;let savedInput;
 const delayed=new Promise(resolve=>{resolvePreview=resolve;});
 const f=fixture((url,options)=>url==='/v1/storage/owner'?{clients:[]}:options.method==='POST'?(savedInput=JSON.parse(options.body),delayed):{bindings:[binding]});
 await f.open();click(f)('单独调整此上下文的精确限制');click(f)('预览精确限制变更');await f.settle();
 f.emit('SIGNED_IN',{user:{id:'different-owner',email:'other@example.test'},access_token:'fixture-other'});
 resolvePreview({status:'issued',token_id:'old-token',confirmation_token:'old-nonce',view_digest:'e'.repeat(64),expires_at:'2099-01-01T00:00:00Z',confirmation_view:{kind:'authorization_precise_limits',binding_id:'b-1',authorization_version:3,resource_kind:'context',resource_id:'owned-context',environment:'test',grant_id:'actual-grant',grant_version:7,override_id:'actual-override',override_version:5,old:{grant:grant.limits,override,binding_scopes:['context:read']},new:savedInput.new,source_snapshot:{sources:[]}}});await f.settle();
 assert.ok(!f.nodes('button').some(n=>f.text(n)==='确认此上下文的精确限制变更'));assert.ok(!f.text().includes('Owner test'));
 assert.equal(f.requests.filter(r=>r.url==='/oauth/connections/api'&&r.options.method==='POST').length,1);
});
