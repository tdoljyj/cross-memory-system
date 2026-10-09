import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

// C1 phase 1: synthetic HTTP only, no real gateway JWT or live database.
const worker = await loadContinuityWorker();
const gateway = 'test-worker-gateway';
const binding = 'clued_bnd_' + 'a'.repeat(64);
const env = { SUPABASE_URL: 'https://gateway-db.invalid', SUPABASE_PUBLISHABLE_KEY: 'test-public-key',
  CLUED_DB_GATEWAY_TOKEN: gateway, PROJECT_VIEWS_V2: 'true' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const resume = token => new Request('https://clued.test/v1/continuity/resume', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ context_key: 'global' }),
});

test('Binding calls carry the Worker credential while still proving the Binding', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return Response.json({ status: 'restored', active_constraints: [] });
  };
  try {
    const response = await worker.fetch(resume(binding), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, env.SUPABASE_URL + '/rest/v1/rpc/clued_mcp_restore');
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${gateway}`);
    assert.equal(calls[0].headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(calls[0].body.p_token_hash, createHash('sha256').update(binding).digest('hex'));
    assert.deepEqual(calls[0].body.p_input, { context_key: 'global' });
    assert.equal((await response.text()).includes(gateway), false);
  } finally { globalThis.fetch = previous; }
});

test('missing or whitespace Worker credentials deny before any database request', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; assert.fail('missing gateway must not fall back to anon'); };
  try {
    for (const value of [undefined, '', ' \n\t ']) {
      const response = await worker.fetch(resume(binding), { ...env, CLUED_DB_GATEWAY_TOKEN: value }, ctx);
      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes(binding), false);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test('a Worker JWT refusal is an unavailable gateway, with no anon retry or credential disclosure', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer invalid-gateway-jwt');
    return Response.json({ code: 'PGRST301', message: 'JWT expired: invalid-gateway-jwt' }, { status: 401 });
  };
  try {
    const response = await worker.fetch(resume(binding), { ...env, CLUED_DB_GATEWAY_TOKEN: 'invalid-gateway-jwt' }, ctx);
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
    assert.equal((await response.text()).includes('invalid-gateway-jwt'), false);
  } finally { globalThis.fetch = previous; }
});

test('an explicitly supplied human JWT is preserved without a configured Worker credential', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return Response.json({ status: 'restored', active_constraints: [] });
  };
  try {
    const response = await worker.fetch(resume('test-human-jwt'), { ...env, CLUED_DB_GATEWAY_TOKEN: undefined }, ctx);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, env.SUPABASE_URL + '/rest/v1/rpc/clued_oauth_call');
    assert.equal(calls[0].headers.get('authorization'), 'Bearer test-human-jwt');
    assert.equal(calls[0].headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal('p_token_hash' in calls[0].body, false);
  } finally { globalThis.fetch = previous; }
});

test('explicit user and P5 JWT failures remain 401 and P5 keeps its separate credential', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 });
  };
  try {
    const human = await worker.fetch(resume('test-human-jwt'), { ...env, CLUED_DB_GATEWAY_TOKEN: undefined }, ctx);
    assert.equal(human.status, 401);
    const request = new Request('https://clued.test/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${binding}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'clued_p5_session_open', arguments: {} } }) });
    const p5 = await worker.fetch(request, { ...env, CLUED_DB_GATEWAY_TOKEN: undefined,
      P5_TENANT_WRITES: 'true', CLUED_P5_GATEWAY_TOKEN: 'test-p5-gateway-jwt' }, ctx);
    assert.equal(p5.status, 401);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].url.endsWith('/clued_p5_session_open'));
    assert.equal(calls[1].headers.get('authorization'), 'Bearer test-p5-gateway-jwt');
  } finally { globalThis.fetch = previous; }
});
