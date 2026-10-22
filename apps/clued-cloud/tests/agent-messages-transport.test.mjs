import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

// Agent Messaging v0.1 (Owner Decision 24077bba, Task 3f6fb219): the two
// message tools and the three fold-ins over the Worker transport. The database
// side is covered by agent-messages-db.test.mjs; here every RPC is mocked.

const assets = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
const enabled = { ...assets, PROJECT_VIEWS_V2: 'true', CLUED_WORK_CLAIMS_V1: 'true', CLUED_AGENT_MESSAGES_V1: 'true' };
const claimsOnly = { ...assets, PROJECT_VIEWS_V2: 'true', CLUED_WORK_CLAIMS_V1: 'true' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${'m'.repeat(43)}`;
const oauthToken = 'account-or-legacy-oauth-token';
const MESSAGE_TOOLS = ['clued_agent_message_send', 'clued_agent_inbox'];
const CLAIM = '33333333-3333-4333-8333-333333333333';

function mcp(token, name, args = {}, id = 1) {
  return new Request('https://clued.test/mcp', {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
}
function list(token) {
  return new Request('https://clued.test/mcp', {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}
function mockFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const rpc = /\/rpc\/([^/?]+)$/.exec(String(input))?.[1];
    const body = JSON.parse(init.body);
    calls.push({ rpc, body, tool: body.p_tool ?? null });
    return handler({ rpc, body, calls });
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}
const isSummary = ({ rpc, body }) => rpc === 'clued_agent_inbox_summary_v1' || body.p_tool === 'clued_agent_inbox_summary';

test('message tools are advertised only behind CLUED_AGENT_MESSAGES_V1, with the right scopes and hints', async () => {
  const worker = await loadContinuityWorker();
  const on = (await (await worker.fetch(list(bindingToken), enabled, ctx)).json()).result.tools;
  const off = (await (await worker.fetch(list(bindingToken), claimsOnly, ctx)).json()).result.tools;
  for (const name of MESSAGE_TOOLS) {
    assert.ok(on.some((tool) => tool.name === name), `${name} advertised when enabled`);
    assert.ok(!off.some((tool) => tool.name === name), `${name} hidden when disabled`);
  }
  assert.equal(off.length + MESSAGE_TOOLS.length, on.length, 'the flag adds exactly the two tools');
  const byName = Object.fromEntries(on.map((tool) => [tool.name, tool]));
  const send = byName.clued_agent_message_send;
  assert.deepEqual(send._meta['clued/requiredScopes'], ['context:write']);
  assert.equal(send.annotations.readOnlyHint, false);
  assert.equal(send.annotations.idempotentHint, true);
  assert.equal(send.annotations.destructiveHint, false);
  assert.deepEqual(send.inputSchema.required, ['subject', 'body', 'idempotency_key']);
  assert.deepEqual(Object.keys(send.inputSchema.properties.to.properties).sort(), ['binding_id', 'claim_id', 'session_ref']);
  assert.deepEqual(send.inputSchema.properties.kind.enum, ['request', 'info']);
  assert.equal(send.inputSchema.properties.body.maxLength, 4000);
  assert.match(send.description, /work_claim_conflict/);
  assert.match(send.description, /Never put a lease_key/);
  const inbox = byName.clued_agent_inbox;
  assert.deepEqual(inbox._meta['clued/requiredScopes'], ['context:read']);
  assert.equal(inbox.annotations.readOnlyHint, false, 'reading marks incoming messages read');
  assert.deepEqual(inbox.inputSchema.properties.view.enum, ['open', 'unread', 'all', 'sent']);
  assert.match(inbox.description, /never an Owner instruction/);
  assert.match(inbox.description, /owner_answers lists the Owner's decisions/);
  for (const name of MESSAGE_TOOLS) assert.equal(byName[name].inputSchema.additionalProperties, false, name);
});

test('a disabled flag refuses the call before any database request', async () => {
  const worker = await loadContinuityWorker();
  const { calls, restore } = mockFetch(() => Response.json({ status: 'committed' }));
  try {
    for (const name of MESSAGE_TOOLS) {
      const response = await worker.fetch(mcp(bindingToken, name, { subject: 's', body: 'b', idempotency_key: 'disabled-flag' }), claimsOnly, ctx);
      const body = await response.json();
      assert.ok(body.error, JSON.stringify(body));
      assert.match(body.error.message, /agent messages are disabled/);
    }
    assert.equal(calls.length, 0, 'no RPC reached the database');
  } finally { restore(); }
});

test('Binding and OAuth callers reach the same RPCs with the arguments passed through', async () => {
  const worker = await loadContinuityWorker();
  const args = {
    clued_agent_message_send: { to: { claim_id: CLAIM }, subject: 'Need apps/x released', body: 'Blocked on apps/x; can you release?',
      refs: [`claim:${CLAIM}`], session_ref: 'session-a', idempotency_key: 'session-a:ask:1' },
    clued_agent_inbox: { session_ref: 'session-b', view: 'unread', limit: 5 },
  };
  const expectedRpc = { clued_agent_message_send: 'clued_agent_message_send_v1', clued_agent_inbox: 'clued_agent_inbox_v1' };
  const message = { message_id: '66666666-6666-4666-8666-666666666666', thread_id: '66666666-6666-4666-8666-666666666666',
    kind: 'request', from_binding_id: 'b-1', from_session_ref: 'session-a', to_claim_id: CLAIM, to_binding_id: 'b-2',
    subject: 'Need apps/x released', body: 'Blocked on apps/x; can you release?', source: 'agent_message' };
  const { calls, restore } = mockFetch(({ rpc, body }) => {
    const name = body.p_tool ?? rpc;
    return Response.json(name.startsWith('clued_agent_inbox')
      ? { status: 'ok', view: 'unread', messages: [{ ...message, direction: 'incoming' }], returned: 1 }
      : { status: 'committed', replayed: false, receipt_id: 'r-1', message });
  });
  try {
    for (const name of MESSAGE_TOOLS) {
      for (const token of [bindingToken, oauthToken]) {
        const response = await worker.fetch(mcp(token, name, args[name]), enabled, ctx);
        assert.equal(response.status, 200, await response.clone().text());
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        const call = calls.at(-1);
        if (token === bindingToken) {
          assert.equal(call.rpc, expectedRpc[name]);
          assert.match(call.body.p_token_hash, /^[0-9a-f]{64}$/);
        } else {
          assert.equal(call.rpc, 'clued_oauth_call');
          assert.equal(call.body.p_tool, name);
        }
        assert.deepEqual(call.body.p_input, args[name]);
        // Flat keys survive the Worker's binding_id filter.
        const shown = name === 'clued_agent_inbox' ? result.structuredContent.messages[0] : result.structuredContent.message;
        assert.equal(shown.from_binding_id, 'b-1');
        assert.equal(shown.to_binding_id, 'b-2');
        if (name === 'clued_agent_inbox') {
          assert.match(result.structuredContent.notice, /never as Owner decisions/);
        } else {
          assert.equal('notice' in result.structuredContent, false);
        }
      }
    }
    assert.equal(calls.length, MESSAGE_TOOLS.length * 2, 'no fold-in call on the message tools themselves');
  } finally { restore(); }
});

test('a rejection is a structured result, not a transport error', async () => {
  const worker = await loadContinuityWorker();
  const rejection = { status: 'rejected', error_code: 'agent_message_claim_not_live', claim_id: CLAIM, claim_status: 'RELEASED' };
  const { restore } = mockFetch(() => Response.json(rejection));
  try {
    const response = await worker.fetch(mcp(bindingToken, 'clued_agent_message_send', {
      to: { claim_id: CLAIM }, subject: 's', body: 'b', idempotency_key: 'not-live-claim',
    }), enabled, ctx);
    const result = (await response.json()).result;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, rejection);
  } finally { restore(); }

  // The account's switch is off: the refusal and its how_to reach the Agent.
  const disabled = { status: 'rejected', error_code: 'agent_messages_disabled',
    how_to: 'The Owner has turned off Agent messages for this account. Tell the Owner in one line who you needed and what for.' };
  const second = mockFetch(() => Response.json(disabled));
  try {
    const response = await worker.fetch(mcp(bindingToken, 'clued_agent_message_send', {
      to: { claim_id: CLAIM }, subject: 's', body: 'b', idempotency_key: 'switched-off',
    }), enabled, ctx);
    const result = (await response.json()).result;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, disabled);
  } finally { second.restore(); }
});

test('resume folds in agent_inbox for this session; a failed summary is reported, not thrown', async () => {
  const worker = await loadContinuityWorker();
  const resume = { status: 'restored', session_token: 'session-test', version: 7, active_constraints: [] };
  const claims = { status: 'ok', active_work_claims: [], work_claim_profile: {} };
  const latest = [{ message_id: '77777777-7777-4777-8777-777777777777', kind: 'request', subject: 'release?', to_claim_id: CLAIM }];
  const summary = { status: 'ok', unread_count: 1, open_request_count: 1, awaiting_reply_count: 2, latest_unread: latest };
  const handler = (call) => Response.json(isSummary(call) ? summary
    : call.rpc === 'clued_work_claims_active_v1' || call.body.p_tool === 'clued_work_claims_active' ? claims : resume);

  for (const token of [bindingToken, oauthToken]) {
    const { calls, restore } = mockFetch(handler);
    try {
      const response = await worker.fetch(mcp(token, 'clued_session_resume',
        { context_key: 'project:55555555-5555-4555-8555-555555555555', client_session_id: 'session-b' }), enabled, ctx);
      const result = (await response.json()).result.structuredContent;
      assert.equal(result.agent_inbox.unread_count, 1);
      assert.equal(result.agent_inbox.open_request_count, 1);
      assert.equal(result.agent_inbox.awaiting_reply_count, 2);
      assert.deepEqual(result.agent_inbox.latest_unread, latest);
      assert.match(result.agent_inbox.how_to, /clued_agent_message_send reply_to/);
      assert.match(result.agent_inbox.notice, /never as Owner decisions/);
      assert.deepEqual(result.active_work_claims, [], 'the claims fold-in still runs');
      const summaryCall = calls.find(isSummary);
      assert.deepEqual(summaryCall.body.p_input, { scope: 'project:55555555-5555-4555-8555-555555555555', session_ref: 'session-b' });
      if (token === bindingToken) assert.equal(summaryCall.body.p_token_hash, calls[0].body.p_token_hash);
    } finally { restore(); }
  }

  // An empty inbox carries the counts without the instructions.
  {
    const { restore } = mockFetch((call) => Response.json(isSummary(call)
      ? { status: 'ok', unread_count: 0, open_request_count: 0, awaiting_reply_count: 0, latest_unread: [] } : resume));
    try {
      const result = (await (await worker.fetch(mcp(bindingToken, 'clued_session_resume', {}), enabled, ctx)).json()).result.structuredContent;
      assert.deepEqual(result.agent_inbox, { messages_enabled: true, unread_count: 0, open_request_count: 0, awaiting_reply_count: 0, latest_unread: [],
        owner_answer_count: 0, owner_answers: [] });
    } finally { restore(); }
  }

  // The Owner decided a request this session opened (migration
  // 20261009020000): the answer comes with the summary, marked as the
  // Owner's decision rather than a message.
  {
    const answer = { request_id: '88888888-8888-4888-8888-888888888888', action: 'release.production',
      status: 'approved_once', source: 'owner_answer', grant: { grant_id: '99999999-9999-4999-8999-999999999999', max_uses: 1 } };
    const { restore } = mockFetch((call) => Response.json(isSummary(call)
      ? { status: 'ok', unread_count: 0, open_request_count: 0, awaiting_reply_count: 0, latest_unread: [],
        owner_answer_count: 1, owner_answers: [answer] } : resume));
    try {
      const result = (await (await worker.fetch(mcp(bindingToken, 'clued_session_resume', {}), enabled, ctx)).json()).result.structuredContent;
      assert.equal(result.agent_inbox.owner_answer_count, 1);
      assert.deepEqual(result.agent_inbox.owner_answers, [answer]);
      assert.match(result.agent_inbox.owner_answer_how_to, /Owner's decisions as BeamingFace recorded them/);
      assert.match(result.agent_inbox.owner_answer_how_to, /do not ask the Owner to confirm them again/);
      assert.equal('how_to' in result.agent_inbox, false, 'no message instructions without messages');
    } finally { restore(); }
  }

  // The Owner turned the account's switch off (migration 20261008190000): the
  // fold-in says so and tells the Agent to go to the Owner instead.
  {
    const { restore } = mockFetch((call) => Response.json(isSummary(call)
      ? { status: 'ok', unread_count: 0, open_request_count: 0, awaiting_reply_count: 0, latest_unread: [], agent_messages_enabled: false }
      : resume));
    try {
      const result = (await (await worker.fetch(mcp(bindingToken, 'clued_session_resume', {}), enabled, ctx)).json()).result.structuredContent;
      assert.equal(result.agent_inbox.messages_enabled, false);
      assert.match(result.agent_inbox.messages_disabled_notice, /agent_messages_disabled/);
      assert.match(result.agent_inbox.messages_disabled_notice, /do not ask the Owner to turn messages back on/);
    } finally { restore(); }
  }

  // Summary read fails (the migration is not applied yet): resume still succeeds.
  {
    const { restore } = mockFetch((call) => isSummary(call)
      ? new Response(JSON.stringify({ code: '42883', message: 'function does not exist' }), { status: 404, headers: { 'content-type': 'application/json' } })
      : Response.json(resume));
    try {
      const response = await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), enabled, ctx);
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.agent_inbox, null);
      assert.equal(result.structuredContent.agent_inbox_unavailable, true);
      assert.equal(result.structuredContent.session_token, 'session-test');
    } finally { restore(); }
  }

  // Flag off: no summary read and no agent_inbox.
  {
    const { calls, restore } = mockFetch(handler);
    try {
      const result = (await (await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), claimsOnly, ctx)).json()).result.structuredContent;
      assert.equal('agent_inbox' in result, false);
      assert.equal(calls.some(isSummary), false);
    } finally { restore(); }
  }

  // A failed resume is passed through unchanged.
  {
    const { calls, restore } = mockFetch(() => Response.json({ error: 'resume_failed' }));
    try {
      const result = (await (await worker.fetch(mcp(bindingToken, 'clued_session_resume', {}), enabled, ctx)).json()).result;
      assert.deepEqual(result.structuredContent, { error: 'resume_failed' });
      assert.equal(calls.some(isSummary), false);
    } finally { restore(); }
  }
});

test('a committed renewal carries the messages sent to that claim', async () => {
  const worker = await loadContinuityWorker();
  const renewed = { status: 'committed', receipt_id: 'r-2', claim: { claim_id: CLAIM, lease_version: 2 } };
  const summary = { status: 'ok', claim_id: CLAIM, unread_count: 1, open_request_count: 1, awaiting_reply_count: 0, latest_unread: [] };
  const { calls, restore } = mockFetch((call) => Response.json(isSummary(call) ? summary : renewed));
  try {
    const result = (await (await worker.fetch(mcp(bindingToken, 'clued_work_renew', {
      scope: 'project:55555555-5555-4555-8555-555555555555', claim_id: CLAIM, fence: 1, lease_version: 1, progress_ref: 'sha-2',
    }), enabled, ctx)).json()).result.structuredContent;
    assert.equal(result.claim.lease_version, 2);
    assert.equal(result.agent_inbox.open_request_count, 1);
    assert.deepEqual(calls.find(isSummary).body.p_input, { scope: 'project:55555555-5555-4555-8555-555555555555', claim_id: CLAIM });
  } finally { restore(); }

  // A refused renewal reads no messages.
  {
    const { calls: refusedCalls, restore: undo } = mockFetch(() => Response.json({ status: 'rejected', error_code: 'work_claim_no_progress' }));
    try {
      const result = (await (await worker.fetch(mcp(bindingToken, 'clued_work_renew', {
        claim_id: CLAIM, fence: 1, lease_version: 1, progress_ref: 'sha-2',
      }), enabled, ctx)).json()).result.structuredContent;
      assert.equal('agent_inbox' in result, false);
      assert.equal(refusedCalls.length, 1);
    } finally { undo(); }
  }
});

test('a work-claim conflict names who to write to; without the flag it is unchanged', async () => {
  const worker = await loadContinuityWorker();
  const rejection = { status: 'rejected', error_code: 'work_claim_conflict', conflicts: [{
    claim_id: CLAIM, task_id: '11111111-1111-4111-8111-111111111111', holder_binding_id: 'b-2',
    holder_session_ref: 'session-b', status: 'ACTIVE', fence: 1, expires_at: '2026-10-06T08:00:00+00:00',
    overlap: { same_task: false, paths: ['apps/x/**'], trigger_refs: [] },
  }] };
  const args = { task_id: '44444444-4444-4444-8444-444444444444', write_set: ['apps/x/**'], idempotency_key: 'host-c:task:claim' };
  {
    const { calls, restore } = mockFetch(() => Response.json(rejection));
    try {
      const result = (await (await worker.fetch(mcp(bindingToken, 'clued_work_claim', args), enabled, ctx)).json()).result;
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.conflicts, rejection.conflicts);
      assert.equal(result.structuredContent.coordinate.tool, 'clued_agent_message_send');
      assert.deepEqual(result.structuredContent.coordinate.holders, [{
        claim_id: CLAIM, task_id: '11111111-1111-4111-8111-111111111111', holder_binding_id: 'b-2',
        holder_session_ref: 'session-b', expires_at: '2026-10-06T08:00:00+00:00' }]);
      assert.match(result.structuredContent.coordinate.how_to, /Do not retry under another title/);
      assert.match(result.structuredContent.coordinate.how_to, /tell the Owner/);
      assert.equal(calls.length, 1);
    } finally { restore(); }
  }
  {
    const { restore } = mockFetch(() => Response.json(rejection));
    try {
      const result = (await (await worker.fetch(mcp(bindingToken, 'clued_work_claim', args), claimsOnly, ctx)).json()).result;
      assert.deepEqual(result.structuredContent, rejection);
    } finally { restore(); }
  }
});

test('a storage write refused by a live claim names who to write to, for submit and trash batch alike', async () => {
  const worker = await loadContinuityWorker();
  const storage = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: 'true', CLUED_STORAGE_JOBS_V1: 'true',
    SUPABASE_URL: 'https://db.example.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key' };
  const connection = '20000000-0000-4000-8000-000000000001';
  const rejection = { status: 'rejected', error_code: 'work_claim_conflict', door: 'clued-storage',
    resources: [`storage:${connection}/track/topic/example.md`],
    conflicts: [{ claim_id: CLAIM, task_id: '11111111-1111-4111-8111-111111111111', holder_binding_id: 'b-2',
      holder_session_ref: 'session-b', status: 'ACTIVE', fence: 1, expires_at: '2026-10-06T08:00:00+00:00',
      overlap: { same_task: null, paths: [`storage:${connection}/track/**`], trigger_refs: [] } }] };
  const submit = { connection_id: connection, job_id: '10000000-0000-4000-8000-000000000001',
    mutation: { operation: 'create', target_kind: 'file', destination_path: 'track/topic/example.md', content: 'fixture' } };
  const batch = { connection_id: connection, batch_id: '40000000-0000-4000-8000-000000000004',
    items: [{ operation: 'trash', target_kind: 'file', source_path: 'track/topic/example.md', source_file_version: '3', source_file_id: 'drive-a' }] };
  for (const [name, args] of [['clued_storage_submit', submit], ['clued_storage_trash_batch', batch]]) {
    for (const [flags, hinted] of [[{ ...enabled, ...storage }, true], [{ ...claimsOnly, ...storage }, false]]) {
      const { restore } = mockFetch(() => Response.json(rejection));
      try {
        const result = (await (await worker.fetch(mcp(bindingToken, name, args), flags, ctx)).json()).result;
        assert.equal(result.isError, true, name);
        assert.equal(result.structuredContent.error, 'work_claim_conflict', name);
        if (!hinted) {
          assert.equal('coordinate' in result.structuredContent, false, name);
          continue;
        }
        assert.equal(result.structuredContent.coordinate.tool, 'clued_agent_message_send', name);
        assert.deepEqual(result.structuredContent.coordinate.holders, [{
          claim_id: CLAIM, task_id: '11111111-1111-4111-8111-111111111111', holder_binding_id: 'b-2',
          holder_session_ref: 'session-b', expires_at: '2026-10-06T08:00:00+00:00' }], name);
        assert.match(result.structuredContent.coordinate.how_to, /to\.claim_id/, name);
      } finally { restore(); }
    }
  }
});
