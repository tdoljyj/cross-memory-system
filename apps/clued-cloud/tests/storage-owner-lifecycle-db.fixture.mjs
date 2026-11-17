import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import DefaultEmbeddedPostgres from 'embedded-postgres';
import {allowTestIssuerCredentials} from './issuer-credentials-fixture.mjs';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {findGatewayCloseoutMigration,assertGatewayCloseoutBoundary,snapshotCallerCatalog, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';
const runtime=createRequire(process.env.CLUED_POSTGRES_TEST_RUNTIME || import.meta.url);
const EmbeddedPostgres=process.env.CLUED_POSTGRES_TEST_RUNTIME
  ?(await import(pathToFileURL(runtime.resolve('embedded-postgres')))).default:DefaultEmbeddedPostgres;
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),id=()=>crypto.randomUUID();
const envelope=()=>({contract:'clued.storage-credential/1',key_id:'synthetic',nonce:'N'.repeat(16),ciphertext:'X'.repeat(64)});
const rpcName='public.clued_storage_owner_lifecycle_v1(text,jsonb)';
const wholeRootMigration='20261010150000_storage_owner_root_trash_scope_v2.sql';
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('Native owner lifecycle, real migrations and synthetic Google observations',{timeout:240000},async t=>{
  const tempParent=await fs.realpath(os.tmpdir());
  const dir=await fs.mkdtemp(path.join(tempParent,'clued-owner-lifecycle-'));
  const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:sha(id()),port:await port(),persistent:true,
    postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog(){},onError(){}});
  const clients=[];let started=false;
  try{
    await server.initialise();await server.start();started=true;
    const db=server.getPgClient();clients.push(db);await db.connect();
    const pgVersion=(await db.query('show server_version')).rows[0].server_version;
    console.log('Synthetic Native lifecycle PostgreSQL:',pgVersion);
    await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    let wholeRootPreMasterDefinition,reconnectRetryPredecessorDefinition,reconnectRefreshPredecessorDefinition,demandRuntimePredecessorDefinition,demandRuntimeSuccessorWorkerDefinition;
    const renewalSignatures=['clued_private.ii_pub_clued_storage_refresh_worker_v1(text,jsonb)','clued_private.clued_storage_refresh_manage_v1(jsonb)'];
    const renewalPredecessors=[];
    for(const file of (await fs.readdir(path.join(cloud,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()){
      if(file.endsWith('_storage_master_control_v1.sql'))wholeRootPreMasterDefinition=(await db.query('select pg_get_functiondef($1::regprocedure) def',[rpcName])).rows[0].def;
      if(file.endsWith('_storage_reconnect_retry_v1.sql'))reconnectRetryPredecessorDefinition=(await db.query('select pg_get_functiondef($1::regprocedure) def',[rpcName])).rows[0].def;
      if(file.endsWith('_storage_reconnect_refresh_default_v1.sql'))reconnectRefreshPredecessorDefinition=(await db.query('select pg_get_functiondef($1::regprocedure) def',[rpcName])).rows[0].def;
      if(file.endsWith('_storage_demand_refresh_runtime_v1.sql'))demandRuntimePredecessorDefinition=(await db.query('select pg_get_functiondef($1::regprocedure) def',[rpcName])).rows[0].def;
      if(file.endsWith('_storage_refresh_intent_v1.sql'))for(const signature of renewalSignatures)
        renewalPredecessors.push((await db.query('select pg_get_functiondef($1::regprocedure) def',[signature])).rows[0].def);
      try{await db.query(await fs.readFile(path.join(cloud,'supabase/migrations',file),'utf8'));}catch(e){throw new Error('Migration '+file+': '+e.message,{cause:e});}
      if(file.endsWith('_storage_demand_refresh_runtime_v1.sql'))demandRuntimeSuccessorWorkerDefinition=(await db.query('select pg_get_functiondef($1::regprocedure) def',[renewalSignatures[0]])).rows[0].def;
    }
    const closeout=await findGatewayCloseoutMigration(cloud);
    await assertGatewayCloseoutBoundary(db);
    const callerCatalog=await snapshotCallerCatalog(db);
    await replayGatewayCloseout(db, await fs.readFile(path.join(cloud,'supabase/migrations',closeout),'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(db),callerCatalog,'formal G6 replay preserves Native V1/V2 definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(db);
    await allowTestIssuerCredentials(db);
    await allowRawTestBindings(db);
    const owner=id(),session=id(),otherOwner=id(),otherSession=id(),secret=sha(id()),proof=sha(secret),client='lifecycle.apps.googleusercontent.com';
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@synthetic.invalid',now()),($2,'other@synthetic.invalid',now())",[owner,otherOwner]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4)',[session,owner,otherSession,otherOwner]);
    await db.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled,execution_enabled) values($1,$2,'https://lifecycle.invalid/storage/google/callback',true,true)",[proof,client]);
    await db.query('insert into clued_private.storage_onboard_allowlist_v1(owner_id) values($1)',[owner]);
    const login=async(c,u=owner,s=session)=>c.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[u,JSON.stringify({sub:u,role:'authenticated',session_id:s})]);
    const native=server.getPgClient();clients.push(native);await native.connect();await native.query('set role authenticated');await login(native);
    const call=async(input,c=native,p=proof)=>(await c.query('select public.clued_storage_owner_lifecycle_v1($1,$2::jsonb) v',[p,JSON.stringify(input)])).rows[0].v;
    const onboard=async input=>(await native.query('select public.clued_storage_onboard_v1($1,$2::jsonb) v',[secret,JSON.stringify(input)])).rows[0].v;
    const callback=async input=>(await native.query('select public.clued_storage_oauth_callback_v2($1,$2::jsonb) v',[secret,JSON.stringify(input)])).rows[0].v;
    const outer=async input=>(await native.query('select public.clued_storage_oauth_v1($1,$2::jsonb) v',[proof,JSON.stringify(input)])).rows[0].v;
    async function root(picked=false){
      const attempt=id(),oa=id(),connection=id(),rootId='root-'+id(),name='Synthetic '+id().slice(0,8),state=sha(id());
      const text=`Clued 使用你 Google 云端硬盘中的「${name}」作为资料根目录。`;
      await onboard({action:'begin',owner_id:owner,onboard_attempt_id:attempt,oauth_attempt_id:oa,connection_id:connection,state_hash:state,
        verifier_envelope:envelope(),root:picked?{mode:'picked',name,folder_id:rootId}:{mode:'new',name},tracks:['资料'],
        normal_use_requested:false,default_refresh_requested:false,disclosure_version:'clued.storage-onboard-disclosure/1',disclosure_text:text,disclosure_sha256:sha(text)});
      await callback({action:'claim',state_hash:state});
      const staged=await onboard({action:'stage_credential',state_hash:state,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:'legacy'});
      const run={onboard_attempt_id:attempt,run_token:staged.run_token};
      if(!picked)await onboard({action:'effect_intent',...run,role:'root'});
      await onboard({action:'effect_result',...run,role:'root',provider_file_id:rootId,version:'3',parents:['my-drive'],created:!picked});
      await onboard({action:'effect_intent',...run,role:'track:资料'});
      await onboard({action:'effect_result',...run,role:'track:资料',provider_file_id:'track-'+id(),version:'1',parents:[rootId],created:true});
      const result=await onboard({action:'activate',...run,ancestors:['my-drive']});assert.equal(result.status,'completed');
      return {connection,rootId,profile:result.profile_id,project:result.project_id};
    }
    const row=async connection=>(await db.query('select * from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0];
    const listing=async()=>await call({action:'list'});
    const connectionInput=async connection=>{const c=(await listing()).connections.find(c=>c.id===connection);return {connection_id:c.id,base_version:c.version,profile_version:c.profile_version};};
    const confirm=(r,more)=>({contract:'clued.storage-owner-confirmation/1',root_folder_id:r.rootId,confirmed:true,...more});
    const disconnect=async connection=>{const c=await row(connection);return (await native.query('select public.clued_storage_owner_manage_v2($1::jsonb) v',[JSON.stringify({action:'disconnect',connection_id:connection,base_version:Number(c.version),idempotency_key:id()})])).rows[0].v;};
    await t.test('gateway stays 80; only authenticated can call; live Native session and active issuer both mandatory',async()=>{
      await assertGatewayCloseoutBoundary(db);
      for(const role of ['anon','service_role','clued_worker_gateway'])assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') v',[role,rpcName])).rows[0].v,false);
      await assert.rejects(call({action:'list'},native,sha(id())),e=>e.code==='42501');
      await login(native,owner,id());await assert.rejects(listing(),e=>e.code==='42501');await login(native);
      assert.deepEqual((await listing()).connections,[]);
      const wrong=server.getPgClient();clients.push(wrong);await wrong.connect();await wrong.query('set role clued_worker_gateway');await login(wrong);
      await db.query('grant execute on function public.clued_storage_owner_lifecycle_v1(text,jsonb) to clued_worker_gateway');
      try{await assert.rejects(call({action:'list'},wrong),e=>e.code==='42501');}
      finally{await db.query('revoke execute on function public.clued_storage_owner_lifecycle_v1(text,jsonb) from clued_worker_gateway');}
      await native.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'clued_worker_gateway',session_id:session})]);
      await assert.rejects(listing(),e=>e.code==='42501');await login(native);
    });
    await t.test('reconnect retry successor pins exact source and Native ACL; replay is unchanged and drift makes no DDL changes',async()=>{
      const currentDefinition=(await db.query('select pg_get_functiondef($1::regprocedure) def',[rpcName])).rows[0].def;
      if(reconnectRefreshPredecessorDefinition)await db.query(reconnectRefreshPredecessorDefinition);
      try{
      const sql=await fs.readFile(path.join(cloud,'supabase/migrations','20261011101500_storage_reconnect_retry_v1.sql'),'utf8');
      const catalog=async()=>(await db.query("select pg_get_userbyid(proowner) owner,prosecdef,proconfig,proacl::text acl,encode(sha256(convert_to(prosrc,'UTF8')),'hex') source_hash from pg_proc where oid=$1::regprocedure",[rpcName])).rows[0];
      const successor=await catalog();assert.equal(successor.source_hash,'dfc42609cbfa7af4086259c093f6993e1a541ceda8a4c1dd399a88983c3d9317');
      await db.query(sql);assert.deepEqual(await catalog(),successor);
      assert.ok(reconnectRetryPredecessorDefinition);await db.query('begin');
      try{await db.query(reconnectRetryPredecessorDefinition);assert.equal((await catalog()).source_hash,'52ac7fd31ce54b212dc528d657bddb21641d7896e4b93d859ac0131c54d3e00d');
        await db.query(sql);assert.deepEqual(await catalog(),successor);
      }finally{await db.query('rollback');}
      for(const tamper of ['alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) owner to authenticated',
        'alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) security invoker',
        'alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) set search_path=public',
        'grant execute on function public.clued_storage_owner_lifecycle_v1(text,jsonb) to anon','source']){
        await db.query('begin');try{
          if(tamper==='source'){const v=(await db.query('select pg_get_functiondef($1::regprocedure) def,prosrc from pg_proc where oid=$1::regprocedure',[rpcName])).rows[0];
            await db.query(v.def.replace(v.prosrc,()=>v.prosrc+'\n-- synthetic drift\n'));
          }else await db.query(tamper);
          const before=await catalog();await db.query('savepoint retry_drift');
          await assert.rejects(db.query(sql),e=>e.code==='42501'&&e.message==='storage_reconnect_retry_upgrade_unqualified');
          await db.query('rollback to savepoint retry_drift');assert.deepEqual(await catalog(),before);
        }finally{await db.query('rollback');}
      }
      }finally{await db.query(currentDefinition);}
    });
    await t.test('refresh successor pins exact source and Native ACL; qualified replay is inert and drift refuses atomically',async()=>{
      const currentDefinition=(await db.query('select pg_get_functiondef($1::regprocedure) def',[rpcName])).rows[0].def;
      if(demandRuntimePredecessorDefinition)await db.query(demandRuntimePredecessorDefinition);
      try{
      const sql=await fs.readFile(path.join(cloud,'supabase/migrations','20261012033722_storage_reconnect_refresh_default_v1.sql'),'utf8');
      const catalog=async()=>(await db.query("select pg_get_userbyid(proowner) owner,prosecdef,proconfig,proacl::text acl,encode(sha256(convert_to(prosrc,'UTF8')),'hex') source_hash from pg_proc where oid=$1::regprocedure",[rpcName])).rows[0];
      const successor=await catalog();assert.equal(successor.source_hash,'5507655146cad446408ddb26136a3c8cbeb84b88ee559aa19114b8f3c03a2238');
      await db.query(sql);assert.deepEqual(await catalog(),successor);
      await db.query('begin');try{await db.query(reconnectRefreshPredecessorDefinition);await db.query(sql);assert.deepEqual(await catalog(),successor);}finally{await db.query('rollback');}
      for(const tamper of ['alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) owner to authenticated',
        'alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) security invoker',
        'alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) set search_path=public',
        'grant execute on function public.clued_storage_owner_lifecycle_v1(text,jsonb) to anon','source']){
        await db.query('begin');try{
          if(tamper==='source'){const v=(await db.query('select pg_get_functiondef($1::regprocedure) def,prosrc from pg_proc where oid=$1::regprocedure',[rpcName])).rows[0];await db.query(v.def.replace(v.prosrc,()=>v.prosrc+'\n-- synthetic drift\n'));}
          else await db.query(tamper);
          const before=await catalog();await db.query('savepoint refresh_drift');
          await assert.rejects(db.query(sql),e=>e.code==='42501'&&e.message==='storage_reconnect_refresh_upgrade_unqualified');
          await db.query('rollback to savepoint refresh_drift');assert.deepEqual(await catalog(),before);
        }finally{await db.query('rollback');}
      }
      }finally{await db.query(currentDefinition);}
    });
    await t.test('whole-root forward upgrade pins source, Owner/definer/config/ACL; replay is idempotent and drift fails without side effects',async()=>{
      const successorDefinition=(await db.query('select pg_get_functiondef($1::regprocedure) def',[rpcName])).rows[0].def;
      if(wholeRootPreMasterDefinition)await db.query(wholeRootPreMasterDefinition);
      try{
      const sql=await fs.readFile(path.join(cloud,'supabase/migrations',wholeRootMigration),'utf8');
      const catalog=async()=>(await db.query(`select pg_get_userbyid(proowner) owner,prosecdef,proconfig,proacl::text acl,
        encode(sha256(convert_to(prosrc,'UTF8')),'hex') source_hash from pg_proc where oid=$1::regprocedure`,[rpcName])).rows[0];
      const baseline=await catalog();assert.equal(baseline.source_hash,'a6eb23ee9c69dae6e1f0ac709587f2b46f675478a326b30f2b3a909bf8170017');
      assert.equal(baseline.owner,'postgres');assert.equal(baseline.prosecdef,true);assert.deepEqual(baseline.proconfig,['search_path=""']);
      await db.query(sql);assert.deepEqual(await catalog(),baseline);
      const source=await fs.readFile(path.join(cloud,'supabase/migrations','20261010055701_storage_owner_lifecycle_v1.sql'),'utf8');
      const original=source.slice(source.indexOf('create function public.clued_storage_owner_lifecycle_v1('));
      const definition=original.slice(0,original.indexOf('end $$;')+'end $$;'.length).replace('create function','create or replace function');
      await db.query('begin');
      try{
        await db.query(definition);assert.equal((await catalog()).source_hash,'e0aaaeef216f736fca47cc3523a5d6c690dcd5cf6711f755411104c96eb7ba04');
        await db.query(sql);assert.deepEqual(await catalog(),baseline);
      }finally{await db.query('rollback');}
      for(const tamper of [
        'alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) owner to authenticated',
        'alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) security invoker',
        'alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) set search_path=public',
        'grant execute on function public.clued_storage_owner_lifecycle_v1(text,jsonb) to anon',
        'source',
      ]){
        await db.query('begin');
        try{
          if(tamper==='source'){
            const v=(await db.query('select pg_get_functiondef($1::regprocedure) def,prosrc from pg_proc where oid=$1::regprocedure',[rpcName])).rows[0];
            await db.query(v.def.replace(v.prosrc,()=>v.prosrc+'\n-- synthetic source drift\n'));
          }else await db.query(tamper);
          const before=await catalog();await db.query('savepoint drift');
          await assert.rejects(db.query(sql),e=>e.code==='42501'&&e.message==='storage_owner_root_trash_upgrade_unqualified');
          await db.query('rollback to savepoint drift');assert.deepEqual(await catalog(),before);
        }finally{await db.query('rollback');}
      }
      assert.deepEqual(await catalog(),baseline);
      }finally{if(wholeRootPreMasterDefinition)await db.query(successorDefinition);}
    });
    const original=await root();
    await t.test('actual Native onboard provenance and true registered identities; no fabricated physical path',async()=>{
      const c=(await listing()).connections.find(c=>c.id===original.connection);
      assert.equal(c.created_by_clued,true);assert.equal(c.root_folder_id,original.rootId);assert.equal(c.profile_id,original.profile);assert.equal(c.project_id,original.project);
      assert.match(c.managed_root,/^\/clued-cloud\//);assert.equal(c.normal_use_enabled,false);assert.equal(c.refresh_enabled,false);
      const originalList=(await native.query('select public.clued_storage_owner_manage_v2($1::jsonb) v',[JSON.stringify({action:'connections'})])).rows[0].v;
      assert.deepEqual(c.access_digest_missing,originalList.connections.find(x=>x.id===original.connection).access_digest_missing);
    });
    await disconnect(original.connection);const oldSnapshot=await row(original.connection);
    const stopped=(await listing()).connections.find(c=>c.id===original.connection);
    const reconnect={action:'reconnect_begin',...await connectionInput(original.connection),root_stop_generation:stopped.root_stop_generation,request_id:id(),confirmation:confirm(original,{normal_use:false})};
    let fresh;
    await t.test('fresh reconnect CAS and confirmation; old revoked row untouched; no implicit refresh/normal/read-content/write-class carry',async()=>{
      await assert.rejects(call({...reconnect,base_version:reconnect.base_version-1}),e=>e.code==='40001');
      await assert.rejects(call({...reconnect,confirmation:confirm(original,{normal_use:false,confirmed:false})}),e=>e.code==='42501');
      fresh=await call(reconnect);assert.equal(fresh.status,'prepared');assert.notEqual(fresh.connection_id,original.connection);
      assert.equal((await listing()).connections.filter(c=>c.profile_id===original.profile).length,1);
      assert.equal((await listing()).connections.find(c=>c.profile_id===original.profile).id,original.connection);
      const replay=await call(reconnect);assert.equal(replay.connection_id,fresh.connection_id);assert.equal(replay.execution_permitted,false);
      assert.deepEqual(await row(original.connection),oldSnapshot);
      const next=await row(fresh.connection_id);assert.equal(next.profile_id,original.profile);assert.equal(next.credential_envelope,null);assert.equal(next.refresh_default_blocked,true);
      const d=await outer({action:'describe',connection_id:fresh.connection_id});assert.equal(d.default_refresh_eligible,false);
      const state=sha(id());await outer({action:'prepare',connection_id:fresh.connection_id,connection_version:d.connection_version,attempt_id:id(),state_hash:state,verifier_envelope:envelope(),requested_scope_profile:'legacy'});
      await callback({action:'claim',state_hash:state});await callback({action:'complete',state_hash:state,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:'legacy'});
      const done=await call({action:'reconnect_activate',state_hash:state});assert.equal(done.status,'completed');assert.equal(done.normal_use_enabled,false);assert.equal(done.refresh_enabled,false);
      assert.deepEqual(await call({action:'reconnect_activate',state_hash:state}),done);assert.deepEqual(await row(original.connection),oldSnapshot);
      const policy=(await db.query('select actions,consent_source from clued_private.storage_account_policies_v2 where connection_id=$1 and state=\'active\'',[fresh.connection_id])).rows[0];
      assert.deepEqual(policy.actions,['inspect','create_file','create_topic']);assert.equal(policy.consent_source,'explicit_restore');
      assert.equal((await db.query("select classes from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'",[fresh.connection_id])).rows[0].classes.join(), 'read');
      assert.equal((await listing()).connections.find(c=>c.id===fresh.connection_id).root_stopped,false);
      assert.equal((await listing()).connections.filter(c=>c.profile_id===original.profile).length,1);
      assert.ok(!(await listing()).connections.some(c=>c.id===original.connection));
    });
    await t.test('other Owner and session cannot inspect or consume another Owner lifecycle',async()=>{
      await login(native,otherOwner,otherSession);await assert.rejects(call({action:'describe',connection_id:fresh.connection_id}),e=>e.code==='42501');assert.deepEqual((await listing()).connections,[]);await login(native);
    });
    await t.test('connection-only delete hides old revoked row without erasing history or touching the active root',async()=>{
      const separate=await root();await disconnect(separate.connection);const before=await row(separate.connection);
      const req={action:'delete_prepare',...await connectionInput(separate.connection),request_id:id(),confirmation:confirm(separate,{trash_created_root:false})};
      const prepared=await call(req);await call({action:'delete_start',attempt_id:prepared.attempt_id,admission:prepared.admission});
      await assert.rejects(call({action:'delete_start',attempt_id:prepared.attempt_id,admission:prepared.admission}),e=>e.code==='42501');
      const done=await call({action:'delete_observe',attempt_id:prepared.attempt_id,root_folder_id:separate.rootId,outcome:'kept'});assert.equal(done.root_trashed,false);
      assert.deepEqual(await row(separate.connection),before);assert.ok(!(await listing()).connections.some(c=>c.id===separate.connection));
      const oldList=(await native.query('select public.clued_storage_owner_manage_v2($1::jsonb) v',[JSON.stringify({action:'connections'})])).rows[0].v;
      assert.ok(!oldList.connections.some(c=>c.id===separate.connection));
      assert.equal((await db.query('select state from clued_private.resource_center_profiles_v1 where id=$1',[separate.profile])).rows[0].state,'active');
    });
    const selected=await root(true),trashable=await root();
    const snapshot=r=>({root_folder_id:r.rootId,root_parent_id:'my-drive',root_version:'3',metadata_digest:sha('synthetic inventory'),etag:'"synthetic-etag"',owned_by_me:true,can_trash:true,trashed:false});
    const deletion=async r=>({action:'delete_prepare',...await connectionInput(r.connection),request_id:id(),confirmation:confirm(r,{trash_created_root:true,root_version:'3',metadata_digest:sha('synthetic inventory')}),snapshot:snapshot(r)});
    await t.test('picked roots and forged root/version snapshots cannot acquire root-trash authority',async()=>{
      assert.equal((await listing()).connections.find(c=>c.id===selected.connection).created_by_clued,false);
      await assert.rejects(call(await deletion(selected)),e=>e.code==='42501');
      const wrong=await deletion(trashable);wrong.snapshot.root_folder_id='other-root';await assert.rejects(call(wrong),e=>e.code==='42501');
      assert.equal((await db.query('select count(*)::int n from clued_private.storage_owner_lifecycle_v1 where operation=\'delete\' and profile_id=$1',[trashable.profile])).rows[0].n,0);
    });
    let admitted;
    await t.test('durable quiet-root fence; short-lived admission is one-use and forged/expired admission never starts a provider effect',async()=>{
      admitted=await call(await deletion(trashable));
      const before=await row(trashable.connection);
      await assert.rejects(disconnect(trashable.connection),e=>e.code==='42501'&&e.message==='storage_owner_lifecycle_pending');
      assert.deepEqual(await row(trashable.connection),before);
      await assert.rejects(call({action:'delete_start',attempt_id:admitted.attempt_id,admission:id()}),e=>e.code==='42501');
      await assert.rejects(db.query('select clued_private.storage_root_quiet_v1($1,$2)',[owner,trashable.rootId]),e=>e.code==='42501');
      await call({action:'delete_start',attempt_id:admitted.attempt_id,admission:admitted.admission});
      await assert.rejects(disconnect(trashable.connection),e=>e.code==='42501'&&e.message==='storage_owner_lifecycle_pending');
      await assert.rejects(call({action:'delete_start',attempt_id:admitted.attempt_id,admission:admitted.admission}),e=>e.code==='42501');
      await call({action:'delete_revalidate',attempt_id:admitted.attempt_id,admission:admitted.admission});
      await assert.rejects(call({action:'delete_revalidate',attempt_id:admitted.attempt_id,admission:admitted.admission}),e=>e.code==='42501');
      await assert.rejects(call({action:'delete_revalidate',attempt_id:admitted.attempt_id,admission:null}),e=>e.code==='42501');
      await assert.rejects(call({action:'delete_revalidate',attempt_id:admitted.attempt_id,admission:''}),e=>e.code==='42501');
      await db.query('update clued_private.storage_owner_lifecycle_v1 set expires_at=clock_timestamp()-interval \'1 second\' where id=$1',[admitted.attempt_id]);
      await assert.rejects(call({action:'delete_revalidate',attempt_id:admitted.attempt_id,admission:admitted.admission}),e=>e.code==='42501');
    });
    await t.test('unknown completion remains fenced; GET observation settles after TTL, never issues another permit; replay is read-only',async()=>{
      await call({action:'delete_observe',attempt_id:admitted.attempt_id,root_folder_id:trashable.rootId,outcome:'uncertain'});
      await assert.rejects(disconnect(trashable.connection),e=>e.code==='42501'&&e.message==='storage_owner_lifecycle_pending');
      await login(native,otherOwner,otherSession);
      await assert.rejects(call({action:'recover',attempt_id:admitted.attempt_id}),e=>e.code==='42501');
      const recoveringSession=id();await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[recoveringSession,owner]);
      await login(native,owner,recoveringSession);
      const recovery=await call({action:'recover',attempt_id:admitted.attempt_id});assert.equal(recovery.execution_permitted,false);assert.ok(!Object.hasOwn(recovery,'admission'));
      await assert.rejects(call({action:'delete_start',attempt_id:admitted.attempt_id,admission:admitted.admission}),e=>e.code==='42501');
      const done=await call({action:'delete_observe',attempt_id:admitted.attempt_id,root_folder_id:trashable.rootId,root_version:'4',outcome:'trashed'});assert.equal(done.root_trashed,true);
      assert.deepEqual(await call({action:'recover',attempt_id:admitted.attempt_id}),done);
      assert.equal((await db.query('select state from clued_private.resource_center_profiles_v1 where id=$1',[trashable.profile])).rows[0].state,'revoked');
      assert.equal((await row(trashable.connection)).state,'revoked');
      assert.equal((await db.query('select count(*)::int n from public.clued_audit_receipts where id=$1',[done.receipt_id])).rows[0].n,1);
      await login(native);
    });
    await t.test('parallel same-root confirmations serialize to one admission; unresolved reservation blocks root lifecycle',async()=>{
      const r=await root(),request=await deletion(r),contender=server.getPgClient();clients.push(contender);await contender.connect();await contender.query('set role authenticated');await login(contender);
      const alternate={...request,request_id:id()};
      const outcomes=await Promise.allSettled([call(request),call(alternate,contender)]);
      assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);
      assert.equal(outcomes.filter(v=>v.status==='rejected'&&v.reason.code==='42501').length,1);
      const prepared=outcomes.find(v=>v.status==='fulfilled').value;
      assert.equal((await db.query('select count(*)::int n from clued_private.resource_center_mutations_v1 where profile_id=$1 and state=\'prepared\'',[r.profile])).rows[0].n,1);
      const retry=await call(outcomes[0].status==='fulfilled'?request:alternate);assert.equal(retry.execution_permitted,false);assert.ok(!Object.hasOwn(retry,'admission'));
      await db.query('update clued_private.storage_owner_lifecycle_v1 set expires_at=clock_timestamp()-interval \'1 second\' where id=$1',[prepared.attempt_id]);
      await assert.rejects(call({action:'delete_start',attempt_id:prepared.attempt_id,admission:prepared.admission}),e=>e.code==='42501');
      const cancelled=await call({action:'recover',attempt_id:prepared.attempt_id});assert.equal(cancelled.status,'cancelled');
      await db.query('select clued_private.storage_root_quiet_v1($1,$2)',[owner,r.rootId]);
      assert.equal((await row(r.connection)).state,'active');
    });
    await t.test('Owner session revocation during Root lock wait is rechecked before any Native effect',async()=>{
      const r=await root(),request=await deletion(r),locker=server.getPgClient(),waiting=server.getPgClient();clients.push(locker,waiting);
      await locker.connect();await waiting.connect();await waiting.query('set role authenticated');await login(waiting);
      const pid=(await waiting.query('select pg_backend_pid() pid')).rows[0].pid;
      await locker.query('begin');await locker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[owner+':'+r.rootId]);
      let settled=false;const pending=call(request,waiting).then(v=>{settled=true;return {v};},error=>{settled=true;return {error};});
      for(let i=0;i<100;i++){
        const waitingNow=(await db.query("select wait_event='advisory' waiting from pg_stat_activity where pid=$1",[pid])).rows[0]?.waiting;
        if(waitingNow)break;if(settled)assert.fail('Native call did not wait for Root serialization');await new Promise(resolve=>setTimeout(resolve,10));
        if(i===99)assert.fail('Native root lock wait was not observed');
      }
      // The session row SHARE check has already run. Changing only its TTL
      // under the same fixture's administrative connection waits on that row,
      // so use a short initial TTL to prove wall-clock recheck after the wait.
      await locker.query('rollback');assert.equal((await pending).error,undefined);
      const sid=id();await db.query("insert into auth.sessions(id,user_id,not_after) values($1,$2,clock_timestamp()+interval '200 milliseconds')",[sid,owner]);
      await login(waiting,owner,sid);const r2=await root(),request2=await deletion(r2);
      await locker.query('begin');await locker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[owner+':'+r2.rootId]);
      const denied=call(request2,waiting).then(v=>({v}),error=>({error}));
      await new Promise(resolve=>setTimeout(resolve,250));await locker.query('rollback');
      assert.equal((await denied).error?.code,'42501');
      assert.equal((await db.query('select count(*)::int n from clued_private.storage_owner_lifecycle_v1 where profile_id=$1',[r2.profile])).rows[0].n,0);
      await login(waiting);
    });
    await t.test('Root stop generation drift after fresh consent refuses activation and preserves every old terminal row',async()=>{
      const r=await root();await disconnect(r.connection);const old=await row(r.connection),entry=(await listing()).connections.find(c=>c.id===r.connection);
      const pending=await call({action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,
        request_id:id(),confirmation:confirm(r,{normal_use:false})});
      const d=await outer({action:'describe',connection_id:pending.connection_id}),state=sha(id());
      await outer({action:'prepare',connection_id:pending.connection_id,connection_version:d.connection_version,attempt_id:id(),state_hash:state,verifier_envelope:envelope(),requested_scope_profile:'legacy'});
      await callback({action:'claim',state_hash:state});await callback({action:'complete',state_hash:state,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:'legacy'});
      await db.query('update clued_private.storage_root_denies_v2 set generation=generation+1,receipt_id=(select receipt_id from clued_private.storage_connections_v1 where id=$3) where root_folder_id=$1 and owner_id=$2',[r.rootId,owner,pending.connection_id]);
      await assert.rejects(call({action:'reconnect_activate',state_hash:state}),e=>e.code==='42501');assert.deepEqual(await row(r.connection),old);
      assert.equal((await db.query('select count(*)::int n from clued_private.storage_account_policies_v2 where connection_id=$1',[pending.connection_id])).rows[0].n,0);
    });
    await t.test('abandoned consent expires into a revoked replacement; only new exact confirmation creates another fresh CID',async()=>{
      const r=await root();await disconnect(r.connection);const old=await row(r.connection),entry=(await listing()).connections.find(c=>c.id===r.connection);
      const req={action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,
        request_id:id(),confirmation:confirm(r,{normal_use:false})};
      const first=await call(req);
      await db.query('update clued_private.storage_owner_lifecycle_v1 set expires_at=clock_timestamp()-interval \'1 second\' where id=$1',[first.attempt_id]);
      const next=await call({...req,request_id:id()});assert.notEqual(next.connection_id,first.connection_id);
      assert.equal((await row(first.connection_id)).state,'revoked');assert.deepEqual(await row(r.connection),old);
      assert.equal((await listing()).connections.filter(c=>c.profile_id===r.profile).length,1);
      assert.equal((await listing()).connections.find(c=>c.id===r.connection).root_stopped,true);
    });
    await t.test('closed consent can be replaced immediately; its old state never claims and full activation stays fresh',async()=>{
      const r=await root();await disconnect(r.connection);const old=await row(r.connection),entry=(await listing()).connections.find(c=>c.id===r.connection);
      const req={action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,
        request_id:id(),confirmation:{contract:'clued.storage-owner-confirmation/3',root_folder_id:r.rootId,confirmed:true,
          master_enabled:true,disclosure_version:'clued.storage-master-disclosure/1'}};
      const first=await call(req),d=await outer({action:'describe',connection_id:first.connection_id}),oldState=sha(id());
      await outer({action:'prepare',connection_id:first.connection_id,connection_version:d.connection_version,attempt_id:id(),state_hash:oldState,
        verifier_envelope:envelope(),requested_scope_profile:'full',full_scope:{disclosure_version:'clued.storage-master-disclosure/1'}});
      assert.equal((await call({action:'recover',attempt_id:first.attempt_id})).status,'waiting');
      await assert.rejects(call({...req,request_id:id(),root_stop_generation:entry.root_stop_generation+1}),e=>e.code==='42501');
      await assert.rejects(call({...req,request_id:id(),confirmation:{...req.confirmation,confirmed:false}}),e=>e.code==='42501');
      const second=await call({...req,request_id:id()});assert.notEqual(second.connection_id,first.connection_id);
      assert.deepEqual(await row(r.connection),old);assert.equal((await row(first.connection_id)).state,'revoked');
      assert.equal((await call({action:'recover',attempt_id:first.attempt_id})).status,'cancelled');
      assert.equal((await listing()).connections.find(c=>c.id===r.connection).root_stopped,true);
      await assert.rejects(callback({action:'claim',state_hash:oldState}),e=>e.code==='42501');
      const next=await outer({action:'describe',connection_id:second.connection_id}),state=sha(id());
      await outer({action:'prepare',connection_id:second.connection_id,connection_version:next.connection_version,attempt_id:id(),state_hash:state,
        verifier_envelope:envelope(),requested_scope_profile:'full',full_scope:{disclosure_version:'clued.storage-master-disclosure/1'}});
      await callback({action:'claim',state_hash:state});await callback({action:'complete',state_hash:state,
        provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:'full'});
      const done=await call({action:'reconnect_activate',state_hash:state});assert.equal(done.master_state,'on');assert.equal(done.refresh_enabled,false);
      assert.equal((await listing()).connections.filter(c=>c.profile_id===r.profile).length,1);
      assert.equal((await listing()).connections.find(c=>c.profile_id===r.profile).id,second.connection_id);
      assert.deepEqual(await row(r.connection),old);
    });
    await t.test('fresh reconnect renewal consent activates only after Google success; opt-out and stopped legacy grants stay closed',async()=>{
      for(const [master_enabled,default_refresh] of [[true,true],[true,false],[false,true]]){
        const r=await root();await disconnect(r.connection);const old=await row(r.connection),entry=(await listing()).connections.find(c=>c.id===r.connection);
        const confirmation={contract:'clued.storage-owner-confirmation/4',root_folder_id:r.rootId,confirmed:true,master_enabled,
          disclosure_version:'clued.storage-master-disclosure/1',default_refresh,refresh_disclosure_version:'clued.storage-reconnect-refresh-disclosure/1'};
        const req={action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,request_id:id(),confirmation};
        for(const invalid of [{...confirmation,default_refresh:'true'},{...confirmation,default_refresh:null},
          {...confirmation,refresh_disclosure_version:'wrong'},{...confirmation,until_revoked:true}]){
          await assert.rejects(call({...req,confirmation:invalid}),e=>e.code==='42501');
        }
        const pending=await call(req),d=await outer({action:'describe',connection_id:pending.connection_id}),state=sha(id());
        assert.equal(d.default_refresh_eligible,false,'initial-onboarding guard remains closed for previous roots');
        assert.equal((await db.query('select count(*)::int n from clued_private.storage_refresh_delegations_v1 where connection_id=$1',[pending.connection_id])).rows[0].n,0);
        await outer({action:'prepare',connection_id:pending.connection_id,connection_version:d.connection_version,attempt_id:id(),state_hash:state,
          verifier_envelope:envelope(),requested_scope_profile:master_enabled?'full':'legacy',
          ...(master_enabled?{full_scope:{disclosure_version:'clued.storage-master-disclosure/1'}}:{})});
        await assert.rejects(call({action:'reconnect_activate',state_hash:state}),e=>e.code==='42501');
        await callback({action:'claim',state_hash:state});await callback({action:'complete',state_hash:state,
          provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:master_enabled?'full':'legacy'});
        const done=await call({action:'reconnect_activate',state_hash:state});
        assert.equal(done.refresh_enabled,default_refresh);assert.equal(done.master_state,master_enabled?'on':'off');
        assert.equal((await listing()).connections.find(c=>c.id===pending.connection_id).refresh_enabled,default_refresh);
        assert.deepEqual(await row(r.connection),old);
        const delegation=(await db.query('select * from clued_private.storage_refresh_delegations_v1 where connection_id=$1',[pending.connection_id])).rows[0];
        if(default_refresh){
          assert.equal(delegation.enabled,true);assert.ok(delegation.receipt_id);
          assert.equal((await db.query('select status from public.clued_audit_receipts where id=$1',[delegation.receipt_id])).rows[0].status,'committed');
          const c=await row(pending.connection_id);
          await native.query('select public.clued_storage_refresh_manage_v1($1::jsonb)',[JSON.stringify({action:'disable',connection_id:pending.connection_id,
            base_version:Number(c.version),delegation_version:Number(delegation.version),idempotency_key:id()})]);
          assert.equal((await call({action:'reconnect_activate',state_hash:state})).refresh_enabled,false,'replayed callback reports current renewal truth');
          assert.equal((await listing()).connections.find(c=>c.id===pending.connection_id).refresh_enabled,false,'completed callback never reenables a manual stop');
        }else assert.equal(delegation,undefined);
      }
    });
    await t.test('a claimed OAuth exchange blocks replacement and expired recovery without changing its reservation',async()=>{
      const r=await root();await disconnect(r.connection);const entry=(await listing()).connections.find(c=>c.id===r.connection);
      const req={action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,
        request_id:id(),confirmation:confirm(r,{normal_use:false})};
      const first=await call(req),d=await outer({action:'describe',connection_id:first.connection_id}),state=sha(id());
      await outer({action:'prepare',connection_id:first.connection_id,connection_version:d.connection_version,attempt_id:id(),state_hash:state,
        verifier_envelope:envelope(),requested_scope_profile:'legacy'});
      await callback({action:'claim',state_hash:state});const before=await row(first.connection_id);
      await assert.rejects(call({...req,request_id:id()}),e=>e.code==='40001');assert.deepEqual(await row(first.connection_id),before);
      await db.query('update clued_private.storage_owner_lifecycle_v1 set expires_at=clock_timestamp()-interval \'1 second\' where id=$1',[first.attempt_id]);
      await assert.rejects(call({action:'recover',attempt_id:first.attempt_id}),e=>e.code==='40001');
      assert.deepEqual(await row(first.connection_id),before);
      assert.equal((await db.query('select state from clued_private.storage_owner_lifecycle_v1 where id=$1',[first.attempt_id])).rows[0].state,'prepared');
    });
    await t.test('explicit normal choice on fresh consent enables only its normal read set, not refresh or old extra write levels',async()=>{
      const r=await root();await disconnect(r.connection);const entry=(await listing()).connections.find(c=>c.id===r.connection);
      const pending=await call({action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,
        request_id:id(),confirmation:confirm(r,{normal_use:true})});
      const d=await outer({action:'describe',connection_id:pending.connection_id}),state=sha(id());
      await outer({action:'prepare',connection_id:pending.connection_id,connection_version:d.connection_version,attempt_id:id(),state_hash:state,verifier_envelope:envelope(),requested_scope_profile:'normal'});
      await callback({action:'claim',state_hash:state});await callback({action:'complete',state_hash:state,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:'normal'});
      const completed=await call({action:'reconnect_activate',state_hash:state});assert.equal(completed.normal_use_enabled,true);assert.equal(completed.refresh_enabled,false);assert.equal(completed.provider_scope_profile,'normal');
      const classes=(await db.query("select classes from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'",[pending.connection_id])).rows[0].classes;
      assert.deepEqual(classes,['read','read_content']);assert.equal((await row(r.connection)).state,'revoked');
    });
    await t.test('awaiting-provider and legacy/no-policy connection-only deletes retire and hide without opening a credential or touching Drive',async()=>{
      const r=await root();await disconnect(r.connection);const entry=(await listing()).connections.find(c=>c.id===r.connection);
      const replacement=await call({action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,
        request_id:id(),confirmation:confirm(r,{normal_use:false})});
      const awaiting=await row(replacement.connection_id);assert.equal(awaiting.state,'awaiting_provider');assert.equal(awaiting.credential_envelope,null);
      // Cancelling a connection that is itself awaiting fresh Google consent
      // first requires closing its expired reconnect reservation by fresh
      // confirmation, then the resulting revoked replacement is deletable.
      // Also exercise a true unreserved awaiting row using a synthetic legacy
      // registration on an existing legitimate Native-created profile.
      const freshRoot=await root();
      await disconnect(freshRoot.connection);
      const legacy=(await db.query(`insert into clued_private.storage_connections_v1(owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,receipt_id)
        select owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,receipt_id from clued_private.storage_connections_v1 where id=$1 returning id`,[freshRoot.connection])).rows[0].id;
      const hidden=await call({action:'delete_prepare',...await connectionInput(legacy),request_id:id(),confirmation:confirm(freshRoot,{trash_created_root:false})});
      await call({action:'delete_start',attempt_id:hidden.attempt_id,admission:hidden.admission});
      const done=await call({action:'delete_observe',attempt_id:hidden.attempt_id,root_folder_id:freshRoot.rootId,outcome:'kept'});assert.equal(done.root_trashed,false);
      const ended=await row(legacy);assert.equal(ended.state,'revoked');assert.equal(ended.auth_mode,'revoked');assert.equal(ended.credential_envelope,null);
      assert.ok(!(await listing()).connections.some(c=>c.id===legacy));assert.equal((await db.query('select state from clued_private.resource_center_profiles_v1 where id=$1',[freshRoot.profile])).rows[0].state,'active');
      const activeLegacy=(await db.query(`insert into clued_private.storage_connections_v1(owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,receipt_id)
        select owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,receipt_id from clued_private.storage_connections_v1 where id=$1 returning id`,[freshRoot.connection])).rows[0].id;
      const d=await outer({action:'describe',connection_id:activeLegacy}),state=sha(id());
      await outer({action:'prepare',connection_id:activeLegacy,connection_version:d.connection_version,attempt_id:id(),state_hash:state,verifier_envelope:envelope(),requested_scope_profile:'legacy'});
      await callback({action:'claim',state_hash:state});await callback({action:'complete',state_hash:state,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:'legacy'});
      assert.equal((await row(activeLegacy)).auth_mode,'legacy');assert.equal((await row(activeLegacy)).state,'active');
      const second=await call({action:'delete_prepare',...await connectionInput(activeLegacy),request_id:id(),confirmation:confirm(freshRoot,{trash_created_root:false})});
      await call({action:'delete_start',attempt_id:second.attempt_id,admission:second.admission});
      await call({action:'delete_observe',attempt_id:second.attempt_id,root_folder_id:freshRoot.rootId,outcome:'kept'});
      assert.equal((await row(activeLegacy)).state,'revoked');assert.ok(!(await listing()).connections.some(c=>c.id===activeLegacy));
    });
    await t.test('actual queued_timeout with no intent is terminal and does not permanently block reconnect; true queued job still blocks',async()=>{
      const r=await root(),c=await row(r.connection),binding=id(),job=id();
      await db.query("insert into public.clued_agent_bindings(id,user_id,vendor,agent_name,token_hash,scopes) values($1,$2,'synthetic','FK-only job fixture',$3,'{context:read}')",[binding,owner,sha(id())]);
      await db.query(`insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,authorization_version,
        request_digest,mutation,receipt_id,authority_snapshot_v2,created_at) values($1,$2,$3,$4,$5,1,$6,'{"operation":"create","target_kind":"file"}',$5,'{}',clock_timestamp()-interval '3 hours')`,
        [owner,job,r.connection,binding,c.receipt_id,sha(id())]);
      await assert.rejects(call(await deletion(r)),e=>e.code==='42501'&&e.message==='storage_root_has_unresolved_mutation');
      assert.equal((await db.query('select clued_private.storage_queued_timeout_v1($1,$2) v',[owner,job])).rows[0].v,true);
      const terminal=(await db.query('select intent_id,dispatch_outcome,dispatch_outcome_receipt_id from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2',[owner,job])).rows[0];
      assert.equal(terminal.intent_id,null);assert.equal(terminal.dispatch_outcome.reason.code,'DISPATCH_NOT_STARTED');assert.ok(terminal.dispatch_outcome_receipt_id);
      await disconnect(r.connection);const entry=(await listing()).connections.find(c=>c.id===r.connection);
      const next=await call({action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,
        request_id:id(),confirmation:confirm(r,{normal_use:false})});assert.equal(next.status,'prepared');
    });
    await t.test('Native reconnect recovery waits without creating a connection, then cancels only an expired replacement and keeps Root stop',async()=>{
      const r=await root();await disconnect(r.connection);const old=await row(r.connection),entry=(await listing()).connections.find(c=>c.id===r.connection);
      const request={action:'reconnect_begin',...await connectionInput(r.connection),root_stop_generation:entry.root_stop_generation,
        request_id:id(),confirmation:confirm(r,{normal_use:false})},pending=await call(request);
      const count=(await db.query('select count(*)::int n from clued_private.storage_connections_v1')).rows[0].n;
      const waiting=await call({action:'recover',attempt_id:pending.attempt_id});assert.equal(waiting.status,'waiting');assert.equal(waiting.operation,'reconnect');assert.equal(waiting.execution_permitted,false);
      assert.equal((await db.query('select count(*)::int n from clued_private.storage_connections_v1')).rows[0].n,count);
      await db.query('update clued_private.storage_owner_lifecycle_v1 set expires_at=clock_timestamp()-interval \'1 second\' where id=$1',[pending.attempt_id]);
      const newSession=id();await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[newSession,owner]);await login(native,owner,newSession);
      const cancelled=await call({action:'recover',attempt_id:pending.attempt_id});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.execution_permitted,false);
      assert.equal((await db.query('select count(*)::int n from clued_private.storage_connections_v1')).rows[0].n,count);
      assert.equal((await row(pending.connection_id)).state,'revoked');assert.deepEqual(await row(r.connection),old);
      assert.equal((await listing()).connections.find(c=>c.id===r.connection).root_stopped,true);
      assert.deepEqual(await call({action:'recover',attempt_id:pending.attempt_id}),cancelled);await login(native);
      const next=await call({...request,request_id:id()});assert.equal(next.status,'prepared');assert.notEqual(next.connection_id,pending.connection_id);
    });
    await t.test('complete Owner list is fail-closed on the 101st row; no omitted row can be mistaken for a logical deletion',async()=>{
      await db.query('begin');
      try{
        await db.query(`insert into clued_private.storage_connections_v1(owner_id,profile_id,profile_version,source_decision_id,decision_version,
          provider,state,revoked_at,auth_mode,receipt_id) select owner_id,profile_id,profile_version,source_decision_id,decision_version,
          provider,'revoked',clock_timestamp(),'revoked',receipt_id from clued_private.storage_connections_v1 c cross join generate_series(1,101)
          where c.id=$1`,[original.connection]);
        await db.query('set local role authenticated');await login(db);
        await assert.rejects(call({action:'list'},db),e=>e.code==='42501'&&e.message==='storage_owner_lifecycle_list_incomplete');
      }finally{await db.query('rollback');}
    });
    const wholeConfirm=r=>({contract:'clued.storage-owner-confirmation/2',root_folder_id:r.rootId,confirmed:true,
      trash_created_root:true,confirmation_mode:'whole_created_root_v2'});
    const wholeDeletion=async(r,etag='')=>({action:'delete_prepare',...await connectionInput(r.connection),request_id:id(),
      confirmation:wholeConfirm(r),snapshot:{...snapshot(r),etag}});
    await t.test('V2 requires exact whole-created-root consent; V1 cannot silently lose its strong ETag or preview digest binding',async()=>{
      const r=await root();
      const d=await call({action:'describe',connection_id:r.connection});assert.equal(d.root_trash_confirmation_mode,'whole_created_root_v2');
      const old=await deletion(r);old.snapshot.etag='';await assert.rejects(call(old),e=>e.code==='42501');
      const malformed=await wholeDeletion(r);
      for(const confirmation of [
        {...wholeConfirm(r),confirmed:false}, {...wholeConfirm(r),trash_created_root:false},
        {...wholeConfirm(r),confirmation_mode:'exact_snapshot_v1'}, {...wholeConfirm(r),root_folder_id:'wrong-root'},
        {...wholeConfirm(r),root_version:'3'}, {...wholeConfirm(r),metadata_digest:sha('preview')},
        {...confirm(r,{trash_created_root:true,root_version:'3',metadata_digest:sha('synthetic inventory')}),confirmation_mode:'whole_created_root_v2'},
      ])await assert.rejects(call({...malformed,confirmation}),e=>e.code==='42501');
      for(const patch of [{can_trash:false},{owned_by_me:false},{trashed:true},{root_parent_id:'wrong-parent'},
        {root_version:''},{metadata_digest:'bad'},{etag:null},{etag:'bad\r\nheader'}])
        await assert.rejects(call({...malformed,snapshot:{...malformed.snapshot,...patch}}),e=>e.code==='42501');
      await assert.rejects(call({...malformed,base_version:malformed.base_version-1}),e=>e.code==='40001');
      await assert.rejects(call({...malformed,profile_version:malformed.profile_version+1}),e=>e.code==='40001');
      await login(native,otherOwner,otherSession);await assert.rejects(call(malformed),e=>e.code==='42501');await login(native);
      await assert.rejects(call(await wholeDeletion(selected)),e=>e.code==='42501');
      assert.equal((await db.query('select count(*)::int n from clued_private.storage_owner_lifecycle_v1 where profile_id=$1',[r.profile])).rows[0].n,0);
    });
    await t.test('V2 weak/absent ETag preparation stores mode and whole-Root authority; replay cannot change mode or snapshots',async()=>{
      const r=await root(),request=await wholeDeletion(r,'W/"synthetic-weak"'),prepared=await call(request);
      const stored=(await db.query(`select l.confirmation,l.request_digest,m.exact_request,m.authority_request
        from clued_private.storage_owner_lifecycle_v1 l join clued_private.resource_center_mutations_v1 m on m.id=l.intent_id where l.id=$1`,[prepared.attempt_id])).rows[0];
      assert.deepEqual(stored.exact_request,wholeConfirm(r));assert.equal(stored.confirmation.snapshot.etag,'W/"synthetic-weak"');
      assert.equal(stored.authority_request.contract,'clued.storage-owner-root-lifecycle/2');assert.equal(stored.authority_request.confirmation_mode,'whole_created_root_v2');
      assert.equal((await call(request)).execution_permitted,false);assert.ok(!Object.hasOwn(await call(request),'admission'));
      await assert.rejects(call({...request,snapshot:{...request.snapshot,metadata_digest:sha('different inventory')}}),e=>e.code==='40001');
      const v1=await deletion(r);await assert.rejects(call({...v1,request_id:request.request_id}),e=>e.code==='40001');
      await db.query('update clued_private.storage_owner_lifecycle_v1 set expires_at=clock_timestamp()-interval \'1 second\' where id=$1',[prepared.attempt_id]);
      assert.equal((await call({action:'recover',attempt_id:prepared.attempt_id})).status,'cancelled');
      await db.query('select clued_private.storage_root_quiet_v1($1,$2)',[owner,r.rootId]);
      assert.equal((await row(r.connection)).state,'active');
    });
    await t.test('V2 durable mode, capability and exact request cannot be changed before start/revalidate or GET recovery',async()=>{
      const r=await root(),prepared=await call(await wholeDeletion(r));
      const start={action:'delete_start',attempt_id:prepared.attempt_id,admission:prepared.admission};
      for(const tamper of [
        "update clued_private.storage_owner_lifecycle_v1 set confirmation=jsonb_set(confirmation,'{confirmation_mode}','\"exact_snapshot_v1\"') where id=$1",
        "update clued_private.storage_owner_lifecycle_v1 set confirmation=jsonb_set(confirmation,'{contract}','\"clued.storage-owner-confirmation/1\"') where id=$1",
        "update clued_private.storage_owner_lifecycle_v1 set confirmation=jsonb_set(confirmation,'{snapshot,can_trash}','false') where id=$1",
        "update clued_private.resource_center_mutations_v1 set exact_request=exact_request-'confirmation_mode' where id=(select intent_id from clued_private.storage_owner_lifecycle_v1 where id=$1)",
      ]){
        await db.query('begin');
        try{await db.query(tamper,[prepared.attempt_id]);await db.query('set local role authenticated');await login(db);
          await db.query('savepoint native_drift');
          await assert.rejects(call(start,db),e=>e.code==='42501');
          await db.query('rollback to savepoint native_drift');
          await assert.rejects(call({action:'recover',attempt_id:prepared.attempt_id},db),e=>e.code==='42501');
        }finally{await db.query('rollback');}
      }
      await call(start);await assert.rejects(call({...start,action:'delete_revalidate',confirmation_mode:'whole_created_root_v2'}),e=>e.code==='42501');
      await call({...start,action:'delete_revalidate'});
      await assert.rejects(call({...start,action:'delete_revalidate',admission:null}),e=>e.code==='42501');
      await call({action:'delete_observe',attempt_id:prepared.attempt_id,root_folder_id:r.rootId,outcome:'uncertain'});
      const newerSession=id();await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[newerSession,owner]);await login(native,owner,newerSession);
      const recovered=await call({action:'recover',attempt_id:prepared.attempt_id});assert.equal(recovered.execution_permitted,false);
      assert.equal(recovered.confirmation_contract,'clued.storage-owner-confirmation/2');assert.equal(recovered.confirmation_mode,'whole_created_root_v2');
      assert.equal(recovered.descriptor.root_trash_confirmation_mode,'whole_created_root_v2');
      assert.ok(!Object.hasOwn(recovered,'admission'));
      await assert.rejects(call(start),e=>e.code==='42501');
      const done=await call({action:'delete_observe',attempt_id:prepared.attempt_id,root_folder_id:r.rootId,root_version:'9',outcome:'trashed'});
      assert.equal(done.root_trashed,true);assert.deepEqual(await call({action:'recover',attempt_id:prepared.attempt_id}),done);await login(native);
      assert.equal((await db.query('select state from clued_private.resource_center_profiles_v1 where id=$1',[r.profile])).rows[0].state,'revoked');
    });
    await t.test('V2 same-Root confirmations serialize and expired/revoked Native authority cannot produce another admission',async()=>{
      const r=await root(),request=await wholeDeletion(r),contender=server.getPgClient();clients.push(contender);
      await contender.connect();await contender.query('set role authenticated');await login(contender);
      const results=await Promise.allSettled([call(request),call({...request,request_id:id()},contender)]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='42501').length,1);
      const prepared=results.find(x=>x.status==='fulfilled').value;
      await db.query('update clued_private.storage_owner_lifecycle_v1 set expires_at=clock_timestamp()-interval \'1 second\' where id=$1',[prepared.attempt_id]);
      await assert.rejects(call({action:'delete_start',attempt_id:prepared.attempt_id,admission:prepared.admission}),e=>e.code==='42501');
      assert.equal((await call({action:'recover',attempt_id:prepared.attempt_id})).status,'cancelled');
      await disconnect(r.connection);const revoked=await row(r.connection),stopped=(await listing()).connections.find(x=>x.id===r.connection);
      await assert.rejects(call(await wholeDeletion(r)),e=>e.code==='42501');assert.deepEqual(await row(r.connection),revoked);
      assert.equal((await listing()).connections.find(x=>x.id===r.connection).root_stop_generation,stopped.root_stop_generation);
      await assertGatewayCloseoutBoundary(db);
    });
    await t.test('demand preparation is private, validates current Owner/session and does not issue a read or file intent',async()=>{
      const r=await root(),before=(await db.query('select count(*)::int n from clued_private.storage_read_receipts_v1')).rows[0].n;
      const prepare=async(s=session)=>(await db.query('select clued_private.storage_demand_prepare_v1($1,$2,$3,null,$4,$5::jsonb) v',
        [proof,r.connection,'owner',s,JSON.stringify({operation:'probe'})])).rows[0].v;
      const current=await prepare();
      assert.equal(current.contract,'clued.storage-demand-preflight/1');
      assert.equal(current.connection_id,r.connection);assert.equal(current.owner_id,owner);
      assert.match(current.proof,/^clued_srp_[0-9a-f]{64}$/);assert.equal(current.renewal_enabled,false);
      assert.equal((await db.query('select count(*)::int n from clued_private.storage_read_receipts_v1')).rows[0].n,before);
      assert.equal((await db.query('select proof_hash from clued_private.storage_refresh_demand_proofs_v1 where connection_id=$1',[r.connection])).rows[0].proof_hash,sha(current.proof));
      await assert.rejects(prepare(otherSession),e=>e.code==='42501');
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') permitted',[role,
          'clued_private.storage_demand_prepare_v1(text,uuid,text,text,uuid,jsonb)'])).rows[0].permitted,false);
        assert.equal((await db.query('select has_table_privilege($1,$2,\'SELECT\') permitted',[role,
          'clued_private.storage_refresh_demand_proofs_v1'])).rows[0].permitted,false);
      }
      await disconnect(r.connection);await assert.rejects(prepare(),e=>e.code==='42501');
      await assertGatewayCloseoutBoundary(db);
    });
    await t.test('staged demand Owner preparation, observation and live renewal claim preserve current CAS and stop races',async()=>{
      const r=await root();
      const refresh=async input=>(await db.query('select public.clued_storage_refresh_worker_v1($1,$2::jsonb) v',[proof,JSON.stringify(input)])).rows[0].v;
      const prepare=()=>call({action:'prepare_credential',connection_id:r.connection,operation:'probe'});
      const renewalStatus=async()=>(await native.query('select public.clued_storage_refresh_manage_v1($1::jsonb) v',
        [JSON.stringify({action:'status',connection_id:r.connection})])).rows[0].v;
      const manage=async action=>{const s=await renewalStatus();return (await native.query('select public.clued_storage_refresh_manage_v1($1::jsonb) v',
        [JSON.stringify({action,connection_id:r.connection,base_version:s.connection_version,delegation_version:s.version,
          idempotency_key:id(),...(action==='enable'?{until_revoked:true}:{})})])).rows[0].v;};
      await manage('enable');
      const current=await prepare();assert.equal(current.renewal_enabled,true);
      const expiry=new Date(Date.now()-1000).toISOString();
      assert.deepEqual(await refresh({action:'observe_credential',proof:current.proof,credential_version:current.credential_version,expires_at:expiry}),{status:'current'});
      const observed=(await db.query('select * from clued_private.storage_refresh_activity_v1 where connection_id=$1',[r.connection])).rows[0];
      assert.equal(observed.last_demand_at,null,'opening an Owner page is not an active background task');
      assert.equal((await refresh({action:'due_demand'})).connections.some(x=>x.connection_id===r.connection),false,
        'expired access token alone cannot trigger hourly idle renewal');
      await db.query("update clued_private.storage_refresh_activity_v1 set keepalive_anchor_at=clock_timestamp()-interval '31 days' where connection_id=$1",[r.connection]);
      assert.equal((await refresh({action:'due_demand'})).connections.find(x=>x.connection_id===r.connection)?.wake,'keepalive');
      await refresh({action:'observe_credential',proof:current.proof,credential_version:current.credential_version,expires_at:expiry});
      assert.equal((await refresh({action:'due_demand'})).connections.find(x=>x.connection_id===r.connection)?.wake,'keepalive',
        'repeated Owner observations cannot postpone the keepalive anchor');
      await db.query("update clued_private.storage_refresh_activity_v1 set last_successful_exchange_at=clock_timestamp()-interval '31 days',keepalive_anchor_at=clock_timestamp(),last_demand_at=clock_timestamp() where connection_id=$1",[r.connection]);
      assert.equal((await refresh({action:'due_demand'})).connections.some(x=>x.connection_id===r.connection),false,
        'new credential anchor wins over an old exchange; a completed read is not ongoing activity');
      // Real demand bypasses the access-token wake timestamp, not failure backoff.
      await db.query("update clued_private.storage_refresh_delegations_v1 set next_refresh_at=clock_timestamp()+interval '1 hour' where connection_id=$1",[r.connection]);
      const attempt=id(),claim={action:'claim',connection_id:r.connection,attempt_id:attempt,demand_proof:current.proof};
      const acquired=await refresh(claim);assert.equal(acquired.status,'acquired');
      const original=await row(r.connection);
      await manage('disable');
      await assert.rejects(refresh({action:'commit',connection_id:r.connection,attempt_id:attempt,demand_proof:current.proof,
        credential_envelope:envelope(),expires_at:new Date(Date.now()+3600000).toISOString()}),e=>e.code==='42501');
      const stopped=await row(r.connection);assert.equal(stopped.credential_version,original.credential_version);
      assert.equal((await renewalStatus()).enabled,false);
      await assert.rejects(refresh({...claim,attempt_id:id()}),e=>e.code==='42501');
      await assert.rejects(call({action:'prepare_credential',connection_id:r.connection,operation:'probe',owner_id:owner}),e=>e.code==='42501');
      await assertGatewayCloseoutBoundary(db);
      const sources=(await db.query("select oid::regprocedure::text signature,encode(sha256(convert_to(prosrc,'UTF8')),'hex') sha from pg_proc where oid=any($1::regprocedure[])",
        [[rpcName,'clued_private.ii_pub_clued_storage_refresh_worker_v1(text,jsonb)','clued_private.ii_pub_clued_storage_read_v1(text,text,jsonb)']])).rows;
      console.log('Synthetic staged demand Native source hashes:',JSON.stringify(sources));
    });
    await t.test('demand endpoints accept the actual rotated issuer credential and reject historical identity as authentication',async()=>{
      const r=await root(),rotated=sha(id());
      await db.query('begin');
      try{
        await db.query("update clued_private.issuer_credentials_v1 set state='retired',retired_at=clock_timestamp() where issuer_id=(select id from clued_private.issuer_identities_v1 where legacy_key=$1 and kind='storage')",[proof]);
        await db.query("insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at) select id,2,$2,'active',clock_timestamp() from clued_private.issuer_identities_v1 where legacy_key=$1 and kind='storage'",
          [proof,'cv1:'+sha('clued.credential-verifier.v1:'+rotated)]);
        await db.query("set local role authenticated");await login(db);
        const input={action:'prepare_credential',connection_id:r.connection,operation:'probe'};
        const current=await call(input,db,rotated);assert.equal(current.connection_id,r.connection);
        await db.query('savepoint old_identity');await assert.rejects(call(input,db,proof),e=>e.code==='42501');await db.query('rollback to savepoint old_identity');
        await db.query("reset role");
        const expiry=new Date(Date.now()+3600000).toISOString();
        await db.query("set local role clued_worker_gateway");
        const observed=(await db.query('select public.clued_storage_refresh_worker_v1($1,$2::jsonb) v',
          [rotated,JSON.stringify({action:'observe_credential',proof:current.proof,credential_version:current.credential_version,expires_at:expiry})])).rows[0].v;
        assert.equal(observed.status,'current');
      }finally{await db.query('rollback');}
    });
    await t.test('demand runtime replay preserves GW80 and every function definition/ACL; catalog drift fails atomically',async()=>{
      // This is a replay of the historical demand-runtime subject. Restore its
      // exact predecessor within this test, then put the current successor back.
      const renewalCurrent=[];
      for(const signature of renewalSignatures)renewalCurrent.push((await db.query('select pg_get_functiondef($1::regprocedure) def',[signature])).rows[0].def);
      try{
      assert.ok(demandRuntimeSuccessorWorkerDefinition);await db.query(demandRuntimeSuccessorWorkerDefinition);
      const sql=await fs.readFile(path.join(cloud,'supabase/migrations','20261012113128_storage_demand_refresh_runtime_v1.sql'),'utf8');
      const before=await snapshotCallerCatalog(db);await db.query(sql);assert.deepEqual(await snapshotCallerCatalog(db),before);
      await db.query('begin');try{
        await db.query('alter function public.clued_storage_owner_lifecycle_v1(text,jsonb) security invoker');
        const drift=await snapshotCallerCatalog(db);await db.query('savepoint bad_catalog');
        await assert.rejects(db.query(sql),/storage_demand_owner_catalog_mismatch/);
        await db.query('rollback to savepoint bad_catalog');assert.deepEqual(await snapshotCallerCatalog(db),drift);
      }finally{await db.query('rollback');}
      await assertGatewayCloseoutBoundary(db);
      }finally{for(const definition of renewalCurrent)await db.query(definition);}
    });
    const refreshStatus=async r=>(await native.query('select public.clued_storage_refresh_manage_v1($1::jsonb) v',
      [JSON.stringify({action:'status',connection_id:r.connection})])).rows[0].v;
    const refreshManage=async(r,action)=>{const s=await refreshStatus(r);return (await native.query('select public.clued_storage_refresh_manage_v1($1::jsonb) v',
      [JSON.stringify({action,connection_id:r.connection,base_version:s.connection_version,delegation_version:s.version,
        idempotency_key:id(),...(action==='enable'?{until_revoked:true}:{})})])).rows[0].v;};
    const refreshCall=async input=>(await db.query('select public.clued_storage_refresh_worker_v1($1,$2::jsonb) v',[proof,JSON.stringify(input)])).rows[0].v;
    const prepareRenewalOAuth=async r=>{const d=await outer({action:'describe',connection_id:r.connection}),state=sha(id());
      await outer({action:'prepare',connection_id:r.connection,connection_version:d.connection_version,attempt_id:id(),state_hash:state,
        verifier_envelope:envelope(),requested_scope_profile:'legacy'});await callback({action:'claim',state_hash:state});return state;};
    const finishRenewalOAuth=(state,subject='synthetic-provider-owner')=>callback({action:'complete',state_hash:state,
      provider_subject:subject,credential_envelope:envelope(),provider_scope_profile:'legacy'});
    const pauseRenewal=async(r,reason='provider_rejected',failure_code='token_invalid_grant')=>{
      await db.query('update clued_private.storage_refresh_delegations_v1 set next_refresh_at=clock_timestamp() where connection_id=$1',[r.connection]);
      const attempt=id();assert.equal((await refreshCall({action:'claim',connection_id:r.connection,attempt_id:attempt})).status,'acquired');
      return {attempt,result:await refreshCall({action:'fail',connection_id:r.connection,attempt_id:attempt,reason,failure_code})};
    };
    await t.test('renewal intent upgrade replays exactly and rejects source/Owner/ACL drift atomically',async()=>{
      const sql=await fs.readFile(path.join(cloud,'supabase/migrations','20261117113000_storage_refresh_intent_v1.sql'),'utf8');
      const catalog=async()=>(await db.query('select oid::regprocedure::text signature,pg_get_userbyid(proowner) owner,prosecdef,proconfig,proacl::text acl,prosrc from pg_proc where oid=any($1::regprocedure[]) order by oid',[renewalSignatures])).rows;
      const current=await catalog();await db.query(sql);assert.deepEqual(await catalog(),current);
      await db.query('begin');try{for(const definition of renewalPredecessors)await db.query(definition);await db.query(sql);assert.deepEqual(await catalog(),current);}finally{await db.query('rollback');}
      for(const signature of renewalSignatures)for(const tamper of ['owner','invoker','path','acl','source']){
        await db.query('begin');try{
          if(tamper==='source'){const v=(await db.query('select pg_get_functiondef($1::regprocedure) def,prosrc from pg_proc where oid=$1::regprocedure',[signature])).rows[0];
            await db.query(v.def.replace(v.prosrc,()=>v.prosrc+'\n-- unexpected drift\n'));}
          else await db.query(tamper==='owner'?`alter function ${signature} owner to authenticated`:tamper==='invoker'?`alter function ${signature} security invoker`
            :tamper==='path'?`alter function ${signature} set search_path=public`:`grant execute on function ${signature} to anon`);
          const changed=await catalog();await db.query('savepoint reject_renewal_drift');
          await assert.rejects(db.query(sql),/storage_refresh_intent_(source|catalog)_mismatch/);
          await db.query('rollback to savepoint reject_renewal_drift');assert.deepEqual(await catalog(),changed);
        }finally{await db.query('rollback');}
      }
      await assertGatewayCloseoutBoundary(db);
    });
    await t.test('fatal refresh pauses execution, retains authorization and fresh same-identity OAuth restores renewal',async()=>{
      const r=await root();await refreshManage(r,'enable');const originalStatus=await refreshStatus(r);
      const failed=await pauseRenewal(r);assert.equal(failed.result.status,'failed');
      const paused=await refreshStatus(r);assert.equal(paused.authorized_enabled,true);assert.equal(paused.enabled,false);
      assert.equal(paused.pause_reason,'reauthorization_required');assert.equal(paused.failures,1);assert.equal(paused.version,originalStatus.version);
      await assert.rejects(refreshCall({action:'claim',connection_id:r.connection,attempt_id:id()}),e=>e.code==='42501');
      const summary=(await db.query('select change_summary from public.clued_context_events where receipt_id=$1',[failed.result.receipt_id])).rows[0].change_summary;
      assert.deepEqual(summary,{connection_id:r.connection,attempt_id:failed.attempt,reason:'provider_rejected',failure_code:'token_invalid_grant'});
      const state=await prepareRenewalOAuth(r),done=await finishRenewalOAuth(state);assert.equal(done.status,'completed');
      const restored=await refreshStatus(r);assert.equal(restored.authorized_enabled,true);assert.equal(restored.enabled,true);assert.equal(restored.failures,0);
      assert.equal(restored.pause_reason,'none');const before=await row(r.connection);
      await callback({action:'claim',state_hash:state});assert.deepEqual(await row(r.connection),before);assert.deepEqual(await refreshStatus(r),restored);
      await refreshManage(r,'disable');const off=await refreshStatus(r);await callback({action:'claim',state_hash:state});
      assert.deepEqual(await refreshStatus(r),off,'completed OAuth replay cannot revive a later explicit stop');
    });
    await t.test('third temporary failure stops new attempts without forgetting the Owner choice; fresh OAuth resets the limit',async()=>{
      const r=await root();await refreshManage(r,'enable');
      for(let n=1;n<=3;n++){await pauseRenewal(r,'provider_unavailable','token_server_error');const s=await refreshStatus(r);
        assert.equal(s.authorized_enabled,true);assert.equal(s.enabled,n<3);assert.equal(s.failures,n);assert.equal(s.pause_reason,n===3?'failure_limit':'backoff');}
      await assert.rejects(refreshCall({action:'claim',connection_id:r.connection,attempt_id:id()}),e=>e.code==='42501'&&/storage_refresh_denied/.test(e.message));
      await finishRenewalOAuth(await prepareRenewalOAuth(r));const current=await refreshStatus(r);
      assert.equal(current.enabled,true);assert.equal(current.authorized_enabled,true);assert.equal(current.failures,0);
    });
    await t.test('explicit Off during OAuth and changed provider identity never inherit renewal authorization',async()=>{
      const r=await root();await refreshManage(r,'enable');const state=await prepareRenewalOAuth(r);await refreshManage(r,'disable');
      await finishRenewalOAuth(state);assert.equal((await refreshStatus(r)).authorized_enabled,false);
      await finishRenewalOAuth(await prepareRenewalOAuth(r));assert.equal((await refreshStatus(r)).authorized_enabled,false);
      const changed=await root();await refreshManage(changed,'enable');const differentState=await prepareRenewalOAuth(changed),unchanged=await row(changed.connection);
      await assert.rejects(finishRenewalOAuth(differentState,'different-provider-owner'),e=>e.code==='42501');
      assert.deepEqual(await row(changed.connection),unchanged,'another identity cannot activate credentials or inherit the old authorization');
      await finishRenewalOAuth(differentState);
      await disconnect(changed.connection);assert.equal((await refreshStatus(changed)).authorized_enabled,false);
    });
    await t.test('diagnostic codes are closed enums, reason-bound and cannot smuggle upstream bodies or change a pending exchange',async()=>{
      const r=await root();await refreshManage(r,'enable');const attempt=id(),claim={action:'claim',connection_id:r.connection,attempt_id:attempt};
      await refreshCall(claim);const before=await row(r.connection),base={...claim,action:'fail',reason:'provider_rejected'};
      for(const extra of [{failure_code:'unsafe-upstream-body'},{failure_code:{body:'secret'}},{failure_code:'token_server_error'},
        {failure_code:'token_invalid_grant',upstream_body:'secret'}]){
        await assert.rejects(refreshCall({...base,...extra}),e=>e.code==='42501');assert.deepEqual(await row(r.connection),before);
        assert.equal((await db.query('select state from clued_private.storage_refresh_attempts_v1 where id=$1',[attempt])).rows[0].state,'claimed');
      }
      const result=await refreshCall({...base,failure_code:'token_invalid_client'});assert.equal(result.status,'failed');
      const legacy=await root();await refreshManage(legacy,'enable');const legacyAttempt=id();await refreshCall({action:'claim',connection_id:legacy.connection,attempt_id:legacyAttempt});
      assert.equal((await refreshCall({action:'fail',connection_id:legacy.connection,attempt_id:legacyAttempt,reason:'credential_invalid'})).status,'failed');
      assert.equal((await refreshStatus(legacy)).authorized_enabled,true,'old Workers retain their compatible reason-only settlement');
      await assertGatewayCloseoutBoundary(db);
    });
    await t.test('issuer retirement rejects even read-only recovery; no identity/verifier fallback',async()=>{
      await db.query("update clued_private.issuer_credentials_v1 set state='retired',retired_at=clock_timestamp() where issuer_id=(select id from clued_private.issuer_identities_v1 where legacy_key=$1 and kind='storage')",[proof]);
      await assert.rejects(listing(),e=>e.code==='42501');
    });
  }finally{
    for(const c of clients)await c.end().catch(()=>{});if(started)await stopCluster(server);
    const actual=await fs.realpath(dir);
    if(actual!==dir||path.dirname(actual)!==tempParent||!path.basename(actual).startsWith('clued-owner-lifecycle-'))
      throw new Error('test database directory identity changed; refusing cleanup');
    await removeTestDirectory(actual);
  }
});
