import assert from "node:assert/strict";
import test from "node:test";
import { detectResourceCenterBoundaryViolations, evaluateResourceCenterMutation, prepareResourceCenterMutationAdmission, verifyResourceCenterMutationAdmission } from "../../../kernel/policy/resource-center-mutation-policy.mjs";

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

test("explicit delete authority admits an otherwise valid governance delete", () => {
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


test("host admission refuses an unregistered caller-supplied profile", () => {
  const result = prepareResourceCenterMutationAdmission({
    registered_profile: profile,
    mutation: {
      operation: "write",
      artifact_role: "clued_resource",
      destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/a.md",
    },
  });
  assert.equal(result.error_code, "REGISTERED_PROFILE_REQUIRED");
});

test("host admission binds exact operation and path under a registered profile", () => {
  const registered = {
    ...profile,
    profile_id: "resource-center-primary",
    registration_status: "registered",
  };
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/brand/a.md",
  };
  const admission = prepareResourceCenterMutationAdmission({
    registered_profile: registered,
    mutation,
  });
  assert.equal(admission.status, "admitted");
  assert.equal(admission.profile_id, "resource-center-primary");
  assert.equal(admission.binding.operation, "write");
  assert.match(admission.security_boundary, /not_a_bearer_capability/);
  assert.equal(verifyResourceCenterMutationAdmission({
    admission,
    registered_profile: registered,
    mutation,
  }).status, "allow");
});

test("host admission fails if an Agent changes the destination after preflight", () => {
  const registered = {
    ...profile,
    profile_id: "resource-center-primary",
    registration_status: "registered",
  };
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/brand/a.md",
  };
  const admission = prepareResourceCenterMutationAdmission({
    registered_profile: registered,
    mutation,
  });
  const result = verifyResourceCenterMutationAdmission({
    admission,
    registered_profile: registered,
    mutation: {
      ...mutation,
      destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/other/a.md",
    },
  });
  assert.equal(result.error_code, "ADMISSION_BINDING_MISMATCH");
});

test("host admission fails if a proof is replayed under another registered profile", () => {
  const registered = {
    ...profile,
    profile_id: "resource-center-primary",
    registration_status: "registered",
  };
  const mutation = {
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/brand/a.md",
  };
  const admission = prepareResourceCenterMutationAdmission({
    registered_profile: registered,
    mutation,
  });
  const result = verifyResourceCenterMutationAdmission({
    admission,
    registered_profile: { ...registered, profile_id: "resource-center-secondary" },
    mutation,
  });
  assert.equal(result.error_code, "ADMISSION_BINDING_MISMATCH");
});
