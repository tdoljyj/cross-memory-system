import assert from 'node:assert/strict';
import test from 'node:test';
import { stopOwnedPostgres } from './model-domain-postgres-lifecycle.fixture.mjs';

function fixture() {
  const child = { pid: 7319, exitCode: null, signalCode: null };
  const calls = { identity: 0, stop: 0 };
  const server = { process: child, stop() { calls.stop++; child.exitCode = 0; this.process = undefined; } };
  const verifyIdentity = async () => { calls.identity++; };
  return { child, server, calls, verifyIdentity };
}
const run = f => stopOwnedPostgres({ ...f, timeoutMs: 5 });

for (const flags of [{ exitCode: 0 }, { signalCode: 'SIGINT' }]) {
  test('already exited child never reaches identity reads or SDK stop: ' + Object.keys(flags)[0], async () => {
    const f = fixture(); Object.assign(f.child, flags);
    const result = await run(f);
    assert.equal(result.cleanup, true);
    assert.equal(result.diagnostic.code, 'OWN_POSTGRES_ALREADY_EXITED');
    assert.deepEqual(f.calls, { identity: 0, stop: 0 });
  });
}

test('exit delivered during asynchronous identity reads never calls the late-listener SDK', async () => {
  const f = fixture();
  f.verifyIdentity = async () => { f.calls.identity++; await Promise.resolve(); f.child.exitCode = 0; };
  f.server.stop = () => { f.calls.stop++; return new Promise(() => {}); };
  const result = await run(f);
  assert.equal(result.cleanup, true);
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_EXITED_DURING_IDENTITY');
  assert.deepEqual(f.calls, { identity: 1, stop: 0 });
});

test('a different server child is rejected before any identity read, even if retained child exited', async () => {
  const f = fixture(); f.server.process = { ...f.child }; f.child.exitCode = 0;
  const result = await run(f);
  assert.equal(result.cleanup, false);
  assert.equal(result.diagnostic.stage, 'initial');
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_CHILD_MISMATCH');
  assert.deepEqual(f.calls, { identity: 0, stop: 0 });
});

test('a server child replaced during identity reads cannot be stopped or excused by later exit', async () => {
  const f = fixture();
  f.verifyIdentity = async () => { await Promise.resolve(); f.server.process = { ...f.child }; f.child.exitCode = 0; };
  const result = await run(f);
  assert.equal(result.cleanup, false);
  assert.equal(result.diagnostic.stage, 'identity');
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_CHILD_MISMATCH');
  assert.equal(f.calls.stop, 0);
});

for (const reason of ['spoofed PID', 'spoofed directory', 'private credential and owner path']) {
  test('identity rejection preserves the directory and redacts callback errors: ' + reason, async () => {
    const f = fixture();
    f.verifyIdentity = async () => { f.child.exitCode = 0; throw new Error(reason); };
    const result = await run(f);
    assert.equal(result.cleanup, false);
    assert.deepEqual(result.diagnostic, {
      stage: 'identity', code: 'OWN_POSTGRES_IDENTITY_REJECTED', exit_code: 0, signal_code: null,
    });
    assert.equal(f.calls.stop, 0);
    assert.equal(JSON.stringify(result).includes(reason), false);
  });
}

test('normal SDK completion requires actual exit proof and permits the SDK to clear its process', async () => {
  const f = fixture();
  const result = await run(f);
  assert.equal(result.cleanup, true);
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_EXIT_PROVEN');
  assert.equal(f.server.process, undefined);
  assert.deepEqual(f.calls, { identity: 1, stop: 1 });
});

test('SDK completion and a killed flag without actual exit cannot permit cleanup', async () => {
  const f = fixture();
  f.server.stop = () => { f.child.killed = true; };
  const result = await run(f);
  assert.equal(result.cleanup, false);
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_STOP_RESOLVED_WITHOUT_EXIT');
});

test('a live child at the shutdown timeout is preserved', async () => {
  const f = fixture(); f.server.stop = () => new Promise(() => {});
  const result = await run(f);
  assert.equal(result.cleanup, false);
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_STOP_TIMEOUT');
  assert.equal(result.diagnostic.exit_code, null);
  assert.equal(result.diagnostic.signal_code, null);
});

for (const asynchronous of [false, true]) {
  test('a live child after SDK ' + (asynchronous ? 'rejection' : 'throw') + ' is preserved', async () => {
    const f = fixture(), error = new Error('private SDK output');
    f.server.stop = asynchronous ? () => Promise.reject(error) : () => { throw error; };
    const result = await run(f);
    assert.equal(result.cleanup, false);
    assert.equal(result.diagnostic.code, 'OWN_POSTGRES_STOP_ERROR');
    assert.equal(JSON.stringify(result).includes(error.message), false);
  });
}

test('SDK rejection after actual retained-child exit permits cleanup while preserving its fixed error label', async () => {
  const f = fixture();
  f.server.stop = async () => { await Promise.resolve(); f.child.signalCode = 'SIGINT'; throw new Error('private output'); };
  const result = await run(f);
  assert.equal(result.cleanup, true);
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_STOP_ERROR');
  assert.equal(result.diagnostic.signal_code, 'SIGINT');
});

test('timeout rechecks genuine exit flags even when SDK never settles', async () => {
  const f = fixture();
  f.server.stop = () => { f.child.exitCode = 0; return new Promise(() => {}); };
  const result = await run(f);
  assert.equal(result.cleanup, true);
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_STOP_TIMEOUT');
  assert.equal(result.diagnostic.exit_code, 0);
});

test('an SDK rejection after a timeout is handled and never changes the failed live-child result', async () => {
  const f = fixture(); let rejectStop;
  f.server.stop = () => new Promise((_, reject) => { rejectStop = reject; });
  const result = await run(f);
  rejectStop(new Error('late private rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.cleanup, false);
  assert.equal(result.diagnostic.code, 'OWN_POSTGRES_STOP_TIMEOUT');
});

test('invalid or widened shutdown deadlines never invoke identity verification or SDK stop', async () => {
  for (const timeoutMs of [0, -1, 15001, Infinity, 1.5]) {
    const f = fixture();
    const result = await stopOwnedPostgres({ ...f, timeoutMs });
    assert.equal(result.cleanup, false);
    assert.equal(result.diagnostic.code, 'OWN_POSTGRES_ARGUMENT_INVALID');
    assert.deepEqual(f.calls, { identity: 0, stop: 0 });
  }
});
