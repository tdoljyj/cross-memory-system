// 托管脚手架 hosted-required.yml 的结构约束（任务 04f9b91b）。纯文本读取；gitleaks 一条另读 Native 的固定值来源。
// staging 会被列车强制改指：上一批没落地时 github.event.before 在检出里不存在，拿它当基线检查就报错变红。
// 所以凡是给命令传比较基线的作业，staging 推送时一律按 stagingBaseFromCheckout 现算（与四个测试作业同一来源）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
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
    for (const value of values) assert.match(value, /^\$\{\{ steps\.train-base\.outputs\.sha \|\| /, `${id} 的基线不先取 train-base：${value}`);
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

// hosted-gitleaks 校验的固定值（三个受信文件、审核提交集、审核 ignore）只有一个来源：Native 在跑的 gitleaks worker
// （protected-job-bridge-v4 → formal-gitleaks-v4 → required-history/prepare.mjs）。作业从受信基线读它，自己不抄值；
// 抄来的值会过期（从已停用的 gitleaks.yml 抄的五个值与 main 不符，任务 04f9b91b 缺陷 B）。
const NATIVE_GITLEAKS = 'work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v4/required-history/prepare.mjs';
test('hosted-gitleaks 不抄固定值，从 Native 在跑的 prepare.mjs 读，读到的值与本树文件一致', async () => {
  const block = jobs(text).get('gitleaks');
  assert.ok(block, 'hosted-required.yml 没有 gitleaks 作业');
  const copied = [...block.matchAll(/\b[0-9a-f]{64}\b/g)].map(m => m[0])
    .filter(hex => !block.includes(`gitleaks:v8.30.1@sha256:${hex}`));
  assert.deepEqual(copied, [], 'gitleaks 作业里抄了固定值');
  assert.ok(block.includes(`await import('./${NATIVE_GITLEAKS}')`), `gitleaks 作业不读 ${NATIVE_GITLEAKS}`);
  const read = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  assert.match(read('work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/linux-worker.mjs'),
    /from '\.\.\/formal-gitleaks-v4\/adapter\.mjs'/, 'Native bridge 换了 gitleaks worker，托管作业要跟着改路径');
  const { createHash } = await import('node:crypto');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const m = await import(new URL(`../../${NATIVE_GITLEAKS}`, import.meta.url));
  assert.deepEqual(Object.keys(m.SOURCE_PINS).sort(),
    ['.gitleaks.toml', 'scripts/ci/reviewed_gitleaks.py', 'scripts/ci/reviewed_gitleaks_historical.py']);
  for (const [file, pin] of Object.entries(m.SOURCE_PINS)) {
    assert.equal(sha(readFileSync(new URL(`../../${file}`, import.meta.url))), pin, file);
  }
  const commits = [...new Set([...read('.gitleaks.toml').matchAll(/^# clued-reviewed-finding: \{"fingerprint":"([0-9a-f]{40}):.*$/gm)]
    .map(x => x[1]))].sort();
  assert.equal(sha(`${commits.join('\n')}\n`), m.REVIEWED_COMMITS.sha256, '审核提交集');
  assert.match(m.REVIEWED_HISTORY_PROOF.reviewed_ignore_sha256, /^[0-9a-f]{64}$/);
});

// 托管第 5 步（任务 04f9b91b）：helper 校验两条历史补丁的摘要，摘要含 git 的 index 行，钉的是 8 位缩写；
// 完整历史下 git 自动缩写到 9 位以上，helper 就报 “Reviewed-finding verification failed”。Native 的自检垫片
// 对这两条 diff 固定 core.abbrev=8。托管作业让 helper 的 git 走同一个 safeGitArguments，不另抄规则；
// 这里取工作流里的那段 git.mjs，真跑这两条 diff，摘要必须等于 helper 钉的值。
test('hosted-gitleaks 自检的 git 走 Native 垫片的 safeGitArguments，两条历史补丁摘要与 helper 钉值一致', async () => {
  const block = jobs(text).get('gitleaks');
  const step = block.slice(block.indexOf('- name: Validate exact historical exceptions and detection regressions'));
  const shim = 'work/actions-hosted-migration/independent-ci-v1/worker/formal-gitleaks-v4/required-history/selftest-shim.mjs';
  assert.ok(step.includes(`$PWD/${shim}`), `自检一步不复用 ${shim}`);
  assert.match(step, /PATH="\$shim\/bin:\$PATH" python3 -I -B scripts\/ci\/reviewed_gitleaks\.py/, 'helper 的 git 没有走垫片');
  const source = /cat > "\$shim\/git\.mjs" <<'EOF'\n([\s\S]*?)\n\s*EOF\n/.exec(step);
  assert.ok(source, '自检一步没有写 git.mjs');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const historical = readFileSync(new URL('./reviewed_gitleaks_historical.py', import.meta.url), 'utf8');
  const constant = name => new RegExp(`^${name} = '([0-9a-f]+)'$`, 'm').exec(historical)[1];
  const pins = [[constant('H'), constant('PATCH_SHA')],
    [constant('H2'), /H2: \{[\s\S]*?'patch_sha': '([0-9a-f]{64})'/.exec(historical)[1]]];
  const dir = mkdtempSync(path.join(tmpdir(), 'hosted-gitleaks-shim-'));
  try {
    const file = path.join(dir, 'git.mjs');
    writeFileSync(file, source[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n') + '\n');
    for (const [commit, pin] of pins) {
      const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--diff-algorithm=myers', '--unified=0',
        `${commit}^`, commit, '--', 'scripts/ci/clued-gated-proof-profiles.json'];
      const run = spawnSync(process.execPath, [file, 'git', path.join(root, shim), dir, ...args], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      assert.equal(run.status, 0, `${commit}: ${run.stderr}`);
      assert.equal(createHash('sha256').update(run.stdout).digest('hex'), pin, `${commit} 的补丁摘要（需要完整历史）`);
    }
    const refused = spawnSync(process.execPath, [file, 'git', path.join(root, shim), dir, 'fetch', 'origin'], { cwd: root });
    assert.notEqual(refused.status, 0, '垫片白名单外的 git 命令应被拒');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.deepEqual(checked.sort(), ['ci-suites', 'ci-suites-windows', 'clued-cloud-tests']);
});
