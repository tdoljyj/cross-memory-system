// T-B review rework (6be83331, medium 3): the whole chain of the lost-admission repair and the front PR line over one scripted GitHub.
// The world, lane and migration fixtures are copied from admission-rerun.test.mjs (T-A) so this file stands alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AdmissionRerunState, AdmissionRerunner, HEAD_RECHECK_MS, LOST_RUN_AFTER_MS, ghPort } from '../src/admission-rerun.mjs';
import { LocalStore, PrStatusReporter } from '../src/pr-status.mjs';
import * as mainRules from '../src/main-required-checks.mjs';
const { readMainRequiredChecks } = mainRules;
const RULES_UNREADABLE_REPORT_AFTER_MS = mainRules.RULES_UNREADABLE_REPORT_AFTER_MS ?? 10 * 60_000;
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { trainSummary } from '../src/train.mjs';
import { tempRoot } from './helpers.mjs';

const REPO = 'o/r';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const NATIVE_ID = `independent-ci:native-work-admission:${'3'.repeat(64)}:f9:e1:a1`;
const HEAVY = ['clued-cloud-tests-skipped', 'ci-suites-skipped', 'migration-verify-skipped'];
const LINUX_WORKFLOW = 100;
const WINDOWS_WORKFLOW = 101;
const EXTRA_WORKFLOW = 102;
const HOSTED_WORKFLOW = 104;
const WORKFLOWS = [{ id: LINUX_WORKFLOW, path: '.github/workflows/clued-required-tests.yml', state: 'active' },
  { id: WINDOWS_WORKFLOW, path: '.github/workflows/clued-required-tests-windows.yml', state: 'active' }];
const extraWorkflow = { id: EXTRA_WORKFLOW, path: '.github/workflows/additional.yml', state: 'active' };
const hostedWorkflow = { id: HOSTED_WORKFLOW, path: '.github/workflows/gitleaks.yml', state: 'active' };
const extraSource = 'jobs:\n  admission-gate:\n  extra:\n    needs: admission-gate\n    name: additional-check\n';
const readWorkflow = file => fs.readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
const CHECK_NAMES = HEAVY.map(name => name.replace(/-skipped$/, ''));
const actionCheck = (name, o = {}) => ({ name, head_sha: HEAD, app: { id: 15368 }, ...o });
const requiredRule = (...names) => ({ type: 'required_status_checks', parameters: {
  required_status_checks: names.map(context => ({ context, integration_id: 15368 })),
} });
const pendingNote = { title: 'admission-gate', message: 'ADMISSION_PENDING: kooyumi-work-admission of App 5368905 for #452: has posted no check after 600s.' };
const outageNote = { title: 'kooyumi-work-admission', message: 'GitHub API /repos/o/r/commits/x/check-runs returned 502' };
const otherNote = { title: 'admission-gate', message: 'REJECTED: something else' };
const nativeCheck = (o = {}) => ({ id: 50, name: 'kooyumi-work-admission', head_sha: HEAD, status: 'completed', conclusion: 'success', external_id: NATIVE_ID, app: { id: 5368905 },
  output: { summary: `Independent Native control check for o/r#452; observation sha256 ${'5'.repeat(64)}.` }, ...o });
const pullRequest = (o = {}) => ({ number: 452, state: 'open', head: { sha: HEAD, ref: 'claude/x', repo: { full_name: REPO } }, base: { ref: 'main', sha: BASE, repo: { full_name: REPO } }, ...o });
const attempt = ({ heavy = ['skipped', 'skipped', 'skipped'], notes = [pendingNote], head = HEAD } = {}) => ({ notes,
  jobs: [{ name: 'admission-gate', status: 'completed', conclusion: 'success', head_sha: head },
    ...heavy.map((c, i) => ({ name: HEAVY[i], head_sha: head, status: c === 'in_progress' ? 'in_progress' : 'completed', conclusion: c === 'in_progress' ? null : c }))] });
const run = (id, attempts, o = {}) => ({ id, workflow_id: LINUX_WORKFLOW, head_sha: HEAD, event: 'pull_request', status: 'completed', pull_requests: [{ number: 452 }], attempts, ...o,
  path: o.path ?? [...WORKFLOWS, extraWorkflow, hostedWorkflow].find(w => w.id === (o.workflow_id ?? LINUX_WORKFLOW))?.path });
const workflowAttempt = name => {
  const a = attempt({ heavy: ['skipped'] });
  a.jobs[1].name = `${name}-skipped`;
  return a;
};

// A scripted `gh api`: fail(route, method) may return { code } or 'throw' or { timedOut: true } for one call.
function world({ pulls = [pullRequest()], checks = [nativeCheck()], runs = [run(700, [attempt()])], rerunCode = 0, dispatchCode = 0, fail = () => null, onDispatch = async () => {},
  rules = [requiredRule(...CHECK_NAMES)], workflows = WORKFLOWS } = {}) {
  const st = { pulls, checks, runs, rules, posts: [], dispatches: [], calls: [] };
  const byId = id => st.runs.find(r => r.id === Number(id));
  const jobsOf = (r, n) => r.attempts[n - 1].jobs.map((j, i) => ({ id: r.id * 100 + n * 10 + i, run_attempt: n, ...j }));
  const shown = r => { const { attempts, ...rest } = r; return { ...rest, run_attempt: attempts.length }; };
  const ok = v => ({ code: 0, stdout: JSON.stringify(v) });
  const runFn = async (argv, o) => {
    assert.equal(argv[0], 'C:\\gh.exe'); assert.equal(argv[1], 'api'); assert.ok(Number.isSafeInteger(o?.timeoutMs));
    { const x = await st.extra?.(argv); if (x) return x; }
    const method = argv[3], target = argv.at(-1);
    st.calls.push({ method, target });
    const f = fail(target, method, st);
    if (f === 'throw') throw new Error('spawn failed');
    if (f) return f;
    assert.ok(target.startsWith(`repos/${REPO}/`), target);
    const route = target.slice(`repos/${REPO}`.length);
    let m;
    if (method === 'POST' && (m = /^\/actions\/workflows\/(\d+)\/dispatches$/.exec(route))) {
      st.dispatchFields = argv.flatMap((value, index) => value === '-f' ? [argv[index + 1]] : []);
      const i = argv.indexOf('-f'); assert.ok(i > 0, 'the ref is a field');
      st.dispatches.push(argv[i + 1]);
      if (dispatchCode === 0) st.runs.push(run(900 + st.dispatches.length, [attempt({ heavy: ['in_progress', 'in_progress', 'in_progress'], notes: [] })], { workflow_id: Number(m[1]), event: 'workflow_dispatch', status: 'queued', pull_requests: [] }));
      if (dispatchCode === 0) await onDispatch(st);
      return { code: dispatchCode, stdout: '', stderr: dispatchCode === 0 ? '' : "gh: Workflow does not have 'workflow_dispatch' trigger (HTTP 422)" };
    }
    if (method === 'POST') {
      m = /^\/actions\/runs\/(\d+)\/rerun$/.exec(route); assert.ok(m, route);
      st.posts.push(Number(m[1]));
      if (rerunCode === 0) { const r = byId(m[1]); r.status = 'queued'; r.attempts.push(attempt({ heavy: ['in_progress', 'in_progress', 'in_progress'], notes: [] })); }
      return { code: rerunCode, stdout: '' };
    }
    assert.equal(method, 'GET');
    if (route === '/rules/branches/main?per_page=100&page=1') return ok(st.rules);
    if (/^\/commits\/[a-f0-9]{40}\/check-runs\?filter=all&per_page=100&page=1$/.test(route)) return ok({ total_count: st.checks.length, check_runs: st.checks });
    if (route === '/actions/workflows?per_page=100&page=1') return ok({ total_count: workflows.length, workflows });
    if ((m = /^\/contents\/(\.github\/workflows\/[\w.-]+)\?ref=[a-f0-9]{40}$/.exec(route))) {
      const content = Buffer.from(m[1] === extraWorkflow.path ? extraSource : await readWorkflow(m[1]));
      return ok({ path: m[1], content: content.toString('base64'), encoding: 'base64', sha: (1 + [...WORKFLOWS, extraWorkflow, hostedWorkflow].findIndex(w => w.path === m[1])).toString().repeat(40) });
    }
    if (route === `/commits/${HEAD}/pulls?per_page=100&page=1`) return ok(st.pulls);
    if (route === `/commits/${HEAD}/check-runs?check_name=kooyumi-work-admission&filter=all&per_page=100&page=1`) return ok({ total_count: st.checks.length, check_runs: st.checks });
    if ((m = /^\/actions\/runs\?head_sha=([a-f0-9]{40})&per_page=100&page=1$/.exec(route))) {
      const own = st.runs.filter(r => r.head_sha === m[1]).map(shown);
      return ok({ total_count: own.length, workflow_runs: own });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/jobs\?filter=all&per_page=100&page=1$/.exec(route))) { const r = byId(m[1]); const jobs = r.attempts.flatMap((_, i) => jobsOf(r, i + 1)); return ok({ total_count: jobs.length, jobs }); }
    if ((m = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=1$/.exec(route))) { const jobs = jobsOf(byId(m[1]), Number(m[2])); return ok({ total_count: jobs.length, jobs }); }
    if ((m = /^\/check-runs\/(\d+)\/annotations\?per_page=100&page=1$/.exec(route))) {
      const id = Number(m[1]), a = byId(Math.floor(id / 100)).attempts[Math.floor((id % 100) / 10) - 1];
      return ok(id % 10 === 0 ? a.notes : (a.jobNotes?.[id % 10] ?? []));
    }
    if ((m = /^\/actions\/workflows\/(\d+)\/runs\?/.exec(route))) {
      const others = st.runs.filter(r => r.head_sha !== HEAD && r.workflow_id === Number(m[1])).sort((a, b) => b.id - a.id).map(shown);
      return ok({ total_count: others.length, workflow_runs: others });
    }
    if ((m = /^\/actions\/jobs\/(\d+)\/logs$/.exec(route))) { st.logReads = (st.logReads ?? 0) + 1; const id = Number(m[1]); const r = byId(Math.floor(id / 100)); const n = Math.floor((id % 100) / 10); return { code: 0, stdout: r.attempts[n - 1].logs?.[id % 10] ?? '' }; }
    if ((m = /^\/pulls\/(\d+)$/.exec(route))) return ok(st.pulls.find(p => p.number === Number(m[1])) ?? null);
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(route))) return ok(shown(byId(m[1])));
    assert.fail(`unexpected route ${route}`);
  };
  st.run = runFn;
  st.gh = ghPort({ ghExe: 'C:\\gh.exe', repo: REPO, run: runFn });
  return st;
}
const T0 = Date.parse('2026-11-05T12:00:00Z');
const botRun = (overrides = {}) => run(700, [attempt({ notes: [] })], { actor: { login: 'clued-admission[bot]', type: 'Bot' }, ...overrides });
const status = (o = {}) => ({ node: { mode: 'ACTIVE' }, halt: null, current: null, pending: [{ pr: 452, headSha: HEAD, state: 'PARKED' }], recent: [], ...o });
const pulls = [{ pr: 452, headSha: HEAD }];
const TIMEOUT_NOTE = { message: 'The job has exceeded the maximum execution time of 30m0s' };
function migrationAttempt(head = HEAD, conclusion = 'cancelled', completed = '2026-11-05T11:00:00Z') {
  const a = attempt({ head, heavy: ['success', 'success', conclusion], notes: [] });
  a.jobs[0].completed_at = completed;
  for (const [i, name] of ['clued-cloud-tests', 'ci-suites', 'migration-verify'].entries()) {
    Object.assign(a.jobs[i + 1], { name, completed_at: completed, started_at: '2026-11-05T10:00:00Z',
      steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Verify migrations', conclusion }] });
  }
  return { ...a, jobNotes: { 3: [TIMEOUT_NOTE] }, logs: { 3: 'Running migration verification\nThe operation was canceled.' } };
}

async function lane(t, w, { st = status(), stateFile = null } = {}) {
  let now = T0;
  const toasts = [];
  const file = stateFile ?? path.join(await tempRoot(t), 'rerun.json');
  const state = await AdmissionRerunState.open(file, () => now);
  const r = new AdmissionRerunner({ gh: w.gh, state, clock: () => now, readStatus: async () => ({ ...st, writtenAt: now }), pulls: () => pulls, notify: async (k, title) => toasts.push(title) });
  return { r, state, toasts, file, advance: ms => { now += ms; } };
}

// ---- T-B review rework (medium 3): the whole chain, over the one scripted GitHub both lanes read ----
const RESIDENT = ['gitleaks', 'trivy', 'kooyumi-admission-verified', 'kooyumi-merge-slot', 'contract-placement'];
const ACTIONS = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
const residentRule = context => ({ context, integration_id: 5368905 });
const FULL_RULES = [{ type: 'required_status_checks', parameters: { required_status_checks: [residentRule('kooyumi-work-admission'), ...RESIDENT.map(residentRule),
  ...ACTIONS.map(context => ({ context, integration_id: 15368 }))] } }];
const resident = () => RESIDENT.map((name, i) => ({ id: 60 + i, name, head_sha: HEAD, status: 'completed', conclusion: 'success', app: { id: 5368905 } }));
const done = (name, o = {}) => actionCheck(name, { id: 80 + ACTIONS.indexOf(name), status: 'completed', conclusion: 'success', ...o });

function frontStatus(at) {
  const b = new StatusBoard({ clock: () => at });
  b.setState('IDLE');
  b.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  b.setPending([{ pr: 452, headSha: HEAD, baseSha: BASE, position: 1 }]);
  const facts = { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: new Date(at).toISOString(), onDuty: true, mainSha: BASE,
    rules: { strict: true, mergeOnly: true }, front: { claimId: 'c', pr: 452, headSha: HEAD }, wouldDo: 'FRONT_GREEN_WAIT_MERGE', wouldRevoke: [], wouldRevokeCount: 0 };
  b.update({ train: { enabled: 'shadow', last: JSON.parse(JSON.stringify(trainSummary(facts))) } });
  return parseStatus(Buffer.from(JSON.stringify(b.snapshot())));
}

// One reporter on the same fake GitHub as the lane; the lane's own line is what the PR page shows after the missing checks.
async function page(t, w, l) {
  const posts = [];
  w.extra = async argv => {
    const route = argv.find(a => a.startsWith('repos/')) ?? '';
    if (argv.includes('POST') && /\/statuses\/[0-9a-f]{40}$/.test(route)) { posts.push(argv.find(a => a.startsWith('description=')).slice('description='.length)); return { code: 0, stdout: '{}' }; }
    if (route.includes('/statuses?')) return { code: 0, stdout: '[]' };
    if (argv[4] === 'user') return { code: 0, stdout: 'o\n' };
    if (/\/commits\/[0-9a-f]{40}\/check-runs\?filter=latest&per_page=100&page=1$/.test(route)) return { code: 0, stdout: JSON.stringify({ total_count: w.checks.length, check_runs: w.checks }) };
    return null;
  };
  let now = Date.parse('2026-11-19T04:00:00Z');
  const reporter = new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    run: w.run, clock: () => now, store: await LocalStore.open(path.join(await tempRoot(t), 'store.json'), () => now), notifications: false, writeRequest: async () => {},
    rerunLine: sha => l.r.line(sha) });
  return async () => {
    now += 2 * 60_000;
    await reporter.pass({ pulls: [{ pr: 452, headSha: HEAD, eligible: true, hint: null, behindBy: 0 }], status: frontStatus(now) });
    return posts.at(-1);
  };
}

test('6be83331 E2 chain: late admission -> the lane re-runs both workflows -> the same reporter turns from missing checks to all green', async t => {
  const w = world({ checks: [nativeCheck(), ...resident()], rules: FULL_RULES,
    runs: [run(700, [attempt()]), run(701, [workflowAttempt('ci-suites-windows')], { workflow_id: WINDOWS_WORKFLOW })] });
  const l = await lane(t, w);
  const shown = await page(t, w, l);
  assert.match(await shown(), /缺 4 项：ci-suites（未出现）、clued-cloud-tests（未出现）、migration-verify（未出现）、ci-suites-windows（未出现）/, 'before the repair');
  await l.r.step();
  assert.deepEqual(w.posts, [700, 701], 'both gated workflows are re-run');
  // the Linux checks arrive; Windows is posted by the wrong App first: still missing, and the lane's own words follow
  w.checks.push(done('ci-suites'), done('clued-cloud-tests'), done('migration-verify'), done('ci-suites-windows', { app: { id: 9999 } }));
  let text = await shown();
  assert.match(text, /缺 1 项：ci-suites-windows（未出现）/);
  assert.match(text, /已自动补跑一次必需测试/);
  // the right App, but skipped
  w.checks.splice(w.checks.findIndex(c => c.name === 'ci-suites-windows'), 1, done('ci-suites-windows', { conclusion: 'skipped' }));
  assert.match(await shown(), /缺 1 项：ci-suites-windows（已跳过）/);
  // running, then green
  w.checks.splice(w.checks.findIndex(c => c.name === 'ci-suites-windows'), 1, done('ci-suites-windows', { status: 'in_progress', conclusion: null }));
  assert.match(await shown(), /缺 1 项：ci-suites-windows（进行中）/);
  w.checks.splice(w.checks.findIndex(c => c.name === 'ci-suites-windows'), 1, done('ci-suites-windows'));
  text = await shown();
  assert.match(text, /全部必需检查已绿，等合并/);
  assert.ok(!text.includes('缺 '), text);
});

test('6be83331 E2 chain: a refused dispatch of the Windows workflow shows with the missing check on the same PR page, once', async t => {
  const w = world({ runs: [run(700, [migrationAttempt(HEAD, 'success')])], checks: [nativeCheck(), ...resident(), done('ci-suites'), done('clued-cloud-tests'), done('migration-verify')],
    rules: FULL_RULES, dispatchCode: 1 });
  const l = await lane(t, w);
  const shown = await page(t, w, l);
  await l.r.step();
  l.advance(LOST_RUN_AFTER_MS);
  await l.r.step();
  l.advance(HEAD_RECHECK_MS);
  await l.r.step();
  assert.equal(w.calls.filter(call => call.method === 'POST').length, 1, 'tried once');
  const text = await shown();
  assert.match(text, /缺 1 项：ci-suites-windows（未出现）/);
  assert.match(text, /ci-suites-windows 没有运行，无法自动补发/);
});

test('R1: integration_id -1 (any source) is an unpinned rule in the shared reader; the lane does not pause for it', async t => {
  const anySource = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'extra-any', integration_id: -1 }] } };
  const rules = await readMainRequiredChecks(async () => [anySource]);
  assert.deepEqual(rules, [{ context: 'extra-any', integrationId: null }]);
  const w = world({ rules: [requiredRule(...CHECK_NAMES), anySource] });
  const l = await lane(t, w);
  const result = await l.r.step();
  assert.ok(!result.errors?.length, 'no read error');
  assert.deepEqual(w.posts, [700]);
  assert.doesNotMatch(l.r.line(HEAD) ?? '', /无法读取|已暂停/);
});

test('R3: a network failure reading the main rules is not reported until it lasts; a recovery restarts the clock', async t => {
  let failing = true;
  const w = world({ fail: target => failing && target.includes('/rules/branches/main') ? { code: 1, stdout: '', stderr: 'dial tcp: i/o timeout' } : null });
  const l = await lane(t, w);
  for (let i = 0; i < 3; i++) {
    const result = await l.r.step();
    assert.equal(result.errors.length, 1, 'still logged as a read error');
    assert.doesNotMatch(l.r.line(HEAD) ?? '', /无法读取|已暂停/, 'no PR words for a flap');
    l.advance(HEAD_RECHECK_MS);
  }
  assert.deepEqual(l.toasts, []);
  failing = false;
  l.advance(HEAD_RECHECK_MS);
  await l.r.step();
  assert.deepEqual(w.posts, [700], 'recovered: the repair goes ahead');
  // a new failing spell starts its own clock: 6 minutes more is still a flap, even though the two spells add up past the limit
  failing = true;
  w.runs.push(run(701, [workflowAttempt('ci-suites-windows')], { workflow_id: WINDOWS_WORKFLOW }));
  for (let i = 0; i < 3; i++) { l.advance(HEAD_RECHECK_MS); await l.r.step(); }
  assert.ok(l.toasts.every(x => !/无法读取/.test(x)), 'no toast about the rules');
  assert.doesNotMatch(l.r.line(HEAD) ?? '', /无法读取|已暂停/);
});

test('R3: a failure that lasts past RULES_UNREADABLE_REPORT_AFTER_MS says so on the PR line and tells the Owner once', async t => {
  const w = world({ fail: target => target.includes('/rules/branches/main') ? { code: 1, stdout: '', stderr: 'dial tcp: i/o timeout' } : null });
  const l = await lane(t, w);
  await l.r.step();
  for (let spent = 0; spent <= RULES_UNREADABLE_REPORT_AFTER_MS + 2 * HEAD_RECHECK_MS; spent += HEAD_RECHECK_MS) { l.advance(HEAD_RECHECK_MS); await l.r.step(); }
  assert.match(l.r.line(HEAD), /无法读取 main 必需检查规则/);
  assert.equal(l.toasts.filter(x => /无法读取 main 必需检查规则/.test(x)).length, 1);
});
