import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../app/grants/AutoApprovalSwitch.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020,
} }).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports, require(name) {
  assert.equal(name, 'react/jsx-runtime');
  return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
} });
function nodes(root, type) {
  const found = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.type === type) found.push(node);
    visit(node.props?.children);
  }
  visit(root); return found;
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  return typeof node === 'object' ? text(node.props?.children) : String(node);
}
const state = on => ({ on, version: 7, persistent: true,
  excluded: [{ action: 'connection.permission', title: '连接权限' }] });

test('persistent switch uses authoritative state, has no duration control, and sends desired state plus CAS version', () => {
  for (const on of [true, false]) {
    const changes = [];
    const root = exports.default({ auto: state(on), working: false, onToggle: (...args) => changes.push(args) });
    const button = nodes(root, 'button')[0];
    assert.equal(button.props.role, 'switch');
    assert.equal(button.props['aria-checked'], on);
    assert.equal(button.props['aria-labelledby'], 'owner-auto-approval-title');
    assert.equal(button.props.disabled, false);
    assert.equal(nodes(root, 'select').length, 0);
    assert.equal(nodes(root, 'input').length, 0);
    assert.ok(text(root).includes(on ? '直到你手动关闭' : '新的申请需要你确认'));
    assert.ok(text(root).includes('仍需你确认：连接权限'));
    button.props.onClick();
    assert.deepEqual(changes, [[!on, 7]]);
    assert.equal(button.props['aria-checked'], on, 'the saved state does not change optimistically');
  }
});

test('saving disables the native switch and keeps the last saved checked state', () => {
  const root = exports.default({ auto: state(true), working: true, onToggle() {} });
  assert.equal(nodes(root, 'button')[0].props.disabled, true);
  assert.equal(nodes(root, 'button')[0].props['aria-checked'], true);
});

test('unknown, malformed or legacy timed state never guesses default-On or exposes a setter', () => {
  for (const auto of [null, {}, { on: true }, { ...state(true), version: -1 },
    { ...state(true), version: 1.5 }, { ...state(true), on: 'true' },
    { ...state(true), persistent: false }, { on: true, expires_at: '2099-01-01' }]) {
    assert.equal(exports.isAutoApprovalState(auto), false);
    const root = exports.default({ auto, working: false, onToggle() { throw Error('must not be called'); } });
    assert.equal(nodes(root, 'button').length, 0);
    assert.ok(text(root).includes('暂时无法读取自动审批状态'));
  }
});
