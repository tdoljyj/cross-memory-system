// Exercise the real page's server-response parser and displayed recovery copy.
// No browser login, live service or synthetic production recovery is involved.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const page=readFileSync(new URL('../app/storage/admin/page.tsx',import.meta.url),'utf8');
const source=ts.transpileModule(page+'\nexport const recoveryTestApi={recoveryView,recoveryTitle,recoveryExplanation};',{
 compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText;
const exports={};
vm.runInNewContext(source,{exports,require(name){
 if(name==='react'||name==='react/jsx-runtime')return {};
 if(name==='next/link')return {__esModule:true,default:'a'};
 if(name.endsWith('/supabase-browser'))return {supabase:{}};
 throw Error(name);
}});
const {recoveryView,recoveryTitle,recoveryExplanation}=exports.recoveryTestApi;
const response=state=>({job_id:randomUUID(),status:'resolved',receipt_id:randomUUID(),source_receipt_id:randomUUID(),
 base_version:4,resolution:'automatically_registered_current_state',automatic_recovery:'resolved',current_artifact_state:state});

test('a trashed directory is shown as in the Google trash, without a usable-directory claim or confirmation',()=>{
 const view=recoveryView(response('trashed'));assert.ok(view);
 assert.equal(recoveryTitle(view),'目录在 Google 回收站，原作业已自动处理');
 assert.match(recoveryExplanation(view),/解除原作业占用，其他目录可正常使用/);
 assert.match(recoveryExplanation(view),/没有重新删除或恢复目录/);
 assert.doesNotMatch(recoveryTitle(view),/恢复使用/);
 assert.equal(view.review_available,undefined);assert.equal(view.abandon_available,undefined);
});

test('active current registration and earlier accepted responses keep their recovery presentation',()=>{
 const active=recoveryView(response('active'));assert.equal(recoveryTitle(active),'已自动恢复使用');
 const legacy=response(undefined);delete legacy.current_artifact_state;
 assert.equal(recoveryTitle(recoveryView(legacy)),'已自动恢复使用');
});

for(const bad of ['deleted','true',true,null,{},[]])test('unsupported directory state '+JSON.stringify(bad)+' cannot become a recovery result',()=>{
 assert.equal(recoveryView(response(bad)),null);
});

test('a state marker cannot replace independent settlement lineage or promote a pending job',()=>{
 for(const change of [v=>v.receipt_id=v.source_receipt_id,v=>v.base_version=0,v=>v.automatic_recovery='pending',
  v=>v.resolution='accepted_current_state',v=>delete v.source_receipt_id]){
  const value=response('trashed');change(value);assert.equal(recoveryView(value),null);
 }
 const pending=response('trashed');Object.assign(pending,{status:'conflict',automatic_recovery:'pending'});
 const view=recoveryView(pending);assert.ok(view);assert.equal(view.current_artifact_state,undefined);
 assert.equal(recoveryTitle(view),'系统正在自动恢复');
});
