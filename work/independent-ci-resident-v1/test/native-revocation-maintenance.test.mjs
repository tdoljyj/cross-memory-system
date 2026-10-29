import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WindowsEngine,parseStageFact } from '../src/engine-windows.mjs';
import { canonicalJson,sha256 } from '../src/canonical.mjs';
import { RevocationMaintenanceBook,validateRevocationFacts,validateRevocationQualification,
  REVOCATION_FACTS_CONTRACT,REVOCATION_QUALIFICATION_CONTRACT,REVOCATION_PENDING_STATE,REVOCATION_BACKOFF_MS } from '../src/revocation-maintenance.mjs';
import { TEST_NODE,TEST_NODE_SHA,CI_SOURCE,tempRoot,executorFixture,fakeEngine,triggerBytes } from './helpers.mjs';

const now=Date.parse('2026-10-29T06:00:00Z');
const qualification=(overrides={})=>({contract:REVOCATION_QUALIFICATION_CONTRACT,qualificationRef:'receipt:'+randomUUID(),
  sourceManifestSha256:CI_SOURCE,allowWhileHalted:true,validUntil:null,...overrides});
const facts=(pending=0)=>({contract:REVOCATION_FACTS_CONTRACT,pending,reconciled:2,notSent:1,acknowledged:pending?0:1,complete:pending===0});
const stageFact=(manifest,pending=0,extra={})=>({contract:'clued.independent-ci.resident-stage-fact/2',stage:12,nonce:'a'.repeat(32),manifest_sha256:manifest,
  state:pending?REVOCATION_PENDING_STATE:'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION',failure_code:null,scm_start_call_issued:true,
  original_binary_restored:true,complete_original_readback:true,configuration_conflict_detected:false,tree_cleanup_confirmed:true,tree_active_processes:0,
  root_exit_confirmed:true,native_receipt_sha256:'f'.repeat(64),revocation:facts(pending),maintenancePending:pending>0,
  outcome:{status:pending?'PENDING':'REVOCATION_MAINTENANCE',reason:null,sideEffects:3,mayHavePublished:true},...extra});
const SC_QC='BINARY_PATH_NAME : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\nSTART_TYPE : 3 DEMAND_START\r\nSERVICE_START_NAME : .\\clued-control\r\n';
const SC_Q='STATE : 1 STOPPED\r\nPID : 0\r\n';
function maintenanceEngine({pending=0,qualified=true,allowWhileHalted=true,unknown=false,deferred=false}={}){
  const engine=fakeEngine(),runs=[];
  engine.revocationMaintenanceQualification=async()=>qualified?qualification({allowWhileHalted}):null;
  engine.runRevocationMaintenance=async({runKey,runId})=>{
    runs.push({runKey,runId});
    if(deferred)return {ok:false,deferred:true,code:'REVOCATION_MAINTENANCE_BUSY'};
    if(unknown)return {ok:false,code:'STAGE_INVOKER_TERMINAL_UNCONFIRMED',proof:{windowsTreeZero:false,serviceOriginalStopped:false},runId};
    return {ok:true,runId,proof:{windowsTreeZero:true,serviceOriginalStopped:true},revocation:facts(pending),maintenancePending:pending>0,
      outcome:{status:pending?'PENDING':'REVOCATION_MAINTENANCE',reason:null,sideEffects:3,mayHavePublished:true}};
  };
  return {engine,runs};
}

test('maintenance facts have an exact bounded shape; pending cannot claim completion',()=>{
  assert.equal(validateRevocationFacts(facts(2)).complete,false);
  for(const value of [{...facts(1),complete:true},{...facts(),pending:-1},{...facts(),acknowledged:100001},{...facts(),extra:true}])assert.throws(()=>validateRevocationFacts(value));
});

test('a qualification must name the exact current Source, a real reference shape and enough remaining time',()=>{
  assert.equal(validateRevocationQualification(qualification(),{sourceManifestSha256:CI_SOURCE,now}).allowWhileHalted,true);
  for(const value of [qualification({sourceManifestSha256:'0'.repeat(64)}),qualification({qualificationRef:'made-up'}),
    qualification({validUntil:new Date(now+479999).toISOString()}),qualification({allowWhileHalted:'true'}),{...qualification(),extra:true}])
    assert.throws(()=>validateRevocationQualification(value,{sourceManifestSha256:CI_SOURCE,now}));
});

test('pending backoff is bounded, survives restart, and never opens an unknown helper',()=>{
  const book=new RevocationMaintenanceBook();let at=now;
  for(let i=0;i<8;i++){
    const runId='a'.repeat(16)+'-'+i.toString(16).padStart(12,'0');
    book.observe({now:at,runId,pending:true});assert.equal(book.nextAt-at,REVOCATION_BACKOFF_MS[Math.min(i,4)]);assert.equal(book.due(at),false);at=book.nextAt;
  }
  const restored=new RevocationMaintenanceBook();restored.restore(book.snapshot());assert.equal(restored.due(at),true);
  restored.observe({now:at,runId:'b'.repeat(16)+'-'+'c'.repeat(12),blocked:true});assert.equal(restored.due(at+86400000),false);
  const again=new RevocationMaintenanceBook();again.restore(restored.snapshot());assert.equal(again.blocked,true);
});

test('stage12 pending is a safe physical ending but remains explicitly incomplete',()=>{
  const manifest='a'.repeat(64),r=parseStageFact(JSON.stringify(stageFact(manifest,2)),manifest);
  assert.equal(r.ok,true);assert.equal(r.maintenancePending,true);assert.equal(r.revocation.complete,false);assert.equal(r.outcome.status,'PENDING');
  for(const change of [f=>f.revocation.complete=true,f=>f.maintenancePending=false,f=>f.outcome.status='REVOCATION_MAINTENANCE',
    f=>f.native_receipt_sha256=null,f=>f.scm_start_call_issued=false,f=>f.tree_active_processes=1,f=>f.contract=undefined]){
    const f=stageFact(manifest,2);change(f);assert.equal(parseStageFact(JSON.stringify(f),manifest).ok,false);
  }
});

test('the real Windows engine uses the read-only qualification CLI and fixed stage12 argv without batch/Linux work',async t=>{
  const root=await tempRoot(t),sourceRoot=path.join(root,'source',CI_SOURCE),v2=path.join(sourceRoot,'work','actions-hosted-migration','independent-ci-v1','src','resident-v2');
  await fs.mkdir(v2,{recursive:true});await fs.writeFile(path.join(v2,'invoke-stage.mjs'),'// fixture');
  const calls=[],q=qualification();
  const run=async argv=>{
    calls.push(argv);
    if(argv[0].endsWith('sc.exe'))return {code:0,stdout:argv[1]==='qc'?SC_QC:SC_Q};
    if(argv.includes('--revocation-maintenance-qualification'))return {code:0,stdout:JSON.stringify({qualified:true,qualification:q,sourceManifestSha256:CI_SOURCE})};
    const at=k=>argv[argv.indexOf(k)+1];
    const manifest=sha256(Buffer.from(canonicalJson({contract:'clued.independent-ci.revocation-maintenance-intent/1',runKey:at('--run-key'),runId:at('--run-id'),nodeProfileSha256:TEST_NODE_SHA})));
    return {code:0,stdout:JSON.stringify(stageFact(manifest,1))};
  };
  const engine=new WindowsEngine({node:TEST_NODE,nodeProfileSha256:TEST_NODE_SHA,run,busy:()=>false,clock:()=>now,
    paths:{sourceRoot,nodeExe:'C:\\resident\\node.exe',scExe:'C:\\Windows\\sc.exe'}});
  const runKey='b'.repeat(64),runId='b'.repeat(16)+'-'+'c'.repeat(12),r=await engine.runRevocationMaintenance({runKey,runId});
  assert.equal(r.ok,true);assert.equal(r.maintenancePending,true);assert.equal(r.runId,runId);
  assert.deepEqual(calls.find(a=>a.includes('--revocation-maintenance')).slice(2),['--revocation-maintenance','--run-key',runKey,'--run-id',runId,'--node-profile-sha256',TEST_NODE_SHA]);
  assert.equal(calls.some(a=>a.includes('--batch-dir')||a.includes('--subject-json')),false);
  engine.busy=()=>true;const before=calls.length;
  assert.equal((await engine.runRevocationMaintenance({runKey,runId})).code,'REVOCATION_MAINTENANCE_BUSY');assert.equal(calls.length,before);
});

test('missing Source qualification leaves ordinary CI behavior unchanged and writes no maintenance intent',async t=>{
  const m=maintenanceEngine({qualified:false}),f=await executorFixture(t,{engine:m.engine});await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state,'COMPLETED');assert.equal(m.runs.length,0);
  assert.equal((await f.receipts.latest(['revocation-maintenance-intent'],2)).length,0);
});

test('automatic maintenance has unique durable intent/result, no PR ledger or CI budget, and bounded pending retry',async t=>{
  const m=maintenanceEngine({pending:2}),f=await executorFixture(t,{engine:m.engine});
  assert.equal((await f.exec.tick()).reason,'REVOCATION_MAINTENANCE_PENDING');assert.equal(m.runs.length,1);
  assert.deepEqual(await f.ledger.open(),[]);assert.equal((await f.receipts.latest(['batch-reserved'],5)).length,0);
  assert.equal((await f.receipts.latest(['revocation-maintenance-intent','revocation-maintenance-result'],4)).length,2);
  await f.exec.tick();assert.equal(m.runs.length,1);f.advance(60001);await f.exec.tick();assert.equal(m.runs.length,2);
  assert.notEqual(m.runs[0].runId,m.runs[1].runId);assert.notEqual(m.runs[0].runKey,m.runs[1].runKey);
  f.advance(60001);await f.exec.tick();assert.equal(m.runs.length,2);
});

test('explicitly qualified revocation can run during HALT while preserving the exact original latch',async t=>{
  const m=maintenanceEngine({pending:1}),f=await executorFixture(t,{engine:m.engine});await f.ledger.halt('ORIGINAL_UNKNOWN_SCENE',{});
  const before=await f.ledger.halted(),r=await f.exec.tick(),after=await f.ledger.halted();
  assert.equal(r.state,'HALTED');assert.equal(r.failureCode,'ORIGINAL_UNKNOWN_SCENE');assert.equal(r.maintenancePending,true);
  assert.equal(after.sha256,before.sha256);assert.equal(m.runs.length,1);assert.equal(m.engine.calls.length,0);
});

test('a generic Source qualification without allowWhileHalted cannot run through HALT',async t=>{
  const m=maintenanceEngine({allowWhileHalted:false}),f=await executorFixture(t,{engine:m.engine});await f.ledger.halt('ORIGINAL_UNKNOWN_SCENE',{});
  assert.equal((await f.exec.tick()).state,'HALTED');assert.equal(m.runs.length,0);
});

test('an unknown helper ending is latched and is not reopened by a later tick or process',async t=>{
  const m=maintenanceEngine({unknown:true}),f=await executorFixture(t,{engine:m.engine});
  assert.equal((await f.exec.tick()).state,'HALTED');assert.equal(m.runs.length,1);f.advance(86400000);await f.exec.tick();assert.equal(m.runs.length,1);
  const restarted=await executorFixture(t,{root:f.root,engine:m.engine,now:f.clock()});
  assert.equal((await restarted.exec.tick()).state,'HALTED');assert.equal(m.runs.length,1);
});

test('an interrupted persistent intent blocks a second helper even if its Source is now qualified',async t=>{
  const m=maintenanceEngine(),f=await executorFixture(t,{engine:m.engine});
  await f.receipts.append('revocation-maintenance-intent',{runKey:'a'.repeat(64),runId:'a'.repeat(16)+'-'+'c'.repeat(12)});
  assert.equal((await f.exec.tick()).failureCode,'REVOCATION_MAINTENANCE_INTERRUPTED');assert.equal(m.runs.length,0);
});

test('a lost final receipt write retains an open intent and cannot dispatch a fresh helper',async t=>{
  const m=maintenanceEngine(),f=await executorFixture(t,{engine:m.engine}),append=f.receipts.append.bind(f.receipts);let injected=false;
  f.receipts.append=async(type,body)=>{if(type==='revocation-maintenance-result'&&!injected){injected=true;throw Error('lost final receipt write');}return append(type,body);};
  assert.equal((await f.exec.tick()).state,'HALTED');assert.equal(m.runs.length,1);f.advance(86400000);
  assert.equal((await f.exec.tick()).state,'HALTED');assert.equal(m.runs.length,1);
});

test('a pre-broker busy guard closes only its maintenance intent and does not latch HALT or spend a CI batch',async t=>{
  const m=maintenanceEngine({deferred:true}),f=await executorFixture(t,{engine:m.engine});
  const r=await f.exec.tick();assert.equal(r.state,'DEFERRED');assert.equal(r.reason,'REVOCATION_MAINTENANCE_BUSY');assert.equal(await f.ledger.halted(),null);
  assert.equal((await f.receipts.latest(['revocation-maintenance-result'],1))[0].value.body.deferred,true);
  assert.equal((await f.receipts.latest(['batch-reserved'],1)).length,0);
});
