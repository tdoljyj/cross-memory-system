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
import {createTokenizer} from '../minimum-context-compiler/tokenizer.mjs';
import {readAndCompileWithSources as compile} from './compiler-with-sources.mjs';
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const EmbeddedPostgres=require('embedded-postgres').default;
const root=fileURLToPath(new URL('../../../apps/clued-cloud/',import.meta.url));
const key=()=>crypto.randomUUID(),hash=()=>crypto.randomBytes(32).toString('hex');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('actual Evidence and Canonical source binding',{timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-evidence-binding-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await port(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];
 try{
  await server.initialise();await server.start();const admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
  const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&(n<'20260826000000'||n.startsWith('20260907123955_')||n.startsWith('20260907131834_')||n.startsWith('20260907172309_')||n.startsWith('2026090717303'))).sort();
  for(const n of names)await admin.query(await fs.readFile(path.join(root,'supabase/migrations',n),'utf8'));

  await admin.query(await fs.readFile(new URL('./read-sources.candidate.sql',import.meta.url),'utf8'));
  const u=key(),rid=key(),h=hash(),e1=key(),e2=key();
  await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'source-fixture@example.invalid',now())",[u]);
  await admin.query("insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,context_keys,scopes) values($1,'fixture','Fixture',$2,array['global'],array['context:read','context:write'])",[u,h]);
  const client=server.getPgClient();clients.push(client);await client.connect();await client.query('set role anon');
  const rpc=async(name,input)=>(await client.query(`select public.${name}($1,$2::jsonb) value`,[h,JSON.stringify(input)])).rows[0].value;
  const raw=Buffer.from('Orbit source\r\nOnly local scratch output. 🛰️\n','utf8');
  const sourceHash=crypto.createHash('sha256').update(raw).digest('hex');
  for(const id of [e1,e2]){
   const receipt=await rpc('clued_evidence_ingest',{idempotency_key:key(),evidence_id:id,evidence_schema_version:1,evidence_type:'file',storage_ref:`synthetic-private-source:${id}`,content_hash:sourceHash,size_bytes:raw.length,mime_type:'text/plain'});
   assert.equal(receipt.status,'committed',JSON.stringify(receipt));
  }
  const candidate={idempotency_key:key(),operation:'create',id:rid,record_type:'note',record_schema_version:1,scope:'global',authority:'user_explicit',confidence_reason:'Explicit synthetic approval',source_refs:[e1,e2],source_unavailable_reason:null,mutation:{title:'orbit source',content:'Only local scratch output.',type_fields:{note_kind:'reference'},relations:{}}};
  await t.test('actual ingest, in-memory candidate, denied unconfirmed claim, then explicit record confirmation',async()=>{
   const count=async()=>(await admin.query('select count(*)::int n from public.clued_memories where id=$1',[rid])).rows[0].n;
   assert.equal(await count(),0);
   assert.equal((await rpc('clued_record_mutate',{...candidate,user_confirmed:false})).status,'rejected');assert.equal(await count(),0);
   const accepted=await rpc('clued_record_mutate',{...candidate,idempotency_key:key(),user_confirmed:true});assert.equal(accepted.status,'committed',JSON.stringify(accepted));
   assert.deepEqual(accepted.supplemental.record.source_refs,[e1,e2].sort());assert.notEqual(accepted.supplemental.record.content_hash,sourceHash);
  });
  const restored=await rpc('clued_mcp_restore',{context_key:'global'});const tokenizer=await createTokenizer();
  await client.query('set role service_role');
  const policy={context_key:'global',task:'Prepare source bound orbit context',token_budget:2048,required_records:[{id:rid,version:1,fields:['title','content']}],critical_constraints:[{record_id:rid,field:'content',exact_text:'Only local scratch output.'}]};
  const args={client,bindingTokenHash:h,sessionToken:restored.session_token,contextKey:'global',query:'orbit',policy,tokenizer,sourceBytes:new Map([[e1,raw],[e2,raw]])};
  const counts=async()=>(await admin.query("select (select jsonb_agg(to_jsonb(x) order by id) from public.clued_memories x) m,(select jsonb_agg(to_jsonb(x) order by id) from public.clued_evidence x) e,(select jsonb_agg(to_jsonb(x) order by id) from public.clued_audit_receipts x) r,(select jsonb_agg(to_jsonb(x) order by id) from public.clued_context_events x) ev")).rows[0];
  const before=await counts();
  await t.test('current authorized read binds distinct Evidence IDs to actual raw hash; all provenance tokens counted; Canon unchanged',async()=>{
   const out=await compile(args);const refs=out.provenance.source_bindings[0].evidence;
   assert.equal(refs.length,2);assert.ok(refs.every(e=>e.content_hash===sourceHash&&e.size_bytes===raw.length));
   assert.equal(out.token_count,tokenizer.count(out.text));assert.ok(out.token_count<=2048);
   assert.ok(!out.text.includes('synthetic-private-source:'));assert.ok(!out.text.includes(restored.session_token));assert.deepEqual(await counts(),before);
  });
  await t.test('wrong/missing raw bytes, old version, unauthorized scope and invalid session reject',async()=>{
   await assert.rejects(compile({...args,sourceBytes:new Map([[e1,Buffer.from('wrong')],[e2,raw]])}),/RAW_SOURCE_BYTES_MISMATCH/);
   await assert.rejects(compile({...args,sourceBytes:new Map()}),/RAW_SOURCE_BYTES_UNAVAILABLE/);
   await assert.rejects(compile({...args,policy:{...policy,required_records:[{...policy.required_records[0],version:2}]}}),/source_not_current_or_authorized/);
   await assert.rejects(compile({...args,contextKey:'profile',policy:{...policy,context_key:'profile'}}),e=>e.code==='42501');
   await assert.rejects(compile({...args,sessionToken:hash()}),e=>['42501','28000'].includes(e.code));assert.deepEqual(await counts(),before);
  });
  await t.test('no public helper privilege and no unlinked or foreign Evidence leaks',async()=>{
   for(const role of ['anon','authenticated'])assert.equal((await admin.query("select has_function_privilege($1,'clued_source_reader.read_compiler_sources(text,jsonb,jsonb)','EXECUTE') ok",[role])).rows[0].ok,false);
   const stranger=key(),foreign=key();await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'foreign-fixture@example.invalid',now())",[stranger]);
   await admin.query('insert into public.clued_evidence(id,user_id,evidence_schema_version,evidence_type,storage_ref,content_hash,size_bytes,receipt_id) values($1,$2,1,\'file\',\'synthetic:foreign\',$3,1,$4)',[foreign,stranger,sourceHash,key()]);
   await admin.query('update public.clued_memories set source_refs=$2 where id=$1',[rid,[foreign]]);await assert.rejects(compile(args),/source_evidence_unavailable/);
   await admin.query("update public.clued_memories set source_refs='{}' where id=$1",[rid]);await assert.rejects(compile(args),/raw_source_reference_missing/);
   await admin.query('update public.clued_memories set source_refs=$2 where id=$1',[rid,[e1,e2]]);
  });
  await t.test('live record and binding revocation reject without cached provenance',async()=>{
   await admin.query("update public.clued_memories set lifecycle_status='revoked',status='revoked' where id=$1",[rid]);await assert.rejects(compile(args),/source_not_current_or_authorized/);
   await admin.query('update public.clued_agent_bindings set revoked_at=now() where token_hash=$1',[h]);await assert.rejects(compile(args),e=>e.code==='42501');
  });
 }finally{
  for(const db of clients.reverse())await db.end().catch(()=>{});await server.stop().catch(()=>{});
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-evidence-binding-'))throw Error('Unsafe temp target');await fs.rm(target,{recursive:true,force:true});
 }
});
