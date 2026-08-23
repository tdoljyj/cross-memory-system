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
