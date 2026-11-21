// Fable 11-21 T5 (push landing follow-up): the rules after C add kooyumi-train-landed pinned to App 5368905, which nothing ever publishes.
// The merge-slot reporter (scripts/ci/clued-merge-slot-ci.mjs) reads main's required checks live (requiredChecksOf) and counts every one
// but kooyumi-merge-slot (ciRequiredChecks). Under C it lists kooyumi-train-landed as missing: on a head whose CI is all green it stays
// idle, never failed, so it neither returns the slot nor posts a failing slot check, and never touches green. Recorded as found (11-21),
// not changed here: whether the reporter should report green under C is Fable's (the train lands itself; the merge executor's planFor
// answers none under these rules, scripts/ci/clued-merge-executor.test.mjs). Kept out of scripts/ci (a protected path).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ciStateOf, requiredChecksOf } from '../../../scripts/ci/clued-merge-slot-ci.mjs';

const REPO = 'o/r', HEAD = 'a'.repeat(40), APP = 5368905;
const NAMES = ['gitleaks', 'trivy', 'kooyumi-work-admission', 'kooyumi-admission-verified', 'kooyumi-merge-slot', 'contract-placement'];
const TODAY = Object.freeze(NAMES.map(name => Object.freeze({ name, app_id: APP })));
const C_RULES = Object.freeze([...TODAY, Object.freeze({ name: 'kooyumi-train-landed', app_id: APP })]);
const J = d => d.repeat(64);
const IDS = { 'kooyumi-work-admission': `independent-ci:native-work-admission:${J('3')}:f9:e1:a1`,
  'kooyumi-admission-verified': `independent-ci:control:control-admission:${J('1')}:f9:e1:a1` };
const check = (name, extra = {}) => ({ id: 500 + NAMES.indexOf(name), name, head_sha: HEAD, status: 'completed', conclusion: 'success', app: { id: APP },
  external_id: IDS[name] ?? `independent-ci:staged:${J('4')}:f9:e1:a1`,
  output: { title: 'Independent check', summary: name === 'kooyumi-admission-verified' ? `Independent Native control check for ${REPO}#5; observation sha256 ${J('5')}.` : `Independent CI job ${J('4')}.` }, ...extra });
const pull = { number: 5, state: 'open', draft: false, head: { sha: HEAD }, base: { ref: 'main', repo: { default_branch: 'main', full_name: REPO } } };
const env = { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 't' };
const json = v => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
function fake(checks, rules = C_RULES) {
  const calls = [];
  const fetchImpl = async url => {
    const route = String(url).replace(/^https:\/\/api\.github\.com/, '');
    calls.push(route);
    if (route.startsWith(`/repos/${REPO}/rules/branches/main`)) return json([{ type: 'required_status_checks', ruleset_id: 24182890,
      parameters: { strict_required_status_checks_policy: true, required_status_checks: rules.map(r => ({ context: r.name, integration_id: r.app_id })) } }]);
    if (route.startsWith(`/repos/${REPO}/commits/${HEAD}/check-runs?filter=all&`)) {
      const page = Number(new URL(`https://x${route}`).searchParams.get('page'));
      return json({ total_count: checks.length, check_runs: checks.slice((page - 1) * 100, page * 100) });
    }
    if (route.startsWith(`/repos/${REPO}/actions/runs?head_sha=${HEAD}`)) return json({ total_count: 0, workflow_runs: [] });
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}
const qualify = async pr => ({ passed: true, state: 'qualified', head: pr.head.sha, pr_number: pr.number, reason: 'fixture', native_runs: [] });
const green = () => NAMES.filter(n => n !== 'kooyumi-merge-slot').map(n => check(n));

test('T5: the rules after C x the merge-slot reporter: a never-published kooyumi-train-landed is never a failure; green CI stays idle, no touch', async () => {
  assert.deepEqual(await requiredChecksOf(fake([]).fetchImpl, env, REPO, 'main'), C_RULES, 'requiredChecksOf reads the rules after C');
  const state = await ciStateOf(fake(green()).fetchImpl, env, REPO, HEAD, new Map(), null, { pr: pull, qualifyExecution: qualify, required: C_RULES });
  assert.notEqual(state.state, 'failed');
  assert.deepEqual([state.state, state.reason, state.checks.find(c => c.name === 'kooyumi-train-landed')?.status],
    ['idle', 'no CI result yet and no CI run active', 'missing']);
  // the same head on today's rules is not failed either (the reference the cell above differs from only by the train's check)
  const today = await ciStateOf(fake(green(), TODAY).fetchImpl, env, REPO, HEAD, new Map(), null, { pr: pull, qualifyExecution: async () => null, required: TODAY });
  assert.notEqual(today.state, 'failed');
  // a real failure under C is still the head's own
  const failing = green().map(c => c.name === 'trivy' ? { ...c, conclusion: 'failure' } : c);
  const failed = await ciStateOf(fake(failing).fetchImpl, env, REPO, HEAD, new Map(), null, { pr: pull, qualifyExecution: qualify, required: C_RULES });
  assert.deepEqual([failed.state, failed.reason], ['failed', 'trivy concluded failure']);
});
