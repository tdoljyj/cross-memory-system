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
    export default {async fetch(){
      // The synthetic prior effect is fixture setup, never performed by recovery.
      const options={lostFinalize:true},base=fixture(options);
      await base.run().run(base.reference);options.redirect='manual';
      const current=base.info().currentRequest;
      const d={...await base.config.load_job(base.reference),status:'recovery_only',oauth_client_id:'fixture-client',
        intent_id:ids.intent,version:2,request_sha256:current.request_sha256,
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
             input.finish.request_sha256!==current.request_sha256||input.credential_version!==1||
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
      return Response.json({result,timeout,gets,finalizes,aborted,posts:base.info().posts,starts:base.info().starts});
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
    assert.equal(JSON.stringify(result).includes('synthetic-cloud-token'),false);
  } finally {await runtime.dispose();}
});
