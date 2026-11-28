import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { firstInstallCheck } from '../fleet/install.mjs';
import { acceptanceOf } from '../fleet/publish.mjs';
import { releaseAssets } from '../fleet/test/delivery-release-fixture.mjs';
import { checkWindowsBoundary } from '../fleet/test/windows-delivery-fixture.mjs';

test('Windows 主机夹具保留位于 runner 根目录下的测试工作路径', { skip: process.platform !== 'win32' }, () => {
  const launcher = fileURLToPath(new URL('../fleet/test/launcher-check-host.py', import.meta.url));
  const check = spawnSync('python', ['-I', '-B', '-X', 'utf8', '-c', String.raw`
import json
from pathlib import Path
import runpy
import sys
from unittest.mock import patch

launcher = sys.argv[1]
work = Path(r'C:\clued-ci\runner\_work\_temp\reinstall')
plan_file = work / 'install-plan.json'
sys.argv = [launcher, r'D:\resident-fixture', 'sddl', 'generate.py', '--fleet-plan', str(plan_file), '--check']
fixture_reads = [
    json.dumps({'packageDir': str(work / 'package')}).encode(),
    json.dumps({'node': {'ownerProfileDirectory': r'C:\Users\FixtureOwner'}}).encode(),
]
# 加载原夹具的映射函数，模拟所有初始化文件操作和生成器调用。
load_launcher = runpy.run_path
with (patch.object(Path, 'read_bytes', side_effect=fixture_reads),
      patch.object(Path, 'mkdir'), patch.object(Path, 'is_dir', return_value=True),
      patch('runpy.run_path')):
    fixture_path = load_launcher(launcher)['fixture_path']

for original in (work, plan_file, str(plan_file).upper()):
    mapped = fixture_path(original)
    assert mapped is original, f'测试工作路径被重写: {original} -> {mapped}'

sibling = Path(str(work) + '-other') / 'install-plan.json'
expected = work / 'host-fixture' / 'clued-ci' / sibling.relative_to(r'C:\clued-ci')
assert fixture_path(sibling) == expected, '同名前缀的相邻目录仍应映射到隔离夹具'
`, launcher], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.error?.message ?? check.stderr);
});

test('Windows 使用真实舰队资产验证首装操作人和重装计划', { skip: process.platform !== 'win32' }, async t => {
  // 包内 Record CLI 也会拒绝未来的接受时刻。
  const now = Date.parse('2026-11-01T00:00:00Z');
  const w = await releaseAssets(t, now);
  const request = JSON.parse(await fs.readFile(w.prepared.request, 'utf8'));
  const acceptance = acceptanceOf(request, { decision: randomUUID(), receipt: randomUUID(), acceptedAt: new Date(now).toISOString() });
  const checked = await firstInstallCheck({ artifactPath: w.build.tar, artifactSha256: acceptance.archive_sha256, acceptance, from: w.out, now });
  assert.equal(checked.status, 'FIRST_INSTALL_INPUTS_ACCEPTED');
  assert.equal(checked.kitSha256, w.prepared.firstInstallKitSha256);
  await checkWindowsBoundary(t, w, acceptance, checked, now);
});
