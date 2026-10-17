import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("private Worker retry boundaries retain identity, deadlines and original outcomes", async t => {
  const {outputFiles}=await build({stdin:{contents:
    "export {fixture,ids} from './tests/resource-center-cloud-executor.fixture.mjs';"+
    "export {createStorageCloudWorker} from './worker/storage-cloud-executor.ts';"+
    "export {createStorageCredentialVault} from './worker/storage-credential-vault.ts';",
    resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,platform:'node',format:'esm',write:false});
  const {fixture,ids,createStorageCloudWorker,createStorageCredentialVault}=
    await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
  const cases=[
    ['one_rollback','committed',2,1],['always_timeout','unavailable',3,0],
    ['network_lost','inspection_required',1,0],['unknown_report','inspection_required',1,0],
    ['bad_report_identity','inspection_required',1,0],['begin_response_mismatch','inspection_required',1,0],
    ['postwrite_timeout','unreconciled',1,1],['unknown_message','deny',1,0],
    ['deadline','unavailable',1,0],['changed_digest','unavailable',1,0],
    ['changed_credential','unavailable',1,0],['changed_owner','unavailable',1,0],
    ['read_unavailable','unavailable',1,0],['read_refused','deny',1,0],
    ['business_cas','deny',1,0],['wrong_http_status','deny',1,0],['non_error_metadata','deny',1,0],
    ['reload_denied','denied',1,0],['reload_cancelled','cancelled',1,0],
    ['reload_attention','attention_required',1,0],['reload_committed','committed',1,0],
    ['reload_bad_receipt','inspection_required',1,0],['reload_unknown_status','inspection_required',1,0],
    ['reload_bad_identity','unavailable',1,0],['reload_private_reason','denied',1,0],
  ];
  for(const [mode,expected,beginsExpected,postsExpected] of cases) await t.test(mode,async()=>{
    const f=fixture({redirect:'manual'}),d=await f.config.load_job(f.reference),token=await f.config.get_credential();
    d.ancestor_match=[{path:d.profile.managed_root,provider_file_id:'root',match:'version'},
      {path:d.profile.managed_root+'/track',provider_file_id:'track',match:'version'}];
    const keys={current_key_id:'test',keys:{test:btoa('b'.repeat(32)).replace(/=+$/,'')}};
    const vault=await createStorageCredentialVault(keys);
    const envelope=await vault.seal(JSON.stringify({...token,token_type:'Bearer'}),{owner_id:d.owner_id,
      connection_id:d.connection_id,provider:'google-drive',provider_subject:d.provider_subject,
      credential_version:d.credential_version,oauth_client_id:'test-client'});
    const timeout=()=>Object.assign(new Error('canceling statement due to statement timeout'),{status:500,details:{code:'57014'}});
    let begins=0,loads=0,reports=0,finish=null,forcedClock=null;const requests=[],warnings=[];
    const bridge=await createStorageCloudWorker({client_id:'test-client',vault:keys,account_policy_v2:true,
      clock:()=>forcedClock??f.config.clock(),fetch:f.config.drive_fetch,rpc:async input=>{
        if(input.action==='verified_inspect')return {status:'none',...f.reference,execution_permitted:false};
        if(input.action==='load'){
          loads++;
          if(loads>1&&mode==='read_unavailable')throw new Error('synthetic original read lost');
          if(loads>1&&mode==='read_refused')throw Object.assign(new Error('work_claim_not_active'),{status:403,details:{code:'42501'}});
          const current={...d,credential_envelope:envelope,oauth_client_id:'test-client'};
          if(loads>1&&mode==='changed_digest')current.request_digest='b'.repeat(64);
          if(loads>1&&mode==='changed_credential')current.credential_version++;
          if(loads>1&&mode==='changed_owner')current.owner_id=ids.receipt;
          if(loads>1&&mode.startsWith('reload_'))return {...f.reference,request_digest:d.request_digest,
            status:mode==='reload_cancelled'?'cancelled':mode==='reload_attention'?'attention_required':
              mode==='reload_committed'?'committed':mode==='reload_unknown_status'?'started':'denied',
            intent_id:mode==='reload_committed'?ids.intent:null,receipt_id:mode==='reload_bad_receipt'?'invalid':ids.receipt,
            reason_code:mode==='reload_cancelled'?'NO_PROVIDER_ATTEMPT':mode==='reload_attention'?'DISPATCH_NOT_STARTED':
              mode==='reload_private_reason'?'PRIVATE_REASON_WITHOUT_ALLOWLIST':'STORAGE_OBJECT_UNDER_REVIEW',
            private_payload:token.access_token,execution_permitted:false,
            ...(mode==='reload_bad_identity'?{job_id:ids.receipt}:{})};
          return current;
        }
        if(input.action==='begin'){
          begins++;requests.push(structuredClone(input));
          if(['network_lost','unknown_report','bad_report_identity','begin_response_mismatch'].includes(mode)){
            const begun=await f.config.rpc(input);
            if(mode==='begin_response_mismatch')return {...begun,job_id:ids.receipt};
            throw new Error('synthetic lost original begin reply');
          }
          if(mode==='unknown_message')throw Object.assign(new Error('private arbitrary SQL text'),{status:500,details:{code:'57014'}});
          if(mode==='business_cas')throw Object.assign(new Error('work_claim_fence_mismatch'),{status:500,details:{code:'40001'}});
          if(mode==='wrong_http_status')throw Object.assign(timeout(),{status:400});
          if(mode==='non_error_metadata')throw {message:'canceling statement due to statement timeout',status:500,details:{code:'57014'}};
          if(mode==='deadline'){forcedClock=f.config.clock()+25001;throw timeout();}
          if(mode==='always_timeout'||begins===1&&(mode.startsWith('reload_')||['one_rollback','changed_digest','changed_credential','changed_owner','read_unavailable','read_refused'].includes(mode)))throw timeout();
        }
        if(input.action==='verified_record'){
          if(mode==='postwrite_timeout')throw timeout();
          finish=input.finish;return {status:'verified',intent_id:input.finish.intent_id,verified_receipt_id:ids.receipt,
            verified_digest:'a'.repeat(64),version:3,execution_permitted:false};
        }
        if(input.action==='settle_verified')return {...await f.config.rpc({...input,...finish,action:'finalize'}),execution_permitted:false};
        if(input.action==='report'){
          reports++;if(mode==='unknown_report')throw new Error('synthetic original report lost');
          const started=f.info().starts>0;
          return {...f.reference,request_digest:d.request_digest,status:started?'started':'denied',intent_id:started?ids.intent:null,
            receipt_id:ids.receipt,execution_permitted:false,...(mode==='bad_report_identity'?{job_id:ids.receipt,status:'committed'}:{})};
        }
        return f.config.rpc(input);
      }});
    const warn=console.warn;console.warn=value=>warnings.push(String(value));let result;
    try{result=await bridge.run(f.reference);}finally{console.warn=warn;}
    assert.equal(result.status,expected,JSON.stringify({mode,result}));
    assert.equal(begins,beginsExpected);assert.equal(f.info().posts,postsExpected);
    for(const request of requests)assert.deepEqual(request,requests[0],'never change the original job/key/payload');
    if(expected==='unavailable'){
      assert.equal(result.error_code,'STORAGE_ADMISSION_RETRY_PENDING');assert.equal(reports,0);
    }
    if(mode==='unknown_report')assert.equal(reports,2);
    if(mode==='deadline')assert.equal(loads,1,'no new read or begin after the retry deadline');
    if(mode.startsWith('reload_')){
      assert.equal(reports,0,'do not overwrite a concurrent original result');
      assert.equal(loads,2);assert.equal(f.info().starts,0);
      assert.equal('private_payload' in result,false);assert.equal(JSON.stringify(result).includes(token.access_token),false);
      if(['reload_denied','reload_cancelled','reload_attention','reload_committed','reload_private_reason'].includes(mode))
        assert.equal(result.receipt_id,ids.receipt);
      if(mode==='reload_denied')assert.equal(result.reason_code,'STORAGE_OBJECT_UNDER_REVIEW');
      if(mode==='reload_cancelled')assert.equal(result.reason_code,'NO_PROVIDER_ATTEMPT');
      if(mode==='reload_attention')assert.equal(result.reason_code,'DISPATCH_NOT_STARTED');
      if(mode==='reload_private_reason')assert.equal('reason_code' in result,false);
    }
    for(const secret of ['private arbitrary SQL text','synthetic lost original',token.access_token,'credential_envelope'])
      assert.equal(warnings.join('\n').includes(secret),false);
    assert.equal(result.execution_permitted,false);
  });
});

// Exercise the actual cloud composition in workerd with synthetic provider/RPC
// closures. No production bindings, mounted Drive, credentials or outbound IO.
test("cloud executor runs in workerd; unknown provider effects survive executor replacement", async () => {
  const { outputFiles } = await build({
    stdin: { contents: `
      import { fixture } from './tests/resource-center-cloud-executor.fixture.mjs';
      import { createStorageCloudWorker } from './worker/storage-cloud-executor.ts';
      import { createStorageCredentialVault } from './worker/storage-credential-vault.ts';
      export default { async fetch() {
        const good = fixture();
        const result = await good.run().run(good.reference);
        const lost = fixture({lostPost:true});
        const first = await lost.run().run(lost.reference);
        const restart = await lost.run().run(lost.reference);
        const bridged=fixture({redirect:'manual'}), descriptor=await bridged.config.load_job(bridged.reference);
        const token=await bridged.config.get_credential();
        const keys={current_key_id:'test',keys:{test:btoa('b'.repeat(32)).replace(/=+$/,'')}};
        const vault=await createStorageCredentialVault(keys);
        const envelope=await vault.seal(JSON.stringify({...token,token_type:'Bearer'}),{owner_id:descriptor.owner_id,
          connection_id:descriptor.connection_id,provider:'google-drive',provider_subject:descriptor.provider_subject,
          credential_version:descriptor.credential_version,oauth_client_id:'test-client'});
        const bridge=await createStorageCloudWorker({client_id:'test-client',vault:keys,clock:bridged.config.clock,fetch:bridged.config.drive_fetch,
          rpc:async input=>input.action==='load'?{...descriptor,credential_envelope:envelope,oauth_client_id:'test-client'}:
            bridged.config.rpc(input.action==='finalize'?{...input.finish,connection_id:input.connection_id,job_id:input.job_id}:input)});
        const bridgedResult=await bridge.run(bridged.reference);
        const v2=fixture({redirect:'manual'}),v2Descriptor=await v2.config.load_job(v2.reference);
        v2Descriptor.ancestor_match=[{path:v2Descriptor.profile.managed_root,provider_file_id:'root',match:'version'},
          {path:v2Descriptor.profile.managed_root+'/track',provider_file_id:'track',match:'version'}];
        let v2Finish=null,v2SemanticObservation=null;
        const v2Bridge=await createStorageCloudWorker({client_id:'test-client',vault:keys,account_policy_v2:true,
          clock:v2.config.clock,fetch:v2.config.drive_fetch,rpc:async input=>{
            if(input.action==='verified_inspect') return {status:'none',connection_id:v2.reference.connection_id,
              job_id:v2.reference.job_id,execution_permitted:false};
            if(input.action==='load') return {...v2Descriptor,credential_envelope:envelope,oauth_client_id:'test-client'};
            if(input.action==='verified_record'){
              if(input.credential_version!==1 || input.proof?.contract!=='clued.storage-create-verified/2') throw Error('proof shape');
              if(input.semantic_observation?.contract!=='clued.storage-semantic-observation/1') throw Error('semantic proof shape');
              v2SemanticObservation=input.semantic_observation;
              v2Finish=input.finish;
              return {status:'verified',intent_id:input.finish.intent_id,verified_receipt_id:bridged.reference.job_id,
                verified_digest:'a'.repeat(64),version:3,execution_permitted:false};
            }
            if(input.action==='settle_verified'){
              if('credential_version' in input || !v2Finish || input.verified_digest!=='a'.repeat(64)) throw Error('settle shape');
              return v2.config.rpc({...input,...v2Finish,action:'finalize'}).then(done=>({...done,execution_permitted:false}));
            }
            return v2.config.rpc(input);
          }});
        const v2Result=await v2Bridge.run(v2.reference);
        let replayCalls=[];
        const recovered=await createStorageCloudWorker({client_id:'test-client',vault:keys,account_policy_v2:true,
          fetch:async()=>{throw Error('provider must not run')},rpc:async input=>{
            replayCalls.push(input.action);
            if(input.action==='verified_inspect') return {status:'verified',connection_id:bridged.reference.connection_id,
              job_id:bridged.reference.job_id,verified_receipt_id:bridged.reference.job_id,verified_digest:'a'.repeat(64),execution_permitted:false};
            if(input.action==='settle_verified') return {status:'committed',state:'committed',final_result:{status:'committed'},
              receipt_id:bridged.reference.job_id,execution_permitted:false};
            throw Error('unexpected action');
          }});
        const recoveredResult=await recovered.run(bridged.reference);
        return Response.json({result,good:good.info(),first,restart,lost:lost.info(),bridgedResult,bridgedPosts:bridged.info().posts,bridgedBatches:bridged.info().batches,
          v2Result,v2Posts:v2.info().posts,v2SemanticObservation,
          recoveredResult,replayCalls});
      }};`, resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "cloud-runtime-fixture.mjs" },
    bundle: true, platform: "node", format: "esm", write: false,
  });
  let outbound = 0;
  const runtime = new Miniflare({
    host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false },
    workers: [{
      config: {
        name: "clued-resource-center-runtime-test", type: "worker",
        compatibilityDate: "2026-08-23", compatibilityFlags: ["nodejs_compat"],
        manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: outputFiles[0].text } } },
      },
      dev: { outboundService: { type: "fetcher", handler: () => { outbound++; return new Response("Outbound forbidden", {status:503}); } } },
    }],
  });
  try {
    const response = await runtime.dispatchFetch("http://localhost/");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.status, "committed");
    assert.equal(body.good.posts, 1);
    assert.equal(body.good.starts, 1);
    assert.equal(body.first.status, "unreconciled");
    assert.equal(body.restart.status, "inspection_required");
    assert.equal(body.lost.posts, 1);
    assert.equal(body.lost.starts, 1);
    assert.equal(body.bridgedResult.status,"committed");
    assert.equal(body.bridgedPosts,1);
    assert.ok(body.bridgedBatches>0);
    assert.equal(body.v2Result.status,"committed");
    assert.equal(body.v2Posts,1);
    assert.equal(body.v2SemanticObservation.contract,"clued.storage-semantic-observation/1");
    assert.equal(body.v2SemanticObservation.first.state.marker,"50000000-0000-4000-8000-000000000001");
    assert.deepEqual(body.v2SemanticObservation.first.state,body.v2SemanticObservation.second.state);
    assert.equal(body.recoveredResult.status,"committed");
    assert.deepEqual(body.replayCalls,["verified_inspect","settle_verified"]);
    assert.equal(outbound, 0);
  } finally { await runtime.dispose(); }
});

test("Worker credential closure labels a post-write expiry without changing the fail-closed outcome", async () => {
  const { outputFiles } = await build({
    stdin: { contents: `
      export { fixture } from './tests/resource-center-cloud-executor.fixture.mjs';
      export { createStorageCloudWorker } from './worker/storage-cloud-executor.ts';
      export { createStorageCredentialVault } from './worker/storage-credential-vault.ts';`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "cloud-credential-label.mjs" },
    bundle: true, platform: "node", format: "esm", write: false,
  });
  const { fixture, createStorageCloudWorker, createStorageCredentialVault } =
    await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64"));
  const f = fixture({redirect:'manual'}), descriptor = await f.config.load_job(f.reference);
  const token = await f.config.get_credential(), start = f.config.clock();
  const keys = {current_key_id:'test',keys:{test:btoa('b'.repeat(32)).replace(/=+$/,'')}};
  const vault = await createStorageCredentialVault(keys);
  const envelope = await vault.seal(JSON.stringify({...token,token_type:'Bearer',expires_at_ms:start+120000}),{owner_id:descriptor.owner_id,
    connection_id:descriptor.connection_id,provider:'google-drive',provider_subject:descriptor.provider_subject,
    credential_version:descriptor.credential_version,oauth_client_id:'test-client'});
  // The token is valid for the pre-write steps and falls inside the 60 s margin only after the one POST.
  const bridge = await createStorageCloudWorker({client_id:'test-client',vault:keys,fetch:f.config.drive_fetch,
    clock:()=>f.info().posts ? start+90000 : start,
    rpc:async input=>input.action==='load'?{...descriptor,credential_envelope:envelope,oauth_client_id:'test-client'}:
      f.config.rpc(input.action==='finalize'?{...input.finish,connection_id:input.connection_id,job_id:input.job_id}:input)});
  const logs = [], original = console.warn;
  console.warn = message => logs.push(message);
  let result;
  try { result = await bridge.run(f.reference); }
  finally { console.warn = original; }
  assert.equal(result.status, "unreconciled");
  assert.equal(f.info().posts, 1);
  assert.deepEqual(JSON.parse(logs[0]), {event:"storage_cloud_postcondition_failed",stage:"verify",error_code:"STORAGE_CREDENTIAL_EXPIRING"});
  assert.equal(logs.join("").includes(f.reference.job_id), false);
});

test("Worker report stores the fixed deny reason in account-policy mode only, never logs paths, and falls back to the plain outcome", async () => {
  const { outputFiles } = await build({
    stdin: { contents: `
      export { fixture } from './tests/resource-center-cloud-executor.fixture.mjs';
      export { createStorageCloudWorker } from './worker/storage-cloud-executor.ts';
      export { createStorageCredentialVault } from './worker/storage-credential-vault.ts';`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "cloud-dispatch-reason.mjs" },
    bundle: true, platform: "node", format: "esm", write: false,
  });
  const { fixture, createStorageCloudWorker, createStorageCredentialVault } =
    await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64"));
  const keys = {current_key_id:'test',keys:{test:btoa('b'.repeat(32)).replace(/=+$/,'')}};
  const vault = await createStorageCredentialVault(keys);
  const scenario = async ({ v2, rejectReason = false }) => {
    const f = fixture({island:true}), descriptor = await f.config.load_job(f.reference), token = await f.config.get_credential();
    const envelope = await vault.seal(JSON.stringify({...token,token_type:'Bearer'}),{owner_id:descriptor.owner_id,
      connection_id:descriptor.connection_id,provider:'google-drive',provider_subject:descriptor.provider_subject,
      credential_version:descriptor.credential_version,oauth_client_id:'test-client'});
    const reports = [];
    const bridge = await createStorageCloudWorker({client_id:'test-client',vault:keys,fetch:f.config.drive_fetch,clock:f.config.clock,
      account_policy_v2:v2,rpc:async input=>{
        if(input.action==='verified_inspect') return {status:'none',connection_id:f.reference.connection_id,job_id:f.reference.job_id,execution_permitted:false};
        if(input.action==='recovery_load') throw Error('no recovery');
        if(input.action==='load') return {...descriptor,credential_envelope:envelope,oauth_client_id:'test-client'};
        if(input.action==='report'){
          reports.push(structuredClone(input));
          if(rejectReason && input.outcome.reason) throw Error('storage_cloud_denied');
          return {status:input.outcome.status};
        }
        throw Error('unexpected action '+input.action);
      }});
    const logs = [], original = console.warn;
    console.warn = message => logs.push(message);
    let result;
    try { result = await bridge.run(f.reference); } finally { console.warn = original; }
    assert.equal(result.status, "deny"); assert.equal(f.info().starts, 0); assert.equal(f.info().posts, 0);
    assert.deepEqual(logs.map(m=>JSON.parse(m)), [{event:"storage_cloud_denied",error_code:"UNAUTHORIZED_WORKSPACE_MUTATION"}]);
    assert.equal(logs.join("").includes("Clued_品牌说明"), false);
    return { reports, reference: f.reference };
  };
  const reason = {code:"UNAUTHORIZED_WORKSPACE_MUTATION",
    findings:[{path:"G:/My Drive/Clued_品牌说明.md",reason:"resource_center_parent_or_sibling_island"}]};
  const v2 = await scenario({ v2: true });
  assert.deepEqual(v2.reports, [{...v2.reference,action:"report",credential_version:1,outcome:{status:"denied",reason}}]);
  // The legacy bridge keeps its exact {status} contract.
  const legacy = await scenario({ v2: false });
  assert.deepEqual(legacy.reports.map(r=>r.outcome), [{status:"denied"}]);
  // A server that predates the reason still records the plain outcome.
  const old = await scenario({ v2: true, rejectReason: true });
  assert.deepEqual(old.reports.map(r=>r.outcome), [{status:"denied",reason},{status:"denied"}]);
});
