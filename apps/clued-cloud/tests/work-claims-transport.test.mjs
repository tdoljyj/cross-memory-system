import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { contractVersionOf } from '../scripts/verify-served-agent-contract.mjs';

const CONTRACT_VERSION = contractVersionOf(await readFile(new URL('../../../skills/clued/references/agent-contract.md', import.meta.url), 'utf8'));

// Work Claim Admission v0.1, step 2: the five work-claim tools and the resume
// fold-in over the Worker transport. The database side is covered by
// currentness-work-claims-db.test.mjs; here every RPC is mocked.

const assets = { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
const enabled = { ...assets, PROJECT_VIEWS_V2: 'true', CLUED_WORK_CLAIMS_V1: 'true' };
const disabled = { ...assets, PROJECT_VIEWS_V2: 'true' };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const bindingToken = `clued_bnd_${'w'.repeat(43)}`;
const oauthToken = 'account-or-legacy-oauth-token';
const WORK_TOOLS = ['clued_work_claim', 'clued_work_renew', 'clued_work_release', 'clued_work_verify', 'clued_work_takeover'];

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

test('work claim tools are advertised only behind CLUED_WORK_CLAIMS_V1, with the right scopes and hints', async () => {
  const worker = await loadContinuityWorker();
  const on = (await (await worker.fetch(list(bindingToken), enabled, ctx)).json()).result.tools;
  const off = (await (await worker.fetch(list(bindingToken), disabled, ctx)).json()).result.tools;
  for (const name of WORK_TOOLS) {
    assert.ok(on.some((tool) => tool.name === name), `${name} advertised when enabled`);
    assert.ok(!off.some((tool) => tool.name === name), `${name} hidden when disabled`);
  }
  assert.equal(off.length + WORK_TOOLS.length, on.length, 'the flag adds exactly the five tools');
  const byName = Object.fromEntries(on.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.clued_work_verify._meta['clued/requiredScopes'], ['context:read']);
  assert.equal(byName.clued_work_verify.annotations.readOnlyHint, true);
  assert.equal(byName.clued_work_verify.annotations.destructiveHint, false);
  for (const name of ['clued_work_claim', 'clued_work_renew', 'clued_work_release', 'clued_work_takeover']) {
    assert.deepEqual(byName[name]._meta['clued/requiredScopes'], ['context:write'], name);
    assert.equal(byName[name].annotations.readOnlyHint, false, name);
    assert.match(byName[name].description, /Required Clued scope: context:write\.$/);
  }
  assert.equal(byName.clued_work_takeover.annotations.destructiveHint, true, 'takeover supersedes another claim');
  assert.equal(byName.clued_work_claim.annotations.idempotentHint, true);
  assert.equal(byName.clued_work_renew.annotations.idempotentHint, false);
  assert.deepEqual(byName.clued_work_claim.inputSchema.required, ['task_id', 'write_set', 'idempotency_key']);
  assert.deepEqual(byName.clued_work_renew.inputSchema.required, ['claim_id', 'fence', 'lease_version', 'progress_ref']);
  assert.deepEqual(byName.clued_work_release.inputSchema.required, ['claim_id', 'fence', 'outcome']);
  assert.deepEqual(byName.clued_work_verify.inputSchema.required, ['claim_id']);
  assert.deepEqual(byName.clued_work_takeover.inputSchema.required, ['claim_id', 'idempotency_key']);
  assert.deepEqual(byName.clued_work_release.inputSchema.properties.outcome.enum, ['completed', 'abandoned', 'draining']);
  for (const name of WORK_TOOLS) assert.equal(byName[name].inputSchema.additionalProperties, false, name);
  assert.equal(byName.clued_work_claim._meta['clued/scopeEnforcement'], 'server-side');
});

test('a disabled flag refuses the call before any database request', async () => {
  const worker = await loadContinuityWorker();
  const { calls, restore } = mockFetch(() => Response.json({ status: 'committed' }));
  try {
    const response = await worker.fetch(mcp(bindingToken, 'clued_work_claim', {
      task_id: '11111111-1111-4111-8111-111111111111', write_set: ['a/b'], idempotency_key: 'disabled-flag-test',
    }), disabled, ctx);
    const body = await response.json();
    assert.ok(body.error, JSON.stringify(body));
    assert.match(body.error.message, /work claims are disabled/);
    assert.equal(calls.length, 0, 'no RPC reached the database');
  } finally { restore(); }
});

test('Binding and OAuth callers reach the same step-1 RPCs with the arguments passed through', async () => {
  const worker = await loadContinuityWorker();
  const expectedRpc = {
    clued_work_claim: 'clued_work_claim_v1', clued_work_renew: 'clued_work_renew_v1',
    clued_work_release: 'clued_work_release_v1', clued_work_verify: 'clued_work_verify_v1',
    clued_work_takeover: 'clued_work_takeover_v1',
  };
  const args = {
    clued_work_claim: { scope: 'global', task_id: '11111111-1111-4111-8111-111111111111',
      write_set: ['apps/clued-cloud/package.json', 'apps/clued-cloud/package-lock.json'],
      trigger_refs: ['ghsa:GHSA-vcvr-r3jv-pc5j'], idempotency_key: 'host-a:task:claim', base_commit: 'f7ba6ff3' },
    clued_work_renew: { claim_id: '22222222-2222-4222-8222-222222222222', fence: 1, lease_version: 1, progress_ref: 'sha-1' },
    clued_work_release: { claim_id: '22222222-2222-4222-8222-222222222222', fence: 1, outcome: 'completed', evidence_ref: 'pr:450' },
    clued_work_verify: { claim_id: '22222222-2222-4222-8222-222222222222', changed_paths: ['apps/clued-cloud/package.json'], head_sha: '3329174e' },
    clued_work_takeover: { claim_id: '22222222-2222-4222-8222-222222222222', idempotency_key: 'host-b:claim:takeover' },
  };
  const { calls, restore } = mockFetch(({ rpc, body }) =>
    Response.json({ status: 'committed', echo: rpc ?? body.p_tool, claim: { claim_id: '22222222-2222-4222-8222-222222222222', holder_binding_id: 'b-1' } }));
  try {
    for (const name of WORK_TOOLS) {
      for (const token of [bindingToken, oauthToken]) {
        const response = await worker.fetch(mcp(token, name, args[name]), enabled, ctx);
        assert.equal(response.status, 200, await response.clone().text());
        const result = (await response.json()).result;
        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.status, 'committed');
        // holder_binding_id is a different key from binding_id and survives sanitization.
        assert.equal(result.structuredContent.claim.holder_binding_id, 'b-1');
        const call = calls.at(-1);
        if (token === bindingToken) {
          assert.equal(call.rpc, expectedRpc[name]);
          assert.match(call.body.p_token_hash, /^[0-9a-f]{64}$/);
          assert.equal(call.body.p_tool, undefined);
        } else {
          assert.equal(call.rpc, 'clued_oauth_call');
          assert.equal(call.body.p_tool, name);
        }
        assert.deepEqual(call.body.p_input, args[name]);
      }
    }
    assert.equal(calls.length, WORK_TOOLS.length * 2);
  } finally { restore(); }
});

test('a conflict or budget rejection is a structured result, not a transport error', async () => {
  const worker = await loadContinuityWorker();
  const rejection = { status: 'rejected', error_code: 'work_claim_conflict', conflicts: [{
    claim_id: '33333333-3333-4333-8333-333333333333', task_id: '11111111-1111-4111-8111-111111111111',
    holder_binding_id: 'b-2', holder_session_ref: 'session-b', status: 'ACTIVE', fence: 1,
    expires_at: '2026-10-01T08:00:00+00:00',
    overlap: { same_task: false, paths: ['apps/clued-cloud/package-lock.json'], trigger_refs: ['ghsa:GHSA-vcvr-r3jv-pc5j'] },
  }] };
  const { restore } = mockFetch(() => Response.json(rejection));
  try {
    const response = await worker.fetch(mcp(bindingToken, 'clued_work_claim', {
      task_id: '44444444-4444-4444-8444-444444444444', write_set: ['apps/clued-cloud/**'], idempotency_key: 'host-c:task:claim',
    }), enabled, ctx);
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.equal(result.isError, false, 'the Agent reads the conflict and stops; it is not a tool failure');
    assert.deepEqual(result.structuredContent, rejection);
    assert.equal(response.headers.get('www-authenticate'), null);
  } finally { restore(); }
});

test('resume folds in contract_version and the live claims; a failed claims read is reported, not thrown', async () => {
  const worker = await loadContinuityWorker();
  const resume = { status: 'restored', session_token: 'session-test', version: 7, active_constraints: [],
    currentness_evaluation: { overall: 'CURRENT', authoritative: true } };
  const claims = { status: 'ok', observed_at: '2026-10-01T06:00:00+00:00', scope: 'global',
    active_work_claims: [{ claim_id: '22222222-2222-4222-8222-222222222222', task_id: '11111111-1111-4111-8111-111111111111',
      holder_binding_id: 'b-1', write_set: ['apps/clued-cloud/package-lock.json', 'apps/clued-cloud/package.json'],
      trigger_refs: ['ghsa:GHSA-vcvr-r3jv-pc5j'], fence: 1, status: 'ACTIVE', expires_at: '2026-10-01T08:00:00+00:00' }],
    work_claim_profile: { profile_id: 'work-claim-v1-default', lease_seconds: 7200 } };
  const expected = {
    ...resume,
    authority_capture_completeness: { state: 'unknown', basis: 'server_observes_only_writes_that_reached_clued', independent_of: 'currentness' },
    contract_version: CONTRACT_VERSION,
    active_work_claims: claims.active_work_claims,
    active_work_claim_count: 1,
    work_claim_profile: claims.work_claim_profile,
  };
  const handler = ({ rpc, body }) => Response.json(
    rpc === 'clued_work_claims_active_v1' || body.p_tool === 'clued_work_claims_active' ? claims : resume);

  // MCP and REST, Binding and OAuth: the same two RPCs, the same folded result.
  for (const token of [bindingToken, oauthToken]) {
    const { calls, restore } = mockFetch(handler);
    try {
      const viaMcp = await worker.fetch(mcp(token, 'clued_session_resume', { context_key: 'global' }), enabled, ctx);
      assert.equal(viaMcp.status, 200, await viaMcp.clone().text());
      assert.deepEqual((await viaMcp.json()).result.structuredContent, expected);
      const viaRest = await worker.fetch(new Request('https://clued.test/v1/continuity/resume', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ context_key: 'global' }) }), enabled, ctx);
      assert.equal(viaRest.status, 200);
      assert.deepEqual(await viaRest.json(), expected);
      assert.equal(calls.length, 4);
      if (token === bindingToken) {
        assert.deepEqual(calls.map((c) => c.rpc), ['clued_mcp_restore', 'clued_work_claims_active_v1', 'clued_mcp_restore', 'clued_work_claims_active_v1']);
        assert.deepEqual(calls[1].body.p_input, { scope: 'global' });
        assert.equal(calls[1].body.p_token_hash, calls[0].body.p_token_hash);
      } else {
        assert.deepEqual(calls.map((c) => c.tool), ['clued_session_resume', 'clued_work_claims_active', 'clued_session_resume', 'clued_work_claims_active']);
        assert.deepEqual(calls[1].body.p_input, { scope: 'global' });
      }
    } finally { restore(); }
  }

  // A project context asks for claims readable in that project scope.
  {
    const { calls, restore } = mockFetch(handler);
    try {
      await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'project:55555555-5555-4555-8555-555555555555' }), enabled, ctx);
      assert.deepEqual(calls[1].body.p_input, { scope: 'project:55555555-5555-4555-8555-555555555555' });
    } finally { restore(); }
  }

  // Flag off: resume is untouched and only the restore RPC runs.
  {
    const { calls, restore } = mockFetch(handler);
    try {
      const response = await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), disabled, ctx);
      const result = (await response.json()).result.structuredContent;
      assert.equal('contract_version' in result, false);
      assert.equal('active_work_claims' in result, false);
      assert.equal(calls.length, 1);
    } finally { restore(); }
  }

  // Claims read fails (for example the migration is not applied yet): the
  // resume still succeeds and says the claims are unavailable.
  {
    const { restore } = mockFetch(({ rpc }) => rpc === 'clued_work_claims_active_v1'
      ? new Response(JSON.stringify({ code: '42883', message: 'function does not exist' }), { status: 404, headers: { 'content-type': 'application/json' } })
      : Response.json(resume));
    try {
      const response = await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), enabled, ctx);
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.contract_version, CONTRACT_VERSION);
      assert.equal(result.structuredContent.active_work_claims, null);
      assert.equal(result.structuredContent.active_work_claims_unavailable, true);
      assert.equal(result.structuredContent.session_token, 'session-test');
    } finally { restore(); }
  }

  // A resume that itself failed is passed through unchanged.
  {
    const { calls, restore } = mockFetch(() => Response.json({ error: 'resume_failed' }));
    try {
      const response = await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), enabled, ctx);
      const result = (await response.json()).result;
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { error: 'resume_failed' });
      assert.equal(calls.length, 1, 'no claims read after a failed resume');
    } finally { restore(); }
  }
});

test('reconcile and other tools are not touched by the fold-in', async () => {
  const worker = await loadContinuityWorker();
  const reconcile = { status: 'current', currentness_state: 'CURRENT' };
  const { calls, restore } = mockFetch(() => Response.json(reconcile));
  try {
    const response = await worker.fetch(mcp(bindingToken, 'clued_session_reconcile', { session_token: 'session-test' }), enabled, ctx);
    const result = (await response.json()).result.structuredContent;
    assert.equal('contract_version' in result, false);
    assert.equal('active_work_claims' in result, false);
    assert.equal(calls.length, 1);
  } finally { restore(); }
});
