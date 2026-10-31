import assert from "node:assert/strict";
import test from "node:test";
import { fixture, ids, root, normalScope } from "./resource-center-cloud-executor.fixture.mjs";
import { cloudDispatchOutcome, createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
test('cloud composition runs scan, admission, one durable start, one POST and verified receipt without a mounted disk',async()=>{
  const f=fixture(),executor=f.run();const result=await executor.run(f.reference);
  assert.deepEqual(result,{status:'committed',job_id:ids.job,receipt_id:ids.receipt,execution_permitted:false});
  assert.equal(f.info().starts,1);assert.equal(f.info().posts,1);
  assert.ok(f.info().trace.indexOf('provider_attempt')<f.info().trace.indexOf('provider-post'));
  assert.equal((await executor.run(f.reference)).status,'inspection_required');
  assert.equal((await f.run().run(f.reference)).status,'inspection_required');
  assert.equal(f.info().posts,1);assert.equal(JSON.stringify(result).includes('admission'),false);
});
test('v2 records real provider proof before pure settlement',async()=>{
  const f=fixture(),base=f.config.rpc;let finish,recorded=false;
  f.config.verified_result_mode=true;
  f.config.rpc=async input=>{
    if(input.action==='verified_record'){
      assert.equal(f.info().posts,1);
      assert.equal(input.proof.contract,'clued.storage-create-verified/2');
      assert.equal(input.proof.provider_file_id,'new-id');
      assert.equal(input.proof.checks.content,true);
      finish=input.finish;recorded=true;
      return {status:'verified',intent_id:ids.intent,verified_receipt_id:ids.receipt,
        verified_digest:'a'.repeat(64),version:3,execution_permitted:false};
    }
    if(input.action==='settle_verified'){
      assert.equal(recorded,true);
      assert.equal(input.verified_receipt_id,ids.receipt);
      return base({...input,...finish,action:'finalize'});
    }
    return base(input);
  };
  const result=await createResourceCenterCloudExecutor(f.config).run(f.reference);
  assert.equal(result.status,'committed');assert.equal(f.info().posts,1);
});
test('Drive version advancement after upload settles the original job with one POST',async()=>{
  const f=fixture(),fetch=f.config.drive_fetch,rpc=f.config.rpc;let advanced=false,proof;
  f.config.verified_result_mode=true;
  f.config.drive_fetch=async(url,init)=>{
    if(f.info().posts===1 && !advanced && init.method==='GET' && new URL(url).pathname.endsWith('/new-id')){
      f.files.get('new-id').version='2';advanced=true;
    }
    return fetch(url,init);
  };
  f.config.rpc=async input=>{
    if(input.action==='verified_record'){
      proof=input.proof;
      return {status:'verified',intent_id:ids.intent,verified_receipt_id:ids.receipt,
        verified_digest:'a'.repeat(64),version:3,execution_permitted:false};
    }
    if(input.action==='settle_verified') return {status:'committed',state:'committed',intent_id:ids.intent,
      request_sha256:input.request_sha256,final_result:{status:'committed'},receipt_id:ids.receipt};
    return rpc(input);
  };
  assert.equal((await f.run().run(f.reference)).status,'committed');
  assert.equal(advanced,true);
  assert.equal(proof.provider_file_version,'2');
  assert.equal(proof.checks.stable_version,true);
  assert.equal(f.info().posts,1);
});
test('post-write failures identify the stage without logging provider or RPC details',async()=>{
  const cases=[
    {name:'Drive verification',stage:'verify',code:'DRIVE_POSTCONDITION_UNAVAILABLE'},
    {name:'verified record RPC',stage:'verified_record_rpc',code:'VERIFIED_RECORD_RPC_UNAVAILABLE'},
    {name:'verified record response',stage:'verified_record_result',code:'VERIFIED_RECORD_RESPONSE_INVALID'},
    {name:'verified settlement RPC',stage:'settle_verified_rpc',code:'SETTLE_VERIFIED_RPC_UNAVAILABLE'},
    {name:'verified settlement response',stage:'settle_verified_result',code:'SETTLE_VERIFIED_RESPONSE_INVALID'},
  ];
  for(const {name,stage,code} of cases){
    const f=fixture(),rpc=f.config.rpc,credential=f.config.get_credential;
    f.config.verified_result_mode=true;
    f.config.get_credential=async(...args)=>{
      if(name==='Drive verification' && f.info().posts===1){
        throw new Error('private provider response '+root);
      }
      return credential(...args);
    };
    f.config.rpc=async input=>{
      if(input.action==='verified_record'){
        if(name==='verified record RPC')throw new Error('private RPC response '+ids.job);
        if(name==='verified record response')return {status:'invalid',private_path:root};
        return {status:'verified',intent_id:ids.intent,verified_receipt_id:ids.receipt,
          verified_digest:'a'.repeat(64),version:3,execution_permitted:false};
      }
      if(input.action==='settle_verified'){
        if(name==='verified settlement RPC')throw new Error('private RPC response '+ids.job);
        if(name==='verified settlement response')return {status:'invalid',private_path:root};
        return {status:'committed',state:'committed',intent_id:ids.intent,
          request_sha256:input.request_sha256,final_result:{status:'committed'},receipt_id:ids.receipt};
      }
      return rpc(input);
    };
    const logs=[],original=console.warn;
    console.warn=message=>logs.push(message);
    let result;
    try { result=await f.run().run(f.reference); }
    finally { console.warn=original; }
    assert.equal(result.status,'unreconciled',name);
    assert.equal(result.error_code,'POST_WRITE_CANONICAL_RECONCILIATION_FAILED',name);
    assert.equal(f.info().posts,1,name);
    assert.equal(f.info().trace.filter(action=>action==='provider-post').length,1,name);
    assert.deepEqual(logs.map(message=>JSON.parse(message)),[
      {event:stage==='verify'?'storage_cloud_postcondition_failed':'storage_cloud_postwrite_failed',stage,error_code:code},
      {event:'storage_cloud_unreconciled',error_code:'POST_WRITE_CANONICAL_RECONCILIATION_FAILED'},
    ],name);
    assert.equal(logs.join('').includes(root),false,name);
    assert.equal(logs.join('').includes(ids.job),false,name);
  }
});
test('post-write Drive metadata failures retain safe categories and never repeat the provider POST',async()=>{
  const cases=[
    {name:'HTTP failure',code:'DRIVE_METADATA_UNAVAILABLE',response:async()=>new Response(null,{status:503})},
    {name:'transport failure',code:'DRIVE_METADATA_REQUEST_FAILED',response:async()=>{throw new Error('private provider response '+root);}},
    {name:'timeout',code:'DRIVE_METADATA_TIMEOUT',response:async()=>{throw Object.assign(new Error('private timeout '+root),{name:'TimeoutError'});}},
    {name:'invalid JSON',code:'DRIVE_METADATA_RESPONSE_INVALID',response:async()=>({ok:true,json:async()=>{throw new Error('private response '+root);}})},
    {name:'subrequest limit',code:'DRIVE_METADATA_SUBREQUEST_LIMIT',response:async()=>{throw new Error('Too many subrequests.');}},
  ];
  for(const {name,code,response} of cases){
    const f=fixture(),fetch=f.config.drive_fetch;
    f.config.drive_fetch=async(url,init)=>
      f.info().posts===1 && init.method==='GET' && new URL(url).pathname.endsWith('/new-id')
        ? response() : fetch(url,init);
    const logs=[],original=console.warn;
    console.warn=message=>logs.push(message);
    let result;
    try { result=await f.run().run(f.reference); }
    finally { console.warn=original; }
    assert.equal(result.status,'unreconciled',name);
    assert.equal(f.info().posts,1,name);
    assert.deepEqual(logs.map(message=>JSON.parse(message)),[
      {event:'storage_cloud_postcondition_failed',stage:'verify',error_code:code},
      {event:'storage_cloud_unreconciled',error_code:'POST_WRITE_CANONICAL_RECONCILIATION_FAILED'},
    ],name);
    assert.equal(logs.join('').includes(root),false,name);
    assert.equal(logs.join('').includes(ids.job),false,name);
  }
});
test('post-write credential failures keep the fixed credential label',async()=>{
  for(const code of ['STORAGE_CREDENTIAL_EXPIRING','STORAGE_CREDENTIAL_OPEN_FAILED','STORAGE_CREDENTIAL_CONTEXT_MISMATCH']){
    const f=fixture(),credential=f.config.get_credential;
    f.config.get_credential=async(...args)=>{
      if(f.info().posts===1) throw new Error(code);
      return credential(...args);
    };
    const logs=[],original=console.warn;
    console.warn=message=>logs.push(message);
    let result;
    try { result=await f.run().run(f.reference); }
    finally { console.warn=original; }
    assert.equal(result.status,'unreconciled',code);
    assert.equal(f.info().posts,1,code);
    assert.deepEqual(JSON.parse(logs[0]),{event:'storage_cloud_postcondition_failed',stage:'verify',error_code:code},code);
  }
});
test('caller profile/payload injection and cross-account credential never reach a write',async()=>{
  const f=fixture();assert.equal((await f.run().run({...f.reference,managed_root:'/other'})).status,'unavailable');assert.equal(f.info().loads,0);
  const other=fixture({credential:{owner_id:ids.connection}});
  assert.equal((await other.run().run(other.reference)).status,'unavailable');assert.equal(other.info().starts,0);assert.equal(other.info().posts,0);
});
test('sibling/root drops and status directory fail before durable start and provider write',async()=>{
  const island=fixture({island:true});assert.equal((await island.run().run(island.reference)).error_code,'UNAUTHORIZED_WORKSPACE_MUTATION');assert.equal(island.info().starts,0);
  const f=fixture();const load=f.config.load_job;f.config.load_job=async ref=>{
    const d=await load(ref);d.mutation={operation:'create',target_kind:'directory',destination_path:root+'/track/00_现行基线',directory_semantics:'topic'};return d;
  };
  assert.equal((await f.run().run(f.reference)).status,'deny');assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
});
test('preflight denial logs only a bounded diagnostic code',async()=>{
  const f=fixture();const load=f.config.load_job;f.config.load_job=async ref=>{
    const d=await load(ref);d.mutation={operation:'create',target_kind:'directory',destination_path:root+'/track/00_现行基线',directory_semantics:'topic'};return d;
  };
  const logs=[],original=console.warn;
  console.warn=message=>logs.push(message);
  let result;
  try { result=await f.run().run(f.reference); }
  finally { console.warn=original; }
  assert.equal(result.status,'deny');assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
  assert.equal(logs.length,1);
  const diagnostic=JSON.parse(logs[0]);
  assert.deepEqual(Object.keys(diagnostic).sort(),['error_code','event']);
  assert.equal(diagnostic.event,'storage_cloud_denied');
  assert.match(diagnostic.error_code,/^[A-Z][A-Z0-9_]{0,63}$/);
  assert.equal(logs[0].includes(root),false);
  assert.equal(logs[0].includes(ids.job),false);
});
test('early boundary scan denial logs a code without scan findings',async()=>{
  const island=fixture({island:true});
  const logs=[],original=console.warn;
  console.warn=message=>logs.push(message);
  let result;
  try { result=await island.run().run(island.reference); }
  finally { console.warn=original; }
  assert.equal(result.status,'deny');
  assert.equal(result.error_code,'UNAUTHORIZED_WORKSPACE_MUTATION');
  assert.equal(island.info().starts,0);assert.equal(island.info().posts,0);
  assert.deepEqual(logs.map(message=>JSON.parse(message)),[{event:'storage_cloud_denied',error_code:'UNAUTHORIZED_WORKSPACE_MUTATION'}]);
});
test('dispatch outcome carries a fixed reason code and bounded boundary findings only',async()=>{
  const island=fixture({island:true});
  const denied=await island.run().run(island.reference);
  assert.deepEqual(cloudDispatchOutcome(denied),{status:'denied',reason:{code:'UNAUTHORIZED_WORKSPACE_MUTATION',
    findings:[{path:'G:/My Drive/Clued_品牌说明.md',reason:'resource_center_parent_or_sibling_island'}]}});
  const many=Array.from({length:12},(_,i)=>({code:'UNAUTHORIZED_WORKSPACE_MUTATION',path:'G:/My Drive/Clued_'+i+'x'.repeat(1200),
    reason:'unregistered_clued_resource_location',managed_root:root}));
  const bounded=cloudDispatchOutcome({status:'deny',error_code:'UNAUTHORIZED_WORKSPACE_MUTATION',findings:[
    {path:'bad\u0000path',reason:'unregistered_clued_resource_location'},{path:'x',reason:'Not A Label'},...many]});
  assert.equal(bounded.reason.findings.length,10);
  assert.ok(bounded.reason.findings.every(f=>Array.from(f.path).length===1000 && Object.keys(f).join()==='path,reason'));
  assert.equal(bounded.reason.findings[0].path.startsWith('G:/My Drive/Clued_0'),true);
  assert.deepEqual(cloudDispatchOutcome({status:'deny',error_code:'STORAGE_CONTENT_STAGING_MISMATCH'}),{status:'denied',reason:{code:'STORAGE_CONTENT_STAGING_MISMATCH'}});
  // attention_required carries the code only, never findings.
  assert.deepEqual(cloudDispatchOutcome({status:'unavailable',error_code:'DRIVE_BOUNDARY_CHANGED',findings:many}),
    {status:'attention_required',reason:{code:'DRIVE_BOUNDARY_CHANGED'}});
  assert.deepEqual(cloudDispatchOutcome({status:'unreconciled',error_code:'PROVIDER_EFFECT_UNKNOWN'}),
    {status:'attention_required',reason:{code:'PROVIDER_EFFECT_UNKNOWN'}});
  for(const error_code of [undefined,'lower_case','AB','X'.repeat(65),'CODE WITH SPACE'])
    assert.deepEqual(cloudDispatchOutcome({status:'unavailable',error_code}),{status:'attention_required'});
});
test('authority failures identify the failed stage using fixed labels without exposing inputs',async()=>{
  for(const scenario of ['provider','provider_unknown','rpc','denied','mismatch']){
    const f=fixture();
    let trackReads=0;
    if(scenario==='provider' || scenario==='provider_unknown'){
      const fetch=f.config.drive_fetch;
      f.config.drive_fetch=async(url,init)=>{
        const response=await fetch(url,init);
        if(new URL(url).searchParams.get('q')?.includes("name = 'track'")){
          trackReads++;
          if(scenario==='provider_unknown') throw new Error('private provider detail '+root);
          const body=await response.json();
          return Response.json({...body,files:body.files.map(file=>({...file,version:null}))});
        }
        return response;
      };
    }else {
      const rpc=f.config.rpc;
      f.config.rpc=async input=>{
        if(input.action!=='authority') return rpc(input);
        if(scenario==='rpc') throw new Error('private database detail '+ids.job);
        if(scenario==='denied') return {status:'denied',private_path:root};
        return {status:'resolved',request:{private_path:root},authority:{workspace_version:'workspace/1'}};
      };
    }
    const logs=[],original=console.warn;
    console.warn=message=>logs.push(message);
    let result;
    try { result=await f.run().run(f.reference); }
    finally { console.warn=original; }
    assert.equal(result.status,'deny');
    assert.equal(result.error_code,'ARTIFACT_AUTHORITY_RESOLUTION_FAILED');
    assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
    const expected={provider:['provider_identity','PROVIDER_METADATA_MISMATCH'],
      // A failed request is named by its fixed code, after two more reads.
      provider_unknown:['provider_identity','DRIVE_METADATA_REQUEST_FAILED'],
      rpc:['canonical_rpc','AUTHORITY_RPC_UNAVAILABLE'],denied:['canonical_result','AUTHORITY_RPC_DENIED'],
      mismatch:['canonical_result','AUTHORITY_RESPONSE_MISMATCH']}[scenario];
    assert.deepEqual(logs.map(message=>JSON.parse(message)),[
      {event:'storage_cloud_authority_failed',phase:'initial',stage:expected[0],error_code:expected[1]},
      {event:'storage_cloud_denied',error_code:'ARTIFACT_AUTHORITY_RESOLUTION_FAILED'},
    ]);
    assert.equal(logs.join('').includes(root),false);
    assert.equal(logs.join('').includes(ids.job),false);
    if(scenario==='provider_unknown') assert.equal(trackReads,3);
    if(scenario==='provider') assert.equal(trackReads,1,'a metadata mismatch is not read again');
  }
});
test('a provider identity read that fails in transit is read again; the job then commits',async()=>{
  for(const [failures,committed] of [[1,true],[2,true]]){
    const f=fixture(),fetch=f.config.drive_fetch;let left=failures;
    f.config.drive_fetch=async(url,init)=>{
      if(new URL(url).searchParams.get('q')?.includes("name = 'track'") && left>0){ left--; throw new Error('transient'); }
      return fetch(url,init);
    };
    const logs=[],original=console.warn;
    console.warn=message=>logs.push(message);
    let result;
    try { result=await f.run().run(f.reference); }
    finally { console.warn=original; }
    assert.equal(result.status==='committed',committed,JSON.stringify(result));
    assert.equal(logs.some(message=>message.includes('storage_cloud_authority_failed')),false);
    assert.equal(f.info().posts,1);
  }
});
test('authority diagnostics distinguish revalidation after initial resolution',async()=>{
  const f=fixture(),rpc=f.config.rpc;let lookups=0;
  f.config.rpc=async input=>{
    if(input.action==='authority' && ++lookups===2) return {status:'denied'};
    return rpc(input);
  };
  const logs=[],original=console.warn;
  console.warn=message=>logs.push(message);
  let result;
  try { result=await f.run().run(f.reference); }
  finally { console.warn=original; }
  assert.equal(result.error_code,'ARTIFACT_AUTHORITY_REVALIDATION_FAILED');
  assert.equal(lookups,2);
  assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
  assert.deepEqual(logs.map(message=>JSON.parse(message)),[
    {event:'storage_cloud_authority_failed',phase:'revalidation',stage:'canonical_result',error_code:'AUTHORITY_RPC_DENIED'},
    {event:'storage_cloud_denied',error_code:'ARTIFACT_AUTHORITY_REVALIDATION_FAILED'},
  ]);
});
test('an unregistered destination folder is refused with PARENT_UNREGISTERED before any reservation',async()=>{
  const f=fixture(),rpc=f.config.rpc;let lookups=0;
  f.config.rpc=async input=>{
    if(input.action==='authority'){ lookups++; return {status:'denied',reason:'parent_unregistered'}; }
    return rpc(input);
  };
  const logs=[],original=console.warn;
  console.warn=message=>logs.push(message);
  let result;
  try { result=await f.run().run(f.reference); }
  finally { console.warn=original; }
  assert.deepEqual(result,{status:'deny',error_code:'PARENT_UNREGISTERED',side_effects:0,execution_permitted:false});
  assert.deepEqual(cloudDispatchOutcome(result),{status:'denied',reason:{code:'PARENT_UNREGISTERED'}});
  assert.equal(lookups,1);
  assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
  assert.deepEqual(logs.map(message=>JSON.parse(message)),[
    {event:'storage_cloud_authority_failed',phase:'initial',stage:'canonical_result',error_code:'AUTHORITY_RPC_DENIED',reason:'parent_unregistered'},
    {event:'storage_cloud_denied',error_code:'PARENT_UNREGISTERED'},
  ]);
});
test('a parent that becomes unregistered at revalidation keeps the revalidation code',async()=>{
  const f=fixture(),rpc=f.config.rpc;let lookups=0;
  f.config.rpc=async input=>{
    if(input.action==='authority' && ++lookups===2) return {status:'denied',reason:'parent_unregistered'};
    return rpc(input);
  };
  const original=console.warn;
  console.warn=()=>{};
  let result;
  try { result=await f.run().run(f.reference); }
  finally { console.warn=original; }
  assert.equal(result.error_code,'ARTIFACT_AUTHORITY_REVALIDATION_FAILED');
  assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
});
test('authority denial logs only an allowlisted fixed reason label',async()=>{
  for(const [reason,expected] of [['parent_version_mismatch','parent_version_mismatch'],['root_version_mismatch','root_version_mismatch'],
    ['private detail /Clued_资料中心/x',undefined],[{nested:true},undefined],[undefined,undefined]]){
    const f=fixture(),rpc=f.config.rpc;
    f.config.rpc=async input=>input.action==='authority'?{status:'denied',reason}:rpc(input);
    const logs=[],original=console.warn;
    console.warn=message=>logs.push(message);
    let result;
    try { result=await f.run().run(f.reference); }
    finally { console.warn=original; }
    assert.equal(result.error_code,'ARTIFACT_AUTHORITY_RESOLUTION_FAILED');
    assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
    assert.deepEqual(JSON.parse(logs[0]),{event:'storage_cloud_authority_failed',phase:'initial',stage:'canonical_result',
      error_code:'AUTHORITY_RPC_DENIED',...(expected?{reason:expected}:{})});
    assert.equal(logs.join('').includes('Clued_资料中心'),false);
  }
});
for(const [name,options] of Object.entries({revoked:{revoke:true},lostBegin:{lostBegin:true},missingAttemptReceipt:{failAttempt:true},replayedAttempt:{replayedAttempt:true},expiredAdmission:{expireAdmission:true}})){
  test('cloud '+name+' prevents provider mutation and never retries start',async()=>{
    const f=fixture(options),executor=f.run();assert.notEqual((await executor.run(f.reference)).status,'committed');
    assert.equal(f.info().posts,0);await executor.run(f.reference);assert.ok(f.info().starts<=1);assert.equal(f.info().posts,0);
  });
}
for(const [name,options] of Object.entries({lostPost:{lostPost:true},lostFinalize:{lostFinalize:true}})){
  test('cloud '+name+' preserves unknown effect across new executors without redispatch',async()=>{
    const f=fixture(options);assert.equal((await f.run().run(f.reference)).status,'unreconciled');
    assert.equal(f.info().posts,1);assert.equal((await f.run().run(f.reference)).status,'inspection_required');assert.equal(f.info().posts,1);
  });
}
test('batched boundary scan keeps post-write verify inside the subrequest budget that the per-folder scan exhausts',async()=>{
  const FOLDER='application/vnd.google-apps.folder';
  const run=async batched=>{
    const f=fixture(),fetch=f.config.drive_fetch,rpc=f.config.rpc;let used=0;
    // Six ordinary folders beside the registered root: the per-folder scan still
    // admits the write, then the budget runs out during post-write verification.
    for(let i=0;i<6;i++)f.files.set('t'+i,{id:'t'+i,name:'top'+i,parents:['parent'],version:'1',trashed:false,mimeType:FOLDER});
    // Every outbound call (provider or database RPC) spends the same per-invocation budget.
    // The budget allows for the two directory sharing reads per identity resolution:
    // the per-folder scan still runs out during verify, the batched scan fits.
    const spend=()=>{if(++used>60)throw new Error('Too many subrequests.');};
    f.config.drive_fetch=async(url,init)=>{spend();return fetch(url,init);};
    f.config.rpc=async input=>{spend();return rpc(input);};
    if(batched){
      const byId=id=>structuredClone(f.files.get(id));
      const children=id=>[...f.files.values()].filter(x=>x.parents.includes(id)).map(x=>structuredClone(x));
      const chunk=async(ids,read)=>{for(let i=0;i<ids.length;i+=32)spend();return ids.map(read);};
      f.config.metadata_batch=async({access_token})=>{
        assert.equal(access_token,'synthetic-cloud-token');
        return {getFiles:ids=>chunk(ids,byId),listFolders:ids=>chunk(ids,children)};
      };
    }
    const logs=[],original=console.warn;console.warn=message=>logs.push(message);
    try{return {result:await f.run().run(f.reference),posts:f.info().posts,logs:logs.map(m=>JSON.parse(m)),used};}
    finally{console.warn=original;}
  };
  const before=await run(false);
  assert.equal(before.result.status,'unreconciled');
  assert.equal(before.posts,1);
  assert.deepEqual(before.logs[0],{event:'storage_cloud_postcondition_failed',stage:'verify',error_code:'DRIVE_METADATA_SUBREQUEST_LIMIT'});
  const after=await run(true);
  assert.equal(after.result.status,'committed');
  assert.equal(after.posts,1);
  assert.deepEqual(after.logs,[]);
  assert.ok(after.used<=52,String(after.used));
});

// StorageNormalUse.v0.1 §3.1 / Clued Decision fd94bd2f. Both credential profiles hold
// drive.metadata.readonly, so both list the Owner's own and other tools' entries
// (isAppAuthorized: false). Production writes were denied because the island rule
// counted the Owner's "Clued_*" documents beside the root. Only the island rule now
// counts app-authorized entries; structural and absence checks see everything.
const FOLDER='application/vnd.google-apps.folder';
const ownerEntry=(id,name,parent,mimeType=FOLDER)=>({id,name,parents:[parent],version:'1',trashed:false,mimeType});
const ownerCluedMaterial=()=>[
  ownerEntry('o-doc','Clued_单一数据源方案','parent','application/vnd.google-apps.document'),
  ownerEntry('o-folder','Clued 旧资料','parent'),ownerEntry('o-inner','notes.txt','o-folder','text/plain')];
const withBatch=(f,{strip=false}={})=>{
  // The batch transport's fields include isAppAuthorized for reads and listings.
  const view=x=>{const {isAppAuthorized=true,...rest}=structuredClone(x);return strip?rest:{...rest,isAppAuthorized};};
  f.config.metadata_batch=async()=>({getFiles:async ids=>ids.map(id=>view(f.files.get(id))),
    listFolders:async ids=>ids.map(id=>[...f.files.values()].filter(x=>x.parents.includes(id)).map(view))});
};
const quietRun=async f=>{
  const logs=[],original=console.warn;console.warn=message=>logs.push(JSON.parse(message));
  try{return {result:await f.run().run(f.reference),logs};}finally{console.warn=original;}
};
const credentials={legacy:undefined,normal:{scope:normalScope}};
for(const mode of ['single','batched'])for(const [profile,credential] of Object.entries(credentials)){
  const make=(options={})=>{const f=fixture({credential,...options});if(mode==='batched')withBatch(f);return f;};
  test(`${mode}/${profile}: Owner Clued-named material outside the root no longer denies a create`,async()=>{
    const f=make({owner:ownerCluedMaterial()});const {result,logs}=await quietRun(f);
    assert.deepEqual(result,{status:'committed',job_id:ids.job,receipt_id:ids.receipt,execution_permitted:false});
    assert.equal(f.info().starts,1);assert.equal(f.info().posts,1);assert.deepEqual(logs,[]);
  });
  test(`${mode}/${profile}: an app-authorized Clued-named stray outside the root is still denied`,async()=>{
    const f=make({owner:ownerCluedMaterial(),island:true});const {result,logs}=await quietRun(f);
    assert.equal(result.status,'deny');assert.equal(result.error_code,'UNAUTHORIZED_WORKSPACE_MUTATION');
    assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
    assert.deepEqual(logs,[{event:'storage_cloud_denied',error_code:'UNAUTHORIZED_WORKSPACE_MUTATION'}]);
  });
  // Decision b18eff80: an N0-onboarded root of the same owner beside the root
  // is another registered root, named by the server descriptor by Drive ID.
  const withSiblingRoot=(siblings,options={})=>{
    const f=make(options);
    f.files.set('n0',{...ownerEntry('n0','Clued_N0验收_新建','parent'),isAppAuthorized:true});
    f.files.set('n0-track',{...ownerEntry('n0-track','资料','n0'),isAppAuthorized:true});
    if(siblings!==undefined){const load=f.config.load_job;f.config.load_job=async r=>({...await load(r),registered_sibling_roots:siblings});}
    return f;
  };
  test(`${mode}/${profile}: another registered root of the same owner beside the root no longer denies a create`,async()=>{
    const before=withSiblingRoot();const denied=await quietRun(before);
    assert.equal(denied.result.status,'deny');assert.equal(denied.result.error_code,'UNAUTHORIZED_WORKSPACE_MUTATION');
    assert.deepEqual(denied.result.findings.map(x=>x.path).sort(),['G:/My Drive/Clued_N0验收_新建','G:/My Drive/Clued_N0验收_新建/资料']);
    assert.equal(before.info().posts,0);
    const f=withSiblingRoot(['n0']);const {result,logs}=await quietRun(f);
    assert.deepEqual(result,{status:'committed',job_id:ids.job,receipt_id:ids.receipt,execution_permitted:false});
    assert.equal(f.info().posts,1);assert.deepEqual(logs,[]);
    // It does not cover an unrelated Clued stray beside it.
    const stray=withSiblingRoot(['n0'],{island:true});const other=await quietRun(stray);
    assert.equal(other.result.status,'deny');assert.deepEqual(other.result.findings.map(x=>x.path),['G:/My Drive/Clued_品牌说明.md']);
    assert.equal(stray.info().posts,0);
  });
  test(`${mode}/${profile}: a malformed registered_sibling_roots descriptor fails closed with no effect`,async()=>{
    for(const bad of [null,'n0',['root'],['n0','n0']]){
      const f=withSiblingRoot(bad);const {result}=await quietRun(f);
      assert.equal(result.status,'unavailable');assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
    }
  });
  test(`${mode}/${profile}: an Owner same-name file in the destination folder fails exactly as a Clued one`,async()=>{
    const owner=make({owner:[ownerEntry('o-same','new.txt','track','text/plain')]});
    const own=make();own.files.set('c-same',ownerEntry('c-same','new.txt','track','text/plain'));
    const a=await quietRun(owner),b=await quietRun(own);
    assert.notEqual(a.result.status,'committed');assert.deepEqual(a.result,b.result);assert.deepEqual(a.logs,b.logs);
    assert.equal(owner.info().posts,0);assert.equal(own.info().posts,0);
  });
  // Decision 24422a98 (job 3f6c2a1e): an Owner shortcut or an unrelated folder
  // nested deeper than the scan limit outside the root no longer fails writes.
  test(`${mode}/${profile}: an Owner shortcut or deep unrelated folder outside the root does not stop the write`,async()=>{
    const plain=await quietRun(make());
    for(const owner of [[ownerEntry('o-link','link','parent','application/vnd.google-apps.shortcut')],
      [ownerEntry('o-d0','CI-transfer','parent'),...Array.from({length:9},(_,i)=>ownerEntry('o-d'+(i+1),'d'+(i+1),'o-d'+i))]]){
      const f=make({owner});const {result}=await quietRun(f);
      assert.equal(result.status,plain.result.status);assert.notEqual(result.status,'unavailable');
    }
    // More than 10000 unrelated entries beside the root: the scan stops descending
    // instead of failing. Only the per-folder listing bound of the unbatched
    // metadata transport (DRIVE_ENUMERATION_LIMIT) still refuses one folder that size.
    const many=make({owner:Array.from({length:10001},(_,i)=>ownerEntry('o-n'+i,'n'+i+'.png','parent','image/png'))});
    const {result,logs}=await quietRun(many);
    if(mode==='batched') assert.equal(result.status,plain.result.status);
    else { assert.equal(result.status,'unavailable');assert.match(logs[0].error_code,/^DRIVE_ENUMERATION_LIMIT$/); }
  });
  test(`${mode}/${profile}: Owner duplicates, root impersonation and limits keep their failures`,async()=>{
    const cases=[
      [/^DRIVE_BOUNDARY_PATH_AMBIGUOUS$/,[ownerEntry('o-a','same','parent','text/plain'),ownerEntry('o-b','same','parent','text/plain')]],
      [/^DRIVE_BOUNDARY_PATH_AMBIGUOUS$/,[ownerEntry('o-spoof','Clued_资料中心','parent')]],
    ];
    for(const [expected,owner] of cases){
      const f=make({owner});const {result,logs}=await quietRun(f);
      assert.equal(result.status,'unavailable',String(expected));assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
      assert.equal(logs.length,1);assert.equal(logs[0].event,'storage_cloud_unavailable');assert.match(logs[0].error_code,expected);
    }
  });
}
test('a listing without isAppAuthorized counts an Owner Clued-named entry (fail closed)',async()=>{
  const f=fixture({owner:ownerCluedMaterial()});withBatch(f,{strip:true});
  const {result}=await quietRun(f);
  assert.equal(result.status,'deny');assert.equal(result.error_code,'UNAUTHORIZED_WORKSPACE_MUTATION');assert.equal(f.info().posts,0);
});
test('unavailable runs log one fixed code: shape checks, boundary scan refusals, never inputs',async()=>{
  const cases=[
    ['CLOUD_MUTATION_SHAPE_INVALID',f=>{const load=f.config.load_job;f.config.load_job=async r=>({...await load(r),mutation:{operation:'create',target_kind:'file',destination_path:root+'/track/x.txt'}});}],
    ['CLOUD_DESCRIPTOR_INVALID',f=>{const load=f.config.load_job;f.config.load_job=async r=>({...await load(r),request_digest:'private '+root});}],
    // A replace of a file Clued has not registered: the database names no revisions to release.
    ['CLOUD_REPLACE_TARGET_UNREGISTERED',f=>{const load=f.config.load_job;f.config.load_job=async r=>({...await load(r),revision_releases:null,
      mutation:{operation:'replace',target_kind:'file',destination_path:root+'/track/map.json',destination_file_version:'16',content:'{}'}});}],
    ['CLOUD_PROFILE_INVALID',f=>{const load=f.config.load_job;f.config.load_job=async r=>{const d=await load(r);d.profile.policy_version='other';return d;};}],
    ['DRIVE_BOUNDARY_PATH_AMBIGUOUS',f=>{f.files.set('dup',ownerEntry('dup','track','parent'));f.files.set('dup2',ownerEntry('dup2','track','parent'));}],
    ['UNSPECIFIED',f=>{f.config.load_job=async()=>{throw new Error('private database detail '+ids.job);};}],
  ];
  for(const [code,arrange] of cases){
    const f=fixture();arrange(f);
    const logs=[],original=console.warn;console.warn=message=>logs.push(message);
    let result;
    try{result=await f.run().run(f.reference);}finally{console.warn=original;}
    assert.equal(result.status,'unavailable',code);assert.equal(f.info().starts,0,code);assert.equal(f.info().posts,0,code);
    assert.deepEqual(logs.map(m=>JSON.parse(m)),[{event:'storage_cloud_unavailable',error_code:code}],code);
    assert.equal(logs.join('').includes(root),false);assert.equal(logs.join('').includes(ids.job),false);
    // The same fixed label (never an exception text) names the result for the dispatch report.
    assert.deepEqual(result,code==='UNSPECIFIED'?{status:'unavailable',execution_permitted:false}:
      {status:'unavailable',execution_permitted:false,error_code:code},code);
  }
});
test('the pre-effect identity check is not read again; its failure leaves no provider attempt (fix d9d6db4c)',async()=>{
  const f=fixture(),fetch=f.config.drive_fetch,rpc=f.config.rpc;let reads=0;const actions=[];
  // Reads 1-3: initial, revalidation, durable start. Read 4: the pre-effect check.
  f.config.drive_fetch=async(url,init)=>{
    if(new URL(url).searchParams.get('q')?.includes("name = 'track'") && ++reads===4) throw new Error('transient');
    return fetch(url,init);
  };
  f.config.rpc=async input=>{actions.push(input.action);return rpc(input);};
  const logs=[],original=console.warn;
  console.warn=message=>logs.push(message);
  let result;
  try { result=await f.run().run(f.reference); }
  finally { console.warn=original; }
  assert.equal(result.status,'unreconciled');
  assert.equal(reads,4,'no second pre-effect read');
  assert.equal(actions.includes('provider_attempt'),false);assert.equal(f.info().posts,0);
  assert.deepEqual(JSON.parse(logs[0]),{event:'storage_cloud_authority_failed',phase:'pre_effect',stage:'provider_identity',
    error_code:'DRIVE_METADATA_REQUEST_FAILED'});
});
test('an error status from Drive is final and not read again',async()=>{
  const f=fixture(),fetch=f.config.drive_fetch;let reads=0;
  f.config.drive_fetch=async(url,init)=>{
    if(new URL(url).searchParams.get('q')?.includes("name = 'track'")){ reads++; return new Response('{}',{status:404}); }
    return fetch(url,init);
  };
  const original=console.warn;console.warn=()=>{};
  try { assert.equal((await f.run().run(f.reference)).status,'deny'); }
  finally { console.warn=original; }
  assert.equal(reads,1);
});
