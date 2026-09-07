// Successor API checks after production retirement; legacy v11 evidence remains unchanged.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build, stop } from 'esbuild';

const dir = await mkdtemp(path.join(os.tmpdir(), 'clued-context-api-'));
await build({ entryPoints: ['worker/continuity.ts', 'app/contexts/context-session.ts'], outdir: dir, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
stop();
const { handleContinuityRequest: handle, publicMcpTools } = await import(pathToFileURL(path.join(dir, 'worker/continuity.mjs')));
const { ContextSession, localDraft } = await import(pathToFileURL(path.join(dir, 'app/contexts/context-session.mjs')));
const env = { CLUED_DEVELOPMENT_CONTEXT_V14: 'true', SUPABASE_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'test-public-key' };
const request = (body = { op: 'context_list' }, token = 'clued_bnd_developer-test', route = '/v1/development', headers = {}) => new Request(`https://clued.example${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('API: default-off rejects and does not contact storage; tool list unchanged', async () => {
  let called = false;
  const old = globalThis.fetch; globalThis.fetch = async () => { called = true; throw new Error('must not fetch'); };
  try {
    assert.equal((await handle(request(), {})).status, 404);
    assert.equal(called, false);
    assert.equal(publicMcpTools({}).some(t => t.name === 'clued_context'), false);
    assert.equal(publicMcpTools(env).some(t => t.name === 'clued_context'), true);
  } finally { globalThis.fetch = old; }
});

test('API: scoped binding hash only, ordinary default, no-store and stable IDs', async () => {
  const calls = []; const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ status: 'ok', records: [{ id: 'canonical-id', user_id: 'private-user', binding_id: 'private-binding', body: { content: 'authorized-only' } }] }); };
  try {
    const response = await handle(request(), env);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls[0].url, 'https://db.example/rest/v1/rpc/clued_development_call_v14');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.p_token_hash, createHash('sha256').update('clued_bnd_developer-test').digest('hex'));
    assert.equal(body.p_input.mode, 'ordinary'); assert.equal(JSON.stringify(calls).includes('clued_bnd_developer-test'), false);
    assert.deepEqual((await response.json()).records, [{ id: 'canonical-id', body: { content: 'authorized-only' } }]);
  } finally { globalThis.fetch = old; }
});

test('API: direct OAuth JWT and retired routes cannot enter successor context business RPC', async () => {
  let called = false; const old = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('must not contact storage'); };
  try {
    assert.equal((await handle(request({ op: 'record_list', mode: 'development_history' }, 'signed-oauth-test'), env)).status, 403);
    assert.equal(called, false);
    assert.equal(await handle(request({ op: 'context_list' }, undefined, '/v1/contexts'), env), null);
    assert.equal(publicMcpTools({ CONTEXT_OWNERSHIP_V11: 'true' }).some(t => t.name === 'clued_context'), false);
    const operations = publicMcpTools(env).find(t => t.name === 'clued_context').inputSchema.properties.op.enum;
    for (const retired of ['accept', 'publish', 'publication_read', 'publication_deliver', 'feedback_update']) assert.equal(operations.includes(retired), false);
  } finally { globalThis.fetch = old; }
});

test('API: no token, wrong origin and binding on management fail before DB', async () => {
  const old = globalThis.fetch; globalThis.fetch = async () => { throw new Error('no request allowed'); };
  try {
    const empty = request(); empty.headers.delete('authorization');
    assert.equal((await handle(empty, env)).status, 401);
    assert.equal((await handle(request({}, undefined, '/v1/development', { origin: 'https://attacker.example' }), env)).status, 403);
    assert.equal((await handle(request({}, undefined, '/v1/development/owner'), env)).status, 403);
    assert.equal((await handle(new Request('https://clued.example/v1/development'), env)).status, 405);
  } finally { globalThis.fetch = old; }
});

test('API: owner management authenticates JWT then invokes separate owner RPC', async () => {
  const urls = []; const old = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(url); return Response.json(url.endsWith('/user') ? { id: 'owner-test' } : { status: 'committed', result: { id: 'context-id' } }); };
  try {
    assert.equal((await handle(request({ op: 'context_create' }, 'owner-jwt-test', '/v1/development/owner'), env)).status, 200);
    assert.deepEqual(urls, ['https://db.example/auth/v1/user', 'https://db.example/rest/v1/rpc/clued_development_owner_v14']);
  } finally { globalThis.fetch = old; }
});

test('API: server authorization failure is not turned into a successful package', async () => {
  const old = globalThis.fetch; globalThis.fetch = async () => Response.json({ code: '42501', message: 'grant_denied' }, { status: 403 });
  try { const response = await handle(request({ op: 'record_list', mode: 'development_history' }), env); assert.equal(response.status, 403); assert.equal((await response.json()).error, 'grant_denied'); }
  finally { globalThis.fetch = old; }
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
