import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { freshConfig, portCandidates, verifyPreparedConfiguration } from './clued-g4-fresh-start.mjs';

const SHA = /^[a-f0-9]{40}$/;
const MAX_BYTES = 64 * 1024;
export const REPORT_NAME = 'clued-tested-tree.json';
// Workflows whose main push may reuse the merged PR head's passing run of the same tree.
// proof 'tree-report': the workflow's own push-reuse job reads the tested-tree artifact the PR run uploaded.
// proof 'ancestry': the admission gate decides (clued-work-admission.mjs gate()); main's old tip must be an
// ancestor of the head, so the PR run's test merge had the head's tree, and every listed job (each a required
// check under its job id) plus the gate must have passed exactly once in the head's latest run.
export const TARGETS = Object.freeze({
  'clued-g4-database.yml': {
    proof: 'tree-report',
    job: 'Supabase migration, RLS, transaction, and pgTAP',
    steps: ['Prepare, start and verify one fresh isolated Supabase runtime', 'Run Unified Record V2 RLS and transaction tests', 'Run Project Lifecycle Successor v2 database and surface tests'],
  },
  'information-flow-e2e.yml': {
    proof: 'tree-report',
    job: 'Information Flow E2E over the local Worker and Supabase stack',
    steps: ['Run the Information Flow E2E harness', 'Recompute normalized evidence digests'],
  },
  'clued-required-tests.yml': { proof: 'ancestry', jobs: Object.freeze(['clued-cloud-tests', 'ci-suites', 'migration-verify']) },
  'clued-required-tests-windows.yml': { proof: 'ancestry', jobs: Object.freeze(['ci-suites-windows']) },
});
const GATE_JOB = 'admission-gate';
const artifactName = (file, attempt) => `clued-tested-tree-${file}-${attempt}`;
// Existing repository executor identity, observed on PR #688. This permits
// proof lookup only; it does not move a bot onto the trusted runner route.
const EXECUTOR_LOGIN = 'clued-admission[bot]';
const executorMerged = (actor) => actor?.login === EXECUTOR_LOGIN && actor.id === 337003645 && actor.type === 'Bot';
const fallback = (reason) => ({ run_heavy: true, reason, current_sha_pass: false });
const requireProof = (condition, reason) => { if (!condition) throw new Error(reason); };
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const CONFIG = 'apps/clued-cloud/supabase/config.toml';
const ISOLATED_PROJECTS = { 'clued-g4-database.yml': 'clued-g4', 'information-flow-e2e.yml': 'clued-ife2e' };

export function isolatedConfig(source, workflow, run, attempt, portBase) {
  if (workflow === 'clued-g4-database.yml') return freshConfig(source, {
    GITHUB_RUN_ID: String(run), GITHUB_RUN_ATTEMPT: String(attempt),
    GITHUB_SHA: '0'.repeat(40), GITHUB_REPOSITORY: 'configuration/template',
  }, portBase);
  const prefix = ISOLATED_PROJECTS[workflow];
  requireProof(prefix && Number.isSafeInteger(run) && run > 0 &&
    source.split('project_id = "clued-cloud"').length === 2, 'isolation_project');
  let count = 0;
  const transformed = source.replace('project_id = "clued-cloud"', `project_id = "${prefix}-${run}"`)
    .replace(/^([ \t]*(?:port|shadow_port)[ \t]*=[ \t]*)5432([0-9])$/gm, (_, leading, digit) => {
      count++; return leading + (45000 + (run % 1000) * 10 + Number(digit));
    });
  requireProof(count === 7, 'isolation_ports');
  return transformed;
}

// Artifact archives contain one small JSON file. Never extract paths to disk.
export function readReportZip(bytes) {
  requireProof(bytes.length <= MAX_BYTES && bytes.length >= 22, 'archive_size');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  requireProof(end >= 0 && bytes.readUInt32LE(end) === 0x06054b50, 'archive_directory');
  requireProof(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 &&
    bytes.readUInt16LE(end + 8) === 1 && bytes.readUInt16LE(end + 10) === 1 &&
    end + 22 + bytes.readUInt16LE(end + 20) === bytes.length, 'archive_entries');
  const pos = bytes.readUInt32LE(end + 16);
  requireProof(pos + 46 <= end && bytes.readUInt32LE(pos) === 0x02014b50, 'archive_entry');
  const method = bytes.readUInt16LE(pos + 10);
  const packed = bytes.readUInt32LE(pos + 20);
  const unpacked = bytes.readUInt32LE(pos + 24);
  const nameSize = bytes.readUInt16LE(pos + 28);
  const extra = bytes.readUInt16LE(pos + 30);
  const comment = bytes.readUInt16LE(pos + 32);
  const local = bytes.readUInt32LE(pos + 42);
  requireProof(pos + 46 + nameSize + extra + comment === end &&
    bytes.readUInt32LE(end + 12) === end - pos &&
    bytes.subarray(pos + 46, pos + 46 + nameSize).toString() === REPORT_NAME &&
    (bytes.readUInt16LE(pos + 8) & 1) === 0 && [0, 8].includes(method) &&
    unpacked <= MAX_BYTES && local + 30 <= pos &&
    bytes.readUInt32LE(local) === 0x04034b50, 'archive_shape');
  const localNameSize = bytes.readUInt16LE(local + 26);
  const start = local + 30 + localNameSize + bytes.readUInt16LE(local + 28);
  requireProof(bytes.subarray(local + 30, local + 30 + localNameSize).toString() === REPORT_NAME &&
    bytes.readUInt16LE(local + 8) === method && start + packed <= pos, 'archive_local_entry');
  const data = bytes.subarray(start, start + packed);
  const raw = method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_BYTES });
  requireProof(raw.length === unpacked, 'archive_unpacked_size');
  return JSON.parse(raw.toString('utf8'));
}

// The merge, its PR and the PR's latest run of this workflow, as both proofs require them.
function validateMergedRun({ repository, owner, sha, workflow, merge, pr, sourceCommit, run, jobs }) {
  requireProof(TARGETS[workflow] && merge.sha === sha && SHA.test(sha), 'merge_identity');
  requireProof(pr.state === 'closed' && pr.merged === true && pr.merge_commit_sha === sha &&
    Number.isSafeInteger(pr.number) && pr.base?.ref === 'main' &&
    pr.base?.repo?.full_name === repository && pr.head?.repo?.full_name === repository &&
    pr.user?.login === owner && (pr.merged_by?.login === owner || executorMerged(pr.merged_by)) &&
    SHA.test(pr.head?.sha), 'merged_pr_identity');
  requireProof(merge.parents?.length === 2 && merge.parents[1].sha === pr.head.sha &&
    sourceCommit.sha === pr.head.sha && SHA.test(merge.commit?.tree?.sha) &&
    merge.commit.tree.sha === sourceCommit.commit?.tree?.sha, 'merged_tree_differs');
  requireProof(run.event === 'pull_request' && run.status === 'completed' && run.conclusion === 'success' &&
    run.path === `.github/workflows/${workflow}` && run.head_sha === pr.head.sha &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.actor?.login === owner && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 && Array.isArray(run.pull_requests) &&
    (run.pull_requests.length === 0 || run.pull_requests.some((p) => p.number === pr.number)), 'pr_run_identity');
  // GitHub clears pull_requests on closed-PR runs (#688 was observed empty).
  // The actual event PR number is separately bound by the immutable report.
  requireProof(Number.isSafeInteger(jobs.total_count) && jobs.total_count < 100 &&
    jobs.jobs?.length === jobs.total_count, 'job_listing_incomplete');
}

export function validateEvidence({ repository, owner, sha, workflow, merge, pr, sourceCommit, run, jobs, report }) {
  const target = TARGETS[workflow];
  requireProof(target?.proof === 'tree-report', 'proof_kind');
  validateMergedRun({ repository, owner, sha, workflow, merge, pr, sourceCommit, run, jobs });
  const selected = jobs.jobs.filter((job) => job.name === target.job);
  requireProof(selected.length === 1, 'heavy_job_missing');
  const job = selected[0];
  requireProof(job.run_id === run.id && job.status === 'completed' && job.conclusion === 'success' &&
    job.steps?.length > 5 && target.steps.every((name) =>
      job.steps.filter((step) => step.name === name && step.conclusion === 'success').length === 1) &&
    job.steps.every((step) => step.conclusion === 'success' ||
      (step.name === 'Capture safe failure diagnostics' && step.conclusion === 'skipped')), 'heavy_steps_not_passed');
  requireProof(report.schema === 'clued.tested-tree/1' && report.repository === repository &&
    report.workflow === workflow && report.run_id === run.id && report.run_attempt === run.run_attempt &&
    report.pr_number === pr.number && report.pr_head_sha === pr.head.sha &&
    SHA.test(report.checkout_sha) && report.checkout_sha === report.github_sha &&
    report.tree === merge.commit.tree.sha, 'tested_tree_identity');
  const isolated = ISOLATED_PROJECTS[workflow];
  const g4 = workflow === 'clued-g4-database.yml';
  const selectedBlock = report.isolation?.profile === 'selected-seven-ports/3';
  requireProof(isolated ? (g4 ? ['fixed-seven-ports/2', 'selected-seven-ports/3'].includes(report.isolation?.profile) :
    report.isolation?.profile === 'fixed-seven-ports/1') &&
    report.isolation.run_id === run.id && /^sha256:[a-f0-9]{64}$/.test(report.isolation.source_config_digest) &&
    /^sha256:[a-f0-9]{64}$/.test(report.isolation.tested_config_digest) &&
    (!g4 || report.isolation.run_attempt === run.run_attempt) &&
    (!selectedBlock || portCandidates({ GITHUB_RUN_ID: String(run.id), GITHUB_RUN_ATTEMPT: String(run.run_attempt),
      GITHUB_SHA: report.checkout_sha, GITHUB_REPOSITORY: repository }).includes(report.isolation.port_base) &&
      /^sha256:[a-f0-9]{64}$/.test(report.isolation.fresh_marker_digest)) : report.isolation === null, 'tested_isolation_identity');
  return { run_heavy: false, reason: 'prior_pr_tested_identical_tree', source_run_id: run.id,
    source_attempt: run.run_attempt, source_pr: pr.number, tested_tree: report.tree,
    current_sha_pass: false, qualification: 'PR_EVIDENCE_ONLY' };
}

// No artifact: main's old tip (the merge's first parent) must be an ancestor of the head. main only moves
// forward (non_fast_forward rule), so the base of every earlier PR test merge was one too, and that merge's
// tree was the head's tree. Each listed job and the gate passed exactly once; any other job (a "-skipped"
// copy, a job the table does not know) means the run is not the evidence this table describes.
export function validateAncestryEvidence({ repository, owner, sha, workflow, merge, pr, sourceCommit, run, jobs, compare }) {
  const target = TARGETS[workflow];
  requireProof(target?.proof === 'ancestry', 'proof_kind');
  validateMergedRun({ repository, owner, sha, workflow, merge, pr, sourceCommit, run, jobs });
  const base = merge.parents[0]?.sha;
  requireProof(SHA.test(base) && ['ahead', 'identical'].includes(compare?.status) && compare.behind_by === 0 &&
    compare.base_commit?.sha === base && compare.merge_base_commit?.sha === base, 'base_not_ancestor');
  const expected = [GATE_JOB, ...target.jobs];
  requireProof(jobs.jobs.length === expected.length && expected.every((name) =>
    jobs.jobs.filter((job) => job.name === name && job.run_id === run.id && job.status === 'completed' &&
      job.conclusion === 'success').length === 1), 'required_jobs_not_passed');
  return { run_heavy: false, reason: 'prior_pr_tested_identical_tree', source_run_id: run.id,
    source_attempt: run.run_attempt, source_pr: pr.number, tested_tree: merge.commit.tree.sha,
    current_sha_pass: false, qualification: 'PR_EVIDENCE_ONLY' };
}

async function limitedBody(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireProof(size <= MAX_BYTES, 'artifact_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function evaluatePush(env, fetchImpl = fetch) {
  if (env.GITHUB_EVENT_NAME !== 'push') return fallback('pr_and_dispatch_always_run');
  if (env.GITHUB_REF !== 'refs/heads/main' ||
    ![env.GITHUB_REPOSITORY_OWNER, EXECUTOR_LOGIN].includes(env.GITHUB_ACTOR) ||
    !SHA.test(env.GITHUB_SHA) || !TARGETS[env.REUSE_WORKFLOW] ||
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
    env.GITHUB_REPOSITORY.split('/')[0] !== env.GITHUB_REPOSITORY_OWNER || !env.GITHUB_TOKEN) {
    return fallback('push_context_not_eligible');
  }
  const base = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  let requests = 0;
  const get = async (suffix, binary = false) => {
    requireProof(++requests <= 9, 'request_budget');
    const response = await fetchImpl(base + suffix, { headers: {
      accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    }, signal: AbortSignal.timeout(10_000) });
    requireProof(response.ok, 'github_request_failed');
    return binary ? limitedBody(response) : response.json();
  };
  try {
    const sha = env.GITHUB_SHA;
    const merge = await get(`/commits/${sha}`);
    const prs = await get(`/commits/${sha}/pulls?per_page=100`);
    requireProof(Array.isArray(prs) && prs.length < 100, 'pr_listing_incomplete');
    const exact = prs.filter((pr) => pr.merge_commit_sha === sha && pr.merged_at);
    requireProof(exact.length === 1, 'merged_pr_missing');
    const pr = await get(`/pulls/${exact[0].number}`);
    const sourceCommit = await get(`/commits/${pr.head.sha}`);
    // Select the latest run, not an earlier green result after a failed retry.
    const runPath = `/actions/workflows/${env.REUSE_WORKFLOW}/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`;
    const runs = await get(runPath);
    requireProof(Number.isSafeInteger(runs.total_count) && runs.total_count > 0 && runs.total_count < 100 &&
      runs.workflow_runs?.length === runs.total_count, 'run_listing_incomplete');
    const run = [...runs.workflow_runs].sort((a, b) => b.run_number - a.run_number)[0];
    const jobs = await get(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    const latestUnchanged = async () => {
      const fresh = await get(runPath);
      requireProof(Number.isSafeInteger(fresh.total_count) && fresh.total_count < 100 &&
        fresh.workflow_runs?.length === fresh.total_count, 'latest_run_listing_incomplete');
      const latest = [...fresh.workflow_runs].sort((a, b) => b.run_number - a.run_number)[0];
      requireProof(latest?.id === run.id && latest.run_attempt === run.run_attempt &&
        latest.status === 'completed' && latest.conclusion === 'success' &&
        latest.head_sha === run.head_sha && latest.path === run.path, 'latest_attempt_changed');
    };
    if (TARGETS[env.REUSE_WORKFLOW].proof === 'ancestry') {
      await latestUnchanged();
      const compare = await get(`/compare/${merge.parents?.[0]?.sha}...${pr.head.sha}`);
      return validateAncestryEvidence({ repository: env.GITHUB_REPOSITORY, owner: env.GITHUB_REPOSITORY_OWNER,
        sha, workflow: env.REUSE_WORKFLOW, merge, pr, sourceCommit, run, jobs, compare });
    }
    const artifacts = await get(`/actions/runs/${run.id}/artifacts?per_page=100`);
    requireProof(Number.isSafeInteger(artifacts.total_count) && artifacts.total_count < 100 &&
      artifacts.artifacts?.length === artifacts.total_count, 'artifact_listing_incomplete');
    const selected = artifacts.artifacts.filter((item) => item.name === artifactName(env.REUSE_WORKFLOW, run.run_attempt));
    requireProof(selected.length === 1 && !selected[0].expired &&
      /^sha256:[a-f0-9]{64}$/.test(selected[0].digest ?? '') &&
      selected[0].workflow_run?.id === run.id && selected[0].workflow_run?.head_sha === pr.head.sha, 'artifact_identity');
    const archive = await get(`/actions/artifacts/${selected[0].id}/zip`, true);
    requireProof(digest(archive) === selected[0].digest, 'artifact_digest');
    const report = readReportZip(archive);
    // Artifact download is a separate boundary; reject a retry or newer run
    // that started while its earlier green proof was being read.
    await latestUnchanged();
    return validateEvidence({ repository: env.GITHUB_REPOSITORY, owner: env.GITHUB_REPOSITORY_OWNER,
      sha, workflow: env.REUSE_WORKFLOW, merge, pr, sourceCommit, run, jobs, report });
  } catch {
    // Unavailable, stale or unqualified proof costs a real rerun; never a fake PASS.
    return fallback('proof_unavailable_or_not_applicable');
  }
}

export function testedTreeReport(env, event, git = (...args) => {
  const result = execFileSync('git', args, { encoding: 'utf8' });
  return args[0] === 'show' ? result : result.trim();
}, readConfig = () => fs.readFileSync('supabase/config.toml', 'utf8'), readFreshMarker) {
  requireProof(env.GITHUB_EVENT_NAME === 'pull_request' && TARGETS[env.REUSE_WORKFLOW]?.proof === 'tree-report' &&
    event.pull_request?.head?.repo?.full_name === env.GITHUB_REPOSITORY &&
    env.GITHUB_ACTOR === env.GITHUB_REPOSITORY_OWNER &&
    event.pull_request.user.login === env.GITHUB_REPOSITORY_OWNER, 'report_context');
  const checkout = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  requireProof(SHA.test(checkout) && checkout === env.GITHUB_SHA && SHA.test(tree) &&
    SHA.test(event.pull_request.head.sha), 'report_checkout');
  const run = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  requireProof(Number.isSafeInteger(run) && run > 0 && Number.isSafeInteger(attempt) && attempt > 0, 'report_run');
  const status = git('status', '--porcelain', '--untracked-files=no');
  let isolation = null;
  if (ISOLATED_PROJECTS[env.REUSE_WORKFLOW]) {
    requireProof(status === `M ${CONFIG}` || status === ` M ${CONFIG}`, 'report_dirty_paths');
    const source = git('show', `HEAD:${CONFIG}`);
    const actual = readConfig();
    const g4 = env.REUSE_WORKFLOW === 'clued-g4-database.yml';
    // G4's default marker comes from this attempt's actual prepare file, bound
    // to source/config hashes and identity. A preview port base is not proof.
    const marker = g4 ? verifyPreparedConfiguration(source, actual, env, readFreshMarker?.()) : null;
    requireProof(actual === isolatedConfig(source, env.REUSE_WORKFLOW, run, attempt, marker?.port_base), 'report_isolation_diff');
    isolation = { profile: g4 ? 'selected-seven-ports/3' : 'fixed-seven-ports/1', run_id: run,
      ...(g4 ? { run_attempt: attempt, port_base: marker.port_base, fresh_marker_digest: digest(JSON.stringify(marker)) } : {}),
      source_config_digest: digest(source), tested_config_digest: digest(actual) };
  } else requireProof(status === '', 'report_dirty_paths');
  return { schema: 'clued.tested-tree/1', repository: env.GITHUB_REPOSITORY,
    workflow: env.REUSE_WORKFLOW, run_id: run, run_attempt: attempt,
    pr_number: event.pull_request.number, pr_head_sha: event.pull_request.head.sha,
    checkout_sha: checkout, github_sha: env.GITHUB_SHA, tree, isolation };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--report')) {
    const report = testedTreeReport(process.env, JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
    fs.writeFileSync(process.env.REUSE_REPORT_PATH, JSON.stringify(report) + '\n');
  } else {
    const result = await evaluatePush(process.env);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run_heavy=${result.run_heavy}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Duplicate push test decision\n\n${JSON.stringify(result)}\n\nThis is prior PR evidence only; skipped heavy jobs do not qualify this main SHA.\n`);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}
