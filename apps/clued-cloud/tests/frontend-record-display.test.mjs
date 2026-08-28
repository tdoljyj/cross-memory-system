import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { presentCluedRecordDisplay } from "../app/record-presentation.ts";

const updatedAt = "2026-08-28T08:03:23.000Z";

test("summarizes structured records while preserving complete pretty-printed details", () => {
  const body = JSON.stringify({
    authority: "user_explicit",
    user_message: "授权 G6-P",
    remote_main: "59ce5224b1b8ad502184a26e8c00f9e51521e41e",
  });
  const item = presentCluedRecordDisplay({
    id: "record-1",
    record_type: "decision",
    body,
    updated_at: updatedAt,
  }, "Decision");

  assert.equal(item.summary, "授权 G6-P");
  assert.equal(item.conclusion, body);
  assert.equal(item.rawDetails, JSON.stringify(JSON.parse(body), null, 2));
  assert.match(item.rawDetails, /"remote_main"/);
});

test("keeps plain text readable without an unnecessary details disclosure", () => {
  const item = presentCluedRecordDisplay({
    id: "record-2",
    record_type: "state",
    body: "Complete the current frontend display fix.",
    updated_at: updatedAt,
  }, "State");

  assert.equal(item.summary, "Complete the current frontend display fix.");
  assert.equal(item.rawDetails, null);
});

test("does not truncate plain-text record content", () => {
  const body = "plain text ".repeat(80);
  const item = presentCluedRecordDisplay({
    id: "record-plain-long",
    record_type: "log",
    body,
    updated_at: updatedAt,
  }, "Log");

  assert.equal(item.summary, body);
  assert.equal(item.rawDetails, null);
});

test("shows canonical log content unchanged instead of an inferred structured summary", () => {
  const content = "User-entered production log text. ".repeat(30);
  const item = presentCluedRecordDisplay({
    id: "record-log-content",
    record_type: "log",
    content,
    body: JSON.stringify({ canonical_event_type: "blocker", conflict: "Retest needs authorization." }),
    updated_at: updatedAt,
  }, "Log");

  assert.equal(item.summary, content);
  assert.equal(item.conclusion, content);
  assert.match(item.rawDetails, /"canonical_event_type": "blocker"/);
});

test("shows the complete log payload when the API has no separate content field", () => {
  const payload = { action: "deploy", evidence: "7/7 PASS", nested: { preserved: true } };
  const item = presentCluedRecordDisplay({
    id: "record-log-payload",
    record_type: "log",
    payload,
    updated_at: updatedAt,
  }, "Log");

  assert.equal(item.summary, JSON.stringify(payload));
  assert.doesNotMatch(item.summary, /…$/);
  assert.match(item.rawDetails, /"preserved": true/);
});

test("keeps structured log payloads complete instead of truncating them", () => {
  const longAction = "x".repeat(300);
  const item = presentCluedRecordDisplay({
    id: "record-3",
    record_type: "log",
    payload: { action: longAction, unknown_field: "preserved" },
    updated_at: updatedAt,
  }, "Log");

  assert.equal(item.summary, JSON.stringify({ action: longAction, unknown_field: "preserved" }));
  assert.doesNotMatch(item.summary, /…$/);
  assert.match(item.rawDetails, /"unknown_field": "preserved"/);
});

test("ships wrapping containment and safe native raw-record rendering", async () => {
  const [css, page] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(css, /\.records-panel\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.auth-card-account\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.record-item p\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.record-details pre\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(page, /<details className="record-details">/);
  assert.match(page, /<pre>\{display\.rawDetails\}<\/pre>/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.match(page, /viewStructuredRecord: "View structured record"/);
  assert.match(page, /viewStructuredRecord: "查看结构化记录"/);
});
