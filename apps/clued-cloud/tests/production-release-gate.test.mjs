import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { builderRunInProgress, verifyReleaseState } from '../scripts/production-release-gate.mjs';

const baseline = JSON.parse(await readFile(new URL(
  '../scripts/production-release-baseline.json', import.meta.url), 'utf8'));
const sourceSql = await readFile(new URL(
  `../supabase/migrations/${baseline.source_migration}`, import.meta.url), 'utf8');
const migrationFiles = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
  .filter((name) => name.endsWith('.sql'));
const postBaselineMigrationFiles = migrationFiles.filter((name) =>
  name.slice(0, 14) > baseline.source_migration.slice(0, 14));
const postBaselineMigrationSources = Object.fromEntries(await Promise.all(
  postBaselineMigrationFiles.map(async (name) => [name, await readFile(new URL(
    `../supabase/migrations/${name}`, import.meta.url), 'utf8')])));
const productionWorkflow = await readFile(new URL(
  '../../../.github/workflows/clued-cloud-production-release.yml', import.meta.url), 'utf8');
const now = new Date('2026-09-23T05:12:49Z');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);

function healthy() {
  return {
    baseline, sourceSql, migrationFiles,
    migrationSources: { ...postBaselineMigrationSources }, changedPaths: [], now,
    history: [
      ...baseline.required_predecessors.map(([version, name]) => ({ version, name })),
      { version: baseline.production_history_version,
        name: baseline.production_history_name,
        statements: [sourceSql + baseline.production_statement_suffix] },
      ...postBaselineMigrationFiles.map((filename) => ({
        version: filename.slice(0, 14),
        name: filename.slice(15, -4),
        statements: [postBaselineMigrationSources[filename]],
      })),
    ],
    frontierDefinition: 'select clued_private.mtpe_snapshot(p_binding.user_id)',
    watchdog: {
      observed_at: '2026-09-23T05:12:49Z',
      heartbeat: { last_result: 'idle', last_finished_at: '2026-09-23T05:11:59Z' },
      projections: [
        { tenant_key: OWNER, builder_served: true,
          projection_key: 'global.priority_frontier', job_status: 'completed',
          invalidation_revision: 94, resolved_through_revision: 94,
          stale_since: null, source_digest_status: 'match' },
        { tenant_key: OWNER, builder_served: true,
          projection_key: 'global.__aggregate__', job_status: 'completed',
          invalidation_revision: 181, resolved_through_revision: 181,
          stale_since: null, source_digest_status: 'match' },
      ],
    },
  };
}

test('production release accepts the verified 2026-09-23 migration alias and current projections', () => {
  assert.deepEqual(verifyReleaseState(healthy()), []);
});

test('release refuses an alias with different SQL or a second migration with missing history', () => {
  const state = healthy();
  state.history.find((row) => row.version === baseline.production_history_version)
    .statements = ['-- unrelated SQL'];
  state.migrationFiles = [...state.migrationFiles,
    '20260925120000_followup.sql'];
  state.migrationSources = { ...state.migrationSources,
    '20260925120000_followup.sql': 'select 1;' };
  assert.deepEqual(verifyReleaseState(state), [
    'production_baseline_sql_mismatch',
    'unapplied_or_mismatched_migration:20260925120000_followup.sql',
  ]);
});

test('a newly applied migration may have a generated production version only when name and SQL match', () => {
  const state = healthy();
  state.migrationFiles = [...state.migrationFiles, '20260925120000_followup.sql'];
  state.migrationSources = { ...state.migrationSources,
    '20260925120000_followup.sql': 'select 1;' };
  state.changedPaths = [{ status: 'A', path:
    'apps/clued-cloud/supabase/migrations/20260925120000_followup.sql' }];
  state.history.push({ version: '20260923060000', name: 'followup',
    statements: ['select 1;\r\n'] });
  assert.deepEqual(verifyReleaseState(state), []);
});

test('migration history may omit exactly one terminal LF recorded by the migration runner', () => {
  const state = healthy();
  state.migrationFiles = [...state.migrationFiles, '20260925120000_followup.sql'];
  state.migrationSources = { ...state.migrationSources,
    '20260925120000_followup.sql': 'select 1;\n' };
  state.changedPaths = [{ status: 'A', path:
    'apps/clued-cloud/supabase/migrations/20260925120000_followup.sql' }];
  state.history.push({ version: '20260923060000', name: 'followup',
    statements: ['select 1;'] });
  assert.deepEqual(verifyReleaseState(state), []);
});

test('release refuses a duplicate source-version migration row even with the expected name', () => {
  const state = healthy();
  state.history.push({ version: baseline.source_migration.slice(0, 14),
    name: baseline.production_history_name, statements: ['-- different SQL'] });
  assert.deepEqual(verifyReleaseState(state), ['source_version_conflict']);
});

test('release refuses changed historical migrations and the old frontier selector', () => {
  const state = healthy();
  state.changedPaths = [{ status: 'M', path:
    'apps/clued-cloud/supabase/migrations/20260924110000_mtpe_universal_intake_auto_priority.sql' }];
  state.frontierDefinition = 'select old_unique_now_task()';
  assert.deepEqual(verifyReleaseState(state), [
    'historical_migration_changed:apps/clued-cloud/supabase/migrations/20260924110000_mtpe_universal_intake_auto_priority.sql',
    'frontier_uses_old_selector',
  ]);
});

test('release refuses stale projections and a cycle-limited heartbeat', () => {
  const state = healthy();
  state.watchdog.heartbeat.last_result = 'cycle_limit';
  state.watchdog.projections[0].resolved_through_revision = 90;
  assert.deepEqual(verifyReleaseState(state), [
    'worker_heartbeat_not_healthy',
    'projection_not_current:global.priority_frontier',
  ]);
});

test('release checks only tenants the Builder serves and fails closed without one', () => {
  const unserved = (key) => ({ tenant_key: OTHER, builder_served: false, projection_key: key,
    job_status: 'queued', invalidation_revision: 4, resolved_through_revision: 0,
    stale_since: '2026-09-23T05:00:00Z', source_digest_status: 'not_applicable' });
  const state = healthy();
  state.watchdog.projections.push(unserved('global.priority_frontier'), unserved('global.__aggregate__'));
  assert.deepEqual(verifyReleaseState(state), []);

  const servedStale = healthy();
  servedStale.watchdog.projections.push({ ...unserved('global.__aggregate__'), builder_served: true });
  assert.deepEqual(verifyReleaseState(servedStale), ['projection_not_current:global.__aggregate__']);

  const duplicate = healthy();
  duplicate.watchdog.projections.push({ ...duplicate.watchdog.projections[0] });
  assert.deepEqual(verifyReleaseState(duplicate), ['projection_not_current:global.priority_frontier']);

  const legacySnapshot = healthy();
  for (const row of legacySnapshot.watchdog.projections) delete row.builder_served;
  assert.deepEqual(verifyReleaseState(legacySnapshot), [
    'projection_not_current:global.priority_frontier',
    'projection_not_current:global.__aggregate__',
  ]);
});

test('a Builder run in progress is waited out, never accepted as healthy', () => {
  // Release run 36656117945 read the heartbeat while the per-minute run was active.
  const running = { heartbeat: { last_result: 'running',
    last_started_at: '2026-09-23T05:12:48Z', last_finished_at: '2026-09-23T05:11:59Z' } };
  assert.equal(builderRunInProgress(running, now), true);
  const state = healthy();
  state.watchdog.heartbeat = { ...running.heartbeat };
  assert.deepEqual(verifyReleaseState(state), ['worker_heartbeat_not_healthy']);

  const stuck = { heartbeat: { ...running.heartbeat, last_started_at: '2026-09-23T05:10:40Z' } };
  assert.equal(builderRunInProgress(stuck, now), false);
  const future = { heartbeat: { ...running.heartbeat, last_started_at: '2026-09-23T05:13:10Z' } };
  assert.equal(builderRunInProgress(future, now), false);
  for (const last_result of ['idle', 'exception', 'cycle_limit']) {
    assert.equal(builderRunInProgress({ heartbeat: { ...running.heartbeat, last_result } }, now), false);
  }
  assert.equal(builderRunInProgress(undefined, now), false);
  assert.equal(builderRunInProgress({ heartbeat: { last_result: 'running' } }, now), false);
});

test('post-deploy readback requires a heartbeat from the newly deployed cycle', () => {
  const state = healthy();
  state.minHeartbeatAt = '2026-09-23T05:12:00Z';
  assert.deepEqual(verifyReleaseState(state), [
    'worker_has_not_run_after_deployment',
  ]);
});

test('production backup mode encrypts and verifies the dump before removing plaintext', () => {
  assert.match(productionWorkflow, /backup_only:/);
  assert.match(productionWorkflow, /CLUED_PRODUCTION_BACKUP_KEY/);
  assert.match(productionWorkflow, /--user \"\$\(id -u\):\$\(id -g\)\"/);
  assert.match(productionWorkflow, /searchParams\.delete\(\"uselibpqcompat\"\)/);
  assert.match(productionWorkflow, /-e DATABASE_URL=\"\$database_url\"/);
  assert.match(productionWorkflow, /pg_restore --list/);
  assert.match(productionWorkflow, /openssl enc -aes-256-cbc -pbkdf2/);
  assert.match(productionWorkflow, /openssl enc -d -aes-256-cbc -pbkdf2/);
  assert.match(productionWorkflow, /shred -u \"\$dump_path\" \"\$verified_path\"/);
  assert.match(productionWorkflow, /clued-production-pre-migration\.dump\.enc/);
  assert.doesNotMatch(productionWorkflow,
    /release-evidence\/clued-production-pre-migration\.dump\s*$/m);
});
