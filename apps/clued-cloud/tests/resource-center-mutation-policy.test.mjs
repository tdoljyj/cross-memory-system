import assert from "node:assert/strict";
import test from "node:test";
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
    effect: async () => {},
  }), /registered, versioned Host-owned/);
});

test("Host preflight binds exact operation, paths, artifact role, profile and policy versions", () => {
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
    effect: async () => ({ ok: true }),
  });
  const result = adapter.preflight({
    operation: "write",
    artifact_role: "clued_resource",
    destination_path: "G:/\u6211\u7684\u4e91\u7aef\u786c\u76d8/Clued_\u8d44\u6599\u4e2d\u5fc3/20_P_\u4ea7\u54c1\u4e0e\u4f53\u9a8c/brand/a.md",
    currentness_identity: "canonical:cv_155",
  });
  assert.equal(result.status, "admitted");
  assert.equal(result.admission.admission_kind, "host_instance_opaque_single_use");
  assert.equal(result.admission.binding.operation, "write");
  assert.equal(result.admission.binding.artifact_role, "clued_resource");
  assert.equal(result.admission.binding.profile_id, "resource-center-primary");
  assert.equal(result.admission.binding.profile_version, "resource-center-profile/1");
  assert.equal(result.admission.binding.policy_version, "clued.resource-center-mutation-policy/1");
  assert.equal(result.admission.binding.currentness_identity, "canonical:cv_155");
  assert.match(result.admission.binding.request_sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(result.admission), true);
});

test("mutation payload cannot self-declare profile or managed-root authority", () => {
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
    effect: async () => ({ ok: true }),
  });
  for (const authority of [
    { profile: { registration_status: "registered" } },
    { managed_root: "D:/attacker-root" },
    { registered_external_roots: ["D:/attacker-root"] },
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

test("Host adapter captures the trusted profile instead of retaining mutable caller config", () => {
  const bootstrapProfile = {
    ...registeredProfile,
    allowed_root_children: [...registeredProfile.allowed_root_children],
    registered_external_roots: [],
  };
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: bootstrapProfile,
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
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
    effect: async () => ({ ok: true }),
  });
  const result = adapter.preflight(mutation);
  assert.equal(result.error_code, "MUTATION_PAYLOAD_INVALID");
  assert.equal(getterCalls, 0);
});

test("Host mutation API refuses a direct mutation without admission", async () => {
  let calls = 0;
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
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
  const first = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
    effect: async () => { calls += 1; },
  });
  const second = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
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
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
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

test("admission expires and remains single-use", async () => {
  let now = 1_000;
  let calls = 0;
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
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
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
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
  const adapter = createResourceCenterHostAdapter({
    trusted_profile: registeredProfile,
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
  assert.deepEqual(seen[0].mutation, mutation);
  assert.equal(Object.isFrozen(seen[0].mutation), true);
  assert.equal(seen[0].identity.profile_id, "resource-center-primary");
  assert.equal(result.effect_result.receipt, "host-effect-1");
  assert.equal((await adapter.commitMutation({ admission: seen[0].admission, mutation })).error_code, "ADMISSION_ALREADY_CONSUMED");
});

test("Host boundary scan uses captured trusted profile and no model callback", () => {
  let modelCalls = 0;
  const adapter = createResourceCenterHostAdapter({
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
