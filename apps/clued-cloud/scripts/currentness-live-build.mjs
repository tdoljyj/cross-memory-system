export const PRODUCTION_HEALTH_URL = 'https://clued.pixelgrav.com/healthz';

export async function verifyLiveSourceCommit(expected, fetchLive = globalThis.fetch) {
  if (!/^[0-9a-f]{40}$/.test(expected)) throw new Error('Invalid expected source commit');
  const response = await fetchLive(PRODUCTION_HEALTH_URL, {
    method: 'GET', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(10000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok || response.status !== 200 ||
      !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error('Production health endpoint did not return the expected JSON response');
  }
  const body = await response.json();
  if (body?.status !== 'ok' || body?.service !== 'clued-continuity' ||
      !/^[0-9a-f]{40}$/.test(body?.source_commit ?? '')) {
    throw new Error('Production Worker has no trustworthy compiled source commit');
  }
  if (body.source_commit !== expected) {
    throw new Error(`Production Worker source commit differs from tested checkout: ${body.source_commit}`);
  }
  return body.source_commit;
}

// Cloudflare may keep serving the previous version for a short while after
// `wrangler deploy` returns. Poll with a bounded budget; the last failure is
// rethrown, so a Worker that never converges still fails closed.
export async function waitForLiveSourceCommit(expected, {
  attempts = 12, delayMs = 10000, fetchLive = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Invalid attempt budget');
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await verifyLiveSourceCommit(expected, fetchLive);
    } catch (error) {
      if (attempt >= attempts) throw error;
      log(`live source commit not yet ${expected} (attempt ${attempt}/${attempts}): ${error.message}`);
      await sleep(delayMs);
    }
  }
}
