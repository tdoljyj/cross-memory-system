import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

const dir = await mkdtemp(path.join(os.tmpdir(), 'clued-context-api-'));
await build({ entryPoints: ['worker/continuity.ts', 'app/contexts/context-session.ts'], outdir: dir, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
stop();
const { handleContinuityRequest: handle, publicMcpTools } = await import(pathToFileURL(path.join(dir, 'worker/continuity.mjs')));
const { ContextSession, localDraft } = await import(pathToFileURL(path.join(dir, 'app/contexts/context-session.mjs')));
const env = { CONTEXT_OWNERSHIP_V11: 'true', SUPABASE_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'test-public-key' };
const request = (route, method = 'POST') => new Request(`https://clued.example${route}`, {
  method, headers: { authorization: 'Bearer clued_bnd_legacy-test', 'content-type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify({ op: 'record_list', mode: 'development_history' }) } : {}),
});

test('retired Context v1.1 routes and feature flag cannot reach storage or advertise a tool', async () => {
  let called = false;
  const old = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('retired route contacted storage'); };
  try {
    for (const route of ['/v1/contexts', '/v1/contexts/owner']) {
      for (const method of ['GET', 'POST', 'OPTIONS']) assert.equal(await handle(request(route, method), env), null);
    }
    assert.equal(called, false);
    assert.equal(publicMcpTools(env).some((tool) => tool.name === 'clued_context'), false);
  } finally { globalThis.fetch = old; }
});

test('only explicit v14 enablement opens the successor transport', async () => {
  const currentEnv = { ...env, CLUED_DEVELOPMENT_CONTEXT_V14: 'true' };
  assert.equal(publicMcpTools(currentEnv).some((tool) => tool.name === 'clued_context'), true);
  assert.equal(await handle(request('/v1/contexts'), currentEnv), null);
  const response = await handle(request('/v1/development'), env);
  assert.equal(response.status, 404);
});

test('consumer: account/mode reset rejects a late completed old response even if transport ignores abort', async () => {
  const old = globalThis.fetch; let resolve;
  globalThis.fetch = () => new Promise(r => { resolve = r; });
  try {
    const session = new ContextSession();
    const pending = session.request('/v1/development', 'session-only-test', { op: 'record_list' });
    session.reset(); resolve(Response.json({ records: [{ body: 'stale secret' }] }));
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { globalThis.fetch = old; }
});

test('consumer: unauthenticated local draft has no canonical claim or receipt', () => {
  const draft = localDraft({ title: 'unsaved', content: 'not on server' });
  assert.equal(draft.status, 'LOCAL_DRAFT'); assert.equal(draft.canonical, false); assert.equal('receipt_id' in draft, false);
});
