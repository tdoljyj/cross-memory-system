import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identity, freshConfig, requireUnused, verifyHistory, migrationSources, verifySourceState, verifyContainer,
  prepare, verify, verifyConfiguration } from './clued-g4-fresh-start.mjs';

const env = { GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'owner/repo' };
const config = 'project_id = "clued-cloud"\nport = 54321\nport = 54322\nshadow_port = 54320\nport = 54323\nport = 54324\nport = 54327\nport = 54329\n[db.seed]\nenabled = false\n[other]\nvalue = true\n';

test('every attempt has a unique project and a different isolated port block', () => {
  assert.equal(identity(env).project, 'clued-g4-100-1');
  const second = { ...env, GITHUB_RUN_ATTEMPT: '2' };
  assert.equal(identity(second).project, 'clued-g4-100-2');
  assert.match(freshConfig(config, env), /project_id = "clued-g4-100-1"/);
  assert.match(freshConfig(config, env), /port = 46001/);
  assert.match(freshConfig(config, second), /port = 46011/);
  assert.match(freshConfig(config, env), /\[other\]\nvalue = true/);
});

test('freshness requires an empty container and volume inventory, including unlabelled db backups', () => {
  const empty = { labelledContainers: [], labelledVolumes: [], volumeNames: ['unrelated_project'], containerNames: ['unrelated_container'] };
  assert.doesNotThrow(() => requireUnused(empty, 'clued-g4-100-1'));
  assert.throws(() => requireUnused({ ...empty, labelledContainers: ['leftover'] }, 'clued-g4-100-1'));
  assert.throws(() => requireUnused({ ...empty, labelledVolumes: ['leftover'] }, 'clued-g4-100-1'));
  assert.throws(() => requireUnused({ ...empty, volumeNames: ['supabase_db_clued-g4-100-1'] }, 'clued-g4-100-1'));
  assert.throws(() => requireUnused({ ...empty, volumeNames: undefined }, 'clued-g4-100-1'));
  assert.throws(() => requireUnused({ ...empty, containerNames: ['supabase_db_clued-g4-100-1'] }, 'clued-g4-100-1'));
  assert.throws(() => requireUnused({ ...empty, containerNames: ['/supabase_auth_clued-g4-100-1'] }, 'clued-g4-100-1'));
});

test('verify and cleanup reject a changed checkout, incomplete prepare or unrelated tracked edit', () => {
  const marker = { prepared: true, checkout_sha: env.GITHUB_SHA };
  const state = { head: env.GITHUB_SHA, dirty: ' M apps/clued-cloud/supabase/config.toml\n' };
  assert.doesNotThrow(() => verifySourceState(marker, state));
  assert.throws(() => verifySourceState(marker, { ...state, head: 'b'.repeat(40) }));
  assert.throws(() => verifySourceState({ ...marker, prepared: false }, state));
  assert.throws(() => verifySourceState(marker, { ...state, dirty: state.dirty + ' M apps/clued-cloud/worker/index.ts' }));
});

test('the database must be the exact labelled project container and its own named volume', () => {
  const marker = { project: 'clued-g4-100-1' };
  const container = { name: '/supabase_db_clued-g4-100-1', project: marker.project,
    mounts: [{ Type: 'volume', Name: 'supabase_db_clued-g4-100-1', Destination: '/var/lib/postgresql/data' }] };
  const labels = { 'com.supabase.cli.project': marker.project };
  assert.doesNotThrow(() => verifyContainer(marker, container, labels));
  assert.throws(() => verifyContainer(marker, { ...container, project: null }, labels));
  assert.throws(() => verifyContainer(marker, { ...container, name: '/other' }, labels));
  assert.throws(() => verifyContainer(marker, { ...container, mounts: [{ ...container.mounts[0], Name: 'old-anonymous-volume' }] }, labels));
  assert.throws(() => verifyContainer(marker, container, {}));
});

test('unknown identity, project template, port set or enabled seed never qualifies', () => {
  for (const delta of [{ GITHUB_RUN_ID: 'bad' }, { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_SHA: 'bad' }])
    assert.throws(() => identity({ ...env, ...delta }));
  assert.throws(() => freshConfig(config.replace('enabled = false', 'enabled = true'), env));
  assert.throws(() => freshConfig(config.replace('port = 54329\n', ''), env));
  assert.throws(() => freshConfig(config.replace('clued-cloud', 'another-project'), env));
});

test('the real committed configuration retains its commented seed section and all unrelated settings', () => {
  const source = fs.readFileSync(new URL('../../apps/clued-cloud/supabase/config.toml', import.meta.url), 'utf8');
  const actual = freshConfig(source, env);
  assert.match(actual, /project_id = "clued-g4-100-1"/);
  assert.match(actual, /major_version = 17/);
  assert.match(actual, /\[db\.seed\][\s\S]*?enabled = false/);
  assert.equal((actual.match(/^[ \t]*(?:port|shadow_port)[ \t]*=[ \t]*4600[0-9]$/gm) ?? []).length, 7);
});

test('history must contain exactly the complete source versions and names', () => {
  const source = [{ version: '202608230001', name: 'first' }, { version: '202608230002', name: 'second' }];
  assert.deepEqual(verifyHistory(source, [...source].reverse()), { migrations: 2, history_matches: true });
  for (const history of [[], [source[0]], [source[0], source[0]],
    [source[0], { ...source[1], name: 'wrong' }], [...source, { version: '202608230003', name: 'extra' }]])
    assert.throws(() => verifyHistory(source, history));
});

test('migration source digest detects changed bytes, rejects invalid and duplicate versions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-g4-source-test-'));
  try {
    fs.writeFileSync(path.join(dir, '202608230001_first.sql'), 'select 1;\n');
    const before = migrationSources(dir);
    fs.writeFileSync(path.join(dir, '202608230001_first.sql'), 'select 2;\n');
    assert.notEqual(migrationSources(dir)[0].sha256, before[0].sha256);
    fs.writeFileSync(path.join(dir, '202608230001_duplicate.sql'), 'select 1;\n');
    assert.throws(() => migrationSources(dir));
    fs.unlinkSync(path.join(dir, '202608230001_duplicate.sql'));
    fs.writeFileSync(path.join(dir, 'malformed.sql'), 'select 1;\n');
    assert.throws(() => migrationSources(dir));
  } finally { fs.rmSync(dir, { recursive: true }); }
});

function workflowFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-g4-flow-test-'));
  const app = path.join(root, 'apps/clued-cloud/supabase');
  fs.mkdirSync(path.join(app, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(app, 'config.toml'), config);
  fs.writeFileSync(path.join(app, 'migrations/202608230001_first.sql'), 'select 1;\n');
  const e = { ...env, GITHUB_RUN_ID: String(run), RUNNER_TEMP: root, GITHUB_ENV: path.join(root, 'github-env'),
    CLUED_G4_FRESH_PROJECT: `clued-g4-${run}-1` };
  const calls = [];
  const runtime = { platform: 'linux', git: (verb, ref) => {
    if (verb === 'show') return config;
    if (verb === 'status') return fs.readFileSync(path.join(app, 'config.toml'), 'utf8') === config ? '' : ' M apps/clued-cloud/supabase/config.toml';
    return ref === 'HEAD' ? e.GITHUB_SHA : root;
  }, docker: (...args) => {
    calls.push(args);
    if (args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
    if (args[0] === 'inspect') return JSON.stringify({ name: `/supabase_db_${e.CLUED_G4_FRESH_PROJECT}`,
      project: e.CLUED_G4_FRESH_PROJECT, mounts: [{ Type: 'volume', Name: `supabase_db_${e.CLUED_G4_FRESH_PROJECT}`, Destination: '/var/lib/postgresql/data' }] });
    if (args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify({ 'com.supabase.cli.project': e.CLUED_G4_FRESH_PROJECT });
    if (args[0] === 'exec') return JSON.stringify([{ version: '202608230001', name: 'first' }]);
    return '';
  } };
  return { root, app, e, calls, runtime, dispose: () => fs.rmSync(root, { recursive: true }) };
}

test('prepare and verify perform the actual file transitions and only a fixed local read query', () => {
  const f = workflowFixture(110);
  try {
    assert.equal(prepare(f.e, f.runtime).fresh_inventory, true);
    assert.equal(verify(f.e, f.runtime).history_matches, true);
    assert.doesNotThrow(() => verifyConfiguration(f.e, f.runtime));
    assert.match(fs.readFileSync(f.e.GITHUB_ENV, 'utf8'), /DOCKER_HOST=unix:\/\/\/var\/run\/docker.sock/);
    assert.equal(f.calls.filter((args) => args[0] === 'exec').length, 1);
    assert.equal(f.calls.some((args) => args.includes('rm') || args.includes('prune') || args.includes('start')), false);
  } finally { f.dispose(); }
});

test('a partial prepare cannot authorize verify or cleanup', () => {
  const f = workflowFixture(111);
  try {
    assert.throws(() => prepare(f.e, { ...f.runtime, fs: { ...fs, appendFileSync: () => { throw new Error('write interrupted'); } } }));
    assert.throws(() => verify(f.e, f.runtime), /fresh_marker_identity/);
    assert.throws(() => verifyConfiguration(f.e, f.runtime), /fresh_marker_identity/);
    assert.equal(f.calls.some((args) => args[0] === 'exec'), false);
  } finally { f.dispose(); }
});

test('existing containers fail before configuration or marker is written', () => {
  const f = workflowFixture(112);
  try {
    assert.throws(() => prepare(f.e, { ...f.runtime, docker: (...args) =>
      args[0] === 'ps' && !args.includes('--filter') ? 'supabase_db_clued-g4-112-1' : f.runtime.docker(...args) }));
    assert.equal(fs.readFileSync(path.join(f.app, 'config.toml'), 'utf8'), config);
    assert.equal(fs.existsSync(f.e.GITHUB_ENV), false);
  } finally { f.dispose(); }
});

test('post-start source or target changes prevent any history query and cleanup qualification', () => {
  const f = workflowFixture(113);
  try {
    prepare(f.e, f.runtime);
    const changed = { ...f.runtime, git: (verb, ref) => verb === 'rev-parse' && ref === 'HEAD' ? 'b'.repeat(40) : f.runtime.git(verb, ref) };
    assert.throws(() => verify(f.e, changed), /fresh_checkout_changed/);
    assert.throws(() => verifyConfiguration({ ...f.e, CLUED_G4_FRESH_PROJECT: 'foreign-project' }, f.runtime));
    assert.equal(f.calls.some((args) => args[0] === 'exec'), false);
  } finally { f.dispose(); }
});
