// 托管脚手架 hosted-required.yml 的结构约束（任务 04f9b91b）。纯文本读取；hosted-gitleaks 与自托管 R1 的区间扫描逐字一致并真跑一遍。
// staging 会被列车强制改指：上一批没落地时 github.event.before 在检出里不存在，拿它当基线检查就报错变红。
// 所以凡是给命令传比较基线的作业，staging 推送时一律按 stagingBaseFromCheckout 现算（与四个测试作业同一来源）。
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

test('托管工作流不拿 github.event.before 当基线（staging 强制改指后它可能不存在）', () => {
  assert.doesNotMatch(text, /github\.event\.before/);
});

test('传比较基线的作业都先按 stagingBaseFromCheckout 算出 staging 基线，并从这一步取值', () => {
  const all = jobs(text);
  assert.ok(all.has('contract-placement') && all.has('ci-suites'), [...all.keys()].join(','));
  const users = [];
  for (const [id, block] of all) {
    const values = [...block.matchAll(BASE_ENV)].map(m => m[2]);
    if (values.length === 0) continue;
    users.push(id);
    assert.match(block, /stagingBaseFromCheckout\(process\.env\.STAGING_SHA\)/, `${id} 没有 staging 基线步骤`);
    assert.match(block, /id: train-base\n/, `${id} 的基线步骤不叫 train-base`);
    for (const value of values) {
      // hosted-gitleaks 用 R1 原文：基线经区间步骤取，区间步骤的推送基线取自 train-base（staging 时即 stagingBaseFromCheckout 的结果）。
      if (value === '${{ steps.range.outputs.base }}') {
        assert.match(block, /\n {10}PUSH_BASE: \$\{\{ steps\.train-base\.outputs\.ci_base \}\}\n/, `${id} 的区间步骤不从 train-base 取推送基线`);
        continue;
      }
      assert.match(value, /^\$\{\{ steps\.train-base\.outputs\.sha \|\| /, `${id} 的基线不先取 train-base：${value}`);
    }
  }
  assert.ok(users.includes('contract-placement'), `contract-placement 应传基线：${users.join(',')}`);
});

// 影子对比要比的是同一选择：托管的 --check 与自托管 clued-required-tests.yml 逐字同参数（--check 带 --root 会多选候选自加的套件）。
test('选择套件的 --check 参数与自托管一致', () => {
  const selfHosted = readFileSync(new URL('../../.github/workflows/clued-required-tests.yml', import.meta.url), 'utf8');
  const checks = source => [...source.matchAll(/--check [^"'`;|&\n]*/g)].map(m => m[0].trim()).sort();
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
// 跑套件的托管作业上限不低于 90（约实测最长正常耗时 2 倍）。migration-verify 只跑 production-schema 一个套件，自有 30 分钟预算，不在此列。
const SUITE_TIMEOUT_FLOOR = 90;
test(`跑 ci-required-selection --run/--run-selected 套件的托管作业 timeout-minutes 不低于 ${SUITE_TIMEOUT_FLOOR}`, () => {
  const checked = [];
  for (const [id, block] of jobs(text)) {
    if (id === 'migration-verify' || !/ci-required-selection\.mjs --run(?:-selected)? /.test(block)) continue;
    const m = /^    timeout-minutes:\s*(\d+)\s*$/m.exec(block);
    assert.ok(m, `${id} 没有作业级 timeout-minutes`);
    assert.ok(Number(m[1]) >= SUITE_TIMEOUT_FLOOR, `${id} 的 timeout-minutes 是 ${m[1]}，低于 ${SUITE_TIMEOUT_FLOOR}`);
    checked.push(id);
  }
  assert.deepEqual(checked.sort(), ['ci-suites', 'ci-suites-windows-shard', 'clued-cloud-tests']);
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
test('块 4：Windows 套件分片跑同一份 --run-selected 计划，片号正好 1..n，片数只写在矩阵列表', () => {
  const shard = jobs(text).get('ci-suites-windows-shard') ?? '';
  assert.match(shard, /^    name: \$\{\{ format\('hosted-ci-suites-windows-shard-\{0\}', matrix\.shard\) \}\}$/m);
  assert.match(shard, /^    runs-on: windows-2025$/m);
  assert.match(shard, /^    timeout-minutes: 90$/m);
  const matrix = /\n    strategy:\n      fail-fast: false\n      matrix:\n        shard: \[([0-9, ]+)\]\n/.exec(shard);
  assert.ok(matrix, '矩阵是 strategy.fail-fast: false 加 matrix.shard 列表');
  const shards = matrix[1].split(',').map(n => Number(n.trim()));
  assert.deepEqual(shards, shards.map((_, i) => i + 1), `片号应为 1..n：${matrix[1]}`);
  assert.equal(shards.length, 4);
  const at = shard.indexOf('- name: Select and run the suites declared for Windows');
  assert.ok(at >= 0, 'Windows 套件步骤还在');
  const step = shard.slice(at).split(/\n {6}- /)[0];
  assert.match(step, /\n {10}& node trusted\/scripts\/ci\/ci-required-selection\.mjs --run-selected ci-suites --root candidate --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}\n {10}exit \$LASTEXITCODE\n/);
  assert.equal(text.split('--shard ').length, 2, '整个工作流只有这一处 --shard');
});

// 必需检查 hosted-ci-suites-windows 是汇总作业：一个判断，别的都没有（裁定“块 4 汇总作业的要求”）。逐字钉住整个作业：
// 多一步、多一个条件、换成读产物或调 API、把 always() 改掉（跳过的必需检查会被当成通过），都红。
const SUMMARY_JOB = [
  '    name: hosted-ci-suites-windows',
  '    needs: ci-suites-windows-shard',
  '    if: always()',
  '    runs-on: ubuntu-24.04',
  '    timeout-minutes: 5',
  '    permissions: {}',
  '    steps:',
  '      - name: Every Windows suite shard succeeded',
  '        env:',
  '          RESULT: ${{ needs.ci-suites-windows-shard.result }}',
  '          TMPDIR: ${{ runner.temp }}',
  '          TMP: ${{ runner.temp }}',
  '          TEMP: ${{ runner.temp }}',
  '          PYTHONPYCACHEPREFIX: ${{ runner.temp }}/clued-pycache',
  '          WRANGLER_LOG_PATH: ${{ runner.temp }}/clued-wrangler-logs',
  '        run: |',
  '          echo "hosted-ci-suites-windows-shard-*: $RESULT"',
  '          test "$RESULT" = success',
].join('\n');
test('块 4：hosted-ci-suites-windows 是汇总作业，只有一步，只判分片作业的 result 是不是 success', () => {
  const lines = (jobs(text).get('ci-suites-windows') ?? '').split('\n');
  // 作业块末尾的空行和注释属于下一个作业的说明。
  while (lines.length && (lines.at(-1).trim() === '' || lines.at(-1).trimStart().startsWith('#'))) lines.pop();
  assert.equal(lines.join('\n'), SUMMARY_JOB);
});

// 时长作业只显红、不挡合入：名字不是任何必需检查（规则集要的是 hosted-ci-suites-windows，影子比对按名字配对七项）。
test('块 4：时长作业非必需，不在影子比对的七项里，只读 actions，跑 hosted-windows-duration.mjs', async () => {
  const block = jobs(text).get('ci-suites-windows-duration') ?? '';
  assert.match(block, /^    name: hosted-ci-suites-windows-duration$/m);
  assert.match(block, /^    needs: ci-suites-windows-shard$/m);
  assert.match(block, /^    if: always\(\)$/m);
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
  const want = trustedRef(jobs(text).get('clued-cloud-tests'));
  assert.ok(want, 'clued-cloud-tests 的受信检出没有 ref');
  for (const id of ['ci-suites', 'migration-verify']) assert.equal(trustedRef(jobs(text).get(id)), want, id);
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
    const A = commit(origin, { 'src/a.txt': 'a\n' }, 'A');
    git(origin, 'checkout', '-q', '-b', 'work');
    const H = commit(origin, headFiles, 'H');
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
    const root = fileURLToPath(new URL('../../', import.meta.url));
    copyFileSync(path.join(root, '.gitleaks.toml'), path.join(ws, 'trusted', '.gitleaks.toml'));
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
      const r = spawnSync(BASH, ['-e', '-c', script], { cwd, encoding: 'utf8', env: { ...shared, ...extra }, timeout: 240000 });
      return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
    };
    const block = jobs(text).get('gitleaks');
    assert.ok(block, 'hosted-required.yml 没有 gitleaks 作业');
    const [rangeStep, copyStep, scanStep] = R1_STEPS.map(name => stepOf(block, name));
    let r = run(rangeStep.run, candidate, { EVENT_NAME: 'pull_request', PR_BASE: A, PR_HEAD: H, PUSH_BASE: '' });
    assert.equal(r.code, 0, r.out);
    const out = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(l => l.split('=')));
    assert.deepEqual(out, { base: A, head: H });
    r = run(copyStep.run, ws, { BASE: A, HEAD: H });
    assert.equal(r.code, 0, r.out);
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
test('块 4：汇总作业的判断真跑，只有分片作业 result 为 success 才退出 0', { skip: noBash }, () => {
  const { run } = stepOf(jobs(text).get('ci-suites-windows'), 'Every Windows suite shard succeeded');
  for (const [result, code] of [['success', 0], ['failure', 1], ['cancelled', 1], ['skipped', 1], ['', 1]]) {
    const r = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], { encoding: 'utf8', env: { ...process.env, RESULT: result } });
    assert.equal(r.status, code, `${result || '(空)'}: ${r.stdout}${r.stderr}`);
  }
});
