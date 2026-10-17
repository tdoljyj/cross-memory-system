// Execute the actual home submit handler with controlled state and network; no browser or live writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler, updateHandler, clearHandler, observeHandler, projectEffect, visibility, selectionKey, confirmed, readFailed;
function find(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleCreateProject') handler = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'updateProject') updateHandler = node;
  if (ts.isFunctionExpression(node) && node.name?.text === 'clearChangedProjectCreate') clearHandler = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'observeProjectSession') observeHandler = node;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'visibleProjects') visibility = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'projectSelectionKey') selectionKey = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'projectsConfirmed') confirmed = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'projectReadFailed') readFailed = node.initializer;
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('const epoch = projectActor.current.epoch')) projectEffect = node.arguments[0];
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(handler, 'home project submit handler exists');
assert.ok(updateHandler, 'home project update handler exists');
assert.ok(clearHandler, 'pending creation clears on account/name changes');
assert.ok(observeHandler); assert.ok(projectEffect); assert.ok(visibility); assert.ok(selectionKey); assert.ok(confirmed); assert.ok(readFailed);
const compiled = ts.transpileModule([handler, updateHandler, clearHandler, observeHandler].map(n => n.getText(ast)).join('\n')
  + '\nthis.submit = handleCreateProject; this.update = updateProject; this.syncPending = clearChangedProjectCreate;'
  + '\nthis.makeSelectionKey = () => (' + selectionKey.getText(ast) + ');'
  + '\nthis.confirmedState = () => (' + confirmed.getText(ast) + '); this.failedState = () => (' + readFailed.getText(ast) + ');'
  + '\nthis.visible = () => (' + visibility.getText(ast) + '); this.readProjects = ' + projectEffect.getText(ast) + ';', {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
// Standard host globals and the real read helper are injected into this AST fixture.
const recoveryCompiled = ts.transpileModule(readFileSync(new URL('../app/native-read-recovery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const project = { id: '11111111-1111-4111-8111-111111111111', name: 'Test project', progress_status: 'not_started', version: 1 };
function fixture({ response = { status: 'committed', supplemental: { project } }, status = 200, fail = false, session = { user: { id: 'fixture-subject-A' }, access_token: 'fixture-human' }, name = '  Test project  ', traceCrypto } = {}) {
  const state = { projects: [{ id: 'existing', name: 'Existing' }], name, busy: false, error: false, recordTitle: 'Draft', recordContent: 'Body' };
  const calls = [];
  const readEvents = [], recoveryExports = {};
  let traceCount = 0;
  vm.runInNewContext(recoveryCompiled, { exports: recoveryExports, AbortController, setInterval, clearInterval, setTimeout, clearTimeout, Date,
    crypto: traceCrypto ?? { randomUUID: () => '55555555-5555-4555-8555-' + String(++traceCount).padStart(12, '0') },
    console: { info(value) { readEvents.push(JSON.parse(value)); } } });
  const network = { response, status, fail };
  let uuidCount = 0;
  const context = {
    ...recoveryExports, AbortController,
    get projectsConfirmed() { return context.confirmedState(); },
    get projectReadFailed() { return context.failedState(); },
    session, view: 'account', projectName: name, projectBusy: false, pendingProjectCreate: { current: null },
    projects: state.projects, projectSelectionToken: {}, projectsOwner: null, projectReload: 0, projectReadError: null,
    projectReadGeneration: { current: 0 },
    projectActor: { current: { subject: session?.user.id ?? '', token: session?.access_token ?? '', epoch: 1 } },
    crypto: { randomUUID: () => ++uuidCount === 1 ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-' + String(uuidCount).padStart(12, '0') },
    setProjectBusy: value => { state.busy = value; },
    setProjectError: value => { state.error = value; },
    setProjectReadError: value => { context.projectReadError = value; },
    setProjectsOwner: value => { context.projectsOwner = value; },
    setProjectReload: value => { state.reload = typeof value === 'function' ? value(state.reload ?? 0) : value;
      context.projectReload = state.reload; refreshSelection(); },
    setRecordTitle: value => { state.recordTitle = value; },
    setRecordContent: value => { state.recordContent = value; },
    setProjectName: value => { state.name = value; context.projectName = value; context.syncPending(); },
    setProjects: value => { state.projects = typeof value === 'function' ? value(state.projects) : value; context.projects = state.projects; },
    async fetch(url, options) {
      calls.push({ url, options });
      if (network.wait) await network.wait;
      if (network.fail) throw new TypeError('fixture connection failure');
      const value = url.includes('?limit=') || (url === '/v1/projects' && !options.method) ? network.listing : network.response;
      return { ok: network.status >= 200 && network.status < 300, status: network.status,
        headers: { get() { if (network.echoFailure) throw Error('PRIVATE_ECHO_FAILURE'); return network.echoMismatch ? 'PRIVATE_UNTRUSTED_ECHO' : options.headers['x-kooyumi-read-trace'] ?? null; } },
        json: async () => { if (network.bodyFailure) throw new TypeError('PRIVATE_BODY_INTERRUPTED'); return value; } };
    },
  };
  vm.runInNewContext(compiled, context);
  function refreshSelection() {
    const key = context.makeSelectionKey();
    if (context.projectSelectionToken.key !== key) context.projectSelectionToken = { key };
  }
  refreshSelection(); context.projectsOwner = context.projectSelectionToken;
  Object.defineProperty(state, 'readError', { get: () => context.projectReadFailed });
  return { state, calls, readEvents, pending: context.pendingProjectCreate, setNetwork: value => Object.assign(network, value),
    changeName: value => context.setProjectName(value),
    changeSession: value => {
      context.observeProjectSession(value); context.session = value;
      refreshSelection();
      context.syncPending();
    },
    changeView: value => { context.view = value; refreshSelection(); },
    confirmed: () => context.projectsConfirmed, visible: () => context.visible(),
    readProjects: () => { context.setProjectReload(value => value + 1); return context.readProjects(); },
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
  f.changeName('Test project');
  await f.submit(); assert.equal(f.calls[1].options.headers.authorization, 'Bearer fixture-other');
  assert.notEqual(JSON.parse(f.calls[1].options.body).idempotency_key, JSON.parse(firstBody).idempotency_key);
  f.changeSession(null); assert.equal(f.pending.current, null);
  f.changeSession({ user: { id: 'fixture-subject-A' }, access_token: 'fixture-human' }); f.changeName('Test project'); await f.submit();
  assert.notEqual(JSON.parse(f.calls[2].options.body).idempotency_key, JSON.parse(firstBody).idempotency_key);
});
test('committed replay without the exact project in the refreshed list keeps its original retry key', async () => {
  const f = fixture({ response: { status: 'committed', replayed: true, target_refs: [{ role: 'primary', kind: 'project', id: project.id }] } });
  f.setNetwork({ listing: { projects: [] } }); await f.submit();
  assert.equal(f.state.error, true); assert.ok(f.pending.current); assert.equal(f.state.projects[0].id, 'existing');
  const firstBody = f.calls[0].options.body; await f.submit(); assert.equal(f.calls[2].options.body, firstBody);
});

const accountA = { user: { id: 'fixture-subject-A' }, access_token: 'fixture-human' };
const accountB = { user: { id: 'fixture-subject-B' }, access_token: 'fixture-other' };
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('account or token change immediately hides cached projects and owner drafts', () => {
  const f = fixture(); assert.equal(f.visible().length, 1);
  f.changeSession(accountB);
  assert.equal(f.visible().length, 0); assert.equal(f.state.name, '');
  assert.equal(f.state.recordTitle, ''); assert.equal(f.state.recordContent, '');
  f.changeSession(accountA); assert.equal(f.visible().length, 0);
  f.changeName('Preserve owner draft');
  f.changeSession({ ...accountA, access_token: 'refreshed' });
  assert.equal(f.visible().length, 0); assert.equal(f.state.name, 'Preserve owner draft');
});

test('late project reads cannot repopulate another account or a refreshed token, including A-B-A', async () => {
  for (const changes of [[accountB], [{ ...accountA, access_token: 'refreshed' }], [accountB, accountA]]) {
    const f = fixture(); const wait = deferred();
    f.setNetwork({ listing: { projects: [project] }, wait: wait.promise });
    f.readProjects(); for (const next of changes) f.changeSession(next);
    wait.resolve(); await settle();
    assert.equal(f.visible().length, 0); assert.equal(f.state.projects.length, 0);
  }
});

test('current project list is visible only after a successful owned response; failure clears the list', async () => {
  const f = fixture(); f.setNetwork({ listing: { projects: [project] } });
  f.readProjects(); await settle(); assert.equal(f.visible()[0].id, project.id);
  f.setNetwork({ status: 403 }); f.readProjects(); await settle();
  assert.equal(f.visible().length, 0); assert.equal(f.confirmed(), false);
  assert.equal(f.state.readError, true); assert.equal(f.state.error, false);
});

test('late creates and updates cannot modify a new account or restored A session', async () => {
  for (const operation of ['create', 'update']) for (const changes of [[accountB], [accountB, accountA]]) {
    const f = fixture({ response: { status: 'committed', supplemental: { project: { ...project, version: 2 } } } });
    const wait = deferred(); f.setNetwork({ wait: wait.promise });
    const pending = operation === 'create' ? f.submit() : f.update(project, 'set_progress', { progress_status: 'active' });
    for (const next of changes) f.changeSession(next);
    f.changeName('New owner draft'); wait.resolve(); await pending;
    assert.equal(f.visible().length, 0); assert.equal(f.state.projects.length, 0);
    assert.equal(f.state.name, 'New owner draft'); assert.equal(f.state.error, false); assert.equal(f.state.busy, false);
  }
});

test('a project loaded during an in-flight create remains beside the newly created project', async () => {
  const f = fixture(); const wait = deferred();
  const cancel = f.readProjects(); await settle(); cancel();
  f.setNetwork({ wait: wait.promise }); const creating = f.submit();
  f.setNetwork({ wait: null, listing: { projects: [{ id: 'concurrently-loaded', name: 'Owned existing project' }] } });
  f.readProjects(); await settle(); assert.equal(f.visible()[0].id, 'concurrently-loaded');
  wait.resolve(); await creating;
  assert.deepEqual(Array.from(f.state.projects, row => row.id), [project.id, 'concurrently-loaded'], 'the committed create preserves concurrently loaded identity');
  assert.equal(f.state.projects[0].version, project.version, 'the confirmed created project keeps its actual CAS version');
  assert.equal(f.confirmed(), false, 'the mutation-triggered reload is immediately unconfirmed');
  const currentListing = Array.from(f.state.projects);
  f.setNetwork({ listing: { projects: currentListing } }); f.readProjects(); await settle();
  assert.deepEqual(Array.from(f.visible(), row => row.id), [project.id, 'concurrently-loaded']);
  assert.equal(f.visible()[0].version, project.version);
});

test('a pre-mutation listing cannot replace committed project creation or progress', async () => {
  for (const operation of ['create', 'update']) {
    const updated = { ...project, progress_status: 'active', version: 2 };
    const f = fixture({ response: { status: 'committed', supplemental: { project: updated } } });
    const wait = deferred(); f.setNetwork({ wait: wait.promise, listing: { projects: [project] } });
    f.readProjects(); const reloadBeforeMutation = f.state.reload; f.setNetwork({ wait: null });
    await (operation === 'create' ? f.submit() : f.update(project, 'set_progress', { progress_status: 'active' }));
    wait.resolve(); await settle();
    assert.equal(f.state.reload, reloadBeforeMutation + 1, 'the committed mutation requests exactly one new read');
    assert.equal(f.state.projects.find(row => row.id === project.id)?.version, operation === 'create' ? 2 : undefined);
    f.setNetwork({ listing: { projects: [updated] } }); f.readProjects(); await settle();
    assert.equal(f.visible()[0].version, 2);
  }
});

test('malformed successful project listing clears cached scope choices rather than throwing during rendering', async () => {
  const f = fixture(); f.setNetwork({ listing: { projects: 'invalid' } }); f.readProjects(); await settle();
  assert.equal(f.visible().length, 0); assert.equal(f.confirmed(), false);
  assert.equal(f.state.readError, true); assert.equal(f.state.error, false);
});

test('project read keeps unknown distinct from confirmed empty and write error', async () => {
  const f = fixture(); f.setNetwork({ status: 403 });
  f.readProjects(); assert.equal(f.confirmed(), false); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.state.readError, true); assert.equal(f.state.error, false);
  f.setNetwork({ status: 200, listing: { projects: [] } });
  f.readProjects(); await settle(); assert.equal(f.confirmed(), true); assert.equal(f.visible().length, 0);
  assert.equal(f.state.readError, false); assert.equal(f.state.error, false);
  assert.match(source, /projectsConfirmed \? visibleProjects\.length : "—"/);
  assert.match(source, /projectsConfirmed && visibleProjects\.length === 0/);
});
test('actual project effect recovers only transport with original JWT and no-store', async () => {
  const f = fixture(); f.setNetwork({ fail: true }); const cleanup = f.readProjects();
  assert.equal(f.calls.length, 1); f.setNetwork({ fail: false, listing: { projects: [project] } });
  await new Promise(resolve => setTimeout(resolve, 350)); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.visible()[0].id, project.id); assert.equal(f.state.readError, false);
  assert.ok(f.calls.every(call => call.options.cache === 'no-store'
    && call.options.headers.authorization === 'Bearer fixture-human' && call.options.signal instanceof AbortSignal));
  const traces = f.calls.map(call => call.options.headers['x-kooyumi-read-trace']);
  assert.ok(traces.every(trace => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trace)));
  assert.equal(new Set(traces).size, 2, 'each actual retry has its own anonymous trace');
  for (const event of f.readEvents) assert.equal(event.traceId, traces[event.attempt - 1], 'header and diagnostic match exactly');
  assert.deepEqual(f.readEvents.filter(event => event.outcome === 'milestone').map(event => event.phase),
    ['response_headers', 'json_decoded', 'payload_validated']);
  assert.equal(f.readEvents.find(event => event.phase === 'response_headers').responseTraceMatched, true);
  cleanup();
});

test('actual project effect preserves header, JSON and validation failure boundaries', async () => {
  for (const [network, milestones, phase] of [
    [{ status: 401 }, ['response_headers'], 'http'],
    [{ bodyFailure: true }, ['response_headers'], 'body'],
    [{ listing: { projects: 'PRIVATE_MALFORMED_PAYLOAD' } }, ['response_headers', 'json_decoded'], 'payload'],
  ]) {
    const f = fixture(); f.setNetwork(network); const cleanup = f.readProjects();
    await settle(); cleanup(); await settle();
    assert.deepEqual(f.readEvents.filter(event => event.outcome === 'milestone').map(event => event.phase), milestones);
    assert.equal(f.readEvents.find(event => event.outcome === 'retry' || event.outcome === 'failed').phase, phase);
    assert.doesNotMatch(JSON.stringify(f.readEvents), /PRIVATE_MALFORMED_PAYLOAD|PRIVATE_BODY_INTERRUPTED|fixture-human|fixture-subject/);
  }
});

test('actual project echo inspection and unavailable crypto never affect the read or mutations', async () => {
  for (const network of [{ echoFailure: true }, { echoMismatch: true }]) {
    const f = fixture(); f.setNetwork({ listing: { projects: [project] }, ...network }); f.readProjects(); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.visible()[0].id, project.id);
    assert.equal(f.readEvents.find(event => event.phase === 'response_headers').responseTraceMatched, network.echoFailure ? null : false);
    assert.doesNotMatch(JSON.stringify(f.readEvents), /PRIVATE_ECHO_FAILURE|PRIVATE_UNTRUSTED_ECHO/);
  }
  const f = fixture({ traceCrypto: { randomUUID() { throw Error('PRIVATE_CRYPTO_FAILURE'); } } });
  f.setNetwork({ listing: { projects: [project] } }); f.readProjects(); await settle();
  assert.equal(f.visible()[0].id, project.id); assert.equal(f.calls[0].options.headers['x-kooyumi-read-trace'], undefined);
  assert.ok(f.readEvents.every(event => event.traceId === null));
  await f.submit(); await f.update(project, 'set_progress', { progress_status: 'active' });
  assert.deepEqual(f.calls.map(call => call.options.method ?? 'GET'), ['GET', 'POST', 'PATCH']);
  assert.ok(f.calls.every(call => call.options.headers['x-kooyumi-read-trace'] === undefined));
  assert.equal(JSON.parse(f.calls[1].options.body).idempotency_key, '33333333-3333-4333-8333-333333333333');
});
test('actual project effect cleanup aborts a pending transport and prevents retry', async () => {
  const f = fixture(); const wait = deferred(); f.setNetwork({ wait: wait.promise, listing: { projects: [project] } });
  const cleanup = f.readProjects(); const signal = f.calls[0].options.signal; cleanup(); assert.equal(signal.aborted, true);
  wait.resolve(); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.confirmed(), false); assert.equal(f.state.readError, false);
});

test('new read/view selection immediately hides cached list and prior read error without an effect setter', async () => {
  const f = fixture(); assert.equal(f.confirmed(), true);
  f.changeView('login'); assert.equal(f.confirmed(), false); assert.equal(f.visible().length, 0);
  f.changeView('account'); assert.equal(f.confirmed(), false, 'A-B-A view changes cannot revive an old response');
  f.setNetwork({ status: 403 }); f.readProjects(); await settle(); assert.equal(f.state.readError, true);
  const wait = deferred(); f.setNetwork({ status: 200, wait: wait.promise, listing: { projects: [project] } });
  const cleanup = f.readProjects();
  assert.equal(f.confirmed(), false); assert.equal(f.state.readError, false, 'prior error belongs only to its old read selection');
  assert.equal(f.state.error, false); cleanup(); wait.resolve(); await settle();
  assert.equal(f.confirmed(), false, 'cleanup does not leave any response confirmed'); assert.equal(f.visible().length, 0);
});
