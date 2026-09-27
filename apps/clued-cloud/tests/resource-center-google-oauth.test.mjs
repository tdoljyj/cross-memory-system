import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
const output = path.join(await mkdtemp(path.join(os.tmpdir(), "clued-google-oauth-")), "oauth.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-google-oauth.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm" });
const { createStorageGoogleOAuth } = await import(pathToFileURL(output));
const vaultOutput = path.join(path.dirname(output), "vault.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-credential-vault.ts", import.meta.url))], outfile: vaultOutput, bundle: true, platform: "node", format: "esm" });
const { createStorageCredentialVault } = await import(pathToFileURL(vaultOutput));
const scope = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const d = { owner_id: randomUUID(), connection_id: randomUUID(), connection_version: 1, credential_version: 1,
  provider_subject: null, oauth_client_id: "fixture.apps.googleusercontent.com", redirect_uri: "https://clued.example.invalid/storage/google/callback", root_folder_id: "root-id", root_parent_id: "root-parent" };
async function fixture(changes = {}) {
  let pending, complete, claims = 0; const calls = [];
  const vaultConfig = { current_key_id: "k1", keys: { k1: randomBytes(32).toString("base64url") } };
  const oauth = await createStorageGoogleOAuth({ client_id: d.oauth_client_id, client_secret: "fixture-only-client-secret", redirect_uri: d.redirect_uri,
    vault: vaultConfig, clock: changes.clock,
    rpc: async input => {
      if (input.action === "describe") return { ...d, ...(changes.descriptor ?? {}) };
      if (input.action === "prepare") { pending = input; return { status: "prepared" }; }
      if (input.action === "claim") {
        claims++; if (!pending || pending.state_hash !== input.state_hash || changes.denied) throw new Error("no state");
        if (complete) return { status: "completed", receipt_id: complete.receipt_id };
        if (claims > 1) throw new Error("already claimed");
        return { ...d, ...(changes.descriptor ?? {}), status: "claimed", attempt_id: pending.attempt_id, verifier_envelope: pending.verifier_envelope };
      }
      if (input.action === "complete") { complete = { ...input, receipt_id: randomUUID() }; return { status: "completed", receipt_id: complete.receipt_id }; }
      throw new Error("unknown operation");
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      assert.equal(init.redirect, "manual");
      if (changes.networkFailure) throw new Error("fixture-secret-in-upstream-error");
      if (String(url).endsWith("/token") && changes.tokenResponse) return changes.tokenResponse();
      if (String(url).endsWith("/token")) return Response.json({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", token_type: "Bearer", expires_in: 3600, scope, ...(changes.tokens ?? {}) });
      assert.equal(init.headers.authorization, "Bearer fixture-access-token");
      if (String(url).includes("/about?")) return Response.json({ user: { me: true, permissionId: "provider-user", ...(changes.user ?? {}) } });
      return Response.json({ id: "root-id", mimeType: "application/vnd.google-apps.folder", trashed: false, parents: ["root-parent"], isAppAuthorized: true,
        capabilities: { canAddChildren: true }, ...(changes.root ?? {}) });
    },
  });
  return { oauth, calls, pending: () => pending, complete: () => complete, vault: await createStorageCredentialVault(vaultConfig) };
}

test("metadata delay never extends credential expiry and a nearly expired token fails closed", async () => {
  let calls = 0; const started = 1700000000000;
  const f = await fixture({ clock: () => started + (calls++ ? 20000 : 0) });
  const state = new URL((await f.oauth.start(d.connection_id)).authorization_url).searchParams.get("state");
  await f.oauth.complete({ state, code: "fixture-code" });
  const plain = JSON.parse(await f.vault.open(f.complete().credential_envelope, { owner_id: d.owner_id, connection_id: d.connection_id,
    provider: "google-drive", provider_subject: "provider-user", oauth_client_id: d.oauth_client_id, credential_version: 1 }));
  assert.equal(plain.expires_at_ms, started + 3600000);
  let ticks = 0;
  const expired = await fixture({ clock: () => started + (ticks++ ? 3590000 : 0) });
  const expiredState = new URL((await expired.oauth.start(d.connection_id)).authorization_url).searchParams.get("state");
  await assert.rejects(expired.oauth.complete({ state: expiredState, code: "fixture-code" }), /storage_google_connection_unavailable/);
  assert.equal(expired.complete(), undefined);
});
test("new server Google consent uses exact scopes, PKCE and durable state before URL", async () => {
  const f = await fixture(), result = await f.oauth.start(d.connection_id), url = new URL(result.authorization_url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), scope);
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(f.pending().verifier_envelope.ciphertext); assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(result).includes("fixture-only-client-secret"), false);
  assert.equal(JSON.stringify(f.pending()).includes(url.searchParams.get("state")), false);
});
test("one code exchange verifies exact root and stores ciphertext only; replay recovers receipt", async () => {
  const f = await fixture(), url = new URL((await f.oauth.start(d.connection_id)).authorization_url);
  const input = { state: url.searchParams.get("state"), code: "fixture-auth-code" };
  const result = await f.oauth.complete(input);
  assert.equal(result.status, "completed"); assert.equal(f.calls.length, 3);
  assert.equal(new URLSearchParams(f.calls[0].init.body).get("grant_type"), "authorization_code");
  assert.equal(new URLSearchParams(f.calls[0].init.body).get("code_verifier").length, 43);
  assert.equal(JSON.stringify(f.complete()).includes("fixture-refresh-token"), false);
  assert.equal(JSON.stringify(result).includes("token"), false);
  assert.deepEqual(await f.oauth.complete(input), result); assert.equal(f.calls.length, 3);
});
test("scope expansion, missing refresh, wrong subject/parent and unpicked root do not activate", async () => {
  for (const changes of [{ tokens: { scope: scope+" https://www.googleapis.com/auth/drive" } }, { tokens: { refresh_token: null } },
    { tokens: { expires_in: "3600" } }, { user: { me: false } }, { user: { permissionId: null } },
    { descriptor: { provider_subject: "different-user" } }, { root: { parents: ["other-parent"] } },
    { root: { isAppAuthorized: false } }, { root: { capabilities: { canAddChildren: false } } }]) {
    const f = await fixture(changes), url = new URL((await f.oauth.start(d.connection_id)).authorization_url);
    const input = { state: url.searchParams.get("state"), code: "fixture-auth-code" };
    await assert.rejects(f.oauth.complete(input), /storage_google_connection_unavailable/);
    assert.equal(f.complete(), undefined);
    const count = f.calls.length; await assert.rejects(f.oauth.complete(input), /unavailable/); assert.equal(f.calls.length, count);
  }
});
test("wrong state or backend identity never calls Google", async () => {
  const f = await fixture(); await f.oauth.start(d.connection_id);
  await assert.rejects(f.oauth.complete({ state: "a".repeat(43), code: "fixture-auth-code" }), /unavailable/);
  assert.equal(f.calls.length, 0);
  const wrong = await fixture({ descriptor: { oauth_client_id: "other-client" } });
  await assert.rejects(wrong.oauth.start(d.connection_id), /unavailable/);
  assert.equal(wrong.pending(), undefined);
});

test("fixed stage reasons distinguish safe failures without exposing provider data or retrying codes", async () => {
  for (const [changes, reason] of [
    [{ denied: true }, "attempt_unavailable"],
    [{ networkFailure: true }, "token_transport_unconfirmed"],
    [{ tokens: { expires_in: "3600" } }, "token_response_invalid"],
    [{ tokens: { refresh_token: null } }, "refresh_token_missing"],
    [{ tokens: { scope: scope + " fixture-private-scope" } }, "scope_mismatch"],
    [{ user: { me: false } }, "provider_identity_unconfirmed"],
    [{ root: { trashed: true } }, "root_identity_mismatch"],
    [{ root: { isAppAuthorized: false } }, "root_not_authorized"],
    [{ root: { capabilities: { canAddChildren: false } } }, "root_not_writable"],
    [{ root: { parents: ["private-parent"] } }, "root_parent_mismatch"],
  ]) {
    const f = await fixture(changes);
    const state = new URL((await f.oauth.start(d.connection_id)).authorization_url).searchParams.get("state");
    const input = { state, code: "fixture-private-authorization-code" };
    await assert.rejects(f.oauth.complete(input), error => {
      assert.equal(error.reason, reason);
      assert.equal(error.message, "storage_google_connection_unavailable");
      for (const secret of [state, input.code, "fixture-access-token", "fixture-refresh-token", "private-parent", "fixture-secret-in-upstream-error"])
        assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
    assert.equal(f.complete(), undefined);
    const count = f.calls.length;
    await assert.rejects(f.oauth.complete(input), /unavailable/);
    assert.equal(f.calls.length, count);
  }
});

test("token errors expose only fixed classes, retain single exchange and never commit", async () => {
  for (const [response, reason] of [
    ...["invalid_client", "invalid_grant", "unauthorized_client", "invalid_request", "unsupported_grant_type"].map(error =>
      [() => Response.json({ error, error_description: "fixture-private-upstream-body" }, { status: 400 }), "token_" + error]),
    [() => Response.json({ error: "fixture-private-upstream-body" }, { status: 503 }), "token_http_rejected"],
    [() => Response.json({ error: "__proto__" }, { status: 400 }), "token_http_rejected"],
    [() => new Response("fixture-private-upstream-body", { status: 502 }), "token_response_unreadable"],
    [() => new Response("x".repeat(65537), { status: 400 }), "token_response_unreadable"],
    [() => Response.json(null), "token_response_unreadable"],
  ]) {
    const f = await fixture({ tokenResponse: response });
    const url = new URL((await f.oauth.start(d.connection_id)).authorization_url);
    const input = { state: url.searchParams.get("state"), code: "fixture-private-auth-code" };
    await assert.rejects(f.oauth.complete(input), error => {
      assert.equal(error.reason, reason);
      for (const secret of [input.state, input.code, "fixture-private-upstream-body", "fixture-only-client-secret"])
        assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    });
    assert.equal(f.calls.length, 1); assert.equal(f.complete(), undefined);
    await assert.rejects(f.oauth.complete(input), /unavailable/);
    assert.equal(f.calls.length, 1);
  }
});
