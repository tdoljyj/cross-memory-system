import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  assert.match(backup, /if: \$\{\{ inputs\.mode == 'backup' \}\}/);
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

// A small model of how GitHub runs this job's steps: each step's `if` (an
// implicit success() unless it names a status function) over the dispatch
// inputs, the earlier failure and the outcomes of steps with an id. It runs
// the real workflow file, so the order, the grant steps and the rollback
// below are the ones production runs.
const releaseSteps = productionWorkflow.split(/\n      - /).slice(1).map((text) => ({
  text,
  name: /(?:^|\n {8})name: (.+)\n/.exec(text)?.[1] ?? text.split('\n')[0],
  id: /(?:^|\n {8})id: (\S+)\n/.exec(text)?.[1] ?? null,
  condition: /(?:^|\n {8})if: \$\{\{ (.+?) \}\}\n/.exec(text)?.[1] ?? null,
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
  const context = { inputs: { source_request_id: '', source_request_digest: '', migrations: '', ...inputs }, failed: false, outcomes: {} };
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
  'Check production database credential', 'Check production backup encryption credential',
  'Check migration database credential', 'Check Cloudflare deployment credential',
  'Verify projection and MTPE behavior', 'Build exact Worker source', 'Verify and build Kooyumi Connect release source',
  'Create and verify encrypted pre-migration backup', 'Consume the Owner Grant for the named migrations',
  'Apply the named migrations', 'Block release unless database and Worker heartbeat are ready',
  'Record the Worker versions production serves', 'Deploy Clued PDF extractor Worker', 'Deploy Clued production Worker',
  'Verify exact live commit and currentness transport', 'Verify production serves the repository Agent contract',
  'Verify the PDF extractor service binding', 'Deploy Kooyumi Connect Worker', 'Verify Kooyumi Connect production release',
  'Verify projection currentness after deployment', 'Preserve release evidence',
];
const ROLLBACK_STEP = 'Roll back the Workers after a failed deploy or verification';
const grantSteps = (run) => run.steps.filter((step) => /clued-release-grant\.mjs/.test(step.text));
const MIGRATION = '20261003170000_owner_grants_release_door.sql';

test('release mode runs preflight, backup, migrations, deploy and verification in one run from one grant step', () => {
  const run = simulateRelease({ mode: 'release', migrations: MIGRATION });
  assert.equal(run.conclusion, 'success');
  const positions = RELEASE_ORDER.map((name) => run.ran.indexOf(name));
  assert.ok(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])),
    JSON.stringify(Object.fromEntries(RELEASE_ORDER.map((name, i) => [name, positions[i]]))));
  // One grant step, before anything changes production, consuming the bundle once.
  assert.deepEqual(grantSteps(run).map((step) => step.name), ['Consume the Owner Grant for the named migrations']);
  assert.match(grantSteps(run)[0].text, /--mode "\$RELEASE_MODE"/);
  assert.match(grantSteps(run)[0].text, /RELEASE_MODE: \$\{\{ inputs\.mode \}\}/);
  assert.match(grantSteps(run)[0].text, /NODE_OPTIONS: ''/);
  assert.ok(!run.ran.includes(ROLLBACK_STEP));
  // Every credential is checked before the grant is used.
  const grantAt = run.ran.indexOf('Consume the Owner Grant for the named migrations');
  run.ran.forEach((name, index) => { if (/^Check .* credentials?$/.test(name)) assert.ok(index < grantAt, name); });
});

test('release mode without migrations skips backup and migrations and uses the deploy grant after the gate', () => {
  const run = simulateRelease({ mode: 'release' });
  assert.equal(run.conclusion, 'success');
  for (const name of ['Check production backup encryption credential', 'Check migration database credential',
    'Create and verify encrypted pre-migration backup', 'Consume the Owner Grant for the named migrations', 'Apply the named migrations']) {
    assert.ok(!run.ran.includes(name), name);
  }
  assert.deepEqual(grantSteps(run).map((step) => step.name), ['Consume the Owner Grant for this commit']);
  const at = (name) => run.ran.indexOf(name);
  assert.ok(at('Block release unless database and Worker heartbeat are ready') < at('Consume the Owner Grant for this commit'));
  assert.ok(at('Consume the Owner Grant for this commit') < at('Record the Worker versions production serves'));
  assert.ok(at('Record the Worker versions production serves') < at('Deploy Clued PDF extractor Worker'));
  assert.ok(at('Verify projection currentness after deployment') > at('Deploy Kooyumi Connect Worker'));
  assert.ok(!run.ran.includes(ROLLBACK_STEP));
});

test('only deploy and release reach production Workers; the single-step modes keep their own steps', () => {
  const touchesWorkers = (step) => /wrangler (deploy|rollback|queues create)|release-worker-versions\.mjs/.test(step.text);
  for (const mode of ['preflight', 'backup', 'migrate', 'source-capture']) {
    const inputs = { mode, migrations: mode === 'migrate' ? MIGRATION : '',
      source_request_id: mode === 'source-capture' ? 'r' : '', source_request_digest: mode === 'source-capture' ? 'd' : '' };
    for (const failAt of [null, 'Verify projection and MTPE behavior', 'Apply the named migrations']) {
      const run = simulateRelease(inputs, failAt);
      assert.deepEqual(run.steps.filter(touchesWorkers).map((step) => step.name), [], `${mode} ${failAt}`);
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
    for (const failAt of ['Deploy Clued PDF extractor Worker', 'Deploy Clued production Worker',
      'Verify exact live commit and currentness transport', 'Verify the PDF extractor service binding',
      'Verify Kooyumi Connect production release', 'Verify projection currentness after deployment']) {
      const run = simulateRelease({ mode, migrations: mode === 'release' ? MIGRATION : '' }, failAt);
      assert.equal(run.conclusion, 'failure', failAt);
      assert.ok(run.ran.includes(ROLLBACK_STEP), `${mode}: ${failAt} did not roll back`);
      assert.ok(run.ran.indexOf(ROLLBACK_STEP) > run.ran.indexOf(failAt));
      assert.ok(run.ran.indexOf(ROLLBACK_STEP) < run.ran.indexOf('Preserve release evidence'));
      if (failAt.startsWith('Verify exact')) assert.ok(!run.ran.includes('Deploy Kooyumi Connect Worker'));
    }
    // Nothing was deployed yet, or the versions were never recorded: nothing to roll back to.
    for (const failAt of ['Block release unless database and Worker heartbeat are ready', 'Record the Worker versions production serves']) {
      const run = simulateRelease({ mode }, failAt);
      assert.equal(run.conclusion, 'failure');
      assert.ok(!run.ran.includes(ROLLBACK_STEP), failAt);
      assert.ok(!run.ran.some((name) => /^Deploy /.test(name)), failAt);
    }
  }
  const migrated = simulateRelease({ mode: 'release', migrations: MIGRATION }, 'Apply the named migrations');
  assert.ok(!migrated.ran.includes(ROLLBACK_STEP) && !migrated.ran.some((name) => /^Deploy /.test(name)));
  const step = releaseSteps.find((s) => s.name === ROLLBACK_STEP);
  assert.match(step.text, /node scripts\/release-worker-versions\.mjs rollback --from \.sites-runtime\/release-evidence\/worker-versions\.json --out \.sites-runtime\/release-evidence\/worker-rollback\.json/);
  assert.match(step.text, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLUED_CLOUDFLARE_DEPLOY_TOKEN_V2 \}\}/);
  const record = releaseSteps.find((s) => s.name === 'Record the Worker versions production serves');
  assert.match(record.text, /node scripts\/release-worker-versions\.mjs record --out \.sites-runtime\/release-evidence\/worker-versions\.json/);
  assert.doesNotMatch(productionWorkflow, /continue-on-error/);
  for (const file of ['worker-versions', 'worker-rollback']) {
    assert.match(productionWorkflow, new RegExp(`release-evidence/${file}\\.json\\n`));
  }
});

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
  const env = { GITHUB_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '42' };
  const before = { 'clued-storage-pdf': id(1), 'clued-cloud': id(2), 'clued-connect': id(3) };
  const recorded = await recordVersions({ wrangler: fakeCloudflare({ ...before }).wrangler, wait, env });
  assert.deepEqual(recorded.workers, Object.entries(before).map(([name, version_id]) => ({ name, version_id })));
  // A split deployment stops the release before anything is deployed.
  await assert.rejects(recordVersions({ wait, env, wrangler: async () => ({ status: 0, stdout: '{"versions":[]}' }) }),
    /clued-storage-pdf does not serve exactly one version/);
  // The PDF extractor and the main Worker were deployed, then verification failed.
  const cloud = fakeCloudflare({ ...before, 'clued-storage-pdf': id(4), 'clued-cloud': id(5) });
  const result = await rollbackVersions({ recorded, wrangler: cloud.wrangler, wait, env });
  assert.equal(result.ok, true);
  assert.deepEqual(cloud.served, before);
  assert.deepEqual(result.workers.map((w) => [w.name, w.action]),
    [['clued-connect', 'unchanged'], ['clued-cloud', 'rolled_back'], ['clued-storage-pdf', 'rolled_back']]);
  assert.deepEqual(cloud.calls.filter((args) => args[0] === 'rollback').map((args) => args.slice(0, 4)),
    [['rollback', id(2), '--name', 'clued-cloud'], ['rollback', id(1), '--name', 'clued-storage-pdf']]);
  assert.ok(cloud.calls.filter((args) => args[0] === 'rollback').every((args) => args.includes('--yes')));
  const summary = renderRollbackSummary(result);
  assert.ok(summary.includes(`| \`clued-cloud\` | \`${id(2)}\` | \`${id(5)}\` | rolled_back |`), summary);
  assert.match(summary, /database is forward-only and was not rolled back/);
  // A refused rollback is reported and fails the step.
  const refused = await rollbackVersions({ recorded, wait, env,
    wrangler: fakeCloudflare({ ...before, 'clued-cloud': id(5) }, { failRollback: ['clued-cloud'] }).wrangler });
  assert.equal(refused.ok, false);
  assert.match(renderRollbackSummary(refused), /rollback_failed: rollback refused[\s\S]*could not be rolled back/);
  await assert.rejects(rollbackVersions({ recorded: { ...recorded, workers: recorded.workers.slice(1) }, wait, env }), /not a valid record/);

  // The commands the workflow runs: record, then rollback with the summary.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'worker-versions-'));
  const files = { versions: path.join(dir, 'v.json'), rollback: path.join(dir, 'r.json'), summary: path.join(dir, 's.md') };
  await writeFile(files.summary, '');
  const log = console.log; const error = console.error; const errors = [];
  console.log = () => {}; console.error = (line) => errors.push(line);
  try {
    assert.equal(await main(['record', '--out', files.versions], { wrangler: fakeCloudflare({ ...before }).wrangler, wait, env }), 0);
    const failed = fakeCloudflare({ ...before, 'clued-connect': id(6) });
    assert.equal(await main(['rollback', '--from', files.versions, '--out', files.rollback],
      { wrangler: failed.wrangler, wait, env: { ...env, GITHUB_STEP_SUMMARY: files.summary } }), 0);
    assert.deepEqual(failed.served, before);
    assert.match(await readFile(files.summary, 'utf8'), /Automatic Worker rollback[\s\S]*`clued-connect`[^\n]*rolled_back/);
    assert.equal(JSON.parse(await readFile(files.rollback, 'utf8')).ok, true);
    assert.ok(errors.some((line) => /::error title=Release rolled back::Rolled back clued-connect/.test(line)));
    assert.equal(await main(['rollback'], { env }), 2);
  } finally {
    console.log = log; console.error = error;
    await rm(dir, { recursive: true, force: true });
  }
});
