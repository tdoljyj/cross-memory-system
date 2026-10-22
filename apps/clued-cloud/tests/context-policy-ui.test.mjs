// Context Policy acceptance page under controlled hooks/auth/network; no browser or live API claims.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../app/policies/page.tsx', import.meta.url), 'utf8'), {
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
  if(name==='../contexts/contexts.css')return {};
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
const body = r => JSON.parse(r.options.body);
async function ready(t) {
 const f=fixture();t.after(()=>f.unmount());f.emit('INITIAL_SESSION',session('owner'));
 assert.equal(f.requests[0].url,'/v1/projects?limit=200');
 f.respond(0,{projects:[{id:'11111111-1111-4111-8111-111111111111',name:'Alpha'}]});await f.settle();return f;
}
const submit=f=>f.nodes('form')[0].props.onSubmit({preventDefault(){}});
const issued={status:'issued',confirmation_token:'clued_cpt_x',view_digest:'d'.repeat(64),task_class:'general',
 expires_at:'2026-09-24T17:00:00Z',confirmation_view:{policy_version:1}};

test('signed-out page sends no requests and offers sign-in',t=>{
 const f=fixture();t.after(()=>f.unmount());f.emit('INITIAL_SESSION',null);
 assert.equal(f.requests.length,0);assert.ok(f.text().includes('登录 BeamingFace'));
});

test('preview then accept sends the exact Native bodies with the session bearer',async t=>{
 const f=await ready(t);
 submit(f);
 const issue=f.requests[1];
 assert.equal(issue.url,'/v1/context/policies/confirmation');
 assert.equal(issue.options.headers.Authorization,'Bearer fixture-owner');
 const sent=body(issue);
 assert.deepEqual(Object.keys(sent).sort(),['base_policy_version','policy','rationale']);
 assert.equal(sent.base_policy_version,0);
 assert.equal(sent.policy.allow_agent_authored,true);
 assert.deepEqual(sent.policy.allowed_scopes,['global']);
 assert.deepEqual(sent.policy.fields,{required:['title','content'],optional:['rationale','closure_summary']});
 assert.equal(sent.policy.tokenizer.encoding,'o200k_base');
 assert.ok(!('confirmation_token' in sent));
 f.respond(1,issued);await f.settle();
 assert.ok(f.text().includes('请核对后确认'));
 f.button('第二步：确认接受').props.onClick();
 const acc=f.requests[2];
 assert.equal(acc.url,'/v1/context/policies');
 const {idempotency_key,...rest}=body(acc);
 assert.match(idempotency_key,/^fixture-operation-\d+$/);
 assert.deepEqual(rest,{task_class:'general',base_policy_version:0,confirmation_token:'clued_cpt_x',view_digest:'d'.repeat(64)});
 f.respond(2,{status:'committed',supplemental:{policy_id:'policy-1'}});await f.settle();
 assert.ok(f.text().includes('策略已接受'));assert.ok(f.text().includes('policy-1'));
});

test('a stale sign-in is reported as a reauthentication requirement and no accept is sent',async t=>{
 const f=await ready(t);
 submit(f);f.respond(1,{status:'rejected',error_code:'reauthentication_required'},200);await f.settle();
 assert.ok(f.text().includes('15 分钟内需要重新登录'));
 assert.equal(f.requests.length,2);
});

test('an uncertain accept keeps the same request for a retry',async t=>{
 const f=await ready(t);
 submit(f);f.respond(1,issued);await f.settle();
 f.button('第二步：确认接受').props.onClick();
 const first=body(f.requests[2]);
 f.requests[2].resolve({ok:false,status:502,json:async()=>{throw new Error('truncated');}});await f.settle();
 assert.ok(f.text().includes('核对原操作'));
 f.button('核对原操作').props.onClick();
 assert.deepEqual(body(f.requests[3]),first);
});
