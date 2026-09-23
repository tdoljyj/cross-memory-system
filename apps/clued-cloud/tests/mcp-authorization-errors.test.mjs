import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-auth-errors-'));
await build({ entryPoints: ['worker/continuity.ts'], outdir: directory, bundle: true,
  platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
stop();
const { handleContinuityRequest: handle } = await import(pathToFileURL(path.join(directory, 'continuity.mjs')));
const env = { SUPABASE_URL: 'https://storage.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key' };
const request = token => new Request('https://clued.example/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clued_project_list', arguments: { limit: 10 } } }),
});

test('resource denials stay denied without triggering an OAuth challenge', async () => {
  const original = globalThis.fetch;
  try {
    for (const message of ['binding_not_authorized', 'resource_action_not_authorized', 'authorization_revoked_or_expired']) {
      let calls = 0;
      globalThis.fetch = async url => {
        calls++;
        assert.equal(new URL(url).pathname, '/rest/v1/rpc/clued_project_list_v2');
        return Response.json({ code: '42501', message }, { status: 401 });
      };
      const response = await handle(request('clued_bnd_isolated-fixture'), env);
      assert.equal(response.status, 403);
      assert.equal(response.headers.has('www-authenticate'), false);
      const body = await response.json();
      assert.equal(body.error.code, -32000);
      assert.equal(body.error.message, message);
      assert.equal(body.error.data.code, '42501');
      assert.equal(calls, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('invalid JWT still challenges authentication', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 });
  try {
    const response = await handle(request('expired-jwt-fixture'), env);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /resource_metadata=/);
    assert.equal((await response.json()).error.code, -32001);
  } finally { globalThis.fetch = original; }
});

test('missing credentials challenge before storage; authorized empty list succeeds', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ projects: [] }); };
  try {
    const denied = await handle(request(), env);
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);
    const response = await handle(request('clued_bnd_isolated-fixture'), env);
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual((await response.json()).result.structuredContent, { projects: [] });
  } finally { globalThis.fetch = original; }
});
