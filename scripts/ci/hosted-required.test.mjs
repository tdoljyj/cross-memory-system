// 托管脚手架 hosted-required.yml 的结构约束（任务 04f9b91b）。纯文本读取，零依赖。
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
