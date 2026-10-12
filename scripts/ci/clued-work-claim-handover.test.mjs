import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import {revokeHandover} from './clued-work-claim-handover.mjs';
import {ADMISSION_APP_ID} from './clued-work-admission.mjs';
const workspace=path.resolve(import.meta.dirname,'../..');
const privateKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const head='a'.repeat(40);
const environment={GITHUB_REPOSITORY:'o/r',GITHUB_API_URL:'https://api.test',GITHUB_TOKEN:'synthetic-gh',
  CLUED_CONTEXT_READ_TOKEN:'synthetic-clued',CLUED_ADMISSION_APP_ID:String(ADMISSION_APP_ID),CLUED_ADMISSION_APP_PRIVATE_KEY:privateKey};
function fixture({running=false,publication=false,markerVisible=true,failCheck=false,prRunning=false,stopsOnCancel=false,historicHead=null,historyUnavailable=false,historyTruncated=false,headMoves=false}={}) {
  const calls=[];let patched=false,cancelled=false,reconciled=false,prReads=0;
  const fetchImpl=async(url,init={})=>{
    const method=init.method??'GET',body=init.body?JSON.parse(init.body):null;
    calls.push({url:String(url),method,body});
    let data={},status=200;
    if(String(url).includes('/rest/v1/rpc/clued_work_claims_active_v1'))data={status:'ok',active_work_claims:[]};
    else if(String(url).includes('/rest/v1/rpc/clued_work_verify_v1')){
      const input=body.p_input;
      if(input.action==='revocations_contexts')data={status:'ok',context_keys:['global'],next_cursor:null};
      else if(input.action==='revocations_list')data={status:'ok',revocations:[{outbox_id:'outbox',claim_id:'claim',
        execution_epoch:2,repository:'o/r',head_sha:head,pr_ref:'o/r#7'}],
        publications:running||publication?[{publication_id:'pub',execution_epoch:1,repository:'o/r',head_sha:head,run_id:'88'}]:[],
        next_outbox_cursor:null,next_publication_cursor:null};
      else if(input.action==='publication_reconcile'){reconciled=true;data={status:'committed'};}
      else if(input.action==='revocation_ack'&&(running||publication)&&!reconciled)data={status:'rejected',error_code:'work_claim_publications_unresolved'};
      else data={status:'committed'};
    }else if(String(url).endsWith('/installation'))data={id:1};
    else if(String(url).endsWith('/access_tokens')){data={token:'synthetic-app'};status=201;}
    else if(String(url).includes('/actions/runs/88'))data={status:running?'in_progress':'completed'};
    else if(String(url).includes('/actions/runs?'))data={total_count:prRunning?1:0,workflow_runs:prRunning?
      [{id:101,event:'pull_request',status:'in_progress',path:'.github/workflows/heavy.yml'}]:[]};
    else if(String(url).includes('/actions/runs/101')){
      if(method==='POST'){cancelled=true;status=202;}
      data={status:cancelled&&stopsOnCancel?'completed':'in_progress'};
    }
    else if(String(url).endsWith('/pulls/7'))data={node_id:'node',head:{sha:headMoves&&prReads++?'c'.repeat(40):head},auto_merge:null,
      commits:historyTruncated?300:historicHead?2:1};
    else if(String(url).includes('/pulls/7/commits?')){
      if(historyUnavailable)status=503;
      data=[{sha:head},...(historicHead?[{sha:historicHead}]:[])];
    }
    else if(String(url).includes('/check-runs?'))data={total_count:1,check_runs:[{id:42,name:'clued-admission-verified',
      app:{id:ADMISSION_APP_ID},external_id:markerVisible?'pr:7/run:88:publication:pub':null,conclusion:patched?'failure':'success'}]};
    else if(String(url).endsWith('/check-runs/42')&&method==='PATCH'){
      if(failCheck)status=503;else patched=true;
    }else if(String(url).endsWith('/check-runs/42')&&method==='GET')data={id:42,status:'completed',conclusion:patched?'failure':'success'};
    else throw new Error('Unexpected request '+method+' '+url);
    return {ok:status>=200&&status<300,status,json:async()=>data,text:async()=>JSON.stringify(data),headers:{get:()=>null}};
  };
  return {fetchImpl,calls};
}
test('revoker confirms old App checks failed before acknowledging an epoch',async()=>{
  const f=fixture();const result=await revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl});
  assert.equal(result.acknowledged,1);assert.equal(result.pending,0);
  const patch=f.calls.findIndex(c=>c.method==='PATCH');const ack=f.calls.findIndex(c=>c.body?.p_input?.action==='revocation_ack');
  assert.ok(patch>=0&&ack>patch);assert.equal(f.calls[patch].body.conclusion,'failure');
});
test('a legacy PR revokes historical heads even when the outbox only names its current head',async()=>{
  const old='b'.repeat(40),f=fixture({historicHead:old});
  const result=await revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl});
  assert.equal(result.acknowledged,1);
  const historical=f.calls.findIndex(c=>c.method==='GET'&&c.url.includes(`/commits/${old}/check-runs?`));
  const ack=f.calls.findIndex(c=>c.body?.p_input?.action==='revocation_ack');
  assert.ok(historical>=0&&ack>historical);
  assert.ok(f.calls.slice(historical,ack).some(c=>c.method==='PATCH'&&c.body.conclusion==='failure'));
});
test('unavailable legacy PR history refuses acknowledgement instead of silently retaining old green heads',async()=>{
  const f=fixture({historyUnavailable:true});
  await assert.rejects(revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl}),/returned 503/);
  assert.equal(f.calls.some(c=>c.body?.p_input?.action==='revocation_ack'),false);
});
test('a provider history cap cannot make partial legacy history look complete',async()=>{
  const f=fixture({historyTruncated:true});
  await assert.rejects(revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl}),/history is incomplete/);
  assert.equal(f.calls.some(c=>c.body?.p_input?.action==='revocation_ack'),false);
});
test('a PR head moving during the sweep retains the revocation until that head is drained',async()=>{
  const f=fixture({headMoves:true});
  const result=await revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl});
  assert.equal(result.acknowledged,0);assert.ok(result.pending>0);
  assert.equal(f.calls.some(c=>c.body?.p_input?.action==='revocation_ack'),false);
});
test('revoker does not treat requested cancellation as a stopped publisher',async()=>{
  const f=fixture({running:true});const result=await revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl});
  assert.equal(result.acknowledged,0);assert.ok(result.pending>0);
  assert.equal(f.calls.some(c=>c.body?.p_input?.action==='publication_reconcile'),false);
});
test('failed external check revocation leaves handover pending without ACK',async()=>{
  const f=fixture({failCheck:true});await assert.rejects(revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl}),/returned 503/);
  assert.equal(f.calls.some(c=>c.body?.p_input?.action==='revocation_ack'),false);
});
test('old PR jobs must actually stop before the epoch can be acknowledged',async()=>{
  let f=fixture({prRunning:true});let result=await revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl});
  assert.equal(result.acknowledged,0);assert.ok(result.pending>0);
  assert.equal(f.calls.some(c=>c.body?.p_input?.action==='revocation_ack'),false);
  f=fixture({prRunning:true,stopsOnCancel:true});result=await revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl});
  assert.equal(result.acknowledged,1);
  const cancel=f.calls.findIndex(c=>c.method==='POST'&&c.url.endsWith('/actions/runs/101/cancel'));
  const ack=f.calls.findIndex(c=>c.body?.p_input?.action==='revocation_ack');
  assert.ok(cancel>=0&&ack>cancel);
});

test('an uncertain POST is reconciled only through its exact publication marker and confirmed failed check',async()=>{
  const f=fixture({publication:true});const result=await revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl});
  assert.equal(result.acknowledged,1);
  const read=f.calls.findIndex(c=>c.method==='GET'&&c.url.endsWith('/check-runs/42'));
  const reconcile=f.calls.findIndex(c=>c.body?.p_input?.action==='publication_reconcile');
  assert.ok(read>=0&&reconcile>read);assert.equal(f.calls[reconcile].body.p_input.check_run_id,'42');
});

test('a stopped publisher with no exact check identity leaves its uncertain publication open',async()=>{
  const f=fixture({publication:true,markerVisible:false});const result=await revokeHandover({env:environment,workspace,fetchImpl:f.fetchImpl});
  assert.equal(result.acknowledged,0);assert.ok(result.pending>0);
  assert.equal(f.calls.some(c=>c.body?.p_input?.action==='publication_reconcile'),false);
});

test('durable context and outbox cursors drain every page without relying on live claims',async()=>{
  const f=fixture();const acknowledged=[];
  const id=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
  const fetchImpl=async(url,init={})=>{
    const body=init.body?JSON.parse(init.body):null,input=body?.p_input;
    const ok=data=>({ok:true,status:200,json:async()=>data,text:async()=>JSON.stringify(data),headers:{get:()=>null}});
    if(input?.action==='revocations_contexts')return ok(input.cursor?{status:'ok',context_keys:[],next_cursor:null}:
      {status:'ok',context_keys:['global'],next_cursor:'global'});
    if(input?.action==='revocations_list'){
      const first=!input.outbox_cursor;
      return ok({status:'ok',revocations:Array.from({length:first?100:1},(_,n)=>({outbox_id:id(first?n+1:101),claim_id:'claim',
        execution_epoch:2,repository:'o/r',head_sha:head,pr_ref:'o/r#7'})),publications:[],
        next_outbox_cursor:first?id(100):null,next_publication_cursor:null});
    }
    if(input?.action==='revocation_ack'){acknowledged.push(input.outbox_id);return ok({status:'committed'});}
    assert.equal(String(url).includes('clued_work_claims_active_v1'),false);
    return f.fetchImpl(url,init);
  };
  const result=await revokeHandover({env:environment,workspace,fetchImpl});
  assert.equal(result.acknowledged,101);assert.equal(new Set(acknowledged).size,101);assert.ok(acknowledged.includes(id(101)));
});

test('a repeated or missing cursor is refused before any external revocation or ACK',async()=>{
  const f=fixture();
  const fetchImpl=async(url,init={})=>{
    const input=init.body?JSON.parse(init.body).p_input:null;
    if(input?.action==='revocations_contexts'){
      const data={status:'ok',context_keys:['global'],next_cursor:'global'};
      return {ok:true,status:200,text:async()=>JSON.stringify(data),headers:{get:()=>null}};
    }
    return f.fetchImpl(url,init);
  };
  await assert.rejects(revokeHandover({env:environment,workspace,fetchImpl}),/cursor unavailable/);
  assert.equal(f.calls.some(c=>c.method==='PATCH'||c.body?.p_input?.action==='revocation_ack'),false);
});
