// Real continuity routes; all accounts, credentials, RPCs and provider IO are synthetic.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { storageOAuthStartsPaused, storageOAuthStartMaintenance } from '../worker/storage-oauth-cutover.ts';

const worker = await loadContinuityWorker();
const origin = 'https://kooyumi.example.invalid', db = 'https://db.example.invalid';
const owner = randomUUID(), connection = randomUUID(), job = randomUUID(), receipt = randomUUID(), attempt = randomUUID();
const env = { CLUED_DB_GATEWAY_TOKEN: 'fixture-gateway', SUPABASE_URL: db, SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
  CLUED_STORAGE_ACCOUNT_V1: 'true', CLUED_STORAGE_GOOGLE_V1: 'true', CLUED_STORAGE_ONBOARD_V1: 'true', CLUED_STORAGE_REFRESH_V1: 'true',
  CLUED_STORAGE_CONNECTOR_ISSUER: randomBytes(32).toString('base64url'),
  CLUED_STORAGE_GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', CLUED_STORAGE_GOOGLE_CLIENT_SECRET: 'fixture-google-client-secret',
  CLUED_STORAGE_GOOGLE_REDIRECT_URI: origin + '/storage/google/callback',
  CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: 'fixture', keys: { fixture: randomBytes(32).toString('base64url') } }) };
const paused = { ...env, CLUED_STORAGE_OAUTH_STARTS_PAUSED: 'true' };
const state = 's'.repeat(43);
const starts = [
  ['/v1/storage/google/start', { connection_id: connection }],
  ['/v1/storage/google/recovery/start', { connection_id: connection, job_id: job }],
  ['/v1/storage/google/recovery/auto-start', { connection_id: connection, job_id: job }],
  ['/v1/storage/onboard/begin', { root: { mode: 'new', name: 'Fixture' }, tracks: ['tasks'], normal_use: false,
    default_refresh: false, disclosure_version: 'clued.storage-onboard-disclosure/1' }],
  ['/v1/storage/lifecycle', { action: 'reconnect', connection_id: connection, base_version: 1, profile_version: 1,
    root_stop_generation: 1, request_id: randomUUID(), confirmation: { contract: 'clued.storage-owner-confirmation/1',
      root_folder_id: 'fixture-root', confirmed: true, normal_use: false } }],
];
const request = (pathname, body, { method = 'POST', token = 'fixture-native', requestOrigin = origin } = {}) =>
  new Request(origin + pathname, { method, headers: { origin: requestOrigin, 'content-type': 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });

function mock(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const call = { url: String(url), input: init.body ? JSON.parse(init.body).p_input : undefined };
    calls.push(call);
    assert.ok(call.url.startsWith(db + '/'), 'no Google/provider request is needed');
    if (call.url.endsWith('/auth/v1/user')) return Response.json({ id: owner });
    return handler(call);
  });
  return calls;
}
const descriptor = () => ({ owner_id: owner, connection_id: connection, connection_version: 1, credential_version: 1,
  provider_subject: 'fixture-subject', oauth_client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID,
  redirect_uri: env.CLUED_STORAGE_GOOGLE_REDIRECT_URI, root_folder_id: 'fixture-root', root_parent_id: 'fixture-parent',
  provider_scope_profile: 'legacy', recovery_binding: 'e'.repeat(64) });
function startRpc({ url, input }) {
  if (input.action === 'describe') return Response.json(descriptor());
  if (input.action === 'prepare') return Response.json({ status: 'prepared' });
  if (input.action === 'mark') return Response.json({ status: 'marked' });
  if (input.action === 'reconnect_begin') return Response.json({ status: 'prepared', connection_id: connection, attempt_id: attempt });
  if (url.endsWith('/clued_storage_onboard_v1') && input.action === 'begin') return Response.json({ status: 'begun',
    onboard_attempt_id: input.onboard_attempt_id, oauth_client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID,
    redirect_uri: env.CLUED_STORAGE_GOOGLE_REDIRECT_URI, requested_scope_profile: 'legacy' });
  throw Error('unexpected fixture start RPC');
}

test('only exact string true enables the start-only switch', () => {
  for (const value of [undefined, null, false, true, 0, 1, '', 'false', 'TRUE', 'True', ' true', 'true ']) {
    const input = { CLUED_STORAGE_OAUTH_STARTS_PAUSED: value };
    assert.equal(storageOAuthStartsPaused(input), false);
    for (const [pathname, body] of starts) assert.equal(storageOAuthStartMaintenance(input, pathname, {}, body.action), null);
  }
  assert.equal(storageOAuthStartsPaused(paused), true);
  for (const action of ['list','delete','preview_delete','recover','reconnect_begin',null,{},['reconnect']]) {
    assert.equal(storageOAuthStartMaintenance(paused, '/v1/storage/lifecycle', {}, action), null);
  }
});

test('four direct consent starts return public maintenance before any Auth, RPC or runtime creation', async t => {
  const calls = mock(t, () => { throw Error('no IO allowed'); });
  const brokenRuntime = { ...paused, CLUED_STORAGE_VAULT_KEYS: 'not-json', CLUED_STORAGE_GOOGLE_CLIENT_SECRET: 'short' };
  for (const [pathname, body] of starts.filter(([pathname]) => pathname !== '/v1/storage/lifecycle')) {
    const response = await worker.fetch(request(pathname, body, { token: '' }), brokenRuntime);
    assert.equal(response.status, 503, pathname);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.deepEqual(await response.json(), { error: 'Storage connection setup is temporarily unavailable. Please try again shortly.' });
  }
  assert.equal(calls.length, 0);
});

test('paused lifecycle reconnect authenticates once before maintenance and makes no consent RPC or provider call', async t => {
  const calls = mock(t, () => { throw Error('no RPC allowed'); });
  const [pathname, body] = starts.find(([pathname]) => pathname === '/v1/storage/lifecycle');
  const response = await worker.fetch(request(pathname, body), { ...paused,
    CLUED_STORAGE_VAULT_KEYS: 'not-json', CLUED_STORAGE_GOOGLE_CLIENT_SECRET: 'short' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('retry-after'), '60');
  assert.deepEqual(await response.json(), { error: 'Storage connection setup is temporarily unavailable. Please try again shortly.' });
  assert.deepEqual(calls.map(call => call.url), [db + '/auth/v1/user']);
});

test('anonymous lifecycle preserves authentication before body parsing with pause both on and off', async t => {
  const calls = mock(t, () => { throw Error('no IO allowed'); });
  for (const value of ['true', undefined, 'false', 'TRUE']) {
    const input = request('/v1/storage/lifecycle', { action: 'reconnect' }, { token: '' });
    let bodyReads = 0;
    input.arrayBuffer = () => { bodyReads++; throw Error('anonymous body must not be read'); };
    assert.equal((await worker.fetch(input, { ...env, CLUED_STORAGE_OAUTH_STARTS_PAUSED: value })).status, 401);
    assert.equal(bodyReads, 0); assert.equal(input.bodyUsed, false);
  }
  assert.equal(calls.length, 0);
});

test('off, absent and non-exact values let all five real start routes retain their original success path', async t => {
  const calls = mock(t, startRpc);
  for (const value of [undefined, 'false', 'TRUE', ' true', 'true ', true, 1]) {
    for (const [pathname, body] of starts) {
      const before = calls.length;
      const response = await worker.fetch(request(pathname, body), { ...env, CLUED_STORAGE_OAUTH_STARTS_PAUSED: value });
      assert.equal(response.status, 200, pathname + ' flag=' + value + ' ' + (response.status === 200 ? '' : await response.text()));
      assert.equal(new URL((await response.json()).authorization_url).origin, 'https://accounts.google.com');
      const actual = calls.slice(before);
      assert.equal(actual[0].url, db + '/auth/v1/user');
      assert.ok(actual.some(call => ['prepare','begin'].includes(call.input?.action)));
      if (pathname === '/v1/storage/lifecycle') assert.ok(actual.some(call => call.input?.action === 'reconnect_begin'));
    }
  }
});

test('Origin, feature, OPTIONS and method checks still precede maintenance', async t => {
  const calls = mock(t, () => { throw Error('no IO allowed'); });
  for (const [pathname, body] of starts) {
    assert.equal((await worker.fetch(request(pathname, body, { requestOrigin: 'https://foreign.invalid' }), paused)).status, 403);
    assert.equal((await worker.fetch(request(pathname, undefined, { method: 'GET' }), paused)).status, 405);
    assert.equal((await worker.fetch(request(pathname, undefined, { method: 'OPTIONS' }), paused)).status, 204);
    assert.equal((await worker.fetch(request(pathname, body), { ...paused, CLUED_STORAGE_ACCOUNT_V1: 'false' })).status, 404);
  }
  assert.equal(calls.length, 0);
});

test('paused callback, automatic target and inspection drain through their actual authenticated RPCs', async t => {
  const calls = mock(t, ({ input }) => {
    if (input.action === 'claim') return Response.json({ status: 'completed', receipt_id: receipt,
      refresh_enabled: false, provider_scope_profile: 'normal', normal_use_enabled: false });
    if (input.action === 'reconnect_activate') return Response.json({ status: 'not_applicable' });
    if (input.action === 'target') return Response.json({ status: 'ready', connection_id: connection, job_id: job, execution_permitted: false });
    if (input.action === 'inspect') return Response.json({ purpose: 'credential_recovery', status: 'claimed', receipt_id: null, execution_permitted: false });
    throw Error('unexpected fixture callback RPC');
  });
  for (const [pathname, body] of [
    ['/v1/storage/google/complete', { state, code: 'synthetic-code' }],
    ['/v1/storage/google/recovery/auto-target', { state }],
    ['/v1/storage/google/recovery/inspect', { state }],
  ]) {
    const response = await worker.fetch(request(pathname, body), paused);
    assert.equal(response.status, 200, pathname); assert.equal(response.headers.get('retry-after'), null);
  }
  assert.deepEqual(calls.filter(call => call.input).map(call => call.input.action), ['claim','reconnect_activate','target','inspect']);
});

test('paused onboarding config, status and resume still reach their original runtime', async t => {
  const calls = mock(t, ({ input }) => {
    if (input.action === 'list') return Response.json({ allowed: true, attempts: [], refresh_token_count: 1 });
    if (input.action === 'status') return Response.json({ state: 'begun' });
    // The original resume path reports this existing attempt refusal; the switch
    // must not replace it with maintenance or prevent the resume RPC.
    if (input.action === 'resume') return Response.json({ message: 'storage_onboard_denied' }, { status: 403 });
    throw Error('unexpected fixture onboard RPC');
  });
  for (const name of ['config','status','resume']) {
    const response = await worker.fetch(request('/v1/storage/onboard/' + name,
      name === 'config' ? {} : { onboard_attempt_id: attempt }), paused);
    assert.equal(response.status, name === 'resume' ? 403 : 200); assert.equal(response.headers.get('retry-after'), null);
  }
  assert.deepEqual(calls.filter(call => call.input).map(call => call.input.action), ['list','status','resume']);
});

test('paused other lifecycle operations and refresh retain authentication and original dispatch', async t => {
  const calls = mock(t, ({ url, input }) => {
    if (url.endsWith('/clued_storage_refresh_manage_v1')) return Response.json({ enabled: true });
    if (input.action === 'list') return Response.json({ contract: 'clued.storage-owner-lifecycle/1', complete: true, connections: [] });
    if (input.action === 'recover') return Response.json({ status: 'uncertain', operation: 'reconnect' });
    throw Error('unexpected fixture lifecycle RPC');
  });
  for (const body of [{ action: 'list' }, { action: 'recover', attempt_id: attempt }]) {
    const response = await worker.fetch(request('/v1/storage/lifecycle', body), paused);
    assert.equal(response.status, 200); assert.equal(response.headers.get('retry-after'), null);
  }
  assert.equal((await worker.fetch(request('/v1/storage/refresh', { action: 'list' }), paused)).status, 200);
  for (const action of ['delete','preview_delete','reconnect_begin','not-an-action']) {
    const response = await worker.fetch(request('/v1/storage/lifecycle', { action }), paused);
    assert.notEqual(response.status, 503); assert.equal(response.headers.get('retry-after'), null);
  }
  assert.equal((await worker.fetch(request('/v1/storage/lifecycle', { action: 'list' }, { token: '' }), paused)).status, 401);
  // Lifecycle list re-reads after its bounded metadata observations.
  assert.deepEqual(calls.filter(call => call.input).map(call => call.input.action), ['list','list','recover','list']);
});

