import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

// Task 8ba4ef85 items 4 and 6: resume used to make three serial database round
// trips (the tool, then the live-claims read, then the inbox summary), renew
// two. The two fold-in reads are independent, so they now run concurrently:
// resume is two serial steps, renew two (its summary needs the committed
// claim), checkpoint one. Every read keeps its own token, scope and input.

const env = { CLUED_DB_GATEWAY_TOKEN: 'test-worker-gateway', ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) },
  PROJECT_VIEWS_V2: 'true', CLUED_WORK_CLAIMS_V1: 'true', CLUED_AGENT_MESSAGES_V1: 'true' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${'s'.repeat(43)}`;
const oauthToken = 'account-or-legacy-oauth-token';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const SCOPE = 'project:55555555-5555-4555-8555-555555555555';

const mcp = (token, name, args = {}) => new Request('https://clued.test/mcp', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
});
const isSummary = ({ rpc, body }) => rpc === 'clued_agent_inbox_summary_v1' || body.p_tool === 'clued_agent_inbox_summary';
const isClaims = ({ rpc, body }) => rpc === 'clued_work_claims_active_v1' || body.p_tool === 'clued_work_claims_active';

// Every database call takes a macrotask to answer; `steps` counts serial steps:
// a call that starts while none is in flight begins a new step.
function measuredFetch(answer) {
  const previous = globalThis.fetch;
  const calls = [];
  let inflight = 0;
  let steps = 0;
  globalThis.fetch = async (input, init = {}) => {
    const rpc = /\/rpc\/([^/?]+)$/.exec(String(input))?.[1];
    const call = { rpc, body: JSON.parse(init.body), authorization: new Headers(init.headers).get('authorization') };
    calls.push(call);
    if (inflight === 0) steps += 1;
    inflight += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    inflight -= 1;
    return Response.json(answer(call));
  };
  return { calls, steps: () => steps, restore: () => { globalThis.fetch = previous; } };
}

const resume = { status: 'restored', session_token: 'session-test', version: 7, active_constraints: [] };
const claims = { status: 'ok', active_work_claims: [], work_claim_profile: {} };
const summary = { status: 'ok', unread_count: 1, open_request_count: 0, awaiting_reply_count: 0, latest_unread: [] };
const renewed = { status: 'committed', receipt_id: 'r-2', claim: { claim_id: CLAIM, lease_version: 2 } };
const answerResume = (call) => (isSummary(call) ? summary : isClaims(call) ? claims : resume);

test('resume reads claims and inbox concurrently: two serial steps, three calls, same result', async () => {
  const worker = await loadContinuityWorker();
  for (const token of [bindingToken, oauthToken]) {
    const m = measuredFetch(answerResume);
    try {
      const result = (await (await worker.fetch(mcp(token, 'clued_session_resume',
        { context_key: SCOPE, client_session_id: 'session-b' }), env, ctx)).json()).result.structuredContent;
      assert.equal(m.calls.length, 3);
      assert.equal(m.steps(), 2, 'resume: tool, then both fold-in reads together');
      assert.equal(result.agent_inbox.unread_count, 1);
      assert.deepEqual(result.active_work_claims, []);
      assert.equal(result.session_token, 'session-test');
      // Isolation: both fold-ins carry the caller's own credential, the requested scope, and nothing else.
      const [tool] = m.calls;
      for (const call of m.calls) {
        assert.equal(call.authorization, tool.authorization);
        if (token === bindingToken) assert.equal(call.body.p_token_hash, tool.body.p_token_hash);
      }
      assert.deepEqual(m.calls.find(isClaims).body.p_input, { scope: SCOPE });
      assert.deepEqual(m.calls.find(isSummary).body.p_input, { scope: SCOPE, session_ref: 'session-b' });
    } finally { m.restore(); }
  }
});

test('a refused or failed resume makes no fold-in read; a failing fold-in does not fail the resume', async () => {
  const worker = await loadContinuityWorker();
  const refused = measuredFetch(() => ({ error: 'resume_failed' }));
  try {
    const result = (await (await worker.fetch(mcp(bindingToken, 'clued_session_resume', {}), env, ctx)).json()).result.structuredContent;
    assert.deepEqual(result, { error: 'resume_failed' });
    assert.equal(refused.calls.length, 1);
  } finally { refused.restore(); }

  const previous = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async (input, init = {}) => {
    called += 1;
    const body = JSON.parse(init.body);
    const rpc = /\/rpc\/([^/?]+)$/.exec(String(input))?.[1];
    if (isSummary({ rpc, body }) || isClaims({ rpc, body })) throw new Error('database unavailable');
    return Response.json(resume);
  };
  try {
    const result = (await (await worker.fetch(mcp(bindingToken, 'clued_session_resume', {}), env, ctx)).json()).result.structuredContent;
    assert.equal(result.status, 'restored');
    assert.equal(called, 3);
  } finally { globalThis.fetch = previous; }
});

test('renew is two serial steps and checkpoint one', async () => {
  const worker = await loadContinuityWorker();
  const renew = measuredFetch((call) => (isSummary(call) ? { ...summary, claim_id: CLAIM } : renewed));
  try {
    await worker.fetch(mcp(bindingToken, 'clued_work_renew',
      { scope: SCOPE, claim_id: CLAIM, fence: 1, lease_version: 1, progress_ref: 'sha-2' }), env, ctx);
    assert.equal(renew.calls.length, 2);
    assert.equal(renew.steps(), 2);
    assert.deepEqual(renew.calls.find(isSummary).body.p_input, { scope: SCOPE, claim_id: CLAIM });
  } finally { renew.restore(); }

  const checkpoint = measuredFetch(() => ({ status: 'committed', session_renewal: { session_token: 'session-next' } }));
  try {
    await worker.fetch(mcp(bindingToken, 'clued_session_checkpoint', { context_key: SCOPE }), env, ctx);
    assert.equal(checkpoint.calls.length, 1);
    assert.equal(checkpoint.steps(), 1);
  } finally { checkpoint.restore(); }
});
