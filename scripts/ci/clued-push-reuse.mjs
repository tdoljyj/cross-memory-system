import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { freshConfig, portCandidates, verifyPreparedConfiguration } from './clued-g4-fresh-start.mjs';
import { MAX_BYTES, SHA, TARGETS, requireProof, validateMergedRun, evaluatePush as evaluateTreeReuse } from './clued-tree-reuse.mjs';

// The reuse table and the ancestry proof live in clued-tree-reuse.mjs (no repository imports: the admission gate
// loads it); this file adds the tested-tree artifact proof of the workflows that upload one (G4, IFE2E).
export { TARGETS, validateAncestryEvidence } from './clued-tree-reuse.mjs';
export const REPORT_NAME = 'clued-tested-tree.json';
const artifactName = (file, attempt) => `clued-tested-tree-${file}-${attempt}`;
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

// The tested-tree artifact proof (proof 'tree-report'): the PR run uploaded the tree it actually checked out.
async function reportProof({ env, get, evidence, latestUnchanged }) {
  const { run, pr } = evidence;
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
  return validateEvidence({ ...evidence, report });
}

export function evaluatePush(env, fetchImpl = fetch) {
  return evaluateTreeReuse(env, fetchImpl, { reportProof });
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
