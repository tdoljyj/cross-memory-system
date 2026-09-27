import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {build,stop} from 'esbuild';
import {Miniflare} from 'miniflare';

// Match the existing bounded natural-exit workerd fixture on Windows.
if(process.env.CLUED_QUALIFICATION_RUNTIME_CHILD!=='1') {
  test('directory observation uses real workerd with natural cleanup',{timeout:40000},async()=>{
    const env={...process.env,CLUED_QUALIFICATION_RUNTIME_CHILD:'1'};delete env.NODE_TEST_CONTEXT;
    const {stdout}=await promisify(execFile)(process.execPath,['--test','--test-reporter=tap',fileURLToPath(import.meta.url)],{env,timeout:30000});
    assert.match(stdout,/ok 1 - workerd directory/);assert.match(stdout,/# pass 1/);assert.match(stdout,/# fail 0/);
  });
} else test('workerd directory probe uses GET only and propagates shared abort through provider metadata',async()=>{
  const {outputFiles}=await build({stdin:{resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'qualification-runtime.ts',contents:`
    import {createGoogleDriveDirectoryProbe} from '../../kernel/host/resource-center-google-drive-qualification.mjs';
    import {createGoogleDriveMetadataApi} from '../../kernel/host/resource-center-google-drive-metadata.mjs';
    import {createStorageFetch} from './worker/storage-fetch.ts';
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
      return Response.json({result,calls,writes,aborted,timeout});
    }};`},bundle:true,platform:'node',format:'esm',write:false});stop();
  let outbound=0;
  const runtime=new Miniflare({host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},workers:[{
    config:{name:'qualification-runtime-fixture',type:'worker',compatibilityDate:'2026-08-23',compatibilityFlags:['nodejs_compat'],
      manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:outputFiles[0].text}}}},
    dev:{outboundService:{type:'fetcher',handler:()=>{outbound++;return new Response('unexpected outbound',{status:503});}}},
  }]});
  try {
    const response=await runtime.dispatchFetch('http://localhost/');assert.equal(response.status,200);
    const result=await response.json();assert.equal(result.result.status,'metadata_observed');
    assert.equal(result.result.execution_permitted,false);assert.equal(result.result.directories.length,2);
    assert.ok(result.calls>0);assert.equal(result.writes,0);assert.equal(outbound,0);
    assert.equal(result.aborted,true);assert.equal(result.timeout,true);
  } finally {await runtime.dispose();}
});
