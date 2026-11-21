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
import {createControlObjectStore as createExecutionStore,projectRef,rootId} from './client.mjs';
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
  await admin.query("insert into clued_control.execution_current values($1,'runner-initial','credential-initial','session-initial',0,null,1410,19264968)",[rootId]);
  const makeGa=key=>{const now=Date.now();return {gate_authorization_id:'ga_'+key,idempotency_key:key,authorization_status:'AUTHORIZED',purpose:'SKILL_COEXISTENCE_QUALIFICATION',environment:'ISOLATED_TEST',
   profile_digest:h,controller_digest:h,scope_digest:h,gate_id:'G-PREENTRY-SKILL-QUALIFICATION',controller_qualification_ref:{sha256:h},control_trust_root_generation:gen,
   runner_generation:'runner-initial',credential_generation:'credential-initial',session_generation:'session-initial',
   issued_at:new Date(now-1000).toISOString(),deadline:new Date(now+60000).toISOString(),expires_at:new Date(now+60000).toISOString()};};

  const status=id=>({object_type:'StatusManifest',schema_version:'1.0',
   schema_digest:'6ba12ed51b3fc0e457c13e83f47e1ad1aa6cc680d8f28c668f8c65d12742ecc2',status_manifest_id:'sm_'+id,
   issuer_purpose:'STATUS',audience:'urn:clued:audience:skill-coexistence-qualification:uscrdifznmlvczcekqpw',
   control_trust_root_generation:gen,generation:1,as_of:new Date(Date.now()-1000).toISOString(),
   expires_at:new Date(Date.now()+120000).toISOString(),signature_binding:{synthetic_only:true}});
  const sm=status('fixed'),smRaw=JSON.stringify(sm)+'\n',smURI='control://status-manifests/'+sm.status_manifest_id;
  await t.test('Status exact bytes are globally unique, immutable and private',async()=>{
   assert.equal((await store.appendStatus(smRaw)).status,'STORED_NO_AUTHORITY');
   assert.equal((await store2.appendStatus(smRaw)).status,'DUPLICATE');
   await assert.rejects(store.appendStatus(JSON.stringify({...sm,as_of:new Date(Date.now()-2000).toISOString()})+'\n'),/immutable_status_identity_conflict/);
   await assert.rejects(store.appendStatus(JSON.stringify({...sm,status_manifest_id:'sm_second'})+'\n'),/duplicate key/);
   await assert.rejects(store.appendStatus(JSON.stringify({...sm,status_manifest_id:'sm_wrong',issuer_purpose:'GATE_RESULT'})+'\n'),/status_scope_or_encoding_mismatch/);
   await assert.rejects(writer.query('select * from clued_control.control_objects'),/permission denied/);
   await assert.rejects(admin.query("update clued_control.control_objects set raw=raw"),/immutable/);
   assert.equal((await admin.query('select count(*)::int n from clued_control.control_objects')).rows[0].n,1);
  });
  const ga=makeGa('status'),raw=JSON.stringify({...ga,status_manifest_ref:{uri:smURI,sha256:sha(smRaw)}});
  await t.test('reserve requires actual stored Status and reads only the active exact object',async()=>{
   await assert.rejects(store.reserveExactGa(JSON.stringify(ga)),/exact_stored_status_required/);
   await store.reserveExactGa(raw);
   await store.appendStatus(JSON.stringify({...sm,status_manifest_id:'sm_unrelated',generation:2})+'\n');
   const current=await store.read();
   assert.deepEqual(current.control_objects,[{object_type:'StatusManifest',uri:smURI,raw:smRaw,sha256:sha(smRaw)}]);
   await writer.query("set timezone='Asia/Shanghai'");const otherZone=await store.read();
   await writer.query("set timezone='UTC'");assert.deepEqual(otherZone,await store.read());
  });
  // This isolated fixture positions an already-stopped attempt solely to test
  // new evidence storage; it is not evidence of a real Docker STOP or GA.
  await admin.query("update clued_control.gate_attempts set phase='STOPPED',container_id=$1 where ga_id='ga_status'",[container]);
  const dRaw=JSON.stringify({ga_id:'ga_status',ga_sha256:sha(raw),result:'BLOCKED',synthetic_fixture:true})+'\n';
  const eRaw=JSON.stringify({ga_id:'ga_status',ga_sha256:sha(raw),events:[],synthetic_fixture:true})+'\n';
  let n=0;
  const transition=async body=>{const current=await store.read();return store.transition({ga_id:'ga_status',operation:'DECISION_RESERVED',idempotency_key:'decision_'+(++n),expected_sequence:current.current.sequence,body});};
  const body={result:'BLOCKED',decision_raw:dRaw,decision_sha256:sha(dRaw),evidence_index_raw:eRaw,evidence_index_sha256:sha(eRaw)};
  await t.test('decision and index require full hash-matching bytes bound to this exact GA',async()=>{
   await assert.rejects(transition({...body,decision_raw:undefined}),/complete_reserved_evidence_bytes_required/);
   await assert.rejects(transition({...body,evidence_index_sha256:'b'.repeat(64)}),/complete_reserved_evidence_bytes_required/);
   const foreign=JSON.stringify({ga_id:'ga_other',ga_sha256:sha(raw)});
   await assert.rejects(transition({...body,evidence_index_raw:foreign,evidence_index_sha256:sha(foreign)}),/reserved_evidence_ga_mismatch/);
   assert.equal((await store.read()).attempts[0].phase,'STOPPED');
   const recorded=await transition(body);
   const current=await store.read();
   assert.deepEqual(current.attempts[0].decision,body);
   assert.equal((await store.readEvent(recorded.sequence)).event.request.body.decision_raw,dRaw);
   assert.deepEqual(recorded.current_context.control_objects,current.control_objects);
   assert.equal(recorded.current_context.attempts[0].phase,'DECISION_RESERVED');
   assert.equal(recorded.current_context.current.sequence,recorded.sequence);
   await assert.rejects(transition(body),/decision_reservation_conflict/);
   assert.equal(current.current.active_ga_id,'ga_status');assert.equal(current.attempts[0].receipt_raw,null);
  });
  assert.deepEqual((await admin.query('select * from public.legacy_sentinel')).rows,[{value:'unchanged'}]);
 }finally{await Promise.all(clients.map(c=>c.end().catch(()=>{})));await server.stop().catch(()=>{});}
});
