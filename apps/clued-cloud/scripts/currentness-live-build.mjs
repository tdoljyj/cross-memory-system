export const PRODUCTION_HEALTH_URL = 'https://kooyumi.pixelgrav.com/healthz';
export const PROPAGATION_WINDOW_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 10_000;

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
    const error = new Error(`Production Worker source commit differs from tested checkout: ${body.source_commit}`);
    error.code = 'LIVE_SOURCE_COMMIT_MISMATCH';
    throw error;
  }
  return body.source_commit;
}

// Cloudflare may keep serving the previous version for a short while after
// `wrangler deploy` returns. Only a well-formed response naming a different
// commit is retried, within a bounded budget; any other failure, and the last
// mismatch, is rethrown so the check still fails closed.
export async function waitForLiveSourceCommit(expected, {
  attempts = Math.ceil(PROPAGATION_WINDOW_MS / DEFAULT_RETRY_DELAY_MS),
  delayMs = DEFAULT_RETRY_DELAY_MS, fetchLive = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Invalid attempt budget');
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await verifyLiveSourceCommit(expected, fetchLive);
    } catch (error) {
      if (error?.code !== 'LIVE_SOURCE_COMMIT_MISMATCH' || attempt >= attempts) throw error;
      log(`live source commit not yet ${expected} (attempt ${attempt}/${attempts}): ${error.message}`);
      await sleep(delayMs);
    }
  }
}
