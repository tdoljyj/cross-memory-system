import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {makeCommitment,prepareMutation,verifyObservedCommit,branch,prefix,repository} from '../nonproduction-control-store/runtime-successor/commitment-signing-next-window/signing.mjs';
const gh='C:/Program Files/GitHub CLI/gh.exe';
const expectedGh='e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3';
const immutableReads=new Map();
const ownerMergeTrees=new Map();
export const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
const hex40=x=>typeof x==='string'&&/^[0-9a-f]{40}$/.test(x);
export function api(endpoint){
 check(sha(fs.readFileSync(gh))===expectedGh,'GITHUB_CLI_BYTES_DRIFT');
 check(endpoint.startsWith('repos/'+repository+'/')||endpoint==='repos/'+repository,'PRIVATE_REPOSITORY_ONLY');
 // Fixed executable, no shell, caller URL/host/credential/command or callback.
 const immutable=/\/(?:git\/(?:blobs|trees)|commits)\/[0-9a-f]{40}(?:\?recursive=1)?$/.test(endpoint);
 if(immutableReads.has(endpoint))return structuredClone(immutableReads.get(endpoint));
 const value=JSON.parse(execFileSync(gh,['api','--hostname','github.com',endpoint],{encoding:'utf8',timeout:10000,maxBuffer:32*1024*1024,windowsHide:true}));
 if(immutable)immutableReads.set(endpoint,value);
 return value;
}
export function readBlobRef(ref){
 const m=/^https:\/\/api\.github\.com\/repos\/tdoljyj\/cross-memory-system\/git\/blobs\/([0-9a-f]{40})$/.exec(ref?.uri);
 check(m&&typeof ref.sha256==='string','EXACT_GITHUB_BLOB_REF_REQUIRED');
 const blob=api('repos/'+repository+'/git/blobs/'+m[1]);
 check(blob.sha===m[1]&&blob.encoding==='base64','GITHUB_BLOB_RESPONSE');
 const bytes=Buffer.from(blob.content,'base64');
 check(bytes.length===blob.size&&sha(bytes)===ref.sha256,'GITHUB_BLOB_RAW_SHA');
 const gitsha=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
 check(gitsha===m[1],'GITHUB_BLOB_ID');
 return bytes.toString('utf8');
}
export function verifyOwnerMergeArtifact({commitSha,artifactPath,raw}){
 check(hex40(commitSha)&&typeof artifactPath==='string'&&!artifactPath.includes('..')&&!artifactPath.startsWith('/'),'FIXED_MERGE_REFERENCE');
 let tree=ownerMergeTrees.get(commitSha);
 if(!tree){
 const repo=api('repos/'+repository);check(repo.private===true&&repo.full_name===repository,'PRIVATE_REPOSITORY_REQUIRED');
 const commit=api('repos/'+repository+'/commits/'+commitSha),v=commit.commit?.verification;
 check(commit.sha===commitSha&&commit.parents?.length===2&&commit.committer?.login==='web-flow'&&v?.verified===true&&v.reason==='valid'&&v.signature&&v.payload,'OWNER_MERGE_VALID_SIGNATURE_REQUIRED');
 const prs=api('repos/'+repository+'/commits/'+commitSha+'/pulls');
 check(Array.isArray(prs)&&prs.filter(p=>p.merge_commit_sha===commitSha&&p.merged_at&&p.base?.ref==='main').length===1,'EXACT_MAIN_MERGED_PR_REQUIRED');
 const p=prs.find(p=>p.merge_commit_sha===commitSha&&p.merged_at&&p.base?.ref==='main');
 const pr=api('repos/'+repository+'/pulls/'+p.number);check(pr.merged===true&&pr.merged_by?.login==='tdoljyj'&&pr.merge_commit_sha===commitSha,'ACTUAL_OWNER_MERGE_REQUIRED');
 tree=api('repos/'+repository+'/git/trees/'+commit.commit.tree.sha+'?recursive=1');
 check(tree.sha===commit.commit.tree.sha&&tree.truncated===false&&Array.isArray(tree.tree),'COMPLETE_EXACT_TREE_REQUIRED');
 ownerMergeTrees.set(commitSha,tree);
 }
 const matches=tree.tree.filter(e=>e.path===artifactPath);check(matches.length===1&&matches[0].type==='blob'&&matches[0].mode==='100644','EXACT_REGULAR_STATIC_ARTIFACT');
 const ref={uri:'https://api.github.com/repos/'+repository+'/git/blobs/'+matches[0].sha,sha256:sha(raw)};
 check(readBlobRef(ref)===raw,'EXACT_SIGNED_STATIC_BYTES');
 return {sha256:sha(raw),commit_sha:commitSha,blob_ref:ref};
}
export function verifyDynamicPayload(raw,type,expiresAt,historicalNotBefore=null){
 const commitment=makeCommitment(raw,type),filename=prefix+type+'/'+commitment.object_id+'.json';
 const repo=api('repos/'+repository);check(repo.private===true&&repo.full_name===repository,'PRIVATE_REPOSITORY_REQUIRED');
 // The accepted fixed path is append-only: more than one path-touching commit rejects.
 const history=api('repos/'+repository+'/commits?sha='+encodeURIComponent(branch)+'&path='+encodeURIComponent(filename)+'&per_page=2');
 check(Array.isArray(history)&&history.length===1&&hex40(history[0].sha),'UNIQUE_APPEND_ONLY_SIGNATURE_PATH_REQUIRED');
 const commit=api('repos/'+repository+'/commits/'+history[0].sha);
 check(commit.parents?.length===1&&hex40(commit.parents[0].sha),'SINGLE_PARENT_REQUIRED');
 const parent=commit.parents[0].sha;
 const parentCommit=api('repos/'+repository+'/commits/'+parent);
 const parentTree=api('repos/'+repository+'/git/trees/'+parentCommit.commit.tree.sha+'?recursive=1');
 check(parentTree.truncated===false&&parentTree.sha===parentCommit.commit.tree.sha&&!parentTree.tree.some(e=>e.path===filename),'SIGNATURE_TARGET_WAS_NOT_ABSENT');
 const plan=prepareMutation({commitment,privateRepository:repo,head:parent,existingPath:null});
 const comparison=api('repos/'+repository+'/compare/'+parent+'...'+commit.sha);
 const tree=api('repos/'+repository+'/git/trees/'+commit.commit.tree.sha+'?recursive=1');
 const entry=tree.tree?.find(e=>e.path===filename);check(entry&&hex40(entry.sha),'COMMITMENT_BLOB_MISSING');
 const blobRaw=readBlobRef({uri:'https://api.github.com/repos/'+repository+'/git/blobs/'+entry.sha,sha256:sha(plan.expectation.raw)});
 let observedNow=Date.now();
 if(historicalNotBefore!==null){
  check(type==='GateAuthorization','HISTORICAL_GA_ONLY');
  observedNow=Date.parse(commit.commit?.committer?.date);
  check(Number.isFinite(observedNow)&&Date.parse(historicalNotBefore)<=observedNow&&observedNow<Date.parse(expiresAt)&&observedNow<=Date.now(),'ACTUAL_HISTORICAL_GA_SIGNING_TIME');
 }
 return verifyObservedCommit({plan,commit,comparison,tree,blobRaw,now:observedNow,expiresAt});
}
// Network reads only. A valid historical signature is never live admission.
