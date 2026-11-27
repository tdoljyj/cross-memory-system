import { isDeepStrictEqual } from 'node:util';

// The approved hosted-scaffold baseline. A ruleset edit alone cannot change it.
export const RELEASE_REPOSITORY = 'tdoljyj/cross-memory-system';
export const RELEASE_OWNER = 'tdoljyj';
const scaffold = 27843120;
const required = new Map([
  ...['ci-suites', 'ci-suites-windows', 'clued-cloud-tests', 'migration-verify', 'gitleaks', 'trivy', 'contract-placement']
    .map(name => [`hosted-${name}`, 15368]),
  ['kooyumi-work-admission', 5368905],
]);
const pullRequestPolicy = {
  allowed_merge_methods: ['merge'],
  dismiss_stale_reviews_on_push: false,
  require_code_owner_review: false,
  require_extra_approval_for_unattributed_changes: true,
  require_last_push_approval: false,
  required_approving_review_count: 0,
  required_review_thread_resolution: false,
  required_reviewers: [],
};
const statusPolicy = {
  strict_required_status_checks_policy: true,
  do_not_enforce_on_create: false,
  required_status_checks: [...required].map(([context, integration_id]) => ({ context, integration_id }))
    .sort((a, b) => a.context.localeCompare(b.context)),
};
const baseline = new Map([
  ['deletion', null],
  ['non_fast_forward', null],
  ['pull_request', pullRequestPolicy],
  ['required_status_checks', statusPolicy],
]);

export function insist(condition, code, detail) {
  if (!condition) throw Object.assign(new Error(code), { code, detail });
}

async function verifyRules(rulesApi, base, repository) {
  const applicable = await rulesApi(`${base}/rules/branches/main?per_page=100`);
  const details = await rulesApi(`${base}/rulesets/${scaffold}`);
  insist(Array.isArray(applicable) && Array.isArray(details?.rules) && Array.isArray(details?.bypass_actors),
    'FLEET_RELEASE_RULES_UNREADABLE');
  insist(details.id === scaffold && details.source_type === 'Repository' && details.source === repository &&
    details.enforcement === 'active' && details.target === 'branch' && details.bypass_actors.length === 0 &&
    isDeepStrictEqual(details.conditions, { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }) &&
    applicable.every(rule => rule?.ruleset_id === scaffold && rule.ruleset_source_type === 'Repository' && rule.ruleset_source === repository),
    'FLEET_RELEASE_RULES_CHANGED');
  for (const rules of [applicable, details.rules]) {
    insist(rules.length === baseline.size && new Set(rules.map(rule => rule?.type)).size === baseline.size,
      'FLEET_RELEASE_RULES_CHANGED');
    for (const rule of rules) {
      let parameters = rule?.parameters ?? null;
      if (rule?.type === 'required_status_checks' && Array.isArray(parameters?.required_status_checks)) {
        const entries = parameters.required_status_checks;
        insist(entries.every(entry => typeof entry?.context === 'string' && Number.isSafeInteger(entry.integration_id) && entry.integration_id > 0),
          'FLEET_RELEASE_CHECK_NOT_PINNED');
        parameters = { ...parameters, required_status_checks: [...entries].sort((a, b) => a.context.localeCompare(b.context)) };
      }
      insist(isDeepStrictEqual(parameters, baseline.get(rule?.type)), 'FLEET_RELEASE_RULES_CHANGED', rule?.type);
    }
  }
}

export async function admitFleetRelease({ api, rulesApi = api, repository, commit }) {
  insist(repository === RELEASE_REPOSITORY && /^[0-9a-f]{40}$/.test(commit), 'FLEET_RELEASE_SUBJECT_REFUSED');
  const base = `repos/${repository}`;
  const readMain = async () => {
    const ref = await api(`${base}/git/ref/heads/main`);
    insist(ref?.ref === 'refs/heads/main' && ref.object?.type === 'commit' && ref.object.sha === commit,
      'FLEET_RELEASE_MAIN_CHANGED', { expected: commit, actual: ref?.object?.sha });
  };
  await readMain();
  await verifyRules(rulesApi, base, repository);
  const checks = new Map([...required].map(([name, app]) => [`${app}/${name}`, null]));

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
    insist(env.CLUED_FLEET_RULES_READ_TOKEN, 'FLEET_RELEASE_RULES_UNREADABLE');
    const read = (token, code) => async endpoint => {
      const answer = await fetch(`https://api.github.com/${endpoint}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      insist(answer.ok, code, answer.status);
      return answer.json();
    };
    await admitFleetRelease({ repository: env.GITHUB_REPOSITORY, commit,
      api: read(env.GH_TOKEN, 'FLEET_RELEASE_GITHUB_UNREADABLE'),
      rulesApi: read(env.CLUED_FLEET_RULES_READ_TOKEN, 'FLEET_RELEASE_RULES_UNREADABLE') });
  }).catch(error => {
    console.error(error.code ?? 'FLEET_RELEASE_ADMISSION_UNREADABLE', JSON.stringify(error.detail ?? null));
    process.exitCode = 1;
  });
}
