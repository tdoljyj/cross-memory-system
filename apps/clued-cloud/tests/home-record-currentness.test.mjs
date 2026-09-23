// Execute the actual consumer functions with controlled network ordering; no live writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map(), expressions = new Map();
function visit(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      ['refreshRecordList', 'handleCreateRecord', 'loadRecordView', 'clearChangedRecordCreate'].includes(node.name?.text)) functions.set(node.name.text, node.getText(ast));
  if (ts.isVariableDeclaration(node) && ['recordStatus', 'visibleRecords'].includes(node.name.getText(ast))) expressions.set(node.name.getText(ast), node.initializer.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.size, 4);
assert.equal(expressions.size, 2);
const compiled = ts.transpileModule([...functions.values()].join('\n') + `
this.read = refreshRecordList; this.submit = handleCreateRecord; this.load = loadRecordView; this.syncPending = clearChangedRecordCreate;
this.renderState = () => { const recordStatus = ${expressions.get('recordStatus')}; const visibleRecords = ${expressions.get('visibleRecords')}; return { recordStatus, visibleRecords }; };`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const oldRecord = { id: 'old', title: 'Previously visible' };
const response = (body, ok = true) => ({ ok, json: async () => body });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(network = async url => response(url.includes('?') ? { records: [] } : { status: 'committed', receipt_id: 'receipt-1', supplemental: { record: oldRecord } })) {
  const calls = [], state = { error: false, busy: false, title: ' Task ', content: ' Content ' }; let uuidCount = 0;
  const selectionToken = { key: 'A' };
  const context = {
    session: { user: { id: 'account-A' }, access_token: 'fixture-token' }, view: 'account', recordsEnabled: true,
    recordLevel: 'global', recordProjectId: '', recordView: 'task', recordSelectionKey: 'A',
    recordSelectionToken: selectionToken, activeRecordSelection: { current: selectionToken }, recordReadGeneration: { current: 0 },
    recordCreateKey: 'create-A', pendingRecordCreate: { current: null },
    recordBusy: false, recordTitle: state.title, recordContent: state.content,
    recordList: { key: 'A', selectionToken, status: 'ready', records: [oldRecord] },
    URLSearchParams, AbortController, crypto: { randomUUID: () => `11111111-1111-4111-8111-${String(++uuidCount).padStart(12, '0')}` },
    window: { setTimeout: callback => { callback(); return 1; }, clearTimeout() {} },
    setRecordList: value => { context.recordList = value; },
    setRecordBusy: value => { context.recordBusy = state.busy = value; },
    setRecordError: value => { state.error = value; },
    setRecordTitle: value => { context.recordTitle = state.title = value; },
    setRecordContent: value => { context.recordContent = state.content = value; },
    fetch: async (url, options) => { calls.push({ url, options }); return network(url, options); },
  };
  vm.runInNewContext(compiled, context);
  return { context, state, calls, read: signal => context.read(context.recordSelectionKey, context.recordSelectionToken,
    context.session.access_token, context.recordLevel, context.recordProjectId, context.recordView, signal),
    submit: () => context.submit({ preventDefault() {} }), change: key => {
      context.recordSelectionKey = key;
      context.recordSelectionToken = { key };
      context.activeRecordSelection.current = context.recordSelectionToken;
    } };
}

for (const flag of ['current_projection_unavailable', 'projection_rebuild_required']) {
  test(`${flag} hides even nonempty returned rows as unknown`, async () => {
    const f = fixture(async () => response({ records: [oldRecord], [flag]: true })); await f.read();
    assert.equal(f.context.recordList.status, 'unknown'); assert.equal(f.context.recordList.records.length, 0);
    assert.equal(f.context.renderState().visibleRecords.length, 0);
  });
}
test('confirmed empty and loading are distinct; starting a read removes old rows', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise); const read = f.read();
  assert.equal(f.context.recordList.status, 'loading'); assert.equal(f.context.recordList.records.length, 0);
  wait.resolve(response({ records: [], current_projection_unavailable: false })); await read;
  assert.equal(f.context.recordList.status, 'ready'); assert.equal(f.context.recordList.records.length, 0);
});
for (const [label, value] of [['HTTP error', response({}, false)], ['malformed envelope', response({})]]) {
  test(`${label} is error rather than confirmed empty`, async () => {
    const f = fixture(async () => value); await f.read();
    assert.equal(f.context.recordList.status, 'error'); assert.equal(f.context.recordList.records.length, 0);
  });
}
test('scope/account switch hides old rows before effects and ignores late responses', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise); const read = f.read();
  f.context.recordList = { key: 'A', status: 'ready', records: [oldRecord] }; f.change('B');
  assert.equal(f.context.renderState().recordStatus, 'loading'); assert.equal(f.context.renderState().visibleRecords.length, 0);
  wait.resolve(response({ records: [oldRecord] })); await read;
  assert.equal(f.context.recordList.key, 'A', 'late response cannot label old results as new scope');
});
test('same-scope later request wins even when the first request resolves last', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const f = fixture(() => ++count === 1 ? first.promise : second.promise);
  const a = f.read(), b = f.read(); second.resolve(response({ records: [{ id: 'new' }] })); await b;
  first.resolve(response({ records: [oldRecord] })); await a;
  assert.equal(f.context.recordList.records[0].id, 'new');
});
test('aborted request cannot publish even if its transport ignores abort', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise), controller = new AbortController();
  const read = f.read(controller.signal); controller.abort(); wait.resolve(response({ records: [oldRecord] })); await read;
  assert.equal(f.context.recordList.status, 'loading'); assert.equal(f.context.recordList.records.length, 0);
});
test('missing project invalidates pending reads and clears the view', () => {
  const f = fixture(); f.context.recordLevel = 'project'; f.context.load();
  assert.equal(f.context.recordList.status, 'idle'); assert.equal(f.context.recordList.records.length, 0);
  assert.equal(f.context.recordReadGeneration.current, 1); assert.equal(f.context.renderState().recordStatus, 'idle');
});
test('committed M1 create reloads the filtered list instead of prepending the returned record', async () => {
  const f = fixture(); f.context.recordLevel = 'project'; f.context.recordProjectId = 'project-1'; await f.submit();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].options.method, 'POST');
  const body = JSON.parse(f.calls[0].options.body);
  assert.equal(body.operation, 'create'); assert.equal(body.scope, 'project:project-1'); assert.equal(body.record_schema_version, 1);
  assert.equal(body.base_version, null); assert.equal(body.mutation.title, 'Task'); assert.equal(body.mutation.type_fields.execution_bucket, 'later');
  assert.equal(body.action, undefined); assert.equal(body.title, undefined);
  assert.equal(f.calls[1].url, '/v1/records?level=project&record_type=task&project_id=project-1');
  assert.equal(f.context.recordList.status, 'ready'); assert.equal(f.context.recordList.records.length, 0);
  assert.equal(f.state.title, ''); assert.equal(f.state.error, false); assert.equal(f.state.busy, false);
});
test('committed write can still have unknown Current; receipt does not override read gate', async () => {
  const f = fixture(async url => response(url.includes('?') ? { records: [oldRecord], current_projection_unavailable: true } : { status: 'committed', receipt_id: 'receipt-1' }));
  await f.submit(); assert.equal(f.context.recordList.status, 'unknown'); assert.equal(f.context.recordList.records.length, 0);
});
for (const body of [{ status: 'rejected' }, { status: 'committed' }, { record: oldRecord }]) {
  test(`unconfirmed write ${JSON.stringify(body)} never clears input or claims current`, async () => {
    const f = fixture(async () => response(body)); await f.submit();
    assert.equal(f.calls.length, 1); assert.equal(f.state.title, ' Task '); assert.equal(f.state.error, true);
    assert.equal(f.context.recordList.status, 'error'); assert.equal(f.context.recordList.records.length, 0);
  });
}
test('late mutation success after changing account/scope cannot clear new drafts or read the old scope', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise); const submit = f.submit();
  f.change('B'); f.context.setRecordTitle('New draft'); f.context.setRecordList({ key: 'B', status: 'ready', records: [{ id: 'B' }] });
  wait.resolve(response({ status: 'committed', receipt_id: 'receipt-1' })); await submit;
  assert.equal(f.state.title, 'New draft'); assert.equal(f.context.recordList.records[0].id, 'B'); assert.equal(f.calls.length, 1);
});
test('empty copy is only rendered for a successfully confirmed empty list', () => {
  assert.match(source, /recordStatus === "ready" && visibleRecords.length === 0/);
  for (const status of ['loading', 'unknown', 'error']) assert.ok(source.includes(`recordStatus === "${status}"`));
});

test('lost mutation response retries exact record ID, payload and key even after token refresh', async () => {
  let failed = false;
  const f = fixture(async url => {
    if (!failed) { failed = true; throw new TypeError('response lost after commit'); }
    return response(url.includes('?') ? { records: [] } : { status: 'committed', receipt_id: 'receipt-1', replayed: true });
  });
  await f.submit(); const body = f.calls[0].options.body;
  f.context.session.access_token = 'refreshed-token'; await f.submit();
  assert.equal(f.calls[1].options.body, body); assert.equal(f.calls[1].options.headers.authorization, 'Bearer refreshed-token');
  assert.equal(f.calls.length, 3); assert.equal(f.context.pendingRecordCreate.current, null); assert.equal(f.state.error, false);
});
test('changed draft/scope/subject invalidates the old pending create', async () => {
  const f = fixture(async () => { throw new TypeError('response lost'); });
  await f.submit(); const first = JSON.parse(f.calls[0].options.body);
  f.context.recordCreateKey = 'changed-create'; f.context.syncPending();
  assert.equal(f.context.pendingRecordCreate.current, null); await f.submit();
  assert.notEqual(JSON.parse(f.calls[1].options.body).idempotency_key, first.idempotency_key);
});
test('scope A to B to A cannot accept the original mutation completion', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise); const submit = f.submit();
  f.change('B'); f.change('A'); f.context.setRecordTitle('New draft');
  f.context.setRecordList({ key: 'A', status: 'ready', records: [{ id: 'new-A' }] });
  wait.resolve(response({ status: 'committed', receipt_id: 'receipt-1' })); await submit;
  assert.equal(f.state.title, 'New draft'); assert.equal(f.context.recordList.records[0].id, 'new-A'); assert.equal(f.calls.length, 1);
});
test('scope A to B to A cannot resurrect cached rows or accept its original read', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise); const read = f.read();
  f.context.recordList = { key: 'A', selectionToken: f.context.recordSelectionToken, status: 'ready', records: [oldRecord] };
  f.change('B'); f.change('A');
  assert.equal(f.context.renderState().recordStatus, 'loading'); assert.equal(f.context.renderState().visibleRecords.length, 0);
  wait.resolve(response({ records: [oldRecord] })); await read;
  assert.equal(f.context.renderState().recordStatus, 'loading'); assert.equal(f.context.renderState().visibleRecords.length, 0);
});
