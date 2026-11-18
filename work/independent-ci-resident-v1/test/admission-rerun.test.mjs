// Generation 12 (DESIGN §56.5; Decision 207c0cd0 v2): the companion clicks the one repair re-run of the required tests with the Owner's
// gh login. Ported from the decision rules and cases of 76481044 (the unmerged workflow variant), over a scripted `gh api`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AdmissionRerunState, AdmissionRerunner, HEAD_RECHECK_MS, candidateHeads, decide, ghPort } from '../src/admission-rerun.mjs';
import { withRerunLine } from '../src/pr-status.mjs';
import { parseDutyStatus } from '../src/node-duty.mjs';
import { tempRoot } from './helpers.mjs';
import { gate, resolvePublicSupabaseConfig } from '../../../scripts/ci/clued-work-admission.mjs';
import { decideWithCurrentEpoch } from '../../../scripts/runner/clued-runner-job-started.mjs';
import { fileURLToPath } from 'node:url';

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
  st.gh = ghPort({ ghExe: 'C:\\gh.exe', repo: REPO, run: runFn });
  return st;
}
const T0 = Date.parse('2026-11-05T12:00:00Z');
const botRun = (overrides = {}) => run(700, [attempt({ notes: [] })], { actor: { login: 'clued-admission[bot]', type: 'Bot' }, ...overrides });
const status = (o = {}) => ({ node: { mode: 'ACTIVE' }, halt: null, current: null, pending: [{ pr: 452, headSha: HEAD, state: 'PARKED' }], recent: [], ...o });
const pulls = [{ pr: 452, headSha: HEAD }];

test('6be83331 E1: both gated PR runs are repaired independently with one receipt each', async t => {
  const ungated = { jobs: [workflowAttempt('lint').jobs[1]] };
  const w = world({ runs: [run(700, [attempt()]), run(701, [workflowAttempt('ci-suites-windows')], { workflow_id: WINDOWS_WORKFLOW }),
    run(702, [ungated], { workflow_id: 103 })],
    rules: [requiredRule('ci-suites', 'ci-suites-windows')] });
  const l = await lane(t, w);
  await l.r.step();
  assert.deepEqual(w.posts, [700, 701]);
  assert.deepEqual(Object.keys(l.state.data.records).sort(), ['700:2', '701:2']);
});

test('6be83331 E1: staging repairs each gated workflow on the bound staging SHA', async t => {
  const testSha = 'b'.repeat(40), staging = 'clued-train/staging';
  const subject = { head_sha: testSha, head_branch: staging, event: 'push', conclusion: 'failure' };
  const windows = workflowAttempt('ci-suites-windows');
  for (const job of windows.jobs) job.head_sha = testSha;
  const w = world({ runs: [run(700, [attempt({ head: testSha })], subject),
    run(701, [windows], { ...subject, workflow_id: WINDOWS_WORKFLOW })],
    rules: [requiredRule('ci-suites', 'ci-suites-windows')],
    fail: target => target.endsWith(`/git/ref/heads/${staging}`) ? { code: 0, stdout: JSON.stringify({
      ref: `refs/heads/${staging}`, object: { sha: testSha },
    }) } : null });
  const l = await lane(t, w, { st: status({ train: { enabled: 'on', landing: 'push' }, pending: [{ pr: 452, headSha: HEAD, testSha, state: 'PARKED' }] }) });
  await l.r.step();
  assert.deepEqual(w.posts, [700, 701]);
  assert.deepEqual(Object.values(l.state.data.records).map(r => [r.headSha, r.frontHeadSha]), [[testSha, HEAD], [testSha, HEAD]]);
});

test('6be83331 E3: a new Actions requirement keeps the head open and its workflow is repaired', async t => {
  const w = world({ runs: [run(700, [migrationAttempt(HEAD, 'success')])],
    checks: [nativeCheck(), actionCheck('ci-suites'), actionCheck('additional-check', { app: { id: 5368905 } })],
    rules: [requiredRule('ci-suites', 'additional-check')], workflows: [...WORKFLOWS, extraWorkflow] });
  const l = await lane(t, w);
  await l.r.step();
  assert.equal(l.state.data.heads[HEAD].final, null);
  w.runs.push(run(701, [workflowAttempt('additional-check')], { workflow_id: 102 }));
  l.advance(HEAD_RECHECK_MS);
  await l.r.step();
  assert.deepEqual(w.posts, [701]);
  w.runs[1].attempts[1] = workflowAttempt('additional-check');
  Object.assign(w.runs[1].attempts[1].jobs[1], { name: 'additional-check', conclusion: 'success' });
  w.runs[1].status = 'completed';
  w.checks.push(actionCheck('additional-check'));
  l.advance(HEAD_RECHECK_MS);
  await l.r.step();
  assert.ok(l.state.data.heads[HEAD].final);
});

test('6be83331 E3: missing or malformed main required-check rules stop mutations and report a read error', async t => {
  for (const rules of [[], [{ type: 'required_status_checks', parameters: {} }]]) {
    const w = world({ rules });
    const l = await lane(t, w);
    const result = await l.r.step();
    assert.match(result.errors[0].reason, /main required status checks are unreadable/);
    assert.match(withRerunLine({ description: '运行中' }, l.r.line(HEAD)).description, /无法读取 main 必需检查规则/);
    assert.deepEqual(w.calls.filter(c => c.method === 'POST'), []);
    assert.equal(l.state.data.heads[HEAD].final, null);
    l.advance(HEAD_RECHECK_MS);
    await l.r.step();
    assert.equal(l.toasts.length, 1);
    l.advance(2 * HEAD_RECHECK_MS);
    await l.r.step();
    assert.equal(l.toasts.length, 1);
    w.rules = [requiredRule(...CHECK_NAMES)];
    l.advance(3 * HEAD_RECHECK_MS);
    await l.r.step();
    assert.deepEqual(w.posts, [700]);
    assert.doesNotMatch(l.r.line(HEAD), /无法读取/);
  }
});

test('6be83331 E4: missing Windows workflow without a dispatch trigger is tried once and shown on the PR', async t => {
  const w = world({ runs: [run(700, [migrationAttempt(HEAD, 'success')])], checks: [nativeCheck(), actionCheck('ci-suites')],
    rules: [requiredRule('ci-suites', 'ci-suites-windows')], dispatchCode: 1 });
  const l = await lane(t, w);
  await l.r.step();
  l.advance(LOST_RUN_AFTER_MS);
  await l.r.step();
  const restarted = await lane(t, w, { stateFile: l.file });
  restarted.advance(LOST_RUN_AFTER_MS + HEAD_RECHECK_MS);
  await restarted.r.step();
  assert.deepEqual(w.calls.filter(call => call.method === 'POST').map(call => call.target),
    [`repos/${REPO}/actions/workflows/${WINDOWS_WORKFLOW}/dispatches`]);
  assert.equal(w.calls.filter(call => call.target.includes('/actions/workflows?')).length, 1);
  assert.equal(w.calls.filter(call => call.target.includes('/contents/')).length, 3);
  assert.match(withRerunLine({ description: '运行中' }, restarted.r.line(HEAD)).description,
    /ci-suites-windows 没有运行，无法自动补发/);
});

test('6be83331 E6: only required Actions workflows are repaired or reported', async t => {
  for (const hosted of [workflowAttempt('gitleaks'), { ...workflowAttempt('gitleaks'), notes: [otherNote] }]) {
    const windows = workflowAttempt('ci-suites-windows');
    windows.jobs[1].name = "${{ needs.admission-gate.outputs.admitted == 'true' && 'ci-suites-windows' || 'ci-suites-windows-skipped' }}";
    const rules = [requiredRule('ci-suites', 'ci-suites-windows'), { type: 'required_status_checks', parameters: {
      required_status_checks: [{ context: 'gitleaks', integration_id: 5368905 }],
    } }];
    const w = world({ rules, runs: [run(700, [attempt()]), run(701, [windows], { workflow_id: WINDOWS_WORKFLOW,
      path: `${WORKFLOWS[1].path}@refs/pull/452/merge` }), run(702, [hosted], { workflow_id: HOSTED_WORKFLOW })] });
    const l = await lane(t, w);
    await l.r.step();
    assert.deepEqual(w.posts, [700, 701]);
    assert.deepEqual(Object.keys(l.state.data.records).sort(), ['700:2', '701:2']);
    assert.equal(l.toasts.length, 2);
    assert.match(l.toasts[1], /已自动补跑 ci-suites-windows/);
    assert.doesNotMatch(l.toasts.join('\n'), /gitleaks/);
    assert.ok(!w.calls.some(call => call.target.includes('/actions/workflows?')));
  }
});

test('6be83331 E7: an unmapped requirement blocks every request and is reported once across restart', async t => {
  const w = world({ rules: [requiredRule('ci-suites', 'unmapped-check')] });
  const l = await lane(t, w);
  const result = await l.r.step();
  assert.deepEqual(w.posts, []);
  assert.match(result.errors[0].reason, /必需检查 unmapped-check 找不到对应工作流/);
  assert.match(withRerunLine({ description: '运行中' }, l.r.line(HEAD)).description, /必需检查 unmapped-check 找不到对应工作流/);
  l.advance(HEAD_RECHECK_MS);
  await l.r.step();
  assert.equal(l.toasts.length, 1);
  const restarted = await lane(t, w, { stateFile: l.file });
  restarted.advance(2 * HEAD_RECHECK_MS);
  await restarted.r.step();
  assert.deepEqual(restarted.toasts, []);
  assert.deepEqual(w.calls.filter(call => call.method === 'POST'), []);
  assert.equal(w.calls.filter(call => call.target.includes('/actions/workflows?')).length, 1);
});

test('6be83331 L1: a settled staging run does not wait for workflows absent from staging', async t => {
  const testSha = 'b'.repeat(40);
  const w = world({ runs: [run(700, [migrationAttempt(testSha, 'success')], { head_sha: testSha, head_branch: 'clued-train/staging', event: 'push', conclusion: 'success' })],
    rules: [requiredRule('ci-suites', 'ci-suites-windows')] });
  const l = await lane(t, w, { st: status({ train: { enabled: 'on', landing: 'push' }, pending: [{ pr: 452, headSha: HEAD, testSha, state: 'PARKED' }] }) });
  await l.r.step();
  assert.ok(l.state.data.heads[testSha].final);
  l.advance(HEAD_RECHECK_MS);
  await l.r.step();
  assert.equal(w.calls.filter(call => call.target.includes(`head_sha=${testSha}`)).length, 1);
  assert.deepEqual(w.posts, []);
});

test('6be83331 L3: the real workflows use the required-check naming convention', async () => {
  const { gatedCheckNames } = await import('../src/admission-rerun.mjs');
  const sources = await Promise.all(WORKFLOWS.map(w => readWorkflow(w.path)));
  const required = [...CHECK_NAMES, 'ci-suites-windows'].sort();
  for (const ending of ['\n', '\r\n']) {
    assert.deepEqual(sources.flatMap(source => gatedCheckNames(source.replace(/\r?\n/g, ending))).sort(), required);
  }
  for (const file of ['gitleaks', 'trivy', 'contract-placement']) {
    const checks = gatedCheckNames(await readWorkflow(`.github/workflows/${file}.yml`));
    assert.ok(checks.length);
    assert.deepEqual(checks.filter(name => required.includes(name)), []);
  }
});
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

test('E4: a proven migration timeout sends one repair, then the successful next attempt settles', async t => {
  const w = world({ runs: [run(700, [migrationAttempt()])] });
  const l = await lane(t, w);
  assert.equal((await l.r.step()).acted, 1);
  assert.deepEqual(l.state.record(HEAD).failures, [{ name: 'migration-verify', kind: 'timeout' }]);
  assert.match(withRerunLine({ description: '运行中' }, l.r.line(HEAD)).description, /^已自动补跑一次必需测试（migration-verify timeout，尝试 2）/);
  w.runs[0].attempts[1] = migrationAttempt(HEAD, 'success');
  w.runs[0].status = 'completed';
  l.advance(HEAD_RECHECK_MS);
  await l.r.step();
  assert.deepEqual(w.posts, [700]);
});

test('E5: a prior late-admission receipt only blocks its own attempt, including across restart', async t => {
  const w = world();
  const l = await lane(t, w);
  assert.equal((await l.r.step()).acted, 1);
  const legacy = JSON.parse(await fs.readFile(l.file, 'utf8'));
  const { requests, failures, ...receipt } = legacy.records['700:2'];
  legacy.records = { [HEAD]: receipt };
  await fs.writeFile(l.file, JSON.stringify(legacy));
  w.runs[0].attempts[1] = migrationAttempt();
  w.runs[0].status = 'completed';
  const restarted = await lane(t, w, { stateFile: l.file });
  restarted.advance(HEAD_RECHECK_MS);
  assert.equal((await restarted.r.step()).acted, 1);
  assert.deepEqual(w.posts, [700, 700]);
  const { records } = JSON.parse(await fs.readFile(l.file, 'utf8'));
  assert.deepEqual(Object.keys(records).sort(), ['700:2', '700:3']);
});

test('a final verdict persisted by the pre-timeout lane is checked again during the original watch window', async t => {
  const w = world({ runs: [run(700, [migrationAttempt()])] });
  const l = await lane(t, w);
  l.state.data.heads[HEAD] = { firstSeen: new Date(T0).toISOString(), final: 'attempt 2 already ran a heavy job', skippedRecoveryChecked: true };
  await l.state.save();
  const restarted = await lane(t, w, { stateFile: l.file });
  assert.equal((await restarted.r.step()).acted, 1);
});

test('E6: two timeouts on three other heads pause once; a subsequent success resumes', async t => {
  const others = [1, 2, 3].map((n, i) => {
    const head = String(n).repeat(40);
    return run(703 - i, [migrationAttempt(head, i < 2 ? 'cancelled' : 'success', `2026-11-05T10:5${9 - i}:00Z`)], { head_sha: head });
  });
  const w = world({ runs: [run(700, [migrationAttempt()]), ...others] });
  const l = await lane(t, w);
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'skip');
  await l.r.step();
  const restarted = await lane(t, w, { stateFile: l.file });
  restarted.advance(HEAD_RECHECK_MS);
  await restarted.r.step();
  assert.deepEqual(w.posts, []);
  assert.match(l.toasts[0], /migration-verify 系统性超时/);
  assert.deepEqual(restarted.toasts, []);
  const recovered = '4'.repeat(40);
  w.runs.push(run(704, [migrationAttempt(recovered, 'success', '2026-11-05T12:01:00Z')], { head_sha: recovered }));
  restarted.advance(HEAD_RECHECK_MS);
  assert.equal((await restarted.r.step()).acted, 1);
  assert.deepEqual(w.posts, [700]);
});

test('an inconclusive POST is retried once after ten minutes if the same attempt is still completed', async t => {
  let requests = 0;
  const w = world({ fail: (_, method) => {
    if (method !== 'POST') return null;
    requests += 1;
    return { timedOut: true };
  } });
  const l = await lane(t, w);
  assert.equal((await l.r.step()).acted, 1);
  l.advance(9 * 60_000);
  await l.r.step();
  assert.equal(requests, 1);
  const restarted = await lane(t, w, { stateFile: l.file });
  restarted.advance(11 * 60_000);
  assert.equal((await restarted.r.step()).acted, 1);
  restarted.advance(11 * 60_000);
  await restarted.r.step();
  assert.equal(requests, 2);
});

test('a second repair waits for the same job to succeed on another head after the last attempt ended; a third is refused', async () => {
  const recent = migrationAttempt(HEAD, 'cancelled', '2026-11-05T11:30:00Z');
  const w = world({ runs: [run(700, [migrationAttempt(), recent])] });
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'skip');
  const other = '5'.repeat(40);
  w.runs.push(run(701, [migrationAttempt(other, 'success', '2026-11-05T11:29:00Z')], { head_sha: other }));
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'skip');
  w.runs[1].attempts.push(migrationAttempt(other, 'success', '2026-11-05T11:31:00Z'));
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'rerun');
  w.runs[0].attempts.push(migrationAttempt());
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'final');
});

test('three proven environmental failures stop the lane and notify the Owner once', async t => {
  const w = world({ runs: [run(700, [migrationAttempt(), migrationAttempt(), migrationAttempt()])] });
  const l = await lane(t, w);
  assert.equal((await l.r.step()).acted, 0);
  assert.match(l.toasts[0], /三次环境类失败.*migration-verify timeout/);
  const restarted = await lane(t, w, { stateFile: l.file });
  await restarted.r.step();
  assert.deepEqual(restarted.toasts, []);
  assert.deepEqual(w.posts, []);
});
async function lane(t, w, { st = status(), stateFile = null } = {}) {
  let now = T0;
  const toasts = [];
  const file = stateFile ?? path.join(await tempRoot(t), 'rerun.json');
  const state = await AdmissionRerunState.open(file, () => now);
  const r = new AdmissionRerunner({ gh: w.gh, state, clock: () => now, readStatus: async () => ({ ...st, writtenAt: now }), pulls: () => pulls, notify: async (k, title) => toasts.push(title) });
  return { r, state, toasts, file, advance: ms => { now += ms; } };
}

test('N9: a live push-mode front offers S to the repair lane before and during parking', () => {
  const testSha = 'b'.repeat(40);
  const train = { enabled: 'on', landing: 'push' };
  const front = { ...pulls[0], testSha, state: 'PARKED', deferred: 'TRAIN_LANDING_CHECKS_PENDING' };
  const candidates = overrides => candidateHeads(status({ writtenAt: T0, train, pending: [front], ...overrides }), pulls, T0);
  assert.deepEqual(candidates({}), [{ ...pulls[0], testSha }, pulls[0]]);
  assert.deepEqual(candidates({ pending: [{ ...front, state: 'RUNNING', deferred: null }] }), [{ ...pulls[0], testSha }, pulls[0]]);
  assert.deepEqual(candidates({ pending: [{ ...front, state: 'QUEUED', deferred: null }] }), [{ ...pulls[0], testSha }, pulls[0]]);
  assert.deepEqual(candidates({ train: { ...train, landing: 'github-merge' } }), pulls);
  assert.deepEqual(candidates({ train: { ...train, notOnDuty: true } }), pulls);
  assert.deepEqual(candidates({ pending: [{ ...front, state: 'STOPPED' }] }), pulls);
  assert.deepEqual(candidates({ pending: [{ ...front, testSha: HEAD }] }), pulls);
  assert.deepEqual(candidates({ pending: [{ ...front, headSha: 'c'.repeat(40) }] }), []);
});

test('N9: staging waits for recovery before requesting its second repair and retains both receipts across restart', async t => {
  const testSha = 'b'.repeat(40), staging = 'clued-train/staging';
  const staged = run(700, [migrationAttempt(testSha)], { head_sha: testSha, head_branch: staging, event: 'push',
    conclusion: 'cancelled', pull_requests: [] });
  const w = world({ runs: [staged, run(701, [migrationAttempt(HEAD, 'success')])], fail: target =>
    target.endsWith(`/git/ref/heads/${staging}`)
      ? { code: 0, stdout: JSON.stringify({ ref: `refs/heads/${staging}`, object: { sha: testSha } }) } : null });
  const st = status({ train: { enabled: 'on', landing: 'push' }, pending: [{ ...pulls[0], testSha, state: 'PARKED' }] });
  const l = await lane(t, w, { st });
  assert.equal((await l.r.step()).acted, 1);
  assert.deepEqual(w.posts, [700]);
  staged.attempts[1] = migrationAttempt(testSha, 'cancelled', '2026-11-05T11:30:00Z');
  staged.status = 'completed';
  const restarted = await lane(t, w, { st, stateFile: l.file });
  restarted.advance(HEAD_RECHECK_MS);
  assert.equal((await restarted.r.step()).acted, 0);
  const other = 'c'.repeat(40);
  w.runs.push(run(702, [migrationAttempt(other, 'success', '2026-11-05T11:31:00Z')], { head_sha: other }));
  restarted.advance(HEAD_RECHECK_MS);
  assert.equal((await restarted.r.step()).acted, 1);
  assert.deepEqual(w.posts, [700, 700]);
  assert.deepEqual(Object.keys(restarted.state.data.records).sort(), ['700:2', '700:3']);
  assert.match(restarted.r.line(HEAD), /列车暂存提交，migration-verify timeout，尝试 3/);
  assert.deepEqual(w.dispatches, []);
});

test('allowed: one "Re-run all jobs", a receipt written before it, the PR page and the Owner told; never a second one', async t => {
  const w = world();
  const l = await lane(t, w);
  const order = [];
  const save = l.state.save.bind(l.state);
  l.state.save = async () => { order.push(['save', l.state.record(HEAD)?.outcome ?? null, w.posts.length]); return save(); };
  assert.deepEqual(await l.r.step(), { acted: 1, looked: 1 });
  assert.deepEqual(w.posts, [700]);
  assert.deepEqual(order.slice(0, 1), [['save', 'intent', 0]], 'the intent is on disk before the request');
  const rec = JSON.parse(await fs.readFile(l.file, 'utf8')).records['700:2'];
  assert.deepEqual([rec.contract, rec.pr, rec.runId, rec.attempt, rec.outcome], ['clued.independent-ci.admission-rerun/1', 452, 700, 2, 'sent']);
  assert.equal(l.r.done(HEAD), true);
  assert.deepEqual(l.toasts, [`PR #452：已自动补跑 ${CHECK_NAMES.join('、')}`]);
  for (let i = 0; i < 5; i++) { l.advance(HEAD_RECHECK_MS); await l.r.step(); }
  assert.deepEqual(w.posts, [700], 'never twice');
  // a restarted companion reads the record back
  const again = await lane(t, w, { stateFile: l.file });
  await again.r.step();
  assert.deepEqual(w.posts, [700]);
  assert.equal(again.r.done(HEAD), true);
});

test('bot head: admitted gate with skipped heavy jobs dispatches once, persists and explains the recovery', async t => {
  const w = world({ runs: [botRun()] });
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'redispatch');
  const l = await lane(t, w);
  await l.r.step();
  assert.deepEqual(w.dispatchFields, ['ref=claude/x', 'inputs[pr]=452', `inputs[head]=${HEAD}`]);
  assert.deepEqual(w.posts, []);
  assert.equal(l.r.line(HEAD), '必需测试被跳过（推送者非 Owner），已自动补发一次');
  assert.equal(l.toasts.length, 1);
  l.advance(HEAD_RECHECK_MS); await l.r.step();
  const restarted = await lane(t, w, { stateFile: l.file });
  await restarted.r.step();
  assert.equal(w.dispatches.length, 1);
  assert.equal(restarted.r.line(HEAD), l.r.line(HEAD));
});

test('bot head: refused dispatch stays visible and tells Owner once without retry', async t => {
  const w = world({ runs: [botRun()], dispatchCode: 422 });
  const l = await lane(t, w);
  await l.r.step();
  assert.equal(w.dispatches.length, 1);
  assert.equal(l.r.line(HEAD), `${CHECK_NAMES.join('、')} 没有运行，无法自动补发`);
  assert.equal(l.toasts.length, 1);
  l.advance(HEAD_RECHECK_MS); await l.r.step();
  const restarted = await lane(t, w, { stateFile: l.file }); await restarted.r.step();
  assert.equal(w.dispatches.length, 1);
  assert.equal(l.toasts.length + restarted.toasts.length, 1);
  assert.ok(!w.calls.some(call => call.target.includes('/actions/workflows?')));
});

test('skipped head: final repair refusal is visible and tells Owner once across restarts', async t => {
  const w = world({ runs: [run(700, [attempt({ notes: [otherNote] })])] });
  const l = await lane(t, w);
  await l.r.step();
  assert.match(l.r.line(HEAD), /必需测试被跳过且不能自动补跑：.*请推新提交或手动 Run workflow/);
  assert.equal(l.toasts.length, 1);
  l.advance(HEAD_RECHECK_MS); await l.r.step();
  const restarted = await lane(t, w, { stateFile: l.file }); await restarted.r.step();
  assert.equal(restarted.r.line(HEAD), l.r.line(HEAD));
  assert.equal(l.toasts.length + restarted.toasts.length, 1);
  assert.deepEqual(w.posts, []); assert.deepEqual(w.dispatches, []);
});

test('bot head: a legacy silent final is reconsidered once without resetting its watch window', async t => {
  const w = world({ runs: [botRun()] }); const l = await lane(t, w);
  l.state.data.heads[HEAD] = { firstSeen: new Date(T0).toISOString(), lookedAt: null, final: 'old repair refusal' };
  await l.state.save(); await l.r.step();
  assert.equal(w.dispatches.length, 1);
  assert.equal(l.state.data.heads[HEAD].firstSeen, new Date(T0).toISOString());
});

test('skipped head: admitted non-automation gate log also selects dispatch for a non-Bot actor', async () => {
  const a = attempt({ notes: [] }); a.logs = { 0: '{"admitted":true,"verdict":"ADMITTED","automation_self_hosted":false}' };
  const w = world({ runs: [run(700, [a], { actor: { login: 'someone', type: 'User' } })] });
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'redispatch');
  a.logs[0] = '{"verdict":"ADMITTED","automation_self_hosted":true}';
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'final');
});

test('bot head: earlier refused rerun may dispatch, but any earlier heavy execution prevents it', async () => {
  const w = world({ runs: [botRun({ attempts: [attempt({ notes: [] }), attempt({ notes: [otherNote] })] })] });
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'redispatch');
  w.runs[0].attempts[0].jobs[1].conclusion = 'success';
  const d = await decide({ gh: w.gh, headSha: HEAD });
  assert.equal(d.action, 'final'); assert.equal(d.neverRan, false);
});

test('bot head: every event is checked; prior dispatch, push, active run and missing jobs prevent another dispatch', async () => {
  for (const extra of [
    run(650, [attempt()], { event: 'workflow_dispatch' }),
    run(650, [attempt()], { event: 'push' }),
    run(650, [attempt()], { status: 'queued' }),
    run(650, [{ jobs: [], notes: [] }]),
    run(650, [attempt({ heavy: ['success', 'skipped', 'skipped'] })], { event: 'workflow_dispatch' }),
  ]) {
    const w = world({ runs: [botRun(), extra] });
    assert.ok(['final', 'skip', 'error'].includes((await decide({ gh: w.gh, headSha: HEAD })).action));
  }
});

test('bot head: moved PR, new run or changed attempt at final read sends nothing', async () => {
  for (const change of ['pr', 'run', 'attempt']) {
    let reads = 0;
    const w = world({ runs: [botRun()], fail: (route, method, st) => {
      if (change === 'pr' && route.endsWith('/pulls/452')) return { code: 0, stdout: JSON.stringify(pullRequest({ state: 'closed' })) };
      if (route.includes(`/actions/runs?head_sha=${HEAD}`) && ++reads === 2) {
        if (change === 'run') st.runs.push(run(900, [attempt()], { status: 'queued' }));
        if (change === 'attempt') st.runs[0].attempts.push(attempt());
      }
      return null;
    } });
    assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'skip', change);
    assert.deepEqual(w.dispatches, []);
  }
});

test('bot head: a truncated job inventory is unknown and never permits dispatch', async () => {
  const w = world({ runs: [botRun()], fail: route => route.includes('/attempts/1/jobs')
    ? { code: 0, stdout: JSON.stringify({ total_count: 5, jobs: attempt().jobs }) } : null });
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'error');
  assert.deepEqual(w.dispatches, []);
});

test('G3: the lost-run request binds the open PR and exact head, and cannot dispatch an unadmitted head', async t => {
  const w = world({ runs: [] });
  const l = await lane(t, w);
  await l.r.step(); l.advance(LOST_RUN_AFTER_MS); await l.r.step();
  assert.deepEqual(w.dispatchFields, ['ref=claude/x', 'inputs[pr]=452', `inputs[head]=${HEAD}`]);
  const denied = world({ runs: [], checks: [nativeCheck({ conclusion: 'failure' })] });
  assert.notEqual((await decide({ gh: denied.gh, headSha: HEAD, headAgeMs: LOST_RUN_AFTER_MS })).action, 'redispatch');
});

test('G3 end-to-end: no push run -> one durable dispatch -> original PR gate and runner epoch -> three checks on the same head', async t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const publicConfig = resolvePublicSupabaseConfig({}, root);
  const configuration = await fs.readFile(path.join(root, 'apps/clued-cloud/app/supabase-public-config.ts'), 'utf8');
  const workflow = await fs.readFile(path.join(root, '.github/workflows/clued-required-tests.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/, 'GitHub accepts this event');
  const executed = [];
  let pr = pullRequest({ base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: REPO, default_branch: 'main' } } });
  let epochCurrent = true;
  const w = world({ runs: [], pulls: [pr], onDispatch: async st => {
    const fields = Object.fromEntries(st.dispatchFields.map(field => { const at = field.indexOf('='); return [field.slice(0, at), field.slice(at + 1)]; }));
    const event = { inputs: { pr: fields['inputs[pr]'], head: fields['inputs[head]'] }, repository: { default_branch: 'main' } };
    const self = { id: 900, event: 'workflow_dispatch', path: '.github/workflows/clued-required-tests.yml', head_sha: HEAD,
      head_branch: fields.ref, run_attempt: 1, created_at: new Date(T0).toISOString() };
    const environment = { GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_OWNER: 'o', GITHUB_ACTOR: 'o',
      GITHUB_RUN_ID: '900', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: HEAD, GITHUB_REF: `refs/heads/${fields.ref}`,
      GITHUB_REF_NAME: fields.ref, GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/clued-required-tests.yml@refs/heads/${fields.ref}`,
      GITHUB_TOKEN: 'test-only', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: '/fixture-event', GITHUB_WORKSPACE: root,
      CLUED_ADMISSION_GATE_SOURCE: 'independent-ci-native-work-admission', CLUED_ADMISSION_GATE_WAIT_SECONDS: '0',
      CLUED_RUNNER_HOOK_REPOSITORY: REPO, CLUED_RUNNER_HOOK_TOKEN_FILE: '/fixture-token' };
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(url), route = u.pathname, input = init.body ? JSON.parse(init.body)?.p_input : null;
      let body;
      if (u.origin === publicConfig.url && input?.action === 'execution_current') {
        assert.deepEqual([input.head_sha, input.pr_ref, input.target_branch], [HEAD, 'o/r#452', 'main']);
        body = { status: 'ok', guard_required: true, epoch_current: epochCurrent };
      } else if (route.endsWith('/pulls/452')) body = pr;
      else if (route.endsWith('/actions/runs/900')) body = self;
      else if (route.endsWith('/clued-required-tests.yml/runs')) body = { total_count: 1, workflow_runs: [self] };
      else if (route.endsWith('/check-runs')) body = { total_count: st.checks.length, check_runs: st.checks };
      else if (route.endsWith('/contents/.github/workflows')) body = [{ type: 'file', path: '.github/workflows/clued-required-tests.yml', sha: 'c'.repeat(40) }];
      else if (route.endsWith('/contents/apps/clued-cloud/app/supabase-public-config.ts')) body = { type: 'file', encoding: 'base64', content: Buffer.from(configuration).toString('base64') };
      else assert.fail(`unexpected recovery read ${route}`);
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const admitted = await gate({ env: environment, event, eventName: 'workflow_dispatch', fetchImpl });
    assert.equal(admitted.admitted, true);
    const start = () => decideWithCurrentEpoch({ env: environment, fetchImpl,
      readFile: p => p === '/fixture-token' ? 'test-only' : JSON.stringify(event) });
    for (const check of ['clued-cloud-tests', 'ci-suites', 'migration-verify']) {
      assert.equal((await start()).allow, true);
      executed.push({ check, head: self.head_sha });
    }
    epochCurrent = false;
    assert.equal((await start()).allow, false, 'a later handover still prevents execution');
    epochCurrent = true;
    pr = { ...pr, head: { ...pr.head, sha: 'd'.repeat(40) } };
    assert.equal((await start()).allow, false, 'a moved head cannot reuse gate outputs');
  } });
  const l = await lane(t, w);
  await l.r.step(); l.advance(LOST_RUN_AFTER_MS); await l.r.step();
  assert.equal(l.state.record(HEAD).outcome, 'sent');
  assert.equal(executed.length, 3);
  assert.ok(executed.every(item => item.head === HEAD));
  await l.r.step();
  assert.equal(w.dispatches.length, 1);
});

test('network cut on the request: every outcome but sent is recorded as what it is, the Owner told once, never clicked again', async t => {
  const cases = [
    [() => ({ code: 1, stdout: '', stderr: 'connection reset by peer' }), 'unknown', 'PR #452：自动补跑结果不确定'],
    [() => ({ code: null, timedOut: true, stdout: '' }), 'unknown', 'PR #452：自动补跑结果不确定'],
    [() => ({ code: null, stdout: '', refused: 'JOB_HOST_UNCONFIRMED', tree: 'unconfirmed' }), 'unknown', 'PR #452：自动补跑结果不确定'],
    [() => ({ code: null, stdout: '', refused: 'RUNNER_SPAWN_FAILED' }), 'unsent', 'PR #452：自动补跑没有发出'],
    [() => ({ code: null, stdout: '', refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' }), 'unsent', 'PR #452：自动补跑没有发出'],
    [() => 'throw', 'unsent', 'PR #452：自动补跑没有发出'],
    [() => ({ code: 1, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)' }), 'refused', 'PR #452：自动补跑被 GitHub 拒绝'],
  ];
  for (const [fail, outcome, toast] of cases) {
    const w = world({ fail: (route, method) => (method === 'POST' ? fail() : null) });
    const l = await lane(t, w);
    await l.r.step();
    assert.equal(l.state.record(HEAD).outcome, outcome, toast);
    assert.equal(l.r.done(HEAD), false, 'the PR page does not claim a re-run');
    assert.deepEqual(l.toasts, [toast]);
    const posts = w.calls.filter(c => c.method === 'POST').length;
    for (let i = 0; i < 4; i++) { l.advance(HEAD_RECHECK_MS); await l.r.step(); }
    assert.equal(w.calls.filter(c => c.method === 'POST').length, posts, 'a failed request is never repeated');
  }
});

test('network cut on the reads: nothing is clicked; the head is read again later and clicked once', async t => {
  let down = true;
  const w = world({ fail: (route, method) => (down && method === 'GET' && route.includes('/actions/') ? { code: 1, stdout: '' } : null) });
  const l = await lane(t, w);
  const result = await l.r.step();
  assert.equal(result.acted, 0);
  assert.match(result.errors[0].reason, /GET \/actions\/runs.*failed/);
  assert.deepEqual(w.posts, []);
  assert.equal(l.state.record(HEAD), null);
  await l.r.step();
  assert.equal(w.calls.filter(c => c.method === 'GET').length > 0, true);
  const reads = w.calls.length;
  await l.r.step();
  assert.equal(w.calls.length, reads, 'not read again before HEAD_RECHECK_MS');
  down = false;
  l.advance(HEAD_RECHECK_MS);
  await l.r.step();
  assert.deepEqual(w.posts, [700]);
});

test('a crash between the intent and the answer: the intent alone stops any later request', async t => {
  const w = world();
  const l = await lane(t, w);
  l.state.data.records[HEAD] = { contract: 'clued.independent-ci.admission-rerun/1', pr: 452, headSha: HEAD, runId: 700, attempt: 2, outcome: 'intent', at: new Date(T0).toISOString(), why: null };
  await l.state.save();
  const again = await lane(t, w, { stateFile: l.file });
  await again.r.step();
  assert.deepEqual(w.posts, []);
});

test('the receipt cannot be written, or the memory file cannot be read: nothing is clicked', async t => {
  const w = world();
  const l = await lane(t, w);
  l.state.save = async () => { throw new Error('disk full'); };
  assert.equal((await l.r.step()).reason, 'ADMISSION_RERUN_STATE_UNSAVED');
  assert.deepEqual(w.posts, []);
  const root = await tempRoot(t);
  const dir = path.join(root, 'state-as-dir');
  await fs.mkdir(dir);
  const broken = await lane(t, world(), { stateFile: dir });
  assert.equal((await broken.r.step()).reason, 'ADMISSION_RERUN_STATE_UNREADABLE');
});

test('a memory file of the wrong shape is unreadable, never an empty memory; the Owner is told once; read again until it is right', async t => {
  const good = { contract: 'clued.independent-ci.admission-rerun-state/1', heads: {}, records: {} };
  const bad = [{}, null, [], { ...good, contract: 'clued.independent-ci.admission-rerun-state/2' }, { ...good, records: [] }, { ...good, heads: [] },
    { ...good, extra: 1 }, { ...good, records: { [HEAD]: { headSha: HEAD, outcome: 'maybe', at: new Date(T0).toISOString() } } },
    { ...good, records: { [HEAD]: { headSha: 'b'.repeat(40), outcome: 'sent', at: new Date(T0).toISOString() } } }];
  for (const v of bad) {
    const file = path.join(await tempRoot(t), 'rerun.json');
    await fs.writeFile(file, JSON.stringify(v));
    const w = world();
    const l = await lane(t, w, { stateFile: file });
    assert.equal((await l.r.step()).reason, 'ADMISSION_RERUN_STATE_UNREADABLE', JSON.stringify(v));
    await l.r.step();
    assert.deepEqual(w.posts, []);
    assert.deepEqual(l.toasts, ['自动补跑已暂停'], 'told once');
    // fixed by hand: the next step reads it and goes on
    await fs.writeFile(file, JSON.stringify(good));
    l.advance(HEAD_RECHECK_MS);
    await l.r.step();
    assert.deepEqual(w.posts, [700]);
  }
  const file = path.join(await tempRoot(t), 'rerun.json');
  await fs.writeFile(file, 'not json');
  assert.equal((await AdmissionRerunState.open(file)).unreadableCode, 'STATE_SHAPE_REFUSED');
});

test('the 12-hour window holds while the head stays a candidate: it is not reset when the memory is saved', async t => {
  const w = world({ fail: (route, method) => (method === 'GET' && route.includes('/actions/') ? { code: 1, stdout: '' } : null) });
  const l = await lane(t, w);
  let decided = 0;
  // within the 24 hours an entry is kept, the head is looked at for its first 12 only (every 2 minutes)
  for (let i = 0; i < 23 * 30; i++) { const n = w.calls.length; await l.r.step(); if (w.calls.length > n) decided++; l.advance(2 * 60_000); }
  assert.ok(decided <= 12 * 30 + 1, `looked at ${decided} times in 23 hours`);
  assert.ok(Object.keys(l.state.data.heads).includes(HEAD), 'the entry stays while the head is a candidate');
  const gone = new AdmissionRerunner({ gh: w.gh, state: l.state, clock: () => T0, readStatus: async () => status({ pending: [], writtenAt: T0 }), pulls: () => pulls, notify: async () => {} });
  await gone.step();
  assert.deepEqual(Object.keys(l.state.data.heads), [], 'no longer a candidate: its entry goes');
});

test('refusals that end the head for good: a heavy job already ran (this run, an earlier attempt, another run), the gate refused for another reason', async t => {
  const cases = [
    { runs: [run(700, [attempt({ heavy: ['success', 'skipped', 'skipped'] })])] },
    { runs: [run(700, [attempt(), attempt({ heavy: ['failure', 'skipped', 'skipped'] })])] },
    { runs: [run(700, [attempt()]), run(650, [attempt({ heavy: ['success', 'success', 'success'] })], { pull_requests: [{ number: 452 }] })] },
    { runs: [run(700, [attempt({ notes: [otherNote] })])] },
  ];
  for (const c of cases) {
    const w = world(c);
    assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'final', JSON.stringify(c.runs.map(r => r.id)));
    assert.deepEqual(w.posts, []);
  }
  // a gate that stopped on a GitHub outage ran nothing: allowed
  assert.equal((await decide({ gh: world({ runs: [run(700, [attempt({ notes: [outageNote] })])] }).gh, headSha: HEAD })).action, 'rerun');
});

test('refusals for now: an attempt queued or running, no admission yet (or another App, not bound, failed), no open PR, a fork, another base', async t => {
  const now = [
    { runs: [run(700, [attempt()], { status: 'in_progress' })] },
    { checks: [] },
    { checks: [nativeCheck({ status: 'in_progress', conclusion: null })] },
    { checks: [nativeCheck({ app: { id: 1 } })] },
    { checks: [nativeCheck({ external_id: 'something-else' })] },
    { checks: [nativeCheck({ output: { summary: 'for o/r#999' } })] },
    { checks: [nativeCheck({ conclusion: 'failure' })] },
    { pulls: [] },
    { pulls: [pullRequest({ state: 'closed' })] },
    { pulls: [pullRequest({ head: { sha: HEAD, repo: { full_name: 'fork/r' } } })] },
    { pulls: [pullRequest({ base: { ref: 'dev', repo: { full_name: REPO } } })] },
    { runs: [] },
    { runs: [run(700, [attempt()], { event: 'push' })] },
  ];
  for (const c of now) {
    const w = world(c);
    const d = await decide({ gh: w.gh, headSha: HEAD });
    assert.equal(d.action, 'skip', JSON.stringify(c));
    assert.deepEqual(w.posts, []);
  }
});

test('the pull request or the run changes right before the request: nothing is clicked', async t => {
  let reads = 0;
  const moved = world({ fail: (route) => (route.endsWith('/pulls/452') ? { code: 0, stdout: JSON.stringify(pullRequest({ head: { sha: 'b'.repeat(40), repo: { full_name: REPO } } })) } : null) });
  assert.equal((await decide({ gh: moved.gh, headSha: HEAD })).action, 'skip');
  const rerunBySomeone = world({ fail: (route, method, st) => { if (route.endsWith('/actions/runs/700') && ++reads) return { code: 0, stdout: JSON.stringify({ id: 700, head_sha: HEAD, status: 'queued', run_attempt: 2 }) }; return null; } });
  assert.equal((await decide({ gh: rerunBySomeone.gh, headSha: HEAD })).action, 'skip');
});

test('only an ACTIVE node, only the heads it ran or queued, never under HALT', async t => {
  const at = o => status({ writtenAt: T0, ...o });
  assert.deepEqual(candidateHeads(at(), pulls, T0), [{ pr: 452, headSha: HEAD }]);
  assert.deepEqual(candidateHeads(at({ node: { mode: 'STANDBY' } }), pulls, T0), []);
  assert.deepEqual(candidateHeads(at({ halt: { code: 'X' } }), pulls, T0), []);
  assert.deepEqual(candidateHeads(at({ pending: [] }), pulls, T0), [], 'a head this node never touched');
  assert.deepEqual(candidateHeads(at({ pending: [], recent: [{ pr: 452, headSha: HEAD, outcome: 'COMPLETED' }] }), pulls, T0), [{ pr: 452, headSha: HEAD }]);
  // review round 10: a status older than STATUS_STALE_MS (or with no time) proves nothing about the role
  assert.deepEqual(candidateHeads(at(), pulls, T0 + 5 * 60_000), [{ pr: 452, headSha: HEAD }]);
  assert.deepEqual(candidateHeads(at(), pulls, T0 + 5 * 60_000 + 1), []);
  assert.deepEqual(candidateHeads(status(), pulls, T0), []);
  assert.deepEqual(candidateHeads(at(), null, T0), [], 'no poller pass yet');
  const w = world();
  const l = await lane(t, w, { st: status({ node: { mode: 'STANDBY' } }) });
  await l.r.step();
  assert.deepEqual(w.calls, []);
});

test('the gh port: fixed argv, the routes it builds, paging; a non-zero exit or bad JSON is unreadable', async () => {
  const seen = [];
  const gh = ghPort({ ghExe: 'C:\\gh.exe', repo: REPO, run: async (argv) => { seen.push(argv); return /&page=1$/.test(argv.at(-1)) ? { code: 0, stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => i)) } : { code: 0, stdout: '[1]' }; } });
  assert.equal((await gh.paged('/check-runs/5/annotations')).length, 101);
  assert.deepEqual(seen[0].slice(0, 6), ['C:\\gh.exe', 'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json']);
  assert.equal(seen[1].at(-1), `repos/${REPO}/check-runs/5/annotations?per_page=100&page=2`);
  const bad = ghPort({ ghExe: 'C:\\gh.exe', repo: REPO, run: async () => ({ code: 0, stdout: 'not json' }) });
  await assert.rejects(bad.get('/pulls/1'));
  await assert.rejects(ghPort({ ghExe: 'C:\\gh.exe', repo: REPO, run: async () => ({ code: 1 }) }).get('/pulls/1'));
  assert.throws(() => ghPort({ ghExe: 'gh', repo: REPO, run: async () => ({}) }), { code: 'ADMISSION_RERUN_CONFIG_INVALID' });
  await assert.rejects(gh.get('/../x'), { code: 'ADMISSION_RERUN_ROUTE_REFUSED' });
});

test('the PR page says the required tests were re-run once, in the base text: the duty word another node reads stays first', () => {
  const want = { state: 'success', description: '已完成：常驻执行器跑完八段，检查已发布', kind: 'result' };
  assert.deepEqual(withRerunLine(want, true), { ...want, description: '已自动补跑一次必需测试；已完成：常驻执行器跑完八段，检查已发布' });
  assert.equal(withRerunLine(want, false), want);
  assert.equal(withRerunLine(null, true), null);
  assert.equal(withRerunLine({ ...want, weak: true }, true).description, want.description, 'a generic text gets none');
  // the reporter applies it to describe's text; NodeDuty then prefixes the duty word
  const base = withRerunLine({ state: 'pending', description: '运行中：第 3 段（扫描）' }, true);
  for (const word of ['当班', '已交班', '双活停机']) {
    const s = { login: 'owner', context: 'resident-queue/node-b (info only)', created_at: '2026-11-05T12:00:00Z', description: `${word}：${base.description}` };
    assert.equal(parseDutyStatus(s, 'owner')?.word, word, word);
  }
});

test('earlier re-runs by hand that ran nothing still leave the one automatic repair, as the gate itself allows', async t => {
  const refused = { title: 'admission-gate', message: 'RERUN_REFUSED: run attempt 2: not settled; this re-run did not run the heavy jobs.' };
  const w = world({ runs: [run(700, [attempt(), attempt({ notes: [refused] })])] });
  const d = await decide({ gh: w.gh, headSha: HEAD });
  assert.deepEqual([d.action, d.runId, d.attempt], ['rerun', 700, 2]);
  const l = await lane(t, w);
  await l.r.step();
  assert.deepEqual(w.posts, [700]);
  assert.equal(l.state.record(HEAD).attempt, 3);
});

test('a run or an attempt with a job of another head is unreadable: nothing is clicked', async t => {
  for (const runs of [[run(700, [attempt({ head: 'c'.repeat(40) })])], [run(700, [attempt(), attempt({ head: 'c'.repeat(40) })])]]) {
    const w = world({ runs });
    const d = await decide({ gh: w.gh, headSha: HEAD });
    assert.ok(['error', 'final'].includes(d.action), d.action);
    assert.deepEqual(w.posts, []);
  }
});

test('review round 4: a companion start, a STANDBY spell or a HALT never resets the window or forgets a final verdict', async t => {
  const w = world({ runs: [run(700, [attempt({ heavy: ['success', 'skipped', 'skipped'] })])],
    checks: [nativeCheck(), ...CHECK_NAMES.map(name => actionCheck(name))] });
  let st = status(), list = pulls;
  let now = T0;
  const state = await AdmissionRerunState.open(path.join(await tempRoot(t), 'rerun.json'), () => now);
  const r = new AdmissionRerunner({ gh: w.gh, state, clock: () => now, readStatus: async () => ({ ...st, writtenAt: now }), pulls: () => list, notify: async () => {} });
  await r.step();
  const first = { ...state.data.heads[HEAD] };
  assert.ok(first.final, 'a heavy job ran: final');
  for (const [s, p] of [[status(), []], [status({ node: { mode: 'STANDBY' } }), pulls], [status({ halt: { code: 'X' } }), pulls]]) {
    st = s; list = p;
    now += 10 * 60_000;
    await r.step();
    assert.deepEqual(state.data.heads[HEAD], first, JSON.stringify(s.node));
  }
  // a full view that no longer lists the head drops it; so does age, whatever
  st = status({ pending: [] }); list = pulls;
  await r.step();
  assert.equal(state.data.heads[HEAD], undefined);
  st = status(); list = [];
  state.data.heads[HEAD] = { firstSeen: new Date(now - 25 * 60 * 60_000).toISOString(), lookedAt: null, final: 'x' };
  await r.step();
  assert.equal(state.data.heads[HEAD], undefined);
});

test('review round 9: a head that stays a candidate past 24 hours is never looked at again after its 12 hours (no new window)', async t => {
  const w = world({ fail: (route, method) => (method === 'GET' && route.includes('/actions/') ? { code: 1, stdout: '' } : null) });
  const l = await lane(t, w);
  const at = [];
  for (let i = 0; i < 40 * 30; i++) { const n = w.calls.length; await l.r.step(); if (w.calls.length > n) at.push(i * 2); l.advance(2 * 60_000); }
  assert.ok(at.length > 0 && at.every(m => m <= 12 * 60), `looked at after 12 hours: ${at.filter(m => m > 12 * 60).slice(0, 3)}`);
  assert.ok(l.state.data.heads[HEAD], 'the entry stays while the head is a candidate');
});

test('review round 10: a still-candidate head keeps its entry across a companion start (no poller pass yet) and a stale status, even past 24 hours', async t => {
  const w = world({ runs: [run(700, [attempt({ heavy: ['success', 'skipped', 'skipped'] })])],
    checks: [nativeCheck(), ...CHECK_NAMES.map(name => actionCheck(name))] });
  let now = T0, list = pulls, written = () => now;
  const state = await AdmissionRerunState.open(path.join(await tempRoot(t), 'rerun.json'), () => now);
  const r = new AdmissionRerunner({ gh: w.gh, state, clock: () => now, readStatus: async () => status({ writtenAt: written() }), pulls: () => list, notify: async () => {} });
  await r.step();
  const first = state.data.heads[HEAD].firstSeen;
  assert.ok(state.data.heads[HEAD].final);
  // 25 hours on, still a candidate all along (the mark is refreshed hourly)
  for (let h = 1; h <= 25; h++) { now = T0 + h * 60 * 60_000; await r.step(); }
  assert.equal(state.data.heads[HEAD].firstSeen, first);
  // the companion restarts: no poller pass yet (null), then a stale status: the entry stays
  list = null; await r.step();
  list = pulls; written = () => now - 10 * 60_000; await r.step();
  assert.equal(state.data.heads[HEAD]?.firstSeen, first, 'not reset, the final verdict kept');
  const reads = w.calls.length;
  written = () => now; now += 2 * 60_000; await r.step();
  assert.equal(w.calls.length, reads, 'never looked at again');
  // a stale status clicks nothing either
  const w2 = world();
  const l2 = await lane(t, w2);
  l2.r.readStatus = async () => status({ writtenAt: T0 - 6 * 60 * 60_000 });
  await l2.r.step();
  assert.deepEqual([w2.posts, w2.calls.length], [[], 0]);
});

test('review round 29: an outcome whose save failed is written by the end of the step or the next one', async t => {
  const w = world();
  const l = await lane(t, w);
  let saves = 0;
  const save = l.state.save.bind(l.state);
  l.state.save = async () => { saves += 1; if (saves === 2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return save(); };
  await l.r.step();
  assert.deepEqual(w.posts, [700]);
  assert.equal(JSON.parse(await fs.readFile(l.file, 'utf8')).records['700:2'].outcome, 'sent', 'written at the end of the same step');
  // a second failure too: the next step writes it
  saves = 0;
  const w2 = world(), l2 = await lane(t, w2);
  const save2 = l2.state.save.bind(l2.state);
  l2.state.save = async () => { saves += 1; if (saves >= 2 && saves <= 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return save2(); };
  await l2.r.step();
  assert.equal(JSON.parse(await fs.readFile(l2.file, 'utf8')).records['700:2'].outcome, 'intent', 'both saves of this step failed');
  l2.advance(60_000);
  await l2.r.step();
  assert.equal(JSON.parse(await fs.readFile(l2.file, 'utf8')).records['700:2'].outcome, 'sent');
});

test('review round 29: an intent left by a stop between the two saves becomes unknown, and the Owner hears of it once', async t => {
  const w = world();
  const l = await lane(t, w);
  l.state.data.records[HEAD] = { contract: 'clued.independent-ci.admission-rerun/1', pr: 452, headSha: HEAD, runId: 700, attempt: 2, outcome: 'intent', at: new Date(T0).toISOString(), why: null };
  await l.state.save();
  const again = await lane(t, w, { stateFile: l.file });
  await again.r.step();
  await again.r.step();
  assert.deepEqual(w.posts, [], 'never asked again');
  assert.deepEqual(again.toasts, ['PR #452：自动补跑结果不确定']);
  assert.equal(JSON.parse(await fs.readFile(l.file, 'utf8')).records['700:2'].outcome, 'unknown');
  assert.equal(again.r.done(HEAD), false);
});

test('review round 30: an intent that cannot be saved leaves the step\'s other changes to the next step; a conversion to unknown that cannot be saved is tried again', async t => {
  // the intent's save fails: nothing is asked, and the next step writes the head's entry
  const w = world();
  const l = await lane(t, w);
  const save = l.state.save.bind(l.state);
  let fail = true;
  l.state.save = async () => { if (fail) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return save(); };
  assert.equal((await l.r.step()).reason, 'ADMISSION_RERUN_STATE_UNSAVED');
  assert.deepEqual(w.posts, []);
  fail = false;
  l.advance(60_000);
  await l.r.step();
  const disk = JSON.parse(await fs.readFile(l.file, 'utf8'));
  assert.ok(disk.heads[HEAD], 'the head entry is on disk');
  // a left intent whose conversion cannot be saved stays intent, unnotified, and is converted at the next step
  const w2 = world();
  const l2 = await lane(t, w2);
  l2.state.data.records[HEAD] = { contract: 'clued.independent-ci.admission-rerun/1', pr: 452, headSha: HEAD, runId: 700, attempt: 2, outcome: 'intent', at: new Date(T0).toISOString(), why: null };
  await l2.state.save();
  const again = await lane(t, w2, { stateFile: l2.file });
  const save2 = again.state.save.bind(again.state);
  let fail2 = true;
  again.state.save = async () => { if (fail2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return save2(); };
  await again.r.step();
  assert.deepEqual([again.state.record(HEAD).outcome, again.state.record(HEAD).why, again.toasts], ['intent', null, []]);
  fail2 = false;
  await again.r.step();
  await again.r.step();
  assert.deepEqual(again.toasts, ['PR #452：自动补跑结果不确定']);
  assert.equal(JSON.parse(await fs.readFile(l2.file, 'utf8')).records['700:2'].outcome, 'unknown');
  assert.deepEqual(w2.posts, [], 'never asked');
});

// --- Environment failures rely on job evidence, and a second repair needs proof of recovery.
const step = (name, conclusion) => ({ name, status: 'completed', conclusion });
const SETUP_DIED = [step('Set up job', 'failure'), step('Run tests', 'skipped')];
const TESTS_DIED = [step('Set up job', 'success'), step('Run tests', 'failure')];
const NET_LOG = '2026-11-15T01:00:00Z npm error code ECONNRESET\n2026-11-15T01:00:01Z npm error network aborted\n##[error]Process completed with exit code 1.';
const TEST_LOG = '2026-11-15T01:00:00Z not ok 3 - admission refuses\n2026-11-15T01:00:01Z # fail 1\n##[error]Process completed with exit code 1.';
const ok = { conclusion: 'success', steps: [step('Set up job', 'success'), step('Run tests', 'success')] };
const netFail = { conclusion: 'failure', steps: TESTS_DIED, log: NET_LOG };
const setupFail = { conclusion: 'failure', steps: SETUP_DIED };
// An attempt that ran: specs = [{ conclusion, steps, log }] for the three heavy jobs; logs are keyed by the job's index (the gate is 0).
const ran = (specs, { gate = { name: 'admission-gate', status: 'completed', conclusion: 'success', head_sha: HEAD } } = {}) => ({ notes: [],
  jobs: [gate, ...specs.map((sp, i) => ({ name: HEAVY[i], head_sha: HEAD, status: 'completed', conclusion: sp.conclusion, ...(sp.steps ? { steps: sp.steps } : {}) }))],
  logs: Object.fromEntries(specs.flatMap((sp, i) => sp.log === undefined ? [] : [[i + 1, sp.log]])) });

test('environment failure: a network failure is re-run once; another needs recovery evidence', async t => {
  const w = world({ runs: [run(700, [ran([netFail, ok, ok])])] });
  const d = await decide({ gh: w.gh, headSha: HEAD });
  assert.deepEqual([d.action, d.runId, d.attempt, d.environment], ['rerun', 700, 1, [HEAVY[0]]]);
  const l = await lane(t, w);
  await l.r.step();
  assert.deepEqual(w.posts, [700]);
  assert.equal(l.state.record(HEAD).attempt, 2);
  assert.match(l.toasts[0], /环境类失败/);
  // There is no evidence to repair the second failure yet.
  w.runs[0].status = 'completed';
  w.runs[0].attempts[1] = ran([netFail, ok, ok]);
  l.advance(HEAD_RECHECK_MS + 1);
  await l.r.step();
  assert.deepEqual(w.posts, [700]);
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'skip');
});

test('environment failure: a setup death needs no log; a gate job that died in setup ran nothing', async t => {
  const w = world({ runs: [run(700, [ran([setupFail, setupFail, ok])])] });
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'rerun');
  assert.equal(w.calls.filter(c => /logs/.test(c.target)).length, 0);
  const died = ran([{ conclusion: 'skipped' }, { conclusion: 'skipped' }, { conclusion: 'skipped' }], { gate: { name: 'admission-gate', status: 'completed', conclusion: 'failure', head_sha: HEAD, steps: SETUP_DIED } });
  const d = await decide({ gh: world({ runs: [run(700, [died])] }).gh, headSha: HEAD });
  assert.deepEqual([d.action, d.environment], ['rerun', null]);
  // Defect B (#1121 run 43720693841): the runner's job-started hook refused the gate in "Set up runner" before the admission came;
  // once it came, this lane asks for the one re-run (it used to call the head final and a new commit had to be pushed).
  const hookRefused = [step('Set up job', 'success'), step('Set up runner', 'failure'), step('Run node scripts/ci/clued-work-admission.mjs --mode gate', 'skipped'), step('Complete job', 'success')];
  const refused = ran([{ conclusion: 'skipped' }, { conclusion: 'skipped' }, { conclusion: 'skipped' }], { gate: { name: 'admission-gate', status: 'completed', conclusion: 'failure', head_sha: HEAD, steps: hookRefused } });
  const wb = world({ runs: [run(700, [refused])] });
  const late = await decide({ gh: wb.gh, headSha: HEAD });
  assert.deepEqual([late.action, late.runId, late.attempt, late.environment], ['rerun', 700, 1, null]);
  assert.equal(wb.calls.filter(c => /annotations/.test(c.target)).length, 0, 'no verdict is looked for: the gate never ran');
});

test('environment failure: a failed test, an unproven failure, a cancelled job or a failure of the attempt after a pending one never re-runs', async t => {
  const cases = {
    'a failed test': [ran([{ conclusion: 'failure', steps: TESTS_DIED, log: TEST_LOG }, ok, ok])],
    'a network failure and a failed test in one log': [ran([{ conclusion: 'failure', steps: TESTS_DIED, log: NET_LOG + '\n' + TEST_LOG }, ok, ok])],
    'a failed test in another job': [ran([netFail, { conclusion: 'failure', steps: TESTS_DIED, log: TEST_LOG }, ok])],
    'no network signature': [ran([{ conclusion: 'failure', steps: TESTS_DIED, log: '##[error]lint failed' }, ok, ok])],
    'no step record': [ran([{ conclusion: 'failure', log: NET_LOG }, ok, ok])],
    'a cancelled job': [ran([netFail, { conclusion: 'cancelled', steps: TESTS_DIED, log: NET_LOG }, ok])],
    'a gate job that did not succeed': [ran([netFail, ok, ok], { gate: { name: 'admission-gate', status: 'completed', conclusion: 'failure', head_sha: HEAD, steps: TESTS_DIED } })],
    'a head that ran twice': [ran([ok, ok, ok]), ran([netFail, ok, ok])],
  };
  for (const [label, attempts] of Object.entries(cases)) {
    const w = world({ runs: [run(700, attempts)] });
    assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'final', label);
    assert.deepEqual(w.posts, [], label);
  }
  // An unreadable log is not "no evidence of a test failure": nothing is clicked, and it is read again later.
  const w = world({ runs: [run(700, [ran([netFail, ok, ok])])], fail: target => (/logs/.test(target) ? { code: 1, stdout: '', stderr: 'HTTP 500' } : null) });
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'error');
  // A pending attempt, then an environment failure of the attempt that ran: that one is repaired.
  assert.equal((await decide({ gh: world({ runs: [run(700, [attempt(), ran([netFail, ok, ok])])] }).gh, headSha: HEAD })).action, 'rerun');
});

test('the log read: an over-long log is answered empty, never as evidence', async () => {
  const w = world({ runs: [run(700, [ran([netFail, ok, ok])])], fail: target => (/logs/.test(target) ? { code: 0, stdout: 'x'.repeat(3_500_000) } : null) });
  assert.equal((await decide({ gh: w.gh, headSha: HEAD })).action, 'final');
});

// Task 7067280f (PLAN 1a): GitHub never created the clued-required-tests run of a pushed head (a0122fd9, 2026-11-09: no Actions check
// suite at all, so there is nothing to re-run or re-request). The lane notices it and asks for the run once, through the workflow's
// dispatch entry. N = 5 minutes (DESK, PLAN 1a).
const LOST_RUN_AFTER_MS = 5 * 60_000;
test('lost run: a head with no clued-required-tests run 5 minutes after it was seen gets one dispatch, receipt first; never a second one', async t => {
  const w = world({ runs: [] });
  const l = await lane(t, w);
  const order = [];
  const save = l.state.save.bind(l.state);
  l.state.save = async () => { order.push([l.state.record(HEAD)?.outcome ?? null, w.dispatches.length]); return save(); };
  await l.r.step();
  l.advance(LOST_RUN_AFTER_MS - 60_000);
  await l.r.step();
  assert.deepEqual(w.dispatches, [], 'not before 5 minutes');
  l.advance(HEAD_RECHECK_MS); // looked at again 2 minutes later: 6 minutes after it was first seen
  assert.deepEqual(await l.r.step(), { acted: 1, looked: 1 });
  assert.deepEqual(w.dispatches, ['ref=claude/x'], 'one dispatch of the PR branch');
  assert.deepEqual(w.posts, [], 'no re-run: there is no run');
  assert.ok(order.some(([outcome, n]) => outcome === 'intent' && n === 0), 'the intent is on disk before the request');
  const rec = JSON.parse(await fs.readFile(l.file, 'utf8')).records[`${HEAD}:${LINUX_WORKFLOW}`];
  assert.deepEqual([rec.kind, rec.pr, rec.runId, rec.outcome], ['redispatch', 452, null, 'sent']);
  assert.equal(l.r.done(HEAD), false, 'not a re-run');
  assert.equal(l.r.line(HEAD), '必需测试没有运行，已自动补发一次');
  assert.deepEqual(l.toasts, ['PR #452：必需测试没有运行，已自动补发一次']);
  assert.equal(withRerunLine({ state: 'pending', description: '运行中：第 3 段（扫描）' }, l.r.line(HEAD)).description, '必需测试没有运行，已自动补发一次；运行中：第 3 段（扫描）');
  // the dispatched run is gone again (cancelled, say): the head is still never dispatched twice, not after a restart either
  w.runs.length = 0;
  for (let i = 0; i < 5; i++) { l.advance(HEAD_RECHECK_MS); await l.r.step(); }
  const again = await lane(t, w, { stateFile: l.file });
  again.advance(LOST_RUN_AFTER_MS);
  await again.r.step();
  assert.deepEqual(w.dispatches, ['ref=claude/x'], 'never twice');
});

test('lost run: a run exists (any event, any state), or the head is younger than 5 minutes: no dispatch', async t => {
  const cases = [
    [run(700, [attempt({ heavy: ['success', 'success', 'success'] })])],
    [run(700, [attempt()], { status: 'in_progress' })],
    [run(700, [attempt()], { status: 'queued', pull_requests: [] })],
    [run(700, [attempt()], { event: 'push' })],
    [run(700, [attempt()], { event: 'workflow_dispatch', pull_requests: [] })],
  ];
  for (const runs of cases) {
    const w = world({ runs, checks: [] });
    const l = await lane(t, w);
    for (let i = 0; i < 6; i++) { await l.r.step(); l.advance(HEAD_RECHECK_MS); }
    assert.deepEqual(w.dispatches, [], JSON.stringify(runs));
  }
  const young = world({ runs: [] });
  assert.equal((await decide({ gh: young.gh, headSha: HEAD, headAgeMs: LOST_RUN_AFTER_MS - 1 })).action, 'skip');
  assert.equal((await decide({ gh: young.gh, headSha: HEAD })).action, 'skip', 'an unknown age is not old');
  assert.equal((await decide({ gh: young.gh, headSha: HEAD, headAgeMs: LOST_RUN_AFTER_MS })).action, 'redispatch');
  assert.deepEqual(young.dispatches, [], 'decide never writes');
});

test('lost run: a failed or truncated query, a moved head, a run that appears right before the request: no dispatch, read again later', async t => {
  const runsRoute = `repos/${REPO}/actions/runs?head_sha=${HEAD}&per_page=100&page=1`;
  const broken = [
    route => (route === runsRoute ? { code: 1, stdout: '', stderr: 'HTTP 502' } : null),
    route => (route === runsRoute ? { code: null, timedOut: true, stdout: '' } : null),
    route => (route === runsRoute ? { code: 0, stdout: JSON.stringify({ total_count: 101, workflow_runs: [] }) } : null),
    route => (route === runsRoute ? { code: 0, stdout: JSON.stringify({ workflow_runs: [] }) } : null),
    route => (route === runsRoute ? { code: 0, stdout: 'not json' } : null),
    route => (route.endsWith('/pulls/452') ? { code: 0, stdout: JSON.stringify(pullRequest({ head: { sha: 'b'.repeat(40), ref: 'claude/x', repo: { full_name: REPO } } })) } : null),
    route => (route.endsWith('/pulls/452') ? { code: 1, stdout: '' } : null),
    route => (route.endsWith('/pulls/452') ? { code: 0, stdout: JSON.stringify(pullRequest({ head: { sha: HEAD, ref: 'bad ref;', repo: { full_name: REPO } } })) } : null),
  ];
  for (const fail of broken) {
    let down = true;
    const w = world({ runs: [], fail: (route, method) => (down && method === 'GET' ? fail(route) : null) });
    const d = await decide({ gh: w.gh, headSha: HEAD, headAgeMs: LOST_RUN_AFTER_MS });
    assert.notEqual(d.action, 'redispatch', String(fail));
    const l = await lane(t, w);
    for (let i = 0; i < 4; i++) { await l.r.step(); l.advance(HEAD_RECHECK_MS); }
    assert.deepEqual(w.dispatches, [], String(fail));
    assert.equal(l.state.record(HEAD), null, 'nothing recorded: the head is looked at again');
    down = false;
    l.advance(HEAD_RECHECK_MS);
    await l.r.step();
    assert.deepEqual(w.dispatches, ['ref=claude/x'], 'read again later, dispatched once');
  }
  // a run is created between the first read and the one right before the request
  let reads = 0;
  const late = world({ runs: [], fail: (route, method, st) => { if (method === 'GET' && route === runsRoute && ++reads === 2) st.runs.push(run(700, [attempt()], { status: 'queued' })); return null; } });
  assert.equal((await decide({ gh: late.gh, headSha: HEAD, headAgeMs: LOST_RUN_AFTER_MS })).action, 'skip');
  assert.deepEqual(late.dispatches, []);
});

test('lost run: GitHub refuses the dispatch (no workflow_dispatch entry yet) or its answer is lost: recorded, the Owner told once, never asked again', async t => {
  const cases = [
    [{ dispatchCode: 1 }, 'refused', `PR #452：${CHECK_NAMES.join('、')} 没有运行，无法自动补发`, `${CHECK_NAMES.join('、')} 没有运行，无法自动补发`],
    [{ fail: (route, method) => (method === 'POST' ? { code: null, timedOut: true, stdout: '' } : null) }, 'unknown', 'PR #452：必需测试没有运行，自动补发结果不确定', '必需测试没有运行，自动补发结果不确定'],
    [{ fail: (route, method) => (method === 'POST' ? { code: null, stdout: '', refused: 'RUNNER_SPAWN_FAILED' } : null) }, 'unsent', 'PR #452：必需测试没有运行，自动补发没有发出', '必需测试没有运行，自动补发未成功'],
  ];
  for (const [o, outcome, toast, line] of cases) {
    const w = world({ runs: [], ...o });
    const l = await lane(t, w);
    await l.r.step();
    l.advance(LOST_RUN_AFTER_MS);
    await l.r.step();
    assert.equal(l.state.record(HEAD)?.outcome, outcome, toast);
    assert.deepEqual(l.toasts, [toast]);
    assert.equal(l.r.line(HEAD), line);
    const posts = w.calls.filter(c => c.method === 'POST').length;
    assert.equal(posts, 1);
    for (let i = 0; i < 4; i++) { l.advance(HEAD_RECHECK_MS); await l.r.step(); }
    assert.equal(w.calls.filter(c => c.method === 'POST').length, posts, 'never repeated');
  }
  // an intent left by a stop: unknown, told once, never sent
  const w = world({ runs: [] });
  const l = await lane(t, w);
  l.state.data.records[HEAD] = { contract: 'clued.independent-ci.admission-rerun/1', kind: 'redispatch', pr: 452, headSha: HEAD, runId: null, attempt: null, outcome: 'intent', at: new Date(T0).toISOString(), why: null };
  await l.state.save();
  const again = await lane(t, w, { stateFile: l.file });
  again.advance(LOST_RUN_AFTER_MS);
  await again.r.step();
  await again.r.step();
  assert.deepEqual(again.toasts, ['PR #452：必需测试没有运行，自动补发结果不确定']);
  assert.deepEqual(w.dispatches, []);
});
