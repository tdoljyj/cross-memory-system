// Test-fixture shutdown only. Signals and SDK completion never prove exit;
// only the retained ChildProcess's actual exit flags permit caller cleanup.
export async function stopOwnedPostgres({ server, child, verifyIdentity, timeoutMs = 15000 }) {
  const exitFlags = () => ({
    exit_code: typeof child?.exitCode === 'number' ? child.exitCode : null,
    signal_code: typeof child?.signalCode === 'string' ? child.signalCode : null,
  });
  const exited = () => {
    const flags = exitFlags();
    return flags.exit_code !== null || flags.signal_code !== null;
  };
  const result = (cleanup, stage, code) => ({
    cleanup,
    diagnostic: { stage, code, ...exitFlags() },
  });
  if (!server || !child || typeof server.stop !== 'function' || typeof verifyIdentity !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) {
    return result(false, 'initial', 'OWN_POSTGRES_ARGUMENT_INVALID');
  }
  if (server.process !== child) return result(false, 'initial', 'OWN_POSTGRES_CHILD_MISMATCH');
  if (exited()) return result(true, 'initial', 'OWN_POSTGRES_ALREADY_EXITED');
  try {
    await verifyIdentity();
  } catch {
    return result(false, 'identity', 'OWN_POSTGRES_IDENTITY_REJECTED');
  }
  if (server.process !== child) return result(false, 'identity', 'OWN_POSTGRES_CHILD_MISMATCH');
  // Identity reads yield to child exit events. Recheck after those reads and
  // invoke the SDK in this same turn, before another event can be delivered.
  if (exited()) return result(true, 'identity', 'OWN_POSTGRES_EXITED_DURING_IDENTITY');
  let timer, outcome;
  try {
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    outcome = await Promise.race([
      Promise.resolve(server.stop()).then(() => 'resolved', () => 'error'),
      timeout,
    ]);
  } catch {
    outcome = 'error';
  } finally {
    clearTimeout(timer);
  }
  // A timed-out/rejected SDK promise can coexist with a genuinely exited
  // child. Recheck that exact object, never a PID lookup or replacement child.
  const cleanup = exited();
  const code = outcome === 'timeout' ? 'OWN_POSTGRES_STOP_TIMEOUT'
    : outcome === 'error' ? 'OWN_POSTGRES_STOP_ERROR'
    : cleanup ? 'OWN_POSTGRES_EXIT_PROVEN' : 'OWN_POSTGRES_STOP_RESOLVED_WITHOUT_EXIT';
  return result(cleanup, 'stop', code);
}
