import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// raw-binding-grants: applies only migrations before 20261009050000, where raw Bindings still pass.

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration='20260908094000_clued_checkpoint_idempotency_binding.sql';
const uuid=()=>crypto.randomUUID(), hash=()=>crypto.randomBytes(32).toString('hex');
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}

test('checkpoint replay binds effective payload and context inside the existing binding namespace',{timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-checkpoint-idempotency-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await port(),persistent:false,postgresFlags:['-c','io_method=sync'],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];let admin;
 try {
  await server.initialise();await server.start();admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
  const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&(n<'20260826000000'||n.startsWith('20260907123955_')||n.startsWith('20260907131834_')||n.startsWith('20260907172309_')||n.startsWith('2026090717303')||n.startsWith('20260908073933_'))).sort();
  for(const name of names)await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));
  async function client(){const db=server.getPgClient();clients.push(db);await db.connect();await db.query('set role anon');return db;}
  const one=await client(),two=await client();
  const rpc=async(db,name,h,input)=>(await db.query('select public.'+name+'($1,$2) value',[h,input])).rows[0].value;
  const U=uuid(),V=uuid();await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'checkpoint-owner@example.invalid',now()),($2,'checkpoint-other@example.invalid',now())",[U,V]);
  async function binding(user=U){const h=hash();const b=(await admin.query("insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic','checkpoint-test',$2,array['context:read','context:write'],array['global','profile']) returning id",[user,h])).rows[0];return {h,id:b.id};}
  const A=await binding(),B=await binding(),C=await binding(V);
  const resume=(b,context='global',db=one)=>rpc(db,'clued_mcp_restore',b.h,{context_key:context});
  const commit=(b,input,db=one)=>rpc(db,'clued_mcp_commit_checkpoint',b.h,input);
  const initial=await resume(A);
  const original={context_key:'global',base_version:initial.version,snapshot:{task:'synthetic',nested:{a:1,b:2}},summary:'synthetic summary',next_action:'synthetic next',idempotency_key:uuid(),session_token:initial.session_token};
  const first=await commit(A,original);assert.equal(first.status,'committed');
  await t.test('pre-fix counterexample: changed payload and context falsely return duplicate',async()=>{
   const again=await resume(A);const changed=await commit(A,{...original,session_token:again.session_token,summary:'DIFFERENT'});
   assert.equal(changed.status,'duplicate');assert.equal(changed.checkpoint_id,first.checkpoint_id);
   const profile=await resume(A,'profile');const crossed=await commit(A,{...original,context_key:'profile',session_token:profile.session_token});
   assert.equal(crossed.status,'duplicate');assert.equal(crossed.checkpoint_id,first.checkpoint_id);assert.equal(crossed.context_key,'profile');
  });
  let legacyNull;
  await t.test('pre-fix counterexample: null base version bypasses the CAS comparison',async()=>{
   const session=await resume(A);const invalid=await commit(A,{...original,idempotency_key:uuid(),base_version:null,session_token:session.session_token});
   assert.equal(invalid.status,'committed');legacyNull=invalid;
  });
  const saved=(await admin.query('select to_jsonb(c) value from public.clued_context_checkpoints c where id=$1',[first.checkpoint_id])).rows[0].value;
  const savedReceipt=(await admin.query("select to_jsonb(r) value from public.clued_audit_receipts r where operation='checkpoint' and object_id=$1",[first.checkpoint_id])).rows[0].value;
  const acl=(await admin.query("select proacl::text value from pg_proc where oid='public.clued_mcp_commit_checkpoint(text,jsonb)'::regprocedure")).rows[0].value;
  const patch=await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8');await admin.query(patch);
  await t.test('same effective payload replays a legacy checkpoint with a fresh session',async()=>{
   const session=await resume(A);
   const replay=await commit(A,{...original,context_key:' global ',summary:' synthetic summary ',next_action:' synthetic next ',snapshot:{nested:{b:2,a:1},task:'synthetic'},session_token:session.session_token});
   assert.equal(replay.status,'duplicate');assert.equal(replay.checkpoint_id,first.checkpoint_id);assert.equal(replay.version,first.version);assert.equal(replay.context_key,'global');
  });
  await t.test('changed snapshot, summary, next action, base version and context conflict without writes',async()=>{
   const session=await resume(A);const profile=await resume(A,'profile');
   const before=(await admin.query("select (select count(*) from public.clued_context_checkpoints) checkpoints,(select count(*) from public.clued_audit_receipts where operation='checkpoint') receipts")).rows[0];
   for(const change of [{snapshot:{task:'changed'}},{summary:'changed'},{next_action:'changed'},{base_version:first.version},{context_key:'profile',session_token:profile.session_token}]){
    const value=await commit(A,{...original,session_token:session.session_token,...change});assert.equal(value.status,'conflict');assert.equal(value.error,'idempotency_key_conflict');assert.equal(value.checkpoint_id,undefined);
   }
   assert.deepEqual((await admin.query("select (select count(*) from public.clued_context_checkpoints) checkpoints,(select count(*) from public.clued_audit_receipts where operation='checkpoint') receipts")).rows[0],before);
  });
  await t.test('null and negative base versions reject; bigint maximum conflicts without overflow',async()=>{
   const session=await resume(A);
   for(const base of [null,-1])await assert.rejects(commit(A,{...original,idempotency_key:uuid(),base_version:base,session_token:session.session_token}),e=>e.code==='22023'&&e.message==='invalid_base_version');
   const max=JSON.stringify({...original,base_version:'BIGINT_MAX',session_token:session.session_token}).replace('"BIGINT_MAX"','9223372036854775807');
   const changed=await commit(A,max);assert.equal(changed.status,'conflict');assert.equal(changed.error,'idempotency_key_conflict');
  });
  await t.test('a legacy null-base commit cannot be replayed by inventing version minus one',async()=>{
   const row=(await admin.query('select * from public.clued_context_checkpoints where id=$1',[legacyNull.checkpoint_id])).rows[0];
   const session=await resume(A);
   const forged=await commit(A,{...original,idempotency_key:row.idempotency_key,base_version:Number(row.version)-1,session_token:session.session_token});
   assert.equal(forged.status,'conflict');assert.equal(forged.error,'idempotency_key_conflict');
   assert.equal((await admin.query("select metadata->'base_version' value from public.clued_audit_receipts where operation='checkpoint' and object_id=$1",[legacyNull.checkpoint_id])).rows[0].value,null);
  });
  await t.test('foreign binding session is denied; legitimate bindings retain separate key namespaces',async()=>{
   const a=await resume(A);await assert.rejects(commit(B,{...original,session_token:a.session_token}),e=>e.code==='42501');
   const b=await resume(B);const stale=await commit(B,{...original,session_token:b.session_token});assert.equal(stale.status,'conflict');assert.equal(stale.error,'stale_base_version');
   const own=await commit(B,{...original,base_version:b.version,session_token:b.session_token});assert.equal(own.status,'committed');assert.notEqual(own.checkpoint_id,first.checkpoint_id);
   const c=await resume(C);const other=await commit(C,{...original,base_version:c.version,session_token:c.session_token});assert.equal(other.status,'committed');assert.notEqual(other.checkpoint_id,first.checkpoint_id);
  });
  await t.test('concurrent same-key same-payload has one commit and one replay',async()=>{
   const s1=await resume(A,'global',one),s2=await resume(A,'global',two),key=uuid();
   const payload={...original,idempotency_key:key,base_version:s1.version};
   const results=await Promise.all([commit(A,{...payload,session_token:s1.session_token},one),commit(A,{...payload,session_token:s2.session_token},two)]);
   assert.deepEqual(results.map(x=>x.status).sort(),['committed','duplicate']);assert.equal(results[0].checkpoint_id,results[1].checkpoint_id);
   assert.equal((await admin.query('select count(*)::int n from public.clued_context_checkpoints where binding_id=$1 and idempotency_key=$2',[A.id,key])).rows[0].n,1);
  });
  await t.test('concurrent same key across authorized contexts cannot commit twice',async()=>{
   const global=await resume(A,'global',one),profile=await resume(A,'profile',two),key=uuid();
   const values=await Promise.all([commit(A,{...original,idempotency_key:key,base_version:global.version,session_token:global.session_token},one),commit(A,{...original,context_key:'profile',idempotency_key:key,base_version:profile.version,session_token:profile.session_token},two)]);
   assert.deepEqual(values.map(x=>x.status).sort(),['committed','conflict']);assert.equal(values.find(x=>x.status==='conflict').error,'idempotency_key_conflict');
  });
  await t.test('revoked binding and ended or expired sessions cannot replay',async()=>{
   await assert.rejects(commit(A,original),e=>e.code==='42501');
   const expired=await resume(A);await admin.query("update public.clued_continuity_sessions set expires_at=now()-interval '1 second' where token_hash=encode(extensions.digest($1,'sha256'),'hex')",[expired.session_token]);
   await assert.rejects(commit(A,{...original,session_token:expired.session_token}),e=>e.code==='42501');
   const live=await resume(A);await admin.query('update public.clued_agent_bindings set revoked_at=now() where id=$1',[A.id]);await assert.rejects(commit(A,{...original,session_token:live.session_token}),e=>e.code==='42501');
  });
  await t.test('forward migration is repeatable and preserves legacy checkpoint, receipt and grants',async()=>{
   await admin.query(patch);
   assert.deepEqual((await admin.query('select to_jsonb(c) value from public.clued_context_checkpoints c where id=$1',[first.checkpoint_id])).rows[0].value,saved);
   assert.deepEqual((await admin.query("select to_jsonb(r) value from public.clued_audit_receipts r where operation='checkpoint' and object_id=$1",[first.checkpoint_id])).rows[0].value,savedReceipt);
   assert.equal((await admin.query("select proacl::text value from pg_proc where oid='public.clued_mcp_commit_checkpoint(text,jsonb)'::regprocedure")).rows[0].value,acl);
  });
 } finally {
  for(const db of clients.reverse())await db.end().catch(()=>{});await stopCluster(server);
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-checkpoint-idempotency-'))throw Error('Unsafe test cleanup');
  await removeTestDirectory(target);
 }
});
