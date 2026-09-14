// Explicit parallel-source controller successor; requires its own accepted source binding.
// R21-F3: the predecessor's reader spawns PowerShell and pins C:/Program Files/nodejs/node.exe,
// which throws ENOENT here -- and is first reached AFTER the one-shot budget reservation and GA
// issuance, so the single allocation would burn on it. The Linux reader is owned by this
// controller; the predecessor's module is left untouched because eight controllers pin its bytes.
import {readSourceBlobRefsBounded} from './read-source-blobs-linux.mjs';
import {planRefs} from '../control-context-verifier-original-input-capacity-successor/ref-plan.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {api,sha,readBlobRef,verifyOwnerMergeArtifact} from './trusted-github.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),repository='tdoljyj/cross-memory-system';
// Derived from this module's own location, not written out. The Linux port copied the
// predecessor's literal verbatim and nobody caught it for four rounds, because both uses sit on
// the GitHub-API path that the self-test lists as uncovered. The consequence was fatal at the
// first line of verifySourcePublication: it read the WINDOW11 manifest (3a58eb87...) and compared
// it against the Linux controller digest the run is bound to (dd11e428...), so
// ACTUAL_CONTROLLER_MANIFEST_BYTES threw before any GitHub call -- and the second use would have
// asked the Owner merge for the predecessor's artifact path. Deriving it means the next port
// cannot repeat this.
const manifestPath=path.relative(repo,fileURLToPath(new URL('./ControllerSourceManifest.candidate.json',import.meta.url))).split(path.sep).join('/');
const need=(ok,why)=>{if(!ok)throw Error(why);};
export function exactDeclaredSources(manifest){
 const sources=manifest?.files;
 if(!(Array.isArray(sources)&&sources.length===23&&sources.every(e=>e&&typeof e==='object'&&!Array.isArray(e)&&Object.keys(e).sort().join(',')==='bytes,path,sha256')))throw Error('EXACT_23_DECLARED_REPOSITORY_SOURCE_SET');
 return sources;
}
export function planSourceBatches(refs,sizes){
 need(Array.isArray(refs)&&refs.length>0&&refs.length<=160&&Array.isArray(sizes)&&sizes.length===refs.length,'COMPLETE_BOUNDED_SOURCE_SET');
 const batches=[],seen=new Map();let plannedEncodedBytes=0;
 for(let i=0;i<refs.length;i+=128){
  const batch={refs:refs.slice(i,i+128),sizes:sizes.slice(i,i+128)};planRefs(batch.refs,batch.sizes);batches.push(batch);
 }
 for(let i=0;i<refs.length;i++){
  const r=refs[i],prior=seen.get(r.uri);need(!prior||(prior.sha256===r.sha256&&prior.size===sizes[i]),'CONTRADICTORY_CROSS_BATCH_SOURCE');seen.set(r.uri,{sha256:r.sha256,size:sizes[i]});
  const content=4*Math.ceil(sizes[i]/3);plannedEncodedBytes+=content+2*Math.ceil(content/60)+2048;
 }
 // Planning allowance, not a claim about unobserved GitHub response bytes.
 // Every frozen batch independently retains its actual 32 MiB response limit.
 need(plannedEncodedBytes<=33554432,'PLANNED_FULL_SOURCE_ENCODING_LIMIT');
 return {batches,plannedEncodedBytes};
}
export function readCompleteSourceSet(refs,sizes){
 const plan=planSourceBatches(refs,sizes); // Complete cross-batch checks before any reader.
 for(const batch of plan.batches)readSourceBlobRefsBounded(batch.refs,batch.sizes);
 return {count:refs.length,batches:plan.batches.length,planned_encoded_bytes:plan.plannedEncodedBytes,authority_effect:'NONE'};
}
export function verifySourcePublication({sourceRef,ownerMerge,controllerDigest}){
 const raw=fs.readFileSync(path.join(repo,manifestPath),'utf8');need(sha(raw)===controllerDigest,'ACTUAL_CONTROLLER_MANIFEST_BYTES');
 const manifest=JSON.parse(raw);need(manifest.object_type==='ControllerSourceManifest'&&manifest.qualification_issued===false&&Array.isArray(manifest.files),'EXACT_MANIFEST_SOURCE_OBJECT');
 const publication=verifyOwnerMergeArtifact({commitSha:ownerMerge,artifactPath:manifestPath,raw});
 const commit=api('repos/'+repository+'/commits/'+sourceRef.commit);need(commit.sha===sourceRef.commit&&commit.commit.tree.sha===sourceRef.tree,'ACTUAL_SOURCE_COMMIT_TREE');
 const comparison=api('repos/'+repository+'/compare/'+sourceRef.commit+'...'+ownerMerge);
 need(comparison.base_commit?.sha===sourceRef.commit&&comparison.merge_base_commit?.sha===sourceRef.commit&&['ahead','identical'].includes(comparison.status),'SOURCE_ANCESTOR_OF_ACTUAL_OWNER_MERGE');
 const tree=api('repos/'+repository+'/git/trees/'+sourceRef.tree+'?recursive=1');need(tree.truncated===false&&tree.sha===sourceRef.tree,'FULL_SOURCE_TREE_REQUIRED');
 need(sourceRef.blobs.some(ref=>ref.uri===publication.blob_ref.uri&&ref.sha256===controllerDigest),'EXACT_SOURCE_MANIFEST_BLOB_REF');
 const sizes=sourceRef.blobs.map(ref=>{const id=ref.uri.split('/').at(-1),entries=tree.tree.filter(e=>e.type==='blob'&&e.sha===id);need(entries.length>0,'SOURCE_REF_BLOB_NOT_IN_SOURCE_TREE');const size=entries[0].size;need(Number.isSafeInteger(size)&&size>=0&&entries.every(e=>e.size===size),'EXACT_CONSISTENT_SOURCE_TREE_BLOB_SIZE');return size;});
 readCompleteSourceSet(sourceRef.blobs,sizes);
 const merge=api('repos/'+repository+'/commits/'+ownerMerge),mergeTree=api('repos/'+repository+'/git/trees/'+merge.commit.tree.sha+'?recursive=1');
 need(mergeTree.truncated===false,'FULL_OWNER_MERGE_TREE_REQUIRED');
 // The accepted successor manifest is source-only: exactly 23 repository files and no
 // predecessor role field. Treating the absent role as a filter selected zero files and made
 // the publication gate impossible to satisfy. Exact cardinality is fail-closed: 21 or 23
 // files are both a different controller, never an implicitly acceptable subset/superset.
 const sources=exactDeclaredSources(manifest);
 for(const source of sources){
  need(typeof source.path==='string'&&!source.path.includes('..')&&!path.isAbsolute(source.path),'REPOSITORY_SOURCE_PATH');
  const bytes=fs.readFileSync(path.join(repo,source.path));need(bytes.length===source.bytes&&sha(bytes)===source.sha256,'SOURCE_MANIFEST_LOCAL_BYTES');
  const blob=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  need(sourceRef.blobs.some(ref=>ref.uri==='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blob&&ref.sha256===source.sha256),'COMPLETE_MANIFEST_FILE_BLOB_COVERAGE');
  for(const current of [tree,mergeTree]){const matches=current.tree.filter(e=>e.path===source.path);need(matches.length===1&&matches[0].type==='blob'&&matches[0].mode==='100644'&&matches[0].sha===blob,'SAME_EXACT_CLOSED_SOURCE_IN_BOTH_TREES');}
 }
 return {state:'ACTUAL_FIXED_SOURCE_PUBLICATION_VERIFIED',source_commit:sourceRef.commit,owner_merge:ownerMerge};
}


