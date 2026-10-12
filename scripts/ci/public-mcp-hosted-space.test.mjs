import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareHostedSpace, SDK, MIN_BYTES, MIN_INODES} from './public-mcp-hosted-space.mjs';

const environment = {GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Linux', ImageOS: 'ubuntu24', ImageVersion: '20261001.1',
  ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK};
function fixture({enoughBefore = false, enoughAfter = true, symbolic = false, realpath = SDK} = {}) {
  const calls = []; let removed = false;
  const execute = (command, args) => {
    calls.push([command, args]);
    if (command === 'docker') return '/var/lib/docker\n';
    assert.equal(command, 'sudo'); removed = true;
  };
  const io = {existsSync: () => true, lstatSync: () => ({isSymbolicLink: () => symbolic}),
    realpathSync: () => realpath, statfsSync: () => ({bsize: 1n,
      bavail: (removed ? enoughAfter : enoughBefore) ? MIN_BYTES : 1n, ffree: MIN_INODES})};
  return {env: environment, platform: 'linux', io, execute, calls};
}
test('persistent, unknown, and non-Ubuntu runners refuse before any command', () => {
  for (const changes of [{RUNNER_ENVIRONMENT: 'self-hosted'}, {GITHUB_ACTIONS: 'false'},
    {RUNNER_OS: 'Windows'}, {ImageOS: 'debian12'}, {ImageVersion: ''}]) {
    const f = fixture();
    assert.throws(() => prepareHostedSpace({...f, env: {...environment, ...changes}}), /ephemeral/);
    assert.deepEqual(f.calls, []);
  }
});
test('sufficient Docker capacity performs no removal', () => {
  const f = fixture({enoughBefore: true});
  assert.equal(prepareHostedSpace(f).removed_sdk, false);
  assert.deepEqual(f.calls.map(x => x[0]), ['docker']);
});
test('low capacity removes only the literal SDK and rechecks actual free space', () => {
  const f = fixture(); const result = prepareHostedSpace(f);
  assert.equal(result.removed_sdk, true);
  assert.deepEqual(f.calls[1], ['sudo', ['--', 'rm', '--one-file-system', '-rf', '--', SDK]]);
  assert.equal(result.after.free_bytes, String(MIN_BYTES));
});
test('SDK symlink, redirected parent and arbitrary environment targets never remove', () => {
  for (const f of [fixture({symbolic: true}), fixture({realpath: '/home/runner/work'}),
    {...fixture(), env: {...environment, ANDROID_HOME: '/home/runner/work'}}]) {
    assert.throws(() => prepareHostedSpace(f), /identity/);
    assert.deepEqual(f.calls.map(x => x[0]), ['docker']);
  }
});
test('remaining low capacity or command failure prevents the test suite from starting', () => {
  assert.throws(() => prepareHostedSpace(fixture({enoughAfter: false})), /after SDK removal/);
  const f = fixture(); f.execute = () => {throw new Error('Docker unavailable');};
  assert.throws(() => prepareHostedSpace(f), /Docker unavailable/);
});
