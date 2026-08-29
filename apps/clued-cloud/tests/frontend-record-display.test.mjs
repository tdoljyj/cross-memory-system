import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  formatRecordTime,
  presentCluedLogCard,
  presentCluedRecordDisplay,
} from "../app/record-presentation.ts";

const updatedAt = "2026-08-28T08:03:23.000Z";

function logRecord(overrides = {}) {
  return {
    id: "578",
    record_type: "log",
    updated_at: updatedAt,
    ...overrides,
  };
}

test("keeps non-log structured summaries and complete details compatible", () => {
  const body = JSON.stringify({
    authority: "user_explicit",
    user_message: "授权 G6-P",
    remote_main: "59ce5224b1b8ad502184a26e8c00f9e51521e41e",
  });
  const item = presentCluedRecordDisplay({
    id: "record-decision",
    record_type: "decision",
    body,
    updated_at: updatedAt,
  }, "Decision");

  assert.equal(item.summary, "授权 G6-P");
  assert.equal(item.conclusion, body);
  assert.equal(item.rawDetails, JSON.stringify(JSON.parse(body), null, 2));
});

test("keeps non-log plain text readable without a details disclosure", () => {
  const body = "Complete the current frontend display fix.";
  const item = presentCluedRecordDisplay({
    id: "record-state",
    record_type: "state",
    body,
    updated_at: updatedAt,
  }, "State");

  assert.equal(item.summary, body);
  assert.equal(item.rawDetails, null);
});

test("keeps ordinary plain-text logs unchanged", () => {
  const content = "User-entered production log text.\nSecond line stays intact.";
  const item = presentCluedRecordDisplay(logRecord({ content }), "Log");

  assert.equal(item.title, "Log");
  assert.equal(item.summary, content);
  assert.equal(item.conclusion, content);
  assert.equal(item.rawDetails, content);
});

test("maps common action values to readable localized titles", () => {
  const content = JSON.stringify({
    action: "merge_and_close_integrated_branches",
    result: "合并动作完成。",
  });
  const item = presentCluedRecordDisplay(logRecord({ content }), "日志", "zh-CN");

  assert.equal(item.title, "合并并关闭集成分支");
  assert.equal(item.summary, "合并动作完成。");
});

test("keeps title, decision, action, and canonical event priority stable", () => {
  const structured = {
    decision: "保留固定源提交",
    action: "record_closed",
    canonical_event_type: "fallback_event",
  };

  assert.equal(
    presentCluedRecordDisplay(logRecord({ title: "显式标题", content: JSON.stringify(structured) }), "日志", "zh-CN").title,
    "显式标题",
  );
  assert.equal(
    presentCluedRecordDisplay(logRecord({ content: JSON.stringify(structured) }), "日志", "zh-CN").title,
    "保留固定源提交",
  );
  assert.equal(
    presentCluedRecordDisplay(logRecord({ content: JSON.stringify({ action: structured.action, canonical_event_type: structured.canonical_event_type }) }), "日志", "zh-CN").title,
    "记录已关闭",
  );
  assert.equal(
    presentCluedRecordDisplay(logRecord({ content: JSON.stringify({ canonical_event_type: structured.canonical_event_type }) }), "日志", "zh-CN").title,
    "Fallback event",
  );
});

test("combines unique summary fields into one concise readable sentence", () => {
  const content = JSON.stringify({
    action: "record_closed",
    summary: "处理完成",
    message: "处理完成",
    result: "验证通过",
    verification: { status: "生产流量未变化" },
    error: "第四行不应进入摘要",
  });
  const item = presentCluedRecordDisplay(logRecord({ content }), "日志", "zh-CN");

  assert.equal(item.summary, "处理完成；验证通过；生产流量未变化。");
});

test("preserves every structured field in pretty-printed raw details", () => {
  const payload = {
    action: "record_closed",
    result: "PASS",
    nested: { preserved: true, count: 7 },
  };
  const item = presentCluedRecordDisplay(logRecord({ payload }), "Log");

  assert.equal(item.rawDetails, JSON.stringify(payload, null, 2));
  assert.match(item.rawDetails, /"preserved": true/);
});

test("handles an 8 KB record with SHA, URL, and Windows path without putting JSON in the card summary", () => {
  const payload = {
    action: "merge_and_close_integrated_branches",
    result: "Done",
    sha: "ef4cb5383236b8a643f760ce1f20255f07aba630",
    url: "https://clued.pixelgrav.com/current/work/log/578?source=canonical",
    path: "C:\\Users\\Windows\\Documents\\Codex\\very\\long\\path\\record.json",
    evidence: "x".repeat(8192),
  };
  const item = presentCluedRecordDisplay(logRecord({ content: JSON.stringify(payload) }), "Log");

  assert.equal(item.summary, "Done");
  assert.ok(item.rawDetails.length > 8192);
  assert.match(item.rawDetails, /ef4cb5383236b8a643f760ce1f20255f07aba630/);
  assert.match(item.rawDetails, /C:\\\\Users\\\\Windows/);
});

test("falls back to plain text when JSON parsing fails", () => {
  const malformed = '{"action":"record_closed",';
  const item = presentCluedRecordDisplay(logRecord({ content: malformed }), "Log");

  assert.equal(item.summary, malformed);
  assert.equal(item.rawDetails, malformed);
});

test("uses a neutral fallback for unrecognized objects and keeps details on demand", () => {
  const payload = { opaque: { still: "preserved" } };
  const item = presentCluedRecordDisplay(logRecord({ payload }), "日志", "zh-CN");

  assert.equal(item.title, "系统事件");
  assert.equal(item.summary, "暂无可读摘要，请展开查看原始记录。");
  assert.equal(item.rawDetails, JSON.stringify(payload, null, 2));
});

test("treats script markup as inert text data", () => {
  const content = '<script>globalThis.compromised = true</script>';
  const item = presentCluedRecordDisplay(logRecord({ content }), "Log");

  assert.equal(item.summary, content);
  assert.equal(item.rawDetails, content);
});

test("projects production-shaped deployment, validation, and Git logs into readable cards", () => {
  const deployment = presentCluedLogCard(logRecord({
    id: "580",
    content: JSON.stringify({
      action: "production_deployment_completed",
      verification: ["npm test PASS 97/97", "build PASS", "healthz 200"],
    }),
  }), "日志", "zh-CN");
  assert.equal(deployment.title, "日志可读化版本已部署");
  assert.equal(deployment.summary, "测试 97/97 通过；构建通过；健康检查返回 200。");
  assert.equal(deployment.tone, "success");
  assert.deepEqual(deployment.tags, ["部署", "成功", "ID 580"]);

  const validation = presentCluedLogCard(logRecord({
    id: "579",
    canonical_event_type: "candidate_validation",
    payload: {
      test_results: [
        "npm test: PASS 97/97",
        "frontend record display tests: PASS 13/13",
        "typecheck: PASS",
      ],
    },
  }), "日志", "zh-CN");
  assert.equal(validation.title, "候选版本验证");
  assert.equal(validation.summary, "测试 97/97 通过；前端记录显示测试 13/13 通过；类型检查通过。");
  assert.equal(validation.tone, "success");
  assert.deepEqual(validation.tags, ["验证", "成功", "ID 579"]);

  const git = presentCluedLogCard(logRecord({
    id: "578",
    payload: {
      action: "merge_and_close_integrated_branches",
      verification: ["7/7 PASS", "bidirectional PASS", "clean"],
    },
  }), "日志", "zh-CN");
  assert.equal(git.summary, "7/7 项验证通过；双向检查通过；工作树干净。");
  assert.deepEqual(git.tags, ["Git", "成功", "ID 578"]);
});

test("formats recent times compactly without changing the source timestamp", () => {
  const now = new Date("2026-08-28T20:00:00");
  assert.match(formatRecordTime("2026-08-28T18:34:08", "zh-CN", now), /^今天 18:34$/);
  assert.match(formatRecordTime("2026-08-27T16:08:11", "zh-CN", now), /^昨天 16:08$/);
  assert.equal(formatRecordTime("not-a-time", "zh-CN", now), "not-a-time");
});

test("ships safe layered disclosure, grouped log cards, and no v n/a fallback", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /<details className="record-details">/);
  assert.match(page, /<pre>\{display\.rawDetails\}<\/pre>/);
  assert.match(page, /<details className="record-raw-details">/);
  assert.match(page, /viewEvidence: "View evidence and raw record"/);
  assert.match(page, /viewFullJson: "查看完整 JSON"/);
  assert.match(page, /className="log-card-tags"/);
  assert.match(page, /formatRecordTime\(item\.updatedAt, locale\)/);
  assert.match(page, /viewRawRecord: "View raw record"/);
  assert.match(page, /viewRawRecord: "查看原始记录"/);
  assert.match(page, /versionNotRecorded: "Version not recorded"/);
  assert.match(page, /item\.version === null \? t\.versionNotRecorded/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /v\{[^\n]*n\/a/);
});

test("contains cards and wraps long identifiers while scrolling only raw details", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.records-panel\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.auth-card-account\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.record-item strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.record-item p\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.record-details\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.record-details pre\s*\{[^}]*max-height:\s*280px[^}]*overflow:\s*auto[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.log-card-tags\s*\{[^}]*justify-content:\s*flex-start/s);
  assert.match(css, /\.log-card-head\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,1fr\) auto/s);
});
