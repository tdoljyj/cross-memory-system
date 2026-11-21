// Same tree, same check, one real run (rule 41ab823a; FABLE-main-push-tree-reuse §2.2): whether a main push may
// reuse the merged PR head's passing run of the same tree. Pure judgement over GitHub's own records: it imports no
// repository file, so the admission gate (a Source v2 walk entry) pulls only this file into the resident closure.
// scripts/ci/clued-push-reuse.mjs re-exports it and adds the tested-tree artifact proof of G4 and IFE2E.

export const SHA = /^[a-f0-9]{40}$/;
export const MAX_BYTES = 64 * 1024;
// Workflows whose main push may reuse the merged PR head's passing run of the same tree.
// proof 'tree-report': the workflow's own push-reuse job reads the tested-tree artifact the PR run uploaded
//   (clued-push-reuse.mjs supplies that proof).
// proof 'ancestry': the admission gate decides (clued-work-admission.mjs gate()); main's old tip must be an
//   ancestor of the head, so the PR run's test merge had the head's tree, and every listed job (each a required
//   check under its job id) plus the gate must have passed exactly once in the head's latest run.
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
// Existing repository executor identity, observed on PR #688. This permits
// proof lookup only; it does not move a bot onto the trusted runner route.
const EXECUTOR_LOGIN = 'clued-admission[bot]';
const executorMerged = (actor) => actor?.login === EXECUTOR_LOGIN && actor.id === 337003645 && actor.type === 'Bot';
// Who may have triggered the PR run. The caller decides; without a caller's word only the owner counts.
const ownerTriggered = (owner) => (actor) => actor?.login === owner;
const fallback = (reason) => ({ run_heavy: true, reason, current_sha_pass: false });
export const requireProof = (condition, reason) => { if (!condition) throw new Error(reason); };

// The merge, its PR and the PR's latest run of this workflow, as both proofs require them.
export function validateMergedRun({ repository, owner, sha, workflow, merge, pr, sourceCommit, run, jobs,
  runActorAllowed = ownerTriggered(owner) }) {
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
    runActorAllowed(run.actor) === true && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 && Array.isArray(run.pull_requests) &&
    (run.pull_requests.length === 0 || run.pull_requests.some((p) => p.number === pr.number)), 'pr_run_identity');
  // GitHub clears pull_requests on closed-PR runs (#688 was observed empty). The tree-report proof binds the PR
  // number through its immutable report; the ancestry proof needs every required job under its real name, which
  // the workflows give only to an admitted owner PR against main from this repository.
  requireProof(Number.isSafeInteger(jobs.total_count) && jobs.total_count < 100 &&
    jobs.jobs?.length === jobs.total_count, 'job_listing_incomplete');
}

// No artifact: main's old tip (the merge's first parent) must be an ancestor of the head. main only moves
// forward (non_fast_forward rule), so the base of every earlier PR test merge was one too, and that merge's
// tree was the head's tree. Each listed job and the gate passed exactly once; any other job (a "-skipped"
// copy, a job the table does not know) means the run is not the evidence this table describes.
export function validateAncestryEvidence({ repository, owner, sha, workflow, merge, pr, sourceCommit, run, jobs, compare }) {
  const target = TARGETS[workflow];
  requireProof(target?.proof === 'ancestry', 'proof_kind');
  // The executor bot's run counts here and only here (#1202: the head was its merge of main). The heavy jobs carry
  // their real names on a bot run only after the gate proved that merge (automation_self_hosted), and the names are
  // required below; a bot run without that proof has "-skipped" names. The tree-report workflows (G4, IFE2E) have no
  // such name proof, so clued-push-reuse.mjs passes nothing and keeps the owner only.
  validateMergedRun({ repository, owner, sha, workflow, merge, pr, sourceCommit, run, jobs,
    runActorAllowed: (actor) => actor?.login === owner || executorMerged(actor) });
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

// run_heavy=false only on proof; any unavailable, stale or unqualified evidence costs a real run, never a fake PASS.
// `reportProof` (clued-push-reuse.mjs) completes a 'tree-report' target; without it such a target always runs.
export async function evaluatePush(env, fetchImpl = fetch, { reportProof = null } = {}) {
  if (env.GITHUB_EVENT_NAME !== 'push') return fallback('pr_and_dispatch_always_run');
  if (env.GITHUB_REF !== 'refs/heads/main' ||
    ![env.GITHUB_REPOSITORY_OWNER, EXECUTOR_LOGIN].includes(env.GITHUB_ACTOR) ||
    !SHA.test(env.GITHUB_SHA) || !Object.hasOwn(TARGETS, env.REUSE_WORKFLOW ?? '') ||
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
    env.GITHUB_REPOSITORY.split('/')[0] !== env.GITHUB_REPOSITORY_OWNER || !env.GITHUB_TOKEN) {
    return fallback('push_context_not_eligible');
  }
  const target = TARGETS[env.REUSE_WORKFLOW];
  if (target.proof === 'tree-report' && typeof reportProof !== 'function') return fallback('tree_report_proof_unavailable');
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
    // Read again after the evidence: a retry or newer run that started meanwhile voids the earlier green proof.
    const latestUnchanged = async () => {
      const fresh = await get(runPath);
      requireProof(Number.isSafeInteger(fresh.total_count) && fresh.total_count < 100 &&
        fresh.workflow_runs?.length === fresh.total_count, 'latest_run_listing_incomplete');
      const latest = [...fresh.workflow_runs].sort((a, b) => b.run_number - a.run_number)[0];
      requireProof(latest?.id === run.id && latest.run_attempt === run.run_attempt &&
        latest.status === 'completed' && latest.conclusion === 'success' &&
        latest.head_sha === run.head_sha && latest.path === run.path, 'latest_attempt_changed');
    };
    const evidence = { repository: env.GITHUB_REPOSITORY, owner: env.GITHUB_REPOSITORY_OWNER,
      sha, workflow: env.REUSE_WORKFLOW, merge, pr, sourceCommit, run, jobs };
    if (target.proof === 'ancestry') {
      await latestUnchanged();
      const compare = await get(`/compare/${merge.parents?.[0]?.sha}...${pr.head.sha}`);
      return validateAncestryEvidence({ ...evidence, compare });
    }
    return await reportProof({ env, get, evidence, latestUnchanged });
  } catch {
    // Unavailable, stale or unqualified proof costs a real rerun; never a fake PASS.
    return fallback('proof_unavailable_or_not_applicable');
  }
}
