import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build,stop} from 'esbuild';
import {Miniflare} from 'miniflare';

if(process.env.CLUED_RECOVERY_RUNTIME_CHILD!=='1') {
  test('settlement-only recovery uses real workerd and natural cleanup',{timeout:40000},async()=>{
    const env={...process.env,CLUED_RECOVERY_RUNTIME_CHILD:'1'};delete env.NODE_TEST_CONTEXT;
    const {stdout}=await promisify(execFile)(process.execPath,['--test','--test-reporter=tap',fileURLToPath(import.meta.url)],{env,timeout:30000});
    assert.match(stdout,/ok 1 - workerd recovery/);assert.match(stdout,/# pass 1/);assert.match(stdout,/# fail 0/);
  });
} else test('workerd recovery verifies the original effect with GET only and bounds stalled metadata',async()=>{
  const {outputFiles}=await build({stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'recovery-runtime.ts',contents:`
    import {fixture,ids} from './tests/resource-center-cloud-executor.fixture.mjs';
    import {createStorageCloudRecovery} from './worker/storage-cloud-recovery.ts';
    import {createStorageCredentialVault} from './worker/storage-credential-vault.ts';
    import {createStorageGoogleRecoveryOAuth} from './worker/storage-google-recovery-oauth.ts';
    import {createStorageGoogleOAuth} from './worker/storage-google-oauth.ts';
    export default {async fetch(){
      // The synthetic prior effect is fixture setup, never performed by recovery.
      const options={lostFinalize:true},base=fixture(options);
      await base.run().run(base.reference);options.redirect='manual';
      const current=base.info().currentRequest;
      const d={...await base.config.load_job(base.reference),status:'recovery_only',oauth_client_id:'fixture-client',
        intent_id:ids.intent,version:2,request_sha256:current.request_sha256,recovery_binding:'e'.repeat(64),
        provider_before:current.authority_request.provider_identity,
        attempt:{provider_file_id:'new-id',parent_id:'track',destination_path:current.exact_request.mutation.destination_path}};
      const vaultConfig={current_key_id:'fixture',keys:{fixture:btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')}};
      const vault=await createStorageCredentialVault(vaultConfig);
      d.credential_envelope=await vault.seal(JSON.stringify({...await base.config.get_credential(),token_type:'Bearer'}),{
        owner_id:d.owner_id,connection_id:d.connection_id,provider:'google-drive',provider_subject:d.provider_subject,
        oauth_client_id:d.oauth_client_id,credential_version:d.credential_version});
      let gets=0,finalizes=0,hang=false,aborted=false;
      const config={client_id:'fixture-client',vault:vaultConfig,clock:base.config.clock,timeout_ms:10000,
        rpc:async input=>{
          if(input.connection_id!==ids.connection||input.job_id!==ids.job)throw Error('wrong reference');
          if(input.action==='recovery_load')return d;
          if(input.action!=='recovery_finalize'||input.finish.intent_id!==ids.intent||input.finish.base_version!==2||
             input.finish.request_sha256!==current.request_sha256||input.credential_version!==1||input.recovery_binding!=='e'.repeat(64)||
             input.finish.postcondition.provider_file_id!=='new-id')throw Error('wrong settlement');
          finalizes++;return {status:'committed',state:'committed',intent_id:ids.intent,receipt_id:ids.receipt,execution_permitted:false};
        },fetch:async(url,init)=>{
          if(init.method!=='GET'||init.redirect!=='manual'||!init.signal)throw Error('unsafe IO');gets++;
          if(hang)return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(init.signal.reason);},{once:true}));
          return base.config.drive_fetch(url,init);
        }};
      const worker=await createStorageCloudRecovery(config),result=await worker.run(base.reference);
      hang=true;const stalled=await createStorageCloudRecovery({...config,timeout_ms:100});
      const timeout=await stalled.run(base.reference);
      let prepared,credentialDone=false,tokenPosts=0,oauthGets=0;
      const descriptor={...d,connection_version:1,credential_version:2,redirect_uri:'https://example.invalid/storage/google/callback'};
      const oauthConfig={client_id:'fixture-client',client_secret:'fixture-private-client-secret',redirect_uri:descriptor.redirect_uri,vault:vaultConfig,
        rpc:async input=>{
          if(input.action==='describe'){if(input.job_id!==ids.job)throw Error('wrong job');return descriptor;}
          if(input.action==='prepare'){
            if(input.job_id!==ids.job||input.recovery_binding!==d.recovery_binding||'default_refresh_consent' in input)throw Error('unsafe prepare');
            prepared=input;return {status:'prepared'};
          }
          if(input.state_hash!==prepared.state_hash)throw Error('wrong state');
          if(input.action==='claim')return credentialDone?{status:'completed',receipt_id:ids.receipt,purpose:'credential_recovery'}:
            {...descriptor,status:'claimed',attempt_id:prepared.attempt_id,verifier_envelope:prepared.verifier_envelope,purpose:'credential_recovery'};
          if(input.action==='complete'){credentialDone=true;return {status:'completed',receipt_id:ids.receipt,purpose:'credential_recovery'};}
          throw Error('unsafe OAuth action');
        },fetch:async(url,init)=>{
          if(init.redirect!=='manual'||!init.signal)throw Error('unsafe OAuth IO');
          if(String(url)==='https://oauth2.googleapis.com/token'){
            tokenPosts++;if(init.method!=='POST')throw Error('wrong token method');
            return Response.json({access_token:'fixture-new-access-token',refresh_token:'fixture-new-refresh-token',token_type:'Bearer',expires_in:3600,
              scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly'});
          }
          if(init.method&&init.method!=='GET')throw Error('Drive write forbidden');oauthGets++;
          return String(url).includes('/about?')?Response.json({user:{me:true,permissionId:d.provider_subject}}):
            Response.json({id:d.root_folder_id,parents:[d.root_parent_id],mimeType:'application/vnd.google-apps.folder',trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
        }};
      const fresh=await createStorageGoogleRecoveryOAuth(oauthConfig,base.reference);
      const state=new URL((await fresh.start()).authorization_url).searchParams.get('state');
      const callback=await createStorageGoogleOAuth(oauthConfig);
      const credentialResult=await callback.complete({state,code:'fixture-fresh-code'});
      const replay=await callback.complete({state,code:'fixture-fresh-code'});
      return Response.json({result,timeout,gets,finalizes,aborted,posts:base.info().posts,starts:base.info().starts,
        credentialResult,replay,tokenPosts,oauthGets});
    }};`},bundle:true,platform:'node',format:'esm',write:false});stop();
  let outbound=0;
  const runtime=new Miniflare({host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},workers:[{
    config:{name:'recovery-runtime-fixture',type:'worker',compatibilityDate:'2026-08-23',compatibilityFlags:['nodejs_compat'],
      manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:outputFiles[0].text}}}},
    dev:{outboundService:{type:'fetcher',handler:()=>{outbound++;return new Response('unexpected outbound',{status:503});}}},
  }]});
  try {
    const response=await runtime.dispatchFetch('http://localhost/');assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.result.status,'committed');
    assert.equal(result.result.execution_permitted,false);assert.equal(result.timeout.status,'inspection_required');
    assert.equal(result.finalizes,1);assert.ok(result.gets>0);assert.equal(result.aborted,true);
    assert.equal(result.posts,1);assert.equal(result.starts,1);assert.equal(outbound,0);
    assert.equal(result.credentialResult.purpose,'credential_recovery');assert.deepEqual(result.replay,result.credentialResult);
    assert.equal(result.tokenPosts,1);assert.equal(result.oauthGets,2);
    assert.equal(JSON.stringify(result).includes('synthetic-cloud-token'),false);
  } finally {await runtime.dispose();}
});
