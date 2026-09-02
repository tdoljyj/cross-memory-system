import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  buildArtifactSet,
  verifyExternalArtifact,
} from "../../kernel/domain/artifact-set.mjs";
import {
  classifyImportStorageApplicability,
  validateArchiveEntries,
} from "../../kernel/policy/archive-import-applicability.mjs";

const digest = (char) => "sha256:" + char.repeat(64);
const archiveBudget = {
  max_entries: 10,
  max_entry_bytes: 1000,
  max_compressed_bytes: 1000,
  max_expanded_bytes: 2000,
  max_compression_ratio: 20,
  max_depth: 5,
  sandbox_profile: "archive-test-no-network",
};
const artifactBudget = {
  max_items: 10,
  max_edges: 20,
  max_total_bytes: 1000,
  max_metadata_bytes: 5000,
  max_reference_depth: 5,
};
const baseArtifactSet = () => ({
  artifact_set_id: "artifact-set-1",
  tenant_id: "tenant-a",
  subject_ref: "subject-a",
  context_key: "alpha",
  commitment_domain: "tenant-a:subject-a:alpha",
  current_erasure_generation: 3,
  parser_profile_digest: digest("f"),
  nodes: [
    {
      node_id: "root",
      content_digest: digest("a"),
      size: 10,
      required: true,
      present: true,
      verified: true,
      erasure_generation: 3,
      location_ref: "location:root",
      media_type: "application/json",
      data_classification: "internal",
    },
    {
      node_id: "child",
      content_digest: digest("b"),
      size: 20,
      required: true,
      present: true,
      verified: true,
      erasure_generation: 3,
      location_ref: "location:child",
      media_type: "application/octet-stream",
      data_classification: "private",
    },
  ],
  edges: [{ edge_id: "edge-1", from: "root", to: "child", dependency_type: "required" }],
});

test("V07-ARCHIVE-01 sealed archive accepts only regular/directory entries within all budgets", () => {
  const manifest = validateArchiveEntries([
    {
      path: "folder/data.json",
      type: "regular",
      compressed_size: 20,
      expanded_size: 100,
      content_digest: digest("a"),
    },
    {
      path: "folder/sub",
      type: "directory",
      compressed_size: 0,
      expanded_size: 0,
      content_digest: digest("b"),
    },
  ], archiveBudget);
  assert.equal(manifest.completeness, "complete");
  assert.equal(manifest.network_access, false);
  assert.equal(manifest.executable, false);
  assert.match(manifest.sealed_manifest_digest, /^sha256:[0-9a-f]{64}$/);
});

test("V07-ARCHIVE-02 traversal, collisions, links, devices, sparse and expansion bombs reject", () => {
  for (const entry of [
    { path: "../escape", type: "regular" },
    { path: "C:\\absolute", type: "regular" },
    { path: "link", type: "regular", symlink: true },
    { path: "hard", type: "regular", hardlink: true },
    { path: "device", type: "device", device: true },
    { path: "pipe", type: "fifo", fifo: true },
    { path: "sparse", type: "regular", sparse: true },
    { path: "file:ads", type: "regular", ads: true },
  ]) {
    assert.throws(() => validateArchiveEntries([{
      compressed_size: 1,
      expanded_size: 1,
      content_digest: digest("a"),
      ...entry,
    }], archiveBudget));
  }
  assert.throws(() => validateArchiveEntries([
    { path: "A.txt", type: "regular", compressed_size: 1, expanded_size: 1, content_digest: digest("a") },
    { path: "a.TXT", type: "regular", compressed_size: 1, expanded_size: 1, content_digest: digest("b") },
  ], archiveBudget), { code: "ARCHIVE_NORMALIZATION_COLLISION" });
  assert.throws(() => validateArchiveEntries([
    { path: "bomb.bin", type: "regular", compressed_size: 1, expanded_size: 500, content_digest: digest("a") },
  ], archiveBudget), { code: "ARCHIVE_EXPANSION_BUDGET_EXCEEDED" });
});

test("V07-ARTIFACT-01 ArtifactSet digest is deterministic and missing required nodes cannot be complete", () => {
  const first = buildArtifactSet(baseArtifactSet(), artifactBudget);
  const second = buildArtifactSet(baseArtifactSet(), artifactBudget);
  assert.equal(first.completeness, "complete");
  assert.equal(first.merkle_commitment, second.merkle_commitment);
  assert.equal(first.nodes_auto_executed, false);

  const missing = baseArtifactSet();
  missing.nodes[1].present = false;
  missing.nodes[1].verified = false;
  const partial = buildArtifactSet(missing, artifactBudget);
  assert.equal(partial.completeness, "partial");
  assert.equal(partial.missing_required_node_ids.join(","), "child");
});

test("V07-ARTIFACT-02 cycles, graph/byte budgets and stale erasure generations fail closed", () => {
  const cyclic = baseArtifactSet();
  cyclic.edges.push({ edge_id: "edge-2", from: "child", to: "root", dependency_type: "required" });
  assert.throws(() => buildArtifactSet(cyclic, artifactBudget), { code: "ARTIFACT_GRAPH_CYCLE" });

  const tooLarge = baseArtifactSet();
  tooLarge.nodes[1].size = 5000;
  assert.throws(() => buildArtifactSet(tooLarge, artifactBudget), {
    code: "ARTIFACT_BYTE_BUDGET_EXCEEDED",
  });

  const stale = baseArtifactSet();
  stale.nodes[1].erasure_generation = 2;
  assert.throws(() => buildArtifactSet(stale, artifactBudget), {
    code: "ERASURE_BARRIER_REJECTED",
  });
});

test("V07-ARTIFACT-03 external artifact uses actual streamed bytes, not claimed hash/size/type", () => {
  const bytes = Buffer.from("verified artifact", "utf8");
  const actual = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const verified = verifyExternalArtifact({
    bytes,
    expected_digest: actual,
    expected_size: bytes.length,
    truncated: false,
  }, { max_bytes: 100 });
  assert.equal(verified.actual_digest, actual);
  assert.equal(verified.external_claim_trusted_without_verification, false);
  assert.throws(() => verifyExternalArtifact({
    bytes,
    expected_digest: digest("f"),
    expected_size: bytes.length,
    truncated: false,
  }, { max_bytes: 100 }), { code: "EXTERNAL_ARTIFACT_DIGEST_MISMATCH" });
  assert.throws(() => verifyExternalArtifact({
    bytes,
    expected_digest: actual,
    expected_size: bytes.length,
    truncated: true,
  }, { max_bytes: 100 }), { code: "EXTERNAL_ARTIFACT_INCOMPLETE" });
});

test("V07-IMPORT-APPLICABILITY-01 import-storage is REQUIRED when present and N/A_WITH_PROOF only with final machine proof", () => {
  const required = classifyImportStorageApplicability({
    release_profile: { capabilities: ["import-storage"] },
    release_bom: { artifacts: [] },
    runtime_entrypoints: [],
  });
  assert.equal(required.disposition, "REQUIRED");

  const omitted = classifyImportStorageApplicability({
    release_profile: { capabilities: [] },
    release_bom: { artifacts: [] },
    runtime_entrypoints: [],
    release_profile_digest: digest("a"),
    release_bom_digest: digest("b"),
    runtime_scan: { entrypoints_found: 0, scanner_digest: digest("c") },
    negative_invocation: { result: "CAPABILITY_NOT_DECLARED" },
    claim_exclusions: { v15: true, v17: true },
  });
  assert.equal(omitted.disposition, "N/A_WITH_PROOF");
  assert.equal(omitted.na_proof_valid, true);

  assert.throws(() => classifyImportStorageApplicability({
    release_profile: { capabilities: [] },
    release_bom: { artifacts: [] },
    runtime_entrypoints: [],
  }), { code: "IMPORT_STORAGE_NA_PROOF_INCOMPLETE" });
});
