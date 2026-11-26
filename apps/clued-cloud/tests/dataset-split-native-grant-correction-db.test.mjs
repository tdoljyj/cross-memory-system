import { stopCluster, startCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
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
for (const scene of ['boundaries','consume-race']) test(`Native correction (${scene}): isolated real token/receipt transaction`,
  { timeout: 300000 }, async t => {
  const root = path.resolve(repo, 'work/host-harness/ngc');
  await fs.mkdir(root, { recursive: true });
  assert.equal((await fs.realpath(root)).toLowerCase(), root.toLowerCase());
  const dir = await fs.mkdtemp(path.join(root, 'p-'));
  const ownership = { run_id: uid(), root, dir };
  await fs.writeFile(path.join(dir, 'Ownership.json'), JSON.stringify(ownership), { flag: 'wx' });
  const server = newCluster({ databaseDir: path.join(dir, 'db'), user: 'postgres',
    password: hash(), persistent: true, createPostgresUser: false,
    initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, '-c', 'listen_addresses=127.0.0.1'], onLog() {}, onError() {} });
  let db, proc;
  const oldTemp = Object.fromEntries(['TEMP','TMP','TMPDIR'].map(k => [k,process.env[k]]));
  for (const k of ['TEMP','TMP','TMPDIR']) process.env[k] = dir;
  try {
    await startCluster(server); proc = server.process;
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
    const owner = uid(), other = uid(), token = hash();
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'correction@example.invalid',now()),($2,'other@example.invalid',now())",[owner,other]);
    const binding = (await db.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
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

    // The fixed Native correction now also requires the actual exclusive
    // execution candidate. Seed it through the real G6 claim RPC after
    // closeout, with all three fixed Record targets; no gate is weakened.
    const ownClaim=await roleCall('clued_worker_gateway','select public.clued_work_claim_v1($1,$2) v',
      [token,{scope,task_id:TASK,holder_label:'Synthetic same-Binding correction holder',
        holder_client:'isolated Node test',holder_session_ref:'same-binding-correction-'+uid(),
        write_set:Object.values(plan.targets).map(id=>'record:'+id),idempotency_key:'same-binding-claim-'+uid()}],
      {...claims(),role:'clued_worker_gateway'});
    assert.equal(ownClaim.status,'committed');
    await db.query(await fs.readFile(path.join(app,'supabase/migrations',candidateFile),'utf8'));

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
            [owner,binding,'model.dataset_split.bootstrap',resources,TASK])).rows[0].v;
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
