// Execute the actual home submit handler with controlled state and network; no browser or live writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler, updateHandler, clearHandler;
function find(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleCreateProject') handler = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'updateProject') updateHandler = node;
  if (ts.isFunctionExpression(node) && node.name?.text === 'clearChangedProjectCreate') clearHandler = node;
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(handler, 'home project submit handler exists');
assert.ok(updateHandler, 'home project update handler exists');
assert.ok(clearHandler, 'pending creation clears on account/name changes');
const compiled = ts.transpileModule(handler.getText(ast) + '\n' + updateHandler.getText(ast) + '\n' + clearHandler.getText(ast) + '\nthis.submit = handleCreateProject; this.update = updateProject; this.syncPending = clearChangedProjectCreate;', {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const project = { id: '11111111-1111-4111-8111-111111111111', name: 'Test project', progress_status: 'not_started', version: 1 };
function fixture({ response = { status: 'committed', supplemental: { project } }, status = 200, fail = false, session = { user: { id: 'fixture-subject-A' }, access_token: 'fixture-human' }, name = '  Test project  ' } = {}) {
  const state = { projects: [{ id: 'existing', name: 'Existing' }], name, busy: false, error: false };
  const calls = [];
  const network = { response, status, fail };
  let uuidCount = 0;
  const context = {
    session, projectName: name, projectBusy: false, pendingProjectCreate: { current: null },
    crypto: { randomUUID: () => ++uuidCount === 1 ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-' + String(uuidCount).padStart(12, '0') },
    setProjectBusy: value => { state.busy = value; },
    setProjectError: value => { state.error = value; },
    setProjectName: value => { state.name = value; context.projectName = value; context.syncPending(); },
    setProjects: value => { state.projects = typeof value === 'function' ? value(state.projects) : value; },
    async fetch(url, options) {
      calls.push({ url, options });
      if (network.fail) throw new TypeError('fixture connection failure');
      const value = url.includes('?limit=') ? network.listing : network.response;
      return { ok: network.status >= 200 && network.status < 300, status: network.status, json: async () => value };
    },
  };
  vm.runInNewContext(compiled, context);
  return { state, calls, pending: context.pendingProjectCreate, setNetwork: value => Object.assign(network, value),
    changeName: value => context.setProjectName(value),
    changeSession: value => { context.session = value; context.syncPending(); },
    submit: () => context.submit({ preventDefault() {} }), update: (...args) => context.update(...args) };
}
test('home creates a recognized project through the Project Lifecycle v2 contract', async () => {
  const f = fixture(); await f.submit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/v1/projects');
  assert.equal(f.calls[0].options.method, 'POST');
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer fixture-human');
  assert.deepEqual(JSON.parse(f.calls[0].options.body), {
    operation: 'create', project_schema_version: 2, base_version: null,
    idempotency_key: '33333333-3333-4333-8333-333333333333',
    mutation: { name: 'Test project', progress_status: 'not_started', aliases: [] },
    recognition: { confidence: 1, reason: 'The account owner explicitly created this Project.', source: 'v2_explicit_create', source_refs: [] },
  });
  assert.equal(f.state.projects[0].id, project.id);
  assert.equal(f.state.projects[1].id, 'existing');
  assert.equal(f.state.name, ''); assert.equal(f.state.error, false); assert.equal(f.state.busy, false);
});
for (const [label, options] of [
  ['HTTP 200 rejected receipt', { response: { status: 'rejected', error_code: 'invalid_project_schema' } }],
  ['committed receipt without a project', { response: { status: 'committed' } }],
  ['retired success envelope', { response: { status: 'ok', project } }],
  ['HTTP failure', { status: 405 }],
  ['lost response', { fail: true }],
]) test(label + ' preserves input and list instead of claiming success', async () => {
  const f = fixture(options); await f.submit();
  assert.equal(f.state.error, true); assert.equal(f.state.busy, false);
  assert.equal(f.state.name, '  Test project  ');
  assert.equal(f.state.projects.length, 1); assert.equal(f.state.projects[0].id, 'existing');
});
test('missing login or empty project name sends no request', async () => {
  for (const options of [{ session: null }, { name: '   ' }]) {
    const f = fixture(options); await f.submit(); assert.equal(f.calls.length, 0);
  }
});

for (const [label, current, action, extra, operation, mutation, nextProgress] of [
  ['start', project, 'set_progress', { progress_status: 'active' }, 'update', { progress_status: 'active' }, 'active'],
  ['pause', { ...project, progress_status: 'active' }, 'set_progress', { progress_status: 'paused' }, 'update', { progress_status: 'paused' }, 'paused'],
  ['complete', project, 'set_progress', { progress_status: 'completed' }, 'complete', {}, 'completed'],
  ['archive selection', project, 'set_progress', { progress_status: 'archived' }, 'archive', {}, 'archived'],
  ['archive button', project, 'archive', {}, 'archive', {}, 'archived'],
  ['restore completed', { ...project, progress_status: 'completed' }, 'set_progress', { progress_status: 'active' }, 'restore', {}, 'active'],
  ['restore archived', { ...project, progress_status: 'archived' }, 'set_progress', { progress_status: 'active' }, 'restore', {}, 'active'],
]) test(label + ' uses the current v2 PATCH operation and CAS version', async () => {
  const updated = { ...current, ...mutation, progress_status: nextProgress, version: 2 };
  const f = fixture({ response: { status: 'committed', supplemental: { project: updated } } });
  f.state.projects = [current]; await f.update(current, action, extra);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/v1/projects/' + project.id);
  assert.equal(f.calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(f.calls[0].options.body), {
    operation, project_schema_version: 2, base_version: current.version,
    idempotency_key: '33333333-3333-4333-8333-333333333333', mutation,
  });
  assert.equal(f.state.projects.length, 1, 'archive preserves the project in history');
  assert.equal(f.state.projects[0].version, 2); assert.equal(f.state.error, false);
});
test('HTTP 200 rejection or mismatched/stale project never replaces the displayed project', async () => {
  for (const response of [
    { status: 'rejected', error_code: 'project_version_conflict' },
    { status: 'committed', supplemental: { project: { ...project, id: 'another-project', version: 2 } } },
    { status: 'committed', supplemental: { project } },
  ]) {
    const f = fixture({ response }); f.state.projects = [project]; await f.update(project, 'set_progress', { progress_status: 'active' });
    assert.equal(f.state.projects[0], project); assert.equal(f.state.error, true); assert.equal(f.state.busy, false);
  }
});
test('unsupported progress and terminal direct pause never send a write', async () => {
  for (const [current, progress] of [[project, 'impossible'], [{ ...project, progress_status: 'completed' }, 'paused']]) {
    const f = fixture(); await f.update(current, 'set_progress', { progress_status: progress });
    assert.equal(f.calls.length, 0); assert.equal(f.state.error, true);
  }
});

test('lost response retries the exact payload/key and resolves the replay receipt through its real project ID', async () => {
  const f = fixture({ fail: true }); await f.submit();
  const firstBody = f.calls[0].options.body;
  assert.ok(f.pending.current); assert.equal(f.state.error, true);
  f.changeName('Test project');
  f.changeSession({ user: { id: 'fixture-subject-A' }, access_token: 'fixture-refreshed' });
  f.setNetwork({ fail: false, response: { status: 'committed', replayed: true, target_refs: [{ role: 'primary', kind: 'project', id: project.id }] }, listing: { projects: [project] } });
  await f.submit();
  assert.equal(f.calls[1].options.body, firstBody);
  assert.equal(f.calls[1].options.headers.authorization, 'Bearer fixture-refreshed');
  assert.equal(f.calls[2].url, '/v1/projects?limit=200');
  assert.equal(f.state.projects[0].id, project.id); assert.equal(f.state.error, false); assert.equal(f.pending.current, null);
});
test('changing the trimmed name clears the pending operation even if the original name is restored', async () => {
  const f = fixture({ fail: true }); await f.submit(); const firstBody = f.calls[0].options.body;
  f.changeName('Different project'); assert.equal(f.pending.current, null);
  f.changeName('Test project'); await f.submit();
  assert.notEqual(JSON.parse(f.calls[1].options.body).idempotency_key, JSON.parse(firstBody).idempotency_key);
});
test('changing accounts clears the pending creation and never reuses another subject operation', async () => {
  const f = fixture({ fail: true }); await f.submit(); const firstBody = f.calls[0].options.body;
  f.changeSession({ user: { id: 'fixture-subject-B' }, access_token: 'fixture-other' }); assert.equal(f.pending.current, null);
  await f.submit(); assert.equal(f.calls[1].options.headers.authorization, 'Bearer fixture-other');
  assert.notEqual(JSON.parse(f.calls[1].options.body).idempotency_key, JSON.parse(firstBody).idempotency_key);
  f.changeSession(null); assert.equal(f.pending.current, null);
  f.changeSession({ user: { id: 'fixture-subject-A' }, access_token: 'fixture-human' }); await f.submit();
  assert.notEqual(JSON.parse(f.calls[2].options.body).idempotency_key, JSON.parse(firstBody).idempotency_key);
});
test('committed replay without the exact project in the refreshed list keeps its original retry key', async () => {
  const f = fixture({ response: { status: 'committed', replayed: true, target_refs: [{ role: 'primary', kind: 'project', id: project.id }] } });
  f.setNetwork({ listing: { projects: [] } }); await f.submit();
  assert.equal(f.state.error, true); assert.ok(f.pending.current); assert.equal(f.state.projects[0].id, 'existing');
  const firstBody = f.calls[0].options.body; await f.submit(); assert.equal(f.calls[2].options.body, firstBody);
});
