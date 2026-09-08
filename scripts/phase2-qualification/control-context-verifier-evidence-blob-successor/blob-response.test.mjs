// Exact production function bodies under synthetic fixed Git read responses.
// No Git API, publication, authority or actual signature is performed here.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';
import {envelopeFromPublication,pathPrefix,branch} from './original-inputs-blob.mjs';
const actual=JSON.parse(fs.readFileSync(new URL('../../../../normal600-existing-history-original-input-artifact.json',import.meta.url),'utf8'));
const ga=JSON.parse(JSON.parse(actual.raw).ga_raw).gate_authorization_id,commit='1'.repeat(40),tree='2'.repeat(40),blob=crypto.createHash('sha1').update('blob '+Buffer.byteLength(actual.raw)+'\0').update(actual.raw).digest('hex');
const publication={branch,commit_sha:commit,ga_id:ga,artifact_path:pathPrefix+'original-inputs-'+ga.slice(3)+'/result.json'},ref={uri:actual.uri,sha256:actual.sha256};
const envelope=envelopeFromPublication(actual,publication,{uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blob,sha256:actual.sha256});
const source=fs.readFileSync(new URL('./original-inputs-blob.mjs',import.meta.url),'utf8'),body=source.replace(/^import .+;\n/gm,'').replaceAll('export function','function').replaceAll('export const','const');
function fixture(change=()=>{}){
 const objects={repo:{full_name:'tdoljyj/cross-memory-system',private:true},commit:{sha:commit,tree:{sha:tree}},tree:{sha:tree,truncated:false,tree:[{path:publication.artifact_path,type:'blob',mode:'100644',sha:blob,size:Buffer.byteLength(actual.raw)}]},raw:actual.raw};change(objects);
 const calls={repo:0,commit:0,tree:0,blob:0};
 const api=p=>{let k;if(p==='repos/tdoljyj/cross-memory-system')k='repo';else if(p==='repos/tdoljyj/cross-memory-system/git/commits/'+commit)k='commit';else if(p==='repos/tdoljyj/cross-memory-system/git/trees/'+tree+'?recursive=1')k='tree';else throw Error('UNEXPECTED_FIXED_READ');calls[k]++;return structuredClone(objects[k]);};
 const readBlobRef=r=>{assert.equal(r.uri.split('/').at(-1),blob);calls.blob++;return objects.raw;};
 const module=new Function('crypto','api','readBlobRef','decodeLegacy',body+'\nreturn {beginOriginalInputVerification,decodeOriginalInputs};')(crypto,api,readBlobRef,()=>{throw Error('LEGACY_NOT_EXERCISED');});
 return {module,calls};
}
test('one actual-function read sequence per terminal-local immutable baseline, exact private/tree/blob checks',()=>{
 const f=fixture(),session=f.module.beginOriginalInputVerification();
 assert.deepEqual(f.module.decodeOriginalInputs(envelope.raw,ref,session),JSON.parse(actual.raw));assert.deepEqual(f.module.decodeOriginalInputs(envelope.raw,ref,session),JSON.parse(actual.raw));
 assert.deepEqual(f.calls,{repo:1,commit:1,tree:1,blob:1});
 for(const change of [o=>o.repo.private='true',o=>o.commit.sha='3'.repeat(40),o=>o.tree.truncated=true,o=>o.tree.tree[0].mode='100755',o=>o.tree.tree[0].sha='4'.repeat(40),o=>o.tree.tree[0].path='../wrong',o=>o.raw+=' ']){
  const changed=fixture(change);assert.throws(()=>changed.module.decodeOriginalInputs(envelope.raw,ref,changed.module.beginOriginalInputVerification()));
 }
});
