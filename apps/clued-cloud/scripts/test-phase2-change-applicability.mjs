// CA01–CA03: isolated checks of actual source, without live OAuth or business writes.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import ts from 'typescript';

const app = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'clued-ca01-ca03-'));
const bundled = path.join(directory, 'continuity.mjs');
await build({ entryPoints: [path.join(app, 'worker/continuity.ts')], outfile: bundled,
  bundle: true, platform: 'node', format: 'esm' });
stop();
after(async () => { await unlink(bundled); await rmdir(directory); });
const { handleContinuityRequest: handle, publicMcpTools } = await import(pathToFileURL(bundled));
const origin = 'https://clued.example.test';
const env = { SUPABASE_URL: 'https://storage.example.test', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key' };
const bootstrap = () => new Request(origin + '/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'clued_agent_bootstrap', arguments: {} } }),
});

for (const scenario of [
  { label: 'disabled uses Supabase', flags: {}, issuer: env.SUPABASE_URL + '/auth/v1' },
  { label: 'disabled ignores delegated override', flags: { CLUED_OAUTH_ORIGIN: 'https://issuer.example.test' }, issuer: env.SUPABASE_URL + '/auth/v1' },
  { label: 'enabled uses explicit issuer', flags: { CLUED_DELEGATED_OAUTH_V12: 'true', CLUED_OAUTH_ORIGIN: 'https://issuer.example.test' }, issuer: 'https://issuer.example.test' },
  { label: 'enabled falls back to request origin', flags: { CLUED_DELEGATED_OAUTH_V12: 'true' }, issuer: origin },
]) test('CA01 bootstrap: ' + scenario.label, async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('bootstrap must not contact storage'); });
  const response = await handle(bootstrap(), { ...env, ...scenario.flags });
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('www-authenticate'), false);
  const { result } = await response.json();
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.authentication.oauth.authorization_server, scenario.issuer);
  assert.equal(result.structuredContent.authentication.oauth.consent_path, origin + '/oauth/consent');
  assert.deepEqual(result.structuredContent.authentication.scopes, ['context:read', 'context:write', 'audit:read']);
  assert.equal(fetch.mock.callCount(), 0);
});

test('CA01 context exposure preserves all legacy tool metadata', () => {
  const legacy = publicMcpTools({});
  const enabled = publicMcpTools({ CLUED_DEVELOPMENT_CONTEXT_V14: 'true' });
  assert.equal(legacy.some(tool => tool.name === 'clued_context'), false);
  assert.equal(enabled.filter(tool => tool.name === 'clued_context').length, 1);
  assert.deepEqual(enabled.filter(tool => tool.name !== 'clued_context'), legacy);
  assert.ok(legacy.some(tool => tool.name === 'clued_agent_bootstrap'));
  assert.ok(legacy.some(tool => tool.name === 'clued_project_list'));
});

const projectRequest = () => new Request(origin + '/v1/projects', {
  headers: { authorization: 'Bearer fixture-account-jwt' },
});
test('CA02 account REST resource denial is 403 without an OAuth challenge', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname;
    paths.push(route);
    assert.equal(options.headers.get('authorization'), 'Bearer fixture-account-jwt');
    if (route === '/auth/v1/user') return Response.json({ id: 'fixture-account' });
    assert.equal(route, '/rest/v1/rpc/clued_user_project_list');
    return Response.json({ code: '42501', message: 'resource_action_not_authorized' }, { status: 401 });
  });
  const response = await handle(projectRequest(), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.has('www-authenticate'), false);
  const body = await response.json();
  assert.equal(body.error, 'resource_action_not_authorized');
  assert.equal(body.details.code, '42501');
  assert.equal('projects' in body, false);
  assert.deepEqual(paths, ['/auth/v1/user', '/rest/v1/rpc/clued_user_project_list']);
});

test('CA02 account REST invalid JWT stays 401 and never calls project RPC', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    paths.push(new URL(url).pathname);
    return Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 });
  });
  const response = await handle(projectRequest(), env);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, 'JWT expired');
  assert.equal(body.details.code, 'PGRST301');
  assert.deepEqual(paths, ['/auth/v1/user']);
});

const consentSource = ts.transpileModule(readFileSync(path.join(app, 'app/oauth/consent/page.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

// Follow the actual page -> Suspense -> ConsentRouter -> selected component tree.
// DelegatedConsent is an observed boundary stub; its internals have existing tests.
async function mountConsent(query) {
  const effects = [], timers = [], mounts = [], delegated = [], authCalls = [];
  const exports = {};
  const sharedAuth = {
    async getSession() { authCalls.push(['getSession']); return { data: { session: { user: { id: 'fixture-user' } } } }; },
    oauth: { async getAuthorizationDetails(id) {
      authCalls.push(['getAuthorizationDetails', id]);
      return { data: { client: { name: 'Fixture client' }, scope: 'context:read' }, error: null };
    } },
  };
  const React = {
    Suspense: ({ children }) => children,
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: callback => callback(), useCallback: callback => callback,
    useEffect: callback => effects.push(callback),
  };
  function DelegatedBoundary({ requestId }) { delegated.push(requestId); return null; }
  vm.runInNewContext(consentSource, {
    exports, URL, URLSearchParams,
    window: { setTimeout: callback => timers.push(callback), clearTimeout() {},
      location: { assign() { throw new Error('router check must not authorize or navigate'); } } },
    require(name) {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === 'next/link') return { __esModule: true, default: 'a' };
      if (name === 'next/navigation') return { useSearchParams: () => new URLSearchParams(query) };
      if (name === './delegated-consent') return { __esModule: true, default: DelegatedBoundary };
      if (name === '../../supabase-browser') return { supabase: { auth: sharedAuth } };
      throw new Error('Unexpected dependency: ' + name);
    },
  });
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function') { mounts.push(node.type.name); visit(node.type(node.props ?? {})); }
    else visit(node.props?.children);
  }
  visit({ type: exports.default, props: {} });
  for (const effect of effects) effect();
  for (const timer of timers) timer();
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  return { mounts, delegated, authCalls };
}

for (const query of ['request_id=request-one', 'request_id=request-one&authorization_id=legacy-one']) {
  test('CA03 only delegated branch mounts: ' + query, async () => {
    const result = await mountConsent(query);
    assert.ok(result.mounts.includes('ConsentRouter'));
    assert.equal(result.mounts.includes('OAuthConsent'), false);
    assert.deepEqual(result.delegated, ['request-one']);
    assert.deepEqual(result.authCalls, []);
  });
}
test('CA03 legacy authorization uses the shared client and exact authorization ID', async () => {
  const result = await mountConsent('authorization_id=legacy-one');
  assert.ok(result.mounts.includes('OAuthConsent'));
  assert.deepEqual(result.delegated, []);
  assert.deepEqual(result.authCalls, [['getSession'], ['getAuthorizationDetails', 'legacy-one']]);
});
test('CA03 missing IDs display the legacy empty state without authorization lookup', async () => {
  const result = await mountConsent('');
  assert.ok(result.mounts.includes('OAuthConsent'));
  assert.deepEqual(result.delegated, []);
  assert.deepEqual(result.authCalls, []);
});
