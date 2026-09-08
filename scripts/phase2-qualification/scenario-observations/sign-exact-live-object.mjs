// Root-operated fixed Owner signature transport. A signature is never current admission.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeCommitment,prepareMutation,verifyObservedCommit,repository,branch,prefix} from '../nonproduction-control-store/runtime-successor/commitment-signing/signing.mjs';
const gh='C:/Program Files/GitHub CLI/gh.exe';
const ghSha='e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3';
const workspace='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/qualification-live';
const ownerExpires=Date.parse('2026-09-09T09:28:59Z');
const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const requireValue=(value,message)=>{if(!value)throw Error(message);};
function call(args,input){
 requireValue(hash(fs.readFileSync(gh))===ghSha,'FIXED_GITHUB_CLI_BYTES');
 return JSON.parse(execFileSync(gh,args,{input,encoding:'utf8',timeout:15000,maxBuffer:32*1024*1024,windowsHide:true}));
}
function api(endpoint){
 requireValue(endpoint==='repos/'+repository||endpoint.startsWith('repos/'+repository+'/'),'FIXED_REPOSITORY');
 return call(['api','--hostname','github.com',endpoint]);
}
function mutateFixed(plan){
 requireValue(hash(fs.readFileSync(gh))===ghSha,'FIXED_GITHUB_CLI_BYTES');
 let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),exitCode=0,signal=null,code=null;
 try{
  stdout=execFileSync(gh,['api','--hostname','github.com','graphql','--input','-'],{
   input:JSON.stringify({query:plan.query,variables:plan.variables}),timeout:15000,maxBuffer:32*1024*1024,windowsHide:true});
 }catch(error){
  stdout=Buffer.from(error.stdout??'');stderr=Buffer.from(error.stderr??'');
  exitCode=Number.isInteger(error.status)?error.status:null;signal=error.signal??null;code=error.code??null;
 }
 let response=null,parseError=null;
 try{response=JSON.parse(stdout.toString('utf8'));}catch(error){parseError=error.message;}
 return {exit_code:exitCode,signal,code,stdout_base64:stdout.toString('base64'),stderr_base64:stderr.toString('base64'),
  stdout_sha256:hash(stdout),stderr_sha256:hash(stderr),response,parse_error:parseError};
}
function saveNew(filename,value){
 const raw=JSON.stringify(value)+'\n',fd=fs.openSync(filename,'wx',0o600);
 try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function signExactObject({type,id}){
 requireValue(['GateAuthorization','GateResultReceipt'].includes(type),'EXISTING_TWO_DYNAMIC_PURPOSES_ONLY');
 requireValue(new RegExp('^'+(type==='GateAuthorization'?'ga':'grr')+'_[A-Za-z0-9_-]{1,128}$').test(id),'FIXED_OBJECT_ID');
 const payloadPath=path.join(workspace,'payloads',type,id+'.json');
 requireValue(!fs.lstatSync(payloadPath).isSymbolicLink(),'REGULAR_FIXED_PAYLOAD_FILE');
 const raw=fs.readFileSync(payloadPath,'utf8'),object=JSON.parse(raw),commitment=makeCommitment(raw,type);
 requireValue(commitment.object_id===id,'EXACT_OBJECT_ID');
 const expires=type==='GateAuthorization'?object.deadline:object.expires_at;
 requireValue(Number.isFinite(Date.parse(expires))&&Date.now()<Date.parse(expires)&&Date.parse(expires)<=ownerExpires,'CURRENT_ORIGINAL_OWNER_AND_OBJECT_WINDOW');
 const privateRepository=api('repos/'+repository);
 const head=api('repos/'+repository+'/git/ref/heads/'+branch).object?.sha;
 requireValue(/^[a-f0-9]{40}$/.test(head),'ACTUAL_FIXED_BRANCH_HEAD');
 const parent=api('repos/'+repository+'/commits/'+head);
 const parentTree=api('repos/'+repository+'/git/trees/'+parent.commit.tree.sha+'?recursive=1');
 requireValue(parentTree.truncated===false&&parentTree.sha===parent.commit.tree.sha,'EXACT_UNTRUNCATED_PARENT_TREE');
 const filename=prefix+type+'/'+id+'.json';
 requireValue(!parentTree.tree.some(entry=>entry.path===filename),'NO_EXISTING_SIGNATURE_PATH');
 const plan=prepareMutation({commitment,privateRepository,head,existingPath:null});
 const ticketDir=path.join(workspace,'signature-attempts',type);fs.mkdirSync(ticketDir,{recursive:true});
 const ticketPath=path.join(ticketDir,id+'.json');
 saveNew(ticketPath,{state:'ONE_SIGNATURE_MUTATION_RESERVED',type,id,payload_sha256:hash(raw),
  expected_head:head,exact_path:filename,reserved_at:new Date().toISOString(),expires_at:expires,
  authority_effect:'NONE',automatic_retry:false});
 let committed=null;
 try{
  requireValue(Date.now()<Date.parse(expires)&&Date.now()<ownerExpires,'EXPIRED_BEFORE_SIGNATURE_MUTATION');
  const transport=mutateFixed(plan),response=transport.response;
  const observedOid=response?.data?.createCommitOnBranch?.commit?.oid;
  committed=typeof observedOid==='string'&&/^[a-f0-9]{40}$/.test(observedOid)?observedOid:null;
  saveNew(path.join(ticketDir,id+'.mutation-response.json'),{commit_sha:committed,transport});
  requireValue(transport.exit_code===0&&transport.signal===null&&transport.code===null&&transport.parse_error===null,'SIGNATURE_MUTATION_PROCESS_ERROR');
  requireValue(!response.errors?.length,'SIGNATURE_MUTATION_RESPONSE_ERROR');
  requireValue(committed!==null,'ACTUAL_CREATED_COMMIT_REQUIRED');
  const commit=api('repos/'+repository+'/commits/'+committed);
  const comparison=api('repos/'+repository+'/compare/'+head+'...'+committed);
  const tree=api('repos/'+repository+'/git/trees/'+commit.commit.tree.sha+'?recursive=1');
  const entry=tree.tree?.find(item=>item.path===filename);
  requireValue(entry&&/^[a-f0-9]{40}$/.test(entry.sha),'ACTUAL_COMMITMENT_BLOB');
  const blob=api('repos/'+repository+'/git/blobs/'+entry.sha);
  requireValue(blob.sha===entry.sha&&blob.encoding==='base64','ACTUAL_BASE64_BLOB');
  const blobRaw=Buffer.from(blob.content,'base64').toString('utf8');
  const verified=verifyObservedCommit({plan,commit,comparison,tree,blobRaw,now:Date.now(),expiresAt:expires});
  const evidence={state:'ACTUAL_EXACT_HISTORICAL_SIGNATURE_VERIFIED',type,id,payload_sha256:hash(raw),
   filename,commit,comparison,tree,blob,verified,observed_at:new Date().toISOString(),authority_effect:'NONE'};
  saveNew(path.join(ticketDir,id+'.verified.json'),evidence);
  return {state:evidence.state,type,id,payload_sha256:hash(raw),commit_sha:committed,authority_effect:'NONE',current_admission_claimed:false};
 }catch(error){
  saveNew(path.join(ticketDir,id+'.unknown.json'),{state:'UNKNOWN_PRESERVE_ORIGINAL_SIGNATURE_ATTEMPT',type,id,
   observed_commit:committed,reason:error.message,observed_at:new Date().toISOString(),automatic_retry:false,authority_effect:'NONE'});
  throw error;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 requireValue(process.argv.length===4,'FIXED_TYPE_AND_ID_ARGUMENTS_ONLY');
 process.stdout.write(JSON.stringify(signExactObject({type:process.argv[2],id:process.argv[3]}))+'\n');
}
