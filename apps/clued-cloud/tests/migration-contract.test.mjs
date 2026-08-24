import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("continuity migration preserves ownership, revocation, conflict and audit invariants", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/202608230001_clued_continuity.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /enable row level security/);
  assert.match(sql, /auth\.uid\(\) = user_id/);
  assert.match(sql, /revoked_at is null/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /stale_base_version/);
  assert.match(sql, /clued_audit_receipts/);
  assert.match(sql, /canonical_store', 'clued-cloud\/supabase'/);
  assert.doesNotMatch(sql, /vector\s*\(/i);
});

test("mandatory continuity migration preserves lifecycle, log and hash-only invariants", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/202608230002_mandatory_continuity.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /clued_continuity_sessions/);
  assert.match(sql, /clued_log_versions/);
  assert.match(sql, /clued_mcp_import_log/);
  assert.match(sql, /clued_mcp_read_log/);
  assert.match(sql, /token_hash text not null unique/);
  assert.match(sql, /resume_required/);
  assert.match(sql, /stale_base_version/);
  assert.match(sql, /enable row level security/);
  assert.doesNotMatch(sql, /vector\s*\(/i);
});

test("memory CRUD migration enforces ownership, explicit grants and digest-only audit", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/20260823182409_clued_memory_crud.sql", import.meta.url),
    "utf8",
  );
  const grantSql = await readFile(
    new URL(
      "../supabase/migrations/20260823182517_harden_clued_memory_grants.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /create table public\.clued_memories/);
  assert.match(sql, /create table public\.clued_memory_audit/);
  assert.match(sql, /clued_memories_select_own/);
  assert.match(sql, /clued_memories_insert_own/);
  assert.match(sql, /clued_memories_update_own/);
  assert.match(sql, /clued_memories_delete_own/);
  assert.match(sql, /using \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.match(sql, /with check \(\(select auth\.uid\(\)\) = user_id\)/);
  assert.match(sql, /grant select, insert, update, delete on table public\.clued_memories to authenticated/);
  assert.match(sql, /revoke all on table public\.clued_memories from anon/);
  assert.match(sql, /content_sha256/);
  assert.doesNotMatch(sql, /insert into public\.clued_memory_audit[\s\S]*v_row\.content[,)]/i);
  assert.match(grantSql, /revoke all on table public\.clued_memories from anon, authenticated/);
  assert.match(grantSql, /revoke all on table public\.clued_memory_audit from anon, authenticated/);
  assert.match(grantSql, /grant select, insert, update, delete/);
  assert.match(grantSql, /grant select\s+on table public\.clued_memory_audit/);
});

test("project lifecycle v1 uses exactly two tables with independent certainty and progress", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/202608240003_project_lifecycle_v1.sql", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    [...sql.matchAll(/create table if not exists public\.(\w+)/gi)].map((match) => match[1]),
    ["clued_projects", "clued_project_mentions"],
  );
  assert.match(sql, /certainty_status in \('unconfirmed', 'confirmed'\)/);
  assert.match(sql, /progress_status in \('not_started', 'active', 'paused', 'completed', 'archived'\)/);
  assert.match(sql, /unique \(user_id, idempotency_key\)/);
  assert.match(sql, /clued_projects_user_name_active_uidx/);
  assert.match(sql, /merged_into_project_id/);
  assert.match(sql, /'project:' \|\| v_new_project_id::text/);
  assert.match(sql, /possible_duplicates/);
  assert.doesNotMatch(sql, /create table[^;]+project_audit/is);
  assert.doesNotMatch(sql, /vector\s*\(/i);
});

test("project lifecycle v1 enforces RLS, least privilege and serialized writes", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/202608240003_project_lifecycle_v1.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /\(select auth\.uid\(\)\) = user_id/);
  assert.match(sql, /clued_private\.resolve_binding\(p_token_hash,'context:write','system:projects'\)/);
  assert.match(sql, /clued_private\.resolve_binding\(p_token_hash,'context:read','system:projects'\)/);
  assert.match(sql, /pg_advisory_xact_lock/g);
  assert.match(sql, /set search_path=''/g);
  assert.match(sql, /revoke all on public\.clued_projects, public\.clued_project_mentions from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.clued_project_observe\(text,jsonb\) to anon/);
  assert.match(sql, /grant execute on function public\.clued_user_project_update\(jsonb\) to authenticated/);
});

test("project lifecycle v1 preserves identity during confirmation and supports complete cleanup", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/202608240003_project_lifecycle_v1.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /certainty_status=case when v_intent='confirmed' then 'confirmed' else certainty_status end/);
  assert.match(sql, /where id=v_project\.id returning \* into v_project/);
  assert.match(sql, /dismissed_at=case when v_action='dismiss' then now\(\) when v_action='restore' then null/);
  assert.match(sql, /operation in \('observe', 'update', 'merge'\)/);
  assert.doesNotMatch(sql, /delete from public\.clued_project_mentions/);
  assert.match(sql, /project_version_conflict/);
  assert.match(sql, /'status','idempotent'/);
});

test("unified record v2 is additive, single-source, transactional and least-privilege", async () => {
  const sql = await readFile(
    new URL("../supabase/migrations/20260824014005_unified_record_v2.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /alter table public\.clued_memories/);
  assert.match(sql, /record_type text not null default 'note'/);
  assert.match(sql, /create or replace view public\.clued_records_v2\s+with \(security_invoker=true\)/);
  assert.match(sql, /create or replace function clued_private\.record_write_core/);
  assert.match(sql, /security definer set search_path=''/);
  assert.match(sql, /record_version_conflict/);
  assert.match(sql, /idempotency_key_conflict/);
  assert.match(sql, /insert into public\.clued_context_events/);
  assert.match(sql, /insert into public\.clued_audit_receipts/);
  assert.match(sql, /grant insert \(user_id,title,content\)/);
  assert.doesNotMatch(sql, /create table(?: if not exists)? public\.clued_(?:states|tasks|decisions|archives)/);
  assert.doesNotMatch(sql, /update public\.clued_memories set project_id/);
});
