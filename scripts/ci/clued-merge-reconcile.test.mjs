import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReconcileBudget,durableFetch,reconcile,operationKey,MAX_API_PER_CYCLE,HOUR} from './clued-merge-reconcile.mjs';
import {controllerFingerprint,assertControllerIdentity,CONTROLLER_IDENTITY_SHA256,JOURNAL_EPOCH} from './clued-merge-reconcile-host.mjs';

const now=1_790_000_000_000;
const url='https://api.github.com/repos/tdoljyj/cross-memory-system/pulls/123/merge';
const put={method:'PUT',body:JSON.stringify({sha:'a'.repeat(40),merge_method:'merge'})};
async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-reconcile-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const ok=()=>new Response('{}',{status:200});

test('a persisted mutation intent survives lost response and restart; no duplicate send',async t=>{
  const file=path.join(await temporary(t),'budget.json');let sent=0;
  const store=await ReconcileBudget.open(file,now);
  await assert.rejects(durableFetch({store,clock:()=>now,fetchImpl:async()=>{sent++;throw Error('lost response');}})(url,put));
  const reopened=await ReconcileBudget.open(file,now+HOUR);
  await assert.rejects(durableFetch({store:reopened,clock:()=>now+HOUR,fetchImpl:async()=>{sent++;return ok();}})(url,put),/ALREADY_SENT_OR_UNKNOWN/);
  assert.equal(sent,1);assert.equal(reopened.data.operations[operationKey(url,put)].phase,'intent');
});

test('merge, update and rerun are deduplicated; a different head is re-evaluated normally',async t=>{
  const store=await ReconcileBudget.open(path.join(await temporary(t),'budget.json'),now);let sent=0;
  const fetch=durableFetch({store,clock:()=>now,fetchImpl:async()=>{sent++;return ok();}});
  for(const [u,o] of [[url,put],[url.replace('/merge','/update-branch'),put],
    ['https://api.github.com/repos/tdoljyj/cross-memory-system/actions/runs/456/rerun',{method:'POST'}]]){
    await fetch(u,o);await assert.rejects(fetch(u,o),/ALREADY_SENT_OR_UNKNOWN/);
  }
  await fetch(url,{...put,body:JSON.stringify({sha:'b'.repeat(40),merge_method:'merge'})});assert.equal(sent,4);
});

test('known refusal can retry, but a server error remains uncertain',async t=>{
  const store=await ReconcileBudget.open(path.join(await temporary(t),'budget.json'),now);let count=0;
  const fetch=durableFetch({store,clock:()=>now,fetchImpl:async()=>new Response('{}',{status:++count===1?409:503})});
  assert.equal((await fetch(url,put)).status,409);assert.equal((await fetch(url,put)).status,503);
  await assert.rejects(fetch(url,put),/ALREADY_SENT_OR_UNKNOWN/);assert.equal(count,2);
});

test('save failure precedes all network effects and never writes credentials',async t=>{
  const store=await ReconcileBudget.open(path.join(await temporary(t),'budget.json'),now);let called=0;
  store.save=async()=>{throw Error('disk unavailable');};
  await assert.rejects(durableFetch({store,clock:()=>now,fetchImpl:async()=>{called++;return ok();}})(url,{...put,headers:{Authorization:'secret'}}));
  assert.equal(called,0);assert.equal(JSON.stringify(store.data).includes('secret'),false);
});

test('different execution Host cannot load credentials or start a fresh dedup journal',async t=>{
  let sends=0;
  const send=()=>{assertControllerIdentity('0'.repeat(64));sends++;};
  assert.throws(send,/IDENTITY_MISMATCH/);assert.equal(sends,0);
  assert.deepEqual(assertControllerIdentity(CONTROLLER_IDENTITY_SHA256),{controllerIdentitySha256:CONTROLLER_IDENTITY_SHA256,journalEpoch:JOURNAL_EPOCH});
  assert.notEqual(controllerFingerprint({hostname:'A',machineGuid:'11111111-1111-1111-1111-111111111111'}),
    controllerFingerprint({hostname:'B',machineGuid:'11111111-1111-1111-1111-111111111111'}));
  const file=path.join(await temporary(t),'budget.json'),binding=assertControllerIdentity(CONTROLLER_IDENTITY_SHA256);
  await assert.rejects(ReconcileBudget.open(file,now,{requireExisting:true,expectedBinding:binding}),/EXISTING_JOURNAL_REQUIRED/);
  const installed=await ReconcileBudget.open(file,now,{expectedBinding:binding});await installed.save();
  await assert.rejects(ReconcileBudget.open(file,now,{requireExisting:true,expectedBinding:{...binding,journalEpoch:'another-epoch'}}),/STATE_INVALID/);
});

test('an actual sync failure prevents POST; data and replacement are synced before sending',async t=>{
  const file=path.join(await temporary(t),'budget.json'),store=await ReconcileBudget.open(file,now);
  const original=fs.open,events=[];
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await original(...args);
    return new Proxy(handle,{get(target,key){if(key==='sync')return async()=>{events.push('sync');await target.sync();};
      const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  });
  await durableFetch({store,clock:()=>now,fetchImpl:async()=>{assert.deepEqual(events,['sync','sync']);events.push('POST');return ok();}})(url,put);
  assert.equal(events[2],'POST');
  t.mock.restoreAll();let sent=0;
  t.mock.method(fs,'open',async(...args)=>{
    const handle=await original(...args);
    return new Proxy(handle,{get(target,key){if(key==='sync')return async()=>{throw Error('flush refused');};
      const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  });
  await assert.rejects(durableFetch({store,clock:()=>now,fetchImpl:async()=>{sent++;return ok();}})(url,{...put,body:'different'}),/flush refused/);
  assert.equal(sent,0);
});

test('corrupt state, unknown schema, rollback and future budget never reset to empty',async t=>{
  const file=path.join(await temporary(t),'budget.json');await fs.writeFile(file,'{');
  await assert.rejects(ReconcileBudget.open(file,now),/UNREADABLE/);
  await fs.writeFile(file,JSON.stringify({contract:'unknown'}));await assert.rejects(ReconcileBudget.open(file,now),/INVALID/);
  const store=await ReconcileBudget.open(path.join(await temporary(t),'budget.json'),now);await store.save();
  await assert.rejects(ReconcileBudget.open(store.file,now-1),/INVALID/);
  await assert.rejects(durableFetch({store,clock:()=>now-1,fetchImpl:ok})(url,put),/CLOCK_ROLLBACK/);
});

test('429 and exhausted GitHub budget persist backoff across restart',async t=>{
  const file=path.join(await temporary(t),'budget.json');let time=now,calls=0;
  const store=await ReconcileBudget.open(file,time);
  const fetch=durableFetch({store,clock:()=>time,fetchImpl:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'600'}});}});
  await fetch('https://api.github.com/rate_limit');await assert.rejects(fetch(url,put),/RETRY_AFTER/);
  const after=await ReconcileBudget.open(file,now+100);assert.equal(after.data.nextAt,now+600_000);assert.equal(calls,1);
  time=now+600_001;
  const reserve=durableFetch({store:after,clock:()=>time,fetchImpl:async()=>new Response('{}',{status:200,headers:{'x-ratelimit-remaining':'100','x-ratelimit-reset':String((time+HOUR)/1000)}})});
  await reserve('https://api.github.com/rate_limit');await assert.rejects(reserve(url,put),/RETRY_AFTER/);
});

test('per-cycle cap and serialization bound bursts without resetting the hourly ledger',async t=>{
  const store=await ReconcileBudget.open(path.join(await temporary(t),'budget.json'),now);let count=0;
  const fetch=durableFetch({store,clock:()=>now,fetchImpl:async()=>{count++;return ok();}});
  const results=await Promise.allSettled(Array.from({length:MAX_API_PER_CYCLE+2},()=>fetch('https://api.github.com/rate_limit')));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,MAX_API_PER_CYCLE);assert.equal(count,MAX_API_PER_CYCLE);
  assert.equal((await ReconcileBudget.open(store.file,now)).data.calls.length,MAX_API_PER_CYCLE);
});

test('missing completion/no new push and restart re-observe current eligibility, not old event text',async t=>{
  const dir=await temporary(t),event=path.join(dir,'event.json');await fs.writeFile(event,JSON.stringify({inputs:{reconcile_request_id:'12345678-1234-1234-1234-123456789abc'},pull_request:{head:{sha:'stale'}}}));
  const env={GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'tdoljyj/cross-memory-system'};
  let phase='waiting',reports=0,merges=0;
  const report=async args=>{assert.equal(args.event,null);reports++;return {errors:[]};};
  const execute=async({fetchImpl})=>{if(phase==='ready'){await fetchImpl(url,put);merges++;}return {errors:[]};};
  for(const current of ['waiting','ready','already-merged','head-changed','main-moved','failed']){
    phase=current;const store=await ReconcileBudget.open(path.join(dir,'budget.json'),now);
    assert.equal((await reconcile({env,workspace:dir,store,clock:()=>now,fetchImpl:ok,report,execute})).status,'RECONCILED');
  }
  assert.equal(reports,6);assert.equal(merges,1);
  await assert.rejects(reconcile({env:{...env,GITHUB_REF:'refs/heads/feature'},store:{},report,execute}),/ENTRY_INVALID/);
  const failed=await reconcile({env,workspace:dir,store:await ReconcileBudget.open(path.join(dir,'budget.json'),now),report:async()=>({errors:['network']}),execute:()=>{throw Error('must not execute');}});
  assert.equal(failed.status,'REPORT_FAILED');
});
