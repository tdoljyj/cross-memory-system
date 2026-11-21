import { EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const standalone=!!process.env.D01D02_SOURCE_REPO;
const repo=process.env.D01D02_SOURCE_REPO;
const cloud=standalone?path.join(repo,'apps/clued-cloud'):path.resolve(here,'..');
const id=()=>randomUUID(),sha=v=>createHash('sha256').update(v).digest('hex');
const ref=process.env.D01D02_SOURCE_REF;
const candidate='20261117050000_storage_runtime_authority_v1.sql';
const migration=await fs.readFile(standalone?path.join(here,candidate):path.join(cloud,'supabase/migrations',candidate),'utf8');
const helper=migration.split('-- Apply the exact registered profile;')[0];
const sig='clued_private.storage_runtime_authority_repair_v1(uuid,uuid,text,uuid,bigint,text)';
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}

test('runtime reference repair preserves frozen layout and creates independently verifiable qualification',{timeout:300000},async t=>{
 const temp=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'clued-runtime-authority-'));
 const server=new EmbeddedPostgres({databaseDir:temp,user:'postgres',password:sha(id()),port:await port(),persistent:true,
  initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'],onLog(){},onError(){}});
 let started=false;const clients=[];
 try{
  await server.initialise();await server.start();started=true;
  const db=server.getPgClient();clients.push(db);await db.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema auth,extensions to anon,authenticated,service_role;
   grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
  const names=standalone?execFileSync('git',['ls-tree','-r','--name-only',ref,'apps/clued-cloud/supabase/migrations'],{cwd:repo,encoding:'utf8'}).trim().split(/\r?\n/).filter(x=>x.endsWith('.sql')).sort()
   :(await fs.readdir(path.join(cloud,'supabase/migrations'))).filter(x=>x.endsWith('.sql')).sort();
  for(const name of names){
   const sql=standalone?execFileSync('git',['show',ref+':'+name],{cwd:repo,encoding:'utf8',maxBuffer:8*1024*1024})
    :await fs.readFile(path.join(cloud,'supabase/migrations',name),'utf8');
   try{await db.query(sql);}catch(e){throw new Error('Migration '+name+': '+e.message,{cause:e});}
  }
  if(standalone)await db.query(migration);
  assert.equal((await db.query('select to_regprocedure($1) v',[sig])).rows[0].v,null,'no repair API remains installed');
  await db.query(helper);
  const owner=id(),other=id(),project=id(),profileDecision=id(),old=id(),successor=id();
  await db.query("insert into auth.users(id,email) values($1,'runtime-owner@synthetic.invalid'),($2,'other@synthetic.invalid')",[owner,other]);
  await db.query('begin');
  await db.query('select clued_private.authorization_writer_guard_v2($1)',[owner]);
  await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Runtime fixture','runtime fixture',$3,'confirmed',now())",[project,owner,'project:'+project]);
  await db.query('commit');
  for(const decision of [profileDecision,old,successor])await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,
   canonical_scope,type_fields,relations,source_refs,authority,confidence_reason,content_hash) values($1,$2,'Explicit synthetic Decision','Fixture authority only','project',$3,'decision','active',1,'active',$4,
   '{"rationale":"Synthetic qualification"}','{}','{}','user_explicit','Owner confirmed',$5)`,[decision,owner,project,'project:'+project,sha('synthetic-decision')]);
  const register=async input=>(await db.query('select public.clued_resource_center_admin_v1($1,$2::jsonb) v',[owner,JSON.stringify({source_decision_id:profileDecision,idempotency_key:id(),...input})])).rows[0].v;
  const registered=await register({action:'profile_register',project_id:project,profile_version:'runtime-fixture/1',managed_root:'/synthetic/资料中心',root_folder_id:'synthetic-root',root_parent_id:'synthetic-parent',root_folder_version:'1'});
  assert.equal(registered.status,'committed');
  const profile=registered.target_refs.find(x=>x.role==='primary').id;
  await register({action:'artifact_register',profile_id:profile,path:'/synthetic/资料中心/工程',provider_file_id:'synthetic-track',provider_file_version:'1',target_kind:'directory',governance_class:'ordinary',delete_authority:false});
  const qualification=(await db.query('select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) v',[owner,JSON.stringify({profile_id:profile,base_version:1,source_decision_id:old,allowed_root_children:['工程'],idempotency_key:id()})])).rows[0].v;
  assert.equal(qualification.status,'committed');
  await db.query("update public.clued_memories set lifecycle_status='superseded',version=version+1 where id=$1",[old]);
  await db.query("update public.clued_memories set relations=jsonb_build_object('supersedes',jsonb_build_array($2::text)) where id=$1",[successor,old]);
  const before=(await db.query('select to_jsonb(p) profile,clued_private.m1_sha256(cloud_runtime) digest from clued_private.resource_center_profiles_v1 p where id=$1',[profile])).rows[0];
  const oldReceipt=(await db.query('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[qualification.receipt_id])).rows[0].v;
  const repair=async({actor=db,user=owner,target=profile,digest=before.digest,decision=successor,version=1,key=id()}={})=>
   (await actor.query('select clued_private.storage_runtime_authority_repair_v1($1,$2,$3,$4,$5,$6) v',[user,target,digest,decision,version,key])).rows[0].v;
  const rollback=async fn=>{await db.query('begin');try{await fn();}finally{await db.query('rollback');}};
  const denied=e=>e.code==='42501'&&e.message==='storage_runtime_authority_denied';
  await t.test('ordinary callers cannot invoke the temporary deployment operation',async()=>{
   for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
    assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') v',[role,sig])).rows[0].v,false);
    const client=server.getPgClient();clients.push(client);await client.connect();await client.query('set role '+role);
    await assert.rejects(repair({actor:client}),e=>e.code==='42501');
   }
  });
  await t.test('different Owner, stale preimage, and stale successor version fail closed',async()=>{
   await assert.rejects(repair({user:other}),denied);
   await assert.rejects(repair({digest:'0'.repeat(64)}),e=>e.code==='40001'&&e.message==='storage_runtime_authority_conflict');
   await assert.rejects(repair({version:2}),denied);
  });
  await t.test('revoked old authority cannot be restored by the repair',()=>rollback(async()=>{
   await db.query("update public.clued_memories set lifecycle_status='archived' where id=$1",[old]);
   await assert.rejects(repair(),denied);
  }));
  await t.test('unknown old Decision authority or lifecycle is rejected',async()=>{
   for(const column of ['authority','lifecycle_status'])await rollback(async()=>{
    await db.query(`update public.clued_memories set ${column}=null where id=$1`,[old]);
    await assert.rejects(repair(),denied);
   });
  });
  await t.test('unrelated or revoked successor does not qualify',async()=>{
   await rollback(async()=>{await db.query("update public.clued_memories set relations='{}' where id=$1",[successor]);await assert.rejects(repair(),denied);});
   await rollback(async()=>{await db.query("update public.clued_memories set lifecycle_status='archived' where id=$1",[successor]);await assert.rejects(repair(),denied);});
  });
  await t.test('profile version/layout drift and revoked registered directory remain unavailable',async()=>{
   await rollback(async()=>{await db.query('update clued_private.resource_center_profiles_v1 set version=version+1 where id=$1',[profile]);await assert.rejects(repair(),denied);});
   await rollback(async()=>{await db.query("update clued_private.resource_center_artifacts_v1 set state='revoked' where profile_id=$1 and path like '%/工程'",[profile]);await assert.rejects(repair(),denied);});
  });
  await t.test('a fabricated qualification receipt or runtime digest is rejected',()=>rollback(async()=>{
   await db.query("update clued_private.resource_center_profiles_v1 set cloud_runtime=jsonb_set(cloud_runtime,'{receipt_id}',to_jsonb($2::text)) where id=$1",[profile,registered.receipt_id]);
   const digest=(await db.query('select clued_private.m1_sha256(cloud_runtime) v from clued_private.resource_center_profiles_v1 where id=$1',[profile])).rows[0].v;
   await assert.rejects(repair({digest}),denied);
  }));
  // Only immutable production selectors are rebound to this synthetic fixture.
  // Execute the original entire migration, including its DO guard and DROP,
  // through the same nested dynamic EXECUTE used by the production workflow.
  const mappedMigration=migration
   .replaceAll('b5267eb8-7dda-408b-81ce-06112a18221a',profile)
   .replaceAll('2ddd1804-b1e5-4916-89fb-3b87fae11ee6',owner)
   .replaceAll('40eaae1b-8fd5-41e6-9806-c88ce6e9d7f2',successor)
   .replaceAll('53f48ae5b99cf04ec6133d7c09406463d584eed57f23670987d61ba1a264073a',before.digest)
   .replaceAll('1aa9d1f493c46192b128d001aa562a6b58783b27e4a8819f68cb28c550871ad3',sha('synthetic-decision'));
  const applyWhole=async sql=>{
   await db.query('drop function '+sig);
   await db.query('do $workflow$ begin execute $migration$'+sql+'$migration$; end $workflow$;');
  };
  await t.test('whole migration repairs the exact mapped subject and removes its temporary helper',()=>rollback(async()=>{
   await applyWhole(mappedMigration);
   assert.equal((await db.query('select to_regprocedure($1) v',[sig])).rows[0].v,null);
   const after=(await db.query('select to_jsonb(p) v from clued_private.resource_center_profiles_v1 p where id=$1',[profile])).rows[0].v;
   assert.equal(after.cloud_runtime.source_decision_id,successor);
   const expected=structuredClone(before.profile);expected.cloud_runtime={...expected.cloud_runtime,source_decision_id:successor,decision_version:1,receipt_id:after.cloud_runtime.receipt_id};
   assert.deepEqual(after,expected);
  }));
  await t.test('whole migration fails on successor content drift and exact preimage drift',async()=>{
   await rollback(async()=>{
    const sql=mappedMigration.replace(sha('synthetic-decision'),'0'.repeat(64));
    await assert.rejects(applyWhole(sql),e=>e.code==='40001'&&e.message==='storage_runtime_authority_successor_changed');
   });
   await rollback(async()=>{
    const sql=mappedMigration.replace(before.digest,'0'.repeat(64));
    await assert.rejects(applyWhole(sql),e=>e.code==='40001'&&e.message==='storage_runtime_authority_conflict');
   });
  });
  await t.test('successful repair changes only reference/version/receipt and preserves the previous proof',async()=>{
   const result=await repair();assert.equal(result.status,'committed');assert.notEqual(result.receipt_id,qualification.receipt_id);
   const after=(await db.query('select to_jsonb(p) v from clued_private.resource_center_profiles_v1 p where id=$1',[profile])).rows[0].v;
   const expected=structuredClone(before.profile);expected.cloud_runtime={...expected.cloud_runtime,source_decision_id:successor,decision_version:1,receipt_id:result.receipt_id};
   assert.deepEqual(after,expected);
   assert.deepEqual((await db.query('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[qualification.receipt_id])).rows[0].v,oldReceipt);
   const proof=(await db.query(`select exists(select 1 from public.clued_audit_receipts r join public.clued_context_events e on e.receipt_id=r.id and e.user_id=r.user_id
    where r.id=$1 and r.user_id=$2 and r.status='committed' and r.operation='storage_cloud_qualify'
    and r.response_hash=clued_private.m1_sha256(r.canonical_result) and e.canonical_event_type='extension:storage:cloud_qualified'
    and e.result='success' and e.change_summary->>'profile_id'=$3 and e.change_summary->>'previous_receipt_id'=$4
    and e.change_summary->>'runtime_digest'=clued_private.m1_sha256($5::jsonb-'receipt_id')) v`,[result.receipt_id,owner,profile,qualification.receipt_id,JSON.stringify(after.cloud_runtime)])).rows[0].v;
   assert.equal(proof,true);
   await assert.rejects(repair(),e=>e.code==='40001');
   assert.equal((await db.query('select lifecycle_status from public.clued_memories where id=$1',[old])).rows[0].lifecycle_status,'superseded');
  });
 }finally{
  for(const client of clients)await client.end().catch(()=>{});
  if(started)await server.stop();
  const resolved=await fs.realpath(temp);const parent=await fs.realpath(os.tmpdir());
  assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('clued-runtime-authority-'));
  await fs.rm(resolved,{recursive:true,force:true});
 }
});
