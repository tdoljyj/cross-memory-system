import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = join(scriptDirectory, '..');
const repositoryDirectory = join(appDirectory, '..', '..');
const migrationsDirectory = join(appDirectory, 'supabase', 'migrations');
const migrationPathPrefix = 'apps/clued-cloud/supabase/migrations/';
const requiredKeys = ['global.priority_frontier', 'global.__aggregate__'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function git(args) {
  const run = spawnSync('git', args, { cwd: repositoryDirectory, encoding: 'utf8' });
  if (run.error || run.status !== 0) throw new Error(`git_${args[0]}_failed`);
  return run.stdout.trim();
}

export function verifyReleaseState({ baseline, sourceSql, history, changedPaths,
  migrationFiles, migrationSources = {}, frontierDefinition, watchdog,
  minHeartbeatAt = null, now = new Date() }) {
  const errors = [];
  if (sha256(sourceSql) !== baseline.source_sha256) errors.push('baseline_source_hash_changed');

  const migrationVersion = baseline.source_migration.slice(0, 14);
  const changedMigrationPaths = changedPaths.filter(({ path }) =>
    path.startsWith(migrationPathPrefix));
  for (const { status, path } of changedMigrationPaths) {
    const version = /^(\d{12,14})_/.exec(path.slice(migrationPathPrefix.length))?.[1];
    if (status !== 'A' || !version || version <= migrationVersion) {
      errors.push(`historical_migration_changed:${path}`);
    }
  }

  const rows = new Map(history.map((row) => [row.version, row]));
  for (const [version, name] of baseline.required_predecessors) {
    if (rows.get(version)?.name !== name) errors.push(`predecessor_missing:${version}`);
  }
  const applied = rows.get(baseline.production_history_version);
  if (applied?.name !== baseline.production_history_name ||
      applied?.statements?.length !== 1 ||
      applied.statements[0] !== sourceSql + baseline.production_statement_suffix) {
    errors.push('production_baseline_sql_mismatch');
  }
  const sourceVersionRow = rows.get(migrationVersion);
  if (sourceVersionRow && migrationVersion !== baseline.production_history_version) {
    errors.push('source_version_conflict');
  }

  for (const filename of migrationFiles) {
    const match = /^(\d{12,14})_(.+)\.sql$/.exec(filename);
    if (!match) {
      errors.push(`invalid_migration_filename:${filename}`);
      continue;
    }
    if (match[1] <= migrationVersion) continue;
    const matching = history.filter((row) => row.name === match[2]);
    const sql = migrationSources[filename];
    const acceptedStatements = typeof sql === 'string'
      ? [sql, sql + '\r\n', ...(sql.endsWith('\n') ? [sql.slice(0, -1)] : [])]
      : [];
    if (matching.length !== 1 || typeof sql !== 'string' ||
        matching[0].statements?.length !== 1 ||
        !acceptedStatements.includes(matching[0].statements[0])) {
      errors.push(`unapplied_or_mismatched_migration:${filename}`);
    }
  }

  if (typeof frontierDefinition !== 'string' ||
      !frontierDefinition.includes('clued_private.mtpe_snapshot(')) {
    errors.push('frontier_uses_old_selector');
  }
  if (!watchdog || typeof watchdog !== 'object') {
    errors.push('watchdog_unavailable');
  } else {
    const observedAt = Date.parse(watchdog.observed_at);
    const heartbeatAt = Date.parse(watchdog.heartbeat?.last_finished_at);
    if (!Number.isFinite(observedAt) || Math.abs(now.getTime() - observedAt) > 120_000) {
      errors.push('watchdog_snapshot_not_fresh');
    }
    if (!Number.isFinite(heartbeatAt) || now.getTime() - heartbeatAt > 180_000 ||
        heartbeatAt > now.getTime() + 10_000 ||
        watchdog.heartbeat?.last_result !== 'idle') {
      errors.push('worker_heartbeat_not_healthy');
    }
    if (minHeartbeatAt !== null && heartbeatAt <= Date.parse(minHeartbeatAt)) {
      errors.push('worker_has_not_run_after_deployment');
    }
    for (const key of requiredKeys) {
      const matching = Array.isArray(watchdog.projections)
        ? watchdog.projections.filter((row) => row.projection_key === key) : [];
      const row = matching[0];
      if (matching.length !== 1 || row.job_status !== 'completed' ||
          row.invalidation_revision !== row.resolved_through_revision ||
          row.stale_since !== null || row.source_digest_status !== 'match') {
        errors.push(`projection_not_current:${key}`);
      }
    }
  }
  return errors;
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: node scripts/production-release-gate.mjs --pre-deploy [--min-heartbeat-at ISO] [--evidence-out PATH]\n');
    return;
  }
  if (!process.argv.includes('--pre-deploy')) throw new Error('pre_deploy_mode_required');
  const heartbeatIndex = process.argv.indexOf('--min-heartbeat-at');
  const minHeartbeatAt = heartbeatIndex >= 0 ? process.argv[heartbeatIndex + 1] : null;
  if (heartbeatIndex >= 0 && !Number.isFinite(Date.parse(minHeartbeatAt))) {
    throw new Error('min_heartbeat_timestamp_invalid');
  }
  const dbUrl = process.env.CLUED_ATTESTATION_DATABASE_URL;
  if (!dbUrl) throw new Error('attestation_database_url_missing');
  const commit = git(['rev-parse', 'HEAD']);
  if (git(['status', '--porcelain'])) throw new Error('source_worktree_dirty');
  if (process.env.GITHUB_ACTIONS === 'true' &&
      (process.env.GITHUB_SHA !== commit || process.env.GITHUB_REF !== 'refs/heads/main')) {
    throw new Error('production_source_not_main_checkout');
  }
  if (process.env.GITHUB_ACTIONS !== 'true' &&
      git(['branch', '--show-current']) !== 'main') {
    throw new Error('production_source_not_main_checkout');
  }
  const baseline = JSON.parse(await readFile(join(scriptDirectory,
    'production-release-baseline.json'), 'utf8'));
  if (baseline.contract !== 'clued.production-release-baseline.v1') {
    throw new Error('release_baseline_contract_invalid');
  }
  const sourceSql = await readFile(join(migrationsDirectory, baseline.source_migration), 'utf8');
  const migrationFiles = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql'));
  const migrationSources = {};
  for (const filename of migrationFiles) {
    if (filename.slice(0, 14) > baseline.source_migration.slice(0, 14)) {
      migrationSources[filename] = await readFile(join(migrationsDirectory, filename), 'utf8');
    }
  }
  const diff = git(['diff', '--name-status', baseline.source_commit, commit, '--',
    migrationPathPrefix]);
  const changedPaths = diff ? diff.split('\n').map((line) => {
    const fields = line.split('\t');
    return { status: fields[0], path: fields.at(-1) };
  }) : [];

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  let history;
  let frontierDefinition;
  let watchdog;
  try {
    await client.query('begin read only');
    const listed = await client.query(
      'select version,name,statements from supabase_migrations.schema_migrations');
    history = listed.rows;
    const functionResult = await client.query(`select pg_get_functiondef(p.oid) as definition
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='clued_private' and p.proname='projection_refresh_frontier_apply'`);
    frontierDefinition = functionResult.rows.length === 1
      ? functionResult.rows[0].definition : null;
    const watchdogResult = await client.query(
      'select clued_watchdog.projection_watchdog_snapshot() as snapshot');
    watchdog = watchdogResult.rows[0]?.snapshot;
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }

  const errors = verifyReleaseState({ baseline, sourceSql, history, changedPaths,
    migrationFiles, migrationSources, frontierDefinition, watchdog, minHeartbeatAt });
  if (errors.length) throw new Error(`production_release_blocked:${errors.join(',')}`);
  const result = {
    status: 'passed', source_commit: commit,
    migration_source_sha256: sha256(sourceSql),
    production_history_version: baseline.production_history_version,
    checked_migration_count: migrationFiles.length,
    projection_revisions: requiredKeys.map((key) => {
      const row = watchdog.projections.find((candidate) => candidate.projection_key === key);
      return { projection_key: key, revision: row.invalidation_revision };
    }),
    heartbeat_finished_at: watchdog.heartbeat.last_finished_at,
    checked_at: new Date().toISOString(),
  };
  const evidenceIndex = process.argv.indexOf('--evidence-out');
  if (evidenceIndex >= 0) {
    const path = process.argv[evidenceIndex + 1];
    if (!path) throw new Error('evidence_path_required');
    await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const reason = error && typeof error.code === 'string'
      ? `production_release_blocked:${error.code}`
      : error instanceof Error && /^[a-z0-9_.,:/-]+$/i.test(error.message)
        ? error.message : 'production_release_blocked:unexpected_error';
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
  });
}
