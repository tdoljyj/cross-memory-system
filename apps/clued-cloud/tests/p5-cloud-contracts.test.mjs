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
  assert.match(p5, /CLUED_P5_GATEWAY_TOKEN/);
  assert.match(continuity, /p5TenantWritesEnabled/);
  assert.match(continuity, /p5GatewayToken/);
  assert.match(continuity, /clued_p5_attempt_begin/);
  assert.match(continuity, /clued_p5_attempt_resolve/);
  assert.match(continuity, /clued_p5_record_commit_failure/);
  assert.match(continuity, /p5AttemptRaceResult/);
  assert.match(continuity, /P5_ATTEMPT_ALREADY_CONSUMED/);
  assert.match(continuity, /p5ResolvedCanonicalResult/);
  assert.match(continuity, /p5AttemptResolutionFailed/);
  assert.match(continuity, /database_commit_failure/);
  assert.match(continuity, /transport_failure/);
  assert.match(continuity, /require an independent revocable Agent Binding/);
  assert.match(continuity, /!token\.startsWith\("clued_bnd_"\)/);
  assert.match(continuity, /bytes\.byteLength > MAX_JSON_BYTES/);
  assert.doesNotMatch(continuity, /as unknown as/);
});

test('P5 migrations enforce gateway-only RPC, Attempt-bound failure, RLS, and canonical-only writes', () => {
  const migration = read('supabase/migrations/20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql');
  const fix = read('supabase/migrations/20260827050750_p5_gateway_attempt_commit_failure.sql');
  const replayFix = read('supabase/migrations/20260827062132_p5_concurrent_attempt_replay.sql');
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
  assert.doesNotMatch(migration, /grant execute[\s\S]*to anon/);
  assert.match(fix, /create role clued_p5_gateway nologin noinherit[\s\S]*nobypassrls/);
  assert.match(fix, /grant clued_p5_gateway to authenticator/);
  assert.match(fix, /clued_p5_gateway_attempts/);
  assert.match(fix, /P5_ATTEMPT_NOT_FOUND/);
  assert.match(fix, /P5_ATTEMPT_ALREADY_CONSUMED/);
  assert.match(fix, /P5_ATTEMPT_REQUEST_MISMATCH/);
  assert.match(fix, /P5_UNTRUSTED_FAILURE_CLASS/);
  assert.match(fix, /from public,anon,authenticated,service_role/);
  assert.match(fix, /to clued_p5_gateway/);
  assert.doesNotMatch(fix, /grant execute[\s\S]*to (anon|authenticated|service_role)/);
  assert.doesNotMatch(fix, /p_error text/);
  assert.match(replayFix,
    /P5_ATTEMPT_REQUEST_MISMATCH[\s\S]*v_attempt\.status in \('completed','failed'\)/,
    'request mismatch must be checked before terminal Attempt replay');
  assert.match(replayFix, /return v_attempt\.canonical_result/);
  assert.match(replayFix, /P5_ATTEMPT_CANONICAL_RESULT_MISSING/);
  assert.match(replayFix, /P5_ATTEMPT_STATUS_UNKNOWN/);
  assert.match(replayFix, /P5_ATTEMPT_EXPIRED/);
  assert.match(replayFix, /is distinct from v\.organization_id/);
  assert.match(replayFix, /is distinct from v\.workspace_id/);
  assert.match(replayFix, /is distinct from v\.user_id/);
  assert.match(replayFix, /is distinct from v\.binding_id/);
  assert.match(replayFix, /is distinct from v_hash/);
  assert.match(replayFix, /is distinct from p_input->>'idempotency_key'/);
  assert.match(replayFix, /is distinct from p_input->>'target_kind'/);
  assert.match(replayFix, /is distinct from \(p_input->>'target_id'\)::uuid/);
  assert.match(replayFix, /is distinct from \(p_input->>'base_version'\)::bigint/);
  assert.doesNotMatch(replayFix, /P5_ATTEMPT_ALREADY_CONSUMED/);
});
