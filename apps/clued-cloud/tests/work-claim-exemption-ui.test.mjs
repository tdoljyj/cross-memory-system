// Work Claim exemption page after Owner Credential step 3: a notice pointing to
// the grants page; it makes no calls. Rendered without a browser.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../app/work-claims/exemption/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

test('the exemption page explains the switch to Owner Grants and links to /grants without calling anything', () => {
  const calls = [];
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('contexts.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    calls.push(name);
    throw Error(name);
  }, fetch(url) { calls.push(url); return new Promise(() => {}); } });
  const root = exports.default({});
  const text = (n) => Array.isArray(n) ? n.map(text).join('') : n == null || typeof n === 'boolean' ? ''
    : typeof n === 'object' ? text(n.props?.children ?? null) : String(n);
  const links = [];
  (function visit(n) { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return;
    if (n.type === 'a') links.push(n.props.href); visit(n.props?.children); })(root);
  assert.ok(text(root).includes('任务领取豁免已改为授权'));
  assert.ok(text(root).includes('到期前继续有效'));
  assert.ok(links.includes('/grants'));
  assert.deepEqual(calls, [], 'no Supabase client, RPC or fetch');
});
