import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from '../../../../apps/clued-cloud/tests/cluster-cleanup.mjs';
// Reuses the existing disposable PG setup; only new remote-evidence checks follow.
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
  const windowStart=Date.now()-1000;
  const evidenceGa={...makeGa('evidence'),issued_at:new Date(windowStart).toISOString(),deadline:new Date(windowStart+180000).toISOString(),expires_at:new Date(windowStart+180000).toISOString()};
  const raw=JSON.stringify(evidenceGa);
  await t.test('explicit 180-second candidate window remains bounded',async()=>{
   await assert.rejects(store.reserveExactGa(JSON.stringify({...evidenceGa,deadline:new Date(windowStart+181000).toISOString(),expires_at:new Date(windowStart+181000).toISOString()})),/ga_window_invalid/);
  });
  await store.reserveExactGa(raw);
  let n=0;
  const call=async(operation,body)=>{const s=await store.read();return store.transition({idempotency_key:'new_evidence_'+(++n),expected_sequence:s.current.sequence,ga_id:'ga_evidence',operation,body});};
  const intentRaw=JSON.stringify({ga_id:'ga_evidence',ga_sha256:sha(raw),operation:'CREATE'});
  await t.test('same transaction Intent cannot authorize external dispatch',async()=>{
   await writer.query('begin');
   const recorded=await call('INTENT_RECORDED',{operation:'CREATE',raw:intentRaw,sha256:sha(intentRaw)});
   await assert.rejects(call('CREATE_SENT',{intent_sequence:recorded.sequence,intent_sha256:sha(intentRaw)}),/exact_prior_committed_intent_required/);
   await writer.query('rollback');
   assert.equal((await store.read()).attempts[0].phase,'PENDING');
  });
  let sequence;
  await t.test('committed exact Intent readback binds next current transaction and preserves raw bytes',async()=>{
   await assert.rejects(call('INTENT_RECORDED',{operation:'CREATE',raw:intentRaw,sha256:'b'.repeat(64)}),/exact_intent_bytes_required/);
   const recorded=await store.recordIntent({gaId:'ga_evidence',key:'fixed_create_intent',body:{operation:'CREATE',raw:intentRaw,sha256:sha(intentRaw)}});sequence=recorded.sequence;
   assert.equal((await store.readEvent(sequence)).event.request.body.raw,intentRaw);
   await assert.rejects(call('CREATE_SENT',{intent_sequence:sequence,intent_sha256:'b'.repeat(64)}),/exact_prior_committed_intent_required/);
   const sent=await store.dispatchIntent({gaId:'ga_evidence',operation:'CREATE',key:'fixed_create_dispatch',sequence,digest:sha(intentRaw)});
   assert.equal(sent.prior_committed_intent_readback.request.body.raw,intentRaw);
   assert.equal(sent.current_context.current.active_ga_id,'ga_evidence');assert.equal(sent.current_context.attempts[0].phase,'CREATE_SENT');
   assert.equal((await store.recordIntent({gaId:'ga_evidence',key:'fixed_create_intent',body:{operation:'CREATE',raw:intentRaw,sha256:sha(intentRaw)}})).status,'DUPLICATE');
   assert.equal((await store.dispatchIntent({gaId:'ga_evidence',operation:'CREATE',key:'fixed_create_dispatch',sequence,digest:sha(intentRaw)})).status,'DUPLICATE');
   await assert.rejects(call('CREATE_SENT',{intent_sequence:sequence,intent_sha256:sha(intentRaw)}),/phase_conflict/);
  });
  await t.test('full observed Result is durably bound to exact GA and container without a GRR',async()=>{
   const resultRaw=JSON.stringify({ga_id:'ga_evidence',ga_sha256:sha(raw),operation:'CREATED',container_id:container,observation:{Id:container,synthetic:true}});
   await assert.rejects(call('CREATED',{container_id:container,raw:resultRaw,sha256:'b'.repeat(64)}),/exact_result_bytes_required/);
   const result=await call('CREATED',{container_id:container,raw:resultRaw,sha256:sha(resultRaw)});
   assert.equal((await store.readEvent(result.sequence)).event.request.body.raw,resultRaw);
   const current=await store.read();assert.equal(current.current.active_ga_id,'ga_evidence');assert.equal(current.attempts[0].receipt_raw,null);
  });
  assert.deepEqual((await admin.query('select * from public.legacy_sentinel')).rows,[{value:'unchanged'}]);
 }finally{await Promise.all(clients.map(c=>c.end().catch(()=>{})));await server.stop().catch(()=>{});}
});
