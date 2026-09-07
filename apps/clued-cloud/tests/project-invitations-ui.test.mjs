// Actual project-page logic under controlled hook/auth/network mocks; no browser or live API claims.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../app/oauth/projects/page.tsx', import.meta.url), 'utf8'), {
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


const token = 'clued_inv_' + 'a'.repeat(64);
const session = id => ({user:{id,email:id+'@example.test'},access_token:'fixture-'+id});
const expiry = new Date(Date.now()+86400000).toISOString();
const invite = {invitation_id:'invitation-A',project_id:'project-A',project_name:'Project Alpha',environment:'test',role:'reader',actions:['read'],expires_at:expiry,version:1,target_email:'recipient@example.test',status:'pending'};
const member = {membership_id:'membership-A',project_id:'project-A',project_name:'Project Alpha',subject_id:'recipient',environment:'test',role:'reader',actions:['read'],expires_at:expiry,revoked_at:null,version:1};
const empty = {owned_projects:[],memberships:[],invitations:[]};
const ownerList = {...empty,owned_projects:[{project_id:'project-A',name:'Project Alpha',environments:['test']}]};
async function ready(t, options={}, listing=ownerList, subject='owner') {
  const f=fixture(options);t.after(()=>f.unmount());f.emit('INITIAL_SESSION',session(subject));f.runTimers();f.respond(0,listing);await f.settle();return f;
}
function fillCreate(f) {
  f.nodes('select')[0].props.onChange({target:{value:'project-A'}});f.render();
  f.nodes('select')[1].props.onChange({target:{value:'test'}});f.render();
  f.nodes('input').find(node=>node.props.type==='email').props.onChange({target:{value:'recipient@example.test'}});f.render();
}
const create=f=>f.nodes('form')[0].props.onSubmit({preventDefault(){}});

test('invite fragment is removed before any network call; identity changes suppress late inspect results',async t=>{
  const f=fixture({hash:'#invite='+token});t.after(()=>f.unmount());
  assert.deepEqual(f.histories,['/oauth/projects']);assert.equal(f.requests.length,0);
  f.emit('INITIAL_SESSION',session('recipient'));f.runTimers();f.respond(0,empty);await f.settle();
  assert.equal(f.requests[1].url,'/oauth/projects/api');
  assert.equal(JSON.parse(f.requests[1].options.body).invite_token,token);
  f.emit('SIGNED_IN',session('other'));f.runTimers();assert.equal(f.requests[1].options.signal.aborted,true);
  f.respond(1,invite);await f.settle();assert.ok(!f.text().includes('Project Alpha'));assert.equal(f.navigations.length,0);
});

test('acceptance posts exact inspected version and verifies the returned membership before success',async t=>{
  const f=await ready(t,{hash:'#invite='+token},empty,'recipient');
  f.respond(1,invite);await f.settle();f.button('接受此邀请').props.onClick();await f.settle();
  const input=JSON.parse(f.requests[2].options.body);assert.equal(input.op,'invite_accept');assert.equal(input.invite_token,token);assert.equal(input.base_version,1);
  f.respond(2,{membership_id:'membership-A',version:1});await f.settle();
  assert.ok(!f.text().includes('已加入指定项目'));
  f.respond(3,{...empty,memberships:[member]});await f.settle();assert.ok(f.text().includes('已加入指定项目'));
  assert.ok(f.requests.every(request=>request.url==='/oauth/projects/api'));
});

test('create unknown acknowledgement survives reload and reuses identical parameters and idempotency key',async t=>{
  const storage=new Map();const f=await ready(t,{storage});fillCreate(f);const pending=create(f);await f.settle();
  const original=f.requests[1].options.body;f.requests[1].reject(new TypeError('fixture lost acknowledgement'));await pending;await f.settle();
  assert.ok(f.text().includes('结果尚未确认'));assert.equal(f.button('创建定向邀请').props.disabled,true);
  assert.equal(storage.size,1);assert.ok(![...storage.values()][0].includes('clued_inv_'));f.unmount();
  const restored=await ready(t,{storage});restored.button('核对原操作').props.onClick();await restored.settle();
  assert.equal(restored.requests[1].options.body,original);
  restored.respond(1,{invitation_id:invite.invitation_id,version:1,expires_at:expiry,replayed:true,token_unavailable:true});await restored.settle();
  restored.respond(2,{...ownerList,invitations:[invite]});await restored.settle();
  assert.ok(restored.text().includes('链接无法再次取回'));assert.equal(storage.size,0);
  assert.equal(restored.nodes('input').some(node=>node.props.readOnly),false);
});

test('confirmed create displays only a fragment link and duplicate pending invitation needs revocation',async t=>{
  const f=await ready(t);fillCreate(f);create(f);await f.settle();
  f.respond(1,{invitation_id:invite.invitation_id,version:1,expires_at:expiry,invite_token:token});await f.settle();
  assert.equal(f.nodes('input').some(node=>node.props.readOnly),false);
  f.respond(2,{...ownerList,invitations:[invite]});await f.settle();
  const link=f.nodes('input').find(node=>node.props.readOnly).props.value;
  assert.equal(new URL(link).search,'');assert.equal(new URL(link).hash,'#invite='+token);
  assert.equal(f.storage.size,0);assert.equal(f.button('创建定向邀请').props.disabled,true);
  f.emit('SIGNED_IN',session('other'));f.runTimers();assert.equal(f.nodes('input').some(node=>node.props.readOnly),false);
});

test('member reduction can only remove existing actions; failed write keeps selected state without claiming success',async t=>{
  const editor={...member,role:'editor',actions:['read','write']};
  const f=await ready(t,{}, {...ownerList,memberships:[editor]});
  const boxes=f.nodes('input').filter(node=>node.props.type==='checkbox');
  boxes[boxes.length-1].props.onChange({target:{checked:false}});f.render();
  f.button('保存减少的权限').props.onClick();await f.settle();
  const input=JSON.parse(f.requests[1].options.body);assert.deepEqual(input.actions,['read']);assert.equal(input.base_version,1);assert.equal(input.membership_id,'membership-A');
  f.respond(1,{error:'forbidden'},403);await f.settle();
  assert.ok(!f.text().includes('已减少该成员'));assert.equal(f.nodes('input').filter(node=>node.props.type==='checkbox').at(-1).props.checked,false);
});

test('registration invokes only existing identity service, never a memory write or automatic invitation acceptance',async t=>{
  const calls=[];const f=fixture({extraAuth:{signUp:async input=>{calls.push(input);return {error:null};}}});t.after(()=>f.unmount());
  f.emit('INITIAL_SESSION',null);f.button('没有账户，注册').props.onClick();f.render();
  f.nodes('input')[0].props.onChange({target:{value:'new-developer@example.test'}});f.nodes('input')[1].props.onChange({target:{value:'fixture-password'}});f.render();
  await f.nodes('form')[0].props.onSubmit({preventDefault(){}});await f.settle();
  assert.equal(calls.length,1);assert.equal(calls[0].options.emailRedirectTo,'https://clued.example.test/oauth/projects');
  assert.equal(f.requests.length,0);assert.ok(f.text().includes('不会自动创建个人记忆'));
});
