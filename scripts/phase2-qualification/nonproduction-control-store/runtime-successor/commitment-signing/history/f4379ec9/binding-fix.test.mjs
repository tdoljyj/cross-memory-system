import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {makeCommitment,prepareMutation,verifyObservedCommit,repository,project,rootGeneration,audience} from './signing.mjs';
function fixture(){
 const id='ga_synthetic_fix',raw=JSON.stringify({gate_authorization_id:id,issuer_purpose:'GATE_AUTHORIZATION',audience,control_trust_root_generation:rootGeneration,schema_digest:'a'.repeat(64),signature:`urn:clued:gate-authorization:${project}:${id}#signature`})+'\n';
 const head='b'.repeat(40),plan=prepareMutation({commitment:makeCommitment(raw,'GateAuthorization'),privateRepository:{full_name:repository,private:true},head,existingPath:null});
 const blobRaw=plan.expectation.raw,bytes=Buffer.from(blobRaw),blob=crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
 const commit={sha:'c'.repeat(40),parents:[{sha:head}],author:{login:'tdoljyj'},committer:{login:'web-flow'},commit:{tree:{sha:'d'.repeat(40)},verification:{verified:true,reason:'valid',signature:'SYNTHETIC',payload:'SYNTHETIC'}}};
 return {plan,commit,comparison:{base_commit:{sha:head},commits:[{sha:commit.sha}],files:[{filename:plan.expectation.path,status:'added',sha:blob}]},tree:{sha:commit.commit.tree.sha,truncated:false,tree:[{path:plan.expectation.path,type:'blob',mode:'100644',sha:blob}]},blobRaw,now:0,expiresAt:'2026-09-08T16:00:00Z'};
}
test('only recursively sealed locally produced plan can be verified',()=>{
 const x=fixture();assert.equal(verifyObservedCommit(x).authority_effect,'NONE');
 assert.throws(()=>{x.plan.expectation.path='other';},TypeError);
 assert.throws(()=>{x.plan.variables.input.expectedHeadOid='0'.repeat(40);},TypeError);
 assert.throws(()=>verifyObservedCommit({...x,plan:structuredClone(x.plan)}),/unrecognized_or_modified_plan/);
});
test('valid-looking signature with another tree or blob cannot use local expected content',()=>{
 for(const mutate of [x=>x.tree.sha='e'.repeat(40),x=>x.tree.tree[0].sha='f'.repeat(40),x=>x.tree.tree[0].mode='120000',x=>x.tree.truncated=true,x=>x.comparison.files[0].sha='f'.repeat(40)]){
  const x=fixture();mutate(x);assert.throws(()=>verifyObservedCommit(x));
 }
});
