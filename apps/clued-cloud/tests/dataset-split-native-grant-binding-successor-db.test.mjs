import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
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
const { AUTHORIZATION_SUCCESSOR_MIGRATIONS, snapshotAuthorizationCallerBoundary, assertAuthorizationSuccessorBoundary, findGatewayCloseoutMigration, assertGatewayCloseoutBoundary, snapshotCallerCatalog, replayGatewayCloseout } = await import(pathToFileURL(path.join(sourceApp,'tests/worker-gateway-caller-fixture.mjs')));

// Real isolated PostgreSQL and synthetic accounts/IDs only. No production,
// real Owner approval, DomainAuthority, DataGate, M2 or model qualification.
const candidateFile = '20261011041300_dataset_split_native_grant_binding_successor_v1.sql';
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

for (const scene of ['boundaries','consume-race']) test(`Native Binding successor (${scene}): isolated real Native token/writer/revoke/receipt`,
  { timeout: 300000 }, async t => {
  const root = path.resolve(repo,'work/host-harness/ngbs');
  await fs.mkdir(root, { recursive: true });
  assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
  const dir = await fs.mkdtemp(path.join(root, 'p-'));
  const ownership = { run_id: uid(), root, dir };
  await fs.writeFile(path.join(dir, 'Ownership.json'), JSON.stringify(ownership), { flag: 'wx' });
  const port = await freePort();
  const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'db'), user: 'postgres',
    password: hash(), port, persistent: true, createPostgresUser: false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
  let db, proc;
  const oldTemp = Object.fromEntries(['TEMP','TMP','TMPDIR'].map(k => [k,process.env[k]]));
  for (const k of ['TEMP','TMP','TMPDIR']) process.env[k] = dir;
  try {
    await server.initialise(); await server.start(); proc = server.process;
    assert.ok(proc?.pid);
    db = server.getPgClient('postgres', '127.0.0.1'); await db.connect();
    await db.query("set statement_timeout='10s'");
    await db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(path.join(sourceApp,'supabase/migrations'))).filter(n => n.endsWith('.sql') && n !== candidateFile && !AUTHORIZATION_SUCCESSOR_MIGRATIONS.includes(n)).sort();
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
    await replayGatewayCloseout(db, await fs.readFile(path.join(sourceApp,'supabase/migrations',closeout),'utf8'));
    await assertGatewayCloseoutBoundary(db);
    const callerCatalog = await snapshotCallerCatalog(db);
    await replayGatewayCloseout(db, await fs.readFile(path.join(sourceApp,'supabase/migrations',closeout),'utf8'));
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
    const def=async sig=>(await db.query('select pg_get_functiondef($1::regprocedure) v',[sig])).rows[0].v;
    const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
    const originalContext=await def(signature),originalLink=await def(linkSignature);
    assert.equal(digest(originalContext),'b95e8ddba5b4400078ae6143735b80aa306bdf44ba6c43c42cbe602b1e98ecf1');
    assert.equal(digest(originalLink),'68a93c873c547ff17bfa09ddde117276511eaa430425b713f2104ad7c204ca94');
    const writerBefore=await def('public.clued_owner_grant_v1(jsonb)');
    const candidateSql=await fs.readFile(path.join(app,'supabase/migrations',candidateFile),'utf8');
    const beforeCatalog=await snapshotCallerCatalog(db);
    await t.test('complete predecessor hashes reject incompatible context and link',async()=>{
      for(const [sig,body] of [[signature,originalContext],[linkSignature,originalLink]]){
        await db.query('begin');
        try{
          await db.query(body.replace('begin\n','begin\n -- synthetic incompatible predecessor\n'));
          await assert.rejects(db.query(candidateSql),/dataset_split_binding_successor_source_changed/);
        }finally{await db.query('rollback');}
      }
    });
    await db.query(candidateSql);
    await t.test('patch preserves writer, all caller/private ACLs and every other function',async()=>{
      assert.equal(await def('public.clued_owner_grant_v1(jsonb)'),writerBefore);
      const after=await snapshotCallerCatalog(db);
      assert.deepEqual(after.map(x=>({...x,source_hash:null})),beforeCatalog.map(x=>({...x,source_hash:null})));
      const changed=[signature,linkSignature];
      assert.deepEqual(after.filter(x=>!changed.includes(x.signature)),
        beforeCatalog.filter(x=>!changed.includes(x.signature)));
      await assertGatewayCloseoutBoundary(db);
      await assert.rejects(db.query(candidateSql),/dataset_split_binding_successor_source_changed/);
      for(const role of ['anon','authenticated','service_role','clued_worker_gateway']){
        for(const sig of [signature,linkSignature,'clued_private.dataset_split_grant_correction_view_for_choices_v1(uuid,jsonb)']){
          assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') v",[role,sig])).rows[0].v,false);
        }
      }
    });
    // The old client has actually been revoked; its genuine original Native
    // approval chain remains history and is never revived or copied.
    await db.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[originalBinding]);
    const originalRequest=(await db.query('select to_jsonb(r) v from clued_private.owner_requests_v1 r where id=$1',[REQUEST])).rows[0].v;
    const originalReceipt=(await db.query('select to_jsonb(r) v from public.clued_audit_receipts r where id=(select receipt_id from clued_private.owner_grants_v1 where id=$1)',[OLD])).rows[0].v;

    const count = async () => (await db.query('select count(*)::int n from clued_private.owner_grants_v1')).rows[0].n;
    const viewName = 'clued_dataset_split_grant_correction_view_v1';
    const issueName = 'clued_dataset_split_grant_correction_issue_v1';
    const before = await db.query('select to_jsonb(t) v from clued_private.native_confirmation_tokens t where t.id=(select token_id from clued_private.owner_grants_v1 where id=$1)',[OLD]);

    if(scene==='consume-race'){
      await t.test('a competing real grant consumption wins its lock and the correction cannot revoke a spent grant',async()=>{
        const issued=await native(issueName,{request_id:REQUEST});
        const competitor=server.getPgClient('postgres','127.0.0.1');await competitor.connect();
        let pending;
        try{
          await competitor.query("set statement_timeout='5s'");
          const pid=(await competitor.query('select pg_backend_pid() pid')).rows[0].pid;
          await competitor.query('begin');
          await competitor.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[owner,JSON.stringify(claims())]);
          await competitor.query('set local role authenticated');
          await db.query('begin');
          const used=(await db.query('select clued_private.owner_grant_consume_v1($1,$2,$3,$4,$5) v',
            [owner,originalBinding,'model.dataset_split.bootstrap',resources,TASK])).rows[0].v;
          assert.equal(used.use,1);assert.equal(used.grant_id,OLD);
          pending=competitor.query('select public.clued_owner_grant_v1($1) v',
            [{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest}]);
          let locked=false;
          for(let i=0;i<30;i++){
            locked=(await db.query("select coalesce(wait_event_type='Lock',false) waiting from pg_stat_activity where pid=$1",[pid])).rows[0]?.waiting;
            if(locked)break;await new Promise(resolve=>setTimeout(resolve,20));
          }
          assert.equal(locked,true,'The competing Native writer must actually wait on the owned grant lock');
          await db.query('commit');
          const denied=(await pending).rows[0].v;assert.equal(denied.status,'rejected');
          await competitor.query('commit');assert.equal(await count(),1);
          const actual=(await db.query('select uses,revoked_at from clued_private.owner_grants_v1 where id=$1',[OLD])).rows[0];
          assert.equal(actual.uses,1);assert.equal(actual.revoked_at,null);
          assert.equal((await db.query('select grant_id from clued_private.owner_requests_v1 where id=$1',[REQUEST])).rows[0].grant_id,OLD);
        }finally{await db.query('rollback');if(pending)await pending.catch(()=>{});await competitor.query('rollback');await competitor.end();}
      });
    }else{
    await t.test('view and fresh issue produce no permission or revocation', async () => {
      const v = await native(viewName,{request_id:REQUEST});
      assert.equal(v.status,'eligible'); assert.equal(v.confirmation_view.expires_seconds,3600);
      assert.equal(v.confirmation_view.max_uses,1); assert.equal(v.confirmation_view.grantee.binding_id,binding);
      assert.deepEqual(v.confirmation_view.resources,resources);
      const continuity=v.confirmation_view.correction.binding_continuation;
      assert.equal(continuity.binding_changed,true);assert.equal(continuity.previous_binding.binding_id,originalBinding);
      assert.equal(continuity.previous_binding.revoked,true);assert.equal(continuity.current_binding.binding_id,binding);
      assert.equal(continuity.execution_claim.claim_id,claimId);assert.equal(continuity.execution_claim.holder_binding_id,binding);
      assert.equal(continuity.task.task_id,TASK);assert.equal(typeof continuity.task.content_hash,'string');
      assert.ok(!JSON.stringify(v).includes(token));assert.ok(!JSON.stringify(v).includes(newToken));
      assert.ok(!JSON.stringify(v).includes('lease_key_hash'));
      assert.equal(v.confirmation_view.correction.previous_grant_id,OLD);
      assert.equal(await count(),1);
      assert.equal((await db.query('select revoked_at from clued_private.owner_grants_v1 where id=$1',[OLD])).rows[0].revoked_at,null);
    });
    await t.test('only the exact original request and input shape are allowed', async () => {
      for (const input of [{request_id:uid()},{request_id:REQUEST,expires_seconds:86400},{request_id:REQUEST,grantee:'any_agent'},{}])
        await assert.rejects(native(viewName,input));
      await assert.rejects(native(viewName,{request_id:REQUEST},claims({sub:other})));
      await assert.rejects(native(viewName,{request_id:REQUEST},claims({session_id:null})));
      await assert.rejects(roleCall('anon','select public.'+viewName+'($1) v',[{request_id:REQUEST}]));
      await assert.rejects(roleCall('authenticated','select clued_private.dataset_split_grant_correction_context_v1($1,$2) v',[owner,REQUEST]));
    });
    async function fault(sql, values = []) {
      await db.query('begin');
      try { await db.query(sql,values); await assert.rejects(native(viewName,{request_id:REQUEST},claims(),true)); }
      finally { await db.query('rollback'); }
      assert.equal(await count(),1);
    }
    await t.test('spent/revoked, foreign scope, inactive task/binding and forged Native chain cannot be corrected',async () => {
      await fault('update clued_private.owner_grants_v1 set uses=1 where id=$1',[OLD]);
      await fault('update clued_private.owner_grants_v1 set revoked_at=clock_timestamp() where id=$1',[OLD]);
      await fault("update clued_private.owner_grants_v1 set granted_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where id=$1",[OLD]);
      await fault('update clued_private.owner_grants_v1 set resources=array[\'repo:other/root/**\'] where id=$1',[OLD]);
      await fault('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[binding]);
      await fault('update public.clued_memories set lifecycle_status=\'completed\' where id=$1',[TASK]);
      await fault(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
        select $1,user_id,'Synthetic target collision','Isolated negative fixture',scope,project_id,'state','active',
          1,'active',canonical_scope,'{"state_kind":"synthetic"}','{}','{}','observed','Synthetic fixture'
        from public.clued_memories where id=$2`,[plan.targets.producer_record_id,TASK]);
      await fault('update public.clued_audit_receipts set metadata=jsonb_set(metadata,\'{principal}\',\'"agent"\') where id=(select receipt_id from clued_private.owner_grants_v1 where id=$1)',[OLD]);
    });
    await t.test('a changed source burns the fresh token and leaves the old grant intact',async () => {
      const issued = await native(issueName,{request_id:REQUEST}); assert.equal(issued.status,'issued');
      await db.query('update clued_private.owner_grants_v1 set uses=1 where id=$1',[OLD]);
      const denied = await native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest});
      assert.equal(denied.status,'rejected'); assert.equal(await count(),1);
      assert.equal((await db.query('select revoked_at from clued_private.owner_grants_v1 where id=$1',[OLD])).rows[0].revoked_at,null);
      await db.query('update clued_private.owner_grants_v1 set uses=0 where id=$1',[OLD]);
    });
    await t.test('wrong session/digest and expired/revoked tokens cannot revoke or create permissions',async () => {
      for(const kind of ['session','digest','expired','revoked']){
        const issued=await native(issueName,{request_id:REQUEST});
        const input={confirmation_token:issued.confirmation_token,view_digest:issued.view_digest};
        if(kind==='digest')input.view_digest='f'.repeat(64);
        if(kind==='expired'){
          // Immutable fields cannot be edited, including by the fixture admin.
          // Seed a separate expired negative token without changing the real one.
          input.confirmation_token='clued_ogr_'+hash();
          await db.query(`insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,
            confirmation_view,view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
            select user_id,action,subject_key||':expired-negative-fixture',subject_version,native_choices,confirmation_view,view_digest,$1,session_id,auth_time,
              clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '5 minutes'
            from clued_private.native_confirmation_tokens where id=$2`,
            [crypto.createHash('sha256').update(input.confirmation_token).digest('hex'),issued.token_id]);
        }
        if(kind==='revoked')await native(issueName,{request_id:REQUEST});
        const denied=await native('clued_owner_grant_v1',input,kind==='session'?claims({session_id:'other-session'}):claims());
        assert.equal(denied.status,'rejected');assert.equal(await count(),1);
        assert.equal((await db.query('select revoked_at from clued_private.owner_grants_v1 where id=$1',[OLD])).rows[0].revoked_at,null);
      }
    });
    await t.test('a failure after old revoke rolls back the successor, old revoke and current pointer together',async () => {
      await db.query(`create function public.fixture_correction_pointer_failure() returns trigger language plpgsql as
        $$begin if new.grant_id is distinct from old.grant_id then raise exception 'fixture_pointer_failure' using errcode='23514'; end if; return new; end$$;
        create trigger fixture_correction_pointer_failure before update on clued_private.owner_requests_v1
        for each row execute function public.fixture_correction_pointer_failure()`);
      try{
        const issued=await native(issueName,{request_id:REQUEST});
        const denied=await native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest});
        assert.equal(denied.status,'rejected');assert.equal(await count(),1);
        assert.equal((await db.query('select revoked_at from clued_private.owner_grants_v1 where id=$1',[OLD])).rows[0].revoked_at,null);
        assert.equal((await db.query('select grant_id from clued_private.owner_requests_v1 where id=$1',[REQUEST])).rows[0].grant_id,OLD);
        assert.equal((await db.query("select count(*)::int n from public.clued_audit_receipts where operation='owner_grant_revoke' and object_id=$1",[OLD])).rows[0].n,0);
      }finally{await db.query('drop trigger fixture_correction_pointer_failure on clued_private.owner_requests_v1; drop function public.fixture_correction_pointer_failure()');}
    });

    await t.test('same Binding remains an eligible explicit Native correction when it is the actual claim holder',async()=>{
      await db.query('begin');
      try{
        await db.query('update public.clued_agent_bindings set revoked_at=null where id=$1',[originalBinding]);
        await db.query('update clued_private.work_claims_v1 set holder_binding_id=$1 where claim_id=$2',[originalBinding,claimId]);
        const value=await native(viewName,{request_id:REQUEST},claims(),true);
        assert.equal(value.confirmation_view.grantee.binding_id,originalBinding);
        assert.equal(value.confirmation_view.correction.binding_continuation.binding_changed,false);
        assert.equal(value.confirmation_view.correction.effect,'REPLACE_UNUSED_GRANT_WITH_ONE_HOUR_SINGLE_USE_KEEP_ORIGINAL_APPROVAL_HISTORY');
      }finally{await db.query('rollback');}
      assert.equal(await count(),1);
    });
    await t.test('missing, ambiguous, race, expired, foreign and uncovered claims deny without grant side effects',async()=>{
      await fault("update clued_private.work_claims_v1 set status='RELEASED' where claim_id=$1",[claimId]);
      await fault(`insert into clued_private.work_claims_v1 select (jsonb_populate_record(null::clued_private.work_claims_v1,
        to_jsonb(c)||jsonb_build_object('claim_id',$2::uuid,'copy_index',1,'idempotency_key','synthetic-duplicate-'||($2::uuid)::text))).*
        from clued_private.work_claims_v1 c where c.claim_id=$1`,[claimId,uid()]);
      await fault(`insert into clued_private.work_claim_task_modes_v1(user_id,task_id,mode,copies,shared_resources,
        enabled_session_id,token_id,receipt_id)
        select $1::uuid,$2::uuid,'multi',2,array['record:'||($2::uuid)::text],'synthetic-race',token_id,receipt_id
        from clued_private.owner_grants_v1 where id=$3`,[owner,TASK,OLD]);
      await fault(`update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '3 hours',
        expires_at=clock_timestamp()-interval '1 hour' where claim_id=$1`,[claimId]);
      await fault(`update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '3 hours',
        expires_at=clock_timestamp()-interval '2 hours',hard_deadline_at=clock_timestamp()-interval '1 hour' where claim_id=$1`,[claimId]);
      await fault("update clued_private.work_claims_v1 set status='DRAINING' where claim_id=$1",[claimId]);
      await fault('update clued_private.work_claims_v1 set copy_index=1 where claim_id=$1',[claimId]);
      await fault('update clued_private.work_claims_v1 set holder_binding_id=$1 where claim_id=$2',[foreignBinding,claimId]);
      await fault('update clued_private.work_claims_v1 set context_key=$1 where claim_id=$2',['project:'+uid(),claimId]);
      await fault('update clued_private.work_claims_v1 set write_set=$1::text[] where claim_id=$2',
        [targets.slice(0,2).map(id=>'record:'+id),claimId]);
      await fault("update clued_private.work_claims_v1 set write_set=array['repo:*'] where claim_id=$1",[claimId]);
      await fault(`insert into clued_private.work_claims_v1 select (jsonb_populate_record(null::clued_private.work_claims_v1,
        to_jsonb(c)||jsonb_build_object('claim_id',$2::uuid,'status','RELEASED','fence',c.fence+1,
          'idempotency_key','synthetic-higher-fence-'||($2::uuid)::text))).*
        from clued_private.work_claims_v1 c where c.claim_id=$1`,[claimId,uid()]);
    });
    await t.test('actual authorization and Global currentness are required without extending scopes',async()=>{
      await fault("update clued_private.authorization_entries_v12 set actions=array['read'] where binding_id=$1 and resource_id=$2",[binding,scope]);
      await fault("update clued_private.authorization_entries_v12 set actions=array['write'] where binding_id=$1 and resource_id=$2",[binding,scope]);
      await fault("delete from clued_private.authorization_entries_v12 where binding_id=$1 and resource_id='global'",[binding]);
      await fault("update clued_private.authorization_entries_v12 set actions=array['write'] where binding_id=$1 and resource_id='global'",[binding]);
      await fault('update clued_private.authorizations_v12 set revoked_at=clock_timestamp() where binding_id=$1',[binding]);
      await fault("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1",[binding]);
      await fault("update public.clued_agent_bindings set scopes=array['context:write'] where id=$1",[binding]);
      await fault('update public.clued_agent_bindings set context_keys=array[$2] where id=$1',[binding,scope]);
      await fault('update public.clued_memories set version=version+1 where id=$1',[globalSource]);
      await fault("update public.clued_memories set lifecycle_status='revoked' where id=$1",[globalSource]);
      await fault("update public.clued_memories set type_fields=jsonb_set(type_fields,'{execution_intents}','[]') where id=$1",[globalSource]);
    });
    await t.test('Task content/version, fence/lease and actual permission revision drift burn confirmation',async()=>{
      const cases=[
        ['update public.clued_memories set version=version+1 where id=$1',[TASK]],
        ["update public.clued_memories set content=content||' changed' where id=$1",[TASK]],
        ['update clued_private.work_claims_v1 set fence=fence+1 where claim_id=$1',[claimId]],
        ['update clued_private.work_claims_v1 set lease_version=lease_version+1 where claim_id=$1',[claimId]],
        ["update clued_private.work_claims_v1 set holder_session_ref='new-synthetic-session' where claim_id=$1",[claimId]],
        ['update clued_private.authorizations_v12 set version=version+1 where binding_id=$1',[binding]],
        ["update clued_private.authorization_entries_v12 set actions=array['read','write','audit'] where binding_id=$1 and resource_id=$2",[binding,scope]]
      ];
      for(const [sql,values] of cases){
        const issued=await native(issueName,{request_id:REQUEST});assert.equal(issued.status,'issued');
        await db.query('begin');
        try{
          await db.query(sql,values);
          const denied=await native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest},claims(),true);
          assert.equal(denied.status,'rejected',JSON.stringify(denied));
          assert.equal((await db.query('select consume_outcome from clued_private.native_confirmation_tokens where id=$1',[issued.token_id])).rows[0].consume_outcome,'rejected');
          assert.equal(await count(),1);
          assert.equal((await db.query('select revoked_at from clued_private.owner_grants_v1 where id=$1',[OLD])).rows[0].revoked_at,null);
        }finally{await db.query('rollback');}
      }
    });
    await t.test('contended real work/currentness advisory lock and CI-style row lock reject promptly without deadlock',async()=>{
      for(const kind of ['work-lock','claim-row','authorization-row','project-row']){
        const issued=await native(issueName,{request_id:REQUEST});assert.equal(issued.status,'issued');
        const blocker=server.getPgClient('postgres','127.0.0.1');await blocker.connect();
        try{
          await blocker.query('begin');
          if(kind==='work-lock')await blocker.query('select clued_private.work_claim_lock($1)',[owner]);
          if(kind==='claim-row')await blocker.query('select 1 from clued_private.work_claims_v1 where claim_id=$1 for update',[claimId]);
          if(kind==='authorization-row')await blocker.query('select 1 from clued_private.authorizations_v12 where binding_id=$1 for update',[binding]);
          if(kind==='project-row')await blocker.query('select 1 from public.clued_projects where id=$1 for update',[PROJECT]);
          const started=Date.now();
          const denied=await native('clued_owner_grant_v1',{confirmation_token:issued.confirmation_token,view_digest:issued.view_digest});
          assert.equal(denied.status,'rejected',JSON.stringify(denied));
          assert.ok(Date.now()-started<3000,'Candidate must fail without waiting on the inverse lock');
          assert.equal((await db.query('select consume_outcome from clued_private.native_confirmation_tokens where id=$1',[issued.token_id])).rows[0].consume_outcome,'rejected');
        }finally{await blocker.query('rollback');await blocker.end();}
        assert.equal(await count(),1);
        assert.equal((await db.query('select revoked_at from clued_private.owner_grants_v1 where id=$1',[OLD])).rows[0].revoked_at,null);
      }
    });

    await t.test('fresh Native confirmation atomically replaces the grant and preserves original evidence; replay is single-result',async () => {
      const issued = await native(issueName,{request_id:REQUEST}); assert.equal(issued.status,'issued');
      const input = {confirmation_token:issued.confirmation_token,view_digest:issued.view_digest};
      const second=server.getPgClient('postgres','127.0.0.1');await second.connect();
      let result,otherResult;
      try{
        await second.query('begin');
        await second.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[owner,JSON.stringify(claims())]);
        await second.query('set local role authenticated');
        const pair=await Promise.all([native('clued_owner_grant_v1',input),
          second.query('select public.clued_owner_grant_v1($1) v',[input]).then(async out=>{await second.query('commit');return out.rows[0].v;})]);
        [result,otherResult]=pair;
      }finally{await second.query('rollback');await second.end();}
      assert.equal(result.status,'committed',JSON.stringify(result));assert.equal(otherResult.status,'committed');
      assert.equal(result.grant.grant_id,otherResult.grant.grant_id);
      assert.ok(result.replayed||otherResult.replayed,'Concurrent confirmations produce one result');
      assert.equal(await count(),2);
      const old = (await db.query('select * from clued_private.owner_grants_v1 where id=$1',[OLD])).rows[0];
      const next = (await db.query('select * from clued_private.owner_grants_v1 where id=$1',[result.grant.grant_id])).rows[0];
      assert.ok(old.revoked_at); assert.equal(old.uses,0); assert.equal(old.request_id,REQUEST);
      assert.equal(next.request_id,null); assert.equal(next.grantee_binding_id,binding); assert.equal(next.max_uses,1);
      assert.equal(next.expires_at-next.granted_at,3600000); assert.ok(next.expires_at<=old.expires_at);
      assert.deepEqual(next.resources,old.resources);
      const request = (await db.query('select * from clued_private.owner_requests_v1 where id=$1',[REQUEST])).rows[0];
      assert.equal(request.id,REQUEST); assert.equal(request.idempotency_key,plan.idempotency_key);
      assert.equal(request.binding_id,originalBinding);
      const currentRequest=(await db.query('select to_jsonb(r) v from clued_private.owner_requests_v1 r where id=$1',[REQUEST])).rows[0].v;
      for(const field of Object.keys(originalRequest).filter(k=>!['status','grant_id','decided_at'].includes(k))) assert.deepEqual(currentRequest[field],originalRequest[field]);
      assert.deepEqual((await db.query('select to_jsonb(r) v from public.clued_audit_receipts r where id=$1',[old.receipt_id])).rows[0].v,originalReceipt);
      assert.equal(request.grant_id,next.id); assert.equal(request.status,'granted');
      assert.deepEqual((await db.query('select to_jsonb(t) v from clued_private.native_confirmation_tokens t where id=$1',[old.token_id])).rows,before.rows);
      const replay = await native('clued_owner_grant_v1',input); assert.equal(replay.replayed,true);
      assert.equal(replay.grant.grant_id,next.id); assert.equal(await count(),2);
      await assert.rejects(native(viewName,{request_id:REQUEST}));
    });
    }
    // Keep all original Native correction/binding scenes and their sealed G6
    // replay in the historical stage. Only now install the current pair.
    const historicalCatalog = await snapshotCallerCatalog(db);
    await replayGatewayCloseout(db, await fs.readFile(path.join(sourceApp, 'supabase/migrations', closeout), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(db), historicalCatalog,
      'sealed closeout remains unchanged after the complete historical scenarios');
    await assertGatewayCloseoutBoundary(db);
    const authorizationBefore = await snapshotAuthorizationCallerBoundary(db);
    for (const name of AUTHORIZATION_SUCCESSOR_MIGRATIONS) {
      await db.query(await fs.readFile(path.join(sourceApp, 'supabase/migrations', name), 'utf8'));
    }
    await assertAuthorizationSuccessorBoundary(db, authorizationBefore);

  } finally {
    if (db) await db.end();
    await stopCluster(server);
    if (proc) assert.ok(proc.exitCode !== null || proc.signalCode !== null,'Own PostgreSQL child must exit');
    assert.equal((await fs.realpath(root)).toLowerCase(),root.toLowerCase());
    assert.ok((await fs.realpath(dir)).startsWith(root+path.sep));
    assert.equal((await fs.lstat(dir)).isSymbolicLink(),false);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'Ownership.json'),'utf8')),ownership);
    await removeTestDirectory(dir);
    for (const [k,v] of Object.entries(oldTemp)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
