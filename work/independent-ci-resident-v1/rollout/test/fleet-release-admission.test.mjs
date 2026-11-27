import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_REPO, prepareCommit } from '../fleet/publish.mjs';
import { fleetReleaseWorkflow } from '../fleet/release-migration-workflow.mjs';
import { missingMigrations, releaseRequirements, requirementsDigest, SNAPSHOT_LABEL } from '../fleet/release-migrations.mjs';
import { prepWorld } from '../fleet/test/publish-fixtures.mjs';

const files = [
  '20261126174100_merge_train_control_v2.sql',
  '20261126175000_ci_train_landing_receipts_v2.sql',
  '20261127120000_fleet_delivery_seal_v1.sql',
];
const path = '.github/workflows/clued-cloud-production-release.yml';
const root = new URL('../../../../', import.meta.url);
const planOf = commit => releaseRequirements(commit, file => readFileSync(new URL(file, root)));
const required = ['hosted-ci-suites', 'hosted-ci-suites-windows', 'hosted-clued-cloud-tests', 'hosted-migration-verify',
  'hosted-gitleaks', 'hosted-trivy', 'hosted-contract-placement', 'kooyumi-work-admission'];
const appOf = name => name.startsWith('hosted-') ? 15368 : 5368905;

async function fixture(t, options = {}) {
  const w = await prepWorld(t, { version: 'g000025', released: false, spawnGh: false });
  const commit = w.source.commit;
  const plan = planOf(commit);
  const effects = [], runs = [];
  const settings = { ...options };
  const ledger = new Set(settings.applied ?? []);
  const index = await fs.readFile(w.index);
  const reply = value => ({ status: 0, stdout: JSON.stringify(value) });
  const checks = required.map((name, id) => ({ name, id: id + 1, app: { id: appOf(name) }, head_sha: commit, status: 'completed', conclusion: 'success' }));
  const snapshot = () => ({ base: true, applied: plan.flatMap((row, i) => ledger.has(row.file) ? [{ name: row.name,
    version: `2026112716000${i + 1}`, digest: settings.badDigest && i === 0 ? 'f'.repeat(64) : row.digest }] : []),
    interfaces: Object.fromEntries(plan.map(row => [row.probe, ledger.has(row.file) && settings.brokenInterface !== row.probe])) });
  let operations = 0;
  const runGh = args => {
    const repo = `repos/${DEFAULT_REPO}`;
    if (args[1] === 'user') return reply({ login: settings.actor ?? 'tdoljyj' });
    if (args[1] === `${repo}/git/ref/heads/main`) {
      const sha = settings.wrongTip || (settings.changeBeforeMigrate && runs.length) ? '0'.repeat(40) : commit;
      return reply({ ref: 'refs/heads/main', object: { type: 'commit', sha } });
    }
    if (args[1] === `${repo}/rules/branches/main?per_page=100`) {
      return reply(['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'].map(type => ({ type, ruleset_id: 27843120,
        ...(type === 'required_status_checks' && { parameters: { strict_required_status_checks_policy: !settings.noStrict,
          required_status_checks: required.filter(name => name !== settings.removedCheck).map(name => ({ context: name, integration_id: appOf(name) })) } }) })));
    }
    if (args[1]?.includes('/check-runs?')) {
      const rows = settings.red ? [...checks, { ...checks[0], id: 80, conclusion: settings.red }] : checks;
      return reply({ total_count: rows.length, check_runs: rows });
    }
    if (args[1]?.includes('/runs?')) return reply({ workflow_runs: settings.hideRun ? [] : runs });
    if (args[1]?.match(/\/runs\/\d+$/)) return reply(runs.find(run => run.id === Number(args[1].split('/').at(-1))));
    if (args[0] === 'run' && args[1] === 'view') {
      const run = runs.find(run => run.id === Number(args[2]));
      assert.ok(args.includes('--log'));
      return { status: 0, stdout: `job\tstep\tdate ${SNAPSHOT_LABEL} ${JSON.stringify(run.result)}\n` };
    }
    if (args[0] === 'api' && args[2] === 'POST') {
      assert.equal(args[4], 'X-GitHub-Api-Version: 2026-03-10');
      assert.ok(args.includes('ref=main'));
      const input = Object.fromEntries(args.flatMap(value => {
        const match = /^inputs\[(\w+)\]=(.*)$/.exec(value);
        return match ? [[match[1], match[2]]] : [];
      }));
      assert.equal(input.expected_release_sha, commit);
      const mode = input.mode, id = runs.length + 1;
      let conclusion = 'success', head = commit;
      if (mode === 'migrate') {
        const missing = input.migrations.split(',');
        effects.push(['migrate', ...missing]);
        assert.deepEqual(missing, plan.filter(row => !ledger.has(row.file)).map(row => row.file));
        const failure = settings.migrateFailure;
        if (failure === 'wrong-sha') head = '0'.repeat(40);
        if (failure) conclusion = 'failure';
        for (const file of failure === 'partial' ? missing.slice(0, 1) : failure ? [] : missing) {
          effects.push(['apply', file]);
          ledger.add(file);
        }
      } else {
        assert.equal(mode, 'preflight');
        assert.equal(input.migrations, undefined);
        effects.push(['read']);
      }
      const result = { commit, runId: String(id), requirementsSha256: settings.badReadback && mode === 'migrate' ? 'z' : requirementsDigest(plan), snapshot: snapshot() };
      const repository = { full_name: DEFAULT_REPO };
      runs.push({ id, display_title: `fleet-release-${mode}-${input.fleet_release_run}`, path, head_branch: 'main', head_sha: head,
        event: 'workflow_dispatch', run_attempt: 1, status: 'completed', conclusion, repository, head_repository: repository,
        actor: { login: 'tdoljyj' }, triggering_actor: { login: 'tdoljyj' }, result });
      if (mode === 'migrate' && settings.lostDispatch) return { status: 1 };
      return reply({ workflow_run_id: id });
    }
    throw new Error(`unexpected fixture call: ${args.join(' ')}`);
  };
  const prepare = () => prepareCommit({ commit, dir: w.build, out: w.out, images: [w.image], index: w.index, ghCommand: w.gh,
    deps: { ...w.deps, release: fleetReleaseWorkflow({ repository: DEFAULT_REPO, commit, directory: w.build, runGh,
      requirements: planOf, keyOf: () => `00000000-0000-4000-8000-${String(++operations).padStart(12, '0')}` }),
    generationTags: { ...w.deps.generationTags, create: claim => { effects.push(['tag']); return w.deps.generationTags.create(claim); } } } });
  const noRelease = async () => {
    assert.deepEqual(await w.assets(), []);
    assert.deepEqual(await fs.readFile(w.index), index);
    assert.ok(!effects.some(([effect]) => effect === 'tag'));
  };
  return { w, commit, plan, effects, settings, prepare, noRelease };
}

test('修前必红：前态缺三条迁移，且备份失败时，正式 prepare 必须零生产写入、零占号、零 Release', async t => {
  const w = await prepWorld(t, { version: 'g000025', released: false, spawnGh: false });
  const index = await fs.readFile(w.index);
  const effects = [];
  const release = {
    admit: async () => {},
    requirements: async () => planOf(w.source.commit),
    read: async () => ({ snapshot: { base: true, applied: [], interfaces: { train: false, landing: false, delivery: false } } }),
    migrate: async missing => {
      effects.push(missing);
      throw Object.assign(new Error('备份失败'), { code: 'FLEET_MIGRATION_RUN_FAILED' });
    },
  };
  const tags = w.deps.generationTags;
  const outcome = await prepareCommit({ commit: w.source.commit, dir: w.build, out: w.out, images: [w.image], index: w.index, ghCommand: w.gh,
    deps: { ...w.deps, release, generationTags: { ...tags, create: claim => { effects.push('tag'); return tags.create(claim); } } } })
    .then(result => ({ status: result.status, effects }), error => ({ code: error.code, effects }));
  assert.deepEqual(outcome, { code: 'FLEET_MIGRATION_RUN_FAILED', effects: [files] });
  assert.deepEqual(await w.assets(), []);
  assert.deepEqual(await fs.readFile(w.index), index);
});

test('正式 prepare 对账到三条缺项，单次派发后凭同提交回读出包，空缺项直接出包', async t => {
  const w = await fixture(t);
  const published = await w.prepare();
  assert.equal(published.status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual(published.migrationAdmission, { commit: w.commit, requirementsSha256: requirementsDigest(w.plan), readRunId: '1',
    migrationRunId: '2', dispatched: files });
  assert.deepEqual(w.effects, [['read'], ['migrate', ...files], ...files.map(file => ['apply', file]), ['tag']]);
  assert.ok((await w.w.assets()).some(asset => asset.name.endsWith('.acceptance-request.json')));
  const complete = await fixture(t, { applied: files });
  assert.equal((await complete.prepare()).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual(complete.effects, [['read'], ['tag']]);
});

test('红灯、跳过、规则集缩水、错误身份、换头、备份失败与账本冲突均不出包', async t => {
  for (const [options, code, effectNames] of [
    [{ red: 'failure' }, 'FLEET_RELEASE_CHECKS_NOT_GREEN', []],
    [{ red: 'skipped' }, 'FLEET_RELEASE_CHECKS_NOT_GREEN', []],
    [{ noStrict: true }, 'FLEET_RELEASE_RULES_CHANGED', []],
    [{ removedCheck: required[0] }, 'FLEET_RELEASE_RULES_CHANGED', []],
    [{ wrongTip: true }, 'FLEET_RELEASE_MAIN_CHANGED', []],
    [{ changeBeforeMigrate: true }, 'FLEET_RELEASE_MAIN_CHANGED', ['read']],
    [{ actor: 'untrusted-actor' }, 'FLEET_RELEASE_PUBLISHER_REFUSED', []],
    [{ migrateFailure: 'wrong-sha' }, 'FLEET_MIGRATION_RUN_SUBJECT_CHANGED', ['read', 'migrate']],
    [{ migrateFailure: 'backup' }, 'FLEET_MIGRATION_RUN_FAILED', ['read', 'migrate']],
    [{ applied: files, badDigest: true }, 'FLEET_MIGRATION_LEDGER_CONFLICT', ['read']],
    [{ applied: files, brokenInterface: 'delivery' }, 'FLEET_MIGRATION_INTERFACE_MISMATCH', ['read']],
    [{ badReadback: true }, 'FLEET_MIGRATION_READBACK_REFUSED', ['read', 'migrate', 'apply', 'apply', 'apply']],
  ]) await t.test(JSON.stringify(options), async t => {
    const w = await fixture(t, options);
    await assert.rejects(w.prepare(), { code });
    assert.deepEqual(w.effects.map(([effect]) => effect), effectNames);
    await w.noRelease();
  });
});

test('派发回执丢失时保留未决操作，重新发现部分成功的运行后只派剩余两条', async t => {
  const w = await fixture(t, { lostDispatch: true, migrateFailure: 'partial' });
  await assert.rejects(w.prepare(), { code: 'FLEET_MIGRATION_DISPATCH_UNKNOWN' });
  await w.noRelease();
  w.settings.hideRun = true;
  await assert.rejects(w.prepare(), { code: 'FLEET_MIGRATION_RUN_UNRESOLVED' });
  assert.deepEqual(w.effects, [['read'], ['migrate', ...files], ['apply', files[0]]]);
  Object.assign(w.settings, { lostDispatch: false, hideRun: false, migrateFailure: null });
  assert.equal((await w.prepare()).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual(w.effects.slice(3), [['read'], ['migrate', ...files.slice(1)], ...files.slice(1).map(file => ['apply', file]), ['tag']]);
});

test('账本中的后项已应用而前项缺失时拒绝续跑', () => {
  const plan = planOf('a'.repeat(40));
  assert.deepEqual(plan.map(row => row.file), files);
  const row = plan[1];
  assert.throws(() => missingMigrations(plan, { base: true, applied: [{ name: row.name, version: row.version, digest: row.digest }],
    interfaces: { train: false, landing: true, delivery: false } }), { code: 'FLEET_MIGRATION_DEPENDENCY_MISMATCH' });
});
