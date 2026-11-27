import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { previousInterfaceCheck, PREVIOUS_INTERFACE_TIMEOUT_MS } from '../../../../work/independent-ci-resident-v1/rollout/fleet/previous-interface-check.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

test('第 26 代接口在候选提交的迁移上真跑且零跳过', { timeout: PREVIOUS_INTERFACE_TIMEOUT_MS + 30_000 }, async () => {
  const resolveCommit = (ref) => execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const commit = resolveCommit('HEAD');
  const previous = { commit: resolveCommit('refs/tags/fleet-node-g000026') };
  const result = await previousInterfaceCheck({ root, commit, previous, timeoutMs: PREVIOUS_INTERFACE_TIMEOUT_MS });

  // PASS requires a real test pass and zero skips or cancellations in the selector output.
  assert.equal(result.status, 'PASS');
  assert.equal(result.commit, commit);
  assert.equal(result.previousCommit, previous.commit);
  assert.ok(result.files.includes('apps/clued-cloud/tests/owner-grants-fleet-accept-door-db.test.mjs'));
});
