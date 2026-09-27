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
      export default { async fetch() {
        const good = fixture();
        const result = await good.run().run(good.reference);
        const lost = fixture({lostPost:true});
        const first = await lost.run().run(lost.reference);
        const restart = await lost.run().run(lost.reference);
        return Response.json({result,good:good.info(),first,restart,lost:lost.info()});
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
    assert.equal(outbound, 0);
  } finally { await runtime.dispose(); }
});
