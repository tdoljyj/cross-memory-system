import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { builderRunInProgress, onlyProjectionLag, settleProjectionLag, verifyReleaseState }
  from '../scripts/production-release-gate.mjs';

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

test('projection lag alone is waited out for a newer Builder run; other findings are not', () => {
  assert.equal(onlyProjectionLag(['projection_not_current:global.priority_frontier',
    'projection_not_current:global.__aggregate__']), true);
  assert.equal(onlyProjectionLag([]), false);
  assert.equal(onlyProjectionLag(['projection_not_current:global.priority_frontier',
    'worker_heartbeat_not_healthy']), false);
  assert.equal(onlyProjectionLag(['worker_has_not_run_after_deployment']), false);
});

function lagClock() {
  let t = Date.parse('2026-09-23T05:12:49Z');
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}
const lagged = ['projection_not_current:global.priority_frontier'];
const idleAt = (finished) => ({ heartbeat: { last_result: 'idle', last_finished_at: finished } });

test('stale projections re-evaluate after the next completed Builder run', async () => {
  const clock = lagClock();
  const first = idleAt('2026-09-23T05:11:59Z');
  const reads = [first, { heartbeat: { last_result: 'running',
    last_started_at: '2026-09-23T05:13:00Z', last_finished_at: '2026-09-23T05:11:59Z' } },
    idleAt('2026-09-23T05:13:05Z')];
  const evaluated = [];
  const result = await settleProjectionLag({ errors: lagged, watchdog: first,
    readWatchdog: async () => reads.shift(),
    evaluate: (snapshot) => { evaluated.push(snapshot); return []; }, ...clock });
  assert.deepEqual(result.errors, []);
  assert.equal(result.watchdog.heartbeat.last_finished_at, '2026-09-23T05:13:05Z');
  assert.equal(evaluated.length, 1);
});

test('lag that outlasts the run budget, or no newer run, still blocks the release', async () => {
  const first = idleAt('2026-09-23T05:11:59Z');
  let finished = Date.parse(first.heartbeat.last_finished_at);
  const clock = lagClock();
  const stillStale = await settleProjectionLag({ errors: lagged, watchdog: first,
    readWatchdog: async () => { finished += 60_000; return idleAt(new Date(finished).toISOString()); },
    evaluate: () => lagged, maxRuns: 3, ...clock });
  assert.deepEqual(stillStale.errors, lagged);

  const quiet = await settleProjectionLag({ errors: lagged, watchdog: first,
    readWatchdog: async () => first, evaluate: () => [], ...lagClock() });
  assert.deepEqual(quiet.errors, lagged);
  assert.equal(quiet.watchdog, first);

  let reads = 0;
  const other = await settleProjectionLag({ errors: ['worker_heartbeat_not_healthy'],
    watchdog: first, readWatchdog: async () => { reads += 1; return first; },
    evaluate: () => [], ...lagClock() });
  assert.deepEqual(other.errors, ['worker_heartbeat_not_healthy']);
  assert.equal(reads, 0);
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
  // Owner Credential v0.1 §6.1 (Task 2a31ca2a): the grant step comes first.
  const steps = productionWorkflow.split(/\n      - /).slice(1);
  const names = steps.map((step) => step.split('\n')[0]);
  const migrateGrant = names.indexOf('name: Consume the Owner Grant for the named migrations');
  const deployGrant = names.indexOf('name: Consume the Owner Grant for this commit');
  assert.ok(migrateGrant > 0 && deployGrant > 0);
  assert.match(steps[migrateGrant], /if: \$\{\{ inputs\.mode == 'migrate' \}\}/);
  assert.match(steps[deployGrant], /if: \$\{\{ inputs\.mode == 'deploy' \}\}/);
  for (const grant of [migrateGrant, deployGrant]) {
    assert.match(steps[grant], /node scripts\/ci\/clued-release-grant\.mjs --mode "\$RELEASE_MODE"/);
    assert.match(steps[grant], /CLUED_RELEASE_TOKEN: \$\{\{ secrets\.CLUED_RELEASE_TOKEN \}\}/);
  }
  assert.match(steps[migrateGrant], /MIGRATIONS: \$\{\{ inputs\.migrations \}\}/);
  // Steps that change production come after their grant; the credential
  // checks come before it, so a run that cannot proceed uses no grant
  // (re-review N6). deploy also runs the release gate first: run 37329072487
  // used its grant and then stopped at the gate.
  const gate = names.indexOf('name: Block release unless database and Worker heartbeat are ready');
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
  assert.match(gateSource, /const errors = \[\.\.\.settled\.errors, \.\.\.ledgerReport\.errors\];\n\s+if \(errors\.length\) throw/);
  assert.doesNotMatch(gateSource, /ledgerReport\.warnings[^\n]*errors/);
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
