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
        const bridged=fixture(), descriptor=await bridged.config.load_job(bridged.reference);
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
        return Response.json({result,good:good.info(),first,restart,lost:lost.info(),bridgedResult,bridgedPosts:bridged.info().posts});
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
    assert.equal(outbound, 0);
  } finally { await runtime.dispose(); }
});
