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
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const EmbeddedPostgres=require('embedded-postgres').default;
const root=fileURLToPath(new URL('../../../apps/clued-cloud/',import.meta.url));
const key=()=>crypto.randomUUID(),hash=()=>crypto.randomBytes(32).toString('hex');
const scope=(id,actions=['read'])=>({resource_kind:'scope',resource_id:id,environment:'canonical',actions});
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('existing record-list query: actual PostgreSQL source authorization before LIMIT',{timeout:180000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-record-prefilter-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await port(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];
 try{
  await server.initialise();await server.start();const admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
  const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&(n<'20260826000000'||n==='20260829100000_clued_legacy_log_alias_bridge.sql'||n.startsWith('20260907123955_')||n.startsWith('20260907131834_')||n.startsWith('20260907172309_')||n.startsWith('2026090717303'))).sort();
  for(const n of names){try{await admin.query(await fs.readFile(path.join(root,'supabase/migrations',n),'utf8'));}catch(e){e.message=n+': '+e.message;throw e;}}
  const U=key(),V=key(),P=key(),Q=key(),issuer=hash(),resource='https://mcp.example.invalid/mcp';
  await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now()),($2,'other@example.invalid',now())",[U,V]);
  for(const [id,name] of [[P,'Parent'],[Q,'Merged']])await admin.query('insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,$3,lower($3),$4)',[id,U,name,'project:'+id]);
  await admin.query('update public.clued_projects set merged_into_project_id=$2 where id=$1',[Q,P]);
  const rows=[['global-visible','global',null,'global',1,U],['profile-hidden','global',null,'profile',100,U],['parent-visible','project',P,'project:'+P,1,U],['merged-hidden','project',Q,'project:'+Q,100,U],['other-owner','global',null,'global',200,V]];
  for(const [title,s,p,cs,priority,u] of rows)await admin.query("insert into public.clued_memories(user_id,title,content,scope,project_id,canonical_scope,record_type,status,priority) values($1,$2,$2,$3,$4,$5,'note','active',$6)",[u,title,s,p,cs,priority]);
  for(const [p,name] of [[P,'parent-event'],[Q,'merged-event']])await admin.query("insert into public.clued_context_events(user_id,context_key,event_type,payload,event_scope,audit_visibility) values($1,$2,'note',$3,$2,'work_log')",[U,'project:'+p,{marker:name}]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Fixture issuer')",[issuer,resource]);
  async function client(role,u){const db=server.getPgClient();clients.push(db);await db.connect();await db.query('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[u??'',JSON.stringify(u?{sub:u}:{})]);return db;}
  const owner=await client('authenticated',U),anon=await client('anon'),service=await client('service_role');
  const rpc=async(db,name,args)=>(await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') value',args.map(x=>Array.isArray(x)?JSON.stringify(x):x))).rows[0].value;
  async function grant(selected){const p=await rpc(owner,'clued_authorization_prepare_v12',[issuer,{request_digest:hash(),client_id:'fixture',client_name:'Fixture',redirect_uri:'https://client.example.invalid/callback',resource,requested_scopes:['context:read']}]);const h=hash();return {h,...await rpc(owner,'clued_authorization_approve_v12',[issuer,p.request_id,p.version,selected,h,new Date(Date.now()+3600000).toISOString()])};}
  const global=await grant([scope('global')]),project=await grant([scope('project:'+P)]),both=await grant([scope('global'),scope('profile')]);
  const list=(b,input={})=>rpc(anon,'clued_record_list',[b.h,{record_type:'note',...input}]);
  const titles=async(b,input)=>(await list(b,input)).records.map(x=>x.title);
  const log=async(b)=>(await list(b,{level:'project',project_id:P,record_type:'log',limit:1})).records.map(x=>x.payload.marker);
  const snapshot=async()=>(await admin.query("select jsonb_build_object('records',(select jsonb_agg(to_jsonb(m) order by id) from public.clued_memories m),'events',(select jsonb_agg(to_jsonb(e) order by id) from public.clued_context_events e),'receipts',(select jsonb_agg(to_jsonb(r) order by id) from public.clued_audit_receipts r)) value")).rows[0].value;
  const attrs=async()=>(await admin.query("select oid::regprocedure::text signature,proacl::text,prosecdef,proconfig from pg_proc where oid in ('public.clued_record_list(text,jsonb)'::regprocedure,'clued_private.record_list_core(uuid,jsonb)'::regprocedure) order by signature")).rows;
  const beforeRows=await snapshot(),beforeAttrs=await attrs();
  const ownerBefore=await rpc(owner,'clued_user_record_list',[{record_type:'note',limit:1}]);
  await t.test('old production-shaped wrapper loses permitted records/events behind unauthorized high-ranked sources',async()=>{
   assert.deepEqual(await titles(global,{limit:1}),[]);assert.deepEqual(await titles(global,{limit:200}),['global-visible']);
   assert.deepEqual(await titles(project,{level:'project',project_id:P,limit:1}),[]);assert.deepEqual(await log(project),[]);
  });
  const sql=await fs.readFile(new URL('authorized-record-list.candidate.sql',import.meta.url),'utf8');await admin.query(sql);
  await t.test('existing public endpoint now filters actual canonical source before limit for records and events',async()=>{
   assert.deepEqual(await titles(global,{limit:1}),['global-visible']);assert.deepEqual(await titles(global,{limit:200}),['global-visible']);
   assert.deepEqual(await titles(project,{level:'project',project_id:P,limit:1}),['parent-visible']);assert.deepEqual(await log(project),['parent-event']);
   assert.deepEqual(await rpc(owner,'clued_user_record_list',[{record_type:'note',limit:1}]),ownerBefore);
   assert.deepEqual(await snapshot(),beforeRows);
  });
  await t.test('client JSON cannot inject trusted scopes; exact grants and private function privileges are enforced',async()=>{
   assert.deepEqual(await titles(global,{limit:1,authorized_scopes:['profile'],p_authorized_scopes:null,_authorized_source_scopes:['*']}),['global-visible']);
   assert.deepEqual(await titles(both,{limit:1}),['profile-hidden']);
   for(const db of [owner,anon,service])await assert.rejects(db.query('select clued_private.record_list_core($1,$2,$3)',[U,{},['*']]),e=>e.code==='42501');
   await assert.rejects(list(global,{level:'project',project_id:P}),e=>e.code==='42501');
   await assert.rejects(list({h:hash()}),e=>e.code==='42501');
  });
  await t.test('live reduction and revocation retain original authorization semantics without stale scope reuse',async()=>{
   await rpc(owner,'clued_authorization_manage_v12',[{op:'reduce',binding_id:both.binding_id,base_version:both.version,selected:[scope('global')]}]);
   assert.deepEqual(await titles(both,{limit:1}),['global-visible']);
   const current=await rpc(owner,'clued_authorization_manage_v12',[{op:'list'}]);const a=current.bindings.find(x=>x.binding_id===both.binding_id);
   await rpc(owner,'clued_authorization_manage_v12',[{op:'revoke',binding_id:both.binding_id,base_version:a.version}]);await assert.rejects(list(both),e=>e.code==='42501');
  });
  await t.test('repeatable candidate keeps existing function grants/config and cannot mutate Canonical rows',async()=>{
   await admin.query(sql);assert.deepEqual(await attrs(),beforeAttrs);assert.deepEqual(await snapshot(),beforeRows);
   const x=(await admin.query("select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service_role from pg_proc where oid='clued_private.record_list_core(uuid,jsonb,text[])'::regprocedure")).rows[0];
   assert.deepEqual(x,{prosecdef:true,proconfig:['search_path=""'],anon:false,authenticated:false,service_role:false});
  });
 }finally{
  for(const db of clients.reverse())await db.end().catch(()=>{});await server.stop().catch(()=>{});
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-record-prefilter-'))throw Error('Unsafe cleanup target');
  await fs.rm(target,{recursive:true,force:true});
 }
});
