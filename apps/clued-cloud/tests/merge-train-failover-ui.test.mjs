// Automatic ci-admission takeover page (/bindings/failover, migration
// 20261031090000, DESIGN.md §41.6a, Task a3701d3d) under controlled
// hooks/auth/RPC; no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const PAGE = compile('../app/bindings/failover/page.tsx');

function fixture(compiled) {
  const hooks = [], effects = [], calls = [], fetches = [];
  let cursor = 0, authCallback, root;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useEffect(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i];
      hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); } },
  };
  const auth = { onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() { authCallback = null; } } } }; } };
  const supabase = { auth, rpc(name, args) { let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); calls.push({ name, args, resolve, reject }); return promise; } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    if (name.endsWith('.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    throw Error(name);
  }, Error, Date, Number, String, Math, Array, Object,
  fetch(url) { fetches.push(url); return new Promise(() => {}); } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(from); return out; }
  function text(n = root) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); }
  function emit(e, s) { authCallback(e, s); render(); }
  function button(t) { const n = nodes('button').find(n => text(n) === t); assert.ok(n, t); return n; }
  render();
  return { calls, fetches, render, nodes, text, settle, emit, button, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const plain = value => JSON.parse(JSON.stringify(value));
const member = (id, name, rank) => ({ binding_id: id, rank, agent_name: name, vendor: 'Headless', live: true, marked_at: '2026-10-31T06:00:00Z' });
const node = (id, name, rank, extra = {}) => ({ binding_id: id, agent_name: name, vendor: 'Headless', live: true, rank,
  node: { node_id: 'n-' + id, name: name.toUpperCase(), last_heartbeat_at: '2026-10-31T07:50:00Z', mode: 'STANDBY', state: 'NORMAL',
    service_running: true, snapshot_age_seconds: 120, ci_source_manifest_sha256: 'c'.repeat(64), ...extra } });
const DATA = (extra = {}) => ({ status: 'ok', setting: { enabled: false, enabled_at: null, version: 3 },
  rules: { silence_minutes: 30 },
  members: [member('b-turing', 'turing', 1), member('b-desk', 'desk-w-591', 2)],
  holders: [{ binding_id: 'b-turing', agent_name: 'turing', purpose: 'resident-node' }, { binding_id: 'b-park', agent_name: 'park', purpose: 'parking' },
    { binding_id: 'b-env', agent_name: 'github-env', purpose: 'other' }],
  connections: [{ binding_id: 'b-turing', agent_name: 'turing', vendor: 'Headless' }, { binding_id: 'b-desk', agent_name: 'desk-w-591', vendor: 'Headless' },
    { binding_id: 'b-new', agent_name: 'new-node', vendor: 'Headless', purpose: null },
    { binding_id: 'b-park', agent_name: 'park', vendor: 'Headless', purpose: 'parking' },
    { binding_id: 'b-env', agent_name: 'github-env', vendor: 'github', purpose: 'other' }],
  nodes: [node('b-turing', 'turing', 1, { mode: 'ACTIVE' }), node('b-desk', 'desk-w-591', 2, { state: 'UNKNOWN', readable_state: 'HALTED', service_running: false })],
  watchdog: { last_tick_at: '2026-10-31T07:59:00Z', stale: false },
  alerts: [
    { receipt_id: 'r3', created_at: '2026-10-31T07:40:00Z', receipt_kind: 'CI_ADMISSION_AUTO_HANDOVER', from_binding_id: 'b-desk',
      to_binding_id: 'b-turing', trigger: 'silence', effective_at: '2026-10-31T07:45:00Z' },
    { receipt_id: 'r2', created_at: '2026-10-31T07:00:00Z', receipt_kind: 'CI_ADMISSION_FAILOVER_NO_TARGET', holder: 'b-desk',
      candidates: [{ binding_id: 'b-turing', reasons: ['heartbeat_stale', 'cooldown'] }] },
    { receipt_id: 'r1', created_at: '2026-10-31T06:00:00Z', receipt_kind: 'CI_ADMISSION_FAILOVER_WITHHELD', reason: 'switch_off' },
  ], ...extra });

async function open(f, data = DATA()) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_resident_failover_v1', { p_input: {} }]);
  f.calls[0].resolve({ data, error: null }); await f.settle();
}

test('signed out: no call, a sign-in link', () => {
  const f = fixture(PAGE);
  f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0);
  assert.ok(f.text().includes('登录 BeamingFace'));
  assert.equal(f.fetches.length, 0);
});

test('the page shows the switch, the watchdog, the order, every node heartbeat and the alerts in plain words', async () => {
  const f = fixture(PAGE);
  await open(f);
  const shown = f.text();
  assert.ok(shown.includes('关着'));
  assert.ok(shown.includes('最近一次运行：'));
  assert.ok(!shown.includes('看门狗超过 5 分钟没有运行'));
  assert.ok(shown.includes('当前持有 CI 准入的常驻节点：turing（Headless）'));
  assert.ok(shown.includes('1. turing（Headless）'));
  assert.ok(shown.includes('2. desk-w-591（Headless）'));
  assert.ok(shown.includes('当班，正常'));
  assert.ok(shown.includes('备用，报不出状态，之前最近一次：已停机'));
  assert.ok(shown.includes('没在运行'));
  assert.ok(shown.includes('cccccccccccc'));
  assert.ok(shown.includes('已自动把 CI 准入从 desk-w-591 移交给 turing（失联 30 分钟）'));
  assert.ok(shown.includes('当前持有者 desk-w-591 失联，但没有可以接班的节点'));
  assert.ok(shown.includes('turing：20 分钟内没有心跳、6 小时内刚交出过 CI 准入'));
  assert.ok(shown.includes('总开关关着，所以没有交接'));
  // A parking spot and an "other" holder are not offered; a live resident candidate is.
  assert.ok(f.nodes('button').some(n => f.text(n) === '加入：new-node（Headless）'));
  assert.ok(!f.nodes('button').some(n => f.text(n).includes('park') || f.text(n).includes('github-env')));
  assert.equal(f.calls.length, 1, 'reading makes one call');
});

test('a stale watchdog is pointed out', async () => {
  const f = fixture(PAGE);
  await open(f, DATA({ watchdog: { last_tick_at: null, stale: true } }));
  assert.ok(f.text().includes('看门狗超过 5 分钟没有运行'));
  assert.ok(f.text().includes('最近一次运行：从来没有'));
});

test('a halted node shows its halt code, time, pull request and head', async () => {
  const f = fixture(PAGE);
  await open(f, DATA({ nodes: [node('b-desk', 'desk-w-591', 2, { state: 'HALTED', readable_state: 'HALTED',
    heartbeat_via_link: true, heartbeat_from_agent_name: 'desk-heartbeat',
    halt: { code: 'BYTE_DRIFT', at: '2026-10-31T07:00:00Z', pr: 'tdoljyj/cross-memory-system#958', head: 'a'.repeat(40) } })],
    alerts: [{ receipt_id: 'r9', created_at: '2026-10-31T07:00:00Z', receipt_kind: 'CI_ADMISSION_FAILOVER_NO_TARGET', holder: 'b-turing',
      candidates: [{ binding_id: 'b-desk', reasons: ['too_few_heartbeats'] }] }] }));
  const shown = f.text();
  assert.ok(shown.includes('备用，已停机'));
  assert.ok(shown.includes('停机详情原因 BYTE_DRIFT，'));
  assert.ok(shown.includes('停机，出事的 PR tdoljyj/cross-memory-system#958，head aaaaaaaaaaaa'));
  assert.ok(shown.includes('desk-w-591：持有者失联期间心跳不到 2 次'));
  assert.ok(shown.includes('（来自挂靠的心跳连接 desk-heartbeat）'));
  // A node that is not halted shows no halt line; a heartbeat from the node's own connection says nothing more.
  const g = fixture(PAGE);
  await open(g);
  assert.ok(!g.text().includes('停机详情'));
  assert.ok(!g.text().includes('挂靠'));
});

test('the switch: two steps, exactly the confirmed view, then the page reloads', async () => {
  const f = fixture(PAGE);
  await open(f);
  f.button('打开自动接班…').props.onClick(); f.render();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_resident_failover_confirmation_issue_v1',
    { p_input: { change: 'switch', enabled: true, base_version: 3 } }]);
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_rfo_a', view_digest: 'd'.repeat(64),
    confirmation_view: { kind: 'resident_failover', change: 'switch', enabled: true, members: [member('b-turing', 'turing', 1)] } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('打开：持有者失联时自动交接'));
  assert.ok(f.text().includes('1. turing（Headless）'));
  f.button('确认').props.onClick(); f.render();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]), ['clued_resident_failover_set_v1',
    { p_input: { confirmation_token: 'clued_rfo_a', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', enabled: true, version: 4 }, error: null }); await f.settle();
  assert.ok(f.text().includes('已打开自动接班总开关'));
  assert.equal(f.calls[3].name, 'clued_resident_failover_v1', 'the page is read again');
  f.calls[3].resolve({ data: DATA({ setting: { enabled: true, enabled_at: '2026-10-31T08:00:00Z', version: 4 } }), error: null }); await f.settle();
  assert.ok(f.text().includes('开着'));
  assert.ok(f.nodes('button').some(n => f.text(n) === '关闭自动接班…'));
});

test('order, marking and unmarking: each sends the whole new list for confirmation; backing out makes no call', async () => {
  const f = fixture(PAGE);
  await open(f);
  f.nodes('button').filter(n => f.text(n) === '下移')[0].props.onClick(); f.render();
  assert.deepEqual(plain(f.calls[1].args.p_input), { change: 'members', members: ['b-desk', 'b-turing'], base_version: 3 });
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_rfo_b', view_digest: 'e'.repeat(64),
    confirmation_view: { change: 'members', members_before: [member('b-turing', 'turing', 1), member('b-desk', 'desk-w-591', 2)],
      members: [member('b-desk', 'desk-w-591', 1), member('b-turing', 'turing', 2)], removed: [] } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('改之前1. turing（Headless）；2. desk-w-591（Headless）'));
  assert.ok(f.text().includes('改之后1. desk-w-591（Headless）；2. turing（Headless）'));
  assert.ok(f.nodes('button').filter(n => f.text(n) === '下移').every(n => n.props.disabled), 'nothing else while a confirmation is open');
  f.button('取消').props.onClick(); f.render();
  assert.equal(f.calls.length, 2);
  f.button('加入：new-node（Headless）').props.onClick(); f.render();
  assert.deepEqual(plain(f.calls[2].args.p_input), { change: 'members', members: ['b-turing', 'b-desk', 'b-new'], base_version: 3 });
  f.calls[2].resolve({ data: { status: 'rejected', error_code: 'resident_failover_version_conflict' }, error: null }); await f.settle();
  assert.ok(f.text().includes('设置刚被改过，请刷新页面后再操作。'));
  f.nodes('button').filter(n => f.text(n) === '取消资格')[1].props.onClick(); f.render();
  assert.deepEqual(plain(f.calls[3].args.p_input), { change: 'members', members: ['b-turing'], base_version: 3 });
  f.calls[3].resolve({ data: { status: 'issued', confirmation_token: 'clued_rfo_c', view_digest: 'f'.repeat(64),
    confirmation_view: { change: 'members', members_before: [], members: [member('b-turing', 'turing', 1)],
      removed: [member('b-desk', 'desk-w-591', 1)] } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('desk-w-591（Headless）（以后不会被自动选中）'));
  f.button('确认').props.onClick(); f.render();
  f.calls[4].resolve({ data: { status: 'rejected', error_code: 'confirmation_view_stale' }, error: null }); await f.settle();
  assert.ok(f.text().includes('设置或连接在你查看后发生了变化'));
  assert.equal(f.calls[5].name, 'clued_resident_failover_v1');
});

test('another account signing in clears the page', async () => {
  const f = fixture(PAGE);
  await open(f);
  f.emit('SIGNED_IN', session('someone-else'));
  assert.ok(!f.text().includes('turing'));
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_resident_failover_v1', { p_input: {} }]);
  f.unmount();
});

test('/bindings links to the takeover page', () => {
  assert.match(readFileSync(new URL('../app/bindings/page.tsx', import.meta.url), 'utf8'), /<Link href="\/bindings\/failover">CI 准入自动接班<\/Link>/);
});
