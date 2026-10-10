// Real page source, controlled Supabase auth events and HTTP replies; no production IO.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../app/storage/admin/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const connection = { id: '79cc0000-1111-4111-8111-111111111111', provider: 'google-drive', state: 'active', version: 305, root_name: 'Clued_资料中心' };
const status = (extra = {}) => ({ enabled: false, version: 0, connection_version: 305, failures: 0, pending: false, next_refresh_at: null, ...extra });
function fixture() {
  const hooks = [], effects = [], requests = [], confirmations = []; let cursor = 0, root, listener, refreshOnSession = false;
  let session = { user: { id: 'owner-A' }, access_token: 'synthetic-native-A' };
  const same = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]));
  const React = {
    useState(initial) { const i=cursor++; hooks[i]??={value:typeof initial==='function'?initial():initial}; return [hooks[i].value,v=>{hooks[i].value=typeof v==='function'?v(hooks[i].value):v;}]; },
    useRef(value) { const i=cursor++; hooks[i]??={current:value}; return hooks[i]; },
    useCallback(callback,deps) { const i=cursor++; if(!hooks[i]||!same(hooks[i].deps,deps))hooks[i]={callback,deps}; return hooks[i].callback; },
    useEffect(callback,deps) { const i=cursor++; if(!hooks[i]||!same(hooks[i].deps,deps)){const old=hooks[i]; hooks[i]={deps}; effects.push(()=>{old?.cleanup?.();hooks[i].cleanup=callback();});} },
  };
  const auth = { async getSession(){if(refreshOnSession){refreshOnSession=false;listener('TOKEN_REFRESHED',session);}return {data:{session},error:null};}, onAuthStateChange(cb){listener=cb; queueMicrotask(()=>cb('INITIAL_SESSION',session)); return {data:{subscription:{unsubscribe(){listener=null;}}}};} };
  const exports = {};
  vm.runInNewContext(source,{exports,URL,Error,crypto:{randomUUID},queueMicrotask,window:{confirm:message=>{confirmations.push(message);return true;},location:{assign(){throw Error('unexpected navigation');}}},require(name){
    if(name==='react')return React;
    if(name==='react/jsx-runtime')return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
    if(name==='next/link')return {__esModule:true,default:'a'};
    if(name.endsWith('/supabase-browser'))return {supabase:{auth}};
    throw Error(name);
  },fetch(url,options){let resolve;const promise=new Promise(r=>resolve=r);requests.push({url,options,resolve});return promise;}});
  function render(){cursor=0;root=exports.default();while(effects.length)effects.shift()();}
  function text(node){if(arguments.length===0)node=root;if(Array.isArray(node))return node.map(n=>text(n)).join('');if(node==null||typeof node==='boolean')return '';return typeof node==='object'?text(node.props?.children):String(node);}
  function nodes(type){const found=[];function visit(n){if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=='object')return;if(n.type===type)found.push(n);visit(n.props?.children);}visit(root);return found;}
  async function settle(){for(let i=0;i<16;i++)await Promise.resolve();render();}
  const respond=(i,data,httpStatus=200)=>requests[i].resolve({ok:httpStatus>=200&&httpStatus<300,status:httpStatus,json:async()=>data});
  const button=label=>{const item=nodes('button').find(n=>text(n)===label);assert.ok(item,label);return item;};
  const click=label=>{const item=button(label);assert.equal(item.props.disabled,false,label);item.props.onClick();};
  function emit(event,id='owner-A'){session=id?{user:{id},access_token:`synthetic-native-${id}`}:null;listener(event,session);render();}
  render();return {requests,confirmations,respond,button,click,emit,text,settle,refreshOnNextSession:()=>{refreshOnSession=true;},close:()=>hooks.forEach(h=>h?.cleanup?.())};
}
async function ready(t){const f=fixture();t.after(()=>f.close());await f.settle();assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'/v1/storage/owner');assert.deepEqual(JSON.parse(f.requests[0].options.body),{action:'connections'});
  f.respond(0,{connections:[connection]});await f.settle();return f;}
async function queried(t,extra={}){const f=await ready(t);f.click('查询续签状态');await f.settle();f.respond(1,status(extra));await f.settle();return f;}

test('cards use published owner directory metadata; status/enable/disable use exact Native transport and both CAS versions',async t=>{
  const f=await queried(t);assert.ok(f.text().includes(connection.root_name));
  assert.equal(f.requests[1].options.headers.authorization,'Bearer synthetic-native-A');
  assert.deepEqual(JSON.parse(f.requests[1].options.body),{action:'status',connection_id:connection.id});
  f.click('授权开启后台续签');await f.settle();
  assert.ok(f.confirmations[0].includes(connection.root_name));
  const enable=JSON.parse(f.requests[2].options.body);assert.deepEqual({...enable,idempotency_key:'key'},{action:'enable',connection_id:connection.id,base_version:305,delegation_version:0,idempotency_key:'key',until_revoked:true});
  assert.equal(f.requests[2].url,'/v1/storage/refresh');assert.equal(f.requests[2].options.redirect,'error');
  f.respond(2,{status:'committed',receipt_id:randomUUID()});await f.settle();
  f.respond(3,status({enabled:true,version:1,connection_version:306}));await f.settle();
  f.click('停用后台续签');await f.settle();const disable=JSON.parse(f.requests[4].options.body);
  assert.ok(f.confirmations[1].includes(connection.root_name));
  assert.equal(disable.base_version,306);assert.equal(disable.delegation_version,1);assert.equal('until_revoked' in disable,false);
  assert.notEqual(disable.idempotency_key,enable.idempotency_key);
  f.respond(4,{status:'committed',receipt_id:randomUUID()});await f.settle();f.respond(5,status({version:2,connection_version:306}));await f.settle();
  assert.ok(f.text().includes('设置已确认'));assert.equal(f.requests.length,6);
});
test('same-account TOKEN_REFRESHED during getSession/request preserves a live renewal read and its CAS view',async t=>{
  const f=await ready(t);f.refreshOnNextSession();f.click('查询续签状态');await f.settle();
  assert.equal(f.requests[1].url,'/v1/storage/refresh');
  f.emit('TOKEN_REFRESHED');await f.settle();assert.equal(f.requests.length,2);
  f.respond(1,status({version:7}));await f.settle();f.click('授权开启后台续签');await f.settle();
  assert.equal(JSON.parse(f.requests[2].options.body).delegation_version,7);
});
test('account switch drops an in-flight enable result and never sends its followup status under the new account',async t=>{
  const f=await queried(t);f.click('授权开启后台续签');await f.settle();
  f.emit('SIGNED_IN','owner-B');await f.settle();assert.equal(f.requests.length,4);
  f.respond(2,{status:'committed',receipt_id:randomUUID()});f.respond(3,{connections:[]});await f.settle();
  assert.equal(f.requests.length,4);assert.equal(f.text().includes(connection.root_name),false);assert.equal(f.text().includes('设置已确认'),false);
  assert.equal(f.requests[3].options.headers.authorization,'Bearer synthetic-native-owner-B');
});
test('same-account logout/relogin still invalidates old renewal results',async t=>{
  const f=await ready(t);f.click('查询续签状态');await f.settle();
  f.emit('SIGNED_OUT',null);f.emit('SIGNED_IN','owner-A');await f.settle();
  f.respond(1,status({enabled:true}));await f.settle();assert.equal(f.text().includes('后台续签已开启'),false);
});
test('404 is shown as unavailable service; other failures stay unconfirmed and do not retry mutation/status',async t=>{
  for(const httpStatus of [404,403,503]){
    const f=await ready(t);f.click('查询续签状态');await f.settle();f.respond(1,{error:'unsafe server body'},httpStatus);await f.settle();
    assert.equal(f.requests.length,2);assert.equal(f.text().includes('unsafe server body'),false);
    assert.equal(f.text().includes('后台续签服务暂未开放'),httpStatus===404);
    assert.equal(f.text().includes('授权开启后台续签'),false);
  }
  const f=await queried(t);f.click('授权开启后台续签');await f.settle();f.respond(2,{},503);await f.settle();
  assert.equal(f.requests.length,3);assert.equal(f.text().includes('设置已确认'),false);
});
test('uncommitted mutation and malformed renewal status cannot become a successful setting or reusable CAS',async t=>{
  const f=await queried(t);f.click('授权开启后台续签');await f.settle();f.respond(2,{status:'denied'});await f.settle();
  assert.equal(f.requests.length,3);assert.equal(f.text().includes('设置已确认'),false);assert.equal(f.text().includes('授权开启后台续签'),false);
  const badReceipt=await queried(t);badReceipt.click('授权开启后台续签');await badReceipt.settle();
  badReceipt.respond(2,{status:'committed',receipt_id:'a'.repeat(36)});await badReceipt.settle();
  assert.equal(badReceipt.requests.length,3);assert.equal(badReceipt.text().includes('设置已确认'),false);
  assert.equal(badReceipt.text().includes('授权开启后台续签'),false);
  const malformed=await ready(t);malformed.click('查询续签状态');await malformed.settle();malformed.respond(1,status({version:-1}));await malformed.settle();
  assert.equal(malformed.text().includes('授权开启后台续签'),false);
  const unchanged=await queried(t);unchanged.click('授权开启后台续签');await unchanged.settle();
  unchanged.respond(2,{status:'committed',receipt_id:randomUUID()});await unchanged.settle();unchanged.respond(3,status());await unchanged.settle();
  assert.equal(unchanged.text().includes('设置已确认'),false);assert.equal(unchanged.requests.length,4);
});
