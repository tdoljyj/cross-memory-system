import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/imprints');
const id = '11111111-1111-4111-8111-111111111111', targetId = '22222222-2222-4222-8222-222222222222';
const context = '33333333-3333-4333-8333-333333333333';
const plain = value => JSON.parse(JSON.stringify(value));
const record = (extra = {}) => ({ id, title: '混合印记', content: '😀说明\r\n周五交方案，已经决定采用A，因为成本低。', version: 1,
  scope: 'global', record_type: 'note', record_schema_version: 1, lifecycle_status: 'active', authoritative: true,
  record_currentness: 'CURRENT', association_version: 0, associations: [], organization_version: 0,
  domains: [], source_refs: [], type_fields: {}, relations: {}, ...extra });
function modules(React = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    vm.runInNewContext(compiled, { exports, crypto: webcrypto, TextEncoder, Date, Intl, Map, Set, AbortController,
      setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, require(name) {
        if (name === 'react') return React;
        if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
        if (name.startsWith('.')) { const base = path.resolve(path.dirname(file), name); return load(existsSync(base+'.ts') ? base+'.ts' : base+'.tsx'); }
        throw Error(name);
      } }, { filename: file });
    return exports;
  }
  return name => load(path.join(root, name));
}
test('exact source slot and Unicode slice bind extraction; JSON metadata and foreign Context never become owner text', async () => {
  const load = modules(), client = load('imprint-extraction.ts'), saved = record();
  const source = { start: saved.content.indexOf('周五'), end: saved.content.indexOf('，'), text: '周五交方案' };
  const input = plain(await client.extractionInput(saved, { slot:'content', text:saved.content }, source, 'task', randomUUID()));
  assert.equal(input.source.start, [...saved.content.slice(0, source.start)].length);
  assert.equal(input.source.end-input.source.start, [...source.text].length);
  assert.equal(input.source.quote, source.text); assert.equal(input.owner_text_confirmed, true);
  const raw = record({ source_kind:'development', record_currentness:'UNKNOWN', lifecycle_status:'ACTIVE', authoritative:false,
    context_id:context, body:{ metadata:'我将删除文件。', content:'我将整理报告。', text:'另一个正文槽位' } });
  assert.deepEqual(plain(client.extractionTexts(raw)), [{slot:'content',text:'我将整理报告。'},{slot:'text',text:'另一个正文槽位'}]);
  assert.deepEqual(plain(client.extractionTexts({...raw,body:{ metadata:'我将删除文件。' }})), []);
  await assert.rejects(client.extractionInput(raw,{slot:'content',text:raw.content},source,'task',randomUUID(),context), /unavailable/);
  await assert.rejects(client.extractionInput(saved,{slot:'content',text:saved.content},{...source,text:'假的片段'},'task',randomUUID()), /unavailable/);
  await assert.rejects(client.extractionInput(saved,{slot:'content',text:saved.content},source,'task',randomUUID(),context), /unavailable/);
});

function fixture(initial = record()) {
  let active, cursor, tree, dirty, props, effects = [];
  const hooks = new Map(), calls = [], seen = new Set(), notices = [];
  const equal = (a,b) => a && b && a.length===b.length && a.every((x,i)=>Object.is(x,b[i]));
  const React = {
    useState(value) { const index=cursor++; active[index] ??= {value: typeof value==='function'?value():value}; const hook=active[index]; return [hook.value, next=>{hook.value=typeof next==='function'?next(hook.value):next;dirty=true;}]; },
    useRef(value) { const index=cursor++; return active[index] ??= {current:value}; },
    useMemo(make,deps) { const index=cursor++; if(!active[index]||!equal(active[index].deps,deps))active[index]={deps,value:make()};return active[index].value; },
    useLayoutEffect(make,deps) { const index=cursor++; if(!active[index]||!equal(active[index].deps,deps)){const old=active[index],hook={deps};active[index]=hook;effects.push(()=>{old?.cleanup?.();hook.cleanup=make();});} },
  };
  const load=modules(React), Editor=load('MixedContentEditor.tsx').default;
  props={record:initial,selection:{},owner:'owner',rpc(name,args){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});calls.push({name,args,resolve,reject});return promise;},locale:'zh-CN',onCommitted:message=>notices.push(message),onRelated:()=>{}};
  function render(){let turns=0;do{dirty=false;seen.clear();function expand(node,key='root'){
    if(Array.isArray(node))return node.map((n,i)=>expand(n,key+'/'+(n?.key??i)));
    if(!node||typeof node!=='object')return node;
    if(typeof node.type==='function'){const name=key+':'+node.type.name+':'+(node.key??'');seen.add(name);if(!hooks.has(name))hooks.set(name,[]);const prev=active,pos=cursor;active=hooks.get(name);cursor=0;const child=node.type(node.props);active=prev;cursor=pos;return expand(child,name);}
    return {...node,props:{...node.props,children:expand(node.props?.children,key+'/'+node.type)}};
  }tree=expand({type:Editor,props});for(const [key,values]of hooks)if(!seen.has(key)){values.forEach(h=>h?.cleanup?.());hooks.delete(key);}while(effects.length)effects.shift()();if(++turns>20)throw Error('render loop');}while(dirty);}
  function nodes(type){const out=[];function visit(n){if(Array.isArray(n))return n.forEach(visit);if(!n||typeof n!=='object')return;if(n.type===type)out.push(n);visit(n.props?.children);}visit(tree);return out;}
  function text(n){if(arguments.length===0)n=tree;if(Array.isArray(n))return n.map(text).join('');return !n||typeof n==='boolean'?'':typeof n==='object'?text(n.props?.children??null):String(n);}
  function click(label){const b=nodes('button').find(n=>text(n)===label);assert.ok(b,label);assert.equal(!!b.props.disabled,false,label);b.props.onClick();render();}
  function change(node,payload){assert.equal(!!node.props.disabled,false,'control must be enabled');node.props.onChange({target:payload});render();}
  async function settle(){for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));render();}
  async function until(count){const deadline=Date.now()+3000;while(calls.length<count&&Date.now()<deadline)await settle();assert.equal(calls.length,count);await settle();}
  render();return {calls,notices,nodes,text,click,change,settle,until,load,
    async reply(index,data){calls[index].resolve({data,error:null});await settle();},async fail(index){calls[index].reject(Error('lost response'));await settle();},
    replace(record){props={...props,record,selection:{}};render();},rerender(){props={...props,rpc:props.rpc.bind(null)};render();},
  };
}
const candidate = (extra={}) => ({candidate_id:context,candidate_version:1,candidate_status:'pending',scope:'global',kind:'task',record_id:null,record_version:null,promotion_receipt_id:null,...extra});
const prepared = item => ({status:'committed',receipt_id:randomUUID(),supplemental:item});
const view = () => ({status:'issued',candidate_id:context,candidate_version:1,record_id:targetId,confirmation_token:'synthetic-token',view_digest:'a'.repeat(64),expires_at:'2099-01-01T00:00:00Z',
  confirmation_view:{id:targetId,record_type:'task',scope:'global',mutation:{title:'服务确认标题',content:'周五交方案',type_fields:{execution_bucket:'later'}}}});
function selectTask(f){f.change(f.nodes('input').find(n=>n.props.type==='checkbox'),{checked:true});f.click('查看可提取片段');f.change(f.nodes('input').find(n=>n.props.type==='radio'),{checked:true});f.change(f.nodes('select')[0],{value:'later'});}
test('real extraction component: read-only suggestions, explicit final view, stable lost-response retry and one recovered record', async () => {
  const f=fixture();selectTask(f);assert.equal(f.calls.length,0,'local preview has no persistent effect');
  f.click('准备候选并核对正式条目');await f.until(1);assert.equal(f.calls[0].name,'clued_imprint_extraction_prepare_v1');
  await f.reply(0,prepared(candidate()));await f.until(2);assert.equal(f.calls[1].name,'clued_candidate_confirmation_issue_v1');
  await f.reply(1,view());assert.ok(f.text().includes('服务确认标题'),'actual service view shown');assert.equal(f.calls.length,2,'issue never promotes automatically');
  f.rerender();assert.ok(f.text().includes('服务确认标题'),'unrelated parent rerender does not erase confirmation');
  f.click('确认生成正式条目');await f.until(3);const original=plain(f.calls[2].args);await f.fail(2);
  assert.ok(f.text().includes('结果未能确认'));f.click('确认生成正式条目');await f.until(4);
  assert.deepEqual(plain(f.calls[3].args),original,'same token/key/hash, no new confirmation');
  await f.reply(3,{status:'committed',receipt_id:randomUUID()});await f.until(5);
  assert.equal(f.calls[4].name,'clued_imprint_extraction_status_v1','terminal recovery never revalidates a changed original');
  await f.reply(4,{status:'ok',extraction:candidate({candidate_status:'promoted',candidate_version:2,record_id:targetId,record_version:1,promotion_receipt_id:randomUUID()})});
  assert.ok(f.text().includes('已生成，同一片段不会重复创建'));assert.ok(f.nodes('button').some(n=>f.text(n)==='把生成条目关联到原文'));
  assert.equal(f.calls.filter(c=>c.name==='clued_candidate_confirmation_issue_v1').length,1);
});
test('late prepare replies cannot issue, promote or announce success after source/session selection changes', async () => {
  const f=fixture();selectTask(f);f.click('准备候选并核对正式条目');await f.until(1);
  f.replace(record({id:targetId,content:'Different source'}));await f.reply(0,prepared(candidate()));
  assert.equal(f.calls.length,1);assert.equal(f.notices.length,0);assert.ok(!f.text().includes('服务确认标题'));
});
test('unknown prepare freezes source/fragment changes and recovers the exact original attempt', async () => {
  const f=fixture();selectTask(f);f.click('准备候选并核对正式条目');await f.until(1);const original=plain(f.calls[0].args);await f.fail(0);
  assert.ok(f.nodes('input').filter(n=>n.props.type==='radio'||n.props.type==='checkbox').every(n=>n.props.disabled));
  assert.equal(f.nodes('button').find(n=>f.text(n)==='查看可提取片段').props.disabled,true);
  f.click('准备候选并核对正式条目');await f.until(2);assert.deepEqual(plain(f.calls[1].args),original);
  await f.reply(1,prepared(candidate()));await f.until(3);await f.reply(2,view());assert.ok(f.text().includes('服务确认标题'));
  assert.equal(f.calls.filter(c=>c.name==='clued_imprint_extraction_prepare_v1').length,2);
});
