import test from "node:test";
import assert from "node:assert/strict";
import { requireAtomicPublication } from "./verify-memory-publication.mjs";

const base = { snapshot_version: "snap_a" };
const next = {
  bundle_path: "published/snap_b/memory",
  previous_snapshot_version: "snap_a",
  snapshot_version: "snap_b",
};

test("ordinary source-only change is not a memory publication", () => {
  assert.equal(requireAtomicPublication(["README.md"], base, next), "NOT_APPLICABLE");
});

test("direct memory edit without the atomic pointer and manifest is rejected", () => {
  assert.throws(
    () => requireAtomicPublication(["memory/global/state.md"], base, next),
    /DIRECT_MEMORY_EDIT_WITHOUT_POINTER_AND_MANIFEST/,
  );
});

test("complete snapshot publication change set is accepted for byte verification", () => {
  assert.equal(
    requireAtomicPublication([
      "memory/manifest.json",
      "artifacts/clued-two-level-snapshots/current.json",
      "artifacts/clued-two-level-snapshots/published/snap_b/memory/manifest.json",
    ], base, next),
    "artifacts/clued-two-level-snapshots/published/snap_b/memory",
  );
});
