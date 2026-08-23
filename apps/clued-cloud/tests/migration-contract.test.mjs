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
