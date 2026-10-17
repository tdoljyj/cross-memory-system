import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SUPABASE_CLI_VERSION } from '../evals/information-flow-e2e/stack.mjs';

const stackUrl = new URL('../evals/information-flow-e2e/stack.mjs', import.meta.url).href;
const fixture = `
  const [url, platform, settings] = process.argv.slice(1);
  Object.defineProperty(process, 'platform', { value: platform });
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, JSON.parse(settings));
  const { supabaseCommand, childEnv } = await import(url);
  process.stdout.write(JSON.stringify({ command: supabaseCommand(), env: childEnv() }));
`;

// Import the real module in an isolated process; never start npx, Supabase or Docker.
function inspect(platform, settings = {}) {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture,
    stackUrl, platform, JSON.stringify(settings)], {
    encoding: 'utf8', env: {}, timeout: 10000, maxBuffer: 32768,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return JSON.parse(child.stdout);
}

const ciPrefix = ['--yes', '--offline', `--package=supabase@${SUPABASE_CLI_VERSION}`,
  `--package=@supabase/cli-linux-x64@${SUPABASE_CLI_VERSION}`, 'supabase'];
const localPrefix = ['--yes', `supabase@${SUPABASE_CLI_VERSION}`];

for (const platform of ['linux', 'win32', 'darwin']) {
  test(`explicit binary has priority on ${platform}, including Actions`, () => {
    assert.deepEqual(inspect(platform, {
      GITHUB_ACTIONS: 'true', IFE2E_SUPABASE_BIN: '/fixture/custom-supabase',
    }).command, ['/fixture/custom-supabase', []]);
  });
}

test('Linux Actions uses only the cached pinned package pair', () => {
  assert.deepEqual(inspect('linux', { GITHUB_ACTIONS: 'true' }).command, ['npx', ciPrefix]);
});

for (const actions of [undefined, 'false', '1', 'TRUE', 'true ']) {
  test(`Linux without the exact Actions marker retains local behavior (${String(actions)})`, () => {
    const settings = actions === undefined ? {} : { GITHUB_ACTIONS: actions };
    const { command } = inspect('linux', settings);
    assert.deepEqual(command, ['npx', localPrefix]);
    assert.equal(command[1].includes('--offline'), false);
  });
}

for (const platform of ['win32', 'darwin']) {
  test(`${platform} retains its existing command even with the Actions marker`, () => {
    const { command } = inspect(platform, { GITHUB_ACTIONS: 'true' });
    assert.deepEqual(command, [platform === 'win32' ? 'npx.cmd' : 'npx', localPrefix]);
    assert.equal(command[1].includes('--offline'), false);
  });
}

test('local Windows retains npx.cmd and the original package argument', () => {
  assert.deepEqual(inspect('win32').command, ['npx.cmd', localPrefix]);
});

test('empty explicit override still selects the Linux Actions fallback', () => {
  assert.deepEqual(inspect('linux', { GITHUB_ACTIONS: 'true', IFE2E_SUPABASE_BIN: '' }).command,
    ['npx', ciPrefix]);
});

test('Actions fallback package set matches both existing workflow stack preparations', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/information-flow-e2e.yml', import.meta.url), 'utf8');
  const jobs = [...workflow.matchAll(/^  (e2e-[\w-]+):\r?\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm)];
  assert.deepEqual(jobs.map((job) => job[1]), ['e2e-trusted-self-hosted', 'e2e-untrusted-hosted']);
  const [, args] = inspect('linux', { GITHUB_ACTIONS: 'true' }).command;
  for (const [, name, body] of jobs) {
    const start = /^\s+run: npx ([^\r\n]+) supabase start(?: |$)/m.exec(body);
    assert.ok(start, `${name} prepares the Supabase CLI before the harness`);
    assert.deepEqual(args.filter((arg) => arg.startsWith('--package=')),
      start[1].split(/\s+/).filter((arg) => arg.startsWith('--package=')), name);
  }
});

test('command selection preserves the child credential, proxy and telemetry boundary', () => {
  const { env } = inspect('linux', {
    GITHUB_ACTIONS: 'true', npm_config_cache: '/fixture/cache', PATH: '/fixture/bin',
    SUPABASE_ACCESS_TOKEN: 'synthetic-forbidden', CLOUDFLARE_API_TOKEN: 'synthetic-forbidden',
    SUPABASE_DB_PASSWORD: 'synthetic-forbidden', HTTP_PROXY: 'http://proxy.invalid:1234',
    HTTPS_PROXY: 'http://proxy.invalid:1234', ALL_PROXY: 'http://proxy.invalid:1234',
  });
  assert.deepEqual(env, {
    PATH: '/fixture/bin', npm_config_cache: '/fixture/cache', GITHUB_ACTIONS: 'true', DO_NOT_TRACK: '1',
    SUPABASE_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false',
  });
});
