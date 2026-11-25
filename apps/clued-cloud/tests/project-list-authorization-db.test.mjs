// issuer-credentials: this historical test selects a migration chain before step 2b.
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
const migration='20260908073933_clued_project_list_authorized_scope.sql';
const key=()=>crypto.randomUUID(), hash=()=>crypto.randomBytes(32).toString('hex');
const future=()=>new Date(Date.now()+3600000).toISOString();
const scope=(id,actions=['read'])=>({resource_kind:'scope',resource_id:id,environment:'canonical',actions});

test('project list uses current explicit Canonical project consent in real PostgreSQL',{timeout:180000},async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-project-list-'));
 const server=newCluster({databaseDir:dir,user:'postgres',password:hash(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];let admin;
 try {
  await startCluster(server);admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
  const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&(n<'20260826000000'||n.startsWith('20260907123955_')||n.startsWith('20260907131834_')||n.startsWith('20260907172309_')||n.startsWith('2026090717303')||n===migration)).sort();
  assert.ok(names.includes(migration));
  for(const name of names){try{await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));}catch(e){e.message=name+': '+e.message;throw e;}}
  const U=key(),V=key(),A=key(),B=key(),C=key(),issuer=hash(),resource='https://mcp.example.invalid/mcp';
  await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.invalid',now()),($2,'member@example.invalid',now())",[U,V]);
  // Newer unauthorized rows must not consume the requested limit.
  for(const [id,u,name,date] of [[A,U,'Allowed old','2026-01-01'],[B,U,'Private new','2026-02-01'],[C,V,'Other owner','2026-03-01']])await admin.query('insert into public.clued_projects(id,user_id,name,normalized_name,context_key,updated_at) values($1,$2,$3,lower($3),$4,$5)',[id,u,name,'project:'+id,date]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Fixture issuer')",[issuer,resource]);
  async function client(role,u){const db=server.getPgClient();clients.push(db);await db.connect();await db.query('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[u??'',JSON.stringify(u?{sub:u}:{})]);return db;}
  const owner=await client('authenticated',U),member=await client('authenticated',V),anon=await client('anon');
  const rpc=async(db,name,args)=>(await db.query('select public.'+name+'('+args.map((_,n)=>'$'+(n+1)).join(',')+') value',args.map(a=>Array.isArray(a)?JSON.stringify(a):a))).rows[0].value;
  const denied=(p,label)=>assert.rejects(p,e=>['42501','28000'].includes(e.code),label);
  async function grant(selected,db=owner){
   const r=await rpc(db,'clued_authorization_prepare_v12',[issuer,{request_digest:hash(),client_id:'fixture-client',client_name:'Fixture client',redirect_uri:'https://client.example.invalid/callback',resource,requested_scopes:['context:read','context:write','audit:read']}]);
   const h=hash();return {h,...await rpc(db,'clued_authorization_approve_v12',[issuer,r.request_id,r.version,selected,h,future()])};
  }
  async function raw(keys,scopes=['context:read']){const h=hash();const row=(await admin.query("insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,context_keys,scopes) values($1,'fixture','Fixture',$2,$3,$4) returning id",[U,h,keys,scopes])).rows[0];return {h,binding_id:row.id};}
  const list=(b,input={})=>rpc(anon,'clued_project_list',[b.h,input]);
  const ids=async(b,input)=>(await list(b,input)).projects.map(p=>p.id);
  let selected;
  await t.test('explicit project read works without system grant and filters before limit',async()=>{
   selected=await grant([scope('global'),scope('profile'),scope('project:'+A)]);
   assert.deepEqual(await ids(selected,{limit:1}),[A]);
   assert.deepEqual(await ids(selected,{query:'Allowed'}),[A]);
   assert.deepEqual(await ids(selected,{query:'Private'}),[]);
   assert.deepEqual(await ids(selected,{query:'Other',include_dismissed:true}),[]);
   const p=(await list(selected)).projects[0];assert.equal(p.mention_count,0);assert.equal(p.user_id,U);
  });
  await t.test('global/profile and write-only project consent reveal no project metadata',async()=>{
   assert.deepEqual(await ids(await grant([scope('global'),scope('profile')])),[]);
   assert.deepEqual(await ids(await grant([scope('global'),scope('project:'+A,['write'])])),[]);
   assert.deepEqual(await ids(await raw(['global','profile'])),[]);
  });
  await t.test('legacy broad grants stay owner-scoped and narrow raw grants stay exact',async()=>{
   for(const context of ['*','system:projects'])assert.deepEqual(await ids(await raw([context])),[B,A]);
   assert.deepEqual(await ids(await raw(['project:'+A,'project:'+C])),[A]);
   await denied(list(await raw(['*'],['context:write'])));
  });
  await t.test('same connection reduction takes effect without changing its token or stale keys',async()=>{
   const g=await grant([scope('global'),scope('project:'+A),scope('project:'+B)]);
   assert.deepEqual(await ids(g),[B,A]);
   await rpc(owner,'clued_authorization_manage_v12',[{op:'reduce',binding_id:g.binding_id,base_version:g.version,selected:[scope('global'),scope('project:'+A)]}]);
   assert.deepEqual(await ids(g),[A]);
   await admin.query("update public.clued_agent_bindings set context_keys=array['*'] where id=$1",[g.binding_id]);
   assert.deepEqual(await ids(g),[A]);
  });
  await t.test('binding and authorization revocation, expiry, disabled account fail closed',async()=>{
   // The existing resolver supports endpoints with and without this optional column.
   await admin.query('alter table public.clued_agent_bindings add column expires_at timestamptz');
   for(const [table,column,value] of [['public.clued_agent_bindings','revoked_at','now()'],['public.clued_agent_bindings','expires_at',"now()-interval '1 second'"],['clued_private.authorizations_v12','revoked_at','now()'],['clued_private.authorizations_v12','expires_at',"now()-interval '1 second'"]]){
    const label=`${table}.${column}`;
    const g=await grant([scope('project:'+A)]);
    const predicate=table.startsWith('public')?'id':'binding_id';
    const changed=await admin.query(`update ${table} set ${column}=${value} where ${predicate}=$1`,[g.binding_id]);
    assert.equal(changed.rowCount,1,`${label}: exactly one fixture row changed`);
    const observed=(await admin.query(`select ${column} as actual_value,clock_timestamp() as db_clock,
      ${column}<=clock_timestamp() as not_future from ${table} where ${predicate}=$1`,[g.binding_id])).rows[0];
    t.diagnostic(JSON.stringify({case:label,row_count:changed.rowCount,...observed}));
    assert.ok(observed.actual_value,`${label}: the mutated field is present`);
    if(column==='expires_at')assert.equal(observed.not_future,true,`${label}: the fixture is already expired on the database clock`);
    await denied(list(g),`${label}: current project list rejects the changed fixture`);
   }
   await denied(list({h:hash()}));await denied(list({h:'invalid'}));
   await admin.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[U]);await denied(list(selected));
   await admin.query('update auth.users set banned_until=null,deleted_at=now() where id=$1',[U]);await denied(list(selected));
   await admin.query('update auth.users set deleted_at=null where id=$1',[U]);
  });
  await t.test('current ownership and lifecycle/query filters remain effective',async()=>{
   await admin.query('update public.clued_projects set user_id=$2 where id=$1',[A,V]);assert.deepEqual(await ids(selected),[]);
   await admin.query('update public.clued_projects set user_id=$2,dismissed_at=now() where id=$1',[A,U]);assert.deepEqual(await ids(selected),[]);assert.deepEqual(await ids(selected,{include_dismissed:true}),[A]);
   await admin.query('update public.clued_projects set dismissed_at=null,merged_into_project_id=$2 where id=$1',[A,B]);assert.deepEqual(await ids(selected,{include_dismissed:true}),[]);
   await admin.query('update public.clued_projects set merged_into_project_id=null where id=$1',[A]);
   assert.deepEqual(await ids(selected,{progress_status:'impossible'}),[]);assert.deepEqual(await ids(selected,{certainty_status:'impossible'}),[]);
  });
  await t.test('v13 development membership never confers Canonical project consent, even before revoke',async()=>{
   const created=await rpc(owner,'clued_development_owner_v14',[{op:'context_create',name:'Fixture development',project_id:A,environment:'test',idempotency_key:key()}]);const cid=created.result.id;
   const invitation=await rpc(owner,'clued_project_access_v13',[{op:'invite_create',project_id:A,environment:'test',target_email:'member@example.invalid',role:'reader',actions:['read'],expires_at:future(),idempotency_key:key()}]);
   const membership=await rpc(member,'clued_project_access_v13',[{op:'invite_accept',invite_token:invitation.invite_token,base_version:invitation.version,idempotency_key:key()}]);
   const g=await grant([{resource_kind:'context',resource_id:cid,environment:'test',actions:['read']}],member);
   const contexts=await rpc(anon,'clued_development_call_v14',[g.h,{op:'context_list',mode:'development_history'}]);
   assert.ok(contexts.contexts.some(c=>c.id===cid));
   assert.deepEqual(await ids(g),[]);
   await rpc(owner,'clued_project_access_v13',[{op:'member_revoke',membership_id:membership.membership_id,base_version:membership.version,idempotency_key:key()}]);
   await denied(rpc(anon,'clued_development_call_v14',[g.h,{op:'record_list',context_id:cid,mode:'development_history'}]));
   assert.deepEqual(await ids(g),[]);
  });
  await t.test('migration is repeatable and retains RPC/table privilege boundary',async()=>{
   await admin.query(await fs.readFile(path.join(root,'supabase/migrations',migration),'utf8'));assert.deepEqual(await ids(selected),[A]);
   await denied(rpc(owner,'clued_project_list',[selected.h,{}]));
   await denied(anon.query('select * from clued_private.authorization_entries_v12'));
  });
 } finally {
  for(const db of clients.reverse())await db.end().catch(()=>{});await stopCluster(server);
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-project-list-'))throw Error('Unsafe test cleanup');
  await removeTestDirectory(target);
 }
});
