// Run after the exact source commit has been deployed. Only the CI job with a
// privileged direct Postgres URL may install the production G6 attestation.
//
// --production waits for the live commit, runs the currentness tests and
// writes the evidence file; it never touches the database. --publish installs
// that evidence as the production attestation, in one transaction, after
// every other release check passed (Fable 1121 item 2): the attestation names
// the deployed commit, and a Worker that a failed release rolls back asks G6
// for its own commit, so nothing may replace the row while a rollback is
// still possible.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
export { TEST_FILES };

const USAGE = 'Usage: node scripts/verify-currentness-transport.mjs --dry-run [--evidence-out PATH]'
  + ' | --production --evidence-out PATH | --publish PATH\n';
const SHA = /^[0-9a-f]{40}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
}
function gitCommand(args) {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function runTestFiles(testArgs) {
  const run = spawnSync(process.execPath, testArgs, { cwd: process.cwd(), encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024, env: process.env });
  if (run.error) throw run.error;
  return run;
}
const ciRun = (env) => `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
const productionClient = (url) => new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });

// The checkout, the run and the commit the evidence and the attestation are for.
function productionCheckout(git, env) {
  const commit = git(['rev-parse', 'HEAD']);
  if (!SHA.test(commit)) throw new Error('Invalid source commit');
  if (git(['status', '--porcelain']) !== '') throw new Error('Production verification requires a clean worktree');
  if (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_RUN_ID ||
      env.GITHUB_SHA !== commit) throw new Error('Production verification requires the matching GitHub CI run');
  return commit;
}

/** Why this run may not install `evidence` for `commit`; empty when it may. */
export function publishRefusals(evidence, { commit, env }) {
  const refusals = [];
  if (evidence?.verification_status !== 'passed') refusals.push('verification_not_passed');
  if (evidence?.verification_context !== 'production_post_deploy') refusals.push('not_production_post_deploy_evidence');
  if (evidence?.source_commit !== commit || evidence?.deployed_commit !== commit) refusals.push('evidence_commit_mismatch');
  if (evidence?.source_worktree_dirty !== false) refusals.push('evidence_worktree_dirty');
  if (evidence?.ci_run !== ciRun(env)) refusals.push('evidence_from_another_run');
  if (evidence?.live_health_url !== PRODUCTION_HEALTH_URL) refusals.push('evidence_live_url_mismatch');
  if (!/^[0-9a-f]{64}$/.test(evidence?.test_digest ?? '')) refusals.push('evidence_digest_invalid');
  if (JSON.stringify(evidence?.test_files) !== JSON.stringify(TEST_FILES)) refusals.push('evidence_test_files_mismatch');
  return refusals;
}

export async function main(argv = process.argv.slice(2), {
  env = process.env, git = gitCommand, runTests = runTestFiles, waitLive = waitForLiveSourceCommit,
  connect = productionClient, out = (text) => process.stdout.write(text),
} = {}) {
  if (argv.includes('--help')) {
    out(USAGE);
    return null;
  }
  const modes = ['--dry-run', '--production', '--publish'].filter((mode) => argv.includes(mode));
  if (modes.length !== 1) throw new Error('Select exactly one of --dry-run, --production or --publish');
  const log = (line) => process.stderr.write(`${line}\n`);

  if (modes[0] === '--publish') {
    const file = arg(argv, '--publish');
    if (!file) throw new Error('--publish needs the evidence file --production wrote');
    const commit = productionCheckout(git, env);
    if (!env.CLUED_ATTESTATION_DATABASE_URL) throw new Error('Missing privileged attestation database URL');
    const evidence = JSON.parse(readFileSync(resolve(file), 'utf8'));
    const refusals = publishRefusals(evidence, { commit, env });
    if (refusals.length) throw new Error(`G6 attestation not written: ${refusals.join(', ')}`);
    // The Workers may have changed since the verification: the attestation
    // only names the commit production still serves.
    await waitLive(commit, { log });
    const client = connect(env.CLUED_ATTESTATION_DATABASE_URL);
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`insert into clued_private.currentness_transport_attestations
        (environment,source_commit,test_digest,all_paths_enforced,evidence,verified_at,verified_by)
        values('production',$1,$2,true,$3::jsonb,now(),$4)
        on conflict (environment) do update set source_commit=excluded.source_commit,
          test_digest=excluded.test_digest,all_paths_enforced=excluded.all_paths_enforced,
          evidence=excluded.evidence,verified_at=excluded.verified_at,verified_by=excluded.verified_by`,
        [commit, evidence.test_digest, JSON.stringify(evidence), `github-actions:${env.GITHUB_RUN_ID}`]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      await client.end();
    }
    const result = { status: 'attested', source_commit: commit, test_digest: evidence.test_digest };
    out(`${JSON.stringify(result)}\n`);
    return result;
  }

  const production = modes[0] === '--production';
  const evidenceOut = arg(argv, '--evidence-out');
  if (production && !evidenceOut) throw new Error('--production needs --evidence-out: --publish installs that file');
  let commit;
  let dirty;
  if (production) {
    commit = productionCheckout(git, env);
    dirty = false;
    await waitLive(commit, { log });
  } else {
    commit = git(['rev-parse', 'HEAD']);
    if (!SHA.test(commit)) throw new Error('Invalid source commit');
    dirty = git(['status', '--porcelain']) !== '';
  }
  const testArgs = ['--test', '--test-force-exit', ...TEST_FILES];
  const run = runTests(testArgs);
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  out(output);
  if (run.status !== 0) throw new Error(`Currentness/retained/Major verification failed (${run.status}); no evidence written`);
  // Recheck after the tests: Cloudflare can still route some requests to the
  // previous version after the first match, so this recheck waits too (only a
  // commit mismatch is retried; anything else still fails closed).
  if (production) await waitLive(commit, { log });
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
    ci_run: production ? ciRun(env) : null,
    checked_at: new Date().toISOString(),
  };
  if (evidenceOut) writeFileSync(resolve(evidenceOut), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  out(`${JSON.stringify({ status: 'passed', attested: false, source_commit: commit,
    source_worktree_dirty: dirty, verification_context: evidence.verification_context,
    test_digest: digest, test_count: TEST_FILES.length })}\n`);
  return evidence;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
