import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {workerGatewayRpc} from './worker-gateway-caller-fixture.mjs';
import {integrateClockSourceCandidate} from '../../../scripts/ci/merge-admission-clock-source.mjs';
const {default:EmbeddedPostgres}=process.env.CLUED_TEST_EMBEDDED_POSTGRES_URL
  ?await import(process.env.CLUED_TEST_EMBEDDED_POSTGRES_URL):await import('embedded-postgres');
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.resolve(cloud,'../..');
const migration='20261011113259_merge_admission_measurement_clock_target_v1.sql';
const uuid=()=>crypto.randomUUID(),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('formal target clock: current full chain, complete atomic publisher install and source boundaries',{timeout:300000},async t=>{
  const base=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
  const names=(await fs.readdir(path.join(cloud,'supabase/migrations'))).filter(x=>x.endsWith('.sql')).sort();
  assert.equal(names.filter(x=>x===migration).length,1);
  const chain=await Promise.all(names.map(async name=>({name,text:await fs.readFile(path.join(cloud,'supabase/migrations',name),'utf8')})));
  const sql=await fs.readFile(path.join(cloud,'supabase/migrations',migration),'utf8');
  assert.match(sql,/^do \$measurement_clock\$ begin/m);assert.match(sql,/end \$measurement_clock\$;\n$/);
  assert.doesNotMatch(sql,/^begin;|^commit;/m);
  const publisher=await fs.readFile(path.join(repo,'.github/workflows/clued-cloud-production-release.yml'),'utf8');assert.match(publisher,/execute s;/);
  const parent=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'clued-clock-target-'));
  const server=new EmbeddedPostgres({databaseDir:directory,user:'postgres',password:crypto.randomBytes(32).toString('hex'),port:await port(),
    persistent:true,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(){}}),clients=[];
  let db;
  try{
    await server.initialise();await server.start();db=server.getPgClient();clients.push(db);await db.connect();
    await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;
      create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
      create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
      create temp table clock_migration_lines(n bigserial primary key,line text);`);
    for(const m of chain.filter(x=>x.name<migration)){try{await db.query(m.text);}catch(error){throw Error('Full preceding migration '+m.name+' failed',{cause:error});}}
    await allowRawTestBindings(db);
    const publicBefore=(await db.query("select oid::regprocedure::text signature,proacl::text acl from pg_proc where pronamespace='public'::regnamespace order by 1")).rows;
    const apply=async()=>{
      await db.query('truncate clock_migration_lines restart identity');
      await db.query('insert into clock_migration_lines(line) select unnest($1::text[])',[sql.split('\n').slice(0,-1)]);
      const md5=crypto.createHash('md5').update(sql).digest('hex');
      await db.query(`begin;do $apply$ declare s text:=(select string_agg(coalesce(line,''),e'\\n' order by n) from clock_migration_lines)||e'\\n';
        begin if md5(s)<>'${md5}' then raise exception 'publisher byte mismatch';end if;execute s;
        insert into supabase_migrations.schema_migrations(version,name,statements) values('20261011113259','merge_admission_measurement_clock_target_v1',array[s]);end $apply$;commit;`);
    };
    await t.test('unchanged publisher history failure rolls the entire new package back',async()=>{
      await db.query("alter table supabase_migrations.schema_migrations add constraint clock_history_failure check(version<>'20261011113259')");
      await assert.rejects(apply(),/clock_history_failure/);await db.query('rollback');
      for(const name of ['merge_clock_samples_candidate_v1','clock_source_epoch_candidate_v1','merge_measurement_clock_registration_v1'])
        assert.equal((await db.query('select to_regclass($1) v',['clued_private.'+name])).rows[0].v,null);
      assert.equal((await db.query("select count(*)::int n from pg_event_trigger where evtname like 'clock_source_%'")).rows[0].n,0);
      await db.query('alter table supabase_migrations.schema_migrations drop constraint clock_history_failure');
    });
    await t.test('complete new atomic source installs with exact publisher history, no public changes or accepted-pin bootstrap',async()=>{
      await apply();
      const row=(await db.query("select name,md5(array_to_string(statements,'')) md5 from supabase_migrations.schema_migrations where version='20261011113259'")).rows[0];
      assert.equal(row.name,'merge_admission_measurement_clock_target_v1');assert.equal(row.md5,crypto.createHash('md5').update(sql).digest('hex'));
      assert.deepEqual((await db.query("select oid::regprocedure::text signature,proacl::text acl from pg_proc where pronamespace='public'::regnamespace order by 1")).rows,publicBefore);
      const registration=(await db.query('select * from clued_private.merge_measurement_clock_registration_v1')).rows[0];
      assert.equal(registration.source_version,'20261011113259');assert.equal(registration.trusted_registry_accepted,false);assert.equal(registration.transport_connected,false);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])assert.equal((await db.query("select has_function_privilege($1,'clued_private.clock_source_page_candidate_v1(text,jsonb)','EXECUTE') v",[role])).rows[0].v,false);
    });
    // Replay any later current migration after the clock source, preserving
    // full-chain order rather than making this test a permanently frozen base.
    for(const m of chain.filter(x=>x.name>migration)){try{await db.query(m.text);}catch(error){throw Error('Full later migration '+m.name+' failed',{cause:error});}}
    const agent=async(r,name,input)=>{try{return await workerGatewayRpc(db,name,r.token,input);}finally{await db.query('reset role');await db.query("select set_config('request.jwt.claims','{}',false)");}};
    const make=async(contexts=['*'])=>{const r={user:uuid(),token:crypto.randomBytes(32).toString('hex')};
      await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[r.user,r.user+'@example.invalid']);
      r.binding=(await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'openai','clock-target DB fixture',$2,array['context:read','context:write','audit:read'],$3) returning id`,[r.user,r.token,contexts])).rows[0].id;
      await append(r,'bootstrap');return r;};
    const append=async(r,key,client=db,context='global')=>client.query("select clued_private.merge_measurement_append_v1($1,$2,'admission_receipt',$3,'{}')",[r.user,context,key]);
    const epoch=async(r,client=db)=>(await client.query("select clued_private.clock_source_epoch_candidate_v1($1,'merge:owner/repo:main') v",[r.user])).rows[0].v;
    const seal=async(r,e,client=db)=>(await client.query('select clued_private.clock_source_seal_candidate_v1($1,$2) v',[r.user,e.epoch_id])).rows[0].v;
    const page=async(r,z,input={})=>{await db.query("select set_config('request.jwt.claims','{\"role\":\"clued_worker_gateway\"}',false)");
      try{return (await db.query('select clued_private.clock_source_page_candidate_v1($1,$2) v',[r.token,{seal_id:z.seal_id,...input}])).rows[0].v;}
      finally{await db.query("select set_config('request.jwt.claims','{}',false)");}};
    const all=async(r,z)=>{const out=[];let after=0;for(let n=0;n<1000;n++){const p=await page(r,z,{limit:1,after_sequence:after});out.push(p);if(p.status!=='ok'||!p.has_more)return out;after=p.next_sequence;}throw Error('page cap');};
    const proof=pages=>integrateClockSourceCandidate(JSON.stringify(pages),JSON.stringify({expectedCatalogDigest:pages[0].epoch.catalog_digest,
      expectedFoundationDigest:pages[0].source_digest,queueRef:'merge:owner/repo:main'}));
    const issue=async(r,ref='merge:owner/repo:main')=>{const task=await agent(r,'clued_record_mutate',{operation:'create',record_type:'task',record_schema_version:1,lifecycle_status:'active',scope:'global',
      idempotency_key:uuid(),authority:'observed',confidence_reason:'DB fixture',source_refs:[],source_unavailable_reason:'synthetic',
      mutation:{title:'Clock-target fixture',content:'fixture',type_fields:{execution_bucket:'next'},relations:{}}});assert.equal(task.status,'committed');
      const result=await agent(r,'clued_work_claim_v1',{scope:'global',task_id:task.target_refs[0].id,write_set:['fixture/'+uuid()],trigger_refs:[ref],
        idempotency_key:uuid(),holder_label:'clock-target fixture',holder_session_ref:'fixture'});assert.equal(result.status,'committed');return result.claim;};
    const marker=async(r,client=db)=>client.query(`insert into clued_private.work_claim_merge_queue_v1(user_id,merge_ref,head_left_at,left_queued_at,left_claim_id)
      values($1,'merge:owner/repo:main',clock_timestamp(),'2000-01-01T00:00:00Z',$2) on conflict(user_id,merge_ref) do update set head_left_at=clock_timestamp()`,[r.user,r.user]);
    await t.test('real complete initial queue state and fixed target pages feed the formal pure reader',async()=>{
      const r=await make(),claim=await issue(r),e=await epoch(r),z=await seal(r,e),p=proof(await all(r,z));
      assert.ok(e.initial_events.some(x=>x.kind==='claim'&&x.payload.claim_id===claim.claim_id));assert.equal(p.value,1);
      assert.equal(p.source_authenticated,false);assert.equal(p.official_metric,false);assert.equal(p.t0,null);
    });
    await t.test('source append in the same transaction cannot be mistaken for committed opening/seal data',async()=>{
      const r=await make(),e=await epoch(r);
      for(const op of ['epoch','seal']){await db.query('begin');await append(r,'same-tx-source');
        try{await assert.rejects(op==='epoch'?epoch(r):seal(r,e),/clock_source_source_write_in_transaction/);}finally{await db.query('rollback');}}
      assert.equal((await seal(r,e)).candidate_ready,true);
    });
    await t.test('current C1 audit signature remains compatible and cannot publicly execute UUID clock cores',async()=>{
      const r=await make();await db.query('begin');
      try{const result=await agent(r,'clued_mcp_audit_receipts',{context_key:'global',measurement:{limit:1}});assert.equal(result.status,'ok');
        await db.query('set role clued_worker_gateway');await assert.rejects(db.query("select clued_private.clock_source_epoch_candidate_v1($1,'merge:owner/repo:main')",[r.user]),/permission denied/);
      }finally{await db.query('rollback');await db.query('reset role');}
    });
    await t.test('unrelated hidden context needs no broad scope; a hidden same-queue member remains unknown',async()=>{
      const r=await make(['global']);await append(r,'unrelated',db,'project:'+uuid());let e=await epoch(r),z=await seal(r,e),p=await page(r,z);assert.equal(p.status,'ok');
      const c=await issue(r);await db.query('update clued_private.work_claims_v1 set context_key=$2 where claim_id=$1',[c.claim_id,'project:'+uuid()]);
      e=await epoch(r);z=await seal(r,e);p=await page(r,z);assert.equal(p.status,'NOT_MEASURED');assert.deepEqual(p.events,[]);
    });
    const rawSignature='clued_private.merge_clock_raw_sample_candidate_v1()',rawOriginal=(await db.query('select pg_get_functiondef($1::regprocedure) v',[rawSignature])).rows[0].v;
    const provider=`create or replace function ${rawSignature} returns timestamptz language sql volatile set search_path='' as $$select case
      when coalesce(current_setting('clock_target_fixture.raw_us',true),'')='' then clock_timestamp()
      else 'epoch'::timestamptz+current_setting('clock_target_fixture.raw_us')::bigint*interval '1 microsecond' end $$`;
    const setRaw=(us,client=db)=>client.query("select set_config('clock_target_fixture.raw_us',$1,false)",[us===null?'':String(us)]);
    await t.test('full upstream rollback/gap cannot disappear through target filtering',async()=>{
      await db.query(provider);await setRaw(2000000000000000n);const r=await make(['global']),e=await epoch(r),baseTime=BigInt(e.opening_us);
      try{await db.query('begin');await setRaw(baseTime+100n);await marker(r);await setRaw(baseTime+50n);await append(r,'hidden-clock',db,'project:'+uuid());await db.query('commit');
        await setRaw(baseTime+130n);const z=await seal(r,e);assert.equal(z.ddl_tainted,false);assert.equal(z.raw_clock_regression_observed,true);assert.equal(z.candidate_ready,false);
      }finally{await db.query('rollback');await setRaw(null);await db.query(rawOriginal);}
    });
    await t.test('same-epoch concurrent sampling serializes uncommitted witness and keeps recovered rollback rejected',async()=>{
      await db.query(provider);await setRaw(2100000000000000n);const r=await make(),e=await epoch(r),baseTime=BigInt(e.opening_us);
      const a=server.getPgClient(),b=server.getPgClient();clients.push(a,b);await a.connect();await b.connect();let pending;
      try{await a.query('begin');await setRaw(baseTime+150n,a);assert.equal((await seal(r,e,a)).candidate_ready,true);await setRaw(baseTime+140n,b);
        pending=seal(r,e,b);pending.catch(()=>{});let parked=false;for(let n=0;n<100;n++){if((await db.query('select wait_event_type from pg_stat_activity where pid=$1',[b.processID])).rows[0]?.wait_event_type==='Lock'){parked=true;break;}await db.query('select pg_sleep(0.01)');}
        assert.equal(parked,true);await a.query('commit');assert.equal((await pending).candidate_ready,false);await setRaw(baseTime+200n);assert.equal((await seal(r,e)).candidate_ready,false);
      }finally{await a.query('rollback');if(pending)await pending.catch(()=>{});await setRaw(null);await db.query(rawOriginal);}
    });
    await t.test('typed source trigger replacement/restoration stays tainted; failed DDL rolls back',async()=>{
      await db.query('create function public.clock_target_noop() returns trigger language plpgsql as $$begin return new;end $$');
      const original=(await db.query("select pg_get_triggerdef(oid) v from pg_trigger where tgrelid='clued_private.work_claims_v1'::regclass and tgname='merge_measurement_claims_v1_capture'")).rows[0].v;
      const r=await make(),c=await issue(r),e=await epoch(r);
      await db.query('begin');await db.query('alter table clued_private.work_claims_v1 disable trigger merge_measurement_claims_v1_capture');await db.query('rollback');assert.equal((await seal(r,e)).candidate_ready,true);
      try{await db.query('create or replace trigger merge_measurement_claims_v1_capture after insert or update or delete on clued_private.work_claims_v1 for each row execute function public.clock_target_noop()');
        await db.query("update clued_private.work_claims_v1 set expires_at=expires_at+interval '1 second' where claim_id=$1",[c.claim_id]);}
      finally{await db.query(original.replace(/^CREATE TRIGGER/,'CREATE OR REPLACE TRIGGER'));}
      const z=await seal(r,e);assert.equal(z.catalog_digest,e.catalog_digest);assert.equal(z.ddl_tainted,true);assert.equal(z.candidate_ready,false);
    });
    await t.test('fixed snapshots refuse without rewriting isolation; ordinary blocking has a bounded runtime timeout',async()=>{
      const r=await make(),e=await epoch(r),a=server.getPgClient(),b=server.getPgClient();clients.push(a,b);await a.connect();await b.connect();
      await b.query('begin isolation level repeatable read');try{await assert.rejects(epoch(r,b),/clock_source_snapshot_isolation_unsupported/);}finally{await b.query('rollback');}
      await a.query('begin');await append(r,'held',a);try{await assert.rejects(epoch(r,b),x=>x.code==='55P03');}finally{await a.query('rollback');}
      assert.equal((await seal(r,e)).candidate_ready,true);
    });
    console.log(JSON.stringify({base,current_migrations:chain.length,preceding_migrations:chain.filter(x=>x.name<migration).length,
      current_chain_sha256:hash(JSON.stringify(chain.map(x=>({name:x.name,sha256:hash(x.text)})))),
      sql_sha256:hash(sql),node:process.versions.node,pg:(await db.query("select current_setting('server_version') v")).rows[0].v,
      full_new_atomic_install:true,source_authenticated:false,official_metric:false,t0:null,production:false}));
  }finally{for(const c of clients)await c.end().catch(()=>{});await stopCluster(server);const actual=await fs.realpath(directory);assert.equal(actual,directory);
    assert.equal(path.dirname(actual),parent);assert.ok(path.basename(actual).startsWith('clued-clock-target-'));await removeTestDirectory(actual);}
});
