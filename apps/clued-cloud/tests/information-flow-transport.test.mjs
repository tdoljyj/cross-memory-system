import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

const env = {
  PROJECT_VIEWS_V2: 'true',
  ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) },
};
const bindingToken = `clued_bnd_${'i'.repeat(43)}`;
const candidateId = '33333333-3333-4333-8333-333333333333';
const informationFlowTools = ['clued_intake_submit', 'clued_intake_list', 'clued_intake_withdraw',
  'clued_knowledge_propose', 'clued_context_pack'];

function mcp(token, name, args = {}) {
  return new Request('https://clued.test/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
}

function rest(pathname, { method = 'POST', token = 'account-jwt', body } = {}) {
  return new Request(`https://clued.test${pathname}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function withStorage(handler, run) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '44444444-4444-4444-8444-444444444444' });
    const rpc = /\/rpc\/([^/?]+)$/.exec(url)?.[1];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ rpc, body });
    return Response.json(handler(rpc, body));
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('the five Information Flow MCP tools are advertised with scopes, and no promotion tool exists', async () => {
  const worker = await loadContinuityWorker();
  const list = async (flags) => (await (await worker.fetch(new Request('https://clued.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), flags, {})).json()).result.tools;
  const tools = await list(env);
  for (const name of informationFlowTools) assert.ok(tools.find((tool) => tool.name === name), name);
  assert.ok(!tools.some((tool) => /promot|confirm|reject|polic|withdrawal/.test(tool.name)),
    'confirmation, promotion, policy and Evidence withdrawal stay Native-only');
  const scopes = Object.fromEntries(tools.filter((tool) => informationFlowTools.includes(tool.name))
    .map((tool) => [tool.name, tool._meta['clued/requiredScopes']]));
  assert.deepEqual(scopes, {
    clued_intake_submit: ['context:write'], clued_intake_list: ['context:read'],
    clued_intake_withdraw: ['context:write'], clued_knowledge_propose: ['context:write'],
    clued_context_pack: ['context:read'],
  });
  const submit = tools.find((tool) => tool.name === 'clued_intake_submit');
  assert.equal(submit.inputSchema.additionalProperties, false);
  for (const smuggled of ['tier', 'authority', 'record_type', 'binding_id', 'source_kind']) {
    assert.ok(!(smuggled in submit.inputSchema.properties), smuggled);
  }
  const disabled = await list({ ...env, PROJECT_VIEWS_V2: 'false' });
  assert.ok(!disabled.some((tool) => informationFlowTools.includes(tool.name)));
});

test('Binding and OAuth MCP calls reach the Binding entries; REST reaches the account entries', async () => {
  const worker = await loadContinuityWorker();
  await withStorage(() => ({ status: 'committed', receipt_id: 'r' }), async (calls) => {
    for (const name of informationFlowTools) {
      for (const token of [bindingToken, 'oauth-access-token']) {
        const response = await worker.fetch(mcp(token, name, { scope: 'global' }), env, {});
        assert.equal(response.status, 200, await response.clone().text());
      }
    }
    assert.deepEqual(calls.map(({ rpc, body }) => [rpc, body.p_tool ?? null]), informationFlowTools.flatMap((name) =>
      [[name, null], ['clued_oauth_call', name]]));
    assert.ok(calls.filter(({ rpc }) => rpc !== 'clued_oauth_call')
      .every(({ body }) => /^[0-9a-f]{64}$/.test(body.p_token_hash) && !JSON.stringify(body).includes(bindingToken)));

    calls.length = 0;
    const submit = { idempotency_key: 'rest-intake-0001', scope: 'global', segment: {}, candidates: {} };
    assert.equal((await worker.fetch(rest('/v1/intake', { body: submit }), env, {})).status, 200);
    assert.equal((await worker.fetch(rest('/v1/knowledge/candidates', { body: { idempotency_key: 'rest-kp-0001' } }),
      env, {})).status, 200);
    assert.equal((await worker.fetch(rest(`/v1/intake/${candidateId}/withdraw`,
      { body: { idempotency_key: 'rest-wd-0001', base_version: 1 } }), env, {})).status, 200);
    assert.equal((await worker.fetch(rest('/v1/context/pack', { body: { scope: 'global' } }), env, {})).status, 200);
    assert.equal((await worker.fetch(rest('/v1/intake?scope=global&tier=knowledge&limit=5', { method: 'GET' }),
      env, {})).status, 200);
    assert.deepEqual(calls.map(({ rpc }) => rpc), ['clued_user_intake_submit', 'clued_user_knowledge_propose',
      'clued_user_intake_withdraw', 'clued_user_context_pack', 'clued_user_intake_list']);
    assert.match(calls[0].body.p_received_payload_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(calls[0].body.p_input, submit);
    assert.equal(calls[2].body.p_input.candidate_id, candidateId, 'the path binds the candidate');
    assert.deepEqual(calls[4].body, { p_input: { scope: 'global', tier: 'knowledge', limit: 5 } });
  });
});

test('Native Information Flow routes reject Binding tokens before any RPC and validate input', async () => {
  const worker = await loadContinuityWorker();
  await withStorage(() => ({ status: 'committed' }), async (calls) => {
    for (const pathname of ['/v1/intake', '/v1/knowledge/candidates', `/v1/intake/${candidateId}/withdraw`,
      '/v1/context/pack']) {
      const response = await worker.fetch(rest(pathname, { token: bindingToken, body: { idempotency_key: 'x'.repeat(8) } }),
        env, {});
      assert.equal(response.status, 401, pathname);
    }
    assert.equal((await worker.fetch(rest('/v1/intake', { method: 'GET', token: bindingToken }), env, {})).status, 401);
    assert.equal((await worker.fetch(rest('/v1/intake?scope=global&authority=user_explicit', { method: 'GET' }),
      env, {})).status, 422);
    assert.equal((await worker.fetch(rest('/v1/intake?limit=0', { method: 'GET' }), env, {})).status, 422);
    assert.equal((await worker.fetch(rest('/v1/intake?limit=201', { method: 'GET' }), env, {})).status, 422);
    assert.equal((await worker.fetch(rest('/v1/intake?scope=global&scope=profile', { method: 'GET' }), env, {})).status, 422);
    assert.equal((await worker.fetch(rest(`/v1/intake/${candidateId}/withdraw`, {
      body: { idempotency_key: 'rest-wd-0002', candidate_id: '55555555-5555-4555-8555-555555555555', base_version: 1 },
    }), env, {})).status, 422, 'a body candidate_id cannot redirect the path-bound candidate');
    // Promotion, confirmation, policy and withdrawal routes are not served before their slices.
    for (const pathname of [`/v1/intake/${candidateId}/promote`, `/v1/intake/${candidateId}/confirmation`,
      `/v1/knowledge/candidates/${candidateId}/promote`]) {
      assert.equal((await worker.fetch(rest(pathname, { body: {} }), env, {})).status, 404, pathname);
    }
    const wrongMethod = await worker.fetch(rest('/v1/knowledge/candidates', { method: 'GET' }), env, {});
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
    assert.equal((await worker.fetch(rest('/v1/intake', { body: {} }), { ...env, PROJECT_VIEWS_V2: 'false' }, {}))
      .status, 404);
    assert.equal(calls.length, 0, 'no storage RPC ran');
  });
});

test('rejected Receipts map to HTTP status, and oversize bodies stop at the transport', async () => {
  const worker = await loadContinuityWorker();
  await withStorage((rpc) => rpc === 'clued_user_intake_withdraw'
    ? { status: 'rejected', error_code: 'candidate_version_conflict' }
    : { status: 'rejected', error_code: 'knowledge_source_not_human_confirmed' }, async (calls) => {
    assert.equal((await worker.fetch(rest('/v1/knowledge/candidates', { body: { idempotency_key: 'rest-kp-0002' } }),
      env, {})).status, 422);
    assert.equal((await worker.fetch(rest(`/v1/intake/${candidateId}/withdraw`,
      { body: { idempotency_key: 'rest-wd-0003', base_version: 9 } }), env, {})).status, 409);
    const huge = { idempotency_key: 'rest-huge-0001', scope: 'global', client_label: 'x'.repeat(1024 * 1024) };
    assert.equal((await worker.fetch(rest('/v1/intake', { body: huge }), env, {})).status, 413);
    const hugeMcp = await worker.fetch(mcp(bindingToken, 'clued_intake_submit', huge), env, {});
    assert.equal(hugeMcp.status, 413);
    assert.equal(calls.length, 2);
  });
});

test('Information Flow writes schedule the post-commit projection refresh', async () => {
  const worker = await loadContinuityWorker();
  const refreshEnv = { ...env, CLUED_PROJECTION_BUILDER_TOKEN: `clued_bnd_${'p'.repeat(43)}` };
  await withStorage((rpc) => rpc?.startsWith('clued_mcp_projection_refresh') ? { status: 'idle' } : { status: 'committed' },
    async () => {
      const scheduled = [];
      const ctx = { waitUntil(promise) { scheduled.push(promise); }, passThroughOnException() {} };
      for (const pathname of ['/v1/intake', '/v1/knowledge/candidates', `/v1/intake/${candidateId}/withdraw`]) {
        const before = scheduled.length;
        const response = await worker.fetch(rest(pathname, { body: { idempotency_key: 'refresh-0001', base_version: 1 } }),
          refreshEnv, ctx);
        assert.equal(response.status, 200, pathname);
        assert.equal(scheduled.length, before + 1, pathname);
      }
      const before = scheduled.length;
      await worker.fetch(rest('/v1/intake?scope=global', { method: 'GET' }), refreshEnv, ctx);
      assert.equal(scheduled.length, before, 'reads do not schedule a refresh');
      await Promise.allSettled(scheduled);
    });
});
