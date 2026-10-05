// Run after the exact source commit has been deployed. Only the CI job with a
// privileged direct Postgres URL may install the production G6 attestation.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { PRODUCTION_HEALTH_URL, waitForLiveSourceCommit } from './currentness-live-build.mjs';

const TEST_FILES = Object.freeze([
  'tests/user-memory-bundle.test.mjs',
  'tests/continuity.test.mjs',
  'tests/stage6-contract.test.mjs',
  'tests/home-record-currentness.test.mjs',
  'tests/context-v2-terminal-restore-db.test.mjs',
  'tests/currentness-record-fence-db.test.mjs',
  'tests/currentness-admission-db.test.mjs',
  'tests/currentness-legacy-inventory.test.mjs',
  'tests/currentness-retained-all.test.mjs',
  'tests/currentness-build-attestation.test.mjs',
  'tests/currentness-transport.test.mjs',
  'tests/k-cont-db.test.mjs',
  'tests/k-cont-contract.test.mjs',
  'tests/priority-projection-db.test.mjs',
  'tests/checkpoint-replay-receipt-db.test.mjs',
  'tests/authorization-end-to-end.test.mjs',
  'tests/delegated-oauth-transport.test.mjs',
  'tests/connection-authorization-db.test.mjs',
  'tests/authorization-closeout.test.mjs',
]);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}
function command(bin, args) {
  const result = spawnSync(bin, args, { cwd: process.cwd(), encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

if (process.argv.includes('--help')) {
  process.stdout.write('Usage: node scripts/verify-currentness-transport.mjs --dry-run [--evidence-out PATH] | --production [--evidence-out PATH]\n');
  process.exit(0);
}

const production = process.argv.includes('--production');
if (production === process.argv.includes('--dry-run')) {
  throw new Error('Select exactly one of --dry-run or --production');
}
const commit = command('git', ['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid source commit');
const dirty = command('git', ['status', '--porcelain']) !== '';
if (production) {
  if (dirty) throw new Error('Production verification requires a clean worktree');
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_RUN_ID ||
      process.env.GITHUB_SHA !== commit) throw new Error('Production verification requires the matching GitHub CI run');
  if (!process.env.CLUED_ATTESTATION_DATABASE_URL) throw new Error('Missing privileged attestation database URL');
  await waitForLiveSourceCommit(commit, { log: (line) => process.stderr.write(`${line}\n`) });
}

const testArgs = ['--test', '--test-force-exit', ...TEST_FILES];
const run = spawnSync(process.execPath, testArgs, { cwd: process.cwd(), encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024, env: process.env });
const output = `${run.stdout || ''}\n${run.stderr || ''}`;
process.stdout.write(output);
if (run.error) throw run.error;
if (run.status !== 0) throw new Error(`Currentness/retained/Major verification failed (${run.status}); G6 attestation not written`);
// Recheck after the tests: Cloudflare can still route some requests to the
// previous version after the first match, so this recheck waits too (only a
// commit mismatch is retried; anything else still fails closed).
if (production) await waitForLiveSourceCommit(commit, { log: (line) => process.stderr.write(`${line}\n`) });
const digest = sha256(JSON.stringify({ commit, dirty, test_files: TEST_FILES, output }));
const evidence = {
  source_commit: commit,
  source_worktree_dirty: dirty,
  verification_context: production ? 'production_post_deploy' : 'author_precheck',
  deployed_commit: production ? commit : null,
  live_health_url: production ? PRODUCTION_HEALTH_URL : null,
  test_digest: digest,
  verification_status: 'passed',
  test_files: TEST_FILES,
  test_command: [process.execPath, ...testArgs],
  ci_run: production ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  checked_at: new Date().toISOString(),
};
if (arg('--evidence-out')) writeFileSync(resolve(arg('--evidence-out')), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });

if (production) {
  const client = new pg.Client({ connectionString: process.env.CLUED_ATTESTATION_DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(`insert into clued_private.currentness_transport_attestations
      (environment,source_commit,test_digest,all_paths_enforced,evidence,verified_at,verified_by)
      values('production',$1,$2,true,$3::jsonb,now(),$4)
      on conflict (environment) do update set source_commit=excluded.source_commit,
        test_digest=excluded.test_digest,all_paths_enforced=excluded.all_paths_enforced,
        evidence=excluded.evidence,verified_at=excluded.verified_at,verified_by=excluded.verified_by`,
      [commit, digest, JSON.stringify(evidence), `github-actions:${process.env.GITHUB_RUN_ID}`]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}
process.stdout.write(`${JSON.stringify({ status: 'passed', attested: production, source_commit: commit,
  source_worktree_dirty: dirty, verification_context: evidence.verification_context,
  test_digest: digest, test_count: TEST_FILES.length })}\n`);
