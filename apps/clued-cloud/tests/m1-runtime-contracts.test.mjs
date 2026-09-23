import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrations = new URL("../supabase/migrations/", import.meta.url);
const names = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
const sql = (await Promise.all(names.map((name) => readFile(new URL(name, migrations), "utf8")))).join("\n").toLowerCase();
const records = (await readFile(new URL("../worker/records.ts", import.meta.url), "utf8")).toLowerCase();
const projects = (await readFile(new URL("../worker/projects.ts", import.meta.url), "utf8")).toLowerCase();

test("M1 exposes distinct executable Record, Decision, Project, Event, Evidence and Export contracts", () => {
  for (const name of ["record_mutation_core", "decision_supersede_core", "project_mutation_core", "append_event_core", "evidence_ingest_core", "canonical_export_core"]) {
    assert.match(sql, new RegExp(`function clued_private\\.${name}`));
  }
  assert.match(records, /clued_record_mutate/);
  assert.match(records, /clued_decision_supersede/);
  assert.match(records, /clued_evidence_ingest/);
  assert.match(records, /clued_event_append/);
  assert.match(records, /clued_canonical_export/);
  assert.match(projects, /clued_project_mutate/);
});

test("M1 receipt owns idempotency by verified user and operation family", () => {
  assert.match(sql, /user_id, operation_family, idempotency_key/);
  assert.match(sql, /where owns_idempotency_key/);
  assert.match(sql, /idempotency_key_conflict/);
  assert.match(sql, /canonical_result/);
  assert.match(sql, /response_hash/);
});

test("M1 keeps Event sequencing disabled and writes entity + Event + Receipt transactionally", () => {
  assert.match(sql, /event_stream_id.*stream_generation.*event_sequence/s);
  assert.match(sql, /1,null,null,null,p_canonical_version/);
  assert.match(sql, /m1_append_event_row/);
  assert.match(sql, /m1_finish_receipt/);
  assert.match(records, /event_stream_ordering_enabled: false/);
});

test("archive_snapshot and merge writes are absent from the new public contracts", () => {
  const mutateStart = records.indexOf('name: "clued_record_mutate"');
  const mutateEnd = records.indexOf('name: "clued_decision_supersede"');
  assert.ok(mutateStart >= 0 && mutateEnd > mutateStart);
  assert.doesNotMatch(records.slice(mutateStart, mutateEnd), /archive_snapshot/);
  assert.doesNotMatch(projects, /"merge"/);
  assert.match(sql, /record_schema_version is null and record_type in \('note','state','task','decision','archive_snapshot'\)/);
});

test("RLS views are security invoker and private cores are revoked", () => {
  assert.match(sql, /view public\.clued_records_m1 with \(security_invoker=true\)/);
  assert.match(sql, /view public\.clued_projects_m1 with \(security_invoker=true\)/);
  assert.match(sql, /view public\.clued_events_m1 with \(security_invoker=true\)/);
  assert.match(sql, /record_mutation_core\(uuid,uuid,jsonb,text\).*from public,anon,authenticated/s);
});

test("authorized export is Receipt-backed and legacy rows remain explicit", () => {
  assert.match(sql, /m1_begin_receipt\(p_user_id,p_binding_id,'export'/);
  assert.match(sql, /export_receipt_id/);
  assert.match(sql, /kind','legacy_record'/);
  assert.match(sql, /kind','legacy_event'/);
  assert.match(sql, /views_complete/);
});


test("project certainty successor v2 removes certainty from public eligibility semantics", async () => {
  const successor = (await readFile(
    new URL("../supabase/migrations/20260923220000_project_certainty_successor_v2.sql", import.meta.url),
    "utf8",
  )).toLowerCase();
  assert.match(projects, /project_schema_version:\s*\{\s*type:\s*"integer",\s*const:\s*2\s*\}/);
  assert.doesNotMatch(projects, /certainty_status:\s*\{\s*type:\s*"string"/);
  assert.match(successor, /certainty_status_retired/);
  assert.match(successor, /recognition_confidence/);
  assert.match(successor, /project_unavailable/);
  assert.doesNotMatch(
    successor.slice(successor.indexOf("function clued_private.record_mutation_core")),
    /certainty_status\s*=\s*'confirmed'/,
  );
});
