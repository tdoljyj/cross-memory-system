import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { contractVersionOf } from '../scripts/verify-served-agent-contract.mjs';

// Task 6dfd7560: every resume reports the component versions the build was made from.
const CLUED_COMPONENTS = {
  schema: 'clued.components/1',
  versions: Object.fromEntries(JSON.parse(readFileSync(new URL('../../../config/clued-components.json', import.meta.url), 'utf8'))
    .components.map((c) => [c.id, String(c.version)])),
  source_commit: null,
};
const CONTRACT_SOURCE = (await readFile(new URL('../../../protocol/agent/agent-contract.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const CONTRACT_VERSION = contractVersionOf(CONTRACT_SOURCE);
const CONTRACT_SHA256 = createHash('sha256').update(CONTRACT_SOURCE).digest('hex');

// Work Claim Admission v0.1, step 2: the five work-claim tools and the resume
// fold-in over the Worker transport. The database side is covered by
// currentness-work-claims-db.test.mjs; here every RPC is mocked.

const assets = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
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
  assert.equal(byName.clued_work_verify.annotations.readOnlyHint, false, 'pr_ref binds the claim');
  assert.equal(byName.clued_work_verify.annotations.idempotentHint, true);
  assert.equal(byName.clued_work_verify.inputSchema.properties.pr_ref.pattern, '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}#[0-9]{1,10}$');
  assert.equal(byName.clued_work_verify.annotations.destructiveHint, false);
  for (const name of ['clued_work_claim', 'clued_work_renew', 'clued_work_release', 'clued_work_takeover']) {
    assert.deepEqual(byName[name]._meta['clued/requiredScopes'], ['context:write'], name);
    assert.equal(byName[name].annotations.readOnlyHint, false, name);
    assert.match(byName[name].description, /Required Clued scope: context:write\.$/);
  }
  assert.equal(byName.clued_work_takeover.annotations.destructiveHint, true, 'takeover supersedes another claim');
  assert.equal(byName.clued_work_claim.annotations.idempotentHint, true);
  assert.equal(byName.clued_work_renew.annotations.idempotentHint, false);
  assert.deepEqual(byName.clued_work_claim.inputSchema.required, ['task_id', 'write_set', 'idempotency_key', 'holder_label']);
  assert.deepEqual(byName.clued_work_renew.inputSchema.oneOf[0],
    {not:{required:['action']},required:['claim_id','fence','lease_version','progress_ref']});
  const commands=Object.fromEntries(byName.clued_work_renew.inputSchema.oneOf.slice(1).map(branch=>[branch.properties.action.const,branch.required]));
  assert.deepEqual(commands.prepare_handover,['action','claim_id','fence','holder_label','idempotency_key']);
  assert.deepEqual(commands.offer_handover,['action','request_id','lease_key']);
  assert.deepEqual(commands.accept_handover,['action','request_id','receiver_key']);
  assert.deepEqual(byName.clued_work_release.inputSchema.required, ['claim_id', 'fence', 'outcome']);
  assert.deepEqual(byName.clued_work_verify.inputSchema.required, ['claim_id']);
  assert.deepEqual(byName.clued_work_takeover.inputSchema.required, ['claim_id', 'idempotency_key', 'holder_label']);
  assert.deepEqual(byName.clued_work_release.inputSchema.properties.outcome.enum, ['completed', 'abandoned', 'draining']);
  for (const name of WORK_TOOLS) assert.equal(byName[name].inputSchema.additionalProperties, false, name);
  // The private lease key (migration 20261005190000) is an optional input of renew and release only.
  for (const name of ['clued_work_renew', 'clued_work_release']) {
    assert.equal(byName[name].inputSchema.properties.lease_key.pattern, '^clued_lk_[0-9a-f]{64}$', name);
    const required=name==='clued_work_renew'?byName[name].inputSchema.oneOf[0].required:byName[name].inputSchema.required;
    assert.ok(!required.includes('lease_key'), name);
  }
  for (const name of ['clued_work_claim', 'clued_work_verify', 'clued_work_takeover']) {
    assert.equal(byName[name].inputSchema.properties.lease_key, undefined, name);
  }
  assert.ok(byName.clued_work_renew.inputSchema.properties.holder_session_ref);
  // The self-reported holder label (migration 20261005200000) on claim, takeover and renew.
  for (const name of ['clued_work_claim', 'clued_work_takeover', 'clued_work_renew']) {
    const props = byName[name].inputSchema.properties;
    assert.deepEqual([props.holder_label.maxLength, props.holder_client.maxLength, props.holder_session_title.maxLength],
      [200, 80, 200], name);
  }
  assert.match(byName.clued_work_renew.description, /work_claim_lease_key_required/);
  assert.match(byName.clued_work_claim.description, /lease_key is the claim's private key: keep it in this session only/);
  assert.match(byName.clued_work_claim.description, /A continuation takes none/);
  assert.match(byName.clued_work_release.inputSchema.properties.evidence_ref.description, /continue without a token/);
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
      trigger_refs: ['ghsa:GHSA-vcvr-r3jv-pc5j'], idempotency_key: 'host-a:task:claim', base_commit: 'f7ba6ff3',
      holder_label: 'npm audit fix · Claude Code · laptop' },
    clued_work_renew: { claim_id: '22222222-2222-4222-8222-222222222222', fence: 1, lease_version: 1, progress_ref: 'sha-1',
      lease_key: `clued_lk_${'a'.repeat(64)}`, holder_session_ref: 'session-new' },
    clued_work_release: { claim_id: '22222222-2222-4222-8222-222222222222', fence: 1, outcome: 'completed', evidence_ref: 'pr:450',
      lease_key: `clued_lk_${'a'.repeat(64)}` },
    clued_work_verify: { claim_id: '22222222-2222-4222-8222-222222222222', changed_paths: ['apps/clued-cloud/package.json'], head_sha: '3329174e', pr_ref: 'tdoljyj/cross-memory-system#482' },
    clued_work_takeover: { claim_id: '22222222-2222-4222-8222-222222222222', idempotency_key: 'host-b:claim:takeover',
      holder_label: 'takeover · Codex · desktop', holder_client: 'Codex' },
  };
  const { calls, restore } = mockFetch(({ rpc, body }) =>
    Response.json({ status: 'committed', echo: rpc ?? body.p_tool, lease_key: `clued_lk_${'b'.repeat(64)}`,
      claim: { claim_id: '22222222-2222-4222-8222-222222222222', holder_binding_id: 'b-1' } }));
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
        // The lease key reaches the caller that took the claim.
        assert.equal(result.structuredContent.lease_key, `clued_lk_${'b'.repeat(64)}`);
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

test('page-free handover commands preserve private receiving proofs only in the authenticated tool response',async()=>{
  const worker=await loadContinuityWorker();
  const receiveKey=`clued_lk_${'c'.repeat(64)}`,leaseKey=`clued_lk_${'d'.repeat(64)}`;
  const requestId='77777777-7777-4777-8777-777777777777';
  const inputs=[
    {action:'prepare_handover',scope:'global',claim_id:'22222222-2222-4222-8222-222222222222',fence:2,
      holder_label:'private receiver',holder_session_ref:'receiver',idempotency_key:'receiving:exact-operation'},
    {action:'offer_handover',scope:'global',request_id:requestId,lease_key:leaseKey},
    {action:'accept_handover',scope:'global',request_id:requestId,receiver_key:receiveKey},
  ];
  const {calls,restore}=mockFetch(({body})=>Response.json(body.p_input.action==='prepare_handover'
    ?{status:'committed',request_id:requestId,receiver_key:receiveKey}
    :body.p_input.action==='offer_handover'?{status:'committed',request_id:requestId,state:'offered'}
      :{status:'pending',delivery_id:requestId,execution_epoch:3}));
  try{
    for(const input of inputs){
      const response=await worker.fetch(mcp(bindingToken,'clued_work_renew',input),enabled,ctx);
      const result=(await response.json()).result;
      assert.equal(result.isError,false);assert.deepEqual(calls.at(-1).body.p_input,input);
      assert.equal(calls.at(-1).rpc,'clued_work_renew_v1');
      assert.notEqual(calls.at(-1).body.p_token_hash,bindingToken);
      if(input.action==='prepare_handover')assert.equal(result.structuredContent.receiver_key,receiveKey);
      if(input.action==='accept_handover'){
        assert.equal(result.structuredContent.status,'pending');assert.equal('lease_key' in result.structuredContent,false);
      }
    }
  }finally{restore();}
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

test('a refusal over the per-Task cap carries the Owner Request with an absolute confirm_url', async () => {
  const worker = await loadContinuityWorker();
  const requestId = '55555555-5555-4555-8555-555555555555';
  const rejection = { status: 'rejected', error_code: 'work_claim_budget_exhausted', limit: 'max_claims_per_task_24h',
    max_claims_per_task_24h: 10, claims_last_24h: 10, task_id: '11111111-1111-4111-8111-111111111111',
    retry_after: '2026-10-04T00:00:00+00:00',
    owner_request: { request_id: requestId, action: 'work_claim.extra_claims', status: 'pending',
      resources: ['record:11111111-1111-4111-8111-111111111111'], confirm_path: `/confirm/${requestId}` } };
  const { restore } = mockFetch(() => Response.json(rejection));
  try {
    for (const token of [bindingToken, oauthToken]) {
      const response = await worker.fetch(mcp(token, 'clued_work_claim', {
        task_id: '11111111-1111-4111-8111-111111111111', write_set: ['a/b'], idempotency_key: 'over-the-cap',
      }), enabled, ctx);
      const result = (await response.json()).result;
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.owner_request.confirm_url, `https://clued.test/confirm/${requestId}`);
      assert.equal(result.structuredContent.owner_request.confirm_path, `/confirm/${requestId}`);
    }
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
    clued_components: CLUED_COMPONENTS,
    authority_capture_completeness: { state: 'unknown', basis: 'server_observes_only_writes_that_reached_clued', independent_of: 'currentness' },
    contract_version: CONTRACT_VERSION,
    agent_contract_sha256: CONTRACT_SHA256,
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

  // Flag off: contract identity remains present and only the restore RPC runs.
  {
    const { calls, restore } = mockFetch(handler);
    try {
      const response = await worker.fetch(mcp(bindingToken, 'clued_session_resume', { context_key: 'global' }), disabled, ctx);
      const result = (await response.json()).result.structuredContent;
      assert.equal(result.contract_version, CONTRACT_VERSION);
      assert.equal(result.agent_contract_sha256, CONTRACT_SHA256);
      assert.equal('active_work_claims' in result, false);
      assert.deepEqual(result.clued_components, CLUED_COMPONENTS, 'component versions do not depend on the work-claims flag');
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
