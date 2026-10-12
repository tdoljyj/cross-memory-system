// Actual Native continuity route with synthetic sessions and mocked RPC/provider.
// This does not qualify production Supabase sessions, Google consent or workerd.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

const worker = await loadContinuityWorker();
const origin = 'https://clued.example.invalid', db = 'https://db.example.invalid';
const owner = randomUUID(), connection = randomUUID(), profile = randomUUID(), project = randomUUID(), receipt = randomUUID();
const nativeToken = 'synthetic-native-owner-jwt', issuer = randomBytes(32).toString('base64url');
const vault = { current_key_id: 'synthetic', keys: { synthetic: randomBytes(32).toString('base64url') } };
const env = { CLUED_DB_GATEWAY_TOKEN: 'synthetic-worker-gateway', SUPABASE_URL: db, SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
  CLUED_STORAGE_ACCOUNT_V1: 'true', CLUED_STORAGE_GOOGLE_V1: 'true', CLUED_STORAGE_ONBOARD_V1: 'true',
  CLUED_STORAGE_CONNECTOR_ISSUER: issuer, CLUED_STORAGE_VAULT_KEYS: JSON.stringify(vault),
  CLUED_STORAGE_GOOGLE_CLIENT_ID: 'synthetic.apps.googleusercontent.com', CLUED_STORAGE_GOOGLE_CLIENT_SECRET: 'synthetic-private-client-secret',
  CLUED_STORAGE_GOOGLE_REDIRECT_URI: origin + '/storage/google/callback' };
const lifecyclePath = '/v1/storage/lifecycle';
function request(body, { path = lifecyclePath, method = 'POST', token = nativeToken, requestOrigin = origin } = {}) {
  return new Request(origin + path, { method, headers: { ...(requestOrigin ? { origin: requestOrigin } : {}),
    'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}
const row = () => ({ id: connection, version: 9, provider: 'google-drive', state: 'revoked', auth_mode: 'revoked',
  scope_name: 'fixture-profile', provider_scope_profile: 'normal', profile_id: profile, profile_version: 1, project_id: project,
  policy_active: false, actions: [], database_execution_enabled: false, profile_current: true,
  managed_root: '/registered/synthetic-root', root_folder_id: 'synthetic-root', root_parent_id: 'synthetic-parent',
  root_name: 'Clued fixture', tracks: ['资料'], created_by_clued: false, root_stop_generation: 2,
  root_stopped: true, normal_use_enabled: false, refresh_enabled: false,
  access_digest_missing: { count: 0, directories: [] } });
function mock(t, handler = () => { throw Error('unexpected RPC'); }, auth = { id: owner }) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const headers = new Headers(init.headers), value = init.body ? JSON.parse(init.body) : undefined;
    const call = { url: String(url), init, headers, value }; calls.push(call);
    if (call.url === db + '/auth/v1/user') {
      assert.equal(headers.get('authorization'), 'Bearer ' + nativeToken);
      return Response.json(auth, { status: 200 });
    }
    assert.ok(call.url.startsWith(db + '/rest/v1/rpc/'), 'no provider IO is expected by these bounded route cases');
    assert.equal(headers.get('authorization'), 'Bearer ' + nativeToken);
    assert.equal(headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(init.redirect, 'manual');
    return handler(call);
  });
  return calls;
}
const rpcCalls = calls => calls.filter(c => c.url.includes('/rest/v1/rpc/'));

test('lifecycle rejects foreign Origin/non-POST and disabled feature gates before any auth/RPC IO', async t => {
  const calls = mock(t);
  assert.equal((await worker.fetch(request({ action: 'list' }, { requestOrigin: 'https://attacker.invalid' }), env)).status, 403);
  assert.equal((await worker.fetch(request(undefined, { method: 'GET' }), env)).status, 405);
  assert.equal((await worker.fetch(request(undefined, { method: 'OPTIONS' }), env)).status, 204);
  for (const flag of ['CLUED_STORAGE_ACCOUNT_V1','CLUED_STORAGE_GOOGLE_V1'])
    assert.equal((await worker.fetch(request({ action: 'list' }), { ...env, [flag]: 'false' })).status, 404);
  assert.equal(calls.length, 0);
});
test('only a verified Native user can call lifecycle; a Binding or missing bearer cannot impersonate that user', async t => {
  const calls = mock(t);
  for (const token of ['', 'clued_bnd_' + 'a'.repeat(64)])
    assert.equal((await worker.fetch(request({ action: 'list' }, { token }), env)).status, 401);
  assert.equal(calls.length, 0);
  t.mock.restoreAll();
  const invalid = mock(t, undefined, {});
  assert.equal((await worker.fetch(request({ action: 'list' }), env)).status, 401);
  assert.equal(invalid.length, 1); assert.equal(rpcCalls(invalid).length, 0);
});
test('browser owner IDs, internal actions and extra admission fields cannot reach lifecycle RPC', async t => {
  const calls = mock(t);
  for (const action of ['reconnect_begin','reconnect_activate','delete_prepare','delete_start','delete_revalidate','delete_observe','describe']) {
    const response = await worker.fetch(request({ action, owner_id: owner, admission: null }), env);
    assert.equal(response.status, 400); assert.equal((await response.json()).reason, 'input_invalid');
  }
  for (const body of [{ action: 'list', owner_id: owner }, { action: 'list', p_issuer_hash: 'a'.repeat(64) },
    { action: 'preview_delete', connection_id: connection, owner_id: owner },
    { action: 'recover', attempt_id: randomUUID(), admission: null }])
    assert.equal((await worker.fetch(request(body), env)).status, 400);
  const base = { connection_id: connection, base_version: 9, profile_version: 1, request_id: randomUUID(),
    confirmation: { contract: 'clued.storage-owner-confirmation/1', root_folder_id: 'synthetic-root', confirmed: true } };
  for (const body of [{ action: 'reconnect', ...base, root_stop_generation: 2, confirmation: { ...base.confirmation, normal_use: false }, owner_id: owner },
    { action: 'delete', ...base, confirmation: { ...base.confirmation, trash_created_root: false }, admission: randomUUID() }]) {
    const response = await worker.fetch(request(body), env);
    assert.equal(response.status, 409); assert.equal((await response.json()).reason, 'input_invalid');
  }
  assert.equal(rpcCalls(calls).length, 0);
});
test('Native list derives Worker availability from actual flags and strips credential/admission/internal owner fields', async t => {
  const pending = { attempt_id: randomUUID(), operation: 'delete', state: 'uncertain', execution_permitted: false,
    admission: 'private-admission', credential_envelope: 'private-pending-credential' };
  const calls = mock(t, call => {
    assert.equal(call.url, db + '/rest/v1/rpc/clued_storage_owner_lifecycle_v1');
    assert.deepEqual(call.value, { p_issuer_hash: createHash('sha256').update(issuer).digest('hex'), p_input: { action: 'list' } });
    return Response.json({ contract: 'clued.storage-owner-lifecycle/1', complete: true, worker_execution_enabled: true,
      admission: 'private-top-admission', connections: [{ ...row(), pending_lifecycle: pending, owner_id: owner,
        credential_envelope: 'private-credential', issuer_secret: issuer, access_token: 'private-provider-token' }] });
  });
  for (const enabled of [false,true]) {
    const response = await worker.fetch(request({ action: 'list' }), { ...env, CLUED_STORAGE_EXECUTOR_V1: String(enabled) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json(); assert.equal(value.worker_execution_enabled, enabled);
    assert.equal(value.complete, true); assert.equal(value.connections[0].root_name, row().root_name);
    assert.deepEqual(value.connections[0].pending_lifecycle, { attempt_id: pending.attempt_id, operation: 'delete', state: 'uncertain', execution_permitted: false });
    assert.deepEqual(value.connections[0].physical_location, { status: 'unavailable', source: 'google_drive_metadata' });
    for (const secret of ['private-top-admission','private-admission','private-credential','private-pending-credential',issuer,'private-provider-token',owner])
      assert.equal(JSON.stringify(value).includes(secret), false);
  }
  assert.equal(calls.length, 4);
});
test('incomplete or malformed lifecycle lists fail closed rather than appearing empty or safe', async t => {
  let result = { contract: 'clued.storage-owner-lifecycle/1', complete: false, connections: [] };
  const calls = mock(t, () => Response.json(result));
  assert.equal((await worker.fetch(request({ action: 'list' }), env)).status, 409);
  result = { contract: 'clued.storage-owner-lifecycle/1', complete: true, connections: [{ ...row(), profile_id: 'foreign-invalid-id' }] };
  assert.equal((await worker.fetch(request({ action: 'list' }), env)).status, 409);
  assert.equal(rpcCalls(calls).length, 2);
});
test('normal precommitted Google callback remains completed when lifecycle activation is not_applicable', async t => {
  const state = 'S'.repeat(43), stateHash = createHash('sha256').update(state).digest('hex');
  const legacy = { status: 'completed', receipt_id: receipt, refresh_enabled: false, provider_scope_profile: 'normal', normal_use_enabled: false };
  const calls = mock(t, call => {
    if (call.url.endsWith('/clued_storage_oauth_callback_v2')) {
      assert.deepEqual(call.value, { p_issuer_secret: issuer, p_input: { action: 'claim', state_hash: stateHash } });
      return Response.json({ ...legacy, access_token: 'private-old-provider-token' });
    }
    assert.equal(call.url, db + '/rest/v1/rpc/clued_storage_owner_lifecycle_v1');
    assert.deepEqual(call.value, { p_issuer_hash: createHash('sha256').update(issuer).digest('hex'), p_input: { action: 'reconnect_activate', state_hash: stateHash } });
    return Response.json({ status: 'not_applicable', admission: 'private-activation-proof' });
  });
  // Reconnecting an existing folder is independent of new-folder onboarding.
  for (const onboarding of ['true','false']) {
    const response = await worker.fetch(request({ state, code: 'synthetic-callback-code' }, { path: '/v1/storage/google/complete' }),
      { ...env, CLUED_STORAGE_ONBOARD_V1: onboarding });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), legacy);
  }
  assert.equal(rpcCalls(calls).length, 4);
  assert.equal(calls.filter(c => c.url.endsWith('/auth/v1/user')).length, 4);
});

test('reconnect callback returns current Native renewal truth instead of the initial OAuth default', async t => {
  const state='R'.repeat(43),stateHash=createHash('sha256').update(state).digest('hex');
  let refreshEnabled=true;
  const calls=mock(t,call=>{
    if(call.url.endsWith('/clued_storage_oauth_callback_v2')){
      assert.equal(call.value.p_input.action,'claim');assert.equal(call.value.p_input.state_hash,stateHash);
      return Response.json({status:'completed',receipt_id:receipt,refresh_enabled:false,provider_scope_profile:'full'});
    }
    assert.equal(call.url,db+'/rest/v1/rpc/clued_storage_owner_lifecycle_v1');
    assert.equal(call.value.p_input.action,'reconnect_activate');assert.equal(call.value.p_input.state_hash,stateHash);
    return Response.json({status:'completed',receipt_id:receipt,connection_id:connection,
      master_state:'on',provider_scope_profile:'full',refresh_enabled:refreshEnabled,admission:'private-lifecycle-proof'});
  });
  for(const enabled of [true,false]){
    refreshEnabled=enabled;
    const response=await worker.fetch(request({state,code:'synthetic-callback-code'},{path:'/v1/storage/google/complete'}),env);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const result=await response.json();assert.equal(result.refresh_enabled,enabled);assert.equal(result.connection_id,connection);
    assert.equal(result.master_state,'on');assert.equal(JSON.stringify(result).includes('private-lifecycle-proof'),false);
  }
  assert.equal(rpcCalls(calls).length,4,'completed callback never repeats Google token exchange');
});
