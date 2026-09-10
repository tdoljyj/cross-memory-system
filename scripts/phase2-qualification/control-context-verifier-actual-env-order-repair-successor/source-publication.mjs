// Explicit parallel-source controller successor; requires its own accepted source binding.
import {readSourceBlobRefsBounded} from '../control-context-verifier-original-input-capacity-successor/read-source-blobs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {api,sha,readBlobRef,verifyOwnerMergeArtifact} from '../control-context-verifier-next-window-successor/trusted-github.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),repository='tdoljyj/cross-memory-system';
const manifestPath='scripts/phase2-qualification/control-context-verifier-actual-env-order-repair-successor/ControllerSourceManifest.candidate.json';
const need=(ok,why)=>{if(!ok)throw Error(why);};
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
 readSourceBlobRefsBounded(sourceRef.blobs,sizes);
 const merge=api('repos/'+repository+'/commits/'+ownerMerge),mergeTree=api('repos/'+repository+'/git/trees/'+merge.commit.tree.sha+'?recursive=1');
 need(mergeTree.truncated===false,'FULL_OWNER_MERGE_TREE_REQUIRED');
 const sources=manifest.files.filter(e=>e.role==='REPOSITORY_SOURCE');need(sources.length>=30,'COMPLETE_DECLARED_REPOSITORY_SOURCE_SET');
 for(const source of sources){
  need(typeof source.path==='string'&&!source.path.includes('..')&&!path.isAbsolute(source.path),'REPOSITORY_SOURCE_PATH');
  const bytes=fs.readFileSync(path.join(repo,source.path));need(bytes.length===source.bytes&&sha(bytes)===source.sha256,'SOURCE_MANIFEST_LOCAL_BYTES');
  const blob=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  need(sourceRef.blobs.some(ref=>ref.uri==='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+blob&&ref.sha256===source.sha256),'COMPLETE_MANIFEST_FILE_BLOB_COVERAGE');
  for(const current of [tree,mergeTree]){const matches=current.tree.filter(e=>e.path===source.path);need(matches.length===1&&matches[0].type==='blob'&&matches[0].mode==='100644'&&matches[0].sha===blob,'SAME_EXACT_CLOSED_SOURCE_IN_BOTH_TREES');}
 }
 return {state:'ACTUAL_FIXED_SOURCE_PUBLICATION_VERIFIED',source_commit:sourceRef.commit,owner_merge:ownerMerge};
}
