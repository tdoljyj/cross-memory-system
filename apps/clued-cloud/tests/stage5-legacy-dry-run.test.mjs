import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildInventory } from "../scripts/stage5-legacy-dry-run.mjs";

async function fixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "clued-stage5-"));
  const files = {
    "memory/状态.md": "# 状态\n## Clued\n- 当前 Worker 正常\n- 已撤回的当前状态\n- 当前状态与历史结论冲突\n",
    "memory/待办.md": "# 待办\n- [ ] 等待授权，当前阻塞\n- [x] 已完成测试证据\n",
    "memory/决策.md": "# 决策\n- 因为单一数据源，确认不复制正文\n",
    "memory/归档.md": "# 归档\n- 故障已归因并关闭\n",
    "memory/contexts/projects/clued/日志.md": "# 日志\n- 当前 Worker 正常\n- 临时日志证据\n",
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return root;
}

test("stage 5 inventory is deterministic, read-only and preserves source semantics", async () => {
  const repoRoot = await fixtureRepo();
  const options = {
    repoRoot,
    databaseSnapshot: { mode: "select_only", legacy_memory_crud: { memories: 0, audit: 0 } },
    asOf: "2026-08-24T05:35:54.968159Z",
  };
  const first = await buildInventory(options);
  const second = await buildInventory(options);

  assert.deepEqual(first, second);
  assert.equal(first.mode, "dry_run_read_only");
  assert.deepEqual(first.boundaries, {
    database_writes: 0,
    production_migrations: 0,
    feature_flag_changes: 0,
    deployments: 0,
    legacy_log_authority: "legacy_evidence_only",
  });
  assert.equal(first.summary.source_files, 5);
  assert.ok(first.summary.preserved_indicators.reason > 0);
  assert.ok(first.summary.preserved_indicators.failure > 0);
  assert.ok(first.summary.preserved_indicators.blocker > 0);
  assert.ok(first.summary.preserved_indicators.retracted > 0);
  assert.ok(first.summary.preserved_indicators.evidence > 0);
});

test("duplicate candidates become references and project log never becomes current authority", async () => {
  const inventory = await buildInventory({
    repoRoot: await fixtureRepo(),
    asOf: "2026-08-24T05:35:54.968159Z",
  });
  const duplicate = inventory.candidates.find((candidate) => candidate.duplicate_of);
  assert.ok(duplicate);
  assert.equal(duplicate.preview, null);
  assert.match(duplicate.duplicate_of, /^legacy-[a-f0-9]{24}$/);

  const logCandidates = inventory.candidates.filter((candidate) =>
    candidate.source_ref.startsWith("memory/contexts/projects/clued/日志.md"),
  );
  assert.ok(logCandidates.length > 0);
  assert.ok(logCandidates.every((candidate) => candidate.record_type === "event"));
  assert.ok(logCandidates.every((candidate) => candidate.validity === "evidence_only"));
  assert.ok(logCandidates.every((candidate) => candidate.authority === "legacy_evidence_only"));
  assert.ok(
    logCandidates.every((candidate) =>
      ["retain_legacy_only", "reference_only"].includes(candidate.migration_disposition),
    ),
  );
  assert.ok(logCandidates.every((candidate) => !candidate.manual_review));
});

test("stable IDs are unique by source location and high-risk candidates are explicit", async () => {
  const inventory = await buildInventory({
    repoRoot: await fixtureRepo(),
    asOf: "2026-08-24T05:35:54.968159Z",
  });
  const ids = inventory.candidates.map((candidate) => candidate.stable_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(
    inventory.candidates.some((candidate) =>
      candidate.review_reasons.includes("contradictory_current_state"),
    ),
  );
  assert.ok(
    inventory.candidates.some(
      (candidate) => candidate.migration_disposition === "retain_legacy_only",
    ),
  );
});
