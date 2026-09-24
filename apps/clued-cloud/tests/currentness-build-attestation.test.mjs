import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PRODUCTION_HEALTH_URL, verifyLiveSourceCommit, waitForLiveSourceCommit } from '../scripts/currentness-live-build.mjs';

const sha = 'a'.repeat(40);
const response = (value, status = 200) => Response.json(value, { status });

test('live attestation reads the fixed HTTPS production health endpoint and exact SHA', async () => {
  let calledUrl;
  const result = await verifyLiveSourceCommit(sha, async (url, options) => {
    calledUrl = url;
    assert.equal(options.redirect, 'error');
    return response({ status: 'ok', service: 'clued-continuity', source_commit: sha });
  });
  assert.equal(calledUrl, 'https://clued.pixelgrav.com/healthz');
  assert.equal(calledUrl, PRODUCTION_HEALTH_URL);
  assert.equal(result, sha);
});

test('live attestation fails closed on missing, mismatched or invalid production identity', async () => {
  for (const body of [
    { status: 'ok', service: 'clued-continuity' },
    { status: 'ok', service: 'clued-continuity', source_commit: 'b'.repeat(40) },
    { status: 'ok', service: 'other', source_commit: sha },
  ]) {
    await assert.rejects(verifyLiveSourceCommit(sha, async () => response(body)));
  }
  await assert.rejects(verifyLiveSourceCommit(sha, async () => response({}, 503)));
  await assert.rejects(verifyLiveSourceCommit(sha, async () => new Response('ok')));
});

test('post-deploy wait tolerates propagation lag but fails closed when the Worker never converges', async () => {
  const old = { status: 'ok', service: 'clued-continuity', source_commit: 'b'.repeat(40) };
  const fresh = { status: 'ok', service: 'clued-continuity', source_commit: sha };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let calls = 0;
  const lagging = async () => response(++calls < 3 ? old : fresh);
  assert.equal(await waitForLiveSourceCommit(sha, { fetchLive: lagging, sleep, delayMs: 5 }), sha);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [5, 5]);

  calls = 0;
  await assert.rejects(
    waitForLiveSourceCommit(sha, { attempts: 4, fetchLive: async () => { calls += 1; return response(old); }, sleep }),
    /differs from tested checkout/);
  assert.equal(calls, 4);
  await assert.rejects(waitForLiveSourceCommit(sha, { attempts: 0, sleep }), /Invalid attempt budget/);
});

test('compiled Worker healthz reports only a valid injected source SHA', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-build-sha-'));
  try {
    const outfile = path.join(directory, 'continuity.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../worker/continuity.ts', import.meta.url))],
      outfile, bundle: true, platform: 'node', format: 'esm',
      define: { __CLUED_BUILD_SHA__: JSON.stringify(sha) } });
    const { handleContinuityRequest } = await import(pathToFileURL(outfile).href);
    const health = await handleContinuityRequest(new Request('https://clued.test/healthz'), {});
    assert.equal((await health.json()).source_commit, sha);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
