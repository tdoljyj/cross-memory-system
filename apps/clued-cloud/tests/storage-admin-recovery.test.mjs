// Exercise the real page's server-response parser and displayed recovery copy.
// No browser login, live service or synthetic production recovery is involved.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {build,stop} from 'esbuild';
import {fileURLToPath} from 'node:url';

const bundled=await build({entryPoints:[fileURLToPath(new URL('../worker/storage-recovery-diagnostics.ts',import.meta.url))],
 bundle:true,platform:'node',format:'esm',write:false});
const {storageRecoveryListResult,storageRecoveryOwnerResult}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
stop();

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

test('real Native list and inspect sanitizers preserve trash state through the actual page parser',()=>{
 const raw={...response('trashed'),connection_id:randomUUID(),execution_permitted:false};
 const inspected=storageRecoveryOwnerResult(raw,{connection_id:raw.connection_id,job_id:raw.job_id});
 const listed=storageRecoveryListResult({status:'ok',connection_id:raw.connection_id,jobs:[raw],execution_permitted:false},raw.connection_id);
 for(const result of [inspected,...listed.jobs]){
  assert.equal(result.current_artifact_state,'trashed');
  const view=recoveryView(result);assert.ok(view);assert.match(recoveryTitle(view),/Google 回收站/);
  assert.doesNotMatch(recoveryTitle(view),/恢复使用/);
 }
 for(const change of [v=>v.current_artifact_state='deleted',v=>v.current_artifact_state=null,
  v=>v.resolution='automatically_reconciled_before',v=>{v.status='conflict';v.automatic_recovery='pending';}]){
  const bad=structuredClone(raw);change(bad);
  assert.throws(()=>storageRecoveryOwnerResult(bad,{connection_id:bad.connection_id,job_id:bad.job_id}),/storage_recovery_response_invalid/);
  assert.throws(()=>storageRecoveryListResult({status:'ok',connection_id:bad.connection_id,jobs:[bad],execution_permitted:false},bad.connection_id),/storage_recovery_response_invalid/);
 }
});

test('actual Native list and inspect retain a validated current location through the page parser and text',()=>{
 const raw={...response('active'),connection_id:randomUUID(),execution_permitted:false,current_path:'G:/资料中心/assets/当前位置'};
 const owner=storageRecoveryOwnerResult(raw,{connection_id:raw.connection_id,job_id:raw.job_id});
 const list=storageRecoveryListResult({status:'ok',connection_id:raw.connection_id,jobs:[raw],execution_permitted:false},raw.connection_id);
 for(const value of [owner,...list.jobs]){
  assert.equal(value.current_path,raw.current_path);const view=recoveryView(value);assert.ok(view);
  assert.equal(view.current_path,raw.current_path);assert.match(recoveryExplanation(view),/当前位置/);
 }
 for(const change of [v=>v.current_path='../escape',v=>v.current_path='G:/Root/../other',v=>v.current_path='G:/Root/\nsecret',
  v=>v.current_path=42,v=>v.current_artifact_state='trashed',v=>delete v.current_artifact_state]){
  const bad=structuredClone(raw);change(bad);
  assert.throws(()=>storageRecoveryOwnerResult(bad,{connection_id:raw.connection_id,job_id:raw.job_id}),/storage_recovery_response_invalid/);
  assert.equal(recoveryView(bad),null);
 }
});

for(const bad of ['deleted','true',true,null,{},[],['trashed'],['active']])test('unsupported directory state '+JSON.stringify(bad)+' cannot become a recovery result',()=>{
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
