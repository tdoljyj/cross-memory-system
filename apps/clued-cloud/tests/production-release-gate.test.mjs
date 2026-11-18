import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as gate from '../scripts/production-release-gate.mjs';
import { settleProjectionLag, verifyReleaseState } from '../scripts/production-release-gate.mjs';

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

test('release CLI checks projection state before and after deployment', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'release-gate-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  const app = path.join(root, 'apps/clued-cloud');
  const scripts = path.join(app, 'scripts');
  const migrations = path.join(app, 'supabase/migrations');
  const ledger = path.join(app, 'supabase/ledger');
  const pg = path.join(app, 'node_modules/pg');
  for (const dir of [scripts, migrations, path.join(ledger, 'history-only'), pg]) {
    await mkdir(dir, { recursive: true });
  }
  for (const name of ['production-release-gate.mjs', 'migration-ledger.mjs']) {
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(scripts, name));
  }
  await copyFile(new URL('./fixtures/production-release-pg.mjs', import.meta.url), path.join(pg, 'index.mjs'));
  const json = (file, value) => writeFile(file, JSON.stringify(value));
  await json(path.join(pg, 'package.json'), { main: 'index.mjs' });
  const git = (...args) => {
    const run = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const version = '20260101000000', name = 'bootstrap', sql = 'select 1;\n';
  const filename = `${version}_${name}.sql`;
  await writeFile(path.join(migrations, filename), sql);
  const wranglerConfig = path.join(app, 'wrangler.production.jsonc');
  await json(wranglerConfig, { name: 'clued-cloud', triggers: { crons: ['*/10 * * * *'] } });
  git('init', '-b', 'main');
  git('add', '--force', '.');
  git('commit', '-qm', 'Create migration fixture');
  await json(path.join(scripts, 'production-release-baseline.json'), {
    contract: baseline.contract, source_commit: git('rev-parse', 'HEAD'), source_migration: filename,
    source_sha256: createHash('sha256').update(sql).digest('hex'), required_predecessors: [],
    production_history_version: version, production_history_name: name, production_statement_suffix: '',
  });
  await json(path.join(ledger, 'production-history.json'), {
    contract: 'clued.production-migration-ledger.v1', history_through: version, row_count: 1,
    rows: [{ version, name, source: 'migrations/' + filename, transform: 'identical',
      statements_md5: createHash('md5').update(sql).digest('hex') }],
  });
  git('add', '.');
  git('commit', '-qm', 'Record release baseline and ledger');
  const db = path.join(temp, 'fixture.json');
  const reads = path.join(temp, 'reads');
  const clients = path.join(temp, 'clients');
  const evidence = path.join(temp, 'evidence.json');
  const key = 'global.priority_frontier';
  const history = [{ version, name, statements: [sql] }];
  const frontier = 'select clued_private.mtpe_snapshot()';
  const current = () => ({ ...healthy().watchdog, observed_at: new Date().toISOString(), heartbeat: null });
  const lag = (age, patch = {}) => {
    const snapshot = current();
    Object.assign(snapshot.projections[0], { invalidation_revision: 95, job_status: 'queued',
      stale_since: new Date(Date.now() - age).toISOString(), source_digest_status: 'not_applicable', ...patch });
    return snapshot;
  };
  const run = async (mode, snapshots, overrides = {}) => {
    await rm(evidence, { force: true });
    await writeFile(reads, '');
    await writeFile(clients, '');
    await json(db, { history, frontier, snapshots, reads, clients, ...overrides });
    const result = spawnSync(process.execPath, [path.join(scripts, 'production-release-gate.mjs'),
      mode, '--evidence-out', evidence], { cwd: app, encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, CLUED_ATTESTATION_DATABASE_URL: db, GITHUB_ACTIONS: 'true',
        GITHUB_SHA: git('rev-parse', 'HEAD'), GITHUB_REF: 'refs/heads/main' } });
    assert.ifError(result.error);
    return { ...result, reads: (await readFile(reads, 'utf8')).trim().split('\n').filter(Boolean).map(Number),
      clients: (await readFile(clients, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
      receipt: result.status === 0 ? JSON.parse(await readFile(evidence, 'utf8')) : null };
  };
  const passed = result => assert.equal(result.status, 0, result.stderr);
  const blocked = (result, reason) => {
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(reason), result.stderr);
  };
  await t.test('部署前接受缺失与陈旧的心跳', async () => {
    for (const heartbeat of [null, { last_result: 'idle', last_finished_at: now.toISOString() }]) {
      const result = await run('--pre-deploy', [{ ...current(), heartbeat }]);
      passed(result);
      assert.deepEqual(result.receipt.warnings, []);
      assert.equal(result.reads.length, 1);
    }
  });
  await t.test('部署后投影追平且无心跳，立即通过', async () => {
    const snapshot = current();
    delete snapshot.heartbeat;
    snapshot.projections.unshift({ ...snapshot.projections[0], tenant_key: OTHER,
      builder_served: false, job_status: 'failed', invalidation_revision: 999 });
    const result = await run('--post-deploy', [snapshot]);
    passed(result);
    assert.equal(result.reads.length, 1);
    assert.equal(result.receipt.projection_revisions.length, 2);
    assert.deepEqual(result.receipt.projection_revisions.map(row => row.revision), [94, 181]);
    assert.ok(!JSON.stringify(result.receipt).includes('heartbeat'));
  });
  await t.test('部署后积压三十秒，十秒后原心跳下读取到追平状态', async () => {
    const result = await run('--post-deploy', [lag(30_000), current()]);
    passed(result);
    assert.equal(result.reads.length, 2);
    assert.ok(result.reads[1] - result.reads[0] >= 9900);
    assert.equal(result.receipt.projection_revisions[0].revision, 94);
  });
  await t.test('部署后积压超过五分钟仍在 Cron 一拍内继续等，下一帧追平即通过', async () => {
    const result = await run('--post-deploy', [lag(301_000), current()]);
    passed(result);
    assert.equal(result.reads.length, 2);
  });
  await t.test('数据库连接与查询都有客户端超时，挂起的连接不能耗尽回滚窗口', async () => {
    for (const mode of ['--pre-deploy', '--post-deploy']) {
      const result = await run(mode, [lag(30_000), current()]);
      passed(result);
      assert.ok(result.clients.length >= 1, mode);
      for (const options of result.clients) {
        assert.ok(options.connectionTimeoutMillis > 0 && options.query_timeout > 0, `${mode}: ${JSON.stringify(options)}`);
      }
    }
  });
  await t.test('Cron 不是 */N * * * * 时两种模式都在读数据库前阻断', async () => {
    for (const crons of [['0 * * * *'], ['*/10 * * * *', '*/5 * * * *'], [], ['*/0 * * * *']]) {
      await json(wranglerConfig, { name: 'clued-cloud', triggers: { crons } });
      git('commit', '-qam', 'Change the schedule');
      for (const mode of ['--pre-deploy', '--post-deploy']) {
        const result = await run(mode, [current()]);
        blocked(result, 'cron_schedule_unsupported');
        assert.equal(result.reads.length, 0, `${mode} ${JSON.stringify(crons)}`);
      }
    }
    await json(wranglerConfig, { name: 'clued-cloud', triggers: { crons: ['*/10 * * * *'] } });
    git('commit', '-qam', 'Restore the schedule');
    passed(await run('--pre-deploy', [current()]));
  });
  await t.test('部署后任务失败、摘要不符分别立即阻断', async () => {
    for (const [snapshot, code] of [
      [lag(30_000, { job_status: 'failed' }), 'projection_job_failed'],
      [current(), 'projection_digest_mismatch'],
    ]) {
      if (code === 'projection_digest_mismatch') snapshot.projections[0].source_digest_status = 'mismatch';
      const result = await run('--post-deploy', [snapshot]);
      blocked(result, code + ':' + key);
      assert.equal(result.reads.length, 1);
    }
  });
  await t.test('部署前同一积压只告警，凭据保留每个服务租户的状态', async () => {
    const snapshot = lag(301_000);
    snapshot.projections.push({ ...snapshot.projections[0], tenant_key: OTHER, job_status: 'failed' });
    const result = await run('--pre-deploy', [snapshot]);
    passed(result);
    assert.equal(result.reads.length, 1);
    for (const code of ['projection_backlog_overdue', 'projection_job_failed']) {
      assert.ok(result.stderr.includes('::warning::' + code + ':' + key), result.stderr);
      assert.ok(result.receipt.warnings.includes(code + ':' + key));
    }
    assert.equal(result.receipt.projection_revisions.length, 3);
    assert.ok(result.receipt.projection_revisions.some(row => row.tenant_key === OWNER &&
      row.stale_since === snapshot.projections[0].stale_since && row.resolved_through_revision === 94));
  });
  await t.test('迁移、账本、frontier 与快照故障在两种模式均立即阻断', async () => {
    for (const mode of ['--pre-deploy', '--post-deploy']) {
      for (const [overrides, errors] of [
        [{ history: [] }, ['production_baseline_sql_mismatch', 'ledger_row_not_in_production']],
        [{ history: [...history, { version: '20260102000000', name: 'unknown', statements: ['select 2;'] }] },
          ['production_row_not_in_repository']],
        [{ frontier: '' }, ['frontier_uses_old_selector']],
      ]) {
        const result = await run(mode, [lag(30_000)], overrides);
        for (const error of errors) blocked(result, error);
        assert.equal(result.reads.length, 1);
      }
      blocked(await run(mode, [null]), 'watchdog_unavailable');
      blocked(await run(mode, [{ ...current(), observed_at: now.toISOString() }]), 'watchdog_snapshot_not_fresh');
      blocked(await run(mode, [{ observed_at: new Date().toISOString() }]), 'watchdog_unavailable');
    }
  });
  await t.test('部署后必需键缺失、服务行重复或缺少服务标记均阻断', async () => {
    for (const mutate of [rows => rows.shift(), rows => rows.push({ ...rows[0] }),
      rows => { delete rows[0].builder_served; }]) {
      const snapshot = current();
      mutate(snapshot.projections);
      blocked(await run('--post-deploy', [snapshot]), 'projection_not_current:' + key);
    }
  });
});

// Fable 1121 item 4: a projection queued without a request-side wake waits for
// the next Cron tick, so the post-deploy window covers one whole period plus two
// minutes. Only a failed job or a digest mismatch blocks at once.
test('部署后等待上限＝Cron 周期＋2 分钟，周期从 wrangler 生产配置读', async () => {
  const { cronPeriodMinutes, postDeployWaitLimitMs } = gate;
  assert.equal(typeof cronPeriodMinutes, 'function');
  const production = JSON.parse(await readFile(new URL('../wrangler.production.jsonc', import.meta.url), 'utf8'));
  assert.equal(cronPeriodMinutes(production), 10);
  assert.equal(postDeployWaitLimitMs(10), 12 * 60_000);
  assert.equal(cronPeriodMinutes({ triggers: { crons: ['*/1 * * * *'] } }), 1);
  for (const triggers of [undefined, {}, { crons: [] }, { crons: ['0 * * * *'] }, { crons: ['*/10 * * * *', '*/5 * * * *'] },
    { crons: ['*/0 * * * *'] }, { crons: ['*/60 * * * *'] }, { crons: ['*/10 */2 * * *'] }, { crons: [' */10 * * * *'] }]) {
    assert.throws(() => cronPeriodMinutes({ triggers }), /cron_schedule_unsupported/, JSON.stringify(triggers));
  }
});

test('Cron 每十分钟：无请求侧唤醒、第 9 分钟追平即通过，12 分钟仍积压才失败，任务失败立即失败', async () => {
  const key = 'global.priority_frontier';
  const waitLimitMs = gate.postDeployWaitLimitMs?.(10);
  assert.equal(waitLimitMs, 12 * 60_000);
  const settle = async ({ caughtUpAt = Infinity, failAt = Infinity }) => {
    let clock = now.getTime(), reads = 0;
    const snapshot = () => {
      const result = healthy().watchdog;
      result.observed_at = new Date(clock).toISOString();
      const elapsed = clock - now.getTime();
      if (elapsed < caughtUpAt) {
        Object.assign(result.projections[0], { invalidation_revision: 95, source_digest_status: 'not_applicable',
          job_status: elapsed >= failAt ? 'failed' : 'queued', stale_since: new Date(now.getTime() - 30_000).toISOString() });
      }
      return result;
    };
    const state = await settleProjectionLag({ watchdog: snapshot(), waitLimitMs, now: () => clock,
      sleep: async ms => { assert.ok(ms > 0 && ms <= 10_000); clock += ms; },
      readWatchdog: async () => { reads++; return snapshot(); } });
    return { state, reads, waited: clock - now.getTime() };
  };
  // The next tick lands at minute 9, long after the backlog turned overdue (5 min).
  const tick = await settle({ caughtUpAt: 9 * 60_000 });
  assert.deepEqual(tick.state.findings, []);
  assert.equal(tick.waited, 9 * 60_000);
  // Still behind at 12 minutes: blocked, after waiting the whole window.
  const stuck = await settle({});
  assert.deepEqual(stuck.state.findings, ['projection_backlog_overdue:' + key]);
  assert.equal(stuck.waited, 12 * 60_000);
  assert.equal(stuck.reads, 72);
  // A failed job blocks at once, before or during the wait.
  const failed = await settle({ failAt: 0 });
  assert.deepEqual(failed.state.findings, ['projection_job_failed:' + key]);
  assert.equal(failed.reads, 0);
  const failedLater = await settle({ failAt: 60_000 });
  assert.deepEqual(failedLater.state.findings, ['projection_job_failed:' + key]);
  assert.equal(failedLater.waited, 60_000);
  await assert.rejects(settleProjectionLag({ watchdog: healthy().watchdog, readWatchdog: async () => null }), /wait_limit/);
});

test('发布门不依赖心跳，两个发布入口使用部署后状态模式', async () => {
  const gate = await readFile(new URL('../scripts/production-release-gate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gate, /heartbeat/i);
  const host = await readFile(new URL('../scripts/existing-release-v3-host/payload/release/' +
    'existing-release-entry-v1/v3-host/release-once.mjs', import.meta.url), 'utf8');
  for (const caller of [productionWorkflow, host]) {
    assert.match(caller, /production-release-gate\.mjs[' ,]+--post-deploy/);
    assert.doesNotMatch(caller, /--min-heartbeat-at/);
  }
});

test('libpq tools get sslmode=require where the node-postgres URL says no-verify', () => {
  const scripts = [...productionWorkflow.matchAll(/node -e '((?:const|let) url[^']*)'/g)].map((m) => m[1]);
  assert.equal(scripts.length, 3);
  for (const script of scripts) {
    const run = (value) => spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, CLUED_ATTESTATION_DATABASE_URL: value, CLUED_MIGRATION_DATABASE_URL: value },
      encoding: 'utf8',
    });
    const mapped = run('postgresql://u:p@db.example:5432/postgres?sslmode=no-verify&uselibpqcompat=true');
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.equal(mapped.stdout, 'postgresql://u:p@db.example:5432/postgres?sslmode=require');
    const kept = run('postgresql://u:p@db.example:5432/postgres?sslmode=verify-full');
    assert.equal(kept.stdout, 'postgresql://u:p@db.example:5432/postgres?sslmode=verify-full');
  }
});

test('production backup mode encrypts and verifies the dump before removing plaintext', async () => {
  const backup = productionWorkflow.split(/\n      - name: /)
    .find((step) => step.startsWith('Create and verify encrypted pre-migration backup\n'));
  const publisher = await readFile(new URL('../scripts/verify-production-backup-scope.mjs', import.meta.url), 'utf8');
  assert.match(backup, /if: \$\{\{ inputs\.mode == 'backup' \|\| inputs\.mode == 'migrate' \}\}/);
  assert.match(backup, /secrets\.CLUED_PRODUCTION_BACKUP_KEY/);
  assert.match(backup, /--user \"\$\(id -u\):\$\(id -g\)\"/);
  assert.match(backup, /searchParams\.delete\(\"uselibpqcompat\"\)/);
  assert.match(backup, /-e DATABASE_URL=\"\$database_url\"/);
  assert.match(backup, /node scripts\/verify-production-backup-scope\.mjs "\$backup_container" "\$backup_tmp"/);
  assert.match(publisher, /const toc = await runPg\('pg_restore', \['--list', dumpPath\]\)/);
  assert.match(publisher, /proof = verifyArchiveScope\(inventory, toc\)/);
  assert.match(publisher, /'exec pg_restore "\$@"'/);
  assert.match(publisher, /const proof = await createVerifiedBackup\(\{ session, runPg, dumpPath:/);
  assert.match(publisher, /fs\.writeFile\(path\.join\(scratch, 'scope-proof\.json'\), JSON\.stringify\(proof\)/);
  assert.match(backup, /scope_proof="\$backup_tmp\/scope-proof\.json"/);
  assert.match(backup, /if\(proof\.verified!==true\) throw new Error/);
  assert.match(backup, /scope_verification:proof/);
  assert.match(backup, /openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt/);
  assert.match(backup, /openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000/);
  assert.equal([...backup.matchAll(/-pass env:CLUED_PRODUCTION_BACKUP_KEY/g)].length, 2);
  assert.match(backup, /backup_tmp=\$\(mktemp -d "\$RUNNER_TEMP\/clued-production-backup-XXXXXX"\)/);
  assert.match(backup, /verified_path="\$backup_tmp\//);
  assert.match(backup, /test "\$\(sha256sum "\$verified_path" \| cut -d' ' -f1\)" = "\$dump_sha256"/);
  assert.match(backup, /trap cleanup_plaintext EXIT/);
  assert.match(backup, /--filter "label=clued\.backup-scratch=\$backup_tmp"/);
  const stop = backup.indexOf('docker rm -f "$backup_container"');
  const cleanup = backup.indexOf('for plaintext in "$dump_path" "$verified_path" "$scope_proof"; do');
  const shred = backup.indexOf('shred -u -- "$plaintext"');
  const removeScratch = backup.indexOf('rmdir -- "$backup_tmp"');
  assert.ok(stop >= 0 && stop < cleanup && cleanup < shred && shred < removeScratch,
    'The owned producer must stop before plaintext and scratch are removed');
  assert.match(backup.slice(stop, cleanup), /\|\| cleanup_status=1[\s\S]*if \[ "\$cleanup_status" -ne 0 \]; then[\s\S]*exit 1/);
  assert.match(backup, /clued-production-pre-migration\.dump\.enc/);
  assert.doesNotMatch(productionWorkflow,
    /release-evidence\/clued-production-pre-migration\.dump\s*$/m);
});

test('production release deploys the PDF extractor Worker first and verifies the service binding after both deploys', async () => {
  // StorageNormalUse §4.5 (Owner decision 7210e5a5): the main Worker's PDF_EXTRACTOR binding names clued-storage-pdf.
  const steps = productionWorkflow.split(/\n      - /).slice(1);
  const index = (name) => steps.findIndex((step) => step.startsWith(`name: ${name}\n`));
  const build = index('Build exact Worker source'), extractor = index('Deploy Clued PDF extractor Worker'),
    main = index('Deploy Clued production Worker'), live = index('Verify exact live commit and currentness transport'),
    verify = index('Verify the PDF extractor service binding');
  assert.ok(build >= 0 && build < extractor && extractor < main && main < live && live < verify, JSON.stringify({ build, extractor, main, live, verify }));
  // Same deploy token and account as the main Worker; no vars, secrets or extra flags for the extractor.
  assert.match(steps[extractor], /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLUED_CLOUDFLARE_DEPLOY_TOKEN_V2 \}\}/);
  assert.match(steps[extractor], /CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLUED_CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.match(steps[extractor], /\n        run: npx wrangler deploy --config wrangler\.pdf-extractor\.jsonc\n?$/);
  assert.match(steps[main], /npx wrangler deploy --config wrangler\.production\.jsonc --keep-vars/);
  assert.match(steps[verify], /\n        if: \$\{\{ inputs\.mode == 'deploy' \|\| inputs\.mode == 'release' \}\}\n/);
  assert.match(steps[verify], /node scripts\/verify-pdf-extractor\.mjs --evidence-out \.sites-runtime\/release-evidence\/pdf-extractor\.json/);
  assert.match(productionWorkflow, /release-evidence\/pdf-extractor\.json\n/);
  const buildScript = await readFile(new URL('../scripts/build-verified.sh', import.meta.url), 'utf8');
  assert.match(buildScript, /scripts\/build-pdf-extractor\.mjs" --check-main/);

  const { expectedExtractorOf, verifyPdfExtractorCheck, CHECK_PATH, ATTEMPTS } = await import('../scripts/verify-pdf-extractor.mjs');
  // The attempts (10 s apart) outlast the check route's 60 s per-isolate cache of an OK result.
  assert.ok((ATTEMPTS - 1) * 10 > 60);
  const expected = expectedExtractorOf(await readFile(new URL('../worker/storage-read-pdf-common.ts', import.meta.url), 'utf8'));
  assert.deepEqual(expected, { contract: 'clued.storage-pdf-extractor/1', version: 1 });
  assert.equal(CHECK_PATH, '/v1/storage/pdf-extractor/check');
  const ok = { contract: 'clued.storage-pdf-extractor-check/1', status: 'ok', extractor: expected };
  assert.deepEqual(verifyPdfExtractorCheck({ expected, status: 200, body: ok }), []);
  assert.deepEqual(verifyPdfExtractorCheck({ expected, status: 503, body: { ...ok, status: 'unavailable', code: 'storage_read_unavailable' } }),
    ['pdf_extractor_check_http_503', 'pdf_extractor_check_storage_read_unavailable']);
  assert.deepEqual(verifyPdfExtractorCheck({ expected, status: 200, body: { ...ok, extractor: { ...expected, version: 2 } } }), ['pdf_extractor_version_mismatch']);
  // The release requires exactly the repository's version, even though reads accept N-1 and N+1 during a deploy gap.
  assert.deepEqual(verifyPdfExtractorCheck({ expected, status: 200, body: { ...ok, extractor: { ...expected, version: 0 } } }), ['pdf_extractor_version_mismatch']);
  assert.deepEqual(verifyPdfExtractorCheck({ expected, status: 503, body: { ...ok, status: 'unavailable', extractor: null, code: 'check_in_progress' } }),
    ['pdf_extractor_check_http_503', 'pdf_extractor_check_check_in_progress', 'pdf_extractor_version_mismatch']);
  assert.deepEqual(verifyPdfExtractorCheck({ expected: null, status: 0, body: null }),
    ['repository_extractor_contract_missing', 'pdf_extractor_check_http_0', 'pdf_extractor_check_contract_invalid', 'pdf_extractor_check_failed']);
  // Freshness: an OK answer replayed from before verification started is refused.
  const started = Date.parse('2026-10-01T04:00:00Z');
  assert.deepEqual(verifyPdfExtractorCheck({ expected, status: 200, notBefore: started,
    body: { ...ok, cached: true, checked_at: '2026-10-01T03:59:00Z' } }), ['pdf_extractor_check_not_fresh']);
  assert.deepEqual(verifyPdfExtractorCheck({ expected, status: 200, notBefore: started,
    body: { ...ok, cached: true, checked_at: '2026-10-01T04:00:30Z' } }), []);
  assert.deepEqual(verifyPdfExtractorCheck({ expected, status: 200, notBefore: started,
    body: { ...ok, cached: false, checked_at: '2026-10-01T03:59:00Z' } }), []);
});

test('production release deploys only when deploy is chosen explicitly', () => {
  // A dispatch whose inputs are missing or misparsed must never fall through to a
  // deploy (run 36738247464 deployed when a boolean backup_only was ignored).
  assert.match(productionWorkflow,
    /\n      mode:\n[\s\S]*?type: choice\n        required: true\n        default: preflight\n/);
  assert.doesNotMatch(productionWorkflow, /preflight_only|backup_only|source_capture_only/);

  const steps = productionWorkflow.split(/\n      - /).slice(1);
  const deploySteps = steps.filter((step) =>
    /wrangler deploy|CLUED_CLOUDFLARE_DEPLOY_TOKEN/.test(step));
  assert.ok(deploySteps.length > 0);
  // Only deploy and release deploy (release: one run from preflight to verification).
  for (const step of deploySteps) {
    assert.match(step, /\n        if: \$\{\{ (failure\(\) && \()?inputs\.mode == 'deploy' \|\| inputs\.mode == 'release'(\) && steps\.worker_versions\.outcome == 'success')? \}\}\n/, step.split('\n')[0]);
  }

  const validate = steps.find((step) => step.startsWith('name: Validate exclusive release mode'));
  const script = validate.slice(validate.indexOf('run: |\n') + 'run: |\n'.length)
    .split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  const run = (env) => spawnSync('bash', ['-c', script],
    { env: { PATH: process.env.PATH, SOURCE_REQUEST_ID: '', SOURCE_REQUEST_DIGEST: '', ...env } }).status;
  for (const mode of ['preflight', 'backup', 'deploy']) assert.equal(run({ RELEASE_MODE: mode }), 0, mode);
  for (const mode of ['', 'true', 'false', 'Deploy', 'deploy ', 'backup_only']) {
    assert.notEqual(run({ RELEASE_MODE: mode }), 0, JSON.stringify(mode));
  }
  assert.notEqual(run({ RELEASE_MODE: 'source-capture' }), 0);
  assert.equal(run({ RELEASE_MODE: 'source-capture', SOURCE_REQUEST_ID: 'r', SOURCE_REQUEST_DIGEST: 'd' }), 0);
  assert.notEqual(run({ RELEASE_MODE: 'deploy', SOURCE_REQUEST_ID: 'r' }), 0);
  // migrate names its files; no other mode takes them.
  assert.notEqual(run({ RELEASE_MODE: 'migrate' }), 0);
  assert.equal(run({ RELEASE_MODE: 'migrate', MIGRATIONS: '20261003170000_owner_grants_release_door.sql' }), 0);
  assert.notEqual(run({ RELEASE_MODE: 'migrate', MIGRATIONS: 'x.sql', SOURCE_REQUEST_ID: 'r' }), 0);
  for (const mode of ['preflight', 'backup', 'deploy']) {
    assert.notEqual(run({ RELEASE_MODE: mode, MIGRATIONS: 'x.sql' }), 0, mode);
  }
  // release carries only what a Worker version rollback undoes: never a
  // migration (Fable 1121 item 3; run migrate first), never a source request.
  assert.equal(run({ RELEASE_MODE: 'release' }), 0);
  for (const migrations of ['20261003170000_owner_grants_release_door.sql', '20261003170000_a.sql, 20261003180000_b.sql',
    'x.sql', ' ']) {
    assert.notEqual(run({ RELEASE_MODE: 'release', MIGRATIONS: migrations }), 0, JSON.stringify(migrations));
  }
  assert.notEqual(run({ RELEASE_MODE: 'release', SOURCE_REQUEST_ID: 'r' }), 0);
  // The rollback drill exists only in release mode.
  assert.equal(run({ RELEASE_MODE: 'release', ROLLBACK_DRILL: 'true' }), 0);
  assert.equal(run({ RELEASE_MODE: 'release', ROLLBACK_DRILL: 'false' }), 0);
  for (const mode of ['preflight', 'backup', 'deploy']) assert.notEqual(run({ RELEASE_MODE: mode, ROLLBACK_DRILL: 'true' }), 0, mode);
  assert.notEqual(run({ RELEASE_MODE: 'migrate', MIGRATIONS: '20261003170000_owner_grants_release_door.sql', ROLLBACK_DRILL: 'true' }), 0);
});

test('a release with migrations stops before any production credential is read', () => {
  const steps = productionWorkflow.split(/\n      - /).slice(1);
  const validate = steps.findIndex((step) => step.startsWith('name: Validate exclusive release mode\n'));
  const firstSecret = steps.findIndex((step) => /\$\{\{ secrets\./.test(step));
  assert.ok(validate >= 0 && validate < firstSecret, JSON.stringify({ validate, firstSecret }));
  // No step keeps a path for a release that migrates.
  assert.doesNotMatch(productionWorkflow, /inputs\.mode == 'release' && inputs\.migrations/);
  for (const step of steps.filter((s) => /^name: [^\n]*migrat/i.test(s))) {
    assert.doesNotMatch(/\n {8}if: ([^\n]*)/.exec(step)?.[1] ?? '', /'release'/, step.split('\n')[0]);
  }
  assert.match(productionWorkflow, /\n      migrations:\n        description: >-\n          migrate mode only: /);
});

test('deploy and migrate consume an Owner Grant before they change production', () => {
  // Owner Credential v0.1 §6.1 (Task 2a31ca2a): the grant step comes first.
  const steps = productionWorkflow.split(/\n      - /).slice(1);
  const names = steps.map((step) => step.split('\n')[0]);
  const migrateGrant = names.indexOf('name: Consume the Owner Grant for the named migrations');
  const deployGrant = names.indexOf('name: Consume the Owner Grant for this commit');
  assert.ok(migrateGrant > 0 && deployGrant > 0);
  // A release takes no migrations, so only migrate uses the migration grant;
  // a release calls the grant check as deploy: the same door call, used once.
  assert.match(steps[migrateGrant], /if: \$\{\{ inputs\.mode == 'migrate' \}\}/);
  assert.match(steps[deployGrant], /if: \$\{\{ inputs\.mode == 'deploy' \|\| inputs\.mode == 'release' \}\}/);
  assert.match(steps[migrateGrant], /RELEASE_MODE: \$\{\{ inputs\.mode \}\}/);
  assert.match(steps[deployGrant], /RELEASE_MODE: \$\{\{ inputs\.mode == 'release' && 'deploy' \|\| inputs\.mode \}\}/);
  // What production serves is recorded, and a release whose settings a version
  // rollback cannot undo is refused, before the deploy grant is used.
  assert.ok(names.indexOf('name: Record the Worker versions production serves') > 0);
  assert.ok(names.indexOf('name: Record the Worker versions production serves') < deployGrant);
  for (const grant of [migrateGrant, deployGrant]) {
    assert.match(steps[grant], /node scripts\/ci\/clued-release-grant\.mjs --mode "\$RELEASE_MODE"/);
    assert.match(steps[grant], /CLUED_RELEASE_TOKEN: \$\{\{ secrets\.CLUED_RELEASE_TOKEN \}\}/);
  }
  assert.match(steps[migrateGrant], /MIGRATIONS: \$\{\{ inputs\.migrations \}\}/);
  // Steps that change production come after their grant; the credential
  // checks come before it, so a run that cannot proceed uses no grant
  // (re-review N6). deploy also runs the release gate first: run 37329072487
  // used its grant and then stopped at the gate.
  const gate = names.indexOf('name: Verify database prerequisites and record projection state');
  assert.ok(gate > 0 && gate < deployGrant);
  assert.match(steps[gate], /if: \$\{\{[^\n]*inputs\.mode == 'deploy'/);
  assert.match(steps[deployGrant], /NODE_OPTIONS: ''/);
  steps.forEach((step, index) => {
    if (/Apply the named migrations/.test(step)) assert.ok(index > migrateGrant, names[index]);
    if (/wrangler (deploy|queues create)/.test(step)) assert.ok(index > deployGrant, names[index]);
    if (/^name: Check migration database credential/.test(step)) assert.ok(index < migrateGrant, names[index]);
    if (/^name: Check (production database|Cloudflare deployment) credential/.test(step)) {
      assert.ok(index < deployGrant, names[index]);
    }
  });
  // The migration credential check connects, so a bad password stops the run
  // before a grant is used (trial run 37155374056).
  const check = steps.find((step) => step.startsWith('name: Check migration database credential'));
  assert.match(check, /psql "\$database_url" -v ON_ERROR_STOP=1 -X -tA -c 'select 1'/);
  // The file reaches the server as COPY data on psql's standard input, never
  // through \\i or -f, so psql meta-commands in a file are not executed, and
  // the server checks its md5 against the file before it runs it.
  const apply = steps.find((step) => step.startsWith('name: Apply the named migrations'));
  assert.match(apply, /copy migration_lines\(line\) from stdin with \(format csv, delimiter e'\\x01', quote e'\\x02'\)/);
  assert.match(apply, /commit;" < "\$file"/);
  // Activation readiness must succeed in the same transaction before the ledger.
  assert.match(apply, /if md5\(s\) is distinct from '\$expected' then raise exception[^\n]*\n\s*execute s;\n(?:\s*--[^\n]*\n)*\s*if to_regprocedure\('clued_private\.storage_conflict_require_scheduler_v1\(\)'\) is not null then\n\s*perform clued_private\.storage_conflict_require_scheduler_v1\(\);\n\s*end if;\n\s*insert into supabase_migrations\.schema_migrations/);
  assert.match(apply, /\[\[ "\$expected" =~ \^\[0-9a-f\]\{32\}\$ \]\]/);
  assert.match(apply, /grep -q \$'\[\\r\\x01\\x02\]' "\$file" \|\| grep -qx '\\\\\\\.' "\$file"/);
  assert.match(apply, /\[ -z "\$\(tail -c1 "\$file"\)" \]/);
  // test -f only checks the file exists; nothing else may name -f or --file.
  assert.doesNotMatch(apply.replace('test -f "$file"', ''), /(^|\s)(-f|--file)(\s|=)|\\i |\\copy|-c "\$sql"/);
  assert.match(apply, /postgres:17-alpine psql "\$database_url" -v ON_ERROR_STOP=1 -X "\$@"/);
  assert.match(apply, /\[ -s "\$file" \]/);
  assert.match(apply, /md5\(s\) is distinct from '\$expected'/);
  // The applied-migration record is kept with the run's evidence.
  assert.match(apply, /> "\$evidence_dir\/production-migrations\.json"/);
  assert.match(productionWorkflow, /release-evidence\/production-migrations\.json\n/);
  assert.match(productionWorkflow, /\n    environment: clued-release\n/);
});

// Re-review 5, N1: a repository secret reaches every branch's workflows (a
// pushed branch may add an `on: push` workflow on a hosted runner), so the
// production deploy token and attestation URL live only in the clued-release
// environment, which deploys from main only. Every job that names them
// declares that environment and runs on main only; nothing outside a job
// names them, and no workflow reads secrets by a computed name or passes all
// of them on.
test('production deploy and attestation secrets are read only by main-only clued-release jobs', async () => {
  const dir = new URL('../../../.github/workflows/', import.meta.url);
  const names = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort();
  const secret = /secrets\.(CLUED_CLOUDFLARE_DEPLOY_TOKEN|CLUED_ATTESTATION_DATABASE_URL)(_V2)?\b/;
  const users = [];
  for (const name of names) {
    const text = (await readFile(new URL(name, dir), 'utf8')).replace(/\r\n?/g, '\n');
    assert.doesNotMatch(text, /secrets\s*\[|toJSON\(\s*secrets\s*\)|secrets:\s*inherit/, name);
    const jobsAt = text.search(/^jobs:\s*$/m);
    assert.ok(jobsAt >= 0, `${name} has a jobs: block`);
    assert.doesNotMatch(text.slice(0, jobsAt), secret, `${name} names a production secret outside a job`);
    const jobs = text.slice(jobsAt).split(/^(?= {2}[A-Za-z0-9_-]+:\s*$)/m).slice(1);
    for (const job of jobs) {
      if (!secret.test(job)) continue;
      const id = job.match(/^ {2}([A-Za-z0-9_-]+):/)[1];
      users.push(`${name}:${id}`);
      assert.match(job, /^ {4}environment: clued-release$/m, `${name}:${id} declares the clued-release environment`);
      assert.match(job, /github\.ref == 'refs\/heads\/main'/, `${name}:${id} runs on main only`);
    }
  }
  assert.deepEqual(users, [
    'clued-cloud-production-release.yml:release',
    'clued-currentness-post-deploy-attestation.yml:verify-and-attest',
    'clued-integration-runtime-config.yml:configure',
    'clued-storage-executor-window.yml:open-window',
    'clued-storage-executor-window.yml:open',
    'clued-storage-executor-window.yml:close',
    'clued-storage-read-config.yml:configure',
  ]);
});

test('the release gate evaluates the committed migration ledger against production history before it passes', async () => {
  const gateSource = await readFile(new URL('../scripts/production-release-gate.mjs', import.meta.url), 'utf8');
  // Behaviour of evaluateLedger is covered in tests/migration-ledger.test.mjs; this pins its wiring.
  assert.match(gateSource, /import \{ baselineVersion, evaluateLedger, historyOnlyDirectory, readLedger, readSqlDirectory \}\n\s+from '\.\/migration-ledger\.mjs'/);
  assert.match(gateSource, /evaluateLedger\(\{ ledger, history,\n\s+migrations: await readSqlDirectory\(migrationsDirectory\),\n\s+historyOnly: await readSqlDirectory\(historyOnlyDirectory\),\n\s+historicalThrough: baselineVersion\(baseline\) \}\)/);
  assert.doesNotMatch(gateSource, /ledgerReport\.warnings[^\n]*errors/);
});

// A small model of how GitHub runs this job's steps: each step's `if` (an
// implicit success() unless it names a status function) over the dispatch
// inputs, the earlier failure and the outcomes of steps with an id. It runs
// the real workflow file, so the order, the grant steps and the rollback
// below are the ones production runs.
const releaseSteps = productionWorkflow.split(/\n      - /).slice(1).map((text) => ({
  text,
  name: /(?:^|\n {8})name: (.+)\n/.exec(text)?.[1] ?? text.split('\n')[0],
  id: /(?:^|\n {8})id: (\S+)\n/.exec(text)?.[1] ?? null,
  condition: ((match) => match?.[1] ?? match?.[2] ?? null)(/(?:^|\n {8})if: (?:\$\{\{ (.+?) \}\}|(.+))\n/.exec(text)),
}));

function evaluateCondition(source, context) {
  const tokens = source.match(/'[^']*'|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*|==|!=|&&|\|\||[()!]/g);
  assert.equal(tokens.join(''), source.replace(/\s+/g, ''), `unsupported condition: ${source}`);
  let at = 0;
  const value = (token) => {
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === 'failure()') return context.failed;
    if (token === 'success()') return !context.failed;
    if (token === 'always()') return true;
    if (token.startsWith('inputs.')) return context.inputs[token.slice(7)] ?? '';
    const outcome = /^steps\.([\w-]+)\.outcome$/.exec(token);
    if (outcome) return context.outcomes[outcome[1]] ?? '';
    throw new Error(`unsupported operand ${token} in ${source}`);
  };
  let or;
  const primary = () => {
    const token = tokens[at++];
    if (token === '!') return !primary();
    if (token === '(') { const inner = or(); assert.equal(tokens[at++], ')'); return inner; }
    const left = value(token);
    if (tokens[at] === '==' || tokens[at] === '!=') {
      const op = tokens[at++]; const right = value(tokens[at++]);
      return (op === '==') === (String(left).toLowerCase() === String(right).toLowerCase());
    }
    return Boolean(left);
  };
  const and = () => { let v = primary(); while (tokens[at] === '&&') { at++; const next = primary(); v = v && next; } return v; };
  or = () => { let v = and(); while (tokens[at] === '||') { at++; const next = and(); v = v || next; } return v; };
  const result = or();
  assert.equal(at, tokens.length, `unparsed condition: ${source}`);
  return result;
}

function simulateRelease(inputs, failAt = null) {
  const context = { inputs: { source_request_id: '', source_request_digest: '', migrations: '', rollback_drill: false, ...inputs }, failed: false, outcomes: {} };
  const ran = [];
  for (const step of releaseSteps) {
    const condition = step.condition ?? 'success()';
    const runs = /\b(failure|success|always|cancelled)\(\)/.test(condition)
      ? evaluateCondition(condition, context) : !context.failed && evaluateCondition(condition, context);
    if (!runs) { if (step.id) context.outcomes[step.id] = 'skipped'; continue; }
    ran.push(step);
    const ok = step.name !== failAt;
    if (step.id) context.outcomes[step.id] = ok ? 'success' : 'failure';
    if (!ok) context.failed = true;
  }
  return { ran: ran.map((step) => step.name), steps: ran, conclusion: context.failed ? 'failure' : 'success' };
}

const RELEASE_ORDER = [
  'Check production database credential', 'Verify projection and MTPE behavior', 'Build exact Worker source',
  'Verify and build Kooyumi Connect release source', 'Verify database prerequisites and record projection state',
  'Check Cloudflare deployment credential', 'Record the Worker versions production serves',
  'Consume the Owner Grant for this commit', 'Deploy Clued PDF extractor Worker', 'Deploy Clued production Worker',
  'Verify exact live commit and currentness transport', 'Verify production serves the repository Agent contract',
  'Verify the PDF extractor service binding', 'Deploy Kooyumi Connect Worker', 'Verify Kooyumi Connect production release',
  'Verify projection currentness after deployment', 'Publish the G6 currentness attestation', 'Preserve release evidence',
];
const ROLLBACK_STEP = 'Roll back the Workers after a failed deploy or verification';
const DRILL_STEP = 'Fail the rollback drill after every verification passed';
const PUBLISH_STEP = 'Publish the G6 currentness attestation';
const RECORD_STEP = 'Record the Worker versions production serves';
const VERIFY_STEPS = ['Verify exact live commit and currentness transport', 'Verify production serves the repository Agent contract',
  'Verify the PDF extractor service binding', 'Verify Kooyumi Connect production release', 'Verify projection currentness after deployment'];
const DEPLOY_STEPS = ['Deploy Clued PDF extractor Worker', 'Deploy Clued production Worker', 'Deploy Kooyumi Connect Worker'];
const grantSteps = (run) => run.steps.filter((step) => /\n {8}run: node scripts\/ci\/clued-release-grant\.mjs /.test(step.text));
const writesAttestation = (step) => /verify-currentness-transport\.mjs --publish /.test(step.text);
const MIGRATION = '20261003170000_owner_grants_release_door.sql';

test('release mode runs preflight, deploy and verification in one run and uses its one grant once', () => {
  const run = simulateRelease({ mode: 'release' });
  assert.equal(run.conclusion, 'success');
  const positions = RELEASE_ORDER.map((name) => run.ran.indexOf(name));
  assert.ok(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])),
    JSON.stringify(Object.fromEntries(RELEASE_ORDER.map((name, i) => [name, positions[i]]))));
  assert.deepEqual(grantSteps(run).map((step) => step.name), ['Consume the Owner Grant for this commit']);
  for (const name of ['Check production backup encryption credential', 'Verify backup and migration database identity',
    'Create and verify encrypted pre-migration backup', 'Require verified backup before migration',
    'Check migration database credential', 'Consume the Owner Grant for the named migrations', 'Apply the named migrations']) {
    assert.ok(!run.ran.includes(name), name);
  }
  assert.ok(!run.ran.includes(ROLLBACK_STEP) && !run.ran.includes(DRILL_STEP));
  const [deployGrant] = grantSteps(run);
  assert.match(deployGrant.text, /RELEASE_MODE: \$\{\{ inputs\.mode == 'release' && 'deploy' \|\| inputs\.mode \}\}/);
  assert.match(deployGrant.text, /--mode "\$RELEASE_MODE"/);
  assert.match(deployGrant.text, /NODE_OPTIONS: ''/);
  // Every credential is checked before the grant is used.
  const grantAt = run.ran.indexOf('Consume the Owner Grant for this commit');
  run.ran.forEach((name, index) => { if (/^Check .* credentials?$/.test(name)) assert.ok(index < grantAt, name); });
});

// Fable 1121 item 2: the old Worker a rollback restores asks G6 for its own
// commit. The run may only replace the production attestation once nothing
// can roll the Workers back any more.
test('the G6 attestation is written once, last, and only after every verification passed', async () => {
  for (const mode of ['deploy', 'release']) {
    const ok = simulateRelease({ mode });
    assert.equal(ok.conclusion, 'success');
    assert.deepEqual(ok.steps.filter(writesAttestation).map((step) => step.name), [PUBLISH_STEP]);
    const publishAt = ok.ran.indexOf(PUBLISH_STEP);
    assert.equal(publishAt, ok.ran.length - 2, 'only the evidence upload follows the attestation');
    for (const name of [...DEPLOY_STEPS, ...VERIFY_STEPS]) assert.ok(ok.ran.indexOf(name) < publishAt, name);
    for (const failAt of [...DEPLOY_STEPS, ...VERIFY_STEPS]) {
      const failed = simulateRelease({ mode }, failAt);
      assert.equal(failed.conclusion, 'failure');
      assert.deepEqual(failed.steps.filter(writesAttestation), [], `${mode}: ${failAt} wrote the attestation`);
      assert.ok(failed.ran.includes(ROLLBACK_STEP), `${mode}: ${failAt}`);
    }
    // A failed attestation write is a failed release too: roll back.
    assert.ok(simulateRelease({ mode }, PUBLISH_STEP).ran.includes(ROLLBACK_STEP));
  }
  assert.equal(releaseSteps.filter(writesAttestation).length, 1);
  const verify = releaseSteps.find((step) => step.name === 'Verify exact live commit and currentness transport');
  assert.match(verify.text, /node scripts\/verify-currentness-transport\.mjs --production --evidence-out \.sites-runtime\/release-evidence\/currentness-attestation\.json/);
  assert.doesNotMatch(verify.text, /CLUED_ATTESTATION_DATABASE_URL/, 'verification runs without the attestation database credential');
  const publish = releaseSteps.find((step) => step.name === PUBLISH_STEP);
  assert.match(publish.text, /node scripts\/verify-currentness-transport\.mjs --publish \.sites-runtime\/release-evidence\/currentness-attestation\.json/);
  assert.match(publish.text, /CLUED_ATTESTATION_DATABASE_URL: \$\{\{ secrets\.CLUED_ATTESTATION_DATABASE_URL_V2 \}\}/);
  // The standalone attestation workflow takes the same two steps, in order.
  const standalone = await readFile(new URL('../../../.github/workflows/clued-currentness-post-deploy-attestation.yml', import.meta.url), 'utf8');
  const verifyAt = standalone.indexOf('verify-currentness-transport.mjs --production --evidence-out currentness-attestation.json');
  const publishAt = standalone.indexOf('verify-currentness-transport.mjs --publish currentness-attestation.json');
  assert.ok(verifyAt > 0 && publishAt > verifyAt, JSON.stringify({ verifyAt, publishAt }));
  assert.equal(standalone.split('CLUED_ATTESTATION_DATABASE_URL').length - 1, 1, 'only the publish step holds the credential');
});

test('the rollback drill fails a fully verified release before the attestation and rolls the Workers back', () => {
  const drill = simulateRelease({ mode: 'release', rollback_drill: true });
  assert.equal(drill.conclusion, 'failure');
  const at = (name) => drill.ran.indexOf(name);
  for (const name of [...DEPLOY_STEPS, ...VERIFY_STEPS]) assert.ok(at(name) >= 0 && at(name) < at(DRILL_STEP), name);
  assert.ok(at(DRILL_STEP) < at(ROLLBACK_STEP));
  assert.deepEqual(drill.steps.filter(writesAttestation), []);
  // Off (the default), and in deploy mode, the drill is not on the path.
  assert.ok(!simulateRelease({ mode: 'release' }).ran.includes(DRILL_STEP));
  assert.ok(!simulateRelease({ mode: 'deploy', rollback_drill: true }).ran.includes(DRILL_STEP));
  // It can only fail the run: no credential, no other effect.
  const step = releaseSteps.find((s) => s.name === DRILL_STEP);
  assert.ok(step, DRILL_STEP);
  assert.doesNotMatch(step.text, /secrets\.|continue-on-error/);
  assert.match(step.text, /\n {10}exit 1\n?$/);
  assert.match(productionWorkflow, /\n      rollback_drill:\n[\s\S]*?type: boolean\n        default: false\n/);
});

test('only deploy and release reach production Workers; the single-step modes keep their own steps', () => {
  const touchesWorkers = (step) => /wrangler (deploy|rollback|queues create)|release-worker-versions\.mjs/.test(step.text);
  for (const mode of ['preflight', 'backup', 'migrate', 'source-capture']) {
    const inputs = { mode, migrations: mode === 'migrate' ? MIGRATION : '',
      source_request_id: mode === 'source-capture' ? 'r' : '', source_request_digest: mode === 'source-capture' ? 'd' : '' };
    for (const failAt of [null, 'Verify projection and MTPE behavior', 'Apply the named migrations']) {
      const run = simulateRelease(inputs, failAt);
      assert.deepEqual(run.steps.filter(touchesWorkers).map((step) => step.name), [], `${mode} ${failAt}`);
      assert.deepEqual(run.steps.filter(writesAttestation), [], `${mode} ${failAt}`);
    }
  }
  assert.deepEqual(grantSteps(simulateRelease({ mode: 'migrate', migrations: MIGRATION })).map((s) => s.name),
    ['Consume the Owner Grant for the named migrations']);
  assert.deepEqual(grantSteps(simulateRelease({ mode: 'deploy' })).map((s) => s.name), ['Consume the Owner Grant for this commit']);
  assert.ok(!simulateRelease({ mode: 'deploy' }).ran.includes('Apply the named migrations'));
  assert.ok(simulateRelease({ mode: 'backup' }).ran.includes('Create and verify encrypted pre-migration backup'));
});

test('a failed deploy or post-deploy verification rolls the Workers back and the release still fails', () => {
  for (const mode of ['release', 'deploy']) {
    for (const failAt of ['Consume the Owner Grant for this commit', ...DEPLOY_STEPS, ...VERIFY_STEPS, PUBLISH_STEP]) {
      const run = simulateRelease({ mode }, failAt);
      assert.equal(run.conclusion, 'failure', failAt);
      assert.ok(run.ran.includes(ROLLBACK_STEP), `${mode}: ${failAt} did not roll back`);
      assert.ok(run.ran.indexOf(ROLLBACK_STEP) > run.ran.indexOf(failAt));
      assert.ok(run.ran.indexOf(ROLLBACK_STEP) < run.ran.indexOf('Preserve release evidence'));
      if (failAt.startsWith('Verify exact')) assert.ok(!run.ran.includes('Deploy Kooyumi Connect Worker'));
    }
    // Nothing was recorded: nothing to roll back to, and no grant was used.
    for (const failAt of ['Verify database prerequisites and record projection state', RECORD_STEP]) {
      const run = simulateRelease({ mode }, failAt);
      assert.equal(run.conclusion, 'failure');
      assert.ok(!run.ran.includes(ROLLBACK_STEP), failAt);
      assert.deepEqual(grantSteps(run), [], failAt);
      assert.ok(!run.ran.some((name) => /^Deploy /.test(name)), failAt);
    }
  }
  const migrated = simulateRelease({ mode: 'migrate', migrations: MIGRATION }, 'Apply the named migrations');
  assert.ok(!migrated.ran.includes(ROLLBACK_STEP) && !migrated.ran.some((name) => /^Deploy /.test(name)));
  const step = releaseSteps.find((s) => s.name === ROLLBACK_STEP);
  assert.match(step.text, /node scripts\/release-worker-versions\.mjs rollback --from \.sites-runtime\/release-evidence\/worker-versions\.json --out \.sites-runtime\/release-evidence\/worker-rollback\.json/);
  assert.match(step.text, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLUED_CLOUDFLARE_DEPLOY_TOKEN_V2 \}\}/);
  const record = releaseSteps.find((s) => s.name === RECORD_STEP);
  assert.match(record.text, /RELEASE_MODE: \$\{\{ inputs\.mode \}\}/);
  assert.match(record.text, /node scripts\/release-worker-versions\.mjs record --mode "\$RELEASE_MODE" --out \.sites-runtime\/release-evidence\/worker-versions\.json/);
  assert.doesNotMatch(productionWorkflow, /continue-on-error/);
  for (const file of ['worker-versions', 'worker-rollback']) {
    assert.match(productionWorkflow, new RegExp(`release-evidence/${file}\\.json\\n`));
  }
});

// Fable 1121 item 6: a step timeout is a failure and reaches the rollback; a
// job timeout is a cancellation and does not. So every step a deploy or
// release runs has its own timeout, and the job outlasts all of them together.
test('every deploy and release step has a timeout, and the job timeout covers them all and the rollback', async () => {
  const workers = await import('../scripts/release-worker-versions.mjs');
  const jobTimeout = Number(/\n    timeout-minutes: (\d+)\n/.exec(productionWorkflow)?.[1]);
  const minutes = (step) => Number(/\n {8}timeout-minutes: (\d+)\n/.exec(`\n${step.text}\n`)?.[1]);
  const paths = [simulateRelease({ mode: 'deploy' }), simulateRelease({ mode: 'release' }),
    simulateRelease({ mode: 'release', rollback_drill: true }), simulateRelease({ mode: 'release' }, PUBLISH_STEP)];
  const steps = [...new Map(paths.flatMap((run) => run.steps).map((step) => [step.text, step])).values()];
  assert.ok(steps.some((step) => step.name === ROLLBACK_STEP) && steps.some((step) => step.name === DRILL_STEP));
  for (const step of steps) assert.ok(minutes(step) > 0, `${step.name} has no timeout-minutes`);
  const total = steps.reduce((sum, step) => sum + minutes(step), 0);
  // Five minutes for the runner's own set-up and post steps.
  assert.ok(jobTimeout >= total + 5, JSON.stringify({ jobTimeout, total }));
  const step = (name) => releaseSteps.find((s) => s.name === name);
  // The edge window is PROPAGATION_WINDOW_MS (Task df6dc467; its own test
  // fails until main carries it); 120 s is its value there.
  const live = await import('../scripts/currentness-live-build.mjs');
  const rollbackMs = workers.rollbackWorstCaseMs(live.PROPAGATION_WINDOW_MS ?? 120_000);
  assert.ok(minutes(step(ROLLBACK_STEP)) * 60_000 >= rollbackMs, String(rollbackMs));
  assert.ok(minutes(step(RECORD_STEP)) * 60_000 >= workers.RECORD_WORST_CASE_MS, String(workers.RECORD_WORST_CASE_MS));
  const production = JSON.parse(await readFile(new URL('../wrangler.production.jsonc', import.meta.url), 'utf8'));
  assert.ok(minutes(step('Verify projection currentness after deployment')) * 60_000 >=
    gate.postDeployWaitLimitMs(gate.cronPeriodMinutes(production)) + 60_000);
});

const HEAD_COMMIT = 'c'.repeat(40), EDGE_COMMIT = 'e'.repeat(40);
// What the public edge serves: the main Worker's /healthz and Connect's smoke.
const servedEdge = (commit = EDGE_COMMIT, revision = 'r1') =>
  ({ 'clued-cloud': { source_commit: commit }, 'clued-connect': { source_commit: commit, revision } });
// Each production configuration as git shows it at a commit.
const WRANGLER_FILES = ['apps/clued-cloud/wrangler.pdf-extractor.jsonc', 'apps/clued-cloud/wrangler.production.jsonc',
  'apps/kooyumi-connect/wrangler.production.jsonc'];
const repositoryConfigs = Object.fromEntries(await Promise.all(WRANGLER_FILES.map(async (file) =>
  [file, await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8')])));
const gitShowAt = (changes = {}) => async (commit, file) => {
  assert.ok(WRANGLER_FILES.includes(file), file);
  if (commit === EDGE_COMMIT && changes[file]) return JSON.stringify(changes[file](JSON.parse(repositoryConfigs[file])));
  return repositoryConfigs[file];
};

test('the rollback restores each changed Worker to its recorded version, last deployed first, and reports it', async () => {
  const { WORKERS, main, recordVersions, rollbackVersions, renderRollbackSummary, servedVersion } =
    await import('../scripts/release-worker-versions.mjs');
  // The names are the ones the deploy steps' configurations publish.
  for (const { name, config } of WORKERS) {
    const text = await readFile(new URL(`../${config}`, import.meta.url), 'utf8');
    assert.equal(/"name": "([^"]+)"/.exec(text)[1], name, config);
    assert.ok(productionWorkflow.includes(config), config);
  }
  const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
  const status = (version) => ({ status: 0, stdout: JSON.stringify({ id: 'd', versions: [{ version_id: version, percentage: 100 }] }) });
  assert.equal(servedVersion(`banner\n${status(id(1)).stdout}\n`), id(1));
  assert.equal(servedVersion(JSON.stringify({ versions: [{ version_id: id(1), percentage: 60 }, { version_id: id(2), percentage: 40 }] })), null);
  const fakeCloudflare = (served, { failRollback = [] } = {}) => {
    const calls = [];
    const wrangler = async (args) => {
      calls.push(args);
      if (args[0] === 'deployments') return status(served[args[3]]);
      if (args[0] === 'rollback') {
        if (failRollback.includes(args[3])) return { status: 1, stdout: '', stderr: 'rollback refused' };
        served[args[3]] = args[1];
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected wrangler ${args.join(' ')}`);
    };
    return { wrangler, calls, served };
  };
  const wait = async () => {};
  const env = { GITHUB_SHA: HEAD_COMMIT, GITHUB_RUN_ID: '42' };
  const edges = { readEdges: async () => servedEdge(), gitShow: gitShowAt(), sleep: wait, windowMs: 120_000 };
  const before = { 'clued-storage-pdf': id(1), 'clued-cloud': id(2), 'clued-connect': id(3) };
  const recorded = await recordVersions({ wrangler: fakeCloudflare({ ...before }).wrangler, wait, env, mode: 'release', ...edges });
  assert.deepEqual(recorded.workers, Object.entries(before).map(([name, version_id]) => ({ name, version_id })));
  assert.deepEqual(recorded.edge, servedEdge());
  // A split deployment stops the release before anything is deployed.
  await assert.rejects(recordVersions({ wait, env, mode: 'release', ...edges,
    wrangler: async () => ({ status: 0, stdout: '{"versions":[]}' }) }), /clued-storage-pdf does not serve exactly one version/);
  // The PDF extractor and the main Worker were deployed, then verification failed.
  const cloud = fakeCloudflare({ ...before, 'clued-storage-pdf': id(4), 'clued-cloud': id(5) });
  const result = await rollbackVersions({ recorded, wrangler: cloud.wrangler, wait, env, ...edges });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'restored');
  assert.deepEqual(cloud.served, before);
  assert.deepEqual(result.workers.map((w) => [w.name, w.action]),
    [['clued-connect', 'unchanged'], ['clued-cloud', 'rolled_back'], ['clued-storage-pdf', 'rolled_back']]);
  assert.deepEqual(cloud.calls.filter((args) => args[0] === 'rollback').map((args) => args.slice(0, 4)),
    [['rollback', id(2), '--name', 'clued-cloud'], ['rollback', id(1), '--name', 'clued-storage-pdf']]);
  assert.ok(cloud.calls.filter((args) => args[0] === 'rollback').every((args) => args.includes('--yes')));
  const summary = renderRollbackSummary(result);
  assert.ok(summary.includes(`| \`clued-cloud\` | \`${id(2)}\` | \`${id(5)}\` | rolled_back |`), summary);
  assert.match(summary, /database is forward-only and was not rolled back/);
  assert.match(summary, /Production serves the recorded versions again/);
  // A refused rollback is reported and fails the step.
  const refused = await rollbackVersions({ recorded, wait, env, ...edges,
    wrangler: fakeCloudflare({ ...before, 'clued-cloud': id(5) }, { failRollback: ['clued-cloud'] }).wrangler });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'rollback_failed');
  assert.match(renderRollbackSummary(refused), /rollback_failed: rollback refused[\s\S]*could not be rolled back/);
  await assert.rejects(rollbackVersions({ recorded: { ...recorded, workers: recorded.workers.slice(1) }, wait, env, ...edges }), /not a valid record/);

  // The commands the workflow runs: record, then rollback with the summary.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'worker-versions-'));
  const files = { versions: path.join(dir, 'v.json'), rollback: path.join(dir, 'r.json'), summary: path.join(dir, 's.md') };
  await writeFile(files.summary, '');
  const log = console.log; const error = console.error; const errors = [];
  console.log = () => {}; console.error = (line) => errors.push(line);
  try {
    assert.equal(await main(['record', '--mode', 'release', '--out', files.versions], { wrangler: fakeCloudflare({ ...before }).wrangler, wait, env, ...edges }), 0);
    const failed = fakeCloudflare({ ...before, 'clued-connect': id(6) });
    assert.equal(await main(['rollback', '--from', files.versions, '--out', files.rollback],
      { wrangler: failed.wrangler, wait, env: { ...env, GITHUB_STEP_SUMMARY: files.summary }, ...edges }), 0);
    assert.deepEqual(failed.served, before);
    assert.match(await readFile(files.summary, 'utf8'), /Automatic Worker rollback[\s\S]*`clued-connect`[^\n]*rolled_back/);
    assert.equal(JSON.parse(await readFile(files.rollback, 'utf8')).ok, true);
    assert.ok(errors.some((line) => /::error title=Release rolled back::Rolled back clued-connect/.test(line)));
    assert.equal(await main(['rollback'], { env }), 2);
    assert.equal(await main(['record', '--out', files.versions], { env }), 2, 'record names its mode');
  } finally {
    console.log = log; console.error = error;
    await rm(dir, { recursive: true, force: true });
  }
});

// Fable 1121 item 5: a version rollback does not undo Cron, routes, queue
// consumers or Durable Object migrations. A release refuses a commit that
// changes any of them, before the grant and before any deploy.
test('a release whose Worker settings a version rollback cannot undo is refused before anything is deployed', async () => {
  const { recordVersions, UNVERSIONED_KEYS } = await import('../scripts/release-worker-versions.mjs');
  assert.deepEqual(UNVERSIONED_KEYS, ['triggers', 'routes', 'queues.consumers', 'migrations']);
  const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
  const versions = { 'clued-storage-pdf': id(1), 'clued-cloud': id(2), 'clued-connect': id(3) };
  let deploys = 0;
  const wrangler = async (args) => {
    if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: versions[args[3]], percentage: 100 }] }) };
    deploys += 1; return { status: 0, stdout: '' };
  };
  const base = { wrangler, wait: async () => {}, env: { GITHUB_SHA: HEAD_COMMIT }, readEdges: async () => servedEdge() };
  const changes = [
    ['apps/clued-cloud/wrangler.production.jsonc', (c) => ({ ...c, triggers: { crons: ['* * * * *'] } }), /clued-cloud[^\n]*triggers/],
    ['apps/clued-cloud/wrangler.production.jsonc', (c) => ({ ...c, routes: c.routes.slice(1) }), /clued-cloud[^\n]*routes/],
    ['apps/clued-cloud/wrangler.production.jsonc', (c) => ({ ...c, queues: { ...c.queues, consumers: [] } }), /queues\.consumers/],
    ['apps/kooyumi-connect/wrangler.production.jsonc', (c) => ({ ...c, routes: [] }), /clued-connect[^\n]*routes/],
    ['apps/clued-cloud/wrangler.pdf-extractor.jsonc', (c) => ({ ...c, triggers: { crons: ['*/5 * * * *'] } }), /clued-storage-pdf[^\n]*triggers/],
  ];
  for (const [file, change, message] of changes) {
    await assert.rejects(recordVersions({ ...base, mode: 'release', gitShow: gitShowAt({ [file]: change }) }),
      (error) => message.test(error.message) && /deploy mode/.test(error.message), file);
    // deploy mode keeps publishing them, and records what changed.
    const recorded = await recordVersions({ ...base, mode: 'deploy', gitShow: gitShowAt({ [file]: change }) });
    assert.equal(recorded.unversioned_changes.length, 1, file);
  }
  // Settings that move with a version (vars, bindings, compatibility) are fine.
  const vars = await recordVersions({ ...base, mode: 'release', gitShow: gitShowAt({
    'apps/clued-cloud/wrangler.production.jsonc': (c) => ({ ...c, vars: { ...c.vars, EXTRA: 'x' } }) }) });
  assert.deepEqual(vars.unversioned_changes, []);
  // Without the commit the edge serves, a release cannot compare and stops.
  for (const edge of [{ ...servedEdge(), 'clued-cloud': { error: 'timeout' } }, { ...servedEdge(), 'clued-connect': { error: 'http 503' } }]) {
    await assert.rejects(recordVersions({ ...base, mode: 'release', readEdges: async () => edge, gitShow: gitShowAt() }), /nothing was deployed/);
    const recorded = await recordVersions({ ...base, mode: 'deploy', readEdges: async () => edge, gitShow: gitShowAt() });
    assert.ok(Object.values(recorded.edge).some((value) => value.error));
  }
  await assert.rejects(recordVersions({ ...base, mode: 'release', gitShow: async () => { throw new Error('bad object'); } }), /nothing was deployed/);
  await assert.rejects(recordVersions({ ...base, mode: 'preview', gitShow: gitShowAt() }), /mode/);
  assert.equal(deploys, 0);
  // In the workflow, a refused record means no grant used and nothing deployed.
  const refused = simulateRelease({ mode: 'release' }, RECORD_STEP);
  assert.deepEqual(grantSteps(refused), []);
  assert.ok(!refused.ran.some((name) => /^Deploy |Ensure Storage/.test(name)));
});

// Fable 1121 item 5: versions back at 100% is not yet service restored. The
// rollback waits, within the propagation window, for the public edge to serve
// the recorded commits again; otherwise it says so and fails.
test('the rollback reports restored only when the edge serves the recorded commits again', async () => {
  const { CONTRACT, WORKERS, rollbackVersions, renderRollbackSummary, main } = await import('../scripts/release-worker-versions.mjs');
  const version = (n) => `${n.repeat(8)}-0000-4000-8000-${n.repeat(12)}`;
  const recorded = { contract: CONTRACT, mode: 'release', source_commit: HEAD_COMMIT, edge: servedEdge(),
    workers: WORKERS.map(({ name }, i) => ({ name, version_id: version(String(i + 1)) })) };
  const rollingBack = () => {
    const served = Object.fromEntries(WORKERS.map(({ name }) => [name, version('9')]));
    return async (args) => {
      if (args[0] === 'rollback') { served[args[3]] = args[1]; return { status: 0, stdout: '' }; }
      return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: served[args[3]], percentage: 100 }] }) };
    };
  };
  const clockFor = () => {
    let clock = 0;
    return { now: () => clock, sleep: async (ms) => { assert.ok(ms > 0 && ms <= 10_000); clock += ms; }, elapsed: () => clock };
  };
  // The versions are back, but the edge still serves the failed release.
  const stuck = clockFor(); let reads = 0;
  const unconfirmed = await rollbackVersions({ recorded, wrangler: rollingBack(), wait: async () => {}, env: {},
    readEdges: async () => { reads += 1; return servedEdge(HEAD_COMMIT, 'r2'); }, windowMs: 120_000, now: stuck.now, sleep: stuck.sleep });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.status, 'versions_restored_edge_unconfirmed');
  assert.ok(unconfirmed.workers.every((w) => w.action === 'rolled_back'));
  assert.equal(stuck.elapsed(), 120_000);
  assert.ok(reads >= 12);
  assert.deepEqual(unconfirmed.edge.map((e) => [e.name, e.confirmed]), [['clued-cloud', false], ['clued-connect', false]]);
  const text = renderRollbackSummary(unconfirmed);
  assert.doesNotMatch(text, /serves the recorded versions again/);
  assert.match(text, /edge was not confirmed/i);
  // Connect back on its commit but on another revision is not restored either.
  const revision = clockFor();
  const wrongRevision = await rollbackVersions({ recorded, wrangler: rollingBack(), wait: async () => {}, env: {},
    readEdges: async () => servedEdge(EDGE_COMMIT, 'r2'), windowMs: 120_000, now: revision.now, sleep: revision.sleep });
  assert.equal(wrongRevision.status, 'versions_restored_edge_unconfirmed');
  // The edge catches up after half a minute, read errors in between: restored.
  const late = clockFor();
  const restored = await rollbackVersions({ recorded, wrangler: rollingBack(), wait: async () => {}, env: {}, windowMs: 120_000,
    now: late.now, sleep: late.sleep, readEdges: async () => {
      if (late.elapsed() < 10_000) throw new Error('synthetic edge timeout');
      return late.elapsed() >= 30_000 ? servedEdge() : servedEdge(HEAD_COMMIT, 'r2');
    } });
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'restored');
  assert.equal(late.elapsed(), 30_000);
  // An edge that could not be read when the versions were recorded cannot be confirmed.
  const blind = clockFor();
  const unrecorded = await rollbackVersions({ recorded: { ...recorded, edge: { ...servedEdge(), 'clued-connect': { error: 'timeout' } } },
    wrangler: rollingBack(), wait: async () => {}, env: {}, readEdges: async () => servedEdge(), windowMs: 120_000, now: blind.now, sleep: blind.sleep });
  assert.equal(unrecorded.status, 'versions_restored_edge_unconfirmed');
  // The CLI exits non-zero for an unconfirmed edge.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'worker-edge-'));
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    await writeFile(path.join(dir, 'v.json'), JSON.stringify(recorded));
    const cli = clockFor();
    assert.equal(await main(['rollback', '--from', path.join(dir, 'v.json'), '--out', path.join(dir, 'r.json')], { wrangler: rollingBack(),
      wait: async () => {}, env: {}, readEdges: async () => servedEdge(HEAD_COMMIT), windowMs: 120_000, now: cli.now, sleep: cli.sleep }), 1);
  } finally {
    console.log = log; console.error = error;
    await rm(dir, { recursive: true, force: true });
  }
});

test('the edge waits in the same propagation window as the release verification', async () => {
  // PROPAGATION_WINDOW_MS lands in currentness-live-build.mjs with Task
  // df6dc467; until main carries it, this test fails on purpose.
  const { propagationWindowMs } = await import('../scripts/release-worker-versions.mjs');
  const live = await import('../scripts/currentness-live-build.mjs');
  assert.ok(Number.isSafeInteger(live.PROPAGATION_WINDOW_MS) && live.PROPAGATION_WINDOW_MS > 0,
    'currentness-live-build.mjs exports PROPAGATION_WINDOW_MS (Task df6dc467)');
  assert.equal(propagationWindowMs(), live.PROPAGATION_WINDOW_MS);
  assert.throws(() => propagationWindowMs({}), /PROPAGATION_WINDOW_MS/);
});

test('migration cannot consume a grant or apply without a successful verified encrypted backup', async () => {
  const steps=productionWorkflow.split(/\n      - /).slice(1);
  const index=name=>steps.findIndex(s=>s.startsWith('name: '+name+'\n'));
  const encryption=index('Check production backup encryption credential');
  const target=index('Verify backup and migration database identity');
  const backup=index('Create and verify encrypted pre-migration backup');
  const gate=index('Require verified backup before migration');
  const grant=index('Consume the Owner Grant for the named migrations');
  const apply=index('Apply the named migrations');
  assert.ok(encryption>=0&&encryption<target&&target<backup&&backup<gate&&gate<grant&&grant<apply);
  for(const i of [encryption,backup])assert.match(steps[i],/if: \$\{\{ inputs\.mode == 'backup' \|\| inputs\.mode == 'migrate' \}\}/);
  assert.match(steps[backup],/id: pre_migration_backup/);
  assert.match(steps[gate],/BACKUP_OUTCOME: \$\{\{ steps\.pre_migration_backup\.outcome \}\}/);
  const script=/node -e '([^']+)'/.exec(steps[gate])?.[1]; assert.ok(script);
  const temp=await mkdtemp(path.join(os.tmpdir(),'clued-backup-gate-'));
  const root=path.join(temp,'.sites-runtime/release-evidence');await mkdir(root,{recursive:true});
  const bytes=Buffer.from('synthetic encrypted fixture');
  const manifest={contract:'clued.production-pre-migration-backup.v1',source_commit:'a'.repeat(40),database_project:'clued-prod',database_identity:'supabase:ccxsikzwxlolxqlosril:postgres',
    scope_verification:{verified:true},dump_bytes:42,dump_sha256:'b'.repeat(64),encrypted_sha256:createHash('sha256').update(bytes).digest('hex')};
  const run=outcome=>spawnSync(process.execPath,['-e',script],{cwd:temp,encoding:'utf8',env:{...process.env,GITHUB_SHA:manifest.source_commit,BACKUP_OUTCOME:outcome,CLUED_PRODUCTION_DATABASE_IDENTITY:manifest.database_identity}}).status;
  const save=m=>writeFile(path.join(root,'production-backup-manifest.json'),JSON.stringify(m));
  try{
    await writeFile(path.join(root,'clued-production-pre-migration.dump.enc'),bytes);await save(manifest);
    assert.equal(run('success'),0);
    for(const outcome of ['skipped','failure','cancelled',''])assert.notEqual(run(outcome),0,outcome);
    for(const changed of [{source_commit:'c'.repeat(40)},{scope_verification:{verified:false}},{database_project:'other'},
      {database_identity:'supabase:other:postgres'},{dump_bytes:0},{encrypted_sha256:'0'.repeat(64)}]){await save({...manifest,...changed});assert.notEqual(run('success'),0,JSON.stringify(changed));}
    await save(manifest);await writeFile(path.join(root,'clued-production-pre-migration.dump.enc'),'tampered');
    assert.notEqual(run('success'),0);
    await rm(path.join(root,'production-backup-manifest.json'));assert.notEqual(run('success'),0);
  }finally{
    assert.equal(path.dirname(temp),os.tmpdir());assert.ok(path.basename(temp).startsWith('clued-backup-gate-'));
    await rm(temp,{recursive:true,force:true});
  }
});

test('backup identity checks actual trusted connection routing, not a project label',async()=>{
  const step=productionWorkflow.split(/\n      - /).find(s=>s.startsWith('name: Verify backup and migration database identity\n'));
  const script=/node -e '([^']+)'/.exec(step)?.[1];assert.ok(script);
  const temp=await mkdtemp(path.join(os.tmpdir(),'clued-backup-identity-'));
  const output=path.join(temp,'github-env');
  const direct='postgresql://fixture:synthetic@db.ccxsikzwxlolxqlosril.supabase.co:5432/postgres';
  const pool='postgresql://fixture.ccxsikzwxlolxqlosril:synthetic@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';
  const run=(backup,migration)=>spawnSync(process.execPath,['-e',script],{encoding:'utf8',env:{...process.env,GITHUB_ENV:output,
    CLUED_ATTESTATION_DATABASE_URL:backup,CLUED_MIGRATION_DATABASE_URL:migration,CLUED_PRODUCTION_DATABASE_IDENTITY:'supabase:ccxsikzwxlolxqlosril:postgres'}});
  try{
    assert.equal(run(direct,pool).status,0);
    assert.equal(await readFile(output,'utf8'),'CLUED_PRODUCTION_DATABASE_IDENTITY=supabase:ccxsikzwxlolxqlosril:postgres\n');
    for(const wrong of [direct.replace('ccxsikzwxlolxqlosril','differentproject'),pool.replace('fixture.ccxsikzwxlolxqlosril','fixture.differentproject'),
      direct.replace('db.ccxsikzwxlolxqlosril.supabase.co','example.invalid'),direct+'?host=example.invalid',pool+'?user=fixture.differentproject',
      direct.replace('/postgres','/otherdb'),'invalid synthetic credential']){
      const result=run(direct,wrong);assert.notEqual(result.status,0);assert.ok(!result.stderr.includes('invalid synthetic credential'));
      assert.notEqual(run(wrong,pool).status,0);
    }
  }finally{
    assert.equal(path.dirname(temp),os.tmpdir());assert.ok(path.basename(temp).startsWith('clued-backup-identity-'));
    await rm(temp,{recursive:true,force:true});
  }
});
// Regression: process exceptions and transient API failures must not prevent
// recovery of the remaining Workers. All Cloudflare effects are injected.
test('rollback isolates command exceptions, retries transient failures and keeps recovering in reverse order', async () => {
  const { CONTRACT, WORKERS, rollbackVersions } = await import('../scripts/release-worker-versions.mjs');
  const version = (n) => `${n.repeat(8)}-0000-4000-8000-${n.repeat(12)}`;
  const recorded = { contract: CONTRACT, mode: 'release', source_commit: 'a'.repeat(40), edge: servedEdge(),
    workers: WORKERS.map(({ name }, i) => ({ name, version_id: version(String(i + 1)) })) };
  const served = Object.fromEntries(WORKERS.map(({ name }) => [name, version('9')]));
  const attempts = new Map(); const calls = [];
  const wrangler = async (args) => {
    const name = args[3];
    if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: served[name], percentage: 100 }] }) };
    calls.push(name); attempts.set(name, (attempts.get(name) ?? 0) + 1);
    if (name === 'clued-connect') throw new Error('synthetic process launch failure');
    if (name === 'clued-cloud' && attempts.get(name) === 1) return { status: 1, stderr: 'temporary API failure' };
    served[name] = args[1]; return { status: 0, stdout: '' };
  };
  let edgeReads = 0;
  const result = await rollbackVersions({ recorded, wrangler, wait: async () => {}, env: { GITHUB_SHA: recorded.source_commit },
    readEdges: async () => { edgeReads += 1; return servedEdge(); }, windowMs: 120_000 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'rollback_failed');
  // A Worker still on the failed release: no point waiting for the edge.
  assert.equal(edgeReads, 0);
  assert.deepEqual(result.workers.map(({ name, action }) => [name, action]), [
    ['clued-connect', 'rollback_failed'], ['clued-cloud', 'rolled_back'], ['clued-storage-pdf', 'rolled_back'],
  ]);
  assert.equal(attempts.get('clued-connect'), 3);
  assert.equal(attempts.get('clued-cloud'), 2);
  assert.deepEqual([...new Set(calls)], ['clued-connect', 'clued-cloud', 'clued-storage-pdf']);
  assert.match(result.workers[0].error, /synthetic process launch failure/);
});

test('unreadable Worker status does not abort recovery of the recorded versions', async () => {
  const { CONTRACT, WORKERS, rollbackVersions } = await import('../scripts/release-worker-versions.mjs');
  const version_id = '11111111-0000-4000-8000-111111111111';
  const recorded = { contract: CONTRACT, mode: 'deploy', edge: servedEdge(), workers: WORKERS.map(({ name }) => ({ name, version_id })) };
  const restored = new Set();
  const result = await rollbackVersions({ recorded, wait: async () => {}, env: {}, readEdges: async () => servedEdge(), windowMs: 120_000, wrangler: async (args) => {
    const name = args[3];
    if (args[0] === 'rollback') { restored.add(name); return { status: 0 }; }
    if (!restored.has(name)) throw new Error('synthetic status read failure');
    return { status: 0, stdout: JSON.stringify({ versions: [{ version_id, percentage: 100 }] }) };
  } });
  assert.equal(result.ok, true);
  assert.equal(restored.size, 3);
});

test('Wrangler subprocesses have a timeout so a stalled read or rollback cannot exhaust the release job', async () => {
  const { npxWrangler } = await import('../scripts/release-worker-versions.mjs');
  assert.equal(typeof npxWrangler, 'function');
  let options;
  const result = npxWrangler(['deployments', 'status', '--name', 'clued-cloud', '--json'], {
    spawn: (file, args, opts) => {
      assert.equal(file, process.execPath);
      assert.match(args[0].replaceAll('\\', '/'), /node_modules\/wrangler\/wrangler-dist\/cli\.js$/);
      assert.deepEqual(args.slice(1), ['deployments', 'status', '--name', 'clued-cloud', '--json']);
      options = opts; return { status: null, error: new Error('synthetic timeout'), stdout: '', stderr: '' };
    },
  });
  assert.ok(options.timeout > 0 && options.timeout <= 60_000);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic timeout/);
});

test('backup failures stop migrate mode before any grant or production mutation', () => {
  for (const mode of ['migrate']) {
    for (const failAt of ['Verify backup and migration database identity',
      'Create and verify encrypted pre-migration backup', 'Require verified backup before migration']) {
      const run = simulateRelease({ mode, migrations: MIGRATION }, failAt);
      assert.equal(run.conclusion, 'failure');
      assert.deepEqual(grantSteps(run), []);
      assert.ok(!run.ran.includes('Apply the named migrations'));
      assert.ok(!run.ran.some((name) => /^Deploy /.test(name)));
      assert.ok(!run.ran.includes(ROLLBACK_STEP));
    }
  }
});

// Fable 1121 item 2: --production verifies and writes its evidence, never the
// database; --publish installs that run's evidence as the production G6
// attestation, in one transaction, only for this commit and this run.
test('verification never writes the attestation; --publish writes it once from this run\'s evidence', async () => {
  const verifier = await import('../scripts/verify-currentness-transport.mjs');
  assert.equal(typeof verifier.main, 'function');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'currentness-publish-'));
  const commit = 'd'.repeat(40);
  const env = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '77', GITHUB_SHA: commit, GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_SERVER_URL: 'https://github.com', CLUED_ATTESTATION_DATABASE_URL: 'postgresql://fixture.invalid/postgres' };
  const connections = [];
  const connect = () => {
    const client = { queries: [], params: [], connect: async () => {}, end: async () => {},
      query: async (sql, params) => { client.queries.push(sql.trim().split(/\s+/).slice(0, 2).join(' ')); client.params.push(params); return { rows: [] }; } };
    connections.push(client);
    return client;
  };
  const live = [];
  const deps = { env, git: (args) => (args[0] === 'rev-parse' ? commit : ''), runTests: () => ({ status: 0, stdout: 'ok 19\n', stderr: '' }),
    waitLive: async (expected) => { live.push(expected); return expected; }, connect, out: () => {} };
  const evidence = path.join(dir, 'currentness-attestation.json');
  try {
    await verifier.main(['--production', '--evidence-out', evidence], deps);
    assert.equal(connections.length, 0, '--production opened a database connection');
    const written = JSON.parse(await readFile(evidence, 'utf8'));
    assert.equal(written.verification_context, 'production_post_deploy');
    assert.equal(written.source_commit, commit);
    assert.equal(written.ci_run, 'https://github.com/owner/repo/actions/runs/77');
    assert.deepEqual(live, [commit, commit]);
    // The evidence path is required: --publish has nothing else to read.
    await assert.rejects(verifier.main(['--production'], deps), /evidence-out/);
    await assert.rejects(verifier.main(['--production', '--evidence-out', path.join(dir, 'failed.json')],
      { ...deps, runTests: () => ({ status: 1, stdout: 'not ok', stderr: '' }) }), /verification failed/);
    assert.equal(connections.length, 0);

    await verifier.main(['--publish', evidence], deps);
    assert.equal(connections.length, 1);
    assert.deepEqual(connections[0].queries, ['begin', 'insert into', 'commit']);
    assert.equal(connections[0].params[1][0], commit);
    assert.equal(connections[0].params[1][1], written.test_digest);
    assert.equal(connections[0].params[1][3], 'github-actions:77');
    assert.deepEqual(live.slice(-1), [commit], 'publish rechecks the live commit');

    // Evidence of another commit, run, context or result is never installed.
    let variant = 0;
    for (const [change, envChange] of [[{ source_commit: 'e'.repeat(40) }], [{ deployed_commit: 'e'.repeat(40) }],
      [{ verification_context: 'author_precheck' }], [{ verification_status: 'failed' }], [{ source_worktree_dirty: true }],
      [{ test_files: written.test_files.slice(1) }], [{ test_digest: 'x' }], [{}, { GITHUB_RUN_ID: '78' }], [{}, { GITHUB_SHA: 'e'.repeat(40) }]]) {
      const file = path.join(dir, `variant-${variant += 1}.json`);
      await writeFile(file, JSON.stringify({ ...written, ...change }));
      await assert.rejects(verifier.main(['--publish', file], { ...deps, env: { ...env, ...envChange } }), undefined, JSON.stringify(change));
    }
    await assert.rejects(verifier.main(['--publish', evidence], { ...deps, waitLive: async () => { throw new Error('live source commit mismatch'); } }));
    await assert.rejects(verifier.main(['--publish', path.join(dir, 'missing.json')], deps));
    assert.equal(connections.length, 1, 'a refused publish opened a database connection');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
