import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepare, identity, freshPortMap } from './clued-g4-fresh-start.mjs';
const { evaluatePush, validateEvidence, testedTreeReport, isolatedConfig, readReportZip, TARGETS, REPORT_NAME } = await import(process.env.CLUED_PUSH_REUSE_TEST_MODULE_PATH ?
  pathToFileURL(process.env.CLUED_PUSH_REUSE_TEST_MODULE_PATH).href : new URL('./clued-push-reuse.mjs', import.meta.url));
const fixtureFile = relative => process.env.CLUED_G4_TEST_REPO_ROOT ? path.join(process.env.CLUED_G4_TEST_REPO_ROOT, relative) : new URL('../../' + relative, import.meta.url);

const M = 'a'.repeat(40), H = 'b'.repeat(40), T = 'c'.repeat(40), C = 'd'.repeat(40);
const file = 'clued-g4-database.yml';
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: M,
  GITHUB_ACTOR: 'owner', GITHUB_REPOSITORY_OWNER: 'owner', GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_TOKEN: 'test-only-placeholder', REUSE_WORKFLOW: file };
const G4_CONFIG = 'project_id = "clued-cloud"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\nmajor_version = 17\n[studio]\nport = 54323\n[local_smtp]\nport = 54324\n[analytics]\nport = 54327\n[db.pooler]\nport = 54329\n[edge_runtime]\ninspector_port = 8083\n[db.seed]\nenabled = false\n';
function proof() {
  return { repository: 'owner/repo', owner: 'owner', sha: M, workflow: file,
    merge: { sha: M, parents: [{ sha: C }, { sha: H }], commit: { tree: { sha: T } } },
    pr: { state: 'closed', merged: true, merged_at: '2026-10-10T00:00:00Z', merge_commit_sha: M,
      number: 12, user: { login: 'owner' }, merged_by: { login: 'owner' },
      base: { ref: 'main', repo: { full_name: 'owner/repo' } }, head: { sha: H, repo: { full_name: 'owner/repo' } } },
    sourceCommit: { sha: H, commit: { tree: { sha: T } } },
    run: { id: 100, run_attempt: 2, run_number: 3, event: 'pull_request', status: 'completed', conclusion: 'success',
      path: `.github/workflows/${file}`, head_sha: H, repository: { full_name: 'owner/repo' },
      head_repository: { full_name: 'owner/repo' }, actor: { login: 'owner' }, pull_requests: [{ number: 12 }] },
    jobs: { total_count: 1, jobs: [{ run_id: 100, name: TARGETS[file].job, status: 'completed', conclusion: 'success',
      steps: [...TARGETS[file].steps, 'Checkout', 'Set up Node', 'Install', 'Stop runtime', 'Record the actual PR test tree',
        'Upload the actual PR test tree'].map((name) => ({ name, conclusion: 'success' })) }] },
    report: { schema: 'clued.tested-tree/1', repository: 'owner/repo', workflow: file, run_id: 100, run_attempt: 2,
      pr_number: 12, pr_head_sha: H, checkout_sha: C, github_sha: C, tree: T,
      isolation: { profile: 'fixed-seven-ports/2', run_id: 100, run_attempt: 2,
        source_config_digest: 'sha256:' + '1'.repeat(64), tested_config_digest: 'sha256:' + '2'.repeat(64) } } };
}

// A complete platform-bound archive; central sizes are used for descriptor ZIPs too.
function zip(value, name = REPORT_NAME, method = 0) {
  const raw = Buffer.from(JSON.stringify(value));
  const payload = method === 0 ? raw : deflateRawSync(raw);
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(filename.length, 26);
  const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(method, 10);
  dir.writeUInt32LE(payload.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + filename.length, 12); end.writeUInt32LE(30 + filename.length + payload.length, 16);
  return Buffer.concat([local, filename, payload, dir, filename, end]);
}
function api(p = proof(), overrides = {}) {
  const bytes = zip(p.report);
  const values = [p.merge, [p.pr], p.pr, p.sourceCommit, { total_count: 1, workflow_runs: [p.run] }, p.jobs,
    { total_count: 1, artifacts: [{ id: 9, name: `clued-tested-tree-${file}-2`, expired: false,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), workflow_run: { id: 100, head_sha: H } }] }, bytes,
    { total_count: 1, workflow_runs: [p.run] }];
  let count = 0;
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const item = overrides[count] ?? values[count]; count++;
    if (item instanceof Error) throw item;
    return { ok: true, json: async () => item, body: (async function* () { yield item; })() };
  };
  return { fetch, calls };
}

test('reuse qualifies only earlier PR evidence and never claims main PASS', async () => {
  const fake = api(); const result = await evaluatePush(env, fake.fetch);
  assert.equal(result.run_heavy, false); assert.equal(result.current_sha_pass, false);
  assert.equal(result.qualification, 'PR_EVIDENCE_ONLY'); assert.equal(result.source_attempt, 2);
  assert.equal(fake.calls.length, 9);
  assert.match(fake.calls[5], /\/attempts\/2\/jobs/);
});

test('the existing executor bot can reuse an Owner PR without widening runner trust', async () => {
  const p = proof(); p.pr.merged_by = { login: 'clued-admission[bot]', id: 337003645, type: 'Bot' };
  assert.equal((await evaluatePush({ ...env, GITHUB_ACTOR: 'clued-admission[bot]' }, api(p).fetch)).run_heavy, false);
  p.pr.merged_by.id = 1;
  assert.equal((await evaluatePush({ ...env, GITHUB_ACTOR: 'clued-admission[bot]' }, api(p).fetch)).run_heavy, true);
});

test('closed-PR empty platform association still requires the exact report PR', async () => {
  const p = proof(); p.run.pull_requests = [];
  assert.equal((await evaluatePush(env, api(p).fetch)).run_heavy, false);
  p.report.pr_number = 99;
  assert.equal((await evaluatePush(env, api(p).fetch)).run_heavy, true);
});

test('Information Flow keeps its run-only isolation qualification while G4 binds each attempt', () => {
  const p = proof();
  p.workflow = 'information-flow-e2e.yml';
  p.run.path = `.github/workflows/${p.workflow}`;
  p.jobs.jobs[0].name = TARGETS[p.workflow].job;
  p.jobs.jobs[0].steps = [...TARGETS[p.workflow].steps, 'Checkout', 'Set up Node', 'Install', 'Stop runtime']
    .map((name) => ({ name, conclusion: 'success' }));
  p.report.workflow = p.workflow;
  p.report.isolation.profile = 'fixed-seven-ports/1';
  delete p.report.isolation.run_attempt;
  assert.equal(validateEvidence(p).run_heavy, false);
  p.report.isolation.profile = 'fixed-seven-ports/2';
  assert.throws(() => validateEvidence(p));
});

test('PR, dispatch, untrusted, other branch and unknown target always execute with zero requests', async () => {
  for (const delta of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_ACTOR: 'someone' }, { GITHUB_REF: 'refs/heads/feature' }, { REUSE_WORKFLOW: 'public-mcp-behavior.yml' }]) {
    assert.equal((await evaluatePush({ ...env, ...delta }, () => { throw new Error('called'); })).run_heavy, true);
  }
});

test('wrong source, tree, workflow, attempt, PR or missing actual tests never reuse', () => {
  const mutations = [p => p.merge.parents.pop(), p => p.merge.commit.tree.sha = M,
    p => p.pr.head.repo.full_name = 'fork/repo', p => p.pr.merged_by.login = 'other',
    p => p.pr.base.ref = 'dev', p => p.pr.merge_commit_sha = H,
    p => p.run.head_sha = M, p => p.run.event = 'push', p => p.run.actor.login = 'other',
    p => p.run.conclusion = 'cancelled', p => p.run.status = 'in_progress',
    p => p.run.path = '.github/workflows/other.yml', p => p.run.pull_requests = [{ number: 99 }],
    p => p.report.run_attempt = 1, p => p.report.tree = H, p => p.report.checkout_sha = H,
    p => p.report.pr_head_sha = M, p => p.jobs.total_count = 100,
    p => p.report.isolation.profile = 'fixed-seven-ports/1', p => p.report.isolation.run_attempt = 1,
    p => p.jobs.jobs[0].steps[0].conclusion = 'skipped', p => p.jobs.jobs[0].steps[0].conclusion = 'failure',
    p => p.jobs.jobs[0].steps[0].name = 'Verify fresh migration initialization',
    p => p.jobs.jobs[0].conclusion = 'skipped', p => p.jobs.jobs[0].steps = []];
  for (const mutate of mutations) { const p = proof(); mutate(p); assert.throws(() => validateEvidence(p)); }
});

test('archive parser rejects multiple entries, wrong names, truncated and inflated archives', () => {
  assert.deepEqual(readReportZip(zip(proof().report)), proof().report);
  assert.deepEqual(readReportZip(zip(proof().report, REPORT_NAME, 8)), proof().report);
  assert.throws(() => readReportZip(zip({}, '../bad.json')));
  assert.throws(() => readReportZip(Buffer.alloc(10)));
  const two = zip({}); two.writeUInt16LE(2, two.length - 12); assert.throws(() => readReportZip(two));
  assert.throws(() => readReportZip(zip({ value: 'a'.repeat(70000) }, REPORT_NAME, 8)));
});

test('API failure, pagination, stale retry and archive digest mismatch fall back to actual work', async () => {
  for (const override of [{ 0: new Error('offline') }, { 1: Array(100).fill(proof().pr) },
    { 4: { total_count: 100, workflow_runs: [] } },
    { 4: { total_count: 2, workflow_runs: [proof().run, { ...proof().run, id: 200, run_number: 4, conclusion: 'failure' }] } },
    { 7: zip({}) },
    { 8: { total_count: 1, workflow_runs: [{ ...proof().run, run_attempt: 3, status: 'in_progress', conclusion: null }] } },
    { 8: { total_count: 2, workflow_runs: [proof().run, { ...proof().run, id: 200, run_number: 4, conclusion: 'failure' }] } }]) {
    assert.equal((await evaluatePush(env, api(proof(), override).fetch)).run_heavy, true);
  }
});

test('only the exact registered listener and run-specific project changes qualify, never arbitrary dirty configuration', () => {
  const source = G4_CONFIG;
  const expected = 'project_id = "clued-g4-100-2"\n[api]\nport = 17617\n[db]\nport = 17618\nshadow_port = 17616\nmajor_version = 17\n[studio]\nport = 17619\n[local_smtp]\nport = 17620\n[analytics]\nport = 17623\n[db.pooler]\nport = 17625\n[edge_runtime]\ninspector_port = 17626\n[db.seed]\nenabled = false\n';
  assert.equal(isolatedConfig(source, file, 100, 2), expected);
  const event = { pull_request: { number: 12, user: { login: 'owner' }, head: { sha: H, repo: { full_name: 'owner/repo' } } } };
  const prEnv = { ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: C, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2' };
  const git = (verb, ref) => verb === 'status' ? 'M apps/clued-cloud/supabase/config.toml' :
    verb === 'show' ? source : ref === 'HEAD' ? C : T;
  const marker = { schema: 'clued.g4.fresh-start/2', ...identity(prEnv), prepared: true, port_base: 17616,
    daemon_id: 'fixture-daemon-identity', ports: freshPortMap(source, 17616),
    port_policy: { ephemeral: [32768, 60999], reserved: [] }, migrations: [],
    source_config_sha256: createHash('sha256').update(source).digest('hex'),
    config_sha256: createHash('sha256').update(expected).digest('hex') };
  const result = testedTreeReport(prEnv, event, git, () => expected, () => marker);
  assert.equal(result.isolation.profile, 'selected-seven-ports/3');
  assert.equal(result.isolation.run_attempt, 2);
  assert.throws(() => testedTreeReport(prEnv, event, git, () => expected.replace('major_version = 17', 'major_version = 18'), () => marker));
  assert.throws(() => testedTreeReport(prEnv, event, git, () => expected.replace('17617', '17618'), () => marker));
  assert.throws(() => testedTreeReport(prEnv, event, (verb, ref) => verb === 'status' ? '' : git(verb, ref), () => expected, () => marker));
  assert.throws(() => isolatedConfig(source.replace('port = 54329\n', ''), file, 100, 2));
  assert.throws(() => isolatedConfig(source, file, 100));
  const ifConfig = isolatedConfig(source, 'information-flow-e2e.yml', 100);
  assert.match(ifConfig, /project_id = "clued-ife2e-100"/);
  assert.match(ifConfig, /port = 46001/);
});

test('workflow integration leaves the registered admission gate unchanged and records proof after tests', () => {
  for (const file of Object.keys(TARGETS)) {
    const text = fs.readFileSync(fixtureFile(`.github/workflows/${file}`), 'utf8');
    assert.match(text, /needs: \[admission-gate, push-reuse\]/);
    assert.match(text, /needs\.admission-gate\.outputs\.admitted == 'true' &&\s+\(!cancelled\(\) && needs\.admission-gate\.result == 'success'/);
    assert.match(text, /github\.event_name != 'push' \|\| needs\.push-reuse\.result != 'success' \|\|\s+needs\.push-reuse\.outputs\.run_heavy != 'false'/);
    assert.match(text, /if: needs\.admission-gate\.outputs\.admitted == 'true' && \(github\.event_name == 'push'\)/);
    const jobs = [...text.slice(text.indexOf('\njobs:\n')).matchAll(/^  [\w-]+:[ \t]*$/gm)];
    const start = text.indexOf('\njobs:\n');
    const trusted = text.slice(start + jobs[2].index, start + jobs[3].index);
    for (const required of TARGETS[file].steps) {
      assert.ok(trusted.includes(required), `${file}: actual required step ${required} exists`);
      assert.ok(trusted.lastIndexOf(required) < trusted.indexOf('Record the actual PR test tree'));
    }
    assert.match(text, /scripts\/ci\/clued-g4-fresh-start\.mjs/);
    assert.ok(text.indexOf('Record the actual PR test tree') > text.indexOf('Check out repository'));
    assert.match(text, /retention-days: 7/);
    assert.match(text, /if: success\(\) && github\.event_name == 'pull_request'/);
    assert.match(text, /node-version: 22\.23\.3/);
  }
});

test('PORT6: the actual prepared alternate block produces a marker-bound tree report', async () => {
  const source = G4_CONFIG;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-g4-reuse-test-'));
  const app = path.join(root, 'apps/clued-cloud/supabase');
  fs.mkdirSync(path.join(app, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(app, 'config.toml'), source);
  fs.writeFileSync(path.join(app, 'migrations/202608230001_first.sql'), 'select 1;\n');
  const prEnv = { ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: C, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2',
    RUNNER_TEMP: root, GITHUB_ENV: path.join(root, 'github-env'), CLUED_G4_FRESH_PROJECT: 'clued-g4-100-2' };
  const event = { pull_request: { number: 12, user: { login: 'owner' }, head: { sha: H, repo: { full_name: 'owner/repo' } } } };
  const readConfig = () => fs.readFileSync(path.join(app, 'config.toml'), 'utf8');
  const git = (verb, ref) => verb === 'show' ? source : verb === 'status' ?
    (readConfig() === source ? '' : 'M apps/clued-cloud/supabase/config.toml') : ref === 'HEAD' ? C : ref === 'HEAD^{tree}' ? T : root;
  let probes = 0;
  try {
    await prepare(prEnv, { git, platform: 'linux', portProbe: async () => ++probes > 1,
      startLock: () => {}, portPolicy: () => ({ ephemeral: [32768, 60999], reserved: [] }),
      docker: (...args) => args[0] === 'context' ? JSON.stringify('unix:///var/run/docker.sock')
        : args[0] === 'info' ? JSON.stringify('fixture-daemon-identity') : '' });
    const report = testedTreeReport(prEnv, event, git, readConfig); // Default actual marker read.
    assert.equal(report.isolation.profile, 'selected-seven-ports/3');
    assert.equal(report.isolation.port_base, 17632);
    assert.match(report.isolation.fresh_marker_digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(readConfig(), isolatedConfig(source, file, 100, 2, report.isolation.port_base));
    const p = proof(); p.report = report; assert.equal(validateEvidence(p).run_heavy, false);
    fs.appendFileSync(path.join(app, 'config.toml'), '# arbitrary tracked edit\n');
    assert.throws(() => testedTreeReport(prEnv, event, git, readConfig), /fresh_configuration_changed/);
    fs.writeFileSync(path.join(app, 'config.toml'), isolatedConfig(source, file, 100, 2, 17632));
    const markerFile = path.join(root, 'clued-g4-fresh-100-2.json');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    for (const mutate of [m => m.port_base = 17616, m => m.config_sha256 = '0'.repeat(64), m => m.source_config_sha256 = '0'.repeat(64),
      m => m.run_attempt = 1, m => m.prepared = false]) {
      const altered = structuredClone(marker); mutate(altered); fs.writeFileSync(markerFile, JSON.stringify(altered));
      assert.throws(() => testedTreeReport(prEnv, event, git, readConfig));
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('PORT7: selected-block evidence remains bounded and malformed or stale proof still requires real work', async () => {
  const p = proof();
  Object.assign(p.report.isolation, { profile: 'selected-seven-ports/3', port_base: 17632, fresh_marker_digest: 'sha256:' + '3'.repeat(64) });
  assert.equal(validateEvidence(p).run_heavy, false);
  assert.equal((await evaluatePush(env, api(p).fetch)).run_heavy, false);
  for (const mutate of [x => x.port_base = '17632', x => x.port_base = 17625, x => x.port_base = 45000, x => x.port_base = 46020,
    x => delete x.port_base, x => x.fresh_marker_digest = 'invalid', x => x.run_attempt = 1,
    x => x.source_config_digest = 'invalid', x => x.tested_config_digest = 'invalid']) {
    const q = structuredClone(p); mutate(q.report.isolation);
    assert.throws(() => validateEvidence(q));
    assert.equal((await evaluatePush(env, api(q).fetch)).run_heavy, true);
  }
  // Historical fixed-block evidence retains its original source/identity gates.
  assert.equal(validateEvidence(proof()).run_heavy, false);
});
