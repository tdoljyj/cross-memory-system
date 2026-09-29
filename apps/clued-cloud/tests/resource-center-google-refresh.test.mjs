import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
const directory = await mkdtemp(path.join(os.tmpdir(), "clued-google-refresh-"));
async function load(name) {
  const output = path.join(directory, name+".mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../worker/"+name+".ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(output));
}
const { createStorageGoogleRefresh } = await load("storage-google-refresh");
const { createStorageCredentialVault } = await load("storage-credential-vault");
const scope = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const initial = 1700000000000;
async function fixture(changes = {}) {
  let now = initial, commitCount = 0;
  const requests = [], calls = [];
  const context = { owner_id: randomUUID(), connection_id: randomUUID(), provider: "google-drive", provider_subject: "fixture-user",
    oauth_client_id: "fixture.apps.googleusercontent.com", credential_version: 1 };
  const vaultConfig = { current_key_id: "k1", keys: { k1: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(vaultConfig);
  const envelope = await vault.seal(JSON.stringify({ access_token: "fixture-old-access-token", refresh_token: "fixture-original-refresh-token", token_type: "Bearer", scope,
    ...(changes.previous ?? {}) }), context);
  const refresher = await createStorageGoogleRefresh({ client_id: context.oauth_client_id, client_secret: "fixture-private-client-secret", vault: vaultConfig, clock: () => now,
    rpc: async input => {
      requests.push(structuredClone(input));
      if (input.action === "claim") {
        if (changes.claimError) throw new Error("unavailable");
        return { ...context, attempt_id: input.attempt_id, status: "acquired", credential_envelope: envelope,
          root_folder_id: "fixture-root", root_parent_id: "fixture-parent", expires_at: new Date(initial+120000).toISOString(), ...(changes.claim ?? {}) };
      }
      if (input.action === "commit") { if (++commitCount <= (changes.lostCommits ?? 0)) throw new Error("lost reply"); return { status: "committed" }; }
      if (input.action === "fail") return { status: "failed" };
      throw new Error("unexpected RPC");
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init }); assert.equal(init.redirect, "manual"); assert.equal(init.cache, "no-store");
      if (String(url) === "https://oauth2.googleapis.com/token") {
        if (changes.networkError) throw new Error("unknown delivery");
        if (changes.malformed) return new Response("not JSON");
        if (changes.providerError) return Response.json({ error: changes.providerError }, { status: 400 });
        now += changes.delay ?? 0;
        return Response.json({ access_token: "fixture-new-access-token", token_type: "Bearer", expires_in: 3600, ...(changes.tokens ?? {}) });
      }
      assert.equal(init.headers.authorization, "Bearer fixture-new-access-token");
      if (String(url).includes("/about?")) return Response.json({ user: { me: true, permissionId: "fixture-user", ...(changes.user ?? {}) } });
      return Response.json({ id: "fixture-root", mimeType: "application/vnd.google-apps.folder", trashed: false, parents: ["fixture-parent"],
        isAppAuthorized: true, capabilities: { canAddChildren: true }, ...(changes.root ?? {}) });
    },
  });
  return { calls, requests, run: () => refresher.run(context.connection_id), plain: async () => JSON.parse(await vault.open(requests.find(x => x.action === "commit").credential_envelope,
    { ...context, credential_version: 2 })) };
}
test("account refresh inherits exact scope, preserves omitted refresh token and seals the next revision", async () => {
  const f = await fixture({ delay: 20000 }); assert.deepEqual(await f.run(), { status: "committed" });
  const plain = await f.plain();
  assert.equal(plain.refresh_token, "fixture-original-refresh-token"); assert.equal(plain.scope, scope);
  assert.equal(plain.expires_at_ms, initial+3600000);
  const body = new URLSearchParams(f.calls[0].init.body);
  assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.has("scope"), false);
  assert.equal(f.calls.length, 3);
  assert.equal(JSON.stringify(f.requests).includes("fixture-original-refresh-token"), false);
  assert.equal(JSON.stringify(f.requests).includes("fixture-new-access-token"), false);
});
test("rotated refresh token persists; lost commit reply retries identical ciphertext, never Google", async () => {
  const f = await fixture({ tokens: { refresh_token: "fixture-rotated-refresh-token", scope }, lostCommits: 1 });
  assert.deepEqual(await f.run(), { status: "committed" }); assert.equal((await f.plain()).refresh_token, "fixture-rotated-refresh-token");
  const commits = f.requests.filter(x => x.action === "commit"); assert.equal(commits.length, 2); assert.deepEqual(commits[0], commits[1]);
  assert.equal(f.calls.filter(x => x.url.endsWith("/token")).length, 1);
});
test("unacquired or failed claim performs no provider request", async () => {
  for (const changes of [{ claimError: true }, { claim: { status: "claimed" } }, { claim: { status: "committed" } }]) {
    const f = await fixture(changes); assert.notEqual((await f.run()).status, "committed"); assert.equal(f.calls.length, 0);
  }
});
test("unknown token exchange or lost settlement stays fenced without automatic provider replay", async () => {
  for (const changes of [{ networkError: true }, { malformed: true }, { providerError: "unknown_error" }, { lostCommits: 2 }]) {
    const f = await fixture(changes); assert.deepEqual(await f.run(), { status: "uncertain" });
    assert.equal(f.calls.filter(x => x.url.endsWith("/token")).length, 1); assert.equal(f.requests.some(x => x.action === "fail"), false);
  }
});
test("explicit provider rejection and temporary failure use distinct bounded settlement reasons", async () => {
  for (const error of ["invalid_grant", "invalid_client", "server_error", "temporarily_unavailable"]) {
    const f = await fixture({ providerError: error }); assert.deepEqual(await f.run(), { status: "unavailable" });
    assert.equal(f.requests.at(-1).reason, error.startsWith("invalid") ? "provider_rejected" : "provider_unavailable"); assert.equal(f.calls.length, 1);
  }
});
test("scope, provider identity, parent, app grant, clock deadline and expiry changes fail closed", async () => {
  for (const changes of [{ tokens: { scope: scope+" https://www.googleapis.com/auth/drive" } }, { tokens: { scope: "https://www.googleapis.com/auth/drive.file" } },
    { tokens: { expires_in: "3600" } }, { tokens: { expires_in: 100 } }, { tokens: { refresh_token: "short" } }, { user: { permissionId: "other" } },
    { user: { me: false } }, { root: { parents: ["other-parent"] } }, { root: { isAppAuthorized: false } }, { root: { trashed: true } },
    { root: { capabilities: { canAddChildren: false } } }, { delay: 120000 }, { delay: 70000, tokens: { expires_in: 120 } }]) {
    const f = await fixture(changes); assert.deepEqual(await f.run(), { status: "unavailable" });
    assert.equal(f.requests.some(x => x.action === "commit"), false); assert.equal(f.requests.at(-1).reason, "provider_rejected");
  }
});
test("invalid stored credentials and forged claim identity never leave the server", async () => {
  for (const changes of [{ previous: { scope: "https://www.googleapis.com/auth/drive" } }, { previous: { refresh_token: "short" } },
    { claim: { oauth_client_id: "wrong-client" } }, { claim: { credential_version: 2 } }, { claim: { expires_at: new Date(initial-1).toISOString() } }]) {
    const f = await fixture(changes); assert.deepEqual(await f.run(), { status: "unavailable" }); assert.equal(f.calls.length, 0);
    assert.equal(f.requests.at(-1).reason, "credential_invalid");
  }
});
