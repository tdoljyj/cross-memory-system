// Actual development owner page under controlled hooks/auth/network; no browser or live API claims.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../app/contexts/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
function fixture({ hash = "", storage = new Map(), extraAuth = {} } = {}) {
 const hooks=[],effects=[],timers=new Map(),requests=[],navigations=[],histories=[];let cursor=0,authCallback,root,seq=0;
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
  if(name==='../imprints/ImprintPanel')return {__esModule:true,default:'imprint-panel'};
  if(name==='./contexts.css')return {};
  if(name==='next/link')return {__esModule:true,default:'a'};throw Error(name);
 },AbortController,Error,TypeError,encodeURIComponent,URL,URLSearchParams,crypto:{randomUUID:()=>"fixture-operation-"+(++seq)},window:{sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},history:{replaceState:(_data,_unused,path)=>histories.push(path)},setInterval:()=>999,clearInterval:()=>{},setTimeout(cb){const id=++seq;timers.set(id,cb);return id;},clearTimeout(id){timers.delete(id);},location:{hash,pathname:'/oauth/projects',search:'',origin:'https://clued.example.test',assign(url){navigations.push(url);}}},
 fetch(url,options){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});requests.push({url,options,resolve,reject});return promise;}});
 function render(){cursor=0;root=exports.default({requestId:'a'.repeat(64)});while(effects.length)effects.shift()();return root;}
 function nodes(type){const out=[];function visit(n){if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=='object')return;if(n.type===type)out.push(n);visit(n.props?.children);}visit(root);return out;}
 function text(n){if(arguments.length===0)n=root;if(Array.isArray(n))return n.map(text).join('');if(n==null||typeof n==='boolean')return '';return typeof n==='object'?text(n.props?.children ?? null):String(n);}
 async function settle(){for(let i=0;i<8;i++)await Promise.resolve();render();}
 const respond=(i,data,status=200)=>requests[i].resolve({ok:status<400,status,json:async()=>data});
 function emit(e,s){authCallback(e,s);render();}
 function runTimers(){const c=[...timers.values()];timers.clear();c.forEach(f=>f());render();}
 function button(t){const n=nodes('button').find(n=>text(n)===t);assert.ok(n,t);return n;}
 render();return {requests,navigations,histories,storage,render,nodes,text,respond,settle,emit,runTimers,button,unmount:()=>hooks.forEach(h=>h?.cleanup?.())};
}


const session = id => ({user:{id,email:id+'@example.test'},access_token:'fixture-'+id});
const context = {id:'context-A',project_id:'project-A',name:'Development notes',environment:'test',cursor:0,version:1,created_at:'2026-09-08T00:00:00Z'};
const listing = {status:'ok',projects:[{id:'project-A',name:'Project Alpha'}],contexts:[]};
async function ready(t,options={}) {
 const f=fixture(options);t.after(()=>f.unmount());f.emit('INITIAL_SESSION',session('owner'));f.runTimers();f.respond(0,listing);await f.settle();return f;
}
function fill(f) {
 f.nodes('select')[0].props.onChange({target:{value:'project-A'}});
 f.nodes('input')[0].props.onChange({target:{value:'Development notes'}});f.render();
}
const create=f=>f.nodes('form')[0].props.onSubmit({preventDefault(){}});

test('signed-out page has no bearer input or retired publication/bridge controls and sends no requests',t=>{
 const f=fixture();t.after(()=>f.unmount());f.emit('INITIAL_SESSION',null);
 assert.equal(f.requests.length,0);assert.equal(f.nodes('input').length,0);
 assert.ok(f.text().includes('登录 BeamingFace'));
 assert.ok(!/发布|关联到项目|当前会话的连接令牌|接受这版/.test(f.text()));
});

test('late owner A list cannot populate owner B account',async t=>{
 const f=fixture();t.after(()=>f.unmount());f.emit('INITIAL_SESSION',session('A'));f.runTimers();
 f.emit('SIGNED_IN',session('B'));f.runTimers();assert.equal(f.requests[0].options.signal.aborted,true);
 f.respond(1,{status:'ok',projects:[{id:'project-B',name:'Project Beta'}],contexts:[]});await f.settle();
 f.respond(0,listing);await f.settle();
 assert.ok(f.text().includes('Project Beta'));assert.ok(!f.text().includes('Project Alpha'));
 assert.equal(JSON.parse(f.requests[1].options.body).op,'owner_list');
});

test('create selects an existing owned project, uses current human token, and confirms the actual reloaded context',async t=>{
 const f=await ready(t);fill(f);
 f.emit('TOKEN_REFRESHED',{...session('owner'),access_token:'fixture-refreshed'});f.runTimers();
 assert.equal(JSON.parse(f.requests[1].options.body).op,'owner_list');
 f.respond(1,listing);await f.settle();fill(f);create(f);await f.settle();
 assert.equal(f.requests[2].url,'/v1/development/owner');assert.equal(f.requests[2].options.headers.Authorization,'Bearer fixture-refreshed');
 const input=JSON.parse(f.requests[2].options.body);
 assert.deepEqual(Object.keys(input).sort(),['environment','idempotency_key','name','op','project_id']);
 assert.equal(input.project_id,'project-A');assert.equal(input.environment,'test');assert.equal(input.op,'context_create');
 f.respond(2,{status:'committed',result:context});await f.settle();assert.ok(!f.text().includes('已创建上下文。'));
 assert.equal(JSON.parse(f.requests[3].options.body).op,'owner_list');
 f.respond(3,{...listing,contexts:[context]});await f.settle();
 assert.ok(f.text().includes('已创建上下文。'));assert.ok(f.text().includes('Development notes'));assert.equal(f.storage.size,0);
});

test('unknown create survives reload and repeats the exact original operation without another key',async t=>{
 const storage=new Map();const f=await ready(t,{storage});fill(f);const job=create(f);await f.settle();
 const original=f.requests[1].options.body;f.requests[1].reject(new TypeError('fixture response lost'));await job;await f.settle();
 assert.ok(f.text().includes('创建结果尚未确认'));assert.equal(f.button('创建上下文').props.disabled,true);assert.equal(storage.size,1);f.unmount();
 const resumed=await ready(t,{storage});resumed.button('核对原操作').props.onClick();await resumed.settle();
 assert.equal(resumed.requests[1].options.body,original);
 resumed.respond(1,{status:'committed',result:context,replayed:true});await resumed.settle();
 resumed.respond(2,{...listing,contexts:[context]});await resumed.settle();assert.equal(storage.size,0);
 assert.ok(resumed.text().includes('已创建上下文。'));
});

test('account change clears pending context UI and prevents an old create response claiming success',async t=>{
 const f=await ready(t);fill(f);create(f);await f.settle();
 f.emit('SIGNED_IN',session('other'));f.runTimers();assert.equal(f.requests[1].options.signal.aborted,true);
 f.respond(1,{status:'committed',result:context});await f.settle();
 assert.equal(f.requests.length,3);assert.ok(!f.text().includes('已创建上下文。'));assert.ok(!f.text().includes('Development notes'));
 f.respond(2,{status:'ok',projects:[],contexts:[]});await f.settle();assert.ok(!f.text().includes('核对原操作'));
});

test('mismatched reloaded result does not claim success and blocks another creation',async t=>{
 const f=await ready(t);fill(f);create(f);await f.settle();
 f.respond(1,{status:'committed',result:context});await f.settle();f.respond(2,listing);await f.settle();
 assert.ok(!f.text().includes('已创建上下文。'));assert.ok(f.text().includes('创建结果尚未确认'));
 assert.equal(f.button('创建上下文').props.disabled,true);assert.equal(f.storage.size,1);
});
