import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = new URL("../../supabase/migrations/", import.meta.url);
const migrationNames = (await readdir(migrationDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migrationSources = await Promise.all(
  migrationNames.map(async (name) => ({
    name,
    sql: await readFile(new URL(name, migrationDirectory), "utf8"),
  })),
);
const schemaSql = migrationSources.map(({ name, sql }) => `\n-- ${name}\n${sql}`).join("\n");
const compactSql = schemaSql.toLowerCase().replace(/\s+/g, " ");

function definition(marker) {
  const start = compactSql.indexOf(marker.toLowerCase());
  if (start < 0) return "";
  const end = compactSql.indexOf("$$;", start);
  return compactSql.slice(start, end < 0 ? compactSql.length : end + 3);
}

function viewDefinition(name) {
  const marker = `view public.${name}`;
  const start = compactSql.indexOf(marker);
  if (start < 0) return "";
  const end = compactSql.indexOf(";", start);
  return compactSql.slice(start, end < 0 ? compactSql.length : end + 1);
}

function contract(name, check) {
  test(name, () => {
    try {
      check();
    } catch {
      assert.fail(`${name.split(":", 1)[0]} contract is not implemented by local migrations`);
    }
  });
}

contract("CLD-VIEW-001: one physical task powers Global and Project views", () => {
  assert.match(compactSql, /add column(?: if not exists)? record_type text/);
  assert.match(compactSql, /add column(?: if not exists)? project_id uuid/);
  const recordsView = viewDefinition("clued_records_v2");
  assert.match(recordsView, /security_invoker/);
  assert.match(recordsView, /from public\.clued_memories/);
  assert.match(recordsView, /effective_project_id/);
  assert.doesNotMatch(
    compactSql,
    /create table(?: if not exists)? public\.clued_(?:states|tasks|decisions|archives)/,
  );
});

contract("CLD-VIEW-002: rename preserves project and historical record identity", () => {
  const projectUpdate = definition("function clued_private.project_update_core");
  assert.match(projectUpdate, /v_action='rename'/);
  assert.match(projectUpdate, /where id=v_project\.id returning \* into v_project/);
  assert.doesNotMatch(projectUpdate, /delete from public\.clued_projects/);
  assert.doesNotMatch(projectUpdate, /update public\.clued_project_mentions set project_id/);
});

contract("CLD-VIEW-003: merge resolves an effective project without copying record bodies", () => {
  const resolutionView = viewDefinition("clued_project_resolution_v2");
  assert.match(resolutionView, /with recursive/);
  assert.match(resolutionView, /effective_project_id/);
  assert.doesNotMatch(
    compactSql,
    /update public\.clued_memories set project_id|insert into public\.clued_memories[\s\S]*select[\s\S]*from public\.clued_memories/,
  );
});

contract("CLD-VIEW-004: an unconfirmed project cannot create five-view records or events", () => {
  const recordWrite = definition("function clued_private.record_write_core");
  assert.match(recordWrite, /certainty_status='confirmed'|certainty_status = 'confirmed'/);
  assert.match(recordWrite, /dismissed_at is null/);
  assert.match(recordWrite, /merged_into_project_id is null/);
  assert.match(recordWrite, /unconfirmed_project|project_not_confirmed/);
});

contract("CLD-VIEW-005: current State is independent from Event and legacy Log text", () => {
  const recordsView = viewDefinition("clued_records_v2");
  assert.match(recordsView, /record_type/);
  assert.doesNotMatch(recordsView, /clued_context_events/);
  assert.doesNotMatch(recordsView, /clued_log_versions/);
  assert.doesNotMatch(recordsView, /clued_context_checkpoints/);
});

contract("CLD-VIEW-006: decision supersession retains both records and their relation", () => {
  assert.match(compactSql, /add column(?: if not exists)? supersedes_id uuid/);
  assert.match(compactSql, /decision/);
  assert.match(compactSql, /superseded/);
  const recordWrite = definition("function clued_private.record_write_core");
  assert.match(recordWrite, /supersede_decision/);
  assert.doesNotMatch(recordWrite, /delete from public\.clued_memories/);
});

contract("CLD-VIEW-007: Archive is an immutable snapshot, not a copied event stream", () => {
  assert.match(compactSql, /archive_snapshot/);
  assert.match(compactSql, /add column(?: if not exists)? restored_from_id uuid/);
  const recordWrite = definition("function clued_private.record_write_core");
  assert.match(recordWrite, /archive/);
  assert.doesNotMatch(
    recordWrite,
    /insert into public\.clued_memories[\s\S]*select[\s\S]*from public\.clued_context_events/,
  );
});

contract("CLD-VIEW-008: stale expected versions fail instead of silently overwriting", () => {
  assert.match(compactSql, /add column(?: if not exists)? version bigint/);
  const recordWrite = definition("function clued_private.record_write_core");
  assert.match(recordWrite, /expected_version/);
  assert.match(recordWrite, /record_version_conflict/);
  assert.match(recordWrite, /version=version\+1|version = version \+ 1/);
});

contract("CLD-VIEW-009: task completion, State advance, Event and Receipt share one transaction", () => {
  const recordWrite = definition("function clued_private.record_write_core");
  assert.match(recordWrite, /complete_task_and_advance_state/);
  assert.match(recordWrite, /update public\.clued_memories/);
  assert.match(recordWrite, /insert into public\.clued_context_events/);
  assert.match(recordWrite, /insert into public\.clued_audit_receipts/);
});

contract("CLD-VIEW-010: V2 RLS and grants preserve ownership and restrict legacy direct writes", () => {
  assert.match(compactSql, /clued_memories_v2_select_own/);
  assert.match(compactSql, /using \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.match(compactSql, /with check \(\(select auth\.uid\(\)\) = user_id/);
  assert.match(compactSql, /record_type='note'|record_type = 'note'/);
  assert.match(compactSql, /scope='global'|scope = 'global'/);
  assert.match(compactSql, /grant insert \(user_id,title,content\)/);
});

contract("CLD-VIEW-011: cross-project writes validate ownership and effective target", () => {
  const recordWrite = definition("function clued_private.record_write_core");
  assert.match(recordWrite, /p\.user_id=p_user_id|p\.user_id = p_user_id/);
  assert.match(recordWrite, /effective_project_id/);
  assert.match(recordWrite, /project_scope_mismatch|cross_project/);
});

contract("CLD-VIEW-012: current-work query uses current-record indexes, not Log scans", () => {
  const globalView = viewDefinition("clued_global_work_v2");
  assert.match(globalView, /clued_records_v2/);
  assert.doesNotMatch(globalView, /clued_context_events|clued_log_versions|clued_context_checkpoints/);
  assert.match(compactSql, /clued_memories_user_type_status_priority/);
  assert.match(compactSql, /clued_memories_user_project_type_status_priority/);
});

contract("CLD-WRITE-001: idempotency binds one key to one canonical request", () => {
  assert.match(compactSql, /add column(?: if not exists)? request_sha256 text/);
  assert.match(compactSql, /clued_audit_receipts[\s\S]*idempotency_key/);
  assert.match(compactSql, /idempotency_key_conflict/);
});

contract("CLD-SEC-001: V2 views and privileged functions are explicitly contained", () => {
  const recordsView = viewDefinition("clued_records_v2");
  const recordWrite = definition("function clued_private.record_write_core");
  assert.match(recordsView, /security_invoker/);
  assert.match(recordWrite, /security definer/);
  assert.match(recordWrite, /set search_path=''/);
  assert.match(
    compactSql,
    /revoke all on function clued_private\.record_write_core\([^)]*\) from public, ?anon, ?authenticated/,
  );
});
