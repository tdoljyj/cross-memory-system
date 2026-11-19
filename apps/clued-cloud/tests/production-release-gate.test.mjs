import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
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
  assert.match(steps[verify], /\n        if: \$\{\{ inputs\.mode == 'deploy' \}\}\n/);
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
  for (const step of deploySteps) {
    assert.match(step, /\n        if: \$\{\{ inputs\.mode == 'deploy' \}\}\n/, step.split('\n')[0]);
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
  assert.match(steps[migrateGrant], /if: \$\{\{ inputs\.mode == 'migrate' \}\}/);
  assert.match(steps[deployGrant], /if: \$\{\{ inputs\.mode == 'deploy' \}\}/);
  for (const grant of [migrateGrant, deployGrant]) {
    assert.match(steps[grant], /CLUED_MIGRATION_DATABASE_URL: \$\{\{ secrets\.CLUED_MIGRATION_DATABASE_URL \}\}/);
    assert.match(steps[grant], /clued-release-grant\.mjs/);
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
