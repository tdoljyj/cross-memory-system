import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/20260921193000_k_cont_single_stage.sql", import.meta.url),
  "utf8",
);
const continuity = readFileSync(new URL("../worker/continuity.ts", import.meta.url), "utf8");
const records = readFileSync(new URL("../worker/records.ts", import.meta.url), "utf8");
const resumeImportBudgetDelta = readFileSync(
  new URL("../supabase/migrations/20260921204000_k_cont_resume_import_budget_delta.sql", import.meta.url),
  "utf8",
);

test("K-CONT-07 requires explicit checkpoint coverage", () => {
  assert.match(migration, /checkpoint_coverage jsonb/);
  assert.match(migration, /checkpoint_coverage_required/);
  assert.match(migration, /checkpoint_context_not_covered/);
  assert.match(migration, /checkpoint_tracks_required/);
  assert.match(continuity, /required: \["session_token", "base_version", "snapshot", "summary", "next_action", "coverage"\]/);
});

test("K-CONT-07 preserves unabsorbed events", () => {
  assert.match(migration, /clued_checkpoint_event_absorptions/);
  assert.match(migration, /checkpoint_event_already_absorbed/);
  assert.match(migration, /pending_event_count_after/);
  assert.match(migration, /not exists\(select 1 from public\.clued_checkpoint_event_absorptions/);
});

test("K-CONT-04 exposes active machine-readable constraints", () => {
  assert.match(migration, /'active_constraints',v_constraints/);
  assert.match(migration, /type_fields->>'constraint','false'\)='true'/);
  assert.match(records, /constraint_marker: "decision\.type_fields\.constraint=true"/);
});

test("K-CONT-03 keeps live truth ahead of imported history", () => {
  const live = migration.indexOf("## Latest checkpoint");
  const imported = migration.indexOf("## Imported historical baseline");
  assert.ok(live >= 0 && imported > live);
  assert.match(migration, /Imported checkpoint snapshot/);
  assert.match(migration, /decision_newer_than_checkpoint/);
});

test("K-CONT-06 returns session compliance and reminders", () => {
  assert.match(migration, /session_compliance/);
  assert.match(migration, /expired_without_checkpoint/);
  assert.match(migration, /checkpoint_required_before_handoff/);
  assert.match(migration, /'checkpoint_reminder',v_reminder/);
});

test("BUG-20260924-001 L1 never reports a write-free session as having no material changes", () => {
  const captureMigration = readFileSync(
    new URL("../supabase/migrations/20260924200000_bug_20260924_001_capture_unknown.sql", import.meta.url),
    "utf8",
  );
  const body = captureMigration.replace(/^--.*$/gm, "");
  assert.doesNotMatch(body, /no_material_changes/);
  assert.match(body, /else 'capture_unknown' end/);
  assert.match(body, /'authority_capture',case when x\.append_count>0 and x\.checkpoint_count=0 then 'incomplete' else 'unknown' end/);
  assert.match(body, /'authority_capture_completeness',jsonb_build_object\(/);
  assert.match(body, /'independent_of','currentness'/);
  assert.doesNotMatch(body, /'complete'/);
  assert.match(continuity, /authority_capture_completeness: "unknown_or_incomplete_never_complete"/);
});

test("K-CONT-01 budgets and paginates resume events", () => {
  assert.match(continuity, /event_budget_bytes/);
  assert.match(continuity, /event_cursor/);
  assert.match(continuity, /response_view/);
  assert.match(migration, /v_event_budget integer/);
  assert.match(migration, /'event_page',jsonb_build_object/);
});

test("K-CONT-01 preserves the scoped development-context restore router", () => {
  assert.match(migration, /create or replace function public\.clued_mcp_restore_before_project_access_v13/);
  assert.doesNotMatch(migration, /create or replace function public\.clued_mcp_restore\(p_token_hash/);
  assert.match(migration, /grant execute on function public\.clued_mcp_restore\(text,jsonb\) to anon,authenticated/);
});

test("K-CONT-01 avoids duplicate log plus event payloads", () => {
  assert.match(migration, /if v_response_view='work_log' then/);
  assert.match(migration, /return v_result\|\|jsonb_build_object\('events_after_checkpoint',v_events\)/);
  assert.doesNotMatch(migration, /'events_after_checkpoint',v_events,[\s\S]{0,200}'work_log'/);
});

test("K-CONT-01 keeps imported history outside the resume response budget", () => {
  assert.match(resumeImportBudgetDelta, /available through the explicit \`clued_read_log\` history surface/);
  assert.doesNotMatch(resumeImportBudgetDelta, /pg_catalog\.rtrim/);
  assert.doesNotMatch(resumeImportBudgetDelta, /Imported checkpoint snapshot/);
});

test("K-CONT-01 budgets and paginates search", () => {
  assert.match(continuity, /max_bytes/);
  assert.match(continuity, /cursor/);
  assert.match(migration, /v_budget integer/);
  assert.match(migration, /oversize_first_item/);
});

test("K-CONT-01 resolves canonical record targets for mutation events", () => {
  assert.match(migration, /'record_targets'/);
  assert.match(migration, /'title',m\.title/);
  assert.match(migration, /'target_refs',coalesce\(e\.target_refs/);
});

test("K-CONT-05 advertises the create mutation shape", () => {
  assert.match(records, /Create requires mutation, source_refs, and source_unavailable_reason/);
  assert.match(records, /type_fields: \{ type: "object" \}/);
  assert.match(records, /relations: \{ type: "object" \}/);
});

test("K-CONT-05 rejects missing fields before database dispatch", () => {
  assert.match(continuity, /function validateRecordMutationInput/);
  assert.match(continuity, /missing_fields/);
  assert.match(continuity, /invalid_fields/);
  assert.match(continuity, /decision_rationale_required/);
  assert.match(continuity, /authority_escalation_forbidden/);
});

test("K-CONT-02 provides threshold-based checkpoint guidance", () => {
  assert.match(migration, /pending_event_threshold_reached/);
  assert.match(migration, /v_pending_count>=20 or v_pending_bytes>=32768/);
  assert.match(continuity, /checkpoint thresholds/);
});
