// Executes the real source component with a small hook harness and controlled auth/network.
// This is deterministic UI logic coverage, not a React browser or live OAuth acceptance test.
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


function compile(relative) {
  return ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}
const consentSource = compile('../app/oauth/consent/delegated-consent.tsx');
const accountSource = compile('../app/oauth/account/page.tsx');
function fixture(compiled = consentSource, extraAuth = {}) {
 const hooks=[],effects=[],timers=new Map(),requests=[],navigations=[];let cursor=0,authCallback,root,seq=0;
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const React={
  useState(initial){const i=cursor++;hooks[i]??={value:typeof initial==='function'?initial():initial};return [hooks[i].value,value=>{hooks[i].value=typeof value==='function'?value(hooks[i].value):value;}];},
  useRef(value){const i=cursor++;hooks[i]??={current:value};return hooks[i];},
  useCallback(callback,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps))hooks[i]={callback,deps};return hooks[i].callback;},
  useEffect(callback,deps){const i=cursor++;if(!hooks[i]||!equal(hooks[i].deps,deps)){const old=hooks[i];hooks[i]={deps};effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=callback();});}},
 };
 const auth={onAuthStateChange(cb){authCallback=cb;return {data:{subscription:{unsubscribe(){authCallback=null;}}}};},signInWithPassword:async()=>({error:null}), ...extraAuth,signOut:async()=>{authCallback?.('SIGNED_OUT',null);return {error:null};}};
 const exports={};
 vm.runInNewContext(compiled,{exports,require(name){const shared=authorizationImport(name);if(shared)return shared;
  if(name==='react')return React;
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>typeof type==='function'?type(props):({type,props}),jsxs:(type,props)=>typeof type==='function'?type(props):({type,props}),Fragment:'fragment'};
  if(name.endsWith('/supabase-browser'))return {supabase:{auth},restoreBrowserSession:async()=>({session:null,error:null,authType:null})};
  if(name==='next/link')return {__esModule:true,default:'a'};throw Error(name);
 },AbortController,Error,TypeError,encodeURIComponent,URL,window:{setTimeout(cb){const id=++seq;timers.set(id,cb);return id;},clearTimeout(id){timers.delete(id);},location:{origin:'https://clued.example.test',assign(url){navigations.push(url);}}},
 fetch(url,options){let resolve;const promise=new Promise(a=>resolve=a);requests.push({url,options,resolve});return promise;}});
 function render(){cursor=0;root=exports.default({requestId:'a'.repeat(64)});while(effects.length)effects.shift()();return root;}
 function nodes(type,from=root){const out=[];function visit(n){if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=='object')return;if(n.type===type)out.push(n);visit(n.props?.children);}visit(from);return out;}
 function text(n){if(arguments.length===0)n=root;if(Array.isArray(n))return n.map(text).join('');if(n==null||typeof n==='boolean')return '';return typeof n==='object'?text(n.props?.children ?? null):String(n);}
 async function settle(){for(let i=0;i<8;i++)await Promise.resolve();render();}
 const respond=(i,data)=>requests[i].resolve({ok:true,json:async()=>data});
 function emit(e,s){authCallback(e,s);render();}
 function runTimers(){const c=[...timers.values()];timers.clear();c.forEach(f=>f());render();}
 function button(t){const n=nodes('button').find(n=>text(n)===t);assert.ok(n,t);return n;}
 render();return {requests,navigations,render,nodes,text,respond,settle,emit,runTimers,button,unmount:()=>hooks.forEach(h=>h?.cleanup?.())};
}

const session = id => ({ user: { id, email: `${id}@example.test` }, access_token: `fixture-${id}` });
const details = id => ({ request_id: `request-${id}`, version: 1, client_name: 'Fixture client', client_id: 'fixture-client',
  requested_scopes: ['context:read'], eligible: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }],
  user: { id, email: `${id}@example.test` } });
const checkbox = f => f.nodes('input').find(node => node.props.type === 'checkbox' && node.props.className !== 'oauth-group-checkbox');
async function ready(t, id = 'A') {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session(id)); f.runTimers(); f.respond(0, details(id)); await f.settle();
  checkbox(f).props.onChange({ target: { checked: true } }); f.render(); return f;
}

test('without an all-context policy consent starts empty and preserves lifetime choices', async t => {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('A')); f.runTimers();
  f.respond(0, { ...details('A'), requested_scopes: ['context:read','context:write'], eligible: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write', 'close'] }] }); await f.settle();
  const boxes = f.nodes('input', f.nodes('details')[0]).filter(node => node.props.type === 'checkbox' && node.props.className !== 'oauth-group-checkbox');
  assert.deepEqual(boxes.map(node => node.props.checked), [false, false, false]);
  assert.equal(f.button('允许所选权限').props.disabled, true);
  // Re-ticking an already selected action must not duplicate it.
  boxes[0].props.onChange({ target: { checked: true } }); f.render();
  assert.ok(f.text().replaceAll(' ', '').includes('已选1/3'));
  const select = f.nodes('select')[0];
  assert.equal(select.props.value, 30);
  assert.deepEqual(f.nodes('option', select).map(node => node.props.value), [1, 7, 30, 90, 365]);
  select.props.onChange({ target: { value: '365' } }); f.render();
  f.button('允许所选权限').props.onClick(); await f.settle();
  const decision = JSON.parse(f.requests[1].options.body);
  assert.equal(decision.days, 365);
  assert.deepEqual(decision.selected, [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }]);
});

test('late account A GET cannot overwrite B identity or selected permissions', async t => {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('A')); f.runTimers();
  f.emit('SIGNED_IN', session('B')); f.runTimers();
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.respond(1, details('B')); await f.settle();
  checkbox(f).props.onChange({ target: { checked: true } }); f.render();
  // Resolve despite AbortSignal: stale-result checks must also protect uncancellable responses.
  f.respond(0, details('A')); await f.settle();
  assert.ok(!f.text().includes('A@example.test'));
  assert.ok(f.text().includes('B@example.test'));
  assert.equal(checkbox(f).props.checked, true);
});

test('same-account refresh preserves choice, uses fresh token, then account change blocks late POST redirect', async t => {
  const f = await ready(t);
  f.emit('TOKEN_REFRESHED', { ...session('A'), access_token: 'fixture-refreshed-A' });
  assert.equal(checkbox(f).props.checked, true);
  f.button('允许所选权限').props.onClick(); await f.settle();
  assert.equal(f.requests[1].options.headers.Authorization, 'Bearer fixture-refreshed-A');
  f.emit('SIGNED_IN', session('B')); f.runTimers();
  assert.equal(f.requests[1].options.signal.aborted, true);
  f.respond(1, { redirect_url: 'https://client.example.test/callback?code=old' }); await f.settle();
  assert.equal(f.navigations.length, 0); assert.equal(checkbox(f), undefined);
});

test('mismatched stable subject cannot display or approve resources', async t => {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('A')); f.runTimers();
  f.respond(0, details('B')); await f.settle();
  assert.ok(f.text().includes('授权请求与当前账户不匹配'));
  assert.equal(checkbox(f), undefined);
  assert.equal(f.nodes('button').some(node => f.text(node) === '允许所选权限'), false);
});

test('explicit account switch clears state and aborts an in-flight decision', async t => {
  const f = await ready(t);
  f.button('允许所选权限').props.onClick(); await f.settle();
  await f.button('切换账户').props.onClick(); await f.settle();
  assert.equal(f.requests[1].options.signal.aborted, true);
  f.respond(1, { redirect_url: 'https://client.example.test/callback?code=old' }); await f.settle();
  assert.equal(f.navigations.length, 0); assert.equal(checkbox(f), undefined);
  assert.ok(!f.text().includes('A@example.test'));
});

test('unmounted consent ignores an old denial response', async t => {
  const f = await ready(t);
  f.button('取消').props.onClick(); await f.settle(); f.unmount();
  f.respond(1, { redirect_url: 'https://client.example.test/callback?error=access_denied' }); await f.settle();
  assert.equal(f.navigations.length, 0);
});

function recoveryFixture(t) {
  const calls = [];
  const f = fixture(accountSource, { resetPasswordForEmail(email, options) {
    let resolve, reject; const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ email, options, resolve, reject }); return pending;
  } });
  t.after(() => f.unmount());
  f.nodes('input')[0].props.onChange({ target: { value: ' person@example.test ' } }); f.render();
  const submit = () => f.nodes('form')[0].props.onSubmit({ preventDefault() {} });
  return { f, calls, submit };
}

test('password recovery uses existing home callback, prevents duplicate requests, and avoids account enumeration', async t => {
  const { f, calls, submit } = recoveryFixture(t);
  const first = submit(); const second = submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].email, 'person@example.test');
  assert.equal(calls[0].options.redirectTo, 'https://clued.example.test/?type=recovery');
  calls[0].resolve({ error: null }); await Promise.all([first, second]); await f.settle();
  assert.ok(f.text().includes('如果该邮箱可以恢复账户'));
  assert.equal(f.requests.length, 0); // No live fetch or protected-data read occurred.
});

test('password recovery rate-limit failure does not claim an email was sent', async t => {
  const { f, calls, submit } = recoveryFixture(t);
  const request = submit(); calls[0].resolve({ error: { status: 429 } }); await request; await f.settle();
  assert.ok(f.text().includes('请求过于频繁'));
  assert.ok(!f.text().includes('你会收到密码重置链接'));
  assert.equal(f.button('发送重置链接').props.disabled, false);
});

test('unknown password recovery result remains unknown and permits an explicit retry', async t => {
  const { f, calls, submit } = recoveryFixture(t);
  const request = submit(); calls[0].reject(new TypeError('fixture network outage')); await request; await f.settle();
  assert.ok(f.text().includes('结果尚未确认'));
  assert.ok(!f.text().includes('你会收到密码重置链接'));
  assert.equal(f.button('发送重置链接').props.disabled, false);
});

test('unmounted recovery page ignores late acknowledgement', async t => {
  const { f, calls, submit } = recoveryFixture(t);
  const request = submit(); f.unmount(); calls[0].resolve({ error: null }); await request; await f.settle();
  assert.ok(!f.text().includes('你会收到密码重置链接'));
});


test('tri-state group checkbox isolates exact resources/environments and preserves manual choices', async t => {
  const f = fixture(); t.after(() => f.unmount());
  const eligible = [
    { resource_kind: 'context', resource_id: '11111111-1111-4111-8111-111111111111', environment: 'test', name: 'Test workspace', actions: ['read', 'write', 'close'] },
    { resource_kind: 'context', resource_id: '11111111-1111-4111-8111-111111111111', environment: 'preview', name: 'Preview workspace', actions: ['read'] },
    { resource_kind: 'context', resource_id: '22222222-2222-4222-8222-222222222222', environment: 'test', name: 'Other workspace', actions: ['read', 'feedback_submit'] },
  ];
  f.emit('INITIAL_SESSION', session('A')); f.runTimers();
  f.respond(0, { ...details('A'), requested_scopes: ['context:read', 'context:write'], eligible }); await f.settle();
  const group = name => {
    const node = f.nodes('fieldset').find(field => f.nodes('legend', field).some(legend => f.text(legend).includes(name)));
    assert.ok(node, name); return node;
  };
  const boxes = name => f.nodes('input', group(name)).filter(node => node.props.type === 'checkbox' && node.props.className !== 'oauth-group-checkbox');
  const choice = name => boxes(name).map(node => node.props.checked);
  const master = name => {
    const inputs = f.nodes('input', group(name)).filter(node => node.props.className === 'oauth-group-checkbox');
    assert.equal(inputs.length, 1, name + ' has exactly one group control');
    assert.equal(inputs[0].props.type, 'checkbox'); return inputs[0];
  };
  const domInputs = new Map();
  const checkState = (name, expected) => {
    const input = master(name);
    assert.equal(input.props.checked, expected === 'all', name + ' checked state');
    assert.equal(input.props['aria-checked'], expected === 'partial' ? 'mixed' : expected === 'all', name + ' accessible state');
    // Invoke the actual ref callback on a persistent input-like DOM object: JSX alone cannot set indeterminate.
    if (!domInputs.has(name)) domInputs.set(name, { indeterminate: true });
    const node = domInputs.get(name);
    assert.equal(typeof input.props.ref, 'function'); input.props.ref(node);
    assert.equal(node.indeterminate, expected === 'partial', name + ' DOM indeterminate state');
    assert.doesNotThrow(() => input.props.ref(null));
  };
  const clickMaster = name => {
    const input = master(name); assert.equal(input.props.disabled, false);
    input.props.onChange({ target: { checked: !input.props.checked } }); f.render();
  };
  for (const row of eligible) {
    assert.deepEqual(choice(row.name), row.actions.map(() => false), 'specific selection starts empty'); checkState(row.name, 'none');
    assert.ok(f.text(group(row.name)).replaceAll(' ', '').includes(`已选0/${row.actions.length}`));
  }
  assert.equal(f.button('允许所选权限').props.disabled, true);
  assert.equal(f.button('允许所选权限').props.disabled, true);
  boxes('Test workspace')[1].props.onChange({ target: { checked: true } }); f.render();
  assert.deepEqual(choice('Test workspace'), [false, true, false], 'manual write does not silently add read');
  checkState('Test workspace', 'partial'); checkState('Preview workspace', 'none'); checkState('Other workspace', 'none');
  clickMaster('Test workspace');
  assert.deepEqual(choice('Test workspace'), [true, true, true], 'clicking a partial group selects its complete allowed action set');
  checkState('Test workspace', 'all');
  assert.deepEqual(choice('Preview workspace'), [false], 'same context in another environment stays empty');
  assert.deepEqual(choice('Other workspace'), [false, false], 'another resource stays empty');
  assert.ok(f.text(group('Test workspace')).replaceAll(' ', '').includes('已选3/3'));
  clickMaster('Preview workspace'); checkState('Preview workspace', 'all');
  boxes('Test workspace')[0].props.onChange({ target: { checked: false } }); f.render();
  checkState('Test workspace', 'partial');
  clickMaster('Test workspace'); checkState('Test workspace', 'all');
  clickMaster('Test workspace');
  assert.deepEqual(choice('Test workspace'), [false, false, false], 'clicking an all-selected group clears it');
  checkState('Test workspace', 'none');
  assert.deepEqual(choice('Preview workspace'), [true], 'clearing one environment preserves the other');
  checkState('Preview workspace', 'all');
  boxes('Test workspace')[1].props.onChange({ target: { checked: true } }); f.render();
  boxes('Other workspace')[1].props.onChange({ target: { checked: true } }); f.render();
  assert.deepEqual(choice('Test workspace'), [false, true, false]);
  assert.deepEqual(choice('Other workspace'), [false, true]);
  checkState('Test workspace', 'partial'); checkState('Other workspace', 'partial');
  assert.equal(f.requests.length, 1, 'group control only changes local selection');
  f.button('允许所选权限').props.onClick(); await f.settle();
  const decision = JSON.parse(f.requests[1].options.body);
  assert.deepEqual(decision.selected, eligible.map((row, index) => ({
    resource_kind: row.resource_kind, resource_id: row.resource_id, environment: row.environment,
    actions: index === 0 ? ['write'] : index === 1 ? ['read'] : ['feedback_submit'],
  })));
  for (const row of eligible) {
    assert.equal(group(row.name).props.disabled, true);
    assert.equal(master(row.name).props.disabled, true);
  }
});

test('new all-context policy defaults to one macro; specified clears selection and presets change only selected resources', async t => {
  const f = fixture(); t.after(() => f.unmount());
  const full = ['read','write','close','restore','audit','feedback_submit'];
  const eligible = [{resource_kind:'scope',resource_id:'contexts:*',environment:'canonical',actions:full},
    {resource_kind:'scope',resource_id:'profile',environment:'canonical',actions:full.slice(0,5)},
    {resource_kind:'scope',resource_id:'global',environment:'canonical',actions:full.slice(0,5)}];
  f.emit('INITIAL_SESSION',session('A'));f.runTimers();f.respond(0,{...details('A'),requested_scopes:['context:read','context:write','audit:read'],eligible});await f.settle();
  assert.ok(f.nodes('button').some(n=>n.props['aria-pressed']===true&&f.text(n).startsWith('全部操作')));
  assert.equal(f.requests.length,1,'default is not consent');
  f.button('允许所选权限').props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.requests[1].options.body).selected,[{resource_kind:'scope',resource_id:'contexts:*',environment:'canonical',actions:full}]);
  f.respond(1,{error:'review again'});await f.settle();
  f.nodes('input').find(n=>n.props.type==='radio'&&!n.props.checked).props.onChange();f.render();
  assert.equal(f.button('允许所选权限').props.disabled,true);
  const personal=f.nodes('label').find(n=>n.props.className==='oauth-project-choice'&&f.text(n)==='个人资料');
  f.nodes('input',personal)[0].props.onChange({target:{checked:true}});f.render();
  f.nodes('button').find(n=>n.props['aria-pressed']!==undefined&&f.text(n).startsWith('只读')).props.onClick();f.render();
  f.button('允许所选权限').props.onClick();await f.settle();
  assert.deepEqual(JSON.parse(f.requests[2].options.body).selected,[{resource_kind:'scope',resource_id:'profile',environment:'canonical',actions:['read']}]);
});

test('without write capability simple controls offer only read; no policy means empty specified selection',async t=>{
 const f=fixture();t.after(()=>f.unmount());f.emit('INITIAL_SESSION',session('A'));f.runTimers();f.respond(0,details('A'));await f.settle();
 assert.equal(f.nodes('input').filter(n=>n.props.type==='radio').length,1);assert.equal(f.button('允许所选权限').props.disabled,true);
 assert.ok(!f.nodes('button').some(n=>n.props['aria-pressed']!==undefined&&/可编辑|全部操作/.test(f.text(n))));
});

test('roles and project range are styled: role cards show the chosen one, radios are not text inputs', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.oauth-card input\[type="radio"\]\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s);
  assert.match(css, /\.oauth-card label:has\(> input\[type="radio"\]\)\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.oauth-role-list button::before\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(css, /\.oauth-role-list button\[aria-pressed="true"\]::before\s*\{[^}]*background:/s);
  assert.match(css, /\.oauth-range\s*\{/);
});
