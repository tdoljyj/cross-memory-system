import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';
import {checkEnvelope,checkRestoredOriginal,envelopeFromPublication,beginOriginalInputVerification,decodeOriginalInputs,pathPrefix,branch} from './original-inputs-blob.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),raw=x=>JSON.stringify(x)+'\n';
const actual=JSON.parse(fs.readFileSync(new URL('../../../../normal600-existing-history-original-input-artifact.json',import.meta.url),'utf8'));
const ga=JSON.parse(JSON.parse(actual.raw).ga_raw).gate_authorization_id;
// A purely local envelope candidate: no remote publication or signature is asserted.
const publication={branch,commit_sha:'1'.repeat(40),ga_id:ga,artifact_path:pathPrefix+'original-inputs-'+ga.slice(3)+'/result.json'};
const blob={uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+crypto.createHash('sha1').update('blob '+Buffer.byteLength(actual.raw)+'\0').update(actual.raw).digest('hex'),sha256:actual.sha256};
test('complete existing 683291 historical bytes remain identical with small reference envelope',()=>{
 assert.equal(sha(actual.raw),'76c0740582de601adcf872e61d5f67af71b4c319851de7709ca615c0e7e6a87c');assert.equal(Buffer.byteLength(actual.raw),683291);
 const item=envelopeFromPublication(actual,publication,blob),e=checkEnvelope(item.raw,{uri:actual.uri,sha256:actual.sha256});
 assert.deepEqual(checkRestoredOriginal(actual.raw,e),JSON.parse(actual.raw));assert.ok(Buffer.byteLength(item.raw)<1024);
 assert.throws(()=>checkRestoredOriginal(actual.raw+' ',e),/EXACT_FULL_ORIGINAL_BYTES/);
 const bad=structuredClone(e);bad.publication.ga_id='ga_'+'0'.repeat(32);assert.throws(()=>checkRestoredOriginal(actual.raw,bad),/THIS_PUBLICATION_GA/);
});
test('fixed repository/path/one MiB bound and opaque cache reject malformed or forged input before network',()=>{
 const item=envelopeFromPublication(actual,publication,blob),e=JSON.parse(item.raw),ref={uri:actual.uri,sha256:actual.sha256};
 for(const mutate of [x=>x.original_bytes=1048577,x=>x.original_bytes='683291',x=>x.blob_ref.uri=x.blob_ref.uri.replace('tdoljyj','other'),x=>x.publication.artifact_path='../arbitrary',x=>x.publication.branch='main',x=>x.original_ref.uri='control://current',x=>x.extra=true]){const v=structuredClone(e);mutate(v);assert.throws(()=>checkEnvelope(raw(v),ref));}
 assert.throws(()=>decodeOriginalInputs(item.raw,ref,{}),/EXACT_LOCAL_VERIFICATION_SESSION/);assert.notEqual(beginOriginalInputVerification(),beginOriginalInputVerification());
});
