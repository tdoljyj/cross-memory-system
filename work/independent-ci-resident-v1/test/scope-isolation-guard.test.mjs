import test from 'node:test';
import assert from 'node:assert/strict';
import { checkScopeIsolation } from '../../../scripts/ci/check-scope-isolation.mjs';
import { selectSuites, SUITE_COMMANDS } from '../../../scripts/ci/ci-required-selection.mjs';

test('policy scope guard discovers a newly declared per PR limit and refuses missing or detached tests', () => {
  const policy = "check(int(p.limits.examplePer24h, 1, 6), 'LIMIT'); // per PR commit\n";
  assert.deepEqual(checkScopeIsolation(policy, []).missing, ['limits.examplePer24h']);
  assert.deepEqual(checkScopeIsolation(policy, ['// scope-isolation: limits.examplePer24h']).missing, ['limits.examplePer24h']);
  assert.deepEqual(checkScopeIsolation(policy, ["// scope-isolation: limits.examplePer24h\ntest('other subject full leaves this subject runnable', async () => { assert.equal(1, 1); });"]).missing, []);
  assert.deepEqual(checkScopeIsolation('// limits.unusualLimit (6 per PR), limits.globalLimit (48 global)\n', []).missing, ['limits.unusualLimit']);
  assert.deepEqual(checkScopeIsolation('// limits.unusualLimit\n// (6 per PR commit), limits.globalLimit (48 global)\n', []).missing, ['limits.unusualLimit']);
});

test('scope guard reads the repository policy and real isolation tests', async () => {
  const fs = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const tests = await fs.readdir(new URL('test/', root));
  const result = checkScopeIsolation(await fs.readFile(new URL('src/policy.mjs', root), 'utf8'),
    await Promise.all(tests.filter(n => n.endsWith('.test.mjs') && n !== 'scope-isolation-guard.test.mjs').map(n => fs.readFile(new URL(`test/${n}`, root), 'utf8'))));
  assert.ok(result.required.includes('park.stage8RetriesPer24h'));
  assert.ok(result.required.includes('breaker.network.releasesPerHeadPer24h'));
  assert.deepEqual(result.missing, []);
  for (const key of result.required) {
    const bodies = await Promise.all(tests.filter(n => n.endsWith('.test.mjs') && n !== 'scope-isolation-guard.test.mjs').map(n => fs.readFile(new URL(`test/${n}`, root), 'utf8')));
    assert.ok(checkScopeIsolation(await fs.readFile(new URL('src/policy.mjs', root), 'utf8'), bodies.map(body => body.replace(`// scope-isolation: ${key}`, '// removed marker'))).missing.includes(key));
  }
  for (const changed of ['scripts/ci/check-scope-isolation.mjs', 'work/independent-ci-resident-v1/src/policy.mjs', 'work/independent-ci-resident-v1/test/budget-isolation.test.mjs'])
    assert.ok(selectSuites('ci-suites', [changed]).suites.includes('resident-node'));
  assert.ok(SUITE_COMMANDS['resident-node'].some(c => c.argv.includes('{tests:test}')));
});
