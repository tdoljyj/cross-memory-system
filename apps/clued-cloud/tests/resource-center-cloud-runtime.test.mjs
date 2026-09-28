import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

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
        let v2Finish=null;
        const v2Bridge=await createStorageCloudWorker({client_id:'test-client',vault:keys,account_policy_v2:true,
          clock:v2.config.clock,fetch:v2.config.drive_fetch,rpc:async input=>{
            if(input.action==='verified_inspect') return {status:'none',connection_id:v2.reference.connection_id,
              job_id:v2.reference.job_id,execution_permitted:false};
            if(input.action==='load') return {...v2Descriptor,credential_envelope:envelope,oauth_client_id:'test-client'};
            if(input.action==='verified_record'){
              if(input.credential_version!==1 || input.proof?.contract!=='clued.storage-create-verified/2') throw Error('proof shape');
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
        return Response.json({result,good:good.info(),first,restart,lost:lost.info(),bridgedResult,bridgedPosts:bridged.info().posts,
          v2Result,v2Posts:v2.info().posts,
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
    assert.equal(body.v2Result.status,"committed");
    assert.equal(body.v2Posts,1);
    assert.equal(body.recoveredResult.status,"committed");
    assert.deepEqual(body.replayCalls,["verified_inspect","settle_verified"]);
    assert.equal(outbound, 0);
  } finally { await runtime.dispose(); }
});
