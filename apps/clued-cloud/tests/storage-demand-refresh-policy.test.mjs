import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const directory = await mkdtemp(path.join(os.tmpdir(), "clued-demand-policy-"));
const outfile = path.join(directory, "policy.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-demand-refresh-policy.ts", import.meta.url))],
  outfile, bundle: true, platform: "node", format: "esm" });
const { storageRenewalWake } = await import(pathToFileURL(outfile));
const now = 1_700_000_000_000, DAY = 86_400_000;
const baseline = { enabled: true, connection_active: true, pending_exchange: false, needs_provider_work: false,
  credential_expires_at_ms: now + 3_600_000, last_successful_exchange_at_ms: now };

test("a idle connection permits access-token expiry without hourly refresh and wakes at thirty days", () => {
  assert.deepEqual(storageRenewalWake(baseline, now), { kind: "keepalive", at_ms: now + 30 * DAY });
  assert.deepEqual(storageRenewalWake(baseline, now + 2 * DAY), { kind: "keepalive", at_ms: now + 30 * DAY });
  assert.deepEqual(storageRenewalWake(baseline, now + 31 * DAY), { kind: "keepalive", at_ms: now + 31 * DAY });
});

test("actual active work wakes before expiry, and expired active work is immediately due", () => {
  assert.deepEqual(storageRenewalWake({ ...baseline, needs_provider_work: true }, now), { kind: "active", at_ms: now + 3_300_000 });
  assert.deepEqual(storageRenewalWake({ ...baseline, needs_provider_work: true }, now + 4_000_000), { kind: "active", at_ms: now + 4_000_000 });
});

test("manual stop, disconnect and unresolved exchange never create another scheduled exchange", () => {
  for (const field of ["enabled", "connection_active"])
    assert.deepEqual(storageRenewalWake({ ...baseline, [field]: false }, now), { kind: "disabled", at_ms: null });
  assert.deepEqual(storageRenewalWake({ ...baseline, pending_exchange: true }, now), { kind: "pending", at_ms: null });
});

test("unknown metadata must be observed, and retry backoff cannot be treated as token expiry", () => {
  assert.deepEqual(storageRenewalWake({ ...baseline, credential_expires_at_ms: null, backoff_until_ms: now + DAY }, now), { kind: "observe", at_ms: now });
  assert.deepEqual(storageRenewalWake({ ...baseline, last_successful_exchange_at_ms: null }, now), { kind: "observe", at_ms: now });
  assert.deepEqual(storageRenewalWake({ ...baseline, needs_provider_work: true, backoff_until_ms: now + DAY }, now), { kind: "active", at_ms: now + DAY });
});

test("invalid clocks, expiry and future exchange metadata are rejected", () => {
  assert.throws(() => storageRenewalWake(baseline, NaN));
  assert.throws(() => storageRenewalWake({ ...baseline, credential_expires_at_ms: Infinity }, now));
  assert.throws(() => storageRenewalWake({ ...baseline, last_successful_exchange_at_ms: now + 1 }, now));
});
