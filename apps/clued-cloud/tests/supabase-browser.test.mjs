// Real shared-client module under mocked SDK calls. No identity traffic or live credentials.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../app/supabase-browser.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText.replaceAll("import.meta.env", "publicBuildEnvironment");
const publicConfigExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../app/supabase-public-config.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: publicConfigExports, URL, Error });
function fixture(href = 'https://clued.example.test/oauth/account', publicEnv = {}) {
  const creations = [], calls = [], changes = [];
  let currentSession = null;
  const browser = { location: { href }, history: { replaceState(_data, _unused, relative) {
    browser.location.href = new URL(relative, browser.location.href).href; changes.push(browser.location.href);
  } } };
  const auth = {
    getSession: async () => ({ data: { session: currentSession }, error: null }),
    setSession: input => deferred('setSession', input),
    exchangeCodeForSession: input => deferred('exchangeCodeForSession', input),
  };
  function deferred(method, input) {
    let resolve;
    const promise = new Promise(done => { resolve = value => { if (!value.error) currentSession = value.data.session; done(value); }; });
    calls.push({ method, input, resolve }); return promise;
  }
  function evaluate(withBrowser = true, environment = publicEnv) {
    const exports = {};
    vm.runInNewContext(compiled, { exports, URL, URLSearchParams, Error, publicBuildEnvironment: environment, ...(withBrowser ? { window: browser } : {}),
      require(name) {
        if (name === './supabase-public-config') return publicConfigExports;
        assert.equal(name, '@supabase/supabase-js');
        return { createClient(url, key, options) {
          assert.ok(url.startsWith('https://')); assert.ok(key.startsWith('sb_publishable_'));
          const client = { auth }; creations.push({ client, options, url, key }); return client;
        } };
      },
    });
    return exports;
  }
  return { browser, creations, calls, changes, evaluate };
}
const session = { user: { id: 'fixture-user' }, access_token: 'fixture-access', refresh_token: 'fixture-refresh' };
const success = { data: { session }, error: null };
const privateKeyFixture = ['sb', 'secret', 'fixture', 'rejected'].join('_');

test('account, projects and home navigation plus HMR use one instance and one fixed callback policy', () => {
  const f = fixture(); const account = f.evaluate();
  f.browser.location.href = 'https://clued.example.test/oauth/projects'; const projects = f.evaluate();
  f.browser.location.href = 'https://clued.example.test/'; const home = f.evaluate();
  for (let i = 0; i < 5; i++) assert.equal(f.evaluate().supabase, account.supabase);
  assert.equal(account.supabase, projects.supabase); assert.equal(projects.supabase, home.supabase);
  assert.equal(f.creations.length, 1);
  assert.equal(f.creations[0].options.auth.detectSessionInUrl, false);
  assert.equal(f.creations[0].options.auth.persistSession, true);
});

test('SSR creates no persistent session or shared browser cache', () => {
  const f = fixture(); const first = f.evaluate(false), second = f.evaluate(false);
  assert.notEqual(first.supabase, second.supabase);
  assert.equal(f.browser.__cluedBrowserSupabase, undefined);
  for (const { options } of f.creations) {
    assert.equal(options.auth.persistSession, false);
    assert.equal(options.auth.autoRefreshToken, false);
    assert.equal(options.auth.detectSessionInUrl, false);
  }
});

test('home recovery tokens are consumed once across repeated effects and module replacement', async () => {
  const f = fixture('https://clued.example.test/#access_token=fixture-a&refresh_token=fixture-r&type=recovery');
  const first = f.evaluate().restoreBrowserSession();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'setSession');
  assert.equal(new URL(f.browser.location.href).hash, '');
  assert.equal(new URL(f.browser.location.href).searchParams.get('type'), 'recovery');
  const second = f.evaluate().restoreBrowserSession(); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(success); const results = await Promise.all([first, second]);
  for (const result of results) { assert.equal(result.session, session); assert.equal(result.authType, 'recovery'); assert.equal(result.error, null); }
  const third = await f.evaluate().restoreBrowserSession(); assert.equal(third.session, session); assert.equal(f.calls.length, 1);
});

test('projects PKCE callback exchanges once and preserves a separate invitation fragment', async () => {
  const f = fixture('https://clued.example.test/oauth/projects?code=fixture-code#invite=fixture-invitation');
  const entry = f.evaluate(); const result = entry.restoreBrowserSession();
  assert.equal(f.calls[0].method, 'exchangeCodeForSession'); assert.equal(f.calls[0].input, 'fixture-code');
  assert.equal(new URL(f.browser.location.href).searchParams.has('code'), false);
  assert.equal(new URL(f.browser.location.href).hash, '#invite=fixture-invitation');
  const duplicate = f.evaluate().restoreBrowserSession(); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(success); assert.equal((await result).session, session); assert.equal((await duplicate).session, session);
});

test('malformed or rejected callback never falls back to a successful identity', async () => {
  const malformed = fixture('https://clued.example.test/#access_token=fixture-a&type=recovery');
  const bad = await malformed.evaluate().restoreBrowserSession(); assert.equal(bad.session, null); assert.ok(bad.error); assert.equal(malformed.calls.length, 0);
  const rejected = fixture('https://clued.example.test/oauth/projects?code=expired'); const result = rejected.evaluate().restoreBrowserSession();
  rejected.calls[0].resolve({ data: { session: null }, error: new Error('fixture expired code') });
  assert.equal((await result).session, null); assert.ok((await result).error);
});

test('a different login callback cannot silently reuse a pending identity result', async () => {
  const f = fixture('https://clued.example.test/oauth/projects?code=first'); const pending = f.evaluate().restoreBrowserSession();
  f.browser.location.href = 'https://clued.example.test/oauth/projects?code=second';
  const rejected = await f.evaluate().restoreBrowserSession(); assert.equal(rejected.session, null); assert.ok(rejected.error); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(success); await pending;
  assert.equal(new URL(f.browser.location.href).searchParams.get('code'), 'second');
});

test('all account entry pages import the shared client instead of constructing another instance', () => {
  for (const name of ['page.tsx', 'contexts/page.tsx', 'oauth/account/page.tsx', 'oauth/projects/page.tsx',
    'oauth/connections/page.tsx', 'oauth/consent/page.tsx', 'oauth/consent/delegated-consent.tsx']) {
    const source = readFileSync(new URL('../app/' + name, import.meta.url), 'utf8');
    assert.match(source, /from ["'](?:\.\.\/|\.\/)+supabase-browser["']/);
    assert.doesNotMatch(source, /createClient\s*\(/);
  }
});

test('public build values select one explicit project, while absent values retain compatibility', () => {
  const defaults = fixture(); defaults.evaluate();
  assert.equal(defaults.creations[0].url, 'https://ccxsikzwxlolxqlosril.supabase.co');
  const configured = fixture(undefined, { VITE_CLUED_SUPABASE_URL: 'https://preview.example.test', VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture_preview' });
  configured.evaluate(); assert.equal(configured.creations[0].url, 'https://preview.example.test');
  assert.equal(configured.creations[0].key, 'sb_publishable_fixture_preview');
});

test('partial public configuration and private keys fail before client creation', () => {
  for (const environment of [
    { VITE_CLUED_SUPABASE_URL: 'https://preview.example.test' },
    { VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' },
    { VITE_CLUED_SUPABASE_URL: '', VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: '' },
    { VITE_CLUED_SUPABASE_URL: 'https://preview.example.test', VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: privateKeyFixture },
    { VITE_CLUED_SUPABASE_URL: 'https://preview.example.test', VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: 'eyJ.fixture.service_role' },
    { VITE_CLUED_SUPABASE_URL: 'http://remote.example.test', VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture' },
  ]) {
    const f = fixture(undefined, environment); assert.throws(() => f.evaluate()); assert.equal(f.creations.length, 0);
  }
});

test('changed build configuration during HMR cannot silently reuse another project client', () => {
  const f = fixture(); f.evaluate();
  assert.throws(() => f.evaluate(true, { VITE_CLUED_SUPABASE_URL: 'https://preview.example.test', VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture_preview' }));
  assert.equal(f.creations.length, 1);
});

const buildConfigSource = ts.transpileModule(readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
async function evaluateBuildConfig(environment) {
  let runtimeImports = 0;
  const exports = {};
  vm.runInNewContext(buildConfigSource, { exports, process: { env: {}, cwd: () => '/fixture' },
    require(name) {
      if (name === 'vite') return { defineConfig: callback => callback, loadEnv: (mode, cwd, prefix) => {
        assert.equal(mode, 'fixture'); assert.equal(cwd, '/fixture'); assert.equal(prefix, 'VITE_CLUED_'); return environment;
      } };
      if (name === './app/supabase-public-config') return publicConfigExports;
      if (name === 'vinext') return { __esModule: true, default: () => ({ name: 'vinext-fixture' }) };
      if (name === './.openai/hosting.json') return {};
      if (name === './build/sites-vite-plugin') return { sites: () => ({ name: 'sites-fixture' }) };
      if (name === '@cloudflare/vite-plugin') { runtimeImports++; return { cloudflare: () => ({ name: 'worker-fixture' }) }; }
      throw new Error('Unexpected build import: ' + name);
    },
  });
  try { return { config: await exports.default({ mode: 'fixture' }), runtimeImports }; }
  catch (error) { return { error, runtimeImports }; }
}

test('actual Vite config rejects private or incomplete public values before Worker plugin loading', async () => {
  for (const environment of [
    { VITE_CLUED_SUPABASE_URL: 'https://preview.example.test' },
    { VITE_CLUED_SUPABASE_URL: 'https://preview.example.test', VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: privateKeyFixture },
  ]) {
    const result = await evaluateBuildConfig(environment); assert.ok(result.error); assert.equal(result.runtimeImports, 0);
  }
});

test('actual Vite config accepts a complete public pair and preserves the existing plugins', async () => {
  const result = await evaluateBuildConfig({ VITE_CLUED_SUPABASE_URL: 'https://preview.example.test', VITE_CLUED_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture_preview' });
  assert.equal(result.error, undefined); assert.equal(result.runtimeImports, 1); assert.equal(result.config.plugins.length, 3);
});
