import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { testNativeRecovery, testNativeRecoveryRace } from './resource-center-native-recovery-db.fixture.mjs';
import { testCredentialRecoveryOAuth } from './resource-center-credential-recovery-oauth-db.fixture.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const dir=await mkdtemp(join(tmpdir(),'clued-cloud-bridge-'));
await build({stdin:{contents:`export {createStorageCloudWorker} from './worker/storage-cloud-executor.ts'; export {createStorageGoogleRefresh} from './worker/storage-google-refresh.ts'; export {createStorageCredentialVault} from './worker/storage-credential-vault.ts';`,
  resolveDir:fileURLToPath(new URL('../',import.meta.url))},outfile:join(dir,'bridge.mjs'),bundle:true,platform:'node',format:'esm'});
const {createStorageCloudWorker,createStorageCredentialVault,createStorageGoogleRefresh}=await import(pathToFileURL(join(dir,'bridge.mjs')));

export async function testCloudBridge(t,admin,server,{user,profile,decision,connection,bindings,native,revoke}) {
  const client=server.getPgClient(),other=server.getPgClient();await client.connect();await other.connect();
  await client.query('set role anon');await other.query('set role anon');
  const issuer=sha('fixture-cloud-issuer'),vaultConfig={current_key_id:'v1',keys:{v1:randomBytes(32).toString('base64url')}};
  const vault=await createStorageCredentialVault(vaultConfig);
  const context={owner_id:user,connection_id:connection,provider:'google-drive',provider_subject:'fixture-subject',oauth_client_id:'fixture-client',credential_version:1};
  const tokens={access_token:'fixture-private-access-token',refresh_token:'fixture-private-refresh-token',token_type:'Bearer',
    scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000};
  const envelope=await vault.seal(JSON.stringify(tokens),context);
  await admin.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[connection,envelope]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri) values($1,'fixture-client','https://example.invalid/storage/google/callback')",[issuer]);
  const rpc=async(input,db=client,hash=issuer)=>(await db.query('select public.clued_storage_cloud_worker_v1($1,$2::jsonb) value',[hash,JSON.stringify(input)])).rows[0].value;
  const submit=async mutation=>{
    const ref={connection_id:connection,job_id:randomUUID()};
    await client.query('select public.clued_storage_jobs_v1($1,$2::jsonb)',[bindings[0].token,JSON.stringify({...ref,action:'submit',mutation})]);return ref;
  };
  const mutation={operation:'create',target_kind:'file',destination_path:'/account/Clued_资料中心/20_P_产品与体验/cloud.txt',content:'云端 UTF-8 exact content'};
  const ref=await submit(mutation);
  const folder='application/vnd.google-apps.folder';
  const file=(id,name,parent,version='1')=>({id,name,parents:parent?[parent]:[],version,trashed:false,mimeType:folder});
  const files=new Map([['account-parent',file('account-parent','account')],['account-root',file('account-root','Clued_资料中心','account-parent')],
    ['account-track',file('account-track','20_P_产品与体验','account-root','2')]]);
  let posts=0;let latestId;let losePost=false;
  const provider=async(url,init)=>{
    const u=new URL(url);assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+tokens.access_token);
    if(init.method==='POST'){
      posts++;const raw=init.body;const match=/\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw);
      const metadata=JSON.parse(match?.[0]??raw);
      const intent=metadata.appProperties.clued_intent_id;
      const saved=(await admin.query('select provider_attempt from clued_private.resource_center_mutations_v1 where id=$1',[intent])).rows[0];
      assert.equal(saved.provider_attempt.provider_file_id,metadata.id);assert.equal(saved.provider_attempt.size,String(Buffer.byteLength(mutation.content)));
      const created={...metadata,version:'1',trashed:false,size:String(Buffer.byteLength(mutation.content)),sha256Checksum:sha(mutation.content)};
      files.set(metadata.id,created);if(losePost)throw new Error('synthetic lost POST');return Response.json(created);
    }
    if(u.pathname.endsWith('/generateIds')){latestId='cloud-'+randomUUID();return Response.json({ids:[latestId]});}
    const q=u.searchParams.get('q');
    if(q){const parent=/'([^']+)' in parents/.exec(q)?.[1],name=/name = '([^']+)'/.exec(q)?.[1];
      return Response.json({files:[...files.values()].filter(f=>f.parents.includes(parent)&&(!name||name===f.name)),incompleteSearch:false});}
    return files.has(u.pathname.split('/').at(-1))?Response.json(files.get(u.pathname.split('/').at(-1))):new Response('',{status:404});
  };
  const worker=async(db=client,overrides={})=>createStorageCloudWorker({client_id:'fixture-client',vault:vaultConfig,rpc:input=>rpc(input,db),fetch:provider,...overrides});
  try {
    await t.test('cloud issuer and immutable registered layout are separate mandatory gates',async()=>{
      await assert.rejects(rpc({...ref,action:'load'}),/storage_cloud_denied/);
      await admin.query('update clued_private.storage_oauth_apps_v1 set execution_enabled=true where issuer_hash=$1',[issuer]);
      await assert.rejects(rpc({...ref,action:'load'}),/storage_cloud_unqualified/);
      const input={profile_id:profile,base_version:1,source_decision_id:decision,allowed_root_children:['20_P_产品与体验'],idempotency_key:randomUUID()};
      await assert.rejects(client.query('select public.clued_storage_cloud_qualify_v1($1,$2::jsonb)',[user,input]),/permission denied/);
      await assert.rejects(admin.query('select public.clued_storage_cloud_qualify_v1($1,$2::jsonb)',[user,{...input,allowed_root_children:['unregistered']}]),/storage_cloud_tracks_unregistered/);
      const result=(await admin.query('select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value',[user,input])).rows[0].value;assert.equal(result.status,'committed');
      await assert.rejects(admin.query('select public.clued_storage_cloud_qualify_v1($1,$2::jsonb)',[user,{...input,idempotency_key:randomUUID()}]),/storage_cloud_qualification_immutable/);
      await assert.rejects(rpc({...ref,action:'load',profile_id:profile}),/storage_cloud_denied/);
      await assert.rejects(rpc({...ref,action:'load',connection_id:randomUUID()}),/storage_cloud_denied/);
      await assert.rejects(rpc({...ref,action:'load'},client,sha('wrong')),/storage_cloud_denied/);
    });
    await t.test('real Canonical RPC plus server vault plus native provider effect commit once across two executors',async()=>{
      const [a,b]=await Promise.all([worker(),worker(other)]);
      const results=await Promise.all([a.run(ref),b.run(ref)]);
      assert.equal(results.filter(r=>r.status==='committed').length,1,JSON.stringify(results));assert.equal(posts,1);
      const stored=(await admin.query('select m.state,m.provider_attempt,m.receipt_id from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.owner_id=$1 and j.job_id=$2',[user,ref.job_id])).rows[0];
      assert.equal(stored.state,'committed');assert.equal(stored.provider_attempt.provider_file_id,latestId);
      assert.equal((await admin.query('select status from public.clued_audit_receipts where id=$1',[stored.receipt_id])).rows[0].status,'committed');
      assert.equal((await (await worker()).run(ref)).status,'inspection_required');assert.equal(posts,1);
      const publicStatus=(await client.query('select public.clued_storage_jobs_v1($1,$2::jsonb) value',[bindings[0].token,{...ref,action:'inspect'}])).rows[0].value;
      for(const secret of [tokens.access_token,tokens.refresh_token,'credential_envelope','cloud_writer_binding_id'])assert.equal(JSON.stringify(publicStatus).includes(secret),false);
    });
    await t.test('vault account/revision substitution and revoked issuer deny before provider POST',async()=>{
      const next=await submit({...mutation,destination_path:mutation.destination_path+'-second'});
      const wrong=await vault.seal(JSON.stringify(tokens),{...context,credential_version:2});
      await admin.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[connection,wrong]);
      assert.equal((await (await worker()).run(next)).status,'unavailable');assert.equal(posts,1);
      const state=(await client.query('select public.clued_storage_jobs_v1($1,$2::jsonb) value',[bindings[0].token,{...next,action:'inspect'}])).rows[0].value;
      assert.equal(state.status,'attention_required');assert.equal(state.execution_permitted,false);
      await admin.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[connection,envelope]);
      assert.equal((await (await worker()).run(next)).status,'inspection_required');assert.equal(posts,1);
      await admin.query('update clued_private.storage_oauth_apps_v1 set revoked_at=clock_timestamp() where issuer_hash=$1',[issuer]);
      assert.equal((await (await worker()).run(next)).status,'unavailable');assert.equal(posts,1);
      await admin.query('update clued_private.storage_oauth_apps_v1 set revoked_at=null where issuer_hash=$1',[issuer]);
    });
    await t.test('lost provider reply retains original DB fence across worker restart, never re-dispatches',async(child)=>{
      const lost=await submit({...mutation,destination_path:mutation.destination_path+'-lost'});losePost=true;
      assert.equal((await (await worker()).run(lost)).status,'unreconciled');assert.equal(posts,2);
      const row=(await admin.query('select m.*,j.job_id from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.job_id=$1',[lost.job_id])).rows[0];
      await revoke();
      await assert.rejects(rpc({...lost,action:'load'}),/storage_binding_denied/);
      // Simulate a restart after the original two-minute reader/writer expiry.
      // Never extend either grant, never issue another writer or clear a fence.
      await admin.query("update clued_private.resource_center_writer_bindings_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1",[row.writer_binding_id]);
      await admin.query("update clued_private.resource_center_bindings_v1 set expires_at=clock_timestamp()-interval '1 second' where token_hash=$1",[row.authority_token_hash]);
      const count=(await admin.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n;
      const actual=files.get(latestId);files.set(latestId,{...actual,sha256Checksum:sha('tampered')});
      assert.equal((await (await worker(other)).run(lost)).status,'inspection_required');assert.equal(posts,2);
      assert.equal((await admin.query('select state from clued_private.resource_center_mutations_v1 where id=$1',[row.id])).rows[0].state,'started');
      files.set(latestId,actual);
      await testNativeRecovery(child,admin,server,{user,profile,decision,connection,native,issuer,lost,row,vaultConfig,provider,
        posts:()=>posts});
      await testCredentialRecoveryOAuth(child,admin,server,{user,connection,native,issuer,lost,row,vaultConfig});
      // A real explicit delegation permits same-scope refresh for this exact
      // in-flight job, even after client revocation. It issues no new writer.
      const cVersion=(await admin.query('select version from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0].version;
      await native.query('select public.clued_storage_refresh_manage_v1($1::jsonb)',[{action:'enable',connection_id:connection,
        base_version:Number(cVersion),delegation_version:0,until_revoked:true,idempotency_key:randomUUID()}]);
      const expired=await vault.seal(JSON.stringify({...tokens,expires_at_ms:Date.now()-1000}),context);
      await admin.query('update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1',[connection,expired]);
      const refreshRpc=async input=>(await client.query('select public.clued_storage_refresh_worker_v1($1,$2::jsonb) value',[issuer,input])).rows[0].value;
      await assert.rejects(refreshRpc({action:'claim',connection_id:connection,attempt_id:randomUUID()}),/storage_root_has_unresolved_mutation/);
      await assert.rejects(refreshRpc({action:'claim',connection_id:connection,attempt_id:randomUUID(),recovery_job_id:ref.job_id}),/storage_refresh_denied/);
      const refreshAdmin=async input=>(await admin.query('select public.clued_storage_refresh_worker_v1($1,$2::jsonb) value',[issuer,input])).rows[0].value;
      // Rollback-only fault injection: no production fence is removed. The
      // original file attempt remains started throughout the real flow below.
      for(const fault of ['delegation_revoked','wrong_job','connection_revoked','decision_revoked','already_settled']) {
        await admin.query('begin');
        try {
          const attempt=randomUUID(),claim={action:'claim',connection_id:connection,attempt_id:attempt,recovery_job_id:lost.job_id};
          const acquired=await refreshAdmin(claim);assert.equal(acquired.status,'acquired');
          const nextEnvelope=await vault.seal(JSON.stringify(tokens),{...context,credential_version:2});
          const commit={...claim,action:'commit',credential_envelope:nextEnvelope,expires_at:new Date(Date.now()+3600000).toISOString()};
          if(fault==='delegation_revoked')await admin.query('update clued_private.storage_refresh_delegations_v1 set enabled=false,version=version+1 where connection_id=$1',[connection]);
          if(fault==='wrong_job')commit.recovery_job_id=ref.job_id;
          if(fault==='connection_revoked')await admin.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),credential_envelope=null where id=$1",[connection]);
          if(fault==='decision_revoked')await admin.query("update public.clued_memories set lifecycle_status='revoked' where id=$1",[decision]);
          if(fault==='already_settled') {
            // Model a concurrent successful verifier; token settlement is still
            // allowed against the unchanged immutable effect identity.
            await admin.query("update clued_private.resource_center_mutations_v1 set state='committed' where id=$1",[row.id]);
            assert.equal((await refreshAdmin(commit)).status,'committed');
          } else await assert.rejects(refreshAdmin(commit),/storage_refresh_denied|storage_connection_unavailable/);
        } finally {await admin.query('rollback');}
      }
      await admin.query('begin');
      try {
        let requests=0;
        const unknown=await createStorageGoogleRefresh({client_id:'fixture-client',client_secret:'fixture-private-client-secret',vault:vaultConfig,rpc:refreshAdmin,
          fetch:async()=>{requests++;throw new Error('lost token exchange');}});
        assert.equal((await unknown.run(connection,lost.job_id)).status,'uncertain');
        await admin.query('savepoint second_claim');
        assert.equal((await unknown.run(connection,lost.job_id)).status,'unavailable');assert.equal(requests,1);
        await admin.query('rollback to savepoint second_claim');
        assert.equal((await admin.query('select state from clued_private.resource_center_mutations_v1 where id=$1',[row.id])).rows[0].state,'started');
      } finally {await admin.query('rollback');}
      let exchanges=0;
      const refresher=await createStorageGoogleRefresh({client_id:'fixture-client',client_secret:'fixture-private-client-secret',vault:vaultConfig,rpc:refreshRpc,
        fetch:async(url,init)=>{
          if(url==='https://oauth2.googleapis.com/token'){exchanges++;assert.equal(init.method,'POST');
            return Response.json({access_token:tokens.access_token,token_type:'Bearer',expires_in:3600});}
          assert.equal(init.method??'GET','GET');
          if(url.includes('/about?'))return Response.json({user:{permissionId:context.provider_subject,me:true}});
          return Response.json({id:'account-root',mimeType:folder,trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true},parents:['account-parent']});
        }});
      const done=await (await worker(other,{recovery_refresh:r=>refresher.run(r.connection_id,r.job_id)})).run(lost);
      assert.equal(done.status,'committed');assert.equal(posts,2);
      assert.equal(exchanges,1);
      const refreshAttempt=(await admin.query('select * from clued_private.storage_refresh_attempts_v1 where connection_id=$1',[connection])).rows[0];
      assert.equal(refreshAttempt.recovery_job_id,lost.job_id);assert.equal(refreshAttempt.recovery_intent_id,row.id);
      assert.match(refreshAttempt.recovery_attempt_digest,/^[0-9a-f]{64}$/);
      assert.equal((await admin.query('select count(*)::int n from clued_private.resource_center_writer_bindings_v1')).rows[0].n,count);
      assert.equal((await admin.query('select expires_at<clock_timestamp() expired from clued_private.resource_center_writer_bindings_v1 where id=$1',[row.writer_binding_id])).rows[0].expired,true);
      assert.equal((await (await worker()).run(lost)).status,'unavailable');assert.equal(posts,2);
    });
    await t.test('two native settlements racing across independent database connections commit the original job only once',async()=>{
      const c=(await admin.query('select version from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0];
      const a=(await admin.query('select version from clued_private.authorizations_v12 where binding_id=$1',[bindings[0].binding])).rows[0];
      await native.query('select public.clued_storage_account_v1($1::jsonb)',[{action:'grant_client',connection_id:connection,
        base_version:Number(c.version),binding_id:bindings[0].binding,authorization_version:Number(a.version),
        actions:['inspect','create_file'],expires_at:new Date(Date.now()+600000).toISOString(),idempotency_key:randomUUID()}]);
      const racing=await submit({...mutation,destination_path:mutation.destination_path+'-race'});
      assert.equal((await (await worker()).run(racing)).status,'unreconciled');
      const before=posts;
      await testNativeRecoveryRace(admin,server,{native,issuer,ref:racing,vaultConfig,provider});
      assert.equal(posts,before);
      const status=(await client.query('select public.clued_storage_jobs_v1($1,$2::jsonb) v',[bindings[0].token,{...racing,action:'inspect'}])).rows[0].v;
      assert.equal(status.status,'committed');assert.equal(status.execution_permitted,false);
    });
  } finally {await client.end();await other.end();}
}
