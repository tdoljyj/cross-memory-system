import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from '../../../apps/clued-cloud/tests/cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createControlStore,projectRef,rootId} from './client.mjs';
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const EmbeddedPostgres=require('embedded-postgres').default;
const directory=path.dirname(fileURLToPath(import.meta.url));
const firstGeneration='ctrgen_352785779b64458a889d571360e2d2d5';
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('nonproduction control store candidate: real local PG only; no signed registration',{timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-control-store-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:crypto.randomBytes(32).toString('hex'),port:await port(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];
 try{
  await server.initialise();await server.start();const admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create table public.legacy_sentinel(id integer primary key,body text);insert into public.legacy_sentinel values(1,\'unchanged\');');
  const sql=await fs.readFile(path.join(directory,'install.candidate.sql'),'utf8');
  await t.test('missing or wrong deployment selector rejects before creating objects',async()=>{
   await assert.rejects(admin.query(sql),/wrong_or_missing_nonproduction_project_selector/);
   assert.equal((await admin.query("select to_regnamespace('clued_control') value")).rows[0].value,null);
  });
  await admin.query("set clued_control.target_project='uscrdifznmlvczcekqpw'");await admin.query(sql);
  const client=async role=>{const c=server.getPgClient();clients.push(c);await c.connect();await c.query('set role '+role);return c;};
  const writer=await client('service_role'),writer2=await client('service_role');
  const store=createControlStore({project:projectRef,query:(...a)=>writer.query(...a)});
  const store2=createControlStore({project:projectRef,query:(...a)=>writer2.query(...a)});
  const base={root_set_id:rootId,idempotency_key:'synthetic-first',expected_sequence:0,kind:'GENERATION_REGISTERED',generation_id:firstGeneration,predecessor_generation_id:null,metadata_binding_sha256:'0'.repeat(64),body:{synthetic_only:true}};
  await t.test('empty installation cannot register; public clients have no access or table writes',async()=>{
   assert.equal(await store.read(),null);
   await assert.rejects(store.append(base),/accepted_binding_missing/);
   for(const role of ['anon','authenticated']){const c=await client(role);await assert.rejects(c.query('select clued_control.read_root($1)',[rootId]),/permission denied/);}
   await assert.rejects(writer.query('insert into clued_control.current_head(root_id) values($1)',[rootId]),/permission denied/);
   await assert.rejects(writer.query('insert into clued_control.accepted_binding(root_id) values($1)',[rootId]),/permission denied/);
   assert.throws(()=>createControlStore({project:'ccxsikzwxlolxqlosril',query(){}}),/Wrong explicit/);
  });
  // Local admin injects explicitly synthetic acceptance metadata for SQL semantics ONLY.
  // No accepted record, signature, deployed root or authoritative schema is claimed.
  await admin.query(`insert into clued_control.accepted_binding values($1,$2,'SKILL_COEXISTENCE_QUALIFICATION','ISOLATED_TEST',
    'e4ab25ecb1fa6709435d0318ad431d14343482cbe84e232f638e55c3c4ba1e1f','4d7f93c17cf7d126e771cf8aca6299c868cba0a9',
    clock_timestamp()-interval '1 second',least(clock_timestamp()+interval '5 seconds','2026-09-09T09:28:59Z'),
    'SYNTHETIC_ISSUER_NOT_ACCEPTED','SYNTHETIC_AUDIENCE_NOT_ACCEPTED','SYNTHETIC_CONFIG_NOT_ACCEPTED',
    $3,$3,$3,$3,$3)`,[rootId,projectRef,'a'.repeat(64)]);
  base.metadata_binding_sha256=(await store.read()).metadata_binding_sha256;
  await t.test('same-key concurrent requests append once and replay the exact original event',async()=>{
   const results=await Promise.all([store.append(base),store2.append(base)]);
   assert.deepEqual(results.map(x=>x.status).sort(),['APPENDED','DUPLICATE']);
   assert.deepEqual(results[0].request,results[1].request);assert.equal(results[0].sequence,1);
   const state=await store.read();assert.equal(state.events.length,1);assert.equal(state.sequence,1);
   assert.deepEqual(await store.append(base),results.find(x=>x.status==='DUPLICATE'));
  });
  await t.test('all changed same-key fields conflict and preserve complete state',async()=>{
   const before=await store.read();
   for(const change of [{body:{changed:true}},{expected_sequence:1},{generation_id:'ctrgen_'+'b'.repeat(32)},
    {predecessor_generation_id:firstGeneration},{kind:'ROOT_REVOKED'}]){
    await assert.rejects(store.append({...base,...change}),/idempotency_conflict/);
    assert.deepEqual(await store.read(),before);
   }
   for(const change of [{metadata_binding_sha256:'b'.repeat(64)},{root_set_id:'ctr_'+'b'.repeat(32)},
    {expected_sequence:null},{expected_sequence:0.5},{expected_sequence:'0'},{extra:true}]){
    await assert.rejects(store.append({...base,...change}));assert.deepEqual(await store.read(),before);
   }
  });
  const next={...base,idempotency_key:'synthetic-second',expected_sequence:1,generation_id:'ctrgen_'+'b'.repeat(32),predecessor_generation_id:firstGeneration};
  await t.test('different-key concurrent generation transitions use one CAS winner',async()=>{
   const competing={...next,idempotency_key:'synthetic-competing',generation_id:'ctrgen_'+'c'.repeat(32)};
   const results=await Promise.allSettled([store.append(next),store2.append(competing)]);
   assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
   assert.match(results.find(x=>x.status==='rejected').reason.message,/sequence_conflict/);
   const state=await store.read();assert.equal(state.sequence,2);assert.equal(state.events.length,2);
   await assert.rejects(store.append({...next,idempotency_key:'rollback',expected_sequence:2,
    generation_id:firstGeneration,predecessor_generation_id:state.generation_id}),/generation_reuse_or_rollback/);
  });
  await t.test('immutable evidence cannot be updated deleted or truncated; binding cannot change',async()=>{
   const before=await store.read();
   for(const relation of ['events','accepted_binding']) for(const operation of ['delete from','truncate'])
    await assert.rejects(admin.query(operation+' clued_control.'+relation+(operation==='truncate'?' cascade':'')),/immutable_control_evidence/);
   await assert.rejects(admin.query("update clued_control.events set request='{}'"),/immutable_control_evidence/);
   await assert.rejects(admin.query("update clued_control.accepted_binding set audience='changed'"),/immutable_control_evidence/);
   assert.deepEqual(await store.read(),before);
  });
  await t.test('revocation is permanent and cannot be undone by a new generation or stale replay',async()=>{
   const before=await store.read();
   const revoke={...base,idempotency_key:'synthetic-revoke',expected_sequence:before.sequence,kind:'ROOT_REVOKED',generation_id:before.generation_id,predecessor_generation_id:null};
   await store.append(revoke);const after=await store.read();assert.equal(after.state,'REVOKED');assert.equal(after.events.length,3);
   await store.append(base);assert.deepEqual(await store.read(),after); // Historical query replay grants nothing.
   await assert.rejects(store.append({...next,idempotency_key:'restore-attempt',expected_sequence:3,predecessor_generation_id:before.generation_id}),/root_revoked/);
   assert.deepEqual(await store.read(),after);
  });
  await t.test('scope and deadline constraints, private security properties and existing table preserved',async()=>{
   assert.deepEqual((await admin.query('select * from public.legacy_sentinel')).rows,[{id:1,body:'unchanged'}]);
   const security=(await admin.query("select proname,prosecdef,proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_control' and proname in ('append_event','read_root') order by proname")).rows;
   assert.equal(security.length,2);for(const p of security){assert.equal(p.prosecdef,true);assert.deepEqual(p.proconfig,['search_path=""','TimeZone=UTC']);}
   assert.equal((await admin.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_control' and c.relkind='r' and c.relrowsecurity")).rows[0].n,3);
   // Direct bad configuration insert is constrained even for admin, within a rolled-back statement.
   await assert.rejects(admin.query("insert into clued_control.accepted_binding select 'other',project_ref,purpose,environment,subject_sha256,owner_approval_commit,not_before,expires_at,issuer,audience,algorithm_config,schema_sha256,registration_acceptance_sha256,store_acceptance_sha256,protocol_mapping_sha256,signature_evidence_sha256 from clued_control.accepted_binding"),/check constraint/);
  });
  await t.test('Owner expiry during a real row-lock wait rejects even an exact replay',async()=>{
   const before=await store.read();
   await admin.query('begin');await admin.query('select * from clued_control.current_head for update');
   const waiting=store.append(base).then(value=>({value}),error=>({error}));
   await admin.query("select pg_sleep(greatest(extract(epoch from expires_at-clock_timestamp()),0)::double precision+0.05) from clued_control.accepted_binding");
   await admin.query('commit');
   const result=await waiting;assert.match(result.error?.message??'',/owner_window_inactive/);
   const after=await store.read();assert.equal(after.state,'EXPIRED_OR_NOT_YET_VALID');
   assert.equal(after.sequence,before.sequence);assert.deepEqual(after.events,before.events);
   await assert.rejects(store.append(base),/owner_window_inactive/);
  });
 } finally{
  for(const c of clients.reverse())await c.end().catch(()=>{});await server.stop().catch(()=>{});
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-control-store-'))throw Error('Unsafe test cleanup');
  await fs.rm(target,{recursive:true,force:true});
 }
});
