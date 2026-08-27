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
  const expiryFix = read('supabase/migrations/20260827072012_p5_expired_attempt_reissue.sql');
  const linearizationFix = read('supabase/migrations/20260827084500_p5_attempt_reissue_linearization.sql');
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
  assert.match(expiryFix, /status in \('open','completed','failed','expired'\)/);
  assert.match(expiryFix,
    /update public\.clued_p5_gateway_attempts a[\s\S]*a\.status='open' and a\.expires_at<=now\(\)[\s\S]*select \* into v_existing[\s\S]*insert into public\.clued_p5_gateway_attempts/,
    'expired open Attempt must be atomically retired and Idempotency rechecked before insert');
  assert.match(expiryFix, /set status='expired'/);
  assert.match(expiryFix, /P5_ATTEMPT_EXPIRED/);
  assert.match(expiryFix, /P5_ATTEMPT_CANONICAL_RESULT_MISSING/);
  assert.match(expiryFix, /P5_ATTEMPT_UNAVAILABLE/);
  assert.match(expiryFix,
    /P5_ATTEMPT_REQUEST_MISMATCH'[\s\S]*v_attempt\.expires_at<=now\(\)[\s\S]*v_attempt\.status in \('completed','failed'\)/,
    'mutate/resolve must check request, then expiry, then terminal status');
  assert.match(expiryFix,
    /create or replace function public\.clued_p5_record_commit_failure[\s\S]*p5_resolve_request[\s\S]*P5_ATTEMPT_REQUEST_MISMATCH[\s\S]*P5_ATTEMPT_EXPIRED[\s\S]*P5_ATTEMPT_ALREADY_CONSUMED[\s\S]*P5_UNTRUSTED_FAILURE_CLASS/,
    'commit-failure must validate request and expiry before status/failure class');
  assert.match(expiryFix, /to clued_p5_gateway/);
  assert.doesNotMatch(expiryFix, /grant execute[\s\S]*to (anon|authenticated|service_role)/);
  assert.match(linearizationFix, /issuance_parent text/);
  assert.match(linearizationFix,
    /create unique index if not exists clued_p5_gateway_attempt_issuance_uidx[\s\S]*idempotency_key,issuance_parent/,
    'successor issuance slot must remain unique across every Attempt status');
  assert.doesNotMatch(linearizationFix,
    /clued_p5_gateway_attempt_issuance_uidx[\s\S]{0,300}where status='open'/,
    'linearization constraint must not be released by terminal status');
  assert.match(linearizationFix, /P5_ATTEMPT_ISSUANCE_PARENT_IMMUTABLE/);
  assert.match(linearizationFix,
    /before update of issuance_parent on public\.clued_p5_gateway_attempts/);
  assert.match(linearizationFix,
    /final Idempotency read before issuance[\s\S]*insert into public\.clued_p5_gateway_attempts[\s\S]*issuance_parent/,
    'the immutable issuance slot must close the final-recheck/INSERT window');
  assert.match(linearizationFix,
    /A conflict is a permanent issuance decision[\s\S]*v_latest\.status in \('completed','failed'\)[\s\S]*canonical_result/,
    'a terminal winner must replay after permanent issuance conflict');
  assert.match(linearizationFix, /IDEMPOTENCY_PAYLOAD_CONFLICT/);
  assert.match(linearizationFix, /to clued_p5_gateway/);
  assert.doesNotMatch(linearizationFix, /grant execute[\s\S]*to (anon|authenticated|service_role)/);
});
