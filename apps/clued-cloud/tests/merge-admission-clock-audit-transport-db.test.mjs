import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build,stop} from 'esbuild';
import { newCluster } from './pg-cluster-fixture.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),cloud=path.resolve(here,'..');
const transportMigration='20261012030548_merge_admission_clock_audit_transport_v1.sql';
const {allowRawTestBindings}=await import(pathToFileURL(path.join(cloud,'tests/raw-binding-grants-fixture.mjs')));
const {workerGatewayRpc}=await import(pathToFileURL(path.join(cloud,'tests/worker-gateway-caller-fixture.mjs')));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),uuid=()=>crypto.randomUUID();
const queue='merge:tdoljyj/cross-memory-system:main',counterexample=false;

test('typed C1 audit transport: actual database authorization and transaction boundaries',{timeout:300000},async t=>{
 const parent=await fs.realpath(process.env.CLUED_TEST_TMP_ROOT??os.tmpdir()),directory=await fs.mkdtemp(path.join(parent,'clued-clock-audit-'));
 const workerDirectory=await fs.mkdtemp(path.join(parent,'clued-clock-audit-worker-'));
 const server=newCluster({databaseDir:directory,user:'postgres',password:crypto.randomBytes(32).toString('hex'),
   persistent:true,initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS],onLog(){},onError(){}}),clients=[];let db;
 try{
  await startCluster(server);db=server.getPgClient();clients.push(db);await db.connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role authenticator nologin noinherit;
   create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
  const names=(await fs.readdir(path.join(cloud,'supabase/migrations'))).filter(x=>x.endsWith('.sql')&&x!==transportMigration).sort(),chain=[];
  for(const name of names){const bytes=await fs.readFile(path.join(cloud,'supabase/migrations',name),'utf8');chain.push({name,sha256:hash(bytes)});
    try{await db.query(bytes);}catch(error){throw Error('Current transport prerequisite '+name+' failed',{cause:error});}}
  await allowRawTestBindings(db);
  const catalog=async()=> (await db.query(`select oid,proowner,proacl::text acl,proconfig,proargtypes::text args from pg_proc
    where oid='public.clued_mcp_audit_receipts(text,jsonb)'::regprocedure`)).rows[0];
  const beforeCatalog=await catalog();
  const rpc=async(r,input)=>{try{return await workerGatewayRpc(db,'clued_mcp_audit_receipts',r.token,input);}
    finally{const reset=async sql=>{try{await db.query(sql);}catch(error){if(error.code!=='25P02')throw error;}};
      await reset('reset role');await reset("select set_config('request.jwt.claims','{}',false)");}};
  const append=async(r,key,context='global',kind='admission_receipt',payload={})=>db.query(
    'select clued_private.merge_measurement_append_v1($1,$2,$3,$4,$5::jsonb)',[r.user,context,kind,key,JSON.stringify(payload)]);
  const make=async(contexts=['*'],scopes=['context:read','context:write','audit:read'])=>{const r={user:uuid(),token:crypto.randomBytes(32).toString('hex')};
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[r.user,r.user+'@example.invalid']);
    r.binding=(await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'openai','private clock audit transport fixture',$2,$3,$4) returning id`,[r.user,r.token,scopes,contexts])).rows[0].id;
    await append(r,'bootstrap');return r;};
  const r=await make(),legacy=await rpc(r,{context_key:'global'}),legacyMeasurement=await rpc(r,{context_key:'global',measurement:{limit:1}});
  const candidate=await fs.readFile(path.join(cloud,'supabase/migrations',transportMigration),'utf8');await db.query(candidate);
  const workerSource=await fs.readFile(path.join(cloud,'worker/continuity.ts'),'utf8');
  // Bind this current transport regression to the independently reviewed Worker.
  // I9 changes only storage recovery routes/scheduler and scoped storage MCP
  // refusals. The replacement-reader refresh bridge also selects the actual
  // reader in those storage routes; C1 audit paths are unchanged. Its reviewed
  // predecessor was ba86106e5e68cf1ddc84cb04455d342a164650b5444e491abf59ad3f2902262f.
  // The prior OAuth guard binding was
  // 005e2c10ccff1369b356ca56ad905c2a063f270332860ad905751053e34dd6f4.
  // That and 23236e5f...24cf remain in earlier history; R9 registry and epoch
  // pins are separate and unchanged.
  // All C1 behavior/permission assertions below remain exact.
  // Prior storage reader refresh pin: 9aa56e4fa6e08eeda5011f86d3085163a7a11bc3ae691e1c9e408fb378f9fc43.
  // Prior storage-only Native absence pin: ffde428621829c2af21dba27c61f8494afe65ee6d9fcd50f86ebc08bca9e57f8.
  // Current storage registration wiring adds the authenticated program RPC
  // in the existing cron and Native recovery routes; C1 assertions stay exact.
  // Prior storage registration pin: ce0646006b8da6269ae233214c52dabc7a9d08a5e2c146895767c5288398f0d8.
  // PR #833, normally merged as 1f45e7ab, adds bounded Native read trace and
  // recovery diagnostics. Bind its exact inherited source; keep every C1
  // permission, transport and transaction assertion below unchanged.
  // Prior Native read diagnostic pin (f3f4493f4):
  // f2277f9683c3d632e60015a1ae3c05c66cfc4001dcd6ea41e97f69c783d45a76.
  // Reviewed successors through a438599e8 change only brand strings, storage
  // digest routes, the MTPE Owner Pin tool and two fixed /v1/ci/* doors; the
  // C1 audit tool, its RPC mapping, error mapping and REST route are unchanged.
  // Prior pin (before #1106 hosted-relay removal): 2578493c142cf0181db9206a877f34ec72f7289b8305fb7dd590de4a64a194f6.
  // #1106 only dropped the hosted scan-start import and door; C1 audit tool, RPC mapping, error mapping and REST route are unchanged.
    // Prior pin (before the continuity-fold change): d09c61e3ced3d1c919477a0faef8493d310ee186b7801c712e90bbdac8345728.
  // That change only runs the resume/renew inbox-summary read beside the live-claims read (Task 8ba4ef85); C1 audit tool, RPC mapping, error mapping and REST route are unchanged.
  // T3 changes scheduled dispatch and post-write projection wakeups; #1161 adds the exact /v1/github/events
  // dispatch before ordinary tracing. Other paths still go through the original CI and audit handling.
  // Database configuration now shares the same defaults with both Worker gateways. C1 audit transport is unchanged.
  // Prior pin (#1173 shared database configuration, before D1): d4bfa2ad260fddff58ae7a40d8684d59aa0264c72fa9b6c04a5001b0a264f3a2.
  // D1 dispatches the signed node renewal route before ordinary tracing, using the shared database transport.
  // Prior pin (D1 before merging #1173): ef2ce85811741d2220e000d84302549628b768ef1f2b9f3c4752dead1d18b5a3.
  // The renewal route's gateway fetch now passes redirect "manual" (workerd does not implement "error"; Task 942adbdb).
  // Prior pin (before that one-literal change): dbecf6920f7d592abe0751c8e11da1fcd2108368bd92412a1341b46a1b0ed0e3.
  assert.equal(hash(workerSource),'2087d718c3f9cc99e854a97e80f2e5e2dfd9b515b2e5065579c477b95c83b594');
  // The historical 8afae4cb pin predates the comment-only Global -> personal records (global) clarification.
  assert.equal(hash(await fs.readFile(path.join(cloud,'worker/permission-guidance.ts'),'utf8')),'7615083917d9cd19460caa1ca23fd531eec804a6a15acea4a821a6eabb03c40c');
  assert.equal(hash(await fs.readFile(path.join(cloud,'worker/result-sanitization.ts'),'utf8')),'0e34c15fcb327f65a6195dec9ded24fae7c96f6d2cb38f36e6a2694db0cf70ff');
  const workerContents=workerSource;
  const workerOutput=path.join(workerDirectory,'continuity.mjs');
  await build({stdin:{contents:workerContents,sourcefile:path.join(cloud,'worker/continuity.ts'),resolveDir:path.join(cloud,'worker'),loader:'ts'},
    outfile:workerOutput,bundle:true,platform:'node',format:'esm',logLevel:'silent'});stop();
  const {handleContinuityRequest:handle}=await import(pathToFileURL(workerOutput));
  const open=(actor,extra={})=>rpc(actor,{context_key:'global',measurement:{operation:'clock_open',queue_ref:queue,...extra}});
  const seal=(actor,e,extra={})=>rpc(actor,{context_key:'global',measurement:{operation:'clock_seal',queue_ref:queue,epoch_id:e.pins.epoch_id,pins:e.pins,...extra}});
  const page=(actor,z,extra={})=>rpc(actor,{context_key:'global',measurement:{operation:'clock_page',queue_ref:queue,seal_id:z.measurement.seal_id,pins:z.pins,seal_pins:z.seal_pins,...extra}});
  const counts=async(actor)=>(await db.query(`select (select count(*) from public.clued_audit_receipts where user_id=$1)::int receipts,
    (select count(*) from clued_private.merge_measurement_events_v1 where user_id=$1)::int journal,
    (select count(*) from clued_private.clock_source_epoch_candidate_v1 where user_id=$1)::int epochs,
    (select count(*) from clued_private.clock_source_seals_candidate_v1 where user_id=$1)::int seals`,[actor.user])).rows[0];
  const makeV12=async(entries=[['global',['audit']]])=>{
    const rawToken='clued_bnd_'+crypto.randomBytes(32).toString('hex'),actor=await make(['*'],['audit:read']);
    actor.rawToken=rawToken;actor.token=hash(rawToken);
    await db.query('update public.clued_agent_bindings set token_hash=$2 where id=$1',[actor.binding,actor.token]);
    await db.query(`insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at,issuance)
      values($1,null,$2,'clock-audit-candidate','Clock audit private DB fixture','https://clued.example/mcp',now()+interval '1 day','headless')`,[actor.binding,actor.user]);
    for(const [resource,actions] of entries)await db.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
      values($1,'scope',$2,'canonical',$3)`,[actor.binding,resource,actions]);
    await db.query('delete from clued_private.raw_binding_grants_v1 where binding_id=$1',[actor.binding]);return actor;
  };
  const mcp=async(actor,method,name='clued_audit_receipts',args={},statusFault=null)=>{
    const originalFetch=globalThis.fetch,calls=[];
    try{globalThis.fetch=async(url,init)=>{
      const route=new URL(url).pathname,body=JSON.parse(init.body);calls.push(route);
      if(route.endsWith('/clued_authorization_status_v12')&&statusFault!==null)return Response.json(statusFault,{status:200});
      try{
        await db.query('set role clued_worker_gateway');await db.query("select set_config('request.jwt.claims','{\"role\":\"clued_worker_gateway\"}',false)");
        if(route.endsWith('/clued_mcp_audit_receipts'))return Response.json((await db.query('select public.clued_mcp_audit_receipts($1,$2::jsonb) v',[body.p_token_hash,body.p_input])).rows[0].v);
        if(route.endsWith('/clued_authorization_status_v12'))return Response.json((await db.query('select public.clued_authorization_status_v12($1) v',[body.p_token_hash])).rows[0].v);
        throw Error('unexpected_mock_rpc');
      }catch(error){if(!error.code)throw error;return Response.json({code:error.code,message:error.message,details:error.detail??null},{status:error.code==='42501'?403:500});}
      finally{await db.query('reset role');await db.query("select set_config('request.jwt.claims','{}',false)");}
    };
    const response=await handle(new Request('https://clued.example'+(method==='rest'?'/v1/continuity/audit':'/mcp'),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+actor.rawToken},
      body:JSON.stringify(method==='rest'?args:{jsonrpc:'2.0',id:1,method,...(method==='tools/call'?{params:{name,arguments:args}}:{})})}),
      {SUPABASE_URL:'https://clued.fixture.invalid',SUPABASE_PUBLISHABLE_KEY:'fixture-public-key',CLUED_DB_GATEWAY_TOKEN:'fixture-worker-gateway'});
    return {http_status:response.status,body:await response.json(),calls};
    }finally{globalThis.fetch=originalFetch;}
  };
  await t.test('only the old C1 RPC remains public; legacy compliance/page and ACL/OID/config stay',async()=>{
    assert.deepEqual(await catalog(),beforeCatalog);assert.deepEqual(await rpc(r,{context_key:'global'}),legacy);
    const laterLegacy=await rpc(r,{context_key:'global',measurement:{limit:1}});
    const {served_observed_at:priorObserved,...priorLegacyFields}=legacyMeasurement;
    const {served_observed_at:laterObserved,...laterLegacyFields}=laterLegacy;
    assert.ok(Number.isFinite(Date.parse(priorObserved)));assert.ok(Number.isFinite(Date.parse(laterObserved)));
    assert.deepEqual(laterLegacyFields,priorLegacyFields,'only the existing per-request served observation is volatile');
    for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])assert.equal((await db.query(
      "select has_function_privilege($1,'clued_private.clock_audit_transport_candidate_v1(text,jsonb)','EXECUTE') v",[role])).rows[0].v,false);
  });
  await t.test('actual C1 open/seal/page authentication is separate from false core/source acceptance; no ordinary post-seal writes',async()=>{
    const before=await counts(r),e=await open(r);assert.equal(e.server_auth.status,'AUTHENTICATED_TARGET_READ');assert.equal(e.source_auth,false);
    assert.equal(e.measurement.source_auth,false);assert.equal(e.official_metric,false);assert.equal(e.t0,null);
    const z=await seal(r,e),p=await page(r,z);assert.equal(p.status,'ok');assert.equal(p.measurement.status,'ok');
    const after=await counts(r);assert.equal(after.receipts,before.receipts);assert.equal(after.journal,before.journal);
    assert.equal(after.epochs,before.epochs+1);assert.equal(after.seals,before.seals+1);
  });
  await t.test('scope denial, user substitution, input booleans and wrong epoch/stream/generation/catalog pins never issue authority',async()=>{
    const narrow=await make(['global'],['context:read']),before=await counts(narrow);
    await assert.rejects(open(narrow),x=>x.code==='42501');assert.deepEqual(await counts(narrow),before);
    const e=await open(r),other=await make();await assert.rejects(seal(other,e),/clock_transport_epoch_unavailable/);
    await assert.rejects(open(r,{user_id:other.user}),/clock_transport_input_invalid/);
    await assert.rejects(open(r,{source_auth:true}),/clock_transport_input_invalid/);
    for(const [field,value] of [['epoch_id',uuid()],['stream_id',uuid()],['clock_generation_id',uuid()],['catalog_digest','0'.repeat(64)],['foundation_digest','0'.repeat(64)]]){
      const before=await counts(r);await assert.rejects(seal(r,e,{pins:{...e.pins,[field]:value}}),/clock_transport_pins_changed/);
      assert.deepEqual(await counts(r),before);
    }
    const z=await seal(r,e);await assert.rejects(page(r,z,{seal_pins:{...z.seal_pins,end_sequence:z.seal_pins.end_sequence+1}}),/clock_transport_seal_pins_changed/);
    await assert.rejects(page(r,z,{seal_pins:{...z.seal_pins,closing_us:String(BigInt(z.seal_pins.closing_us)+1n)}}),/clock_transport_seal_pins_changed/);
  });
  await t.test('unrelated hidden context does not require broad audit; hidden ever-target context refuses and rolls seal back',async()=>{
    const limited=await make(['global']);await append(limited,'unrelated','project:'+uuid());
    const e=await open(limited),z=await seal(limited,e);assert.equal((await page(limited,z)).status,'ok');
    const hidden='project:'+uuid(),key=uuid();await append(limited,key,hidden,'claim',{claim_id:key,merge_refs:[queue],status:'ACTIVE'});
    const before=await counts(limited);await assert.rejects(seal(limited,e),x=>x.code==='42501');assert.deepEqual(await counts(limited),before);
  });
  await t.test('permission drift during real opening/sealing rolls observations back rather than leaving an unauthorized epoch/seal',async()=>{
    const sig='clued_private.merge_clock_raw_sample_candidate_v1()',original=(await db.query('select pg_get_functiondef($1::regprocedure) v',[sig])).rows[0].v;
    const actor=await make();
    await db.query(`create or replace function ${sig} returns timestamptz language plpgsql volatile set search_path='' as $$begin
      if coalesce(current_setting('clock_audit_fixture.revoke',true),'')='yes' then
        update public.clued_agent_bindings set revoked_at=clock_timestamp() where id='${actor.binding}'::uuid;
      end if;return clock_timestamp();end $$`);
    try{const before=await counts(actor);await db.query("select set_config('clock_audit_fixture.revoke','yes',false)");
      await assert.rejects(open(actor),x=>x.code==='42501');assert.deepEqual(await counts(actor),before);
      assert.equal((await db.query('select revoked_at is null active from public.clued_agent_bindings where id=$1',[actor.binding])).rows[0].active,true);
      await db.query("select set_config('clock_audit_fixture.revoke','',false)");const e=await open(actor),beforeSeal=await counts(actor);
      await db.query("select set_config('clock_audit_fixture.revoke','yes',false)");
      await assert.rejects(seal(actor,e),x=>x.code==='42501');assert.deepEqual(await counts(actor),beforeSeal);
      assert.equal((await db.query('select revoked_at is null active from public.clued_agent_bindings where id=$1',[actor.binding])).rows[0].active,true);
    }finally{await db.query("select set_config('clock_audit_fixture.revoke','',false)");await db.query(original);}
  });
  await t.test('same-transaction ordinary source before measurement and unsupported fixed snapshots refuse unchanged isolation',async()=>{
    const actor=await make();await db.query('begin');await append(actor,'same-tx');
    try{await assert.rejects(open(actor),/clock_source_source_write_in_transaction/);}finally{await db.query('rollback');await db.query('reset role');}
    await db.query('begin isolation level repeatable read');try{await assert.rejects(open(actor),/clock_transport_snapshot_isolation_unsupported/);}
      finally{await db.query('rollback');await db.query('reset role');}
    assert.equal((await db.query("select current_setting('transaction_isolation') v")).rows[0].v,'read committed');
  });
  await t.test('C1 real published tool metadata matches non-idempotent persisted opening/seal effects',async()=>{
    const actor=await makeV12(),before=await counts(actor),one=await open(actor),two=await open(actor);
    assert.notEqual(one.pins.epoch_id,two.pins.epoch_id);const z1=await seal(actor,one),z2=await seal(actor,one);
    assert.notEqual(z1.measurement.seal_id,z2.measurement.seal_id);const after=await counts(actor);
    assert.equal(after.epochs,before.epochs+2);assert.equal(after.seals,before.seals+2);
    const published=await mcp(actor,'tools/list'),tool=published.body.result.tools.find(x=>x.name==='clued_audit_receipts');
    if(counterexample)console.log(JSON.stringify({old_counterexample:'C1',readOnlyHint:tool.annotations.readOnlyHint,
      idempotentHint:tool.annotations.idempotentHint,created_epochs:after.epochs-before.epochs,created_seals:after.seals-before.seals}));
    assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.idempotentHint,false);assert.equal(tool.annotations.destructiveHint,false);
    assert.match(tool.description,/persist bounded private queue observations/);
  });
  await t.test('C2 actual v12 Global audit + hidden same-queue project produces clean target refusal without guessed Global grant or persistent seal',async()=>{
    const actor=await makeV12(),e=await open(actor),hidden='project:'+uuid(),key=uuid();
    await append(actor,key,hidden,'claim',{claim_id:key,merge_refs:[queue],status:'ACTIVE'});const before=await counts(actor);
    const out=await mcp(actor,'tools/call','clued_audit_receipts',{context_key:'global',measurement:{operation:'clock_seal',queue_ref:queue,epoch_id:e.pins.epoch_id,pins:e.pins}});
    assert.deepEqual(await counts(actor),before);const denial=out.body.result?.structuredContent;
    if(counterexample)console.log(JSON.stringify({old_counterexample:'C2',error_code:denial.error.code,
      suggestion_resources:denial.error.suggested_request?.resources??[],global_audit_already_succeeded:true,unauthorized_observation_persisted:false}));
    assert.equal(denial.error.code,'clock_target_permission_denied');assert.equal(denial.error.suggested_request,undefined);
    assert.equal(denial.error.suggested_role,undefined);assert.equal(denial.error.missing,undefined);assert.equal(out.body.result.isError,true);
    assert.equal(out.http_status,200);assert.equal(denial.error.category,'permission');assert.ok(!JSON.stringify(out).includes(hidden));
    assert.ok(!JSON.stringify(out).includes(key));assert.ok(!JSON.stringify(out).includes('permission:global/audit'));
    if(!counterexample){const rest=await mcp(actor,'rest','clued_audit_receipts',{context_key:'global',measurement:{operation:'clock_seal',queue_ref:queue,epoch_id:e.pins.epoch_id,pins:e.pins}});
      assert.equal(rest.http_status,403);assert.equal(rest.body.error.code,'clock_target_permission_denied');
      assert.equal(rest.body.error.suggested_request,undefined);assert.ok(!JSON.stringify(rest).includes(hidden));
      assert.ok(!JSON.stringify(rest).includes(key));assert.deepEqual(await counts(actor),before);}
  });
  if(!counterexample)await t.test('new target carrier preserves a6d inactive/unknown signals and genuine requested-context suggestion',async()=>{
    const noGlobal=await makeV12([['global',['read']]]);
    const denied=await mcp(noGlobal,'tools/call','clued_audit_receipts',{context_key:'global'});
    assert.equal(denied.body.result.structuredContent.error.suggested_request.resources[0],'permission:global/audit');
    const actor=await makeV12();await db.query('update public.clued_agent_bindings set revoked_at=now() where id=$1',[actor.binding]);
    const gone=await mcp(actor,'tools/call','clued_audit_receipts',{context_key:'global'});
    assert.equal(gone.http_status,403);assert.ok(JSON.stringify(gone.body).includes('authorization_revoked_or_expired'));
    const unknown=await mcp(actor,'tools/call','clued_audit_receipts',{context_key:'global'},{});
    assert.equal(unknown.http_status,503);assert.ok(!JSON.stringify(unknown.body).includes('suggested_request'));
    const missing=await mcp({rawToken:'clued_bnd_'+crypto.randomBytes(32).toString('hex')},'tools/call','clued_audit_receipts',{context_key:'global'});
    assert.equal(missing.http_status,403);assert.ok(!JSON.stringify(missing.body).includes('suggested_request'));
  });
  if(!counterexample)await t.test('C2 actual contributor permission disappearing during sealing retains v12/Global validity and atomically rolls the seal back',async()=>{
    const actor=await makeV12(),project=uuid(),context='project:'+project,key=uuid();
    await db.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key)
      values($1,$2,'Clock-target private permission fixture','clock-target private permission fixture',$3)`,[project,actor.user,context]);
    await db.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
      values($1,'scope',$2,'canonical',array['audit'])`,[actor.binding,context]);
    const sig='clued_private.merge_clock_raw_sample_candidate_v1()',original=(await db.query('select pg_get_functiondef($1::regprocedure) v',[sig])).rows[0].v;
    await db.query(`create or replace function ${sig} returns timestamptz language plpgsql volatile set search_path='' as $$begin
      if coalesce(current_setting('clock_audit_fixture.drop_project',true),'')='yes' then
        delete from clued_private.authorization_entries_v12 where binding_id='${actor.binding}'::uuid and resource_id='${context}';
      end if;return clock_timestamp();end $$`);
    try{
      const e=await open(actor);await append(actor,key,context,'claim',{claim_id:key,merge_refs:[queue],status:'ACTIVE'});
      const before=await counts(actor);await db.query("select set_config('clock_audit_fixture.drop_project','yes',false)");
      const out=await mcp(actor,'tools/call','clued_audit_receipts',{context_key:'global',measurement:{operation:'clock_seal',queue_ref:queue,epoch_id:e.pins.epoch_id,pins:e.pins}});
      assert.equal(out.body.result.structuredContent.error.code,'clock_target_permission_denied');
      assert.equal(out.body.result.structuredContent.error.suggested_request,undefined);assert.deepEqual(await counts(actor),before);
      assert.equal((await db.query(`select count(*)::int n from clued_private.authorization_entries_v12 where binding_id=$1 and resource_id=$2`,[actor.binding,context])).rows[0].n,1);
      assert.ok(!JSON.stringify(out).includes(context));
    }finally{await db.query("select set_config('clock_audit_fixture.drop_project','',false)");await db.query(original);}
  });
  console.log(JSON.stringify({node:process.versions.node,pg:(await db.query("select current_setting('server_version') v")).rows[0].v,
    migration_count:chain.length,chain_sha256:hash(JSON.stringify(chain)),candidate_sha256:hash(candidate),
    actual_c1_database_test:true,actual_worker_runtime:true,worker_source_sha256:hash(workerSource),counterexample,
    private_candidate:true,source_authenticated:false,official_metric:false,t0:null,production:false}));
 }finally{for(const client of clients)await client.end().catch(()=>{});await stopCluster(server);
   const actual=await fs.realpath(directory);assert.equal(actual,directory);assert.equal(path.dirname(actual),parent);
   assert.ok(path.basename(actual).startsWith('clued-clock-audit-'));await removeTestDirectory(actual);
   const actualWorker=await fs.realpath(workerDirectory);assert.equal(path.dirname(actualWorker),parent);
   assert.ok(path.basename(actualWorker).startsWith('clued-clock-audit-worker-'));await removeTestDirectory(actualWorker);
   console.log(JSON.stringify({clock_audit_fixture_cleanup:'complete'}));}
});
