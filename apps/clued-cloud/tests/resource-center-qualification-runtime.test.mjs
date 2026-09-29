import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build,stop} from 'esbuild';
import {Miniflare} from 'miniflare';
import {batchRequests,batchReply} from './google-batch-fixture.mjs';

// Match the existing bounded natural-exit workerd fixture on Windows.
if(process.env.CLUED_QUALIFICATION_RUNTIME_CHILD!=='1') {
  test('directory observation uses real workerd with natural cleanup',{timeout:40000},async()=>{
    const env={...process.env,CLUED_QUALIFICATION_RUNTIME_CHILD:'1'};delete env.NODE_TEST_CONTEXT;
    const {stdout}=await promisify(execFile)(process.execPath,['--test','--test-reporter=tap',fileURLToPath(import.meta.url)],{env,timeout:30000});
    assert.match(stdout,/ok 1 - workerd directory/);assert.match(stdout,/# pass 1/);assert.match(stdout,/# fail 0/);
  });
} else test('workerd directory probe uses GET metadata batches and propagates shared abort through provider metadata',async()=>{
  const {outputFiles}=await build({stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'qualification-runtime.ts',contents:`
    import {createGoogleDriveDirectoryProbe} from '../../kernel/host/resource-center-google-drive-qualification.mjs';
    import {createGoogleDriveMetadataApi} from '../../kernel/host/resource-center-google-drive-metadata.mjs';
    import {createStorageFetch} from './worker/storage-fetch.ts';
    import {createStorageGoogleProbe} from './worker/storage-google-probe.ts';
    import {createStorageCredentialVault} from './worker/storage-credential-vault.ts';
    export default {async fetch(){
      const root='/drive/Clued_资料中心',folder='application/vnd.google-apps.folder';
      const item=(id,name,parent)=>({id,name,parents:parent?[parent]:[],mimeType:folder,version:'1',trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
      const files=[item('parent','drive'),item('root','Clued_资料中心','parent'),item('track','10_E','root')];
      const layout={contract:'clued.storage-directory-layout/1',managed_root:root,root_folder_id:'root',root_parent_id:'parent',allowed_root_children:['10_E'],
        directories:[{path:root,provider_file_id:'root'},{path:root+'/10_E',provider_file_id:'track'}]};
      let calls=0,writes=0,aborted=false;
      const getCredential=async()=>({access_token:'synthetic-access-token',scope:'https://www.googleapis.com/auth/drive.metadata.readonly'});
      const api=createGoogleDriveMetadataApi({get_credential:getCredential,authorization_details:true,fetch:createStorageFetch(async(url,init)=>{
        calls++;if(init.method!=='GET')writes++;if(init.redirect!=='manual')throw Error('redirect invalid');
        const u=new URL(url),id=u.pathname.split('/').at(-1);
        if(id==='files'){
          const parent=u.searchParams.get('q').split("'")[1];
          return Response.json({files:files.filter(f=>f.parents.includes(parent)),incompleteSearch:false});
        }
        return Response.json(files.find(f=>f.id===id));
      })});
      const result=await createGoogleDriveDirectoryProbe({trusted_layout:layout,get_file:api.getFile,list_folder:api.listFolder})();
      const hanging=createGoogleDriveMetadataApi({get_credential:getCredential,fetch:createStorageFetch(async(_,init)=>new Promise((_,reject)=>{
        init.signal.addEventListener('abort',()=>{aborted=true;reject(init.signal.reason);},{once:true});
      }))});
      let timeout=false;
      try{await createGoogleDriveDirectoryProbe({trusted_layout:layout,get_file:hanging.getFile,list_folder:hanging.listFolder,timeout_ms:10})();}
      catch(error){timeout=error.message==='DRIVE_QUALIFICATION_OBSERVATION_EXPIRED';}
      const vaultConfig={current_key_id:'fixture',keys:{fixture:btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')}};
      const vault=await createStorageCredentialVault(vaultConfig);
      const context={owner_id:'10000000-0000-4000-8000-000000000001',connection_id:'10000000-0000-4000-8000-000000000002',provider:'google-drive',provider_subject:'fixture-user',oauth_client_id:'fixture-client',credential_version:1};
      const envelope=await vault.seal(JSON.stringify({access_token:'synthetic-access-token',token_type:'Bearer',scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),context);
      let serverGets=0,serverBatches=0,serverCommits=0;
      const server=await createStorageGoogleProbe({client_id:context.oauth_client_id,vault:vaultConfig,
        rpc:async input=>{
          if(input.action==='prepare')return {status:'prepared',attempt_id:'10000000-0000-4000-8000-000000000003',descriptor:{...context,layout},credential_envelope:envelope,expires_at:new Date(Date.now()+90000).toISOString()};
          if(input.action!=='complete'||input.observation.execution_permitted!==false)throw Error('invalid commit');
          serverCommits++;return {status:'metadata_observed',attempt_id:input.attempt_id,receipt_id:'10000000-0000-4000-8000-000000000004',execution_permitted:false};
        },fetch:async(url,init)=>{
          if(init.redirect!=='manual'||!init.signal)throw Error('unsafe server read');
          if(init.method==='GET')serverGets++;
          else if(init.method==='POST'&&String(url)==='https://www.googleapis.com/batch/drive/v3')serverBatches++;
          else throw Error('unsafe method');
          return fetch(url,init);
        }});
      const serverResult=await server.run({connection_id:context.connection_id});
      return Response.json({result,calls,writes,aborted,timeout,serverResult,serverGets,serverBatches,serverCommits});
    }};`},bundle:true,platform:'node',format:'esm',write:false});stop();
  let outbound=0;
  const runtime=new Miniflare({host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},workers:[{
    config:{name:'qualification-runtime-fixture',type:'worker',compatibilityDate:'2026-08-23',compatibilityFlags:['nodejs_compat'],
      manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:outputFiles[0].text}}}},
    dev:{outboundService:{type:'fetcher',handler:async request=>{
      outbound++;
      if(request.url.startsWith('https://www.googleapis.com/drive/v3/about?')){
        assert.equal(request.method,'GET');return Response.json({user:{me:true,permissionId:'fixture-user'}});
      }
      assert.equal(request.url,'https://www.googleapis.com/batch/drive/v3');assert.equal(request.method,'POST');
      const item=(id,name,parent)=>({id,name,parents:parent?[parent]:[],mimeType:'application/vnd.google-apps.folder',version:'1',trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true}});
      const files=[item('parent','drive'),item('root','Clued_资料中心','parent'),item('track','10_E','root')];
      return batchReply(batchRequests(await request.text()).map(part=>{
        const u=new URL(part.path,'https://www.googleapis.com'),id=u.pathname.split('/').at(-1);
        return {...part,value:id==='files'?{files:files.filter(f=>f.parents.includes(u.searchParams.get('q').split("'")[1])),incompleteSearch:false}:files.find(f=>f.id===id)};
      }).reverse());
    }}},
  }]});
  try {
    const response=await runtime.dispatchFetch('http://localhost/');assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.result.status,'metadata_observed');
    assert.equal(result.result.execution_permitted,false);assert.equal(result.result.directories.length,2);
    assert.ok(result.calls>0);assert.equal(result.writes,0);assert.equal(outbound,9);
    assert.equal(result.aborted,true);assert.equal(result.timeout,true);
    assert.equal(result.serverResult.status,'metadata_observed');assert.equal(result.serverResult.execution_permitted,false);
    assert.equal(result.serverCommits,1);assert.equal(result.serverGets,1);assert.equal(result.serverBatches,8);
    assert.equal(result.serverResult.boundary_observation.status,'clean');
    assert.equal(JSON.stringify(result).includes('synthetic-access-token'),false);
  } finally {await runtime.dispose();}
});
