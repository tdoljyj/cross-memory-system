import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",
  PROJECT_VIEWS_V2: 'true',
  ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${'m'.repeat(43)}`;

function request(token, name, args = {}) {
  return new Request('https://clued.test/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args } }),
  });
}

test('MTPE inspection tools are read-only and route Binding/OAuth calls to the same contract', async () => {
  const worker = await loadContinuityWorker();
  const listed = await worker.fetch(new Request('https://clued.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }), env, ctx);
  const tools = (await listed.json()).result.tools;
  for (const name of ['clued_mtpe_snapshot', 'clued_mtpe_validate']) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `${name} must be advertised`);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.deepEqual(tool._meta['clued/requiredScopes'], ['context:read']);
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  }
  const ownerPin = tools.find((item) => item.name === 'clued_mtpe_owner_pin');
  assert.ok(ownerPin);
  assert.equal(ownerPin.annotations.readOnlyHint, false);
  assert.equal(ownerPin.annotations.destructiveHint, false);
  assert.deepEqual(ownerPin._meta['clued/requiredScopes'], ['context:write']);
  assert.deepEqual(ownerPin.inputSchema.required,
    ['operation', 'record_id', 'base_version', 'idempotency_key', 'user_confirmed']);
  // A set names the focus it replaces; null means no focus is expected.
  assert.deepEqual(ownerPin.inputSchema.properties.expected_current_focus_id.anyOf,
    [{ type: 'string', format: 'uuid' }, { type: 'null' }]);
  assert.match(ownerPin.description, /owner_pin_focus_conflict/);
  assert.match(ownerPin.description, /clued_work_claim/);
  // The Owner's custom priority (20261031070000): on the Owner's request only, with the Owner's words.
  assert.deepEqual(ownerPin.inputSchema.properties.operation.enum, ['set', 'cancel', 'custom_priority_set']);
  assert.deepEqual([ownerPin.inputSchema.properties.priority.minimum, ownerPin.inputSchema.properties.priority.maximum], [0, 100]);
  assert.equal(ownerPin.inputSchema.properties.owner_instruction.type, 'string');
  assert.equal(ownerPin.inputSchema.properties.base_version.minimum, 0);
  assert.match(ownerPin.description, /only when the Owner explicitly asks/);
  assert.match(ownerPin.description, /owner_instruction/);

  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ rpc: /\/rpc\/([^/?]+)$/.exec(String(input))?.[1], body: JSON.parse(init.body) });
    return Response.json({ status: 'ok', candidate_universe_digest: 'a'.repeat(64) });
  };
  try {
    for (const name of ['clued_mtpe_snapshot', 'clued_mtpe_validate']) {
      for (const token of [bindingToken, 'oauth-access-token']) {
        const response = await worker.fetch(request(token, name), env, ctx);
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json()).result.structuredContent.status, 'ok');
      }
    }
    const pinArgs = { operation: 'set', record_id: '11111111-1111-4111-8111-111111111111',
      base_version: 3, expected_current_focus_id: null, idempotency_key: 'owner-pin-test',
      user_confirmed: true };
    for (const token of [bindingToken, 'oauth-access-token']) {
      const response = await worker.fetch(request(token, 'clued_mtpe_owner_pin', pinArgs), env, ctx);
      assert.equal(response.status, 200, await response.clone().text());
    }
    assert.deepEqual(calls.map(({ rpc, body }) => [rpc, body.p_tool]), [
      ['clued_mcp_mtpe_snapshot', undefined], ['clued_oauth_call', 'clued_mtpe_snapshot'],
      ['clued_mcp_mtpe_validate', undefined], ['clued_oauth_call', 'clued_mtpe_validate'],
      ['clued_mcp_mtpe_owner_pin', undefined], ['clued_oauth_call', 'clued_mtpe_owner_pin'],
    ]);
    assert.ok(calls[0].body.p_token_hash?.match(/^[0-9a-f]{64}$/));
    assert.deepEqual(calls[0].body.p_input, {});
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('MTPE coverage denial is a tool error, not an HTTP authorization failure', async () => {
  const worker = await loadContinuityWorker();
  const denial = { status: 'denied', rule: 'mtpe-read-set-coverage.v1',
    error: { code: 'INSUFFICIENT_CONTEXT_COVERAGE', message: 'coverage required',
      missing_context_keys: ['project:22222222-2222-4222-8222-222222222222'], unscoped_sources: 0 } };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(denial);
  try {
    for (const name of ['clued_mtpe_snapshot', 'clued_mtpe_validate']) {
      const response = await worker.fetch(request(bindingToken, name), env, ctx);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('www-authenticate'), null);
      const result = (await response.json()).result;
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, denial);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});
