import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {reportMergeSlots} from './clued-merge-slot-ci.mjs';
import {runExecutor} from './clued-merge-executor.mjs';
import {exportNaturalArtifact} from './merge-admission-source-producer.mjs';
import {verifyReconcileSource} from './clued-merge-reconcile-source.mjs';
import {assertControllerIdentity} from './clued-merge-reconcile-host.mjs';
import {markDurableFetch,readReconcileActivation} from './clued-merge-reconcile-gate.mjs';

export const COMPONENT_VERSION='1.0.21';
export const CONTRACT='clued.merge-reconciliation-budget/1';
export const HOUR=3_600_000, MAX_API_PER_HOUR=1500, MAX_API_PER_CYCLE=250;
export const MAX_OPERATIONS=2000, MIN_GITHUB_REMAINING=750;
const sha=x=>createHash('sha256').update(x).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail=code=>{throw Error(code);};
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);

// Protected, pre-provisioned controller storage. Absence/corruption fails
// closed; restarting never resets an existing budget or mutation intent.
export class ReconcileBudget {
  constructor(file,data){this.file=file;this.data=data;}
  static async open(file,now,{requireExisting=false,expectedBinding=null}={}){
    let d;
    try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)fail('RECONCILE_STATE_INVALID');
      d=JSON.parse(await fs.readFile(file,'utf8'));}
    catch(e){if(e.code!=='ENOENT')fail('RECONCILE_STATE_UNREADABLE');
      if(requireExisting)fail('RECONCILE_EXISTING_JOURNAL_REQUIRED');
      d={contract:CONTRACT,lastAt:now,nextAt:0,calls:[],operations:{},binding:expectedBinding};}
    if(d.contract!==CONTRACT||!Number.isSafeInteger(d.lastAt)||d.lastAt>now||!Number.isSafeInteger(d.nextAt)
      ||!Array.isArray(d.calls)||d.calls.length>MAX_API_PER_HOUR||d.calls.some(t=>!Number.isSafeInteger(t)||t>now||t<1)
      ||!plain(d.operations)||Object.keys(d.operations).length>MAX_OPERATIONS
      ||Object.entries(d.operations).some(([key,v])=>!/^[a-f0-9]{64}$/.test(key)||!plain(v)
        ||!['intent','accepted','refused'].includes(v.phase)||!Number.isSafeInteger(v.at)||v.at>now
        ||(v.status!==null&&!Number.isInteger(v.status)))
      ||(expectedBinding&&JSON.stringify(d.binding)!==JSON.stringify(expectedBinding)))fail('RECONCILE_STATE_INVALID');
    return new ReconcileBudget(file,d);
  }
  async save(){
    const tmp=this.file+'.'+randomUUID()+'.tmp';
    const handle=await fs.open(tmp,'wx');
    try{await handle.writeFile(JSON.stringify(this.data));await handle.sync();}finally{await handle.close();}
    await fs.rename(tmp,this.file);
    // Confirm the replacement itself is durably readable before any POST.
    const committed=await fs.open(this.file,'r+');
    try{await committed.sync();}finally{await committed.close();}
  }
}

export function operationKey(url,options={}){
  const u=new URL(url),method=String(options.method??'GET').toUpperCase();
  if(u.origin!=='https://api.github.com')return null;
  if(!((method==='PUT'&&/^\/repos\/tdoljyj\/cross-memory-system\/pulls\/[1-9][0-9]*\/(?:merge|update-branch)$/.test(u.pathname))
    ||(method==='POST'&&/^\/repos\/tdoljyj\/cross-memory-system\/actions\/runs\/[1-9][0-9]*\/rerun$/.test(u.pathname))))return null;
  // No header, token, body, error text or private response is persisted.
  return sha(JSON.stringify([method,u.pathname,String(options.body??'')]));
}

// The original executor still makes every current Native/FIFO/Owner/rules/
// required-check/Source/expected-head decision. This wrapper supplies only a
// durable budget and at-most-once send for a planned merge/update/rerun.
export function durableFetch({store,fetchImpl,clock=Date.now}){
  let cycle=0,tail=Promise.resolve();
  const one=async(url,options={})=>{
    const now=clock(),d=store.data;
    if(!Number.isSafeInteger(now)||now<d.lastAt)fail('RECONCILE_CLOCK_ROLLBACK');
    if(now<d.nextAt)fail('RECONCILE_RETRY_AFTER');
    d.calls=d.calls.filter(t=>now-t<HOUR);d.lastAt=now;
    if(cycle>=MAX_API_PER_CYCLE||d.calls.length>=MAX_API_PER_HOUR)fail('RECONCILE_API_BUDGET');
    const key=operationKey(String(url),options);
    if(key&&d.operations[key]&&d.operations[key].phase!=='refused')fail('RECONCILE_OPERATION_ALREADY_SENT_OR_UNKNOWN');
    // Never silently evict an intent: that could repeat a prior mutation.
    if(key&&!d.operations[key]&&Object.keys(d.operations).length>=MAX_OPERATIONS)fail('RECONCILE_OPERATION_RETENTION_FULL');
    d.calls.push(now);cycle++;
    if(key)d.operations[key]={at:now,phase:'intent',status:null};
    await store.save(); // failure means zero outbound requests
    const response=await fetchImpl(url,options); // uncertainty leaves the intent
    if(key){
      const noEffect=[400,401,403,404,405,409,422,429].includes(response.status);
      const accepted=[200,201,202,204].includes(response.status);
      d.operations[key]={at:now,phase:noEffect?'refused':accepted?'accepted':'intent',status:response.status};
    }
    const remaining=response.headers?.get('x-ratelimit-remaining');
    const reset=Number(response.headers?.get('x-ratelimit-reset'));
    const retry=response.headers?.get('retry-after');
    if(response.status===429||(response.status===403&&remaining==='0')){
      const wait=/^[0-9]+$/.test(retry??'')?now+Number(retry)*1000:Date.parse(retry??'');
      d.nextAt=Math.max(d.nextAt,Number.isFinite(wait)?wait:now+15*60_000);
    }
    if(new URL(String(url)).origin==='https://api.github.com'&&remaining!==null&&remaining!==undefined
      &&/^[0-9]+$/.test(remaining)&&Number(remaining)<MIN_GITHUB_REMAINING)
      d.nextAt=Math.max(d.nextAt,Number.isFinite(reset)&&reset>now/1000?reset*1000:now+15*60_000);
    await store.save();
    return response;
  };
  return markDurableFetch((url,options)=>{
    const result=tail.then(()=>one(url,options));
    tail=result.catch(()=>{});
    return result;
  });
}

export async function reconcile({env,workspace,fetchImpl,store,clock=Date.now,report=reportMergeSlots,execute=runExecutor}){
  const request=JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH,'utf8')).inputs?.reconcile_request_id;
  if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REF!=='refs/heads/main'
    ||env.GITHUB_REPOSITORY!=='tdoljyj/cross-memory-system'||!uuid.test(request??''))fail('RECONCILE_ENTRY_INVALID');
  const fetch=durableFetch({store,fetchImpl,clock});
  // Event text is never an eligibility proof. Re-list every current head.
  const slot=await report({env,workspace,fetchImpl:fetch,event:null,eventName:'workflow_dispatch'});
  if(slot.errors?.length)return {status:'REPORT_FAILED',request,slot,executor:null};
  const executor=await execute({env,workspace,fetchImpl:fetch});
  return {status:executor.errors?.length?'EXECUTOR_FAILED':'RECONCILED',request,slot,executor};
}

export async function main(env=process.env){
  const workspace=env.GITHUB_WORKSPACE;
  if(process.platform!=='win32'||env.RUNNER_OS!=='Windows'||!workspace)fail('RECONCILE_QUALIFIED_CONTROLLER_REQUIRED');
  verifyReconcileSource(workspace);
  const binding=assertControllerIdentity();
  if(readReconcileActivation().enabled!==true)fail('RECONCILE_NOT_ACTIVATED');
  // Provisioned by the separately accepted controller installation, with its
  // own retention/ACL policy. This workflow never creates the trusted root.
  const root='C:\\ProgramData\\CluedControl\\merge-reconcile';
  const info=await fs.lstat(root);
  if(!info.isDirectory()||info.isSymbolicLink())fail('RECONCILE_TRUSTED_SPOOL_REQUIRED');
  const retained=await fs.readdir(root);
  if(retained.length>=2000)fail('RECONCILE_EVIDENCE_RETENTION_FULL');
  const store=await ReconcileBudget.open(path.join(root,'budget.json'),Date.now(),{requireExisting:true,expectedBinding:binding});
  let result;
  try{result=await reconcile({env,workspace,store,fetchImpl:globalThis.fetch});}
  finally{
    // Keep the unchanged natural observation packet on owned storage. No
    // official upload, no conversion of a packet into an authority receipt.
    const packet=exportNaturalArtifact({env,workspace,expected:['slot','executor']});
    const name=[env.GITHUB_RUN_ID,env.GITHUB_RUN_ATTEMPT,env.GITHUB_JOB].join('-');
    if(!/^[1-9][0-9]*-[1-9][0-9]*-[A-Za-z0-9_-]+$/.test(name))fail('RECONCILE_NATIVE_ID_INVALID');
    const bytes=await fs.readFile(packet.filename);
    await fs.writeFile(path.join(root,name+'.json'),bytes,{flag:'wx'});
  }
  // Public status only; original observation bodies stay in the local spool.
  console.log(JSON.stringify({status:result.status,request:result.request}));
  return result.status==='RECONCILED'?0:1;
}
if(import.meta.main)
  main().then(code=>{process.exitCode=code;},()=>{console.error('MERGE_RECONCILE_FAILED_CLOSED');process.exitCode=1;});
