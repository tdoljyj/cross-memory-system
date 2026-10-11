import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

// Search re-review (Task f46591b2): clued_search_context's input refusals
// (SQLSTATE 22023, HTTP 400 from PostgREST) reach the Agent as tool errors
// with a fixed message, not as a transport failure.

const assets = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
const env = { ...assets, PROJECT_VIEWS_V2: 'true' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${'s'.repeat(43)}`;

function mcp(name, args, method = 'tools/call') {
  return new Request('https://clued.test/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${bindingToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name, arguments: args } : {} }),
  });
}
function mockFetch(reply) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), body: JSON.parse(init.body) });
    return reply();
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}
const pgError = (message, code = '22023') => () => Response.json({ code, message, details: 'raw detail', hint: null }, { status: 400 });

test('each search input refusal is a tool error with a fixed message', async () => {
  const worker = await loadContinuityWorker();
  for (const code of ['invalid_query_length', 'invalid_search_scope', 'invalid_page_input', 'search_cursor_too_deep', 'project_scope_unresolved']) {
    const { calls, restore } = mockFetch(pgError(code));
    try {
      const response = await worker.fetch(mcp('clued_search_context', { session_token: 'x', query: 'q' }), env, ctx);
      assert.equal(response.status, 200, code);
      const { result } = await response.json();
      assert.equal(result.isError, true, code);
      assert.equal(result.structuredContent.status, 'rejected');
      assert.equal(result.structuredContent.error.code, code);
      assert.equal(result.structuredContent.error.category, 'request_validation');
      assert.ok(result.structuredContent.error.message.length > 10);
      assert.ok(!JSON.stringify(result).includes('raw detail'), 'no raw database detail');
      assert.match(calls[0].url, /\/rpc\/clued_mcp_search_context$/);
    } finally { restore(); }
  }
});

test('other 400 errors, and 22023 on other tools, are unchanged', async () => {
  const worker = await loadContinuityWorker();
  for (const [name, reply] of [
    ['clued_search_context', pgError('something_else')],
    ['clued_search_context', pgError('invalid_page_input', '22P02')],
    ['clued_read_log', pgError('invalid_page_input')],
  ]) {
    const { restore } = mockFetch(reply);
    try {
      const response = await worker.fetch(mcp(name, { session_token: 'x', query: 'q' }), env, ctx);
      assert.equal(response.status, 400, name);
      assert.ok((await response.json()).error, name);
    } finally { restore(); }
  }
});

test('the search schema states the paging limit', async () => {
  const worker = await loadContinuityWorker();
  const { restore } = mockFetch(() => Response.json({}));
  try {
    const response = await worker.fetch(mcp(null, null, 'tools/list'), env, ctx);
    const tool = (await response.json()).result.tools.find((t) => t.name === 'clued_search_context');
    assert.equal(tool.inputSchema.properties.cursor.maximum, 10000);
    assert.match(tool.description, /10000 results/);
    assert.match(tool.description, /session_context_mismatch/);
  } finally { restore(); }
});
