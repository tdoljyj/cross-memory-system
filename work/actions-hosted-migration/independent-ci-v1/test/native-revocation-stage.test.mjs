import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical } from '../src/proof.mjs';
import { hash } from '../src/resident-v2/prepare-record.mjs';
import { makeRevocationRun, validateRevocationRun, revocationRunId, validateRevocationFacts, revocationQualification } from '../src/resident-v2/revocation-run.mjs';
import { invokeRevocationMaintenance } from '../src/resident-v2/invoke-stage.mjs';
import { loadStageInputs, writeOutcome } from '../src/resident-v2/stage-inputs.mjs';
import { validatePlanV2 } from '../src/resident-v2/stage-package.mjs';
import { OUTCOME_CONTRACT, stageByNumber } from '../src/resident-v2/layout.mjs';
import { NATIVE_RECEIPT_CONTRACT_V2 } from '../src/resident-v2/stage-fact.mjs';
import { BROKER_RESPONSE_CONTRACT, validateBrokerRequest } from '../src/resident-v2/broker-protocol.mjs';
import { NOW, fixtureRecord, tempDir } from './resident-v2-fixtures.mjs';
const key='a'.repeat(64),runId=key.slice(0,16)+'-'+'b'.repeat(12);
const summary=pending=>({contract:'clued.independent-ci.revocation-maintenance-facts/1',pending,reconciled:2,notSent:1,acknowledged:1,complete:pending===0});
function qualify(rec){
  const accepted=JSON.parse(rec.docs['acceptance.json']),config=JSON.parse(rec.docs['installation.json']);
  accepted.revocationMaintenanceQualification={contract:'clued.independent-ci.revocation-maintenance-qualification/1',qualificationRef:'receipt:11111111-2222-4333-8444-555555555555',
    sourceManifestSha256:config.sourceManifestSha256,allowWhileHalted:false,validUntil:null};
  config.acceptanceSha256=hash(canonical(accepted));
  return {...rec,docs:{...rec.docs,'acceptance.json':Buffer.from(canonical(accepted)),'installation.json':Buffer.from(canonical(config))}};
}
async function fixture(t,qualified=true){
  const root=await tempDir(t),base=fixtureRecord(),rec=qualified?qualify(base):base;
  const roots={stageRoot:path.join(root,'stage'),brokerRoot:path.join(root,'broker'),receiptsRoot:path.join(root,'receipts')};
  for(const dir of [roots.stageRoot,roots.receiptsRoot,path.join(roots.brokerRoot,'requests'),path.join(roots.brokerRoot,'responses')])await fs.mkdir(dir,{recursive:true});
  return {root,rec,roots,nodeProfileSha256:hash(rec.inputs.node)};
}
function broker(f,{pending=0,badJob=false,badHash=false,tree=true}={}){
  const seen=new Set();
  return async()=>{
    for(const file of await fs.readdir(path.join(f.roots.brokerRoot,'requests'))){
      if(seen.has(file))continue;seen.add(file);
      const request=JSON.parse(await fs.readFile(path.join(f.roots.brokerRoot,'requests',file),'utf8'));
      validateBrokerRequest(request,NOW);assert.equal(request.stage,12);
      const plan=JSON.parse(await fs.readFile(path.join(f.roots.stageRoot,request.nonce,'formal-service-entry.json'),'utf8'));
      const inputs=await loadStageInputs({nonce:request.nonce,configSha256:request.configSha256,entryRole:'revocation-maintenance',recordDocs:f.rec.docs,stageRoot:f.roots.stageRoot,now:NOW});
      assert.equal(inputs.resultEnvelope,null);assert.equal(inputs.jobs[0].contract,'clued.independent-ci.revocation-maintenance-run/1');
      const outcome=await writeOutcome({receiptsRoot:f.roots.receiptsRoot,nonce:request.nonce,plan,jobIds:[badJob?'f'.repeat(64):inputs.jobs[0].id],clock:()=>NOW,
        result:{status:pending?'PENDING':'REVOCATION_MAINTENANCE',sideEffects:4,revocation:summary(pending)}});
      const outcomeBytes=Buffer.from(canonical(outcome)+'\n');
      const receipt={contract:NATIVE_RECEIPT_CONTRACT_V2,nonce:request.nonce,state:'FIXED_CHILD_COMPLETED',failure_code:null,actual_sid:f.rec.inputs.node.controllerSid,
        service_pid:4242,session_id:0,node_pid:77,node_exit_code:0,timed_out:false,stop_requested:false,tree_cleanup_confirmed:tree,tree_cleanup_failure_code:null,
        tree_active_processes:tree?0:1,root_exit_confirmed:tree,entry_role:plan.entryRole,stage:12,entry_sha256:plan.entrySha256,config_sha256:request.configSha256,
        acceptance_sha256:plan.acceptanceSha256,source_manifest_sha256:plan.sourceManifestSha256,outcome_sha256:badHash?'0'.repeat(64):hash(outcomeBytes),
        stdout_captured:false,private_bytes_read_by_helper:false,host_qualification:false,ci_principal_qualification:false};
      await fs.writeFile(path.join(f.roots.receiptsRoot,`windows-formal-entry-${request.nonce}.json`),JSON.stringify(receipt),{flag:'wx'});
      const response={contract:BROKER_RESPONSE_CONTRACT,requestId:file.slice(0,-5),ok:true,code:null,started:true,startCallIssued:true,helperPid:4242,
        stoppedInTime:true,restored:true,accountUnchanged:true,stableBefore:true,stableAfter:true,configurationConflict:false};
      await fs.writeFile(path.join(f.roots.brokerRoot,'responses',file),JSON.stringify(response),{flag:'wx'});
    }
  };
}
async function invoke(f,handler){let now=NOW;return invokeRevocationMaintenance({runKey:key,runId,nodeProfileSha256:f.nodeProfileSha256,...f.roots,recordDocs:f.rec.docs,
  clock:()=>now,sleep:async ms=>{now+=ms;await handler();}});}

test('stage12 run is domain-separated and rejects scanner/role-probe identities and extra authority',()=>{
  const job=makeRevocationRun({repo:'tdoljyj/cross-memory-system',runId,sourceManifestSha256:key,nodeProfileSha256:'c'.repeat(64),createdAt:new Date(NOW).toISOString()});
  assert.equal(job.id,revocationRunId(job));
  for(const edit of [j=>j.contract='clued.independent-ci.role-probe-run/1',j=>j.claim_id='fake',j=>j.nodeProfileSha256='d'.repeat(64),j=>j.repo='other/repo']){
    const bad=structuredClone(job);edit(bad);assert.throws(()=>validateRevocationRun(bad));
  }
  assert.equal(stageByNumber(12).runMilliseconds,300000);assert.equal(stageByNumber(10).runMilliseconds,300000);assert.equal(stageByNumber(11).runMilliseconds,60000);
});
test('maintenance summary cannot turn pending into complete or carry arbitrary details',()=>{
  assert.deepEqual(validateRevocationFacts(summary(0)),summary(0));
  for(const v of [{...summary(1),complete:true},{...summary(0),pending:-1},{...summary(0),secret:'no'}])assert.throws(()=>validateRevocationFacts(v));
});
test('real stage12 invoker and reader bind nonzero negative effects and original restoration',async t=>{
  const f=await fixture(t),fact=await invoke(f,broker(f));
  assert.equal(fact.state,'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION');assert.equal(fact.maintenancePending,false);
  assert.deepEqual(fact.revocation,summary(0));assert.equal(fact.outcome.sideEffects,4);assert.equal(fact.outcome.mayHavePublished,true);
});
test('pending maintenance is a distinct bound result, never all-drained completion',async t=>{
  const f=await fixture(t),fact=await invoke(f,broker(f,{pending:2}));
  assert.equal(fact.state,'REVOCATION_MAINTENANCE_PENDING_ORIGINAL_STOPPED_NO_QUALIFICATION');assert.equal(fact.maintenancePending,true);
  assert.equal(fact.revocation.complete,false);assert.equal(fact.revocation.pending,2);
});
test('wrong job, outcome hash or incomplete child cleanup never assert maintenance success',async t=>{
  for(const options of [{badJob:true},{badHash:true},{tree:false}]){
    const f=await fixture(t),fact=await invoke(f,broker(f,options));assert.ok(fact.failure_code);assert.equal(fact.revocation,undefined);
  }
});
test('missing qualification refuses before any broker request',async t=>{
  const f=await fixture(t,false),fact=await invoke(f,async()=>assert.fail('must not request broker'));
  assert.equal(fact.failure_code,'STAGE_PACKAGE_REFUSED');assert.deepEqual(await fs.readdir(path.join(f.roots.brokerRoot,'requests')),[]);
});
test('qualification is exact Source-bound, time-bounded and cannot confer HALT permission by omission',()=>{
  const rec=qualify(fixtureRecord()),accepted=JSON.parse(rec.docs['acceptance.json']),config=JSON.parse(rec.docs['installation.json']);
  const record={accepted,config};assert.equal(revocationQualification(record,{now:NOW}).allowWhileHalted,false);
  for(const patch of [{sourceManifestSha256:'f'.repeat(64)},{validUntil:new Date(NOW).toISOString()},{allowWhileHalted:'true'},{qualificationRef:'invented'}]){
    assert.equal(revocationQualification({config,accepted:{...accepted,revocationMaintenanceQualification:{...accepted.revocationMaintenanceQualification,...patch}}},{now:NOW}),null);
  }
});
test('C# public boundary validates the same maintenance run identity and fixed stage12 cap', {skip:process.platform!=='win32'},()=>{
  const dir=fileURLToPath(new URL('../src/resident-v2/windows/',import.meta.url));
  const job=makeRevocationRun({repo:'tdoljyj/cross-memory-system',runId,sourceManifestSha256:key,nodeProfileSha256:'c'.repeat(64),createdAt:new Date().toISOString()});
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const command=`$ErrorActionPreference='Stop'; Add-Type -Path ${quote(path.join(dir,'NodeProfileV2.cs'))},${quote(path.join(dir,'FormalPublicBoundaryV2.cs'))} -ReferencedAssemblies System.Web.Extensions; $j=New-Object 'System.Collections.Generic.Dictionary[string,object]'; $v=ConvertFrom-Json ${quote(JSON.stringify(job))}; foreach($p in $v.PSObject.Properties){$j.Add($p.Name,$p.Value)}; $x=[FormalPublicBoundaryV2]::ValidateRevocationRun($j,${quote(key)},${quote(runId)},${quote('c'.repeat(64))}); if([FormalPublicBoundaryV2]::StageMilliseconds[11] -ne 300000){throw 'cap'}; [FormalPublicBoundaryV2]::RevocationRunId($j)`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),job.id);
});
