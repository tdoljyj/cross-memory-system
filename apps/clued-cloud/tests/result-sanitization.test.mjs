import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
import { sanitizeCluedResult } from '../worker/result-sanitization.ts';

// Task 0c0367c7: exercise the real transport boundary, rather than a copy of
// its private sanitizer. IDs below are synthetic, distinct fixture identities.
const USER = '90000000-0000-4000-8000-000000000001';
const BINDING = '90000000-0000-4000-8000-000000000002';
const RECORD = '10000000-0000-4000-8000-000000000001';
const RECEIPT = '10000000-0000-4000-8000-000000000002';
const CHECKPOINT = '10000000-0000-4000-8000-000000000003';
const CLAIM = '10000000-0000-4000-8000-000000000004';
const TASK = '10000000-0000-4000-8000-000000000005';
const SESSION = '10000000-0000-4000-8000-000000000006';
const MESSAGE = '10000000-0000-4000-8000-000000000007';
const FROM = '20000000-0000-4000-8000-000000000001';
const TO = '20000000-0000-4000-8000-000000000002';
const timestamp = '2026-10-11T00:00:00.000Z';
const bindingToken = `clued_bnd_${'s'.repeat(43)}`;
const env = {
  CLUED_DB_GATEWAY_TOKEN: 'test-worker-gateway',
  PROJECT_VIEWS_V2: 'true',
  SUPABASE_URL: 'https://db.example.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key',
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

function userContent(label) {
  return {
    user_id: `${label}: customer identifier`,
    actor_user_id: `${label}: author identifier`,
    binding_id: `${label}: business binding`,
    actor_binding_id: `${label}: business actor`,
    nested: { user_id: `${label}: nested customer`, actor_binding_id: `${label}: nested actor` },
    items: [{ binding_id: `${label}: array binding`, actor_user_id: `${label}: array author` }, null, false],
    // Known envelope names inside user content do not turn it into a service row.
    records: [{ user_id: `${label}: user-owned record` }],
    snapshot: { binding_id: `${label}: user-owned snapshot` },
  };
}

function request(spec, transport) {
  if (transport === 'MCP') {
    return new Request('https://clued.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${bindingToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: spec.tool, arguments: spec.args } }),
    });
  }
  return new Request(`https://clued.test${spec.path}`, {
    method: spec.method ?? 'POST',
    headers: { authorization: `Bearer ${spec.native ? 'account-jwt' : bindingToken}`, 'content-type': 'application/json' },
    ...(spec.method === 'GET' ? {} : { body: JSON.stringify(spec.args) }),
  });
}

async function resultFor(spec, transport, fixture, emptyBody = false) {
  const worker = await loadContinuityWorker();
  const previous = globalThis.fetch;
  const calls = [];
  const native = transport === 'REST' && spec.native;
  const rpc = native ? spec.nativeRpc : spec.rpc;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (native && url === `${env.SUPABASE_URL}/auth/v1/user`) {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer account-jwt');
      return Response.json({ id: USER });
    }
    // Exact per-tool routes catch a fixture accidentally reaching another RPC.
    assert.equal(url, `${env.SUPABASE_URL}/rest/v1/rpc/${rpc}`, `${transport}: ${spec.tool}`);
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.p_input, spec.args);
    if (!native) assert.match(body.p_token_hash, /^[0-9a-f]{64}$/);
    return emptyBody ? new Response(null, { status: 204 }) : Response.json(fixture);
  };
  try {
    const response = await worker.fetch(request(spec, transport), { ...env, ...spec.flags }, ctx);
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.deepEqual(calls, [
      ...(native ? [`${env.SUPABASE_URL}/auth/v1/user`] : []),
      `${env.SUPABASE_URL}/rest/v1/rpc/${rpc}`,
    ]);
    const body = JSON.parse(text);
    if (transport === 'REST') return { data: body, text };
    assert.equal(body.result.isError, false);
    assert.deepEqual(JSON.parse(body.result.content[0].text), body.result.structuredContent,
      'MCP text and structured content carry the same result');
    return { data: body.result.structuredContent, text };
  } finally {
    globalThis.fetch = previous;
  }
}

const recordList = {
  tool: 'clued_record_list', rpc: 'clued_record_list', nativeRpc: 'clued_user_record_list', native: true,
  method: 'GET', path: '/v1/records?level=global&record_type=state&limit=10',
  args: { level: 'global', record_type: 'state', limit: 10 },
};
const audit = {
  tool: 'clued_audit_receipts', rpc: 'clued_mcp_audit_receipts', path: '/v1/continuity/audit',
  args: { context_key: 'global', limit: 10 },
};
const search = {
  tool: 'clued_search_context', rpc: 'clued_mcp_search_context', path: '/v1/continuity/search',
  args: { context_key: 'global', session_token: 'fixture-session', query: 'fixture' },
};
const canonicalExport = {
  tool: 'clued_canonical_export', rpc: 'clued_canonical_export_v2', nativeRpc: 'clued_user_canonical_export_v2',
  native: true, path: '/v1/export', args: { idempotency_key: 'sanitization-export-fixture' },
};
const log = {
  tool: 'clued_read_log', rpc: 'clued_mcp_read_log', path: '/v1/continuity/log', args: { context_key: 'global' },
};

for (const transport of ['REST', 'MCP']) {
  test(`${transport}: record-list hides the authenticated user ID and preserves the record ID`, async () => {
    // clued_records_v2 contains user_id, but does not expose type_fields.
    const record = { id: RECORD, user_id: USER, record_type: 'state', title: 'Fixture state', body: 'Fixture content',
      scope: 'global', project_id: null, effective_project_id: null, status: 'current', priority: 0,
      version: 7, updated_at: timestamp, projection_currentness: 'CURRENT', authoritative: true };
    const fixture = { status: 'ok', level: 'global', record_type: 'state', project_id: null, records: [record] };
    const { data, text } = await resultFor(recordList, transport, fixture);
    const { user_id: _user, ...publicRecord } = record;
    assert.deepEqual(data.records, [publicRecord]);
    assert.equal(data.records[0].id, RECORD);
    assert.equal(text.includes(USER), false, 'the full returned response contains no authenticated user ID');
  });

  test(`${transport}: audit receipts hide the authenticated binding ID and preserve receipt identity`, async () => {
    const receipt = { id: RECEIPT, operation: 'restore', object_type: 'session', object_id: SESSION,
      version: 7, binding_id: BINDING, metadata: { client_session_id: 'fixture-client' }, created_at: timestamp };
    const fixture = { status: 'ok', context_key: 'global', receipts: [receipt], session_compliance: [], checkpoint_reminder: false };
    const { data, text } = await resultFor(audit, transport, fixture);
    const { binding_id: _binding, ...publicReceipt } = receipt;
    assert.deepEqual(data.receipts, [publicReceipt]);
    assert.equal(data.receipts[0].id, RECEIPT);
    assert.equal(data.receipts[0].object_id, SESSION);
    assert.equal(text.includes(BINDING), false, 'the full returned response contains no authenticated binding ID');
  });

  test(`${transport}: search preserves user type_fields, event payload and checkpoint snapshot`, async () => {
    // The latest search SQL creates these three tagged result shapes. It does
    // not put authentication IDs on the root search envelope.
    const rows = [
      { kind: 'record', id: RECORD, version: 7, record_type: 'note', scope: 'global', title: 'Fixture note',
        content: 'Fixture content', status: 'current', lifecycle_status: 'active',
        type_fields: { note_kind: 'log', ...userContent('record') },
        updated_at: timestamp, record_currentness: 'CURRENT', projection_currentness: 'CURRENT', authoritative: true, match_score: 1 },
      { kind: 'checkpoint', id: CHECKPOINT, version: 7, summary: 'Fixture checkpoint', next_action: 'Fixture next action',
        snapshot: userContent('checkpoint'), coverage: { mode: 'explicit', contexts: ['global'], tracks: [], event_ids: [] },
        source_semantics: 'continuity_history', authoritative: false, created_at: timestamp },
      { kind: 'event', id: 17, version: 7, type: 'note', payload: userContent('event'), carrier_state: 'ACTIVE_UNSTRUCTURED',
        source_semantics: 'canonical_material_event', structured_action_usable: false, occurred_at: timestamp, target_refs: [] },
    ];
    const fixture = { status: 'ok', mode: 'lexical_terms', scope: 'context', scopes_searched: ['global'], absence_claim: false,
      record_candidates_capped: false, empty_result_hint: null, context_key: 'global', query: 'fixture', results: rows,
      page: { cursor: 0, next_cursor: null, limit: 10, max_bytes: 65536, returned: 3, truncated: false,
        oversize_first_item: false, cursor_limit_reached: false } };
    const { data } = await resultFor(search, transport, fixture);
    assert.deepEqual({ type_fields: data.results[0].type_fields, snapshot: data.results[1].snapshot, payload: data.results[2].payload },
      { type_fields: rows[0].type_fields, snapshot: rows[1].snapshot, payload: rows[2].payload },
      'all three user content branches are opaque, including nested objects and arrays');
    assert.deepEqual(data, fixture, 'all result fields, stable IDs and paging metadata survive');
  });

  test(`${transport}: canonical export hides service actor identity inside its service snapshot`, async () => {
    // canonical_export_core_v2's snapshot is a service envelope, unlike the
    // checkpoint snapshot above. SQL already removes actor_user_id, but leaves
    // actor_binding_id in the exported clued_events_m1 row.
    const event = { event_id: '17', event_schema_version: 1, event_type: 'record_created',
      actor_binding_id: BINDING, actor_kind: 'agent_binding', receipt_id: RECEIPT, occurred_at: timestamp };
    const fixture = { replayed: false, receipt: { status: 'committed', receipt_id: RECEIPT }, snapshot: {
      schema_version: 2, project_contract_version: 2, canonical_version: 'cv_7', source_verification: 'live_rechecked',
      views_complete: true, owner_ref: 'owner_000000000000000000000000', export_receipt_id: RECEIPT,
      projects: [], records: [], events: [event], evidence: [], referenced_receipts: [RECEIPT],
      legacy_projects: [], legacy_records: [], legacy_events: [], legacy_evidence: [], excluded_evidence_counts: { unlinked: 0 },
    } };
    const { data, text } = await resultFor(canonicalExport, transport, fixture);
    const { actor_binding_id: _binding, ...publicEvent } = event;
    assert.deepEqual(data.snapshot.events, [publicEvent]);
    assert.equal(data.snapshot.events[0].event_id, '17');
    assert.equal(data.snapshot.events[0].receipt_id, RECEIPT);
    assert.equal(data.snapshot.export_receipt_id, RECEIPT);
    assert.equal(text.includes(BINDING), false, 'a service snapshot does not bypass identity filtering');
  });

  test(`${transport}: canonical export preserves user fields within its service snapshot`, async () => {
    const record = { id: RECORD, record_schema_version: 1, record_type: 'note', scope: 'global', lifecycle_status: 'active',
      title: 'Fixture note', content: 'Fixture content', type_fields: { note_kind: 'log', ...userContent('export record') },
      relations: userContent('export relations'),
      version: 7, receipt_id: RECEIPT };
    const legacyEvent = { kind: 'legacy_event', legacy_id: '17', legacy_schema_version: null,
      inline_payload: { event_type: 'note', context_key: 'global', payload: userContent('legacy event') },
      migration_status: 'preserved_audit_only' };
    const fixture = { replayed: false, receipt: { status: 'committed', receipt_id: RECEIPT }, snapshot: {
      schema_version: 2, project_contract_version: 2, canonical_version: 'cv_7', source_verification: 'live_rechecked',
      views_complete: true, export_receipt_id: RECEIPT, projects: [], records: [record], events: [], evidence: [],
      referenced_receipts: [RECEIPT], legacy_projects: [], legacy_records: [], legacy_events: [legacyEvent],
      legacy_evidence: [], excluded_evidence_counts: { unlinked: 0 },
    } };
    const { data } = await resultFor(canonicalExport, transport, fixture);
    assert.deepEqual({ type_fields: data.snapshot.records[0].type_fields, relations: data.snapshot.records[0].relations,
      payload: data.snapshot.legacy_events[0].inline_payload.payload },
      { type_fields: record.type_fields, relations: record.relations, payload: legacyEvent.inline_payload.payload },
      'canonical export still preserves user record fields, relations and legacy event payload');
    assert.equal(data.snapshot.records[0].id, RECORD);
    assert.deepEqual(data, fixture);
  });

  test(`${transport}: unknown non-object JSON and empty values pass through without throwing`, async () => {
    // Deliberately malformed upstream result types test robustness, rather
    // than claiming that the read-log RPC normally emits these values.
    for (const fixture of [null, false, 0, '', 'unexpected upstream text', [], {}]) {
      const { data } = await resultFor(log, transport, fixture);
      assert.deepEqual(data, fixture);
    }
    const { data } = await resultFor(log, transport, null, true);
    assert.equal(data, null, 'supabaseRequest interprets an empty successful body as null');
  });
}

test('MCP: public from_binding_id and to_binding_id remain usable for Agent coordination', async () => {
  const message = { message_id: MESSAGE, thread_id: MESSAGE, kind: 'request', from_binding_id: FROM, from_session_ref: 'from-session',
    to_claim_id: CLAIM, to_binding_id: TO, subject: 'Fixture coordination', body: 'Fixture message', source: 'agent_message' };
  const fixture = { status: 'committed', replayed: false, receipt_id: RECEIPT, message };
  const spec = { tool: 'clued_agent_message_send', rpc: 'clued_agent_message_send_v1',
    flags: { CLUED_WORK_CLAIMS_V1: 'true', CLUED_AGENT_MESSAGES_V1: 'true' },
    args: { to: { claim_id: CLAIM }, subject: 'Fixture coordination', body: 'Fixture message', idempotency_key: 'sanitization-message-fixture' } };
  const { data } = await resultFor(spec, 'MCP', fixture);
  assert.deepEqual(data.message, message);
  assert.equal(data.message.from_binding_id, FROM);
  assert.equal(data.message.to_binding_id, TO);
});

test('MCP: public holder_binding_id remains usable when a work claim conflicts', async () => {
  const fixture = { status: 'rejected', error_code: 'work_claim_conflict', conflicts: [{ claim_id: CLAIM, task_id: TASK,
    holder_binding_id: TO, holder_session_ref: 'holder-session', status: 'ACTIVE', fence: 1,
    expires_at: '2026-10-11T01:00:00.000Z', overlap: { same_task: false, paths: ['apps/example/**'], trigger_refs: [] } }] };
  const spec = { tool: 'clued_work_claim', rpc: 'clued_work_claim_v1', flags: { CLUED_WORK_CLAIMS_V1: 'true' },
    args: { task_id: TASK, write_set: ['apps/example/**'], idempotency_key: 'sanitization-claim-fixture',
      holder_label: 'Fixture coordination check' } };
  const { data } = await resultFor(spec, 'MCP', fixture);
  assert.deepEqual(data, fixture);
  assert.equal(data.conflicts[0].holder_binding_id, TO);
});

test('MCP: a committed work claim returns the user-declared budget unchanged with its service profile', async () => {
  const declaredBudget = { estimated_model_tokens: 1000, ...userContent('declared budget') };
  const storedBudget = { ...declaredBudget, profile_id: 'fixture-profile' };
  const claim = { claim_id: CLAIM, task_id: TASK, context_key: 'global', holder_binding_id: FROM,
    holder_session_ref: 'fixture-session', fence: 1, lease_version: 1, status: 'ACTIVE', budget: storedBudget };
  const fixture = { status: 'committed', replayed: false, receipt_id: RECEIPT, claim };
  const spec = { tool: 'clued_work_claim', rpc: 'clued_work_claim_v1', flags: { CLUED_WORK_CLAIMS_V1: 'true' },
    args: { task_id: TASK, write_set: ['apps/example/**'], idempotency_key: 'sanitization-budget-fixture',
      holder_label: 'Fixture budget roundtrip', budget: declaredBudget } };
  const { data } = await resultFor(spec, 'MCP', fixture);
  assert.deepEqual(data.claim.budget, storedBudget, 'the open caller declaration survives, including nested fields');
  assert.equal(data.claim.claim_id, CLAIM);
  assert.equal(data.claim.holder_binding_id, FROM);
});

test('module: Canonical relations remain opaque inside a service export snapshot', () => {
  const relations = Object.freeze(userContent('record relations'));
  const input = { snapshot: { records: [{ id: RECORD, relations }], events: [{ event_id: '17', actor_binding_id: BINDING }] } };
  const output = sanitizeCluedResult(input, 'clued_canonical_export');
  assert.deepEqual(output.snapshot.records[0], { id: RECORD, relations });
  assert.equal(output.snapshot.records[0].relations, relations);
  assert.deepEqual(output.snapshot.events, [{ event_id: '17' }]);
  assert.equal(input.snapshot.events[0].actor_binding_id, BINDING, 'the input service row remains unchanged');
});

test('module: budget is opaque at each known work-claim result location', () => {
  const budget = Object.freeze({ estimated_model_tokens: 1000, ...userContent('claim budget'), profile_id: 'fixture-profile' });
  const claim = Object.freeze({ claim_id: CLAIM, task_id: TASK, holder_binding_id: FROM, budget });
  for (const tool of ['clued_work_claim', 'clued_work_renew', 'clued_work_release', 'clued_work_verify', 'clued_work_takeover']) {
    const input = Object.freeze({ status: 'committed', receipt_id: RECEIPT, claim });
    const output = sanitizeCluedResult(input, tool);
    assert.deepEqual(output, input, tool);
    assert.equal(output.claim.budget, budget, `${tool}: preserve the user JSON branch`);
  }
  const resume = { status: 'restored', active_work_claims: [claim] };
  const active = { status: 'ok', claims: [claim] };
  assert.deepEqual(sanitizeCluedResult(resume, 'clued_session_resume'), resume);
  assert.equal(sanitizeCluedResult(resume, 'clued_session_resume').active_work_claims[0].budget, budget);
  assert.deepEqual(sanitizeCluedResult(active, 'clued_work_claims_active'), active);
  assert.equal(sanitizeCluedResult(active, 'clued_work_claims_active').claims[0].budget, budget);
});

test('module: unknown service budget and metadata still hide authentication identities', () => {
  // Boundary robustness only: do not invent an upstream RPC that emits this shape.
  const serviceBudget = Object.freeze({ user_id: USER, actor_user_id: USER, binding_id: BINDING, actor_binding_id: BINDING,
    retained: 17, nested: Object.freeze({ user_id: USER, binding_id: BINDING, retained: false }) });
  const publicBudget = { retained: 17, nested: { retained: false } };
  const input = Object.freeze({ budget: serviceBudget, metadata: Object.freeze({ actor_user_id: USER, budget: serviceBudget }) });
  const expected = { budget: publicBudget, metadata: { budget: publicBudget } };
  for (const tool of [undefined, 'clued_unknown_tool', 'clued_work_claim', 'clued_session_resume', 'clued_canonical_export']) {
    assert.deepEqual(sanitizeCluedResult(input, tool), expected, `${tool}: unrelated service metadata is not opaque`);
  }
  assert.deepEqual(sanitizeCluedResult({ claim: { budget: serviceBudget } }, 'clued_work_unknown'),
    { claim: { budget: publicBudget } }, 'an unknown work-prefixed tool does not create a claim boundary');
  assert.equal(serviceBudget.user_id, USER, 'the input remains unchanged');
});
