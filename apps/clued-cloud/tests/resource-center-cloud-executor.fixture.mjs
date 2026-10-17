import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { batchRequests, batchReply } from "./google-batch-fixture.mjs";
export const ids={job:"10000000-0000-4000-8000-000000000001",connection:"20000000-0000-4000-8000-000000000001",
  owner:"30000000-0000-4000-8000-000000000001",profile:"40000000-0000-4000-8000-000000000001",
  intent:"50000000-0000-4000-8000-000000000001",receipt:"60000000-0000-4000-8000-000000000001"};
export const root="G:/My Drive/Clued_资料中心";
const folder="application/vnd.google-apps.folder";
const scope="https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
export const normalScope=scope+" https://www.googleapis.com/auth/drive.readonly";
// Drive returns isAppAuthorized only when `fields` names it. Items are Clued's
// own (created or opened by the app) unless they say isAppAuthorized: false.
const project=(u,item)=>{
  const {isAppAuthorized=true,...rest}=item;
  return (u.searchParams.get('fields')??'').includes('isAppAuthorized')?{...rest,isAppAuthorized}:rest;
};
const sha=s=>createHash("sha256").update(s).digest("hex");
export function fixture(options={}){
  let now=100000,status="queued",starts=0,posts=0,loads=0,batches=0;const trace=[];
  const file=(id,name,parent)=>({id,name,parents:parent?[parent]:[],version:"1",trashed:false,mimeType:folder});
  const files=new Map([['parent',file('parent','My Drive')],['root',file('root','Clued_资料中心','parent')],['track',file('track','track','root')]]);
  if(options.island) files.set('island',{...file('island','Clued_品牌说明.md','parent'),mimeType:'text/plain'});
  // The Owner's own / other tools' entries (StorageNormalUse §3.1). The legacy and
  // the normal credential both hold drive.metadata.readonly, so both list them.
  for(const entry of options.owner??[]) files.set(entry.id,{...entry,isAppAuthorized:false});
  const mutation={operation:'create',target_kind:'file',destination_path:root+'/track/new.txt',content:'hello cloud',...options.mutation};
  const descriptor={contract:'clued.storage-job-execution/1',owner_id:ids.owner,job_id:ids.job,connection_id:ids.connection,request_digest:'a'.repeat(64),
    provider:'google-drive',provider_subject:'subject',credential_version:1,mutation,
    profile:{registration_status:'registered',profile_id:ids.profile,profile_version:'cloud/1',policy_version:'clued.resource-center-mutation-policy/1',
      managed_root:root,allowed_root_children:['track']},root_folder_id:'root',root_parent_id:'parent',scan_roots:[{folder_id:'parent',path:'G:/My Drive'}]};
  const authority={artifact_id:null,artifact_role:'clued_resource',governance_class:'ordinary',delete_authority:false,
    authority_version:'authority/1',currentness_identity:'decision/1',workspace_version:'workspace/1'};
  let currentRequest, semanticAttempt;
  const config={clock:()=>now,
    load_job:async()=>{loads++;return structuredClone({...descriptor,status});},
    get_credential:async()=>({owner_id:ids.owner,connection_id:ids.connection,provider_subject:'subject',credential_version:1,
      access_token:'synthetic-cloud-token',scope,expires_at_ms:now+3600000,...options.credential}),
    rpc:async input=>{
      trace.push(input.action);assert.equal(input.job_id,ids.job);assert.equal(input.connection_id,ids.connection);
      if(input.action==='authority')return {status:'resolved',request:input.request,authority};
      if(input.action==='begin'){
        if(options.revoke || status!=='queued')return {status:'denied',execution_permitted:false};
        starts++;status='started';currentRequest=input.prepare;trace.push('durable-start');
        if(options.lostBegin)throw new Error('lost begin response');
        return {status:'committed',state:'started',execution_permitted:true,version:2,intent_id:ids.intent,
          job_id:ids.job,job_request_digest:descriptor.request_digest,request_sha256:input.prepare.request_sha256};
      }
      if(input.action==='provider_attempt'){
        assert.equal(status,'started');assert.equal(posts,0);
        assert.equal(input.attempt.intent_id,ids.intent);assert.equal(input.attempt.parent_id,'track');
        assert.equal(input.attempt.sha256,sha(mutation.content));
        if(options.failAttempt)throw new Error('durable store unavailable');
        if(options.replayedAttempt)return {status:'replayed',attempt_recorded:false,execution_permitted:false,receipt_id:ids.receipt};
        if(options.expireAdmission)now+=60000;
        if(input.semantic_attempt){
          assert.equal(input.semantic_attempt.observed_file_version,null);
          assert.equal(input.semantic_attempt.evidence.before.exists,false);
          assert.equal(input.semantic_attempt.evidence.before.provider_file_id,input.attempt.provider_file_id);
          semanticAttempt=structuredClone(input.semantic_attempt.evidence);
        }
        return {status:'committed',attempt_recorded:true,receipt_id:ids.receipt,attempt:input.attempt,
          ...(semanticAttempt?{semantic_attempt_receipt_id:ids.receipt,semantic_recovery:{receipt_id:ids.receipt,
            evidence:semanticAttempt,no_effect_after_ms:now+700000}}:{})};
      }
      assert.equal(input.action,'finalize');assert.equal(posts,1);assert.equal(input.postcondition.provider_file_id,'new-id');
      if(options.lostFinalize)throw new Error('lost receipt');
      status='committed';return {status:'committed',state:'committed',intent_id:ids.intent,request_sha256:input.request_sha256,
        final_result:{status:'committed'},receipt_id:ids.receipt};
    },drive_fetch:async(url,init)=>{
      const u=new URL(url);
      if(u.href==='https://www.googleapis.com/batch/drive/v3'){
        // Metadata-only GET envelope used by the batched boundary scan; never a file write.
        assert.equal(init.method,'POST');batches++;trace.push('metadata-batch');
        return batchReply(batchRequests(init.body).map(part=>{
          const read=metadata(new URL(part.path,u.origin));return {...part,value:read.value,status:read.status};
        }));
      }
      assert.equal(init.redirect,options.redirect??'error');assert.equal(init.cache,'no-store');
      if(init.method==='POST'){
        assert.equal(status,'started');assert.ok(trace.includes('provider_attempt'));posts++;trace.push('provider-post');
        files.set('new-id',{id:'new-id',name:'new.txt',parents:['track'],version:'1',trashed:false,mimeType:'text/plain',
          size:String(Buffer.byteLength(mutation.content)),sha256Checksum:sha(mutation.content)});
        if(semanticAttempt){
          // Model the metadata in the actual multipart request, rather than
          // inventing a matching marker for the postcondition observer.
          assert.equal(typeof init.body,'string');
          const metadata=JSON.parse(/\r\n\r\n(\{[^\r\n]*\})\r\n/.exec(init.body)?.[1]??'null');
          assert.equal(metadata.id,'new-id');assert.equal(metadata.appProperties.clued_intent_id,ids.intent);
          Object.assign(files.get('new-id'),{explicitlyTrashed:false,headRevisionId:'new-revision',
            appProperties:metadata.appProperties});
        }
        if(options.lostPost)throw new Error('lost provider response');
        return Response.json(files.get('new-id'));
      }
      if(u.pathname.endsWith('/generateIds'))return Response.json({ids:['new-id']});
      const read=metadata(u);return read.status===200?Response.json(read.value):new Response('',{status:read.status});
    }};
  function metadata(u){
    const q=u.searchParams.get('q');
    if(q){
      const parent=/'([^']+)' in parents/.exec(q)?.[1],name=/name = '([^']+)'/.exec(q)?.[1];
      return {status:200,value:{files:[...files.values()].filter(f=>f.parents.includes(parent)&&(!name||f.name===name)).map(f=>project(u,f)),incompleteSearch:false}};
    }
    const item=files.get(u.pathname.split('/').at(-1));return item?{status:200,value:project(u,item)}:{status:404,value:{}};
  }
  return {config,reference:{job_id:ids.job,connection_id:ids.connection},run:()=>createResourceCenterCloudExecutor(config),
    info:()=>({starts,posts,loads,batches,status,trace,currentRequest}),files};
}
