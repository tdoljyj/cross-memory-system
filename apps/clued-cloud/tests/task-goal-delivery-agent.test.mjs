import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

const task = 'd2c137ad-405c-43f1-a8f2-757e318369d9';
const goalVersion = '3'.repeat(64);
const definition = {
  contract: 'clued.task-goal-delivery/1', goal: '交付约定的报告版本', scope: '本次报告文件',
  completion_level: 'artifact', input_versions: [], acceptance_mode: 'machine',
  conditions: [{ id: 'archive', kind: 'file_integrity', text: '约定字节版本已归档', deliverable_id: 'report' }],
  deliverables: [{ id: 'report', label: '报告', required: true }], delivery_refs: [],
};
const env = { PROJECT_VIEWS_V2: 'true', CLUED_DB_GATEWAY_TOKEN: 'fixture-worker-gateway',
  ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } };
const context = { waitUntil() {}, passThroughOnException() {} };
const call = (worker, name, args) => worker.fetch(new Request('https://clued.test/mcp', {
  method: 'POST', headers: { authorization: `Bearer clued_bnd_${'x'.repeat(43)}`, 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
}), env, context);

test('existing Agent record tools carry the one Task workflow and server goal revision', async () => {
  const worker = await loadContinuityWorker();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const name = /\/rpc\/([^/?]+)$/.exec(String(url))?.[1];
    const body = JSON.parse(init.body);
    calls.push({ name, input: body.p_input });
    assert.match(body.p_token_hash, /^[0-9a-f]{64}$/);
    if (name === 'clued_record_list') return Response.json({ status: 'ok', records: [{
      id: task, record_type: 'task', version: 4,
      task_workflow: { goal_version: goalVersion, definition, delivery_refs: [] },
    }] });
    assert.equal(name, 'clued_record_mutate');
    return Response.json({ status: 'committed', supplemental: { record: { id: task, version: 4 } } });
  };
  try {
    const input = { operation: 'update', record_type: 'task', record_schema_version: 1,
      lifecycle_status: 'active', id: task, scope: 'global', base_version: 3,
      idempotency_key: 'task-workflow-agent-0001', authority: 'observed', confidence_reason: 'Observed file goal',
      mutation: { type_fields: { task_workflow: definition } } };
    const write = await call(worker, 'clued_record_mutate', input);
    assert.equal(write.status, 200);
    assert.equal((await write.json()).result.structuredContent.status, 'committed');
    assert.deepEqual(calls[0].input, input, 'existing M1 receives the exact structured Task mutation');
    const read = await call(worker, 'clued_record_list', { level: 'global', record_type: 'task', limit: 1 });
    const record = (await read.json()).result.structuredContent.records[0];
    assert.equal(record.id, task);
    assert.equal(record.task_workflow.goal_version, goalVersion, 'Agent reads the server revision instead of inventing it');
    assert.deepEqual(record.task_workflow.definition, definition);
    assert.deepEqual(calls.map(item => item.name), ['clued_record_mutate', 'clued_record_list']);
  } finally { globalThis.fetch = previousFetch; }
});

test('Agent cannot replace actual Owner acceptance with its caller confirmation', async () => {
  const worker = await loadContinuityWorker();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('Owner-only RPC must not be reached'); };
  try {
    const response = await call(worker, 'clued_task_goal_delivery_owner_v1', {
      action: 'accept', id: task, user_confirmed: true, goal_version: goalVersion,
    });
    const body = await response.json();
    assert.ok(body.error || body.result?.isError, 'Native acceptance is not an Agent tool');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});
