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
 function nodes(type){const out=[];function visit(n){if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=='object')return;if(n.type===type)out.push(n);visit(n.props?.children);}visit(root);return out;}
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
const checkbox = f => f.nodes('input').find(node => node.props.type === 'checkbox');
async function ready(t, id = 'A') {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session(id)); f.runTimers(); f.respond(0, details(id)); await f.settle();
  checkbox(f).props.onChange({ target: { checked: true } }); f.render(); return f;
}

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
