import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../supabase/manifests/20260923_owner_approved_legacy_continuity.json", import.meta.url);
const migrationUrl = new URL("../supabase/migrations/20260923193000_context_v2_approved_legacy_continuity_once.sql", import.meta.url);

function validateManifest(manifest) {
  assert.equal(manifest.schema, "clued.context-v2.legacy-continuity-resolution-manifest.v1");
  assert.equal(manifest.owner_user_id, "2ddd1804-b1e5-4916-89fb-3b87fae11ee6");
  assert.equal(manifest.target_state, "RESOLVED_CONTINUITY_ONLY");
  assert.equal(manifest.event_count, 367);
  assert.equal(manifest.events.length, 367);
  assert.equal(new Set(manifest.events.map((entry) => entry.event_id)).size, 367);
  assert.deepEqual(manifest.scope_counts, {
    global: 295,
    "project:0597aa60-9b98-4da6-a4ab-63d7705b632f": 65,
    "project:09c99505-7971-4bca-a885-632350b05139": 7,
  });
  assert.deepEqual(manifest.semantic_counts, { A: 158, B: 139, C: 66, D: 4 });
  assert.equal(manifest.release_set.length, 165);
  assert.equal(new Set(manifest.release_set.map((entry) => entry.id)).size, 165);
  assert.equal(manifest.proof_records.length, 49);
  assert.deepEqual(
    manifest.proof_records.map((entry) => entry.id),
    [...new Set(manifest.events.flatMap((entry) => entry.proof_record_ids))].sort(),
  );
  for (const entry of manifest.events) {
    assert.match(entry.event_hash, /^[0-9a-f]{64}$/);
    assert.match(entry.carrier_hash, /^[0-9a-f]{64}$/);
    assert.match(entry.append_receipt_hash, /^[0-9a-f]{64}$/);
    assert.match(entry.append_receipt_id, /^[0-9a-f-]{36}$/);
    assert.equal(entry.source_kind, "legacy");
    assert.equal(entry.visibility, "work_log");
    assert.equal(entry.target_carrier_state, "RESOLVED_CONTINUITY_ONLY");
    assert.ok(entry.proof_record_ids.length > 0);
  }
  assert.deepEqual(
    manifest.events.filter((entry) => entry.semantic_category === "D").map((entry) => entry.event_id),
    [622, 659, 1066, 1067],
  );
  assert.deepEqual(manifest.current_unique_now_task, {
    id: "9c3effaa-7162-47c3-85da-0039415eb262",
    version: 5,
    title: "K-CONT 收口后：实施 MTPE Universal Intake & Auto-Priority M0",
  });
}

test("finite continuity manifest binds every source and release Record", async () => {
  const bytes = await readFile(manifestUrl);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "82330fbdd83e25f3f64336de6cec4b215ec3e207b8ca1708f586d66f1ec82838");
  validateManifest(JSON.parse(bytes));
});

test("manifest validator rejects drift and duplicate source identity", async () => {
  const original = JSON.parse(await readFile(manifestUrl, "utf8"));
  const hashDrift = structuredClone(original);
  hashDrift.events[0].event_hash = "changed";
  assert.throws(() => validateManifest(hashDrift));
  const duplicate = structuredClone(original);
  duplicate.events[1].event_id = duplicate.events[0].event_id;
  assert.throws(() => validateManifest(duplicate));
});

test("migration is private, lock bound, approval bound and fail closed", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const required of [
    "security invoker set search_path=''",
    "currentness_user_lock",
    "lock table public.clued_context_events in share mode",
    "lock table public.clued_memories in share mode",
    "lock table clued_private.event_truth_carriers in share row exclusive mode",
    "legacy_continuity_active_set_changed",
    "legacy_continuity_release_set_changed",
    "legacy_continuity_proof_records_changed",
    "legacy_continuity_source_changed",
    "legacy_continuity_source_receipt_changed",
    "legacy_continuity_approval_invalid",
    "continuity_only_resolution_authorized",
    "'continuity_only_proof','verified'",
    "RESOLVED_CONTINUITY_ONLY",
    "approved_legacy_continuity_reconcile",
    "legacy_continuity_postcondition_failed",
    "6a08c40279cd68c399b30380c33f86a8799c90686b26d0423ded7032c4ad94f1",
    "94765a27b467485c72280978761db7d7fa314860ae0452250affb14cdf97d028",
    "revoke all on function clued_private.reconcile_approved_legacy_continuity_once_v1",
    "from public,anon,authenticated,service_role",
  ]) assert.ok(sql.includes(required), `missing migration guard: ${required}`);
  assert.ok(sql.includes("82330fbdd83e25f3f64336de6cec4b215ec3e207b8ca1708f586d66f1ec82838"));
});
