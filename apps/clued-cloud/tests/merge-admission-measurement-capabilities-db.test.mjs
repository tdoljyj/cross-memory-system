import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {allowRawTestBindings} from './raw-binding-grants-fixture.mjs';
import {workerGatewayRpc,assertGatewayCloseoutBoundary} from './worker-gateway-caller-fixture.mjs';
// Only an already-installed local test library URL may override the literal
// dependency. It is never a database URL, caller token or production target.
const {default:EmbeddedPostgres}=process.env.CLUED_TEST_EMBEDDED_POSTGRES_URL
  ? await import(process.env.CLUED_TEST_EMBEDDED_POSTGRES_URL)
  : await import('embedded-postgres');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const uuid=()=>crypto.randomUUID(),hash=()=>crypto.randomBytes(32).toString('hex');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const candidateName='20261011050507_merge_admission_measurement_capabilities_v1.sql';
const helperSignature='clued_private.merge_measurement_capabilities_v1(uuid)';
async function freePort(){const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));return port;}
async function readChain(){
  const folder=path.join(root,'supabase/migrations');
  return Promise.all((await fs.readdir(folder)).filter(n=>n.endsWith('.sql')).sort().map(async name=>{
    const text=await fs.readFile(path.join(folder,name),'utf8');return {name,text,sha256:sha(text)};
  }));
}
const catalog=async db=>(await db.query(`select p.oid::regprocedure::text signature,
  pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl::text acl
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','clued_private') order by 1`)).rows;

test('measurement capabilities: current-chain publisher atomicity and real gateway/resolver boundaries',
  {timeout:300000},async t=>{
  const chain=await readChain(),entry=chain.find(m=>m.name===candidateName);
  assert.ok(entry);assert.ok(chain.some(m=>m.name.endsWith('_merge_admission_measurement_history_atomic_v1.sql')));
  assert.ok(chain.some(m=>m.name.endsWith('_task_owner_detail_v1.sql')));
  assert.ok(chain.some(m=>m.name.endsWith('_storage_master_control_v1.sql')));
  const candidate=entry.text;
  assert.ok(candidate.includes('do $r9_capabilities$ begin\n'));assert.ok(candidate.endsWith('end $r9_capabilities$;\n'));
  const publisher=await fs.readFile(path.join(root,'../../.github/workflows/clued-cloud-production-release.yml'),'utf8');
  assert.match(publisher,/execute s;/);assert.match(publisher,/insert into supabase_migrations\.schema_migrations/);
  const tempParent=await fs.realpath(os.tmpdir());
  const directory=await fs.mkdtemp(path.join(tempParent,'clued-r9-capabilities-'));
  const server=new EmbeddedPostgres({databaseDir:directory,user:'postgres',password:hash(),port:await freePort(),
    persistent:true,postgresFlags:['-c','io_method=sync'],onLog(){},onError(message){process.stderr.write(message+'\n');}});
  const clients=[];let admin,legacy,fixture,legacyBefore,beforeCatalog,beforeLedger;
  const rpc=async(client,token,input)=>{
    try{return await workerGatewayRpc(client,'clued_mcp_audit_receipts',token,input);}
    finally{await client.query('reset role');await client.query("select set_config('request.jwt.claims','{}',false)");}
  };
  const makeReader=async(contexts=['*'],seed=true)=>{
    const user=uuid(),token=hash();await admin.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[user,`capability-${user}@example.invalid`]);
    const binding=(await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'openai','isolated capability reader',$2,array['audit:read'],$3) returning id`,[user,token,contexts])).rows[0].id;
    if(seed)await admin.query(`select clued_private.merge_measurement_append_v1($1,'global','policy','fifo-v1',
      jsonb_build_object('profile',clued_private.work_claim_profile_v1(),'initial_snapshot',true))`,[user]);
    return {user,token,binding};
  };
  try{
    await server.initialise();await server.start();admin=server.getPgClient();clients.push(admin);await admin.connect();
    await admin.query(`create role anon nologin;create role authenticated nologin;
      create role service_role nologin bypassrls;create role authenticator nologin noinherit;
      create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
      create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
      create temp table migration_lines(n bigserial primary key,line text);`);
    const applyPublished=async(text,version)=>{
      assert.equal(text.includes('\r'),false);assert.ok(text.endsWith('\n'));
      await admin.query('truncate migration_lines restart identity');
      await admin.query('insert into migration_lines(line) select unnest($1::text[])',[text.split('\n').slice(0,-1)]);
      const md5=crypto.createHash('md5').update(text).digest('hex');
      await admin.query(`begin;do $apply$ declare s text:=(select string_agg(coalesce(line,''),e'\\n' order by n) from migration_lines)||e'\\n';
        begin if md5(s) is distinct from '${md5}' then raise exception 'migration text differs from file';end if;
          execute s;insert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','capabilities_test',array[s]);
        end $apply$;commit;`);
      assert.equal((await admin.query("select md5(array_to_string(statements,'')) v from supabase_migrations.schema_migrations where version=$1",[version])).rows[0].v,md5);
    };
    for(const migration of chain){
      try{
        if(migration.name!==candidateName){await admin.query(migration.text);continue;}
        await allowRawTestBindings(admin);legacy=await makeReader();
        legacyBefore=await rpc(admin,legacy.token,{context_key:'global',limit:2});beforeCatalog=await catalog(admin);
        const beforeAudit=(await admin.query("select pg_get_functiondef('public.clued_mcp_audit_receipts(text,jsonb)'::regprocedure) v")).rows[0].v;
        await t.test('history failure after full capability DDL rolls helper/public body back; success binds exact file bytes',async()=>{
          await admin.query("alter table supabase_migrations.schema_migrations add constraint test_capability_history_failure check(version<>'fault_injected')");
          await assert.rejects(applyPublished(candidate,'fault_injected'),/test_capability_history_failure/);await admin.query('rollback');
          assert.equal((await admin.query('select to_regprocedure($1) v',[helperSignature])).rows[0].v,null);
          assert.equal((await admin.query("select pg_get_functiondef('public.clued_mcp_audit_receipts(text,jsonb)'::regprocedure) v")).rows[0].v,beforeAudit);
          assert.deepEqual(await catalog(admin),beforeCatalog);
          assert.equal((await admin.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n,0);
          await applyPublished(candidate,'20261011050507');
          const afterCatalog=await catalog(admin);assert.deepEqual(afterCatalog.filter(row=>row.signature!==helperSignature),beforeCatalog);
        });
      }catch(error){throw new Error(`Migration ${migration.name}: ${error.message}`,{cause:error});}
    }
    // legacy's stream is pinned to the source digest at the candidate. A later
    // migration that redefines a pinned source (20261108161615 rewrites
    // work_claim_merge_queue_v1) correctly makes it SOURCE_CHANGED, so the
    // served-measurement checks use a stream started on the current chain.
    fixture=await makeReader();
    const installedCatalog=await catalog(admin);
    await assertGatewayCloseoutBoundary(admin);
    beforeLedger=(await admin.query(`select jsonb_build_object(
      'streams',(select jsonb_agg(to_jsonb(s) order by user_id) from clued_private.merge_measurement_stream_v1 s),
      'events',(select jsonb_agg(to_jsonb(e) order by user_id,sequence) from clued_private.merge_measurement_events_v1 e)) v`)).rows[0].v;
    await t.test('legacy audit unchanged, helper still private, same public overload and ACL/role boundary',async()=>{
      assert.deepEqual(await rpc(admin,legacy.token,{context_key:'global',limit:2}),legacyBefore);
      const pinned=(await admin.query('select source_digest v from clued_private.merge_measurement_stream_v1 where user_id=$1',[legacy.user])).rows[0].v;
      const current=(await admin.query('select clued_private.merge_measurement_source_digest_v1() v')).rows[0].v;
      const served=await rpc(admin,legacy.token,{measurement:{}});
      assert.equal(served.status,pinned===current?'ok':'NOT_MEASURED');assert.equal(Object.hasOwn(served,'stream_id'),pinned===current);
      assert.deepEqual(await catalog(admin),installedCatalog);
      assert.equal((await admin.query(`select count(*)::int n from pg_proc where pronamespace='public'::regnamespace
        and proname='clued_mcp_audit_receipts'`)).rows[0].n,1);
      for(const role of ['anon','authenticated','service_role','authenticator','clued_worker_gateway'])
        assert.equal((await admin.query('select has_function_privilege($1,$2,\'EXECUTE\') v',[role,helperSignature])).rows[0].v,false);
      const denied=server.getPgClient();clients.push(denied);await denied.connect();
      for(const role of ['anon','authenticated','service_role','authenticator','clued_worker_gateway']){
        await denied.query(`set role ${role}`);
        try{await assert.rejects(denied.query('select clued_private.merge_measurement_capabilities_v1($1)',[fixture.user]),error=>error.code==='42501');}
        finally{await denied.query('reset role');}
      }
    });
    await t.test('initial denial and all-context coverage reject without credential/context/data echoes; other user unstarted',async()=>{
      await assert.rejects(rpc(admin,hash(),{measurement:{}}));
      const constrained=await makeReader(['global']);const hidden=`project:${uuid()}`;
      await admin.query(`select clued_private.merge_measurement_append_v1($1,$2,'admission_receipt','scope-test','{}')`,[constrained.user,hidden]);
      const result=await rpc(admin,constrained.token,{context_key:'global',measurement:{}});
      assert.equal(result.status,'NOT_MEASURED');assert.equal(result.reason,'measurement_scope_incomplete');assert.deepEqual(result.events,[]);
      assert.equal(JSON.stringify(result).includes(hidden),false);assert.equal(JSON.stringify(result).includes(constrained.token),false);
      const unstarted=await makeReader(['*'],false);
      const unknown=await rpc(admin,unstarted.token,{measurement:{}});assert.equal(unknown.status,'NOT_MEASURED');assert.deepEqual(unknown.events,[]);
      await assert.rejects(rpc(admin,fixture.token,{measurement:{user_id:unstarted.user}}),/merge_measurement_page_invalid/);
    });
    await t.test('fixed header and fingerprint survive genuine paged reads; observation time is after last visible read',async()=>{
      await admin.query(`select clued_private.merge_measurement_append_v1($1,'global','admission_receipt','second','{}')`,[fixture.user]);
      const first=await rpc(admin,fixture.token,{measurement:{limit:1}});assert.equal(first.status,'ok');assert.equal(first.has_more,true);
      const final=await rpc(admin,fixture.token,{measurement:{limit:1,after_sequence:first.next_sequence,stream_id:first.stream_id,end_sequence:first.end_sequence}});
      assert.equal(final.status,'ok');assert.equal(final.has_more,false);
      for(const key of ['stream_id','started_at','source_digest','end_sequence','capability_fingerprint'])assert.deepEqual(final[key],first[key]);
      for(const r of [first,final]) {
        for(const flag of ['source_auth','source_continuity','commit_clock_qualified','official_metric'])assert.equal(r[flag],false);
        assert.equal(r.t0,null);assert.equal(Object.hasOwn(r.capabilities,'stream'),false);assert.equal(Object.hasOwn(r.capabilities,'observed_at'),false);
        assert.match(r.capability_fingerprint,/^[a-f0-9]{64}$/);
        assert.ok(r.events.every(e=>Date.parse(e.recorded_at)<=Date.parse(r.served_observed_at)));
      }
    });
    await admin.query(`create table clued_private.wrapper_test_probe_v1(pid integer primary key,calls integer not null default 0,pause_at integer,flip_at integer,field text,last_read_at timestamptz);
      revoke all on table clued_private.wrapper_test_probe_v1 from public,anon,authenticated,service_role;`);
    const control=async(client,pauseAt=null,flipAt=null,field=null)=>admin.query(`insert into clued_private.wrapper_test_probe_v1(pid,calls,pause_at,flip_at,field)
      values($1,0,$2,$3,$4) on conflict(pid) do update set calls=0,pause_at=$2,flip_at=$3,field=$4`,[client.processID,pauseAt,flipAt,field]);
    const helperDef=(await admin.query('select pg_get_functiondef($1::regprocedure) v',[helperSignature])).rows[0].v;
    const installHelperHook=async(tailSql='')=>admin.query(`alter function ${helperSignature} rename to merge_measurement_capabilities_wrapper_test_original_v1;
      create function clued_private.merge_measurement_capabilities_v1(p_user uuid) returns jsonb
      language plpgsql volatile security invoker set search_path='' as $$declare n integer;pause integer;flip integer;f text;r jsonb;begin
        update clued_private.wrapper_test_probe_v1 set calls=calls+1 where pid=pg_backend_pid() returning calls,pause_at,flip_at,field into n,pause,flip,f;
        if n=pause then perform pg_advisory_lock(192611011);perform pg_advisory_unlock(192611011);end if;
        r:=clued_private.merge_measurement_capabilities_wrapper_test_original_v1(p_user);
        ${tailSql}
        return r;end $$;
      revoke all on function ${helperSignature} from public,anon,authenticated,service_role;`);
    const restoreHelper=async()=>admin.query(`drop function ${helperSignature};
      alter function clued_private.merge_measurement_capabilities_wrapper_test_original_v1(uuid) rename to merge_measurement_capabilities_v1;`);
    const parked=async client=>{
      for(let n=0;n<100;n++){const row=(await admin.query('select wait_event_type from pg_stat_activity where pid=$1',[client.processID])).rows[0];
        if(row?.wait_event_type==='Lock')return;await admin.query('select pg_sleep(0.01)');}
      throw Error('reader was not actually observed parked');
    };
    await t.test('served observation follows the actual final capability read, not the first header',async()=>{
      await installHelperHook("perform pg_sleep(0.01);update clued_private.wrapper_test_probe_v1 set last_read_at=clock_timestamp() where pid=pg_backend_pid();");
      try{
        await control(admin);const r=await rpc(admin,fixture.token,{measurement:{}});assert.equal(r.status,'ok');
        const probe=(await admin.query('select calls,last_read_at from clued_private.wrapper_test_probe_v1 where pid=$1',[admin.processID])).rows[0];
        assert.equal(probe.calls,2);assert.ok(Date.parse(r.served_observed_at)>=probe.last_read_at.getTime());
        assert.equal(r.commit_clock_qualified,false);
      }finally{await restoreHelper();}
    });
    await t.test('unreadable new tail arriving after prefix authorization cannot leak helper stream/end or its context',async()=>{
      const constrained=await makeReader(['global']);const reader=server.getPgClient();clients.push(reader);await reader.connect();
      const initial=(await admin.query('select last_sequence::text n from clued_private.merge_measurement_stream_v1 where user_id=$1',[constrained.user])).rows[0].n;
      const hidden=`project:${uuid()}`;await installHelperHook();await control(reader,1);
      await admin.query('select pg_advisory_lock(192611011)');const pending=rpc(reader,constrained.token,{measurement:{}});
      try {await parked(reader);
        await admin.query(`select clued_private.merge_measurement_append_v1($1,$2,'admission_receipt','late-hidden-context','{}')`,[constrained.user,hidden]);
        await admin.query('select pg_advisory_unlock(192611011)');const r=await pending;
        assert.equal(r.status,'ok');assert.equal(String(r.end_sequence),initial);
        assert.equal(r.events.some(e=>e.object_key==='late-hidden-context'),false);
        assert.equal(JSON.stringify(r).includes(hidden),false);assert.equal(Object.hasOwn(r.capabilities,'stream'),false);
      }finally {await admin.query('select pg_advisory_unlock(192611011)');await pending.catch(()=>{});await restoreHelper();}
    });
    const pageSignature='clued_private.merge_measurement_page_v1(uuid,jsonb)';
    await t.test('final stream/end/source/started pin mutations all refuse instead of returning altered header',async()=>{
      await admin.query(`alter function ${pageSignature} rename to merge_measurement_page_wrapper_test_original_v1;
        create function clued_private.merge_measurement_page_v1(p_user uuid,p_input jsonb) returns jsonb
        language plpgsql volatile security definer set search_path='' as $$declare n integer;f text;r jsonb;begin
          update clued_private.wrapper_test_probe_v1 set calls=calls+1 where pid=pg_backend_pid() returning calls,field into n,f;
          r:=clued_private.merge_measurement_page_wrapper_test_original_v1(p_user,p_input);
          if n=2 then
            if f='stream_id' then r:=jsonb_set(r,'{stream_id}',to_jsonb('00000000-0000-0000-0000-000000000001'::text));
            elsif f='end_sequence' then r:=jsonb_set(r,'{end_sequence}',to_jsonb((r->>'end_sequence')::bigint+1));
            elsif f='source_digest' then r:=jsonb_set(r,'{source_digest}',to_jsonb(repeat('a',64)));
            elsif f='started_at' then r:=jsonb_set(r,'{started_at}',to_jsonb('2020-01-01T00:00:00+00:00'::text));end if;
          end if;return r;end $$;
        revoke all on function ${pageSignature} from public,anon,authenticated,service_role;`);
      try {for(const field of ['stream_id','end_sequence','source_digest','started_at']) {
        await control(admin,null,null,field);const r=await rpc(admin,fixture.token,{measurement:{}});
        assert.equal(r.status,'NOT_MEASURED');assert.equal(r.reason,'measurement_pins_changed');assert.deepEqual(r.events,[]);
        assert.equal(Object.hasOwn(r,'stream_id'),false);
      }}finally {await admin.query(`drop function ${pageSignature};alter function clued_private.merge_measurement_page_wrapper_test_original_v1(uuid,jsonb) rename to merge_measurement_page_v1;`);}
    });
    await t.test('contributor authorization narrowing committed after first check is caught by final all-context check',async()=>{
      const candidateReader=await makeReader();const project=`project:${uuid()}`;
      await admin.query(`select clued_private.merge_measurement_append_v1($1,$2,'admission_receipt','project','{}')`,[candidateReader.user,project]);
      const reader=server.getPgClient();clients.push(reader);await reader.connect();await installHelperHook();await control(reader,1);
      await admin.query('select pg_advisory_lock(192611011)');const pending=rpc(reader,candidateReader.token,{measurement:{}});
      try {await parked(reader);
        // resolve_binding holds FOR SHARE on the Binding, so mutating that same
        // row synchronously while parking its reader creates a test deadlock.
        // The actual raw-grant authorization predicate is read without that row
        // lock; narrowing it is a real committed scope-revocation boundary.
        await admin.query("update clued_private.raw_binding_grants_v1 set context_key='global' where binding_id=$1",[candidateReader.binding]);
        await admin.query('select pg_advisory_unlock(192611011)');const r=await pending;
        assert.equal(r.status,'NOT_MEASURED');assert.equal(r.reason,'measurement_scope_incomplete');assert.deepEqual(r.events,[]);
        assert.equal(JSON.stringify(r).includes(project),false);
      }finally {await admin.query('select pg_advisory_unlock(192611011)');await pending.catch(()=>{});await restoreHelper();}
    });
    await t.test('Binding-row revoke is actually serialized behind the read, then the next read is refused',async()=>{
      const candidateReader=await makeReader();const reader=server.getPgClient(),writer=server.getPgClient();clients.push(reader,writer);
      await reader.connect();await writer.connect();await installHelperHook();await control(reader,1);
      await admin.query('select pg_advisory_lock(192611011)');const pending=rpc(reader,candidateReader.token,{measurement:{}});
      let change;
      try {await parked(reader);
        change=writer.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1',[candidateReader.binding]);
        change.catch(()=>{});await parked(writer); // real row-lock wait, not an assumption.
        assert.equal((await admin.query('select revoked_at is null v from public.clued_agent_bindings where id=$1',[candidateReader.binding])).rows[0].v,true);
        await admin.query('select pg_advisory_unlock(192611011)');const r=await pending;
        assert.equal(r.status,'ok');assert.equal(r.source_auth,false);
        await change;
        assert.equal((await admin.query('select revoked_at is not null v from public.clued_agent_bindings where id=$1',[candidateReader.binding])).rows[0].v,true);
        await assert.rejects(rpc(admin,candidateReader.token,{measurement:{}}),error=>error.code==='42501');
      }finally {await admin.query('select pg_advisory_unlock(192611011)');await pending.catch(()=>{});await change?.catch(()=>{});await restoreHelper();}
    });
    await t.test('an end watermark inside a real committed multi-event transaction retains the original refusal',async()=>{
      const r=await makeReader();await admin.query('begin');
      await admin.query(`select clued_private.merge_measurement_append_v1($1,'global','admission_receipt','tx-a','{}')`,[r.user]);
      await admin.query(`select clued_private.merge_measurement_append_v1($1,'global','admission_receipt','tx-b','{}')`,[r.user]);await admin.query('commit');
      const stream=(await admin.query('select stream_id,last_sequence::text n from clued_private.merge_measurement_stream_v1 where user_id=$1',[r.user])).rows[0];
      await assert.rejects(rpc(admin,r.token,{measurement:{stream_id:stream.stream_id,end_sequence:String(BigInt(stream.n)-1n)}}),/merge_measurement_watermark_in_transaction/);
    });
    await t.test('bad capability producer text/type/flags and changed fingerprint are never reflected or qualified',async()=>{
      const marker='SYNTHETIC-SENSITIVE-CAPABILITY-NOT-RETURNED';
      const overrides=["r:=jsonb_set(r,'{current_source_digest}',to_jsonb('"+marker+"'::text));",
        "r:=jsonb_set(r,'{current_source_digest}',to_jsonb(1111111111111111111111111111111111111111111111111111111111111111::numeric));",
        "r:=jsonb_set(r,'{capture_triggers,0,expected_function}',to_jsonb('"+marker+"'::text));",
        "r:=jsonb_set(r,'{official_metric}','true');",
        "r:=jsonb_set(r,'{clock,track_commit_timestamp_setting}',to_jsonb('"+marker+"'::text));"];
      for(const code of overrides) {
        await installHelperHook(code);
        try {await control(admin);const r=await rpc(admin,fixture.token,{measurement:{}});
          assert.equal(r.status,'NOT_MEASURED');assert.equal(r.reason,'measurement_capability_unknown');assert.deepEqual(r.events,[]);
          assert.equal(JSON.stringify(r).includes(marker),false);
        }finally {await restoreHelper();}
      }
      await installHelperHook("r:=r||jsonb_build_object('ignored_text','"+marker+"','stream',jsonb_build_object('end_sequence',999,'raw','"+marker+"'));");
      try {await control(admin);const r=await rpc(admin,fixture.token,{measurement:{}});
        assert.equal(r.status,'ok');assert.equal(JSON.stringify(r).includes(marker),false);assert.equal(r.official_metric,false);
      }finally {await restoreHelper();}
      await installHelperHook("if n=2 then r:=jsonb_set(r,'{clock,track_commit_timestamp_setting}',to_jsonb(case when r->'clock'->>'track_commit_timestamp_setting'='on' then 'off' else 'on' end));end if;");
      try {await control(admin);const r=await rpc(admin,fixture.token,{measurement:{}});
        assert.equal(r.status,'NOT_MEASURED');assert.equal(r.reason,'measurement_capability_changed');assert.deepEqual(r.events,[]);
      }finally {await restoreHelper();}
      assert.equal((await admin.query('select pg_get_functiondef($1::regprocedure) v',[helperSignature])).rows[0].v,helperDef);
    });
    await t.test('diagnostic wrapper alone has no new catalog/ACL or ledger side effects; all qualification remains false',async()=>{
      // Compare the same fixture immediately before/after diagnostic reads.
      // Intentional earlier synthetic events remain retained, never edited.
      const pre=(await admin.query(`select jsonb_build_object('stream',to_jsonb(s),'events',
        (select jsonb_agg(to_jsonb(e) order by sequence) from clued_private.merge_measurement_events_v1 e where e.user_id=s.user_id)) v
        from clued_private.merge_measurement_stream_v1 s where user_id=$1`,[fixture.user])).rows[0].v;
      const r=await rpc(admin,fixture.token,{measurement:{}});assert.equal(r.status,'ok');
      const post=(await admin.query(`select jsonb_build_object('stream',to_jsonb(s),'events',
        (select jsonb_agg(to_jsonb(e) order by sequence) from clued_private.merge_measurement_events_v1 e where e.user_id=s.user_id)) v
        from clued_private.merge_measurement_stream_v1 s where user_id=$1`,[fixture.user])).rows[0].v;
      assert.deepEqual(post,pre);assert.deepEqual(await catalog(admin),installedCatalog);
      assert.ok(beforeLedger.events.length>0);
      console.log(JSON.stringify({scope:'actual isolated PG authorization/races; synthetic callers only',
        chain_source:'current checkout migration bytes',
        local_migrations:chain.length,local_chain_sha256:sha(JSON.stringify(chain.map(({name,sha256})=>({name,sha256})))),
        candidate_sql_sha256:sha(candidate),
        source_auth:false,source_continuity:false,commit_clock_qualified:false,official_metric:false,t0:null,production:false}));
    });
    await t.test('positive and denied metadata reads leave all local records, receipts, streams and events unchanged',async()=>{
      await admin.query('insert into public.clued_memories(user_id,title,content) values($1,$2,$3)',
        [fixture.user,'Capability read baseline','Synthetic local record remains unchanged']);
      const snapshot=async()=>(await admin.query(`select jsonb_build_object(
        'records',(select coalesce(jsonb_agg(to_jsonb(r) order by ctid),'[]') from clued_private.development_records_v14 r),
        'memories',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.clued_memories r),
        'memory_audit',(select coalesce(jsonb_agg(to_jsonb(r) order by ctid),'[]') from public.clued_memory_audit r),
        'receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.clued_audit_receipts r),
        'streams',(select coalesce(jsonb_agg(to_jsonb(r) order by user_id),'[]') from clued_private.merge_measurement_stream_v1 r),
        'events',(select coalesce(jsonb_agg(to_jsonb(r) order by user_id,sequence),'[]') from clued_private.merge_measurement_events_v1 r)) v`)).rows[0].v;
      const before=await snapshot();assert.equal((await rpc(admin,fixture.token,{measurement:{}})).status,'ok');
      await assert.rejects(rpc(admin,hash(),{measurement:{}}),error=>error.code==='42501');
      assert.deepEqual(await snapshot(),before);
    });
  }finally {
    for(const client of clients)await client.end().catch(()=>{});await stopCluster(server);
    const actual=await fs.realpath(directory);assert.equal(actual,directory);assert.equal(path.dirname(actual),tempParent);
    assert.ok(path.basename(actual).startsWith('clued-r9-capabilities-'));await removeTestDirectory(actual);
  }
});
