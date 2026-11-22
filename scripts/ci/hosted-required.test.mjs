// 托管脚手架 hosted-required.yml 的结构约束（任务 04f9b91b）。纯文本读取；gitleaks 一条另读 Native 的固定值来源。
// staging 会被列车强制改指：上一批没落地时 github.event.before 在检出里不存在，拿它当基线检查就报错变红。
// 所以凡是给命令传比较基线的作业，staging 推送时一律按 stagingBaseFromCheckout 现算（与四个测试作业同一来源）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

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
