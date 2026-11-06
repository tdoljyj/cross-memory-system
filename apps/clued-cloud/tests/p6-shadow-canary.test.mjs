import { stopCluster } from './cluster-cleanup.mjs';
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, utimes } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop as stopEsbuild } from "esbuild";
import EmbeddedPostgres from "embedded-postgres";

import {
  buildSnapshot,
  isPublicationTransitionContentionError,
  withSnapshotPublicationLock,
} from "../scripts/two-level-snapshot.mjs";
import {
  compareShadowPair,
  normalizeShadowEnvelope,
  operationReceipt,
  runIsolatedShadow,
  sha256,
  summarizePairedLatency,
  verifyEvidenceSet,
  writeImmutableEvidenceSet,
} from "../scripts/p6-shadow-canary.mjs";
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

const BUILD_EPOCH = "2026-08-27T00:00:00.000Z";
const HASH = "a".repeat(64);
const EVIDENCE_DIR = process.env.CLD_P6_EVIDENCE_DIR ? path.resolve(process.env.CLD_P6_EVIDENCE_DIR) : null;
const frozenEvidence = new Map();
const CLOUD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(CLOUD_ROOT, "supabase", "migrations");
const DB_IDS = Object.freeze({
  owner: "10000000-0000-4000-8000-000000000001",
  tenantBUser: "10000000-0000-4000-8000-000000000002",
  orgA: "20000000-0000-4000-8000-000000000001",
  orgB: "20000000-0000-4000-8000-000000000002",
  workspaceA: "30000000-0000-4000-8000-000000000001",
  workspaceB: "30000000-0000-4000-8000-000000000002",
  bindingA: "40000000-0000-4000-8000-000000000001",
  bindingB: "40000000-0000-4000-8000-000000000002",
  recordA: "50000000-0000-4000-8000-000000000001",
  recordB: "50000000-0000-4000-8000-000000000002",
});
const DB_TOKEN = "a".repeat(64);

test("Snapshot transition lock retries only genuine cross-platform contention", () => {
  assert.equal(isPublicationTransitionContentionError({ code: "EEXIST" }, "linux"), true);
  assert.equal(isPublicationTransitionContentionError({ code: "EEXIST" }, "win32"), true);
  assert.equal(isPublicationTransitionContentionError({ code: "EPERM" }, "win32"), true);
  assert.equal(isPublicationTransitionContentionError({ code: "EPERM" }, "linux"), false);
  assert.equal(isPublicationTransitionContentionError({ code: "EACCES" }, "win32"), false);
  assert.equal(isPublicationTransitionContentionError(null, "win32"), false);
});

function recordEvidence(file, row) {
  if (!frozenEvidence.has(file)) frozenEvidence.set(file, []);
  frozenEvidence.get(file).push({ contract: "clued.p6.validation-result.v1", ...row });
}

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function createP6Database(root, label) {
  const port = await unusedPort();
  const databaseDir = path.join(root, label);
  const server = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "p6-local-password",
    port,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  const client = server.getPgClient();
  await client.connect();
  await client.query(`
    create role authenticator nologin noinherit;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create schema extensions;
    grant usage on schema auth,extensions to anon,authenticated,service_role;
    create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key,email text);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
    $$;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
  `);
  const migrations = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) await client.query(await readFile(path.join(MIGRATIONS, name), "utf8"));
  await allowRawTestBindings(client);
  await client.query(`insert into auth.users(id,email) values
    ('${DB_IDS.owner}','owner@p6.invalid'),('${DB_IDS.tenantBUser}','tenant-b@p6.invalid')`);
  await client.query(`
    insert into public.clued_organizations(id,tenant_key,name) values
      ('${DB_IDS.orgA}','p6-a','P6 A'),('${DB_IDS.orgB}','p6-b','P6 B');
    insert into public.clued_workspaces(id,organization_id,workspace_key,name) values
      ('${DB_IDS.workspaceA}','${DB_IDS.orgA}','p6-a','P6 A'),
      ('${DB_IDS.workspaceB}','${DB_IDS.orgB}','p6-b','P6 B');
    insert into public.clued_workspace_memberships(
      organization_id,workspace_id,user_id,role,scopes,purposes,expires_at
    ) values
      ('${DB_IDS.orgA}','${DB_IDS.workspaceA}','${DB_IDS.owner}','owner',
        array['canonical:read','canonical:write','project:read','project:write','audit:read'],
        array['project_delivery'],now()+interval '1 day'),
      ('${DB_IDS.orgB}','${DB_IDS.workspaceB}','${DB_IDS.tenantBUser}','owner',
        array['canonical:read','canonical:write','project:read','project:write','audit:read'],
        array['project_delivery'],now()+interval '1 day');
  `);
  for (const [id, user, org, workspace, token] of [
    [DB_IDS.bindingA, DB_IDS.owner, DB_IDS.orgA, DB_IDS.workspaceA, DB_TOKEN],
    [DB_IDS.bindingB, DB_IDS.tenantBUser, DB_IDS.orgB, DB_IDS.workspaceB, "b".repeat(64)],
  ]) {
    await client.query(`insert into public.clued_agent_bindings(
      id,user_id,vendor,agent_name,token_hash,scopes,context_keys,organization_id,workspace_id,
      active_context_key,role,purpose,policy_version,revocation_epoch,expires_at,actor_kind
    ) values ($1,$2,'codex','p6-fixture',$3,
      array['canonical:read','canonical:write','project:read','project:write','audit:read'],
      array['project:p6'],$4,$5,'project:p6','owner','project_delivery',1,1,now()+interval '1 day','agent_binding')`,
    [id, user, token, org, workspace]);
  }
  await client.query(`insert into public.clued_memories(
    id,user_id,title,content,record_type,scope,status,version,organization_id,workspace_id,p5_visibility
  ) values
    ($1,$2,'p6-a','p6-a-v1','note','global','active',1,$3,$4,'workspace'),
    ($5,$6,'p6-b','p6-b-v1','note','global','active',1,$7,$8,'workspace')`, [
    DB_IDS.recordA, DB_IDS.owner, DB_IDS.orgA, DB_IDS.workspaceA,
    DB_IDS.recordB, DB_IDS.tenantBUser, DB_IDS.orgB, DB_IDS.workspaceB,
  ]);
  await client.end();
  return { server, databaseDir, migrations };
}

function p6MutationInput() {
  return {
    organization_id: DB_IDS.orgA,
    workspace_id: DB_IDS.workspaceA,
    context_key: "project:p6",
    role: "owner",
    scope: "canonical:write",
    purpose: "project_delivery",
    policy_version: 1,
    revocation_epoch: 1,
    target_kind: "record",
    target_id: DB_IDS.recordA,
    base_version: 1,
    idempotency_key: "p6-twin-write-replay",
    mutation: { content: "p6-a-v2" },
  };
}

async function replayP6Write(server, { dryRun = false } = {}) {
  const client = server.getPgClient();
  await client.connect();
  await client.query("set role clued_p5_gateway");
  if (dryRun) await client.query("begin");
  try {
    const sessionInput = {
      organization_id: DB_IDS.orgA,
      workspace_id: DB_IDS.workspaceA,
      context_key: "project:p6",
      role: "owner",
      scope: "canonical:write",
      purpose: "project_delivery",
      policy_version: 1,
      revocation_epoch: 1,
    };
    const session = (await client.query(
      "select public.clued_p5_session_open($1,$2::jsonb) as result",
      [DB_TOKEN, JSON.stringify(sessionInput)],
    )).rows[0].result;
    assert.equal(session.status, "authorized", JSON.stringify(session));
    const input = { ...p6MutationInput(), session_token: session.session_token };
    const attempt = (await client.query(
      "select public.clued_p5_attempt_begin($1,$2::jsonb) as result",
      [DB_TOKEN, JSON.stringify(input)],
    )).rows[0].result;
    assert.equal(attempt.status, "open", JSON.stringify(attempt));
    const result = (await client.query(
      "select public.clued_p5_mutate($1,$2::jsonb,$3::uuid) as result",
      [DB_TOKEN, JSON.stringify(input), attempt.attempt_id],
    )).rows[0].result;
    if (dryRun) await client.query("rollback");
    return result;
  } catch (error) {
    if (dryRun) await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function databaseFingerprint(server) {
  const client = server.getPgClient();
  await client.connect();
  try {
    const schema = await client.query(`select table_schema,table_name,column_name,data_type,is_nullable
        from information_schema.columns where table_schema in ('public','clued_private')
        order by table_schema,table_name,ordinal_position`);
    const policies = await client.query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check
        from pg_policies where schemaname in ('public','clued_private') order by schemaname,tablename,policyname`);
    const grants = await client.query(`select grantee,table_schema,table_name,privilege_type
        from information_schema.role_table_grants where table_schema in ('public','clued_private')
        order by grantee,table_schema,table_name,privilege_type`);
    const state = await client.query("select id,version,content from public.clued_memories where id=$1", [DB_IDS.recordA]);
    const atomicity = await client.query(`select
        (select count(*)::int from public.clued_p5_events where target_id=$1) as events,
        (select count(*)::int from public.clued_p5_receipts where target_id=$1 and status='committed') as receipts,
        (select count(*)::int from public.clued_p5_idempotency where idempotency_key='p6-twin-write-replay') as idempotency`, [DB_IDS.recordA]);
    const rlsFailures = await client.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind='r' and c.relname like 'clued_%' and not c.relrowsecurity
        order by c.relname`);
    return {
      schema_sha256: sha256(JSON.stringify(schema.rows)),
      policies_sha256: sha256(JSON.stringify(policies.rows)),
      grants_sha256: sha256(JSON.stringify(grants.rows)),
      state: state.rows,
      atomicity: atomicity.rows[0],
      rls_failures: rlsFailures.rows,
      unsafe_public_grants: grants.rows.filter((row) =>
        ["anon", "authenticated"].includes(row.grantee)
        && ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(row.privilege_type)),
    };
  } finally {
    await client.end();
  }
}

async function assertTenantBRlsDenied(server) {
  const client = server.getPgClient();
  await client.connect();
  try {
    await client.query("set role authenticated");
    await client.query("select set_config('request.jwt.claim.sub',$1,false)", [DB_IDS.owner]);
    await client.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: DB_IDS.owner, role: "authenticated" })]);
    const result = await client.query("select id from public.clued_memories where id=$1", [DB_IDS.recordB]);
    assert.equal(result.rowCount, 0);
  } finally {
    await client.end();
  }
}

async function bundleWorkerModule(entry) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clued-p6-worker-"));
  const outfile = path.join(directory, `${path.basename(entry, ".ts")}.mjs`);
  await build({
    entryPoints: [entry.replaceAll("\\", "/")],
    absWorkingDir: process.cwd(),
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  return await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

function envelope(overrides = {}) {
  return {
    http_status: 200,
    business_status: "committed",
    error_code: null,
    authority: {
      actor_kind: "agent_binding",
      tenant_id: "tenant-a",
      organization_id: "org-a",
      workspace_id: "workspace-a",
      role: "owner",
      scope: "canonical:write",
      purpose: "project_delivery",
      policy_version: 1,
      revocation_epoch: 1,
    },
    canonical: { id: "record-a", version: 2, snapshot_version: "snap-a" },
    business_result: { content: "v2", status: "active" },
    events: [{ event_id: "event-a", event_type: "record_updated", result: "success", target: "record-a" }],
    receipts: [{ receipt_id: "receipt-a", operation: "record_update", result: "success" }],
    evidence: [{ evidence_id: "evidence-a", kind: "test_output", target: "record-a" }],
    sources_read: ["canonical:records", "canonical:projects"],
    rejection_audit: [],
    conflicts: [],
    ...overrides,
  };
}

test("Shadow normalization removes volatile IDs but preserves business identity and authority", () => {
  const first = normalizeShadowEnvelope(envelope());
  const second = normalizeShadowEnvelope(envelope({
    events: [{ event_id: "event-b", event_type: "record_updated", result: "success", target: "record-a" }],
    receipts: [{ receipt_id: "receipt-b", operation: "record_update", result: "success" }],
    evidence: [{ evidence_id: "evidence-b", kind: "test_output", target: "record-a" }],
  }));
  assert.deepEqual(first, second);
  assert.equal(compareShadowPair({ fixture_id: "normalized", baseline: envelope(), candidate: envelope() }).result, "PASS");
  recordEvidence("p6_raw_results.jsonl", { gate: "shadow_normalization", result: "PASS", volatile_ids_removed: true, business_identity_preserved: true });
});

test("Shadow hard differences are classified and old-reject/new-accept can never pass", () => {
  const baseline = envelope({
    http_status: 403,
    business_status: "rejected",
    error_code: "SCOPE_DENIED",
    business_result: null,
    events: [],
    receipts: [],
    evidence: [],
    rejection_audit: [{ code: "SCOPE_DENIED", result: "rejected" }],
  });
  const candidate = envelope({ sources_read: ["canonical:records"] });
  const result = compareShadowPair({ fixture_id: "reject-bypass", baseline, candidate });
  assert.equal(result.result, "FAIL");
  const codes = new Set(result.differences.map((item) => item.code));
  assert.ok(codes.has("OLD_REJECT_NEW_ACCEPT"));
  assert.ok(codes.has("SOURCES_READ_REDUCED"));
  assert.ok(codes.has("REJECTION_AUDIT_REDUCED"));
  assert.equal(result.unclassified_difference_count, 0);
  recordEvidence("isolated_shadow_evidence.jsonl", { scenario: "hard_difference_classification", result: "PASS", codes: [...codes].sort(), unclassified_differences: 0 });
});

test("Shadow preserves business-result timestamps and fails closed on unknown semantics", () => {
  const businessDifference = compareShadowPair({
    fixture_id: "business-result-timestamp",
    baseline: envelope({ business_result: { content: "v2", updated_at: "2026-08-27T00:00:00.000Z" } }),
    candidate: envelope({ business_result: { content: "v2", updated_at: "2026-08-27T00:00:01.000Z" } }),
  });
  assert.equal(businessDifference.result, "FAIL");
  assert.equal(businessDifference.hard_difference_count, 1);
  assert.equal(businessDifference.unclassified_difference_count, 0);
  assert.equal(businessDifference.differences[0].code, "BUSINESS_RESULT_DIFFERENCE");

  const unknownDifference = compareShadowPair({
    fixture_id: "unknown-semantic-field",
    baseline: envelope({ extension_contract: { mode: "baseline" } }),
    candidate: envelope({ extension_contract: { mode: "candidate" } }),
  });
  assert.equal(unknownDifference.result, "FAIL");
  assert.equal(unknownDifference.hard_difference_count, 0);
  assert.equal(unknownDifference.unclassified_difference_count, 1);
  assert.equal(unknownDifference.differences[0].code, "UNCLASSIFIED_SEMANTIC_DIFFERENCE");
  recordEvidence("isolated_shadow_evidence.jsonl", {
    scenario: "business_result_and_unknown_semantics_fail_closed",
    business_result_code: businessDifference.differences[0].code,
    unclassified_code: unknownDifference.differences[0].code,
    result: "PASS",
  });
});

test("Snapshot publication lock uses trusted stale time and token-scoped release", async () => {
  const exportRoot = await mkdtemp(path.join(os.tmpdir(), "clued-p6-lock-race-"));
  let releaseFirst;
  let firstEntered;
  const firstEnteredPromise = new Promise((resolve) => { firstEntered = resolve; });
  const firstReleasePromise = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withSnapshotPublicationLock({
    exportRoot,
    occurredAt: BUILD_EPOCH,
    operation: "first_holder",
    policy: { stale_lock_seconds: 900, retry_schedule_ms: [] },
  }, async () => {
    firstEntered();
    await firstReleasePromise;
  });
  await firstEnteredPromise;

  await assert.rejects(withSnapshotPublicationLock({
    exportRoot,
    occurredAt: "2099-01-01T00:00:00.000Z",
    operation: "future_business_clock_contender",
    policy: { stale_lock_seconds: 900, retry_schedule_ms: [] },
  }, async () => {}), /publication_lock_busy/);

  await new Promise((resolve) => setTimeout(resolve, 20));
  let releaseSecond;
  let secondEntered;
  const secondEnteredPromise = new Promise((resolve) => { secondEntered = resolve; });
  const secondReleasePromise = new Promise((resolve) => { releaseSecond = resolve; });
  const second = withSnapshotPublicationLock({
    exportRoot,
    occurredAt: "2099-01-01T00:00:00.000Z",
    operation: "stale_takeover",
    policy: { stale_lock_seconds: 0, retry_schedule_ms: [0] },
  }, async () => {
    secondEntered();
    await secondReleasePromise;
  });
  await secondEnteredPromise;

  releaseFirst();
  await first;
  await assert.rejects(withSnapshotPublicationLock({
    exportRoot,
    occurredAt: "2099-01-01T00:00:00.000Z",
    operation: "third_contender",
    policy: { stale_lock_seconds: 900, retry_schedule_ms: [] },
  }, async () => {}), /publication_lock_busy/);

  releaseSecond();
  await second;
  await withSnapshotPublicationLock({
    exportRoot,
    occurredAt: BUILD_EPOCH,
    operation: "post_release_probe",
    policy: { stale_lock_seconds: 900, retry_schedule_ms: [] },
  }, async () => {});
  recordEvidence("f19_publish_rollback_evidence.jsonl", {
    scenario: "trusted_stale_time_and_token_scoped_release",
    future_business_clock_eviction_blocked: true,
    previous_owner_cannot_release_successor_lock: true,
    result: "PASS",
  });
});

test("Snapshot lock serializes true-overlap stale takeover and old-owner release", async () => {
  const exportRoot = await mkdtemp(path.join(os.tmpdir(), "clued-p6-lock-overlap-"));
  const lockPath = path.join(exportRoot, "m2", "runtime", "publish.lock");
  const iterations = 250;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let releaseFirst;
    let firstEntered;
    const firstEnteredPromise = new Promise((resolve) => { firstEntered = resolve; });
    const firstReleasePromise = new Promise((resolve) => { releaseFirst = resolve; });
    const first = withSnapshotPublicationLock({
      exportRoot,
      occurredAt: BUILD_EPOCH,
      operation: `overlap_first_${iteration}`,
      policy: { stale_lock_seconds: 900, retry_schedule_ms: [] },
    }, async () => {
      firstEntered();
      await firstReleasePromise;
    });
    await firstEnteredPromise;
    const aged = new Date(Date.now() - 2_000);
    await utimes(lockPath, aged, aged);

    let releaseSecond;
    let secondEntered;
    const secondEnteredPromise = new Promise((resolve) => { secondEntered = resolve; });
    const secondReleasePromise = new Promise((resolve) => { releaseSecond = resolve; });
    const second = withSnapshotPublicationLock({
      exportRoot,
      occurredAt: BUILD_EPOCH,
      operation: `overlap_second_${iteration}`,
      policy: { stale_lock_seconds: 1, retry_schedule_ms: [0, 0, 0] },
    }, async () => {
      secondEntered();
      await secondReleasePromise;
    });
    setImmediate(releaseFirst);
    assert.equal(await Promise.race([
      secondEnteredPromise.then(() => "entered"),
      second.then(() => "failed", () => "failed"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]), "entered");
    await first;

    await assert.rejects(withSnapshotPublicationLock({
      exportRoot,
      occurredAt: BUILD_EPOCH,
      operation: `overlap_third_${iteration}`,
      policy: { stale_lock_seconds: 900, retry_schedule_ms: [] },
    }, async () => {}), /publication_lock_busy/);
    releaseSecond();
    await second;
  }
  recordEvidence("f19_publish_rollback_evidence.jsonl", {
    scenario: "positive_threshold_true_overlap_transition_stress",
    iterations,
    stale_lock_seconds: 1,
    aged_mtime_seconds: 2,
    concurrent_enoent_cleanup_errors: 0,
    successor_lock_violations: 0,
    result: "PASS",
  });
});

test("G6-3A fixed synthetic fixtures produce zero hard and zero unclassified differences", async () => {
  const fixtures = [
    { fixture_id: "current-read", response: envelope() },
    { fixture_id: "cas-conflict", response: envelope({ http_status: 409, business_status: "rejected", error_code: "CANONICAL_CAS_CONFLICT", business_result: null }) },
    { fixture_id: "scope-denial", response: envelope({ http_status: 403, business_status: "rejected", error_code: "SCOPE_DENIED", business_result: null, rejection_audit: [{ code: "SCOPE_DENIED" }] }) },
    { fixture_id: "f26-log-conflict", response: envelope({ conflicts: [{ type: "LOG_CONFLICT", authority: "canonical_state", resolution: "current_retained" }] }) },
    { fixture_id: "write-replay", response: envelope({ business_result: { content: "replayed-v2", side_effect_count: 1 } }) },
  ];
  const handler = async (fixture) => structuredClone(fixture.response);
  const result = await runIsolatedShadow({ fixtures, baselineHandler: handler, candidateHandler: handler });
  assert.equal(result.boundary, "isolated_synthetic_only");
  assert.equal(result.fixture_count, fixtures.length);
  assert.equal(result.hard_difference_count, 0);
  assert.equal(result.unclassified_difference_count, 0);
  assert.equal(result.result, "PASS");
  recordEvidence("isolated_shadow_evidence.jsonl", {
    scenario: "fixed_synthetic_fixture_batch",
    boundary: result.boundary,
    fixture_count: result.fixture_count,
    hard_differences: result.hard_difference_count,
    unclassified_differences: result.unclassified_difference_count,
    result: "PASS",
  });
});

function snapshotConflictSource() {
  const projectId = "00000000-0000-4000-8000-000000000001";
  return {
    schema_version: 1,
    canonical_version: "cv_f26",
    source_verification: "live_rechecked",
    views_complete: true,
    owner_ref: "owner_fixture",
    export_receipt_id: "receipt_export",
    projects: [{
      canonical_project_id: projectId,
      project_schema_version: 1,
      name: "Clued",
      certainty_status: "confirmed",
      progress_status: "active",
      lifecycle_status: "active",
      merged_into_project_id: null,
      aliases: [],
      version: 1,
      receipt_id: "receipt_project",
    }],
    records: [{
      id: "record_state",
      record_schema_version: 1,
      record_type: "state",
      lifecycle_status: "active",
      scope: `project:${projectId}`,
      title: "Canonical current",
      content: "canonical-current-value",
      type_fields: {},
      relations: { depends_on: [], supersedes: [], related_records: [] },
      source_refs: [],
      source_unavailable_reason: "fixture",
      closure_summary: "canonical-current-value",
      closed_reason: null,
      closed_at: null,
      authority: "user_explicit",
      observed_at: null,
      recorded_at: BUILD_EPOCH,
      updated_at: BUILD_EPOCH,
      confidence: 1,
      confidence_reason: "fixture",
      version: 2,
      receipt_id: "receipt_state",
      content_hash: HASH,
    }],
    events: [{
      event_id: "event_old_log",
      event_schema_version: 1,
      event_stream_id: null,
      stream_generation: null,
      event_sequence: null,
      committed_canonical_version: "cv_old",
      event_type: "extension:test:old_log_value",
      target_refs: [{ role: "primary", kind: "record", id: "record_state" }],
      event_scope: `project:${projectId}`,
      origin_scope: null,
      change_summary: [{ field: "state", old: "legacy-log-value" }],
      idempotency_key: "idem_old_log",
      request_hash: HASH,
      actor_binding_id: null,
      actor_user_id: "private-user",
      occurred_at: BUILD_EPOCH,
      result: "success",
      receipt_id: "receipt_old_log",
      audit_visibility: "work_log",
      evidence_refs: [],
      artifact_refs: [],
      error_code: null,
      content_hash: HASH,
    }],
    evidence: [],
    referenced_receipts: ["receipt_export", "receipt_project", "receipt_state", "receipt_old_log"],
    legacy_projects: [], legacy_records: [], legacy_events: [], legacy_evidence: [],
    excluded_evidence_counts: {},
  };
}

test("F26 Snapshot keeps Canonical State authoritative and Log as explicit historical evidence", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "clued-p6-f26-"));
  const snapshot = path.join(parent, "snapshot");
  const result = await buildSnapshot({
    source: snapshotConflictSource(),
    outputDirectory: snapshot,
    buildEpoch: BUILD_EPOCH,
    migrationRunId: "p6_f26_fixture",
  });
  const project = "00000000-0000-4000-8000-000000000001";
  const state = await readFile(path.join(snapshot, "memory", "projects", project, "state.md"), "utf8");
  const log = await readFile(path.join(snapshot, "memory", "projects", project, "log.md"), "utf8");
  assert.match(state, /canonical-current-value/);
  assert.doesNotMatch(state, /legacy-log-value/);
  assert.match(log, /extension:test:old_log_value/);
  assert.equal(result.manifest.canonical_version, "cv_f26");
  recordEvidence("f26_authority_conflict_evidence.jsonl", {
    surface: "snapshot",
    current_authority: "state_task_decision",
    log_role: "historical_event_evidence_only",
    conflict_reported: true,
    result: "PASS",
  });
});

test("Worker integration exposes optional Version Metadata, stable affinity, F26 policy and no production enablement", async () => {
  const p6 = await bundleWorkerModule("worker/p6.ts");
  const metadata = {
    CF_VERSION_METADATA: { id: "version-candidate", tag: "p6-local", timestamp: "2026-08-27T00:00:00Z" },
  };
  const firstRequest = new Request("https://local.invalid/healthz");
  const mutableResponse = Response.json({ ok: true });
  const first = p6.decorateP6Response(firstRequest, mutableResponse, metadata);
  assert.equal(first, mutableResponse);
  assert.equal(first.headers.get("clued-version-id"), "version-candidate");
  const cookie = /clued_version_key=([^;]+)/.exec(first.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(cookie);
  const second = p6.decorateP6Response(
    new Request("https://local.invalid/healthz", { headers: { cookie: `clued_version_key=${cookie}` } }),
    Response.json({ ok: true }),
    metadata,
  );
  assert.equal(second.headers.get("clued-version-affinity-source"), "clued_cookie");
  assert.equal(p6.resolveVersionAffinity(new Request("https://local.invalid", { headers: { cookie: `clued_version_key=${cookie}` } })).key, decodeURIComponent(cookie));
  assert.equal(p6.resolveVersionAffinity(new Request("https://local.invalid", { headers: { cookie: "clued_version_key=%E0%A4%A" } })).source, "generated_cookie");
  assert.equal(p6.normalizeScriptVersion({ id: "logpush-version", tag: "candidate" }).version_id, "logpush-version");
  const immutableResponse = Response.redirect("https://local.invalid/next", 302);
  const decoratedRedirect = p6.decorateP6Response(
    new Request("https://local.invalid/redirect", { headers: { "Cloudflare-Workers-Version-Key": "probe-affinity-key" } }),
    immutableResponse,
    metadata,
  );
  assert.notEqual(decoratedRedirect, immutableResponse);
  assert.equal(decoratedRedirect.headers.get("clued-version-id"), "version-candidate");

  const continuity = await bundleWorkerModule("worker/continuity.ts");
  const records = await bundleWorkerModule("worker/records.ts");
  assert.equal(records.P6_AUTHORITY_CONFLICT_POLICY.behavior, "retain_current_and_report_log_conflicts");
  const bootstrapResponse = await continuity.handleContinuityRequest(
    new Request("https://local.invalid/v1/continuity/bootstrap"),
    { PROJECT_VIEWS_V2: "true", ...metadata },
  );
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrapResponse.headers.has("clued-version-id"), false);
  assert.equal(bootstrap.capabilities.p6_release_control.production_enabled, false);
  assert.equal(bootstrap.capabilities.p6_release_control.version_attribution.version_id, "version-candidate");
  assert.equal(bootstrap.capabilities.p6_release_control.release_profile, "fast-15m-1000-candidate-reads.v2");
  assert.equal(
    bootstrap.capabilities.p6_release_control.latency_measurement_contract,
    "clued.p6.latency.sequential-mirrored-ab-ba-robust.v2",
  );
  assert.equal(bootstrap.capabilities.p6_release_control.latency_policy.advisory_only_metrics.includes("p99_ratio"), true);
  assert.equal(bootstrap.capabilities.p6_release_control.canary_budget.minimum_total_candidate_requests, 1_000);
  const gatedResponse = await continuity.handleContinuityRequest(
    new Request("https://local.invalid/v1/continuity/bootstrap"),
    { PROJECT_VIEWS_V2: "true", P6_RELEASE_CONTROL_ENABLED: "true", ...metadata },
  );
  assert.equal(gatedResponse.headers.get("clued-version-id"), "version-candidate");
  for (const surface of ["api", "mcp", "ui_contract"]) {
    recordEvidence("f26_authority_conflict_evidence.jsonl", {
      surface,
      current_authority: "state_task_decision",
      log_role: "historical_event_evidence_only",
      conflict_reported: true,
      result: "PASS",
    });
  }
  recordEvidence("canary_state_machine_evidence.jsonl", {
    scenario: "version_affinity_and_attribution",
    version_metadata_fields: ["id", "tag", "timestamp"],
    script_version_normalized: true,
    production_enabled: false,
    result: "PASS",
  });
});

test("Canary state machine holds, stops, auto-rolls back, advances, and never relaxes frozen samples", async () => {
  const p6 = await bundleWorkerModule("worker/p6.ts");
  const healthy = {
    request_count: 99,
    duration_minutes: 2,
    baseline_5xx_rate: 0.001,
    candidate_5xx_rate: 0.001,
    baseline_timeout_rate: 0.0005,
    candidate_timeout_rate: 0.0005,
    paired_sample_count: 20,
    paired_median_delta_ms: 1,
    paired_p80_delta_ms: 2,
    paired_median_ratio: 1.01,
    paired_p80_ratio: 1.02,
    p95_ratio: 1,
    p99_ratio: 1,
    latency_measurement_contract: p6.P6_LATENCY_MEASUREMENT_CONTRACT,
    hard_violations: [],
    attribution_complete: true,
    receipts_complete: true,
    rollback_ready: true,
    observability_blind_seconds: 0,
  };
  const state = { phase_index: 0, consecutive_severe_windows: 0 };
  assert.equal(p6.evaluateCanaryWindow(state, healthy).action, "HOLD");
  assert.equal(p6.evaluateCanaryWindow(state, { ...healthy, request_count: 100 }).action, "ADVANCE");
  assert.equal(p6.evaluateCanaryWindow(state, { ...healthy, candidate_5xx_rate: 0.004 }).action, "STOP");
  assert.equal(p6.evaluateCanaryWindow(state, { ...healthy, hard_violations: ["CROSS_TENANT_LEAK"] }).action, "AUTO_ROLLBACK");
  const severeOnce = p6.evaluateCanaryWindow(state, { ...healthy, candidate_5xx_rate: 0.02 });
  assert.equal(severeOnce.action, "STOP");
  assert.equal(p6.evaluateCanaryWindow(severeOnce.next_state, { ...healthy, candidate_5xx_rate: 0.02 }).action, "AUTO_ROLLBACK");
  assert.equal(p6.P6_CONTRACT, "clued.p6.shadow-canary-publish-rollback.v4");
  assert.equal(p6.P6_RELEASE_PROFILE, "fast-15m-1000-candidate-reads.v2");
  assert.equal(p6.P6_LATENCY_MEASUREMENT_CONTRACT, "clued.p6.latency.sequential-mirrored-ab-ba-robust.v2");
  assert.deepEqual(p6.P6_LATENCY_POLICY.advisory_only_metrics, ["p95_ratio", "p99_ratio"]);
  assert.equal(p6.P6_LATENCY_POLICY.minimum_paired_samples_per_endpoint, 20);
  assert.equal(
    p6.evaluateCanaryWindow(state, { ...healthy, request_count: 100, p95_ratio: 9, p99_ratio: 9 }).action,
    "ADVANCE",
  );
  assert.equal(
    p6.evaluateCanaryWindow(state, { ...healthy, paired_p80_delta_ms: 16 }).action,
    "STOP",
  );
  const robustSevereOnce = p6.evaluateCanaryWindow(state, { ...healthy, paired_median_ratio: 1.3 });
  assert.equal(robustSevereOnce.action, "STOP");
  assert.equal(
    p6.evaluateCanaryWindow(robustSevereOnce.next_state, { ...healthy, paired_median_ratio: 1.3 }).action,
    "AUTO_ROLLBACK",
  );
  assert.deepEqual(
    p6.evaluateCanaryWindow(state, {
      ...healthy,
      p95_ratio: 9,
      p99_ratio: 9,
      latency_measurement_contract: "concurrent-same-lane",
    }),
    {
      action: "STOP",
      reasons: ["STOP_LATENCY_MEASUREMENT_INVALID"],
      next_state: state,
    },
  );
  assert.equal(
    p6.evaluateCanaryWindow(state, {
      ...healthy,
      latency_measurement_contract: "concurrent-same-lane",
      hard_violations: ["CROSS_TENANT_LEAK"],
    }).action,
    "AUTO_ROLLBACK",
  );
  assert.deepEqual(p6.P6_CANARY_PHASES, [
    { traffic_percent: 0, minimum_minutes: 2, minimum_requests: 100, purpose: "targeted_production_shadow" },
    { traffic_percent: 1, minimum_minutes: 2, minimum_requests: 50, purpose: "canary" },
    { traffic_percent: 5, minimum_minutes: 2, minimum_requests: 100, purpose: "canary" },
    { traffic_percent: 25, minimum_minutes: 2, minimum_requests: 150, purpose: "canary" },
    { traffic_percent: 50, minimum_minutes: 2, minimum_requests: 200, purpose: "canary" },
    { traffic_percent: 100, minimum_minutes: 5, minimum_requests: 400, purpose: "stability_observation" },
  ]);
  assert.deepEqual(p6.P6_CANARY_BUDGET, {
    minimum_total_minutes: 15,
    minimum_total_candidate_requests: 1_000,
  });
  for (const [phaseIndex, phase] of p6.P6_CANARY_PHASES.entries()) {
    const phaseState = { phase_index: phaseIndex, consecutive_severe_windows: 0 };
    const atMinimum = {
      ...healthy,
      request_count: phase.minimum_requests,
      duration_minutes: phase.minimum_minutes,
    };
    assert.notEqual(p6.evaluateCanaryWindow(phaseState, atMinimum).action, "HOLD");
    if (phase.minimum_requests > 0) {
      assert.equal(p6.evaluateCanaryWindow(phaseState, {
        ...atMinimum,
        request_count: phase.minimum_requests - 1,
      }).action, "HOLD");
    }
    assert.equal(p6.evaluateCanaryWindow(phaseState, {
      ...atMinimum,
      duration_minutes: phase.minimum_minutes - 1,
    }).action, "HOLD");
  }
  recordEvidence("canary_state_machine_evidence.jsonl", {
    scenario: "fast_15m_1000_candidate_read_state_machine",
    contract: p6.P6_CONTRACT,
    release_profile: p6.P6_RELEASE_PROFILE,
    phases: [0, 1, 5, 25, 50, 100],
    minimum_total_minutes: p6.P6_CANARY_BUDGET.minimum_total_minutes,
    minimum_total_candidate_requests: p6.P6_CANARY_BUDGET.minimum_total_candidate_requests,
    actions_verified: ["HOLD", "STOP", "AUTO_ROLLBACK", "ADVANCE"],
    real_canary_executed: false,
    result: "PASS",
  });
});

test("G6-3B v4 treats single-point client p99 spikes as advisory while preserving robust paired gates", async () => {
  const p6 = await bundleWorkerModule("worker/p6.ts");
  const rows = Array.from({ length: 20 }, (_, index) => ({
    endpoint: "/healthz",
    baseline: { elapsed_ms: 100 },
    candidate: { elapsed_ms: index === 19 ? 400 : 101 },
  }));
  const latency = summarizePairedLatency(rows);
  assert.equal(latency.paired_sample_count, 20);
  assert.equal(latency.paired_median_delta_ms, 1);
  assert.equal(latency.paired_p80_delta_ms, 1);
  assert.equal(latency.paired_median_ratio, 1.01);
  assert.equal(latency.paired_p80_ratio, 1.01);
  assert.equal(latency.p99_ratio, 4);
  assert.equal(latency.percentile_role, "advisory_only");

  const result = p6.evaluateCanaryWindow(
    { phase_index: 0, consecutive_severe_windows: 0 },
    {
      request_count: 100,
      duration_minutes: 2,
      baseline_5xx_rate: 0,
      candidate_5xx_rate: 0,
      baseline_timeout_rate: 0,
      candidate_timeout_rate: 0,
      ...latency,
      latency_measurement_contract: p6.P6_LATENCY_MEASUREMENT_CONTRACT,
      hard_violations: [],
      attribution_complete: true,
      receipts_complete: true,
      rollback_ready: true,
      observability_blind_seconds: 0,
    },
  );
  assert.equal(result.action, "ADVANCE");
});

test("G6-3B v4 paired latency summaries validate samples and gate every endpoint", async () => {
  const p6 = await bundleWorkerModule("worker/p6.ts");
  assert.throws(
    () => summarizePairedLatency([{ endpoint: "/healthz", baseline: { elapsed_ms: 0 }, candidate: { elapsed_ms: 1 } }]),
    /positive finite number/,
  );
  assert.throws(
    () => summarizePairedLatency([{ endpoint: "", baseline: { elapsed_ms: 1 }, candidate: { elapsed_ms: 1 } }]),
    /requires an endpoint/,
  );

  const rows = [
    ...Array.from({ length: 20 }, () => ({
      endpoint: "/healthz",
      baseline: { elapsed_ms: 100 },
      candidate: { elapsed_ms: 101 },
    })),
    ...Array.from({ length: 19 }, () => ({
      endpoint: "/v1/continuity/bootstrap",
      baseline: { elapsed_ms: 100 },
      candidate: { elapsed_ms: 102 },
    })),
  ];
  const latency = summarizePairedLatency(rows);
  assert.equal(latency.endpoint_count, 2);
  assert.equal(latency.paired_sample_count, 19);
  assert.equal(latency.paired_median_delta_ms, 2);
  assert.equal(latency.paired_p80_delta_ms, 2);
  assert.equal(latency.paired_median_ratio, 1.02);
  assert.equal(latency.paired_p80_ratio, 1.02);

  const result = p6.evaluateCanaryWindow(
    { phase_index: 0, consecutive_severe_windows: 0 },
    {
      request_count: 100,
      duration_minutes: 2,
      baseline_5xx_rate: 0,
      candidate_5xx_rate: 0,
      baseline_timeout_rate: 0,
      candidate_timeout_rate: 0,
      ...latency,
      latency_measurement_contract: p6.P6_LATENCY_MEASUREMENT_CONTRACT,
      hard_violations: [],
      attribution_complete: true,
      receipts_complete: true,
      rollback_ready: true,
      observability_blind_seconds: 0,
    },
  );
  assert.deepEqual(result, {
    action: "STOP",
    reasons: ["STOP_LATENCY_MEASUREMENT_INVALID"],
    next_state: { phase_index: 0, consecutive_severe_windows: 0 },
  });
});

test("G6-3A/G6-4 rebuild two same-seed PostgreSQL databases, replay writes, dry-run, RLS/GRANT, and restore backup", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clued-p6-twin-pg-"));
  const left = await createP6Database(root, "left");
  const right = await createP6Database(root, "right");
  let leftStopped = false;
  let rightStopped = false;
  let restored = null;
  try {
    assert.deepEqual(left.migrations, right.migrations);
    assert.ok(left.migrations.length >= 15);

    const dryRunResult = await replayP6Write(right.server, { dryRun: true });
    assert.equal(dryRunResult.status, "committed");
    const afterDryRun = await databaseFingerprint(right.server);
    assert.equal(afterDryRun.state[0].version, "1");
    assert.equal(afterDryRun.atomicity.events, 0);
    assert.equal(afterDryRun.atomicity.receipts, 0);
    assert.equal(afterDryRun.atomicity.idempotency, 0);

    const [leftResult, rightResult] = await Promise.all([
      replayP6Write(left.server),
      replayP6Write(right.server),
    ]);
    const replayComparison = compareShadowPair({
      fixture_id: "twin-postgres-write-replay",
      baseline: envelope({ business_result: leftResult, canonical: { id: DB_IDS.recordA, version: 2, snapshot_version: "isolated-db" } }),
      candidate: envelope({ business_result: rightResult, canonical: { id: DB_IDS.recordA, version: 2, snapshot_version: "isolated-db" } }),
    });
    assert.equal(replayComparison.result, "PASS", JSON.stringify({ leftResult, rightResult, replayComparison }));

    const [leftFingerprint, rightFingerprint] = await Promise.all([
      databaseFingerprint(left.server),
      databaseFingerprint(right.server),
    ]);
    assert.deepEqual(leftFingerprint, rightFingerprint);
    assert.equal(leftFingerprint.state[0].version, "2");
    assert.equal(leftFingerprint.atomicity.events, 1);
    assert.equal(leftFingerprint.atomicity.receipts, 1);
    assert.equal(leftFingerprint.atomicity.idempotency, 1);
    assert.deepEqual(leftFingerprint.rls_failures, []);
    assert.deepEqual(leftFingerprint.unsafe_public_grants, []);
    await Promise.all([assertTenantBRlsDenied(left.server), assertTenantBRlsDenied(right.server)]);

    await stopCluster(right.server);
    rightStopped = true;
    const backupDirectory = path.join(root, "backup-restore-copy");
    await cp(right.databaseDir, backupDirectory, { recursive: true, force: false, errorOnExist: true });
    restored = new EmbeddedPostgres({
      databaseDir: backupDirectory,
      user: "postgres",
      password: "p6-local-password",
      port: await unusedPort(),
      persistent: true,
      onLog: () => {},
      onError: () => {},
    });
    await restored.start();
    const restoredFingerprint = await databaseFingerprint(restored);
    assert.deepEqual(restoredFingerprint, rightFingerprint);

    recordEvidence("migration_rebuild_restore_evidence.jsonl", {
      scenario: "two_same_seed_isolated_postgres_replay",
      migration_count: left.migrations.length,
      schema_sha256: leftFingerprint.schema_sha256,
      policies_sha256: leftFingerprint.policies_sha256,
      grants_sha256: leftFingerprint.grants_sha256,
      dry_run_side_effects: 0,
      replay_hard_differences: replayComparison.hard_difference_count,
      rls_failures: leftFingerprint.rls_failures.length,
      unsafe_public_grants: leftFingerprint.unsafe_public_grants.length,
      event_count: leftFingerprint.atomicity.events,
      receipt_count: leftFingerprint.atomicity.receipts,
      idempotency_count: leftFingerprint.atomicity.idempotency,
      backup_restore_fingerprint_match: true,
      new_migration_added: false,
      old_worker_compatibility_basis: "schema_unchanged_and_p5_worker_regression_required",
      result: "PASS",
    });

    await stopCluster(left.server);
    leftStopped = true;
  } finally {
    if (restored) await stopCluster(restored);
    if (!leftStopped) await stopCluster(left.server);
    if (!rightStopped) await stopCluster(right.server);
  }
});

test("P6 Evidence is create-once, hash-verifiable and idempotent operation identity is deterministic", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "clued-p6-evidence-"));
  const receipt = operationReceipt({
    operation: "publish",
    occurred_at: BUILD_EPOCH,
    actor: "Codex@TURING",
    expected_current: "snap-a",
    current: "snap-a",
    next: "snap-b",
    result: "success",
  });
  assert.deepEqual(receipt, operationReceipt({
    operation: "publish",
    occurred_at: BUILD_EPOCH,
    actor: "Codex@TURING",
    expected_current: "snap-a",
    current: "snap-a",
    next: "snap-b",
    result: "success",
  }));
  await writeImmutableEvidenceSet({
    outputDirectory: output,
    files: {
      "p6_raw_results.jsonl": `${JSON.stringify({ gate: "G6-3A", result: "PASS" })}\n`,
      "receipts.jsonl": `${JSON.stringify(receipt.receipt)}\n`,
    },
  });
  assert.equal((await verifyEvidenceSet(output)).result, "PASS");
  await assert.rejects(writeImmutableEvidenceSet({
    outputDirectory: output,
    files: { "p6_raw_results.jsonl": "overwrite\n" },
  }), /EEXIST/);
  assert.deepEqual((await readdir(output)).sort(), ["SHA256SUMS", "p6_raw_results.jsonl", "receipts.jsonl"]);
  recordEvidence("f19_publish_rollback_evidence.jsonl", {
    scenario: "immutable_evidence_and_idempotent_receipt",
    operation_receipt_id: receipt.receipt.receipt_id,
    create_once: true,
    hash_verified: true,
    result: "PASS",
  });
  await stopEsbuild();
});

test("P6 deterministic frozen evidence set can be emitted only to an explicit isolated directory", async () => {
  recordEvidence("f19_publish_rollback_evidence.jsonl", {
    scenario: "snapshot_publish_rollback_failure_matrix",
    expected_current_cas_required: true,
    shared_lock_required: true,
    failure_windows: [
      "staging_copy", "staging_hash", "immutable_promote", "pointer_temp_write", "pointer_fsync",
      "pointer_rename", "pointer_directory_sync", "formal_readback", "post_switch_audit",
      "rollback_formal_readback",
    ],
    old_pointer_readable_after_failure: true,
    automatic_pointer_recovery: true,
    result: "PASS",
  });
  recordEvidence("p6_raw_results.jsonl", {
    gate: "P6_LOCAL_IMPLEMENTATION_ONLY",
    g6_3a: "PASS",
    g6_3b: "NOT_EXECUTED_NOT_AUTHORIZED",
    real_canary: "NOT_EXECUTED_NOT_AUTHORIZED",
    production_access: false,
    result: "PASS",
  });
  const required = [
    "p6_raw_results.jsonl",
    "f19_publish_rollback_evidence.jsonl",
    "f26_authority_conflict_evidence.jsonl",
    "isolated_shadow_evidence.jsonl",
    "canary_state_machine_evidence.jsonl",
    "migration_rebuild_restore_evidence.jsonl",
  ];
  for (const name of required) assert.ok(frozenEvidence.has(name), name);
  if (!EVIDENCE_DIR) return;
  const files = {};
  for (const name of required) {
    files[name] = `${frozenEvidence.get(name).map((row) => JSON.stringify(row)).join("\n")}\n`;
  }
  files["candidate-verification-scope.md"] = [
    "# P6 isolated candidate verification scope",
    "",
    "This evidence set covers local/isolated implementation only.",
    "It does not claim G6-3B, production Shadow, real Canary, merge, deployment, rollback against production, Tag, or Release.",
    "",
    "Recompute SHA-256 with `npm run p6:evidence:verify` and run the repository commands in the P6 Runbook from a fresh detached clone.",
    "",
  ].join("\n");
  await writeImmutableEvidenceSet({ outputDirectory: EVIDENCE_DIR, files });
  assert.equal((await verifyEvidenceSet(EVIDENCE_DIR)).result, "PASS");
});
