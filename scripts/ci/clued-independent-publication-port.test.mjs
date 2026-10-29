import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EffectJournal } from '../../work/actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { makeJobV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { admittedFacts, subject } from '../../work/actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
import { digest } from '../../work/actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { createIndependentPublicationPort, isNativePublicationPort, nativePublicationNoPostProof, independentControllerId } from './clued-independent-publication-port.mjs';
const now=Date.parse('2026-10-29T05:00:00Z');
const controllerId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',pub='11111111-aaaa-4bbb-8ccc-222222222222',receipt='33333333-aaaa-4bbb-8ccc-444444444444';
async function fixture(t,active=true){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-port-unit-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const job=makeJobV2({...subject(),role:'gitleaks'}),claim={claimId:'11111111-2222-4333-8444-555555555555',fence:4,epoch:3,expiresAt:new Date(now+3600000).toISOString()};
 const packet={complete:true,pr:job.pr,headSha:job.headSha,baseSha:job.baseSha,paths:['scripts/ci/example.mjs']};
 let facts=admittedFacts(job,claim,packet,{batchClaim:claim,observedAt:now});
 if(active){delete facts.observationSha256;facts={...facts,contract:'clued.independent-ci.full-admission/3',executionPolicy:'active',guarded:true,
  publicationRequired:true,headAuthorizationId:controllerId};facts={...facts,observationSha256:digest(facts)};}
 const checks=[],commands=[];let current=true,posts=0,patches=0;
 const github={async createCheck(payload){posts++;const check={...structuredClone(payload),id:123,app:{id:5368905}};checks.push(check);return structuredClone(check);},
  async readCheck(id){return structuredClone(checks.find(c=>c.id===id));},async readChecks(){return {complete:true,checks:structuredClone(checks)};},
  async revokeCheck(id,payload){patches++;Object.assign(checks.find(c=>c.id===id),structuredClone(payload));return structuredClone(checks.find(c=>c.id===id));}};
 const native={async command(input){commands.push(input);return input.action==='publication_begin_independent'
  ? {status:'ok',verdict:'ADMITTED',execution_policy:'active',execution_authorized:true,publication_required:true,publication_id:pub,receipt_id:receipt,independent_identity:input.independent_identity}
  : {status:'committed',receipt_id:receipt,must_revoke:false};}};
 const port=createIndependentPublicationPort({job,controllerId,github,native,journal:await EffectJournal.open(directory),clock:()=>now,assertCurrent:async()=>current});
 const payload={name:'gitleaks',head_sha:job.headSha,status:'completed',conclusion:'success',external_id:`independent-ci:staged:v2:${job.id}:a1`,output:{title:'success',summary:'signed proof'}};
 return {port,job,facts,packet,payload,commands,setCurrent:v=>current=v,get posts(){return posts;},get patches(){return patches;}};
}
test('active facade requires an opaque prepared capability and binds the real Native ticket',async t=>{
 const f=await fixture(t);assert.equal(isNativePublicationPort(f.port),true);
 await assert.rejects(()=>f.port.createCheck(f.payload),/prepare_required/);assert.equal(f.posts,0);
 const handle=await f.port.prepareNativePublication({facts:f.facts,packet:f.packet,payload:f.payload});assert.equal(f.posts,0);
 const check=await f.port.createCheck(f.payload,handle);assert.equal(check.external_id,f.payload.external_id);assert.match(check.output.summary,new RegExp(pub));
 assert.deepEqual(f.commands.map(c=>c.action),['publication_begin_independent','publication_begin_independent','publication_finish']);assert.equal(f.posts,1);
});
test('legacy staged facade preserves the old path without issuing a Native publication',async t=>{
 const f=await fixture(t,false),handle=await f.port.prepareNativePublication({facts:f.facts,packet:f.packet,payload:f.payload});
 const check=await f.port.createCheck(f.payload,handle);assert.equal(handle.native,false);assert.equal(check.output.summary,f.payload.output.summary);
 assert.equal(f.commands.length,0);assert.equal(f.posts,1);
});
test('payload drift or handover after prepare is proven no-POST, not a forged JSON flag',async t=>{
 for(const mutate of [true,false]){
  const f=await fixture(t),handle=await f.port.prepareNativePublication({facts:f.facts,packet:f.packet,payload:f.payload});
  const payload=structuredClone(f.payload);if(mutate)payload.output.summary='different proof';else f.setCurrent(false);
  let error;try{await f.port.createCheck(payload,handle);}catch(e){error=e;}
  assert.equal(nativePublicationNoPostProof(error)?.notSent,true);assert.equal(nativePublicationNoPostProof({...error}),null);assert.equal(f.posts,0);
 }
});
test('compensation preserves the Native marker and never patches an already negative check twice',async t=>{
 const f=await fixture(t),handle=await f.port.prepareNativePublication({facts:f.facts,packet:f.packet,payload:f.payload});const check=await f.port.createCheck(f.payload,handle);
 const negative={status:'completed',conclusion:'failure',output:{title:'revoked',summary:'authorization moved'}};
 await f.port.revokeCheck(check.id,negative);const second=await f.port.revokeCheck(check.id,negative);
 assert.match(second.output.summary,new RegExp(pub));assert.equal(f.patches,1);
});
test('controller identity binds the actual supervisor nonce, node and job, never a fabricated Actions run',()=>{
 const input={invocationNonce:'a'.repeat(32),nodeId:'TURING',jobId:'b'.repeat(64)};
 assert.equal(independentControllerId(input),independentControllerId({...input}));
 assert.notEqual(independentControllerId(input),independentControllerId({...input,nodeId:'DESK-W-591'}));
 assert.notEqual(independentControllerId(input),independentControllerId({...input,invocationNonce:'c'.repeat(32)}));
 assert.throws(()=>independentControllerId({...input,invocationNonce:'123'}));
});
test('active and legacy relay external identities retain exact role/head binding and compensation',async t=>{
 for(const active of [true,false]){
  const f=await fixture(t,active);f.payload.external_id=`independent-ci:relay:gitleaks:${f.job.headSha.slice(0,12)}:run39000000001:a1`;
  const handle=await f.port.prepareNativePublication({facts:f.facts,packet:f.packet,payload:f.payload});
  const check=await f.port.createCheck(f.payload,handle);
  const revoked=await f.port.revokeCheck(check.id,{status:'completed',conclusion:'failure',output:{title:'revoked',summary:'authorization changed'}});
  assert.equal(revoked.conclusion,'failure');assert.equal(f.posts,1);assert.equal(f.patches,1);
  if(active)assert.match(revoked.output.summary,new RegExp(pub));
 }
});
