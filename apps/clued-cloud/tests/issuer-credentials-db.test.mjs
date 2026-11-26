import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { testAccountCloud } from './resource-center-account-cloud-db.fixture.mjs';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { testStorageOAuth } from './resource-center-oauth-db.fixture.mjs';
import { testStorageOnboard } from './resource-center-storage-onboard-db.fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = '20261009070001_issuer_identity_credentials_v1.sql';
const hex = () => crypto.randomBytes(32).toString('hex');
const verifier = (proof) => `cv1:${crypto.createHash('sha256').update(`clued.credential-verifier.v1:${proof}`).digest('hex')}`;
const RAW_BINDING_COMPARISON=/(?<![\w.])(?<!set )(?:\w+\.)?(?:token_hash|old_token_hash|old_reader_hash|old_writer_hash|authority_token_hash)\s*(?:=|<>|is distinct from|is not distinct from)\s*(?:p_\w+|h|reader_hash|writer_hash)(?!\w)/;

test('issuer identity, versioned digests and independently retired credentials', { timeout: 900000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-issuer-credentials-'));
  const server = newCluster({ databaseDir: directory, user: 'postgres', password: hex(),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await startCluster(server);
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrations = (await fs.readdir(path.join(root, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
    const sql = (name) => fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8');
    for (const name of migrations.filter((name) => name < MIGRATION)) {
      try { await admin.query(await sql(name)); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message} ${error.detail ?? ''}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    const user = crypto.randomUUID(), project = crypto.randomUUID(), decision = crypto.randomUUID(), session = crypto.randomUUID();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at) values($1,'issuer-owner@example.invalid',now());`, [user]);
    await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
      values($1,$2,'Issuer fixture','issuer fixture',$3,'confirmed',now())`, [project,user,`project:${project}`]);
    await admin.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Owner issuer fixture','Disposable test objects only','project',$3,'decision','active',1,'active',
      $4,'{"rationale":"Issuer migration regression"}','{}','{}','user_explicit','Owner confirmed')`,
    [decision,user,project,`project:${project}`]);
    const connect = async (role) => {
      const db = server.getPgClient(); clients.push(db); await db.connect();
      if (role) await db.query(`set role ${role}`);
      await db.query('set statement_timeout=\'15s\'');
      return db;
    };
    const owner = await connect('authenticated'), anon = await connect('anon');
    await admin.query(`insert into auth.sessions(id,user_id) values($1,$2)`,[session,user]);
    await owner.query(`select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)`,
      [user,JSON.stringify({sub:user,session_id:session})]);
    const resource='https://issuer.example.invalid/mcp', authorizationProof=hex(), storageSecret=hex(),
      storageProof=crypto.createHash('sha256').update(storageSecret).digest('hex');
    await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Issuer migration fixture')`,
      [authorizationProof,resource]);
    await admin.query(`insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri)
      values($1,'issuer-migration-fixture','https://issuer.example.invalid/storage/google/callback')`,[storageProof]);
    const request = (overrides={}) => ({request_digest:hex(),client_id:'fixture-client',client_name:'Issuer fixture',
      redirect_uri:'https://issuer.example.invalid/client-callback',resource,requested_scopes:['context:read'],...overrides});
    const prepare = async (proof,body=request()) => (await owner.query(`select public.clued_authorization_prepare_v12($1,$2::jsonb) v`,
      [proof,JSON.stringify(body)])).rows[0].v;
    const beforeRequest=await prepare(authorizationProof), bindingProof=hex();
    const approve = async (proof,r,token) => (await owner.query(`select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) v`,
      [proof,r.request_id,r.version,JSON.stringify([{resource_kind:'scope',resource_id:'global',environment:'canonical',actions:['read']}]),
        token,new Date(Date.now()+3600000).toISOString()])).rows[0].v;
    const authorized=await approve(authorizationProof,beforeRequest,bindingProof);
    const registered=(await admin.query(`select public.clued_resource_center_admin_v1($1,$2::jsonb) v`,[user,JSON.stringify({
      action:'profile_register',project_id:project,profile_version:'issuer-test/1',managed_root:'/issuer-fixture/Clued_资料中心',
      root_folder_id:'issuer-fixture-root',root_parent_id:'issuer-fixture-parent',root_folder_version:'1',
      source_decision_id:decision,idempotency_key:crypto.randomUUID()})])).rows[0].v;
    assert.equal(registered.status,'committed',JSON.stringify(registered));
    const lineage=crypto.randomUUID();
    const digest = async (id) => (await admin.query(`select clued_private.storage_client_request_digest_v2($1) v`,[id])).rows[0].v;
    const beforeDigest=await digest(beforeRequest.request_id);
    await admin.query(`insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,
      metadata_digest,review_receipt_id,source_request_id) values($1,1,$2,$3,'fixture-client',$4,$5,$6)`,
    [lineage,authorizationProof,resource,beforeDigest,registered.receipt_id,beforeRequest.request_id]);
    await admin.query(`insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,
      review_receipt_id) values($1,$2,1,$3,$4)`,[beforeRequest.request_id,lineage,beforeDigest,registered.receipt_id]);
    await admin.query(`insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id)
      values($1,1,$2)`,[lineage,registered.receipt_id]);

    // The established shared cloud fixture creates real provider attempts, persisted /2 verification, Receipts
    // and both unsettled and settled jobs before the upgrade. Its existing acceptance assertions remain intact.
    await testAccountCloud(t,admin,server,user,decision);
    const historical = async () => (await admin.query(`select
      (select jsonb_agg(to_jsonb(x) order by lineage_id,generation) from clued_private.storage_client_registrations_v2 x) registrations,
      (select jsonb_agg(to_jsonb(x) order by request_id) from clued_private.storage_client_request_links_v2 x) links,
      (select jsonb_agg(to_jsonb(x) order by id) from public.clued_audit_receipts x) receipts,
      (select jsonb_agg(jsonb_build_object('id',id,'saved',verified_result_v2,'digest',verified_digest_v2,'receipt',verified_receipt_id_v2)
        order by id) from clued_private.resource_center_mutations_v1 where verified_result_v2 is not null) verified`)).rows[0];
    const historicalBefore=await historical();
    assert.ok(historicalBefore.verified.length>0,'the fixture produced real historical persisted verification');
    const publicAcl=(await admin.query(`select p.oid::regprocedure::text sig,p.proacl::text acl from pg_proc p
      where p.pronamespace='public'::regnamespace and p.proargnames && array['p_issuer_hash','p_issuer_secret'] order by 1`)).rows;
    await admin.query(await sql(MIGRATION));
    await allowRawTestBindings(admin);

    const resolve = async (proof,kind) => (await admin.query(`select clued_private.issuer_resolve_identity_v1($1,$2) v`,[proof,kind])).rows[0].v;
    const identity = async (kind,key) => (await admin.query(`select id from clued_private.issuer_identities_v1 where kind=$1 and legacy_key=$2`,
      [kind,key])).rows[0].id;
    const authorizationId=await identity('authorization',authorizationProof), storageId=await identity('storage',storageProof);
    const denied=(promise,pattern=/issuer_credential_required|authorization_issuer_required|storage_\w+_denied/) => assert.rejects(promise,pattern);
    const stage=async(id,proof)=>(await admin.query(`select clued_private.issuer_credential_stage_v1($1,$2) v`,[id,verifier(proof)])).rows[0].v;
    const activate=(id,generation)=>admin.query(`select clued_private.issuer_credential_activate_v1($1,$2)`,[id,generation]);
    const retire=(id,generation)=>admin.query(`select clued_private.issuer_credential_retire_v1($1,$2)`,[id,generation]);
    await t.test('upgrade preserves every historical registration, link, Receipt and persisted verification byte',async()=>{
      assert.deepEqual(await historical(),historicalBefore);
      assert.equal(await digest(beforeRequest.request_id),beforeDigest);
      assert.equal(await resolve(authorizationProof,'authorization'),authorizationProof);
      assert.equal(await resolve(storageProof,'storage'),storageProof);
      const rows=(await admin.query(`select i.kind,c.generation,c.verifier,c.valid_until>clock_timestamp() valid,
        c.valid_until<clock_timestamp()+interval '25 hours' bounded from clued_private.issuer_credentials_v1 c
        join clued_private.issuer_identities_v1 i on i.id=c.issuer_id where i.id=any($1::uuid[])`,[[authorizationId,storageId]])).rows;
      assert.equal(rows.length,2);
      for(const row of rows){assert.equal(row.generation,'1');assert.equal(row.valid,true);assert.equal(row.bounded,true);
        assert.equal(row.verifier,verifier(row.kind==='authorization'?authorizationProof:storageProof));}
      assert.deepEqual((await admin.query(`select p.oid::regprocedure::text sig,p.proacl::text acl from pg_proc p
        where p.pronamespace='public'::regnamespace and p.proargnames && array['p_issuer_hash','p_issuer_secret'] order by 1`)).rows,publicAcl);
    });
    const newAuthorizationProof=hex(),newStorageSecret=hex(),newStorageProof=crypto.createHash('sha256').update(newStorageSecret).digest('hex');
    await t.test('authorization rotates independently; old identities/verifiers/internal proofs cannot authenticate',async()=>{
      const generation=await stage(authorizationId,newAuthorizationProof);
      await denied(resolve(newAuthorizationProof,'authorization'));
      await activate(authorizationId,generation);
      const after=await prepare(newAuthorizationProof);
      const expected=(await admin.query(`select clued_private.m1_sha256(jsonb_build_object('contract','clued.storage-client-registration/3',
        'issuer_id',$2::uuid,'resource',resource,'client_id',client_id,'redirect_uri',redirect_uri,'client_name',client_name,
        'requested_scopes',to_jsonb(requested_scopes))) v from clued_private.authorization_requests_v12 where id=$1`,
        [after.request_id,authorizationId])).rows[0].v;
      assert.equal(await digest(after.request_id),expected);
      assert.equal(await digest(beforeRequest.request_id),beforeDigest);
      assert.equal((await admin.query(`select issuer_hash from clued_private.authorization_requests_v12 where id=$1`,[after.request_id])).rows[0].issuer_hash,authorizationProof,
        'the request stores fixed identity rather than the new credential proof');
      await retire(authorizationId,1);
      await denied(prepare(authorizationProof));
      for(const bad of [authorizationProof,authorizationId,verifier(newAuthorizationProof),verifier(newAuthorizationProof).slice(4),null,'x'])
        await denied(resolve(bad,'authorization'));
      await denied(resolve(newAuthorizationProof,'storage'));
      await admin.query('begin');
      const internal=(await admin.query(`select clued_private.credential_internal_proof_v1($1) v`,[verifier(newAuthorizationProof)])).rows[0].v;
      await denied(resolve(internal,'authorization'));
      await admin.query('rollback');
      assert.equal(await resolve(storageProof,'storage'),storageProof,'rotating authorization does not change the storage issuer');
      const status=(await anon.query(`select public.clued_authorization_status_v12($1) v`,[bindingProof])).rows[0].v;
      assert.equal(status.active,true,'existing Binding remains active');
      const inherited=await prepare(newAuthorizationProof,request({client_id:'fresh-dcr-client'}));
      await approve(newAuthorizationProof,inherited,hex());
      const link=(await admin.query(`select * from clued_private.storage_client_request_link_v3($1)`,[inherited.request_id])).rows;
      assert.equal(link.length,1);assert.equal(link[0].lineage_id,lineage,'new DCR request inherits the historical qualified lineage');
      const matches=(await admin.query(`select clued_private.storage_client_request_matches_v3($1,$2,1,$3) v`,
        [beforeRequest.request_id,lineage,beforeDigest])).rows[0].v;
      assert.equal(matches,true);
      await assert.rejects(activate(authorizationId,1),/issuer_credential_stage_required/);
      await assert.rejects(admin.query(`update clued_private.issuer_credentials_v1 set state='active',retired_at=null
        where issuer_id=$1 and generation=1`,[authorizationId]),/issuer_credential_history_immutable/);
    });
    await t.test('storage rotates; both proof RPCs and raw-secret RPCs reject the old credential',async()=>{
      const generation=await stage(storageId,newStorageProof);await activate(storageId,generation);
      const sweep=async(proof)=>(await anon.query(`select public.clued_storage_onboard_sweep_v1($1) v`,[proof])).rows[0].v;
      assert.ok(await sweep(newStorageProof));
      await retire(storageId,1);await denied(sweep(storageProof));
      assert.equal(await resolve(newStorageProof,'storage'),storageProof);
      const raw=async(secret)=>owner.query(`select public.clued_storage_onboard_v1($1,$2::jsonb)`,
        [secret,JSON.stringify({action:'status',onboard_attempt_id:crypto.randomUUID()})]);
      await denied(raw(storageSecret));
      // No attempt was seeded: a new key reaches the existing guarded business path, which refuses the target.
      await assert.rejects(raw(newStorageSecret),(error)=>error.code==='42501'&&!/issuer_credential_required/.test(error.message));
      await denied(resolve(newStorageProof,'authorization'));
      assert.equal(await resolve(newAuthorizationProof,'authorization'),authorizationProof);
      await assert.rejects(admin.query(`update clued_private.issuer_identities_v1 set legacy_key=$2 where id=$1`,[storageId,hex()]),/issuer_identity_immutable/);
    });
    await t.test('historical persisted jobs authenticate with a new issuer credential without rewriting their proof',async()=>{
      const samples=(await admin.query(`select m.verified_result_v2 saved,m.state,c.state connection_state
        from clued_private.resource_center_mutations_v1 m join clued_private.storage_jobs_v1 j on j.intent_id=m.id
        join clued_private.storage_connections_v1 c on c.id=j.connection_id where m.verified_result_v2 is not null`)).rows;
      const oldIssuer=samples[0].saved.issuer_hash, id=await identity('storage',oldIssuer),proof=hex();
      const generation=await stage(id,proof);await activate(id,generation);await retire(id,1);
      let inspectedCount=0;
      for(const sample of samples.filter((x)=>x.saved.issuer_hash===oldIssuer)){
        const saved=sample.saved;
        const input={action:'verified_inspect',connection_id:saved.connection_id,job_id:saved.job_id};
        await denied(anon.query(`select public.clued_storage_cloud_worker_router_v2($1,$2::jsonb)`,[oldIssuer,JSON.stringify(input)]));
        const inspected=(await anon.query(`select public.clued_storage_cloud_worker_router_v2($1,$2::jsonb) v`,[proof,JSON.stringify(input)])).rows[0].v;
        assert.ok(['committed','verified'].includes(inspected.status),JSON.stringify(inspected));
        inspectedCount++;
      }
      assert.ok(inspectedCount>0,'at least one actual historical job was inspected using the new credential');
      assert.deepEqual((await historical()).verified,historicalBefore.verified,'stored JSON/digest/Receipt remain unchanged after new-key recovery');
      for(const saved of [samples[0].saved,{contract:'clued.storage-persisted-verification/3',issuer_kind:'storage',issuer_id:id,credential_generation:1}]){
        assert.equal((await admin.query(`select clued_private.issuer_verified_identity_matches_v1($1::jsonb,$2) v`,[JSON.stringify(saved),oldIssuer])).rows[0].v,true);
        assert.equal((await admin.query(`select clued_private.issuer_verified_identity_matches_v1($1::jsonb,$2) v`,[JSON.stringify({...saved,issuer_id:crypto.randomUUID(),issuer_hash:hex()}),oldIssuer])).rows[0].v,false);
      }
    });
    await t.test('every issuer entry is covered and private identity/rotation entries stay closed',async()=>{
      const sources=(await admin.query(`select * from clued_private.issuer_function_sources_v1`)).rows;
      assert.equal(sources.length,40);assert.equal(sources.filter(x=>x.schema_name==='public').length,25);
      for(const source of sources){
        const def=(await admin.query(`select pg_get_functiondef($1::regprocedure) v`,[source.signature])).rows[0].v;
        if(source.schema_name==='public'&&source.function_name==='clued_storage_policy_transition_v2'){
          assert.match(def,/issuer_resolve_identity_policy_transition_v1\(p_issuer_hash,\s*p_input\)/,source.signature);
        }else if(source.schema_name==='public'&&source.function_name==='clued_storage_onboard_sweep_v1'){
          assert.match(def,/issuer_resolve_identity_onboard_sweep_v1\(p_issuer_hash\)/,source.signature);
        }else if(source.function_name!=='storage_onboard_activate_v1'){
          assert.match(def,/issuer_resolve_identity(?:_compatible)?_v1/,source.signature);
          assert.doesNotMatch(def,/issuer_resolve_identity_(?:policy_transition|onboard_sweep)_v1/,source.signature);
        }
        if(source.identity_name){
          const internal=(await admin.query(`select pg_get_functiondef(p.oid) def,has_function_privilege('anon',p.oid,'execute') anon,
            has_function_privilege('authenticated',p.oid,'execute') native,has_function_privilege('service_role',p.oid,'execute') service
            from pg_proc p where p.pronamespace='clued_private'::regnamespace and p.proname=$1`,[source.identity_name])).rows[0];
          assert.equal(internal.anon,false);assert.equal(internal.native,false);assert.equal(internal.service,false);
          for(const other of sources.filter(x=>x.identity_name))
            assert.ok(!internal.def.includes(`${other.schema_name}.${other.function_name}(`),'nested calls use identity-only implementations');
          if(source.function_name==='storage_verified_result_v2'){
            assert.match(internal.def,/clued.storage-persisted-verification\/3/);assert.match(internal.def,/issuer_verified_identity_matches_v1/);
            assert.ok(!internal.def.includes("'issuer_hash',p_issuer_identity"),'new proof does not persist the issuer credential');
          }
        }
      }
      const exposed=(await admin.query(`select p.proname from pg_proc p where p.pronamespace='clued_private'::regnamespace
        and (p.proname like 'issuer_%' or p.proname like 'ii_%') and (has_function_privilege('anon',p.oid,'execute')
        or has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute'))`)).rows;
      assert.deepEqual(exposed,[]);
      const functions=(await admin.query(`select p.oid::regprocedure::text sig,pg_get_functiondef(p.oid) def
        from pg_proc p where p.pronamespace in ('public'::regnamespace,'clued_private'::regnamespace) and p.prokind='f'`)).rows;
      const raw=functions.filter(x=>RAW_BINDING_COMPARISON.test(x.def));
      assert.deepEqual(raw.map(x=>x.sig),['clued_private.ii_priv_authorization_issuer_v12(text,text)'],
        'all current Binding credential comparisons remain verified; the one exact identity comparison is independently closed');
      assert.match(raw[0].def,/token_hash=p_issuer_identity/);
      const identityManifest=sources.find(x=>x.function_name==='authorization_issuer_v12');
      assert.equal(identityManifest.identity_name,'ii_priv_authorization_issuer_v12');assert.equal(identityManifest.kind,'authorization');
      assert.ok(!raw[0].def.includes('credential_internal_proof_v1'),'the internal issuer identity is never converted into a proof');
      for(const role of ['anon','authenticated','service_role']){
        const db=await connect(role);await assert.rejects(db.query(`select * from clued_private.issuer_credentials_v1`),/permission denied/);
        await assert.rejects(db.query(`select clued_private.issuer_credential_activate_v1($1,1)`,[storageId]),/permission denied/);
        for(const entry of [
          {name:'issuer_credential_stage_v1',signature:'uuid,text',args:[storageId,verifier(hex())]},
          {name:'issuer_credential_activate_v1',signature:'uuid,bigint',args:[storageId,1]},
          {name:'issuer_credential_retire_v1',signature:'uuid,bigint',args:[storageId,1]},
        ]){
          await admin.query('begin');
          try{
            await admin.query(`grant usage on schema clued_private to ${role};
              grant execute on function clued_private.${entry.name}(${entry.signature}) to ${role}; set local role ${role}`);
            await assert.rejects(admin.query(`select clued_private.${entry.name}($1,$2)`,entry.args),/offline_database_operator_required/);
          }finally{await admin.query('rollback');}
        }
      }
    });
    await t.test('only the Native transition resolver keeps active credential authentication separate from issuer activation',async()=>{
      const original=(await admin.query('select revoked_at from clued_private.storage_oauth_apps_v1 where issuer_hash=$1',[storageProof])).rows[0].revoked_at;
      const checked=await connect(),noOwner=await connect(),blocker=await connect();
      await checked.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [user,JSON.stringify({sub:user,session_id:session})]);
      const checkedResolve=(proof,action='inspect')=>checked.query('select clued_private.issuer_resolve_identity_policy_transition_v1($1,$2) value',
        [proof,{action,manifest_id:crypto.randomUUID()}]);
      const rejected=error=>error.code==='42501'&&error.message==='storage_transition_denied';
      const expiration=async(ttl=0.3)=>{
        const proof=hex(),generation=Number((await admin.query('select max(generation) generation from clued_private.issuer_credentials_v1 where issuer_id=$1',[storageId])).rows[0].generation)+1;
        const deadline=(await admin.query(`insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at,valid_until)
          values($1,$2,$3,'active',clock_timestamp(),clock_timestamp()+$4::numeric*interval '1 second') returning valid_until`,[storageId,generation,verifier(proof),ttl])).rows[0].valid_until;
        return {proof,deadline,generation};
      };
      const waitDetails=async(credential,settled,result)=>{
        const state=(await admin.query(`select clock_timestamp() db_clock,valid_until,state,
          state='active' and valid_until>clock_timestamp() live,
          pg_blocking_pids($3) blocking_pids from clued_private.issuer_credentials_v1
          where issuer_id=$1 and generation=$2`,[storageId,credential.generation,checked.processID])).rows[0];
        const safeMessages=['storage_transition_denied','direct_human_session_required','issuer_credential_required'];
        return JSON.stringify({state,settled,returned:!settled?'pending':result===null?'success':{
          code:/^[0-9A-Z]{5}$/.test(result?.code??'')?result.code:'unknown',
          message:safeMessages.includes(result?.message)?result.message:'unrecognized_error'}});
      };
      const waitForLock=async(pending,credential)=>{
        let settled=false,result;pending.then(value=>{settled=true;result=value;});
        for(let i=0;i<200;i++){
          if((await admin.query('select exists(select 1 from pg_locks where pid=$1 and not granted) value',[checked.processID])).rows[0].value)return;
          if(settled)assert.fail('the credential must reach the intended lock wait: '+await waitDetails(credential,settled,result));
          await new Promise(resolve=>setTimeout(resolve,5));
        }
        assert.fail('the transition credential did not wait: '+await waitDetails(credential,settled,result));
      };
      const waitExpired=async(deadline)=>{
        for(let i=0;i<1200;i++){
          if((await admin.query("select clock_timestamp()>$1::timestamptz+interval '0.02 seconds' value",[deadline])).rows[0].value)return;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.fail('the database clock did not pass the credential deadline');
      };
      try{
        await admin.query('update clued_private.storage_oauth_apps_v1 set revoked_at=clock_timestamp() where issuer_hash=$1',[storageProof]);
        assert.equal((await checkedResolve(newStorageProof)).rows[0].value,storageProof);
        await denied(resolve(newStorageProof,'storage'));
        for(const proof of [storageProof,verifier(newStorageProof),storageId,authorizationProof])await assert.rejects(checkedResolve(proof),rejected);
        const staged=hex(),stagedGeneration=await stage(storageId,staged);
        await assert.rejects(checkedResolve(staged),rejected);await retire(storageId,stagedGeneration);
        const expired=await expiration();
        await waitExpired(expired.deadline);
        await assert.rejects(checkedResolve(expired.proof),rejected);
        await assert.rejects(owner.query('select public.clued_storage_policy_transition_v2($1,$2)',
          [newStorageProof,{action:'inspect',manifest_id:crypto.randomUUID()}]),rejected,'fresh operations remain denied for revoked issuers');
        for(const action of ['transition','inspect']){
          await blocker.query('begin');
          try{
            if(action==='transition')await blocker.query('lock table clued_private.storage_oauth_apps_v1 in row exclusive mode');
            else await blocker.query('update clued_private.storage_oauth_apps_v1 set revoked_at=revoked_at where issuer_hash=$1',[storageProof]);
            if(action==='transition')await assert.rejects(noOwner.query('select clued_private.issuer_resolve_identity_policy_transition_v1($1,$2)',
              [newStorageProof,{action}]),error=>error.code==='42501'&&error.message==='direct_human_session_required',
              'an issuer proof without a Native Owner must not wait on the transition table');
            // Only the lock-wait fixtures need dispatch headroom. Keep the fast
            // already-expired negative above unchanged. Expiry is still real DB
            // time while the resolver is provably blocked, not a changed clock.
            const expiring=await expiration(3);
            if(action==='transition')await admin.query('select pg_sleep(0.4)');
            assert.equal((await admin.query('select clock_timestamp()<$1::timestamptz live',[expiring.deadline])).rows[0].live,true,
              'the lock-wait credential must be live before dispatch');
            const pending=checkedResolve(expiring.proof,action).then(()=>null,error=>error);
            await waitForLock(pending,expiring);
            if(action==='transition'){
              // The table wait must precede app-row SHARE: this real operator
              // UPDATE completes rather than waiting for the reader's row lock.
              await blocker.query('set local statement_timeout=\'1s\'');
              await blocker.query('update clued_private.storage_oauth_apps_v1 set revoked_at=revoked_at where issuer_hash=$1',[storageProof]);
            }
            await waitExpired(expiring.deadline);
            await blocker.query('commit');assert.ok(rejected(await pending),'expiry after either table or app-row wait denies authentication');
          }finally{await blocker.query('rollback');}
        }
      }finally{
        await admin.query('update clued_private.storage_oauth_apps_v1 set revoked_at=$2 where issuer_hash=$1',[storageProof,original]);
      }
    });
    await t.test('permanent issuer provisioning creates identity without implicit credentials, even on reapplication',async()=>{
      const key=hex();await admin.query(`insert into clued_private.authorization_issuers_v12(token_hash,resource,name)
        values($1,$2,'New nonsecret identity')`,[key,resource]);
      const id=await identity('authorization',key);
      assert.equal((await admin.query(`select count(*)::int n from clued_private.issuer_credentials_v1 where issuer_id=$1`,[id])).rows[0].n,0);
      await denied(resolve(key,'authorization'));await admin.query(await sql(MIGRATION));await denied(resolve(key,'authorization'));
      const proof=hex(),generation=await stage(id,proof);await activate(id,generation);
      assert.equal(await resolve(proof,'authorization'),key);await denied(resolve(key,'authorization'));
    });
    await t.test('credential expiry is checked after an issuer lock wait; issuer revoke refuses a current generation',async()=>{
      const key=hex(),proof=hex();await admin.query(`insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri)
        values($1,'expiry-fixture','https://issuer.example.invalid/storage/google/callback')`,[key]);
      const id=await identity('storage',key);
      await admin.query(`insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at,valid_until)
        values($1,1,$2,'active',clock_timestamp(),clock_timestamp()+interval '2 seconds')`,[id,verifier(proof)]);
      const blocker=await connect(),reader=await connect();await blocker.query('begin');
      await blocker.query(`update clued_private.storage_oauth_apps_v1 set revoked_at=revoked_at where issuer_hash=$1`,[key]);
      const pending=reader.query(`select clued_private.issuer_resolve_identity_v1($1,'storage')`,[proof]).then(()=>null,(e)=>e);
      try{
        let waited=false;
        for(let i=0;i<200;i++){
          waited=(await admin.query(`select exists(select 1 from pg_locks where pid=$1 and not granted) v`,[reader.processID])).rows[0].v;
          if(waited)break;await new Promise(r=>setTimeout(r,5));
        }
        assert.equal(waited,true);
        await admin.query(`select pg_sleep(greatest(0,extract(epoch from(valid_until-clock_timestamp()))+0.02))
          from clued_private.issuer_credentials_v1 where issuer_id=$1 and generation=1`,[id]);
        await blocker.query('commit');assert.match((await pending).message,/issuer_credential_required/);
      }finally{await blocker.query('rollback');}
      const fresh=hex(),generation=await stage(id,fresh);await activate(id,generation);
      await admin.query(`update clued_private.storage_oauth_apps_v1 set revoked_at=clock_timestamp() where issuer_hash=$1`,[key]);
      await denied(resolve(fresh,'storage'));
    });
    await t.test('new cloud verification and consent/onboard Receipts contain stable UUID and credential generation, never issuer proof fields',async(sub)=>{
      await allowTestIssuerCredentials(admin);
      const before=(await admin.query(`select coalesce(max(created_at),'-infinity'::timestamptz) at from public.clued_audit_receipts`)).rows[0].at;
      await testAccountCloud(sub,admin,server,user,decision);
      const saved=(await admin.query(`select verified_result_v2 from clued_private.resource_center_mutations_v1
        where verified_result_v2->>'contract'='clued.storage-persisted-verification/3'`)).rows;
      assert.ok(saved.length>0);
      for(const row of saved){const proof=row.verified_result_v2;
        assert.match(proof.issuer_id,/^[0-9a-f-]{36}$/);assert.equal(proof.issuer_kind,'storage');
        assert.ok(Number(proof.credential_generation)>0);assert.equal('issuer_hash' in proof,false);
        assert.equal('issuer_proof' in proof,false);assert.equal('issuer_verifier' in proof,false);}
      const accountProfile=(await admin.query(`select public.clued_resource_center_admin_v1($1,$2::jsonb) v`,[user,JSON.stringify({
        action:'profile_register',project_id:project,profile_version:'account/1',managed_root:'/account/Clued_资料中心',
        root_folder_id:'account-root',root_parent_id:'account-parent',root_folder_version:'1',source_decision_id:decision,
        idempotency_key:crypto.randomUUID()})])).rows[0].v;
      assert.equal(accountProfile.status,'committed',JSON.stringify(accountProfile));
      await testStorageOAuth(sub,admin,server,user,decision);
      await testStorageOnboard(sub,admin,server,user,decision);
      const receipts=(await admin.query(`select r.metadata,r.canonical_result,r.received_payload_hash,r.request_sha256,
        jsonb_build_object('idempotency_key',r.idempotency_key,
          'connection_id',e.change_summary->>'connection_id','oauth_attempt_id',x.id,
          'oauth_receipt_id',e.change_summary->>'oauth_receipt_id','session_id',x.session_id,
          'issuer_id',i.id,'issuer_kind','storage','credential_generation',1,'until_revoked',true) payload
        from public.clued_audit_receipts r join public.clued_context_events e on e.receipt_id=r.id
        join clued_private.storage_oauth_attempts_v1 x on x.id=(e.change_summary->>'oauth_attempt_id')::uuid
        join clued_private.issuer_identities_v1 i on i.kind='storage' and i.legacy_key=x.issuer_hash
        where r.created_at>$1 and r.operation='storage_default_refresh'`,[before])).rows;
      assert.ok(receipts.length>0,'real consent/onboard paths produced Receipts');
      for(const row of receipts){
        const payload=row.payload;
        assert.equal('issuer_hash' in payload,false);assert.equal('issuer_proof' in payload,false);assert.equal('issuer_verifier' in payload,false);
        assert.match(payload.issuer_id,/^[0-9a-f-]{36}$/);assert.equal(payload.issuer_kind,'storage');assert.ok(Number(payload.credential_generation)>0);
        const hashes=(await admin.query(`select clued_private.m1_sha256($1::jsonb) received,
          clued_private.m1_sha256(jsonb_build_object('operation','storage_default_refresh','payload',$1::jsonb-'idempotency_key'-'request_hash')) request`,
          [JSON.stringify(payload)])).rows[0];
        assert.equal(row.received_payload_hash,hashes.received);assert.equal(row.request_sha256,hashes.request);
        assert.ok(!JSON.stringify(row.metadata).includes('issuer_hash'));assert.ok(!JSON.stringify(row.canonical_result).includes('issuer_hash'));
      }
    });
    await t.test('a new active sweep credential clears only its revoked issuer expired attempts, never fresh onboard operations',async()=>{
      const key=hex(),foreignKey=hex(),secret=hex(),proof=crypto.createHash('sha256').update(secret).digest('hex');
      await admin.query(`insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri)
        values($1,'cleanup-fixture','https://cleanup.invalid/storage/google/callback'),
          ($2,'foreign-cleanup-fixture','https://foreign-cleanup.invalid/storage/google/callback')`,[key,foreignKey]);
      const id=await identity('storage',key), generation=await stage(id,proof);await activate(id,generation);await retire(id,1);
      await admin.query('update clued_private.storage_oauth_apps_v1 set revoked_at=clock_timestamp() where issuer_hash=$1',[key]);
      const makeAttempt=async(issuer,expired)=>{
        const attempt=crypto.randomUUID();
        await admin.query(`insert into clued_private.storage_onboard_attempts_v1(id,owner_id,session_id,issuer_hash,
          oauth_attempt_id,connection_id,root_mode,root_name,tracks,normal_use_requested,default_refresh_requested,
          disclosure_version,disclosure_text,disclosure_sha256,state,provider_subject,granted_scope_profile,
          credential_envelope,run_token,run_lease_until,effects,expires_at)
          values($1::uuid,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'new','Synthetic cleanup','["资料"]',false,false,
            'clued.storage-onboard-disclosure/1','Synthetic cleanup disclosure',$5,'credential_staged','cleanup_subject','legacy',
            '{"fixture":"sealed-synthetic-envelope"}',gen_random_uuid(),clock_timestamp()+interval '5 minutes',
            jsonb_build_object('root',jsonb_build_object('intent_at',clock_timestamp(),'provider_file_id','orphan-'||$1::uuid::text,'created',true)),
            clock_timestamp()+case when $6 then interval '-1 second' else interval '1 hour' end)`,[attempt,user,session,issuer,hex(),expired]);
        return attempt;
      };
      const expired=await makeAttempt(key,true),live=await makeAttempt(key,false),foreign=await makeAttempt(foreignKey,true);
      const snapshot=async()=>(await admin.query('select id,state,credential_envelope,run_token,run_lease_until,orphans from clued_private.storage_onboard_attempts_v1 where id=any($1::uuid[]) order by id',[[expired,live,foreign]])).rows;
      const before=await snapshot(),sweep=token=>anon.query('select public.clued_storage_onboard_sweep_v1($1) value',[token]);
      const rejected=error=>error.code==='42501'&&error.message==='storage_onboard_denied';
      try{
        for(const bad of [key,verifier(proof),id,newAuthorizationProof,hex()])await assert.rejects(sweep(bad),rejected);
        const staged=hex(),stagedGeneration=await stage(id,staged);await assert.rejects(sweep(staged),rejected);await retire(id,stagedGeneration);
        const expiredProof=hex(),expiringGeneration=Number(stagedGeneration)+1;
        const deadline=(await admin.query(`insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,activated_at,valid_until)
          values($1,$2,$3,'active',clock_timestamp(),clock_timestamp()+interval '0.3 seconds') returning valid_until`,[id,expiringGeneration,verifier(expiredProof)])).rows[0].valid_until;
        const blocker=await connect();await blocker.query('begin');
        try{
          await blocker.query('update clued_private.storage_oauth_apps_v1 set revoked_at=revoked_at where issuer_hash=$1',[key]);
          const pending=sweep(expiredProof).then(()=>null,error=>error);
          let waiting=false;
          for(let n=0;n<200;n++){
            waiting=(await admin.query('select exists(select 1 from pg_locks where pid=$1 and not granted) value',[anon.processID])).rows[0].value;
            if(waiting)break;await new Promise(resolve=>setTimeout(resolve,5));
          }
          assert.equal(waiting,true,'sweep credential must recheck expiry after the issuer-row wait');
          let elapsed=false;
          for(let n=0;n<1200;n++){
            elapsed=(await admin.query("select clock_timestamp()>$1::timestamptz+interval '0.02 seconds' value",[deadline])).rows[0].value;
            if(elapsed)break;await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.equal(elapsed,true);await blocker.query('commit');assert.ok(rejected(await pending));
        }finally{await blocker.query('rollback');}
        assert.deepEqual(await snapshot(),before,'all credential refusals leave attempts untouched');
        await denied(resolve(proof,'storage'));
        await assert.rejects(anon.query('select public.clued_storage_cloud_worker_router_v2($1,$2)',[proof,{action:'load'}]),/denied/);
        await assert.rejects(owner.query('select public.clued_storage_onboard_v1($1,$2)',[secret,{action:'list'}]),/denied/);
        await assert.rejects(anon.query('select clued_private.issuer_resolve_identity_onboard_sweep_v1($1)',[proof]),/permission denied/);
        assert.equal((await sweep(proof)).rows[0].value.expired,1);
        const after=await snapshot(),cleared=after.find(row=>row.id===expired);
        assert.equal(cleared.state,'expired');assert.equal(cleared.credential_envelope,null);assert.equal(cleared.run_token,null);assert.equal(cleared.run_lease_until,null);
        assert.deepEqual(cleared.orphans.map(row=>row.provider_file_id),['orphan-'+expired]);
        assert.deepEqual(after.find(row=>row.id===live),before.find(row=>row.id===live));
        assert.deepEqual(after.find(row=>row.id===foreign),before.find(row=>row.id===foreign),'a foreign expired attempt is untouched');
        assert.equal((await sweep(proof)).rows[0].value.expired,0);
        assert.equal((await sweep(foreignKey)).rows[0].value.expired,1,'another issuer can sweep only its own expired row');
        const foreignSwept=await snapshot();
        for(const target of [expired,live])assert.deepEqual(foreignSwept.find(row=>row.id===target),after.find(row=>row.id===target));
        await retire(id,generation);await assert.rejects(sweep(proof),rejected);
      }finally{await admin.query('delete from clued_private.storage_onboard_attempts_v1 where id=any($1::uuid[])',[[expired,live,foreign]]);}
    });
    await t.test('a repeated migration never revives retired credentials or changes historical digests',async()=>{
      const state=async()=>(await admin.query(`select
        (select jsonb_agg(to_jsonb(c) order by issuer_id,generation) from clued_private.issuer_credentials_v1 c) credentials,
        (select jsonb_agg(to_jsonb(i) order by id) from clued_private.issuer_identities_v1 i) identities,
        (select jsonb_agg(to_jsonb(d) order by request_id) from clued_private.storage_client_digest_contracts_v1 d) versions`)).rows[0];
      const before=await state();await admin.query(await sql(MIGRATION));assert.deepEqual(await state(),before);
      await denied(resolve(authorizationProof,'authorization'));await denied(resolve(storageProof,'storage'));
      assert.equal(await digest(beforeRequest.request_id),beforeDigest);
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory);
  }
});
