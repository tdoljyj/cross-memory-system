// The universal node package's node side in CI, part 1 of 2: rollout/fleet/test (prepare, the first install, publish, the tar reader),
// each fleet test file in a child node. Part 2, the offline checks of the two first-install PowerShell scripts, is
// fleet-node-powershell.test.mjs; the two were one file, fleet-node.test.mjs, split so they run side by side (task 3435f8bf, block 2).
// No CI suite ran any of them (the resident-fleet-node suite was taken out of the selector again in b596acbc: its selector source is
// pinned and re-pinning needs the whole registry chain). They run here, in resident-node, which every change under this directory
// selects (ci-required-selection.mjs RESIDENT_AND_SOURCE). They need Windows (Windows PowerShell 5.1, Windows paths): on Linux
// this file is skipped by name. Each fleet test file runs in a process of its own, as `node --test <dir>` would run it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FLEET_TESTS, RES, childEnv, skip, tail, windows } from './fleet-node-fixtures.mjs';

// Every child carries the test marker itself (Fable "补：发布工具测试入套件"; ruling 11-20 "补：止血 PR 第四轮" §4), also when
// this file is started without the one entry.
test('the fleet children carry the test marker CLUED_UNDER_TEST=1 whatever this process has', () => {
  const saved = process.env.CLUED_UNDER_TEST;
  delete process.env.CLUED_UNDER_TEST;
  try {
    assert.equal(childEnv().CLUED_UNDER_TEST, '1');
  } finally {
    if (saved !== undefined) process.env.CLUED_UNDER_TEST = saved;
  }
});

const files = windows ? fs.readdirSync(FLEET_TESTS).filter(n => n.endsWith('.test.mjs')).sort() : [];
test('rollout/fleet/test holds the fleet tests this file runs', { skip }, () => {
  assert.ok(files.includes('first-install.test.mjs') && files.includes('install.test.mjs'), files.join(','));
});
for (const name of files) {
  test(`rollout/fleet/test/${name}`, { skip, timeout: 3_600_000 }, () => {
    const r = spawnSync(process.execPath, ['--test', path.join(FLEET_TESTS, name)], { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, timeout: 3_500_000 });
    assert.ifError(r.error);
    assert.equal(r.status, 0, `${name} failed:\n${tail(r.stdout)}\n${tail(r.stderr, 2000)}`);
  });
}
