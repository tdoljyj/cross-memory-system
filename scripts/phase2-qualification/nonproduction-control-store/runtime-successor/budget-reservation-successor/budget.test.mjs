import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from '../../../../../apps/clued-cloud/tests/cluster-cleanup.mjs';
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
import {createBudgetStore as createExecutionStore,projectRef,rootId} from './client.mjs';
const require=createRequire(new URL('../../../../../apps/clued-cloud/package.json',import.meta.url));
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
  const oldSql=await fs.readFile(path.join(directory,'../../install.candidate.sql'),'utf8');
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
  await admin.query("insert into clued_control.execution_binding values($1,$2,$2,$2,$2,'G-PREENTRY-SKILL-QUALIFICATION','SYNTHETIC_DEFINITION_NOT_ACCEPTED',$2,$2,1410,19264968)",[rootId,h]);
  await admin.query("insert into clued_control.execution_current values($1,'runner-initial','credential-initial','session-initial',0,null,null,1410,19264968)",[rootId]);
  const makeGa=key=>{const now=Date.now();return {gate_authorization_id:'ga_'+key,idempotency_key:key,authorization_status:'AUTHORIZED',purpose:'SKILL_COEXISTENCE_QUALIFICATION',environment:'ISOLATED_TEST',
   profile_digest:h,controller_digest:h,scope_digest:h,gate_id:'G-PREENTRY-SKILL-QUALIFICATION',controller_qualification_ref:{sha256:h},control_trust_root_generation:gen,
   runner_generation:'runner-initial',credential_generation:'credential-initial',session_generation:'session-initial',
   issued_at:new Date(now-1000).toISOString(),deadline:new Date(now+60000).toISOString(),expires_at:new Date(now+60000).toISOString()};};


  const sm={object_type:'StatusManifest',schema_version:'1.0',schema_digest:'6ba12ed51b3fc0e457c13e83f47e1ad1aa6cc680d8f28c668f8c65d12742ecc2',
   status_manifest_id:'sm_budget',issuer_purpose:'STATUS',audience:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',
   control_trust_root_generation:gen,generation:1,as_of:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+300000).toISOString(),signature_binding:{synthetic_only:true}};
  const smRaw=JSON.stringify(sm)+'\n';await store.appendStatus(smRaw);
  const allocation=key=>({controller_digest:h,credential_generation:'credential-initial',environment:'ISOLATED_TEST',evidence_bytes:134217728,
   expires_at:new Date(Date.now()+300000).toISOString(),idempotency_key:key,not_before:new Date(Date.now()-1000).toISOString(),profile_digest:h,
   purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:gen,runner_generation:'runner-initial',scope_digest:h,seconds:180,session_generation:'session-initial'});
  const gaFor=(key,ref)=>({...makeGa(key),issued_at:new Date(Date.now()-100).toISOString(),
   status_manifest_ref:{uri:'control://status-manifests/sm_budget',sha256:sha(smRaw)},budget_reservation_ref:ref});
  await t.test('budget must be committed before GA consume; rollback preserves counters',async()=>{
   await writer.query('begin');const reservation=await store.reserveBudget(JSON.stringify(allocation('same_tx'))+'\n');
   await assert.rejects(store.reserveExactGa(JSON.stringify(gaFor('same_tx',reservation.budget_reservation_ref))),/exact_prior_committed_budget_required/);
   await writer.query('rollback');const current=(await store.read()).current;
   assert.equal(current.pending_budget_sequence,null);assert.equal(current.charged_seconds,1410);
  });
  let selected,ref,seq;
  await t.test('concurrent distinct allocations reserve one slot and charge only once',async()=>{
   const raws=['concurrent_a','concurrent_b'].map(key=>JSON.stringify(allocation(key))+'\n');
   const outcomes=await Promise.allSettled([store.reserveBudget(raws[0]),store2.reserveBudget(raws[1])]);
   assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
   const index=outcomes.findIndex(x=>x.status==='fulfilled');selected=raws[index];ref=outcomes[index].value.budget_reservation_ref;seq=outcomes[index].value.sequence;
   const current=(await store.read()).current;assert.equal(current.pending_budget_sequence,seq);
   assert.equal(current.charged_seconds,1590);assert.equal(current.charged_evidence_bytes,19264968+134217728);
   assert.equal((await store.readEvent(seq)).event.request.body.raw,selected);
   assert.equal(ref.uri,'urn:clued:control-evidence:uscrdifznmlvczcekqpw:execution-events:'+seq);
  });
  await t.test('same key changed raw conflicts; original duplicate never recharges',async()=>{
   assert.equal((await store2.reserveBudget(selected)).status,'DUPLICATE');
   const changed={...JSON.parse(selected),expires_at:new Date(Date.now()+280000).toISOString()};
   await assert.rejects(store.reserveBudget(JSON.stringify(changed)+'\n'),/budget_idempotency_conflict/);
   assert.equal((await store.read()).current.charged_seconds,1590);
  });
  await t.test('wrong reference/window cannot consume; one exact GA consumes without second charge',async()=>{
   const expired=gaFor('expired',ref);expired.issued_at=new Date(Date.now()-1000).toISOString();expired.deadline=new Date(Date.now()-1).toISOString();expired.expires_at=expired.deadline;
   await assert.rejects(store.reserveExactGa(JSON.stringify(expired)),/ga_window_invalid/);
   assert.equal((await store.read()).current.pending_budget_sequence,seq);assert.equal((await store.read()).current.charged_seconds,1590);
   await assert.rejects(store.reserveExactGa(JSON.stringify(gaFor('bad_ref',{...ref,sha256:'b'.repeat(64)}))),/exact_prior_committed_budget_required/);
   const wide=gaFor('wide',ref);wide.issued_at=new Date(Date.parse(JSON.parse(selected).not_before)-1).toISOString();
   await assert.rejects(store.reserveExactGa(JSON.stringify(wide)),/budget_consumption_binding_or_window_mismatch/);
   const raw=JSON.stringify(gaFor('consumer',ref));await store.reserveExactGa(raw);
   assert.equal((await store.reserveExactGa(raw)).status,'DUPLICATE');
   await assert.rejects(store.reserveExactGa(JSON.stringify(gaFor('second_consumer',ref))),/actual_pending_budget_required/);
   const state=await store.read();assert.equal(state.current.pending_budget_sequence,null);assert.equal(state.current.charged_seconds,1590);
   assert.equal(state.attempts[0].budget_sequence,seq);
   await assert.rejects(admin.query('update clued_control.gate_attempts set budget_sequence=budget_sequence+1'),/immutable_gate_bytes/);
  });
  await t.test('UNKNOWN never refunds the allocation or clears active capacity',async()=>{
   // A synthetic state transition, not an actual process observation.
   const state=await store.read();await store.transition({ga_id:'ga_consumer',idempotency_key:'unknown_budget',operation:'UNKNOWN',body:{},expected_sequence:state.current.sequence});
   await assert.rejects(store.reserveBudget(JSON.stringify(allocation('after_unknown'))+'\n'),/budget_or_pending_capacity_unavailable/);
   const current=(await store.read()).current;assert.equal(current.charged_seconds,1590);assert.equal(current.active_ga_id,'ga_consumer');
  });
  assert.deepEqual((await admin.query('select * from public.legacy_sentinel')).rows,[{value:'unchanged'}]);
 }finally{await Promise.all(clients.map(c=>c.end().catch(()=>{})));await server.stop().catch(()=>{});}
});
