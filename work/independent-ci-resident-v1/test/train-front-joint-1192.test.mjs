// Second independent review (Codex, 58b9825fe), medium 2: #1192 as one event stream. One PR (#910 here), one head, the two required-tests
// workflows of the incident (Linux: ci-suites, clued-cloud-tests, migration-verify; Windows: ci-suites-windows), one model of GitHub that both
// the companion's lane (over its gh port) and stage 10 (over its GitHub port) read. The order is the incident's: the first attempts end
// skipped by the gate (ADMISSION_PENDING, 07:09), the admission comes (09:45:46), the merge slot goes green (09:56), stage 10 says the front
// misses four checks, the lane finds the front by itself and re-runs both runs, GitHub queues and starts the re-runs, stage 10 sees them in
// its window, the jobs run and pass, and the front is green. Without the lane the front yields at the window. No production access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { iso, H, NOW, REPO, T } from '../../actions-hosted-migration/independent-ci-v1/test/train-strict-fixtures.mjs';
import { ACTIONS, MIN, LINUX_RUN, WINDOWS_RUN, SKIPPED_NAME, detailsUrl, front } from './train-front-fixture.mjs';
import { AdmissionRerunState, AdmissionRerunner } from '../src/admission-rerun.mjs';
import { trainPageLine, trainSummary } from '../src/train.mjs';
import { tempRoot } from './helpers.mjs';

const PR = 910;
const NATIVE_ID = `independent-ci:native-work-admission:${'3'.repeat(64)}:f9:e1:a1`;
const SLOT = NOW - 2 * MIN, ADMITTED = SLOT - 10 * MIN - 14_000, FIRST_END = SLOT - (2 * 60 + 46) * MIN - 50_000;
const WORKFLOWS = { [LINUX_RUN]: { id: 100, path: '.github/workflows/clued-required-tests.yml', jobs: ['clued-cloud-tests', 'ci-suites', 'migration-verify'], base: 1000 },
  [WINDOWS_RUN]: { id: 101, path: '.github/workflows/clued-required-tests-windows.yml', jobs: ['ci-suites-windows'], base: 2000 } };
const PENDING_NOTE = { title: 'admission-gate', message: 'ADMISSION_PENDING: kooyumi-work-admission of App 5368905 for #910: has posted no check after 600s; heavy jobs are skipped.' };

// One model of the head's workflow runs; sync() writes GitHub's check runs of every job into stage 10's world.
function model(e) {
  const job = (run, n, i, name, o) => ({ id: WORKFLOWS[run].base + n * 10 + i, name, head_sha: H, run_attempt: n, runner_name: 'clued-ci-company-linux-01', runner_id: 7,
    steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' }], ...o });
  const attempt1 = run => [job(run, 1, 0, 'admission-gate', { status: 'completed', conclusion: 'success', started_at: iso(FIRST_END - 11 * MIN), completed_at: iso(FIRST_END) }),
    ...WORKFLOWS[run].jobs.map((c, i) => job(run, 1, i + 1, SKIPPED_NAME(c), { status: 'completed', conclusion: 'skipped', started_at: iso(FIRST_END), completed_at: iso(FIRST_END), steps: [], runner_name: null, runner_id: 0 }))];
  const m = { runs: [LINUX_RUN, WINDOWS_RUN].map(id => ({ id, workflow_id: WORKFLOWS[id].id, path: WORKFLOWS[id].path, head_sha: H, event: 'pull_request', status: 'completed',
    conclusion: 'success', pull_requests: [{ number: PR }], actor: { login: 'tdoljyj', type: 'User' }, attempts: [attempt1(id)] })), posts: [] };
  m.run = id => m.runs.find(r => r.id === id);
  m.shown = r => { const { attempts, ...rest } = r; return { ...rest, run_attempt: attempts.length }; };
  m.sync = () => {
    for (const [id, c] of e.gh.world.checks) if (c.app.id === 15368) e.gh.world.checks.delete(id);
    for (const r of m.runs) for (const jobs of r.attempts) for (const j of jobs)
      e.gh.world.checks.set(j.id, { id: j.id, app: { id: 15368 }, name: j.name, head_sha: H, status: j.status, conclusion: j.conclusion ?? null,
        started_at: j.started_at ?? null, completed_at: j.completed_at ?? null, details_url: detailsUrl(r.id, j.id), check_suite: { id: r.id * 10 } });
  };
  // GitHub's answer to "Re-run all jobs": a new attempt whose gate is queued.
  m.rerun = id => { const r = m.run(id); const n = r.attempts.length + 1; r.status = 'queued'; r.attempts.push([job(id, n, 0, 'admission-gate', { status: 'queued', conclusion: null, steps: [], runner_name: null, runner_id: null })]); };
  m.startGates = at => { for (const r of m.runs) { const g = r.attempts.at(-1)[0]; Object.assign(g, { status: 'in_progress', started_at: iso(at) }); r.status = 'in_progress'; } };
  m.admitGates = at => { for (const r of m.runs) { const n = r.attempts.length; const jobs = r.attempts.at(-1);
    Object.assign(jobs[0], { status: 'completed', conclusion: 'success', completed_at: iso(at) });
    jobs.push(...WORKFLOWS[r.id].jobs.map((c, i) => job(r.id, n, i + 1, c, { status: 'in_progress', conclusion: null, started_at: iso(at + 5000) }))); } };
  m.pass = at => { for (const r of m.runs) { for (const j of r.attempts.at(-1).slice(1)) Object.assign(j, { status: 'completed', conclusion: 'success', completed_at: iso(at) }); r.status = 'completed'; } };
  return m;
}

// The lane's gh port over the same model and stage 10's checks.
async function laneGh(e, m) {
  const pull = { number: PR, state: 'open', head: { sha: H, ref: 'claude/incident-1192', repo: { full_name: REPO } }, base: { ref: 'main', sha: T, repo: { full_name: REPO } } };
  const checks = () => [...e.gh.world.checks.values()].filter(c => c.head_sha === H).map(c => structuredClone(c));
  const sources = Object.fromEntries(await Promise.all(Object.values(WORKFLOWS).map(async w => [w.path, await fs.readFile(new URL(`../../../${w.path}`, import.meta.url))])));
  return {
    repo: REPO,
    async get(route) {
      let r;
      if (route === `/pulls/${PR}`) return structuredClone(pull);
      if ((r = /^\/actions\/runs\/(\d+)$/.exec(route))) return m.shown(m.run(Number(r[1])));
      if ((r = /^\/contents\/(\.github\/workflows\/[\w.-]+)\?ref=([0-9a-f]{40})$/.exec(route))) return { path: r[1], sha: 'f'.repeat(40), encoding: 'base64', content: sources[r[1]].toString('base64') };
      if (route.startsWith('/actions/workflows/')) return { total_count: 0, workflow_runs: [] };
      assert.fail(`GET ${route}`);
    },
    async paged(route) {
      let r;
      if (route === `/commits/${H}/pulls`) return [structuredClone(pull)];
      if (route === `/commits/${H}/check-runs?check_name=kooyumi-work-admission&filter=all`) return checks().filter(c => c.name === 'kooyumi-work-admission');
      if (route === `/commits/${H}/check-runs?filter=all`) return checks();
      if (route === '/rules/branches/main') return (await e.gh.readBranchRules()).rules;
      if (route === `/actions/runs?head_sha=${H}`) return m.runs.map(m.shown);
      if ((r = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(route))) return structuredClone(m.run(Number(r[1])).attempts[Number(r[2]) - 1]);
      if ((r = /^\/check-runs\/(\d+)\/annotations$/.exec(route))) return Number(r[1]) % 1000 === 10 ? [PENDING_NOTE] : [];
      assert.fail(`PAGED ${route}`);
    },
    async text(route) {
      assert.match(route, /^\/actions\/jobs\/\d+\/logs$/);
      return '2026-11-19T22:58:31Z \x1b[36;1mnode scripts/ci/clued-work-admission.mjs --mode gate\x1b[0m\n  "verdict": "ADMISSION_PENDING",\n  "automation_self_hosted": false\n';
    },
    async rerun(runId) { m.posts.push(runId); m.rerun(runId); return { outcome: 'sent' }; },
    async dispatch() { assert.fail('no re-dispatch in #1192: both runs exist'); },
  };
}

async function incident(t) {
  const f = await front(t, { slotAt: SLOT, admittedAt: ADMITTED, others: false });
  // the admission the lane reads is the same check run stage 10 sees, bound to the PR as App 5368905 writes it
  const admission = [...f.e.gh.world.checks.values()].find(c => c.name === 'kooyumi-work-admission');
  Object.assign(admission, { external_id: NATIVE_ID, output: { summary: `Independent Native control check for ${REPO}#${PR}.` } });
  const m = model(f.e);
  m.sync();
  return { ...f, m };
}
const roundAt = async (f, at) => { f.m.sync(); f.e.now = at; return (await f.e.run()).facts; };

test('#1192 as one stream: skipped -> the merge slot -> the lane re-runs both workflows -> the train waits, then green', async t => {
  const f = await incident(t);
  const r1 = await roundAt(f, NOW);
  assert.equal(r1.decision, 'FRONT_CHECKS_MISSING');
  assert.deepEqual(r1.front.required.missing.map(x => x.context).sort(), [...ACTIONS].sort());
  assert.equal(f.yields(), 0);
  // the companion: this node has no queue row for the head; the train's summary names it the front
  let now = NOW + MIN;
  const state = await AdmissionRerunState.open(path.join(await tempRoot(t), 'rerun.json'), () => now);
  const lane = new AdmissionRerunner({ gh: await laneGh(f.e, f.m), state, clock: () => now, notify: async () => {},
    readStatus: async () => ({ node: { mode: 'ACTIVE' }, halt: null, current: null, pending: [], recent: [], writtenAt: now, train: { enabled: 'on', last: trainSummary(r1) } }),
    pulls: () => [{ pr: PR, headSha: H }] });
  await lane.step();
  assert.deepEqual(f.m.posts.sort(), [LINUX_RUN, WINDOWS_RUN].sort(), 'the lane re-ran both workflows of the front');
  // GitHub queued the re-runs: not yet a new attempt; still inside the window that began with the merge slot
  const r2 = await roundAt(f, NOW + 3 * MIN);
  assert.equal(r2.decision, 'FRONT_CHECKS_MISSING');
  assert.equal(f.yields(), 0);
  // the gates start; past the window the train sees the re-run of each missing check's own run
  f.m.startGates(NOW + 4 * MIN);
  const r3 = await roundAt(f, NOW + 11 * MIN);
  assert.equal(f.yields(), 0);
  assert.equal(r3.decision, 'FRONT_CHECKS_WAIT');
  assert.equal(r3.front.required.reruns, 1);
  assert.match(trainPageLine(trainSummary(r3), PR, ['ci-suites（未出现）']), /补跑中（第 1 次）/);
  // admitted at once (the admission exists): the jobs run, then pass
  f.m.admitGates(NOW + 12 * MIN);
  assert.equal((await roundAt(f, NOW + 13 * MIN)).decision, 'FRONT_CHECKS_WAIT');
  f.m.pass(NOW + 26 * MIN);
  const done = await roundAt(f, NOW + 27 * MIN);
  assert.equal(done.decision, 'FRONT_GREEN_WAIT_MERGE');
  assert.equal(f.yields(), 0);
});

test('#1192 as one stream, without the lane: the front yields at the window with the reason', async t => {
  const f = await incident(t);
  assert.equal((await roundAt(f, NOW)).decision, 'FRONT_CHECKS_MISSING');
  const r = await roundAt(f, NOW + 11 * MIN);
  assert.equal(f.yields(), 1);
  assert.equal(r.front.required.yieldReason, 'REQUIRED_CHECK_NOT_RERUN');
});
