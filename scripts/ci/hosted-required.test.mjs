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

// 任务 df4bdf98：托管跑套件的步骤不设 CI_BASE_SHA 时，ci-required-selection 判“CI_BASE_SHA is not a commit”，
// 不做失败后整条命令重跑的偶发容错，必需项遇 1–3 条偶发失败就判红。取值与自托管（steps.train-base.outputs.sha || PR base || ci_base）逐字一致。
test('托管每个跑 ci-required-selection --run* 的步骤都设 CI_BASE_SHA，取值与自托管一致', () => {
  const selfHosted = readFileSync(new URL('../../.github/workflows/clued-required-tests.yml', import.meta.url), 'utf8');
  const want = [...selfHosted.matchAll(/^\s+CI_BASE_SHA:\s*(.+)$/gm)].map(m => m[1].trim());
  assert.ok(want.length > 0 && new Set(want).size === 1, `自托管取值应唯一：${want.join(' | ')}`);
  let steps = 0;
  for (const [id, block] of jobs(text)) {
    for (const step of block.split(/\n      - /)) {
      if (!/ci-required-selection\.mjs --run/.test(step)) continue;
      steps += 1;
      const m = /^\s+CI_BASE_SHA:\s*(.+)$/m.exec(step);
      assert.ok(m, `${id} 的步骤没设 CI_BASE_SHA：${step.split('\n')[0]}`);
      assert.equal(m[1].trim(), want[0], `${id} 的 CI_BASE_SHA 与自托管不一致`);
    }
  }
  assert.ok(steps >= 4, `应至少覆盖 4 个跑套件步骤：${steps}`);
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
  const windows = jobs(text).get('ci-suites-windows') ?? '';
  const at = windows.indexOf('- name: Select and run the suites declared for Windows');
  assert.ok(at >= 0, 'Windows 套件步骤还在');
  const step = windows.slice(at).split(/\n {6}- /)[0];
  assert.match(step, /\n {10}CLUED_CI_HOST_LACKS: non-elevated\n/, '声明在 Windows 套件那一步的 env 里');
  for (const [id, block] of jobs(text)) if (id !== 'ci-suites-windows') assert.doesNotMatch(block, /CLUED_CI_HOST_LACKS/, id);
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
