import assert from "node:assert/strict";
import test from "node:test";
import { evaluateResourceCenterMutation } from "../../../kernel/policy/resource-center-mutation-policy.mjs";

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
