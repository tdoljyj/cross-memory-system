// The approved hosted-scaffold baseline. A ruleset edit alone cannot shrink it.
export const RELEASE_REPOSITORY = 'tdoljyj/cross-memory-system';
export const RELEASE_OWNER = 'tdoljyj';
const scaffold = 27843120;
const required = new Map([
  ...['ci-suites', 'ci-suites-windows', 'clued-cloud-tests', 'migration-verify', 'gitleaks', 'trivy', 'contract-placement']
    .map(name => [`hosted-${name}`, 15368]),
  ['kooyumi-work-admission', 5368905],
]);

export function insist(condition, code, detail) {
  if (!condition) throw Object.assign(new Error(code), { code, detail });
}

export async function admitFleetRelease({ api, repository, commit }) {
  insist(repository === RELEASE_REPOSITORY && /^[0-9a-f]{40}$/.test(commit), 'FLEET_RELEASE_SUBJECT_REFUSED');
  const base = `repos/${repository}`;
  const readMain = async () => {
    const ref = await api(`${base}/git/ref/heads/main`);
    insist(ref?.ref === 'refs/heads/main' && ref.object?.type === 'commit' && ref.object.sha === commit,
      'FLEET_RELEASE_MAIN_CHANGED', { expected: commit, actual: ref?.object?.sha });
  };
  await readMain();
  const rules = await api(`${base}/rules/branches/main?per_page=100`);
  insist(Array.isArray(rules) && rules.length < 100 && rules.every(rule => typeof rule?.type === 'string'), 'FLEET_RELEASE_RULES_UNREADABLE');
  const pinnedRules = rules.filter(rule => rule.ruleset_id === scaffold);
  insist(['pull_request', 'deletion', 'non_fast_forward'].every(type => pinnedRules.some(rule => rule.type === type)), 'FLEET_RELEASE_RULES_CHANGED');
  const checks = new Map();
  const pinnedChecks = new Map();
  const strict = rules.filter(rule => rule.type === 'required_status_checks');
  insist(strict.some(rule => rule.ruleset_id === scaffold && rule.parameters?.strict_required_status_checks_policy === true),
    'FLEET_RELEASE_RULES_CHANGED');
  for (const rule of strict) {
    const entries = rule.parameters?.required_status_checks;
    insist(Array.isArray(entries) && entries.length > 0, 'FLEET_RELEASE_RULES_UNREADABLE');
    for (const entry of entries) {
      const { context, integration_id: id } = entry ?? {};
      insist(typeof context === 'string' && context.length > 0 && Number.isSafeInteger(id) && id > 0, 'FLEET_RELEASE_CHECK_NOT_PINNED');
      const key = `${id}/${context}`;
      checks.set(key, null);
      if (rule.ruleset_id === scaffold && rule.parameters.strict_required_status_checks_policy === true) pinnedChecks.set(context, id);
    }
  }
  for (const [name, app] of required) insist(pinnedChecks.get(name) === app, 'FLEET_RELEASE_RULES_CHANGED', { name, app });

  // Read every page. A newer queued, skipped or failed check supersedes an older green.
  const seen = new Set();
  for (let page = 1; ; page++) {
    insist(page <= 10, 'FLEET_RELEASE_CHECKS_UNREADABLE');
    const result = await api(`${base}/commits/${commit}/check-runs?filter=all&per_page=100&page=${page}`);
    const rows = result?.check_runs;
    insist(Array.isArray(rows) && rows.length <= 100 && Number.isSafeInteger(result.total_count) && result.total_count <= 1000,
      'FLEET_RELEASE_CHECKS_UNREADABLE');
    for (const row of rows) {
      insist(Number.isSafeInteger(row?.id) && !seen.has(row.id) && row.head_sha === commit, 'FLEET_RELEASE_CHECKS_UNREADABLE');
      seen.add(row.id);
      const key = `${row.app?.id}/${row.name}`;
      if (checks.has(key) && row.id > (checks.get(key)?.id ?? 0)) checks.set(key, row);
    }
    if (seen.size === result.total_count) break;
    insist(rows.length === 100 && seen.size < result.total_count, 'FLEET_RELEASE_CHECKS_UNREADABLE');
  }
  const blocked = [...checks].filter(([, row]) => row?.status !== 'completed' || row.conclusion !== 'success').map(([key]) => key);
  insist(blocked.length === 0, 'FLEET_RELEASE_CHECKS_NOT_GREEN', { commit, blocked });
  await readMain();
}

if (import.meta.main) {
  const env = process.env;
  const commit = env.EXPECTED_RELEASE_SHA;
  await Promise.resolve().then(async () => {
    insist(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_SHA === commit &&
      env.GITHUB_ACTOR === RELEASE_OWNER && env.GITHUB_TRIGGERING_ACTOR === RELEASE_OWNER && env.GITHUB_RUN_ATTEMPT === '1' && env.GH_TOKEN,
      'FLEET_RELEASE_WORKFLOW_SUBJECT_REFUSED');
    await admitFleetRelease({ repository: env.GITHUB_REPOSITORY, commit, api: async endpoint => {
      const answer = await fetch(`https://api.github.com/${endpoint}`, { headers: { Authorization: `Bearer ${env.GH_TOKEN}` },
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
      insist(answer.ok, 'FLEET_RELEASE_GITHUB_UNREADABLE', answer.status);
      return answer.json();
    } });
  }).catch(error => {
    console.error(error.code ?? 'FLEET_RELEASE_ADMISSION_UNREADABLE', JSON.stringify(error.detail ?? null));
    process.exitCode = 1;
  });
}
