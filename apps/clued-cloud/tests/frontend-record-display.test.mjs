import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { presentCluedLogCard, presentCluedRecordDisplay } from "../app/record-presentation.ts";

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
  const item = presentCluedRecordDisplay(logRecord({ content }), "日志", "zh-CN");

  assert.equal(item.summary, content);
  assert.equal(item.conclusion, content);
  assert.equal(item.rawDetails, content);
});

test("1. ID 580 shape: deployment completion reads as a version deployment with test, build and healthz evidence", () => {
  const content = JSON.stringify({
    canonical_event_type: "production_deployment_completed",
    action: "production_deployment_completed",
    result: ["测试 97/97 通过", "构建通过", "healthz 200"],
    verification: { status: "COMPLETED", healthz: "200" },
    version_id: "b4d1e2f9c3a4b5d6e7f8091a2b3c4d5",
  });
  const card = presentCluedLogCard(logRecord({ id: "580", content }), "日志", "zh-CN");

  assert.equal(card.title, "日志可读化版本已部署");
  assert.match(card.summary, /97\/97/);
  assert.match(card.summary, /构建/);
  assert.match(card.summary, /healthz 200/);
  assert.equal(card.tone, "success");
  assert.ok(card.tags.includes("ID 580"));
  assert.ok(card.tags.includes("完成"));
  assert.ok(card.evidence.some((line) => line.value.includes("b4d1e2f9c3a4b5d6e7f8091a2b3c4d5")));
});

test("2. ID 579 shape: never falls back to a structural placeholder for both title and summary", () => {
  const payload = { opaque: { still: "preserved" } };
  const card = presentCluedLogCard(logRecord({ id: "579", payload }), "日志", "zh-CN");

  assert.notEqual(card.title, "结构化日志记录");
  assert.notEqual(card.summary, "结构化日志记录");
  assert.notEqual(card.title, card.summary);
  assert.equal(card.title, "系统事件");
  assert.equal(card.summary, "暂无可读摘要，请展开查看原始记录");
  assert.equal(card.rawDetails, JSON.stringify(payload, null, 2));
});

test("3. ID 578 shape: branch merge reads with its result and production impact", () => {
  const content = JSON.stringify({
    canonical_event_type: "merge_and_close_integration_branch",
    result: "集成分支已合并并关闭",
    verification: { status: "COMPLETED", production: "生产流量未变化" },
  });
  const card = presentCluedLogCard(logRecord({ id: "578", content }), "日志", "zh-CN");

  assert.equal(card.title, "合并并关闭集成分支");
  assert.match(card.summary, /合并并关闭/);
  assert.match(card.summary, /生产流量未变化/);
  assert.equal(card.tone, "success");
});

test("4. ID 577 shape: blocked records name the blocked target and never invent one", () => {
  const blocked = presentCluedLogCard(logRecord({
    id: "577",
    status: "BLOCKED",
    content: JSON.stringify({
      canonical_event_type: "production_deployment_blocked",
      decision: "Cloudflare 部署未执行",
      reason: "缺少生产部署授权",
    }),
  }), "日志", "zh-CN");

  assert.equal(blocked.title, "Cloudflare 部署未执行");
  assert.equal(blocked.tone, "blocked");
  assert.ok(blocked.tags.includes("已阻断"));
  assert.ok(blocked.evidence.some((line) => line.label === "原因" && line.value === "缺少生产部署授权"));

  const insufficient = presentCluedLogCard(logRecord({
    id: "577b",
    status: "BLOCKED",
    content: JSON.stringify({ detail: { unknown: 1 } }),
  }), "日志", "zh-CN");

  assert.ok(!insufficient.title.includes("Cloudflare"));
  assert.equal(insufficient.title, "系统事件");
  assert.equal(insufficient.tone, "blocked");
});

test("5. explicit BLOCKED is shown as blocked while a missing status stays neutral", () => {
  const blocked = presentCluedLogCard(logRecord({
    id: "600",
    content: JSON.stringify({ action: "record_closed", status: "BLOCKED" }),
  }), "日志", "zh-CN");
  const paused = presentCluedLogCard(logRecord({
    id: "601",
    content: JSON.stringify({ action: "record_closed", status: "PAUSED" }),
  }), "日志", "zh-CN");
  const unknown = presentCluedLogCard(logRecord({
    id: "602",
    content: JSON.stringify({ action: "record_closed", result: "处理中" }),
  }), "日志", "zh-CN");

  assert.equal(blocked.tone, "blocked");
  assert.ok(blocked.tags.some((tag) => tag === "已阻断"));
  assert.equal(paused.tone, "blocked");
  assert.ok(paused.tags.some((tag) => tag === "已暂停"));

  assert.equal(unknown.tone, "neutral");
  assert.ok(!unknown.tags.some((tag) => ["成功", "完成", "已阻断", "已暂停", "失败"].includes(tag)));
});

test("6. a missing version is not printed on the main card but stays explained in the details", () => {
  const card = presentCluedLogCard(logRecord({
    id: "579",
    content: JSON.stringify({ action: "record_closed", result: "处理完成" }),
  }), "日志", "zh-CN");

  assert.ok(!card.tags.some((tag) => tag.includes("版本未记录") || tag.includes("n/a") || /^v\s*$/.test(tag)));
  assert.ok(card.metadata.some((line) => line.label === "版本" && line.value.includes("未记录")));

  const versioned = presentCluedLogCard(logRecord({
    id: "579",
    version: 3,
    content: JSON.stringify({ action: "record_closed", result: "处理完成" }),
  }), "日志", "zh-CN");

  assert.ok(versioned.tags.includes("v3"));
  assert.ok(versioned.metadata.some((line) => line.value === "v3"));
});

test("7. every structured field survives, including 8 KB bodies, SHAs and Windows paths", () => {
  const payload = {
    action: "merge_and_close_integration_branch",
    result: "Done",
    sha: "ef4cb5383236b8a643f760ce1f20255f07aba630",
    url: "https://clued.pixelgrav.com/current/work/log/578?source=canonical",
    path: "C:\\Users\\Windows\\Documents\\Codex\\very\\long\\path\\record.json",
    evidence: "x".repeat(8192),
  };
  const card = presentCluedLogCard(logRecord({ content: JSON.stringify(payload) }), "Log");

  assert.equal(card.summary, "Done");
  assert.equal(card.rawDetails, JSON.stringify(payload, null, 2));
  assert.ok(card.rawDetails.length > 8192);
  assert.match(card.rawDetails, /ef4cb5383236b8a643f760ce1f20255f07aba630/);
  assert.match(card.rawDetails, /C:\\\\Users\\\\Windows/);
  assert.match(card.rawDetails, /"evidence": "x{100}/);
  assert.equal(Object.keys(JSON.parse(card.rawDetails)).length, Object.keys(payload).length);
});

test("8. malformed JSON and script markup stay inert text data", () => {
  const malformed = '{"action":"record_closed",';
  const malformedCard = presentCluedLogCard(logRecord({ content: malformed }), "Log");

  assert.equal(malformedCard.summary, malformed);
  assert.equal(malformedCard.rawDetails, malformed);
  assert.equal(malformedCard.title, "Log");

  const script = "<script>globalThis.compromised = true</script>";
  const scriptCard = presentCluedLogCard(logRecord({ content: script }), "Log");

  assert.equal(scriptCard.summary, script);
  assert.equal(scriptCard.rawDetails, script);
  assert.equal(globalThis.compromised, undefined);
});

test("keeps title, decision, action, and canonical event priority stable", () => {
  const structured = {
    decision: "保留固定源提交",
    action: "record_closed",
    canonical_event_type: "fallback_event",
  };

  assert.equal(
    presentCluedLogCard(logRecord({ title: "显式标题", content: JSON.stringify(structured) }), "日志", "zh-CN").title,
    "显式标题",
  );
  assert.equal(
    presentCluedLogCard(logRecord({ content: JSON.stringify(structured) }), "日志", "zh-CN").title,
    "保留固定源提交",
  );
  assert.equal(
    presentCluedLogCard(logRecord({ content: JSON.stringify({ action: structured.action, canonical_event_type: structured.canonical_event_type }) }), "日志", "zh-CN").title,
    "关闭记录",
  );
  assert.equal(
    presentCluedLogCard(logRecord({ content: JSON.stringify({ canonical_event_type: structured.canonical_event_type }) }), "日志", "zh-CN").title,
    "Fallback event",
  );
});

test("drops a summary line that would only repeat the title", () => {
  const card = presentCluedLogCard(logRecord({
    content: JSON.stringify({ canonical_event_type: "record_closed", summary: "关闭记录" }),
  }), "日志", "zh-CN");

  assert.equal(card.title, "关闭记录");
  assert.equal(card.summary, "暂无可读摘要，请展开查看原始记录");
});

test("combines unique summary fields into no more than three readable lines", () => {
  const content = JSON.stringify({
    action: "record_closed",
    summary: "处理完成",
    message: "处理完成",
    result: "验证通过",
    verification: { status: "生产流量未变化" },
    error: "第四行不应进入摘要",
  });
  const card = presentCluedLogCard(logRecord({ content }), "日志", "zh-CN");

  assert.equal(card.summary, "处理完成\n验证通过\n生产流量未变化");
});

test("ships the five-layer log card with safe native disclosure and no placeholder copy", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const presentation = await readFile(new URL("../app/record-presentation.ts", import.meta.url), "utf8");

  assert.match(page, /record\.record_type === "log"/);
  assert.match(page, /log-card tone-\$\{card\.tone\}/);
  assert.match(page, /log-card-dot/);
  assert.match(page, /log-card-time/);
  assert.match(page, /log-card-summary/);
  assert.match(page, /log-card-tag/);
  assert.match(page, /card\.tags\.map/);
  assert.match(page, /card\.metadata\.map/);
  assert.match(page, /<details className="record-details">/);
  assert.match(page, /<pre>\{card\.rawDetails\}<\/pre>/);
  assert.match(page, /viewEvidence: "View evidence and raw record"/);
  assert.match(page, /viewEvidence: "查看证据与原始记录"/);
  assert.match(page, /viewRawRecord: "View raw record"/);
  assert.match(page, /viewRawRecord: "查看原始记录"/);
  assert.match(page, /item\.version === null \? t\.versionNotRecorded/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /v\{[^\n]*n\/a/);

  // Placeholder copy may only exist as a rejection-list entry, never as emitted output.
  const listStart = presentation.indexOf("TITLE_PLACEHOLDERS");
  const listEnd = presentation.indexOf("]);", listStart);
  assert.ok(listStart > -1 && listEnd > listStart);
  const denyList = presentation.slice(listStart, listEnd);
  const restOfModule = presentation.slice(0, listStart) + presentation.slice(listEnd);

  assert.match(denyList, /结构化日志记录/);
  assert.match(denyList, /操作日志/);
  assert.doesNotMatch(restOfModule, /结构化日志记录/);
  assert.doesNotMatch(restOfModule, /操作日志/);
});

test("contains cards and wraps long identifiers while scrolling only raw details", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.records-panel\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.auth-card-account\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.record-item strong\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.record-item p\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.record-details\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.record-details pre\s*\{[^}]*max-height:\s*280px[^}]*overflow:\s*auto[^}]*overflow-wrap:\s*anywhere/s);

  assert.match(css, /\.log-card \.log-card-head\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.log-card \.log-card-summary\s*\{[^}]*-webkit-line-clamp:\s*3/s);
  assert.match(css, /\.log-card \.log-card-summary\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.log-card \.log-card-time\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(css, /\.log-card \.log-card-tag\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.log-detail-row dd\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /@media \(max-width: 560px\)/);
});
