import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_REPO, prepareCommit } from '../fleet/publish.mjs';
import * as releaseAdmission from '../fleet/release-admission.mjs';
import { fleetReleaseWorkflow } from '../fleet/release-migration-workflow.mjs';
import { missingMigrations, releaseRequirements, requirementsDigest, SNAPSHOT_LABEL } from '../fleet/release-migrations.mjs';
import { prepWorld } from '../fleet/test/publish-fixtures.mjs';

const files = [
  '20261126174100_merge_train_control_v2.sql',
  '20261126175000_ci_train_landing_receipts_v2.sql',
  '20261127120000_fleet_delivery_seal_v1.sql',
  '20261127120100_fleet_pending_delivery_v1.sql',
  '20261127120200_fleet_delivery_recipients_v1.sql',
  '20261127120210_fleet_delivery_peer_recipients_v1.sql',
  '20261127123000_fleet_previous_interface_gate_v1.sql',
  '20261127210000_fleet_sealed_source_rule_v1.sql',
  '20261127223938_fleet_reinstall_window_partial_ready_v1.sql',
  '20261128080000_fleet_sealed_rule_takes_effect_on_arrival_v1.sql',
];
const workflowPath = '.github/workflows/clued-cloud-production-release.yml';
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
  const runReads = [], pauses = [];
  const settings = { ...options };
  const ledger = new Set(settings.applied ?? []);
  const index = await fs.readFile(w.index);
  const reply = value => ({ status: 0, stdout: JSON.stringify(value) });
  const head = 'd'.repeat(40), tree = 'e'.repeat(40);
  const pr = { number: 1387, state: 'closed', merged_at: '2026-11-27T01:00:00Z', merge_commit_sha: commit,
    head: { sha: head, repo: { full_name: DEFAULT_REPO } }, base: { ref: 'main', repo: { full_name: DEFAULT_REPO } } };
  const checks = required.map((name, id) => ({ name, id: id + 1, app: { id: appOf(name) }, head_sha: head,
    started_at: '2026-11-27T00:30:00Z', status: 'completed', conclusion: 'success' }));
  const publisherStateDirectory = join(w.d, 'publisher-state');
  const snapshot = () => ({ base: true, applied: plan.flatMap((row, i) => ledger.has(row.file) ? [{ name: row.name,
    version: `20261127160${String(i + 1).padStart(3, "0")}`, digest: settings.badDigest && i === 0 ? 'f'.repeat(64) : row.digest }] : []),
    interfaces: Object.fromEntries(plan.map(row => [row.probe, ledger.has(row.file) && settings.brokenInterface !== row.probe])) });
  let operations = 0;
  const runGh = args => {
    const repo = `repos/${DEFAULT_REPO}`;
    if (args[1] === 'user') return reply({ login: settings.actor ?? 'tdoljyj' });
    if (args[1] === `${repo}/git/ref/heads/main`) {
      const sha = settings.wrongTip || (settings.changeBeforeMigrate && runs.length) ? '0'.repeat(40) : commit;
      return reply({ ref: 'refs/heads/main', object: { type: 'commit', sha } });
    }
    if (args[1] === `${repo}/commits/${commit}`) return reply({
      sha: commit, parents: [{ sha: 'a'.repeat(40) }, { sha: settings.wrongParent ? 'b'.repeat(40) : head }], commit: { tree: { sha: tree } },
    });
    if (args[1] === `${repo}/commits/${head}`) return reply({
      sha: head, commit: { tree: { sha: settings.otherTree ? 'f'.repeat(40) : tree } },
    });
    if (args[1] === `${repo}/commits/${commit}/pulls?per_page=100`) return reply([pr]);
    if (args[1] === `${repo}/pulls/${pr.number}`) return reply({ ...pr, merged: !settings.notMerged });
    if (args[1]?.startsWith(`${repo}/rules`)) {
      assert.ok(!settings.noRules, 'no ruleset read credential');
      throw new Error('release admission must not query rulesets');
    }
    if (args[1]?.includes('/check-runs?')) {
      if (!args[1].includes(`/commits/${head}/`)) return reply({ total_count: 0, check_runs: [] });
      const rows = settings.skippedAfterMerge ? [...checks, ...checks.filter(row => row.app.id === 15368)
        .map(row => ({ ...row, id: row.id + 80, started_at: '2026-11-27T01:00:01Z', conclusion: 'skipped' }))]
        : settings.red ? [...checks, { ...checks[0], id: 80, started_at: '2026-11-27T00:59:59Z',
          ...(settings.red === 'queued' ? { status: 'queued', conclusion: null } : { conclusion: settings.red }) }]
        : settings.badCheckApp ? [{ ...checks[0], app: { id: 123 } }, ...checks.slice(1)]
        : settings.otherCheckSha ? [{ ...checks[0], head_sha: '0'.repeat(40) }, ...checks.slice(1)]
        : settings.noMergeChecks ? [] : checks;
      return reply({ total_count: rows.length, check_runs: rows });
    }
    if (args[1]?.includes('/runs?')) return reply({ workflow_runs: settings.hideRun ? [] : runs });
    if (args[1]?.match(/\/runs\/\d+$/)) {
      const id = Number(args[1].split('/').at(-1));
      runReads.push(id);
      const run = runs.find(run => run.id === id);
      return settings.readRun?.(run, runReads.length, reply) ?? reply(run);
    }
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
      pause: async ms => { pauses.push(ms); },
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
  return { w, commit, plan, effects, settings, prepare, noRelease, runReads, pauses };
}

test('发布准入 CLI 钉住返回 merge_commit_sha 的 GitHub API 版本', () => {
  const source = readFileSync(new URL('../fleet/release-admission.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('2026-03-10'), '发布准入源码仍包含不返回 merge_commit_sha 的版本 2026-03-10');
  assert.equal(releaseAdmission.RELEASE_API_VERSION, '2022-11-28');
  assert.match(source, /'X-GitHub-Api-Version':\s*RELEASE_API_VERSION\b/);
});

test('落地合并提交无需自身有检查，须读取其已合并 PR 的 head', async t => {
  const w = await fixture(t, { applied: files });
  assert.equal((await w.prepare()).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
});

test('略过合入之后在同一 head 启动的七项 skipped 检查', async t => {
  const w = await fixture(t, { applied: files, skippedAfterMerge: true });
  assert.equal((await w.prepare()).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
});

test('合入前启动且编号更新的 skipped 检查仍拒绝发布', async t => {
  const w = await fixture(t, { applied: files, red: 'skipped' });
  await assert.rejects(w.prepare(), { code: 'FLEET_RELEASE_CHECKS_NOT_GREEN' });
  assert.deepEqual(w.effects, []);
  await w.noRelease();
});

test('没有规则集专用读取授权时，固定检查仍可完成发布准入', async t => {
  const w = await fixture(t, { applied: files, noRules: true });
  assert.equal((await w.prepare()).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
});

test('迁移有缺项且备份失败时，正式 prepare 必须零生产写入、零占号、零 Release', async t => {
  const w = await prepWorld(t, { version: 'g000025', released: false, spawnGh: false });
  const index = await fs.readFile(w.index);
  const plan = planOf(w.source.commit);
  const effects = [];
  const release = {
    admit: async () => {},
    requirements: async () => plan,
    read: async () => ({ snapshot: { base: true, applied: [], interfaces: Object.fromEntries(plan.map(({ probe }) => [probe, false])) } }),
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

test('派发后运行先返回 404、再返回工作流名，完成绑定后 prepare 成功', async t => {
  const w = await fixture(t, { applied: files, readRun: (run, read, reply) => {
    if (read === 1) return { status: 1, stderr: 'gh: Not Found (HTTP 404)' };
    if (read === 2) return reply({ ...run, display_title: 'Clued Cloud production release' });
    return reply(run);
  } });
  assert.equal((await w.prepare()).status, 'FLEET_ACCEPTANCE_REQUEST_WRITTEN');
  assert.deepEqual(w.runReads, [1, 1, 1]);
  assert.deepEqual(w.pauses, [5000, 5000]);
  assert.deepEqual(w.effects, [['read'], ['tag']]);
});

test('运行一旦绑定，下一次发现主体变更就立即拒绝', async t => {
  const w = await fixture(t, { applied: files, readRun: (run, read, reply) => read === 1
    ? reply({ ...run, status: 'in_progress', conclusion: null })
    : reply({ ...run, head_sha: '0'.repeat(40) }) });
  await assert.rejects(w.prepare(), { code: 'FLEET_MIGRATION_RUN_SUBJECT_CHANGED', detail: { id: 1 } });
  assert.deepEqual(w.runReads, [1, 1]);
  assert.deepEqual(w.pauses, [5000]);
  await w.noRelease();
});

test('派发后的就绪窗口用尽且主体仍不符时拒绝', async t => {
  const w = await fixture(t, { applied: files, readRun: (run, _read, reply) => reply({ ...run, path: null }) });
  await assert.rejects(w.prepare(), { code: 'FLEET_MIGRATION_RUN_SUBJECT_CHANGED', detail: { id: 1 } });
  assert.deepEqual(w.runReads, Array(13).fill(1));
  assert.deepEqual(w.pauses, Array(12).fill(5000));
  await w.noRelease();
});

test('红灯、跳过、错误 PR、错误身份、换头、备份失败与账本冲突均不出包', async t => {
  for (const [options, code, effectNames] of [
    [{ red: 'failure' }, 'FLEET_RELEASE_CHECKS_NOT_GREEN', []],
    [{ red: 'queued' }, 'FLEET_RELEASE_CHECKS_NOT_GREEN', []],
    [{ wrongParent: true }, 'FLEET_RELEASE_MERGED_PR_REFUSED', []],
    [{ notMerged: true }, 'FLEET_RELEASE_MERGED_PR_REFUSED', []],
    [{ otherTree: true }, 'FLEET_RELEASE_MERGED_TREE_CHANGED', []],
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
    interfaces: { train: false, landing: true, delivery: false, pendingDelivery: false, deliveryRecipients: false, deliveryPeerRecipients: false } }), { code: 'FLEET_MIGRATION_DEPENDENCY_MISMATCH' });
});
