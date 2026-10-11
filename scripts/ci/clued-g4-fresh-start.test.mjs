import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
const { identity, freshConfig, requireUnused, verifyHistory, migrationSources, verifySourceState, verifyContainer,
  prepare, verify, verifyConfiguration, portCandidates, probePorts, PORT_BLOCK_LIMIT } = await import(process.env.CLUED_G4_TEST_MODULE_PATH ?
    pathToFileURL(process.env.CLUED_G4_TEST_MODULE_PATH).href : new URL('./clued-g4-fresh-start.mjs', import.meta.url));
const fixtureFile = relative => process.env.CLUED_G4_TEST_REPO_ROOT ? path.join(process.env.CLUED_G4_TEST_REPO_ROOT, relative) : new URL('../../' + relative, import.meta.url);

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
  const source = fs.readFileSync(fixtureFile('apps/clued-cloud/supabase/config.toml'), 'utf8');
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

function workflowFixture(run, attempt = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-g4-flow-test-'));
  const app = path.join(root, 'apps/clued-cloud/supabase');
  fs.mkdirSync(path.join(app, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(app, 'config.toml'), config);
  fs.writeFileSync(path.join(app, 'migrations/202608230001_first.sql'), 'select 1;\n');
  const e = { ...env, GITHUB_RUN_ID: String(run), GITHUB_RUN_ATTEMPT: String(attempt), RUNNER_TEMP: root, GITHUB_ENV: path.join(root, 'github-env'),
    CLUED_G4_FRESH_PROJECT: `clued-g4-${run}-${attempt}` };
  const calls = [];
  const runtime = { platform: 'linux', portProbe: async () => true, git: (verb, ref) => {
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

test('prepare and verify perform the actual file transitions and only a fixed local read query', async () => {
  const f = workflowFixture(110);
  try {
    assert.equal((await prepare(f.e, f.runtime)).fresh_inventory, true);
    assert.equal(verify(f.e, f.runtime).history_matches, true);
    assert.doesNotThrow(() => verifyConfiguration(f.e, f.runtime));
    assert.match(fs.readFileSync(f.e.GITHUB_ENV, 'utf8'), /DOCKER_HOST=unix:\/\/\/var\/run\/docker.sock/);
    assert.equal(f.calls.filter((args) => args[0] === 'exec').length, 1);
    assert.equal(f.calls.some((args) => args.includes('rm') || args.includes('prune') || args.includes('start')), false);
  } finally { f.dispose(); }
});

test('a partial prepare cannot authorize verify or cleanup', async () => {
  const f = workflowFixture(111);
  try {
    await assert.rejects(() => prepare(f.e, { ...f.runtime, fs: { ...fs, appendFileSync: () => { throw new Error('write interrupted'); } } }));
    assert.throws(() => verify(f.e, f.runtime), /fresh_marker_identity/);
    assert.throws(() => verifyConfiguration(f.e, f.runtime), /fresh_marker_identity/);
    assert.equal(f.calls.some((args) => args[0] === 'exec'), false);
  } finally { f.dispose(); }
});

test('existing containers fail before configuration or marker is written', async () => {
  const f = workflowFixture(112);
  try {
    await assert.rejects(() => prepare(f.e, { ...f.runtime, docker: (...args) =>
      args[0] === 'ps' && !args.includes('--filter') ? 'supabase_db_clued-g4-112-1' : f.runtime.docker(...args) }));
    assert.equal(fs.readFileSync(path.join(f.app, 'config.toml'), 'utf8'), config);
    assert.equal(fs.existsSync(f.e.GITHUB_ENV), false);
  } finally { f.dispose(); }
});

test('post-start source or target changes prevent any history query and cleanup qualification', async () => {
  const f = workflowFixture(113);
  try {
    await prepare(f.e, f.runtime);
    const changed = { ...f.runtime, git: (verb, ref) => verb === 'rev-parse' && ref === 'HEAD' ? 'b'.repeat(40) : f.runtime.git(verb, ref) };
    assert.throws(() => verify(f.e, changed), /fresh_checkout_changed/);
    assert.throws(() => verifyConfiguration({ ...f.e, CLUED_G4_FRESH_PROJECT: 'foreign-project' }, f.runtime));
    assert.equal(f.calls.some((args) => args[0] === 'exec'), false);
  } finally { f.dispose(); }
});

test('both G4 routes prove freshness before start, keep every database test, and guard cleanup', () => {
  const text = fs.readFileSync(fixtureFile('.github/workflows/clued-g4-database.yml'), 'utf8');
  const routes = text.split(/^  database-gate-(?:trusted-self-hosted|untrusted-hosted):$/m).slice(1);
  assert.equal(routes.length, 2);
  for (const route of routes) {
    assert.ok(route.indexOf('--prepare') >= 0 && route.indexOf('--prepare') < route.indexOf('supabase start'));
    assert.ok(route.indexOf('--verify') > route.indexOf('supabase start'));
    assert.equal(route.includes('supabase db reset'), false);
    for (const command of ['supabase db lint --local', 'supabase test db supabase/tests/m1_runtime_contracts.test.sql',
      'npm run test:project:lifecycle:v2']) assert.ok(route.includes(command));
    assert.ok(route.indexOf('--verify') < route.indexOf('supabase db lint'));
    assert.match(route, /if: always\(\) && env\.CLUED_G4_FRESH_PROJECT != ''/);
    assert.ok(route.indexOf('--guard-cleanup') < route.indexOf('supabase stop --no-backup'));
    assert.match(route, /uses: \.\/\.github\/actions\/ci-temporary-storage/);
  }
});

const listen = async port => {
  const server = createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '0.0.0.0', port, exclusive: true }, resolve);
  });
  return server;
};
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('PORT1: a real occupied inbucket port changes the prepared block and remains verifiable', async () => {
  const f = workflowFixture(38151441285, 2);
  delete f.runtime.portProbe; // The real default Node exclusive TCP probe.
  const occupied = await listen(47864);
  try {
    const result = await prepare(f.e, f.runtime);
    const actual = fs.readFileSync(path.join(f.app, 'config.toml'), 'utf8');
    assert.doesNotMatch(actual, /port = 47864(?:\n|$)/, 'the occupied preferred block cannot be selected');
    assert.ok(portCandidates(f.e).includes(result.port_base));
    assert.notEqual(result.port_base, 47860);
    const marker = verifyConfiguration(f.e, f.runtime).marker;
    assert.equal(marker.port_base, result.port_base);
    assert.equal(actual, freshConfig(config, f.e, marker.port_base));
    assert.equal(verify(f.e, f.runtime).history_matches, true);
  } finally { await close(occupied); f.dispose(); }
});

test('PORT2: real exclusive probes report occupancy and release all partial reservations', async () => {
  const occupied = await listen(0), first = await listen(0);
  const used = occupied.address().port, free = first.address().port;
  await close(first);
  try {
    assert.equal(await probePorts([free]), true);
    assert.equal(await probePorts([free, used]), false);
    const released = await listen(free); await close(released);
    await assert.rejects(() => probePorts(['47864']), /fresh_probe_ports/);
  } finally { await close(occupied); }
  assert.equal(await probePorts([used]), true);
});

test('PORT3: selection is bounded and unknown or failed probes cannot write preparation', async () => {
  for (const outcome of [false, undefined, new Error('EACCES')]) {
    const f = workflowFixture(121); let probes = 0;
    try {
      await assert.rejects(() => prepare(f.e, { ...f.runtime, portProbe: async ports => {
        probes++; assert.equal(ports.length, 7); assert.equal(new Set(ports).size, 7);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      } }), outcome === false ? /fresh_no_available_port_block/ : outcome === undefined ? /fresh_probe_unknown/ : /EACCES/);
      assert.equal(probes, outcome === false ? PORT_BLOCK_LIMIT : 1);
      assert.equal(fs.readFileSync(path.join(f.app, 'config.toml'), 'utf8'), config);
      assert.equal(fs.existsSync(f.e.GITHUB_ENV), false);
      assert.equal(fs.existsSync(path.join(f.root, 'clued-g4-fresh-121-1.json')), false);
    } finally { f.dispose(); }
  }
});

test('PORT4: selected marker base and all existing source/config/identity pins are mandatory', async () => {
  const f = workflowFixture(122); let probes = 0;
  try {
    await prepare(f.e, { ...f.runtime, portProbe: async () => ++probes > 1 });
    const markerFile = path.join(f.root, 'clued-g4-fresh-122-1.json');
    const original = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.equal(original.port_base, portCandidates(f.e)[1]);
    assert.doesNotThrow(() => verifyConfiguration(f.e, f.runtime));
    for (const mutate of [m => delete m.port_base, m => m.port_base = '46230', m => m.port_base = 45000,
      m => m.port_base++, m => m.checkout_sha = 'b'.repeat(40), m => m.project = 'foreign',
      m => m.prepared = false, m => m.source_config_sha256 = '0'.repeat(64), m => m.config_sha256 = '0'.repeat(64)]) {
      const marker = structuredClone(original); mutate(marker); fs.writeFileSync(markerFile, JSON.stringify(marker));
      assert.throws(() => verifyConfiguration(f.e, f.runtime));
    }
    fs.writeFileSync(markerFile, JSON.stringify(original));
    fs.appendFileSync(path.join(f.app, 'config.toml'), '# unrelated edit\n');
    assert.throws(() => verifyConfiguration(f.e, f.runtime), /fresh_configuration_changed/);
    assert.equal(f.calls.some(args => args[0] === 'exec'), false);
  } finally { f.dispose(); }
});

test('PORT5: explicit config bases are typed, aligned and bounded; selection wraps with a fixed limit', () => {
  for (const base of [null, '46000', 44990, 55000, 46005, NaN, Infinity])
    assert.throws(() => freshConfig(config, env, base), /fresh_port_base/);
  assert.match(freshConfig(config, env, 46020), /port = 46021/);
  const candidates = portCandidates({ ...env, GITHUB_RUN_ID: '999' });
  assert.equal(candidates.length, PORT_BLOCK_LIMIT); assert.equal(new Set(candidates).size, PORT_BLOCK_LIMIT);
  assert.deepEqual(candidates.slice(0, 2), [54990, 45000]);
});
