import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {loadContinuityWorker} from './worker-continuity-loader.mjs';
import {createStorageCredentialVault} from '../worker/storage-credential-vault.ts';
const worker=await loadContinuityWorker();
const scope='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';
test('Owner recovery honors a fresh terminal result after one exact-job renewal and never reloads the old effect',async t=>{
  for(const terminal of ['committed','cancelled']){
    const owner=randomUUID(),connection=randomUUID(),job=randomUUID(),intent=randomUUID(),receipt=randomUUID(),origin='https://clued.example.invalid';
    const keys={current_key_id:'test',keys:{test:randomBytes(32).toString('base64url')}},vault=await createStorageCredentialVault(keys);
    const context={owner_id:owner,connection_id:connection,provider:'google-drive',provider_subject:'subject',oauth_client_id:'recovery-client',credential_version:1};
    const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:'expired-original-access',refresh_token:'original-refresh-token',scope,
      expires_at_ms:Date.now()-1000}),context);
    const reference={connection_id:connection,job_id:job},rpcs=[],provider=[];let inspections=0;
    const env={CLUED_DB_GATEWAY_TOKEN:'fixed-gateway',SUPABASE_URL:'https://db.example.invalid',SUPABASE_PUBLISHABLE_KEY:'publishable',
      CLUED_STORAGE_ACCOUNT_V1:'true',CLUED_STORAGE_GOOGLE_V1:'true',CLUED_STORAGE_REFRESH_V1:'true',CLUED_STORAGE_CONNECTOR_ISSUER:'i'.repeat(40),
      CLUED_STORAGE_GOOGLE_CLIENT_ID:context.oauth_client_id,CLUED_STORAGE_GOOGLE_CLIENT_SECRET:'synthetic-client-secret',CLUED_STORAGE_VAULT_KEYS:JSON.stringify(keys)};
    t.mock.method(globalThis,'fetch',async(url,init)=>{
      const u=new URL(String(url)),headers=new Headers(init?.headers);
      if(u.pathname==='/auth/v1/user'){assert.equal(headers.get('authorization'),'Bearer owner-jwt');return Response.json({id:owner});}
      if(u.origin===env.SUPABASE_URL){
        const input=JSON.parse(init.body).p_input,name=u.pathname.split('/').at(-1);rpcs.push([name,input.action]);
        if(name==='clued_storage_native_recovery_v1'){
          assert.equal(headers.get('authorization'),'Bearer owner-jwt');inspections++;
          return Response.json({...reference,status:inspections===1?'uncertain':terminal,request_digest:'a'.repeat(64),intent_id:intent,receipt_id:receipt,execution_permitted:false});
        }
        if(name==='clued_storage_cloud_worker_router_v2')return Response.json({...reference,status:'inspection_required',execution_permitted:false});
        if(name==='clued_storage_native_recovery_load_v2'){
          assert.equal(headers.get('authorization'),'Bearer owner-jwt');
          return Response.json({...context,...reference,status:'recovery_only',intent_id:intent,version:2,credential_envelope:envelope,request_sha256:'b'.repeat(64),
            root_folder_id:'root',root_parent_id:'parent',profile:{managed_root:'/root'},mutation:{operation:'create',target_kind:'file',destination_path:'/root/file'},
            provider_before:{destination_parent_id:'track'},attempt:{provider_file_id:'file',parent_id:'track',destination_path:'/root/file'}});
        }
        if(name==='clued_storage_refresh_worker_v1'){
          assert.equal(headers.get('authorization'),'Bearer fixed-gateway');assert.equal(input.recovery_job_id,job);
          if(input.action==='claim')return Response.json({...context,status:'acquired',attempt_id:input.attempt_id,credential_envelope:envelope,
            root_folder_id:'root',root_parent_id:'parent',expires_at:new Date(Date.now()+120000).toISOString()});
          assert.equal(input.action,'commit');return Response.json({status:'committed'});
        }
        throw Error('unexpected Native request');
      }
      provider.push({url:String(url),method:init.method??'GET'});
      if(u.origin==='https://oauth2.googleapis.com')return Response.json({token_type:'Bearer',access_token:'new-recovery-access',expires_in:3600});
      assert.equal(headers.get('authorization'),'Bearer new-recovery-access');
      if(u.pathname.endsWith('/about'))return Response.json({user:{me:true,permissionId:'subject'}});
      assert.equal(u.pathname,'/drive/v3/files/root');
      return Response.json({id:'root',parents:['parent'],mimeType:'application/vnd.google-apps.folder',trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
    });
    const response=await worker.fetch(new Request(origin+'/v1/storage/recovery',{method:'POST',headers:{origin,authorization:'Bearer owner-jwt','content-type':'application/json'},
      body:JSON.stringify({action:'settle',...reference})}),env);
    assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,terminal);assert.equal(result.execution_permitted,false);
    assert.equal(rpcs.filter(([name])=>name==='clued_storage_native_recovery_load_v2').length,1,'no stale-effect reload after fresh terminal result');
    assert.equal(provider.filter(p=>p.method==='POST').length,1,'only the token request, never a file write');
    assert.equal(provider.length,3);assert.doesNotMatch(JSON.stringify(result),/access|refresh-token|credential|clued_srp_/);
    t.mock.restoreAll();
  }
});
