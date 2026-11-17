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
  await f.respond(2, { status: 'ok', available: true, complete: true, record_id: ID, record_version: 2,
    authoritative: false, current_input_eligible: false, evidence: { id: EVIDENCE }, content: 'Original meeting\n<script>not executable</script>', segment: null });
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
  const historical = { status: 'ok', available: true, complete: true, record_id: ID, evidence: { id: EVIDENCE },
    record_version: 2, content: 'WITHDRAWN OLD SOURCE', evidence_status: 'withdrawn',
    source_semantics: 'historical_evidence', authoritative: false, current_input_eligible: false };
  await f.respond(1, historical); assert.ok(!f.text().includes('WITHDRAWN OLD SOURCE'));
  f.check('包含旧版本及待核对内容', true); await f.respond(2, page([record({ source_refs: [EVIDENCE] })]));
  f.click('读取来源: ' + EVIDENCE); assert.equal(f.calls[3].args.p_input.include_history, true);
  await f.respond(3, historical); assert.ok(f.text().includes('WITHDRAWN OLD SOURCE')); assert.ok(f.text().includes('不能作为当前输入')); assert.ok(f.text().includes('已撤回'));
});

test('English controls and scope/full-text limitations are actually rendered in English', async t => {
  const f = fixture(session('owner'), 'en'); t.after(() => f.unmount()); await f.respond(0, page());
  assert.deepEqual(f.nodes('button').filter(n => n.props.role === 'tab').map(f.text), ['All', 'Tasks', 'Decisions', 'Daily life', 'Work', 'Learning', 'Creation', 'Interests']);
  assert.ok(f.text().includes('saved titles, bodies and readable source text'));
  assert.ok(f.text().includes('previously unsaved bodies cannot be recovered'));
  assert.ok(f.text().includes('Unclassified content'));
});

const developmentRecord = extra => record({ context_id: OTHER, source_kind: 'development', source_semantics: 'development_context',
  canonical_scope: 'project:' + PROJECT, scope: 'project:' + PROJECT, record_type: 'annotation', lifecycle_status: 'ACTIVE',
  record_schema_version: null, authority: 'candidate', qualification: 'candidate', authoritative: false, record_currentness: 'UNKNOWN',
  content: '{"title":"Engineering candidate","proposal":"Try blue"}', type_fields: {}, relations: {}, source_refs: [EVIDENCE], ...extra });

const retainedMatch = (version = 1, extra = {}) => ({
  id: ID, scope: 'global', context_id: null, source_kind: 'canonical', version, matched_record_version: version,
  snippet: 'OLD retained body excerpt', updated_at: '2026-10-17T06:00:00Z', record_currentness: 'HISTORY',
  authoritative: false, current_input_eligible: false, full_body_included: false, ...extra,
});
const sourceMatch = (historical = false, extra = {}) => ({
  evidence_id: EVIDENCE, record_id: ID, record_version: 3, source_record_version: historical ? 1 : 3,
  historical_record_version: historical ? 1 : null, scope: 'global', context_id: null,
  snippet: 'SOURCE saved original excerpt', record_updated_at: '2026-10-17T06:00:00Z',
  source_semantics: historical ? 'historical_evidence' : 'linked_evidence', evidence_status: 'retained',
  authoritative: false, current_input_eligible: false, full_body_included: false, ...extra,
});
const searchable = (revisions = [], sources = [], extra = {}) => record({
  version: 3, content: 'LATEST body stays separate', authoritative: false, source_semantics: 'canonical_record',
  matched_revisions: revisions, matched_revision_count: revisions.length, matched_revisions_truncated: false,
  matched_sources: sources, matched_source_count: sources.length, matched_sources_truncated: false, ...extra,
});
const revisionResult = (version = 1, extra = {}) => ({
  status: 'ok', available: true, complete: true, record_id: ID, record_version: 3, historical_record_version: version,
  source_kind: 'canonical', scope: 'global', context_id: null, authoritative: false, current_input_eligible: false,
  record: record({ version, content: 'OLD full retained body ' + version, record_currentness: 'HISTORY',
    authoritative: false, current_input_eligible: false, updated_at: '2026-10-17T06:00:00Z', source_refs: [EVIDENCE] }),
  ...extra,
});
async function searchedFixture(t, row, contextId) {
  const f = fixture(session('owner'), 'zh-CN', contextId); t.after(() => f.unmount());
  await f.respond(0, page());
  f.check('包含旧版本及待核对内容', true); await f.respond(1, page());
  f.change('搜索当前视图', 'OLD'); f.submit('搜索'); await f.respond(2, page([row]));
  assert.equal(f.calls[2].args.p_input.include_history, true); assert.equal(f.calls[2].args.p_input.query, 'OLD');
  return f;
}

test('retained Canonical history reads exact old version while the latest complete body remains separate', async t => {
  const f = await searchedFixture(t, searchable([retainedMatch()]));
  assert.ok(f.text().includes('LATEST body stays separate')); assert.ok(f.text().includes('OLD retained body excerpt'));
  assert.ok(!f.text().includes('OLD full retained body')); assert.ok(f.text().includes('历史，非当前'));
  f.click('读取这个版本的完整正文: 1');
  assert.equal(f.calls[3].name, 'clued_imprint_revision_read_v1');
  assert.deepEqual(plain(f.calls[3].args.p_input), { record_id: ID, record_version: 3, historical_record_version: 1, scope: 'global' });
  await f.respond(3, revisionResult());
  assert.ok(f.text().includes('OLD full retained body 1')); assert.ok(f.text().includes('LATEST body stays separate'));
  assert.equal(f.nodes('script').length, 0);
  f.click('读取来源: ' + EVIDENCE);
  assert.deepEqual(plain(f.calls[4].args.p_input), { record_id: ID, record_version: 3, historical_record_version: 1,
    evidence_id: EVIDENCE, include_history: true });
  await f.respond(4, { status: 'ok', available: true, complete: true, record_id: ID, record_version: 3, source_record_version: 1,
    historical_record_version: 1, source_semantics: 'historical_evidence', authoritative: false, current_input_eligible: false,
    evidence_status: 'retained', content: 'SOURCE full old body', evidence: { id: EVIDENCE } });
  assert.ok(f.text().includes('SOURCE full old body')); assert.ok(f.text().includes('不能作为当前输入'));
  assert.ok(f.calls.every(call => !/mutate|set|promote/.test(call.name)), 'reading history never writes or promotes it');
});

test('source-only historical matches request both current-card and selected-source versions', async t => {
  const f = await searchedFixture(t, searchable([], [sourceMatch(true)]));
  assert.ok(f.text().includes('来源全文命中')); assert.ok(f.text().includes('历史来源'));
  assert.ok(!f.nodes('section').some(node => node.props['aria-label'] === '历史版本命中'));
  f.click('读取来源: ' + EVIDENCE);
  assert.equal(f.calls[3].args.p_input.record_version, 3); assert.equal(f.calls[3].args.p_input.historical_record_version, 1);
  await f.respond(3, { status: 'ok', available: false, unavailable_reason: 'stale_record_version' });
  assert.ok(f.text().includes('对象已有更新')); assert.ok(!f.text().includes('SOURCE full'));
});

test('complete historical read rejects mismatched identity, scope, version, context or authority', async t => {
  for (const bad of [
    { record_version: 2 }, { historical_record_version: 2 }, { record_id: OTHER }, { scope: 'project:' + PROJECT },
    { context_id: OTHER }, { authoritative: true }, { current_input_eligible: true }, { complete: false },
    { record: { ...revisionResult().record, id: OTHER } }, { record: { ...revisionResult().record, version: 2 } },
    { record: { ...revisionResult().record, authoritative: true } },
  ]) {
    const f = await searchedFixture(t, searchable([retainedMatch()]));
    f.click('读取这个版本的完整正文: 1'); await f.respond(3, revisionResult(1, bad));
    assert.ok(!f.text().includes('OLD full retained body')); assert.ok(f.text().includes('读取结果未知'));
  }
});

test('malformed query hits fail as unknown before snippets, hidden counts or a forged namespace render', async t => {
  for (const bad of [
    { matched_revisions: [retainedMatch(1, { id: OTHER, snippet: 'PRIVATE forged hit' })] },
    { matched_revisions: [retainedMatch(1, { source_kind: 'development', snippet: 'PRIVATE forged hit' })] },
    { matched_revisions: [retainedMatch(1, { context_id: OTHER, snippet: 'PRIVATE forged hit' })] },
    { matched_revisions: [retainedMatch(1, { version: 3, snippet: 'PRIVATE forged hit' })] },
    { matched_revisions: [retainedMatch(1, { content: 'PRIVATE forged hit'.repeat(10000) })] },
    { matched_revisions: [retainedMatch(1, { body: 'PRIVATE forged hit' })] },
    { matched_revision_count: 999, matched_revisions_truncated: false },
    { matched_sources: [sourceMatch(true, { record_version: 2, snippet: 'PRIVATE forged hit' })] },
    { matched_sources: [sourceMatch(true, { historical_record_version: 2, snippet: 'PRIVATE forged hit' })] },
    { matched_sources: [sourceMatch(true, { current_input_eligible: true, snippet: 'PRIVATE forged hit' })] },
  ]) {
    const f = await searchedFixture(t, searchable([retainedMatch()], [], bad));
    assert.equal(f.nodes('article').length, 0); assert.ok(f.text().includes('读取结果未知'));
    assert.ok(!f.text().includes('PRIVATE forged hit')); assert.ok(!f.text().includes('999'));
  }
});

test('newer historical reads win and late responses cannot repopulate after account or filter changes', async t => {
  const f = await searchedFixture(t, searchable([retainedMatch(1), retainedMatch(2)]));
  f.click('读取这个版本的完整正文: 1'); f.click('读取这个版本的完整正文: 2');
  await f.respond(4, revisionResult(2)); await f.respond(3, revisionResult(1));
  assert.ok(f.text().includes('OLD full retained body 2')); assert.ok(!f.text().includes('OLD full retained body 1'));
  f.click('读取这个版本的完整正文: 1'); f.setSession(session('another'));
  await f.respond(5, revisionResult(1));
  assert.ok(!f.text().includes('OLD full retained body')); assert.ok(!f.text().includes('LATEST body stays separate'));
  await f.respond(6, page([searchable([retainedMatch()])]));
  f.click('读取这个版本的完整正文: 1'); f.check('包含旧版本及待核对内容', false);
  await f.respond(7, revisionResult()); assert.ok(!f.text().includes('OLD full retained body'));
  await f.respond(8, page()); assert.equal(f.nodes('article').length, 0);
});

test('historical full read carries exact context and cannot finish in a replacement directory', async t => {
  const row = searchable([retainedMatch(1, { scope: 'project:' + PROJECT, context_id: OTHER })], [],
    { canonical_scope: 'project:' + PROJECT, scope: 'project:' + PROJECT, source_kind: 'canonical', context_id: OTHER });
  const f = await searchedFixture(t, row, OTHER);
  f.click('读取这个版本的完整正文: 1');
  assert.equal(f.calls[3].args.p_input.context_id, OTHER); assert.equal(f.calls[3].args.p_input.scope, 'project:' + PROJECT);
  f.setDevelopmentContext(PROJECT);
  await f.respond(3, revisionResult(1, { context_id: OTHER, scope: 'project:' + PROJECT,
    record: { ...revisionResult().record, scope: 'project:' + PROJECT, canonical_scope: 'project:' + PROJECT } }));
  assert.ok(!f.text().includes('OLD full retained body')); assert.equal(f.calls[4].args.p_input.context_id, PROJECT);
});

test('over-limit full reads report unavailable and exact partial counts stay honest', async t => {
  const row = searchable([retainedMatch()], [], { matched_revision_count: 23, matched_revisions_truncated: true });
  const f = await searchedFixture(t, row);
  assert.ok(f.text().includes('已显示 1 个历史命中，共 23 个'));
  f.click('读取这个版本的完整正文: 1');
  await f.respond(3, { status: 'ok', available: false, complete: false, unavailable_reason: 'revision_content_exceeds_read_limit' });
  assert.ok(f.text().includes('超过单次完整读取上限')); assert.ok(!f.text().includes('OLD full retained body'));
});

test('a non-authoritative history query does not expose the current-task due-date write control', async t => {
  const f = await searchedFixture(t, searchable([retainedMatch()], [], { record_type: 'task', type_fields: { execution_bucket: 'later' } }));
  assert.equal(f.nodes('input').filter(node => node.props.type === 'datetime-local').length, 0);
});

test('source full reads reject wrong identities, incomplete bodies and over-limit UTF8 before rendering', async t => {
  for (const bad of [
    { record_id: OTHER }, { evidence: { id: OTHER } }, { evidence: null }, { complete: false }, { complete: undefined },
    { content: 'PRIVATE invalid source'.repeat(10000) }, { content: '界'.repeat(50000) },
    { authoritative: true }, { current_input_eligible: true },
  ]) {
    const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page([record({ source_refs: [EVIDENCE] })]));
    f.click('读取来源: ' + EVIDENCE);
    await f.respond(1, { status: 'ok', available: true, complete: true, record_id: ID, record_version: 2,
      evidence: { id: EVIDENCE }, authoritative: false, current_input_eligible: false, content: 'PRIVATE invalid source', ...bad });
    assert.ok(f.text().includes('读取结果未知')); assert.ok(!f.text().includes('PRIVATE invalid source'));
    assert.ok(!f.text().includes('界界界'));
  }
});

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

const associationSource = extra => record({ title: '客户交付说明', content: '周五交Logo二稿，沿用原任务。',
  source_semantics: 'canonical_record', authoritative: true, associations: [], association_version: 0, association_unavailable_count: 0, ...extra });
const associationTask = extra => record({ id: OTHER, title: '周五交Logo第二版', content: '原任务唯一执行正文。', record_type: 'task',
  source_kind: 'canonical', source_semantics: 'canonical_record', authoritative: true, version: 1, type_fields: { execution_bucket: 'later' }, ...extra });

test('existing-record matching ranks literal evidence without inventing identity or including another scope/candidate/history', () => {
  const m = modules().load('imprint-associations.ts'), source = associationSource(), target = associationTask();
  const other = associationTask({ id: EVIDENCE });
  const matches = m.rankAssociationMatches(source, [target, other, associationTask({ scope: 'profile' }),
    associationTask({ source_kind: 'development' }), associationTask({ record_currentness: 'HISTORY' }),
    associationTask({ authoritative: false })]);
  assert.deepEqual(plain(matches.map(x => [x.record.id, x.reason])), [[OTHER, 'terms'], [EVIDENCE, 'terms']]);
  assert.equal(m.rankAssociationMatches(associationSource({ title: '英文电影', content: '随手记一下' }), [target]).length, 0);
  assert.equal(m.rankAssociationMatches(associationSource({ content: OTHER }), [target])[0].reason, 'identity');
  assert.equal(m.rankAssociationMatches(associationSource({ content: target.title }), [target])[0].reason, 'title');
  assert.equal(m.canAssociate(associationSource({ association_version: undefined })), false);
  assert.equal(m.canAssociate(associationSource({ lifecycle_status: 'completed' })), false);
});

test('candidate lookup is bounded and honest about pagination, and only uses the existing strict-current readers', async () => {
  const m = modules().load('imprint-associations.ts'), calls = [], source = associationSource();
  const rpc = async (name, { p_input }) => { calls.push([name, p_input]);
    return { data: page([associationTask({ id: p_input.view === 'task' ? OTHER : EVIDENCE, record_type: p_input.view })], p_input.cursor + 30, 'strict_current'), error: null }; };
  const found = await m.findExistingAssociations(rpc, source, '', undefined, { isCurrent: () => true });
  assert.equal(found.complete, false); assert.equal(calls.length, 4);
  assert.ok(calls.every(([name, input]) => name === 'clued_imprint_read_v1' && input.scope === source.scope && input.include_history === false));
  assert.deepEqual(calls.map(([,input]) => [input.view,input.cursor]), [['task',0],['task',30],['decision',0],['decision',30]]);
  await assert.rejects(m.findExistingAssociations(rpc, source, '', undefined, { isCurrent: () => false }), e => e.reason === 'unknown');
});

test('actual picker previews the existing body, persists only a pointer, and reuses the exact lost-response request', async t => {
  const f = fixture(); t.after(() => f.unmount()); const source = associationSource(), target = associationTask();
  await f.respond(0, page([source])); f.click('查找已有任务或决策');
  await f.respond(1, page([target], null, 'strict_current')); await f.respond(2, page([], null, 'strict_current'));
  assert.ok(f.text().includes(target.title)); assert.equal(f.calls.filter(x => /mutate|set_v1/.test(x.name)).length, 0);
  f.click('核对这条记录'); assert.ok(f.text().includes(target.content));
  f.click('确认关联'); await f.respond(3, page([target], null, 'strict_current')); await f.untilCalls(5);
  const pending = plain(f.calls[4].args); assert.equal(f.calls[4].name, 'clued_imprint_association_set_v1');
  assert.equal(pending.p_input.record_id, ID); assert.equal(pending.p_input.target_id, OTHER);
  assert.equal(pending.p_input.record_version, source.version); assert.equal(pending.p_input.target_version, 1);
  assert.equal('mutation' in pending.p_input, false); assert.equal('content' in pending.p_input, false);
  await f.fail(4); assert.ok(f.text().includes('本次结果未能确认'));
  f.click('确认关联'); await f.respond(5, page([target], null, 'strict_current')); await f.untilCalls(7);
  assert.deepEqual(plain(f.calls[6].args), pending); assert.equal(f.calls[6].headers.Authorization, 'Bearer fixture-owner');
  await f.respond(6, { status: 'committed', receipt_id: EVIDENCE, supplemental: { association: { record_id: ID, source_kind: 'canonical', version: 1, changed: true } } });
  await f.respond(7, page([associationSource({ association_version: 1, associations: [{ record_id: OTHER, source_kind: 'canonical',
    record_type: 'task', record_version: 1, current_version: 1, title: target.title }] })]));
  assert.ok(f.text().includes('已关联原条目')); assert.ok(f.text().includes(source.content));
  assert.equal(f.calls.filter(x => x.name === 'clued_user_record_mutate').length, 0, 'no duplicate task or source body mutation');
});

test('changed target requires review rather than silently linking a newer version', async t => {
  const f = fixture(); t.after(() => f.unmount()); const target = associationTask();
  await f.respond(0, page([associationSource()])); f.click('查找已有任务或决策');
  await f.respond(1, page([target], null, 'strict_current')); await f.respond(2, page([], null, 'strict_current'));
  f.click('核对这条记录'); f.click('确认关联'); await f.respond(3, page([associationTask({ version: 2 })], null, 'strict_current'));
  assert.ok(f.text().includes('原条目或关联已有更新')); assert.equal(f.calls.length, 4);
});

test('same-title same-body candidates remain distinguishable by original type, ID and version through confirmation', async t => {
  const f = fixture(); t.after(() => f.unmount());
  const first = associationTask(), second = associationTask({ id: EVIDENCE, version: 4 });
  await f.respond(0, page([associationSource()])); f.click('查找已有任务或决策');
  await f.respond(1, page([first, second], null, 'strict_current')); await f.respond(2, page([], null, 'strict_current'));
  const candidates = f.nodes('button').filter(node => f.text(node) === '核对这条记录'); assert.equal(candidates.length, 2);
  assert.ok(f.text().includes(OTHER)); assert.ok(f.text().includes(EVIDENCE)); assert.ok(f.text().includes('已有任务'));
  f.fire(candidates[1], 'onClick');
  const confirmation = f.nodes('section').find(node => node.props['aria-label'] === '确认查阅关联');
  assert.ok(f.text(confirmation).includes(EVIDENCE)); assert.ok(!f.text(confirmation).includes(OTHER));
  assert.ok(f.text(confirmation).includes('版本 4')); assert.ok(f.text(confirmation).includes(second.content));
  f.click('确认关联'); assert.equal(f.calls[3].args.p_input.id, EVIDENCE);
  await f.respond(3, page([second], null, 'strict_current')); await f.untilCalls(5);
  assert.equal(f.calls[4].args.p_input.target_id, EVIDENCE); assert.equal(f.calls[4].args.p_input.target_version, 4);
});

test('associated details recheck exact scope and current eligibility and directly show only that qualified read', async t => {
  const f = fixture(); t.after(() => f.unmount());
  const link = { record_id: OTHER, source_kind: 'canonical', record_type: 'task', record_version: 1, current_version: 1, title: '原任务入口' };
  await f.respond(0, page([associationSource({ associations: [link], association_version: 1 })])); f.click(link.title);
  assert.deepEqual(plain(f.calls[1].args.p_input), { view: 'task', scope: 'global', query: '', include_history: false, limit: 30, cursor: 0, id: OTHER });
  await f.respond(1, page([associationTask({ version: 2, content: 'UPDATED ORIGINAL BODY' })], null, 'strict_current'));
  assert.ok(f.text().includes('UPDATED ORIGINAL BODY')); assert.equal(f.calls.length, 2);
  for (const invalid of [{ scope: 'profile', canonical_scope: 'profile' }, { lifecycle_status: 'completed' }, { record_currentness: 'HISTORY', authoritative: false }]) {
    f.click(link.title);
    await f.respond(f.calls.length - 1, page([associationTask({ ...invalid, content: 'INELIGIBLE TARGET BODY' })], null, 'strict_current'));
    assert.ok(!f.text().includes('INELIGIBLE TARGET BODY'));
  }
  assert.ok(f.calls.slice(1).every(call => call.args.p_input.scope === 'global' && call.args.p_input.include_history === false));
});

test('Context associated details bind canonical namespace and discard a late read after Context switch', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount());
  const link = { record_id: EVIDENCE, source_kind: 'canonical', record_type: 'task', record_version: 1, current_version: 1, title: 'Context原任务入口' };
  const source = associationSource({ context_id: OTHER, environment: 'test', scope: 'project:' + PROJECT, canonical_scope: 'project:' + PROJECT,
    source_kind: 'development', source_semantics: 'development_context', lifecycle_status: 'ACTIVE', record_currentness: 'UNKNOWN', authoritative: false, qualification: 'candidate',
    associations: [link], association_version: 1 });
  await f.respond(0, page([source])); f.click(link.title);
  assert.equal(f.calls[1].args.p_input.scope, source.scope); assert.equal(f.calls[1].args.p_input.source_kind, 'canonical');
  assert.equal(f.calls[1].args.p_input.context_id, OTHER); assert.equal(f.calls[1].args.p_input.include_history, false);
  f.setDevelopmentContext(PROJECT);
  await f.respond(1, page([associationTask({ id: EVIDENCE, context_id: OTHER, scope: source.scope, canonical_scope: source.scope, content: 'LATE OTHER CONTEXT BODY' })], null, 'strict_current'));
  assert.ok(!f.text().includes('LATE OTHER CONTEXT BODY')); assert.equal(f.calls.length, 3);
});

test('late lookup cannot reveal old-account candidates or initiate a mutation after account switch', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await f.respond(0, page([associationSource()])); f.click('查找已有任务或决策');
  f.setSession(session('other')); await f.respond(1, page([associationTask()], null, 'strict_current'));
  await f.respond(2, page([])); assert.ok(!f.text().includes('周五交Logo第二版'));
  assert.equal(f.calls.filter(x => x.name === 'clued_imprint_association_set_v1').length, 0);
  assert.equal(f.calls.length, 3, 'old lookup stops before reading another type');
});

test('Context candidate uses exact context and canonical namespace without promoting the original Raw source', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount());
  const source = associationSource({ source_kind: 'development', source_semantics: 'development_context', authoritative: false,
    context_id: OTHER, environment: 'test', scope: 'project:' + PROJECT, canonical_scope: 'project:' + PROJECT,
    lifecycle_status: 'ACTIVE', record_currentness: 'UNKNOWN', qualification: 'candidate' });
  const target = associationTask({ context_id: OTHER, environment: 'test', scope: 'project:' + PROJECT, canonical_scope: 'project:' + PROJECT });
  await f.respond(0, page([source])); f.click('查找已有任务或决策');
  assert.equal(f.calls[1].args.p_input.context_id, OTHER); assert.equal(f.calls[1].args.p_input.source_kind, 'canonical');
  await f.respond(1, page([target], null, 'strict_current')); await f.respond(2, page([], null, 'strict_current'));
  f.click('核对这条记录'); f.click('确认关联'); await f.respond(3, page([target], null, 'strict_current')); await f.untilCalls(5);
  assert.equal(f.calls[4].args.p_input.source_kind, 'development'); assert.equal(f.calls[4].args.p_input.context_id, OTHER);
  assert.equal(f.calls[4].args.p_input.environment, 'test'); assert.ok(f.text().includes('候选内容'));
  assert.ok(!f.text().includes('即时权威上下文'));
  f.setDevelopmentContext(EVIDENCE); await f.respond(4, { status: 'committed', receipt_id: EVIDENCE,
    supplemental: { association: { record_id: ID, source_kind: 'development', version: 1, changed: true } } });
  assert.ok(!f.text().includes('已关联原条目'));
});

test('removal is an explicit metadata operation; inaccessible links never render stale identities or look absent', async t => {
  const f = fixture(); t.after(() => f.unmount()); const link = { record_id: OTHER, source_kind: 'canonical', record_type: 'task',
    record_version: 1, current_version: 2, title: '原任务现标题' };
  await f.respond(0, page([associationSource({ associations: [link], association_version: 2, association_unavailable_count: 1 })]));
  assert.ok(f.text().includes('部分原有关联目前不可读取或已失效'));
  f.click('取消关联'); assert.equal(f.calls.length, 1); f.click('确认取消关联'); await f.untilCalls(2);
  assert.equal(f.calls[1].name, 'clued_imprint_association_set_v1'); assert.equal(f.calls[1].args.p_input.action, 'remove');
  assert.equal('target_version' in f.calls[1].args.p_input, false); assert.equal(f.calls[1].args.p_input.base_version, 2);
  const model = modules().load('imprint-model.ts');
  assert.equal(model.normalizeRecord(associationSource({ associations: [{ ...link, source_kind: 'development' }] })), null);
  assert.equal(model.normalizeRecord(associationSource({ associations: [link], association_version: undefined })), null);
});

const bulkPlan = (extra = {}) => {
  const value = { status: 'ok', complete: true, authoritative: false, max_batch_size: 100,
  digest: 'a'.repeat(64), rules_version: 'imprint-explicit-local.v2', selection: { scope: 'all' },
  counts: { total: 3, characters: 100, ineligible: 1, protected: 1, needs_review: 0, ready: 1,
    personal: 3, profile: 0, project: 0, current: 3, history: 0, other_currentness: 0,
    automatic_marked: 0, manual_or_unspecified_marked: 1, unmarked: 2, ready_characters: 20, review_characters: 0 },
  items: [{ record_id: ID, record_version: 2, title: 'Existing old note', domains: ['learning'] }],
  review_sample: [], ...extra };
  const { ready, needs_review, ready_characters, review_characters, ...base } = value.counts;
  const classifiable = ready + needs_review;
  const samples = value.review_sample.length || !needs_review ? value.review_sample : [{ record_id: OTHER, title: 'Needs individual review' }];
  return { ...value, inventory_counts: { ...base, classifiable }, ready_characters, review_characters,
    review_sample: samples, page: { cursor: 0, scanned: classifiable, next_cursor: null, complete: true },
    proof: { mac: 'b'.repeat(64), payload: { owner_id: 'owner', selection: value.selection, digest: value.digest,
      rules_version: value.rules_version, cursor: classifiable, classifiable, ready, needs_review, ready_characters, review_characters,
      expires_at: new Date(Date.now() + 3600000).toISOString(), items: value.items.map(({ title, ...item }) => item) } } };
};
const bulkBatch = (extra = {}) => ({ status: 'ok', available: true, batch_id: EVIDENCE, version: 1,
  state: 'running', selection: { scope: 'all' }, rules_version: 'imprint-explicit-local.v2', preview_digest: 'a'.repeat(64),
  items: [{ record_id: ID, record_version: 2, domains: ['learning'], state: 'pending', ordinal: 1,
    receipt_id: null, organization_version: null, undo_receipt_id: null }], ...extra });
const bulkWrite = batch => ({ status: 'committed', receipt_id: OTHER, supplemental: { batch } });

test('bulk preview remains read-only and explicit plan confirmation does not run label mutations', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  assert.ok(f.text().includes('全部自有内容（个人资料、个人记录、项目）'));
  f.click('盘点并预演（不修改内容）'); assert.equal(f.calls[1].name, 'clued_imprint_bulk_preview_v1');
  await f.respond(1, bulkPlan()); await f.untilCalls(3); await f.respond(2, { status: 'ok', available: false });
  assert.ok(f.text().includes('完整盘点 3 条')); assert.ok(f.text().includes('待逐条核对 0')); assert.equal(f.calls.length, 3);
  f.click('确认这1条，保存首批计划'); await f.untilCalls(4);
  assert.equal(f.calls[3].args.p_input.action, 'begin'); assert.equal(f.calls[3].args.p_input.digest, 'a'.repeat(64));
  await f.respond(3, bulkWrite(bulkBatch())); assert.ok(f.text().includes('尚未修改标签')); assert.equal(f.calls.length, 4);
});
test('failed rehearsal bounds timeout retries and rejects invalidation without raw database details', async t => {
  for (const [error, expected] of [
    [{ message: 'canceling statement due to statement timeout', code: '57014' }, '预演超时'],
    [{ message: 'bulk_preview_changed', code: '40001' }, '本轮预演已失效'],
    [{ message: 'bulk_preview_changed', code: 'PT409' }, '本轮预演已失效'],
    [{ message: 'bulk_proof_expired', code: 'PT409' }, '本轮预演已失效'],
  ]) {
    const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
    f.click('盘点并预演（不修改内容）'); f.calls[1].resolve({ data: null, error, status: 500 }); await f.settle();
    if (error.code === '57014') {
      for (let attempt = 0; attempt < 2; attempt++) {
        const next = f.calls.length; await f.untilCalls(next + 1);
        assert.deepEqual(plain(f.calls[next].args), plain(f.calls[1].args));
        f.calls[next].resolve({ data: null, error, status: 500 }); await f.settle();
      }
    }
    assert.ok(f.text().includes(expected)); assert.ok(f.text().includes('没有修改标签'));
    assert.ok(!f.text().includes('完整盘点')); assert.ok(!f.text().includes('57014'));
    assert.ok(!f.text().includes('statement timeout')); assert.equal(f.calls.length, error.code === '57014' ? 4 : 2);
    assert.ok(!f.nodes('button').some(b => f.text(b).includes('保存首批计划')));
    const next = f.calls.length; f.click('读取已保存进度'); await f.respond(next, { status: 'ok', available: false });
    assert.ok(f.text().includes('尚未建立首批计划'));
  }
});

test('bulk preview recovers a later timeout using the unchanged signed page and counts each record once', async () => {
  const { previewBulk } = modules().load('imprint-bulk.ts');
  const first = bulkPlan(), second = bulkPlan();
  for (const value of [first, second]) Object.assign(value.inventory_counts, { total: 4, personal: 4, current: 4, classifiable: 2, unmarked: 3, characters: 120 });
  Object.assign(first.page, { complete: false, next_cursor: 1 });
  Object.assign(first.proof.payload, { classifiable: 2 });
  second.items[0].record_id = OTHER;
  Object.assign(second.page, { cursor: 1, complete: true, next_cursor: null });
  Object.assign(second.proof.payload, { classifiable: 2, cursor: 2, ready: 2, ready_characters: 40,
    items: [first.proof.payload.items[0], { ...first.proof.payload.items[0], record_id: OTHER }] });
  const calls = [], progress = [];
  const result = await previewBulk(async (name, args) => {
    calls.push({ name, args });
    return calls.length === 2 ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      : { data: calls.length === 1 ? first : second, error: null };
  }, { scope: 'all' }, { owner: 'owner', isCurrent: () => true, onProgress: (...values) => progress.push(values) });
  assert.equal(calls.length, 3); assert.equal(calls[1].args, calls[2].args);
  assert.deepEqual(plain(calls[1].args.p_input.proof), plain(first.proof));
  assert.ok(calls.every(call => call.name === 'clued_imprint_bulk_preview_v1'));
  assert.deepEqual(plain(progress), [[1, 2, 1], [2, 2, 2]]);
  assert.equal(result.counts.ready, 2); assert.equal(result.counts.ready_characters, 40);
  assert.deepEqual(plain(result.items.map(item => item.record_id)), [ID, OTHER]);
});

test('bulk preview limits timeout recovery across the entire scan', async () => {
  const { previewBulk } = modules().load('imprint-bulk.ts');
  let calls = 0, scanned = 0;
  await assert.rejects(previewBulk(async () => {
    calls++;
    if (calls % 2) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
    const value = bulkPlan({ items: [], review_sample: [{ record_id: webcrypto.randomUUID(), title: 'Review' }] });
    Object.assign(value.inventory_counts, { total: 10, personal: 10, current: 10, classifiable: 8, unmarked: 9, characters: 200 });
    Object.assign(value.page, { cursor: scanned, scanned: 1, next_cursor: scanned + 1, complete: false });
    value.ready_characters = 0; value.review_characters = 1; scanned++;
    Object.assign(value.proof.payload, { cursor: scanned, classifiable: 8, ready: 0, needs_review: scanned, ready_characters: 0, review_characters: scanned, items: [] });
    return { data: value, error: null };
  }, { scope: 'all' }, { owner: 'owner', isCurrent: () => true }), failure => failure.code === 'canceling statement due to statement timeout');
  assert.equal(calls, 13); assert.equal(scanned, 6);
});

test('stopping a preview during timeout backoff prevents another request', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  f.click('盘点并预演（不修改内容）');
  f.calls[1].resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }); await f.settle();
  f.click('停止预演'); await new Promise(resolve => setTimeout(resolve, 600)); await f.settle();
  assert.equal(f.calls.length, 2); assert.ok(!f.text().includes('完整盘点'));
  assert.ok(!f.nodes('button').some(b => f.text(b).includes('保存首批计划')));
});

test('bulk preview does not retry transport, unrelated serialization or message-only timeouts', async () => {
  const { previewBulk } = modules().load('imprint-bulk.ts');
  for (const error of [{ code: '40001', message: 'unrelated_serialization_failure' },
    { code: 'PT500', message: 'canceling statement due to statement timeout' }, { code: 'PT409', message: 'bulk_proof_expired' }]) {
    let calls = 0;
    await assert.rejects(previewBulk(async () => { calls++; return { data: null, error }; },
      { scope: 'all' }, { owner: 'owner', isCurrent: () => true }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(previewBulk(async () => { calls++; throw Error('network interrupted'); },
    { scope: 'all' }, { owner: 'owner', isCurrent: () => true }));
  assert.equal(calls, 1);
});
test('bulk unknown write never retries automatically; resume reconciles durable progress before another step', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  f.click('读取已保存进度'); await f.respond(1, bulkBatch()); f.click('继续处理首批');
  await f.respond(2, bulkBatch()); await f.untilCalls(4);
  assert.equal(f.calls[3].args.p_input.action, 'advance'); await f.fail(3);
  assert.equal(f.calls.length, 4); assert.ok(f.text().includes('结果尚未确认'));
  f.click('读取已保存进度'); assert.equal(f.calls[4].name, 'clued_imprint_bulk_status_v1');
  await f.respond(4, bulkBatch({ version: 2, state: 'completed', items: [{ ...bulkBatch().items[0], state: 'applied', organization_version: 1, receipt_id: OTHER }] }));
  assert.ok(f.text().includes('已补标签 1')); assert.ok(f.text().includes('撤销本批已补标签')); assert.equal(f.calls.length, 5);
});
test('bulk scope/context/account changes fence late previews and prevent the next write', async t => {
  const f = fixture(session('owner'), 'zh-CN', OTHER); t.after(() => f.unmount()); await f.respond(0, page());
  f.click('盘点并预演（不修改内容）'); assert.equal(f.calls[1].args.p_input.context_id, OTHER);
  f.setDevelopmentContext(EVIDENCE); await f.respond(1, bulkPlan());
  assert.ok(!f.text().includes('Existing old note')); assert.equal(f.calls.length, 3);
  await f.respond(2, page()); f.click('读取已保存进度'); await f.respond(3, bulkBatch());
  f.click('继续处理首批'); f.setSession(session('replacement'));
  await f.respond(4, bulkBatch()); assert.equal(f.calls.length, 6, 'only the replacement list read was added');
  assert.ok(!f.text().includes('已补标签 1')); assert.equal(f.calls.filter(c => c.name === 'clued_imprint_bulk_mutate_v1').length, 0);
});
test('zero and malformed bulk previews cannot fabricate success or expose a write control', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  f.click('盘点并预演（不修改内容）'); await f.respond(1, bulkPlan({ counts: { ...bulkPlan().counts, total: 1, personal: 1, current: 1,
    characters: 20, ineligible: 0, protected: 0, needs_review: 1, ready: 0, manual_or_unspecified_marked: 0, unmarked: 1, ready_characters: 0, review_characters: 20 }, items: [] }));
  await f.respond(2, { status: 'ok', available: false }); assert.ok(f.text().includes('没有可可靠自动归类'));
  assert.ok(!f.nodes('button').some(b => f.text(b).includes('保存首批计划')));
  f.click('盘点并预演（不修改内容）'); await f.respond(3, bulkPlan({ items: [bulkPlan().items[0], bulkPlan().items[0]] }));
  assert.ok(f.text().includes('预演未完成')); assert.ok(!f.text().includes('Existing old note'));
});
test('a later failed batch-status read invalidates an earlier empty result before enabling begin', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  f.click('读取已保存进度'); await f.respond(1, { status: 'ok', available: false });
  assert.ok(f.text().includes('尚未建立首批计划'));
  f.click('盘点并预演（不修改内容）'); await f.respond(2, bulkPlan()); await f.untilCalls(4); await f.fail(3);
  assert.ok(f.text().includes('预演未完成')); assert.ok(!f.text().includes('尚未建立首批计划'));
  const confirm = f.nodes('button').find(b => f.text(b).includes('保存首批计划'));
  assert.ok(!confirm || confirm.props.disabled);
});
test('selection replacement during the write digest prevents dispatch from the unmounted batch panel', async t => {
  let resumeDigest;
  const gate = new Promise(resolve => { resumeDigest = resolve; });
  const crypto = { randomUUID: () => webcrypto.randomUUID(), subtle: { async digest(...args) { await gate; return webcrypto.subtle.digest(...args); } } };
  const f = fixture(session('owner'), 'zh-CN', undefined, { crypto }); t.after(() => { f.unmount(); resumeDigest(); });
  await f.respond(0, page()); f.click('盘点并预演（不修改内容）'); await f.respond(1, bulkPlan());
  await f.respond(2, { status: 'ok', available: false }); f.click('确认这1条，保存首批计划');
  f.change('查询范围', 'global'); resumeDigest(); await f.settle();
  assert.equal(f.calls.filter(c => c.name === 'clued_imprint_bulk_mutate_v1').length, 0);
});

function bulkTwoPages() {
  const completed = bulkPlan({ counts: { ...bulkPlan().counts, total: 4, personal: 4, current: 4, unmarked: 3,
    ready: 1, needs_review: 1, review_characters: 40 }, review_sample: [{ record_id: OTHER, title: 'Needs individual review' }] });
  const first = { ...completed, review_sample: [], ready_characters: 20, review_characters: 0,
    page: { cursor: 0, scanned: 1, next_cursor: 1, complete: false }, proof: { ...completed.proof,
      payload: { ...completed.proof.payload, cursor: 1, needs_review: 0, review_characters: 0 } } };
  const last = { ...completed, items: [], ready_characters: 0, review_characters: 40,
    page: { cursor: 1, scanned: 1, next_cursor: null, complete: true } };
  return [first, last];
}
test('paged preview requires continuous full coverage and carries the final server proof into begin', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  const [first, last] = bulkTwoPages(); f.click('盘点并预演（不修改内容）'); await f.respond(1, first);
  assert.ok(f.text().includes('已预演 1/2')); assert.ok(!f.text().includes('完整盘点'));
  assert.ok(!f.nodes('button').some(b => f.text(b).includes('保存首批计划')));
  assert.deepEqual(plain(f.calls[2].args.p_input.proof), first.proof);
  await f.respond(2, last); await f.respond(3, { status: 'ok', available: false });
  assert.ok(f.text().includes('完整盘点 4 条')); assert.ok(f.text().includes('待逐条核对 1'));
  f.click('确认这1条，保存首批计划'); await f.untilCalls(5);
  assert.deepEqual(plain(f.calls[4].args.p_input.proof), last.proof);
  assert.equal(f.calls[4].args.p_input.items.length, 1);
});
test('bounded multi-source pages accumulate exact coverage and pass only the final signed plan to begin', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  const rows = Array.from({ length: 19 }, (_, i) => ({ record_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    record_version: 1, title: 'Synthetic page row', domains: ['learning'] }));
  const completed = bulkPlan({ items: rows, counts: { ...bulkPlan().counts, total: 19, characters: 380,
    ineligible: 0, protected: 0, personal: 19, current: 19, manual_or_unspecified_marked: 0,
    unmarked: 19, ready: 19, ready_characters: 380 } });
  const first = { ...completed, items: rows.slice(0, 16), ready_characters: 320,
    page: { cursor: 0, scanned: 16, next_cursor: 16, complete: false }, proof: { ...completed.proof,
      payload: { ...completed.proof.payload, cursor: 16, ready: 16, ready_characters: 320,
        items: completed.proof.payload.items.slice(0, 16) } } };
  const last = { ...completed, items: rows.slice(16), ready_characters: 60,
    page: { cursor: 16, scanned: 3, next_cursor: null, complete: true } };
  f.click('盘点并预演（不修改内容）'); assert.equal(f.calls[1].args.p_input.page_size, 16);
  await f.respond(1, first); assert.ok(f.text().includes('已预演 16/19'));
  assert.ok(!f.nodes('button').some(b => f.text(b).includes('保存首批计划')));
  assert.equal(f.calls[2].args.p_input.page_size, 16);
  await f.respond(2, last); await f.respond(3, { status: 'ok', available: false });
  assert.ok(f.text().includes('完整盘点 19 条'));
  f.click('确认这19条，保存首批计划'); await f.untilCalls(5);
  assert.deepEqual(plain(f.calls[4].args.p_input.proof), completed.proof);
  assert.equal(f.calls[4].args.p_input.items.length, 19);
});

test('an oversized or nonprogressing multi-source page remains incomplete with no confirmation', async t => {
  for (const scanned of [0, 17]) {
    const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
    const rows = Array.from({ length: scanned }, (_, i) => ({ record_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      record_version: 1, domains: ['learning'] }));
    const invalid = bulkPlan({ items: rows, counts: { ...bulkPlan().counts, total: 20, characters: 400,
      ineligible: 0, protected: 0, personal: 20, current: 20, manual_or_unspecified_marked: 0,
      unmarked: 20, ready: 20, ready_characters: 400 } });
    invalid.page = { cursor: 0, scanned, next_cursor: scanned, complete: false };
    f.click('盘点并预演（不修改内容）'); await f.respond(1, invalid);
    assert.ok(f.text().includes('预演未完成')); assert.ok(!f.text().includes('完整盘点'));
    assert.ok(!f.nodes('button').some(b => f.text(b).includes('保存首批计划')));
    assert.equal(f.calls.length, 2);
  }
});

test('a missing, duplicated, drifting or forged-complete page invalidates all accumulated confirmation', async t => {
  for (const mode of ['transport', 'duplicate', 'digest', 'counts', 'proof', 'cursor']) {
    const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page()); const [first, original] = bulkTwoPages();
    f.click('盘点并预演（不修改内容）'); await f.respond(1, first);
    const last = JSON.parse(JSON.stringify(original));
    if (mode === 'transport') await f.fail(2);
    else {
      if (mode === 'duplicate') last.review_sample[0].record_id = ID;
      if (mode === 'digest') last.digest = 'c'.repeat(64);
      if (mode === 'counts') last.inventory_counts.characters++;
      if (mode === 'proof') last.proof.payload.ready++;
      if (mode === 'cursor') last.page.cursor = 10;
      await f.respond(2, last);
    }
    assert.ok(f.text().includes('预演未完成'), mode); assert.ok(!f.text().includes('完整盘点'), mode);
    assert.ok(!f.nodes('button').some(b => f.text(b).includes('保存首批计划')), mode);
    assert.equal(f.calls.length, 3, mode);
  }
});
test('stopping or changing account during a classification page cannot fetch a following page or create a batch', async t => {
  for (const stop of [true, false]) {
    const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page()); const [first, last] = bulkTwoPages();
    f.click('盘点并预演（不修改内容）'); await f.respond(1, first);
    if (stop) f.click('停止预演'); else f.setSession(session('next-owner'));
    await f.respond(2, last);
    assert.equal(f.calls.filter(c => c.name === 'clued_imprint_bulk_status_v1' || c.name === 'clued_imprint_bulk_mutate_v1').length, 0);
    assert.ok(!f.text().includes('完整盘点'));
    if (stop) assert.ok(f.text().includes('已停止预演，没有修改标签'));
  }
});
test('restoring the shared batch displays its original scope rather than the current preview scope', async t => {
  const f = fixture(); t.after(() => f.unmount()); await f.respond(0, page());
  f.change('查询范围', 'global'); await f.respond(1, page()); f.click('读取已保存进度');
  await f.respond(2, bulkBatch({ selection: { scope: 'project:' + PROJECT } }));
  assert.ok(f.text().includes('预演范围：个人记录')); assert.ok(f.text().includes('原批次范围：Design project'));
});
