import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { baselineVersion, evaluateLedger, historyOnlyDirectory, readLedger, readSqlDirectory }
  from './migration-ledger.mjs';

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
  migrationFiles, migrationSources = {}, frontierDefinition }) {
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
  return errors;
}

const snapshotQuery = 'select clued_watchdog.projection_watchdog_snapshot() as snapshot';
const backlogLimitMs = 5 * 60_000;
const pollMs = 10_000;
const waitLimitMs = 3 * 60_000;

function projectionFinding(row, now) {
  if (typeof row.tenant_key !== 'string' || !/^[a-f0-9]{64}$/.test(row.tenant_key)) return 'projection_not_current';
  if (row.job_status === 'failed') return 'projection_job_failed';
  if (row.source_digest_status === 'mismatch') return 'projection_digest_mismatch';
  const { invalidation_revision: revision, resolved_through_revision: resolved } = row;
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(resolved) ||
      resolved < 0 || revision < resolved) return 'projection_not_current';
  if (revision === resolved) {
    return row.source_digest_status === 'match' && row.stale_since === null
      ? null : 'projection_not_current';
  }
  const age = now - Date.parse(row.stale_since);
  if (!Number.isFinite(age) || age < 0 || row.source_digest_status !== 'not_applicable') {
    return 'projection_not_current';
  }
  return age >= backlogLimitMs ? 'projection_backlog_overdue' : 'projection_backlog_pending';
}

function inspectSnapshot(watchdog, now) {
  const findings = new Set();
  const revisions = [];
  if (!Array.isArray(watchdog?.projections)) {
    return { error: 'watchdog_unavailable', findings: [], revisions };
  }
  const observedAt = Date.parse(watchdog.observed_at);
  if (!Number.isFinite(observedAt) || Math.abs(now - observedAt) > 120_000) {
    return { error: 'watchdog_snapshot_not_fresh', findings: [], revisions };
  }
  for (const key of requiredKeys) {
    const served = watchdog.projections.filter(row => row?.projection_key === key && row.builder_served === true);
    if (!served.length || new Set(served.map(row => row.tenant_key)).size !== served.length) {
      findings.add('projection_not_current:' + key);
    }
    for (const row of served) {
      const finding = projectionFinding(row, now);
      if (finding) findings.add(finding + ':' + key);
      revisions.push({ projection_key: key, tenant_key: row.tenant_key, revision: row.invalidation_revision,
        resolved_through_revision: row.resolved_through_revision, stale_since: row.stale_since,
        job_status: row.job_status, source_digest_status: row.source_digest_status });
    }
  }
  return { error: null, observedAt: watchdog.observed_at, findings: [...findings], revisions };
}

export async function settleProjectionLag({ watchdog, readWatchdog, now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  const deadline = now() + waitLimitMs;
  let state = inspectSnapshot(watchdog, now());
  while (!state.error && state.findings.length &&
      state.findings.every(reason => reason.startsWith('projection_backlog_pending:'))) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMs, remaining));
    const next = await readWatchdog();
    state = inspectSnapshot(next, now());
  }
  return state;
}

async function readWatchdog(dbUrl) {
  const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  await client.connect();
  try {
    const result = await client.query(snapshotQuery);
    return result.rows[0]?.snapshot;
  } finally {
    await client.end();
  }
}

async function main() {
  const { values: args } = parseArgs({ options: {
    'pre-deploy': { type: 'boolean' }, 'post-deploy': { type: 'boolean' },
    'evidence-out': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (args.help) {
    process.stdout.write('Usage: node scripts/production-release-gate.mjs (--pre-deploy | --post-deploy) [--evidence-out PATH]\n');
    return;
  }
  if (Boolean(args['pre-deploy']) === Boolean(args['post-deploy'])) throw new Error('one_deploy_mode_required');
  const mode = args['post-deploy'] ? 'post-deploy' : 'pre-deploy';
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
    const watchdogResult = await client.query(snapshotQuery);
    watchdog = watchdogResult.rows[0]?.snapshot;
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
  // The committed ledger must be valid against this checkout, and production
  // history must be the ledger (docs/maintenance/migration-ledger.md): every
  // row up to history_through, with its recorded text, and no row the
  // repository cannot account for. A newer row exactly as migrate mode records
  // it for a pending file is reported, not blocked.
  const ledger = await readLedger();
  const ledgerReport = evaluateLedger({ ledger, history,
    migrations: await readSqlDirectory(migrationsDirectory),
    historyOnly: await readSqlDirectory(historyOnlyDirectory),
    historicalThrough: baselineVersion(baseline) });
  for (const filename of ledgerReport.pending) {
    process.stderr.write(`pending migration (not in the ledger yet): ${filename}\n`);
  }
  for (const warning of ledgerReport.warnings) process.stderr.write(`::warning::${warning}\n`);
  if (ledgerReport.missingRows.length) {
    process.stderr.write('rows to add to supabase/ledger/production-history.json:\n' +
      `${JSON.stringify(ledgerReport.missingRows, null, 2)}\n`);
  }
  // Ledger errors can carry production row names; print each one so a name
  // the final message cannot hold does not hide the others.
  for (const error of ledgerReport.errors) process.stderr.write(`ledger: ${error}\n`);
  const errors = [...verifyReleaseState({ baseline, sourceSql, history, changedPaths,
    migrationFiles, migrationSources, frontierDefinition }), ...ledgerReport.errors];
  const requireCurrentProjections = mode === 'post-deploy';
  const state = requireCurrentProjections && errors.length === 0
    ? await settleProjectionLag({ watchdog, readWatchdog: () => readWatchdog(dbUrl) })
    : inspectSnapshot(watchdog, Date.now());
  if (state.error) errors.push(state.error);
  if (requireCurrentProjections) errors.push(...state.findings);
  const warnings = requireCurrentProjections ? [] : state.findings;
  for (const warning of warnings) process.stderr.write('::warning::' + warning + '\n');
  if (errors.length) throw new Error(`production_release_blocked:${errors.join(',')}`);
  const result = {
    status: 'passed', source_commit: commit,
    migration_source_sha256: sha256(sourceSql),
    production_history_version: baseline.production_history_version,
    checked_migration_count: migrationFiles.length,
    migration_ledger_rows: ledger.rows.length,
    migration_ledger_rows_to_add: ledgerReport.missingRows.length,
    mode, projection_observed_at: state.observedAt,
    projection_revisions: state.revisions, warnings,
    checked_at: new Date().toISOString(),
  };
  if (args['evidence-out'] !== undefined) {
    await writeFile(args['evidence-out'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
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
