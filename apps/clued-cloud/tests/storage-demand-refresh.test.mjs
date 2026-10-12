import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const directory = await mkdtemp(path.join(os.tmpdir(), "clued-demand-refresh-"));
async function load(name) {
  const outfile = path.join(directory, name + ".mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../worker/" + name + ".ts", import.meta.url))], outfile,
    bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(outfile));
}
const { createStorageDemandRefresh } = await load("storage-demand-refresh");
const { createStorageCredentialVault } = await load("storage-credential-vault");
const scope = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const initial = 1_700_000_000_000;
async function fixture(options = {}) {
  let now = initial, version = 1, enabled = options.enabled ?? true, generation = 1;
  let state = options.state ?? "idle", expires = initial + (options.validity ?? 3_600_000);
  let prepares = 0, renewals = 0;
  const observations = [], calls = [];
  const context = { owner_id: randomUUID(), connection_id: randomUUID(), provider: "google-drive",
    provider_subject: "synthetic-demand-user", oauth_client_id: "synthetic.apps.googleusercontent.com" };
  const keys = { current_key_id: "k1", keys: { k1: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(keys);
  const request = { connection_id: context.connection_id, operation: "read", token_hash: "c".repeat(64) };
  const config = { client_id: context.oauth_client_id, vault: keys, clock: () => now, max_wait_ms: options.maxWait ?? 300,
    pause: async delay => { now += delay; },
    prepare: async value => {
      calls.push(value); prepares++;
      if (options.prepareError || (options.revokeAfterRefresh && version > 1)) throw new Error("native refusal");
      const snapshot = { version, enabled, generation, state, expires };
      const envelope = await vault.seal(JSON.stringify({ access_token: "synthetic-private-access-token", refresh_token: "synthetic-private-refresh-token",
        token_type: "Bearer", scope: options.tokenScope ?? scope, expires_at_ms: snapshot.expires }), { ...context, credential_version: snapshot.version });
      return { contract: "clued.storage-demand-preflight/1", ...context, credential_version: snapshot.version,
        credential_envelope: envelope, delegation_version: snapshot.generation, renewal_enabled: snapshot.enabled, provider_scope_profile: "legacy",
        refresh_state: snapshot.state, proof: "clued_srp_" + snapshot.version.toString(16).padStart(64, "0"), ...(options.descriptor ?? {}) };
    },
    observe: async value => { observations.push(value); return { status: options.observeStatus ?? (value.credential_version === version ? "current" : "stale") }; },
    renew: async value => {
      if (Number.parseInt(value.proof.slice("clued_srp_".length), 16) !== version) return { status: "not_acquired" };
      renewals++; calls.push(value);
      if (options.renew) return options.renew({ value, fresh: () => { version++; expires = now + 3_600_000; },
        disable: () => { enabled = false; generation++; }, generation: () => { generation++; } });
      version++; expires = now + 3_600_000;
      return { status: "committed" };
    } };
  return { manager: await createStorageDemandRefresh(config), config, request, context, observations,
    counts: () => ({ prepares, renewals }), advance: ms => { now += ms; },
    fresh: () => { version++; expires = now + 3_600_000; state = "idle"; } };
}

test("a sufficiently valid sealed token is reused without renewal and without returning secrets", async () => {
  const f = await fixture();
  const result = await f.manager.ensure(f.request);
  assert.deepEqual(result, { status: "ready", credential_version: 1 });
  assert.equal(f.counts().renewals, 0);
  assert.equal(f.observations.length, 1);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(Object.hasOwn(result, "proof"), false);
});

test("an expired eligible credential renews then reloads Native authorization and the new version", async () => {
  const f = await fixture({ validity: -1 });
  assert.deepEqual(await f.manager.ensure(f.request), { status: "ready", credential_version: 2 });
  assert.equal(f.counts().renewals, 1);
  assert.equal(f.counts().prepares, 2);
  assert.deepEqual(f.observations.map(x => x.credential_version), [1, 2]);
});

test("Native denial, wrong connection, mismatched client or scope cause zero provider exchanges", async () => {
  for (const options of [{ prepareError: true }, { descriptor: { connection_id: randomUUID() } },
    { descriptor: { oauth_client_id: "foreign.apps.googleusercontent.com" } },
    { tokenScope: "https://www.googleapis.com/auth/drive" }, { descriptor: { proof: randomUUID() } }]) {
    const f = await fixture({ validity: -1, ...options });
    assert.deepEqual(await f.manager.ensure(f.request), { status: "unavailable" });
    assert.equal(f.counts().renewals, 0);
  }
});

test("renewal disabled still permits a valid token, but never refreshes an expired one", async () => {
  const valid = await fixture({ enabled: false });
  assert.equal((await valid.manager.ensure(valid.request)).status, "ready");
  const expired = await fixture({ enabled: false, validity: -1 });
  assert.deepEqual(await expired.manager.ensure(expired.request), { status: "renewal_disabled" });
  assert.equal(expired.counts().renewals, 0);
});

test("permission loss after renewal cannot reuse the former authorization", async () => {
  const f = await fixture({ validity: -1, revokeAfterRefresh: true });
  assert.deepEqual(await f.manager.ensure(f.request), { status: "unavailable" });
  assert.equal(f.counts().renewals, 1);
});

test("manual disable or disable/re-enable during exchange invalidates the old demand", async () => {
  for (const change of ["disable", "generation"]) {
    const f = await fixture({ validity: -1, renew: async control => {
      control.fresh(); control[change](); return { status: "committed" };
    } });
    assert.deepEqual(await f.manager.ensure(f.request), { status: "renewal_disabled" });
    assert.equal(f.counts().renewals, 1);
  }
});

test("ambiguous exchange returns pending and never makes a second exchange", async () => {
  for (const status of ["uncertain", "pending"]) {
    const f = await fixture({ validity: -1, renew: async () => ({ status }) });
    assert.deepEqual(await f.manager.ensure(f.request), { status: "pending" });
    assert.equal(f.counts().renewals, 1);
  }
  const prior = await fixture({ validity: -1, state: "uncertain" });
  assert.equal((await prior.manager.ensure(prior.request)).status, "pending");
  assert.equal(prior.counts().renewals, 0);
});

test("waiting for another durable claim is bounded and does not repeatedly write observations", async () => {
  const f = await fixture({ validity: -1, state: "pending" });
  assert.deepEqual(await f.manager.ensure(f.request), { status: "pending" });
  assert.equal(f.counts().renewals, 0);
  assert.equal(f.observations.length, 1);
  assert.ok(f.counts().prepares < 5);
});

test("parallel authorized requests share an exchange and each reloads current Native state", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ validity: -1, maxWait: 1000, renew: async control => {
    await gate; control.fresh(); return { status: "committed" };
  } });
  const first = f.manager.ensure(f.request);
  const second = f.manager.ensure({ ...f.request, token_hash: "d".repeat(64) });
  for (let n = 0; n < 100 && f.counts().renewals < 1; n++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.counts().renewals, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ status: "ready", credential_version: 2 }, { status: "ready", credential_version: 2 }]);
  assert.equal(f.counts().renewals, 1);
  assert.ok(f.counts().prepares >= 4);
});

test("clock reversal and stale observation fail without a provider call", async () => {
  const stale = await fixture({ validity: -1, observeStatus: "stale" });
  assert.equal((await stale.manager.ensure(stale.request)).status, "unavailable");
  assert.equal(stale.counts().renewals, 0);
  const reversed = await fixture();
  const observe = reversed.config.observe;
  reversed.config.observe = async value => { reversed.advance(-1); return observe(value); };
  assert.equal((await reversed.manager.ensure(reversed.request)).status, "unavailable");
  assert.equal(reversed.counts().renewals, 0);
});

test("a stalled Native preflight ends its bounded wait without a provider exchange", async () => {
  const f = await fixture({ maxWait: 100 });
  f.config.prepare = async () => new Promise(() => {});
  assert.deepEqual(await f.manager.ensure(f.request), { status: "pending" });
  assert.equal(f.counts().renewals, 0);
});
