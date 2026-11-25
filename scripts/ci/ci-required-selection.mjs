// Which test suites a change needs, and what each suite runs (Task 2a5fdb66;
// design in work/ci-required-tests-v1/DESIGN.md).
//
// The required checks ci-suites, clued-cloud-tests and migration-verify
// (.github/workflows/clued-required-tests.yml) always report, so they can sit
// in the main ruleset; this file decides what each one runs. The workflow
// runs it from the pull request's trusted base checkout, so a pull request
// cannot narrow its own selection, swap a suite's command line or extend the
// known-failure list (ci-known-failures.json, read next to this file). The
// baseline commands run first, followed by commands the candidate adds to
// the selected suite (requiredCommands), each side's commands as it expands them; a suite only the
// candidate has runs whole (candidateSuites). The commands run the candidate's code and tests: that code is
// reviewed through the protected-path rules, not through this file. The
// candidate's own changes to the selection (this file, the workflow) select
// every suite.
//
// So a pull request that fixes the trusted side (this file, test-env.mjs, the
// suite commands) runs under main's trusted side, not its own fix (Task
// 3435f8bf). Its must-fail test exercises the candidate's code itself (call
// executeSuite and assert the child's environment, red on main's code, green
// on the candidate's); it never asserts the job's real environment, which is
// main's until it merges. The end-to-end check is the first run after merge;
// a timing guard is added then. The hosted suite jobs' timeout-minutes is a
// hang backstop, not a speed gate (hosted-required.test.mjs: at least 90).
//
//   node scripts/ci/ci-required-selection.mjs --check <ci-suites|clued-cloud-tests|migration-verify> [--root <checkout>]
//     reads GITHUB_EVENT_PATH and lists the pull request's files through the
//     API (GITHUB_TOKEN, pull-requests: read); a push, a listing it cannot
//     read or a listing at GitHub's 3000-file limit selects everything.
//     In hosted-required, a pull request head behind its base branch's live
//     tip selects nothing and says so (behindMain); a compare it cannot read
//     selects as above.
//     Writes suites=<json>, app_deps=<json> (SUITE_APP_DEPENDENCIES) and
//     run_<suite>=true|false to GITHUB_OUTPUT. Only
//     the suites declared for the host's platform (SUITE_PLATFORMS) are listed. With --root, the suites the
//     checkout's own selector adds to the check follow, by its own platform table (selectWithCandidate).
//   node scripts/ci/ci-required-selection.mjs --run-selected <check> [--root <checkout>] [--shard <i>/<n>]
//     selects as --check does, then runs every selected suite in turn and fails
//     when any of them fails: one job step, the same on Linux and on Windows
//     (the ci-suites-windows job; resident ADR 0032). With --shard, only the
//     i-th of n parts of that plan (parseShard); only in a CI job. Without it,
//     a CI job on a machine with 8 or more cores runs the plan in lanes: the
//     n parts --shard would make, at once in the one job (laneCount, runSelected).
//   node scripts/ci/ci-required-selection.mjs --run <suite> [--root <checkout>]
//     runs one suite's commands (SUITE_COMMANDS) in the checkout at --root.
//   node scripts/ci/ci-required-selection.mjs --write-known <suite> [--keep] [--root <checkout>]
//     regenerates that suite's ci-known-failures.json entries from a real run
//     (--keep also keeps the entries already listed).
//   node scripts/ci/ci-required-selection.mjs --write-shard-seconds <log> [<log>...]
//     rewrites ci-shard-seconds.json (the seconds --shard packs files by) from
//     the shard-seconds lines of --shard job logs: each file's median, files
//     under 3 seconds left out. The table is only ever written this way. When
//     hosted-required.yml goes (S8), --shard goes; the table and the packing
//     stay for the lanes (FABLE-ci-duration-node-side-20261124, 做法 2).
//   node scripts/ci/ci-required-selection.mjs --run-prepush --root <tree>
//     runs PREPUSH_COMMANDS (a few static checks, seconds) in <tree>: the push entry's check of the tree a push would
//     merge into main. Exit 0 all passed, 1 a command failed (named with its failed tests), 3 one could not run.
//     No suite slot, no application dependencies (runPrepush).
// The suite run modes (--run, --run-selected, --write-known, --run-files) wait for a machine-wide suite slot outside GitHub Actions.
import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownIdentityDir, testEnv } from './test-env.mjs';
import { clockGuardEnv, recordVerdict } from './test-clock-scan.mjs';

// The resident layer imports Source v2, Source v2 imports scripts/ci (and
// through it scripts/runner) and the resident's node profile, the admission
// self-tests reach Source v2 through scripts/ci, and both read the gitleaks
// configuration; a change to any of them runs all of these suites
// (ci-required-selection.test.mjs checks the transitive imports of each).
const RESIDENT_AND_SOURCE = ['work/independent-ci-resident-v1/**', 'work/actions-hosted-migration/independent-ci-v1/**',
  'scripts/ci/**', 'scripts/runner/**', 'config/merge-admission-policy.json', '.gitleaks.toml'];

// Select the registry checks for the R9 inputs, the reconcile source closure and
// the component manifest. Generated outputs also select on their generators and inputs.
// check-pinned-registries.test.mjs checks that every pinned file matches.
export const PINNED_REGISTRY_PATHS = ['scripts/ci/**', 'scripts/runner/**', '.github/workflows/**', '.github/actions/ci-temporary-storage/**',
  'config/merge-admission-policy.json', 'apps/clued-cloud/app/supabase-public-config.ts', 'apps/clued-cloud/package.json',
  'apps/clued-cloud/package-lock.json', 'config/clued-components.json', 'scripts/clued_components.py', 'scripts/hooks/**', 'skills/**', 'integrations/**',
  'protocol/agent/agent-contract.md', 'apps/clued-cloud/worker/generated/**', 'apps/clued-cloud/scripts/generate-*.mjs',
  'apps/clued-cloud/app/imprints/imprint-suggestions.ts', 'apps/clued-cloud/supabase/migrations/*_imprint_auto_domains_v1.sql', 'scripts/build_claude_code_plugin.py', 'config/clued-mechanical-files.json'];

// Every file the one generated-file list names, read at run time from the
// checkout this selector belongs to (no copy of the list here).
export function generatedFilePatterns(file = fileURLToPath(new URL('../../config/clued-mechanical-files.json', import.meta.url))) {
  try {
    const policy = JSON.parse(readFileSync(file, 'utf8'));
    return [...policy.mechanical_paths, ...(policy.marker_paths ?? [])].filter((p) => typeof p === 'string');
  } catch { return []; }
}
// A generator, the list or a generated file changed: integrate a throwaway
// copy and fail on any written file the list does not declare.
const GENERATED_OUTPUTS = [...new Set([...PINNED_REGISTRY_PATHS, ...generatedFilePatterns()])];

// Database tests of invariants every later migration must keep, on the database every migration builds. Database
// tests run in no other required check; a verifier rewrite (20261108161615) once left every scan start refused in
// production. The scan start (both providers) end to end; one reader of whether a role row has started; the
// Integration Runtime derivation and its 250,000 fixed-seed random facts, the CI half of IntegrationRuntime v0.1.8
// §13.2 P2 (c) (the nightly 2,000,000 is clued-integration-runtime-nightly.yml); the database security hygiene,
// which stops its own embedded PostgreSQL servers and so runs without --test-force-exit.
const MIGRATION_DB_TESTS = ['apps/clued-cloud/tests/ci-scan-start-native-db.test.mjs', 'apps/clued-cloud/tests/ci-scan-start-batch-key-db.test.mjs',
  'apps/clued-cloud/tests/ci-node-binding-rebind-db.test.mjs', 'apps/clued-cloud/tests/ci-connection-self-db.test.mjs',
  'apps/clued-cloud/tests/binding-role-single-reader-db.test.mjs', 'apps/clued-cloud/tests/integration-runtime-derivation-db.test.mjs',
  'apps/clued-cloud/tests/db-security-hygiene-db.test.mjs',
  'apps/clued-cloud/tests/storage-runtime-authority-db.test.mjs',
  'apps/clued-cloud/tests/work-claims-pr-end-release-db.test.mjs'];
// The database tests clued-connection-authorization.yml ran (authorization, context v2, projection refresh, work
// claims, Information Flow, records, MTPE, invitations, migration chain, Resource Center authority, end-to-end
// authorization, DatasetSplit grants); nothing ran them once it was disabled
// (2026-10-17). Their tests that need no database run in clued-cloud-tests already. The S2c identity, lifecycle and
// verification suites and five work-claim files were red on main while nothing ran them (stale against the gateway closeout
// replay and the PR-binding plan of 20261108161615); repaired 2026-11-14 and listed here.
const AUTHORIZATION_DB_TESTS = [
  'agent-messages-db', 'all-contexts-authorization-db', 'all-contexts-authorization-locks-db', 'authorization-closeout', 'authorization-end-to-end',
  'authorization-expiry-db', 'authorization-migration-chain', 'authorization-roles-db', 'checkpoint-backlog-controls-db', 'checkpoint-idempotency-db',
  'checkpoint-replay-receipt-db', 'checkpoint-session-renewal-db', 'connection-authorization-db', 'connection-permission-request-db',
  'context-archive-structure-db', 'context-ownership-db', 'context-v2-terminal-restore-db', 'currentness-admission-db', 'currentness-record-fence-db', 'currentness-retained-all',
  'currentness-work-claims-db', 'dataset-split-native-grant-binding-successor-db', 'dataset-split-native-grant-correction-db',
  'dataset-split-native-grant-currentness-scope-db', 'decision-supersede-schema-guard-db', 'event-carrier-block-reasons-db',
  'event-continuity-manifest-db', 'global-scope-projection-invalidation-db', 'headless-binding-issuance-db', 'information-flow-candidate-store-db',
  'information-flow-context-db', 'information-flow-intake-transport-db', 'information-flow-invalidation-db', 'information-flow-promotion-db',
  'information-flow-token-hardening-db', 'integration-runtime-identity-db', 'integration-runtime-lifecycle-db',
  'integration-runtime-verification-db',
  'issuer-credentials-db', 'k-cont-db', 'model-domain-bootstrap-db', 'mtpe-frontier-eligibility-v2-1-db', 'mtpe-frontier-eligibility-v2-db',
  'mtpe-owner-pin-consistency-db', 'mtpe-universal-intake-db', 'now-conflict-null-project-db', 'owner-grants-db', 'owner-grants-release-door-db',
  'owner-grants-resident-upgrade-door-db', 'owner-grants-scope-db', 'owner-request-bundles-db', 'priority-projection-db', 'production-release-door-flow-db',
  'project-invitations-db',
  'project-list-authorization-db', 'projection-refresh-pipeline-db', 'record-update-field-merge-db', 'resource-center-authority-db',
  'migration-size-gate-db', 'resume-constraint-index-db', 'retention-classes-db', 'retention-sweep-db', 'search-context-cross-scope-db', 'search-context-rereview-db', 'session-context-from-token-db',
  'task-dependency-guard-db', 'work-claim-exemptions-db', 'work-claims-acceptance-db', 'work-claims-binding-roles-db', 'work-claims-ci-metering-db',
  'work-claims-continuation-db', 'work-claims-hardening-db', 'work-claims-main-merge-db', 'work-claims-multi-copy-db', 'work-claims-reject-receipts-db', 'work-claims-owner-grants-db', 'work-claims-rate-buckets-db',
  'work-claims-resource-kinds-db', 'worker-gateway-db', 'worker-gateway-request-context-db',
  // Database tests no required suite ran until ci-required-selection.test.mjs required each to run or be exempted
  // (2026-11-19); each of these passed when listed. The exempted ones and their reasons are in ci-uncovered-tests.json.
  'approved-legacy-successor-reconcile-db', 'audit-receipt-lookup-indexes-db', 'ci-database-lint-type-fixes-db', 'ci-heartbeat-scope-db',
  'credential-table-privileges-db', 'credential-verifier-db', 'currentness-legacy-inventory', 'future-consent-authorization-db',
  'imprint-bulk-backfill-db', 'imprint-development-organization-db', 'imprint-organization-db', 'imprint-owner-scope-query-db',
  'imprint-source-history-db', 'integration-runtime-transport', 'integration-status-lookup-indexes-db', 'kooyumi-issuer-provision',
  'legacy-audit-binding-revoke-db', 'legacy-create-carrier-reconcile-db', 'legacy-existing-retraction-reconcile-db',
  'merge-admission-clock-audit-transport-db', 'merge-admission-measurement-capabilities-db', 'merge-admission-measurement-clock-target-db',
  'merge-admission-measurement-history-db', 'merge-train-failover-db', 'model-domain-bootstrap-claim-currentness-scope-db', 'owner-auto-approve-persistent-db',
  'owner-request-answers-db', 'priority-custom-db', 'project-lifecycle-successor-v2-db', 'storage-admission-retry-db',
  'storage-conflict-isolation-db', 'storage-file-version-denial-db', 'storage-google-redirect-cutover',
  'storage-legacy-create-registration-db', 'storage-legacy-directory-recovery-db', 'storage-master-control-db',
  'storage-registration-reconcile-db', 'storage-semantic-recovery-db', 'task-goal-delivery-db', 'task-goal-delivery-production-schema-db',
  'task-owner-detail-db', 'work-claims-generated-files-db', 'work-claims-lease-pin-db',
  // The merge queue of a served repository is joined only through the CI door (20261122140000).
  'merge-queue-ci-join-only-db',
  // The drill test project is brought to production's applied list (FABLE-drill-test-project-sync-20261124 §1).
  'drill-test-sync-db',
  // Repository paths are exclusive until delivery: a claim with a live head authorization does not block another (20261124160000).
  'work-claims-delivered-paths-db',
].map((name) => `apps/clued-cloud/tests/${name}.test.mjs`);
// What those tests read besides the migrations: their shared test helpers, the worker code some of them bundle, the
// Resource Center host and policy modules, the context compiler and the vendored Information Flow and DatasetSplit
// inputs (ci-required-selection.test.mjs checks that every file a database test imports is listed here). The worker's
// own files only (worker/*): worker/generated is rewritten by every component bump, and those version strings are
// not what these tests check.
const MIGRATION_DB_TEST_INPUTS = ['apps/clued-cloud/tests/cluster-cleanup.mjs', 'scripts/ci/test-clock-guard.mjs', 'scripts/ci/test-clock-imports.mjs', 'apps/clued-cloud/tests/fixtures/integration-runtime/**',
  'apps/clued-cloud/tests/ci-connection-renew-db.test.mjs',
  'apps/clued-cloud/tests/fixtures/ci-connection-self-v1.json',
  'apps/clued-cloud/tests/*fixture*.mjs', 'apps/clued-cloud/tests/*.case.mjs', 'apps/clued-cloud/tests/worker/**',
  'apps/clued-cloud/tests/worker-continuity-loader.mjs', 'apps/clued-cloud/tests/independent-review-db.test.mjs',
  'apps/clued-cloud/worker/*', 'apps/clued-cloud/build/pdfjs-decode-guard.mjs', 'kernel/host/resource-center-*.mjs',
  'kernel/policy/resource-center-*.mjs', 'scripts/phase2-qualification/minimum-context-compiler/**',
  'development/contracts/information-flow/vendored/**',
  'development/contracts/model-program/stage-admission/DatasetSplitBootstrapPlan.fc83a4a1.json',
  'apps/clued-cloud/scripts/kooyumi-issuer-provision.mjs', 'apps/clued-cloud/scripts/storage-google-redirect-cutover.mjs',
  'apps/clued-cloud/scripts/release-migration-compat.mjs',
  'scripts/ci/clued-independent-publication-identity.mjs', 'scripts/ci/merge-admission-clock-source.mjs',
  'scripts/ci/merge-admission-measurement-history.mjs', 'work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs',
  'work/actions-hosted-migration/independent-ci-v1/src/proof.mjs', 'work/actions-hosted-migration/independent-ci-v1/src/queue.mjs'];

// suite id -> path patterns ("**" any depth, "*" within a segment).
export const SUITES = {
  'ci-suites': {
    'retrigger-counter': ['scripts/ci/retrigger-counter*', 'scripts/ci/fixtures/retrigger-counter/**'],
    'compute-panel': ['scripts/ci/self-hosted/compute_panel.py', 'tests/test_compute_panel.py', '.github/workflows/clued-compute-panel.yml'],
    // Node Resource Governance v1: the renderer, its sweep and installer, the declarations and the standard (whose archive numbers the resident tests hold too).
    'node-governance': ['scripts/ci/self-hosted/node-governance/**', 'scripts/ci/self-hosted/node-profiles.json', 'scripts/ci/self-hosted/validate_node_profiles.py',
      'config/node-governance-standard.json', 'work/independent-ci-resident-v1/src/host-capacity.mjs'],
    // The renewal contract is the server's file; the resident package carries it (build-package.mjs RESIDENT_EXTERNAL) and these
    // tests verify the fixed signature vector against it, so a server-side change runs them (D2c ruling B1; package.test.mjs checks it).
    'resident-node': [...RESIDENT_AND_SOURCE, 'config/node-governance-standard.json', 'apps/clued-cloud/worker/ci-connection-renew.contract.json'],
    'resident-python': [...RESIDENT_AND_SOURCE, 'config/node-governance-standard.json'],
    // The reinstall tools' own tests (work/independent-ci-resident-v1/reinstall/test) pin the launcher template, read the resident's
    // windows/linux/rollout files and the Source v2 resident-v2 record code, so they run on the same paths as the resident suites.
    'reinstall-python': RESIDENT_AND_SOURCE,
    'offline-drill': RESIDENT_AND_SOURCE,
    'source-v2-node': [...RESIDENT_AND_SOURCE, 'apps/clued-cloud/tests/fixtures/ci-connection-self-v1.json',
      'apps/clued-cloud/supabase/migrations/*_ci_connection_self_v1.sql', 'apps/clued-cloud/tests/ci-connection-self-db.test.mjs'],
    'source-v2-python': RESIDENT_AND_SOURCE,
    'components': ['scripts/clued_components.py', 'scripts/hooks/**', 'skills/**', 'integrations/**',
      'config/clued-components.json', 'tests/test_clued_components.py', 'tests/test_clued_version_check.py',
      'scripts/ci/component-version-integration.py', 'scripts/ci/component-version-integration.test.py',
      'scripts/update_clued_skills.py', 'scripts/test_update_clued_skills.py', 'plugins/kooyumi/**',
      'VERSION', '.claude/settings.json', 'scripts/ci/clued_release_tags.py', 'scripts/ci/test_clued_release_tags.py'],
    'runner-budget-policy': ['.github/workflows/**', 'scripts/ci/validate_runner_budget_policy.py',
      'scripts/ci/test_validate_runner_budget_policy.py'],
    'admission-self-tests': [...RESIDENT_AND_SOURCE, '.github/workflows/**'],
    'pinned-registries': PINNED_REGISTRY_PATHS,
    'mechanical-outputs': GENERATED_OUTPUTS,
    'powershell-count': ['**/*.ps1', 'scripts/ci/check-powershell-count.mjs', 'scripts/ci/check-powershell-count.test.mjs'],
    'cron-budget': ['**/wrangler*.jsonc', '**/migrations/*.sql', 'scripts/ci/check-cron-budget*.mjs', 'scripts/ci/sql-tokens.mjs',
      'scripts/ci/cron-budget-allowlist.json'],
    // Every CI dependency install goes through scripts/ci/ci-deps.mjs (offline; preparing its store is the one networked step).
    'ci-deps-entry': ['.github/workflows/**', '.github/actions/**', 'scripts/ci/**', 'scripts/runner/**'],
    // Its tests read the database tests of apps/clued-cloud/tests and what they import, so a new or changed test there, or
    // the classifier, selects it.
    'selection': ['scripts/ci/ci-required-selection.mjs', 'scripts/ci/test-env.mjs', 'scripts/ci/test-clock-scan.mjs', 'scripts/ci/test-clock-guard.mjs',
      'scripts/ci/test-clock-imports.mjs', 'scripts/ci/ci-required-selection.test.mjs', 'scripts/ci/ci-required-selection-candidate.test.mjs',
      'scripts/ci/ci-required-selection-flaky.test.mjs', 'scripts/ci/ci-required-selection-lanes.test.mjs', 'scripts/ci/ci-required-selection-timeout.test.mjs',
      'scripts/ci/local-suite-slots.mjs',
      'scripts/ci/local-suite-slot-guard.mjs', 'scripts/ci/local-suite-slot-job.ps1', 'scripts/ci/ci-test-failures-reporter.mjs',
      'scripts/ci/local-verify.mjs', 'scripts/ci/local-verify.test.mjs', 'scripts/ci/local-verify-concurrency.test.mjs',
      'scripts/ci/check-tests-covered.mjs', 'scripts/ci/ci-known-failures.json', 'scripts/ci/ci-shard-seconds.json',
      '.github/workflows/clued-required-tests-windows.yml', 'apps/clued-cloud/tests/**',
      'apps/clued-cloud/scripts/select-tests.mjs', 'apps/clued-cloud/scripts/run-tests.mjs'],
  },
  // The application suite reads files from across the repository (workflow,
  // contract and CI-script tests), so every change runs it. It runs
  // check-tests-covered.mjs --base {base}: every test file runs in a required
  // suite or is listed in ci-uncovered-tests.json, checked on every change.
  'clued-cloud-tests': {
    'clued-cloud': ['**'],
  },
  'migration-verify': {
    'production-schema': ['apps/clued-cloud/supabase/**', 'apps/clued-cloud/scripts/production-schema-*.mjs',
      'apps/clued-cloud/scripts/migration-ledger.mjs', 'apps/clued-cloud/scripts/production-release-baseline.json',
      // The drill test project sync and what its database test reaches (the drift module imports the compatibility check; the
      // sync script imports its generated client, scripts/generated/drill-pg.mjs).
      'apps/clued-cloud/scripts/drill-test-sync.mjs', 'apps/clued-cloud/scripts/generated/drill-pg.mjs', 'apps/clued-cloud/scripts/release-migration-compat.mjs',
      // The release door flow test runs the release workflow steps and the grant script (FABLE-release-identity-autonomous §3.1).
      '.github/workflows/clued-cloud-production-release.yml', 'scripts/ci/clued-release-door.mjs',
      'apps/clued-cloud/tests/production-schema-drift.test.mjs', ...MIGRATION_DB_TESTS, ...AUTHORIZATION_DB_TESTS, ...MIGRATION_DB_TEST_INPUTS, 'apps/clued-cloud/package.json',
      'apps/clued-cloud/package-lock.json'],
  },
};

// Changing how selection or the required-check workflow works selects every
// suite of every check.
export const SELECT_ALL = ['scripts/ci/ci-required-selection.mjs', 'scripts/ci/ci-known-failures.json', 'scripts/ci/ci-test-failures-reporter.mjs',
  '.github/workflows/clued-required-tests.yml', '.github/actions/**'];

export const FILE_LIMIT = 3000;

// Where each suite runs (resident ADR 0032). The required checks run the same
// selection once on each platform: on the self-hosted Linux pool (ci-suites,
// clued-cloud-tests, migration-verify) and on the Windows runner of a resident
// node's host (ci-suites-windows). A suite runs on every platform its code runs
// on in production; a suite of one platform only is simply not selected on the
// other. This table is the only place that says so: a suite it does not name
// runs on both, and each entry gives its reason.
export const PLATFORMS = ['linux', 'win32'];
export const SUITE_PLATFORMS = {
  // Renders the panel on a Linux runner from GitHub's API; nothing of it runs on a Windows host.
  'compute-panel': { platforms: ['linux'], reason: 'the panel is rendered on the Linux pool only' },
  // The application is built and deployed from Linux (Workers, Supabase); its unit tests take 16 minutes.
  'clued-cloud': { platforms: ['linux'], reason: 'the application is built, tested and released on Linux only' },
  'production-schema': { platforms: ['linux'], reason: 'the embedded PostgreSQL replay uses the Linux binary package' },
  // Repository bookkeeping with one answer for a commit whatever the host: once is enough (execute once, ADR 0003).
  'components': { platforms: ['linux'], reason: 'a commit has one component state; checked once' },
  'runner-budget-policy': { platforms: ['linux'], reason: 'a commit has one set of workflows; checked once' },
  'pinned-registries': { platforms: ['linux'], reason: 'a commit has one set of pinned bytes; checked once (needs the application dependencies)' },
  'mechanical-outputs': { platforms: ['linux'], reason: 'integrates a throwaway worktree from the Linux dependency store; one answer for a commit' },
  'ci-deps-entry': { platforms: ['linux'], reason: 'the dependency store it guards exists on the Linux pool only' },
  // Its 10 Windows failures on main (test_resume_launcher and others) are an open defect; until they are fixed a
  // required Windows run could never be green. Remove this entry with that fix: the reinstall tools run on Windows.
  'reinstall-python': { platforms: ['linux'], reason: 'fails on Windows on main today (open defect); joins win32 with its fix' },
};
export const hostPlatform = (platform = process.platform) => (platform === 'win32' ? 'win32' : 'linux');
export const suitePlatforms = (id) => SUITE_PLATFORMS[id]?.platforms ?? PLATFORMS;

// The suites whose commands need an application's npm dependencies in the checkout, and that application (Clued Task
// 10399304). This is the only place that says so. --check writes app_deps=<json> for the suites it selected; the job that
// runs them installs those applications (scripts/ci/ci-deps.mjs install, offline) and then sets APP_DEPS_MARKER=1 for the
// suites' processes. The selection test fails a required-tests job that can run one of these suites without that step.
export const SUITE_APP_DEPENDENCIES = {
  'pinned-registries': 'apps/clued-cloud',
};
export const APP_DEPS_MARKER = 'CLUED_CI_APP_DEPS';
export const appDependencies = (suites) => [...new Set(suites.map((id) => SUITE_APP_DEPENDENCIES[id]).filter(Boolean))].sort();
// A command that needs files of an application's dependencies (paths under the checkout) and finds one missing. With the
// marker the job said it installed them, so that is a failure; without it this run did not provide them, and the command
// says so and checks nothing. null when nothing is missing.
export function appDependencyGap(root, needs, env = process.env) {
  const missing = needs.find((file) => !existsSync(path.join(root, file)));
  if (!missing) return null;
  return env[APP_DEPS_MARKER] === '1'
    ? { fail: true, reason: `${missing} is missing although this job provided the application dependencies (${APP_DEPS_MARKER}=1)` }
    : { fail: false, reason: `${missing} is missing: this run did not provide the application dependencies (${APP_DEPS_MARKER} is not set)` };
}

// What each suite runs; cwd is relative to the checkout root. Source v2 tests
// resolve paths from the root, so they run there. {tests:<dir>} expands to the
// sorted *.test.mjs files directly in <dir> (relative to cwd), {unit-tests}
// to the application's unit test files (scripts/select-tests.mjs),
// {ci-script-tests} to the CI-script tests (ciScriptTests), {db-concurrency} and
// {unit-concurrency} to a --test-concurrency (testConcurrency), {base} to
// the base commit (CI_BASE_SHA), {report} to a file under RUNNER_TEMP. A
// command with `known` runs Node's test runner with ci-test-failures-reporter.mjs
// and passes only when every failure is an entry of ci-known-failures.json
// under that key (knownFailureVerdict). Any other node --test command of this list reports to it as well, so that a command
// that fails once can run again in full (passesAgain).
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const RESIDENT = 'work/independent-ci-resident-v1';
const SOURCE_V2 = 'work/actions-hosted-migration/independent-ci-v1';
export const SUITE_COMMANDS = {
  'retrigger-counter': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/retrigger-counter.test.mjs'] }],
  'compute-panel': [{ cwd: '.', argv: [PYTHON, '-I', '-B', 'tests/test_compute_panel.py'] }],
  'node-governance': [{ cwd: '.', argv: ['node', '--test', '{tests:scripts/ci/self-hosted/node-governance}'] },
    { cwd: '.', argv: [PYTHON, '-I', '-B', 'scripts/ci/self-hosted/validate_node_profiles.py'], quiet: true }],
  // The upgrade precheck and rollout tools' own tests (rollout/test) run with the resident's (defect 15894c2a review M1).
  'resident-node': [{ cwd: RESIDENT, argv: ['node', '--test', '{tests:test}', '{tests:rollout/test}'] }],
  'resident-python': [{ cwd: RESIDENT, argv: [PYTHON, '-I', '-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'] },
    { cwd: RESIDENT, argv: [PYTHON, '-I', '-B', '-m', 'unittest', 'discover', '-s', 'rollout/test', '-p', 'test_*.py'] }],
  'reinstall-python': [{ cwd: `${RESIDENT}/reinstall`, argv: [PYTHON, '-I', '-B', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py'] }],
  'offline-drill': [{ cwd: RESIDENT, argv: ['node', 'drill/offline-drill.mjs'] }],
  'source-v2-node': [{ cwd: '.', argv: ['node', '--test', `{tests:${SOURCE_V2}/test}`] }],
  'source-v2-python': [{ cwd: '.', argv: [PYTHON, '-I', '-B', '-m', 'unittest', 'discover', '-s', `${SOURCE_V2}/test`, '-p', 'test_*.py'] }],
  'components': [
    { cwd: '.', argv: [PYTHON, 'scripts/clued_components.py', 'check', '--base', '{base}'] },
    { cwd: '.', argv: [PYTHON, '-m', 'unittest', 'tests.test_clued_components', 'tests.test_clued_version_check'] },
    // The integration builder's own tests (they were in no suite before defect C).
    { cwd: '.', argv: [PYTHON, 'scripts/ci/component-version-integration.test.py'] },
    // The Skill publishing entries refuse a changed Skill under its released version (ComponentVersioning v0.4).
    { cwd: '.', argv: [PYTHON, '-m', 'unittest', 'scripts/test_update_clued_skills.py', 'plugins/kooyumi/test_build_bundle.py'] },
    // VERSION and its git tag agree (ComponentVersioning v0.2; the checkout has full history).
    { cwd: '.', argv: [PYTHON, 'scripts/ci/clued_release_tags.py', 'check'] },
    { cwd: '.', argv: [PYTHON, '-m', 'unittest', 'scripts/ci/test_clued_release_tags.py'] },
  ],
  'runner-budget-policy': [
    { cwd: '.', argv: [PYTHON, 'scripts/ci/validate_runner_budget_policy.py'], quiet: true },
    { cwd: '.', argv: [PYTHON, '-m', 'unittest', 'scripts/ci/test_validate_runner_budget_policy.py'] },
  ],
  'admission-self-tests': [{ cwd: '.', known: 'admission-self-tests', argv: ['node', '--test',
    'scripts/ci/clued-work-admission.test.mjs', 'scripts/ci/merge-admission-policy.test.mjs',
    'scripts/ci/merge-admission-policy-file.test.mjs', 'scripts/ci/clued-release-grant.test.mjs', 'scripts/ci/clued-release-door.test.mjs',
    'scripts/runner/clued-runner-job-started.test.mjs', 'scripts/runner/clued-runner-hook-loader.test.mjs', 'scripts/runner/install-hook-loader.test.mjs', 'scripts/ci/clued-merge-slot-ci.test.mjs',
    'scripts/ci/clued-front-main-merge.test.mjs'] }],
  // Stale pinned registries fail clued-cloud-tests 16 minutes in; this says so in seconds and names the command that fixes each.
  'pinned-registries': [
    { cwd: '.', argv: ['node', 'scripts/ci/check-pinned-registries.mjs', '--base', '{base}'] },
    { cwd: '.', argv: ['node', '--test', 'scripts/ci/generated-registry-merge.test.mjs'] },
  ],
  // Integrates a throwaway worktree. It never installs into the checkout: there
  // node_modules may be a link to a shared store (local-verify), which npm ci would empty.
  // It installs the worktree through ci-deps.mjs (offline from the runner's store).
  'mechanical-outputs': [
    { cwd: '.', argv: [PYTHON, 'scripts/ci/component-version-integration.py', '--audit', '--base', '{base}'] },
  ],
  // Under StrictMode, .Count off a one-item or empty pipeline throws in Windows PowerShell 5.1; this scan takes under a second.
  'powershell-count': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/check-powershell-count.test.mjs'] },
    { cwd: '.', argv: ['node', 'scripts/ci/check-powershell-count.mjs'] }],
  'cron-budget': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/check-cron-budget.test.mjs'] },
    { cwd: '.', argv: ['node', 'scripts/ci/check-cron-budget.mjs'] }],
  'ci-deps-entry': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/ci-deps.test.mjs', 'scripts/ci/check-ci-deps-entry.test.mjs'] },
    { cwd: '.', argv: ['node', 'scripts/ci/check-ci-deps-entry.mjs', '--base', '{base}'] }],
  'selection': [{ cwd: '.', argv: ['node', '--test', 'scripts/ci/ci-required-selection.test.mjs', 'scripts/ci/ci-required-selection-candidate.test.mjs',
    'scripts/ci/ci-required-selection-flaky.test.mjs', 'scripts/ci/ci-required-selection-lanes.test.mjs', 'scripts/ci/ci-required-selection-timeout.test.mjs',
    'scripts/ci/local-verify.test.mjs',
    'scripts/ci/local-verify-concurrency.test.mjs'] }],
  'clued-cloud': [
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'lint'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'ledger:verify'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'typecheck'] },
    { cwd: 'apps/clued-cloud', argv: ['npm', 'run', 'build'] },
    { cwd: 'apps/clued-cloud', argv: ['node', '--test', '{tests:../kooyumi-connect/tests}'] },
    // The CI tools' Python tests (FABLE-tests-outside-required-suites-20261121, C2). scripts/ci is listed file by file:
    // test_check_design_refs.py is red on its first run (ci-uncovered-tests.json), and the components and runner budget
    // suites run their own two.
    { cwd: '.', argv: [PYTHON, '-B', '-m', 'unittest', 'scripts/ci/test_check_contract_placement.py', 'scripts/ci/test_clued_docs_only.py'] },
    { cwd: 'apps/clued-cloud', known: 'clued-cloud', argv: ['node', 'scripts/run-tests.mjs', '--test', '{unit-concurrency}', '{unit-tests}', '{ci-script-tests}'] },
    // Every test file runs in a required suite or is listed, and both lists only shrink against the base: a check, so it takes
    // the job's base from here (Task 700f2b68; PLAN-main-red-real-repo-20261124 §4.3). Last, so the units before it keep their
    // shard numbers; one command, run whole, so one shard runs it.
    { cwd: '.', argv: ['node', 'scripts/ci/check-tests-covered.mjs', '--base', '{base}'] },
    // The real-clock debt list only shrinks against the same base, and the static rules hold (Task 11092b8b;
    // PLAN-main-red-ci-base-sha-20261124 §4): after the coverage check, so the units before it keep their shard numbers.
    { cwd: '.', argv: ['node', 'scripts/ci/test-clock-scan.mjs', '--check', '--base', '{base}'] },
  ],
  'production-schema': [
    { cwd: 'apps/clued-cloud', argv: ['node', '--test', 'tests/ci-connection-renew-db.test.mjs'] },
    { cwd: 'apps/clued-cloud', argv: ['node', '--test', 'tests/production-schema-drift.test.mjs'] },
    { cwd: 'apps/clued-cloud', argv: ['node', 'scripts/production-schema-drift.mjs', 'check', '--base', '{base}', '--report', '{report}'] },
    { cwd: 'apps/clued-cloud', argv: ['node', '--test', '{db-concurrency}',
      ...MIGRATION_DB_TESTS.map((file) => file.slice('apps/clued-cloud/'.length))] },
    { cwd: 'apps/clued-cloud', argv: ['node', 'scripts/run-tests.mjs', '--test', '{db-concurrency}', '--test-force-exit',
      ...AUTHORIZATION_DB_TESTS.map((file) => file.slice('apps/clued-cloud/'.length))] },
  ],
};

// What the push entry runs before a push, on the tree the push would merge into main (--run-prepush; task 3435f8bf,
// FABLE-ci-one-round-20261124 §3.2 and §3.7 ruling 1). A command joins only when it reads tracked files alone, uses only
// Node's and Python's standard library, gives one answer on every platform and takes under 120 seconds; and only once the
// same static check has failed a whole CI round twice. A suite's commands are referenced, never copied: one place each.
export const PREPUSH_COMMANDS = [
  { cwd: '.', argv: ['node', '--test', 'scripts/ci/main-entry-realpath.test.mjs'] },
  ...SUITE_COMMANDS['runner-budget-policy'],
];
export const PREPUSH_TIMEOUT_MS = 120_000;
// Exit codes of --run-prepush: 0 all passed, 1 a command failed (the push entry refuses), PREPUSH_ERROR_EXIT a command timed
// out, did not start or could not be expanded (the push entry pushes and says the check did not run).
export const PREPUSH_ERROR_EXIT = 3;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KNOWN_FAILURES_PATH = path.join(HERE, 'ci-known-failures.json');
export const REPORTER_PATH = path.join(HERE, 'ci-test-failures-reporter.mjs');
// The seconds --shard packs a listing command's files by (shardCommand), read next to this file (the trusted base checkout,
// the same for every shard). Written only by --write-shard-seconds; read only under --shard and in a lane (runSelected).
export const SHARD_SECONDS_PATH = path.join(HERE, 'ci-shard-seconds.json');

// Tests that already fail on main (quarantine, Task 679a0c2b), by suite: each
// entry names the test file (relative to the checkout), the test's full path
// of names (describe and parent tests first) and the fingerprint of why it
// fails (ci-test-failures-reporter.mjs), with a reason. They still run. A
// failure that matches no entry exactly fails the suite, so the same test
// failing for a new reason is a new failure; a listed test that passes, or
// no longer exists, is reported so its entry can be removed.
export const knownKey = ({ file, path: names, fingerprint }) => `${file} :: ${names.join(' > ')} :: ${fingerprint}`;

export function readKnownFailures(file = KNOWN_FAILURES_PATH) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const [suite, entries] of Object.entries(data)) {
    if (!Array.isArray(entries)) throw new Error(`known failures of ${suite} must be a list`);
    for (const entry of entries) {
      if (typeof entry?.file !== 'string' || !Array.isArray(entry.path) || entry.path.length === 0 ||
          !/^[0-9a-f]{16}$/.test(entry.fingerprint ?? '') || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
        throw new Error(`known failure entry invalid or without a reason: ${suite}: ${JSON.stringify(entry)}`);
      }
    }
  }
  return data;
}

export function unitTestFiles(cwd, spawn = spawnSync, env = process.env) {
  const result = spawn('node', ['scripts/select-tests.mjs', 'unit', '--list'], { cwd, encoding: 'utf8', env: testEnv(env) });
  if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error('select-tests --list failed');
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (char === '*') source += '[^/]*';
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const matchesAny = (file, patterns) => patterns.some((pattern) => globToRegExp(pattern).test(file));

// files: repository paths changed, or null when they are unknown. A renamed
// file counts under both names (listPullRequestFiles returns both).
// platform: 'linux' or 'win32' keeps only the suites declared for it
// (SUITE_PLATFORMS), whatever selected them, also when every suite is selected;
// null (callers that are not a CI job, such as local-verify) keeps them all.
export function selectSuites(check, files, platform = null) {
  const suites = SUITES[check];
  if (!suites) throw new Error(`unknown check: ${check}`);
  if (platform !== null && !PLATFORMS.includes(platform)) throw new Error(`unknown platform: ${platform}`);
  const ids = Object.keys(suites).filter((id) => platform === null || suitePlatforms(id).includes(platform));
  if (files === null) return { suites: ids, reason: 'changed files unknown: every suite runs' };
  if (files.some((file) => matchesAny(file, SELECT_ALL))) {
    return { suites: ids, reason: 'the selection or the required-check workflow changed: every suite runs' };
  }
  const selected = ids.filter((id) => files.some((file) => matchesAny(file, suites[id])));
  return { suites: selected, reason: selected.length === 0 ? 'no file this check covers changed' : 'selected by changed paths' };
}

// Task cb5017b6: the selection of the trusted table, then the suites the candidate at root adds to the check (candidateSuites),
// each selected whole whatever changed: a pull request that adds a suite runs it. A candidate table that cannot be read
// keeps the trusted selection and is returned as the error, which fails the check.
export function selectWithCandidate(check, files, platform, root, { trusted } = {}) {
  const selection = selectSuites(check, files, platform);
  let added = [];
  try {
    added = candidateSuites(check, root, { platform, ...(trusted ? { trusted } : {}) });
  } catch (error) {
    return { selection, error };
  }
  if (added.length === 0) return { selection, error: null };
  const ids = added.map(({ id }) => id);
  return { selection: { suites: [...selection.suites, ...ids], added,
    reason: `${selection.reason}; the candidate adds ${ids.join(', ')}: each runs whole` }, error: null };
}

export async function listPullRequestFiles({ repository, number, token, fetchImpl = fetch }) {
  const files = [];
  for (let page = 1; page <= FILE_LIMIT / 100; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    });
    if (!response.ok) return null;
    const batch = await response.json();
    if (!Array.isArray(batch)) return null;
    for (const entry of batch) {
      if (typeof entry?.filename !== 'string') return null;
      files.push(entry.filename);
      if (typeof entry.previous_filename === 'string') files.push(entry.previous_filename);
    }
    if (batch.length < 100) return files;
  }
  return null; // at GitHub's listing limit: the list may be incomplete
}

export async function changedFiles({ event, env, fetchImpl = fetch }) {
  const number = event?.pull_request?.number;
  if (!Number.isInteger(number) || !env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return null;
  try {
    return await listPullRequestFiles({ repository: env.GITHUB_REPOSITORY, number, token: env.GITHUB_TOKEN, fetchImpl });
  } catch {
    return null;
  }
}

// --shard: each of the n jobs reads the changed files itself, and a push while they start could give them different lists,
// so different selections (review H1). A list counts only when the pull request's head is still the event's once it has
// been read; any doubt runs every suite (null), which takes in every other shard's selection, so no unit is left out.
export async function shardChangedFiles({ event, env, fetchImpl = fetch }) {
  const head = event?.pull_request?.head?.sha;
  if (typeof head !== 'string' || !head) return null;
  const files = await changedFiles({ event, env, fetchImpl });
  if (!files) return null;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/pulls/${event.pull_request.number}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' },
    });
    if (!response.ok) return null;
    return (await response.json())?.head?.sha === head ? files : null;
  } catch {
    return null;
  }
}

// Task 3435f8bf (FABLE-ci-one-round-20261124 3.1): a pull request head that lacks its base branch's tip cannot merge while
// the ruleset's strict rule is on (V2), and main only moves forward, so a green on it is never used; the head the merge
// bot makes runs everything. Returns how many commits the head is behind, only for a clear behind_by above 0; anything it
// cannot read (an error, a timeout, a reply it does not recognise) is null, and the selection runs as before. The tip is
// read live, by the branch name in the same request, never the event's base.sha, which may be old (80b9382). Only
// hosted-required for now: shadow-compare.mjs cannot yet tell such a skip from a run (3.1 step 7, stop-loss).
export const BEHIND_MAIN_WORKFLOW = 'hosted-required';
export async function behindMain({ event, env, fetchImpl = fetch, timeoutMs = 20_000 }) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || env.GITHUB_WORKFLOW !== BEHIND_MAIN_WORKFLOW) return null;
  const head = event?.pull_request?.head?.sha;
  const base = event?.pull_request?.base?.ref;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head) || typeof base !== 'string' || !base) return null;
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return null;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/compare/${encodeURIComponent(base)}...${head}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const behind = (await response.json())?.behind_by;
    return Number.isSafeInteger(behind) && behind > 0 ? behind : null;
  } catch {
    return null;
  }
}

export const behindMainReason = (base, behind) => `head 落后 ${base} ${behind} 个提交：strict 下合不进去，不跑；合入 ${base} 后的 head 会跑`;

export function outputLines(check, selection) {
  const apps = [...appDependencies(selection.suites), ...(selection.added ?? []).map(({ app }) => app).filter(Boolean)];
  return [
    `suites=${JSON.stringify(selection.suites)}`,
    `app_deps=${JSON.stringify([...new Set(apps)].sort())}`,
    ...Object.keys(SUITES[check]).map((id) => `run_${id.replace(/-/g, '_')}=${selection.suites.includes(id)}`),
  ];
}

// The test files a Node test process runs at once (FABLE-ci-10min-20261119 7.3): the database tests always, the unit tests
// in a hosted job (GITHUB_ACTIONS), max(2, min(4, floor(cores / 4))); a local run keeps the unit tests at 2, as the local
// limits (two suites at once) assume.
export function testConcurrency(cores = os.availableParallelism()) {
  return Math.max(2, Math.min(4, Math.floor(cores / 4)));
}

// No base commit: unset, empty, or GitHub's all-zero SHA. expandArgv refuses {base} then, executeSuite refuses the suite.
const missingBase = (base) => !base || /^0+$/.test(base);
const BASE_REQUIRED = 'CI_BASE_SHA is required for this suite';

// hosted: a CI job's expansion. The trusted side passes it and its core count to the candidate's (readCandidate), whose
// environment has no GITHUB_ACTIONS (test-env.mjs keep), so both sides expand the same command alike.
export function expandArgv(argv, { cwd, root, base, report, listUnit = () => unitTestFiles(cwd),
  hosted = process.env.GITHUB_ACTIONS === 'true', cores = os.availableParallelism() }) {
  let unit = null;
  const units = () => (unit ??= listUnit());
  return argv.flatMap((arg) => {
    if (arg === '{ci-script-tests}') {
      if (!root) throw new Error('{ci-script-tests} needs the checkout root');
      return ciScriptTests(root, cwd, units());
    }
    if (arg === '{unit-tests}') {
      const files = units();
      // An empty list would make `node --test` run every file it finds.
      if (files.length === 0) throw new Error('no unit test files');
      return files;
    }
    if (arg === '{db-concurrency}') return [`--test-concurrency=${testConcurrency(cores)}`];
    if (arg === '{unit-concurrency}') return [`--test-concurrency=${hosted ? testConcurrency(cores) : 2}`];
    const tests = /^\{tests:(.+)\}$/.exec(arg);
    if (tests) {
      const files = readdirSync(path.join(cwd, tests[1])).filter((name) => name.endsWith('.test.mjs')).sort()
        .map((name) => `${tests[1]}/${name}`);
      if (files.length === 0) throw new Error(`no test files in ${tests[1]}`);
      return files;
    }
    if (arg === '{base}') {
      if (missingBase(base)) throw new Error(BASE_REQUIRED);
      return [base];
    }
    if (arg === '{report}') return [report];
    return [arg];
  });
}

// {ci-script-tests}: the *.test.mjs files directly in CI_SCRIPT_TEST_DIRS (from the checkout root) that run in no other
// way here, sorted, relative to cwd; a new file joins without an edit (defect ddc94356; FABLE-tests-outside-required-
// suites-20261121, addendum ruling 1). Left out: what an application unit test (unit, relative to cwd) imports, and the
// admission self-tests, which run in their own suite whenever their code changes, keep their own known failures and
// print GitHub annotations; with both, the tests they import. Other suite-listed tests, such as the selection test,
// check the whole repository but run only when a few files change: they stay.
export const CI_SCRIPT_TEST_DIRS = ['scripts', 'scripts/ci', 'scripts/ci/self-hosted', 'scripts/runner'];
// The module specifiers a file names, read as apps/clued-cloud/scripts/select-tests.mjs reads them (its SPECIFIER_PATTERNS;
// check-tests-covered.test.mjs holds the two equal). Kept here because this file is loaded alone (local-verify copies it).
export const IMPORT_PATTERNS = [
  /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const importSpecifiers = (source) => IMPORT_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
export function ciScriptTests(root, cwd, unit) {
  const source = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const covered = new Set();
  for (const file of unit.map((name) => path.resolve(cwd, name))) {
    for (const specifier of importSpecifiers(source(file))) covered.add(path.resolve(path.dirname(file), specifier));
  }
  for (const command of SUITE_COMMANDS['admission-self-tests']) {
    for (const arg of command.argv) if (arg.endsWith('.test.mjs')) covered.add(path.resolve(root, command.cwd, arg));
  }
  for (const file of covered) { // the Set visits what is added
    if (!file.endsWith('.test.mjs')) continue;
    for (const specifier of importSpecifiers(source(file))) {
      if (specifier.startsWith('.')) covered.add(path.resolve(path.dirname(file), specifier));
    }
  }
  const files = CI_SCRIPT_TEST_DIRS.flatMap((dir) => (existsSync(path.join(root, dir)) ? readdirSync(path.join(root, dir), { withFileTypes: true }) : [])
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs')).map((entry) => `${dir}/${entry.name}`))
    .filter((file) => !covered.has(path.resolve(root, file))).sort();
  if (files.length === 0) throw new Error(`no CI-script test files under ${root}`);
  return files.map((file) => path.relative(cwd, path.join(root, file)).replaceAll('\\', '/'));
}

const real = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

// Reads the reporter's JSON lines (ci-test-failures-reporter.mjs). Files are
// made relative to the checkout root with forward slashes, both sides resolved
// to real paths (Node reports a test file's real path; a runner directory may
// sit behind a link), so entries match on any runner.
export function readReport(text, root) {
  const events = [];
  const base = root ? real(root) : null;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { events, summary: null, corrupt: true };
    }
    if (typeof event.file === 'string' && base) {
      event.file = path.relative(base, real(event.file)).split(path.sep).join('/');
    }
    events.push(event);
  }
  return { events, summary: events.find((event) => event.type === 'summary') ?? null, corrupt: false };
}

// The verdict of a run with known failures. It fails on: any failure that is
// not exactly a known entry; an exit other than 0 or 1 (a signal, a timeout,
// a crash of the runner); a report without the run's summary (the runner did
// not finish); or a nonzero exit with no failure in the report.
export function knownFailureVerdict({ status, report, known }) {
  const keys = new Map(known.map((entry) => [knownKey(entry), entry]));
  const failures = report.events.filter((event) => event.type === 'fail');
  const unexpected = failures.filter((event) => !keys.has(knownKey(event)));
  const expected = failures.filter((event) => keys.has(knownKey(event)));
  const where = (entry) => `${entry.file} :: ${entry.path.join(' > ')}`;
  const failedAt = new Set(failures.map(where));
  const passedAt = new Set(report.events.filter((event) => event.type === 'pass').map(where));
  const fixed = known.filter((entry) => passedAt.has(where(entry)) && !failedAt.has(where(entry)));
  const missing = known.filter((entry) => !passedAt.has(where(entry)) && !failedAt.has(where(entry)));
  const problems = [];
  if (report.corrupt) problems.push('the test report is not readable');
  if (!report.summary) problems.push('the test run did not finish (no summary in the report)');
  if (status !== 0 && status !== 1) problems.push(`the test runner exited ${status}`);
  if (status === 1 && failures.length === 0) problems.push('the test runner failed without a failing test in the report');
  if (status === 0 && failures.length > 0) problems.push('the report has failures but the runner exited 0');
  return { ok: problems.length === 0 && unexpected.length === 0, problems, unexpected, expected, fixed, missing };
}

// Windows ships npm/npx as .cmd shims, which spawn cannot start without a shell
// (ENOENT, or EINVAL since the CVE-2024-27980 fix). Run npm's own JS entry with this
// node instead: no shell, so no quoting or argument injection. Elsewhere unchanged.
const NPM_ENTRIES = { npm: 'npm-cli.js', npx: 'npx-cli.js' };
export function resolveCommand(argv, { platform = process.platform, nodePath = process.execPath, exists = existsSync } = {}) {
  const entry = NPM_ENTRIES[argv[0]];
  if (platform !== 'win32' || !entry) return argv;
  const script = path.win32.join(path.win32.dirname(nodePath), 'node_modules', 'npm', 'bin', entry);
  return exists(script) ? [nodePath, script, ...argv.slice(1)] : argv;
}

// The environment of every suite child (test marker, listed variables, fake identity) is test-env.mjs; local-verify.mjs reads it too.
export {
  FAKE_GITHUB_TOKEN, KEEP_VARIABLE, TEST_ENV_RULES, TEST_ENV_VERSION, TEST_GIT_IDENTITY, fakeIdentityEnv, keptVariables, ownIdentityDir, testEnv,
} from './test-env.mjs';
// The command line marks its own environment first, before any child starts (the unit-test listing included), when it runs
// suites: --run, --run-selected, --write-known, --run-files, and --run-prepush; it also makes the run's fake identity
// directory (Task 2ee162c2). --check runs nothing and is left as it is.
export function markTestRun(argv, env) {
  if (!['--run', '--run-selected', '--write-known', '--run-files', '--run-prepush'].some((flag) => argv.includes(flag))) return;
  env.CLUED_UNDER_TEST = '1';
  env.CLUED_TEST_IDENTITY_DIR = ownIdentityDir(env);
}
// A run whose identity directory cannot be made does not start (ruling 11-20 "补：止血 PR 第四轮" §1).
export const TEST_IDENTITY_EXIT = 71;

// --run-files: the suite's own commands with the test-file operands replaced by
// the named files. Only the operands change, so the command is the one CI runs.
// A command that cannot take a named file is skipped (lint, build, validators,
// drills); a named file no command takes is refused before anything starts.
const posixPath = (file) => file.replaceAll('\\', '/');
const operandsAfter = (argv, index) => argv.slice(index + 1).filter((arg) => !arg.startsWith('-'));
const optionValue = (argv, flag) => argv[argv.indexOf(flag) + 1];
// Switches the lists use after the anchor (--test, -m unittest) that take no value. After it, an element that follows any other switch
// without = may be that switch's value (--test-name-pattern foo, --import ./setup.mjs, -k foo): dropping the other operands
// would drop it too, so such a command cannot be planned (gap A L1). A switch missing here only runs the whole command.
const VALUELESS_SWITCHES = new Set(['--test-force-exit']);
const takesSeparateValue = (argv, anchor) => argv.some((arg, i) => i > anchor + 1 && !arg.startsWith('-')
  && argv[i - 1].startsWith('-') && !argv[i - 1].includes('=') && !VALUELESS_SWITCHES.has(argv[i - 1]));

export function filterCommand(command, argv, named) {
  const repo = (operand) => path.posix.join(command.cwd, posixPath(operand));
  const result = { runs: [], matched: [], accepts: [] };
  const testAt = argv.indexOf('--test');
  const unittestAt = argv.findIndex((arg, i) => arg === 'unittest' && argv[i - 1] === '-m');
  const listAt = testAt >= 0 ? testAt : unittestAt >= 0 && argv[unittestAt + 1] !== 'discover' ? unittestAt : -1;
  if (listAt >= 0 && takesSeparateValue(argv, listAt)) return result;
  if (testAt >= 0) {
    const files = operandsAfter(argv, testAt);
    result.accepts = files.map(repo);
    const kept = new Set(files.filter((file) => named.has(repo(file))));
    if (kept.size > 0) {
      result.runs = [argv.filter((arg, i) => i <= testAt || arg.startsWith('-') || kept.has(arg))];
      result.matched = [...kept].map(repo);
    }
  } else if (unittestAt >= 0 && argv[unittestAt + 1] === 'discover') {
    const directory = repo(optionValue(argv, '-s'));
    const pattern = optionValue(argv, '-p') ?? 'test*.py';
    result.accepts = [`${directory}/${pattern}`];
    for (const file of named) {
      if (path.posix.dirname(file) !== directory || !globToRegExp(pattern).test(path.posix.basename(file))) continue;
      const argvFor = [...argv];
      argvFor[argv.indexOf('-p') + 1] = path.posix.basename(file);
      result.runs.push(argvFor);
      result.matched.push(file);
    }
  } else if (unittestAt >= 0) {
    // A file operand, or a dotted module name (tests.test_x is tests/test_x.py under cwd).
    const fileOf = (arg) => (/[\\/]/.test(arg) || arg.endsWith('.py') ? arg
      : /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(arg) ? `${arg.replaceAll('.', '/')}.py` : null);
    const operands = operandsAfter(argv, unittestAt).filter(fileOf);
    result.accepts = operands.map((arg) => repo(fileOf(arg)));
    const kept = new Set(operands.filter((arg) => named.has(repo(fileOf(arg)))));
    if (kept.size > 0) {
      result.runs = [argv.filter((arg, i) => i <= unittestAt || arg.startsWith('-') || kept.has(arg))];
      result.matched = [...kept].map((arg) => repo(fileOf(arg)));
    }
  } else {
    const operands = operandsAfter(argv, 0);
    if (operands.length === 1 && /\.(mjs|py)$/.test(operands[0])) {
      result.accepts = [repo(operands[0])];
      if (named.has(repo(operands[0]))) {
        result.runs = [argv];
        result.matched = [repo(operands[0])];
      }
    }
  }
  return result;
}

// The test files a candidate command only adds to a trusted command of the same directory: the trusted argv is a
// subsequence of the candidate's and every other element is a new test file operand, as --run-files recognises one
// (filterCommand). Null for any other change (a switch, a changed or removed element): that command is added whole.
function addedTestFiles(command, baseline) {
  for (const trusted of baseline) {
    if (trusted.cwd !== command.cwd) continue;
    const extra = [];
    let next = 0;
    for (const arg of command.argv) {
      if (next < trusted.argv.length && arg === trusted.argv[next]) next += 1;
      else extra.push(arg);
    }
    if (next < trusted.argv.length || extra.length === 0 || new Set(extra).size !== extra.length) continue;
    if (extra.some((arg) => arg.startsWith('-') || /^\{.*\}$/.test(arg) || trusted.argv.includes(arg))) continue;
    const files = extra.map((arg) => path.posix.join(command.cwd, posixPath(arg)));
    const { runs, matched } = filterCommand(command, command.argv, new Set(files));
    if (runs.length === 1 && matched.length === new Set(files).size) return files;
  }
  return null;
}

// The argv a suite command runs: its placeholders expanded and, for a command that only adds test files to a trusted one
// (requiredCommands), just those files, planned as --run-files plans them.
export function commandArgv(command, options) {
  const argv = command.expanded ? command.argv : expandArgv(command.argv, options);
  if (!command.files) return argv;
  const [only] = filterCommand(command, argv, new Set(command.files)).runs;
  if (!only) throw new Error(`cannot run only the added test files of (${command.cwd}) ${command.argv.join(' ')}`);
  return only;
}

// --shard i/n (PLAN-hosted-windows-speed-20261123 block 3): n jobs split one --run-selected between them. The plan is cut into
// units: each test file operand of a command that lists its test files (node --test, python -m unittest <files>), as
// --run-files recognises one (filterCommand), and every other command whole (unittest discover, drills, check scripts, npm,
// and a listing command with an operand that is not a test file, such as a package: it would leave every shard's command).
// A unit's global number is the suite's own number (shardOffset) plus the unit's place in the suite's plan; shard i runs the
// units whose number mod n is i - 1, so the shards together run every unit once and n = 1 runs today's plan command for
// command. A listing command's files are packed by their seconds instead (FABLE-hosted-win-shard-balance-20261124, block 5):
// see shardCommand; with no table, or none of the command's files in it, that is the same mod n rule. The suite's number
// comes from its id alone, never from what else a shard selected: each shard selects on its own
// (one that cannot read the changed files runs every suite), and a suite's units go to the same shards whichever other
// suites a shard runs or stops at their first failure (REVIEW-hosted-speed-b3-20261124 H1). A listing command runs only its
// shard's files, with its own switches, and runs again in full (passesAgain) as that narrower command; its known failures
// are those of its shard's files, and the shard with its first file also has those of files the command no longer lists.
// The whole-run-again thresholds (failures, files, time) count that narrower command, never summed across shards
// (FABLE-hosted-b3-L2-ruling-20261124): what keeps a real failure red -- the run again passes in full, each test that
// failed passes, the test files match base -- is the same per shard; the summary job reads only each shard's result.
export function parseShard(text) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(text ?? ''));
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`--shard takes i/n with 1 <= i <= n: ${text}`);
  return { index: Number(match[1]), total: Number(match[2]) };
}

// The number of a suite's first unit: its place in SUITE_COMMANDS; past those, for a suite only the candidate has, a number
// from its id.
export function shardOffset(id) {
  const ids = Object.keys(SUITE_COMMANDS);
  if (ids.includes(id)) return ids.indexOf(id);
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return ids.length + hash;
}

// ci-shard-seconds.json as a Map of repository path -> whole seconds. A table that is missing or not that shape is an empty
// one (problem says why): an aid that fails only does nothing, it never stops a shard (FABLE-hosted-win-shard-balance §1.3).
export function readShardSeconds(file = SHARD_SECONDS_PATH) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { table: new Map(), problem: `${path.basename(file)} cannot be read (${error?.code ?? error?.message ?? error}); every file weighs 1` };
  }
  const entries = data && typeof data === 'object' && !Array.isArray(data) ? Object.entries(data) : null;
  const valid = entries && entries.every(([key, value]) => key.length > 0 && !key.startsWith('/') && !key.includes('\\')
    && Number.isSafeInteger(value) && value > 0);
  if (!valid) return { table: new Map(), problem: `${path.basename(file)} is not {"<repository path>": whole seconds}; every file weighs 1` };
  return { table: new Map(entries), problem: null };
}

// The shard of each of a command's files: heaviest first (seconds from the table, 1 when it has none; equal ones in the
// command's order), each into the lightest shard, equal ones taken in turn from shard position mod n. With equal weights that
// puts unit u in shard (position + u) mod n, the rule for a command that runs whole. It reads only this command's files, the
// table and the suite's number, never what else a shard selected (REVIEW-hosted-speed-b3-20261124 H1).
function packFiles(files, total, position, seconds) {
  const weight = (file) => {
    const value = seconds instanceof Map ? seconds.get(file) : seconds && Object.hasOwn(seconds, file) ? seconds[file] : undefined;
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
  };
  const weights = files.map(weight);
  const order = files.map((file, unit) => unit).sort((a, b) => weights[b] - weights[a] || a - b);
  const loads = new Array(total).fill(0);
  const shardOf = new Array(files.length);
  const start = position % total;
  for (const unit of order) {
    let best = start;
    for (let step = 1; step < total; step += 1) {
      const candidate = (start + step) % total;
      if (loads[candidate] < loads[best]) best = candidate;
    }
    shardOf[unit] = best;
    loads[best] += weights[unit];
  }
  return shardOf;
}

// The part of one expanded command a shard runs: argv null when none; units, the units the command counts for; files, the
// repository paths of the shard's test files, and listed, those of all the command's (both null for a command that runs
// whole). seconds: the table (readShardSeconds), passed in; none packs as one with no entry.
export function shardCommand(command, argv, shard, position, seconds = null) {
  const { accepts, ...part } = shardPart(command, argv, shard, position, seconds);
  return part;
}

// shardCommand, with accepts: every test file of a listing command (empty for a command that runs whole).
function shardPart(command, argv, { index, total }, position, seconds) {
  const testAt = argv.indexOf('--test');
  const unittestAt = argv.findIndex((arg, i) => arg === 'unittest' && argv[i - 1] === '-m');
  const listing = testAt >= 0 || (unittestAt >= 0 && argv[unittestAt + 1] !== 'discover');
  const { accepts } = listing ? filterCommand(command, argv, new Set()) : { accepts: [] };
  // Each operand after the anchor a test file: filterCommand keeps no other operand (review M1).
  const everyOperand = listing && accepts.length === operandsAfter(argv, testAt >= 0 ? testAt : unittestAt).length;
  if (everyOperand && accepts.length > 0 && new Set(accepts).size === accepts.length) {
    const shardOf = packFiles(accepts, total, position, seconds);
    const files = accepts.filter((file, unit) => shardOf[unit] === index - 1);
    if (files.length === 0) return { argv: null, units: accepts.length, files: null, listed: null, accepts };
    const { runs, matched } = filterCommand(command, argv, new Set(files));
    if (runs.length !== 1 || matched.length !== files.length) throw new Error(`cannot shard (${command.cwd}) ${argv.join(' ')}`);
    return { argv: runs[0], units: accepts.length, files: new Set(files), listed: new Set(accepts), accepts };
  }
  return { argv: position % total === index - 1 ? argv : null, units: 1, files: null, listed: null, accepts: [] };
}

// The seconds a shard spent on each of its files: the sum of the file's top-level tests (the reporter's ms), so a test that
// waits on a child process counts the child's time (fleet-node-children). One decimal; a file with no timed test is left out.
export function shardSecondsOf(report, files) {
  const ms = new Map();
  for (const event of report.events) {
    if ((event.type !== 'pass' && event.type !== 'fail') || typeof event.ms !== 'number' || !files.has(event.file)) continue;
    ms.set(event.file, (ms.get(event.file) ?? 0) + event.ms);
  }
  return Object.fromEntries([...ms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, total]) => [file, Math.round(total / 100) / 10]));
}

// Gap A (FABLE r8 B2): the trusted list first, in its order and with its policy, even if the PR removes or replaces a
// command; then the commands the candidate's selector adds to the suite. Reading the candidate is lazy: only after the
// baseline commands have run, and always when the candidate's selector is another file: its bytes say nothing about the
// modules it imports. A separate Node process exports the candidate's list, and only what it prints, once validated here,
// can add a command; candidate code never runs inside the process that decides which commands passed. A candidate command
// that only adds test files to a trusted command runs just those files, and none carries a policy. A checkout without
// scripts/ci adds nothing; one with scripts/ci but no selector moved or deleted it, so what it adds cannot be read and the
// suite fails.
// The permission flags are no boundary of any kind (FABLE-new-suite-run-points-20261121 §3): the commands list may start
// processes (--allow-child-process), which the permission model does not follow, the model follows symbolic links and the
// network is open. They only keep an unintended write out. This guards against a change that would run less, swap a command
// or widen the known failures by editing the selection, not against hostile code: that is for the protected-path rules and
// review, and the suite commands run the candidate's code with the same user and environment anyway. What still holds:
// candidate code never runs in the process that decides; the candidate only adds commands; what it adds carries no policy;
// suite names, platforms and application dependencies are validated before they reach GITHUB_OUTPUT. The child gets the
// suite environment (no real token), but its parent's token is readable to a process of the same user, so a step that holds
// a token with write access or any secret must never call this selector with --root.
// Task cb5017b6 (FABLE-c2-review-rulings-20261121, "补" ruling 2): each side expands its own commands and the expanded
// commands are compared, so a placeholder only the candidate knows, or one the candidate expands differently, adds just the
// test files it adds. The candidate's process reads the whole checkout and may start the unit-test listing, with the
// environment a suite command gets. A suite only the candidate has (no trusted commands) runs the candidate's commands
// whole. Equal expanded commands add nothing.
const CANDIDATE_EXPORT = `const [url, mode, name, root, base, report, hosted, cores] = process.argv.slice(1);
const path = await import('node:path');
const m = await import(url);
const plain = (c) => typeof c?.cwd === 'string' && Array.isArray(c.argv) && c.argv.every((a) => typeof a === 'string');
let out = null;
if (mode === 'commands') {
  if (m.SUITE_COMMANDS && Object.hasOwn(m.SUITE_COMMANDS, name)) {
    const list = m.SUITE_COMMANDS[name];
    out = !Array.isArray(list) ? list : list.map((c) => (plain(c) && typeof m.expandArgv === 'function'
      ? { cwd: c.cwd, argv: m.expandArgv(c.argv, { cwd: path.join(root, c.cwd), root, base: base || undefined, report, hosted: hosted === 'true', cores: Number(cores) }) } : c));
  }
} else {
  out = Object.keys(m.SUITES?.[name] ?? {}).map((id) => ({ id,
    platforms: typeof m.suitePlatforms === 'function' ? m.suitePlatforms(id) : m.SUITE_PLATFORMS?.[id]?.platforms ?? null,
    app: m.SUITE_APP_DEPENDENCIES?.[id] ?? null }));
}
process.stdout.write(JSON.stringify(out));`;

// The candidate's selector: null when it is this file or the checkout has no scripts/ci.
function candidateSelectorOf(root, trusted, what) {
  const candidate = path.resolve(root, 'scripts/ci/ci-required-selection.mjs');
  if (real(candidate) === real(trusted)) return null;
  if (!existsSync(candidate)) {
    if (!existsSync(path.dirname(candidate))) return null;
    throw new Error(`the candidate has scripts/ci but no ci-required-selection.mjs: ${what} cannot be read`);
  }
  return candidate;
}

function readCandidate(candidate, root, mode, name, { base, report, env }, what) {
  const reads = [...new Set([path.resolve(root), real(root)])].map((dir) => `--allow-fs-read=${dir}`);
  // Only expanding commands may start a process (the unit-test listing); reading the suite tables does not.
  const spawns = mode === 'commands' ? ['--allow-child-process'] : [];
  const read = spawnSync(process.execPath, ['--permission', ...reads, ...spawns, '--input-type=module', '-e', CANDIDATE_EXPORT,
    pathToFileURL(candidate).href, mode, name, root, base ?? '', report, String(env.GITHUB_ACTIONS === 'true'), String(os.availableParallelism())], {
    cwd: root, env: testEnv(env), encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (read.status !== 0) throw new Error(`cannot read ${what}: ${read.error?.message ?? read.stderr}`);
  return JSON.parse(read.stdout);
}

export function* requiredCommands(id, root, { baseline = SUITE_COMMANDS[id], trusted = fileURLToPath(import.meta.url), env = process.env,
  base = env.CI_BASE_SHA, report = path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-report.json`) } = {}) {
  if (baseline !== undefined && !Array.isArray(baseline)) throw new Error(`unknown suite: ${id}`);
  const own = baseline ?? [];
  yield* own;
  const what = `the commands the candidate adds to ${id}`;
  const candidate = candidateSelectorOf(root, trusted, what);
  if (!candidate) {
    if (baseline === undefined) throw new Error(`unknown suite: ${id}`);
    return;
  }
  const commands = readCandidate(candidate, root, 'commands', id, { base, report, env }, what);
  if (commands === null && baseline === undefined) throw new Error(`unknown suite: ${id}`);
  // A new suite that runs nothing would pass having checked nothing.
  if (baseline === undefined && Array.isArray(commands) && commands.length === 0) throw new Error(`the candidate's suite ${id} has no command`);
  if (commands !== null && !Array.isArray(commands)) throw new Error(`invalid candidate command list for ${id}`);
  const key = ({ cwd, argv }) => JSON.stringify([cwd, argv]);
  // The trusted commands as they ran: expanded by this file's rules, with the same base commit and report file.
  const expanded = own.map((command) => ({ cwd: command.cwd,
    argv: expandArgv(command.argv, { cwd: path.join(root, command.cwd), root, base, report, hosted: env.GITHUB_ACTIONS === 'true' }) }));
  const seen = new Set(expanded.map(key));
  for (const command of commands ?? []) {
    const { cwd, argv } = command ?? {};
    if (typeof cwd !== 'string' || !Array.isArray(argv) || !argv[0] || !argv.every((arg) => typeof arg === 'string')) {
      throw new Error(`invalid candidate command for ${id}`);
    }
    const identity = key(command);
    if (seen.has(identity)) continue;
    const relative = path.relative(real(root), real(path.resolve(root, cwd)));
    if (path.isAbsolute(cwd) || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`candidate command directory is outside the checkout: ${cwd}`);
    }
    seen.add(identity);
    // Only the trusted list can attach a known-failure allowance (or any other policy) to a command.
    const files = addedTestFiles({ cwd, argv }, expanded);
    yield files ? { cwd, argv, expanded: true, files } : { cwd, argv, expanded: true };
  }
}

// The suites of a check only the candidate has (no trusted check names them), each runnable by --run, by the candidate's
// own platform table (all platforms when it names none), with its application dependency. Empty when the checkout's
// selector is this file or the checkout has no scripts/ci.
const SUITE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function candidateSuites(check, root, { platform = null, trusted = fileURLToPath(import.meta.url), env = process.env } = {}) {
  const what = `the suites the candidate adds to ${check}`;
  const candidate = candidateSelectorOf(root, trusted, what);
  if (!candidate) return [];
  const listed = readCandidate(candidate, root, 'suites', check, { report: '', env }, what);
  if (!Array.isArray(listed)) throw new Error(`invalid candidate suite list for ${check}`);
  const known = new Set([...Object.keys(SUITE_COMMANDS), ...Object.values(SUITES).flatMap((suites) => Object.keys(suites))]);
  const added = [];
  for (const { id, platforms, app } of listed) {
    if (typeof id !== 'string' || !SUITE_NAME.test(id)) throw new Error(`invalid candidate suite name in ${check}: ${JSON.stringify(id)}`);
    if (known.has(id)) continue;
    const on = platforms ?? PLATFORMS;
    if (!Array.isArray(on) || !on.every((name) => PLATFORMS.includes(name))) throw new Error(`invalid candidate platforms for ${id}`);
    // The trusted ci-deps.mjs installs it from the runner's store: an application of the checkout, with its lockfile.
    if (app !== null && (typeof app !== 'string' || !/^apps\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(app)
        || !existsSync(path.join(root, app, 'package-lock.json')))) {
      throw new Error(`invalid candidate application dependency for ${id}: ${JSON.stringify(app)} (apps/<name> with a package-lock.json)`);
    }
    if (platform === null || on.includes(platform)) added.push({ id, app });
  }
  return added;
}

export class RunFilesError extends Error {}

export function planFiles(id, { root, files, env = process.env }) {
  if (!Object.hasOwn(SUITE_COMMANDS, id)) throw new RunFilesError(`unknown suite: ${id}`);
  const list = (files ?? []).map(posixPath);
  if (list.length === 0) throw new RunFilesError('no test file named');
  for (const file of list) {
    if (path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) || path.posix.normalize(file).startsWith('..')) {
      throw new RunFilesError(`name test files by repository path, relative to the checkout: ${file}`);
    }
  }
  const named = new Set(list.map((file) => path.posix.normalize(file)));
  const missing = [...named].filter((file) => !existsSync(path.join(root, file)));
  if (missing.length > 0) throw new RunFilesError(`not found under ${root}: ${missing.join(', ')}`);
  const steps = [];
  const matched = new Set();
  const accepts = [];
  const report = path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-report.json`);
  for (const command of requiredCommands(id, root, { env, base: env.CI_BASE_SHA || 'unset', report })) {
    const cwd = path.join(root, command.cwd);
    // {base} is not a test file; a placeholder keeps commands that need it plannable (they are skipped).
    const argv = command.expanded ? command.argv : expandArgv(command.argv, { cwd, root, base: env.CI_BASE_SHA || 'unset', report });
    // A command that only adds test files to a trusted one runs no other file (the trusted command runs those).
    const filtered = filterCommand(command, argv, command.files ? new Set(command.files.filter((file) => named.has(file))) : named);
    accepts.push(...filtered.accepts);
    filtered.matched.forEach((file) => matched.add(file));
    steps.push(...filtered.runs.map((run) => ({ command, argv: run })));
  }
  const unmatched = [...named].filter((file) => !matched.has(file));
  if (unmatched.length > 0) {
    throw Object.assign(new RunFilesError(`suite ${id} does not run: ${unmatched.join(', ')}\nit runs: ${[...new Set(accepts)].join(' ') || '(no test file)'}`),
      { unmatched });
  }
  return { steps, named };
}

// Where the files a suite refused run instead, read as the coverage check reads them (check-tests-covered.mjs): the suite
// whose command takes each one, directly or through the running test that imports it, or why none does (its table). Only a
// hint, given after the refusal: when it cannot be read it says why.
async function whereFilesRun(files, root) {
  if (!files?.length) return [];
  try {
    const { TABLE_PATH, readTable, whereTestsRun } = await import('./check-tests-covered.mjs');
    const where = whereTestsRun(root, files);
    const listed = new Map((readTable(root).tests ?? []).map((entry) => [entry.path, entry]));
    return files.map((file) => {
      const runs = where.get(file);
      if (runs) {
        return `${file} runs in ${runs.suites.join(', ')}${runs.through === file ? '' : ` imported by ${runs.through}`}: --run-files ${runs.suites[0]} ${runs.through}`;
      }
      const entry = listed.get(file);
      return `${file}: no required suite runs it${entry ? ` (${TABLE_PATH}: ${entry.kind}, ${entry.reason})` : ''}`;
    });
  } catch (error) {
    return [`(where ${files.join(', ')} run could not be read: ${error.message})`];
  }
}

// --run-prepush --root <tree>: PREPUSH_COMMANDS in order, expanded and run in the environment a suite's commands get
// (expandArgv, testEnv, resolveCommand). Unlike --run it is not a suite run: it does not go through --run-files, does not
// link or install an application's dependencies (linkSuiteDependencies) and does not wait for a machine-wide suite slot:
// the commands take seconds together, and the slots keep heavy suites from crowding the node's production CI. Every
// command runs, each with a PREPUSH_TIMEOUT_MS timeout; a red one is named with the tests that failed.
export function runPrepush(root, { env = process.env, spawn = spawnSync, log = console.log, platform = process.platform,
  commands = PREPUSH_COMMANDS, timeoutMs = PREPUSH_TIMEOUT_MS, readReportFile = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '') } = {}) {
  // One verdict at the end: a red command is a clear red even when a later one timed out, did not start, could not be
  // expanded or threw (the push entry refuses only on exit 1 with a "prepush 红：" line); no red but a command that did
  // not run is PREPUSH_ERROR_EXIT, never 1, so a check that could not run never stops a push.
  const red = [];
  const notRun = [];
  for (const command of commands) {
    const cwd = path.join(root, command.cwd);
    const named = `(${command.cwd}) ${command.argv.join(' ')}`;
    try {
      let argv;
      try {
        argv = expandArgv(command.argv, { cwd, root, hosted: false });
      } catch (error) {
        throw new Error(`cannot be expanded: ${error.message}`);
      }
      let reportDir = null;
      if (isNodeTest(argv) && existsSync(REPORTER_PATH)) {
        try {
          reportDir = mkdtempSync(path.join(os.tmpdir(), 'prepush-tests-'));
        } catch { /* runs without naming its failed tests */ }
      }
      const report = reportDir ? path.join(reportDir, 'failures.jsonl') : null;
      log(`::group::prepush: (${command.cwd}) ${argv.join(' ')}`);
      let result;
      try {
        const run = resolveCommand(report ? withReporter(argv, report) : argv, { platform });
        result = spawn(run[0], run.slice(1), { cwd, env: testEnv(env), stdio: command.quiet ? ['ignore', 'pipe', 'inherit'] : 'inherit', timeout: timeoutMs });
        if (command.quiet && result.stdout) {
          const text = result.stdout.toString();
          log(result.status === 0 ? `${text.split('\n').slice(0, 4).join('\n')}\n...` : text);
        }
      } finally {
        log('::endgroup::');
      }
      let tests = [];
      if (report) {
        try {
          tests = [...new Set(readReport(readReportFile(report), root).events.filter((event) => event.type === 'fail').map(testAt))];
        } catch { /* the command's own output names them */ }
        try {
          rmSync(reportDir, { recursive: true, force: true });
        } catch { /* a report directory left in the temp directory is litter, not a verdict */ }
      }
      if (result.error || result.signal || result.status === null) {
        throw new Error(result.error?.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs / 1000} s`
          : result.error ? `did not start: ${result.error.message}` : `ended by ${result.signal}`);
      }
      if (result.status !== 0) red.push({ command, argv, status: result.status, tests });
    } catch (error) {
      log(`prepush: ${named} ${error.message}; this command did not run`);
      notRun.push(`${named}: ${error.message}`);
    }
  }
  if (red.length === 0) {
    if (notRun.length) {
      log(`prepush: 没跑成 ${notRun.length} 条、没有红，按未跑处理`);
      return PREPUSH_ERROR_EXIT;
    }
    log(`prepush: 全部通过（${commands.length} 条）`);
    return 0;
  }
  for (const { command, argv, status, tests } of red) {
    log(`prepush 红：(${command.cwd}) ${argv.join(' ')} 退出 ${status}`);
    for (const name of tests) log(`  失败的测试：${name}`);
  }
  for (const line of notRun) log(`  另有没跑成的：${line}`);
  log(`复现：node scripts/ci/ci-required-selection.mjs --run-prepush --root ${root}`);
  return 1;
}

export async function runSuite(id, { root, env = process.env, log = console.log, captureKnown = false, keep = false, files = null, shard = null } = {}) {
  // A suite this file does not have may be one the candidate adds (requiredCommands reads it); not in this file's own checkout.
  if (!Object.hasOwn(SUITE_COMMANDS, id) && (files || captureKnown || !candidateSelectorOf(root, fileURLToPath(import.meta.url), id))) {
    throw new Error(`unknown suite: ${id}`);
  }
  if (files) {
    if (env.GITHUB_ACTIONS === 'true') {
      log('run-files: refused under GITHUB_ACTIONS; a targeted run is never a suite verdict, use --run');
      return 2;
    }
    try {
      planFiles(id, { root, files, env });
    } catch (error) {
      if (!(error instanceof RunFilesError)) throw error;
      log(`run-files ${id}: ${error.message}`);
      for (const line of await whereFilesRun(error.unmatched, root)) log(line);
      return 2;
    }
  }
  if (captureKnown && !SUITE_COMMANDS[id].some((command) => command.known)) {
    throw new Error(`suite ${id} has no known-failure command`);
  }
  if (env.GITHUB_ACTIONS === 'true') return executeSuite(id, { root, env, log, captureKnown, keep, ...(shard ? { shard } : {}) });
  // The local suite slot runs the suite whole: a shard of it would pass having run a part.
  if (shard) {
    log(`${id}: --shard runs only in a CI job (GITHUB_ACTIONS=true); run locally with --run or --run-files`);
    return 2;
  }
  // The application's dependencies the CI job installs: a local run in a checkout without them (a fresh worktree) links
  // local-verify's store first, outside the slot (R2 review 11-21: a targeted database test failed on its first import).
  // Loaded only for a checkout that has the application and lacks its dependencies: every other run keeps its startup.
  const app = path.join(root, 'apps', 'clued-cloud');
  if (existsSync(path.join(app, 'package.json')) && !existsSync(path.join(app, 'node_modules'))) {
    const { linkSuiteDependencies } = await import('./local-verify.mjs');
    linkSuiteDependencies(id, root, { env, log });
  }
  const { withLocalSuiteSlot } = await import('./local-suite-slots.mjs');
  return withLocalSuiteSlot(id, {
    root, env, timeoutExit: LOCAL_TIMEOUT_EXIT,
    work: { selectorUrl: import.meta.url, captureKnown, keep, files },
  });
}

// What a host cannot give a test (FABLE-hosted-windows-suites-20261122 §2.3, task 04f9b91b). The host says what it lacks
// in CLUED_CI_HOST_LACKS (only the hosted workflow sets it: hosted-required.test.mjs), a test says what it needs in its own
// name ("... [needs:non-elevated]"), and every node --test command of a suite gets Node's skip pattern for those names:
// the marked tests and every subtest under them do not run there (ci-required-selection.test.mjs runs Node on a fixture).
// A host that does not set it runs them all, so a node that turns elevated stays red rather than skipping in silence.
// A value not in this table runs nothing.
export const HOST_LACKS_VARIABLE = 'CLUED_CI_HOST_LACKS';
export const HOST_CAPABILITIES = {
  'non-elevated': 'the job process is not an elevated administrator (GitHub-hosted Windows runners run elevated)',
};
export function hostLacks(env = process.env) {
  const value = String(env[HOST_LACKS_VARIABLE] ?? '');
  const lacks = [...new Set(value.split(/[\s,]+/).filter(Boolean))].sort();
  const unknown = lacks.filter((name) => !Object.hasOwn(HOST_CAPABILITIES, name));
  if (unknown.length > 0) {
    return { lacks: [], error: `${HOST_LACKS_VARIABLE}=${value}: unknown capability ${unknown.join(', ')}; known: ${Object.keys(HOST_CAPABILITIES).join(', ')}; nothing runs` };
  }
  return { lacks, error: null };
}
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const hostLacksSwitches = (lacks) => (lacks.length === 0 ? []
  : [`--test-skip-pattern=\\[needs:(?:${lacks.map(escapeRegExp).join('|')})\\]`]);
export const hostLacksNote = (lacks) => `本机缺 ${lacks.join('、')}（${HOST_LACKS_VARIABLE}），带 ${lacks.map((name) => `[needs:${name}]`).join('、')} 的用例不在此运行`;

// A failed command run again in full (Task 11092b8b; FABLE-flaky-fingerprint-20261122 §7.3). When a node --test command
// fails only because of one to RERUN_MAX_FAILURES tests (a known-failure command: tests off its list) in at most
// RERUN_MAX_FILES files the change did not touch, and that run took at most RERUN_MAX_ELAPSED_MS, the same command runs once
// more, whole and with the same arguments, with an empty temporary directory of its own (TEMP, TMP, TMPDIR) and a timeout
// of twice the first run (at least RERUN_MIN_TIMEOUT_MS). The command passes when that run finishes with a summary, passes
// as the command does (exit 0; a known-failure command: knownFailureVerdict) and passes, not skips, every test that failed,
// with one flaky warning per test. Anything else keeps the failure: a runner that crashed, was killed or timed out (exit
// other than 1, no summary in the report), a missing dependency, a test file that differs from the base commit's
// (CI_BASE_SHA) or that git cannot read, a run too long, any error on the way. It starts only after a command failed, so it
// never fails a command that passed; --run-files never does it. It is the job's own run again: a failure the command's
// context makes every time (another file of the same run) fails again; what this lets through is a failure one full run has
// and the next has not.
export const RERUN_MAX_FAILURES = 3;
export const RERUN_MAX_FILES = 2;
export const RERUN_MAX_ELAPSED_MS = 10 * 60_000;
export const RERUN_MIN_TIMEOUT_MS = 2 * 60_000;
const isNodeTest = (argv) => argv[0] === 'node' && argv.includes('--test');

// One limit at the entry (FABLE-flaky-four-replan-20261124 §2; PLAN-ci-p90-next-20261125 补充裁定, task 3435f8bf): a test or
// command that hangs fails with its name, not at the job's limit (90 minutes hosted, 45 on a node's Windows job, 30 for
// migration-verify) with none. executeSuite starts the first run of every command (node --test, the run-tests wrapper, any
// other) with COMMAND_TIMEOUT_MS and ends it with SIGKILL: Windows ends a process outright anyway, and on POSIX a SIGTERM would
// let Node cancel gracefully and end what had begun, so the two would differ. The command line stays as it is. Node times
// each test (--test-timeout) but never a test file (its FileTest has no timeout), so the limit is the whole command's and,
// for a node --test command with the trusted reporter, the entry then names each file and test that began and did not end:
// the reporter writes Node's test:dequeue and test:complete, which reach it as they happen (not in report order), and the
// parent sends both for each file itself, so a file that hangs is named even when its process sent nothing
// (unfinishedTests). 25 minutes: 1.5 times the longest step of a passing job (987 s), above the one command of the 11-23
// slow window (1287 s), and still named before migration-verify's 30 minutes for a command that starts early in the job. It
// catches a hang; it is not a speed gate.
export const COMMAND_TIMEOUT_MS = 25 * 60_000;
const UNFINISHED_SHOWN = 20;
const limitText = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${ms / 1000} 秒`);
// The files and tests a report (the trusted reporter's lines) began and did not end, in the order each first appears: per
// (file, nesting, name), more begin lines than end lines. A line cut off by the kill ends the reading (readReport).
export function unfinishedTests(text, root) {
  const open = new Map();
  for (const event of readReport(text, root).events) {
    if (event.type !== 'begin' && event.type !== 'end') continue;
    const at = { file: event.file ?? null, nesting: event.nesting ?? null, name: event.name ?? null };
    const key = JSON.stringify([at.file, at.nesting, at.name]);
    const entry = open.get(key) ?? { at, count: 0 };
    entry.count += event.type === 'begin' ? 1 : -1;
    open.set(key, entry);
  }
  return [...open.values()].filter((entry) => entry.count > 0).map((entry) => entry.at);
}
function withReporter(argv, out) {
  const index = argv.indexOf('--test');
  // The reporter comes from this file's (trusted base) checkout.
  return [...argv.slice(0, index + 1), '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${pathToFileURL(REPORTER_PATH).href}`, `--test-reporter-destination=${out}`, ...argv.slice(index + 1)];
}
const testAt = (entry) => `${entry.file} :: ${entry.path.join(' > ')}`;

// Whether CI_BASE_SHA names a commit (Task 11092b8b; PLAN-mainpush-flaky-rerun-20261124 §2): null, or why not. The one
// judgement of the base's form, read by the run again in full (unchangedSinceBase) and by a CI job's --run and
// --run-selected (ciBaseRefusal).
export function baseCommitProblem(base) {
  return typeof base !== 'string' || !/^[0-9a-f]{7,64}$/i.test(base) || /^0+$/.test(base) ? 'CI_BASE_SHA is not a commit' : null;
}

// In a CI job (GITHUB_ACTIONS) the base is an input of the suites, resolved once by the job's train-base step, which writes
// CI_BASE_SHA to GITHUB_ENV for every later step (ci-base.mjs). A step without it is wired wrong, every time (no train-base
// before it, or the step overrides the value): --run and --run-selected start nothing and fail there, so the change that
// breaks it fails in its own pull request (before, the run again in full gave up with one log line and some suites failed
// only when they reached {base}). A local run is not judged here.
export function ciBaseRefusal(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return null;
  const problem = baseCommitProblem(env.CI_BASE_SHA);
  if (!problem) return null;
  return `${problem} (${env.CI_BASE_SHA === undefined ? 'not set' : JSON.stringify(env.CI_BASE_SHA)}): this step does not get `
    + "the base its job's train-base step writes to GITHUB_ENV (no train-base step before it in this job, or the step sets CI_BASE_SHA itself and overrides it); nothing ran";
}

// Each file as the base commit has it: its blob there equals the checkout's file as git would store it. Local reads only.
function unchangedSinceBase(root, base, files, env) {
  const problem = baseCommitProblem(base);
  if (problem) return problem;
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
    return result.status === 0 && !result.error ? result.stdout.trim() : null;
  };
  for (const file of files) {
    const before = git('rev-parse', '--verify', '--quiet', `${base}:${file}`);
    if (!before) return `${file} is not in the base commit ${base} (or git cannot read it)`;
    if (git('hash-object', '--', file) !== before) return `${file} differs from the base commit ${base}`;
  }
  return null;
}

// Why a failed command cannot run again, or null.
function rerunRefusal({ status, signal, report, failures, elapsed, maxElapsed, root, base, env }) {
  if (signal || status !== 1) return `the test runner exited ${status ?? signal}`;
  if (report.corrupt || !report.summary) return 'the test report has no summary of the run';
  if (failures.length === 0) return 'no failing test in the report';
  if (failures.length > RERUN_MAX_FAILURES) return `${failures.length} failing tests (more than ${RERUN_MAX_FAILURES})`;
  if (failures.some((event) => typeof event.file !== 'string' || !event.file || !Array.isArray(event.path))) return 'a failure names no test file';
  if (failures.some((event) => event.missing_dependency)) return 'a module cannot be loaded';
  const files = [...new Set(failures.map((event) => event.file))];
  if (files.length > RERUN_MAX_FILES) return `failures in ${files.length} test files (more than ${RERUN_MAX_FILES})`;
  if (!(elapsed <= maxElapsed)) return `the run took ${Math.round(elapsed)} ms (more than ${maxElapsed} ms)`;
  return unchangedSinceBase(root, base, files, env);
}

// Runs the failed command once more, whole; true when that run passes as the command does and passes every test that
// failed. Logs why not otherwise.
function passesAgain(id, { command, argv, failures, report, status, signal, elapsed, root, cwd, env, spawn, platform, list, log,
  readReportFile, maxElapsed, minTimeout }) {
  const refusal = rerunRefusal({ status, signal, report, failures, elapsed, maxElapsed, root, base: env.CI_BASE_SHA, env });
  if (refusal) {
    log(`${id}: not run again in full: ${refusal}`);
    return false;
  }
  const timeout = Math.max(2 * Math.ceil(elapsed), minTimeout);
  const clock = clockRun(id, root, env);
  const dir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-again-`));
  let text = '';
  let result;
  try {
    // What the first run left in its temporary directory is not there for this one.
    const temp = path.join(dir, 'tmp');
    mkdirSync(temp);
    const kept = Object.entries(testEnv(env)).filter(([name]) => !/^(TEMP|TMP|TMPDIR)$/i.test(name));
    log(`::group::${id}: run again in full (timeout ${Math.ceil(timeout / 1000)} s): (${command.cwd}) ${argv.join(' ')}`);
    const run = resolveCommand(withReporter(argv, path.join(dir, 'failures.jsonl')), { platform });
    result = spawn(run[0], run.slice(1), { cwd, env: { ...Object.fromEntries(kept), TEMP: temp, TMP: temp, TMPDIR: temp, ...clock.env },
      stdio: 'inherit', timeout });
    log('::endgroup::');
    text = readReportFile(path.join(dir, 'failures.jsonl'));
  } finally {
    // Removing it never decides the command (a process the run left may still hold a file there).
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log(`${id}: could not remove ${dir}: ${error?.message ?? error}`);
    }
  }
  const again = readReport(text, root);
  const failed = again.events.filter((event) => event.type === 'fail');
  const problems = new Set();
  const clockUses = clock.refused(log);
  if (clockUses > 0) problems.add(`${clockUses} real-clock use${clockUses === 1 ? '' : 's'} in test code`);
  if (result.error) problems.add(result.error.message);
  if (again.corrupt || !again.summary) problems.add('the test report has no summary of the run');
  if (command.known) {
    const verdict = knownFailureVerdict({ status: result.signal ? 128 : result.status, report: again, known: list });
    for (const problem of verdict.problems) problems.add(problem);
    for (const event of verdict.unexpected) problems.add(`${testAt(event)} failed`);
  } else if (result.status !== 0) {
    problems.add(`the test runner exited ${result.status ?? result.signal}`);
    for (const event of failed) problems.add(`${testAt(event)} failed`);
  }
  // A skipped test did not pass: it did not run.
  const passed = new Set(again.events.filter((event) => event.type === 'pass' && !event.skip).map(testAt));
  const failedAt = new Set(failed.map(testAt));
  const notPassed = failures.filter((event) => failedAt.has(testAt(event)) || !passed.has(testAt(event)));
  if (notPassed.length > 0) problems.add(`${notPassed.map(testAt).join('; ')} did not pass`);
  if (problems.size > 0) {
    log(`${id}: run again in full, still failing (整条再跑仍失败): ${[...problems].join('; ')}`);
    return false;
  }
  return true;
}

function reportFlaky(id, failures, { env, log }) {
  for (const event of failures) log(`::warning title=${id} flaky::${testAt(event)} fingerprint=${event.fingerprint}`);
  log(`${id}: ${failures.length} test(s) failed once and passed when the command ran again in full (flaky): the command passes`);
  try {
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, failures.map((event) => `- \`${id}\` flaky: ${testAt(event)} (fingerprint ${event.fingerprint})\n`).join(''));
    }
  } catch { /* the annotations above are the record */ }
}

// The real-clock guard (test-clock-guard.mjs; Task 11092b8b, FABLE-no-real-clock-20261122 §2.1, §2.2): every command of a
// suite runs with it preloaded (NODE_OPTIONS, so every node the command starts has it too), the checkout and a record of
// its own. Once the command has ended, a use the record has outside the debt list fails it, whatever its exit code (a test
// may swallow the error the guard throws). The guard is this file's neighbour: the entry's own checkout's, never the change's.
// A record the entry cannot read fails the command: the verdict is not guessed.
function clockRun(id, root, env) {
  const record = path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-clock-${randomUUID()}.jsonl`);
  return {
    env: clockGuardEnv({ root, record }),
    refused(log) {
      let text = '';
      try {
        if (existsSync(record)) text = readFileSync(record, 'utf8');
      } catch (error) {
        log(`::error title=${id} real clock::the guard's record ${record} cannot be read: ${error?.message ?? error}`);
        return 1;
      }
      try {
        rmSync(record, { force: true });
      } catch { /* a record left behind decides nothing */ }
      const { refused, lines } = recordVerdict(text, { suite: id });
      if (lines.length > 0) log(`::error title=${id} real clock::${lines[0]}`);
      for (const line of lines) log(line);
      return refused.length;
    },
  };
}

// The CI process or the already guarded worker executes the suite here.
export function executeSuite(id, { root, env = process.env, spawn = spawnSync, log = console.log, platform = process.platform,
  captureKnown = false, keep = false, files = null, known = null, readReportFile = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : ''),
  rerunMaxElapsedMs = RERUN_MAX_ELAPSED_MS, rerunMinTimeoutMs = RERUN_MIN_TIMEOUT_MS, shard = null, shardSecondsFile = SHARD_SECONDS_PATH,
  commandTimeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const host = hostLacks(env);
  if (host.error) {
    log(`::error title=${id}::${host.error}`);
    return 2;
  }
  if (shard && (files || captureKnown)) throw new Error('--shard splits a suite run, not --run-files or --write-known');
  if (captureKnown) return writeKnown(id, root, env, keep);
  // A suite whose trusted commands compare with the base stops here without one, before its first command, rather than
  // after every command ahead of the one that takes it (task 700f2b68). --run-files plans {base} commands out (planFiles).
  if (!files && missingBase(env.CI_BASE_SHA) && (SUITE_COMMANDS[id] ?? []).some((command) => command.argv.includes('{base}'))) {
    log(`::error title=${id}::${BASE_REQUIRED}; no command started. A CI job sets it in the step that runs the suite; locally: CI_BASE_SHA=$(git merge-base HEAD origin/main)`);
    return 2;
  }
  // The global number of this suite's next unit (parseShard).
  let position = shard ? shardOffset(id) : 0;
  // The seconds the shard packs files by, read only here; the first line names the table (entries, a digest of them) so
  // the shards' logs show they all read the same one.
  let seconds = null;
  if (shard) {
    const { table, problem } = readShardSeconds(shardSecondsFile);
    seconds = table;
    if (problem) log(`::notice title=${id} shard seconds::${problem}`);
    const digest = createHash('sha256').update(JSON.stringify([...table])).digest('hex').slice(0, 12);
    log(`${id}: ${shard.lane ? '道' : 'shard'} ${shard.index}/${shard.total}, units numbered from ${position}; 按秒数分片，表 ${table.size} 条（${digest}）`);
  }
  const skipSwitches = hostLacksSwitches(host.lacks);
  // A lane's node --test runs at most its share of the cores (laneTestConcurrency), so n lanes do not each start one
  // process per core; a command that sets its own concurrency keeps it.
  const laneSwitches = shard?.lane && Number.isSafeInteger(shard.concurrency) ? [`--test-concurrency=${shard.concurrency}`] : [];
  if (skipSwitches.length > 0) log(`${id}: ${hostLacksNote(host.lacks)}`);
  const report = path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-report.json`);
  // The trusted commands, then the candidate's additions (read once the trusted ones have run), or, for a suite only the
  // candidate has, the candidate's commands (requiredCommands throws for a suite neither has).
  let steps = (function* plan() {
    for (const command of requiredCommands(id, root, { env, base: env.CI_BASE_SHA, report })) yield { command, argv: null };
  }());
  let named = null;
  if (files) {
    try {
      ({ steps, named } = planFiles(id, { root, files, env }));
    } catch (error) {
      if (!(error instanceof RunFilesError)) throw error;
      log(`run-files ${id}: ${error.message}`);
      return 2;
    }
  }
  for (const { command, argv: planned } of steps) {
    const cwd = path.join(root, command.cwd);
    const full = planned ?? commandArgv(command, { cwd, root, base: env.CI_BASE_SHA, report, hosted: env.GITHUB_ACTIONS === 'true' });
    let given = full;
    // A known failure counts in this shard when its file is one of the shard's, or one the command no longer lists and the
    // shard has the command's first file (one shard warns that it no longer runs, as without --shard).
    let shardKnown = null;
    let part = null;
    if (shard) {
      part = shardPart(command, full, shard, position, seconds);
      position += part.units;
      if (part.accepts.length > 0) {
        const hits = part.accepts.filter((file) => seconds.has(file)).length;
        log(`${id}: 按秒数分片，表里命中 ${hits} / 本命令 ${part.accepts.length} 个文件`);
      }
      // How much of the suite the shard ran, for runSelected's summary (review M2).
      if (shard.tally) {
        shard.tally.units += part.units;
        if (part.argv) shard.tally.ran += part.files ? part.files.size : 1;
      }
      if (!part.argv) continue;
      given = part.argv;
      if (part.files) {
        const [first] = part.listed;
        shardKnown = (file) => part.files.has(file) || (part.files.has(first) && !part.listed.has(file));
      }
    }
    // What this host lacks is part of the command itself: the first run and the run again in full (passesAgain) both skip it.
    const switches = given[0] === 'node' && given[1] === '--test'
      ? [...skipSwitches, ...(given.some((arg) => arg.startsWith('--test-concurrency')) ? [] : laneSwitches)] : [];
    const plain = switches.length > 0 ? [given[0], given[1], ...switches, ...given.slice(2)] : given;
    let argv = plain;
    let reportDir = null;
    // A known-failure command reports to the trusted reporter for its verdict; any other node --test command of the trusted
    // list for the run again in full (passesAgain), which a missing reporter or report directory only rules out. A command the
    // candidate adds gets none: what it adds carries no policy. The log shows such a command as it is, without the reporter.
    if (command.known) reportDir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-tests-`));
    else if (!files && !command.expanded && isNodeTest(plain) && existsSync(REPORTER_PATH)) {
      try {
        reportDir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-tests-`));
      } catch { /* runs without a report */ }
    }
    if (reportDir) argv = withReporter(plain, path.join(reportDir, 'failures.jsonl'));
    // Removing that report never decides a command (a known-failure command removes its own as before).
    const dropReport = () => {
      try {
        if (reportDir && !command.known) rmSync(reportDir, { recursive: true, force: true });
      } catch { /* a temporary directory left behind */ }
    };
    const shown = command.known ? argv : plain;
    log(`::group::${id}: (${command.cwd}) ${shown.join(' ')}`);
    const run = resolveCommand(argv, { platform });
    const clock = clockRun(id, root, env);
    const started = performance.now();
    const result = spawn(run[0], run.slice(1), { cwd, env: { ...testEnv(env), ...clock.env }, stdio: command.quiet ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      timeout: commandTimeoutMs, killSignal: 'SIGKILL' });
    const elapsed = performance.now() - started;
    if (command.quiet && result.stdout) {
      // The runner budget report is long; print its head on success, all of it on failure.
      const text = result.stdout.toString();
      log(result.status === 0 ? `${text.split('\n').slice(0, 4).join('\n')}\n...` : text);
    }
    log('::endgroup::');
    // What each of the shard's files took on this first run, for --write-shard-seconds; never part of the verdict.
    if (part?.files && reportDir && !result.error) {
      try {
        const timed = shardSecondsOf(readReport(readReportFile(path.join(reportDir, 'failures.jsonl')), root), part.files);
        log(`${id}: shard-seconds ${JSON.stringify(timed)}`);
      } catch { /* no seconds this run */ }
    }
    // At the limit (COMMAND_TIMEOUT_MS) the command fails, a known-failure command too (no verdict), with what never ended.
    if (result.error?.code === 'ETIMEDOUT') {
      log(`::error::${id}: ${shown.join(' ')} 超过 ${limitText(commandTimeoutMs)}被终止`);
      if (reportDir) {
        let open = [];
        try {
          open = unfinishedTests(readReportFile(path.join(reportDir, 'failures.jsonl')), root);
        } catch (error) {
          log(`${id}: the test report cannot be read (${error?.message ?? error})`);
        }
        for (const entry of open.slice(0, UNFINISHED_SHOWN)) log(`::error title=${id} 开始了没结束::${entry.file ?? '<run>'} :: ${entry.name}`);
        if (open.length > UNFINISHED_SHOWN) log(`${id}: 另有 ${open.length - UNFINISHED_SHOWN} 条开始了没结束`);
        try {
          rmSync(reportDir, { recursive: true, force: true });
        } catch { /* a temporary directory left behind */ }
      } else {
        log(`${id}: 本命令无受信报告，列不出用例`);
      }
      return 1;
    }
    if (result.error) {
      dropReport();
      clock.refused(() => {});
      log(`${id}: ${shown[0]} did not start: ${result.error.message}`);
      return 1;
    }
    // A real-clock use in test code fails the command as it is: running it again would only hide it.
    if (clock.refused(log) > 0) {
      try {
        if (reportDir) rmSync(reportDir, { recursive: true, force: true });
      } catch { /* a temporary directory left behind */ }
      log(`${id}: ${shown.join(' ')} used the real clock in test code (exit ${result.status ?? result.signal})`);
      return result.status || 1;
    }
    // Every error on the way to running again keeps the failure (FABLE-flaky-no-new-commit-20261122 §2.5).
    const again = (failures, { report: ran, status, list = [] }) => {
      if (files) return false;
      try {
        return passesAgain(id, { command, argv: plain, failures, report: ran, status, signal: result.signal, elapsed, root, cwd, env,
          spawn, platform, list, log, readReportFile, maxElapsed: rerunMaxElapsedMs, minTimeout: rerunMinTimeoutMs });
      } catch (error) {
        log(`${id}: not run again in full: ${error?.message ?? error}`);
        return false;
      }
    };
    if (command.known) {
      const list = ((known ?? readKnownFailures())[command.known] ?? [])
        .filter((entry) => (!named || named.has(entry.file)) && (!shardKnown || shardKnown(entry.file)));
      const text = readReportFile(path.join(reportDir, 'failures.jsonl'));
      rmSync(reportDir, { recursive: true, force: true });
      const status = result.signal ? 128 : result.status;
      const ran = readReport(text, root);
      const verdict = knownFailureVerdict({ status, report: ran, known: list });
      const label = (entry) => `${entry.file} :: ${entry.path.join(' > ')}`;
      for (const entry of verdict.expected) log(`::warning title=${id} known failure::${label(entry)}`);
      for (const entry of verdict.fixed) log(`::warning title=${id} known failure now passes::${label(entry)}; remove it from ci-known-failures.json`);
      for (const entry of verdict.missing) log(`::warning title=${id} known failure no longer runs::${label(entry)}; remove it from ci-known-failures.json`);
      if (!verdict.ok && verdict.problems.length === 0
          && again(verdict.unexpected, { report: ran, status, list })) {
        reportFlaky(id, verdict.unexpected, { env, log });
        continue;
      }
      for (const entry of verdict.unexpected) {
        log(`::error title=${id} new failure::${label(entry)} (${entry.failure_type ?? 'failure'}, fingerprint ${entry.fingerprint})`);
      }
      for (const problem of verdict.problems) log(`::error title=${id}::${problem}`);
      if (!verdict.ok) {
        log(`${id}: ${verdict.unexpected.length} failure(s) not on the known-failure list${verdict.problems.length ? `; ${verdict.problems.join('; ')}` : ''}`);
        return status || 1;
      }
      continue;
    }
    if (result.status !== 0) {
      log(`${id}: ${shown.join(' ')} exited ${result.status ?? result.signal}`);
      if (reportDir) {
        let ran = null;
        try {
          ran = readReport(readReportFile(path.join(reportDir, 'failures.jsonl')), root);
        } catch (error) {
          log(`${id}: not run again in full: the test report cannot be read (${error?.message ?? error})`);
        }
        dropReport();
        const failures = ran ? ran.events.filter((event) => event.type === 'fail') : [];
        if (ran && again(failures, { report: ran, status: result.status })) {
          reportFlaky(id, failures, { env, log });
          continue;
        }
      }
      return result.status || 1;
    }
    dropReport();
  }
  return 0;
}

// Lanes (FABLE-ci-duration-node-side-20261124, 做法 2): a CI job without --shard runs the n parts --shard i/n would make of
// its plan at once, each part in a process of its own (runLanePart), each lane its suites in order. The parts are --shard's
// (shardPart, ci-shard-seconds.json): together they run every unit once, a file in one lane only. n is read from the
// machine, max(1, min(LANES_MAX, floor(cores / 4))): a 4-core hosted machine gets 1, today's serial run command for
// command. CI_SELECTED_LANES lowers it, never raises it; a value that is not a whole number from 1 runs serially (an aid
// that fails only does nothing). Outside a CI job (the local suite slots hold one suite at a time) and with --shard: 1.
// Stop-loss: a timing failure lanes bring lowers LANES_MAX, then CI_SELECTED_LANES=1 (the design's 止损).
export const LANES_MAX = 3;
export const LANES_VARIABLE = 'CI_SELECTED_LANES';
export function laneCount({ cores = os.availableParallelism(), env = process.env, shard = null } = {}) {
  if (shard || env.GITHUB_ACTIONS !== 'true') return 1;
  const ceiling = Math.max(1, Math.min(LANES_MAX, Math.floor(cores / 4)));
  const asked = env[LANES_VARIABLE];
  if (asked === undefined || asked === '') return ceiling;
  return /^[1-9]\d*$/.test(String(asked).trim()) ? Math.min(ceiling, Number(String(asked).trim())) : 1;
}
export const laneTestConcurrency = (cores, lanes) => Math.max(2, Math.floor((cores - 1) / lanes));

// One lane's part of one suite, in a child process: runSuite with --shard's part i/n, so its commands, known failures and
// run again in full are --shard's. Its output (the suite's commands inherit it) is held and handed back whole; the result
// comes back in a file, never parsed out of that output. A process a test leaves behind may hold the output pipe open (it
// inherited it): the part ends LANE_DRAIN_MS after its process exits, with the output read by then, and says so in a
// notice line (what that process writes later is not in the log; review M2).
export const LANE_DRAIN_MS = 5_000;
const LANE_PART = `const [url, id, root, index, total, concurrency, out] = process.argv.slice(1);
const { writeFileSync } = await import('node:fs');
const { runSuite } = await import(url);
const tally = { units: 0, ran: 0 };
let status = 1;
try {
  status = await runSuite(id, { root, shard: { index: Number(index), total: Number(total), tally, lane: true, concurrency: Number(concurrency) } });
} catch (error) {
  console.log('::error title=' + id + '::' + error.message);
}
writeFileSync(out, JSON.stringify({ status, tally }));`;
export function runLanePart(id, { root, env = process.env, lane, drainMs = LANE_DRAIN_MS }) {
  const dir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-lane-`));
  const out = path.join(dir, 'result.json');
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawnAsync(process.execPath, ['--input-type=module', '-e', LANE_PART, import.meta.url, id, root,
      String(lane.index), String(lane.total), String(lane.concurrency), out], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    let done = false;
    let drain = null;
    const finish = (problem, drained = false) => {
      if (done) return;
      done = true;
      clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
      let result = null;
      try {
        result = JSON.parse(readFileSync(out, 'utf8'));
      } catch { /* the part did not finish: it failed */ }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* a temporary directory left behind */ }
      const ok = result && Number.isInteger(result.status);
      const output = Buffer.concat(chunks).toString('utf8')
        + (drained ? `::notice title=${id}::道 ${lane.index}/${lane.total}：子进程已退出，留下的进程仍占输出管道，${drainMs} 毫秒后收尾，之后的输出未收\n` : '')
        + (ok ? '' : `::error title=${id}::lane ${lane.index}/${lane.total} ended without a result (${problem})\n`);
      resolve({ status: ok ? result.status : 1, output, tally: ok ? result.tally : null });
    };
    child.on('error', (error) => finish(error.message));
    child.on('exit', (code, signal) => {
      drain = setTimeout(() => finish(`exit ${code ?? signal}; its output pipe still open after ${drainMs} ms`, true), drainMs);
    });
    child.on('close', (code, signal) => finish(`exit ${code ?? signal}`));
  });
}

// One job step for a platform: every selected suite runs, in order, even after
// one fails (so the summary names each); any failure fails the step, and with
// it the check. Nothing selected is a pass: the change touches no suite of
// this platform.
export async function runSelected(suites, { root, env = process.env, run = runSuite, log = console.log, summary = () => {}, shard = null,
  cores = os.availableParallelism(), runPart = runLanePart } = {}) {
  const host = hostLacks(env);
  if (host.error) {
    log(`::error title=${HOST_LACKS_VARIABLE}::${host.error}`);
    summary(`- **${host.error}**\n`);
    return 2;
  }
  if (host.lacks.length > 0) {
    log(hostLacksNote(host.lacks));
    summary(`- ${hostLacksNote(host.lacks)}\n`);
  }
  const failed = [];
  const lanes = laneCount({ cores, env, shard });
  if (lanes > 1 && suites.length > 0) {
    const concurrency = laneTestConcurrency(cores, lanes);
    log(`${suites.length} 个套件分 ${lanes} 道并行（本机 ${cores} 核，每道 node --test 并发 ${concurrency}；${LANES_VARIABLE} 可压低），道内依次跑`);
    const parts = new Map(suites.map((id) => [id, []]));
    const started = performance.now();
    await Promise.all(Array.from({ length: lanes }, async (unused, at) => {
      const lane = { index: at + 1, total: lanes, concurrency };
      for (const id of suites) {
        // A line as the part starts: a job cancelled at its time limit drops the parts still held, and the suites that
        // started and never ended name where it stopped (review M1).
        log(`${id}: 道 ${lane.index}/${lanes} 开始`);
        const begun = performance.now();
        let part;
        try {
          part = await runPart(id, { root, env, lane });
        } catch (error) {
          part = { status: 1, output: `::error title=${id}::${error.message}\n`, tally: null };
        }
        const took = ((performance.now() - begun) / 1000).toFixed(1);
        // Printed whole when it ends: one block per suite and lane, never interleaved with another lane's.
        log(`${id}: 道 ${lane.index}/${lanes} 用时 ${took} 秒，${part.status === 0 ? 'passed' : `failed (${part.status})`}\n${String(part.output ?? '').trimEnd()}`);
        parts.get(id).push(part);
      }
    }));
    for (const id of suites) {
      const status = parts.get(id).find((part) => part.status !== 0)?.status ?? 0;
      summary(`- \`${id}\`: ${status === 0 ? 'passed' : '**failed**'}\n`);
      if (status !== 0) failed.push(id);
    }
    log(`${lanes} 道全部结束，墙钟 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
    if (failed.length > 0) log(`::error title=${hostPlatform()} suites::failed: ${failed.join(' ')}`);
    return failed.length > 0 ? 1 : 0;
  }
  let timedOut = false;
  if (shard) summary(`- shard ${shard.index}/${shard.total}\n`);
  for (const id of suites) {
    let status = 1;
    const tally = { units: 0, ran: 0 };
    try {
      status = await run(id, shard ? { root, env, log, shard: { index: shard.index, total: shard.total, tally } } : { root, env, log });
    } catch (error) {
      // e.g. a candidate selector whose command list cannot be read: this suite fails, the next ones still run
      log(`::error title=${id}::${error.message}`);
    }
    if (env.GITHUB_ACTIONS !== 'true' && status === LOCAL_TIMEOUT_EXIT) timedOut = true;
    if (shard) {
      // A suite this shard ran no unit of did not pass here: it did not run here (review M2).
      const part = `${tally.ran} of ${tally.units} unit${tally.units === 1 ? '' : 's'}`;
      const outcome = status !== 0 ? `**failed** (${part} counted in this shard)`
        : tally.ran === 0 ? `not run in this shard (${part}; 本片未分到)` : `passed (${part} in this shard)`;
      log(`${id}: shard ${shard.index}/${shard.total}: ${outcome.replaceAll('**', '')}`);
      summary(`- \`${id}\`: ${outcome}\n`);
    } else {
      summary(`- \`${id}\`: ${status === 0 ? 'passed' : '**failed**'}\n`);
    }
    if (status !== 0) failed.push(id);
  }
  if (failed.length > 0) log(`::error title=${hostPlatform()} suites::failed: ${failed.join(' ')}`);
  if (timedOut) return LOCAL_TIMEOUT_EXIT;
  return failed.length > 0 ? 1 : 0;
}

const ROOT = path.resolve(HERE, '..', '..');

// The known-failure entries of one run: every failure in the report, keeping
// the reason of an entry already listed for the same file and path. A new
// entry gets no reason, so readKnownFailures refuses the list until a person
// writes one.
// A reason carries over only to the same failure (same fingerprint): a known
// test now failing for another reason needs its reason written again. With
// keep, the previous entries stay as well, so a pull request can list the
// failure a coming change will produce (a count or list a test pins) before
// that change lands; the known-failure list is read from the trusted base.
export function knownEntriesFromReport(report, previous = [], { keep = false } = {}) {
  const reasons = new Map(previous.map((entry) => [knownKey(entry), entry.reason]));
  const entries = new Map(keep ? previous.map((entry) => [knownKey(entry), entry]) : []);
  for (const event of report.events.filter((candidate) => candidate.type === 'fail')) {
    const entry = { file: event.file, path: event.path, fingerprint: event.fingerprint, reason: reasons.get(knownKey(event)) ?? '' };
    entries.set(knownKey(entry), entry);
  }
  return [...entries.values()].sort((a, b) => knownKey(a).localeCompare(knownKey(b)));
}

// --write-known <suite>: run that suite's known-failure command in the checkout
// and rewrite its entries in ci-known-failures.json from the run.
function writeKnown(id, root, env, keep = false) {
  const command = SUITE_COMMANDS[id]?.find((candidate) => candidate.known);
  if (!command) throw new Error(`suite ${id} has no known-failure command`);
  const cwd = path.join(root, command.cwd);
  const argv = expandArgv(command.argv, { cwd, root, base: env.CI_BASE_SHA, report: '' });
  const dir = mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), `${id}-known-`));
  const out = path.join(dir, 'failures.jsonl');
  const index = argv.indexOf('--test');
  spawnSync(argv[0], [...argv.slice(1, index + 1), `--test-reporter=${pathToFileURL(REPORTER_PATH).href}`,
    `--test-reporter-destination=${out}`, ...argv.slice(index + 1)], { cwd, env: testEnv(env), stdio: ['ignore', 'ignore', 'inherit'] });
  const report = readReport(existsSync(out) ? readFileSync(out, 'utf8') : '', root);
  rmSync(dir, { recursive: true, force: true });
  if (!report.summary) throw new Error('the run did not finish; nothing written');
  const data = JSON.parse(readFileSync(KNOWN_FAILURES_PATH, 'utf8'));
  data[command.known] = knownEntriesFromReport(report, data[command.known] ?? [], { keep });
  writeFileSync(KNOWN_FAILURES_PATH, `${JSON.stringify(data, null, 2)}\n`);
  const unexplained = data[command.known].filter((entry) => !entry.reason).length;
  console.log(`${command.known}: ${data[command.known].length} entries written${unexplained ? `, ${unexplained} need a reason` : ''}`);
  return unexplained ? 1 : 0;
}

// --write-shard-seconds <log>...: rewrite ci-shard-seconds.json, the whole of it, from the shard-seconds lines of --shard job
// logs (executeSuite): each file's median over its samples, rounded to whole seconds, files under 3 seconds left out, keys
// sorted. The only way the table is written. A log it cannot read, or no shard-seconds line at all, writes nothing.
export function writeShardSeconds(logs, { file = SHARD_SECONDS_PATH, log = console.log } = {}) {
  const samples = new Map();
  if (logs.length === 0) {
    log('write-shard-seconds: no log named; nothing written');
    return 2;
  }
  for (const name of logs) {
    let text;
    try {
      text = readFileSync(name, 'utf8');
    } catch (error) {
      log(`write-shard-seconds: ${name} cannot be read (${error?.code ?? error?.message ?? error}); nothing written`);
      return 1;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /: shard-seconds (\{.*\})\s*$/.exec(line);
      if (!match) continue;
      let data;
      try {
        data = JSON.parse(match[1]);
      } catch {
        continue;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      for (const [key, value] of Object.entries(data)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
        samples.set(key, [...(samples.get(key) ?? []), value]);
      }
    }
  }
  if (samples.size === 0) {
    log('write-shard-seconds: no shard-seconds line in the logs; nothing written');
    return 1;
  }
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const table = {};
  for (const key of [...samples.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const seconds = median(samples.get(key));
    if (seconds >= 3) table[key] = Math.round(seconds);
  }
  writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`);
  log(`write-shard-seconds: ${Object.keys(table).length} files written to ${path.basename(file)} (of ${samples.size} timed)`);
  return 0;
}

const USAGE = 'usage: node scripts/ci/ci-required-selection.mjs --check <ci-suites|clued-cloud-tests|migration-verify> [--root <checkout>] | --run-selected <check> [--root <checkout>] [--shard <i>/<n>] | --run <suite> [--root <checkout>] | --run-files <suite> <file> [<file>...] [--root <checkout>] | --run-prepush --root <tree> | --write-shard-seconds <log> [<log>...]';
export const LOCAL_TIMEOUT_EXIT = 75;

async function main(argv, env = process.env) {
  try {
    markTestRun(argv, env);
  } catch (error) {
    console.error(`test identity: cannot make the run's directory, nothing started: ${error.message}`);
    return TEST_IDENTITY_EXIT;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    console.log(`Exit codes: 1 for a suite failure; ${LOCAL_TIMEOUT_EXIT} for a local suite slot timeout (waiting or holding).`);
    console.log('--run-files runs only the named test files (repository paths) with the suite command CI runs, takes a local slot, and is refused under GITHUB_ACTIONS (exit 2): its result is not a suite verdict.');
    return 0;
  }
  const secondsIndex = argv.indexOf('--write-shard-seconds');
  if (secondsIndex >= 0) {
    const logs = argv.slice(secondsIndex + 1);
    if (logs.length === 0 || logs.some((arg) => arg.startsWith('--'))) {
      console.error(`--write-shard-seconds <log> [<log>...] takes the --shard job logs and nothing else\n${USAGE}`);
      return 2;
    }
    return writeShardSeconds(logs);
  }
  // Written any other way --shard would be ignored and the shard would run the whole plan (review L3).
  if (argv.some((arg) => arg.startsWith('--shard='))) {
    console.error(`--shard takes i/n as its own argument (--shard 2/4)\n${USAGE}`);
    return 2;
  }
  if (argv.filter((arg) => arg === '--shard').length > 1) {
    console.error(`--shard is given once\n${USAGE}`);
    return 2;
  }
  const shardIndex = argv.indexOf('--shard');
  let shard = null;
  if (shardIndex >= 0) {
    try {
      shard = parseShard(argv[shardIndex + 1]);
    } catch (error) {
      console.error(`${error.message}\n${USAGE}`);
      return 2;
    }
    if (!argv.includes('--run-selected')) {
      console.error(`--shard goes with --run-selected only\n${USAGE}`);
      return 2;
    }
    if (env.GITHUB_ACTIONS !== 'true') {
      console.error('--shard runs only in a CI job (GITHUB_ACTIONS=true); run locally with --run or --run-files');
      return 2;
    }
  }
  if (argv.includes('--run-prepush')) {
    const rootIndex = argv.indexOf('--root');
    const tree = rootIndex >= 0 ? argv[rootIndex + 1] : undefined;
    if (!tree || tree.startsWith('--')) {
      console.error(`run-prepush: needs the tree to check: --run-prepush --root <tree>\n${USAGE}`);
      return 2;
    }
    try {
      return runPrepush(path.resolve(tree), { env });
    } catch (error) { // an exception is "did not run" (PREPUSH_ERROR_EXIT), never the red exit 1 the push entry refuses on
      console.error(`run-prepush: did not run: ${error.message}`);
      return PREPUSH_ERROR_EXIT;
    }
  }
  const filesIndex = argv.indexOf('--run-files');
  if (filesIndex >= 0) {
    const rootIndex = argv.indexOf('--root');
    const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : ROOT;
    const id = argv[filesIndex + 1];
    const named = [];
    for (const arg of argv.slice(filesIndex + 2)) {
      if (arg.startsWith('--')) break;
      named.push(arg);
    }
    if (env.GITHUB_ACTIONS === 'true') {
      console.error('run-files: refused under GITHUB_ACTIONS; a targeted run is never a suite verdict, use --run');
      return 2;
    }
    if (!Object.hasOwn(SUITE_COMMANDS, id) && Object.hasOwn(SUITES, id)) {
      console.error(`run-files: ${id} is a required check, not a suite; its suites: ${Object.keys(SUITES[id]).join(', ')}`);
      return 2;
    }
    if (!Object.hasOwn(SUITE_COMMANDS, id) || named.length === 0) {
      console.error(`run-files: needs a known suite and at least one test file\n${USAGE}`);
      return 2;
    }
    const status = await runSuite(id, { root, env, files: named });
    if (status !== 2) console.log(`run-files ${id}: ${named.length} 个文件，退出 ${status} —— 定向结果，不是套件结论`);
    return status;
  }
  const writeIndex = argv.indexOf('--write-known');
  if (writeIndex >= 0) {
    const rootIndex = argv.indexOf('--root');
    return runSuite(argv[writeIndex + 1], {
      root: rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : ROOT, env, captureKnown: true, keep: argv.includes('--keep'),
    });
  }
  const runIndex = argv.indexOf('--run');
  if (runIndex >= 0) {
    const rootIndex = argv.indexOf('--root');
    const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : ROOT;
    const refusal = ciBaseRefusal(env);
    if (refusal) {
      console.log(`::error title=${argv[runIndex + 1]} CI_BASE_SHA::${refusal}`);
      return 2;
    }
    return runSuite(argv[runIndex + 1], { root, env });
  }
  const selectedIndex = argv.indexOf('--run-selected');
  const index = selectedIndex >= 0 ? selectedIndex : argv.indexOf('--check');
  const check = index >= 0 ? argv[index + 1] : undefined;
  if (!SUITES[check]) {
    console.error(USAGE);
    return 2;
  }
  const refusal = selectedIndex >= 0 ? ciBaseRefusal(env) : null;
  if (refusal) {
    console.log(`::error title=${check} CI_BASE_SHA::${refusal}`);
    return 2;
  }
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const behind = await behindMain({ event, env });
  const files = env.GITHUB_EVENT_NAME === 'pull_request' ? await (shard ? shardChangedFiles : changedFiles)({ event, env }) : null;
  const platform = hostPlatform();
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1]) : ROOT;
  // Behind: nothing, the candidate's added suites included; each job takes its not-affected path.
  const { selection, error } = behind !== null
    ? { selection: { suites: [], reason: behindMainReason(event.pull_request.base.ref, behind) }, error: null }
    : selectWithCandidate(check, files, platform, root);
  if (error) console.log(`::error title=${check} candidate suites::${error.message}`);
  console.log(`${check}: ${selection.reason}; suites: ${selection.suites.join(', ') || 'none'}`);
  console.log(`platform: ${platform} (suites declared for another platform only are not selected here)`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${outputLines(check, selection).join('\n')}\n`);
  const summary = (text) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text); };
  summary(`### ${check}\n\n${selection.reason}.\n\nSuites (${platform}): ${selection.suites.map((id) => `\`${id}\``).join(', ') || 'none (not affected)'}\n`);
  if (selectedIndex < 0) return error ? 1 : 0;
  const status = await runSelected(selection.suites, { root, env, summary, ...(shard ? { shard } : {}) });
  return status !== 0 ? status : error ? 1 : 0;
}

// The entry runs main without a top-level await (task 0d2fb345). A module main loads that imports this one (check-tests-
// covered.mjs, for a refused file) waits for this module to finish evaluating; under a top-level await of main that never
// came, and Node ended the process with exit 13 and nothing said. A run that still never settles leaves the event loop
// empty: that is said, with exit 1.
export function runEntry(run) {
  let settled = false;
  process.once('beforeExit', () => {
    if (settled) return;
    console.error('ci-required-selection: ended before the run finished: a step it awaited never settled (nothing was left to settle it)');
    process.exitCode = 1;
  });
  return Promise.resolve().then(run).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`ci-required-selection: ${error.message}`);
    process.exitCode = 1;
  }).finally(() => { settled = true; });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runEntry(() => main(process.argv.slice(2)));
}
