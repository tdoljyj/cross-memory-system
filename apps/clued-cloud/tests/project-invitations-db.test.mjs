// issuer-credentials: this historical test selects a migration chain before step 2b.
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

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration='20260907173032_clued_project_invitations_v13.sql';
const U='10000000-0000-4000-8000-000000000001', V='10000000-0000-4000-8000-000000000002';
const P='20000000-0000-4000-8000-000000000001';
const resource='https://mcp.example.invalid/mcp';
const key=()=>crypto.randomUUID(), hash=()=>crypto.randomBytes(32).toString('hex');
const future=()=>new Date(Date.now()+3600000).toISOString();
const scope=(id,actions)=>({resource_kind:'scope',resource_id:id,environment:'canonical',actions});
const ctx=(id,actions)=>({resource_kind:'context',resource_id:id,environment:'test',actions});
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('Project invitations v1.3: real PostgreSQL qualification and actor boundaries',{timeout:180000},async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clued-auth-v13-'));
 const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:hash(),port:await port(),persistent:false,postgresFlags:['-c','io_method=sync'],onLog(){},onError(m){process.stderr.write(m+'\n');}});
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

  const access=(input,db=owner)=>rpc(db,'clued_project_access_v13',[input]);
  const invite=(overrides={})=>access({op:'invite_create',project_id:P,environment:'test',target_email:'other@example.invalid',role:'editor',actions:['read','write','close','feedback_submit'],expires_at:future(),idempotency_key:key(),...overrides});
  await admin.query('alter table auth.users add column email_confirmed_at timestamptz');
  await admin.query('update auth.users set email_confirmed_at=now()');

  await t.test('human owner setup creates only owned development contexts with stable receipts',async()=>{
   for(const db of [anon,oldOAuth,service])await denied(rpc(db,'clued_development_owner_v14',[{op:'owner_list'}]));
   const empty=await rpc(other,'clued_development_owner_v14',[{op:'owner_list'}]);assert.equal(empty.projects.length,0);assert.equal(empty.contexts.length,0);
   const input={op:'context_create',project_id:P,name:'Owner setup fixture',environment:'preview',idempotency_key:key(),owner_id:V};
   await denied(rpc(other,'clued_development_owner_v14',[input]));
   const created=await rpc(owner,'clued_development_owner_v14',[input]),replayed=await rpc(owner,'clued_development_owner_v14',[input]);
   assert.equal(created.status,'committed');assert.equal(created.result.owner_id,U);assert.equal(created.result.cursor,0);assert.equal(created.result.version,1);assert.ok(created.result.created_at);
   assert.equal(replayed.receipt_id,created.receipt_id);assert.equal(replayed.replayed,true);
   const overview=await rpc(owner,'clued_development_owner_v14',[{op:'owner_list'}]);assert.ok(overview.projects.some(p=>p.id===P));assert.ok(overview.contexts.some(c=>c.id===created.result.id));
   const actor=(await admin.query('select actor_user_id from clued_private.development_operations_v14 where id=$1',[created.operation_id])).rows[0];assert.equal(actor.actor_user_id,U);
   await denied(rpc(owner,'clued_development_owner_v14',[{op:'record_put',context_id:cid,record_type:'note',body:{content:'Human JWT cannot replace business grant'},idempotency_key:key()}]));
   for(const op of ['link_upsert','accept','publish','publication_read'])await denied(rpc(owner,'clued_development_owner_v14',[{op,context_id:cid,idempotency_key:key()}]));
   assert.equal((await admin.query("select to_regprocedure('public.clued_context_call(text,jsonb)') old_call,to_regprocedure('public.clued_context_owner(jsonb)') old_owner")).rows[0].old_call,null);
   assert.equal((await admin.query("select to_regprocedure('public.clued_context_owner(jsonb)') old_owner")).rows[0].old_owner,null);
  });

  let invitation,membership;
  await t.test('owner invitations bind exact resources and verified recipient with truthful token replay',async()=>{
   await denied(access({op:'list'},anon));await denied(access({op:'list'},oldOAuth));await denied(access({op:'list'},service));
   await denied(invite({role:'admin'}),['22023']);
   const input={op:'invite_create',project_id:P,environment:'test',target_email:'other@example.invalid',role:'editor',actions:['read','write','close','feedback_submit'],expires_at:future(),idempotency_key:key()};
   invitation=await access(input);assert.ok(invitation.invite_token.startsWith('clued_inv_'));
   const retry=await access(input);assert.equal(retry.invitation_id,invitation.invitation_id);assert.equal(retry.replayed,true);assert.equal(retry.token_unavailable,true);assert.ok(!retry.invite_token);
   await denied(access({...input,role:'reader',actions:['read']}),['40001']);
   await denied(access({op:'invite_inspect',invite_token:invitation.invite_token}));
   const preview=await access({op:'invite_inspect',invite_token:invitation.invite_token},other);
   assert.equal(preview.project_id,P);assert.equal(preview.environment,'test');assert.ok(!('target_email'in preview));
   const accept={op:'invite_accept',invite_token:invitation.invite_token,base_version:preview.version,idempotency_key:key(),role:'admin'};
   membership=await access(accept,other);assert.equal(membership.role,'editor');assert.equal(membership.project_id,P);
   assert.equal((await access(accept,other)).membership_id,membership.membership_id);
   await denied(access({...accept,idempotency_key:key()},other));
   await denied(access({op:'invite_create',project_id:P,environment:'test',target_email:'owner@example.invalid',role:'reader',actions:['read'],expires_at:future(),idempotency_key:key()},other));
   const list=await access({op:'list'},other);assert.equal(list.memberships[0].membership_id,membership.membership_id);assert.equal(list.owned_projects.length,0);
  });
  await t.test('a new developer verifies email and accepts without creating any personal memory',async()=>{
   const incoming=await invite({target_email:'new-developer@example.invalid',role:'reader',actions:['read']});
   const N=key();await admin.query("insert into auth.users(id,email) values($1,'new-developer@example.invalid')",[N]);
   const newcomer=await client('authenticated',N);
   await denied(access({op:'invite_inspect',invite_token:incoming.invite_token},newcomer));
   await admin.query('update auth.users set email_confirmed_at=now() where id=$1',[N]);
   const info=await access({op:'invite_inspect',invite_token:incoming.invite_token},newcomer);
   const accepted=await access({op:'invite_accept',invite_token:incoming.invite_token,base_version:info.version,idempotency_key:key()},newcomer);
   assert.equal(accepted.role,'reader');assert.deepEqual(accepted.actions,['read']);
   assert.equal((await admin.query('select count(*)::int n from public.clued_memories where user_id=$1',[N])).rows[0].n,0);
  });
  await t.test('membership actions only shrink with CAS; revoke never becomes self-service grant',async()=>{
   await denied(access({op:'member_reduce',membership_id:membership.membership_id,base_version:1,actions:['read','publish'],idempotency_key:key()}));
   await denied(access({op:'member_reduce',membership_id:membership.membership_id,base_version:2,actions:['read'],idempotency_key:key()}),['40001']);
   const reduced=await access({op:'member_reduce',membership_id:membership.membership_id,base_version:1,actions:['read'],idempotency_key:key()});
   assert.equal(reduced.version,2);assert.deepEqual(reduced.actions,['read']);
   await denied(access({op:'member_reduce',membership_id:membership.membership_id,base_version:2,actions:['read','write'],idempotency_key:key()}));
   await denied(access({op:'member_revoke',membership_id:membership.membership_id,base_version:2,idempotency_key:key()},other));
   const revoked=await access({op:'member_revoke',membership_id:membership.membership_id,base_version:2,idempotency_key:key()});assert.ok(revoked.revoked_at);
   const second=await invite({role:'reader',actions:['read']});
   const accepted=await access({op:'invite_accept',invite_token:second.invite_token,base_version:second.version,idempotency_key:key()},other);
   assert.notEqual(accepted.membership_id,membership.membership_id);
  });

  let readerBinding,editorBinding,editorMembership;
  const memberConnection=async(actions)=>{
   const prepared=await prepare(request(['context:read','context:write']),other);
   const row=prepared.eligible.find(e=>e.resource_id===cid);assert.ok(row?.qualification_id);
   assert.ok(!prepared.eligible.some(e=>e.resource_kind==='scope'&&e.resource_id==='project:'+P));
   const h=hash(),expires=future(),approved=await approve(prepared,[ctx(cid,actions)],h,expires,other);
   return {h,...approved};
  };
  await t.test('invited reader uses actual actor identity and only the exact development context',async()=>{
   const ownerWriter=await create([ctx(cid,['write'])]);
   await call(ownerWriter,{op:'record_put',record_type:'note',body:{content:'Owner development record'},idempotency_key:key()});
   readerBinding=await memberConnection(['read']);
   const list=await call(readerBinding,{op:'context_list',mode:'development_history'});assert.equal(list.contexts.length,1);assert.equal(list.contexts[0].id,cid);
   assert.equal((await call(readerBinding,{op:'record_list',mode:'development_history'})).records[0].body.content,'Owner development record');
   await denied(call(readerBinding,{op:'record_put',record_type:'note',body:{content:'Reader cannot edit'},idempotency_key:key()}));
   await denied(call(readerBinding,{op:'record_list',mode:'development_history',environment:'production'}));
   await denied(call(readerBinding,{op:'publish',idempotency_key:key()}));
   await denied(rpc(anon,'clued_record_list',[readerBinding.h,{level:'global'}]));
   await denied(rpc(anon,'clued_record_list',[readerBinding.h,{level:'project',project_id:P}]));
   await denied(rpc(other,'clued_development_owner_v14',[{op:'grant_upsert',context_id:cid,binding_id:readerBinding.binding_id,actions:['write'],idempotency_key:key()}]));
   const overview=await manage({op:'list'},other);const x=overview.bindings.find(b=>b.binding_id===readerBinding.binding_id);
   assert.ok(x.created_at);assert.equal(x.last_used_at,null);assert.deepEqual(x.grants[0].effective_actions,['read']);
  });
  await t.test('member revoke/reinvite never revives an old Binding; editor writes preserve true owner and actor',async()=>{
   const pendingBeforeRevocation=await prepare(request(),other);
   const current=(await access({op:'list'},other)).memberships.find(m=>!m.revoked_at);
   await access({op:'member_revoke',membership_id:current.membership_id,base_version:current.version,idempotency_key:key()});
   await denied(call(readerBinding,{op:'record_list',mode:'development_history'}));
   const newInvite=await invite();
   editorMembership=await access({op:'invite_accept',invite_token:newInvite.invite_token,base_version:newInvite.version,idempotency_key:key()},other);
   await denied(call(readerBinding,{op:'record_list',mode:'development_history'}));
   await denied(approve(pendingBeforeRevocation,[{...ctx(cid,['read']),qualification_id:editorMembership.membership_id}],hash(),future(),other));
   editorBinding=await memberConnection(['read','write','close','feedback_submit']);
   const input={op:'record_put',record_type:'note',body:{content:'Actual invited editor'},idempotency_key:key(),owner_id:V,actor_user_id:U};
   const written=await call(editorBinding,input);assert.equal(written.status,'committed');assert.equal(written.actor_user_id,V);assert.equal(written.resource_owner_id,U);
   assert.equal(written.result.actor_binding_id,editorBinding.binding_id);
   const operation=(await admin.query('select owner_id,actor_user_id,binding_ref from clued_private.development_operations_v14 where id=$1',[written.operation_id])).rows[0];
   assert.deepEqual(operation,{owner_id:U,actor_user_id:V,binding_ref:editorBinding.binding_id});
   const replay=await call(editorBinding,input);assert.equal(replay.receipt_id,written.receipt_id);assert.equal(replay.replayed,true);
   assert.equal((await admin.query('select count(*)::int n from clued_private.development_record_versions_v14 where record_id=$1',[written.result.id])).rows[0].n,1);
   assert.equal((await admin.query('select id from clued_private.development_events_with_actor_v14 where operation_id=$1',[written.operation_id])).rows[0].id,written.event_id);
   assert.equal((await admin.query('select count(*)::int n from public.clued_memories where user_id=$1',[V])).rows[0].n,0);
   await denied(call(editorBinding,{op:'accept',idempotency_key:key()}));
   await denied(call(editorBinding,{op:'grant_upsert',idempotency_key:key()}));
   const oldOverview=(await manage({op:'list'},other)).bindings.find(b=>b.binding_id===readerBinding.binding_id);
   assert.deepEqual(oldOverview.grants[0].actions,['read']);assert.deepEqual(oldOverview.grants[0].effective_actions,[]);
  });


  await t.test('separate close and feedback consent preserves real actors and own feedback only',async()=>{
   const writer=await memberConnection(['write']),closer=await memberConnection(['close']),feedback=await memberConnection(['feedback_submit']),sibling=await memberConnection(['feedback_submit']);
   const written=await call(writer,{op:'record_put',record_type:'note',body:{content:'Separate close consent'},idempotency_key:key()});
   await denied(call(writer,{op:'record_revoke',record_id:written.result.id,base_version:1,reason:'No close consent',idempotency_key:key()}));
   await denied(call(closer,{op:'record_put',record_type:'note',body:{content:'No write consent'},idempotency_key:key()}));
   const closeInput={op:'record_revoke',record_id:written.result.id,base_version:1,reason:'Explicit closure',idempotency_key:key()};
   const closed=await call(closer,closeInput),closeReplay=await call(closer,closeInput);
   assert.deepEqual(Object.keys(closed.result).sort(),['actor_binding_id','context_id','id','lifecycle_status','revision_cursor','version']);
   assert.deepEqual(closeReplay.result,closed.result);assert.equal(closeReplay.receipt_id,closed.receipt_id);
   assert.equal(closed.result.actor_binding_id,closer.binding_id);assert.equal(closed.actor_user_id,V);assert.equal(closed.result.lifecycle_status,'REVOKED');
   const submitted=await call(feedback,{op:'feedback_submit',body:{message:'Own test feedback'},idempotency_key:key()});
   assert.deepEqual((await admin.query('select scopes from public.clued_agent_bindings where id=$1',[feedback.binding_id])).rows[0].scopes,['context:write']);
   assert.equal((await call(feedback,{op:'feedback_list'})).feedback[0].id,submitted.result.id);
   assert.equal((await call(sibling,{op:'feedback_list'})).feedback.length,0);
   await denied(call(sibling,{op:'feedback_withdraw',feedback_id:submitted.result.id,base_version:1,idempotency_key:key()}));
   await denied(call(feedback,{op:'record_list',mode:'development_history'}));
   await call(feedback,{op:'feedback_withdraw',feedback_id:submitted.result.id,base_version:1,idempotency_key:key()});
   const ownFeedback=(await call(feedback,{op:'feedback_list'})).feedback[0];assert.equal(ownFeedback.state,'withdrawn');assert.deepEqual(ownFeedback.body,{});
  });

  await t.test('owned context feedback and closure follow the same explicit action semantics',async()=>{
   const writer=await create([ctx(cid,['write'])]),closer=await create([ctx(cid,['close'])]),feedback=await create([ctx(cid,['feedback_submit'])]);
   const written=await call(writer,{op:'record_put',record_type:'note',body:{content:'Owner close actor fixture'},idempotency_key:key()});
   const closeInput={op:'record_revoke',record_id:written.result.id,base_version:1,reason:'Owner close explicitly allowed',idempotency_key:key()};
   const closed=await call(closer,closeInput),closeReplay=await call(closer,closeInput);
   assert.deepEqual(Object.keys(closed.result).sort(),['actor_binding_id','context_id','id','lifecycle_status','revision_cursor','version']);
   assert.deepEqual(closeReplay.result,closed.result);assert.equal(closeReplay.receipt_id,closed.receipt_id);
   assert.equal(closed.result.actor_binding_id,closer.binding_id);
   const f=await call(feedback,{op:'feedback_submit',body:{message:'Owner own feedback'},idempotency_key:key()});
   assert.equal((await call(feedback,{op:'feedback_list'})).feedback[0].id,f.result.id);
  });

  await t.test('context-only restore is a scoped capability projection without Canonical sessions or checkpoints',async()=>{
   const b=await memberConnection(['read']);
   const before=(await admin.query('select (select count(*) from public.clued_continuity_sessions)::int sessions,(select count(*) from public.clued_context_streams)::int streams,(select count(*) from public.clued_audit_receipts)::int receipts')).rows[0];
   const restored=await rpc(anon,'clued_mcp_restore',[b.h,{}]);
   assert.equal(restored.status,'scoped_context_ready');assert.equal(restored.session_resumed,false);assert.equal(restored.session_checkpoint_supported,false);
   assert.deepEqual(restored.authorized_contexts.map(c=>c.context_id),[cid]);assert.equal(restored.authorized_contexts[0].project_id,P);
   assert.ok(!('session_token'in restored));assert.ok(!('snapshot'in restored));assert.ok(!('work_log'in restored));
   assert.deepEqual(restored.sources_read,['context:'+cid+':authorization_metadata']);
   const exact=await rpc(anon,'clued_mcp_restore',[b.h,{context_key:'project:'+P}]);assert.equal(exact.authorized_contexts.length,1);
   await denied(rpc(anon,'clued_mcp_restore',[b.h,{context_key:'project:'+key()}]));
   await denied(rpc(anon,'clued_mcp_restore',[b.h,{context_key:'profile'}]));
   const writeOnly=await memberConnection(['write']);await denied(rpc(anon,'clued_mcp_restore',[writeOnly.h,{}]));
   const after=(await admin.query('select (select count(*) from public.clued_continuity_sessions)::int sessions,(select count(*) from public.clued_context_streams)::int streams,(select count(*) from public.clued_audit_receipts)::int receipts')).rows[0];assert.deepEqual(after,before);
   await rpc(anon,'clued_authorization_revoke_self_v12',[b.h]);await denied(rpc(anon,'clued_mcp_restore',[b.h,{}]));
   const canonical=await create([scope('global',['read'])]);
   const legacy=await rpc(anon,'clued_mcp_restore',[canonical.h,{}]);assert.ok(['empty','restored'].includes(legacy.status));assert.ok(legacy.session_token);
  });
  await t.test('owner grant revocation removes displayed effective capabilities and scoped restore',async()=>{
   const b=await memberConnection(['read','write']);
   const g=(await admin.query('select id,version from clued_private.development_grants_v14 where binding_id=$1 and context_id=$2',[b.binding_id,cid])).rows[0];
   await own({op:'grant_revoke',context_id:cid,grant_id:g.id,base_version:Number(g.version)});
   await denied(call(b,{op:'record_list',mode:'development_history'}));
   const list=await call(b,{op:'context_list',mode:'development_history'});assert.equal(list.contexts.length,0);
   const view=(await manage({op:'list'},other)).bindings.find(x=>x.binding_id===b.binding_id).grants[0];
   assert.deepEqual(view.actions.sort(),['read','write']);assert.deepEqual(view.effective_actions,[]);
   await denied(rpc(anon,'clued_mcp_restore',[b.h,{}]));
  });


  await t.test('invited development history uses existing after_cursor and exact environment filtering',async()=>{
   const b=await memberConnection(['read','write']);
   await call(b,{op:'record_put',record_type:'note',body:{content:'Pagination next record'},idempotency_key:key()});
   const first=await call(b,{op:'record_list',mode:'development_history',limit:1});
   const next=await call(b,{op:'record_list',mode:'development_history',limit:1,after_cursor:first.next_cursor});
   assert.equal(first.records.length,1);assert.equal(next.records.length,1);assert.notEqual(first.records[0].id,next.records[0].id);
   assert.ok(next.records[0].created_cursor>first.records[0].created_cursor);
   assert.equal((await call(b,{op:'context_list',mode:'development_history',environment:'production'})).contexts.length,0);
  });

  const waitLock=async(db,label)=>{for(let n=0;n<150;n++){const q=await admin.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[db.processID]);if(q.rows.length)return;await new Promise(r=>setTimeout(r,10));}assert.fail(label);};
  await t.test('qualification reduction waits for prior business commit, then immediately removes write',async()=>{
   const writer=await client('anon'),reducer=await client('authenticated',U);
   await writer.query('begin');
   const written=await call(editorBinding,{op:'record_put',record_type:'note',body:{content:'Before membership reduction'},idempotency_key:key()},writer);
   let done=false;
   const reducing=access({op:'member_reduce',membership_id:editorMembership.membership_id,base_version:1,actions:['read'],idempotency_key:key()},reducer).then(r=>{done=true;return r;});
   await waitLock(reducer,'member reduction must wait for authorized business commit');assert.equal(done,false);
   await writer.query('commit');const reduced=await reducing;editorMembership.version=reduced.version;
   assert.equal((await admin.query('select count(*)::int n from clued_private.development_operations_v14 where receipt_id=$1',[written.receipt_id])).rows[0].n,1);
   await denied(call(editorBinding,{op:'record_put',record_type:'note',body:{content:'After reduction denied'},idempotency_key:key()}));
   assert.ok((await call(editorBinding,{op:'record_list',mode:'development_history'})).records.length>=2);
   const summary=(await manage({op:'list'},other)).bindings.find(b=>b.binding_id===editorBinding.binding_id).grants[0];
   assert.ok(summary.actions.includes('write'));assert.deepEqual(summary.effective_actions,['read']);
  });
  await t.test('qualification revocation committed first blocks a queued write without side effects',async()=>{
   await access({op:'member_revoke',membership_id:editorMembership.membership_id,base_version:editorMembership.version,idempotency_key:key()});
   const i=await invite();const m=await access({op:'invite_accept',invite_token:i.invite_token,base_version:i.version,idempotency_key:key()},other);
   const b=await memberConnection(['read','write']);
   const revoker=await client('authenticated',U),writer=await client('anon');
   await revoker.query('begin');await access({op:'member_revoke',membership_id:m.membership_id,base_version:1,idempotency_key:key()},revoker);
   const pending=call(b,{op:'record_put',record_type:'note',body:{content:'Must not write revoked project'},idempotency_key:key()},writer).then(()=>null,e=>e);
   await waitLock(writer,'member write must wait for the membership revocation');
   await revoker.query('commit');assert.equal((await pending).code,'42501');
   assert.equal((await admin.query("select count(*)::int n from clued_private.development_records_v14 where body->>'content'='Must not write revoked project'")).rows[0].n,0);
   await denied(call(editorBinding,{op:'record_list',mode:'development_history'}));
  });
  await t.test('invitation expiry, verified identity change and cancel/accept races fail closed',async()=>{
   const T=key();await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'racing-developer@example.invalid',now())",[T]);
   const recipient=await client('authenticated',T),owner2=await client('authenticated',U);
   const inviteRace=()=>invite({target_email:'racing-developer@example.invalid',role:'reader',actions:['read']});
   const expired=await inviteRace();await admin.query("update clued_private.project_invitations_v13 set expires_at=now()-interval '1 second' where id=$1",[expired.invitation_id]);
   await denied(access({op:'invite_inspect',invite_token:expired.invite_token},recipient));
   const wrongIdentity=await inviteRace();await admin.query("update auth.users set email='changed-developer@example.invalid' where id=$1",[T]);
   await denied(access({op:'invite_inspect',invite_token:wrongIdentity.invite_token},recipient));
   await admin.query("update auth.users set email='racing-developer@example.invalid' where id=$1",[T]);
   const cancelled=await inviteRace();await owner2.query('begin');
   await access({op:'invite_revoke',invitation_id:cancelled.invitation_id,base_version:1,idempotency_key:key()},owner2);
   const accepting=access({op:'invite_accept',invite_token:cancelled.invite_token,base_version:1,idempotency_key:key()},recipient).then(()=>null,e=>e);
   await waitLock(recipient,'accept waits for cancel');await owner2.query('commit');assert.equal((await accepting).code,'42501');
   const accepted=await inviteRace();await recipient.query('begin');
   await access({op:'invite_accept',invite_token:accepted.invite_token,base_version:1,idempotency_key:key()},recipient);
   const cancelling=access({op:'invite_revoke',invitation_id:accepted.invitation_id,base_version:1,idempotency_key:key()},owner2).then(()=>null,e=>e);
   await waitLock(owner2,'cancel waits for acceptance');await recipient.query('commit');assert.equal((await cancelling).code,'40001');
  });


  await t.test('queued member work validates context ownership after the ownership change commits',async()=>{
   const i=await invite();await access({op:'invite_accept',invite_token:i.invite_token,base_version:i.version,idempotency_key:key()},other);
   const b=await memberConnection(['read','write']),changer=await client('postgres'),writer=await client('anon');
   await changer.query('begin');await changer.query('update clued_private.development_spaces_v14 set owner_id=$1 where id=$2',[V,cid]);
   const queued=call(b,{op:'record_put',record_type:'note',body:{content:'Forbidden after context owner changed'},idempotency_key:key()},writer).then(()=>null,e=>e);
   await waitLock(writer,'member must wait for locked context ownership');await changer.query('commit');
   assert.equal((await queued)?.code,'42501');
   assert.equal((await admin.query("select count(*)::int n from clued_private.development_records_v14 where body->>'content'='Forbidden after context owner changed'")).rows[0].n,0);
   await admin.query('update clued_private.development_spaces_v14 set owner_id=$1 where id=$2',[U,cid]);
  });

  await t.test('offline administrator bootstrap is one-time, audited and never grants project or memory access',async()=>{
   const bootstrap=db=>db.query('call clued_private.platform_admin_bootstrap_v13($1,$2,$3)',[U,'isolated-operator-evidence','Explicit isolated bootstrap']);
   for(const db of [anon,owner,other,service])await denied(bootstrap(db));
   await admin.query('update auth.users set email_confirmed_at=null where id=$1',[V]);
   await denied(admin.query('call clued_private.platform_admin_bootstrap_v13($1,$2,$3)',[V,'isolated-operator-evidence','Unverified target rejected']));
   await admin.query('update auth.users set email_confirmed_at=now() where id=$1',[V]);
   await bootstrap(admin);await denied(bootstrap(admin),['40001']);
   const recovery=db=>db.query('call clued_private.platform_admin_recover_v13($1,$2,$3,$4)',[V,1,'isolated-recovery-evidence','Operator verified recovery']);
   for(const db of [anon,owner,other,service])await denied(recovery(db));
   const before=(await admin.query('select (select count(*) from public.clued_memories)::int memories,(select count(*) from clued_private.project_memberships_v13)::int memberships,(select count(*) from public.clued_agent_bindings)::int bindings')).rows[0];
   await denied(admin.query('call clued_private.platform_admin_recover_v13($1,$2,$3,$4)',[V,2,'isolated-recovery-evidence','Stale recovery version']),['40001']);
   await recovery(admin);await denied(recovery(admin),['40001']);
   const after=(await admin.query('select (select count(*) from public.clued_memories)::int memories,(select count(*) from clued_private.project_memberships_v13)::int memberships,(select count(*) from public.clued_agent_bindings)::int bindings')).rows[0];assert.deepEqual(after,before);
   const rows=(await admin.query('select operation,old_subject_id,new_subject_id,version,operator_role,session_role from clued_private.platform_admin_audit_v13 order by version')).rows;
   assert.equal(rows.length,2);assert.equal(rows[0].operation,'bootstrap');assert.equal(rows[0].old_subject_id,null);
   assert.equal(rows[1].operation,'recover');assert.equal(rows[1].old_subject_id,U);assert.equal(rows[1].new_subject_id,V);
   assert.equal(rows[1].operator_role,'postgres');assert.equal(rows[1].session_role,'postgres');
   await denied(access({op:'invite_create',project_id:P,environment:'test',target_email:'stranger@example.invalid',role:'reader',actions:['read'],expires_at:future(),idempotency_key:key()},other));
  });


  await t.test('a historical context owner loses access when current project ownership changes',async()=>{
   const b=await create([ctx(cid,['read'])]);
   await admin.query('update public.clued_projects set user_id=$1 where id=$2',[V,P]);
   await denied(call(b,{op:'record_list',mode:'development_history'}));
   const overview=await rpc(owner,'clued_development_owner_v14',[{op:'owner_list'}]);assert.ok(!overview.contexts.some(c=>c.id===cid));
   await admin.query('update public.clued_projects set user_id=$1 where id=$2',[U,P]);
  });

  await t.test('invitation secrets and private actor helpers are not public data',async()=>{
   for(const db of [anon,owner,other,service]){
    await denied(db.query('select * from clued_private.project_memberships_v13'));
    await denied(db.query('select * from clued_private.project_access_requests_v13'));
   }
   const grants=(await admin.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='clued_private' and (p.proname like '%_v13' or p.proname like 'development_%_v14') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute'))")).rows;
   assert.deepEqual(grants,[]);
   assert.equal((await admin.query("select count(*)::int n from clued_private.project_access_requests_v13 where result::text like '%clued_inv_%'")).rows[0].n,0);
   const stored=(await admin.query('select token_hash from clued_private.project_invitations_v13 where id=$1',[invitation.invitation_id])).rows[0].token_hash;
   assert.equal(stored,crypto.createHash('sha256').update(invitation.invite_token).digest('hex'));
  });
 }finally{
  for(const db of clients.reverse())await db.end().catch(()=>{});await stopCluster(server);
  const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-auth-v13-'))throw Error('Unsafe test cleanup');
  await removeTestDirectory(target);
 }
});
