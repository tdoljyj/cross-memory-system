import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from '../../../apps/clued-cloud/tests/cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {createControlStore,projectRef,rootId} from './client.mjs';
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const EmbeddedPostgres=require('embedded-postgres').default;
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('two independent-review fixes: local synthetic PG only',{timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-control-review-'));
 const pg=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:crypto.randomBytes(32).toString('hex'),port:await port(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];
 try{
  await pg.initialise();await pg.start();const a=pg.getPgClient();clients.push(a);await a.connect();
  await a.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;set clued_control.target_project='uscrdifznmlvczcekqpw'");
  await a.query(await fs.readFile(new URL('install.candidate.sql',import.meta.url),'utf8'));
  await a.query(`insert into clued_control.accepted_binding values($1,$2,'SKILL_COEXISTENCE_QUALIFICATION','ISOLATED_TEST','e4ab25ecb1fa6709435d0318ad431d14343482cbe84e232f638e55c3c4ba1e1f','4d7f93c17cf7d126e771cf8aca6299c868cba0a9',clock_timestamp()-interval '1 second','2026-09-09T09:28:59Z','SYNTHETIC_NOT_ACCEPTED','SYNTHETIC_NOT_ACCEPTED','SYNTHETIC_NOT_ACCEPTED',$3,$3,$3,$3,$3)`,[rootId,projectRef,'a'.repeat(64)]);
  const stores=[];
  for(const zone of ['UTC','Asia/Shanghai']){const c=pg.getPgClient();clients.push(c);await c.connect();await c.query('set role service_role');await c.query("select set_config('TimeZone',$1,false)",[zone]);stores.push(createControlStore({project:projectRef,query:(...x)=>c.query(...x)}));}
  const base={root_set_id:rootId,idempotency_key:'synthetic-timezone',expected_sequence:0,kind:'GENERATION_REGISTERED',generation_id:'ctrgen_352785779b64458a889d571360e2d2d5',predecessor_generation_id:null,metadata_binding_sha256:(await stores[0].read()).metadata_binding_sha256,body:{synthetic_only:true}};
  await t.test('different session timezones yield identical digest and valid cross-connection replay',async()=>{
   assert.deepEqual(await stores[0].read(),await stores[1].read());
   const written=await stores[1].append(base);assert.equal(written.status,'APPENDED');
   const replay=await stores[0].append(base);assert.equal(replay.status,'DUPLICATE');assert.deepEqual(replay.request,written.request);
   assert.deepEqual(await stores[0].read(),await stores[1].read());
   for(const row of (await a.query("select proconfig from pg_proc p join pg_namespace n on p.pronamespace=n.oid where n.nspname='clued_control' and proname in ('read_root','append_event')")).rows)assert.deepEqual(row.proconfig,['search_path=""','TimeZone=UTC']);
  });
  await t.test('numeric JSON idempotency key rejects without changing event or head',async()=>{
   const before=await stores[0].read();
   await assert.rejects(stores[1].append({...base,idempotency_key:123456}),/invalid_scope_or_fields/);
   assert.deepEqual(await stores[0].read(),before);
   const stringKey={...base,idempotency_key:'123456',expected_sequence:1,generation_id:'ctrgen_'+'b'.repeat(32),predecessor_generation_id:base.generation_id};
   assert.equal((await stores[1].append(stringKey)).status,'APPENDED');
  });
 }finally{for(const c of clients.reverse())await c.end().catch(()=>{});await pg.stop().catch(()=>{});const resolved=path.resolve(dir);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('clued-control-review-'))throw Error('Unsafe cleanup');await fs.rm(resolved,{recursive:true,force:true});}
});
