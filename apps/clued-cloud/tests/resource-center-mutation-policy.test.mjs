import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createResourceCenterFilesystemAdapter } from "../../../kernel/host/resource-center-filesystem-adapter.mjs";
import { createResourceCenterHostAdapter } from "../../../kernel/host/resource-center-mutation-host.mjs";
import { detectResourceCenterBoundaryViolations, evaluateResourceCenterMutation } from "../../../kernel/policy/resource-center-mutation-policy.mjs";

const profile = {
  managed_root: "G:/我的云端硬盘/Clued_资料中心",
  allowed_root_children: [
    "00_从这里开始",
    "10_E_工程与平台",
    "20_P_产品与体验",
    "30_R_基础研究",
    "40_B_商业与增长",
    "90_待归类",
  ],
};

const registeredProfile = {
  ...profile,
  profile_id: "resource-center-primary",
  profile_version: "resource-center-profile/1",
  registration_status: "registered",
};

const artifactAuthority = (overrides = {}) => Object.freeze({
  artifact_id: "artifact:test",
  artifact_role: "clued_resource",
  governance_class: "ordinary",
  delete_authority: false,
  authority_version: "artifact-registry/1",
  currentness_identity: "canonical:cv_155",
  workspace_version: "snapshot:snap_f6134235591bfcbfe4ba3a674383c3e0",
  ...overrides,
});

const createHost = (options = {}) => createResourceCenterHostAdapter({
  trusted_profile: registeredProfile,
  resolve_artifact: () => artifactAuthority(),
  effect: async () => ({ ok: true }),
  ...options,
});

const check = (input) => evaluateResourceCenterMutation({ profile, ...input });

test("2026-09-25 regression: status-semantic folder is rejected", () => {
  const result = check({
    operation: "create",
    artifact_role: "clued_resource",
    target_kind: "directory",
    directory_semantics: "topic",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/00_现行基线",
  });
  assert.equal(result.status, "deny");
  assert.equal(result.error_code, "STATUS_SEMANTIC_DIRECTORY_FORBIDDEN");
});

test("Resource Center material cannot be dropped into a sibling island", () => {
  const result = check({
    operation: "move",
    artifact_role: "clued_resource",
    source_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/a.md",
    destination_path: "G:/我的云端硬盘/Clued品牌资料/a.md",
  });
  assert.equal(result.error_code, "SIBLING_ISLAND_FORBIDDEN");
});

test("Resource Center material cannot be dropped at the storage root", () => {
  const result = check({
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/我的云端硬盘/Clued_品牌说明.md",
  });
  assert.equal(result.error_code, "SIBLING_ISLAND_FORBIDDEN");
});

test("an unregistered Resource Center root child is rejected", () => {
  const result = check({
    operation: "create",
    artifact_role: "clued_resource",
    target_kind: "directory",
    directory_semantics: "topic",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/00_现行基线",
  });
  assert.equal(result.error_code, "RESOURCE_CENTER_ROOT_CHILD_FORBIDDEN");
});

test("duplicate bytes do not authorize deleting governance evidence", () => {
  const result = check({
    operation: "delete",
    artifact_role: "clued_resource",
    governance_class: "governance",
    duplicate_bytes: true,
    source_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/review.md",
  });
  assert.equal(result.error_code, "DELETE_AUTHORITY_REQUIRED");
  assert.equal(result.duplicate_bytes, true);
});

test("trusted delete authority admits an otherwise valid governance delete", () => {
  const result = check({
    operation: "delete",
    artifact_role: "clued_resource",
    governance_class: "governance",
    delete_authority: true,
    source_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/review.md",
  });
  assert.equal(result.status, "allow");
});

test("normal track to topic organization is admitted", () => {
  const result = check({
    operation: "move",
    artifact_role: "clued_resource",
    source_path: "G:/我的云端硬盘/Clued_资料中心/90_待归类/a.md",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/a.md",
  });
  assert.equal(result.status, "allow");
});

test("delete rejects a destination instead of letting it mask the source", () => {
  const result = check({
    operation: "delete",
    artifact_role: "clued_resource",
    governance_class: "ordinary",
    delete_authority: false,
    source_path: "G:/我的云端硬盘/Clued_孤岛/证据.md",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/证据.md",
  });
  assert.equal(result.error_code, "DELETE_DESTINATION_FORBIDDEN");
});

test("move cannot mutate a source outside the managed or registered roots", () => {
  const result = check({
    operation: "move",
    artifact_role: "clued_resource",
    source_path: "D:/Unregistered/CluedLoose/a.md",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/a.md",
  });
  assert.equal(result.error_code, "SOURCE_OUTSIDE_REGISTERED_ROOT");
});

test("path traversal cannot escape the managed root", () => {
  const result = check({
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/../../Clued旁路/a.md",
  });
  assert.equal(result.error_code, "SIBLING_ISLAND_FORBIDDEN");
});

test("Windows path matching is case-insensitive", () => {
  const result = check({
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "g:/我的云端硬盘/CLUED_资料中心/20_P_产品与体验/品牌与视觉/a.md",
  });
  assert.equal(result.status, "allow");
});

test("artifact role omission fails closed", () => {
  const result = check({
    operation: "move",
    source_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/a.md",
    destination_path: "G:/我的云端硬盘/Clued品牌资料/a.md",
  });
  assert.equal(result.error_code, "ARTIFACT_ROLE_REQUIRED");
});

test("delete classification omission fails closed", () => {
  const result = check({
    operation: "delete",
    artifact_role: "clued_resource",
    source_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/a.md",
  });
  assert.equal(result.error_code, "GOVERNANCE_CLASS_REQUIRED");
});

test("directory creation without declared track/topic/asset semantics fails closed", () => {
  const result = check({
    operation: "create",
    artifact_role: "clued_resource",
    target_kind: "directory",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/新目录",
  });
  assert.equal(result.error_code, "DIRECTORY_SEMANTICS_REQUIRED");
});

test("status-split aliases from the 2026-09-25 incident are rejected", () => {
  for (const name of ["10_候选与素材", "20_评审"]) {
    const result = check({
      operation: "create",
      artifact_role: "clued_resource",
      target_kind: "directory",
      directory_semantics: "topic",
      destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/" + name,
    });
    assert.equal(result.error_code, "STATUS_SEMANTIC_DIRECTORY_FORBIDDEN");
  }
});

test("a declared topic directory remains allowed", () => {
  const result = check({
    operation: "create",
    artifact_role: "clued_resource",
    target_kind: "directory",
    directory_semantics: "topic",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉",
  });
  assert.equal(result.status, "allow");
});

test("remediation may move material out of an already-illegal status folder", () => {
  const result = check({
    operation: "move",
    artifact_role: "clued_resource",
    source_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/00_现行基线/a.md",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/a.md",
  });
  assert.equal(result.status, "allow");
});


test("boundary watcher is quiet for the managed root and unrelated system files", () => {
  const violations = detectResourceCenterBoundaryViolations({
    profile,
    observed_entries: [
      { path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3", artifact_role: "clued_resource" },
      { path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/desktop.ini" },
    ],
  });
  assert.deepEqual(violations, []);
});

test("island rule counts only app-authorized Clued-named entries; a missing field still counts", () => {
  const outside = "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u5355\u4e00\u6570\u636e\u6e90\u65b9\u6848";
  const paths = (entries) => detectResourceCenterBoundaryViolations({ profile, observed_entries: entries }).map((v) => v.path);
  assert.deepEqual(paths([{ path: outside, is_app_authorized: false }]), []);
  assert.deepEqual(paths([{ path: outside, is_app_authorized: true }]), [outside]);
  assert.deepEqual(paths([{ path: outside }]), [outside]);
  assert.deepEqual(paths([{ path: outside, is_app_authorized: "false" }]), [outside]);
  assert.deepEqual(paths([outside]), [outside]);
  // An explicit Clued resource role is not the island rule and is never exempt.
  const role = "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/notes.md";
  assert.deepEqual(paths([{ path: role, artifact_role: "clued_resource", is_app_authorized: false }]), [role]);
});

test("boundary watcher reports sibling and parent-root Clued islands", () => {
  const violations = detectResourceCenterBoundaryViolations({
    profile,
    observed_entries: [
      { path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued\u54c1\u724c\u8d44\u6599" },
      { path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3.md" },
    ],
  });
  assert.equal(violations.length, 2);
  for (const violation of violations) {
    assert.equal(violation.code, "UNAUTHORIZED_WORKSPACE_MUTATION");
    assert.equal(violation.reason, "resource_center_parent_or_sibling_island");
  }
});

test("boundary watcher reports explicit Clued resource outside the parent even without a Clued filename", () => {
  const violations = detectResourceCenterBoundaryViolations({
    profile,
    observed_entries: [
      { path: "D:/Shared/brand/a.md", artifact_role: "clued_resource" },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, "unregistered_clued_resource_location");
});

test("boundary watcher reports Clued-named islands under other scanned roots", () => {
  const violations = detectResourceCenterBoundaryViolations({
    profile,
    observed_entries: [
      { path: "D:/Shared/CluedBrandArchive/release/a.zip" },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "UNAUTHORIZED_WORKSPACE_MUTATION");
  assert.equal(violations[0].reason, "unregistered_clued_resource_location");
});

test("boundary watcher ignores a registered external authority root", () => {
  const violations = detectResourceCenterBoundaryViolations({
    profile: {
      ...profile,
      registered_external_roots: ["D:/RegisteredCluedArtifacts"],
    },
    observed_entries: [
      { path: "D:/RegisteredCluedArtifacts/release/a.zip", artifact_role: "clued_resource" },
    ],
  });
  assert.deepEqual(violations, []);
});


test("Host adapter rejects unregistered or unversioned bootstrap profiles", () => {
  assert.throws(() => createResourceCenterHostAdapter({
    trusted_profile: profile,
    resolve_artifact: () => artifactAuthority(),
    effect: async () => {},
  }), /registered, versioned Host-owned/);
});

test("Host preflight binds exact operation, paths, artifact role, profile and policy versions", () => {
  const adapter = createHost({
    effect: async () => ({ ok: true }),
  });
  const result = adapter.preflight({
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/brand/a.md",
  });
  assert.equal(result.status, "admitted");
  assert.equal(result.admission.admission_kind, "host_instance_opaque_single_use");
  assert.equal(result.admission.binding.operation, "write");
  assert.equal(result.admission.binding.artifact_role, "clued_resource");
  assert.equal(result.admission.binding.profile_id, "resource-center-primary");
  assert.equal(result.admission.binding.profile_version, "resource-center-profile/1");
  assert.equal(result.admission.binding.policy_version, "clued.resource-center-mutation-policy/1");
  assert.equal(result.admission.binding.currentness_identity, "canonical:cv_155");
  assert.equal(result.admission.binding.workspace_version, "snapshot:snap_f6134235591bfcbfe4ba3a674383c3e0");
  assert.match(result.admission.binding.request_sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(result.admission), true);
});

test("mutation payload cannot self-declare profile or managed-root authority", () => {
  const adapter = createHost({
    effect: async () => ({ ok: true }),
  });
  for (const authority of [
    { profile: { registration_status: "registered" } },
    { managed_root: "D:/attacker-root" },
    { registered_external_roots: ["D:/attacker-root"] },
    { governance_class: "ordinary" },
    { delete_authority: true },
    { artifact_authority_version: "attacker/1" },
    { artifact_id: "attacker-artifact" },
    { currentness_identity: "canonical:attacker" },
    { workspace_version: "snapshot:attacker" },
  ]) {
    const result = adapter.preflight({
      operation: "write",
      artifact_role: "clued_resource",
      destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md",
      ...authority,
    });
    assert.equal(result.error_code, "CALLER_AUTHORITY_FIELDS_FORBIDDEN");
  }
});

test("Host artifact resolver, not the caller, decides governance delete authority", async () => {
  let calls = 0;
  const mutation = {
    operation: "delete",
    artifact_role: "clued_resource",
    duplicate_bytes: true,
    source_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/review.md",
  };
  const denied = createHost({
    resolve_artifact: () => artifactAuthority({ governance_class: "governance" }),
    effect: async () => { calls += 1; },
  });
  assert.equal((await denied.guardedMutation(mutation)).error_code, "DELETE_AUTHORITY_REQUIRED");
  assert.equal(calls, 0);

  const admitted = createHost({
    resolve_artifact: () => artifactAuthority({ governance_class: "governance", delete_authority: true }),
    effect: async ({ mutation: authorized }) => {
      calls += 1;
      assert.equal(authorized.governance_class, "governance");
      assert.equal(authorized.delete_authority, true);
      assert.equal(authorized.artifact_authority_version, "artifact-registry/1");
    },
  });
  assert.equal((await admitted.guardedMutation(mutation)).status, "committed");
  assert.equal(calls, 1);
});

test("Host fails closed when trusted currentness or workspace identity is unavailable", () => {
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md",
  };
  const withoutCurrentness = createHost({
    resolve_artifact: () => {
      const authority = { ...artifactAuthority() };
      delete authority.currentness_identity;
      return authority;
    },
  });
  const withoutWorkspace = createHost({
    resolve_artifact: () => {
      const authority = { ...artifactAuthority() };
      delete authority.workspace_version;
      return authority;
    },
  });
  assert.equal(withoutCurrentness.preflight(mutation).error_code, "ARTIFACT_AUTHORITY_INVALID");
  assert.equal(withoutWorkspace.preflight(mutation).error_code, "ARTIFACT_AUTHORITY_INVALID");
});

test("Host rejects delete destination masking before the effect", async () => {
  let calls = 0;
  const adapter = createHost({ effect: async () => { calls += 1; } });
  const result = await adapter.guardedMutation({
    operation: "delete",
    artifact_role: "clued_resource",
    source_path: "G:/我的云端硬盘/Clued_孤岛/证据.md",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/证据.md",
  });
  assert.equal(result.error_code, "DELETE_DESTINATION_FORBIDDEN");
  assert.equal(calls, 0);
});

test("Host adapter captures the trusted profile instead of retaining mutable caller config", () => {
  const bootstrapProfile = {
    ...registeredProfile,
    allowed_root_children: [...registeredProfile.allowed_root_children],
    registered_external_roots: [],
  };
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: bootstrapProfile,
    resolve_artifact: () => artifactAuthority(),
    effect: async () => ({ ok: true }),
  });
  bootstrapProfile.managed_root = "D:/attacker-root";
  bootstrapProfile.allowed_root_children.push("escape");
  bootstrapProfile.registered_external_roots.push("D:/Elsewhere");

  assert.equal(adapter.preflight({
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "D:/attacker-root/escape/a.md",
  }).error_code, "SIBLING_ISLAND_FORBIDDEN");
  assert.equal(adapter.preflight({
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md",
  }).status, "admitted");
});

test("Host preflight rejects accessor-bearing mutation payloads without invoking getters", () => {
  let getterCalls = 0;
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
  };
  Object.defineProperty(mutation, "destination_path", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md";
    },
  });
  const adapter = createHost({
    effect: async () => ({ ok: true }),
  });
  const result = adapter.preflight(mutation);
  assert.equal(result.error_code, "MUTATION_PAYLOAD_INVALID");
  assert.equal(getterCalls, 0);
});

test("Host mutation API refuses a direct mutation without admission", async () => {
  let calls = 0;
  const adapter = createHost({
    effect: async () => { calls += 1; },
  });
  const result = await adapter.commitMutation({
    mutation: {
      operation: "write",
      artifact_role: "clued_resource",
      destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md",
    },
  });
  assert.equal(result.error_code, "ADMISSION_REQUIRED");
  assert.equal(calls, 0);
});

test("lookalike or cross-adapter admission objects cannot be consumed", async () => {
  let calls = 0;
  const first = createHost({
    effect: async () => { calls += 1; },
  });
  const second = createHost({
    effect: async () => { calls += 1; },
  });
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md",
  };
  const issued = first.preflight(mutation);
  assert.equal((await first.commitMutation({ admission: { ...issued.admission }, mutation })).error_code, "ADMISSION_INVALID");
  assert.equal((await second.commitMutation({ admission: issued.admission, mutation })).error_code, "ADMISSION_INVALID");
  assert.equal(calls, 0);
});

test("admission is exact-bound and consumed by a mismatched execution attempt", async () => {
  let calls = 0;
  const adapter = createHost({
    effect: async () => { calls += 1; },
  });
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/brand/a.md",
  };
  const issued = adapter.preflight(mutation);
  const mismatch = await adapter.commitMutation({
    admission: issued.admission,
    mutation: { ...mutation, destination_path: mutation.destination_path.replace("brand", "other") },
  });
  assert.equal(mismatch.error_code, "ADMISSION_BINDING_MISMATCH");
  assert.equal((await adapter.commitMutation({ admission: issued.admission, mutation })).error_code, "ADMISSION_ALREADY_CONSUMED");
  assert.equal(calls, 0);
});

test("artifact authority drift invalidates and consumes an admission", async () => {
  let authorityVersion = "artifact-registry/1";
  let calls = 0;
  const adapter = createHost({
    resolve_artifact: () => artifactAuthority({ authority_version: authorityVersion }),
    effect: async () => { calls += 1; },
  });
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/brand/a.md",
  };
  const issued = adapter.preflight(mutation);
  authorityVersion = "artifact-registry/2";
  assert.equal((await adapter.commitMutation({ admission: issued.admission, mutation })).error_code, "ADMISSION_BINDING_MISMATCH");
  assert.equal((await adapter.commitMutation({ admission: issued.admission, mutation })).error_code, "ADMISSION_ALREADY_CONSUMED");
  assert.equal(calls, 0);
});

test("trusted currentness drift invalidates and consumes an admission", async () => {
  let currentnessIdentity = "canonical:cv_155";
  let calls = 0;
  const adapter = createHost({
    resolve_artifact: () => artifactAuthority({ currentness_identity: currentnessIdentity }),
    effect: async () => { calls += 1; },
  });
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/brand/a.md",
  };
  const issued = adapter.preflight(mutation);
  currentnessIdentity = "canonical:cv_156";
  assert.equal((await adapter.commitMutation({ admission: issued.admission, mutation })).error_code, "ADMISSION_BINDING_MISMATCH");
  assert.equal((await adapter.commitMutation({ admission: issued.admission, mutation })).error_code, "ADMISSION_ALREADY_CONSUMED");
  assert.equal(calls, 0);
});

test("admission expires and remains single-use", async () => {
  let now = 1_000;
  let calls = 0;
  const adapter = createHost({
    effect: async () => { calls += 1; },
    clock: () => now,
    admission_ttl_ms: 50,
  });
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md",
  };
  const issued = adapter.preflight(mutation);
  now = issued.admission.expires_at_ms;
  assert.equal((await adapter.commitMutation({ admission: issued.admission, mutation })).error_code, "ADMISSION_EXPIRED");
  assert.equal((await adapter.commitMutation({ admission: issued.admission, mutation })).error_code, "ADMISSION_ALREADY_CONSUMED");
  assert.equal(calls, 0);
});

test("guarded Host wrapper never calls the side effect when preflight denies", async () => {
  let calls = 0;
  const adapter = createHost({
    effect: async () => { calls += 1; },
  });
  const result = await adapter.guardedMutation({
    operation: "create",
    artifact_role: "clued_resource",
    target_kind: "directory",
    directory_semantics: "topic",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/\u54c1\u724c\u4e0e\u89c6\u89c9/00_\u73b0\u884c\u57fa\u7ebf",
  });
  assert.equal(result.error_code, "STATUS_SEMANTIC_DIRECTORY_FORBIDDEN");
  assert.equal(calls, 0);
});

test("guarded Host wrapper consumes one exact admission and freezes effect input", async () => {
  const seen = [];
  const adapter = createHost({
    effect: async ({ mutation, admission, profile_identity: identity }) => {
      seen.push({ mutation, admission, identity });
      return { receipt: "host-effect-1" };
    },
  });
  const mutation = {
    operation: "move",
    artifact_role: "clued_resource",
    source_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/90_\u5f85\u5f52\u7c7b/a.md",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/brand/a.md",
  };
  const result = await adapter.guardedMutation(mutation);
  assert.equal(result.status, "committed");
  assert.equal(seen.length, 1);
  assert.deepEqual({
    operation: seen[0].mutation.operation,
    artifact_role: seen[0].mutation.artifact_role,
    source_path: seen[0].mutation.source_path,
    destination_path: seen[0].mutation.destination_path,
  }, mutation);
  assert.equal(seen[0].mutation.governance_class, "ordinary");
  assert.equal(seen[0].mutation.delete_authority, false);
  assert.equal(seen[0].mutation.artifact_authority_version, "artifact-registry/1");
  assert.equal(seen[0].mutation.artifact_id, "artifact:test");
  assert.equal(seen[0].mutation.currentness_identity, "canonical:cv_155");
  assert.equal(seen[0].mutation.workspace_version, "snapshot:snap_f6134235591bfcbfe4ba3a674383c3e0");
  assert.equal(Object.isFrozen(seen[0].mutation), true);
  assert.equal(seen[0].identity.profile_id, "resource-center-primary");
  assert.equal(result.effect_result.receipt, "host-effect-1");
  assert.equal((await adapter.commitMutation({ admission: seen[0].admission, mutation })).error_code, "ADMISSION_ALREADY_CONSUMED");
});

test("Host boundary scan uses captured trusted profile and no model callback", () => {
  let modelCalls = 0;
  const adapter = createHost({
    trusted_profile: {
      ...registeredProfile,
      registered_external_roots: ["D:/RegisteredCluedArtifacts"],
    },
    effect: async () => ({ ok: true }),
    model: () => { modelCalls += 1; },
  });
  const violations = adapter.scanBoundary({
    observed_entries: [
      { path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/CluedBrandIsland" },
      { path: "D:/Elsewhere/CluedLoose/a.md" },
      { path: "D:/RegisteredCluedArtifacts/a.md", artifact_role: "clued_resource" },
    ],
    registered_external_roots: ["D:/Elsewhere"],
  });
  assert.deepEqual(violations.map((item) => item.code), [
    "UNAUTHORIZED_WORKSPACE_MUTATION",
    "UNAUTHORIZED_WORKSPACE_MUTATION",
  ]);
  assert.equal(modelCalls, 0);
});

test("official filesystem adapter consumes admission and scans trusted roots", async (t) => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "clued-resource-center-"));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const managedRoot = path.join(sandbox, "Clued_资料中心");
  const track = path.join(managedRoot, "20_P_产品与体验");
  await fs.mkdir(track, { recursive: true });
  const adapter = createResourceCenterFilesystemAdapter({
    trusted_profile: {
      registration_status: "registered",
      profile_id: "filesystem-test",
      profile_version: "resource-center-profile/2",
      managed_root: managedRoot,
      allowed_root_children: ["20_P_产品与体验"],
      boundary_scan_roots: [sandbox],
    },
    resolve_artifact: () => artifactAuthority({ authority_version: "filesystem-registry/1" }),
  });

  const destination = path.join(track, "artifact.md");
  const result = await adapter.guardedMutation({
    operation: "create",
    artifact_role: "clued_resource",
    destination_path: destination,
    content: "governed",
  });
  assert.equal(result.status, "committed");
  assert.equal(await fs.readFile(destination, "utf8"), "governed");
  assert.equal(result.effect_result.object_identity.link_count, 1);
  await assert.rejects(adapter.guardedMutation({ operation: "create", artifact_role: "clued_resource",
    destination_path: destination, content: "must not overwrite" }), { code: "EEXIST" });
  assert.equal(await fs.readFile(destination, "utf8"), "governed");

  const replaced = await adapter.guardedMutation({
    operation: "replace",
    artifact_role: "clued_resource",
    destination_path: destination,
    content: "governed replacement",
  });
  assert.equal(replaced.status, "committed");
  assert.equal(replaced.effect_result.object_identity.link_count, 1);
  assert.equal(await fs.readFile(destination, "utf8"), "governed replacement");

  await fs.mkdir(path.join(sandbox, "Clued_孤岛"));
  const violations = await adapter.scanBoundary();
  assert.equal(violations.some((item) =>
    item.code === "UNAUTHORIZED_WORKSPACE_MUTATION" && item.path.includes("Clued_孤岛")), true);
});

test("new file with unknown provider link count never receives content or a success result", async (t) => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "clued-create-link-count-"));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const track = path.join(sandbox, "20_P_产品与体验");
  await fs.mkdir(track);
  let writes = 0;
  let closed = 0;
  const adapter = createResourceCenterFilesystemAdapter({
    trusted_profile: { registration_status: "registered", profile_id: "unqualified-volume-test",
      profile_version: "test/1", managed_root: sandbox, allowed_root_children: ["20_P_产品与体验"] },
    resolve_artifact: () => artifactAuthority(),
    filesystem: { ...fs, open: async (file, mode) => {
      assert.equal(mode, "wx");
      const handle = await fs.open(file, mode);
      return { stat: async () => Object.assign(await handle.stat({ bigint: true }), { nlink: 0n }),
        writeFile: async () => { writes++; }, sync: () => handle.sync(),
        close: async () => { closed++; await handle.close(); } };
    } },
  });
  const destination = path.join(track, "empty.txt");
  await assert.rejects(adapter.guardedMutation({ operation: "create", artifact_role: "clued_resource",
    destination_path: destination, content: "must not be written" }), /FILESYSTEM_OBJECT_IDENTITY_UNAVAILABLE/);
  assert.equal(writes, 0);
  assert.equal(closed, 1);
  assert.equal((await fs.stat(destination)).size, 0);
  // Exclusive open can already have created an empty object. The online Host
  // must fence this as uncertain, not claim zero effects or silently delete it.
});

test("official filesystem adapter rejects a realpath escape before the effect", async (t) => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "clued-resource-center-realpath-"));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const managedRoot = path.join(sandbox, "Clued_资料中心");
  const destination = path.join(managedRoot, "20_P_产品与体验", "linked", "artifact.md");
  const outside = path.join(sandbox, "outside", "artifact.md");
  let writeCalls = 0;
  const fakeFilesystem = {
    readdir: async () => [],
    lstat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    writeFile: async () => { writeCalls += 1; },
    link: async () => { throw new Error("link must not be reached"); },
    rename: async () => {},
    unlink: async () => {},
    rmdir: async () => {},
    mkdir: async () => {},
    open: async () => { throw new Error("open must not be reached"); },
    stat: async () => { throw new Error("stat must not be reached"); },
    realpath: async (candidate) => candidate === destination ? outside : candidate,
  };
  const adapter = createResourceCenterFilesystemAdapter({
    trusted_profile: {
      registration_status: "registered",
      profile_id: "filesystem-realpath-test",
      profile_version: "resource-center-profile/2",
      managed_root: managedRoot,
      allowed_root_children: ["20_P_产品与体验"],
    },
    resolve_artifact: () => artifactAuthority({ authority_version: "filesystem-registry/1" }),
    filesystem: fakeFilesystem,
  });

  await assert.rejects(adapter.guardedMutation({
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: destination,
    content: "must not escape",
  }), { code: "DESTINATION_REALPATH_OUTSIDE_MANAGED_ROOT" });
  assert.equal(writeCalls, 0);
});

test("official filesystem adapter rejects a hard-link alias without changing the outside object", async (t) => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "clued-resource-center-hardlink-"));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const managedRoot = path.join(sandbox, "Clued_资料中心");
  const track = path.join(managedRoot, "20_P_产品与体验");
  const outside = path.join(sandbox, "outside.md");
  const alias = path.join(track, "alias.md");
  await fs.mkdir(track, { recursive: true });
  await fs.writeFile(outside, "outside-original");
  await fs.link(outside, alias);
  const adapter = createResourceCenterFilesystemAdapter({
    trusted_profile: {
      registration_status: "registered",
      profile_id: "filesystem-hardlink-test",
      profile_version: "resource-center-profile/2",
      managed_root: managedRoot,
      allowed_root_children: ["20_P_产品与体验"],
    },
    resolve_artifact: () => artifactAuthority({ authority_version: "filesystem-registry/1" }),
  });

  await assert.rejects(adapter.guardedMutation({
    operation: "replace",
    artifact_role: "clued_resource",
    destination_path: alias,
    content: "must not cross the boundary",
  }), { code: "HARD_LINK_ALIAS_FORBIDDEN" });
  assert.equal(await fs.readFile(outside, "utf8"), "outside-original");
  assert.equal((await fs.stat(outside)).nlink, 2);
});

test("official filesystem adapter fails closed when a provider cannot prove object identity", async () => {
  const managedRoot = path.resolve("virtual-provider", "Clued_资料中心");
  const destination = path.join(managedRoot, "20_P_产品与体验", "artifact.md");
  let writeCalls = 0;
  const unsupportedStats = () => ({ isFile: () => true, nlink: 1, size: 0 });
  const fakeFilesystem = {
    readdir: async () => [],
    lstat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    writeFile: async () => {},
    link: async () => { throw new Error("link must not be reached"); },
    rename: async () => {},
    unlink: async () => {},
    rmdir: async () => {},
    mkdir: async () => {},
    realpath: async (candidate) => candidate,
    stat: async () => unsupportedStats(),
    open: async () => ({
      stat: async () => unsupportedStats(),
      writeFile: async () => { writeCalls += 1; },
      truncate: async () => {},
      sync: async () => {},
      close: async () => {},
    }),
  };
  const adapter = createResourceCenterFilesystemAdapter({
    trusted_profile: {
      registration_status: "registered",
      profile_id: "filesystem-identity-test",
      profile_version: "resource-center-profile/2",
      managed_root: managedRoot,
      allowed_root_children: ["20_P_产品与体验"],
    },
    resolve_artifact: () => artifactAuthority({ authority_version: "filesystem-registry/1" }),
    filesystem: fakeFilesystem,
  });

  await assert.rejects(adapter.guardedMutation({
    operation: "replace",
    artifact_role: "clued_resource",
    destination_path: destination,
    content: "must fail closed",
  }), { code: "FILESYSTEM_OBJECT_IDENTITY_UNAVAILABLE" });
  assert.equal(writeCalls, 0);
});

// Owner Decision f382c494 (Task 2e8ed1da item 3): the layout rules stay, but
// an ordinary write into a status-named folder that already exists is not
// refused; only a new status-named directory is.
test("a file written into an existing status-named folder is allowed; a new status-named directory is not", () => {
  const base = "G:/我的云端硬盘/Clued_资料中心/20_P_产品与体验/品牌与视觉/";
  for (const operation of ["create", "write"]) {
    const result = check({ operation, artifact_role: "clued_resource", target_kind: "file", destination_path: base + "历史/note.md" });
    assert.equal(result.status, "allow", operation);
  }
  // A topic created inside an existing status folder writes into it, and is allowed.
  assert.equal(check({ operation: "create", artifact_role: "clued_resource", target_kind: "directory", directory_semantics: "topic",
    destination_path: base + "历史/新主题" }).status, "allow");
  // Creating, renaming or moving a directory to a status name is still refused.
  for (const operation of ["create", "rename"]) {
    const result = check({ operation, artifact_role: "clued_resource", target_kind: "directory", directory_semantics: "topic",
      ...(operation === "rename" ? { source_path: base + "主题" } : {}), destination_path: base + "当前版本" });
    assert.equal(result.error_code, "STATUS_SEMANTIC_DIRECTORY_FORBIDDEN", operation);
  }
});
