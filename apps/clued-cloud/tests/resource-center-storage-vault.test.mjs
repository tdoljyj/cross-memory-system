import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const directory = await mkdtemp(path.join(os.tmpdir(), "clued-vault-test-"));
const output = path.join(directory, "vault.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-credential-vault.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm" });
const { createStorageCredentialVault } = await import(pathToFileURL(output));
const key = () => randomBytes(32).toString("base64url");
const k1 = key(), k2 = key();
const context = Object.freeze({ owner_id: "10000000-0000-4000-8000-000000000001", connection_id: "20000000-0000-4000-8000-000000000001",
  provider: "google-drive", provider_subject: "test-subject", oauth_client_id: "test-client.apps.googleusercontent.com", credential_version: 1 });
const vault = await createStorageCredentialVault({ current_key_id: "v1", keys: { v1: k1 } });
const secret = JSON.stringify({ refresh_token: "fixture-only-not-a-real-token" });

test("credential encryption roundtrip uses independent nonces and exposes no plaintext", async () => {
  const a = await vault.seal(secret, context), b = await vault.seal(secret, context);
  assert.notEqual(a.nonce, b.nonce); assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(await vault.open(a, context), secret);
  assert.equal(JSON.stringify(a).includes("refresh_token"), false);
  assert.deepEqual(Object.keys(a).sort(), ["ciphertext", "contract", "key_id", "nonce"]);
});
test("every owner/connection/provider/client/revision is authenticated", async () => {
  const envelope = await vault.seal(secret, context);
  const changes = { owner_id: "10000000-0000-4000-8000-000000000002", connection_id: "20000000-0000-4000-8000-000000000002",
    provider: "dropbox", provider_subject: "other-account", oauth_client_id: "other-client", credential_version: 2 };
  for (const [field, value] of Object.entries(changes)) await assert.rejects(vault.open(envelope, { ...context, [field]: value }), /storage_credential_unavailable/);
});
test("key rotation reads retained keys; removal and key-id substitution deny", async () => {
  const a = await vault.seal(secret, context);
  const successor = await createStorageCredentialVault({ current_key_id: "v2", keys: { v1: k1, v2: k2 } });
  assert.equal(await successor.open(a, context), secret);
  assert.equal((await successor.seal(secret, context)).key_id, "v2");
  await assert.rejects(successor.open({ ...a, key_id: "v2" }, context), /unavailable/);
  const retired = await createStorageCredentialVault({ current_key_id: "v2", keys: { v2: k2 } });
  await assert.rejects(retired.open(a, context), /unavailable/);
});
test("tampering, invalid encodings and unknown fields fail without leaking input", async () => {
  const a = await vault.seal(secret, context);
  for (const changed of [{ ...a, ciphertext: a.ciphertext.slice(0, -4) }, { ...a, nonce: a.nonce + "=" },
    { ...a, ciphertext: "!" }, { ...a, contract: "other" }, { ...a, plaintext: secret }, { ...a, key_id: "__proto__" }]) {
    await assert.rejects(vault.open(changed, context), error => error.message === "storage_credential_unavailable" && !error.cause);
  }
  await assert.rejects(vault.open(a, { ...context, injected: true }), /unavailable/);
  await assert.rejects(vault.seal("", context), /unavailable/);
  await assert.rejects(vault.seal("x".repeat(16385), context), /unavailable/);
  for (const configuration of [{ current_key_id: "v1", keys: {} }, { current_key_id: "v1", keys: { v1: "short" } },
    { current_key_id: "v1", keys: { v1: k1 }, key_url: "https://untrusted.invalid" }]) await assert.rejects(createStorageCredentialVault(configuration), /unavailable/);
});
