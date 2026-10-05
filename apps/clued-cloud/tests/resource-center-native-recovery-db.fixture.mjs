import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const dir=await mkdtemp(join(tmpdir(),'clued-native-recovery-'));
await build({entryPoints:[fileURLToPath(new URL('../worker/storage-cloud-recovery.ts',import.meta.url))],
  outfile:join(dir,'recovery.mjs'),bundle:true,platform:'node',format:'esm'});
const {createStorageCloudRecovery}=await import(pathToFileURL(join(dir,'recovery.mjs')));

export async function testNativeRecoveryRace(admin,server,{native,issuer,ref,vaultConfig,provider}) {
  const claims=(await native.query("select current_setting('request.jwt.claims') v")).rows[0].v;
  const other=server.getPgClient();await other.connect();
  await other.query('set role authenticated');
  await other.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[JSON.parse(claims).sub,claims]);
  let arrived=0,release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const writers=(await admin.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n;
  try {
    const make=db=>createStorageCloudRecovery({client_id:'fixture-client',vault:vaultConfig,rpc:async input=>{
      if(input.action==='recovery_finalize'){arrived++;if(arrived===2)release();await barrier;}
      return (await db.query('select public.clued_storage_native_recovery_v1($1,$2::jsonb) v',[issuer,input])).rows[0].v;
    },fetch:async(url,init)=>{assert.equal(init.method,'GET');return provider(url,init);}});
    const [one,two]=await Promise.all([make(native),make(other)]);
    const results=await Promise.all([one.run(ref),two.run(ref)]);
    assert.equal(arrived,2);assert.equal(results.filter(r=>r.status==='committed').length,1,JSON.stringify(results));
    assert.equal(results.filter(r=>r.status==='inspection_required').length,1);
    const journal=(await admin.query('select m.state,m.receipt_id,m.id from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.job_id=$1',[ref.job_id])).rows[0];
    assert.equal(journal.state,'committed');assert.equal(journal.receipt_id,results.find(r=>r.status==='committed').receipt_id);
    assert.equal((await admin.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n,writers);
    const before=(await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n;
    const status=(await other.query('select public.clued_storage_native_recovery_v1($1,$2::jsonb) v',[issuer,{...ref,action:'recovery_inspect'}])).rows[0].v;
    assert.equal(status.status,'committed');assert.equal(status.receipt_id,journal.receipt_id);assert.equal(status.execution_permitted,false);
    assert.deepEqual(Object.keys(status).sort(),['connection_id','execution_permitted','intent_id','job_id','receipt_id','request_digest','status']);
    assert.equal((await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n,before);
  } finally {release();await other.end();}
}

export async function testNativeRecovery(t,admin,server,{user,profile,decision,connection,native,issuer,lost,row,vaultConfig,provider,posts}) {
  const claims=(await native.query("select current_setting('request.jwt.claims') v")).rows[0].v;
  const session=JSON.parse(claims).session_id;
  const db=server.getPgClient();await db.connect();
  const call=async(input,hash=issuer)=>{
    await db.query('set local role authenticated');
    try{return (await db.query('select public.clued_storage_native_recovery_v1($1,$2::jsonb) v',[hash,input])).rows[0].v;}
    finally{await db.query('reset role').catch(()=>{});}
  };
  const prepare=async()=>{
    await db.query('begin');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user,claims]);
    await db.query("update clued_private.storage_connections_v1 set state='reauthorization_required' where id=$1",[connection]);
    await db.query('update clued_private.storage_oauth_apps_v1 set execution_enabled=false where issuer_hash=$1',[issuer]);
  };
  const inspect={status:'inspection_required',execution_permitted:false};
  try {
    await t.test('native recovery is inaccessible without live native Owner plus exact issuer and original job',async()=>{
      for(const fault of ['anonymous','service','binding','missing_session','wrong_owner','wrong_issuer','wrong_job','extra_field']) {
        await prepare();
        try {
          if(fault==='binding')await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({...JSON.parse(claims),client_id:'delegated'})]);
          if(fault==='missing_session')await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,session_id:randomUUID()})]);
          if(fault==='wrong_owner')await db.query("select set_config('request.jwt.claim.sub',$1,true)",[randomUUID()]);
          const input={...lost,action:'recovery_load',...(fault==='wrong_job'?{job_id:randomUUID()}:{}),...(fault==='extra_field'?{managed_root:'/caller'}:{})};
          if(['anonymous','service'].includes(fault)) {
            await db.query('set local role '+(fault==='anonymous'?'anon':'service_role'));
            await assert.rejects(db.query('select public.clued_storage_native_recovery_v1($1,$2::jsonb)',[issuer,input]),/permission denied/);
          } else await assert.rejects(call(input,fault==='wrong_issuer'?'0'.repeat(64):issuer),/required|denied|unavailable/);
        } finally {await db.query('rollback');}
      }
    });
    await t.test('reauthorization-required settlement commits only the original effect without writer activation or credential refresh',async()=>{
      await prepare();let gets=0;
      try {
        const before=(await db.query('select to_jsonb(c) c,(select count(*) from clued_private.resource_center_writer_bindings_v1) writers from clued_private.storage_connections_v1 c where id=$1',[connection])).rows[0];
        const worker=await createStorageCloudRecovery({client_id:'fixture-client',vault:vaultConfig,rpc:call,fetch:async(url,init)=>{
          assert.equal(init.method,'GET');gets++;return provider(url,init);
        }});
        const count=posts(),done=await worker.run(lost);assert.equal(done.status,'committed',JSON.stringify(done));
        assert.equal(done.execution_permitted,false);assert.ok(gets>0);assert.equal(posts(),count);
        const after=(await db.query('select to_jsonb(c) c,(select count(*) from clued_private.resource_center_writer_bindings_v1) writers from clued_private.storage_connections_v1 c where id=$1',[connection])).rows[0];
        assert.deepEqual(after,before);
        assert.equal((await db.query('select state from clued_private.resource_center_mutations_v1 where id=$1',[row.id])).rows[0].state,'committed');
        assert.equal((await db.query('select status from public.clued_audit_receipts where id=$1',[done.receipt_id])).rows[0].status,'committed');
        assert.equal((await db.query('select execution_enabled from clued_private.storage_oauth_apps_v1 where issuer_hash=$1',[issuer])).rows[0].execution_enabled,false);
        assert.equal((await db.query('select revoked_at is not null revoked from clued_private.storage_client_grants_v1 where connection_id=$1 order by revoked_at nulls last limit 1',[connection])).rows[0].revoked,true);
      } finally {await db.query('rollback');}
    });
    await t.test('native recovery rechecks credential, full attempt, connection, profile and session CAS before any settlement',async()=>{
      for(const fault of ['credential','attempt','version','connection_version','connection_revoked','decision','profile','session','binding_fingerprint']) {
        await prepare();let finalizes=0,first=true;
        try {
          const worker=await createStorageCloudRecovery({client_id:'fixture-client',vault:vaultConfig,rpc:async input=>{
            if(input.action==='recovery_finalize'){finalizes++;if(fault==='binding_fingerprint')input={...input,recovery_binding:'0'.repeat(64)};}
            return call(input);
          },fetch:async(url,init)=>{
            assert.equal(init.method,'GET');
            if(first){first=false;
              if(fault==='credential')await db.query('update clued_private.storage_connections_v1 set credential_version=credential_version+1 where id=$1',[connection]);
              if(fault==='attempt')await db.query("update clued_private.resource_center_mutations_v1 set provider_attempt=provider_attempt||'{\"sha256\":\"changed\"}'::jsonb where id=$1",[row.id]);
              if(fault==='version')await db.query('update clued_private.resource_center_mutations_v1 set version=version+1 where id=$1',[row.id]);
              if(fault==='connection_version')await db.query('update clued_private.storage_connections_v1 set version=version+1 where id=$1',[connection]);
              if(fault==='connection_revoked')await db.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp() where id=$1",[connection]);
              if(fault==='decision')await db.query("update public.clued_memories set lifecycle_status='revoked' where id=$1",[decision]);
              if(fault==='profile')await db.query('update clued_private.resource_center_profiles_v1 set version=version+1 where id=$1',[profile]);
              if(fault==='session')await db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1",[session]);
            }
            return provider(url,init);
          }});
          await db.query('savepoint protected');
          assert.deepEqual(await worker.run(lost),inspect);assert.equal(finalizes,1);
          await db.query('rollback to savepoint protected');
          assert.equal((await db.query('select state from clued_private.resource_center_mutations_v1 where id=$1',[row.id])).rows[0].state,'started');
        } finally {await db.query('rollback');}
      }
    });
    await t.test('existing automatic recovery still rejects inactive connection and new private helpers have no API grants',async()=>{
      await prepare();
      try {
        await db.query('savepoint inactive');
        await assert.rejects(db.query('select clued_private.storage_cloud_recover_v1($1,$2,$3)',[user,lost.job_id,'recovery_load']),/storage_connection_unavailable/);
        await db.query('rollback to savepoint inactive');
        for(const role of ['anon','authenticated','service_role'])for(const signature of [
          'clued_private.storage_connection_recovery_v1(uuid,uuid)','clued_private.storage_cloud_settle_core_v1(uuid,uuid,text,jsonb)']) {
          assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,signature,'execute'])).rows[0].allowed,false);
        }
      } finally {await db.query('rollback');}
    });
    await t.test('native recovery session expiry during a real provider-root lock wait returns no descriptor or settlement',async()=>{
      const pid=(await native.query('select pg_backend_pid() pid')).rows[0].pid;
      const count=(await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n;
      await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1",[session]);
      await admin.query('begin');let pending;
      try {
        await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[user+':account-root']);
        pending=native.query('select public.clued_storage_native_recovery_v1($1,$2::jsonb)',[issuer,{...lost,action:'recovery_load'}])
          .then(value=>({value}),error=>({error}));
        let waiting=false;
        for(let i=0;i<200;i++) {
          waiting=(await admin.query('select exists(select 1 from pg_locks where pid=$1 and not granted) waiting',[pid])).rows[0].waiting;
          if(waiting)break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(waiting,true,'native recovery reached the real root lock');
        await admin.query("select pg_sleep(greatest(0,extract(epoch from (not_after-clock_timestamp())))+0.02) from auth.sessions where id=$1",[session]);
        await admin.query('commit');
        assert.match((await pending).error?.message??'',/storage_native_session_required/);
        assert.equal((await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n,count);
        assert.equal((await admin.query('select state from clued_private.resource_center_mutations_v1 where id=$1',[row.id])).rows[0].state,'started');
      } finally {
        await admin.query('rollback');if(pending)await pending;
        await admin.query('update auth.sessions set not_after=null where id=$1',[session]);
      }
    });
    await t.test('connection revocation winning the real root lock denies a waiting native recovery',async()=>{
      const prior=(await admin.query('select state,revoked_at from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0];
      const pid=(await native.query('select pg_backend_pid() pid')).rows[0].pid;
      await admin.query('begin');let pending;
      try {
        await admin.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[user+':account-root']);
        pending=native.query('select public.clued_storage_native_recovery_v1($1,$2::jsonb)',[issuer,{...lost,action:'recovery_load'}])
          .then(value=>({value}),error=>({error}));
        let waiting=false;
        for(let i=0;i<200;i++) {
          waiting=(await admin.query('select exists(select 1 from pg_locks where pid=$1 and not granted) waiting',[pid])).rows[0].waiting;
          if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(waiting,true);
        await admin.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp() where id=$1",[connection]);
        await admin.query('commit');assert.match((await pending).error?.message??'',/storage_connection_unavailable/);
        assert.equal((await admin.query('select state from clued_private.resource_center_mutations_v1 where id=$1',[row.id])).rows[0].state,'started');
      } finally {
        await admin.query('rollback');if(pending)await pending;
        // Restore only isolated fixture fault injection, never production state.
        await admin.query('update clued_private.storage_connections_v1 set state=$2,revoked_at=$3 where id=$1',[connection,prior.state,prior.revoked_at]);
      }
    });
  } finally {await db.end();}
}
