import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

// The entry keeps this pipe open while it owns the request. SIGKILL and other
// abrupt entry exits close the pipe even if its JS cleanup never runs.
function ownerPipe() {
  const disconnected = once(process.stdin, 'end');
  const permission = Promise.race([once(process.stdin, 'data').then(([bytes]) => bytes[0] === 1),
    disconnected.then(() => false)]);
  process.stdin.resume();
  return { permission, disconnected };
}

async function guard({ suite, owner, worker, holdMs, timeoutExit, requestPath }) {
  const started = performance.now();
  const control = ownerPipe();
  const child = spawn(process.execPath, [worker, 'worker'], { detached: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {}); // The blocked worker may exit before permission arrives.
  const timer = new AbortController();
  try {
    await once(child, 'spawn');
    const exited = once(child, 'exit').then(([code]) => code ?? 1);
    writeFileSync(path.join(requestPath, `group-${child.pid}`), '');
    if (!await control.permission) return 1;
    child.stdin.end(Buffer.of(1));
    const timedOut = Symbol();
    const deadline = Math.max(0, holdMs - (performance.now() - started));
    const result = await Promise.race([exited, control.disconnected.then(() => 1),
      delay(deadline, timedOut, { signal: timer.signal })]);
    if (result !== timedOut) return result;
    console.error(`LOCAL_SUITE_HOLD_TIMEOUT: ${suite} (PID ${owner}) held a slot for ${(holdMs / 60_000).toFixed(2)} minutes; stopping its process tree`);
    return timeoutExit;
  } finally {
    timer.abort();
    process.stdin.destroy();
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      while (groupExists(child.pid)) await delay(20);
    }
    writeFileSync(path.join(requestPath, 'drained'), '');
  }
}

if (process.env.CLUED_LOCAL_SUITE_GUARD && process.argv[1] === import.meta.filename) {
  try {
    const context = JSON.parse(process.env.CLUED_LOCAL_SUITE_GUARD);
    if (process.argv[2] === 'guard') {
      process.exitCode = await guard(context);
    } else if (process.argv[2] === 'worker' && await ownerPipe().permission) {
      process.stdin.destroy();
      delete process.env.CLUED_LOCAL_SUITE_GUARD;
      const { runSuite } = await import('./ci-required-selection.mjs');
      process.exitCode = runSuite(context.suite, { root: context.root });
    } else {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`local suite guard: ${error.message}`);
    process.exitCode = 1;
  }
}
