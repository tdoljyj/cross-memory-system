import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { loadDailyHostConfig, validateDailyCredentials } from "../scripts/resource-center-daily-runner.mjs";
const hash = b => createHash("sha256").update(b).digest("hex");
async function config(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clued-daily-config-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const c = { contract: "clued.resource-center-daily-host/1", enabled: true,
    profile: { registration_status: "registered", profile_id: randomUUID(), managed_root: dir, boundary_scan_roots: [dir] },
    root_folder_id: "root", root_parent_id: "parent", distribution: "Ubuntu-24.04" };
  c.activation_path = path.join(dir,"activation.json");c.activation_sha256=hash("activated");await fs.writeFile(c.activation_path,"activated");
  for (const name of ["state_directory", "recovery_path", "attempt_path", "client_secret_path", "google_tokens_path", "bindings_path", "consumer_path", "probe_path", "bwrap_path"])
    c[name] = name === "state_directory" ? dir : path.join(dir, name);
  for (const name of ["consumer", "probe", "bwrap"]) { await fs.writeFile(c[`${name}_path`], name);c[`${name}_sha256`] = hash(name); }
  c.recovery_path = path.join(dir, "recovery.jsonl");c.attempt_path = path.join(dir, "attempts.jsonl");c.journal_identity = {};
  for (const name of ["jobs.jsonl", "recovery.jsonl", "attempts.jsonl"]) {
    await fs.writeFile(path.join(dir, name), "");const st = await fs.lstat(path.join(dir, name));c.journal_identity[name] = { dev: st.dev, ino: st.ino };
  }
  const location = path.join(dir, "host.json");
  return { c, location, save: async () => { const bytes = JSON.stringify(c);await fs.writeFile(location, bytes);return hash(bytes); } };
}
test("fixed host config validates exact runtime pins before secret access", async t => {
  const f = await config(t);const pin = await f.save();
  assert.equal((await loadDailyHostConfig(f.location, pin)).profile.profile_id, f.c.profile.profile_id);
});
test("modified profile or runtime fails before a provider call", async t => {
  const f = await config(t);const pin = await f.save();
  await assert.rejects(loadDailyHostConfig(f.location, "0".repeat(64)), /DAILY_CONFIG_PIN_MISMATCH/);
  await fs.writeFile(f.c.consumer_path, "changed");
  await assert.rejects(loadDailyHostConfig(f.location, pin), /DAILY_RUNTIME_PIN_MISMATCH/);
});
test("missing scan root cannot be reported clean", async t => {
  const f = await config(t);f.c.profile.boundary_scan_roots = [path.join(f.c.state_directory, "missing")];
  await assert.rejects(loadDailyHostConfig(f.location, await f.save()), /ENOENT/);
});
test("disabled deployment and relative paths cannot enable a writer", async t => {
  const f = await config(t);f.c.enabled = false;
  await assert.rejects(loadDailyHostConfig(f.location, await f.save()), /DAILY_CONFIG_INVALID/);
  f.c.enabled = true;f.c.bindings_path = "caller.json";
  await assert.rejects(loadDailyHostConfig(f.location, await f.save()), /DAILY_CONFIG_PATH_INVALID/);
});
test("expired, near-expiry or cross-profile credentials require operator renewal", () => {
  const now = Date.now();const s = { profile_id: "profile", reader: "clued_rcb_" + "a".repeat(64), writer: "clued_rcw_" + "b".repeat(64), expires_at: new Date(now + 3600000).toISOString() };
  validateDailyCredentials(s, "profile", now);
  for (const value of [{ ...s, expires_at: new Date(now + 1000).toISOString() }, { ...s, expires_at: "invalid" }, { ...s, profile_id: "other" }, { ...s, writer: "" }])
    assert.throws(() => validateDailyCredentials(value, "profile", now), /DAILY_BINDING_RENEWAL_REQUIRED/);
});
test("replacement journal cannot silently reset history", async t => {
  const f = await config(t);const pin = await f.save();
  await fs.rename(f.c.recovery_path, f.c.recovery_path + ".old");await fs.writeFile(f.c.recovery_path, "");
  await assert.rejects(loadDailyHostConfig(f.location, pin), /DAILY_JOURNAL_IDENTITY_CHANGED/);
});
