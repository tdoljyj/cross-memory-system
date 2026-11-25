import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-toolchain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'scripts/ci');
  mkdirSync(scripts, { recursive: true });
  for (const file of ['ci-required-selection.mjs', 'test-env.mjs', 'test-clock-scan.mjs', 'test-clock-guard.mjs', 'test-clock-imports.mjs']) {
    cpSync(new URL(file, import.meta.url), path.join(scripts, file));
  }
  const selector = path.join(scripts, 'ci-required-selection.mjs');
  writeFileSync(path.join(scripts, 'local-suite-slots.mjs'), `
    export function withLocalSuiteSlot() { console.log('套件已启动'); return 0; }
  `);
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config/ci-toolchain.json'), JSON.stringify({ git: '2.43.0' }));
  const hook = path.join(root, 'mock-git.mjs');
  writeFileSync(hook, `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const spawn = childProcess.spawnSync;
    childProcess.spawnSync = (file, args, options) =>
      file === 'git' && args.length === 1 && args[0] === '--version'
        ? { status: 0, stdout: 'git version ' + process.env.FIXTURE_GIT + '\\n' }
        : spawn(file, args, options);
    syncBuiltinESMExports();
  `);
  return (args, git) => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, selector, ...args], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, FIXTURE_GIT: git, GITHUB_ACTIONS: 'false', GITHUB_EVENT_PATH: '', GITHUB_EVENT_NAME: '' },
    });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
}

test('Git 声明 2.43.0、实际 2.56.1 时，单套件和选中套件入口均在开跑前拒绝', (t) => {
  const run = fixture(t);
  for (const args of [['--run', 'retrigger-counter'], ['--run-selected', 'ci-suites']]) {
    const { status, output } = run(args, '2.56.1');
    assert.equal(status, 2, `${args.join(' ')}：${output}`);
    assert.match(output, /环境不符：声明 2\.43\.0，实际 2\.56\.1/);
    assert.doesNotMatch(output, /套件已启动/);
  }
});

test('Git 主次版本相同，允许补丁号及 Windows 后缀不同', (t) => {
  const { status, output } = fixture(t)(['--run', 'retrigger-counter'], '2.43.7.windows.1');
  assert.equal(status, 0, output);
  assert.match(output, /套件已启动/);
});
