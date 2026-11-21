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
import {createTokenizer} from './tokenizer.mjs';
import {readAndCompile} from './compiler.mjs';
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const EmbeddedPostgres=require('embedded-postgres').default;
const root=fileURLToPath(new URL('../../../apps/clued-cloud/',import.meta.url));
const key=()=>crypto.randomUUID(),hash=()=>crypto.randomBytes(32).toString('hex');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('compiler calls the real existing scoped/session-bound search RPC and never reuses revoked input',{timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-context-compiler-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await port(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];
 try{
  await server.initialise();await server.start();const admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
  const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&(n<'20260826000000'||n.startsWith('20260907123955_')||n.startsWith('20260907131834_')||n.startsWith('20260907172309_')||n.startsWith('2026090717303'))).sort();
  for(const n of names)await admin.query(await fs.readFile(path.join(root,'supabase/migrations',n),'utf8'));
  const u=key(),rid=key(),h=hash();await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'synthetic@example.invalid',now())",[u]);
  await admin.query("insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,context_keys,scopes) values($1,'fixture','Fixture',$2,array['global'],array['context:read','context:write'])",[u,h]);
  await admin.query("insert into public.clued_memories(id,user_id,title,content,scope,record_type,status,record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,source_unavailable_reason,authority,confidence_reason) values($1,$2,'orbit source','Observe orbit. Only local scratch output.','global','task','active',1,'active','global','{\"private_note\":\"SYNTHETIC_NOT_SELECTED\"}','{}','{}','Synthetic isolated fixture','user_explicit','Explicit local test fixture')",[rid,u]);
  const client=server.getPgClient();clients.push(client);await client.connect();await client.query('set role anon');
  const restored=(await client.query('select public.clued_mcp_restore($1,$2) value',[h,{context_key:'global'}])).rows[0].value;
  const tokenizer=await createTokenizer();
  const policy={context_key:'global',task:'Prepare orbit context',token_budget:2048,required_records:[{id:rid,version:1,fields:['title','content']}],critical_constraints:[{record_id:rid,field:'content',exact_text:'Only local scratch output.'}]};
  const args={client,bindingTokenHash:h,sessionToken:restored.session_token,contextKey:'global',query:'orbit',policy,tokenizer};
  const before=(await admin.query('select to_jsonb(m) value from public.clued_memories m where id=$1',[rid])).rows[0].value;
  await t.test('actual current authorized source compiles with real tokenizer and exact Canonical ID/version',async()=>{
   const out=await readAndCompile(args);assert.equal(out.provenance.selected_records[0].id,rid);assert.equal(out.token_count,tokenizer.count(out.text));assert.ok(!out.text.includes('SYNTHETIC_NOT_SELECTED'));assert.ok(!out.text.includes(restored.session_token));
   assert.deepEqual((await admin.query('select to_jsonb(m) value from public.clued_memories m where id=$1',[rid])).rows[0].value,before);
  });
  await t.test('real resolver denies cross-scope and invalid session before compilation',async()=>{
   await assert.rejects(readAndCompile({...args,contextKey:'profile',policy:{...policy,context_key:'profile'}}),e=>e.code==='42501');
   await assert.rejects(readAndCompile({...args,sessionToken:hash()}),e=>['42501','28000'].includes(e.code));
  });
  await t.test('next request reads live lifecycle and live binding; no compiler cache or fallback',async()=>{
   await admin.query("update public.clued_memories set lifecycle_status='revoked',status='revoked' where id=$1",[rid]);
   await assert.rejects(readAndCompile(args),/INSUFFICIENT_OR_AMBIGUOUS_AUTHORIZED_CONTEXT/);
   await admin.query('update public.clued_agent_bindings set revoked_at=now() where token_hash=$1',[h]);
   await assert.rejects(readAndCompile(args),e=>e.code==='42501');
  });
 }finally{
  for(const db of clients.reverse())await db.end().catch(()=>{});await server.stop().catch(()=>{});
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-context-compiler-'))throw Error('Unsafe temp target');await fs.rm(target,{recursive:true,force:true});
 }
});
