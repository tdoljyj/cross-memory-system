// issuer-credentials: this historical test selects a migration chain before step 2b.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration='20260907173031_clued_connection_authorization_v12.sql';
const U='10000000-0000-4000-8000-000000000001', V='10000000-0000-4000-8000-000000000002';
const P='20000000-0000-4000-8000-000000000001';
const resource='https://mcp.example.invalid/mcp';
const key=()=>crypto.randomUUID(), hash=()=>crypto.randomBytes(32).toString('hex');
const future=()=>new Date(Date.now()+3600000).toISOString();
const scope=(id,actions)=>({resource_kind:'scope',resource_id:id,environment:'canonical',actions});
const ctx=(id,actions)=>({resource_kind:'context',resource_id:id,environment:'test',actions});
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('Connection authorization v1.2: real PostgreSQL permission and transaction boundaries',{timeout:180000},async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-auth-v12-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await port(),persistent:false,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(m){process.stderr.write(m+'\n');}});
 const clients=[];let admin,cid;const issuer=hash();
 try{
  await server.initialise();await server.start();admin=server.getPgClient();clients.push(admin);await admin.connect();
  await admin.query("create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
  const names=(await fs.readdir(path.join(root,'supabase/migrations'))).filter(n=>n.endsWith('.sql')&&(n<'20260826000000'||n.startsWith('20260907123955_')||n.startsWith('20260907131834_')||n.startsWith('20260907172309_')||n.startsWith('2026090717303'))).sort();
  for(const name of names){if(name.startsWith('20260907173030_')){assert.equal((await admin.query("select to_regclass('clued_private.context_spaces_v11') old")).rows[0].old,null);}try{await admin.query(await fs.readFile(path.join(root,'supabase/migrations',name),'utf8'));}catch(e){e.message=name+': '+e.message;throw e;}}
  assert.equal((await admin.query("select to_regclass('clued_private.context_spaces_v11') old,to_regprocedure('public.clued_context_call(text,jsonb)') rpc")).rows[0].old,null);
  assert.equal((await admin.query("select count(*)::int n from pg_tables where schemaname='clued_private' and tablename like 'development_%_v14'")).rows[0].n,6);
  await admin.query("insert into auth.users values($1,'owner@example.invalid'),($2,'other@example.invalid')",[U,V]);
  await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key) values($1,$2,'Test project','test project',$3)",[P,U,'project:'+P]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Test gateway')",[issuer,resource]);
  async function client(role,user=null,oauth=null){
   const db=server.getPgClient();clients.push(db);await db.connect();await db.query('set role '+role);
   await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[user??'',JSON.stringify({sub:user,...(oauth?{client_id:oauth}:{})})]);return db;
  }
  const owner=await client('authenticated',U),other=await client('authenticated',V),oldOAuth=await client('authenticated',U,'shared-client'),anon=await client('anon'),service=await client('service_role');
  const rpc=async(db,name,args)=>(await db.query('select public.'+name+'('+args.map((_,n)=>'$'+(n+1)).join(',')+') value',args.map(a=>Array.isArray(a)?JSON.stringify(a):a))).rows[0].value;
  const denied=async(p,codes=['42501','28000'])=>assert.rejects(p,e=>codes.includes(e.code));
  const own=input=>rpc(owner,'clued_development_owner_v14',[{idempotency_key:key(),...input}]);
  cid=(await own({op:'context_create',name:'Development test',project_id:P,environment:'test'})).result.id;
  const request=(scopes=['context:read','context:write','audit:read'])=>({request_digest:hash(),client_id:'shared-client',client_name:'Test AI',redirect_uri:'https://client.example.invalid/callback',resource,requested_scopes:scopes});
  const prepare=(r=request(),db=owner,ih=issuer)=>rpc(db,'clued_authorization_prepare_v12',[ih,r]);
  const approve=(r,selected,h=hash(),expires=future(),db=owner)=>rpc(db,'clued_authorization_approve_v12',[issuer,r.request_id,r.version,selected,h,expires]);
  const create=async(selected,scopes)=>{const r=await prepare(request(scopes));const h=hash(),expires=future();const a=await approve(r,selected,h,expires).catch(e=>{process.stderr.write('APPROVE: '+e.message+'; '+e.where+'\n');throw e;});return {r,h,expires,...a};};
  const call=(b,input,db=anon)=>rpc(db,'clued_development_call_v14',[b.h,{context_id:cid,...input}]);
  const status=b=>rpc(anon,'clued_authorization_status_v12',[b.h]);
  const manage=(input,db=owner)=>rpc(db,'clued_authorization_manage_v12',[input]);
  let personal,developer,combined;
  await t.test('trusted issuer and direct subject required; no forged client request',async()=>{
   await denied(prepare(request(),owner,hash()));
   await denied(prepare(request(),oldOAuth));
   await denied(prepare(request(),anon));
   await denied(prepare(request(),service));
   const raw=request();await prepare(raw);await denied(prepare({...raw,client_id:'different-client'}),['40001']);
  });
  await t.test('selected permissions intersect requested scopes and current ownership',async()=>{
   const r=await prepare(request(['context:read']));
   assert.equal(r.eligible.find(e=>e.resource_id==='global').actions.join(','),'read');
   await denied(approve(r,[scope('global',['write'])]));
   await denied(approve(r,[ctx(cid,['read'])],hash(),future(),other));
   await denied(approve(r,[{...ctx(cid,['read']),environment:'production'}]));
   await denied(approve(r,[]),['22023']);
   const no=await prepare(request(),other);assert.ok(!no.eligible.some(e=>e.resource_id===cid||e.resource_id==='project:'+P));
  });
  await t.test('same client creates independent bindings; partial consent never forms Cartesian product',async()=>{
   personal=await create([scope('global',['read'])]);
   developer=await create([ctx(cid,['write'])]);
   combined=await create([scope('global',['read']),ctx(cid,['read','write'])]);
   assert.notEqual(personal.binding_id,developer.binding_id);
   assert.deepEqual(personal.granted_scopes,['context:read']);assert.deepEqual(developer.granted_scopes,['context:write']);
   await denied(call(personal,{op:'record_put',record_type:'note',body:{content:'wrong resource'},idempotency_key:key()}));
   await denied(rpc(anon,'clued_record_mutate',[combined.h,{scope:'global',operation:'create'}]));
   await denied(call(developer,{op:'record_list',mode:'development_history'}));
   const written=await call(developer,{op:'record_put',record_type:'note',body:{content:'permitted development'},idempotency_key:key()});
   assert.ok(written.result.id);
   assert.equal((await call(combined,{op:'record_list',mode:'development_history'})).records.length,1);
   assert.equal((await call(personal,{op:'context_list',mode:'development_history'})).contexts.length,0);
   const list=await manage({op:'list'});assert.equal(list.bindings.length,3);assert.ok(list.bindings.every(b=>b.active&&b.grants.length));
  });
  await t.test('approval retries preserve exact binding and cannot reuse request for broader consent',async()=>{
   assert.equal((await approve(personal.r,[scope('global',['read'])],personal.h,personal.expires)).binding_id,personal.binding_id);
   await denied(approve(personal.r,[scope('global',['read'])]),['40001']);
   await denied(approve(personal.r,[scope('global',['write'])],personal.h,personal.expires),['40001']);
  });
  await t.test('legacy JWT, tables, private helpers and whole-account exports cannot bypass selection',async()=>{
   await denied(rpc(oldOAuth,'clued_oauth_call',['record_list',{}]));
   await denied(rpc(oldOAuth,'clued_development_oauth_call_v14',[{op:'context_list'}]));
   await denied(rpc(oldOAuth,'clued_user_project_list',[{}]));
   assert.equal((await oldOAuth.query('select * from public.clued_projects')).rows.length,0);
   for(const db of [anon,owner,service]) await denied(db.query('select * from clued_private.authorizations_v12'));
   await denied(rpc(anon,'clued_resolve_binding',[personal.h,'context:read']));
   await denied(rpc(anon,'clued_canonical_export',[personal.h,{idempotency_key:key()}]));
  });
  await t.test('global aggregation filters actual source scopes',async()=>{
   await admin.query("insert into public.clued_memories(user_id,title,content,scope,record_type,status) values($1,'personal','personal','global','note','active')",[U]);
   await admin.query("insert into public.clued_memories(user_id,title,content,scope,project_id,record_type,status) values($1,'private project','private project','project',$2,'note','active')",[U,P]);
   const listed=await rpc(anon,'clued_record_list',[personal.h,{level:'global',record_type:'note'}]);
   assert.deepEqual(listed.records.map(r=>r.title),['personal']);
  });
  await t.test('reduce is CAS protected and cannot grow; other same-client binding remains valid',async()=>{
   await denied(manage({op:'reduce',binding_id:combined.binding_id,base_version:1,selected:[scope('global',['write'])]}));
   await denied(manage({op:'reduce',binding_id:combined.binding_id,base_version:2,selected:[scope('global',['read'])]}),['40001']);
   const reduced=await manage({op:'reduce',binding_id:combined.binding_id,base_version:1,selected:[scope('global',['read']),ctx(cid,['read'])]});
   assert.equal(reduced.version,2);
   await denied(call(combined,{op:'record_put',record_type:'note',body:{content:'after reduction'},idempotency_key:key()}));
   assert.equal((await status(developer)).active,true);
   await denied(manage({op:'revoke',binding_id:developer.binding_id,base_version:1},other));
  });
  await t.test('business commit before revocation is ordered; all operations after revocation commit fail',async()=>{
   const writer=await client('anon'),revoker=await client('authenticated',U);
   await writer.query('begin');
   await call(developer,{op:'record_put',record_type:'note',body:{content:'commits before revoke'},idempotency_key:key()},writer);
   let completed=false;
   const pending=rpc(revoker,'clued_authorization_manage_v12',[{op:'revoke',binding_id:developer.binding_id,base_version:1}]).then(r=>{completed=true;return r;});
   for(let n=0;n<100;n++){const q=await admin.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[revoker.processID]);if(q.rows.length)break;if(n===99)assert.fail('revoke did not wait for in-flight write');await new Promise(r=>setTimeout(r,10));}
   assert.equal(completed,false);await writer.query('commit');await pending;
   assert.equal((await status(developer)).active,false);
   await denied(call(developer,{op:'record_put',record_type:'note',body:{content:'must never commit'},idempotency_key:key()}));
   assert.equal((await status(personal)).active,true);
  });
  await t.test('revocation commit first blocks a queued business operation before side effect',async()=>{
   const b=await create([ctx(cid,['write'])]),writer=await client('anon'),revoker=await client('authenticated',U);
   await revoker.query('begin');await rpc(revoker,'clued_authorization_revoke_self_v12',[b.h]);
   let settled=false;
   const pending=call(b,{op:'record_put',record_type:'note',body:{content:'revoked while queued'},idempotency_key:key()},writer).then(()=>{settled=true;return null;},e=>{settled=true;return e;});
   for(let n=0;n<100;n++){const q=await admin.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[writer.processID]);if(q.rows.length)break;if(n===99)assert.fail('write did not wait for revocation');await new Promise(r=>setTimeout(r,10));}
   assert.equal(settled,false);await revoker.query('commit');assert.equal((await pending).code,'42501');
   assert.equal((await admin.query("select count(*)::int n from clued_private.development_records_v14 where body->>'content'='revoked while queued'")).rows[0].n,0);
  });
  await t.test('status/self-revoke are minimal and idempotent; expiry is live',async()=>{
   const b=await create([scope('global',['read'])]);const x=await rpc(anon,'clued_authorization_revoke_self_v12',[b.h]);
   assert.equal(x.active,false);assert.equal(x.version,2);
   assert.equal((await rpc(anon,'clued_authorization_revoke_self_v12',[b.h])).version,2);
   assert.deepEqual(await rpc(anon,'clued_authorization_status_v12',[hash()]),{active:false});
   const expired=await create([scope('global',['read'])]);await admin.query("update clued_private.authorizations_v12 set expires_at=now()-interval '1 second' where binding_id=$1",[expired.binding_id]);
   assert.equal((await status(expired)).active,false);await denied(rpc(anon,'clued_record_list',[expired.h,{}]));
  });

  await t.test('deny and approve serialize on the same request; denied/approved state cannot be reversed',async()=>{
   const r=await prepare();await rpc(owner,'clued_authorization_deny_v12',[issuer,r.request_id,r.version]);
   await denied(approve(r,[scope('global',['read'])]),['40001']);
   await denied(rpc(owner,'clued_authorization_deny_v12',[issuer,personal.r.request_id,personal.r.version]),['40001']);
   const fresh=await prepare(),approver=await client('authenticated',U),denier=await client('authenticated',U);
   await approver.query('begin');await approve(fresh,[scope('global',['read'])],hash(),future(),approver);
   const pending=rpc(denier,'clued_authorization_deny_v12',[issuer,fresh.request_id,fresh.version]).then(()=>null,e=>e);
   for(let n=0;n<100;n++){const q=await admin.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[denier.processID]);if(q.rows.length)break;if(n===99)assert.fail('deny did not wait for consent commit');await new Promise(r=>setTimeout(r,10));}
   await approver.query('commit');assert.equal((await pending).code,'40001');
  });
  await t.test('issuer callback is revoke-only, bound to exact issuing authority, and idempotent',async()=>{
   const b=await create([scope('global',['read'])]),differentIssuer=hash();
   await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Other issuer')",[differentIssuer,resource]);
   await denied(rpc(anon,'clued_authorization_revoke_issuer_v12',[differentIssuer,b.binding_id]));
   assert.equal((await status(b)).active,true);
   const revoked=await rpc(anon,'clued_authorization_revoke_issuer_v12',[issuer,b.binding_id]);assert.equal(revoked.version,2);
   assert.equal((await rpc(anon,'clued_authorization_revoke_issuer_v12',[issuer,b.binding_id])).version,2);
   assert.equal((await status(personal)).active,true);
   await admin.query("update clued_private.authorization_issuers_v12 set revoked_at=now() where token_hash=$1",[differentIssuer]);
   await denied(prepare(request(),owner,differentIssuer));
  });
  await t.test('reclassification requires source and destination, not only target write permission',async()=>{
   const writer=await create([scope('global',['write'])]);
   const id=(await admin.query("select id from public.clued_memories where user_id=$1 and title='private project'",[U])).rows[0].id;
   await denied(rpc(anon,'clued_record_mutate',[writer.h,{operation:'reclassify_scope',id,scope:'global'}]));
   assert.equal((await admin.query("select scope from public.clued_memories where id=$1",[id])).rows[0].scope,'project');
  });

  await t.test('private helper privileges stay closed and profile consent is independent',async()=>{
   const exposed=(await admin.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_private' and (p.proname like 'authorization_%_v12' or p.proname like 'context_execute%' or p.proname='resolve_binding_action_v12') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute'))")).rows;
   assert.deepEqual(exposed,[]);
   const r=await prepare(request(['context:read']));assert.ok(r.eligible.some(e=>e.resource_id==='profile'));
   const p=await create([scope('profile',['read'])]);
   await denied(rpc(anon,'clued_record_list',[p.h,{level:'global',record_type:'note'}]));
   assert.equal((await status(p)).active,true);
  });

  await t.test('account suspension is checked live and serialized against the business transaction',async()=>{
   await admin.query('alter table auth.users add column banned_until timestamptz');
   const b=await create([ctx(cid,['write'])]),writer=await client('anon'),banner=await client('postgres');
   await banner.query('begin');await banner.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[U]);
   const pending=call(b,{op:'record_put',record_type:'note',body:{content:'must fail when banned'},idempotency_key:key()},writer).then(()=>null,e=>e);
   for(let n=0;n<100;n++){const q=await admin.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[writer.processID]);if(q.rows.length)break;if(n===99)assert.fail('business call did not wait for current account state');await new Promise(r=>setTimeout(r,10));}
   await banner.query('commit');assert.equal((await pending).code,'42501');
   assert.equal((await status(b)).active,false);
   await denied(prepare());await denied(rpc(owner,'clued_user_project_list',[{}]));
   assert.equal((await admin.query("select count(*)::int n from clued_private.development_records_v14 where body->>'content'='must fail when banned'")).rows[0].n,0);
   await admin.query('update auth.users set banned_until=null where id=$1',[U]);
   assert.equal((await status(b)).active,true);
  });
  await t.test('current project qualification is locked, with no stale owner grant after commit',async()=>{
   const b=await create([scope('project:'+P,['read'])]),reader=await client('anon'),changer=await client('postgres');
   await changer.query('begin');await changer.query('update public.clued_projects set user_id=$1 where id=$2',[V,P]);
   const pending=rpc(reader,'clued_record_list',[b.h,{level:'project',project_id:P,record_type:'note'}]).then(()=>null,e=>e);
   for(let n=0;n<100;n++){const q=await admin.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[reader.processID]);if(q.rows.length)break;if(n===99)assert.fail('reader did not wait for current ownership');await new Promise(r=>setTimeout(r,10));}
   await changer.query('commit');assert.equal((await pending).code,'42501');
   await admin.query('update public.clued_projects set user_id=$1 where id=$2',[U,P]);
  });

  await t.test('decision replacement cannot smuggle project sources through missing or forged global scope',async()=>{
   const id=key(),globalWriter=await create([scope('global',['write'])]);
   await admin.query("insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,record_key,status,record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Project source','Synthetic','project',$3,'decision','supersede-source','active',1,'active',$4,'{\"rationale\":\"Probe\"}','{}','{}','user_explicit','Explicit test')",[id,U,P,'project:'+P]);
   const input={idempotency_key:key(),source_decisions:[{id,base_version:1}],supersede_reason:'Independent boundary probe',user_confirmed:true,replacement:{title:'Replacement',content:'Synthetic',record_schema_version:1,type_fields:{rationale:'Probe'},relations:{supersedes:[id]},authority:'user_explicit',source_refs:[],source_unavailable_reason:null,confidence_reason:'Explicit isolated test'}};
   const counts=async()=>(await admin.query('select (select count(*)::int from public.clued_memories) records,(select count(*)::int from public.clued_context_events) events,(select count(*)::int from public.clued_audit_receipts) receipts')).rows[0];
   const before=await counts();
   await denied(rpc(anon,'clued_decision_supersede',[globalWriter.h,input]),['22023']);
   await denied(rpc(anon,'clued_decision_supersede',[globalWriter.h,{...input,replacement:{...input.replacement,scope:'global'}}]));
   assert.deepEqual(await counts(),before);
   assert.equal((await admin.query('select lifecycle_status from public.clued_memories where id=$1',[id])).rows[0].lifecycle_status,'active');
   const projectWriter=await create([scope('project:'+P,['write'])]);
   const allowed=await rpc(anon,'clued_decision_supersede',[projectWriter.h,{...input,replacement:{...input.replacement,scope:'project:'+P}}]);
   assert.equal(allowed.status,'committed');
   assert.equal((await admin.query('select lifecycle_status from public.clued_memories where id=$1',[id])).rows[0].lifecycle_status,'superseded');
  });

  await t.test('canonical close/archive and restore are explicit permissions independent of write',async()=>{
   const writer=await create([scope('global',['write'])]),closer=await create([scope('global',['close'])]),restorer=await create([scope('global',['restore'])]);
   assert.deepEqual(closer.granted_scopes,['context:write']);assert.deepEqual(restorer.granted_scopes,['context:write']);
   const id=key(),base={id,scope:'global',record_type:'note',record_schema_version:1,authority:'user_explicit',user_confirmed:true,confidence_reason:'Explicit isolated action test'};
   const mutate=(b,input)=>rpc(anon,'clued_record_mutate',[b.h,{...base,idempotency_key:key(),...input}]);
   const created=await mutate(writer,{operation:'create',mutation:{title:'Lifecycle note',content:'Preserve this body',type_fields:{note_kind:'general'},relations:{}},source_refs:[],source_unavailable_reason:null});
   assert.equal(created.status,'committed',JSON.stringify(created));
   const close={operation:'close',base_version:1,lifecycle_status:'archived',mutation:{closure_summary:'Explicit archive',closed_reason:'Test'}};
   await denied(mutate(writer,close));
   await denied(mutate(restorer,close));
   await denied(mutate(closer,{...close,mutation:{content:'Smuggled edit',closed_reason:'Test'}}));
   const closed=await mutate(closer,close);assert.equal(closed.status,'committed',JSON.stringify(closed));
   const row=(await admin.query('select lifecycle_status,content,version from public.clued_memories where id=$1',[id])).rows[0];
   assert.equal(row.lifecycle_status,'archived');assert.equal(row.content,'Preserve this body');assert.equal(Number(row.version),2);
   const restore={operation:'restore',base_version:2,mutation:{}};
   await denied(mutate(writer,restore));await denied(mutate(closer,restore));
   const restored=await mutate(restorer,restore);assert.equal(restored.status,'committed',JSON.stringify(restored));
   assert.equal((await admin.query('select lifecycle_status from public.clued_memories where id=$1',[id])).rows[0].lifecycle_status,'active');
   await denied(mutate(restorer,{operation:'update',base_version:3,mutation:{content:'Not allowed'}}));
   await denied(mutate(closer,{operation:'create',id:key(),mutation:{content:'Not allowed'}}));
   const both=await create([scope('global',['write','close','restore'])]);
   await manage({op:'reduce',binding_id:both.binding_id,base_version:1,selected:[scope('global',['write'])]});
   await denied(mutate(both,{...close,base_version:3}));
   await denied(rpc(anon,'clued_project_mutate',[writer.h,{operation:'close',canonical_project_id:P}]));
  });
  await t.test('context record revocation needs close; it never follows from write',async()=>{
   const writer=await create([ctx(cid,['write'])]),closer=await create([ctx(cid,['close'])]);
   const r=(await call(writer,{op:'record_put',record_type:'note',body:{content:'Explicit revoke test'},idempotency_key:key()})).result;
   const revoke={op:'record_revoke',record_id:r.id,base_version:r.version,reason:'Explicit close',idempotency_key:key()};
   await denied(call(writer,revoke));
   await denied(call(closer,{op:'record_put',record_type:'note',body:{content:'No implicit write'},idempotency_key:key()}));
   await denied(call(closer,{op:'record_list',mode:'development_history'}));
   assert.equal((await call(closer,revoke)).result.lifecycle_status,'REVOKED');
   const eligible=(await prepare()).eligible.find(e=>e.resource_kind==='context'&&e.resource_id===cid);
   assert.ok(eligible.actions.includes('close'));assert.ok(!eligible.actions.includes('restore'));
   const readOnly=(await prepare(request(['context:read']))).eligible;
   assert.ok(readOnly.every(e=>!e.actions.includes('close')&&!e.actions.includes('restore')));
  });
 }finally{
  for(const db of clients.reverse())await db.end().catch(()=>{});await stopCluster(server);
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-auth-v12-'))throw Error('Unsafe test cleanup');
  await removeTestDirectory(target);
 }
});
