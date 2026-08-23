import assert from "node:assert/strict";
import test from "node:test";

test("renders Clued account entry", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Clued — One you\. Every AI\./i);
  assert.match(html, /Clued by Pixel Gravity/i);
});

test("ships bilingual copy and an eight-character password rule", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /const MIN_PASSWORD_LENGTH = 8;/);
  assert.match(source, /headlineOne: "一个你。"/);
  assert.match(source, /headlineOne: "One you\."/);
  assert.match(source, /Clued by Pixel Gravity/);
  assert.doesNotMatch(source, /setError\(result\.error\.message\)/);
});
