// The eight required checks are pinned to their producing GitHub Apps.
export const RELEASE_REPOSITORY = 'tdoljyj/cross-memory-system';
export const RELEASE_OWNER = 'tdoljyj';
const sha = /^[0-9a-f]{40}$/;
const required = new Map([
  ...['ci-suites', 'ci-suites-windows', 'clued-cloud-tests', 'migration-verify', 'gitleaks', 'trivy', 'contract-placement']
    .map(name => [`hosted-${name}`, 15368]),
  ['kooyumi-work-admission', 5368905],
]);

export function insist(condition, code, detail) {
  if (!condition) throw Object.assign(new Error(code), { code, detail });
}

export async function admitFleetRelease({ api, repository, commit }) {
  insist(repository === RELEASE_REPOSITORY && sha.test(commit), 'FLEET_RELEASE_SUBJECT_REFUSED');
  const base = `repos/${repository}`;
  const readMain = async () => {
    const ref = await api(`${base}/git/ref/heads/main`);
    insist(ref?.ref === 'refs/heads/main' && ref.object?.type === 'commit' && ref.object.sha === commit,
      'FLEET_RELEASE_MAIN_CHANGED', { expected: commit, actual: ref?.object?.sha });
  };
  await readMain();
  const merge = await api(`${base}/commits/${commit}`);
  const head = merge?.parents?.[1]?.sha;
  const tree = merge?.commit?.tree?.sha;
  const bound = pull => pull?.state === 'closed' && pull.merged_at && pull.merge_commit_sha === commit &&
    pull.base?.ref === 'main' && pull.base.repo?.full_name === repository &&
    pull.head?.repo?.full_name === repository && pull.head.sha === head;
  insist(merge?.sha === commit && merge.parents?.length === 2 && sha.test(merge.parents[0]?.sha) &&
    sha.test(head) && sha.test(tree), 'FLEET_RELEASE_MERGED_PR_REFUSED', { commit });
  const pulls = await api(`${base}/commits/${commit}/pulls?per_page=100`);
  insist(Array.isArray(pulls) && pulls.length < 100, 'FLEET_RELEASE_MERGED_PR_REFUSED', { commit });
  const matches = pulls.filter(bound);
  const number = matches[0]?.number;
  insist(matches.length === 1 && Number.isSafeInteger(number) && number > 0, 'FLEET_RELEASE_MERGED_PR_REFUSED', { commit });
  const pull = await api(`${base}/pulls/${number}`);
  const mergedAt = typeof pull?.merged_at === 'string' ? Date.parse(pull.merged_at) : NaN;
  insist(bound(pull) && pull.number === number && pull.merged === true && Number.isFinite(mergedAt),
    'FLEET_RELEASE_MERGED_PR_REFUSED', { commit, number });
  const checked = await api(`${base}/commits/${head}`);
  insist(checked?.sha === head && checked.commit?.tree?.sha === tree, 'FLEET_RELEASE_MERGED_TREE_CHANGED', { commit, head });
  const checks = new Map([...required].map(([name, app]) => [`${app}/${name}`, null]));

  // Read every page. Among checks started by merge time, a newer queued, skipped or failed check supersedes an older green.
  const seen = new Set();
  for (let page = 1; ; page++) {
    insist(page <= 10, 'FLEET_RELEASE_CHECKS_UNREADABLE');
    const result = await api(`${base}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`);
    const rows = result?.check_runs;
    insist(Array.isArray(rows) && rows.length <= 100 && Number.isSafeInteger(result.total_count) && result.total_count <= 1000,
      'FLEET_RELEASE_CHECKS_UNREADABLE');
    for (const row of rows) {
      insist(Number.isSafeInteger(row?.id) && !seen.has(row.id) && row.head_sha === head, 'FLEET_RELEASE_CHECKS_UNREADABLE');
      seen.add(row.id);
      const key = `${row.app?.id}/${row.name}`;
      if (!checks.has(key)) continue;
      const startedAt = typeof row.started_at === 'string' ? Date.parse(row.started_at) : NaN;
      insist(Number.isFinite(startedAt), 'FLEET_RELEASE_CHECKS_UNREADABLE');
      if (startedAt <= mergedAt && row.id > (checks.get(key)?.id ?? 0)) checks.set(key, row);
    }
    if (seen.size === result.total_count) break;
    insist(rows.length === 100 && seen.size < result.total_count, 'FLEET_RELEASE_CHECKS_UNREADABLE');
  }
  const blocked = [...checks].filter(([, row]) => row?.status !== 'completed' || row.conclusion !== 'success').map(([key]) => key);
  insist(blocked.length === 0, 'FLEET_RELEASE_CHECKS_NOT_GREEN', { commit, head, blocked });
  await readMain();
}

if (import.meta.main) {
  const env = process.env;
  const commit = env.EXPECTED_RELEASE_SHA;
  await Promise.resolve().then(async () => {
    insist(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_SHA === commit &&
      env.GITHUB_ACTOR === RELEASE_OWNER && env.GITHUB_TRIGGERING_ACTOR === RELEASE_OWNER && env.GITHUB_RUN_ATTEMPT === '1' && env.GH_TOKEN,
      'FLEET_RELEASE_WORKFLOW_SUBJECT_REFUSED');
    const api = async endpoint => {
      const answer = await fetch(`https://api.github.com/${endpoint}`, {
        headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      insist(answer.ok, 'FLEET_RELEASE_GITHUB_UNREADABLE', answer.status);
      return answer.json();
    };
    await admitFleetRelease({ repository: env.GITHUB_REPOSITORY, commit, api });
  }).catch(error => {
    console.error(error.code ?? 'FLEET_RELEASE_ADMISSION_UNREADABLE', JSON.stringify(error.detail ?? null));
    process.exitCode = 1;
  });
}
