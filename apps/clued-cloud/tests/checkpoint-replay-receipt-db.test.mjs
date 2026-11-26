import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';

// raw-binding-grants: applies only migrations before 20261009050000, where raw Bindings still pass.

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration='20260908102500_clued_checkpoint_replay_receipt.sql';
const uuid=()=>crypto.randomUUID(),hash=()=>crypto.randomBytes(32).toString('hex');

test('checkpoint replay returns its unique original Receipt without changing stored history',{timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-checkpoint-receipt-'));
 const server=newCluster({databaseDir:dir,user:'postgres',password:hash(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];let admin;
 try {
  await startCluster(server);admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
  const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&(n<'20260826000000'||n.startsWith('20260907123955_')||n.startsWith('20260907131834_')||n.startsWith('20260907172309_')||n.startsWith('2026090717303')||n.startsWith('20260908073933_')||n==='20260908094000_clued_checkpoint_idempotency_binding.sql')).sort();
  for(const name of names)await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
  const db=server.getPgClient();clients.push(db);await db.connect();await db.query('set role anon');
  const U=uuid(),h=hash();await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'receipt-owner@example.invalid',now())",[U]);
  const binding=(await admin.query("insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic','receipt-test',$2,array['context:read','context:write'],array['global','profile']) returning id",[U,h])).rows[0].id;
  const rpc=async(name,input)=>(await db.query('select public.'+name+'($1,$2) value',[h,input])).rows[0].value;
  const resume=(context='global')=>rpc('clued_mcp_restore',{context_key:context});
  const commit=input=>rpc('clued_mcp_commit_checkpoint',input);
  const state=async()=>(await admin.query("select jsonb_build_object('checkpoints',(select count(*) from public.clued_context_checkpoints),'checkpoint_receipts',(select count(*) from public.clued_audit_receipts where operation='checkpoint'),'streams',(select jsonb_agg(to_jsonb(s) order by s.user_id,s.context_key) from public.clued_context_streams s),'heads',(select jsonb_agg(to_jsonb(h) order by h.user_id,h.context_key) from public.clued_context_heads h)) value")).rows[0].value;
  const functionSecurity=async()=>(await admin.query("select proacl::text,prosecdef,proconfig from pg_proc where oid='public.clued_mcp_commit_checkpoint(text,jsonb)'::regprocedure")).rows[0];
  const session=await resume();
  const original={context_key:'global',base_version:session.version,snapshot:{synthetic:'receipt'},summary:'synthetic summary',next_action:'synthetic next',idempotency_key:uuid(),session_token:session.session_token};
  const first=await commit(original);assert.equal(first.status,'committed');assert.ok(first.receipt_id);
  await t.test('deployed predecessor counterexample: duplicate omits the persisted original Receipt id',async()=>{
   const fresh=await resume();const replay=await commit({...original,session_token:fresh.session_token});
   assert.equal(replay.status,'duplicate');assert.equal(replay.checkpoint_id,first.checkpoint_id);assert.equal(replay.receipt_id,undefined);
   assert.equal((await admin.query("select id from public.clued_audit_receipts where operation='checkpoint' and object_id=$1",[first.checkpoint_id])).rows[0].id,first.receipt_id);
  });
  const savedCheckpoint=(await admin.query('select to_jsonb(c) value from public.clued_context_checkpoints c where id=$1',[first.checkpoint_id])).rows[0].value;
  const savedReceipt=(await admin.query('select to_jsonb(r) value from public.clued_audit_receipts r where id=$1',[first.receipt_id])).rows[0].value;
  const security=await functionSecurity();
  const patch=await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8');await admin.query(patch);
  await t.test('legacy result replays with its exact original Receipt through each new valid session',async()=>{
   for(let i=0;i<2;i++){
    const fresh=await resume();const before=await state();const replay=await commit({...original,session_token:fresh.session_token});
    assert.equal(replay.status,'duplicate');assert.equal(replay.checkpoint_id,first.checkpoint_id);assert.equal(replay.version,first.version);assert.equal(replay.receipt_id,first.receipt_id);
    assert.deepEqual(await state(),before);
   }
  });
  await t.test('fresh post-patch commit and replay have the same Receipt without a second write',async()=>{
   const fresh=await resume();const input={...original,idempotency_key:uuid(),base_version:fresh.version,session_token:fresh.session_token};
   const written=await commit(input);assert.equal(written.status,'committed');assert.ok(written.receipt_id);
   const again=await resume();const before=await state();const replay=await commit({...input,session_token:again.session_token});
   assert.equal(replay.status,'duplicate');assert.equal(replay.receipt_id,written.receipt_id);assert.equal(replay.checkpoint_id,written.checkpoint_id);
   assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts where operation='checkpoint' and object_id=$1",[written.checkpoint_id])).rows[0].n,1);
   assert.deepEqual(await state(),before);
  });
  await t.test('changed effective fields remain conflict and cannot disclose a Receipt reference',async()=>{
   const fresh=await resume(),profile=await resume('profile');
   for(const change of [{snapshot:{changed:true}},{summary:'changed'},{next_action:'changed'},{base_version:first.version},{context_key:'profile',session_token:profile.session_token}]){
    const before=await state();
    const result=await commit({...original,session_token:fresh.session_token,...change});
    assert.equal(result.status,'conflict');assert.equal(result.error,'idempotency_key_conflict');assert.equal(result.receipt_id,undefined);
    assert.deepEqual(await state(),before);
   }
  });
  await t.test('synthetic legacy checkpoints without one unique Receipt fail closed',async()=>{
   const fresh=await resume();
   for(const receiptCount of [0,2]){
    const key=uuid();
    const checkpoint=(await admin.query("insert into public.clued_context_checkpoints(user_id,binding_id,context_key,version,snapshot,summary,next_action,last_event_id,idempotency_key) values($1,$2,'global',$3,$4,$5,$6,0,$7) returning id",[U,binding,100+receiptCount,original.snapshot,original.summary,original.next_action,key])).rows[0].id;
    for(let i=0;i<receiptCount;i++)await admin.query("insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata) values($1,$2,'global','checkpoint','checkpoint',$3,$4,$5)",[U,binding,checkpoint,100+receiptCount,{base_version:original.base_version}]);
    const before=await state();const result=await commit({...original,idempotency_key:key,session_token:fresh.session_token});
    assert.equal(result.status,'conflict');assert.equal(result.error,'idempotency_key_conflict');assert.equal(result.receipt_id,undefined);
    assert.deepEqual(await state(),before);
   }
  });
  await t.test('repeatable forward migration leaves old checkpoint, original Receipt and grants unchanged',async()=>{
   await admin.query(patch);
   assert.deepEqual((await admin.query('select to_jsonb(c) value from public.clued_context_checkpoints c where id=$1',[first.checkpoint_id])).rows[0].value,savedCheckpoint);
   assert.deepEqual((await admin.query('select to_jsonb(r) value from public.clued_audit_receipts r where id=$1',[first.receipt_id])).rows[0].value,savedReceipt);
   assert.deepEqual(await functionSecurity(),security);
  });
 } finally {
  for(const db of clients.reverse())await db.end().catch(()=>{});await stopCluster(server);
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-checkpoint-receipt-'))throw Error('Unsafe test cleanup');
  await removeTestDirectory(target);
 }
});
