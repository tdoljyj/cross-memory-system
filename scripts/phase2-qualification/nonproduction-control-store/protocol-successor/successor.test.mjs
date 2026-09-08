import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {rootId,rootUri,sourceSchema,validateRootShape,parseControlUri,readControlUri,canonicalDigest,reviewSubjectDigest,signaturePayloadDigest} from './validate-successor.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=p=>fs.readFileSync(new URL(p,import.meta.url));
const digest=sha(read('control-trust-root-set.schema.json'));
// In-memory shape-only references. No signature bytes, fake cryptographic result or stored instance.
const h=sha('NON_ISSUED_STRUCTURAL_FIXTURE'),ref=()=>({uri:'urn:clued:unresolved:non-issued-shape-fixture',sha256:h});
function fixture(){const value={schema_version:'1.0',object_type:'ControlTrustRootSet',root_set_id:rootId,control_trust_root_generation:'ctrgen_352785779b64458a889d571360e2d2d5',generation_ordinal:1,predecessor:null,purpose:'SKILL_COEXISTENCE_QUALIFICATION',scope:{project_ref:'uscrdifznmlvczcekqpw',repository:'tdoljyj/cross-memory-system',profile_id:'DP-PREENTRY-SKILL-QUALIFICATION',environment:'ISOLATED_TEST',model_budget:0,paid_budget:0},issuer_bindings:[{subject_id:'tdoljyj',signing_service:'web-flow',purpose:'GATE_AUTHORIZATION',audience:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',qualification_ref:ref()}],audience:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',schema_digest:digest,algorithm_config:{canonicalization_id:'SORTED_JSON_UTF8_NO_FLOATS_LF_V1_CANDIDATE',signed_payload_excluded_fields:['signature_binding'],digest_algorithm:'SHA-256',signature_verification:'GITHUB_API_VERIFIED_OWNER_MERGE',accepted_config_ref:ref()},not_before:'2026-09-08T11:00:00Z',expires_at:'2026-09-09T09:28:59Z',history:{index_uri:rootUri+'#history',prefix_digest:canonicalDigest([]),prefix_sequence:0,minimum_accepted_generation:'ctrgen_352785779b64458a889d571360e2d2d5'},revocation:{events_uri:rootUri+'#revocations',event_set_digest:h,as_of:'2026-09-08T11:00:00Z',expires_at:'2026-09-08T12:00:00Z'},owner_approval_ref:ref(),independent_acceptance_ref:ref(),signature_binding:{owner_merge_commit:'4d7f93c17cf7d126e771cf8aca6299c868cba0a9',signed_object_sha256:h,signature_evidence_ref:ref()},status:'REGISTERED'};value.signature_binding.signed_object_sha256=signaturePayloadDigest(value);return value;
}
test('new schema follows existing identity conventions and shape never claims signature acceptance',()=>{
 assert.equal(sourceSchema.$schema,'https://json-schema.org/draft/2020-12/schema');assert.equal(sourceSchema.$id,'urn:clued:schema:control-trust-root-set:v1');
 assert.deepEqual(validateRootShape(fixture()),{status:'SHAPE_VALID_ONLY',authority_effect:'NONE',signature_verified:false});
});
test('wrong root production scope or issuer purpose Audience and missing actual bindings reject',()=>{
 for(const mutate of [x=>x.root_set_id='ctr_'+'f'.repeat(32),x=>x.scope.environment='PRODUCTION',x=>x.scope.paid_budget=1,x=>x.issuer_bindings[0].purpose='PROMOTION_AUTHORIZATION',x=>x.issuer_bindings[0].audience='other',x=>delete x.signature_binding,x=>delete x.algorithm_config,x=>x.schema_digest=h]){const x=fixture();mutate(x);assert.throws(()=>validateRootShape(x));}
});
test('first-generation misuse and invalid dates reject; business Vector is not added to RootSet',()=>{
 for(const mutate of [x=>x.control_trust_root_generation='4d7f93c17cf7d126e771cf8aca6299c868cba0a9',x=>x.generation_ordinal=2,x=>x.history.prefix_sequence=9007199254740992,x=>x.revocation_epoch_vector={account_epoch:'not_applicable'},x=>x.expires_at='2026-02-30T00:00:00Z',x=>x.expires_at='2026-09-10T00:00:00Z']){const x=fixture();mutate(x);assert.throws(()=>validateRootShape(x));}
});
test('typed URI only selects the exact nonproduction root and bounded known fragments',()=>{
 for(const fragment of ['', '#history','#revocations'])assert.equal(parseControlUri(rootUri+fragment).root_set_id,rootId);
 for(const uri of [rootUri.replace('uscrdifznmlvczcekqpw','ccxsikzwxlolxqlosril'),rootUri+'#other',rootUri+'/../other','https://example.invalid'])assert.throws(()=>parseControlUri(uri));
});
test('private SQL read mapping returns no authority and rejects missing history or revoked root',async()=>{
 const body=fixture(),event={root_id:rootId,sequence:1,request:{kind:'GENERATION_REGISTERED',generation_id:body.control_trust_root_generation,body}};
 const value={root_set_id:rootId,sequence:1,generation_id:body.control_trust_root_generation,state:'STORED_NO_GATE_AUTHORITY',events:[event]};
 const store={async read(){return structuredClone(value);}};
 assert.equal((await readControlUri(rootUri,store)).signature_verified,false);
 assert.equal((await readControlUri(rootUri+'#history',store)).data.length,1);
 assert.equal((await readControlUri(rootUri+'#revocations',store)).data.length,0);
 value.events=[];await assert.rejects(readControlUri(rootUri,store),/Incomplete/);
 value.events=[event];value.state='REVOKED';await assert.rejects(readControlUri(rootUri,store),/expired\/revoked/);
});
test('manifest binds precisely the added schema and revised verifier without changing original trace mappings',()=>{
 const m=JSON.parse(read('manifest.candidate.json')),old=JSON.parse(read('../../../../protocol/continuity/v1/manifest.json'));
 assert.equal(m.entries.length,92);assert.equal(m.entries.filter(x=>x.path.includes('/schemas/')).length,66);
 assert.equal(m.downstream_mapping_digest,old.downstream_mapping_digest);assert.equal(m.rule_set_digest,old.rule_set_digest);
 assert.equal(m.control_uri_templates.ControlTrustRootSet.schema_sha256,digest);
 for(const e of old.entries)if(e.path!=='scripts/verify-generated-artifacts.mjs')assert.deepEqual(m.entries.find(x=>x.path===e.path),e);
 assert.equal(m.entries.find(x=>x.path==='scripts/verify-generated-artifacts.mjs').sha256,'sha256:'+sha(read('verify-generated-artifacts.candidate.mjs')));
});
test('actual successor guard rejects altered query scope mapping digest and unexpected artifact count',()=>{
 const text=read('verify-generated-artifacts.candidate.mjs').toString('utf8');
 const start=text.indexOf('  const controlSuccessor = manifest.control_root_successor;');
 const end=text.indexOf('  const paths = new Set();',start);assert.ok(start>0&&end>start);
 // Execute only the generated pure scope guard, not the full historical G1/BOM verifier.
 const guard=new Function('manifest','same',text.slice(start,end)+'\nreturn true;');
 const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
 const same=(a,b)=>canonical(a)===canonical(b),m=JSON.parse(read('manifest.candidate.json'));
 assert.equal(guard(m,same),true);
 for(const mutate of [x=>x.control_uri_templates.ControlTrustRootSet.project_ref='ccxsikzwxlolxqlosril',
  x=>x.control_uri_templates.ControlTrustRootSet.query='delete from public.projects',
  x=>x.control_root_successor.schema_sha256=h,x=>x.control_root_successor.revision_id='unknown',
  x=>delete x.control_root_successor.source_contract,x=>x.control_root_successor.predecessor_manifest_sha256=h,
  x=>x.control_root_successor.scope='EXPANDED_SCOPE',
  x=>x.entries.push(x.entries[0]),x=>delete x.control_root_successor]){const x=structuredClone(m);mutate(x);assert.throws(()=>guard(x,same));}
});
test('review subject and signed payload are separate real commitments without review self-reference',()=>{
 const x=fixture(),subject=reviewSubjectDigest(x),signed=signaturePayloadDigest(x);
 assert.notEqual(subject,signed);x.independent_acceptance_ref.sha256=sha('DIFFERENT_UNACCEPTED_REFERENCE');
 assert.equal(reviewSubjectDigest(x),subject);assert.notEqual(signaturePayloadDigest(x),signed);
 assert.throws(()=>validateRootShape(x));
 x.signature_binding.signed_object_sha256=signaturePayloadDigest(x);assert.equal(validateRootShape(x).signature_verified,false);
 x.scope.paid_budget=1;assert.notEqual(reviewSubjectDigest(x),subject);
});
test('prefix is verified against actual pre-append events and Profile Vector source stays untouched',async()=>{
 assert.equal(sourceSchema.properties.revocation_epoch_vector,undefined);
 assert.equal(sha(read('../../contract-candidates/revocation-epoch-vector.candidate.schema.json')),'c3c3c2ae05cd1f4f844f2f9898f1d29b2bfad2940975104847df41e1610831fe');
 const body=fixture();body.history.prefix_digest=h;body.signature_binding.signed_object_sha256=signaturePayloadDigest(body);
 const store={async read(){return {root_set_id:rootId,sequence:1,generation_id:body.control_trust_root_generation,state:'STORED_NO_GATE_AUTHORITY',events:[{root_id:rootId,sequence:1,request:{kind:'GENERATION_REGISTERED',generation_id:body.control_trust_root_generation,body}}]};}};
 await assert.rejects(readControlUri(rootUri,store),/actual pre-append history prefix/);
 body.history.prefix_digest=canonicalDigest([]);body.history.prefix_sequence=1;body.signature_binding.signed_object_sha256=signaturePayloadDigest(body);
 await assert.rejects(readControlUri(rootUri,store),/actual pre-append history prefix/);
 body.history.prefix_sequence=0;body.signature_binding.signed_object_sha256=signaturePayloadDigest(body);
 assert.equal((await readControlUri(rootUri,store)).authority_effect,'NONE');
});
