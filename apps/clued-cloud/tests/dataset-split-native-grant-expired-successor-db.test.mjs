import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceApp = path.resolve(process.env.CLUED_SYNTHETIC_SOURCE_APP ?? app);
const { allowRawTestBindings } = await import(pathToFileURL(path.join(sourceApp,'tests/raw-binding-grants-fixture.mjs')));
const { findGatewayCloseoutMigration, assertGatewayCloseoutBoundary, snapshotCallerCatalog } = await import(pathToFileURL(path.join(sourceApp,'tests/worker-gateway-caller-fixture.mjs')));

// Real isolated PostgreSQL and synthetic accounts/IDs only. No production,
// real Owner approval, DomainAuthority, DataGate, M2 or model qualification.
const bindingFile = '20261011041300_dataset_split_native_grant_binding_successor_v1.sql';
const candidateSuffix = '_dataset_split_expired_native_reauthorization_v1.sql';
const repo = path.resolve(app, '../..');
const sourceRepo = path.resolve(sourceApp,'../..');
const REQUEST = 'af1cabdb-5259-4ca3-94d3-133f1af122c8';
const OLD = '4970e492-d26e-4974-adaa-757b2146b171';
const TASK = '1502fd80-8ff8-4adc-b4f5-da6d462f4f8a';
const PROJECT = '0597aa60-9b98-4da6-a4ab-63d7705b632f';
const scope = 'project:' + PROJECT;
const uid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const planResource = 'repo:tdoljyj/cross-memory-system/8a975c42ddba3ee7a80fe54a4223b7f590014b67/development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json';
async function freePort() {
  const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}

test('Expired Native successor: real M1 provenance and fresh Native transaction, synthetic only',
  { timeout: 300000 }, async t => {
  // A local WSL harness may place its owned cluster on Linux's temporary
  // filesystem; mounted NTFS cannot provide initdb's required chmod semantics.
  // This changes disposable storage only, never SQL or authorization checks.
  const root = path.resolve(process.env.CLUED_SYNTHETIC_TEMP_ROOT ?? path.join(repo,'work/host-harness/nges'));
  await fs.mkdir(root, { recursive: true });
  assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
  const dir = await fs.mkdtemp(path.join(root, 'p-'));
  const ownership = { run_id: uid(), root, dir };
  await fs.writeFile(path.join(dir, 'Ownership.json'), JSON.stringify(ownership), { flag: 'wx' });
  const port = await freePort();
  const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'db'), user: 'postgres',
    password: hash(), port, persistent: true, createPostgresUser: false,
    postgresFlags: ['-c', 'io_method=sync', '-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
  let db, proc;
  const oldTemp = Object.fromEntries(['TEMP','TMP','TMPDIR'].map(k => [k,process.env[k]]));
  for (const k of ['TEMP','TMP','TMPDIR']) process.env[k] = dir;
  try {
    await server.initialise(); await server.start(); proc = server.process;
    assert.ok(proc?.pid);
    db = server.getPgClient('postgres', '127.0.0.1'); await db.connect();
    const runtime=(await db.query("select current_setting('server_version') version,current_setting('server_version_num')::integer version_num")).rows[0];
    t.diagnostic('Actual PostgreSQL server_version='+runtime.version+'; server_version_num='+runtime.version_num);
    if(process.env.CLUED_SYNTHETIC_EXPECT_PG_VERSION_NUM)
      assert.equal(runtime.version_num,Number(process.env.CLUED_SYNTHETIC_EXPECT_PG_VERSION_NUM));
    await db.query("set statement_timeout='10s'");
    await db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const migrationNames = await fs.readdir(path.join(sourceApp,'supabase/migrations'));
    const expiredNames = migrationNames.filter(n => n.endsWith(candidateSuffix));
    if (!process.env.CLUED_EXPIRED_SUCCESSOR_SQL) assert.equal(expiredNames.length,1,'one exact forward migration is required');
    const candidateSqlPath = process.env.CLUED_EXPIRED_SUCCESSOR_SQL ?? path.join(app,'supabase/migrations',expiredNames[0]);
    const names = migrationNames.filter(n => n.endsWith('.sql') && n !== bindingFile && !expiredNames.includes(n) && n !== path.basename(candidateSqlPath)).sort();
    const closeout = await findGatewayCloseoutMigration(sourceApp);
    // The original request predates G6 and uses its now-retired project alias.
    // Only that historical setup precedes closeout; all Native correction cases run after it.
    for (const name of names.filter(name => name !== closeout)) {
      try { await db.query(await fs.readFile(path.join(sourceApp,'supabase/migrations',name),'utf8')); }
      catch (e) { throw new Error('Migration ' + name + ': ' + e.message, { cause: e }); }
    }
    await allowRawTestBindings(db);
    await allowTestIssuerCredentials(db);
    const owner = uid(), other = uid(), token = hash();
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'correction@example.invalid',now()),($2,'other@example.invalid',now())",[owner,other]);
    const originalBinding = (await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Native correction fixture',$2,array['context:read','context:write','audit:read'],array['*']) returning id`,[owner,token])).rows[0].id;
    const claims = (overrides = {}) => ({ sub: owner, role:'authenticated', session_id:'native-correction-fixture',
      aal:'aal1',amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}],...overrides });
    async function roleCall(role, sql, values, c = claims(), inside = false) {
      if (!inside) await db.query('begin');
      try {
        await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[c.sub ?? '',JSON.stringify(c)]);
        await db.query('set local role ' + role);
        const out = (await db.query(sql,values)).rows[0].v;
        if (!inside) await db.query('commit'); else await db.query('reset role');
        return out;
      } catch (e) { if (!inside) await db.query('rollback'); throw e; }
    }
    const rpc = (name,input) => roleCall('anon','select public.'+name+'($1,$2) v',[token,input]);
    const native = (name,input,c = claims(),inside = false) => roleCall('authenticated','select public.'+name+'($1) v',[input],c,inside);
    const project = await rpc('clued_project_mutate',{operation:'create',canonical_project_id:PROJECT,project_schema_version:1,
      base_version:null,idempotency_key:uid(),mutation:{name:'Synthetic correction fixture',progress_status:'active',certainty_status:'confirmed',aliases:[]}});
    assert.equal(project.status,'committed');
    await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Synthetic correction task','Ephemeral SQL fixture','project',$3,'task','active',1,'active',$4,
      '{"execution_bucket":"next"}','{}','{}','observed','Synthetic fixture')`,[TASK,owner,PROJECT,scope]);
    const plan = JSON.parse(await fs.readFile(path.join(sourceRepo,'development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json'),'utf8'));
    const resources = [...Object.values(plan.targets).map(id => 'record:'+id),
      ...Object.values(plan.owner_anchor_refs).map(r => `record:${r.id}@${r.version}#${r.content_hash}`),planResource].sort();
    const req = await rpc('clued_owner_request_v1',{action:'model.dataset_split.bootstrap',scope,task_id:TASK,resources,
      idempotency_key:plan.idempotency_key,suggested_grant:{expires_seconds:3600,max_uses:1}});
    assert.equal(req.status,'committed');
    // Pin synthetic fixture IDs before issuing the genuine Native token.
    await db.query('update clued_private.owner_requests_v1 set id=$1 where id=$2',[REQUEST,req.request.request_id]);
    const oldIssue = await native('clued_owner_grant_confirmation_issue_v1',{request_id:REQUEST,choice:'once',grantee:'requester'});
    assert.equal(oldIssue.status,'issued');
    const oldGrant = await native('clued_owner_grant_v1',{confirmation_token:oldIssue.confirmation_token,view_digest:oldIssue.view_digest});
    assert.equal(oldGrant.status,'committed');
    await db.query('update clued_private.owner_requests_v1 set grant_id=null where id=$1',[REQUEST]);
    await db.query('update clued_private.owner_grants_v1 set id=$1 where id=$2',[OLD,oldGrant.grant.grant_id]);
    await db.query('update clued_private.owner_requests_v1 set grant_id=$1 where id=$2',[OLD,REQUEST]);
    await db.query(await fs.readFile(path.join(sourceApp,'supabase/migrations',closeout),'utf8'));
    await assertGatewayCloseoutBoundary(db);
    const callerCatalog = await snapshotCallerCatalog(db);
    await db.query(await fs.readFile(path.join(sourceApp,'supabase/migrations',closeout),'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(db),callerCatalog,'G6 replay preserves the actual Native correction writer and caller ACLs');
    await assertGatewayCloseoutBoundary(db);

    // A separate synthetic current client obtains a genuine exclusive Task
    // claim through the actual G6 gateway role in this local database only.
    const newToken = hash();
    const binding = (await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Current successor fixture',$2,array['context:read','context:write','audit:read'],array['*']) returning id`,
      [owner,newToken])).rows[0].id;
    const foreignBinding = (await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','Foreign successor fixture',$2,array['context:read','context:write'],array['*']) returning id`,
      [other,hash()])).rows[0].id;
    await db.query('update public.clued_memories set version=593 where id=$1',[TASK]);
    const targets=Object.values(plan.targets);
    const ownClaim=await roleCall('clued_worker_gateway','select public.clued_work_claim_v1($1,$2) v',
      [newToken,{scope,task_id:TASK,holder_label:'Self-reported synthetic successor holder',
        holder_client:'isolated Node test',holder_session_ref:'successor-fixture-'+uid(),
        write_set:targets.map(id=>'record:'+id),idempotency_key:'successor-claim-'+uid()}],
      {...claims(),role:'clued_worker_gateway'});
    assert.equal(ownClaim.status,'committed');
    const claimId=ownClaim.claim.claim_id;
    // Real v12 authorization rows, not mocked permission predicates.
    const issuer=hash(),authRequest=uid();
    await db.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,'https://synthetic.example.invalid','Successor fixture')",[issuer]);
    await db.query(`insert into clued_private.authorization_requests_v12(id,owner_id,issuer_hash,request_digest,
      client_id,client_name,redirect_uri,resource,requested_scopes,eligible,status,binding_id)
      values($1,$2,$3,$4,'synthetic-successor','Synthetic fixture','https://synthetic.example.invalid/callback',
        'https://synthetic.example.invalid',array['context:read','context:write'],'{}','approved',$5)`,
      [authRequest,owner,issuer,hash(),binding]);
    await db.query(`insert into clued_private.authorizations_v12(binding_id,request_id,owner_id,client_id,client_name,resource,expires_at)
      values($1,$2,$3,'synthetic-successor','Synthetic fixture','https://synthetic.example.invalid',now()+interval '2 hours')`,
      [binding,authRequest,owner]);
    await db.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
      values($1,'scope',$2,'canonical',array['read','write']),($1,'scope','global','canonical',array['read'])`,[binding,scope]);
    await db.query('delete from clued_private.raw_binding_grants_v1 where binding_id=$1',[binding]);
    const globalSource=uid(),globalIntent=uid();
    await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,record_type,status,
      record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'Synthetic registered Global intent','Local regression only','global','decision','active',1,'active','global',
        $3,'{}','{}','user_explicit','Synthetic fixture')`,[globalSource,owner,{rationale:'Synthetic source',
        execution_intents:[{id:globalIntent,completion_criteria:'Synthetic successor validation'}]}]);
    await db.query("update public.clued_memories set type_fields=type_fields||jsonb_build_object('execution_intent',$2::jsonb) where id=$1",
      [TASK,{id:globalIntent,source_id:globalSource,source_version:1,source_scope:'global'}]);

    const signature='clued_private.dataset_split_grant_correction_context_v1(uuid,uuid)';
    const linkSignature='clued_private.dataset_split_grant_correction_link_v1(uuid,jsonb,uuid)';
    const writerSignature='public.clued_owner_grant_v1(jsonb)';
    const def=async sig=>(await db.query('select pg_get_functiondef($1::regprocedure) v',[sig])).rows[0].v;
    const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
    const beforeBindingContext=await def(signature),beforeBindingLink=await def(linkSignature);
    assert.equal(digest(beforeBindingContext),'b95e8ddba5b4400078ae6143735b80aa306bdf44ba6c43c42cbe602b1e98ecf1');
    assert.equal(digest(beforeBindingLink),'68a93c873c547ff17bfa09ddde117276511eaa430425b713f2104ad7c204ca94');
    await db.query(await fs.readFile(path.join(sourceApp,'supabase/migrations',bindingFile),'utf8'));
    const predecessorContext=await def(signature),predecessorLink=await def(linkSignature);
    assert.equal(digest(predecessorContext),'e6479cd30ae02ad9a2d82caf14bc82766cc654983508747cda7f34279c2c83ca');
    assert.equal(digest(predecessorLink),'2e73e0bc85ee2bed7a789f5e29490992e291613d9240cb2191c01581ec1d0819');
    const writerBefore=await def(writerSignature);
    const draft=await fs.readFile(candidateSqlPath,'utf8');
    const pinned=draft.match(/adoption_ref constant jsonb := '([\s\S]*?)'::jsonb;/);
    const adoptedShape=draft.match(/scope_without_grantee constant jsonb := '([\s\S]*?)'::jsonb;/);
    assert.ok(pinned && adoptedShape,'the exact private pin and frozen scope must exist once');
    assert.equal(draft.match(/adoption_ref constant jsonb := /g).length,1);
    const productionRef=JSON.parse(pinned[1]);
    const adoptedScope={...JSON.parse(adoptedShape[1]),grantee_binding_ref:binding};
    assert.equal(productionRef.version,2);
    assert.equal(adoptedScope.task_version,593);
    assert.equal(adoptedScope.scope_approval_only,true);
    assert.equal(adoptedScope.production_approved,false);
    assert.equal(adoptedScope.bootstrap_approved,false);
    assert.deepEqual([...adoptedScope.resources].sort(),resources);
    assert.notDeepEqual(adoptedScope.resources,resources,'frozen resource order and canonical Grant order intentionally differ');
    const adoptedId=uid();
    const mutation={title:'Synthetic expired-scope adoption',content:'Synthetic scope preparation, never Native approval',
      type_fields:{rationale:'Disposable regression fixture'},relations:{expired_native_adopted_scope:adoptedScope}};
    const m1=async input=>roleCall('clued_worker_gateway','select public.clued_record_mutate($1,$2) v',
      [newToken,input],{...claims(),role:'clued_worker_gateway'});
    const create=await m1({operation:'create',id:adoptedId,record_type:'decision',record_schema_version:1,
      lifecycle_status:'active',scope,idempotency_key:uid(),authority:'user_explicit',user_confirmed:true,
      confidence_reason:'Synthetic fixture only',source_refs:[],source_unavailable_reason:null,mutation});
    assert.equal(create.status,'committed',JSON.stringify(create));
    const updated=await m1({operation:'update',id:adoptedId,record_type:'decision',record_schema_version:1,
      lifecycle_status:'active',scope,base_version:1,idempotency_key:uid(),authority:'user_explicit',user_confirmed:true,
      confidence_reason:'Synthetic fixture only',mutation:{content:'Synthetic exact v2 preparation, never Native approval'}});
    assert.equal(updated.status,'committed',JSON.stringify(updated));
    const adopted=(await db.query('select * from public.clued_memories where id=$1',[adoptedId])).rows[0];
    const adoptionReceipt=(await db.query('select * from public.clued_audit_receipts where id=$1',[adopted.receipt_id])).rows[0];
    const adoptionRef={id:adoptedId,version:Number(adopted.version),content_hash:adopted.content_hash,
      receipt_id:adopted.receipt_id,event_id:String(adoptionReceipt.event_ids[0]),plan_sha256:productionRef.plan_sha256};
    assert.equal(adoptionRef.version,2);
    assert.notEqual(adoptionRef.id,productionRef.id,'the production adoption row is never seeded');
    assert.notEqual(adoptionRef.receipt_id,productionRef.receipt_id);
    assert.equal(adoptionReceipt.binding_id,binding);
    assert.equal(adoptionReceipt.operation_family,'record_mutation');
    const chain=async()=>(await db.query(`select clued_private.model_domain_owner_chain_successor(b,m) v
      from public.clued_agent_bindings b,public.clued_memories m where b.id=$1 and m.id=$2`,[binding,adoptedId])).rows[0].v;
    const actualChain=await chain();
    assert.equal(actualChain.event.actor_binding_ref,binding);
    assert.equal(actualChain.event.actor_user_id,owner);
    assert.equal(String(actualChain.event.id),adoptionRef.event_id);
    assert.equal(actualChain.receipt.id,adoptionRef.receipt_id);
    assert.equal((await db.query(`select clued_private.m1_record_content_hash(record_type,canonical_scope,lifecycle_status,
      title,content,type_fields,relations,source_refs,source_unavailable_reason,authority,observed_at,closed_at,
      confidence,confidence_reason) h from public.clued_memories where id=$1`,[adoptedId])).rows[0].h,adoptionRef.content_hash);
    assert.notEqual(digest(adopted.content),adoptionRef.content_hash,'a body hash does not substitute for the whole server hash');

    // Compile only a disposable SQL string from the real M1 fixture's exact
    // server Ref. The reviewed file and production Source pin are untouched.
    const compile=ref=>draft.replace(pinned[0],`adoption_ref constant jsonb := '${JSON.stringify(ref)}'::jsonb;`);
    const candidateSql=compile(adoptionRef);
    await db.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[originalBinding]);
    const viewName='clued_dataset_split_grant_correction_view_v1';
    const issueName='clued_dataset_split_grant_correction_issue_v1';
    const preview=()=>native(viewName,{request_id:REQUEST});
    const context=async()=>(await db.query('select clued_private.dataset_split_grant_correction_context_v1($1,$2) v',[owner,REQUEST])).rows[0].v;
    const count=async()=>(await db.query('select count(*)::int n from clued_private.owner_grants_v1')).rows[0].n;
    const oldRow=async()=>(await db.query('select to_jsonb(g) v from clued_private.owner_grants_v1 g where id=$1',[OLD])).rows[0].v;
    const requestRow=async()=>(await db.query('select to_jsonb(r) v from clued_private.owner_requests_v1 r where id=$1',[REQUEST])).rows[0].v;
    const tokenRow=async id=>(await db.query('select to_jsonb(t) v from clued_private.native_confirmation_tokens t where id=$1',[id])).rows[0].v;
    const originalRequest=await requestRow();
    const originalGrant=await oldRow();
    const originalToken=await tokenRow(originalGrant.token_id);
    const originalReceipt=(await db.query('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[originalGrant.receipt_id])).rows[0].v;
    const liveBefore=await context();
    const livePublicBefore=await preview();
    const catalogBefore=await snapshotCallerCatalog(db);

    await t.test('exact full predecessor hashes and ACLs reject with zero helper/catalog/data writes',async()=>{
      const cases=[
        async()=>{await db.query(beforeBindingContext);await db.query(beforeBindingLink);},
        async()=>db.query(predecessorContext.replace('begin\n','begin\n -- incompatible context fixture\n')),
        async()=>db.query(predecessorLink.replace('begin\n','begin\n -- incompatible link fixture\n')),
        async()=>db.query('grant execute on function '+signature+' to public'),
        async()=>db.query('grant execute on function '+linkSignature+' to clued_worker_gateway'),
        async()=>db.query('grant execute on function '+signature+' to postgres with grant option')
      ];
      for(const corrupt of cases){
        await db.query('begin');
        try{
          await corrupt();const before=await snapshotCallerCatalog(db);
          const beforeOld=await oldRow(),beforeRequest=await requestRow();
          await db.query('savepoint candidate_apply');
          await assert.rejects(db.query(candidateSql),/dataset_split_expired_successor_(source|acl)_changed/);
          await db.query('rollback to savepoint candidate_apply');
          assert.deepEqual(await snapshotCallerCatalog(db),before);
          assert.deepEqual(await oldRow(),beforeOld);assert.deepEqual(await requestRow(),beforeRequest);
          assert.equal(await count(),1);
        }finally{await db.query('rollback');}
      }
    });
    await db.query(candidateSql);
    const installedContext=await def(signature),installedLink=await def(linkSignature);
    await t.test('only two private helpers change; LIVE full private/public objects remain exactly equal',async()=>{
      assert.equal(await def(writerSignature),writerBefore);
      assert.deepEqual(await context(),liveBefore);
      assert.deepEqual(await preview(),livePublicBefore);
      assert.equal(Object.hasOwn((await context()).choices,'correction_mode'),false);
      const after=await snapshotCallerCatalog(db),changed=[signature,linkSignature];
      assert.deepEqual(after.map(x=>({...x,source_hash:null})),catalogBefore.map(x=>({...x,source_hash:null})));
      assert.deepEqual(after.filter(x=>!changed.includes(x.signature)),catalogBefore.filter(x=>!changed.includes(x.signature)));
      await assertGatewayCloseoutBoundary(db);
      await assert.rejects(db.query(candidateSql),/dataset_split_expired_successor_source_changed/);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        for(const sig of [signature,linkSignature,'clued_private.model_domain_owner_chain_successor(public.clued_agent_bindings,public.clued_memories)'])
          assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') v",[role,sig])).rows[0].v,false);
      }
    });

    const setRemaining=async interval=>db.query(`with clock as (select clock_timestamp()+$2::interval expiry)
      update clued_private.owner_grants_v1 set expires_at=clock.expiry,granted_at=clock.expiry-interval '24 hours'
      from clock where id=$1`,[OLD,interval]);
    async function isolated(fn){await db.query('begin');try{return await fn();}finally{await db.query('rollback');}}
    async function deniedMutation(sql,values=[],reason){
      await isolated(async()=>{
        await db.query(sql,values);await assert.rejects(native(viewName,{request_id:REQUEST},claims(),true),reason);
      });assert.equal(await count(),1);
    }
    await t.test('LIVE >1h, positive <=1h GAP, and expired/equality branches use actual server time',async()=>{
      for(const [interval,branch] of [['1 hour 5 seconds','live'],['1 hour','gap'],['30 minutes','gap'],['1 second','gap'],['0 seconds','expired'],['-1 second','expired']]){
        await isolated(async()=>{
          await setRemaining(interval);
          if(branch==='gap')await assert.rejects(native(viewName,{request_id:REQUEST},claims(),true),/dataset_split_correction_grant_not_eligible/);
          else{
            const v=await native(viewName,{request_id:REQUEST},claims(),true);
            assert.equal(v.status,'eligible');
            assert.equal(Object.hasOwn(v.confirmation_view.correction,'expired_reauthorization'),branch==='expired');
          }
        });
      }
      await deniedMutation("with clock as (select clock_timestamp()+interval '1 second' stamp) update clued_private.owner_grants_v1 set granted_at=clock.stamp,expires_at=clock.stamp+interval '24 hours' from clock where id=$1",[OLD],/grant_not_eligible/);
    });
    // The original genuine Native evidence remains byte-identical; only the
    // fixture's old Grant clock is moved to represent a naturally expired row.
    await setRemaining('-1 minute');
    const expiredOriginalGrant=await oldRow();
    await t.test('expired preview signs stable rule/Ref and canonical six resources without granting anything',async()=>{
      const a=await preview(),b=await preview();assert.deepEqual(a,b);
      const v=a.confirmation_view,c=(await context()).choices;
      assert.equal(v.grantee.binding_id,binding);assert.deepEqual(v.resources,resources);
      assert.equal(v.expires_seconds,3600);assert.equal(v.max_uses,1);
      assert.equal(v.correction.previous_expires_at,expiredOriginalGrant.expires_at);
      assert.equal(v.correction.effect,'EXPIRED_UNUSED_BOOTSTRAP_GRANT_REAUTHORIZED_BY_FRESH_NATIVE_OWNER');
      assert.deepEqual(v.correction.expired_reauthorization,{schema:'clued.dataset-split-expired-native-reauthorization.v1',
        mode:'EXPIRED_FRESH_NATIVE_OWNER_GRANT',time_rule:'WRITER_GRANTED_AT_PLUS_3600_SECONDS',adoption_server_ref:adoptionRef});
      assert.equal(c.correction_mode,'EXPIRED_FRESH_NATIVE_OWNER_GRANT');
      assert.equal(c.correction_time_rule,'WRITER_GRANTED_AT_PLUS_3600_SECONDS');
      assert.deepEqual(c.correction_adoption_server_ref,adoptionRef);
      assert.equal(c.request_id,null);assert.equal(c.correction_request_id,REQUEST);
      assert.equal(await count(),1);assert.deepEqual(await oldRow(),expiredOriginalGrant);
      for(const hidden of [token,newToken,adoptionRef.content_hash+'-fake',owner,'lease_key_hash','token_hash','actor_user_id'])
        assert.ok(!JSON.stringify(a).includes(hidden));
      assert.equal((await db.query('select count(*)::int n from public.clued_memories where id=any($1::uuid[])',[targets])).rows[0].n,0);
    });

    await t.test('missing/null/changed Source-pinned server Ref fails only the expired branch',async()=>{
      const variants=[null,{...adoptionRef,id:uid()},{...adoptionRef,version:1},
        {...adoptionRef,content_hash:digest(adopted.content)},{...adoptionRef,receipt_id:uid()},
        {...adoptionRef,event_id:String(BigInt(adoptionRef.event_id)+1n)},
        {...adoptionRef,plan_sha256:'f'.repeat(64)},productionRef];
      for(const ref of variants){
        await isolated(async()=>{
          await db.query(predecessorContext);await db.query(predecessorLink);
          await db.query(compile(ref));
          await assert.rejects(native(viewName,{request_id:REQUEST},claims(),true),/expired_scope|OWNER_M1/);
        });assert.equal(await count(),1);
      }
      await isolated(async()=>{
        await db.query(predecessorContext);await db.query(predecessorLink);await db.query(compile(null));
        await setRemaining('2 hours');
        const v=await native(viewName,{request_id:REQUEST},claims(),true);
        assert.equal(Object.hasOwn(v.confirmation_view.correction,'expired_reauthorization'),false);
      });
      assert.equal(await def(signature),installedContext);assert.equal(await def(linkSignature),installedLink);
    });
    await t.test('real adopted Record whole hash and actual M1 Receipt/Event columns are mandatory',async()=>{
      const faults=[
        ['update public.clued_memories set version=version+1 where id=$1',[adoptedId]],
        ["update public.clued_memories set title=title||' drift' where id=$1",[adoptedId]],
        ["update public.clued_memories set content=content||' drift' where id=$1",[adoptedId]],
        ["update public.clued_memories set relations=jsonb_set(relations,'{expired_native_adopted_scope,grantee_binding_ref}',to_jsonb($2::text)) where id=$1",[adoptedId,foreignBinding]],
        ["update public.clued_memories set content_hash=$2 where id=$1",[adoptedId,digest(adopted.content)]],
        ["update public.clued_memories set authority='observed' where id=$1",[adoptedId]],
        ["update public.clued_memories set lifecycle_status='revoked' where id=$1",[adoptedId]],
        ['update public.clued_memories set user_id=$2 where id=$1',[adoptedId,other]],
        ['update public.clued_audit_receipts set binding_id=null where id=$1',[adopted.receipt_id]],
        ['update public.clued_audit_receipts set binding_id=$2 where id=$1',[adopted.receipt_id,foreignBinding]],
        ["update public.clued_audit_receipts set operation_family='note' where id=$1",[adopted.receipt_id]],
        ["update public.clued_audit_receipts set committed_versions=jsonb_build_object($2::text,1) where id=$1",[adopted.receipt_id,adoptedId]],
        ["update public.clued_audit_receipts set event_ids=array[$2,$2] where id=$1",[adopted.receipt_id,adoptionRef.event_id]],
        ['update public.clued_context_events set actor_user_id=$2 where id=$1',[adoptionRef.event_id,other]],
        ['update public.clued_context_events set actor_binding_ref=$2 where id=$1',[adoptionRef.event_id,foreignBinding]],
        ["update public.clued_context_events set event_scope='global' where id=$1",[adoptionRef.event_id]],
        ["update public.clued_context_events set result='failure' where id=$1",[adoptionRef.event_id]]
      ];
      for(const [sql,values] of faults)await deniedMutation(sql,values);
      assert.deepEqual(await chain(),actualChain);
      // An actual existing M1 Event becomes a synthetic active blocker. The
      // real fence implementation, not a stub, must return non-CURRENT.
      for(const blockedScope of [scope,'global']){
        await isolated(async()=>{
          await db.query(`insert into clued_private.event_truth_carriers(event_id,user_id,canonical_scope,dimensions,
            visibility,source_kind,carrier_state) values($1,$2,$3,array['decision'],'work_log','direct','ACTIVE_UNSTRUCTURED')
            on conflict(event_id) do update set canonical_scope=excluded.canonical_scope,dimensions=excluded.dimensions,
              visibility='work_log',carrier_state='ACTIVE_UNSTRUCTURED',materialized_record_id=null,materialized_record_version=null`,
            [adoptionRef.event_id,owner,blockedScope]);
          const target=blockedScope===scope?adoptedId:globalSource;
          assert.notEqual((await db.query('select clued_private.record_currentness_fence($1,$2,array[\'global\',$3]) v',
            [owner,target,scope])).rows[0].v,'CURRENT');
          await assert.rejects(native(viewName,{request_id:REQUEST},claims(),true));
        });
      }
    });
    await t.test('no claim, ambiguous/race/expired/foreign/uncovered claim and real permission loss deny',async()=>{
      const faults=[
        ["update clued_private.work_claims_v1 set status='RELEASED' where claim_id=$1",[claimId]],
        [`insert into clued_private.work_claims_v1 select (jsonb_populate_record(null::clued_private.work_claims_v1,
          to_jsonb(c)||jsonb_build_object('claim_id',$2::uuid,'copy_index',1,'idempotency_key','duplicate-'||($2::uuid)::text))).*
          from clued_private.work_claims_v1 c where c.claim_id=$1`,[claimId,uid()]],
        [`insert into clued_private.work_claim_task_modes_v1(user_id,task_id,mode,copies,shared_resources,enabled_session_id,token_id,receipt_id)
          select $1,$2,'multi',2,array['record:'||($2::uuid)::text],'synthetic-race',token_id,receipt_id
          from clued_private.owner_grants_v1 where id=$3`,[owner,TASK,OLD]],
        ["update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '3 hours',expires_at=clock_timestamp()-interval '1 hour' where claim_id=$1",[claimId]],
        ['update clued_private.work_claims_v1 set holder_binding_id=$2 where claim_id=$1',[claimId,foreignBinding]],
        ["update clued_private.work_claims_v1 set write_set=$2::text[] where claim_id=$1",[claimId,targets.slice(0,2).map(id=>'record:'+id)]],
        ["update clued_private.work_claims_v1 set write_set=array['repo:*'] where claim_id=$1",[claimId]],
        ["update clued_private.authorization_entries_v12 set actions=array['read'] where binding_id=$1 and resource_id=$2",[binding,scope]],
        ["update clued_private.authorization_entries_v12 set actions=array['write'] where binding_id=$1 and resource_id=$2",[binding,scope]],
        ["delete from clued_private.authorization_entries_v12 where binding_id=$1 and resource_id='global'",[binding]],
        ['update clued_private.authorizations_v12 set revoked_at=clock_timestamp() where binding_id=$1',[binding]],
        ["update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1",[binding]],
        ['update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[binding]],
        ["update public.clued_memories set lifecycle_status='completed' where id=$1",[TASK]],
        ['update public.clued_memories set version=594 where id=$1',[TASK]]
      ];
      for(const [sql,values] of faults)await deniedMutation(sql,values);
    });
    await t.test('expired unused original still requires original 24h Native history and approved_once pointer',async()=>{
      for(const status of ['rejected','pending','granted'])
        await deniedMutation('update clued_private.owner_requests_v1 set status=$2 where id=$1',[REQUEST,status]);
      await deniedMutation("with clock as (select clock_timestamp() stamp) update clued_private.owner_requests_v1 set status='pending',created_at=clock.stamp-interval '24 hours',expires_at=clock.stamp-interval '1 minute' from clock where id=$1",[REQUEST],/request_not_eligible/);
      // Natural expiry is a deadline in this schema, not a fifth status. It
      // must not be fabricated into a row in order to claim guard coverage.
      await isolated(async()=>{
        await assert.rejects(db.query("update clued_private.owner_requests_v1 set status='expired' where id=$1",[REQUEST]),
          e=>e.code==='23514' && e.constraint==='owner_requests_v1_status_check');
      });
      await deniedMutation('update clued_private.owner_grants_v1 set uses=1 where id=$1',[OLD]);
      await deniedMutation('update clued_private.owner_grants_v1 set revoked_at=clock_timestamp() where id=$1',[OLD]);
      await deniedMutation("update clued_private.owner_grants_v1 set granted_at=expires_at-interval '1 hour' where id=$1",[OLD]);
      await deniedMutation('update clued_private.owner_grants_v1 set grantee_binding_id=$2 where id=$1',[OLD,binding]);
      await deniedMutation("update clued_private.owner_grants_v1 set resources=array['repo:other/**'] where id=$1",[OLD]);
      await deniedMutation("update public.clued_audit_receipts set metadata=jsonb_set(metadata,'{principal}','\"agent\"') where id=$1",[originalGrant.receipt_id]);
      await deniedMutation('update public.clued_memories set content=content||\' invalid source\',version=version+1 where id=$1',[globalSource]);
      // This predecessor schema has no auto_approved column. A disposable
      // future-field negative proves that the JSON-row guard still rejects it.
      await isolated(async()=>{
        await db.query('alter table clued_private.owner_grants_v1 add column auto_approved boolean default false');
        await db.query('update clued_private.owner_grants_v1 set auto_approved=true where id=$1',[OLD]);
        await assert.rejects(native(viewName,{request_id:REQUEST},claims(),true),/grant_not_eligible/);
      });
    });
    await t.test('exact public input, native session/Owner identity and private ACL cannot be bypassed',async()=>{
      for(const input of [{request_id:REQUEST,mode:'EXPIRED_FRESH_NATIVE_OWNER_GRANT'},
        {request_id:REQUEST,grantee_binding_id:binding},{request_id:REQUEST,expires_seconds:3600},
        {request_id:REQUEST,adoption_server_ref:adoptionRef},{request_id:uid()},{}])
        await assert.rejects(native(viewName,input));
      await assert.rejects(native(viewName,{request_id:REQUEST},claims({sub:other})));
      await assert.rejects(native(viewName,{request_id:REQUEST},claims({session_id:null})));
      await assert.rejects(roleCall('anon','select public.'+viewName+'($1) v',[{request_id:REQUEST}]));
      await assert.rejects(roleCall('clued_worker_gateway','select public.'+issueName+'($1) v',[{request_id:REQUEST}]));
      await assert.rejects(roleCall('authenticated','select clued_private.dataset_split_grant_correction_context_v1($1,$2) v',[owner,REQUEST]));
    });

    const givenCount=async()=>(await db.query("select count(*)::int n from public.clued_audit_receipts where metadata->>'receipt_kind'='OWNER_GRANT_GIVEN'")).rows[0].n;
    const revokedCount=async()=>(await db.query("select count(*)::int n from public.clued_audit_receipts where operation='owner_grant_revoke' and object_id=$1",[OLD])).rows[0].n;
    const commit=issued=>native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest});
    async function assertNoGrantEffects(beforeOld,beforeRequest,beforeGiven,beforeRevoked){
      assert.equal(await count(),1);assert.deepEqual(await oldRow(),beforeOld);assert.deepEqual(await requestRow(),beforeRequest);
      assert.equal(await givenCount(),beforeGiven);assert.equal(await revokedCount(),beforeRevoked);
    }
    async function assertDurableBurn(issued,result){
      assert.equal(result.status,'rejected',JSON.stringify(result));
      const observer=server.getPgClient('postgres','127.0.0.1');await observer.connect();
      try{
        const token=(await observer.query('select * from clued_private.native_confirmation_tokens where id=$1',[issued.token_id])).rows[0];
        assert.equal(token.consume_outcome,'rejected');assert.ok(token.consumed_at);assert.ok(token.consumed_receipt_id);
        const r=(await observer.query('select * from public.clued_audit_receipts where id=$1',[token.consumed_receipt_id])).rows[0];
        assert.equal(r.operation,'owner_grant');assert.equal(r.metadata.receipt_kind,'OWNER_GRANT_REJECTED');
        assert.equal(r.metadata.token_id,issued.token_id);
      }finally{await observer.end();}
    }
    await t.test('committed claim drift causes persistent real token burn and reused token cannot grant',async()=>{
      const issued=await native(issueName,{request_id:REQUEST});assert.equal(issued.status,'issued');
      const old=await oldRow(),request=await requestRow(),given=await givenCount(),revokes=await revokedCount();
      const lease=(await db.query('select lease_version from clued_private.work_claims_v1 where claim_id=$1',[claimId])).rows[0].lease_version;
      await db.query('update clued_private.work_claims_v1 set lease_version=lease_version+1 where claim_id=$1',[claimId]);
      const result=await commit(issued);await assertDurableBurn(issued,result);
      await assertNoGrantEffects(old,request,given,revokes);
      const replay=await commit(issued);assert.equal(replay.status,'rejected');
      assert.equal(replay.error_code,'confirmation_token_reused');
      await db.query('update clued_private.work_claims_v1 set lease_version=$2 where claim_id=$1',[claimId,lease]);
    });
    await t.test('valid M1 proof metadata drift alone changes the private snapshot and persists a stale-token rejection',async()=>{
      const issued=await native(issueName,{request_id:REQUEST});
      const old=await oldRow(),request=await requestRow(),given=await givenCount(),revokes=await revokedCount();
      await db.query("update public.clued_audit_receipts set metadata=metadata||'{\"synthetic_snapshot_drift\":true}'::jsonb where id=$1",[adopted.receipt_id]);
      const changedProof=await chain();assert.equal(changedProof.receipt.metadata.synthetic_snapshot_drift,true);
      assert.equal(changedProof.event.actor_binding_ref,binding,'the genuine chain is still eligible before the digest comparison');
      const result=await commit(issued);assert.equal(result.error_code,'confirmation_view_stale');
      await assertDurableBurn(issued,result);await assertNoGrantEffects(old,request,given,revokes);
      await db.query("update public.clued_audit_receipts set metadata=metadata-'synthetic_snapshot_drift' where id=$1",[adopted.receipt_id]);
    });
    await t.test('outer PostgreSQL ROLLBACK also removes rejection burn and rejected Receipt',async()=>{
      const issued=await native(issueName,{request_id:REQUEST});const before=await tokenRow(issued.token_id);
      let receipt;
      await isolated(async()=>{
        await db.query('update public.clued_memories set version=594 where id=$1',[TASK]);
        const result=await native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest},claims(),true);
        assert.equal(result.status,'rejected');const burned=await tokenRow(issued.token_id);
        assert.equal(burned.consume_outcome,'rejected');receipt=burned.consumed_receipt_id;
      });
      assert.deepEqual(await tokenRow(issued.token_id),before);
      assert.equal((await db.query('select count(*)::int n from public.clued_audit_receipts where id=$1',[receipt])).rows[0].n,0);
    });

    await t.test('Task, lease/fence and actual permission metadata drift are bound to the Native token',async()=>{
      const faults=[
        ["update public.clued_memories set title=title||' drift' where id=$1",[TASK]],
        ["update public.clued_memories set content=content||' drift' where id=$1",[TASK]],
        ['update public.clued_memories set version=version+1 where id=$1',[TASK]],
        ['update clued_private.work_claims_v1 set fence=fence+1 where claim_id=$1',[claimId]],
        ['update clued_private.work_claims_v1 set lease_version=lease_version+1 where claim_id=$1',[claimId]],
        ["update clued_private.work_claims_v1 set holder_session_ref='drifted-session' where claim_id=$1",[claimId]],
        ['update clued_private.authorizations_v12 set version=version+1 where binding_id=$1',[binding]],
        ["update clued_private.authorization_entries_v12 set actions=array['read','write','audit'] where binding_id=$1 and resource_id=$2",[binding,scope]],
        ["update public.clued_memories set title=title||' drift' where id=$1",[adoptedId]]
      ];
      for(const [sql,values] of faults){
        const issued=await native(issueName,{request_id:REQUEST});assert.equal(issued.status,'issued');
        await isolated(async()=>{
          await db.query(sql,values);
          const result=await native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest},claims(),true);
          assert.equal(result.status,'rejected',JSON.stringify(result));
          assert.equal((await tokenRow(issued.token_id)).consume_outcome,'rejected');
          assert.equal(await count(),1);assert.equal((await oldRow()).revoked_at,null);
        });
      }
    });
    await t.test('5min issue, session/digest/revoked/expired token and same-transaction issue keep Native protocol',async()=>{
      for(const kind of ['session','digest','revoked','expired']){
        const issued=await native(issueName,{request_id:REQUEST});
        const token=await tokenRow(issued.token_id);
        assert.equal(Date.parse(token.expires_at)-Date.parse(token.issued_at),300000);
        const input={confirmation_token:issued.confirmation_token,view_digest:issued.view_digest};
        if(kind==='digest')input.view_digest='f'.repeat(64);
        if(kind==='revoked')await native(issueName,{request_id:REQUEST});
        if(kind==='expired'){
          input.confirmation_token='clued_ogr_'+hash();
          await db.query(`insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
            confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
            select user_id,action,subject_key||':expired-fixture',subject_version,native_choices,confirmation_view,view_digest,
              $1,session_id,auth_time,clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '5 minutes'
            from clued_private.native_confirmation_tokens where id=$2`,[digest(input.confirmation_token),issued.token_id]);
        }
        const old=await oldRow(),request=await requestRow(),given=await givenCount(),revokes=await revokedCount();
        const result=await native('clued_owner_grant_v1',input,kind==='session'?claims({session_id:'another-native-session'}):claims());
        assert.equal(result.status,'rejected',JSON.stringify(result));
        await assertNoGrantEffects(old,request,given,revokes);
      }
      await isolated(async()=>{
        const issued=await native(issueName,{request_id:REQUEST},claims(),true);
        const result=await native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest},claims(),true);
        assert.equal(result.status,'rejected');assert.equal(result.error_code,'confirmation_token_same_request');
        assert.equal(await count(),1);
      });
    });
    await t.test('CAS no-match after revoke rolls back Grant/GIVEN/revoke/pointer while persisting rejection burn',async()=>{
      await db.query(`create function public.fixture_expired_cas_failure() returns trigger language plpgsql as $$
        begin if new.id='${REQUEST}'::uuid and new.grant_id is distinct from old.grant_id then return null; end if; return new; end$$;
        create trigger fixture_expired_cas_failure before update on clued_private.owner_requests_v1
        for each row execute function public.fixture_expired_cas_failure()`);
      try{
        const issued=await native(issueName,{request_id:REQUEST});
        const old=await oldRow(),request=await requestRow(),given=await givenCount(),revokes=await revokedCount();
        const result=await commit(issued);assert.equal(result.error_code,'confirmation_view_stale');
        await assertDurableBurn(issued,result);await assertNoGrantEffects(old,request,given,revokes);
      }finally{await db.query('drop trigger fixture_expired_cas_failure on clued_private.owner_requests_v1; drop function public.fixture_expired_cas_failure()');}
    });
    await t.test('real link rejects a new granted_at before old expiry or after server time; no host clock stub',async()=>{
      for(const timeExpression of ["(select expires_at-interval '1 second' from clued_private.owner_grants_v1 where id='"+OLD+"'::uuid)","clock_timestamp()+interval '5 minutes'"]){
        await db.query(`create function public.fixture_expired_clock_failure() returns trigger language plpgsql as $$
          begin if new.request_id is null and new.user_id='${owner}'::uuid and new.action='model.dataset_split.bootstrap' then
            new.granted_at:=${timeExpression};new.expires_at:=new.granted_at+interval '1 hour';end if;return new;end$$;
          create trigger fixture_expired_clock_failure before insert on clued_private.owner_grants_v1
          for each row execute function public.fixture_expired_clock_failure()`);
        try{
          const issued=await native(issueName,{request_id:REQUEST});
          const old=await oldRow(),request=await requestRow(),given=await givenCount(),revokes=await revokedCount();
          const result=await commit(issued);assert.equal(result.error_code,'dataset_split_correction_successor_not_exact');
          await assertDurableBurn(issued,result);await assertNoGrantEffects(old,request,given,revokes);
        }finally{await db.query('drop trigger fixture_expired_clock_failure on clued_private.owner_grants_v1; drop function public.fixture_expired_clock_failure()');}
      }
    });
    await t.test('real adopted/work/claim/permission/Project lock contention rejects promptly and burns token',async()=>{
      for(const kind of ['adopted-row','work-lock','claim-row','authorization-row','project-row']){
        const issued=await native(issueName,{request_id:REQUEST});
        const blocker=server.getPgClient('postgres','127.0.0.1');await blocker.connect();
        const old=await oldRow(),request=await requestRow(),given=await givenCount(),revokes=await revokedCount();
        try{
          await blocker.query('begin');
          if(kind==='adopted-row')await blocker.query('select 1 from public.clued_memories where id=$1 for update',[adoptedId]);
          if(kind==='work-lock')await blocker.query('select clued_private.work_claim_lock($1)',[owner]);
          if(kind==='claim-row')await blocker.query('select 1 from clued_private.work_claims_v1 where claim_id=$1 for update',[claimId]);
          if(kind==='authorization-row')await blocker.query('select 1 from clued_private.authorizations_v12 where binding_id=$1 for update',[binding]);
          if(kind==='project-row')await blocker.query('select 1 from public.clued_projects where id=$1 for update',[PROJECT]);
          const started=Date.now(),result=await commit(issued);
          assert.ok(Date.now()-started<3000,'NOWAIT/try-lock must fail without an inverse-order wait');
          await assertDurableBurn(issued,result);await assertNoGrantEffects(old,request,given,revokes);
        }finally{await blocker.query('rollback');await blocker.end();}
      }
    });
    async function configureNative(client){
      await client.query("set statement_timeout='10s'");await client.query('begin');
      await client.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[owner,JSON.stringify(claims())]);
      await client.query('set local role authenticated');
    }
    async function waitForLock(observer,pid){
      for(let i=0;i<100;i++){
        if((await observer.query("select wait_event_type='Lock' waiting from pg_stat_activity where pid=$1",[pid])).rows[0]?.waiting)return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail('the competing writer must actually be observed waiting on the owned real lock');
    }
    await t.test('a real Native revoke wins the Owner lock; waiting fresh confirmation cannot revive it',async()=>{
      const issued=await native(issueName,{request_id:REQUEST});
      const blocker=server.getPgClient('postgres','127.0.0.1'),observer=server.getPgClient('postgres','127.0.0.1');
      await blocker.connect();await observer.connect();let pending;
      const old=await oldRow(),request=await requestRow(),given=await givenCount(),revokes=await revokedCount();
      try{
        const pid=(await db.query('select pg_backend_pid() p')).rows[0].p;
        await configureNative(blocker);
        const revoked=(await blocker.query('select public.clued_owner_grant_revoke_v1($1) v',[{grant_id:OLD}])).rows[0].v;
        assert.equal(revoked.status,'committed');assert.equal(revoked.replayed,false);
        pending=commit(issued);await waitForLock(observer,pid);await blocker.query('commit');
        const result=await pending;await assertDurableBurn(issued,result);
        assert.equal(await count(),1);assert.equal(await givenCount(),given);assert.equal(await revokedCount(),revokes+1);
        assert.equal((await oldRow()).uses,0);assert.ok((await oldRow()).revoked_at);
        assert.deepEqual(await requestRow(),request);
      }finally{
        await blocker.query('rollback');if(pending)await pending.catch(()=>{});await blocker.end();await observer.end();
        // Restore only the synthetic negative-case Grant field. The real
        // Native revoke Receipt remains as evidence of this test transaction.
        await db.query('update clued_private.owner_grants_v1 set revoked_at=$2 where id=$1',[OLD,old.revoked_at]);
      }
    });
    await t.test('expired consume is NULL; concurrent real Native confirmations produce one successor and replay expiry',async()=>{
      const issued=await native(issueName,{request_id:REQUEST});assert.equal(issued.status,'issued');
      const input={confirmation_token:issued.confirmation_token,view_digest:issued.view_digest};
      const consume=server.getPgClient('postgres','127.0.0.1'),second=server.getPgClient('postgres','127.0.0.1'),observer=server.getPgClient('postgres','127.0.0.1');
      await consume.connect();await second.connect();await observer.connect();let firstPending,secondPending;
      const given=await givenCount(),revokes=await revokedCount();let result,otherResult;
      try{
        const firstPid=(await db.query('select pg_backend_pid() p')).rows[0].p;
        const secondPid=(await second.query('select pg_backend_pid() p')).rows[0].p;
        await consume.query('begin');
        const unavailable=(await consume.query('select clued_private.owner_grant_consume_v1($1,$2,$3,$4,$5) v',
          [owner,originalBinding,'model.dataset_split.bootstrap',resources,TASK])).rows[0].v;
        assert.equal(unavailable,null,'a naturally expired old Grant is never consumed or revived');
        await configureNative(second);
        firstPending=native('clued_owner_grant_v1',input);
        secondPending=second.query('select public.clued_owner_grant_v1($1) v',[input]).then(async out=>{await second.query('commit');return out.rows[0].v;});
        await waitForLock(observer,firstPid);await waitForLock(observer,secondPid);
        await consume.query('commit');[result,otherResult]=await Promise.all([firstPending,secondPending]);
      }finally{
        await consume.query('rollback');if(firstPending)await firstPending.catch(()=>{});if(secondPending)await secondPending.catch(()=>{});
        await second.query('rollback');await consume.end();await second.end();await observer.end();
      }
      assert.equal(result.status,'committed',JSON.stringify(result));assert.equal(otherResult.status,'committed',JSON.stringify(otherResult));
      assert.equal(result.grant.grant_id,otherResult.grant.grant_id);assert.equal(result.receipt_id,otherResult.receipt_id);
      assert.equal([result,otherResult].filter(r=>r.replayed===false).length,1);
      assert.equal([result,otherResult].filter(r=>r.replayed===true).length,1);
      assert.equal(await count(),2);assert.equal(await givenCount(),given+1);assert.equal(await revokedCount(),revokes+1);
      const next=(await db.query('select to_jsonb(g) v from clued_private.owner_grants_v1 g where id=$1',[result.grant.grant_id])).rows[0].v;
      const old=await oldRow(),request=await requestRow(),freshToken=await tokenRow(issued.token_id);
      assert.ok(old.revoked_at);assert.equal(old.uses,0);
      for(const field of Object.keys(expiredOriginalGrant).filter(k=>k!=='revoked_at'))assert.deepEqual(old[field],expiredOriginalGrant[field]);
      assert.equal(next.request_id,null);assert.equal(next.grantee_binding_id,binding);assert.equal(next.max_uses,1);assert.equal(next.uses,0);
      assert.equal(next.granted_at,freshToken.consumed_at);assert.equal(next.granted_session_id,freshToken.session_id);
      assert.equal((await db.query("select expires_at=granted_at+interval '1 hour' exact from clued_private.owner_grants_v1 where id=$1",[next.id])).rows[0].exact,true);
      assert.ok(Date.parse(next.expires_at)>Date.parse(old.expires_at));assert.deepEqual(next.resources,old.resources);
      assert.equal(request.status,'granted');assert.equal(request.grant_id,next.id);assert.equal(request.binding_id,originalBinding);
      for(const field of Object.keys(originalRequest).filter(k=>!['status','grant_id','decided_at'].includes(k)))assert.deepEqual(request[field],originalRequest[field]);
      assert.deepEqual(await tokenRow(originalGrant.token_id),originalToken);
      assert.deepEqual((await db.query('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[originalGrant.receipt_id])).rows[0].v,originalReceipt);
      const receipt=(await db.query('select * from public.clued_audit_receipts where id=$1',[next.receipt_id])).rows[0];
      assert.equal(receipt.binding_id,null);assert.equal(receipt.metadata.principal,'native_account_session');
      assert.equal(receipt.metadata.token_id,issued.token_id);assert.deepEqual(receipt.metadata.choices,freshToken.native_choices);
      assert.equal(freshToken.consume_outcome,'committed');assert.equal(freshToken.consumed_receipt_id,next.receipt_id);
      // A lost HTTP result is reconciled only with the original token/digest.
      // The replay returns the same stored deadline and never starts a window.
      const replay=await native('clued_owner_grant_v1',input);assert.equal(replay.replayed,true);
      assert.equal(replay.grant.grant_id,next.id);assert.equal(replay.grant.expires_at,next.expires_at);
      assert.equal(await count(),2);await assert.rejects(preview());
      await assert.rejects(native(issueName,{request_id:REQUEST}));
      const secondConsumer=server.getPgClient('postgres','127.0.0.1'),useObserver=server.getPgClient('postgres','127.0.0.1');
      await secondConsumer.connect();await useObserver.connect();let pendingUse;
      try{
        const useSql='select clued_private.owner_grant_consume_v1($1,$2,$3,$4,$5) v';
        const values=[owner,binding,'model.dataset_split.bootstrap',resources,TASK];
        const pid=(await secondConsumer.query('select pg_backend_pid() p')).rows[0].p;
        await db.query('begin');
        const firstUse=(await db.query(useSql,values)).rows[0].v;assert.equal(firstUse.use,1);
        pendingUse=secondConsumer.query(useSql,values).then(r=>r.rows[0].v);
        await waitForLock(useObserver,pid);await db.query('commit');
        const uses=[firstUse,await pendingUse];
        assert.equal(uses.filter(x=>x===null).length,1);assert.equal(uses.filter(x=>x?.use===1).length,1);
        assert.equal((await db.query('select uses from clued_private.owner_grants_v1 where id=$1',[next.id])).rows[0].uses,1);
        assert.equal((await db.query("select count(*)::int n from public.clued_audit_receipts where operation='owner_grant_use' and object_id=$1",[next.id])).rows[0].n,1);
        const afterUseReplay=await native('clued_owner_grant_v1',input);
        assert.equal(afterUseReplay.replayed,true);assert.equal(afterUseReplay.grant.expires_at,next.expires_at);
      }finally{await db.query('rollback');if(pendingUse)await pendingUse.catch(()=>{});await secondConsumer.end();await useObserver.end();}
    });
  } finally {
    if (db) await db.end();
    await server.stop();
    if (proc) assert.ok(proc.exitCode !== null || proc.signalCode !== null,'Own PostgreSQL child must exit');
    assert.equal((await fs.realpath(root)).toLowerCase(),root.toLowerCase());
    assert.ok((await fs.realpath(dir)).startsWith(root+path.sep));
    assert.equal((await fs.lstat(dir)).isSymbolicLink(),false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'Ownership.json'),'utf8')),ownership);
    await fs.rm(dir,{recursive:true,force:true});
    for (const [k,v] of Object.entries(oldTemp)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
