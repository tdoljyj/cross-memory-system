import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { settleProjectionLag, verifyReleaseState } from '../scripts/production-release-gate.mjs';
import { verifyProductionRenewRateLimits } from '../scripts/verify-production-renew-rate-limits.mjs';

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

// The production workflow already runs this file in preflight and deploy modes.
// This file is on the release path, so it reads the configuration only through
// readWranglerConfig (the guard below); the script's own reading of the raw
// JSONC is what Wrangler's build command runs, so the test runs that script.
test('N1 production preflight requires both renewal rate limit bindings', async t => {
  const { readWranglerConfig } = await import('../scripts/projection-postflight.mjs');
  const parsed = await readWranglerConfig(fileURLToPath(new URL('../wrangler.production.jsonc', import.meta.url)));
  const script = spawnSync(process.execPath,
    [fileURLToPath(new URL('../scripts/verify-production-renew-rate-limits.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(script.status, 0, script.stderr);
  const config = verifyProductionRenewRateLimits(JSON.stringify(parsed));
  assert.equal(config.build.command,
    'node scripts/verify-production-renew-rate-limits.mjs && node scripts/production-release-gate.mjs --pre-deploy');
  for (const name of ['CI_RENEW_SOURCE_LIMIT', 'CI_RENEW_IDENTITY_LIMIT']) {
    await t.test(name, () => {
      const configWithoutBinding = {
        ...config,
        ratelimits: config.ratelimits.filter(binding => binding.name !== name),
        vars: { ...config.vars, [name]: 'not-a-rate-limit-binding' },
      };
      assert.throws(() => verifyProductionRenewRateLimits(
        '// Production bindings\n' + JSON.stringify(configWithoutBinding)), {
        message: `production_release_blocked:renew_rate_limit_binding_missing:${name}`,
      });
    });
  }
});

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
    await json(db, { history, frontier, snapshots, reads, ...overrides });
    const result = spawnSync(process.execPath, [path.join(scripts, 'production-release-gate.mjs'),
      mode, '--evidence-out', evidence], { cwd: app, encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, CLUED_ATTESTATION_DATABASE_URL: db, GITHUB_ACTIONS: 'true',
        GITHUB_SHA: git('rev-parse', 'HEAD'), GITHUB_REF: 'refs/heads/main' } });
    assert.ifError(result.error);
    return { ...result, reads: (await readFile(reads, 'utf8')).trim().split('\n').filter(Boolean).map(Number),
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
  await t.test('部署后超时、任务失败、摘要不符分别立即阻断', async () => {
    for (const [snapshot, code] of [
      [lag(301_000), 'projection_backlog_overdue'],
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

test('积压始终未追平时只等三分钟，最后一帧的过期或失败立即生效', async () => {
  const key = 'global.priority_frontier';
  for (const outcome of ['pending', 'overdue', 'failed']) {
    let clock = now.getTime(), reads = 0;
    const snapshot = () => {
      const result = healthy().watchdog;
      result.observed_at = new Date(clock).toISOString();
      Object.assign(result.projections[0], { invalidation_revision: 95, source_digest_status: 'not_applicable',
        job_status: outcome === 'failed' && reads ? 'failed' : 'queued',
        stale_since: new Date(now.getTime() - (outcome === 'overdue' ? 290_000 : 30_000)).toISOString() });
      return result;
    };
    const state = await settleProjectionLag({ watchdog: snapshot(), now: () => clock,
      sleep: async ms => { assert.equal(ms, 10_000); clock += ms; },
      readWatchdog: async () => { reads++; return snapshot(); } });
    const code = outcome === 'failed' ? 'projection_job_failed' : 'projection_backlog_' + outcome;
    assert.equal(reads, outcome === 'pending' ? 18 : 1);
    assert.deepEqual(state.findings, [code + ':' + key]);
  }
});

test('发布门不依赖心跳，两个发布入口使用部署后状态模式', async () => {
  const gate = await readFile(new URL('../scripts/production-release-gate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gate, /heartbeat/i);
  const host = await readFile(new URL('../scripts/existing-release-v3-host/payload/release/' +
    'existing-release-entry-v1/v3-host/release-once.mjs', import.meta.url), 'utf8');
  const postflight = await readFile(new URL('../scripts/projection-postflight.mjs', import.meta.url), 'utf8');
  // The workflow reaches the gate's --post-deploy through the projection postflight.
  assert.match(productionWorkflow, /node scripts\/projection-postflight\.mjs/);
  assert.match(host, /production-release-gate\.mjs[' ,]+--post-deploy/);
  assert.match(postflight, /production-release-gate\.mjs/);
  assert.match(postflight, /'--post-deploy'/);
  for (const caller of [productionWorkflow, host, postflight]) assert.doesNotMatch(caller, /--min-heartbeat-at/);
});

test('libpq tools get sslmode=require where the node-postgres URL says no-verify', () => {
  const scripts = [...productionWorkflow.matchAll(/node -e '((?:const|let) url[^']*)'/g)].map((m) => m[1]);
  // Backup, migration login role, apply and (release door v1) the deploy grant step.
  assert.equal(scripts.length, 4);
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
    main = index('Deploy Clued production Worker'), live = index('Wait until production serves this commit'),
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
    assert.match(step, /\n        if: \$\{\{ (failure\(\) && \()?inputs\.mode == 'deploy' \|\| inputs\.mode == 'release'(\) && steps\.worker_versions\.outcome == 'success'( && \(steps\.first_deploy\.outcome == 'success' \|\| steps\.first_deploy\.outcome == 'failure'\))?)? \}\}\n/, step.split('\n')[0]);
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
  // Release door v1 (FABLE-release-identity-autonomous-20261119 §1.2): the door
  // is clued_private.release_door_v1, called with the migration database login
  // of the clued-release environment (no token). migrate consumes inside the
  // transaction of its first file; deploy consumes in its own step first.
  const steps = productionWorkflow.split(/\n      - /).slice(1);
  const names = steps.map((step) => step.split('\n')[0]);
  const migrateGrant = names.indexOf('name: Apply the named migrations');
  const deployGrant = names.indexOf('name: Consume the Owner Grant for this commit');
  assert.ok(migrateGrant > 0 && deployGrant > 0);
  assert.equal(names.indexOf('name: Consume the Owner Grant for the named migrations'), -1,
    'no grant is consumed outside the migration transaction');
  // A release takes no migrations, so only migrate uses the migration grant;
  // a release calls the grant check as deploy: the same door call, used once.
  assert.match(steps[migrateGrant], /if: \$\{\{ inputs\.mode == 'migrate' \}\}/);
  assert.match(steps[deployGrant], /if: \$\{\{ inputs\.mode == 'deploy' \|\| inputs\.mode == 'release' \}\}/);
  // The deploy grant step names deploy for both modes; nothing passes the mode through.
  assert.match(steps[deployGrant], /clued-release-door\.mjs input --mode deploy \|/);
  assert.match(steps[deployGrant], /clued-release-door\.mjs report --mode deploy /);
  assert.doesNotMatch(steps[deployGrant], /RELEASE_MODE|--mode "/);
  // What production serves is recorded, and a release whose settings a version
  // rollback cannot undo is refused, before the deploy grant is used.
  assert.ok(names.indexOf('name: Record the Worker versions production serves') > 0);
  assert.ok(names.indexOf('name: Record the Worker versions production serves') < deployGrant);
  for (const grant of [migrateGrant, deployGrant]) {
    assert.match(steps[grant], /CLUED_MIGRATION_DATABASE_URL: \$\{\{ secrets\.CLUED_MIGRATION_DATABASE_URL \}\}/);
    assert.match(steps[grant], /clued-release-door\.mjs/);
    assert.match(steps[grant], /input --mode (deploy|migrate)/);
    assert.match(steps[grant], /clued_private\.release_door_v1\(/);
  }
  assert.match(steps[migrateGrant], /MIGRATIONS: \$\{\{ inputs\.migrations \}\}/);
  // Steps that change production come after their grant. deploy also runs the
  // release gate first: run 37329072487 used its grant and then stopped at the gate.
  const gate = names.indexOf('name: Verify database prerequisites and record projection state');
  assert.ok(gate > 0 && gate < deployGrant);
  assert.match(steps[gate], /if: \$\{\{[^\n]*inputs\.mode == 'deploy'/);
  assert.match(steps[deployGrant], /NODE_OPTIONS: ''/);
  steps.forEach((step, index) => {
    if (/wrangler (deploy|queues create)/.test(step)) assert.ok(index > deployGrant, names[index]);
    if (/^name: Record migration database login role/.test(step)) assert.ok(index < migrateGrant, names[index]);
    if (/^name: Check (production database|Cloudflare deployment) credential/.test(step)) {
      assert.ok(index < deployGrant, names[index]);
    }
  });
  // The migration login connects once and records its database role (a name,
  // not a secret) before anything changes production.
  const check = steps.find((step) => step.startsWith('name: Record migration database login role'));
  assert.match(check, /psql "\$database_url" -v ON_ERROR_STOP=1 -X -tA -c 'select current_user'/);
  // The file reaches the server as COPY data on psql's standard input, never
  // through \\i or -f, so psql meta-commands in a file are not executed, and
  // the server checks its md5 against the file before it runs it.
  const apply = steps.find((step) => step.startsWith('name: Apply the named migrations'));
  assert.match(apply, /copy migration_lines\(line\) from stdin with \(format csv, delimiter e'\\x01', quote e'\\x02'\)/);
  // The door's input is the first COPY line, the file follows: neither is SQL text.
  assert.match(apply, /\{ printf '%s\\n' "\$door_input"; cat -- "\$file"; \} \| psql /);
  // One transaction per file, in this order: md5, consume (first file, door
  // present), execute, consume (bootstrap install), activation readiness,
  // probe, ledger. A file that breaks the door, or a missing grant, rolls back.
  const order = ["if md5(s) is distinct from '$expected' then raise exception",
    "if '$order' = 'consume' then", 'answer := clued_private.release_door_v1(door_input);', 'execute s;',
    "if '$order' = 'install' then", "to_regprocedure('clued_private.storage_conflict_require_scheduler_v1()')",
    "perform clued_private.storage_conflict_require_scheduler_v1();", "raise exception 'release_door_probe_failed'",
    'insert into supabase_migrations.schema_migrations', 'commit;'];
  const at = order.map((text) => apply.indexOf(text));
  assert.ok(at.every((value, index) => value >= 0 && (index === 0 || value > at[index - 1])), JSON.stringify(at));
  assert.match(apply, /if answer->>'consumed' is distinct from 'true' then raise exception 'release_grant_not_consumed'/);
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

// GitHub's && and || yield an operand, not a boolean, so `cond && 165 || 45`
// is a number; a step's `if` takes the truthiness of the same value.
function evaluateExpression(source, context) {
  const tokens = source.match(/'[^']*'|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*|\d+|==|!=|&&|\|\||[()!]/g);
  assert.equal(tokens.join(''), source.replace(/\s+/g, ''), `unsupported condition: ${source}`);
  let at = 0;
  const value = (token) => {
    if (token.startsWith("'")) return token.slice(1, -1);
    if (/^\d+$/.test(token)) return Number(token);
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
    return left;
  };
  const and = () => { let v = primary(); while (tokens[at] === '&&') { at++; const next = primary(); v = v && next; } return v; };
  or = () => { let v = and(); while (tokens[at] === '||') { at++; const next = and(); v = v || next; } return v; };
  const result = or();
  assert.equal(at, tokens.length, `unparsed condition: ${source}`);
  return result;
}
const evaluateCondition = (source, context) => Boolean(evaluateExpression(source, context));

// The release job's timeout-minutes for one dispatch mode, a literal or an
// expression over the inputs (GitHub allows `inputs` there).
const RELEASE_MODES = ['preflight', 'backup', 'source-capture', 'deploy', 'migrate', 'release'];
function jobTimeoutMinutes(mode) {
  const source = /\n {4}timeout-minutes: (.+)\n/.exec(productionWorkflow)?.[1];
  assert.ok(source, 'the release job has no timeout-minutes');
  const expression = /^\$\{\{ (.+) \}\}$/.exec(source)?.[1];
  const minutes = Number(expression ? evaluateExpression(expression, { inputs: { mode }, failed: false, outcomes: {} }) : source);
  assert.ok(Number.isInteger(minutes) && minutes > 0, `${mode}: ${source}`);
  return minutes;
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
  return { mode: context.inputs.mode, ran: ran.map((step) => step.name), steps: ran, conclusion: context.failed ? 'failure' : 'success' };
}

const RELEASE_ORDER = [
  'Check production database credential', 'Verify projection and MTPE behavior', 'Build exact Worker source',
  'Verify and build Kooyumi Connect release source', 'Verify database prerequisites and record projection state',
  'Check Cloudflare deployment credential', 'Record the Worker versions production serves',
  'Consume the Owner Grant for this commit', 'Ensure Storage job queue exists', 'Deploy Clued PDF extractor Worker',
  'Deploy Clued production Worker', 'Wait until production serves this commit',
  'Verify production serves the repository Agent contract', 'Verify the PDF extractor service binding',
  'Deploy Kooyumi Connect Worker', 'Verify Kooyumi Connect production release',
  'Verify projection currentness after deployment', 'Verify exact live commit and currentness transport', 'Preserve release evidence',
];
const ROLLBACK_STEP = 'Roll back the Workers after a failed deploy or verification';
const DRILL_STEP = 'Fail the rollback drill after every verification passed';
const G6_STEP = 'Verify exact live commit and currentness transport';
const G6_REPORT_STEP = 'Report an unconfirmed G6 attestation';
const RECORD_STEP = 'Record the Worker versions production serves';
const QUEUE_STEP = 'Ensure Storage job queue exists';
const VERIFY_STEPS = ['Wait until production serves this commit', 'Verify production serves the repository Agent contract',
  'Verify the PDF extractor service binding', 'Verify Kooyumi Connect production release', 'Verify projection currentness after deployment'];
const DEPLOY_STEPS = ['Deploy Clued PDF extractor Worker', 'Deploy Clued production Worker', 'Deploy Kooyumi Connect Worker'];
// Release door v1: the steps that call clued-release-door.mjs consume a grant
// (deploy in its own step, migrate inside the apply step's transaction).
const grantSteps = (run) => run.steps.filter((step) => /\n {10}[^\n#]*node (?:\.\.\/\.\.\/)?scripts\/ci\/clued-release-door\.mjs /.test(step.text));
const writesAttestation = (step) => /verify-currentness-transport\.mjs --production /.test(step.text);
const MIGRATION = '20261003170000_owner_grants_release_door.sql';
// The production wrangler configuration, read as Wrangler reads it (JSONC).
const PRODUCTION_WRANGLER = fileURLToPath(new URL('../wrangler.production.jsonc', import.meta.url));

test('release mode runs preflight, deploy and verification in one run and uses its one grant once', () => {
  const run = simulateRelease({ mode: 'release' });
  assert.equal(run.conclusion, 'success');
  const positions = RELEASE_ORDER.map((name) => run.ran.indexOf(name));
  assert.ok(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])),
    JSON.stringify(Object.fromEntries(RELEASE_ORDER.map((name, i) => [name, positions[i]]))));
  assert.deepEqual(grantSteps(run).map((step) => step.name), ['Consume the Owner Grant for this commit']);
  for (const name of ['Check production backup encryption credential', 'Verify backup and migration database identity',
    'Create and verify encrypted pre-migration backup', 'Require verified backup before migration',
    'Record migration database login role', 'Apply the named migrations']) {
    assert.ok(!run.ran.includes(name), name);
  }
  for (const name of [ROLLBACK_STEP, DRILL_STEP, G6_REPORT_STEP]) assert.ok(!run.ran.includes(name), name);
  const [deployGrant] = grantSteps(run);
  // A release consumes as deploy: the step names deploy for both modes.
  assert.match(deployGrant.text, /clued-release-door\.mjs input --mode deploy \|/);
  assert.doesNotMatch(deployGrant.text, /RELEASE_MODE/);
  assert.match(deployGrant.text, /NODE_OPTIONS: ''/);
  // Every credential is checked before the grant is used.
  const grantAt = run.ran.indexOf('Consume the Owner Grant for this commit');
  run.ran.forEach((name, index) => { if (/^Check .* credentials?$/.test(name)) assert.ok(index < grantAt, name); });
});

// Fable 1121 §6.1, review high 2: the G6 attestation is outside the rollback.
// It runs (and writes) only when everything before it succeeded, after the
// rollback step; its own failure does not roll production back.
test('the G6 attestation runs after the rollback step, only when everything succeeded, and its failure rolls nothing back', () => {
  const at = (run, name) => run.ran.indexOf(name);
  const g6 = releaseSteps.find((s) => s.name === G6_STEP);
  assert.equal(releaseSteps.filter(writesAttestation).length, 1);
  assert.ok(releaseSteps.indexOf(g6) > releaseSteps.findIndex((s) => s.name === ROLLBACK_STEP));
  // The step is main's verifier unchanged: verify and write in one.
  assert.match(g6.text, /\n {8}run: node scripts\/verify-currentness-transport\.mjs --production --evidence-out \.sites-runtime\/release-evidence\/currentness-attestation\.json(?:\n|$)/);
  assert.match(g6.text, /CLUED_ATTESTATION_DATABASE_URL: \$\{\{ secrets\.CLUED_ATTESTATION_DATABASE_URL_V2 \}\}/);
  assert.match(g6.text, /\n {8}id: g6\n/);
  for (const mode of ['deploy', 'release']) {
    const ok = simulateRelease({ mode });
    assert.equal(ok.conclusion, 'success');
    assert.equal(at(ok, G6_STEP), ok.ran.length - 2, 'only the evidence upload follows the attestation');
    // A failed deploy, check, queue or grant: the G6 step never writes.
    for (const failAt of ['Consume the Owner Grant for this commit', QUEUE_STEP, ...DEPLOY_STEPS, ...VERIFY_STEPS]) {
      const failed = simulateRelease({ mode }, failAt);
      assert.equal(failed.conclusion, 'failure');
      assert.deepEqual(failed.steps.filter(writesAttestation), [], `${mode}: ${failAt} wrote the attestation`);
      // Before the first deploy nothing changed production: no rollback (review M1).
      assert.equal(failed.ran.includes(ROLLBACK_STEP), !['Consume the Owner Grant for this commit', QUEUE_STEP].includes(failAt), `${mode}: ${failAt}`);
      assert.ok(!failed.ran.includes(G6_REPORT_STEP), `${mode}: ${failAt}`);
    }
    // The G6 step itself fails: the run fails, nothing rolls back, the summary says so.
    const g6Failed = simulateRelease({ mode }, G6_STEP);
    assert.equal(g6Failed.conclusion, 'failure');
    assert.ok(!g6Failed.ran.includes(ROLLBACK_STEP), `${mode}: a G6 failure rolled back`);
    assert.ok(at(g6Failed, G6_REPORT_STEP) > at(g6Failed, G6_STEP));
  }
  const report = releaseSteps.find((s) => s.name === G6_REPORT_STEP);
  assert.match(report.text, /GITHUB_STEP_SUMMARY/);
  assert.match(report.text, /not rolled back/);
  assert.match(report.text, /post-deploy attestation workflow/);
  assert.doesNotMatch(report.text, /secrets\./);
});

test('the rollback drill fails a fully verified release before the rollback and the attestation', () => {
  // The model runs no script: the drill step's `exit 1` (pinned below) is its failure.
  const drill = simulateRelease({ mode: 'release', rollback_drill: true }, DRILL_STEP);
  assert.equal(drill.conclusion, 'failure');
  assert.ok(drill.ran.includes(DRILL_STEP));
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
  // Its whole script: one message, then exit 1 (the text after it is the next step's comment).
  assert.match(step.text, /\n {8}run: \|\n {10}echo "[^"\n]*"\n {10}exit 1(?:\n {6}#[^\n]*)*\n?$/);
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
    ['Apply the named migrations']);
  assert.deepEqual(grantSteps(simulateRelease({ mode: 'deploy' })).map((s) => s.name), ['Consume the Owner Grant for this commit']);
  assert.ok(!simulateRelease({ mode: 'deploy' }).ran.includes('Apply the named migrations'));
  assert.ok(simulateRelease({ mode: 'backup' }).ran.includes('Create and verify encrypted pre-migration backup'));
});

test('a failed deploy or post-deploy verification rolls the Workers back and the release still fails', () => {
  for (const mode of ['release', 'deploy']) {
    for (const failAt of [...DEPLOY_STEPS, ...VERIFY_STEPS]) {
      const run = simulateRelease({ mode }, failAt);
      assert.equal(run.conclusion, 'failure', failAt);
      assert.ok(run.ran.includes(ROLLBACK_STEP), `${mode}: ${failAt} did not roll back`);
      assert.ok(run.ran.indexOf(ROLLBACK_STEP) > run.ran.indexOf(failAt));
      assert.ok(run.ran.indexOf(ROLLBACK_STEP) < run.ran.indexOf('Preserve release evidence'));
      if (failAt.startsWith('Wait until')) assert.ok(!run.ran.includes('Deploy Kooyumi Connect Worker'));
    }
    // Nothing was recorded: nothing to roll back to, and no grant was used.
    for (const failAt of ['Verify database prerequisites and record projection state', RECORD_STEP]) {
      const run = simulateRelease({ mode }, failAt);
      assert.equal(run.conclusion, 'failure');
      assert.ok(!run.ran.includes(ROLLBACK_STEP), failAt);
      assert.deepEqual(grantSteps(run), [], failAt);
      assert.ok(!run.ran.some((name) => /^Deploy |^Ensure Storage/.test(name)), failAt);
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

// Review high 1: creating the queue is not undone by a Worker rollback. In
// release mode the queue step only reads; a missing queue stops the release.
test('release never creates the Storage job queue; deploy still creates a missing one', async () => {
  const step = releaseSteps.find((s) => s.name === QUEUE_STEP);
  const script = step.text.slice(step.text.indexOf('run: |\n') + 'run: |\n'.length)
    .split('\n').filter((line) => /^ {10}/.test(line)).map((line) => line.slice(10)).join('\n');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'release-queue-'));
  try {
    const calls = path.join(dir, 'calls');
    // A stand-in npx: `queues info` fails as for a missing queue; every call is logged.
    await writeFile(path.join(dir, 'npx'), `#!/usr/bin/env bash\necho "$*" >> "${calls.replaceAll('\\', '/')}"\n[ "$3" = info ] && exit 1\nexit 0\n`);
    const run = async (mode) => {
      await writeFile(calls, '');
      const result = spawnSync('bash', ['-c', `chmod +x ./npx; PATH="$PWD:$PATH"; ${script}`], { cwd: dir, encoding: 'utf8',
        env: { ...process.env, RELEASE_MODE: mode } });
      return { status: result.status, calls: (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean) };
    };
    const release = await run('release');
    assert.notEqual(release.status, 0);
    assert.deepEqual(release.calls, ['wrangler queues info clued-storage-jobs']);
    const deploy = await run('deploy');
    assert.equal(deploy.status, 0);
    assert.deepEqual(deploy.calls, ['wrangler queues info clued-storage-jobs', 'wrangler queues create clued-storage-jobs']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(step.text, /RELEASE_MODE: \$\{\{ inputs\.mode \}\}/);
});

// Fable 1121 item 6: a step timeout is a failure and reaches the rollback; a
// job timeout is a cancellation and does not. So every step a deploy or
// release runs has its own timeout, and the job outlasts the longest path.
test('every deploy and release step has a timeout, and the job timeout covers the longest path', async () => {
  const workers = await import('../scripts/release-worker-versions.mjs');
  const postflight = await import('../scripts/projection-postflight.mjs');
  const minutes = (step) => Number(/\n {8}timeout-minutes: (\d+)\n/.exec(`\n${step.text}\n`)?.[1]);
  // Every way through: success, the G6 step failing, and a failure at each
  // step after the record, which runs the rollback.
  const paths = [simulateRelease({ mode: 'deploy' }), simulateRelease({ mode: 'release' }),
    simulateRelease({ mode: 'release' }, G6_STEP),
    ...[...RELEASE_ORDER.slice(RELEASE_ORDER.indexOf(RECORD_STEP) + 1, -2)].map((name) => simulateRelease({ mode: 'release' }, name)),
    simulateRelease({ mode: 'release', rollback_drill: true }, DRILL_STEP)];
  for (const run of paths) {
    const jobTimeout = jobTimeoutMinutes(run.mode);
    for (const step of run.steps) assert.ok(minutes(step) > 0, `${step.name} has no timeout-minutes`);
    const total = run.steps.reduce((sum, step) => sum + minutes(step), 0);
    // Five minutes for the runner's own set-up and post steps.
    assert.ok(jobTimeout >= total + 5, JSON.stringify({ jobTimeout, total, last: run.ran.at(-1) }));
  }
  const step = (name) => releaseSteps.find((s) => s.name === name);
  // The edge window is PROPAGATION_WINDOW_MS (Task df6dc467; its own test
  // fails until main carries it); 120 s is its value there.
  const live = await import('../scripts/currentness-live-build.mjs');
  const rollbackMs = workers.rollbackWorstCaseMs(live.PROPAGATION_WINDOW_MS ?? 120_000);
  assert.ok(minutes(step(ROLLBACK_STEP)) * 60_000 >= rollbackMs, String(rollbackMs));
  assert.ok(minutes(step(RECORD_STEP)) * 60_000 >= workers.RECORD_WORST_CASE_MS, String(workers.RECORD_WORST_CASE_MS));
  // Projection: the window (Cron period + 2 minutes) plus five, as Fable 1121 §6.1 sets it.
  const production = await postflight.readWranglerConfig(PRODUCTION_WRANGLER);
  const windowMinutes = postflight.windowMs(postflight.cronPeriodMinutes(production)) / 60_000;
  assert.equal(minutes(step('Verify projection currentness after deployment')), windowMinutes + 5);
  assert.ok(windowMinutes * 60_000 + postflight.CALL_TIMEOUT_MS <= (windowMinutes + 5) * 60_000);
});

// Review of #1121 after main, B1: the longer job timeout is for a deploy or a
// release with its rollback. Every other mode keeps main's 45 minutes: the
// migrate steps have no step timeout, so a stalled migration (DDL waiting on a
// lock) must still free the concurrency group that every deploy waits on.
test('only deploy and release get the longer job timeout; every other mode keeps 45 minutes', () => {
  const options = /\n {8}options:\n((?: {10}- \S+\n)+)/.exec(productionWorkflow)?.[1].trim().split('\n').map((line) => line.trim().slice(2));
  assert.deepEqual(options, RELEASE_MODES, 'a new mode must be placed on one side of the job timeout');
  for (const mode of RELEASE_MODES) {
    if (mode === 'deploy' || mode === 'release') assert.ok(jobTimeoutMinutes(mode) > 45, mode);
    else assert.equal(jobTimeoutMinutes(mode), 45, mode);
  }
});

// Review of #1121 after main, M1: the versions are recorded before the grant,
// but production changes only from the first deploy step. A failure before it
// (the release door refusing the grant, the queue check) rolls nothing back,
// so it reads nothing again, waits no propagation window and raises no
// "rolled back" alarm for a run that never touched production.
test('a failure before the first deploy step runs no rollback; from the first deploy on every failure does', () => {
  const firstDeploy = releaseSteps.find((s) => /\bwrangler deploy\b/.test(s.text));
  assert.equal(firstDeploy?.name, DEPLOY_STEPS[0]);
  for (const mode of ['deploy', 'release']) {
    for (const failAt of ['Consume the Owner Grant for this commit', QUEUE_STEP]) {
      const run = simulateRelease({ mode }, failAt);
      assert.equal(run.conclusion, 'failure', `${mode}: ${failAt}`);
      assert.ok(!run.ran.includes(ROLLBACK_STEP), `${mode}: ${failAt} rolled back before any deploy`);
      assert.ok(!run.ran.some((name) => DEPLOY_STEPS.includes(name)), `${mode}: ${failAt}`);
    }
    // The first deploy failing (a step timeout is a failure too) may have changed production.
    for (const failAt of [...DEPLOY_STEPS, ...VERIFY_STEPS]) {
      assert.ok(simulateRelease({ mode }, failAt).ran.includes(ROLLBACK_STEP), `${mode}: ${failAt} did not roll back`);
    }
  }
  assert.ok(simulateRelease({ mode: 'release', rollback_drill: true }, DRILL_STEP).ran.includes(ROLLBACK_STEP));
});

const HEAD_COMMIT = 'c'.repeat(40), EDGE_COMMIT = 'e'.repeat(40);
// What the public edge serves: the main Worker's /healthz and Connect's smoke.
const servedEdge = (commit = EDGE_COMMIT, revision = 'r1') =>
  ({ 'clued-cloud': { source_commit: commit }, 'clued-connect': { source_commit: commit, revision } });
// `git diff --quiet <commit> HEAD -- <files>` as a function: true when identical.
const gitSame = (differs = []) => async (commit, files) => {
  const { WRANGLER_CONFIGS } = await import('../scripts/release-worker-versions.mjs');
  assert.deepEqual(files, WRANGLER_CONFIGS);
  return !differs.includes(commit);
};
const noSleep = async () => {};

test('the rollback restores each changed Worker to its recorded version, last deployed first, and reports it', async () => {
  const { WORKERS, main, recordVersions, rollbackVersions, renderRollbackSummary, servedVersion } =
    await import('../scripts/release-worker-versions.mjs');
  // The names are the ones the deploy steps' configurations publish (read as Wrangler reads them).
  const { readWranglerConfig } = await import('../scripts/projection-postflight.mjs');
  const { WRANGLER_CONFIGS } = await import('../scripts/release-worker-versions.mjs');
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  for (const [index, { name }] of WORKERS.entries()) {
    assert.equal((await readWranglerConfig(path.join(repository, WRANGLER_CONFIGS[index]))).name, name, name);
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
  const wait = noSleep;
  const env = { GITHUB_SHA: HEAD_COMMIT, GITHUB_RUN_ID: '42' };
  const edges = { readEdges: async () => servedEdge(), gitSameFiles: gitSame(), sleep: noSleep, windowMs: 120_000 };
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
  // The declared limit: hand-made changes outside the repository are not restored.
  assert.match(summary, /not restored by a rollback/);
  // A refused rollback is reported and fails the step.
  const refused = await rollbackVersions({ recorded, wait, env, ...edges,
    wrangler: fakeCloudflare({ ...before, 'clued-cloud': id(5) }, { failRollback: ['clued-cloud'] }).wrangler });
  assert.equal(refused.ok, false);
  assert.match(renderRollbackSummary(refused), /rollback_failed: rollback refused[\s\S]*not restored/i);
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

// Fable 1121 §6.1, review high 1: a release runs only when the three wrangler
// production configurations are byte for byte those of the commit the edge
// serves (git diff, no key list). Otherwise it stops before the grant.
test('a release whose wrangler configuration differs from the commit the edge serves is refused before anything is deployed', async () => {
  const { recordVersions } = await import('../scripts/release-worker-versions.mjs');
  const source = await readFile(new URL('../scripts/release-worker-versions.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /UNVERSIONED_KEYS|triggers|queues\.consumers/, 'no key-by-key comparison');
  const id = (n) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
  const versions = { 'clued-storage-pdf': id(1), 'clued-cloud': id(2), 'clued-connect': id(3) };
  let deploys = 0;
  const wrangler = async (args) => {
    if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: versions[args[3]], percentage: 100 }] }) };
    deploys += 1; return { status: 0, stdout: '' };
  };
  const base = { wrangler, wait: noSleep, env: { GITHUB_SHA: HEAD_COMMIT }, readEdges: async () => servedEdge() };
  // The edge commits differ from HEAD in any of the three files.
  await assert.rejects(recordVersions({ ...base, mode: 'release', gitSameFiles: gitSame([EDGE_COMMIT]) }),
    (error) => /deploy mode/.test(error.message) && /nothing was deployed/.test(error.message));
  // Connect's edge on another commit than the main Worker's: both are compared.
  const other = 'f'.repeat(40);
  const split = { ...servedEdge(), 'clued-connect': { source_commit: other, revision: 'r1' } };
  await assert.rejects(recordVersions({ ...base, mode: 'release', readEdges: async () => split, gitSameFiles: gitSame([other]) }), /nothing was deployed/);
  // git cannot compare (unknown commit): refused.
  await assert.rejects(recordVersions({ ...base, mode: 'release', gitSameFiles: async () => { throw new Error('bad object'); } }), /nothing was deployed/);
  // The edge commit cannot be read: refused.
  for (const edge of [{ ...servedEdge(), 'clued-cloud': { error: 'timeout' } }, { ...servedEdge(), 'clued-connect': { error: 'http 503' } }]) {
    await assert.rejects(recordVersions({ ...base, mode: 'release', readEdges: async () => edge, gitSameFiles: gitSame() }), /nothing was deployed/);
    const recorded = await recordVersions({ ...base, mode: 'deploy', readEdges: async () => edge, gitSameFiles: gitSame() });
    assert.ok(Object.values(recorded.edge).some((value) => value.error));
  }
  // deploy keeps publishing such commits and records that the files differ.
  const deployed = await recordVersions({ ...base, mode: 'deploy', gitSameFiles: gitSame([EDGE_COMMIT]) });
  assert.equal(deployed.config_identical, false);
  const same = await recordVersions({ ...base, mode: 'release', gitSameFiles: gitSame() });
  assert.equal(same.config_identical, true);
  await assert.rejects(recordVersions({ ...base, mode: 'preview', gitSameFiles: gitSame() }), /mode/);
  assert.equal(deploys, 0);
  // In the workflow, a refused record means no grant used and nothing deployed.
  const refused = simulateRelease({ mode: 'release' }, RECORD_STEP);
  assert.deepEqual(grantSteps(refused), []);
  assert.ok(!refused.ran.some((name) => /^Deploy |Ensure Storage/.test(name)));
});

// Fable 1121 §6.1, review medium 1: the conclusion comes from one reading
// taken a whole propagation window after the last rollback action, never
// from the first match; each Worker's result is on disk as soon as it is done.
test('the rollback concludes from one final reading after the propagation window', async () => {
  const { CONTRACT, WORKERS, rollbackVersions, renderRollbackSummary, main } = await import('../scripts/release-worker-versions.mjs');
  const version = (n) => `${n.repeat(8)}-0000-4000-8000-${n.repeat(12)}`;
  const recorded = { contract: CONTRACT, mode: 'release', source_commit: HEAD_COMMIT, edge: servedEdge(),
    workers: WORKERS.map(({ name }, i) => ({ name, version_id: version(String(i + 1)) })) };
  const rollingBack = () => {
    const served = Object.fromEntries(WORKERS.map(({ name }) => [name, version('9')]));
    return { served, wrangler: async (args) => {
      if (args[0] === 'rollback') { served[args[3]] = args[1]; return { status: 0, stdout: '' }; }
      return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: served[args[3]], percentage: 100 }] }) };
    } };
  };
  // The edge serves the recorded commits at first, then the failed release again.
  let slept = 0;
  const flipping = await rollbackVersions({ recorded, wrangler: rollingBack().wrangler, wait: noSleep, env: {}, windowMs: 120_000,
    sleep: async (ms) => { slept += ms; }, readEdges: async () => (slept < 120_000 ? servedEdge() : servedEdge(HEAD_COMMIT, 'r2')) });
  assert.equal(slept, 120_000, 'one fixed window before the reading');
  assert.equal(flipping.ok, false);
  assert.notEqual(flipping.status, 'restored');
  assert.ok(flipping.mismatches.some((m) => /clued-cloud/.test(m)));
  assert.doesNotMatch(renderRollbackSummary(flipping), /serves the recorded versions again/);
  // A version that moves again after its rollback (a late deploy) is caught by the same reading.
  const cloud = rollingBack();
  let reads = 0;
  const late = await rollbackVersions({ recorded, wait: noSleep, env: {}, windowMs: 120_000, sleep: noSleep, readEdges: async () => servedEdge(),
    wrangler: async (args) => {
      if (args[0] === 'deployments' && args[3] === 'clued-cloud' && ++reads > 2) return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: version('8'), percentage: 100 }] }) };
      return cloud.wrangler(args);
    } });
  assert.equal(late.status, 'not_restored');
  assert.ok(late.mismatches.some((m) => /clued-cloud/.test(m)));
  // Versions and edge as recorded in that reading: restored.
  const fine = await rollbackVersions({ recorded, wrangler: rollingBack().wrangler, wait: noSleep, env: {}, windowMs: 120_000,
    sleep: noSleep, readEdges: async () => servedEdge() });
  assert.equal(fine.status, 'restored');
  assert.deepEqual(fine.mismatches, []);
  // Connect back on its commit but another revision is not restored.
  const revision = await rollbackVersions({ recorded, wrangler: rollingBack().wrangler, wait: noSleep, env: {}, windowMs: 120_000,
    sleep: noSleep, readEdges: async () => servedEdge(EDGE_COMMIT, 'r2') });
  assert.equal(revision.status, 'not_restored');
  // An edge that was unreadable when recorded cannot be confirmed.
  const blind = await rollbackVersions({ recorded: { ...recorded, edge: { ...servedEdge(), 'clued-connect': { error: 'timeout' } } },
    wrangler: rollingBack().wrangler, wait: noSleep, env: {}, windowMs: 120_000, sleep: noSleep, readEdges: async () => servedEdge() });
  assert.equal(blind.status, 'not_restored');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'worker-final-'));
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    await writeFile(path.join(dir, 'v.json'), JSON.stringify(recorded));
    // The CLI exits non-zero when the final reading does not match.
    assert.equal(await main(['rollback', '--from', path.join(dir, 'v.json'), '--out', path.join(dir, 'r.json')], { wrangler: rollingBack().wrangler,
      wait: noSleep, env: {}, readEdges: async () => servedEdge(HEAD_COMMIT), windowMs: 120_000, sleep: noSleep }), 1);
    // Killed half way (here: while reading the PDF extractor): the Workers
    // already handled are in the evidence file.
    const cloudHalf = rollingBack();
    await assert.rejects(main(['rollback', '--from', path.join(dir, 'v.json'), '--out', path.join(dir, 'half.json')], {
      env: {}, readEdges: async () => servedEdge(), windowMs: 120_000, sleep: noSleep,
      wait: async () => { throw new Error('synthetic kill'); },
      wrangler: async (args) => (args[0] === 'deployments' && args[3] === 'clued-storage-pdf'
        ? { status: 1, stdout: '', stderr: 'unreadable' } : cloudHalf.wrangler(args)) }), /synthetic kill/);
    const half = JSON.parse(await readFile(path.join(dir, 'half.json'), 'utf8'));
    assert.deepEqual(half.workers.map((w) => [w.name, w.action]), [['clued-connect', 'rolled_back'], ['clued-cloud', 'rolled_back']]);
    assert.equal(half.status, 'in_progress');
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

// Fable 1121 §6.1, review medium 2: the gate stays as on main. A wrapper calls
// its --post-deploy until one Cron period plus two minutes has passed, while
// its only findings are a backlog, and always leaves a conclusion file.
test('the projection postflight waits one Cron period plus two minutes around the unchanged gate', async () => {
  const postflight = await import('../scripts/projection-postflight.mjs');
  const { cronPeriodMinutes, windowMs, runPostflight, main: postflightMain, CALL_TIMEOUT_MS } = postflight;
  const production = await postflight.readWranglerConfig(PRODUCTION_WRANGLER);
  assert.equal(cronPeriodMinutes(production), 10);
  assert.equal(windowMs(10), 12 * 60_000);
  for (const triggers of [undefined, {}, { crons: [] }, { crons: ['0 * * * *'] }, { crons: ['*/10 * * * *', '*/5 * * * *'] },
    { crons: ['*/0 * * * *'] }, { crons: ['*/60 * * * *'] }, { crons: ['*/10 */2 * * *'] }]) {
    assert.throws(() => cronPeriodMinutes({ triggers }), /cron_schedule_unsupported/, JSON.stringify(triggers));
  }
  const backlog = 'production_release_blocked:projection_backlog_overdue:global.priority_frontier,projection_backlog_pending:global.__aggregate__\n';
  // Each gate call takes three minutes of the clock (its own internal wait).
  const harness = (answer) => {
    let clock = 0; const calls = [];
    return { now: () => clock, sleep: async (ms) => { clock += ms; }, calls, elapsed: () => clock,
      runGate: async () => { calls.push(clock); const result = answer(clock); clock += result.ms ?? 180_000; return result; } };
  };
  // No request-side wake; the next tick lands at minute 9: passes.
  const tick = harness((clock) => (clock >= 9 * 60_000 ? { status: 0, stderr: '', ms: 5_000 } : { status: 1, stderr: backlog }));
  const passed = await runPostflight({ periodMinutes: 10, ...tick });
  assert.equal(passed.status, 'passed');
  assert.ok(tick.elapsed() <= 12 * 60_000 + CALL_TIMEOUT_MS);
  // Still a backlog when the window ends: fails, after the window, with the last reasons.
  const stuck = harness(() => ({ status: 1, stderr: backlog }));
  const failed = await runPostflight({ periodMinutes: 10, ...stuck });
  assert.equal(failed.status, 'failed');
  assert.ok(stuck.calls.at(-1) < 12 * 60_000 && stuck.elapsed() >= 12 * 60_000);
  assert.match(failed.reason, /projection_backlog/);
  // A failed job (or anything but a backlog) fails at once.
  for (const stderr of ['production_release_blocked:projection_job_failed:global.priority_frontier\n',
    'production_release_blocked:projection_backlog_pending:global.priority_frontier,projection_digest_mismatch:global.__aggregate__\n',
    'production_release_blocked:unexpected_error\n', '']) {
    const once = harness(() => ({ status: 1, stderr }));
    const result = await runPostflight({ periodMinutes: 10, ...once });
    assert.equal(result.status, 'failed', stderr);
    assert.equal(once.calls.length, 1, stderr);
  }
  // A stalled call is cut by the child timeout and counts as a failure.
  const stalled = harness(() => ({ status: null, timedOut: true, stderr: '', ms: CALL_TIMEOUT_MS }));
  const cut = await runPostflight({ periodMinutes: 10, ...stalled });
  assert.equal(cut.status, 'failed');
  assert.equal(stalled.calls.length, 1);
  assert.match(cut.reason, /timeout/);
  // The real call runs the gate's --post-deploy with a child timeout.
  let options;
  postflight.spawnGate('/tmp/attempt.json', { spawn: (file, args, opts) => { options = { file, args, opts }; return { status: 0, stdout: '', stderr: '' }; } });
  assert.equal(options.file, process.execPath);
  assert.ok(options.args.some((a) => a.replaceAll('\\', '/').endsWith('scripts/production-release-gate.mjs')));
  assert.ok(options.args.includes('--post-deploy'));
  assert.equal(options.opts.timeout, CALL_TIMEOUT_MS);
  // The CLI writes a conclusion file whether it passes or fails.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'projection-postflight-'));
  try {
    const out = path.join(dir, 'postflight.json');
    const failing = harness(() => ({ status: 1, stderr: backlog }));
    assert.equal(await postflightMain(['--evidence-out', out], { periodMinutes: 10, ...failing, log: () => {} }), 1);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'failed');
    const passing = harness(() => ({ status: 0, stderr: '', ms: 5_000 }));
    assert.equal(await postflightMain(['--evidence-out', out], { periodMinutes: 10, ...passing, log: () => {} }), 0);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'passed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('migration cannot consume a grant or apply without a successful verified encrypted backup', async () => {
  const steps=productionWorkflow.split(/\n      - /).slice(1);
  const index=name=>steps.findIndex(s=>s.startsWith('name: '+name+'\n'));
  const encryption=index('Check production backup encryption credential');
  const target=index('Verify backup and migration database identity');
  const backup=index('Create and verify encrypted pre-migration backup');
  const gate=index('Require verified backup before migration');
  // The grant is consumed inside the apply step's transaction (release door v1).
  const apply=index('Apply the named migrations');
  assert.ok(encryption>=0&&encryption<target&&target<backup&&backup<gate&&gate<apply);
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
    readEdges: async () => { edgeReads += 1; return servedEdge(); }, windowMs: 120_000, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_restored');
  // The final reading still happens, once, as evidence.
  assert.equal(edgeReads, 1);
  assert.ok(result.mismatches.some((m) => /clued-connect/.test(m)));
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
  const result = await rollbackVersions({ recorded, wait: async () => {}, env: {}, readEdges: async () => servedEdge(), windowMs: 120_000, sleep: noSleep, wrangler: async (args) => {
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

// Round-3 review, medium 1: a kill while the progress file is being written
// must not lose the progress already on disk (write to a temporary file, then
// rename over the old one).
test('rollback progress is written atomically: a failed write keeps the previous progress', async () => {
  const { CONTRACT, WORKERS, main } = await import('../scripts/release-worker-versions.mjs');
  const realFs = (await import('node:fs')).default;
  const version = (n) => `${n.repeat(8)}-0000-4000-8000-${n.repeat(12)}`;
  const recorded = { contract: CONTRACT, mode: 'release', source_commit: HEAD_COMMIT, edge: servedEdge(),
    workers: WORKERS.map(({ name }, i) => ({ name, version_id: version(String(i + 1)) })) };
  const served = Object.fromEntries(WORKERS.map(({ name }) => [name, version('9')]));
  const wrangler = async (args) => {
    if (args[0] === 'rollback') { served[args[3]] = args[1]; return { status: 0, stdout: '' }; }
    return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: served[args[3]], percentage: 100 }] }) };
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'worker-atomic-'));
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const from = path.join(dir, 'v.json'), out = path.join(dir, 'r.json');
    await writeFile(from, JSON.stringify(recorded));
    let writes = 0;
    // The second progress write is killed half way through.
    const fileSystem = { ...realFs, writeFileSync: (file, data, ...rest) => {
      writes += 1;
      if (writes === 2) { realFs.writeFileSync(file, String(data).slice(0, 12)); throw new Error('synthetic kill during the evidence write'); }
      return realFs.writeFileSync(file, data, ...rest);
    } };
    await assert.rejects(main(['rollback', '--from', from, '--out', out], { wrangler, wait: noSleep, env: {},
      readEdges: async () => servedEdge(), windowMs: 120_000, sleep: noSleep, fileSystem }), /synthetic kill/);
    const kept = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(kept.status, 'in_progress');
    assert.deepEqual(kept.workers.map((w) => w.name), ['clued-connect']);
  } finally {
    console.log = log; console.error = error;
    await rm(dir, { recursive: true, force: true });
  }
});

// Round-3 review, medium 2: "restored" needs both edge endpoints compared. A
// record without both is not a record of this release.
test('the rollback refuses a record without both edge endpoints', async () => {
  const { CONTRACT, WORKERS, rollbackVersions, main } = await import('../scripts/release-worker-versions.mjs');
  const version = (n) => `${n.repeat(8)}-0000-4000-8000-${n.repeat(12)}`;
  const base = { contract: CONTRACT, mode: 'release', source_commit: HEAD_COMMIT,
    workers: WORKERS.map(({ name }, i) => ({ name, version_id: version(String(i + 1)) })) };
  const wrangler = async (args) => ({ status: 0, stdout: JSON.stringify({ versions: [{
    version_id: base.workers.find((w) => w.name === args[3]).version_id, percentage: 100 }] }) });
  const options = { wrangler, wait: noSleep, env: {}, readEdges: async () => servedEdge(), windowMs: 120_000, sleep: noSleep };
  for (const edge of [{}, { 'clued-cloud': servedEdge()['clued-cloud'] }, { 'clued-connect': servedEdge()['clued-connect'] },
    { ...servedEdge(), 'clued-connect': null }]) {
    await assert.rejects(rollbackVersions({ recorded: { ...base, edge }, ...options }), /not a valid record/, JSON.stringify(edge));
  }
  // Both present (even one unreadable at record time) is a valid record; the unreadable one is not restored.
  assert.equal((await rollbackVersions({ recorded: { ...base, edge: servedEdge() }, ...options })).status, 'restored');
  assert.equal((await rollbackVersions({ recorded: { ...base, edge: { ...servedEdge(), 'clued-connect': { error: 'timeout' } } }, ...options })).status, 'not_restored');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'worker-edge-record-'));
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    // The CLI refuses it, exits non-zero and leaves a not_restored result with the reason.
    for (const edge of [{}, { 'clued-cloud': servedEdge()['clued-cloud'] }, { ...servedEdge(), 'clued-connect': null }]) {
      const out = path.join(dir, 'r.json');
      await rm(out, { force: true });
      await writeFile(path.join(dir, 'v.json'), JSON.stringify({ ...base, edge }));
      assert.equal(await main(['rollback', '--from', path.join(dir, 'v.json'), '--out', out], options), 1, JSON.stringify(edge));
      const written = JSON.parse(await readFile(out, 'utf8'));
      assert.equal(written.status, 'not_restored', JSON.stringify(edge));
      assert.equal(written.ok, false);
      assert.match(written.reason, /not a valid record/);
    }
  } finally {
    console.log = log; console.error = error;
    await rm(dir, { recursive: true, force: true });
  }
});

// Round-3 review, medium 3: the wrapper reads wrangler.production.jsonc as
// Wrangler does (comments, trailing commas), and every failure, an exception
// included, still leaves a conclusion file before the non-zero exit.
test('the projection postflight reads JSONC as Wrangler does and always writes its conclusion', async () => {
  const { main: postflightMain, readWranglerConfig } = await import('../scripts/projection-postflight.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'projection-jsonc-'));
  const quiet = () => {};
  try {
    const config = path.join(dir, 'production-config.jsonc');
    await writeFile(config, '{\n  // the Builder fallback\n  "name": "clued-cloud", /* block */\n  "triggers": { "crons": ["*/10 * * * *",], },\n}\n');
    const out = path.join(dir, 'postflight.json');
    let calls = 0;
    const passing = { readConfig: () => readWranglerConfig(config), log: quiet, now: () => 0, sleep: noSleep,
      runGate: async () => { calls += 1; return { status: 0, stderr: '' }; } };
    assert.equal(await postflightMain(['--evidence-out', out], passing), 0);
    assert.equal(calls, 1);
    const passed = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(passed.status, 'passed');
    assert.equal(passed.period_minutes, 10);
    // An exception in the gate call (say, unreadable attempt evidence): a conclusion, then exit 1.
    await rm(out);
    assert.equal(await postflightMain(['--evidence-out', out], { ...passing,
      runGate: async () => { throw new Error('synthetic evidence parse failure'); } }), 1);
    const thrown = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(thrown.status, 'failed');
    assert.match(thrown.reason, /synthetic evidence parse failure/);
    // An unreadable or invalid configuration: a conclusion, then exit 1.
    for (const text of ['{ "triggers": ', '{ "triggers": { "crons": ["0 * * * *"] } }']) {
      await writeFile(config, text);
      await rm(out, { force: true });
      assert.equal(await postflightMain(['--evidence-out', out], passing), 1, text);
      assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'failed', text);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Round-4 review: cleaning up the scratch directory (EBUSY, EACCES) must not
// lose the conclusion. It is written first; a failed clean-up only adds a warning.
test('the projection postflight writes its conclusion before it cleans up, and a failed clean-up changes nothing', async () => {
  const { main: postflightMain } = await import('../scripts/projection-postflight.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'projection-cleanup-'));
  try {
    const out = path.join(dir, 'postflight.json');
    for (const [answer, code, status] of [[{ status: 0, stderr: '' }, 0, 'passed'],
      [{ status: 1, stderr: 'production_release_blocked:projection_job_failed:global.priority_frontier\n' }, 1, 'failed']]) {
      await rm(out, { force: true });
      const lines = [];
      let cleaned = 0;
      const result = await postflightMain(['--evidence-out', out], { periodMinutes: 10, now: () => 0, sleep: noSleep,
        log: (line) => lines.push(line), runGate: async () => answer,
        removeScratch: (directory) => { cleaned += 1; assert.ok(fs.existsSync(out), 'the conclusion is on disk before the clean-up');
          fs.rmSync(directory, { recursive: true, force: true }); // the test leaves nothing behind
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); } });
      assert.equal(cleaned, 1);
      assert.equal(result, code);
      assert.equal(JSON.parse(await readFile(out, 'utf8')).status, status);
      assert.equal(lines.filter((line) => /warning/i.test(line) && /EBUSY/.test(line)).length, 1, lines.join('\n'));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Round-4 review: the release's own pre-deploy tests read the production
// configuration through the same reader as the wrapper, so legal JSONC
// (comments, trailing commas) in it cannot fail them.
// Hand-written JSONC: a comment before each key, a trailing comma after every
// member and element, the last top-level member included.
function toJsonc(value, pad = '') {
  if (Array.isArray(value)) {
    return value.length ? `[\n${value.map((item) => `${pad}  ${toJsonc(item, pad + '  ')},`).join('\n')}\n${pad}]` : '[]';
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length ? `{\n${entries.map(([key, item]) =>
      `${pad}  // ${key}\n${pad}  ${JSON.stringify(key)}: ${toJsonc(item, pad + '  ')}, /* ${key} */`).join('\n')}\n${pad}}` : '{}';
  }
  return JSON.stringify(value);
}

// A JSONC copy of a wrangler configuration: the same settings with comments
// and trailing commas. Built from the configuration as Wrangler reads it, so
// the original's own punctuation (a trailing comma already there) cannot break it.
async function jsoncCopyOf(read) {
  return `// production configuration\n${toJsonc(await read())}\n`;
}

test('the release tests read the wrangler configuration with the wrapper\'s JSONC reader', async () => {
  const postflight = await import('../scripts/projection-postflight.mjs');
  const source = await readFile(new URL(import.meta.url), 'utf8');
  assert.doesNotMatch(source, /JSON\.parse\(await readFile\(new URL\('\.\.\/wrangler\.production\.jsonc'/);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wrangler-jsonc-'));
  try {
    // The same configuration with comments and trailing commas.
    const jsonc = await jsoncCopyOf(() => postflight.readWranglerConfig(PRODUCTION_WRANGLER));
    assert.throws(() => JSON.parse(jsonc));
    const copy = path.join(dir, 'production-config.jsonc');
    await writeFile(copy, jsonc);
    const read = await postflight.readWranglerConfig(copy);
    assert.deepEqual(read, await postflight.readWranglerConfig(PRODUCTION_WRANGLER));
    assert.equal(postflight.cronPeriodMinutes(read), 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Round-5 review: the configuration itself may already carry a top-level
// trailing comma and comments (Wrangler accepts both). Every release test that
// reads it, the JSONC copy included, must still pass.
test('a production configuration with a top-level trailing comma and comments passes the release tests that read it', async () => {
  const postflight = await import('../scripts/projection-postflight.mjs');
  const parsed = await postflight.readWranglerConfig(PRODUCTION_WRANGLER);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wrangler-trailing-'));
  try {
    const configured = path.join(dir, 'production-config.jsonc');
    const text = `${toJsonc(parsed)}\n`;
    assert.match(text, /, \/\* observability \*\/\n\}\n$/, 'the last top-level member has a trailing comma');
    await writeFile(configured, text);
    // Wrangler reads it as the same configuration.
    const read = await postflight.readWranglerConfig(configured);
    assert.deepEqual(read, parsed);
    // The budget and window tests' computation over it.
    assert.equal(postflight.windowMs(postflight.cronPeriodMinutes(read)), 12 * 60_000);
    // The JSONC-copy test's fixture built from it is still read as the same configuration.
    const copy = path.join(dir, 'copy.jsonc');
    await writeFile(copy, await jsoncCopyOf(() => postflight.readWranglerConfig(configured)));
    assert.deepEqual(await postflight.readWranglerConfig(copy), parsed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Round-5 review, low: a failed conclusion write still removes the scratch
// directory; an invalid rollback record is not announced as rolled back.
test('the projection postflight cleans up even when the conclusion cannot be written', async () => {
  const { main: postflightMain } = await import('../scripts/projection-postflight.mjs');
  let cleaned = 0;
  await assert.rejects(postflightMain(['--evidence-out', path.join(os.tmpdir(), 'unused-postflight.json')], {
    periodMinutes: 10, now: () => 0, sleep: noSleep, log: () => {}, runGate: async () => ({ status: 0, stderr: '' }),
    writeConclusion: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); },
    removeScratch: (directory) => { cleaned += 1; fs.rmSync(directory, { recursive: true, force: true }); } }), /ENOSPC/);
  assert.equal(cleaned, 1);
});

test('an invalid rollback record is reported as not rolled back', async () => {
  const { CONTRACT, WORKERS, main } = await import('../scripts/release-worker-versions.mjs');
  const version = (n) => `${n.repeat(8)}-0000-4000-8000-${n.repeat(12)}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'worker-invalid-title-'));
  const log = console.log; const error = console.error; const errors = [];
  console.log = () => {}; console.error = (line) => errors.push(String(line));
  try {
    await writeFile(path.join(dir, 'v.json'), JSON.stringify({ contract: CONTRACT, mode: 'release', edge: {},
      workers: WORKERS.map(({ name }, i) => ({ name, version_id: version(String(i + 1)) })) }));
    assert.equal(await main(['rollback', '--from', path.join(dir, 'v.json'), '--out', path.join(dir, 'r.json')],
      { env: {}, wait: noSleep, sleep: noSleep, windowMs: 120_000 }), 1);
    assert.ok(errors.length > 0);
    for (const line of errors) assert.doesNotMatch(line, /title=Release rolled back/, line);
    assert.ok(errors.some((line) => /title=Release not rolled back/.test(line)), errors.join('\n'));
  } finally {
    console.log = log; console.error = error;
    await rm(dir, { recursive: true, force: true });
  }
});

// Fable 1121 §7: the release path reads wrangler configurations only through
// readWranglerConfig (Wrangler's own JSONC reader), so a legal comment or
// trailing comma in a configuration cannot stop a release before its deploy.
// Scope: the files that the workflow's preflight / deploy / release steps name
// directly (node and node --test arguments, globs expanded; `npm run` scripts
// expanded one level from package.json). Known limit: it does not follow the
// modules those files import (the release scripts themselves use
// readWranglerConfig). Zero exceptions inside the scope.
function releasePathFiles() {
  const app = fileURLToPath(new URL('..', import.meta.url));
  const repo = path.resolve(app, '../..');
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  const expand = (dir, pattern) => {
    const full = path.resolve(dir, pattern);
    if (!pattern.includes('*')) return [full];
    const folder = path.dirname(full);
    const name = new RegExp(`^${path.basename(full).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*')}$`);
    return fs.existsSync(folder) ? fs.readdirSync(folder).filter((entry) => name.test(entry)).map((entry) => path.join(folder, entry)) : [];
  };
  const named = (text, dir) => {
    const out = [];
    for (const line of text.split('\n')) {
      for (const match of line.matchAll(/(?:^|[\s;&|(])node\s+((?:--[\w-]+(?:=\S+)?\s+)*)([^\s;&|)]+(?:\s+[^\s;&|)-][^\s;&|)]*)*)/g)) {
        for (const token of match[2].split(/\s+/).map((t) => t.replace(/["']/g, ''))) {
          if (/\.(?:mjs|cjs|js|ts)$/.test(token)) out.push(...expand(dir, token));
        }
      }
      for (const match of line.matchAll(/npm run ([\w:.-]+)/g)) {
        for (const token of (pkg.scripts?.[match[1]] ?? '').split(/[\s;&|()]+/).map((t) => t.replace(/["']/g, ''))) {
          if (/\.(?:mjs|cjs|js|ts)$/.test(token)) out.push(...expand(app, token));
        }
      }
    }
    return out;
  };
  const files = new Set();
  for (const step of productionWorkflow.split(/\n      - /).slice(1)) {
    const condition = /\n {8}if: ([^\n]*)/.exec(`\n${step}`)?.[1] ?? '';
    if (!/'(?:preflight|deploy|release)'/.test(condition)) continue;
    const dir = /\n {8}working-directory: \.\n/.test(`\n${step}\n`) ? repo : app;
    const run = /\n {8}run: (?:[|>]-?\n)?([\s\S]*)$/.exec(`\n${step}`)?.[1] ?? '';
    for (const file of named(run, dir)) if (fs.existsSync(file)) files.add(path.normalize(file));
  }
  return { repo, files: [...files].sort() };
}

// Round-7 review: the guard is a structural rule, not a list of parse
// patterns. In the release path a wrangler configuration path (a literal, or
// a const whose initializer holds one) may only be an argument of
// readWranglerConfig(...) (parse) or gitSameFiles(...) (byte comparison, no
// parse), besides its own const definition and an export list. Any other use
// fails: a raw read, an alias, a concatenation, an interpolation.
const CONFIG_PATH_LITERAL = /wrangler[\w.-]*\.json[c5]?\b/;
const CONFIG_PATH_CALLS = ['readWranglerConfig', 'gitSameFiles'];

// The source with comments, regular expressions and the text of string and
// template literals blanked (template expressions stay code), and the spans
// of the literals that name a configuration.
function codeAndConfigLiterals(source) {
  const out = source.split('');
  const literals = [];
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  const regexAfter = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await))\s*$/;
  let i = 0;
  const templateDepth = [];
  while (i < source.length) {
    const c = source[i], n = source[i + 1];
    if (c === '/' && n === '/') { const end = source.indexOf('\n', i); const stop = end < 0 ? source.length : end; blank(i, stop); i = stop; continue; }
    if (c === '/' && n === '*') { const end = source.indexOf('*/', i + 2); const stop = end < 0 ? source.length : end + 2; blank(i, stop); i = stop; continue; }
    if (c === '/' && regexAfter.test(out.slice(Math.max(0, i - 40), i).join(''))) {
      let j = i + 1, inClass = false;
      for (; j < source.length && source[j] !== '\n'; j += 1) {
        if (source[j] === '\\') { j += 1; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
      }
      blank(i, j + 1); i = j + 1; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      if (CONFIG_PATH_LITERAL.test(source.slice(i, j + 1))) literals.push(i);
      blank(i + 1, j); i = j + 1; continue;
    }
    if (c === '`' || (c === '}' && templateDepth.at(-1) === 0)) {
      // A template's text up to its end or the next ${ expression.
      if (c === '}') templateDepth.pop();
      let j = i + 1;
      while (j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) j += source[j] === '\\' ? 2 : 1;
      if (CONFIG_PATH_LITERAL.test(source.slice(i, j + 1))) literals.push(i);
      blank(i + 1, j);
      if (source[j] === '$') { templateDepth.push(0); i = j + 2; } else i = j + 1;
      continue;
    }
    if (templateDepth.length) {
      if (c === '{') templateDepth[templateDepth.length - 1] += 1;
      else if (c === '}') templateDepth[templateDepth.length - 1] -= 1;
    }
    i += 1;
  }
  return { code: out.join(''), literals };
}

function argumentSpans(code, names) {
  const spans = [];
  for (const match of code.matchAll(new RegExp(`(?<![\\w$])(?:${names.join('|')})\\s*\\(`, 'g'))) {
    let depth = 1, j = match.index + match[0].length;
    for (; j < code.length && depth; j += 1) depth += code[j] === '(' ? 1 : code[j] === ')' ? -1 : 0;
    spans.push([match.index + match[0].length, j - 1]);
  }
  return spans;
}

// const NAME = <initializer>, to the end of its statement.
function constInitializers(code) {
  const out = [];
  for (const match of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    let depth = 0, j = match.index + match[0].length;
    for (; j < code.length; j += 1) {
      const ch = code[j];
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) { if (!depth) break; depth -= 1; }
      else if (!depth && (ch === ';' || ch === ',')) break;
      else if (!depth && ch === '\n' && !/[=(,+\-*/.?:|&[{]\s*$/.test(code.slice(match.index, j))
        && !/^\s*[.?:+\-*/|&)\]}]/.test(code.slice(j + 1, j + 80))) break;
    }
    out.push({ name: match[1], start: match.index, end: j });
  }
  return out;
}

// The calls a literal sits in between `from` and it, innermost first.
function enclosingCalls(code, position, from) {
  const names = [];
  let depth = 0;
  for (let j = position - 1; j >= from; j -= 1) {
    if (code[j] === ')') depth += 1;
    else if (code[j] === '(') {
      if (depth) depth -= 1;
      else names.push(/([\w$.]*)\s*$/.exec(code.slice(Math.max(from, j - 60), j))[1]);
    }
  }
  return names;
}
// Forming a path is all a definition may do with the literal.
const PATH_FORMING = /^(?:URL|fileURLToPath|path\.(?:posix\.)?(?:join|resolve|normalize)|Object\.freeze)$/;

function configPathFindings(source) {
  const { code, literals } = codeAndConfigLiterals(source);
  if (!literals.length) return [];
  const inside = (position, spans) => spans.some(([from, to]) => position >= from && position < to);
  const calls = argumentSpans(code, CONFIG_PATH_CALLS);
  // A const defines a configuration path when a literal in its initializer
  // sits only inside path-forming calls (the result of readWranglerConfig is
  // content, not a path; a literal handed to anything else is a finding).
  const definitions = constInitializers(code).filter((d) => literals.some((at) => at >= d.start && at < d.end
    && !inside(at, calls) && enclosingCalls(code, at, d.start).every((name) => PATH_FORMING.test(name))));
  const allowed = [...calls, ...definitions.map((d) => [d.start, d.end]),
    ...[...code.matchAll(/\bexport\s*\{[^}]*\}/g)].map((m) => [m.index, m.index + m[0].length])];
  const lineOf = (position) => {
    const from = source.lastIndexOf('\n', position) + 1, to = source.indexOf('\n', position);
    return source.slice(from, to < 0 ? undefined : to).trim().slice(0, 160);
  };
  const findings = [];
  for (const at of literals) if (!inside(at, allowed)) findings.push(lineOf(at));
  for (const { name } of definitions) {
    for (const use of code.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))) {
      if (!inside(use.index, allowed)) findings.push(`${name}: ${lineOf(use.index)}`);
    }
  }
  return [...new Set(findings)];
}

test('the release path reads wrangler configurations only through readWranglerConfig', () => {
  // The guard catches each way of parsing a configuration by hand (samples
  // assembled at run time, so this file never contains one).
  const parse = ['JSON', 'parse'].join('.');
  const file = ['../wrangler', 'production.jsonc'].join('.');
  for (const sample of [
    `const config = ${parse}(await readFile(new URL('${file}', import.meta.url), 'utf8'));\n`,
    `const text = await readFile(new URL('${file}', import.meta.url), 'utf8');\nconst config = ${parse}(text);\n`,
    `const config = parseJsonc(fs.readFileSync('${file}', 'utf8'));\n`]) {
    assert.ok(configPathFindings(sample).length >= 1, sample);
  }
  assert.deepEqual(configPathFindings(`const config = await readWranglerConfig('${file}');\nconst other = ${parse}(body);\n`), []);
  const { repo, files } = releasePathFiles();
  const relative = files.map((f) => path.relative(repo, f).split(path.sep).join('/'));
  // The scope is the release path: the tests and scripts those steps run.
  for (const expected of ['apps/clued-cloud/tests/production-release-gate.test.mjs', 'apps/clued-cloud/tests/oauth-origin.test.mjs',
    'apps/kooyumi-connect/tests/connect-migration.test.mjs', 'apps/kooyumi-connect/tests/release.test.mjs',
    'apps/clued-cloud/scripts/projection-postflight.mjs', 'apps/clued-cloud/scripts/release-worker-versions.mjs']) {
    assert.ok(relative.includes(expected), expected);
  }
  // Not source-capture: its script is outside this scope.
  assert.ok(!relative.includes('apps/clued-cloud/scripts/storage-client-registration-source.mjs'));
  const findings = files.flatMap((f) => configPathFindings(fs.readFileSync(f, 'utf8'))
    .map((finding) => `${path.relative(repo, f).split(path.sep).join('/')}: ${finding}`));
  assert.deepEqual(findings, []);
});

test('the release-path guard fails every use of a configuration path but readWranglerConfig and gitSameFiles', () => {
  // Samples assembled at run time, so this file holds none of them.
  const parse = ['JSON', 'parse'].join('.');
  const literal = `'${['../wrangler', 'production.jsonc'].join('.')}'`;
  const counterexamples = {
    // The review's injection: a path constant read by hand.
    injection: `const WRANGLER_PRODUCTION = fileURLToPath(new URL(${literal}, import.meta.url));\n`
      + `const round7Config = ${parse}(readFileSync(WRANGLER_PRODUCTION, 'utf8'));\n`,
    // A literal read directly.
    literal: `const text = readFileSync(${literal}, 'utf8');\nconsole.log(text.length);\n`,
    // A constant given another name, then read.
    alias: `const CONFIG_PATH = new URL(${literal}, import.meta.url);\nconst alias = CONFIG_PATH;\n`
      + `const config = ${parse}(await readFile(alias, 'utf8'));\n`,
  };
  for (const [name, sample] of Object.entries(counterexamples)) {
    assert.ok(configPathFindings(sample).length >= 1, `${name} is not reported:\n${sample}`);
  }
  const allowed = `const PRODUCTION = fileURLToPath(new URL(${literal}, import.meta.url));\n`
    + `const config = await readWranglerConfig(PRODUCTION);\n`
    + `export const CONFIGS = Object.freeze([${literal}]);\n`
    + `if (!(await gitSameFiles(commit, CONFIGS))) throw new Error('changed');\n`
    + `const other = ${parse}(body);\nconst pattern = /'--config' "x"/;\n`;
  assert.deepEqual(configPathFindings(allowed), []);
});

// Release door v1 bootstrap (FABLE-release-identity-autonomous-20261119 §2):
// while the door does not exist, only a first file whose md5 equals
// RELEASE_DOOR_INSTALL_MD5 may run. The value is the md5 of the one install
// migration, 20261119130000_release_door_db_identity_v1.sql (PR-A), as LF
// bytes the way the runner checks them out. Wherever that file is in the
// repository this test holds the pin to it; a changed file needs a new pin.
test('the release workflow pins the md5 of the release door install migration', async () => {
  const pins = [...productionWorkflow.matchAll(/^ {10}RELEASE_DOOR_INSTALL_MD5: '([0-9a-f]{32})'$/gm)].map((match) => match[1]);
  assert.equal(pins.length, 1, 'exactly one pin, on the apply step');
  const applyStep = productionWorkflow.split(/\n      - /).find((step) => step.startsWith('name: Apply the named migrations\n'));
  assert.ok(applyStep.includes(`RELEASE_DOOR_INSTALL_MD5: '${pins[0]}'`));
  assert.notEqual(pins[0], '0'.repeat(32), 'a real md5, not a placeholder');
  const installs = migrationFiles.filter((name) => name.endsWith('_release_door_db_identity_v1.sql'));
  assert.ok(installs.length <= 1, installs.join(', '));
  // Before PR-A is merged into this checkout there is no file to compare with.
  if (installs.length === 0) return;
  assert.equal(installs[0], '20261119130000_release_door_db_identity_v1.sql');
  const bytes = Buffer.from((await readFile(new URL(`../supabase/migrations/${installs[0]}`, import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n'), 'utf8');
  assert.equal(pins[0], createHash('md5').update(bytes).digest('hex'),
    `set RELEASE_DOOR_INSTALL_MD5 in .github/workflows/clued-cloud-production-release.yml to the md5 of ${installs[0]}`);
});
