// Execute the real panel and request/projection modules with controlled Native
// RPC ordering. This is a local interaction test, not a live service/browser test.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/imprints');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EVIDENCE = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const plain = value => JSON.parse(JSON.stringify(value));
const session = (owner, token = 'fixture-' + owner) => ({ user: { id: owner }, access_token: token });
const record = extra => ({ id: ID, title: 'Saved imprint', content: 'Complete source body\n<script>inert text</script>',
  record_type: 'note', canonical_scope: 'global', scope: 'global', version: 2, record_schema_version: 1,
  lifecycle_status: 'active', organization_version: 0, domains: [], record_currentness: 'CURRENT',
  type_fields: { note_kind: 'observation' }, relations: {}, source_refs: [], ...extra });
const page = (records = [], next = null, semantics = 'qualified_saved_latest') => ({ status: 'ok', records,
  read_semantics: semantics, selection_complete: true, page: { next_cursor: next, complete: next === null } });

function modules(React = {}, supabase = {}, crypto = webcrypto) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    vm.runInNewContext(compiled, { exports, crypto, TextEncoder, Date, Intl, Map, Set, Array, JSON, Error,
      AbortController, setInterval, clearInterval, setTimeout, clearTimeout,
      queueMicrotask: callback => React.queueMicrotask ? React.queueMicrotask(callback) : queueMicrotask(callback),
      require(name) {
        if (name === 'react') return React;
        if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
        if (name.endsWith('/supabase-browser')) return { supabase };
        if (name.startsWith('.')) {
          const base = path.resolve(path.dirname(file), name);
          return load(existsSync(base + '.ts') ? base + '.ts' : base + '.tsx');
        }
        throw Error(name);
      },
    }, { filename: file });
    return exports;
  }
  return { load: name => load(path.join(ROOT, name)) };
}

function fixture(initial = session('owner'), locale = 'zh-CN', initialDevelopmentContext, { crypto = webcrypto } = {}) {
  const hooks = new Map(), effects = [], microtasks = [], calls = [], rpcWaiters = new Set();
  let active, cursor, dirty = false, root, unmounted = false, who = initial, developmentContextId = initialDevelopmentContext;
  const notifyRpc = () => { for (const waiter of rpcWaiters) if (calls.length >= waiter.count) waiter.finish(); };
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const React = {
    queueMicrotask(callback) { microtasks.push(callback); },
    useState(initial) {
      const slot = cursor++; active[slot] ??= { value: typeof initial === 'function' ? initial() : initial };
      const hook = active[slot];
      return [hook.value, value => { const next = typeof value === 'function' ? value(hook.value) : value;
        if (!Object.is(next, hook.value)) { hook.value = next; dirty = true; } }];
    },
    useRef(value) { const slot = cursor++; active[slot] ??= { current: value }; return active[slot]; },
    useMemo(make, deps) { const slot = cursor++; if (!active[slot] || !equal(active[slot].deps, deps)) active[slot] = { deps, value: make() }; return active[slot].value; },
    useEffect(callback, deps) { const slot = cursor++; if (!active[slot] || !equal(active[slot].deps, deps)) {
      const old = active[slot], hook = { deps }; active[slot] = hook;
      effects.push(() => { old?.cleanup?.(); hook.cleanup = callback(); });
    } },
  };
  React.useLayoutEffect = React.useEffect;
  const supabase = { rpc(name, args) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const call = { name, args, resolve, reject, headers: {} }; calls.push(call); notifyRpc();
    return { then: (...args) => promise.then(...args), setHeader(name, value) { call.headers[name] = value; return this; },
      abortSignal(signal) { call.signal = signal; return this; } };
  } };
  const m = modules(React, supabase, crypto), Panel = m.load('ImprintPanel.tsx').default;
  function render() {
    if (unmounted) return root;
    let turns = 0;
    do {
      dirty = false;
      const seen = new Set();
      function expand(node, key = 'root') {
        if (Array.isArray(node)) return node.map((item, i) => expand(item, key + '/' + (item?.key ?? i)));
        if (!node || typeof node !== 'object') return node;
        if (typeof node.type === 'function') {
          const id = key + ':' + node.type.name; seen.add(id); if (!hooks.has(id)) hooks.set(id, []);
          const parent = active, position = cursor; active = hooks.get(id); cursor = 0;
          const child = node.type(node.props); active = parent; cursor = position;
          return expand(child, id);
        }
        return { ...node, props: { ...node.props, children: expand(node.props?.children, key + '/' + node.type) } };
      }
      root = expand({ type: Panel, props: { session: who, projects: [{ id: PROJECT, name: 'Design project' }], locale,
        ...(developmentContextId !== undefined ? { developmentContextId, developmentContextName: 'Engineering' } : {}) } });
      for (const [id, list] of hooks) if (!seen.has(id)) { list.forEach(hook => hook?.cleanup?.()); hooks.delete(id); }
      while (effects.length) effects.shift()();
      while (microtasks.length) microtasks.shift()();
      if (++turns > 30) throw Error('render loop');
    } while (dirty);
    return root;
  }
  function nodes(type, from = root) { const found = []; (function visit(n) {
    if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return;
    if (n.type === type) found.push(n); visit(n.props?.children);
  })(from); return found; }
  function text(node) { if (arguments.length === 0) node = root; if (Array.isArray(node)) return node.map(text).join(''); if (node == null || typeof node === 'boolean') return '';
    return typeof node === 'object' ? text(node.props?.children ?? null) : String(node); }
  const button = label => { const node = nodes('button').find(node => text(node) === label); assert.ok(node, label); return node; };
  const field = label => { const node = [...nodes('input'), ...nodes('textarea'), ...nodes('select')].find(node => node.props['aria-label'] === label); assert.ok(node, label); return node; };
  async function settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); render(); }
  // A real WebCrypto digest can finish after many immediate turns under worker
  // contention. Synchronize on the actual RPC registration, not render count.
  async function untilCalls(count, { timeoutMs = 5000 } = {}) {
    assert.ok(Number.isSafeInteger(count) && count > 0);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000);
    if (unmounted) throw Error('fixture unmounted before RPC dispatch');
    if (calls.length < count) await new Promise((resolve, reject) => {
      let timer, finished = false;
      const waiter = { count, finish(error) {
        if (finished) return;
        finished = true; clearTimeout(timer); rpcWaiters.delete(waiter);
        if (error) reject(error); else resolve();
      } };
      rpcWaiters.add(waiter);
      timer = setTimeout(() => waiter.finish(Error(`RPC not dispatched within ${timeoutMs}ms: expected ${count}, received ${calls.length}`)), timeoutMs);
      notifyRpc(); // Recheck after registration; no dispatch can be missed.
    });
    await settle();
  }
  function fire(node, event, payload = {}) { const result = node.props[event]({ preventDefault() {}, target: payload, ...payload }); render(); return result; }
  render();
  return { calls, render, nodes, text, button, field, fire, settle, untilCalls,
    change(label, value) { return fire(field(label), 'onChange', { value }); },
    click(label) { return fire(button(label), 'onClick'); },
    submit(label) { const form = nodes('form').find(node => node.props['aria-label'] === label || nodes('button', node).some(button => text(button) === label)); assert.ok(form, label); return fire(form, 'onSubmit'); },
    check(label, checked) { const parent = nodes('label').find(node => text(node) === label); assert.ok(parent, label); return fire(nodes('input', parent)[0], 'onChange', { checked }); },
    async respond(index, data) { calls[index].resolve({ data, error: null }); await settle(); },
    async fail(index) { calls[index].reject(new Error('lost response')); await settle(); },
    setSession(next) { who = next; render(); },
    setDevelopmentContext(next) { developmentContextId = next; render(); },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      hooks.forEach(list => list.forEach(hook => hook?.cleanup?.())); hooks.clear(); root = null;
      for (const waiter of rpcWaiters) waiter.finish(Error('fixture unmounted before RPC dispatch'));
    },
  };
}

test('RPC wait observes dispatch after an asynchronous digest exceeds the former immediate budget', async t => {
  let resumeDigest;
  const digestGate = new Promise(resolve => { resumeDigest = resolve; });
  const crypto = { randomUUID: () => webcrypto.randomUUID(), subtle: { async digest(...args) {
    await digestGate;
    return webcrypto.subtle.digest(...args);
  } } };
  const f = fixture(session('owner'), 'zh-CN', undefined, { crypto });
  t.after(() => { f.unmount(); resumeDigest(); });
  await f.respond(0, page([record()]));
  f.check('工作', true); const saving = f.submit('保存领域');
  let outcome = 'pending';
  const waiting = f.untilCalls(2).then(() => { outcome = 'dispatched'; }, () => { outcome = 'failed'; });
  for (let i = 0; i < 31; i++) await f.settle();
  assert.equal(outcome, 'pending'); assert.equal(f.calls.length, 1);
  resumeDigest(); await waiting;
  assert.equal(outcome, 'dispatched'); assert.equal(f.calls[1].name, 'clued_imprint_organization_set_v1');
  assert.equal(f.calls[1].headers.Authorization, 'Bearer fixture-owner');
  await f.respond(1, { status: 'rejected', error_code: 'organization_version_conflict' });
  await saving; assert.ok(f.text().includes('对象已有更新'));
});

test('RPC waits resolve for recorded calls and concurrent listeners without inventing responses', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await f.untilCalls(1);
  const first = f.untilCalls(2), second = f.untilCalls(2);
  f.click('工作'); await Promise.all([first, second]);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].name, 'clued_imprint_read_v1');
  assert.equal(f.calls[1].args.p_input.view, 'work');
  assert.ok(f.text().includes('正在读取印记'));
  await f.respond(1, page()); assert.ok(f.text().includes('没有匹配'));
});

test('an absent RPC fails at its bounded deadline and a later real dispatch still works', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await assert.rejects(f.untilCalls(2, { timeoutMs: 25 }), /RPC not dispatched within 25ms: expected 2, received 1/);
  assert.equal(f.calls.length, 1);
  f.click('学习'); await f.untilCalls(2);
  assert.equal(f.calls[1].args.p_input.view, 'learning');
});

test('unmount cancels RPC waits and settling cannot remount the fixture', async () => {
  const f = fixture();
  const waiting = f.untilCalls(2);
  f.unmount(); await assert.rejects(waiting, /fixture unmounted before RPC dispatch/);
  await f.settle(); assert.equal(f.calls.length, 1); assert.equal(f.nodes('article').length, 0);
  await assert.rejects(f.untilCalls(2), /fixture unmounted before RPC dispatch/);
});

test('eight views default to All; unclassified saved content and full inert text are readable', async t => {
  const f = fixture(); t.after(() => f.unmount());
  assert.deepEqual(f.nodes('button').filter(n => n.props.role === 'tab').map(f.text), ['全部', '任务', '决策', '日常', '工作', '学习', '创作', '兴趣']);
  assert.deepEqual(plain(f.calls[0].args.p_input), { view: 'all', scope: 'all', query: '', include_history: false, limit: 30, cursor: 0 });
  assert.equal(f.calls[0].headers.Authorization, 'Bearer fixture-owner');
  await f.respond(0, page([record(), record()]));
  assert.equal(f.nodes('article').length, 1); assert.ok(f.text().includes('未归类'));
  assert.ok(f.nodes('pre').some(node => node.props.children.includes('<script>inert text</script>')));
  assert.equal(f.nodes('script').length, 0); assert.ok(f.text().includes(ID));
});

test('projection uses purpose labels, never English/movie keywords; intersection is passed before pagination', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  f.click('工作'); f.change('内容性质', 'task'); f.change('追加领域（同时满足）', 'creation');
  const index = f.calls.length - 1;
  assert.deepEqual(plain(f.calls[index].args.p_input), { view: 'work', scope: 'all', query: '', include_history: false, record_type: 'task', domains: ['creation'], limit: 30, cursor: 0 });
  await f.respond(index, page([record({ record_type: 'task', domains: ['work', 'creation'], type_fields: { execution_bucket: 'later' } })]));
  assert.equal(f.nodes('article').length, 1);
  const model = modules().load('imprint-model.ts');
  const movie = model.normalizeRecord(record({ title: 'English movie list', domains: ['interest'] }));
  assert.equal(model.matchesProjection(movie, { view: 'learning', scope: 'all', domains: [], include_history: false }), false);
  assert.equal(model.matchesProjection(movie, { view: 'interest', scope: 'all', include_history: false }), true);
});

test('view/scope/query/account changes hide prior results and discard late Native responses', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record()]));
  f.click('工作'); assert.ok(!f.text().includes('Complete source body'));
  f.change('查询范围', 'project:' + PROJECT);
  f.change('搜索当前视图', 'logo'); f.submit('搜索');
  const old = f.calls.length - 1; assert.equal(f.calls[old].args.p_input.query, 'logo');
  f.setSession(session('another')); const latest = f.calls.length - 1;
  assert.equal(f.calls[old].headers.Authorization, 'Bearer fixture-owner'); assert.equal(f.calls[latest].headers.Authorization, 'Bearer fixture-another');
  await f.respond(old, page([record({ title: 'Private old account', canonical_scope: 'project:' + PROJECT, domains: ['work'] })]));
  assert.ok(!f.text().includes('Private old account'));
  await f.respond(latest, page()); assert.ok(f.text().includes('没有匹配'));
});

test('A to B to A does not revive cached content or accept the original request', async t => {
  const f = fixture(); t.after(() => f.unmount());
  f.click('工作'); f.click('全部');
  await f.respond(0, page([record({ title: 'Original A response' })]));
  assert.ok(!f.text().includes('Original A response'));
  await f.respond(2, page([record({ title: 'Fresh A response' })])); assert.ok(f.text().includes('Fresh A response'));
});

test('malformed and conflicting identities stay unknown rather than confirmed empty', async t => {
  for (const data of [{ status: 'ok', records: [] }, page([record({ version: 0 })]), page([record(), record({ content: 'different body' })]),
    { ...page([record()]), current_projection_unavailable: true }, { ...page([record()]), projection_rebuild_required: true }]) {
    const f = fixture(); t.after(() => f.unmount()); await f.respond(0, data);
    assert.ok(f.text().includes('读取结果未知')); assert.ok(!f.text().includes('没有匹配'));
  }
});

test('ordinary note save preserves ID/payload/hash/key after a lost response and requires a Receipt', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  f.change('标题', 'Maybe learn piano'); f.change('完整正文', 'A wish, not an accepted task.');
  const first = f.submit('保存普通印记'); await f.untilCalls(2);
  const pending = plain(f.calls[1].args); assert.equal(pending.p_input.record_type, 'note');
  assert.equal(pending.p_input.mutation.type_fields.note_kind, 'observation');
  assert.equal(pending.p_received_payload_hash, createHash('sha256').update(JSON.stringify(pending.p_input)).digest('hex'));
  await f.fail(1); await first;
  const retry = f.submit('保存普通印记'); await f.untilCalls(3); assert.deepEqual(plain(f.calls[2].args), pending);
  await f.respond(2, { status: 'committed' }); await retry;
  assert.equal(f.field('标题').props.value, 'Maybe learn piano'); assert.equal(f.calls.length, 3);
  const final = f.submit('保存普通印记'); await f.untilCalls(4);
  await f.respond(3, { status: 'committed', receipt_id: 'receipt-note' });
  assert.equal(f.field('标题').props.value, ''); assert.equal(f.calls[4].name, 'clued_imprint_read_v1');
  await f.respond(4, page()); await final;
  f.change('标题', 'Maybe learn piano'); f.change('完整正文', 'A wish, not an accepted task.');
  const another = f.submit('保存普通印记'); await f.untilCalls(6);
  assert.notEqual(f.calls[5].args.p_input.id, pending.p_input.id, 'a new explicit save after success is a new intent, not semantic deduplication');
  await f.fail(5); await another;
});

test('late successful note save cannot clear a changed draft or publish into a new view', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  f.change('标题', 'Original note'); f.change('完整正文', 'Original body');
  const submit = f.submit('保存普通印记'); await f.untilCalls(2);
  f.change('标题', 'New draft'); f.click('兴趣');
  await f.respond(1, { status: 'committed', receipt_id: 'receipt-old' }); await submit;
  assert.equal(f.field('标题').props.value, 'New draft'); assert.ok(!f.text().includes('receipt-old'));
  assert.equal(f.calls.length, 3);
});

test('domain edit updates only the displayed object, carries independent CAS, and retries exact intent', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record({ domains: ['work'], organization_version: 3, relations: { follows: [OTHER] } })]));
  f.check('创作', true);
  const submit = f.submit('保存领域'); await f.untilCalls(2);
  const pending = plain(f.calls[1].args.p_input);
  assert.deepEqual(Object.keys(pending).sort(), ['base_version', 'domains', 'idempotency_key', 'record_id', 'record_version']);
  assert.equal(pending.record_id, ID); assert.equal(pending.record_version, 2); assert.equal(pending.base_version, 3);
  assert.deepEqual(pending.domains, ['work', 'creation']); assert.ok(!JSON.stringify(pending).includes(OTHER));
  assert.equal(f.calls[1].args.p_received_payload_hash, createHash('sha256').update(JSON.stringify(pending)).digest('hex'));
  await f.fail(1); await submit;
  const retry = f.submit('保存领域'); await f.untilCalls(3); assert.deepEqual(plain(f.calls[2].args.p_input), pending);
  await f.respond(2, { status: 'committed', receipt_id: 'receipt-domains', supplemental: { organization: { record_id: ID, domains: ['creation', 'work'], version: 4 } } });
  await retry; assert.equal(f.calls[3].name, 'clued_imprint_read_v1');
});

test('domain write conflicts and late writes never mutate current content or claim success', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record()]));
  f.check('工作', true); const submit = f.submit('保存领域'); await f.untilCalls(2);
  await f.respond(1, { status: 'rejected', error_code: 'organization_version_conflict' }); await submit; assert.ok(f.text().includes('对象已有更新'));
  const retry = f.submit('保存领域'); await f.untilCalls(3); f.click('学习');
  await f.respond(2, { status: 'committed', receipt_id: 'old-view-receipt', supplemental: { organization: { record_id: ID, domains: ['work'], version: 1 } } });
  await retry; assert.ok(!f.text().includes('old-view-receipt')); assert.equal(f.calls.length, 4);
});

test('task deadline update is CAS-only, Beijing time, and does not copy execution text or lifecycle', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record({ record_type: 'task', type_fields: { execution_bucket: 'now' } })]));
  f.change('任务期限（北京时间）: Saved imprint', '2026-10-15T18:30');
  const submit = f.submit('保存期限'); await f.untilCalls(2);
  const input = plain(f.calls[1].args.p_input);
  assert.equal(input.base_version, 2); assert.equal(input.scope, 'global');
  assert.deepEqual(input.mutation, { type_fields: { due_at: '2026-10-15T10:30:00.000Z' } });
  for (const key of ['content', 'lifecycle_status', 'source_refs']) assert.ok(!(key in input));
  await f.respond(1, { status: 'committed', receipt_id: 'receipt-due' }); await submit;
  assert.equal(f.calls[2].name, 'clued_imprint_read_v1');
});

test('completed and noncurrent tasks retain full text, outcome and history without an editable deadline', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await f.respond(0, page([record({ record_type: 'task', lifecycle_status: 'completed', record_currentness: 'HISTORY', closure_summary: 'Actually finished' })]));
  assert.ok(f.text().includes('已完成')); assert.ok(f.text().includes('历史')); assert.ok(f.text().includes('Actually finished'));
  assert.equal(f.nodes('input').filter(node => node.props.type === 'datetime-local').length, 0);
  const model = modules().load('imprint-model.ts');
  assert.equal(model.canEditDue(model.normalizeRecord(record({ record_type: 'task', record_currentness: 'UNKNOWN' }))), false);
});

test('source locator is not claimed as full text; real saved source body remains inert and readable', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record({ source_refs: [EVIDENCE] })]));
  f.click('读取来源: ' + EVIDENCE);
  assert.deepEqual(plain(f.calls[1].args.p_input), { record_id: ID, evidence_id: EVIDENCE, include_history: false, record_version: 2 });
  await f.respond(1, { status: 'ok', available: false, evidence: { id: EVIDENCE, storage_ref: 'https://example.test/source' }, unavailable_reason: 'external_only' });
  assert.ok(f.text().includes('定位信息不等于全文')); assert.ok(!f.text().includes('已保存来源正文'));
  f.click('读取来源: ' + EVIDENCE);
  await f.respond(2, { status: 'ok', available: true, record_version: 2, evidence: { id: EVIDENCE }, content: 'Original meeting\n<script>not executable</script>', segment: null });
  assert.ok(f.text().includes('Original meeting')); assert.equal(f.nodes('script').length, 0);
});

test('source and related-detail reads are invalidated when selection changes; terminal detail explicitly includes history', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record({ source_refs: [EVIDENCE], relations: { follows: [OTHER] } })]));
  f.click('读取来源: ' + EVIDENCE); f.click('读取关联记录: ' + OTHER);
  assert.equal(f.calls[2].args.p_input.include_history, true); assert.equal(f.calls[2].args.p_input.id, OTHER);
  f.click('兴趣');
  await f.respond(1, { status: 'ok', available: true, content: 'Private previous source', evidence: { id: EVIDENCE } });
  await f.respond(2, page([record({ id: OTHER, title: 'Previous related record' })]));
  assert.ok(!f.text().includes('Private previous source')); assert.ok(!f.text().includes('Previous related record'));
});

test('legacy compatibility keeps real identity/version/body and null metadata without gaining execution eligibility', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await f.respond(0, page([record({ source_semantics: 'legacy_compatibility', authoritative: false, record_schema_version: null,
    lifecycle_status: null, type_fields: null, relations: null, source_refs: null, version: 1, record_type: 'task' })]));
  assert.equal(f.nodes('article').length, 1); assert.ok(f.text().includes('生命周期未提供'));
  assert.ok(f.text().includes('不视为正式当前结论')); assert.ok(f.text().includes('Complete source body'));
  assert.ok(f.nodes('pre').some(node => node.props.children.includes('"lifecycle_status": null')));
  assert.equal(f.nodes('input').filter(node => node.props.type === 'datetime-local').length, 0);
});

test('withdrawn source requires explicit history and stays identified as ineligible history', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record({ source_refs: [EVIDENCE] })]));
  f.click('读取来源: ' + EVIDENCE);
  const historical = { status: 'ok', available: true, record_version: 2, content: 'WITHDRAWN OLD SOURCE', evidence_status: 'withdrawn',
    source_semantics: 'historical_evidence', authoritative: false, current_input_eligible: false };
  await f.respond(1, historical); assert.ok(!f.text().includes('WITHDRAWN OLD SOURCE'));
  f.check('包含旧版本及待核对内容', true); await f.respond(2, page([record({ source_refs: [EVIDENCE] })]));
  f.click('读取来源: ' + EVIDENCE); assert.equal(f.calls[3].args.p_input.include_history, true);
  await f.respond(3, historical); assert.ok(f.text().includes('WITHDRAWN OLD SOURCE')); assert.ok(f.text().includes('不能作为当前输入')); assert.ok(f.text().includes('已撤回'));
});

test('English controls and scope/full-text limitations are actually rendered in English', async t => {
  const f = fixture(session('owner'), 'en'); t.after(() => f.unmount()); await f.respond(0, page());
  assert.deepEqual(f.nodes('button').filter(n => n.props.role === 'tab').map(f.text), ['All', 'Tasks', 'Decisions', 'Daily life', 'Work', 'Learning', 'Creation', 'Interests']);
  assert.ok(f.text().includes('not indexed here')); assert.ok(f.text().includes('Unclassified content'));
});

const developmentRecord = extra => record({ context_id: OTHER, source_kind: 'development', source_semantics: 'development_context',
  canonical_scope: 'project:' + PROJECT, scope: 'project:' + PROJECT, record_type: 'annotation', lifecycle_status: 'ACTIVE',
  record_schema_version: null, authority: 'candidate', qualification: 'candidate', authoritative: false, record_currentness: 'UNKNOWN',
  content: '{"title":"Engineering candidate","proposal":"Try blue"}', type_fields: {}, relations: {}, source_refs: [EVIDENCE], ...extra });

test('development mode shares eight views but isolates Native families, context and candidate identity', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount());
  assert.equal(f.calls[0].name, 'clued_development_imprint_read_v1'); assert.equal(f.calls[0].args.p_input.context_id, OTHER);
  await f.respond(0, page([developmentRecord({ history: [{ version: 1, body: { proposal: 'Earlier proposal' } }] })]));
  assert.ok(f.text().includes('候选内容')); assert.ok(f.text().includes('原始种类：annotation')); assert.ok(f.text().includes('Earlier proposal'));
  assert.ok(!f.nodes('form').some(node => node.props['aria-label'] === '保存普通印记'));
  assert.equal(f.nodes('input').filter(node => node.props.type === 'datetime-local').length, 0);
  assert.ok(!f.nodes('button').some(node => f.text(node).startsWith('读取来源:')));
  assert.ok(f.text().includes('来源读取尚未接入'));
  f.check('工作', true); const submit = f.submit('保存领域'); await f.untilCalls(2);
  const input = plain(f.calls[1].args.p_input);
  assert.equal(f.calls[1].name, 'clued_development_imprint_organization_set_v1');
  assert.equal(input.context_id, OTHER); assert.equal(input.source_kind, 'development'); assert.equal(input.record_version, 2);
  assert.equal(f.calls[1].args.p_received_payload_hash, createHash('sha256').update(JSON.stringify(input)).digest('hex'));
  await f.respond(1, { status: 'committed', receipt_id: 'dev-tags', supplemental: { organization: { record_id: ID, domains: ['work'], version: 1 } } }); await submit;
  assert.equal(f.calls[2].name, 'clued_development_imprint_read_v1');
  assert.ok(f.calls.every(call => call.name.startsWith('clued_development_imprint_')));
});

test('development union uses source_kind plus ID, and Canonical task is distinct from a same-ID candidate', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount());
  const canonical = record({ context_id: OTHER, source_kind: 'canonical', source_semantics: 'canonical_record', canonical_scope: 'project:' + PROJECT,
    record_type: 'task', title: 'Accepted project task', domains: ['work'] });
  await f.respond(0, page([developmentRecord({ domains: ['work'] }), canonical]));
  assert.equal(f.nodes('article').length, 2); assert.deepEqual(f.nodes('article').map(node => node.props['data-source-kind']).sort(), ['canonical', 'development']);
  f.click('任务'); await f.respond(1, page([canonical], null, 'strict_current'));
  assert.equal(f.nodes('article').length, 1); assert.ok(f.text().includes('Accepted project task')); assert.ok(!f.text(f.nodes('article')[0]).includes('候选内容'));
  assert.equal(f.nodes('input').filter(node => node.props.type === 'datetime-local').length, 0);
});

test('switching user/development/context/account does not accept a stale body or late cross-context receipt', async t => {
  const f = fixture(); t.after(() => f.unmount()); f.setDevelopmentContext(OTHER);
  await f.respond(0, page([record({ title: 'Old user body' })])); assert.ok(!f.text().includes('Old user body'));
  await f.respond(1, page([developmentRecord()])); f.check('工作', true);
  const submit = f.submit('保存领域'); await f.untilCalls(3); f.setDevelopmentContext(PROJECT);
  await f.respond(2, { status: 'committed', receipt_id: 'old-context-receipt', supplemental: { organization: { record_id: ID, domains: ['work'], version: 1 } } }); await submit;
  assert.ok(!f.text().includes('old-context-receipt')); assert.equal(f.calls[3].args.p_input.context_id, PROJECT);
  await f.respond(3, page([developmentRecord({ context_id: OTHER, title: 'Mismatched context body' })]));
  assert.ok(!f.text().includes('Mismatched context body')); assert.ok(f.text().includes('读取结果未知'));
  f.setSession(session('next-owner')); assert.equal(f.calls[4].headers.Authorization, 'Bearer fixture-next-owner');
});

test('invalid development context never falls back to a user API', async t => {
  const f = fixture(session('owner'), 'en', ''); t.after(() => f.unmount()); await f.settle();
  assert.equal(f.calls.length, 0); assert.ok(f.text().includes('not admitted')); assert.ok(!f.nodes('form').some(node => node.props['aria-label'] === 'Save an ordinary imprint'));
});

test('development Canonical source bridge fixes record version and cannot reuse a late source across contexts', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount());
  const canonical = record({ context_id: OTHER, source_kind: 'canonical', source_semantics: 'canonical_record', canonical_scope: 'project:' + PROJECT, source_refs: [EVIDENCE] });
  await f.respond(0, page([canonical])); f.click('读取来源: ' + EVIDENCE);
  assert.equal(f.calls[1].name, 'clued_imprint_source_v1'); assert.equal(f.calls[1].args.p_input.record_version, 2);
  await f.respond(1, { status: 'rejected', error_code: 'record_version_conflict' }); assert.ok(f.text().includes('刷新并核对'));
  f.click('读取来源: ' + EVIDENCE); f.setDevelopmentContext(PROJECT);
  await f.respond(2, { status: 'ok', available: true, content: 'OLD PROJECT SOURCE' }); assert.ok(!f.text().includes('OLD PROJECT SOURCE'));
  assert.ok(!f.calls.some(call => call.name === 'clued_user_record_mutate'));
});

test('typed Native M1 and organization conflicts stay conflicts and never generate replacement keys', async () => {
  const client = modules().load('imprint-client.ts');
  const pending = await client.prepareWrite({ id: ID, idempotency_key: 'stable-idempotency' });
  for (const code of ['record_version_conflict', 'organization_version_conflict', 'IDEMPOTENCY_KEY_CONFLICT']) {
    const calls = [];
    const rpc = async (name, args) => { calls.push({ name, args }); return { data: { status: 'rejected', error_code: code }, error: null }; };
    await assert.rejects(client.mutateRecord(rpc, pending), error => error.reason === 'conflict' && error.code === code);
    await assert.rejects(client.mutateRecord(rpc, pending), error => error.reason === 'conflict');
    assert.deepEqual(plain(calls[0].args), plain(calls[1].args));
  }
});

test('stale displayed Source version asks for a fresh read without following latest source qualification', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record({ source_refs: [EVIDENCE] })]));
  f.click('读取来源: ' + EVIDENCE);
  await f.respond(1, { status: 'ok', available: false, record_version: 3, unavailable_reason: 'stale_record_version' });
  assert.ok(f.text().includes('刷新并核对')); assert.equal(f.calls.length, 2);
  f.click('读取来源: ' + EVIDENCE);
  await f.respond(2, { status: 'ok', available: true, record_version: 3, content: 'Unmatched latest source' });
  assert.ok(!f.text().includes('Unmatched latest source')); assert.ok(f.text().includes('读取结果未知'));
});

test('development detail passes source_kind so same UUID in different stores cannot select the wrong object', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount());
  await f.respond(0, page([developmentRecord({ relations: { follows: [ID] } })]));
  f.click('读取关联记录: ' + ID);
  assert.equal(f.calls[1].args.p_input.source_kind, 'development');
  await f.respond(1, page([record({ context_id: OTHER, source_kind: 'canonical', source_semantics: 'canonical_record', title: 'Wrong namespace body' })]));
  assert.ok(!f.text().includes('Wrong namespace body')); assert.ok(f.text().includes('读取结果未知'));
});

test('retained-history query hit exposes the matched old version without replacing the latest body', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount()); await f.respond(0, page());
  f.check('包含旧版本及待核对内容', true); f.change('搜索当前视图', 'OLDER TERM'); f.submit('搜索');
  const index = f.calls.length - 1;
  const previous = developmentRecord({ version: 1, matched_record_version: 1, content: 'OLDER TERM retained body', record_currentness: 'HISTORY', authoritative: false });
  await f.respond(index, page([developmentRecord({ content: 'LATEST BODY DOES NOT CONTAIN THE QUERY', match_source: 'retained_history', matched_revisions: [previous] })]));
  assert.ok(f.text().includes('历史版本命中（非当前）'));
  const bodies = f.nodes('pre').map(node => node.props.children);
  assert.ok(bodies.includes('LATEST BODY DOES NOT CONTAIN THE QUERY')); assert.ok(bodies.includes('OLDER TERM retained body'));
  assert.equal(f.nodes('article').length, 1); assert.ok(f.text().includes('版本 1'));
  assert.ok(!f.calls.some(call => /mutate|organization_set/.test(call.name)));
});

test('local domain suggestions remain source-bound candidates until explicit apply AND Receipt-backed save', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await f.respond(0, page([record({ domains: ['interest'], authority: 'user_explicit', content: '保存用途：工作交付。\n我会明天提交草稿。' })]));
  f.click('查看领域建议'); assert.ok(f.text().includes('本地候选建议')); assert.ok(f.text().includes('保存用途：工作交付'));
  const domainInput = label => f.nodes('input', f.nodes('label').find(node => f.text(node) === label))[0];
  assert.equal(domainInput('工作').props.checked, false); assert.equal(f.calls.length, 1);
  f.click('采用这些建议'); assert.equal(domainInput('工作').props.checked, true); assert.equal(domainInput('兴趣').props.checked, true);
  assert.equal(f.calls.length, 1, 'apply changes local checkboxes only');
  assert.ok(!f.nodes('button').some(node => /生成任务|创建决策/.test(f.text(node))));
  const save = f.submit('保存领域'); await f.untilCalls(2);
  assert.equal(f.calls[1].name, 'clued_imprint_organization_set_v1'); assert.deepEqual(plain(f.calls[1].args.p_input.domains), ['work', 'interest']);
  await f.respond(1, { status: 'committed', receipt_id: 'suggestion-reviewed', supplemental: { organization: { record_id: ID, domains: ['work', 'interest'], version: 1 } } }); await save;
  await f.respond(2, page([record({ domains: ['work', 'interest'], organization_version: 1 })]));
  assert.ok(!f.text().includes('本地候选建议')); assert.ok(!f.calls.some(call => call.name === 'clued_user_record_mutate'));
});

test('suggestions abstain from title/keyword classification and disappear on selection changes', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record({ title: 'English movie', content: '一份英语电影清单。' })]));
  f.click('查看领域建议'); assert.ok(f.text().includes('没有足够明确的用途依据')); assert.equal(f.calls.length, 1);
  f.click('学习'); assert.ok(!f.text().includes('领域候选建议')); await f.respond(1, page());
  f.click('全部'); await f.respond(2, page([record()])); assert.ok(!f.text().includes('本地候选建议'));
});

test('All default browse includes terminal latest bodies without reopening them', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await f.respond(0, page([record({ lifecycle_status: 'completed', record_currentness: 'HISTORY', authoritative: false,
    record_type: 'task', closure_summary: 'Verified completion', content: 'TERMINAL LATEST BODY' })]));
  assert.equal(f.calls[0].args.p_input.include_history, false); assert.ok(f.text().includes('TERMINAL LATEST BODY'));
  assert.ok(f.text().includes('已完成')); assert.ok(f.text().includes('历史')); assert.equal(f.nodes('input').filter(node => node.props.type === 'datetime-local').length, 0);
});

test('explicit qualified browse keeps valid notes when other current content is withheld, never claiming completeness', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await f.respond(0, { ...page([record({ title: 'Qualified note', content: 'QUALIFIED NOTE BODY', authoritative: true })]),
    selection_complete: false, withheld_record_count: 1, current_projection_unavailable: true });
  assert.ok(f.text().includes('QUALIFIED NOTE BODY')); assert.ok(f.text().includes('部分内容待核对'));
  assert.ok(!f.text().includes('本次查询结果已显示')); assert.ok(!f.text().includes('没有匹配'));
  f.click('刷新'); await f.respond(1, { ...page([]), selection_complete: false, withheld_record_count: 1 });
  assert.ok(f.text().includes('部分内容待核对')); assert.ok(!f.text().includes('没有匹配'));
});

test('strict Task projection and missing/unrecognized browse semantics cannot bypass unknown currentness', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page()); f.click('任务');
  await f.respond(1, { ...page([record({ record_type: 'task' })], null, 'strict_current'), selection_complete: false, current_projection_unavailable: true });
  assert.ok(f.text().includes('读取结果未知')); assert.equal(f.nodes('article').length, 0);
  const client = modules().load('imprint-client.ts');
  for (const semantics of [undefined, 'unverified_other_mode']) {
    const data = { ...page([record()]), read_semantics: semantics, selection_complete: false, current_projection_unavailable: true };
    await assert.rejects(client.readImprints(async () => ({ data, error: null }), { view: 'all', scope: 'all', query: '', include_history: false, cursor: 0, limit: 30 }), error => error.reason === 'unknown');
  }
});

test('Dev candidates retain original qualification while Canonical unknown bodies require explicit diagnostic history', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount());
  await f.respond(0, { ...page([developmentRecord({ content: 'READABLE DEV CANDIDATE' })]), selection_complete: false, withheld_record_count: 1 });
  assert.ok(f.text().includes('READABLE DEV CANDIDATE')); assert.ok(f.text().includes('候选内容')); assert.ok(f.text().includes('部分内容待核对'));
  f.check('包含旧版本及待核对内容', true);
  const uncertain = record({ id: EVIDENCE, context_id: OTHER, source_kind: 'canonical', source_semantics: 'canonical_record',
    canonical_scope: 'project:' + PROJECT, record_currentness: 'UNKNOWN', authoritative: false, content: 'DIAGNOSTIC CANONICAL BODY' });
  await f.respond(1, { ...page([developmentRecord({ content: 'READABLE DEV CANDIDATE' }), uncertain]), selection_complete: false });
  assert.ok(f.text().includes('DIAGNOSTIC CANONICAL BODY')); assert.ok(f.text().includes('当前有效记录')); assert.equal(f.nodes('article').length, 2);
  const client = modules().load('imprint-client.ts');
  await assert.rejects(client.readImprints(async () => ({ data: page([uncertain]), error: null }), { view: 'all', scope: 'all', query: '', include_history: false, limit: 30, cursor: 0 }, OTHER), error => error.reason === 'unknown');
});


test('Immediate authoritative context is a qualified Record badge, not a ninth view or a promotion of candidates',async t=>{
 const f=fixture();t.after(()=>f.unmount());await f.respond(0,page([record({authoritative:true,source_semantics:'canonical_record'})]));
 assert.ok(f.text().includes('即时权威上下文'));assert.equal(f.nodes('button').filter(n=>n.props.role==='tab').length,8);
 f.click('刷新');await f.respond(1,page([record({authoritative:false,record_currentness:'HISTORY'})]));
 assert.ok(!f.text().includes('即时权威上下文'));assert.ok(f.text().includes('历史'));
});
