import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import {build} from 'esbuild';
import {allowTestIssuerCredentials} from './issuer-credentials-fixture.mjs';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {setWorkerGatewayCaller,assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';
const cloud=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),id=()=>crypto.randomUUID();
const envelope=()=>({contract:'clued.storage-credential/1',key_id:'synthetic',nonce:'N'.repeat(16),ciphertext:'X'.repeat(64)});
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('three-state master control: actual PostgreSQL migrations and Native authorization',{timeout:240000},async t=>{
  const tempParent=await fs.realpath(os.tmpdir());
  const dir=await fs.mkdtemp(path.join(tempParent,'clued-master-control-'));
  const server=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:sha(id()),port:await port(),persistent:true,
    postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog(){},onError(){}});
  const clients=[];let started=false;
  try{
    const disclosureModule=await build({entryPoints:[path.join(cloud,'worker/storage-onboard-disclosure.ts')],bundle:true,platform:'node',format:'esm',write:false});
    const {renderOnboardDisclosure}=await import('data:text/javascript;base64,'+Buffer.from(disclosureModule.outputFiles[0].text).toString('base64'));
    await server.initialise();await server.start();started=true;
    const db=server.getPgClient();clients.push(db);await db.connect();
    await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for(const file of (await fs.readdir(path.join(cloud,'supabase/migrations'))).filter(n=>n.endsWith('.sql')).sort()){
      const migrationSql=await fs.readFile(path.join(cloud,'supabase/migrations',file),'utf8');
      if(file.endsWith('_storage_master_control_v1.sql')){
        await t.test('migration rejects unreviewed source drift and caller/definer/config changes before creating any object',async()=>{
          const sig='public.clued_storage_owner_manage_v2(jsonb)',v=(await db.query('select pg_get_functiondef($1::regprocedure) def,prosrc from pg_proc where oid=$1::regprocedure',[sig])).rows[0];
          for(const tamper of [v.def.replace(v.prosrc,()=>v.prosrc+'\n-- synthetic drift outside every insertion anchor\n'),
            'alter function '+sig+' security invoker','alter function '+sig+' set search_path=public','grant execute on function '+sig+' to anon']){
            await db.query('begin');
            try{await db.query(tamper);await assert.rejects(db.query(migrationSql),e=>e.code==='42501'&&e.message==='storage_master_upgrade_unqualified');}
            finally{await db.query('rollback');}
            assert.equal((await db.query("select to_regclass('clued_private.storage_master_controls_v1') v")).rows[0].v,null);
          }
        });
      }
      try{await db.query(migrationSql);}catch(e){throw new Error('Migration '+file+': '+e.message,{cause:e});}
    }
    await allowTestIssuerCredentials(db);
    await allowRawTestBindings(db);
    await assertGatewayCloseoutBoundary(db);
    const owner=id(),session=id(),other=id(),otherSession=id(),secret=sha(id()),proof=sha(secret),client='master.apps.googleusercontent.com';
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@synthetic.invalid',now()),($2,'other@synthetic.invalid',now())",[owner,other]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4)',[session,owner,otherSession,other]);
    await db.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled,execution_enabled) values($1,$2,'https://master.invalid/storage/google/callback',true,true)",[proof,client]);
    await db.query('insert into clued_private.storage_onboard_allowlist_v1(owner_id) values($1)',[owner]);
    const login=async(c,u=owner,s=session)=>c.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[u,JSON.stringify({sub:u,role:'authenticated',session_id:s})]);
    const native=server.getPgClient();clients.push(native);await native.connect();await native.query('set role authenticated');await login(native);
    const rpc=async(name,input,c=native)=>(await c.query(`select public.${name}($1::jsonb) v`,[JSON.stringify(input)])).rows[0].v;
    const master=async input=>rpc('clued_storage_owner_manage_v2',input);
    const status=async connection=>master({action:'master_status',connection_id:connection});
    const set=async(connection,enabled,extra={})=>{const s=await status(connection);return master({action:'master_set',connection_id:connection,enabled,
      base_generation:s.master_generation,base_status_digest:s.status_digest,disclosure_version:s.disclosure_version,idempotency_key:id(),...extra});};
    const onboard=async input=>(await native.query('select public.clued_storage_onboard_v1($1,$2::jsonb) v',[secret,JSON.stringify(input)])).rows[0].v;
    const callback=async input=>(await native.query('select public.clued_storage_oauth_callback_v2($1,$2::jsonb) v',[secret,JSON.stringify(input)])).rows[0].v;
    const oauth=async input=>(await native.query('select public.clued_storage_oauth_v1($1,$2::jsonb) v',[proof,JSON.stringify(input)])).rows[0].v;
    const lifecycle=async input=>(await native.query('select public.clued_storage_owner_lifecycle_v1($1,$2::jsonb) v',[proof,JSON.stringify(input)])).rows[0].v;
    const oauthPrepare=async(connection,disclosure)=>{
      const d=await oauth({action:'describe',connection_id:connection}),state_hash=sha(id());
      await oauth({action:'prepare',connection_id:connection,connection_version:d.connection_version,attempt_id:id(),state_hash,
        verifier_envelope:envelope(),requested_scope_profile:'full',...(disclosure?{full_scope:{disclosure_version:disclosure}}:{})});
      return state_hash;
    };
    const oauthComplete=async(state_hash,provider_scope_profile='full')=>{
      await callback({action:'claim',state_hash});
      return callback({action:'complete',state_hash,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile});
    };
    async function root(version='1',granted='legacy',masterRequested=true){
      const attempt=id(),oa=id(),connection=id(),rootId='root-'+id(),name='Synthetic '+id().slice(0,8),state=sha(id());
      const input={action:'begin',owner_id:owner,onboard_attempt_id:attempt,oauth_attempt_id:oa,connection_id:connection,state_hash:state,
        verifier_envelope:envelope(),root:{mode:'new',name},tracks:['资料'],normal_use_requested:version==='2'&&masterRequested,default_refresh_requested:false,
        disclosure_version:'clued.storage-onboard-disclosure/'+version};
      const text=version==='2'?renderOnboardDisclosure({root:input.root,tracks:input.tracks,normal_use:input.normal_use_requested,default_refresh:input.default_refresh_requested},input.disclosure_version)
        :`Clued 使用你 Google 云端硬盘中的「${name}」作为资料根目录。`;
      if(version==='2'){
        assert.equal(text,(await db.query('select clued_private.storage_onboard_master_disclosure_v1($1::jsonb) v',[JSON.stringify(input)])).rows[0].v);
        const narrower=`Clued 使用你 Google 云端硬盘中的「${name}」作为资料根目录。`;
        await assert.rejects(onboard({...input,disclosure_text:narrower,disclosure_sha256:sha(narrower)}),e=>e.code==='40001'&&e.message==='storage_onboard_disclosure_changed');
      }
      await onboard({...input,disclosure_text:text,disclosure_sha256:sha(text)});
      await callback({action:'claim',state_hash:state});
      const staged=await onboard({action:'stage_credential',state_hash:state,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:granted});
      const run={onboard_attempt_id:attempt,run_token:staged.run_token};
      await onboard({action:'effect_intent',...run,role:'root'});await onboard({action:'effect_result',...run,role:'root',provider_file_id:rootId,version:'3',parents:['my-drive'],created:true});
      await onboard({action:'effect_intent',...run,role:'track:资料'});await onboard({action:'effect_result',...run,role:'track:资料',provider_file_id:'track-'+id(),version:'1',parents:[rootId],created:true});
      return {connection,...await onboard({action:'activate',...run,ancestors:['my-drive']})};
    }
    const legacy=await root();
    await t.test('installation leaves old policy unchanged and derives partial, owner and API isolation',async()=>{
      const s=await status(legacy.connection);assert.equal(s.state,'partial');assert.equal(s.master_generation,0);assert.equal(s.reconsent_required,true);
      await assert.rejects(set(legacy.connection,true),e=>e.code==='42501'&&e.message==='storage_master_reconsent_required');
      await login(native,other,otherSession);await assert.rejects(status(legacy.connection),e=>e.code==='42501');await login(native);
      for(const role of ['anon','service_role','clued_worker_gateway']){
        const actor=server.getPgClient();clients.push(actor);await actor.connect();await actor.query('set role '+role);await login(actor);
        await assert.rejects(rpc('clued_storage_owner_manage_v2',{action:'master_status',connection_id:legacy.connection},actor),e=>e.code==='42501');
      }
      for(const name of ['storage_master_snapshot_v1(uuid,uuid)','storage_master_apply_v1(uuid,uuid,boolean,public.clued_audit_receipts,text)','storage_master_native_v1(jsonb)'])
        assert.equal((await db.query("select has_function_privilege('authenticated',$1,'execute') v",['clued_private.'+name])).rows[0].v,false);
    });
    await t.test('OFF is atomic, clears every real class and blocks basic creation as well as reading',async()=>{
      const s=await status(legacy.connection);const request={action:'master_set',connection_id:legacy.connection,enabled:false,
        base_generation:s.master_generation,base_status_digest:s.status_digest,disclosure_version:s.disclosure_version,idempotency_key:id()};
      const receipt=await master(request);assert.equal(receipt.status,'committed');assert.deepEqual(await master(request),receipt);
      const stopped=await status(legacy.connection);assert.equal(stopped.state,'off');assert.equal(stopped.agent_enabled,false);
      assert.equal(stopped.create_enabled,false);assert.deepEqual(stopped.read_classes,[]);assert.deepEqual(stopped.write_classes,[]);
      assert.equal((await db.query('select clued_private.storage_master_action_enabled_v1($1,$2,$3) v',[owner,legacy.connection,'create_file'])).rows[0].v,false);
      await assert.rejects(master({...request,idempotency_key:id()}),e=>e.code==='40001');
      const r=(await db.query('select status,event_ids from public.clued_audit_receipts where id=$1',[receipt.receipt_id])).rows[0];assert.equal(r.status,'committed');assert.ok(r.event_ids.length>0);
    });
    await t.test('OFF to one read class enables only that class; base create and all write classes stay disabled',async()=>{
      const reading=await rpc('clued_storage_read_access_v1',{action:'status',connection_id:legacy.connection});
      await rpc('clued_storage_read_access_v1',{action:'set_classes',connection_id:legacy.connection,classes:['read'],base_generation:reading.read_generation,
        disclosure_version:reading.disclosure_version,idempotency_key:id()});
      const partial=await status(legacy.connection);assert.equal(partial.state,'partial');assert.equal(partial.agent_enabled,true);assert.equal(partial.create_enabled,false);
      assert.deepEqual(partial.read_classes,['read']);assert.deepEqual(partial.write_classes,[]);assert.equal(partial.read_content,false);
      const next=await rpc('clued_storage_read_access_v1',{action:'status',connection_id:legacy.connection});
      await rpc('clued_storage_read_access_v1',{action:'set_classes',connection_id:legacy.connection,classes:[],base_generation:next.read_generation,
        disclosure_version:next.disclosure_version,idempotency_key:id()});
      assert.equal((await status(legacy.connection)).state,'off');
    });
    const full=await root('2','full');
    await t.test('new successor onboarding with a real full scope atomically defaults all capabilities ON',async()=>{
      assert.equal(full.requested_scope_profile,'full');assert.equal(full.provider_scope_profile,'full');assert.equal(full.master_state,'on');
      const s=await status(full.connection);assert.equal(s.state,'on');assert.equal(s.normal_use,true);assert.equal(s.create_enabled,true);
      assert.deepEqual(s.read_classes,['read','read_content']);assert.deepEqual(s.write_classes,['modify','overwrite','destructive','modify_subtree']);
      const partial=await root('2','normal');assert.equal(partial.master_state,'partial');assert.equal((await status(partial.connection)).reconsent_required,true);
      const stopped=await root('2','legacy',false);assert.equal(stopped.master_state,'off');assert.equal((await status(stopped.connection)).create_enabled,false);
    });
    await t.test('parallel Owner CAS produces one committed change; stale write leaves no Receipt or permission side effect; unqualified runtime cannot report ON',async()=>{
      const s=await status(full.connection),racer=server.getPgClient();clients.push(racer);await racer.connect();await racer.query('set role authenticated');await login(racer);
      const first={action:'master_set',connection_id:full.connection,enabled:false,base_generation:s.master_generation,base_status_digest:s.status_digest,
        disclosure_version:s.disclosure_version,idempotency_key:id()},second={...first,idempotency_key:id()};
      const outcomes=await Promise.allSettled([master(first),rpc('clued_storage_owner_manage_v2',second,racer)]);
      assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='40001').length,1);
      const rejectedKey=outcomes[0].status==='rejected'?first.idempotency_key:second.idempotency_key;
      assert.equal((await db.query('select count(*)::int n from public.clued_audit_receipts where user_id=$1 and idempotency_key=$2',[owner,rejectedKey])).rows[0].n,0);
      assert.equal((await status(full.connection)).master_generation,s.master_generation+1);await set(full.connection,true);
      await db.query('begin');
      try{
        await db.query('set local session_replication_role=replica');
        await db.query("update clued_private.resource_center_profiles_v1 p set cloud_runtime=cloud_runtime-'profile_version' from clued_private.storage_connections_v1 c where c.id=$1 and p.id=c.profile_id",[full.connection]);
        await db.query('set local role authenticated');await login(db);
        const unavailable=await rpc('clued_storage_owner_manage_v2',{action:'master_status',connection_id:full.connection},db);
        assert.equal(unavailable.state,'partial');assert.equal(unavailable.agent_enabled,false);assert.equal(unavailable.create_enabled,false);
      }finally{await db.query('rollback');}
      assert.equal((await status(full.connection)).state,'on');
    });
    await t.test('real OAuth full-master consent is atomic; old scope-only consent, partial grant and stale consent never open all permissions',async()=>{
      const old=await root();await set(old.connection,false);
      const scopeOnly=await oauthPrepare(old.connection,'clued.storage-full-scope-disclosure/1');
      await oauthComplete(scopeOnly);assert.equal((await status(old.connection)).state,'off');
      assert.deepEqual((await status(old.connection)).write_classes,[]);
      const requested=await oauthPrepare(old.connection,'clued.storage-master-disclosure/1');
      const done=await oauthComplete(requested);assert.equal(done.master_state,'on');assert.equal((await status(old.connection)).state,'on');
      await set(old.connection,false);
      assert.equal((await callback({action:'claim',state_hash:requested})).status,'completed');
      await assert.rejects(callback({action:'complete',state_hash:requested,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:'full'}),e=>e.code==='42501');
      assert.equal((await status(old.connection)).state,'off','completed OAuth replay cannot re-enable an Owner stop');
      const limited=await root();await set(limited.connection,false);
      const lower=await oauthPrepare(limited.connection,'clued.storage-master-disclosure/1');
      const partial=await oauthComplete(lower,'normal');assert.notEqual(partial.master_state,'on');assert.equal((await status(limited.connection)).state,'off');
      const stale=await oauthPrepare(limited.connection,'clued.storage-master-disclosure/1');await set(limited.connection,false);
      await callback({action:'claim',state_hash:stale});
      await assert.rejects(callback({action:'complete',state_hash:stale,provider_subject:'synthetic-provider-owner',credential_envelope:envelope(),provider_scope_profile:'full'}),e=>e.code==='40001');
      assert.equal((await status(limited.connection)).state,'off');
    });
    await t.test('new explicit reconnect disclosure defaults a fresh replacement ON only after actual full grant',async()=>{
      const r=await root('2','full');const old=(await db.query('select * from clued_private.storage_connections_v1 where id=$1',[r.connection])).rows[0];
      await master({action:'disconnect',connection_id:r.connection,base_version:Number(old.version),idempotency_key:id()});
      const stopped=(await lifecycle({action:'list'})).connections.find(c=>c.id===r.connection);
      const request={action:'reconnect_begin',connection_id:r.connection,base_version:stopped.version,profile_version:stopped.profile_version,
        root_stop_generation:stopped.root_stop_generation,request_id:id(),confirmation:{contract:'clued.storage-owner-confirmation/3',
          root_folder_id:stopped.root_folder_id,confirmed:true,master_enabled:true,disclosure_version:'clued.storage-master-disclosure/1'}};
      const fresh=await lifecycle(request);assert.notEqual(fresh.connection_id,r.connection);
      const state=await oauthPrepare(fresh.connection_id);await oauthComplete(state);
      const activated=await lifecycle({action:'reconnect_activate',state_hash:state});assert.equal(activated.master_state,'on');
      assert.equal((await status(fresh.connection_id)).state,'on');assert.equal((await status(r.connection)).state,'off');
      await set(fresh.connection_id,false);await lifecycle({action:'reconnect_activate',state_hash:state});
      assert.equal((await status(fresh.connection_id)).state,'off','completed reconnect replay cannot re-enable an Owner stop');
    });
    const clientIssuer=sha(id()),resource='https://master-agent.invalid/mcp',token=sha(id()),clientId='master-client-'+id();
    await db.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'synthetic master Agent')",[clientIssuer,resource]);
    const prepared=(await native.query('select public.clued_authorization_prepare_v12($1,$2::jsonb) v',[clientIssuer,JSON.stringify({
      request_digest:sha(id()),client_id:clientId,client_name:'synthetic master Agent',redirect_uri:'https://master-agent.invalid/callback',resource,requested_scopes:['context:read','context:write']})])).rows[0].v;
    await native.query('select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6)',[clientIssuer,prepared.request_id,prepared.version,
      JSON.stringify([{resource_kind:'scope',resource_id:'project:'+full.project_id,environment:'canonical',actions:['read','write','close']}]),token,new Date(Date.now()+3600000).toISOString()]);
    const lineage=id(),digest=(await db.query('select clued_private.storage_client_request_digest_v2($1) v',[prepared.request_id])).rows[0].v;
    await db.query('insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)',[lineage,clientIssuer,resource,clientId,digest,full.receipt_id]);
    await db.query('insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)',[prepared.request_id,lineage,digest,full.receipt_id]);
    await db.query('insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)',[lineage,full.receipt_id]);
    const evaluate=async action=>(await db.query('select clued_private.storage_policy_evaluate_v2($1,$2,$3,$4) v',[token,full.connection,action,id()])).rows[0].v;
    const readEvaluate=async cls=>(await db.query('select clued_private.storage_read_evaluate_v1($1,$2,$3) v',[token,full.connection,cls])).rows[0].v;
    const caller=server.getPgClient();clients.push(caller);await caller.connect();await setWorkerGatewayCaller(caller);
    const stage=async(input,binding=null)=>(await caller.query('select public.clued_storage_staging_v1($1,$2,$3::jsonb) v',[proof,binding,JSON.stringify(input)])).rows[0].v;
    const read=async input=>(await caller.query('select public.clued_storage_read_v1($1,$2,$3::jsonb) v',[proof,token,JSON.stringify(input)])).rows[0].v;
    const job=async input=>(await caller.query('select public.clued_storage_jobs_router_v2($1,$2::jsonb) v',[token,JSON.stringify(input)])).rows[0].v;
    const profile=(await db.query('select p.* from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$1',[full.connection])).rows[0];
    await t.test('real Agent evaluators cover reads, search/upload/adoption/basic and advanced writes; OFF refuses all admissions',async()=>{
      for(const action of ['inspect','create_file','create_topic','modify','overwrite','destructive','modify_subtree'])assert.equal((await evaluate(action)).connection_id,full.connection);
      for(const cls of ['read','read_content'])assert.equal((await readEvaluate(cls)).connection_id,full.connection);
      assert.equal((await db.query('select clued_private.storage_binary_gate_v1($1) v',[full.connection])).rows[0].v,true);
      const readInputs=[{operation:'list',object_id:profile.root_folder_id},{operation:'read',object_id:'syntheticFile0001'},
        {operation:'search',condition_hmac:sha('synthetic query'),key_id:'k1'},
        {operation:'search',condition_hmac:sha('synthetic query'),key_id:'k1',content_search:true}].map(x=>({action:'admit',connection_id:full.connection,...x}));
      for(const input of readInputs)assert.ok((await read(input)).receipt_id);
      const stageInput={action:'begin',connection_id:full.connection,destination_path:profile.managed_root+'/资料/synthetic.png',
        mime_type:'image/png',size:32,content_sha256:sha('synthetic bytes'),transport:'url'};
      const issued=await stage(stageInput,token);assert.equal(issued.state,'issued');
      const queuedInput={action:'submit',connection_id:full.connection,job_id:id(),mutation:{operation:'create',target_kind:'file',
        destination_path:profile.managed_root+'/资料/queued.txt',content:'synthetic queued text'}};
      const queued=await job(queuedInput);assert.equal(queued.status,'queued');assert.equal(queued.intent_id,null);
      await set(full.connection,false);
      for(const action of ['inspect','create_file','create_topic','modify','overwrite','destructive','modify_subtree'])await assert.rejects(evaluate(action),e=>e.code==='42501'&&e.message==='storage_master_disabled');
      for(const cls of ['read','read_content'])await assert.rejects(readEvaluate(cls),e=>e.code==='42501'&&e.message==='storage_master_disabled');
      assert.equal((await db.query('select clued_private.storage_binary_gate_v1($1) v',[full.connection])).rows[0].v,false);
      for(const input of readInputs)await assert.rejects(read(input),e=>e.code==='42501'&&e.message==='storage_master_disabled');
      await assert.rejects(stage(stageInput,token),e=>e.code==='42501'&&e.message==='storage_master_disabled');
      await assert.rejects(stage({action:'receive',staging_id:issued.staging_id,owner_id:issued.owner_id,connection_id:issued.connection_id,
        binding_id:issued.binding_id,sha256:issued.sha256,size:issued.size,mime_type:issued.mime_type,exp:issued.expires_at,key_id:'k1'}),e=>e.code==='42501'&&e.message==='storage_master_disabled');
      assert.equal((await db.query('select state from clued_private.storage_staging_v1 where id=$1',[issued.staging_id])).rows[0].state,'issued');
      await assert.rejects(job({...queuedInput,job_id:id()}),e=>e.code==='42501'&&e.message==='storage_master_disabled');
      await assert.rejects(job({action:'inspect',connection_id:full.connection,job_id:queuedInput.job_id}),e=>e.code==='42501'&&e.message==='storage_master_disabled');
      await assert.rejects(job(queuedInput),e=>e.code==='42501'&&e.message==='storage_master_disabled');
      const q=(await db.query('select dispatch_outcome,dispatch_outcome_receipt_id,intent_id from clued_private.storage_jobs_v1 where job_id=$1',[queuedInput.job_id])).rows[0];
      assert.deepEqual(q.dispatch_outcome,{status:'denied'});assert.equal(q.intent_id,null);
      assert.equal((await db.query('select status from public.clued_audit_receipts where id=$1',[q.dispatch_outcome_receipt_id])).rows[0].status,'committed');
      const nativeHistory=(await native.query('select public.clued_storage_native_recovery_v1($1,$2::jsonb) v',[proof,
        JSON.stringify({action:'recovery_inspect',connection_id:full.connection,job_id:queuedInput.job_id})])).rows[0].v;
      assert.equal(nativeHistory.job_id,queuedInput.job_id);assert.equal(nativeHistory.execution_permitted,false);
      const stopped=await status(full.connection);assert.deepEqual(stopped.read_classes,[]);assert.deepEqual(stopped.write_classes,[]);assert.equal(stopped.create_enabled,false);
      await set(full.connection,true);assert.equal((await status(full.connection)).state,'on');
    });
  }finally{
    await Promise.allSettled(clients.map(c=>c.end()));if(started)await stopCluster(server);
    const actual=await fs.realpath(dir);
    if(actual!==dir||path.dirname(actual)!==tempParent||!path.basename(actual).startsWith('clued-master-control-'))
      throw new Error('test database directory identity changed; refusing cleanup');
    await removeTestDirectory(actual);
  }
});
