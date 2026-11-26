// The universal node package's Windows tests in resident-node. The three fleet-node-children files run the sorted
// rollout/fleet/test files modulo three, each in a child Node process. The offline first-install PowerShell checks
// are still in fleet-node-powershell.test.mjs (task 3435f8bf, block 2).
import assert from 'node:assert/strict';
import test from 'node:test';
import { fleetChildFiles, runFleetChildren } from './fleet-node-children.test.mjs';
import { childEnv, skip } from './fleet-node-fixtures.mjs';

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

const files = fleetChildFiles();
test('rollout/fleet/test holds the fleet tests this file runs', { skip }, () => {
  assert.ok(files.includes('first-install.test.mjs') && files.includes('install.test.mjs'), files.join(','));
});
runFleetChildren(files, 0);
