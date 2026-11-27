// 托管脚手架 hosted-required.yml 的结构约束（任务 04f9b91b）。纯文本读取；hosted-gitleaks 与自托管 R1 的区间扫描逐字一致并真跑一遍。
// staging 会被列车强制改指：上一批没落地时 github.event.before 在检出里不存在，拿它当基线检查就报错变红。
// 所以凡是给命令传比较基线的作业，一律由 train-base 按 scripts/ci/ci-base.mjs 现算（staging 时即 stagingBaseFromCheckout；与自托管同一来源）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const text = readFileSync(new URL('../../.github/workflows/hosted-required.yml', import.meta.url), 'utf8');

function jobs(source) {
  const body = source.slice(source.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const out = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    const head = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) { current = head[1]; out.set(current, []); continue; }
    if (current) out.get(current).push(line);
  }
  return new Map([...out].map(([id, lines]) => [id, lines.join('\n')]));
}

const BASE_ENV = /^\s+(BASE|CI_BASE_SHA):\s*(.+)$/gm;
const V2_STAGING_GATE = " && (github.event_name != 'push' || vars.CLUED_MERGE_TRAIN_PROTOCOL_VERSION != '2')";

const STAGING_GATE = text.includes(V2_STAGING_GATE) ? V2_STAGING_GATE : '';

test('协议 2 只停用 hosted 暂存作业，PR 和协议 1 保留各作业原条件', () => {
  assert.match(text, /pull_request:\n    types: \[opened, synchronize, reopened, closed\]\n    branches: \[main\]/);
  assert.match(text, /push:\n    branches: \[clued-train\/staging\]/);
  const always = new Set(['clued-cloud-tests', 'ci-suites', 'migration-verify', 'ci-suites-windows', 'ci-suites-windows-duration']);
  for (const [id, block] of jobs(text)) {
    const guard = /^    if: (.+)$/m.exec(block)?.[1];
    assert.equal(guard, (always.has(id) ? 'always() && ' : '') + "github.event.action != 'closed'" + STAGING_GATE, id);
  }
});

test('托管工作流不拿 github.event.before 当基线（staging 强制改指后它可能不存在）', () => {
  assert.doesNotMatch(text, /github\.event\.before/);
});

// CI_BASE_SHA 只有一处规则（scripts/ci/ci-base.mjs，任务 6cd46765）：每个要比较基线的作业在 train-base 步骤里从 main 读它，
// 写进 GITHUB_ENV；没有哪一步自己设 CI_BASE_SHA 或 BASE（步骤 env 会盖过 GITHUB_ENV，#1292 就是步骤里取了 PR 旧合并基）。
// 规则逐事件的取值与端到端（#1292 形状、dispatch 空基线）在 ci-base.test.mjs。
const LOADS_CI_BASE = "git('show', 'origin/main:scripts/ci/ci-base.mjs')";
test('传比较基线的作业都先跑 train-base（ci-base.mjs），不在步骤里自设基线', () => {
  const all = jobs(text);
  assert.ok(all.has('contract-placement') && all.has('ci-suites'), [...all.keys()].join(','));
  const users = [];
  for (const [id, block] of all) {
    const values = [...block.matchAll(BASE_ENV)].map(m => m[2]);
    const usesBase = values.length > 0 || /\$CI_BASE_SHA|ci-required-selection\.mjs --run/.test(block);
    if (!usesBase) continue;
    users.push(id);
    assert.match(block, /id: train-base\n/, `${id} 没有 train-base 步骤`);
    assert.ok(block.includes(LOADS_CI_BASE), `${id} 的 train-base 不从 main 读 ci-base.mjs`);
    for (const value of values) {
      // hosted-gitleaks 用 R1 原文：基线经区间步骤取，区间步骤的推送基线取自 train-base。
      assert.equal(value, '${{ steps.range.outputs.base }}', `${id} 在步骤里自设基线：${value}`);
      assert.match(block, /\n {10}PUSH_BASE: \$\{\{ steps\.train-base\.outputs\.ci_base \}\}\n/, `${id} 的区间步骤不从 train-base 取推送基线`);
    }
  }
  assert.match(all.get('contract-placement'), /--base "\$CI_BASE_SHA"/, 'contract-placement 用 CI_BASE_SHA 比较');
  assert.ok(users.includes('contract-placement'), `contract-placement 应传基线：${users.join(',')}`);
});

// 任务 df4bdf98：托管跑套件的步骤拿不到 CI_BASE_SHA 时，ci-required-selection 判“CI_BASE_SHA is not a commit”，
// 不做失败后整条命令重跑的偶发容错。现在它来自同作业 train-base 写的 GITHUB_ENV，与自托管同一规则。
test('托管每个跑 ci-required-selection --run* 的步骤都在 train-base 之后，且不自设 CI_BASE_SHA', () => {
  let steps = 0;
  for (const [id, block] of jobs(text)) {
    const parts = block.split(/\n      - /);
    const at = parts.findIndex(step => /\n {8}id: train-base\n/.test(`\n${step}\n`));
    parts.forEach((step, i) => {
      if (!/ci-required-selection\.mjs --run/.test(step)) return;
      steps += 1;
      assert.ok(at >= 0 && at < i, `${id} 跑套件前没有 train-base：${step.split('\n')[0]}`);
      assert.doesNotMatch(step, /^\s+CI_BASE_SHA:/m, `${id} 的步骤自设 CI_BASE_SHA，盖过 train-base 写的值`);
    });
  }
  assert.ok(steps >= 4, `应至少覆盖 4 个跑套件步骤：${steps}`);
});

// 影子对比要比的是同一选择：托管的 --check 与自托管 clued-required-tests.yml 逐字同参数（--check 带 --root 会多选候选自加的套件）。
test('选择套件的 --check 参数与自托管一致', () => {
  const selfHosted = readFileSync(new URL('../../.github/workflows/clued-required-tests.yml', import.meta.url), 'utf8');
  // Trivy 的 sha256sum 也使用 --check；这里只比较选择器的调用。
  const invocation = /\bnode (?:[^\s"']*ci-required-selection\.mjs|"\$selector") (--check [^"'`;|&\n]*)/g;
  const checks = source => [...source.matchAll(invocation)].map(m => m[1].trim()).sort();
  assert.deepEqual(checks(text), checks(selfHosted));
});

// 主机缺什么只由托管工作流自己声明（FABLE-hosted-windows-suites §2.3、§2.4）：唯一入口读 CLUED_CI_HOST_LACKS，
// 不跑带 [needs:<能力>] 的用例。节点工作流若也设了它，节点上这些用例会悄悄不跑，所以 .github 下别处出现即红；
// 托管的 Windows 套件步骤只声明 non-elevated（作业进程是提权管理员，日志已证实）。S8 删托管工作流时本条一起删。
test('只有 hosted-required.yml 的 Windows 套件步骤声明 CLUED_CI_HOST_LACKS: non-elevated，.github 下别处出现即红', () => {
  const root = fileURLToPath(new URL('../../.github/', import.meta.url));
  const elsewhere = readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => path.join(e.parentPath ?? e.path, e.name))
    .filter(file => path.relative(root, file).replaceAll('\\', '/') !== 'workflows/hosted-required.yml')
    .filter(file => readFileSync(file, 'utf8').includes('CLUED_CI_HOST_LACKS'))
    .map(file => path.relative(root, file).replaceAll('\\', '/'));
  assert.deepEqual(elsewhere, [], '只有托管工作流可以声明主机缺的能力');
  assert.equal(text.split('CLUED_CI_HOST_LACKS').length, 2, 'hosted-required.yml 只声明一处');
  const windows = jobs(text).get('ci-suites-windows-shard') ?? '';
  const at = windows.indexOf('- name: Select and run the suites declared for Windows');
  assert.ok(at >= 0, 'Windows 套件步骤还在');
  const step = windows.slice(at).split(/\n {6}- /)[0];
  assert.match(step, /\n {10}CLUED_CI_HOST_LACKS: non-elevated\n/, '声明在 Windows 套件那一步的 env 里');
  for (const [id, block] of jobs(text)) if (id !== 'ci-suites-windows-shard') assert.doesNotMatch(block, /CLUED_CI_HOST_LACKS/, id);
});

// 任务 3435f8bf：作业级上限只兜底挂死，不当速度门。修可信侧的 PR 跑的是 main 的可信侧（选择、命令、test-env），
// 自己的修复用不上，改动又喂所有套件，于是“最慢的环境跑最多套件”；45 分钟贴着实测 44–45 分钟，修慢的 PR 被慢卡死。
// 跑套件的托管作业上限不低于 90（约实测最长正常耗时 2 倍）。migration-verify 的分片只跑 production-schema 一个套件，自有 30 分钟预算，不在此列。
const SUITE_TIMEOUT_FLOOR = 90;
test(`跑 ci-required-selection --run/--run-selected 套件的托管作业 timeout-minutes 不低于 ${SUITE_TIMEOUT_FLOOR}`, () => {
  const checked = [];
  for (const [id, block] of jobs(text)) {
    if (id === 'migration-verify-shard' || !/ci-required-selection\.mjs --run(?:-selected)? /.test(block)) continue;
    const m = /^    timeout-minutes:\s*(\d+)\s*$/m.exec(block);
    assert.ok(m, `${id} 没有作业级 timeout-minutes`);
    assert.ok(Number(m[1]) >= SUITE_TIMEOUT_FLOOR, `${id} 的 timeout-minutes 是 ${m[1]}，低于 ${SUITE_TIMEOUT_FLOOR}`);
    checked.push(id);
  }
  assert.deepEqual(checked.sort(), ['ci-suites-shard', 'ci-suites-windows-shard', 'clued-cloud-tests-shard']);
});

// 任务 3435f8bf 块 1：托管 Windows 作业在跑套件前把镜像预热好的模块分析缓存复制到默认位置（快不快由非必需的
// hosted-ci-suites-windows-duration 判）。它是辅助步骤，出错只能“不做”，不能让作业红，也不能拖住作业：步级上限 ≤ 2 分钟。S8 删托管工作流时本条一起删。
test('托管 Windows 作业在跑套件前预热默认分析缓存，且这一步失败不让作业红', () => {
  const steps = (jobs(text).get('ci-suites-windows-shard') ?? '').split(/\n {6}- /);
  const at = name => steps.findIndex(s => s.startsWith(`name: ${name}\n`));
  const warm = at('Warm the default PowerShell module analysis cache');
  assert.ok(warm > at('Configure job temporary storage') && at('Configure job temporary storage') > 0, '预热在配置临时存储之后');
  assert.ok(warm < at('Select and run the suites declared for Windows'), '预热在跑套件之前');
  assert.match(steps[warm], /\n {8}continue-on-error: true\n/, '辅助步骤失败不挡作业');
  const limit = /\n {8}timeout-minutes:\s*(\d+)\s*\n/.exec(steps[warm]);
  assert.ok(limit && Number(limit[1]) <= 2, `辅助步骤有步级 timeout-minutes 且 ≤ 2：${limit?.[1] ?? '没有'}`);
  assert.match(steps[warm], /GetEnvironmentVariable\('PSModuleAnalysisCachePath', 'Machine'\)/);
  assert.match(steps[warm], /GetFolderPath\('LocalApplicationData'\)\) 'Microsoft\\Windows\\PowerShell\\ModuleAnalysisCache'/);
});

// ---- 任务 3435f8bf 块 4：Windows 套件分片（PLAN-hosted-windows-speed-20261123 §3.2、§4 V5；裁定 FABLE-hosted-b3-L2-ruling-20261124） ----
// 分片作业跑同一份 --run-selected 计划的第 i/n 片；n 取 strategy.job-total，只在矩阵列表写一处。列表必须正好是 1..n：
// 少写一个号（如 [1, 2, 4]）那一片就没人跑，汇总照样绿。S8 删托管工作流时这几条一起删。
test('Windows 分片由 PowerShell 运行并传回选择器退出码', () => {
  const shard = jobs(text).get('ci-suites-windows-shard') ?? '';
  assert.match(shard, /^    name: \$\{\{ format\('hosted-ci-suites-windows-shard-\{0\}', matrix\.shard\) \}\}$/m);
  assert.match(shard, /^    runs-on: windows-2025$/m);
  assert.match(shard, /^    timeout-minutes: 90$/m);
  const at = shard.indexOf('- name: Select and run the suites declared for Windows');
  assert.ok(at >= 0, 'Windows 套件步骤还在');
  const step = shard.slice(at).split(/\n {6}- /)[0];
  assert.match(step, /\n {10}& node trusted\/scripts\/ci\/ci-required-selection\.mjs --run-selected ci-suites --root candidate --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}\n {10}exit \$LASTEXITCODE\n/);
});

// 必需检查 hosted-ci-suites-windows 是汇总作业：一个判断，别的都没有（裁定“块 4 汇总作业的要求”）。逐字钉住整个作业：
// 汇总作业在普通事件上用 always() 检查分片结果。关闭事件只取消旧运行，汇总作业也跳过。
const summaryJob = (name, needs, step) => [
  `    name: ${name}`,
  `    needs: ${needs}`,
  "    if: always() && github.event.action != 'closed'" + STAGING_GATE,
  '    runs-on: ubuntu-24.04',
  '    timeout-minutes: 5',
  '    permissions: {}',
  '    steps:',
  `      - name: ${step}`,
  '        env:',
  `          RESULT: \${{ needs.${needs}.result }}`,
  '          TMPDIR: ${{ runner.temp }}',
  '          TMP: ${{ runner.temp }}',
  '          TEMP: ${{ runner.temp }}',
  '          PYTHONPYCACHEPREFIX: ${{ runner.temp }}/clued-pycache',
  '          WRANGLER_LOG_PATH: ${{ runner.temp }}/clued-wrangler-logs',
  '        run: |',
  `          echo "${name}-shard-*: $RESULT"`,
  '          test "$RESULT" = success',
].join('\n');
const SUMMARY_JOB = summaryJob('hosted-ci-suites-windows', 'ci-suites-windows-shard', 'Every Windows suite shard succeeded');
const jobLines = id => {
  const lines = (jobs(text).get(id) ?? '').split('\n');
  // 作业块末尾的空行和注释属于下一个作业的说明。
  while (lines.length && (lines.at(-1).trim() === '' || lines.at(-1).trimStart().startsWith('#'))) lines.pop();
  return lines.join('\n');
};
test('块 4：hosted-ci-suites-windows 是汇总作业，只有一步，只判分片作业的 result 是不是 success', () => {
  assert.equal(jobLines('ci-suites-windows'), SUMMARY_JOB);
});

// ---- 任务 3435f8bf 件甲（PLAN-ci-p90-next-20261125 §3.1；形状同 FABLE-ci-duration-target-20261124 §2.5）：三个长作业分片 ----
// 检查名不变：hosted-<检查名> 是同名汇总作业。除关闭事件外，它总是检查自己矩阵的结果。
// 分片作业 <作业名>-shard、检查名 hosted-<检查名>-shard-<i>，跑同一份 --run-selected 计划的第 i/n 片，n 只写在矩阵列表。
// S8 删托管工作流时本节一起删。
const SHARDED = [
  { id: 'migration-verify', check: 'migration-verify', name: 'hosted-migration-verify', shards: 4, step: 'Every migration verification shard succeeded' },
  { id: 'ci-suites', check: 'ci-suites', name: 'hosted-ci-suites', shards: 4, step: 'Every Linux suite shard succeeded' },
  { id: 'ci-suites-windows', check: 'ci-suites', name: 'hosted-ci-suites-windows', shards: 7, step: 'Every Windows suite shard succeeded' },
  { id: 'clued-cloud-tests', check: 'clued-cloud-tests', name: 'hosted-clued-cloud-tests', shards: 2, step: 'Every application test shard succeeded' },
];
const SHARD_RUN = check => new RegExp(`ci-required-selection\\.mjs --run-selected ${check} --root candidate --shard \\$\\{\\{ matrix\\.shard \\}\\}/\\$\\{\\{ strategy\\.job-total \\}\\}(?:\\n|$)`);
test('分片作业跑 --run-selected <检查名> --shard i/n，片号正好 1..n，片数 4、4、7、2 只写在矩阵列表', () => {
  for (const { id, check, name, shards } of SHARDED) {
    const block = jobs(text).get(`${id}-shard`) ?? '';
    assert.ok(block, `${id}-shard 作业在`);
    assert.ok(block.split('\n').includes(`    name: \${{ format('${name}-shard-{0}', matrix.shard) }}`), `${id}-shard 的检查名是 ${name}-shard-<i>`);
    const matrix = /\n    strategy:\n      fail-fast: false\n      matrix:\n        shard: \[([0-9, ]+)\]\n/.exec(block);
    assert.ok(matrix, `${id}-shard：矩阵是 strategy.fail-fast: false 加 matrix.shard 列表`);
    const list = matrix[1].split(',').map(n => Number(n.trim()));
    assert.deepEqual(list, Array.from({ length: shards }, (_, i) => i + 1), `${id}-shard 片号应为 1..${shards}：${matrix[1]}`);
    const runs = block.split(/\n {6}- /).filter(step => /ci-required-selection\.mjs --run/.test(step));
    assert.equal(runs.length, 1, `${id}-shard 只有一步跑套件`);
    assert.match(runs[0], SHARD_RUN(check), `${id}-shard 跑 --run-selected ${check} 的第 i/n 片`);
    // 各片自己读 PR 的改动文件：没有令牌就读不到，每片都跑全部套件。
    assert.match(runs[0], /\n {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}\n/, `${id}-shard 跑套件那一步带 GITHUB_TOKEN`);
  }
  assert.equal(text.split('--shard ').length, SHARDED.length + 1, '每个矩阵只有一个分片入口');
});

test('各矩阵的同名必需检查只汇总分片作业的 result', () => {
  for (const { id, name, step } of SHARDED) assert.equal(jobLines(id), summaryJob(name, `${id}-shard`, step), id);
});

test('件甲：未选中时 migration-verify 各片走 Not affected，不装依赖、不跑套件', () => {
  const steps = (jobs(text).get('migration-verify-shard') ?? '').split(/\n {6}- /);
  const at = name => steps.find(s => s.startsWith(`name: ${name}\n`)) ?? '';
  assert.match(at('Install the application dependencies'), /\n {8}if: steps\.select\.outputs\.run_production_schema == 'true'\n/);
  assert.match(at('Verify migrations on the production schema'), /\n {8}if: steps\.select\.outputs\.run_production_schema == 'true'\n/);
  assert.match(at('Not affected'), /\n {8}if: steps\.select\.outputs\.run_production_schema != 'true'\n/);
});

// 时长作业只显红、不挡合入：名字不是任何必需检查（规则集要的是 hosted-ci-suites-windows，影子比对按名字配对七项）。
test('块 4：时长作业非必需，不在影子比对的七项里，只读 actions，跑 hosted-windows-duration.mjs', async () => {
  const block = jobs(text).get('ci-suites-windows-duration') ?? '';
  assert.match(block, /^    name: hosted-ci-suites-windows-duration$/m);
  assert.match(block, /^    needs: ci-suites-windows-shard$/m);
  assert.ok(block.split('\n').includes("    if: always() && github.event.action != 'closed'" + STAGING_GATE));
  assert.match(block, /\n    permissions:\n      actions: read\n      contents: read\n    steps:\n/);
  assert.match(block, /\n {8}run: node candidate\/scripts\/ci\/hosted-windows-duration\.mjs(?:\n|$)/);
  const { PAIRS } = await import('./shadow-compare.mjs');
  const paired = PAIRS.map(pair => pair.hosted.name);
  assert.ok(paired.includes('hosted-ci-suites-windows'));
  for (const name of ['hosted-ci-suites-windows-duration', 'hosted-ci-suites-windows-shard-1']) assert.ok(!paired.includes(name), name);
});

// ---- hosted-gitleaks = 自托管 R1 的区间扫描（PLAN-hosted-stale-base-20261123 第 2、3 节） ----
// 旧定义抄自已停用 gitleaks.yml 的全历史扫描，断言“现场 main 尖端 == 事件负载 base.sha”。负载 base.sha 是 PR 记录上的
// 快照：reopened、手工重跑、运行期间 main 前进都会让它和现场 main 不等，红与 PR 无关。新定义只扫 base..head，不取现场 main。
const SELF_HOSTED = readFileSync(new URL('../../.github/workflows/clued-required-tests.yml', import.meta.url), 'utf8');
const R1_STEPS = ['Resolve the changed range', 'Copy the changed history into a fresh Git directory', 'Scan the changed range with Gitleaks 8.30.1'];

// 作业文本里的一步：env（键 → 原值）与 run（去掉 10 格缩进的块文本）。纯文本，不引 YAML 依赖。
function stepOf(block, name) {
  const raw = block.split(/\n {6}- /).find(s => s.startsWith(`name: ${name}\n`));
  assert.ok(raw, `没有一步叫 ${name}`);
  const lines = raw.split('\n');
  const env = {};
  const envAt = lines.indexOf('        env:');
  if (envAt >= 0) {
    for (const line of lines.slice(envAt + 1)) {
      const m = /^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
      if (!m) break;
      env[m[1]] = m[2];
    }
  }
  const runAt = lines.indexOf('        run: |');
  assert.ok(runAt >= 0, `${name} 没有 run 块`);
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  while (body.length && body.at(-1) === '') body.pop();
  return { env, run: `${body.join('\n')}\n` };
}
// 检出到 trusted 的那一步的 ref。
const trustedRef = block => block.split(/\n {6}- /).map(s => /\n {10}ref: ([^\n]+)\n(?: {10}[^\n]*\n)*? {10}path: trusted(?:\n|$)/.exec(s))
  .find(Boolean)?.[1];

test('hosted-gitleaks 的三步与自托管 R1 gitleaks 作业逐字一致，受信检出 ref 与其他托管作业相同', () => {
  const hosted = jobs(text).get('gitleaks');
  const r1 = jobs(SELF_HOSTED).get('gitleaks');
  assert.ok(hosted && r1, '两边都要有 gitleaks 作业');
  for (const name of R1_STEPS) {
    const a = stepOf(hosted, name);
    const b = stepOf(r1, name);
    assert.equal(a.run, b.run, `${name} 的 run 与自托管不一致`);
    assert.deepEqual(a.env, b.env, `${name} 的 env 与自托管不一致`);
  }
  const want = trustedRef(jobs(text).get('clued-cloud-tests-shard'));
  assert.ok(want, 'clued-cloud-tests-shard 的受信检出没有 ref');
  for (const id of ['ci-suites-shard', 'migration-verify-shard']) assert.equal(trustedRef(jobs(text).get(id)), want, id);
  assert.equal(trustedRef(hosted), want, 'hosted-gitleaks 的受信检出 ref 与其他托管作业不同');
  assert.match(hosted, /\n {6}- name: Check out the candidate\n[\s\S]*?\n {10}fetch-depth: 0\n {10}path: candidate\n/, '候选检出要全历史');
  assert.match(hosted, /\n {8}id: train-base\n/, '没有 train-base 步骤');
});

test('hosted-gitleaks 不读现场 main：作业里没有 refs/heads/main、github.com/$GITHUB_REPOSITORY、FETCH_TOKEN', () => {
  const block = jobs(text).get('gitleaks');
  assert.ok(block, 'hosted-required.yml 没有 gitleaks 作业');
  for (const needle of ['refs/heads/main', 'github.com/$GITHUB_REPOSITORY', 'FETCH_TOKEN']) {
    assert.ok(!block.includes(needle), `gitleaks 作业里还有 ${needle}`);
  }
});

// 旧 base 场景：main=A，H 从 A 分出，main 前进到 B，GitHub 的合并 M=merge(B,H)，事件负载仍是 PR_BASE=A。
// 用工作流里这三步原文真跑（docker 换成跑桩 gitleaks 的替身，与 gitleaks-range.test.mjs 同法）：区间 A..H 扫过且干净即过；
// H 里加一条假密钥则非 0。
function gitBash() {
  if (process.platform !== 'win32') return 'bash';
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const bash = exec && path.resolve(exec, '..', '..', '..', 'bin', 'bash.exe');
  return bash && existsSync(bash) ? bash : null;
}
const BASH = gitBash();
const noBash = BASH ? false : '找不到 Git for Windows 的 bash';
const fwd = p => p.replace(/\\/g, '/');

test('应用分片仅在可信选择器尚未声明每片构建时预构建 dist', { skip: noBash }, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'clued-hosted-shard-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trusted = path.join(root, 'trusted', 'scripts', 'ci');
  mkdirSync(trusted, { recursive: true });
  const buildStep = 'Build application for a trusted selector predating per-shard build';
  const steps = jobs(text).get('clued-cloud-tests-shard');
  assert.ok(steps.indexOf('Install the application dependencies') < steps.indexOf(buildStep));
  assert.ok(steps.indexOf(buildStep) < steps.indexOf('Run the selected application shard'));
  const { run } = stepOf(steps, buildStep);
  for (const every of [false, true]) {
    writeFileSync(path.join(trusted, 'ci-required-selection.mjs'), `export const SUITE_COMMANDS = { 'clued-cloud': [{ every: ${every} }] };\n`);
    const r = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `npm() { echo "$*"; }\n${run}`],
      { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(r.stdout.trim(), every ? '' : '--prefix candidate/apps/clued-cloud run build');
  }
});

// 仓库 generic-api-key 规则命中的样子；运行时拼出，本文件自身不带命中。
const LEAK = ['const k = { policy', "Key: 'park.stage8Retries", "Per24h' };\n"].join('');
const STUB = `import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2);
const src = a[a.indexOf('git') + 1];
const opts = (a.find((x) => x.startsWith('--log-opts=')) || '--log-opts=').slice(11).split(/\\s+/).filter(Boolean);
const r = spawnSync('git', ['-C', src, 'log', '-p', '-U0', '--no-color', ...opts], { encoding: 'utf8' });
if (r.status !== 0) { console.log('ERR [git] ' + (r.stderr || '').trim()); process.exit(0); }
if (/^\\+.*policyKey: '/m.test(r.stdout)) { console.log('Finding: policyKey: REDACTED'); process.exit(1); }
console.log('INF no leaks found');
`;
const fakeDocker = stub => `import { spawnSync } from 'node:child_process';
const a = process.argv.slice(2);
if (a[0] === 'image' || a[0] === 'pull') process.exit(0);
if (a[0] !== 'run') process.exit(9);
for (const f of ['--network=none', '--read-only', '--pull=never', '--cap-drop=ALL']) if (!a.includes(f)) { console.error('fake docker: missing ' + f); process.exit(9); }
const mount = a.find((x) => /dst=\\/repo,/.test(x)) || '';
const src = /src=([^,]+)/.exec(mount)[1];
const args = a.slice(a.indexOf('/usr/bin/gitleaks') + 2).map((x) => x === '/repo' ? src : x);
process.exit(spawnSync(process.execPath, [${JSON.stringify(stub)}, ...args], { stdio: 'inherit' }).status ?? 1);
`;

function staleBaseRun(headFiles) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hosted-gitleaks-stale-'));
  try {
    const globalConfig = path.join(tmp, 'gitconfig');
    writeFileSync(globalConfig, '[user]\n\tname = t\n\temail = t@invalid\n[commit]\n\tgpgSign = false\n[core]\n\thooksPath =\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
    const git = (cwd, ...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    const commit = (dir, files, message) => {
      for (const [file, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        writeFileSync(path.join(dir, file), body);
      }
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', message);
      return git(dir, 'rev-parse', 'HEAD');
    };
    const origin = path.join(tmp, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const policy = readFileSync(path.join(root, '.gitleaks.toml'), 'utf8');
    const A = commit(origin, { '.gitleaks.toml': policy, 'src/a.txt': 'a\n' }, 'A');
    git(origin, 'checkout', '-q', '-b', 'work');
    const H = commit(origin, { '.gitleaks.toml': `${policy}\n# candidate change\n`, ...headFiles }, 'H');
    git(origin, 'checkout', '-q', 'main');
    const B = commit(origin, { 'src/main.txt': 'main moves\n' }, 'B');
    const ws = path.join(tmp, 'ws');
    const temp = path.join(ws, '_temp');
    const candidate = path.join(ws, 'candidate');
    mkdirSync(path.join(ws, 'trusted', 'scripts', 'ci'), { recursive: true });
    mkdirSync(temp);
    git(tmp, 'clone', '-q', '--no-local', origin, candidate);
    // GitHub 的合并：现场 main（B）并上 head（H），H 是第二父。
    git(candidate, 'checkout', '-q', '--detach', B);
    git(candidate, 'merge', '-q', '--no-ff', '--no-edit', H);
    const M = git(candidate, 'rev-parse', 'HEAD');
    copyFileSync(path.join(root, 'scripts', 'ci', 'gitleaks-range.sh'), path.join(ws, 'trusted', 'scripts', 'ci', 'gitleaks-range.sh'));
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'stub.mjs'), STUB);
    writeFileSync(path.join(bin, 'fake-docker.mjs'), fakeDocker(fwd(path.join(bin, 'stub.mjs'))));
    const docker = path.join(bin, 'docker');
    writeFileSync(docker, `#!/usr/bin/env bash\nexec "${fwd(process.execPath)}" "${fwd(path.join(bin, 'fake-docker.mjs'))}" "$@"\n`);
    chmodSync(docker, 0o755);
    const output = path.join(temp, 'output');
    writeFileSync(output, '');
    // MSYS_NO_PATHCONV：Git for Windows 的 bash 会把容器路径 /repo 改写成 Windows 路径。
    const shared = { ...env, MSYS_NO_PATHCONV: '1', GITHUB_WORKSPACE: fwd(ws), RUNNER_TEMP: fwd(temp), GITHUB_SHA: M,
      GITHUB_OUTPUT: fwd(output), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const run = (script, cwd, extra) => {
      const r = spawnSync(BASH, ['-e', '-c', script], { cwd, encoding: 'utf8', env: { ...shared, ...extra } });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };
    const block = jobs(text).get('gitleaks');
    assert.ok(block, 'hosted-required.yml 没有 gitleaks 作业');
    const [rangeStep, copyStep, scanStep] = R1_STEPS.map(name => stepOf(block, name));
    let r = run(rangeStep.run, candidate, { EVENT_NAME: 'pull_request', PR_BASE: A, PR_HEAD: H, PUSH_BASE: '' });
    assert.equal(r.code, 0, r.out);
    const out = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(l => l.split('=')));
    assert.deepEqual(out, { base: A, head: H });
    r = run(copyStep.run, ws, { BASE: A, HEAD: H, TRUSTED_BASE_SHA: A });
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path.join(temp, 'clued-gitleaks', 'repo', '.gitleaks.toml'), 'utf8'), policy);
    return run(scanStep.run, ws, { BASE: A, HEAD: H });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('hosted-gitleaks 在旧 base（负载 base.sha 落后现场 main）下照常扫 PR 区间：干净则过', { skip: noBash }, () => {
  const r = staleBaseRun({ 'src/h.txt': 'h\n' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /scanned, no finding/);
});

test('hosted-gitleaks 在旧 base 下 PR 带假密钥则红', { skip: noBash }, () => {
  const r = staleBaseRun({ 'src/h.js': LEAK });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /gitleaks exited 1/);
});

// 块 4：汇总作业那一步原文真跑（与 GitHub 的 bash 同参数）：分片作业的 result 只有 success 退出 0；失败、取消、跳过、空值都红。
test('汇总步骤实际执行，只有分片作业 result 为 success 才退出 0', { skip: noBash }, () => {
  for (const { id, step } of SHARDED) {
    const { run } = stepOf(jobs(text).get(id), step);
    for (const [result, code] of [['success', 0], ['failure', 1], ['cancelled', 1], ['skipped', 1], ['', 1]]) {
      const r = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], { encoding: 'utf8', env: { ...process.env, RESULT: result } });
      assert.equal(r.status, code, `${id} ${result || '(空)'}: ${r.stdout}${r.stderr}`);
    }
  }
});
