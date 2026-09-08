import assert from 'node:assert/strict';
import test from 'node:test';
import {makeCommitment,prepareMutation,verifyObservedCommit,repository,branch,project,rootGeneration,audience} from './signing.mjs';
function fixture(){
 const id='ga_synthetic',raw=JSON.stringify({gate_authorization_id:id,issuer_purpose:'GATE_AUTHORIZATION',audience,control_trust_root_generation:rootGeneration,schema_digest:'a'.repeat(64),signature:`urn:clued:gate-authorization:${project}:${id}#signature`})+'\n';
 const args={commitment:makeCommitment(raw,'GateAuthorization'),privateRepository:{full_name:repository,private:true},head:'b'.repeat(40),existingPath:null};
 const plan=prepareMutation(args),commit={sha:'c'.repeat(40),parents:[{sha:args.head}],author:{login:'tdoljyj'},committer:{login:'web-flow'},commit:{verification:{verified:true,reason:'valid',signature:'SYNTHETIC_NOT_CRYPTOGRAPHIC',payload:'SYNTHETIC_NOT_CRYPTOGRAPHIC'}}};
 const observed={plan,commit,comparison:{base_commit:{sha:args.head},commits:[{sha:commit.sha}],files:[{filename:plan.expectation.path,status:'added'}]},blobRaw:plan.expectation.raw,now:0,expiresAt:'2026-09-08T16:00:00Z'};
 return {raw,args,plan,observed};
}
test('fixed GraphQL CAS single new commitment contains no live payload or author overrides',()=>{
 const {plan,raw}=fixture(),input=plan.variables.input;
 assert.deepEqual(input.branch,{repositoryNameWithOwner:repository,refName:branch});assert.equal(input.fileChanges.additions.length,1);
 assert.ok(!('deletions'in input.fileChanges));assert.ok(!('author'in input));assert.ok(!('committer'in input));
 assert.ok(!plan.expectation.raw.includes(raw));assert.equal(verifyObservedCommit(fixture().observed).authority_effect,'NONE');
});
test('cross-purpose, root-generation, schema and typed proof substitution reject',()=>{
 const {raw}=fixture();for(const patch of [{issuer_purpose:'STATUS'},{control_trust_root_generation:'other'},{schema_digest:'bad'},{signature:'https://example.invalid'}])
  assert.throws(()=>makeCommitment(JSON.stringify({...JSON.parse(raw),...patch})+'\n','GateAuthorization'));
 assert.throws(()=>makeCommitment(raw.replace('"issuer_purpose":','"issuer_purpose":"STATUS","issuer_purpose":'),'GateAuthorization'),/exact_compact_unique_json_required/);
});
test('public, nonboolean visibility, wrong repository, existing target and forged commitment refuse planning',()=>{
 for(const patch of [{privateRepository:{full_name:repository,private:false}},{privateRepository:{full_name:repository,private:'true'}},{privateRepository:{full_name:'other/repo',private:true}},{existingPath:{}},{head:'unknown'},{commitment:{algorithm:'forged'}}])
  assert.throws(()=>prepareMutation({...fixture().args,...patch}));
});
test('wrong signer, false validity, second parent, wrong content and expiry reject observation',()=>{
 const mutations=[x=>x.commit.author.login='other',x=>x.commit.committer.login='other',x=>x.commit.commit.verification.verified='true',x=>x.commit.parents.push({sha:'d'.repeat(40)}),x=>x.blobRaw+=' ',x=>x.now=Date.parse(x.expiresAt),x=>x.comparison.files[0].status='modified',x=>x.comparison.files.push({filename:'other',status:'added'})];
 for(const mutate of mutations){const x=fixture().observed;mutate(x);assert.throws(()=>verifyObservedCommit(x));}
});
