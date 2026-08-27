import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('P5 Worker surface is feature-gated and Binding-only', () => {
  const p5 = read('worker/p5.ts');
  const continuity = read('worker/continuity.ts');
  for (const field of [
    'organization_id', 'workspace_id', 'context_key', 'role', 'scope', 'purpose',
    'policy_version', 'revocation_epoch',
  ]) assert.match(p5, new RegExp(field));
  for (const tool of [
    'clued_p5_session_open', 'clued_p5_mutate', 'clued_p5_workspace_switch',
    'clued_p5_pending_intent', 'clued_p5_git_divergence',
  ]) {
    assert.match(p5, new RegExp(tool));
    assert.match(continuity, new RegExp('p5RpcByTool'));
  }
  assert.match(p5, /P5_TENANT_WRITES/);
  assert.match(continuity, /p5TenantWritesEnabled/);
  assert.match(continuity, /require an independent revocable Agent Binding/);
  assert.match(continuity, /!token\.startsWith\("clued_bnd_"\)/);
});

test('P5 migration enforces CAS, immutable evidence, RLS, and canonical-only writes', () => {
  const migration = read('supabase/migrations/20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql');
  assert.match(migration, /version=v_base/);
  assert.match(migration, /CANONICAL_CAS_CONFLICT/);
  assert.match(migration, /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  assert.match(migration, /clued_p5_events_immutable/);
  assert.match(migration, /clued_p5_receipts_immutable/);
  assert.match(migration, /clued_p5_audit_immutable/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /p5_rls_authorized/);
  assert.match(migration, /p5_audit\(record,text,uuid,bigint,bigint,text,jsonb,text,uuid\).*from public,anon,authenticated/s);
  assert.match(migration, /revoke insert,update,delete on table public\.clued_memories,public\.clued_projects from authenticated/);
  assert.match(migration, /status text not null default 'pending' check \(status = 'pending'\)/);
  assert.doesNotMatch(migration, /service_role/i);
});
