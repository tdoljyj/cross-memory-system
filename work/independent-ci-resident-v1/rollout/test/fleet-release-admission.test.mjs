import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_REPO, prepareCommit } from '../fleet/publish.mjs';
import { fleetReleaseWorkflow } from '../fleet/release-migration-workflow.mjs';
import { missingMigrations, releaseRequirements, requirementsDigest, SNAPSHOT_LABEL } from '../fleet/release-migrations.mjs';
import { prepWorld } from '../fleet/test/publish-fixtures.mjs';

const files = [
  '20261126174100_merge_train_control_v2.sql',
  '20261126175000_ci_train_landing_receipts_v2.sql',
  '20261127120000_fleet_delivery_seal_v1.sql',
  '20261127120100_fleet_pending_delivery_v1.sql',
  '20261127120200_fleet_delivery_recipients_v1.sql',
];
const workflowPath = '.github/workflows/clued-cloud-production-release.yml';
const root = new URL('../../../../', import.meta.url);
const planOf = commit => releaseRequirements(commit, file => readFileSync(new URL(file, root)));
const required = ['hosted-ci-suites', 'hosted-ci-suites-windows', 'hosted-clued-cloud-tests', 'hosted-migration-verify',
  'hosted-gitleaks', 'hosted-trivy', 'hosted-contract-placement', 'kooyumi-work-admission'];
const appOf = name => name.startsWith('hosted-') ? 15368 : 5368905;
const branchRules = JSON.parse(readFileSync(new URL(
  'work/actions-hosted-migration/independent-ci-v1/test/fixtures/main-rules-scaffold-20261125.json', root)));

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
  const publisherStateDirectory = join(w.d, 'publisher-state');
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
      const rules = structuredClone(branchRules);
      const pr = rules.find(rule => rule.type === 'pull_request').parameters;
      if (settings.relaxPR) pr.require_extra_approval_for_unattributed_changes = false;
      const requiredChecks = rules.find(rule => rule.type === 'required_status_checks').parameters;
      requiredChecks.strict_required_status_checks_policy = !settings.noStrict;
      requiredChecks.required_status_checks = requiredChecks.required_status_checks.filter(entry => entry.context !== settings.removedCheck);
      return reply(rules);
    }
    if (args[1] === `${repo}/rulesets/27843120`) {
      const rules = JSON.parse(runGh(['api', `${repo}/rules/branches/main?per_page=100`]).stdout);
      return reply({ id: 27843120, target: 'branch', enforcement: 'active', source_type: 'Repository', source: DEFAULT_REPO,
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        ...(settings.noBypassMeta ? {} : { bypass_actors: settings.relaxBypass ? [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] : [] }),
        rules: rules.map(({ type, parameters }) => ({ type, parameters })) });
    }
    if (args[1]?.includes('/check-runs?')) {
      const rows = settings.red ? [...checks, { ...checks[0], id: 80, conclusion: settings.red }]
        : settings.badCheckApp ? [{ ...checks[0], app: { id: 123 } }, ...checks.slice(1)]
        : settings.otherCheckSha ? [{ ...checks[0], head_sha: '0'.repeat(40) }, ...checks.slice(1)]
        : settings.noMergeChecks ? [] : checks;
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
      runs.push({ id, display_title: `fleet-release-${mode}-${input.fleet_release_run}`, path: workflowPath, head_branch: 'main', head_sha: head,
        event: 'workflow_dispatch', run_attempt: 1, status: 'completed', conclusion, repository, head_repository: repository,
        actor: { login: 'tdoljyj' }, triggering_actor: { login: 'tdoljyj' }, result });
      if (mode === 'migrate' && settings.lostDispatch) return { status: 1 };
      return reply({ workflow_run_id: id });
    }
    throw new Error(`unexpected fixture call: ${args.join(' ')}`);
  };
  let advanceMain = false;
  const prepare = (dir = w.build) => {
    const release = fleetReleaseWorkflow({ repository: DEFAULT_REPO, commit, directory: dir, publisherStateDirectory, runGh,
      requirements: planOf, keyOf: () => `00000000-0000-4000-8000-${String(++operations).padStart(12, '0')}` });
    const ghCommand = args => {
      if (args[1]?.includes('/compare/main...')) return reply({ status: advanceMain ? 'behind' : 'identical' });
      return w.gh(args);
    };
    const read = async plan => {
      const observed = await release.read(plan);
      await settings.afterRead?.();
      return observed;
    };
    const generationTags = { ...w.deps.generationTags,
      list: () => {
        if (settings.advanceDuringInventory) advanceMain = true;
        return w.deps.generationTags.list();
      },
      read: name => {
        if (settings.advanceBeforeRelease) advanceMain = true;
        return w.deps.generationTags.read(name);
      },
      create: claim => { effects.push(['tag']); return w.deps.generationTags.create(claim); } };
    return prepareCommit({ commit, dir, out: w.out, images: [w.image], index: w.index, ghCommand,
      deps: { ...w.deps, release: { ...release, read }, generationTags } });
  };
  const noRelease = async () => {
    assert.deepEqual(await w.assets(), []);
    assert.ok(!(await w.calls()).some(({ args }) => args[0] === 'release' && args[1] === 'create'));
    assert.deepEqual(await fs.readFile(w.index), index);
    assert.ok(!effects.some(([effect]) => effect === 'tag'));
  };
  return { w, commit, plan, effects, settings, prepare, noRelease };
}

test('迁移有缺项且备份失败时，正式 prepare 必须零生产写入、零占号、零 Release', async t => {
  const w = await prepWorld(t, { version: 'g000025', released: false, spawnGh: false });
  const index = await fs.readFile(w.index);
  const effects = [];
  const release = {
    admit: async () => {},
    requirements: async () => planOf(w.source.commit),
    read: async () => ({ snapshot: { base: true, applied: [], interfaces: { train: false, landing: false, delivery: false, pendingDelivery: false, deliveryRecipients: false } } }),
    migrate: async missing => {
      effects.push(missing);
      throw Object.assign(new Error('备份失败'), { code: 'FLEET_MIGRATION_RUN_FAILED' });
    },
  };
  const tags = w.deps.generationTags;
  const ghCommand = args => args[1]?.includes('/compare/main...')
    ? { status: 0, stdout: JSON.stringify({ status: 'identical' }) } : w.gh(args);
  const outcome = await prepareCommit({ commit: w.source.commit, dir: w.build, out: w.out, images: [w.image], index: w.index, ghCommand,
    deps: { ...w.deps, release, generationTags: { ...tags, create: claim => { effects.push('tag'); return tags.create(claim); } } } })
    .then(result => ({ status: result.status, effects }), error => ({ code: error.code, effects }));
  assert.deepEqual(outcome, { code: 'FLEET_MIGRATION_RUN_FAILED', effects: [files] });
  assert.deepEqual(await w.assets(), []);
  assert.deepEqual(await fs.readFile(w.index), index);
});

test('正式 prepare 一次派发全部迁移缺项，凭同提交回读出包，空缺项直接出包', async t => {
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
    [{ relaxBypass: true }, 'FLEET_RELEASE_RULES_CHANGED', []],
    [{ relaxPR: true }, 'FLEET_RELEASE_RULES_CHANGED', []],
    [{ noBypassMeta: true }, 'FLEET_RELEASE_RULES_UNREADABLE', []],
    [{ noMergeChecks: true }, 'FLEET_RELEASE_CHECKS_NOT_GREEN', []],
    [{ badCheckApp: true }, 'FLEET_RELEASE_CHECKS_NOT_GREEN', []],
    [{ otherCheckSha: true }, 'FLEET_RELEASE_CHECKS_UNREADABLE', []],
    [{ wrongTip: true }, 'FLEET_RELEASE_MAIN_CHANGED', []],
    [{ changeBeforeMigrate: true }, 'FLEET_RELEASE_MAIN_CHANGED', ['read']],
    [{ actor: 'untrusted-actor' }, 'FLEET_RELEASE_PUBLISHER_REFUSED', []],
    [{ migrateFailure: 'wrong-sha' }, 'FLEET_MIGRATION_RUN_SUBJECT_CHANGED', ['read', 'migrate']],
    [{ migrateFailure: 'backup' }, 'FLEET_MIGRATION_RUN_FAILED', ['read', 'migrate']],
    [{ applied: files, badDigest: true }, 'FLEET_MIGRATION_LEDGER_CONFLICT', ['read']],
    [{ applied: files, brokenInterface: 'delivery' }, 'FLEET_MIGRATION_INTERFACE_MISMATCH', ['read']],
    [{ badReadback: true }, 'FLEET_MIGRATION_READBACK_REFUSED', ['read', 'migrate', ...files.map(() => 'apply')]],
  ]) await t.test(JSON.stringify(options), async t => {
    const w = await fixture(t, options);
    await assert.rejects(w.prepare(), { code });
    assert.deepEqual(w.effects.map(([effect]) => effect), effectNames);
    await w.noRelease();
  });
});

test('派发回执丢失时保留未决操作，重新发现部分成功的运行后只派剩余项', async t => {
  const w = await fixture(t, { lostDispatch: true, migrateFailure: 'partial' });
  const secondBuild = join(w.w.d, 'second-build');
  await fs.cp(w.w.build, secondBuild, { recursive: true });
  await assert.rejects(w.prepare(), { code: 'FLEET_MIGRATION_DISPATCH_UNKNOWN' });
  await w.noRelease();
  w.settings.hideRun = true;
  await assert.rejects(w.prepare(secondBuild), { code: 'FLEET_MIGRATION_RUN_UNRESOLVED' });
  assert.deepEqual(w.effects, [['read'], ['migrate', ...files], ['apply', files[0]]]);
  Object.assign(w.settings, { lostDispatch: false, hideRun: false, migrateFailure: null });
  assert.equal((await w.prepare(secondBuild)).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual(w.effects.slice(3), [['read'], ['migrate', ...files.slice(1)], ...files.slice(1).map(file => ['apply', file]), ['tag']]);
});

test('同一发布者从两个构建目录并发，首次迁移只 POST 一次', async t => {
  const bothRead = Promise.withResolvers();
  let reads = 0;
  const w = await fixture(t, { migrateFailure: 'backup', afterRead: () => {
    if (++reads === 2) bothRead.resolve();
    return bothRead.promise;
  } });
  const secondBuild = join(w.w.d, 'second-build');
  await fs.cp(w.w.build, secondBuild, { recursive: true });
  const attempts = await Promise.allSettled([w.prepare(), w.prepare(secondBuild)]);
  assert.ok(attempts.every(result => result.status === 'rejected'));
  assert.deepEqual(w.effects.filter(([effect]) => effect === 'migrate'), [['migrate', ...files]]);
  await w.noRelease();
});

test('正式准入后，代号库存读取期间 main 前进，零 tag、Release 和索引写入', async t => {
  const w = await fixture(t, { applied: files, advanceDuringInventory: true });
  await assert.rejects(w.prepare(), { code: 'FLEET_RELEASE_MAIN_CHANGED' });
  await w.noRelease();
});

test('tag 回读后 main 前进时，禁止创建正式 Release 和写索引', async t => {
  const w = await fixture(t, { applied: files, advanceBeforeRelease: true });
  const index = await fs.readFile(w.w.index);
  await assert.rejects(w.prepare(), { code: 'FLEET_RELEASE_MAIN_CHANGED' });
  assert.deepEqual(w.effects, [['read'], ['tag']]);
  assert.deepEqual(await w.w.assets(), []);
  assert.ok(!(await w.w.calls()).some(({ args }) => args[0] === 'release' && args[1] === 'create'));
  assert.deepEqual(await fs.readFile(w.w.index), index);
});

test('账本中的后项已应用而前项缺失时拒绝续跑', () => {
  const plan = planOf('a'.repeat(40));
  assert.deepEqual(plan.map(row => row.file), files);
  const row = plan[1];
  assert.throws(() => missingMigrations(plan, { base: true, applied: [{ name: row.name, version: row.version, digest: row.digest }],
    interfaces: { train: false, landing: true, delivery: false, pendingDelivery: false, deliveryRecipients: false } }), { code: 'FLEET_MIGRATION_DEPENDENCY_MISMATCH' });
});
