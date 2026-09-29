import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const dir=await mkdtemp(join(tmpdir(),'clued-credential-recovery-'));
await build({stdin:{contents:`export {createStorageGoogleOAuth} from './worker/storage-google-oauth.ts';
export {createStorageGoogleRecoveryOAuth} from './worker/storage-google-recovery-oauth.ts';
export {createStorageCredentialVault} from './worker/storage-credential-vault.ts';`,resolveDir:fileURLToPath(new URL('../',import.meta.url))},
  outfile:join(dir,'oauth.mjs'),bundle:true,platform:'node',format:'esm'});
const {createStorageGoogleOAuth,createStorageGoogleRecoveryOAuth,createStorageCredentialVault}=await import(pathToFileURL(join(dir,'oauth.mjs')));
const sha=s=>createHash('sha256').update(s).digest('hex');

export async function testCredentialRecoveryOAuth(t,admin,server,{user,connection,native,issuer,lost,row,vaultConfig}) {
  const claims=(await native.query("select current_setting('request.jwt.claims') v")).rows[0].v;
  const session=JSON.parse(claims).session_id;
  const db=server.getPgClient();await db.connect();
  let exchanges=0,prepared;
  const call=async(input,start=false)=>{
    await db.query('set local role authenticated');
    try{return (await db.query(`select public.${start?'clued_storage_recovery_oauth_start_v1':'clued_storage_oauth_v1'}($1,$2::jsonb) v`,[issuer,input])).rows[0].v;}
    finally{await db.query('reset role').catch(()=>{});}
  };
  const config={client_id:'fixture-client',client_secret:'fixture-only-client-secret',redirect_uri:'https://example.invalid/storage/google/callback',
    vault:vaultConfig,rpc:input=>call(input),fetch:async(url,init)=>{
      if(String(url)==='https://oauth2.googleapis.com/token'){
        assert.equal(init.method,'POST');exchanges++;
        return Response.json({access_token:'fixture-fresh-access-token',refresh_token:'fixture-fresh-refresh-token',token_type:'Bearer',expires_in:3600,
          scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly'});
      }
      assert.ok(!init.method||init.method==='GET');
      if(String(url).includes('/about?'))return Response.json({user:{me:true,permissionId:'fixture-subject'}});
      return Response.json({id:'account-root',parents:['account-parent'],mimeType:'application/vnd.google-apps.folder',trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
    }};
  const begin=async()=>{
    await db.query('begin');exchanges=0;prepared=undefined;
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user,claims]);
    await db.query("update clued_private.storage_connections_v1 set state='reauthorization_required',refresh_default_blocked=true where id=$1",[connection]);
  };
  const start=async()=>{
    const factory=await createStorageGoogleRecoveryOAuth({...config,rpc:async input=>{
      if(input.action==='prepare')prepared=input;
      return call(input,true);
    }},lost);
    const url=new URL((await factory.start()).authorization_url);
    await assert.rejects(factory.start(),/unavailable/);
    return {state:url.searchParams.get('state'),code:'fixture-fresh-code'};
  };
  const state=async()=> (await db.query(`select to_jsonb(c) c,
    (select to_jsonb(m) from clued_private.resource_center_mutations_v1 m where id=$2) m,
    (select jsonb_agg(to_jsonb(g) order by g.binding_id) from clued_private.storage_client_grants_v1 g where connection_id=$1) grants,
    (select to_jsonb(d) from clued_private.storage_refresh_delegations_v1 d where connection_id=$1) delegation,
    (select count(*) from clued_private.resource_center_writer_bindings_v1) writers
    from clued_private.storage_connections_v1 c where c.id=$1`,[connection,row.id])).rows[0];
  const addPending=async()=>{
    const id=randomUUID();
    await db.query(`insert into clued_private.storage_refresh_attempts_v1(id,connection_id,issuer_hash,delegation_version,credential_version,state,expires_at)
      select $1,id,$3,1,credential_version,'claimed',clock_timestamp()+interval '5 minutes' from clued_private.storage_connections_v1 where id=$2`,[id,connection,issuer]);
    return id;
  };
  try {
    await t.test('server-selected legacy recovery start retains the exact original job contract',async()=>{
      await begin();try{
        const secret='fixture-legacy-recovery-secret-'+randomUUID(),known=sha(secret);
        await db.query(`insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled)
          select $2,oauth_client_id,redirect_uri,execution_enabled
          from clued_private.storage_oauth_apps_v1 where issuer_hash=$1`,[issuer,known]);
        const route=async input=>(await db.query('select public.clued_storage_recovery_oauth_start_v2($1,$2::jsonb) v',
          [secret,input])).rows[0].v;
        const description=await route({action:'describe',...lost});
        assert.equal(description.connection_id,connection);
        assert.match(description.recovery_binding,/^[0-9a-f]{64}$/);
        const attempt=randomUUID(),stateHash=sha(randomUUID());
        const stored=await route({action:'prepare',...lost,connection_version:description.connection_version,
          recovery_binding:description.recovery_binding,attempt_id:attempt,state_hash:stateHash,
          verifier_envelope:{contract:'clued.storage-credential/1',key_id:'v1',nonce:'a'.repeat(16),ciphertext:'a'.repeat(23)}});
        assert.equal(stored.status,'prepared');
        const attemptRow=(await db.query('select purpose,recovery_job_id from clued_private.storage_oauth_attempts_v1 where id=$1',
          [attempt])).rows[0];
        assert.equal(attemptRow.purpose,'credential_recovery');assert.equal(attemptRow.recovery_job_id,lost.job_id);
        const auto=async input=>(await db.query('select public.clued_storage_recovery_auto_target_v1($1,$2::jsonb) v',
          [secret,input])).rows[0].v;
        await db.query('savepoint target_before_complete');
        await assert.rejects(auto({action:'target',state_hash:stateHash}),/denied/);
        await db.query('rollback to savepoint target_before_complete');
        await db.query('savepoint wrong_job');
        await assert.rejects(auto({action:'mark',state_hash:stateHash,connection_id:connection,job_id:randomUUID()}),/denied/);
        await db.query('rollback to savepoint wrong_job');
        assert.deepEqual(await auto({action:'mark',state_hash:stateHash,...lost}),{status:'marked'});
        assert.equal((await db.query('select auto_settle_original from clued_private.storage_oauth_attempts_v1 where id=$1',[attempt])).rows[0].auto_settle_original,true);
        await db.query(`update clued_private.storage_oauth_attempts_v1 set status='completed',
          receipt_id=(select receipt_id from clued_private.storage_connections_v1 where id=$2) where id=$1`,[attempt,connection]);
        assert.deepEqual(await auto({action:'target',state_hash:stateHash}),
          {status:'ready',connection_id:connection,job_id:lost.job_id,execution_permitted:false});
        await db.query('savepoint mark_after_complete');
        await assert.rejects(auto({action:'mark',state_hash:stateHash,...lost}),/denied/);
        await db.query('rollback to savepoint mark_after_complete');
        assert.equal((await db.query('select state from clued_private.resource_center_mutations_v1 where id=$1',[row.id])).rows[0].state,'started');
        assert.equal(exchanges,0);
      }finally{await db.query('rollback');}
    });
    await t.test('fresh human recovery changes only encrypted credential generation, preserving original file fence and stopped permissions',async()=>{
      await begin();
      try {
        const pending=await addPending(),before=await state(),input=await start();
        assert.equal(Object.hasOwn(prepared,'default_refresh_consent'),false);
        const oauth=await createStorageGoogleOAuth(config),done=await oauth.complete(input);
        assert.equal(done.purpose,'credential_recovery');assert.equal(done.status,'completed');assert.equal(exchanges,1);
        assert.equal(Object.hasOwn(done,'refresh_enabled'),false);
        const after=await state(),changed=['credential_envelope','credential_version','version','receipt_id'];
        assert.deepEqual({...after,c:Object.fromEntries(Object.entries(after.c).filter(([k])=>!changed.includes(k)))},
          {...before,c:Object.fromEntries(Object.entries(before.c).filter(([k])=>!changed.includes(k)))});
        assert.equal(after.c.credential_version,before.c.credential_version+1);assert.equal(after.c.version,before.c.version+1);
        const vault=await createStorageCredentialVault(vaultConfig);
        const tokens=JSON.parse(await vault.open(after.c.credential_envelope,{owner_id:user,connection_id:connection,provider:'google-drive',
          provider_subject:'fixture-subject',oauth_client_id:'fixture-client',credential_version:after.c.credential_version}));
        assert.equal(tokens.access_token,'fixture-fresh-access-token');
        assert.deepEqual((await db.query('select state,receipt_id from clued_private.storage_refresh_attempts_v1 where id=$1',[pending])).rows[0],
          {state:'superseded',receipt_id:done.receipt_id});
        assert.deepEqual(await oauth.complete(input),done);assert.equal(exchanges,1);
        const receipts=(await db.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n;
        await db.query("update clued_private.storage_oauth_attempts_v1 set expires_at=clock_timestamp()-interval '1 second' where state_hash=$1",[sha(input.state)]);
        assert.deepEqual(await oauth.inspectRecovery(input.state),{status:'completed',receipt_id:done.receipt_id,execution_permitted:false});
        assert.equal((await db.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n,receipts);assert.equal(exchanges,1);
        await db.query('savepoint late_refresh');
        await assert.rejects(db.query('select public.clued_storage_refresh_worker_v1($1,$2::jsonb)',[issuer,
          {action:'commit',connection_id:connection,attempt_id:pending,credential_envelope:prepared.verifier_envelope,expires_at:new Date(Date.now()+3600000).toISOString()}]),/denied|unavailable/);
        await db.query('rollback to savepoint late_refresh');
      }finally{await db.query('rollback');}
    });
    await t.test('ordinary and recovery attempts share one unique state namespace and reject purpose/default consent injection',async()=>{
      for(const extra of [{purpose:'connection'},{default_refresh_consent:true},{profile_id:randomUUID()}]) {
        await begin();try{
          await start();await db.query('savepoint injection');
          await assert.rejects(call({...prepared,attempt_id:randomUUID(),state_hash:sha(randomUUID()),...extra},true),/denied/);
          await db.query('rollback to savepoint injection');
          await assert.rejects(call({...prepared,attempt_id:randomUUID()},true),/unique constraint/);
        }finally{await db.query('rollback');}
      }
      await begin();try{
        await start();await db.query('savepoint ordinary');
        await assert.rejects(call({action:'complete',state_hash:prepared.state_hash,provider_subject:'fixture-subject',credential_envelope:prepared.verifier_envelope,purpose:'connection'}),/denied/);
        await db.query('rollback to savepoint ordinary');
        await assert.rejects(call({action:'claim',state_hash:prepared.state_hash},true),/denied/);
      }finally{await db.query('rollback');}
    });
    await t.test('each recovery step rechecks original job, credential, pending refresh and native session CAS',async()=>{
      for(const phase of ['prepare','claim','complete'])for(const fault of ['credential','journal','pending_new','pending_finished','connection','session','settled']){
        await begin();try{
          const pending=fault==='pending_finished'?await addPending():null;
          const description=await call({action:'describe',...lost},true);
          if(phase!=='prepare')await start();
          if(phase==='complete')await call({action:'claim',state_hash:prepared.state_hash});
          if(fault==='credential')await db.query('update clued_private.storage_connections_v1 set credential_version=credential_version+1 where id=$1',[connection]);
          if(fault==='journal')await db.query("update clued_private.resource_center_mutations_v1 set provider_attempt=provider_attempt||'{\"extra\":true}'::jsonb where id=$1",[row.id]);
          if(fault==='pending_new')await addPending();
          if(fault==='pending_finished')await db.query("update clued_private.storage_refresh_attempts_v1 set state='committed' where id=$1",[pending]);
          if(fault==='connection')await db.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp() where id=$1",[connection]);
          if(fault==='session')await db.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1",[session]);
          if(fault==='settled')await db.query("update clued_private.resource_center_mutations_v1 set state='committed' where id=$1",[row.id]);
          const input=phase==='prepare'?{action:'prepare',...lost,connection_version:description.connection_version,recovery_binding:description.recovery_binding,
            attempt_id:randomUUID(),state_hash:sha(randomUUID()),verifier_envelope:{contract:'clued.storage-credential/1',key_id:'v1',nonce:'a'.repeat(16),ciphertext:'a'.repeat(23)}}:
            phase==='claim'?{action:'claim',state_hash:prepared.state_hash}:{action:'complete',state_hash:prepared.state_hash,provider_subject:'fixture-subject',credential_envelope:prepared.verifier_envelope};
          await assert.rejects(call(input,phase==='prepare'),/stale|denied|unavailable|required/);
          assert.equal(exchanges,0);
        }finally{await db.query('rollback');}
      }
    });
    await t.test('lost claim or exchange is never replayed; lost credential commit returns the original receipt without Google',async()=>{
      for(const loss of ['claim','exchange','complete']){
        await begin();try{
          const input=await start();let first=true;
          const oauth=await createStorageGoogleOAuth({...config,rpc:async v=>{
            const value=await call(v);
            if(first&&v.action===loss){first=false;throw new Error('lost response');}return value;
          },fetch:async(...args)=>{if(loss==='exchange'){exchanges++;throw new Error('lost exchange');}return config.fetch(...args);}});
          await assert.rejects(oauth.complete(input),/unavailable/);const count=exchanges;
          if(loss==='complete')assert.equal((await oauth.complete(input)).status,'completed');
          else {await db.query('savepoint replay');await assert.rejects(oauth.complete(input),/unavailable/);await db.query('rollback to savepoint replay');}
          assert.equal(exchanges,count);
        }finally{await db.query('rollback');}
      }
    });
    await t.test('real background due polling does not invalidate credential-only human consent',async()=>{
      await begin();try{
        await db.query("update clued_private.storage_connections_v1 set state='active' where id=$1",[connection]);
        await db.query(`insert into clued_private.storage_refresh_delegations_v1(connection_id,issuer_hash,enabled,receipt_id)
          select id,$2,true,receipt_id from clued_private.storage_connections_v1 where id=$1`,[connection,issuer]);
        const input=await start(),oauth=await createStorageGoogleOAuth({...config,rpc:async v=>{
          if(v.action==='complete'){
            const result=(await db.query('select public.clued_storage_refresh_worker_v1($1,$2::jsonb) v',[issuer,{action:'due'}])).rows[0].v;
            assert.ok(result.connections.includes(connection));
            assert.ok((await db.query('select last_polled_at from clued_private.storage_refresh_delegations_v1 where connection_id=$1',[connection])).rows[0].last_polled_at);
          }return call(v);
        }});
        assert.equal((await oauth.complete(input)).status,'completed');assert.equal(exchanges,1);
      }finally{await db.query('rollback');}
    });
    await t.test('recovery inspection never exposes another native session, Owner or issuer or returns vault data',async()=>{
      for(const fault of ['session','owner','issuer','ordinary','extra']){
        await begin();try{
          const input=await start();
          const value=await (await createStorageGoogleOAuth(config)).inspectRecovery(input.state);
          assert.deepEqual(value,{status:'prepared',receipt_id:null,execution_permitted:false});
          if(fault==='session')await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({...JSON.parse(claims),session_id:randomUUID()})]);
          if(fault==='owner')await db.query("select set_config('request.jwt.claim.sub',$1,true)",[randomUUID()]);
          if(fault==='issuer')await db.query('update clued_private.storage_oauth_apps_v1 set revoked_at=clock_timestamp() where issuer_hash=$1',[issuer]);
          if(fault==='ordinary')await db.query("update clued_private.storage_oauth_attempts_v1 set purpose='connection',recovery_job_id=null,recovery_binding=null,recovery_refresh_snapshot=null where id=$1",[prepared.attempt_id]);
          await assert.rejects(call({action:'inspect',state_hash:sha(input.state),...(fault==='extra'?{purpose:'connection'}:{})}),/denied|required/);
        }finally{await db.query('rollback');}
      }
    });
    await t.test('two independently claimed recovery consents can replace one credential generation only once',async()=>{
      const before=(await admin.query('select to_jsonb(c) c from clued_private.storage_connections_v1 c where id=$1',[connection])).rows[0].c;
      const other=server.getPgClient();await other.connect();
      try{
        await begin();const one=await start(),two=await start();await db.query('commit');
        await other.query('set role authenticated');
        await other.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[user,claims]);
        const rpc=(client,input)=>client.query('select public.clued_storage_oauth_v1($1,$2::jsonb) v',[issuer,input]);
        await rpc(native,{action:'claim',state_hash:sha(one.state)});await rpc(other,{action:'claim',state_hash:sha(two.state)});
        const common={action:'complete',provider_subject:'fixture-subject',credential_envelope:prepared.verifier_envelope};
        const results=await Promise.allSettled([rpc(native,{...common,state_hash:sha(one.state)}),rpc(other,{...common,state_hash:sha(two.state)})]);
        assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
        assert.match(results.find(r=>r.status==='rejected').reason.message,/stale/);
        assert.equal((await admin.query('select credential_version::int from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0].credential_version,Number(before.credential_version)+1);
        assert.equal((await admin.query('select state from clued_private.resource_center_mutations_v1 where id=$1',[row.id])).rows[0].state,'started');
      }finally{
        await db.query('rollback');await other.end();
        // Restore isolated fixture only; these fault-injection helpers are not
        // production APIs and never delete the receipt or attempt history.
        await admin.query(`update clued_private.storage_connections_v1 set state=$2,version=$3,credential_version=$4,
          credential_envelope=$5,receipt_id=$6,refresh_default_blocked=$7 where id=$1`,
          [connection,before.state,before.version,before.credential_version,before.credential_envelope,before.receipt_id,before.refresh_default_blocked]);
      }
    });
    await t.test('real root-lock waits recheck connection revocation and OAuth/native expiry with no credential or receipt commit',async()=>{
      const before=(await admin.query('select to_jsonb(c) c from clued_private.storage_connections_v1 c where id=$1',[connection])).rows[0].c;
      for(const fault of ['revoke','session_expiry','attempt_expiry']){
        let pending;
        try{
          await begin();const input=await start();await call({action:'claim',state_hash:sha(input.state)});await db.query('commit');
          if(fault==='session_expiry')await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1",[session]);
          if(fault==='attempt_expiry')await admin.query("update clued_private.storage_oauth_attempts_v1 set expires_at=clock_timestamp()+interval '1 second' where id=$1",[prepared.attempt_id]);
          const pid=(await native.query('select pg_backend_pid() pid')).rows[0].pid;
          const receipts=(await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n;
          await admin.query('begin');
          await admin.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[user+':account-root']);
          pending=native.query('select public.clued_storage_oauth_v1($1,$2::jsonb)',[issuer,{action:'complete',state_hash:sha(input.state),provider_subject:'fixture-subject',credential_envelope:prepared.verifier_envelope}])
            .then(value=>({value}),error=>({error}));
          let waiting=false;
          for(let i=0;i<200;i++){
            waiting=(await admin.query('select exists(select 1 from pg_locks where pid=$1 and not granted) v',[pid])).rows[0].v;
            if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.equal(waiting,true);
          if(fault==='revoke')await admin.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp() where id=$1",[connection]);
          else await admin.query('select pg_sleep(1.02)');
          await admin.query('commit');assert.match((await pending).error?.message??'',/denied|required|unavailable/);
          assert.equal((await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n,receipts);
          assert.equal((await admin.query('select credential_version::int from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0].credential_version,Number(before.credential_version));
        }finally{
          await admin.query('rollback');await db.query('rollback');if(pending)await pending;
          await admin.query('update auth.sessions set not_after=null where id=$1',[session]);
          await admin.query('update clued_private.storage_connections_v1 set state=$2,revoked_at=$3,refresh_default_blocked=$4 where id=$1',
            [connection,before.state,before.revoked_at,before.refresh_default_blocked]);
        }
      }
    });
  }finally{await db.end();}
}
