import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { previousInterfaceCheck, PREVIOUS_INTERFACE_TIMEOUT_MS } from '../../../../work/independent-ci-resident-v1/rollout/fleet/previous-interface-check.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const testReader = fileURLToPath(import.meta.url);

test('第 26 代接口在候选提交的迁移上真跑且零跳过', async () => {
  const resolveCommit = (ref) => execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const commit = resolveCommit('HEAD');
  const previous = { commit: resolveCommit('refs/tags/fleet-node-g000026') };
  const result = await previousInterfaceCheck({ root, commit, previous, timeoutMs: PREVIOUS_INTERFACE_TIMEOUT_MS, testReader });

  // PASS requires a real test pass and zero skips or cancellations in the selector output.
  assert.equal(result.status, 'PASS');
  assert.equal(result.commit, commit);
  assert.equal(result.previousCommit, previous.commit);
  assert.ok(result.files.includes('apps/clued-cloud/tests/owner-grants-fleet-accept-door-db.test.mjs'));
});

test('第 29 代回放上一代接口时能打包 Worker 及其应用依赖', async () => {
  const commit = '5d6e535b8faf2fc0320e219d455c45d4ef1fb866';
  const previous = { commit: 'b49c7ae69e30d8e397cfcb8392cee0d85fca3103' };
  const result = await previousInterfaceCheck({ root, commit, previous, timeoutMs: PREVIOUS_INTERFACE_TIMEOUT_MS, testReader });

  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.files, [
    'apps/clued-cloud/tests/owner-grants-fleet-accept-door-db.test.mjs',
    'apps/clued-cloud/tests/fleet-delivery-release-db.test.mjs',
  ]);
});
