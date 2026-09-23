import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { verifyReleaseState } from '../scripts/production-release-gate.mjs';

const baseline = JSON.parse(await readFile(new URL(
  '../scripts/production-release-baseline.json', import.meta.url), 'utf8'));
const sourceSql = await readFile(new URL(
  `../supabase/migrations/${baseline.source_migration}`, import.meta.url), 'utf8');
const migrationFiles = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
  .filter((name) => name.endsWith('.sql'));
const now = new Date('2026-09-23T05:12:49Z');

function healthy() {
  return {
    baseline, sourceSql, migrationFiles, changedPaths: [], now,
    history: [
      ...baseline.required_predecessors.map(([version, name]) => ({ version, name })),
      { version: baseline.production_history_version,
        name: baseline.production_history_name,
        statements: [sourceSql + baseline.production_statement_suffix] },
    ],
    frontierDefinition: 'select clued_private.mtpe_snapshot(p_binding.user_id)',
    watchdog: {
      observed_at: '2026-09-23T05:12:49Z',
      heartbeat: { last_result: 'idle', last_finished_at: '2026-09-23T05:11:59Z' },
      projections: [
        { projection_key: 'global.priority_frontier', job_status: 'completed',
          invalidation_revision: 94, resolved_through_revision: 94,
          stale_since: null, source_digest_status: 'match' },
        { projection_key: 'global.__aggregate__', job_status: 'completed',
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
  state.history.at(-1).statements = ['-- unrelated SQL'];
  state.migrationFiles = [...state.migrationFiles,
    '20260925120000_followup.sql'];
  state.migrationSources = { '20260925120000_followup.sql': 'select 1;' };
  assert.deepEqual(verifyReleaseState(state), [
    'production_baseline_sql_mismatch',
    'unapplied_or_mismatched_migration:20260925120000_followup.sql',
  ]);
});

test('a newly applied migration may have a generated production version only when name and SQL match', () => {
  const state = healthy();
  state.migrationFiles = [...state.migrationFiles, '20260925120000_followup.sql'];
  state.migrationSources = { '20260925120000_followup.sql': 'select 1;' };
  state.changedPaths = [{ status: 'A', path:
    'apps/clued-cloud/supabase/migrations/20260925120000_followup.sql' }];
  state.history.push({ version: '20260923060000', name: 'followup',
    statements: ['select 1;\r\n'] });
  assert.deepEqual(verifyReleaseState(state), []);
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

test('post-deploy readback requires a heartbeat from the newly deployed cycle', () => {
  const state = healthy();
  state.minHeartbeatAt = '2026-09-23T05:12:00Z';
  assert.deepEqual(verifyReleaseState(state), [
    'worker_has_not_run_after_deployment',
  ]);
});
