import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from '../../../../apps/clued-cloud/tests/cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createExecutionStore,projectRef,rootId} from './client.mjs';
const require=createRequire(new URL('../../../../apps/clued-cloud/package.json',import.meta.url));
const EmbeddedPostgres=require('embedded-postgres').default;
const directory=path.dirname(fileURLToPath(import.meta.url));
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const h='a'.repeat(64),gen='ctrgen_352785779b64458a889d571360e2d2d5',container='c'.repeat(64);
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const value=s.address().port;await new Promise(r=>s.close(r));return value;}

test('same-domain runtime SQL candidate; synthetic local PG only',{timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-execution-store-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:crypto.randomBytes(32).toString('hex'),port:await port(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];
 try{
  await server.initialise();await server.start();const admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create table public.legacy_sentinel(value text);insert into public.legacy_sentinel values(\'unchanged\');');
  const oldSql=await fs.readFile(path.join(directory,'../install.candidate.sql'),'utf8');
  const sql=await fs.readFile(path.join(directory,'install.candidate.sql'),'utf8');
  await assert.rejects(admin.query(sql),/wrong_or_missing_existing_control_domain/);
  await admin.query("set clued_control.target_project='uscrdifznmlvczcekqpw'");await admin.query(oldSql);
  const privileges=(await admin.query("select oid::regprocedure::text name,proacl::text,prosecdef,proconfig from pg_proc where pronamespace='clued_control'::regnamespace order by name")).rows;
  await admin.query(sql);
  const oldNames=privileges.map(x=>x.name);
  assert.deepEqual((await admin.query("select oid::regprocedure::text name,proacl::text,prosecdef,proconfig from pg_proc where pronamespace='clued_control'::regnamespace order by name")).rows.filter(x=>oldNames.includes(x.name)),privileges);
  const connect=async role=>{const c=server.getPgClient();clients.push(c);await c.connect();await c.query('set role '+role);return c;};
  const writer=await connect('service_role'),other=await connect('service_role');
  const store=createExecutionStore({project:projectRef,query:writer.query.bind(writer)}),store2=createExecutionStore({project:projectRef,query:other.query.bind(other)});
  await t.test('empty install blocks and private clients cannot read or write tables',async()=>{
   assert.equal(await store.read(),null);
   await assert.rejects(store.reserveExactGa(JSON.stringify({gate_authorization_id:'ga_empty',idempotency_key:'empty'})),/accepted_execution_binding_missing/);
   for(const role of ['anon','authenticated']){const c=await connect(role);await assert.rejects(c.query('select clued_control.read_execution()'),/permission denied/);}
   await assert.rejects(writer.query('select * from clued_control.gate_attempts'),/permission denied/);
  });
  // Synthetic metadata is injected only into this throwaway database by its admin.
  // G1 here tests string binding; it is NOT a proposed applicable pre-entry Gate.
  await admin.query(`insert into clued_control.accepted_binding values($1,$2,'SKILL_COEXISTENCE_QUALIFICATION','ISOLATED_TEST',
   'e4ab25ecb1fa6709435d0318ad431d14343482cbe84e232f638e55c3c4ba1e1f','4d7f93c17cf7d126e771cf8aca6299c868cba0a9',
   clock_timestamp()-interval '1 minute',least(clock_timestamp()+interval '10 minutes','2026-09-09T09:28:59Z'),
   'SYNTHETIC_ISSUER','SYNTHETIC_AUDIENCE','SYNTHETIC_CONFIG',$3,$3,$3,$3,$3)`,[rootId,projectRef,h]);
  await admin.query('insert into clued_control.current_head values($1,1,$2,false)',[rootId,gen]);
  await admin.query("insert into clued_control.execution_binding values($1,$2,$2,$2,$2,'G1','SYNTHETIC_DEFINITION_NOT_ACCEPTED',$2,$2,1410,19264968)",[rootId,h]);
  await admin.query("insert into clued_control.execution_current values($1,'runner-initial','credential-initial','session-initial',0,null,1410,19264968)",[rootId]);
  const makeGa=key=>{const now=Date.now();return {gate_authorization_id:'ga_'+key,idempotency_key:key,authorization_status:'AUTHORIZED',purpose:'SKILL_COEXISTENCE_QUALIFICATION',environment:'ISOLATED_TEST',
   profile_digest:h,controller_digest:h,scope_digest:h,gate_id:'G1',controller_qualification_ref:{sha256:h},control_trust_root_generation:gen,
   runner_generation:'runner-initial',credential_generation:'credential-initial',session_generation:'session-initial',
   issued_at:new Date(now-1000).toISOString(),deadline:new Date(now+60000).toISOString(),expires_at:new Date(now+60000).toISOString()};};
  const raw=JSON.stringify(makeGa('first'));
  await t.test('duplicate JSON keys and issuance before Owner window reject without writes',async()=>{
   const before=await store.read();
   await assert.rejects(store.reserveExactGa(raw.replace('"gate_id":"G1"','"gate_id":"G1","gate_id":"G1"')),/invalid_unique_ga_object/);
   await assert.rejects(store.reserveExactGa(JSON.stringify({...makeGa('early'),issued_at:new Date(Date.now()-120000).toISOString()})),/ga_window_invalid/);
   assert.deepEqual(await store.read(),before);
  });
  await t.test('concurrent exact reserve writes once and charges one reservation',async()=>{
   const results=await Promise.all([store.reserveExactGa(raw),store2.reserveExactGa(raw)]);
   assert.deepEqual(results.map(x=>x.status).sort(),['DUPLICATE','RESERVED']);
   const current=(await store.read()).current;assert.equal(current.charged_seconds,1471);assert.equal(current.charged_evidence_bytes,153482696);
  });
  await t.test('same key changed body and competing capacity reject without counter changes',async()=>{
   const before=await store.read();await assert.rejects(store.reserveExactGa(JSON.stringify({...JSON.parse(raw),scope_digest:'b'.repeat(64)})),/idempotency_conflict/);
   await assert.rejects(store.reserveExactGa(JSON.stringify(makeGa('competing'))),/budget_or_active_capacity_unavailable/);
   assert.deepEqual(await store.read(),before);
  });
  let n=0;
  const transition=async(op,body={},ga='ga_first')=>{
   let state=await store.read();const attempt=state.attempts.find(x=>x.ga_id===ga);
   if((op==='CREATE_SENT'&&attempt.phase==='PENDING')||(op==='START_SENT'&&attempt.phase==='CREATED')){
    const operation=op.replace('_SENT','');
    let existing=state.events.find(e=>e.request.ga_id===ga&&e.request.operation==='INTENT_RECORDED'&&e.request.body.operation===operation);
    if(!existing){const intentRaw=JSON.stringify({ga_id:ga,ga_sha256:attempt.ga_sha256,operation});const recorded=await store.recordIntent({gaId:ga,key:'intent_'+ga+'_'+operation,body:{operation,raw:intentRaw,sha256:sha(intentRaw)}});existing=(await store.readEvent(recorded.sequence)).event;}
    body={...body,intent_sequence:existing.sequence,intent_sha256:existing.request.body.sha256};state=await store.read();
   }
   if(['CREATED','RUNNING','STOPPED','RECONCILED_CONTAINER'].includes(op)){
    const resultRaw=JSON.stringify({ga_id:ga,ga_sha256:attempt.ga_sha256,operation:op,container_id:body.container_id,observation:{synthetic:true}});
    body={...body,raw:resultRaw,sha256:sha(resultRaw)};
   }
   return store.transition({idempotency_key:'event_'+(++n),expected_sequence:state.current.sequence,ga_id:ga,operation:op,body});
  };
  await t.test('independent generation rotation prevents next effect and cannot roll back',async()=>{
   const state=await store.read();await store.rotate({idempotency_key:'rotate',expected_sequence:state.current.sequence,generation_kind:'credential_generation',previous:'credential-initial',replacement:'credential-next',signed_source_sha256:h});
   await assert.rejects(transition('CREATE_SENT',{intent_sha256:h}),/current_authority_or_generation_changed/);
   const now=await store.read();await assert.rejects(store.rotate({idempotency_key:'rollback',expected_sequence:now.current.sequence,generation_kind:'credential_generation',previous:'credential-next',replacement:'credential-initial',signed_source_sha256:h}),/generation_rollback_or_conflict/);
   // Change the synthetic GA input only by terminating and issuing a new GA is
   // required in reality. Here this admin restores fixture state for separate
   // transition tests; it is not exposed by the private service_role interface.
   await admin.query("update clued_control.execution_current set credential_generation='credential-initial' where root_id=$1",[rootId]);
  });
  await t.test('fixed lifecycle records send before observation and binds exact stopped ID',async()=>{
   await transition('CREATE_SENT',{intent_sha256:h});
   await assert.rejects(transition('START_SENT',{intent_sha256:h}),/phase_conflict/);
   await transition('CREATED',{container_id:container});await transition('START_SENT',{intent_sha256:h});await transition('RUNNING',{container_id:container});
   await transition('STOP_SENT',{container_id:container});
   await assert.rejects(transition('STOPPED',{container_id:'d'.repeat(64),observation_sha256:h}),/stopped_observation_missing/);
   await transition('STOPPED',{container_id:container,observation_sha256:h});
   await transition('DECISION_RESERVED',{decision_sha256:h,evidence_index_sha256:h,result:'BLOCKED'});await transition('SIGNING',{decision_sha256:h});
  });
  await t.test('one exact result per GA releases slot only after stopped reservation and preserves raw bytes',async()=>{
   const receipt=JSON.stringify({gate_result_receipt_id:'grr_first',gate_authorization_id:'ga_first',result:'BLOCKED',schema_digest:h,issuer_purpose:'GATE_RESULT',audience:'SYNTHETIC_AUDIENCE',signature:'SYNTHETIC_ONLY_NOT_A_SIGNATURE'});
   const results=await Promise.all([store.commitExactResult(receipt,h),store2.commitExactResult(receipt,h)]);
   assert.deepEqual(results.map(x=>x.status).sort(),['COMMITTED','DUPLICATE']);
   await assert.rejects(store.commitExactResult(receipt.replace('BLOCKED','PASS'),h),/one_ga_one_immutable_grr/);
   const state=await store.read();assert.equal(state.current.active_ga_id,null);assert.equal(state.attempts[0].ga_raw,raw);assert.equal(state.attempts[0].receipt_raw,receipt);
   await assert.rejects(admin.query("update clued_control.gate_attempts set ga_raw='{}'"),/immutable_gate_bytes_or_decision/);
   await assert.rejects(admin.query('truncate clued_control.gate_attempts'),/immutable_control_evidence/);
  });
  await t.test('revocation UNKNOWN keeps capacity and never permits blind rerun',async()=>{
   await store.reserveExactGa(JSON.stringify(makeGa('second')));await transition('REVOKE',{},'ga_second');
   await assert.rejects(transition('CREATE_SENT',{intent_sha256:h},'ga_second'),/current_authority_or_generation_changed/);
   await assert.rejects(store.reserveExactGa(JSON.stringify(makeGa('third'))),/budget_or_active_capacity_unavailable/);
   assert.equal((await store.read()).current.active_ga_id,'ga_second');
  });
  await t.test('UNKNOWN discovery records exact container for cleanup without restoring launch authority',async()=>{
   await assert.rejects(transition('RECONCILED_CONTAINER',{container_id:container},'ga_second'),/exact_unknown_reconciliation_required/);
   await transition('RECONCILED_CONTAINER',{container_id:container,observation_sha256:h},'ga_second');
   assert.equal((await store.read()).attempts.find(a=>a.ga_id==='ga_second').phase,'UNKNOWN');
   await assert.rejects(transition('START_SENT',{intent_sha256:h},'ga_second'),/current_authority_or_generation_changed/);
   await transition('STOP_SENT',{container_id:container},'ga_second');await transition('STOPPED',{container_id:container,observation_sha256:h},'ga_second');
   assert.equal((await store.read()).current.active_ga_id,'ga_second');
  });
  assert.deepEqual((await admin.query('select * from public.legacy_sentinel')).rows,[{value:'unchanged'}]);
 }finally{await Promise.all(clients.map(c=>c.end().catch(()=>{})));await server.stop().catch(()=>{});}
});
