// Executes the real source component with a small hook harness and controlled auth/network.
// This is deterministic UI logic coverage, not a React browser or live OAuth acceptance test.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

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
 vm.runInNewContext(compiled,{exports,require(name){
  if(name==='react')return React;
  if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
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

test('consent defaults to every eligible permission and a 30-day lifetime of up to 365 days', async t => {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('A')); f.runTimers();
  f.respond(0, { ...details('A'), eligible: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write', 'close'] }] }); await f.settle();
  const boxes = f.nodes('input').filter(node => node.props.type === 'checkbox' && node.props.className !== 'oauth-group-checkbox');
  assert.deepEqual(boxes.map(node => node.props.checked), [true, true, true]);
  // Re-ticking an already selected action must not duplicate it.
  boxes[0].props.onChange({ target: { checked: true } }); f.render();
  assert.ok(f.text().replaceAll(' ', '').includes('已选3/3'));
  const select = f.nodes('select')[0];
  assert.equal(select.props.value, 30);
  assert.deepEqual(f.nodes('option', select).map(node => node.props.value), [1, 7, 30, 90, 365]);
  select.props.onChange({ target: { value: '365' } }); f.render();
  f.button('允许所选权限').props.onClick(); await f.settle();
  const decision = JSON.parse(f.requests[1].options.body);
  assert.equal(decision.days, 365);
  assert.deepEqual(decision.selected, [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read', 'write', 'close'] }]);
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
    assert.deepEqual(choice(row.name), row.actions.map(() => true), 'every eligible action starts selected'); checkState(row.name, 'all');
    assert.ok(f.text(group(row.name)).replaceAll(' ', '').includes(`已选${row.actions.length}/${row.actions.length}`));
  }
  assert.equal(f.button('允许所选权限').props.disabled, false);
  for (const row of eligible) { clickMaster(row.name); checkState(row.name, 'none'); }
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

// Preset roles and "我的全部项目（含以后新建的）" (PermissionSimplification.v0.1 §3.1, Task 0756c748).
test('roles: 全部 over 我的全部项目 by default; 指定项目 and 项目开发者 package the same rows', async t => {
  const f = fixture(); t.after(() => f.unmount());
  const all5 = ['read', 'write', 'close', 'restore', 'audit'];
  const A = 'project:11111111-1111-4111-8111-111111111111';
  const B = 'project:22222222-2222-4222-8222-222222222222';
  const eligible = [
    { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', name: 'Personal memory', actions: all5 },
    { resource_kind: 'scope', resource_id: 'profile', environment: 'canonical', name: 'Personal profile', actions: all5 },
    { resource_kind: 'scope', resource_id: 'project:*', environment: 'canonical', name: '我的全部项目（含以后新建的）', actions: all5 },
    { resource_kind: 'scope', resource_id: A, environment: 'canonical', name: 'M2', actions: all5 },
    { resource_kind: 'scope', resource_id: B, environment: 'canonical', name: 'Other', actions: all5 },
  ];
  f.emit('INITIAL_SESSION', session('A')); f.runTimers();
  f.respond(0, { ...details('A'), requested_scopes: ['context:read', 'context:write', 'audit:read'], eligible }); await f.settle();
  const pressed = () => f.nodes('button').filter(n => n.props['aria-pressed'] === true).map(n => f.text(n.props.children[0]));
  assert.deepEqual(pressed(), ['全部']);
  // Each send is answered with a refusal so the next one can go out.
  const send = async () => {
    f.button('允许所选权限').props.onClick(); await f.settle();
    const index = f.requests.length - 1;
    const body = JSON.parse(f.requests[index].options.body);
    f.respond(index, { error: 'not this time' }); await f.settle();
    return Object.fromEntries(body.selected.map(row => [row.resource_id, row.actions]));
  };
  const role = title => f.nodes('button').find(n => n.props['aria-pressed'] !== undefined && f.text(n).startsWith(title));
  const radios = () => f.nodes('input').filter(n => n.props.type === 'radio');
  const rangeNote = '这一组只在“项目范围”选“我的全部项目（含以后新建的）”时才勾选';
  // Default (Decision d4c06a24): 全部 over 我的全部项目, one project:* row instead of each project.
  assert.equal(radios().length, 2);
  assert.equal(radios()[1].props.checked, true);
  assert.ok(f.text().includes('以后新建的项目也自动包含在内'));
  assert.ok(!f.text().includes(rangeNote));
  let sent = await send();
  assert.deepEqual(sent, { global: all5, profile: all5, 'project:*': all5 });
  // 指定项目: everything on the current projects, nothing on project:*.
  radios()[0].props.onChange(); f.render();
  sent = await send();
  assert.deepEqual(sent, { global: all5, profile: all5, [A]: all5, [B]: all5 });
  // The empty project:* group in 高级 says why it is empty.
  assert.ok(f.text().includes(rangeNote));
  // 项目开发者: the projects get read/write/close/restore, Global read, profile nothing.
  role('项目开发者').props.onClick(); f.render();
  assert.deepEqual(pressed(), ['项目开发者']);
  // Narrow to one project.
  const projectBox = name => f.nodes('label').filter(n => n.props.className === 'oauth-project-choice')
    .find(n => f.text(n).includes(name));
  f.nodes('input', projectBox('Other'))[0].props.onChange({ target: { checked: false } }); f.render();
  sent = await send();
  assert.deepEqual(sent, { global: ['read'], [A]: ['read', 'write', 'close', 'restore'] });
  // 我的全部项目（含以后新建的）: one project:* row instead of each project.
  radios()[1].props.onChange(); f.render();
  assert.ok(!f.text().includes(rangeNote), 'the note goes once project:* is selected');
  sent = await send();
  assert.deepEqual(sent, { global: ['read'], 'project:*': ['read', 'write', 'close', 'restore'] });
  // 只读 keeps the range.
  role('只读').props.onClick(); f.render();
  sent = await send();
  assert.deepEqual(sent, { global: ['read'], profile: ['read'], 'project:*': ['read'] });
  // 全部 from 指定项目 moves the range to 我的全部项目.
  radios()[0].props.onChange(); f.render();
  role('全部').props.onClick(); f.render();
  assert.equal(radios()[1].props.checked, true);
  sent = await send();
  assert.deepEqual(sent, { global: all5, profile: all5, 'project:*': all5 });
  // A change in 高级 makes the role 自定义 and hides the range.
  const advanced = f.nodes('details')[0];
  assert.ok(advanced, '高级 holds the per-row checkboxes');
  const firstBox = f.nodes('input', advanced).find(n => n.props.type === 'checkbox' && n.props.className !== 'oauth-group-checkbox');
  firstBox.props.onChange({ target: { checked: false } }); f.render();
  assert.deepEqual(pressed(), []);
  assert.ok(f.text().includes('自定义'));
  assert.equal(f.nodes('input').filter(n => n.props.type === 'radio').length, 0);
});

test('roles: no project:* row on offer means no 我的全部项目 choice', async t => {
  const f = fixture(); t.after(() => f.unmount());
  const A = 'project:11111111-1111-4111-8111-111111111111';
  f.emit('INITIAL_SESSION', session('A')); f.runTimers();
  f.respond(0, { ...details('A'), eligible: [
    { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] },
    { resource_kind: 'scope', resource_id: A, environment: 'canonical', name: 'M2', actions: ['read'] }] }); await f.settle();
  assert.equal(f.nodes('input').filter(n => n.props.type === 'radio').length, 1);
  assert.ok(!f.text().includes('我的全部项目（含以后新建的）'));
});

test('roles and project range are styled: role cards show the chosen one, radios are not text inputs', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  assert.match(css, /\.oauth-card input\[type="radio"\]\s*\{[^}]*width:\s*18px[^}]*height:\s*18px/s);
  assert.match(css, /\.oauth-card label:has\(> input\[type="radio"\]\)\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.oauth-role-list button::before\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(css, /\.oauth-role-list button\[aria-pressed="true"\]::before\s*\{[^}]*background:/s);
  assert.match(css, /\.oauth-range\s*\{/);
});
